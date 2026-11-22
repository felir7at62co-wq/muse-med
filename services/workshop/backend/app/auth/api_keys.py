"""外部 Agent 用的 API Key（2026-11-04）。

用途只有一个：让别的 Agent（同样基于 deepseek-harness 的同事、或任何支持 MCP 的客户端）
通过 ``/v1/mcp`` 调剧本平台的工具，身份就是建这把 key 的那个账号。

- **只认 MCP 端点**：``user_from_api_key`` 不进 ``get_current_user``，所以 key 用在其余几十个
  网页接口上一律 401。泄露时影响面是「能以该账号读写草稿」，碰不到账号设置与后台。
- **明文只出现一次**：创建时返回；库里存 SHA-256。丢了只能吊销重建。
- **吊销即时生效**：每次请求都查库，没有缓存。
"""
from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db import session_scope
from ..db.models_phase5 import ApiKey
from .dependencies import get_current_user
from .models import User

logger = logging.getLogger("auth.api_keys")

PREFIX = "jlk_"
#: 每个账号最多同时有效的 key 数。
MAX_ACTIVE_PER_USER = 10
#: ``last_used_at`` 最多隔多久写一次库：每次调用都写会让高频调用平白多一次 UPDATE。
_TOUCH_EVERY = timedelta(minutes=1)


def _hash(plain: str) -> str:
    return hashlib.sha256(plain.encode("utf-8")).hexdigest()


async def create_key(user_id: int, name: str) -> tuple[str, ApiKey]:
    """建一把 key。返回（明文, 行）；明文之后再也拿不到。"""
    name = (name or "").strip()[:80] or "未命名"
    async with session_scope() as s:
        active = (await s.execute(select(ApiKey).where(
            ApiKey.user_id == user_id, ApiKey.revoked_at.is_(None)))).scalars().all()
        if len(active) >= MAX_ACTIVE_PER_USER:
            raise HTTPException(409, f"每个账号最多 {MAX_ACTIVE_PER_USER} 把有效的 key，先吊销不用的")
        plain = PREFIX + secrets.token_urlsafe(32)
        row = ApiKey(user_id=user_id, name=name, prefix=plain[:12], key_hash=_hash(plain))
        s.add(row)
        await s.commit()
        await s.refresh(row)
    logger.info("api key created user=%s id=%s name=%s", user_id, row.id, name)
    return plain, row


async def user_from_api_key(plain: str) -> User | None:
    """按明文 key 找到有效账号；key 不存在、已吊销、账号停用都返回 None。"""
    if not plain.startswith(PREFIX):
        return None
    async with session_scope() as s:
        row = (await s.execute(select(ApiKey).where(ApiKey.key_hash == _hash(plain)))).scalar_one_or_none()
        if row is None or row.revoked_at is not None:
            return None
        user = await s.get(User, row.user_id)
        if user is None or user.status != "active":
            return None
        now = datetime.utcnow()
        if row.last_used_at is None or now - row.last_used_at > _TOUCH_EVERY:
            row.last_used_at = now
            await s.commit()
        _ = (user.username, user.role, user.display_name)
    try:
        from ..factory.usage import set_usage_user
        set_usage_user(user.id)
    except Exception as e:  # noqa: BLE001 - 记账永远不能挡住调用
        logger.debug("set_usage_user failed (ignored): %s", e)
    return user


async def user_for_mcp(authorization: str | None = Header(None)) -> User:
    """MCP 端点的鉴权：API Key 或正常的登录令牌都认（后者方便在网页登录态下自测）。"""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "缺少认证：请求头 Authorization: Bearer <API Key>")
    token = authorization[7:].strip()
    if token.startswith(PREFIX):
        user = await user_from_api_key(token)
        if user is None:
            raise HTTPException(401, "API Key 无效或已吊销")
        return user
    return await get_current_user(authorization)


def _view(row: ApiKey) -> dict:
    return {"id": row.id, "name": row.name, "prefix": row.prefix,
            "created_at": row.created_at, "last_used_at": row.last_used_at,
            "revoked": row.revoked_at is not None}


router = APIRouter(prefix="/v1/api-keys", tags=["api-keys"])


class CreateIn(BaseModel):
    name: str = Field(default="", max_length=80, description="给人看的用途，例如「同事 Agent」")


@router.get("")
async def list_keys(user: User = Depends(get_current_user)) -> dict:
    """本人的 key（不含明文）。"""
    async with session_scope() as s:
        rows = (await s.execute(select(ApiKey).where(ApiKey.user_id == user.id)
                                .order_by(ApiKey.id.desc()))).scalars().all()
    return {"keys": [_view(r) for r in rows]}


@router.post("")
async def create(body: CreateIn, user: User = Depends(get_current_user)) -> dict:
    """建一把 key。只能用登录令牌建（``get_current_user`` 不认 key），key 不能再生 key。"""
    plain, row = await create_key(user.id, body.name)
    return {"key": plain, **_view(row), "note": "明文只显示这一次，请立即保存；丢了只能吊销后重建"}


@router.delete("/{key_id}")
async def revoke(key_id: int, user: User = Depends(get_current_user)) -> dict:
    """吊销本人的一把 key，立即生效。"""
    async with session_scope() as s:
        row = await s.get(ApiKey, key_id)
        if row is None or row.user_id != user.id:
            raise HTTPException(404, "没有这把 key")
        if row.revoked_at is None:
            row.revoked_at = datetime.utcnow()
            await s.commit()
    logger.info("api key revoked user=%s id=%s", user.id, key_id)
    return {"ok": True, "id": key_id}
