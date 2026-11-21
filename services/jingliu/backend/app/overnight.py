"""客户端通宵模式（2026-11-02 用户裁定）：Agent 在用户电脑上整夜跑，这里只负责「电脑断了要告诉他」。

为什么在后端：客户端睡眠、合盖、断网、重启时，它自己什么也发不出来。只有一直在线的后端能在
「心跳停了」这件事上作出反应。

流程：
- 客户端开启通宵模式后每分钟 `POST /v2/desktop-agent/overnight/beat`，带上进度与正在做什么；
- 正常退出或系统关机时 `.../overnight/offline`，后端立刻发飞书，不等超时；
- `sweep()` 每 20 秒跑一次：心跳超过 `OFFLINE_AFTER_SEC` 的 running 行标 offline 并发飞书；
- 心跳恢复：offline → running，再发一条「已恢复」；
- 结束：`.../overnight/finish` 带上早上的报告，后端飞书发给用户本人。

每条飞书只发给这一行的 `user_id` 本人。发不出去（没绑飞书、接口失败）只记日志，不影响心跳。
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from .auth import KnownUser
from .db import OvernightRun, Project, get_session

log = logging.getLogger("fw.overnight")

#: 心跳超过这么久没来就算电脑离线。客户端每 60 秒报一次，留出两次丢包 + 网络抖动的余量。
OFFLINE_AFTER_SEC = 300
#: 文本字段的上限：通知与报告都是给人看的一段话，不该无限长。
_TEXT_CAP = {"title": 120, "progress": 120, "doing": 300, "report": 3000}


def _now(now: datetime | None = None) -> datetime:
    return now or datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def _clip(field: str, value: object) -> str:
    return str(value or "").strip()[: _TEXT_CAP[field]]


def _send(user_id: int, text: str) -> bool:
    """飞书私信用户本人。返回是否发出。"""
    from . import feishu_open
    from .reminders import _send as send_text
    if not feishu_open.configured():
        return False
    with get_session() as s:
        u = s.get(KnownUser, user_id)
        union_id = u.feishu_union_id if u else None
    if not union_id:
        log.info("[overnight] user=%s 没有飞书身份，通知未发：%s", user_id, text[:60])
        return False
    try:
        send_text(union_id, text)
        return True
    except Exception as e:  # noqa: BLE001  通知失败不能让心跳失败
        log.warning("[overnight] 飞书发送失败 user=%s: %r", user_id, e)
        return False


def _name(r: OvernightRun) -> str:
    if r.title:
        return r.title
    if r.project_id:
        with get_session() as s:
            p = s.get(Project, r.project_id)
            if p:
                return f"《{p.title}》"
    return "通宵任务"


def _offline_text(r: OvernightRun, *, reason: str) -> str:
    progress = f"已完成 {r.progress}。" if r.progress else ""
    doing = f"停下时在做：{r.doing}。" if r.doing else ""
    return (f"你的电脑{reason}，{_name(r)} 已停止。{progress}{doing}"
            "已经提交给服务器的镜头会继续生成完；没提交的不会再提交。打开电脑和镜流客户端后会接着做。")


def beat(user_id: int, session_id: str, body: dict, now: datetime | None = None) -> dict:
    """记一次心跳；断过线的恢复为 running 并通知一次。"""
    sid = str(session_id or "").strip()[:64]
    if not sid:
        raise ValueError("缺少 session_id")
    stamp = _iso(_now(now))
    resumed = False
    with get_session() as s:
        r = s.get(OvernightRun, sid)
        if r is not None and r.user_id != user_id:
            raise PermissionError("这个会话不属于你")
        if r is None or r.status in ("done", "stopped"):
            if r is None:
                r = OvernightRun(session_id=sid, user_id=user_id)
                s.add(r)
            r.started_at, r.offline_at, r.report = stamp, None, None
            r.status = "running"
        elif r.status == "offline":
            r.status, r.offline_at = "running", None
            resumed = True
        # 只用带来的非空值覆盖：HTTP 层把没传的字段补成空串，按「有这个键」判断会把标题和进度清空。
        for field in ("title", "progress", "doing"):
            value = _clip(field, body.get(field))
            if value:
                setattr(r, field, value)
        if body.get("project_id"):
            r.project_id = str(body["project_id"])[:16]
        r.last_beat_at = stamp
        s.commit()
        name = _name(r)
    if resumed:
        _send(user_id, f"电脑已恢复连接，{name} 接着做。")
    return {"ok": True, "status": "running", "resumed": resumed}


def offline(user_id: int, session_id: str, reason: str = "", now: datetime | None = None) -> dict:
    """客户端主动报「要下线了」（退出、关机）：立刻标 offline 并通知。"""
    with get_session() as s:
        r = s.get(OvernightRun, str(session_id or "")[:64])
        if r is None or r.user_id != user_id:
            return {"ok": False, "error": "没有这个通宵任务"}
        if r.status != "running":
            return {"ok": True, "status": r.status}
        r.status, r.offline_at = "offline", _iso(_now(now))
        s.commit()
        text = _offline_text(r, reason=reason.strip()[:40] or "关机或退出了镜流")
        uid = r.user_id
    _send(uid, text)
    return {"ok": True, "status": "offline"}


def finish(user_id: int, session_id: str, report: str, stopped: bool = False, now: datetime | None = None) -> dict:
    """通宵任务结束：存下报告并飞书发给用户。`stopped` = 没做完就停了（卡住、余额不足）。"""
    with get_session() as s:
        r = s.get(OvernightRun, str(session_id or "")[:64])
        if r is None or r.user_id != user_id:
            return {"ok": False, "error": "没有这个通宵任务"}
        r.status = "stopped" if stopped else "done"
        r.report = _clip("report", report)
        r.last_beat_at = _iso(_now(now))
        s.commit()
        head = f"{_name(r)} {'没有做完，已停下' if stopped else '已经做完'}。"
        text = f"{head}\n{r.report}" if r.report else head
    sent = _send(user_id, text)
    return {"ok": True, "status": "stopped" if stopped else "done", "feishu_sent": sent}


def sweep(now: datetime | None = None) -> int:
    """把心跳超时的通宵任务标为离线并通知，返回通知的条数。"""
    cutoff = _iso(_now(now) - timedelta(seconds=OFFLINE_AFTER_SEC))
    stamp = _iso(_now(now))
    notices: list[tuple[int, str]] = []
    with get_session() as s:
        rows = (s.query(OvernightRun)
                .filter(OvernightRun.status == "running", OvernightRun.last_beat_at < cutoff).all())
        for r in rows:
            r.status, r.offline_at = "offline", stamp
            notices.append((r.user_id, _offline_text(r, reason="离线了（睡眠、合盖、断网或关机）")))
        s.commit()
    for uid, text in notices:
        _send(uid, text)
    return len(notices)
