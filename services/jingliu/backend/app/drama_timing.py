"""真人剧镜头时长估算：**按台词字数算**，不让 LLM 拍脑袋。

## 为什么需要这个模块（2026-09-01 实测，项目「9125」）

用户报告：镜头 6「人物语速异常的快」。查下去是这样的：

| 镜 | 台词字数 | 规划时长 | 折算语速 |
|---|---|---|---|
| 6 | 182 | 23.0s | **7.9 字/秒** |
| 7 | 33 | 10.0s | 3.3 字/秒 |

真人剧的音画是视频模型一体生成的（seedance 音画一体），**台词读多久是物理约束**：
给 23 秒塞 182 个字，模型只能把台词加速念完。而同一集里另一个镜头
33 个字给了 10 秒。同一部片子里两个镜头的语速差 2.4 倍，这不是"节奏设计"，
是时长没有跟内容挂钩。

根因在老的对白下限判定上——它只认**引号内**的文字：

    re.findall(r"[“「『\\"]([^”」』\\"]*)", ref)

而本系统的剧本格式是 `角色【情绪】：台词` / `角色(OS)：台词`，**一个引号都没有**。
于是 `dialog_chars` 恒为 0、对白物理下限恒为 0，秒数完全等于 LLM 报的数字。
唯一被这个正则捞到的反而是拟声词（`△“啪。”一张黑卡`）和台词里的引用
（`所有人都在规劝我“嫁人就要收心”`）——捞的全是不该算的。

所以这里重写一份**认剧本格式**的时长估算，并且它对所有视频模型完全一致：
秒数只由内容决定，模型能力只影响分组与拆分（见 routes_v2._DurWindow）。

## 估算模型

一个镜头的时间由三种内容占用：

- **同期台词**（`角色【情绪】：…`）：必须逐字念完，时间不可压缩。
- **画外音 / 独白**（`角色(OS)：…`、`(VO)`、`旁白`）：也要逐字念完，但它是
  **盖在画面上的**——与动作节拍**并行**，不叠加。
- **动作节拍**（`△…` 画面描述行）：每行给一份固定的表演时间。

    总时长 = 同期台词时长 + max(动作节拍时长, 画外音时长)

画外音与动作取 max 而不是相加，是本次修镜头 7 的关键：那一镜没有同期台词，
只有 2 个动作节拍 + 33 字独白（6.6 秒）。相加得 11.6 秒，取 max 得 6.6 秒——
独白本就是在推门、按停八音盒的过程中说的，不该另外买一份时间。
"""
from __future__ import annotations

import re
from typing import NamedTuple

#: 中文台词语速（字/秒）。与 `script_import._CHARS_PER_SEC` 同一标定
#: （RunningHub IndexTTS 实测均值 5.56、中位 5.75，取 5.0 略偏保守）。
#:
#: ⚠️ **这个值只适合用来做「分组」，不适合用来定「秒数」**（2026-09-22 实测）。
#: 它的标定源是 IndexTTS **朗读旁白**，而 drama/anime 的台词是视频模型
#: **音画一体自己念的** —— 那是另一个引擎，语速见 `NATURAL_CPS`。
#: 这里保持 5.0 不动，是因为 `_merge_short_shots` / `split_ref_by_cap` 的
#: 合并与分组判据都按它标定过；秒数侧改由 `dialogue_floor()` 兜底。
_SPEECH_CPS = 5.0

#: **视频模型音画一体时，台词的自然语速（字/秒）**。2026-09-22 实测标定。
#:
#: ## 怎么测出来的
#:
#: `scripts/verify_seedance_speech_rate.py`（实测 H）：给 seedance-2.5 一条
#: 真实台词 + 远超所需的时长，用 Whisper ASR 时间戳量它实际念了多久。
#: **只有真正留出尾留白的样本才算数** —— 模型按自己的节奏念完、剩下时间空着，
#: 那才是自然语速；把时长填满的样本只能给出「语速 ≥ 这个值」的下界。
#: 合格样本 n=2，实测 **3.08 ~ 3.25**，取 3.1。
#:
#: ## 为什么不是 5.0
#:
#: 同一批实测里，按 5.0 反推时长的那一条（53 计时字给 12s = 4.42 字/秒）
#: **吞掉了台词开头的「林泽轩，」** —— 与仓库内 Seedance 官方排障文档
#: （`prompt_opt/skill_assets/seedance2/references/typical-effect-cases.txt`）
#: 3.1 条描述的一致：「人物台词过长但视频时长不够 → 只能从视频一开始就说台词」。
#: 另一条在 3.62 时台词虽完整，但念成了不换气的一长串（ASR 转写一个标点都没有）。
#: 所以失真阈值在 3.6~4.4 之间，3.1 留了余量。
#:
#: ## 适用范围
#:
#: drama 与 anime 的配音策略完全相同（`project_defaults` 有记载），
#: 实测也逐位相同（同为 2.79 字/秒、0.07s 尾留白），故**一个值管两种模式**。
#: ⚠️ **海螺 H3 的自然语速未实测**，它同为音画一体，按同值估算 ——
#: 这是本常数唯一的外推，若海螺侧出现语速问题，第一个要重测的就是它。
NATURAL_CPS = 3.1

