"""飞书机器人的前台（2026-11-01）：每条消息都先到这里，由模型决定怎么答。

用户裁定：不匹配固定命令，一律交给 AI。前台自己处理账号级的事（提醒、飞书文档、余额、
选项目、切平台），要动手的活用 `delegate` 交给当前平台的 Agent。提醒在前台，所以用户
在哪个平台都能用。一个聊天同一时刻只连一个平台，平台各自的工具不会同时出现。

确认、取消、停止不在这里：花钱和找不回来的操作只认用户的原话（见 feishu_bot._handle），
模型没有批准的入口。

上下文有界：历史只取 `feishu_bot_log` 里最近 `HISTORY_MESSAGES` 条、`HISTORY_WINDOW_SEC`
以内的消息，每条截断；一轮最多 `MAX_ROUNDS` 次工具调用，单个工具结果也截断。
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from .db import get_session
from .err_text import human_error

logger = logging.getLogger("fw.feishu_front")

MODEL = "deepseek-flash"
MAX_ROUNDS = 6
HISTORY_MESSAGES = 20
HISTORY_WINDOW_SEC = 6 * 3600
HISTORY_CHARS = 1500
CURRENT_CHARS = 20000
TOOL_RESULT_CHARS = 24000
_CST = timezone(timedelta(hours=8))

ACCOUNT_TOOLS = ["get_my_balance", "create_feishu_doc", "read_feishu_doc", "edit_feishu_doc",
                 "remind_me", "list_reminders", "cancel_reminder"]

_LOCAL_TOOLS: list[dict] = [
    {"type": "function", "function": {
        "name": "delegate",
        "description": "把要动手或要查平台内容的事交给当前平台的 Agent。它做完会自己把结果发给用户。"
                       "task 写清要做什么，带上上文里它需要的信息，它看不到这段聊天。",
        "parameters": {"type": "object", "properties": {"task": {"type": "string"}}, "required": ["task"]}}},
    {"type": "function", "function": {
        "name": "list_projects",
        "description": "列出用户能进的镜流项目。",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "select_project",
        "description": "选定当前镜流项目。query 是序号（list_projects 里的）、片名或片名的一部分。",
        "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "switch_platform",
        "description": "用户要求时切换平台：jingliu 是镜流（视频），script 是剧本平台（大纲、正文、剧本）。",
        "parameters": {"type": "object", "properties": {"platform": {"type": "string", "enum": ["jingliu", "script"]}},
                       "required": ["platform"]}}},
]

_SYSTEM = """你是「镜流」的飞书机器人，用户在飞书私聊里跟你说话。回复用中文，简短自然，不提工具名。

现在是北京时间 {now}。
当前平台：{platform}。
{project}
{pending}

平台：镜流做视频（拆镜、资产、提示词、出图出片、配音字幕、剪辑、导出剪映草稿）；剧本平台写文字（大纲、正文、剧本、体检精修、改编、去AI味、小说推文）。用户说的事属于另一个平台时，告诉他可以切过去，他同意再切。

你自己能做：到点提醒、查和取消提醒、新建飞书文档、读和改飞书文档（用户发链接）、查余额。这些在两个平台都能用，不要交给 Agent。
其他要动手或要看平台内容的事用 delegate 交出去，然后用一句话告诉用户你在办，结果由 Agent 发给他。
用户发来的图片已经由系统看过，描述和地址写在他的消息里。

用户问你能做什么时：先说两个平台的主要能力，再说他多半不知道的：飞书里直接说「明天三点提醒我开会」、发文档链接让你读或改、把内容写成飞书文档、任务做完提醒、发图片、切换平台。
花钱或找不回来的操作，Agent 会发确认内容，用户回复「确认」或「取消」。你不能替他确认。"""


Tool = Callable[[dict], Awaitable[Any]]


def _history(open_id: str) -> list[dict]:
    from .feishu_bot import FeishuBotLog

    since = time.time() - HISTORY_WINDOW_SEC
    with get_session() as s:
        rows = s.query(FeishuBotLog).filter(FeishuBotLog.open_id == open_id, FeishuBotLog.ts >= since,
                                            FeishuBotLog.kind != "group_ignored") \
            .order_by(FeishuBotLog.id.desc()).limit(HISTORY_MESSAGES).all()
        return [{"role": "user" if r.direction == "in" else "assistant", "content": r.text[:HISTORY_CHARS]}
                for r in reversed(rows)]


def _system(chat: dict, pending: str) -> str:
    script = chat.get("platform") == "script"
    title = chat.get("project_title")
    return _SYSTEM.format(
        now=datetime.now(_CST).strftime("%Y-%m-%d %H:%M %A"),
        platform="剧本平台" if script else "镜流",
        project="" if script else (f"当前项目：{title}。" if title else "还没选项目。"),
        pending=pending)


def _llm():
    from .providers.llm import LLMProvider

    return LLMProvider(model_id=MODEL)


async def _account_tool(chat: dict, name: str, args: dict, call_id: str) -> str:
    from .agent import registry, tools_read, tools_write  # noqa: F401
    from .agent.executor import ToolCtx, execute_tool

    spec = registry.get_spec(name)
    ctx = ToolCtx(run_id=f"feishu-{chat['user_id']}"[:16], project_id="", user_id=chat["user_id"],
                  role="viewer", model=MODEL)
    return await execute_tool(ctx, spec, args, call_id=call_id)


async def turn(chat: dict, text: str, local: dict[str, Tool], *, pending: str = "") -> str:
    """跑一轮前台对话，返回要发给用户的话（可能为空：Agent 接手后没什么要补充的）。"""
    from .agent import registry, tools_read, tools_write  # noqa: F401

    tools = registry.tools_schema(names=ACCOUNT_TOOLS) + _LOCAL_TOOLS
    # 这句话已经进了审计日志，日志里的是截断版；发给模型的要完整。
    past = _history(chat["open_id"])[:-1]
    messages: list[dict] = [{"role": "system", "content": _system(chat, pending)}, *past,
                            {"role": "user", "content": text[:CURRENT_CHARS]}]
    llm = _llm()
    for _ in range(MAX_ROUNDS):
        msg = await llm.chat_with_tools(messages, tools)
        calls = msg.get("tool_calls") or []
        if not calls:
            return (msg.get("content") or "").strip()
        messages.append(msg)
        for call in calls:
            fn = call.get("function") or {}
            name, raw = fn.get("name") or "", fn.get("arguments")
            try:
                args = raw if isinstance(raw, dict) else json.loads(raw or "{}")
                if name in local:
                    out = await local[name](args)
                elif name in ACCOUNT_TOOLS:
                    out = await _account_tool(chat, name, args, call.get("id") or uuid.uuid4().hex)
                else:
                    out = {"ok": False, "error": f"没有这个工具：{name}"}
            except Exception as e:  # noqa: BLE001  工具失败要让模型知道，由它告诉用户
                logger.warning("[feishu-front] 工具 %s 失败：%r", name, e)
                out = {"ok": False, "error": human_error(e, 300)}
            text = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)
            messages.append({"role": "tool", "tool_call_id": call.get("id"), "content": text[:TOOL_RESULT_CHARS]})
    return "这件事步骤比较多，我先停在这里。你想先看哪一部分？"
