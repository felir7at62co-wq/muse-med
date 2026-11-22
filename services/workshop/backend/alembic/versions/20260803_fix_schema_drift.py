"""fix schema drift: factory_products.metadata rename + user_profiles.agent_permissions

Revision ID: 20260803_schema_drift_fix
Revises: 20260802_corpus_tags
Create Date: 2026-08-03

两处历史手工改动的补账迁移(幂等, 用条件 SQL, dev 上已手工改过则为 no-op):
1. factory_products.meta_data -> metadata 列改名(模型 Column("metadata") 期望 DB 列名为 metadata;
   dev 库已手工改名, prod 仍是旧迁移建出的 meta_data, 该表当前 0 行, 改名零风险)
2. user_profiles.agent_permissions JSONB default '{}' (dev 手工加过, prod 缺失但代码已引用)
"""
from alembic import op

# revision identifiers, used by Alembic.
revision = "20260803_schema_drift_fix"
down_revision = "20260802_corpus_tags"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. factory_products.meta_data -> metadata (仅当旧列名存在且新列名不存在)
    op.execute("""
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='factory_products' AND column_name='meta_data')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='factory_products' AND column_name='metadata')
        THEN
            ALTER TABLE factory_products RENAME COLUMN meta_data TO metadata;
        END IF;
    END $$;
    """)
    # 2. user_profiles.agent_permissions (仅当缺失)
    op.execute("""
    ALTER TABLE user_profiles
        ADD COLUMN IF NOT EXISTS agent_permissions JSONB DEFAULT '{}'::jsonb;
    """)


def downgrade() -> None:
    # 补账迁移不提供回滚(改名回去/删列都可能破坏线上数据), 留空。
    pass