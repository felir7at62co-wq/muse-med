"""`run_agent_run` —— RUNNERS["agent_run"]。

## 一次 run 的生命周期

```
POST /agent/runs → create_run + create_job("agent_run") + BackgroundTasks
                       ↓
run_agent_run:
   ① 从 checkpoint 取状态（有则续、无则新建）
   ② graph.ainvoke(...) —— 一路跑到 END 或被 interrupt 挂起
   ③ 返回体里有 __interrupt__ → status=waiting_approval + 存审批卡片
      正常结束            → status=done + 写 summary
      异常                → status=failed
```

## 为什么 checkpoint 单独一个库

LangGraph 每走一步都写一次 checkpoint。写在主库 `filmweaver_dev.db` 上，
高频写事务会和业务写（出片结果、任务进度）抢 SQLite 的写锁 ——
而 SQLite 是全库一把锁，不是行锁。表现是出片那条链突然变慢、`database is locked`。

单独一个文件 `filmweaver-agent.db`，两边互不干扰。代价是备份要备份两个文件
（`storage` 与 `maintenance` 那套已覆盖整个 data_dir，不用改）。

## Python 3.10 的 interrupt 问题

见 `graph._prepare_async_node`。这里只负责把 config 传进图，别在 runner 里
再做一次 contextvar 操作 —— 那会被节点内的 set 覆盖，属于重复保险反而容易出错。
"""
from __future__ import annotations

import json
import logging

logger = logging.getLogger("fw.agent.runner")

#: checkpoint 库路径（与主库同目录）。
_CHECKPOINT_NAME = "filmweaver-agent.db"


def _checkpoint_path() -> str:
    from pathlib import Path

    from ..db import engine
    url = str(engine.url)
    if url.startswith("sqlite:///"):
        main = Path(url.replace("sqlite:///", ""))
        return str(main.parent / _CHECKPOINT_NAME)
    # 非 sqlite（将来切 pg 时）：退到临时目录，保证不写到奇怪的地方
    import tempfile
    return str(Path(tempfile.gettempdir()) / _CHECKPOINT_NAME)


