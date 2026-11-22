"""rewrite_jobs.batch_evidence —— 分批精修的原始响应留底(仅后端)

Revision ID: 20261007_rewrite_evidence
Revises: 20260919_auto_checks
Create Date: 2026-10-07

## 背景(2026-10-07 事故)

prod 草稿 2409「同事请客，刷的却是我的卡…」的一次精修, 作业记录写
``total=61 / finished=51``: **10 集一字未动**(第 3、4、5、6 与 31-36 集),
内部原因是"模型未返回该集, 保持原稿"。

恶劣之处在于**报告与实际不符**: 第一轮诊断清单**点名了**第 3 集的中秋矛盾、
第 31-36 集的残留小标题, 而这 10 集恰好就是没被改的那批 —— 用户看到
"该修的东西"与"实际改动"对不上, 问出了"是不是只有部分真的被优化了"。

查全库 ``rewrite_jobs``: 出现跳过的作业共 8 个, **几乎每次都是连续 6 集整块消失**
(job 86/73: 19-24; job 59: 2-6; job 13: 8-12; job 92: 3-6 与 31-36), 跨草稿复现。

## 为什么加这一列

当时**原始响应哪里都没存** —— ``generation_logs`` 对精修路径是空的, 服务端日志里
也没有应用层记录(只剩 uvicorn 访问日志)。于是事后只能确认"少了 10 集", 无法确认
"少的那段长什么样", 也就无法区分「输出被截断」还是「模型自己跳过了」。

这一列把每批的取证落库: 要了哪些集、返回了哪些、重试几次、每次的 finish_reason,
以及原始响应留底。有了它, 下次同类问题一次就能定因。

## 为什么不放进已有的 summary_json

``summary_json`` **已经在通过 ``_job_view`` 下发前端**, 且被前端当结果文案用。
把原始响应塞进去就自动外泄了。面向用户的接口(``rewrite/routes.py:_job_view``、
agent 的 ``_job_detail``)都是**显式列字段**, 所以新开一列不会被带出去 —— 这正是
要的效果: 后端可查、前端看不到。

## 可空, 对存量数据零影响

历史作业留 NULL, 表示"这次没有取证"(不是"没有缺集")。
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20261007_rewrite_evidence"
down_revision = "20260919_auto_checks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "rewrite_jobs",
        sa.Column("batch_evidence", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("rewrite_jobs", "batch_evidence")
