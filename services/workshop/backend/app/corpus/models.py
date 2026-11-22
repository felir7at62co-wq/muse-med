"""前贴语料库数据模型 (frontcut_corpus_items表)。

语料 = 一段"参考文本"(爆款钩子/题材套路/剧情复述), 生成五条前贴提示词时作为参考上下文。
两种产出:- source="video": 上传视频 → doubao 分段反推(第三人称详述画面) → 文本
  - source="text" : 用户直接上传/粘贴的现成文本

两种归属:
  - is_preset=True : 管理员上传的预置语料, 全体用户可见/可用, 普通用户不可编辑
  - is_preset=False: 用户自上传, 仅本人(+管理员)可见, 可用可随意编辑

管理员在"自上传"视图能看到所有用户的自上传语料(卡片带用户名标签)。

打标体系(2026-08 新增):
  视频反推完成后自动调用 LLM 进行二次分析打标, 提取:- 主角人设(protagonist_gender / protagonist_role)
  - 题材标签(theme_tags JSON 数组, 如 ["恐怖","猎奇","逆袭"])
  - 钩子类型(hook_type, 如 "视觉奇观"/"性张力"/"悬疑")
  - 核心设定一句话(scenario_summary, 如"女人从土里挖出大蛇")
  - 内容分级(content_rating: safe/sensitive/adult_lite)
  打标结果用于: 语料库筛选 + 生成前贴时向grok 注入结构化题材提示(topic_hints)。
"""
from __future__ import annotations

from sqlalchemy import Boolean, Column, DateTime, Integer, JSON, String, Text, func

from ..db.models import Base


class FrontcutCorpusItem(Base):
    """一条前贴语料库记录。"""
    __tablename__ = "frontcut_corpus_items"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)  # 归属人(上传者)
    is_preset = Column(Boolean, default=False, index=True)  # True=预置(管理员,全员可见不可编辑); False=自上传(仅本人可编辑)

    title = Column(String(200), default="")# 展示名(文件名/用户起的名)
    source = Column(String(16), default="text")  # text=直接文本; video=视频反推
    content = Column(Text, default="")# 语料正文(反推结果 或 用户文本)

    # 视频来源时保留原视频(供回看/重跑)
    video_oss_key = Column(String(255), default="")
    video_url = Column(Text, default="")       # 预签名播放URL

    # 视频反推流水线状态: uploaded → describing → done / failed (source=text时直接 done)
    status = Column(String(24), default="done", index=True)
    error = Column(Text, default="")

    # ── 二次打标字段(2026-08 新增, 视频反推完成后自动LLM 分析) ─────────────────────
    # 主角性别: male / female / mixed / unknown
    protagonist_gender = Column(String(16), default="", index=True)
    # 主角人设一句话, 如 "农村女孩" / "婆婆与儿媳" / "陌生男女"
    protagonist_role = Column(String(100), default="")
    # 题材标签JSON 数组, 如 ["恐怖","猎奇","逆袭"]。候选值见 corpus/tagger.py THEME_TAG_CANDIDATES
    theme_tags = Column(JSON, default=list)
    # 钩子类型: 视觉奇观 / 性张力 / 情绪冲突 / 悬疑 / 反常识 中一个
    hook_type = Column(String(50), default="")
    # 核心设定一句话, 如 "女人从土里挖出大蛇缠住手臂"
    scenario_summary = Column(String(300), default="")
    # 内容分级: safe=无敏感 / sensitive=含轻微暴力恐怖 / adult_lite=含轻度性张力
    content_rating = Column(String(20), default="safe", index=True)
    # 是否已完成自动打标; False=待打标 / True=已打标(tag_version 记版本号)
    auto_tagged = Column(Boolean, default=False, index=True)
    # 打标版本号, 用于批量重打标时识别哪些是旧版本
    tag_version = Column(Integer, default=0)

    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())