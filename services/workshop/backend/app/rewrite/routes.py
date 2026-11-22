"""整本 AI 精修 API。替代旧"打磨"的单稿入口, 结果直接覆写回草稿。"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from ..auth import get_current_user, User
from ..db import session_scope, ScriptDraft
from ..db.models import RewriteJob
from . import service

logger = logging.getLogger("rewrite.routes")

router = APIRouter(prefix="/v1/rewrite", tags=["rewrite"])


class SubmitBody(BaseModel):
    draft_id: int
    model: str = "gpt5"
    # 用户参考意见(对话工坊「自动精修」模式下发的那句话)。空 = 常规四维精修。
    guidance: str = ""


def _job_view(j: RewriteJob) -> dict:
    return {
        "id": j.id,
        "draft_id": j.draft_id,
        "title": j.title,
        "status": j.status,
        "model": j.model,
        "total": j.total,
        "finished": j.finished,
        "per_ep": j.per_ep_json or {},
        "analysis": j.analysis_text or "",
        "summary": j.summary_json or {},
        "guidance": getattr(j, "guidance", "") or "",
        "error": j.error or "",
        "created_at": j.created_at.isoformat() if j.created_at else None,
        "finished_at": j.finished_at.isoformat() if j.finished_at else None,
    }


@router.post("")
async def submit(body: SubmitBody, user: User = Depends(get_current_user)):
    """提交一个整本精修作业。校验草稿归属后异步执行。"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, body.draft_id)
        if not d:
            raise HTTPException(404, "draft not found")
        # 归属校验: 非管理员只能操作自己的草稿
        if user.role not in ("admin", "superadmin") and d.user_id != user.id:
            raise HTTPException(403, "无权操作该草稿")
        job = RewriteJob(
            user_id=user.id, draft_id=body.draft_id,
            title=(d.title or f"草稿{body.draft_id}"),
            status="running", model=body.model or "gpt5",
            # 截断留底即可: 这是"用户当时说了什么"的备忘, 不是要下发的 prompt 本体
            # (prompt 侧另有长度约束)。8000 字足够覆盖一句话意见的全部合理用法。
            guidance=(body.guidance or "").strip()[:8000],
            # 建行时就写心跳：判活窗口是 180 秒，而 _heartbeat_loop 的头一次心跳
            # 要等 30 秒才来。不写这一笔的话，这 30 秒里唯一能用的时间戳是
            # created_at（判活逻辑会回落到它，所以不会误判），但显式写下来
            # 让"这行从诞生起就是活的"这件事在库里可见，排查时不用靠推断。
            heartbeat_at=datetime.now(timezone.utc).replace(tzinfo=None),
        )
        s.add(job)
        await s.flush()
        job_id = job.id
    asyncio.create_task(service.run_rewrite(job_id))
    logger.info("rewrite job %d submitted for draft %d", job_id, body.draft_id)
    return {"ok": True, "job_id": job_id}


@router.get("")
async def list_jobs(draft_id: int | None = None, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        q = select(RewriteJob).where(RewriteJob.user_id == user.id)
        if draft_id:
            q = q.where(RewriteJob.draft_id == draft_id)
        rows = (await s.execute(
            q.order_by(RewriteJob.created_at.desc()).limit(30)
        )).scalars().all()
    return {"ok": True, "items": [_job_view(r) for r in rows]}


@router.get("/{job_id}")
async def get_job(job_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        j = await s.get(RewriteJob, job_id)
        if not j:
            raise HTTPException(404, "job not found")
        if user.role not in ("admin", "superadmin") and j.user_id != user.id:
            raise HTTPException(403, "无权查看该作业")
        return {"ok": True, "job": _job_view(j)}


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        j = await s.get(RewriteJob, job_id)
        if not j:
            raise HTTPException(404, "job not found")
        if user.role not in ("admin", "superadmin") and j.user_id != user.id:
            raise HTTPException(403, "无权操作该作业")
        if j.status in ("running", "pending", "analyzing", "rewriting"):
            j.status = "canceled"
    return {"ok": True}