#: 表演余量的比例与上下限（秒）。用户口径：「在原本的时长判断上普遍长 1~4s，
#: 按原本长度」—— 即短镜加得少、长镜加得多，但不超过 4 秒。
#:
#: 它治的是**两个症状里的一个**：镜头整体偏紧导致动作过快。台词念不完那一个
#: 由 `dialogue_floor()` 治 —— 余量是加法，补不了「差 4~6 倍」的镜头。
#: 实测（2299 个真实有台词镜）：只加余量能把 >4.4 字/秒的吞字风险从
#: 15.5% 压到 5.0%，再叠 `dialogue_floor()` 才降到 0.3%。
_BUMP_RATIO = 0.30
_BUMP_MIN = 1.0
_BUMP_MAX = 4.0


def performance_bump(sec: float) -> float:
    """给一个时长配多少表演余量（秒）。见 `_BUMP_RATIO` 的注释。"""
    if sec <= 0:
        return 0.0
    return max(_BUMP_MIN, min(_BUMP_MAX, sec * _BUMP_RATIO))


def dialogue_chars(ref: str) -> int:
    """这一镜**按剧本原文解析出来**要念多少字（同期台词 + 画外音，不含动作描述）。

    ## ⚠️ 这是**解析结果**，不是"不会错的事实"（2026-10-24 更正）

    上一版这里写着"这是事实，数出来的字不会错"。那句话是错的：它数的是
    `split_units` **解析出来**的台词，而解析会错。实测（71 个同一镜可对照的样本，
    剧本解析 vs ASR 实测）：

      · 中位偏差 **0%**（多数镜头是对的）；
      · 但**均值 15%**，**12 个（17%）偏差超过 50%**；
      · 最大的几例是 剧本 8 字 / ASR 实测 81 字、剧本 60 字 / ASR 实测 8 字。

    解析出错的几种真实原因（都不是"调一下正则"能解决的）：
      · **小说体/无标签写法**：整段没有 `角色：` 前缀 → 被判成 action，字数为 0；
      · **台词跨镜**：一句台词被拆到相邻两镜，单看这一镜的 script_ref 数不全；
      · **剧本后来改过**：镜头上的 `script_ref` 是旧稿，与已出片的音轨对不上；
      · **多音字/重复标点**等清洗差异。

    ## 所以该怎么用

    - **有可信的字幕** → 用 `speech_rate.shot_rates()` 的 `subtitle_chars`，
      那是从**已出片音轨**转写出来的实测字数，比解析准。
      （前提：字幕锚点没坏 —— 见 `speech_rate` 的锚点体检。）
    - **没有字幕** → 本函数给的是**大致量级**，够模型判断"这镜台词多不多"，
      但不要当成精确值去卡秒数，更不要用它推"还差 0.3 秒"这种结论。
    - 两者都有时，`speech_rate` 会把两边一起给出来，差得多就说明有一边不可信，
      让模型自己看原文判断（`read_shots` 里就有原始 script_ref）。
    """
    return sum(u.chars for u in split_units(ref or "")
               if u.kind in ("dialog", "vo"))


