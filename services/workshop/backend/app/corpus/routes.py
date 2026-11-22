"""前贴语料库REST API (prefix /v1/frontcut/corpus)。

流程:- 普通用户: 上传视频/文本→ 列表(预置+自己的) → 编辑/删除自己的
  - 管理员: 上传视频/文本(自动标is_preset=True) → 列表(全部) → 编辑/删除任何人的

2026-08 新增: 二次打标接口
  - 视频反推完成后自动异步打标
  - POST/{item_id}/retag — 单条重打标
  - POST /admin/batch-retag — 批量打标(管理员)
  - GET /admin/tag-stats— 打标统计(管理员)
"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, select

from ..auth import User, get_current_user, require_admin
from ..db import session_scope
from ..oss import client as oss_client
from .models import FrontcutCorpusItem

router = APIRouter(prefix="/v1/frontcut/corpus", tags=["frontcut-corpus"])
log = logging.getLogger("frontcut-corpus")

_VIDEO_MAX = 100* 1024 * 1024  # 100MB


def _is_admin(user: User) -> bool:
    return bool(getattr(user, "role", "") in ("admin", "superadmin"))


def _item_dict(item: FrontcutCorpusItem,*, with_owner_name: bool = False) -> dict:
    """序列化单条语料。with_owner_name=True 时附带owner_username(管理员看自上传用)。"""
    d = {
        "id": item.id,
        "user_id": item.user_id,
        "is_preset": bool(item.is_preset),
        "title": item.title or "",
        "source": item.source or "text",
        "content": item.content or "",
        "video_url": _fresh_url(item),
        "status": item.status,
        "error": item.error or "",
        "created_at": item.created_at.isoformat() if item.created_at else None,
        # 打标字段(2026-08 新增)
        "protagonist_gender": item.protagonist_gender or "",
        "protagonist_role": item.protagonist_role or "",
        "theme_tags": item.theme_tags or [],
        "hook_type": item.hook_type or "",
        "scenario_summary": item.scenario_summary or "",
        "content_rating": item.content_rating or "safe",
        "auto_tagged": bool(item.auto_tagged),
        "tag_version": item.tag_version or 0,
    }
    if with_owner_name:
        d["owner_username"] = ""# 由调用方填充(需join users 表)
    return d


def _fresh_url(item: FrontcutCorpusItem) -> str:
    """视频 URL 可能过期, 每次读时重签。"""
    if not item.video_oss_key:
        return item.video_url or ""
    try:
        return oss_client.sign_get_url(item.video_oss_key, ttl_seconds=6* 3600)
    except Exception:# noqa: BLE001
        return item.video_url or ""


#============ 列表 / 统计 ============

@router.get("")
async def list_corpus(
    user: User = Depends(get_current_user),
    scope: str = Query("all", description="preset=预置; mine=我的自上传; all=预置+我的自上传(管理员=全部)"),
    limit: int = Query(100, le=500),
    offset: int = Query(0, ge=0),
):
    """列出语料(前端弹窗勾选用)。普通用户看预置+自己的; 管理员 all时看全部。"""
    admin = _is_admin(user)
    async with session_scope() as s:
        q = select(FrontcutCorpusItem)
        if scope == "preset":
            q = q.where(FrontcutCorpusItem.is_preset == True)  # noqa: E712
        elif scope == "mine":
            q = q.where(
                (FrontcutCorpusItem.user_id == user.id) & (FrontcutCorpusItem.is_preset == False)  # noqa: E712
            )
        else:  # all
            if admin:
                pass# 管理员看全部
            else:
                # 普通用户: 预置 + 自己的自上传
                q = q.where(
                    (FrontcutCorpusItem.is_preset == True)  # noqa: E712
                    | ((FrontcutCorpusItem.user_id == user.id) & (FrontcutCorpusItem.is_preset == False))  # noqa: E712
                )
        q = q.order_by(FrontcutCorpusItem.id.desc()).limit(limit).offset(offset)
        rows = (await s.execute(q)).scalars().all()
        # 管理员看自上传时, 附带 owner_username(需 join users 表)
        show_owner = admin and scope in ("mine", "all")
        out = []
        if show_owner:
            from ..auth.models import User as UserModel
            user_ids = list({r.user_id for r in rows})
            user_map = {}
            if user_ids:
                users = (await s.execute(
                    select(UserModel.id, UserModel.username).where(UserModel.id.in_(user_ids))
                )).all()
                user_map = {u[0]: u[1] for u in users}
            for r in rows:
                d = _item_dict(r, with_owner_name=True)
                d["owner_username"] = user_map.get(r.user_id, "")
                out.append(d)
        else:
            out = [_item_dict(r) for r in rows]
        return {"items": out, "count": len(out)}


@router.get("/stats")
async def corpus_stats(user: User = Depends(get_current_user)):
    """统计: 预置数+ 我的自上传数(管理员还能看全部自上传数)。"""
    admin = _is_admin(user)
    async with session_scope() as s:
        # 预置
        preset_cnt = (await s.execute(
            select(func.count(FrontcutCorpusItem.id)).where(FrontcutCorpusItem.is_preset == True)  # noqa: E712
        )).scalar() or 0
        # 我的自上传
        mine_cnt = (await s.execute(
            select(func.count(FrontcutCorpusItem.id)).where(
                (FrontcutCorpusItem.user_id == user.id) & (FrontcutCorpusItem.is_preset == False)  # noqa: E712
            )
        )).scalar() or 0
        ret = {"preset": preset_cnt, "mine": mine_cnt}
        if admin:
            # 管理员额外看全部自上传数
            all_personal = (await s.execute(
                select(func.count(FrontcutCorpusItem.id)).where(FrontcutCorpusItem.is_preset == False)  # noqa: E712
            )).scalar() or 0
            ret["all_personal"] = all_personal
        return ret


# ============ 上传 ============

class UploadTextIn(BaseModel):
    title: str
    content: str


@router.post("/upload-text")
async def upload_text(body: UploadTextIn, user: User = Depends(get_current_user)):
    """直接上传文本语料。管理员上传 → is_preset=True(预置); 普通用户 → is_preset=False(自上传)。"""
    if not body.content.strip():
        raise HTTPException(400, "内容不能为空")
    admin = _is_admin(user)
    async with session_scope() as s:
        item = FrontcutCorpusItem(
            user_id=user.id,
            is_preset=admin,  # 管理员=预置, 普通用户=自上传
            title=body.title.strip()[:200] or "未命名语料",
            source="text",
            content=body.content.strip(),
            status="done",
        )
        s.add(item)
        await s.flush()
        item_id = item.id
        result = _item_dict(item)
    # 文本语料上传后也自动打标(异步)
    asyncio.create_task(_run_auto_tag(item_id))
    return {"ok": True, "id": item_id, "item": result}


@router.post("/upload-video")
async def upload_video(
    file: UploadFile = File(...),
    title: str | None = Form(None),
    user: User = Depends(get_current_user),
):
    """上传视频→ 存OSS → 异步反推(doubao分段) → content。

    管理员上传 → is_preset=True; 普通用户 → is_preset=False。
    """
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "空文件")
    if len(raw) > _VIDEO_MAX:
        raise HTTPException(400, f"视频超过 100MB 限制({len(raw) //1024 // 1024}MB)")
    ext = os.path.splitext(file.filename or "v.mp4")[1].lower()
    if ext not in {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}:
        raise HTTPException(400, f"不支持的视频格式: {ext}")

    admin = _is_admin(user)
    t = (title or file.filename or "未命名语料").strip()[:200] or "未命名语料"

    # 先存OSS
    fname = file.filename or "corpus.mp4"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    try:
        tmp.write(raw)
        tmp.flush()
        tmp.close()
        key = oss_client.build_oss_key(user_id=user.id, filename=fname, namespace="frontcut-corpus")
        # 用内网 endpoint 上传(免公网流量费)
        from ..config import get_settings
        settings = get_settings()
        cli = oss_client.get_client_internal()
        await asyncio.to_thread(cli.put_object_from_file, settings.aliyun_oss_bucket, key, tmp.name)
        url = oss_client.sign_get_url(key, ttl_seconds=7 * 24 * 3600)
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:  # noqa: BLE001
            pass

    async with session_scope() as s:
        item = FrontcutCorpusItem(
            user_id=user.id,
            is_preset=admin,
            title=t,
            source="video",
            content="",  # 反推后填充
            video_oss_key=key,
            video_url=url,
            status="uploaded",
        )
        s.add(item)
        await s.flush()
        item_id = item.id

    # 异步反推(反推完成后自动触发打标)
    asyncio.create_task(_run_reverse(item_id))
    return {"ok": True, "id": item_id, "note": "视频已上传, 正在反推画面描述"}


async def _run_reverse(item_id: int) -> None:
    """异步反推视频 → 填充 content。反推成功后自动触发打标。豆包(方舟)视频理解原生支持大文件: 视频存TOS桶时按 URL拉取支持最大 2GB
    (官方文档 File API 说明)。因此直接用 TOS 签名直链整片反推, 保留原画质、
    完整剧情, 不做本地下载/分段/降规格 —— 分段降规格(480p/8fps)会显著降低反推质量。
    """
    try:
        async with session_scope() as s:
            item = await s.get(FrontcutCorpusItem, item_id)
            if not item:
                return
            item.status = "describing"
            key = item.video_oss_key# 走豆包 Files API 整片上传反推(oss_key→下载→上传→file_id 引用), 无50MiB 限制, 原画质
        from ..frontcut.reverse import reverse_video
        content = await reverse_video("",oss_key=key, timeout=600.0)

        if not content:
            async with session_scope() as s:
                item = await s.get(FrontcutCorpusItem, item_id)
                if item:
                    item.status = "failed"
                    item.error = "反推失败:豆包返回空内容"
            return

        async with session_scope() as s:
            item = await s.get(FrontcutCorpusItem, item_id)
            if item:
                item.content = content
                item.status = "done"
                item.error = ""
        log.info("corpus %d 反推完成, %d 字", item_id, len(content))# 反推完成后自动触发打标(异步, 不阻塞主流程)
        asyncio.create_task(_run_auto_tag(item_id))
    except Exception as e:  # noqa: BLE001
        log.exception("corpus %d 反推失败", item_id)
        async with session_scope() as s:
            item = await s.get(FrontcutCorpusItem, item_id)
            if item:
                item.status = "failed"
                item.error = f"反推失败: {type(e).__name__}: {e}"[:1000]


async def _run_auto_tag(item_id: int) -> None:
    """反推完成后自动打标(静默, 失败不影响语料可用性)。"""
    try:
        from .tagger import tag_item
        ok = await tag_item(item_id)
        log.info("corpus %d auto_tag=%s", item_id, ok)
    except Exception as e:  # noqa: BLE001
        log.warning("corpus %d auto_tag failed: %s", item_id, e)


# ============ 详情 / 编辑 / 删除 ============

async def _get_editable(s, item_id: int, user: User) -> FrontcutCorpusItem:
    """获取可编辑的语料: 管理员可编辑任何; 普通用户只能编辑自己的自上传(不能编辑预置)。"""
    item = await s.get(FrontcutCorpusItem, item_id)
    if not item:
        raise HTTPException(404, "语料不存在")
    admin = _is_admin(user)
    if admin:
        return item
    # 普通用户: 只能编辑自己的自上传
    if item.user_id != user.id or item.is_preset:
        raise HTTPException(403, "无权编辑(仅能编辑自己的自上传语料)")
    return item


@router.get("/{item_id}")
async def get_corpus_item(item_id: int, user: User = Depends(get_current_user)):
    """查看单条语料详情。普通用户能看预置+自己的; 管理员能看全部。"""
    admin = _is_admin(user)
    async with session_scope() as s:
        item = await s.get(FrontcutCorpusItem, item_id)
        if not item:
            raise HTTPException(404, "语料不存在")
        # 权限: 管理员全通; 普通用户只能看预置或自己的
        if not admin and not (item.is_preset or item.user_id == user.id):
            raise HTTPException(403, "无权访问")
        return _item_dict(item)


@router.patch("/{item_id}")
async def patch_corpus_item(
    item_id: int,
    user: User = Depends(get_current_user),
    title: Optional[str] = Form(None),
    content: Optional[str] = Form(None),
):
    """编辑语料(title/content)。管理员可编辑任何; 普通用户只能编辑自己的自上传。"""
    async with session_scope() as s:
        item = await _get_editable(s, item_id, user)
        if title is not None:
            item.title = title.strip()[:200] or "未命名语料"
        if content is not None:
            item.content = content.strip()
        return {"ok": True}


@router.delete("/{item_id}")
async def delete_corpus_item(item_id: int, user: User = Depends(get_current_user)):
    """删除语料。管理员可删任何; 普通用户只能删自己的自上传。"""
    async with session_scope() as s:
        item = await _get_editable(s, item_id, user)
        key = item.video_oss_key
        await s.delete(item)
    if key:
        try:
            await oss_client.delete_object_async(key)
        except Exception as e:  # noqa: BLE001
            log.warning("删除 OSS 对象失败 %s: %s", key, e)
    return {"ok": True}


@router.post("/{item_id}/reprocess")
async def reprocess_corpus_item(item_id: int, user: User = Depends(get_current_user)):
    """重跑视频反推(source=video 的语料)。需可编辑权限。"""
    async with session_scope() as s:
        item = await _get_editable(s, item_id, user)
        if item.source != "video":
            raise HTTPException(400, "仅视频语料可重跑反推")
        item.status = "uploaded"
        item.content = ""
        item.error = ""
    asyncio.create_task(_run_reverse(item_id))
    return {"ok": True, "note": "已重新提交反推任务"}


# ============ 管理员: 批量操作 ============

@router.post("/admin/publish")
async def admin_publish_corpus(
    item_id: int,
    admin: User = Depends(require_admin),
):
    """管理员: 把某条自上传语料提升为预置(is_preset=True), 全员可见。"""
    async with session_scope() as s:
        item = await s.get(FrontcutCorpusItem, item_id)
        if not item:
            raise HTTPException(404, "语料不存在")
        item.is_preset = True
        return {"ok": True, "note": "已提升为预置语料"}


# ============ 打标接口(2026-08 新增) ============

@router.post("/{item_id}/retag")
async def retag_corpus_item(item_id: int, user: User = Depends(get_current_user)):
    """对单条语料重新进行 LLM 打标。需可编辑权限(管理员或自己的自上传)。
    异步执行, 立即返回; 打标完成后字段写回 DB, 下次查询时可见新值。
    """
    async with session_scope() as s:
        await _get_editable(s, item_id, user)  # 权限检查
    asyncio.create_task(_run_auto_tag(item_id))
    return {"ok": True, "note": "打标任务已提交,稍后刷新查看结果"}


@router.post("/admin/batch-retag")
async def admin_batch_retag(
    limit: int = Query(50, le=200),
    old_version: int = Query(0, description="重打tag_version<=此值的条目; 0=只打未打标的"),
    admin: User = Depends(require_admin),
):
    """管理员: 批量重打标。
    old_version=0: 只打标auto_tagged=False的条目(适合首次批量打历史数据)。
    old_version>0: 重打 tag_version<=old_version 的条目(适合升级 prompt 后重打旧数据)。
    异步后台执行, 立即返回。
    """
    from .tagger import batch_tag_untagged, batch_retag_by_version
    if old_version <= 0:
        asyncio.create_task(batch_tag_untagged(limit=limit))
        return {"ok": True, "note": f"已提交批量打标任务(未打标, limit={limit})"}
    else:
        asyncio.create_task(batch_retag_by_version(old_version=old_version, limit=limit))
        return {"ok": True, "note": f"已提交批量重打标任务(tag_version<={old_version}, limit={limit})"}


@router.get("/admin/tag-stats")
async def admin_tag_stats(admin: User = Depends(require_admin)):
    """管理员: 打标统计 — 已打标/未打标/各hook_type 分布。"""
    async with session_scope() as s:
        total = (await s.execute(
            select(func.count(FrontcutCorpusItem.id)).where(FrontcutCorpusItem.status == "done")
        )).scalar() or 0
        tagged = (await s.execute(
            select(func.count(FrontcutCorpusItem.id)).where(
                FrontcutCorpusItem.auto_tagged.is_(True),
                FrontcutCorpusItem.status == "done",
            )
        )).scalar() or 0
        # hook_type 分布
        hook_rows = (await s.execute(
            select(FrontcutCorpusItem.hook_type, func.count(FrontcutCorpusItem.id))
            .where(FrontcutCorpusItem.auto_tagged.is_(True))
            .group_by(FrontcutCorpusItem.hook_type)
        )).all()
        hook_dist = {(r[0] or ""): r[1] for r in hook_rows}
    return {
        "total_done": total,
        "tagged": tagged,
        "untagged": total - tagged,
        "hook_type_distribution": hook_dist,
    }