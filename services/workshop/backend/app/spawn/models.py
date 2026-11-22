"""DNA 裂变工厂 ORM 模型。

一个 SpawnJob = 一次"从原作裂变出 N 个新作"的批量作业。
每个裂变方向(variant)独立生成一份全新大纲, 进度存 JSONB variants_json。

variants_json 结构:
  {
    "0": {
      "idx": 0,
      "angle": "古装宅斗版",           # 裂变方向标题
      "pitch": "把现代婆媳争产改写成...", # 一句话卖点
      "status": "生成中|待确认|已弃用|展开中|完成|失败",
      "draft_id": 123,                 # 预览阶段就落草稿, 展开时原地更新同一条
                                       # (同时写 new_draft_id 同值, 兼容旧前端/旧作业)
      "title": "凤鸣宫阙",             # 新作标题(来自大纲, 非 angle)
      "synopsis": "全剧主线梗概",       # 大纲级 synopsis, 供卡片试读
      "characters": [{"name","role"}], # 主要人物摘要
      "preview_chapters": [{"order","title","synopsis"}],  # 前 N 集摘要
      "episode_count": 24,             # 展开后的最终集数
      "lint": {"error": 0, "warn": 0}, # 展开后的一致性校验摘要
      "error": ""
    },
    ...
  }

dna_json: 提取出的「爆款 DNA」(缓存, 便于二次裂变不重抽)
"""
from __future__ import annotations

from sqlalchemy import Column, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB

from ..db.models import Base


class SpawnJob(Base):
    """裂变作业: 对一部原作, 按创作意图批量裂变出 N 个各具新意的完整新作(大纲级)。"""

    __tablename__ = "spawn_jobs"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True)                 # 发起用户
    source_draft_id = Column(Integer, index=True)         # 原作草稿
    title = Column(String(256), default="")               # 人话描述
    intent = Column(Text, default="")                     # 用户创作意图(自由文本, 可空)
    mode = Column(String(16), default="homage")           # clone(换皮)|homage(同源)|inspired(灵感)
    model = Column(String(64), default="gemini")
    count = Column(Integer, default=3)                     # 裂变个数
    status = Column(String(20), default="pending")        # pending|running|preview_ready|done|partial_failed|failed|canceled
    # 两段式裂变: preview=先出"圣经+前N集"待人工确认, expanding=确认后展开全集,
    # legacy=旧的一步到位模式(two_stage=false 时)
    stage = Column(String(16), default="legacy")          # legacy|preview|expanding|done
    preview_episodes = Column(Integer, default=3)         # 预览集数
    total = Column(Integer, default=0)                    # = count
    finished = Column(Integer, default=0)                 # 已成功裂变数
    failed = Column(Integer, default=0)
    dna_json = Column(JSONB, default=dict)                # 提取的爆款 DNA
    variants_json = Column(JSONB, default=dict)           # 每个裂变方向的进度/产物
    error = Column(Text)
    # Token 使用量追踪（精确计费）
    total_tokens = Column(Integer, default=0)
    prompt_tokens = Column(Integer, default=0)
    completion_tokens = Column(Integer, default=0)
    cached_tokens = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())
    started_at = Column(DateTime)
    finished_at = Column(DateTime)


__all__ = ["SpawnJob"]