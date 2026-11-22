"""自动打磨工作流 API。

- POST /v1/polish            : 提交打磨作业(draft_ids + max_rounds + target_score)
- GET  /v1/polish            : 我的作业列表
- GET  /v1/polish/{id}       : 进度 + 每草稿轨迹
- POST /v1/polish/{id}/resume: 继续/断点续跑
- POST /v1/polish/{id}/cancel: 取消
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..auth import get_current_user, User
from ..db import session_scope, ScriptDraft
from ..db.models import PolishJob
from . import service

router = APIRouter(prefix="/v1/polish", tags=["polish"])
logger = logging.getLogger("polish.routes")


class SubmitBody(BaseModel):
    draft_ids: list[int] = Field(..., description="目标草稿ID列表")
    max_rounds: int = Field(3, ge=1, le=10, description="单草稿最大打磨轮数")
    target_score: int = Field(80, ge=0, le=100, description="达标综合分阈值")
    target_p0: int = Field(0, ge=0, description="达标要求的P0上限(默认0=无硬伤)")
    title: str = Field("", description="人话描述(可选)")


@router.post("")
async def submit(body: SubmitBody, user: User = Depends(get_current_user)):
    if not body.draft_ids:
        raise HTTPException(400, "draft_ids 不能为空")
    if len(body.draft_ids) > 300:
        raise HTTPException(400, "单次打磨上限 300 个草稿")

    # 校验草稿归属(只操作自己的; admin 可操作全部)
    async with session_scope() as s:
        rows = (await s.execute(
            select(ScriptDraft.id, ScriptDraft.title, ScriptDraft.user_id)
            .where(ScriptDraft.id.in_(body.draft_ids))
        )).all()
    owned_ids, per = [], {}
    for did, title, uid in rows:
        if user.role in ("admin", "superadmin") or uid == user.id:
            owned_ids.append(did)
            per[str(did)] = {"title": title or f"草稿#{did}", "status": "待处理", "rounds": []}
    if not owned_ids:
        raise HTTPException(403, "没有可操作的草稿(可能无权限或ID不存在)")

    async with session_scope() as s:
        job = PolishJob(
            user_id=user.id,
            title=body.title or f"自动打磨({len(owned_ids)}个草稿, 目标{body.target_score}分/P0≤{body.target_p0})",
            draft_ids=owned_ids,
            max_rounds=body.max_rounds,
            target_score=body.target_score,
            target_p0=body.target_p0,
            status="pending",
            total=len(owned_ids),
            finished=0, failed=0,
            per_draft_json=per,
        )
        s.add(job)
        await s.flush()
        job_id = job.id

    asyncio.create_task(service.run_polish(job_id))
    return {
        "ok": True, "job_id": job_id, "total": len(owned_ids),
        "max_rounds": body.max_rounds, "target_score": body.target_score, "target_p0": body.target_p0,
        "message": f"自动打磨已启动: {len(owned_ids)}个草稿, 最多{body.max_rounds}轮, "
                   f"目标{body.target_score}分且P0≤{body.target_p0}",
    }


def _job_view(job: PolishJob) -> dict:
    return {
        "id": job.id, "title": job.title, "status": job.status,
        "total": job.total, "finished": job.finished, "failed": job.failed,
        "max_rounds": job.max_rounds, "target_score": job.target_score, "target_p0": job.target_p0,
        "draft_ids": job.draft_ids, "per_draft": job.per_draft_json, "error": job.error,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


@router.get("")
async def list_jobs(user: User = Depends(get_current_user)):
    async with session_scope() as s:
        rows = (await s.execute(
            select(PolishJob).where(PolishJob.user_id == user.id)
            .order_by(PolishJob.created_at.desc()).limit(50)
        )).scalars().all()
        return {"items": [_job_view(j) for j in rows]}


@router.get("/{job_id}")
async def get_job(job_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        job = await s.get(PolishJob, job_id)
        if not job:
            raise HTTPException(404, "作业不存在")
        if job.user_id != user.id and user.role not in ("admin", "superadmin"):
            raise HTTPException(403, "无权查看")
        return _job_view(job)


@router.post("/{job_id}/resume")
async def resume_job(job_id: int, user: User = Depends(get_current_user)):
    """继续/断点续跑一个中断的打磨作业(已收敛/已达最大轮的草稿跳过)。"""
    _DONE = {"达标", "已达最大轮"}
    async with session_scope() as s:
        job = await s.get(PolishJob, job_id)
        if not job:
            raise HTTPException(404, "作业不存在")
        if job.user_id != user.id and user.role not in ("admin", "superadmin"):
            raise HTTPException(403, "无权操作")
        if job.status == "done":
            raise HTTPException(400, "该作业已全部完成, 无需继续")
        per = dict(job.per_draft_json or {})
        draft_ids = list(job.draft_ids or [])
        remaining = sum(1 for d in draft_ids if (per.get(str(d)) or {}).get("status") not in _DONE)
        if remaining <= 0:
            raise HTTPException(400, "该作业没有可继续的剩余草稿")

    asyncio.create_task(service.run_polish(job_id, resume=True))
    logger.info("polish job %d resume by user %d (剩余 %d)", job_id, user.id, remaining)
    return {"ok": True, "job_id": job_id, "resuming": remaining,
            "message": f"已开始继续, 补跑 {remaining} 个未收敛的草稿"}


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: int, user: User = Depends(get_current_user)):
    """取消一个打磨作业(协程在每轮动作前会检查, 感知到即停手)。"""
    from sqlalchemy.orm.attributes import flag_modified
    async with session_scope() as s:
        job = await s.get(PolishJob, job_id)
        if not job:
            raise HTTPException(404, "作业不存在")
        if job.user_id != user.id and user.role not in ("admin", "superadmin"):
            raise HTTPException(403, "无权操作")
        if job.status in ("done", "canceled"):
            raise HTTPException(400, f"作业已{job.status}, 无需取消")
        job.status = "canceled"
        job.finished_at = datetime.now(timezone.utc)
        # 把还在"优化中"的草稿标为已取消
        per = dict(job.per_draft_json or {})
        for k, v in per.items():
            if isinstance(v, dict) and v.get("status") in ("优化中", "待处理"):
                v = dict(v)
                v["status"] = "已取消"
                per[k] = v
        job.per_draft_json = per
        flag_modified(job, "per_draft_json")
        await s.flush()

    logger.info("polish job %d canceled by user %d", job_id, user.id)
    return {"ok": True, "job_id": job_id, "message": "作业已取消; 未收敛的草稿可稍后点「继续」补跑。"}