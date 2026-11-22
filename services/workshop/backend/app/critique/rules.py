"""非 LLM 硬校验层 (客观锚 1)。

在 LLM 审查之前先跑, 便宜、确定、可解释, 结果直接进编辑工单。
当前实现 AI 腔黑名单 + 重复句式 + 旁白占比统计 (纯本地, 无需模型)。
"""
from __future__ import annotations

import re
from collections import Counter

# AI 腔黑名单: 命中即作为 low/mid 问题定位
AI_CLICHE_PATTERNS = [
    "不愧是", "果然", "我倒要看看", "这一刻", "那一刻", "心中一紧", "嘴角勾起",
    "眼中闪过", "不禁", "暗暗", "缓缓", "淡淡地", "冷冷地", "幽幽地",
    "仿佛整个世界", "时间仿佛静止", "空气仿佛凝固", "一字一句", "意味深长",
    "深吸一口气", "握紧了拳头", "瞳孔骤缩", "嘴角微微",
]


def _coerce_str(text) -> str:
    """把传入内容统一成字符串。

    剧本(storyboard)精修时, 编辑模型可能把 new_text 直接返回成 JSON 数组/对象
    (list/dict) 而非字符串, 下游若直接 .splitlines() 会抛
    'list' object has no attribute 'splitlines'。这里兜底转字符串。
    """
    if isinstance(text, str):
        return text
    if text is None:
        return ""
    if isinstance(text, (list, dict)):
        import json as _j
        try:
            return _j.dumps(text, ensure_ascii=False)
        except Exception:  # noqa: BLE001
            return str(text)
    return str(text)


def _iter_lines(text) -> list[str]:
    return [ln.strip() for ln in _coerce_str(text).splitlines() if ln.strip()]


# ---------------------------------------------------------------------------
# 旁白降级判定（2026-09-19）
#
# 口径来自《小说转竖屏AI剧剧本》那套流程的四级降级优先级：
#   ① 能写成**对话**的 → 角色对白（最高优先级）
#   ② 能写成**动作**的 → ▲动作 + 神态，**不加 OS**
#   ③ 需要保留内心活动的 → `角色 os：`（最后手段）
#   ④ 与上下文不通 / 与画面重复的 → 直接删掉
#
# 我们**不自动改**（只给建议），理由与 `polish/ai_taste.py` 的 C 类零权重
# 是同一个取信逻辑：编剧判断优先于规则。
#
# 本模块只做**能确定性判出来的那一档**：旁白里如果含"他是/她认为/于是/因为"
# 这类**转述他人的心理或因果解释**，它天然可以改写成对白或动作；
# 而"多年以后回想起来"这类跨时间跨度的人生感悟属于**该保留**的一档。
# 语义上的细分留给 LLM 审查，这里给的是**位置与依据**。
# ---------------------------------------------------------------------------

#: 旁白里出现这些词 → 它多半在替观众解释因果/心理，而不是在叙事。
#: 命中的建议降级到 ①（对话）或 ②（动作）。
_NARR_EXPLAIN_MARKERS = (
    "因为", "所以", "于是", "因此", "原来", "其实", "之所以",
    "他认为", "她觉得", "他知道", "她知道", "他明白", "她明白",
    "他以为", "她以为", "他想", "她想", "心里想", "心中想",
    "原因是", "这意味着", "说明", "证明",
)

#: 这些开头的旁白属于"该保留"的一档（③）：跨时间跨度的回顾、
#: 身份确认、重大揭晓前的铺垫。**不得**判它该降级。
_NARR_KEEP_MARKERS = (
    "多年以后", "后来才", "多年后", "回想", "记忆里", "那一年",
    "重生", "醒来", "直到那天", "很久以后", "许多年后", "再次",
)

