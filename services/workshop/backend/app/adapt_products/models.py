"""章节改编产物 ORM: 小说(novel) / 推文(tweet)。

逐章一条, 独立于原文 chapters(不复写原文)。历史版本复用 ScriptEpisodeHistory(stage=kind)。
"""
from __future__ import annotations

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB

from ..db.models import Base


class ChapterAdaptation(Base):
    """章节改编产物: kind ∈ {novel, tweet}。逐章一条。"""

    __tablename__ = "chapter_adaptations"
    __table_args__ = (
        UniqueConstraint("draft_id", "kind", "chapter_order", name="uq_adapt_draft_kind_chapter"),
    )

    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, index=True, nullable=False)
    kind = Column(String(16), nullable=False, index=True)   # 'novel' | 'tweet'
    chapter_order = Column(Integer, nullable=False)
    content = Column(Text, default="")                       # 产物正文
    word_count = Column(Integer, default=0)
    version = Column(Integer, default=1)
    user_edited = Column(Boolean, default=False)
    meta_json = Column(JSONB, default=dict)                  # tweet 存 {protagonist} 等
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ChapterAdaptJob(Base):
    """一键逐章生成作业(参照 RewriteJob)。

    per_ep_json: {ep: {status: ok|failed|skipped, chars, reason?}}
    """

    __tablename__ = "chapter_adapt_jobs"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True)
    draft_id = Column(Integer, index=True)
    kind = Column(String(16), nullable=False)               # 'novel' | 'tweet'
    status = Column(String(20), default="running")          # running|done|partial|failed|canceled
    model = Column(String(64), default="gemini")
    protagonist = Column(String(64), default="")            # tweet 用: 第一人称主角名
    total = Column(Integer, default=0)
    finished = Column(Integer, default=0)
    per_ep_json = Column(JSONB, default=dict)
    error = Column(Text)
    created_at = Column(DateTime, server_default=func.now())
    finished_at = Column(DateTime)
