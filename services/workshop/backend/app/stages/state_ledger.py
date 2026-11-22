"""P1: 故事状态账本 (Story State Ledger) —— 唯一事实源。

设计目标(见 PLAN-大纲与剧本生成-诊断与重构 §3.4):
  - 每批大纲产出后, 用一次 LLM 抽取调用增量更新账本;
  - 记录每集"结束后世界变成什么样"(谁死/谁在场/悬念/用过的元素);
  - snapshot(upto) 给生成/校验提供"截至第N集的世界状态";
  - 账本存进 ScriptDraft.outline["state_ledger"], 零新表。

账本 JSON 结构:
{
  "by_episode": {
    "5": {
      "deaths": ["A"], "births": [],
      "resolved_threads": ["悬念1"], "revealed_secrets": ["A是卧底"],
      "used_elements": ["身世反转"], "present": ["B","C"], "location": "..."
    }
  },
  "cumulative": {
    "alive": ["B","C"], "dead": ["A"],
    "open_threads": ["悬念2"], "resolved_threads": ["悬念1"],
    "revealed_secrets": ["A是卧底"], "used_elements": ["身世反转", "..."]
  }
}
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from ..models.llm import get_llm

logger = logging.getLogger("state_ledger")


def empty_ledger() -> dict[str, Any]:
    """空账本骨架。"""
    return {
        "by_episode": {},
        "cumulative": {
            "alive": [],
            "dead": [],
            "open_threads": [],
            "resolved_threads": [],
            "revealed_secrets": [],
            "used_elements": [],
        },
    }


def _dedup_keep_order(items: list[str]) -> list[str]:
    seen = set()
    out = []
    for x in items:
        s = (x or "").strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


_EXTRACT_PROMPT = """你是剧情状态抽取器。给你若干集的大纲概要, 请抽取每一集"结束后世界状态的变化", 输出严格 JSON。

## 已知的截至上一批的累计状态(供你判断连续性, 不要重复输出已有信息)
{prev_cumulative}

## 本批各集概要(逐集)
{episodes_block}

## 输出格式(严格 JSON, 不要 markdown 包装, 不要解释)
{{
  "by_episode": {{
    "集号(字符串)": {{
      "deaths": ["本集死亡的角色名"],
      "births": ["本集新登场的重要角色名"],
      "resolved_threads": ["本集被解决/揭晓的悬念(一句话)"],
      "revealed_secrets": ["本集揭穿的秘密(一句话)"],
      "used_elements": ["本集用到的重大反转/核心场景/关键道具的首次登场(一句话标签)"],
      "present": ["本集出场的角色名"],
      "location": "本集主要场景(一句话)"
    }}
  }}
}}

