"""场次编号（scene_no）的唯一修正口径。

## 为什么需要它（2026-10-23 用户报的 bug）

导出剧本时，**第 2 集以后的每一集场号都是 `1-1`、`1-2`**，看起来像"每集都从第 1 场
重新开始"，而格式本身写的是「集号-场号」。

根因不在渲染，在生成：分镜提示词要求 `scene_no` 用「集号-场号」格式、**从 `1-1`
开始递增**，但生成函数**根本不知道自己在生成第几集** —— 集号从来不是入参。
模型只能照字面执行"从 1-1 开始"，于是每一集都从 `1-1` 起编。

dev 库实测（2026-10-23）：52813 个分镜里 **17780 个集号前缀是错的**，且错的全是
退化成 `1-x`。也就是说这不是偶发，是**默认行为**。

## 修法

编号只由两件确定的事决定：**这一集是第几集** + **这一场在数组里的位置**。
所以不去猜模型写了什么，直接按真实集号重排：

    第 5 集的第 1、2 场  →  "5-1"、"5-2"

这样同时消掉三类历史脏数据：前缀错、场号重复、场号跳号。

## 何时用

1. **生成落库时**（`storyboard_gen._normalize`）—— 保证新数据从一开始就是对的。
2. **导出渲染时**（`stages/router.py` 的 sb_rows）—— 存量 17780 条不必做数据迁移，
   导出前纠正即可；用户拿到的文件立刻是对的。

⚠️ 渲染时纠正**不回写库**：用户编辑时看到的场号仍是他存的那些。要不要回填存量
   由用户决定（那是一次全库写操作），这里只保证"交付物是对的"。
"""
from __future__ import annotations

import re
from typing import Any

#: 从模型返回的场号里抽出"场号"部分。接受 "1-3" / "第1集第3场" / "3" 这几种写法。
_SCENE_TAIL = re.compile(r"^\s*(?:第\s*\d+\s*集)?\s*[-－—]?\s*(?:场\s*)?(\d+)\s*$")


def _tail_no(raw: Any) -> int | None:
    """取场号的数字部分；取不到（空、非数字、"全篇"之类）返回 None。"""
    s = str(raw or "").strip()
    if not s:
        return None
    # 优先按 "集-场" 拆，取后半段
    if "-" in s or "－" in s or "—" in s:
        part = re.split(r"[-－—]", s)[-1].strip()
        return int(part) if part.isdigit() else None
    m = _SCENE_TAIL.match(s)
    return int(m.group(1)) if m else None


def renumber_scenes(shots: list[dict], episode_order: int) -> list[dict]:
    """把 `shots` 每场的 `scene_no` 改成 `"{真实集号}-{本集内顺序号}"`。

    只改 `scene_no`，**不动任何其它字段**，也不改变数组顺序与元素内容。

    ⚠️ 三类条目刻意跳过（保持原样）：
      · 扁平镜头表（没有 `scene_no`、只有 `shot_no`）—— 那是"本集第几镜"，
        按定义就该每集从 1 起，不是这里要修的"集号-场号"；
      · 非 dict 的脏条目 —— 交回给原来的渲染器兜底。

    返回**新的 list[dict]**（浅拷贝条目），不改入参。
    """
    if not isinstance(shots, list):
        return shots
    try:
        ep = int(episode_order or 0)
    except (TypeError, ValueError):
        ep = 0
    if ep <= 0:
        return shots

    out: list[dict] = []
    seq = 0
    for s in shots:
        if not isinstance(s, dict):
            out.append(s)
            continue
        item = dict(s)
        # 扁平镜头表：没有场号概念，原样过去
        if "scene_no" not in s and "elements" not in s:
            out.append(item)
            continue
        seq += 1
        item["scene_no"] = f"{ep}-{seq}"
        out.append(item)
    return out
