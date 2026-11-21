"""把提示词里的 `@名字` / `@名字的音色` 确定性地转写成官方编号 `@图片N` / `音频N`。

## 为什么需要它（2026-10-15 用户甲的测试暴露）

官方 Seedance 文档 §三：提示词里**必须**用「素材类型+序号」引用素材
（`图片1`、`音频1`），不认名字、不认 Asset ID。

此前把 `@名字` 换成编号这件事**只在提示词优化器里做**（靠 ctx 里的对照表让 LLM
改写）。但用户**手改过**提示词的镜头走的是"原样下发"路径（jobs.run_shot_videos
的 `override["prompt"]` 分支），**根本不经过优化器**——而镜流编辑器里每插一个
@ 块都会把提示词变成手改稿。于是：

    下发原文：「@刘盛 」说："「……」，音色参考「@刘盛的音色 」"

模型拿到的是字面上的 `@刘盛的音色`，不知道它指第几段音频。实测：参考音频是
女声（基频 222Hz），成片是男声（133Hz）——音频送到了，模型没被告知怎么用。
dev 10 月以来 160 次出片里有 13 次下发稿含未解析的 `@名字`。

## 口径

  · 只认**带 @** 的写法。裸名字不在这里动（由 `bind_bare_names` 负责，规则更严）。
  · 图片引用转成 `名字@图片N`（保留名字），音色转成 `音频N`。
  · 最长优先：`@男一号的音色` 先于 `@男一号`，不会被切开。
  · 已经是 `@图片N` / `@图N` / `音频N` 的不动（幂等，优化器的输出再过一遍无变化）。
  · 认不出的 `@名字` **原样保留**并返回给调用方记日志——不猜、不删。
  · 编号必须与真实下发顺序一致：图片在首/尾帧之后（见 video_seedance._build_images），
    所以由调用方传 `image_offset`。
"""
from __future__ import annotations

import re

#: 标签里第一个「…」就是实体名：`角色「刘盛」（本镜造型：西装）` / `场景「茶水间」（全景）`
#: / `道具「黑卡」` / `「刘盛」`（手动 @ 的兜底标签）/ `角色「刘盛」的音色`
_NAME_IN_LABEL = re.compile(r"「([^」]+)」")
#: 已经是编号的引用，不能被当成名字再转一次
_ALREADY_NUM = re.compile(r"^(?:图片?|音频)\s*\d+")


def _name_of(label: str) -> str | None:
    m = _NAME_IN_LABEL.search(label or "")
    return m.group(1).strip() if m else None


def resolve_at_refs(text: str, image_labels: list[str], audio_labels: list[str],
                    *, image_offset: int = 0) -> tuple[str, list[str]]:
    """返回 `(转写后的文本, 认不出的 @名字 列表)`。

    `image_labels[i]` 对应下发的第 `image_offset + i + 1` 张图；
    `audio_labels[i]` 对应第 `i + 1` 段音频。
    """
    if not text or "@" not in text:
        return text or "", []
    voice: dict[str, int] = {}
    for i, lb in enumerate(audio_labels or []):
        nm = _name_of(lb)
        if nm and nm not in voice:
            voice[nm] = i + 1
    image: dict[str, int] = {}
    for i, lb in enumerate(image_labels or []):
        nm = _name_of(lb)
        if nm and nm not in image:
            image[nm] = image_offset + i + 1

    # 一个 alternation、按长度降序 → 同位置最长优先。音色名带「的音色」后缀，
    # 天然比同一角色的图片名长，所以 `@刘盛的音色` 不会被 `@刘盛` 抢先命中。
    #
    # 图片转成 `名字@图片N` 而不是光秃秃的 `@图片N`（2026-10-27）：
    # 用户在编辑器里点的是「@角色X」，他要表达的是"这里是 X，长相看第 N 张图"。
    # 只剩编号的话正文里这个人就没名字了 —— 后文再提到「X」时模型对不上号，
    # 台词标注 `台词（X）` 也失去了指向。保留名字、编号紧贴其后，是生成稿本来
    # 的形态（`林晨@图片2 拎着文件袋走来`），也是下游纠错器认得的形态。
    cands: list[tuple[str, str]] = [(f"{n}的音色", f"音频{k}") for n, k in voice.items()]
    cands += [(n, f"{n}@图片{k}") for n, k in image.items()]
    cands.sort(key=lambda x: -len(x[0]))
    table = dict(cands)

    out = text
    if table:
        rx = re.compile("@\\s*(" + "|".join(re.escape(n) for n, _ in cands) + ")")
        out = rx.sub(lambda m: table[m.group(1)], out)

    # 剩下的 @名字：既不是编号、也不在清单里。原样留，报给调用方。
    unknown = []
    for m in re.finditer(r"@\s*([^\s@，。、；：,.:!?！？「」\"“”（）()]{1,24})", out):
        tok = m.group(1)
        if not _ALREADY_NUM.match(tok):
            unknown.append(tok)
    return out, unknown


