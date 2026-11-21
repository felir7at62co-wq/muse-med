"""桌面端 Agent 的**统一工具网关**。

```
GET  /v2/desktop-agent/tools        工具清单（模型可见的 schema + 风险档）
POST /v2/desktop-agent/tool         调一个工具：{project_id, name, args}
```

## 为什么是一个网关，而不是给桌面端重开 N 个业务端点

镜流的业务能力**已经**被超级 Agent 包成 75 个带元数据的工具
（`agent/tools_{read,write,gen,audit}.py`），每个都声明了 `role`（四档）、
`costs`（报价）、`confirm`（要不要人点头），并且统一走
`executor.execute_tool` 做权限/报价/审计。桌面端要的是同一批能力。

再开一套 HTTP 端点意味着：闸门要写第二份，而两份必然漂移 —— 漂移的方向
永远是"网页里拦住了、桌面端没拦"。所以这里只是把 `execute_tool` 接到
HTTP 上，**判断逻辑一行都不复制**。

## 与超级 Agent（`/projects/{pid}/agent/runs`）的分工

| | 超级 Agent | 这个网关 |
|---|---|---|
| 谁在决定调什么 | 服务端 LangGraph 自己规划多步 | 客户端 Agent（模型在用户电脑上） |
| 状态 | `agent_runs` 表里有完整一轮 | 无服务端 run，一次请求一个工具 |
| 适合 | "把这部片做完" | "读一下第 3 集现在什么状态" |

## 花钱

没有单次或每日的预算上限（2026-11-02 用户裁定删除）。钱由账户余额兜底：余额不足时
`charge` 扣款抛出，这里翻成 HTTP 402，客户端提示去充值。

## 不做什么

· **不代跑生成后的等待**：长任务工具返回 `job_id`，客户端自己轮询 `/v2/jobs/{id}`
  （或已订阅的 SSE）。网关里等 5 分钟会把连接占死。
· **不替客户端做确认**：`confirm` 判据命中的工具直接返回 `409`+`needs_confirm`，
  由客户端弹卡片、用户点过头后再带 `confirmed=true` 重发。网关不记得
  "刚才谁批过" —— 那需要服务端 run，而桌面端刻意没有。
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import access
from ..agent import policy, registry
from ..agent.executor import ToolCtx, role_allows

logger = logging.getLogger("fw.desktop_agent")

router = APIRouter(prefix="/v2", tags=["desktop-agent"])

class ToolCallIn(BaseModel):
    #: 项目级工具必填；账号级工具（`tags` 含 `account`，如 list_projects）可留空。
    project_id: str = ""
    #: 工具名（`GET /v2/desktop-agent/tools` 里的 `name`）。
    name: str
    #: 工具参数，形状见该工具的 `parameters`。
    args: dict[str, Any] = {}
    #: 已废弃，忽略（旧客户端仍会发送）。
    cap_fen: Optional[int] = None
    #: 客户端已经弹过确认卡片、用户点过头。只对 `confirm` 命中的工具有意义。
    confirmed: bool = False
    #: 客户端处在通宵模式（无人值守）。此时换掉已有剧本一律拒绝：没人能拦，而旧剧本不留历史。
    unattended: bool = False
    #: 客户端这次工具调用的 id（模型给的 tool_call id）。**生成类工具的幂等键**：
    #: 同一个 call_id 重发只会接管已有任务，不会再提交一次。不传则每次视为新调用。
    call_id: str = ""


def _ensure_tools_loaded() -> None:
    """显式导入工具模块 —— 不导入的话装饰器不执行，注册表是空的。

    与 `agent/runner.py` 同一个坑：`registry` 是**导入副作用**填充的。
    """
    from ..agent import (tools_audit, tools_gen, tools_gen2, tools_read,  # noqa: F401
                         tools_write)


def _role_of(project_id: str) -> str | None:
    """当前登录者在这个项目里是什么档。与 `agent.runner._role_of` 同一口径。"""
    from ..db import get_session
    with get_session() as s:
        return access.project_role(s, project_id)


@router.get("/desktop-agent/tools")
def list_tools() -> dict:
    """模型可调的工具清单：**全部工具**，含 manager 档（2026-10-30 用户裁定）。

    桌面端就是 Agent 本身，网页能做的事它都要能做。清单不按档位裁剪：
    一个工具能不能用要看**调用时**这个人在那个项目里是什么档，而档位是
    逐项目不同的 —— 列表阶段裁掉只会让他在自己当管理者的项目里也用不了。
    档位由 `call_tool` 的 `role_allows` 拦，与超级 Agent 同一把闸。
    """
    _ensure_tools_loaded()
    out = []
    for spec in registry.all_specs().values():
        out.append({
            "name": spec.name,
            "description": spec.description,
            "parameters": spec.args_schema.model_json_schema(),
            "risk": spec.risk,
            "role": spec.role,
            "costs": spec.costs,
            "long_running": spec.long_running,
            "needs_confirm": bool(spec.confirm),
            # 账号级工具（列项目、查余额、建项目）不属于任何项目；其余工具都要
            # 由调用方在顶层给 project_id —— 有些工具的参数表里没有它（get_shot、
            # get_job…），客户端据此给它们补上这个参数。
            "account_scoped": "account" in (spec.tags or []),
        })
    return {"tools": out, "count": len(out)}


class QuoteIn(BaseModel):
    project_id: str = ""
    name: str
    args: dict[str, Any] = {}


@router.post("/desktop-agent/quote")
def quote_tool(body: QuoteIn) -> dict:
    """给一次工具调用报价，**不执行**。桌面端用它填审批卡片上的金额。

    与 `call_tool` 的报价用**同一个** `policy.estimate_for`：审批卡上的数字
    与闸门、扣费口径一致，不另写一套（两套必然漂移成"卡上 5 元、实际 50 元"）。
    权限与 `call_tool` 同一口径：不是成员 404、档位不够 403 —— 报价也是在读项目。
    """
    _ensure_tools_loaded()
    spec = registry.get_spec(body.name)
    if spec is None:
        raise HTTPException(404, {"code": "tool_not_found", "message": f"没有这个工具：{body.name}"})
    account_scoped = "account" in (spec.tags or [])
    role = "viewer" if account_scoped else _role_of(body.project_id)
    if role is None:
        raise HTTPException(404, {"code": "project_not_found", "message": "项目不存在"})
    if not role_allows(role, spec.role):
        raise HTTPException(403, {"code": "forbidden",
                                  "message": f"需要「{spec.role}」档，当前是「{role}」"})
    args = dict(body.args or {})
    if "project_id" in spec.args_schema.model_fields:
        args["project_id"] = body.project_id
    est, note = policy.estimate_for(spec, args)
    return {"tool": spec.name, "costs": bool(spec.costs), "estimate_fen": int(est),
            "estimate_yuan": f"{int(est) / 100:.2f}", "note": note}


@router.post("/desktop-agent/tool")
async def call_tool(body: ToolCallIn) -> dict:
    """调一个工具。返回模型可读的 `result`（与 ToolMessage 同一份文本）。

    ## 三条失败语义，客户端要区别对待

    | HTTP | `code` | 客户端该做什么 |
    |---|---|---|
    | 404 | `tool_not_found` | 工具不存在（版本不匹配），别重试 |
    | 403 | `forbidden` | 权限不够，告诉用户 |
    | 409 | `needs_confirm` | 弹确认卡片，点过头后带 `confirmed=true` 重发 |
    | 402 | `insufficient_credit` | 余额不足，告诉用户去充值 |
    | 200 | — | `ok` 字段自己看（工具级失败也是 200，`ok=false`） |

    工具级失败用 200 + `ok=false` 是有意的：模型看到结构化错误能自己纠正
    （"old 出现了 2 次，请多带几个字"），HTTP 5xx 会让客户端直接放弃。
    """
    _ensure_tools_loaded()

    spec = registry.get_spec(body.name)
    if spec is None:
        raise HTTPException(404, {"code": "tool_not_found",
                                  "message": f"没有这个工具：{body.name}"})

    # 账号级工具（列项目、查余额）不属于任何项目：项目成员校验对它们无意义，
    # 且桌面端第一步就是 list_projects —— 这时手上还没有 project_id。
    # 只认工具声明里的 `account` 标记，不按"没传 project_id"放行：
    # 后者会让任何项目级工具在漏传参数时绕过成员校验。
    account_scoped = "account" in (spec.tags or [])
    role = "viewer" if account_scoped else _role_of(body.project_id)
    if role is None:
        # 与全站口径一致：不是成员一律 404，不区分"不存在"与"无权限"
        raise HTTPException(404, {"code": "project_not_found",
                                  "message": "项目不存在"})
    if not role_allows(role, spec.role):
        raise HTTPException(403, {"code": "forbidden",
                                  "message": f"需要「{spec.role}」档，当前是「{role}」",
                                  "your_role": role,
                                  "required_role": spec.role})

    args = dict(body.args or {})
    # `project_id` 一律以顶层为准：让模型能在一个工具调用里改项目，
    # 是"改错项目"这类事故最省事的来源。
    if "project_id" in spec.args_schema.model_fields:
        args["project_id"] = body.project_id

    # 通宵模式下换剧本一律不做（2026-11-02 用户裁定：「换掉剧本显然是错误操作，除非用户明确要求」）。
    # 判据与确认门同一个（`_replaces_script`）：空项目第一次写剧本照常放行。
    if body.unattended and spec.name == "import_script" and policy.needs_confirm(spec, args):
        raise HTTPException(409, {
            "code": "blocked_unattended",
            "message": "通宵模式下不会换掉已有剧本。要换剧本，请用户醒来后在普通模式下自己确认。",
            "tool": spec.name,
        })

    # 确认门：只有真正找不回来的操作才走这里（换剧本 / 强制重拆 / 合并资产）
    if policy.needs_confirm(spec, args) and not body.confirmed:
        raise HTTPException(409, {
            "code": "needs_confirm",
            "message": policy.confirm_text(spec, args) or "这一步会丢掉一些东西，需要你确认",
            "tool": spec.name,
        })

    uid = access.current_user_id()
    # ⚠️ run_id 与 call_id 都不能为空（2026-10-30 修）。生成类工具的 job id 是
    #    `sha1(run_id:tool_call_id)`；两者都空时它对每种工具是**一个常数**，
    #    于是全平台第一次之后的每次出片/首帧/拆解都"接管"那条旧任务、什么都不生成。
    #    run_id 按人分（顺带让 agent_steps 成为桌面端调用的审计记录，≤16 字符），
    #    call_id 用客户端的 tool_call id：同一调用重发去重，不同调用各自提交。
    run_id = f"desktop-{uid or 0}"[:16]
    call_id = (body.call_id or "").strip() or uuid.uuid4().hex
    ctx = ToolCtx(
        run_id=run_id,
        project_id=body.project_id,
        user_id=uid,
        role=role,
        spent_fen=0,
        # 模型名只用于工具内部的展示/日志；桌面端不做服务端推理。
        model="desktop",
    )

    from ..agent.executor import execute_tool
    text = await execute_tool(ctx, spec, args, call_id=call_id)

    try:
        payload = json.loads(text)
    except (ValueError, TypeError):
        payload = {"ok": True, "result": text}
    if not isinstance(payload, dict):
        payload = {"ok": True, "result": payload}

    # 402 是**工具内部**（charge）抛出来的，被 execute_tool 转成了 ok=false 文本。
    # 这里把它翻成 HTTP 402，客户端才能弹"去充值"而不是"操作失败"。
    err = str(payload.get("error") or "")
    if "余额不足" in err or "积分不足" in err or "InsufficientCredit" in err:
        raise HTTPException(402, {"code": "insufficient_credit", "message": err})

    return {"tool": spec.name, **payload}


class OvernightBeatIn(BaseModel):
    #: 客户端会话 id（一段通宵任务一个）。
    session_id: str
    project_id: str = ""
    #: 一句话：哪个项目、做什么。
    title: str = ""
    #: 进度，如「12/30 镜」。
    progress: str = ""
    #: 正在做什么。
    doing: str = ""


class OvernightEndIn(BaseModel):
    session_id: str
    #: offline：为什么要下线（「关机」「退出镜流」）；finish：早上的报告。
    text: str = ""
    #: finish 时：没做完就停了（卡住、余额不足）。
    stopped: bool = False


def _overnight_user() -> int:
    uid = access.current_user_id()
    if not uid:
        raise HTTPException(401, {"code": "not_signed_in", "message": "没有登录"})
    return uid


@router.post("/desktop-agent/overnight/beat")
def overnight_beat(body: OvernightBeatIn) -> dict:
    """通宵模式心跳（每分钟一次）。断过线的会恢复并飞书告诉用户。"""
    from .. import overnight
    try:
        return overnight.beat(_overnight_user(), body.session_id, body.model_dump())
    except PermissionError as e:
        raise HTTPException(403, {"code": "forbidden", "message": str(e)}) from None
    except ValueError as e:
        raise HTTPException(400, {"code": "bad_request", "message": str(e)}) from None


@router.post("/desktop-agent/overnight/offline")
def overnight_offline(body: OvernightEndIn) -> dict:
    """客户端要下线（退出、关机）：立刻标离线并飞书告诉用户，不等心跳超时。"""
    from .. import overnight
    return overnight.offline(_overnight_user(), body.session_id, body.text)


@router.post("/desktop-agent/overnight/finish")
def overnight_finish(body: OvernightEndIn) -> dict:
    """通宵任务结束：报告飞书发给用户本人。"""
    from .. import overnight
    return overnight.finish(_overnight_user(), body.session_id, body.text, stopped=body.stopped)
