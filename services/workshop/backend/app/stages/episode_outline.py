"""集纲(分集大纲)解析 — 续写功能的用户自备大纲支持。

用户自己写好"精确到每一集发生什么"的大纲(集纲), 粘贴进续写弹窗。
支持的分集标注(参考导入剧本 smart_split_chapters 的识别方案):
  A. 第N集/第N章/第N话/第N回 (中文/阿拉伯数字), 如 "第十一集" "第11集: 标题"
  B. 行首序号: "一、" "1、" "1." "1:" "（1）" "(1)" 等

与导入剧本不同: 集纲保留用户标注的原始集号(用户可能从第 11 集开始写),
不强制从 1 重新编号; 集号缺失/重复时才回退为顺序编号。
"""
from __future__ import annotations

import re

from .import_script import _cn_num_to_int

# 每集标题的最大长度: 标注行剩余部分不超过它才当作标题, 否则并入剧情简介
_TITLE_MAX_LEN = 24

# 模式 A: 第N集/章/节/话/回/幕/场 (与导入剧本一致)
_PATTERN_A = re.compile(
    r'(?:^|\n)\s*(第\s*([一二三四五六七八九十百千零壹贰叁肆伍陆柒捌玖\d]+)\s*[集章节话回幕场])'
    r'\s*(?:[:：、\.]?\s*([^\n]{0,50}))?'
)

# 模式 B: 行首序号 "一、" "1、" "1." "1:" "（1）" "(1)"
_PATTERN_B = re.compile(
    r'(?:^|\n)\s*[（(]?([一二三四五六七八九十百千零\d]{1,6})[)）]?\s*[、.．:：]\s*([^\n]{0,60})'
)


def _resolve_orders(raw_orders: list[int]) -> list[int]:
    """校正集号: 全部有效且严格递增则保留用户原始集号; 否则回退顺序编号。

    回退时以第一个有效集号为起点(用户从第 11 集开始写就从 11 顺延),
    一个有效集号都没有则从 1 开始。
    """
    if raw_orders and all(o > 0 for o in raw_orders) and all(
        b > a for a, b in zip(raw_orders, raw_orders[1:])
    ):
        return raw_orders
    start = next((o for o in raw_orders if o > 0), 1)
    return [start + i for i in range(len(raw_orders))]


def split_episode_outline(text: str) -> dict:
    """把用户粘贴的集纲文本拆分为逐集条目。

    返回:
      {
        "episodes": [{"order": 11, "title": "...", "synopsis": "...", "word_count": 123}, ...],
        "mode": "marker_di" | "marker_seq" | "none",
      }
    mode=none 表示识别不到分集标注(不足 2 个), 前端提示用户手动整理。
    """
    text = (text or "").strip()
    if not text:
        return {"episodes": [], "mode": "none"}

    # 优先模式 A ("第N集"), 命中数多者胜; 都不足 2 个则无法拆分
    matches_a = list(_PATTERN_A.finditer(text))
    matches_b = list(_PATTERN_B.finditer(text))
    use_a = len(matches_a) >= 2 and len(matches_a) >= len(matches_b)
    use_b = not use_a and len(matches_b) >= 2

    if not use_a and not use_b:
        return {"episodes": [], "mode": "none"}

    matches = matches_a if use_a else matches_b
    mode = "marker_di" if use_a else "marker_seq"

    entries: list[dict] = []
    raw_orders: list[int] = []
    for i, m in enumerate(matches):
        body = text[m.end(): matches[i + 1].start() if i + 1 < len(matches) else len(text)].strip()
        if use_a:
            num_str = m.group(2)
            remainder = (m.group(3) or "").strip().lstrip(":：、.").strip()
        else:
            num_str = m.group(1)
            remainder = (m.group(2) or "").strip()
        raw_orders.append(_cn_num_to_int(num_str))

        # 标注行剩余部分: 短(≤24字)且后面还有正文 → 当标题; 否则并入简介
        title = ""
        if remainder and len(remainder) <= _TITLE_MAX_LEN and body:
            title = remainder
        elif remainder:
            body = f"{remainder}\n{body}".strip() if body else remainder

        entries.append({"title": title, "synopsis": body})

    orders = _resolve_orders(raw_orders)
    episodes = []
    for order, e in zip(orders, entries):
        syn = e["synopsis"].strip()
        if not syn:
            continue  # 空条目丢弃(比如标注后没内容)
        episodes.append({
            "order": order,
            "title": e["title"] or f"第{order}集",
            "synopsis": syn,
            "word_count": len(syn),
        })
    return {"episodes": episodes, "mode": mode}


__all__ = ["split_episode_outline"]