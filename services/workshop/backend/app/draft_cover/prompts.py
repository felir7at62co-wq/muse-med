"""draft_cover.prompts — B 方案: 标题入图的海报封面 prompt.

策略:
  阶段 1: LLM 把 (outline.synopsis + characters + world) 压成 60-120 词
          英文"海报视觉意象" (氛围 / 色调 / 关键道具 / 构图意象).
          ★ 严禁写 "title / text / poster / caption" 等元词 — 避免和阶段 2
          的标题硬指令打架.
  阶段 2: 拼装最终 prompt = 视觉意象 + 海报构图(标题留白区) + 标题硬指令
          + 风格 + 负面. 标题以 ScriptDraft.title 为准, 经过严格清洗
          (去除引号 / 书名号 / 连字符 / markdown 标记) 才进 prompt.

为什么 B 方案 + 独立海报模板 (不复用 image2 速转模板):
  - 用户决定封面要带标题, image2 中文渲染对短剧标题 (4-8 字) 足够稳定
  - 海报需要"概念意象 + 留白 + 大字标题", 不是"分镜定格剧照"
  - 速转 image2 模板是"短剧首帧图"(主体N + 焦距 50mm + 光圈 f2.0 +
    单帧定格抬腿瞬间), 那是剧照逻辑, 套到海报会出"一个角色在做一个具体动作"
    的截图, 不像海报
  - 海报模板核心 = 把标题留白讲清楚, 把视觉意象讲简练, 让 image2 的
    构图自由度大于细节填充
"""
from __future__ import annotations

import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from ..models.llm import ainvoke_with_fallback

logger = logging.getLogger("draft_cover.prompts")


# ─────────────────────── 清洗 ───────────────────────

# 各种引号 + 中英文书名号 + 角括号 + 反引号 + markdown 强调符
# 这些字符如果留在 prompt 里, image2 容易把它们当成"画面要画的内容",
# 在海报上印一堆乱标点
_NOISE_CHARS = "\"'\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u300a\u300b\u3008\u3009<>\u00ab\u00bb\u2039\u203a`*#"
_NOISE_RE = re.compile("[" + re.escape(_NOISE_CHARS) + "]")


def _sanitize_text(s: str) -> str:
    """清洗给 image2 的输入: 去引号/书名号/连字符/markdown 标记."""
    if not s:
        return ""
    s = _NOISE_RE.sub("", s)
    # 各种连字符替换 (image2 看到 -- 会截断 prompt)
    s = s.replace("--", " ").replace("—", " ").replace("–", " ")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _sanitize_title(title: str, *, max_chars: int = 16) -> str:
    """清洗 + 截断标题. 短剧标题一般 4-8 字, 超过 16 字 image2 渲染明显糊."""
    t = _sanitize_text(title)
    if len(t) > max_chars:
        t = t[:max_chars]
    return t.strip()


# ─────────────────────── 阶段 1: LLM 抽视觉意象 ───────────────────────

_VISUAL_LLM_SYSTEM = """你是中国短剧海报美术指导。
我会给你一份短剧大纲信息(梗概/主要角色/世界观)。
你必须输出**一段英文画面描述**, 60-120 词, 用于驱动 AI 海报生图模型 (gpt-image-2).

输出严格规则:
1. 只描述画面视觉: 氛围 / 色调 / 关键道具 / 主体意象 / 构图角度. 不写剧情, 不写对白.
2. ★ 严禁出现 "title / text / poster / caption / sign / typography / letter / character" 等元词,
   也不要描述任何"会出现文字的招牌/横幅/书页". 这些会和后续的标题指令打架.
3. 不要描述任何具体可识别的真人脸特征. 主体处理用 "silhouette / back view / shadowed figure / hands holding"
   一类抽象方式.
4. 必须包含至少 1 项明确色调 (warm crimson / cold cyan / golden hour / moonlit blue 等).
5. ★ 画面是 16:9 横屏 (wide horizontal cinematic frame). 必须把主体安排在画面右半边,
   左半边留出大块负空间 (干净的氛围/虚化的背景/雾气/远景), 不要把主体放到画面正中
   或左侧, 不要让左半边塞满细节. 写"main subject placed on the right side / right
   third anchors the figure / wide horizontal framing with left negative space"
   一类构图意象.
6. 题材属性必须落到画面: 古装→宫廷/水墨/丝绸/烛光/檀木; 都市→霓虹/玻璃幕墙/雨夜/写字楼; 悬疑→低光/雾霾/暗角;
   玄幻→灵气/星轨/幻光/仙鹤; 校园→课桌/篮球场/夕阳长廊.
7. 不要换行, 不要 bullet, 不要前缀, 直接输出英文段落, 一段一句到底.
"""


