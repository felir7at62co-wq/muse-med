"""导入「大纲」解析 (需求3)。

支持两类大纲并存:
  1) 单集: 「第3集：…」「第三集 …」「3. …」等 → 直接成一集
  2) 混合集: 「第41-43集：…」 → 必须按剧情拆成 41/42/43 三集 (调 Gemini)

最大兼容人类写法的集号标记; 解析后产出统一的单集列表。
拆解失败时降级为"平均挂集+标【待拆分】", 绝不丢数据。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger("import_outline")

# ── 中文数字 → 阿拉伯数字 ─────────────────────────────────────────
_CN_NUM = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
    "百": 100, "千": 1000,
}


def cn_to_int(s: str) -> int | None:
    """把中文数字串转为 int。支持 '四十三' / '一百二十' / '十' 等; 失败返回 None。"""
    s = s.strip()
    if not s:
        return None
    if s.isdigit():
        return int(s)
    if not all(ch in _CN_NUM for ch in s):
        return None
    total = 0
    section = 0
    for ch in s:
        v = _CN_NUM[ch]
        if v >= 10:  # 十/百/千 单位
            if section == 0:
                section = 1
            section *= v
            total += section
            section = 0
        else:
            section = v
    total += section
    return total or None


def _to_int(token: str) -> int | None:
    """阿拉伯或中文数字串 → int。"""
    token = token.strip()
    if token.isdigit():
        return int(token)
    return cn_to_int(token)


# ── 行首集号标记正则 ──────────────────────────────────────────────
# 数字或中文数字片段
_NUM = r"[0-9]+|[零〇一二两三四五六七八九十百千]+"
# 区间分隔符: - — ~ ～ 到 至
_RANGE_SEP = r"\s*(?:-|—|–|~|～|到|至)\s*"

# 单集前缀, **按体例分开**。顺序即强弱: 越靠前越不可能是正文。
#
# ⛔ 这里曾经是一条大而全的 _RE_SINGLE, 把所有体例 or 在一起 ——
# 结果「行首是数字 + 标点」的任何一行都被当成新的一集。
# 而**写得最细的那几集**恰恰就是正文里带节拍清单的:
#     第1集 命运的齿轮
#     1. 开场：雨夜，林晚站在灵堂外。
#     2. 冲突：沈知远当众撕毁遗嘱。
# 于是第1集的正文在「1.」处被斩断, 只剩标题那一句, 而 4 条节拍各自变成一「集」。
# 用户看到的就是「前面几集被压缩成一两句」+「60 集变 67 集」。
#
# 修法: 先通篇扫一遍选定**唯一的集号体例**, 只有该体例才算集边界,
# 其余体例一律当正文并入本集。见 _elect_style()。
_STYLE_PATTERNS: list[tuple[str, re.Pattern]] = [
    # 第3集 / 第三集 / 第3话 / 第3章
    ("episode", re.compile(rf"^\s*第\s*({_NUM})\s*(?:集|话|章)\s*[:：.、\)）]?\s*")),
    # EP3 / EP.3 / EP 3
    ("ep", re.compile(r"^\s*EP\.?\s*([0-9]+)\s*[:：.、\)）]?\s*", re.IGNORECASE)),
    # E3 (要求后面不再跟字母, 免得吃掉 "End" 之类)
    ("e", re.compile(r"^\s*E\s*([0-9]+)(?![A-Za-z])\s*[:：.、\)）]?\s*", re.IGNORECASE)),
    # 【3】
    ("bracket", re.compile(rf"^\s*【\s*({_NUM})\s*】\s*[:：.、]?\s*")),
    # (3) / （3）
    ("paren", re.compile(r"^\s*[\(（]\s*([0-9]+)\s*[\)）]\s*[:：.、]?\s*")),
    # 3. / 3、 / 三、 / 3)
    ("bare", re.compile(rf"^\s*({_NUM})\s*[.、:：\)）]\s*")),
]
_STYLE_RX = dict(_STYLE_PATTERNS)
# 「带第/集/话/章」的体例几乎不可能出现在正文行首, 视为强体例: 一出现就独占。
# 弱体例(纯数字编号)必须靠序列形态来判断到底是集号还是节拍号。
_STRONG_STYLES = ("episode", "ep", "e", "bracket")
_WEAK_STYLES = ("paren", "bare")

# 区间: 第41-43集 / 第四十一至四十三集 / 41-43集 / 第41~43话
#
# ⛔ 旧写法里「第」和「集」两侧全是可选的, 于是正文里的
#     2019-2020年，两人分居两地。 / 18-25岁观众 / 3-5个反转 / 30—40秒高潮
# 全都被当成「合并集区间」, 每个都凭空多出 end-start+1 集,
# 而且还会真的去调一次大模型把它「拆」成几集。
# 现在要求: 起始侧必须有「第」, 或者数字后面必须带 集/话/章。
_RE_RANGE_MARKED = re.compile(
    rf"^\s*(?:"
    rf"第\s*({_NUM})\s*(?:集|话|章)?{_RANGE_SEP}(?:第)?\s*({_NUM})\s*(?:集|话|章)?"
    rf"|({_NUM})\s*(?:集|话|章){_RANGE_SEP}(?:第)?\s*({_NUM})\s*(?:集|话|章)?"
    rf")\s*[:：.、\)）]?\s*"
)
# 裸区间 41-43 只在「大纲本来就用裸数字编号」时才认, 且后面不能跟量词/单位
_RE_RANGE_BARE = re.compile(
    rf"^\s*({_NUM}){_RANGE_SEP}({_NUM})\s*(?![0-9])"
    rf"(?!\s*(?:年|岁|个|集?字|字|秒|分钟|分|小时|天|万|千|百|元|块|人|%|％))"
    rf"\s*[:：.、\)）]?\s*"
)
# 区间最大跨度: 防止把 "2-3000" 之类当成 2999 集
_RANGE_MAX_SPAN = 200


def _match_single(line: str, style: str):
    """按选定体例匹配单集前缀, 返回 (order:int, rest:str) 或 None。"""
    rx = _STYLE_RX.get(style)
    if rx is None:
        return None
    m = rx.match(line)
    if not m:
        return None
    n = _to_int(m.group(1))
    if n is None:
        return None
    rest = line[m.end():].strip()
    # 小数陷阱: "3.5万彩礼" 会被 bare 体例读成「第3集, 正文 5万彩礼」
    if style == "bare" and rest[:1].isdigit():
        return None
    return n, rest


def _match_range(line: str, style: str):
    """匹配区间前缀, 返回 (start:int, end:int, rest:str) 或 None。"""
    m = _RE_RANGE_MARKED.match(line)
    if m:
        groups = [g for g in m.groups() if g]
        a, b = _to_int(groups[0]), _to_int(groups[1])
    elif style in _WEAK_STYLES:
        # 裸区间只在弱体例大纲里认 —— 「第N集」体例的正文里出现 2019-2020 是叙述, 不是集号
        m = _RE_RANGE_BARE.match(line)
        if not m:
            return None
        a, b = _to_int(m.group(1)), _to_int(m.group(2))
    else:
        return None
    if a is None or b is None or b < a:
        return None
    if b - a > _RANGE_MAX_SPAN:
        return None
    return a, b, line[m.end():].strip()


def _monotonic_len(nums: list[int]) -> int:
    """贪心数出「像集号序列」的长度: 从头扫, 只数严格大于上一个被接受值的。

    集号 1,2,3,…,60 → 60。
    节拍号 1,2,3,4 在每集里重复 → [1,2,3,4,1,2,3,4,…] 只得 4。
    这个差距就是区分「集号」和「节拍号」的依据。
    """
    last = float("-inf")
    n = 0
    for v in nums:
        if v > last:
            n += 1
            last = v
    return n


def _elect_style(lines: list[str]) -> str:
    """通篇扫一遍, 选出这份大纲实际使用的集号体例。

    规则:
      1. 只要出现过强体例(第N集 / EPn / En / 【n】), 就用其中最强的那个,
         其余行一律当正文 —— 这是本次修复的核心。
      2. 都没有, 才在弱体例(纯数字编号)里按「序列单调性」挑:
         集号会一路递增, 节拍号会反复从 1 重来。
    """
    hits: dict[str, list[int]] = {name: [] for name, _ in _STYLE_PATTERNS}
    for line in lines:
        line = line.strip()
        if not line:
            continue
        # 区间行(第1-3集)也算 episode 体例的证据
        if _RE_RANGE_MARKED.match(line):
            hits["episode"].append(0)
            continue
        for name, rx in _STYLE_PATTERNS:   # 强→弱, 命中即止
            m = rx.match(line)
            if m:
                n = _to_int(m.group(1))
                if n is not None:
                    hits[name].append(n)
                break

    for name in _STRONG_STYLES:
        if hits[name]:
            return name

    best, best_score = "bare", -1
    for name in _WEAK_STYLES:
        score = _monotonic_len(hits[name])
        if score > best_score:
            best, best_score = name, score
    return best


def parse_outline_text(text: str) -> list[dict]:
    """把大纲文本切成条目列表。

    返回: [{kind:'single', order, body} | {kind:'range', start, end, body}, ...]
    无法识别集号的行, 并入上一条目的 body (避免割裂)。
    """
    raw = (text or "").replace("\r\n", "\n")
    lines = raw.split("\n")
    style = _elect_style(lines)
    weak = style in _WEAK_STYLES
    # 弱体例下额外要求集号递增: 正文里的节拍清单会从 1 重新数起, 据此剔除
    last_order = float("-inf")

    items: list[dict] = []
    cur: dict | None = None

    def push():
        nonlocal cur
        if cur is not None:
            cur["body"] = cur["body"].strip()
            items.append(cur)
            cur = None

    for rawline in lines:
        line = rawline.strip()
        if not line:
            if cur is not None:
                cur["body"] += "\n"
            continue
        # 先试区间(更具体), 再试单集
        rng = _match_range(line, style)
        if rng and not (weak and rng[0] <= last_order):
            push()
            a, b, rest = rng
            last_order = b
            cur = {"kind": "range", "start": a, "end": b, "body": rest}
            continue
        sgl = _match_single(line, style)
        if sgl and not (weak and sgl[0] <= last_order):
            push()
            order, rest = sgl
            last_order = order
            cur = {"kind": "single", "order": order, "body": rest}
            continue
        # 普通行: 并入当前条目
        if cur is None:
            # 文首没有任何集号的引言, 暂存为 order=0 容器, 后续丢弃或并入
            cur = {"kind": "single", "order": 0, "body": line}
        else:
            cur["body"] += ("\n" if cur["body"] else "") + line
    push()

    # 丢弃 order=0 的"引言"残留 (文首没写集号的那段话, 如《某某》分集大纲),
    # 它不是真正的集。结尾悬空的集号行(`第3集：`后面什么都没有)解析出的 order
    # 是正数, 不会被这里丢弃 —— 它会在 build_outline_chapters 里被拦下报错,
    # 而不是静默少一集。
    cleaned = [it for it in items if not (it["kind"] == "single" and it.get("order") == 0)]
    return cleaned or items


# ─────────────────────────────────────────────────────────────────────────
# 四栏表格格式识别（2026-10-09）
#
# 用户自己的大纲工作台（/root/script-workbench）产出的是五栏结构：
#
#     【本集对手】陆家雇的占房人
#     【核心冲突】父亲的灵堂上，大伯拿来族里收回土地的文件……
#     【转折爽点】他两份都没碰。他先把三碗饭端进里屋……
#     【集尾断点】陆建国在车里看着，打了一个电话……
#     【本集具体动作】签字桌上摆着一支旧钢笔……
#
# 这原本是**结构化**的（谁在对抗 / 冲突是什么 / 哪里转折 / 断在哪），
# 但导入时被 `build_outline_chapters` 整个塞进 `synopsis` 一根字符串，
# 再被六处 `content[:200]` 截断 —— 结构没了，只剩 200 字。
# 于是下游写剧本时，契约字段全空、节拍全空，模型只能自己编。
#
# 这里把它**解析回字段**：结构在文本里本来就有，不该被丢掉。
# ─────────────────────────────────────────────────────────────────────────

#: 栏名 → 目标字段。左侧是各种写法（用户会调整措辞），右侧是我们认的键。
_OUTLINE_TABLE_FIELDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("opponent", ("本集对手", "对手", "本集反派", "对抗方")),
    ("core_push", ("核心冲突", "核心推进", "本集核心推进点", "主要冲突", "冲突")),
    ("turn_point", ("转折爽点", "转折", "爽点", "反转", "转折点")),
    ("hook", ("集尾断点", "结尾断点", "集尾钩子", "断点", "结尾卡点", "钩子")),
    ("beats", ("本集具体动作", "具体动作", "场景节拍", "节拍", "分场", "具体情节")),
    ("stakes", ("失败代价", "代价", "风险")),
    ("plant", ("伏笔", "本集伏笔", "埋点")),
    ("payoff", ("回收", "回收伏笔", "兑现")),
)

#: 匹配形如 `【核心冲突】正文…`、`核心冲突：正文…`、`[核心冲突] 正文…` 的行。
#:
#: 🔴 2026-10-09 实测修正：用户工作台的真实格式是
#:     `【本集对手】谢宛如与池煜`   —— **栏名后没有冒号**。
#: 第一版正则强制要求 `[：:]`，于是对真实数据**一条都匹配不上**，
#: 解析器静默返回 {}，即"改完看着没问题、实际结构照旧全丢"。
#: 现在冒号是可选的；有 `【】` 包裹时**以括号为准**，不看冒号。
_TABLE_FIELD_RE = re.compile(
    r"^"
    r"(?:[【\[（(]\s*(?P<bracketed>[^】\]）)]{1,12})\s*[】\]）)]"   # 【栏名】 / [栏名]
    r"|(?P<plain>[^：:【】\[\]]{1,12}))"                            # 栏名：(裸栏名必须带冒号)
    r"\s*[：:]?\s*"
    r"(?P<value>.*)$"
)


def parse_structured_fields(body: str) -> dict:
    """把四栏/五栏表格格式的大纲正文解析成结构化字段。

    返回 `{"opponent": ..., "core_push": ..., "beats": [...], ...}`；
    **认不出任何栏时返回空 dict**（调用方据此走老的"整段当 synopsis"行为）。

    ## 为什么用"栏名表 + 逐行扫"而不是正则一把梭
    用户会改措辞（"转折爽点"→"爽点"、"集尾断点"→"断点"），硬编码一个正则
    在下次措辞变化时就静默失效 —— 而失效的表现是"结构又没了"，不会报错。
    用一张**可扩展的别名表**，加一行就能认新写法。

    ## 多行值
    栏的正文可能换行（用户写长了会手动折行）。这里把**直到下一个栏名**为止的
    所有行都算作当前栏的值 —— 否则折行部分会被当成新栏而丢失。
    """
    text = (body or "").replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        return {}

    # 栏名 → 目标键
    alias: dict[str, str] = {}
    for key, names in _OUTLINE_TABLE_FIELDS:
        for n in names:
            alias[n] = key

    found: dict[str, list[str]] = {}
    cur_key: str | None = None
    for raw_line in text.split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        m = _TABLE_FIELD_RE.match(line)
        name = ""
        value = ""
        if m:
            # 有【】包裹时以括号内为准（真实格式没有冒号）；
            # 裸栏名那条分支**必须**带冒号才算栏名，否则会把
            # "她签了。"这种普通句子当成栏名。
            name = (m.group("bracketed") or m.group("plain") or "").strip()
            if m.group("bracketed") is None and "：" not in line and ":" not in line:
                name = ""
            value = (m.group("value") or "").strip()
        # 只有栏名**确实在别名表里**才认，否则视为上一栏的续行
        key = alias.get(name.replace(" ", "")) if name else None
        if key:
            cur_key = key
            if value:
                found.setdefault(key, []).append(value)
        elif cur_key:
            found.setdefault(cur_key, []).append(line)

    if not found:
        return {}

    out: dict[str, object] = {}
    for key, chunks in found.items():
        value = "\n".join(chunks).strip()
        if not value:
            continue
        if key in ("beats", "plant", "payoff"):
            # 列表字段：按行/分号/项目符号拆
            items = []
            for c in chunks:
                for piece in re.split(r"[\n;；]", c):
                    p = piece.strip().lstrip("-·•*0123456789.、) ").strip()
                    if p:
                        items.append(p)
            if items:
                out[key] = items
        else:
            out[key] = value
    return out


def _structured_to_chapter_fields(fields: dict) -> dict:
    """把 `parse_structured_fields` 的结果映射成集纲的字段形状。

    ⚠️ 这里刻意**不做 synopsis 拼接**：五栏里的每一栏各有归宿，把它们再揉回
    一根字符串等于又丢一次结构。synopsis 由调用方用原来的正文兜底。
    """
    ch: dict = {}
    if fields.get("core_push"):
        ch["core_push"] = fields["core_push"]
    if fields.get("stakes"):
        ch["stakes"] = fields["stakes"]
    if fields.get("plant"):
        ch["plant"] = fields["plant"]
    if fields.get("payoff"):
        ch["payoff"] = fields["payoff"]

    # 五栏 → 场景节拍。这是**关键映射**：下游写剧本时唯一"演什么"的依据。
    # 对抗/冲突/转折/断点本来就是按顺序推进的四拍，正好是 beat 的形状。
    beats: list[dict] = []
    who = str(fields.get("opponent") or "").strip()
    if fields.get("core_push"):
        beats.append({
            "at": "", "who": who,
            "action": str(fields["core_push"]).strip(),
            "turn": str(fields.get("turn_point") or "").strip(),
        })
    elif fields.get("turn_point"):
        beats.append({
            "at": "", "who": who, "action": "",
            "turn": str(fields["turn_point"]).strip(),
        })
    # 用户自己写的"本集具体动作"已经是最细的一层，优先用它做节拍
    detail = fields.get("beats")
    if isinstance(detail, list) and detail:
        for d in detail:
            beats.append({"at": "", "who": who, "action": str(d), "turn": ""})
    # 集尾断点收尾：它是本集的最后一拍
    if fields.get("hook"):
        beats.append({
            "at": "", "who": who, "action": "",
            "turn": f"【集尾断点】{str(fields['hook']).strip()}",
        })
    if beats:
        ch["beats"] = beats
    if fields.get("hook"):
        ch["hook_out"] = {"type": "", "strength": "", "leads_to": str(fields["hook"]).strip()}
    return ch


def _title_from_summary(summary: str, maxlen: int = 16) -> str:
    """从概要里截一个短标题 (无显式标题时兜底)。"""
    s = (summary or "").strip().replace("\n", " ")
    # 取第一句 (中文句号/逗号/分号前)
    m = re.split(r"[。.!！?？;；,，]", s, maxsplit=1)
    head = (m[0] if m else s).strip()
    return head[:maxlen] if head else ""


def _split_single_body(body: str) -> tuple[str, str]:
    """单集 body 拆成 (title, summary)。

    若首行像标题(短、无句末标点)则取作 title, 其余为 summary; 否则 title 由 summary 精炼。
    """
    body = (body or "").strip()
    if not body:
        return "", ""
    lines = [l.strip() for l in body.split("\n") if l.strip()]
    first = lines[0]
    rest = "\n".join(lines[1:]).strip()
    # 首行短且无句末标点 → 当标题
    if len(first) <= 20 and not re.search(r"[。.！!？?]$", first) and rest:
        return first[:16], rest
    return _title_from_summary(body), body


async def _ai_split_range(start: int, end: int, body: str, provider: str = "gemini") -> list[dict]:
    """调 Gemini 把区间合并大纲拆成 N 集。失败/数量不符则降级。

    返回 [{order, title, summary, beats, ...}, ...] 覆盖 start..end。

    🔴 2026-10-09：**这次调用本来就在跑**，原先却只问回 order/title/summary 三个
    字段 —— 而 prompt 里已经明确要求"原文里的场景、人物动作、台词要点、节拍编号、
    反转与钩子必须**原样保留**"。也就是说：模型手里已经有 beats 级的信息，
    输出契约里却没有承载它的字段，只能全塞回一根 `summary` 字符串。

    现在让它**结构化回**：`beats` + 契约字段。**零额外成本**（同一次调用、
    同样一次输出，只是字段更明确），直接消掉一次信息损失。
    下游 `build_outline_chapters` 会把这些字段原样带进 outline。
    """
    from ..models.llm import get_llm
    from .adaptation import _extract_json

    n = end - start + 1
    expect_orders = list(range(start, end + 1))

    prompt = f"""你是资深短剧编剧。下面是一段「第{start}-{end}集」合并在一起的大纲(共{n}集)。
