"""用户反馈写入与查询。"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import func, select

from ..db import session_scope
from .models import UserFeedback

logger = logging.getLogger("feedback")

MAX_CONTENT = 2000


async def create_feedback(
    *,
    user_id: int,
    username: Optional[str],
    display_name: Optional[str],
    content: str,
    page_url: Optional[str],
) -> dict:
    content = (content or "").strip()[:MAX_CONTENT]
    async with session_scope() as s:
        row = UserFeedback(
            user_id=user_id,
            username=username,
            display_name=display_name,
            content=content,
            page_url=(page_url or None),
            status="new",
        )
        s.add(row)
        await s.flush()
        return {"id": row.id, "status": row.status}


async def list_feedback(
    *,
    status: Optional[str] = None,
    user_id: Optional[int] = None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    async with session_scope() as s:
        q = select(UserFeedback)
        cnt_q = select(func.count(UserFeedback.id))
        if status:
            q = q.where(UserFeedback.status == status)
            cnt_q = cnt_q.where(UserFeedback.status == status)
        if user_id is not None:
            q = q.where(UserFeedback.user_id == user_id)
            cnt_q = cnt_q.where(UserFeedback.user_id == user_id)
        total = (await s.execute(cnt_q)).scalar() or 0
        q = q.order_by(UserFeedback.id.desc()).limit(limit).offset(offset)
        rows = (await s.execute(q)).scalars().all()
        items = [
            {
                "id": r.id,
                "user_id": r.user_id,
                "username": r.username,
                "display_name": r.display_name,
                "content": r.content,
                "page_url": r.page_url,
                "status": r.status,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]
    return {"items": items, "total": int(total), "limit": limit, "offset": offset}


async def unread_count() -> int:
    """未读 (status=new) 数量, 给管理后台红点用。"""
    async with session_scope() as s:
        n = (await s.execute(
            select(func.count(UserFeedback.id)).where(UserFeedback.status == "new")
        )).scalar() or 0
    return int(n)


async def update_status(*, feedback_id: int, status: str) -> bool:
    if status not in ("new", "read", "resolved"):
        return False
    async with session_scope() as s:
        row = await s.get(UserFeedback, feedback_id)
        if not row:
            return False
        row.status = status
    return True