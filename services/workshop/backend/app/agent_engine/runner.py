"""Agent 运行器：作为 worker 作业 `agent_run` 执行一次运行。

一次执行的流程：
  拿线程咨询锁（同一会话同一时刻只能有一个执行者——LangGraph 自身不防并发，实测两进程同时续跑会分叉）
  → 从检查点判断该怎么继续：审批后续跑 / 崩溃后续跑 / 新的一轮
  → 流式执行，逐条写事件
  → 遇到审批：落审批表、状态改 awaiting_approval、释放 worker（用户决定后重新入队）
  → 结束：写最终回复、用量、会话消息。
取消在每个事件之间检查（至多每 2 秒查一次库）。
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime

import psycopg
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langgraph.types import Command
from sqlalchemy import select, text

from ..db import session_scope
from ..db.models import AgentMessage
from .context import EngineContext
from .events import EventWriter
from .graph import build_agent, checkpoint_dsn, checkpointer, thread_config
from .models import AgentApproval, AgentRun
from .policy import merge_permissions

logger = logging.getLogger("agent_engine.runner")


class _CancelRequested(Exception):
    pass


def _human_id(run_id: int) -> str:
    return f"run-{run_id}"


async def _load_run(run_id: int) -> AgentRun | None:
    async with session_scope() as s:
        r = await s.get(AgentRun, run_id)
        if r:
            s.expunge(r)
        return r


async def _update_run(run_id: int, **fields) -> None:
    async with session_scope() as s:
        r = await s.get(AgentRun, run_id)
        for k, v in fields.items():
            setattr(r, k, v)
        await s.flush()


async def _context(run: AgentRun) -> EngineContext:
    from ..auth.models import User
    from ..agent.memory import get_or_create_profile
    async with session_scope() as s:
        u = await s.get(User, run.user_id)
        role = (u.role if u else "user") or "user"
    prof = await get_or_create_profile(run.user_id)
    perms = merge_permissions((prof or {}).get("agent_permissions") if isinstance(prof, dict) else None)
    return EngineContext(user_id=run.user_id, role=role, run_id=run.id, conversation_id=run.conversation_id,
                         profile=run.profile, draft_id=run.draft_id, permissions=perms,
                         writing_model=(getattr(run, "writing_model", None) or None))


def _interrupts(state) -> list:
    return [i for t in (state.tasks or ()) for i in (t.interrupts or ())]


def _usage_since(messages: list, human_id: str) -> dict:
    """本轮（从本轮用户消息之后）的模型用量。"""
    out = {"input": 0, "output": 0, "model_calls": 0}
    seen = False
    for m in messages:
        if isinstance(m, HumanMessage) and m.id == human_id:
            seen = True
            continue
        if seen and isinstance(m, AIMessage) and getattr(m, "usage_metadata", None):
            out["input"] += m.usage_metadata.get("input_tokens", 0)
            out["output"] += m.usage_metadata.get("output_tokens", 0)
            out["model_calls"] += 1
    return out


def _text_of(m) -> str:
    c = m.content
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join(p.get("text", "") for p in c if isinstance(p, dict))
    return str(c)


async def _record_approvals(run_id: int, ints: list, ew: EventWriter) -> list[dict]:
    """把中断里的待审批调用落表（幂等：同一中断点重复落表不会产生重复行）。"""
    out = []
    async with session_scope() as s:
        for it in ints:
            reqs = (it.value or {}).get("action_requests") or []
            for idx, ar in enumerate(reqs):
                existing = (await s.execute(select(AgentApproval).where(
                    AgentApproval.run_id == run_id, AgentApproval.interrupt_id == str(it.id),
                    AgentApproval.idx == idx))).scalar_one_or_none()
                if not existing:
                    from .tools import META
                    meta = META.get(ar.get("name"))
                    existing = AgentApproval(run_id=run_id, interrupt_id=str(it.id), idx=idx, tool=ar.get("name"),
                                             args=ar.get("args") or {}, risk=meta.risk if meta else None,
                                             description=ar.get("description"))
                    s.add(existing)
                    await s.flush()
                out.append({"approval_id": existing.id, "tool": existing.tool, "args": existing.args,
                            "risk": existing.risk, "description": existing.description, "status": existing.status})
    await ew.emit("approval_required", {"approvals": out})
    return out


def decisions_from_approvals(aps: list) -> dict:
    """把一个中断的审批行（按 idx 排好）翻译成 Command(resume=...) 的入参。

    审批接口与 runner 共用这一份：runner 在 `run.resume` 丢失时要能从审批表原样重建，
    两处写法不一致就会出现"用户点的是拒绝、续跑却当成批准"。
    """
    return {"decisions": [{"type": "approve"} if a.status == "approved" else
                          {"type": "reject", "message": a.note or "用户拒绝了这个操作，请按用户意见调整或换个做法"}
                          for a in aps]}


async def _decided_resume(run_id: int, ints: list) -> dict | None:
    """中断点上的审批项若**已经全部有了决定**，按决定重建续跑入参；否则 None。

    为什么需要（2026-10-28）：`_execute` 在续跑前就把 `run.resume` 清空了。若清空之后、
    检查点前进之前进程退出（重启 / 模型报错重试），重放时中断还在、resume 却没了 ——
    旧逻辑会重新落审批表（幂等，拿回的是已批准的旧行）并把状态改回 awaiting_approval。
    结果就是界面一直"等待你确认"，却没有任何一张待确认卡片可点，永远卡住。
    """
    reqs = [(str(it.id), len((it.value or {}).get("action_requests") or [])) for it in ints]
    if not reqs or any(n == 0 for _, n in reqs):
        return None
    async with session_scope() as s:
        aps = (await s.execute(select(AgentApproval).where(
            AgentApproval.run_id == run_id, AgentApproval.interrupt_id.in_([i for i, _ in reqs]))
            .order_by(AgentApproval.interrupt_id, AgentApproval.idx))).scalars().all()
    if len(aps) != sum(n for _, n in reqs) or any(a.status == "pending" for a in aps):
        return None
    if len(reqs) > 1:
        # 一个检查点上多个中断（目前的中间件不会产生）：决定无法无歧义地拼成一份 resume，宁可再问一次。
        return None
    return decisions_from_approvals(list(aps))


async def _refresh_permissions(ctx: EngineContext) -> None:
    """运行中途重读用户的权限开关，**原地**更新 ctx.permissions。

    审批策略（policy.interrupt_config 的 when）在每次工具调用前读 ctx.permissions；
    原先只在一轮开始时读一次，用户中途勾上"生成类免确认"要等下一轮才生效。
    原地改 dict 而不是换对象：LangGraph 交给中间件的 runtime.context 即便是浅拷贝，
    也和这里共用同一个 dict。
    """
    from ..agent.memory import get_or_create_profile
    try:
        prof = await get_or_create_profile(ctx.user_id)
        fresh = merge_permissions((prof or {}).get("agent_permissions") if isinstance(prof, dict) else None)
    except Exception:  # noqa: BLE001
        logger.warning("agent run %s: 重读权限失败，沿用当前值", ctx.run_id, exc_info=True)
        return
    if fresh != ctx.permissions:
        logger.info("agent run %s: 权限开关已变更，后续工具调用按新设置判断", ctx.run_id)
        ctx.permissions.clear()
        ctx.permissions.update(fresh)


#: 拿不到会话锁时最多等多久（秒）。持锁的只可能是：同一轮的重复作业（等到后会发现运行
#: 已不在可执行状态而跳过），或上一轮刚结束、连接还没关的执行者（毫秒到秒级）。
CONV_LOCK_WAIT = 180


async def handle_agent_run(job: dict) -> dict:
    run_id = int((job.get("payload") or {})["run_id"])
    run = await _load_run(run_id)
    if not run:
        return {"run_id": run_id, "skipped": "not_found"}

    from ..factory.usage import set_usage_context
    set_usage_context(user_id=run.user_id, source="agent_engine")

    # ---- 线程咨询锁：连接存活期间持有，连接关闭即释放（进程崩溃也会自动释放）。
    # ⚠️ 必须**先拿锁，再读运行状态与事件序号**：2026-10-18 实测，先读后锁时，重复派发的作业
    #    在持锁者刚释放的瞬间拿到锁，带着过期的"running"快照把收尾又做了一遍（事件序号撞车）。
    lock_conn = await psycopg.AsyncConnection.connect(checkpoint_dsn(), autocommit=True)
    try:
        # ⚠️ 2026-10-28：拿不到锁时**等**，不再直接结束。
        # 原先这里 `return skipped: busy` —— 作业被标成 done，可运行本身还停在 queued，
        # 再也没有任何作业会推进它：界面永远"排队中（等一个空闲的执行位）"。
        # 典型触发：用户停止上一轮后马上发下一轮，上一轮的执行者还没关掉连接。
        # 等锁期间作业心跳照常（run_job 的 _beat），不会被当成僵尸回收。
        deadline = time.monotonic() + CONV_LOCK_WAIT
        lock_key = f"agent:conv:{run.conversation_id}"
        while True:
            got = (await (await lock_conn.execute(
                "SELECT pg_try_advisory_lock(hashtext(%s))", (lock_key,))).fetchone())[0]
            if got:
                break
            if time.monotonic() >= deadline:
                msg = f"会话 {run.conversation_id} 一直被另一个执行者占用（等了 {CONV_LOCK_WAIT} 秒）"
                if await _attempts_left(run_id):
                    raise RuntimeError(msg)          # 交给作业重试
                await _finish(run_id, "failed", error=msg + "，请稍后重新发送")
                return {"run_id": run_id, "status": "failed", "reason": "conv_busy"}
            await asyncio.sleep(1.0)
        run = await _load_run(run_id)
        if run.status in ("done", "failed", "canceled", "awaiting_approval"):
            return {"run_id": run_id, "skipped": run.status}
        ew = await EventWriter(run_id).init()
        if run.cancel_requested:
            await _finish(run_id, "canceled")
            await ew.emit("canceled", {})
            return {"run_id": run_id, "status": "canceled"}
        return await _execute(run, ew)
    finally:
        await lock_conn.close()


async def _execute(run: AgentRun, ew: EventWriter) -> dict:
    run_id = run.id
    ctx = await _context(run)
    cfg = thread_config(run.conversation_id)
    hid = _human_id(run_id)
    await _update_run(run_id, status="running", error=None)
    try:
        async with checkpointer() as saver:
            agent = build_agent(ctx, saver, run.model)
            state = await agent.aget_state(cfg)
            ints = _interrupts(state)
            msgs = (state.values or {}).get("messages") or []
            if ints:
                resume = run.resume or await _decided_resume(run_id, ints)
                if resume:
                    inp = Command(resume=resume)
                    await _update_run(run_id, resume=None)
                    await ew.emit("resumed", {"reason": "approval"})
                else:
                    await _record_approvals(run_id, ints, ew)
                    await _update_run(run_id, status="awaiting_approval")
                    return {"run_id": run_id, "status": "awaiting_approval"}
            elif state.next:
                inp = None                                    # 崩溃/重启后从检查点续跑
                await ew.emit("resumed", {"reason": "recovery"})
            elif not any(isinstance(m, HumanMessage) and m.id == hid for m in msgs):
                inp = {"messages": [HumanMessage(content=run.message, id=hid)]}
                await ew.emit("started", {"profile": run.profile, "draft_id": run.draft_id})
            else:
                inp = None                                    # 本轮已经跑完（只差收尾）

            last_cancel_check, buf, last_flush = 0.0, [], time.monotonic()
            if inp is not None or state.next:
                async for mode, chunk in agent.astream(inp, cfg, context=ctx, stream_mode=["updates", "messages"]):
                    now = time.monotonic()
                    if now - last_cancel_check > 2:
                        last_cancel_check = now
                        if (await _load_run(run_id)).cancel_requested:
                            raise _CancelRequested()
                        await _refresh_permissions(ctx)
                    if mode == "messages":
                        m, meta = chunk
                        if isinstance(m, AIMessageChunk) and meta.get("langgraph_node") == "model":
                            t = _text_of(m)
                            if t:
                                buf.append(t)
                        if buf and now - last_flush > 0.8:
                            await ew.emit("delta", {"text": "".join(buf)})
                            buf, last_flush = [], now
                        continue
                    for node, val in (chunk or {}).items():
                        if node == "__interrupt__" or not isinstance(val, dict):
                            continue
                        if buf:
                            await ew.emit("delta", {"text": "".join(buf)})
                            buf, last_flush = [], now
                        for m in val.get("messages") or []:
                            if isinstance(m, AIMessage):
                                await ew.emit("assistant", {
                                    "text": _text_of(m),
                                    "tool_calls": [{"id": tc["id"], "name": tc["name"], "args": tc["args"]}
                                                   for tc in (m.tool_calls or [])]})
                            elif isinstance(m, ToolMessage):
                                body = _text_of(m)
                                await ew.emit("tool_result", {"tool_call_id": m.tool_call_id, "name": m.name,
                                                              "ok": not body.startswith("[失败]"),
                                                              "content": body[:3000]})
                        if "todos" in val:
                            await ew.emit("plan", {"todos": val["todos"]})
                if buf:
                    await ew.emit("delta", {"text": "".join(buf)})

            state = await agent.aget_state(cfg)
            ints = _interrupts(state)
            if ints:
                await _record_approvals(run_id, ints, ew)
                await _update_run(run_id, status="awaiting_approval")
                return {"run_id": run_id, "status": "awaiting_approval"}

            msgs = (state.values or {}).get("messages") or []
            final = next((_text_of(m) for m in reversed(msgs) if isinstance(m, AIMessage) and _text_of(m).strip()), "")
            usage = _usage_since(msgs, hid)
            await _finish(run_id, "done", final_text=final, usage=usage)
            await ew.emit("done", {"text": final, "usage": usage})
            return {"run_id": run_id, "status": "done"}
    except _CancelRequested:
        await _finish(run_id, "canceled")
        await ew.emit("canceled", {})
        return {"run_id": run_id, "status": "canceled"}
    except asyncio.CancelledError:
        raise                              # worker 停止：保持 running，租约过期后重放续跑
    except Exception as e:
        logger.exception("agent run %s failed", run_id)
        if await _attempts_left(run_id):
            await ew.emit("error", {"message": f"运行出错，将自动重试：{str(e)[:200]}", "retrying": True})
            raise
        await _finish(run_id, "failed", error=str(e)[:2000])
        await ew.emit("error", {"message": f"运行失败：{str(e)[:300]}", "retrying": False})
        return {"run_id": run_id, "status": "failed"}


async def _attempts_left(run_id: int) -> bool:
    """这一轮最近的作业还能不能重试（不能 = 本次就得把运行收尾，否则运行会停在半路）。"""
    from ..db.models import AgentJob
    async with session_scope() as s:
        j = (await s.execute(select(AgentJob).where(
            AgentJob.kind == "agent_run", AgentJob.payload["run_id"].astext == str(run_id))
            .order_by(AgentJob.id.desc()).limit(1))).scalar_one_or_none()
        return bool(j and (j.attempt or 0) < (j.max_attempts or 3))


async def _finish(run_id: int, status: str, *, final_text: str | None = None, usage: dict | None = None,
                  error: str | None = None) -> None:
    async with session_scope() as s:
        r = await s.get(AgentRun, run_id)
        r.status = status
        r.finished_at = datetime.utcnow()
        if final_text is not None:
            r.final_text = final_text
        if usage is not None:
            r.usage = usage
        if error is not None:
            r.error = error
        if status == "done" and final_text:
            s.add(AgentMessage(conversation_id=r.conversation_id, role="assistant", content=final_text))
        await s.execute(text("UPDATE agent_conversations SET updated_at = now() WHERE id = :c"),
                        {"c": r.conversation_id})
        await s.flush()


def register() -> None:
    from ..agent import jobs
    jobs.register_handler("agent_run", handle_agent_run)
