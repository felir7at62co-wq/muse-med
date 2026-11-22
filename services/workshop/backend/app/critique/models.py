"""评审精修数据模型 (复用项目 db.Base)。

2 张表:
- critique_runs    一次精修任务 (一个 draft + 一组集 + 强度档)
- critique_issues  评审产出的问题条目 (审计/结果区理由标签来源)

产出的"新稿"不单独存表, 采纳时直接覆盖 script_chapters/script_storyboards,
覆盖前存 script_episode_history (复用既有版本表, 可回滚)。
"""
from __future__ import annotations

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


class CritiqueRun(Base):
    """一次评审精修任务。

    status:  pending | running | succeeded | failed | interrupted | canceled
    source:  chapter (章节正文) | storyboard (剧本分镜)
    intensity: light | standard | full
    params:  范围(episodes)/关注点(focus)/编辑模型/强度档快照
    progress_json: 看板实时数据 (当前轮/主题/各身份状态/编辑事件/百分比)
    result_json:   完成后逐集 diff + 前后质量分 + 收敛曲线 (供结果区)
    """

    __tablename__ = "critique_runs"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True, nullable=False)
    draft_id = Column(Integer, index=True, nullable=False)
    source = Column(Text, nullable=False, default="chapter")
    intensity = Column(Text, nullable=False, default="standard")
    status = Column(Text, nullable=False, default="pending", index=True)
    progress = Column(Integer, default=0)
    params = Column(JSONB, nullable=True)
    progress_json = Column(JSONB, nullable=True)
    result_json = Column(JSONB, nullable=True)
    applied = Column(Integer, default=0)  # 0=未采纳 1=已覆盖回写
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class CritiqueConfig(Base):
    """评审精修全局配置 (单行 id=1, admin 可改)。

    config_json 结构:
      {
        "roles": {"logic_reviewer": {"enabled": true, "weight": 1.0}, ...},
        "intensity": {"standard": {"models": ["gemini","deepseek"], "themes": [...]}},
        "default_intensity": "standard"
      }
    未配置项回落 roles.py 内置默认。
    """

    __tablename__ = "critique_config"

    id = Column(Integer, primary_key=True)
    config_json = Column(JSONB, nullable=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class CritiqueIssue(Base):
    """评审产出的单条问题 (合议后)。"""

    __tablename__ = "critique_issues"

    id = Column(Integer, primary_key=True)
    run_id = Column(Integer, ForeignKey("critique_runs.id"), index=True, nullable=False)
    episode_order = Column(Integer, nullable=False, default=0)
    round = Column(Integer, nullable=False, default=1)
    theme = Column(Text, nullable=True)            # structure|character|deai|pacing
    role = Column(Text, nullable=True)             # 评审身份 id
    severity = Column(Text, nullable=True)         # high|mid|low
    confidence = Column(Integer, default=0)        # 0-100 (N/总模型数 * 100)
    issue = Column(Text, nullable=True)
    evidence = Column(Text, nullable=True)
    fix_hint = Column(Text, nullable=True)
    locator = Column(JSONB, nullable=True)
    status = Column(Text, default="open")          # open|applied|rejected
    reject_reason = Column(Text, nullable=True)
    created_at = Column(DateTime, server_default=func.now())