"""短视频资产库 - 异步流水线服务。

单个资产处理: 已入库(uploaded, 视频已在TOS) → describing(反推画面描述)
              → optimizing(seedance2.0 优化提示词) → done / failed。

存储: 复用 oss.client(本就是火山 TOS, 桶 __REDACTED__)。
反推: video.doubao_video.analyze_video_file → full_text 作为画面描述。
优化: seedance_pe.service.optimize_to_prompt(description) → 纯提示词(失败回退用描述本身)。
"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import uuid

from sqlalchemy import select

from ..db import session_scope
from ..factory.usage import set_usage_context
from ..oss import client as oss_client
from ..video.doubao_video import analyze_video_file
from ..seedance_pe.service import optimize_to_prompt
from ..models.llm import ainvoke_with_fallback
from .models import ClipAsset

log = logging.getLogger("clip-asset")

MAX_SIZE_BYTES = 100 * 1024 * 1024  # 100MB 单视频上限
_ALLOWED_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}

# 反推并发限流: 一次上传几十个视频时, 若同时全部打 Gemini 视频API 会被限流/超时导致大面积失败。
# 用信号量把同时进行的反推控制在 N 个, 其余排队, 逐个跑完。
_PIPELINE_CONCURRENCY = 3
_pipeline_sem: "asyncio.Semaphore | None" = None


def _get_sem() -> "asyncio.Semaphore":
    global _pipeline_sem
    if _pipeline_sem is None:
        _pipeline_sem = asyncio.Semaphore(_PIPELINE_CONCURRENCY)
    return _pipeline_sem


def is_allowed_video(filename: str) -> bool:
    ext = os.path.splitext(filename or "")[1].lower()
    return ext in _ALLOWED_EXT


def upload_local_to_tos(local_path: str, *, user_id: int, filename: str) -> tuple[str, str]:
    """把本地视频上传到 TOS(桶 __REDACTED__), 返回 (oss_key, 预签名播放URL)。"""
    from ..config import get_settings

    s = get_settings()
    key = oss_client.build_oss_key(user_id=user_id, filename=filename, namespace="clip-assets")
    # 走内网 endpoint 上传(免公网流量费)
    cli = oss_client.get_client_internal()
    cli.put_object_from_file(s.aliyun_oss_bucket, key, local_path)
    play_url = oss_client.sign_get_url(key, ttl_seconds=7 * 24 * 3600)
    return key, play_url


async def save_upload_and_enqueue(
    *,
    file_bytes: bytes,
    filename: str,
    user_id: int,
    is_public: bool,
    category: str,
    batch_id: str = "",
) -> int:
    """把上传的视频存 TOS + 建 ClipAsset(uploaded) 记录, 并异步触发流水线。返回 asset_id。"""
    if len(file_bytes) > MAX_SIZE_BYTES:
        raise ValueError(f"视频超过 100MB 限制({len(file_bytes) // 1024 // 1024}MB)")
    if not is_allowed_video(filename):
        raise ValueError(f"不支持的视频格式: {filename}")

    title = os.path.splitext(os.path.basename(filename or "视频"))[0][:160]
    category = (category or "未分类").strip()[:80] or "未分类"

    # 先落 TOS(在线程池里做同步 IO)
    suffix = os.path.splitext(filename or "v.mp4")[1] or ".mp4"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(file_bytes)
        tmp.flush()
        tmp.close()
        oss_key, play_url = await asyncio.to_thread(
            upload_local_to_tos, tmp.name, user_id=user_id, filename=filename
        )
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass

    async with session_scope() as s:
        asset = ClipAsset(
            user_id=user_id,
            is_public=is_public,
            category=category,
            title=title,
            video_oss_key=oss_key,
            video_url=play_url,
            size_bytes=len(file_bytes),
            status="uploaded",
            batch_id=batch_id,
        )
        s.add(asset)
        await s.flush()
        asset_id = asset.id

    # 异步跑反推+优化(不阻塞上传响应)
    asyncio.create_task(run_pipeline(asset_id))
    return asset_id


async def run_pipeline(asset_id: int) -> None:
    """对单个资产跑 反推→优化, 更新状态。视频保留(资产库需要播放)。

    并发限流: 通过全局信号量把同时进行的反推控制在 _PIPELINE_CONCURRENCY 个,
    避免一次上传几十个视频时同时打爆 Gemini 视频API 导致大面积失败。
    """
    async with _get_sem():
        await _run_pipeline_inner(asset_id)


async def _run_pipeline_inner(asset_id: int) -> None:
    # 取记录
    async with session_scope() as s:
        asset = (await s.execute(select(ClipAsset).where(ClipAsset.id == asset_id))).scalar_one_or_none()
        if not asset:
            return
        oss_key = asset.video_oss_key
        title = asset.title
        owner_id = asset.user_id  # NOT NULL, 可安全作为计费归属

    # 播种归属: 本函数由 asyncio.create_task 拉起(HTTP 链路会复制上下文),
    # 但也可能从无请求上下文的恢复/守护路径进入 —— 显式盖章保证不丢人。
    set_usage_context(job_id=None, user_id=owner_id, source="clip_asset")

    # 下载回本地临时文件供 Gemini 反推
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
    tmp.close()
    try:
        await _set_status(asset_id, "describing")
        await asyncio.to_thread(oss_client.get_object_to_file, oss_key, tmp.name)

        # ① 分段反推: 把视频按 10s 切段, 所有分段并发反推, 再用 AI 把各段结果拼接成
        #    连贯完整的画面描述。此前"整段视频一次性反推"因上游对长视频推理耗时长且不
        #    稳定, 频繁 ReadTimeout / 502; 分段后每个请求只含 10s 短片, 上游压力小、
        #    快且稳, 并发跑完再拼接, 兼顾速度与成功率。
        try:
            description = await _analyze_video_segmented(
                asset_id, tmp.name, title or "资产视频", user_id=owner_id,
            )
        except Exception as e:  # noqa: BLE001
            await _fail(asset_id, f"反推失败: {type(e).__name__}: {e}".strip())
            return
        if not description:
            await _fail(asset_id, "反推失败: 所有分段均无有效结果")
            return

        # ② seedance2.0 优化提示词(失败回退用描述本身, 不阻断)
        await _set_status(asset_id, "optimizing", description=description)
        prompt = None
        try:
            prompt = await optimize_to_prompt(description, provider="gemini")
        except Exception as e:  # noqa: BLE001
            log.warning("asset %s 优化失败(回退用描述): %s", asset_id, e)
        prompt = (prompt or description).strip()

        await _finish(asset_id, description=description, prompt=prompt)
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


# 单段反推的时长(秒)。每段单独送模型, 请求小、快、稳。
_SEGMENT_SECONDS = 10
# 每段反推重试次数(段更小, 偶发超时/502 重试一次通常即可)
_SEGMENT_RETRY = 2


def _split_video_to_segments(src_path: str, seg_seconds: int = _SEGMENT_SECONDS) -> list[str]:
    """用 ffmpeg 把视频按固定时长切成多段, 每段同时降规格(480p/8fps/去音轨/CRF32)。

    返回按时间顺序排列的分段文件路径列表。切段与压缩一次完成(重编码, 保证每段可独立解码)。
    """
    import subprocess

    seg_dir = tempfile.mkdtemp(prefix="clipseg_")
    pattern = os.path.join(seg_dir, "seg_%04d.mp4")
    cmd = [
        "ffmpeg", "-y", "-i", src_path,
        "-vf", "scale='min(480,iw)':'-2'",
        "-r", "8",
        "-an",
        "-c:v", "libx264", "-preset", "faster", "-crf", "32",
        "-f", "segment",
        "-segment_time", str(seg_seconds),
        "-reset_timestamps", "1",
        "-movflags", "+faststart",
        pattern,
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=300)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg segment rc={proc.returncode}: {proc.stderr[-300:].decode('utf-8','ignore')}")
    segs = sorted(
        os.path.join(seg_dir, f) for f in os.listdir(seg_dir) if f.startswith("seg_")
    )
    return segs


async def _analyze_video_segmented(asset_id: int, video_path: str, title: str,
                                   *, user_id: int | None = None) -> str:
    """分段反推 → 并发跑各段 → AI 拼接为连贯完整描述。

    1. ffmpeg 把视频切成 10s 一段(同时降规格)。
    2. 所有分段**同时并发**调 analyze_video_file(每段一次, 带少量重试)。
    3. 按时间顺序收集各段小说体片段, 用 LLM 拼接去重、消除段间割裂, 输出连贯完整描述。
    单段全失败时该段跳过; 若所有段都失败则返回空字符串(上层判为反推失败)。
    """
    segs: list[str] = []
    seg_dir: str | None = None
    try:
        segs = await asyncio.to_thread(_split_video_to_segments, video_path)
        if segs:
            seg_dir = os.path.dirname(segs[0])
        if not segs:
            # 切段失败兜底: 整段跑一次
            res = await analyze_video_file(video_path, draft_title=title, episode_order=1,
                                           user_id=user_id)
            return (res.get("full_text") or "").strip()

        log.info("asset %s 分段反推: 共 %d 段(每段%ds), 并发处理", asset_id, len(segs), _SEGMENT_SECONDS)

        async def _one(idx: int, path: str) -> tuple[int, str]:
            last = None
            for attempt in range(_SEGMENT_RETRY):
                try:
                    res = await analyze_video_file(
                        path, draft_title=f"{title} 片段{idx + 1}", episode_order=idx + 1,
                        user_id=user_id,
                    )
                    txt = (res.get("full_text") or "").strip()
                    if txt:
                        return idx, txt
                    last = "空结果"
                except Exception as e:  # noqa: BLE001
                    last = f"{type(e).__name__}: {e}"
                    if attempt < _SEGMENT_RETRY - 1:
                        await asyncio.sleep(2 + attempt * 3)
            log.warning("asset %s 第%d段反推失败: %s", asset_id, idx + 1, last)
            return idx, ""

        # 所有分段同时并发反推
        results = await asyncio.gather(*[_one(i, p) for i, p in enumerate(segs)])
        parts = [txt for _, txt in sorted(results, key=lambda x: x[0]) if txt]
        if not parts:
            return ""

        # 只有一段直接返回, 无需拼接
        if len(parts) == 1:
            return parts[0]

        # AI 拼接: 把按时序排列的分段复述整合成一篇连贯完整的画面描述
        numbered = "\n\n".join(f"【片段{i + 1}】\n{p}" for i, p in enumerate(parts))
        stitch_prompt = (
            "下面是同一段短视频按时间先后切成多个片段后, 各片段分别生成的画面复述。"
            "请把它们整合成一篇连贯、完整、不重复的小说体复述:\n"
            "- 严格保持时间先后顺序, 衔接自然, 消除片段之间的重复叙述和割裂感;\n"
            "- 保留所有台词原话与关键动作, 不要总结、不要遗漏情节;\n"
            "- 统一人物代号(男1/女1/…), 同一人物前后一致;\n"
            "- 只输出整合后的正文, 不要加任何说明、标题或分段标记。\n\n"
            f"{numbered}"
        )
        try:
            resp = await ainvoke_with_fallback(
                stitch_prompt, role="generate", temperature=0.3, primary="deepseek", max_tokens=8192
            )
            stitched = (getattr(resp, "content", "") or "").strip()
            if stitched:
                log.info("asset %s 分段拼接完成: %d段 -> %d字", asset_id, len(parts), len(stitched))
                return stitched
        except Exception as e:  # noqa: BLE001
            log.warning("asset %s 分段AI拼接失败(回退直接拼): %s", asset_id, e)

        # 拼接失败兜底: 直接按顺序拼起来
        return "\n\n".join(parts)
    finally:
        # 清理分段临时文件与目录
        for p in segs:
            try:
                os.unlink(p)
            except Exception:
                pass
        if seg_dir:
            try:
                os.rmdir(seg_dir)
            except Exception:
                pass


async def _set_status(asset_id: int, status: str, *, description: str | None = None) -> None:
    async with session_scope() as s:
        a = (await s.execute(select(ClipAsset).where(ClipAsset.id == asset_id))).scalar_one_or_none()
        if not a:
            return
        a.status = status
        if description is not None:
            a.description = description


async def _finish(asset_id: int, *, description: str, prompt: str) -> None:
    async with session_scope() as s:
        a = (await s.execute(select(ClipAsset).where(ClipAsset.id == asset_id))).scalar_one_or_none()
        if not a:
            return
        a.description = description
        a.prompt = prompt
        a.status = "done"
        a.error = ""


async def _fail(asset_id: int, msg: str) -> None:
    async with session_scope() as s:
        a = (await s.execute(select(ClipAsset).where(ClipAsset.id == asset_id))).scalar_one_or_none()
        if not a:
            return
        a.status = "failed"
        a.error = msg[:1000]


def new_batch_id() -> str:
    return uuid.uuid4().hex[:16]


def category_from_relpath(relpath: str) -> str:
    """从 webkitRelativePath 解析分类(只吃一层子文件夹, 更深按最近父目录名)。

    '素材/悬疑/c.mp4' -> '悬疑'
    '素材/a.mp4'      -> '未分类' (根目录文件)
    '素材/悬疑/深层/d.mp4' -> '深层' (最近父目录)
    """
    parts = [p for p in (relpath or "").replace("\\", "/").split("/") if p]
    # parts[0] 是用户选的顶层文件夹名, 最后一个是文件名
    if len(parts) <= 2:
        return "未分类"
    return parts[-2].strip()[:80] or "未分类"