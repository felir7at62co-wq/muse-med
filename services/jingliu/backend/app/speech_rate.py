"""本项目**实测**的语速（字/秒），给 agent 当判断依据，而不是给一个平台常数。

## 为什么不用常数（2026-10-24 用户裁定）

用户原话：「你给的那个语速标准完全不对，不能让 agent 使用。agent 应该自己判断语速。」

核过库里数据，这个判断成立：

  · 拿 74 个**已正常出片**的带台词镜头反查，原先的 `dialogue_floor`
    （按 `NATURAL_CPS = 3.1` 字/秒）把其中 **40 个（54%）** 判成"台词念不完"
    —— 而它们全都顺利出片、没人反馈过语速问题。
  · 实测跨度 **1.80 ~ 4.76 字/秒（p10~p90），差 2.7 倍**。3.1 恰好是这批镜头的
    **中位数** —— 拿中位数当下限，注定判掉一半。
  · 那个常数当初只标定于 **n=2** 个样本。
  · **项目之间也不一样**：四个有 ASR 字幕的 dev 项目实测分别是
    3.77 / 3.33 / 4.09 / 3.07 字/秒。

所以本模块的立场是：**字数是事实（数得出来），语速是每个项目自己的数据（量得出来）。**
量不出来就如实说"没数据"，让模型自己判断——**绝不填一个常数冒充事实**。

## 两个数据源，优先级从高到低

1. **ASR 字幕**（`subtitle_clips`）：从**真实出片音轨**转写，带句级时间戳。
   这是最硬的证据 —— 它就是这条视频里人实际怎么念的。
   它反映的是**视频模型**（seedance / 海螺）音画一体的语速。
2. **TTS 旁白**（`audio_clips`，kind=narration/tts）：`text` 是念的原文，
   `duration` 是合成音频的实测长度。反映的是 **TTS 引擎**的语速。

⚠️ **两者不可混用**：TTS 朗读旁白约 6.1 字/秒，视频模型念台词约 3.3 字/秒，
差了近一倍。拿旁白的语速去判断台词镜要多久，会得出"这一镜 3 秒就够"的荒谬结论。
所以返回值**按来源分开报**，让模型自己知道该用哪一组。
"""
from __future__ import annotations

import logging
import statistics

from .db import AudioClip, Shot, SubtitleClip, get_session

logger = logging.getLogger("fw.speech_rate")

#: 少于这么多条样本就不下结论（n=2 标定出 3.1 那次就是教训）。
MIN_SAMPLES = 8

#: 单条样本的合理区间。超出这个范围的多半是数据坏了，而不是真的念这么快/慢：
#:   · < 0.8 字/秒：字幕时间戳把静音也算了进去（一条 8 字的字幕挂 10 秒）
#:   · > 9 字/秒：两镜的字幕叠在一起、或字幕文本被重复计入
#: 剔除而不是钳制 —— 钳过的值会假装成证据。
SANE_MIN = 0.8
SANE_MAX = 9.0


def _spoken_chars(text: str) -> int:
    """字幕文本 → 发声字数。ASR 结果里的标点不算念出来的字。"""
    return sum(1 for ch in (text or "") if ch.strip() and ch not in "，。！？、；：…—·「」『』“”\"'（）()《》【】")


def _stats(vals: list[float]) -> dict:
    vals = sorted(vals)
    n = len(vals)
    return {
        "samples": n,
        "cps_median": round(statistics.median(vals), 2),
        #: 区间而不是单值 —— 模型要的是"这批镜头大概在什么范围"，不是一条线
        "cps_p10": round(vals[max(0, int(n * 0.1))], 2),
        "cps_p90": round(vals[min(n - 1, int(n * 0.9))], 2),
    }


