"""模块触发器：根据用户输入 + 标签规则，命中后台维护的「风格模块」。

M1：使用关键词 + 标签简单匹配。
M2：引入轻量 LLM 意图识别，支持同义词、隐式线索。
"""
from __future__ import annotations

from typing import Any


def match_modules(
    user_input: str,
    modules: list[dict[str, Any]],
    *,
    top_n: int = 3,
) -> list[dict[str, Any]]:
    """对每个模块计算命中分数 = Σ(关键词命中次数) × tag 权重。"""
    text = user_input.lower()
    scored: list[tuple[float, dict[str, Any]]] = []
    for m in modules:
        score = 0.0
        for kw in m.get("keywords", []):
            if kw and kw.lower() in text:
                score += float(m.get("weight", 1.0))
        for tag in m.get("tags", []):
            if tag and tag.lower() in text:
                score += 0.5
        if score > 0:
            scored.append((score, m))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [m for _, m in scored[:top_n]]
