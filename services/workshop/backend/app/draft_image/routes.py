"""草稿生图版块 路由 (prefix /v1)。

每集模式配置 + 任务卡列表/发起/重生 + 角色垫图 CRUD。
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..auth import get_current_user, User
from ..db import session_scope
from ..db.models import ScriptDraft, ScriptVideoPrompt
from ..oss import client as oss_client
from . import service
from .models import (
    DraftCharacter,
    DraftCharacterImage,
    DraftEpisodeImageConfig,
    DraftImageTask,
)

logger = logging.getLogger("draft_image.routes")
router = APIRouter(prefix="/v1", tags=["draft_image"])

ALLOWED_MODELS = {"gpt-image-2", "gemini-3-pro-image-preview", "gemini-3.1-flash-image"}
ALLOWED_MODES = {"none", "single", "grid9"}


# ============================================================
# 权限
# ============================================================

async def _check_draft_owner(draft_id: int, user: User) -> ScriptDraft:
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise HTTPException(404, "draft not found")
        if user.role not in ("admin", "superadmin") and d.user_id != user.id:
            raise HTTPException(403, "无权访问此草稿")
        return d


def _sign(key: Optional[str]) -> Optional[str]:
    if not key:
        return None
    try:
        return oss_client.sign_get_url(key, ttl_seconds=3600)
    except Exception:  # noqa: BLE001
        return None


# ============================================================
# 概览: 按集列出 prompts 数 + 模式 + 任务卡
# ============================================================

@router.get("/drafts/{draft_id}/image-tasks")
async def list_image_tasks(draft_id: int, user: User = Depends(get_current_user)):
    await _check_draft_owner(draft_id, user)
    async with session_scope() as s:
        # 各集 prompt 数 (有 image_prompt 的)
        prows = (await s.execute(
            select(ScriptVideoPrompt).where(ScriptVideoPrompt.draft_id == draft_id)
            .order_by(ScriptVideoPrompt.chapter_order, ScriptVideoPrompt.task_index)
        )).scalars().all()
        configs = (await s.execute(
            select(DraftEpisodeImageConfig).where(DraftEpisodeImageConfig.draft_id == draft_id)
        )).scalars().all()
        tasks = (await s.execute(
            select(DraftImageTask).where(DraftImageTask.draft_id == draft_id)
            .order_by(DraftImageTask.chapter_order, DraftImageTask.group_index)
        )).scalars().all()

    cfg_by_ch = {c.chapter_order: c.mode for c in configs}
    # 每集 prompt 统计
    ep_prompt_count: dict[int, int] = {}
    ep_image_prompt_count: dict[int, int] = {}
    for r in prows:
        ep_prompt_count[r.chapter_order] = ep_prompt_count.get(r.chapter_order, 0) + 1
        if (r.image_prompt or "").strip():
            ep_image_prompt_count[r.chapter_order] = ep_image_prompt_count.get(r.chapter_order, 0) + 1

    tasks_by_ch: dict[int, list[dict]] = {}
    for t in tasks:
        tasks_by_ch.setdefault(t.chapter_order, []).append({
            "id": t.id,
            "mode": t.mode,
            "group_index": t.group_index,
            "shot_indexes": list(t.shot_indexes or []),
            "status": t.status,
            "progress": t.progress,
            "error": t.error,
            "model": t.model,
            "size": t.size,
            "ref_urls": [u for u in (_sign(k) for k in (t.ref_image_keys or [])) if u],
            "result_urls": [u for u in (_sign(k) for k in (t.result_keys or [])) if u],
        })

    chapters = sorted(set(list(ep_prompt_count.keys()) + list(cfg_by_ch.keys())))
    episodes = []
    for ch in chapters:
        episodes.append({
            "chapter_order": ch,
            "mode": cfg_by_ch.get(ch, "single"),
            "prompt_count": ep_prompt_count.get(ch, 0),
            "image_prompt_count": ep_image_prompt_count.get(ch, 0),
            "tasks": tasks_by_ch.get(ch, []),
        })

    running = any(t.status in ("pending", "running") for t in tasks)
    return {"episodes": episodes, "running": running}


# ============================================================
# 每集模式配置
# ============================================================

class EpisodeModeIn(BaseModel):
    chapter_order: int
    mode: str = Field(..., pattern="^(none|single|grid9)$")


class SetConfigIn(BaseModel):
    items: list[EpisodeModeIn]


@router.put("/drafts/{draft_id}/image-config")
async def set_image_config(draft_id: int, payload: SetConfigIn, user: User = Depends(get_current_user)):
    await _check_draft_owner(draft_id, user)
    async with session_scope() as s:
        existing = (await s.execute(
            select(DraftEpisodeImageConfig).where(DraftEpisodeImageConfig.draft_id == draft_id)
        )).scalars().all()
        by_ch = {c.chapter_order: c for c in existing}
        for it in payload.items:
            if it.mode not in ALLOWED_MODES:
                continue
            row = by_ch.get(it.chapter_order)
            if row:
                row.mode = it.mode
            else:
                s.add(DraftEpisodeImageConfig(
                    draft_id=draft_id, chapter_order=it.chapter_order, mode=it.mode,
                ))
    return {"ok": True}


# ============================================================
# 发起生图 (按集重建任务卡 + 跑)
# ============================================================

class RunIn(BaseModel):
    chapter_orders: Optional[list[int]] = None  # null=全部已配置集
    model: str = "gpt-image-2"
    size: str = "2048x2048"  # single 用; grid9 内部强制正方形


@router.post("/drafts/{draft_id}/image-tasks/run")
async def run_image_tasks(draft_id: int, payload: RunIn, user: User = Depends(get_current_user)):
    d = await _check_draft_owner(draft_id, user)
    if payload.model not in ALLOWED_MODELS:
        raise HTTPException(400, f"unsupported model (allowed: {sorted(ALLOWED_MODELS)})")

    # 决定要处理哪些集 + 其模式
    async with session_scope() as s:
        configs = (await s.execute(
            select(DraftEpisodeImageConfig).where(DraftEpisodeImageConfig.draft_id == draft_id)
        )).scalars().all()
        cfg_by_ch = {c.chapter_order: c.mode for c in configs}
        # 草稿里所有有 prompt 的集 (默认 single)
        chs = (await s.execute(
            select(ScriptVideoPrompt.chapter_order).where(
                ScriptVideoPrompt.draft_id == draft_id
            ).distinct()
        )).scalars().all()
    all_chs = sorted(set(list(chs)))
    target = payload.chapter_orders if payload.chapter_orders else all_chs

    all_task_ids: list[int] = []
    built_summary: list[dict] = []
    for ch in target:
        mode = cfg_by_ch.get(ch, "single")
        if mode == "none":
            built_summary.append({"chapter_order": ch, "mode": mode, "tasks": 0})
            # 仍清掉旧卡
            await service.build_tasks_for_episode(
                draft_id=draft_id, user_id=d.user_id, chapter_order=ch,
                mode="none", model=payload.model, size=payload.size,
            )
            continue
        ids = await service.build_tasks_for_episode(
            draft_id=draft_id, user_id=d.user_id, chapter_order=ch,
            mode=mode, model=payload.model, size=payload.size,
        )
        all_task_ids.extend(ids)
        built_summary.append({"chapter_order": ch, "mode": mode, "tasks": len(ids)})

    service.kick_off(all_task_ids)
    return {
        "ok": True,
        "started": len(all_task_ids),
        "episodes": built_summary,
        "message": f"已发起 {len(all_task_ids)} 张生图任务",
    }


@router.post("/drafts/{draft_id}/image-tasks/{task_id}/regenerate")
async def regenerate_task(draft_id: int, task_id: int, user: User = Depends(get_current_user)):
    await _check_draft_owner(draft_id, user)
    async with session_scope() as s:
        t = await s.get(DraftImageTask, task_id)
        if not t or t.draft_id != draft_id:
            raise HTTPException(404, "task not found")
        t.status = "pending"
        t.progress = 0
        t.error = None
        t.result_keys = None
    service.kick_off([task_id])
    return {"ok": True}


@router.delete("/drafts/{draft_id}/image-tasks/{task_id}")
async def delete_task(draft_id: int, task_id: int, user: User = Depends(get_current_user)):
    await _check_draft_owner(draft_id, user)
    async with session_scope() as s:
        t = await s.get(DraftImageTask, task_id)
        if not t or t.draft_id != draft_id:
            raise HTTPException(404, "task not found")
        await s.delete(t)
    return {"ok": True}


# ============================================================
# 角色垫图
# ============================================================

@router.get("/drafts/{draft_id}/characters-image")
async def list_characters(draft_id: int, user: User = Depends(get_current_user)):
    await _check_draft_owner(draft_id, user)
    async with session_scope() as s:
        chars = (await s.execute(
            select(DraftCharacter).where(DraftCharacter.draft_id == draft_id)
            .order_by(DraftCharacter.id)
        )).scalars().all()
        char_ids = [c.id for c in chars]
        imgs_by_char: dict[int, list] = {cid: [] for cid in char_ids}
        if char_ids:
            imgs = (await s.execute(
                select(DraftCharacterImage).where(DraftCharacterImage.character_id.in_(char_ids))
                .order_by(DraftCharacterImage.seq, DraftCharacterImage.id)
            )).scalars().all()
            for im in imgs:
                imgs_by_char.setdefault(im.character_id, []).append(im)
    return {
        "characters": [
            {
                "id": c.id,
                "name": c.name,
                "images": [
                    {
                        "id": im.id,
                        "url": _sign(im.oss_key),
                        "episodes": list(im.episodes or []),
                        "seq": im.seq,
                    }
                    for im in imgs_by_char.get(c.id, [])
                ],
            }
            for c in chars
        ]
    }


class CharacterIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)


@router.post("/drafts/{draft_id}/characters-image")
async def create_character(draft_id: int, payload: CharacterIn, user: User = Depends(get_current_user)):
    await _check_draft_owner(draft_id, user)
    async with session_scope() as s:
        c = DraftCharacter(draft_id=draft_id, name=payload.name.strip())
        s.add(c)
        await s.flush()
        return {"id": c.id, "name": c.name}


@router.delete("/drafts/{draft_id}/characters-image/{char_id}")
async def delete_character(draft_id: int, char_id: int, user: User = Depends(get_current_user)):
    await _check_draft_owner(draft_id, user)
    async with session_scope() as s:
        c = await s.get(DraftCharacter, char_id)
        if not c or c.draft_id != draft_id:
            raise HTTPException(404, "character not found")
        imgs = (await s.execute(
            select(DraftCharacterImage).where(DraftCharacterImage.character_id == char_id)
        )).scalars().all()
        for im in imgs:
            await s.delete(im)
        await s.delete(c)
    return {"ok": True}


@router.post("/drafts/{draft_id}/characters-image/{char_id}/images")
async def upload_character_image(
    draft_id: int,
    char_id: int,
    file: UploadFile = File(...),
    episodes: str = Form(""),  # 逗号分隔集号; 空=全集
    user: User = Depends(get_current_user),
):
    await _check_draft_owner(draft_id, user)
    async with session_scope() as s:
        c = await s.get(DraftCharacter, char_id)
        if not c or c.draft_id != draft_id:
            raise HTTPException(404, "character not found")

    raw = await file.read()
    if not raw:
        raise HTTPException(400, "empty file")
    if len(raw) > 15 * 1024 * 1024:
        raise HTTPException(400, "形象图过大 (>15MB)")

    eps: list[int] = []
    for tok in (episodes or "").split(","):
        tok = tok.strip()
        if tok.isdigit():
            eps.append(int(tok))

    key = oss_client.build_oss_key(
        user_id=user.id, filename=file.filename or "char.png", namespace="draft-character",
    )
    try:
        await oss_client.put_object_async(key, raw)
    except Exception as e:  # noqa: BLE001
        logger.exception("upload character image failed")
        raise HTTPException(500, f"OSS 上传失败: {e}")

    async with session_scope() as s:
        im = DraftCharacterImage(
            character_id=char_id, oss_key=key, episodes=eps or None, seq=0,
        )
        s.add(im)
        await s.flush()
        return {"id": im.id, "url": _sign(key), "episodes": eps}


class CharImagePatchIn(BaseModel):
    episodes: list[int] = []


@router.patch("/drafts/{draft_id}/characters-image/images/{image_id}")
async def patch_character_image(
    draft_id: int, image_id: int, payload: CharImagePatchIn,
    user: User = Depends(get_current_user),
):
    await _check_draft_owner(draft_id, user)
    async with session_scope() as s:
        im = await s.get(DraftCharacterImage, image_id)
        if not im:
            raise HTTPException(404, "image not found")
        c = await s.get(DraftCharacter, im.character_id)
        if not c or c.draft_id != draft_id:
            raise HTTPException(404, "image not found")
        im.episodes = payload.episodes or None
    return {"ok": True}


@router.delete("/drafts/{draft_id}/characters-image/images/{image_id}")
async def delete_character_image(
    draft_id: int, image_id: int, user: User = Depends(get_current_user),
):
    await _check_draft_owner(draft_id, user)
    async with session_scope() as s:
        im = await s.get(DraftCharacterImage, image_id)
        if not im:
            raise HTTPException(404, "image not found")
        c = await s.get(DraftCharacter, im.character_id)
        if not c or c.draft_id != draft_id:
            raise HTTPException(404, "image not found")
        await s.delete(im)
    return {"ok": True}