"""RunningHub SparkVideo 2.0 视频生成 provider。

标准模型 API (与 audio_studio 的工作流 API 不同端点族):
  提交: POST /openapi/v2/rhart-video/sparkvideo-2.0/multimodal-video  (Bearer key)
  轮询: POST /openapi/v2/query  { taskId }  → status SUCCESS/FAILED/...
  产出 url 24h 失效 → 须及时下载转存。
"""
from __future__ import annotations

import os
import logging

import httpx

logger = logging.getLogger("clip.video_provider")

_SUBMIT_PATH = "/openapi/v2/rhart-video/sparkvideo-2.0/multimodal-video"
_QUERY_PATH = "/openapi/v2/query"


def _cfg() -> tuple[str, str]:
    key = os.environ.get("RUNNINGHUB_API_KEY", "").strip()
    base = os.environ.get("RUNNINGHUB_BASE_URL", "https://www.runninghub.cn").rstrip("/")
    if not key:
        raise RuntimeError("RUNNINGHUB_API_KEY not configured")
    return key, base


async def submit_video(
    *,
    prompt: str,
    image_urls: list[str] | None = None,
    video_urls: list[str] | None = None,
    resolution: str = "480p",
    duration: str = "5",
    ratio: str = "9:16",
    generate_audio: bool = True,
    real_person_mode: bool = True,
    timeout: float = 120.0,
) -> str:
    """提交视频生成任务, 返回 taskId。"""
    key, base = _cfg()
    payload: dict = {
        "prompt": prompt,
        "resolution": resolution,
        "duration": str(duration),
        "imageUrls": image_urls or [],
        "videoUrls": video_urls or [],
        "audioUrls": [],
        "generateAudio": bool(generate_audio),
        # 归一化: 中文冒号/全角→半角, 去空格(防旧任务或误输入的 "4：3" 触发 seedance 1007)
        "ratio": (ratio or "9:16").replace("：", ":").replace(" ", "").strip(),
        "realPersonMode": bool(real_person_mode),
        "conversionSlots": ["all"],
        "returnLastFrame": False,
        "seed": -1,
    }
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(f"{base}{_SUBMIT_PATH}", headers=headers, json=payload)
    if r.status_code != 200:
        raise RuntimeError(f"RH video submit HTTP {r.status_code}: {r.text[:300]}")
    d = r.json()
    tid = d.get("taskId")
    status = (d.get("status") or "").upper()
    if not tid:
        raise RuntimeError(f"RH video submit no taskId: {str(d)[:300]}")
    if status == "FAILED":
        raise RuntimeError(f"RH video submit failed: {d.get('errorMessage') or d}")
    return str(tid)


async def query_video(task_id: str, *, timeout: float = 60.0) -> dict:
    """查询任务, 返回 { status, video_url|None, raw }。"""
    key, base = _cfg()
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}
    async with httpx.AsyncClient(timeout=timeout) as c:
        r = await c.post(f"{base}{_QUERY_PATH}", headers=headers, json={"taskId": task_id})
    if r.status_code != 200:
        raise RuntimeError(f"RH video query HTTP {r.status_code}: {r.text[:300]}")
    d = r.json()
    status = (d.get("status") or "").upper()
    video_url = None
    for it in (d.get("results") or []):
        if isinstance(it, dict):
            ot = (it.get("outputType") or "").lower()
            u = it.get("url")
            if u and (ot in ("mp4", "mov", "webm") or u.lower().split("?")[0].endswith((".mp4", ".mov", ".webm"))):
                video_url = u
                break
    # 兜底: 没匹配到视频后缀但有 url
    if not video_url:
        for it in (d.get("results") or []):
            if isinstance(it, dict) and it.get("url"):
                video_url = it["url"]
                break
    # 失败原因: RH 各版本字段名不一, 尽量都取
    reason = (
        d.get("errorMessage") or d.get("failedReason") or d.get("error")
        or d.get("msg") or d.get("message") or ""
    )
    return {"status": status, "video_url": video_url, "reason": reason, "raw": d}


async def download(url: str, *, timeout: float = 600.0) -> bytes:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as c:
        r = await c.get(url)
        if r.status_code != 200:
            raise RuntimeError(f"video download HTTP {r.status_code}")
        return r.content