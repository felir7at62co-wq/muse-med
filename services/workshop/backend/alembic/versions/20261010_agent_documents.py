"""agent_documents / agent_document_chapters —— 对话工坊上传的长文档落盘

Revision ID: 20261010_agent_docs
Revises: 20261008_rewrite_heartbeat
Create Date: 2026-10-10

## 背景（2026-10-10 定位的"40 轮后瞎写"事故）

用户上传了一份 992KB（40 万字）小说原文到对话工坊，然后逐章"继续改第X章"。
到后面模型开始自己编 —— 因为它**早就读不到原文了**：

  · 上传内容被前端整篇拼进 user message，随对话历史进上下文，占满 10 轮窗口；
  · 约第 33~35 轮被 ``compaction.prune_old_tool_outputs`` 剪成 200 字占位符
    （"原 375,639 字符，开头为…"）；
  · 第 38 轮彻底滑出窗口，而用户以为它还在。

⚠️ **压缩一次都没触发过**：用的是 gemini-3.6-flash（阈值 921,464 token），
   实际历史峰值只有 409,250。真凶是"10 轮窗口 + 长消息剪枝"，不是压缩不足。
   所以加大压缩阈值这类改法治不了它。

## 这两张表解决什么

文档**落盘**，消息里只留一行引用，正文不再进对话历史 → 体积与剪枝问题同时消失。
每轮组装上下文时按需检索（见 ``app/agent/doc_context.py``）：
用户点名章号就给那几章全文，没点名就给目录 + 相邻若干章。

## 为什么正文只存一份

``agent_documents.full_text`` 存全文，``agent_document_chapters`` 只存
start/end 偏移量，**不重复存正文**。40 万字存两遍既浪费又必然不同步；
偏移量还能让切分规则演进后重切（规则改了就重算，不用让用户重传）。

表结构由 ``Base.metadata.create_all`` 也能建出来（main.py 里 import 即触发），
这里显式迁移是为了 prod 上线时 schema 变更有据可查、可回滚。
"""
from alembic import op
import sqlalchemy as sa

revision = "20261010_agent_docs"
down_revision = "20261008_rewrite_heartbeat"
branch_labels = None
depends_on = None

_DOCS = "agent_documents"
_CHAPTERS = "agent_document_chapters"


def upgrade() -> None:
    op.create_table(
        _DOCS,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("conversation_id", sa.Integer(),
                  sa.ForeignKey("agent_conversations.id", ondelete="CASCADE")),
        sa.Column("draft_id", sa.Integer()),
        sa.Column("filename", sa.String(256), server_default=""),
        sa.Column("char_count", sa.Integer(), server_default="0"),
        sa.Column("full_text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_agent_documents_user_id", _DOCS, ["user_id"])
    op.create_index("ix_agent_documents_conversation_id", _DOCS, ["conversation_id"])
    op.create_index("ix_agent_documents_draft_id", _DOCS, ["draft_id"])

    op.create_table(
        _CHAPTERS,
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("document_id", sa.Integer(),
                  sa.ForeignKey(f"{_DOCS}.id", ondelete="CASCADE"), nullable=False),
        sa.Column("order", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(256), server_default=""),
        sa.Column("start_offset", sa.Integer(), nullable=False),
        sa.Column("end_offset", sa.Integer(), nullable=False),
        sa.Column("char_count", sa.Integer(), server_default="0"),
    )
    op.create_index("ix_agent_document_chapters_document_id", _CHAPTERS, ["document_id"])


def downgrade() -> None:
    op.drop_index("ix_agent_document_chapters_document_id", table_name=_CHAPTERS)
    op.drop_table(_CHAPTERS)
    op.drop_index("ix_agent_documents_draft_id", table_name=_DOCS)
    op.drop_index("ix_agent_documents_conversation_id", table_name=_DOCS)
    op.drop_index("ix_agent_documents_user_id", table_name=_DOCS)
    op.drop_table(_DOCS)
