"""Create, revise, publish, and export Workshop drafts through the Muse editor."""

import base64
from datetime import datetime, timezone
import hashlib
import json
import re
from typing import Annotated, Literal
from urllib.parse import unquote
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from starlette.concurrency import run_in_threadpool
from sqlalchemy import func, select, update
from sqlalchemy.engine import Row
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import User, get_current_user
from .db.models import ScriptChapter, ScriptDraft, ScriptEditorCandidate, ScriptEditorPublication, ScriptEpisodeHistory, ScriptStoryboard
from .db.session import session_scope
from .script_editor_import import (
    CreateDraftBody, MAX_IMPORT_BYTES, MAX_STORYBOARD_CHARS, file_episodes, parse_shots, validate_editor_text,
)
from .script_library import MAX_EPISODES, MAX_EPISODE_CHARS, MAX_TOTAL_CHARS, FinalizeBody, finalize_in_session
from .stages.access import check_draft_access, is_admin_role
from .stages.candidate_store import snapshot_in

router = APIRouter(prefix="/v1/script-editor", tags=["script-editor"])

DraftId = Annotated[int, Path(ge=1)]
EpisodeNumber = Annotated[int, Path(ge=1)]
HistoryId = Annotated[int, Path(ge=1)]
Revision = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Layer = Literal["chapter", "storyboard"]
_EDITOR_CONTEXT_CHARS = 24_000
_MAX_EXPORT_BYTES = 8 * 1024 * 1024
_MAX_LEGACY_EPISODES = 2000


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
        return validate_editor_text(value)


class StoryboardBody(BaseModel):
    """Save one structured episode at the expected storyboard revision."""

    model_config = ConfigDict(extra="forbid")

    base_revision: Revision = Field(alias="baseRevision")
    shots_json: str = Field(min_length=2, max_length=MAX_STORYBOARD_CHARS, alias="shotsJson")


class RestoreBody(BaseModel):
    """Restore a past version of one layer over the expected saved version."""

    model_config = ConfigDict(extra="forbid")

    base_revision: Revision = Field(alias="baseRevision")
    layer: Layer


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
    draft = await _draft(session, draft_id, user, lock=lock)
    rows = await _chapters(session, draft_id, episode=episode, lock=lock)
    if rows:
        return rows[0]
    if episode > min(draft.episode_count or 0, _MAX_LEGACY_EPISODES) and await _board(session, draft_id, episode, lock=lock) is None:
        raise _fail(404, "SCRIPT_EDITOR_EPISODE_MISSING", "草稿中没有这一集。")
    return ScriptChapter(draft_id=draft_id, chapter_order=episode, title="", full_text="", version=1)


async def _board(session: AsyncSession, draft_id: int, episode: int, *, lock: bool = False) -> ScriptStoryboard | None:
    statement = select(ScriptStoryboard).where(
        ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == episode,
    ).limit(2)
    if lock:
        statement = statement.with_for_update()
    rows = (await session.scalars(statement)).all()
    if len(rows) > 1:
        raise _fail(409, "SCRIPT_EDITOR_INVALID_EPISODES", "草稿存在重复的分场稿集号，需要先修正集号。")
    return rows[0] if rows else None


def _board_item(chapter: ScriptChapter, board: ScriptStoryboard | None) -> dict:
    shots = board.shots_json if board is not None and board.shots_json is not None else []
    version = (board.version if board is not None else None) or 1
    stale = bool(board is not None and board.is_stale)
    return {
        "draftId": chapter.draft_id,
        "episode": chapter.chapter_order,
        "title": chapter.title or "",
        "shotsJson": json.dumps(shots, ensure_ascii=False, separators=(",", ":")),
        "revision": _hash([
            "storyboard", chapter.draft_id, chapter.chapter_order, board.id if board is not None else None,
            version, _timestamp(board.updated_at) if board is not None else None, stale, shots,
        ]),
        "version": version,
        "exists": board is not None,
        "stale": stale,
    }


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
    _require_revision(_episode_revision(row), revision)


def _require_revision(saved: str, expected: str) -> None:
    if saved != expected:
        raise _fail(409, "SCRIPT_EDITOR_VERSION_CHANGED", "这一集已有新的保存版本，请重新核对后再修改。")


