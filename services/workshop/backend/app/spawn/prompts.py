"""DNA 裂变工厂 — Prompt 构造。

三类 prompt:
  1. extract_dna     —— 从原作 outline(+章节摘要) 提炼「爆款 DNA」(为什么好看的本质)
  2. plan_variants   —— 基于 DNA + 用户意图, 规划出 N 个各具新意的裂变方向
  3. build_brief     —— 把"某个裂变方向 + DNA"渲染成一段创作意图, 喂给现有大纲管线
                        (generate_outline_pipeline 的 user_input), 由它产出完整全新大纲

与旧「换皮改编」的本质区别:
  - 旧: 锁死原作集数/节拍/场次, 逐句换皮 → 产出像"改名版"
  - 新: 只保留"爽点公式/情绪节奏/关系张力模型", 重新编故事 → 产出是"新作品"
"""
from __future__ import annotations

import json


# ===========================================================================
# 0. 题材硬约束 (与 adaptation.PROPOSE_PROMPT 对齐, 面向大众短剧受众)
# ===========================================================================

_GENRE_CONSTRAINT = """# 题材硬约束
新作的时代背景**必须**从下列主流短剧题材中选取, 选最能承载原作戏剧内核的:
- 现代都市(豪门恩怨/商战/职场/都市情感/婚姻家庭)
- 穿越/重生(穿越古代、重生改命、回到过去)
- 架空古代/古装(架空王朝宫廷、古风宅斗、江湖恩怨)
- 民国(民国大家族、乱世情缘)
- 校园青春(校园、初恋、青春成长)
- 仙侠玄幻(修仙、宗门、神魔)——仅当原作本身偏奇幻时才选

**严禁**赛博朋克、未来科技、末世废土、星际科幻、AI、虚拟世界等小众/科技向题材。
优先观众一眼就懂、代入门槛低的题材。用户意向优先于此约束。"""


# ===========================================================================
# 1. 提取爆款 DNA
# ===========================================================================

EXTRACT_DNA_PROMPT = """你是短剧爆款拆解专家。下面是一部短剧的结构化资料。
不要复述剧情, 请提炼它「为什么好看」的底层 DNA —— 这些是可迁移到任何题材的爽感引擎。

# 原作资料
{source_block}

# 任务
提炼下列 DNA 要素, 严格输出 JSON(不要 Markdown 包装, 不要解释文字):

{{
  "hook_formula": "核心爽点公式(一句话概括这部剧靠什么让观众上头, 如'弱者隐藏实力→被轻视→打脸逆袭'的循环)",
  "emotional_engine": "情绪引擎(观众代入的核心情绪, 如 憋屈-爽快 / 虐恋-救赎 / 悬疑-揭底)",
  "relationship_model": [
    {{"model":"关系张力模型(抽象, 如 '施害者vs复仇者''错位身份的相互吸引')", "why_it_works":"为什么这个张力抓人"}}
  ],
  "opening_hook": "黄金三秒/黄金开场做法(原作如何在开头抓住观众)",
  "twist_patterns": ["贯穿全剧的反转套路(抽象化, 如 '身份反转''反派反杀''伪装揭穿')"],
  "beat_rhythm": [
    {{"phase":"开端/发展/高潮/结局", "function":"该阶段的爽点职能(如 立矛盾/埋钩子/连环反转/情绪总爆发)", "intensity":"情绪强度 1-5"}}
  ],
  "signature_devices": ["原作的招牌桥段/记忆点(抽象, 如 '当众打脸''契约婚姻''失忆梗')"],
  "audience": "目标受众画像一句话",
  "why_hit": "综合判断: 这部剧最核心的爆款基因是什么(一句话)"
}}

# 要求
- 全部**抽象化**表达, 不要绑定具体人名/时代/地点(那些是皮, 不是 DNA)
- beat_rhythm 概括全剧情绪节奏(6-10 个阶段), 这是裂变时要保留的骨架
- 只输出 JSON
"""


