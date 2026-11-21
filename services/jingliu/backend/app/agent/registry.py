"""工具注册表：把业务函数变成模型能调的工具。

## 与 drama `agent_engine/tools.py` 的关系

同形不同实现。drama 用 `engine_tool(name, risk, scope, long_running)` 装饰器 +
LangGraph 的 `@tool`；这里保留前者的**元数据约定**（risk / role / costs），
但注册出来的对象直接是 `langchain_core.tools.StructuredTool`，因为镜流直接走
LangGraph 的 `ToolNode`，中间不需要再转一层。

## 四条硬约定（漏一条就会出事故）

1. **每个工具都必须声明 `role`**：`scripts/verify_agent_tools.py` 会枚举断言。
   漏声明的后果是"查看者也能调生成工具"——越权且不报错。
2. **花钱的工具必须声明 `costs=True`**：执行器靠它报价，审批卡与步骤记录显示这个数。
   忘了声明 = 报价为 0。
3. **提交异步 job 的工具必须用 `submit_idempotent()`**，不许直接 `create_job`。
   理由见那个函数的文档：进程被杀重启后，LangGraph 会重放该节点，
   而重放的语义是"再执行一次"，不是"看看上次做完了没"。
4. **工具返回值必须是 `dict` 或 `str`**：LangGraph 会把返回值原样塞进
   ToolMessage。返回 ORM 对象会在序列化时炸，且报错信息看不懂。
"""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from typing import Annotated, Any, Callable, Literal

from langchain_core.tools import InjectedToolCallId, StructuredTool

logger = logging.getLogger("fw.agent.tools")

Risk = Literal["read", "write", "generate"]

#: 风险等级 → 人类可读（只用于展示；**不参与任何拦截判断**，见 policy 头注释）。
RISK_CN: dict[str, str] = {
    "read": "只读",
    "write": "修改数据",
    "generate": "生成（花钱）",
}


@dataclass
class ToolSpec:
    name: str
    fn: Callable
    description: str
    args_schema: Any
    risk: Risk
    role: str = "editor"
    #: 是否提交异步 job（意味着可能跑几分钟，需要 wait_for_job）。
    long_running: bool = False
    #: 是否会花钱（报价只对它生效；真实金额来自 charge.estimate）。
    costs: bool = False
    tags: list[str] = field(default_factory=list)
    #: 执行前要不要停下来等人点头。`True` / `False`，或 `(args) -> bool`。
    #:
    #: **只给真正找不回来的操作**（换整个剧本、强制重新拆解）。生成留版本、删资产
    #: 是软删、改提示词旧稿记在步骤里，都不属于这一类。判据只在
    #: `policy.needs_confirm` 一处，图的路由与审批节点都调它，执行器不再判。
    confirm: bool | Callable[[dict], bool] = False

    @property
    def tool(self) -> StructuredTool:
        return self._tool


_REGISTRY: dict[str, ToolSpec] = {}


