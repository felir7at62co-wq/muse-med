"""audio_studio 业务编排: 上传参考音色 -> RunningHub 创建任务 -> 轮询 -> 转存 OSS。

抗重启: rh_task_id 存 params, 重启后用它续查 (远端任务不受本进程影响)。
并发: 与生图版块共享 RunningHub 的 100 并发 (复用 image_studio.service._SEM)。
"""
from __future__ import annotations

import asyncio
import logging
import tempfile
import os as _os
from datetime import datetime
from typing import Optional

from sqlalchemy import select

from ..db import session_scope
from ..oss import client as oss_client
from ..billing import service as billing_service
from ..factory.usage import set_usage_context
from . import providers
from .models import AudioAsset, AudioJob

logger = logging.getLogger("audio_studio")

# 与生图版块共享 100 并发 (同一 RunningHub key 的并发池)
try:
    from ..image_studio.service import _SEM as _SHARED_SEM  # type: ignore
except Exception:  # noqa: BLE001
    _SHARED_SEM = asyncio.Semaphore(100)

_MAX_ATTEMPTS = 3
RH_POLL_INTERVAL = 5.0
RH_POLL_MAX = 240  # 5s * 240 = 20min 上限

# 进程内取消标记
_CANCELLED: set[int] = set()


def request_cancel(job_id: int) -> None:
    _CANCELLED.add(job_id)


def is_cancelled(job_id: int) -> bool:
    return job_id in _CANCELLED


async def _set_status(job_id: int, *, status: Optional[str] = None, progress: Optional[int] = None,
                      error: Optional[str] = None) -> None:
    async with session_scope() as s:
        job = await s.get(AudioJob, job_id)
        if not job:
            return
        if status is not None:
            job.status = status
        if progress is not None:
            job.progress = progress
        if error is not None:
            job.error = error[:500]
        job.updated_at = datetime.utcnow()


async def _save_rh_task_id(job_id: int, rh_task_id: str) -> None:
    async with session_scope() as s:
        job = await s.get(AudioJob, job_id)
        if not job:
            return
        p = dict(job.params or {})
        p["rh_task_id"] = rh_task_id
        job.params = p
        # 远端任务创建成功的瞬间 = 算力开始计时 (排队时间不算算力)
        if job.started_at is None:
            job.started_at = datetime.utcnow()
        job.updated_at = datetime.utcnow()


async def _load_ref_audio_bytes(oss_key: str) -> bytes:
    with tempfile.NamedTemporaryFile(delete=False, suffix=".audio") as tf:
        tmp = tf.name
    try:
        await oss_client.get_object_to_file_async(oss_key, tmp)
        with open(tmp, "rb") as fh:
            return fh.read()
    finally:
        try:
            _os.unlink(tmp)
        except Exception:  # noqa: BLE001
            pass


async def _rh_task_id_of_job(job_id: int) -> str:
    async with session_scope() as s:
        job = await s.get(AudioJob, job_id)
        tid = (dict(job.params or {}).get("rh_task_id") if job else None)
    if not tid:
        raise RuntimeError(f"audio job {job_id} 无 rh_task_id")
    return str(tid)


