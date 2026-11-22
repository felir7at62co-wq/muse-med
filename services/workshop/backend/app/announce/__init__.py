"""公告群发（飞书私信）。

对外只有 service 里那几个函数；HTTP 入口挂在 admin 路由
（`/v1/admin-api/announcements/*`），因为发公告是管理员动作。
"""
from . import service  # noqa: F401
