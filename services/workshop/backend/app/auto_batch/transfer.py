"""转交逻辑 — 把 admin 的草稿复制给目标用户。

复制范围:
  - ScriptDraft (新 id, user_id=target, parent_draft_id=原 id)
  - 所有 ScriptChapter
  - 所有 ScriptStoryboard
  - (可选) 最新一次 ScriptAnalysis
  - 写一条 AutoBatchTransfer 记录
"""
from __future__ import annotations

import logging
from sqlalchemy import select

from ..auth.models import User
from ..db import (
    AutoBatchTransfer, ScriptAnalysis, ScriptChapter, ScriptDraft, ScriptStoryboard,
    session_scope,
)

logger = logging.getLogger("auto_batch.transfer")


async def copy_draft_to_user(
    *,
    source_draft_id: int,
    target_user_id: int,
    admin_user_id: int,
    job_id: int | None = None,
    include_analysis: bool = True,
) -> dict:
    """把 source_draft_id 完整复制一份给 target_user_id。

    Returns:
        {
          "ok": True,
          "original_draft_id": ...,
          "target_user_id": ...,
          "new_draft_id": ...
        }
    或失败时:
        {"ok": False, "error": "..."}
    """
    async with session_scope() as s:
        original = await s.get(ScriptDraft, source_draft_id)
        if not original:
            return {"ok": False, "error": "source draft not found"}

        # 1) 复制 draft
        new_draft = ScriptDraft(
            user_id=target_user_id,
            session_id=None,
            title=original.title,
            user_input=original.user_input,
            outline=original.outline,
            original_outline=original.original_outline,
            outline_locked=original.outline_locked,
            status=original.status,
            episode_count=original.episode_count,
            is_favorite=False,
            is_deleted=False,
            preview_batch_running=0,
            model_provider=original.model_provider,
            chapter_word_target=original.chapter_word_target,
            auto_batch_job_id=original.auto_batch_job_id,
            auto_generated=original.auto_generated,
            parent_draft_id=original.id,
        )
        s.add(new_draft)
        await s.flush()
        new_draft_id = new_draft.id

        # 2) 复制章节
        ch_rows = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == source_draft_id)
        )).scalars().all()
        for ch in ch_rows:
            s.add(ScriptChapter(
                draft_id=new_draft_id,
                chapter_order=ch.chapter_order,
                title=ch.title,
                summary=ch.summary,
                full_text=ch.full_text,
                word_count=ch.word_count,
                locked=ch.locked,
                is_stale=ch.is_stale,
                version=ch.version,
            ))

        # 3) 复制剧本
        sb_rows = (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == source_draft_id)
        )).scalars().all()
        for sb in sb_rows:
            s.add(ScriptStoryboard(
                draft_id=new_draft_id,
                chapter_order=sb.chapter_order,
                shots_json=sb.shots_json,
                locked=sb.locked,
                is_stale=sb.is_stale,
                version=sb.version,
            ))

        # 4) 复制最新分析(可选)
        if include_analysis:
            latest = (await s.execute(
                select(ScriptAnalysis)
                .where(ScriptAnalysis.draft_id == source_draft_id, ScriptAnalysis.status == "done")
                .order_by(ScriptAnalysis.created_at.desc())
            )).scalars().first()
            if latest:
                s.add(ScriptAnalysis(
                    draft_id=new_draft_id,
                    scope=latest.scope,
                    status="done",
                    progress_step="done",
                    progress_current=latest.progress_current,
                    progress_total=latest.progress_total,
                    overall_grade=latest.overall_grade,
                    overall_score=latest.overall_score,
                    summary=latest.summary,
                    scores_json=latest.scores_json,
                    hooks_json=latest.hooks_json,
                    risks_json=latest.risks_json,
                    audience_json=latest.audience_json,
                    suggestions_json=latest.suggestions_json,
                    metrics_json=latest.metrics_json,
                ))

        # 5) 写转交记录
        s.add(AutoBatchTransfer(
            draft_id=source_draft_id,
            source_user_id=admin_user_id,
            target_user_id=target_user_id,
            copied_draft_id=new_draft_id,
            job_id=job_id,
        ))

    logger.info(
        "transfer ok: src=%d target_user=%d new_draft=%d",
        source_draft_id, target_user_id, new_draft_id,
    )
    return {
        "ok": True,
        "original_draft_id": source_draft_id,
        "target_user_id": target_user_id,
        "new_draft_id": new_draft_id,
    }


# ---------------------------------------------------------------------------
# 批量入口 (供 routes.py 使用)
# ---------------------------------------------------------------------------
async def transfer_drafts(
    *,
    draft_ids: list[int],
    target_user_ids: list[int],
    source_user_id: int,
    job_id: int | None = None,
    include_analysis: bool = True,
) -> dict:
    """把多个 draft 转交给多个目标用户(笛卡尔积)。

    Returns:
        {
          "ok": True,
          "transferred": [{"original_draft_id": ..., "target_user_id": ..., "new_draft_id": ...}, ...],
          "skipped": [{"target_user_id": ..., "reason": ...}, ...]
        }
    """
    if not draft_ids:
        return {"ok": False, "error": "draft_ids 为空", "transferred": [], "skipped": []}
    if not target_user_ids:
        return {"ok": False, "error": "target_user_ids 为空", "transferred": [], "skipped": []}

    # 校验目标用户存在
    valid_user_ids: list[int] = []
    skipped: list[dict] = []
    async with session_scope() as s:
        for uid in target_user_ids:
            user = await s.get(User, uid)
            if not user:
                skipped.append({"target_user_id": uid, "reason": "user not found"})
                continue
            if not user.is_active:
                skipped.append({"target_user_id": uid, "reason": "user inactive"})
                continue
            valid_user_ids.append(uid)

    transferred: list[dict] = []
    for did in draft_ids:
        for uid in valid_user_ids:
            try:
                result = await copy_draft_to_user(
                    source_draft_id=did,
                    target_user_id=uid,
                    admin_user_id=source_user_id,
                    job_id=job_id,
                    include_analysis=include_analysis,
                )
                if result.get("ok"):
                    transferred.append({
                        "original_draft_id": did,
                        "target_user_id": uid,
                        "new_draft_id": result["new_draft_id"],
                    })
                else:
                    skipped.append({
                        "target_user_id": uid,
                        "draft_id": did,
                        "reason": result.get("error") or "unknown",
                    })
            except Exception as e:
                logger.exception("transfer failed: draft=%d user=%d", did, uid)
                skipped.append({
                    "target_user_id": uid,
                    "draft_id": did,
                    "reason": f"{type(e).__name__}: {e}",
                })

    return {
        "ok": True,
        "transferred": transferred,
        "skipped": skipped,
    }
