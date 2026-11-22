"""整本 AI 精修模块: 两轮同上下文全局重写 + 格式无损拆回覆写。"""
from .routes import router as rewrite_router

__all__ = ["rewrite_router"]