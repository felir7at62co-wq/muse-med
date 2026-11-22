"""火山计费数据模型。

- VolcUsageRecord: 每次火山官方调用(视频理解/视频生成)的一条用量+成本记录, 精确到用户。
- VolcRateCard: 费率表(元/百万token), 管理员后台可编辑; 计费时快照进 usage 记录。

设计原则:
- 成本用 Numeric(高精度)存, 不做四舍五入, 保留多位小数。
- 计量以火山返回的真实 usage.total_tokens 为准; 缺失才按参数档位估算(is_estimated=True)。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean, Column, DateTime, Integer, Numeric, String, Text, func,
)

from ..db.models import Base


class VolcRateCard(Base):
    """火山模型费率表(元/百万 token)。管理员后台可编辑。"""
    __tablename__ = "volc_rate_cards"

    id = Column(Integer, primary_key=True)
    model_key = Column(String(64), unique=True, nullable=False)  # seed2.1pro-video-understand / seedance-2.0-video-gen
    label = Column(String(120), default="")                      # 中文展示名
    # 单价: 元 / 百万 token。高精度(最多 10 位小数)。
    unit_price_per_mtoken = Column(Numeric(20, 10), default=0)
    note = Column(Text, default="")
    updated_by = Column(Integer, nullable=True)                  # admin user id
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    created_at = Column(DateTime, server_default=func.now())


class VolcUsageRecord(Base):
    """一次火山官方调用的用量+成本记录。"""
    __tablename__ = "volc_usage_records"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=True)          # 归属用户(可能为空: 系统任务)
    biz_type = Column(String(32), index=True, nullable=False)     # video_understand / video_gen
    source = Column(String(32), default="", index=True)           # clip / frontcut / corpus / videopipe / firstframe ...
    model_key = Column(String(64), index=True, nullable=False)    # 对应费率表 model_key
    ep_id = Column(String(64), default="")                        # 火山 endpoint id
    request_id = Column(String(96), default="", index=True)       # 火山返回的 request/task id

    # ---- token 计量(视频理解 + 视频生成 都可能有) ----
    prompt_tokens = Column(Integer, default=0)
    completion_tokens = Column(Integer, default=0)
    total_tokens = Column(Integer, default=0)

    # ---- 视频生成参数(留档 + 兜底估算用) ----
    resolution = Column(String(16), default="")                  # 480p/720p/1080p
    duration_sec = Column(Numeric(10, 3), default=0)             # 时长秒(可小数)
    ratio = Column(String(16), default="")
    fps = Column(Integer, default=0)
    has_audio = Column(Boolean, default=False)

    # ---- 计价 ----
    unit_price_per_mtoken = Column(Numeric(20, 10), default=0)   # 下单时单价快照
    cost_cny = Column(Numeric(24, 12), default=0)               # 高精度成本, 不四舍五入
    is_estimated = Column(Boolean, default=False)               # True=返回缺usage, 按档位估算

    draft_id = Column(Integer, nullable=True, index=True)
    extra = Column(Text, default="")                            # 备用(存原始 usage JSON 片段等)
    # 归属来源: explicit(调用方显式传了 user_id) / auth(鉴权卡点盖章) /
    # 业务链路名 / none(上下文里也没有 —— 这次调用确实无人可归)。
    # 见 volc/billing.record_usage 的归属回退逻辑。
    attribution_source = Column(String(40), default="", index=True)

    created_at = Column(DateTime, server_default=func.now(), index=True)