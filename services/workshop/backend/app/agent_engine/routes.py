"""Agent 引擎 HTTP 接口（前缀 /v1/agent-engine）。"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, text, update

from ..auth.dependencies import get_current_user
from ..auth.models import User
from ..db import session_scope
from ..db.models import AgentConversation, AgentMessage
from .events import emit_once
from .models import RUN_ACTIVE, AgentApproval, AgentRun, AgentRunEvent
from .policy import DEFAULT_PERMISSIONS, PERMISSION_LABELS, merge_permissions
from .prompts import PROFILES
from .tools import META

router = APIRouter(prefix="/v1/agent-engine", tags=["agent-engine"])


def _admin(u: User) -> bool:
    return getattr(u, "role", "") in ("admin", "superadmin")


async def _own_run(s, run_id: int, user: User) -> AgentRun:
    r = await s.get(AgentRun, run_id)
    if not r or (r.user_id != user.id and not _admin(user)):
        raise HTTPException(404, "运行不存在")
    return r


def _run_view(r: AgentRun) -> dict:
    return {"id": r.id, "conversation_id": r.conversation_id, "draft_id": r.draft_id, "profile": r.profile,
            "model": r.model, "writing_model": r.writing_model, "status": r.status, "message": r.message, "final_text": r.final_text, "error": r.error,
            "usage": r.usage, "cancel_requested": r.cancel_requested,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            "state": _run_state(r)}


async def _run_states(runs: list[AgentRun]) -> dict[int, dict]:
    """给一批运行补上 `state`（排队中 / 进行中 / 疑似卡住 / 等你确认 …）。

    ## 为什么 AgentRun.status 一个人说了不算（2026-10-24）

    `agent_runs.status = "running"` 只是说"这一轮还没结束"，它**不区分**：
      · 真的在跑（job 已被 worker 领到）；
      · 还在队列里等 worker 领 —— 那时一个字都没写，用户看到的却是"进行中"。
    后者在生产上是常态（排队动辄 1~3 小时），正是用户反复问"是不是卡住了"的来源。

    真相在 `agent_jobs` 那一行：`payload->>'run_id'` 指向这一轮。有作业行就以作业
    状态为准（它带队列位次和心跳），没有作业行（极早期数据）才退回 run 自己的 status。
    """
    from ..agent.job_status import describe
    from ..db import AgentJob
    ids = [r.id for r in runs if r.status in ("queued", "running")]
    jobs_by_run: dict[int, AgentJob] = {}
    pos: dict[int, int] = {}
    if ids:
        async with session_scope() as s:
            rows = (await s.execute(select(AgentJob).where(
                AgentJob.kind == "agent_run",
                AgentJob.status.in_(("queued", "running")),
            ).order_by(AgentJob.id.desc()))).scalars().all()
            for j in rows:
                rid = int((j.payload or {}).get("run_id") or 0)
                if rid in ids and rid not in jobs_by_run:
                    jobs_by_run[rid] = j
            # 出了 session 还要读属性 → 先摘下来（expire_on_commit=False，值已加载）
            for j in jobs_by_run.values():
                s.expunge(j)
        from ..agent import jobs as _jobs
        pos = await _jobs.queue_positions([j.id for j in jobs_by_run.values() if j.status == "queued"])
    out: dict[int, dict] = {}
    for r in runs:
        j = jobs_by_run.get(r.id)
        if j is not None:
            out[r.id] = describe(status=j.status, progress=j.progress, progress_note=j.progress_note,
                                 heartbeat_at=j.heartbeat_at, created_at=j.created_at,
                                 attempt=j.attempt, queue_position=pos.get(j.id))
            # 作业已经不在跑了（done）但 run 还停在 running：说明 worker 死了，
            # 这一轮没有正常收尾。用 run 自己的 status 更贴近真相。
        elif r.status == "awaiting_approval":
            out[r.id] = describe(status="awaiting_approval")
        else:
            out[r.id] = describe(status=r.status, created_at=r.created_at)
    return out


def _run_state(r: AgentRun) -> dict:
    """单条运行的同步版兜底（列表接口用批量的 `_run_states`）。

    这里**不查作业行** —— `_run_view` 是同步函数且被多处调用，加 IO 会让它变成
    到处要 await 的坑。列表/详情接口应当用 `_run_states(runs)[run_id]` 覆盖。
    """
    from ..agent.job_status import describe
    if r.status == "awaiting_approval":
        return describe(status="awaiting_approval")
    return describe(status=r.status, created_at=r.created_at)


# ---------------------------------------------------------------- 运行
class StartRunIn(BaseModel):
    message: str = Field(..., min_length=1, max_length=20000)
    profile: Literal["studio", "producer", "readonly"] = "producer"
    draft_id: int | None = None
    conversation_id: int | None = None
    #: 本次运行使用的模型。⚠️ **已锁定，不再由前端指定**（2026-10-21 用户裁定）：
    #: 对话栏的模型选择器只决定写作模型，Agent 自己怎么想统一用平台默认
    #: （AGENT_ENGINE_MODEL，当前 deepseek-v4-flash）。这里保留字段只为兼容旧页面，
    #: 传什么都按未指定处理 —— 见 start_run 里的强制覆盖。
    model: str | None = Field(None, max_length=80, description="已废弃：Agent 模型锁定为平台默认")
    #: 这一轮派发的写作作业（大纲/正文/剧本/精修）用哪个模型。不传 = 用草稿自己记的写作模型。
    #: 与 model 独立：Agent 自己用什么模型思考，和让它派出去写稿子的模型往往不是一回事。
    writing_model: str | None = Field(None, max_length=80, description="写作作业使用的模型；不传用草稿的设置")


@router.post("/runs")
async def start_run(body: StartRunIn, user: User = Depends(get_current_user)):
    """在会话里发起一轮（没有会话就新建）。同一会话同一时刻只能有一轮在进行。"""
    # 🔒 Agent 自己的模型**锁定为平台默认**（2026-10-21 用户裁定）。
    # 对话栏的模型选择器只决定写作模型。此前它同时决定 Agent 模型，生产上有人选了
    # gpt-6.1-sol → Agent 带工具的请求被 langchain 自动改道 /v1/responses → 第二轮回传
    # item_ 开头的 id 被上游判 400 → 三次重试全废、整轮失败。
    # 这里无条件覆盖而不是"忽略"，是为了让库里 agent_runs.model 记的**就是实际跑的模型**：
    # 留着前端传来的值会让事后对账看到 gpt-6.1-sol，实际跑的却是 deepseek。
    from .llm import DEFAULT_MODEL
    body.model = DEFAULT_MODEL
    if body.writing_model:
        # 只接受"厂商:具体型号"。厂商级老值没有意义（写作模型必须明确到型号），直接丢弃。
        from ..models.catalog import is_allowed, split_provider_model
        prov, mid = split_provider_model(body.writing_model)
        if mid is None:
            body.writing_model = None
        elif not is_allowed(prov, mid):
            raise HTTPException(422, f"不支持的写作模型：{body.writing_model}")
        else:
            body.writing_model = f"{prov}:{mid}"
    if body.profile == "studio" and not body.draft_id:
        raise HTTPException(422, "单剧本模式必须指定 draft_id")
    if body.draft_id:
        from ..stages.access import check_draft_access
        async with session_scope() as s:
            await check_draft_access(s, body.draft_id, user, for_write=body.profile != "readonly")
    async with session_scope() as s:
        if body.conversation_id:
            conv = await s.get(AgentConversation, body.conversation_id)
            if not conv or conv.user_id != user.id or conv.is_deleted or conv.source != "agent":
                raise HTTPException(404, "会话不存在")
            busy = (await s.execute(select(AgentRun.id).where(
                AgentRun.conversation_id == conv.id, AgentRun.status.in_(RUN_ACTIVE)))).scalar_one_or_none()
            if busy:
                raise HTTPException(409, {"message": "这个会话还有一轮在进行，等它结束或先取消", "run_id": busy})
        else:
            conv = AgentConversation(user_id=user.id, draft_id=body.draft_id, source="agent",
                                     title=body.message.strip().replace("\n", " ")[:30] or "新对话")
            s.add(conv)
            await s.flush()
        s.add(AgentMessage(conversation_id=conv.id, role="user", content=body.message))
        from ..models.catalog import split_provider_model
        from .llm import DEFAULT_MODEL, model_on_channel
        # 存**实际会下发**的模型名（"deepseek:deepseek-v4-flash" → "deepseek-v4-flash"），
        # 否则同一次运行在库里、在用量表里、在引擎里是三个不同的字符串，事后没法对账。
        _p, _m = split_provider_model(body.model)
        eff = (_m or DEFAULT_MODEL)
        run = AgentRun(user_id=user.id, conversation_id=conv.id, draft_id=body.draft_id, profile=body.profile,
                       message=body.message, status="queued", model=eff, writing_model=body.writing_model)
        s.add(run)
        await s.flush()
        run_id, conv_id = run.id, conv.id
    from ..agent import jobs
    await jobs.enqueue(kind="agent_run", user_id=user.id, payload={"run_id": run_id})
    return {"run_id": run_id, "conversation_id": conv_id}


@router.get("/runs/{run_id}")
async def get_run(run_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        await _own_run(s, run_id, user)
    # 先自愈再读：孤儿运行（没人推进的 queued / 无待确认项的 awaiting_approval）当场修好，
    # 返回的就是修好之后的状态。
    from .heal import heal_runs
    await heal_runs([run_id])
    async with session_scope() as s:
        r = await _own_run(s, run_id, user)
        aps = (await s.execute(select(AgentApproval).where(AgentApproval.run_id == run_id)
                               .order_by(AgentApproval.id))).scalars().all()
        plan = (await s.execute(select(AgentRunEvent.payload).where(
            AgentRunEvent.run_id == run_id, AgentRunEvent.type == "plan").order_by(AgentRunEvent.seq.desc()).limit(1)
        )).scalar_one_or_none()
        # ⚠️ state 必须走查作业行的 `_run_states`（2026-10-28）。`_run_view` 自带的是同步兜底版，
        # 只看 agent_runs.status：作业早已被 worker 领走在跑，这里仍说"排队中"。
        # 前端每次刷新单轮都读这个接口，用兜底版等于让界面永远落后一拍。
        states = await _run_states([r])
        return {**_run_view(r), "state": states.get(r.id) or _run_state(r), "plan": (plan or {}).get("todos"),
                "approvals": [{"approval_id": a.id, "tool": a.tool, "args": a.args, "risk": a.risk,
                               "description": a.description, "status": a.status} for a in aps]}


@router.get("/runs/{run_id}/events")
async def run_events(run_id: int, after_seq: int = Query(0, ge=0), user: User = Depends(get_current_user)):
    """SSE：从 after_seq 之后推送事件；断线后带上最后收到的 seq 重连即可续读。
    运行进入终态或等待审批、且没有新事件时结束本次推送（审批后重新连接）。"""
    async with session_scope() as s:
        await _own_run(s, run_id, user)

    async def gen():
        last, idle, beat = after_seq, 0, 0.0
        while True:
            async with session_scope() as s:
                rows = (await s.execute(select(AgentRunEvent).where(
                    AgentRunEvent.run_id == run_id, AgentRunEvent.seq > last).order_by(AgentRunEvent.seq).limit(200)
                )).scalars().all()
                status = (await s.get(AgentRun, run_id)).status
            for e in rows:
                last = e.seq
                yield f"id: {e.seq}\ndata: {json.dumps({'seq': e.seq, 'type': e.type, **(e.payload or {})}, ensure_ascii=False)}\n\n"
            if rows:
                idle = 0
                continue
            if status in ("done", "failed", "canceled", "awaiting_approval"):
                idle += 1
                if idle >= 2:
                    yield f"data: {json.dumps({'type': 'stream_end', 'status': status}, ensure_ascii=False)}\n\n"
                    return
            beat += 0.7
            if beat >= 15:
                beat = 0.0
                yield ": keepalive\n\n"
            await asyncio.sleep(0.7)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class DecisionIn(BaseModel):
    decision: Literal["approve", "reject"]
    note: str = Field("", max_length=2000)


@router.post("/runs/{run_id}/approvals/{approval_id}")
async def decide(run_id: int, approval_id: int, body: DecisionIn, user: User = Depends(get_current_user)):
    """对一个待审批的工具调用做决定。只回传决定，参数以服务端保存的为准。重复提交幂等。"""
    async with session_scope() as s:
        await _own_run(s, run_id, user)
        res = await s.execute(
            update(AgentApproval)
            .where(AgentApproval.id == approval_id, AgentApproval.run_id == run_id, AgentApproval.status == "pending")
            .values(status="approved" if body.decision == "approve" else "rejected", note=body.note or None,
                    decided_at=datetime.utcnow())
            .returning(AgentApproval.interrupt_id))
        hit = res.scalar_one_or_none()
    if hit is None:
        async with session_scope() as s:
            a = await s.get(AgentApproval, approval_id)
            if not a or a.run_id != run_id:
                raise HTTPException(404, "审批项不存在")
            return {"ok": True, "already_decided": True, "status": a.status}

    resumed = False
    async with session_scope() as s:
        run = await s.get(AgentRun, run_id, with_for_update=True)      # 行锁：只入队一次
        aps = (await s.execute(select(AgentApproval).where(
            AgentApproval.run_id == run_id, AgentApproval.interrupt_id == hit).order_by(AgentApproval.idx))).scalars().all()
        if run.status == "awaiting_approval" and all(a.status != "pending" for a in aps):
            from .runner import decisions_from_approvals
            run.resume = decisions_from_approvals(list(aps))
            run.status = "queued"
            resumed = True
        await s.flush()
    if resumed:
        from ..agent import jobs
        await jobs.enqueue(kind="agent_run", user_id=user.id, payload={"run_id": run_id})
        await emit_once(run_id, "approval_decided", {"approval_id": approval_id, "decision": body.decision})
    return {"ok": True, "resumed": resumed}


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        r = await _own_run(s, run_id, user)
        if r.status in ("done", "failed", "canceled"):
            return {"ok": True, "status": r.status}
        r.cancel_requested = True
        direct = r.status in ("queued", "awaiting_approval")
        if direct:                                   # 没有执行者在跑，直接收尾
            r.status = "canceled"
            r.finished_at = datetime.utcnow()
            await s.execute(update(AgentApproval).where(AgentApproval.run_id == run_id,
                                                        AgentApproval.status == "pending").values(status="rejected"))
        await s.flush()
    if direct:
        await emit_once(run_id, "canceled", {})
    return {"ok": True, "status": "canceled" if direct else "canceling"}


# ---------------------------------------------------------------- 会话
@router.get("/conversations")
async def list_conversations(limit: int = Query(50, ge=1, le=200), draft_id: int | None = Query(None),
                             user: User = Depends(get_current_user)):
    """Agent 会话列表；draft_id 只列绑定这部草稿的会话。profile 取该会话最近一轮的模式。"""
    async with session_scope() as s:
        stmt = select(AgentConversation).where(
            AgentConversation.user_id == user.id, AgentConversation.source == "agent",
            AgentConversation.is_deleted.is_(False))
        if draft_id:
            stmt = stmt.where(AgentConversation.draft_id == draft_id)
        rows = (await s.execute(stmt.order_by(AgentConversation.updated_at.desc()).limit(limit))).scalars().all()
        prof: dict[int, str] = {}
        if rows:
            for cid, p in (await s.execute(text(
                "SELECT DISTINCT ON (conversation_id) conversation_id, profile FROM agent_runs "
                "WHERE conversation_id = ANY(:ids) ORDER BY conversation_id, id DESC"), {"ids": [c.id for c in rows]})).all():
                prof[cid] = p
        return {"items": [{"id": c.id, "title": c.title, "draft_id": c.draft_id, "profile": prof.get(c.id),
                           "updated_at": c.updated_at.isoformat() if c.updated_at else None} for c in rows]}


@router.get("/conversations/{conv_id}")
async def get_conversation(conv_id: int, user: User = Depends(get_current_user)):
    """会话完整回放：每一轮的指令、事件（工具卡、审批卡、计划）、最终回复。"""
    async with session_scope() as s:
        c = await s.get(AgentConversation, conv_id)
        if not c or c.user_id != user.id or c.source != "agent":
            raise HTTPException(404, "会话不存在")
        active_ids = (await s.execute(select(AgentRun.id).where(
            AgentRun.conversation_id == conv_id, AgentRun.status.in_(RUN_ACTIVE)))).scalars().all()
    if active_ids:
        from .heal import heal_runs
        await heal_runs(list(active_ids))       # 先自愈再回放，见 heal.py
    async with session_scope() as s:
        runs = (await s.execute(select(AgentRun).where(AgentRun.conversation_id == conv_id)
                                .order_by(AgentRun.id))).scalars().all()
        states = await _run_states(list(runs))
        out = []
        for r in runs:
            evs = (await s.execute(select(AgentRunEvent).where(AgentRunEvent.run_id == r.id, AgentRunEvent.type != "delta")
                                   .order_by(AgentRunEvent.seq))).scalars().all()
            out.append({**_run_view(r), "state": states.get(r.id), "events": [
                {"seq": e.seq, "type": e.type, **(e.payload or {})} for e in evs]})
        return {"conversation": {"id": c.id, "title": c.title, "draft_id": c.draft_id,
                                 "profile": out[-1]["profile"] if out else None}, "runs": out}


@router.delete("/conversations/{conv_id}")
async def delete_conversation(conv_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        c = await s.get(AgentConversation, conv_id)
        if not c or c.user_id != user.id or c.source != "agent":
            raise HTTPException(404, "会话不存在")
        c.is_deleted = True
    return {"ok": True}


# ---------------------------------------------------------------- 权限与工具
@router.get("/permissions")
async def get_permissions(user: User = Depends(get_current_user)):
    from ..agent.memory import get_or_create_profile
    prof = await get_or_create_profile(user.id)
    return {"permissions": merge_permissions((prof or {}).get("agent_permissions")),
            "labels": PERMISSION_LABELS, "defaults": DEFAULT_PERMISSIONS}


class PermIn(BaseModel):
    permissions: dict[str, bool]


@router.patch("/permissions")
async def patch_permissions(body: PermIn, user: User = Depends(get_current_user)):
    from ..agent.memory import get_or_create_profile
    prof = await get_or_create_profile(user.id)
    merged = merge_permissions({**((prof or {}).get("agent_permissions") or {}),
                                **{k: v for k, v in body.permissions.items() if k in DEFAULT_PERMISSIONS}})
    async with session_scope() as s:
        await s.execute(text("UPDATE user_profiles SET agent_permissions = CAST(:p AS JSONB) WHERE user_id = :u"),
                        {"p": json.dumps(merged), "u": user.id})
    return {"ok": True, "permissions": merged}


@router.get("/tools")
async def list_tools(user: User = Depends(get_current_user)):
    from .prompts import PROFILE_TOOLS
    return {"profiles": list(PROFILES), "tools": [
        {"name": n, "risk": m.risk, "scope": m.scope, "long_running": m.long_running,
         "profiles": [p for p, allow in PROFILE_TOOLS.items() if allow is None or n in allow]}
        for n, m in META.items()]}
