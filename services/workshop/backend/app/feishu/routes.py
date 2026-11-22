"""飞书多维表格自动化 API (prefix /v1/feishu)。

- 配置 CRUD: 存飞书表 app_token/table_id/字段映射(每用户可多套)
- POST /sync/{id}: 扫描该表, 为未处理行批量建小说转视频任务, 完成后回写
- GET /video/{job_id}?t=token: 匿名签名跳转 → 现签 TOS 下载链接 302(写回飞书的永久链接)
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select

from ..auth import User, require_novel_video
from ..db import session_scope
from ..oss import client as oss_client
from ..novel_video.models import FeishuBitableSync, NovelVideoJob
from . import service as feishu_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/v1/feishu", tags=["feishu"])


# 制作表格固定字段映射(用户不再手填, 锁定这套约定)
DEFAULT_FIELD_MAP = {
    "filename": "原 小说名",
    "doc": "附件",
    "title": "改写剧名",
    "tags": "类型",
    "video": "下载链接",
    "style": "风格",
    "ratio": "比例",
    "seconds": "几秒一张图",
}

def _fixed_table_url() -> str:
    """固定的飞书"制作表格"链接(唯一, 前端不再让用户填), 取 FEISHU_PRODUCTION_TABLE_URL。"""
    from ..config import get_settings
    url = get_settings().feishu_production_table_url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="未配置制作表格链接(FEISHU_PRODUCTION_TABLE_URL),请填写表格链接")
    return url


class SyncConfigIn(BaseModel):
    name: str = "飞书自动化"
    app_token: str = ""   # 为空则用固定的制作表格链接
    table_id: str = ""
    field_map: Optional[dict] = None   # 不传则用 DEFAULT_FIELD_MAP
    # 默认样式/参数(行内为空时兜底)
    default_ratio: Optional[str] = None
    default_style_prompt: Optional[str] = None
    default_per_image_seconds: Optional[int] = None
    overlay_layout: Optional[dict] = None
    cover_enabled: Optional[bool] = None
    cover_layout: Optional[dict] = None
    voice_oss_keys: Optional[list] = None
    voice_mode: Optional[str] = None   # custom(默认)/male/female/auto
    bgm_category: Optional[str] = None


def _cfg_dict(c: FeishuBitableSync) -> dict:
    return {
        "id": c.id, "name": c.name, "app_token": c.app_token, "table_id": c.table_id,
        "field_map": c.field_map or {},
        "default_ratio": c.default_ratio or "4:3",
        "default_style_prompt": c.default_style_prompt or "",
        "default_per_image_seconds": c.default_per_image_seconds or 7,
        "overlay_layout": c.overlay_layout or None,
        "cover_enabled": bool(c.cover_enabled if c.cover_enabled is not None else 1),
        "cover_layout": c.cover_layout or None,
        "voice_oss_keys": c.voice_oss_keys or [],
        "voice_mode": c.voice_mode or "custom",
        "bgm_category": c.bgm_category or "",
        "last_synced_at": c.last_synced_at.isoformat() if c.last_synced_at else None,
    }


def _apply_defaults(c: FeishuBitableSync, body: SyncConfigIn) -> None:
    """把 body 的默认样式字段写到配置对象(None 表示不改/用默认)。"""
    if body.default_ratio is not None:
        c.default_ratio = body.default_ratio or "4:3"
    if body.default_style_prompt is not None:
        c.default_style_prompt = body.default_style_prompt or ""
    if body.default_per_image_seconds is not None:
        c.default_per_image_seconds = max(2, min(60, int(body.default_per_image_seconds or 7)))
    if body.overlay_layout is not None:
        c.overlay_layout = body.overlay_layout or None
    if body.cover_enabled is not None:
        c.cover_enabled = 1 if body.cover_enabled else 0
    if body.cover_layout is not None:
        c.cover_layout = body.cover_layout or None
    if body.voice_oss_keys is not None:
        c.voice_oss_keys = [k for k in (body.voice_oss_keys or []) if k] or None
    if body.voice_mode is not None:
        c.voice_mode = body.voice_mode if body.voice_mode in ("custom", "male", "female", "auto") else None
    if body.bgm_category is not None:
        c.bgm_category = body.bgm_category if body.bgm_category in ("古风", "现代", "auto") else None


@router.get("/configs")
async def list_configs(user: User = Depends(require_novel_video)):
    async with session_scope() as s:
        rows = (await s.execute(
            select(FeishuBitableSync).where(FeishuBitableSync.user_id == user.id)
            .order_by(FeishuBitableSync.id.desc())
        )).scalars().all()
        return {"configs": [_cfg_dict(c) for c in rows]}


async def _normalize_ref(app_token_input: str, table_id_input: str) -> tuple[str, str]:
    """把用户填的 app_token(可能是 wiki/base 链接或纯 token)归一化成真实 app_token;
    若输入是链接且带 ?table=, 且用户没单独填 table_id, 则用链接里的 table_id。"""
    from . import client as feishu
    raw = (app_token_input or "").strip()
    tbl = (table_id_input or "").strip()
    token, tbl_from_url = feishu.parse_bitable_ref(raw)
    if not tbl and tbl_from_url:
        tbl = tbl_from_url
    # wiki 节点 → 真实 app_token(独立表则原样返回)
    app_token = await feishu.resolve_app_token(token)
    return app_token, tbl


@router.post("/configs")
async def create_config(body: SyncConfigIn, user: User = Depends(require_novel_video)):
    ref = body.app_token.strip() or _fixed_table_url()  # 前端不填则用固定制作表格链接
    fmap = body.field_map or dict(DEFAULT_FIELD_MAP)  # 不传则用制作表格固定映射
    for k in ("doc", "video", "title", "tags"):
        if not fmap.get(k):
            raise HTTPException(status_code=400, detail=f"字段映射缺少必填项: {k}")
    app_token, table_id = await _normalize_ref(ref, body.table_id)
    if not app_token or not table_id:
        raise HTTPException(status_code=400, detail="解析后 app_token / table_id 为空,请检查链接或单独填写 table_id")
    async with session_scope() as s:
        c = FeishuBitableSync(
            user_id=user.id, name=(body.name or "飞书自动化")[:100],
            app_token=app_token, table_id=table_id,
            field_map=fmap,
        )
        _apply_defaults(c, body)
        s.add(c); await s.flush()
        return _cfg_dict(c)


@router.put("/configs/{cfg_id}")
async def update_config(cfg_id: int, body: SyncConfigIn, user: User = Depends(require_novel_video)):
    ref = body.app_token.strip() or _fixed_table_url()
    app_token, table_id = await _normalize_ref(ref, body.table_id)
    if not app_token or not table_id:
        raise HTTPException(status_code=400, detail="解析后 app_token / table_id 为空,请检查链接或单独填写 table_id")
    fmap = body.field_map or dict(DEFAULT_FIELD_MAP)
    async with session_scope() as s:
        c = await s.get(FeishuBitableSync, cfg_id)
        if not c or c.user_id != user.id:
            raise HTTPException(status_code=404, detail="配置不存在")
        c.name = (body.name or "飞书自动化")[:100]
        c.app_token = app_token
        c.table_id = table_id
        c.field_map = fmap
        _apply_defaults(c, body)
        await s.flush()
        return _cfg_dict(c)


@router.delete("/configs/{cfg_id}")
async def delete_config(cfg_id: int, user: User = Depends(require_novel_video)):
    async with session_scope() as s:
        c = await s.get(FeishuBitableSync, cfg_id)
        if not c or c.user_id != user.id:
            raise HTTPException(status_code=404, detail="配置不存在")
        await s.delete(c)
    return {"ok": True}


@router.post("/configs/{cfg_id}/test")
async def test_config(cfg_id: int, user: User = Depends(require_novel_video)):
    """连通性测试: 取 token + 列出表字段, 便于用户核对字段名。"""
    async with session_scope() as s:
        c = await s.get(FeishuBitableSync, cfg_id)
        if not c or c.user_id != user.id:
            raise HTTPException(status_code=404, detail="配置不存在")
        app_token, table_id = c.app_token, c.table_id
    try:
        from . import client as feishu
        fields = await feishu.list_fields(app_token, table_id)
        names = [f.get("field_name") for f in fields]
        return {"ok": True, "field_names": names}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"连接飞书失败: {e}") from e


@router.post("/configs/{cfg_id}/sync")
async def sync(cfg_id: int, user: User = Depends(require_novel_video)):
    """扫描表 + 为所有未处理行批量入队(后台跑, 完成各自回写)。返回本次入队/跳过数。"""
    async with session_scope() as s:
        c = await s.get(FeishuBitableSync, cfg_id)
        if not c or c.user_id != user.id:
            raise HTTPException(status_code=404, detail="配置不存在")
    try:
        res = await feishu_service.sync_once(cfg_id)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"同步失败: {e}") from e
    return {"ok": True, **res}


@router.get("/configs/{cfg_id}/candidates")
async def candidates(cfg_id: int, user: User = Depends(require_novel_video)):
    """列出"未生成"的候选行(下载链接为空、有附件、且不在现有任务里)。供勾选同步。"""
    async with session_scope() as s:
        c = await s.get(FeishuBitableSync, cfg_id)
        if not c or c.user_id != user.id:
            raise HTTPException(status_code=404, detail="配置不存在")
    try:
        res = await feishu_service.list_candidate_rows(cfg_id)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"读取候选失败: {e}") from e
    return {"ok": True, **res}


class SyncSelectedBody(BaseModel):
    record_ids: list[str]


async def _bg_sync_selected(cfg_id: int, record_ids: list[str]) -> None:
    """后台执行选中行同步(拉记录/下载附件/生文案/建 job 都在这里, 不阻塞请求)。"""
    try:
        await feishu_service.sync_selected(cfg_id, record_ids)
    except Exception:  # noqa: BLE001
        logger.exception("后台同步选中行失败 cfg=%s", cfg_id)


@router.post("/configs/{cfg_id}/sync-selected")
async def sync_selected(cfg_id: int, body: SyncSelectedBody, user: User = Depends(require_novel_video)):
    """只对勾选的行建任务(下载/生文案/建 job 均在后台跑)。立即返回, 前端可马上关弹窗看任务列表。"""
    async with session_scope() as s:
        c = await s.get(FeishuBitableSync, cfg_id)
        if not c or c.user_id != user.id:
            raise HTTPException(status_code=404, detail="配置不存在")
    if not body.record_ids:
        raise HTTPException(status_code=400, detail="未勾选任何行")
    # 整段处理(含下载附件+LLM生文案, 较慢)丢后台, 不阻塞本次请求
    asyncio.create_task(_bg_sync_selected(cfg_id, list(body.record_ids)))
    return {"ok": True, "submitted": len(body.record_ids), "background": True}


@router.post("/configs/{cfg_id}/backfill-links")
async def backfill_links(cfg_id: int, user: User = Depends(require_novel_video)):
    """补写下载链接: 扫描全表,对'下载链接列为空且已有succeeded视频'的行补写链接/剧名/标签。
    只补空行,不覆盖已有下载链接的行。返回补写数/跳过数。"""
    async with session_scope() as s:
        c = await s.get(FeishuBitableSync, cfg_id)
        if not c or c.user_id != user.id:
            raise HTTPException(status_code=404, detail="配置不存在")
    try:
        res = await feishu_service.backfill_empty_links(cfg_id)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"补写失败: {e}") from e
    return {"ok": True, **res}


@router.get("/video/{job_id}")
async def video_redirect(job_id: int, t: str = Query(...)):
    """匿名: 校验签名 token → 现签 TOS 下载链接 → 302 跳转。写回飞书的永久链接就是这个。"""
    if not feishu_service.verify_video_token(job_id, t):
        raise HTTPException(status_code=403, detail="无效链接")
    async with session_scope() as s:
        job = await s.get(NovelVideoJob, job_id)
        if not job or not job.video_oss_key:
            raise HTTPException(status_code=404, detail="视频不存在或未完成")
        title = job.title or f"video{job_id}"
        key = job.video_oss_key
    import re as _re
    fname = _re.sub(r"[\\/:*?\"<>|\n\r]+", "_", title).strip()[:40] or "video"
    try:
        url = oss_client.sign_download_url(key, filename=f"{fname}.mp4", ttl_seconds=3600)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"生成下载链接失败: {e}") from e
    return RedirectResponse(url=url, status_code=302)