# ---------------------------------------------------------------------------
# 裸名字绑定（2026-10-27）
# ---------------------------------------------------------------------------
#
# ## 问题（生产「巴郎错牵结良缘」用户丙 E11#67 / E12#74、用户丁 E11·S045）
#
# 镜流编辑器把正文里的**裸名字**（不带 `@`）也渲染成引用块，角标写着「图1」
# （app.js `promptHTML` 的 `(@?名字)` 一支）。这是有意的：裸名字只包裹不补 `@`，
# 否则编辑器每次失焦都会改写正文。「一键引用」同理，只登记 refs、不改正文。
#
# 可后端此前**只认带 `@` 的写法**（`resolve_at_refs`），于是用户在界面上看到
# 「夏依达 图1」，模型收到的却是光秃秃的「夏依达」—— 4 张人像一起送去、
# 没有一句说哪张是谁，同性别角色一多就换脸。生产实测送 ≥2 张图的镜头里
# 约 21% 是这种形态，而用户从界面上**完全看不出来**。
#
# ## 口径：界面上每一个引用块，下发时都要真的生效
#
# 不是"只补第一次出现"：界面上每处都亮着角标，只补第一处等于其余几处又成了
# 假引用块。规则与前端 `promptHTML` 逐条对齐 ——
#   · 名字取本次**实际下发**的图的标签（`image_labels`），最长优先；
#   · 台词与画面文字不是引用：`{…}`、`<d>…</d>`、`【…】`、`“…”`、`"…"`
#     （≤500 字，与前端 `protectedRanges` 同一份判据）里的名字不动；
#   · 已经绑定过的不重复绑：紧跟 `@图片N`、紧贴在 `@图片N 为/的…` 声明之后、
#     或前面就是 `@` 的，都跳过。所以本函数**幂等**。
#
# ## 只改下发稿，不写回（用户 2026-10-27 裁定）
#
# 用户视觉上引用的是「@角色X」，正文保持他写的样子；`名字@图片N` 只出现在
# 发给模型的那一份里。调用方负责不把结果写回 `gen_prompt`。

#: 台词 / 画面文字的区间（与前端 `protectedRanges` 同口径）
_PROTECT_RX = (
    re.compile(r"\{[^{}]*\}"),
    re.compile(r"<d>[\s\S]*?</d>"),
    re.compile(r"【[^【】]*】"),
)
_QUOTE_RX = (re.compile(r"“[^”]*”"), re.compile(r'"[^"]*"'))
#: 引号段长度上限，超限不保护（前端 `_QUOTE_MAX` 同值）
_QUOTE_MAX = 500
#: 名字后面已经跟着编号 → 已绑定
_BOUND_AFTER = re.compile(r"\s*@\s*图\s*片?\s*\d")
#: 名字前面紧贴着编号声明（`@图片1 为夏依达` / `@图片1 的夏依达`）→ 已绑定
_BOUND_BEFORE = re.compile(
    r"@\s*图\s*片?\s*\d+\s*(?:为|是|即|的|中的|里的|：|:|=)?\s*$")


def _protected_ranges(text: str) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for rx in _PROTECT_RX:
        out += [(m.start(), m.end()) for m in rx.finditer(text)]
    for rx in _QUOTE_RX:
        out += [(m.start(), m.end()) for m in rx.finditer(text)
                if len(m.group(0)) <= _QUOTE_MAX]
    return out


