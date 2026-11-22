"""视频反推剧本 API

3 个端点:
- POST /v1/video/upload            上传 N 个视频 → 创建 draft + 异步启动流水线
- GET  /v1/video/jobs/{draft_id}   进度查询(从 generation_logs 拉最新 video_* 日志)
- POST /v1/drafts/{draft_id}/character-replace  把 男1/女1 等占位名批量替换为真名
"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select, desc
from sqlalchemy.orm.attributes import flag_modified

from ..auth import User, get_current_user
from ..db import GenerationLog, ScriptChapter, ScriptDraft, ScriptStoryboard, session_scope
from ..video import (
    apply_character_mapping,
    resume_sources,
    run_video_to_script_pipeline,
)

from ..reverse_routes import require_reverse, router as muse_materials_router

router = APIRouter(prefix="/v1", tags=["video"])
router.include_router(muse_materials_router)
logger = logging.getLogger("features.video")

# 视频临时存储目录(落地在容器内,任务完成后由流水线清理)
VIDEO_TMP_DIR = Path(os.environ.get("VIDEO_TMP_DIR", "/tmp/drama_video"))
VIDEO_TMP_DIR.mkdir(parents=True, exist_ok=True)

# 后台任务注册表(进程内),防止任务对象被 GC
_bg_tasks: dict[int, asyncio.Task] = {}


# ---------------------------------------------------------------------------
# 1. 上传 + 启动
# ---------------------------------------------------------------------------
@router.post("/video/upload", dependencies=[Depends(require_reverse)])
async def upload_videos(
    files: list[UploadFile] = File(..., description="按集顺序的视频文件列表"),
    title: str = Form("", description="剧名(可选,不填则取第一个文件名)"),
    model: str = Form("", description="兼容已有客户端，反推使用工坊的 Muse 模型配置"),
    concurrency: int = Form(1, ge=1, le=5, description="并发集数,默认串行保证角色一致性"),
    user: User = Depends(get_current_user),
):
    """一次性上传多集视频,创建草稿后台反推剧本"""
    if not files:
        raise HTTPException(400, "至少上传 1 个视频")

    # 计费归属: 后台协程虽会复制 contextvars, 仍显式捕获一份,
    # 以免后续在无请求上下文的地方被调用时丢人。
    user_id = user.id

    # 取剧名
    draft_title = (title or "").strip()
    if not draft_title:
        first = files[0].filename or "视频剧本"
        draft_title = Path(first).stem

    # 每批一个子目录,便于排错
    batch_id = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"
    batch_dir = VIDEO_TMP_DIR / batch_id
    batch_dir.mkdir(parents=True, exist_ok=True)

    saved_paths: list[str] = []
    total_bytes = 0
    try:
        for i, f in enumerate(files, start=1):
            # 保留原扩展名,文件名用 ep_N
            ext = Path(f.filename or "").suffix.lower() or ".mp4"
            if ext not in {".mp4", ".mov", ".mkv", ".webm", ".avi", ".mpeg", ".mpg", ".3gp", ".flv", ".wmv"}:
                raise HTTPException(400, f"第{i}集 不支持的格式: {ext}")
            dst = batch_dir / f"ep_{i:03d}{ext}"
            # 流式写盘,避免大文件内存爆
            with open(dst, "wb") as out:
                while True:
                    chunk = await f.read(1024 * 1024 * 8)  # 8MB
                    if not chunk:
                        break
                    out.write(chunk)
                    total_bytes += len(chunk)
            saved_paths.append(str(dst))
    except HTTPException:
        # 清理已写入
        for p in saved_paths:
            try: os.remove(p)
            except Exception: pass
        try: batch_dir.rmdir()
        except Exception: pass
        raise
    except Exception as e:
        for p in saved_paths:
            try: os.remove(p)
            except Exception: pass
        raise HTTPException(500, f"视频落盘失败: {e}")

    logger.info(
        "video upload: user=%s title=%s files=%d total=%.1fMB",
        user.username, draft_title, len(saved_paths), total_bytes / 1024 / 1024,
    )

    # 豆包整片反推(2GB/文件): 一个上传文件 = 一集, 不再降帧率/切片。
    final_paths = list(saved_paths)
    split_meta = [{"source_index": i + 1, "part": 1, "total_parts": 1} for i in range(len(saved_paths))]
    total_segments = len(final_paths)
    needs_split = False

    # 创建 draft
    async with session_scope() as s:
        row = ScriptDraft(
            user_id=user.id,
            session_id=f"video_{batch_id}",
            title=draft_title,
            user_input="(从视频反推的剧本)",
            model_provider="gemini",
            episode_count=total_segments,
            status="video_running",
            outline={
                "title": draft_title,
                "synopsis": "视频反推中,完成后将填充概要",
                "characters": [],
                "chapters": [],
                "character_mapping": {},
                "video_split_meta": split_meta,    # 记录切分情况, 后续可还原
            },
            outline_locked=0,
        )
        s.add(row)
        await s.flush()
        draft_id = row.id

    # 启动后台任务
    async def _run():
        try:
            # 写一条切分日志, 方便用户感知
            if needs_split:
                from ..stages.log_helper import save_log
                detail_lines = []
                for m in split_meta:
                    if m.get("total_parts", 1) > 1:
                        detail_lines.append(
                            f"  · {m.get('source_filename', '?')}: {m.get('total_parts')} 段"
                        )
                detail = "\n".join(detail_lines) if detail_lines else ""
                await save_log(
                    draft_id, "video_ingest",
                    f"长视频已自动切分: {len(saved_paths)} 个文件 → {total_segments} 集"
                    + (f"\n{detail}" if detail else ""),
                    "log", 0, {"split_meta": split_meta},
                )
            await run_video_to_script_pipeline(
                draft_id=draft_id,
                video_paths=final_paths,
                draft_title=draft_title,
                model=model,
                concurrency=concurrency,
                cleanup_files=True,
                user_id=user_id,
            )
        except Exception as e:
            logger.exception("video pipeline crashed: %s", e)
        finally:
            if batch_dir.is_dir() and not any(batch_dir.iterdir()):
                batch_dir.rmdir()
            _bg_tasks.pop(draft_id, None)

    task = asyncio.create_task(_run())
    _bg_tasks[draft_id] = task

    return {
        "ok": True,
        "draft_id": draft_id,
        "title": draft_title,
        "episode_count": total_segments,
        "uploaded_files": len(saved_paths),
        "auto_split": needs_split,
        "message": (
            f"已上传 {len(saved_paths)} 个文件, 自动切分为 {total_segments} 集, 后台反推已启动"
            if needs_split else
            f"已上传 {total_segments} 集, 后台反推已启动"
        ),
    }


# ---------------------------------------------------------------------------
# 1.2 贴链接 / 搜索下载 (档位1+2) — 见 docs/PLAN-视频反推-URL与搜索下载.md
# ---------------------------------------------------------------------------
class ProbeUrlIn(BaseModel):
    url: str = Field(..., description="单条视频链接(可含分享口令文本, 后端自动提取)")


class FromUrlIn(BaseModel):
    urls: list[str] = Field(..., min_length=1, max_length=20, description="按集顺序的视频链接列表")
    title: str = Field("", description="剧名(可选, 不填用第一条视频标题)")
    model: str = Field("", description="兼容已有客户端，反推使用工坊的 Muse 模型配置")
    delete_source_after: bool = Field(True, description="反推完成后删除本地原始视频(仅留分析文本)")


class SearchVideosIn(BaseModel):
    query: str = Field(..., min_length=1, max_length=200)
    platform: str = Field("bilibili", description="bilibili / youtube (其它平台请贴链接)")
    limit: int = Field(8, ge=1, le=20)


# 简单限频: 每用户每天可发起的"链接下载"集数上限 (内存计数, 进程级)
_DL_DAILY_LIMIT = int(os.environ.get("VIDEO_DL_DAILY_LIMIT", "30"))
_dl_counter: dict[str, int] = {}  # key=f"{user_id}:{yyyymmdd}"


def _dl_quota_check(user_id: int, n: int) -> None:
    key = f"{user_id}:{time.strftime('%Y%m%d')}"
    used = _dl_counter.get(key, 0)
    if used + n > _DL_DAILY_LIMIT:
        raise HTTPException(429, f"今日链接下载已达上限({_DL_DAILY_LIMIT}集), 请明天再试或改用手动上传")
    _dl_counter[key] = used + n


@router.post("/video/probe-url")
async def probe_video_url(payload: ProbeUrlIn, user: User = Depends(get_current_user)):
    """解析单条链接的元信息(不下载): 标题/时长/平台/是否超长。供前端贴链接后即时预览。"""
    from ..video.downloader import probe_url
    try:
        return await probe_url(payload.url)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/video/search")
async def search_videos_endpoint(payload: SearchVideosIn, user: User = Depends(get_current_user)):
    """关键词搜索候选。
    - douyin: 走 TikHub 短视频大数据(短剧爆款检索, 返回统一格式含封面/点赞/播放/标签)
    - bilibili / youtube: 走 yt-dlp
    - 其它平台: supported=false, 前端引导贴链接
    """
    platform = payload.platform.lower()

    # 全平台走 TikHub (抖音/TikTok/快手/小红书), 稳定且统一
    TIKHUB_PLATS = {"douyin", "tiktok", "kuaishou", "xiaohongshu"}
    if platform in TIKHUB_PLATS:
        from ..tikhub import service as tikhub_svc
        from ..tikhub import platforms as tikhub_plat
        from ..tikhub.client import TikHubError
        try:
            if platform == "douyin":
                r = await tikhub_svc.search_videos(payload.query, user_id=user.id)
            else:
                r = await tikhub_plat.search(platform, payload.query, user_id=user.id)
        except TikHubError as e:
            raise HTTPException(502, f"{platform}搜索失败: {e}")
        results = []
        for v in (r.get("videos") or [])[: payload.limit]:
            aid = v.get("aweme_id")
            results.append({
                "title": v.get("desc") or "",
                "cover": v.get("cover"),
                "duration": int((v.get("duration") or 0) / 1000) if v.get("duration") else 0,
                "url": v.get("share_url") or "",
                "aweme_id": aid,
                "author": (v.get("author") or {}).get("nickname"),
                "statistics": v.get("statistics"),
                "tags": v.get("tags"),
                "platform": platform,
            })
        return {"ok": True, "supported": True, "platform": platform, "results": results}

    from ..video.downloader import search_videos, _SEARCH_PREFIX
    if platform not in _SEARCH_PREFIX:
        return {
            "ok": True,
            "supported": False,
            "platform": platform,
            "results": [],
            "message": "该平台暂不支持关键词搜索, 请直接粘贴单条视频的链接",
        }
    results = await search_videos(payload.query, platform=platform, limit=payload.limit)
    return {"ok": True, "supported": True, "platform": platform, "results": results}


@router.post("/video/from-url", dependencies=[Depends(require_reverse)])
async def create_draft_from_url(payload: FromUrlIn, user: User = Depends(get_current_user)):
    """从一个或多个视频链接下载 → 切分 → 反推剧本(后台)。

    仅供个人学习/拆解分析。下载走独立 downloader 模块(域名白名单+防SSRF),
    反推完成后按 delete_source_after 决定是否删本地原片(不入 OSS)。
    """
    from ..video.downloader import validate_url, download_url

    # 计费归属: 后台协程显式捕获一份(见 upload_videos 同名变量)
    user_id = user.id

    # 1. 预校验所有链接(域名白名单/单条/可提取)
    clean: list[tuple[str, str]] = []  # (clean_url, platform)
    for raw in payload.urls:
        try:
            u, plat = validate_url(raw)
        except ValueError as e:
            raise HTTPException(400, f"链接校验失败: {e}")
        clean.append((u, plat))

    # 2. 限频(按链接数=预估集数)
    _dl_quota_check(user.id, len(clean))

    batch_id = f"url_{int(time.time())}_{uuid.uuid4().hex[:8]}"
    batch_dir = VIDEO_TMP_DIR / batch_id
    batch_dir.mkdir(parents=True, exist_ok=True)
    draft_title = (payload.title or "").strip()
    model = payload.model
    delete_source = payload.delete_source_after

    # 3. 先建 draft(status=下载中), 立即返回; 下载+反推走后台
    async with session_scope() as s:
        row = ScriptDraft(
            user_id=user.id,
            session_id=f"video_{batch_id}",
            title=draft_title or "链接视频反推中…",
            user_input="(从视频链接反推的剧本)",
            model_provider="gemini",
            episode_count=len(clean),
            status="video_running",
            outline={
                "title": draft_title or "链接视频反推中…",
                "synopsis": "正在下载视频, 完成后开始反推…",
                "characters": [],
                "chapters": [],
                "character_mapping": {},
                "source_urls": [u for u, _ in clean],
            },
            outline_locked=0,
        )
        s.add(row)
        await s.flush()
        draft_id = row.id

    async def _run_from_url():
        from ..stages.log_helper import save_log
        saved_paths: list[str] = []
        try:
            await save_log(draft_id, "video_ingest",
                           f"开始从 {len(clean)} 个链接下载视频…", "log", 0,
                           {"source_urls": [u for u, _ in clean]})
            # 逐条下载
            for idx, (u, plat) in enumerate(clean):
                try:
                    res = await download_url(u, batch_dir)
                    saved_paths.append(res["path"])
                    await save_log(draft_id, "video_ingest",
                                   f"已下载第{idx+1}条({plat}): {res.get('title','')[:40]}", "log", idx + 1)
                except ValueError as e:
                    await save_log(draft_id, "video_ingest",
                                   f"第{idx+1}条下载失败: {e}", "error", idx + 1)
            if not saved_paths:
                async with session_scope() as s:
                    d = await s.get(ScriptDraft, draft_id)
                    if d:
                        d.status = "draft"
                await save_log(draft_id, "video_ingest",
                               "所有链接下载失败, 请检查链接或改用手动上传", "error", 0)
                return

            # 用第一条标题补 draft 标题(若用户没填)
            if not draft_title:
                try:
                    from ..video.downloader import probe_url as _probe
                    async with session_scope() as s:
                        d = await s.get(ScriptDraft, draft_id)
                        if d and (not d.title or "反推中" in d.title):
                            # saved 已下载, 用文件名兜底即可; 标题非关键
                            d.title = Path(saved_paths[0]).stem[:40] or "链接视频反推"
                            ol = dict(d.outline or {}); ol["title"] = d.title
                            d.outline = ol
                except Exception:
                    pass

            # 豆包整片反推: 一个下载文件 = 一集, 不切片
            final_paths = list(saved_paths)

            async with session_scope() as s:
                d = await s.get(ScriptDraft, draft_id)
                if d:
                    d.episode_count = len(final_paths)

            await run_video_to_script_pipeline(
                draft_id=draft_id,
                video_paths=final_paths,
                draft_title=(draft_title or "链接视频反推"),
                model=model,
                concurrency=1,
                cleanup_files=delete_source,
                user_id=user_id,
            )
        except Exception as e:
            logger.exception("from-url pipeline crashed: %s", e)
        finally:
            # 用户选择保留片源时保留下载目录。
            if batch_dir.is_dir() and not any(batch_dir.iterdir()):
                batch_dir.rmdir()
            _bg_tasks.pop(draft_id, None)

    task = asyncio.create_task(_run_from_url())
    _bg_tasks[draft_id] = task

    return {
        "ok": True,
        "draft_id": draft_id,
        "title": draft_title or "链接视频反推",
        "url_count": len(clean),
        "message": f"已开始下载 {len(clean)} 个视频, 下载完成后自动反推",
    }


# ---------------------------------------------------------------------------
# 1.5 从 OSS 直传完成的文件创建草稿 (大文件方案)
# ---------------------------------------------------------------------------

class FromOssIn(BaseModel):
    upload_ids: list[str] = Field(..., min_length=1, description="按集顺序的 oss upload_id 列表")
    title: str = ""
    model: str = ""
    concurrency: int = Field(default=1, ge=1, le=5)


@router.post("/video/from-oss", dependencies=[Depends(require_reverse)])
async def create_draft_from_oss(payload: FromOssIn, user: User = Depends(get_current_user)):
    """从已通过 /v1/oss/* 直传完成的视频创建草稿并启动反推。

    工作流(全部异步, 立刻返回 draft_id, 浏览器不会卡):
      1. 校验所有 upload_id 都属于当前用户且 status=completed (毫秒级)
      2. 立刻建 draft 行 (毫秒级)
      3. 后台任务: OSS 内网下载 → split → run_video_to_script_pipeline
      4. 返回 {draft_id} 给前端, 前端跳到草稿页轮询 /v1/video/jobs/{id}
    """
    from ..oss import client as oss_client
    from ..db.models import UploadSession
    from ..stages.log_helper import save_log

    # 计费归属: 后台协程显式捕获一份(见 upload_videos 同名变量)
    user_id = user.id

    # ---- 1. 校验 + 拍快照 (毫秒级, 同步) ----
    session_snapshots: list[dict] = []  # 用 plain dict 避免 detached ORM 实例
    async with session_scope() as s:
        for uid in payload.upload_ids:
            sess = await s.get(UploadSession, uid)
            if not sess:
                raise HTTPException(404, f"upload_id 不存在: {uid}")
            if sess.user_id != user.id and user.role not in ("admin", "superadmin"):
                raise HTTPException(403, f"无权使用该上传: {uid}")
            if sess.status != "completed":
                raise HTTPException(409, f"upload {uid} 状态={sess.status}, 不是 completed")
            session_snapshots.append({
                "id": sess.id,
                "filename": sess.filename,
                "oss_key": sess.oss_key,
                "total_size": sess.total_size,
            })

    # 校验扩展名 (early fail)
    valid_ext = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".mpeg", ".mpg", ".3gp", ".flv", ".wmv"}
    for i, snap in enumerate(session_snapshots, start=1):
        ext = Path(snap["filename"] or "").suffix.lower() or ".mp4"
        if ext not in valid_ext:
            raise HTTPException(400, f"第{i}集 不支持的格式: {ext}")

    draft_title = (payload.title or "").strip()
    if not draft_title:
        draft_title = Path(session_snapshots[0]["filename"] or "视频剧本").stem

    oss_keys = [s["oss_key"] for s in session_snapshots]
    total_bytes_estimated = sum(s["total_size"] for s in session_snapshots)

    # ---- 2. 立刻建 draft 行 (此时还不知道切分结果, episode_count 先用上传文件数估算) ----
    async with session_scope() as s:
        row = ScriptDraft(
            user_id=user.id,
            session_id=f"video_oss_{int(time.time())}_{uuid.uuid4().hex[:8]}",
            title=draft_title,
            user_input="(从视频反推的剧本 / OSS 直传)",
            model_provider="gemini",
            episode_count=len(session_snapshots),  # 后台 split 后会更新
            status="video_pulling",  # 新状态: 正在从 OSS 拉取
            source_oss_key=oss_keys[0] if oss_keys else None,
            outline={
                "title": draft_title,
                "synopsis": "视频反推中,完成后将填充概要",
                "characters": [],
                "chapters": [],
                "character_mapping": {},
                "source_oss_keys": oss_keys,
            },
            outline_locked=0,
        )
        s.add(row)
        await s.flush()
        draft_id = row.id

    logger.info(
        "video from-oss: user=%s title=%s files=%d ~%.1fMB draft_id=%d (后台拉取)",
        user.username, draft_title, len(oss_keys), total_bytes_estimated / 1024 / 1024, draft_id,
    )

    # 写一条 ingest 日志, 让前端进度页能立刻看到反馈
    try:
        await save_log(
            draft_id, "video_ingest",
            f"OSS 直传完成, 共 {len(oss_keys)} 集, 即将用 Muse 核对原声、字幕与画面...",
            "log", 0, {"source_oss_keys": oss_keys, "total_bytes": total_bytes_estimated},
        )
    except Exception:
        pass

    # ---- 3. 后台任务: 豆包直接从 TOS 整片反推(不下载本地、不切片, 一文件=一集) ----
    async def _run_from_oss():
        try:
            # 3a. 直接把 OSS key 按上传顺序映射为 {集号: oss_key}(豆包整片反推, 无需本地降规格/切片)
            episode_oss_keys = {i: snap["oss_key"] for i, snap in enumerate(session_snapshots, start=1)}
            total_segments = len(episode_oss_keys)

            # 3b. 更新 draft (集数 = 上传文件数, 状态切到 video_running)
            async with session_scope() as s2:
                d = await s2.get(ScriptDraft, draft_id)
                if d:
                    d.episode_count = total_segments
                    d.status = "video_running"
                    # ⚠️ 集号↔key 的映射必须落库。反推是**进程内协程**, orchestrator
                    # 一重启(部署/改代码/崩)整批就没了, 而 OSS 直传的草稿
                    # outline.video_paths 是空的 → retry-failed 会说"没有可重试的集",
                    # 素材明明还在 TOS 里却再也续不上。
                    # 存的是 {集号: key}, 顺序即集号, 不依赖 source_oss_keys 的上传顺序。
                    outline = dict(d.outline or {})
                    outline["episode_oss_keys"] = {str(k): v for k, v in episode_oss_keys.items()}
                    outline["video_source_kind"] = "oss"
                    d.outline = outline
                    flag_modified(d, "outline")

            await save_log(
                draft_id, "video_ingest",
                f"共 {total_segments} 集, Muse 逐集反推已启动",
                "log", 0, {"episode_count": total_segments},
            )

            # 3c. 启动反推流水线 (豆包从 TOS 整片反推; cleanup_files 对 oss 来源无效, TOS 原文件保留供复推)
            await run_video_to_script_pipeline(
                draft_id=draft_id,
                draft_title=draft_title,
                model=payload.model,
                concurrency=payload.concurrency,
                cleanup_files=False,
                episode_oss_keys=episode_oss_keys,
                user_id=user_id,
            )
        except Exception as e:
            logger.exception("video pipeline (from-oss) crashed: %s", e)
            try:
                await save_log(
                    draft_id, "video_ingest",
                    f"从 OSS 反推失败: {e}",
                    "error", 0, {},
                )
                async with session_scope() as s3:
                    d = await s3.get(ScriptDraft, draft_id)
                    if d and d.status not in ("failed", "video_running"):
                        d.status = "failed"
            except Exception:
                pass
        finally:
            _bg_tasks.pop(draft_id, None)

    task = asyncio.create_task(_run_from_oss())
    _bg_tasks[draft_id] = task

    # ---- 4. 立刻返回 (前端可马上跳转草稿页) ----
    return {
        "ok": True,
        "draft_id": draft_id,
        "title": draft_title,
        "source": "oss",
        "oss_keys": oss_keys,
        "status": "video_pulling",
        "message": f"已开始从 OSS 拉取 {len(oss_keys)} 集到服务端, 进度可在草稿页查看",
    }


# ---------------------------------------------------------------------------
# 2. 进度查询
# ---------------------------------------------------------------------------
@router.get("/video/jobs/{draft_id}")
async def get_video_job(
    draft_id: int,
    limit: int = 200,
    user: User = Depends(get_current_user),
):
    """查询视频反推任务进度,基于 generation_logs 聚合"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise HTTPException(404, "draft not found")
        if user.role not in ("admin", "superadmin") and d.user_id != user.id:
            raise HTTPException(403, "无权访问此草稿")

        # 统计章节完成情况
        chs = (await s.execute(
            select(ScriptChapter.chapter_order).where(ScriptChapter.draft_id == draft_id)
            .order_by(ScriptChapter.chapter_order)
        )).scalars().all()
        sbs = (await s.execute(
            select(ScriptStoryboard.chapter_order).where(ScriptStoryboard.draft_id == draft_id)
            .order_by(ScriptStoryboard.chapter_order)
        )).scalars().all()

        # 最近 video_* 日志
        logs = (await s.execute(
            select(GenerationLog).where(
                GenerationLog.draft_id == draft_id,
                GenerationLog.stage.in_(["video_ingest", "video_analyze", "video_done"]),
            ).order_by(desc(GenerationLog.id)).limit(limit)
        )).scalars().all()

        expected = d.episode_count or 0
        finished_set = set(chs)
        finished = len(finished_set)

        running = (draft_id in _bg_tasks) and (not _bg_tasks[draft_id].done())
        status = "running" if running else ("done" if finished >= expected > 0 else d.status or "unknown")

        # 失败集合 = outline.video_paths 里还留有文件路径的 order(成功的已被 prune 掉)
        outline = d.outline or {}
        pending_paths_raw = outline.get("video_paths") or {}
        pending_paths: dict[str, str] = {}
        failed_orders: list[int] = []
        for k, v in pending_paths_raw.items():
            try:
                order_i = int(k)
            except Exception:
                continue
            if not isinstance(v, str) or not v:
                continue
            # 只报告文件还存在的集(磁盘被清理过也要容忍)
            if os.path.exists(v):
                pending_paths[str(order_i)] = v
                failed_orders.append(order_i)
        failed_orders.sort()

    # 续跑可行性: 找出"有原始素材、但还没有正文"的集。
    # OSS 直传的草稿 outline.video_paths 是空的, 所以 can_retry 对他们恒为 False,
    # 光看那个字段用户会以为彻底没救了 —— 素材其实好好躺在 TOS 里。
    resumable_orders: list[int] = []
    if not running and status != "done":
        try:
            src = await resume_sources(draft_id)
            if src:
                resumable_orders = sorted(set(src.keys()) - finished_set)
        except Exception as e:  # noqa: BLE001
            logger.warning("video jobs: 续跑可行性判断失败 draft=%d: %s", draft_id, e)

    return {
        "ok": True,
        "draft_id": draft_id,
        "status": status,
        "expected_episodes": expected,
        "finished_episodes": finished,
        "storyboards_done": len(set(sbs)),
        "running_in_bg": running,
        "failed_orders": failed_orders,
        "pending_paths": pending_paths,
        "can_retry": (not running) and bool(pending_paths),
        # 能续跑 = 素材还在 + 还有没做完的集。前端据此显示"继续反推"按钮,
        # 别让用户以为只能重新上传 60 个视频。
        "resumable_orders": resumable_orders,
        "can_resume": bool(resumable_orders),
        "logs": [
            {
                "id": l.id,
                "stage": l.stage,
                "chapter_order": l.chapter_order,
                "log_type": l.log_type,
                "message": l.message,
                "metadata": l.log_metadata or {},
                "created_at": l.created_at.isoformat() if l.created_at else None,
            }
            for l in reversed(logs)
        ],
    }


# ---------------------------------------------------------------------------
# 2b. 重试失败剧集
# ---------------------------------------------------------------------------
class RetryFailedIn(BaseModel):
    orders: list[int] | None = None  # 指定 order,不传=全部失败的
    concurrency: int = 1


@router.post("/video/drafts/{draft_id}/retry-failed", dependencies=[Depends(require_reverse)])
async def retry_failed_episodes(
    draft_id: int,
    payload: RetryFailedIn,
    user: User = Depends(get_current_user),
):
    """重推反推失败的剧集

    - 依赖 outline.video_paths 里保留的文件路径(失败集才会留在里面)
    - 若指定 orders 参数,只重推指定集;否则重推所有尚在 video_paths 中的集
    - 后台任务异步执行,前端用 /v1/video/jobs/{id} 轮询进度
    """
    # 计费归属: 后台协程显式捕获一份(见 upload_videos 同名变量)
    user_id = user.id

    # 权限 + 取路径
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise HTTPException(404, "draft not found")
        if user.role not in ("admin", "superadmin") and d.user_id != user.id:
            raise HTTPException(403, "无权访问此草稿")

        outline = d.outline or {}
        pending = outline.get("video_paths") or {}
        episode_paths: dict[int, str] = {}
        for k, v in pending.items():
            try:
                order_i = int(k)
            except Exception:
                continue
            if not isinstance(v, str) or not v or not os.path.exists(v):
                continue
            if payload.orders and order_i not in payload.orders:
                continue
            episode_paths[order_i] = v

        draft_title = d.title or "未命名"
        model_name = ""   # 空 = 用 ark_video_understand_model(豆包)

    if not episode_paths:
        raise HTTPException(400, "没有可重试的集:要么全部已成功,要么视频文件已被清理")

    # 已在跑就拒绝
    existing = _bg_tasks.get(draft_id)
    if existing and not existing.done():
        raise HTTPException(409, "该草稿仍有后台任务在运行,请稍后重试")

    logger.info("retry-failed draft=%d orders=%s", draft_id, sorted(episode_paths.keys()))

    async def _run():
        try:
            await run_video_to_script_pipeline(
                draft_id=draft_id,
                draft_title=draft_title,
                model=model_name,
                concurrency=max(1, min(5, payload.concurrency or 1)),
                cleanup_files=True,
                episode_paths=episode_paths,
                user_id=user_id,
            )
        except Exception as e:
            logger.exception("retry pipeline crashed: %s", e)
        finally:
            _bg_tasks.pop(draft_id, None)

    task = asyncio.create_task(_run())
    _bg_tasks[draft_id] = task

    return {
        "ok": True,
        "draft_id": draft_id,
        "retry_orders": sorted(episode_paths.keys()),
        "count": len(episode_paths),
    }


# ---------------------------------------------------------------------------
# 2.5 断点续跑: 服务重启打断的反推
# ---------------------------------------------------------------------------
class ResumeIn(BaseModel):
    concurrency: int = 1
    # 重跑已完成的集? 默认 False = 只补没做完的(省钱、快)
    redo_done: bool = False


@router.post("/video/drafts/{draft_id}/resume", dependencies=[Depends(require_reverse)])
async def resume_interrupted(
    draft_id: int,
    payload: ResumeIn,
    user: User = Depends(get_current_user),
):
    """续跑一个被中断的视频反推(素材还在 TOS, 不必让用户重新上传)。

    为什么需要这个端点: 反推跑在 **orchestrator 进程内的协程**里
    (`asyncio.create_task`), 这个进程一重启, 所有在跑的反推就静默消失——
    草稿永远停在 video_running, 进度页显示"第N集 开始分析"再也不动。
    而部署 reboot 是常规操作, 用户不该为此重传 60 个视频。

    与 retry-failed 的区别: retry-failed 只认本地文件路径, 对 OSS 直传的草稿
    (不落盘)必然是 400; 本端点从 outline 里找回原始 key, 顺序还原集号。

    默认只补没做完的集(reuse 已有正文), 不会重烧已花掉的视频理解 token。
    """
    user_id = user.id

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise HTTPException(404, "draft not found")
        if user.role not in ("admin", "superadmin") and d.user_id != user.id:
            raise HTTPException(403, "无权访问此草稿")
        draft_title = d.title or "未命名"
        model_name = ""  # 空 = 用 ark_video_understand_model(豆包)

    existing = _bg_tasks.get(draft_id)
    if existing and not existing.done():
        raise HTTPException(409, "该草稿仍有后台任务在运行, 请稍后重试")

    sources = await resume_sources(draft_id)
    if not sources:
        raise HTTPException(
            400,
            "找不到这个草稿的原始视频来源(可能是本地文件流程且文件已被清理)。"
            "请重新上传视频建新草稿。",
        )

    # 本地文件来源才需要 exists 过滤; oss key 不落盘, 不做此判断
    oss_like = {o: src for o, src in sources.items() if not os.path.isabs(src)}
    local_like = {o: src for o, src in sources.items() if os.path.isabs(src)}
    local_like = {o: p for o, p in local_like.items() if os.path.exists(p)}
    if not oss_like and not local_like:
        raise HTTPException(400, "原始视频文件已不存在, 请重新上传建新草稿")

    logger.info(
        "resume draft=%d orders=%d oss=%d local=%d redo_done=%s",
        draft_id, len(sources), len(oss_like), len(local_like), payload.redo_done,
    )

    async def _run():
        try:
            await run_video_to_script_pipeline(
                draft_id=draft_id,
                draft_title=draft_title,
                model=model_name,
                concurrency=max(1, min(5, payload.concurrency or 1)),
                cleanup_files=False,
                episode_oss_keys=oss_like or None,
                episode_paths=local_like or None,
                user_id=user_id,
                # 用户明确要"全部重跑"时才重烧已完成的集
                skip_existing=not payload.redo_done,
                revision=uuid.uuid4().hex if payload.redo_done else None,
            )
        except Exception as e:
            logger.exception("resume pipeline crashed: %s", e)
        finally:
            _bg_tasks.pop(draft_id, None)

    task = asyncio.create_task(_run())
    _bg_tasks[draft_id] = task

    return {
        "ok": True,
        "draft_id": draft_id,
        "resume_orders": sorted(sources.keys()),
        "count": len(sources),
        "redo_done": payload.redo_done,
    }


# ---------------------------------------------------------------------------
# 3. 角色批量替换
# ---------------------------------------------------------------------------
class CharacterReplaceIn(BaseModel):
    mapping: dict[str, str]  # { "男1": "陆远", "女1": "林夏" }


@router.post("/drafts/{draft_id}/character-replace")
async def character_replace(
    draft_id: int,
    payload: CharacterReplaceIn,
    user: User = Depends(get_current_user),
):
    """把 男1/女1 等占位名批量替换为用户填写的真名,作用于本 draft 的所有章节+剧本+大纲"""
    # 权限
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise HTTPException(404, "draft not found")
        if user.role not in ("admin", "superadmin") and d.user_id != user.id:
            raise HTTPException(403, "无权访问此草稿")

    try:
        # allow_any=True: 支持通用改名(任意人名, 如 陆淮→刘淮), 不再局限于 男1/女1 占位代号;
        # 作用于该草稿的全部大纲+章节(若有)+剧本, 不依赖"章节正文"或角色库是否存在。
        result = await apply_character_mapping(draft_id, payload.mapping, save_history=True, allow_any=True)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.exception("character replace failed")
        raise HTTPException(500, f"替换失败: {e}")

    return {"ok": True, **result}
