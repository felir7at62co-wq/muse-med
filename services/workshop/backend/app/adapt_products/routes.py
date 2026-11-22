"""章节改编 API: 小说(novel) / 推文(tweet)。

前缀 /v1/adapt。均校验草稿归属(非 admin 只能操作自己的草稿)。
输入只用原文 chapters, 逐章产出, 独立表存储, 不复写原文。
"""
from __future__ import annotations

import asyncio
import io
import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select

from ..auth import get_current_user, User
from ..db import session_scope, ScriptDraft
from ..db.models import ScriptEpisodeHistory
from .models import ChapterAdaptation, ChapterAdaptJob
from . import service

logger = logging.getLogger("adapt.routes")

router = APIRouter(prefix="/v1/adapt", tags=["adapt"])

KINDS = ("novel", "tweet")
_KIND_LABEL = {"novel": "小说", "tweet": "推文"}


def _check_kind(kind: str) -> None:
    if kind not in KINDS:
        raise HTTPException(400, "kind 只能是 novel 或 tweet")


async def _guard_draft(draft_id: int, user: User) -> ScriptDraft:
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise HTTPException(404, "draft not found")
        if user.role not in ("admin", "superadmin") and d.user_id != user.id:
            raise HTTPException(403, "无权操作该草稿")
        return d


def _job_view(j: ChapterAdaptJob) -> dict:
    return {
        "id": j.id,
        "draft_id": j.draft_id,
        "kind": j.kind,
        "status": j.status,
        "model": j.model,
        "protagonist": j.protagonist or "",
        "total": j.total,
        "finished": j.finished,
        "per_ep": j.per_ep_json or {},
        "error": j.error or "",
        "created_at": j.created_at.isoformat() if j.created_at else None,
        "finished_at": j.finished_at.isoformat() if j.finished_at else None,
    }


def _item_view(a: ChapterAdaptation) -> dict:
    return {
        "chapter_order": a.chapter_order,
        "content": a.content or "",
        "word_count": a.word_count or 0,
        "version": a.version or 1,
        "user_edited": bool(a.user_edited),
        "protagonist": (a.meta_json or {}).get("protagonist", ""),
        "updated_at": a.updated_at.isoformat() if a.updated_at else None,
    }


class GenerateBody(BaseModel):
    draft_id: int
    model: str = "gemini"
    protagonist: str = ""   # tweet 用
    #: True = **只补缺失的集**（已有内容的集整个跳过，一次模型调用都不花）。
    #: 供工作台顶栏「补全小说/推文」用，与正文/剧本的「补全」语义对齐。
    #: 默认 False 保持原有契约：对话里的「生成小说」仍是整本重生。
    only_missing: bool = False


class FeedbackBody(BaseModel):
    feedback: str = ""
    model: str = "gemini"


class EditBody(BaseModel):
    content: str


class RestoreBody(BaseModel):
    history_id: int


# ---------------------------------------------------------------------------
# 主角建议(仅 tweet 场景有意义, 但通用挂 kind 便于前端统一)
# ---------------------------------------------------------------------------
@router.post("/{kind}/suggest-protagonist")
async def suggest_protagonist(kind: str, body: GenerateBody, user: User = Depends(get_current_user)):
    _check_kind(kind)
    await _guard_draft(body.draft_id, user)
    try:
        data = await service.suggest_protagonist(body.draft_id, body.model)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, **data}


