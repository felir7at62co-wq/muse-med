"""创建计费表 image_billing (幂等)。

用法 (容器内):
  python scripts/migrate_billing.py
"""
from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db import engine

DDL = [
    """
    CREATE TABLE IF NOT EXISTS image_billing (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL UNIQUE REFERENCES image_jobs(id),
        user_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        model TEXT NOT NULL,
        unit TEXT NOT NULL,
        quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
        unit_price DOUBLE PRECISION NOT NULL DEFAULT 0,
        amount DOUBLE PRECISION NOT NULL DEFAULT 0,
        detail JSONB,
        created_at TIMESTAMP DEFAULT now()
    );
    """,
    "CREATE INDEX IF NOT EXISTS ix_image_billing_user_id ON image_billing (user_id);",
    "CREATE INDEX IF NOT EXISTS ix_image_billing_job_id ON image_billing (job_id);",
    "CREATE INDEX IF NOT EXISTS ix_image_billing_amount ON image_billing (amount);",
    "CREATE INDEX IF NOT EXISTS ix_image_billing_created_at ON image_billing (created_at);",
]


async def main() -> None:
    async with engine.begin() as conn:
        for stmt in DDL:
            await conn.exec_driver_sql(stmt)
    print("billing migration done: image_billing ready")


if __name__ == "__main__":
    asyncio.run(main())