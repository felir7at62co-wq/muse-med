"""Admin 专用 API - 全自动批量产线"""
from __future__ import annotations

import asyncio
import io
import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, desc, func

from ..auth.dependencies import require_admin
from ..auth.models import User
from ..db import (
    AutoBatchJob, AutoBatchGenre, AutoBatchTransfer,
    ScriptDraft, ScriptChapter, ScriptStoryboard, ScriptAnalysis,
    session_scope,
)
from .genres import (
    list_genres as _list_genres,
    create_genre as _create_genre,
    update_genre as _update_genre,
    delete_genre as _delete_genre,
    reorder_genres as _reorder_genres,
)
from .orchestrator import run_batch
from .transfer import transfer_drafts

logger = logging.getLogger("auto_batch.routes")

router = APIRouter(prefix="/v1/admin-api/auto-batch", tags=["admin-auto-batch"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class CreateJobIn(BaseModel):
    name: str = ""
    batch_count: int = Field(ge=1, le=1000)
    episodes_per_drama: int = Field(ge=1, le=500)
    words_per_episode: int = Field(ge=1000, le=15000)
    genre_keys: list[str] = []
    adhoc_tags: list[str] = []
    concept_model: str = "gemini"
    gen_model: str = ""                      # 留空=同 concept_model
    drama_concurrency: int = Field(default=2, ge=1, le=10)
    auto_analyze: bool = True
    auto_pack: bool = False
    auto_transfer_user_ids: list[int] = []


class JobOut(BaseModel):
    id: int
    name: str
    config_json: dict
    status: str
    total_dramas: int
    finished_dramas: int
    failed_dramas: int
    draft_ids: list[int]
    current_step: str
    llm_calls_estimated: int
    llm_calls_actual: int
    error: str | None
    created_by: int
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class TransferIn(BaseModel):
    target_user_ids: list[int]
    draft_ids: list[int] = []                # 留空=整批所有 done 的
    include_analysis: bool = True


class GenreIn(BaseModel):
    key: str
    label: str
    description: str = ""
    prompt_hint: str = ""


class GenreOut(BaseModel):
    id: int
    key: str
    label: str
    description: str
    prompt_hint: str
    is_builtin: bool
    display_order: int
    use_count: int
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# 批次任务
# ---------------------------------------------------------------------------
@router.post("/jobs", response_model=JobOut)
async def create_job(payload: CreateJobIn, admin: User = Depends(require_admin)):
    """创建批次,立即后台启动"""
    # 检查是否已有 running
    async with session_scope() as s:
        running = (await s.execute(
            select(AutoBatchJob).where(
                AutoBatchJob.created_by == admin.id,
                AutoBatchJob.status == "running",
            )
        )).scalar_one_or_none()
        if running:
            raise HTTPException(400, "你已有一个运行中的批次,请等待完成或取消")

    gen_model = payload.gen_model or payload.concept_model
    cfg = {
        "batch_count": payload.batch_count,
        "episodes_per_drama": payload.episodes_per_drama,
        "words_per_episode": payload.words_per_episode,
        "genre_keys": payload.genre_keys,
        "adhoc_tags": payload.adhoc_tags,
        "concept_model": payload.concept_model,
        "gen_model": gen_model,
        "drama_concurrency": payload.drama_concurrency,
        "auto_analyze": payload.auto_analyze,
        "auto_pack": payload.auto_pack,
        "auto_transfer_user_ids": payload.auto_transfer_user_ids,
    }
    # 预估 LLM 调用
    est = payload.batch_count * (
        1 +                                          # 大纲
        payload.episodes_per_drama +                 # 章节
        payload.episodes_per_drama +                 # 剧本
        (1 if payload.auto_analyze else 0)           # 分析
    )

    async with session_scope() as s:
        job = AutoBatchJob(
            name=payload.name or f"批次-{datetime.now().strftime('%m%d%H%M')}",
            config_json=cfg,
            status="pending",
            total_dramas=payload.batch_count,
            llm_calls_estimated=est,
            created_by=admin.id,
        )
        s.add(job)
        await s.flush()
        job_id = job.id

    # 后台启动
    asyncio.create_task(run_batch(job_id))

    async with session_scope() as s:
        row = await s.get(AutoBatchJob, job_id)
        return JobOut(
            id=row.id,
            name=row.name,
            config_json=row.config_json or {},
            status=row.status,
            total_dramas=row.total_dramas or 0,
            finished_dramas=row.finished_dramas or 0,
            failed_dramas=row.failed_dramas or 0,
            draft_ids=row.draft_ids or [],
            current_step=row.current_step or "",
            llm_calls_estimated=row.llm_calls_estimated or 0,
            llm_calls_actual=row.llm_calls_actual or 0,
            error=row.error,
            created_by=row.created_by,
            created_at=row.created_at,
            started_at=row.started_at,
            finished_at=row.finished_at,
        )


@router.get("/jobs")
async def list_jobs(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str | None = None,
    admin: User = Depends(require_admin),
):
    """批次列表(分页) - 含细粒度章节/剧本进度"""
    async with session_scope() as s:
        q = select(AutoBatchJob).where(AutoBatchJob.created_by == admin.id)
        if status:
            q = q.where(AutoBatchJob.status == status)
        q = q.order_by(desc(AutoBatchJob.created_at)).offset((page - 1) * page_size).limit(page_size)
        rows = (await s.execute(q)).scalars().all()

        items = []
        for r in rows:
            cfg = r.config_json or {}
            episodes_per_drama = int(cfg.get("episodes_per_drama") or 0)
            draft_ids = r.draft_ids or []
            total_units = (r.total_dramas or 0) * episodes_per_drama * 2  # 章节 + 剧本

            chapters_done = 0
            storyboards_done = 0
            if draft_ids:
                chapters_done = (await s.execute(
                    select(func.count(ScriptChapter.id)).where(ScriptChapter.draft_id.in_(draft_ids))
                )).scalar() or 0
                storyboards_done = (await s.execute(
                    select(func.count(ScriptStoryboard.id)).where(ScriptStoryboard.draft_id.in_(draft_ids))
                )).scalar() or 0

            # 时间字段统一带 UTC 'Z' 标识 (DB 存的是 UTC, 但没 timezone 信息, JS new Date 会当本地时间)
            def _utc_iso(dt):
                if not dt:
                    return None
                s = dt.isoformat()
                return s if s.endswith("Z") or "+" in s else s + "Z"

            items.append({
                "id": r.id,
                "name": r.name,
                "config_json": cfg,
                "status": r.status,
                "total_dramas": r.total_dramas or 0,
                "finished_dramas": r.finished_dramas or 0,
                "failed_dramas": r.failed_dramas or 0,
                "draft_ids": draft_ids,
                "current_step": r.current_step or "",
                "llm_calls_estimated": r.llm_calls_estimated or 0,
                "llm_calls_actual": r.llm_calls_actual or 0,
                "error": r.error,
                "created_by": r.created_by,
                "started_at": _utc_iso(r.started_at),
                "finished_at": _utc_iso(r.finished_at),
                "created_at": _utc_iso(r.created_at),
                # 细粒度进度
                "chapters_done": chapters_done,
                "storyboards_done": storyboards_done,
                "total_units": total_units,
            })
        return items


@router.get("/jobs/{job_id}", response_model=dict)
async def get_job_detail(job_id: int, admin: User = Depends(require_admin)):
    """批次详情(含子任务状态)"""
    async with session_scope() as s:
        job = await s.get(AutoBatchJob, job_id)
        if not job or job.created_by != admin.id:
            raise HTTPException(404, "批次不存在")

        draft_ids = job.draft_ids or []
        drafts_data = []
        if draft_ids:
            drafts = (await s.execute(
                select(ScriptDraft).where(ScriptDraft.id.in_(draft_ids))
            )).scalars().all()
            for d in drafts:
                ch_count = (await s.execute(
                    select(func.count(ScriptChapter.id)).where(ScriptChapter.draft_id == d.id)
                )).scalar() or 0
                sb_count = (await s.execute(
                    select(func.count(ScriptStoryboard.id)).where(ScriptStoryboard.draft_id == d.id)
                )).scalar() or 0
                analysis = (await s.execute(
                    select(ScriptAnalysis).where(ScriptAnalysis.draft_id == d.id).order_by(desc(ScriptAnalysis.created_at))
                )).scalars().first()
                transfers = (await s.execute(
                    select(AutoBatchTransfer).where(AutoBatchTransfer.draft_id == d.id)
                )).scalars().all()

                drafts_data.append({
                    "draft_id": d.id,
                    "title": d.title,
                    "status": d.status,
                    "episode_count": d.episode_count,
                    "chapters_done": ch_count,
                    "storyboards_done": sb_count,
                    "analysis_grade": analysis.overall_grade if analysis else None,
                    "analysis_score": analysis.overall_score if analysis else None,
                    "transferred_to": [t.target_user_id for t in transfers],
                })

        return {
            "job": JobOut(
                id=job.id,
                name=job.name,
                config_json=job.config_json or {},
                status=job.status,
                total_dramas=job.total_dramas or 0,
                finished_dramas=job.finished_dramas or 0,
                failed_dramas=job.failed_dramas or 0,
                draft_ids=job.draft_ids or [],
                current_step=job.current_step or "",
                llm_calls_estimated=job.llm_calls_estimated or 0,
                llm_calls_actual=job.llm_calls_actual or 0,
                error=job.error,
                created_by=job.created_by,
                created_at=job.created_at,
                started_at=job.started_at,
                finished_at=job.finished_at,
            ),
            "drafts": drafts_data,
        }


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: int, admin: User = Depends(require_admin)):
    """取消批次(已生成的保留)"""
    async with session_scope() as s:
        job = await s.get(AutoBatchJob, job_id)
        if not job or job.created_by != admin.id:
            raise HTTPException(404)
        if job.status not in ("pending", "running"):
            raise HTTPException(400, "只能取消 pending/running 状态")
        job.status = "cancelled"
        job.finished_at = datetime.utcnow()
    return {"ok": True}


@router.post("/jobs/{job_id}/retry")
async def retry_job(job_id: int, admin: User = Depends(require_admin)):
    """增量重试 / 恢复中断 (只补缺失的部分)。

    支持的源状态:
      - partial_failed / failed : 标准重试
      - running / pending       : 强制恢复 (用于服务重启后状态卡死的情况)
      - cancelled               : 用户主动取消后改主意,可继续
      - done                    : 拒绝(已完成)
    """
    async with session_scope() as s:
        job = await s.get(AutoBatchJob, job_id)
        if not job or job.created_by != admin.id:
            raise HTTPException(404)
        if job.status == "done":
            raise HTTPException(400, "批次已完成,无需重试")
        # 其他状态都允许恢复 (orchestrator 内部有去重: 已生成的章节会跳过)
        job.status = "pending"
        job.error = None
        job.current_step = "retrying"
        job.finished_at = None

    asyncio.create_task(run_batch(job_id))
    return {"ok": True, "message": "已重新排队 (增量补全)"}


@router.delete("/jobs/{job_id}")
async def delete_job(
    job_id: int,
    delete_drafts: bool = Query(False),
    admin: User = Depends(require_admin),
):
    """删除批次(可选级联删草稿)"""
    async with session_scope() as s:
        job = await s.get(AutoBatchJob, job_id)
        if not job or job.created_by != admin.id:
            raise HTTPException(404)
        draft_ids = job.draft_ids or []
        if delete_drafts and draft_ids:
            await s.execute(
                select(ScriptDraft).where(ScriptDraft.id.in_(draft_ids))
            )
            # 简化:只标记删除
            for did in draft_ids:
                d = await s.get(ScriptDraft, did)
                if d:
                    d.is_deleted = True
                    d.deleted_at = datetime.utcnow()
        await s.delete(job)
    return {"ok": True}


@router.get("/jobs/{job_id}/export-zip")
async def export_zip(job_id: int, admin: User = Depends(require_admin)):
    """下载 zip(分目录 scripts/ + analysis/)"""
    from .docx_zip import build_batch_zip

    async with session_scope() as s:
        job = await s.get(AutoBatchJob, job_id)
        if not job or job.created_by != admin.id:
            raise HTTPException(404)

    zip_bytes = await build_batch_zip(job_id)
    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=batch-{job_id}.zip"},
    )


