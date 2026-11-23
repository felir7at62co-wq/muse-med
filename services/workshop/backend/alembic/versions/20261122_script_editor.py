"""Stage Muse screenplay revisions and link source drafts to their publications.

Revision ID: 20261122_script_editor
Revises: 20261104_api_keys
"""

from alembic import op
import sqlalchemy as sa

revision = "20261122_script_editor"
down_revision = "20261104_api_keys"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create the editor tables when application startup has not created them."""
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("script_editor_candidates"):
        op.create_table(
            "script_editor_candidates",
            sa.Column("draft_id", sa.Integer, sa.ForeignKey("script_drafts.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("episode", sa.Integer, primary_key=True),
            sa.Column("actor_id", sa.Integer, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("id", sa.String(36), nullable=False, unique=True),
            sa.Column("base_revision", sa.String(64), nullable=False),
            sa.Column("content", sa.Text, nullable=False),
            sa.Column("summary", sa.Text, nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        )
    if not inspector.has_table("script_editor_publications"):
        op.create_table(
            "script_editor_publications",
            sa.Column("draft_id", sa.Integer, sa.ForeignKey("script_drafts.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("entry_id", sa.Integer, nullable=False, unique=True),
        )
