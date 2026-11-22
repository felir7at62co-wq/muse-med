"""对话工坊 v3 体检/定点修复: scope 精修范围 + 体检报告落库

Revision ID: 20260914_check_scope
Revises: 20260913_rewrite_guidance
Create Date: 2026-09-14

本次新增三样东西, 对应「对话工坊 v3」的两件事:

1. ``rewrite_jobs.scope_json`` —— 精修范围。
   用户能在对话工坊里圈"只精修第 10-20 集"。范围必须**落库**而不是只塞进
   payload: 精修是覆写操作且会被队列重放, 重放时 payload 若读不到范围,
   第二次就会悄悄把整本重写一遍 —— 用户圈的范围被无声放大, 这是不可接受的。
   合同 ``{"start_ep": int|null, "end_ep": int|null}``, null 表示该侧不限。
   存 JSONB 而非两列 int, 是为了以后加 "只要剧本不要正文" 这类范围维度时不必再迁移。

2. ``agent_messages.report_json`` —— 消息上挂的体检报告。
   体检结果(问题清单 + 每条的 id/等级/集号/修改建议)要让前端渲染成卡片,
   并且**点"让 AI 改这个"时只回传 issue_id**。所以报告必须留服务端:
   前端传来的只有 id, 内容以库里的为准, 否则前端(或被篡改的前端)可以凭空
   构造一条问题让引擎去"修"。这一列就是那份可信内容。

3. 新表 ``check_reports`` —— 体检快照。
   每跑一次体检存一行, ``issue_index`` 是 ``{issue_id: {level,code,episode,
   message,fix_hint,kind}}`` 的扁平索引, 专供定点修复按 id 取回。
   为什么不复用 agent_messages.report_json: 体检可以脱离某条消息发生
   (自动体检、定时体检、从报告卡上"重新体检"), 而修复要按 id 找到那份报告;
   表里带 ``ix_check_reports_draft (draft_id, id DESC)`` 正是为"取该草稿最新一份"。

幂等: 先 inspect 再动手, 可重复 upgrade(compose 重建/启动脚本可能重复跑)。
downgrade 是**空操作**: 三样都是"改了就没法还原"的留底(范围、报告、issue id),
收回列等于让已发生的覆写失去回溯依据, 而列本身的存储成本可以忽略。
用 op.get_bind() + sa.inspect, 不用 conn.execute(...).scalar() —— 后者在
``alembic upgrade --sql`` 离线模式下会直接报错。
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "20260914_check_scope"
down_revision = "20260913_rewrite_guidance"
branch_labels = None
depends_on = None

_TABLE = "check_reports"


def _has_col(insp, table: str, col: str) -> bool:
    """表不存在时返回 True(= 不需要加列), 与 20260913 同一约定。"""
    if table not in insp.get_table_names():
        return True
    return any(c["name"] == col for c in insp.get_columns(table))


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    tables = insp.get_table_names()

    # ---- 1. rewrite_jobs.scope_json ----
    if not _has_col(insp, "rewrite_jobs", "scope_json"):
        op.add_column("rewrite_jobs", sa.Column("scope_json", JSONB, nullable=True))

    # ---- 2. agent_messages.report_json ----
    if not _has_col(insp, "agent_messages", "report_json"):
        op.add_column("agent_messages", sa.Column("report_json", JSONB, nullable=True))

    # ---- 3. check_reports ----
    if _TABLE not in tables:
        op.create_table(
            _TABLE,
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column("draft_id", sa.Integer, nullable=False),
            # 谁跑的体检。用户维度便于"我的报告"列表; 不加 FK 约束以兼容系统体检(user_id=0)
            sa.Column("user_id", sa.Integer, nullable=False, server_default="0"),
            # 本次体检覆盖哪几类: ["structure","style","consistency","script"]
            sa.Column("kinds", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
            # 本次体检的范围 {"start_ep":int|null,"end_ep":int|null}; null = 整本
            sa.Column("scope", JSONB, nullable=True),
            # 完整报告(前端卡片直接渲染这个)
            sa.Column("report", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
            # {issue_id: {level,code,episode,message,fix_hint,kind}} —— 定点修复按 id 取回
            sa.Column("issue_index", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
            sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        )
        # 取"该草稿最新一份报告"是最高频查询(修复前要按 id 找报告)
        op.create_index("ix_check_reports_draft", _TABLE, ["draft_id", "id"])


def downgrade() -> None:
    # 三样都是覆写操作的留底(范围/报告/issue id), 收回即永久失去回溯依据;
    # 已覆写的剧本不可能重放, 而列与表的存储成本可忽略。故不收回。
    pass
