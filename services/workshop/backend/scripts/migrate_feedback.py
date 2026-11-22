"""创建用户反馈表 user_feedback (幂等)。

用法 (容器内):
  python scripts/migrate_feedback.py
"""
from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db import engine

DDL = [
    """
    CREATE TABLE IF NOT EXISTS user_feedback (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        username VARCHAR(64),
        display_name VARCHAR(64),
        content TEXT NOT NULL,
        page_url TEXT,
        status VARCHAR(16) NOT NULL DEFAULT 'new',
        created_at TIMESTAMP DEFAULT now()
    );
    """,
    "CREATE INDEX IF NOT EXISTS ix_user_feedback_user_id ON user_feedback (user_id);",
    "CREATE INDEX IF NOT EXISTS ix_user_feedback_status ON user_feedback (status);",
    "CREATE INDEX IF NOT EXISTS ix_user_feedback_created_at ON user_feedback (created_at);",
]


async def main() -> None:
    async with engine.begin() as conn:
        for stmt in DDL:
            await conn.exec_driver_sql(stmt)
    print("feedback migration done: user_feedback ready")


if __name__ == "__main__":
    asyncio.run(main())