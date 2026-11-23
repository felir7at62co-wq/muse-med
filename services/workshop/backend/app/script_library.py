"""Finalized-script library: Muse uploads finished scripts as versions, everyone reads them, leads pick one.

Writing happens on each member's own computer in Muse. When a script is done, Muse asks the member and, on yes,
uploads it here as a new version of that script (an identical upload adds nothing). Every signed-in user can read
the library; users with the `script_pick` feature (admins by default) pick a version for production and record the
Jingliu project it became. A library reader opened on a first Muse sign-in (`muse_readers`) uploads only with the
`script_finalize` feature. A script keeps only its original's data-station work ID (`fanqie:…`, `hongguo:…`);
clients read the original's current numbers from the data station.
"""
from datetime import datetime
import hashlib
import json
import re
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import Column, DateTime, Integer, String, UniqueConstraint, or_, select
from sqlalchemy.dialects.postgresql import JSONB

from .auth import User, get_current_user
from .auth.dependencies import user_has_feature
from .db.models import Base
from .db.session import session_scope
from .muse_readers import FINALIZE_FEATURE, is_reader

router = APIRouter(prefix="/v1/script-library", tags=["script-library"])

PICK_FEATURE = "script_pick"
STATUSES = ("waiting", "picked", "in_production")
MAX_EPISODES = 300
MAX_EPISODE_CHARS = 60_000
MAX_TOTAL_CHARS = 3_000_000
ORIGIN = re.compile(r"^(?:hongguo|fanqie|qimao|douyin|lvpaopao):[0-9A-Za-z_-]{1,64}$")