# ---------------------------------------------------------------------------
# 列表(产物逐章 + 最近作业)
# ---------------------------------------------------------------------------
@router.get("/{kind}")
async def list_items(kind: str, draft_id: int, user: User = Depends(get_current_user),
                     job_only: bool = False):
    """逐章产物 + 最近一次作业。

    job_only=True: **只返回作业进度, 不返回 items**。
      ⚠️ 为什么需要它: items 里每一条都带该章**全文**(`content`), 一部 60 集的剧
      就是几十万字。v2 草稿页的任务状态栏要 3 秒轮询一次进度, 用全量响应会把
      浏览器和服务端一起拖死。带这个参数时只查作业表那一行。
    """
    _check_kind(kind)
    await _guard_draft(draft_id, user)
    async with session_scope() as s:
        if job_only:
            job = (await s.execute(
                select(ChapterAdaptJob).where(
                    ChapterAdaptJob.draft_id == draft_id,
                    ChapterAdaptJob.kind == kind,
                ).order_by(ChapterAdaptJob.created_at.desc()).limit(1)
            )).scalars().first()
            return {"ok": True, "kind": kind, "items": [],
                    "job": _job_view(job) if job else None}
        items = (await s.execute(
            select(ChapterAdaptation).where(
                ChapterAdaptation.draft_id == draft_id,
                ChapterAdaptation.kind == kind,
            ).order_by(ChapterAdaptation.chapter_order)
        )).scalars().all()
        job = (await s.execute(
            select(ChapterAdaptJob).where(
                ChapterAdaptJob.draft_id == draft_id,
                ChapterAdaptJob.kind == kind,
            ).order_by(ChapterAdaptJob.created_at.desc()).limit(1)
        )).scalars().first()
    return {
        "ok": True,
        "kind": kind,
        "items": [_item_view(a) for a in items],
        "job": _job_view(job) if job else None,
    }


# ---------------------------------------------------------------------------
# 一键生成(逐章异步)
# ---------------------------------------------------------------------------
@router.post("/{kind}/generate")
async def generate(kind: str, body: GenerateBody, user: User = Depends(get_current_user)):
    _check_kind(kind)
    await _guard_draft(body.draft_id, user)
    async with session_scope() as s:
        job = ChapterAdaptJob(
            user_id=user.id, draft_id=body.draft_id, kind=kind,
            status="running", model=body.model or "gemini",
            protagonist=(body.protagonist or ""),
        )
        s.add(job)
        await s.flush()
        job_id = job.id
    asyncio.create_task(service.run_adapt(job_id, only_missing=body.only_missing))
    logger.info("adapt %s job %d submitted for draft %d (only_missing=%s)",
                kind, job_id, body.draft_id, body.only_missing)
    return {"ok": True, "job_id": job_id}


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        j = await s.get(ChapterAdaptJob, job_id)
        if not j:
            raise HTTPException(404, "job not found")
        if user.role not in ("admin", "superadmin") and j.user_id != user.id:
            raise HTTPException(403, "无权操作该作业")
        if j.status in ("running", "pending"):
            j.status = "canceled"
    return {"ok": True}


# ---------------------------------------------------------------------------
# 单章重新生成 / 按意见重新生成
# ---------------------------------------------------------------------------
@router.post("/{kind}/{chapter_order}/regenerate")
async def regenerate(kind: str, chapter_order: int, body: FeedbackBody,
                     draft_id: int, user: User = Depends(get_current_user)):
    _check_kind(kind)
    await _guard_draft(draft_id, user)
    try:
        content = await service.regenerate_one(draft_id, kind, chapter_order, body.model, feedback="")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "content": content}


@router.post("/{kind}/{chapter_order}/regenerate-with-feedback")
async def regenerate_with_feedback(kind: str, chapter_order: int, body: FeedbackBody,
                                   draft_id: int, user: User = Depends(get_current_user)):
    _check_kind(kind)
    await _guard_draft(draft_id, user)
    if not (body.feedback or "").strip():
        raise HTTPException(400, "请填写修改意见")
    try:
        content = await service.regenerate_one(draft_id, kind, chapter_order, body.model, feedback=body.feedback)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "content": content}


