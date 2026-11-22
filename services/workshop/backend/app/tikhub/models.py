"""TikHub 用量统计模型。

按用户 + 接口维度记录每次 TikHub 调用(不做限额, 仅统计)。
用于后台/管理端查看"每个用户用了多少次、哪些功能、是否命中缓存(命中不计费)"。
"""
from __future__ import annotations

from sqlalchemy import BigInteger, Boolean, Column, DateTime, Integer, String, func

from ..db.models import Base


class TikHubUsage(Base):
    """TikHub 调用流水: 每次(未命中缓存的)真实外部调用记一条。"""

    __tablename__ = "tikhub_usage"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    user_id = Column(Integer, index=True, nullable=True)     # 触发调用的用户(匿名/系统为 null)
    endpoint = Column(String(128), index=True, nullable=False)  # 逻辑功能名, 如 search_videos / resolve_share_url
    tikhub_path = Column(String(256), nullable=True)         # 实际调用的 TikHub 接口路径
    keyword = Column(String(256), nullable=True)             # 检索关键词/目标ID(便于统计热门查询)
    ok = Column(Boolean, default=True)                       # 调用是否成功
    cached = Column(Boolean, default=False)                  # 是否命中缓存(命中=不计费)
    billed = Column(Boolean, default=True)                   # 是否产生计费(cached=True 时为 False)
    status_code = Column(Integer, nullable=True)             # TikHub 返回的 code
    request_id = Column(String(64), nullable=True)           # TikHub request_id, 便于对账
    error = Column(String(512), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), index=True)