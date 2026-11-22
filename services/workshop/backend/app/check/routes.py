"""⚠️ 本模块的 **POST /v1/check、POST /v1/check/fix、GET /v1/check/fix/{job_id}
三个端点已于 2026-09-22 标记 deprecated**（PLAN-v2收编与v1退役 §1.6）。

原因：对话里的体检/修复**不经过它们** —— `agent/routes.py` 直接调
`check.engine.run_check` 与 `check.fixer`。这三个是同一能力的第二入口，
属 v1「功能冗余」的典型，v2 不会调用。

**保留** `GET /reports` 与 `GET /reports/{id}`：那是对话路径**没有**的能力
（体检结果现在只活在对话消息里，翻聊天记录才找得回），
v2 要把它做成报告卡上的"查看历史报告"。

标 deprecated 而不是直接删：旧工作台仍在运行，v1 退役前不能断它的腿。
体检 / 定点修复 API —— 对话工坊的三个入口。

  POST /v1/check            跑一次体检(同步跑: 体检是只读的, 秒级返回)
  POST /v1/check/fix        按 issue_id 定点修复(异步: 要调 LLM 改剧本, 走队列)
  GET  /v1/check/reports/{id} 取某份报告

设计要点:

· **体检同步、修复异步**。体检不改任何数据(纯读 + LLM 只读分析), 秒级能返回,
  用户点一下就出卡片, 等待感最小。修复是覆写操作, 且要跑好几集 LLM, 必须走
  队列(关掉页面也要跑完), 前端靠 SSE + 作业轮询看进度。

· **修复只接受 issue_id**。请求体里带的是 id 列表, 内容从 check_reports 取。
  这样前端(或被篡改的前端)不可能构造"帮我修这条并不存在的问题"。
  报告 id 也要校验归属, 防止拿别人的草稿 id 去改。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from ..auth import get_current_user, User
from ..db import session_scope, ScriptDraft, CheckReport
from .engine import run_check, ALL_KINDS, KIND_LABEL

logger = logging.getLogger("check.routes")

router = APIRouter(prefix="/v1/check", tags=["check"])


# ---------------------------------------------------------------------------
# 请求模型
# ---------------------------------------------------------------------------

class CheckBody(BaseModel):
    """额外字段一律 422: 请求体与 schema 漂移要在入口就暴露, 不要静默忽略。"""
    model_config = ConfigDict(extra="forbid")

    draft_id: int
    #: 要查哪几类; 空 = 全部四类
    kinds: list[str] = Field(default_factory=list)
    #: 范围 {"start_ep": int|null, "end_ep": int|null}; 缺省 = 整本
    scope: dict | None = None
    #: 是否跑 LLM 深度层(跨集逻辑矛盾只有 LLM 看得出)。关掉 = 纯规则层, 更快更省
    deep: bool = True
    #: 报告要不要挂到某条消息上(前端渲染卡片用); 0 = 不挂
    message_id: int = 0
    #: 关掉"persona 无关"的深度层时用哪个模型厂商
    provider: str = "gemini"


class FixBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    draft_id: int
    #: 要修的问题 id 列表(来自某份报告)。**只传 id, 不传内容**。
    issue_ids: list[str] = Field(default_factory=list)
    #: 报告 id; 缺省 = 该草稿最新一份报告
    report_id: int = 0


# ---------------------------------------------------------------------------
# 归属校验
# ---------------------------------------------------------------------------

async def _load_draft_checked(draft_id: int, user: User) -> ScriptDraft:
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
    if not d:
        raise HTTPException(404, "draft not found")
    if user.role not in ("admin", "superadmin") and d.user_id != user.id:
        raise HTTPException(403, "无权操作该草稿")
    return d


def _norm_kinds(kinds: list[str]) -> tuple:
    picked = tuple(k for k in (kinds or []) if k in ALL_KINDS)
    return picked or ALL_KINDS


# ---------------------------------------------------------------------------
# 体检
# ---------------------------------------------------------------------------

@router.post("", deprecated=True)
async def do_check(body: CheckBody, user: User = Depends(get_current_user)):
    """跑一次体检。同步返回完整报告, 并把报告落库(供定点修复按 id 取回)。"""
    d = await _load_draft_checked(body.draft_id, user)
    kinds = _norm_kinds(body.kinds)

    try:
        report = await run_check(
            draft_id=body.draft_id, kinds=kinds, scope=body.scope,
            provider=body.provider or "gemini", deep=bool(body.deep))
    except Exception as ex:  # noqa: BLE001
        logger.exception("体检失败 draft=%s", body.draft_id)
        raise HTTPException(500, f"体检失败：{ex}") from ex

    from .fixer import index_issues
    idx = index_issues(report)
    async with session_scope() as s:
        row = CheckReport(
            draft_id=body.draft_id, user_id=user.id,
            kinds=list(kinds), scope=body.scope,
            report=report, issue_index=idx,
        )
        s.add(row)
        await s.flush()
        report_id = row.id

        # 挂到消息上(前端刷新页面后还能从历史里把卡片渲染回来)
        if body.message_id:
            from ..db import AgentMessage
            m = await s.get(AgentMessage, body.message_id)
            if m and m.conversation_id:
                m.report_json = {"report_id": report_id, **report}

    report["report_id"] = report_id
    report["issue_count"] = len(idx)
    report["kinds_label"] = [KIND_LABEL.get(k, k) for k in kinds]
    logger.info("体检完成 draft=%s report=%s issues=%d err=%d warn=%d",
                body.draft_id, report_id, len(idx),
                (report.get("totals") or {}).get("error", 0),
                (report.get("totals") or {}).get("warn", 0))
    # 报告放在 report 里(与 agent 那条 SSE 事件的形状一致), 顶层只留寻址信息 ——
    # 同一份报告在两条链路上形状不同, 前端就得写两套取值逻辑。
    return {"ok": True, "report_id": report_id, "draft_id": body.draft_id,
            "report": report, "issue_index": idx,
            "issue_count": len(idx), "kinds_label": report["kinds_label"]}


@router.get("/reports/{report_id}")
async def get_report(report_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        r = await s.get(CheckReport, report_id)
        if not r:
            raise HTTPException(404, "report not found")
        d = await s.get(ScriptDraft, r.draft_id)
    if d and user.role not in ("admin", "superadmin") and d.user_id != user.id:
        raise HTTPException(403, "无权查看该报告")
    return {"ok": True, "report": r.report or {}, "issue_index": r.issue_index or {},
            "report_id": r.id, "created_at": r.created_at.isoformat() if r.created_at else None}


@router.get("/reports")
async def list_reports(draft_id: int, limit: int = 10,
                       user: User = Depends(get_current_user)):
    """该草稿的体检历史(不含完整报告体, 只给摘要, 免得列表接口拖几百 KB)。"""
    await _load_draft_checked(draft_id, user)
    async with session_scope() as s:
        rows = (await s.execute(
            select(CheckReport).where(CheckReport.draft_id == draft_id)
            .order_by(CheckReport.id.desc()).limit(max(1, min(50, limit)))
        )).scalars().all()
    return {"ok": True, "items": [{
        "id": r.id,
        "kinds": r.kinds or [],
        "scope": r.scope,
        "totals": (r.report or {}).get("totals") or {},
        "created_at": r.created_at.isoformat() if r.created_at else None,
    } for r in rows]}


# ---------------------------------------------------------------------------
# 定点修复
# ---------------------------------------------------------------------------

@router.post("/fix", deprecated=True)
async def do_fix(body: FixBody, user: User = Depends(get_current_user)):
    """按 issue_id 定点修复。入队, 立即返回 job_id。

    走队列(不走 asyncio.create_task): 修复要跑好几集 LLM, 是用户**关掉页面也要
    跑完**的场景; 且修复是覆写操作, 崩溃后必须能被重放接管(靠 history 与
    check_reports 的 id 保证重放安全)。
    """
    if not body.issue_ids:
        raise HTTPException(400, "没有要修复的问题")

    await _load_draft_checked(body.draft_id, user)

    from ..agent import chat_jobs
    r = await chat_jobs.start_fix(
        draft_id=body.draft_id, user_id=user.id,
        issue_ids=[str(x) for x in body.issue_ids][:200],
        report_id=int(body.report_id or 0))
    if not r.get("ok"):
        raise HTTPException(400, r.get("error") or "无法开始修复")
    return r


@router.get("/fix/{job_id}", deprecated=True)
async def fix_status(job_id: int, user: User = Depends(get_current_user)):
    """修复作业状态(前端在 SSE 断线时用轮询兜底)。"""
    from ..agent import jobs
    async with session_scope() as s:
        j = await s.get(jobs.AgentJob, job_id)
        if not j:
            raise HTTPException(404, "job not found")
        if user.role not in ("admin", "superadmin") and j.user_id not in (None, user.id):
            raise HTTPException(403, "无权查看该作业")
        return {"ok": True, "job": {
            "id": j.id, "kind": j.kind, "status": j.status,
            "progress": j.progress or 0, "note": j.progress_note or "",
            "result": j.result or {}, "error": j.error or "",
        }}
