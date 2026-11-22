"""小说转视频 — 核心流水线。

流程: 建 job → 拆音频chunk/图片shot → 并发生成配音(RunningHub IndexTTS) + 并发生图(image2, 带全局画风+统一垫图)
      → ffmpeg 拼整段配音得总时长 T → 图片张数=ceil(T/每张秒数) → 逐图 Ken Burns 片段 → concat+配音 → 成片 → OSS。

复用:
- 生图: image_studio.providers.generate(model, prompt, n, size, ref_images=[bytes])
- 配音: audio_studio.providers.rh_upload_audio / rh_create_audio / rh_status / rh_outputs / download_url
- OSS: app.oss.client
"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import tempfile
import uuid
from datetime import datetime
from typing import Optional

from ..config import get_settings
from ..db import session_scope
from ..oss import client as oss_client
from ..billing import service as billing_service
from ..factory.usage import set_usage_context
from ..audio_studio import providers as audio_providers
from ..image_studio import providers as image_providers
from .models import NovelVideoAudioChunk, NovelVideoJob, NovelVideoShot, NovelVideoVoice
from .text_split import split_for_audio, split_for_images
from . import subtitle as subtitle_mod

logger = logging.getLogger(__name__)

# 与全局高并发一致(不擅自降)。生图/配音各自的信号量。
_IMG_SEM = asyncio.Semaphore(100)
_AUDIO_SEM = asyncio.Semaphore(100)

_POLL_INTERVAL = 5
_POLL_MAX = 900  # 单个音频任务最长等待秒

# 合成(Ken Burns 重编码)是 CPU 密集。本进程内限 2 并发合成(单 worker 内)。
# 全自动模式下大量任务入队时, 靠此信号量串行化 CPU 阶段(生图/配音是外部API, 不受此限)。
_COMPOSE_SEM = asyncio.Semaphore(2)

# ffmpeg 线程预算(每个 worker 容器的合成最多占用的 CPU 核数)。
# 算力机 16 核, 计划跑 4 个 worker 容器 → 每个 worker 分 16/4 = 4 核, 避免多 worker
# 同时合成时 CPU 超订(oversubscription)导致互相抢核、单个合成反而变慢。
# 说明: 多个 worker 是独立进程/容器, 不共享 _COMPOSE_SEM, 故必须靠 ffmpeg -threads 显式
#       限核, 而不能只靠进程内信号量。可用环境变量 NV_FFMPEG_THREADS 覆盖(默认4)。
_FFMPEG_THREADS = int(os.getenv("NV_FFMPEG_THREADS", "4"))
# Ken Burns 分段渲染的并发路数(每 worker 内)。每路 ffmpeg 单线程即可(单图 zoompan 不吃多核),
# 路数 = 线程预算, 使 Ken Burns 阶段总占用 ≈ _FFMPEG_THREADS 核。
_SEG_CONCURRENCY = _FFMPEG_THREADS


async def _set_job(job_id: int, **kw) -> None:
    async with session_scope() as s:
        job = await s.get(NovelVideoJob, job_id)
        if not job:
            return
        for k, v in kw.items():
            setattr(job, k, v)


async def _oss_put(raw: bytes, *, user_id: int, namespace: str, ext: str) -> str:
    """上传字节到对象存储。**异步版**：tos SDK 是同步的，放进线程池。

    2026-10-21：原同步版直接写在 async 调用链里，一次上传就按住整个事件循环。
    """
    key = oss_client.build_oss_key(user_id=user_id, filename=f"{uuid.uuid4().hex}.{ext}", namespace=namespace)
    await oss_client.put_object_async(key, raw)
    return key


async def _load_bytes(oss_key: str) -> bytes:
    loop = asyncio.get_event_loop()

    def _read():
        with tempfile.NamedTemporaryFile(delete=False) as tf:
            tmp = tf.name
        try:
            oss_client.get_object_to_file(oss_key, tmp)
            with open(tmp, "rb") as f:
                return f.read()
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    return await loop.run_in_executor(None, _read)


def _ffprobe_duration(path: str) -> float:
    """取音频/视频时长(秒)。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, timeout=60,
        )
        return float((out.stdout or b"0").decode().strip() or 0)
    except Exception:  # noqa: BLE001
        return 0.0


