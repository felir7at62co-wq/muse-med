"""llm_usage_logs 加渠道与耗时列：查清"偶发 10 分钟长尾"必须先有每次调用的渠道和耗时。

失败的调用原先不入表(只在 on_llm_end 里记), 现在也落一行(ok=false)。

Revision ID: 20261018_llm_usage_timing
Revises: 20261011_history_job_id
"""
from alembic import op
import sqlalchemy as sa

revision = "20261018_llm_usage_timing"
down_revision = "20261011_history_job_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("llm_usage_logs", sa.Column("channel", sa.String(40), nullable=True))
    op.add_column("llm_usage_logs", sa.Column("duration_ms", sa.Integer(), nullable=True))
    op.add_column("llm_usage_logs", sa.Column("ok", sa.Boolean(), nullable=True, server_default=sa.true()))
    op.add_column("llm_usage_logs", sa.Column("error", sa.String(300), nullable=True))
    op.create_index("ix_llm_usage_logs_duration_ms", "llm_usage_logs", ["duration_ms"])


def downgrade() -> None:
    op.drop_index("ix_llm_usage_logs_duration_ms", table_name="llm_usage_logs")
    for c in ("error", "ok", "duration_ms", "channel"):
        op.drop_column("llm_usage_logs", c)
