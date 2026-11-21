"""飞书提醒（2026-11-01）：用户主动要求时，到点或任务结束后由机器人私信他本人。

- 只发给创建提醒的人：收件人取自 `user_id`，没有「发给别人」的入口。
- 只在用户要求时创建，后台任务不会自动提醒。
- 存在 `feishu_reminders`，所以客户端关着、后端重启后都照常送达。
- 发送失败留在 pending 重试，超过 `MAX_ATTEMPTS` 记 failed，不会无限重发。
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

from .auth import KnownUser
from .db import FeishuReminder, Job, Project, get_session

log = logging.getLogger(__name__)

CST = timezone(timedelta(hours=8))
MAX_ATTEMPTS = 5
MAX_TEXT = 500
#: 一个人同时等待中的提醒上限，防止循环调用刷屏。
MAX_PENDING = 50
MAX_AHEAD_DAYS = 366
_DONE = {"done": "已完成", "failed": "失败了", "cancelled": "已取消"}


class ReminderError(ValueError):
    """用户能看懂、能照着改的拒绝原因。"""


def _utc(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat(timespec="seconds")


def parse_time(value: str) -> datetime:
    """解析到点时间；没写时区按北京时间，这是用户说话的口径。"""
    try:
        at = datetime.fromisoformat((value or "").strip())
    except ValueError as e:
        raise ReminderError("时间格式不对，要 ISO 格式，例如 2026-11-02T15:00:00+08:00") from e
    return at.replace(tzinfo=CST) if at.tzinfo is None else at


def _view(r: FeishuReminder) -> dict:
    out = {"id": r.id, "kind": r.kind, "text": r.text, "status": r.status}
    if r.due_at:
        out["due_at"] = datetime.fromisoformat(r.due_at).astimezone(CST).isoformat(timespec="minutes")
    if r.job_id:
        out["job_id"] = r.job_id
    return out


def _check_capacity(s, user_id: int, text: str) -> str:
    text = (text or "").strip()
    if not text:
        raise ReminderError("提醒内容不能为空")
    if len(text) > MAX_TEXT:
        raise ReminderError(f"提醒内容最长 {MAX_TEXT} 字")
    u = s.get(KnownUser, user_id) if user_id else None
    if not (u and u.feishu_union_id):
        raise ReminderError("不知道你的飞书账号：请用飞书扫码登录一次镜流")
    n = s.query(FeishuReminder).filter(FeishuReminder.user_id == user_id,
                                       FeishuReminder.status == "pending").count()
    if n >= MAX_PENDING:
        raise ReminderError(f"等待中的提醒已有 {n} 条，先取消一些")
    return text


def create_time(user_id: int, at: datetime, text: str, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    if at <= now:
        raise ReminderError("这个时间已经过了")
    if at > now + timedelta(days=MAX_AHEAD_DAYS):
        raise ReminderError("最多只能提前一年设置提醒")
    with get_session() as s:
        text = _check_capacity(s, user_id, text)
        r = FeishuReminder(id=uuid.uuid4().hex[:16], user_id=user_id, kind="time", text=text,
                           due_at=_utc(at), created_at=_utc(now))
        s.add(r)
        s.commit()
        return _view(r)


def create_job(user_id: int, job_id: str, project_id: str, text: str) -> dict:
    with get_session() as s:
        text = _check_capacity(s, user_id, text)
        old = s.query(FeishuReminder).filter(FeishuReminder.user_id == user_id, FeishuReminder.job_id == job_id,
                                             FeishuReminder.status == "pending").first()
        if old:
            return _view(old)
        r = FeishuReminder(id=uuid.uuid4().hex[:16], user_id=user_id, kind="job", text=text, job_id=job_id,
                           project_id=project_id, created_at=_utc())
        s.add(r)
        s.commit()
        return _view(r)


def list_pending(user_id: int) -> list[dict]:
    with get_session() as s:
        rows = s.query(FeishuReminder).filter(FeishuReminder.user_id == user_id, FeishuReminder.status == "pending") \
            .order_by(FeishuReminder.created_at).all()
        return [_view(r) for r in rows]


def cancel(user_id: int, reminder_id: str) -> bool:
    """只能取消自己的；别人的与不存在的同样返回 False。"""
    with get_session() as s:
        r = s.get(FeishuReminder, reminder_id)
        if r is None or r.user_id != user_id or r.status != "pending":
            return False
        r.status = "cancelled"
        s.commit()
        return True


def _job_line(s, r: FeishuReminder) -> str | None:
    j = s.get(Job, r.job_id)
    if j is None:
        return f"任务 {r.job_id} 已不存在。{r.text}"
    state = _DONE.get(j.status)
    if state is None:
        return None
    p = s.get(Project, r.project_id) if r.project_id else None
    head = f"「{p.title}」的任务{state}" if p else f"任务{state}"
    return f"{head}。{r.text}"


def _send(union_id: str, text: str) -> None:
    from . import feishu_open
    feishu_open.call("POST", "/open-apis/im/v1/messages", params={"receive_id_type": "union_id"},
                     body={"receive_id": union_id, "msg_type": "text",
                           "content": json.dumps({"text": text}, ensure_ascii=False)}, timeout=8.0)


def sweep(now: datetime | None = None) -> int:
    """发出所有到期的提醒，返回发出的条数。单条失败不影响其他条。"""
    from . import feishu_open
    if not feishu_open.configured():
        return 0
    stamp = _utc(now)
    sent = 0
    with get_session() as s:
        rows = s.query(FeishuReminder).filter(FeishuReminder.status == "pending").all()
        for r in rows:
            if r.kind == "time":
                if (r.due_at or "") > stamp:
                    continue
                line = f"提醒：{r.text}"
            else:
                line = _job_line(s, r)
                if line is None:
                    continue
            u = s.get(KnownUser, r.user_id)
            try:
                if not (u and u.feishu_union_id):
                    raise ReminderError("用户没有飞书身份")
                _send(u.feishu_union_id, line)
                r.status, r.sent_at, r.error = "sent", stamp, None
                sent += 1
            except Exception as e:  # noqa: BLE001  一条发不出去不能挡住后面的
                r.attempts += 1
                r.error = repr(e)[:300]
                if r.attempts >= MAX_ATTEMPTS:
                    r.status = "failed"
                log.warning("[reminder] 发送失败 id=%s attempts=%s: %r", r.id, r.attempts, e)
            # 每条单独提交：进程中途退出时，已发的不会下次重发。
            s.commit()
    return sent
