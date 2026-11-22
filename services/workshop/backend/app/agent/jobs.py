"""长任务持久化 (Durable Jobs) —— 租约 + 心跳 + 幂等重放的作业队列。

为什么需要它（实测根因）：
  现有长任务（精修、改编、批量生成）都用 `asyncio.create_task` 跑在 orchestrator
  容器进程内存里。容器一重启（部署/OOM/异常退出），任务凭空消失，而数据库状态
  永远停在 `running` —— dev 库 402 条 `critique_runs.interrupted` 就是这么来的。

设计（借鉴 Temporal / DBOS 的 durable execution，但用 Postgres 原生能力实现）：

  作业表即真相源
    - API 只写一行 status='queued' 就返回，**不启动任何后台协程**
    - worker 用 `SELECT ... FOR UPDATE SKIP LOCKED` 原子领取（无需 Redis/Celery）
    - 执行中续租 + 心跳；租约过期即判定持有者已死
    - worker 启动时扫过期租约 → 标 interrupted → 重新入队（幂等重放）

  **幂等是硬要求**：同一作业被重放必须安全。约定：
    - 生成类：按"每集一行、有则覆盖"天然幂等
    - 修复类：必须记录已应用的操作 id（利用 AgentOperation 表），避免重复应用
"""
from __future__ import annotations

import asyncio
import logging
import os
import socket
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from sqlalchemy import select, text, update
from sqlalchemy.orm.attributes import flag_modified

from ..db import session_scope
from ..db.models import AgentJob

logger = logging.getLogger("jobs")

#: 租约时长。worker 每 LEASE_SECONDS/3 续租一次。
LEASE_SECONDS = 90
HEARTBEAT_INTERVAL = 30

#: 单作业最大尝试次数，超过则标 failed（避免坏作业无限重放）。
DEFAULT_MAX_ATTEMPTS = 3

#: worker 身份：主机名 + 进程内随机后缀，便于多进程/多机区分。
WORKER_ID = f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)   # 库列是 naive UTC


# ---------------------------------------------------------------------------
# 入队
# ---------------------------------------------------------------------------

async def enqueue(*, kind: str, draft_id: int | None = None,
                  user_id: int | None = None, payload: dict | None = None,
                  max_attempts: int = DEFAULT_MAX_ATTEMPTS) -> int:
    """入队一个作业，返回 job_id。只写库，不启动任何后台任务。"""
    payload = dict(payload or {})
    # 入队时若处在"指定了写作模型"的环境里（Agent 运行 / 对话栏动作），把它带进 payload，
    # worker 执行时再恢复 —— 作业跨进程执行，contextvar 自己过不去。见 job_context.WRITING_MODEL。
    if "writing_model" not in payload:
        from ..job_context import current_writing_model
        _wm = current_writing_model()
        if _wm:
            payload["writing_model"] = _wm
    async with session_scope() as s:
        job = AgentJob(
            kind=kind, draft_id=draft_id, user_id=user_id,
            status="queued", payload=payload,
            attempt=0, max_attempts=max_attempts, progress=0,
        )
        s.add(job)
        await s.flush()
        await s.refresh(job)
        logger.info("enqueue job #%s kind=%s draft=%s", job.id, kind, draft_id)
        return job.id


# ---------------------------------------------------------------------------
# 领取（原子）
# ---------------------------------------------------------------------------

