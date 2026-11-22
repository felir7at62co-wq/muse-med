"""narrative — 叙事健康度: 事件时间轴 + 实体负荷检测。

见 docs/PLAN-叙事健康度-时间轴与实体负荷.md。
复用 stages.state_ledger 的 by_episode 事件数据, 零新表。
"""
from .routes import router as narrative_router

__all__ = ["narrative_router"]