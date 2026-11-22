"""功能完善模块"""
from .assets_routes import router as assets_router
from .user_features_routes import router as user_features_router
from .admin_analytics_routes import router as analytics_router
from .theme_routes import router as theme_router, admin_router as theme_admin_router, public_router as theme_public_router
from .preview_routes import router as preview_router
from .video_routes import router as video_router
from .overview_routes import router as overview_router
from .phase5_routes import router as phase5_router

__all__ = ["assets_router", "user_features_router", "analytics_router",
           "theme_router", "theme_admin_router", "theme_public_router", "preview_router",
           "video_router", "overview_router", "phase5_router"]
