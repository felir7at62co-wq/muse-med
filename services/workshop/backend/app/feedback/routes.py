"""用户反馈路由。

用户端 (/v1/feedback):
  POST /                提交反馈 (登录用户)

管理端 (/v1/admin-api/feedback):
  GET  /                列表 (可选 ?status= / ?user_id= , 分页)
  GET  /unread-count    未读数量 (给菜单红点)
  PATCH /{id}/status    改状态 (read/resolved/new)
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import get_current_user, require_admin, User
from . import service

router = APIRouter(prefix="/v1/feedback", tags=["feedback"])
admin_router = APIRouter(prefix="/v1/admin-api/feedback", tags=["feedback-admin"])


class FeedbackIn(BaseModel):
    content: str = Field(..., min_length=1, max_length=service.MAX_CONTENT)
    page_url: Optional[str] = Field(default=None, max_length=500)


@router.post("")
async def submit_feedback(payload: FeedbackIn, user: User = Depends(get_current_user)):
    """登录用户提交反馈。"""
    return await service.create_feedback(
        user_id=user.id,
        username=getattr(user, "username", None),
        display_name=getattr(user, "display_name", None),
        content=payload.content,
        page_url=payload.page_url,
    )


# ---------- 管理端 ----------

@admin_router.get("")
async def admin_list(
    admin: User = Depends(require_admin),
    status: Optional[str] = None,
    user_id: Optional[int] = None,
    limit: int = 50,
    offset: int = 0,
):
    return await service.list_feedback(status=status, user_id=user_id, limit=limit, offset=offset)


@admin_router.get("/unread-count")
async def admin_unread_count(admin: User = Depends(require_admin)):
    return {"unread": await service.unread_count()}


class StatusIn(BaseModel):
    status: str = Field(..., pattern="^(new|read|resolved)$")


@admin_router.patch("/{feedback_id}/status")
async def admin_update_status(
    feedback_id: int,
    payload: StatusIn,
    admin: User = Depends(require_admin),
):
    ok = await service.update_status(feedback_id=feedback_id, status=payload.status)
    if not ok:
        raise HTTPException(404, "反馈不存在或状态非法")
    return {"ok": True, "status": payload.status}