def _summarize_for_visual(outline: dict | None, user_input: str) -> str:
    """从 outline 抽 LLM 输入素材. 不传 title (避免 LLM 把 title 写进意象描述)."""
    if not isinstance(outline, dict):
        outline = {}

    parts: list[str] = []

    syn = (outline.get("synopsis") or "").strip()
    if syn:
        parts.append(f"梗概: {_sanitize_text(syn[:300])}")

    chars = outline.get("characters") or []
    if isinstance(chars, list) and chars:
        char_lines: list[str] = []
        for c in chars[:3]:
            if not isinstance(c, dict):
                continue
            n = _sanitize_text((c.get("name") or "")[:20])
            r = _sanitize_text((c.get("role") or "")[:20])
            traits = c.get("traits") or []
            if isinstance(traits, list):
                tr = "/".join(_sanitize_text(str(x))[:12] for x in traits[:3] if x)
            else:
                tr = ""
            line = n
            if r:
                line += f"({r})"
            if tr:
                line += f": {tr}"
            if line.strip():
                char_lines.append(line)
        if char_lines:
            parts.append("主要角色: " + " | ".join(char_lines))

    world = outline.get("world") if isinstance(outline.get("world"), dict) else {}
    era = _sanitize_text((world.get("era") or "").strip()[:60]) if world else ""
    setting = _sanitize_text((world.get("setting") or "").strip()[:120]) if world else ""
    if era or setting:
        parts.append(f"世界观: {era} {setting}".strip())

    # 没有 outline 就拿 user_input 当兜底素材
    if not parts and user_input:
        parts.append(f"创作初衷: {_sanitize_text(user_input[:300])}")

    return "\n".join(parts)[:1200]


# ─────────────────────── 阶段 2: 拼装最终 prompt ───────────────────────

# 风格锚点 (固定不变, 保证多张封面有视觉一致性)
_STYLE_LINE = (
    "Painterly digital art, premium streaming platform poster, Chinese drama "
    "aesthetic, dramatic cinematic lighting with rich color grading, ultra "
    "detailed, glossy magazine quality, depth and atmosphere."
)

# 负面提示
# 关键: "no extra Chinese characters except the show title above" 必须放在标题指令后面,
# 否则模型会把"no Chinese characters"当成全局禁令把标题也擦了
_NEGATIVE_LINE = (
    "Negative: no subtitles, no captions, no watermark, no logo, no UI elements, "
    "no extra Chinese characters or random Chinese text except the show title "
    "above, no Latin letters or English words anywhere on the poster, no "
    "doubled or repeated title, no faces of recognizable real celebrities, "
    "no QR code, no barcode."
)

# 兜底视觉意象 (LLM 抽取失败时用)
# 16:9 横屏构图: 主体偏右下, 左上留出大块空区给标题
_FALLBACK_VISUAL = (
    "An evocative cinematic Chinese drama atmosphere with cold moonlight and "
    "warm amber accent, a solitary back-view silhouette in flowing traditional "
    "garments standing at the right side of a misty courtyard, the right two "
    "thirds of the frame anchors the figure and atmosphere, the left third "
    "stays mostly empty as negative space with deep shadows and soft particle "
    "bloom, wide horizontal cinematic framing."
)


def _build_final_prompt(*, visual: str, clean_title: str) -> str:
    """B 方案最终 prompt: 视觉 + 构图(标题留白) + 标题硬指令 + 风格 + 负面.

    16:9 横屏布局: 标题放画面 **左侧** 上下居中区, 主体放右侧.
    这样在 DraftCard 的 aspect-[16/9] 容器里 object-cover 不会裁掉标题.
    """
    # 标题指令是核心, 用三段冗余约束让 image2 严格按字渲染:
    #   1. 在哪里画 (left side, vertically centered area)
    #   2. 用什么字体 (large bold modern Chinese poster typography)
    #   3. 字到底是什么 (exactly these characters, do not invent)
    title_instruction = (
        f"Text on poster (CRITICAL): render exactly these Chinese characters "
        f"and only these characters in the left third of the poster, vertically "
        f"centered, as the official show title, very large bold modern Chinese "
        f"poster typography, high contrast against the background, perfectly "
        f"legible at first glance, do not invent new characters, do not add "
        f"subtitles or any other text, the only text on the entire poster is "
        f"the title:\n"
        f"{clean_title}"
    )

    composition_line = (
        "Composition: 16:9 wide horizontal cinematic poster framing. Place the "
        "main subject and atmospheric details in the right two thirds of the "
        "frame. Keep the left third as a clean, uncluttered negative-space "
        "area (soft gradient / mist / out-of-focus background) reserved "
        "exclusively for the show title text. Do not cover the left third "
        "with figures, props or busy texture."
    )

    parts = [
        "Horizontal 16:9 cinematic Chinese short drama poster cover, wide "
        "landscape orientation.",
        "",
        f"Visual concept: {visual.strip()}",
        "",
        composition_line,
        "",
        title_instruction,
        "",
        f"Style: {_STYLE_LINE}",
        "",
        _NEGATIVE_LINE,
    ]
    return "\n".join(parts)


