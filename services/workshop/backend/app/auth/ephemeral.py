"""一次性短时凭证存储：飞书 state / claim_token / merge_token 共用一套。

## 为什么要有这个模块（生产事故复盘）

生产上有用户反复撞到「state 无效或已过期，请重新发起登录」。原实现是
`feishu_oauth._STATES` 这样一个**进程内存 dict + pop**，三种情况会踩空：

1. **重放** —— `pop` 是严格一次性，用户在回调页按刷新/后退、或把回调链接
   再打开一次，第二次必然落空。这是日志里最常见的一种：实测同一个 state
   `…5MyaQafcHQf` 在 02:27:57 与 02:33:01 各出现一次。
2. **超时** —— TTL 只有 300 秒，而 state 是**渲染二维码时**就签发的。
   用户把登录页晾在那儿几分钟再扫，就已经过期了。
   （飞书 code 的 5 分钟是"扫完之后"才开始算的，两者不是一回事，
   原注释把它们混为一谈。）
3. **重启即失忆** —— orchestrator 一重启 dict 就空了，当时正在授权的人全挂。
   将来只要给 uvicorn 加 `--workers` 或起副本，还会变成高频失败：
   签发 state 的进程和处理回调的进程根本不是同一个。

所以搬到 Redis。同时 `account_merge._TOKENS` 是同一套写法、同一批毛病
（那边的注释也写着"将来多实例换 Redis（两处一起换）"），一并收编到这里。

## 三种失败要能分开报

用户看到的文案必须能指导他下一步做什么，"无效或已过期"这种二合一说法
既不告诉他发生了什么，也不告诉他该干嘛。为此**物理 TTL 比逻辑 TTL 长**
（多留 `_GRACE`），凭证被消费后还会留一份墓碑，于是能分辨：

  * 记录在、`used=1`     → `used`    「已经用过了」→ 多半是刷新/后退
  * 记录在、`exp` 已过    → `expired` 「超时了」→ 让他重新扫码
  * 记录不在             → `unknown` 「会话已失效」→ 超过宽限期或服务重启过

## Redis 挂了怎么办

降级回进程内存（也就是原来的行为），而不是让所有人登不进来。
登录链路不该因为缓存不可用而整条断掉。
"""
from __future__ import annotations

import json
import logging
import secrets
import time
from typing import Any

from redis import asyncio as aioredis

from ..config import get_settings

logger = logging.getLogger("auth.ephemeral")

# 物理保留时长 = 逻辑 TTL + 宽限。宽限期内记录还在，只是 exp 已过，
# 于是能明确告诉用户"超时了"而不是含糊的"无效"。
_GRACE = 1800

# 墓碑保留时长：消费成功后留这么久，用来识别"重放"。
_TOMBSTONE_TTL = 1800

_redis: aioredis.Redis | None = None

# Redis 不可用时的降级存储：{full_key: value_dict}
_fallback: dict[str, dict[str, Any]] = {}


class EphemeralError(ValueError):
    """凭证不可用。`code` ∈ used / expired / unknown，供上层挑文案。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _r() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(get_settings().redis_url, decode_responses=True)
    return _redis


def _key(ns: str, token: str) -> str:
    return f"drama:auth:{ns}:{token}"


def new_token() -> str:
    return secrets.token_urlsafe(24)


def _gc_fallback() -> None:
    now = time.time()
    for k in [k for k, v in _fallback.items() if v.get("gone_at", 0) < now]:
        _fallback.pop(k, None)


async def put(ns: str, token: str, data: dict, ttl: int) -> None:
    """写入一条一次性凭证。ns 用于隔离用途（state / claim / merge）。"""
    now = time.time()
    val = {"exp": now + ttl, "used": 0, "data": dict(data)}
    k = _key(ns, token)
    try:
        await _r().set(k, json.dumps(val), ex=ttl + _GRACE)
    except Exception as e:  # noqa: BLE001  Redis 不可用 → 降级进程内存
        logger.warning("ephemeral put via redis failed, fallback to memory: %s", e)
        _gc_fallback()
        _fallback[k] = {**val, "gone_at": now + ttl + _GRACE}


async def _load(k: str) -> dict | None:
    try:
        raw = await _r().get(k)
        if raw:
            return json.loads(raw)
    except Exception as e:  # noqa: BLE001
        logger.warning("ephemeral get via redis failed, fallback to memory: %s", e)
    _gc_fallback()
    return _fallback.get(k)


def _check(val: dict | None) -> dict:
    """把三种失败翻译成用户看得懂、且能照着做的话。"""
    if not val:
        raise EphemeralError(
            "unknown",
            "登录会话已失效（链接太旧，或服务刚刚重启过）。请返回登录页重新扫码。",
        )
    if val.get("used"):
        raise EphemeralError(
            "used",
            "这个登录链接已经用过了（多半是刷新或后退导致的）。请返回登录页重新扫码。",
        )
    if time.time() > float(val.get("exp") or 0):
        raise EphemeralError(
            "expired",
            "登录超时了（二维码停留太久未完成授权）。请返回登录页重新扫码。",
        )
    return dict(val.get("data") or {})


async def peek(ns: str, token: str) -> dict:
    """只读不消费 —— 认领页要先把飞书姓名显示出来给用户确认。"""
    return _check(await _load(_key(ns, token)))


async def consume(ns: str, token: str) -> dict:
    """校验并消费（一次性，防重放）。成功后原地留墓碑，重放时报 `used`。"""
    k = _key(ns, token)
    val = await _load(k)
    data = _check(val)
    tomb = {"exp": val.get("exp"), "used": 1, "data": {}}
    try:
        await _r().set(k, json.dumps(tomb), ex=_TOMBSTONE_TTL)
    except Exception as e:  # noqa: BLE001
        logger.warning("ephemeral tombstone via redis failed: %s", e)
        _fallback[k] = {**tomb, "gone_at": time.time() + _TOMBSTONE_TTL}
    return data
