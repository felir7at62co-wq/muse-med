"""Agent 批量运营作业 API。

- POST /v1/agent-batch/submit  : 提交一个批量作业(Agent 技能调用它)
- GET  /v1/agent-batch/{job_id}: 查作业进度
- GET  /v1/agent-batch         : 列出我的作业
- POST /v1/agent-batch/{job_id}/apply-pending: 手动采纳(非全自动模式下, 精修完成后用)
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
from ..db.models import AgentBatchJob
from . import service

router = APIRouter(prefix="/v1/agent-batch", tags=["agent-batch"])
logger = logging.getLogger("agent_batch.routes")

_ALLOWED_ACTIONS = {"reanalyze", "optimize_by_analysis", "critique", "apply_critique", "fill_missing_storyboards"}


class SubmitBody(BaseModel):
    title: str = Field("", description="人话描述")
    draft_ids: list[int] = Field(..., description="目标草稿ID列表(Agent 已筛选好)")
    action_chain: list[str] = Field(..., description="动作链, 按顺序执行")
    params: dict = Field(default_factory=dict, description="动作参数(intensity/source/feedback等)")
    auto_apply: bool = Field(False, description="全自动模式: 精修后自动采纳/覆盖")
    filter_desc: dict = Field(default_factory=dict, description="筛选条件快照(仅记录)")


@router.post("/submit")
async def submit(body: SubmitBody, user: User = Depends(get_current_user)):
    if not body.draft_ids:
        raise HTTPException(400, "draft_ids 不能为空")
    if len(body.draft_ids) > 300:
        raise HTTPException(400, "单次批量上限 300 个草稿")
    bad = [a for a in body.action_chain if a not in _ALLOWED_ACTIONS]
    if bad:
        raise HTTPException(400, f"不支持的动作: {bad}; 允许: {sorted(_ALLOWED_ACTIONS)}")

    # 校验草稿归属(只操作自己的; admin 可操作全部)
    async with session_scope() as s:
        rows = (await s.execute(
            select(ScriptDraft.id, ScriptDraft.title, ScriptDraft.user_id)
            .where(ScriptDraft.id.in_(body.draft_ids))
        )).all()
    owned = []
    for did, title, uid in rows:
        if user.role in ("admin", "superadmin") or uid == user.id:
            owned.append({"draft_id": did, "title": title or f"草稿#{did}",
                          "status": "pending", "step": "", "detail": ""})
    if not owned:
        raise HTTPException(403, "没有可操作的草稿(可能无权限或ID不存在)")

    async with session_scope() as s:
        job = AgentBatchJob(
            user_id=user.id,
            title=body.title or f"批量{'+'.join(body.action_chain)}({len(owned)}个草稿)",
            filter_json=body.filter_desc,
            action_chain=body.action_chain,
            params_json=body.params,
            auto_apply=1 if body.auto_apply else 0,
            status="pending",
            total=len(owned),
            finished=0, failed=0,
            items_json=owned,
        )
        s.add(job)
        await s.flush()
        job_id = job.id

    asyncio.create_task(service.run_agent_batch(job_id))
    return {"ok": True, "job_id": job_id, "total": len(owned),
            "auto_apply": body.auto_apply,
            "message": f"批量作业已启动: {len(owned)}个草稿 × [{' → '.join(body.action_chain)}]"
                       + ("(全自动: 精修后自动采纳)" if body.auto_apply else "(精修后需手动采纳)")}


def _job_view(job: AgentBatchJob) -> dict:
    return {
        "id": job.id, "title": job.title, "status": job.status,
        "total": job.total, "finished": job.finished, "failed": job.failed,
        "auto_apply": bool(job.auto_apply),
        "action_chain": job.action_chain, "params": job.params_json,
        "items": job.items_json, "error": job.error,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


@router.get("/{job_id}")
async def get_job(job_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        job = await s.get(AgentBatchJob, job_id)
        if not job:
            raise HTTPException(404, "作业不存在")
        if job.user_id != user.id and user.role not in ("admin", "superadmin"):
            raise HTTPException(403, "无权查看")
        return _job_view(job)


@router.get("")
async def list_jobs(user: User = Depends(get_current_user)):
    async with session_scope() as s:
        rows = (await s.execute(
            select(AgentBatchJob).where(AgentBatchJob.user_id == user.id)
            .order_by(AgentBatchJob.created_at.desc()).limit(50)
        )).scalars().all()
        return {"items": [_job_view(j) for j in rows]}


@router.post("/{job_id}/apply-pending")
async def apply_pending(job_id: int, user: User = Depends(get_current_user)):
    """非全自动模式: 精修完成后, 手动一键采纳所有待采纳草稿。"""
    from ..critique import service as critique_service
    async with session_scope() as s:
        job = await s.get(AgentBatchJob, job_id)
        if not job:
            raise HTTPException(404, "作业不存在")
        if job.user_id != user.id and user.role not in ("admin", "superadmin"):
            raise HTTPException(403, "无权操作")
        items = list(job.items_json or [])

    applied, skipped = [], []
    for it in items:
        rid = it.get("pending_run_id")
        if rid and it.get("status") != "applied":
            try:
                await critique_service.apply_run(run_id=rid, user_id=job.user_id, episode_orders=None)
                applied.append(it["draft_id"])
            except Exception as e:
                skipped.append({"draft_id": it["draft_id"], "err": str(e)[:100]})
    return {"ok": True, "applied": applied, "skipped": skipped}


@router.post("/{job_id}/resume")
async def resume_job(job_id: int, user: User = Depends(get_current_user)):
    """继续/断点续跑一个中断的批量作业。

    进程重启会打断内存协程, DB 里 job 停在 running/partial_failed, 部分草稿卡在假 running。
    点"继续"从断点补跑未完成的草稿(status!='done' 的都重跑, 已完成的跳过)。
    """
    async with session_scope() as s:
        job = await s.get(AgentBatchJob, job_id)
        if not job:
            raise HTTPException(404, "作业不存在")
        if job.user_id != user.id and user.role not in ("admin", "superadmin"):
            raise HTTPException(403, "无权操作")
        if job.status == "done":
            raise HTTPException(400, "该作业已全部完成, 无需继续")
        items = list(job.items_json or [])
        remaining = sum(1 for it in items if (it or {}).get("status") != "done")
        if remaining <= 0:
            raise HTTPException(400, "该作业没有可继续的剩余任务")

    asyncio.create_task(service.run_agent_batch(job_id, resume=True))
    logger.info("agent_batch job %d resume by user %d (剩余 %d)", job_id, user.id, remaining)
    return {"ok": True, "job_id": job_id, "resuming": remaining, "message": f"已开始继续, 补跑 {remaining} 个未完成的草稿"}


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: int, user: User = Depends(get_current_user)):
    """暂停/取消一个批量作业。

    - 把作业标记为 canceled(内存协程在每个草稿动作前会检查, 感知到即停手)。
    - 顺带取消该作业名下【正在跑/排队】的评审精修 run(否则精修会继续跑完)。
    已完成的草稿不受影响; 之后可用「继续(resume)」从断点补跑未完成的。
    """
    from ..critique.models import CritiqueRun
    async with session_scope() as s:
        job = await s.get(AgentBatchJob, job_id)
        if not job:
            raise HTTPException(404, "作业不存在")
        if job.user_id != user.id and user.role not in ("admin", "superadmin"):
            raise HTTPException(403, "无权操作")
        if job.status in ("done", "canceled"):
            raise HTTPException(400, f"作业已{job.status}, 无需取消")
        items = list(job.items_json or [])
        draft_ids = [it.get("draft_id") for it in items if it.get("draft_id")]
        job.status = "canceled"
        job.finished_at = datetime.now(timezone.utc)
        # 把还卡在 running/pending 的草稿项标为 canceled(已 done 的保留)
        new_items = []
        for it in items:
            it = dict(it)
            if it.get("status") in ("running", "pending"):
                it["status"] = "canceled"
                it["step"] = "已取消"
            new_items.append(it)
        job.items_json = new_items
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(job, "items_json")
        await s.flush()

    # 取消该作业名下正在跑/排队的精修 run
    canceled_runs = 0
    if draft_ids:
        async with session_scope() as s:
            runs = (await s.execute(
                select(CritiqueRun).where(
                    CritiqueRun.draft_id.in_(draft_ids),
                    CritiqueRun.user_id == job.user_id,
                    CritiqueRun.status.in_(["running", "pending"]),
                )
            )).scalars().all()
            for r in runs:
                r.status = "canceled"
                r.updated_at = datetime.now(timezone.utc)
                canceled_runs += 1
            await s.flush()

    logger.info("agent_batch job %d canceled by user %d (取消精修 %d)", job_id, user.id, canceled_runs)
    return {"ok": True, "job_id": job_id, "canceled_runs": canceled_runs,
            "message": f"作业已取消; 同时停掉 {canceled_runs} 个正在跑的精修。未完成的草稿可稍后点「继续」补跑。"}
