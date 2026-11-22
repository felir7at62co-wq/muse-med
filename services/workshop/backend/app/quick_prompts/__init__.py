"""提示词速转模块.

为已有剧本/分镜/章节内容的用户提供"脱离剧本流"的提示词生成入口.

输入支持:
- free_text: 自由文本 (章节/剧本/分镜表), 调 LLM 智能结构化为 shots[]
- shots_json: 直接提供 shots[] 数组 (高级用户)
- from_draft: 从已有草稿的某些章节导入 (复用现有 storyboards)

数据存 redis 24h 过期, 不污染正式 draft 列表.
"""
from .routes import router

__all__ = ["router"]
