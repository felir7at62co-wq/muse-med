"""Agent 引擎的运行时上下文：每次运行注入一次，工具与审批策略都从这里读。"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class EngineContext:
    user_id: int
    role: str
    run_id: int
    conversation_id: int
    profile: str                    # studio / producer / readonly
    draft_id: int | None = None     # studio 配置档绑定的草稿
    #: 这一轮对话栏里选的**写作模型**（"deepseek:deepseek-v4-flash" 形式）。
    #: 空的含义是"用草稿自己记的写作模型"，与"没选"完全一致 —— 不能在这里落一个
    #: 默认值，否则用户没选也会把草稿的写作模型悄悄改掉。
    #: Agent 自己思考用的模型是另一个东西（AgentRun.model），两者互不覆盖：
    #: 想清楚用哪个 ≠ 想让稿子由哪个模型写。
    writing_model: str | None = None
    permissions: dict = field(default_factory=dict)   # user_profiles.agent_permissions（已与默认值合并）
