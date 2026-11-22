"""字幕的纠正与切条（逐字时间版，2026-11-21）：识别出来的**每一个字词**带着实测时间进来，
按剧本纠正、按人的选择改、切成一条条字幕出去。

## 谁用它

- 镜流：`subtitle_jobs.run_auto_subtitles` 的 segments 模式（Muse 送来逐字时间，镜流不下载、不转写）；
- Muse：`tweet-drama-draft-build/scripts/subtitle_rules/` 里逐字节相同的一份，由 `run.py` 调用
  （Muse 的门禁 `verify-subtitle-rules-copy` 要求两份完全一样）。

所以这个模块**没有任何 IO**，除 `subtitle_align` 外不导入镜流的任何东西：纠正规则只有
`subtitle_align` 一份，这里只负责「逐字时间怎么跟着走」。

## 字词（words）

`[{start, end, text, seg?, speaker_id?}]`，按时间先后；`start`/`end` 是**这一镜源文件里**的秒
（不减取片入点、不除变速，换算见 `shot_timing.subtitle_source_span`）。`text` 可以带着
识别结果里跟在它后面的标点或空格（「了。」），切条优先在那里断开；`seg` 是它所在的识别分段，
`speaker_id` 是说话人，切条不跨这两样。

## 规则

- 纠正：每个字词当作一个识别分段交给 `subtitle_align.correct_segments`，所以每个字词保留自己的
  实测时间；长短不同的替换整段放进第一个字（「3」「18」→「三百一十八」「」），被清空的字词留着，
  它的时间并进前面那条字幕。
- 要人看的每一处（`review_items`）有稳定的编号：同一段声音、同一份识别结果、同一份台词，
  编号就不变，所以人的选择（`apply_decisions`）在别的镜头改动之后仍然有效，这一镜一变就自然作废。
- 切条（`layout_cues`）只在字词之间断开，优先断在标点或空格处，按有效字数（空格算 `space_width` 个字）
  贪心装到 `max_chars`；一条字幕的起止就是第一个和最后一个字词的时间，**从不按字数分摊时间**。
  一个字词本身就超过 `max_chars` 时单独成条并列进 `long_cue`。
"""
from __future__ import annotations

import hashlib
import json

if __package__:
    from .subtitle_align import _is_content, correct_segments, put_text
else:                       # Muse 的副本：和 subtitle_align.py 放在同一个目录里、按顶层模块导入
    from subtitle_align import _is_content, correct_segments, put_text

#: 出字幕前要洗掉的符号。**烧进画面的字幕不带标点**是短剧字幕的通行做法：
#: 一行只有十几个字、停顿由分条本身表达，标点只是占位置的噪点。
#: 只洗"断句/引述"这一类。**刻意保留** `·`（人名里的间隔号，「阿·晨」）、
#: `%`、`+`、`-`、`&`、`#`、`/`、字母与数字 —— 那些是内容，不是标点。
CUE_DROP_PUNCT = (
    "，。！？；：、…‥—～﹏"                        # 中文断句
    "\"'“”‘’「」『』《》〈〉【】〔〕（）()[]{}"      # 引号与括号
    ",.!?;:"                                       # 半角断句
)
#: 断句点（空格也算：识别结果常用空格分隔小句）。
CUE_BREAKS = frozenset("，。！？；：、,.!?;: …—\n\t")
#: 人能对一处做的选择：按听到的保留、换成剧本的字、删掉这几个字。
ACTIONS = ("heard", "script", "drop")


def _wash_punct(s: str) -> str:
    """洗掉标点，只留能读的内容。

    标点位置换成一个空格而不是直接删：句中的停顿（「朋友啊，快坐」）删掉逗号后
    要是粘成「朋友啊快坐」就读不出那个停顿了，留个空格正好是字幕里表达停顿的写法。
    首尾的空格随后被 strip 掉，所以「你就不再是我爹了。」出来就是干净一句。
    """
    out = "".join(" " if ch in CUE_DROP_PUNCT else ch for ch in s)
    return " ".join(out.split())