def _anchor_check(shots_by_order: dict, subs_by_order: dict) -> dict:
    """字幕锚点体检：这批字幕**真的**锚在它该在的那一镜上吗？

    ## 为什么必须有这一步（2026-10-24 实测）

    「有字幕就以字幕为准」这句话成立的前提是**锚点没坏**。实测四个项目：

        7fd29f5231bf  124/124 条锚对
        c4ac5414f04f   58/58
        df2c3415248b  100/100
        13fd3b2ba28e   **7/104**，且 10/23 镜的字幕总时长**超过镜头本身**

    最后那个项目的字幕是 2026-09-07 生成的，之后镜头重排过，锚点没跟着走。
    用它的字幕算"这镜实测语速"，得到的是**别的镜**的语速 —— 数字看着很正常，
    但指向错误的内容，比没有数据坏得多。

    ## 判据只用**物理不可能**，不做内容匹配

    「字幕总时长 > 这一镜在成片里占的时长」是硬矛盾：一镜 4.57 秒，上面挂了
    11 秒字幕，多出来的那 6 秒必然属于别的镜头。这条判据不会误伤
    （字幕可以比镜头略长一点点吗？不行，那已经是错位了）。

    刻意**不用**「字幕字数 vs 剧本解析字数差太多」来判：两者差异也可能来自
    剧本解析本身不准（小说体、台词跨镜），那是另一回事，混进来会让判据既
    误报又说不清原因。

    返回 `{"checked", "overflow_shots", "trusted", "reason"}`。
    `trusted=False` 时调用方**必须**拒绝给出逐镜实测语速。
    """
    checked = overflow = 0
    examples = []
    for order, rows in subs_by_order.items():
        sh = shots_by_order.get(order)
        if sh is None:
            continue
        # ⚠️ 比的是**源秒对源秒**（2026-10-24 修）。
        #
        # 字幕的 `duration` 是按**源文件秒**记的（ASR 转写的是镜头视频本身），
        # 而 `shot_output_sec` 是成片秒 = 源秒 / speed。拿源秒去比成片秒，
        # 1.7 倍速的镜头会显得"字幕比镜头长 70%"，于是整批字幕被误判成锚点损坏。
        #
        # 实测：项目 `fa5cd6854a0e`（1023）8 镜全部 1.7~1.8 倍速，这条判据把它
        # 判成 `trusted=False`，于是 agent 拿不到任何实测语速 —— 而它的锚点
        # 其实完全正确，按 `subtitle_output_span` 换算后 0 条越界。
        # 同一份数据在修复前是"17/29 条越界"，看着像严重损坏。
        from .shot_timing import shot_source_window
        span = sum(float(c.duration or 0) for c in rows
                   if float(c.duration or 0) > 0.2)
        if span <= 0.2:
            continue
        shot_sec = float(shot_source_window(sh)[1])
        if shot_sec <= 0:
            continue
        checked += 1
        # 容差 1 秒：字幕时间戳是 ASR 给的，末条略有出入不算错位。
        if span > shot_sec + 1.0:
            overflow += 1
            if len(examples) < 5:
                examples.append({"order": order,
                                 "subtitle_sec": round(span, 1),
                                 "shot_sec": round(shot_sec, 1)})
    if checked < 3:
        # 样本太少，判不了。**不判为可信**：宁可说"没数据"。
        return {"checked": checked, "overflow_shots": overflow, "trusted": False,
                "reason": f"只有 {checked} 个镜头能对照，无法判断字幕锚点是否可靠"}
    bad_ratio = overflow / checked
    if bad_ratio > 0.25:
        return {"checked": checked, "overflow_shots": overflow, "trusted": False,
                "reason": (f"{overflow}/{checked} 个镜头的字幕总时长超过镜头本身"
                           f"（成片时长），说明字幕锚点已经错位——"
                           "这批字幕不能用来判断这一镜的语速"),
                "examples": examples}
    return {"checked": checked, "overflow_shots": overflow, "trusted": True,
            "reason": (f"{overflow}/{checked} 个镜头有溢出"
                       + ("（在容差内）" if overflow else ""))}


