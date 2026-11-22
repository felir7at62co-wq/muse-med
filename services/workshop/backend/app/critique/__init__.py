"""评审精修 (Critique Room) — 多模型多身份评审-修订系统。

在现有逐集生成之上叠加的可选增强阶段:
- 多个评审身份 (逻辑/人物/观众/台词/题材) 独立审查当前稿, 产出问题清单
- 非 LLM 硬校验层先跑 (AI 腔词典 / 重复检测), 客观锚
- 仲裁者合并去重 + severity×置信排序 -> 编辑工单
- 编辑 (用户创作模型) 按工单定向改写 -> 新稿
- 分层多轮 (结构/人物/台词去AI/节奏) + 质量早停
- 结果落 critique_runs / critique_issues, 覆盖前存 script_episode_history 可回滚

详见 docs/PLAN_CRITIQUE_ROOM.md。
"""
from .routes import router as critique_router  # noqa: F401

__all__ = ["critique_router"]