"""对话工坊体检 / 定点修复模块。

  engine.py   四类体检(结构/文风/一致性/剧本) —— 规则层零 LLM, LLM 层只出 warn
  fixer.py    按 issue_id 定点修复(最小改动 + 往返校验 + 修后复检)
  prompts.py  体检与修复的 prompt
  routes.py   /v1/check 三个入口
"""
from .routes import router as check_router

__all__ = ["check_router"]