# ---------------------------------------------------------------------------
# 手动编辑保存
# ---------------------------------------------------------------------------
@router.patch("/{kind}/{chapter_order}")
async def edit_item(kind: str, chapter_order: int, body: EditBody,
                    draft_id: int, user: User = Depends(get_current_user)):
    _check_kind(kind)
    await _guard_draft(draft_id, user)
    await service._upsert_adaptation(  # 复用: 存历史→覆盖
        draft_id, kind, chapter_order, body.content or "", user_edited=True,
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# 历史版本
# ---------------------------------------------------------------------------
@router.get("/{kind}/{chapter_order}/history")
async def list_history(kind: str, chapter_order: int, draft_id: int,
                       user: User = Depends(get_current_user)):
    _check_kind(kind)
    await _guard_draft(draft_id, user)
    async with session_scope() as s:
        rows = (await s.execute(
            select(ScriptEpisodeHistory).where(
                ScriptEpisodeHistory.draft_id == draft_id,
                ScriptEpisodeHistory.episode_order == chapter_order,
                ScriptEpisodeHistory.stage == kind,
            ).order_by(ScriptEpisodeHistory.created_at.desc()).limit(20)
        )).scalars().all()
    return {
        "ok": True,
        "items": [
            {
                "id": r.id,
                "version": r.version,
                "content": (r.content or {}).get("content", ""),
                "created_by": r.created_by,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }


@router.post("/{kind}/{chapter_order}/history/restore")
async def restore_history(kind: str, chapter_order: int, body: RestoreBody,
                          draft_id: int, user: User = Depends(get_current_user)):
    _check_kind(kind)
    await _guard_draft(draft_id, user)
    async with session_scope() as s:
        h = await s.get(ScriptEpisodeHistory, body.history_id)
        if not h or h.draft_id != draft_id or h.stage != kind or h.episode_order != chapter_order:
            raise HTTPException(404, "历史版本不存在")
        content = (h.content or {}).get("content", "")
    await service._upsert_adaptation(draft_id, kind, chapter_order, content, user_edited=True)
    return {"ok": True, "content": content}


# ---------------------------------------------------------------------------
# 导出(整本 txt/md/docx)
# ---------------------------------------------------------------------------
async def _load_export_items(draft_id: int, kind: str) -> tuple[str, list[tuple[int, str]]]:
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        title = (d.title if d else "") or f"草稿{draft_id}"
        items = (await s.execute(
            select(ChapterAdaptation).where(
                ChapterAdaptation.draft_id == draft_id,
                ChapterAdaptation.kind == kind,
            ).order_by(ChapterAdaptation.chapter_order)
        )).scalars().all()
    return title, [(a.chapter_order, a.content or "") for a in items]


@router.get("/{kind}/export/{fmt}")
async def export(kind: str, fmt: str, draft_id: int, user: User = Depends(get_current_user)):
    _check_kind(kind)
    if fmt not in ("txt", "md", "docx"):
        raise HTTPException(400, "fmt 只能是 txt/md/docx")
    await _guard_draft(draft_id, user)
    title, items = await _load_export_items(draft_id, kind)
    if not items:
        raise HTTPException(400, "暂无可导出的内容, 请先生成")
    label = _KIND_LABEL.get(kind, kind)
    safe_name = f"{title}-{label}"

    if fmt == "txt":
        parts = [f"《{title}》· {label}\n"]
        for order, content in items:
            parts.append(f"\n第{order}章\n\n{content}\n")
        data = "\n".join(parts).encode("utf-8")
        return Response(content=data, media_type="text/plain; charset=utf-8", headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{_url_quote(safe_name)}.txt",
        })

    if fmt == "md":
        parts = [f"# 《{title}》· {label}\n"]
        for order, content in items:
            parts.append(f"\n## 第{order}章\n\n{content}\n")
        data = "\n".join(parts).encode("utf-8")
        return Response(content=data, media_type="text/markdown; charset=utf-8", headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{_url_quote(safe_name)}.md",
        })

    # docx
    try:
        from docx import Document
    except Exception:  # noqa: BLE001
        raise HTTPException(500, "docx 依赖缺失")
    doc = Document()
    doc.add_heading(f"《{title}》· {label}", level=0)
    for order, content in items:
        doc.add_heading(f"第{order}章", level=1)
        for para in (content or "").split("\n"):
            doc.add_paragraph(para)
    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{_url_quote(safe_name)}.docx"},
    )


def _url_quote(s: str) -> str:
    from urllib.parse import quote
    return quote(s)
