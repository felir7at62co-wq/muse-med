"""draft_read_state —— 未读状态（两级红点的数据来源）

Revision ID: 20260919_draft_read
Revises: 20260917_user_pref_model
Create Date: 2026-09-19

PLAN-剧本平台全面升级 §4.2。设计说明见 app/db/models_read.py ——
核心是**记时间戳而不是布尔标志**：未读 = 该流产物 updated_at > seen_at，
这样内容重新生成后自动重新变红，不需要任何写回逻辑。

表结构由 Base.metadata.create_all 也能建出来（main.py 里 import 即触发），
这里显式迁移是为了让 prod 上线时 schema 变更有据可查、可回滚。
"""
from alembic import op
import sqlalchemy as sa

revision = "20260919_draft_read"
down_revision = "20260917_user_pref_model"
branch_labels = None
depends_on = None

_TABLE = "draft_read_state"


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    # 幂等：create_all 可能已经建过表（dev 环境常见），跳过而不是报错
    if _TABLE in insp.get_table_names():
        return

    op.create_table(
        _TABLE,
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer,
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("draft_id", sa.Integer,
                  sa.ForeignKey("script_drafts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("stream", sa.String(32), nullable=False),
        sa.Column("seen_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "draft_id", "stream", name="uq_draft_read_state"),
    )
    op.create_index("ix_draft_read_state_user_id", _TABLE, ["user_id"])
    op.create_index("ix_draft_read_state_draft_id", _TABLE, ["draft_id"])
    op.create_index("ix_draft_read_state_user_draft", _TABLE, ["user_id", "draft_id"])


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if _TABLE not in insp.get_table_names():
        return
    op.drop_table(_TABLE)
