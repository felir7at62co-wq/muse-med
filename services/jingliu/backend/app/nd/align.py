"""对齐：模型原片里每句台词实际在哪 → 剪辑方案（只算参数，不渲染）。

## 为什么边界由音量决定、不用 ASR 字级时间戳

百炼的字级戳是「词时长按字均分」，长句末尾偏差可达 1 秒以上（2026-10-30 实测：
林倩一句实际 10.0s 前已说完，ASR 把句尾标到 11.8s，紧跟的「用不着」被整句并进上一句）。
所以：

  1. 音量切出「有声片段」（边界准）；
  2. 每个片段单独识别（并发）——一段的文字只属于这一段；
  3. 片段按文字顺序对应到台词：一句对多段时取「命中最多、多余最少」的连续几段
     （模型常先嘟囔半句再完整说一遍）；一段里含两句（两人之间没停顿）就在
     估计分界附近找音量低谷切开；片段里台词之外多出 ≥3 个字就裁掉。

## 产出：剪辑单元（时间轴上首尾相接）

  · dlg  台词：原画原声，只裁两端静音（前留 0.12s、后留 0.20s）
  · narr 旁白/画外音：原声静音，换上 TTS；画面按 0.6–2.0 倍变速贴合 TTS 时长
  · sfx  音效（喵呜——）：按计划窗保留原声；被真实台词挤占时让位
  · fill 模型漏念的台词：计划窗画面、原声静音，由流水线补 TTS（见 pipeline）

相邻两句台词的截取区间若交叠（余量 + 短句最短时长造成），在两句实际发声的中点切开——
否则交叠那段会播两遍，听着像「抽搐复读」（2026-10-30 用户报）。
"""
from __future__ import annotations

import logging
import subprocess
import uuid
import wave
from pathlib import Path

import numpy as np

from . import textutil as T

log = logging.getLogger(__name__)

PAD_IN, PAD_OUT = 0.12, 0.20
SPD_MIN, SPD_MAX = 0.6, 2.0
SR = 16000


# ------------------------------------------------------------------ 音频

def pcm(src: Path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(src), "-vn", "-ac", "1",
                          "-ar", str(SR), "-f", "s16le", "-"], capture_output=True, timeout=300).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768


def runs(x: np.ndarray) -> list[tuple[float, float]]:
    """有声片段：20ms 帧，阈值 = max(-40dB, 底噪+12dB)，间隔 <0.24s 并段，<0.15s 丢弃。"""
    hop = 320
    if len(x) < hop * 2:
        return []
    fr = x[: len(x) // hop * hop].reshape(-1, hop)
    db = 20 * np.log10(np.sqrt((fr ** 2).mean(axis=1)) + 1e-9)
    thr = max(-40.0, float(np.percentile(db, 10)) + 12)
    on = db > thr
    out, i, n = [], 0, len(on)
    while i < n:
        if not on[i]:
            i += 1
            continue
        j = i
        while j < n and (on[j] or on[j:j + 12].any()):
            j += 1
        if (j - i) * hop / SR >= 0.15:
            out.append((i * hop / SR, j * hop / SR))
        i = j
    return out


def dip(x: np.ndarray, lo: float, hi: float) -> float:
    """[lo, hi] 里音量最低的 100ms 的中点。"""
    a, b = max(0, int(lo * SR)), min(len(x), int(hi * SR))
    seg = x[a:b]
    win, hop = 1600, 160
    if len(seg) < win + hop:
        return (lo + hi) / 2
    e = [float((seg[i:i + win] ** 2).mean()) for i in range(0, len(seg) - win, hop)]
    return a / SR + (int(np.argmin(e)) * hop + win / 2) / SR


async def _asr_one(x: np.ndarray, a: float, b: float) -> list[tuple]:
    """识别一个有声片段 → [(字, 原片起, 原片止)]。

    临时文件落在素材目录下（百炼只认公网 URL，见 asr_bailian._public_url），
    识别完连同桶里的副本一起删掉。
    """
    from .. import media, storage
    from ..providers.asr_bailian import BailianASR
    a0 = max(0.0, a - 0.05)
    seg = x[int(a0 * SR): int((b + 0.05) * SR)]
    tmpdir = media.DATA_DIR / "nd_tmp"
    tmpdir.mkdir(exist_ok=True)
    p = tmpdir / f"asr_{uuid.uuid4().hex[:12]}.wav"
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(seg, -1, 1) * 32767).astype(np.int16).tobytes())
    rel = p.relative_to(media.DATA_DIR).as_posix()
    asr = BailianASR()
    try:
        url = await asr._public_url(p)
        try:
            raw = await asr._submit_and_wait(url, "zh")
        except RuntimeError as e:
            if "NO_VALID_FRAGMENT" in str(e):     # 这一段没有可识别的人声
                return []
            import re
            # ⚠️ 原始报错里带签名下载链接（含访问密钥 ID），绝不能原样外抛
            raise RuntimeError(re.sub(r"https?://\S+", "<url>", str(e))[:300]) from None
    finally:
        p.unlink(missing_ok=True)
        try:
            if storage.enabled():
                storage.delete(rel)
        except Exception:   # noqa: BLE001
            log.warning("[nd] 清理识别临时文件失败: %s", rel)
    out = []
    for tr in raw.get("transcripts") or []:
        for s in tr.get("sentences") or []:
            for wd in s.get("words") or []:
                txt = T.clean((wd.get("text") or "") + (wd.get("punctuation") or ""))
                if not txt:
                    continue
                b0, e0 = wd["begin_time"] / 1000, wd["end_time"] / 1000
                step = (e0 - b0) / len(txt)
                for k, ch in enumerate(txt):
                    out.append((ch, a0 + b0 + k * step, a0 + b0 + (k + 1) * step))
    return out


