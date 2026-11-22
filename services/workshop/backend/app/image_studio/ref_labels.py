"""参考图标注 → 图N 自动替换 (后端隐式处理)。

用户为每张参考图打标注 (角色名等)。提交生图时, 把提示词里出现的标注词
按"参考图顺序"替换成 图1 图2 … 图9, 让模型明确名字与第N张参考图的对应关系。

- 替换在后端完成, 用户看不到替换结果 (前端存储/展示仍是原始提示词与标注)。
- 编号: 图1..图9 (阿拉伯数字, 与 MAX_REF_IMAGES=9 对齐)。
"""
from __future__ import annotations


def apply_ref_label_map(prompt: str, labels: list[str] | None) -> str:
    """把 prompt 中出现的标注词替换为 图{N} (N 为该标注对应参考图的 1-based 序号)。

    参数:
      prompt: 原始提示词
      labels: 标注列表, labels[i] 对应第 i 张参考图 (0-based)。
              空串/None 表示该图未标注, 跳过。

    规则:
      - 同一标注词只映射到首次出现的图号 (去重)。
      - 按标注词长度降序替换, 避免短词先吃掉长词的子串 (如 "小满" vs "林小满")。
      - 中文无词边界, 采用直接子串替换; 先长后短可显著降低误伤。
    """
    if not prompt or not labels:
        return prompt or ""

    # 收集 (标注词, 图号), 去重保留首个序号
    seen: set[str] = set()
    pairs: list[tuple[str, int]] = []
    for idx, raw in enumerate(labels):
        label = (raw or "").strip()
        if not label or label in seen:
            continue
        seen.add(label)
        pairs.append((label, idx + 1))

    if not pairs:
        return prompt

    # 先长后短, 避免子串误替换
    pairs.sort(key=lambda p: len(p[0]), reverse=True)

    out = prompt
    for label, n in pairs:
        out = out.replace(label, f"图{n}")
    return out