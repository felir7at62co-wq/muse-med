"""短视频资产库 API (前缀 /v1/clip/assets)。

- 用户: 浏览公共+自己私有、上传(私有,1~N)、详情、改、重跑、删
- 管理员: 文件夹上传(自动分类,公共)、提升为公共、批次进度、看全部
存储走 TOS(__REDACTED__); 上传后异步跑 反推→seedance优化。
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from sqlalchemy import func, select

from ..auth import User, get_current_user, require_admin
from ..db import session_scope
from ..oss import client as oss_client
from .models import ClipAsset
from . import asset_service as svc

router = APIRouter(prefix="/v1/clip/assets", tags=["clip-assets"])
log = logging.getLogger("clip-asset-routes")


def _is_admin(user: User) -> bool:
    return bool(getattr(user, "is_admin", False) or getattr(user, "role", "") == "admin")


def _asset_dict(a: ClipAsset, *, with_owner: bool = False) -> dict:
    d = {
        "id": a.id,
        "user_id": a.user_id,
        "is_public": bool(a.is_public),
        "category": a.category or "未分类",
        "title": a.title or "",
        "video_url": a.video_url or "",
        "cover_url": a.cover_url or "",
        "description": a.description or "",
        "prompt": a.prompt or "",
        "status": a.status,
        "error": a.error or "",
        "batch_id": a.batch_id or "",
        "size_bytes": a.size_bytes or 0,
        "created_at": a.created_at.isoformat() if a.created_at else None,
    }
    return d


def _fresh_url(a: ClipAsset) -> str:
    """预签名 URL 可能过期, 每次读列表时重签一份短期 URL。"""
    if not a.video_oss_key:
        return a.video_url or ""
    try:
        return oss_client.sign_get_url(a.video_oss_key, ttl_seconds=6 * 3600)
    except Exception:
        return a.video_url or ""


# ============ 列表 / 分类 ============

@router.get("")
async def list_assets(
    user: User = Depends(get_current_user),
    category: Optional[str] = Query(None),
    scope: str = Query("all", description="mine/public/all; all对普通用户=public+mine, 对管理员=全部"),
    limit: Optional[int] = Query(None),
    offset: Optional[int] = Query(None),
):
    limit = limit if (limit and 0 < limit <= 500) else 100
    offset = offset if (offset and offset > 0) else 0
    admin = _is_admin(user)
    async with session_scope() as s:
        q = select(ClipAsset)
        if scope == "mine":
            q = q.where(ClipAsset.user_id == user.id)
        elif scope == "public":
            q = q.where(ClipAsset.is_public == True)  # noqa: E712
        else:  # all
            if admin:
                pass  # 管理员看全部
            else:
                q = q.where((ClipAsset.is_public == True) | (ClipAsset.user_id == user.id))  # noqa: E712
        if category:
            q = q.where(ClipAsset.category == category)
        q = q.order_by(ClipAsset.id.desc()).limit(limit).offset(offset)
        rows = (await s.execute(q)).scalars().all()
        out = []
        for a in rows:
            d = _asset_dict(a)
            d["video_url"] = _fresh_url(a)
            out.append(d)
        return {"assets": out, "count": len(out)}


@router.get("/categories")
async def list_categories(
    user: User = Depends(get_current_user),
    scope: str = Query("all"),
):
    admin = _is_admin(user)
    async with session_scope() as s:
        q = select(ClipAsset.category, func.count(ClipAsset.id))
        if scope == "mine":
            q = q.where(ClipAsset.user_id == user.id)
        elif scope == "public":
            q = q.where(ClipAsset.is_public == True)  # noqa: E712
        else:
            if not admin:
                q = q.where((ClipAsset.is_public == True) | (ClipAsset.user_id == user.id))  # noqa: E712
        q = q.group_by(ClipAsset.category).order_by(func.count(ClipAsset.id).desc())
        rows = (await s.execute(q)).all()
        return {"categories": [{"name": r[0] or "未分类", "count": r[1]} for r in rows]}


# ============ 上传(普通用户, 私有, 1~N) ============

@router.post("/upload")
async def upload_assets(
    user: User = Depends(get_current_user),
    files: list[UploadFile] = File(...),
    category: str = Form("未分类"),
):
    if not files:
        raise HTTPException(400, "未选择文件")
    batch_id = svc.new_batch_id() if len(files) > 1 else ""
    created = []
    errors = []
    for f in files:
        try:
            data = await f.read()
            aid = await svc.save_upload_and_enqueue(
                file_bytes=data,
                filename=f.filename or "视频.mp4",
                user_id=user.id,
                is_public=False,  # 普通用户上传=私有
                category=category or "未分类",
                batch_id=batch_id,
            )
            created.append(aid)
        except ValueError as e:
            errors.append({"file": f.filename, "error": str(e)})
        except Exception as e:  # noqa: BLE001
            log.exception("upload asset failed: %s", f.filename)
            errors.append({"file": f.filename, "error": f"上传失败: {e}"})
    return {"ok": True, "created_ids": created, "errors": errors, "batch_id": batch_id}


# ============ 详情 / 改 / 重跑 / 删 ============

async def _get_owned_or_visible(s, asset_id: int, user: User) -> ClipAsset:
    a = (await s.execute(select(ClipAsset).where(ClipAsset.id == asset_id))).scalar_one_or_none()
    if not a:
        raise HTTPException(404, "资产不存在")
    admin = _is_admin(user)
    if not (admin or a.is_public or a.user_id == user.id):
        raise HTTPException(403, "无权访问")
    return a


async def _get_editable(s, asset_id: int, user: User) -> ClipAsset:
    a = (await s.execute(select(ClipAsset).where(ClipAsset.id == asset_id))).scalar_one_or_none()
    if not a:
        raise HTTPException(404, "资产不存在")
    if not (_is_admin(user) or a.user_id == user.id):
        raise HTTPException(403, "只能修改自己的资产")
    return a


@router.get("/{asset_id}")
async def get_asset(asset_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        a = await _get_owned_or_visible(s, asset_id, user)
        d = _asset_dict(a)
        d["video_url"] = _fresh_url(a)
        return d


@router.patch("/{asset_id}")
async def patch_asset(
    asset_id: int,
    user: User = Depends(get_current_user),
    category: Optional[str] = Form(None),
    title: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
    prompt: Optional[str] = Form(None),
):
    async with session_scope() as s:
        a = await _get_editable(s, asset_id, user)
        if category is not None:
            a.category = category.strip()[:80] or "未分类"
        if title is not None:
            a.title = title.strip()[:160]
        if description is not None:
            a.description = description
        if prompt is not None:
            a.prompt = prompt
        return {"ok": True}


@router.post("/{asset_id}/reprocess")
async def reprocess_asset(asset_id: int, user: User = Depends(get_current_user)):
    import asyncio

    async with session_scope() as s:
        a = await _get_editable(s, asset_id, user)
        a.status = "uploaded"
        a.error = ""
    asyncio.create_task(svc.run_pipeline(asset_id))
    return {"ok": True}


@router.delete("/{asset_id}")
async def delete_asset(asset_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        a = await _get_editable(s, asset_id, user)
        key = a.video_oss_key
        await s.delete(a)
    if key:
        try:
            await oss_client.delete_object_async(key)
        except Exception as e:  # noqa: BLE001
            log.warning("删除 TOS 对象失败 %s: %s", key, e)
    return {"ok": True}


# ============ 管理员: 文件夹上传 / 提升公共 / 批次进度 ============

@router.post("/admin/upload-folder")
async def admin_upload_folder(
    admin: User = Depends(require_admin),
    files: list[UploadFile] = File(...),
    paths: list[str] = Form(...),  # 与 files 对齐的 webkitRelativePath
):
    if not files:
        raise HTTPException(400, "未选择文件")
    if len(paths) != len(files):
        raise HTTPException(400, "paths 与 files 数量不一致")
    batch_id = svc.new_batch_id()
    created = []
    errors = []
    for f, rel in zip(files, paths):
        if not svc.is_allowed_video(f.filename or rel):
            continue  # 跳过非视频(封面/说明等)
        category = svc.category_from_relpath(rel)
        try:
            data = await f.read()
            aid = await svc.save_upload_and_enqueue(
                file_bytes=data,
                filename=f.filename or "视频.mp4",
                user_id=admin.id,
                is_public=True,  # 管理员文件夹上传=公共
                category=category,
                batch_id=batch_id,
            )
            created.append(aid)
        except ValueError as e:
            errors.append({"file": rel, "error": str(e)})
        except Exception as e:  # noqa: BLE001
            log.exception("folder upload failed: %s", rel)
            errors.append({"file": rel, "error": f"上传失败: {e}"})
    return {"ok": True, "created_ids": created, "errors": errors, "batch_id": batch_id}


@router.post("/{asset_id}/publish")
async def publish_asset(asset_id: int, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        a = (await s.execute(select(ClipAsset).where(ClipAsset.id == asset_id))).scalar_one_or_none()
        if not a:
            raise HTTPException(404, "资产不存在")
        a.is_public = True
        return {"ok": True}


@router.get("/batches/{batch_id}")
async def batch_progress(batch_id: str, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        rows = (await s.execute(select(ClipAsset).where(ClipAsset.batch_id == batch_id))).scalars().all()
        if not rows:
            return {"batch_id": batch_id, "total": 0, "done": 0, "failed": 0, "processing": 0}
        # 非管理员只能看自己批次
        if not _is_admin(user) and any(r.user_id != user.id for r in rows):
            raise HTTPException(403, "无权查看")
        done = sum(1 for r in rows if r.status == "done")
        failed = sum(1 for r in rows if r.status == "failed")
        return {
            "batch_id": batch_id,
            "total": len(rows),
            "done": done,
            "failed": failed,
            "processing": len(rows) - done - failed,
        }


# ============ Agent 技能用: 检索资产(按关键词/分类) ============

@router.get("/search/for-agent")
async def search_for_agent(
    user: User = Depends(get_current_user),
    query: str = Query("", description="在标题/描述/提示词里模糊匹配"),
    category: Optional[str] = Query(None),
    limit: int = Query(10, le=50),
):
    """给超级 Agent 检索参考资产(可见范围: 公共+自己私有; 管理员全部)。"""
    admin = _is_admin(user)
    async with session_scope() as s:
        q = select(ClipAsset).where(ClipAsset.status == "done")
        if not admin:
            q = q.where((ClipAsset.is_public == True) | (ClipAsset.user_id == user.id))  # noqa: E712
        if category:
            q = q.where(ClipAsset.category == category)
        if query:
            like = f"%{query}%"
            q = q.where(
                (ClipAsset.title.ilike(like))
                | (ClipAsset.description.ilike(like))
                | (ClipAsset.prompt.ilike(like))
            )
        q = q.order_by(ClipAsset.id.desc()).limit(limit)
        rows = (await s.execute(q)).scalars().all()
        return {
            "results": [
                {
                    "id": a.id,
                    "title": a.title,
                    "category": a.category,
                    "description": a.description,
                    "prompt": a.prompt,
                    "video_url": _fresh_url(a),
                }
                for a in rows
            ]
        }