@router.post("/jobs/{job_id}/transfer")
async def transfer_job(
    job_id: int,
    payload: TransferIn,
    admin: User = Depends(require_admin),
):
    """转交给一个或多个用户"""
    async with session_scope() as s:
        job = await s.get(AutoBatchJob, job_id)
        if not job or job.created_by != admin.id:
            raise HTTPException(404)

        draft_ids = payload.draft_ids or job.draft_ids or []
        if not draft_ids:
            raise HTTPException(400, "无可转交的草稿")

    result = await transfer_drafts(
        draft_ids=draft_ids,
        target_user_ids=payload.target_user_ids,
        source_user_id=admin.id,
        job_id=job_id,
        include_analysis=payload.include_analysis,
    )
    return result


# ---------------------------------------------------------------------------
# 题材库
# ---------------------------------------------------------------------------
@router.get("/genres", response_model=list[GenreOut])
async def list_genres_route(admin: User = Depends(require_admin)):
    rows = await _list_genres()
    return [
        GenreOut(
            id=r.id,
            key=r.key,
            label=r.label,
            description=r.description or "",
            prompt_hint=r.prompt_hint or "",
            is_builtin=r.is_builtin,
            display_order=r.display_order or 0,
            use_count=r.use_count or 0,
            created_at=r.created_at,
            updated_at=r.updated_at,
        )
        for r in rows
    ]


