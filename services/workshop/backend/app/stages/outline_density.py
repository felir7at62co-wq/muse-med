"""outline_density — 大纲「可生成度」判据（这是**唯一**事实来源）。

## 为什么需要它（2026-10-09 用户提问）

> "当用户导入大纲或原文时，此时大纲往往是缺失甚至空白的，或者结构不像我们
>   设计的这么严谨。有时用户导入的大纲信息量过少，导致生成剧本时 AI 还是会
>   胡乱编造。该怎么办？"

诊断时实测：**51 字梗概 → 4423 字剧本**（87 倍）。这不是模型不听话，
是用户给的东西确实撑不起一集，而我们**从来没有告诉过用户这件事**。

dev 库 370 部有大纲的草稿实测分布：

| 情形 | 数量 | 直接生成剧本会怎样 |
|---|---|---|
| 有正文 | 201 | 从正文**转写**，不会编 ✅ |
| 只有剧本、无正文 | 133 | 剧本本身就是"大纲直生"编出来的，但**可从成品据实反推** |
| 只有大纲 | 36 | 从一句梗概直接写几千字 —— ⚠️ 就是这一批在编 |

其中导入的大纲普遍是这个厚度：

    矿 591? 不 —— 实测：651 = 55 字/集、656 = 95、652 = 97、655 = 100、653 = 107

## 判据（刻意保守：宁可漏报，不可误报）

逐集分档，**先看有没有"不必编"的东西**，再退而看大纲本身够不够厚：

    text        有正文      → 剧本是转写，不会编
    storyboard  有剧本      → 重生成仍是直生，但可据实反推补厚
    structured  有 beats，或 must_have ≥ 2 条，或契约齐备  → 有"可演的下一层"
    fair        仅梗概且 ≥ 120 字
    thin        仅梗概且 < 120 字   → ⚠️ 会大幅补写

### `120 字` 这个阈值怎么来的
不是拍脑袋：实测导入的薄大纲落在 55~107 字，而 AI 从零生成的大纲是 100~200 字
（`outline_gen` 首批 prompt 明写"本集 100-200 字概要"）。120 是"明显低于我们
自己的生成标准"那条线 —— **只在用户的东西比我们自己的产出还薄时才提醒**，
不拿我们的标准去苛责用户的正常输入。

### 为什么不用"密度/爽点数"这类更精细的判据
因为做不到可靠判定，而**误报会训练用户忽略提醒**。`must_have ≥ 2` 这类计数是
可验证的；"这一集够不够精彩"不可验证。本仓已有教训：`drama_gate` 对老数据
一律只报 warn、绝不报 error，就是为了避免刷屏。

## 与其它判据的关系（**别再造第四套**）
已有的、本模块**不替代**：
  · `drama_gate._has_contract` / `contract_incomplete` —— 「有没有契约字段」
  · `drama_gate._check_beats_presence` / `beats_missing` —— 「有没有节拍」
  · `settings_backfill._CONTRACT_KEYS` —— 「反推时哪些键算已填」
  · 前端 `_ContractFold.hasContract` / `DraftSettingsPanel.emptyBlocks`
本模块回答的是另一个问题：**「照现在这份大纲去生成剧本，用户会拿到多少 AI 自己加的东西」**。
"""
from __future__ import annotations

import logging

from sqlalchemy import select

logger = logging.getLogger(__name__)

#: 只有梗概时，低于这个字数就认为"撑不起一集剧本"。理由见模块 docstring。
THIN_SYNOPSIS_CHARS = 120

#: 分档常量（前端/接口直接拿它做判断，别在别处硬编码字符串）
TIER_TEXT = "text"
TIER_STORYBOARD = "storyboard"
TIER_STRUCTURED = "structured"
TIER_FAIR = "fair"
TIER_THIN = "thin"

#: 分档 → 人话。前后端共用，别再各写一份文案。
TIER_LABEL = {
    TIER_TEXT: "有正文（剧本按原文转写，不会自行编造）",
    TIER_STORYBOARD: "已有剧本（可据此反推更细的大纲）",
    TIER_STRUCTURED: "结构完整（有场景节拍或契约）",
    TIER_FAIR: "信息一般（只有分集梗概）",
    TIER_THIN: "信息量偏低（只有很短的梗概）",
}


def _synopsis_of(ep: dict) -> str:
    if not isinstance(ep, dict):
        return ""
    return str(ep.get("synopsis") or ep.get("summary") or "").strip()


# ---------------------------------------------------------------------------
# 「骨架大纲」—— 不是大纲，是导入时零 LLM 生成的占位结构
# ---------------------------------------------------------------------------