def build_source_block(*, outline: dict, chapter_summaries: list[dict]) -> str:
    """把原作 outline + 章节摘要拼成提炼用的资料块(有界, 防爆上下文)。"""
    blocks: list[str] = []
    title = (outline or {}).get("title") or ""
    synopsis = (outline or {}).get("synopsis") or ""
    world = (outline or {}).get("world") or {}
    chars = (outline or {}).get("characters") or []
    ol_chapters = (outline or {}).get("chapters") or []

    if title:
        blocks.append(f"标题: {title}")
    if synopsis:
        blocks.append(f"主线: {synopsis}")
    if world:
        era = world.get("era", "")
        setting = world.get("setting", "")
        if era or setting:
            blocks.append(f"世界观: {era} | {setting}")

    if chars:
        blocks.append("\n## 人物表")
        for c in chars[:16]:
            line = f"- {c.get('name','')} ({c.get('role','')})"
            traits = "/".join(c.get("traits") or [])
            if traits:
                line += f" · 性格: {traits}"
            blocks.append(line)

    if ol_chapters:
        blocks.append("\n## 分集大纲")
        for c in ol_chapters[:80]:
            blocks.append(
                f"- 第{c.get('order')}集 「{c.get('title','')}」: {c.get('synopsis','')}"
            )

    if chapter_summaries:
        blocks.append("\n## 章节摘要(节选)")
        for c in chapter_summaries[:40]:
            s = (c.get("summary") or "").strip()
            if s:
                blocks.append(f"- 第{c.get('chapter_order')}集: {s}")

    return "\n".join(blocks)


def build_extract_dna_prompt(*, outline: dict, chapter_summaries: list[dict]) -> str:
    return EXTRACT_DNA_PROMPT.format(
        source_block=build_source_block(outline=outline, chapter_summaries=chapter_summaries)
    )


# ===========================================================================
# 2. 规划裂变方向
# ===========================================================================

_MODE_GUIDE = {
    "clone": "近似档: 保留原作的题材与故事框架, 换人名/关系/细节, 各方向之间差异较小(适合走量)。",
    "homage": "同源档(主打): 保留 DNA(爽点公式/情绪引擎/节奏), 但换全新的题材外壳、人物、事件与场景, 让每个方向都像一部独立新作, 彼此题材/切入角度明显不同。",
    "inspired": "灵感档: 只借鉴原作的情绪引擎与核心张力, 大胆重编故事线、人物设定甚至节奏, 追求'看不出是同一部剧改的', 每个方向都是全新创意。",
}

PLAN_VARIANTS_PROMPT = """你是短剧厂牌的开发总监。基于一部原作的「爆款 DNA」, 请策划出 {count} 个
**各具新意、彼此明显不同**的裂变方向, 每个方向都将被独立开发成一部完整新剧。

# 原作爆款 DNA
{dna_json}

# 裂变强度
{mode_guide}

{intent_block}{genre_constraint}

# 任务
产出 {count} 个裂变方向。它们必须:
- **共享同一套爆款 DNA**(情绪引擎/爽点公式/节奏骨架保留)
- 但题材、人物身份、核心事件、切入角度**彼此差异明显**(不要 N 个换皮雷同货)
- 每个方向都要有清晰的"一句话卖点", 让人一眼想看

# 输出(严格 JSON 数组, 不要 Markdown 包装、不要解释文字)
[
  {{
    "angle": "方向标题(如 '古装宅斗版''重生复仇版', 8字内)",
    "genre": "选定题材(从题材约束里选)",
    "pitch": "一句话卖点(30-50字, 说清这个版本主角是谁/靠什么爽点上头)",
    "twist": "本方向相比其他方向的差异化亮点(一句话)"
  }}
]

# 必须满足
- 正好 {count} 个方向, 题材/切入角度尽量分散
- 只输出 JSON 数组
"""


def build_plan_variants_prompt(
    *, dna: dict, count: int, mode: str = "homage", intent: str = ""
) -> str:
    intent_block = ""
    g = (intent or "").strip()
    if g:
        intent_block = f"# 用户创作意图(硬约束, 优先满足)\n{g}\n\n"
    return PLAN_VARIANTS_PROMPT.format(
        dna_json=json.dumps(dna or {}, ensure_ascii=False, indent=2),
        count=count,
        mode_guide=_MODE_GUIDE.get(mode, _MODE_GUIDE["homage"]),
        intent_block=intent_block,
        genre_constraint=_GENRE_CONSTRAINT,
    )


# ===========================================================================
# 3. 把裂变方向渲染成创作意图 (喂给 generate_outline_pipeline 的 user_input)
# ===========================================================================

