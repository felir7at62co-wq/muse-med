"""这一集用哪段文字 —— 全项目唯一的事实来源。

## 要解决的事（2026-10-10 审计）

审计发现"这一集给模型喂什么"在 **13 个文件里各实现了一遍**，且质量不一：

    正文生成前情      chapter_gen._build_rolling_memory   → 原文（对）
    分镜邻集          episode_render.collect_neighbor_*   → 原文（对）
    对话上下文        context_loader._episode_text        → 摘要
    按意见重写        router.py:1383 prev_summary         → 摘要
    续写 L2/L3        continuation_prompts                → 摘要 + 最近几集
    改编蓝图          adaptation_prompts                  → 摘要，且只取 30 集
    ... 另有 7 处

同一部剧、同一集，走不同路径拿到**不同的文字** —— 于是"AI 手里那份稿子"
取决于用户点的是哪个按钮。这是剧情偏移类问题反复复发的结构性原因：
每修一处只治好一个器官，下次从另一个入口进来又中招。

## 全库数据（说明问题有多大）

    7892 章实测：
      真实摘要          4072 章（52%）
      截断·正文前500字  2319 章（29%）  ← summary 字段里装的是正文前缀
      summary 为空      1415 章（18%）  ← 对话里这一集**完全不可见**
    平均可见度 32.2%；5186 章（66%）可见度低于 30%

## 设计（用户 2026-10-10 三条裁定）

**裁定 1：文本预算按模型窗口算，比例按本模块的分配器设计。**
**裁定 2："保底字数"= 摘要失败时兜底**这一集的**全文**，不是留空。**
        用户原话："如果保底字数是指摘要失败情况下的兜底，那这个保底字数
        应该是这一集的全文。"
**裁定 3：收拢调用点。** 13 处全部改走本模块。

### 表示形式与降级梯

    全文 FULL  <  裁剪 CLIPPED  <  真摘要 SUMMARY  <  大纲梗概 SYNOPSIS

用户已核实窗口口径"稳定 70 万"，而全库最大剧本 550,161 字 —— **全文装得下**。
所以梯子是「**全文优先，摘要是长剧兜底**」，不是"默认摘要省空间"。

⚠️ **"空"不在梯子上。** 这是本模块与前身 `_synopsis_fallback` 最重要的差别：
那条路径取不到东西时返回 `""`，模型于是**以为这一集不存在**、直接开编，
而用户从上下文里看不出缺了什么。宁可给大纲梗概，也不给空。

### 截断方向比截断本身更决定伤害

    continuity（前情/衔接）→ 保**尾**：要的是"演到哪"，尾部离本集最近
    lookahead（下一集）    → 保**头**：本集要往它那里去
    named（用户点名）      → 保头+保尾：要细节，两头都留
    overview（全剧概览）   → 真摘要优先：这类问题只要"讲了什么"

### 可信性校验（挡存量假摘要，不需要回填）

`is_trustworthy_summary` 判定一个 summary 到底是"整集概要"还是"正文前缀"。
存量 2319 条假摘要因此**自动降级走全文**，无需回填、无需改数据 ——
符合用户"旧的已经错的草稿都不管"的要求：旧数据不被修，但也不再被误当摘要用。
"""
from __future__ import annotations

import logging
import re
from typing import Any, Iterable

logger = logging.getLogger("episode_text")

# ---------------------------------------------------------------------------
# 表示形式
# ---------------------------------------------------------------------------

FULL = "full"           # 全文
CLIPPED = "clipped"     # 裁剪（显式标注断点）
SUMMARY = "summary"     # 真摘要
SYNOPSIS = "synopsis"   # 大纲梗概（计划态）


#: 判定"这是一整篇正文而不是摘要"的比例：摘要长度 / 正文长度。
#:
#: ⚠️ **这个判据的方向很容易搞反，务必看清**：
#:
#:   真摘要     200-300 字压 5000 字正文 ≈  4-6%
#:   截断 500   500 字压 1600 字正文   ≈  31%
#:   截断 200   200 字压 1600 字正文   ≈  12%
#:
#: 截断的**比例反而更高**（它按固定字数切，正文越短占比越大）。
#: 所以"比例低"绝不能当成"是截断"的证据 —— 那会把真摘要全部误杀
#: （本模块初版就犯了这错，实测真摘要被判 False）。
#:
#: 比例只能反向用：占比**接近 1** 说明这段"摘要"其实就是整篇正文，
#: 那它也不是摘要。识别截断靠的是前缀判据，不是比例。
_WHOLE_TEXT_RATIO = 0.85

#: 判定"是不是正文前缀"时取多少字符比对。取前 40 字：
#: 短于这个长度，中文里撞车概率偏高。
_PREFIX_PROBE = 40