def bind_bare_names(text: str, image_labels: list[str],
                    *, image_offset: int = 0,
                    blockers: "list[str] | set[str] | None" = None,
                    ) -> tuple[str, list[str]]:
    """把正文里**界面上显示成引用块**的裸名字，下发前绑成 `名字@图片N`。

    返回 `(绑定后的文本, 绑定过的名字列表（去重、按首次出现）)`。
    编号口径与 `resolve_at_refs` 相同：`image_labels[i]` = 第 `offset+i+1` 张图，
    同名取靠前那张（前端 `byName` 同序）。

    `blockers`：项目里**全部**资产名（含本镜没送的）。参与最长优先匹配，
    命中它们（且不是本镜送了图的）就整段跳过 —— 否则「陈秀兰家」（没送的场景）
    里的「陈秀兰」会被绑成 `陈秀兰@图片1家`。生产全库扫描 340 镜命中这一类。
    前端 `promptHTML` 用同一份全项目名单做同样的拦截。
    """
    if not text or not image_labels:
        return text or "", []
    image: dict[str, int] = {}
    for i, lb in enumerate(image_labels):
        nm = _name_of(lb)
        if nm and nm not in image:
            image[nm] = image_offset + i + 1
    if not image:
        return text, []
    pool = set(image) | {b for b in (blockers or ()) if b}
    names = sorted(pool, key=len, reverse=True)
    rx = re.compile("|".join(re.escape(n) for n in names))
    guards = _protected_ranges(text)

    bound: list[str] = []
    parts: list[str] = []
    last = 0
    for m in rx.finditer(text):
        s, e = m.start(), m.end()
        nm = m.group(0)
        if any(a <= s < b for a, b in guards):
            continue
        if nm not in image:
            continue                       # 更长的、本镜没送图的实体名：整段跳过
        if len(nm) < 2:
            # 单字名（道具「马」「包」）不当裸名字绑：中文里它几乎总是词的一部分，
            # 实测「马蹄 / 马匹 / 牵马」会被绑成 `马@图片6蹄`，把正文拆坏。
            # 前端 `promptHTML` 同步不再把裸单字渲染成引用块；要引用就写 `@马`。
            continue
        if s > 0 and text[s - 1] == "@":
            continue                       # `@名字` 是 resolve 的地盘（认不出的照样留）
        if _BOUND_AFTER.match(text, e):
            continue                       # 已是 `名字@图片N`
        if _BOUND_BEFORE.search(text[max(0, s - 16):s]):
            continue                       # 已是 `@图片N 为名字`
        parts.append(text[last:e])
        parts.append(f"@图片{image[nm]}")
        last = e
        if nm not in bound:
            bound.append(nm)
    if not bound:
        return text, []
    parts.append(text[last:])
    return "".join(parts), bound


# ---------------------------------------------------------------------------
# 编号纠错（2026-10-18）
# ---------------------------------------------------------------------------
#
# ## 要解决的问题（生产实测）
#
# `gen_prompt` 里的 `@图片N` 是**写提示词那天**按当时的角色顺序算出来的，
# 之后任何一次角色增删 / 造型图补上或失效 / 顺序变化，都不会回写那串数字。
# 出片时 `_auto_inject_refs_detailed` 又按**此刻**的顺序重新编号 —— 两套编号
# 没有任何一致性校验，于是出现「提示词写 @图片1 是林婉萍，实际送出去的第 1 张
# 是王彩霞」。生产 14610 镜里实测 122 镜指错人（38 镜已成片）。
#
# ## 为什么可以确定性纠正
#
# 提示词里自己**声明**了每个编号指谁（`@图片1 为林婉萍`、`林婉萍（@图片1）`、
# `@图片1 的林婉萍`）。既然它说了 N 指 X，而我们知道 X 此刻是第几张，
# 就能把 N 改成正确的编号。这不是猜，是拿它自己的声明去纠正它自己的编号。
#
# 声明有歧义（同一个 N 被声明成两个人）或名字不在本次下发的清单里时**不动**，
# 并在返回值里报出来 —— 宁可留一个已知的错，也不做一次可能更错的改写。
#
# ⚠️ 必须**同时**替换（先换成占位符再一次性落位）。逐个 `str.replace` 会在
# 「@图片1→@图片2、@图片2→@图片1」这种互换上把两处都改成同一个编号，
# 而角色互换恰恰是这里最典型的一种错法。

#: 「@图片1 为X」/「@图片1 是X」/「@图片1：X」
_CLAIM_PREFIX = re.compile(
    r"@\s*图\s*片?\s*(\d+)\s*(?:为|是|即|=|：|:)\s*([^\s@（()），,。；;、]{1,24})")
#: 「X（@图片1）」/「X(@图片1)」/「X（参考@图片1）」
_CLAIM_PAREN = re.compile(
    r"([^\s@（()），,。；;、]{1,24})\s*[（(]\s*(?:参考|作为参考|见|见参考)?\s*"
    r"@\s*图\s*片?\s*(\d+)\s*[)）]")
#: 「@图片1 的X」/「@图片1 X」——生成稿最常见的行文
_CLAIM_SUFFIX = re.compile(
    r"@\s*图\s*片?\s*(\d+)\s*(?:的|中的|里)?\s*([^\s@（()），,。；;、]{1,24})")
#: 「X@图片1」——名字在**前面**（生成稿高频形态：「林晨@图片2 拎着文件袋走来」）
_CLAIM_BEFORE = re.compile(
    r"([^\s@（()），,。；;、]{1,24})\s*@\s*图\s*片?\s*(\d+)")

#: 编号引用本身（含 `@图N` 简写）
_NUM_REF = re.compile(r"@\s*图\s*片?\s*(\d+)")

