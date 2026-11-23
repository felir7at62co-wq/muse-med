"""Publish and revise existing Workshop text episodes through the Muse editor."""

from datetime import datetime, timezone
import hashlib
import json
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import func, select, update
from sqlalchemy.engine import Row
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import User, get_current_user
from .db.models import ScriptChapter, ScriptDraft, ScriptEditorCandidate, ScriptEditorPublication, ScriptStoryboard
from .db.session import session_scope
from .script_library import MAX_EPISODES, MAX_EPISODE_CHARS, MAX_TOTAL_CHARS, FinalizeBody, finalize_in_session
from .stages.access import check_draft_access, is_admin_role
from .stages.candidate_store import snapshot_in

router = APIRouter(prefix="/v1/script-editor", tags=["script-editor"])

DraftId = Annotated[int, Path(ge=1)]
EpisodeNumber = Annotated[int, Path(ge=1)]
Revision = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
_EDITOR_CONTEXT_CHARS = 24_000


class EditBody(BaseModel):
    """Save one full episode based on its last read revision."""

    model_config = ConfigDict(extra="forbid")

    base_revision: Revision = Field(alias="baseRevision")
    content: str = Field(min_length=1, max_length=MAX_EPISODE_CHARS)

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        if not value.strip() or "\x00" in value:
            raise ValueError("content is blank or contains a NUL")
        return value


class StageBody(EditBody):
    """Stage one candidate and a short description without changing the current draft."""

    summary: str = Field(min_length=1, max_length=1000)

    @field_validator("summary")
    @classmethod
    def validate_summary(cls, value: str) -> str:
        value = value.strip()
        if not value or "\x00" in value:
            raise ValueError("summary is blank or contains a NUL")
        return value


class CandidateBody(BaseModel):
    """Identify the exact candidate reviewed by the editor."""

    model_config = ConfigDict(extra="forbid")

    candidate_id: UUID = Field(alias="candidateId")


class FinalizeDraftBody(BaseModel):
    """Accept the exact saved draft and its library metadata for publication."""

    model_config = ConfigDict(extra="forbid")

    base_revision: Revision = Field(alias="baseRevision")
    rights: Literal["original", "licensed"]
    kind: Literal["drama", "narration"]
    style: Literal["realistic", "3d"]
    origin_work_id: str | None = Field(default=None, max_length=80, alias="originWorkId")
    origin_title: str | None = Field(default=None, max_length=500, alias="originTitle")


def _fail(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, {"code": code, "message": message})


