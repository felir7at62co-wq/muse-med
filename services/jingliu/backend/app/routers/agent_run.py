"""超级 Agent 的接口。

```
POST   /v2/projects/{pid}/agent/runs                  建 run（一段话：要求）
GET    /v2/projects/{pid}/agent/runs                  列表
GET    /v2/projects/{pid}/agent/runs/{rid}            详情 + 步骤
POST   /v2/projects/{pid}/agent/runs/{rid}/say        说一句：在跑时是插话；已结束时同一轮接着做
POST   /v2/projects/{pid}/agent/runs/{rid}/approve    确认找不回来的操作（批准/驳回）
POST   /v2/projects/{pid}/agent/runs/{rid}/resume     中断恢复
POST   /v2/projects/{pid}/agent/runs/{rid}/cancel     停止
GET    /v2/audit/overview?project_id=                 体检三件套的汇总数（不启动 run）
GET    /v2/bgm-library                                配乐库（全局只读）
GET    /v2/agent/tools                                工具清单（管理员排障）
```

## 一轮 = 一段话（2026-10-21 用户裁定）

范围、做到哪一步、花钱前要不要问都写在用户那段话里，由模型遵守。
没有每轮预算上限（2026-11-02 用户裁定删除）：钱由账户余额兜底。
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from .. import access
from ..agent import policy, store
from ..db import Project, Shot, get_session

logger = logging.getLogger("fw.agent.api")

router = APIRouter(prefix="/v2", tags=["agent-run"])


class RunIn(BaseModel):
    #: 用户那段话（要求 + 范围 + 做到哪一步 + 花钱前要不要问）。
    goal: str = ""
    model: Optional[str] = None


class SayIn(BaseModel):
    text: str


class ApproveIn(BaseModel):
    ok: bool
    reason: str = ""


class RunOut(BaseModel):
    id: str
    project_id: str
    goal: str
    status: str
    stage: Optional[str] = None
    model: str
    #: 实际花费 = usage_events 实测合计 + 脑模型 token 费。**对账用**。
    #: ⚠️ 别拿它当"这一轮总共要了多少钱"：agent 提交的 job 里，文本类实测恒为 0，
    #:    而 runner 没跑完的那些一条用量行都没有（2026-10-23 前会因此显示成只剩 token 费）。
    spent_fen: int = 0
    #: 预扣合计（提交那一刻按上界锁住的金额）。
    #: 两个数一起给前端，用户才分得清"已经结算了多少"和"还压着多少"。
    reserved_fen: int = 0
    tokens: int = 0
    todo: list[dict] = []
    summary: Optional[str] = None
    error: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class StepOut(BaseModel):
    seq: int
    kind: str
    tool: Optional[str] = None
    args: Optional[str] = None
    result: Optional[str] = None
    ok: bool = True
    cost_fen: int = 0
    estimate_fen: int = 0
    approval: Optional[str] = None
    created_at: Optional[str] = None


def _run_out(r) -> RunOut:
    def _loads(s, d):
        try:
            return json.loads(s) if s else d
        except (ValueError, TypeError):
            return d

    return RunOut(id=r.id, project_id=r.project_id, goal=r.goal,
                  status=r.status, stage=r.stage, model=r.model,
                  spent_fen=r.spent_fen,
                  reserved_fen=store.reserved_fen(r.id),
                  tokens=r.tokens or 0,
                  todo=_loads(r.todo, []), summary=r.summary, error=r.error,
                  created_at=r.created_at, updated_at=r.updated_at)


def _step_out(s) -> StepOut:
    return StepOut(seq=s.seq, kind=s.kind, tool=s.tool, args=s.args,
                   result=s.result, ok=bool(s.ok), cost_fen=s.cost_fen,
                   estimate_fen=s.estimate_fen, approval=s.approval,
                   created_at=s.created_at)


def _pid_guard(project_id: str) -> None:
    with get_session() as s:
        access.require_project_access(s, project_id)


def _one_run(run_id: str, project_id: str):
    r = store.get_run(run_id)
    if not r or r.project_id != project_id:
        raise HTTPException(404, "run 不存在")
    return r


# ---------------------------------------------------------------------------
# 建 run
# ---------------------------------------------------------------------------

@access.requires(access.ROLE_EDITOR)
@router.post("/projects/{project_id}/agent/runs", response_model=RunOut)
async def create_run(project_id: str, body: RunIn,
                     background: BackgroundTasks) -> RunOut:
    from ..jobs import RUNNERS, create_job
    from ..job_submit import _run_job_guarded

    _pid_guard(project_id)

    goal = (body.goal or "").strip()
    if not goal:
        raise HTTPException(400, "说说要它做什么")
    if len(goal) > 4000:
        raise HTTPException(400, "内容太长（上限 4000 字）")
    # 同一项目同时只允许一轮在跑（出片/去字幕互斥组只防同一类 job，
    # 防不住"一轮在出片、另一轮在去字幕"）
    _ensure_no_other_active(project_id)

    run = store.create_run(project_id, goal, user_id=access.current_user_id(),
                           cap_fen=0, model=body.model or "gpt-6.1-sol")

    jid = create_job("agent_run", {"project_id": project_id, "run_id": run.id,
                                   "resume": None})
    background.add_task(_run_job_guarded, RUNNERS["agent_run"], jid, "agent_run")
    return _run_out(run)


# ---------------------------------------------------------------------------
# 查询
# ---------------------------------------------------------------------------

@router.get("/projects/{project_id}/agent/runs")
def list_runs(project_id: str, limit: int = 50) -> dict:
    _pid_guard(project_id)
    rows = store.list_runs(project_id, limit=max(1, min(200, limit)))
    return {"runs": [_run_out(r).model_dump() for r in rows]}


@router.get("/projects/{project_id}/agent/runs/{run_id}")
def get_run(project_id: str, run_id: str, after_seq: int = 0,
            limit: int = 500) -> dict:
    _pid_guard(project_id)
    r = _one_run(run_id, project_id)
    steps = store.list_steps(run_id, after_seq=after_seq,
                             limit=max(1, min(2000, limit)))
    return {"run": _run_out(r).model_dump(),
            "steps": [_step_out(s).model_dump() for s in steps]}


# ---------------------------------------------------------------------------
# 审批 / 继续 / 停止
# ---------------------------------------------------------------------------

@access.requires(access.ROLE_EDITOR)
@router.post("/projects/{project_id}/agent/runs/{run_id}/approve")
async def approve(project_id: str, run_id: str, body: ApproveIn,
                  background: BackgroundTasks) -> dict:
    from ..jobs import RUNNERS, create_job
    from ..job_submit import _run_job_guarded

    _pid_guard(project_id)
    r = _one_run(run_id, project_id)
    if r.status != "waiting_approval":
        raise HTTPException(409, f"这一轮当前不在等待确认（状态 {r.status}）")

    jid = create_job("agent_run", {
        "project_id": project_id, "run_id": run_id,
        "resume": {"ok": bool(body.ok), "reason": body.reason,
                   "by": access.current_user_id()},
    })
    background.add_task(_run_job_guarded, RUNNERS["agent_run"], jid, "agent_run")
    return {"ok": True, "run_id": run_id, "job_id": jid,
            "decision": "approved" if body.ok else "rejected"}


@access.requires(access.ROLE_EDITOR)
@router.post("/projects/{project_id}/agent/runs/{run_id}/resume")
async def resume(project_id: str, run_id: str,
                 background: BackgroundTasks) -> dict:
    """interrupted / waiting_approval 状态的人工恢复。"""
    from ..jobs import RUNNERS, create_job
    from ..job_submit import _run_job_guarded

    _pid_guard(project_id)
    r = _one_run(run_id, project_id)
    if r.status in ("running", "pending"):
        raise HTTPException(409, "这一轮还在跑，不用继续")
    if r.status in ("done", "failed", "cancelled"):
        raise HTTPException(409, f"这一轮已结束（{r.status}）；直接说一句话就会接着做")

    jid = create_job("agent_run", {
        "project_id": project_id, "run_id": run_id,
        "resume": {"ok": True, "reason": "用户继续", "by": access.current_user_id()}
        if r.status == "waiting_approval" else None,
    })
    background.add_task(_run_job_guarded, RUNNERS["agent_run"], jid, "agent_run")
    return {"ok": True, "run_id": run_id, "job_id": jid}


@access.requires(access.ROLE_EDITOR)
@router.post("/projects/{project_id}/agent/runs/{run_id}/say")
async def say(project_id: str, run_id: str, body: SayIn,
              background: BackgroundTasks) -> dict:
    """中途插话（§10.3）。

    ## 三条必须守住的性质

    1. **不打断正在跑的 tool**。`wait_for_job` 最长等 300 秒，这期间说的话
       停在 inbox 里，等这一轮工具返回、下一次模型调用时才被读到。这是**刻意的**：
       中途掐断一个已经提交的出片 job 只会留下半成品。想立刻停，用 `/cancel`。
    2. **不能被 checkpoint 重放吃掉**。先落库（`AgentStep`）再改 state。
       顺序反了会在 resume 时被 checkpoint 覆盖，话就丢了。
    3. **要在步骤流里可见**。`user_message` 步骤立刻可见，模型读到后补一条
       `ack`（「已收到，将在下一步处理」）—— 没有它用户会重复说三遍。

    ## 为什么这里只改 checkpoint 的 inbox，不直接进 messages

    `messages` 是模型见过的对话历史，往里塞一条 user 消息会让它以为那是
    **上一轮**说的话。inbox 的语义是"还没读到的指示"，由 model 节点在
    下一次调用时合并进去。
    """
    from ..jobs import RUNNERS, create_job
    from ..job_submit import _run_job_guarded

    _pid_guard(project_id)
    r = _one_run(run_id, project_id)
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "内容为空")
    if len(text) > 2000:
        raise HTTPException(400, "一次最多 2000 字")
    if r.status in ("done", "failed", "cancelled"):
        return _follow_up(project_id, r, text, background)

    # ① 先落库 —— 即使后面 checkpoint 写失败，这句话也还在界面上
    seq = store.add_inbox(run_id, text, by=access.current_user_id())

    # ② 再写 checkpoint 的 inbox
    try:
        await _append_inbox(run_id, text)
    except Exception as e:  # noqa: BLE001
        # 写 checkpoint 失败不算致命：runner 启动时会从 AgentStep 里补
        # （store.pending_inbox），所以这句话不会被丢。
        logger.warning("[agent] run %s 插话写 checkpoint 失败: %r", run_id, e)

    # ③ 如果这一轮当前**空闲**（waiting_approval / interrupted），顺手把它叫醒，
    #    否则用户的话要等到下一次人工动作才会被读到 —— 那就不叫"随时插话"了。
    #
    # ⚠️ 等确认时用户说话 = **不批准**，这句话就是理由。此前这里按「批准」叫醒：
    #    卡片问"要换掉整个剧本吗"，用户打一句"别换"，剧本就被换掉了。
    #    要批准只能点卡片上的「批准」。
    woke = False
    if r.status in ("waiting_approval", "interrupted"):
        jid = create_job("agent_run", {
            "project_id": project_id, "run_id": run_id,
            "resume": {"ok": False, "reason": text[:500], "by": access.current_user_id()}
            if r.status == "waiting_approval" else None,
        })
        background.add_task(_run_job_guarded, RUNNERS["agent_run"], jid, "agent_run")
        woke = True

    return {"ok": True, "run_id": run_id, "seq": seq,
            "status": r.status, "woken": woke,
            "note": ("已送达，它会在下一步之前读到" if not woke
                     else "已送达，并已把它叫醒继续")}


def _follow_up(project_id: str, r, text: str, background: BackgroundTasks) -> dict:
    """这一轮已结束，用户又说了一句：**同一线程接着做**（上下文全在）。

    此前这里是 409「请新建一轮」——用户问一句"第 3 镜为什么没改"，得到的是一轮
    什么都不记得的新对话。
    """
    from ..jobs import RUNNERS, create_job
    from ..job_submit import _run_job_guarded

    _ensure_no_other_active(project_id, r.id)
    seq = store.add_step(r.id, kind="user_message", result=text[:4000],
                         decided_by=access.current_user_id())
    store.update_run(r.id, status="pending", error=None)
    jid = create_job("agent_run", {"project_id": project_id, "run_id": r.id,
                                   "resume": None, "followup": text})
    background.add_task(_run_job_guarded, RUNNERS["agent_run"], jid, "agent_run")
    return {"ok": True, "run_id": r.id, "seq": seq, "status": "pending",
            "woken": True, "note": "已送达，接着这一轮继续"}


def _ensure_no_other_active(project_id: str, except_id: str | None = None) -> None:
    """同一项目同时只允许一轮在跑：两轮会同时改同一批镜头。"""
    with get_session() as s:
        q = (s.query(store.AgentRun)
             .filter(store.AgentRun.project_id == project_id,
                     store.AgentRun.status.in_(("pending", "running", "waiting_approval"))))
        if except_id:
            q = q.filter(store.AgentRun.id != except_id)
        active = q.first()
    if active:
        raise HTTPException(
            409, f"这个项目已有一轮 AI 制片在进行中（{active.id}）。请先停止它，或等它结束。")


async def _append_inbox(run_id: str, text: str) -> None:
    """把一句话追加进 checkpoint 里的 `inbox`。"""
    await _mini_update(run_id, {"inbox": [{"text": text}]})


async def _mini_update(run_id: str, values: dict) -> None:
    """往 checkpoint 的 state 里写几个字段，**不建图、不初始化工具**。

    ## 为什么用一张只有 schema、没有节点的空图

    写 state 需要 `aupdate_state`，而它要求一个已 compile 的图。为了写一句话
    去 `build_graph()` 会把 llm 工厂、55 个工具、ToolNode 全部初始化一遍 ——
    慢且可能因为上游配置问题失败，而这里失败没有任何好处。

    `StateGraph(AgentState)` 只带 schema 编译出来就够 `aupdate_state` 用了。
    `inbox` 的 reducer 是 `merge_inbox`，所以传一条 = **追加**，不会覆盖别的字段。

    ⚠️ 空图编译会抛 `Graph must have an entrypoint` —— 必须挂一个 no-op 节点
    并连一条 START→它 的边。这个节点**永远不会被执行**（我们只调
    `aupdate_state`，不 invoke），它存在的唯一目的是让图通过校验。

    ## 没 checkpoint 时怎么办

    run 刚建、runner 还没起过 —— 这时没有 thread 可写。**直接返回**：
    runner 启动时会用 `store.pending_inbox()` 从步骤表里把没读过的插话补进
    初始 state。这是保底路径，也是"先落库再改 state"这条顺序的意义。
    """
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
    from langgraph.graph import START, StateGraph

    from ..agent.graph import AgentState
    from ..agent.runner import _checkpoint_path

    def _noop(state):          # 永不执行，只为让图通过入口校验
        return {}

    cfg = {"configurable": {"thread_id": run_id}}
    async with AsyncSqliteSaver.from_conn_string(_checkpoint_path()) as saver:
        snap = await saver.aget_tuple(cfg)
        if snap is None:
            return                # runner 会用 pending_inbox 兜底
        mini_graph = StateGraph(AgentState)
        mini_graph.add_node("noop", _noop)
        mini_graph.add_edge(START, "noop")
        mini = mini_graph.compile(checkpointer=saver)
        # ⚠️ 必须显式 `as_node`：图里只有一个节点时 langgraph 仍会报
        # `Ambiguous update, specify as_node`（它要据此决定下一个节点是谁）。
        # 这里指定 noop，写完之后不会再被 invoke，所以"下一个是谁"无所谓。
        await mini.aupdate_state(cfg, values, as_node="noop")


@access.requires(access.ROLE_EDITOR)
@router.post("/projects/{project_id}/agent/runs/{run_id}/cancel")
def cancel(project_id: str, run_id: str) -> dict:
    """停止这一轮（不撤销已生成的东西）。"""
    from ..db import Job, get_session as _gs

    _pid_guard(project_id)
    r = _one_run(run_id, project_id)
    if r.status in ("done", "failed", "cancelled"):
        return {"ok": True, "run_id": run_id, "status": r.status,
                "note": "已结束，无需停止"}

    store.update_run(run_id, status="cancelled")
    # 把它派生的仍在跑的任务也停掉 —— 否则用户点了停止，后台还在出片花钱。
    stopped = []
    for job_id in store.run_job_ids(run_id):
        with _gs() as s:
            j = s.get(Job, job_id)
            if j and j.status in ("pending", "running"):
                j.status = "cancelled"
                s.commit()
                stopped.append(job_id)
    return {"ok": True, "run_id": run_id, "status": "cancelled",
            "cancelled_jobs": stopped}


# ---------------------------------------------------------------------------
# 元信息
# ---------------------------------------------------------------------------

@router.get("/bgm-library")
def bgm_library(mood: Optional[str] = None,
                min_intensity: int = 1, max_intensity: int = 5) -> dict:
    """配乐库。**全局只读**，不按项目隔离（与音色库同款）。"""
    from ..bgm import list_library
    return list_library(mood=mood, min_intensity=min_intensity,
                        max_intensity=max_intensity)


@router.get("/audit/overview")
def audit_overview(project_id: str) -> dict:
    """体检三件套的**汇总数**（§13.4）。不启动 run、不花钱。

    面板只显示三个数 + 一个「让 Agent 处理」按钮。明细在抽屉里可展开、
    默认折叠 —— 报出几百条然后全部铺开，用户就不看了，等于没做。

    ## 为什么走项目级鉴权而不是全局

    它读的是某个项目的镜头与提示词。用 `can_access_project` 而不是
    `@access.requires(owner)`：项目的查看者也有权知道自己这个项目有毛病，
    而这个接口是纯读的。
    """
    with get_session() as s:
        if not access.can_access_project(s, project_id):
            raise HTTPException(404, "项目不存在或无权访问")
    from ..agent.audit import overview
    return overview(project_id)


@access.requires(access.ROLE_OWNER)
@router.get("/agent/tools")
def agent_tools() -> dict:
    """工具清单（排障用：确认注册了哪些、各自什么风险档）。"""
    from ..agent import registry
    from ..agent import tools_gen, tools_read, tools_write  # noqa: F401

    return {"tools": [
        {"name": s.name, "risk": s.risk, "risk_cn": policy.RISK_CN.get(s.risk),
         "role": s.role, "costs": s.costs,
         "confirm": "按参数" if callable(s.confirm) else bool(s.confirm),
         "long_running": s.long_running,
         "description": s.description}
        for s in registry.all_specs().values()
    ]}