#: 这些词出现在编号后面时**不是**实体名，是行文（"@图片1 作为角色参考"）
_NOT_A_NAME = {
    "作为", "用于", "中的", "为", "是", "参考", "素材", "图片", "角色", "场景",
    "道具", "里的", "中", "的", "和", "与", "及", "以及", "首次", "出现",
    "对应", "所示", "展示", "表示", "代表", "提供", "上传", "顺序", "编号",
    "仅", "只", "即", "也", "都", "并", "但", "而", "作为参考",
}

#: 后缀式/括注式命中时，名字开头的这些字是**连接词**，剥掉再比对。
#: ⚠️ 不能像原先那样"以这些字开头就整条丢弃"：`王彩霞（@图片1）与林婉萍（@图片2）`
#: 的第二条会捕获成「与林婉萍」，一丢就漏改一处，互换只改半边——实测踩到。
_LEADING_JOINERS = ("与", "和", "及", "以及", "、", "，", ",", "跟", "同")

#: 剥完之后若以这些字开头，才是真的行文（不是名字）
_BAD_HEAD = ("为", "是", "即", "的", "中", "里")

#: 名字前面可能拖着的**结构词/动词**：`将@图片1中的女子定义为白薇` 会捕获成
#: 「将」；`把@图片2的男士…` 同理。它们不是名字，剥掉再比对。
#: （只影响日志里"提示词说指「X」"的可读性与匹配精度，不影响删不删的判定 ——
#:  判定最后还有"整句里有没有真名"那一跳兜底。）
_LEADING_VERBS = ("将", "把", "让", "使", "令", "以", "用", "将其中", "其中")

#: 纯数字/标点不是实体名：`@图片1 的35岁中年男人` 会捕获成「35」。
#: 真有人拿纯数字当角色名吗？没有；而误判的代价是把编号改错，所以宁可放过。
_NOT_A_NAME_RX = re.compile(r"^[\d\s\.\-—~%、，。/]+$")


def _norm(n: str) -> str:
    """比对用的归一：去掉所有空白。

    场景名在不同来源里空格写法不一致（`金诚律所 密室会客室` vs
    `金诚律所密室会客室`），带空格比对会把同一个场景判成"对不上"，
    于是该改的编号没改 —— 实测踩到。
    """
    return re.sub(r"\s+", "", n or "")


def _clean_name(n: str) -> str:
    """去掉标签里常见的前后缀，只留实体名本身。

    ⚠️ 必须处理「句中转折」：`@图片1 中的女子为林晨` 这类生成稿里，
    名字前面拖着一串描述。原实现把整段 `女子为林晨` 当成名字，于是
    `_match_name` 必然对不上 —— 在剔除逻辑里会被判成"这人没送来"而
    **把一条正确的引用删掉**（实测踩到，属最坏的结果：删掉对的内容）。
    """
    n = (n or "").strip().strip("「」\"'“”")
    # ① 先切开「X为Y / X是Y」：真名在转折词**之后**
    #    （`中的女子为林晨` → `林晨`；`男性=顾耀东` → `顾耀东`）
    parts = re.split(r"[为是即：:=]", n)
    if len(parts) > 1:
        tail = parts[-1].strip()
        if tail:
            n = tail
    # ② 去掉开头的结构词（的/中的/里的 …），它们不可能属于名字
    for p in ("中的", "里的", "的", "中", "里"):
        while n.startswith(p) and len(n) > len(p) + 1:
            n = n[len(p):]
    for j in _LEADING_JOINERS:
        while n.startswith(j) and len(n) > len(j) + 1:
            n = n[len(j):]
    for v in _LEADING_VERBS:
        while n.startswith(v) and len(n) > len(v) + 1:
            n = n[len(v):]
    for p in ("角色", "场景", "道具"):
        if n.startswith(p) and len(n) > len(p):
            n = n[len(p):]
    for p in ("参考", "场景", "角色", "道具", "的"):
        if n.endswith(p) and len(n) > len(p) + 1:
            n = n[: -len(p)]
    return n.strip("「」\"'“”")


def _match_name(claimed: str, names: list[str]) -> str | None:
    """把提示词里写的名字对到本次下发清单里的名字。

    **只认归一后完全相等**（归一 = 去空白），不做包含匹配。

    ## 为什么砍掉包含匹配（2026-10-18）

    原实现允许"一边包含另一边、且唯一命中"，实测把一个场景配到了角色头上：

        「林晨的跑车内」⊃「林晨」 → 判成角色「林晨」

    于是纠错器把这一镜指向"跑车内"的 @图片N 改成了林晨那一张 —— **原本只是
    对不上的引用，被改成了一条错误的引用**。这不是"少修一处"，是"修出新的换脸"，
    比不改还糟。宁可放过，不能改错。

    真正需要的场景差异（`金诚律所 密室会客室` vs `金诚律所密室会客室`）
    在 `_norm` 去空白之后本来就是**完全相等**，不需要包含匹配兜底。
    """
    c = _clean_name(claimed)
    if not c or _NOT_A_NAME_RX.match(c):
        return None
    cn = _norm(c)
    for n in names:
        if n and cn == _norm(n):
            return n
    return None


