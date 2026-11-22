"""外部 Agent 用的 API Key：api_keys

只建新表，不碰存量数据。表可能已由 create_all 建于 dev，所以先判存在。

Revision ID: 20261104_api_keys
Revises: 20261101_desktop_reminders
"""
from alembic import op
import sqlalchemy as sa

revision = "20261104_api_keys"
down_revision = "20261101_desktop_reminders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("api_keys"):
        return
    op.create_table(
        "api_keys",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, nullable=False, index=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("prefix", sa.String(16), nullable=False),
        sa.Column("key_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("last_used_at", sa.DateTime),
        sa.Column("revoked_at", sa.DateTime),
    )


def downgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("api_keys"):
        op.drop_table("api_keys")
