"""批量创建工厂: 一次批量生成多个 AI 原创草稿, 自动跑完 大纲→(小说|剧本)→分析打分,
用于"广撒网 + 靠分数筛底子好的稿子"。复用现有 AutoBatchJob 表做批次持久化。
"""
from .routes import router  # noqa: F401