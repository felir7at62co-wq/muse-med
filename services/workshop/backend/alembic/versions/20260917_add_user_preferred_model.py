"""user_profiles 增加 preferred_model —— 用户个人的默认模型偏好

Revision ID: 20260917_user_pref_model
Revises: 20260914_check_scope
Create Date: 2026-09-17

## 为什么要这一列

此前"新建草稿用哪个模型"只有一条链路: 前端 useState('gemini') → 后端
default_choice() → env 的 LLM_REWRITE_MODEL。也就是说**全平台所有人共用一个
写死的默认值**, 新用户第一次生成永远撞上它(实测 gemini-3.6-flash 吃掉了
78.9% 的 token), 而用户各自的模型偏好无处存放。

加这一列后优先级变成: 用户偏好 > 平台默认(system_settings) > env > 代码常量。

## 列宽为什么是 64

存的是**完整的 provider:model 串**(如 "gemini:gemini-3.8-flash"), 与
20260909_model_select 放宽那四张作业表 model 列的口径保持一致 —— 最长的合法值
"gemini:gemini-3.1-flash-lite-preview" 是 36 字符, 32 不够用。

## 降级

只删列, 不动其它。列里存的偏好丢失后会自动回落平台默认, 无功能性损坏。
"""
from alembic import op
import sqlalchemy as sa

revision = "20260917_user_pref_model"
down_revision = "20260914_check_scope"
branch_labels = None
depends_on = None

_TABLE = "user_profiles"
_COL = "preferred_model"


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)

    # 幂等: 表不在(极早期库)或列已存在都直接跳过, 允许重复执行
    if _TABLE not in insp.get_table_names():
        return
    if any(c["name"] == _COL for c in insp.get_columns(_TABLE)):
        return

    op.add_column(_TABLE, sa.Column(_COL, sa.String(64), nullable=True))


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)

    if _TABLE not in insp.get_table_names():
        return
    if not any(c["name"] == _COL for c in insp.get_columns(_TABLE)):
        return

    op.drop_column(_TABLE, _COL)