def dialogue_floor(ref: str) -> float:
    """这一镜的台词**按 `NATURAL_CPS` 念完要多少秒** —— ⚠️ 只作内部估算用。

    ## 2026-10-24：这个函数**不再给 agent 用**，也不该被当成"物理下限"

    用户裁定：「语速标准完全不对，不能让 agent 使用，agent 应该自己判断语速。」
    核过数据，这个判断是对的：

      · 拿 74 个**已正常出片**的带台词镜头反查，本函数把其中 **40 个（54%）**
        判成"念不完"——而它们全都出片成功、没有语速问题。
      · 实测跨度是 **1.80 ~ 4.76 字/秒（p10~p90），差了 2.7 倍**。
        单个常数不可能同时是"下限"和"典型值"；3.1 恰好是这批镜头的**中位数**，
        于是按它设下限必然判掉一半。
      · 它当初只标定于 **n=2** 个样本（见 `NATURAL_CPS` 注释）。
      · 项目之间也有差异：四个项目的 ASR 实测分别是 3.77 / 3.33 / 4.09 / 3.07。

    所以：**字数是事实，语速是每个项目自己的数据**。要给模型判断依据，
    用 `speech_rate.measure()` 实测本项目的真实语速，不要用平台常数。
    本函数保留只因为拆镜流水线（`routers/shots._clamp_duration`）还在用它，
    那条链路用的是相对值、且有自己的回归基线，改动需要单独评估。
    """
    ch = dialogue_chars(ref)
    return (ch / NATURAL_CPS + _LINE_GAP_SEC) if ch else 0.0

#: 每条台词的换口/轮次交接。三个人来回对话时这部分不可忽略。
_LINE_GAP_SEC = 0.5

#: 一条 `△` 画面描述行的表演时间。实测剧本里一条 △ 行就是一个动作
#: （「推开门」「把咖啡杯放下」），1.5 秒是能看清一个动作的下限。
_ACTION_BEAT_SEC = 1.5

#: 什么内容都没识别出来时，按原文字数兜底（沿用老实现的口径）。
_FALLBACK_CPS = 12.0
_FALLBACK_MAX = 8.0

#: 说话人标签：行首的角色名 + 可选**裸** `os` 标记 + 可选 `(OS)` 技术标注
#: + 可选 `【情绪】` + 冒号。
#: 名字里不允许出现空白、标点、括号——那样能挡掉「他转身，说：」这类叙述句。
#:
#: ⚠️ 中间那个"裸标记 + 允许空格"是 2026-09-08 补的，原先没有，后果很实在：
#: 剧本里 `叶轻语os（无奈）：` 与 `叶轻语 os（冷笑）：` **两种写法混用**
#: （同一个作者、同一集里都有）。带空格的那种匹配不上 —— 名字组不许含空白，
#: 而 `os` 又不在括号里，于是整行落到 `action`、`chars=0`：
#:
#: · **台词对时长完全不可见**。这正是本模块开头要修的「语速异常的快」：
#:   3-2 那种只有一句 `楚子烨 os（阴鸷）：…` 的镜头会被当成纯动作镜，
#:   给 1.5 秒，然后模型得在 1.5 秒里念完整句独白。
#: · **字幕也拿不到这句台词**（`spoken_lines` 同样按 kind 筛）。
#:
#: 所以名字与标记之间只允许 `[ \t]`（不用 `\s`）—— 跨行会把下一行的
#: 冒号错认成本行的说话人标签。
#:
#: ⚠️ 括号长度原先限 10 字（2026-10-29 放宽到 `_PAREN_MAX`）。很多剧本把整段表演
#: 说明写在括号里：`彤彤（背着粉色的小书包，手里拿着一张画，兴奋地在前面蹦蹦跳跳）：…`，
#: 超过 10 字就匹配不上，整行落到 `action`、`chars=0` —— 与上面 os 那次同一个后果，
#: 只是规模大得多：生产库 30596 行带括号台词里 6754 行被这样吞掉，《玩具房》194 行
#: 里 154 行。台词对时长不可见 → 估时只剩十几秒 → 不拆镜、还被并成 26 秒长镜 →
#: 提示词装不下，后半段剧情被整段丢掉（第 71 集的拼图对话一句都没进提示词）。
_PAREN_MAX = 120
_SPEAKER_RE = re.compile(
    r"^([^\s△▲▽▼◆◇○●■□※☆★＊*·、，。！？；：…—\-\"“”「」『』()（）【】\d]{1,10})"
    r"[ \t]*((?:os|o\.s\.?|vo|v\.o\.?|voice[ \-]?over)?)"   # 裸 os / vo（可空）
    r"[ \t]*((?:[（(][^）)\n]{0,%d}[）)])*)"  # (OS) / (V.O.) / （画外音）/ 长表演说明
    r"[ \t]*((?:【[^】\n]{0,24}】)*)"         # 【冷笑】情绪标
    r"\s*[：:]" % _PAREN_MAX, re.I)

