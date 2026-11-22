"""Async SQLAlchemy engine + session factory."""
from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from ..config import get_settings
from .models import Base


def _to_async_url(url: str) -> str:
    # postgresql+psycopg:// -> postgresql+psycopg_async:// ;
    # psycopg 3 supports async natively via "postgresql+psycopg"
    return url


_settings = get_settings()

# 连接池大小: 主库 max_connections=100 是所有进程共享的。
#   web(orchestrator) 用大池(20+40=60)扛用户并发;
#   每台弹性算力 worker(ROLE=worker) 单任务串行, 只需极小池 —— 否则 web+多 worker 各持 60 会冲破 100,
#   报 "too many clients already"(报错端口 15433 = worker 经 SSH 隧道连主库)。
# DB_POOL_SIZE / DB_MAX_OVERFLOW 环境变量优先; 未显式设置且 ROLE=worker 时自动降到 3+5。
_is_worker = os.getenv("ROLE", "").strip().lower() == "worker"
_env_pool = os.getenv("DB_POOL_SIZE")
_env_overflow = os.getenv("DB_MAX_OVERFLOW")
if _env_pool is not None:
    _pool_size = int(_env_pool)
elif _is_worker:
    _pool_size = 3
else:
    _pool_size = _settings.db_pool_size
if _env_overflow is not None:
    _max_overflow = int(_env_overflow)
elif _is_worker:
    _max_overflow = 5
else:
    _max_overflow = _settings.db_max_overflow

# pre_ping 防止拿到已被 PG 关闭的死连接; recycle 定期回收避免长连接失效。
engine = create_async_engine(
    _to_async_url(_settings.database_url),
    echo=False,
    future=True,
    pool_size=_pool_size,
    max_overflow=_max_overflow,
    pool_timeout=_settings.db_pool_timeout,
    pool_pre_ping=True,
    pool_recycle=_settings.db_pool_recycle,
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def init_db() -> None:
    """启动时创建表（M2 简化，M3 改 Alembic migration）。"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as s:
        try:
            yield s
            await s.commit()
        except Exception:
            await s.rollback()
            raise


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI Depends 用的 session 获取函数"""
    async with SessionLocal() as s:
        try:
            yield s
            await s.commit()
        except Exception:
            await s.rollback()
            raise