#: 导入路径写进 `outline.synopsis` 的固定占位符（四条导入路径共用这一个串）。
SKELETON_MARKER = "(从已有剧本导入)"

#: 骨架每集 synopsis = 正文前 200 字硬切（`ch["content"][:200]`）。
SKELETON_CHUNK_CHARS = 200


def is_skeleton_outline(outline: dict | None) -> bool:
    """这份 outline 是**导入骨架**而不是真大纲。

    ## 为什么需要这个判据（2026-10-24）

    生产用户反馈"Agent 读的大纲不是大纲"。查下来不是读取 bug —— 数据本身就是
    骨架：导入时按 2026-09-22 的裁定（导入 = 纯原文落库、零模型调用）只建
    `title/order/synopsis`，其中每个 `synopsis` 是**正文前 200 字硬切**，
    顶层 `synopsis` 是固定占位符。

    设计上这是对的（v2 左侧树由 outline.chapters 驱动，不建骨架就"一集都看不到"），
    但**没有任何地方告诉读取方"这不是大纲"**：字段名就叫 synopsis，
    Agent 于是把它当梗概用，据此判断剧情、据此提修改意见。

    dev 库实测：139 部带标记的草稿里，3508/5678 集的 synopsis 长度**正好等于 200**，
    且大量是从句子中间硬断的。

    判据取"顶层占位符"或"过半集是 200 字整"——两者都是导入路径的特征，
    而**从零生成的大纲不可能命中**（它的 synopsis 是模型写的 100-200 字，
    长度随机分布；且顶层 synopsis 是真实主线描述）。
    """
    o = outline or {}
    if str(o.get("synopsis") or "").strip() == SKELETON_MARKER:
        return True
    eps = [e for e in (o.get("chapters") or []) if isinstance(e, dict)]
    if not eps:
        return False
    exact = sum(1 for e in eps if len(_synopsis_of(e)) == SKELETON_CHUNK_CHARS)
    return exact * 2 > len(eps)


def _is_structured(ep: dict) -> bool:
    """这一集有没有"可演的下一层"（够厚的正文 / 扎实的必备情节点 / 齐备契约）。

    ⚠️ 与 `drama_gate._has_contract` **口径不同、故意不复用**：那个问"有没有契约
    字段"（用于跳过跨集检查），这个问"够不够撑起生成"。一个只有 `stakes` 的集
    在那边算"有契约"，在这里仍然撑不起一集 —— 两者会各自演化。

    2026-11-07：beats 取消后，第一条判据换成**正文厚度**。新版大纲的正文就是
    要素块（【开场卡点】【冲突】…【结尾钩子】），一集三四百字；
    `THIN_SYNOPSIS_CHARS` 那条线本来就是"比我们自己的产出还薄才提醒"，
    要素制正文天然远高于它。老数据里带 beats 的集仍然算 structured
    （它们确实有可演的下一层），所以这条判断对老草稿行为不变。
    """
    if not isinstance(ep, dict):
        return False
    beats = ep.get("beats")
    if isinstance(beats, list) and beats:
        return True
    if len(_synopsis_of(ep)) >= THIN_SYNOPSIS_CHARS:
        return True
    mh = ep.get("must_have")
    if isinstance(mh, list) and len([x for x in mh if str(x or "").strip()]) >= 2:
        return True
    # 契约齐备（三个关键字段都在）也算 —— 那种集虽然没节拍，但至少有推进点、
    # 代价、钩子三件事约束着模型，不属于"随便编"。
    core = str(ep.get("core_push") or "").strip()
    st = str(ep.get("stakes") or "").strip()
    ho = ep.get("hook_out") or {}
    return bool(core and st and isinstance(ho, dict) and str(ho.get("leads_to") or "").strip())


