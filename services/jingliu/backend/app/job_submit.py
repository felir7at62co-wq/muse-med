"""任务提交的**原子性与终态保证**：`_SUBMIT_LOCK` 与 `_run_job_guarded`。

## 为什么单独成模块（而不是留在 routes_v2.py）

它们**不是某一域的东西**：去字幕（`routers/desub.py`）、高清放大
（`routers/upscale.py`）、场景多视角（`routers/look.py`）都要用，
而各自原先靠 `from ..routes_v2 import _run_job_guarded, _SUBMIT_LOCK`
反过来 import 路由模块。子模块之间互相 import 路由文件会让依赖图成环，
所以按 _PLAN-路由按域拆分.md 第 7 条的计划，先把这对下沉到这里。

## 两者都**不是可选的**（原文照录，别删）

- **少了锁**，双击提交就是两批任务同时擦同一批镜头（去字幕按时长计费，直接翻倍）。
- **少了 guard**，runner 里 `asyncio.gather(...)` 抛异常会让 Job 永远停在
  running，而 `find_active_job` 把 running 当"正在跑" ——
  该项目之后**再也提交不了**同组任务。

通用 `POST /v2/jobs` 已经把这两件事做对了；这里只负责让别的域也能复用，
而不是各自再写一份看起来更简单的提交逻辑。
"""
from __future__ import annotations

import asyncio
import logging

from .db import Job, get_session

logger = logging.getLogger(__name__)


_SUBMIT_LOCK = asyncio.Lock()

#: 后台协程的强引用表。
#:
#: asyncio 只持**弱引用**：任务对象没有别的引用的那一刻就可能被 GC 掉，
#: 而那时它**还没跑完** —— 表现是任务凭空消失、job 永远停在 pending。
#: 这是 asyncio 文档里明写的坑（"Save a reference to the result of this
#: function, to avoid a task disappearing mid-execution"）。
_TASKS: set[asyncio.Task] = set()

#: 已经在跑的 job id。防止同一个 job 被派发两次。
#:
#: 两个来源会撞：① 进程被杀后 LangGraph 重放同一节点（`submit_idempotent`
#: 的"接管已有 pending"分支也会再派一次）；② 用户手点的路由与 agent 走的是
#: 同一个 `_run_job_guarded`。同一个 job 跑两遍对出片 = 同一批镜头生成两遍，
#: 直接翻倍烧钱，而且两个 job 都会显示成功、用户看不出来。
_RUNNING: set[str] = set()


def spawn_job(runner, jid: str, kind: str) -> None:
    """把 runner 派发到后台跑（不依赖 HTTP 的 `BackgroundTasks`）。

    ## 为什么需要它（2026-10-23 修）

    `POST /v2/jobs` 那条路用的是 FastAPI 的 `background.add_task(...)`，
    它在**请求结束之后**由框架跑。但「镜流超级 Agent」在后台协程里运行，
    没有 request、也没有 `BackgroundTasks` —— 它调用的
    `submit_idempotent()` 只 `create_job()` 写库就返回了，**没有任何东西去启动
    这个任务**。

    后果（生产实测 2026-10-23，项目 2034）：agent 提交的 `asset_fill` 从
    建库那一刻起 `status=pending / progress=0`，`created_at == updated_at`，
    一次都没被碰过。agent 随后三次 `wait_for_job(timeout=300)` 共等满 15 分钟，
    最后只能如实汇报"还在排队"。更糟的是 `asset_fill` 在 `assets` 互斥组里，
    这条永不推进的 pending 会一直把用户手点的补图挡成 `deduped`，
    直到下次重启 `recover_zombie_tasks` 把它标成 failed。

    受影响的不是个别工具：`submit_idempotent` 覆盖 17 个工具，
    出片 / 首帧 / 拆解 / 配音 / 字幕 / 放大 / 去字幕 / 补图全线。

    ## 为什么不是 `background.add_task`

    这里没有 `BackgroundTasks` 可用，也不需要"等响应返回后再跑"的语义 ——
    agent 提交完就该让它在后台跑起来。`asyncio.create_task` 是同一件事在
    纯协程上下文里的做法。
    """
    from .jobs import RUNNERS

    runner = runner or RUNNERS.get(kind)
    if runner is None:
        logger.error("[job %s] kind=%s 没有注册 runner，无法派发", jid, kind)
        return
    # 同一个 job 只许有一个执行体（见 `_RUNNING`）。这是**幂等派发**，
    # 不是"跳过已完成的"：完成的不在集合里，重放时仍会按库里的终态直接返回。
    if jid in _RUNNING:
        logger.info("[job %s] 已有执行体在跑，跳过重复派发", jid)
        return
    _RUNNING.add(jid)

    async def _wrapped() -> None:
        try:
            await _run_job_guarded(runner, jid, kind)
        finally:
            _RUNNING.discard(jid)

    task = asyncio.create_task(_wrapped())
    _TASKS.add(task)
    # 任务结束就摘掉引用（on_done 一定在 task 完成时回调一次）
    task.add_done_callback(_TASKS.discard)