#: 旁白行前缀的识别（`旁白：` / `画外音：` / `VO：` / `vo：` / `NARRATION:`）
#:
#: ⚠️ **不能开 `re.I`**：实测踩过 —— 开了以后拉丁分支里的 `vo` 变成不区分
#: 大小写的通用模式，会在中文里乱配，把 `林母：` / `顾总：` 当成旁白行，
#: 于是全体台词都被判成"旁白占比过高"。所以大小写变体**逐个列出来**。
#:
#: 拉丁词两侧用 `\b` 收边：否则 `voice：` 里的 `vo` 也会被认成前缀。
_NARR_LINE_RE = re.compile(
    r"^\s*(?:(?:旁白|旁述|画外音|念白|内心独白)\s*[:：]"
    r"|(?:VO|vo|Vo|NARRATION|narration)\s*[:：])\s*(?P<body>.+)$")


def _is_narration_line(line: str) -> str:
    """旁白行 → 返回旁白正文；不是旁白行返回空串。

    ⚠️ **只认显式前缀**。不做"没有冒号的就是旁白"这种推断 ——
    剧本正文里大量动作行（`△他推门进来`）没有冒号，
    按"无冒号即旁白"会把整篇动作描写误判成旁白，比不判更糟。
    """
    m = _NARR_LINE_RE.match(line or "")
    return (m.group("body") or "").strip() if m else ""


def classify_narration(text) -> list[dict]:
    """逐条旁白给出"该降级到哪一级"的**建议**（不改稿）。

    返回 `[{line_no, text, suggest, reason, confidence}]`：
      · `suggest` ∈ {"dialogue", "action", "os_ok"} 对应 ①②③；
      · 判不出来的**不出现在结果里**（宁缺勿滥，避免刷屏）；
      · 第 ④ 级（该删）需要与画面对照，本地判不了，交给 LLM 审查。
    """
    out: list[dict] = []
    for i, ln in enumerate(_iter_lines(text), start=1):
        body = _is_narration_line(ln)
        if not body or len(body) < 4:
            continue
        # ③ 优先判：该保留的一档不能被 ① 的标记词抢走
        # （"后来才明白，原来…"同时命中两边，此时按"该保留"处理）
        if any(k in body for k in _NARR_KEEP_MARKERS):
            out.append({
                "line_no": i, "text": body, "suggest": "os_ok",
                "reason": "跨时间跨度的回顾/身份确认类旁白，属于该保留的一档",
                "confidence": 70,
            })
            continue
        hits = [k for k in _NARR_EXPLAIN_MARKERS if k in body]
        if hits:
            # 有引号/对话迹象 → 更像"本来该直接说出来的话"
            looks_like_speech = bool(re.search(r"[“「『].+[”」』]", body)) or "：" in body
            out.append({
                "line_no": i, "text": body,
                "suggest": "dialogue" if looks_like_speech else "action",
                "reason": f"含解释性表述（{'、'.join(hits[:3])}），"
                          f"可用对白或动作呈现，不必由旁白代说",
                "confidence": 60,
            })
    return out


