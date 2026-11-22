"""Alembic 迁移环境。

设计要点 (与本项目的安全红线一致):
- 迁移只负责数据库 schema, 绝不触碰 uploads/ 等磁盘文件。
- 连接串从环境变量 DATABASE_URL 读取, 强制转同步驱动 (psycopg), 避免
  误用异步驱动; 也避免把连接串硬编码进文件而误连错库。
- 导入所有 model 模块, 让 autogenerate 能看到全部表 (否则会误判"要删表")。
"""
from __future__ import annotations

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

# ── 导入 Base 和全部 models, 确保 metadata 注册齐全 ──────────────────
from app.db.models import Base  # noqa: E402
import app.db.models  # noqa: E402,F401
import app.db.models_phase5  # noqa: E402,F401
import app.auth.models  # noqa: E402,F401
import app.billing.models  # noqa: E402,F401
import app.feedback.models  # noqa: E402,F401
import app.image_studio.models  # noqa: E402,F401
import app.draft_image.models  # noqa: E402,F401
import app.audio_studio.models  # noqa: E402,F401
import app.critique.models  # noqa: E402,F401
import app.novel_video.models  # noqa: E402,F401

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _sync_db_url() -> str:
    """取 DATABASE_URL 并转成同步驱动 (alembic 用同步连接)。"""
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        raise RuntimeError("DATABASE_URL 未设置, 拒绝运行迁移 (避免误连)")
    # postgresql+asyncpg / postgresql+psycopg (async) → 同步 psycopg
    url = url.replace("+asyncpg", "+psycopg")
    # 已是 +psycopg 的 async url, SQLAlchemy 同步引擎也能用 psycopg3 驱动
    return url


def run_migrations_offline() -> None:
    context.configure(
        url=_sync_db_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
        compare_server_default=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = _sync_db_url()
    connectable = engine_from_config(
        section,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()