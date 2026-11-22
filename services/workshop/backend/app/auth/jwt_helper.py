"""JWT token编码/解码"""
import os
import uuid
from datetime import datetime, timedelta
from jose import jwt, JWTError

# 必须通过环境变量设置：dev 与 prod 各用一个随机值（2026-11-01 前两边都没设，
# 共用下面这个写在源码里的默认值，任何看过源码的人都能签出生产任意用户的令牌）。
# 只有本机单测/脚本可以不设；容器里（ENV=dev/prod）没设就拒绝启动。
_DEFAULT_SECRET = "drama-dev-secret-change-me-in-production"
JWT_SECRET = os.environ.get("JWT_SECRET") or _DEFAULT_SECRET
if JWT_SECRET == _DEFAULT_SECRET and os.environ.get("ENV") in ("dev", "prod"):
    raise RuntimeError("JWT_SECRET 未设置：在 services/orchestrator/.env 里配置一个随机值，dev 与 prod 必须不同")
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_TTL = timedelta(hours=24)      # 1天,为允许多端并存
REFRESH_TOKEN_TTL = timedelta(days=30)


def create_access_token(user_id: int, username: str, role: str) -> tuple[str, str]:
    """返回 (token, jti)"""
    jti = str(uuid.uuid4())
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "type": "access",
        "iat": datetime.utcnow(),
        "exp": datetime.utcnow() + ACCESS_TOKEN_TTL,
        "jti": jti,
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return token, jti


def create_refresh_token(user_id: int) -> tuple[str, str]:
    jti = str(uuid.uuid4())
    payload = {
        "sub": str(user_id),
        "type": "refresh",
        "iat": datetime.utcnow(),
        "exp": datetime.utcnow() + REFRESH_TOKEN_TTL,
        "jti": jti,
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return token, jti


def decode_token(token: str) -> dict:
    """解码token,失败抛JWTError"""
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
