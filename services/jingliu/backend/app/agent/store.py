"""AgentRun / AgentStep / AgentRunJob 的读写。

**所有写都在这里**，工具与图节点都不直接碰这三张表 —— 否则"这一步花了多少"
会散在十几个地方，对账时永远对不平。
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone

from ..db import AgentRun, AgentRunJob, AgentStep, get_session

logger = logging.getLogger("fw.agent.store")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

def create_run(project_id: str, goal: str, *, user_id: int | None,
               cap_fen: int, model: str = "gpt-6.1-sol") -> AgentRun:
    rid = uuid.uuid4().hex[:12]
    now = _now()
    with get_session() as s:
        run = AgentRun(id=rid, project_id=project_id, user_id=user_id,
                       goal=goal, model=model, status="pending",
                       cap_fen=max(0, int(cap_fen or 0)), spent_fen=0, tokens=0,
                       todo="[]",
                       created_at=now, updated_at=now)
        s.add(run)
        s.commit()
        s.refresh(run)
        s.expunge(run)
        return run


def get_run(run_id: str) -> AgentRun | None:
    with get_session() as s:
        r = s.get(AgentRun, run_id)
        if r:
            s.expunge(r)
        return r


def list_runs(project_id: str, limit: int = 50) -> list[AgentRun]:
    with get_session() as s:
        rows = (s.query(AgentRun)
                .filter(AgentRun.project_id == project_id)
                .order_by(AgentRun.created_at.desc())
                .limit(limit).all())
        for r in rows:
            s.expunge(r)
        return rows


def update_run(run_id: str, **fields) -> None:
    if not fields:
        return
    allowed = {"status", "stage", "cap_fen", "spent_fen", "tokens",
               "todo", "summary", "error", "model"}
    with get_session() as s:
        r = s.get(AgentRun, run_id)
        if not r:
            return
        for k, v in fields.items():
            if k in allowed:
                setattr(r, k, v)
        r.updated_at = _now()
        s.commit()


def set_cap(run_id: str, cap_fen: int) -> None:
    update_run(run_id, cap_fen=max(0, int(cap_fen or 0)))


# ---------------------------------------------------------------------------
# Step
# ---------------------------------------------------------------------------

def next_seq(run_id: str) -> int:
    with get_session() as s:
        last = (s.query(AgentStep.seq)
                .filter(AgentStep.run_id == run_id)
                .order_by(AgentStep.seq.desc()).first())
        return (last[0] + 1) if last else 1


def add_step(run_id: str, *, kind: str, tool: str | None = None,
             args: str | None = None, result: str | None = None,
             ok: bool = True, cost_fen: int = 0, estimate_fen: int = 0,
             approval: str | None = None, decided_by: int | None = None) -> int:
    with get_session() as s:
        last = (s.query(AgentStep.seq)
                .filter(AgentStep.run_id == run_id)
                .order_by(AgentStep.seq.desc()).first())
        seq = (last[0] + 1) if last else 1
        s.add(AgentStep(run_id=run_id, seq=seq, kind=kind, tool=tool,
                        args=args, result=result, ok=1 if ok else 0,
                        cost_fen=cost_fen, estimate_fen=estimate_fen,
                        approval=approval, decided_by=decided_by,
                        decided_at=_now() if approval in ("approved", "rejected") else None,
                        created_at=_now()))
        s.commit()
        return seq


def list_steps(run_id: str, *, after_seq: int = 0, limit: int = 500) -> list[AgentStep]:
    with get_session() as s:
        rows = (s.query(AgentStep)
                .filter(AgentStep.run_id == run_id, AgentStep.seq > after_seq)
                .order_by(AgentStep.seq)
                .limit(limit).all())
        for r in rows:
            s.expunge(r)
        return rows


def close_pending_approvals(run_id: str, *, result: str,
                            approval: str = "approved",
                            decided_by: int | None = None) -> int:
    """把这一轮里**还挂着 pending 的审批步骤**一次性收尾，返回收尾条数。

    ## 为什么必须收（2026-10-27 用户报「根本没有批准选项」）

    `runner` 在挂起时写一条 `AgentStep(kind="approval", approval="pending")`，
    而**批准之后没有任何地方把它改成 approved** —— `graph` 的审批节点只会
    再 add 一条新的 "已批准" 步骤，旧的 pending 行就地变成僵尸。

    后果不是"多一行脏数据"这么轻：前端是**按步骤渲染卡片**的，一张僵尸 pending
    行会一直渲染成一个「等你点头」的卡片，排在真正待批的那张**上面**。
    用户点它 → 后端 409（这一轮当前不在等待确认）→ 看起来就像"批准按钮坏了"。

    而且 pending 行里的 `args` 是**当时那一批**调用的快照。批准/驳回之后这批
    已经执行完或被清掉，留着它还会让人误以为"这一批还没做"。

    收尾口径：
      · 批准 / 用户继续 → `approved`
      · 驳回 / 用户插话（插话 = 不批准，见 agent_run.say 的说明）→ `rejected`
      · 这一轮失败 / 停止 → 既不批准也不驳回，记 `rejected` 并写明原因
        （用 "expired" 会更准，但前端只认 approved/rejected/pending 三档配色，
        新增一档要在 `aimStepHTML` 同步改，不值得为这一种情况加）。
    """
    with get_session() as s:
        rows = (s.query(AgentStep)
                .filter(AgentStep.run_id == run_id,
                        AgentStep.kind == "approval",
                        AgentStep.approval == "pending").all())
        for r in rows:
            r.approval = approval
            r.result = (r.result or "") if r.result else result
            # 只写审批结论，不覆盖 args：args 是"当时问的是什么"，事后要能核对
            r.decided_by = decided_by
            r.decided_at = _now()
        if rows:
            s.commit()
        return len(rows)


def count_tools(run_id: str) -> dict[str, int]:
    """这一轮里每个工具成功执行了几次（用于"已完成 N 组"这类进度提示）。"""
    with get_session() as s:
        rows = (s.query(AgentStep.tool, AgentStep.ok, AgentStep.kind)
                .filter(AgentStep.run_id == run_id,
                        AgentStep.kind == "tool_result").all())
    out: dict[str, int] = {}
    for tool, ok, _k in rows:
        if tool and ok:
            out[tool] = out.get(tool, 0) + 1
    return out


# ---------------------------------------------------------------------------
# Run ↔ Job
# ---------------------------------------------------------------------------

def link_run_job(run_id: str, job_id: str, tool: str, estimate_fen: int) -> None:
    with get_session() as s:
        if s.get(AgentRunJob, {"run_id": run_id, "job_id": job_id}):
            return              # 已连过（重放），不重复插
        s.add(AgentRunJob(run_id=run_id, job_id=job_id, tool=tool,
                          estimate_fen=estimate_fen, created_at=_now()))
        s.commit()


def run_job_ids(run_id: str) -> list[str]:
    with get_session() as s:
        return [r[0] for r in (s.query(AgentRunJob.job_id)
                               .filter(AgentRunJob.run_id == run_id).all())]


def recalc_spent(run_id: str) -> int:
    """重算本轮真实花费并写回：**实际用量 + 脑模型 token**。

    ## ⚠️ 这里曾经把用户看到的金额算成"几乎只剩 token 费"（2026-10-23 修）

    返回的是 `SUM(usage_events.cost_fen) + agent_llm_cost(tokens)`。问题是
    **agent 提交的那些 job 的实测花费常常一条都不在 `usage_events` 里**：

      · 出片 / 首帧 / 放大：用量行在 runner 跑完时才写，而 runner 没跑（见
        `job_submit.spawn_job` 的文档）→ 一条都没有；
      · 文本类：`cost_fen` 恒记 0（按操作收费，不落在单次调用上）。

    于是"已花"退化成 `0 + token 费`。生产实测：一轮跑了 21 分钟、提交了补图任务、
    179184 tokens，界面显示 **¥0.36** —— 而那一轮按预扣口径是 ¥0.90 起。
    用户看到 ¥0.36 时的直觉是"计费坏了"，这个直觉是对的：**数字确实算错了**，
    只是错法不是"少收了钱"，而是"展示的钱不等于这一轮真实的成本口径"。

    ## 口径（两条都返回，别只取一个）

      · `actual`  = `usage_events` 实测合计 + 脑模型 token 费 —— **对账用**；
      · `reserved` = 预扣（提交那一刻锁住的金额）—— **预算闸门用**。

    两者缺一不可：闸门必须用预扣（否则"已提交未结算"的任务会骗过它），
    而用户看的花费必须是实际（否则他会以为自己只花了 3 毛）。
    """
    from ..db import UsageEvent

    ids = run_job_ids(run_id)
    actual = 0
    if ids:
        with get_session() as s:
            rows = (s.query(UsageEvent.cost_fen)
                    .filter(UsageEvent.job_id.in_(ids)).all())
            actual = sum(int(r[0] or 0) for r in rows)

    run = get_run(run_id)
    if run is None:
        return actual
    from ..pricing import agent_llm_cost
    brain = agent_llm_cost(run.tokens or 0)
    update_run(run_id, spent_fen=actual + brain)
    return actual + brain


def reserved_fen(run_id: str) -> int:
    """本轮**预扣**合计 —— 提交那一刻按上界锁住的金额（预算闸门的口径）。

    与 `recalc_spent` 是两笔账：这条读 `agent_run_jobs.estimate_fen`，
    不依赖 runner 有没有跑完、也不依赖用量行写没写。
    """
    with get_session() as s:
        rows = (s.query(AgentRunJob.estimate_fen)
                .filter(AgentRunJob.run_id == run_id).all())
    return sum(int(r[0] or 0) for r in rows)


def reserved_of_job(job_id: str) -> int:
    """单个 job 的预扣额（重放时补记账用）。

    `submit_idempotent` 命中"这个 job 已存在"的分支时不重新报价 —— 报价是按
    **当时的 payload** 算的，重算可能与首次不同。直接读首次那条记录，
    两次口径才一致。
    """
    with get_session() as s:
        row = (s.query(AgentRunJob.estimate_fen)
               .filter(AgentRunJob.job_id == job_id).first())
    return int(row[0] or 0) if row else 0


def add_tokens(run_id: str, tokens: int) -> None:
    """累加脑模型 token。

    ⚠️ **这里只累加 token，不折算钱**（2026-10-23 更正文档）。此前 docstring
    写的是"并同步折算成花费"，但那行代码从来没写过 —— 真正把 token 折算成钱的是
    `recalc_spent`（`actual + agent_llm_cost(tokens)`），而它只在 run 收尾时跑。
    两处各写一遍就会漂移（比如一边按 2 元/百万、另一边按别的），所以刻意留一处。
    """
    if not tokens:
        return
    with get_session() as s:
        r = s.get(AgentRun, run_id)
        if not r:
            return
        r.tokens = int(r.tokens or 0) + int(tokens)
        r.updated_at = _now()
        s.commit()


# ---------------------------------------------------------------------------
# 中途插话（§10.3）
# ---------------------------------------------------------------------------

def add_inbox(run_id: str, text: str, *, by: int | None = None) -> int:
    """用户中途插话：**先落库**，再写 checkpoint 的 inbox。

    ## 为什么必须先落库

    LangGraph resume 时会用 checkpoint 覆盖 state。若先改 state 再写库，
    中间任何一次异常（进程被杀、checkpoint 写失败）都会让这句话彻底消失，
    而用户在界面上看不到任何异常 —— 他只会觉得"我说了它没听"。

    落库之后即使 checkpoint 丢了，`/say` 的步骤流里仍然留着这句话，
    下一次 model 节点也能从 `AgentStep` 里补回来（见 runner 的 `_pending_inbox`）。
    """
    return add_step(run_id, kind="user_message", result=text[:4000],
                    decided_by=by)


def pending_inbox(run_id: str, *, until_seq: int | None = None) -> list[dict]:
    """从步骤表里取"还没被模型读到的插话"。

    `ack` 步骤是「已收到」的标记：它之前的 `user_message` 已经处理过。
    所以这里取的是**最后一条 ack 之后**的 user_message。
    """
    with get_session() as s:
        last_ack = (s.query(AgentStep.seq)
                    .filter(AgentStep.run_id == run_id, AgentStep.kind == "ack")
                    .order_by(AgentStep.seq.desc()).first())
        floor = last_ack[0] if last_ack else 0
        rows = (s.query(AgentStep)
                .filter(AgentStep.run_id == run_id,
                        AgentStep.kind == "user_message",
                        AgentStep.seq > floor)
                .order_by(AgentStep.seq).all())
        return [{"text": (r.result or "").strip(), "seq": r.seq} for r in rows
                if (r.result or "").strip()]
