"""llm_usage_logs 增加 cached_tokens：记录提示缓存命中量。

DeepSeek 官方直连默认启用上下文缓存（命中价约为未命中的 1/5~1/50），
不记这一列就无法判断缓存是否真的生效、也无法核算实际成本。

Revision ID: 20261019_llm_cached
Revises: 20261018_agent_engine
"""
from alembic import op
import sqlalchemy as sa

revision = "20261019_llm_cached"
down_revision = "20261018_agent_engine"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("llm_usage_logs", sa.Column("cached_tokens", sa.Integer(), server_default="0"))


def downgrade() -> None:
    op.drop_column("llm_usage_logs", "cached_tokens")
