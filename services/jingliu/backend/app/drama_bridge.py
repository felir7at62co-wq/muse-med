"""飞书机器人 → 剧本平台的内部通道（2026-11-01）。

飞书长连接只能连一处，所以由镜流后端收消息；用户切到剧本平台后，这里把话转给
orchestrator 的 `/internal/feishu-bridge`。按 union_id 认人，走本机端口，带专用密钥。
"""
from __future__ import annotations

from typing import Any

import httpx

from .config import get_settings
from .providers import http


class BridgeError(RuntimeError):
    """给用户看的失败原因。"""


def enabled() -> bool:
    s = get_settings()
    return bool(s.drama_bridge_url and s.drama_bridge_key)


async def _call(method: str, path: str, *, union_id: str, json: dict | None = None) -> dict:
    s = get_settings()
    if not enabled():
        raise BridgeError("这个环境还没接通剧本平台")
    try:
        async with http.client(s.drama_bridge_url.rstrip("/"), timeout=30.0) as client:
            r = await client.request(method, f"{s.drama_bridge_url.rstrip('/')}/internal/feishu-bridge{path}",
                                     params={"union_id": union_id}, json=json,
                                     headers={"X-Bridge-Key": s.drama_bridge_key})
    except httpx.HTTPError as e:
        raise BridgeError(f"连不上剧本平台：{type(e).__name__}") from e
    if r.status_code >= 400:
        try:
            detail: Any = r.json().get("detail")
        except ValueError:
            detail = None
        if isinstance(detail, dict):
            detail = detail.get("message")
        raise BridgeError(str(detail or f"剧本平台返回 HTTP {r.status_code}"))
    return r.json()


async def start_turn(union_id: str, text: str, conversation_id: int | None) -> dict:
    return await _call("POST", "/turn", union_id=union_id, json={"text": text, "conversation_id": conversation_id})


async def get_run(union_id: str, run_id: int) -> dict:
    return await _call("GET", f"/runs/{run_id}", union_id=union_id)


async def decide(union_id: str, run_id: int, approve: bool) -> dict:
    return await _call("POST", f"/runs/{run_id}/decide", union_id=union_id, json={"approve": approve})


async def cancel(union_id: str, run_id: int) -> dict:
    return await _call("POST", f"/runs/{run_id}/cancel", union_id=union_id)