def _sha(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":"))
                          .encode("utf-8")).hexdigest()


def _normalize(words: list[dict]) -> list[dict]:
    """字词的副本：`start`/`end` 为浮点数、`text` 为字符串，其余字段原样带着。"""
    out = []
    for w in words or []:
        start = float(w.get("start") or 0.0)
        out.append({**w, "start": start, "end": max(start, float(w.get("end") or start)),
                    "text": str(w.get("text") or "")})
    return out


def words_sha256(words: list[dict]) -> str:
    """一份识别结果的摘要（时间取到毫秒）：要人看的编号的一部分。"""
    return _sha([[round(float(w.get("start") or 0.0), 3), round(float(w.get("end") or 0.0), 3),
                  str(w.get("text") or ""), w.get("seg"), w.get("speaker_id")] for w in words or []])


def lines_sha256(lines: list[str]) -> str:
    """这一镜台词的摘要：要人看的编号的一部分。"""
    return _sha(list(lines or []))


def _where(words: list[dict]) -> list[tuple[int, int]]:
    """识别结果里每一个参与比较的字落在哪：(第几个字词, 字词里第几个字符)。
    与 `correct_segments` 里的 `where` 是同一个口径，`spans` 的下标就指这个列表。"""
    return [(i, j) for i, w in enumerate(words) for j, ch in enumerate(w["text"]) if _is_content(ch)]


def correct_words(words: list[dict], lines: list[str],
                  names=()) -> tuple[list[dict], dict]:
    """按剧本纠正逐字识别结果 → (纠正后的字词, 统计)。

    每个字词是 `correct_segments` 的一个分段，时间一律不动；统计与按分段调用时相同
    （见 `subtitle_align.correct_segments`，`spans` 指向未纠正的字词）。
    """
    words = _normalize(words)
    segs = [{"start": w["start"], "end": w["end"], "text": w["text"]} for w in words]
    out, stats = correct_segments(segs, list(lines or []), names)
    return [{**w, "text": o["text"]} for w, o in zip(words, out)], stats


def _item(kind: str, heard: str, script: str, start: float, end: float, span, ids: tuple) -> dict:
    audio_sha, transcript_sha, lines_sha = ids
    key = [kind, audio_sha, transcript_sha, lines_sha, heard, script, f"{start:.3f}"]
    return {"id": _sha(key)[:12], "kind": kind, "heard": heard, "script": script,
            "start": round(start, 3), "end": round(end, 3), "span": span}


def _span_times(words: list[dict], where: list[tuple[int, int]], i1: int, i2: int) -> tuple[float, float]:
    """`spans` 的一处 → 这几个字的起止秒；听到的一边为空时是剧本那几个字应在的时刻。"""
    if i1 < i2:
        return words[where[i1][0]]["start"], words[where[i2 - 1][0]]["end"]
    if i1 < len(where):
        t = words[where[i1][0]]["start"]
    elif where:
        t = words[where[-1][0]]["end"]
    else:
        t = 0.0
    return t, t


