"""事件时间轴构建 —— 读 state_ledger.by_episode, 产出可视化时间轴 JSON。

纯规则、零 LLM: 把每集已抽取的事件(deaths/births/reveals/...)展开成事件卡,
加权求和得每集"事件负荷分", 用同剧内相对阈值(mean/mean+std)判定 low/mid/high。

事件权重(见 PLAN):
  death=3, reveal=2, resolve=2, twist=2, new_char=1
"""
from __future__ import annotations

import math
from typing import Any

# 事件类型定义: (ledger 字段, type 标签, 权重)
_EVENT_SPECS: list[tuple[str, str, int]] = [
    ("deaths", "death", 3),
    ("revealed_secrets", "reveal", 2),
    ("resolved_threads", "resolve", 2),
    ("used_elements", "twist", 2),
    ("births", "new_char", 1),
]


def _title_by_order(outline: dict) -> dict[int, str]:
    """从大纲 chapters 取 order -> title 映射。"""
    out: dict[int, str] = {}
    for i, c in enumerate((outline.get("chapters") or outline.get("episodes") or [])):
        if not isinstance(c, dict):
            continue
        try:
            o = int(c.get("order") or (i + 1))
        except (TypeError, ValueError):
            o = i + 1
        if c.get("title"):
            out[o] = str(c["title"])
    return out


def build_timeline(outline: dict) -> dict[str, Any]:
    """把 outline 里的 state_ledger.by_episode 整理成时间轴。

    返回:
      {
        "episodes": [{order, title, events:[{type,label,weight}], load_score, load_level}],
        "stats": {mean, std, high_threshold, mid_threshold, max_order, total_events},
        "has_ledger": bool
      }
    """
    ledger = outline.get("state_ledger") or {}
    by_ep = ledger.get("by_episode") or {}
    title_map = _title_by_order(outline)

    # 收集所有出现过的集号(ledger + 大纲 chapters 的并集, 保证空事件集也占位)
    orders: set[int] = set()
    for k in by_ep.keys():
        if str(k).lstrip("-").isdigit():
            orders.add(int(k))
    for o in title_map.keys():
        orders.add(o)
    # 大纲有 chapters 但 order 未在 title_map(无 title)时也纳入
    for i, c in enumerate((outline.get("chapters") or outline.get("episodes") or [])):
        if isinstance(c, dict):
            try:
                orders.add(int(c.get("order") or (i + 1)))
            except (TypeError, ValueError):
                orders.add(i + 1)

    episodes: list[dict] = []
    scores: list[int] = []
    for o in sorted(orders):
        ep_ledger = by_ep.get(str(o)) or {}
        events: list[dict] = []
        for field, etype, weight in _EVENT_SPECS:
            for label in (ep_ledger.get(field) or []):
                s = str(label).strip()
                if not s:
                    continue
                events.append({"type": etype, "label": s, "weight": weight})
        load_score = sum(e["weight"] for e in events)
        scores.append(load_score)
        episodes.append({
            "order": o,
            "title": title_map.get(o) or f"第{o}集",
            "events": events,
            "load_score": load_score,
            "load_level": "low",  # 占位, 下方按相对阈值回填
        })

    # 相对阈值: mean 作 mid 门槛, mean+std 作 high 门槛
    n = len(scores)
    if n > 0:
        mean = sum(scores) / n
        var = sum((x - mean) ** 2 for x in scores) / n
        std = math.sqrt(var)
    else:
        mean = 0.0
        std = 0.0
    mid_threshold = mean
    high_threshold = mean + std

    for ep in episodes:
        sc = ep["load_score"]
        if sc > high_threshold and sc > 0:
            ep["load_level"] = "high"
        elif sc > mid_threshold and sc > 0:
            ep["load_level"] = "mid"
        else:
            ep["load_level"] = "low"

    return {
        "episodes": episodes,
        "stats": {
            "mean": round(mean, 2),
            "std": round(std, 2),
            "mid_threshold": round(mid_threshold, 2),
            "high_threshold": round(high_threshold, 2),
            "max_order": max(orders) if orders else 0,
            "total_events": sum(scores),
        },
        "has_ledger": bool(by_ep),
    }