"""短剧编导的剧变音色分配协调（2026-11-05，从 muse-med 的账号网关迁来）。

剧变（jubianai.net）项目里，同一个角色在同一个人生阶段只应注册一份音色。多个人、多个对话同时给同一个
项目做配音时，先在这里「认领」这个槽位，注册完成后再登记最终的剧变音频资产；别人看到的是已完成的那一份，
不会重复注册（重复注册会多花钱、还会让同一个角色出现两种声音）。

流程：acquire（认领，拿到租约）→ start（标记已提交注册）→ complete（登记音频资产 id）；
中途放弃用 abandon（只有还没提交的认领才能放弃）；read 只读。认领超时（默认 2 分钟）未提交会自动释放；
已提交的不会过期，只能由原操作者用原租约完成。

每次请求都用**调用者自己的剧变令牌**向剧变核对：他确实能访问这个项目；登记完成时再核对那个音频资产
确实属于这个项目、是音频类、名字里带这个槽位的标记、链接是 https。令牌只用于这次核对，**不落库**。
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import re
import secrets
import threading
import time

import httpx

logger = logging.getLogger(__name__)

_PROVIDER = "https://web.jubianai.net/prod-api"
_ACTIONS = {"acquire", "start", "complete", "abandon", "read"}
_KEYS = {"action", "script_id", "character_id", "voice_period_id", "operation_key", "lease_id", "asset_id"}
_LEASE = re.compile(r"^[A-Za-z0-9_-]{43}$")
#: 认领多久没提交就自动释放（毫秒）。
LEASE_MS = 120_000
_TIMEOUT_SEC = 10
_lock = threading.Lock()


class SlotError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _text(v) -> bool:
    return isinstance(v, str) and 0 < len(v.strip()) and len(v) <= 256 and not re.search(r"[\x00-\x1f\x7f]", v)


def _positive(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v > 0


def _tag(slot: dict) -> str:
    raw = json.dumps([slot["script_id"], slot["character_id"], slot["voice_period_id"]], ensure_ascii=False, separators=(",", ":"))
    return f"⟦muse-voice:v1:{base64.urlsafe_b64encode(raw.encode()).decode().rstrip('=')}⟧"


def _slot_key(slot: dict) -> str:
    return hashlib.sha256(json.dumps([slot["script_id"], slot["character_id"], slot["voice_period_id"]],
                                     ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def _validate(value) -> dict:
    if not isinstance(value, dict) or set(value) - _KEYS or value.get("action") not in _ACTIONS \
            or not _positive(value.get("script_id")) or not _text(value.get("character_id")) \
            or not _text(value.get("voice_period_id")) or not _text(value.get("operation_key")) \
            or ("lease_id" in value and (not isinstance(value["lease_id"], str) or not _LEASE.fullmatch(value["lease_id"]))) \
            or ("asset_id" in value and not _positive(value["asset_id"])):
        raise SlotError(400, "invalid_request", "音色认领请求无效")
    if value["action"] in ("start", "complete", "abandon") and "lease_id" not in value:
        raise SlotError(400, "invalid_request", "缺少认领租约")
    if value["action"] == "complete" and "asset_id" not in value:
        raise SlotError(400, "invalid_request", "缺少音频资产 id")
    return value


def _jubian_get(token: str, path: str):
    try:
        resp = httpx.get(_PROVIDER + path, headers={"authorization": f"Bearer {token}", "accept": "application/json"},
                         timeout=_TIMEOUT_SEC, follow_redirects=False)
    except httpx.HTTPError:
        raise SlotError(503, "provider_unavailable", "暂时无法向剧变核对") from None
    if resp.status_code >= 400:
        raise SlotError(403 if resp.status_code in (401, 403) else 503, "project_access_unverified", "无法向剧变核对访问权")
    if len(resp.content) > 1_048_576:
        raise SlotError(503, "provider_unavailable", "剧变返回过大")
    try:
        parsed = resp.json()
    except ValueError:
        raise SlotError(503, "provider_unavailable", "剧变返回无法解析") from None
    env = parsed[0] if isinstance(parsed, list) and len(parsed) == 1 else parsed
    if not isinstance(env, dict) or env.get("code") not in (0, 200):
        raise SlotError(403, "project_access_unverified", "无法向剧变核对访问权")
    inner = env.get("data")
    return inner.get("data") if isinstance(inner, dict) and inner.get("code") in (0, 200) and "data" in inner else inner


def _verify_project(token: str, script_id: int) -> None:
    value = _jubian_get(token, f"/aigc/script/{script_id}")
    ids = [v for v in ((value or {}).get("id"), (value or {}).get("scriptId")) if v is not None] if isinstance(value, dict) else []
    if not ids or any(str(i) != str(script_id) for i in ids):
        raise SlotError(403, "project_access_unverified", "无法确认你能访问这个剧变项目")


def _verify_asset(token: str, slot: dict, asset_id: int) -> dict:
    value = _jubian_get(token, f"/aigc/asset/{asset_id}")
    if not isinstance(value, dict):
        raise SlotError(409, "asset_unverified", "音频资产不可读")
    num = lambda v: int(v) if isinstance(v, str) and re.fullmatch(r"[1-9][0-9]*", v) else v  # noqa: E731
    ids = [num(v) for v in (value.get("id"), value.get("asset_id")) if v is not None]
    projects = [num(v) for v in (value.get("scriptId"), value.get("script_id")) if v is not None]
    cats = [v for v in (value.get("assetType"), value.get("asset_type")) if v is not None]
    name, url = value.get("assetName") or value.get("name"), value.get("assetUrl") or value.get("url")
    deleted = value.get("deleted")
    if not ids or ids[0] != asset_id or any(i != asset_id for i in ids) or not projects or any(p != slot["script_id"] for p in projects) \
            or not cats or any(c != 4 for c in cats) or value.get("delFlag") not in (0, "0") \
            or deleted not in (None, False, 0, "0") or not isinstance(name, str) or not name.endswith(_tag(slot)):
        raise SlotError(409, "asset_unverified", "音频资产的项目、类型或音色标记对不上")
    if not isinstance(url, str) or not url.startswith("https://") or "@" in url.split("/")[2] or "#" in url or "\\" in url:
        raise SlotError(409, "asset_unverified", "音频资产需要不带凭据的 https 链接")
    return {"asset_id": asset_id, "script_id": slot["script_id"], "asset_type": 4, "name": name, "url": url,
            "character_id": slot["character_id"], "voice_period_id": slot["voice_period_id"], "voice_slot_tag": _tag(slot)}


def request(user_id: int, token: str, value) -> dict:
    """处理一次协调请求；返回的记录由客户端逐项校验。"""
    from .db import DramaVoiceSlot, get_session
    req = _validate(value)
    if not isinstance(token, str) or not 0 < len(token) <= 8192 or re.search(r"[\x00-\x20\x7f]", token):
        raise SlotError(400, "invalid_request", "缺少剧变令牌")
    account = str(user_id)
    _verify_project(token, req["script_id"])
    base = {"script_id": req["script_id"], "character_id": req["character_id"], "voice_period_id": req["voice_period_id"]}
    key = _slot_key(req)
    with _lock:
        with get_session() as s:
            row = s.get(DramaVoiceSlot, key)
            now = int(time.time() * 1000)
            cur = None if row is None or (row.state == "reserved" and row.lease_expires_at <= now) else row
            owner = cur is not None and cur.owner_account_id == account and cur.operation_key == req["operation_key"]

            def view(r, **extra):
                out = {**base, "state": r.state if r is not None else "available"}
                if r is not None and owner:
                    out.update({"owner_operation": True, "lease_id": r.lease_id})
                    if r.state == "reserved":
                        out["lease_expires_at"] = r.lease_expires_at
                out.update(extra)
                return out

            if req["action"] == "read":
                return view(cur, asset=_verify_asset(token, req, cur.asset_id)) if cur is not None and cur.state == "ready" else view(cur)
            if req["action"] == "acquire":
                if cur is not None and cur.state == "ready":
                    return view(cur, asset=_verify_asset(token, req, cur.asset_id))
                if cur is not None:
                    return view(cur) if owner else {**base, "state": "busy", "blocking_state": cur.state}
                lease = secrets.token_urlsafe(32)
                fresh = DramaVoiceSlot(slot_key=key, script_id=req["script_id"], character_id=req["character_id"],
                                       voice_period_id=req["voice_period_id"], state="reserved", owner_account_id=account,
                                       operation_key=req["operation_key"], lease_id=lease, lease_expires_at=now + LEASE_MS,
                                       updated_at=now, asset_id=None)
                s.merge(fresh)
                s.commit()
                return {**base, "state": "reserved", "owner_operation": True, "lease_id": lease, "lease_expires_at": now + LEASE_MS}
            if cur is None or not owner or cur.lease_id != req.get("lease_id"):
                raise SlotError(409, "lease_conflict", "这个认领租约不可用或属于别的操作")
            if req["action"] == "start":
                if cur.state == "ready":
                    return view(cur, asset=_verify_asset(token, req, cur.asset_id), started_now=False)
                if cur.state == "submitted":
                    return view(cur, started_now=False)
                cur.state, cur.updated_at = "submitted", now
                s.commit()
                return view(cur, started_now=True)
            if req["action"] == "abandon":
                if cur.state != "reserved":
                    raise SlotError(409, "submitted_registration", "已提交的音色注册只能由原操作完成核对")
                cur.lease_expires_at, cur.updated_at = now, now
                s.commit()
                return {**base, "state": "available"}
            if cur.state == "reserved":
                raise SlotError(409, "registration_not_started", "音色注册还没有标记为已提交")
            if cur.state == "ready" and cur.asset_id != req["asset_id"]:
                raise SlotError(409, "asset_conflict", "已完成的音色注册不能换资产")
            asset = _verify_asset(token, req, req["asset_id"])
            if cur.state != "ready":
                cur.state, cur.asset_id, cur.updated_at = "ready", req["asset_id"], now
                s.commit()
            return view(cur, asset=asset)
