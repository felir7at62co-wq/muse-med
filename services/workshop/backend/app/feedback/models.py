"""用户反馈数据模型 (复用项目 db.Base)。

user_feedback: 每条对应一次用户主动提交的反馈。
- 提交时快照存 username/display_name, 避免用户改名后对不上。
- page_url 记录用户提交时所在页面, 便于定位问题。
- status: new(未读) | read(已读) | resolved(已解决)。
"""
from __future__ import annotations

from sqlalchemy import Column, DateTime, Integer, String, Text, func

from ..db.models import Base


class UserFeedback(Base):
    __tablename__ = "user_feedback"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    username = Column(String(64), nullable=True)       # 提交时快照
    display_name = Column(String(64), nullable=True)   # 提交时快照
    content = Column(Text, nullable=False)
    page_url = Column(Text, nullable=True)
    status = Column(String(16), nullable=False, default="new", index=True)
    created_at = Column(DateTime, server_default=func.now(), index=True)