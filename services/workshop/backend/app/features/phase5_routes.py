"""Phase 5 核心后端 routes (PLAN_UI_REVAMP §5.5).

涵盖:
  - 角色管理 (/v1/drafts/{draft_id}/characters/...)
  - 安全报告持久化 (/v1/drafts/{draft_id}/safety-reports/...)
  - 导出任务异步队列 (/v1/export-jobs/...)
  - 配额查询 (/v1/quotas/me)
  - 邮箱验证码 (/v1/auth/email/send-code, /verify-code)
  - 续写偏好 (/v1/drafts/{draft_id}/extend-config)
  - Agent 浮窗附件/产出物 (/v1/agent/conversations/{cid}/{attachments|artifacts})

设计原则:
  - 所有写操作要求 get_current_user
  - dev-only 上线, 接口先做"读 + 简单写", 业务逻辑后续 enrich
  - 严格隔离 user_id, 防越权
"""
from __future__ import annotations

import logging
import random
import string
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Query, BackgroundTasks
from pydantic import BaseModel, Field
from sqlalchemy import select, func as sql_func, and_, desc, delete

from ..db.session import session_scope
from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from ..db.models import ScriptDraft, AgentConversation
from ..db.models_phase5 import (
    Character, CharacterRelationship, CharacterConsistencyWarning,
    ExportJob, DraftExtendConfig, EmailVerification,
    AgentAttachment, AgentArtifact,
    PromptConverterQuota, ImageGenerationQuota,
    SafetyReport, SafetyRisk,
)
from ..auth.dependencies import get_current_user
from ..auth.models import User

logger = logging.getLogger("phase5")

router = APIRouter(prefix="/v1", tags=["phase5"])


# ---------------------------------------------------------------------------
# 工具: 校验 draft 归属 (避免越权)
# ---------------------------------------------------------------------------

async def _check_draft_owner(s, draft_id: int, user: User) -> ScriptDraft:
    draft = await s.get(ScriptDraft, draft_id)
    if not draft:
        raise HTTPException(404, "draft not found")
    if user.role not in ("admin", "superadmin") and draft.user_id != user.id:
        raise HTTPException(403, "no permission")
    return draft


# ===========================================================================
# 1. 角色管理
# ===========================================================================

class CharacterIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    role: str = ""
    appearance: str = ""
    personality: str = ""
    backstory: str = ""
    avatar_url: str = ""
    avatar_prompt: str = ""
    traits: list[str] = []
    sort_order: int = 0


