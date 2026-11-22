"""评审精修路由 (用户端, prefix /v1/critique)。

  POST   /drafts/{draft_id}/start       启动精修 (body: source/intensity/episodes/editor_model/focus)
  GET    /drafts/{draft_id}/runs        该草稿的精修任务历史
  GET    /runs/{run_id}                 单任务详情 (进度看板)
  GET    /runs/{run_id}/result          结果 (逐集 diff + 理由标签)
  POST   /runs/{run_id}/apply           采纳覆盖 (全部或指定集)
  POST   /runs/{run_id}/cancel          取消

═══════════════════════════════════════════════════════════════════════════════
⛔ 2026-09-18 入口审计裁定：**评审精修功能已停用**（验证后完全没有可用性）
═══════════════════════════════════════════════════════════════════════════════

判据：
  - 近 30 天 prod 仅 2 次调用；历史累计 39 次 / 16 人，最后一次 2026-09-01
  - 它与「整本 AI 精修」(rewrite) 都做"AI 审整本 + 改写覆写"，入口高度重叠，
    用户分不清该点哪个
  - 用户 2026-09-18 裁定：这些功能已被对话工坊的「精修这批」按钮取代，
    旧逻辑都可以不要

处理方式：**只停用、不删除**（按用户要求的"注释掉使其不可用"口径）。
  - 下方各"评审精修"端点已逐个注释，并在每处标了停用标注
  - main.py 中 admin_router 的注册已注释
  - service.py / models.py / 数据表全部保留，恢复时取消注释即可

⚠️ **story-bible 的 3 个端点必须保留**（见本文件 story-bible 段）：
   工作台总览中心 _OverviewHub.tsx → lib/critique.ts 正在用它们，
   它们与评审精修共用 /v1/critique 前缀，整块停用会让总览一起失效。
"""

from __future__ import annotations

import logging
from typing import Optional

from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select

from ..auth import get_current_user, User
from ..security import require_admin
from ..db import session_scope
from ..db.models import ScriptDraft
from . import service
from . import roles as R
from .models import CritiqueRun, CritiqueIssue, CritiqueConfig

logger = logging.getLogger("critique")

router = APIRouter(prefix="/v1/critique", tags=["critique"])

# 管理端: 身份/权重/强度档配置 (admin only)
# ⛔ 2026-09-18 已停用：它只服务评审精修的强度/权重配置，功能停用后无用。
#    （main.py 中的注册也已注释，这里保留定义以免恢复时漏改。）
admin_router = APIRouter(
    prefix="/v1/admin-api/critique", tags=["critique-admin"],
    dependencies=[Depends(require_admin)],
)


@admin_router.get("/config")
async def get_config():
    """读取评审精修配置 (无则返回内置默认)。"""
    async with session_scope() as s:
        row = await s.get(CritiqueConfig, 1)
        if row and row.config_json:
            return {"config": row.config_json, "defaults": R.default_config()}
    return {"config": R.default_config(), "defaults": R.default_config()}


class ConfigBody(BaseModel):
    config: dict


@admin_router.put("/config")
async def put_config(body: ConfigBody):
    """覆盖保存评审精修配置 (单行 id=1)。"""
    async with session_scope() as s:
        row = await s.get(CritiqueConfig, 1)
        if not row:
            row = CritiqueConfig(id=1, config_json=body.config)
            s.add(row)
        else:
            row.config_json = body.config
    return {"ok": True, "config": body.config}

_ALLOWED_SOURCE = {"chapter", "storyboard"}
_ALLOWED_INTENSITY = {"light", "standard", "full"}


class StartBody(BaseModel):
    source: str = "chapter"
    intensity: str = "standard"
    episodes: Optional[list[int]] = None
    editor_model: str = "gemini"
    focus: Optional[str] = None


        # [STOPPED 2026-09-18] critique run endpoint disabled - no usability confirmed
