"""audio_studio 路由 (用户端, prefix /v1/audio-studio)。

  POST /upload-ref          上传参考音色音频 (multipart), 返回 oss_key
  POST /generate            发起音频生成 (text + 参考音色), 立即返回 job_id
  GET  /jobs/{id}           查询任务状态 + 产出音频签名 URL
  GET  /jobs                当前用户任务历史
  POST /jobs/{id}/cancel    取消任务
  POST /jobs/{id}/regenerate 用原参数重新生成
  DELETE /jobs/{id}         删除任务 + 产出
  GET  /concurrency         并发上限 + 当前用户排队/运行数
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import select

from ..auth import get_current_user, User
from ..db import session_scope
from ..oss import client as oss_client
from . import service
from .models import AudioAsset, AudioJob

logger = logging.getLogger("audio_studio")

router = APIRouter(prefix="/v1/audio-studio", tags=["audio-studio"])

# 参考音频体积上限 (30MB)
_MAX_REF_BYTES = 30 * 1024 * 1024
# 文本长度上限
_MAX_TEXT_LEN = 5000


@router.post("/upload-ref")
async def upload_ref(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    """上传参考音色音频到 OSS, 返回 oss_key + 试听 URL。"""
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "empty file")
    if len(raw) > _MAX_REF_BYTES:
        raise HTTPException(400, "参考音频过大 (>30MB)")
    key = oss_client.build_oss_key(
        user_id=user.id, filename=file.filename or "ref.flac", namespace="audio-studio-ref",
    )
    try:
        await oss_client.put_object_async(key, raw)
    except Exception as e:  # noqa: BLE001
        logger.exception("upload ref audio failed")
        raise HTTPException(500, f"OSS 上传失败: {e}")
    return {
        "oss_key": key,
        "filename": file.filename or "ref.flac",
        "url": oss_client.sign_get_url(key, ttl_seconds=3600),
    }


class GenerateBody(BaseModel):
    text: str
    ref_audio_oss_key: str
    ref_audio_filename: str = "ref.flac"


@router.post("/generate")
async def generate(body: GenerateBody, user: User = Depends(get_current_user)):
    if not (body.text or "").strip():
        raise HTTPException(400, "待合成文本不能为空")
    if len(body.text) > _MAX_TEXT_LEN:
        raise HTTPException(400, f"文本过长 (>{_MAX_TEXT_LEN} 字)")
    if not (body.ref_audio_oss_key or "").strip():
        raise HTTPException(400, "请先上传参考音色音频")
    job_id = await service.create_and_run_generate(
        user_id=user.id,
        text=body.text,
        ref_audio_oss_key=body.ref_audio_oss_key,
        ref_audio_filename=body.ref_audio_filename or "ref.flac",
    )
    return {"job_id": job_id, "status": "queued"}


def _ref_url_of(job: AudioJob) -> str | None:
    key = (dict(job.params or {}).get("ref_audio_oss_key") or "")
    if not key:
        return None
    try:
        return oss_client.sign_get_url(key, ttl_seconds=3600)
    except Exception:  # noqa: BLE001
        return None


def _job_view(job: AudioJob, assets: list[AudioAsset]) -> dict:
    params = dict(job.params or {})
    return {
        "id": job.id,
        "provider": job.provider,
        "model": job.model,
        "status": job.status,
        "progress": job.progress,
        "error": job.error,
        "text": params.get("text"),
        "ref_url": _ref_url_of(job),
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
        "assets": [
            {
                "id": a.id, "seq": a.seq, "fmt": a.fmt,
                "url": oss_client.sign_get_url(a.oss_key, ttl_seconds=3600),
            }
            for a in sorted(assets, key=lambda x: x.seq)
        ],
    }


@router.get("/jobs/{job_id}")
async def get_job(job_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        job = await s.get(AudioJob, job_id)
        if not job or job.user_id != user.id:
            raise HTTPException(404, "job not found")
        assets = (await s.execute(
            select(AudioAsset).where(AudioAsset.job_id == job_id)
        )).scalars().all()
        return _job_view(job, list(assets))


@router.get("/jobs")
async def list_jobs(user: User = Depends(get_current_user), limit: int = 30):
    limit = max(1, min(limit, 100))
    async with session_scope() as s:
        jobs = (await s.execute(
            select(AudioJob).where(AudioJob.user_id == user.id)
            .order_by(AudioJob.id.desc()).limit(limit)
        )).scalars().all()
        job_ids = [j.id for j in jobs]
        assets_by_job: dict[int, list[AudioAsset]] = {jid: [] for jid in job_ids}
        if job_ids:
            assets = (await s.execute(
                select(AudioAsset).where(AudioAsset.job_id.in_(job_ids))
            )).scalars().all()
            for a in assets:
                assets_by_job.setdefault(a.job_id, []).append(a)
        return [_job_view(j, assets_by_job.get(j.id, [])) for j in jobs]


@router.post("/jobs/{job_id}/cancel")
async def cancel_job_route(job_id: int, user: User = Depends(get_current_user)):
    try:
        st = await service.cancel_job(job_id, user.id)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"job_id": job_id, "status": st}


@router.post("/jobs/{job_id}/regenerate")
async def regenerate_job_route(job_id: int, user: User = Depends(get_current_user)):
    """用原任务参数重新生成 (任意状态均可)。"""
    async with session_scope() as s:
        job = await s.get(AudioJob, job_id)
        if not job or job.user_id != user.id:
            raise HTTPException(404, "job not found")
        params = dict(job.params or {})
    new_id = await service.create_and_run_generate(
        user_id=user.id,
        text=params.get("text") or "",
        ref_audio_oss_key=params.get("ref_audio_oss_key") or "",
        ref_audio_filename=params.get("ref_audio_filename") or "ref.flac",
    )
    return {"job_id": new_id, "status": "queued"}


@router.delete("/jobs/{job_id}")
async def delete_job_route(job_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        job = await s.get(AudioJob, job_id)
        if not job or job.user_id != user.id:
            raise HTTPException(404, "job not found")
        assets = (await s.execute(
            select(AudioAsset).where(AudioAsset.job_id == job_id)
        )).scalars().all()
        for a in assets:
            await s.delete(a)
        await s.delete(job)
    return {"ok": True, "deleted": [job_id]}


@router.get("/concurrency")
async def concurrency_info(user: User = Depends(get_current_user)):
    """与生图共享 100 并发; 返回当前用户排队/运行中数量。"""
    async with session_scope() as s:
        running = (await s.execute(
            select(AudioJob).where(AudioJob.user_id == user.id, AudioJob.status == "running")
        )).scalars().all()
        pending = (await s.execute(
            select(AudioJob).where(AudioJob.user_id == user.id, AudioJob.status == "pending")
        )).scalars().all()
    return {"limit": 100, "running": len(running), "pending": len(pending), "shared_with": "image-studio"}