async def _save_content(
    session: AsyncSession, row: ScriptChapter, content: str, *, title: str | None = None, source: str = "user_edit",
) -> None:
    if content == (row.full_text or "") and (title is None or title == (row.title or "")):
        return
    version = row.version or 1
    await snapshot_in(
        session, draft_id=row.draft_id, order=row.chapter_order, stage="chapter",
        content={"full_text": row.full_text or "", "title": row.title or ""},
        version=version, created_by=source,
    )
    if row.id is None:
        session.add(row)
    if title is not None:
        row.title = title
    row.full_text = content
    row.word_count = len(content)
    row.version = version + 1
    await session.execute(
        update(ScriptStoryboard).where(
            ScriptStoryboard.draft_id == row.draft_id, ScriptStoryboard.chapter_order == row.chapter_order,
        ).values(is_stale=1),
    )
    await _touch_draft(session, row.draft_id)
    await session.flush()
    await session.refresh(row)


async def _touch_draft(session: AsyncSession, draft_id: int) -> None:
    await session.execute(update(ScriptDraft).where(ScriptDraft.id == draft_id).values(updated_at=func.now()))


async def _save_board(
    session: AsyncSession, chapter: ScriptChapter, board: ScriptStoryboard | None, shots: list[dict], *, source: str = "user_edit",
) -> ScriptStoryboard | None:
    saved = board.shots_json if board is not None and board.shots_json is not None else []
    # JSON equality must distinguish booleans from numbers.
    if json.dumps(saved, sort_keys=True) == json.dumps(shots, sort_keys=True) and (board is None or not board.is_stale):
        return board
    if board is None:
        board = ScriptStoryboard(draft_id=chapter.draft_id, chapter_order=chapter.chapter_order, version=1)
        session.add(board)
    version = board.version or 1
    await snapshot_in(
        session, draft_id=chapter.draft_id, order=chapter.chapter_order, stage="storyboard",
        content={"shots_json": saved}, version=version, created_by=source,
    )
    board.shots_json = shots
    board.version = version + 1
    board.is_stale = 0
    await _touch_draft(session, chapter.draft_id)
    await session.flush()
    await session.refresh(board)
    return board


async def _draft_detail(session: AsyncSession, draft: ScriptDraft, user: User) -> dict:
    rows = await _chapters(session, draft.id)
    episode_titles = dict.fromkeys(range(1, min(draft.episode_count or 0, _MAX_LEGACY_EPISODES) + 1), "")
    board_orders = await session.scalars(select(ScriptStoryboard.chapter_order).where(
        ScriptStoryboard.draft_id == draft.id, ScriptStoryboard.chapter_order > 0,
    ).distinct())
    for episode in board_orders:
        episode_titles.setdefault(episode, "")
    episode_titles.update((row.chapter_order, row.title or "") for row in rows)
    return {
        **_draft_item(draft),
        "revision": _draft_revision(draft, rows),
        "canFinalize": _can_finalize(draft, rows, user),
        "episodes": [{"episode": episode, "title": title} for episode, title in sorted(episode_titles.items())],
        "context": {
            "outline": _bounded_object(draft.outline, ("synopsis", "world", "characters", "theme", "episodes", "chapters")),
            "storyBible": _bounded_object(
                draft.story_bible_json, ("world", "characters", "name_whitelist", "address_matrix", "core_drive", "trope_labels"),
            ),
        },
    }


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


def _creation_materials(body: CreateDraftBody) -> tuple[str, list[tuple[str, str, list[dict] | None]], str]:
    title = validate_editor_text(body.title).strip()
    if not title:
        raise ValueError("请输入剧本名称。")
    if body.file is not None and (body.episodes is not None or body.episode_count is not None):
        raise ValueError("文件导入与手动设置集数或内容只能选择一种。")
    imported = file_episodes(body.file) if body.file is not None else body.episodes
    if imported is None:
        return title, [("", "", None)] * (body.episode_count or 1), "draft"
    if not 0 < len(imported) <= MAX_EPISODES or (body.episode_count is not None and body.episode_count != len(imported)):
        raise ValueError("导入的集数须与文件或结构化内容匹配，且不得超过 300 集。")
    episodes = []
    for episode in imported:
        name = validate_editor_text(episode.title or "")
        content = validate_editor_text(episode.content or "")
        shots = parse_shots(episode.shots_json) if episode.shots_json is not None else None
        if not content.strip() and not shots:
            raise ValueError("每集需要有正文或结构化分场稿。")
        episodes.append((name, content, shots))
    if sum(len(content) for _, content, _ in episodes) > MAX_TOTAL_CHARS or sum(
        len(json.dumps(shots, ensure_ascii=False).encode("utf-8")) for _, _, shots in episodes if shots is not None
    ) > MAX_IMPORT_BYTES:
        raise ValueError("导入内容超出单次上限，请拆分后再导入。")
    return title, episodes, "imported"


