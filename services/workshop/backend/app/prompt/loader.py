"""Prompt 数据库加载器：按 stage 取当前激活的模板。

M2：DB 优先，fallback 到 composer._META_SYSTEM_BASE。
"""
from __future__ import annotations

from sqlalchemy import select

from ..db import Prompt, session_scope


async def load_active_template(stage: str) -> str | None:
    async with session_scope() as s:
        stmt = (
            select(Prompt)
            .where(Prompt.stage == stage, Prompt.is_active == 1)
            .order_by(Prompt.version.desc())
            .limit(1)
        )
        row = (await s.execute(stmt)).scalar_one_or_none()
        return row.template if row else None