#: 一个括号的内容；用于从括号组里**逐个**取出来判 vo（见 `_vo_tag_of_parens`）。
_PAREN_ITEM_RE = re.compile(r"[（(]([^）)\n]*)[）)]")
#: 旧口径的括号上限：不超过它的括号整段参与 vo 判定，与放宽前逐字节一致。
_VO_PAREN_FULL = 10

#: 画外音/独白标记（在说话人标签的括号或情绪标里出现即算）。
_VO_MARK_RE = re.compile(
    r"os|o\.s|vo|v\.o|voice|画外|内心|心声|独白|旁白|回忆音", re.I)

#: 粘在名字尾巴上的裸标记（`叶轻语os`）。只在**取角色名**时剥，判 vo 时不能剥
#: —— 那正是判定它是独白的依据。锚在词尾，免得削掉真名里的字。
_BARE_VO_SUFFIX_RE = re.compile(r"(?:os|o\.s\.?|vo|v\.o\.?)$", re.I)

#: 长表演说明只取第一个分句判 vo（`（OS，目光看向车窗外）` → `OS`）。
_PAREN_CLAUSE_RE = re.compile(r"[，,、；;。\s]")


def _vo_tag_of_parens(group: str) -> str:
    """括号组里用来判 vo 的那部分文字。

    短括号（≤ `_VO_PAREN_FULL` 字）整段参与，与放宽前完全一致；长括号是表演
    说明，只看第一个分句 —— 否则「（心里充满了柔情，**内心**一软）」这种描写里的
    「内心」会把同期台词判成画外音，而 vo 在 `units_seconds` 里与动作取 max、
    不累加，整句台词又从时长里消失了。
    """
    out = []
    for m in _PAREN_ITEM_RE.finditer(group or ""):
        inner = m.group(1)
        out.append(inner if len(inner) <= _VO_PAREN_FULL
                   else _PAREN_CLAUSE_RE.split(inner, 1)[0])
    return "".join(out)

#: 镜头术语——它们后面也跟冒号（`△特写：`、`快剪：`），但不是台词。
#: 绝大多数带 `△` 前缀已被挡住，这里再兜一层，防剧本漏写 △。
_CAM_TERMS = (
    "特写", "近景", "中景", "远景", "全景", "大全", "中近", "过肩", "空镜",
    "插入", "闪回", "快剪", "蒙太奇", "镜头", "画面", "字幕", "黑场", "定格",
    "叠化", "慢镜", "升格", "俯拍", "仰拍", "航拍", "推镜", "拉镜", "摇镜",
    "跟拍", "手持", "旁白字", "转场", "淡入", "淡出", "音效", "配乐",
)

#: 引号内对白（**兜底**用）：整段剧本一条 `角色：` 都没有时才启用，
#: 用于「他说：“……”」这类小说体文本。正常剧本走说话人标签那条路。
_QUOTED_RE = re.compile(r"[“「『]([^”」』\n]{0,400})[”」』]")


class Unit(NamedTuple):
    """一个内容单元（一行台词或一行画面描述）。

    `raw` 保留**原文与分隔符**，拼起来必须严格等于原 script_ref——
    拆镜时要靠它保证"不改一个字"（拆解提示词规则 4）。
    """
    raw: str
    kind: str      # dialog | vo | action
    chars: int     # 计时用的字数（台词只算冒号之后的部分）

    @property
    def seconds(self) -> float:
        if self.kind == "blank":
            return 0.0
        if self.kind == "action":
            return _ACTION_BEAT_SEC
        return self.chars / _SPEECH_CPS + _LINE_GAP_SEC


#: 台词里的舞台指示（`（低声）`、`【冷笑】`）不发声，计时要剔掉。
_INLINE_DIR_RE = re.compile(r"[（(][^）)\n]{0,20}[）)]|【[^】\n]{0,24}】")
_NON_SPEECH_RE = re.compile(r"[\s—…·、，。！？；：\"“”「」『』()（）【】\-~～]")


def _speech_chars(text: str) -> int:
    """一句台词实际要念出来的字数。"""
    return len(_NON_SPEECH_RE.sub("", _INLINE_DIR_RE.sub("", text)))


