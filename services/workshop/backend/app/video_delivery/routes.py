"""视频交付 API 路由"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
import httpx

from ..auth.dependencies import get_current_user
from ..auth.models import User
from ..db.session import get_session
from . import service

router = APIRouter(prefix="/v1/video-delivery", tags=["video-delivery"])


class LogDownloadRequest(BaseModel):
    """批量下载请求"""

    job_ids: list[int]
    channel: str | None = None  # web/desktop/script


class TagRequest(BaseModel):
    """批量打/取消标签请求"""

    job_ids: list[int]
    tag: str


@router.get("/list")
async def list_videos(
    page: int = 1,
    page_size: int = 20,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    keyword: str | None = None,
    source: str | None = None,
    download_status: str | None = None,   # all|not_downloaded|downloaded_by_me|downloaded_by_others
    tag: str | None = None,               # 按标签筛; __untagged__=无标签
    sort: str | None = None,              # latest|most_downloaded|duration|oldest
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """查询可交付视频列表（需登录）"""
    return await service.list_videos(
        session,
        page=page,
        page_size=page_size,
        start_date=start_date,
        end_date=end_date,
        keyword=keyword,
        source=source,
        user=user,
        download_status=download_status,
        tag=tag,
        sort=sort,
    )


@router.post("/tags")
async def add_tags(
    req: TagRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """批量打标签(全局共享, 幂等)。返回新增条数。"""
    added = await service.add_tags(session, job_ids=req.job_ids, tag=req.tag, user=user)
    return {"added": added}


@router.delete("/tags")
async def remove_tags(
    req: TagRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """批量取消标签。返回删除条数。"""
    removed = await service.remove_tags(session, job_ids=req.job_ids, tag=req.tag)
    return {"removed": removed}


@router.get("/tags/presets")
async def tag_presets(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """标签下拉列表: 预置 + 已用过的自定义标签。"""
    return {"tags": await service.list_tag_presets(session)}


@router.get("/download/{job_id}")
async def download_video(
    job_id: int,
    token: str | None = None,
    session: AsyncSession = Depends(get_session),
):
    """下载单个视频(302重定向到CDN+Content-Disposition,支持token query参数)"""
    from fastapi.responses import RedirectResponse
    from urllib.parse import quote
    from ..auth.jwt_helper import decode_token
    from sqlalchemy import select
    
    # 支持token query参数(window.open不带Authorization头)
    if not token:
        raise HTTPException(401, "缺少认证token")
    
    try:
        payload = decode_token(token)
        user_id = int(payload["sub"])
        result = await session.execute(select(User).filter(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(401, "用户不存在")
    except Exception as e:
        raise HTTPException(401, f"Token无效: {str(e)}")
    
    job = await service.get_job_by_id(session, job_id)
    if not job or not job.get("video_url"):
        raise HTTPException(404, "视频不存在")
    
    # 记录下载
    from .models import VideoDownloadLog
    log = VideoDownloadLog(job_id=job_id, user_id=user.id)
    session.add(log)
    await session.commit()
    
    # 302重定向到CDN,文件名通过Content-Disposition设置
    title = job["title"]
    cdn_url = job["video_url"]
    
    response = RedirectResponse(url=cdn_url, status_code=302)
    disposition = f"attachment; filename*=UTF-8''{quote(title)}.mp4"
    response.headers["Content-Disposition"] = disposition
    return response


@router.post("/log-download")
async def log_download(
    req: LogDownloadRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """批量记录下载统计并返回CDN链接（需登录）"""
    links = await service.log_downloads(session, job_ids=req.job_ids, user=user)
    return {"links": links}


@router.get("/stats")
async def get_stats(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """获取下载统计（需登录）"""
    return await service.get_download_stats(session)


@router.get("/export-mapping")
async def export_mapping(
    session: AsyncSession = Depends(get_session),
):
    """导出文件名映射JSON(用于重命名脚本,公开endpoint无需认证)"""
    from fastapi.responses import JSONResponse
    from urllib.parse import urlparse
    
    videos = await service.list_videos(session, page=1, page_size=10000)
    
    mappings = []
    for video in videos["items"]:
        # 从CDN URL提取文件名
        url_path = urlparse(video["cdn_url"]).path  # 修复:字段名是cdn_url不是video_url
        filename = url_path.split('/')[-1].split('?')[0]
        
        mappings.append({
            "filename": filename,
            "title": video["title"],
            "job_id": video["id"]
        })
    
    return JSONResponse(
        content=mappings,
        headers={
            "Content-Disposition": "attachment; filename=mapping.json"
        }
    )


@router.get("/export-download-list")
async def export_download_list(
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    keyword: str | None = None,
    source: str | None = None,
    session: AsyncSession = Depends(get_session),
):
    """导出筛选后全部视频的下载清单(公开endpoint,供批量下载脚本使用)

    支持与/list相同的筛选参数(start_date/end_date/keyword/source),
    但不分页,返回全部匹配结果,用于命令行脚本批量下载。
    """
    from fastapi.responses import JSONResponse

    result = await service.list_videos(
        session,
        page=1,
        page_size=100000,
        start_date=start_date,
        end_date=end_date,
        keyword=keyword,
        source=source,
    )
    items = [
        {"id": v["id"], "title": v["title"], "cdn_url": v["cdn_url"]}
        for v in result["items"]
    ]
    return JSONResponse(content={"total": result["total"], "items": items})


@router.get("/delivery-list")
async def delivery_list(
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    keyword: str | None = None,
    source: str | None = None,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """桌面下载器专用: 鉴权版全量交付清单(需登录)

    与 export-download-list 等价, 但强制 Bearer token 鉴权,
    可把下载行为归属到具体用户。供 Tauri 桌面下载器拉取清单使用。
    支持与 /list 相同的筛选参数, 不分页返回全部匹配结果。
    """
    result = await service.list_videos(
        session,
        page=1,
        page_size=100000,
        start_date=start_date,
        end_date=end_date,
        keyword=keyword,
        source=source,
    )
    items = [
        {
            "id": v["id"],
            "title": v["title"],
            "original_title": v.get("original_title"),
            "cdn_url": v["cdn_url"],
            "source": v["source"],
            "created_at": v["created_at"],
            "updated_at": v.get("updated_at"),
            "duration": v.get("duration", 0),
            "feishu_record_id": v.get("feishu_record_id"),
            "download_count": v["download_count"],
        }
        for v in result["items"]
    ]
    return {"total": result["total"], "items": items}


@router.get("/download-redirect/{job_id}")
async def download_redirect(
    job_id: int,
    token: str | None = None,
    session: AsyncSession = Depends(get_session),
):
    """
    302重定向到CDN: 前端用<a download>触发, 浏览器跟随302到CDN直连下载
    避免后端代理瓶颈, 实现CDN满速下载 + 自动触发下载
    """
    from fastapi import HTTPException
    from fastapi.responses import RedirectResponse
    from ..auth.jwt_helper import decode_token
    from ..auth.models import User
    from sqlalchemy import select
    
    if not token:
        raise HTTPException(401, "未登录")
    
    try:
        payload = decode_token(token)
        user_id = int(payload["sub"])
        result = await session.execute(select(User).filter(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(401, "用户不存在")
    except Exception as e:
        raise HTTPException(401, f"Token无效: {str(e)}")
    
    job_dict = await service.get_job_by_id(session, job_id)
    if not job_dict or not job_dict.get("video_url"):
        raise HTTPException(404, "视频不存在")

    # 记录下载
    await service.log_downloads(session, job_ids=[job_id], user=user)

    # 302重定向到CDN, 浏览器直连CDN满速下载
    return RedirectResponse(url=job_dict["video_url"], status_code=302)


@router.get("/download-proxy/{job_id}")
async def download_proxy(
    job_id: int,
    token: str | None = None,
    session: AsyncSession = Depends(get_session),
):
    """
    代理下载: 从CDN流式拉取并添加Content-Disposition头, 解决跨域download失效
    适用于大文件下载, 浏览器原生下载器接管, 避免前端fetch整个blob(485MB)导致卡死
    支持token query参数认证(window.open不带Authorization头)
    """
    from fastapi import HTTPException
    from ..auth.jwt_helper import decode_token
    from ..auth.models import User
    from sqlalchemy import select
    
    # 只支持 token query 参数(window.open场景)
    if not token:
        raise HTTPException(401, "未登录")
    
    try:
        payload = decode_token(token)
        user_id = int(payload["sub"])
        result = await session.execute(select(User).filter(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(401, "用户不存在")
    except Exception as e:
        raise HTTPException(401, f"Token无效: {str(e)}")
    
    job_dict = await service.get_job_by_id(session, job_id)
    if not job_dict or not job_dict.get("video_url"):
        raise HTTPException(404, "视频不存在")

    # 记录下载
    await service.log_downloads(session, job_ids=[job_id], user=user)

    # HEAD请求获取Content-Length，浏览器需要它来显示进度条
    async with httpx.AsyncClient(timeout=30.0) as client:
        head_response = await client.head(job_dict["video_url"])
        content_length = head_response.headers.get("Content-Length")
    
    # 流式代理
    async def stream_from_cdn():
        async with httpx.AsyncClient(timeout=600.0) as client:
            async with client.stream("GET", job_dict["video_url"]) as response:
                async for chunk in response.aiter_bytes(chunk_size=65536):
                    yield chunk

    # URL编码中文文件名+Content-Length让浏览器显示进度条
    from urllib.parse import quote
    title_safe = quote(job_dict['title'])
    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{title_safe}.mp4",
    }
    if content_length:
        headers["Content-Length"] = content_length
    
    return StreamingResponse(
        stream_from_cdn(),
        media_type="video/mp4",
        headers=headers,
    )
