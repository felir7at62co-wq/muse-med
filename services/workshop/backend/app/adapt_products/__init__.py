"""章节改编产物模块: 小说(novel) / 推文(tweet)。

只用原文 chapters 做输入, 逐章产出, 独立表存储, 不复写原文。
"""
from .routes import router as adapt_router

__all__ = ["adapt_router"]