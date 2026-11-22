"""公告群发：批次表 + 逐人投递表

公告此前只有网页顶部横幅（announcements 表）。横幅只能覆盖"打开了网页的人"，
用户在织影、在生成任务里、几天没开网页就完全看不到。加飞书私信之后群发不可撤回，
必须能逐人回答"发给谁了、谁没收到、为什么"，所以需要这两张表。

⚠️ 表可能已由 create_all 建于 dev（见 db/models.py 的 AnnouncementPush /
AnnouncementDelivery）。这里用存在性判断, 两种入口都安全。

Revision ID: 20261026_announce_push
Revises: 20261019_agent_writing
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "20261026_announce_push"
down_revision = "20261019_agent_writing"
branch_labels = None
depends_on = None


def _has_table(bind, name: str) -> bool:
    return sa.inspect(bind).has_table(name)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "announcement_pushes"):
        op.create_table(
            "announcement_pushes",
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column("announcement_id", sa.Integer, nullable=True, index=True),
            sa.Column("title", sa.String(128), nullable=False, server_default=""),
            sa.Column("text", sa.Text, nullable=False),
            sa.Column("scope", sa.String(16), nullable=False, server_default="all"),
            sa.Column("target_ids", JSONB, nullable=True),
            sa.Column("total", sa.Integer, server_default="0"),
            sa.Column("sent", sa.Integer, server_default="0"),
            sa.Column("failed", sa.Integer, server_default="0"),
            sa.Column("skipped", sa.Integer, server_default="0"),
            sa.Column("created_by", sa.Integer, nullable=True, index=True),
            sa.Column("created_at", sa.DateTime, server_default=sa.func.now(), index=True),
        )

    if not _has_table(bind, "announcement_deliveries"):
        op.create_table(
            "announcement_deliveries",
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column("push_id", sa.Integer, nullable=False, index=True),
            sa.Column("user_id", sa.Integer, nullable=True, index=True),
            sa.Column("user_name", sa.String(128), server_default=""),
            sa.Column("status", sa.String(16), nullable=False, index=True),
            sa.Column("reason", sa.String(300), server_default=""),
            sa.Column("message_id", sa.String(120), server_default=""),
            sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table(bind, "announcement_deliveries"):
        op.drop_table("announcement_deliveries")
    if _has_table(bind, "announcement_pushes"):
        op.drop_table("announcement_pushes")