def build_variant_brief(*, dna: dict, variant: dict, mode: str, intent: str = "") -> str:
    """把'某个裂变方向 + 共享 DNA'组织成一段创作指令, 作为大纲管线的 user_input。

    产出的是"给编剧的创作简报", 而非"逐集换皮指令" —— 这是新作能自成一体的关键。
    """
    dna = dna or {}
    v = variant or {}
    lines: list[str] = []

    lines.append(f"【题材】{v.get('genre','现代都市')}")
    lines.append(f"【创意方向】{v.get('angle','')} —— {v.get('pitch','')}")
    if v.get("twist"):
        lines.append(f"【差异化亮点】{v['twist']}")

    lines.append("\n【必须复刻的爆款基因(核心, 决定这部剧好不好看)】")
    if dna.get("hook_formula"):
        lines.append(f"- 核心爽点公式: {dna['hook_formula']}")
    if dna.get("emotional_engine"):
        lines.append(f"- 情绪引擎: {dna['emotional_engine']}")
    if dna.get("opening_hook"):
        lines.append(f"- 黄金开场做法: {dna['opening_hook']}")

    rels = dna.get("relationship_model") or []
    if rels:
        lines.append("- 关系张力模型(用新人物承载, 但张力类型保留):")
        for r in rels[:5]:
            if isinstance(r, dict):
                lines.append(f"    · {r.get('model','')}（{r.get('why_it_works','')}）")

    twists = dna.get("twist_patterns") or []
    if twists:
        lines.append(f"- 反转套路(重新设计具体事件, 保留套路类型): {', '.join(str(t) for t in twists[:6])}")

    devices = dna.get("signature_devices") or []
    if devices:
        lines.append(f"- 招牌记忆点(至少复刻其中几个): {', '.join(str(d) for d in devices[:6])}")

    beats = dna.get("beat_rhythm") or []
    if beats:
        lines.append("- 情绪节奏骨架(逐阶段贴合强度, 但用全新事件填充):")
        for b in beats:
            if isinstance(b, dict):
                lines.append(
                    f"    · [{b.get('phase','')}] {b.get('function','')} (强度 {b.get('intensity','')})"
                )

    # 裂变强度对创作自由度的指示
    if mode == "clone":
        lines.append("\n【创作自由度】近似档: 贴近原作框架, 主要更换人物与表层设定, 情节走向大体一致。")
    elif mode == "inspired":
        lines.append("\n【创作自由度】灵感档: 大胆原创。只需保留上面的情绪引擎与张力类型, 故事线/人物/桥段全部重新创作, 追求看不出改编痕迹。")
    else:
        lines.append("\n【创作自由度】同源档: 保留上面的爆款基因与情绪节奏, 但人物、事件、场景全部换新, 写成一部能独立成立的新剧, 不要照搬原作的具体情节。")

    if (intent or "").strip():
        lines.append(f"\n【用户额外要求(硬约束)】{intent.strip()}")

    lines.append("\n请据此创作一部逻辑自洽、爽点密集、情绪曲线贴合上述骨架的全新短剧。")
    return "\n".join(lines)


# ===========================================================================
# JSON 提取容错 (复用 adaptation 的健壮解析)
# ===========================================================================

def normalize_variants(raw, count: int) -> list[dict]:
    """规范化 LLM 返回的裂变方向数组, 补齐/截断到 count 个。

    补齐出来的占位方向带 `_placeholder=True` —— 调用方必须跳过它, 不要拿去跑
    整条大纲管线(那等于花一份完整大纲的钱, 换一部没有创意方向的泛泛之作)。
    """
    items: list[dict] = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            items.append({
                "angle": str(item.get("angle", "")).strip() or f"方向{len(items)+1}",
                "genre": str(item.get("genre", "")).strip() or "现代都市",
                "pitch": str(item.get("pitch", "")).strip(),
                "twist": str(item.get("twist", "")).strip(),
                "_placeholder": False,
            })
    # 补齐(标记为占位, 由调用方判定是否跳过)
    while len(items) < count:
        i = len(items)
        items.append({
            "angle": f"方向{i+1}",
            "genre": "现代都市",
            "pitch": "(方向规划输出不足, 已用默认占位)",
            "twist": "",
            "_placeholder": True,
        })
    return items[:count]


__all__ = [
    "build_source_block",
    "build_extract_dna_prompt",
    "build_plan_variants_prompt",
    "build_variant_brief",
    "normalize_variants",
]