@router.get("/drafts/{draft_id}/characters")
async def list_characters(draft_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
        rows = (await s.execute(
            select(Character).where(Character.draft_id == draft_id, Character.is_active.is_(True))
            .order_by(Character.sort_order, Character.id)
        )).scalars().all()
        return {"items": [_dump_character(c) for c in rows]}


@router.post("/drafts/{draft_id}/characters")
async def create_character(draft_id: int, body: CharacterIn, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
        c = Character(
            draft_id=draft_id,
            name=body.name,
            role=body.role,
            appearance=body.appearance,
            personality=body.personality,
            backstory=body.backstory,
            avatar_url=body.avatar_url,
            avatar_prompt=body.avatar_prompt,
            traits=body.traits or [],
            sort_order=body.sort_order,
        )
        s.add(c)
        await s.flush()
        await s.refresh(c)
        return _dump_character(c)


@router.patch("/drafts/{draft_id}/characters/{cid}")
async def update_character(draft_id: int, cid: int, body: CharacterIn, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
        c = await s.get(Character, cid)
        if not c or c.draft_id != draft_id:
            raise HTTPException(404, "character not found")
        for k in ("name", "role", "appearance", "personality", "backstory", "avatar_url", "avatar_prompt", "sort_order"):
            setattr(c, k, getattr(body, k))
        c.traits = body.traits or []
        await s.flush()
        await s.refresh(c)
        return _dump_character(c)


@router.delete("/drafts/{draft_id}/characters/{cid}")
async def delete_character(draft_id: int, cid: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
        c = await s.get(Character, cid)
        if not c or c.draft_id != draft_id:
            raise HTTPException(404, "character not found")
        c.is_active = False  # soft delete
        return {"ok": True}


@router.get("/drafts/{draft_id}/characters/relationships")
async def list_relationships(draft_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
        rows = (await s.execute(
            select(CharacterRelationship).where(CharacterRelationship.draft_id == draft_id)
        )).scalars().all()
        return {"items": [
            {
                "id": r.id, "from": r.from_character_id, "to": r.to_character_id,
                "type": r.relation_type, "strength": r.strength, "description": r.description,
            }
            for r in rows
        ]}


class RelationshipIn(BaseModel):
    from_character_id: int
    to_character_id: int
    relation_type: str = ""
    strength: int = 50
    description: str = ""


@router.post("/drafts/{draft_id}/characters/relationships")
async def create_relationship(draft_id: int, body: RelationshipIn, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
        r = CharacterRelationship(
            draft_id=draft_id,
            from_character_id=body.from_character_id,
            to_character_id=body.to_character_id,
            relation_type=body.relation_type,
            strength=max(0, min(100, body.strength)),
            description=body.description,
        )
        s.add(r)
        await s.flush()
        await s.refresh(r)
        return {"id": r.id}


@router.delete("/drafts/{draft_id}/characters/relationships/{rid}")
async def delete_relationship(draft_id: int, rid: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
        r = await s.get(CharacterRelationship, rid)
        if not r or r.draft_id != draft_id:
            raise HTTPException(404, "relationship not found")
        await s.delete(r)
        return {"ok": True}


@router.get("/drafts/{draft_id}/characters/warnings")
async def list_warnings(draft_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
        rows = (await s.execute(
            select(CharacterConsistencyWarning)
            .where(CharacterConsistencyWarning.draft_id == draft_id)
            .order_by(CharacterConsistencyWarning.resolved, desc(CharacterConsistencyWarning.created_at))
        )).scalars().all()
        return {"items": [
            {
                "id": w.id, "character_id": w.character_id, "character_name": w.character_name,
                "chapter_orders": w.chapter_orders, "warning_type": w.warning_type,
                "severity": w.severity, "description": w.description,
                "suggestion": w.suggestion, "resolved": w.resolved,
            }
            for w in rows
        ]}


@router.post("/drafts/{draft_id}/characters/cards/build")
async def build_cards(
    draft_id: int,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
):
    """一键生成角色卡库: 全盘扫描剧情, 抽取所有角色 + 人际关系网 (异步)。

    与设定圣经区分: 圣经侧重主角一致性, 卡库覆盖全员关系分析。
    完成后 GET characters / relationships 即可看到结果。
    """
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
    from .character_cards_worker import build_character_cards
    background.add_task(build_character_cards, draft_id)
    return {"ok": True, "queued": True}


@router.post("/drafts/{draft_id}/characters/warnings/scan")
async def scan_warnings(
    draft_id: int,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
):
    """触发角色一致性扫描 (§12.6.7). 异步执行, 完成后 list 即可看到新告警."""
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
    from .character_consistency_worker import scan_character_consistency
    background.add_task(scan_character_consistency, draft_id)
    return {"ok": True, "queued": True}


@router.patch("/drafts/{draft_id}/characters/warnings/{wid}/resolve")
async def resolve_warning(draft_id: int, wid: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
        w = await s.get(CharacterConsistencyWarning, wid)
        if not w or w.draft_id != draft_id:
            raise HTTPException(404, "warning not found")
        w.resolved = True
        return {"ok": True}


def _dump_character(c: Character) -> dict:
    return {
        "id": c.id,
        "draft_id": c.draft_id,
        "name": c.name,
        "role": c.role,
        "appearance": c.appearance,
        "personality": c.personality,
        "backstory": c.backstory,
        "avatar_url": c.avatar_url,
        "avatar_prompt": c.avatar_prompt,
        "traits": c.traits or [],
        "sort_order": c.sort_order,
        "is_active": c.is_active,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


# ===========================================================================
# 2. 安全报告持久化
# ===========================================================================

class SafetyReportIn(BaseModel):
    scope: str = "full"
    overall: str = "pass"
    summary: str = ""
    high_count: int = 0
    medium_count: int = 0
    low_count: int = 0
    scores: dict = {}
    risks: list[dict] = []


@router.get("/drafts/{draft_id}/safety-reports")
async def list_safety_reports(draft_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
        rows = (await s.execute(
            select(SafetyReport)
            .where(SafetyReport.draft_id == draft_id)
            .order_by(desc(SafetyReport.created_at))
            .limit(20)
        )).scalars().all()
        return {"items": [_dump_safety_report(r) for r in rows]}


@router.post("/drafts/{draft_id}/safety-reports")
async def create_safety_report(draft_id: int, body: SafetyReportIn, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
        total = body.high_count + body.medium_count + body.low_count
        report = SafetyReport(
            draft_id=draft_id,
            scope=body.scope,
            overall=body.overall,
            summary=body.summary,
            total_issues=total,
            high_count=body.high_count,
            medium_count=body.medium_count,
            low_count=body.low_count,
            unresolved_count=total,
            scores_json=body.scores,
        )
        s.add(report)
        await s.flush()
        for r in body.risks:
            risk = SafetyRisk(
                report_id=report.id,
                category=r.get("category"),
                severity=r.get("severity", "medium"),
                keyword=r.get("keyword", ""),
                snippet=r.get("snippet", ""),
                chapter_order=r.get("chapter_order"),
                position=r.get("position"),
                reason=r.get("reason", ""),
                suggestion=r.get("suggestion", ""),
            )
            s.add(risk)
        await s.flush()
        await s.refresh(report)
        return {"id": report.id, "total": total}


@router.get("/drafts/{draft_id}/safety-reports/{report_id}")
async def get_safety_report(draft_id: int, report_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
        report = await s.get(SafetyReport, report_id)
        if not report or report.draft_id != draft_id:
            raise HTTPException(404, "report not found")
        risks = (await s.execute(
            select(SafetyRisk).where(SafetyRisk.report_id == report.id)
            .order_by(SafetyRisk.severity, SafetyRisk.id)
        )).scalars().all()
        out = _dump_safety_report(report)
        out["risks"] = [
            {
                "id": r.id, "category": r.category, "severity": r.severity,
                "keyword": r.keyword, "snippet": r.snippet,
                "chapter_order": r.chapter_order, "position": r.position,
                "reason": r.reason, "suggestion": r.suggestion,
                "is_resolved": r.is_resolved,
            }
            for r in risks
        ]
        return out


@router.post("/drafts/{draft_id}/safety-risks/{risk_id}/resolve")
async def resolve_safety_risk(draft_id: int, risk_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
        r = await s.get(SafetyRisk, risk_id)
        if not r:
            raise HTTPException(404, "risk not found")
        report = await s.get(SafetyReport, r.report_id)
        if not report or report.draft_id != draft_id:
            raise HTTPException(404, "risk not found")
        if not r.is_resolved:
            r.is_resolved = True
            r.resolved_at = datetime.now(timezone.utc)
            report.unresolved_count = max(0, (report.unresolved_count or 0) - 1)
        return {"ok": True, "unresolved": report.unresolved_count}


def _dump_safety_report(r: SafetyReport) -> dict:
    return {
        "id": r.id,
        "draft_id": r.draft_id,
        "scope": r.scope,
        "overall": r.overall,
        "summary": r.summary,
        "total_issues": r.total_issues,
        "high_count": r.high_count,
        "medium_count": r.medium_count,
        "low_count": r.low_count,
        "unresolved_count": r.unresolved_count,
        "scores": r.scores_json or {},
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


# ===========================================================================
# 3. 导出任务异步队列
# ===========================================================================

class ExportJobIn(BaseModel):
    draft_id: int
    kind: str
    config: dict = {}


@router.post("/export-jobs")
async def create_export_job(
    body: ExportJobIn,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
):
    async with session_scope() as s:
        await _check_draft_owner(s, body.draft_id, user)
        job = ExportJob(
            user_id=user.id,
            draft_id=body.draft_id,
            kind=body.kind,
            config_json=body.config,
        )
        s.add(job)
        await s.flush()
        job_id = job.id
        kind = job.kind
        status = job.status
    # 在事务提交后再调度 worker, 避免 worker 看不到 row
    if kind in ("mixed_docx",):
        from .export_worker import run_export_job
        background.add_task(run_export_job, job_id)
    return {"id": job_id, "status": status}


class BatchExportIn(BaseModel):
    """批量导出选中草稿。

    mode 三种:
      - "all_chapter":    仅原文(每集都用 full_text)
      - "all_storyboard": 仅剧本(每集都用 storyboard)
      - "auto":           推荐(有剧本的集用剧本, 没剧本的集用原文; 缺哪个自动兜底另一个)
    """
    draft_ids: list[int] = Field(..., description="要导出的草稿ID列表")
    mode: str = Field("auto", description="all_chapter | all_storyboard | auto")


@router.post("/export-jobs/batch")
async def create_batch_export_jobs(
    body: BatchExportIn,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
):
    """为一批草稿各建一个 mixed_docx 导出任务(三模式: 仅原文/仅剧本/推荐)。

    每个草稿一个 ExportJob, 前端可用 GET /v1/export-jobs 轮询各自进度/下载 URL。
    """
    if not body.draft_ids:
        raise HTTPException(400, "draft_ids 不能为空")
    if len(body.draft_ids) > 300:
        raise HTTPException(400, "单次批量导出上限 300 个草稿")
    if body.mode not in ("all_chapter", "all_storyboard", "auto"):
        raise HTTPException(400, "mode 只能是 all_chapter | all_storyboard | auto")

    created, skipped = [], []
    job_ids: list[int] = []
    async with session_scope() as s:
        for did in body.draft_ids:
            try:
                await _check_draft_owner(s, did, user)
            except HTTPException:
                skipped.append({"draft_id": did, "reason": "无权限或不存在"})
                continue
            job = ExportJob(
                user_id=user.id,
                draft_id=did,
                kind="mixed_docx",
                config_json={"mode": body.mode},
            )
            s.add(job)
            await s.flush()
            job_ids.append(job.id)
            created.append({"draft_id": did, "job_id": job.id})
    # 事务提交后再调度 worker
    from .export_worker import run_export_job
    for jid in job_ids:
        background.add_task(run_export_job, jid)

    return {
        "ok": True, "mode": body.mode,
        "created": created, "skipped": skipped,
        "message": f"已提交 {len(created)} 个导出任务" + (f", 跳过 {len(skipped)} 个" if skipped else ""),
    }


@router.post("/export-jobs/zip")
async def create_zip_export_job(
    body: BatchExportIn,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
):
    """批量导出并打包成【一个 ZIP】: 建单个 ExportJob(kind=batch_zip), 后台生成所有 docx
    塞进一个压缩包上传 OSS。前端轮询这一个 job, done 后拿 output_url 直接下载整包。
    (相比 /batch 一部一个任务、让用户逐个点下载, 这里只出一个压缩包一次下载。)
    """
    if not body.draft_ids:
        raise HTTPException(400, "draft_ids 不能为空")
    if len(body.draft_ids) > 300:
        raise HTTPException(400, "单次批量导出上限 300 个草稿")
    if body.mode not in ("all_chapter", "all_storyboard", "auto"):
        raise HTTPException(400, "mode 只能是 all_chapter | all_storyboard | auto")

    valid_ids: list[int] = []
    skipped: list[dict] = []
    async with session_scope() as s:
        for did in body.draft_ids:
            try:
                await _check_draft_owner(s, did, user)
                valid_ids.append(did)
            except HTTPException:
                skipped.append({"draft_id": did, "reason": "无权限或不存在"})
        if not valid_ids:
            raise HTTPException(400, "没有可导出的有效草稿")
        job = ExportJob(
            user_id=user.id,
            draft_id=valid_ids[0],  # 占位(表非空约束); 真实清单在 config_json
            kind="batch_zip",
            config_json={"mode": body.mode, "draft_ids": valid_ids},
        )
        s.add(job)
        await s.flush()
        job_id = job.id

    from .export_worker import run_export_job
    background.add_task(run_export_job, job_id)

    return {
        "ok": True, "mode": body.mode, "job_id": job_id,
        "count": len(valid_ids), "skipped": skipped,
        "message": f"已提交打包任务({len(valid_ids)} 部), 完成后一个压缩包下载"
                   + (f", 跳过 {len(skipped)} 个" if skipped else ""),
    }


@router.get("/export-jobs")
async def list_export_jobs(draft_id: Optional[int] = None, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        q = select(ExportJob).where(ExportJob.user_id == user.id)
        if draft_id:
            q = q.where(ExportJob.draft_id == draft_id)
        q = q.order_by(desc(ExportJob.created_at)).limit(50)
        rows = (await s.execute(q)).scalars().all()
        return {"items": [
            {
                "id": j.id, "draft_id": j.draft_id, "kind": j.kind, "status": j.status,
                "progress": j.progress, "output_url": j.output_url, "error": j.error,
                "created_at": j.created_at.isoformat() if j.created_at else None,
                "finished_at": j.finished_at.isoformat() if j.finished_at else None,
            }
            for j in rows
        ]}


@router.get("/export-jobs/{job_id}")
async def get_export_job(job_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        j = await s.get(ExportJob, job_id)
        if not j or j.user_id != user.id:
            raise HTTPException(404, "job not found")
        return {
            "id": j.id, "draft_id": j.draft_id, "kind": j.kind, "status": j.status,
            "progress": j.progress, "output_url": j.output_url, "error": j.error,
            "config": j.config_json,
            "created_at": j.created_at.isoformat() if j.created_at else None,
            "started_at": j.started_at.isoformat() if j.started_at else None,
            "finished_at": j.finished_at.isoformat() if j.finished_at else None,
        }


# ===========================================================================
# 4. 配额查询 (前端 image2 / 速转 用)
# ===========================================================================

@router.get("/quotas/me")
async def my_quotas(user: User = Depends(get_current_user)):
    """获取当前用户今天的配额使用情况."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    async with session_scope() as s:
        # prompt_converter
        pc_row = (await s.execute(
            select(PromptConverterQuota).where(
                PromptConverterQuota.user_id == user.id,
                PromptConverterQuota.quota_date == today,
            )
        )).scalars().first()
        if not pc_row:
            pc_row = PromptConverterQuota(user_id=user.id, quota_date=today, used_count=0, daily_limit=20)
            s.add(pc_row)
            await s.flush()
        # image_generation
        img_row = (await s.execute(
            select(ImageGenerationQuota).where(
                ImageGenerationQuota.user_id == user.id,
                ImageGenerationQuota.quota_date == today,
                ImageGenerationQuota.kind == "any",
            )
        )).scalars().first()
        if not img_row:
            img_row = ImageGenerationQuota(user_id=user.id, quota_date=today, used_count=0, daily_limit=10, kind="any")
            s.add(img_row)
            await s.flush()
        return {
            "date": today,
            "prompt_converter": {
                "used": pc_row.used_count,
                "limit": pc_row.daily_limit,
                "remaining": max(0, pc_row.daily_limit - pc_row.used_count),
            },
            "image_generation": {
                "used": img_row.used_count,
                "limit": img_row.daily_limit,
                "remaining": max(0, img_row.daily_limit - img_row.used_count),
            },
        }


@router.post("/quotas/me/consume")
async def consume_quota(
    kind: str = Query(..., pattern="^(prompt_converter|image_generation)$"),
    count: int = Query(1, ge=1, le=10),
    user: User = Depends(get_current_user),
):
    """消费配额. kind ∈ {prompt_converter, image_generation}."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    async with session_scope() as s:
        if kind == "prompt_converter":
            row = (await s.execute(
                select(PromptConverterQuota).where(
                    PromptConverterQuota.user_id == user.id,
                    PromptConverterQuota.quota_date == today,
                )
            )).scalars().first()
            if not row:
                row = PromptConverterQuota(user_id=user.id, quota_date=today, used_count=0, daily_limit=20)
                s.add(row)
                await s.flush()
        else:
            row = (await s.execute(
                select(ImageGenerationQuota).where(
                    ImageGenerationQuota.user_id == user.id,
                    ImageGenerationQuota.quota_date == today,
                    ImageGenerationQuota.kind == "any",
                )
            )).scalars().first()
            if not row:
                row = ImageGenerationQuota(user_id=user.id, quota_date=today, used_count=0, daily_limit=10, kind="any")
                s.add(row)
                await s.flush()

        if row.used_count + count > row.daily_limit:
            raise HTTPException(429, f"quota exceeded: used {row.used_count}/{row.daily_limit}")
        row.used_count += count
        return {"used": row.used_count, "limit": row.daily_limit, "remaining": row.daily_limit - row.used_count}


# ===========================================================================
# 5. 邮箱验证码
# ===========================================================================

class EmailSendIn(BaseModel):
    email: str
    purpose: str = "register"


class EmailVerifyIn(BaseModel):
    email: str
    code: str
    purpose: str = "register"


@router.post("/auth/email/send-code")
async def send_email_code(body: EmailSendIn):
    """生成邮箱验证码并 (TODO 集成 SMTP) 发送. 现在仅入库, 在 dev 中可通过 admin 查询."""
    code = "".join(random.choices(string.digits, k=6))
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=10)
    async with session_scope() as s:
        # 失效旧码
        await s.execute(
            select(EmailVerification).where(
                EmailVerification.email == body.email,
                EmailVerification.purpose == body.purpose,
                EmailVerification.status == "pending",
            )
        )
        ev = EmailVerification(
            email=body.email,
            code=code,
            purpose=body.purpose,
            status="pending",
            expires_at=expires_at,
        )
        s.add(ev)
        await s.flush()
    logger.info(f"[email-code] email={body.email} code={code} purpose={body.purpose}")
    # dev 环境直接返回 code, 生产应只返回 ok
    return {"ok": True, "dev_code": code, "expires_at": expires_at.isoformat()}


@router.post("/auth/email/verify-code")
async def verify_email_code(body: EmailVerifyIn):
    async with session_scope() as s:
        ev = (await s.execute(
            select(EmailVerification).where(
                EmailVerification.email == body.email,
                EmailVerification.purpose == body.purpose,
                EmailVerification.status == "pending",
            ).order_by(desc(EmailVerification.created_at)).limit(1)
        )).scalars().first()
        if not ev:
            raise HTTPException(400, "no pending code")
        if ev.expires_at and ev.expires_at < datetime.now(timezone.utc).replace(tzinfo=ev.expires_at.tzinfo):
            ev.status = "expired"
            raise HTTPException(400, "code expired")
        ev.attempts = (ev.attempts or 0) + 1
        if ev.attempts > 5:
            ev.status = "expired"
            raise HTTPException(429, "too many attempts")
        if ev.code != body.code:
            raise HTTPException(400, "code mismatch")
        ev.status = "verified"
        ev.verified_at = datetime.now(timezone.utc)
        return {"ok": True}


# ===========================================================================
# 6. 续写偏好
# ===========================================================================

class ExtendConfigIn(BaseModel):
    default_target_episodes: int = 20
    default_chunk_size: int = 20
    default_word_target: int = DEFAULT_CHAPTER_WORD_TARGET
    default_provider: str = "gemini"
    forced_level: Optional[str] = None
    user_guidance_template: str = ""


@router.get("/drafts/{draft_id}/extend-config")
async def get_extend_config(draft_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
        cfg = (await s.execute(
            select(DraftExtendConfig).where(DraftExtendConfig.draft_id == draft_id)
        )).scalars().first()
        if not cfg:
            return {
                "default_target_episodes": 20,
                "default_chunk_size": 20,
                "default_word_target": DEFAULT_CHAPTER_WORD_TARGET,
                "default_provider": "gemini",
                "forced_level": None,
                "user_guidance_template": "",
            }
        return _dump_extend_config(cfg)


@router.put("/drafts/{draft_id}/extend-config")
async def set_extend_config(draft_id: int, body: ExtendConfigIn, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_draft_owner(s, draft_id, user)
        cfg = (await s.execute(
            select(DraftExtendConfig).where(DraftExtendConfig.draft_id == draft_id)
        )).scalars().first()
        if not cfg:
            cfg = DraftExtendConfig(draft_id=draft_id)
            s.add(cfg)
        cfg.default_target_episodes = body.default_target_episodes
        cfg.default_chunk_size = body.default_chunk_size
        cfg.default_word_target = body.default_word_target
        cfg.default_provider = body.default_provider
        cfg.forced_level = body.forced_level
        cfg.user_guidance_template = body.user_guidance_template
        await s.flush()
        return _dump_extend_config(cfg)


def _dump_extend_config(cfg: DraftExtendConfig) -> dict:
    return {
        "default_target_episodes": cfg.default_target_episodes,
        "default_chunk_size": cfg.default_chunk_size,
        "default_word_target": cfg.default_word_target,
        "default_provider": cfg.default_provider,
        "forced_level": cfg.forced_level,
        "user_guidance_template": cfg.user_guidance_template,
    }


# ===========================================================================
# 7. Agent 浮窗附件 / 产出物
# ===========================================================================

async def _check_conv_owner(s, conv_id: int, user: User) -> AgentConversation:
    conv = await s.get(AgentConversation, conv_id)
    if not conv:
        raise HTTPException(404, "conversation not found")
    if user.role not in ("admin", "superadmin") and conv.user_id != user.id:
        raise HTTPException(403, "no permission")
    return conv


class AttachmentIn(BaseModel):
    message_id: Optional[int] = None
    kind: str = "image"
    filename: str = ""
    oss_url: str
    size_bytes: int = 0
    mime_type: str = ""


@router.get("/agent/conversations/{conv_id}/attachments")
async def list_attachments(conv_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_conv_owner(s, conv_id, user)
        rows = (await s.execute(
            select(AgentAttachment).where(AgentAttachment.conversation_id == conv_id)
            .order_by(desc(AgentAttachment.created_at))
        )).scalars().all()
        return {"items": [
            {
                "id": a.id, "message_id": a.message_id, "kind": a.kind,
                "filename": a.filename, "oss_url": a.oss_url,
                "size_bytes": a.size_bytes, "mime_type": a.mime_type,
                "created_at": a.created_at.isoformat() if a.created_at else None,
            }
            for a in rows
        ]}


@router.post("/agent/conversations/{conv_id}/attachments")
async def add_attachment(conv_id: int, body: AttachmentIn, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_conv_owner(s, conv_id, user)
        a = AgentAttachment(
            conversation_id=conv_id,
            message_id=body.message_id,
            user_id=user.id,
            kind=body.kind,
            filename=body.filename,
            oss_url=body.oss_url,
            size_bytes=body.size_bytes,
            mime_type=body.mime_type,
        )
        s.add(a)
        await s.flush()
        return {"id": a.id}


class ArtifactIn(BaseModel):
    message_id: Optional[int] = None
    kind: str = "text"
    title: str = ""
    content: str = ""
    metadata: dict = {}
    is_pinned: bool = False


@router.get("/agent/conversations/{conv_id}/artifacts")
async def list_artifacts(conv_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_conv_owner(s, conv_id, user)
        rows = (await s.execute(
            select(AgentArtifact).where(AgentArtifact.conversation_id == conv_id)
            .order_by(desc(AgentArtifact.is_pinned), desc(AgentArtifact.created_at))
        )).scalars().all()
        return {"items": [
            {
                "id": a.id, "message_id": a.message_id, "kind": a.kind,
                "title": a.title, "content": a.content,
                "metadata": a.metadata_json or {},
                "is_pinned": a.is_pinned,
                "created_at": a.created_at.isoformat() if a.created_at else None,
            }
            for a in rows
        ]}


@router.post("/agent/conversations/{conv_id}/artifacts")
async def add_artifact(conv_id: int, body: ArtifactIn, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _check_conv_owner(s, conv_id, user)
        a = AgentArtifact(
            conversation_id=conv_id,
            message_id=body.message_id,
            user_id=user.id,
            kind=body.kind,
            title=body.title,
            content=body.content,
            metadata_json=body.metadata,
            is_pinned=body.is_pinned,
        )
        s.add(a)
        await s.flush()
        return {"id": a.id}


@router.patch("/agent/artifacts/{artifact_id}/pin")
async def toggle_pin(artifact_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        a = await s.get(AgentArtifact, artifact_id)
        if not a or a.user_id != user.id:
            raise HTTPException(404, "artifact not found")
        a.is_pinned = not a.is_pinned
        return {"is_pinned": a.is_pinned}


@router.delete("/agent/artifacts/{artifact_id}")
async def delete_artifact(artifact_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        a = await s.get(AgentArtifact, artifact_id)
        if not a or a.user_id != user.id:
            raise HTTPException(404, "artifact not found")
        await s.delete(a)
        return {"ok": True}
