"""spawn_jobs 增加两段式裂变字段 (stage / preview_episodes)

Revision ID: 20260814_spawn_two_stage
Revises: 20260803_schema_drift_fix
Create Date: 2026-08-14 00:00:00.000000

DNA 裂变工厂改为两段式:
  stage=preview   先出「故事圣经 + 前 N 集」, 停下来等人工确认/编辑
  stage=expanding 确认后展开全集
  stage=legacy    旧的一步到位模式(存量作业默认值, 保持行为不变)

preview_episodes 记录该作业的预览集数(默认 3)。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20260814_spawn_two_stage"
down_revision = "20260803_schema_drift_fix"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 存量作业一律标 legacy —— 它们是一步到位跑完的, 不能被当成"待展开"
    op.add_column(
        "spawn_jobs",
        sa.Column("stage", sa.String(length=16), nullable=False, server_default="legacy"),
    )
    op.add_column(
        "spawn_jobs",
        sa.Column("preview_episodes", sa.Integer(), nullable=False, server_default="3"),
    )


def downgrade() -> None:
    op.drop_column("spawn_jobs", "preview_episodes")
    op.drop_column("spawn_jobs", "stage")