@router.post("/drafts")
async def create_draft(body: CreateDraftBody, user: Annotated[User, Depends(get_current_user)]):
    """Save a blank or imported draft in the editor’s account in a single transaction."""
    try:
        title, episodes, status = await run_in_threadpool(_creation_materials, body)
    except ValidationError as error:
        raise _fail(422, "SCRIPT_EDITOR_INVALID_IMPORT", "导入内容超出支持的长度或集数。") from error
    except ValueError as error:
        raise _fail(422, "SCRIPT_EDITOR_INVALID_IMPORT", str(error)) from error

    async with session_scope() as session:
        session_id = f"muse_script_editor:{uuid4()}"
        if body.request_id is not None:
            # Existing imported drafts use session_id as a source reference. The owner lock serializes retries.
            prefix = f"muse_script_editor_request:{body.request_id}:"
            session_id = prefix + _hash([title, episodes, status])
            await session.scalar(select(User.id).where(User.id == user.id).with_for_update())
            prior = await session.scalar(select(ScriptDraft).where(
                ScriptDraft.user_id == user.id, ScriptDraft.session_id.startswith(prefix, autoescape=True),
            ))
            if prior is not None:
                if prior.session_id != session_id or prior.is_deleted:
                    raise _fail(409, "SCRIPT_EDITOR_REQUEST_REUSED", "这次创建已处理，请重新发起创建。")
                return await _draft_detail(session, prior, user)
        draft = ScriptDraft(user_id=user.id, title=title, episode_count=len(episodes), status=status, session_id=session_id)
        session.add(draft)
        await session.flush()
        for order, (name, content, shots) in enumerate(episodes, start=1):
            session.add(ScriptChapter(
                draft_id=draft.id, chapter_order=order, title=name, full_text=content, word_count=len(content), version=1,
            ))
            if shots is not None:
                session.add(ScriptStoryboard(draft_id=draft.id, chapter_order=order, shots_json=shots, version=1))
        await session.flush()
        return await _draft_detail(session, draft, user)


@router.get("/drafts/{draft_id}")
async def read_draft(draft_id: DraftId, user: Annotated[User, Depends(get_current_user)]):
    """Read a draft’s episode index and bounded writing context."""
    async with session_scope() as session:
        return await _draft_detail(session, await _draft(session, draft_id, user), user)


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


@router.get("/drafts/{draft_id}/episodes/{episode}/storyboard")
async def read_storyboard(draft_id: DraftId, episode: EpisodeNumber, user: Annotated[User, Depends(get_current_user)]):
    """Read the structured scene data independently of the episode’s prose."""
    async with session_scope() as session:
        chapter = await _episode(session, draft_id, episode, user)
        return _board_item(chapter, await _board(session, draft_id, episode))


@router.patch("/drafts/{draft_id}/episodes/{episode}/storyboard")
async def save_storyboard(
    draft_id: DraftId, episode: EpisodeNumber, body: StoryboardBody, user: Annotated[User, Depends(get_current_user)],
):
    """Save revised scene data and snapshot the prior storyboard."""
    try:
        shots = parse_shots(body.shots_json)
    except ValueError as error:
        raise _fail(422, "SCRIPT_EDITOR_INVALID_STORYBOARD", str(error)) from error
    async with session_scope() as session:
        chapter = await _episode(session, draft_id, episode, user, lock=True)
        board = await _board(session, draft_id, episode, lock=True)
        _require_revision(_board_item(chapter, board)["revision"], body.base_revision)
        return _board_item(chapter, await _save_board(session, chapter, board, shots))


def _history_query(draft_id: int, episode: int, layer: Layer):
    return select(ScriptEpisodeHistory).where(
        ScriptEpisodeHistory.draft_id == draft_id,
        ScriptEpisodeHistory.episode_order == episode,
        ScriptEpisodeHistory.stage == layer,
    )


async def _history_row(session: AsyncSession, draft_id: int, episode: int, layer: Layer, history_id: int) -> ScriptEpisodeHistory:
    row = await session.scalar(_history_query(draft_id, episode, layer).where(ScriptEpisodeHistory.id == history_id))
    if row is None:
        raise _fail(404, "SCRIPT_EDITOR_HISTORY_MISSING", "这条历史版本已不存在。")
    return row


def _history_item(row: ScriptEpisodeHistory) -> dict:
    return {
        "id": row.id,
        "version": row.version or 1,
        "createdAt": _timestamp(row.created_at),
        "createdBy": row.created_by or "",
    }


def _history_text(row: ScriptEpisodeHistory) -> tuple[str, str | None]:
    content = row.content
    if isinstance(content, dict):
        text = content.get("full_text", content.get("content"))
        title = content.get("title")
    else:
        text, title = content, None
    if not isinstance(text, str) or not (title is None or isinstance(title, str)):
        raise _fail(409, "SCRIPT_EDITOR_INVALID_HISTORY", "此历史版本的正文格式无法读取。")
    return text, title