def _collect_claims(text: str) -> list[tuple[int, int, str, int, int]]:
    """提示词里所有「编号↔名字」的声明。

    返回 `[(编号, 档位, 名字, 匹配起点, 匹配终点)]`。档位越小越可信：
    1=显式指代 / 2=括注或名字在前 / 3=行文顺带。

    ⚠️ **必须保留匹配区间**，不能只按编号聚成一个字典。同一个编号在正文里
    出现多次、各自指不同的人很常见（`@图片1 为顾耀东 … @图片1 为林晨` ——
    前者因为顾耀东没图、被 remap 挪到 1 号上撞在一起）。只按编号决策会把
    **正确的那一条一起删掉**，所以剔除逻辑要能定位到"这一处标记"。

    ⚠️ `_CLAIM_BEFORE`（`林晨@图片2`，名字**在前**）必须收进来。生成稿里
    这是高频形态（"林晨@图片2 拎着文件袋走来"），漏掉就认不出这个编号指谁，
    既不会被纠正、也不会被剔除 —— 表现为"明明写着某人，却对不上"。
    """
    out: list[tuple[int, int, str, int, int]] = []
    for tier, (rx, i_num, i_name) in enumerate((
            (_CLAIM_PREFIX, 1, 2),
            (_CLAIM_PAREN, 2, 1),
            (_CLAIM_BEFORE, 2, 1),
            (_CLAIM_SUFFIX, 1, 2)), start=1):
        for m in rx.finditer(text):
            idx = int(m.group(i_num))
            nm = (m.group(i_name) or "").strip()
            if not nm or nm in _NOT_A_NAME or nm.startswith(_BAD_HEAD):
                continue
            out.append((idx, tier, nm, m.start(), m.end()))
    return out


def _claims_covering(claims: list[tuple[int, int, str, int, int]],
                     start: int, end: int) -> list[tuple[int, str]]:
    """区间**真正覆盖了** `[start,end)` 这处标记的声明，按可信度排序。

    这是"同一编号多处声明"能分开处理的关键（见 `_collect_claims`）。
    """
    hit = [(tier, nm) for _idx, tier, nm, s, e in claims
           if s <= start and e >= end]
    return sorted(hit)


def _sent_names(image_labels: list[str], image_offset: int) -> dict[str, int]:
    """本次真正送出去的：名字 → 编号。"""
    real: dict[str, int] = {}
    for i, lb in enumerate(image_labels or []):
        nm = _name_of(lb)
        if nm and nm not in real:
            real[nm] = image_offset + i + 1
    return real


#: 名字与编号之间可能夹着的结构词（`@图片1 的X` / `@图片1 中的X` / `@图片1：X`）
_BETWEEN = r"(?:的|中的|里的|为|是|即|：|:|=|\s|,|，)*"

#: 分句标点：找"这处标记所在的那一小句"用的
_CLAUSE_STOP = "。；！？\n，、;!?"


def _match_name_loose(claimed: str, names: list[str]) -> str | None:
    """宽松匹配：一边包含另一边也算。

    ⚠️ **只给剔除逻辑用，绝不能给 `remap` 用**。两边要求相反：
      · `remap` 拿它改编号，宽松匹配会"修出新的换脸"（实测
        「林晨的跑车内」被配成角色「林晨」）；
      · `drop` 拿它决定"要不要删"，宽松 = 倾向**不删**。
        误删是删掉用户写对的内容，误留只是维持原状 —— 两者代价不对等。
    """
    hit = _match_name(claimed, names)
    if hit:
        return hit
    c = _norm(_clean_name(claimed))
    if len(c) < 2:
        return None
    for n in sorted(names, key=len, reverse=True):
        if not n:
            continue
        nn = _norm(n)
        if len(nn) >= 2 and (nn in c or c in nn):
            return n
    return None


def _clause_around(text: str, start: int, end: int) -> str:
    """这处标记所在的**一小句**（按句读切，最多各取 60 字）。"""
    lo = start
    while lo > 0 and start - lo < 60 and text[lo - 1] not in _CLAUSE_STOP:
        lo -= 1
    hi = end
    while hi < len(text) and hi - end < 60 and text[hi] not in _CLAUSE_STOP:
        hi += 1
    return text[lo:hi]