def scan_text(text) -> list[dict]:
    """对一段正文跑非 LLM 规则, 返回 issue dict 列表 (与 LLM issue 同 schema)。"""
    issues: list[dict] = []
    text = _coerce_str(text)
    if not text:
        return issues

    # 1) AI 腔黑名单
    cliche_hits = Counter()
    for pat in AI_CLICHE_PATTERNS:
        cnt = text.count(pat)
        if cnt:
            cliche_hits[pat] = cnt
    for pat, cnt in cliche_hits.most_common():
        issues.append({
            "severity": "low" if cnt == 1 else "mid",
            "role": "rule_ai_cliche",
            "issue": f"AI 腔高频词「{pat}」出现 {cnt} 次",
            "evidence": pat,
            "fix_hint": f"删除或替换「{pat}」，改用具体动作/潜台词表达",
            "locator": {"scene_no": "全篇"},
            "confidence": 100,
        })

    # 2) 重复句子检测 (完全相同的非短句重复出现)
    lines = _iter_lines(text)
    line_counts = Counter(ln for ln in lines if len(ln) >= 8)
    for ln, cnt in line_counts.items():
        if cnt >= 2:
            issues.append({
                "severity": "mid",
                "role": "rule_repeat",
                "issue": f"重复句式出现 {cnt} 次",
                "evidence": ln[:60],
                "fix_hint": "避免重复表达，改写其中一处或删除",
                "locator": {"scene_no": "全篇"},
                "confidence": 100,
            })

    # 3) 旁白占比统计 (无引号对白占比过高预警)
    if lines:
        dialogue = sum(1 for ln in lines if ('“' in ln or '"' in ln or '：' in ln or ':' in ln))
        narration_ratio = 1 - dialogue / len(lines)
        if narration_ratio > 0.7 and len(lines) >= 6:
            issues.append({
                "severity": "low",
                "role": "rule_narration",
                "issue": f"旁白/叙述占比偏高 (~{int(narration_ratio*100)}%)，对白偏少",
                "evidence": f"{len(lines)} 行中仅 {dialogue} 行含对白",
                "fix_hint": "短剧应以对白和动作推进，适当把叙述转为对白/冲突",
                "locator": {"scene_no": "全篇"},
                "confidence": 100,
            })

    # 4) 旁白降级建议 (2026-09-19)
    #
    # 与第 3 条的分工：第 3 条报**比例**（便宜、但只说"多了"），
    # 这条报**逐条该怎么改**（编剧真正会用的那条）。
    # 建议分级见 `classify_narration` 的注释；这里只把"该降级"的那一档
    # 落成 issue，`os_ok`（该保留）**不产生 issue** —— 它是用来防误报的。
    # 逐条最多报 5 处，避免刷屏把真问题淹掉。
    _suggests = [d for d in classify_narration(text) if d["suggest"] != "os_ok"]
    for d in _suggests[:5]:
        to_dialogue = d["suggest"] == "dialogue"
        issues.append({
            "severity": "low",
            "role": "rule_narration_level",
            "issue": ("旁白可降级为" +
                      ("角色对白" if to_dialogue else "动作描写/画面")),
            "evidence": f"第 {d['line_no']} 行：{d['text'][:60]}",
            "fix_hint": (("这段内容更适合由角色**说**出来。"
                          "改写成对白能同时提供信息与人物性格。")
                         if to_dialogue else
                         ("不必由旁白代说：改写成 ▲动作 + 神态，"
                          "让观众自己看出来。")),
            "locator": {"scene_no": "全篇", "line_no": d["line_no"]},
            "confidence": d["confidence"],
        })
    if len(_suggests) > 5:
        issues.append({
            "severity": "low",
            "role": "rule_narration_level",
            "issue": f"另有 {len(_suggests) - 5} 处旁白同样可降级（未逐条列出）",
            "evidence": f"全篇共 {len(_suggests)} 处",
            "fix_hint": "先用上面的 position 逐条处理前 5 处，改完再跑一次即可看到剩余的。",
            "locator": {"scene_no": "全篇"},
            "confidence": 60,
        })

    return issues


def storyboard_to_text(shots_json) -> str:
    """把剧本分镜 JSON 拍平成纯文本供规则/审查 (台词+动作)。"""
    if not shots_json:
        return ""
    parts: list[str] = []
    seq = shots_json if isinstance(shots_json, list) else shots_json.get("shots", [])
    for sh in (seq or []):
        if not isinstance(sh, dict):
            parts.append(str(sh))
            continue
        no = sh.get("shot_no") or sh.get("no") or ""
        desc = sh.get("description") or sh.get("action") or sh.get("scene") or ""
        line = sh.get("line") or sh.get("dialogue") or sh.get("台词") or ""
        spk = sh.get("speaker") or sh.get("character") or sh.get("角色") or ""
        seg = f"[{no}] {desc}".strip()
        if line:
            seg += f"\n{spk}：{line}" if spk else f"\n{line}"
        parts.append(seg)
    return "\n\n".join(parts)