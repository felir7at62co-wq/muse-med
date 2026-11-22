"""作业「到底在哪个阶段」的唯一判据。

## 为什么需要它（2026-10-24 用户提问）

> "用户该如何判断工作流的状态？是正在运行，还是卡死了，还是成功了？
>   现在 agent 页有好几个状态汇报"

提问的起因是真实的：生产上用户提交了一个 131 集的剧本生成作业，之后
界面上**同时**有四个地方在说状态，而且说的话互不相同 ——

| 界面 | 读的是什么 | 会说"在跑"吗 |
|---|---|---|
| 草稿页顶栏（TaskStatusBar） | `/progress` + `/jobs` | 会 |
| Agent 对话台每一轮的页脚 | `agent_runs.status` | 会，**哪怕它只是在等队列** |
| 超级 Agent 页的批量浮窗 | `agent_batch_jobs` | 只覆盖批量运营 |
| 对话栏的作业气泡 | 自己记的 job_id | 会 |

四个都"会"，但没有一个能回答真正的问题：**这个作业是在跑，还是在排队，
还是已经死了？** 用户看到的"进行中"三种情况都会出现：

    queued   —— 排队等 worker。**一个字都没写**，也不会有任何进展。
    running  —— 真的在写。
    running 但心跳早没了 —— 死了，只是在等租约过期被重新入队。

`agent_jobs.status` 只有 `queued/running/done/failed/canceled` 五个值，
**`queued` 和"跑得很慢"在界面上长得一模一样** —— 这正是 2026-10-24 用户甲
那个用户反复问"是不是卡住了"、Agent 只能回"我继续等"的原因。

## 本模块的口径（全部可从库里现算，不新增心跳协议）

    queued      等 worker 领。带"前面还有几个"。
    running     已领到、心跳新鲜。带"第几集/共几集"与预计剩余。
    stalled     状态说 running，但心跳超过一个租约周期没更新 —— **死了**，
                只是在等 `requeue_expired` 回收。这个窗口最长 90 秒，
                但如果作业反复被重放，它会一次次回到 queued（见 retrying）。
    awaiting_approval  Agent 停在审批点，**什么都没在写**，等人。
    done / failed / canceled  终态。

⚠️ 判活阈值**必须**与 `jobs.LEASE_SECONDS` 一致：租约过期就是 worker 判死的
同一刻。另立一个阈值会让"界面说还在跑、队列已经准备重派"这种自相矛盾的
状态出现 —— 那比没有状态更坏。

⚠️ 本模块只**读**，不写库。谁要改状态，走 `jobs.finish` / `jobs.set_progress`。
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

#: 心跳超过这个秒数没更新 = worker 已经死了。与 `jobs.LEASE_SECONDS` 同值，
#: 理由见模块 docstring。**不要**在这里独立调参。
STALE_SECONDS = 90

PHASE_QUEUED = "queued"
PHASE_RUNNING = "running"
PHASE_STALLED = "stalled"
PHASE_APPROVAL = "awaiting_approval"
PHASE_DONE = "done"
PHASE_FAILED = "failed"
PHASE_CANCELED = "canceled"

#: 终态集合。模型/界面都靠它判断"还要不要等"。
TERMINAL = frozenset({PHASE_DONE, PHASE_FAILED, PHASE_CANCELED})

_ACTIVE = frozenset({PHASE_QUEUED, PHASE_RUNNING, PHASE_STALLED, PHASE_APPROVAL})

#: 从进度文案里抠「第 i/total 集」。两个生成处理器都写成
#: `正在写第{order}集剧本（第 {i}/{total} 集）`，这是它们唯一的稳定约定。
#: 抠不到就返回 None —— 界面上少一行"预计剩余"，不影响别的。
_EP_RE = re.compile(r"第\s*(\d+)\s*/\s*(\d+)\s*集")


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)   # 库里是 naive UTC


def _naive(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt.replace(tzinfo=None) if dt.tzinfo is not None else dt


def _secs(delta) -> int | None:
    if delta is None:
        return None
    return max(0, int(delta.total_seconds()))


def _episodes(note: str | None) -> tuple[int | None, int | None]:
    m = _EP_RE.search(note or "")
    if not m:
        return None, None
    return int(m.group(1)), int(m.group(2))


def describe(
    *,
    status: str | None,
    progress: int | None = None,
    progress_note: str | None = None,
    heartbeat_at: datetime | None = None,
    created_at: datetime | None = None,
    started_at: datetime | None = None,
    attempt: int | None = None,
    queue_position: int | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """把作业的原始字段翻译成「阶段 + 人话 + 还能不能等」。

    纯函数：不查库、不看时间之外的外部状态，方便单测与在多个接口里复用。

    返回::

        {
          "phase": "queued|running|stalled|awaiting_approval|done|failed|canceled",
          "label": "排队中（前面还有 3 个任务）",   # 直接显示给人看
          "active": True,                            # 还需要你等
          "terminal": False,
          "retrying": False,                         # 这次不是第一次跑了
          "queue_position": 3,                       # 仅 queued 有意义
          "queued_seconds": 900,
          "heartbeat_age_seconds": 12,               # 仅 running/stalled
          "episodes_done": 28, "episodes_total": 112,
          "elapsed_seconds": 3600, "eta_seconds": 5400,
          "why": "…",                                # 一句话解释，给模型也给人
        }

    `eta_seconds` 只在**已经跑起来且能推断出总量**时给，否则 None ——
    宁可不说，也不要给一个让用户按此安排工作的错误时间。
    """
    now = _now() if now is None else _naive(now)
    st = (status or "").strip()
    out: dict[str, Any] = {
        "phase": st or "unknown", "label": st or "未知", "active": False, "terminal": False,
        "retrying": bool(attempt and attempt > 1), "queue_position": queue_position,
        "queued_seconds": None, "heartbeat_age_seconds": None,
        "episodes_done": None, "episodes_total": None,
        "elapsed_seconds": None, "eta_seconds": None, "why": "",
    }
    done, total = _episodes(progress_note)
    out["episodes_done"], out["episodes_total"] = done, total

    if st == "queued":
        out["phase"] = PHASE_QUEUED
        out["active"] = True
        wait = _secs(now - _naive(created_at)) if created_at else None
        out["queued_seconds"] = wait
        pos = queue_position
        # ⚠️ pos == 0 与 pos is None 是两回事（2026-10-28 前共用一句"等一个空闲的执行位"）：
        #   0    = 前面没有任何任务，worker 每 2 秒取一次单，马上就会开始；
        #   None = 调用方没给位次（查不到作业行 / 不是队列作业），不能对用户说"前面还有几个"。
        # 合成一句话时，用户唯一的任务也显示"等执行位"，看起来像被别人挤住了。
        if pos:
            out["label"] = f"排队中（前面还有 {pos} 个任务）"
            out["why"] = ("已经提交，但还没有任何一个 worker 开始做 —— "
                          "**现在一个字都还没写，等多久取决于前面排了多少**。"
                          "这不是卡死，也不是慢，是没有轮到。")
        elif pos == 0:
            out["label"] = "即将开始"
            out["why"] = "前面没有其他任务，几秒内就会开始。"
        else:
            out["label"] = "排队中"
            out["why"] = "已经提交，等待开始执行。"
        if out["retrying"]:
            out["label"] += f" · 第 {attempt} 次"
            out["why"] = ("这个作业之前跑过一次没跑完，正在重新排。"
                          f"已经到第 {attempt} 次尝试，多次失败会直接判失败。")
        return out

    if st in ("running", "analyzing", "rewriting", "pending"):
        hb_age = _secs(now - _naive(heartbeat_at)) if heartbeat_at else None
        out["heartbeat_age_seconds"] = hb_age
        if hb_age is not None and hb_age > STALE_SECONDS:
            out["phase"] = PHASE_STALLED
            out["active"] = True
            out["label"] = f"疑似卡住（{hb_age // 60} 分钟没有心跳）"
            out["why"] = ("执行它的进程已经不再报心跳了，多半是被重启或异常退出。"
                          "队列会在租约到期后自动重新派发，已完成的集不会丢。"
                          "如果它反复这样，请把作业号告知管理员。")
            return out
        out["phase"] = PHASE_RUNNING
        out["active"] = True
        if done and total:
            out["label"] = f"进行中 · 第 {done}/{total} 集"
        else:
            pct = f" {progress}%" if isinstance(progress, int) and progress not in (0, 100) else ""
            out["label"] = f"进行中{pct}"
        el = _secs(now - _naive(started_at)) if started_at else None
        out["elapsed_seconds"] = el
        # 预计剩余：只按**本集速率**外推，且要求至少做完 1 集、已跑 ≥2 分钟。
        # 样本太小的时候外推出来的数字会差一个数量级，宁可返回 None。
        if done and total and total > done and el and el >= 120 and started_at:
            per_ep = el / done
            out["eta_seconds"] = int(per_ep * (total - done))
        out["why"] = "正在写，心跳正常。" + (
            f"按目前的节奏还要约 {_human(out['eta_seconds'])}。" if out.get("eta_seconds") else "")
        return out

    if st == "awaiting_approval":
        out["phase"] = PHASE_APPROVAL
        out["active"] = True
        out["label"] = "等你确认（还没开始执行）"
        out["why"] = ("Agent 停下来问你同不同意这一步操作。**它什么都没在做**，"
                      "也不会自己恢复 —— 必须有人去那一轮对话里点确认或拒绝。")
        return out

    if st == "done":
        out["phase"] = PHASE_DONE
        out["terminal"] = True
        out["label"] = "已完成"
        if done and total:
            out["label"] += f"（{done}/{total} 集）"
        out["why"] = "跑完了。"
        return out

    if st == "canceled":
        out["phase"] = PHASE_CANCELED
        out["terminal"] = True
        out["label"] = "已取消"
        out["why"] = "被用户停止。已完成的部分保留。"
        return out

    if st in ("failed", "error"):
        out["phase"] = PHASE_FAILED
        out["terminal"] = True
        out["label"] = "失败"
        out["why"] = "没有成功结束，具体原因见 error 字段。"
        return out

    out["active"] = st in _ACTIVE
    return out


def _human(seconds: int | None) -> str:
    if not seconds:
        return ""
    if seconds < 90:
        return f"{seconds} 秒"
    if seconds < 5400:
        return f"{round(seconds / 60)} 分钟"
    return f"{seconds / 3600:.1f} 小时"


def label_for(phase: str) -> str:
    """阶段 → 短词。四个界面的徽标都用它，别各写一份。"""
    return {
        PHASE_QUEUED: "排队中",
        PHASE_RUNNING: "进行中",
        PHASE_STALLED: "疑似卡住",
        PHASE_APPROVAL: "等你确认",
        PHASE_DONE: "已完成",
        PHASE_FAILED: "失败",
        PHASE_CANCELED: "已取消",
    }.get(phase, phase)


__all__ = [
    "STALE_SECONDS", "PHASE_QUEUED", "PHASE_RUNNING", "PHASE_STALLED", "PHASE_APPROVAL",
    "PHASE_DONE", "PHASE_FAILED", "PHASE_CANCELED", "TERMINAL",
    "describe", "label_for", "_episodes",
]
