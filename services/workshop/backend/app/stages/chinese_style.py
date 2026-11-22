"""中文文风闸门 (Chinese Style Gate) —— 检测翻译腔与外语残留。

背景（用户明确要求）：
  本项目的戏剧方法论大量参考国外开源项目（McKee/Truby/Snyder/Vogler、
  storyrepo、writeAgent 等）。这些项目的方法论框架本身有价值，但**表述是英文的**，
  直接搬进 prompt 容易把"翻译腔"带进产出，甚至出现外语原文、英式剧集标题、
  欧美剧结构术语（"第三幕转折点""B故事线""救猫咪"）。

  光在 prompt 里叮嘱"要用中文"不够——模型仍会偶发。这里提供**零 LLM 的确定性检测**，
  把"像不像中文短剧"变成可机检的门槛，与 drama_gate 同一套 issue schema。

设计原则：
  - 只查**确凿**的问题，不评判文笔好坏（那是 dialogue_reviewer 的职责）；
  - 允许行业标准英文术语（OS/VO/JSON 键名）——它们在剧本格式里有明确定义；
  - 中文短剧里合法出现的英文字母（如"X光""A股""B超"）不误报。

⚠️ 用途边界：本模块只用于检查**产出内容**（大纲字段、剧本正文）。
   **不要**拿它去检查 prompt 模板自身——drama_principles 里本来就以反例形式列举了
   "救猫咪""B故事线"等术语（告诉模型"不要说这些"），扫 prompt 会把反例当问题报出来。
"""
from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# 1. 翻译腔高危句式（英文直译的典型结构）
#     这些不是"文笔不好"，而是"读起来像翻译过来的"，与中文短剧的表达习惯相悖。
# ---------------------------------------------------------------------------
TRANSLATIONESE_PATTERNS: list[tuple[str, str]] = [
    ("这是一个关于", "英文 'It's a story about' 的直译"),
    ("一个关于", "英文 'a story about' 的直译"),
    ("旅程", "英文 'journey' 的直译，中文说'经历/转变'"),
    ("一段成长", "英文 'a journey of growth' 的直译"),
    ("人生旅程", "英文 'life journey' 的直译"),
    ("的弧光", "英文 'arc' 的直译，中文说'转变/成长'"),
    ("内心世界被", "英文 'inner world' 的直译"),
    ("被深深触动", "英文 'deeply moved' 的直译"),
    ("与此同时", "英文 'meanwhile' 的直译，中文说'这时/另一边'"),
    ("值得注意的是", "英文 'notably/it is worth noting' 的直译"),
    ("在某种程度上", "英文 'to some extent' 的直译"),
    ("这不仅仅是", "英文 'this is not just' 的直译"),
    ("的存在", "英文 'the existence of' 的直译"),
    ("令人惊叹", "英文 'breathtaking' 的直译"),
    ("充满了", "英文 'full of' 的直译（中文更常说'全是/都是'）"),
    ("展现了", "英文 'showcases' 的直译"),
    ("彰显了", "英文 'highlights' 的直译"),
    ("对…进行了", "英文 'conducted ... on' 的直译"),
    ("正如我们所知", "英文 'as we know' 的直译"),
    ("毫无疑问的是", "英文 'there is no doubt that' 的直译"),
]

# ---------------------------------------------------------------------------
# 2. 欧美剧结构术语（国外参考项目的方法论名词，不该出现在中文短剧文案里）
# ---------------------------------------------------------------------------
WESTERN_TERMS: list[tuple[str, str, str]] = [
    # (术语, 来源, 中文建议说法)
    ("救猫咪", "Save the Cat (Snyder)", "开场钩子/立人物"),
    ("B故事线", "B Story (Snyder)", "副线/感情线"),
    ("B故事", "B Story", "副线"),
    ("第三幕", "Act Three", "后段/收尾"),
    ("第二幕", "Act Two", "中段"),
    ("第一幕", "Act One", "开场/前段"),
    ("幕转折点", "Act Turn", "转折"),
    ("英雄之旅", "Hero's Journey (Campbell/Vogler)", "主角成长线"),
    ("节拍表", "Beat Sheet (Snyder)", "分集节奏/剧情节点"),
    ("节拍点", "Beat", "剧情节点"),
    ("叙事弧", "Narrative Arc", "主线走向"),
    ("人物弧光", "Character Arc", "人物转变"),
    ("主题陈述", "Theme Stated", "立意/主题"),
    ("中点反转", "Midpoint", "中段反转"),
    ("黑暗时刻", "Dark Night of the Soul", "最低谷"),
    ("灵魂黑夜", "Dark Night of the Soul", "最低谷"),
    ("叫板", "Call to Adventure", "召唤/开局事件"),
    ("跨越门槛", "Crossing the Threshold", "进入正题"),
]