def _timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    return (value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()


def _hash(values: list) -> str:
    serialized = json.dumps(values, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _episode_revision(row: ScriptChapter) -> str:
    return _hash([row.draft_id, row.chapter_order, row.id, row.version, _timestamp(row.updated_at), row.title, row.full_text])


def _draft_revision(draft: ScriptDraft, rows: list[ScriptChapter]) -> str:
    return _hash([draft.id, draft.title, draft.episode_count, [_episode_revision(row) for row in rows]])


def _draft_item(draft: ScriptDraft | Row) -> dict:
    return {
        "id": draft.id,
        "title": draft.title or "",
        "status": draft.status or "",
        "episodeCount": draft.episode_count or 0,
        "updatedAt": _timestamp(draft.updated_at),
    }


def _bounded_object(value: object, keys: tuple[str, ...]) -> dict | None:
    if not isinstance(value, dict) or not value:
        return None
    result = {}
    budget = _EDITOR_CONTEXT_CHARS
    for key in keys:
        if key not in value:
            continue
        size = len(json.dumps(value[key], ensure_ascii=False)) + len(key)
        if size <= budget:
            result[key] = value[key]
            budget -= size
    return result or None


def _can_finalize(draft: ScriptDraft, rows: list[ScriptChapter], user: User) -> bool:
    total = draft.episode_count or 0
    return (
        draft.user_id == user.id
        and 0 < len((draft.title or "").strip()) <= 200
        and 0 < total <= MAX_EPISODES
        and [row.chapter_order for row in rows] == list(range(1, total + 1))
        and all(0 < len((row.full_text or "").strip()) <= MAX_EPISODE_CHARS
                and len(row.full_text or "") <= MAX_EPISODE_CHARS for row in rows)
        and all(len(row.title or "") <= 200 for row in rows)
        and sum(len(row.full_text or "") for row in rows) <= MAX_TOTAL_CHARS
    )


def _candidate_item(candidate: ScriptEditorCandidate | None) -> dict | None:
    if candidate is None:
        return None
    return {
        "id": candidate.id,
        "baseRevision": candidate.base_revision,
        "content": candidate.content,
        "summary": candidate.summary,
        "createdAt": _timestamp(candidate.created_at),
    }


def _episode_item(row: ScriptChapter, candidate: ScriptEditorCandidate | None) -> dict:
    return {
        "draftId": row.draft_id,
        "episode": row.chapter_order,
        "title": row.title or "",
        "content": row.full_text or "",
        "revision": _episode_revision(row),
        "version": row.version or 1,
        "candidate": _candidate_item(candidate),
    }


async def _draft(session: AsyncSession, draft_id: int, user: User, *, lock: bool = False) -> ScriptDraft:
    draft = await check_draft_access(session, draft_id, user, lock=lock)
    if draft.is_deleted is not False:
        raise _fail(404, "SCRIPT_EDITOR_DRAFT_MISSING", "草稿不存在。")
    return draft


async def _chapters(session: AsyncSession, draft_id: int, *, episode: int | None = None, lock: bool = False) -> list[ScriptChapter]:
    statement = select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
    if episode is not None:
        statement = statement.where(ScriptChapter.chapter_order == episode)
    statement = statement.order_by(ScriptChapter.chapter_order, ScriptChapter.id)
    if lock:
        statement = statement.with_for_update()
    rows = list((await session.scalars(statement)).all())
    orders = [row.chapter_order for row in rows]
    if len(orders) != len(set(orders)) or any(not order or order < 1 for order in orders):
        raise _fail(409, "SCRIPT_EDITOR_INVALID_EPISODES", "草稿存在重复或无效的集号，需要先修正集号。")
    return rows


async def _episode(session: AsyncSession, draft_id: int, episode: int, user: User, *, lock: bool = False) -> ScriptChapter:
    await _draft(session, draft_id, user, lock=lock)
    rows = await _chapters(session, draft_id, episode=episode, lock=lock)
    if not rows:
        raise _fail(404, "SCRIPT_EDITOR_EPISODE_MISSING", "这一集还没有正文。")
    return rows[0]


async def _candidate(session: AsyncSession, row: ScriptChapter, user: User) -> ScriptEditorCandidate | None:
    return await session.get(ScriptEditorCandidate, (row.draft_id, row.chapter_order, user.id))


async def _matching_candidate(
    session: AsyncSession, row: ScriptChapter, user: User, body: CandidateBody,
) -> ScriptEditorCandidate:
    candidate = await _candidate(session, row, user)
    if candidate is None or candidate.id != str(body.candidate_id):
        raise _fail(409, "SCRIPT_EDITOR_CANDIDATE_CHANGED", "候选稿已更新或已处理，请重新打开这一集。")
    return candidate


def _require_base(row: ScriptChapter, revision: str) -> None:
    if revision != _episode_revision(row):
        raise _fail(409, "SCRIPT_EDITOR_VERSION_CHANGED", "这一集已有新的保存版本，请重新核对后再修改。")


async def _save_content(session: AsyncSession, row: ScriptChapter, content: str) -> None:
    if content == (row.full_text or ""):
        return
    version = row.version or 1
    await snapshot_in(
        session, draft_id=row.draft_id, order=row.chapter_order, stage="chapter",
        content={"full_text": row.full_text or "", "title": row.title or ""},
        version=version, created_by="user_edit",
    )
    row.full_text = content
    row.word_count = len(content)
    row.version = version + 1
    await session.execute(
        update(ScriptStoryboard).where(
            ScriptStoryboard.draft_id == row.draft_id, ScriptStoryboard.chapter_order == row.chapter_order,
        ).values(is_stale=1),
    )
    await session.execute(
        update(ScriptDraft).where(ScriptDraft.id == row.draft_id).values(updated_at=func.now()),
    )
    await session.flush()
    await session.refresh(row)


@router.get("/drafts")
async def list_drafts(
    user: Annotated[User, Depends(get_current_user)],
    query: Annotated[str, Query(max_length=120)] = "",
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
):
    """List accessible drafts by recent update, optionally filtered by title."""
    async with session_scope() as session:
        statement = select(ScriptDraft.id, ScriptDraft.title, ScriptDraft.status, ScriptDraft.episode_count, ScriptDraft.updated_at)
        statement = statement.where(ScriptDraft.is_deleted.is_(False))
        if not is_admin_role(user.role):
            statement = statement.where(ScriptDraft.user_id == user.id)
        if query.strip():
            statement = statement.where(ScriptDraft.title.icontains(query.strip(), autoescape=True))
        statement = statement.order_by(ScriptDraft.updated_at.desc().nulls_last(), ScriptDraft.id.desc())
        rows = (await session.execute(statement.offset(offset).limit(limit + 1))).all()
        return {
            "items": [_draft_item(row) for row in rows[:limit]],
            "nextOffset": offset + limit if len(rows) > limit else None,
        }


@router.get("/drafts/{draft_id}")
async def read_draft(draft_id: DraftId, user: Annotated[User, Depends(get_current_user)]):
    """Read a draft’s saved text episode index and bounded writing context."""
    async with session_scope() as session:
        draft = await _draft(session, draft_id, user)
        rows = await _chapters(session, draft_id)
        return {
            **_draft_item(draft),
            "revision": _draft_revision(draft, rows),
            "canFinalize": _can_finalize(draft, rows, user),
            "episodes": [{"episode": row.chapter_order, "title": row.title or ""} for row in rows],
            "context": {
                "outline": _bounded_object(
                    draft.outline, ("synopsis", "world", "characters", "theme", "episodes", "chapters"),
                ),
                "storyBible": _bounded_object(
                    draft.story_bible_json, ("world", "characters", "name_whitelist", "address_matrix", "core_drive", "trope_labels"),
                ),
            },
        }


@router.get("/drafts/{draft_id}/episodes/{episode}")
async def read_episode(draft_id: DraftId, episode: EpisodeNumber, user: Annotated[User, Depends(get_current_user)]):
    """Read one saved episode and the caller’s pending candidate, if any."""
    async with session_scope() as session:
        row = await _episode(session, draft_id, episode, user)
        return _episode_item(row, await _candidate(session, row, user))


@router.post("/drafts/{draft_id}/episodes/{episode}/candidates")
async def stage_episode(
    draft_id: DraftId, episode: EpisodeNumber, body: StageBody, user: Annotated[User, Depends(get_current_user)],
):
    """Record a candidate without changing the current text or history."""
    async with session_scope() as session:
        row = await _episode(session, draft_id, episode, user, lock=True)
        _require_base(row, body.base_revision)
        if body.content == (row.full_text or ""):
            raise _fail(422, "SCRIPT_EDITOR_NO_CHANGE", "候选稿和当前稿相同。")
        candidate = await _candidate(session, row, user)
        if candidate is None:
            candidate = ScriptEditorCandidate(draft_id=draft_id, episode=episode, actor_id=user.id)
            session.add(candidate)
        elif (candidate.base_revision, candidate.content, candidate.summary) == (body.base_revision, body.content, body.summary):
            return _candidate_item(candidate)
        candidate.id = str(uuid4())
        candidate.base_revision = body.base_revision
        candidate.content = body.content
        candidate.summary = body.summary
        candidate.created_at = datetime.now(timezone.utc)
        return _candidate_item(candidate)


@router.post("/drafts/{draft_id}/episodes/{episode}/apply")
async def apply_candidate(
    draft_id: DraftId, episode: EpisodeNumber, body: CandidateBody, user: Annotated[User, Depends(get_current_user)],
):
    """Apply the reviewed candidate if the saved episode still matches its base."""
    async with session_scope() as session:
        row = await _episode(session, draft_id, episode, user, lock=True)
        candidate = await _matching_candidate(session, row, user, body)
        _require_base(row, candidate.base_revision)
        await _save_content(session, row, candidate.content)
        await session.delete(candidate)
        return _episode_item(row, None)


@router.post("/drafts/{draft_id}/episodes/{episode}/discard")
async def discard_candidate(
    draft_id: DraftId, episode: EpisodeNumber, body: CandidateBody, user: Annotated[User, Depends(get_current_user)],
):
    """Discard the caller’s exact candidate without changing its saved episode."""
    async with session_scope() as session:
        row = await _episode(session, draft_id, episode, user, lock=True)
        await session.delete(await _matching_candidate(session, row, user, body))
        return _episode_item(row, None)


@router.patch("/drafts/{draft_id}/episodes/{episode}")
async def save_episode(
    draft_id: DraftId, episode: EpisodeNumber, body: EditBody, user: Annotated[User, Depends(get_current_user)],
):
    """Save one manual edit and retain the previous text in Workshop history."""
    async with session_scope() as session:
        row = await _episode(session, draft_id, episode, user, lock=True)
        _require_base(row, body.base_revision)
        await _save_content(session, row, body.content)
        return _episode_item(row, await _candidate(session, row, user))


@router.post("/drafts/{draft_id}/finalize")
async def finalize_draft(
    draft_id: DraftId, body: FinalizeDraftBody, user: Annotated[User, Depends(get_current_user)],
):
    """Publish the exact complete, saved draft to its finalized library entry."""
    async with session_scope() as session:
        draft = await _draft(session, draft_id, user, lock=True)
        if draft.user_id != user.id:
            raise _fail(403, "SCRIPT_EDITOR_FINALIZE_OWNER", "只有草稿所有者可以将它定稿。")
        rows = await _chapters(session, draft_id, lock=True)
        if body.base_revision != _draft_revision(draft, rows):
            raise _fail(409, "SCRIPT_EDITOR_VERSION_CHANGED", "草稿已有新版，请重新检查后再定稿。")
        if not _can_finalize(draft, rows, user):
            raise _fail(409, "SCRIPT_EDITOR_INCOMPLETE_DRAFT", "请补齐有效的剧名和每集正文，再确认定稿。")
        if body.rights == "licensed" and not body.origin_work_id:
            raise _fail(422, "SCRIPT_EDITOR_ORIGIN_REQUIRED", "授权改编的剧本需要记录原作。")
        link = await session.get(ScriptEditorPublication, draft_id)
        try:
            payload = FinalizeBody(
                entry_id=link.entry_id if link is not None else None,
                title=draft.title, rights=body.rights, kind=body.kind, style=body.style,
                origin_work_id=body.origin_work_id, origin_title=body.origin_title,
                episodes=[{"order": row.chapter_order, "title": row.title or "", "content": row.full_text} for row in rows],
            )
        except ValidationError as error:
            raise _fail(422, "SCRIPT_EDITOR_INVALID_FINALIZATION", "定稿信息不符合剧本库要求，请检查标题、正文和原作编号。") from error
        result = await finalize_in_session(session, payload, user)
        if link is None:
            session.add(ScriptEditorPublication(draft_id=draft_id, entry_id=result["script"]["id"]))
        return result
