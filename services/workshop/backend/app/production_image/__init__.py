"""
production_image — 生产级 image2 资产生成模块（dev-only，受控）

与现有 dev_image 模块的差别：
 - dev_image: 给开发者调试用 image2 API 的实验池
 - production_image: 业务侧的"实际产出"通道，绑定字段 (drafts.cover_url) /
   配额 (image_generation_quotas) / 审计

按 PLAN_UI_REVAMP §37.7 + PLAN_UI_REVAMP_EXEC.md §4 实施。

当前阶段：仅提供 prompts 模板和说明，**不接 routes.py / 不挂 main.py**，
等用户授权后再把 routes 接入并执行批量生成。
"""

from .prompts import (
    STATIC_ASSETS,
    DRAFT_COVER_TEMPLATE,
    CHARACTER_AVATAR_TEMPLATE,
    QUICK_PROMPT_FRAME_TEMPLATE,
    StaticAssetSpec,
    get_static_asset,
    render_draft_cover_prompt,
    render_character_avatar_prompt,
    render_quick_prompt_frame_prompt,
)

__all__ = [
    "STATIC_ASSETS",
    "DRAFT_COVER_TEMPLATE",
    "CHARACTER_AVATAR_TEMPLATE",
    "QUICK_PROMPT_FRAME_TEMPLATE",
    "StaticAssetSpec",
    "get_static_asset",
    "render_draft_cover_prompt",
    "render_character_avatar_prompt",
    "render_quick_prompt_frame_prompt",
]
