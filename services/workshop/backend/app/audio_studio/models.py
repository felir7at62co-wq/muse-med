"""audio_studio 数据模型 (复用项目 db.Base)。

2 张表:
- audio_jobs    一次音频生成任务 (RunningHub IndexTTS 工作流)
- audio_assets  产出音频 (转存 OSS 后)

调度/抗重启思路与 image_studio 完全一致:
- RunningHub 远端异步工作流: upload(参考音频) -> create -> poll status -> outputs
- rh_task_id 存 params, 重启后用它续查 (远端任务不受本进程影响)
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Integer,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB

from ..db.models import Base

# 产出保留天数 (一个月), 与 image_studio 一致
RETENTION_DAYS = 30


def _default_expires_at() -> datetime:
    return datetime.utcnow() + timedelta(days=RETENTION_DAYS)


class AudioJob(Base):
    """一次音频生成任务。

    provider: runninghub (IndexTTS 工作流)
    status:   pending | running | succeeded | failed | interrupted | canceled
    params:   text(待合成文本) / ref_audio_oss_key(参考音色 OSS key) /
              rh_task_id(RunningHub 远端任务 id, 用于重启续查) 等
    """

    __tablename__ = "audio_jobs"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    provider = Column(Text, nullable=False, default="runninghub")
    model = Column(Text, nullable=True, default="IndexTTS-1.5")
    status = Column(Text, nullable=False, default="pending", index=True)
    progress = Column(Integer, default=0)
    params = Column(JSONB, nullable=True)
    error = Column(Text, nullable=True)
    # 算力时长口径专用 (见 billing/service.record_runninghub):
    #   started_at  = 远端 RunningHub 任务创建成功的瞬间
    #   finished_at = 轮询到终态 (成功或失败) 的瞬间
    # 不能用 created_at→updated_at 反推: 任务在 pending 里排队的时间不是算力。
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, default=_default_expires_at, index=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class AudioAsset(Base):
    """任务产出的单个音频 (已转存 OSS)。"""

    __tablename__ = "audio_assets"

    id = Column(Integer, primary_key=True)
    job_id = Column(Integer, ForeignKey("audio_jobs.id"), index=True, nullable=False)
    user_id = Column(Integer, index=True, nullable=False)
    oss_key = Column(Text, nullable=False)
    # 音频格式 (flac/wav/mp3), 由产出文件后缀推断
    fmt = Column(Text, nullable=True)
    duration_ms = Column(Integer, nullable=True)
    seq = Column(Integer, default=0)
    meta = Column(JSONB, nullable=True)
    expires_at = Column(DateTime, default=_default_expires_at, index=True)
    created_at = Column(DateTime, server_default=func.now())