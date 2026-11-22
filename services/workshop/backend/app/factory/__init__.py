"""Factory 模块

内容裂变工厂模块，提供：
- 数据模型 (FactoryJob, FactoryProduct, FactoryStats)
- API 路由 (router)
"""
from .models import FactoryJob, FactoryProduct, FactoryStats
from .routes import router

__all__ = ['FactoryJob', 'FactoryProduct', 'FactoryStats', 'router']