# 行业标准英文术语：在剧本格式里有明确定义，不视作问题
ALLOWED_TOKENS = {
    "OS", "VO", "JSON", "NPC", "URL", "ID", "AI",
}

# 中文短剧里合法出现的英文字母组合（单位/型号/常见缩写）
_ALLOWED_ALPHA_RE = re.compile(
    r"^(?:"
    r"[A-Z]{1,3}\d*"          # A股 / X光 / B超 / VIP / 4K
    r"|OS|VO|JSON|NPC|URL|ID|AI"
    r")$"
)


# ---------------------------------------------------------------------------
# 检测
# ---------------------------------------------------------------------------

# 连续 2 个以上拉丁字母构成的"词"（单个字母如 A/B 不算，可能是型号或倍速）
_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'\-]{1,}")
_CJK_RE = re.compile(r"[一-鿿]")
# 完整英文句子：含空格且词数 >= 4 的拉丁文本
_EN_SENTENCE_RE = re.compile(r"(?:[A-Za-z][A-Za-z'\-]*\s+){3,}[A-Za-z][A-Za-z'\-]*")
# 西里尔/日文假名/韩文——非中文剧本里出现的直接是外语正文
_FOREIGN_SCRIPT_RE = re.compile(r"[Ѐ-ӿ぀-ヿ가-힯]")


def _coerce(text) -> str:
    if isinstance(text, str):
        return text
    if isinstance(text, (list, dict)):
        import json
        try:
            return json.dumps(text, ensure_ascii=False)
        except Exception:  # noqa: BLE001
            return str(text)
    return str(text or "")


def scan_chinese_style(text, *, where: str = "", episode: int | None = None) -> list[dict]:
    """对一段中文文案跑文风检查，返回 issue 列表（与 drama_gate 同 schema）。

    where: 定位说明（如"第3集标题"），会进 message 与 detail。
    episode: 这段文案属于第几集。调用方知道集号时**务必传**——报告卡靠它渲染
      集号徽章，聊天摘要的"先修这几条"也靠它定位。不传（如"全剧标题/全剧主线"
      这类全剧级文案）就是 None，界面会照实不显示集号。
    """
    issues: list[dict] = []
    t = _coerce(text)
    if not t.strip():
        return issues

    # 1) 西里尔/假名/韩文 —— 直接是外语正文
    hits = set(_FOREIGN_SCRIPT_RE.findall(t))
    if hits:
        issues.append({
            "level": "error",
            "code": "foreign_script",
            "episode": episode,
            "message": f"{where}出现非中文字符（{''.join(sorted(hits))[:20]}），剧本必须是中文",
            "detail": {"hits": "".join(sorted(hits))[:40], "where": where},
            "fix_hint": "把外语原文改为中文；确需保留的专名要同时给中文译名",
        })

    # 2) 完整英文句子
    en_sent = _EN_SENTENCE_RE.search(t)
    if en_sent:
        issues.append({
            "level": "error",
            "code": "english_sentence",
            "episode": episode,
            "message": f"{where}出现完整英文句子：「{en_sent.group(0)[:50]}」",
            "detail": {"snippet": en_sent.group(0)[:80], "where": where},
            "fix_hint": "改用中文表达；确需保留的专有名词只保留名字本身，不要整句英文",
        })

    # 3) 孤立英文单词（排除行业术语与合法缩写）
    words = [w for w in _WORD_RE.findall(t)]
    suspicious: list[str] = []
    for w in words:
        if w in ALLOWED_TOKENS or _ALLOWED_ALPHA_RE.match(w):
            continue
        # 全大写 2-4 字母多为缩写（如 OST/BGM），单独提醒即可；长词或驼峰词更可疑
        if len(w) <= 4 and w.isupper():
            continue
        suspicious.append(w)
    if suspicious:
        uniq = sorted(set(suspicious))[:8]
        issues.append({
            "level": "warn",
            "code": "english_words",
            "episode": episode,
            "message": f"{where}出现英文单词：{'、'.join(uniq)}",
            "detail": {"words": uniq, "where": where},
            "fix_hint": "改写成中文；若为品牌名/专名，请同时给出中文称呼",
        })

    # 4) 欧美剧结构术语
    term_hits = [(term, src, sug) for term, src, sug in WESTERN_TERMS if term in t]
    for term, source, suggest in term_hits:
        if any(term != other and term in other for other, _, _ in term_hits):
            continue   # 被更长的术语包含，丢弃
        if True:
            issues.append({
                "level": "warn",
                "code": "western_term",
                "episode": episode,
                "message": f"{where}出现欧美剧结构术语「{term}」（源自 {source}）",
                "detail": {"term": term, "source": source, "where": where},
                "fix_hint": f"改用中文短剧的说法：{suggest}",
            })

    # 5) 翻译腔句式
    #    去重：命中多个互相包含的模式时（如"这是一个关于" ⊃ "一个关于"），
    #    只保留最长的那个，避免同一句话被报两遍。
    hits = [(pat, why) for pat, why in TRANSLATIONESE_PATTERNS if pat in t]
    kept: list[tuple[str, str]] = []
    for pat, why in hits:
        if any(pat != other and pat in other for other, _ in hits):
            continue   # 被更长的模式包含，丢弃
        kept.append((pat, why))
    for pat, why in kept:
        issues.append({
            "level": "warn",
            "code": "translationese",
            "episode": episode,
            "message": f"{where}有翻译腔：「{pat}」（{why}）",
            "detail": {"pattern": pat, "reason": why, "where": where},
            "fix_hint": "按中文口语习惯重写，别按英文语序直译",
        })

    return issues


