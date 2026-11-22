"""阿里云 OSS 大文件直传模块。

设计原则:
1. AK/SK 不出后端,浏览器只拿一次性预签名 URL
2. 服务端用内网 endpoint 读 OSS (免流量费,延迟低)
3. 给浏览器签名时用公网 endpoint
4. key 由后端生成,防止恶意覆盖

用法:
- 路由注册: from .oss.routes import router as oss_router
- 业务调用: from .oss.service import (
        get_session, complete_session, abort_session,
        oss_download_to_local, oss_object_url,
    )
"""
from .routes import router

__all__ = ["router"]
