"""桌面端「任务做完提醒我」：desktop_reminders

只建新表，不碰存量数据。表可能已由 create_all 建于 dev，所以先判存在。

Revision ID: 20261101_desktop_reminders
Revises: 20261028_agent_images
"""
from alembic import op
import sqlalchemy as sa

revision = "20261101_desktop_reminders"
down_revision = "20261028_agent_images"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("desktop_reminders"):
        return
    op.create_table(
        "desktop_reminders",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, nullable=False, index=True),
        sa.Column("job_id", sa.Integer, nullable=False),
        sa.Column("job_kind", sa.String(24), nullable=False),
        sa.Column("text", sa.String(500), nullable=False),
        sa.Column("status", sa.String(12), nullable=False, server_default="pending", index=True),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("error", sa.Text),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("sent_at", sa.DateTime),
    )


def downgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("desktop_reminders"):
        op.drop_table("desktop_reminders")