def _name_near(text: str, start: int, end: int, names: list[str]) -> str | None:
    """判断这处 `@图片N` 是不是就指着某个**确实送出去**的人。

    不解析"标记后面那一坨字"再清洗，而是反过来：拿**已知的真名**去匹配
    标记周边。原因是清洗路线不可靠 —— 实测两处踩坑：

      · `@图片1 中的女子为林晨` → 粗解析得到「女子为林晨」，对不上 → 误判成
        "林晨没送来"，把一条**正确**的引用删掉（最坏的结果）；
      · `@图片1 的林晨冷笑` → 解析成「林晨冷笑」，同样对不上 → 同样误删。
      · `林晨的面部特征对应@图片1` → 名字在**左**边、中间隔着一串描述，
        只看"紧邻"同样会误删。

    所以分两跳：先看**紧邻**（最常见的三种写法），再退到**整句**。
    整句里出现任一个送出去的名字 → 判为有效（不删）。
    ⚠️ 这里刻意宽松：宁可放过一条悬空引用，也不能删掉用户写对的引用。
    """
    if not names:
        return None
    # ① 紧邻：右边 `@图片1 的林晨`
    right = text[end:end + 40]
    for n in sorted(names, key=len, reverse=True):
        if n and re.match(_BETWEEN + re.escape(n), right, re.S):
            return n
    # ② 紧邻：左边 `林晨@图片1` / `林晨（@图片1）`
    left = text[max(0, start - 40):start]
    for n in sorted(names, key=len, reverse=True):
        if n and re.search(re.escape(n) + _BETWEEN + r"$", left, re.S):
            return n
    # ③ 退到整句：`林晨的面部特征对应@图片1`
    clause = _clause_around(text, start, end)
    for n in sorted(names, key=len, reverse=True):
        if n and n in clause:
            return n
    return None


def remap_image_refs(text: str, image_labels: list[str],
                     *, image_offset: int = 0) -> tuple[str, list[str]]:
    """按提示词**自己声明的**「@图片N 指谁」，把编号改成实际下发顺序。

    返回 `(纠正后的文本, 被纠正的说明列表)`。说明形如
    `"@图片1→@图片3（提示词说是「林婉萍」）"`，供调用方记日志，
    让"这一镜的编号被改过"永远可追溯 —— 静默改用户的稿是不可接受的。

    声明来源按**可信度**排先后（同一个编号有多条声明时，只认最高那档；
    最高档里出现两个不同名字 → 判定自相矛盾，整条不动）：

      1. `@图片1 为X` / `@图片1 是X` / `@图片1：X` / `@图片1=X`  —— 显式指代
      2. `X（@图片1）` / `X(@图片1)`                              —— 显式括注
      3. `@图片1 的X` / `@图片1 X`                                —— 行文顺带

    不做的事：名字对不上本次清单里任何一项 → 不动；声明矛盾 → 不动。
    """
    if not text or not image_labels or "@" not in text:
        return text, []

    real = _sent_names(image_labels, image_offset)
    if not real:
        return text, []

    names = list(real)
    raw_claims = _collect_claims(text)

    # 按编号聚合（remap 是"这个编号整体指向谁"，所以这里聚合是对的）。
    # ⚠️ 与 drop 的差别就在这里：drop 必须按**每一处标记**判（同一编号可能
    # 同时有正确与错误两条声明），remap 是整条编号改号，只能有一个结论。
    by_idx: dict[int, list[tuple[int, str, int]]] = {}
    for idx, tier, nm, s, _e in raw_claims:
        by_idx.setdefault(idx, []).append((tier, nm, s))

    mapping: dict[int, int] = {}
    notes: list[str] = []
    for idx in sorted(by_idx):
        rows = by_idx[idx]
        best_tier = min(t for t, _, _ in rows)
        # 同档出现两个不同写法 → 可能是自相矛盾，也可能只是同一名字的不同写法。
        # 逐个对到清单名上再判，对不上的写法不参与冲突判定。
        hits = sorted({hit for t, sp, _p in sorted(rows, key=lambda r: r[2])
                       if t == best_tier
                       for hit in [_match_name(sp, names)] if hit})
        if len(hits) != 1:
            continue                      # 对不上 or 自相矛盾：不动
        target = real[hits[0]]
        if target != idx:
            mapping[idx] = target
            notes.append(f"@图片{idx}→@图片{target}（提示词说是「{hits[0]}」）")

    if not mapping:
        return text, []

    # 同时替换：先全部换成占位符，再落位（防止 1↔2 互换时两处都变同一个）
    out = text
    for old, new in mapping.items():
        out = re.sub(r"@\s*图\s*片?\s*%d(?!\d)" % old, f"\x00{new}\x00", out)
    out = re.sub(r"\x00(\d+)\x00", lambda m: f"@图片{m.group(1)}", out)
    return out, notes


