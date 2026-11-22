"""场景卡（Scene Cards）—— 一场一张卡。

## 定位

场景卡是 beat sheet 与剧本之间的中间层：

    beat sheet（beats）         → 一拍一行，只有"发生了什么"
    scene_cards（本模块）       → 每张卡补上**意图**与**障碍**，让生成知道"为什么这样演"
    剧本（storyboard）          → 完整台词与动作描写

没有场景卡时，剧本生成要从"一句话概要"直接飞到 5000 字，中间"演什么、为什么这样演"
的决策层是空着的，模型只能自己补 —— 这是模型经常编大纲里没有的内容的机制性来源。

## 生成路径

1. **从 beats 派生（零 LLM）**：机械提取，立刻可用，适合已有 beats 的集。
2. **LLM 扩展（可选）**：在派生卡基础上补 `intent` / `obstacle`，成本约 0.5k token/集。

## 字段

每张卡：
    card_no     : int          # 1 起
    at          : str          # 地点+时间（与 beat 同义）
    who         : str          # 在场人物
    intent      : str          # 这一拍的主要人物想要什么（动机层）
    obstacle    : str          # 阻止他/她得到的是什么
    action      : str          # 发生了什么（能被拍出来）
    turn        : str          # 这一拍结束时局面/认知变成了什么
    drama_role  : str          # "爽点"|"钩子"|"埋伏笔"|"收伏笔"|"推进"|""

## 存储

场景卡放在集纲集的 `scene_cards` 字段里，类型 `list[dict]`。
集纲不存库（不是单独表），场景卡也随之落进 `ScriptDraft.outline.chapters[N].scene_cards`。
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("scene_card")

#: 场景卡全部字段名（落库时用白名单过滤）
CARD_FIELDS = ("card_no", "at", "who", "intent", "obstacle", "action", "turn", "drama_role")


def _s(v: Any) -> str:
    """安全取字符串。"""
    return str(v or "").strip()


# ---------------------------------------------------------------------------
# 路径 1：从 beats 零成本派生
# ---------------------------------------------------------------------------

def derive_from_beats(ep: dict) -> list[dict]:
    """从一集的 `beats` 派生场景卡列表（零 LLM 调用）。

    补规则：
    - `intent` / `obstacle` 留空（供后续 LLM 扩展）
    - `drama_role` 按集纲契约字段自动推断：
        · 本集 `payoff_moment` 文本在某一拍的 action/turn 里出现 → "爽点"
        · 最后一拍 → "钩子"（通常 hook_out 就是最后一拍产生的卡点）
        · 本集 `plant` 里的道具/台词明确出现在 action 里 → "埋伏笔"
        · 本集 `payoff`（回收伏笔）文本出现 → "收伏笔"
        · 其余 → "推进"
    """
    beats = ep.get("beats") or []
    if not beats:
        return []

    payoff_moment = _s(ep.get("payoff_moment")).lower()
    plants = [_s(x).lower() for x in (ep.get("plant") or []) if _s(x)]
    payoffs = [_s(x).lower() for x in (ep.get("payoff") or []) if _s(x)]
    n = len(beats)

    cards: list[dict] = []
    for i, b in enumerate(beats, 1):
        if isinstance(b, str):
            b = {"action": b}
        if not isinstance(b, dict):
            continue
        at = _s(b.get("at") or b.get("where") or b.get("location"))
        who = _s(b.get("who") or b.get("characters"))
        action = _s(b.get("action") or b.get("what") or b.get("beat"))
        turn = _s(b.get("turn") or b.get("result") or b.get("shift"))

        # drama_role 推断
        combined = (action + " " + turn).lower()
        role = ""
        if payoff_moment and payoff_moment[:10] in combined:
            role = "爽点"
        elif i == n:
            role = "钩子"
        elif any(p[:8] in combined for p in plants if len(p) >= 4):
            role = "埋伏笔"
        elif any(p[:8] in combined for p in payoffs if len(p) >= 4):
            role = "收伏笔"
        else:
            role = "推进"

        cards.append({
            "card_no": i,
            "at": at,
            "who": who,
            "intent": "",          # 留给 LLM 扩展
            "obstacle": "",        # 留给 LLM 扩展
            "action": action,
            "turn": turn,
            "drama_role": role,
        })
    return cards


def cards_for_episode(outline: dict, order: int) -> list[dict]:
    """取出某集的场景卡（如果已存在）；否则从 beats 实时派生（不写回）。"""
    ep = next((c for c in (outline.get("chapters") or [])
               if int(c.get("order") or 0) == int(order)), None)
    if not isinstance(ep, dict):
        return []
    existing = ep.get("scene_cards")
    if isinstance(existing, list) and existing:
        return existing
    return derive_from_beats(ep)


def write_cards_to_episode(outline: dict, order: int,
                           cards: list[dict]) -> bool:
    """把场景卡写回 outline 里对应的集（原地修改，返回是否找到了那集）。"""
    for ep in (outline.get("chapters") or []):
        if int(ep.get("order") or 0) == int(order):
            ep["scene_cards"] = [
                {k: c.get(k, "") for k in CARD_FIELDS}
                for c in cards if isinstance(c, dict)
            ]
            return True
    return False


# ---------------------------------------------------------------------------
# 路径 2：LLM 扩展（补 intent / obstacle）
# ---------------------------------------------------------------------------

_EXPAND_PROMPT = """你是资深短剧导演。下面是第 {order} 集《{title}》的场景卡草稿，
`intent` 和 `obstacle` 还是空的。请逐卡补全这两个字段：