async def claim_one(*, kinds: list[str] | None = None) -> dict | None:
    """原子领取一个待执行作业。没有则返回 None。

    用 `FOR UPDATE SKIP LOCKED`：多个 worker 并发领取不会拿到同一个作业，
    也不需要分布式锁或队列中间件。

    返回的字典会直接交给 handler（见 `run_job`），所以这里**必须带上 `result`**：
    重试/崩溃重放时 handler 要靠上一次尝试写进去的 result 判断"这一步是不是已经做过了"
    （例：`rewrite_script` 从 result 里读 `rewrite_job_id`，否则重放会再建一个改写作业、
    把同一部剧精修两遍 —— 那是**覆写**操作，重复执行是真损失）。
    旧的省略写法（只有 id/kind/draft/user/payload/attempt/max_attempts）会让这类保护
    静默失效：handler 读到 None，看起来一切正常，实际每次都当首次执行。
    """
    kind_filter = ""
    params: dict[str, Any] = {
        "worker": WORKER_ID,
        "lease": _now() + timedelta(seconds=LEASE_SECONDS),
    }
    if kinds:
        # 别名是 c —— 见下面子查询。这里必须与它一致。
        kind_filter = "AND c.kind = ANY(:kinds)"
        params["kinds"] = list(kinds)

    # ⚠️ 挑作业时必须**跳过已有作业在跑的草稿**（2026-10-09）。
    #
    # 队列此前是纯 `ORDER BY id`：一个草稿上的长任务（精修 61 集、生成大纲
    # 30 集，动辄十几分钟到几小时）会把**排在它后面的所有作业**一起堵住 ——
    # 哪怕那些作业属于**完全不相干的草稿**。实测：草稿 690 的精修(#84) 让
    # 草稿 691 的生成大纲(#85) 白等了 12 分钟。
    #
    # 按设计，**同一草稿**互斥是**语义**要求（都是覆写同一批集，并发会互相
    # 覆盖，见 chat_jobs 顶部注释），但**不同草稿之间没有任何理由串行** ——
    # compose 里也写明 worker "可横向扩展（多开 replicas）"。
    # 「同草稿互斥」与「全队列串行」是两回事，前者是必须的，后者是副作用。
    #
    # 这里用 NOT EXISTS 把前者的约束表达出来，同时让后者消失：
    #   · 同草稿已有 running → 这个作业继续等（正确，且是语义要求）
    #   · 别的草稿在跑 → 不影响，照领（修掉真正的病）
    #   · draft_id 为空（草稿无关的作业）→ 永远可领
    #
    # 与多开 worker 正交互补，不是替代：这条解决"不该等的在等"，
    # 多开解决"一个消费者不够"。两者都做才对。
    sql = text(f"""
        UPDATE agent_jobs SET
            status = 'running',
            lease_owner = :worker,
            lease_expires_at = :lease,
            heartbeat_at = now(),
            attempt = attempt + 1,
            updated_at = now(),
            -- 记录**真正开跑**的时刻（不含排队），界面的"还要多久"才能算得准。
            -- 用 payload 存而不是加一列：不必迁移，且 requeue 后重领会自然刷新成新一轮的起点。
            payload = jsonb_set(coalesce(payload, '{{}}'::jsonb), '{{_started_at}}',
                                to_jsonb(extract(epoch from now())))
        WHERE id = (
            SELECT c.id FROM agent_jobs c
            WHERE c.status = 'queued' {kind_filter}
              AND NOT EXISTS (
                  SELECT 1 FROM agent_jobs r
                  WHERE r.draft_id IS NOT NULL
                    AND r.draft_id = c.draft_id
                    AND r.status = 'running'
              )
            ORDER BY c.id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        RETURNING id, kind, draft_id, user_id, payload, attempt, max_attempts,
                  result, progress, progress_note
    """)
    async with session_scope() as s:
        row = (await s.execute(sql, params)).mappings().first()
        if not row:
            return None
        return dict(row)


async def heartbeat(job_id: int) -> bool:
    """续租。返回 False 表示租约已被别人抢走（应尽快停止工作）。"""
    async with session_scope() as s:
        res = await s.execute(
            update(AgentJob)
            .where(AgentJob.id == job_id, AgentJob.lease_owner == WORKER_ID)
            .values(heartbeat_at=_now(),
                    lease_expires_at=_now() + timedelta(seconds=LEASE_SECONDS))
        )
        return (res.rowcount or 0) > 0


async def set_progress(job_id: int, *, progress: int | None = None,
                       note: str | None = None,
                       result: dict | None = None) -> None:
    """更新进度/结果（供前端实时读取）。"""
    async with session_scope() as s:
        job = await s.get(AgentJob, job_id)
        if not job:
            return
        if progress is not None:
            job.progress = max(0, min(100, int(progress)))
        if note is not None:
            job.progress_note = note
        if result is not None:
            job.result = result
            flag_modified(job, "result")
        await s.flush()