def is_trustworthy_summary(summary: str | None, full_text: str | None) -> bool:
    """这个 summary 是"整集概要"还是"正文前缀/整篇正文"？

    **纯函数、零成本、无 IO。** 这是本模块能在不改任何数据的前提下
    挡掉存量 2319 条假摘要的机制。

    返回 False 的三种情形：
      1. 空 —— 没有摘要，不是摘要；
      2. **是正文的前缀** —— 那是截断（`content[:500]` 的产物），
         读起来像开头却标着"摘要"，会让模型以为整集就讲了这些；
      3. 几乎等于正文全长 —— 那也不是摘要。

    ⚠️ 判据 2 是主力且**唯一可靠**的：库里的假摘要都是
    `summary = full_text[:N]` 直接切出来的，前 40 字必然逐字相同。
    判据 3 是兜底，正常永不触发。
    """
    s = (summary or "").strip()
    if not s:
        return False
    f = (full_text or "").strip()
    if not f:
        # 没有正文可比对（如凭大纲直生），只能信它
        return True
    probe = s[:_PREFIX_PROBE]
    if len(probe) >= 8 and f.startswith(probe):
        return False
    if len(s) >= len(f) * _WHOLE_TEXT_RATIO:
        return False
    return True


# ---------------------------------------------------------------------------
# 裁剪
# ---------------------------------------------------------------------------

def _clip_head(text: str, limit: int) -> str:
    return text[:limit] + "\n…（后文略）"


def _clip_tail(text: str, limit: int) -> str:
    return "…（前文略）\n" + text[-limit:]


def _clip_both(text: str, limit: int) -> str:
    """保头 + 保尾，中间挖掉。两头都是衔接价值最高的部分。"""
    if limit < 200:
        return _clip_head(text, limit)
    head = int(limit * 0.55)
    tail = limit - head
    return f"{text[:head]}\n…（中间略）…\n{text[-tail:]}"


#: `keep` 的取值 → 裁剪函数
_CLIPPERS = {"head": _clip_head, "tail": _clip_tail, "both": _clip_both}


def clip(text: str, limit: int, *, keep: str = "tail") -> str:
    """裁到 limit 字符，**显式标注断点**。

    为什么不直接 `text[:limit]`：那样模型不知道后面还有内容，会把
    "这就是全部"当事实。标注断点等于告诉它"这里被裁了"。
    （沿用 `episode_render._clip_neighbor` 的既有做法。）
    """
    t = (text or "").strip()
    if len(t) <= limit or limit <= 0:
        return t
    return _CLIPPERS.get(keep, _clip_tail)(t, limit)


# ---------------------------------------------------------------------------
# 主体：决定这一集用什么、以及要不要裁
# ---------------------------------------------------------------------------

#: 各用途的**取数来源优先级** + 裁剪方向。
#:
#: ⚠️ 梯子上列的是"**从哪段文字取**"（全文 / 摘要 / 大纲梗概），
#: **不是"要不要裁"** —— 预算裁剪是取到之后无条件施加的一步。
#: 初版把 CLIPPED 当成梯子的一级，结果 `FULL` 排在它前面，
#: 预算被整个绕过（实测 budget=300 却返回 1320 字全文）。现按来源划分。
#:
#: 方向说明：
#:   · continuity（前情/衔接）→ 保**尾**：要的是"演到哪"，尾部离本集最近
#:   · lookahead（下一集）    → 保**头**：本集要往它那里去
#:   · named（用户点名）      → 保头+保尾：要细节，两头都留
#:   · overview（全剧概览）   → 真摘要优先：这类问题只要"讲了什么"（舍弃摘要
#:                              在这里并不成立 —— 它仍是首选）
_LADDERS: dict[str, dict] = {
    "continuity": {"keep": "tail",
                   "sources": [FULL, SUMMARY, SYNOPSIS]},
    "lookahead":  {"keep": "head",
                   "sources": [FULL, SUMMARY, SYNOPSIS]},
    "named":      {"keep": "both",
                   "sources": [FULL, SUMMARY, SYNOPSIS]},
    "overview":   {"keep": "head",
                   "sources": [SUMMARY, FULL, SYNOPSIS]},
}


def _candidates(ep: dict, ch: Any) -> dict[str, str]:
    """从 ORM 行 / 大纲条目里取出各形式的原文。

    ⚠️ `ch` 可能是 None（该集还没正文）、也可能是任意带 `summary`/`full_text`
    的对象（ORM 行、dict 包装）。两条都要能取。
    """
    full = _get(ch, "full_text") or ""
    summ = _get(ch, "summary") or ""
    syn = str((ep or {}).get("synopsis") or "").strip()
    return {"full": full.strip(), "summary": summ.strip(), "synopsis": syn}


def _get(obj: Any, key: str) -> str:
    """从 ORM 行或 dict 里取字段。"""
    if obj is None:
        return ""
    if isinstance(obj, dict):
        return str(obj.get(key) or "")
    return str(getattr(obj, key, "") or "")


