"""从 DB 加载激活的风格模块。"""
from __future__ import annotations

from typing import Any
from sqlalchemy import select

from ..db import StyleModule, session_scope


async def load_active_modules() -> list[dict[str, Any]]:
    async with session_scope() as s:
        rows = (
            (await s.execute(select(StyleModule).where(StyleModule.is_active == 1)))
            .scalars()
            .all()
        )
        return [
            {
                "id": r.id,
                "name": r.name,
                "tags": r.tags or [],
                "keywords": r.keywords or [],
                "language": r.language or "",
                "scenes": r.scenes or "",
                "weight": float(r.weight or 1.0),
            }
            for r in rows
        ]