def review_items(stats: dict, words: list[dict], lines: list[str], *, audio_sha: str = "",
                 transcript_sha: str | None = None, flags=()) -> list[dict]:
    """要人看的每一处 → `[{id, kind, heard, script, start, end, span}]`，按先后排。

    `stats`、`words` 来自同一次 `correct_words`（`words` 是**未纠正**的那份）。kind：
    `doubt` / `differ`（`stats` 的 `doubts` / `differs` 每一处）、`deviated`（整镜和剧本差得多）、
    `unheard`（剧本有台词、什么都没听到）、`no_script`（听到了说话、剧本这一镜没有台词）。
    `flags` 是调用方测出来的别的问题 `[{kind, start, end}]`（比如 Muse 拼包转写时跨镜头边界的
    `boundary`），`heard` 是落在那一段里的字。`span` 是 `stats.spans` 的那一处，只有能改字的几种有。
    编号 = sha256(kind, audio_sha, transcript_sha, lines_sha, heard, script, start) 的前 12 位。
    """
    words = _normalize(words)
    ids = (audio_sha or "", transcript_sha or words_sha256(words), lines_sha256(lines))
    where = _where(words)
    heard_all = "".join(words[i]["text"][j] for i, j in where)
    script_all = "".join(ch for line in lines or [] for ch in line if _is_content(ch))
    first = words[0]["start"] if words else 0.0
    last = words[-1]["end"] if words else 0.0
    items = []
    if stats.get("unheard"):
        items.append(_item("unheard", "", script_all, first, last, [0, 0], ids))
    elif stats.get("deviated"):
        items.append(_item("deviated", heard_all, script_all, first, last, [0, len(where)], ids))
    elif stats.get("no_script"):
        items.append(_item("no_script", heard_all, "", first, last, [0, len(where)], ids))
    spans = stats.get("spans") or {}
    for listed, kind in (("doubts", "doubt"), ("differs", "differ")):
        for piece, (i1, i2) in zip(stats.get(listed) or [], spans.get(listed) or []):
            start, end = _span_times(words, where, i1, i2)
            items.append(_item(kind, piece["heard"], piece["script"], start, end, [i1, i2], ids))
    for flag in flags or []:
        start, end = float(flag.get("start") or 0.0), float(flag.get("end") or 0.0)
        heard = _wash_punct("".join(w["text"] for w in words
                                    if start <= (w["start"] + w["end"]) / 2 <= end))
        items.append(_item(str(flag.get("kind") or "flag"), heard, "", start, end, None, ids))
    items.sort(key=lambda it: (it["start"], it["end"]))
    return items


def _decision_map(decisions) -> dict[str, str]:
    """`[{id, action}]` → {id: action}；认不出的动作不算（后写的为准）。"""
    out = {}
    for d in decisions or []:
        if isinstance(d, dict) and d.get("action") in ACTIONS and d.get("id"):
            out[str(d["id"])] = d["action"]
    return out


def apply_decisions(words: list[dict], stats: dict, items: list[dict], decisions) -> list[dict]:
    """把按剧本的纠正和人的选择一起落到**未纠正**的字词上 → 新的字词（时间不动）。

    没有选择时结果与 `correct_words` 的字词相同。对带 `span` 的一处：
    `heard` 保留听到的字；`script` 换成剧本的字（长短不同的整段放进第一个字，同 `correct_segments`；
    听到的一边为空时把剧本的字插在那个位置）；`drop` 删掉这几个字，字全被删掉的字词连同时间一起去掉。
    没有 `span` 的几种（`unheard` 和调用方给的 `flags`）任何选择都只算看过。
    """
    words = _normalize(words)
    chosen = _decision_map(decisions)
    where = _where(words)
    chars = [list(w["text"]) for w in words]
    spans = stats.get("spans") or {}
    for piece, (i1, i2) in zip(stats.get("fixes") or [], spans.get("fixes") or []):
        put_text(chars, where[i1:i2], piece["script"])
    dropped: set[int] = set()
    for it in items:
        action, span = chosen.get(it["id"]), it.get("span")
        if action not in ("script", "drop") or not span:
            continue
        i1, i2 = span
        want = it["script"] if action == "script" else ""
        if i1 < i2:
            put_text(chars, where[i1:i2], want)
            if action == "drop" or not want:
                dropped.update(k for k, _ in where[i1:i2])
        elif want and where:
            si, sj = where[min(i1, len(where) - 1)]
            chars[si][sj] = (want + chars[si][sj]) if i1 < len(where) else (chars[si][sj] + want)
    out = []
    for i, w in enumerate(words):
        text = "".join(chars[i])
        if i in dropped and not any(_is_content(ch) for ch in text):
            continue
        out.append({**w, "text": text})
    return out


