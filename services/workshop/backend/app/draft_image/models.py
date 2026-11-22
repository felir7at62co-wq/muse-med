"""草稿内「生图」版块数据模型 (复用项目 db.Base)。

4 张表:
- draft_characters         角色 (草稿内, name 唯一不强制, 可同名多形象)
- draft_character_images   角色形象图 (一个角色可多形象, 每形象指定适用集)
- draft_episode_image_config  每集生图模式 (none|single|grid9)
- draft_image_tasks        生图任务卡 (single=1镜1图; grid9=9镜合一再切9)

注意: 实际图像生成走 image_studio.providers + OSS, 本表只存任务编排 + 结果 oss_key。
"""
from __future__ import annotations

from datetime import datetime

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


class DraftCharacter(Base):
    """草稿内的角色 (用于垫图匹配)。"""

    __tablename__ = "draft_characters"

    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, index=True, nullable=False)
    name = Column(Text, nullable=False)
    created_at = Column(DateTime, server_default=func.now())


class DraftCharacterImage(Base):
    """角色的一个形象图。

    episodes: 适用集号列表 (chapter_order)。生图命中该角色名 + 当前集在 episodes 内时,
              此形象的 oss_key 注入 ref_image_keys。空列表表示对所有集生效。
    """

    __tablename__ = "draft_character_images"

    id = Column(Integer, primary_key=True)
    character_id = Column(Integer, ForeignKey("draft_characters.id"), index=True, nullable=False)
    oss_key = Column(Text, nullable=False)
    episodes = Column(JSONB, nullable=True)  # list[int]; None/[] = 全集
    seq = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())


class DraftEpisodeImageConfig(Base):
    """每集的生图模式。"""

    __tablename__ = "draft_episode_image_config"

    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, index=True, nullable=False)
    chapter_order = Column(Integer, nullable=False)
    mode = Column(Text, nullable=False, default="single")  # none|single|grid9
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class DraftImageTask(Base):
    """一张生图任务卡。

    mode=single: shot_indexes 仅 1 个; result_keys 仅 1 张。
    mode=grid9 : shot_indexes 最多 9 个 (按 prompt task_index 顺序);
                 合成 1 张 3x3 大图后切 9 张, result_keys 顺序对应 shot_indexes。
    """

    __tablename__ = "draft_image_tasks"

    id = Column(Integer, primary_key=True)
    draft_id = Column(Integer, index=True, nullable=False)
    user_id = Column(Integer, index=True, nullable=False)
    chapter_order = Column(Integer, nullable=False)
    mode = Column(Text, nullable=False, default="single")  # single|grid9
    group_index = Column(Integer, default=0)  # 本章内第几组 (grid9 用; single 用 0,1,2..)
    # 关联的 ScriptVideoPrompt.task_index 列表 (即"镜头"序号)
    shot_indexes = Column(JSONB, nullable=False)
    # 送模型的 image_prompt (single=原文; grid9=合成的 3x3 prompt)
    image_prompt = Column(Text, nullable=True)
    status = Column(Text, nullable=False, default="pending")  # pending|running|succeeded|failed
    progress = Column(Integer, default=0)
    error = Column(Text, nullable=True)
    model = Column(Text, nullable=True)
    size = Column(Text, nullable=True)
    ref_image_keys = Column(JSONB, nullable=True)  # 注入的角色垫图 oss_key
    # 与 ref_image_keys 同序的角色名标注; 生成时把 image_prompt 里的角色名隐式替换为 图1..图N
    # (image_prompt 仍存原文, 前端只显示原文; 替换只发生在送模型前)
    ref_labels = Column(JSONB, nullable=True)
    # 结果图 oss_key 列表 (single=1; grid9=9, 顺序对齐 shot_indexes)
    result_keys = Column(JSONB, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())