"""script_episode_history.job_id —— 让"这次作业改了哪几集"可被回答

Revision ID: 20261011_history_job_id
Revises: 20261010_agent_docs
Create Date: 2026-10-11

## 背景（用户甲在 dev 报的「看记录」说"没有可比对的改动记录"）

`GET /v1/agent/jobs/{job_id}/changes`（`agent/routes.py:_job_changes`）从诞生起
就**不按作业号区分**：它写的是

    WHERE draft_id = ? AND created_by = 'ai_rewrite'
      AND stage IN ('chapter','storyboard')
    ORDER BY id DESC LIMIT 200

三处都错，而且是叠加的：

  1. 定点修复写的是 ``created_by='ai_fix'``（``check/fixer.py`` 两处），
     精修才写 ``'ai_rewrite'`` —— 于是「修硬伤」点开永远说没有记录；
  2. ``structure`` 类问题全走**大纲**路径（``stage='outline'``），不在白名单里 ——
     修大纲的作业一条也查不到；
  3. 最要命的：**没有任何作业维度**。同一份草稿上只要留下过 ``ai_rewrite``，
     点**任意**作业的「看改动」都会看到同一份对照。
     dev 实测 job #107（只改了 1 集大纲）与 job #110（整本精修 61 集剧本）
     返回内容的 md5 完全相同。

第 3 点用"时间窗"绕不过去：``_save_episode_history`` 是**每条自开事务**，
作业失败重试时前一次已提交的行会落在新窗口之外变成孤儿；而
``agent/operations.py`` 的 ``apply_script_fix`` / ``apply_outline_fix`` 路径
**根本不在 agent_jobs 表里**，连窗口都没有。

## 这一列解决什么

给每条快照记下"写入时正在跑哪个作业"，读侧就能 ``WHERE job_id = ?`` 精确取回。
写入侧不必改 —— 值由 ``agent/jobs.py:run_job`` 用 contextvar 注入
（``factory/usage.py`` 那套的同一写法，worker 是 ``await run_job(job)`` 而非
``create_task``，同一任务内可见），两条底层写入口
（``snapshot_in`` / ``_save_episode_history``）自动读取，
覆盖全部 33 个调用点。

## 可空，对存量数据零影响

历史行 ``job_id`` 为 NULL。读侧对 NULL 回落到"按作业起止时间 + created_by"
的窗口查询（已实测可准确圈定 dev 上的 #107 / #108 / #110），
所以老作业点「看改动」仍然拿得到对照，只是新作业才走精确路径。
"""
from alembic import op
import sqlalchemy as sa

revision = "20261011_history_job_id"
down_revision = "20261010_agent_docs"
branch_labels = None
depends_on = None

_TABLE = "script_episode_history"
_COL = "job_id"
_INDEX = "ix_script_episode_history_job_id"


def upgrade() -> None:
    # 幂等 + 离线安全：用 sa.inspect 而不是 conn.execute(...).scalar()
    # （后者在 `alembic upgrade --sql` 离线模式下报错）。同 20260917 那支的写法。
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if _TABLE not in insp.get_table_names():
        return
    if any(c["name"] == _COL for c in insp.get_columns(_TABLE)):
        return
    op.add_column(_TABLE, sa.Column(_COL, sa.Integer(), nullable=True))
    op.create_index(_INDEX, _TABLE, [_COL])


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if _TABLE not in insp.get_table_names():
        return
    if not any(c["name"] == _COL for c in insp.get_columns(_TABLE)):
        return
    op.drop_index(_INDEX, table_name=_TABLE)
    op.drop_column(_TABLE, _COL)
