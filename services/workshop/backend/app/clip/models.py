"""短视频流水线数据模型 (clip_jobs 表, 永久可看)。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB

from ..db.models import Base


class ClipJob(Base):
    """一条短视频流水线记录。

    阶段: input(已建) → composed(出创意+提示词+亮点) → image_done(首帧图)
          → video_running(提交RH) → done / failed
    """
    __tablename__ = "clip_jobs"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    title = Column(String(120), default="未命名短视频")

    # ① 输入
    input_kind = Column(String(16), default="idea")   # idea / script / reverse
    input_text = Column(Text, default="")             # 思路 / 粘贴的脚本 / 反推出的脚本

    # ② 合成产物 (1 次 AI)
    creative = Column(Text, default="")               # 视频创意(改编/再创作后)
    video_prompt = Column(Text, default="")           # 优化后视频提示词(走 seedance-pe)
    image_prompt = Column(Text, default="")           # 首帧图提示词
    highlights = Column(Text, default="")             # 亮点说明(画面效果/情绪钩子)

    # ③ 首帧图
    image_oss_key = Column(String(255), default="")
    image_url = Column(Text, default="")              # 预签名公网URL(给前端展示 + 喂RH)

    # ④ 视频参数 + 产物
    params = Column(JSONB, default=dict)              # {resolution, ratio, duration, generateAudio, realPersonMode}
    rh_task_id = Column(String(64), default="")
    video_oss_key = Column(String(255), default="")
    video_url = Column(Text, default="")             # 转存OSS后的公网URL

    status = Column(String(24), default="input", index=True)  # input/composed/image_done/video_running/done/failed
    error = Column(Text, default="")
    progress = Column(Integer, default=0)

    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ClipAsset(Base):
    """短视频资产库一条记录 = 视频 + 画面描述(反推) + seedance2.0提示词 + 分类 + 可见性。

    上传后自动流水线: uploaded → describing(反推画面描述) → optimizing(seedance优化) → done/failed。
    分类(category)用字符串, 同名即同类(天然合并), 不建独立表。
    管理员文件夹上传默认 is_public=True(公共); 普通用户上传 is_public=False(仅自己可见)。
    """
    __tablename__ = "clip_assets"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)      # 归属人
    is_public = Column(Boolean, default=False, index=True)      # True=公共; False=私有(仅自己+管理员可见)
    category = Column(String(80), default="未分类", index=True) # 分类(同名自动合并)
    title = Column(String(160), default="")                    # 原文件名(去扩展名)

    # 视频
    video_oss_key = Column(String(255), default="")
    video_url = Column(Text, default="")                       # 预签名公网URL(播放)
    cover_url = Column(Text, default="")                       # 可选:首帧缩略(v2)
    duration_s = Column(Integer, default=0)                    # 可选:时长秒(v2)
    size_bytes = Column(Integer, default=0)

    # 产物
    description = Column(Text, default="")                     # 画面描述(gemini反推 full_text)
    prompt = Column(Text, default="")                          # seedance2.0 优化后提示词

    status = Column(String(24), default="uploaded", index=True)  # uploaded/describing/optimizing/done/failed
    error = Column(Text, default="")
    batch_id = Column(String(48), default="", index=True)      # 同批文件夹上传归为一批

    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
