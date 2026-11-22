"""作业 worker 入口 —— 独立进程，常驻执行长任务。

与 orchestrator 的关系：
  · **共用同一份代码与镜像**，只是启动入口不同
  · orchestrator 只负责入队（写一行 status='queued'），不执行
  · worker 负责领取与执行，可多进程/多机横向扩展

启动方式（systemd: drama-dev-worker / drama-prod-worker）：
    python -m app.worker

为什么独立进程（而不是容器内守护协程）：
  守护协程仍与 orchestrator 同生共死 —— 部署、OOM、异常退出都会带走任务。
  独立进程 + 租约心跳 + 幂等重放，才能做到"重启不丢任务"。
"""
from __future__ import annotations

import asyncio
import os
import logging
import signal
import sys

from .db import init_db
from .agent import chat_jobs, jobs

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("worker")

#: 平台默认模型的重载间隔(秒)。
#:
#: worker 是**独立进程**, 拿不到 orchestrator 里那次 set_default_model_override 的
#: 就地刷新 —— 管理员在后台改了默认模型, worker 进程内还是旧值, 于是"页面显示新模型、
#: 长任务实跑旧模型", 且用量日志记的也是旧的, 从任何一端都看不出来。
#:
#: orchestrator 那边靠"写入端失效"做到确定性即时生效; worker 没有写入端可挂,
#: 只能轮询。60 秒是个折中: 管理员改完最多一分钟内全量生效, 而每分钟一次
#: 单行 SELECT 的开销可以忽略。
_DEFAULT_MODEL_RELOAD_SEC = 60


async def _sync_default_models(stop: asyncio.Event) -> None:
    """周期性把 system_settings 里的平台默认模型同步进本进程。

    ⚠ 首次同步由 _main 在**启动 worker_loop 之前**显式 await, 不在这里做 ——
    放这里的话它与 worker_loop 并发起跑, 领到的头几个任务可能赶在同步完成前
    就用 env 的老型号跑掉了。这里只负责之后的周期刷新。

    任何一次失败都只 warn 并继续 —— 同步不上最多是沿用上一次的值, 不该让 worker 退出。
    """
    from .models.catalog import load_default_models_from_db

    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=_DEFAULT_MODEL_RELOAD_SEC)
            return  # stop 被置位 = 正在退出
        except asyncio.TimeoutError:
            pass
        try:
            await load_default_models_from_db()
        except Exception as e:  # noqa: BLE001
            logger.warning("同步平台默认模型失败(沿用当前值): %s", e)


async def _main() -> None:
    # 确保表存在（与 orchestrator 共用同一套模型定义）
    try:
        await init_db()
    except Exception as e:  # noqa: BLE001
        logger.warning("init_db 失败（可能已由 orchestrator 建表）: %s", e)

    chat_jobs.register_all()
    # Agent 引擎：注册处理器 → 自检（不通过拒绝启动）→ 建检查点表
    from .agent_engine import runner as _agent_runner
    from .agent_engine.graph import setup_checkpointer
    from .agent_engine.selfcheck import assert_ok as _agent_selfcheck
    _agent_runner.register()
    from .agent_engine import desktop as _desktop
    _desktop.register()   # 桌面端的慢工具调用（重写某集等）经队列执行
    _agent_selfcheck()
    await setup_checkpointer()
    logger.info("worker 就绪，已注册作业类型: %s", jobs.registered_kinds())

    # 平台默认模型: 必须在开始领任务**之前**同步好, 否则头几个任务会用 env 的老型号
    try:
        from .models.catalog import load_default_models_from_db
        await load_default_models_from_db()
    except Exception as e:  # noqa: BLE001
        logger.warning("首次同步平台默认模型失败(沿用 env): %s", e)

    stop = asyncio.Event()

    def _shutdown(*_a):  # noqa: ANN002
        logger.info("收到停止信号，准备退出…")
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _shutdown)
        except NotImplementedError:  # pragma: no cover
            pass

    # 主循环：处理除 agent_run 以外的全部作业。
    #
    # ⚠️ 2026-10-25 用户裁定：不同草稿上的任务应当**真的并发跑**。
    #   "即使多个用户同时给多个草稿跑 agent 或任务，这些任务都应该并发跑，
    #    为什么排队？我们的 llm 渠道和服务器性能都支持并发。"
    #
    # 在此之前这里是 `worker_loop(kinds=main_kinds)` —— **一个进程一次只跑一个作业**，
    # 而生产只有一台 worker，于是整平台同一时刻只有一个生成类作业在动。
    # 那不是并发能力的问题，是消费者只有一个。实测：8 个来自 4 个用户的作业
    # 排成一条线，最长等 225 分钟。
    #
    # WORKER_SLOTS = 本进程同时执行的**非 Agent** 作业数。默认 8：够覆盖日常并发，
    # 又不会把上游渠道和数据库连接打满（连接池见 db/session.py，ROLE=worker 时 3+8）。
    # ⚠️ 同草稿仍然互斥，由 claim_one 的 NOT EXISTS 保证 —— 生成/精修都在覆写
    #    同一批集，并发会互相覆盖。这是语义要求，不是排队副作用。
    #
    # Agent 运行仍走自己的通道：它会提交生成/精修等子作业并等待其完成，若与子作业
    # 共用通道，几个 Agent 运行就能占满槽位、各自等一个永远没人执行的子作业（死锁）。
    main_kinds = [k for k in jobs.registered_kinds() if k != "agent_run"]
    agent_slots = max(1, int(os.environ.get("AGENT_RUN_SLOTS", "4")))
    job_slots = max(1, int(os.environ.get("WORKER_SLOTS", "8")))
    main_task = asyncio.create_task(jobs.worker_loop(kinds=main_kinds, slots=job_slots))
    agent_tasks = [asyncio.create_task(jobs.worker_loop(kinds=["agent_run"])) for _ in range(agent_slots)]
    default_model_task = asyncio.create_task(_sync_default_models(stop))
    logger.info("worker 并发：作业 %d 路 + Agent %d 路", job_slots, agent_slots)
    await stop.wait()
    main_task.cancel()
    default_model_task.cancel()
    for t in agent_tasks:
        t.cancel()
    for t in (main_task, default_model_task, *agent_tasks):
        try:
            await t
        except asyncio.CancelledError:
            pass
    logger.info("worker 已退出")


def main() -> None:
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:  # pragma: no cover
        sys.exit(0)


if __name__ == "__main__":
    main()
