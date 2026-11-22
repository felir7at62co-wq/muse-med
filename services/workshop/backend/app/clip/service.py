"""短视频流水线服务层。

compose: 1 次 AI → 创意 + 视频提示词(再走 seedance-pe 优化) + 首帧图提示词 + 亮点
gen_image: 复用 image_studio.providers 文生图 → 转存 OSS
gen_video: RunningHub SparkVideo 2.0 提交 + 轮询 + 下载转存 OSS
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Optional

from sqlalchemy import select

from ..db import session_scope
from ..models.llm import get_llm
from ..oss import client as oss_client
from ..image_studio import providers as image_providers
from ..seedance_pe.service import optimize_to_prompt
from ..volc import client as volc_video
from ..volc import billing as volc_billing
from .models import ClipJob

logger = logging.getLogger("clip.service")

# 首帧图生成用的模型
#
# ⚠️ 2026-10-14 改。原为 "rh-image-g-2-t2i"（RunningHub 低价文生图），随该渠道一起被摘除 ——
# 上游 CN 节点合规下线了 RunningHub 的托管生图模型（40310）。**不改这里会直接坏掉**：
# providers.generate() 里那个 model 分支已删除，会落到 `unsupported model` 抛错，
# 用户看到"生成首帧图失败"。
#
# 换成 gpt-image-2（zx1 主 + kege 兜底），它支持文生图且已有既定的尺寸/计费口径。
_IMAGE_MODEL = "gpt-image-2"
# 9:16 竖屏首帧图尺寸
_IMAGE_SIZE = "768x1344"


# ============================================================
# ② 合成 (1 次 AI): 创意 + 视频提示词 + 首帧图提示词 + 亮点
# ============================================================

_COMPOSE_SYS = """你是短视频创意与提示词专家。用户会给你一段输入(可能是: 简单思路 / 一段视频反推出的脚本 / 用户写好的脚本)。
请基于输入做轻量改编或再创作, 一次性产出一条可直接用于 AI 视频生成的方案。

