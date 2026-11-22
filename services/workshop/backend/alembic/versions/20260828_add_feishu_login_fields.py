"""add feishu binding fields to users

Revision ID: 20260828_feishu_login
Revises: 20260814_spawn_two_stage
Create Date: 2026-08-28

飞书扫码登录（阶段一：双通道并存）所需的 users 表结构变更。

## 为什么这个迁移是补写的

这四个列 + password_hash 放宽，最初是**手工**加到 dev 库上的，仓库里没有对应迁移。
后果在 2026-08-28 上线 prod 时暴露：prod 库完全没有这些列，而新代码在
`auth/routes.py:61`(/me) 与 `:134`(/login) 都会读 `feishu_union_id` ——
那是**普通密码登录**的必经路径，只同步代码不改库会让全部存量用户登录失败。

## 幂等

用 IF NOT EXISTS / 先查后改：dev 库已有这些列（手工加的），跑这个迁移不能报错，
否则 dev 与 prod 就只能各走各的路，漂移会一直留着。

## password_hash 放宽为可空

飞书自动建号的用户没有密码（`password_hash=NULL`，见 routes.py:434），
所以必须 DROP NOT NULL。这个方向是**放宽**约束，对存量数据零影响：
已有行都有密码，不会因此变脏。

回滚时**不**收回 NOT NULL —— 若届时已有飞书建的无密码用户，
加回 NOT NULL 会直接失败；且真要回滚也应先决定那些用户怎么办。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20260828_feishu_login"
down_revision = "20260814_spawn_two_stage"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # 四个绑定字段。用 IF NOT EXISTS：dev 库已手工加过，必须能重复跑。
    # union_id 作绑定键：同一开发者下跨应用一致，不同企业的用户天然区分。
    conn.execute(sa.text(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS feishu_union_id VARCHAR(64)"))
    conn.execute(sa.text(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS feishu_open_id VARCHAR(64)"))
    conn.execute(sa.text(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS feishu_name VARCHAR(64)"))
    conn.execute(sa.text(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS feishu_bound_at TIMESTAMP"))

    # 唯一索引带 WHERE NOT NULL：未绑定的用户该列为 NULL，
    # 普通唯一约束在 PG 下虽允许多个 NULL，但显式写出意图更清楚，
    # 也与 dev 库现状（ix_users_feishu_union_id ... WHERE feishu_union_id IS NOT NULL）一致。
    conn.execute(sa.text(
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_feishu_union_id "
        "ON users (feishu_union_id) WHERE feishu_union_id IS NOT NULL"))

    # 飞书建的号没有密码 → 放宽 NOT NULL。
    # 直接执行、不先 SELECT 判断：DROP NOT NULL 在"已经可空"时本身就是无操作，
    # 重复执行安全。而先查后改会用到 conn.execute(...).scalar()，
    # 那在 `alembic upgrade --sql`（离线出 SQL 模式）下拿不到结果直接抛异常 ——
    # 离线预览是上线前核对 DDL 的手段，不该被自己的迁移脚本堵死。
    conn.execute(sa.text(
        "ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL"))


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("DROP INDEX IF EXISTS ix_users_feishu_union_id"))
    for col in ("feishu_bound_at", "feishu_name", "feishu_open_id", "feishu_union_id"):
        conn.execute(sa.text(f"ALTER TABLE users DROP COLUMN IF EXISTS {col}"))
    # 刻意不恢复 password_hash 的 NOT NULL：见模块文档字符串。
