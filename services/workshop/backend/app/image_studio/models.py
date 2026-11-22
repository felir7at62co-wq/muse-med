"""image_studio 数据模型 (复用项目 db.Base)。

3 张表:
- image_jobs           一次生成/放大任务
- image_assets         产出图片 (转存 OSS 后)
- image_prompt_presets 预置前置提示词 (admin 管理, 用户选择)
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB

from ..db.models import Base

# 产出保留天数 (一个月)
RETENTION_DAYS = 30


def _default_expires_at() -> datetime:
    return datetime.utcnow() + timedelta(days=RETENTION_DAYS)


class ImageJob(Base):
    """一次图像任务。

    kind:     generate(文生图/图生图) | upscale(P2 高清放大)
    provider: gpt-image-2 | gemini-3-pro-image-preview | runninghub(P2)
    status:   pending | running | succeeded | failed | interrupted
    """

    __tablename__ = "image_jobs"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    kind = Column(Text, nullable=False, default="generate")
    provider = Column(Text, nullable=False)
    model = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="pending", index=True)
    progress = Column(Integer, default=0)
    # 入参快照: prompt/preset_id/size/n/ref_image_keys(参考图 OSS key 列表) 等
    params = Column(JSONB, nullable=True)
    # P2: RunningHub 远端任务 id, 用于重启后续查
    remote_task_id = Column(Text, nullable=True)
    # 串联流水线: 放大任务指向其源生成任务
    parent_job_id = Column(Integer, ForeignKey("image_jobs.id"), nullable=True)
    error = Column(Text, nullable=True)
    # RunningHub 算力时长口径(v2: 不再用 created_at 反推, 那会把排队时间算成算力):
    #   started_at  = 远端任务创建成功的瞬间
    #   finished_at = 轮询到终态的瞬间
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, default=_default_expires_at, index=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ImageAsset(Base):
    """任务产出的单张图片 (已转存 OSS)。"""

    __tablename__ = "image_assets"

    id = Column(Integer, primary_key=True)
    job_id = Column(Integer, ForeignKey("image_jobs.id"), index=True, nullable=False)
    user_id = Column(Integer, index=True, nullable=False)
    oss_key = Column(Text, nullable=False)
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
    # original(生成原图) | upscaled(放大图, P2) | slice(切片, P3)
    kind = Column(Text, nullable=False, default="original")
    seq = Column(Integer, default=0)
    meta = Column(JSONB, nullable=True)
    expires_at = Column(DateTime, default=_default_expires_at, index=True)
    created_at = Column(DateTime, server_default=func.now())


class ImagePromptPreset(Base):
    """预置前置提示词 (admin 管理, 用户端只读选择)。

    最终 prompt = prefix_text + 用户输入; negative_text 作为可选负面词。
    """

    __tablename__ = "image_prompt_presets"

    id = Column(Integer, primary_key=True)
    name = Column(Text, nullable=False)
    category = Column(Text, nullable=True)
    prefix_text = Column(Text, nullable=False, default="")
    negative_text = Column(Text, nullable=True)
    sort_order = Column(Integer, default=0)
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
