"""上游用量采集（P0 计价基建，2026-10-13）。

## 职责
每次**真实的上游调用**结束后记一行 `usage_events`：花在哪个模型/渠道、
多少 token、多少生成耗时、按现价估算多少钱（分）。只记录，**不拦截任何请求**。

## 归属（谁花的）怎么传到 provider 层
provider 不知道自己在为哪个 job / 项目 / 用户干活。这里用一个 ContextVar
`_CTX` 自上而下传：

  · 后台任务：`job_submit._run_job_guarded` 在跑 runner 前按 Job 行设好；
  · 同步接口：`main.session_guard` 已把登录者放进 `access._CURRENT`，
    这里读不到 job 时退回读它（至少知道是谁、哪个项目）。

asyncio 的 Task 会复制 ContextVar 快照，`gather` 派出去的每个镜头协程都继承
同一份归属——不需要层层传参。

## 硬约束：记账失败绝不影响生成
`record()` 内部吞掉一切异常只打日志。花了钱的生成因为记一行统计失败而报错，
等于把一次成功出片变成"失败"，用户会重试——再花一次钱。
"""
from __future__ import annotations

import json
import logging
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone

from . import pricing

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class UsageCtx:
    job_id: str | None = None
    job_kind: str | None = None
    project_id: str | None = None
    user_id: int | None = None


_CTX: ContextVar[UsageCtx | None] = ContextVar("fw_usage_ctx", default=None)


def set_ctx(ctx: UsageCtx):
    """设置当前协程的用量归属，返回 token（可交给 reset_ctx 复原）。"""
    return _CTX.set(ctx)


def reset_ctx(token) -> None:
    try:
        _CTX.reset(token)
    except (ValueError, LookupError):   # 跨上下文复原：忽略即可
        pass


def ctx_for_job(job_id: str) -> UsageCtx:
    """按 Job 行构造归属。读库失败返回仅含 job_id 的归属（不抛）。"""
    try:
        from .db import Job, get_session
        with get_session() as s:
            j = s.get(Job, job_id)
            if j:
                pid = j.project_id
                if not pid:
                    try:
                        pid = (json.loads(j.payload or "{}") or {}).get("project_id")
                    except (ValueError, TypeError):
                        pid = None
                return UsageCtx(job_id=j.id, job_kind=j.kind, project_id=pid,
                                user_id=j.user_id)
    except Exception:  # noqa: BLE001
        log.exception("[usage] 读 job %s 失败", job_id)
    return UsageCtx(job_id=job_id)


def current() -> UsageCtx:
    """当前归属：有 job 上下文用它；否则退回登录者（同步接口）。"""
    c = _CTX.get()
    if c is not None:
        return c
    try:
        from . import access
        p = access.current_principal()
        return UsageCtx(user_id=p.user_id if p else None)
    except Exception:  # noqa: BLE001
        return UsageCtx()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _loads(raw: str | None) -> dict:
    try:
        v = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return v if isinstance(v, dict) else {}


