"""model_channel_health + 放宽各作业表的 model 列宽

Revision ID: 20260909_model_select
Revises: 20260828_feishu_login
Create Date: 2026-09-09

用户可选具体型号(而非只选厂商)所需的两处库变更。

## 1) 新表 model_channel_health

"稳"标的事实来源: 逐 (provider, model, channel) 实测后落这张表, 前端据此显示
某个模型是不是三条渠道都通。**必须是实测现算**而不是代码里写死的清单 ——
2026-09-09 当天 api4me 的 gemini 分组就同时出现了三种故障("无可用渠道"/
"上游负载饱和"/"上游账号被停"), 写死的清单第二天就是错的, 而错的方向最糟:
用户看着"稳"标去选了一个实际只剩一条渠道的模型。

按三元组唯一: 这张表存"当前状态"不存历史流水, 每轮探测 upsert 覆盖。

## 2) model 列 VARCHAR(32) → VARCHAR(64)

型号选择通过把型号编进原有的 model/provider 字符串实现
(``"gemini:gemini-3.8-flash"``, 见 models/catalog.py 里为什么这么做)。
最长的合法值 ``gemini:gemini-3.1-flash-lite-preview`` 是 36 字符,
而这四张作业表的 model 列都是 VARCHAR(32) —— **不放宽就会在 insert 时报错**,
用户一选长名字的型号, 启动作业直接 500。

放宽列宽对存量数据零影响(现有值都是 "gemini"/"gpt5" 这种短串)。
降级里刻意**不**收回 32: 届时若已存在长值, 收窄会直接截断/报错。
"""
from alembic import op
import sqlalchemy as sa

revision = "20260909_model_select"
down_revision = "20260828_feishu_login"
branch_labels = None
depends_on = None

#: (表名, 列名) —— 存"用户选的模型"的作业表
_MODEL_COLS = (
    ("rewrite_jobs", "model"),
    ("spawn_jobs", "model"),
    ("chapter_adapt_jobs", "model"),
    ("deai_jobs", "model"),
)


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)

    if "model_channel_health" not in insp.get_table_names():
        op.create_table(
            "model_channel_health",
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column("provider", sa.String(30), nullable=False),
            sa.Column("model", sa.String(100), nullable=False),
            sa.Column("channel", sa.String(30), nullable=False),
            sa.Column("ok", sa.Boolean, server_default=sa.text("false")),
            sa.Column("stream_ok", sa.Boolean),
            sa.Column("http_status", sa.Integer),
            sa.Column("latency_ms", sa.Integer),
            sa.Column("echo_model", sa.String(100), server_default=""),
            sa.Column("echo_raw", sa.String(100), server_default=""),
            sa.Column("substituted", sa.Boolean, server_default=sa.text("false")),
            sa.Column("error", sa.Text),
            sa.Column("checked_at", sa.DateTime, nullable=False,
                      server_default=sa.func.now()),
            sa.UniqueConstraint("provider", "model", "channel", name="uq_model_channel"),
        )
        op.create_index("ix_mch_provider", "model_channel_health", ["provider"])
        op.create_index("ix_mch_model", "model_channel_health", ["model"])
        op.create_index("ix_mch_checked_at", "model_channel_health", ["checked_at"])

    # 幂等放宽列宽: 表/列不存在就跳过(各环境启用的模块不完全一致)
    existing = set(insp.get_table_names())
    for table, col in _MODEL_COLS:
        if table not in existing:
            continue
        if not any(c["name"] == col for c in insp.get_columns(table)):
            continue
        op.alter_column(table, col, type_=sa.String(64), existing_nullable=True)


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if "model_channel_health" in insp.get_table_names():
        op.drop_table("model_channel_health")
    # 列宽**不**收回 32: 若已有 "gemini:gemini-3.1-flash-lite-preview" 这类长值,
    # 收窄会截断数据或直接失败。放着更宽的列不会有任何副作用。
