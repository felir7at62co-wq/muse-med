"""add token usage fields to spawn_jobs

Revision ID: 20260729_spawn_tokens
Revises: 20260729_feishu_tracking
Create Date: 2026-07-29 11:11:00.000000

添加 Token 使用量追踪字段到 spawn_jobs 表，用于精确计费。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '20260729_spawn_tokens'
down_revision = '20260729_feishu_tracking'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """添加 Token 使用量字段到 spawn_jobs"""
    op.add_column('spawn_jobs', sa.Column('total_tokens', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('spawn_jobs', sa.Column('prompt_tokens', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('spawn_jobs', sa.Column('completion_tokens', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('spawn_jobs', sa.Column('cached_tokens', sa.Integer(), nullable=False, server_default='0'))


def downgrade() -> None:
    """回滚：删除 Token 字段"""
    op.drop_column('spawn_jobs', 'cached_tokens')
    op.drop_column('spawn_jobs', 'completion_tokens')
    op.drop_column('spawn_jobs', 'prompt_tokens')
    op.drop_column('spawn_jobs', 'total_tokens')
