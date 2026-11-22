"""
production_image.prompts — image2 prompt 模板库（PLAN §37.7 + §4 落实）

包含两类资源：

1. STATIC_ASSETS  : 一次性静态资产（8 张），落盘到 apps/web/public/
   - 由 admin 手动触发批量生成；产物作为代码仓库的一部分提交
2. *_TEMPLATE     : 运行时按需 prompt 模板（3 类）
   - 草稿封面 / 角色头像 / 速转首帧图

设计原则：
- 所有 prompt 都明确 negative-prompt（避免 AI 字 / 文字水印 / 写实人脸 / 暴露内容）
- 所有 prompt 强制使用一致的"双主调插画风格"：紫 #7C3AED / 青 #22D3EE
- 所有 prompt 给出明确尺寸建议（写在 spec 里，由调用层传入 image2 API）
- 不对接外部 image2 API，仅提供 prompt 文本与 spec；最终调用层等用户授权
"""

from __future__ import annotations

from dataclasses import dataclass


# ─────────────────── 通用风格描述（所有 prompt 都拼上这一段）───────────────────

# 风格基调：现代插画 + 双主调（紫 #7C3AED 主、青 #22D3EE 辅）+ 暗深色背景
COMMON_STYLE = (
    "modern editorial illustration, soft gradients, geometric shapes, "
    "purple #7C3AED primary and cyan #22D3EE accent, dark navy background "
    "tinted with subtle nebula glow, clean negative space, premium product feel, "
    "no text, no watermarks, no logos, no human faces."
)

# 通用 negative prompt（拼到 prompt 末尾，部分 image2 API 走单独字段）
COMMON_NEGATIVE = (
    "text, watermark, signature, low-quality, blurry, photorealistic human faces, "
    "NSFW content, gore, jpeg artifacts."
)


@dataclass(frozen=True)
class StaticAssetSpec:
    """一次性静态资产的规格 — 由 admin 触发后批量生成。"""

    key: str
    output_path: str  # 相对仓库根目录
    width: int
    height: int
    prompt: str
    negative: str = COMMON_NEGATIVE
    notes: str = ""


# ─────────────────── 1. 一次性静态资产清单（8 张）───────────────────

STATIC_ASSETS: list[StaticAssetSpec] = [
    # ── 登录 / 注册双栏品牌区 ──────────────────────
    StaticAssetSpec(
        key="login-hero",
        output_path="apps/web/public/login-hero.webp",
        width=1024,
        height=1536,
        prompt=(
            "Vertical hero illustration for a creative writing studio login page. "
            "Centerpiece: an elegant abstract feather-quill morphing into film reels and "
            "code brackets, suggesting story + screen + technology. Floating constellation "
            "particles, soft purple-cyan light leaks. Bottom 30% reserved for typography. "
            f"{COMMON_STYLE}"
        ),
        notes="登录页右侧品牌区背景；底部 30% 留白便于叠加 slogan/标语",
    ),
    StaticAssetSpec(
        key="register-hero",
        output_path="apps/web/public/register-hero.webp",
        width=1024,
        height=1536,
        prompt=(
            "Vertical hero illustration for a creative writing studio register page. "
            "Centerpiece: an open notebook with glowing dialog bubbles rising and forming "
            "a cinematic short-drama scene tile in the upper portion. Cinematic depth, "
            "purple-cyan rim light, soft cosmic dust. Bottom 30% reserved for form. "
            f"{COMMON_STYLE}"
        ),
        notes="注册页右侧品牌区背景；与 login-hero 视觉系列化但构图不同",
    ),
    # ── 4 个空状态插画 ──────────────────────
    StaticAssetSpec(
        key="empty-no-drafts",
        output_path="apps/web/public/empty-states/no-drafts.webp",
        width=1024,
        height=1024,
        prompt=(
            "Centered minimalist illustration for an empty state: a stack of blank papers "
            "tied with a soft purple ribbon, a single quill pen leaning, a tiny glowing "
            "spark hovering above suggesting 'idea ready'. Soft ambient lighting, "
            "negative space-friendly, transparent-feel background. "
            f"{COMMON_STYLE}"
        ),
        notes="/drafts 列表为空时使用",
    ),
    StaticAssetSpec(
        key="empty-no-search-result",
        output_path="apps/web/public/empty-states/no-search-result.webp",
        width=1024,
        height=1024,
        prompt=(
            "Centered minimalist illustration for 'no search results': a magnifying glass "
            "looking over an empty card grid, with a tiny dotted question mark inside the "
            "lens. Cyan rim light, restrained palette, friendly tone, not somber. "
            f"{COMMON_STYLE}"
        ),
        notes="搜索 / 筛选无结果时使用",
    ),
    StaticAssetSpec(
        key="empty-no-memories",
        output_path="apps/web/public/empty-states/no-memories.webp",
        width=1024,
        height=1024,
        prompt=(
            "Centered minimalist illustration for 'no memories yet': three floating "
            "memory orbs (purple, cyan, amber) connected by faint constellation lines, "
            "with a small AI-shaped silhouette in the corner suggesting 'I will remember'. "
            "Soft, not melancholic. "
            f"{COMMON_STYLE}"
        ),
        notes="/settings/memories 列表为空时使用",
    ),
    StaticAssetSpec(
        key="empty-trash",
        output_path="apps/web/public/empty-states/trash-empty.webp",
        width=1024,
        height=1024,
        prompt=(
            "Centered minimalist illustration for 'trash is empty': a stylized recycle bin "
            "with a soft cyan glow inside, suggesting 'all clear'. Subtle confetti drift "
            "above, not celebratory but reassuring. Restrained palette. "
            f"{COMMON_STYLE}"
        ),
        notes="/trash 为空时使用",
    ),
    # ── 元资产 ──────────────────────
    StaticAssetSpec(
        key="og-image",
        output_path="apps/web/public/og-image.png",
        width=1024,
        height=1024,
        prompt=(
            "Open Graph card 1200x630 for a short-drama AI writing studio. "
            "Layout: left side bold gradient brand text area (will be overlaid in code), "
            "right side a cinematic frame showing layered storyboard tiles, dialog bubbles, "
            "and a quill morphing into a film reel. Premium tech-creative tone, "
            "purple-cyan dual-tone, deep navy background. "
            f"{COMMON_STYLE}"
        ),
        notes="社交分享 og:image。左侧留白由代码覆盖品牌文字",
    ),
    StaticAssetSpec(
        key="favicon-source",
        output_path="apps/web/public/favicon-source.png",
        width=1024,
        height=1024,
        prompt=(
            "Square 1:1 logo glyph at 512x512: a stylized quill-pen tip merging with a "
            "subtle play-triangle inside a softly-rounded square plate, purple-cyan "
            "gradient with a tiny highlight. Iconographic, no text. Must read clearly "
            "even when shrunk to 32x32 — strong silhouette, minimal detail. "
            f"{COMMON_STYLE}"
        ),
        notes="favicon 源图（再用工具生成 ico/16/32/180/512 多尺寸）",
    ),
]


