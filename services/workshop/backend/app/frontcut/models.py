"""前贴(front-cut)流水线数据模型。

B线状态机: 用户传剧情视频 → 反推 → 5框架生成5条提示词 → 5条前贴视频(RunningHub) → 选1条 → 拼接导出。

状态流转 status:
  created → reversing(反推中) → prompting(生成提示词) → await_select_prompt(可选:让用户看提示词)
    → generating(生成5条前贴视频) → await_pick(等用户挑选) → composing(拼接) → succeeded / failed
"""
from __future__ import annotations

from sqlalchemy import Column, DateTime, Integer, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func

from ..db.models import Base


class FeishuReverseJob(Base):
    """A线: 飞书多维表格「链接」列批量反推任务(后台执行 + 进度轮询)。

    流程: 读飞书表每行「链接」列的抖音链接 → TikHub 取公网直链 → 豆包反推
          → 回写「文本」列(反推结果) + 可选「提示词」列(seedance优化)。
    因每条反推约 40-60s、表可达数百行, 必须后台跑, 前端轮询进度。
    """
    __tablename__ = "feishu_reverse_jobs"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    status = Column(Text, nullable=False, default="pending", index=True)
    # pending → running → succeeded / partial_failed / failed
    progress = Column(Integer, default=0)   # 0-100
    error = Column(Text, nullable=True)

    # 飞书表定位
    source_ref = Column(Text, nullable=True)   # 用户原始输入(wiki/base 链接或 token)
    app_token = Column(Text, nullable=True)    # 解析后的 bitable app_token
    table_id = Column(Text, nullable=True)
    # 列映射: {"douyin_url":"链接","reverse_out":"文本","prompt_out":"提示词"(可选)}
    field_map = Column(JSONB, nullable=True)

    # 统计
    total = Column(Integer, default=0)
    done = Column(Integer, default=0)     # 已处理(ok+skip+fail)
    ok = Column(Integer, default=0)
    skip = Column(Integer, default=0)
    fail = Column(Integer, default=0)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class FrontcutJob(Base):
    """一次前贴生成任务。"""
    __tablename__ = "frontcut_jobs"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    status = Column(Text, nullable=False, default="created", index=True)
    progress = Column(Integer, default=0)
    error = Column(Text, nullable=True)

    # 剧情视频(用户上传, 存 OSS)
    source_video_oss_key = Column(Text, nullable=True)
    source_video_url = Column(Text, nullable=True)   # 若来自URL(可选)
    # 剧情视频规格(前贴要与之一致): 打开页面即预设, 允许改
    ratio = Column(Text, nullable=True)              # 如 9:16 / 16:9 (默认取剧情视频比例)
    resolution = Column(Text, nullable=False, default="720p")
    duration = Column(Integer, nullable=False, default=10)  # 前贴时长(秒), 默认10

    # 用户可选参考提示词
    user_ref = Column(Text, nullable=True)
    # 用户勾选的语料库条目 id 列表(生成五条前贴提示词时作参考上下文)
    corpus_ids = Column(JSONB, nullable=True)
    # 用户可选上传的主角形象参考图(存 OSS), 生成视频时作为参考图之一
    ref_image_oss_key = Column(Text, nullable=True)
    # 用户选定的参考音色(存 OSS key), 用于语音克隆生成口播
    voice_ref_oss_key = Column(Text, nullable=True)

    # 反推结果(= 原片完整剧情口播文案)
    reverse_summary = Column(Text, nullable=True)
    # 正片首帧画面描述(用于前贴"首帧锚点衔接": grok 让故事收束到此画面, Seedance 尾帧对齐此画面)
    first_frame_desc = Column(Text, nullable=True)
    # 原片口播音频(语音克隆合成, 存 OSS)
    narration_audio_oss_key = Column(Text, nullable=True)

    # 5 条前贴提示词候选: [{framework_id, framework_name, prompt}]
    prompt_candidates = Column(JSONB, nullable=True)

    # 5 条前贴视频候选: [{framework_id, framework_name, prompt, rh_task_id, video_oss_key, status, error}]
    video_candidates = Column(JSONB, nullable=True)

    # 用户挑选的候选(framework_id)
    picked_framework_id = Column(Text, nullable=True)

    # 最终成片(前贴+剧情拼接后)
    final_video_oss_key = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class FrontcutVoiceRef(Base):
    """用户上传的参考音色库(供前贴流水线语音克隆下拉选择)。"""
    __tablename__ = "frontcut_voice_refs"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    name = Column(Text, nullable=False)          # 展示名(用户起的/文件名)
    oss_key = Column(Text, nullable=False)        # 参考音频存 OSS 的 key
    created_at = Column(DateTime(timezone=True), server_default=func.now())