def assess_chapters(
    outline: dict,
    *,
    have_text: set[int] | None = None,
    have_storyboard: set[int] | None = None,
    start: int = 0,
    end: int = 0,
) -> dict:
    """对 `outline["chapters"]` 做可生成度分档。**零 LLM、零 IO**（调用方喂集合）。

    have_text / have_storyboard: 已有正文 / 已有剧本的集号集合。
    start/end: 只看这一段（含端点）；0 表示不限。

    返回：
      {
        "total": 范围内集数,
        "counts": {tier: n},
        "orders": {tier: [集号]},
        "avg_synopsis": 平均梗概字数,
        "thin_ratio": 偏薄占比,
        "should_confirm": 生成前是否值得拦一下,
        "advice": ["人话建议", ...],
      }
    """
    have_text = have_text or set()
    have_storyboard = have_storyboard or set()
    eps = [e for e in (outline.get("chapters") or []) if isinstance(e, dict)]

    def _in_scope(e: dict) -> bool:
        o = int(e.get("order") or 0)
        if start and o < start:
            return False
        if end and o > end:
            return False
        return True

    eps = [e for e in eps if _in_scope(e)]
    orders: dict[str, list[int]] = {t: [] for t in TIER_LABEL}
    lens: list[int] = []
    for e in eps:
        o = int(e.get("order") or 0)
        syn = _synopsis_of(e)
        if syn:
            lens.append(len(syn))
        # ⚠️ 顺序即优先级：有正文的集**永远**归 text，哪怕大纲很薄 ——
        # 因为它走的是"转写正文"的路，编不了。
        if o in have_text:
            t = TIER_TEXT
        elif o in have_storyboard:
            t = TIER_STORYBOARD
        elif _is_structured(e):
            t = TIER_STRUCTURED
        elif len(syn) >= THIN_SYNOPSIS_CHARS:
            t = TIER_FAIR
        else:
            t = TIER_THIN
        orders[t].append(o)

    total = len(eps)
    counts = {t: len(v) for t, v in orders.items()}
    thin_ratio = (counts[TIER_THIN] / total) if total else 0.0

    # 只有"真的会编"的那两档值得拦：thin。
    # fair 不拦（用户给了 120+ 字，是他正常水平的输入，拦了就是骚扰）。
    should_confirm = counts[TIER_THIN] > 0

    advice: list[str] = []
    if counts[TIER_THIN]:
        shown = "、".join(f"第{o}集" for o in orders[TIER_THIN][:8])
        more = f" 等 {counts[TIER_THIN]} 集" if counts[TIER_THIN] > 8 else ""
        advice.append(
            f"{shown}{more}的大纲信息量偏低（平均 "
            f"{round(sum(lens) / len(lens)) if lens else 0} 字/集）。"
            f"直接生成剧本时，这些集会有相当一部分情节由 AI 自行补写 —— "
            f"补出来的内容不在你的大纲里。"
        )
        advice.append("建议先「补全本集大纲」：把梗概扩写成场景节拍，你过一眼、"
                      "改一改再生成，写出来的就是你要的戏。")
    if counts[TIER_FAIR] and not counts[TIER_THIN]:
        advice.append("这些集只有分集梗概、没有场景节拍。生成剧本时会有细节由 AI 补写，"
                      "精度不如有节拍的大纲；如在意可先「补全本集大纲」。")
    if counts[TIER_FAIR] and counts[TIER_THIN]:
        advice.append(f"另有 {counts[TIER_FAIR]} 集只有分集梗概，同样建议先补全大纲。")
    if counts[TIER_STORYBOARD] and not counts[TIER_THIN] and not counts[TIER_FAIR]:
        advice.append("已有剧本的集可以「从已有剧本反推」补出契约与节拍，"
                      "之后重做时就有依据了。")

    return {
        "total": total,
        "counts": counts,
        "orders": orders,
        "avg_synopsis": round(sum(lens) / len(lens)) if lens else 0,
        "thin_ratio": round(thin_ratio, 3),
        "should_confirm": should_confirm,
        "advice": advice,
        "labels": TIER_LABEL,
    }


async def assess_draft(draft_id: int, *, start: int = 0, end: int = 0) -> dict:
    """带 DB 查库的版本：自动判断哪些集已有正文 / 已有剧本。"""
    from ..db import ScriptChapter, ScriptDraft, ScriptStoryboard, session_scope

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"total": 0, "counts": {}, "orders": {}, "avg_synopsis": 0,
                    "thin_ratio": 0.0, "should_confirm": False,
                    "advice": ["草稿不存在"], "labels": TIER_LABEL}
        outline = dict(d.outline or {})
        have_text = {int(r.chapter_order) for r in (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
        )).scalars().all() if (r.full_text or "").strip()}
        have_sb = {int(r.chapter_order) for r in (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
        )).scalars().all() if r.shots_json}

    return assess_chapters(outline, have_text=have_text, have_storyboard=have_sb,
                           start=start, end=end)


__all__ = [
    "THIN_SYNOPSIS_CHARS", "TIER_TEXT", "TIER_STORYBOARD", "TIER_STRUCTURED",
    "TIER_FAIR", "TIER_THIN", "TIER_LABEL", "assess_chapters", "assess_draft",
    "SKELETON_MARKER", "SKELETON_CHUNK_CHARS", "is_skeleton_outline",
]
