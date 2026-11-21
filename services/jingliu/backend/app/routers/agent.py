"""AI 指令条的模型侧：契约声明 + 一轮对话。

`GET  /v2/agent/protocol`  —— 提示词契约版本与限额（**不含密钥/渠道信息**）
`POST /v2/agent/turn`      —— 收意图 → 调模型 → 回结构化的命令**意图**

## 为什么从 routes_v2.py 搬出来

行数预算「只许减」（见 `routers/__init__.py`）。这一域的全部依赖就是
`agent_proxy` 模块与三个常量，与 `routes_v2` 无共享状态，整块自洽。

## 后端只到「意图」为止，落库一律不在这里

客户端拿着 `commands` **在自己进程内**走 `dispatch.ts` 执行（校验参数、dry-run、
确认门、入命令栈）。后端在这里落库是错的：AI 改了什么必须只有一处事实来源。
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import access
from .. import agent_proxy                 # AI 指令条：提示词契约 + 模型侧唯一出口
from ..agent_proxy import (                # 契约版本与限额常量（/agent/protocol 直读）
    AGENT_CONTRACT_VERSION, agent_max_commands, agent_max_input_chars,
)

router = APIRouter(prefix="/v2", tags=["agent"])


class AgentTurnIn(BaseModel):
    """一轮 Agent 对话的输入。

    ⚠️ `timeline_text` 是**客户端渲染好的时间轴文本**（`describeTimeline.toPromptText`），
    不是镜头数组。后端不去读数据库拼一份——那等于把"模型看到的现状"变成第二个
    事实来源，而模型下的命令是拿 id 指镜头，id 对不上就会改错镜头且不报错。
    渲染逻辑只应有一处。

    ⚠️ `capabilities` 由客户端下发（见 `agent_proxy` 模块头）。后端不维护副本。
    """
    text: str                                      # 用户这一句
    timeline_text: str = ""                        # 时间轴快照（纯文本）
    capabilities: list[dict] = []                  # 能力表导出（E5）
    project_id: Optional[str] = None               # 只用于让模型填 project_id 参数
    history: list[dict] = []                       # [{role, text}] 近几轮
    model_id: Optional[str] = None


class AgentTurnOut(BaseModel):
    reply: str
    done: bool
    commands: list[dict]                           # [{id, args}] 仅**意图**，不是 EditCommand
    dropped: list[str] = []                        # 被整形丢掉的条目及原因（不静默）
    model_id: str


@router.get("/agent/protocol")
async def agent_protocol() -> dict:
    """Agent 提示词契约版本（**不含任何密钥/渠道信息**）。

    客户端的 `prompt.ts` 里有一个同名的 `PROMPT_CONTRACT_VERSION`，
    `verify-agent.ts` 比对两者：不一致说明两端的提示词格式漂移了 ——
    那会让模型按一端的格式回答、另一端解析不了，且失败长相是
    "模型偶尔乱回"，极难定位。把它变成一条红灯。

    契约版本存成模块常量而不是配置项：它描述的是**代码**，不是部署环境的差异。
    """
    return {
        "contract_version": AGENT_CONTRACT_VERSION,
        "max_commands": agent_max_commands(),
        "max_input_chars": agent_max_input_chars(),
        # 显式声明"本接口不回传模型名/渠道/密钥"，让安全审查有个明确的断言点
        "leaks_credentials": False,
    }


@router.post("/agent/turn", response_model=AgentTurnOut)
@access.requires(access.ROLE_EDITOR)
async def agent_turn(body: AgentTurnIn) -> AgentTurnOut:
    """Agent 的模型侧：收意图 → 调模型 → 回结构化的命令意图。

    客户端拿着 `commands` **在自己进程内**走 `dispatch.ts` 执行（校验参数、dry-run、
    确认门、入命令栈）。后端在这里落库是错的：AI 改了什么必须只有一处事实来源。

    ⚠️ 密钥只存在于本进程的 settings；`LLMProvider` 从不回传 key，本接口也不回传
    渠道名（`/health` 已经在暴露渠道名与冷却标志，没必要再多一个泄漏面）。
    """
    if not (body.text or "").strip():
        raise HTTPException(status_code=422, detail="text 不能为空")
    # 一次 Agent 回合 = 一次文本操作（按次收）。放在 422 之后：
    # 空文本本身就是无效请求，不该收费。
    from .. import charge
    charge.charge_sync("reprompt", {"project_id": body.project_id},
                       desc="Agent 对话", project_id=body.project_id)
    try:
        out = await agent_proxy.run_turn(
            capabilities=body.capabilities,
            timeline_text=body.timeline_text,
            user_text=body.text,
            history=body.history,
            project_id=body.project_id,
            model_id=body.model_id,
        )
    except agent_proxy.AgentInputError as e:
        # 输入本身不合法：重试同一份输入必然再失败，让用户改输入
        raise HTTPException(status_code=422, detail=str(e))
    except agent_proxy.AgentProtocolError as e:
        # 模型回复不合协议：**值得重试**（客户端会重发一次再放弃）
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"LLM 调用失败: {e!r}")
    return AgentTurnOut(**out)