严格输出 JSON(不要 markdown 代码块外的任何多余文字), 字段:
{
  "title": "8字内短标题",
  "creative": "一句话视频创意(改编/再创作后的核心画面与情节, 30-60字)",
  "video_prompt": "完整的视频生成提示词(主体+动作+环境+运镜+情绪, 适配竖屏短视频, 100-200字)",
  "image_prompt": "首帧图提示词(描述视频第一帧的静态画面, 用于先生成首帧图, 80-150字)",
  "highlights": "2-3条亮点说明, 说明画面效果/情绪钩子/为什么吸引人(分行, 每行以 - 开头)"
}
保留用户原意; 输入是写好的脚本时以改编润色为主、不要大改设定。"""


def _extract_json(text: str) -> Optional[dict]:
    if not text:
        return None
    # 去掉可能的 ```json 包裹
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    raw = m.group(1) if m else text
    # 取第一个 { 到最后一个 }
    s, e = raw.find("{"), raw.rfind("}")
    if s >= 0 and e > s:
        raw = raw[s:e + 1]
    try:
        return json.loads(raw)
    except Exception:
        return None


async def compose(job_id: int, *, provider: str = "gemini") -> dict:
    """对 job 的输入做合成(创意+提示词+首帧图提示词+亮点), 写回 DB。"""
    async with session_scope() as s:
        job = await s.get(ClipJob, job_id)
        if not job:
            return {"ok": False, "error": "job 不存在"}
        input_text = (job.input_text or "").strip()
    if not input_text:
        return {"ok": False, "error": "输入为空"}

    from langchain_core.messages import SystemMessage, HumanMessage
    try:
        llm = get_llm("generate", temperature=0.7, provider=provider)  # type: ignore[arg-type]
        resp = await llm.ainvoke([
            SystemMessage(content=_COMPOSE_SYS),
            HumanMessage(content=input_text),
        ])
        text = getattr(resp, "content", "") if resp else ""
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"AI 合成失败: {e}"}

    data = _extract_json(str(text))
    if not data:
        return {"ok": False, "error": "AI 返回无法解析, 请重试"}

    video_prompt = (data.get("video_prompt") or "").strip()
    # 视频提示词再走 seedance-pe 优化(失败回退原稿)
    try:
        opt = await optimize_to_prompt(video_prompt)
        if opt and opt.strip():
            video_prompt = opt.strip()
    except Exception:
        logger.exception("clip compose: seedance-pe optimize failed (fallback)")

    async with session_scope() as s:
        job = await s.get(ClipJob, job_id)
        if not job:
            return {"ok": False, "error": "job 不存在"}
        job.title = (data.get("title") or job.title or "未命名短视频")[:120]
        job.creative = (data.get("creative") or "").strip()
        job.video_prompt = video_prompt
        job.image_prompt = (data.get("image_prompt") or "").strip()
        job.highlights = (data.get("highlights") or "").strip()
        job.status = "composed"
        job.progress = 30

    return {"ok": True}


# ============================================================
# ③ 生成首帧图 → 转存 OSS
# ============================================================

async def gen_image(job_id: int) -> dict:
    async with session_scope() as s:
        job = await s.get(ClipJob, job_id)
        if not job:
            return {"ok": False, "error": "job 不存在"}
        prompt = (job.image_prompt or "").strip()
        user_id = job.user_id
    if not prompt:
        return {"ok": False, "error": "首帧图提示词为空, 请先合成"}

    try:
        imgs = await image_providers.generate(model=_IMAGE_MODEL, prompt=prompt, n=1, size=_IMAGE_SIZE)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"生成首帧图失败: {e}"}
    if not imgs:
        return {"ok": False, "error": "未生成首帧图"}

    raw = imgs[0]
    try:
        key = oss_client.build_oss_key(user_id=user_id, filename="clip_first_frame.png", namespace="clip")
        await oss_client.put_object_async(key, raw)
        url = oss_client.sign_get_url(key, ttl_seconds=3600)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"首帧图转存失败: {e}"}

    async with session_scope() as s:
        job = await s.get(ClipJob, job_id)
        if job:
            job.image_oss_key = key
            job.image_url = url
            job.status = "image_done"
            job.progress = 55
    return {"ok": True, "image_url": url}


# ============================================================
# ④ 生成视频 (火山官方 Seedance 2.0): 提交 + 轮询 + 转存 + 计费
# ============================================================

_POLL_INTERVAL = 8      # 秒
_POLL_MAX = 150         # 最多 ~20 分钟


async def gen_video(job_id: int) -> dict:
    """提交并后台轮询; 立即返回, 进度看 GET /{id}。视频生成走火山官方 Seedance。"""
    async with session_scope() as s:
        job = await s.get(ClipJob, job_id)
        if not job:
            return {"ok": False, "error": "job 不存在"}
        prompt = (job.video_prompt or "").strip()
        image_url = (job.image_url or "").strip()
        user_id = job.user_id
        params = dict(job.params or {})
    if not prompt:
        return {"ok": False, "error": "视频提示词为空"}

    resolution = params.get("resolution", "480p")
    ratio = params.get("ratio", "9:16")
    duration = str(params.get("duration", "5"))
    generate_audio = bool(params.get("generateAudio", True))

    # 首帧图作为参考图(若有)
    image_urls = [image_url] if image_url else []
    # image_url 可能已过期(1h签名), 重新签一个长效的
    if image_urls:
        try:
            async with session_scope() as s:
                job = await s.get(ClipJob, job_id)
                if job and job.image_oss_key:
                    image_urls = [oss_client.sign_get_url(job.image_oss_key, ttl_seconds=7200)]
        except Exception:
            pass

    try:
        task_id = await volc_video.submit_video(
            prompt=prompt,
            image_urls=image_urls,
            resolution=resolution,
            duration=duration,
            ratio=ratio,
            generate_audio=generate_audio,
        )
    except Exception as e:  # noqa: BLE001
        async with session_scope() as s:
            job = await s.get(ClipJob, job_id)
            if job:
                job.status = "failed"
                job.error = f"提交视频失败: {e}"
        return {"ok": False, "error": f"提交视频失败: {e}"}

    async with session_scope() as s:
        job = await s.get(ClipJob, job_id)
        if job:
            job.rh_task_id = task_id  # 复用字段存火山 task id
            job.status = "video_running"
            job.progress = 60

    asyncio.create_task(_poll_video(
        job_id, task_id, user_id,
        resolution=resolution, duration=duration, ratio=ratio, generate_audio=generate_audio,
    ))
    return {"ok": True, "rh_task_id": task_id}


async def _poll_video(job_id: int, task_id: str, user_id: int, *,
                      resolution: str = "", duration: str = "5",
                      ratio: str = "", generate_audio: bool = True) -> None:
    for i in range(_POLL_MAX):
        await asyncio.sleep(_POLL_INTERVAL)
        try:
            res = await volc_video.query_video(task_id)
        except Exception as e:  # noqa: BLE001
            logger.warning("clip poll error job=%d: %s", job_id, e)
            continue
        status = res["status"]
        if status in ("RUNNING", "QUEUED", "PENDING", "SUBMITTED", ""):
            # 进度缓增到 90
            async with session_scope() as s:
                job = await s.get(ClipJob, job_id)
                if job and job.progress < 90:
                    job.progress = min(90, 60 + i)
            continue
        if status in ("FAILED", "ERROR", "CANCELED", "CANCELLED"):
            async with session_scope() as s:
                job = await s.get(ClipJob, job_id)
                if job:
                    job.status = "failed"
                    job.error = f"视频生成失败: {str(res.get('raw'))[:300]}"
            return
        if status in ("SUCCESS", "SUCCEEDED", "COMPLETED"):
            # 计费: 用返回 usage 精确计, 缺失则按参数档位兜底估算
            try:
                u = volc_billing.extract_usage({"usage": res.get("usage") or {}})
                await volc_billing.record_usage(
                    biz_type="video_gen",
                    model_key=volc_billing.MK_VIDEO_GEN,
                    user_id=user_id,
                    source="clip",
                    request_id=task_id,
                    prompt_tokens=u["prompt_tokens"],
                    completion_tokens=u["completion_tokens"],
                    total_tokens=u["total_tokens"],
                    resolution=resolution,
                    duration_sec=float(duration or 0),
                    ratio=ratio,
                    has_audio=generate_audio,
                    draft_id=job_id,
                )
            except Exception:  # noqa: BLE001
                logger.warning("clip 视频生成计费记录失败(不阻断)", exc_info=True)

            url = res.get("video_url")
            if not url:
                async with session_scope() as s:
                    job = await s.get(ClipJob, job_id)
                    if job:
                        job.status = "failed"
                        job.error = "成功但未取到视频URL"
                return
            # 下载转存 OSS(火山产出 URL 有失效期, 及时转存)
            try:
                raw = await volc_video.download(url)
                key = oss_client.build_oss_key(user_id=user_id, filename="clip_video.mp4", namespace="clip")
                await oss_client.put_object_async(key, raw)
                final_url = oss_client.sign_get_url(key, ttl_seconds=7 * 24 * 3600)
            except Exception as e:  # noqa: BLE001
                # 转存失败也保留原始 URL(24h 内可用)
                logger.exception("clip video transfer failed job=%d", job_id)
                async with session_scope() as s:
                    job = await s.get(ClipJob, job_id)
                    if job:
                        job.video_url = url
                        job.status = "done"
                        job.progress = 100
                        job.error = f"(已出视频但转存OSS失败, 用临时链接, 24h内有效: {e})"
                return
            async with session_scope() as s:
                job = await s.get(ClipJob, job_id)
                if job:
                    job.video_oss_key = key
                    job.video_url = final_url
                    job.status = "done"
                    job.progress = 100
            return
    # 超时
    async with session_scope() as s:
        job = await s.get(ClipJob, job_id)
        if job and job.status == "video_running":
            job.status = "failed"
            job.error = "视频生成超时(>20分钟)"