def measure(project_id: str) -> dict:
    """量这个项目自己的语速。量不出来就明说，**不拿常数顶上**。

    返回：`{"ok", "asr": {...}|None, "tts": {...}|None, "note"}`
    """
    from .drama_timing import split_units

    asr_vals: list[float] = []
    tts_vals: list[float] = []

    with get_session() as s:
        # ---- 1) ASR 字幕：真实出片音轨的转写 ----
        subs = (s.query(SubtitleClip)
                .filter(SubtitleClip.project_id == project_id).all())
        # 先做锚点体检：锚错了的字幕不能用来算语速（见 `_anchor_check`）
        shots = (s.query(Shot).filter(Shot.project_id == project_id).all())
        by_order: dict[int, list] = {}
        for c in subs:
            by_order.setdefault(int(c.start_shot_order or 0), []).append(c)
        anchor = _anchor_check({int(x.order): x for x in shots}, by_order)
        for c in subs:
            txt, dur = c.text or "", float(c.duration or 0)
            if dur <= 0.2:
                continue
            ch = _spoken_chars(txt)
            # 单条太短时比值噪声极大（"好"字挂 0.5 秒 = 2 字/秒，挂 0.3 秒 = 3.3）
            if ch < 4:
                continue
            v = ch / dur
            if SANE_MIN <= v <= SANE_MAX:
                asr_vals.append(v)

        # ---- 2) TTS 旁白：文本 + 合成音频实测长度 ----
        auds = (s.query(AudioClip)
                .filter(AudioClip.project_id == project_id,
                        AudioClip.kind.in_(("narration", "tts")),
                        AudioClip.duration > 1).all())
        for a in auds:
            dur = float(a.duration or 0)
            if dur <= 1:
                continue
            # ⚠️ 只算**发声**的字（`split_units` 剔掉 △ 动作行与舞台指示）。
            # 直接数字符会把动作描述也算进去 —— 实测那样会得到 6.1 字/秒，
            # 而真实朗读只有 4.3 左右，虚高四成。
            ch = sum(u.chars for u in split_units(a.text or "")
                     if u.kind in ("dialog", "vo"))
            if ch < 10:
                continue
            v = ch / dur
            if SANE_MIN <= v <= SANE_MAX:
                tts_vals.append(v)

    out: dict = {"ok": True, "project_id": project_id,
                 #: 字幕锚点体检结果。`trusted=False` 时下面的 asr 数据一律不采用
                 #: —— 锚错位的字幕会算出"别的镜"的语速，看着正常但指向错误内容。
                 "subtitle_anchor": anchor}
    # ⚠️ 锚点不可信时**不给 asr 数字**，哪怕样本再多。
    if anchor.get("trusted") and len(asr_vals) >= MIN_SAMPLES:
        out["asr"] = _stats(asr_vals)
        out["asr"]["source"] = ("从本项目**真实出片音轨**的 ASR 字幕测得，"
                                "反映视频模型（音画一体）念台词的语速")
    else:
        out["asr"] = None
    if len(tts_vals) >= MIN_SAMPLES:
        out["tts"] = _stats(tts_vals)
        out["tts"]["source"] = ("从本项目 TTS 合成音频的实测时长测得，"
                                "反映 TTS 引擎朗读的语速")
    else:
        out["tts"] = None

    if out["asr"]:
        out["recommended"] = "asr"
        out["note"] = ("判断**台词镜要多长**用 `asr` 那组（视频模型自己念的）。"
                       "它给的是区间不是单值：某个镜头落在 p10 附近也正常，"
                       "别把 p90 当成上限、也别拿它去否定用户的判断。")
    elif out["tts"]:
        out["recommended"] = "tts"
        out["note"] = ("没有可用的 ASR 语速数据"
                       + ("（字幕锚点不可信，见 `subtitle_anchor`）"
                          if not anchor.get("trusted") else "（样本不足）")
                       + "，只能用 TTS 那组。"
                       "⚠️ TTS 朗读通常比视频模型念台词快得多，**判断台词镜时长时要留余量**，"
                       "最好先出一镜试片、听一下再定。")
    else:
        out["recommended"] = None
        out["note"] = (f"这个项目还没有足够的实测样本（各需 ≥{MIN_SAMPLES} 条），"
                       "**没有可信的语速数据**。不要凭一个数字硬算，"
                       "按台词字数与你读剧本的理解自己判断；"
                       "已经出过片的话可以先跑 run_auto_subtitles 拿到真实时间戳再回来量。")
    if not anchor.get("trusted") and anchor.get("overflow_shots"):
        out["note"] = (f"⚠️ 字幕锚点体检未通过：{anchor['reason']}。"
                       "\n重新跑一次 run_auto_subtitles 会把字幕按当前镜序重排，"
                       "之后再来量。")
    return out


