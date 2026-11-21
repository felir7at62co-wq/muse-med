"""文本工具：清洗、拼音比对、原文对白提取。核对与拆解共用，保证同一个口径。"""
from __future__ import annotations

import difflib
import re

from pypinyin import lazy_pinyin

_PUNCT = re.compile(r"[\s，。！？、…；：,.!?;:“”\"'‘’（）()【】\[\]—\-~～·《》<>]")
_PAREN = re.compile(r"（[^）]*）|\([^)]*\)")
#: 拟声（喵呜——）：ASR 转不出字，按音效处理，不核对、不拿 TTS 去念
_SFX = re.compile(r"[喵呜嗷汪哼嗯啊呃咕噜嘶哈嘿呼]+")


def clean(s: str) -> str:
    """去标点空白。比对与计字数都用它。"""
    return _PUNCT.sub("", s or "")


def strip_paren(s: str) -> str:
    """去掉括号里的表演提示：「陆知夏？（上下打量）一个人啊」→「陆知夏？一个人啊」。"""
    return _PAREN.sub("", s or "").strip()


def is_sfx(text: str) -> bool:
    c = clean(text)
    return bool(c) and bool(_SFX.fullmatch(c))


def py(s: str) -> list[str]:
    return lazy_pinyin(clean(s))


def hits(a: str, b: str) -> int:
    """a 的字在 b 里按序命中多少个（按拼音比，ASR 的同音错字不算错）。"""
    pa, pb = py(a), py(b)
    return sum(m.size for m in difflib.SequenceMatcher(None, pa, pb, autojunk=False)
               .get_matching_blocks())


def diff_line(orig: str, heard: str) -> dict:
    """原文 vs 实际听到：一致度 + 漏/多/改（按拼音对齐，显示原字）。"""
    a, b = clean(orig), clean(heard)
    pa, pb = lazy_pinyin(a), lazy_pinyin(b)
    sm = difflib.SequenceMatcher(None, pa, pb, autojunk=False)
    miss, extra, swap, same = [], [], [], 0
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            same += i2 - i1
        elif op == "delete":
            miss.append(a[i1:i2])
        elif op == "insert":
            extra.append(b[j1:j2])
        else:
            swap.append(f"{a[i1:i2]}→{b[j1:j2]}")
    # 一致度要同时罚「漏」与「多」：只算原文命中率的话，「考虑考虑保护你」对「考虑保护你」
    # 也是 100%（原文每个字都念到了），模型多念一遍就溜过核对（2026-10-31 实测）。
    # 用 2·命中 / (原文字数 + 实际字数)：多念 2 字的 23 字句 → 0.96，会进核对报告。
    ratio = 2 * same / max(1, len(a) + len(b)) if b else 0.0
    return {"ratio": round(ratio, 3), "heard": heard, "miss": miss, "extra": extra, "swap": swap}


# ------------------------------------------------------------ 原文里的对白

_LINE_DLG = re.compile(r"^\s*([^\s▲【：:（(]{1,10})\s*(?:（[^）]*）|\([^)]*\))?\s*[：:]\s*(.+)$")
_QUOTE = re.compile(r"[“\"「]([^”\"」]{1,200})[”\"」]")
#: 剧本格式里不算台词的冒号行
_NOT_SPEAKER = ("出场人物", "人物", "场景", "时间", "地点", "备注", "第")


def source_dialogues(text: str) -> list[str]:
    return [t for _, t, _ in source_dialogue_pairs(text)]


def source_dialogue_pairs(text: str) -> list[tuple[str, str, bool]]:
    """原文里所有台词（去括号表演提示后），按出现顺序。

    两种写法都认：剧本体「周浩（错愕）：陆知夏？…」与小说体引号「“……”」。
    返回 (说话人, 台词, 是否画外音)。`XXVO：` / `XXOS：` 是画外音/内心独白：
    同样要逐字念，但没有口型——本模式里交给统一的解说音色念（is_vo=True）。
    """
    out: list[tuple[str, str, bool]] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("▲"):
            continue
        m = _LINE_DLG.match(line)
        if m and not m.group(1).startswith(_NOT_SPEAKER):
            t = strip_paren(m.group(2))
            if clean(t):
                vo = bool(re.search(r"(VO|OS)$", m.group(1), re.I))
                who = re.sub(r"(VO|OS)$", "", m.group(1), flags=re.I).strip()
                out.append((who, t, vo))
            continue
        for q in _QUOTE.findall(line):
            t = strip_paren(q)
            if clean(t):
                out.append(("", t, False))
    return out


def verbatim_in(text: str, source_clean_py: list[str]) -> bool:
    """这句台词（去括号后）是否**逐字**出现在原文里（按拼音，容忍原文用了同音异体字）。"""
    p = py(strip_paren(text))
    if not p:
        return True
    n = len(p)
    hay = source_clean_py
    for i in range(0, len(hay) - n + 1):
        if hay[i:i + n] == p:
            return True
    return False


def source_py(text: str) -> list[str]:
    """原文去括号后的拼音序列（`verbatim_in` 的被查对象）。"""
    return py(strip_paren(text))
