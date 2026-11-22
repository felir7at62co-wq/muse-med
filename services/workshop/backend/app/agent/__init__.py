"""Agent 助手浮窗模块。

提供全局对话窗口的后端能力:
- 会话/消息持久化 (DB)
- 上下文感知 (草稿信息自动注入)
- SSE 流式响应 (基于 LangChain ChatOpenAI streaming)

入口: routes.py 暴露 /v1/agent/* 路由
"""
from .routes import router

__all__ = ["router"]
