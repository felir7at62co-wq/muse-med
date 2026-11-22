"""飞书机器人 → 剧本平台 Agent 的内部入口（2026-11-01）。

飞书长连接由镜流后端持有，用户在飞书切到剧本平台后，镜流后端把话转到这里。这里按飞书 union_id
认人，之后完全走网页超级 Agent 的路由函数：权限、审批、上下文摘要都与网页同一套。
写稿模型用用户存的个人偏好。

安全：dev 的 nginx 把 /api/ 透传给 orchestrator，所以不能只靠路径名。必须带 X-Bridge-Key
（环境变量 FEISHU_BRIDGE_KEY，不配 = 入口关闭），且经 nginx 转发的请求一律拒绝。
"""
from __future__ import annotations

import hmac
import logging
import os

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..auth.models import User
from ..db import session_scope
from .desktop import _preferred
from .routes import DecisionIn, StartRunIn, cancel_run, decide, get_run, start_run

logger = logging.getLogger("agent_engine.bridge")

router = APIRouter(prefix="/internal/feishu-bridge", tags=["internal"], include_in_schema=False)


async def _caller(request: Request, union_id: str = Query(..., min_length=1)) -> User:
    key = os.environ.get("FEISHU_BRIDGE_KEY", "")
    if not key or not hmac.compare_digest(request.headers.get("x-bridge-key", ""), key):
        raise HTTPException(403, "forbidden")
    if request.headers.get("x-real-ip") or request.headers.get("x-forwarded-for"):
        raise HTTPException(403, "forbidden")
    async with session_scope() as s:
        user = (await s.execute(select(User).where(User.feishu_union_id == union_id))).scalar_one_or_none()
        if user is None or user.status != "active":
            raise HTTPException(404, "你还没有用飞书登录过剧本平台：请先在网页或桌面端扫码登录一次")
        s.expunge(user)
    return user


class TurnIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=20000)
    conversation_id: int | None = None


class DecideIn(BaseModel):
    approve: bool


@router.post("/turn")
async def turn(body: TurnIn, user: User = Depends(_caller)) -> dict:
    return await start_run(StartRunIn(message=body.text, profile="producer", conversation_id=body.conversation_id,
                                      writing_model=await _preferred(user.id)), user=user)


@router.get("/runs/{run_id}")
async def run(run_id: int, user: User = Depends(_caller)) -> dict:
    return await get_run(run_id, user=user)


@router.post("/runs/{run_id}/decide")
async def decide_all(run_id: int, body: DecideIn, user: User = Depends(_caller)) -> dict:
    """飞书里只有一句「确认」或「取消」：对这一轮所有待确认项做同一个决定。"""
    pending = [a for a in (await get_run(run_id, user=user))["approvals"] if a["status"] == "pending"]
    verdict = DecisionIn(decision="approve" if body.approve else "reject", note="飞书回复")
    for a in pending:
        await decide(run_id, a["approval_id"], verdict, user=user)
    return {"ok": True, "decided": len(pending)}


@router.post("/runs/{run_id}/cancel")
async def cancel(run_id: int, user: User = Depends(_caller)) -> dict:
    return await cancel_run(run_id, user=user)
