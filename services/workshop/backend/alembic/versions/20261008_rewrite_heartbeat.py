"""rewrite_jobs.heartbeat_at —— 让"这个精修作业还活着吗"可被判定

Revision ID: 20261008_rewrite_heartbeat
Revises: 20261007_rewrite_evidence
Create Date: 2026-10-08

## 背景（2026-10-08 事故：草稿上的按钮集体失效）

用户报告「一键全修硬伤」按钮似乎不可用，并且「精修这批」修完硬伤反而变多。
查下去的第一层根因是**僵尸精修作业把整个草稿锁死了**：

``agent/chat_jobs.has_active_job`` 只要看到本草稿有一行 ``rewrite_jobs``
的 status ∈ {running, analyzing, rewriting}，就认定"已有任务在跑"，
于是「修硬伤」「精修这批」「生成正文/剧本」三个入口**全部被拦**，
回一句"这部剧已有任务在跑（整本精修 #31（rewriting））"。

而**没有任何机制**会把卡住的行改成终态：

  · ``jobs.requeue_expired`` 只管 ``agent_jobs`` 的租约，不管 ``rewrite_jobs``；
  · ``_handle_rewrite_script`` 的重放保护看到 ``rj.status == 'rewriting'`` 时
    **直接 return**（它假设"另一个 worker 还在跑"），把 agent_jobs 写 done，
    而那个 RewriteJob 就永远留在 rewriting。

dev 实测（草稿 653《重来》）：RewriteJob #31 建于 2026-10-08 03:34、
finished=0、再也没动过；agent_jobs #65 却是 done。
此后 ``has_active_job(653)`` 一直返回 ``"整本精修 #31（rewriting）"``——
用户看到的就是"按钮点了没反应/用不了"。

## 这一列解决什么

把"还在跑"的依据从**一个只能由正常收尾路径改写的 status 字段**，
换成**心跳新鲜度**：作业每推进一次就刷新 ``heartbeat_at``，
超过窗口没刷新即判定持有者已死，可安全回收。

``run_rewrite`` 起一个 30 秒周期的后台心跳任务覆盖整个执行期
（包括第一轮整本诊断这种单次长 LLM 调用），所以窗口取 180 秒足够宽松。

## 可空，对存量数据零影响

历史作业 ``heartbeat_at`` 为 NULL。判活逻辑对 NULL 回落到 ``created_at``
（见 ``chat_jobs._rewrite_alive_since``），所以存量行不会因为"没有心跳"
就被误判为死掉，也不会因为"有 status"就被误判为活着。
"""
from alembic import op
import sqlalchemy as sa

revision = "20261008_rewrite_heartbeat"
down_revision = "20261007_rewrite_evidence"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "rewrite_jobs",
        sa.Column("heartbeat_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "ix_rewrite_jobs_heartbeat_at", "rewrite_jobs", ["heartbeat_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_rewrite_jobs_heartbeat_at", table_name="rewrite_jobs")
    op.drop_column("rewrite_jobs", "heartbeat_at")