async def _mark_finished_and_bill(job_id: int, *, status: str) -> None:
    """任务到达终态时: 补 finished_at, 并落一条 RunningHub 用量记录。

    失败/取消/超时同样落账 —— 远端算力已经消耗掉了, 只是没产出。
    幂等由 record_runninghub 的 (biz_type, job_id) 唯一约束保证: 重复调用只写一次。
    """
    started_at = finished_at = None
    with_user_id = None
    rh_task_id = ""
    try:
        async with session_scope() as s:
            job = await s.get(AudioJob, job_id)
            if not job:
                return
            if job.finished_at is None:
                job.finished_at = datetime.utcnow()
            job.updated_at = datetime.utcnow()
            started_at = job.started_at
            finished_at = job.finished_at
            with_user_id = job.user_id
            rh_task_id = str(dict(job.params or {}).get("rh_task_id") or "")
    except Exception as e:  # noqa: BLE001
        logger.warning("mark finished %s failed: %s", job_id, e)
        return
    if started_at is None or finished_at is None:
        # 未提交到远端 (排队期间被取消等): 没有算力消耗, 不记账
        return
    try:
        await billing_service.record_runninghub(
            biz_type="audio_studio", job_id=job_id, user_id=with_user_id,
            started_at=started_at, finished_at=finished_at,
            rh_task_id=rh_task_id, status=status,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("record runninghub(audio_studio/%s) failed: %s", job_id, e)


async def _finish_from_outputs(job_id: int, user_id: int) -> None:
    """SUCCESS 后: 取产出 URL -> 下载 -> 转存 OSS -> 写 audio asset。"""
    urls = await providers.rh_outputs(await _rh_task_id_of_job(job_id))
    await _set_status(job_id, progress=85)
    saved = 0
    for i, url in enumerate(urls):
        raw = await providers.download_url(url)
        fmt = providers.fmt_from_url(url)
        key = oss_client.build_oss_key(
            user_id=user_id, filename=f"audio_{job_id}_{i}.{fmt}", namespace="audio-studio",
        )
        try:
            await oss_client.put_object_async(key, raw)
        except Exception as e:  # noqa: BLE001
            logger.exception("oss put failed for audio job %s seq %s", job_id, i)
            raise RuntimeError(f"OSS 上传失败: {e}")
        async with session_scope() as s:
            s.add(AudioAsset(
                job_id=job_id, user_id=user_id, oss_key=key, fmt=fmt, seq=i,
            ))
        saved += 1
    await _set_status(job_id, status="succeeded", progress=100)
    logger.info("audio job %s done, %d assets", job_id, saved)


async def _poll(job_id: int, user_id: int) -> None:
    """轮询 RunningHub 任务状态直到终态。"""
    for _ in range(RH_POLL_MAX):
        await asyncio.sleep(RH_POLL_INTERVAL)
        if is_cancelled(job_id):
            await _set_status(job_id, status="canceled", error="用户取消")
            _CANCELLED.discard(job_id)
            await _mark_finished_and_bill(job_id, status="canceled")
            return
        try:
            st = await providers.rh_status(await _rh_task_id_of_job(job_id))
        except Exception as e:  # noqa: BLE001
            logger.warning("audio job %s status query err: %s", job_id, e)
            continue
        if st in ("SUCCESS", "SUCCEED", "SUCCEEDED"):
            await _finish_from_outputs(job_id, user_id)
            await _mark_finished_and_bill(job_id, status="succeeded")
            return
        if st in ("FAILED", "ERROR", "CANCELED", "CANCELLED"):
            await _set_status(job_id, status="failed", error=f"RunningHub 任务 {st}")
            await _mark_finished_and_bill(job_id, status="failed")
            return
        # RUNNING / QUEUED: progress 在 40~80 间缓动
        async with session_scope() as s:
            job = await s.get(AudioJob, job_id)
            cur = job.progress if job else 40
        if cur is not None and cur < 80:
            await _set_status(job_id, progress=min(80, (cur or 40) + 2))
    await _set_status(job_id, status="failed", error="RunningHub 任务超时")
    await _mark_finished_and_bill(job_id, status="timeout")


async def run_audio_job(job_id: int) -> None:
    """后台执行一次音频生成任务 (与生图共享 100 并发)。"""
    async with _SHARED_SEM:
        if is_cancelled(job_id):
            await _set_status(job_id, status="canceled", error="用户取消")
            _CANCELLED.discard(job_id)
            return
        await _set_status(job_id, status="running", progress=10)
        try:
            async with session_scope() as s:
                job = await s.get(AudioJob, job_id)
                if not job:
                    return
                params = dict(job.params or {})
                user_id = job.user_id
            # 播种归属: HTTP 链路本就带上下文, 但重启恢复等无请求路径需要它兜底
            set_usage_context(job_id=job_id, user_id=user_id, source="audio_studio")
            text: str = params.get("text") or ""
            ref_key: str = params.get("ref_audio_oss_key") or ""
            ref_name: str = params.get("ref_audio_filename") or "ref.flac"
            if not text.strip():
                raise RuntimeError("待合成文本为空")
            if not ref_key:
                raise RuntimeError("缺少参考音色音频")

            raw = await _load_ref_audio_bytes(ref_key)
            await _set_status(job_id, progress=25)

            last_err = None
            rh_task_id = None
            for attempt in range(1, _MAX_ATTEMPTS + 1):
                if is_cancelled(job_id):
                    await _set_status(job_id, status="canceled", error="用户取消")
                    _CANCELLED.discard(job_id)
                    return
                try:
                    file_name = await providers.rh_upload_audio(raw, filename=ref_name)
                    await _set_status(job_id, progress=35)
                    rh_task_id = await providers.rh_create_audio(ref_file_name=file_name, text=text)
                    break
                except Exception as e:  # noqa: BLE001
                    last_err = e
                    logger.warning("audio job %s attempt %d/%d failed: %s", job_id, attempt, _MAX_ATTEMPTS, e)
                    if attempt < _MAX_ATTEMPTS:
                        await asyncio.sleep(2 * attempt)
            if rh_task_id is None:
                raise RuntimeError(f"音频生成失败(已重试{_MAX_ATTEMPTS}次): {last_err}")

            await _save_rh_task_id(job_id, rh_task_id)
            await _set_status(job_id, progress=40)
            await _poll(job_id, user_id)
        except Exception as e:  # noqa: BLE001
            logger.exception("audio job %s failed", job_id)
            await _set_status(job_id, status="failed", error=str(e))
            await _mark_finished_and_bill(job_id, status="failed")


async def resume_audio_job(job_id: int) -> None:
    """重启后恢复: 已有 rh_task_id 则直接续查, 否则标记中断。"""
    async with session_scope() as s:
        job = await s.get(AudioJob, job_id)
        if not job:
            return
        params = dict(job.params or {})
        user_id = job.user_id
        rh_task_id = params.get("rh_task_id")
    set_usage_context(job_id=job_id, user_id=user_id, source="audio_studio.resume")
    if not rh_task_id:
        await _set_status(job_id, status="interrupted", error="重启前未取得远端任务ID")
        return
    logger.info("resume audio job %s rh_task=%s", job_id, rh_task_id)
    await _poll(job_id, user_id)


async def create_and_run_generate(
    *,
    user_id: int,
    text: str,
    ref_audio_oss_key: str,
    ref_audio_filename: str = "ref.flac",
) -> int:
    """建任务记录 + 起后台协程, 立即返回 job_id。"""
    async with session_scope() as s:
        job = AudioJob(
            user_id=user_id,
            provider="runninghub",
            model="IndexTTS-1.5",
            status="pending",
            progress=0,
            params={
                "text": text,
                "ref_audio_oss_key": ref_audio_oss_key,
                "ref_audio_filename": ref_audio_filename,
            },
        )
        s.add(job)
        await s.flush()
        job_id = job.id

    asyncio.create_task(run_audio_job(job_id))
    return job_id


async def cancel_job(job_id: int, user_id: int) -> str:
    async with session_scope() as s:
        job = await s.get(AudioJob, job_id)
        if not job or job.user_id != user_id:
            raise ValueError("任务不存在或无权限")
        if job.status in ("succeeded", "failed", "canceled", "interrupted"):
            return job.status
        request_cancel(job_id)
        job.status = "canceled"
        job.error = "用户取消"
        job.updated_at = datetime.utcnow()
        return "canceled"