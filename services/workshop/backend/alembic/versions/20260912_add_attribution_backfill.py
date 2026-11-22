"""用量归属补全: attribution_source 列 + 算力时间戳 + runninghub_billing 表

Revision ID: 20260912_attribution
Revises: 20260909_model_select
Create Date: 2026-09-12

2026-09-07~09-11 的消耗报告暴露出两类"统计不明", 本迁移补齐其库侧结构:

## A 类 —— 身份丢失(记了用量, 但 user_id 为空)

火山视频理解 1,037 次调用 / 28,125,467 tokens 全部 user_id 与 draft_id 为 NULL;
LLM 侧 14,597 行窗口数据里 job_id 全空、stage 一律 'other'。

根因是代码而非库(见 volc/billing.record_usage 的上下文兜底、
各后台入口的 set_usage_context 播种)。库侧只需要能**观测**:
新增 ``attribution_source`` 记录"这次归属是谁盖的章"(auth / explicit /
feishu_row / frontcut …), 排查时一句 GROUP BY 就能定位到链路,
不必再靠行为指纹反推。历史行留空串, 表示"迁移之前产生的, 归属未知"。

## B 类 —— 用量没记(身份对, 但数量缺失)

四条 RunningHub 链路(音频工坊 / 小说配音 / 前剪辑配音 / 前剪辑高清)
此前**完全没有计费代码**, 消耗凭空消失。补齐时的关键口径问题是**时长**:

已有实现用 ``now - created_at`` 反推运行时长。图片场景够用(提交即开跑),
但音频/视频任务会**排队** —— 排队时间不是算力消耗, 用 created_at 反推
会让时长虚高, 且跨天不可比(深夜排队 6 小时会把当天算力撑爆)。

所以给三张作业表加 ``started_at``(真正提交远端任务那一刻) /
``finished_at``(轮询到终态那一刻, 失败也写), 时长 = 两者之差。

历史行两列均空, 表示"该行产生于口径 v2 之前", 统计时应与 v2 行分开看 ——
把它们按 created_at 折算回去等于把旧的错误口径重新引入。

## 为什么 runninghub_billing 是新表而不是复用 image_billing

``image_billing.job_id`` 是 ``unique=True`` 且外键指向 ``image_jobs.id``。
音频作业(audio_jobs / novel_video_audio_chunks)、前剪辑作业的 id
根本不在这张表里, 塞进去要么撞唯一约束、要么破坏外键语义。

新表用 ``(biz_type, job_id)`` 应用层唯一做幂等, **不设外键** ——
一张表要覆盖多种业务的多张作业表。``biz_key`` 存散列前的原始业务标识,
便于人工核对; 无单一作业行的链路(前剪辑逐段 TTS)把业务串 blake2b 成
63 位正整数当 job_id(见 billing/service.stable_biz_key), 保证重放幂等。

## 本迁移是幂等的

每处改动都先查 information_schema 再动手(见 _add_column / _table_exists)。
docker compose 重建 + 启动脚本可能重复跑 upgrade, 必须能重入。
全部用 op.get_bind() + inspector, 不用 conn.execute(...).scalar() ——
后者在 ``alembic upgrade --sql`` 离线模式下会直接报错(拿不到结果)。
"""
from alembic import op
import sqlalchemy as sa

revision = "20260912_attribution"
down_revision = "20260909_model_select"
branch_labels = None
depends_on = None


#: 加 attribution_source 的用量表 —— 记录归属来源, 用于排查归属缺口
_ATTR_TABLES = (
    "llm_usage_logs",
    "volc_usage_records",
)

#: 加 started_at / finished_at 的作业表 —— 算力时长的唯一正确口径
_TIME_TABLES = (
    "audio_jobs",
    "image_jobs",
    "novel_video_audio_chunks",
)


def _table_exists(insp, name: str) -> bool:
    return name in insp.get_table_names()


def _has_col(insp, table: str, col: str) -> bool:
    return any(c["name"] == col for c in insp.get_columns(table))


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = set(insp.get_table_names())

    # 1) 归属来源标记(留空串 = 迁移前的历史行, 归属未知)
    for t in _ATTR_TABLES:
        if t not in tables or _has_col(insp, t, "attribution_source"):
            continue
        op.add_column(
            t,
            sa.Column("attribution_source", sa.String(40),
                      nullable=False, server_default=""),
        )
        op.create_index(f"ix_{t}_attr_src", t, ["attribution_source"])

    # 2) 算力计时口径 v2(历史行两列空 = 口径 v2 之前, 勿按 created_at 回填)
    for t in _TIME_TABLES:
        if t not in tables:
            continue
        if not _has_col(insp, t, "started_at"):
            op.add_column(t, sa.Column("started_at", sa.DateTime, nullable=True))
        if not _has_col(insp, t, "finished_at"):
            op.add_column(t, sa.Column("finished_at", sa.DateTime, nullable=True))

    # 3) 通用 RunningHub 用量表
    if "runninghub_billing" not in tables:
        op.create_table(
            "runninghub_billing",
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column("biz_type", sa.String(32), nullable=False),
            # 有单一作业行时存作业主键; 无作业行(逐段 TTS)存 stable_biz_key 的散列值
            sa.Column("job_id", sa.Integer, nullable=False),
            # 散列前的原始业务标识, 便于人工核对; 直接用作业主键时留空
            sa.Column("biz_key", sa.Text, server_default=""),
            sa.Column("user_id", sa.Integer, nullable=True),
            sa.Column("attribution_source", sa.String(40), server_default=""),
            sa.Column("rh_task_id", sa.String(128), server_default=""),
            sa.Column("started_at", sa.DateTime, nullable=True),
            sa.Column("finished_at", sa.DateTime, nullable=True),
            sa.Column("duration_sec", sa.Float, server_default="0"),
            sa.Column("unit", sa.String(16), server_default="小时"),
            sa.Column("quantity", sa.Float, server_default="0"),
            sa.Column("unit_price", sa.Float, server_default="0"),
            sa.Column("amount", sa.Float, server_default="0"),
            sa.Column("status", sa.String(20), server_default="succeeded"),
            sa.Column("detail", sa.Text, server_default=""),
            sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
            sa.UniqueConstraint("biz_type", "job_id", name="uq_rh_billing_biz_job"),
        )
        op.create_index("ix_rh_billing_user", "runninghub_billing", ["user_id"])
        op.create_index("ix_rh_billing_biz_type", "runninghub_billing", ["biz_type"])
        op.create_index("ix_rh_billing_created", "runninghub_billing", ["created_at"])


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if "runninghub_billing" in insp.get_table_names():
        op.drop_table("runninghub_billing")
    # 列**不**收回:
    # - attribution_source 是排查手段, 收回等于把已获得的排查能力丢掉;
    # - started_at/finished_at 一旦有新口径行写入, 收回会让这些行失去时长依据,
    #   统计时又被迫退回 created_at 反推的错误口径。留着不占多少空间。
