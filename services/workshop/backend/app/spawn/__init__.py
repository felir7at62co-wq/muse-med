"""DNA 裂变工厂: 从一部原作提取「爆款 DNA」, 据此批量裂变出 N 个各具新意的完整新作。

对外暴露:
  - router: FastAPI 路由 (/v1/spawn)
  - SpawnJob: 裂变作业 ORM (触发 create_all 建表)
"""
from .models import SpawnJob  # noqa: F401
from .routes import router  # noqa: F401

__all__ = ["SpawnJob", "router"]