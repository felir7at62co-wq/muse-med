"""短视频流水线 — FastAPI 路由 (/v1/clip)。"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..auth import User, get_current_user
from ..db import session_scope
from . import service as svc
from .models import ClipJob

logger = logging.getLogger("clip.routes")
router = APIRouter(prefix="/v1/clip", tags=["clip"])

# 视频参数枚举(给前端校验参考)
RESOLUTIONS = ["480p", "720p", "native1080p", "1080p", "2k", "4k"]
RATIOS = ["9:16", "16:9", "4:3", "1:1", "3:4", "21:9", "adaptive"]
DURATIONS = [str(x) for x in range(4, 16)]  # 4..15


def _job_dict(j: ClipJob) -> dict:
    return {
        "id": j.id,
        "title": j.title,
        "input_kind": j.input_kind,
        "input_text": j.input_text,
        "creative": j.creative,
        "video_prompt": j.video_prompt,
        "image_prompt": j.image_prompt,
        "highlights": j.highlights,
        "image_url": j.image_url,
        "params": dict(j.params or {}),
        "video_url": j.video_url,
        "status": j.status,
        "error": j.error,
        "progress": j.progress,
        "created_at": j.created_at.isoformat() if j.created_at else None,
        "updated_at": j.updated_at.isoformat() if j.updated_at else None,
    }


async def _owned(job_id: int, user: User) -> ClipJob:
    async with session_scope() as s:
        j = await s.get(ClipJob, job_id)
        if not j:
            raise HTTPException(404, "clip 不存在")
        if user.role not in ("admin", "superadmin") and j.user_id != user.id:
            raise HTTPException(403, "无权访问")
        # detach 副本
        return j


# ---- 建任务 ----
class CreateIn(BaseModel):
    input_text: str = Field(..., min_length=1, max_length=20000)
    input_kind: str = Field("idea", description="idea / script / reverse")
    title: str = Field("未命名短视频", max_length=120)


@router.post("/create")
async def create(payload: CreateIn, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        j = ClipJob(
            user_id=user.id,
            title=payload.title or "未命名短视频",
            input_kind=payload.input_kind,
            input_text=payload.input_text,
            params={"resolution": "480p", "ratio": "9:16", "duration": "5",
                    "generateAudio": True, "realPersonMode": True},
            status="input",
            progress=10,
        )
        s.add(j)
        await s.flush()
        jid = j.id
    return {"ok": True, "id": jid}


# ---- ② 合成(创意+提示词+首帧图提示词+亮点, 1次AI) ----
class ComposeIn(BaseModel):
    provider: str = Field("gemini", description="gemini/deepseek/gpt5")


@router.post("/{job_id}/compose")
async def compose(job_id: int, payload: ComposeIn, user: User = Depends(get_current_user)):
    await _owned(job_id, user)
    r = await svc.compose(job_id, provider=payload.provider)
    if not r.get("ok"):
        raise HTTPException(500, r.get("error", "合成失败"))
    async with session_scope() as s:
        j = await s.get(ClipJob, job_id)
        return {"ok": True, "job": _job_dict(j)}


# ---- ③ 生成首帧图 ----
@router.post("/{job_id}/gen-image")
async def gen_image(job_id: int, user: User = Depends(get_current_user)):
    await _owned(job_id, user)
    r = await svc.gen_image(job_id)
    if not r.get("ok"):
        raise HTTPException(500, r.get("error", "生成首帧图失败"))
    async with session_scope() as s:
        j = await s.get(ClipJob, job_id)
        return {"ok": True, "job": _job_dict(j)}


# ---- 更新视频参数 ----
class ParamsIn(BaseModel):
    resolution: str | None = None
    ratio: str | None = None
    duration: str | None = None
    generateAudio: bool | None = None
    realPersonMode: bool | None = None


@router.patch("/{job_id}/params")
async def set_params(job_id: int, payload: ParamsIn, user: User = Depends(get_current_user)):
    await _owned(job_id, user)
    async with session_scope() as s:
        j = await s.get(ClipJob, job_id)
        p = dict(j.params or {})
        for k, v in payload.model_dump(exclude_none=True).items():
            p[k] = v
        j.params = p
    return {"ok": True, "params": p}


# ---- 可编辑提示词(用户手改) ----
class EditIn(BaseModel):
    video_prompt: str | None = None
    image_prompt: str | None = None
    creative: str | None = None
    title: str | None = None


@router.patch("/{job_id}")
async def edit(job_id: int, payload: EditIn, user: User = Depends(get_current_user)):
    await _owned(job_id, user)
    async with session_scope() as s:
        j = await s.get(ClipJob, job_id)
        d = payload.model_dump(exclude_none=True)
        for k, v in d.items():
            setattr(j, k, v)
    return {"ok": True}


# ---- ④ 生成视频(长任务) ----
@router.post("/{job_id}/gen-video")
async def gen_video(job_id: int, user: User = Depends(get_current_user)):
    await _owned(job_id, user)
    r = await svc.gen_video(job_id)
    if not r.get("ok"):
        raise HTTPException(500, r.get("error", "生成视频失败"))
    return {"ok": True, "rh_task_id": r.get("rh_task_id")}


# ---- 查询单个 ----
@router.get("/{job_id}")
async def get_one(job_id: int, user: User = Depends(get_current_user)):
    await _owned(job_id, user)
    async with session_scope() as s:
        j = await s.get(ClipJob, job_id)
        return {"ok": True, "job": _job_dict(j)}


# ---- 历史列表(永久可看) ----
@router.get("")
async def list_jobs(user: User = Depends(get_current_user)):
    async with session_scope() as s:
        rows = list((await s.execute(
            select(ClipJob).where(ClipJob.user_id == user.id).order_by(ClipJob.id.desc()).limit(100)
        )).scalars().all())
        return {"items": [_job_dict(r) for r in rows]}


# ---- 删除 ----
@router.delete("/{job_id}")
async def delete_job(job_id: int, user: User = Depends(get_current_user)):
    await _owned(job_id, user)
    async with session_scope() as s:
        j = await s.get(ClipJob, job_id)
        await s.delete(j)
    return {"ok": True}


# ---- 轻量视频反推(上传视频 → doubao 反推 → 仅返回文本, 不建草稿) ----
@router.post("/reverse-video")
async def reverse_video(file: UploadFile = File(...), user: User = Depends(get_current_user)):
    from ..video.doubao_video import analyze_video_file

    suffix = os.path.splitext(file.filename or "v.mp4")[1] or ".mp4"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        data = await file.read()
        if not data:
            raise HTTPException(400, "空文件")
        tmp.write(data)
        tmp.flush()
        tmp.close()
        try:
            res = await analyze_video_file(tmp.name, draft_title="短视频反推", episode_order=1,
                                           user_id=user.id)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(500, f"视频反推失败: {e}")
        text = (res.get("full_text") or "").strip()
        if not text:
            raise HTTPException(500, "反推结果为空")
        return {"ok": True, "text": text, "title": res.get("episode_title") or "短视频反推"}
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass
