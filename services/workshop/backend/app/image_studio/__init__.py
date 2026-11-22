"""文生图工作台 (image_studio) - P1.

能力:
- 文生图 / 图生图 (最多 9 张参考图)
- 三个生成 provider: gpt-image-2 (images接口) / gemini-3-pro-image-preview
  (Nano Banana Pro) / gemini-3.1-flash-image (Nano Banana 2) — 后两者走 gemini
  native generateContent, 均为 api4me ↔ zx1 双渠道互为兜底
- 预置前置提示词 (admin 管理, 用户选择)
- 产出转存 OSS, 30 天过期清理 (P3 接清理 worker)

P2 预留: RunningHub 高清放大
P3 预留: 切割(九宫格) + 过期清理 worker
"""
from .routes import router as image_studio_router  # noqa: F401

__all__ = ["image_studio_router"]
