"""计费数据模型 (复用项目 db.Base)。

image_billing: 每条对应一次成功的 image_jobs (generate / upscale),
记录估算费用 (人民币元) + 计费明细, 便于用户/管理员核对。
"""
from __future__ import annotations

from sqlalchemy import (
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB

from ..db.models import Base


class ImageBilling(Base):
    """一条生图/放大任务的计费记录。

    kind:     generate | upscale
    model:    gpt-image-2 | gemini-3-pro-image-preview | runninghub
    quantity: generate=出图张数; upscale=运行小时数(浮点)
    unit_price: 单价 (元/张 或 元/小时)
    amount:   quantity * unit_price (元)
    detail:   计费明细 (size/tier/duration_seconds 等), 便于回溯
    """

    __tablename__ = "image_billing"

    id = Column(Integer, primary_key=True)
    job_id = Column(Integer, ForeignKey("image_jobs.id"), index=True, nullable=False, unique=True)
    user_id = Column(Integer, index=True, nullable=False)
    kind = Column(Text, nullable=False)          # generate | upscale
    model = Column(Text, nullable=False)         # 计费用的 provider 标识
    unit = Column(Text, nullable=False)          # 张 | 小时
    quantity = Column(Float, nullable=False, default=0)
    unit_price = Column(Float, nullable=False, default=0)
    amount = Column(Float, nullable=False, default=0, index=True)
    detail = Column(JSONB, nullable=True)
    created_at = Column(DateTime, server_default=func.now(), index=True)