def record(category: str, *, model_id: str | None = None, channel: str | None = None,
           ok: bool = True, prompt_tokens: int | None = None,
           completion_tokens: int | None = None, total_tokens: int | None = None,
           gen_seconds: float | None = None, media_seconds: float | None = None,
           units: int | None = None, resolution: str | None = None,
           vendor_money: object = None, cost_fen: int | None = None,
           project_id: str | None = None, meta: dict | None = None,
           task_id: str | None = None) -> None:
    """记一行用量。**永不抛异常。**

    `cost_fen` 不传时按 category 用 pricing 自动估算；文本恒为 0（见 pricing 模块文档）。
    `project_id` 显式传入时覆盖上下文里的（同步接口常常只有路由参数里才有项目）。

    ## `task_id`：把「已派发」那行**就地结算**掉，不追加第二行

    异步上游（RunningHub / 方舟）的任务在 `record_dispatch()` 那一刻就已经记了
    一行。任务出结论时把 `task_id` 传进来，这行会被就地填上金额与耗时，而不是
    再插一行 —— 一次上游任务一行。

    这不只是洁癖：**那行的 `ts` 是派发时刻**，取消结算要用它算等待时长
    （RunningHub 按机时计费）。若在这里另插一行，派发时刻就被埋在一条
    `cost_fen=0` 的孤儿行里，取消时算不出"等了多久"（2026-10-16）。
    """
    try:
        c = current()
        if cost_fen is None:
            cost_fen = estimate_cost(category, model_id=model_id,
                                     total_tokens=total_tokens, gen_seconds=gen_seconds,
                                     units=units, resolution=resolution,
                                     media_seconds=media_seconds, channel=channel)
        if total_tokens is None and (prompt_tokens or completion_tokens):
            total_tokens = (prompt_tokens or 0) + (completion_tokens or 0)
        from .db import UsageEvent, get_session
        with get_session() as s:
            row = _dispatch_row(s, c.job_id, task_id) if task_id else None
            if row is None:
                row = UsageEvent(ts=_now(), category=category)
                s.add(row)
            row.category = category
            row.model_id = model_id
            row.channel = channel
            row.job_id = c.job_id
            row.job_kind = c.job_kind
            row.project_id = project_id or c.project_id
            row.user_id = c.user_id
            row.ok = 1 if ok else 0
            row.prompt_tokens = prompt_tokens
            row.completion_tokens = completion_tokens
            row.total_tokens = total_tokens
            row.gen_seconds = gen_seconds
            row.media_seconds = media_seconds
            row.units = units
            row.resolution = resolution
            row.vendor_money = (None if vendor_money is None
                                else str(vendor_money)[:32])
            row.cost_fen = int(cost_fen or 0)
            # 结算完就不再是「未结算」：摘掉 phase 标记（ts/category 原样保留）
            m = _loads(row.meta) if row.meta else {}
            m.pop("phase", None)
            if meta:
                m.update(meta)
            if task_id:
                m["task_id"] = str(task_id)
            row.meta = json.dumps(m, ensure_ascii=False) if m else None
            s.commit()
    except Exception:  # noqa: BLE001
        log.exception("[usage] 记账失败（不影响生成） category=%s model=%s",
                      category, model_id)


def record_dispatch(category: str, *, task_id: str, model_id: str | None = None,
                    channel: str | None = None, resolution: str | None = None,
                    media_seconds: float | None = None, meta: dict | None = None,
                    project_id: str | None = None) -> None:
    """记一行「**已派发、尚未结算**」的上游异步任务。**永不抛异常。**

    `cost_fen` 恒为 0 —— 此刻确实还不知道要花多少（RunningHub 看机时、
    方舟看 token）。它的价值不在金额，而在**证明这个 task 真的发出去了**：

      · **取消结算**据此收「已消耗的那部分」。没有这一行，取消路径只能看到
        `SUM(cost_fen) = 0`（要么还没出结论、要么这一类的单价本就不落在单次
        调用上），于是把预扣全额退回去 —— 而渠道那边早就按机时/token 扣过我们了。
      · `ts` 就是**派发时刻**，取消时用 `now - ts` 算等待时长。
      · 方舟那条通道**没有取消接口**，任务在用户取消之后仍会跑到出片并计费；
        有这一行才有可能把那份钱算到用户头上。

    任务出结论时，用 `record(..., task_id=...)` 就地结算这一行（见上）。
    """
    m = dict(meta or {})
    m["task_id"] = str(task_id)
    m["phase"] = "dispatched"          # 「未结算」的唯一标记
    record(category, model_id=model_id, channel=channel, ok=False, cost_fen=0,
           resolution=resolution, media_seconds=media_seconds, meta=m,
           project_id=project_id)


def cancel_requested() -> bool:
    """当前上下文所属的 job 是否已被用户取消。**永不抛异常**（读不到按未取消）。

    给异步上游通道在**轮询循环里**用：runner 的检查点只能拦住"下一个"请求，
    已经派发、正在轮询的那一个会一直等到出片——用户取消之后机时照烧到底。

    为什么查 `current().job_id` 就够、不必再传 parent：一键成片的子 runner 是
    父 runner **直接 await** 的，`_run_job_guarded` 设的上下文没被替换，
    这里拿到的正是用户在界面上点取消的那个父 job。
    """
    jid = current().job_id
    if not jid:
        return False
    try:
        from .db import Job, get_session
        with get_session() as s:
            j = s.get(Job, jid)
            return bool(j and j.status == "cancelled")
    except Exception:  # noqa: BLE001
        return False