# ─────────────────── 2. 运行时按需 prompt 模板（3 类）───────────────────

#: 草稿封面 — 用 draft.title + draft.synopsis（或 user_input）填进 {summary}。
DRAFT_COVER_TEMPLATE = (
    "Vertical poster-style cover illustration 720x1080 for a short-drama work titled "
    "{title}. Story essence: {summary}. Mood and tone should reflect the synopsis "
    "without showing recognizable human faces. Cinematic depth, "
    f"{COMMON_STYLE}"
)

#: 角色头像 — 用 character.appearance 填进 {appearance}，
# **强制要求**："stylized non-photorealistic, side or 3/4 silhouette" 避免真人脸。
CHARACTER_AVATAR_TEMPLATE = (
    "Square 1:1 character portrait 512x512, stylized non-photorealistic illustration. "
    "Character: {name}, role: {role}. Appearance description: {appearance}. "
    "Use 3/4 view or partial silhouette to keep it stylized; strong rim light, "
    "subtle background bokeh. Avoid photorealism and avoid recognizable real-person "
    f"likeness. {COMMON_STYLE}"
)

#: 速转首帧图 — 7 字段填进 {scene_description} 等。
QUICK_PROMPT_FRAME_TEMPLATE = (
    "Cinematic film frame 1920x1080. Scene: {scene}. Subject: {subject}. "
    "Action: {action}. Camera: {camera}. Lighting: {lighting}. Mood: {mood}. "
    f"Composition style: editorial illustration, no text, no watermark. {COMMON_STYLE}"
)


# ─────────────────── 工具函数 ───────────────────


def get_static_asset(key: str) -> StaticAssetSpec | None:
    """按 key 查找一次性资产 spec。"""
    for spec in STATIC_ASSETS:
        if spec.key == key:
            return spec
    return None


def render_draft_cover_prompt(*, title: str, summary: str) -> str:
    """填充草稿封面 prompt。summary 自动截断到 180 字以内防止 prompt 过长。"""
    s = (summary or "").strip()
    if len(s) > 180:
        s = s[:180].rstrip() + "..."
    return DRAFT_COVER_TEMPLATE.format(title=title or "Untitled", summary=s or "—")


def render_character_avatar_prompt(*, name: str, role: str, appearance: str) -> str:
    """填充角色头像 prompt。"""
    a = (appearance or "").strip()
    if len(a) > 220:
        a = a[:220].rstrip() + "..."
    return CHARACTER_AVATAR_TEMPLATE.format(
        name=name or "—",
        role=role or "supporting",
        appearance=a or "neutral, undefined",
    )


def render_quick_prompt_frame_prompt(
    *,
    scene: str,
    subject: str,
    action: str,
    camera: str,
    lighting: str,
    mood: str,
) -> str:
    """填充速转首帧图 prompt。"""
    return QUICK_PROMPT_FRAME_TEMPLATE.format(
        scene=scene or "—",
        subject=subject or "—",
        action=action or "—",
        camera=camera or "medium shot, eye-level",
        lighting=lighting or "natural daylight",
        mood=mood or "neutral",
    )