async def queue_positions(job_ids: list[int]) -> dict[int, int]:
    """每个排队中的作业"前面还有几个"。

    口径：比它早、且还没跑完的作业数（queued + running 都算）。
    这只是**乐观的估算** —— 真正决定何时开跑的是 `claim_one`（还要看"同草稿互斥"
    和 worker 槽位），所以界面上写成"前面还有 N 个任务"，不要写成精确名次。

    一次查完一批，避免 /jobs 列表每行一个 COUNT。
    """
    if not job_ids:
        return {}
    async with session_scope() as s:
        rows = (await s.execute(text("""
            SELECT j.id,
                   (SELECT count(*) FROM agent_jobs a
                     WHERE a.id < j.id AND a.status IN ('queued', 'running')) AS ahead
            FROM agent_jobs j
            WHERE j.id = ANY(:ids)
        """), {"ids": list(job_ids)})).mappings().all()
    return {int(r["id"]): int(r["ahead"] or 0) for r in rows}


async def is_canceled(job_id: int) -> bool:
    """作业是否已被用户取消。长作业应在每个阶段/每一集开头调用，协作式退出。"""
    async with session_scope() as s:
        job = await s.get(AgentJob, job_id)
        return bool(job and job.status == "canceled")


async def finish(job_id: int, *, status: str = "done",
                 result: dict | None = None, error: str = "") -> None:
    """标记作业完成/失败，释放租约。"""
    async with session_scope() as s:
        job = await s.get(AgentJob, job_id)
        if not job:
            return
        job.status = status
        job.error = error or None
        if result is not None:
            job.result = result
            flag_modified(job, "result")
        job.lease_owner = None
        job.lease_expires_at = None
        if status == "done":
            job.progress = 100
        await s.flush()
        logger.info("job #%s → %s", job_id, status)


# ---------------------------------------------------------------------------
# 崩溃恢复
# ---------------------------------------------------------------------------

async def requeue_expired() -> int:
    """把租约过期的 running 作业重新入队。worker 启动时与运行期定期调用。

    返回重新入队的数量。
    """
    async with session_scope() as s:
        rows = (await s.execute(text("""
            UPDATE agent_jobs SET
                status = 'queued',
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = now()
            WHERE status = 'running'
              AND lease_expires_at IS NOT NULL
              AND lease_expires_at < now()
            RETURNING id, attempt, max_attempts, kind
        """))).mappings().all()

        requeued = 0
        for r in rows:
            if (r["attempt"] or 0) >= (r["max_attempts"] or DEFAULT_MAX_ATTEMPTS):
                await s.execute(text("""
                    UPDATE agent_jobs SET status='failed',
                        error='超过最大尝试次数', updated_at=now()
                    WHERE id=:id
                """), {"id": r["id"]})
                logger.warning("job #%s 超过最大尝试次数(%s), 标 failed",
                               r["id"], r["max_attempts"])
            else:
                requeued += 1
                logger.info("job #%s 租约过期, 重新入队(第 %s 次)",
                            r["id"], (r["attempt"] or 0) + 1)
        return requeued


# ---------------------------------------------------------------------------
# worker 主循环
# ---------------------------------------------------------------------------

#: 作业类型 → 处理函数。由各业务模块注册（避免循环导入）。
Handler = Callable[[dict], Awaitable[dict | None]]
_HANDLERS: dict[str, Handler] = {}


def register_handler(kind: str, fn: Handler) -> None:
    _HANDLERS[kind] = fn
    logger.info("注册作业处理器: %s", kind)


def registered_kinds() -> list[str]:
    return sorted(_HANDLERS.keys())