def _build_titleless_prompt(visual: str) -> str:
    """标题清洗后为空时的退化路径 — 不画文字, 只出氛围海报 (16:9 横屏)."""
    return (
        "Horizontal 16:9 cinematic Chinese short drama poster cover, wide "
        "landscape orientation.\n"
        "\n"
        f"Visual concept: {visual.strip()}\n"
        "\n"
        "Composition: 16:9 wide horizontal framing. Subject in the right two "
        "thirds, the left third stays as clean negative space reserved for "
        "later editorial title placement.\n"
        "\n"
        f"Style: {_STYLE_LINE}\n"
        "\n"
        "Negative: absolutely no text, no Chinese characters, no Latin "
        "letters, no captions, no subtitles, no watermark, no logo, no UI "
        "elements, no QR code, no barcode, no faces of recognizable real "
        "celebrities, no doubled subjects."
    )


# ─────────────────────── 主入口 ───────────────────────

async def build_image_prompt(
    *,
    title: str,
    tags: list[str] | None,
    user_input: str,
    outline: dict | None,
) -> str:
    """主入口: 给 image2 用的海报 prompt (B 方案, 标题画进画面).

    Args:
        title: 用户在 ScriptDraft.title 填的标题, 是画面里要出现的文字
               (这里是真正进入 prompt 的标题; 调用方负责从 ScriptDraft
                取 title, 如果空则从 outline.title 取)
        tags: 用作风格锚点 (现在主要影响 LLM 的题材识别, 不直接进 prompt 文本)
        user_input: 用户初始输入, LLM 抽视觉意象的兜底素材
        outline: 已经生成的大纲, 含 synopsis / characters / world

    Returns:
        给 gpt-image-2 的纯文本 prompt.
    """
    # 1. 标题清洗 (绝对优先, 决定走 B 方案还是退化路径)
    clean_title = _sanitize_title(title)

    # 2. 给 LLM 喂大纲素材, 抽视觉意象
    brief = _summarize_for_visual(outline, user_input)
    if not brief:
        # 完全没素材, 退化也得有个兜底意象
        brief = "(no synopsis provided yet, generate a generic atmospheric concept)"

    # 题材标签作为风格 hint, 跟 brief 一起送给 LLM (不进最终 prompt)
    tag_hint = ""
    if tags:
        clean_tags = [_sanitize_text(t)[:12] for t in tags if t]
        clean_tags = [t for t in clean_tags if t][:5]
        if clean_tags:
            tag_hint = "题材标签 (用于风格判断): " + ", ".join(clean_tags) + "\n"

    visual = ""
    try:
        resp = await ainvoke_with_fallback(
            [
                SystemMessage(content=_VISUAL_LLM_SYSTEM),
                HumanMessage(content=tag_hint + brief),
            ],
            role="rewrite",
            temperature=0.7,
            max_tokens=400,
        )
        raw = (getattr(resp, "content", "") or "").strip()
        # LLM 输出本身也清洗一遍 (它有时候会偷偷给你引号 / markdown)
        raw = raw.replace("\n", " ")
        raw = _sanitize_text(raw)
        if len(raw) >= 40:
            visual = raw
        else:
            logger.warning("draft_cover visual prompt too short (%d chars), using fallback", len(raw))
    except Exception as e:  # noqa: BLE001
        logger.warning("draft_cover visual LLM failed, using fallback: %s", e)

    if not visual:
        visual = _FALLBACK_VISUAL

    # 3. 拼最终 prompt
    if clean_title:
        return _build_final_prompt(visual=visual, clean_title=clean_title)
    # 标题为空 → 退化为无文字海报
    logger.info("draft_cover: empty title after sanitize, falling back to titleless prompt")
    return _build_titleless_prompt(visual)