@router.post("/genres", response_model=GenreOut)
async def create_genre_route(payload: GenreIn, admin: User = Depends(require_admin)):
    row = await _create_genre(
        key=payload.key,
        label=payload.label,
        description=payload.description,
        prompt_hint=payload.prompt_hint,
    )
    return GenreOut(
        id=row.id,
        key=row.key,
        label=row.label,
        description=row.description or "",
        prompt_hint=row.prompt_hint or "",
        is_builtin=row.is_builtin,
        display_order=row.display_order or 0,
        use_count=row.use_count or 0,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.patch("/genres/{genre_id}", response_model=GenreOut)
async def update_genre_route(
    genre_id: int,
    payload: GenreIn,
    admin: User = Depends(require_admin),
):
    row = await _update_genre(
        genre_id=genre_id,
        label=payload.label,
        description=payload.description,
        prompt_hint=payload.prompt_hint,
    )
    return GenreOut(
        id=row.id,
        key=row.key,
        label=row.label,
        description=row.description or "",
        prompt_hint=row.prompt_hint or "",
        is_builtin=row.is_builtin,
        display_order=row.display_order or 0,
        use_count=row.use_count or 0,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.delete("/genres/{genre_id}")
async def delete_genre_route(genre_id: int, admin: User = Depends(require_admin)):
    await _delete_genre(genre_id)
    return {"ok": True}


@router.post("/genres/reorder")
async def reorder_genres_route(
    payload: dict[str, list[int]],
    admin: User = Depends(require_admin),
):
    """调整顺序 {"ids": [3,1,2,...]}"""
    await _reorder_genres(payload.get("ids") or [])
    return {"ok": True}
