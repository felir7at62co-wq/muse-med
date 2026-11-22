"""小说转视频 API (prefix /v1/novel-video)。仅管理员可用。

- POST /jobs            创建任务(可多篇一次入队) + 上传垫图/音色见 /upload-ref-*
- GET  /jobs            历史列表
- GET  /jobs/{id}       任务详情(含 shots)
- GET  /jobs/{id}/video 成片URL
- POST /shots/{id}/regenerate  单图重生成
- POST /upload-image-ref  上传统一垫图 → oss_key
- POST /upload-voice-ref  上传参考音色 → oss_key
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, field_validator
from sqlalchemy import select

from ..auth import User, require_admin, require_novel_video
from ..db import session_scope
from ..oss import client as oss_client
from .models import (
    NovelVideoAudioChunk, NovelVideoBgm, NovelVideoJob, NovelVideoShot,
    NovelVideoVoice, NovelVideoStylePreset, NovelVideoCoverPreset,
    NovelVideoOverlayPreset,
)
from . import service

BGM_CATEGORIES = ["古风", "现代"]

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/v1/novel-video", tags=["novel-video"])


class NovelSpec(BaseModel):
    title: Optional[str] = None
    novel_text: str
    style_prompt: str = ""
    ref_image_oss_key: Optional[str] = None            # 兼容旧单图
    ref_image_oss_keys: Optional[list[str]] = None     # 多图垫图(优先)
    voice_ref_oss_key: Optional[str] = None
    # 音色模式: 'male'=男音池轮转 | 'female'=女音池轮转 | 'auto'=按AI主角性别选池 | 'custom'/None=用 voice_ref_oss_key 指定的单个音色
    voice_mode: Optional[str] = None
    overlays: Optional[dict] = None                    # 画面水印(免责声明/右上角标语)
    width: int = 1080
    height: int = 1920
    fps: int = 30
    per_image_seconds: int = 10   # 每张图播放秒数(=每X秒一张图); 越小图越多、生图越贵越慢
    image_model: str = "gpt-image-2"
    # 封面(视频第一帧): 开关 + 文字布局(占位符 {title}/{tags})
    cover_enabled: bool = False
    cover_overlays: Optional[dict] = None

    @field_validator("per_image_seconds")
    @classmethod
    def _clamp_per_image_seconds(cls, v: int) -> int:
        # 合理区间 [2, 60]: 太小图片数量爆炸(生图开销/耗时激增), 太大画面长时间不动。
        try:
            v = int(v)
        except Exception:  # noqa: BLE001
            return 10
        return max(2, min(60, v))


class CreateJobsBody(BaseModel):
    # 支持一次多篇: 每篇一个 NovelSpec (共享垫图/音色/规格可在各自 spec 内填)
    novels: list[NovelSpec]
    auto_compose: bool = False  # 全自动: 生图完不暂停, 自动合成成片(受后端 CPU 并发信号量限流)
    bgm_category: Optional[str] = None  # 古风 | 现代 | None(无BGM); 在该类型池里按顺序轮转选曲


@router.post("/extract-text")
async def extract_text(file: UploadFile = File(...), user: User = Depends(require_novel_video)):
    """从上传文件提取纯文本, 支持 txt / md / docx / pdf。
    前端拿到 text 后作为小说正文入队(txt/md 前端可自行读, docx/pdf 必须走这里, 因为是二进制)。
    """
    from ..stages.file_upload import parse_file
    res = await parse_file(file)
    if res.get("error"):
        raise HTTPException(status_code=400, detail=res["error"])
    return {"title": res.get("title"), "text": res.get("content") or "", "word_count": res.get("word_count", 0)}


@router.post("/upload-image-ref")
async def upload_image_ref(file: UploadFile = File(...), user: User = Depends(require_novel_video)):
    raw = await file.read()
    key = oss_client.build_oss_key(user_id=user.id, filename=file.filename or "ref.png", namespace="novel-video-imgref")
    await oss_client.put_object_async(key, raw)
    return {"oss_key": key}


@router.post("/upload-voice-ref")
async def upload_voice_ref(
    file: UploadFile = File(...),
    gender: Optional[str] = None,   # 'male' | 'female' | None; 上传时指定该音色进入哪个性别池
    user: User = Depends(require_novel_video),
):
    """上传参考音色 → OSS → 入音色库(按文件名命名, 供之后下拉复用)。
    gender 指定该音色的性别归类(male/female), 供"男/女/自动"音色模式筛选; 未传则尝试按文件名推断。
    返回 oss_key(兼容旧调用) + 音色库条目 id/name/gender。
    """
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="空文件")
    fname = file.filename or "ref.wav"
    # 性别归类: 优先用显式传入的 gender; 否则按文件名含"男"/"女"推断; 都没有则留空
    g = (gender or "").strip().lower()
    if g not in ("male", "female"):
        if "女" in fname:
            g = "female"
        elif "男" in fname:
            g = "male"
        else:
            g = None
    key = oss_client.build_oss_key(user_id=user.id, filename=fname, namespace="novel-video-voiceref")
    await oss_client.put_object_async(key, raw)
    async with session_scope() as s:
        v = NovelVideoVoice(user_id=user.id, name=fname, oss_key=key, gender=g)
        s.add(v); await s.flush()
        vid = v.id
    return {"oss_key": key, "id": vid, "name": fname, "gender": g}


@router.get("/voices")
async def list_voices(user: User = Depends(require_novel_video)):
    """列出当前用户的参考音色库(最近在前)。供新建任务下拉选择。"""
    async with session_scope() as s:
        rows = (await s.execute(
            select(NovelVideoVoice).where(NovelVideoVoice.user_id == user.id)
            .order_by(NovelVideoVoice.id.desc())
        )).scalars().all()
        return {"voices": [{
            "id": v.id, "name": v.name, "oss_key": v.oss_key,
            "gender": v.gender,
            "url": _oss_url(v.oss_key),
            "created_at": v.created_at.isoformat() if v.created_at else None,
        } for v in rows]}


class VoiceGenderIn(BaseModel):
    gender: Optional[str] = None   # 'male' | 'female' | None


@router.put("/voices/{voice_id}/gender")
async def set_voice_gender(voice_id: int, body: VoiceGenderIn, user: User = Depends(require_novel_video)):
    """修改某个音色的性别归类(male/female/None)。供前端手动纠正分类。"""
    g = (body.gender or "").strip().lower()
    if g not in ("male", "female"):
        g = None
    async with session_scope() as s:
        v = await s.get(NovelVideoVoice, voice_id)
        if not v or v.user_id != user.id:
            raise HTTPException(status_code=404, detail="音色不存在")
        v.gender = g
    return {"ok": True, "id": voice_id, "gender": g}


@router.delete("/voices/{voice_id}")
async def delete_voice(voice_id: int, user: User = Depends(require_novel_video)):
    """删除自己音色库里的一个音色。已创建的任务已存 oss_key, 不受影响。"""
    async with session_scope() as s:
        v = await s.get(NovelVideoVoice, voice_id)
        if not v or v.user_id != user.id:
            raise HTTPException(status_code=404, detail="音色不存在")
        await s.delete(v)
    return {"ok": True}


# ==================== 画风提示词预设 ====================
class StylePresetIn(BaseModel):
    name: str
    prompt: str = ""


@router.get("/style-presets")
async def list_style_presets(user: User = Depends(require_novel_video)):
    """列出当前用户的画风提示词预设(最近更新在前)。供新建任务下拉选择。"""
    async with session_scope() as s:
        rows = (await s.execute(
            select(NovelVideoStylePreset).where(NovelVideoStylePreset.user_id == user.id)
            .order_by(NovelVideoStylePreset.updated_at.desc(), NovelVideoStylePreset.id.desc())
        )).scalars().all()
        return {"presets": [{
            "id": p.id, "name": p.name, "prompt": p.prompt or "",
        } for p in rows]}


@router.post("/style-presets")
async def create_style_preset(body: StylePresetIn, user: User = Depends(require_novel_video)):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="预设名不能为空")
    async with session_scope() as s:
        p = NovelVideoStylePreset(user_id=user.id, name=name[:100], prompt=body.prompt or "")
        s.add(p); await s.flush()
        return {"id": p.id, "name": p.name, "prompt": p.prompt or ""}


@router.put("/style-presets/{preset_id}")
async def update_style_preset(preset_id: int, body: StylePresetIn, user: User = Depends(require_novel_video)):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="预设名不能为空")
    async with session_scope() as s:
        p = await s.get(NovelVideoStylePreset, preset_id)
        if not p or p.user_id != user.id:
            raise HTTPException(status_code=404, detail="预设不存在")
        p.name = name[:100]
        p.prompt = body.prompt or ""
        return {"id": p.id, "name": p.name, "prompt": p.prompt or ""}


@router.delete("/style-presets/{preset_id}")
async def delete_style_preset(preset_id: int, user: User = Depends(require_novel_video)):
    async with session_scope() as s:
        p = await s.get(NovelVideoStylePreset, preset_id)
        if not p or p.user_id != user.id:
            raise HTTPException(status_code=404, detail="预设不存在")
        await s.delete(p)
    return {"ok": True}


# ---------------- 封面样式预设 CRUD ----------------
class CoverPresetIn(BaseModel):
    name: str
    layout: dict   # {"items":[{text,xPct,yPct,fontPct,vertical,font,color,stroke}]}


@router.get("/cover-presets")
async def list_cover_presets(user: User = Depends(require_novel_video)):
    """列出当前用户的封面样式预设(最近更新在前)。只存布局, 不存具体文案。"""
    async with session_scope() as s:
        rows = (await s.execute(
            select(NovelVideoCoverPreset).where(NovelVideoCoverPreset.user_id == user.id)
            .order_by(NovelVideoCoverPreset.updated_at.desc(), NovelVideoCoverPreset.id.desc())
        )).scalars().all()
        return {"presets": [{
            "id": p.id, "name": p.name, "layout": p.layout or {},
        } for p in rows]}


@router.post("/cover-presets")
async def create_cover_preset(body: CoverPresetIn, user: User = Depends(require_novel_video)):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="预设名不能为空")
    async with session_scope() as s:
        p = NovelVideoCoverPreset(user_id=user.id, name=name[:100], layout=body.layout or {})
        s.add(p); await s.flush()
        return {"id": p.id, "name": p.name, "layout": p.layout or {}}


@router.put("/cover-presets/{preset_id}")
async def update_cover_preset(preset_id: int, body: CoverPresetIn, user: User = Depends(require_novel_video)):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="预设名不能为空")
    async with session_scope() as s:
        p = await s.get(NovelVideoCoverPreset, preset_id)
        if not p or p.user_id != user.id:
            raise HTTPException(status_code=404, detail="预设不存在")
        p.name = name[:100]
        p.layout = body.layout or {}
        return {"id": p.id, "name": p.name, "layout": p.layout or {}}


@router.delete("/cover-presets/{preset_id}")
async def delete_cover_preset(preset_id: int, user: User = Depends(require_novel_video)):
    async with session_scope() as s:
        p = await s.get(NovelVideoCoverPreset, preset_id)
        if not p or p.user_id != user.id:
            raise HTTPException(status_code=404, detail="预设不存在")
        await s.delete(p)
    return {"ok": True}


# ---------------- 画面文字/字幕样式预设 CRUD ----------------
class OverlayPresetIn(BaseModel):
    name: str
    layout: dict   # {"items":[...], "subtitle":{...}}


@router.get("/overlay-presets")
async def list_overlay_presets(user: User = Depends(require_novel_video)):
    """列出画面文字/字幕样式预设(最近更新在前)。飞书自动化按 `飞书自动化{比例}` 命名匹配。"""
    async with session_scope() as s:
        rows = (await s.execute(
            select(NovelVideoOverlayPreset).where(NovelVideoOverlayPreset.user_id == user.id)
            .order_by(NovelVideoOverlayPreset.updated_at.desc(), NovelVideoOverlayPreset.id.desc())
        )).scalars().all()
        return {"presets": [{"id": p.id, "name": p.name, "layout": p.layout or {}} for p in rows]}


@router.post("/overlay-presets")
async def create_overlay_preset(body: OverlayPresetIn, user: User = Depends(require_novel_video)):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="预设名不能为空")
    async with session_scope() as s:
        p = NovelVideoOverlayPreset(user_id=user.id, name=name[:100], layout=body.layout or {})
        s.add(p); await s.flush()
        return {"id": p.id, "name": p.name, "layout": p.layout or {}}


@router.put("/overlay-presets/{preset_id}")
async def update_overlay_preset(preset_id: int, body: OverlayPresetIn, user: User = Depends(require_novel_video)):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="预设名不能为空")
    async with session_scope() as s:
        p = await s.get(NovelVideoOverlayPreset, preset_id)
        if not p or p.user_id != user.id:
            raise HTTPException(status_code=404, detail="预设不存在")
        p.name = name[:100]
        p.layout = body.layout or {}
        return {"id": p.id, "name": p.name, "layout": p.layout or {}}


@router.delete("/overlay-presets/{preset_id}")
async def delete_overlay_preset(preset_id: int, user: User = Depends(require_novel_video)):
    async with session_scope() as s:
        p = await s.get(NovelVideoOverlayPreset, preset_id)
        if not p or p.user_id != user.id:
            raise HTTPException(status_code=404, detail="预设不存在")
        await s.delete(p)
    return {"ok": True}


async def _voice_pool_by_gender(s, user_id: int, gender: str) -> list[str]:
    """取某用户指定性别的音色池 oss_key 列表(按 id 升序, 便于轮转)。"""
    return (await s.execute(
        select(NovelVideoVoice.oss_key).where(
            NovelVideoVoice.user_id == user_id, NovelVideoVoice.gender == gender
        ).order_by(NovelVideoVoice.id)
    )).scalars().all()


@router.post("/jobs")
async def create_jobs(body: CreateJobsBody, user: User = Depends(require_novel_video)):
    if not body.novels:
        raise HTTPException(status_code=400, detail="至少一篇小说")
    cat = body.bgm_category if body.bgm_category in BGM_CATEGORIES else None
    job_ids = []
    async with session_scope() as s:
        # 音色性别池(供 male/female 模式轮转; auto 模式在 run_job 里按 AI 主角性别取)
        male_pool = await _voice_pool_by_gender(s, user.id, "male")
        female_pool = await _voice_pool_by_gender(s, user.id, "female")
        voice_pick = {"male": 0, "female": 0}  # 各性别池轮转游标(本批内)
        # BGM 轮转: 取该分类池(按 id 升序), 用"该分类已创建任务数"做起点, 逐个任务轮转分配, 用完从头。
        bgm_pool: list[str] = []
        rotate_start = 0
        if cat:
            bgm_pool = [b.oss_key for b in (await s.execute(
                select(NovelVideoBgm).where(NovelVideoBgm.category == cat).order_by(NovelVideoBgm.id)
            )).scalars().all()]
            if bgm_pool:
                # 已用该分类的历史任务数 → 轮转起点(保证跨批次也连续轮转)
                rotate_start = len((await s.execute(
                    select(NovelVideoJob.id).where(
                        NovelVideoJob.user_id == user.id, NovelVideoJob.bgm_category == cat
                    )
                )).scalars().all())
        pick_i = 0
        for spec in body.novels:
            if not (spec.novel_text or "").strip():
                continue
            bgm_key = None
            if bgm_pool:
                bgm_key = bgm_pool[(rotate_start + pick_i) % len(bgm_pool)]
                pick_i += 1
            # 音色选择: male/female 模式从对应性别池轮转选一个; auto 留空(run_job 按 AI 主角性别选);
            # custom/None 用前端指定的 voice_ref_oss_key。
            mode = (spec.voice_mode or "").strip().lower()
            voice_key = spec.voice_ref_oss_key
            if mode in ("male", "female"):
                pool = male_pool if mode == "male" else female_pool
                if pool:
                    voice_key = pool[voice_pick[mode] % len(pool)]
                    voice_pick[mode] += 1
            elif mode == "auto":
                voice_key = None  # 交给 run_job: 分析主角性别后从对应池选
            job = NovelVideoJob(
                user_id=user.id,
                title=spec.title or (spec.novel_text[:20] + "…"),
                novel_text=spec.novel_text,
                style_prompt=spec.style_prompt or "",
                ref_image_oss_key=spec.ref_image_oss_key,
                ref_image_oss_keys=spec.ref_image_oss_keys or None,
                voice_ref_oss_key=voice_key,
                overlays=spec.overlays or None,
                width=spec.width, height=spec.height, fps=spec.fps,
                per_image_seconds=spec.per_image_seconds,
                image_model=spec.image_model or "gpt-image-2",
                auto_compose=1 if body.auto_compose else 0,
                bgm_category=cat, bgm_oss_key=bgm_key,
                cover_enabled=1 if spec.cover_enabled else 0,
                cover_overlays=spec.cover_overlays or None,
                # 重活只在算力机跑: 置 pending + pending_action='run', 由常驻 worker 认领执行(主站不本地 run_job)
                status="pending",
                pending_action="run",
            )
            s.add(job); await s.flush(); job_ids.append(job.id)
    # 不在主站本地跑重活(生图/合成), 交给算力机常驻 worker 认领(上面已置 pending + pending_action='run')
    return {"ok": True, "job_ids": job_ids}


@router.get("/jobs")
async def list_jobs(source: Optional[str] = None, exclude_source: Optional[str] = None,
                    user: User = Depends(require_novel_video)):
    """任务列表。source=feishu 只看飞书来源; exclude_source=feishu 只看普通任务(主页用)。"""
    async with session_scope() as s:
        q = select(NovelVideoJob).where(NovelVideoJob.user_id == user.id)
        if source:
            q = q.where(NovelVideoJob.source == source)
        elif exclude_source:
            # source 为 NULL 或 != exclude_source
            q = q.where((NovelVideoJob.source.is_(None)) | (NovelVideoJob.source != exclude_source))
        rows = (await s.execute(
            q.order_by(NovelVideoJob.id.desc()).limit(1000)
        )).scalars().all()
        return {"jobs": [{
            "id": j.id, "title": j.title, "status": j.status, "progress": j.progress,
            "image_count": j.image_count, "audio_duration": j.audio_duration,
            "video_oss_key": j.video_oss_key, "error": j.error,
            "created_at": j.created_at.isoformat() if j.created_at else None,
        } for j in rows]}


def _oss_url(key: Optional[str]) -> Optional[str]:
    if not key:
        return None
    try:
        return oss_client.sign_get_url(key, ttl_seconds=86400)
    except Exception:  # noqa: BLE001
        return None


@router.get("/jobs/{job_id}")
async def get_job(job_id: int, user: User = Depends(require_novel_video)):
    async with session_scope() as s:
        j = await s.get(NovelVideoJob, job_id)
        if not j or j.user_id != user.id:
            raise HTTPException(status_code=404, detail="任务不存在")
        shots = (await s.execute(
            select(NovelVideoShot).where(NovelVideoShot.job_id == job_id).order_by(NovelVideoShot.idx)
        )).scalars().all()
        return {
            "id": j.id, "title": j.title, "status": j.status, "progress": j.progress,
            "image_count": j.image_count, "audio_duration": j.audio_duration,
            "style_prompt": j.style_prompt, "error": j.error,
            "video_url": _oss_url(j.video_oss_key),
            "audio_url": _oss_url(j.audio_oss_key),
            "cover_enabled": bool(j.cover_enabled),
            "cover_title": j.cover_title or "",
            "cover_tags": j.cover_tags or "",
            "cover_prompt": j.cover_prompt or "",
            "cover_url": _oss_url(j.cover_oss_key),
            "cover_overlays": j.cover_overlays or None,
            # 封面图作为虚拟分镜(id=-1, idx=-1)放在 shots 最前, 前端右侧列表第一个即封面
            "shots": ([{
                "id": -1, "idx": -1, "text_segment": "封面",
                "image_prompt": (j.cover_title or ""), "status": "done",
                "image_url": _oss_url(j.cover_oss_key), "error": None,
                "is_cover": True,
            }] if j.cover_oss_key else []) + [{
                "id": sh.id, "idx": sh.idx, "text_segment": sh.text_segment,
                "image_prompt": sh.image_prompt, "status": sh.status,
                "image_url": _oss_url(sh.image_oss_key), "error": sh.error,
                "is_cover": False,
            } for sh in shots],
        }


@router.post("/jobs/{job_id}/compose")
async def compose_job_route(job_id: int, user: User = Depends(require_novel_video)):
    async with session_scope() as s:
        j = await s.get(NovelVideoJob, job_id)
        if not j or j.user_id != user.id:
            raise HTTPException(status_code=404, detail="任务不存在")
        if j.status not in ("await_confirm", "succeeded", "failed"):
            raise HTTPException(status_code=400, detail=f"当前状态({j.status})不可合成")
        # 重活只在算力机跑: 置 pending + pending_action='compose', 由 worker 认领合成(主站不本地 compose_job)
        j.status = "pending"
        j.pending_action = "compose"
        j.action_params = None
    return {"ok": True}


class RegenCoverBody(BaseModel):
    cover_title: Optional[str] = None      # 用户改后的标题(为空则沿用已存/重新生成)
    cover_tags: Optional[str] = None       # 用户改后的标签(不含"完结")
    cover_prompt: Optional[str] = None     # 用户改后的封面图提示词
    cover_overlays: Optional[dict] = None  # 用户改后的封面文字布局


@router.post("/jobs/{job_id}/regenerate-cover")
async def regenerate_cover_route(job_id: int, body: RegenCoverBody, user: User = Depends(require_novel_video)):
    """重新生成封面(不重跑整段视频)。可传改后的标题/标签/提示词/布局;
    仅重生成封面图与文案, 生成后需用户再点"合成"把新封面合进成片。"""
    async with session_scope() as s:
        j = await s.get(NovelVideoJob, job_id)
        if not j or j.user_id != user.id:
            raise HTTPException(status_code=404, detail="任务不存在")
        j.cover_enabled = 1
        if body.cover_title is not None:
            j.cover_title = body.cover_title.strip() or None
        if body.cover_tags is not None:
            j.cover_tags = body.cover_tags.strip() or None
        if body.cover_prompt is not None:
            j.cover_prompt = body.cover_prompt.strip() or None
        if body.cover_overlays is not None:
            j.cover_overlays = body.cover_overlays or None
        model = j.image_model or "gpt-image-2"
        size = f"{j.width}x{j.height}"
        style_prompt = j.style_prompt or ""
        ref_image_keys = list(j.ref_image_oss_keys or ([] if not j.ref_image_oss_key else [j.ref_image_oss_key]))
        # 重活只在算力机跑: 置 pending + pending_action='regen_cover', 由 worker 认领(主站不本地跑)
        j.status = "pending"
        j.pending_action = "regen_cover"
        j.action_params = None
    return {"ok": True}


@router.post("/jobs/{job_id}/retry")
async def retry_job(job_id: int, user: User = Depends(require_novel_video)):
    """重新发起一个失败/中断的任务: 清掉旧的分镜与音频分片, 重置为 pending 后从头重跑。

    仅允许对 failed / canceled 的任务重跑(运行中/已完成的不重跑, 避免误触)。
    复用原 job 的全部配置(小说全文/画风/垫图/音色/规格/BGM/水印), 用户无需重填。
    """
    from sqlalchemy import delete as _delete
    async with session_scope() as s:
        j = await s.get(NovelVideoJob, job_id)
        if not j or j.user_id != user.id:
            raise HTTPException(status_code=404, detail="任务不存在")
        if j.status not in ("failed", "canceled"):
            raise HTTPException(status_code=400, detail=f"当前状态({j.status})不可重跑, 仅失败/取消的任务可重新发起")
        # 清理上次残留的分镜/音频分片(从头重跑, 不复用旧的半成品)
        await s.execute(_delete(NovelVideoShot).where(NovelVideoShot.job_id == job_id))
        await s.execute(_delete(NovelVideoAudioChunk).where(NovelVideoAudioChunk.job_id == job_id))
        # 重置任务状态与产出字段
        j.status = "pending"
        j.progress = 0
        j.error = None
        j.image_count = 0
        j.audio_duration = 0
        j.audio_oss_key = None
        j.video_oss_key = None
        # 重活只在算力机跑: 置 pending + pending_action='run', 由 worker 认领从头重跑(主站不本地 run_job)
        j.pending_action = "run"
        j.action_params = None
    return {"ok": True, "job_id": job_id, "message": "已重新发起, 从头开始生成"}


@router.delete("/jobs/feishu-failed")
async def clear_feishu_failed(user: User = Depends(require_novel_video)):
    """一键清空当前用户飞书自动化列表中所有「失败」的任务。

    只删 source='feishu' 且 status='failed' 的任务(连带其分镜/音频分片, CASCADE)。
    不影响进行中/已完成/待确认的任务。返回删除条数。
    """
    from sqlalchemy import delete as _delete, select as _select
    async with session_scope() as s:
        ids = (await s.execute(
            _select(NovelVideoJob.id).where(
                NovelVideoJob.user_id == user.id,
                NovelVideoJob.source == "feishu",
                NovelVideoJob.status == "failed",
            )
        )).scalars().all()
        if ids:
            # 先删子表(shots/audio_chunks), 再删主表(FK ondelete=CASCADE 已配, 双保险显式删)
            await s.execute(_delete(NovelVideoShot).where(NovelVideoShot.job_id.in_(ids)))
            await s.execute(_delete(NovelVideoAudioChunk).where(NovelVideoAudioChunk.job_id.in_(ids)))
            await s.execute(_delete(NovelVideoJob).where(NovelVideoJob.id.in_(ids)))
    return {"ok": True, "deleted": len(ids)}


@router.delete("/jobs/failed")
async def clear_failed(user: User = Depends(require_novel_video)):
    """一键清空当前用户「普通任务」(非飞书)中所有 status='failed' 的任务(连带分镜/音频分片)。
    只删 source 非 'feishu'(NULL 或其它)且 failed 的; 飞书失败用 /jobs/feishu-failed。返回删除条数。"""
    from sqlalchemy import delete as _delete, select as _select
    async with session_scope() as s:
        ids = (await s.execute(
            _select(NovelVideoJob.id).where(
                NovelVideoJob.user_id == user.id,
                (NovelVideoJob.source.is_(None)) | (NovelVideoJob.source != "feishu"),
                NovelVideoJob.status == "failed",
            )
        )).scalars().all()
        if ids:
            await s.execute(_delete(NovelVideoShot).where(NovelVideoShot.job_id.in_(ids)))
            await s.execute(_delete(NovelVideoAudioChunk).where(NovelVideoAudioChunk.job_id.in_(ids)))
            await s.execute(_delete(NovelVideoJob).where(NovelVideoJob.id.in_(ids)))
    return {"ok": True, "deleted": len(ids)}


class RegenBody(BaseModel):
    new_prompt: Optional[str] = None


@router.post("/shots/{shot_id}/regenerate")
async def regenerate(shot_id: int, body: RegenBody, user: User = Depends(require_novel_video)):
    async with session_scope() as s:
        sh = await s.get(NovelVideoShot, shot_id)
        if not sh:
            raise HTTPException(status_code=404, detail="分镜不存在")
        job = await s.get(NovelVideoJob, sh.job_id)
        if not job or job.user_id != user.id:
            raise HTTPException(status_code=403, detail="无权限")
        # 重活只在算力机跑: 置 job pending + pending_action='regen_shot', 参数带 shot_id/new_prompt, 由 worker 认领(主站不本地跑)
        job.status = "pending"
        job.pending_action = "regen_shot"
        job.action_params = {"shot_id": shot_id, "new_prompt": body.new_prompt}
    return {"ok": True}


def _safe_filename(name: str) -> str:
    """把标题清成安全文件名: 去掉原扩展名(如上传的 .txt/.docx), 去非法字符, 限长。"""
    import re as _re
    name = (name or "").strip()
    # 去掉常见文档扩展名(标题可能是上传的原文件名, 如 "第一章.txt")
    name = _re.sub(r"\.(txt|md|docx|doc|pdf)$", "", name, flags=_re.IGNORECASE)
    name = _re.sub(r"[\\/:*?\"<>|\n\r]+", "_", name).strip() or "video"
    return name[:40]


@router.get("/jobs/{job_id}/download-url")
async def download_job_url(job_id: int, user: User = Depends(require_novel_video)):
    """返回"强制下载 + 指定文件名"的 OSS 预签名 URL。

    前端拿到后直接 window.location = url, 浏览器直连 OSS 下载, 不经后端代理/nginx 缓冲,
    大视频秒开下载(修复旧版后端整块读内存再流式回传导致的长时间卡"下载中")。
    文件名用任务标题(上传文件名去扩展名 / 粘贴正文首句)。
    """
    async with session_scope() as s:
        j = await s.get(NovelVideoJob, job_id)
        if not j or j.user_id != user.id:
            raise HTTPException(status_code=404, detail="任务不存在")
        if not j.video_oss_key:
            raise HTTPException(status_code=400, detail="该任务尚无成片可下载")
        # 文件名 = 原文件名/粘贴正文首句 + AI剧名(3~5字) + 2个标签
        base_title = j.title or f"job{j.id}"
        cover_title = (j.cover_title or "").strip()
        cover_tags = (j.cover_tags or "").strip()
        key = j.video_oss_key
    parts = [_safe_filename(base_title)]
    if cover_title:
        parts.append(_safe_filename(cover_title))
    if cover_tags:
        # 标签里的斜杠换成下划线, 避免被当路径分隔
        parts.append(_safe_filename(cover_tags.replace("/", "_")))
    fname = "_".join([p for p in parts if p]) + ".mp4"
    try:
        url = oss_client.sign_download_url(key, filename=fname, ttl_seconds=3600)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"生成下载链接失败: {e}") from e
    return {"url": url, "filename": fname}


class ExportBody(BaseModel):
    job_ids: list[int]


@router.post("/jobs/export")
async def export_jobs(body: ExportBody, user: User = Depends(require_novel_video)):
    """把选中的多个已完成成片打包成 zip 返回(流式)。仅本人、仅 succeeded 且有成片的任务。"""
    import io
    import zipfile
    import re
    from fastapi.responses import StreamingResponse

    if not body.job_ids:
        raise HTTPException(status_code=400, detail="未选择任务")
    # 取任务并校验归属/状态
    picked: list[tuple[int, str, str]] = []  # (id, title, video_oss_key)
    async with session_scope() as s:
        for jid in body.job_ids:
            j = await s.get(NovelVideoJob, jid)
            if j and j.user_id == user.id and j.video_oss_key:
                picked.append((j.id, j.title or f"job{j.id}", j.video_oss_key))
    if not picked:
        raise HTTPException(status_code=400, detail="选中的任务没有可导出的成片")

    def _safe(name: str) -> str:
        name = re.sub(r"[\\/:*?\"<>|\n\r]+", "_", name).strip() or "video"
        return name[:40]

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:  # 视频已压缩, STORED 更快
        used: set[str] = set()
        for jid, title, key in picked:
            try:
                raw = await service._load_bytes(key)
            except Exception:  # noqa: BLE001
                continue
            fname = f"{_safe(title)}_{jid}.mp4"
            n = 1
            while fname in used:
                fname = f"{_safe(title)}_{jid}_{n}.mp4"; n += 1
            used.add(fname)
            zf.writestr(fname, raw)
    buf.seek(0)
    headers = {"Content-Disposition": 'attachment; filename="novel-videos.zip"'}
    return StreamingResponse(buf, media_type="application/zip", headers=headers)


# ==================== BGM 素材管理 ====================
@router.get("/bgm/categories")
async def bgm_categories(user: User = Depends(require_novel_video)):
    return {"categories": BGM_CATEGORIES}


@router.get("/bgm")
async def list_bgm(user: User = Depends(require_novel_video)):
    """列出 BGM 素材库(按分类分组)。BGM 是全站共享素材(仅管理员能上传/删除),
    普通授权用户也能看到并使用, 因此这里返回全部 BGM, 不按 user_id 过滤。"""
    async with session_scope() as s:
        rows = (await s.execute(
            select(NovelVideoBgm).order_by(NovelVideoBgm.category, NovelVideoBgm.id)
        )).scalars().all()
        items = [{
            "id": b.id, "category": b.category, "name": b.name,
            "duration": b.duration, "url": _oss_url(b.oss_key),
        } for b in rows]
    grouped: dict[str, list] = {c: [] for c in BGM_CATEGORIES}
    for it in items:
        grouped.setdefault(it["category"], []).append(it)
    return {"categories": BGM_CATEGORIES, "grouped": grouped, "items": items}


@router.post("/bgm/upload")
async def upload_bgm(category: str, file: UploadFile = File(...), user: User = Depends(require_admin)):
    """上传 BGM: 用 loudnorm 统一响度并转码 mp3 → OSS → 入库。category 必须是 古风/现代。"""
    import os
    import tempfile

    if category not in BGM_CATEGORIES:
        raise HTTPException(status_code=400, detail=f"分类必须是: {'/'.join(BGM_CATEGORIES)}")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="空文件")

    loop = asyncio.get_event_loop()

    def _process() -> tuple[bytes, int]:
        # 落盘 → loudnorm 标准化 → 读回标准化后的 mp3 + 时长
        with tempfile.TemporaryDirectory() as td:
            src = os.path.join(td, "src")
            out = os.path.join(td, "out.mp3")
            with open(src, "wb") as f:
                f.write(raw)
            service.normalize_bgm(src, out)
            dur = int(service._ffprobe_duration(out))
            with open(out, "rb") as f:
                return f.read(), dur

    try:
        norm_bytes, dur = await loop.run_in_executor(None, _process)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"音频处理失败: {e}")

    # 上传标准化后的 mp3 到 OSS(按分类分目录)
    safe_cat = "guofeng" if category == "古风" else "xiandai"
    key = oss_client.build_oss_key(
        user_id=user.id, filename=(file.filename or "bgm.mp3"),
        namespace=f"novel-video-bgm/{safe_cat}",
    )
    await oss_client.put_object_async(key, norm_bytes)

    async with session_scope() as s:
        b = NovelVideoBgm(user_id=user.id, category=category,
                          name=(file.filename or "bgm.mp3"), oss_key=key, duration=dur)
        s.add(b); await s.flush()
        bid = b.id
    return {"ok": True, "id": bid, "category": category, "duration": dur, "url": _oss_url(key)}


@router.delete("/bgm/{bgm_id}")
async def delete_bgm(bgm_id: int, user: User = Depends(require_admin)):
    async with session_scope() as s:
        b = await s.get(NovelVideoBgm, bgm_id)
        if not b or b.user_id != user.id:
            raise HTTPException(status_code=404, detail="BGM 不存在")
        await s.delete(b)
    return {"ok": True}
