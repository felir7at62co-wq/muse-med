"""请求超时中间件。"""
from __future__ import annotations

import asyncio

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from ..config import get_settings


# 长任务接口豁免全局超时: 这些接口的语义是"接收大文件/视频 → 上传+切分+入库 →
# 立即返回, 反推在后台异步进行"。大视频上传与服务端切分本身就可能超过 300s,
# 若被全局 TimeoutMiddleware 掐断会返回 504 "Request timed out after 300s",
# 但后台任务其实仍在跑 —— 属于误杀。这里按路径前缀豁免, 让它们不受 300s 限制。
_TIMEOUT_EXEMPT_PREFIXES = (
    "/v1/clip/assets/upload",          # 短视频资产库: 上传(单/多个)
    "/v1/clip/assets/admin/upload-folder",  # 资产库: 批量文件夹上传
    "/v1/video/upload",                # 视频反推剧本: 多集视频上传
)
# reprocess 是 /v1/clip/assets/{id}/reprocess, 用包含匹配单独处理


def _is_exempt(path: str) -> bool:
    if path.startswith(_TIMEOUT_EXEMPT_PREFIXES):
        return True
    # 资产重跑反推: /v1/clip/assets/<id>/reprocess
    if path.startswith("/v1/clip/assets/") and path.endswith("/reprocess"):
        return True
    return False


class TimeoutMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # 长任务(大文件上传/切分)接口豁免全局超时, 避免误杀仍在后台跑的任务
        if _is_exempt(request.url.path):
            return await call_next(request)

        timeout = get_settings().generate_timeout
        try:
            return await asyncio.wait_for(call_next(request), timeout=timeout)
        except asyncio.TimeoutError:
            return JSONResponse(
                status_code=504,
                content={"detail": f"Request timed out after {timeout}s"},
            )
