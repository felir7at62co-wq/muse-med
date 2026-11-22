"""去 AI 味工作室(De-AI-Taste Studio)。

对整部剧本逐集: 检测 AI 味 → LLM 去味改写 → 注入人味瑕疵 → 写回。
仅管理员可用(路由层校验 role)。
"""
from .routes import router as deai_router  # noqa: F401