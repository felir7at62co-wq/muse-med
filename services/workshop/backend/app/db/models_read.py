"""未读状态 —— 两级红点的数据来源（PLAN-剧本平台全面升级 §4.2）

## 为什么需要这张表

新版要在两处显示"有新东西你还没看过"：
  1. 首页草稿卡右上角的红点数字（该草稿内未读新产物总数）
  2. 工作台侧栏每个 tab 上的未读数（不用逐个点开找哪里是新的）

现状：**没有任何"用户看过什么"的记录**。`script_drafts.updated_at` 只说明
"内容变过"，不说明"用户知不知道它变了"。

## 为什么记时间戳而不是布尔标志

两种建模方式：

  A. 布尔：`is_read = true/false`  —— 简单，但内容被**重新生成**后要记得把它
     翻回 false。任何一处漏翻，用户就再也看不到红点了，而且很难发现。
  B. 时间戳：`seen_at`，未读 = `该产物的 updated_at > seen_at` ——
     内容重新生成后**自动**重新变红，不需要任何额外的写回逻辑。

选 B。理由不只是"少写代码"，而是它把"什么时候该变红"变成了一条**可推导的规则**，
而不是一个需要处处维护的状态。§4.2 里"看过即消、重新生成后再次变红"的语义
因此是自然结果，不是额外实现。

## 粒度：按 (用户, 草稿, 产物流)

产物流（stream）取值与工作台 tab 对齐：
  outline / chapters / storyboards / novel / tweet / prompts / images

按流分开记，才能做到"原文有新内容"和"剧本有新内容"分别亮红点。
只记草稿级的话，用户知道"这部剧有变化"但不知道变化在哪 —— 正是要解决的问题。
"""
from __future__ import annotations

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, UniqueConstraint, func, Index

from .models import Base


class DraftReadState(Base):
    """某个用户在某份草稿的某个产物流上，最后一次"看过"的时间。"""

    __tablename__ = "draft_read_state"

    id = Column(Integer, primary_key=True)
    user_id = Column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    draft_id = Column(
        Integer, ForeignKey("script_drafts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    #: 产物流，与工作台 tab 对齐：outline / chapters / storyboards / novel / tweet / prompts / images
    stream = Column(String(32), nullable=False)

    #: 该用户最后一次查看这个流的时间。"未读" = 该流的产物 updated_at > seen_at
    seen_at = Column(DateTime, server_default=func.now(), nullable=False)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        # 一人一草稿一流只有一行 —— upsert 的冲突键
        UniqueConstraint("user_id", "draft_id", "stream", name="uq_draft_read_state"),
        # 列表页要按 (用户, 草稿集合) 批量查未读，这个索引是那条查询的支撑
        Index("ix_draft_read_state_user_draft", "user_id", "draft_id"),
    )
