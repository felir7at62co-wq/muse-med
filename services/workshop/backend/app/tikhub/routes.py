"""TikHub 对前端暴露的 API。

前缀 /v1/tikhub, 全员可用(登录即可, 不限额, 仅统计用量)。
- 检索: /search/videos
- 解析: /resolve  (分享链接→视频详情)
- 下载入库: /download  (解析→下载视频→进短视频资产库→自动分段反推)
- 评论: /comments
- 热榜聚合: /boards
- 账户信息: /account
- 用量统计: /usage/me (个人), /usage/summary (管理员总览)
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select

from ..auth import User, get_current_user, require_admin
from ..config import get_settings
from ..db import session_scope
from . import service
from .client import TikHubError
from .models import TikHubUsage

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/v1/tikhub", tags=["tikhub"])


# ---------- 平台清单 ----------
@router.get("/platforms")
async def platforms(_: User = Depends(get_current_user)):
    from .platforms import SUPPORTED_PLATFORMS
    return {"platforms": SUPPORTED_PLATFORMS}


# ---------- 检索(多平台) ----------
@router.get("/search/videos")
async def search_videos(
    keyword: str = Query(..., min_length=1),
    platform: str = Query("douyin", description="douyin/tiktok/kuaishou/xiaohongshu"),
    sort_type: str = Query("0", description="0综合 1最多点赞 2最新(仅抖音)"),
    publish_time: str = Query("0", description="0不限 1一天 7一周 180半年(仅抖音)"),
    filter_duration: str = Query("0"),
    cursor: int = Query(0),
    user: User = Depends(get_current_user),
):
    try:
        if platform.lower() == "douyin":
            return await service.search_videos(
                keyword, sort_type=sort_type, publish_time=publish_time,
                filter_duration=filter_duration, cursor=cursor, user_id=user.id,
            )
        from . import platforms as plat
        return await plat.search(platform, keyword, user_id=user.id)
    except TikHubError as e:
        raise HTTPException(status_code=502, detail=str(e))


# ---------- 短剧合集: 按 series_id 拉全部集 ----------
@router.get("/series/videos")
async def series_videos(
    series_id: str = Query(..., min_length=1),
    user: User = Depends(get_current_user),
):
    """按抖音短剧 series_id 拉整部剧的所有集(权威入口, 召回全)。"""
    try:
        return await service.list_series_episodes(series_id, user_id=user.id)
    except TikHubError as e:
        raise HTTPException(status_code=502, detail=str(e))


# ---------- 解析分享链接 ----------
class ResolveIn(BaseModel):
    share_url: str


@router.post("/resolve")
async def resolve(payload: ResolveIn, user: User = Depends(get_current_user)):
    try:
        return await service.resolve_share_url(payload.share_url, user_id=user.id)
    except TikHubError as e:
        raise HTTPException(status_code=502, detail=str(e))


# ---------- 下载入库(解析→下载→进资产库→自动反推) ----------
class DownloadIn(BaseModel):
    share_url: Optional[str] = None   # 二选一: 分享链接
    aweme_id: Optional[str] = None    # 或作品ID
    is_public: bool = False
    category: str = "抖音下载"
    mode: str = "reverse"             # reverse=入资产库反推; draft=建草稿反推


# ---------- 仅获取无水印下载地址(下载到本地用, 不入库) ----------
class LocalUrlIn(BaseModel):
    share_url: Optional[str] = None
    aweme_id: Optional[str] = None


@router.post("/download-url")
async def get_download_url(payload: LocalUrlIn, user: User = Depends(get_current_user)):
    if not payload.share_url and not payload.aweme_id:
        raise HTTPException(status_code=400, detail="需要 share_url 或 aweme_id 之一")
    try:
        if payload.share_url:
            video = await service.resolve_share_url(payload.share_url, user_id=user.id)
        else:
            video = await service.get_video_detail(payload.aweme_id, user_id=user.id)
        aid = video.get("aweme_id")
        if not aid:
            raise HTTPException(status_code=404, detail="未解析到有效视频")
        url = await service.get_play_url(aid, user_id=user.id) or video.get("play_url")
        if not url:
            raise HTTPException(status_code=502, detail="未取得可下载地址")
        title = (video.get("desc") or f"douyin_{aid}")[:60]
        return {"ok": True, "download_url": url, "filename": f"{title}.mp4", "aweme_id": aid}
    except TikHubError as e:
        raise HTTPException(status_code=502, detail=str(e))


async def _download_and_ingest(video: dict, *, user_id: int, is_public: bool, category: str) -> Optional[int]:
    """下载视频 bytes → 存资产库 → 自动分段反推。返回 asset_id。"""
    from ..clip import asset_service as clip_svc

    aweme_id = video.get("aweme_id") or "douyin"
    play_url = await service.get_play_url(aweme_id, user_id=user_id)
    if not play_url:
        play_url = video.get("play_url")
    if not play_url:
        raise TikHubError("未能取得可下载的视频地址")

    # 下载视频字节(抖音 CDN, 带常见 UA)
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as cli:
        r = await cli.get(play_url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.douyin.com/"})
        r.raise_for_status()
        content = r.content

    title = (video.get("desc") or f"抖音视频_{aweme_id}")[:60]
    asset_id = await clip_svc.save_upload_and_enqueue(
        file_bytes=content,
        filename=f"{title or aweme_id}.mp4",
        user_id=user_id,
        is_public=is_public,
        category=category,
    )
    return asset_id


@router.post("/download")
async def download(payload: DownloadIn, user: User = Depends(get_current_user)):
    if payload.mode == "draft":
        from ..reverse_routes import require_reverse
        require_reverse()
    if not payload.share_url and not payload.aweme_id:
        raise HTTPException(status_code=400, detail="需要 share_url 或 aweme_id 之一")
    try:
        if payload.share_url:
            video = await service.resolve_share_url(payload.share_url, user_id=user.id)
        else:
            video = await service.get_video_detail(payload.aweme_id, user_id=user.id)
        if not video.get("aweme_id"):
            raise HTTPException(status_code=404, detail="未解析到有效视频")

        # mode=draft: 走"视频反推剧本"链路, 创建一个草稿(和视频反推页一致)
        if payload.mode == "draft":
            draft_id = await _download_to_draft(video, user_id=user.id)
            return {"ok": True, "draft_id": draft_id, "video": video,
                    "message": "已创建草稿并开始反推, 可在草稿页查看进度"}

        # mode=reverse(默认): 进短视频资产库 + 反推
        asset_id = await _download_and_ingest(
            video, user_id=user.id, is_public=payload.is_public, category=payload.category,
        )
        return {"ok": True, "asset_id": asset_id, "video": video,
                "message": "已下载入库, 正在后台反推(分段并发+提示词优化), 稍后可在资产库查看"}
    except TikHubError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"下载视频失败: {e}")


async def _download_to_draft(video: dict, *, user_id: int) -> int:
    """把抖音视频交给'视频反推剧本'链路: 建 ScriptDraft + 后台下载→切分→反推。返回 draft_id。"""
    import asyncio
    import time as _time
    import uuid as _uuid
    from pathlib import Path
    from ..db import ScriptDraft, session_scope
    from ..features.video_routes import VIDEO_TMP_DIR
    from ..video import run_video_to_script_pipeline
    from ..video.splitter import split_videos_for_upload

    aweme_id = video.get("aweme_id")
    title = (video.get("desc") or f"抖音短剧_{aweme_id}")[:40]

    async with session_scope() as s:
        row = ScriptDraft(
            user_id=user_id,
            session_id=f"douyin_{aweme_id}_{_uuid.uuid4().hex[:6]}",
            title=title or "抖音视频反推中…",
            user_input="(从抖音视频反推的剧本)",
            model_provider="gemini",
            episode_count=1,
            status="video_running",
            outline={"title": title, "synopsis": "正在下载抖音视频, 完成后开始反推…",
                     "characters": [], "chapters": [], "character_mapping": {},
                     "source": "douyin", "aweme_id": aweme_id},
            outline_locked=0,
        )
        s.add(row)
        await s.flush()
        draft_id = row.id

    async def _run():
        from ..stages.log_helper import save_log
        batch_dir = VIDEO_TMP_DIR / f"douyin_{aweme_id}_{_uuid.uuid4().hex[:6]}"
        batch_dir.mkdir(parents=True, exist_ok=True)
        try:
            await save_log(draft_id, "video_ingest", "开始下载抖音视频…", "log", 0)
            play_url = await service.get_play_url(aweme_id, user_id=user_id) or video.get("play_url")
            if not play_url:
                raise RuntimeError("未取得可下载地址")
            dst = batch_dir / "ep_001.mp4"
            async with httpx.AsyncClient(timeout=120, follow_redirects=True) as cli:
                r = await cli.get(play_url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.douyin.com/"})
                r.raise_for_status()
                dst.write_bytes(r.content)
            await save_log(draft_id, "video_ingest", "下载完成, 开始切分+反推…", "log", 1)
            split_result = await split_videos_for_upload([(1, str(dst))], batch_dir / "splits")
            final_paths = [p for _, p, _ in split_result]
            async with session_scope() as s2:
                d = await s2.get(ScriptDraft, draft_id)
                if d:
                    d.episode_count = len(final_paths)
            await run_video_to_script_pipeline(
                draft_id=draft_id, video_paths=final_paths, draft_title=title,
                model="", concurrency=1, cleanup_files=True, user_id=user_id,
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("抖音反推草稿失败: %s", e)
            try:
                await save_log(draft_id, "video_ingest", f"反推失败: {e}", "error", 0)
                async with session_scope() as s3:
                    d = await s3.get(ScriptDraft, draft_id)
                    if d:
                        d.status = "draft"
            except Exception:
                pass
        finally:
            try:
                import shutil
                if batch_dir.is_dir() and not any(batch_dir.iterdir()):
                    batch_dir.rmdir()
            except Exception:
                pass

    asyncio.create_task(_run())
    return draft_id


# ---------- 评论 ----------
@router.get("/comments")
async def comments(
    aweme_id: str = Query(...),
    cursor: int = Query(0),
    count: int = Query(20, le=50),
    user: User = Depends(get_current_user),
):
    try:
        return await service.get_comments(aweme_id, cursor=cursor, count=count, user_id=user.id)
    except TikHubError as e:
        raise HTTPException(status_code=502, detail=str(e))


# ---------- 热榜聚合(市场数据面板) ----------
@router.get("/boards")
async def boards(user: User = Depends(get_current_user)):
    try:
        return await service.get_hot_boards(user_id=user.id)
    except TikHubError as e:
        raise HTTPException(status_code=502, detail=str(e))


# ---------- 账户/健康 ----------
@router.get("/account")
async def account(user: User = Depends(get_current_user)):
    try:
        data = await service.get_account_usage()
        return {"ok": True, "api_key_name": (data.get("api_key_data") or {}).get("api_key_name")}
    except TikHubError as e:
        return {"ok": False, "error": str(e)}


# ---------- 用量统计 ----------
@router.get("/usage/me")
async def my_usage(user: User = Depends(get_current_user)):
    """当前用户的 TikHub 使用统计(总次数/计费次数/命中缓存/按功能)。"""
    async with session_scope() as s:
        total = (await s.execute(
            select(func.count()).select_from(TikHubUsage).where(TikHubUsage.user_id == user.id)
        )).scalar() or 0
        billed = (await s.execute(
            select(func.count()).select_from(TikHubUsage).where(
                TikHubUsage.user_id == user.id, TikHubUsage.billed == True)  # noqa: E712
        )).scalar() or 0
        by_ep = (await s.execute(
            select(TikHubUsage.endpoint, func.count()).where(TikHubUsage.user_id == user.id)
            .group_by(TikHubUsage.endpoint)
        )).all()
    return {
        "total_calls": total,
        "billed_calls": billed,
        "cached_calls": total - billed,
        "by_endpoint": {ep: cnt for ep, cnt in by_ep},
    }


@router.get("/usage/summary")
async def usage_summary(
    limit: int = Query(50, le=500),
    _: User = Depends(require_admin),
):
    """管理员: 全站 TikHub 用量总览(按用户 + 按功能)。"""
    async with session_scope() as s:
        total = (await s.execute(select(func.count()).select_from(TikHubUsage))).scalar() or 0
        billed = (await s.execute(
            select(func.count()).select_from(TikHubUsage).where(TikHubUsage.billed == True)  # noqa: E712
        )).scalar() or 0
        by_user = (await s.execute(
            select(TikHubUsage.user_id, func.count()).group_by(TikHubUsage.user_id)
            .order_by(func.count().desc()).limit(limit)
        )).all()
        by_ep = (await s.execute(
            select(TikHubUsage.endpoint, func.count()).group_by(TikHubUsage.endpoint)
            .order_by(func.count().desc())
        )).all()
    return {
        "total_calls": total,
        "billed_calls": billed,
        "cached_calls": total - billed,
        "by_user": [{"user_id": uid, "calls": cnt} for uid, cnt in by_user],
        "by_endpoint": {ep: cnt for ep, cnt in by_ep},
    }