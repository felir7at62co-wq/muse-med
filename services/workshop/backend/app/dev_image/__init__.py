"""临时模块: dev 环境下 UI 设计稿示意图批量生成 (gpt-image-2).

仅用于内部 UI 重构期可视化对比, 不进入生产路由.
"""
from .routes import design_router, router

__all__ = ["router", "design_router"]
