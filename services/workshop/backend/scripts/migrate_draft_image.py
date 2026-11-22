"""创建草稿生图版块所需 4 张表 (幂等, IF NOT EXISTS)。

用法 (容器内):
  python scripts/migrate_draft_image.py
"""
from __future__ import annotations

import asyncio
import os
import sys

# 允许 `python scripts/migrate_draft_image.py` 直接运行 (把项目根加入 path)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db import engine

DDL = [
    """
    CREATE TABLE IF NOT EXISTS draft_characters (
        id SERIAL PRIMARY KEY,
        draft_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT now()
    );
    """,
    "CREATE INDEX IF NOT EXISTS ix_draft_characters_draft_id ON draft_characters (draft_id);",
    """
    CREATE TABLE IF NOT EXISTS draft_character_images (
        id SERIAL PRIMARY KEY,
        character_id INTEGER NOT NULL REFERENCES draft_characters(id),
        oss_key TEXT NOT NULL,
        episodes JSONB,
        seq INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT now()
    );
    """,
    "CREATE INDEX IF NOT EXISTS ix_draft_character_images_character_id ON draft_character_images (character_id);",
    """
    CREATE TABLE IF NOT EXISTS draft_episode_image_config (
        id SERIAL PRIMARY KEY,
        draft_id INTEGER NOT NULL,
        chapter_order INTEGER NOT NULL,
        mode TEXT NOT NULL DEFAULT 'single',
        updated_at TIMESTAMP DEFAULT now()
    );
    """,
    "CREATE INDEX IF NOT EXISTS ix_draft_episode_image_config_draft_id ON draft_episode_image_config (draft_id);",
    """
    CREATE TABLE IF NOT EXISTS draft_image_tasks (
        id SERIAL PRIMARY KEY,
        draft_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        chapter_order INTEGER NOT NULL,
        mode TEXT NOT NULL DEFAULT 'single',
        group_index INTEGER DEFAULT 0,
        shot_indexes JSONB NOT NULL,
        image_prompt TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        progress INTEGER DEFAULT 0,
        error TEXT,
        model TEXT,
        size TEXT,
        ref_image_keys JSONB,
        result_keys JSONB,
        created_at TIMESTAMP DEFAULT now(),
        updated_at TIMESTAMP DEFAULT now()
    );
    """,
    "CREATE INDEX IF NOT EXISTS ix_draft_image_tasks_draft_id ON draft_image_tasks (draft_id);",
    "CREATE INDEX IF NOT EXISTS ix_draft_image_tasks_user_id ON draft_image_tasks (user_id);",
    # ref_labels: 与 ref_image_keys 同序的角色名, 生成时隐式替换为 图1..图N (image_prompt 仍存原文)
    "ALTER TABLE draft_image_tasks ADD COLUMN IF NOT EXISTS ref_labels JSONB;",
]


async def main() -> None:
    async with engine.begin() as conn:
        for stmt in DDL:
            await conn.exec_driver_sql(stmt)
    print("draft_image migration done: 4 tables ready")


if __name__ == "__main__":
    asyncio.run(main())