# ---------------- 配音 ----------------
async def _bill_audio_chunk(chunk_id: int, status: str) -> None:
    """落一条 RunningHub 用量记录(biz_type=novel_audio, job_id=chunk_id)。

    失败/超时同样落账 —— 远端算力已消耗。幂等由 (biz_type, job_id) 唯一约束保证。
    归属用户从所属 NovelVideoJob 取(chunk 自身没有 user_id 列)。
    """
    chunk = None
    try:
        async with session_scope() as s:
            chunk = await s.get(NovelVideoAudioChunk, chunk_id)
            if not chunk:
                return
            job = await s.get(NovelVideoJob, chunk.job_id)
            owner_id = getattr(job, "user_id", None)
            started_at = chunk.started_at
            finished_at = chunk.finished_at
            rh_task_id = chunk.rh_task_id or ""
    except Exception as e:  # noqa: BLE001
        logger.warning("bill audio chunk %s: load failed: %s", chunk_id, e)
        return
    if started_at is None or finished_at is None:
        return  # 未提交到远端, 无算力消耗
    try:
        await billing_service.record_runninghub(
            biz_type="novel_audio", job_id=chunk_id, user_id=owner_id,
            started_at=started_at, finished_at=finished_at,
            rh_task_id=str(rh_task_id), status=status,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("record runninghub(novel_audio/%s) failed: %s", chunk_id, e)


async def _gen_one_audio(chunk_id: int, ref_name: str) -> None:
    """生成单个音频分片 → OSS。ref_name 为已上传到 RunningHub 的参考音色 fileName。"""
    async with _AUDIO_SEM:
        async with session_scope() as s:
            c = await s.get(NovelVideoAudioChunk, chunk_id)
            if not c:
                return
            text = c.text_chunk or ""
            c.status = "running"
        task_id = ""
        ok = False
        try:
            task_id = await audio_providers.rh_create_audio(ref_file_name=ref_name, text=text)
            # 远端任务已创建: 从这一刻起算算力时长(此前在信号量上排队的时间不算)
            async with session_scope() as s:
                c = await s.get(NovelVideoAudioChunk, chunk_id)
                if c:
                    c.rh_task_id = task_id
                    if c.started_at is None:
                        c.started_at = datetime.utcnow()
            # 轮询
            waited = 0
            status = ""
            while waited < _POLL_MAX:
                status = str(await audio_providers.rh_status(task_id)).upper()
                if status in ("SUCCESS", "COMPLETED", "SUCCEED", "SUCCEEDED"):
                    break
                if status in ("FAILED", "ERROR", "FAIL"):
                    raise RuntimeError(f"RunningHub 音频任务 {status}")
                await asyncio.sleep(_POLL_INTERVAL)
                waited += _POLL_INTERVAL
            else:
                raise RuntimeError("音频任务超时")
            urls = await audio_providers.rh_outputs(task_id)
            if not urls:
                raise RuntimeError("音频无产出")
            raw = await audio_providers.download_url(urls[0])
            # OSS 上传在 session 块外(同步阻塞, 避免在块内长占DB连接)
            key = await _oss_put(raw, user_id=0, namespace="novel-video-audio", ext="mp3")
            async with session_scope() as s:  # 只写key, 连接秒放
                c = await s.get(NovelVideoAudioChunk, chunk_id)
                c.audio_oss_key = key
                c.rh_task_id = task_id
                c.status = "done"
                c.finished_at = datetime.utcnow()
            ok = True
        except Exception as e:  # noqa: BLE001
            logger.exception("novel audio chunk %s failed", chunk_id)
            async with session_scope() as s:
                c = await s.get(NovelVideoAudioChunk, chunk_id)
                if c:
                    c.status = "failed"
                    c.error = str(e)[:500]
                    c.finished_at = datetime.utcnow()
        finally:
            # 只有拿得到远端 task_id 才有算力消耗; 信号量排队期间失败的不记账
            if task_id:
                await _bill_audio_chunk(chunk_id, "succeeded" if ok else "failed")


def _align16(size: str) -> str:
    """gpt-image-2 要求宽高均为16的倍数。把 WxH 向上对齐到16(保持比例接近)。"""
    try:
        w, h = (int(x) for x in size.lower().split("x"))
    except Exception:  # noqa: BLE001
        return "1024x1024"
    w = max(16, round(w / 16) * 16)
    h = max(16, round(h / 16) * 16)
    return f"{w}x{h}"


# ---------------- 生图 ----------------
def _is_moderation_error(err: Exception) -> bool:
    """判断是否为内容安全审核拦截(可通过改写提示词绕过, 而非配额/网络错误)。"""
    msg = str(err).lower()
    return (
        "moderation_blocked" in msg
        or "safety system" in msg
        or "content_policy" in msg
        or "content policy" in msg
        or "image_generation_user_error" in msg
    )


async def _sanitize_prompt(prompt: str) -> str:
    """把触发审核的生图提示词改写成更安全的中性版本。

    仅在被内容安全系统拦截时调用: 让 LLM 去掉/弱化可能触发审核的敏感元素
    (血腥/暴力/性暗示/违禁品/真实人物等), 保留画面主体与氛围, 便于重新过审。
    失败则回退原提示词。
    """
    try:
        from ..models.llm import get_llm
        llm = get_llm()
        sys_p = (
            "你是AI生图提示词安全改写专家。下面这条文生图提示词被内容安全系统拦截了。"
            "请在尽量保留画面主体、场景、氛围的前提下, 改写成不会触发安全审核的中性版本: "
            "淡化或去除血腥/暴力/流血/尸体/性暗示/裸露/武器凶器/毒品/违禁/真实政治人物等敏感元素, "
            "用含蓄、艺术化、非写实的措辞替代(如'冲突场面'代替'血腥厮杀')。"
            "直接输出改写后的提示词, 不要解释。"
        )
        resp = await llm.ainvoke([{"role": "system", "content": sys_p},
                                  {"role": "user", "content": prompt}])
        out = (getattr(resp, "content", None) or str(resp)).strip()
        return out or prompt
    except Exception as e:  # noqa: BLE001
        logger.warning("sanitize prompt failed, fallback raw: %s", e)
        return prompt


# 生图渠道(2026-08 调整): kegeai(ai.kegeai.top) 已全面废弃(域名失联, 不可再用)。
# 现有两个可用渠道:
#   首选 zx1.deepwl.net  — gpt-image-2 走 ZX1_* 配置(支持参考图); 实测500并发95.6%成功率。
#   备选 kege(vip.kegeai.top) — KEGE_GPT_API_KEY, 纯文生图 (2026-10-09 起替换已失效的 api4me)。
# 使用逻辑: 首选渠道重试几次全失败 → 切备选渠道再试几次 → 仍失败才报错。
_PRIMARY_T2I_MODEL = "zx1-gpt-image-2"      # 首选渠道的纯文生图版(封面用)
_FALLBACK_T2I_MODEL = "kege-gpt-image-2"  # 备选渠道(kege), 纯文生图


async def _gen_image_bytes(*, model: str, prompt: str, size: str,
                           ref_images: list[bytes] | None) -> bytes:
    """调 provider 生成 1 张图并返回字节(处理 url/inline 两种返回)。失败抛异常。"""
    imgs = await image_providers.generate(
        model=model, prompt=prompt, n=1, size=_align16(size),
        ref_images=ref_images or None,
    )
    if not imgs:
        raise RuntimeError("生图无产出")
    raw = imgs[0] if isinstance(imgs[0], (bytes, bytearray)) else None
    if raw is None:
        import httpx
        async with httpx.AsyncClient(timeout=120) as cli:
            r = await cli.get(imgs[0]); r.raise_for_status(); raw = r.content
    return bytes(raw)


async def _gen_one_image(shot_id: int, *, model: str, size: str,
                         style_prompt: str, ref_images: list[bytes]) -> None:
    """生成单张图 → OSS。style_prompt 拼到提示词前, ref_images 统一垫图。

    来源回退: 先用首选渠道 zx1(用户所选模型, gpt-image-2 走 ZX1_* 配置)最多重试 2 次,
    全失败再切备选渠道 kege 纯文生图最多重试 2 次, 仍失败才报错。被内容安全拦截
    (moderation)时在当前来源内先改写提示词再重试(不额外占用来源重试次数)。
    """
    async with _IMG_SEM:
        async with session_scope() as s:
            shot = await s.get(NovelVideoShot, shot_id)
            if not shot:
                return
            # ⚠ 这里**不能**回退 text_segment: 原文当提示词会被生图模型画成
            # 大段文字图, 且把 style_prompt 的画风指令淹没(见 PromptOptimizeError)。
            # 提示词为空说明上游优化失败, 该镜头就该是 failed 状态等重试。
            base_prompt = (shot.image_prompt or "").strip()
            if not base_prompt:
                logger.warning("novel image shot %s 无提示词(优化失败?), 跳过生图并置 failed", shot_id)
                shot.status = "failed"
                shot.error = "缺少图片提示词(提示词优化失败), 请重试该镜头"
                return
            shot.status = "imaging"
        cur_prompt = base_prompt
        sanitized_used = False
        last_err: Exception | None = None
        # (来源模型, 是否吃参考图, 重试次数)。备选渠道 kege 是纯文生图, 不吃参考图, 传 None。
        sources: list[tuple[str, list[bytes] | None, int]] = [
            (model, ref_images, 2),
            (_FALLBACK_T2I_MODEL, None, 2),
        ]
        for src_model, src_refs, tries in sources:
            for attempt in range(tries):
                try:
                    full_prompt = (style_prompt.strip() + "\n" + cur_prompt).strip() if style_prompt else cur_prompt
                    raw = await _gen_image_bytes(model=src_model, prompt=full_prompt, size=size, ref_images=src_refs)
                    # OSS 上传在 session 块外做(同步阻塞IO, 若在块内会长时间占住DB连接 → 高并发耗尽连接池)
                    key = await _oss_put(raw, user_id=0, namespace="novel-video-img", ext="png")
                    async with session_scope() as s:  # 只写一次key, DB连接秒放
                        shot = await s.get(NovelVideoShot, shot_id)
                        shot.image_oss_key = key
                        shot.status = "done"
                        if sanitized_used:
                            shot.image_prompt = cur_prompt
                    return
                except Exception as e:  # noqa: BLE001
                    last_err = e
                    # 审核拦截: 在当前来源内改写提示词重试(不消耗来源重试次数上限之外的机会)
                    if _is_moderation_error(e) and attempt < tries - 1:
                        logger.warning("novel image shot %s 在 %s 被审核拦截, 改写提示词重试", shot_id, src_model)
                        cur_prompt = await _sanitize_prompt(cur_prompt)
                        sanitized_used = True
                    else:
                        logger.warning("novel image shot %s 在 %s 第%d次失败: %s", shot_id, src_model, attempt + 1, e)
                    continue
            logger.warning("novel image shot %s 来源 %s 全部失败, 切换下一来源", shot_id, src_model)
        # 所有来源都失败
        logger.exception("novel image shot %s failed(all sources)", shot_id, exc_info=last_err)
        async with session_scope() as s:
            shot = await s.get(NovelVideoShot, shot_id)
            if shot:
                shot.status = "failed"
                shot.error = str(last_err)[:500] if last_err else "生图失败(zx1/kege 均失败)"
                if sanitized_used:
                    shot.image_prompt = cur_prompt


# ---------------- 图片提示词优化(简版, 复用 LLM) ----------------
class PromptOptimizeError(RuntimeError):
    """提示词优化失败。

    刻意不回退原文: 小说原文含对话引号、章节标题、跨句截断(text_split 是按
    字数硬切的), 直接送进生图模型会被"画"成大段文字图, 且画风指令会被这段
    长文淹没 —— 实测 job 56~60 共 1938/1950 个镜头就是这么产出的, 画风提示
    词明明在场却完全失控。
    宁可让这个镜头 failed 可重试, 也不产出一张错图: 错图是静默的(status
    仍是 done), 用户看到才发现; failed 是显式的, 有 /jobs/{id}/retry 兜底。
    """


async def _optimize_prompt(text_segment: str) -> str:
    """把小说段落转成生图提示词。用现有 LLM。

    失败直接抛 PromptOptimizeError, 由调用方把该镜头置 failed。
    LLM 侧已有三渠道兜底(zx1 → kege → modelverse), 走到这里说明三家都不可用,
    属实打实的故障, 不该用"拿原文硬生"来掩盖。
    """
    try:
        from ..models.llm import get_llm  # 复用现有 LLM 封装
        llm = get_llm()
        sys_p = ("你是AI生图提示词专家。把下面这段中文小说内容转成一句用于文生图的画面描述提示词, "
                 "聚焦可视元素(人物/动作/场景/光影/氛围), 简洁具体, 不要旁白/对话/解释, 直接输出提示词。")
        resp = await llm.ainvoke([{"role": "system", "content": sys_p},
                                  {"role": "user", "content": text_segment}])
        out = (getattr(resp, "content", None) or str(resp)).strip()
    except Exception as e:  # noqa: BLE001
        logger.warning("optimize prompt failed: %s", e)
        raise PromptOptimizeError(f"提示词优化失败: {e}") from e
    if not out:
        # 空返回同样是失败: 推理模型偶尔把预算全用在 reasoning 上, 正文为空
        logger.warning("optimize prompt returned empty for segment len=%d", len(text_segment))
        raise PromptOptimizeError("提示词优化返回空内容")
    return out


# ---------------- 封面: AI 生成标题/标签/封面图提示词 + image2 生封面图 ----------------
def _valid_title(t: str) -> bool:
    """标题合格判定: 纯中文 3~5 字(不含标点/空格/英文)。"""
    import re as _re
    t = (t or "").strip()
    return bool(_re.fullmatch(r"[\u4e00-\u9fa5]{3,5}", t))


async def _gen_cover_meta(novel_text: str) -> Optional[dict]:
    """用全文让 LLM 生成 {title(3~5汉字), tags(如"大女主/系统"), cover_prompt(无文字画面)}。

    标题不合格(非3~5汉字)则重新生成, 最多 3 次尝试; 整体失败重试 2 次(共3轮)。
    返回 None 表示彻底失败(调用方据此跳过封面, 不拖垮主流程)。
    """
    from ..models.llm import get_llm
    import json as _json
    refused = False  # 追踪 LLM 是否因内容审核拒绝
    sys_p = (
        "你是短视频封面文案专家。阅读用户给的小说全文, 输出一个JSON对象, 字段:\n"
        "title: 一个吸引人的标题, 严格3到5个汉字(不能有标点/空格/英文/数字);\n"
        "tags: 两个题材标签用斜杠连接, 如 大女主/系统 或 重生/复仇 (只输出两个词, 不要加\"完结\");\n"
        "cover_prompt: 一句英文或中文的文生图画面提示词, 描述封面主视觉(人物/场景/氛围/构图), "
        "必须在结尾强调 no text, no letters, no watermark, no subtitles, no caption(画面中绝对不能出现任何文字);\n"
        "genre: 题材, 只能是 古风 或 现代 二选一(判断这个故事整体是古装/仙侠/宫廷类=古风, 还是都市/现代/校园类=现代).\n"
        "protagonist_gender: 第一主角的性别, 只能是 男 或 女 二选一(判断这个故事的第一主角/主视角人物是男性还是女性).\n"
        "只输出JSON, 不要解释。"
    )
    # LLM 内容审核拒绝的特征串(Gemini/OpenAI 等触发敏感词时返回一段英文拒绝语而非 JSON):
    # 这类小说含大出血/复仇/杀妻等情节会被模型安全策略拦截, 但文档内容本身是好的,
    # 不应因为"生成不出封面文案"就让整个视频任务失败 → 检测到拒绝则走安全兜底 meta。
    _REFUSAL_MARKERS = (
        "could not be submitted", "prohibited use policy", "sensitive words",
        "violate", "i can't", "i cannot", "unable to", "as an ai",
        "我不能", "无法完成", "违反", "敏感",
    )

    def _looks_like_refusal(s: str) -> bool:
        low = (s or "").lower()
        return any(m.lower() in low for m in _REFUSAL_MARKERS)

    for outer in range(3):  # 整体最多3轮(即失败重试2次)
        try:
            llm = get_llm()
            resp = await llm.ainvoke([{"role": "system", "content": sys_p},
                                      {"role": "user", "content": novel_text[:6000]}])
            out = (getattr(resp, "content", None) or str(resp)).strip()
            # 模型内容审核拒绝(返回英文拒绝语而非 JSON) → 不重试(重试仍会被拦), 直接兜底
            if _looks_like_refusal(out):
                logger.warning("cover meta: LLM 审核拒绝, 走安全兜底 meta。resp=%s", out[:120])
                refused = True  # 标记为审核拒绝
                break
            # 去掉可能的 ```json 包裹
            out = out.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
            data = _json.loads(out)
            title = (data.get("title") or "").strip()
            tags = (data.get("tags") or "").strip()
            prompt = (data.get("cover_prompt") or "").strip()
            # 标题不合格 → 再要一次(在同一轮内最多补救2次)
            fix = 0
            while not _valid_title(title) and fix < 2:
                fix += 1
                r2 = await llm.ainvoke([
                    {"role": "system", "content": "只输出一个3到5个汉字的短视频标题, 不要标点/空格/英文/数字, 不要解释。"},
                    {"role": "user", "content": f"小说全文:\n{novel_text[:3000]}\n\n之前给的\"{title}\"不合格, 重新给一个3~5个汉字的标题。"},
                ])
                title = (getattr(r2, "content", None) or str(r2)).strip().strip("《》\"' 　")
            if not _valid_title(title):
                continue  # 本轮标题仍不合格 → 下一轮重来
            if not prompt:
                continue
            genre = (data.get("genre") or "").strip()
            if genre not in ("古风", "现代"):
                genre = "现代"  # 兜底
            # 主角性别 男/女 → male/female; 无法判断留 None
            pg_raw = (data.get("protagonist_gender") or "").strip()
            protagonist_gender = "male" if "男" in pg_raw else ("female" if "女" in pg_raw else None)
            # 封面提示词兜底追加无文字约束
            if "no text" not in prompt.lower() and "无文字" not in prompt:
                prompt = prompt + " , no text, no letters, no watermark, no subtitles"
            return {"title": title, "tags": tags, "cover_prompt": prompt, "genre": genre,
                    "protagonist_gender": protagonist_gender}
        except Exception as e:  # noqa: BLE001
            logger.warning("cover meta gen attempt %d failed: %s", outer + 1, e)
            continue

    # 走到这里 = LLM 没能产出合格 meta。
    # 若是内容审核拒绝(refused): 文档内容本身没问题, 不应让整个视频任务失败 → 返回安全兜底 meta,
    #   用通用标题/标签/中性封面提示词, 让任务继续生成视频(封面文案可后续人工在飞书表改)。
    # 若是其它原因(网络/JSON 反复失败等)且非审核拒绝: 也给一个兜底, 保证飞书任务不因封面文案卡死。
    logger.warning("cover meta: 生成失败(refused=%s), 使用安全兜底 meta", refused)
    return {
        "title": "精彩小说",  # 通用兜底标题(3~5汉字, 合法)
        "tags": "热门/推荐",
        "cover_prompt": (
            "a cinematic dramatic book cover illustration, atmospheric lighting, "
            "expressive character portrait, high quality, no text, no letters, "
            "no watermark, no subtitles, no caption"
        ),
        "genre": "现代",
        "protagonist_gender": None,
    }


async def gen_meta_for_text(novel_text: str) -> Optional[dict]:
    """供飞书自动化前置调用: 读全文生成 {title, tags, cover_prompt, genre}。
    genre 用于选 BGM 分类。失败返回 None。"""
    return await _gen_cover_meta(novel_text)


async def analyze_protagonist_gender(novel_text: str) -> Optional[str]:
    """轻量分析: 只判断第一主角性别, 返回 'male'|'female'|None。
    用于"自动"音色模式在配音前(流程最早期)确定该用哪个性别的音色池。失败返回 None。"""
    try:
        from ..models.llm import get_llm
        llm = get_llm()
        sys_p = ("判断下面这段中文小说的第一主角(主视角人物)的性别。"
                 "只回答一个字: 男 或 女。不要解释、不要标点。")
        resp = await llm.ainvoke([{"role": "system", "content": sys_p},
                                  {"role": "user", "content": (novel_text or "")[:3000]}])
        out = (getattr(resp, "content", None) or str(resp)).strip()
        if "男" in out:
            return "male"
        if "女" in out:
            return "female"
        return None
    except Exception as e:  # noqa: BLE001
        logger.warning("analyze_protagonist_gender failed: %s", e)
        return None


async def _pick_voice_by_gender(user_id: int, gender: Optional[str]) -> Optional[str]:
    """从指定性别的音色池挑一个 oss_key(按已有任务数轮转, 保证跨任务分散)。
    gender 为 None 或该性别池为空时, 回退用户全部音色池; 仍为空返回 None。"""
    from sqlalchemy import select as _select, func as _func
    async with session_scope() as s:
        pool: list[str] = []
        if gender in ("male", "female"):
            pool = (await s.execute(
                _select(NovelVideoVoice.oss_key).where(
                    NovelVideoVoice.user_id == user_id, NovelVideoVoice.gender == gender
                ).order_by(NovelVideoVoice.id)
            )).scalars().all()
        if not pool:
            pool = (await s.execute(
                _select(NovelVideoVoice.oss_key).where(NovelVideoVoice.user_id == user_id)
                .order_by(NovelVideoVoice.id)
            )).scalars().all()
        if not pool:
            return None
        # 轮转游标: 该用户已创建任务总数(跨任务分散选取)
        used = (await s.execute(
            _select(_func.count()).select_from(NovelVideoJob)
            .where(NovelVideoJob.user_id == user_id)
        )).scalar() or 0
    return pool[used % len(pool)]


async def _gen_cover_image(cover_prompt: str, *, model: str, size: str,
                           style_prompt: str, ref_images: list[bytes]) -> Optional[bytes]:
    """生成封面图。走纯文生图渠道(不吃参考图), 首选 zx1 重试2次(共3次),
    全失败再切备选 kege 重试2次(共3次), 两渠道均失败才放弃。

    纯文生图不吃参考图; size 对齐16后直传, 保证封面图比例与设置的视频比例一致。
    model 参数保留仅为签名兼容, 实际不使用(封面固定走文生图专用渠道)。
    """
    full_prompt = (style_prompt.strip() + "\n" + cover_prompt).strip() if style_prompt else cover_prompt
    last_err: Exception | None = None
    # (渠道模型, 尝试次数): 首选 zx1 共3次 → 备选 kege 共3次
    for src_model, tries in ((_PRIMARY_T2I_MODEL, 3), (_FALLBACK_T2I_MODEL, 3)):
        for attempt in range(tries):
            try:
                imgs = await image_providers.generate(
                    model=src_model, prompt=full_prompt, n=1, size=_align16(size),
                    ref_images=None,
                )
                if not imgs:
                    raise RuntimeError("封面生图无产出")
                raw = imgs[0] if isinstance(imgs[0], (bytes, bytearray)) else None
                if raw is None:
                    import httpx
                    async with httpx.AsyncClient(timeout=120) as cli:
                        r = await cli.get(imgs[0]); r.raise_for_status(); raw = r.content
                return bytes(raw)
            except Exception as e:  # noqa: BLE001
                last_err = e
                logger.warning("cover image %s attempt %d failed: %s", src_model, attempt + 1, e)
                continue
        logger.warning("cover image 渠道 %s 全部失败, 切换下一渠道", src_model)
    logger.warning("cover image gen giving up(all channels): %s", last_err)
    return None


async def _gen_cover(job_id: int, *, model: str, size: str, style_prompt: str,
                     ref_images: list[bytes]) -> None:
    """封面全流程: LLM 生文案 → image2 生封面图 → 存 job.cover_* 字段。
    任何环节彻底失败都只记录、不抛异常(封面是增强项, 不能拖垮主流程)。
    若用户已手动填了 title/tags(重生成场景), 则复用, 只补缺失部分。
    """
    async with session_scope() as s:
        job = await s.get(NovelVideoJob, job_id)
        if not job:
            return
        novel = job.novel_text or ""
        exist_title = (job.cover_title or "").strip()
        exist_tags = (job.cover_tags or "").strip()
        exist_prompt = (job.cover_prompt or "").strip()
    # 若已有完整文案(用户改过 + 有提示词)则跳过 LLM, 直接用
    if exist_title and exist_prompt:
        title, tags, prompt = exist_title, exist_tags, exist_prompt
    else:
        meta = await _gen_cover_meta(novel)
        if not meta:
            logger.warning("job %s 封面文案生成失败, 跳过封面", job_id)
            return
        title = exist_title if _valid_title(exist_title) else meta["title"]
        tags = exist_tags or meta["tags"]
        prompt = exist_prompt or meta["cover_prompt"]
        async with session_scope() as s:
            job = await s.get(NovelVideoJob, job_id)
            if job:
                job.cover_title = title
                job.cover_tags = tags
                job.cover_prompt = prompt
    raw = await _gen_cover_image(prompt, model=model, size=size,
                                 style_prompt=style_prompt, ref_images=ref_images)
    if not raw:
        logger.warning("job %s 封面图生成失败, 跳过封面", job_id)
        return
    key = await _oss_put(raw, user_id=0, namespace="novel-video-cover", ext="png")
    async with session_scope() as s:
        job = await s.get(NovelVideoJob, job_id)
        if job:
            job.cover_oss_key = key


async def regenerate_cover(job_id: int, *, model: str, size: str, style_prompt: str,
                           ref_image_keys: list[str]) -> None:
    """重新生成封面(供路由调用)。清掉旧封面图后重跑 _gen_cover;
    若用户改过 title/tags/prompt, _gen_cover 会复用这些值。"""
    async with session_scope() as s:
        job = await s.get(NovelVideoJob, job_id)
        if not job:
            return
        job.cover_oss_key = None  # 清旧图, 强制重生
    ref_imgs = [await _load_bytes(k) for k in ref_image_keys] if ref_image_keys else []
    await _gen_cover(job_id, model=model, size=size, style_prompt=style_prompt, ref_images=ref_imgs)


# ---------------- 字体注册表(免费可商用) ----------------
# id → 候选路径(取第一个存在的)。前端用 id 选择, 后端解析成实际字体文件。
FONT_REGISTRY: dict[str, list[str]] = {
    "sans": [  # 思源黑体(默认)
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    ],
    "serif": [  # 思源宋体
        "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc",
        "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
    ],
    "sans-bold": [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ],
}
FONT_CHOICES = [
    {"id": "sans", "label": "思源黑体"},
    {"id": "sans-bold", "label": "思源黑体(粗)"},
    {"id": "serif", "label": "思源宋体"},
]


def _resolve_font(font_id: Optional[str]) -> Optional[str]:
    """按 id 解析实际字体文件路径; 未指定或找不到则兜底任意中文字体。"""
    cands = FONT_REGISTRY.get(font_id or "sans") or FONT_REGISTRY["sans"]
    for p in cands:
        if os.path.exists(p):
            return p
    # 兜底: 任意已注册字体
    for lst in FONT_REGISTRY.values():
        for p in lst:
            if os.path.exists(p):
                return p
    # 再兜底: fc-list
    try:
        out = subprocess.run(["fc-list", ":lang=zh", "file"], capture_output=True, timeout=10)
        for line in (out.stdout or b"").decode("utf-8", "ignore").splitlines():
            fp = line.split(":")[0].strip()
            if fp and os.path.exists(fp):
                return fp
    except Exception:  # noqa: BLE001
        pass
    return None


def _find_font() -> Optional[str]:  # 向后兼容旧调用
    return _resolve_font("sans")


def _wrap_caption(text: str, per_line: int) -> str:
    """按每行字数折行 → 用真实换行符(chr 10)分隔。
    注意: 之前用字面 '\\n' 会被 drawtext 显示成字母 n(bug), 必须用真实换行符。
    """
    text = (text or "").strip().replace("\r", " ").replace("\n", " ")
    if not text:
        return ""
    lines = [text[i:i + per_line] for i in range(0, len(text), per_line)]
    return "\n".join(lines[:2])  # 最多2行, 防止占满屏幕/溢出画面


def _escape_drawtext(s: str) -> str:
    """drawtext text= 内的转义。保留真实换行符(\\n)不动, 只转义特殊字符。"""
    return (s.replace("\\", "\\\\").replace(":", "\\:")
            .replace("'", "\u2019").replace("%", "\\%"))


# ---------------- ffmpeg Ken Burns (平滑运镜 + 可选字幕) ----------------
def _ken_burns_cmd(img_path: str, out_path: str, *, dur: float, w: int, h: int, fps: int,
                   direction: int, caption: str = "", font: Optional[str] = None,
                   sub_font_pct: float = 0.045, sub_y_pct: float = 0.88,
                   sub_color: str = "white", sub_stroke: str = "black") -> list[str]:
    """生成缓慢移动片段。为消除 zoompan 逐帧像素抖动(卡顿感), 在放大 8 倍的高分辨率画布上做平移,
    最后一次性 scale 到目标尺寸 → 亚像素平移被平滑掉。

    direction 0..3: 0 左上→右下, 1 右上→左下, 2 左下→右上, 3 右下→左上。
    caption: 该段字幕文本(白字黑描边), 空则不加。
    """
    frames = max(1, int(dur * fps))
    # 平滑运镜(恢复最初被验证平滑的方案): 在【2x 放大画布】上做 zoompan 连续缩放+平移, 再 bicubic 缩回目标尺寸。
    #   为什么放大画布: zoompan 的 zoom/x/y 虽是浮点求值, 但其内部采样与缩放在【接近目标分辨率】直接跑时,
    #   低分辨率下的重采样精度不足 + 每帧整数化误差被放大 → 观感抖动/卡顿(用户实测: 直接目标分辨率 zoompan
    #   既抖又没提速)。改为先放大到 2x 大画布(mw×mh), 在大画布上跑 zoompan(此时 1 目标像素对应 2 大画布
    #   像素, 亚像素运动更细腻), 最后一次性 scale 回目标尺寸并用 bicubic 重采样 → 把大画布上的细腻运动
    #   平滑落到目标像素, 抖动消失。这是本项目最初上线、被验证"平滑无抖"的版本。
    mw, mh = w * 2, h * 2
    # 缓慢连续放大(1.0→1.10), 配合随帧线性平移, 形成 Ken Burns 式平滑运镜。
    z0, z1 = 1.0, 1.10
    zexpr = f"min(zoom+{(z1 - z0) / frames:.6f},{z1})"
    # 平移范围 = iw-iw/zoom(相对 zoompan 当前输入=大画布); 按帧进度线性移动。
    prog = f"(on/{frames})"          # 0→1
    inv = f"(1-on/{frames})"          # 1→0
    xmax, ymax = "(iw-iw/zoom)", "(ih-ih/zoom)"
    if direction == 0:               # 左上 → 右下
        x, y = f"{xmax}*{prog}", f"{ymax}*{prog}"
    elif direction == 1:             # 右上 → 左下
        x, y = f"{xmax}*{inv}", f"{ymax}*{prog}"
    elif direction == 2:             # 左下 → 右上
        x, y = f"{xmax}*{prog}", f"{ymax}*{inv}"
    else:                            # 右下 → 左上
        x, y = f"{xmax}*{inv}", f"{ymax}*{inv}"
    # 1) 放大铺满到 2x 大画布; 2) 在大画布上 zoompan 连续缩放+平移(亚像素细腻); 3) bicubic 缩回目标尺寸(平滑落像素)。
    vf = (f"scale={mw}:{mh}:force_original_aspect_ratio=increase,crop={mw}:{mh},"
          f"zoompan=z='{zexpr}':x='{x}':y='{y}':d={frames}:s={mw}x{mh}:fps={fps},"
          f"scale={w}:{h}:flags=bicubic")
    # 字幕: 可调字号(占画面高%)/纵向位置(y占画面高%)/颜色/描边; 底部居中
    if caption and font:
        fontsize = max(16, int(h * sub_font_pct))
        cap = _escape_drawtext(caption)
        ypx = int(h * sub_y_pct)
        vf += (f",drawtext=fontfile='{font}':text='{cap}':"
               f"fontcolor={sub_color}:fontsize={fontsize}:borderw={max(2, fontsize // 12)}:bordercolor={sub_stroke}:"
               f"x=(w-text_w)/2:y={ypx}-text_h/2:line_spacing=8:box=0")
    # 单图 zoompan 用单线程即可(不吃多核); 并发路数由调用方 _SEG_CONCURRENCY 控制, 使总核占用受控。
    return ["ffmpeg", "-y", "-threads", "1", "-loop", "1", "-i", img_path, "-t", f"{dur}",
            "-filter_complex", vf, "-c:v", "libx264", "-preset", "veryfast",
            "-pix_fmt", "yuv420p", "-r", str(fps), out_path]


def _overlay_filters(overlays: Optional[dict], *, w: int, h: int, total_dur: float) -> str:
    """构造画面固定文字的 drawtext 滤镜串(逗号分隔)。
    overlays.items: [{text,xPct,yPct,fontPct,vertical,font,color,stroke}]
    - xPct/yPct: 左上角锚点(0~1, 相对画面); fontPct: 字号占画面高百分比
    - vertical: 竖排(逐字换行); font: 字体id; text 中 {min} 替换为时长分钟
    兼容旧结构 {disclaimer, corner} → 转成两个 item。
    """
    if not overlays:
        return ""
    # 只取整分钟(向下取整, 不进位/不四舍五入): 88s→1, 125s→2
    minutes = int(total_dur // 60) if total_dur else 0
    items = overlays.get("items")
    # 兼容旧结构
    if items is None:
        items = []
        dis = overlays.get("disclaimer") or {}
        if dis.get("on") and (dis.get("text") or "").strip():
            items.append({"text": dis["text"], "xPct": 0.03, "yPct": 0.25,
                          "fontPct": 0.03, "vertical": True, "font": "sans"})
        cor = overlays.get("corner") or {}
        if cor.get("on") and (cor.get("text") or "").strip():
            items.append({"text": cor["text"], "xPct": 0.55, "yPct": 0.03,
                          "fontPct": 0.033, "vertical": False, "font": "sans"})
    parts: list[str] = []
    for it in items:
        text = (it.get("text") or "").strip().replace("{min}", str(minutes))
        if not text:
            continue
        ffile = _resolve_font(it.get("font"))
        if not ffile:
            continue
        if it.get("vertical"):
            text = "\n".join(list(text))
        text = _escape_drawtext(text)
        fs = max(14, int(h * float(it.get("fontPct") or 0.03)))
        # align=center → 左右居中(x 用 ffmpeg 表达式, 按文本实际宽度居中); 否则按 xPct 左锚点
        if it.get("align") == "center":
            x = "(w-text_w)/2"
        else:
            x = int(w * float(it.get("xPct") or 0.03))
        y = int(h * float(it.get("yPct") or 0.03))
        color = it.get("color") or "white"
        stroke = it.get("stroke") or "black"
        parts.append(
            f"drawtext=fontfile='{ffile}':text='{text}':fontcolor={color}:fontsize={fs}:"
            f"borderw={max(2, fs // 12)}:bordercolor={stroke}:x={x}:y={y}:line_spacing=4:box=0"
        )
    return ",".join(parts)


def _run(cmd: list[str], timeout: int = 600) -> None:
    p = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg rc={p.returncode}: {p.stderr[-400:].decode('utf-8','ignore')}")


# ---------------- BGM 响度标准化(上传时) ----------------
def normalize_bgm(src_path: str, out_path: str) -> None:
    """用 EBU R128 loudnorm 把 BGM 统一到标准响度(I=-16 LUFS), 再转码 mp3。
    统一后各首 BGM 主观音量一致, 便于后续按固定比例混入。"""
    _run(["ffmpeg", "-y", "-i", src_path,
          "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
          "-c:a", "libmp3lame", "-q:a", "2", out_path], timeout=300)


def _mix_bgm_cmd(voice_path: str, bgm_path: str, out_path: str, *, dur: float) -> list[str]:
    """把配音(翻倍)与 BGM(配音的1/3, 循环填满, 按画面时长裁剪)混音成一条音轨。
    - 配音: volume=2.0 整体翻倍(用户反馈原声偏小)
    - BGM : aloop 无限循环 → volume 降到配音的 1/3(≈0.667=2*(1/3)) → 与配音等长
    - amix: duration=first 以配音为准; 末尾 atrim 到画面时长, 多余 BGM 被裁掉
    """
    # 配音翻倍(volume=2.0)作为基准。BGM 原设"配音的1/3"仍偏大, 用户反馈再降一半 → 约配音的1/6。
    # BGM 绝对增益 = 2 * (1/6) ≈ 0.333。
    vf = (
        f"[0:a]volume=2.0[v];"
        f"[1:a]aloop=loop=-1:size=2e9,volume=0.333[b];"
        f"[v][b]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]"
    )
    return ["ffmpeg", "-y", "-i", voice_path, "-i", bgm_path,
            "-filter_complex", vf, "-map", "[a]",
            "-t", f"{dur}", "-c:a", "libmp3lame", "-q:a", "2", out_path]


def _cover_overlay_filters(cover_overlays: Optional[dict], *, w: int, h: int,
                           title: str, tags: str) -> str:
    """封面文字 drawtext 串。cover_overlays.items 的 text 支持占位符 {title}/{tags},
    合成时替换成该任务实际文案(tags 为 AI 生成的两个标签, 用户模板里可自行写 /完结)。
    """
    if not cover_overlays:
        return ""
    items = cover_overlays.get("items") or []
    parts: list[str] = []
    for it in items:
        text = (it.get("text") or "")
        text = text.replace("{title}", title or "").replace("{tags}", tags or "").strip()
        if not text:
            continue
        ffile = _resolve_font(it.get("font"))
        if not ffile:
            continue
        if it.get("vertical"):
            text = "\n".join(list(text))
        text = _escape_drawtext(text)
        fs = max(14, int(h * float(it.get("fontPct") or 0.06)))
        # align=center → 左右居中(x 用 ffmpeg 表达式, 按文本实际宽度居中); 否则按 xPct 左锚点
        if it.get("align") == "center":
            x = "(w-text_w)/2"
        else:
            x = int(w * float(it.get("xPct") or 0.1))
        y = int(h * float(it.get("yPct") or 0.1))
        color = it.get("color") or "white"
        stroke = it.get("stroke") or "black"
        parts.append(
            f"drawtext=fontfile='{ffile}':text='{text}':fontcolor={color}:fontsize={fs}:"
            f"borderw={max(2, fs // 10)}:bordercolor={stroke}:x={x}:y={y}:line_spacing=6:box=0"
        )
    return ",".join(parts)


def _make_cover_clip(img_path: str, out_path: str, *, w: int, h: int, fps: int,
                     cover_overlays: Optional[dict], title: str, tags: str) -> None:
    """把封面图烧上标题/标签文字, 生成"1帧/极短"的静止片段(与主视频同尺寸/编码, 便于 concat)。
    时长取 1/fps(即一帧); 用 loop+t 生成极短静止片段。无音轨(concat 后主视频音轨从0开始)。
    """
    vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}"
    ov = _cover_overlay_filters(cover_overlays, w=w, h=h, title=title, tags=tags)
    if ov:
        vf += "," + ov
    dur = max(1.0 / max(fps, 1), 0.04)
    _run(["ffmpeg", "-y", "-threads", "2", "-loop", "1", "-i", img_path, "-t", f"{dur}",
          "-vf", vf, "-c:v", "libx264", "-preset", "veryfast",
          "-pix_fmt", "yuv420p", "-r", str(fps), out_path])


# ---------------- 主流水线 ----------------
async def run_job(job_id: int) -> None:
    """执行一个小说转视频任务(后台)。"""
    s_cfg = get_settings()
    max_chars = getattr(s_cfg, "novel_tts_max_chars", None)  # 先留空=整段不拆
    import random

    async with session_scope() as s:
        job = await s.get(NovelVideoJob, job_id)
        if not job:
            return
        novel = job.novel_text or ""
        style_prompt = job.style_prompt or ""
        ref_image_keys = list(job.ref_image_oss_keys or ([] if not job.ref_image_oss_key else [job.ref_image_oss_key]))
        voice_ref_key = job.voice_ref_oss_key
        model = job.image_model or "gpt-image-2"
        w, h, fps = job.width, job.height, job.fps
        per_img = job.per_image_seconds or 10
        user_id = job.user_id
        auto_compose = bool(job.auto_compose)

    # 播种归属: 本入口由独立 worker 进程/后台协程调用, 无请求上下文。
    # 这里盖章后, 后续 analyze_protagonist_gender / 生图 / 配音等消耗才统计得到人。
    set_usage_context(job_id=job_id, user_id=user_id, source="novel_video")

    try:
        # 0) "自动"音色模式: 建任务时 voice_ref_oss_key 留空 → 这里先分析第一主角性别,
        #    存 job.protagonist_gender, 再从该性别音色池挑一个作为本任务参考音色。
        if not voice_ref_key:
            pg = await analyze_protagonist_gender(novel)
            picked = await _pick_voice_by_gender(user_id, pg)
            if picked:
                voice_ref_key = picked
                await _set_job(job_id, protagonist_gender=pg, voice_ref_oss_key=picked)
            elif pg:
                await _set_job(job_id, protagonist_gender=pg)

        # 1) 拆音频 chunk
        await _set_job(job_id, status="audio", progress=5)
        audio_texts = split_for_audio(novel, max_chars)
        chunk_ids: list[int] = []
        async with session_scope() as s:
            for i, t in enumerate(audio_texts):
                c = NovelVideoAudioChunk(job_id=job_id, idx=i, text_chunk=t, status="pending")
                s.add(c); await s.flush(); chunk_ids.append(c.id)

        if not voice_ref_key:
            raise RuntimeError("缺少参考音色(自动模式下音色库为空, 请先上传音色)")
        ref_raw = await _load_bytes(voice_ref_key)
        ref_name = await audio_providers.rh_upload_audio(ref_raw, filename="ref.wav")

        # 2) 并发生成配音
        await asyncio.gather(*[_gen_one_audio(cid, ref_name) for cid in chunk_ids])

        # 3) ffmpeg 拼整段配音
        with tempfile.TemporaryDirectory() as td:
            audio_parts = []
            async with session_scope() as s:
                for cid in chunk_ids:
                    c = await s.get(NovelVideoAudioChunk, cid)
                    if c and c.audio_oss_key:
                        raw = await _load_bytes(c.audio_oss_key)
                        p = os.path.join(td, f"a_{c.idx}.mp3")
                        with open(p, "wb") as f:
                            f.write(raw)
                        audio_parts.append(p)
            if not audio_parts:
                raise RuntimeError("配音全部失败")
            # 注意: RunningHub IndexTTS 产出可能是 flac/wav, 统一重编码为 mp3(不能 -c copy, 否则 flac 放不进 mp3 容器)
            full_audio = os.path.join(td, "full.mp3")
            if len(audio_parts) == 1:
                _run(["ffmpeg", "-y", "-i", audio_parts[0], "-c:a", "libmp3lame", "-q:a", "2", full_audio])
            else:
                lst = os.path.join(td, "alist.txt")
                with open(lst, "w") as f:
                    for p in audio_parts:
                        f.write(f"file '{p}'\n")
                # concat 不同来源音频先重编码保证一致
                _run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lst,
                      "-c:a", "libmp3lame", "-q:a", "2", full_audio])
            total_dur = _ffprobe_duration(full_audio)
            with open(full_audio, "rb") as _f:
                _audio_bytes = _f.read()
            audio_key = await _oss_put(_audio_bytes, user_id=user_id, namespace="novel-video-audio", ext="mp3")
            await _set_job(job_id, audio_oss_key=audio_key, audio_duration=int(total_dur))

            # 4) 图片张数 = ceil(总时长 / 每张秒数); 拆图片段
            import math
            n_imgs = max(1, math.ceil(total_dur / per_img)) if total_dur else 1
            img_texts = split_for_images(novel, n_imgs)
            n_imgs = len(img_texts)
            await _set_job(job_id, status="prompting", image_count=n_imgs, progress=30)
            shot_ids: list[int] = []
            async with session_scope() as s:
                # 幂等保护(防重复 shot): 建新分镜前先删除本 job 已存在的旧 shot 记录。
                # 背景: 若因任何原因 run_job 对同一 job 被执行了两次(如历史上的重复认领),
                #   不清理会导致每个 idx 叠加出两条 shot(实测 dev job40: 30 shots/15 distinct idx),
                #   前端"图片数=shot总数"就翻倍(显示30), 与 image_count(15) 不符, 且合成时同一 idx
                #   多条图片重复入轨。这里先按 job_id 清空旧 shot, 保证本次分镜是唯一权威来源。
                #   (认领侧已改原子 UPDATE 杜绝重复认领; 这层是双保险, 对续跑/重试同样安全。)
                await s.execute(
                    __import__("sqlalchemy").text("DELETE FROM novel_video_shots WHERE job_id = :jid"),
                    {"jid": job_id},
                )
                for i, t in enumerate(img_texts):
                    sh = NovelVideoShot(job_id=job_id, idx=i, text_segment=t, status="pending")
                    s.add(sh); await s.flush(); shot_ids.append(sh.id)

            # 5) 并发优化提示词
            #    单段失败只让该镜头 failed, 不能拖垮整个 job ——
            #    故 gather(return_exceptions=True), 且 _opt 内部自己吞掉异常并落库。
            async def _opt(sid: int):
                async with session_scope() as s:
                    sh = await s.get(NovelVideoShot, sid)
                    seg = sh.text_segment if sh else ""
                    if sh:
                        sh.status = "prompting"
                try:
                    pr = await _optimize_prompt(seg)
                except PromptOptimizeError as e:
                    # 不回退原文(原因见 PromptOptimizeError 文档): 置 failed 等重试。
                    # image_prompt 保持 NULL, 这样 _gen_one_image 那处
                    # `shot.image_prompt or shot.text_segment` 的二次兜底也不会被触发。
                    logger.warning("shot %s 提示词优化失败, 置 failed: %s", sid, e)
                    async with session_scope() as s:
                        sh = await s.get(NovelVideoShot, sid)
                        if sh:
                            sh.status = "failed"
                            sh.error = str(e)[:500]
                    return
                async with session_scope() as s:
                    sh = await s.get(NovelVideoShot, sid)
                    if sh:
                        sh.image_prompt = pr
            await asyncio.gather(*[_opt(sid) for sid in shot_ids], return_exceptions=True)

            # 6) 并发生图(统一垫图) + (可选)并发生成封面
            await _set_job(job_id, status="imaging", progress=50)
            ref_imgs = [await _load_bytes(k) for k in ref_image_keys] if ref_image_keys else []
            size = f"{w}x{h}"
            async with session_scope() as s:
                _j = await s.get(NovelVideoJob, job_id)
                cover_on = bool(_j and _j.cover_enabled)
            gen_tasks = [
                _gen_one_image(sid, model=model, size=size, style_prompt=style_prompt, ref_images=ref_imgs)
                for sid in shot_ids
            ]
            if cover_on:
                # 封面与分镜图并发生成(失败不拖垮主流程, _gen_cover 内部已吞异常)
                gen_tasks.append(_gen_cover(job_id, model=model, size=size,
                                            style_prompt=style_prompt, ref_images=ref_imgs))
            await asyncio.gather(*gen_tasks)

        # 7) 生图完成
        if auto_compose:
            # 全自动: 不暂停, 直接进合成(受 _COMPOSE_SEM 限流, 最多2个任务同时占CPU)
            await _set_job(job_id, status="await_confirm", progress=70)
            await compose_job(job_id)
        else:
            # 手动: 停在 await_confirm 等用户确认/改图后再点合成
            await _set_job(job_id, status="await_confirm", progress=70)
    except Exception as e:  # noqa: BLE001
        logger.exception("novel_video job %s failed", job_id)
        await _set_job(job_id, status="failed", error=str(e)[:1000])