async def _run_job_guarded(runner, jid: str, kind: str) -> None:
    """跑 runner，并**保证**任务最终落到终态。

    为什么必须有这层：runner 里的 `asyncio.gather(...)` 没有 try/except
    （jobs.py:1094），任一镜头抛异常就会跳过后面的 `_update(status=...)`，
    Job 行永远停在 running。后果不只是进度条空转 ——
    `find_active_job` 会把它当成"正在跑的批量任务"，之后该项目**再也提交不了**
    同类任务，只能重启后端（recover_zombie_tasks 仅在 lifespan 启动时跑一次）。

    放在派发层而不是逐个 runner 里加：一处修复覆盖全部 RUNNERS，
    也不会漏掉将来新增的 runner。
    """
    from .jobs import _update  # 局部导入避免循环依赖
    from . import usage
    # 用量归属：本任务里所有上游调用都记到这个 job / 项目 / 提交者名下。
    # gather 派出的子协程会复制这份 ContextVar，不需要层层传参。
    _utok = usage.set_ctx(usage.ctx_for_job(jid))
    try:
        await runner(jid)
    except asyncio.CancelledError:
        # 进程关闭等正常取消：标记出来，不要留个假的 running
        try:
            _update(jid, status="failed", error="任务被中断（服务重启或取消）")
        except Exception:  # noqa: BLE001
            pass
        raise
    except Exception as e:  # noqa: BLE001
        logger.exception("[job %s] kind=%s 未捕获异常，置为 failed", jid, kind)
        try:
            _update(jid, status="failed",
                    error=f"任务异常终止: {type(e).__name__}: {e}"[:2000])
        except Exception:  # noqa: BLE001
            logger.exception("[job %s] 连 failed 都没写进去", jid)
    finally:
        usage.reset_ctx(_utok)
        # 结算积分（P1）：预扣是按上界估的，这里按**实测**多退少补。
        # 放在 finally 且**读 job 的终态**而不是猜：上面三条出口
        # （正常 / 取消 / 异常）都会把状态写进 Job 行，以它为准。
        # ⚠️ settle 自己幂等（查过 refund 流水就不再动），所以这里多调一次无害，
        #    而终态的三处绕行（取消 / 重启清理 / 孤儿巡检）各自也会调。
        try:
            from .charge import settle
            from .db import Job, get_session
            with get_session() as _s:
                _j = _s.get(Job, jid)
                _st = (_j.status if _j else "") or ""
            if _st in ("done", "success"):
                settle(jid, ok=True)
            elif _st in ("failed", "error"):
                settle(jid, ok=False, reason="任务失败")
            elif _st == "cancelled":
                # 取消**要结算**（2026-10-15 改）：按实测收，已派发的照收、
                # 没跑的不收。此前这里空着，预扣的上界被一分不退地收下——
                # 取消得越早、多收得越多。见 charge.settle 的说明。
                # ⚠️ 结算必须在**任务真的结束之后**：这里就是那个位置。
                settle(jid, cancelled=True, reason="用户取消")
        except Exception:  # noqa: BLE001
            logger.exception("[job %s] 积分结算失败（不影响任务结果）", jid)