def engine_tool(*, name: str, description: str, risk: Risk, role: str = "editor",
                long_running: bool = False, costs: bool = False,
                tags: list[str] | None = None,
                confirm: bool | Callable[[dict], bool] = False):
    """把一个 async 函数注册成模型可调的工具。

    用法：

        @engine_tool(name="run_shot_videos", risk="generate",
                     long_running=True, costs=True,
                     description="批量生成镜头视频…")
        async def run_shot_videos(ctx: ToolCtx, project_id: str,
                                  shot_ids: list[str] | None = None) -> dict: ...

    函数的**第一个参数必须是 `ctx: ToolCtx`**，它由执行层注入，不进 schema
    （模型看不到它，也不需要）。
    """
    def deco(fn: Callable) -> Callable:
        if name in _REGISTRY:
            raise ValueError(f"工具重名: {name}")

        def _invoke(**kwargs):
            raise RuntimeError("agent 工具必须通过 async 路径调用")

        # 去掉 ctx 后的签名就是模型看到的参数表。用 pydantic 的
        # `create_model` 从函数注解生成，避免手写两份 schema 漂移。
        from pydantic import create_model
        import inspect

        sig = inspect.signature(fn)
        fields: dict[str, tuple] = {}
        for i, (pname, param) in enumerate(sig.parameters.items()):
            if i == 0:
                continue                       # ctx
            ann = param.annotation if param.annotation is not inspect.Parameter.empty else str
            default = (param.default if param.default is not inspect.Parameter.empty
                       else ...)
            fields[pname] = (ann, default)
        ArgsModel = create_model(f"{name}_args", **fields)

        spec = ToolSpec(name=name, fn=fn, description=description,
                        args_schema=ArgsModel, risk=risk, role=role,
                        long_running=long_running,
                        costs=costs, tags=list(tags or []),
                        confirm=confirm)
        _REGISTRY[name] = spec
        fn._agent_spec = spec          # 便于测试直接拿
        return fn

    return deco


def all_specs() -> dict[str, ToolSpec]:
    return dict(_REGISTRY)


def get_spec(name: str) -> ToolSpec | None:
    return _REGISTRY.get(name)


# ---------------------------------------------------------------------------
# LangGraph 侧：把 ToolSpec 变成 StructuredTool / 工具 schema
# ---------------------------------------------------------------------------

def build_langchain_tools(ctx, *, names: list[str] | None = None) -> list[StructuredTool]:
    """生成给 `ToolNode` 用的工具列表。

    `ctx` 会闭包进每个工具 —— 里面装着 run 上下文（项目、用户、花费）。

    ## tool_call_id 用框架原生的 `InjectedToolCallId` 拿

    确定性 job id 靠它（`deterministic_job_id`）。注入参数只在给 ToolNode 的 schema
    里，**模型看到的 schema（`tools_schema()`）不含它**。
    2026-10-21 之前这里没拿到它（恒为空串），同一轮第二次出片被当成重放 dedup；
    中间一版靠覆写 `StructuredTool.arun` 灌 contextvar，依赖框架内部签名，已改回原生做法。
    """
    from pydantic import create_model

    out: list[StructuredTool] = []
    for spec in _REGISTRY.values():
        if names is not None and spec.name not in names:
            continue

        InjModel = create_model(
            f"{spec.name}_args_injected", __base__=spec.args_schema,
            tool_call_id=(Annotated[str, InjectedToolCallId], ...))

        async def _run(_spec=spec, tool_call_id: str = "", **kwargs):
            from .executor import execute_tool
            return await execute_tool(ctx, _spec, kwargs, call_id=tool_call_id)

        out.append(StructuredTool.from_function(
            coroutine=_run,
            name=spec.name,
            description=spec.description,
            args_schema=InjModel,
        ))
    return out


def tools_schema(*, names: list[str] | None = None) -> list[dict]:
    """OpenAI 格式的工具定义（给 `chat_with_tools` 用）。"""
    out = []
    for spec in _REGISTRY.values():
        if names is not None and spec.name not in names:
            continue
        out.append({
            "type": "function",
            "function": {
                "name": spec.name,
                "description": spec.description,
                "parameters": spec.args_schema.model_json_schema(),
            },
        })
    return out


# ---------------------------------------------------------------------------
# 幂等提交
# ---------------------------------------------------------------------------

def deterministic_job_id(run_id: str, tool_call_id: str) -> str:
    """同一个 (run, tool_call) 永远得到同一个 job id。

    ## 为什么这是安全底线而不是优化

    LangGraph 的 checkpoint 保证"节点不重跑"，但**不保证**节点内已发生的
    外部副作用不重复发生：一种情况是进程在工具执行完、checkpoint 落盘之前被杀，
    恢复时这个节点会被再执行一次。

    对一个"提交出片任务"的工具，那意味着**同一批镜头生成两遍**——按 120 镜
    ¥18.60 算，一次意外重启就是 18 块钱，而且用户完全看不出来（两个 job 都成功）。

    用确定性的 id 之后，重放时 `create_job` 会发现该 id 已存在，于是接管它、
    返回它的当前状态，而不是再建一条。
    """
    h = hashlib.sha1(f"{run_id}:{tool_call_id}".encode()).hexdigest()
    return h[:12]