# 大纲里值得检查文风的字段（标题与描述性文字；纯枚举字段不查）
_OUTLINE_TEXT_FIELDS = ("title", "synopsis", "core_push", "stakes", "escalation",
                        "audience_knows_delta")


def scan_outline_style(outline: dict | None) -> list[dict]:
    """检查整部大纲的中文文风。零 LLM。

    覆盖：全剧标题/主线、各集标题与描述字段、伏笔文本、禁止项。
    """
    issues: list[dict] = []
    ol = outline or {}

    for field, label in (("title", "全剧标题"), ("synopsis", "全剧主线")):
        v = str(ol.get(field) or "").strip()
        if v:
            issues += scan_chinese_style(v, where=label)

    for ep in (ol.get("chapters") or ol.get("episodes") or []):
        if not isinstance(ep, dict):
            continue
        order = ep.get("order")
        # 集号一路传给 scan_chinese_style —— 报告卡的集号徽章、聊天摘要的
        # "先修这几条"都读 issue["episode"]。以前这里只把集号写进 where 文案，
        # episode 字段恒为 None，界面就只能显示"第—集：第1集synopsis出现…"
        # （集号在文案里重复一遍、徽章却是空的）。
        ep_no = int(order) if isinstance(order, int) or (
            isinstance(order, str) and order.isdigit()) else None
        for f in _OUTLINE_TEXT_FIELDS:
            v = ep.get(f)
            if isinstance(v, str) and v.strip():
                issues += scan_chinese_style(v, where=f"第{order}集{f}", episode=ep_no)
        # 伏笔/禁止项
        for key, label in (("plant", "伏笔"), ("payoff", "伏笔"), ("forbidden", "禁止项")):
            for item in (ep.get(key) or []):
                if str(item).strip():
                    issues += scan_chinese_style(str(item), where=f"第{order}集{label}",
                                                 episode=ep_no)
        # 契约里的 value_shift / hook
        vs = ep.get("value_shift") or {}
        for k in ("from", "to"):
            if str(vs.get(k) or "").strip():
                issues += scan_chinese_style(str(vs[k]), where=f"第{order}集价值转变",
                                             episode=ep_no)
        ho = ep.get("hook_out") or {}
        for k in ("type", "strength", "leads_to"):
            v = str(ho.get(k) or "").strip()
            # type/strength 是枚举值，交给 drama_gate 的枚举校验，这里只查 leads_to
            if k == "leads_to" and v:
                issues += scan_chinese_style(v, where=f"第{order}集结尾卡点", episode=ep_no)

    # 去重（同一句在多个字段出现时只报一次）
    seen: set[tuple] = set()
    out: list[dict] = []
    for it in issues:
        key = (it["code"], it["message"])
        if key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out
