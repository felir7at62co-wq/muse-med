"""RunningHub 用量计费 (音频/配音/视频高清等非生图任务)。

## 为什么不是复用 image_billing

`image_billing.job_id` 是 ``unique=True`` 且外键指向 ``image_jobs.id``。
音频(novel_video_audio_chunks / audio_jobs)、前剪辑视频高清(frontcut_jobs)
的 job id 根本不在这张表里, 塞进去要么撞唯一约束、要么破坏外键语义。

所以单开一张通用表, 用 ``(biz_type, job_id)`` 应用层唯一来做幂等 ——
不设外键, 因为一张表要覆盖三种业务的三张作业表。

## 为什么单独存 started_at / finished_at 而不是用 created_at 反推

`image_studio` 的放大计费用 ``now - created_at`` 折算运行时长, 在图片场景够用
(提交即开始跑)。但音频/视频任务会**排队**: 提交后 task 先躺 pending 等
RunningHub 空闲, 排队时间不是算力消耗。用 created_at 反推会把排队时间算进去,
时长虚高且跨天不可比。

所以精确记两个时刻, 时长 = finished_at - started_at:
- started_at:  真正向 RunningHub 提交远端任务那一刻;
- finished_at: 轮询到终态那一刻(成功或失败都写, 失败也占用了算力)。

`duration_sec` 是该差值的物化, 便于直接 sum, 不必每次算。

## 单位

unit 固定 ``"小时"`` (与 image_billing 的 upscale 一致, 报价 4 元/小时),
quantity 存小时数(浮点)。金额折算走 pricing 模块, 本表只落用量。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
    func,
)

from ..db.models import Base


class RunninghubBilling(Base):
    """一次 RunningHub 远端任务的用量记录。

    biz_type 取值(与调用点一一对应, 新链路请沿用):
      - audio_studio   音频工坊 IndexTTS 合成
      - novel_audio    小说转视频配音分片
      - frontcut_tts   前剪辑配音
      - frontcut_hd    前剪辑视频高清放大
    """

    __tablename__ = "runninghub_billing"
    __table_args__ = (
        UniqueConstraint("biz_type", "job_id", name="uq_rh_billing_biz_job"),
    )

    id = Column(Integer, primary_key=True)
    biz_type = Column(Text, nullable=False, index=True)
    job_id = Column(Integer, nullable=False, index=True)
    # 原始业务标识(散列前的字符串), 便于人工核对; 直接用作业表主键时留空
    biz_key = Column(Text, default="")
    user_id = Column(Integer, index=True, nullable=True)   # 可空: 极少系统任务无主
    # 归属来源: explicit / auth / 业务链路名 / none。与 volc_usage_records 同口径。
    attribution_source = Column(Text, default="", index=True)

    # RunningHub 远端任务 id。音频分片场景一个 job 会跑多个 task,
    # 但 job 粒度只记一条(取首个非空 task), 明细看 novel_video_audio_chunks.rh_task_id。
    rh_task_id = Column(Text, default="")

    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    duration_sec = Column(Float, nullable=False, default=0.0)

    unit = Column(Text, nullable=False, default="小时")
    quantity = Column(Float, nullable=False, default=0.0)   # 小时数
    unit_price = Column(Float, nullable=False, default=0.0) # 元/小时快照
    amount = Column(Float, nullable=False, default=0.0)     # quantity * unit_price

    status = Column(Text, default="succeeded")   # succeeded | failed (失败也占算力)
    detail = Column(Text, default="")            # 备用说明
    created_at = Column(DateTime, server_default=func.now(), index=True)
