"""add corpus tag fields

Revision ID: 20260802_corpus_tags
Revises: 20260729_add_feishu_row_failure_table
Create Date: 2026-08-02
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20260802_corpus_tags"
# 注意: down_revision 必须是上一个迁移文件里的 revision ID(不是文件名)。
# 链条: 23008b1c2d4c -> 20260729_feishu_tracking -> 20260729_spawn_tokens
#       -> 20260729_factory_tables -> 20260802_corpus_tags(本文件)
down_revision = "20260729_factory_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    #二次打标字段 — 全部为可空/有默认值, 向后兼容历史行
    op.add_column("frontcut_corpus_items",
                  sa.Column("protagonist_gender", sa.String(16), nullable=True, server_default=""))
    op.add_column("frontcut_corpus_items",
                  sa.Column("protagonist_role", sa.String(100), nullable=True, server_default=""))
    op.add_column("frontcut_corpus_items",
                  sa.Column("theme_tags", sa.JSON(), nullable=True))
    op.add_column("frontcut_corpus_items",
                  sa.Column("hook_type", sa.String(50), nullable=True, server_default=""))
    op.add_column("frontcut_corpus_items",
                  sa.Column("scenario_summary", sa.String(300), nullable=True, server_default=""))
    op.add_column("frontcut_corpus_items",
                  sa.Column("content_rating", sa.String(20), nullable=True, server_default="safe"))
    op.add_column("frontcut_corpus_items",
                  sa.Column("auto_tagged", sa.Boolean(), nullable=True, server_default="false"))
    op.add_column("frontcut_corpus_items",
                  sa.Column("tag_version", sa.Integer(), nullable=True, server_default="0"))

    # 索引: protagonist_gender / content_rating / auto_tagged — 供筛选查询使用
    op.create_index("ix_frontcut_corpus_protagonist_gender",
                    "frontcut_corpus_items", ["protagonist_gender"])
    op.create_index("ix_frontcut_corpus_content_rating",
                    "frontcut_corpus_items", ["content_rating"])
    op.create_index("ix_frontcut_corpus_auto_tagged",
                    "frontcut_corpus_items", ["auto_tagged"])


def downgrade() -> None:
    op.drop_index("ix_frontcut_corpus_auto_tagged", table_name="frontcut_corpus_items")
    op.drop_index("ix_frontcut_corpus_content_rating", table_name="frontcut_corpus_items")
    op.drop_index("ix_frontcut_corpus_protagonist_gender", table_name="frontcut_corpus_items")
    op.drop_column("frontcut_corpus_items", "tag_version")
    op.drop_column("frontcut_corpus_items", "auto_tagged")
    op.drop_column("frontcut_corpus_items", "content_rating")
    op.drop_column("frontcut_corpus_items", "scenario_summary")
    op.drop_column("frontcut_corpus_items", "hook_type")
    op.drop_column("frontcut_corpus_items", "theme_tags")
    op.drop_column("frontcut_corpus_items", "protagonist_role")
    op.drop_column("frontcut_corpus_items", "protagonist_gender")