def shot_rates(project_id: str) -> dict[str, dict]:
    """逐镜的**实测**语速（只对有字幕、且锚点可信的镜头）。

    ## 为什么必须过锚点体检（2026-10-24）

    「有字幕就以字幕为准」的前提是锚点没坏。实测项目 `13fd3b2ba28e` 的
    144 条字幕里，`order=22` 上挂的其实是 `order=29` 的台词，且 10/23 镜的
    字幕总时长超过镜头本身（那批字幕是 2026-09-07 生成的，之后镜头重排过）。
    不体检就用它算逐镜语速，得到的是**别的镜**的语速 —— 数字看着很正常，
    但指向错误的内容，比没有数据坏得多。

    锚点不可信时**整个返回空 dict**，调用方拿不到 `measured_cps`，
    于是模型看不到任何假数据、只能自己判断。

    返回 `{shot_id: {subtitle_chars, subtitle_sec, cps, script_chars, output_sec}}`
    """
    from .drama_timing import dialogue_chars

    out: dict[str, dict] = {}
    with get_session() as s:
        subs = (s.query(SubtitleClip)
                .filter(SubtitleClip.project_id == project_id).all())
        if not subs:
            return out
        # 字幕锚在 order 上，先换回 shot_id 并拿到该镜的输出时长
        from .shot_timing import shot_output_sec
        shots = {int(x.order): x for x in
                 s.query(Shot).filter(Shot.project_id == project_id).all()}
        by_order: dict[int, list] = {}
        for c in subs:
            by_order.setdefault(int(c.start_shot_order or 0), []).append(c)
        # ⚠️ 锚点不可信 → 一条都不给。少给数据，好过给错数据。
        if not _anchor_check(shots, by_order).get("trusted"):
            logger.warning("[speech_rate] %s 字幕锚点体检未通过，不提供逐镜语速",
                           project_id)
            return out
        for order, rows in by_order.items():
            sh = shots.get(order)
            if sh is None:
                continue
            spoken = sum(_spoken_chars(c.text) for c in rows
                         if float(c.duration or 0) > 0.2)
            span = sum(float(c.duration or 0) for c in rows
                       if float(c.duration or 0) > 0.2)
            if spoken < 4 or span <= 0.2:
                continue
            v = spoken / span
            if not (SANE_MIN <= v <= SANE_MAX):
                continue
            out[sh.id] = {
                "subtitle_chars": spoken,
                "subtitle_sec": round(span, 2),
                "cps": round(v, 2),
                #: 剧本**解析**出来这一镜该念多少字。⚠️ 它是解析值不是实测值
                #: （实测 71 个样本里 17% 偏差 >50%，见 `dialogue_chars` 的注释）。
                #: 两个数差得多时，说明有一边不可信 —— 让模型自己看原文判断。
                "script_chars": dialogue_chars(sh.script_ref or ""),
                "output_sec": round(shot_output_sec(sh), 2),
            }
    return out
