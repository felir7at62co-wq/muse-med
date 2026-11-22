"""Agent 引擎数据表：运行、运行事件、审批。

一次"运行" = 用户在某个 Agent 会话里发出的一条指令，及 Agent 为完成它所做的全部步骤。
同一会话的所有运行共用一个 LangGraph 线程（thread_id = conv:<会话id>），所以上下文连续。
"""
from __future__ import annotations

from sqlalchemy import (BigInteger, Boolean, Column, DateTime, Integer, String, Text,
                        UniqueConstraint, func)
from sqlalchemy.dialects.postgresql import JSONB

from ..db.models import Base

#: 运行状态
#:   queued            已入队，等 worker 领取
#:   running           正在执行
#:   awaiting_approval 停在审批点，worker 已释放；用户决定后重新入队
#:   done / failed / canceled  终态
RUN_ACTIVE = ("queued", "running", "awaiting_approval")
RUN_TERMINAL = ("done", "failed", "canceled")


class AgentRun(Base):
    __tablename__ = "agent_runs"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    conversation_id = Column(Integer, index=True, nullable=False)
    draft_id = Column(Integer, index=True)            # studio 配置档绑定的草稿；producer 可为空
    profile = Column(String(16), nullable=False)       # studio / producer / readonly
    model = Column(String(80))
    #: 这一轮派发的写作作业用哪个模型（"deepseek:deepseek-v4-flash"）。空 = 用草稿自己记的写作模型。
    #: 与 model 分开存：model 是 Agent 自己思考用的，writing_model 是它派出去写稿子用的，
    #: 两者可以不同，混成一个字段就没法分别调整、事后也查不清"这段稿子是谁写的"。
    writing_model = Column(String(80))
    status = Column(String(24), nullable=False, server_default="queued", index=True)
    message = Column(Text, nullable=False)             # 用户这一轮的指令原文
    final_text = Column(Text)                          # 最后一条助手回复
    error = Column(Text)
    cancel_requested = Column(Boolean, nullable=False, server_default="false")
    resume = Column(JSONB)                             # 审批决定（续跑时交给 Command(resume=...)）
    usage = Column(JSONB)                              # {input, output, model_calls}
    created_at = Column(DateTime, server_default=func.now(), index=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    finished_at = Column(DateTime)


class AgentRunEvent(Base):
    """运行中发生的每一件事，按 seq 递增；前端 SSE 按 after_seq 续读，断线重连不丢。"""
    __tablename__ = "agent_run_events"
    id = Column(BigInteger, primary_key=True)
    run_id = Column(Integer, index=True, nullable=False)
    seq = Column(Integer, nullable=False)
    type = Column(String(32), nullable=False)
    payload = Column(JSONB, nullable=False, server_default="{}")
    created_at = Column(DateTime, server_default=func.now())
    __table_args__ = (UniqueConstraint("run_id", "seq", name="uq_agent_run_events_run_seq"),)


class AgentApproval(Base):
    """待审批的工具调用。参数以这里保存的为准，前端只回传决定，不回传参数。"""
    __tablename__ = "agent_approvals"
    id = Column(Integer, primary_key=True)
    run_id = Column(Integer, index=True, nullable=False)
    interrupt_id = Column(String(64), nullable=False)
    idx = Column(Integer, nullable=False)              # 同一中断里的第几个待审批调用
    tool = Column(String(64), nullable=False)
    args = Column(JSONB, nullable=False, server_default="{}")
    risk = Column(String(16))
    description = Column(Text)
    status = Column(String(16), nullable=False, server_default="pending", index=True)  # pending/approved/rejected
    note = Column(Text)
    decided_at = Column(DateTime)
    created_at = Column(DateTime, server_default=func.now())
    __table_args__ = (UniqueConstraint("run_id", "interrupt_id", "idx", name="uq_agent_approvals_point"),)