def _width(text: str, space_width: float) -> float:
    return sum(space_width if ch == " " else 1.0 for ch in text)


def layout_cues(words: list[dict], max_chars: float, *, space_width: float = 0.5) -> list[dict]:
    """字词 → 字幕 `[{start, end, text, words: [i1, i2], seg, speaker_id, long}]`（规则见模块说明）。

    `words: [i1, i2]` 是这条字幕用到的字词下标（左闭右开）。没有可读的字的字词（被纠正清空的、
    只有标点的）跟着前一个字词走，从不在它前面断开。
    """
    words = _normalize(words)
    cues: list[dict] = []

    def text_of(idx: list[int]) -> str:
        return _wash_punct("".join(words[k]["text"] for k in idx))

    def breaks_after(k: int) -> bool:
        tail = words[k]["text"][-1:]
        nxt = words[k + 1]["text"][:1] if k + 1 < len(words) else ""
        return bool(tail and (tail in CUE_BREAKS or tail.isspace())) or bool(
            nxt and (nxt in CUE_BREAKS or nxt.isspace()))

    def flush(idx: list[int]) -> None:
        text = text_of(idx)
        if not text:
            return
        w0 = words[idx[0]]
        start = w0["start"]
        end = max(start, max(words[k]["end"] for k in idx))
        cues.append({"start": start, "end": end, "text": text, "words": [idx[0], idx[-1] + 1],
                     "seg": w0.get("seg"), "speaker_id": w0.get("speaker_id"),
                     "long": _width(text, space_width) > max_chars})

    cur: list[int] = []
    for i, w in enumerate(words):
        if cur and (w.get("seg"), w.get("speaker_id")) != (words[cur[-1]].get("seg"),
                                                          words[cur[-1]].get("speaker_id")):
            flush(cur)
            cur = []
        if cur and any(_is_content(ch) for ch in w["text"]) and \
                _width(text_of(cur + [i]), space_width) > max_chars:
            # 优先断在最后一个标点 / 空格之后；没有就断在这个字词前面
            cut = next((j for j in range(len(cur) - 1, -1, -1) if breaks_after(cur[j])), None)
            if cut is None or cut == len(cur) - 1:
                flush(cur)
                cur = []
            else:
                flush(cur[:cut + 1])
                cur = cur[cut + 1:]
                if _width(text_of(cur + [i]), space_width) > max_chars:
                    flush(cur)
                    cur = []
        cur.append(i)
    if cur:
        flush(cur)
    return cues


def shot_cues(words: list[dict], lines: list[str], names=(), decisions=(), *, max_chars: float,
              space_width: float = 0.5, audio_sha: str = "", transcript_sha: str | None = None,
              flags=()) -> dict:
    """一镜从识别结果到字幕的全过程 → `{words, cues, stats, items, pending}`。

    纠正（`correct_words`）→ 列出要人看的（`review_items`）→ 落下纠正与人的选择
    （`apply_decisions`）→ 切条（`layout_cues`），再把超过 `max_chars` 的字幕列成 `long_cue`。
    每一处带上人选的 `decision`（没选为 None），`pending` 是还没选的处数。
    """
    words = _normalize(words)
    tsha = transcript_sha or words_sha256(words)
    _fixed, stats = correct_words(words, lines, names)
    items = review_items(stats, words, lines, audio_sha=audio_sha, transcript_sha=tsha, flags=flags)
    final = apply_decisions(words, stats, items, decisions)
    cues = layout_cues(final, max_chars, space_width=space_width)
    ids = (audio_sha or "", tsha, lines_sha256(lines))
    items += [_item("long_cue", c["text"], "", c["start"], c["end"], None, ids)
              for c in cues if c["long"]]
    items.sort(key=lambda it: (it["start"], it["end"]))
    chosen = _decision_map(decisions)
    for it in items:
        it["decision"] = chosen.get(it["id"])
    return {"words": final, "cues": cues, "stats": stats, "items": items,
            "pending": sum(it["decision"] is None for it in items)}