async def run_job(job: dict) -> None:
    """执行一个已领取的作业，负责心跳、进度、成败落库。"""
    job_id, kind = job["id"], job["kind"]
    fn = _HANDLERS.get(kind)
    if fn is None:
        await finish(job_id, status="failed", error=f"没有 {kind} 的处理器")
        return

    stop = asyncio.Event()

    async def _beat() -> None:
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=HEARTBEAT_INTERVAL)
            except asyncio.TimeoutError:
                pass
            if stop.is_set():
                break
            ok = await heartbeat(job_id)
            if not ok:
                logger.warning("job #%s 租约丢失，停止执行", job_id)
                stop.set()
                return

    beat_task = asyncio.create_task(_beat())
    #: 把作业号放进 contextvar，让这条作业写过的一切历史快照都带上它。
    #: 写入口（snapshot_in / _save_episode_history）自动读取，33 个调用点不必改。
    #: worker 是 `await run_job(job)` 而非 create_task，所以同任务内可见。
    from ..job_context import JOB_ID, WRITING_MODEL
    ctx_token = JOB_ID.set(job_id)
    # 恢复入队时的写作模型（没有就是 None，等于不覆盖，行为与以前一致）
    wm_token = WRITING_MODEL.set(str((job.get("payload") or {}).get("writing_model") or "").strip() or None)
    try:
        result = await fn(job)
        # 🔴 2026-10-18: 用户取消后处理器若仍跑完(或协作式退出), 原先这里会无条件写 done,
        # 把 canceled 覆盖掉 —— 前端看到"已完成"而不是"已取消"。现在保留取消态。
        if await is_canceled(job_id):
            await finish(job_id, status="canceled", result=result or {})
        else:
            await finish(job_id, status="done", result=result or {})
    except asyncio.CancelledError:
        # worker 被要求停止：作业留在 running，等租约过期后被重新入队
        logger.info("job #%s 被取消，留在 running 等待重放", job_id)
        raise
    except Exception as e:  # noqa: BLE001
        logger.exception("job #%s 执行失败", job_id)
        if await is_canceled(job_id):
            # 已被用户取消: 不再放回队列重试(否则取消后还会被别的 worker 捡起来再跑)
            await finish(job_id, status="canceled", error=str(e)[:500])
            return
        # 未超过尝试次数就放回队列，让别的 worker 重试
        attempt = job.get("attempt") or 0
        max_attempts = job.get("max_attempts") or DEFAULT_MAX_ATTEMPTS
        if attempt < max_attempts:
            async with session_scope() as s:
                await s.execute(text("""
                    UPDATE agent_jobs SET status='queued', lease_owner=NULL,
                        lease_expires_at=NULL, error=:err, updated_at=now()
                    WHERE id=:id
                """), {"id": job_id, "err": str(e)[:500]})
            logger.info("job #%s 失败(第 %s 次)，放回队列重试", job_id, attempt)
        else:
            await finish(job_id, status="failed", error=str(e)[:500])
    finally:
        stop.set()
        # ⚠️ 必须在 finally 里重置：worker 是个长循环，一个进程里连跑成百上千个作业。
        # 漏掉它，下一个作业写历史时会读到上一个作业的 job_id —— 归因串号，
        # 而且症状是"看改动"显示成别人的集，比没有更糟。
        JOB_ID.reset(ctx_token)
        WRITING_MODEL.reset(wm_token)
        beat_task.cancel()
        try:
            await beat_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass


async def _reap_once() -> None:
    """一次过期回收（租约超时 + 僵尸精修）。串行与并发两种派发共用。"""
    await requeue_expired()
    # RewriteJob 没有租约，回收靠心跳 —— 见 chat_jobs.reap_stale_rewrite_jobs。
    # 放在这里（而不是 agent_jobs 的 requeue 里）是因为本地导入：jobs.py
    # 不能 import chat_jobs（chat_jobs 要 import 本模块注册处理器），
    # 会成环。所以由主循环显式调它。
    try:
        from .chat_jobs import reap_stale_rewrite_jobs
        n_reaped = await reap_stale_rewrite_jobs()
        if n_reaped:
            logger.info("回收 %d 个僵尸精修作业（心跳超时）", n_reaped)
    except Exception as ex:  # noqa: BLE001
        logger.warning("回收僵尸精修作业失败: %s", ex)


