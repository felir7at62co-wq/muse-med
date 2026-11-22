"""前贴(front-cut)流水线编排 — B线状态机。

阶段:
  run_reverse_and_prompts(job): reversing → 反推 → prompting → 生成5条提示词 → await_pick_prompt(停, 等前端展示/或直接生成视频)
  generate_videos(job): generating → 5框架并发调 RunningHub 生成前贴视频 → await_pick(等用户挑选)
  compose_final(job, framework_id): composing → 前贴+剧情拼接(走外置剪辑节点, 见 TODO) → succeeded

注意:
- 视频生成用现成 clip.video_provider(RunningHub SparkVideo), seedance-2.0 暂搁置。
- 前贴与剧情拼接的 ffmpeg 重编码必须走外置算力服务器(用户正在加), 主机/prod 不跑重编码。
  当前先留 compose_final 的接口与 TODO, 外置节点就绪后接入。
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import subprocess
import tempfile
from datetime import datetime

from sqlalchemy import select

from ..billing import service as billing_service
from ..db import session_scope
from ..factory.usage import set_usage_context
from ..oss import client as oss
from ..volc import client as volc_video
from ..volc import billing as volc_billing
from .models import FrontcutJob
from .reverse import reverse_video, reverse_first_frame
from .prompts import generate_frontcut_prompts, append_tail_frame_constraint
from . import tts

logger = logging.getLogger("frontcut.service")

# 前贴视频生成并发(5框架), 外部API不占本机CPU, 可并发
_GEN_SEM = asyncio.Semaphore(5)
_POLL_INTERVAL = 6
_POLL_MAX = 900

# 拼接是纯 concat(无运镜/每条≤2次/低频), 本地做即可。
# ⚠️吸取 CPU 事故教训: 严格限 ffmpeg 线程数(-threads 2)+信号量限并发, 绝不 -threads 0 打满核。
_COMPOSE_SEM = asyncio.Semaphore(2)
_FFMPEG_THREADS = "2"


async def _set(job_id: int, **kw) -> None:
    async with session_scope() as s:
        j = await s.get(FrontcutJob, job_id)
        if not j:
            return
        for k, v in kw.items():
            setattr(j, k, v)


async def _seed_usage(job_id: int, *, source: str) -> None:
    """给本任务的后台协程播种计费归属 (job.user_id + user_ref)。

    前贴流水线全部跑在 BackgroundTasks / asyncio.create_task 里, 没有请求上下文;
    不播种的话下面所有 LLM(反推/提示词)与 RunningHub(口播/高清)调用都归不到人。
    归属字段取 job 上已固化的一份 —— 改动业务字段不会影响已播种的归属。
    """
    try:
        async with session_scope() as s:
            j = await s.get(FrontcutJob, job_id)
            if not j:
                return
            set_usage_context(job_id=None, user_id=j.user_id, source=source)
    except Exception as e:  # noqa: BLE001
        logger.warning("frontcut job %s 播种计费归属失败(不阻断): %s", job_id, e)


# 火山内容安全对"输入参考图含真人"的拒绝特征(HTTP 400)。
# 典型报文: InputImageSensitiveContentDetected.PrivacyInformation /
#          "the input image 'content[1]' may contain real person"
_REAL_PERSON_ERR_PAT = re.compile(
    r"InputImageSensitiveContentDetected"
    r"|PrivacyInformation"
    r"|may contain real person"
    r"|SensitiveContentDetected",
    re.I,
)


def _is_ref_image_refused(err: BaseException | str) -> bool:
    """判断异常是否为"参考图被内容安全拒绝"(可通过去掉参考图降级重试)。"""
    return bool(_REAL_PERSON_ERR_PAT.search(str(err)))


async def _cand_patch(job_id: int, framework_id: str, **fields) -> None:
    """增量更新某条视频候选的字段(其它条保持最新状态, 不整表覆盖)。

    用于生成过程中把 段1/段2 的中间产物(seg1_video_oss_key 等)即时写库,
    让前端两个预览框能在两段各自完成时就分别显示, 不必等 concat 结束。
    """
    async with session_scope() as s:
        j = await s.get(FrontcutJob, job_id)
        if not j:
            return
        cur = list(j.video_candidates or [])
        hit = False
        out = []
        for c in cur:
            cc = dict(c)
            if cc.get("framework_id") == framework_id:
                cc.update(fields)
                hit = True
            out.append(cc)
        if not hit:
            base = {"framework_id": framework_id}
            base.update(fields)
            out.append(base)
        j.video_candidates = out


async def _video_url_for(job: FrontcutJob) -> str:
    """取剧情视频的公网直链(喂给豆包反推)。优先 OSS key 签名, 其次现成 URL。"""
    if job.source_video_oss_key:
        return oss.sign_get_url(job.source_video_oss_key, ttl_seconds=3600)
    if job.source_video_url:
        return job.source_video_url
    raise RuntimeError("缺少剧情视频(source_video_oss_key/url)")


async def _fetch_corpus_context(corpus_ids: list[int], *, max_chars: int = 400_000) -> str:
    """拉用户勾选的语料库文本拼成参考语料。失败返回空串(不阻断主流程)。

    ⚠️ 飞书短剧库方案已彻底弃用: 任何情况下都不再把飞书文本塞进上下文。
    参考语料只来自用户在语料库弹窗里勾选的条目(预置 + 自上传)。
    """
    ctx, _ = await _resolve_corpus(corpus_ids, max_chars=max_chars, auto_recall=False)
    return ctx


async def _resolve_corpus(
    corpus_ids: list[int], *, max_chars: int = 400_000, auto_recall: bool = True,
) -> tuple[str, str]:
    """解析本次生成可用的语料参考。返回 (library_context, topic_hints)。

    - corpus_ids 非空: 用用户勾选的条目(原逻辑)。
    - corpus_ids 为空且 auto_recall: 【自动召回】——按 hook_type 分桶, 每种钩子类型取最新 2 条
      已打标语料(总数 ≤ 8), 保证 5 套框架都有对应风格的爆款参考, 语料库不再闲置。
    - topic_hints: 用所选语料的打标结果(tagger.build_topic_hints_from_items)拼成题材方向提示,
      注入 build_meta_prompt 帮 grok 选切入角度。
    失败返回 ("", "")(不阻断主流程)。
    """
    try:
        from sqlalchemy import select
        from ..corpus.models import FrontcutCorpusItem
        from ..corpus import tagger

        async with session_scope() as s:
            if corpus_ids:
                rows = (await s.execute(
                    select(FrontcutCorpusItem).where(FrontcutCorpusItem.id.in_(corpus_ids))
                )).scalars().all()
            elif auto_recall:
                all_rows = (await s.execute(
                    select(FrontcutCorpusItem).where(
                        FrontcutCorpusItem.status == "done",
                        FrontcutCorpusItem.content != "",
                    ).order_by(FrontcutCorpusItem.id.desc())
                )).scalars().all()
                by_hook: dict[str, int] = {}
                rows = []
                for it in all_rows:
                    hk = (it.hook_type or "").strip() or "其他"
                    if by_hook.get(hk, 0) >= 2:
                        continue
                    by_hook[hk] = by_hook.get(hk, 0) + 1
                    rows.append(it)
                    if len(rows) >= 8:
                        break
                if rows:
                    logger.info("frontcut 语料自动召回 %d 条(按hook_type分桶): %s",
                                len(rows), [r.id for r in rows])
            else:
                rows = []

        parts: list[str] = []
        total = 0
        for i, item in enumerate(rows, 1):
            t = (item.content or "").strip()
            if not t:
                continue
            block = f"[语料#{i}·{item.title or '未命名'}] {t}"
            if total + len(block) > max_chars:
                break
            parts.append(block)
            total += len(block)
        hints = tagger.build_topic_hints_from_items(list(rows))
        return "\n\n".join(parts), hints
    except Exception as e:  # noqa: BLE001
        logger.warning("拉语料库参考失败(不阻断): %s", e)
        return "", ""


def _build_pe_context(job: FrontcutJob) -> str:
    """构造传给 seedance PE 优化器的硬约束背景(参考图清单/音频规则/场景预算)。

    目的(2026-08 修复): 优化器不知道本次实际提供了哪些参考图, 曾幻觉发明 "@图片1/@图片2
    作为人物外观参考"——而实际只有正片首帧(路牌/场景图), 导致人物生成崩坏。此处把真实
    图片清单 + 音频规则显式告知优化器。
    """
    has_char = bool(getattr(job, "ref_image_oss_key", None))
    if has_char:
        img_rule = (
            "本次实际提供 2 张参考图: 图1=正片首帧画面(仅用作前贴末帧衔接参考, 不是人物形象参考); "
            "图2=主角形象参考(人物外观须与图2一致, 可用 @图片2 引用人物)。"
            "除这 2 张外不存在任何图片, 严禁引用或发明其它 @图片N。"
        )
    else:
        img_rule = (
            "本次【没有提供任何人物形象参考图】(仅有 1 张正片首帧画面图, 只作前贴末帧衔接参考, "
            "画面内容可能是场景/物件而非人物)。提示词中【严禁出现 @图片1、@图片2 等任何图片引用】, "
            "所有人物外观一律用文字直接定义。"
        )
    return (
        "【硬约束(优化提示词时必须遵守, 优先级高于一切风格发挥)】\n"
        f"1. 参考图规则: {img_rule}\n"
        "2. 音频规则: 成片唯一人声是后期叠加的口播旁白配音, 提示词中【严禁给人物写台词/对话/"
        "人声语音内容】(人物可以有动作和口型但不能规定其说话内容); 只允许描述环境音效与背景音乐氛围。\n"
        "3. 场景预算: 全片最多 2 个场景、1 次场景转换; 严禁 3 个以上场景或多段时空快切分镜。"
    )


def _extract_first_frame(video_path: str, out_jpg: str) -> None:
    """用 ffmpeg 提取视频首帧为 jpg(供作为前贴视频的尾帧参考图, 确保衔接连贯)。"""
    cmd = ["ffmpeg", "-y", "-threads", _FFMPEG_THREADS, "-i", video_path,
           "-vf", "select=eq(n\\,0)", "-frames:v", "1", "-q:v", "2", out_jpg]
    _run_ffmpeg(cmd, timeout=120)


def _extract_last_frame(video_path: str, out_jpg: str) -> None:
    """用 ffmpeg 提取视频最后一帧为 jpg(两段式生成: 第1段末帧作第2段首帧参考图)。"""
    cmd = ["ffmpeg", "-y", "-threads", _FFMPEG_THREADS, "-sseof", "-1",
           "-i", video_path, "-update", "1", "-frames:v", "1", "-q:v", "2", out_jpg]
    _run_ffmpeg(cmd, timeout=120)


async def _prepare_ref_images(job: FrontcutJob) -> tuple[list[str], str, str | None, str | None]:
    """准备生成视频用的参考图 URL 列表 + 给提示词追加的图注说明。

    返回 (image_urls, image_note, ff_url, char_url):
      - image_urls/image_note: 单段生成用的合并清单(图1=正片首帧作尾帧, 图2=主角形象可选)
      - ff_url: 正片首帧签名URL(两段式生成时单独给第2段作尾帧参考)
      - char_url: 主角形象参考图签名URL(可空; 两段式生成时两段都带)
    """
    urls: list[str] = []
    notes: list[str] = []
    ff_url: str | None = None
    char_url: str | None = None

    def _do_extract(story_key: str) -> bytes | None:
        with tempfile.TemporaryDirectory() as d:
            sp = os.path.join(d, "story.mp4")
            fp = os.path.join(d, "first.jpg")
            oss.get_object_to_file(story_key, sp)
            _extract_first_frame(sp, fp)
            with open(fp, "rb") as f:
                return f.read()

    # 1) 正剧首帧 → 作为尾帧参考图
    try:
        if job.source_video_oss_key:
            raw = await asyncio.to_thread(_do_extract, job.source_video_oss_key)
            if raw:
                fk = oss.build_oss_key(user_id=0, filename=f"frontcut_firstframe_{job.id}.jpg", namespace="frontcut-ref")
                await asyncio.to_thread(oss.get_bucket_public().put_object, fk, raw)
                ff_url = oss.sign_get_url(fk, ttl_seconds=3600)
                # ⚠️ 火山多图必须带 role; first/last 不可与 reference 混用, 且 last_frame 不能单独用。
                # 故单段路径统一用 reference_image(尾帧衔接靠提示词文字约束)。
                urls.append({"url": ff_url, "role": "reference_image"})
                notes.append(f"参考图{len(urls)}是正片开头画面(前贴视频的最后一帧须尽量衔接到此画面, 保证与正片开头连贯; 它不是前贴的起始画面)")
    except Exception as e:  # noqa: BLE001
        logger.warning("提取正剧首帧失败(不阻断): %s", e)

    # 2) 用户上传的主角形象参考图(可选)
    if getattr(job, "ref_image_oss_key", None):
        try:
            char_url = oss.sign_get_url(job.ref_image_oss_key, ttl_seconds=3600)
            urls.append({"url": char_url, "role": "reference_image"})
            notes.append(f"参考图{len(urls)}是主角形象参考(前贴中人物外形须与此一致)")
        except Exception:  # noqa: BLE001
            pass

    note = ("；".join(notes) + "。") if notes else ""
    return urls, note, ff_url, char_url


def _probe_duration_seconds(url: str) -> int:
    """用 ffprobe 探测视频时长(秒, 取整); 失败返回 0。直接读公网/签名 URL, 不下整片。"""
    try:
        cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "default=noprint_wrappers=1:nokey=1", url]
        p = subprocess.run(cmd, capture_output=True, timeout=60)
        if p.returncode == 0:
            return int(float((p.stdout or b"0").decode().strip() or 0))
    except Exception as e:  # noqa: BLE001
        logger.warning("ffprobe 探测原片时长失败(不阻断): %s", e)
    return 0


async def _reverse_source(job_id: int, job: FrontcutJob, url: str, *, target_chars: int | None) -> str:
    """反推正片剧情视频 → 完整口播文案。

    豆包视频理解: URL 拉取有 50MiB 硬限, Files API 上传支持 2GB。因此优先用 oss_key 走
    Files API 整片上传反推(原画质、完整剧情、无大小限制); reverse_video 内部会下载→上传→
    file_id 引用, 失败才回退 URL 直连。实测(2026-07-16): 61MB 正片 Files API 反推成功。
    """
    return await reverse_video(url, target_chars=target_chars, timeout=600.0,
                               oss_key=job.source_video_oss_key)


async def _make_first_frame_desc(job_id: int, job: FrontcutJob) -> str:
    """提取正片首帧 → 反推其画面描述 → 存 job.first_frame_desc, 返回描述。

    用于前贴'首帧锚点衔接': grok 让故事收束到此画面, Seedance 提示词追加尾帧约束。
    任何一步失败都降级返回空串(不阻断主流程; 仍有首帧参考图兜底)。
    """
    try:
        if not job.source_video_oss_key:
            return ""

        def _extract_upload() -> str | None:
            with tempfile.TemporaryDirectory() as d:
                sp = os.path.join(d, "story.mp4")
                fp = os.path.join(d, "first.jpg")
                oss.get_object_to_file(job.source_video_oss_key, sp)
                _extract_first_frame(sp, fp)
                with open(fp, "rb") as f:
                    raw = f.read()
            fk = oss.build_oss_key(user_id=0, filename=f"frontcut_ff_{job_id}.jpg", namespace="frontcut-ref")
            oss.get_bucket_public().put_object(fk, raw)
            return oss.sign_get_url(fk, ttl_seconds=3600)

        img_url = await asyncio.to_thread(_extract_upload)
        if not img_url:
            return ""
        desc = await reverse_first_frame(image_url=img_url, timeout=120.0)
        desc = (desc or "").strip()
        if desc:
            await _set(job_id, first_frame_desc=desc)
        return desc
    except Exception as e:  # noqa: BLE001
        logger.warning("frontcut job %s 首帧描述反推失败(降级, 仍用首帧参考图): %s", job_id, str(e)[:200])
        return ""


async def run_reverse_and_prompts(job_id: int) -> None:
    """反推剧情视频 → 生成5条前贴提示词, 停在 await_pick(等用户看/挑, 或直接触发生成视频)。"""
    try:
        await _set(job_id, status="reversing", progress=10)
        async with session_scope() as s:
            job = await s.get(FrontcutJob, job_id)
            if not job:
                return
            user_ref = job.user_ref or ""
            front_duration = int(job.duration or 10)  # 前贴时长(秒), 决定前贴口播字数
            corpus_ids = list(job.corpus_ids or [])  # 用户勾选的语料库条目
        # 计费归属: 本函数跑在后台协程里, 没有请求上下文, 显式盖一次(job.user_id)
        set_usage_context(job_id=None, user_id=job.user_id, source="frontcut")
        url = await _video_url_for(job)
        # 探测原片时长 → 原片口播文案目标字数 = 秒数 × 6(高密度; 成片时口播 atempo 变速对齐画面)
        src_seconds = await asyncio.to_thread(_probe_duration_seconds, url)
        target_chars = src_seconds * 6 if src_seconds > 0 else None
        rev = await _reverse_source(job_id, job, url, target_chars=target_chars)
        await _set(job_id, reverse_summary=rev, status="prompting", progress=40)

        # 【首帧锚点衔接】提取正片首帧并反推其画面描述(供 grok 收束/Seedance 尾帧约束)。
        # 失败降级: first_frame_desc 为空, 仍能用剧情+首帧参考图做衔接, 不阻断主流程。
        first_frame_desc = await _make_first_frame_desc(job_id, job)

        # 参考语料只来自语料库(用户勾选优先; 未勾选则按hook_type自动召回)。飞书短剧库方案已彻底弃用。
        library_context, topic_hints = await _resolve_corpus(corpus_ids, max_chars=400_000)
        cands = await generate_frontcut_prompts(
            reverse_summary=rev, user_ref=user_ref, optimize=True,
            library_context=library_context, duration=front_duration,
            first_frame_desc=first_frame_desc, topic_hints=topic_hints,
            pe_context=_build_pe_context(job),
        )
        # 提示词就绪即进入可挑选态; 口播不在此触发, 改为与视频"一起"在 generate_videos 里触发
        await _set(job_id, prompt_candidates=cands, status="await_pick_prompt", progress=70)
    except Exception as e:  # noqa: BLE001
        logger.exception("frontcut job %s reverse/prompts failed", job_id)
        await _set(job_id, status="failed", error=str(e)[:1000])


async def regenerate_prompts(job_id: int) -> None:
    """重新生成 5 条前贴提示词(不重跑反推, 复用已有 reverse_summary)。

    用于提示词整体生成失败/不满意时重来一次。完成后回到 await_pick_prompt。
    """
    try:
        async with session_scope() as s:
            job = await s.get(FrontcutJob, job_id)
            if not job:
                return
            rev = job.reverse_summary or ""
            user_ref = job.user_ref or ""
            front_duration = int(job.duration or 10)
            corpus_ids = list(job.corpus_ids or [])
            first_frame_desc = job.first_frame_desc or ""  # 复用已存首帧描述, 不重复反推
        set_usage_context(job_id=None, user_id=job.user_id, source="frontcut")
        if not rev.strip():
            # 没有反推结果, 退回完整反推+提示词流程
            await run_reverse_and_prompts(job_id)
            return
        await _set(job_id, status="prompting", progress=40)
        library_context, topic_hints = await _resolve_corpus(corpus_ids, max_chars=400_000)
        cands = await generate_frontcut_prompts(
            reverse_summary=rev, user_ref=user_ref, optimize=True,
            library_context=library_context, duration=front_duration,
            first_frame_desc=first_frame_desc, topic_hints=topic_hints,
            pe_context=_build_pe_context(job),
        )
        await _set(job_id, prompt_candidates=cands, status="await_pick_prompt", progress=70)
    except Exception as e:  # noqa: BLE001
        logger.exception("frontcut job %s regenerate_prompts failed", job_id)
        await _set(job_id, status="failed", error=str(e)[:1000])


async def regenerate_one_prompt(job_id: int, framework_id: str) -> None:
    """只重新生成某一条框架的前贴提示词(复用已有 reverse_summary), 其余 4 条不动。"""
    try:
        from .frameworks import FRAMEWORKS
        from .prompts import _gen_one
        async with session_scope() as s:
            job = await s.get(FrontcutJob, job_id)
            if not job:
                return
            rev = job.reverse_summary or ""
            user_ref = job.user_ref or ""
            front_duration = int(job.duration or 10)
            corpus_ids = list(job.corpus_ids or [])
            first_frame_desc = job.first_frame_desc or ""  # 修复: 之前漏传导致单条重生失去首帧锚点
            cands = list(job.prompt_candidates or [])
            pe_context = _build_pe_context(job)
        set_usage_context(job_id=None, user_id=job.user_id, source="frontcut")
        if not rev.strip():
            return
        fw = next((f for f in FRAMEWORKS if f["id"] == framework_id), None)
        if not fw:
            return
        library_context, topic_hints = await _resolve_corpus(corpus_ids, max_chars=400_000)
        new_c = await _gen_one(fw, reverse_summary=rev, user_ref=user_ref,
                               optimize=True, library_context=library_context,
                               duration=front_duration, first_frame_desc=first_frame_desc,
                               topic_hints=topic_hints, pe_context=pe_context)
        # 合并回该条(保留其它条)
        async with session_scope() as s:
            job = await s.get(FrontcutJob, job_id)
            if not job:
                return
            cur = [c for c in (job.prompt_candidates or []) if c.get("framework_id") != framework_id]
            cur.append(new_c)
            # 按 FRAMEWORKS 原顺序排列, 保持 UI 稳定
            order = {f["id"]: i for i, f in enumerate(FRAMEWORKS)}
            cur.sort(key=lambda c: order.get(c.get("framework_id"), 99))
            job.prompt_candidates = cur
        logger.info("frontcut job %s 重生单条提示词 %s 完成", job_id, framework_id)
    except Exception as e:  # noqa: BLE001
        logger.exception("frontcut job %s 重生单条提示词 %s 失败: %s", job_id, framework_id, e)


async def regenerate_narration(job_id: int, framework_id: str, new_narration: str | None = None) -> None:
    """按(可选编辑后的)口播文案重新合成单条前贴口播音频。

    new_narration: 用户编辑后的口播文案; 不传则用该候选现有 narration 重合成。
    需 job 已选参考音色, 否则忽略。
    """
    try:
        async with session_scope() as s:
            job = await s.get(FrontcutJob, job_id)
            if not job:
                return
            voice_key = job.voice_ref_oss_key
            cands = list(job.prompt_candidates or [])
        set_usage_context(job_id=None, user_id=job.user_id, source="frontcut")
        if not voice_key:
            logger.warning("frontcut job %s 未选参考音色, 无法重生口播", job_id)
            return
        # 更新该条 narration 文案(若传入)
        if new_narration is not None and new_narration.strip():
            for c in cands:
                if c.get("framework_id") == framework_id:
                    c["narration"] = new_narration.strip()
            await _set(job_id, prompt_candidates=cands)
        target = next((c for c in cands if c.get("framework_id") == framework_id), None)
        if not target or not (target.get("narration") or "").strip():
            return
        # 下载参考音 → 上传 → 合成该条
        def _load_voice() -> bytes:
            import tempfile as _tf
            with _tf.TemporaryDirectory() as d:
                p = os.path.join(d, "voice_ref.wav")
                oss.get_bucket_public().get_object_to_file(voice_key, p)
                with open(p, "rb") as f:
                    return f.read()
        raw = await asyncio.to_thread(_load_voice)
        ref_fn = await tts.upload_ref_voice(raw, filename="voice_ref.wav")
        k = await tts.synth_one(ref_file_name=ref_fn, text=target["narration"].strip(),
                                oss_namespace="frontcut-narration",
                                oss_filename=f"front_{job_id}_{framework_id}.mp3")
        # 回填该条 narration_audio_oss_key
        async with session_scope() as s:
            job = await s.get(FrontcutJob, job_id)
            cur = list(job.prompt_candidates or [])
            for c in cur:
                if c.get("framework_id") == framework_id:
                    c["narration_audio_oss_key"] = k
            job.prompt_candidates = cur
        logger.info("frontcut job %s 口播 %s 重生完成", job_id, framework_id)
    except Exception as e:  # noqa: BLE001
        logger.exception("frontcut job %s 口播 %s 重生失败: %s", job_id, framework_id, e)


async def _synth_all_narrations_safe(job_id: int, voice_key: str, reverse_text: str, cands: list[dict]) -> None:
    """后台口播合成包装: 捕获所有异常并记详细日志, 不影响主流程(状态已是 await_pick_prompt)。"""
    try:
        await _synth_all_narrations(job_id, voice_key, reverse_text, cands)
        logger.info("frontcut job %s 口播语音克隆全部完成", job_id)
    except Exception as e:  # noqa: BLE001
        logger.exception("frontcut job %s 口播合成失败(不阻断, 仅缺音频): %s", job_id, e)


async def _synth_all_narrations(job_id: int, voice_key: str, reverse_text: str, cands: list[dict]) -> None:
    """用参考音色合成: 原片口播(reverse_text) + 每条前贴口播(cand.narration)。

    参考音色只上传一次, 拿 ref_file_name 后 5+1 段共用。结果写回:
      - job.narration_audio_oss_key (原片口播)
      - prompt_candidates[i].narration_audio_oss_key (各前贴口播)
    """
    # 本函数经 _synth_all_narrations_safe 派生自 generate_videos 的后台任务;
    # 显式播种一次, 保证下面 6 段 TTS(计费入库)与任何 LLM 归到人头上。
    await _seed_usage(job_id, source="frontcut.tts")
    # 参考音是用 get_bucket_public().put_object 存的, 必须用同一 public bucket 读回(否则 NoSuchKey)
    def _load_voice() -> bytes:
        import tempfile as _tf
        with _tf.TemporaryDirectory() as d:
            p = os.path.join(d, "voice_ref.wav")
            oss.get_bucket_public().get_object_to_file(voice_key, p)
            with open(p, "rb") as f:
                return f.read()
    raw = await asyncio.to_thread(_load_voice)
    logger.info("frontcut job %s 参考音已下载(%d字节), 开始语音克隆合成", job_id, len(raw))
    ref_fn = await tts.upload_ref_voice(raw, filename="voice_ref.wav")

    # 原片口播
    try:
        if (reverse_text or "").strip():
            nk = await tts.synth_one(ref_file_name=ref_fn, text=reverse_text,
                                     oss_namespace="frontcut-narration", oss_filename=f"orig_{job_id}.mp3")
            await _set(job_id, narration_audio_oss_key=nk)
    except Exception as e:  # noqa: BLE001
        logger.warning("原片口播合成失败: %s", e)

    # 5条前贴口播(并发)
    async def _one(c: dict) -> dict:
        cc = dict(c)
        nar = (c.get("narration") or "").strip()
        if nar:
            try:
                k = await tts.synth_one(ref_file_name=ref_fn, text=nar,
                                        oss_namespace="frontcut-narration",
                                        oss_filename=f"front_{job_id}_{c.get('framework_id')}.mp3")
                cc["narration_audio_oss_key"] = k
            except Exception as e:  # noqa: BLE001
                logger.warning("前贴口播 %s 合成失败: %s", c.get("framework_id"), e)
        return cc

    new_cands = await asyncio.gather(*[_one(c) for c in cands])
    await _set(job_id, prompt_candidates=list(new_cands))


async def _submit_and_wait_video(
    *, prompt: str, ratio: str, resolution: str, duration: int,
    image_urls: list | None, user_id: int | None, job_id: int,
) -> tuple[bytes, str]:
    """提交一次 Seedance 生成并轮询到完成, 下载返回 (视频字节, task_id)。失败抛异常。已计费。

    ⚠️ 内容安全降级(2026-08): 主角形象参考图若是真人照片/截图, 火山会直接 400 拒绝
    (InputImageSensitiveContentDetected.PrivacyInformation "may contain real person")。
    此时不能直接判该条失败——自动去掉参考图重试一次(人物外观改由提示词文字约束),
    保证"按此提示词重新生成视频"不会因为一张真人参考图而永远失败。
    """
    imgs = list(image_urls or [])
    try:
        task_id = await volc_video.submit_video(
            prompt=prompt, resolution=resolution, duration=str(duration),
            ratio=ratio or "9:16", generate_audio=True,
            image_urls=imgs,
        )
    except Exception as e:  # noqa: BLE001
        if not (imgs and _is_ref_image_refused(e)):
            raise
        # 降级: 去掉全部参考图, 纯文生视频重试(提示词里已有完整人物外观描述)
        logger.warning(
            "frontcut job %s 参考图被火山内容安全拒绝, 去参考图降级重试(纯文生视频): %s",
            job_id, str(e)[:200],
        )
        fallback_prompt = (
            f"{prompt}\n\n【注意】本次没有任何参考图, 人物外观/服装/场景一律严格按上文文字描述生成, "
            "不要引用任何图片。"
        )
        task_id = await volc_video.submit_video(
            prompt=fallback_prompt, resolution=resolution, duration=str(duration),
            ratio=ratio or "9:16", generate_audio=True,
            image_urls=[],
        )
    waited = 0
    while waited < _POLL_MAX:
        st = await volc_video.query_video(task_id)
        status = (st.get("status") or "").upper()
        if status in ("SUCCESS", "SUCCEEDED", "COMPLETED"):
            # 计费(旁路, 失败不阻断): 用返回 usage 精确计, 缺失按参数档位估算
            try:
                u = volc_billing.extract_usage({"usage": st.get("usage") or {}})
                await volc_billing.record_usage(
                    biz_type="video_gen", model_key=volc_billing.MK_VIDEO_GEN,
                    user_id=user_id, source="frontcut", request_id=task_id,
                    prompt_tokens=u["prompt_tokens"], completion_tokens=u["completion_tokens"],
                    total_tokens=u["total_tokens"], resolution=resolution,
                    duration_sec=float(duration or 0), ratio=ratio or "9:16",
                    has_audio=True, draft_id=job_id,
                )
            except Exception:  # noqa: BLE001
                logger.warning("frontcut 视频生成计费记录失败(不阻断)", exc_info=True)
            vurl = st.get("video_url")
            if not vurl:
                raise RuntimeError("火山成功但无视频URL")
            raw = await volc_video.download(vurl)
            return raw, task_id
        if status in ("FAILED", "ERROR", "FAIL", "CANCELED", "CANCELLED"):
            reason = st.get("reason") or ""
            raise RuntimeError(f"火山视频任务 {status}: {reason}" if reason else f"火山视频任务 {status}")
        await asyncio.sleep(_POLL_INTERVAL)
        waited += _POLL_INTERVAL
    raise RuntimeError("火山视频任务超时")


def _concat_two_raw(raw1: bytes, raw2: bytes) -> bytes:
    """两段视频字节 → 统一规格重编码 concat → 返回拼接后的字节(两段式生成用)。

    ⚠️ CPU 事故教训: -threads 2 限线程; 调用方需持 _COMPOSE_SEM。
    """
    vf = ("scale=1080:1920:force_original_aspect_ratio=decrease,"
          "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30")
    with tempfile.TemporaryDirectory() as d:
        p1 = os.path.join(d, "s1.mp4"); p2 = os.path.join(d, "s2.mp4")
        out = os.path.join(d, "out.mp4")
        with open(p1, "wb") as f:
            f.write(raw1)
        with open(p2, "wb") as f:
            f.write(raw2)
        cmd = [
            "ffmpeg", "-y", "-threads", _FFMPEG_THREADS,
            "-i", p1, "-i", p2,
            "-filter_complex",
            f"[0:v]{vf}[v0];[1:v]{vf}[v1];[0:a]aresample=44100[a0];[1:a]aresample=44100[a1];"
            f"[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]",
            "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100",
            "-threads", _FFMPEG_THREADS, out,
        ]
        _run_ffmpeg(cmd)
        with open(out, "rb") as f:
            return f.read()


def _seg_ref_images(
    seg_no: int, *, ff_url: str | None, char_url: str | None,
) -> tuple[list, str]:
    """组装某一段的参考图清单 + 图注(全部 reference_image, 两段无先后依赖)。

    - 段1: 参考图=主角形象(可选);
    - 段2: 参考图=[主角形象(可选), 正片首帧(收尾衔接目标)]。
    """
    imgs: list = []
    notes: list[str] = []
    if char_url:
        imgs.append({"url": char_url, "role": "reference_image"})
        notes.append(f"参考图{len(imgs)}是主角形象(人物外形须与此一致)")
    if seg_no == 2 and ff_url:
        imgs.append({"url": ff_url, "role": "reference_image"})
        notes.append(
            f"参考图{len(imgs)}是【尾帧参考】——正片开头的那一帧画面。"
            "本段的最后 1-2 秒必须收束、定格到这张图的画面, 以便与正片开头无缝衔接。"
            "⚠️ 它【不是】本段的起始画面, 也不是要在中途出现的画面, 只作为本段结尾的目标画面"
        )
    note = ("\n\n【参考图说明】" + "；".join(notes) + "。") if notes else ""
    return imgs, note


async def _two_seg_plan(job_id: int, cand: dict, duration: int) -> tuple[str, str, int, int]:
    """解析两段式候选的 (段1提示词, 段2提示词, 段1秒数, 段2秒数)。

    优先用候选自带的 prompt2(故事阶段切割+各自优化, 用户可见可编辑);
    旧候选无 prompt2 时才降级为"事后 LLM 拆分"。
    """
    from .prompts import split_prompt_two_segments

    prompt = (cand.get("prompt") or "").strip()
    seg1_sec = max(5, int(duration) // 2)
    seg2_sec = max(5, int(duration) - seg1_sec)
    ss = cand.get("seg_seconds")
    if isinstance(ss, (list, tuple)) and len(ss) == 2 and all(int(x) > 0 for x in ss):
        seg1_sec, seg2_sec = int(ss[0]), int(ss[1])

    pre_p2 = (cand.get("prompt2") or "").strip()
    if pre_p2:
        return prompt, pre_p2, seg1_sec, seg2_sec

    async with session_scope() as s:
        j = await s.get(FrontcutJob, job_id)
        ff_desc = (j.first_frame_desc or "") if j else ""
    p1, p2 = await split_prompt_two_segments(
        prompt, seg1_seconds=seg1_sec, seg2_seconds=seg2_sec, first_frame_desc=ff_desc)
    return p1, p2, seg1_sec, seg2_sec


async def _gen_and_store_segment(
    job_id: int, fid: str, seg_no: int, *, seg_prompt: str, seg_sec: int,
    ratio: str, resolution: str, ff_url: str | None, char_url: str | None,
    user_id: int | None, is_tail: bool = True,
) -> str:
    """生成单段视频并独立存 TOS, 即时写回该候选的 seg{N}_video_oss_key。返回对象 key。

    (存储为火山 TOS; `oss` 模块/`*_oss_key` 字段沿用历史命名, 值是 TOS 对象 key。)

    每段独立落库 → 前端两个预览框可在各段完成时就分别显示/单独重生, 不必等 concat。

    is_tail: 本段是否是整条前贴的最后一段(单段=True; 两段式只有段2=True)。
      为 True 时在提交前【兜底补齐】"尾帧收束到正片首帧"的文字约束 —— 用户在前端
      编辑提示词时可能把这段删掉, 或旧候选压根没有, 这里统一补(幂等, 已有则不重复加)。
    """
    imgs, note = _seg_ref_images(seg_no, ff_url=ff_url, char_url=char_url)
    body = seg_prompt
    if is_tail and ff_url:
        async with session_scope() as s:
            j = await s.get(FrontcutJob, job_id)
            ff_desc = (j.first_frame_desc or "") if j else ""
        body = append_tail_frame_constraint(body, ff_desc)
    async with _GEN_SEM:
        raw, tid = await _submit_and_wait_video(
            prompt=f"{body}{note}", ratio=ratio, resolution=resolution,
            duration=seg_sec, image_urls=imgs, user_id=user_id, job_id=job_id)
    key = oss.build_oss_key(
        user_id=0, filename=f"frontcut_{fid}_seg{seg_no}.mp4", namespace="frontcut-clip")
    await asyncio.to_thread(oss.get_bucket_public().put_object, key, raw)
    await _cand_patch(job_id, fid, **{
        f"seg{seg_no}_video_oss_key": key,
        f"seg{seg_no}_status": "done",
        f"seg{seg_no}_error": None,
        f"seg{seg_no}_task_id": tid,
    })
    return key


async def _merge_segments(job_id: int, fid: str, key1: str, key2: str) -> str:
    """把两段已存 TOS 的分段视频下载→concat→回存 TOS, 返回合并成片的对象 key。"""
    def _load(k: str) -> bytes:
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "seg.mp4")
            oss.get_object_to_file(k, p)
            with open(p, "rb") as f:
                return f.read()

    raw1 = await asyncio.to_thread(_load, key1)
    raw2 = await asyncio.to_thread(_load, key2)
    async with _COMPOSE_SEM:
        merged = await asyncio.to_thread(_concat_two_raw, raw1, raw2)
    key = oss.build_oss_key(user_id=0, filename=f"frontcut_{fid}.mp4", namespace="frontcut-clip")
    await asyncio.to_thread(oss.get_bucket_public().put_object, key, merged)
    return key


async def _gen_two_segment_video(
    job_id: int, cand: dict, *, ratio: str, resolution: str, duration: int,
    ff_url: str | None, char_url: str | None, user_id: int | None,
    only_segment: int | None = None,
) -> dict:
    """>15s 两段式生成: 两段并发生成(全能参考模式) → 各段独立存 TOS → concat → 回存 TOS。

    衔接策略(2026-08 用户定): 两段之间是【剧情上的正常切镜】(切场景/切视角/时间跳跃),
    不追求画面无缝延续 → 不用 first/last 首尾帧模式, 只用 reference_image 全能参考:
    - 段1: 参考图=主角形象(可选);
    - 段2: 参考图=[主角形象(可选), 正片首帧(收尾衔接目标)];
    - 人物一致性靠 主角参考图 + 两段提示词各自完整的人物外观描述 保证;
    - 两段无先后依赖, 并发生成, 总耗时减半。

    分段产物(2026-08 新增): 每段单独存 TOS 到 seg{N}_video_oss_key 并即时落库,
    前端因此可以两个预览框分别展示、分别重生。

    only_segment: 只重生指定的那一段(1/2), 另一段复用已有 seg{N}_video_oss_key
      (用于前端"按段N提示词重新生成"——只烧一段算力)。两段都就绪后自动重新 concat。
    """
    fid = cand.get("framework_id")
    out = dict(cand)
    prompt = (cand.get("prompt") or "").strip()
    if not prompt:
        out["status"] = "failed"; out["error"] = "空提示词"; return out

    try:
        out["status"] = "generating"
        out["segments"] = 2
        seg1_prompt, seg2_prompt, seg1_sec, seg2_sec = await _two_seg_plan(job_id, cand, duration)
        out["seg_seconds"] = [seg1_sec, seg2_sec]
        specs = {1: (seg1_prompt, seg1_sec), 2: (seg2_prompt, seg2_sec)}

        # 决定本次要跑哪些段: only_segment 指定单段(要求另一段已有产物), 否则两段全跑
        todo = [1, 2]
        if only_segment in (1, 2):
            other = 2 if only_segment == 1 else 1
            if cand.get(f"seg{other}_video_oss_key"):
                todo = [only_segment]
            else:
                logger.info(
                    "frontcut job %s 候选 %s 请求只重生段%s, 但段%s 无产物 → 两段一起生成",
                    job_id, fid, only_segment, other)

        # 先把待跑段标 generating 落库(前端对应预览框立刻转圈)
        patch: dict = {"status": "generating", "segments": 2,
                       "seg_seconds": [seg1_sec, seg2_sec]}
        for n in todo:
            patch[f"seg{n}_status"] = "generating"
            patch[f"seg{n}_error"] = None
            patch[f"seg{n}_video_oss_key"] = None
        await _cand_patch(job_id, fid, **patch)

        async def _one(n: int) -> tuple[int, str | None, str | None]:
            p, sec = specs[n]
            try:
                k = await _gen_and_store_segment(
                    job_id, fid, n, seg_prompt=p, seg_sec=sec, ratio=ratio,
                    resolution=resolution, ff_url=ff_url, char_url=char_url, user_id=user_id,
                    is_tail=(n == 2))
                return n, k, None
            except Exception as e:  # noqa: BLE001
                msg = str(e)[:500]
                logger.warning("frontcut job %s 候选 %s 段%s 生成失败: %s", job_id, fid, n, msg)
                await _cand_patch(job_id, fid,
                                  **{f"seg{n}_status": "failed", f"seg{n}_error": msg})
                return n, None, msg

        results = await asyncio.gather(*[_one(n) for n in todo])
        keys: dict[int, str | None] = {
            1: cand.get("seg1_video_oss_key"), 2: cand.get("seg2_video_oss_key")}
        errs: list[str] = []
        for n, k, err in results:
            keys[n] = k
            out[f"seg{n}_status"] = "done" if k else "failed"
            out[f"seg{n}_error"] = err
            if k:
                out[f"seg{n}_video_oss_key"] = k
            if err:
                errs.append(f"段{n}: {err}")
        # 本次未跑的那一段沿用已有产物(不能丢)
        for n in (1, 2):
            if n not in todo and keys[n]:
                out[f"seg{n}_video_oss_key"] = keys[n]
                out[f"seg{n}_status"] = "done"

        if not (keys[1] and keys[2]):
            # 有段失败 → 整条标失败; 但成功那段产物已落库, 用户可只重生失败的那段
            out["status"] = "failed"
            out["error"] = ("；".join(errs) or "两段式生成失败")[:500]
            out.pop("video_oss_key", None)
            return out

        # 两段都就绪 → concat 出合并成片
        out["video_oss_key"] = await _merge_segments(job_id, fid, keys[1], keys[2])
        out["status"] = "done"
        out["error"] = None
        return out
    except Exception as e:  # noqa: BLE001
        logger.warning("frontcut job %s 候选 %s 两段式生成失败: %s", job_id, fid, e)
        out["status"] = "failed"; out["error"] = str(e)[:500]
        return out




async def _gen_one_video(
    job_id: int, cand: dict, *, ratio: str, resolution: str, duration: int,
    image_urls: list | None = None, image_note: str = "",
    user_id: int | None = None,
    ff_url: str | None = None, char_url: str | None = None,
    only_segment: int | None = None,
) -> dict:
    """用一条提示词生成一个前贴视频(火山 Seedance), 转存 OSS。返回更新后的候选 dict。

    - duration ≤ 15: 单段直出(原逻辑)。
    - duration > 15: 两段式——拆提示词→顺序生成两段(段1末帧作段2首帧锚点)→ffmpeg concat。
    image_urls: 单段用参考图(图1=正剧首帧作尾帧, 图2=主角形象); image_note: 对应图注。
    ff_url/char_url: 两段式用的正片首帧/主角形象 URL(由 _prepare_ref_images 返回)。
    """
    fid = cand.get("framework_id")
    out = dict(cand)
    prompt = (cand.get("prompt") or "").strip()
    if not prompt:
        out["status"] = "failed"; out["error"] = "空提示词"; return out

    # >15s: Seedance 单次生成上限之外 → 两段式顺序生成+拼接
    if int(duration or 0) > 15:
        return await _gen_two_segment_video(
            job_id, cand, ratio=ratio, resolution=resolution, duration=int(duration),
            ff_url=ff_url, char_url=char_url, user_id=user_id, only_segment=only_segment)

    # ≤15s: 单段直出。把图注追加到提示词末尾, 让模型知道每张参考图的作用
    # 单段候选自身就是"最后一段" → 兜底补齐尾帧收束约束(用户可能编辑时删掉了, 幂等不重复加)
    if ff_url:
        async with session_scope() as s:
            _j = await s.get(FrontcutJob, job_id)
            _ffd = (_j.first_frame_desc or "") if _j else ""
        prompt = append_tail_frame_constraint(prompt, _ffd)
    if image_note:
        prompt = f"{prompt}\n\n【参考图说明】{image_note}"
    async with _GEN_SEM:
        try:
            out["status"] = "generating"
            raw, task_id = await _submit_and_wait_video(
                prompt=prompt, ratio=ratio, resolution=resolution, duration=int(duration),
                image_urls=image_urls or [], user_id=user_id, job_id=job_id)
            out["rh_task_id"] = task_id  # 复用字段存火山 task id
            key = oss.build_oss_key(user_id=0, filename=f"frontcut_{fid}.mp4", namespace="frontcut-clip")
            oss.get_bucket_public().put_object(key, raw)
            out["video_oss_key"] = key
            out["status"] = "done"
            return out
        except Exception as e:  # noqa: BLE001
            logger.warning("frontcut job %s 候选 %s 生成失败: %s", job_id, fid, e)
            out["status"] = "failed"; out["error"] = str(e)[:500]
            return out


async def regenerate_one(job_id: int, framework_id: str, new_prompt: str | None = None,
                         new_prompt2: str | None = None,
                         only_segment: int | None = None) -> None:
    """重新生成单条前贴视频; 若传 new_prompt/new_prompt2 则先更新该候选的提示词(用户编辑后重生)。

    new_prompt2: >15s 两段式候选的第2段提示词(用户可编辑); 单段候选忽略。
    only_segment: 两段式候选只重生第 1 段或第 2 段(前端两个预览框各自的重生按钮);
                  None=整条(两段)重生。单段候选忽略。

    ⚠️ 顺序很重要(2026-08 修复"生成中变回待生成"): 必须【先】把 status=generating 落库,
    再去做 _prepare_ref_images(下载源视频 + ffmpeg 抽首帧 + 回传 TOS, 可能耗时数十秒)。
    否则前端 4s 后第一次轮询读到的还是旧的 await_pick → 停轮询并清掉重生标记 →
    视频框从"生成中"退回"待生成"。
    """
    try:
        async with session_scope() as s:
            job = await s.get(FrontcutJob, job_id)
            if not job:
                return
            ratio, resolution, duration = job.ratio, job.resolution, job.duration
            cands = list(job.prompt_candidates or [])
            vids = list(job.video_candidates or [])
            job_user_id = job.user_id  # 计费归属
        set_usage_context(job_id=None, user_id=job_user_id, source="frontcut.regen")
        # 找到目标候选: 提示词以 prompt_candidates 为准, 已有分段产物以 video_candidates 为准
        # (只重生某一段时必须保留另一段的 seg{N}_video_oss_key, 否则会被当成"无产物"而两段全跑)
        pc = next((c for c in cands if c.get("framework_id") == framework_id), None)
        vc = next((v for v in vids if v.get("framework_id") == framework_id), None)
        base: dict = {"framework_id": framework_id, "framework_name": framework_id}
        if vc:
            base.update(vc)
        if pc:
            base.update(pc)
        if new_prompt is not None and new_prompt.strip():
            base["prompt"] = new_prompt.strip()
        if new_prompt2 is not None and new_prompt2.strip():
            base["prompt2"] = new_prompt2.strip()

        # 1) 先把该视频候选标 generating 落库(必须在任何耗时操作之前, 见上方 docstring)
        two_seg = int(duration or 0) > 15
        gen_placeholder = dict(base)
        gen_placeholder["status"] = "generating"
        gen_placeholder.pop("error", None)
        gen_placeholder.pop("video_oss_key", None)  # 合并成片作废, 等重新 concat
        if two_seg:
            gen_placeholder["segments"] = 2
            for n in (1, 2):
                if only_segment in (1, 2) and n != only_segment:
                    continue  # 保留未重生那段的产物与状态
                gen_placeholder[f"seg{n}_status"] = "generating"
                gen_placeholder[f"seg{n}_error"] = None
                gen_placeholder[f"seg{n}_video_oss_key"] = None
        others = [v for v in vids if v.get("framework_id") != framework_id]
        await _set(job_id, video_candidates=others + [gen_placeholder], status="generating")

        # 2) 再同步用户编辑后的提示词到 prompt_candidates
        if (new_prompt or "").strip() or (new_prompt2 or "").strip():
            for c in cands:
                if c.get("framework_id") == framework_id:
                    if new_prompt is not None and new_prompt.strip():
                        c["prompt"] = new_prompt.strip()
                    if new_prompt2 is not None and new_prompt2.strip():
                        c["prompt2"] = new_prompt2.strip()
            await _set(job_id, prompt_candidates=cands)

        # 3) 准备参考图(正剧首帧作尾帧 + 可选主角图) — 耗时操作, 此时前端已在转圈
        async with session_scope() as s:
            jj = await s.get(FrontcutJob, job_id)
        img_urls, img_note, ff_url, char_url = await _prepare_ref_images(jj)

        res = await _gen_one_video(job_id, base, ratio=ratio, resolution=resolution, duration=duration,
                                   image_urls=img_urls, image_note=img_note, user_id=job_user_id,
                                   ff_url=ff_url, char_url=char_url, only_segment=only_segment)
        # 合并回列表
        async with session_scope() as s:
            job = await s.get(FrontcutJob, job_id)
            if job:
                cur = [v for v in (job.video_candidates or []) if v.get("framework_id") != framework_id]
                cur.append(res)
                job.video_candidates = cur
                job.status = "await_pick"
    except Exception as e:  # noqa: BLE001
        logger.exception("frontcut job %s 重生 %s 失败", job_id, framework_id)
        # ⚠️ 必须把该条从 generating 落到 failed 并让 job 回到 await_pick,
        # 否则前端会永远转圈(轮询不会停)。
        try:
            await _cand_patch(job_id, framework_id, status="failed", error=str(e)[:500])
            await _set(job_id, status="await_pick")
        except Exception:  # noqa: BLE001
            logger.warning("frontcut job %s 重生失败后回写状态也失败", job_id, exc_info=True)


async def generate_videos(job_id: int) -> None:
    """把5条提示词并发生成5个前贴视频候选, 停在 await_pick 等用户挑选。"""
    try:
        async with session_scope() as s:
            job = await s.get(FrontcutJob, job_id)
            if not job:
                return
            cands = list(job.prompt_candidates or [])
            ratio, resolution, duration = job.ratio, job.resolution, job.duration
            job_user_id = job.user_id  # 计费归属
        set_usage_context(job_id=None, user_id=job_user_id, source="frontcut.gen")
        if not cands:
            raise RuntimeError("无提示词候选, 无法生成视频")
        await _set(job_id, status="generating", progress=60)
        # 准备参考图(正剧首帧作尾帧 + 可选主角图), 5条共用
        async with session_scope() as s:
            jj = await s.get(FrontcutJob, job_id)
        img_urls, img_note, ff_url, char_url = await _prepare_ref_images(jj)

        # 口播语音克隆与视频"一起"触发: 后台异步跑(选了参考音才跑), 不阻塞视频生成
        voice_key = jj.voice_ref_oss_key
        rev = jj.reverse_summary or ""
        if voice_key:
            asyncio.create_task(_synth_all_narrations_safe(job_id, voice_key, rev, cands))

        # 先把5条都置为 generating 占位写库(前端立即看到5个"生成中"格子)
        placeholders = []
        for c in cands:
            p = {"framework_id": c.get("framework_id"), "framework_name": c.get("framework_name"),
                 "status": "generating"}
            placeholders.append(p)
        await _set(job_id, video_candidates=list(placeholders))

        # 每条独立生成; 谁先完成就立即单独写库(单条失败不拖累其他, 前端逐个显示)
        async def _run_and_persist(c: dict) -> dict:
            res = await _gen_one_video(job_id, c, ratio=ratio, resolution=resolution, duration=duration,
                                       image_urls=img_urls, image_note=img_note, user_id=job_user_id,
                                       ff_url=ff_url, char_url=char_url)
            # 增量合并写库: 只替换本条, 保留其它条的最新状态
            async with session_scope() as s:
                j = await s.get(FrontcutJob, job_id)
                if j:
                    cur = list(j.video_candidates or [])
                    cur = [v for v in cur if v.get("framework_id") != res.get("framework_id")]
                    cur.append(res)
                    j.video_candidates = cur
            return res

        results = await asyncio.gather(*[_run_and_persist(c) for c in cands])
        ok = sum(1 for r in results if r.get("status") == "done")
        # 只要有≥1条成功就进入可挑选态; 全失败才标失败
        await _set(job_id, status="await_pick" if ok > 0 else "failed",
                   progress=90 if ok > 0 else 60,
                   error=None if ok > 0 else "5条前贴视频全部生成失败")
    except Exception as e:  # noqa: BLE001
        logger.exception("frontcut job %s generate_videos failed", job_id)
        await _set(job_id, status="failed", error=str(e)[:1000])


def _run_ffmpeg(cmd: list[str], *, timeout: int = 600) -> None:
    p = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg rc={p.returncode}: {p.stderr[-400:].decode('utf-8', 'ignore')}")


def _media_seconds(path: str) -> float:
    """ffprobe 读本地文件时长(秒, float)。失败返回 0。"""
    try:
        cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "default=noprint_wrappers=1:nokey=1", path]
        p = subprocess.run(cmd, capture_output=True, timeout=60)
        if p.returncode == 0:
            return float((p.stdout or b"0").decode().strip() or 0)
    except Exception:  # noqa: BLE001
        pass
    return 0.0


def _mux_segment_aligned(video_path: str, voice_path: str | None, out_path: str) -> None:
    """把一段视频与其口播开头对齐合成(替换原声为口播)。

    规则(2026-08 更新: 口播按 7字/秒 高密度撰写, TTS 自然语速≈5字/秒, 音频普遍比视频长,
    靠 atempo 自动变速对齐——这是设计内行为, 不再依赖文本层硬卡朗读速度):
    - 无口播: 保留视频原声。
    - 口播 ≤ 视频: 口播从视频开头对齐, 视频原声去掉(纯口播); 视频照常放完(口播后静音)。
    - 口播 > 视频: 口播 atempo 自动加速到与视频等长(7/5≈1.4x, 爆款解说节奏; 上限2.0x保护,
      文本层的 8字/秒 上限保证实际加速 ≤1.6x, 听感仍自然)。
    统一输出 1080x1920 30fps / aac 44100。
    """
    vf = ("scale=1080:1920:force_original_aspect_ratio=decrease,"
          "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30")
    if not voice_path:
        cmd = ["ffmpeg", "-y", "-threads", _FFMPEG_THREADS, "-i", video_path,
               "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
               "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100",
               "-threads", _FFMPEG_THREADS, out_path]
        _run_ffmpeg(cmd)
        return
    v_sec = _media_seconds(video_path)
    a_sec = _media_seconds(voice_path)
    atempo = ""
    if v_sec > 0 and a_sec > v_sec:
        # 口播比视频长 → 加速到与视频等长(atempo=a/v, 上限保护)
        ratio = a_sec / v_sec
        ratio = min(ratio, 2.0)  # atempo 单次上限2.0
        atempo = f"atempo={ratio:.4f},"
    # 视频去原声, 用口播(可能加速)作音轨, 从0对齐; -shortest 让音轨短于视频时视频照放完
    cmd = [
        "ffmpeg", "-y", "-threads", _FFMPEG_THREADS,
        "-i", video_path, "-i", voice_path,
        "-filter_complex",
        f"[0:v]{vf}[v];[1:a]{atempo}aresample=44100[a]",
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100",
        "-threads", _FFMPEG_THREADS, out_path,
    ]
    _run_ffmpeg(cmd)


def _concat_two(seg1_path: str, seg2_path: str, out_path: str) -> None:
    """把两段(已各自对齐口播的)视频顺接: 前贴段 + 原片段。"""
    cmd = [
        "ffmpeg", "-y", "-threads", _FFMPEG_THREADS,
        "-i", seg1_path, "-i", seg2_path,
        "-filter_complex", "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]",
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "44100",
        "-threads", _FFMPEG_THREADS, out_path,
    ]
    _run_ffmpeg(cmd)


async def compose_final(job_id: int, framework_id: str) -> None:
    """用户挑选某条前贴 → 与剧情视频本地拼接(纯concat)导出。

    拼接很轻(仅前贴+剧情两段, 无运镜, 每条≤1次), 本地做即可, 无需外置节点。
    ⚠️吸取 CPU 事故教训: -threads 2 限线程 + _COMPOSE_SEM 限并发, 不打满核。
    """
    async with session_scope() as s:
        job = await s.get(FrontcutJob, job_id)
        if not job:
            return
        job.picked_framework_id = framework_id
        job.status = "composing"
        cands = list(job.video_candidates or [])
        pcands = list(job.prompt_candidates or [])
        story_key = job.source_video_oss_key
        story_url = job.source_video_url
        orig_narration_key = job.narration_audio_oss_key  # 原片口播
        job_user_id = job.user_id  # 计费归属
    set_usage_context(job_id=None, user_id=job_user_id, source="frontcut.compose")

    # 找挑选的前贴视频 oss_key + 该条前贴口播
    # 若该条已有高清版(hd_video_oss_key), 优先用高清版拼接; 否则用原视频。
    front_key = None
    front_narration_key = None
    for c in cands:
        if c.get("framework_id") == framework_id and c.get("status") == "done":
            front_key = c.get("hd_video_oss_key") or c.get("video_oss_key")
            break
    for c in pcands:
        if c.get("framework_id") == framework_id:
            front_narration_key = c.get("narration_audio_oss_key")
            break
    if not front_key:
        await _set(job_id, status="failed", error="挑选的前贴视频不存在或未生成成功")
        return

    def _do_compose() -> str:
        """下载→(前贴+前贴口播对齐)+(原片+原片口播对齐)→顺接→上传, 返回成片 oss_key。"""
        with tempfile.TemporaryDirectory() as d:
            front_p = os.path.join(d, "front.mp4")
            story_p = os.path.join(d, "story.mp4")
            fseg_p = os.path.join(d, "fseg.mp4")   # 前贴段(含前贴口播)
            sseg_p = os.path.join(d, "sseg.mp4")   # 原片段(含原片口播)
            out_p = os.path.join(d, "final.mp4")
            oss.get_object_to_file(front_key, front_p)
            if story_key:
                oss.get_object_to_file(story_key, story_p)
            elif story_url:
                import urllib.request
                urllib.request.urlretrieve(story_url, story_p)
            else:
                raise RuntimeError("缺少剧情视频")
            # 下载口播(可空)
            fnar_p = None
            if front_narration_key:
                fnar_p = os.path.join(d, "fnar.mp3")
                oss.get_object_to_file(front_narration_key, fnar_p)
            snar_p = None
            if orig_narration_key:
                snar_p = os.path.join(d, "snar.mp3")
                oss.get_object_to_file(orig_narration_key, snar_p)
            # 各自与口播开头对齐(口播长>视频≤20%则加速)
            _mux_segment_aligned(front_p, fnar_p, fseg_p)
            _mux_segment_aligned(story_p, snar_p, sseg_p)
            # 前贴段 + 原片段 顺接
            _concat_two(fseg_p, sseg_p, out_p)
            with open(out_p, "rb") as f:
                data = f.read()
            key = oss.build_oss_key(user_id=0, filename=f"frontcut_final_{job_id}.mp4", namespace="frontcut-out")
            oss.get_bucket_public().put_object(key, data)
            return key

    async with _COMPOSE_SEM:
        try:
            final_key = await asyncio.to_thread(_do_compose)
            await _set(job_id, final_video_oss_key=final_key, status="succeeded", progress=100)
        except Exception as e:  # noqa: BLE001
            logger.exception("frontcut job %s compose failed", job_id)
            await _set(job_id, status="failed", error=str(e)[:1000])


# ============================================================
# 前贴视频高清 (RunningHub SeedVR2 视频超分)
# 对某条已生成的前贴候选做高清: 下载原候选视频 → 上传 RunningHub → create → 轮询 →
# 下载高清成品 → 存 OSS → 写回该候选的 hd_video_oss_key / hd_status (并存, 不覆盖原视频)。
# 协议同图片 upscale(upload→create→rh_status→rh_outputs), 只是上传视频、输出视频。
# ============================================================

# 视频高清较慢(超分), 放宽轮询上限
_HD_POLL_INTERVAL = 8
_HD_POLL_MAX = 1800  # 秒


def _cand_set_hd(cands: list[dict], framework_id: str, **fields) -> list[dict]:
    """在候选列表里就地更新某条的 hd_* 字段, 返回新列表(其它条不动)。"""
    out = []
    for c in cands:
        cc = dict(c)
        if cc.get("framework_id") == framework_id:
            cc.update(fields)
        out.append(cc)
    return out


async def _persist_hd(job_id: int, framework_id: str, **fields) -> None:
    """把某条候选的 hd_* 字段增量写回 job.video_candidates(保留其它条最新状态)。"""
    async with session_scope() as s:
        j = await s.get(FrontcutJob, job_id)
        if not j:
            return
        j.video_candidates = _cand_set_hd(list(j.video_candidates or []), framework_id, **fields)


async def _hd_poll_and_persist(job_id: int, framework_id: str, task_id: str) -> None:
    """轮询 RH 高清任务直到完成 → 下载 → 存 TOS → 写回候选。

    从 upscale_one 拆出, 供两处调用:
    - upscale_one 正常流程;
    - resume_hd_upscales 服务重启恢复(轮询协程随进程死亡, 但 RH 远端可能已完成/仍在跑,
      重启后凭 hd_rh_task_id 续查, 不再让 hd_status 永远卡在 processing)。
    """
    from ..image_studio import providers as rh

    # 起算时刻: 远端高清任务提交成功那一刻(排队时间不算算力, 与 audio/image 同口径)
    started_at = datetime.utcnow()
    ok = False
    waited = 0
    out_urls: list[str] = []
    try:
        while waited < _HD_POLL_MAX:
            st = await rh.rh_status(task_id)
            if st in ("SUCCESS", "SUCCEED", "SUCCEEDED", "COMPLETED"):
                out_urls = await rh.rh_outputs(task_id)
                ok = True
                break
            if st in ("FAILED", "ERROR", "FAIL", "CANCELED", "CANCELLED"):
                raise RuntimeError(f"RH 视频高清任务 {st}")
            await asyncio.sleep(_HD_POLL_INTERVAL)
            waited += _HD_POLL_INTERVAL
        if not out_urls:
            raise RuntimeError("RH 视频高清任务超时或无产出")

        # 下载高清成品 → 存 TOS(独立 key, 与原视频并存)
        hd_raw = await rh.download_url(out_urls[0])
        hd_key = oss.build_oss_key(
            user_id=0, filename=f"frontcut_hd_{framework_id}.mp4", namespace="frontcut-clip-hd",
        )
        await asyncio.to_thread(oss.get_bucket_public().put_object, hd_key, hd_raw)
        await _persist_hd(job_id, framework_id,
                          hd_video_oss_key=hd_key, hd_status="done", hd_error=None)
        logger.info("frontcut job %s 候选 %s 视频高清完成", job_id, framework_id)
    finally:
        # 高清算力已消耗, 无论成败都记账(失败落 status=failed);
        # 排队期间就失败/超时(out_urls 空)则没有产出但也确实跑了任务, 同样落账。
        await _bill_hd(job_id, framework_id, task_id,
                       started_at=started_at, ok=ok)


async def _bill_hd(job_id: int, framework_id: str, task_id: str, *,
                   started_at, ok: bool) -> None:
    """落一条前剪辑视频高清的 RunningHub 用量。

    幂等键用 RH 远端 task_id: 重启后 resume_hd_upscales 会重查同一条任务,
    重复记账会被 (biz_type, job_id) 唯一约束挡掉。
    归属: 优先取上下文(upscale/resume 入口已播种), 兜底直接读 job.user_id ——
    resume 路径是进程启动时的独立任务, 上下文可能为空。
    """
    try:
        uid = None
        try:
            from ..factory.usage import get_usage_user_id
            uid = get_usage_user_id()
        except Exception:  # noqa: BLE001
            uid = None
        if uid is None:
            async with session_scope() as s:
                j = await s.get(FrontcutJob, job_id)
                uid = j.user_id if j else None
        await billing_service.record_runninghub(
            biz_type="frontcut_hd",
            job_id=billing_service.stable_biz_key("frontcut_hd", f"{task_id}"),
            biz_key=f"{job_id}_{framework_id}_{task_id}",
            user_id=uid,
            started_at=started_at, finished_at=datetime.utcnow(),
            rh_task_id=str(task_id or ""),
            status="succeeded" if ok else "failed",
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("frontcut job %s 高清计费入库失败: %s", job_id, e)


async def resume_hd_upscales() -> None:
    """服务启动恢复: 高清 + 拼接 两类进程内协程任务的断点续跑。

    背景(2026-08 事故): 高清轮询/成片拼接都是进程内协程, orchestrator 重启后死亡:
    - hd_status=processing 有 hd_rh_task_id → 续查 RH; 无 → 标 failed 让用户重试;
    - job.status=composing 且有 picked_framework_id → 重新发起 compose_final
      (拼接是纯本地确定性操作, 输入都在库里, 直接重跑即可);
      无 picked → 回退 await_pick 让用户重选。
    """
    try:
        async with session_scope() as s:
            rows = (await s.execute(select(FrontcutJob))).scalars().all()
            todo: list[tuple[int, str, str | None]] = []
            recompose: list[tuple[int, str | None]] = []
            for j in rows:
                if j.status == "composing":
                    recompose.append((j.id, j.picked_framework_id))
                for c in (j.video_candidates or []):
                    if c.get("hd_status") == "processing":
                        todo.append((j.id, c.get("framework_id"), c.get("hd_rh_task_id")))
        for job_id, fid, tid in todo:
            if not fid:
                continue
            if tid:
                logger.warning("frontcut 高清恢复: job %s 候选 %s 续查 RH task %s", job_id, fid, tid)
                # 计费归属: 启动恢复任务无请求上下文, 补种一次(create_task 会复制它)
                await _seed_usage(job_id, source="frontcut.hd.resume")
                asyncio.create_task(_resume_one_hd(job_id, fid, tid))
            else:
                await _persist_hd(job_id, fid, hd_status="failed",
                                  hd_error="服务重启时任务尚未提交到RH, 请重新点高清处理")
        for job_id, picked in recompose:
            if picked:
                logger.warning("frontcut 拼接恢复: job %s 重新发起 compose_final(%s)", job_id, picked)
                asyncio.create_task(compose_final(job_id, picked))
            else:
                await _set(job_id, status="await_pick")
        if todo or recompose:
            logger.warning("frontcut 恢复: %d 条高清 processing + %d 个 composing 任务",
                           len(todo), len(recompose))
    except Exception as e:  # noqa: BLE001
        logger.warning("frontcut 高清/拼接恢复失败(不阻断启动): %s", e)


async def _resume_one_hd(job_id: int, framework_id: str, task_id: str) -> None:
    """恢复单条高清轮询(带异常兜底写回 failed)。"""
    try:
        await _hd_poll_and_persist(job_id, framework_id, task_id)
    except Exception as e:  # noqa: BLE001
        logger.exception("frontcut job %s 候选 %s 高清恢复失败", job_id, framework_id)
        await _persist_hd(job_id, framework_id, hd_status="failed", hd_error=str(e)[:500])


async def upscale_one(job_id: int, framework_id: str) -> None:
    """对某条前贴候选视频做高清处理。并存: 结果写该候选的 hd_video_oss_key。

    幂等友好: 先把该条置 hd_status=processing(前端立即可见), 完成置 done, 失败置 failed。
    """
    from ..image_studio import providers as rh

    # 1) 取该候选的原视频 oss_key
    async with session_scope() as s:
        j = await s.get(FrontcutJob, job_id)
        if not j:
            return
        cands = list(j.video_candidates or [])
        _owner = j.user_id  # 计费归属
    set_usage_context(job_id=None, user_id=_owner, source="frontcut.hd")
    target = next((c for c in cands if c.get("framework_id") == framework_id), None)
    if not target:
        logger.warning("frontcut job %s upscale: 候选 %s 不存在", job_id, framework_id)
        return
    src_key = target.get("video_oss_key")
    if not src_key or target.get("status") != "done":
        await _persist_hd(job_id, framework_id, hd_status="failed", hd_error="原视频未生成成功, 无法高清")
        return

    await _persist_hd(job_id, framework_id, hd_status="processing", hd_error=None)

    try:
        # 2) 从 OSS 下载原候选视频字节
        def _load() -> bytes:
            with tempfile.TemporaryDirectory() as d:
                p = os.path.join(d, "src.mp4")
                oss.get_object_to_file(src_key, p)
                with open(p, "rb") as f:
                    return f.read()
        raw = await asyncio.to_thread(_load)

        # 3) 上传 RunningHub → create 视频高清任务
        file_name = await rh.rh_upload_video(raw, filename=f"frontcut_{framework_id}.mp4")
        task_id = await rh.rh_create_video_upscale(file_name)
        await _persist_hd(job_id, framework_id, hd_rh_task_id=task_id)

        # 4) 轮询→下载→存 TOS→写回(共享助手; 重启后可凭 hd_rh_task_id 由 resume_hd_upscales 续查)
        await _hd_poll_and_persist(job_id, framework_id, task_id)
    except Exception as e:  # noqa: BLE001
        logger.exception("frontcut job %s 候选 %s 视频高清失败", job_id, framework_id)
        await _persist_hd(job_id, framework_id, hd_status="failed", hd_error=str(e)[:500])
