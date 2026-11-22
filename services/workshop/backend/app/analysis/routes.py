"""剧本分析 API 路由"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import delete, select

from ..auth import User, get_current_user
from ..db import ScriptAnalysis, ScriptDraft, session_scope
from .analyzer import run_analysis
from .docx_export import build_analysis_docx

logger = logging.getLogger("analysis.routes")

router = APIRouter(prefix="/v1/stages", tags=["analysis"])

MAX_HISTORY = 5


def _row_to_dict(row: ScriptAnalysis, *, lite: bool = False) -> dict:
    """ScriptAnalysis row → dict。lite 模式不包含大字段(给历史列表用)"""
    base = {
        "id": row.id,
        "draft_id": row.draft_id,
        "scope": row.scope,
        "status": row.status,
        "progress_step": row.progress_step,
        "progress_current": row.progress_current,
        "progress_total": row.progress_total,
        "overall_grade": row.overall_grade,
        "overall_score": row.overall_score,
        "summary": row.summary,
        "error": row.error,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
    if lite:
        return base
    base.update({
        "scores_json": row.scores_json or {},
        "hooks_json": row.hooks_json or [],
        "risks_json": row.risks_json or [],
        "audience_json": row.audience_json or {},
        "suggestions_json": row.suggestions_json or [],
        "metrics_json": row.metrics_json or {},
        "report_md": row.report_md or "",
    })
    return base


async def _spawn_auto_analysis(draft_id: int, user_id: int) -> None:
    """导入剧本后自动跑一次剧情分析(后台)。

    与 start_analysis 同逻辑, 但不依赖 HTTP user 上下文; 已有 pending/running 则跳过。
    供 stages.router 的 import-script/create 调用。
    """
    try:
        async with session_scope() as s:
            running = (await s.execute(
                select(ScriptAnalysis).where(
                    ScriptAnalysis.draft_id == draft_id,
                    ScriptAnalysis.status.in_(["pending", "running"]),
                )
            )).scalars().first()
            if running:
                return
            new_row = ScriptAnalysis(
                draft_id=draft_id, scope="full", status="pending",
                progress_step="queued", progress_current=0, progress_total=0,
            )
            s.add(new_row)
            await s.flush()
            analysis_id = new_row.id
        asyncio.create_task(run_analysis(draft_id, analysis_id))
        logger.info("auto analysis %d spawned for imported draft %d", analysis_id, draft_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("auto analysis spawn failed for draft %d: %s", draft_id, e)


async def _check_draft(s, draft_id: int, user: User) -> ScriptDraft:
    d = await s.get(ScriptDraft, draft_id)
    if not d:
        raise HTTPException(404, "draft not found")
    if user.role not in ("admin", "superadmin") and d.user_id != user.id:
        raise HTTPException(403, "无权访问此草稿")
    return d


@router.post("/drafts/{draft_id}/analysis/start")
async def start_analysis(
    draft_id: int,
    user: User = Depends(get_current_user),
):
    """启动一次新的分析任务(后台异步)。
    返回 analysis_id,前端轮询 GET /analysis/{aid} 拿进度和结果。
    """
    async with session_scope() as s:
        await _check_draft(s, draft_id, user)

        # 拒绝重复启动: 若已有 running 的分析,返回 409
        running = (await s.execute(
            select(ScriptAnalysis).where(
                ScriptAnalysis.draft_id == draft_id,
                ScriptAnalysis.status.in_(["pending", "running"]),
            )
        )).scalars().first()
        if running:
            return {
                "ok": True,
                "analysis_id": running.id,
                "status": running.status,
                "message": "已有分析任务在运行,返回该任务 ID",
            }

        # 限制只保留最近 MAX_HISTORY 条
        all_old = (await s.execute(
            select(ScriptAnalysis)
            .where(ScriptAnalysis.draft_id == draft_id)
            .order_by(ScriptAnalysis.created_at.desc())
        )).scalars().all()
        if len(all_old) >= MAX_HISTORY:
            # 删除最老的几条,留 MAX_HISTORY-1 给新的占位
            to_delete_ids = [r.id for r in all_old[MAX_HISTORY - 1:]]
            await s.execute(delete(ScriptAnalysis).where(ScriptAnalysis.id.in_(to_delete_ids)))

        # 创建新记录
        new_row = ScriptAnalysis(
            draft_id=draft_id,
            scope="full",
            status="pending",
            progress_step="queued",
            progress_current=0,
            progress_total=0,
        )
        s.add(new_row)
        await s.flush()
        analysis_id = new_row.id

    # 后台跑(不依赖 HTTP 连接)
    asyncio.create_task(run_analysis(draft_id, analysis_id))
    logger.info("started analysis %d for draft %d", analysis_id, draft_id)

    return {"ok": True, "analysis_id": analysis_id, "status": "pending"}


@router.get("/drafts/{draft_id}/analysis")
async def get_latest_analysis(
    draft_id: int,
    user: User = Depends(get_current_user),
):
    """拿最新的一次分析结果。如果还没分析过返回 {analysis: null}"""
    async with session_scope() as s:
        await _check_draft(s, draft_id, user)
        row = (await s.execute(
            select(ScriptAnalysis)
            .where(ScriptAnalysis.draft_id == draft_id)
            .order_by(ScriptAnalysis.created_at.desc())
        )).scalars().first()
        if not row:
            return {"ok": True, "analysis": None}
        return {"ok": True, "analysis": _row_to_dict(row)}


@router.get("/drafts/{draft_id}/analysis/history")
async def list_analysis_history(
    draft_id: int,
    user: User = Depends(get_current_user),
):
    """历史分析列表(简略,用于版本选择/对比)"""
    async with session_scope() as s:
        await _check_draft(s, draft_id, user)
        rows = (await s.execute(
            select(ScriptAnalysis)
            .where(ScriptAnalysis.draft_id == draft_id)
            .order_by(ScriptAnalysis.created_at.desc())
        )).scalars().all()
        return {"ok": True, "items": [_row_to_dict(r, lite=True) for r in rows]}


@router.get("/drafts/{draft_id}/analysis/{analysis_id}")
async def get_analysis_detail(
    draft_id: int,
    analysis_id: int,
    user: User = Depends(get_current_user),
):
    """拿指定一次分析的完整结果"""
    async with session_scope() as s:
        await _check_draft(s, draft_id, user)
        row = await s.get(ScriptAnalysis, analysis_id)
        if not row or row.draft_id != draft_id:
            raise HTTPException(404, "analysis not found")
        return {"ok": True, "analysis": _row_to_dict(row)}


@router.delete("/drafts/{draft_id}/analysis/{analysis_id}")
async def delete_analysis(
    draft_id: int,
    analysis_id: int,
    user: User = Depends(get_current_user),
):
    """删除某次分析"""
    async with session_scope() as s:
        await _check_draft(s, draft_id, user)
        row = await s.get(ScriptAnalysis, analysis_id)
        if not row or row.draft_id != draft_id:
            raise HTTPException(404, "analysis not found")
        if row.status in ("pending", "running"):
            raise HTTPException(409, "正在运行的任务不能删除,请等待完成或失败")
        await s.delete(row)
    return {"ok": True}


@router.get("/drafts/{draft_id}/analysis/{analysis_id}/export-docx")
async def export_analysis_docx(
    draft_id: int,
    analysis_id: int,
    user: User = Depends(get_current_user),
):
    """导出分析报告为 Word 文档"""
    async with session_scope() as s:
        draft = await _check_draft(s, draft_id, user)
        row = await s.get(ScriptAnalysis, analysis_id)
        if not row or row.draft_id != draft_id:
            raise HTTPException(404, "analysis not found")
        if row.status != "done":
            raise HTTPException(409, f"分析任务尚未完成(status={row.status})")
        analysis_dict = _row_to_dict(row)
        draft_title = draft.title or "未命名"

    try:
        docx_bytes = build_analysis_docx(draft_title=draft_title, analysis=analysis_dict)
    except Exception as e:
        logger.exception("build docx failed for analysis %d", analysis_id)
        raise HTTPException(500, f"docx generation failed: {e}")

    filename = f"{draft_title}_分析报告_{datetime.now().strftime('%Y%m%d_%H%M')}.docx"
    return Response(
        content=docx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        },
    )