def _boundaries(ref: str) -> list[int]:
    """切分位置：换行之后、以及每个 `△` 之前（△ 常与台词同行紧跟）。"""
    cuts = {0, len(ref)}
    for i, ch in enumerate(ref):
        if ch == "\n":
            cuts.add(i + 1)
        elif ch in "△▲":
            cuts.add(i)
    return sorted(cuts)


def _classify(chunk: str) -> tuple[str, int]:
    """判定一个片段是 台词 / 画外音 / 动作 / 空白，并给出计时字数。"""
    body = chunk.strip()
    if not body:
        return ("blank", 0)
    if body[0] in "△▲▽▼":
        return ("action", 0)
    m = _SPEAKER_RE.match(body)
    if m and not any(t in m.group(1) for t in _CAM_TERMS):
        # 四个组都要进 tag：裸 `os`(2)、括号标注(3)、【情绪】(4)，
        # 外加名字本身(1)（`叶轻语os` 这种没空格的写法里 os 被并进名字组）。
        tag = ((m.group(2) or "") + _vo_tag_of_parens(m.group(3) or "")
               + (m.group(4) or "") + m.group(1))
        kind = "vo" if _VO_MARK_RE.search(tag) else "dialog"
        return (kind, _speech_chars(body[m.end():]))
    return ("action", 0)


def spoken_text(chunk: str) -> str:
    """一个单元里**真正会被念出来**的那段文字（去掉说话人标签与舞台指示）。

    与 `_speech_chars` 的区别是**保留标点**：字幕分条完全依赖句读
    （`align.ts:splitIntoCues` 先按 `。！？` 再按 `，、；` 断），
    在这里就把标点洗掉，下游只能按字数硬断，一句话会被切在莫名其妙的地方。
    标点由前端在**分条之后**才洗（`washPunct`）。

    只处理 `dialog` / `vo` 单元；其他 kind 传进来返回空串。
    """
    body = (chunk or "").strip()
    if not body:
        return ""
    m = _SPEAKER_RE.match(body)
    if not m or any(t in m.group(1) for t in _CAM_TERMS):
        return ""
    return _INLINE_DIR_RE.sub("", body[m.end():]).strip()


def spoken_lines(ref: str) -> list[str]:
    """`script_ref` 里按顺序被念出来的台词（同期台词 + 画外音/独白）。

    这是"已有文本本地对齐字幕"在真人剧上的**文本来源**。真人剧的音画由
    seedance 一体生成，念的就是这些行 —— 文本已知，所以不需要 ASR 去猜
    （理由见 `align.ts` 头注释；ASR 还会把人名听错，而原文一个字都不会错）。

    刻意**包含** `vo`（`角色os：…` 独白）：它同样会被念出来、同样要出字幕。
    刻意**排除**：
      · `△/▲` 画面描述 —— 那是给视频模型看的表演指示，没人念它。
        （2026-09-07 那批错字幕的成因之一就是把它当台词烧进了画面。）
      · `【字幕：楚子烨：楚家假少爷】` 这类**角色名条**（`_CAM_TERMS` 含"字幕"，
        且行首 `【` 本就进不了名字组）—— 它是设计成一直挂在画面上的标签，
        不跟着声轨走，硬塞进强制对齐只会挤掉真台词的时间。
        目前它需要用户手工加为 `title` 字幕，属已知缺口。
    """
    out: list[str] = []
    for u in split_units(ref or ""):
        if u.kind not in ("dialog", "vo"):
            continue
        t = spoken_text(u.raw)
        if t:
            out.append(t)
    return out


def speaker_of(chunk: str) -> str:
    """一个单元的说话人名（不是台词行则返回空串）。

    名字取 `_SPEAKER_RE` 的第 1 组，但要**把粘在名字上的裸 os/vo 标记剥掉**：
    剧本里 `叶轻语os（无奈）：` 这种没空格的写法，正则会把 `os` 并进名字组
    （见该正则的注释），直接拿来当角色名就会匹配不上资产库里的「叶轻语」。
    """
    body = (chunk or "").strip()
    if not body:
        return ""
    m = _SPEAKER_RE.match(body)
    if not m or any(t in m.group(1) for t in _CAM_TERMS):
        return ""
    return _BARE_VO_SUFFIX_RE.sub("", m.group(1)).strip()


