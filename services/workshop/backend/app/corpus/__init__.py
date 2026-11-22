"""前贴语料库 — 预置 + 用户自上传的参考文本/视频反推结果。

替代原有的飞书短剧库作为生成五条前贴提示词时的参考上下文。
"""
from .models import FrontcutCorpusItem  # noqa: F401
from .routes import router  # noqa: F401

__all__ = ["FrontcutCorpusItem", "router"]