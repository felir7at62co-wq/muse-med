"""批次编排器 - 全自动产线核心。

入口: run_batch(job_id) - 后台 task

阶段:
  A. 概念生成
  B. 批量创建草稿
  C. 部级并发处理(每部跑大纲→章节→剧本→分析)
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

from sqlalchemy import select

from ..analysis.analyzer import run_analysis
from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from ..db import (
    AutoBatchJob, AutoBatchGenre, ScriptDraft, ScriptChapter, ScriptStoryboard,
    ScriptAnalysis, session_scope,
)
from ..stages.chapter_gen import generate_chapter, summarize_chapter
from ..stages.outline_gen import generate_outline
from ..stages.storyboard_gen import generate_storyboard
from .concept_gen import generate_concepts

logger = logging.getLogger("auto_batch.orchestrator")


# ---------------------------------------------------------------------------
# 进度更新工具
# ---------------------------------------------------------------------------
async def _update_job(job_id: int, **fields):
    async with session_scope() as s:
        row = await s.get(AutoBatchJob, job_id)
        if not row:
            return
        for k, v in fields.items():
            if hasattr(row, k):
                setattr(row, k, v)


async def _set_job_failed(job_id: int, error: str):
    await _update_job(
        job_id,
        status="failed",
        error=str(error)[:1000],
        finished_at=datetime.utcnow(),
        current_step="failed",
    )


async def _bump_finished(job_id: int):
    async with session_scope() as s:
        row = await s.get(AutoBatchJob, job_id)
        if row:
            row.finished_dramas = (row.finished_dramas or 0) + 1


async def _bump_failed(job_id: int):
    async with session_scope() as s:
        row = await s.get(AutoBatchJob, job_id)
        if row:
            row.failed_dramas = (row.failed_dramas or 0) + 1


async def _is_cancelled(job_id: int) -> bool:
    async with session_scope() as s:
        row = await s.get(AutoBatchJob, job_id)
        return bool(row and row.status == "cancelled")


# ---------------------------------------------------------------------------
# 单部草稿全流程
# ---------------------------------------------------------------------------
async def _run_one_drama(
    *,
    draft_id: int,
    job_id: int,
    episode_count: int,
    word_target: int,
    provider: str,
    auto_analyze: bool = True,
) -> dict:
    """跑通一部:大纲→章节→剧本→分析。返回 {ok, error, step}"""

    log_prefix = f"[batch{job_id}/draft{draft_id}]"

    async def _stop():
        return await _is_cancelled(job_id)

    # ---- 1. 大纲
    try:
        async with session_scope() as s:
            draft = await s.get(ScriptDraft, draft_id)
            user_input = (draft.user_input or "") if draft else ""

        if await _stop():
            return {"ok": False, "step": "outline", "error": "cancelled"}

        outline = await generate_outline(
            user_input=user_input,
            chapter_count=episode_count,
            chapter_word_target=word_target,
            provider=provider,
            draft_id=draft_id,
        )

        async with session_scope() as s:
            draft = await s.get(ScriptDraft, draft_id)
            if not draft:
                return {"ok": False, "step": "outline", "error": "draft missing"}
            draft.outline = outline
            draft.original_outline = outline
            draft.outline_locked = 1            # 自动锁定
            draft.status = "outline_done"
        logger.info("%s outline done (chapters=%d)", log_prefix, len(outline.get("chapters") or []))
    except Exception as e:
        logger.exception("%s outline failed", log_prefix)
        return {"ok": False, "step": "outline", "error": f"{type(e).__name__}: {e}"}

    # ---- 2. 章节(顺序生成,因每章需要前面章节作上下文)
    try:
        async with session_scope() as s:
            draft = await s.get(ScriptDraft, draft_id)
            outline = draft.outline or {}
            existing_orders = {
                c.chapter_order for c in (await s.execute(
                    select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
                )).scalars().all()
            }
        chapters_meta = outline.get("chapters") or []
        total_ch = len(chapters_meta)
        for idx, ch_meta in enumerate(chapters_meta):
            order = ch_meta.get("order", idx + 1)
            if order in existing_orders:
                continue
            if await _stop():
                return {"ok": False, "step": "chapter", "error": "cancelled"}

            # 拉前面章节
            async with session_scope() as s:
                prev_rows = (await s.execute(
                    select(ScriptChapter)
                    .where(ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order < order)
                    .order_by(ScriptChapter.chapter_order)
                )).scalars().all()
                prev_chapters = [{
                    "chapter_order": c.chapter_order,
                    "summary": c.summary,
                    "full_text": c.full_text,
                } for c in prev_rows]

            full_text = await generate_chapter(
                outline=outline,
                chapter_order=order,
                word_target=word_target,
                prev_chapters=prev_chapters,
                provider=provider,
                draft_id=draft_id,
            )
            try:
                summary = await summarize_chapter(full_text)
            except Exception:
                # 留空而非 `full_text[:300]`（那是正文前 300 字，不是摘要）。
                # 读取侧遇空会退回本集全文 —— 用户的裁定：兜底是全文。
                summary = ""

            async with session_scope() as s:
                row = ScriptChapter(
                    draft_id=draft_id,
                    chapter_order=order,
                    title=ch_meta.get("title", f"第{order}章"),
                    full_text=full_text,
                    summary=summary,
                    word_count=len(full_text),
                )
                s.add(row)
                await s.flush()
            logger.info("%s chapter %d done (%d chars, %d/%d)",
                        log_prefix, order, len(full_text), idx + 1, total_ch)
    except Exception as e:
        logger.exception("%s chapter failed", log_prefix)
        return {"ok": False, "step": "chapter", "error": f"{type(e).__name__}: {e}"}

    # ---- 3. 剧本(顺序)
    try:
        async with session_scope() as s:
            draft = await s.get(ScriptDraft, draft_id)
            outline = draft.outline or {}
            ch_rows = (await s.execute(
                select(ScriptChapter)
                .where(ScriptChapter.draft_id == draft_id)
                .order_by(ScriptChapter.chapter_order)
            )).scalars().all()
            chapters_data = [{
                "chapter_order": c.chapter_order,
                "title": c.title,
                "full_text": c.full_text,
            } for c in ch_rows]
            existing_sb = {
                row.chapter_order for row in (await s.execute(
                    select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
                )).scalars().all()
            }

        for ch in chapters_data:
            order = ch["chapter_order"]
            if order in existing_sb:
                continue
            if await _stop():
                return {"ok": False, "step": "storyboard", "error": "cancelled"}

            shots = await generate_storyboard(
                episode_order=order,
                chapter_text=ch["full_text"] or "",
                chapter_title=ch["title"] or f"第{order}章",
                provider=provider,
                draft_id=draft_id,
            )

            async with session_scope() as s:
                row = ScriptStoryboard(
                    draft_id=draft_id,
                    chapter_order=order,
                    shots_json=shots or [],
                )
                s.add(row)
                await s.flush()
            logger.info("%s storyboard ch %d done (%d shots)", log_prefix, order, len(shots or []))
    except Exception as e:
        logger.exception("%s storyboard failed", log_prefix)
        return {"ok": False, "step": "storyboard", "error": f"{type(e).__name__}: {e}"}

    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if draft:
            draft.status = "done"

    # ---- 4. 分析(可选,失败不阻塞)
    if auto_analyze and not await _stop():
        try:
            async with session_scope() as s:
                analysis_row = ScriptAnalysis(
                    draft_id=draft_id,
                    scope="full",
                    status="pending",
                    progress_step="queued",
                )
                s.add(analysis_row)
                await s.flush()
                analysis_id = analysis_row.id
            await run_analysis(draft_id, analysis_id)
            logger.info("%s analysis done (id=%d)", log_prefix, analysis_id)
        except Exception as e:
            logger.warning("%s analysis failed (non-fatal): %s", log_prefix, e)

    return {"ok": True}


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------
async def run_batch(job_id: int) -> None:
    """批次任务后台主入口"""
    started_at = datetime.utcnow()

    try:
        # 加载配置
        async with session_scope() as s:
            job = await s.get(AutoBatchJob, job_id)
            if not job:
                logger.error("batch %d not found", job_id)
                return
            cfg = job.config_json or {}
            admin_id = job.created_by

        if await _is_cancelled(job_id):
            return

        batch_count = int(cfg.get("batch_count") or 1)
        episodes_per_drama = int(cfg.get("episodes_per_drama") or 3)
        words_per_episode = int(cfg.get("words_per_episode") or DEFAULT_CHAPTER_WORD_TARGET)
        concept_model = cfg.get("concept_model") or "gemini"
        gen_model = cfg.get("gen_model") or concept_model      # 章节/剧本生成用
        drama_concurrency = int(cfg.get("drama_concurrency") or 2)
        if drama_concurrency < 1:
            drama_concurrency = 1
        genre_keys = cfg.get("genre_keys") or []
        adhoc_tags = cfg.get("adhoc_tags") or []
        auto_analyze = bool(cfg.get("auto_analyze", True))

        # ---- Step 0: 加载题材
        async with session_scope() as s:
            genre_rows = []
            if genre_keys:
                genre_rows = (await s.execute(
                    select(AutoBatchGenre).where(AutoBatchGenre.key.in_(genre_keys))
                )).scalars().all()
            genre_items = [{
                "key": g.key,
                "label": g.label,
                "description": g.description,
                "prompt_hint": g.prompt_hint,
            } for g in genre_rows]
            # 累加 use_count
            for g in genre_rows:
                g.use_count = (g.use_count or 0) + 1

        await _update_job(
            job_id,
            status="running",
            started_at=started_at,
            current_step="resuming" if (job.draft_ids or []) else "generating_concepts",
            error=None,
            finished_at=None,
        )

        # ---- 幂等: 如果 draft_ids 已存在(retry 场景), 跳过概念生成 + 创建步骤
        existing_draft_ids = list(job.draft_ids or [])
        draft_ids: list[int] = []

        if existing_draft_ids:
            # 复用已有 draft, 不消耗 LLM 重新生概念
            logger.info("batch %d resume: reuse %d existing drafts", job_id, len(existing_draft_ids))
            draft_ids = existing_draft_ids
        else:
            # ---- Step A: 概念生成 (首次运行)
            try:
                concepts = await generate_concepts(
                    count=batch_count,
                    genre_items=genre_items,
                    adhoc_tags=adhoc_tags,
                    provider=concept_model,
                )
            except Exception as e:
                await _set_job_failed(job_id, f"概念生成失败: {e}")
                return

            if not concepts:
                await _set_job_failed(job_id, "概念生成返回空")
                return

            if await _is_cancelled(job_id):
                return

            # ---- Step B: 批量创建草稿 (首次运行)
            await _update_job(job_id, current_step="creating_drafts")
            async with session_scope() as s:
                for idx, c in enumerate(concepts):
                    draft = ScriptDraft(
                        user_id=admin_id,
                        title=c["title"],
                        user_input=c["synopsis"],
                        episode_count=episodes_per_drama,
                        chapter_word_target=words_per_episode,
                        model_provider=gen_model,
                        auto_batch_job_id=job_id,
                        auto_generated=True,
                        status="draft",
                    )
                    s.add(draft)
                    await s.flush()
                    draft_ids.append(draft.id)
            await _update_job(job_id, draft_ids=draft_ids, total_dramas=len(draft_ids))

        # 重置 finished/failed 计数 (retry 时重新统计已完成的 draft)
        # 实际完成 = status='done' 的 draft 数
        async with session_scope() as s:
            done_count = (await s.execute(
                select(ScriptDraft).where(
                    ScriptDraft.id.in_(draft_ids),
                    ScriptDraft.status == "done",
                )
            )).scalars().all()
            row = await s.get(AutoBatchJob, job_id)
            if row:
                row.finished_dramas = len(done_count)
                row.failed_dramas = 0  # retry 时重置, 跑完会重新累加

        # ---- Step C: 部级并发处理
        await _update_job(job_id, current_step="generating_dramas")

        sem = asyncio.Semaphore(drama_concurrency)

        async def _wrap_one(draft_id: int):
            if await _is_cancelled(job_id):
                return {"ok": False, "step": "skip", "error": "cancelled"}
            async with sem:
                if await _is_cancelled(job_id):
                    return {"ok": False, "step": "skip", "error": "cancelled"}
                result = await _run_one_drama(
                    draft_id=draft_id,
                    job_id=job_id,
                    episode_count=episodes_per_drama,
                    word_target=words_per_episode,
                    provider=gen_model,
                    auto_analyze=auto_analyze,
                )
                if result.get("ok"):
                    await _bump_finished(job_id)
                else:
                    await _bump_failed(job_id)
                return result

        results = await asyncio.gather(*[_wrap_one(did) for did in draft_ids], return_exceptions=True)

        # 汇总
        ok_count = sum(1 for r in results if isinstance(r, dict) and r.get("ok"))
        fail_count = len(results) - ok_count

        if await _is_cancelled(job_id):
            await _update_job(
                job_id,
                status="cancelled",
                finished_at=datetime.utcnow(),
                current_step="cancelled",
            )
        elif fail_count == 0:
            await _update_job(
                job_id,
                status="done",
                finished_at=datetime.utcnow(),
                current_step="done",
            )
        elif ok_count == 0:
            await _update_job(
                job_id,
                status="failed",
                finished_at=datetime.utcnow(),
                current_step="all_failed",
                error=f"全部 {fail_count} 部失败",
            )
        else:
            await _update_job(
                job_id,
                status="partial_failed",
                finished_at=datetime.utcnow(),
                current_step="partial_failed",
                error=f"{fail_count} 部失败 / {ok_count} 部成功",
            )

        elapsed = (datetime.utcnow() - started_at).total_seconds()
        logger.info(
            "batch %d done: ok=%d failed=%d total=%d elapsed=%.1fs",
            job_id, ok_count, fail_count, len(results), elapsed,
        )

    except Exception as e:
        logger.exception("run_batch fatal error: job_id=%d", job_id)
        await _set_job_failed(job_id, f"{type(e).__name__}: {e}")