def speaker_seconds(ref: str) -> dict[str, float]:
    """`script_ref` 里每个角色的**说话时长**（秒），按发言量降序取用。

    给"这一镜该参考谁的音色"用：一镜多人时，戏份最重的那个说了算，
    而不是"第一个出现的"——第一句常常是一句「嗯。」。
    同期台词与独白都算（都要发声）。
    """
    out: dict[str, float] = {}
    for u in split_units(ref or ""):
        if u.kind not in ("dialog", "vo"):
            continue
        name = speaker_of(u.raw)
        if name:
            out[name] = out.get(name, 0.0) + u.seconds
    return out


def split_units(ref: str) -> list[Unit]:
    """把 script_ref 切成内容单元；`''.join(u.raw)` 严格等于 ref。

    空白片段并入 `blank` 单元（0 秒）而不是丢弃——拆镜时要靠 raw 还原原文。
    """
    ref = ref or ""
    cuts = _boundaries(ref)
    out: list[Unit] = []
    for a, b in zip(cuts, cuts[1:]):
        chunk = ref[a:b]
        kind, chars = _classify(chunk)
        out.append(Unit(chunk, kind, chars))
    return out


def unit_seconds(u: "Unit", cps: float = _SPEECH_CPS) -> float:
    """单个内容单元的秒数，可指定语速。

    `Unit.seconds` 属性恒用 `_SPEECH_CPS`（分组口径）；需要按自然语速
    重算时走本函数，例如真人剧的拆分判据（见 `split_ref_by_cap` 的 `cps`）。
    """
    if u.kind == "blank":
        return 0.0
    if u.kind == "action":
        return _ACTION_BEAT_SEC
    return u.chars / cps + _LINE_GAP_SEC


#: 一段**连续的纯环境描写**最多占多少秒（2026-11-10 用户裁定：1.5 秒）。
#:
#: ## 为什么要封顶
#:
#: 此前一行环境 `△` 按动作节拍算 1.5 秒，连写三行就是 4.5 秒；
#: 再叠加整镜按比例加的表演余量（`performance_bump`），一句 22 字的
#: 「深夜，客厅只亮着一盏台灯」就成了 3 秒没人、没事的画面。
#: 全库实测 29% 的有人物镜头开头挂着这种描写 —— 用户反馈的
#: 「经常出现三四秒的空镜头」即此。
#:
#: 1.5 秒够看清"这是哪里"（出品规则第 5 条允许的空镜就是交代地点、天气、光线），
#: 又短到观众感觉不到停顿。描写文字**仍然留在正文里**，提示词那一步照样把它
#: 写成开场画面 —— 只是不再按行累加时长。
SCENERY_CAP_SEC = 1.5


def scenery_mask(units: list[Unit], names: "list[str] | None") -> list[bool]:
    """逐单元判定"是不是纯环境描写"（确定性，不靠模型）。

    判据：`action` 单元里**没有出现任何人物名**。`names` 为空（不知道本镜有谁）
    时一律返回 False —— 不知道就不压，保持原行为，误判方向只会"多给时长"。
    """
    nm = [n for n in (names or []) if n and n.strip()]
    if not nm:
        return [False] * len(units)
    return [u.kind == "action" and not any(n in u.raw for n in nm) for u in units]


def units_seconds(units: list[Unit], cps: float = _SPEECH_CPS,
                  names: "list[str] | None" = None) -> float:
    """一组单元的内容时长：同期台词 + max(动作, 画外音)。

    `names` 给了时，**连续的纯环境描写**（见 `scenery_mask`）合计按
    `SCENERY_CAP_SEC` 封顶，不再逐行累加。不给 = 老口径（逐字节不变）。
    """
    speech = sum(unit_seconds(u, cps) for u in units if u.kind == "dialog")
    vo = sum(unit_seconds(u, cps) for u in units if u.kind == "vo")
    mask = scenery_mask(units, names)
    action = 0.0
    run = 0.0                      # 当前这一串连续纯环境描写已累加的秒数
    for u, is_scn in zip(units, mask):
        if u.kind == "blank":
            continue               # 空行不打断"连续"
        if is_scn:
            run += unit_seconds(u, cps)
            continue
        if run:
            action += min(run, SCENERY_CAP_SEC)
            run = 0.0
        if u.kind == "action":
            action += unit_seconds(u, cps)
    if run:
        action += min(run, SCENERY_CAP_SEC)
    return speech + max(action, vo)