def dangling_image_refs(text: str, image_labels: list[str],
                        *, image_offset: int = 0) -> list[str]:
    """找出**指向不存在素材**的 `@图片N`（重编号救不了的那一类）。

    与 `remap_image_refs` 的分工：
      · `remap` 管「编号写错了、人还在」→ 改对；
      · 本函数管「人根本不在这批图里」→ 只能报出来。

    后者在生产上量更大（dev 实测 210 处），成因是三种、都合理：
      · 角色/场景**被用户删了**（墓碑，注入时断链）；
      · 角色**还没出图**（注入跳过，不占位）；
      · 场景**改了名**（提示词里是旧名）。

    这三种都不是 bug，但**必须可观测**：用户看到的是"我明明 @ 了她却没带上"，
    而日志里一个字都没有 —— 无从归因。返回的说明用于调用方记 WARN。

    ⚠️ `image_offset` 必须与 `remap_image_refs` 同一口径：走首帧/尾帧路线时，
    编号 1..offset 被首/尾帧占着，它们是**真实存在的图**；标签从 offset+1
    开始。漏算偏移会在首帧路线上把合法引用全报成悬空（日志天天误报）。
    """
    if not text or "@" not in text:
        return []
    # 有效编号区间是 1 .. offset+len(labels)：首尾帧 + 下发的参考图
    upper = image_offset + len(image_labels or [])
    if upper <= 0:
        return []
    out: list[str] = []
    seen: set[int] = set()
    for m in _NUM_REF.finditer(text):
        idx = int(m.group(1))
        if idx in seen:
            continue
        seen.add(idx)
        if idx > upper or idx < 1:
            out.append(f"@图片{idx}")
    return out


#: 「@图片1 为X」开头的**声明句**：整句摘掉会破坏行文，只摘编号本身。
#: 但「@图片1 」这种纯指代前缀（后面直接跟名字）要连 `@` 一起摘，不然会
#: 剩下「图片1 林晨」这种更像引用的残句。


def drop_dangling_refs(text: str, image_labels: list[str],
                       *, image_offset: int = 0,
                       image_count: int | None = None,
                       known_names: "list[str] | set[str] | None" = None,
                       ) -> tuple[str, list[str]]:
    """把指向**未送出素材**的 `@图片N` 从正文里剔除，换成纯文本。

    用户 2026-10-18 裁定：「根本没送出去的图应该在触发生成时剔除引用
    （提示词文本框内也要把对应的引用块换成原本的文本）」。

    ## 换成什么

    不是删掉，是**退化成原文本**，因为被指的实体名通常就写在旁边：

        `@图片1 中的女子为林晨`        → `林晨`
        `林晨（@图片2）转过身`          → `林晨转过身`
        `@图片1 的白薇冷笑`             → `白薇冷笑`
        `参考@图片1`                    → `参考`

    这样正文读起来仍然通顺，而且**不会诱导模型去引用一张不存在的图**——
    原来留着 `@图片1` 时模型会当成"有这张图"，结果是乱套或者报错。

    ## 编号空间（三段，判据完全不同）

    | 区间 | 是什么 | 怎么判 |
    |---|---|---|
    | `1 .. image_offset` | **首帧 / 尾帧**（真实存在） | 一律不动 |
    | `offset+1 .. offset+count` | 下发的参考图 | 有标签就按名字判；没标签不动 |
    | `> offset+count` | 根本没这一张 | 一律剔 |

    ⚠️ 第一段是 2026-10-18 复检补的，此前**缺席，导致真实事故**：
    走首帧路线的镜，提示词里 `首帧画面定格为@图片1` 的 `@图片1` 指的是**首帧本身**
    （`_build_images` 里 first_frame 排在最前），却被当成"没送出的引用"删掉，
    正文变成「首帧画面定格为。」—— **删掉了用户写对的内容**，正是最坏那类错。
    dev 实测 20 镜命中（有首帧且提示词含 `@图片N`）。

    ## `image_count` 与 `image_labels` 的区别

    `image_count` = **实际送出去的图数**（含首尾帧之外的那部分）；
    `image_labels` = 这些图**各自是谁**。
    两者不等价的场景是真实存在的：用户手动给了 `ref_urls` 时，jobs 里
    `injected_labels if len(...) == len(_imgs) else []` 会把标签置空 ——
    图送了、只是不知道是谁。这时只能按数量判，不能按名字判。
    缺省 `image_count = len(image_labels)`。

    ## 不做什么

    · 认不出指谁的裸引用（没有声明、编号又在有效区间内）→ 不动；
    · 声明的名字不是项目里任何实体（传了 `known_names` 时）→ 不动
      （「站位图参考@图片6」里的「站位图」不是谁，见函数体 ④）；
    · 剔除后若产生连续空白/悬空标点，做一次轻量清理（不动句读结构）。

    返回 `(处理后的文本, 被剔除的说明列表)`。
    """
    if not text or "@" not in text:
        return text, []

    count = len(image_labels) if image_count is None else max(0, int(image_count))
    # 一张图都没有、也没有首尾帧 → 正文里任何 `@图片N` 都是悬空的
    if count == 0 and image_offset == 0 and not image_labels:
        matches0 = list(_NUM_REF.finditer(text))
        if not matches0:
            return text, []
        removals0 = [_removal_span(text, m.start(), m.end()) for m in matches0]
        notes0 = sorted({f"@图片{m.group(1)}（本次未提供任何参考图）"
                         for m in matches0})
        return _apply_removals(text, removals0), notes0

    upper = image_offset + count
    real = _sent_names(image_labels, image_offset)
    names = list(real)
    # 没有名字清单时只能按数量判：区间内的一律不动（不知道它指谁）
    has_labels = bool(image_labels)
    claims = _collect_claims(text) if has_labels else []
    matches = list(_NUM_REF.finditer(text))
    if not matches:
        return text, []

    removals: list[tuple[int, int]] = []
    notes: list[str] = []
    for m in matches:
        idx = int(m.group(1))
        start, end = m.start(), m.end()
        # ① 首帧 / 尾帧：真实存在的图，任何情况下都不许动
        if 1 <= idx <= image_offset:
            continue
        if idx < 1 or idx > upper:
            why = "编号超出实际张数"
        elif not has_labels:
            continue                        # 区间内但不知道是谁：不动
        elif _name_near(text, start, end, names):
            continue                        # ② 旁边就是真名：有效引用
        else:
            rows = _claims_covering(claims, start, end)
            if not rows:
                continue                    # ③ 认不出指谁：不动
            best_tier = min(t for t, _ in rows)
            spelled = next((nm for t, nm in rows if t == best_tier), "")
            if _match_name(spelled, names) is not None:
                continue                    # 声明的人确实送到了
            # ④ 声明的"名字"根本不是项目里的任何实体 → 不知道它指什么，不动。
            #
            # 2026-10-27 生产「巴郎错牵结良缘」E12·#74：用户写 `站位图参考@图片6`，
            # 第 6 张是他手动 @ 的图（资产名叫「新茶参考」）。`_CLAIM_BEFORE`
            # 把「站位图参考」读成了这个编号的属主，对不上清单就判"未下发"，
            # 删掉的是一条**确实送到了的**引用 —— 正是"删掉对的内容"那类最坏的错。
            #
            # 剔除的本意是"提示词点名的那个人这次没送来"（角色已删 / 无图 /
            # 场景改名）。所以只有当被点名的确实是项目里**有名有姓的实体**时
            # 才剔；认不出的写法（站位图、夜晚、0.00–1.60）一律放过。
            # `known_names=None` 保持旧行为（不知道项目实体时无从判断）。
            if known_names is not None and _match_name(spelled, list(known_names)) is None:
                continue
            why = f"提示词说指「{_clean_name(spelled)}」，本次未下发"
        notes.append(f"@图片{idx}（{why}）")
        removals.append(_removal_span(text, start, end))

    if not removals:
        return text, []
    return _apply_removals(text, removals), notes