async def transcribe_runs(x: np.ndarray, rs: list[tuple[float, float]]) -> list[list[tuple]]:
    """每个有声片段**单独**识别（并发）。

    试过「全部拼成一条只识别一次」：ASR 句尾字的时间戳偏晚近 1 秒，按时间分回各段
    总会串字；「谁？」这种短句在长音频里还会被识成 "She"。单独识别时，一段的文字
    只属于这一段，边界由音量决定、不依赖时间戳。百炼按音频秒数计费，两种做法同价。
    """
    import asyncio
    return list(await asyncio.gather(*(_asr_one(x, a, b) for a, b in rs)))


# ------------------------------------------------------------------ 台词定位

def _trim_to_line(x, a, b, cs, line):
    """片段里只留与这句台词整体最吻合的那段连续文字（同分取靠后的——完整那遍通常在后）。"""
    text = "".join(c for c, _, _ in cs)
    pt, pl = T.py(text), T.py(line)
    if not cs or len(cs) != len(pt) or len(pt) <= len(pl) + 2:
        return a, b, text
    import difflib
    w = len(pl) + 2
    best, bi = -1, 0
    for i in range(0, len(pt) - w + 1):
        h = sum(m.size for m in difflib.SequenceMatcher(None, pl, pt[i:i + w], autojunk=False)
                .get_matching_blocks())
        if h >= best:
            best, bi = h, i
    lo, hi = bi, bi + w - 1
    if lo >= 3:
        a = max(a, dip(x, cs[lo][1] - 0.4, cs[lo][1] + 0.05))
    if len(pt) - 1 - hi >= 3:
        b = min(b, dip(x, cs[hi][2] - 0.05, cs[hi][2] + 0.4))
    return a, b, "".join(c for c, _, _ in cs[lo:hi + 1])


def locate(x: np.ndarray, rs, rchars, lines: list[str]) -> list[dict]:
    """有声片段 → 每句台词 {start, end, heard}（start=None = 没念）。"""
    spans: list[list] = [[] for _ in lines]
    p = 0
    for (a, b), cs in zip(rs, rchars):
        t = "".join(c for c, _, _ in cs)
        if not t or p >= len(lines):
            continue
        cand = list(range(p, min(len(lines), p + 3)))
        sc = {j: T.hits(lines[j], t) for j in cand}
        j = max(cand, key=lambda j: (sc[j], -j))
        if sc[j] < max(1, 0.3 * len(t)):
            continue                                  # 不是剧本里的话（杂音/即兴）
        nxt = j + 1
        if nxt < len(lines):
            hn = T.hits(lines[nxt], t)
            if hn >= max(2, 0.5 * len(T.clean(lines[nxt]))) and sc[j] >= 2:
                cut = dip(x, a + (b - a) * sc[j] / (sc[j] + hn) - 0.5,
                          a + (b - a) * sc[j] / (sc[j] + hn) + 0.5)
                spans[j].append((a, cut, t))
                spans[nxt].append((cut, b, t))
                p = nxt
                continue
        a, b, t = _trim_to_line(x, a, b, cs, lines[j])
        spans[j].append((a, b, t))
        p = j
    for k, (line, sp) in enumerate(zip(lines, spans)):
        if len(sp) > 1:
            best, key = sp, None
            for i in range(len(sp)):
                for j in range(i, len(sp)):
                    txt = "".join(r[2] for r in sp[i:j + 1])
                    h = T.hits(line, txt)
                    cand = (h, -(len(T.clean(txt)) - h))
                    if key is None or cand > key:
                        key, best = cand, sp[i:j + 1]
            spans[k] = best
    out = []
    for sp in spans:
        if not sp:
            out.append({"start": None, "end": None, "heard": ""})
        else:
            out.append({"start": min(r[0] for r in sp), "end": max(r[1] for r in sp),
                        "heard": "".join(r[2] for r in sp)})
    return out


# ------------------------------------------------------------------ 剪辑方案