# @router.post("/drafts/{draft_id}/start")
async def start(draft_id: int, body: StartBody, user: User = Depends(get_current_user)):
    if body.source not in _ALLOWED_SOURCE:
        raise HTTPException(400, f"source 必须是 {sorted(_ALLOWED_SOURCE)}")
    if body.intensity not in _ALLOWED_INTENSITY:
        raise HTTPException(400, f"intensity 必须是 {sorted(_ALLOWED_INTENSITY)}")
    try:
        run_id = await service.create_and_run(
            user_id=user.id, draft_id=draft_id, source=body.source,
            intensity=body.intensity, episodes=body.episodes,
            editor_model=body.editor_model, focus=body.focus,
        )
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"run_id": run_id, "status": "queued"}


def _run_view(run: CritiqueRun) -> dict:
    return {
        "id": run.id,
        "draft_id": run.draft_id,
        "source": run.source,
        "intensity": run.intensity,
        "status": run.status,
        "progress": run.progress,
        "applied": run.applied,
        "error": run.error,
        "params": run.params,
        "progress_json": run.progress_json,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "updated_at": run.updated_at.isoformat() if run.updated_at else None,
    }


        # [STOPPED 2026-09-18] critique run endpoint disabled - no usability confirmed
# @router.get("/drafts/{draft_id}/runs")
async def list_runs(draft_id: int, user: User = Depends(get_current_user), limit: int = 20):
    limit = max(1, min(limit, 50))
    async with session_scope() as s:
        rows = (await s.execute(
            select(CritiqueRun).where(
                CritiqueRun.draft_id == draft_id, CritiqueRun.user_id == user.id,
            ).order_by(CritiqueRun.id.desc()).limit(limit)
        )).scalars().all()
        return [_run_view(r) for r in rows]


        # [STOPPED 2026-09-18] critique run endpoint disabled - no usability confirmed
