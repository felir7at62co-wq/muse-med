"""add feishu_row_failures table for tracking pre-job failures

Revision ID: 20260729_feishu_tracking
Revises: 23008b1c2d4c
Create Date: 2026-07-29 10:16:00.000000

此迁移仅添加 feishu_row_failures 表，用于追踪飞书行处理状态（processing/success/failed），
特别是 job 创建之前的失败（docx 解析失败、AI 文案失败等）。不触碰任何现有表。
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '20260729_feishu_tracking'
down_revision = '23008b1c2d4c'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """添加 feishu_row_failures 表（长期优化：任务队列可追踪性）"""
    op.create_table(
        'feishu_row_failures',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('cfg_id', sa.Integer(), nullable=False),
        sa.Column('record_id', sa.Text(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('status', sa.Text(), nullable=False, server_default='pending'),
        sa.Column('reason', sa.Text(), nullable=True),
        sa.Column('job_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.PrimaryKeyConstraint('id', name=op.f('feishu_row_failures_pkey')),
        comment='飞书行处理状态追踪（pending/processing/success/failed），覆盖 job 创建前失败'
    )
    op.create_index(op.f('ix_feishu_row_failures_cfg_id'), 'feishu_row_failures', ['cfg_id'], unique=False)
    op.create_index(op.f('ix_feishu_row_failures_record_id'), 'feishu_row_failures', ['record_id'], unique=False)
    op.create_index(op.f('ix_feishu_row_failures_user_id'), 'feishu_row_failures', ['user_id'], unique=False)
    # 复合索引: 按 (cfg_id, record_id) 快速查询单行状态（幂等更新用）
    op.create_index('ix_feishu_row_failures_cfg_record', 'feishu_row_failures', ['cfg_id', 'record_id'], unique=False)


def downgrade() -> None:
    """回滚：删除 feishu_row_failures 表"""
    op.drop_index('ix_feishu_row_failures_cfg_record', table_name='feishu_row_failures')
    op.drop_index(op.f('ix_feishu_row_failures_user_id'), table_name='feishu_row_failures')
    op.drop_index(op.f('ix_feishu_row_failures_record_id'), table_name='feishu_row_failures')
    op.drop_index(op.f('ix_feishu_row_failures_cfg_id'), table_name='feishu_row_failures')
    op.drop_table('feishu_row_failures')
