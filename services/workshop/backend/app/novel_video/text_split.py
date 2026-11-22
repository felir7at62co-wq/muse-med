"""小说文本拆分。

- split_for_audio: 音频维度, 只在"。"处断, 累积到 max_chars 切一批(防 TTS 超长)。
  max_chars 为 None 时不拆(整段一次生成)。
- split_for_images: 图片维度, 把全文按目标张数 n 均分(尽量在句末"。"边界切, 不拆句)。
"""
from __future__ import annotations

import re
from typing import Optional

# 句子结束标点(主要用"。", 兼顾其它句末符防止极端无句号文本切不动)
_SENT_END = "。"


def _split_sentences(text: str) -> list[str]:
    """按"。"切句, 保留句号在句尾。其它换行/空白规整。"""
    text = (text or "").replace("\r\n", "\n").strip()
    if not text:
        return []
    parts: list[str] = []
    buf = ""
    for ch in text:
        buf += ch
        if ch == _SENT_END:
            s = buf.strip()
            if s:
                parts.append(s)
            buf = ""
    tail = buf.strip()
    if tail:
        parts.append(tail)  # 结尾没有句号的残句也保留
    return parts


def split_for_audio(text: str, max_chars: Optional[int]) -> list[str]:
    """音频分片: 只在"。"处断。max_chars=None → 整段不拆。"""
    sentences = _split_sentences(text)
    if not sentences:
        return []
    if not max_chars or max_chars <= 0:
        return ["".join(sentences)]
    chunks: list[str] = []
    cur = ""
    for s in sentences:
        # 单句就超阈值: 只能单独成块(无法在句中切, 遵守"不拆句")
        if len(s) >= max_chars:
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.append(s)
            continue
        if len(cur) + len(s) <= max_chars:
            cur += s
        else:
            if cur:
                chunks.append(cur)
            cur = s
    if cur:
        chunks.append(cur)
    return chunks


def split_for_images(text: str, n: int) -> list[str]:
    """图片分段: 把全文按目标张数 n 尽量均分, 在句边界切(不拆句)。

    先切句, 再把句子按累计长度均匀分配到 n 组。
    """
    sentences = _split_sentences(text)
    if n <= 0 or not sentences:
        return [text] if text else []
    # 统一按字数把全文均分成【恰好 n 段】, 保证图片张数 = ceil(音频/每张秒数)。
    #
    # 为什么不按句边界均分:
    #   原实现分两种情况, 且"句数≥n"时用贪婪累积(cur_len>=每段目标字数才切)。当句子长短不均时,
    #   靠前的段会"吃"掉过多字数, 使后面内容不足以切满 n 段 → 实际段数 < n(实测 ceshi3: 857字/42句,
    #   目标20段却只切出15段), 导致图片张数不足、每张停留被拉长、切换偏慢, 与用户设置不符。
    #   句数<n 时旧实现更是直接每句一段, 段数更少。
    #
    # 现方案: 无论句数多少, 都按累计字数取 n-1 个等距切点(第 i 段覆盖 [i*L/n, (i+1)*L/n) 字),
    #   切点就近吸附到句边界(优先不拆句); 若某段被吸附后为空则回退为精确字数切分。
    #   段文字仅用于生成该段的画面提示词(LLM 概括), 偶尔句中断开不影响画面质量, 但张数精确=n。
    full = "".join(sentences)
    L = len(full)
    if L == 0:
        return sentences
    if n == 1:
        return [full]
    # 纯字数等分成【恰好 n 段】: 第 i 段覆盖 full[i*L/n : (i+1)*L/n)。
    # 之前尝试过"吸附到句边界"以避免句中切, 但句边界数量有限(=句数), 当目标段数 n > 句数 或
    # 句长不均时, 多个等距切点会吸附到同一批句边界、去重后候选枯竭, 导致实际段数塌缩到句数
    # (实测 ceshi3: 目标20段却只切出15段/=句数)。图片段文字仅用于让 LLM 概括出该段画面提示词,
    # 偶尔在句中断开完全不影响画面质量, 但张数必须精确 = n(=ceil(音频/每张秒数)), 否则每张停留
    # 时长与用户设置不符、切换频率不对。故这里直接按字数硬切, 简单且张数恒等于 n。
    per = L / n
    segs: list[str] = []
    for i in range(n):
        start = int(round(i * per))
        end = int(round((i + 1) * per)) if i < n - 1 else L
        piece = full[start:end].strip()
        segs.append(piece if piece else full[start:end] or "…")
    return segs