def _apply_removals(text: str, removals: list[tuple[int, int]]) -> str:
    """按区间从后往前删，再做轻量排版清理。"""
    out = text
    for s, e in sorted(set(removals), reverse=True):
        out = out[:s] + out[e:]
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"[ \t]+([，。；、！？）)])", r"\1", out)
    out = re.sub(r"([（(])[ \t]+", r"\1", out)
    return out


#: 括注里可以是「参考/作为参考/见」+ 空白 + 编号
_PAREN_HEAD = re.compile(r"[（(]\s*(?:参考|作为参考|见|见参考)?\s*$")


def _removal_span(text: str, start: int, end: int) -> tuple[int, int]:
    """一处悬空引用要删掉哪一段文本。

    三种形态分别处理，目标是**退化成原文本**而不是留下残句：

        `林晨（@图片2）转过身`   → 连括号一起删 → `林晨转过身`
        `顾耀东（参考@图片1）`   → 连括号一起删 → `顾耀东`
        `林晨@图片2 拎着文件袋`  → 删标记+空格   → `林晨拎着文件袋`
        `@图片1 中的女子为林晨`  → 删标记+「中的」→ `女子为林晨`
    """
    # ① 括注：左边 `（`（中间只允许"参考"等）、右边 `）`
    lm = _PAREN_HEAD.search(text, max(0, start - 12), start)
    if lm:
        rm = re.match(r"\s*[)）]", text[end:end + 6])
        if rm:
            return lm.start(), end + rm.end()
    # ② 普通形态：删标记本身 + 紧跟的「的/中的/里」+ 一个空格
    tail = re.match(r"\s*(?:的|中的|里的|里)?\s*", text[end:end + 12])
    return start, end + (tail.end() if tail else 0)