# @router.get("/runs/{run_id}")
async def get_run(run_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        run = await s.get(CritiqueRun, run_id)
        if not run or run.user_id != user.id:
            raise HTTPException(404, "run not found")
        return _run_view(run)


        # [STOPPED 2026-09-18] critique run endpoint disabled - no usability confirmed
# @router.get("/runs/{run_id}/result")
async def get_result(run_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        run = await s.get(CritiqueRun, run_id)
        if not run or run.user_id != user.id:
            raise HTTPException(404, "run not found")
        issues = (await s.execute(
            select(CritiqueIssue).where(CritiqueIssue.run_id == run_id)
            .order_by(CritiqueIssue.episode_order, CritiqueIssue.round)
        )).scalars().all()
        issues_by_ep: dict[int, list[dict]] = {}
        for it in issues:
            issues_by_ep.setdefault(it.episode_order, []).append({
                "round": it.round, "theme": it.theme, "role": it.role,
                "severity": it.severity, "confidence": it.confidence,
                "issue": it.issue, "evidence": it.evidence,
                "fix_hint": it.fix_hint, "locator": it.locator,
            })
        return {
            "run": _run_view(run),
            "result": run.result_json or {},
            "issues_by_episode": issues_by_ep,
        }


class ApplyBody(BaseModel):
    episodes: Optional[list[int]] = None


        # [STOPPED 2026-09-18] critique run endpoint disabled - no usability confirmed
# @router.post("/runs/{run_id}/apply")
async def apply(run_id: int, body: ApplyBody, user: User = Depends(get_current_user)):
    try:
        res = await service.apply_run(run_id, user.id, body.episodes)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return res


        # [STOPPED 2026-09-18] critique run endpoint disabled - no usability confirmed
# @router.get("/runs/{run_id}/log.docx")
async def export_log_docx(run_id: int, user: User = Depends(get_current_user)):
    """导出本次精修全过程为可读 Word (建议/采纳/驳回 + 前后对照)。"""
    from .log_export import build_critique_log_docx
    from ..critique.roles import REVIEW_ROLES, GLOBAL_REVIEWER

    async with session_scope() as s:
        run = await s.get(CritiqueRun, run_id)
        if not run or run.user_id != user.id:
            raise HTTPException(404, "run not found")
        if run.status != "succeeded":
            raise HTTPException(400, "仅成功的精修任务可导出过程日志")
        issues = (await s.execute(
            select(CritiqueIssue).where(CritiqueIssue.run_id == run_id)
            .order_by(CritiqueIssue.episode_order, CritiqueIssue.round)
        )).scalars().all()
        draft = await s.get(ScriptDraft, run.draft_id)
        draft_title = (draft.title if draft else None) or f"草稿{run.draft_id}"
        result = dict(run.result_json or {})
        run_view = _run_view(run)

    issues_by_ep: dict[int, list[dict]] = {}
    for it in issues:
        issues_by_ep.setdefault(it.episode_order, []).append({
            "round": it.round, "theme": it.theme, "role": it.role,
            "severity": it.severity, "confidence": it.confidence,
            "issue": it.issue, "evidence": it.evidence, "fix_hint": it.fix_hint,
        })

    # id -> 中文名 映射 (与前端 lib/critique.ts 对齐, 后端独立维护一份)
    _role_names = {rid: cfg.get("name", rid) for rid, cfg in REVIEW_ROLES.items()}
    _role_names[GLOBAL_REVIEWER["id"]] = GLOBAL_REVIEWER["name"]
    _role_names.update({
        "rule_ai_cliche": "规则·AI腔词典", "rule_repeat": "规则·重复检测",
        "rule_narration": "规则·旁白占比",
        "rule_narration_level": "规则·旁白降级建议",
        "rule_scene_name": "规则·场景名一致性",
    })
    _theme_names = {"structure": "结构/逻辑", "character": "人物/动机",
                    "deai": "台词去AI感", "pacing": "节奏/钩子"}
    _model_names = {"gemini": "跨世界观模型", "deepseek": "通用模型",
                    "gpt5": "逻辑专项模型", "qwen": "兜底模型"}
    _intensity_names = {"light": "轻量（单模型·2轮）", "standard": "标准（2模型·4轮）",
                        "full": "全量（3模型·6轮）"}

    data = build_critique_log_docx(
        draft_title=draft_title,
        run=run_view,
        result=result,
        issues_by_ep=issues_by_ep,
        role_label=lambda x: _role_names.get(x, x),
        theme_label=lambda x: _theme_names.get(x, x),
        model_label=lambda x: _model_names.get(x, x),
        intensity_label=lambda x: _intensity_names.get(x, x),
    )
    fname = quote(f"精修过程_{draft_title}_run{run_id}.docx")
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{fname}"},
    )


        # [STOPPED 2026-09-18] critique run endpoint disabled - no usability confirmed
# @router.post("/runs/{run_id}/resume")
async def resume(run_id: int, user: User = Depends(get_current_user)):
    """断点续跑: 把 failed/interrupted/canceled 的任务重新拉起, 跳过已完成的集。

    依赖 service 的增量落盘 (每完成一集即写 result_json): 已完成集会被自动跳过,
    只补未完成的集, 不重复消耗。"""
    import asyncio as _aio
    from . import service as _svc
    async with session_scope() as s:
        run = await s.get(CritiqueRun, run_id)
        if not run or run.user_id != user.id:
            raise HTTPException(404, "run not found")
        if run.status in ("running", "pending"):
            raise HTTPException(409, "任务进行中, 无需续跑")
        if run.status == "succeeded":
            raise HTTPException(400, "任务已完成, 无需续跑")
        # draft 级独占检查
        other = (await s.execute(
            select(CritiqueRun).where(
                CritiqueRun.draft_id == run.draft_id,
                CritiqueRun.status.in_(("pending", "running")),
            )
        )).scalars().first()
        if other:
            raise HTTPException(409, "该草稿已有进行中的精修任务")
        run.status = "pending"
        run.error = None
    _svc._CANCELLED.discard(run_id)
    _aio.create_task(_svc.run_critique(run_id))
    return {"run_id": run_id, "status": "resumed"}


# ── 设定圣经 (v2): 构建 / 读取 / 人工微调 ──
@router.get("/drafts/{draft_id}/story-bible")
async def get_bible(draft_id: int, user: User = Depends(get_current_user)):
    try:
        bible = await service.get_story_bible(draft_id, user.id)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"bible": bible}


class BuildBibleBody(BaseModel):
    source: str = "chapter"