请按剧情推进, 把它**均匀拆解成恰好 {n} 集**, 集号从 {start} 到 {end} 连续, 不增不减。
每集输出该集的剧情概要(summary)、一个不超过16字的短标题(title), 以及**场景节拍(beats)**。

⚠️ 这是**切分**不是**缩写**: 原文里的场景、人物动作、台词要点、节拍编号、
反转与钩子, 必须按归属分配到对应集里**原样保留**, 不要概括、不要删减、不要合并同类项。
拆完后把 {n} 集的 summary 接起来, 信息量应当与原文相当; 原文越详细, summary 就应当越长。

## beats 是本次切分**最重要**的产出
原文里那些"第几拍、在哪儿、谁做了什么、变成了什么"，要落到对应集的 beats 里，
**一条一拍**，而不是被概括进 summary。下游写剧本时唯一能依据的就是它。
每条 beat 必须齐备四样（缺一不可）：
- `at`   地点 + 时间（如"医院走廊 夜"）—— 用原文里写明的场景；
- `who`  这一拍在场的人物 —— 同上，用原文里的名字；
- `action` 具体发生了什么（能被拍出来的动作/台词）；
- `turn` 这一拍结束时局面变成了什么。
**不得新增**原文里没有的人物、事件或反转 —— 这是切分，不是创作。

