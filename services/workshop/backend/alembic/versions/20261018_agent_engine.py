"""Agent 引擎：agent_runs / agent_run_events / agent_approvals 三张表 + 会话来源字段。

agent_conversations.source：存量会话**一律保持默认 studio，不做推断回填**。
  曾考虑"消息 group_id 全空 = 超级 Agent"，但 dev 实测 161 个这样的会话里混着大量
  对话工坊会话（早期对话工坊消息也不填版本化字段），推断会把它们误归到 Agent 列表。
  保持 studio 的效果与现状一致（旧超级 Agent 会话本来就出现在对话工坊列表里）；
  Agent 引擎新建的会话才标 agent。

Revision ID: 20261018_agent_engine
Revises: 20261018_llm_usage_timing
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "20261018_agent_engine"
down_revision = "20261018_llm_usage_timing"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("agent_conversations",
                  sa.Column("source", sa.String(16), nullable=False, server_default="studio"))
    op.create_index("ix_agent_conversations_source", "agent_conversations", ["source"])

    op.create_table(
        "agent_runs",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, nullable=False, index=True),
        sa.Column("conversation_id", sa.Integer, nullable=False, index=True),
        sa.Column("draft_id", sa.Integer, index=True),
        sa.Column("profile", sa.String(16), nullable=False),
        sa.Column("model", sa.String(80)),
        sa.Column("status", sa.String(24), nullable=False, server_default="queued", index=True),
        sa.Column("message", sa.Text, nullable=False),
        sa.Column("final_text", sa.Text),
        sa.Column("error", sa.Text),
        sa.Column("cancel_requested", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("resume", JSONB),
        sa.Column("usage", JSONB),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now(), index=True),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("finished_at", sa.DateTime),
    )
    op.create_table(
        "agent_run_events",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column("run_id", sa.Integer, nullable=False, index=True),
        sa.Column("seq", sa.Integer, nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("payload", JSONB, nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.UniqueConstraint("run_id", "seq", name="uq_agent_run_events_run_seq"),
    )
    op.create_table(
        "agent_approvals",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("run_id", sa.Integer, nullable=False, index=True),
        sa.Column("interrupt_id", sa.String(64), nullable=False),
        sa.Column("idx", sa.Integer, nullable=False),
        sa.Column("tool", sa.String(64), nullable=False),
        sa.Column("args", JSONB, nullable=False, server_default="{}"),
        sa.Column("risk", sa.String(16)),
        sa.Column("description", sa.Text),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending", index=True),
        sa.Column("note", sa.Text),
        sa.Column("decided_at", sa.DateTime),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.UniqueConstraint("run_id", "interrupt_id", "idx", name="uq_agent_approvals_point"),
    )
    # LangGraph 检查点放独立 schema，不与业务表混放（表由 AsyncPostgresSaver.setup() 创建）
    op.execute("CREATE SCHEMA IF NOT EXISTS agent_ckpt")


def downgrade() -> None:
    op.drop_table("agent_approvals")
    op.drop_table("agent_run_events")
    op.drop_table("agent_runs")
    op.drop_index("ix_agent_conversations_source", table_name="agent_conversations")
    op.drop_column("agent_conversations", "source")