@router.post("/drafts/{draft_id}/story-bible/build")
async def build_bible(draft_id: int, body: BuildBibleBody, user: User = Depends(get_current_user)):
    """通读全剧抽取设定圣经并落库 (可能耗时数十秒)。"""
    try:
        bible = await service.build_story_bible(draft_id, user.id, source=body.source)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"bible": bible}


class UpdateBibleBody(BaseModel):
    bible: dict


@router.put("/drafts/{draft_id}/story-bible")
async def put_bible(draft_id: int, body: UpdateBibleBody, user: User = Depends(get_current_user)):
    try:
        bible = await service.update_story_bible(draft_id, user.id, body.bible)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"bible": bible}


        # [STOPPED 2026-09-18] critique run endpoint disabled - no usability confirmed
# @router.post("/runs/{run_id}/cancel")
async def cancel(run_id: int, user: User = Depends(get_current_user)):
    try:
        st = await service.cancel_run(run_id, user.id)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"run_id": run_id, "status": st}


# ======================================================================
# 跨草稿查询 & 批量断点续跑 (供超级 Agent 技能调用)
# ======================================================================

from datetime import datetime as _dt, timedelta as _td  # noqa: E402


def _parse_dt(s: Optional[str]) -> Optional[_dt]:
    """宽松解析时间: 支持 'YYYY-MM-DD'(北京日期) 或 ISO8601。返回 naive UTC datetime。

    库内 critique_runs.updated_at 存的是 UTC naive (service 用 datetime.utcnow()),
    所以这里统一把输入换算成 UTC naive 再比较:
      - 'YYYY-MM-DD': 视为北京时间当天 00:00 → 减 8 小时得 UTC。
      - ISO8601 带时区: 转 UTC 后去掉 tzinfo。
      - ISO8601 不带时区: 视为北京时间 → 减 8 小时。
    """
    if not s:
        return None
    s = s.strip()
    from datetime import timezone as _tz
    try:
        if len(s) == 10 and s.count("-") == 2:
            d = _dt.strptime(s, "%Y-%m-%d")
            return d - _td(hours=8)
        dtv = _dt.fromisoformat(s.replace("Z", "+00:00"))
        if dtv.tzinfo is not None:
            return dtv.astimezone(_tz.utc).replace(tzinfo=None)
        # 无时区: 当北京时间处理
        return dtv - _td(hours=8)
    except Exception:
        return None


_QUERYABLE_STATUS = {"pending", "running", "succeeded", "failed", "interrupted", "canceled"}


        # [STOPPED 2026-09-18] critique run endpoint disabled - no usability confirmed
# @router.get("/runs")
async def query_runs(
    user: User = Depends(get_current_user),
    since: Optional[str] = None,
    until: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 200,
):
    """跨草稿查询【当前用户】的精修任务 (供 Agent 查'某时段被中断的精修')。

    - since/until: 时间范围 (按 updated_at 过滤)。支持 'YYYY-MM-DD'(北京日期) 或 ISO8601。
    - status: 逗号分隔的状态过滤, 如 'failed,interrupted'。不传=全部。
    - limit: 返回上限 (默认 200, 最大 500)。

    返回按 updated_at 倒序, 每条含 run_id/draft_id/status/progress/error/时间。
    """
    limit = max(1, min(limit, 500))
    conds = [CritiqueRun.user_id == user.id]
    sdt = _parse_dt(since)
    udt = _parse_dt(until)
    if sdt:
        conds.append(CritiqueRun.updated_at >= sdt)
    if udt:
        conds.append(CritiqueRun.updated_at <= udt)
    if status:
        wanted = [x.strip() for x in status.split(",") if x.strip() in _QUERYABLE_STATUS]
        if wanted:
            conds.append(CritiqueRun.status.in_(wanted))
    async with session_scope() as s:
        rows = (await s.execute(
            select(CritiqueRun).where(*conds)
            .order_by(CritiqueRun.updated_at.desc()).limit(limit)
        )).scalars().all()
        items = [{
            "run_id": r.id, "draft_id": r.draft_id, "status": r.status,
            "progress": r.progress, "source": r.source,
            "error": (r.error or "")[:120] or None,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        } for r in rows]
        # 顺带给状态计数, 方便 Agent 概览
        counts: dict[str, int] = {}
        for it in items:
            counts[it["status"]] = counts.get(it["status"], 0) + 1
    return {"total": len(items), "status_counts": counts, "runs": items}