- `intent`：**本场核心人物**（通常是主角或主要对手）在这一场想要得到什么、做到什么，
  一句话，写成"想要……"的主动句。
- `obstacle`：**阻止他/她**在这一场达成 intent 的是什么（人、信息差、物理障碍、自己的限制），
  一句话，写成"但是……"的句式。

**要求：**
- 照抄除 intent/obstacle 外的所有字段，不要增删场次，不要修改 action/turn。
- 输出格式和输入相同（分块文本），每张卡：

卡号：N
地点时间：……
在场人物：……
意图：……（新填）
障碍：……（新填）
动作：……
转折：……
戏剧功能：……

---

集纲背景（仅供参考）：
{context_block}

---

场景卡草稿：
{cards_text}

只输出场景卡，不要任何解释。
"""


def _cards_to_text(cards: list[dict]) -> str:
    lines = []
    for c in cards:
        lines.append(f"卡号：{c.get('card_no', '')}")
        lines.append(f"地点时间：{c.get('at', '')}")
        lines.append(f"在场人物：{c.get('who', '')}")
        lines.append(f"意图：{c.get('intent', '')}")
        lines.append(f"障碍：{c.get('obstacle', '')}")
        lines.append(f"动作：{c.get('action', '')}")
        lines.append(f"转折：{c.get('turn', '')}")
        lines.append(f"戏剧功能：{c.get('drama_role', '')}")
        lines.append("")
    return "\n".join(lines).strip()


def _parse_cards_text(text: str) -> list[dict]:
    """把 LLM 返回的分块文本解析回 list[dict]。"""
    import re
    _FLD = re.compile(r"^(?P<k>[^：:]{1,8})\s*[：:]\s*(?P<v>.*)$")
    _MAP = {
        "卡号": "card_no", "地点时间": "at", "在场人物": "who",
        "意图": "intent", "障碍": "obstacle", "动作": "action",
        "转折": "turn", "戏剧功能": "drama_role",
    }
    cards: list[dict] = []
    cur: dict = {}
    for ln in text.split("\n"):
        line = ln.strip()
        if not line:
            if cur:
                cards.append(cur)
                cur = {}
            continue
        m = _FLD.match(line)
        if not m:
            continue
        k, v = m.group("k").strip(), m.group("v").strip()
        if k in _MAP:
            key = _MAP[k]
            if key == "card_no":
                try:
                    cur[key] = int(v)
                except ValueError:
                    cur[key] = v
            else:
                cur[key] = v
    if cur:
        cards.append(cur)
    return cards


async def expand_cards_with_llm(
    ep: dict, cards: list[dict], provider: str = "gemini"
) -> list[dict]:
    """用 LLM 补全 intent / obstacle。

    失败时静默回退到原始卡（intent/obstacle 为空），不阻断主流程。
    """
    from ..models.llm import get_llm

    order = ep.get("order", 0)
    title = ep.get("title", f"第{order}集")
    synopsis = str(ep.get("synopsis") or "").strip()
    core_push = str(ep.get("core_push") or "").strip()
    context_lines = []
    if synopsis:
        context_lines.append(f"本集概要：{synopsis[:200]}")
    if core_push:
        context_lines.append(f"本集核心推进：{core_push}")
    context_block = "\n".join(context_lines) or "（无）"

    prompt = _EXPAND_PROMPT.format(
        order=order, title=title,
        context_block=context_block,
        cards_text=_cards_to_text(cards),
    )
    try:
        llm = get_llm("generate", temperature=0.4, provider=provider)
        resp = await llm.ainvoke(prompt)
        raw = (getattr(resp, "content", "") or "").strip()
        expanded = _parse_cards_text(raw)
        if len(expanded) == len(cards):
            # 合并：只更新 intent/obstacle，其余字段用原来的
            merged = []
            for orig, exp in zip(cards, expanded):
                c = dict(orig)
                c["intent"] = _s(exp.get("intent"))
                c["obstacle"] = _s(exp.get("obstacle"))
                merged.append(c)
            return merged
        logger.warning("expand_cards_with_llm: 卡数不符（期望 %d，得到 %d），回退",
                       len(cards), len(expanded))
    except Exception as e:  # noqa: BLE001
        logger.warning("expand_cards_with_llm 失败，使用原始卡: %s", e)
    return cards


# ---------------------------------------------------------------------------
# 渲染：供生成剧本时注入
# ---------------------------------------------------------------------------

def build_scene_cards_block(outline: dict, chapter_order: int) -> str:
    """把场景卡渲染成给生成模型看的文本块。

    不替代 `build_beats_block`，而是补充：beats 给的是"演哪几拍"，
    场景卡额外给出"为什么这样演（意图与障碍）"。
    intent/obstacle 为空时这一段就不出现（等同于没有场景卡）。
    """
    cards = cards_for_episode(outline, chapter_order)
    if not cards:
        return ""

    # 只有至少一张卡有 intent 才值得输出
    if not any(c.get("intent") for c in cards):
        return ""

    lines = ["【本集场景卡（每场意图与障碍，帮助决定台词给谁说、怎么推进）】"]
    for c in cards:
        intent = _s(c.get("intent"))
        obstacle = _s(c.get("obstacle"))
        if not intent:
            continue
        at = _s(c.get("at"))
        role = _s(c.get("drama_role"))
        seg = f"场{c.get('card_no', '')}."
        if at:
            seg += f" {at}"
        if role:
            seg += f"【{role}】"
        seg += f"\n  意图：{intent}"
        if obstacle:
            seg += f"\n  障碍：{obstacle}"
        lines.append(seg)
    if len(lines) <= 1:
        return ""
    return "\n".join(lines)
