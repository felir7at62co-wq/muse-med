"""image_studio 路由。

用户端 (prefix /v1/image-studio):
  GET  /presets                     取启用的预置前置提示词
  POST /upload-ref                  上传参考图 (multipart), 返回 oss_key (最多前端控制 9 张)
  POST /generate                    发起文生图/图生图, 立即返回 job_id
  GET  /jobs/{id}                   查询任务状态 + 产出图签名 URL
  GET  /jobs                        当前用户的任务历史

管理端 (prefix /v1/admin-api/image-studio):
  GET    /presets                   全部预置词 (含禁用)
  POST   /presets                   新建
  PUT    /presets/{id}              更新
  DELETE /presets/{id}              删除
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import select

from ..auth import get_current_user, User
from ..auth.dependencies import require_admin
from ..db import session_scope
from ..oss import client as oss_client
from . import service
from .models import ImageAsset, ImageJob, ImagePromptPreset
from .providers import MAX_REF_IMAGES
from .ref_labels import apply_ref_label_map

logger = logging.getLogger("image_studio")

router = APIRouter(prefix="/v1/image-studio", tags=["image-studio"])
admin_router = APIRouter(prefix="/v1/admin-api/image-studio", tags=["image-studio-admin"])

ALLOWED_MODELS = {"gpt-image-2", "gemini-3-pro-image-preview", "gemini-3.1-flash-image",
                  "image2.5flare", "image2.5sunburst",
                  "rh-portrait-t2i", "ref-process"}
# 尺寸不再用固定白名单 (前端按 比例×画质 动态算出 size, 如 1080x1920),
# 改为按格式 + 边界校验; 非法才回退到 1024x1024
_SIZE_MIN, _SIZE_MAX = 256, 4096


def _sanitize_size(size: str | None) -> str:
    try:
        w, h = (int(x) for x in str(size or "").lower().split("x"))
    except Exception:  # noqa: BLE001
        return "1024x1024"
    if not (_SIZE_MIN <= w <= _SIZE_MAX and _SIZE_MIN <= h <= _SIZE_MAX):
        return "1024x1024"
    return f"{w}x{h}"


# ---------- 用户端 ----------

@router.get("/workflows")
async def list_workflows_route(user: User = Depends(get_current_user)):
    """固定工作流列表 (不含隐藏前缀)。"""
    from . import workflows as _wf
    return {"workflows": _wf.list_workflows()}


@router.get("/presets")
async def list_presets(user: User = Depends(get_current_user)):
    async with session_scope() as s:
        rows = (await s.execute(
            select(ImagePromptPreset)
            .where(ImagePromptPreset.enabled == True)  # noqa: E712
            .order_by(ImagePromptPreset.sort_order.asc(), ImagePromptPreset.id.asc())
        )).scalars().all()
        return [
            {
                "id": p.id, "name": p.name, "category": p.category,
                "prefix_text": p.prefix_text, "negative_text": p.negative_text,
            }
            for p in rows
        ]


@router.post("/upload-ref")
async def upload_ref(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    """上传一张参考图到 OSS, 返回 oss_key (前端最多收集 9 张后一起提交)。"""
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "empty file")
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(400, "参考图过大 (>15MB)")
    key = oss_client.build_oss_key(
        user_id=user.id, filename=file.filename or "ref.png", namespace="image-studio-ref",
    )
    try:
        await oss_client.put_object_async(key, raw)
    except Exception as e:  # noqa: BLE001
        logger.exception("upload ref failed")
        raise HTTPException(500, f"OSS 上传失败: {e}")
    return {"oss_key": key, "url": oss_client.sign_get_url(key, ttl_seconds=3600)}


class GenerateBody(BaseModel):
    model: str
    prompt: str
    n: int = 1
    size: str = "1024x1024"
    preset_id: Optional[int] = None
    ref_image_keys: Optional[list[str]] = None
    # 每张参考图的标注 (角色名等), 与 ref_image_keys 同序; 用于后端把提示词里的名字替换成 图1..图9
    ref_labels: Optional[list[str]] = None
    auto_hd: bool = True
    auto_polish: bool = False
    workflow: Optional[str] = None
    optimize_prompt: bool = False


@router.post("/generate")
async def generate(body: GenerateBody, user: User = Depends(get_current_user)):
    if body.model not in ALLOWED_MODELS:
        raise HTTPException(400, f"unsupported model (allowed: {sorted(ALLOWED_MODELS)})")
    if not (body.prompt or "").strip() and not (body.ref_image_keys or []):
        raise HTTPException(400, "prompt 或参考图至少提供一个")
    if body.n < 1 or body.n > 4:
        raise HTTPException(400, "n 必须在 1..4")
    body.size = _sanitize_size(body.size)
    refs = (body.ref_image_keys or [])[:MAX_REF_IMAGES]

    # 人像专用 (rh-portrait-t2i): 纯文生图, 不支持参考图/提示词优化/图片润色 (后端兜底强制关闭,
    # 与前端置灰一致; 仅高清保留)。必须有提示词。
    if body.model == "rh-portrait-t2i":
        if not (body.prompt or "").strip():
            raise HTTPException(400, "人像专用为纯文生图, 需填写提示词")
        refs = []
        body.ref_image_keys = []
        body.ref_labels = None
        body.optimize_prompt = False
        body.auto_polish = False

    # 参考图处理 (ref-process): 跳过生图, 直接对上传图各自走 高清/润色。
    # 工作流/数量/比例/画质 全部忽略; 提示词仅在勾选润色时生效 (拼到 #146 预置词后)。
    if body.model == "ref-process":
        if not refs:
            raise HTTPException(400, "参考图处理需要至少上传 1 张图")
        if not (body.auto_hd or body.auto_polish):
            raise HTTPException(400, "请至少勾选 高清 或 图片润色")
        polish_prompt = None
        if body.auto_polish and (body.prompt or "").strip():
            # #146 预置润色词 + 换行 + 用户词 (用户没写则后端不传, 工作流用其默认词)
            _PRESET = "高清放大成细节丰富的摄影作品，去除图片瑕疵，保持整个图片内容不变."
            polish_prompt = _PRESET + "\n" + body.prompt.strip()
        job_id = await service.create_and_run_ref_process(
            user_id=user.id, ref_image_keys=refs,
            auto_hd=body.auto_hd, auto_polish=body.auto_polish,
            polish_prompt=polish_prompt,
        )
        return {"job_id": job_id, "status": "queued"}

    # 拼接预置前缀
    prompt = body.prompt or ""
    if body.preset_id:
        async with session_scope() as s:
            preset = await s.get(ImagePromptPreset, body.preset_id)
            if preset and preset.enabled and (preset.prefix_text or "").strip():
                prompt = f"{preset.prefix_text.strip()}\n{prompt}".strip()

    # 参考图标注 → 图N 替换 (后端隐式)。仅作用于送模型的 effective_prompt,
    # params.prompt 仍是用户原文 (前端只显示原文)。labels 与 refs 同序。
    ref_labels = list(body.ref_labels or [])[:len(refs)] if refs else None

    job_id = await service.create_and_run_generate(
        user_id=user.id, model=body.model, prompt=prompt,
        n=body.n, size=body.size, preset_id=body.preset_id, ref_image_keys=refs,
        auto_hd=body.auto_hd, auto_polish=body.auto_polish, workflow=body.workflow,
        optimize_prompt=body.optimize_prompt, ref_labels=ref_labels,
    )
    return {"job_id": job_id, "status": "queued"}


def _ref_urls_of(job: ImageJob) -> list[str]:
    """从 job.params.ref_image_keys 生成签名预览 URL (供前端在任务顶部展示参考图)。"""
    keys = (dict(job.params or {}).get("ref_image_keys") or [])
    out: list[str] = []
    for k in keys:
        try:
            out.append(oss_client.sign_get_url(k, ttl_seconds=3600))
        except Exception:  # noqa: BLE001
            continue
    return out


def _job_view(job: ImageJob, assets: list[ImageAsset]) -> dict:
    return {
        "id": job.id,
        "kind": job.kind,
        "model": job.model,
        "status": job.status,
        "progress": job.progress,
        "error": job.error,
        "params": job.params,
        "ref_urls": _ref_urls_of(job),
        "parent_job_id": job.parent_job_id,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
        "assets": [
            {
                "id": a.id, "seq": a.seq, "width": a.width, "height": a.height,
                "kind": a.kind,
                "url": oss_client.sign_get_url(a.oss_key, ttl_seconds=3600),
            }
            for a in sorted(assets, key=lambda x: x.seq)
        ],
    }


@router.get("/jobs/{job_id}")
async def get_job(job_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        job = await s.get(ImageJob, job_id)
        if not job or job.user_id != user.id:
            raise HTTPException(404, "job not found")
        assets = (await s.execute(
            select(ImageAsset).where(ImageAsset.job_id == job_id)
        )).scalars().all()
        return _job_view(job, list(assets))


@router.get("/jobs")
async def list_jobs(user: User = Depends(get_current_user), limit: int = 30, offset: int = 0):
    limit = max(1, min(limit, 100))
    offset = max(0, offset)
    async with session_scope() as s:
        jobs = (await s.execute(
            select(ImageJob).where(ImageJob.user_id == user.id)
            .order_by(ImageJob.id.desc()).limit(limit).offset(offset)
        )).scalars().all()
        job_ids = [j.id for j in jobs]
        assets_by_job: dict[int, list[ImageAsset]] = {jid: [] for jid in job_ids}
        if job_ids:
            assets = (await s.execute(
                select(ImageAsset).where(ImageAsset.job_id.in_(job_ids))
            )).scalars().all()
            for a in assets:
                assets_by_job.setdefault(a.job_id, []).append(a)
        return [_job_view(j, assets_by_job.get(j.id, [])) for j in jobs]


@router.post("/assets/{asset_id}/upscale")
async def upscale_asset(asset_id: int, user: User = Depends(get_current_user)):
    """对某张产出图发起高清放大 (RunningHub SeedVR2), 立即返回新 job_id。"""
    async with session_scope() as s:
        asset = await s.get(ImageAsset, asset_id)
        if not asset or asset.user_id != user.id:
            raise HTTPException(404, "asset not found")
        if asset.kind == "upscaled":
            raise HTTPException(400, "该图已是高清放大结果")
    try:
        job_id = await service.create_and_run_upscale(user_id=user.id, source_asset_id=asset_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"job_id": job_id, "status": "queued"}


@router.post("/jobs/{job_id}/cancel")
async def cancel_job_route(job_id: int, user: User = Depends(get_current_user)):
    try:
        st = await service.cancel_job(job_id, user.id)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"job_id": job_id, "status": st}


@router.post("/jobs/{job_id}/retry")
async def retry_job_route(job_id: int, user: User = Depends(get_current_user)):
    """重试失败/取消/中断的任务: 用原 params 新建一个同类型任务。"""
    async with session_scope() as s:
        job = await s.get(ImageJob, job_id)
        if not job or job.user_id != user.id:
            raise HTTPException(404, "job not found")
        if job.status not in ("failed", "canceled", "interrupted"):
            raise HTTPException(400, "只有失败/取消/中断的任务可重试")
        params = dict(job.params or {})
        kind = job.kind
        model = job.model
    if kind == "upscale":
        src = params.get("source_asset_id")
        if not src:
            raise HTTPException(400, "缺少源图, 无法重试")
        try:
            new_id = await service.create_and_run_upscale(user_id=user.id, source_asset_id=int(src))
        except ValueError as e:
            raise HTTPException(400, str(e))
    else:
        new_id = await service.create_and_run_generate(
            user_id=user.id, model=model or "gpt-image-2",
            prompt=params.get("prompt") or "", n=int(params.get("n") or 1),
            size=params.get("size") or "1024x1024",
            preset_id=params.get("preset_id"),
            ref_image_keys=params.get("ref_image_keys") or [],
        )
    return {"job_id": new_id, "status": "queued"}


@router.post("/jobs/{job_id}/regenerate")
async def regenerate_job_route(job_id: int, user: User = Depends(get_current_user)):
    """重新生成: 用原任务完全相同的参数(提示词/工作流/模型/尺寸/参考图/预置)
    新建一个任务, 不覆盖旧任务。任意状态均可 (与 retry 仅限失败态不同)。
    注意: params.prompt 已是拼好预置前缀的最终提示词, 这里直接复用,
    因此 preset_id 不再二次拼接 (置空), 避免前缀被叠加两次。"""
    async with session_scope() as s:
        job = await s.get(ImageJob, job_id)
        if not job or job.user_id != user.id:
            raise HTTPException(404, "job not found")
        params = dict(job.params or {})
        kind = job.kind
        model = job.model
    if kind == "upscale":
        src = params.get("source_asset_id")
        if not src:
            raise HTTPException(400, "缺少源图, 无法重新生成")
        try:
            new_id = await service.create_and_run_upscale(user_id=user.id, source_asset_id=int(src))
        except ValueError as e:
            raise HTTPException(400, str(e))
    else:
        new_id = await service.create_and_run_generate(
            user_id=user.id, model=model or "gpt-image-2",
            prompt=params.get("prompt") or "", n=int(params.get("n") or 1),
            size=params.get("size") or "1024x1024",
            preset_id=None,  # prompt 已含前缀, 不再二次拼接
            ref_image_keys=params.get("ref_image_keys") or [],
            ref_labels=params.get("ref_labels") or None,  # 角色名→图N 隐式替换沿用原任务
            auto_hd=bool(params.get("auto_hd", True)),
            workflow=params.get("workflow"),
        )
    return {"job_id": new_id, "status": "queued"}


@router.delete("/jobs/{job_id}")
async def delete_job_route(job_id: int, user: User = Depends(get_current_user)):
    """删除任务: 连带其子放大任务 + 全部产出图的 DB 记录。
    (OSS 文件由既有清理任务按 30 天策略回收, 这里不做即时删 OSS, 避免误删被引用资源。)"""
    async with session_scope() as s:
        job = await s.get(ImageJob, job_id)
        if not job or job.user_id != user.id:
            raise HTTPException(404, "job not found")
        # 收集自身 + 子放大任务
        child_ids = [
            j.id for j in (await s.execute(
                select(ImageJob).where(ImageJob.parent_job_id == job_id)
            )).scalars().all()
        ]
        all_ids = [job_id] + child_ids
        # 先删 assets, 再删关联的计费记录, 最后删 jobs (外键顺序)
        assets = (await s.execute(
            select(ImageAsset).where(ImageAsset.job_id.in_(all_ids))
        )).scalars().all()
        for a in assets:
            await s.delete(a)
        # image_billing.job_id 外键引用 image_jobs, 删 job 前必须先删其计费记录
        try:
            from ..billing.models import ImageBilling
            bills = (await s.execute(
                select(ImageBilling).where(ImageBilling.job_id.in_(all_ids))
            )).scalars().all()
            for b in bills:
                await s.delete(b)
        except Exception as _e:  # noqa: BLE001
            logger.warning("delete billing rows for jobs %s failed: %s", all_ids, _e)
        for jid in child_ids:
            j = await s.get(ImageJob, jid)
            if j:
                await s.delete(j)
        await s.delete(job)
    return {"ok": True, "deleted": all_ids}


@router.get("/concurrency")
async def concurrency_info(user: User = Depends(get_current_user)):
    """返回并发上限 + 当前用户排队/运行中数量, 供前端展示调度态。"""
    async with session_scope() as s:
        running = (await s.execute(
            select(ImageJob).where(
                ImageJob.user_id == user.id,
                ImageJob.status == "running",
            )
        )).scalars().all()
        pending = (await s.execute(
            select(ImageJob).where(
                ImageJob.user_id == user.id,
                ImageJob.status == "pending",
            )
        )).scalars().all()
    return {"limit": 100, "running": len(running), "pending": len(pending)}


# ---------- 管理端 ----------

class PresetBody(BaseModel):
    name: str
    category: Optional[str] = None
    prefix_text: str = ""
    negative_text: Optional[str] = None
    sort_order: int = 0
    enabled: bool = True


@admin_router.get("/presets")
async def admin_list_presets(admin: User = Depends(require_admin)):
    async with session_scope() as s:
        rows = (await s.execute(
            select(ImagePromptPreset).order_by(
                ImagePromptPreset.sort_order.asc(), ImagePromptPreset.id.asc()
            )
        )).scalars().all()
        return [
            {
                "id": p.id, "name": p.name, "category": p.category,
                "prefix_text": p.prefix_text, "negative_text": p.negative_text,
                "sort_order": p.sort_order, "enabled": p.enabled,
                "created_at": p.created_at.isoformat() if p.created_at else None,
            }
            for p in rows
        ]


@admin_router.post("/presets")
async def admin_create_preset(body: PresetBody, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        p = ImagePromptPreset(
            name=body.name, category=body.category, prefix_text=body.prefix_text,
            negative_text=body.negative_text, sort_order=body.sort_order, enabled=body.enabled,
        )
        s.add(p)
        await s.flush()
        return {"id": p.id}


@admin_router.put("/presets/{preset_id}")
async def admin_update_preset(preset_id: int, body: PresetBody, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        p = await s.get(ImagePromptPreset, preset_id)
        if not p:
            raise HTTPException(404, "preset not found")
        p.name = body.name
        p.category = body.category
        p.prefix_text = body.prefix_text
        p.negative_text = body.negative_text
        p.sort_order = body.sort_order
        p.enabled = body.enabled
        return {"ok": True}


@admin_router.delete("/presets/{preset_id}")
async def admin_delete_preset(preset_id: int, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        p = await s.get(ImagePromptPreset, preset_id)
        if not p:
            raise HTTPException(404, "preset not found")
        await s.delete(p)
        return {"ok": True}
