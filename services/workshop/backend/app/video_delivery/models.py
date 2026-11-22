"""视频交付模块数据模型 — 下载统计 + 业务标签"""
from __future__ import annotations

from sqlalchemy import (
    BigInteger, Column, DateTime, Integer, String, UniqueConstraint, func,
)

from ..db.models import Base


class VideoDownloadLog(Base):
    """视频下载统计日志(每次生成下载链接记一条)"""

    __tablename__ = "video_download_logs"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    job_id = Column(Integer, nullable=False, index=True)   # novel_video_jobs.id
    user_id = Column(Integer, nullable=False, index=True)  # 下载用户
    # 下载渠道: web(网页) / desktop(桌面下载器) / script(脚本)。便于区分统计, 缺省 web。
    channel = Column(String(16), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class VideoDeliveryTag(Base):
    """视频业务标签(全局共享的交付状态): 已使用 / 已发布 / 待剪辑 / 有问题 / 自定义。

    - 团队协作: 任何登录用户可打/取消, created_by 记录操作人便于追溯。
    - 幂等: (job_id, tag) 唯一, 同一视频同一标签只存一条。
    - "已使用"就是一条 tag='已使用' 的记录; 取消 = 删该行。
    """

    __tablename__ = "video_delivery_tags"
    __table_args__ = (UniqueConstraint("job_id", "tag", name="uq_video_tag_job_tag"),)

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    job_id = Column(Integer, nullable=False, index=True)    # novel_video_jobs.id
    tag = Column(String(32), nullable=False, index=True)    # 标签名
    created_by = Column(Integer, nullable=True)             # 操作人 user_id
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)