"""JWT + API Key 认证。

前台用 JWT（登录获取 token）。
Admin 后台可用 JWT 或 X-API-Key header。
生成端点支持两种方式。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json as _json
import time
from typing import Annotated

from fastapi import Depends, HTTPException, Header, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from ..config import get_settings

_bearer = HTTPBearer(auto_error=False)


def _secret() -> str:
    return get_settings().jwt_secret or "drama-dev-secret-change-me"


# ---------------------------------------------------------------------------
# 极简 JWT（HS256，无外部依赖；生产建议换 python-jose）
# ---------------------------------------------------------------------------

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(s: str) -> bytes:
    s += "=" * (4 - len(s) % 4)
    return base64.urlsafe_b64decode(s)


def _sign(payload: str) -> str:
    return _b64url_encode(
        hmac.new(_secret().encode(), payload.encode(), hashlib.sha256).digest()
    )


def create_token(sub: str, role: str = "user", ttl: int = 86400 * 7) -> str:
    header = _b64url_encode(_json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = _b64url_encode(
        _json.dumps({"sub": sub, "role": role, "exp": int(time.time()) + ttl}).encode()
    )
    sig = _sign(f"{header}.{body}")
    return f"{header}.{body}.{sig}"


def decode_token(token: str) -> dict:
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("bad token")
    expected_sig = _sign(f"{parts[0]}.{parts[1]}")
    if not hmac.compare_digest(expected_sig, parts[2]):
        raise ValueError("bad sig")
    payload = _json.loads(_b64url_decode(parts[1]))
    if payload.get("exp", 0) < time.time():
        raise ValueError("expired")
    return payload


# ---------------------------------------------------------------------------
# FastAPI dependencies
# ---------------------------------------------------------------------------
def _extract_token(
    creds: HTTPAuthorizationCredentials | None,
    x_api_key: str | None,
) -> dict:
    """
    解析 Bearer / X-API-Key, 兼容 2 种 JWT 格式:
      A. app/auth/jwt_helper.py 用 PyJWT 签出的 token (登录页 /v1/auth/login 返回的)
         - secret  : os.environ['JWT_SECRET'] (默认 'drama-dev-secret-change-me-in-production')
         - 算法    : HS256
         - payload : {sub: '<user_id>', username, role, exp, iat, jti, type:'access'}
      B. app/security/auth.py 这里手搓的 token (老 admin / generate API 用的)
         - secret  : settings.jwt_secret (默认 'drama-dev-secret-change-me')
         - payload : {sub: '<username>', role, exp}
    实际登录走 A, 但所有 admin-api 都用本模块的 require_admin → 历史上只接受 B
    → admin 登录后任何调用都 401 → 前端 adminFetch 捕到 401 强制清 token + reload → 闪退
    修复: 优先 A (PyJWT), 失败再 fallback B
    """
    s = get_settings()

    # 1. X-API-Key 匹配（Admin 快捷方式）
    if x_api_key and s.admin_api_key and hmac.compare_digest(x_api_key, s.admin_api_key):
        return {"sub": "admin", "role": "admin"}

    # 2. Bearer JWT — 双格式兼容
    if creds and creds.credentials:
        token = creds.credentials
        last_err: str = ""
        # 2a. 先试 python-jose (auth/jwt_helper.py 用的; 前端登录页签出的格式)
        try:
            from jose import jwt as _jose_jwt  # type: ignore
            import os as _os
            _secret_a = _os.environ.get(
                "JWT_SECRET", "drama-dev-secret-change-me-in-production"
            )
            payload_a = _jose_jwt.decode(token, _secret_a, algorithms=["HS256"])
            # 转 'role' 兜底 (避免漏 role 时 require_admin 拒)
            return {
                "sub": payload_a.get("sub", ""),
                "role": payload_a.get("role", "user"),
                "username": payload_a.get("username"),
                "type": payload_a.get("type", "access"),
            }
        except Exception as e_a:  # noqa: BLE001
            last_err = f"jose: {e_a}"
        # 2b. 老手搓 HS256 (settings.jwt_secret)
        try:
            return decode_token(token)
        except ValueError as e_b:
            raise HTTPException(401, f"token 无效: {last_err}; legacy: {e_b}")
        except Exception as e_b:  # noqa: BLE001
            raise HTTPException(401, f"token 无效: {last_err}; legacy: {e_b}")

    # 3. AUTH_REQUIRED=false 时跳过认证（不论 ENV 值）
    if not s.auth_required:
        return {"sub": "anonymous", "role": "admin"}

    raise HTTPException(401, "authentication required")


async def require_auth(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)] = None,
    x_api_key: str | None = Header(None, alias="X-API-Key"),
) -> dict:
    return _extract_token(creds, x_api_key)


async def require_admin(
    user: Annotated[dict, Depends(require_auth)],
) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(403, "admin role required")
    return user
