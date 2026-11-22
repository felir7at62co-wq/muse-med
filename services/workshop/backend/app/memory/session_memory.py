"""极简会话记忆：按 session_id 存储近期摘要到 Redis。

M2：仅保存"每轮输入 + 最终剧本的摘要"，供后续轮注入 memory_summary。
M3：再接入 LangGraph 原生 Checkpointer 做完整状态恢复。
"""
from __future__ import annotations

import json
from redis import asyncio as aioredis

from ..config import get_settings

_redis: aioredis.Redis | None = None


def _r() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(get_settings().redis_url, decode_responses=True)
    return _redis


def _key(session_id: str) -> str:
    return f"drama:session:{session_id}:summary"


async def get_summary(session_id: str) -> str:
    return (await _r().get(_key(session_id))) or ""


async def set_summary(session_id: str, text: str) -> None:
    await _r().set(_key(session_id), text, ex=60 * 60 * 24 * 7)


async def append_turn(session_id: str, user_input: str, final_script: str) -> None:
    """把新一轮摘要附加到既有摘要上（截断）。"""
    prev = await get_summary(session_id)
    merged = (prev + "\n" if prev else "") + f"Q: {user_input[:200]}\nA: {final_script[:600]}"
    await set_summary(session_id, merged[-4000:])
