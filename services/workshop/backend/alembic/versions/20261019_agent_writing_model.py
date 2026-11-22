"""agent_runs 增加 writing_model：这一轮 Agent 派发的写作作业用哪个模型。

Agent 自己"想"用的模型（model）和它派出去"写"稿子用的模型（writing_model）是两件事：
前者决定规划与工具调用质量，后者决定大纲/正文/剧本的文风与成本。
用户可以在对话栏选一个便宜模型来写稿，而 Agent 用一个稳的模型来调度。

Revision ID: 20261019_agent_writing
Revises: 20261019_llm_cached
"""
from alembic import op
import sqlalchemy as sa

revision = "20261019_agent_writing"
down_revision = "20261019_llm_cached"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("agent_runs", sa.Column("writing_model", sa.String(80)))


def downgrade() -> None:
    op.drop_column("agent_runs", "writing_model")
