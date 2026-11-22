"""续写主调度 — 大纲扩写 + 章节生成

流程:
  1. 加载 draft + 已锁定章节
  2. 自动检测档位 (L1/L2/L3)
  3. 备份当前 outline 到 outline.continuation_backup
  4. 把已锁定 outline.chapters 标记 locked=true
  5. 分批调 LLM 扩写大纲, 每批 chunk_size 集
  6. 把扩写结果 append 到 outline.chapters
  7. 调用 batch_generate_chapters (它会自动跳过已存在的章节)
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import AsyncGenerator

from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from ..db import ScriptChapter, ScriptDraft, session_scope
from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from ..models.llm import get_llm
from .batch_gen import batch_generate_chapters
from .chapter_gen import summarize_chapter
from .character_extract import (
    extract_characters,
    merge_new_names,
    split_registry_bible,
)
from .continuation_prompts import (
    ContextLevel,
    build_context_for_extension,
    build_outline_extend_prompt,
    detect_context_level,
    normalize_extended_chapters,
)
from . import drama_principles
from .log_helper import save_log
from .progress_helper import (
    finish_progress,
    start_progress,
    tick_progress,
)

logger = logging.getLogger("continuation")


# ===========================================================================
# 辅助
# ===========================================================================

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _extract_json_array(text: str) -> list:
    """从 LLM 输出中提取 JSON 数组, 容错 markdown 包装"""
    if not text:
        raise ValueError("empty LLM response")
    raw = text.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw)
    except Exception:
        m = re.search(r"\[[\s\S]*\]", raw)
        if not m:
            raise
        return json.loads(m.group(0))


async def _ensure_summaries(draft_id: int, chapters: list[ScriptChapter]) -> None:
    """L2/L3 档位需要每集 summary, 缺失的现场补一次。

    每集 summary 调用 summarize_chapter (短调用, 便宜模型即可)。
    生成后写回数据库。
    """
    missing = [c for c in chapters if not (c.summary or "").strip()]
    if not missing:
        return
    logger.info("draft %d: %d chapters missing summary, generating", draft_id, len(missing))
    for c in missing:
        try:
            s = await summarize_chapter(c.full_text or "")
            async with session_scope() as session:
                row = await session.get(ScriptChapter, c.id)
                if row:
                    row.summary = s
                    await session.flush()
            c.summary = s
        except Exception as ex:
            logger.warning("summarize ch %d failed: %s", c.chapter_order, ex)


async def _load_locked_chapters(draft_id: int) -> list[dict]:
    """读出 draft 当前所有已写就的章节(按 order 升序), 返回普通 dict 列表"""
    async with session_scope() as s:
        rows = (
            await s.execute(
                select(ScriptChapter)
                .where(ScriptChapter.draft_id == draft_id)
                .order_by(ScriptChapter.chapter_order)
            )
        ).scalars().all()
        if not rows:
            return []
        # 提前判断档位; 如果是 L2/L3, 给缺 summary 的补
        total_chars = sum(len(r.full_text or "") for r in rows)
        level = detect_context_level(total_chars)
        if level in ("L2", "L3"):
            await _ensure_summaries(draft_id, rows)
        return [
            {
                "chapter_order": r.chapter_order,
                "title": r.title or f"第{r.chapter_order}集",
                "summary": r.summary or "",
                "full_text": r.full_text or "",
                "word_count": r.word_count or len(r.full_text or ""),
            }
            for r in rows
        ]


# ===========================================================================
# 主入口
# ===========================================================================

async def extend_draft(
    draft_id: int,
    *,
    target_episode_count: int,
    chunk_size: int = 20,
    word_target: int | None = None,
    provider: str = "gemini",
    forced_level: ContextLevel | None = None,
    user_guidance: str = "",
    outline_only: bool = True,
    episode_outline: list[dict] | None = None,
) -> AsyncGenerator[str, None]:
    """续写主流程, 返回 SSE 事件流。

    Args:
        word_target: 续写章节的目标字数; 不传则用草稿当前的 chapter_word_target。
                     传入会被持久化到 draft, 后续 batch_generate_chapters 会按这个字数生成。
        user_guidance: 用户对剧情走向的期望(自然语言), 会作为硬约束注入大纲扩写 prompt。
                       与集纲共存时, 只引导"没有原文、没有集纲"的空缺集数。
        outline_only: True(默认)=只扩写大纲, 不自动生成章节正文; 用户可在大纲确认后手动触发
                      "全部生成"来写正文。False=扩写大纲后立即续接生成新增集的正文(旧行为)。
        episode_outline: 用户自备集纲(逐集大纲), 每项 {order, title, synopsis}。
                       覆盖的集数直接采用、跳过 LLM 大纲生成; 只对"没原文、没集纲"
                       的空缺集数调 LLM 扩写(此时 LLM 上下文会注入用户集纲)。

    事件类型:
      stage:        阶段切换 (outline_extend / chapter_gen)
      log:          普通日志
      level:        档位检测 (L1/L2/L3)
      outline_chunk: 一批大纲完成 {from, to, count}
      progress:     进度 {current, total, phase}
      chapter_done: 单集正文完成 (透传 batch_gen 事件)
      error:        错误
      done:         全部完成
    """
    # 1. 校验 + 加载
    yield _sse({"type": "log", "message": "续写流程启动..."})

    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            yield _sse({"type": "error", "message": "草稿不存在"})
            return
        outline = dict(draft.outline or {})
        existing_outline_chs = list(outline.get("chapters") or [])
        # 字数目标: 用户在弹窗里指定了就用它, 并写回 draft 让 batch_generate_chapters 跟着用
        if word_target is None:
            word_target = draft.chapter_word_target or DEFAULT_CHAPTER_WORD_TARGET
        else:
            if word_target != draft.chapter_word_target:
                draft.chapter_word_target = int(word_target)
                await s.flush()

    locked_chapters = await _load_locked_chapters(draft_id)
    locked_count = len(locked_chapters)
    if locked_count == 0:
        yield _sse({"type": "error", "message": "尚无已生成的章节, 请先用'批量生成'写完前几集再续写"})
        return
    if target_episode_count <= locked_count:
        yield _sse(
            {
                "type": "error",
                "message": f"目标集数 {target_episode_count} 必须 > 当前已有 {locked_count}",
            }
        )
        return

    total_chars = sum(c["word_count"] for c in locked_chapters)
    level: ContextLevel = forced_level or detect_context_level(total_chars)
    yield _sse({"type": "level", "level": level, "total_chars": total_chars, "locked_count": locked_count})
    await save_log(
        draft_id,
        "continuation",
        f"档位检测: {level} (前 {locked_count} 集共 {total_chars} 字)",
        "log",
        0,
    )

    new_chapter_count = target_episode_count - locked_count

    # ---- 集纲(用户自备逐集大纲)处理 ----
    # 有效范围: (locked_count, target]。已锁定集数(已有原文)的大纲不被覆盖;
    # 超出目标集数的条目忽略。同 order 重复时取最后一条。
    user_eps_map: dict[int, dict] = {}
    for ep in (episode_outline or []):
        try:
            o = int(ep.get("order") or 0)
        except (TypeError, ValueError):
            continue
        syn = str(ep.get("synopsis") or "").strip()
        if locked_count < o <= target_episode_count and syn:
            user_eps_map[o] = {
                "order": o,
                "title": (str(ep.get("title") or "").strip() or f"第{o}集")[:60],
                "synopsis": syn,
                "must_have": [str(x) for x in (ep.get("must_have") or []) if str(x).strip()],
                "characters": [str(x) for x in (ep.get("characters") or []) if str(x).strip()],
                "source": "user_episode_outline",
            }
    user_eps = [user_eps_map[o] for o in sorted(user_eps_map)]
    user_orders = set(user_eps_map)
    dropped = len(episode_outline or []) - len(user_eps)
    if user_eps:
        yield _sse({
            "type": "log",
            "message": (
                f"用户集纲: 采用 {len(user_eps)} 集 (第 {min(user_orders)}~{max(user_orders)} 集)"
                + (f", 忽略 {dropped} 条(已有原文/超出目标/空内容)" if dropped > 0 else "")
            ),
        })

    # 空缺集数 = 没原文也没集纲的集 → 只有这些需要 LLM 扩写。
    # 按连续段分组(集纲可能打断连续性, 如 21~25 有集纲则空缺分成两段)。
    gap_orders = [o for o in range(locked_count + 1, target_episode_count + 1) if o not in user_orders]
    gap_segments: list[tuple[int, int]] = []
    for o in gap_orders:
        if gap_segments and o == gap_segments[-1][1] + 1:
            gap_segments[-1] = (gap_segments[-1][0], o)
        else:
            gap_segments.append((o, o))

    # 每个连续段再按 chunk_size 切批
    chunks: list[tuple[int, int]] = []
    for seg_start, seg_end in gap_segments:
        cur = seg_start
        while cur <= seg_end:
            chunks.append((cur, min(cur + chunk_size - 1, seg_end)))
            cur += chunk_size
    chunk_total = len(chunks)

    if user_eps and chunk_total == 0:
        yield _sse({"type": "log", "message": "集纲已覆盖全部续写集数, 无需 LLM 生成大纲"})
    elif user_eps:
        seg_desc = ", ".join(f"{a}~{b}" if a != b else str(a) for a, b in gap_segments)
        yield _sse({"type": "log", "message": f"需 LLM 扩写的空缺集数: 第 {seg_desc} 集 (共 {len(gap_orders)} 集, {chunk_total} 批)"})

    task_id = uuid.uuid4().hex[:12]

    # 1.5 确保角色花名册 + 角色圣经存在 (首次续写时从已锁定正文抽取)
    #     抽取即生效; 用户可在前端「角色」页编辑覆盖。抽取失败不阻断主流程。
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        outline_now = dict(d.outline or {})
        has_registry = bool((outline_now.get("character_registry") or {}).get("characters"))
        has_bible = bool((outline_now.get("character_bible") or {}).get("characters"))
    if not (has_registry and has_bible):
        yield _sse({"type": "log", "message": "正在抽取角色花名册与人设(用于保持角色一致性)..."})
        try:
            corpus = "\n\n".join(
                f"第{c['chapter_order']}集 「{c.get('title','')}」\n{c.get('full_text','')}"
                for c in locked_chapters
            )
            chars = await extract_characters(corpus, provider=provider)
            if chars:
                registry, bible = split_registry_bible(chars)
                async with session_scope() as s:
                    d = await s.get(ScriptDraft, draft_id)
                    outline_now = dict(d.outline or {})
                    if not has_registry:
                        outline_now["character_registry"] = registry
                    if not has_bible:
                        outline_now["character_bible"] = bible
                    d.outline = outline_now
                    flag_modified(d, "outline")
                await save_log(
                    draft_id, "continuation",
                    f"角色抽取完成: 共 {len(chars)} 个角色 (可在「角色」页编辑立场/人设)",
                    "log", 0,
                )
                yield _sse({"type": "characters", "count": len(chars)})
        except Exception as ex:
            logger.warning("character extract on continuation failed: %s", ex)
            yield _sse({"type": "log", "message": f"角色抽取跳过({ex})"})

    # 2. 备份当前 outline + 标记 locked + 写续写元数据
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        outline_now = dict(d.outline or {})
        # 备份 (只在第一次续写时备份, 避免覆盖更早的备份)
        if not outline_now.get("continuation_backup"):
            outline_now["continuation_backup"] = {
                "snapshot_at": _now_iso(),
                "outline_chapters": list(outline_now.get("chapters") or []),
                "episode_count": d.episode_count,
            }
        # 标记前 N 集 outline locked
        for ch in (outline_now.get("chapters") or []):
            if ch.get("order") in {c["chapter_order"] for c in locked_chapters}:
                ch["locked"] = True
        # 续写历史
        ext_log = list(outline_now.get("extensions") or [])
        ext_log.append(
            {
                "task_id": task_id,
                "from_episode": locked_count + 1,
                "to_episode": target_episode_count,
                "level": level,
                "chunk_size": chunk_size,
                "word_target": int(word_target),
                "user_guidance": (user_guidance or "").strip()[:200000],  # 截断防爆
                "episode_outline_count": len(user_eps),
                "started_at": _now_iso(),
            }
        )
        outline_now["extensions"] = ext_log
        d.outline = outline_now
        flag_modified(d, "outline")

    # 2.5 用户集纲直接写入 outline.chapters (覆盖已有同 order 的 LLM 生成大纲)
    if user_eps:
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            outline_now = dict(d.outline or {})
            chs = [c for c in (outline_now.get("chapters") or []) if int(c.get("order") or 0) not in user_orders]
            chs.extend(user_eps)
            chs.sort(key=lambda x: int(x.get("order") or 0))
            outline_now["chapters"] = chs
            d.outline = outline_now
            d.episode_count = max(d.episode_count or 0, max(user_orders))
            flag_modified(d, "outline")
        yield _sse({
            "type": "outline_chunk",
            "chunk_index": 0,
            "from": min(user_orders),
            "to": max(user_orders),
            "count": len(user_eps),
            "source": "user_episode_outline",
        })
        await save_log(
            draft_id, "continuation",
            f"用户集纲已写入大纲: 第 {min(user_orders)}~{max(user_orders)} 集共 {len(user_eps)} 集 (跳过 LLM 生成)",
            "log", 0,
        )

    # 3. 启动整体进度 (大纲阶段 + 章节阶段累加)
    overall_total = chunk_total + new_chapter_count
    await start_progress(draft_id, "continuation", overall_total, task_id=task_id)

    # ============ 阶段 1: 大纲扩写 (只扩写"没原文、没集纲"的空缺集数) ============
    final_end = target_episode_count
    if chunk_total > 0:
        yield _sse({"type": "stage", "stage": "outline_extend", "message": "正在扩写大纲..."})
        await tick_progress(draft_id, current=0, total=overall_total, message="开始扩写大纲")

    # 把已锁定章节缓存好(扩写过程中不变, 但每批 prompt 可能要复用)
    base_locked_chapters = locked_chapters

    overall_done = 0

    for chunk_idx, (start_order, end_order) in enumerate(chunks):
        yield _sse(
            {
                "type": "log",
                "message": f"扩写大纲 第 {chunk_idx + 1}/{chunk_total} 批 (第 {start_order}~{end_order} 集)",
            }
        )

        # 重新读最新 outline (前一批的产出对当前批次可见)
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            current_outline = dict(d.outline or {})

        prior_ctx = build_context_for_extension(
            level=level,
            outline=current_outline,
            locked_chapters=base_locked_chapters,
            include_planned_outline=True,  # 注入已确定的后续分集大纲(用户集纲+前批产出)
        )

        prompt = build_outline_extend_prompt(
            prior_context=prior_ctx,
            start_order=start_order,
            end_order=end_order,
            target_total=final_end,
            locked_count=locked_count,
            user_guidance=user_guidance,
        )
        # D2: 续写大纲同样注入集纲结构原则(留存优先/事件密度/失败代价/明暗线/结尾卡点)。
        # 原先续写链路完全没有结构约束, 只有"防漂移"的角色花名册。
        prompt = drama_principles.outline_block() + "\n\n" + prompt

        try:
            llm = get_llm("generate", temperature=0.7, provider=provider)
            await save_log(
                draft_id,
                "continuation",
                f"调用模型扩写大纲 第 {start_order}~{end_order} 集 (provider={provider}, 上下文={len(prompt)}字)",
                "log",
                0,
            )
            resp = await llm.ainvoke(prompt)
            text = getattr(resp, "content", "") if resp else ""
            raw = _extract_json_array(text)
            chunk_eps = normalize_extended_chapters(
                raw, start_order=start_order, end_order=end_order
            )
        except Exception as e:
            logger.exception("outline extend chunk %d failed", chunk_idx)
            yield _sse(
                {
                    "type": "error",
                    "message": f"大纲扩写第 {chunk_idx + 1} 批失败: {e}",
                    "recoverable": True,
                }
            )
            await finish_progress(
                draft_id, success=False, message=f"大纲扩写失败 ({chunk_idx + 1}/{chunk_total})"
            )
            return

        # 追加到 outline.chapters 并落库
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            outline_now = dict(d.outline or {})
            chs = list(outline_now.get("chapters") or [])
            # 去重: 已存在同 order 的跳过(含用户集纲占用的集数, 不被 LLM 覆盖)
            existing_orders = {c.get("order") for c in chs}
            for ep in chunk_eps:
                if ep["order"] in existing_orders:
                    continue
                chs.append(ep)
            chs.sort(key=lambda x: int(x.get("order") or 0))
            outline_now["chapters"] = chs
            d.outline = outline_now
            d.episode_count = max(d.episode_count or 0, end_order)
            flag_modified(d, "outline")

        overall_done += 1
        await tick_progress(
            draft_id,
            current=overall_done,
            total=overall_total,
            message=f"大纲扩写 {chunk_idx + 1}/{chunk_total} 批完成",
        )
        yield _sse(
            {
                "type": "outline_chunk",
                "chunk_index": chunk_idx + 1,
                "from": start_order,
                "to": end_order,
                "count": len(chunk_eps),
            }
        )
        yield _sse(
            {
                "type": "progress",
                "current": overall_done,
                "total": overall_total,
                "phase": "outline",
            }
        )

    # 大纲扩写全部完成, 把最终 episode_count 同步好
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        d.episode_count = final_end
        # outline.chapters 里 1..N 集再次确保 locked
        outline_now = dict(d.outline or {})
        for ch in (outline_now.get("chapters") or []):
            if ch.get("order", 0) <= locked_count:
                ch["locked"] = True
        d.outline = outline_now
        flag_modified(d, "outline")

    # P5: 续写后增量更新状态账本(仅当已有账本时), 让新集受账本约束、并把新集事件并入账本。
    try:
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            _ol = dict(d.outline or {})
            _led = _ol.get("state_ledger")
            _prov = d.model_provider or "gemini"
        if _led:
            from .state_ledger import update_ledger_for_batch
            _new_eps = [c for c in (_ol.get("chapters") or []) if int(c.get("order", 0)) > locked_count]
            if _new_eps:
                _led2 = await update_ledger_for_batch(_led, _new_eps, provider=_prov)
                async with session_scope() as s:
                    d = await s.get(ScriptDraft, draft_id)
                    _ol2 = dict(d.outline or {})
                    _ol2["state_ledger"] = _led2
                    d.outline = _ol2
                    flag_modified(d, "outline")
                    await s.flush()
    except Exception as _e:  # noqa: BLE001
        logger.warning("continuation ledger update failed (continue): %s", _e)

    # outline_only: 只扩写大纲, 不自动生成正文。收尾并结束(用户可在大纲确认后手动"全部生成")。
    if outline_only:
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            outline_now = dict(d.outline or {})
            ext_log = list(outline_now.get("extensions") or [])
            if ext_log:
                ext_log[-1]["finished_at"] = _now_iso()
                ext_log[-1]["outline_only"] = True
                outline_now["extensions"] = ext_log
            d.outline = outline_now
            flag_modified(d, "outline")
        yield _sse(
            {
                "type": "done",
                "message": f"大纲已扩写至第 {final_end} 集(仅大纲)。如需生成正文, 请在章节页点“全部生成”。",
                "final_episode_count": final_end,
                "outline_only": True,
            }
        )
        await finish_progress(draft_id, success=True, message=f"大纲扩写完成: 共 {final_end} 集(仅大纲)")
        return

    yield _sse({"type": "log", "message": "大纲全部扩写完成, 进入正文生成阶段"})

    # ============ 阶段 2: 章节正文 (复用 batch_generate_chapters) ============
    yield _sse({"type": "stage", "stage": "chapter_gen", "message": "开始批量生成章节..."})

    # batch_generate_chapters 自带跳过已存在章节的逻辑, 所以前 N 集会被跳过, N+1..M 会逐集生成。
    # 它内部会自己 start_progress("chapters", total=M),
    # 我们这里不再用 outer overall_total 跟踪, 让它接管 progress 显示。
    # batch_generate_chapters 输出的 SSE 事件直接转发, 同时累加 overall_done 用于 log。
    chapters_done_local = 0
    try:
        async for raw_evt in batch_generate_chapters(draft_id):
            # 把 batch_gen 事件直接透传给上层
            yield raw_evt
            # 同时尝试解析进度事件来更新本地计数
            try:
                if raw_evt.startswith("data: "):
                    obj = json.loads(raw_evt[6:].strip())
                    if obj.get("type") == "complete" and obj.get("chapter_order"):
                        chapters_done_local += 1
            except Exception:
                pass
    except Exception as e:
        logger.exception("chapter batch failed")
        yield _sse({"type": "error", "message": f"章节生成失败: {e}", "recoverable": True})
        await finish_progress(draft_id, success=False, message=f"章节生成失败: {e}")
        return

    # 收尾
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        outline_now = dict(d.outline or {})
        # 把当前 extension 的完成时间补上
        ext_log = list(outline_now.get("extensions") or [])
        if ext_log:
            ext_log[-1]["finished_at"] = _now_iso()
            ext_log[-1]["chapters_generated"] = chapters_done_local
            outline_now["extensions"] = ext_log
        d.outline = outline_now
        flag_modified(d, "outline")

    yield _sse(
        {
            "type": "done",
            "message": f"续写完成: 第 {locked_count + 1} ~ {final_end} 集",
            "final_episode_count": final_end,
        }
    )
    await finish_progress(draft_id, success=True, message=f"续写完成: 共 {final_end} 集")


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


# ===========================================================================
# 元信息查询(用于前端弹窗)
# ===========================================================================

async def get_extend_meta(draft_id: int) -> dict:
    """返回续写所需的元信息 (locked 集数 / 字数 / 检测档位)"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"error": "草稿不存在"}
        rows = (
            await s.execute(
                select(ScriptChapter)
                .where(ScriptChapter.draft_id == draft_id)
                .order_by(ScriptChapter.chapter_order)
            )
        ).scalars().all()
        total_chars = sum(len(r.full_text or "") for r in rows)
        level = detect_context_level(total_chars)
        return {
            "draft_id": draft_id,
            "title": d.title or "",
            "current_episode_count": d.episode_count or 0,
            "locked_chapter_count": len(rows),
            "total_chars": total_chars,
            "detected_level": level,
            "chapter_word_target": d.chapter_word_target or DEFAULT_CHAPTER_WORD_TARGET,
            "extensions": list((d.outline or {}).get("extensions") or []),
        }