def scenery_seconds(ref: str, names: "list[str] | None",
                    cps: float = _SPEECH_CPS) -> float:
    """本段里纯环境描写**封顶后**占的秒数。表演余量要扣掉这一部分（它不需要"演"）。"""
    units = split_units(ref or "")
    mask = scenery_mask(units, names)
    total, run = 0.0, 0.0
    for u, is_scn in zip(units, mask):
        if u.kind == "blank":
            continue
        if is_scn:
            run += unit_seconds(u, cps)
            continue
        if run:
            total += min(run, SCENERY_CAP_SEC)
            run = 0.0
    if run:
        total += min(run, SCENERY_CAP_SEC)
    return total


def estimate_seconds(ref: str, cps: float = _SPEECH_CPS,
                     names: "list[str] | None" = None) -> float:
    """镜头内容值多少秒（**纯内容，不做任何区间钳制**）。

    识别不到任何台词/动作时（例如纯小说体文本）退回引号对白 + 字数兜底，
    与老实现口径一致，保证不会因为格式不认识而给出 0。

    `names`：本镜人物名。给了就对纯环境描写封顶（见 `SCENERY_CAP_SEC`）。
    """
    ref = ref or ""
    if not ref.strip():
        return 0.0
    units = split_units(ref)
    sec = units_seconds(units, cps, names)
    if any(u.kind in ("dialog", "vo") for u in units):
        return sec
    quoted = sum(_speech_chars(m) for m in _QUOTED_RE.findall(ref))
    if quoted:
        sec = max(sec, quoted / cps + _LINE_GAP_SEC)
    return max(sec, min(len(ref) / _FALLBACK_CPS, _FALLBACK_MAX), 2.0)


def reconcile(est: float, ai_sec: float | None) -> float:
    """把 LLM 报的秒数收进内容允许的范围。

    - **下限 = est**：台词念不完是硬伤（镜头 6 的 7.9 字/秒就是这么来的）。
    - **上限 = max(est*1.35, est+2.0)**：留一点表演/停顿余量，但不容许
      33 个字的独白撑成 10 秒（镜头 7）。短镜头用 +2.0 那一支，
      否则 6.6 秒的镜头上限只有 8.9 秒，比例项会过于苛刻。

    LLM 的判断在这个区间内仍然有效——它比字数更懂哪一镜该留白。
    """
    hi = max(est * 1.35, est + 2.0)
    if not ai_sec or ai_sec <= 0:
        return est
    return min(max(float(ai_sec), est), hi)


def split_ref_by_cap(ref: str, cap_sec: float,
                     cps: float = _SPEECH_CPS) -> list[tuple[str, float]]:
    """把超长镜头按内容单元切成若干段，每段尽量不超过 cap_sec。

    贪心首次适配：对**连续区间划分**而言这就是最优解（段数最少）——
    每多切一刀就多一个上下文断点，段数最少即断点最少。

    `cps`：判定"这一段有多长"时用的语速。真人剧要传 `NATURAL_CPS`——
    按 5.0 判的话，一段 106 字的台词会被算成 21.7s、在 2.5 的 28s 上限内
    "放得下"而不拆，实际念完要 34.7s，于是模型只能压缩语速甚至吞字。
    **拆不拆必须按真实念得完与否判，不能按分组口径判。**

    返回 `[(片段原文, 内容秒数), …]`，片段拼接后严格等于 ref。
    片段秒数同样按 `cps` 计。单个单元本身就超 cap（一大段独白）时它自成一段
    并超出——此时切开也没用，只能交给上层钳制。
    """
    units = split_units(ref)
    if not units or estimate_seconds(ref, cps) <= cap_sec:
        return [(ref, estimate_seconds(ref, cps))]

    groups: list[list[Unit]] = []
    cur: list[Unit] = []
    for u in units:
        if cur and units_seconds(cur + [u], cps) > cap_sec and u.kind != "blank":
            groups.append(cur)
            cur = [u]
        else:
            cur.append(u)
    if cur:
        groups.append(cur)

    # 只有空白/动作的尾段无法独立成镜，并回上一段
    merged: list[list[Unit]] = []
    for g in groups:
        if merged and not any(x.kind in ("dialog", "vo") for x in g) \
                and units_seconds(merged[-1] + g, cps) <= cap_sec * 1.15:
            merged[-1] = merged[-1] + g
        else:
            merged.append(g)

    return [("".join(u.raw for u in g), units_seconds(g, cps)) for g in merged]