def pick_episode_text(
    ep: dict | None,
    ch: Any = None,
    *,
    purpose: str = "continuity",
    budget_chars: int = 4_000,
) -> tuple[str, str]:
    """决定这一集给模型看哪段文字。

    返回 `(text, form)`；`form` 供调用方留痕/调试（不要在 prompt 里暴露）。

    `ep`  大纲条目（提供 synopsis / order / title）
    `ch`  章节行（提供 full_text / summary），可为 None
    `budget_chars` 这一集分到的字符额度

    两步，顺序不能颠倒：
      1. **按 purpose 的来源优先级**挑一段文字（全文 > 真摘要 > 大纲梗概）；
      2. **无条件施加预算**：装得下就原样给，装不下就裁剪并标注断点。

    ⚠️ **永不返回空串**（除非三条来源全没有，那也确实无话可说）。
    这是本模块的核心承诺：宁可给大纲梗概，也不给空 ——
    空会让模型以为这一集不存在并开始编造，而用户无从察觉。
    """
    cands = _candidates(ep or {}, ch)
    spec = _LADDERS.get(purpose) or _LADDERS["continuity"]
    keep = spec["keep"]

    for form in spec["sources"]:
        if form == FULL:
            raw = cands["full"]
        elif form == SUMMARY:
            # 假摘要不算摘要 —— 跳过，让梯子落到全文
            raw = cands["summary"] if is_trustworthy_summary(
                cands["summary"], cands["full"]) else ""
        else:  # SYNOPSIS
            raw = cands["synopsis"]

        if not raw:
            continue
        if len(raw) <= budget_chars:
            return raw, form
        return clip(raw, budget_chars, keep=keep), CLIPPED

    return "", "none"


# ---------------------------------------------------------------------------
# 预算分配：一轮里给多集分额度
# ---------------------------------------------------------------------------

#: 每集在任何情况下都至少拿到这么多字符（约等于一条真摘要的长度）。
#:
#: 用户裁定 2 的落实点：**任何一集都不许因为预算不足而消失**。
#: 注意这与"摘要失败兜底用全文"是两件事 —— 前者是**分配**下限，
#: 后者是**取不到摘要时的降级目标**。两者共同保证"不会有一集是空的"。
MIN_PER_EPISODE_CHARS = 400

#: 点名的集相对普通集的权重倍数。
_NAMED_WEIGHT = 3.0
#: 邻集相对普通集的权重倍数。
_NEIGHBOR_WEIGHT = 2.0


def allocate(total_budget: int, orders: Iterable[int], *,
             named: Iterable[int] = (), neighbors: Iterable[int] = (),
             count: int | None = None) -> dict[int, int]:
    """把总预算分给若干集，返回 `{集号: 该集的字符额度}`。

    分配遵循三条：
      1. **先扣保底**：每集先留 `MIN_PER_EPISODE_CHARS`，谁都拿得到；
      2. **余下按优先级加权**：点名集 > 邻集 > 其他集；
      3. **总量不超过预算**：`count` 集数过大时，保底本身就可能超预算 ——
         此时**按集均分**（而不是让后面的集归零），保证"每集都有份"。

    这不是平均主义：优先级高的集拿得多。但它保证低的集**不是零**。
    """
    ords = sorted({int(o) for o in orders})
    if count is not None and count < len(ords):
        ords = ords[:count]
    if not ords:
        return {}

    named_s = {int(x) for x in named}
    nb_s = {int(x) for x in neighbors}

    # 预算连保底都覆盖不了 → 均分，谁也别归零
    floor_total = MIN_PER_EPISODE_CHARS * len(ords)
    if total_budget <= floor_total:
        each = max(1, total_budget // len(ords))
        return {o: each for o in ords}

    surplus = total_budget - floor_total
    weights = []
    for o in ords:
        if o in named_s:
            weights.append(_NAMED_WEIGHT)
        elif o in nb_s:
            weights.append(_NEIGHBOR_WEIGHT)
        else:
            weights.append(1.0)
    wsum = sum(weights) or 1.0

    out: dict[int, int] = {}
    for o, w in zip(ords, weights):
        out[o] = MIN_PER_EPISODE_CHARS + int(surplus * w / wsum)
    return out


def render_episode_block(
    ep: dict | None,
    ch: Any = None,
    *,
    purpose: str = "continuity",
    budget_chars: int = 4_000,
    label: str | None = None,
) -> str:
    """渲染成 prompt 里的一段（带集号标题）。

    没有内容时返回空串 —— 让调用方决定要不要写占位。
    （本模块不产出"（无）"这类占位：调用方更清楚那句话该怎么措辞。）
    """
    text, form = pick_episode_text(ep, ch, purpose=purpose,
                                   budget_chars=budget_chars)
    if not text.strip():
        return ""
    order = (ep or {}).get("order") if isinstance(ep, dict) else None
    title = str(((ep or {}).get("title") if isinstance(ep, dict) else "") or "").strip()
    head = label or (f"第{order}集" if order else "")
    if title and head and title not in head:
        head = f"{head}「{title}」"
    # ⚠️ 形式不写进 prompt：模型不需要知道"这段是摘要还是全文"，
    #    知道了反而可能对摘要型内容降低要求。form 只给调用方留痕用。
    return f"{head}\n{text}" if head else text


__all__ = [
    "FULL", "CLIPPED", "SUMMARY", "SYNOPSIS",
    "is_trustworthy_summary", "clip",
    "pick_episode_text", "allocate", "render_episode_block",
    "MIN_PER_EPISODE_CHARS",
]
