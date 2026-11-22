"""飞书多维表格 → 批量小说转视频 编排。

同步流程(按钮触发):
1. 拉取目标 table 全部记录。
2. 选出"有 docx 附件 且 视频地址列为空"的行(视频地址非空=已处理, 跳过; 也跳过已有 feishu job 的 record_id)。
3. 每行: 下载 docx→提取文本→AI 生文案(剧名/标签/题材)→按题材选 BGM 分类+轮转→音色轮转
        →按风格列(空→2D电影感插画)选画风预设; 按比例列(空→4:3)选封面/字幕预设; 每几秒一张图列
        →建 novel_video job(全自动, source=feishu, feishu_record_id)→回写第1列文件名(空才写)。
4. job 完成后回写 剧名/标签/视频永久链接; 失败回写"生成失败"。

轮转: 音色/BGM 用"该用户已存在的 feishu 任务数"做全局游标, 跨批次连续取下一个。
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import io
import logging
import re
from typing import Any, Optional

from sqlalchemy import select, func

from ..config import get_settings
from ..db import session_scope
from ..factory.usage import set_usage_context
from ..novel_video import service as nv
from ..novel_video.models import (
    NovelVideoJob, NovelVideoVoice, NovelVideoBgm,
    NovelVideoStylePreset, NovelVideoCoverPreset, NovelVideoOverlayPreset,
    FeishuBitableSync, FeishuRowFailure,
)
from . import client as feishu

logger = logging.getLogger(__name__)

DEFAULT_STYLE_NAME = "2D电影感插画"
DEFAULT_RATIO = "4:3"
DEFAULT_PER_IMAGE_SECONDS = 7   # 飞书来源固定: 7 秒一张图

# 比例字符串 → (w比, h比)
_RATIO_MAP = {"9:16": (9, 16), "16:9": (16, 9), "4:3": (4, 3), "3:4": (3, 4), "1:1": (1, 1)}


def _resolve_wh(ratio: str, short: int = 1080) -> tuple[int, int]:
    """比例 + 短边像素 → 实际宽高(短边=short, 长边按比例, 都取偶数)。"""
    rw, rh = _RATIO_MAP.get(ratio, _RATIO_MAP[DEFAULT_RATIO])
    if rh >= rw:
        w, h = short, round(short * rh / rw)
    else:
        h, w = short, round(short * rw / rh)
    even = lambda n: n + 1 if n % 2 else n  # noqa: E731
    return even(w), even(h)


def video_link_token(job_id: int) -> str:
    """给 job_id 生成不可枚举签名 token(匿名下载用)。"""
    s = get_settings()
    return hmac.new(s.feishu_video_link_secret.encode(), str(job_id).encode(), hashlib.sha256).hexdigest()[:32]


def verify_video_token(job_id: int, token: str) -> bool:
    return hmac.compare_digest(video_link_token(job_id), token or "")


def video_permalink(job_id: int) -> str:
    """写回飞书的永久视频链接(点开→后端现签 TOS 下载链接 302 跳转)。"""
    s = get_settings()
    base = (s.public_base_url or "").rstrip("/")
    return f"{base}/v1/feishu/video/{job_id}?t={video_link_token(job_id)}"


def _extract_docx_text(raw: bytes) -> str:
    """从附件字节提取纯文本。支持 docx 与纯文本(txt)。

    - docx 是 zip 包(魔术字节 'PK\\x03\\x04'), 用 python-docx 解析段落。
    - txt/纯文本: 直接按编码 decode(依次尝试 utf-8/utf-8-sig/gbk/gb18000)。
    
    **修复**: docx 解析失败时不再回退到 _decode_plain(raw), 因为 docx 本质是二进制 zip,
    decode 会产生含 NUL 字节的伪文本导致 PostgreSQL 写入失败。改为明确返回空字符串。
    """
    if not raw:
        return ""

    def _decode_plain(b: bytes) -> str:
        """纯文本编码检测与解码(用于 txt 等非 zip 文件)。"""
        for enc in ("utf-8", "utf-8-sig", "gbk", "gb18030", "big5"):
            try:
                s = b.decode(enc)
                # decode 成功但含大量替换符/不可读, 视为该编码不对, 继续尝试
                if s and s.count("\ufffd") < max(3, len(s) // 50):
                    return s.strip()
            except Exception:  # noqa: BLE001
                continue
        # 全部失败: 宽松 decode(忽略错误), 尽量取到可用文本
        try:
            return b.decode("utf-8", errors="ignore").strip()
        except Exception:  # noqa: BLE001
            return ""

    # 1) docx(zip, PK 开头) → python-docx
    if raw[:4] == b"PK\x03\x04":
        try:
            import docx  # python-docx
            d = docx.Document(io.BytesIO(raw))
            txt = "\n".join(p.text for p in d.paragraphs if p.text and p.text.strip()).strip()
            if txt:
                logger.info("docx 解析成功, 提取文本长度: %d 字符", len(txt))
                return txt
            # docx 解析成功但为空文档
            logger.warning("docx 解析成功但文档为空(无段落文本)")
            return ""
        except Exception as e:  # noqa: BLE001
            # **关键修复**: docx 解析失败不再 fallback 到 _decode_plain(二进制会产生 NUL 导致 PG 失败)
            logger.error("docx 解析失败(文件可能损坏或不是有效的 docx): %s", e, exc_info=True)
            return ""

    # 2) 非 zip → 纯文本(txt 等)
    return _decode_plain(raw)


async def _get_preset_layout(user_id: int, model, name: str) -> Optional[dict]:
    """按 name 取某用户的预设 layout(画风取 prompt)。找不到返回 None。"""
    async with session_scope() as s:
        row = (await s.execute(
            select(model).where(model.user_id == user_id, model.name == name)
        )).scalars().first()
        if not row:
            return None
        return {"prompt": getattr(row, "prompt", None), "layout": getattr(row, "layout", None)}


async def _rotate_voice(user_id: int, pool: list) -> Optional[str]:
    """音色轮转: 优先用配置的轮转池 pool(oss_key 列表), 空则回退用户全部音色库。
    游标 = 该用户已创建的 feishu 任务数, 保证跨批次连续。"""
    pool = [k for k in (pool or []) if k]
    if not pool:
        async with session_scope() as s:
            pool = (await s.execute(
                select(NovelVideoVoice.oss_key).where(NovelVideoVoice.user_id == user_id)
                .order_by(NovelVideoVoice.id)
            )).scalars().all()
    if not pool:
        return None
    async with session_scope() as s:
        used = (await s.execute(
            select(func.count()).select_from(NovelVideoJob)
            .where(NovelVideoJob.user_id == user_id, NovelVideoJob.source == "feishu")
        )).scalar() or 0
    return pool[used % len(pool)]


async def _rotate_voice_by_gender(user_id: int, gender: str) -> Optional[str]:
    """按性别音色池轮转(male/female)。游标=该用户 feishu 任务数, 跨批次连续。
    该性别池为空则返回 None(调用方回退全部池)。"""
    async with session_scope() as s:
        pool = (await s.execute(
            select(NovelVideoVoice.oss_key).where(
                NovelVideoVoice.user_id == user_id, NovelVideoVoice.gender == gender
            ).order_by(NovelVideoVoice.id)
        )).scalars().all()
        if not pool:
            return None
        used = (await s.execute(
            select(func.count()).select_from(NovelVideoJob)
            .where(NovelVideoJob.user_id == user_id, NovelVideoJob.source == "feishu")
        )).scalar() or 0
    return pool[used % len(pool)]


async def _rotate_bgm(user_id: int, category: Optional[str]) -> Optional[str]:
    """BGM 轮转: 按配置的分类(古风|现代)在对应库里轮转。分类为空/无效则不加 BGM。"""
    if category not in ("古风", "现代"):
        return None
    async with session_scope() as s:
        pool = (await s.execute(
            select(NovelVideoBgm.oss_key).where(NovelVideoBgm.category == category)
            .order_by(NovelVideoBgm.id)
        )).scalars().all()
        used = (await s.execute(
            select(func.count()).select_from(NovelVideoJob)
            .where(NovelVideoJob.user_id == user_id, NovelVideoJob.source == "feishu",
                   NovelVideoJob.bgm_category == category)
        )).scalar() or 0
    if not pool:
        return None
    return pool[used % len(pool)]


async def _mark_row_status(
    cfg_id: int, user_id: int, record_id: str, status: str,
    reason: Optional[str] = None, job_id: Optional[int] = None,
) -> None:
    """落库/更新一行的处理状态(长期优化: 可追踪性, 替代'发后不管')。

    以 (cfg_id, record_id) 定位: 已存在则更新同一条(幂等, 不重复插入), 不存在则新建。
    该函数内部吞掉所有异常(状态追踪本身不应影响主流程成败)。
    """
    try:
        async with session_scope() as s:
            row = (await s.execute(
                select(FeishuRowFailure).where(
                    FeishuRowFailure.cfg_id == cfg_id, FeishuRowFailure.record_id == record_id
                )
            )).scalars().first()
            if row:
                row.status = status
                row.reason = reason
                if job_id is not None:
                    row.job_id = job_id
            else:
                s.add(FeishuRowFailure(
                    cfg_id=cfg_id, user_id=user_id, record_id=record_id,
                    status=status, reason=reason, job_id=job_id,
                ))
    except Exception:  # noqa: BLE001
        logger.exception("状态追踪落库失败 cfg=%s record=%s status=%s(不影响主流程)", cfg_id, record_id, status)


async def _writeback(app_token: str, table_id: str, record_id: str, fields: dict) -> bool:
    """回写飞书单条记录, 失败自动重试(飞书 API 偶发超时/限流很常见)。

    重试 3 次, 指数退避(2s/4s/8s)。全部失败才放弃并记 warning。
    返回 True=成功, False=最终失败(交由定时兜底任务下一轮补)。
    """
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            await feishu.update_record(app_token, table_id, record_id, fields)
            if attempt > 0:
                logger.info("飞书回写重试成功 record=%s (第%d次)", record_id, attempt + 1)
            return True
        except Exception as e:  # noqa: BLE001
            last_err = e
            if attempt < 2:
                await asyncio.sleep(2 ** (attempt + 1))  # 2s, 4s
    logger.warning("飞书回写失败(已重试3次) record=%s: %s", record_id, last_err)
    return False


def _snapshot_cfg(cfg: FeishuBitableSync) -> dict:
    """在 session 内把配置读成普通 dict, 避免 detached ORM 访问问题。"""
    return {
        "id": cfg.id,
        "user_id": cfg.user_id,
        "app_token": cfg.app_token,
        "table_id": cfg.table_id,
        "field_map": dict(cfg.field_map or {}),
        "default_ratio": cfg.default_ratio or DEFAULT_RATIO,
        "default_style_prompt": cfg.default_style_prompt or "",
        "default_per_image_seconds": cfg.default_per_image_seconds or DEFAULT_PER_IMAGE_SECONDS,
        "overlay_layout": dict(cfg.overlay_layout) if cfg.overlay_layout else None,
        "cover_enabled": 1 if (cfg.cover_enabled is None or cfg.cover_enabled) else 0,
        "cover_layout": dict(cfg.cover_layout) if cfg.cover_layout else None,
        "voice_oss_keys": list(cfg.voice_oss_keys or []),
        "voice_mode": cfg.voice_mode or None,   # custom(默认)/male/female/auto
        "bgm_category": cfg.bgm_category or None,
    }


def _pick_ratio(row_val: str, cfg: dict) -> str:
    """比例: 行内 > 配置默认 > 硬兜底 4:3。只接受已知比例, 否则回退。"""
    v = (row_val or "").strip()
    if v in _RATIO_MAP:
        return v
    d = (cfg.get("default_ratio") or "").strip()
    return d if d in _RATIO_MAP else DEFAULT_RATIO


def _pick_seconds(row_val: str, cfg: dict) -> int:
    """几秒一张图: 行内 > 配置默认 > 硬兜底 7。clamp [2,60]。"""
    def _num(x):
        try:
            return int(float(str(x).strip()))
        except Exception:  # noqa: BLE001
            return None
    n = _num(row_val)
    if n is None:
        n = _num(cfg.get("default_per_image_seconds"))
    if n is None:
        n = DEFAULT_PER_IMAGE_SECONDS
    return max(2, min(60, n))


async def _process_row(cfg: dict, rec: dict) -> Optional[int]:
    """处理一行: 建 job。cfg 为 _snapshot_cfg 出来的 dict。返回 job_id; 跳过/失败返回 None。
    
    **长期优化改进**:
    1. 整体 try/except 包裹, 防止单行异常(含 DB 写入异常)向上传播导致批次中断。
    2. 用 _mark_row_status 追踪状态(processing→success/failed), 替代"发后不管"模式。
    3. 所有失败路径都回写飞书"生成失败"并落库失败原因, 无静默丢失。
    """
    fmap = cfg["field_map"]
    app_token, table_id = cfg["app_token"], cfg["table_id"]
    cfg_id = cfg["id"]
    record_id = rec.get("record_id") or ""
    fields = rec.get("fields") or {}
    user_id = cfg["user_id"]

    # 播种归属: 本函数由守护进程/后台循环调用, 没有请求上下文。
    # 这里盖章后, 本行后续所有 LLM 调用(gen_meta_for_text 等)才统计得到人。
    set_usage_context(job_id=None, user_id=user_id, source="feishu_row")

    # 标记开始处理(processing)
    await _mark_row_status(cfg_id, user_id, record_id, "processing")

    try:
        # 已处理判定: 视频列非空 → 跳过
        if feishu.cell_text(fields.get(fmap["video"])):
            logger.debug("跳过已处理行 record=%s(视频列非空)", record_id)
            return None
        # 已有 feishu job 的 record_id → 跳过(防重复入队)
        async with session_scope() as s:
            exist = (await s.execute(
                select(NovelVideoJob.id).where(
                    NovelVideoJob.source == "feishu", NovelVideoJob.feishu_record_id == record_id
                )
            )).scalars().first()
        if exist:
            logger.debug("跳过已有任务行 record=%s job=%s", record_id, exist)
            return None

        # 取附件
        atts = feishu.extract_attachments(fields.get(fmap["doc"]))
        if not atts:
            logger.debug("跳过无附件行 record=%s", record_id)
            return None  # 无文档, 跳过(不算失败)
        att = atts[0]
        
        # 下载附件
        try:
            raw = await feishu.download_media(att["file_token"], table_id=table_id, url=att.get("url") or None)
        except Exception as e:  # noqa: BLE001
            reason = f"下载附件失败: {e}"
            logger.warning("record=%s %s", record_id, reason, exc_info=True)
            await _writeback(app_token, table_id, record_id, {fmap["video"]: "生成失败"})
            await _mark_row_status(cfg_id, user_id, record_id, "failed", reason=reason)
            return None
        
        # 提取文本(已修复: docx 失败不再 fallback 二进制)
        text = _extract_docx_text(raw)
        if not text or len(text) < 20:
            reason = "文档解析失败或文本过短(< 20字符)" if not text else f"文本过短({len(text)}字符)"
            logger.warning("record=%s %s", record_id, reason)
            await _writeback(app_token, table_id, record_id, {fmap["video"]: "生成失败"})
            await _mark_row_status(cfg_id, user_id, record_id, "failed", reason=reason)
            return None

        # 文件名列(原 小说名): 空才写附件文件名
        fn_field = fmap.get("filename")
        if fn_field and not feishu.cell_text(fields.get(fn_field)):
            await _writeback(app_token, table_id, record_id, {fn_field: att.get("name") or ""})

        # AI 文案(剧名/标签/题材)
        try:
            meta = await nv.gen_meta_for_text(text)
        except Exception as e:  # noqa: BLE001
            reason = f"AI 文案生成异常: {e}"
            logger.warning("record=%s %s", record_id, reason, exc_info=True)
            await _writeback(app_token, table_id, record_id, {fmap["video"]: "生成失败"})
            await _mark_row_status(cfg_id, user_id, record_id, "failed", reason=reason)
            return None
        if not meta:
            reason = "AI 文案生成失败(返回空)"
            logger.warning("record=%s %s", record_id, reason)
            await _writeback(app_token, table_id, record_id, {fmap["video"]: "生成失败"})
            await _mark_row_status(cfg_id, user_id, record_id, "failed", reason=reason)
            return None
        title, tags = meta["title"], meta["tags"]
        ai_genre = meta.get("genre") or "现代"  # AI 综合全文/标题/标签判定的题材(古风|现代)

        # 比例/秒数: 行内 > 配置默认 > 硬兜底
        ratio = _pick_ratio(feishu.cell_text(fields.get(fmap.get("ratio", ""))), cfg)
        per_img = _pick_seconds(feishu.cell_text(fields.get(fmap.get("seconds", ""))), cfg)
        w, h = _resolve_wh(ratio)

        # 画风: 行内"风格"列(当作画风提示词) > 配置默认画风提示词 > 命名预设兜底
        row_style = feishu.cell_text(fields.get(fmap.get("style", "")))
        style_prompt = row_style or cfg.get("default_style_prompt") or ""
        if not style_prompt:
            style_p = await _get_preset_layout(user_id, NovelVideoStylePreset, DEFAULT_STYLE_NAME)
            style_prompt = (style_p or {}).get("prompt") or ""

        # 画面文字/字幕 + 封面: 用配置里存的样式
        overlays = cfg.get("overlay_layout") or None
        cover_enabled = cfg.get("cover_enabled", 1)
        cover_overlays = cfg.get("cover_layout") or None

        # 音色选择: 按 voice_mode 决定
        #   auto            → voice_key 留空, 交 run_job 分析主角性别后从对应性别池选(与主站一致)
        #   male / female   → 从对应性别池轮转; 该池空则回退全部池
        #   custom / None   → 用配置的 voice_oss_keys 池轮转(空则全部池)
        voice_mode = (cfg.get("voice_mode") or "").strip().lower()
        voice_key: Optional[str] = None
        if voice_mode == "auto":
            voice_key = None  # run_job 会按 protagonist_gender 选
        elif voice_mode in ("male", "female"):
            voice_key = await _rotate_voice_by_gender(user_id, voice_mode)
            if not voice_key:
                voice_key = await _rotate_voice(user_id, cfg.get("voice_oss_keys") or [])
        else:
            voice_key = await _rotate_voice(user_id, cfg.get("voice_oss_keys") or [])
        # 非 auto 模式且拿不到音色(库为空) → 无法生成; auto 模式允许留空(run_job 兜底选)
        if voice_mode != "auto" and not voice_key:
            reason = f"音色库为空(mode={voice_mode})"
            logger.warning("record=%s %s", record_id, reason)
            await _writeback(app_token, table_id, record_id, {fmap["video"]: "生成失败"})
            await _mark_row_status(cfg_id, user_id, record_id, "failed", reason=reason)
            return None
        # BGM 轮转: 配置为 auto → 用 AI 判定的题材(古风/现代)选对应曲库; 否则用配置固定分类
        bgm_cat = cfg.get("bgm_category")
        if bgm_cat == "auto":
            bgm_cat = ai_genre if ai_genre in ("古风", "现代") else None
        bgm_key = await _rotate_bgm(user_id, bgm_cat)

        # 创建 job (可能因 DB 约束/写入异常而失败, 外层 try 会捕获)
        async with session_scope() as s:
            job = NovelVideoJob(
                user_id=user_id,
                title=(att.get("name") or title or "飞书任务")[:60],
                novel_text=text,
                style_prompt=style_prompt,
                voice_ref_oss_key=voice_key,
                overlays=overlays,
                width=w, height=h, fps=30, per_image_seconds=per_img,
                image_model="gpt-image-2",
                auto_compose=1,
                bgm_category=(bgm_cat if bgm_key else None), bgm_oss_key=bgm_key,
                cover_enabled=cover_enabled,
                cover_title=title, cover_tags=tags, cover_overlays=cover_overlays,
                source="feishu", feishu_record_id=record_id,
                status="pending",
            )
            s.add(job)
            await s.flush()
            job_id = job.id
        
        # 成功: 标记 success + 记录 job_id
        await _mark_row_status(cfg_id, user_id, record_id, "success", job_id=job_id)
        logger.info("飞书行处理成功 record=%s job=%s", record_id, job_id)
        return job_id

    except Exception as e:  # noqa: BLE001
        # **关键修复**: 捕获所有异常(含 DB 写入失败如 NUL 字节错误), 防止向上传播导致批次中断
        reason = f"处理异常: {type(e).__name__}: {e}"
        logger.error("飞书行处理失败 record=%s: %s", record_id, reason, exc_info=True)
        # 尽力回写飞书(即使 DB 已炸, 至少让飞书表格有失败标记)
        try:
            await _writeback(app_token, table_id, record_id, {fmap["video"]: "生成失败"})
        except Exception:  # noqa: BLE001
            logger.exception("回写飞书也失败 record=%s", record_id)
        await _mark_row_status(cfg_id, user_id, record_id, "failed", reason=reason)
        return None


async def writeback_feishu_job(job_id: int) -> None:
    """worker 完成 job 后调用: 若该 job 是飞书任务, 按其当前终态回写飞书表格。

    背景: 视频实际由算力机 worker 独立进程跑(worker 认领 pending 任务)。回写飞书的逻辑
    以前绑在主服务的 _run_and_writeback(await run_job 后回写), 但 worker 跑完不经过它,
    导致 worker 出的片回写不到飞书。故把回写下沉到"谁跑完谁回写": worker 在 job 到达终态
    (succeeded/failed)后调用本函数。

    job 表只存 feishu_record_id(不存 cfg_id), 这里按 job.user_id 反查该用户的飞书配置
    (生产为固定表, 一个用户通常一个 cfg; 取最近一个)拿到 app_token/table_id/field_map。
    成功(succeeded+有video): 回写 剧名/标签/视频永久链接; 否则回写"生成失败"。幂等: 可重复调。
    """
    async with session_scope() as s:
        job = await s.get(NovelVideoJob, job_id)
        if not job or job.source != "feishu" or not job.feishu_record_id:
            return
        record_id = job.feishu_record_id
        status = job.status or ""
        title = (job.cover_title or "")
        tags = (job.cover_tags or "")
        has_video = bool(job.video_oss_key)
        cfg = (await s.execute(
            select(FeishuBitableSync).where(FeishuBitableSync.user_id == job.user_id)
            .order_by(FeishuBitableSync.id.desc())
        )).scalars().first()
        if not cfg:
            logger.warning("writeback_feishu_job: job %s 找不到用户 %s 的飞书配置, 跳过回写", job_id, job.user_id)
            return
        fmap = dict(cfg.field_map or {})
        app_token, table_id = cfg.app_token, cfg.table_id
    if not fmap.get("video"):
        return
    if status == "succeeded" and has_video:
        fields = {fmap["video"]: video_permalink(job_id)}
        if fmap.get("title"):
            fields[fmap["title"]] = title
        if fmap.get("tags"):
            fields[fmap["tags"]] = tags
        await _writeback(app_token, table_id, record_id, fields)
        logger.info("writeback_feishu_job: job %s 回写成功链接 record=%s", job_id, record_id)
    else:
        await _writeback(app_token, table_id, record_id, {fmap["video"]: "生成失败"})
        logger.info("writeback_feishu_job: job %s 回写生成失败 record=%s (status=%s)", job_id, record_id, status)


async def backfill_empty_links(cfg_id: int) -> dict:
    """补写飞书表中下载链接为空的行(对应job已succeeded+有video的才补)。
    
    用途: 有些视频已生成但因各种原因(worker异常、回写失败等)未写回飞书。本函数扫描
    全表找出"下载链接列为空 + 有对应succeeded job"的行, 补写链接/剧名/标签。
    
    关键: 只补写下载链接列当前为空的行, 已有内容(包括"生成失败")的行保持不动。
    返回: {"backfilled": 补写数, "skipped": 跳过数(已有链接或无对应job)}
    """
    async with session_scope() as s:
        cfg = await s.get(FeishuBitableSync, cfg_id)
        if not cfg:
            raise ValueError(f"配置不存在: {cfg_id}")
        cfg_snap = _snapshot_cfg(cfg)
    fmap = cfg_snap["field_map"]
    app_token, table_id = cfg_snap["app_token"], cfg_snap["table_id"]
    video_field = fmap.get("video")
    if not video_field:
        return {"backfilled": 0, "skipped": 0, "error": "未配置下载链接列"}
    
    # 列出全表记录
    all_records = await feishu.list_records(app_token, table_id)
    backfilled = 0
    skipped = 0
    
    for rec in all_records:
        record_id = rec.get("record_id") or ""
        if not record_id:
            skipped += 1
            continue
        fields = rec.get("fields") or {}
        # 下载链接列非空 → 跳过(保留已有内容)
        if feishu.cell_text(fields.get(video_field)):
            skipped += 1
            continue
        # 查该record_id对应的飞书job
        async with session_scope() as s:
            job = (await s.execute(
                select(NovelVideoJob).where(
                    NovelVideoJob.source == "feishu",
                    NovelVideoJob.feishu_record_id == record_id,
                    NovelVideoJob.status == "succeeded"
                ).order_by(NovelVideoJob.id.desc())
            )).scalars().first()
        if not job or not job.video_oss_key:
            skipped += 1
            continue
        # 构造回写字段(同writeback_feishu_job逻辑)
        back_fields = {video_field: video_permalink(job.id)}
        if fmap.get("title") and job.cover_title:
            back_fields[fmap["title"]] = job.cover_title
        if fmap.get("tags") and job.cover_tags:
            back_fields[fmap["tags"]] = job.cover_tags
        await _writeback(app_token, table_id, record_id, back_fields)
        backfilled += 1
        logger.info("backfill_empty_links: 补写 record=%s job=%s", record_id, job.id)
    
    return {"backfilled": backfilled, "skipped": skipped}


async def _run_and_writeback(cfg_id: int, job_id: int, record_id: str) -> None:
    """[已弃用-保留兼容] 跑 job + 回写。现改为: sync_selected 只建 pending 任务交 worker 认领,
    worker 完成后调 writeback_feishu_job 回写。本函数不再被 sync_selected 调用。
    成功: 改写剧名←title, 类型←tags, 下载链接←永久链接。失败: 下载链接←"生成失败"。"""
    try:
        await nv.run_job(job_id)
    except Exception:  # noqa: BLE001
        logger.exception("feishu job %s run 失败", job_id)
    async with session_scope() as s:
        job = await s.get(NovelVideoJob, job_id)
        cfg = await s.get(FeishuBitableSync, cfg_id)
        if not cfg:
            return
        fmap = dict(cfg.field_map or {})
        app_token, table_id = cfg.app_token, cfg.table_id
        status = job.status if job else "failed"
        title = (job.cover_title if job else "") or ""
        tags = (job.cover_tags if job else "") or ""
        has_video = bool(job and job.video_oss_key)
    if status == "succeeded" and has_video:
        await _writeback(app_token, table_id, record_id, {
            fmap["title"]: title,
            fmap["tags"]: tags,
            fmap["video"]: video_permalink(job_id),
        })
    else:
        await _writeback(app_token, table_id, record_id, {fmap["video"]: "生成失败"})


def _has_attachment(fields: dict, fmap: dict) -> bool:
    return bool(feishu.extract_attachments(fields.get(fmap.get("doc", ""))))


async def list_candidate_rows(cfg_id: int) -> dict:
    """列出"未生成"的候选行: 有附件、视频列为空、且不在现有 feishu 任务(排队/进行/已完成)里。
    返回 {rows:[{record_id, name, ratio, seconds}], total, table_total}。"""
    async with session_scope() as s:
        cfg = await s.get(FeishuBitableSync, cfg_id)
        if not cfg:
            raise RuntimeError("同步配置不存在")
        fmap = dict(cfg.field_map or {})
        app_token, table_id = cfg.app_token, cfg.table_id
    for k in ("doc", "video", "title", "tags"):
        if not fmap.get(k):
            raise RuntimeError(f"字段映射缺少 {k}")

    records = await feishu.list_records(app_token, table_id)
    # 已存在的 feishu record_id(任何状态都算已处理, 不再列为候选)
    async with session_scope() as s:
        existed = set((await s.execute(
            select(NovelVideoJob.feishu_record_id).where(NovelVideoJob.source == "feishu")
        )).scalars().all())

    rows = []
    for rec in records:
        rid = rec.get("record_id") or ""
        f = rec.get("fields") or {}
        if feishu.cell_text(f.get(fmap["video"])):  # 视频列非空 = 已处理
            continue
        if rid in existed:  # 已排队/已生成
            continue
        if not _has_attachment(f, fmap):  # 无附件, 不能生成
            continue
        name = feishu.cell_text(f.get(fmap.get("filename", ""))) or ""
        if not name:
            atts = feishu.extract_attachments(f.get(fmap["doc"]))
            name = (atts[0].get("name") if atts else "") or rid
        rows.append({
            "record_id": rid,
            "name": name,
            "ratio": feishu.cell_text(f.get(fmap.get("ratio", ""))) or "",
            "seconds": feishu.cell_text(f.get(fmap.get("seconds", ""))) or "",
        })
    return {"rows": rows, "total": len(rows), "table_total": len(records)}


async def sync_selected(cfg_id: int, record_ids: list[str]) -> dict:
    """只对选中的 record_ids 建任务并入队(后台跑, 完成各自回写)。"""
    want = set(r for r in (record_ids or []) if r)
    if not want:
        return {"queued": 0, "skipped": 0, "total": 0}
    async with session_scope() as s:
        cfg = await s.get(FeishuBitableSync, cfg_id)
        if not cfg:
            raise RuntimeError("同步配置不存在")
        snap = _snapshot_cfg(cfg)
    for k in ("doc", "video", "title", "tags"):
        if not snap["field_map"].get(k):
            raise RuntimeError(f"字段映射缺少 {k}")

    records = await feishu.list_records(snap["app_token"], snap["table_id"])
    targets = [rec for rec in records if (rec.get("record_id") or "") in want]
    # 并发建任务(每行含下载docx+LLM生文案, 之前串行且无超时 → 某行卡住会阻塞后面所有行,
    # 导致大批勾选的行建不出来)。改为限并发 + 单行超时: 单行失败/超时只跳过该行, 不拖垮整批。
    # 并发数(建任务阶段的 LLM/下载并发)默认 10, 可按 KEY 配额调整; 这不是生图/合成的算力并发。
    _BUILD_CONCURRENCY = 10
    _ROW_TIMEOUT = 120  # 单行建任务(下载+生文案)最长等待秒, 超时即判失败跳过
    sem = asyncio.Semaphore(_BUILD_CONCURRENCY)
    counters = {"queued": 0, "skipped": 0}

    async def _one(rec: dict) -> None:
        rid = rec.get("record_id") or ""
        async with sem:
            try:
                job_id = await asyncio.wait_for(_process_row(snap, rec), timeout=_ROW_TIMEOUT)
            except asyncio.TimeoutError:
                logger.warning("处理行超时(>%ss)跳过 record=%s", _ROW_TIMEOUT, rid)
                job_id = None
            except Exception:  # noqa: BLE001
                logger.exception("处理行失败 record=%s", rid)
                job_id = None
        if job_id:
            # job 已建为 status='pending', 交算力机 worker 认领跑(worker 完成后调
            # writeback_feishu_job 回写飞书)。不再在主服务内 await run_job(那会与 worker 抢跑
            # 同一任务、且回写逻辑无法覆盖 worker 出的片)。
            counters["queued"] += 1
        else:
            counters["skipped"] += 1

    await asyncio.gather(*[_one(rec) for rec in targets])
    async with session_scope() as s:
        cfg = await s.get(FeishuBitableSync, cfg_id)
        if cfg:
            cfg.last_synced_at = func.now()
    logger.info("sync_selected 完成 cfg=%s: queued=%d skipped=%d total=%d",
                cfg_id, counters["queued"], counters["skipped"], len(want))
    return {"queued": counters["queued"], "skipped": counters["skipped"], "total": len(want)}


async def sync_once(cfg_id: int) -> dict:
    """执行一次全量同步(所有候选行)。job 在后台跑, 完成各自回写。"""
    cand = await list_candidate_rows(cfg_id)
    ids = [r["record_id"] for r in cand["rows"]]
    res = await sync_selected(cfg_id, ids)
    res["total"] = cand["table_total"]
    return res


# 定时兜底扫描间隔(秒): 每 10 分钟扫一遍所有飞书配置, 把"已出片但飞书链接列还空着"的行补写。
# 即使 worker 实时回写漏了(重试仍失败/进程崩溃), 最多 10 分钟内被这个兜底任务自动补上, 用户无需手动。
_WRITEBACK_DAEMON_INTERVAL = 600


async def run_feishu_writeback_daemon(interval: int = _WRITEBACK_DAEMON_INTERVAL) -> None:
    """飞书回写兜底守护: 周期性对所有飞书配置执行 backfill_empty_links, 保证最终一致。

    与 worker 实时回写互补: worker 跑完立即回写(带重试); 本 daemon 兜底补漏。
    只补"链接列为空 + 有对应 succeeded job"的行, 幂等安全, 不覆盖已有内容(含"生成失败")。
    """
    logger.info("飞书回写兜底守护启动, 间隔 %ds", interval)
    # 启动后先等一会儿再首扫, 避免和启动期其他任务抢资源
    await asyncio.sleep(60)
    while True:
        try:
            async with session_scope() as s:
                cfg_ids = (await s.execute(select(FeishuBitableSync.id))).scalars().all()
            total_backfilled = 0
            for cfg_id in cfg_ids:
                try:
                    r = await backfill_empty_links(cfg_id)
                    n = r.get("backfilled", 0)
                    total_backfilled += n
                    if n:
                        logger.info("飞书回写兜底: cfg=%s 补写 %d 条", cfg_id, n)
                except Exception:  # noqa: BLE001
                    logger.exception("飞书回写兜底: cfg=%s 扫描失败", cfg_id)
            if total_backfilled:
                logger.info("飞书回写兜底: 本轮共补写 %d 条", total_backfilled)
        except Exception:  # noqa: BLE001
            logger.exception("飞书回写兜底守护本轮异常")
        await asyncio.sleep(interval)
