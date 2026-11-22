"""整本精修支持"用户参考意见": rewrite_jobs.guidance

Revision ID: 20260913_rewrite_guidance
Revises: 20260912_attribution
Create Date: 2026-09-13

对话工坊新增「自动精修」模式: 用户在发送框里写的那句话会作为**参考意见**随整本
精修一起下发（不再是普通对话，也不再是设置里的一个开关）。

库侧只需要一列留底 —— ``guidance``。之所以要存而不是只塞进 prompt:

1. 精修是**覆写**操作，必须能回答"这次为什么改成这样"。analysis_text 记的是模型
   自己的诊断，guidance 记的是**用户当时的要求**，两者缺一，回溯就成了猜。
2. 长任务会崩会重放，重放时从库里读 payload 恢复上下文；只在内存里传的字段
   一重放就丢，重放出来的精修结果会与用户当时看到的不是一回事。

历史行留空串 = "本次精修没带用户意见"，与"带了但为空"等价，统计/回溯时不必区分。
空串而非 NULL 是为了让 ``or ""`` 与 ``IS NULL`` 两种写法都能用，少一类踩坑。

本迁移是幂等的: 先查 information_schema 再动手。docker compose 重建 + 启动脚本
可能重复跑 upgrade，必须能重入。用 op.get_bind() + inspector，不用
conn.execute(...).scalar() —— 后者在 ``alembic upgrade --sql`` 离线模式下会报错。
"""
from alembic import op
import sqlalchemy as sa

revision = "20260913_rewrite_guidance"
down_revision = "20260912_attribution"
branch_labels = None
depends_on = None


def _has_col(insp, table: str, col: str) -> bool:
    if table not in insp.get_table_names():
        return True     # 表都没有 → 视作"不需要加"，本迁移不该建表
    return any(c["name"] == col for c in insp.get_columns(table))


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if not _has_col(insp, "rewrite_jobs", "guidance"):
        op.add_column(
            "rewrite_jobs",
            sa.Column("guidance", sa.Text, nullable=False, server_default=""),
        )


def downgrade() -> None:
    # 列不收回: guidance 是回溯依据，收回等于把"当时用户要求了什么"丢掉，
    # 而这些行已经覆写过剧本、不可能重放。留一列文本的成本可以忽略。
    pass
