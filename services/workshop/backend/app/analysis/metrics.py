"""程序化指标(无 LLM,纯统计)

输入: 章节列表 + 剧本列表
输出: 节奏曲线 / 角色戏份占比 / 字数偏离度
"""
from __future__ import annotations

import re
from typing import Any

from ..defaults import DEFAULT_CHAPTER_WORD_TARGET


def compute_metrics(
    *,
    chapters: list[dict],
    storyboards: list[dict],
    word_target: int = DEFAULT_CHAPTER_WORD_TARGET,
    characters: list[dict] | None = None,
) -> dict:
    """统计程序化指标。

    chapters: [{chapter_order, title, full_text, summary, word_count}]
    storyboards: [{chapter_order, shots_json}]
    """
    chapters = chapters or []
    storyboards = storyboards or []
    sb_by_order = {s["chapter_order"]: (s.get("shots_json") or []) for s in storyboards}

    # ---- 1. 字数统计
    total_words = 0
    chapter_word_counts: list[dict] = []
    for ch in chapters:
        wc = ch.get("word_count") or len(ch.get("full_text") or "")
        total_words += wc
        deviation = 0
        if word_target > 0:
            deviation = round((wc - word_target) / word_target * 100)
        chapter_word_counts.append({
            "order": ch.get("chapter_order"),
            "title": ch.get("title", ""),
            "word_count": wc,
            "deviation_pct": deviation,        # 偏离目标字数的百分比
        })

    avg_per_chapter = round(total_words / len(chapters)) if chapters else 0

    # ---- 2. 节奏密度曲线(按集)
    # 短剧节奏 = 每集 action 字数 + dialogue 字数密度,假设短剧应该高
    pacing_curve: list[dict] = []
    for sb_order, shots in sorted(sb_by_order.items()):
        action_chars = 0
        dialogue_chars = 0
        shot_count = len(shots)
        for s in shots:
            if not isinstance(s, dict):
                continue
            action_chars += len(s.get("action", "") or "")
            dialogue_chars += len(s.get("dialogue", "") or "")
        pacing_curve.append({
            "order": sb_order,
            "shot_count": shot_count,
            "action_chars": action_chars,
            "dialogue_chars": dialogue_chars,
            "total_chars": action_chars + dialogue_chars,
            "dialogue_ratio": round(dialogue_chars / max(1, action_chars + dialogue_chars), 2),
        })

    # ---- 3. 角色戏份占比(扫 dialogue 出场次数)
    char_appearances: dict[str, int] = {}
    char_lines: dict[str, int] = {}    # 台词数量
    known_char_names = set()
    if characters:
        for c in characters:
            name = (c.get("name") or "").strip()
            if name:
                known_char_names.add(name)
                char_appearances[name] = 0
                char_lines[name] = 0

    for sb_order, shots in sb_by_order.items():
        for s in shots:
            if not isinstance(s, dict):
                continue
            chars_in_shot = s.get("characters") or []
            for cn in chars_in_shot:
                if isinstance(cn, str) and cn:
                    char_appearances[cn] = char_appearances.get(cn, 0) + 1
            # 从 dialogue 统计台词(粗略:按"人名:"模式)
            dlg = s.get("dialogue", "") or ""
            for name in known_char_names:
                # 形如 "李明: ..." 或 "李明（特写）: ..."
                pattern = re.compile(rf"\b{re.escape(name)}(?:[（(][^）)]*[）)])?\s*[:：]")
                hits = len(pattern.findall(dlg))
                if hits:
                    char_lines[name] = char_lines.get(name, 0) + hits

    # 计算戏份占比
    total_appearances = sum(char_appearances.values()) or 1
    character_share = []
    for name, n in sorted(char_appearances.items(), key=lambda x: -x[1])[:15]:
        character_share.append({
            "name": name,
            "appearances": n,
            "share_pct": round(n / total_appearances * 100, 1),
            "line_count": char_lines.get(name, 0),
        })

    # ---- 4. 钩子密度估算(粗略:每集 shot 数 vs 总字数比例)
    chapters_count = len(chapters)
    storyboards_count = len(storyboards)
    avg_shots = round(sum(p["shot_count"] for p in pacing_curve) / max(1, len(pacing_curve)), 1)

    return {
        # 概览
        "total_chapters": chapters_count,
        "total_storyboards": storyboards_count,
        "total_words": total_words,
        "avg_words_per_chapter": avg_per_chapter,
        "word_target": word_target,
        # 字数偏离
        "chapter_word_counts": chapter_word_counts,
        # 节奏曲线
        "pacing_curve": pacing_curve,
        "avg_shots_per_chapter": avg_shots,
        # 角色
        "character_share": character_share,
        # 整体
        "has_full_storyboard": storyboards_count >= chapters_count and chapters_count > 0,
    }
