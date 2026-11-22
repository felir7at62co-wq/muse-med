"""FastAPI依赖:获取当前登录用户"""
import logging
from fastapi import Header, HTTPException, Depends
from jose import JWTError
from sqlalchemy import select

from ..db import session_scope
from .models import User
from .jwt_helper import decode_token

logger = logging.getLogger("auth")


async def get_current_user_optional(authorization: str | None = Header(None)) -> User | None:
    """可选认证:有token则返回user,无则返回None。用于兼容旧API的灰度期。"""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization[7:]
    try:
        payload = decode_token(token)
        if payload.get("type") != "access":
            return None
        user_id = int(payload["sub"])
        async with session_scope() as s:
            user = await s.get(User, user_id)
            if not user or user.status != "active":
                return None
            # 确保session外可访问
            _ = user.username
            _ = user.role
            try:
                from ..factory.usage import set_usage_user
                set_usage_user(user.id)
            except Exception:  # noqa: BLE001
                pass
            return user
    except JWTError:
        return None
    except Exception as e:
        logger.warning(f"auth optional error: {e}")
        return None


async def get_current_user(authorization: str | None = Header(None)) -> User:
    """强制认证:无token或token无效抛401。

    注意: authorization 用 Header(None) 而非 Header(...), 这样"完全缺失请求头"时
    也走到下面的 401 分支 (而不是 FastAPI 默认的 422)。前端 authFetch 依赖 401 来
    触发清 token + 跳登录; 若返回 422 会卡在错误提示、无法自动重新登录。
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "缺少认证token")
    token = authorization[7:]
    try:
        payload = decode_token(token)
    except JWTError as e:
        raise HTTPException(401, f"token无效: {e}")
    if payload.get("type") != "access":
        raise HTTPException(401, "token类型错误")
    user_id = int(payload["sub"])
    async with session_scope() as s:
        user = await s.get(User, user_id)
        if not user:
            raise HTTPException(401, "用户不存在")
        if user.status != "active":
            raise HTTPException(403, f"账号状态异常: {user.status}")
        # 强制加载字段
        _ = user.username
        _ = user.role
        _ = user.display_name
        # 把 user_id 塞进用量上下文: 本请求内(以及由它 create_task 出去的后台协程)
        # 发生的每一次 LLM 调用都会带上归属。放在这里是因为它是**唯一**的鉴权入口,
        # 43 个路由文件共用 —— 逐个路由去 set 必然漏。
        # contextvars 在 async 依赖与端点之间同任务传递, 且 create_task 会复制当前
        # 上下文, 故后台任务也能继承。
        try:
            from ..factory.usage import set_usage_user
            set_usage_user(user.id)
        except Exception as e:  # noqa: BLE001 - 记账永远不能挡住登录
            logger.debug(f"set_usage_user failed (ignored): {e}")
        return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    """要求管理员权限"""
    if user.role not in ("admin", "superadmin"):
        raise HTTPException(403, "需要管理员权限")
    return user


def user_has_feature(user: User, feature: str) -> bool:
    """判断用户是否有某功能权限: admin/superadmin 默认全通; 普通用户看 feature_flags 白名单。"""
    if user.role in ("admin", "superadmin"):
        return True
    flags = getattr(user, "feature_flags", None) or {}
    return bool(flags.get(feature))


async def require_novel_video(user: User = Depends(get_current_user)) -> User:
    """要求"小说转视频"权限: 管理员, 或被管理员在 feature_flags.novel_video 授权的普通用户。"""
    if not user_has_feature(user, "novel_video"):
        raise HTTPException(403, "无小说转视频权限, 请联系管理员开通")
    return user
