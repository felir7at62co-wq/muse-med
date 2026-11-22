"""script_chapters.auto_checks —— 生成后自动校验的结论

Revision ID: 20260919_auto_checks
Revises: 20260919_draft_read
Create Date: 2026-09-19

PLAN §3.3 / B8。背景：

  用户问"为什么要跑精修？为什么不能生成时就确认结果是对的？"
  根因不是没有校验，而是**校验要用户手动点**。

  核实（2026-09-19）：
    大纲层 **已经有**自动校验（outline_gen.py 生成完跑到 lint + drama_gate）
    章节层 **完全没有** —— 生成完什么都不跑

本迁移加的列，就是给章节层存自动校验结论用的。

为什么是 JSONB 而不是独立表：形状与 lint_report 的 issue 对齐
（[{level, episode, code, message, auto}]），前端复用同一套标注组件；
而且它是**列表页每行都要读**的信息，放同一行比 JOIN 省事。

默认 NULL = 未跑或没问题。可空，对存量数据零影响。
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260919_auto_checks"
down_revision = "20260919_draft_read"
branch_labels = None
depends_on = None

_TABLE = "script_chapters"
_COL = "auto_checks"


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if _TABLE not in insp.get_table_names():
        return
    # 幂等：create_all 可能已经加过（dev 常见）
    if any(c["name"] == _COL for c in insp.get_columns(_TABLE)):
        return
    op.add_column(_TABLE, sa.Column(_COL, postgresql.JSONB, nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if _TABLE not in insp.get_table_names():
        return
    if not any(c["name"] == _COL for c in insp.get_columns(_TABLE)):
        return
    op.drop_column(_TABLE, _COL)
