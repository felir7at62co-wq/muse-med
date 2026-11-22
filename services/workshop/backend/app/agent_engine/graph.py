"""组装 LangGraph agent：工具 + 中间件 + Postgres 检查点。"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from langchain.agents import create_agent
from langchain.agents.middleware import (HumanInTheLoopMiddleware, ModelCallLimitMiddleware,
                                         ModelFallbackMiddleware, SummarizationMiddleware,
                                         TodoListMiddleware)
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from .context import EngineContext
from .llm import build_models
from .policy import interrupt_config
from .prompts import PROFILE_TOOLS, system_prompt
from .tools import all_tools

#: 单次运行的模型调用上限。**默认不设限**（0 = 不限）。
#:
#: 2026-11-06 用户裁定：移除这个限制。理由：它按"一次运行"计数，而客户端驱动的
#: 一部 60 集剧要经历 判断→生成→验收→定点修→复验 的循环，全流程几百上千次调用
#: 是正常工作量；300 的上限会让长任务在跑到一半时被静默 end 掉
#: （ModelCallLimitMiddleware 默认 exit_behavior="end"），用户只看到"Agent 停了"。
#: 真正的成本控制应落在预算/计费上，不是按调用次数截断任务。
#: 需要临时收紧时仍可用环境变量 AGENT_ENGINE_CALL_LIMIT 指定次数。
MODEL_CALL_LIMIT = int(os.environ.get("AGENT_ENGINE_CALL_LIMIT", "0"))
#: 上下文压缩触发点（token）。只在接近窗口时压缩，保留最近 30 条消息原文。
SUMMARIZE_AT_TOKENS = int(os.environ.get("AGENT_ENGINE_SUMMARIZE_AT", "180000"))


def checkpoint_dsn() -> str:
    """检查点库连接串：与业务库同库，但放独立 schema agent_ckpt。"""
    url = os.environ.get("DATABASE_URL", "")
    url = url.replace("postgresql+psycopg://", "postgresql://").replace("postgresql+asyncpg://", "postgresql://")
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}options=-csearch_path%3Dagent_ckpt"


@asynccontextmanager
async def checkpointer():
    async with AsyncPostgresSaver.from_conn_string(checkpoint_dsn()) as saver:
        yield saver


async def setup_checkpointer() -> None:
    """建检查点表（幂等）。worker 启动时调用一次。"""
    async with checkpointer() as saver:
        await saver.setup()


def tools_for(profile: str) -> list:
    allowed = PROFILE_TOOLS[profile]
    return [t for name, t in all_tools().items() if allowed is None or name in allowed]


def build_agent(ctx: EngineContext, saver, model: str | None = None):
    # [(渠道名, 实际下发的模型名, LLM), ...]：渠道名与真实模型名要留着写进事件/用量，
    # 否则"这次到底跑的是官方还是中转、跑的是哪个型号"永远查不出来。
    built = build_models(model)
    primary = built[0][2]
    fallbacks = [x[2] for x in built[1:]]
    middleware = [
        HumanInTheLoopMiddleware(interrupt_on=interrupt_config()),
        TodoListMiddleware(),
        SummarizationMiddleware(model=primary, trigger=("tokens", SUMMARIZE_AT_TOKENS), keep=("messages", 30)),
    ]
    # 0 = 不装这个中间件（不限次数）。见上方 MODEL_CALL_LIMIT 的说明。
    if MODEL_CALL_LIMIT > 0:
        middleware.append(ModelCallLimitMiddleware(run_limit=MODEL_CALL_LIMIT))
    if fallbacks:
        middleware.insert(0, ModelFallbackMiddleware(*fallbacks))
    return create_agent(
        primary, tools=tools_for(ctx.profile), system_prompt=system_prompt(ctx.profile, ctx.draft_id),
        middleware=middleware, checkpointer=saver, context_schema=EngineContext,
    )


def thread_config(conversation_id: int) -> dict:
    return {"configurable": {"thread_id": f"conv:{conversation_id}"}, "recursion_limit": 2000}