# ===========================================================================
# 回滚
# ===========================================================================

async def rollback_extension(draft_id: int) -> dict:
    """回滚最近一次续写: 删 N+1 之后的章节 + outline.chapters 截断到原集数。

    使用 outline.continuation_backup 中的 outline_chapters / episode_count 恢复。
    """
    from sqlalchemy import delete
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": "草稿不存在"}
        outline_now = dict(d.outline or {})
        backup = outline_now.get("continuation_backup")
        if not backup:
            return {"ok": False, "error": "没有可回滚的续写记录"}

        old_chapters = list(backup.get("outline_chapters") or [])
        old_episode_count = int(backup.get("episode_count") or 0)
        old_max_order = max((c.get("order") or 0) for c in old_chapters) if old_chapters else 0

        # 1. 删数据库里 chapter_order > old_max_order 的章节。
        #
        # ★ 删之前先把这一批正文归档。旧实现直接 DELETE, 回滚后想反悔就再也拿不回来
        # —— outline.chapters 有 continuation_backup 可回滚, 正文却没有对应机制,
        # 续写了几万字、一点回滚全部蒸发。归档后用户能去「历史版本」里找回。
        # 归档与删除同一个事务: 归档失败则整体回滚, 不会出现"稿没了、历史也没存上"。
        from .candidate_store import snapshot_only
        doomed = (await s.execute(
            select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order > old_max_order,
            )
        )).scalars().all()
        for row in doomed:
            if not (row.full_text or "").strip():
                continue      # 空行不值得占一个历史位
            # 传 session=s: 归档写进**当前这个事务**, 与下面的 DELETE 同生共死。
            # 不能自开 session_scope —— 那会拿第二条连接, 与自身未提交的写锁互等。
            await snapshot_only(
                draft_id=draft_id,
                order=row.chapter_order,
                stage="chapter",
                content={"full_text": row.full_text or "", "title": row.title or ""},
                version=int(row.version or 1),
                created_by="user_rollback",
                session=s,
            )

        del_result = await s.execute(
            delete(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order > old_max_order,
            )
        )

        # 2. outline 恢复
        outline_now["chapters"] = old_chapters
        outline_now.pop("continuation_backup", None)
        # 把扩写历史标记为已回滚
        ext_log = list(outline_now.get("extensions") or [])
        if ext_log:
            ext_log[-1]["rolled_back_at"] = _now_iso()
            outline_now["extensions"] = ext_log
        d.outline = outline_now
        d.episode_count = old_episode_count
        flag_modified(d, "outline")

        return {
            "ok": True,
            "deleted_chapters": del_result.rowcount,
            "restored_episode_count": old_episode_count,
        }


__all__ = [
    "extend_draft",
    "get_extend_meta",
    "rollback_extension",
]
