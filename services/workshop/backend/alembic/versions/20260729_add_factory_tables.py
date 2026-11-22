"""Add factory tables

Revision ID: 20260729_factory_tables
Revises: 20260729_spawn_tokens
Create Date: 2026-07-29 12:16:00

内容裂变工厂的核心数据表：
- factory_jobs: 任务主表
- factory_products: 产物表
- factory_stats: 日度统计表
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

# revision identifiers, used by Alembic.
revision = '20260729_factory_tables'
down_revision = '20260729_spawn_tokens'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """创建 factory 相关表"""
    
    # 创建 factory_jobs 表
    op.create_table(
        'factory_jobs',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('job_type', sa.String(50), nullable=False),  # create_spawn/import_spawn/batch_video
        sa.Column('status', sa.String(50), nullable=False, server_default='pending'),  # pending/running/succeeded/failed/partial_failed
        sa.Column('config', JSONB, nullable=False, server_default='{}'),
        sa.Column('progress', JSONB, nullable=False, server_default='{}'),
        sa.Column('result', JSONB, nullable=False, server_default='{}'),
        sa.Column('total_tokens', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('prompt_tokens', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('completion_tokens', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('cached_tokens', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('error_message', sa.Text()),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
        sa.Column('finished_at', sa.DateTime())
    )
    
    # 创建索引
    op.create_index('idx_factory_jobs_user_id', 'factory_jobs', ['user_id'])
    op.create_index('idx_factory_jobs_status', 'factory_jobs', ['status'])
    op.create_index('idx_factory_jobs_job_type', 'factory_jobs', ['job_type'])
    op.create_index('idx_factory_jobs_created_at', 'factory_jobs', ['created_at'])
    
    # 创建 factory_products 表
    op.create_table(
        'factory_products',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('job_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('product_type', sa.String(50), nullable=False),  # outline/script/novel/tweet/video
        sa.Column('title', sa.String(500)),
        sa.Column('content', sa.Text()),
        sa.Column('meta_data', JSONB, nullable=False, server_default='{}'),  # 重命名以避免与 SQLAlchemy 保留字冲突
        sa.Column('quality_score', sa.Float()),
        sa.Column('parent_id', sa.Integer()),  # 溯源链：指向父产物
        sa.Column('draft_id', sa.Integer()),  # 关联的草稿ID（如果已导入到草稿系统）
        sa.Column('status', sa.String(50), nullable=False, server_default='completed'),  # pending/running/completed/failed
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now())
    )
    
    op.create_index('idx_factory_products_job_id', 'factory_products', ['job_id'])
    op.create_index('idx_factory_products_user_id', 'factory_products', ['user_id'])
    op.create_index('idx_factory_products_product_type', 'factory_products', ['product_type'])
    op.create_index('idx_factory_products_parent_id', 'factory_products', ['parent_id'])
    op.create_index('idx_factory_products_draft_id', 'factory_products', ['draft_id'])
    
    # 创建 factory_stats 表（每日统计）
    op.create_table(
        'factory_stats',
        sa.Column('id', sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column('date', sa.Date(), nullable=False, unique=True),
        sa.Column('total_jobs', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('success_jobs', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('failed_jobs', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('total_tokens', sa.BigInteger(), nullable=False, server_default='0'),
        sa.Column('job_type_dist', JSONB, nullable=False, server_default='{}'),  # {"create_spawn": 10, "import_spawn": 5, "batch_video": 3}
        sa.Column('avg_duration', sa.Float()),  # 平均耗时（秒）
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now())
    )
    
    op.create_index('idx_factory_stats_date', 'factory_stats', ['date'])


def downgrade() -> None:
    """删除 factory 相关表"""
    op.drop_index('idx_factory_stats_date', table_name='factory_stats')
    op.drop_table('factory_stats')
    
    op.drop_index('idx_factory_products_draft_id', table_name='factory_products')
    op.drop_index('idx_factory_products_parent_id', table_name='factory_products')
    op.drop_index('idx_factory_products_product_type', table_name='factory_products')
    op.drop_index('idx_factory_products_user_id', table_name='factory_products')
    op.drop_index('idx_factory_products_job_id', table_name='factory_products')
    op.drop_table('factory_products')
    
    op.drop_index('idx_factory_jobs_created_at', table_name='factory_jobs')
    op.drop_index('idx_factory_jobs_job_type', table_name='factory_jobs')
    op.drop_index('idx_factory_jobs_status', table_name='factory_jobs')
    op.drop_index('idx_factory_jobs_user_id', table_name='factory_jobs')
    op.drop_table('factory_jobs')