async def compose_job(job_id: int) -> None:
    """把已生成的图片 + 配音合成为成片(带平滑运镜 + 字幕)。可在 await_confirm 或 succeeded 后调用(重合成)。"""
    async with session_scope() as s:
        job = await s.get(NovelVideoJob, job_id)
        if not job:
            return
        w, h, fps = job.width, job.height, job.fps
        per_img = job.per_image_seconds or 10
        user_id = job.user_id
        audio_key = job.audio_oss_key
        audio_dur = job.audio_duration or 0
        novel_text = job.novel_text or ""
        bgm_key = job.bgm_oss_key
        overlays = job.overlays or None
        # 封面(视频第一帧)
        cover_key = job.cover_oss_key
        cover_overlays = job.cover_overlays or None
        cover_title = job.cover_title or ""
        cover_tags = job.cover_tags or ""
        sub = (overlays or {}).get("subtitle") or {} if overlays else {}
        sub_font = _resolve_font(sub.get("font"))
        sub_font_pct = float(sub.get("fontPct") or 0.045)
        sub_y_pct = float(sub.get("yPct") or 0.88)
        sub_color = sub.get("color") or "white"
        sub_stroke = sub.get("stroke") or "black"
    if not audio_key:
        await _set_job(job_id, status="failed", error="缺少配音, 无法合成")
        return

    import random
    font = sub_font or _find_font()
    # CPU 密集段限流: 最多 2 个任务同时合成, 保护 16 核不被挤爆(全自动批量时尤其重要)。
    await _COMPOSE_SEM.acquire()
    await _set_job(job_id, status="compositing", progress=80)
    try:
        with tempfile.TemporaryDirectory() as td:
            # 取整段配音
            full_audio = os.path.join(td, "full.mp3")
            with open(full_audio, "wb") as f:
                f.write(await _load_bytes(audio_key))

            # 取所有已生成图片(按 idx), 逐段做平滑运镜 + 烧该段字幕
            seg_paths = []
            async with session_scope() as s:
                shots = (await s.execute(
                    __import__("sqlalchemy").select(NovelVideoShot)
                    .where(NovelVideoShot.job_id == job_id).order_by(NovelVideoShot.idx)
                )).scalars().all()
            shot_data = [(sh.idx, sh.image_oss_key, sh.text_segment) for sh in shots if sh.image_oss_key]
            # 每段时长 = 音频总时长 / 实际图片段数, 保证画面铺满整段配音。
            # 修复(时长截断): 原用固定 per_img, 但 split_for_images 在"小说句子数 < 目标张数"时
            # 只返回句子数(每句一段), 实际段数 < ceil(音频/per_img), 导致 段数×per_img < 音频时长
            # → 成片被截短(如 52 分钟音频只出 37 分钟)。改为按实际段数均分音频时长, 使
            # seg_dur × 段数 ≡ 音频时长, 无论切出多少段画面都精确铺满配音。
            n_seg = len(shot_data)
            seg_dur = (audio_dur / n_seg) if (audio_dur and n_seg) else per_img
            # 每行字数 = 画面宽×0.9 / 实际字号。中文全角字宽≈字号, 故此上限保证每行渲染宽度≤90%画面宽。
            # 现字幕改用 whisper 时间戳 + 原文纠正的 SRT(音字同步、单行), 此值用于 SRT 断句粒度上限。
            sub_fs = max(16, int(h * sub_font_pct))
            per_line = max(6, int(w * 0.9 / sub_fs))
            # 先把所有图片落盘
            for idx, img_key, seg_text in shot_data:
                raw = await _load_bytes(img_key)
                with open(os.path.join(td, f"img_{idx}.png"), "wb") as f:
                    f.write(raw)
            # 分段渲染: 并发路数 = _SEG_CONCURRENCY(每路单线程 ffmpeg), 总核占用 ≈ _FFMPEG_THREADS,
            # 多 worker 时各自受限, 避免 CPU 超订。
            seg_sem = asyncio.Semaphore(_SEG_CONCURRENCY)
            loop = asyncio.get_event_loop()

            async def _render_seg(idx: int, seg_text: str):
                # 不再逐图烧静态字幕: 字幕改由整段配音的 SRT(音字同步)统一烧录
                ip = os.path.join(td, f"img_{idx}.png")
                op = os.path.join(td, f"seg_{idx}.mp4")
                async with seg_sem:
                    await loop.run_in_executor(
                        None, _run,
                        _ken_burns_cmd(ip, op, dur=seg_dur, w=w, h=h, fps=fps,
                                       direction=random.randint(0, 3), caption="", font=font,
                                       sub_font_pct=sub_font_pct, sub_y_pct=sub_y_pct,
                                       sub_color=sub_color, sub_stroke=sub_stroke),
                    )
                return idx, op
            seg_paths = list(await asyncio.gather(*[_render_seg(idx, txt) for idx, _, txt in shot_data]))
            if not seg_paths:
                raise RuntimeError("无可用图片片段")
            seg_paths.sort(key=lambda x: x[0])
            vlist = os.path.join(td, "vlist.txt")
            with open(vlist, "w") as f:
                for _, p in seg_paths:
                    f.write(f"file '{p}'\n")
            silent = os.path.join(td, "silent.mp4")
            _run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", vlist, "-c", "copy", silent])

            # 合成前校验(防 3 秒残片 + 后续烧录 rc=234"Output无流"):
            # 若生图大面积缺失, 拼出的 silent.mp4 会远短于配音(极端只剩几秒), 继续烧字幕会因
            # 输入几乎无有效流而报 rc=234, 或产出与配音严重不符的残片。这里 fail-fast:
            # silent 时长应接近配音时长(段数×seg_dur≈audio_dur), 若不足配音的 80% 判为
            # "图不全导致的坏片", 直接失败并报明确原因, 不产出误导性的残缺成片。
            _silent_dur = _ffprobe_duration(silent)
            if audio_dur and _silent_dur and _silent_dur < audio_dur * 0.8:
                raise RuntimeError(
                    f"画面时长({_silent_dur:.0f}s)显著短于配音({audio_dur:.0f}s), "
                    f"疑似生图大面积缺失(有效图 {n_seg} 段)。已中止合成以免产出残缺成片, 请重跑补图。"
                )

            # === 自动字幕: whisper 时间戳 + 原文纠正 → SRT ===
            srt_path = os.path.join(td, "sub.srt")
            has_srt = False
            try:
                loop2 = asyncio.get_event_loop()
                has_srt = await loop2.run_in_executor(
                    None, subtitle_mod.generate_srt, full_audio, novel_text, srt_path,
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("generate_srt failed, skip subtitles: %s", e)
                has_srt = False

            # 字幕 + 固定水印 合并为「单次」重编码。
            # 之前分两趟(字幕一趟 + 水印一趟)且都限 -threads 2, 全长 1080p 重编码只有 ~1.5fps,
            # 800s 视频需数小时, 远超默认 600s 超时 → ffmpeg 被 SIGKILL(rc=-9) → 字幕烧录静默失败 → 成片无字幕。
            # 修复: 合并成一趟; 放开线程(用满 CPU); 超时按视频时长放宽; preset 用更快档以保证能在超时内完成。
            vf_parts: list[str] = []
            if has_srt and os.path.exists(srt_path) and os.path.getsize(srt_path) > 0:
                # subtitles 滤镜 force_style: 字号(px)/颜色/描边/底部边距/居中/单行(WrapStyle=2禁止自动换行, 已在SRT保证单行)
                # 关键: SRT 无 PlayRes, libass 默认按 PlayResY=288 坐标系渲染, 再整体缩放填满视频高度(放大 h/288 倍)。
                # 若直接把"视频像素"写进 FontSize/MarginV, 会被放大 h/288 倍 → 字巨大且顶到画面顶部。
                # 修复: 把目标像素值换算到 288 坐标系(× 288/h), 放大后正好还原为目标像素。
                fs_px = max(16, int(h * sub_font_pct))       # 目标字号(视频像素)
                mv_px = max(10, int(h * (1 - sub_y_pct)))    # 目标距底(视频像素)
                _ass_k = 288.0 / float(h)                     # 视频像素 → 288坐标系 的换算系数
                fs_ass = max(6, int(round(fs_px * _ass_k)))
                mv_ass = max(2, int(round(mv_px * _ass_k)))
                ol_ass = max(1, int(round(max(2, fs_px // 12) * _ass_k)))
                # 颜色名 → ASS &HAABBGGRR(AA=00不透明)。默认字色白、描边黑。
                _NAMED = {
                    "white": "&H00FFFFFF", "black": "&H00000000",
                    "red": "&H000000FF", "green": "&H0000FF00", "blue": "&H00FF0000",
                    "yellow": "&H0000FFFF", "gray": "&H00808080", "grey": "&H00808080",
                }
                def _c(col: str, default: str = "&H00FFFFFF") -> str:
                    s = (col or "").strip().lower()
                    if s in _NAMED:
                        return _NAMED[s]
                    hexc = s.lstrip("#")
                    if len(hexc) != 6:
                        return default  # 非法值用调用方给的默认(字=白, 边=黑), 不再一律回退白
                    r, g, b = hexc[0:2], hexc[2:4], hexc[4:6]
                    return f"&H00{b}{g}{r}".upper()
                # 用换算到 288 坐标系后的值(fs_ass/mv_ass/ol_ass), 而非原始视频像素, 避免被 libass 放大。
                style = (f"FontName=Noto Sans CJK SC,FontSize={fs_ass},"
                         f"PrimaryColour={_c(sub_color)},OutlineColour={_c(sub_stroke)},"
                         f"BorderStyle=1,Outline={ol_ass},Shadow=0,"
                         f"Alignment=2,MarginV={mv_ass},WrapStyle=2")
                srt_esc = srt_path.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
                # 不用 original_size: 保留 libass 默认 288 坐标系, 由上面的换算保证字号/边距正确。
                vf_parts.append(f"subtitles='{srt_esc}':force_style='{style}'")

            # 固定水印(免责声明/右上角标语) — X=总时长分钟
            ov = _overlay_filters(overlays, w=w, h=h, total_dur=audio_dur)
            if ov:
                vf_parts.append(ov)

            if vf_parts:
                burned = os.path.join(td, "burned.mp4")
                vf_all = ",".join(vf_parts)
                # 超时按时长放宽: 全长重编码在低速机器上可能远超默认 600s, 给足时间避免被误杀导致字幕丢失
                enc_timeout = max(1800, int((audio_dur or 60) * 60))
                try:
                    # 体积控制: 之前用 ultrafast+crf20, ultrafast 压缩效率极差, 40min 1080p 成片高达 ~2.7G(≈9Mbps)。
                    # 在不改分辨率/帧率前提下, 换更高效的 preset + 合理 CRF + 码率上限即可大幅降体积:
                    #   - preset medium: 压缩效率远高于 ultrafast(同画质体积可降 50%~70%)
                    #   - crf 23: 视觉近乎无损的常用档(数值越大越小; 20→23 已明显减小)
                    #   - maxrate 4M + bufsize 8M: 给码率封顶, 避免复杂画面瞬时码率飙高把文件撑大
                    # Ken Burns 画面变化平缓, 4Mbps 对 1080p 足够清晰; 40min 预计从 2.7G 降到 ~1G 以内。
                    _run(["ffmpeg", "-y", "-threads", str(_FFMPEG_THREADS), "-i", silent, "-vf", vf_all,
                          "-c:v", "libx264", "-preset", "medium", "-crf", "23",
                          "-maxrate", "4M", "-bufsize", "8M",
                          "-pix_fmt", "yuv420p", burned], timeout=enc_timeout)
                    silent = burned
                except Exception as e:  # noqa: BLE001
                    # 若字幕+水印这趟失败, 不能静默丢弃字幕 → 直接让整个合成失败, 便于定位
                    raise RuntimeError(f"字幕/水印烧录失败: {e}") from e
            # 封面(视频第一帧): 若有封面图, 烧标题/标签 → 生成极短静止片段 → concat 到主视频最前。
            # 封面无音轨, 主视频音轨仍从其画面起点对齐; 封面只占 1 帧, 不影响配音同步观感。
            if cover_key:
                try:
                    cover_img = os.path.join(td, "cover.png")
                    with open(cover_img, "wb") as f:
                        f.write(await _load_bytes(cover_key))
                    cover_clip = os.path.join(td, "cover.mp4")
                    # 封面片段编码需与主视频一致才能无损 concat; 主视频经过重编码(medium/crf23),
                    # 这里封面单帧用相近参数即可, concat 用 -c copy 会因参数差异失败, 故改用 filter concat 重编码。
                    _make_cover_clip(cover_img, cover_clip, w=w, h=h, fps=fps,
                                     cover_overlays=cover_overlays, title=cover_title, tags=cover_tags)
                    with_cover = os.path.join(td, "with_cover.mp4")
                    # 用 concat filter(重编码)拼接封面帧 + 主视频, 避免编码参数不一致导致的 concat 失败
                    _run(["ffmpeg", "-y", "-threads", str(_FFMPEG_THREADS), "-i", cover_clip, "-i", silent,
                          "-filter_complex",
                          "[0:v][1:v]concat=n=2:v=1:a=0[v]",
                          "-map", "[v]", "-c:v", "libx264", "-preset", "medium", "-crf", "23",
                          "-maxrate", "4M", "-bufsize", "8M", "-pix_fmt", "yuv420p", with_cover],
                         timeout=max(1800, int((audio_dur or 60) * 60)))
                    silent = with_cover
                except Exception as e:  # noqa: BLE001
                    logger.warning("job %s 封面帧拼接失败, 出无封面成片: %s", job_id, e)

            # 音轨: 若选了 BGM, 先把配音(翻倍)与 BGM(配音1/3, 循环, 按画面裁剪)混音; 否则仅配音翻倍。
            mixed_audio = os.path.join(td, "audio_final.mp3")
            vid_dur = _ffprobe_duration(silent) or audio_dur or 0
            if bgm_key:
                try:
                    bgm_path = os.path.join(td, "bgm.mp3")
                    with open(bgm_path, "wb") as f:
                        f.write(await _load_bytes(bgm_key))
                    _run(_mix_bgm_cmd(full_audio, bgm_path, mixed_audio, dur=vid_dur), timeout=600)
                except Exception as e:  # noqa: BLE001
                    logger.warning("BGM 混音失败, 回退纯配音(翻倍): %s", e)
                    _run(["ffmpeg", "-y", "-i", full_audio, "-af", "volume=2.0",
                          "-c:a", "libmp3lame", "-q:a", "2", mixed_audio])
            else:
                # 无 BGM 也把配音翻倍(用户反馈原声偏小)
                _run(["ffmpeg", "-y", "-i", full_audio, "-af", "volume=2.0",
                      "-c:a", "libmp3lame", "-q:a", "2", mixed_audio])

            final = os.path.join(td, "final.mp4")
            _run(["ffmpeg", "-y", "-i", silent, "-i", mixed_audio,
                  "-c:v", "copy", "-c:a", "aac", "-shortest", final])
            with open(final, "rb") as _f:
                _video_bytes = _f.read()
            video_key = await _oss_put(_video_bytes, user_id=user_id, namespace="novel-video-out", ext="mp4")
            await _set_job(job_id, video_oss_key=video_key, status="succeeded", progress=100)
    except Exception as e:  # noqa: BLE001
        logger.exception("novel_video compose %s failed", job_id)
        await _set_job(job_id, status="failed", error=str(e)[:1000])
    finally:
        _COMPOSE_SEM.release()


# ---------------- 僵尸任务恢复(服务重启后) ----------------
# 运行中状态: 这些状态意味着有个 worker 在跑该任务。
# 关键: 'pending' 不在此列 —— pending 是"待 worker 认领"的队列态(worker 按 status='pending'
#   轮询认领), 是正常等待状态, 不是僵尸。主站 orchestrator 重启绝不能把 pending 当中断任务处理,
#   否则会把大批"刚建好还没被 worker 认领"的任务误杀成 failed(这是之前大量"服务重启中断"报错的根因)。
# 真正需要恢复的僵尸: worker 认领后置的中间态(audio/prompting/imaging/compositing), 若 worker 进程
#   中途挂掉会滞留在这些态。但 worker 侧有自己的认领与恢复, 主站只做兜底判定, 且只碰这些"运行中态", 不碰 pending。
_RUNNING_STATUSES = ("audio", "prompting", "imaging", "compositing")


async def _resume_imaging_and_compose(job_id: int) -> None:
    """续跑: 补齐未完成的图(跳过已 done 的, 不重复消耗) → 合成。用于 imaging/compositing 阶段被中断的任务。"""
    from sqlalchemy import select as _select
    async with session_scope() as s:
        job = await s.get(NovelVideoJob, job_id)
        if not job:
            return
        model = job.image_model or "gpt-image-2"
        size = f"{job.width}x{job.height}"
        style_prompt = job.style_prompt or ""
        ref_image_keys = list(job.ref_image_oss_keys or ([] if not job.ref_image_oss_key else [job.ref_image_oss_key]))
        # 未完成(非 done)的分镜 = 需要补生图的
        pending_shots = (await s.execute(
            _select(NovelVideoShot.id).where(
                NovelVideoShot.job_id == job_id,
                NovelVideoShot.status != "done",
            )
        )).scalars().all()
    ref_imgs = [await _load_bytes(k) for k in ref_image_keys] if ref_image_keys else []
    if pending_shots:
        await _set_job(job_id, status="imaging", progress=55)
        await asyncio.gather(*[
            _gen_one_image(sid, model=model, size=size, style_prompt=style_prompt, ref_images=ref_imgs)
            for sid in pending_shots
        ])
    # 补完图后进合成(compose_job 幂等: 用现有图+配音重新合成)
    await _set_job(job_id, status="await_confirm", progress=70)
    await compose_job(job_id)


async def recover_interrupted_jobs() -> None:
    """服务启动时调用: 把上个进程遗留的"运行中"僵尸任务恢复。

    策略(按数据完整度就近续跑, 不重复已完成的工作):
      - 已有成片(video_oss_key)      → 只是状态没更新, 直接置 succeeded;
      - 有配音(audio_oss_key)+有分镜  → imaging/compositing 阶段被中断, 补未完成的图再合成(续跑);
      - 其它(pending/audio/prompting 早期, 数据不全) → 标 failed, 提示用户重新发起。
    恢复在后台跑, 不阻塞启动。
    """
    from sqlalchemy import select as _select, text as _text
    # 关键(防误杀正在跑的活任务): 只恢复 updated_at 停滞超过阈值(默认15分钟)的"运行中"任务。
    # 背景: recover 在主服务 orchestrator 启动时跑。若此刻算力机 worker 正跑着某任务(处于
    #   audio/prompting/imaging/compositing 态), 不加时间过滤会把"正被 worker 活跃处理"的任务
    #   误判为僵尸 → 置回 pending → 被另一个 worker 重复认领(曾导致 job 649 被两 worker 同跑,
    #   进而临时文件/输出踩踏、成片损坏)。worker 每推进一个阶段都会 _set_job 更新 updated_at,
    #   故正在跑的任务 updated_at 会持续刷新, 只有真正卡死(进程已亡)的任务才会停滞超阈值。
    stale_minutes = int(os.getenv("NV_RECOVER_STALE_MINUTES", "15"))
    try:
        async with session_scope() as s:
            jobs = (await s.execute(
                _select(NovelVideoJob).where(
                    NovelVideoJob.status.in_(_RUNNING_STATUSES),
                    NovelVideoJob.updated_at < _text(f"now() - interval '{stale_minutes} minutes'"),
                )
            )).scalars().all()
            snapshots = [
                (j.id, j.status, bool(j.video_oss_key), bool(j.audio_oss_key))
                for j in jobs
            ]
    except Exception as e:  # noqa: BLE001
        logger.warning("novel_video 僵尸任务扫描失败: %s", e)
        return

    if not snapshots:
        return
    logger.info("novel_video: 发现 %d 个重启遗留的运行中任务, 开始恢复", len(snapshots))

    for job_id, status, has_video, has_audio in snapshots:
        try:
            if has_video:
                await _set_job(job_id, status="succeeded", progress=100)
                logger.info("novel_video job %s: 已有成片, 置 succeeded", job_id)
                continue
            # 有配音+分镜 → imaging/compositing 阶段被中断, 有中间产物可续跑:
            #   置 pending + pending_action='run', 交 worker 认领(run_job 幂等: 已 done 的分镜跳过,
            #   只补未完成的图, 不重复消耗已生成的图的额度)。
            # 无配音(pending/audio/prompting 早期) → 数据不全、无有效中间产物, 判定为"确认失败、
            #   无续跑可能": 直接标 failed, 不重跑、不占用算力和生图额度(避免浪费在注定要重来的任务上)。
            async with session_scope() as s:
                shot_cnt = (await s.execute(
                    _select(__import__("sqlalchemy").func.count()).select_from(NovelVideoShot)
                    .where(NovelVideoShot.job_id == job_id)
                )).scalar() or 0
            if has_audio and shot_cnt > 0:
                await _set_job(job_id, status="pending", pending_action="run",
                               action_params=None, error=None)
                logger.info("novel_video job %s: 有配音+分镜, 置 pending 交 worker 续跑(补未完成的图)", job_id)
            else:
                await _set_job(
                    job_id, status="failed",
                    error="服务重启导致任务中断(早期阶段, 无有效中间产物无法续跑), 请重新发起。",
                )
                logger.info("novel_video job %s: 早期中断无中间产物, 标 failed(不重跑不占额度)", job_id)
        except Exception as e:  # noqa: BLE001
            logger.warning("novel_video job %s 恢复失败: %s", job_id, e)


async def _safe_resume(job_id: int) -> None:
    try:
        await _resume_imaging_and_compose(job_id)
    except Exception as e:  # noqa: BLE001
        logger.exception("novel_video job %s 续跑失败", job_id)
        await _set_job(job_id, status="failed", error=f"续跑失败: {str(e)[:500]}")


async def regenerate_shot(shot_id: int, *, new_prompt: Optional[str] = None) -> None:
    """重新生成单张图(可带新提示词)。"""
    async with session_scope() as s:
        shot = await s.get(NovelVideoShot, shot_id)
        if not shot:
            return
        job = await s.get(NovelVideoJob, shot.job_id)
        if new_prompt:
            shot.image_prompt = new_prompt
        shot.regenerate_count = (shot.regenerate_count or 0) + 1
        shot.status = "imaging"
        model = job.image_model or "gpt-image-2"
        size = f"{job.width}x{job.height}"
        style_prompt = job.style_prompt or ""
        ref_image_keys = list(job.ref_image_oss_keys or ([] if not job.ref_image_oss_key else [job.ref_image_oss_key]))
    ref_imgs = [await _load_bytes(k) for k in ref_image_keys] if ref_image_keys else []
    await _gen_one_image(shot_id, model=model, size=size, style_prompt=style_prompt, ref_images=ref_imgs)