class ResumeBatchBody(BaseModel):
    run_ids: Optional[list[int]] = None      # 指定 run_id 列表; 与下列过滤二选一
    since: Optional[str] = None              # 或按时间段+状态批量续跑
    until: Optional[str] = None
    status: Optional[str] = "failed,interrupted"   # 默认续跑失败/中断的
    max_count: int = 200                     # 安全上限


        # [STOPPED 2026-09-18] critique run endpoint disabled - no usability confirmed
# @router.post("/runs/resume-batch")
async def resume_batch(body: ResumeBatchBody, user: User = Depends(get_current_user)):
    """批量断点续跑 (供 Agent '把某时段中断的精修都续跑')。

    两种用法(二选一):
      1) 传 run_ids: 精确续跑这些 run。
      2) 传 since/until/status: 按条件筛选后批量续跑 (每个 draft 只取最新一条, 避免重复)。

    对每条: 跳过 running/pending(进行中)、succeeded(已完成); 其余(failed/interrupted/canceled)
    重新拉起 run_critique(自动断点续跑, 已完成的集不重跑)。draft 级独占, 同 draft 已有在跑的会跳过。
    """
    import asyncio as _aio
    from . import service as _svc

    # 1) 决定候选 run_id 列表
    target_ids: list[int] = []
    async with session_scope() as s:
        if body.run_ids:
            rows = (await s.execute(
                select(CritiqueRun).where(
                    CritiqueRun.id.in_(body.run_ids),
                    CritiqueRun.user_id == user.id,
                )
            )).scalars().all()
            target_ids = [r.id for r in rows]
        else:
            conds = [CritiqueRun.user_id == user.id]
            sdt = _parse_dt(body.since)
            udt = _parse_dt(body.until)
            if sdt:
                conds.append(CritiqueRun.updated_at >= sdt)
            if udt:
                conds.append(CritiqueRun.updated_at <= udt)
            wanted = [x.strip() for x in (body.status or "").split(",")
                      if x.strip() in _QUERYABLE_STATUS] or ["failed", "interrupted"]
            conds.append(CritiqueRun.status.in_(wanted))
            rows = (await s.execute(
                select(CritiqueRun).where(*conds).order_by(
                    CritiqueRun.draft_id, CritiqueRun.id.desc()
                )
            )).scalars().all()
            # 每个 draft 只取最新一条
            seen_draft: set[int] = set()
            for r in rows:
                if r.draft_id in seen_draft:
                    continue
                seen_draft.add(r.draft_id)
                target_ids.append(r.id)

    target_ids = target_ids[: max(1, min(body.max_count, 500))]

    # 2) 逐个尝试续跑 (复用单条 resume 的校验逻辑)
    resumed: list[int] = []
    skipped: list[dict] = []
    for run_id in target_ids:
        async with session_scope() as s:
            run = await s.get(CritiqueRun, run_id)
            if not run or run.user_id != user.id:
                skipped.append({"run_id": run_id, "reason": "not_found"})
                continue
            if run.status in ("running", "pending"):
                skipped.append({"run_id": run_id, "reason": "in_progress"})
                continue
            if run.status == "succeeded":
                skipped.append({"run_id": run_id, "reason": "already_done"})
                continue
            other = (await s.execute(
                select(CritiqueRun).where(
                    CritiqueRun.draft_id == run.draft_id,
                    CritiqueRun.status.in_(("pending", "running")),
                )
            )).scalars().first()
            if other:
                skipped.append({"run_id": run_id, "reason": "draft_busy"})
                continue
            run.status = "pending"
            run.error = None
        _svc._CANCELLED.discard(run_id)
        _aio.create_task(_svc.run_critique(run_id))
        resumed.append(run_id)

    return {
        "ok": True,
        "resumed_count": len(resumed),
        "resumed": resumed,
        "skipped_count": len(skipped),
        "skipped": skipped[:50],
        "message": f"已续跑 {len(resumed)} 个精修任务, 跳过 {len(skipped)} 个",
    }