async def submit_idempotent(ctx, *, kind: str, payload: dict,
                            tool_call_id: str, tool: str,
                            estimate_fen: int = 0) -> dict:
    """提交一个 job，**保证同一 tool_call 只提交一次**，并立刻派发它去跑。

    三件事在 `_SUBMIT_LOCK` 里原子完成：hold（预扣）→ create_job → 记账。
    与 `POST /v2/jobs` 用的是同一把锁、同一套 charge 口径 —— agent 不许有旁路，
    否则它和用户手点的任务会各扣一次钱。

    ## ⚠️ 派发这一步曾经整块缺失（2026-10-23 修）

    此前本函数**只 `create_job()` 写库就返回**，而所有派发点都在 HTTP 路由里
    （`background.add_task(_run_job_guarded, ...)`）。agent 跑在后台协程里，
    没有 request、没有 `BackgroundTasks` —— 于是它提交的每一个任务都只是
    库里的一个 `pending` 行，**从来没有执行体**。

    生产实测（2026-10-23，项目 2034）：agent 提交的 `asset_fill` 从建库起
    `status=pending / progress=0`、`created_at == updated_at`，agent 随后
    三次 `wait_for_job(timeout=300)` 白等 15 分钟，最后只能汇报"还在排队"，
    用户刷新页面看不到任何资产。更糟的是它在 `assets` 互斥组里，
    这条永不推进的 pending 会一直把用户手点的补图挡成 `deduped`。

    影响面是全部 17 个「提交异步 job」的工具：出片 / 首帧 / 拆解 / 配音 /
    字幕 / 放大 / 去字幕 / 补图全线。

    派发放在锁**外**：`_run_job_guarded` 一进去就要读 job 行，而在这里持锁
    起协程只是让出控制权、没有收益；且锁的语义是"提交不重复"，不是"跑完"。
    """
    from .. import charge
    from ..db import Job, get_session
    from ..job_submit import _SUBMIT_LOCK, spawn_job
    from ..jobs import create_job, get_job, get_job_phase
    from . import store

    jid = deterministic_job_id(ctx.run_id, tool_call_id)

    async with _SUBMIT_LOCK:
        existing = get_job(jid)
        if existing is not None:
            logger.info("[agent] 工具 %s 的 job %s 已存在（重放接管），不再提交",
                        tool, jid)
            # 重放接管时**也要确认它真的在跑**：进程重启会留下 pending/running
            # 却没有执行体的行（recover_zombie_tasks 只在启动时清一次）。
            # 不清醒地判断就 dispatch，会让同一个 job 被两个协程同时跑
            # （出片 = 同一批镜头生成两遍，直接翻倍烧钱）；不判断就干脆不管，
            # 则是永远卡住。判据：pending 且从未被推进过（updated == created）
            # = 确定没有执行体，可以安全接管；running 一律不动。
            revive = (existing.status == "pending"
                      and (existing.updated_at or "") == (existing.created_at or ""))
            if revive:
                logger.warning("[agent] job %s 是无人接管的 pending，重新派发", jid)
                spawn_job(None, jid, existing.kind)
            # ⚠️ 重放也要把这一笔计入本轮的已花（2026-10-23 修）。
            #    此前这里只返回、不记账：同一个 tool_call 被 checkpoint 重放时
            #    第一次记了 est、第二次不记。单轮内看似无害，但 runner 在批准 /
            #    叫醒 / 接续时会重建 ctx（`spent_fen` 从库里重算），两次口径不同
            #    就会出现"库里预扣 90 分、闸门以为只花了 30 分"，重放越多闸门越松。
            #    这里按 `agent_run_jobs` 里那一行记的预扣额补记，与首次提交同源。
            try:
                ctx.spent_fen += store.reserved_of_job(jid)
            except Exception:  # noqa: BLE001 — 记账失败不该让工具调用失败
                logger.debug("[agent] 补齐重放预扣失败 job=%s", jid, exc_info=True)
            return {
                "job_id": jid,
                "kind": existing.kind,
                "status": existing.status,
                "progress": existing.progress,
                "deduped": True,
                "note": ("这条任务在上一次执行时已提交，本次直接接管，没有重复提交"
                         + ("（此前没有执行体，现已重新派发）" if revive else "")),
            }

        # ⚠️ Bug 3 修复（2026-11-04）：检查同互斥组里是否有活动 job。
        # 相同 tool 被重试时（LLM 感知失败，用不同 tool_call_id 再调一次），
        # deterministic_job_id 会生成不同的 jid，上面的 existing 检查通过，
        # 但如果同互斥组里已有活动 job（pending/running），应该去重。
        #
        # 2026-11-05 修：原先这里写的是 `charge.mutex_group_of(kind, payload)`，
        # 但 **charge 里从来没有这个函数**（dev / prod 两个仓都搜不到定义），
        # 提交一走到这里就 AttributeError——所有经 Agent 提交的任务
        # （拆镜 / 出片 / 首图 / 补图…共 16 个调用点）全部失败。
        # 下一行 `find_active_job(project_id, mutex_group)` 的参数也是反的：
        # 它的签名是 (kind, project_id, payload)，返回 job id 字符串，
        # 却被当成对象取 `.id`。两处一起改对。
        #
        # 互斥分组本来就在 `find_active_job` 内部按 `_EXCLUSIVE_GROUPS` 判
        # （`shots` 组还升级成了按镜头集合相交），不要在调用方再算一遍。
        from ..jobs import find_active_job
        active_id = find_active_job(kind, payload.get("project_id"), payload)
        if active_id and active_id != jid:
            logger.info("[agent] 工具 %s 的 job 被去重到活动 job %s", tool, active_id)
            try:
                ctx.spent_fen += store.reserved_of_job(active_id)
            except Exception:  # noqa: BLE001
                logger.debug("[agent] 补齐去重预扣失败 job=%s", active_id, exc_info=True)
            active = get_job(active_id)
            if active is not None:
                return {
                    "job_id": active.id,
                    "kind": active.kind,
                    "status": active.status,
                    "progress": active.progress,
                    "deduped": True,
                    "note": "同类任务正在进行，本次直接接管，没有重复提交",
                }

        # ⚠️ **报价与扣费是两件事，必须分开算**（2026-10-21 修）。
        #
        # 原先写成 `if charged: est = estimate(...)`，于是"不需要扣钱的人"
        # （管理员：无限积分）拿到的报价恒为 0。后果有两个，都很隐蔽：
        #   · `agent_run_jobs.estimate_fen` 全是 0 → 一輪 run 的花费永远显示 ¥0；
        # 管理员不扣钱，但他仍然想知道这一轮花了多少。
        charged, _why = charge.should_charge(kind, payload)
        est, note = charge.estimate(kind, payload)
        if charged and est > 0:
            charge.hold(kind, payload, jid, amount_fen=est, note=note)
        create_job(kind, payload, jid=jid)

        from .store import link_run_job
        link_run_job(ctx.run_id, jid, tool, est)
        ctx.spent_fen += est

    # 出了锁再派发（见文档最后一段）。这一步缺失过整整一个版本，别删。
    spawn_job(None, jid, kind)

    return {
        "job_id": jid,
        "kind": kind,
        "status": "pending",
        "estimate_fen": est,
        "estimate_note": note,
        "deduped": False,
    }