async def run_agent_run(jid: str) -> None:
    """RUNNERS["agent_run"] 的实现。

    payload = {
      "run_id": "...",
      "resume": {"ok": bool, "reason": str, "by": int} | null,  # 审批/继续
      "followup": "用户的话" | null,   # 这一轮已结束后用户又说了一句：同一线程接着做
    }
    """
    from ..jobs import _update, get_job
    from . import policy, registry, store
    from .executor import ToolCtx
    from .graph import build_graph

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload or "{}")
    run_id = p.get("run_id")
    if not run_id:
        _update(jid, status="failed", error="缺少 run_id")
        return

    run = store.get_run(run_id)
    if not run:
        _update(jid, status="failed", error=f"run 不存在: {run_id}")
        return
    if run.status == "cancelled":
        _update(jid, status="cancelled", error="已取消")
        return

    # ---- 上下文 ----
    role = _role_of(run)
    # ⚠️ 闸门的基准必须是 `max(已结算, 预扣)`（2026-10-23 修）。
    #
    # 此前只用 `run.spent_fen`，而它由 `recalc_spent` 写成「实测用量 + token 费」——
    # agent 提交的 job 往往一条用量行都还没有（runner 没跑完 / 文本类恒 0），
    # 于是**预扣的那部分完全不在闸门里**。后果：一轮跑到一半被批准 / 叫醒 /
    # 接续时，runner 重建 ctx，`spent_fen` 归零回到 token 费，用户设的
    # 50 元上限等于每过一个 job 边界就重置一次，永远撞不到。
    # 预扣才是"这一轮还压着多少钱"，与 `reserved_fen` 是同一口径（见 store）。
    ctx = ToolCtx(
        run_id=run.id,
        project_id=run.project_id,
        user_id=run.user_id,
        role=role,
        cap_fen=int(run.cap_fen or 0),
        spent_fen=max(int(run.spent_fen or 0), store.reserved_fen(run.id)),
        model=run.model or "gpt-6.1-sol",
    )

    # 导入工具模块 —— **必须显式导入**，否则装饰器不执行、注册表是空的。
    from . import tools_audit, tools_gen, tools_gen2, tools_read, tools_write  # noqa: F401

    tools_schema = registry.tools_schema()
    if not tools_schema:
        _update(jid, status="failed", error="工具注册表为空（tools_* 未导入？）")
        return

    tree = build_graph(registry_mod=registry, policy_mod=policy, store=store,
                       ctx=ctx, tools_schema=tools_schema)

    store.update_run(run.id, status="running", error=None)
    _update(jid, status="running", progress=1)

    resume = p.get("resume")
    cfg = {"configurable": {"thread_id": run.id}}

    # ack 步骤要写库，但 `_drain_inbox` 是节点内的纯函数，不想为它加参数。
    # 绑定到本 context：单线程事件循环里不存在串号。
    from .graph import bind_store, merge_inbox
    tok = bind_store(store)

    try:
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
        from langgraph.types import Command

        async with AsyncSqliteSaver.from_conn_string(_checkpoint_path()) as saver:
            app = tree.compile(checkpointer=saver)
            base = {"run_id": run.id, "project_id": run.project_id,
                    "stage": "", "cap_fen": ctx.cap_fen, "spent_fen": ctx.spent_fen}
            followup = (p.get("followup") or "").strip()
            if resume is not None:
                out = await app.ainvoke(Command(resume=resume), cfg)
            elif followup:
                # 这一轮已结束，用户又说了一句：在**同一个线程**上追加一条用户消息接着做
                # （LangGraph 原生多轮）。上一轮的结论、读过的镜头都还在上下文里。
                from langchain_core.messages import HumanMessage
                msgs = await _close_dangling_calls(app, cfg)
                out = await app.ainvoke(
                    {**base, "messages": msgs + [HumanMessage(content=followup)],
                     "inbox": []}, cfg)
            else:
                from langchain_core.messages import HumanMessage
                # 插话兜底：checkpoint 里没来得及写进去的（`/say` 时还没有
                # checkpoint 的那些），这里从步骤表补回来。
                inbox = store.pending_inbox(run.id)
                out = await app.ainvoke(
                    {**base, "messages": [HumanMessage(content=run.goal or "把项目做完")],
                     "todo": [], "inbox": inbox},
                    cfg)
    except Exception as e:  # noqa: BLE001 — 一轮 run 失败不该炸掉后端
        logger.exception("[agent] run %s 执行失败", run.id)
        # ⚠️ 失败路径**也要回写 spent_fen**（2026-10-23 修）。
        #    此前只在成功/等确认两条路径写，失败的一轮于是永远留着建 run 时的 0。
        #    而失败最常见的原因恰恰是上游报错——那时 token 已经花掉了、
        #    有些 job 也已经提交并预扣了，界面却显示"已花 ¥0.00"。
        #    用户据此判断"没花钱"，与真实账目相反。
        try:
            store.recalc_spent(run.id)
        except Exception:  # noqa: BLE001 — 记账失败不能盖住真正的错误
            logger.warning("[agent] run %s 失败后回写花费失败", run.id, exc_info=True)
        store.update_run(run.id, status="failed", error=f"{type(e).__name__}: {e}")
        _update(jid, status="failed", error=f"{type(e).__name__}: {e}")
        # 失败的一轮同样要收尾挂着的审批行：否则它永远显示「等你点头」，
        # 而这一轮已经 failed，点批准只会得到 409。
        try:
            store.close_pending_approvals(
                run.id, result=f"这一轮失败，未执行：{type(e).__name__}",
                approval="rejected")
        except Exception:  # noqa: BLE001 — 收尾失败不能盖住真正的错误
            logger.warning("[agent] run %s 失败后收尾审批行失败", run.id, exc_info=True)
        return
    finally:
        from .graph import reset_ack_store
        reset_ack_store(tok)

    # ---- 收尾 ----
    spent = store.recalc_spent(run.id)
    intr = out.get("__interrupt__") if isinstance(out, dict) else None
    if intr:
        payload = _interrupt_value(intr)
        store.add_step(run.id, kind="approval",
                       args=json.dumps(payload, ensure_ascii=False)[:4000],
                       approval="pending")
        store.update_run(run.id, status="waiting_approval", spent_fen=spent)
        _update(jid, status="done", progress=100,
                result=json.dumps({"run_id": run.id, "status": "waiting_approval",
                                   "approval": payload,
                                   "spent_fen": spent}, ensure_ascii=False))
        return

    # 这一轮真的跑到了 END —— 把**还挂着 pending 的审批行**收尾
    # （2026-10-27 用户报「根本没有批准选项」：批准后没人改旧行，
    #  前端按步骤渲染，僵尸卡片一直排在新卡片之上，点它必然 409）。
    # 放在 `intr` 分支**之后**：还挂着新的 interrupt 时，那一行才是真待批的。
    _closed = store.close_pending_approvals(
        run.id,
        result="已批准（这一轮结束时补记）" if resume and resume.get("ok")
               else ("用户没批准（这一轮结束时补记）" if resume else "这一轮已结束"),
        approval="approved" if (resume and resume.get("ok")) else "rejected",
        decided_by=(resume or {}).get("by"))

    summary = _final_text(out)
    store.update_run(run.id, status="done", spent_fen=spent, summary=summary)
    store.recalc_spent(run.id)
    _update(jid, status="done", progress=100,
            result=json.dumps({"run_id": run.id, "status": "done",
                               "summary": summary, "spent_fen": spent},
                              ensure_ascii=False))