## 规则
- 只抽取"本批"这几集, 集号用大纲里的 order 数字(字符串形式)
- deaths/births 只写角色姓名; 没有就空数组
- used_elements 用短标签(如"身世反转""失忆梗""绑架桥段"), 便于后续查重
- 只输出 JSON 对象, 禁止任何前后文字
"""


def _extract_json(text: str) -> dict:
    if not text:
        raise ValueError("empty LLM response")
    raw = text.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw)
    except Exception:
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if not m:
            raise
        return json.loads(m.group(0))


def _fmt_episodes_block(episodes: list[dict]) -> str:
    lines = []
    for ep in episodes:
        order = ep.get("order")
        title = ep.get("title", "")
        syn = ep.get("synopsis", "")
        must = "、".join(ep.get("must_have") or [])
        chars = "、".join(ep.get("characters") or [])
        lines.append(f"[第{order}集]{title}\n概要: {syn}\n关键事件: {must}\n涉及人物: {chars}")
    return "\n\n".join(lines)


def _fmt_cumulative(cum: dict) -> str:
    return (
        f"存活: {'、'.join(cum.get('alive') or []) or '(未知)'}\n"
        f"死亡: {'、'.join(cum.get('dead') or []) or '(无)'}\n"
        f"未决悬念: {'、'.join(cum.get('open_threads') or []) or '(无)'}\n"
        f"已揭秘密: {'、'.join(cum.get('revealed_secrets') or []) or '(无)'}\n"
        f"已用元素: {'、'.join(cum.get('used_elements') or []) or '(无)'}"
    )


def _merge_into_cumulative(ledger: dict, by_ep_delta: dict) -> None:
    """把本批增量合并进 cumulative。就地修改 ledger。"""
    cum = ledger["cumulative"]
    # 按集号顺序处理, 保证 alive/dead 迁移正确
    for ep_no in sorted(by_ep_delta.keys(), key=lambda x: int(x) if str(x).isdigit() else 0):
        d = by_ep_delta[ep_no] or {}
        # ⚠️ str() 兜底：台账由模型产出的 JSON 合并而来，字段偶尔是列表而不是字符串
        # （与 chapter_gen._build_contract_block 同一类坑，见那里的注释）。
        # 直接 .strip() 会抛 'list' object has no attribute 'strip'，
        # 一个字段的类型跑偏就整部剧的生成失败。
        deaths = [str(x).strip() for x in (d.get("deaths") or []) if str(x or "").strip()]
        births = [str(x).strip() for x in (d.get("births") or []) if str(x or "").strip()]
        present = [str(x).strip() for x in (d.get("present") or []) if str(x or "").strip()]
        resolved = [str(x).strip() for x in (d.get("resolved_threads") or []) if str(x or "").strip()]
        secrets = [str(x).strip() for x in (d.get("revealed_secrets") or []) if str(x or "").strip()]
        elements = [str(x).strip() for x in (d.get("used_elements") or []) if str(x or "").strip()]

        # 死亡: 从 alive 移除, 加入 dead
        for name in deaths:
            if name in cum["alive"]:
                cum["alive"].remove(name)
            if name not in cum["dead"]:
                cum["dead"].append(name)
        # 出生/新登场 + 出场者: 若未死则纳入 alive
        for name in births + present:
            if name in cum["dead"]:
                continue  # 已死不因"出场"复活(闪回不改状态)
            if name not in cum["alive"]:
                cum["alive"].append(name)
        # 悬念: resolved 从 open 移除并入 resolved
        for t in resolved:
            if t in cum["open_threads"]:
                cum["open_threads"].remove(t)
            if t not in cum["resolved_threads"]:
                cum["resolved_threads"].append(t)
        cum["revealed_secrets"] = _dedup_keep_order(cum["revealed_secrets"] + secrets)
        cum["used_elements"] = _dedup_keep_order(cum["used_elements"] + elements)


async def update_ledger_for_batch(
    ledger: dict | None,
    batch_episodes: list[dict],
    *,
    open_threads_seed: list[str] | None = None,
    provider: str = "gemini",
) -> dict:
    """对一批新生成的大纲集, 抽取状态并增量合并进账本。

    ledger: 现有账本(None 则新建)
    batch_episodes: 本批大纲集列表(含 order/title/synopsis/must_have/characters)
    open_threads_seed: 若本批是首批, 可把 Bible.core_mysteries 作为初始未决悬念种子
    返回更新后的账本(新对象)。
    """
    led = ledger or empty_ledger()
    # 保证结构完整
    led.setdefault("by_episode", {})
    led.setdefault("cumulative", empty_ledger()["cumulative"])
    for k, v in empty_ledger()["cumulative"].items():
        led["cumulative"].setdefault(k, list(v))

    if open_threads_seed:
        led["cumulative"]["open_threads"] = _dedup_keep_order(
            led["cumulative"]["open_threads"] + list(open_threads_seed)
        )

    if not batch_episodes:
        return led

    prompt = _EXTRACT_PROMPT.format(
        prev_cumulative=_fmt_cumulative(led["cumulative"]),
        episodes_block=_fmt_episodes_block(batch_episodes),
    )
    try:
        llm = get_llm("extract", temperature=0.2, provider=provider)
        resp = await llm.ainvoke(prompt)
        text = getattr(resp, "content", "") or ""
        data = _extract_json(text)
    except Exception as e:  # noqa: BLE001
        logger.warning("state_ledger 抽取失败(降级为空增量): %s", e)
        data = {"by_episode": {}}

    by_ep = data.get("by_episode") or {}
    # 写入 by_episode
    for ep_no, delta in by_ep.items():
        led["by_episode"][str(ep_no)] = {
            "deaths": delta.get("deaths") or [],
            "births": delta.get("births") or [],
            "resolved_threads": delta.get("resolved_threads") or [],
            "revealed_secrets": delta.get("revealed_secrets") or [],
            "used_elements": delta.get("used_elements") or [],
            "present": delta.get("present") or [],
            "location": delta.get("location") or "",
        }
    # 合并进 cumulative
    _merge_into_cumulative(led, by_ep)
    return led


def snapshot(ledger: dict | None, upto_episode: int) -> dict:
    """返回"截至第 upto_episode 集(含)"的世界状态快照, 供生成/校验用。

    重放 by_episode 里 <= upto 的增量, 得到该时点的 alive/dead/open_threads 等。
    """
    base = empty_ledger()
    if not ledger:
        return base["cumulative"]
    by_ep = ledger.get("by_episode") or {}
    # 初始 open_threads 用整体 cumulative 的种子(首批 seed 进去的核心悬念)
    # 这里保守做法: 从空开始重放, 但把 cumulative 里从未出现在任何 resolved 的 open 也带上。
    tmp = empty_ledger()
    # 先把 cumulative 的初始 open_threads 种子(不含被 resolved 的)带入
    cum_all = ledger.get("cumulative") or {}
    seed_open = [t for t in (cum_all.get("open_threads") or [])]
    tmp["cumulative"]["open_threads"] = list(seed_open)

    upto_deltas = {
        k: v for k, v in by_ep.items()
        if str(k).isdigit() and int(k) <= upto_episode
    }
    _merge_into_cumulative(tmp, upto_deltas)
    return tmp["cumulative"]


def snapshot_text(ledger: dict | None, upto_episode: int) -> str:
    """把快照渲染成给 LLM 的约束文本块。"""
    snap = snapshot(ledger, upto_episode)
    dead = snap.get("dead") or []
    alive = snap.get("alive") or []
    open_threads = snap.get("open_threads") or []
    revealed = snap.get("revealed_secrets") or []
    used = snap.get("used_elements") or []
    lines = [f"【截至第{upto_episode}集的世界状态(硬约束)】"]
    if dead:
        lines.append(f"- 已死亡角色(只在标明的闪回/回忆里出现): {'、'.join(dead)}")
    if alive:
        lines.append(f"- 存活角色: {'、'.join(alive)}")
    if revealed:
        lines.append(f"- 已揭穿的秘密(各方按已知处理): {'、'.join(revealed)}")
    if open_threads:
        lines.append(f"- 尚未解决的悬念: {'、'.join(open_threads)}")
    if used:
        lines.append(f"- 已用过的重大元素(后续换用新的): {'、'.join(used)}")
    if len(lines) == 1:
        lines.append("- (暂无累计状态约束)")
    return "\n".join(lines)


# ===========================================================================
# D3: 正向账本 (Positive Ledger) —— 钩子链 / 升级曲线 / 伏笔台账 / 双视图
#
# 背景: 上面那本账记的是 deaths/revealed_secrets/used_elements, 是一本
# **防矛盾的负向账本**——它告诉生成"不能做什么", 但没有任何东西告诉第 12 集
# "你必须比第 11 集更险"。D3 补的正是这个方向。
#
# 全部从大纲的戏剧契约字段**推导**, 零 LLM 调用。
# ===========================================================================


def build_positive_ledger(outline: dict | None) -> dict:
    """从大纲契约字段推导正向账本。零 LLM。

    返回:
      {
        "promises":  [{"id","text","planted_at","expected_by","status"}],
        "hook_chain":[{"ep","out_type","strength","leads_to","in_mode","responds_to"}],
        "escalation_curve": [{"ep","level","label","is_upgrade"}],
        "author_truth": [...], "audience_known": [{"ep","delta"}],
        "mysteries": [...],
      }
    字段缺失时对应项为空, 不抛错(老剧兼容)。
    """
    eps = list((outline or {}).get("chapters") or (outline or {}).get("episodes") or [])
    eps = [e for e in eps if isinstance(e, dict)]
    eps.sort(key=lambda e: e.get("order", 0))

    from .drama_gate import HOOK_STRENGTHS, _norm, _similar, normalize_hook_type  # 复用判据, 不另造一套

    # --- 伏笔台账 ---
    promises: list[dict] = []
    by_text: dict[str, dict] = {}
    for ep in eps:
        order = ep.get("order")
        for p in (ep.get("plant") or []):
            text = str(p).strip()
            key = _norm(text)
            if not text or key in by_text:
                continue
            rec = {
                "id": f"F-{len(promises) + 1:03d}",
                "text": text,
                "planted_at": order,
                "expected_by": None,
                "status": "open",
            }
            promises.append(rec)
            by_text[key] = rec
        for p in (ep.get("payoff") or []):
            key = _norm(str(p))
            hit = by_text.get(key)
            if hit is None:  # 模糊匹配(模型措辞不完全一致)
                for k, rec in by_text.items():
                    if _similar(k, key) >= 0.5:
                        hit = rec
                        break
            if hit is not None:
                hit["status"] = "paid"
                hit["paid_at"] = order

    total_orders = [e.get("order") for e in eps]
    for rec in promises:
        try:
            idx = total_orders.index(rec["planted_at"])
        except ValueError:
            continue
        # 预期回收窗口: 小伏笔 3 集内, 中伏笔 8 集内, 超出即逾期
        rec["expected_by"] = (
            total_orders[min(idx + 3, len(total_orders) - 1)] if total_orders else None
        )
        if rec["status"] == "open" and rec["expected_by"] is not None:
            rec["overdue"] = rec["expected_by"] < (total_orders[-1] if total_orders else 0)

    # --- 钩子链 ---
    hook_chain: list[dict] = []
    for ep in eps:
        ho = ep.get("hook_out") or {}
        hi = ep.get("hook_in") or {}
        hook_chain.append({
            "ep": ep.get("order"),
            "out_type": normalize_hook_type(str(ho.get("type") or "")),
            "strength": str(ho.get("strength") or "").strip(),
            "leads_to": str(ho.get("leads_to") or "").strip(),
            "in_mode": str(hi.get("mode") or "").strip(),
            "responds_to": str(hi.get("responds_to") or "").strip(),
        })

    # --- 升级曲线 ---
    order_idx = {s: i for i, s in enumerate(HOOK_STRENGTHS)}
    curve: list[dict] = []
    prev_level = -1
    for ep in eps:
        ho = ep.get("hook_out") or {}
        strength = str(ho.get("strength") or "").strip()
        level = order_idx.get(strength, -1)
        curve.append({
            "ep": ep.get("order"),
            "level": level,
            "label": strength or "未标注",
            "is_upgrade": level > prev_level >= 0,
        })
        if level >= 0:
            prev_level = level

    # --- 双视图: 作者真相 vs 读者已知 ---
    audience_known: list[dict] = []
    author_truth: list[str] = []
    for ep in eps:
        delta = str(ep.get("audience_knows_delta") or "").strip()
        if delta:
            audience_known.append({"ep": ep.get("order"), "delta": delta})
        for name, know in (ep.get("char_knows_delta") or {}).items():
            if str(know).strip():
                author_truth.append(f"第{ep.get('order')}集 {name}: {str(know).strip()}")

    return {
        "promises": promises,
        "hook_chain": hook_chain,
        "escalation_curve": curve,
        "audience_known": audience_known,
        "author_truth": author_truth,
        "mysteries": [str(m).strip() for m in ((outline or {}).get("story_bible") or {}).get("core_mysteries") or []],
    }


def positive_ledger_text(outline: dict | None, upto_episode: int) -> str:
    """把正向账本渲染成给 LLM 的约束块（截至 upto_episode）。

    与 snapshot_text 的区别: 这本告诉生成"必须往哪走"——
    未回收的伏笔、上一集的钩子指向、升级到哪一档了。
    """
    led = build_positive_ledger(outline)
    eps = led["hook_chain"]
    upto_idx = next((i for i, h in enumerate(eps) if h["ep"] == upto_episode), len(eps) - 1)

    lines: list[str] = []

    # 上一集的钩子指向(本集必须回应)
    if upto_idx >= 0 and eps:
        prev = eps[upto_idx]
        if prev.get("leads_to"):
            lines.append(
                f"- 第{prev['ep']}集留下的卡点: {prev['leads_to']}"
                f"（本集须直接或间接回应，节奏上最多延迟 3 集）"
            )

    # 未回收的伏笔
    open_promises = [p for p in led["promises"] if p["status"] == "open" and p["planted_at"] <= upto_episode]
    if open_promises:
        items = "；".join(
            f"{p['id']}「{p['text']}」(第{p['planted_at']}集埋"
            + ("，已逾期)" if p.get("overdue") else ")")
            for p in open_promises
        )
        lines.append(f"- 待回收伏笔(按剧情时机兑现，标「已逾期」的优先安排): {items}")

    # 升级档位
    curve = [c for c in led["escalation_curve"] if c["ep"] <= upto_episode and c["level"] >= 0]
    if curve:
        last = curve[-1]
        lines.append(
            f"- 当前压迫强度档位: {last['label']}(第{last['ep']}集)。"
            # 2026-10-28：原为"本集不得低于此档，理想应上升一档"，与集纲 escalation 口径
            # （允许停顿、阶段性胜利、局部降温，整体趋势上升）矛盾，统一为后者。
            f"本集按剧情需要保持或推高；需要喘息的集可以短暂回落，随后回到更高的档位。"
        )

    # 观众已知边界(防提前透底)
    if led["audience_known"]:
        known = "；".join(f"第{a['ep']}集: {a['delta']}" for a in led["audience_known"][-5:])
        lines.append(f"- 观众已知(在此基础上往下揭，后续秘密按计划留到后面): {known}")

    if not lines:
        return "（本剧暂无可用的正向剧情约束）"
    return "【正向剧情约束(必须往这个方向走)】\n" + "\n".join(lines)