async def _concurrent_dispatch(poll_seconds: float, kinds: list[str] | None,
                               slots: int) -> None:
    """本进程同时跑 slots 个作业 —— **不同草稿之间并行**，同草稿仍互斥。

    ## 为什么要有它（2026-10-25 用户裁定）

    > "即使多个用户同时给多个草稿跑 agent 或任务，这些任务都应该并发跑，
    >   为什么排队？我们的 llm 渠道和服务器性能都支持并发。"

    在此之前 `worker_loop` 是**一个进程一次只跑一个作业**（`await run_job(...)`
    直接在循环里）。生产只有一台 worker，于是"整个平台同一时刻只有一个生成类
    作业在跑"—— 这与并发能力无关，纯粹是消费者只有一个。实测后果：生产队列里
    8 个来自 4 个不同用户的作业排成一条线，最长等 225 分钟，而其中每个都在
    等前一个写完 100 多集。

    同草稿互斥**不是**这里决定的，而是 `claim_one` 里的 NOT EXISTS：生成/精修
    都在覆写同一批集，并发会互相覆盖。那条约束与这里的并发正交。

    ## 三条必须遵守的顺序

    1. **先要槽位，再领作业**。反过来会让作业已经是 `running`、租约开始计时，
       却还没有执行者 —— 排队超过 `LEASE_SECONDS`(90s) 就被 `requeue_expired`
       当成死作业重排，来回打转。
    2. `run_job` 里的 `JOB_ID` / `WRITING_MODEL` 是 contextvar。`create_task`
       会复制一份 context，所以每个作业各自独立、互不串号；这不是偶然，是靠
       "一个作业一个 task"保证的 —— 不要改成在同一个 task 里轮流跑。
    3. 收到停止信号必须**取消并等待**所有在飞作业：它们在 finally 里 reset
       contextvar、关掉心跳任务；直接退出会留下心跳线程和脏 context。
    """
    sem = asyncio.Semaphore(slots)
    inflight: set[asyncio.Task] = set()
    last_gc = 0.0
    logger.info("并发派发启动：slots=%d kinds=%s", slots, kinds or "(全部)")

    async def _one(job: dict) -> None:
        try:
            await run_job(job)
        finally:
            sem.release()

    try:
        while True:
            loop_t = asyncio.get_event_loop().time()
            if loop_t - last_gc > 60:
                await _reap_once()
                last_gc = loop_t

            await sem.acquire()            # 见上面第 1 条
            job = await claim_one(kinds=kinds)
            if job is None:
                sem.release()
                await asyncio.sleep(poll_seconds)
                continue
            t = asyncio.create_task(_one(job))   # 见上面第 2 条
            inflight.add(t)
            t.add_done_callback(inflight.discard)
    except asyncio.CancelledError:
        for t in list(inflight):
            t.cancel()
        if inflight:
            await asyncio.gather(*inflight, return_exceptions=True)   # 见上面第 3 条
        logger.info("worker 收到停止信号，并发派发已收尾退出")
        raise
    except Exception as e:  # noqa: BLE001
        logger.exception("并发派发循环异常: %s", e)
        raise


async def worker_loop(poll_seconds: float = 2.0,
                      kinds: list[str] | None = None,
                      slots: int = 1) -> None:
    """worker 主循环：恢复过期作业 → 不断领取并执行。

    以 systemd 服务方式常驻（drama-dev-worker / drama-prod-worker）。

    slots: 本进程**同时执行**多少个作业。1 = 串行（2026-10-25 之前的行为）。
      由环境变量 `WORKER_SLOTS` 控制（见 app/worker.py）。
      ⚠️ 并发发生在**不同草稿**之间；同一草稿仍然互斥，理由见 `claim_one`。
    """
    slots = max(1, int(slots or 1))
    logger.info("worker %s 启动，可处理作业: %s（本进程并发 %d）",
                WORKER_ID, kinds or registered_kinds() or "(全部)", slots)
    n = await requeue_expired()
    if n:
        logger.info("启动时恢复 %d 个中断作业", n)

    if slots > 1:
        await _concurrent_dispatch(poll_seconds, kinds, slots)
        return

    last_gc = 0.0
    while True:
        try:
            loop_t = asyncio.get_event_loop().time()
            # 每 60s 做一次过期回收
            if loop_t - last_gc > 60:
                await _reap_once()
                last_gc = loop_t

            job = await claim_one(kinds=kinds)
            if job is None:
                await asyncio.sleep(poll_seconds)
                continue
            await run_job(job)
        except asyncio.CancelledError:
            logger.info("worker 收到停止信号，退出")
            raise
        except Exception as e:  # noqa: BLE001
            logger.exception("worker 循环异常: %s", e)
            await asyncio.sleep(poll_seconds * 2)


__all__ = [
    "enqueue", "claim_one", "heartbeat", "set_progress", "finish",
    "requeue_expired", "register_handler", "registered_kinds",
    "run_job", "worker_loop", "WORKER_ID", "LEASE_SECONDS",
]
