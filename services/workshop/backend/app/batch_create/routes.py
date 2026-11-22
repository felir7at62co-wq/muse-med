"""批量创建 API (面向普通用户)。

POST /v1/batch-create           发起一个批次(后台异步跑)
GET  /v1/batch-create/batches   我的批次列表(带每个草稿的进度+分数)
GET  /v1/batch-create/{id}      单批次详情/进度
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, desc

from ..auth import get_current_user, User
from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from ..db import session_scope
from ..db.models import AutoBatchJob
from .service import run_batch, MAX_COUNT

router = APIRouter(prefix="/v1/batch-create", tags=["batch-create"])
logger = logging.getLogger("batch_create.routes")


class BatchCreateIn(BaseModel):
    direction: str = Field("", description="创作方向: 时代背景/粗略情节等, 可留空")
    count: int = Field(5, ge=1, le=MAX_COUNT, description="一次创建多少个草稿(≤100)")
    words_per_episode: int = Field(DEFAULT_CHAPTER_WORD_TARGET, ge=1, le=20000)
    episodes: int = Field(12, ge=1, le=500)
    mode: str = Field("script", description="novel(小说/原文) 或 script(剧本)")
    model_provider: str = Field("gemini")


def _job_to_dict(job: AutoBatchJob) -> dict:
    cfg = job.config_json or {}
    return {
        "id": job.id,
        "name": job.name,
        "status": job.status,
        "total": job.total_dramas,
        "finished": job.finished_dramas,
        "failed": job.failed_dramas,
        "draft_ids": job.draft_ids or [],
        "direction": cfg.get("direction", ""),
        "mode": cfg.get("mode", "script"),
        "episodes": cfg.get("episodes"),
        "words": cfg.get("words"),
        "per_draft": cfg.get("per_draft") or [],
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


@router.post("")
async def create_batch(payload: BatchCreateIn, user: User = Depends(get_current_user)):
    if payload.mode not in ("novel", "script"):
        raise HTTPException(400, "mode 必须是 novel 或 script")
    count = min(payload.count, MAX_COUNT)

    per_draft = [{"step": "排队中", "draft_id": None, "score": None} for _ in range(count)]
    cfg = {
        "direction": payload.direction.strip(),
        "count": count,
        "words": payload.words_per_episode,
        "episodes": payload.episodes,
        "mode": payload.mode,
        "provider": payload.model_provider,
        "user_id": user.id,
        "per_draft": per_draft,
    }
    name = f"批量创建 {count}稿 · {'小说' if payload.mode=='novel' else '剧本'}"

    async with session_scope() as s:
        job = AutoBatchJob(
            name=name,
            config_json=cfg,
            status="pending",
            total_dramas=count,
            finished_dramas=0,
            failed_dramas=0,
            draft_ids=[],
            created_by=user.id,
        )
        s.add(job)
        await s.flush()
        await s.refresh(job)
        job_id = job.id
        result = _job_to_dict(job)

    # 后台异步跑, 不阻塞请求
    asyncio.create_task(run_batch(job_id))
    return result


@router.get("/batches")
async def list_batches(
    limit: int = Query(20, ge=1, le=100),
    user: User = Depends(get_current_user),
):
    """我发起的批次(倒序)。前端进度面板轮询这个。"""
    async with session_scope() as s:
        stmt = (
            select(AutoBatchJob)
            .where(AutoBatchJob.created_by == user.id)
            .order_by(desc(AutoBatchJob.created_at))
            .limit(limit)
        )
        rows = (await s.execute(stmt)).scalars().all()
        return {"items": [_job_to_dict(j) for j in rows]}


@router.get("/{job_id}")
async def get_batch(job_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        job = await s.get(AutoBatchJob, job_id)
        if not job:
            raise HTTPException(404, "批次不存在")
        if job.created_by != user.id and user.role not in ("admin", "superadmin"):
            raise HTTPException(403, "无权访问此批次")
        return _job_to_dict(job)


@router.post("/{job_id}/resume")
async def resume_batch(job_id: int, user: User = Depends(get_current_user)):
    """继续/断点续跑一个中断的批次。

    典型场景: 进程重启打断了内存里的批次协程, DB 里 job 停在 running/partial_failed/failed,
    但还有未完成的草稿。点"继续"即从断点补跑未完成的部分(已完成的会跳过, 不重复建草稿)。
    """
    async with session_scope() as s:
        job = await s.get(AutoBatchJob, job_id)
        if not job:
            raise HTTPException(404, "批次不存在")
        if job.created_by != user.id and user.role not in ("admin", "superadmin"):
            raise HTTPException(403, "无权访问此批次")
        if job.status == "done":
            raise HTTPException(400, "该批次已全部完成, 无需继续")
        cfg = dict(job.config_json or {})
        count = int(cfg.get("count") or job.total_dramas or 0)
        per_draft = list(cfg.get("per_draft") or [])
        done = sum(1 for pd in per_draft if isinstance(pd, dict) and pd.get("step") == "完成")
        remaining = count - done
        if remaining <= 0:
            raise HTTPException(400, "该批次没有可继续的剩余任务")

    asyncio.create_task(run_batch(job_id, resume=True))
    logger.info("batch_create job %d resume by user %d (剩余 %d)", job_id, user.id, remaining)
    return {"ok": True, "job_id": job_id, "resuming": remaining, "message": f"已开始继续, 补跑 {remaining} 个未完成的草稿"}