def settle_dispatch_by_wait(category: str, *, task_id: str,
                            model_id: str | None = None,
                            channel: str | None = None) -> int:
    """用户取消了一个 RunningHub 任务：按**派发至今的等待时长**收（用户裁定 2026-10-16）。

    返回收了多少分。等待时长 = now − 派发行的 ts（含排队时间——平台不给
    取消瞬间的已耗机时，用户裁定按等待时长算）。找不到派发行按 0。
    """
    waited = 0.0
    try:
        from .db import get_session
        with get_session() as s:
            row = _dispatch_row(s, current().job_id, task_id)
            if row is not None and row.ts:
                t0 = datetime.fromisoformat(row.ts)
                waited = max(0.0, (datetime.now(timezone.utc) - t0).total_seconds())
    except Exception:  # noqa: BLE001
        log.exception("[usage] 算等待时长失败 task=%s", task_id)
    fen = pricing.runninghub_cost(waited)
    record(category, model_id=model_id, channel=channel, ok=False,
           gen_seconds=round(waited, 1), cost_fen=fen, task_id=task_id,
           meta={"billed_by": "wait", "cancelled_by_user": True})
    return fen


def settle_dispatch_free(category: str, *, task_id: str, model_id: str | None = None,
                         channel: str | None = None, reason: str = "") -> None:
    """把派发行结算成 0 分（RunningHub 失败不收 / 方舟排队中被真取消掉）。

    必须**显式**结算而不是放着不管：放着的行会被取消结算当成"在途"按等待时长收。
    """
    record(category, model_id=model_id, channel=channel, ok=False, cost_fen=0,
           task_id=task_id, meta={"free_reason": reason} if reason else None)


def _dispatch_row(s, job_id: str | None, task_id: str | None):
    """找同一 job 下、同一个 task **尚未结算**的那一行（没有返回 None）。"""
    if not job_id or not task_id:
        return None
    from .db import UsageEvent
    rows = (s.query(UsageEvent)
            .filter(UsageEvent.job_id == job_id, UsageEvent.meta.isnot(None))
            .order_by(UsageEvent.id.desc()).all())
    for r in rows:
        m = _loads(r.meta)
        if m.get("phase") == "dispatched" and m.get("task_id") == str(task_id):
            return r
    return None


def unsettled_dispatches(session, job_id: str) -> list[dict]:
    """这个 job 里**已派发、还没等到结论**的上游任务。取消结算用它算钱。

    只扫这一个 job 的行（几十条），meta 在 Python 里解 —— 不为它加一列：
    `asset_image_versions` 那次的教训是"建表在 _TABLES 里、加列忘了写 _COLUMNS，
    老库永远拿不到新列"（见 memory），能不加列就不加。

    返回 [{category, channel, model_id, task_id, ts, resolution, media_seconds}]。
    """
    from .db import UsageEvent
    out: list[dict] = []
    try:
        rows = (session.query(UsageEvent)
                .filter(UsageEvent.job_id == job_id, UsageEvent.meta.isnot(None))
                .order_by(UsageEvent.id).all())
        for r in rows:
            m = _loads(r.meta)
            if m.get("phase") != "dispatched":
                continue
            out.append({"category": r.category, "channel": r.channel,
                        "model_id": r.model_id, "task_id": m.get("task_id"),
                        "ts": r.ts, "resolution": r.resolution,
                        "media_seconds": r.media_seconds})
    except Exception:  # noqa: BLE001
        log.exception("[usage] 读未结算派发行失败 job=%s", job_id)
    return out


def estimate_cost(category: str, *, model_id: str | None = None,
                  total_tokens: int | None = None, gen_seconds: float | None = None,
                  units: int | None = None, resolution: str | None = None,
                  media_seconds: float | None = None,
                  channel: str | None = None) -> int:
    """按现价估算单次调用的成本（分）。未知类别返回 0。"""
    if category == "image":
        return pricing.image_cost(units or 1)
    if category == "tts":
        return pricing.tts_cost(units or 1)
    if category in ("upscale",):
        # ⚠️ 按**渠道**分流（2026-11-09 接入火山后）：RunningHub 按机时、
        #    MediaKit 按被处理素材时长。写死成本一条会让两条通道互相估错价。
        #    通道侧通常显式传 `cost_fen`（见 upscale_mediakit._record），
        #    这里只是兜底：漏传时也不至于按另一条通道的单价入账。
        if (model_id or "").startswith("mediakit") or channel == "mediakit":
            return pricing.mediakit_upscale_cost(media_seconds or 0)
        return pricing.runninghub_cost(gen_seconds or 0)
    if category == "video":
        if pricing.seedance_family(model_id or ""):
            return pricing.seedance_cost(model_id or "", resolution, total_tokens or 0)
        if pricing.is_wan(model_id or ""):     # 万相：按输出秒数
            return pricing.wan_cost(resolution, media_seconds or 0)
        if gen_seconds is not None:            # RunningHub（海螺 H3）
            return pricing.runninghub_cost(gen_seconds)
        return 0
    return 0                                   # llm / desub（单价未定）等
