"""TikHub HTTP 客户端。

统一封装:
- Bearer 鉴权
- GET(query) / POST(json body) 两种调用
- Redis 缓存(命中不计费): key = tikhub:{md5(method+path+params)}
- 用量流水记录(TikHubUsage): 每次真实外部调用记一条(命中缓存也记, 标 cached=True/billed=False)
- 错误归一化: 统一抛 TikHubError, 上层可兜底

计费说明: TikHub 每次成功外部请求都会计费, 所以缓存优先; 命中缓存不产生费用。
"""
from __future__ import annotations

import hashlib
import json
import logging
from typing import Any, Optional

import httpx
from redis import asyncio as aioredis

from ..config import get_settings
from ..db import session_scope
from .models import TikHubUsage

logger = logging.getLogger(__name__)

_redis: aioredis.Redis | None = None


def _r() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(get_settings().redis_url, decode_responses=True)
    return _redis


class TikHubError(Exception):
    """TikHub 调用失败(网络/鉴权/上游错误)。"""


def _cache_key(method: str, path: str, params: dict | None) -> str:
    raw = f"{method}:{path}:{json.dumps(params or {}, sort_keys=True, ensure_ascii=False)}"
    return "tikhub:" + hashlib.md5(raw.encode("utf-8")).hexdigest()


async def _record_usage(
    *,
    user_id: Optional[int],
    endpoint: str,
    path: str,
    keyword: Optional[str],
    ok: bool,
    cached: bool,
    status_code: Optional[int],
    request_id: Optional[str],
    error: Optional[str],
) -> None:
    """写用量流水(尽力而为, 不阻断主流程)。"""
    try:
        async with session_scope() as sess:
            sess.add(
                TikHubUsage(
                    user_id=user_id,
                    endpoint=endpoint,
                    tikhub_path=path[:256],
                    keyword=(keyword or "")[:256] or None,
                    ok=ok,
                    cached=cached,
                    billed=(not cached and ok),
                    status_code=status_code,
                    request_id=(request_id or "")[:64] or None,
                    error=(error or "")[:512] or None,
                )
            )
    except Exception:  # noqa: BLE001 - 统计失败绝不影响业务
        logger.exception("记录 TikHub 用量失败(忽略)")


async def call(
    path: str,
    *,
    method: str = "GET",
    params: dict | None = None,
    json_body: dict | None = None,
    endpoint: str = "",
    user_id: Optional[int] = None,
    keyword: Optional[str] = None,
    cache_ttl: int = 0,
) -> dict[str, Any]:
    """调用一个 TikHub 接口, 返回解析后的 JSON dict。

    - method: GET / POST
    - params: GET query 或 POST 时也可作 query
    - json_body: POST body
    - endpoint: 逻辑功能名(用量统计用), 默认取 path 末段
    - cache_ttl: >0 则启用缓存; 命中不计费
    """
    s = get_settings()
    if not s.tikhub_enable:
        raise TikHubError("TikHub 未启用(tikhub_enable=False)")
    if not s.tikhub_api_key:
        raise TikHubError("TikHub API Key 未配置(tikhub_api_key)")

    endpoint = endpoint or path.rstrip("/").split("/")[-1]
    cache_params = {**(params or {}), **(json_body or {})}
    ck = _cache_key(method, path, cache_params) if cache_ttl > 0 else None

    # 1) 缓存命中(不计费)
    if ck:
        try:
            hit = await _r().get(ck)
        except Exception:  # noqa: BLE001
            hit = None
        if hit:
            await _record_usage(
                user_id=user_id, endpoint=endpoint, path=path, keyword=keyword,
                ok=True, cached=True, status_code=200, request_id=None, error=None,
            )
            return json.loads(hit)

    # 2) 真实外部调用(计费)
    url = s.tikhub_base_url.rstrip("/") + path
    headers = {"Authorization": f"Bearer {s.tikhub_api_key}", "User-Agent": "drama-orchestrator/1.0"}
    try:
        async with httpx.AsyncClient(timeout=s.tikhub_timeout) as cli:
            if method.upper() == "POST":
                resp = await cli.post(url, params=params or None, json=json_body or {}, headers=headers)
            else:
                resp = await cli.get(url, params=params or None, headers=headers)
        data = resp.json()
    except Exception as e:  # noqa: BLE001
        await _record_usage(
            user_id=user_id, endpoint=endpoint, path=path, keyword=keyword,
            ok=False, cached=False, status_code=None, request_id=None, error=str(e),
        )
        raise TikHubError(f"TikHub 请求失败: {e}") from e

    code = data.get("code")
    request_id = data.get("request_id")
    ok = code == 200
    await _record_usage(
        user_id=user_id, endpoint=endpoint, path=path, keyword=keyword,
        ok=ok, cached=False, status_code=code, request_id=request_id,
        error=None if ok else str(data.get("detail") or data.get("message"))[:512],
    )
    if not ok:
        raise TikHubError(f"TikHub 返回非200: code={code}, detail={data.get('detail') or data.get('message')}")

    # 3) 写缓存
    if ck:
        try:
            await _r().set(ck, json.dumps(data, ensure_ascii=False), ex=cache_ttl)
        except Exception:  # noqa: BLE001
            pass
    return data