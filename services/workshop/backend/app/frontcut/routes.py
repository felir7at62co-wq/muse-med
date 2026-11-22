"""前贴(front-cut) REST 接口 — B线。

流程:
  POST /v1/frontcut/jobs            建任务(传剧情视频OSS key或URL + 规格 + 可选参考) → 后台反推+生成5提示词
  GET  /v1/frontcut/jobs/{id}       查状态/反推结果/5提示词候选/5视频候选
  POST /v1/frontcut/jobs/{id}/generate-videos   用5提示词生成5前贴视频(后台)
  POST /v1/frontcut/jobs/{id}/pick  挑选某条前贴(framework_id) → 拼接(待外置节点)
  GET  /v1/frontcut/frameworks      列出5套框架(前端展示)
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy import select

from ..auth.dependencies import get_current_user
from ..auth.models import User
from ..db import session_scope
from .models import FrontcutJob, FrontcutVoiceRef
from .frameworks import list_frameworks
from . import service as fc

router = APIRouter(prefix="/v1/frontcut", tags=["frontcut"])


class CreateJobIn(BaseModel):
    source_video_oss_key: str | None = None
    source_video_url: str | None = None
    ratio: str | None = None            # 默认取剧情视频比例(前端探测后传)
    resolution: str = "720p"
    duration: int = 10
    user_ref: str | None = None
    corpus_ids: list[int] | None = None   # 可选: 勾选的语料库条目 id(作生成参考上下文)
    ref_image_oss_key: str | None = None  # 可选: 用户上传的主角形象参考图
    voice_ref_id: int | None = None       # 可选: 选定的参考音色库 id(语音克隆口播)


def _sign(key: str | None) -> str | None:
    if not key:
        return None
    try:
        from ..oss import client as _oss
        return _oss.sign_get_url(key, ttl_seconds=3600)
    except Exception:  # noqa: BLE001
        return None


def _job_dict(j: FrontcutJob) -> dict:
    # 给候选视频补签名可播放 URL(原视频 + 高清版 + 两段式分段视频 并存)
    cands = []
    for c in (j.video_candidates or []):
        cc = dict(c)
        cc["video_url"] = _sign(c.get("video_oss_key"))
        cc["hd_video_url"] = _sign(c.get("hd_video_oss_key"))  # 高清版(可空)
        # 两段式(>15s)候选: 每段单独可预览/单独重生 → 分别签名
        cc["seg1_video_url"] = _sign(c.get("seg1_video_oss_key"))
        cc["seg2_video_url"] = _sign(c.get("seg2_video_oss_key"))
        cands.append(cc)

    # 提示词候选补: 前贴口播音频签名URL(供试听)
    pcands = []
    for c in (j.prompt_candidates or []):
        cc = dict(c)
        cc["narration_audio_url"] = _sign(c.get("narration_audio_oss_key"))
        pcands.append(cc)
    return {
        "id": j.id, "status": j.status, "progress": j.progress, "error": j.error,
        "ratio": j.ratio, "resolution": j.resolution, "duration": j.duration,
        "reverse_summary": j.reverse_summary,
        "narration_audio_url": _sign(j.narration_audio_oss_key),  # 原片口播
        "prompt_candidates": pcands,
        "video_candidates": cands,
        "picked_framework_id": j.picked_framework_id,
        "final_video_oss_key": j.final_video_oss_key,
        # 源视频预览 + 成片下载 签名 URL
        "source_video_url": _sign(j.source_video_oss_key) or j.source_video_url,
        "final_video_url": _sign(j.final_video_oss_key),
        "created_at": j.created_at.isoformat() if j.created_at else None,
    }


@router.get("/frameworks")
async def get_frameworks():
    return {"frameworks": list_frameworks()}


@router.post("/jobs")
async def create_job(body: CreateJobIn, user: User = Depends(get_current_user)):
    if not body.source_video_oss_key and not body.source_video_url:
        raise HTTPException(400, "需提供 source_video_oss_key 或 source_video_url")
    # 时长边界: 1~30 秒。≤15 秒单段直出; >15 秒自动两段式顺序生成+拼接(Seedance 单次上限15s)
    if not (1 <= int(body.duration or 0) <= 30):
        raise HTTPException(400, "duration 须在 1~30 秒之间(>15秒将自动两段式生成拼接)")
    # 解析参考音色 id → oss_key
    voice_key = None
    if body.voice_ref_id:
        async with session_scope() as s:
            v = await s.get(FrontcutVoiceRef, body.voice_ref_id)
            if v and v.user_id == user.id:
                voice_key = v.oss_key
    async with session_scope() as s:
        job = FrontcutJob(
            user_id=user.id, status="created", progress=0,
            source_video_oss_key=body.source_video_oss_key,
            source_video_url=body.source_video_url,
            ratio=body.ratio, resolution=body.resolution, duration=body.duration,
            user_ref=body.user_ref, corpus_ids=body.corpus_ids or [],
            ref_image_oss_key=body.ref_image_oss_key,
            voice_ref_oss_key=voice_key,
        )
        s.add(job); await s.flush(); jid = job.id
    asyncio.create_task(fc.run_reverse_and_prompts(jid))
    return {"ok": True, "job_id": jid}


@router.get("/jobs/{job_id}")
async def get_job(job_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        j = await s.get(FrontcutJob, job_id)
        if not j or j.user_id != user.id:
            raise HTTPException(404, "任务不存在")
        return _job_dict(j)


@router.get("/jobs")
async def list_jobs(user: User = Depends(get_current_user)):
    async with session_scope() as s:
        rows = (await s.execute(
            select(FrontcutJob).where(FrontcutJob.user_id == user.id)
            .order_by(FrontcutJob.id.desc()).limit(50)
        )).scalars().all()
        return {"jobs": [_job_dict(j) for j in rows]}


@router.post("/jobs/{job_id}/generate-videos")
async def gen_videos(job_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        j = await s.get(FrontcutJob, job_id)
        if not j or j.user_id != user.id:
            raise HTTPException(404, "任务不存在")
        if not j.prompt_candidates:
            raise HTTPException(400, "尚无提示词候选")
    asyncio.create_task(fc.generate_videos(job_id))
    return {"ok": True}


class PickIn(BaseModel):
    framework_id: str


@router.post("/jobs/{job_id}/pick")
async def pick(job_id: int, body: PickIn, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        j = await s.get(FrontcutJob, job_id)
        if not j or j.user_id != user.id:
            raise HTTPException(404, "任务不存在")
        # 防重复提交: 已在拼接中(用户连点/闪烁重试)直接幂等返回, 不再叠加 ffmpeg 任务
        if j.status == "composing":
            return {"ok": True, "note": "已在拼接中, 请等待完成"}
        j.status = "composing"  # 同步落库, 前端下一次轮询立即可见
        j.picked_framework_id = body.framework_id
    # 拼接(ffmpeg 重编码)较慢, 放后台跑, 立即返回; 前端轮询 job.status(composing→succeeded)。
    # ⚠️ 之前同步 await 会因 >300s 触发超时中间件 504。
    asyncio.create_task(fc.compose_final(job_id, body.framework_id))
    return {"ok": True, "note": "已提交拼接, 完成后成片可下载"}


class RegenIn(BaseModel):
    framework_id: str
    prompt: str | None = None   # 用户编辑后的提示词(可空=用原提示词重生); 两段式候选=第1段
    prompt2: str | None = None  # 两段式候选(>15s)的第2段提示词(可空=用原第2段)
    segment: int | None = None  # 两段式候选: 只重生第1段/第2段(1|2); 空=整条两段都重生


@router.post("/jobs/{job_id}/regenerate-one")
async def regenerate_one(job_id: int, body: RegenIn, user: User = Depends(get_current_user)):
    """按(可选编辑后的)提示词重新生成单条前贴视频。

    body.segment=1|2 时只重生两段式候选的那一段(另一段复用已有产物), 省一半算力;
    两段都就绪后后端自动重新拼接出合并成片。
    """
    if body.segment is not None and body.segment not in (1, 2):
        raise HTTPException(400, "segment 只能是 1 或 2")
    async with session_scope() as s:
        j = await s.get(FrontcutJob, job_id)
        if not j or j.user_id != user.id:
            raise HTTPException(404, "任务不存在")
    asyncio.create_task(
        fc.regenerate_one(job_id, body.framework_id, body.prompt, body.prompt2,
                          only_segment=body.segment))
    return {"ok": True}



@router.post("/jobs/{job_id}/regenerate-prompts")
async def regenerate_prompts(job_id: int, user: User = Depends(get_current_user)):
    """重新生成全部 5 条前贴提示词(复用已有反推结果, 不重跑反推)。"""
    async with session_scope() as s:
        j = await s.get(FrontcutJob, job_id)
        if not j or j.user_id != user.id:
            raise HTTPException(404, "任务不存在")
    asyncio.create_task(fc.regenerate_prompts(job_id))
    return {"ok": True, "note": "已重新提交提示词生成"}


class RegenOnePromptIn(BaseModel):
    framework_id: str


@router.post("/jobs/{job_id}/regenerate-one-prompt")
async def regenerate_one_prompt(job_id: int, body: RegenOnePromptIn, user: User = Depends(get_current_user)):
    """只重新生成某一条框架的前贴提示词(复用反推结果, 其余不动)。"""
    async with session_scope() as s:
        j = await s.get(FrontcutJob, job_id)
        if not j or j.user_id != user.id:
            raise HTTPException(404, "任务不存在")
    asyncio.create_task(fc.regenerate_one_prompt(job_id, body.framework_id))
    return {"ok": True, "note": "已重新提交该条提示词生成"}


class RegenNarrationIn(BaseModel):
    framework_id: str
    narration: str | None = None  # 用户编辑后的口播文案(可空=用原文案重合成)


@router.post("/jobs/{job_id}/regenerate-narration")
async def regenerate_narration(job_id: int, body: RegenNarrationIn, user: User = Depends(get_current_user)):
    """按(可选编辑后的)口播文案重新合成单条前贴口播音频。"""
    async with session_scope() as s:
        j = await s.get(FrontcutJob, job_id)
        if not j or j.user_id != user.id:
            raise HTTPException(404, "任务不存在")
    asyncio.create_task(fc.regenerate_narration(job_id, body.framework_id, body.narration))
    return {"ok": True}


class UpscaleIn(BaseModel):
    framework_id: str


@router.post("/jobs/{job_id}/upscale-one")
async def upscale_one(job_id: int, body: UpscaleIn, user: User = Depends(get_current_user)):
    """对某条前贴候选视频做高清处理(RunningHub SeedVR2)。结果并存到该候选的高清版。"""
    async with session_scope() as s:
        j = await s.get(FrontcutJob, job_id)
        if not j or j.user_id != user.id:
            raise HTTPException(404, "任务不存在")
    asyncio.create_task(fc.upscale_one(job_id, body.framework_id))
    return {"ok": True, "note": "已提交高清处理, 完成后该条会出现高清版"}


# ---- A线: 飞书表抖音链接批量反推(后台任务 + 进度轮询) ----
from .models import FeishuReverseJob
from ..feishu import client as feishu

# 只写反推文本(「文本」列), 不再生成提示词
DEFAULT_FIELD_MAP = {"douyin_url": "链接", "reverse_out": "文本"}


def _default_source() -> str:
    """默认飞书表(用户指定, 无需前端输入): 短剧链接库, 取 FEISHU_LINK_LIBRARY_URL(链接里带 ?table=)。"""
    from ..config import get_settings
    return get_settings().feishu_link_library_url.strip()


def _default_table_id() -> str:
    return feishu.parse_bitable_ref(_default_source())[1] or ""


async def _resolve_default() -> tuple[str, str]:
    """解析默认飞书表 → (app_token, table_id)。"""
    source = _default_source()
    if not source:
        raise HTTPException(400, "未配置默认飞书表(FEISHU_LINK_LIBRARY_URL),请传入表格链接")
    token, table_from_url = feishu.parse_bitable_ref(source)
    app_token = await feishu.resolve_app_token(token)
    return app_token, (table_from_url or _default_table_id())


@router.get("/feishu-reverse/candidates")
async def feishu_candidates(user: User = Depends(get_current_user)):
    """列出默认飞书表里「可反推」的行: 有链接、且「文本」列还空(未反推)。

    供前端弹窗展示勾选。返回 record_id + 链接, 前端勾选后传回 record_ids 执行。
    """
    app_token, table_id = await _resolve_default()
    fm = DEFAULT_FIELD_MAP
    try:
        records = await feishu.list_records(app_token, table_id)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"读取飞书表失败: {str(e)[:200]}")
    candidates = []
    done_cnt = 0
    for r in records:
        fields = r.get("fields") or {}
        url = feishu.cell_text(fields.get(fm["douyin_url"]))
        if not url:
            continue
        done = feishu.cell_text(fields.get(fm["reverse_out"]))
        if done:
            done_cnt += 1
            continue
        candidates.append({
            "record_id": r.get("record_id") or r.get("id"),
            "url": url,
        })
    return {
        "app_token": app_token, "table_id": table_id,
        "total": len(records), "done": done_cnt,
        "pending": len(candidates), "candidates": candidates,
    }


class FeishuReverseIn(BaseModel):
    # 勾选要处理的行(record_id 列表); 不传=处理默认表所有待反推行
    record_ids: list[str] | None = None
    # 以下均可选, 默认用内置的短剧链接库表
    source_ref: str | None = None
    app_token: str | None = None
    table_id: str | None = None
    field_map: dict | None = None


def _rjob_dict(j: FeishuReverseJob) -> dict:
    return {
        "id": j.id, "status": j.status, "progress": j.progress, "error": j.error,
        "total": j.total, "done": j.done, "ok": j.ok, "skip": j.skip, "fail": j.fail,
        "field_map": j.field_map, "table_id": j.table_id,
    }


@router.post("/feishu-reverse")
async def feishu_reverse(body: FeishuReverseIn, user: User = Depends(get_current_user)):
    """建飞书表批量反推任务(A线), 后台执行, 返回 job_id 供轮询。

    默认针对内置短剧链接库表; record_ids 传入时仅处理勾选的行。
    """
    # 解析目标表: 优先用显式传入, 否则用默认表
    if body.app_token or body.source_ref:
        app_token = body.app_token
        if not app_token:
            token, table_from_url = feishu.parse_bitable_ref(body.source_ref)
            app_token = await feishu.resolve_app_token(token)
        table_id = body.table_id or _default_table_id()
        field_map = dict(body.field_map or DEFAULT_FIELD_MAP)
    else:
        app_token, table_id = await _resolve_default()
        field_map = dict(DEFAULT_FIELD_MAP)

    for k in ("douyin_url", "reverse_out"):
        if not field_map.get(k):
            raise HTTPException(400, f"field_map 缺少必填列: {k}")
    if not app_token:
        raise HTTPException(400, "无法解析 app_token")

    # 勾选的行存进 field_map 的私有键(避免加 DB 列), run_reverse_job 会取出过滤
    if body.record_ids:
        field_map["__record_ids__"] = list(body.record_ids)

    async with session_scope() as s:
        job = FeishuReverseJob(
            user_id=user.id, status="pending", progress=0,
            source_ref=body.source_ref or _default_source(),
            app_token=app_token, table_id=table_id,
            field_map=field_map,
        )
        s.add(job); await s.flush(); jid = job.id
    from .feishu_reverse import run_reverse_job
    asyncio.create_task(run_reverse_job(jid))
    return {"ok": True, "job_id": jid}


@router.get("/feishu-reverse/jobs/{job_id}")
async def get_reverse_job(job_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        j = await s.get(FeishuReverseJob, job_id)
        if not j or j.user_id != user.id:
            raise HTTPException(404, "任务不存在")
        return _rjob_dict(j)


@router.get("/feishu-reverse/jobs")
async def list_reverse_jobs(user: User = Depends(get_current_user)):
    async with session_scope() as s:
        rows = (await s.execute(
            select(FeishuReverseJob).where(FeishuReverseJob.user_id == user.id)
            .order_by(FeishuReverseJob.id.desc()).limit(20)
        )).scalars().all()
        return {"jobs": [_rjob_dict(j) for j in rows]}


# ---- 参考音色库(语音克隆): 上传 / 列表 / 删除 ----
_VOICE_MAX = 30 * 1024 * 1024  # 30MB


def _voice_dict(v: FrontcutVoiceRef) -> dict:
    return {
        "id": v.id, "name": v.name,
        "audio_url": _sign(v.oss_key),
        "created_at": v.created_at.isoformat() if v.created_at else None,
    }


@router.get("/voice-refs")
async def list_voice_refs(user: User = Depends(get_current_user)):
    async with session_scope() as s:
        rows = (await s.execute(
            select(FrontcutVoiceRef).where(FrontcutVoiceRef.user_id == user.id)
            .order_by(FrontcutVoiceRef.id.desc()).limit(100)
        )).scalars().all()
        return {"voice_refs": [_voice_dict(v) for v in rows]}


@router.post("/voice-refs")
async def upload_voice_ref(
    file: UploadFile = File(...),
    name: str | None = Form(None),
    user: User = Depends(get_current_user),
):
    """上传参考音色到 OSS, 登记进参考音库(供下拉选择)。"""
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "空文件")
    if len(raw) > _VOICE_MAX:
        raise HTTPException(400, "参考音频过大 (>30MB)")
    from ..oss import client as _oss
    fname = file.filename or "voice.wav"
    key = _oss.build_oss_key(user_id=user.id, filename=fname, namespace="frontcut-voice-ref")
    _oss.get_bucket_public().put_object(key, raw)
    async with session_scope() as s:
        v = FrontcutVoiceRef(user_id=user.id, name=(name or fname).strip()[:100], oss_key=key)
        s.add(v); await s.flush()
        return {"ok": True, "voice_ref": _voice_dict(v), "oss_key": key}


@router.delete("/voice-refs/{ref_id}")
async def delete_voice_ref(ref_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        v = await s.get(FrontcutVoiceRef, ref_id)
        if not v or v.user_id != user.id:
            raise HTTPException(404, "参考音色不存在")
        await s.delete(v)
    return {"ok": True}