def _history_shots(row: ScriptEpisodeHistory) -> str:
    shots = row.content
    if isinstance(shots, dict):
        shots = next((shots[key] for key in ("shots_json", "shots") if isinstance(shots.get(key), list)), None)
    if not isinstance(shots, list):
        raise _fail(409, "SCRIPT_EDITOR_INVALID_HISTORY", "此历史版本的分场稿格式无法读取。")
    return json.dumps(shots, ensure_ascii=False, indent=2)


@router.get("/drafts/{draft_id}/episodes/{episode}/history")
async def list_episode_history(
    draft_id: DraftId, episode: EpisodeNumber, user: Annotated[User, Depends(get_current_user)], layer: Layer = "chapter",
):
    """List saved snapshots for one episode and one layer."""
    async with session_scope() as session:
        await _episode(session, draft_id, episode, user)
        rows = await session.scalars(_history_query(draft_id, episode, layer).order_by(
            ScriptEpisodeHistory.created_at.desc(), ScriptEpisodeHistory.id.desc(),
        ).limit(50))
        return {"items": [_history_item(row) for row in rows]}


@router.get("/drafts/{draft_id}/episodes/{episode}/history/{history_id}")
async def read_episode_history(
    draft_id: DraftId, episode: EpisodeNumber, history_id: HistoryId,
    user: Annotated[User, Depends(get_current_user)], layer: Layer = "chapter",
):
    """Read the exact prior text or structured data for the selected snapshot."""
    async with session_scope() as session:
        await _episode(session, draft_id, episode, user)
        row = await _history_row(session, draft_id, episode, layer, history_id)
        return {**_history_item(row), "content": _history_text(row)[0] if layer == "chapter" else _history_shots(row)}


@router.post("/drafts/{draft_id}/episodes/{episode}/history/{history_id}/restore")
async def restore_episode_history(
    draft_id: DraftId, episode: EpisodeNumber, history_id: HistoryId, body: RestoreBody,
    user: Annotated[User, Depends(get_current_user)],
):
    """Restore a snapshot while keeping the prior current version in history."""
    async with session_scope() as session:
        chapter = await _episode(session, draft_id, episode, user, lock=True)
        row = await _history_row(session, draft_id, episode, body.layer, history_id)
        if body.layer == "chapter":
            _require_base(chapter, body.base_revision)
            content, title = _history_text(row)
            try:
                validate_editor_text(content)
                if title is not None:
                    validate_editor_text(title)
            except ValueError as error:
                raise _fail(409, "SCRIPT_EDITOR_INVALID_HISTORY", str(error)) from error
            await _save_content(session, chapter, content, title=title, source="rollback")
            return {"episode": _episode_item(chapter, await _candidate(session, chapter, user)), "storyboard": None}
        board = await _board(session, draft_id, episode, lock=True)
        _require_revision(_board_item(chapter, board)["revision"], body.base_revision)
        try:
            shots = parse_shots(_history_shots(row))
        except ValueError as error:
            raise _fail(409, "SCRIPT_EDITOR_INVALID_HISTORY", str(error)) from error
        board = await _save_board(session, chapter, board, shots, source="rollback")
        return {"episode": None, "storyboard": _board_item(chapter, board)}


@router.get("/drafts/{draft_id}/export")
async def export_draft(
    draft_id: DraftId, user: Annotated[User, Depends(get_current_user)],
    kind: Literal["chapters", "storyboards", "mixed", "outline"] = "chapters",
    format: Literal["docx", "txt", "md"] = "docx",
    episode: Annotated[int | None, Query(ge=1)] = None,
):
    """Export an accessible draft through the existing Workshop renderers."""
    from .stages.router import render_draft_export

    async with session_scope() as session:
        draft = await _draft(session, draft_id, user)
        response = await render_draft_export(
            session, draft.id, kind=kind, scope="all" if episode is None else str(episode), fmt=format,
        )
    if len(response.body) > _MAX_EXPORT_BYTES:
        raise _fail(413, "SCRIPT_EDITOR_EXPORT_TOO_LARGE", "剧本超出单次导出上限，请按集导出。")
    disposition = response.headers.get("content-disposition", "")
    name = unquote(disposition.partition("filename*=UTF-8''")[2]) or f"draft-{draft_id}.{format}"
    return {
        "filename": re.sub(r"[\x00-\x1f\x7f/\\]", "_", name),
        "mime": response.media_type,
        "base64": base64.b64encode(response.body).decode("ascii"),
    }


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