# ---------------------------------------------------------------------------

def _role_of(run) -> str | None:
    """这个 run 的执行者对该项目是什么档。

    ⚠️ **不能用 `access.project_role`**：它依赖请求上下文（`_CURRENT`），
    而 runner 跑在后台。`access` 里对"无调用者"的判定是 **owner**（见
    `project_role` 第 2 条），直接用会把后台作业全部提成最高权限 ——
    agent 于是能删任何东西，且不报错。

    所以这里手工按 `run.user_id` 查：管理员 → owner；项目 owner → owner；
    名册 → 名册档；否则 None（工具全部拒绝）。
    """
    from sqlalchemy import or_

    from ..db import Project, ProjectCollaborator, get_session

    with get_session() as s:
        proj = s.get(Project, run.project_id)
        if not proj:
            return None
        if run.user_id is None:
            return "editor"        # 无名用户（CLI/巡检发起）：按 editor，不给删除权
        row = (s.query(ProjectCollaborator.role)
               .filter(ProjectCollaborator.project_id == run.project_id,
                       ProjectCollaborator.user_id == int(run.user_id)).first())
        if proj.owner_id is not None and int(proj.owner_id) == int(run.user_id):
            return "owner"
        if row and row[0] in ("viewer", "editor", "manager"):
            return row[0]
        # 管理员：查这个人的平台角色。auth_sessions 没有 created_at（此前按它排序必抛、
        # 被吞掉，管理员在非自己的项目里工具全被拒），按 expires_at 取最近一次会话；
        # 没有会话时退到 known_users（每次登录都会刷新）。
        from ..auth import AuthSession, KnownUser
        try:
            sess = (s.query(AuthSession)
                    .filter(AuthSession.user_id == int(run.user_id))
                    .order_by(AuthSession.expires_at.desc()).first())
            role = sess.role if sess else None
            if role is None:
                known = s.get(KnownUser, int(run.user_id))
                role = known.role if known else None
            if (role or "") in ("admin", "superadmin"):
                return "owner"
        except Exception as e:  # noqa: BLE001 — 会话表结构变动不该让 agent 全线不可用
            logger.warning("[agent] run %s 查执行者平台角色失败：%r", run.id, e)
    return None


async def _close_dangling_calls(app, cfg) -> list:
    """上一轮若停在"发出了工具调用、还没有结果"（被停止 / 出错），补上占位结果。

    OpenAI 协议要求带 tool_calls 的 assistant 消息后面**必须**紧跟每个调用的
    tool 消息；缺了的话接着说的第一句就会被上游 400，这一轮再也续不上。
    """
    from langchain_core.messages import AIMessage, ToolMessage

    try:
        snap = await app.aget_state(cfg)
    except Exception:  # noqa: BLE001 — 没有 checkpoint：从零开始
        return []
    msgs = list((snap.values or {}).get("messages") or []) if snap else []
    if not msgs:
        return []
    answered = {m.tool_call_id for m in msgs if isinstance(m, ToolMessage)}
    last = msgs[-1]
    if not isinstance(last, AIMessage):
        return []
    return [ToolMessage(content=json.dumps({"ok": False, "error": "这一步没有执行（上一轮已停止）"},
                                           ensure_ascii=False),
                        tool_call_id=tc["id"], name=tc.get("name") or "")
            for tc in (getattr(last, "tool_calls", None) or [])
            if tc.get("id") and tc["id"] not in answered]


def _interrupt_value(intr) -> dict:
    try:
        first = intr[0] if isinstance(intr, (list, tuple)) else intr
        v = getattr(first, "value", None)
        if v is None and isinstance(first, dict):
            v = first.get("value", first)
        return v if isinstance(v, dict) else {"raw": str(v)}
    except Exception:  # noqa: BLE001
        return {"raw": str(intr)[:1000]}


def _final_text(out) -> str:
    try:
        msgs = out.get("messages") or []
        for m in reversed(msgs):
            if getattr(m, "type", "") == "ai":
                c = m.content
                if isinstance(c, str) and c.strip():
                    return c.strip()[:8000]
    except Exception:  # noqa: BLE001
        pass
    return ""
