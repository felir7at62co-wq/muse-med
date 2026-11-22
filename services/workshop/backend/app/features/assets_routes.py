"""Admin资产库管理API: characters/worlds/snippets CRUD"""
import logging
from typing import Any
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from sqlalchemy import text

from ..db import session_scope
from ..auth import require_admin, User

router = APIRouter(prefix="/v1/admin-api/assets", tags=["admin-assets"])
logger = logging.getLogger("admin-assets")


# ============ 角色卡 ============

class CharacterIn(BaseModel):
    name: str
    avatar_url: str | None = None
    background: str | None = None
    personality: str | None = None
    appearance: str | None = None
    tags: list[str] = []
    is_public: bool = True


@router.get("/characters")
async def list_characters(admin: User = Depends(require_admin)):
    async with session_scope() as s:
        rows = (await s.execute(
            text("""SELECT c.*, u.username as creator_name FROM characters c
                    LEFT JOIN users u ON u.id = c.created_by
                    ORDER BY c.id DESC""")
        )).mappings().all()
        return [dict(r) for r in rows]


@router.post("/characters")
async def create_character(payload: CharacterIn, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        result = await s.execute(
            text("""INSERT INTO characters (name, avatar_url, background, personality, appearance, tags, is_public, created_by)
                    VALUES (:name, :avatar, :bg, :pers, :app, :tags, :pub, :uid)
                    RETURNING id"""),
            {"name": payload.name, "avatar": payload.avatar_url, "bg": payload.background,
             "pers": payload.personality, "app": payload.appearance, "tags": payload.tags,
             "pub": payload.is_public, "uid": admin.id}
        )
        return {"ok": True, "id": result.scalar_one()}


@router.patch("/characters/{cid}")
async def update_character(cid: int, payload: CharacterIn, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        await s.execute(
            text("""UPDATE characters SET name=:name, avatar_url=:avatar, background=:bg,
                    personality=:pers, appearance=:app, tags=:tags, is_public=:pub, updated_at=NOW()
                    WHERE id=:id"""),
            {"id": cid, "name": payload.name, "avatar": payload.avatar_url, "bg": payload.background,
             "pers": payload.personality, "app": payload.appearance, "tags": payload.tags,
             "pub": payload.is_public}
        )
        return {"ok": True}


@router.delete("/characters/{cid}")
async def delete_character(cid: int, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        await s.execute(text("DELETE FROM characters WHERE id=:id"), {"id": cid})
        return {"ok": True}


# ============ 世界观 ============

class WorldIn(BaseModel):
    name: str
    era: str | None = None
    location: str | None = None
    setting: str | None = None
    rules: str | None = None
    tags: list[str] = []
    is_public: bool = True


@router.get("/worlds")
async def list_worlds(admin: User = Depends(require_admin)):
    async with session_scope() as s:
        rows = (await s.execute(
            text("""SELECT w.*, u.username as creator_name FROM worlds w
                    LEFT JOIN users u ON u.id = w.created_by
                    ORDER BY w.id DESC""")
        )).mappings().all()
        return [dict(r) for r in rows]


@router.post("/worlds")
async def create_world(payload: WorldIn, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        result = await s.execute(
            text("""INSERT INTO worlds (name, era, location, setting, rules, tags, is_public, created_by)
                    VALUES (:name, :era, :loc, :st, :ru, :tags, :pub, :uid)
                    RETURNING id"""),
            {"name": payload.name, "era": payload.era, "loc": payload.location, "st": payload.setting,
             "ru": payload.rules, "tags": payload.tags, "pub": payload.is_public, "uid": admin.id}
        )
        return {"ok": True, "id": result.scalar_one()}


@router.patch("/worlds/{wid}")
async def update_world(wid: int, payload: WorldIn, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        await s.execute(
            text("""UPDATE worlds SET name=:name, era=:era, location=:loc, setting=:st,
                    rules=:ru, tags=:tags, is_public=:pub, updated_at=NOW()
                    WHERE id=:id"""),
            {"id": wid, "name": payload.name, "era": payload.era, "loc": payload.location,
             "st": payload.setting, "ru": payload.rules, "tags": payload.tags, "pub": payload.is_public}
        )
        return {"ok": True}


@router.delete("/worlds/{wid}")
async def delete_world(wid: int, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        await s.execute(text("DELETE FROM worlds WHERE id=:id"), {"id": wid})
        return {"ok": True}


# ============ 素材库(admin端CRUD) ============

class SnippetIn(BaseModel):
    title: str | None = None
    category: str = "台词"
    content: str
    tags: list[str] = []
    is_public: bool = True


@router.get("/snippets")
async def admin_list_snippets(category: str | None = Query(None), admin: User = Depends(require_admin)):
    async with session_scope() as s:
        where = ""
        params: dict[str, Any] = {}
        if category:
            where = "WHERE category=:cat"
            params["cat"] = category
        rows = (await s.execute(
            text(f"""SELECT sn.*, u.username as creator_name,
                     d.title as source_draft_title
                     FROM snippets sn
                     LEFT JOIN users u ON u.id = sn.created_by
                     LEFT JOIN script_drafts d ON d.id = sn.source_draft_id
                     {where}
                     ORDER BY sn.id DESC LIMIT 500"""),
            params
        )).mappings().all()
        return [dict(r) for r in rows]


@router.post("/snippets")
async def admin_create_snippet(payload: SnippetIn, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        result = await s.execute(
            text("""INSERT INTO snippets (title, category, content, tags, is_public, created_by)
                    VALUES (:t, :c, :ct, :tg, :p, :uid) RETURNING id"""),
            {"t": payload.title, "c": payload.category, "ct": payload.content,
             "tg": payload.tags, "p": payload.is_public, "uid": admin.id}
        )
        return {"ok": True, "id": result.scalar_one()}


@router.patch("/snippets/{sid}")
async def admin_update_snippet(sid: int, payload: SnippetIn, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        await s.execute(
            text("""UPDATE snippets SET title=:t, category=:c, content=:ct, tags=:tg, is_public=:p
                    WHERE id=:id"""),
            {"id": sid, "t": payload.title, "c": payload.category, "ct": payload.content,
             "tg": payload.tags, "p": payload.is_public}
        )
        return {"ok": True}


@router.delete("/snippets/{sid}")
async def admin_delete_snippet(sid: int, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        await s.execute(text("DELETE FROM snippets WHERE id=:id"), {"id": sid})
        return {"ok": True}


# ============ 资产总览 ============

@router.get("/overview")
async def assets_overview(admin: User = Depends(require_admin)):
    async with session_scope() as s:
        char_total = (await s.execute(text("SELECT COUNT(*) FROM characters"))).scalar_one()
        world_total = (await s.execute(text("SELECT COUNT(*) FROM worlds"))).scalar_one()
        snip_total = (await s.execute(text("SELECT COUNT(*) FROM snippets"))).scalar_one()
        char_public = (await s.execute(text("SELECT COUNT(*) FROM characters WHERE is_public=true"))).scalar_one()
        world_public = (await s.execute(text("SELECT COUNT(*) FROM worlds WHERE is_public=true"))).scalar_one()
        snip_public = (await s.execute(text("SELECT COUNT(*) FROM snippets WHERE is_public=true"))).scalar_one()
        return {
            "characters": {"total": char_total, "public": char_public},
            "worlds": {"total": world_total, "public": world_public},
            "snippets": {"total": snip_total, "public": snip_public},
        }
