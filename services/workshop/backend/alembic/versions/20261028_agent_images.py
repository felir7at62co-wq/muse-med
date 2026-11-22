"""对话工坊图片附件：agent_images

用户可以把图片（截图/参考图）粘贴或拖进对话工坊发给 AI。图片文件落在
/app/uploads/chat-images/，库里只存元数据与"挂在哪条消息上"。
详见 app/agent/images.py。

⚠️ 表可能已由 create_all 建于 dev（见 db/models_phase5.AgentImage）。
这里用存在性判断，两种入口都安全。只建新表，不碰任何存量数据。

Revision ID: 20261028_agent_images
Revises: 20261026_announce_push
"""
from alembic import op
import sqlalchemy as sa

revision = "20261028_agent_images"
down_revision = "20261026_announce_push"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if sa.inspect(bind).has_table("agent_images"):
        return
    op.create_table(
        "agent_images",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, nullable=False, index=True),
        sa.Column("conversation_id", sa.Integer,
                  sa.ForeignKey("agent_conversations.id", ondelete="CASCADE"), index=True),
        sa.Column("message_id", sa.Integer,
                  sa.ForeignKey("agent_messages.id", ondelete="SET NULL"), index=True),
        sa.Column("filename", sa.String(256), server_default=""),
        sa.Column("stored_name", sa.String(128), nullable=False),
        sa.Column("mime", sa.String(64), server_default="image/jpeg"),
        sa.Column("byte_size", sa.Integer, server_default="0"),
        sa.Column("width", sa.Integer, server_default="0"),
        sa.Column("height", sa.Integer, server_default="0"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )


def downgrade() -> None:
    bind = op.get_bind()
    if sa.inspect(bind).has_table("agent_images"):
        op.drop_table("agent_images")