class ScriptEntry(Base):
    """One finalized script and its library state; its text lives in versions."""
    __tablename__ = "script_library"

    id = Column(Integer, primary_key=True, index=True)
    owner_id = Column(Integer, nullable=False, index=True)
    title = Column(String(200), nullable=False)
    rights = Column(String(16), nullable=False)
    origin_work_id = Column(String(80))
    origin_title = Column(String(500))
    kind = Column(String(16), nullable=False)
    style = Column(String(16), nullable=False)
    episodes = Column(Integer, nullable=False)
    words = Column(Integer, nullable=False)
    status = Column(String(16), nullable=False, default="waiting", index=True)
    latest_version = Column(Integer, nullable=False)
    picked_by = Column(Integer)
    picked_version = Column(Integer)
    picked_at = Column(DateTime)
    project_id = Column(String(80))
    project_title = Column(String(200))
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class ScriptVersion(Base):
    """One uploaded text of a script; numbers start at 1 and never change."""
    __tablename__ = "script_library_versions"
    __table_args__ = (UniqueConstraint("entry_id", "number", name="uq_script_library_version"),)

    id = Column(Integer, primary_key=True, index=True)
    entry_id = Column(Integer, nullable=False, index=True)
    number = Column(Integer, nullable=False)
    content = Column(JSONB, nullable=False)
    words = Column(Integer, nullable=False)
    sha256 = Column(String(64), nullable=False)
    session_ref = Column(String(120))
    created_by = Column(Integer, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class Episode(BaseModel):
    order: int = Field(ge=1, le=MAX_EPISODES)
    title: str = Field(default="", max_length=200)
    content: str = Field(min_length=1, max_length=MAX_EPISODE_CHARS)


class FinalizeBody(BaseModel):
    entry_id: Optional[int] = Field(default=None, ge=1)
    title: str = Field(min_length=1, max_length=200)
    rights: Literal["original", "licensed"]
    origin_work_id: Optional[str] = Field(default=None, max_length=80)
    origin_title: Optional[str] = Field(default=None, max_length=500)
    kind: Literal["drama", "narration"]
    style: Literal["realistic", "3d"]
    episodes: list[Episode] = Field(min_length=1, max_length=MAX_EPISODES)
    session_ref: Optional[str] = Field(default=None, max_length=120)

    @field_validator("title")
    @classmethod
    def _title(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("title is empty")
        return value

    @field_validator("origin_work_id")
    @classmethod
    def _origin(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not ORIGIN.fullmatch(value):
            raise ValueError("origin_work_id must be a data-station work ID")
        return value

    @field_validator("episodes")
    @classmethod
    def _episodes(cls, value: list[Episode]) -> list[Episode]:
        orders = [episode.order for episode in value]
        if len(set(orders)) != len(orders):
            raise ValueError("episode orders repeat")
        if sum(len(episode.content) for episode in value) > MAX_TOTAL_CHARS:
            raise ValueError("script is too long")
        return sorted(value, key=lambda episode: episode.order)


class PickBody(BaseModel):
    version: int = Field(ge=1)


class ProductionBody(BaseModel):
    project_id: str = Field(min_length=1, max_length=80)
    project_title: str = Field(min_length=1, max_length=200)


def _words(episodes: list[Episode]) -> int:
    return sum(len(re.sub(r"\s+", "", episode.content)) for episode in episodes)


def _digest(episodes: list[Episode]) -> str:
    canonical = json.dumps([episode.model_dump() for episode in episodes], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _name(user: Optional[User]) -> Optional[str]:
    return None if user is None else (user.display_name or user.username)


def _time(value: Optional[datetime]) -> Optional[str]:
    return None if value is None else value.isoformat()


async def _names(session, ids) -> dict[int, str]:
    ids = {value for value in ids if value is not None}
    if not ids:
        return {}
    rows = (await session.execute(select(User).where(User.id.in_(ids)))).scalars().all()
    return {row.id: _name(row) for row in rows}


def _summary(entry: ScriptEntry, names: dict[int, str]) -> dict:
    return {
        "id": entry.id, "title": entry.title, "owner": {"id": entry.owner_id, "name": names.get(entry.owner_id)},
        "rights": entry.rights, "origin_work_id": entry.origin_work_id, "origin_title": entry.origin_title,
        "kind": entry.kind, "style": entry.style, "episodes": entry.episodes, "words": entry.words,
        "status": entry.status, "latest_version": entry.latest_version,
        "picked": None if entry.picked_by is None else {
            "by": {"id": entry.picked_by, "name": names.get(entry.picked_by)}, "version": entry.picked_version, "at": _time(entry.picked_at)},
        "project": None if entry.project_id is None else {"id": entry.project_id, "title": entry.project_title},
        "created_at": _time(entry.created_at), "updated_at": _time(entry.updated_at),
    }


async def _entry(session, entry_id: int, lock: bool = False) -> ScriptEntry:
    query = select(ScriptEntry).where(ScriptEntry.id == entry_id)
    if lock:
        query = query.with_for_update()
    entry = (await session.execute(query)).scalar_one_or_none()
    if entry is None:
        raise HTTPException(404, "剧本不存在")
    return entry


def _require_pick(user: User) -> None:
    if not user_has_feature(user, PICK_FEATURE):
        raise HTTPException(403, "只有组长可以选用剧本")


def _require_finalize(user: User) -> None:
    if is_reader(user) and not user_has_feature(user, FINALIZE_FEATURE):
        raise HTTPException(403, "只读账号不能上传定稿，请联系管理员开通")


async def finalize_in_session(session, body: FinalizeBody, user: User):
    """Save a library version in the caller’s transaction and return its summary."""
    _require_finalize(user)
    digest = _digest(body.episodes)
    words = _words(body.episodes)
    if body.entry_id is None:
        now = datetime.utcnow()
        entry = ScriptEntry(owner_id=user.id, status="waiting", latest_version=0, episodes=0, words=0, created_at=now, updated_at=now,
                            title=body.title, rights=body.rights, kind=body.kind, style=body.style)
        session.add(entry)
        await session.flush()
        latest = None
    else:
        entry = await _entry(session, body.entry_id, lock=True)
        if entry.owner_id != user.id and user.role not in ("admin", "superadmin"):
            raise HTTPException(403, "只能给自己的剧本上传新版本")
        latest = (await session.execute(select(ScriptVersion).where(
            ScriptVersion.entry_id == entry.id, ScriptVersion.number == entry.latest_version))).scalar_one_or_none()
    created = latest is None or latest.sha256 != digest
    if created:
        number = entry.latest_version + 1
        session.add(ScriptVersion(entry_id=entry.id, number=number, words=words, sha256=digest, created_by=user.id, created_at=datetime.utcnow(),
                                  session_ref=body.session_ref, content=[episode.model_dump() for episode in body.episodes]))
        entry.latest_version = number
        entry.episodes = len(body.episodes)
        entry.words = words
    entry.title = body.title
    entry.rights = body.rights
    entry.origin_work_id = body.origin_work_id
    entry.origin_title = body.origin_title if body.origin_work_id is not None else None
    entry.kind = body.kind
    entry.style = body.style
    entry.updated_at = datetime.utcnow()
    names = await _names(session, [entry.owner_id, entry.picked_by])
    return {"created": created, "version": entry.latest_version, "script": _summary(entry, names)}


@router.post("")
async def finalize(body: FinalizeBody, user: User = Depends(get_current_user)):
    """Publish a new library entry or a new version of the caller’s script."""
    async with session_scope() as session:
        return await finalize_in_session(session, body, user)


@router.get("")
async def list_scripts(status: Optional[Literal["waiting", "picked", "in_production"]] = None, q: Optional[str] = Query(None, max_length=100),
                       mine: bool = False, page: int = Query(1, ge=1), limit: int = Query(30, ge=1, le=100),
                       user: User = Depends(get_current_user)):
    """Every finalized script, newest first, with counts per status for the same search."""
    async with session_scope() as session:
        base = select(ScriptEntry)
        term = (q or "").strip()
        if term:
            base = base.where(or_(ScriptEntry.title.ilike(f"%{term}%"), ScriptEntry.origin_title.ilike(f"%{term}%")))
        if mine:
            base = base.where(ScriptEntry.owner_id == user.id)
        rows = (await session.execute(base.order_by(ScriptEntry.updated_at.desc(), ScriptEntry.id.desc()))).scalars().all()
        counts = {name: sum(1 for row in rows if row.status == name) for name in STATUSES}
        counts["all"] = len(rows)
        shown = [row for row in rows if status is None or row.status == status]
        page_rows = shown[(page - 1) * limit:page * limit]
        names = await _names(session, [value for row in page_rows for value in (row.owner_id, row.picked_by)])
        return {"items": [_summary(row, names) for row in page_rows], "total": len(shown), "page": page, "limit": limit,
                "counts": counts, "can_pick": user_has_feature(user, PICK_FEATURE)}


@router.get("/{entry_id}")
async def read_script(entry_id: int, version: Optional[int] = Query(None, ge=1), user: User = Depends(get_current_user)):
    """One script with its version list and the text of one version (the latest unless named)."""
    async with session_scope() as session:
        entry = await _entry(session, entry_id)
        versions = (await session.execute(select(ScriptVersion).where(ScriptVersion.entry_id == entry.id)
                                          .order_by(ScriptVersion.number.desc()))).scalars().all()
        chosen = next((row for row in versions if row.number == (version or entry.latest_version)), None)
        if chosen is None:
            raise HTTPException(404, "这个版本不存在")
        names = await _names(session, [entry.owner_id, entry.picked_by, *[row.created_by for row in versions]])
        return {
            "script": _summary(entry, names), "can_pick": user_has_feature(user, PICK_FEATURE),
            "versions": [{"number": row.number, "words": row.words, "created_at": _time(row.created_at),
                          "by": {"id": row.created_by, "name": names.get(row.created_by)}} for row in versions],
            "content": {"version": chosen.number, "episodes": chosen.content},
        }


@router.post("/{entry_id}/pick")
async def pick(entry_id: int, body: PickBody, user: User = Depends(get_current_user)):
    """组长选用 one version; a script already in production keeps its pick."""
    _require_pick(user)
    async with session_scope() as session:
        entry = await _entry(session, entry_id, lock=True)
        if entry.status == "in_production":
            raise HTTPException(409, "这部剧本已投产")
        exists = (await session.execute(select(ScriptVersion.id).where(
            ScriptVersion.entry_id == entry.id, ScriptVersion.number == body.version))).scalar_one_or_none()
        if exists is None:
            raise HTTPException(404, "这个版本不存在")
        entry.status = "picked"
        entry.picked_by = user.id
        entry.picked_version = body.version
        entry.picked_at = datetime.utcnow()
        entry.updated_at = entry.picked_at
        await session.commit()
        names = await _names(session, [entry.owner_id, entry.picked_by])
        return {"script": _summary(entry, names)}


@router.post("/{entry_id}/production")
async def production(entry_id: int, body: ProductionBody, user: User = Depends(get_current_user)):
    """Record the Jingliu project a picked script became."""
    _require_pick(user)
    async with session_scope() as session:
        entry = await _entry(session, entry_id, lock=True)
        if entry.status == "waiting":
            raise HTTPException(409, "先选用再投产")
        entry.status = "in_production"
        entry.project_id = body.project_id
        entry.project_title = body.project_title
        entry.updated_at = datetime.utcnow()
        await session.commit()
        names = await _names(session, [entry.owner_id, entry.picked_by])
        return {"script": _summary(entry, names)}
