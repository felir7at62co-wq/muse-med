"""自动字幕: whisper 时间戳 + 原文纠正 + 单行切句 → SRT。

思路(音字同步且字准):
1. faster-whisper 对配音做 word-level 转录 → 每个字带 (start,end) 时间戳(时间准, 但可能听错同音字)
2. 把识别出的字序列与原文用 difflib 对齐 → 建立 原文字→时间 的映射(内容用原文, 时间用whisper)
3. 原文按标点/字数切成"单行"短句, 每句取首字start~末字end作为字幕时间段
4. 输出标准 SRT, 交给 ffmpeg subtitles 滤镜烧录

额外成本: 对齐用标准库 difflib(毫秒级, 可忽略); 主要开销在 whisper 转录本身(~音频时长的0.2~0.5x)。
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Optional

# HF 环境: 国内走镜像 + 禁用 xet(新版默认走 xethub 未镜像会 401); 模型已缓存则纯离线加载。
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

logger = logging.getLogger(__name__)

# 全局缓存模型(避免每次合成都重新加载)
_MODEL = None
_MODEL_NAME = "small"


def _get_model():
    global _MODEL
    if _MODEL is None:
        from faster_whisper import WhisperModel  # 延迟导入, 未装依赖时不影响其它功能
        # CPU int8: 内存小、速度可接受; 有GPU可改 device="cuda", compute_type="float16"
        _MODEL = WhisperModel(_MODEL_NAME, device="cpu", compute_type="int8")
        logger.info("faster-whisper model '%s' loaded", _MODEL_NAME)
    return _MODEL


@dataclass
class CharTime:
    ch: str
    start: float
    end: float


def _transcribe_chars(audio_path: str) -> list[CharTime]:
    """转录 → 逐字时间戳序列。word 内多字均分时间。"""
    model = _get_model()
    segments, _info = model.transcribe(
        audio_path, language="zh", word_timestamps=True,
        vad_filter=True, beam_size=5,
    )
    chars: list[CharTime] = []
    for seg in segments:
        words = getattr(seg, "words", None) or []
        if not words:
            # 没有 word 级时间戳, 退化: 整段均分
            txt = re.sub(r"\s+", "", seg.text or "")
            if txt:
                n = len(txt)
                dur = max(0.0, (seg.end - seg.start))
                for i, c in enumerate(txt):
                    s = seg.start + dur * i / n
                    e = seg.start + dur * (i + 1) / n
                    chars.append(CharTime(c, s, e))
            continue
        for w in words:
            wt = re.sub(r"\s+", "", w.word or "")
            if not wt:
                continue
            n = len(wt)
            dur = max(0.0, (w.end - w.start))
            for i, c in enumerate(wt):
                s = w.start + dur * i / n
                e = w.start + dur * (i + 1) / n
                chars.append(CharTime(c, s, e))
    return chars


# 断句标点(在这些字符后可断行)
_BREAK_PUNCT = set("。！？!?…；;，,、：:")
# 需要从字幕里剔除的字符(不影响对齐, 只影响显示)
_STRIP_FOR_DISPLAY = set(" \t\r\n")
# 字幕显示时要剔除的标点符号(用户要求: 字幕只保留文本, 不要任何标点)。
# 仅影响"显示", 不影响对齐/时间(对齐仍用含标点的原文)。
_DISPLAY_PUNCT = set(
    "，。！？；：、,.!?;:…—―~～·「」『』【】《》〈〉（）()[]｛｝{}"
    "\"'“”‘’＂＇`´「」〔〕·　￥$#*/\\|＿_-＝=+＜＞<>@＠&＆^％%"
)


def _strip_display_punct(s: str) -> str:
    """从字幕显示文本中去掉所有标点/符号, 只保留文字/字母/数字。"""
    return "".join(c for c in s if c not in _DISPLAY_PUNCT)


def _norm_for_align(text: str) -> tuple[str, list[int]]:
    """归一化原文用于对齐: 去掉空白/换行, 返回(压缩后字符串, 每个压缩字符在原文中的下标)。"""
    buf = []
    idx = []
    for i, c in enumerate(text):
        if c in _STRIP_FOR_DISPLAY:
            continue
        buf.append(c)
        idx.append(i)
    return "".join(buf), idx


def _split_lines(orig: str, max_chars: int) -> list[tuple[int, int]]:
    """把原文切成"单行"短句, 返回每句在原文中的 [start,end) 下标区间。
    规则: 优先在标点处断; 超过 max_chars 强制断; 跳过纯空白。
    """
    spans: list[tuple[int, int]] = []
    n = len(orig)
    i = 0
    line_start = None
    count = 0  # 当前行的可见字符数
    while i < n:
        c = orig[i]
        if c in _STRIP_FOR_DISPLAY:
            # 换行视为强制断句
            if line_start is not None and count > 0:
                spans.append((line_start, i))
                line_start = None
                count = 0
            i += 1
            continue
        if line_start is None:
            line_start = i
            count = 0
        count += 1
        # 标点断句(标点归入本行)
        if c in _BREAK_PUNCT and count >= 1:
            spans.append((line_start, i + 1))
            line_start = None
            count = 0
            i += 1
            continue
        # 超长强制断
        if count >= max_chars:
            spans.append((line_start, i + 1))
            line_start = None
            count = 0
        i += 1
    if line_start is not None and count > 0:
        spans.append((line_start, n))
    return spans


def _build_orig2time(chars: list[CharTime], orig_norm: str) -> list[Optional[tuple[float, float]]]:
    """difflib 对齐: 返回归一化原文每个字符的 (start,end); 未对齐处为 None。"""
    asr = "".join(c.ch for c in chars)
    o2t: list[Optional[tuple[float, float]]] = [None] * len(orig_norm)
    if not asr or not orig_norm:
        return o2t
    sm = SequenceMatcher(None, asr, orig_norm, autojunk=False)
    for a0, b0, size in sm.get_matching_blocks():
        for k in range(size):
            ct = chars[a0 + k]
            o2t[b0 + k] = (ct.start, ct.end)
    return o2t


def _fill_gaps(o2t: list[Optional[tuple[float, float]]]) -> list[tuple[float, float]]:
    """把未对齐(None)的字符时间用就近/插值补齐, 保证单调不减。"""
    n = len(o2t)
    if n == 0:
        return []
    # 找到首个/末个已知
    known = [i for i, v in enumerate(o2t) if v is not None]
    if not known:
        return [(0.0, 0.0)] * n
    filled: list[tuple[float, float]] = [(-1.0, -1.0)] * n
    # 已知点直接填
    for i in known:
        filled[i] = o2t[i]  # type: ignore
    # 头部: 用首个已知的 start
    first = known[0]
    for i in range(0, first):
        filled[i] = (o2t[first][0], o2t[first][0])  # type: ignore
    # 尾部: 用末个已知的 end
    last = known[-1]
    for i in range(last + 1, n):
        filled[i] = (o2t[last][1], o2t[last][1])  # type: ignore
    # 中间空洞: 在相邻已知点之间线性插值
    ki = 0
    for gi in range(len(known) - 1):
        a = known[gi]
        b = known[gi + 1]
        if b - a <= 1:
            continue
        ta = o2t[a][1]  # type: ignore  # 前一已知 end
        tb = o2t[b][0]  # type: ignore  # 后一已知 start
        span = b - a
        for j in range(a + 1, b):
            frac = (j - a) / span
            t = ta + (tb - ta) * frac
            filled[j] = (t, t)
    # 单调修正
    prev = 0.0
    for i in range(n):
        s, e = filled[i]
        if s < prev:
            s = prev
        if e < s:
            e = s
        filled[i] = (s, e)
        prev = s
    return filled


def _fmt_ts(t: float) -> str:
    if t < 0:
        t = 0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    if ms == 1000:
        ms = 999
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def generate_srt(audio_path: str, original_text: str, srt_path: str, *,
                 max_chars_per_line: int = 18) -> bool:
    """生成与配音同步、内容用原文、单行的 SRT 文件。成功返回 True。

    max_chars_per_line: 单行最大可见字符数(前端会按字号再保证不溢出, 这里控制断句粒度)。
    """
    try:
        chars = _transcribe_chars(audio_path)
    except Exception as e:  # noqa: BLE001
        logger.warning("whisper transcribe failed: %s", e)
        return False
    if not chars:
        logger.warning("whisper produced no timestamps")
        return False

    orig_norm, norm2orig = _norm_for_align(original_text)
    if not orig_norm:
        return False
    o2t = _build_orig2time(chars, orig_norm)
    times = _fill_gaps(o2t)  # 归一化原文每字的时间

    # 归一化下标 → 时间; 需要把"原文下标"映射到"归一化下标"以取时间
    orig2norm: dict[int, int] = {orig_i: k for k, orig_i in enumerate(norm2orig)}

    spans = _split_lines(original_text, max_chars_per_line)
    lines: list[tuple[float, float, str]] = []
    for (a, b) in spans:
        disp = original_text[a:b].strip()
        disp = re.sub(r"\s+", "", disp)
        if not disp:
            continue
        # 过滤"无实义"行: 仅由符号/标点组成(如 markdown 标题符号 #、列表符 *、- 等)。
        # 之前上传 .md 小说开头的 "# 标题" 会把 "#" 当成首条字幕(ffmpeg 还可能因该行报 rc=234)。
        if not re.search(r"[\u4e00-\u9fffA-Za-z0-9]", disp):
            continue
        # 去掉行首残留的 markdown 标记(# 号标题、* - 列表符)
        disp = re.sub(r"^[#*\-\s]+", "", disp)
        # 用户要求: 字幕只保留文本, 去掉所有标点符号(不影响上面的时间对齐)
        disp = _strip_display_punct(disp)
        if not disp:
            continue
        # 该句在归一化序列中的可见字符下标
        norm_idxs = [orig2norm[i] for i in range(a, b) if i in orig2norm]
        if not norm_idxs:
            continue
        start = times[norm_idxs[0]][0]
        end = times[norm_idxs[-1]][1]
        if end <= start:
            end = start + 0.4
        lines.append((start, end, disp))

    if not lines:
        return False

    # 相邻字幕时间修正: 保证不重叠、按序
    lines.sort(key=lambda x: x[0])
    fixed: list[tuple[float, float, str]] = []
    for s, e, t in lines:
        if fixed and s < fixed[-1][1]:
            s = fixed[-1][1]
        if e <= s:
            e = s + 0.4
        fixed.append((s, e, t))

    with open(srt_path, "w", encoding="utf-8") as f:
        for i, (s, e, t) in enumerate(fixed, 1):
            f.write(f"{i}\n{_fmt_ts(s)} --> {_fmt_ts(e)}\n{t}\n\n")
    return True