def plan(x: np.ndarray, vdur: float, beats: list[dict], windows: list[tuple[float, float]],
         loc: dict[int, dict]) -> tuple[list[dict], list[str]]:
    """拍子 + 计划窗 + 台词定位 → 剪辑单元。返回 (units, 旁白窗里模型多说的话)。

    beats[i]["k"] ∈ narr/vo/dlg/sfx；narr/vo 需带 "dur"（TTS 实长）。
    loc：台词拍序号 → locate 的结果。
    """
    spans: dict[int, tuple] = {}
    for i, b in enumerate(beats):
        if b["k"] == "sfx":
            a, e = windows[i]
            spans[i] = (a, min(vdur, e), "sfx", {})
        elif b["k"] == "dlg":
            l = loc.get(i) or {"start": None}
            if l["start"] is not None:
                n = len(T.clean(b["text"]))
                a0, b0 = max(0.0, l["start"] - PAD_IN), min(vdur, l["end"] + PAD_OUT)
                floor = n / 5.0 + 0.25
                if b0 - a0 < floor:
                    mid = (a0 + b0) / 2
                    a0, b0 = max(0.0, mid - floor / 2), min(vdur, mid + floor / 2)
                spans[i] = (a0, b0, True, l)
            else:
                a, e = windows[i]
                spans[i] = (a, min(vdur, e), False, l)
    # 相邻台词/音效去交叠
    order = [i for i, b in enumerate(beats) if b["k"] in ("dlg", "sfx")]
    for ka, kb in zip(order, order[1:]):
        a0, a1, fa, la = spans[ka]
        b0, b1, fb, lb = spans[kb]
        if fa is True and fb is True and b0 >= a1 and lb["start"] - la["end"] < 0.6:
            b0 = a1 - 0.01
        if b0 < a1 and "sfx" in (fa, fb):
            if fa == "sfx":
                spans[ka] = (a0, max(a0, b0), fa, la)
            else:
                spans[kb] = (min(b1, a1), b1, fb, lb)
            continue
        if b0 < a1:
            ea = la.get("end") if fa is True else None
            sb = lb.get("start") if fb is True else None
            cut = (ea + sb) / 2 if (ea is not None and sb is not None and sb > ea) else (a1 + b0) / 2
            cut = min(max(cut, a0 + 0.2), b1 - 0.2)
            spans[ka] = (a0, cut, fa, la)
            spans[kb] = (cut, b1, fb, lb)
    units: list[dict] = []
    k = 0
    while k < len(beats):
        b = beats[k]
        if b["k"] in ("dlg", "sfx"):
            s, e, found, l = spans[k]
            if found == "sfx" and e - s < 0.3:
                k += 1
                continue
            units.append({"k": "sfx" if found == "sfx" else ("dlg" if found else "fill"),
                          "beat": k, "s": round(s, 3), "e": round(e, 3)})
            k += 1
            continue
        run = []
        while k < len(beats) and beats[k]["k"] in ("narr", "vo"):
            run.append(k)
            k += 1
        left = units[-1]["e"] if units else 0.0
        nxt = next((spans[j][0] for j in range(k, len(beats)) if beats[j]["k"] in ("dlg", "sfx")
                    and not (spans[j][2] == "sfx" and spans[j][1] - spans[j][0] < 0.3)), vdur)
        ws, we = left, max(left + 0.3, nxt)
        tot = sum(beats[j]["dur"] for j in run) or 1.0
        t = ws
        for j in run:
            part = (we - ws) * beats[j]["dur"] / tot
            units.append({"k": "narr", "beat": j, "s": round(t, 3), "e": round(t + part, 3)})
            t += part
    # 旁白窗里模型多说的话（成片里已静音，报告用）
    return units, []


def fit(unit: dict, target: float, vdur: float) -> dict:
    """旁白/补位单元：画面变速贴合声音（0.6–2.0 倍；窗太长取中段、太短向两侧借画面）。"""
    s, e = unit["s"], unit["e"]
    src = max(0.2, e - s)
    spd = src / target
    if spd > SPD_MAX:
        keep = target * SPD_MAX
        mid = (s + e) / 2
        s, e, spd = mid - keep / 2, mid + keep / 2, SPD_MAX
    elif spd < SPD_MIN:
        need = target * SPD_MIN
        s = max(0.0, min(s - (need - src) / 2, vdur - need))
        e, spd = s + need, SPD_MIN
    return {**unit, "s": round(max(0.0, s), 3), "e": round(min(vdur, e), 3),
            "speed": round(spd, 4), "dur": round(target, 3)}


def extra_speech(units, rs, rchars, beats) -> list[str]:
    """旁白单元窗口里模型自己说的话（被静音了，列出来给人看）。"""
    out = []
    for u in units:
        if u["k"] != "narr":
            continue
        said = "".join(c for cs in rchars for c, a, b in cs if a >= u["s"] and b <= u["e"])
        if len(said) >= 2:
            out.append(said)
    return out
