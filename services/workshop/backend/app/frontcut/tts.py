"""前贴流水线 — 语音克隆口播合成辅助。

复用 audio_studio 已封装的 RunningHub IndexTTS-1.5 语音克隆工作流:
  上传参考音频(拿 fileName) → 用文本+参考音色创建任务 → 轮询 → 取产物音频URL → 下载转存OSS。

用途:
- 原片口播: reverse_summary(完整剧情文案) → 一段音频
- 5 条前贴口播: 每条 narration → 各一段音频
参考音色对同一任务只需上传一次, 5+1 段共用同一个 ref_file_name。

计费: 每段口播是一次独立远端任务, 用 stable_biz_key(biz_type, biz_key) 做幂等键
落 runninghub_billing(biz_type="frontcut_tts")。见 billing/service.stable_biz_key。
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime

import httpx

from ..audio_studio import providers as rh_audio
from ..billing import service as billing_service
from ..oss import client as oss

logger = logging.getLogger("frontcut.tts")

_POLL_INTERVAL = 5
_POLL_MAX = 300  # 单段最长等 5 分钟


async def upload_ref_voice(raw: bytes, *, filename: str = "ref.wav") -> str:
    """上传参考音色到 RunningHub, 返回 fileName(供本任务多段合成复用)。"""
    return await rh_audio.rh_upload_audio(raw, filename=filename)


async def synth_one(*, ref_file_name: str, text: str, oss_namespace: str, oss_filename: str) -> str:
    """用参考音色 + 文本合成一段口播音频, 转存 OSS, 返回 oss_key。

    ref_file_name: upload_ref_voice 返回的 RunningHub fileName。
    oss_filename 兼作计费幂等键(调用方保证同一次合成的文件名稳定可复现)。
    失败抛异常, 由调用方捕获。
    """
    text = (text or "").strip()
    if not text:
        raise ValueError("口播文本为空")
    task_id = await rh_audio.rh_create_audio(ref_file_name=ref_file_name, text=text)
    # 远端任务创建成功的瞬间 = 算力开始计时 (上传参考音/排队的耗时不算)
    started_at = datetime.utcnow()
    ok = False
    waited = 0
    try:
        while waited < _POLL_MAX:
            st = (await rh_audio.rh_status(task_id)).upper()
            if st in ("SUCCESS", "SUCCEEDED", "COMPLETED"):
                urls = await rh_audio.rh_outputs(task_id)
                if not urls:
                    raise RuntimeError("TTS 成功但无产物音频")
                audio_url = urls[0]
                async with httpx.AsyncClient(timeout=300.0) as c:
                    r = await c.get(audio_url)
                    r.raise_for_status()
                    raw = r.content
                key = oss.build_oss_key(user_id=0, filename=oss_filename, namespace=oss_namespace)
                await asyncio.to_thread(oss.get_bucket_public().put_object, key, raw)
                ok = True
                return key
            if st in ("FAILED", "ERROR", "FAIL"):
                raise RuntimeError(f"TTS 任务 {st}")
            await asyncio.sleep(_POLL_INTERVAL)
            waited += _POLL_INTERVAL
        raise RuntimeError("TTS 任务超时")
    finally:
        # 失败/超时同样落账: 远端算力已经消耗掉了, 只是没产出
        try:
            await billing_service.record_runninghub(
                biz_type="frontcut_tts",
                job_id=billing_service.stable_biz_key("frontcut_tts", oss_filename),
                biz_key=oss_filename,
                started_at=started_at, finished_at=datetime.utcnow(),
                rh_task_id=str(task_id or ""),
                status="succeeded" if ok else "failed",
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("frontcut tts billing failed (%s): %s", oss_filename, e)