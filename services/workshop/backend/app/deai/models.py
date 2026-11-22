"""去 AI 味作业表。DeaiJob 直接定义在 db.models 中(与 PolishJob 同处), 此处仅 re-export。"""
from __future__ import annotations

from ..db.models import DeaiJob  # noqa: F401