合并大纲原文:
{body}

只输出 JSON 数组, 格式:
[{{"order": {start}, "title": "短标题", "summary": "本集剧情",
   "beats": [{{"at": "地点+时间", "who": "在场人物", "action": "发生了什么", "turn": "变成了什么"}}],
   "core_push": "本集唯一核心推进点(一句话)",
   "stakes": "本集失败会失去什么(具体)",
   "hook_out": {{"type": "突然揭示|紧急危机|未完成动作|身份反转|两难选择|神秘线索|时间限制|承诺威胁|离奇消失|言外之意", "strength": "好奇|关切|迫切|生存|终极", "leads_to": "它直接引发下一集发生什么"}}}}, ...]
共 {n} 个元素, order 必须是 {expect_orders}。不要输出任何解释。"""

    async def _call_once() -> list[dict] | None:
        try:
            llm = get_llm("generate", temperature=0.4, provider=provider, max_tokens=4096)
            resp = await llm.ainvoke(prompt)
            data = _extract_json((resp.content or "").strip())
            if isinstance(data, list) and len(data) == n:
                out = []
                for i, item in enumerate(data):
                    if not isinstance(item, dict):
                        return None
                    rec = {
                        "order": expect_orders[i],
                        "title": str(item.get("title", "") or "")[:16],
                        "summary": str(item.get("summary", "") or "").strip(),
                    }
                    # 🔴 顺手把模型已经产出的结构化字段留下来（零额外成本）。
                    # ⚠️ 只**透传**，不做归一 —— 归一统一由 outline_gen._norm_beats /
                    # _structured_to_chapter_fields 负责，避免两处各归一一次而漂移。
                    if item.get("beats"):
                        rec["beats"] = item["beats"]
                    for k in ("core_push", "stakes", "hook_out", "value_shift",
                              "escalation", "must_have", "characters"):
                        v = item.get(k)
                        if v not in (None, "", [], {}):
                            rec[k] = v
                    out.append(rec)
                if all(o["summary"] for o in out):
                    return out
            return None
        except Exception as e:  # noqa: BLE001
            logger.warning("range split AI call failed (%d-%d): %s", start, end, e)
            return None

    res = await _call_once()
    if res is None:
        res = await _call_once()  # 重试 1 次
    if res is not None:
        return res

    # 降级: 平均挂集, summary 相同并标【待拆分】, 让用户在预览页手动改
    logger.warning("range %d-%d split failed, degrade to placeholder", start, end)
    return [
        {
            "order": o,
            "title": "【待拆分】",
            "summary": f"【待拆分 第{start}-{end}集合并大纲, 请手动拆分本集】\n{body}",
        }
        for o in expect_orders
    ]


async def parse_and_split_outline(text: str, provider: str = "gemini") -> list[dict]:
    """完整流程: 解析文本 → 区间用 AI 拆解 → 合并 → 按 order 排序去重。

    返回统一单集列表 [{order, title, summary}, ...] (order 可能断号/重复, 交前端纠错)。
    """
    items = parse_outline_text(text)
    result: list[dict] = []
    for it in items:
        if it["kind"] == "single":
            title, summary = _split_single_body(it["body"])
            # ⛔ 空正文的**真集**必须保留, 不能 continue 掉。
            #    早先这里是 `if not summary: continue`, 用途是丢掉文首没写集号的
            #    "引言"残留 —— 但正文为空的真集也会被一起吃掉, 而且毫无痕迹:
            #    用户贴「第1集…第2集…第3集：」(结尾集号后漏写内容),
            #    导入出来就是 2 集, 不报错、不提示, 用户以为系统漏了他的内容。
            #    现在保留空集, 由 build_outline_chapters 抛
            #    "第3集大纲为空, 请补充内容或删除该集后再创建" —— 宁可报错,
            #    不可静默少一集。order=0 的引言残留由 parse_outline_text 负责清理。
            result.append({"order": it["order"], "title": title, "summary": summary})
        else:  # range
            split = await _ai_split_range(it["start"], it["end"], it["body"], provider=provider)
            result.extend(split)
    # 按 order 稳定排序 (保留断号/重复, 供前端纠错)
    result.sort(key=lambda x: x["order"])
    return result


def has_unsplittable_range(text: str) -> bool:
    """文本里是否存在需要 AI 拆解的合并集(如「第41-43集：…」)吗?

    用途: 调用方可以先问一句, 决定要不要为这次解析准备 provider / 花一次 LLM 调用。
    逐集写全的大纲(最常见)会返回 False, 于是整条路径零成本、零等待。
    """
    return any(it.get("kind") == "range" for it in parse_outline_text(text))


def build_outline_chapters(episodes: list[dict], *, start_order: int = 1) -> list[dict]:
    """把单集列表 [{order, title, summary}] 转成 outline.chapters 结构。

    ⚠️ 这份结构是**三个页面共同的渲染依据**, 必须与各页面读的键完全一致:
        · 草稿页   drafts/[id]/page.tsx           读 outline.chapters
        · 大纲页   drafts/[id]/outline/page.tsx   读 outline.chapters (回退 episodes)
        · 对话页   chat-studio/page.tsx           读 outline.episodes (回退 chapters)
      历史上两处入口(HTTP 导入路由 / 对话工具)各写一份, 一旦漂移就会出现
      "导入成功但页面空白"这种最难查的故障。故收敛到这一个函数。

    start_order: 追加到已有大纲时传"现有最大 order + 1", 保证不覆盖已有集。

    校验: summary 为空即抛 ValueError (空集卡片在页面上无法编辑也无法生成)。
    order 一律重排为连续整数——用户手写的集号常有笔误, 断号/重号都会让前端错位。
    """
    if not episodes:
        raise ValueError("至少需要 1 集大纲")

    empty = [e for e in episodes if not str(e.get("summary", "")).strip()]
    if empty:
        # order=0 的都是"只写了集号、后面没内容"的悬空条目(常见于用户从别处
        # 复制时漏掉了结尾), 报成"第0集"会让人摸不着头脑, 单独说清楚。
        parts = []
        for e in empty:
            o = int(e.get("order", 0) or 0)
            parts.append(f"第{o}集" if o > 0 else "末尾只有集号、没写内容的条目")
        raise ValueError(f"{'、'.join(parts)}大纲为空, 请补充内容或删除该集后再创建")

    ordered = sorted(episodes, key=lambda e: int(e.get("order", 0) or 0))
    chapters: list[dict] = []
    for i, e in enumerate(ordered):
        order = int(start_order) + i
        summary = str(e.get("summary", "")).strip()
        ch = {
            "order": order,
            "title": (e.get("title") or f"第{order}集").strip(),
            "synopsis": summary,
            "must_have": [],
            "characters": [],
        }
        # 🔴 2026-10-09：识别四栏/五栏表格格式，把结构**还回字段**。
        #
        # 用户工作台产出的大纲本来就是结构化的（本集对手/核心冲突/转折爽点/
        # 集尾断点/本集具体动作），但导入时整个塞进一根 synopsis 字符串，
        # 再被 `content[:200]` 之类的截断削掉大半 → 下游写剧本时契约全空、
        # 节拍全空，只能自己编。结构在文本里本来就有，不该丢。
        #
        # ⚠️ 认不出任何栏时 `parse_structured_fields` 返回 {}，此处原样跳过，
        # 行为与改前**完全一致** —— 普通散文式大纲不受影响。
        struct = parse_structured_fields(summary)
        if struct:
            ch.update(_structured_to_chapter_fields(struct))

        # 🔴 2026-10-09：`_ai_split_range` 现在会回结构化字段，这里要接住。
        #
        # 它原先只回 order/title/summary，所以这条路上游明明已经调了 LLM、
        # 模型也已经被要求"原样保留节拍编号与钩子"，产出却在落库时被压成
        # 一根 summary 字符串。现在把 models 给的结构化字段原样带进 outline。
        #
        # ⚠️ 顺带把 `must_have` 从"永远空数组"改成"有就带上"：
        # 空 must_have 会让下游 `format_must_have` 落到"本集未单独列出必备情节点"，
        # 而模型其实已经给出了关键情节。老数据本是空数组，不受影响。
        for _k in ("must_have", "characters"):
            _v = e.get(_k)
            if isinstance(_v, list) and _v:
                ch[_k] = [str(x).strip() for x in _v if str(x or "").strip()]

        # beats：先取 AI 拆出来的；没有再用四栏解析出来的（两者都是"已有的结构"）
        if not ch.get("beats"):
            _b = e.get("beats")
            if _b:
                from .outline_gen import _norm_beats
                _nb = _norm_beats(_b)
                if _nb:
                    ch["beats"] = _nb

        # 契约字段：同样是"模型给了就带上"
        from .outline_gen import _coerce_intensity
        for _k in ("core_push", "stakes", "escalation", "forbidden",
                   "audience_knows_delta"):
            _v = str(e.get(_k) or "").strip()
            if _v:
                ch[_k] = _v
        for _k in ("plant", "payoff"):
            _v = e.get(_k)
            if isinstance(_v, list):
                ch[_k] = [str(x).strip() for x in _v if str(x or "").strip()]
        for _k in ("value_shift", "hook_in", "hook_out", "char_knows_delta", "power"):
            _v = e.get(_k)
            if isinstance(_v, dict) and _v:
                ch[_k] = _v
        _ei = _coerce_intensity(e.get("emotion_intensity"))
        if _ei:
            ch["emotion_intensity"] = _ei

        chapters.append(ch)
    return chapters


def make_outline(title: str, chapters: list[dict], synopsis: str = "(从大纲导入)") -> dict:
    """组装完整的 outline 对象(含 title/synopsis/characters/world 骨架)。

    ⚠️ 只改 chapters 时必须**整树重写**并 flag_modified, JSONB 列的就地改不落库。
    """
    return {
        "title": title,
        "synopsis": synopsis,
        "characters": [],
        "world": {},
        "chapters": chapters,
    }


__all__ = ["parse_outline_text", "parse_and_split_outline", "cn_to_int",
           "has_unsplittable_range", "build_outline_chapters", "make_outline"]