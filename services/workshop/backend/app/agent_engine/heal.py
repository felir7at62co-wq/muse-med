"""Agent 运行的"孤儿"自愈：运行状态说还没完，但已经没有任何东西会推进它。

## 为什么需要（2026-10-28）

`agent_runs.status` 和 `agent_jobs` 是两张表，中间任何一步失手，运行就会停在一个
**界面上看着在等、实际永远不会动**的状态。三种形态：

=====================  ============================================  ==================
运行状态               没有人推进它的原因                             自愈动作
=====================  ============================================  ==================
queued                 作业没入成队 / 作业被跳过（会话锁冲突）/      重新入队
                       作业重试耗尽后 failed
running                执行它的作业已经结束（done/failed），         判失败并说明原因
                       但没走到收尾
awaiting_approval      没有任何 pending 的审批项 —— 界面上           重新入队（runner 会
                       没有确认卡片，用户无从点起                    按已有的决定续跑）
=====================  ============================================  ==================

用户看到的分别是"排队中（等一个空闲的执行位）"一直不变、"进行中"一直不变、
"等待你确认"却没有确认弹窗。

## 什么时候跑

查询运行状态的接口（会话回放、单轮详情、草稿活动）在返回前调用 `heal_runs`。
不另起定时任务：没人看的孤儿不会伤到谁，有人看时当场修好即可。

## 不误伤正常流程的依据

- queued：入队与建运行是两个事务，中间有毫秒级窗口 → 只处理 `updated_at` 超过
  `QUEUED_GRACE` 秒且确实没有 queued/running 作业的；判断与入队在同一把
  事务级咨询锁里做，并发两次查询也只会入队一次。
- running：作业在 handler 返回之后才标 done，而 handler 返回前已经收尾运行 →
  "作业不活跃 + 运行仍 running"只可能是中断。仍留 `RUNNING_GRACE` 秒余量。
- awaiting_approval：runner 先落 pending 审批项、再把状态改成 awaiting_approval，
  所以"awaiting 且无 pending"在正常流程里不存在（审批接口自己也会入队；两边都入队
  时第二个作业会因运行已不在可执行状态而跳过）。
"""
from __future__ import annotations

import logging
from datetime import datetime

from sqlalchemy import text

from ..db import session_scope

logger = logging.getLogger("agent_engine.heal")

QUEUED_GRACE = 30
RUNNING_GRACE = 60


async def heal_runs(run_ids: list[int]) -> set[int]:
    """检查并修复给定运行里的孤儿。返回被改动过的运行 id。

    永不抛异常：它是查询接口的附带动作，修不了也不该连累查询本身。
    """
    ids = [int(x) for x in run_ids if x]
    if not ids:
        return set()
    changed: set[int] = set()
    try:
        async with session_scope() as s:
            rows = (await s.execute(text("""
                SELECT r.id, r.user_id, r.status,
                       extract(epoch from (now() - coalesce(r.updated_at, r.created_at))) AS age,
                       EXISTS (SELECT 1 FROM agent_jobs j
                                WHERE j.kind = 'agent_run' AND j.status IN ('queued', 'running')
                                  AND (j.payload->>'run_id') = r.id::text) AS has_job,
                       EXISTS (SELECT 1 FROM agent_approvals a
                                WHERE a.run_id = r.id AND a.status = 'pending') AS has_pending
                FROM agent_runs r
                WHERE r.id = ANY(:ids) AND r.status IN ('queued', 'running', 'awaiting_approval')
            """), {"ids": ids})).mappings().all()
        for r in rows:
            st, age = r["status"], float(r["age"] or 0)
            if st == "queued" and not r["has_job"] and age > QUEUED_GRACE:
                if await _requeue(r["id"], r["user_id"], from_status="queued"):
                    changed.add(r["id"])
            elif st == "awaiting_approval" and not r["has_pending"]:
                if await _requeue(r["id"], r["user_id"], from_status="awaiting_approval"):
                    changed.add(r["id"])
            elif st == "running" and not r["has_job"] and age > RUNNING_GRACE:
                if await _fail_interrupted(r["id"]):
                    changed.add(r["id"])
    except Exception:  # noqa: BLE001
        logger.warning("agent 运行自愈检查失败 ids=%s", ids[:20], exc_info=True)
    return changed


async def _requeue(run_id: int, user_id: int, *, from_status: str) -> bool:
    """在咨询锁内复核"仍是孤儿"再入队，保证并发查询只入一次队。"""
    from ..agent import jobs
    async with session_scope() as s:
        await s.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"agent:heal:{run_id}"})
        still = (await s.execute(text("""
            SELECT 1 FROM agent_runs r
            WHERE r.id = :id AND r.status = :st
              AND NOT EXISTS (SELECT 1 FROM agent_jobs j
                               WHERE j.kind = 'agent_run' AND j.status IN ('queued', 'running')
                                 AND (j.payload->>'run_id') = r.id::text)
              AND (:st <> 'awaiting_approval' OR NOT EXISTS (
                    SELECT 1 FROM agent_approvals a WHERE a.run_id = r.id AND a.status = 'pending'))
        """), {"id": run_id, "st": from_status})).first()
        if not still:
            return False
        await s.execute(text("UPDATE agent_runs SET status = 'queued', updated_at = now() WHERE id = :id"),
                        {"id": run_id})
        # 入队放在同一事务里（不能调 jobs.enqueue —— 它自开事务，锁释放前作业行还不可见，
        # 并发的第二个复核者会再入一次）。字段与 jobs.enqueue 保持一致。
        from ..db.models import AgentJob
        job = AgentJob(kind="agent_run", user_id=user_id, status="queued", payload={"run_id": run_id},
                       attempt=0, max_attempts=jobs.DEFAULT_MAX_ATTEMPTS, progress=0)
        s.add(job)
        await s.flush()
        job_id = job.id
    logger.warning("agent run %s: 状态 %s 但没有任何作业/审批项推进它，已重新入队（作业 #%s）",
                   run_id, from_status, job_id)
    return True


async def _fail_interrupted(run_id: int) -> bool:
    async with session_scope() as s:
        res = await s.execute(text("""
            UPDATE agent_runs SET status = 'failed', finished_at = :now, updated_at = now(),
                   error = coalesce(error, '执行进程中途退出，这一轮没有正常收尾。已经完成的修改会保留，可以重新发送指令接着做。')
            WHERE id = :id AND status = 'running'
              AND NOT EXISTS (SELECT 1 FROM agent_jobs j
                               WHERE j.kind = 'agent_run' AND j.status IN ('queued', 'running')
                                 AND (j.payload->>'run_id') = :sid)
        """), {"id": run_id, "sid": str(run_id), "now": datetime.utcnow()})
        ok = (res.rowcount or 0) > 0
    if ok:
        logger.warning("agent run %s: 状态 running 但执行作业已结束，判为中断失败", run_id)
    return ok
