"""大纲的输出形态：**规约文本**，不是 JSON。

## 为什么（与 `script_format` 同一个裁定）

模型不擅长在 JSON 格子里写内容 —— 格子名暗示长度、转义压力让台词变短、
60 集的数组装不下就会反过来压内容。所以大纲也改成"人读优先的规约文本"。

## 2026-11-07：一集只剩**一段正文**

此前每集有 20 多个槽位（契约 15 字段 + `beats` 四段式 + 各类标签），
而用户在界面上只看得到 `synopsis` —— **用户审的是 A，模型读的是 B**。
用户改梗概、beats 没跟着改时，平台还会打 `_beats_stale` 让节拍整块失效，
等于用户改的那句根本没进模型。这是"所见非所得"的结构性来源，不是措辞问题。

现在：

    {order, title, synopsis}    ← 一集就这三个键

`synopsis` 是要素块拼成的整段正文，**用户看到的、模型收到的、剧本照着写的
是同一份文本**。地点/时间/在场人物不进大纲 —— 一集本就横跨多个场景，
由剧本按场次决定，在大纲里定死只会自相矛盾。

## 输出格式

### 首批：剧名 / 主线 / 世界 / 角色

```
【剧名】重生换嫁：继母跪求我别翻旧账

【全剧主线】
被继母与妹妹害死的沈家养女重生回订婚宴当天……（60~120 字，一整段）

【世界】
时代：现代都市
核心场景：
- 沈家老宅——权力中心，谁能进客厅谈事谁就有话语权
- 沈氏集团总部——明面上的战场
行得通的规则：
- 豪门联姻由长辈拍板，小辈当场反对无效
不出现的元素：
- 没有超自然力量（重生除外）

【角色】沈栀｜女主
身份：对外：沈家养女；真实：沈家亲生女儿
标签：扮猪吃虎、话少手狠、记仇
外观：24 岁，瘦，眼神冷，常穿深色
性格：外人面前温顺怯懦；关起门来算无遗策
经历：一整段，写成长经历
动机：核心动机 + 当前困境
关系：与主要人物的关系及演变轨迹
```

### 每集一块

```
【第12集】她把药瓶放进了继母的包里

【开场卡点】继母正逼她交出储物间钥匙，沈薇在门外听着。
【冲突】她要进客厅说话，继母要把她按死在储物间；争的是谁能代表沈家出面。
【期待点】观众等着看她手里那瓶药什么时候翻出来。
【互动】继母先动手搜她的包，她把空包递过去；继母搜不出东西，转头要动她的柜子。
【转折】药瓶从继母自己包里滚出来，全场看向继母。
【爽点】药瓶当着老爷子的面从继母包里滚出来。
【结尾钩子】继母笑着说："你以为你赢了？你妈还在我手里。"
```

要素名见 `ELEMENTS`。**只有【结尾钩子】必填**，其余按需取舍 ——
用户裁定：为凑要素硬写不如不写，这一集没有独立转折就不写【转折】。

## 解析规则（为什么这么定）

- **要素块头必须限定在已知要素名内**。导入草稿的 `synopsis` 常常是剧本原文，
  里面有 `【闪回】`、`【画面1】`、`【一周后】`、`【字幕：…】`；早先接受任意
  `【xx】`，它们被当成要素切开、正文被重组 —— 全库实测 598 集因此损坏。
- **要素按出现顺序拼进 `synopsis`**，不做结构化拆分：位置和顺序由模型定，
  我们只负责原样保存用户能看到的那份。
- **认不出的行并进上一个字段**。所以要素内容里换行是自然的，不用缩进。
- 老模板的分散字段（`core_push：` / `伏笔：` …）仍然认得，会被整理成同样的
  要素块并进正文 —— DB 里还有旧提示词在用，上线后一段时间内一定会碰到。
- ⚠️ **`dump_episode` 绝不把旧契约字段写回正文**：一旦写进去，解析回来就会把
  用户看到的散文梗概顶掉（全库实测 2862 集）。旧字段留在库里的原 dict 上，
  `episode_render.build_contract_block` 之类读得到，dump 只管"用户看得见的那份"。
"""
from __future__ import annotations

import logging
import re

logger = logging.getLogger("outline_format")


# ---------------------------------------------------------------------------
# 输出规约（进 prompt 的那一段）
# ---------------------------------------------------------------------------
# ⚠️ 不含花括号：它可能随 `.format()` 走一遍。
HEAD_SPEC = '''
## ⭐ 输出格式：分块文本（不要 JSON、不要解释）

### 第一批要额外给出剧名、主线、世界与角色

【剧名】全剧标题

【全剧主线】
60~120 字，一整段：主角要得到或守住什么｜谁在挡、为什么挡｜主角靠什么赢。

【世界】
时代：时代或世界观一句话
核心场景：
- 场景名——属于谁、代表什么权力关系（3~5 处）
行得通的规则：
- 这个世界里什么事行得通（2~4 条）
不出现的元素：
- 不能出现的东西（1~3 条）

【角色】姓名｜定位
身份：对外身份 + 真实身份
标签：标签1、标签2、标签3
外观：50 字内的视觉形象
性格：外在表现；内在性格；两者如何反差
经历：一整段，什么经历造成了现在的行为方式
动机：核心动机 + 当前困境
关系：与主要人物的关系，以及这段关系在全剧里怎么演变

（重要角色每人一块，数量 ≥ 3。）

'''

EP_SPEC = '''### 每一集一块

【第N集】本集标题

【开场卡点】这一集开场时，谁被卡在什么处境上——接住上一集结尾的悬置。
【冲突】谁要什么、谁挡着，两人争的具体是哪一件事。
【期待点】观众看到这里最想看到的那一下，以及它落在哪。
【互动】本集最主要的一来一回：谁先出手、对方怎么接、局面怎么变。可以写几段。
【转折】本集哪个时刻局面变了，从什么变成了什么。
【爽点】本集最值回票价的那一下，写成能被拍出来的画面或台词。
【结尾钩子】这一集最后落在哪句话或哪个动作上，观众为什么非点下一集。

### 硬性要求
- 只输出上面这些分块，不要开场白、不要总结、不要用代码块包裹。
- 每集都必须有【结尾钩子】。其余要素按需取舍：这一集没有独立的转折就不写【转折】，不要为凑要素硬写。
- 要素要具体、能被拍出来：写谁做了什么、说了哪句话；不写"她意识到事情不对"这类结论。
- 不要再加别的标签（尤其不要写"地点""时间""在场人物"）。地点与人物是剧本按场次决定的，一集本就会横跨多个场景。
- 集号从给定的起始集开始连续递增，不要跳号、不要重复。
'''

OUTPUT_SPEC = HEAD_SPEC + "\n" + EP_SPEC



# ---------------------------------------------------------------------------
# 字段表：文本前缀 → 中间 dict 的键
# ---------------------------------------------------------------------------

#: 集内字段：前缀 → (键, 类型)。类型：str | num | list | beat | kv
_EP_FIELDS: dict[str, tuple[str, str]] = {
    "梗概": ("synopsis", "str"),
    "本集戏怎么推进": ("core_push", "str"),
    "爽点": ("payoff_moment", "str"),
    "爽点类型": ("payoff_kind", "str"),
    "对手这一集做了什么": ("opponent_move", "str"),
    "兑现卖点": ("selling_point", "str"),
    "失败代价": ("stakes", "str"),
    "推进维度": ("escalation", "str"),
    "情绪强度": ("emotion_intensity", "num"),
    "关键事件": ("must_have", "list_inline"),
    "涉及角色": ("characters", "list_inline"),
    "观众新知道": ("audience_knows_delta", "str"),
    "开场承接": ("hook_in_responds_to", "str"),
    "承接方式": ("hook_in_mode", "str"),
    "开场承接类型": ("hook_in_type", "str"),
    "开场承接强度": ("hook_in_strength", "str"),
    "开场承接引出": ("hook_in_leads_to", "str"),
    "结尾钩子": ("hook_out_type", "str"),
    "钩子强度": ("hook_out_strength", "str"),
    "直接引发": ("hook_out_leads_to", "str"),
    "结尾承接": ("hook_out_responds_to", "str"),
    "结尾方式": ("hook_out_mode", "str"),
    "权力关系": ("power_pair", "str"),
    "争的是": ("power_focus", "str"),
    "伏笔": ("plant_payoff", "list_prefixed"),
    "本集边界": ("forbidden", "list"),
    "角色新知道": ("char_knows_delta", "list_kv"),
    # 容错别名：模型可能把我们给的四段式写回成这几个词
    "剧情概要": ("synopsis", "str"),
    "本集概要": ("synopsis", "str"),
    "戏剧任务": ("core_push", "str"),
    "爽点内容": ("payoff_moment", "str"),
    "本集爽点": ("payoff_moment", "str"),
    "价值转变起点": ("value_shift_from", "str"),
    "价值转变终点": ("value_shift_to", "str"),
    # 兼容模型仍写成一行的形态（解析时尝试拆分，拆不开整句放进"终点"）
    "价值转变": ("value_shift_line", "str"),
    "下集钩子": ("hook_out_type", "str"),
    "开场钩子": ("hook_in_responds_to", "str"),
}

#: 世界设定块里的字段
_WORLD_FIELDS = {
    "时代": "era",
    "核心场景": "setting",
    "行得通的规则": "rules",
    "不出现的元素": "rules_forbidden",
    "规则": "rules",
    "不出现": "rules_forbidden",
}

#: 角色块里的字段（照 `_BIBLE_PROMPT` 的键名）
_CHAR_FIELDS = {
    "身份": "identity",
    "标签": "tags",
    "外观": "appearance",
    "外形": "appearance",
    "性格": "traits",
    "经历": "backstory",
    "动机": "motive",
    "关系": "relations",
    "弧光": "arc",
    "结局": "ending_state",
}

#: 顶层块头
_H_EPISODE = re.compile(r"^【\s*第\s*(\d+)\s*集\s*】\s*(?P<title>.*)$")
_H_CHARACTER = re.compile(r"^【\s*角色\s*】\s*(?P<name>[^｜|]+?)\s*(?:[｜|]\s*(?P<role>.*))?$")
_H_TITLE = re.compile(r"^【\s*剧名\s*】\s*(?P<v>.*)$")
_H_SYNOPSIS = re.compile(r"^【\s*全剧主线\s*】\s*(?P<v>.*)$")
_H_WORLD = re.compile(r"^【\s*世界\s*】\s*$")
_H_BEATS = re.compile(r"^【?\s*场景节拍\s*】?\s*[：:]?\s*(?P<v>.*)$")

#: `名称：内容`（中英文冒号都认）
_FLD = re.compile(r"^(?P<k>[^：:]{1,24})\s*[：:]\s*(?P<v>.*)$")

#: 已知要素名。白名单不是为了限制创作，而是为了**区分要素块与正文里本来就有的方括号**：
#: 导入草稿的 `synopsis` 常常是整段剧本原文，里面有 `【闪回】`、`【画面1】`、
#: `【一周后】`、`【字幕：十天前】`。全库回归实测，把这些也当要素切开会让 598 集内容被破坏。
ELEMENTS = ("开场卡点", "冲突", "期待点", "互动", "转折", "爽点", "结尾钩子")

#: 要素块头：`【要素名】…`。整段正文按出现顺序拼进 `synopsis`，
#: 不做结构化拆分 —— 用户看到的就是模型读到的（见模块 docstring「要素制」）。
_H_ELEM = re.compile(r"^【\s*(?P<k>" + "|".join(ELEMENTS) + r")\s*】\s*(?P<v>.*)$")

#: 判"这份 synopsis 是要素块形态"（导出/界面渲染用）：**每一非空行**都是要素行。
#: 只要混进自由散文，就说明它是老式梗概或导入的剧本原文，必须原样保留。
_ELEM_LINE = re.compile(r"^\s*【\s*(?:" + "|".join(ELEMENTS) + r")\s*】")

#: 续行前缀：内容里的换行要落在**同一个字段**里，不能变成新的一行内容。
#: 用全角空格开头 —— 规约文本里不会以它开头，且不会被 strip 掉。
_CONT = "\u3000\u3000"


# ---------------------------------------------------------------------------
# \u6309\u8981\u7d20\u7cbe\u786e\u6539\u5199\uff08\u4eba\u5de5\u4ecb\u5165\u7528\uff0c\u4e0d\u662f Agent \u7684\u81ea\u7531\u6539\u5199\uff09
# ---------------------------------------------------------------------------

#: 场景节拍的一条：`1. 地点｜人物｜动作｜转折`
_BEAT_ITEM = re.compile(r"^\s*\d+\s*[.、)）]\s*(?P<v>.+)$")


# ---------------------------------------------------------------------------
# 解析
# ---------------------------------------------------------------------------

def _split_inline(v: str) -> list[str]:
    """「、，；/」分隔的短列表。"""
    return [x.strip() for x in re.split(r"[、，,；;]", v or "") if x.strip()]


def _end_block(state: dict) -> dict:
    """收口当前块，返回它的中间结构。"""
    return state


def parse_outline(text: str, *, start: int = 1) -> dict:
    """把规约文本解析成**与旧 JSON 完全相同的中间 dict**。

    返回 `{"title","synopsis","world","characters","chapters"}`，可原样交给
    `outline_gen._norm_chapters()` 与 `_fill_outline_head()`。

    `start` 只用于"模型没写集号"或"集号与批次不符"时的兜底编号 ——
    **集号以批次为准**，不信模型自己编的（第 2 批以后模型常从 1 重编）。
    """
    raw = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    raw = re.sub(r"^\s*```[a-zA-Z]*\s*", "", raw.strip())
    raw = re.sub(r"\s*```\s*$", "", raw).strip()
    if not raw:
        raise ValueError("大纲输出为空")

    # JSON 回退：模型偶发不遵从格式，或未迁移的模板
    if raw.lstrip()[:1] in "[{":
        try:
            import json as _json
            data = _json.loads(raw)
            if isinstance(data, dict):
                logger.info("大纲输出是 JSON，走兼容路径")
                return data
        except Exception:  # noqa: BLE001
            pass

    out: dict = {"title": "", "synopsis": "", "world": {}, "characters": [], "chapters": []}

    mode = "top"          # top | world | char | episode
    cur_world: dict = {}
    cur_char: dict | None = None
    cur_ep: dict | None = None
    cur_key: str | None = None       # 当前正在续写的字段键
    cur_type: str = "str"
    beats_mode = False

    def flush_char():
        nonlocal cur_char
        if cur_char and str(cur_char.get("name") or "").strip():
            out["characters"].append(cur_char)
        cur_char = None

    def flush_ep():
        nonlocal cur_ep
        if cur_ep:
            out["chapters"].append(cur_ep)
        cur_ep = None

    def flush_world():
        if cur_world:
            out["world"] = dict(cur_world)

    def ensure_ep() -> dict:
        nonlocal cur_ep
        if cur_ep is None:
            cur_ep = {"order": None, "title": "", "_f": {}, "_plant": [], "_payoff": [],
                      "_beats": []}
        return cur_ep

    for ln in raw.split("\n"):
        # ⚠️ 续行必须在 strip 之前判：它的特征就是行首的全角空格。
        #    它也可能是**空行**（原文里本来就有空段），所以不能先丢掉空行。
        if ln.startswith(_CONT):
            _append_continuation(out, cur_ep, cur_char, cur_world, mode, cur_key,
                                 cur_type, ln[len(_CONT):])
            continue
        line = ln.strip()
        if not line:
            continue

        # ---- 块头 ----
        m = _H_TITLE.match(line)
        if m:
            flush_ep(); flush_char(); flush_world()
            out["title"] = m.group("v").strip()
            mode, cur_key, beats_mode = "top", None, False
            continue

        m = _H_SYNOPSIS.match(line)
        if m:
            flush_ep(); flush_char(); flush_world()
            out["synopsis"] = m.group("v").strip()
            mode, cur_key, beats_mode = "top", "synopsis", False
            continue

        if _H_WORLD.match(line):
            flush_ep(); flush_char()
            mode, cur_key, cur_world, beats_mode = "world", None, {}, False
            continue

        m = _H_CHARACTER.match(line)
        if m:
            flush_ep(); flush_world()
            flush_char()
            cur_char = {"name": m.group("name").strip(),
                        "role": (m.group("role") or "").strip(),
                        "_f": {}}
            mode, cur_key, beats_mode = "char", None, False
            continue

        m = _H_EPISODE.match(line)
        if m:
            flush_char(); flush_world()
            flush_ep()
            cur_ep = {"order": int(m.group(1)), "title": m.group("title").strip(),
                      "_f": {}, "_plant": [], "_payoff": [], "_beats": [],
                      "_elements": []}
            mode, cur_key, beats_mode = "episode", None, False
            continue

        # ---- 要素块：`【冲突】…`。整段按顺序拼进 synopsis，不做结构化拆分。 ----
        # 位置必须在【第N集】/【世界】/【角色】之后 —— 那几个也是 `【xx】` 形态，
        # 先匹配到的先赢；走到这里的一定是集内的创作要素。
        m = _H_ELEM.match(line)
        if m and mode == "episode":
            ep = ensure_ep()
            ep["_elements"].append({"k": m.group("k").strip(), "v": (m.group("v") or "").strip()})
            cur_key, cur_type, beats_mode = "_elements", "element", False
            continue

        # ---- 旧格式的场景节拍：仍收下，但不进 synopsis（下游已不再读 beats）----
        m = _H_BEATS.match(line)
        if m and mode == "episode":
            beats_mode = True
            cur_key, cur_type = "_beats", "beat"
            v = (m.group("v") or "").strip()
            if v:
                _push_beat(ensure_ep(), v)
            continue

        # ---- 字段行 ----
        m = _FLD.match(line)
        key = m.group("k").strip() if m else ""
        val = (m.group("v") or "").strip() if m else ""

        if mode == "episode":
            beats_mode = False
            ep = ensure_ep()
            if key in _EP_FIELDS:
                cur_key, cur_type = _EP_FIELDS[key]
                cur_key_type = cur_type
                if cur_type == "list_prefixed":
                    _push_plant_payoff(ep, val)
                elif cur_type == "list_inline":
                    _push_list(ep["_f"], cur_key, val)
                elif cur_type == "list_kv":
                    ep["_f"].setdefault(cur_key, {})
                    _push_kv(ep["_f"][cur_key], val)
                elif cur_type == "list":
                    ep["_f"].setdefault(cur_key, [])
                    ep["_f"][cur_key].extend(_strip_bullet_items(val))
                elif cur_type == "num":
                    ep["_f"][cur_key] = val
                elif cur_type == "beat":
                    pass
                else:
                    ep["_f"][cur_key] = val
                cur_type = cur_key_type
                continue
            if beats_mode or cur_type == "beat":
                _push_beat(ep, line)
                continue
            # 要素块里的续行（模型把一段话换行了）
            if cur_type == "element" and ep["_elements"]:
                last = ep["_elements"][-1]
                last["v"] = (last["v"] + "\n" + line).strip()
                continue
            # 认不出的行：并进上一个字段
            if cur_key:
                _append_text(ep, cur_key, cur_type, line)
            continue

        if mode == "world":
            if key in _WORLD_FIELDS:
                cur_key = _WORLD_FIELDS[key]
                cur_type = _world_type(cur_key)
                if val:
                    _world_add(cur_world, cur_key, cur_type, val)
                continue
            if cur_key:
                _world_add(cur_world, cur_key, cur_type, line)
            continue

        if mode == "char" and cur_char is not None:
            if key in _CHAR_FIELDS:
                cur_key = _CHAR_FIELDS[key]
                cur_type = "list" if cur_key in ("tags", "traits") else "str"
                if val:
                    if cur_type == "list":
                        cur_char["_f"].setdefault(cur_key, []).extend(_split_inline(val))
                    else:
                        cur_char["_f"][cur_key] = val
                continue
            if cur_key:
                if cur_type == "list":
                    cur_char["_f"].setdefault(cur_key, []).extend(_split_inline(line))
                else:
                    cur_char["_f"][cur_key] = (
                        cur_char["_f"].get(cur_key, "") + "\n" + line).strip()
            continue

        # mode == "top"：`【全剧主线】` 之后的段落
        if cur_key == "synopsis":
            out["synopsis"] = (out["synopsis"] + "\n" + line).strip()

    flush_char(); flush_world(); flush_ep()

    if not out["chapters"]:
        raise ValueError("大纲输出里找不到任何【第N集】块")

    return _finalize(out, start)


def _append_continuation(out, ep, ch, world, mode: str, key: str | None,
                         typ: str, rest: str) -> None:
    """把一条续行并回当前字段（保留原文里的换行与空行）。"""
    if not key:
        return
    if mode == "top" and key == "synopsis":
        out["synopsis"] = str(out.get("synopsis") or "") + "\n" + rest
        return
    if mode == "episode" and ep is not None:
        if typ == "list":
            lst = _as_list(ep["_f"], key)
            if lst:
                lst[-1] = lst[-1] + "\n" + rest
            elif rest.strip():
                lst.append(rest)
            return
        if typ in ("list_inline", "list_kv", "list_prefixed", "beat", "num"):
            return
        old_v = str(ep["_f"].get(key) or "")
        ep["_f"][key] = (old_v + "\n" + rest) if old_v else rest
        return

    if mode == "world":
        old_v = str(world.get(key) or "")
        world[key] = (old_v + "\n" + rest) if old_v else rest
        return

    if mode == "char" and ch is not None:
        if typ == "list":
            lst = _as_list(ch["_f"], key)
            if lst:
                lst[-1] = lst[-1] + "\n" + rest
            elif rest.strip():
                lst.append(rest)
            return
        old_v = str(ch["_f"].get(key) or "")
        ch["_f"][key] = (old_v + "\n" + rest) if old_v else rest
        return

def _world_type(key: str) -> str:
    """核心场景与规则都是多条的；时代是单值。"""
    return "str" if key == "era" else "list"


def _world_add(world: dict, key: str, typ: str, line: str) -> None:
    """世界块的一行入账。

    `setting` 在旧结构里是**字符串**（`_BIBLE_PROMPT` 要求 80~150 字的一段），
    而模型按规约写成多条 `- 场景名——含义`。这里把多条用换行拼回一个字符串，
    保持与旧 JSON 同型 —— 下游 `bible_text()` 直接 `f"- 世界观: {era} / {setting}"`，
    换类型会让它打印出 `['a','b']` 这种噪声。
    """
    items = _strip_bullet_items(line)
    if not items:
        return
    if typ == "list" and key != "setting":
        _as_list(world, key).extend(items)
        return
    joined = "\n".join(items)
    old_v = str(world.get(key) or "").strip()
    world[key] = (old_v + "\n" + joined).strip() if old_v else joined


_QUOTE_PAIRS = (('"', '"'), ("'", "'"), ("“", "”"), ("「", "」"), ("『", "』"))


def _clean_val(v: str) -> str:
    """清掉"从…变成…"这种一行写法带来的包裹引号。

    ⚠️ 只剥**成对的**外层引号。无条件 `strip('"“”')` 会把 `被指挥的"打工人"` 的
    结尾引号单独吃掉，变成不配对的字符串（实测踩到）。
    ⚠️ 不删句号：原值本来就带句号时，删掉就是丢内容（实测 12 处）。
    """
    s = str(v or "").strip()
    for open_q, close_q in _QUOTE_PAIRS:
        if len(s) >= 2 and s.startswith(open_q) and s.endswith(close_q):
            s = s[1:-1].strip()
            break
    # 模型习惯在引号内末尾补一个逗号（`从"甲，"变成"乙"`）。句号保留 ——
    # 它可能是内容本身的一部分；逗号在句尾则一定是多余的。
    s = re.sub(r"[，,；;]+$", "", s).strip()
    return s.strip()


def _strip_bullet_items(v: str) -> list[str]:
    """一条列表项：剥掉 `- ` / `1. ` 前缀。

    ⚠️ **不按顿号拆** —— 条目自己就含顿号（"网络舆论危机爆发，旧照被曝光抹黑"），
    拆开会把一条碎成两条（实测 must_have 481 处）。
    """
    s = (v or "").strip()
    s = re.sub(r"^\s*[-—•·]\s*", "", s)
    # ⚠️ 序号前缀的 `.` 后面**不能紧跟数字** —— 否则 `0.5%排片率` 会被削成 `5%排片率`
    #    （实测踩到）。也要求后面有空白或直接结束，才算序号。
    s = re.sub(r"^\s*\d+\s*[.、)）](?!\d)\s*", "", s)
    return [s] if s else []


def _push_list(container: dict, key: str, v: str) -> None:
    """往列表字段里加内容，兼容两种写法：

    · **一行一条**（`- 药瓶被捡起`）：这是 dump 与规约都推荐的形态；
    · **行内顿号分隔**（`药瓶被捡起、门被反锁`）：模型偶尔这么写，按顿号拆。

    判据是这一行有没有 `- ` 前缀：有就是单条，没有才按顿号拆。
    """
    raw = (v or "").strip()
    if not raw:
        return
    lst = _as_list(container, key)
    if re.match(r"^\s*[-—•·]\s*", raw):
        lst.extend(_strip_bullet_items(raw))
    else:
        lst.extend(x.strip() for x in re.split(r"[、，,；;]", raw) if x.strip())


def _push_plant_payoff(ep: dict, val: str) -> None:
    """`埋：…` / `收：…` 分流到两个列表。"""
    v = (val or "").strip()
    v = re.sub(r"^\s*[-—•·]\s*", "", v)
    if not v:
        return
    if re.match(r"^埋\s*[：:]", v):
        ep["_plant"].append(re.sub(r"^埋\s*[：:]\s*", "", v).strip())
    elif re.match(r"^(收|回收)\s*[：:]", v):
        ep["_payoff"].append(re.sub(r"^(收|回收)\s*[：:]\s*", "", v).strip())
    else:
        ep["_plant"].append(v)


def _push_kv(d: dict, val: str) -> None:
    """`角色名：知道了什么`。"""
    v = (val or "").strip()
    v = re.sub(r"^\s*[-—•·]\s*", "", v)
    m = _FLD.match(v)
    if m:
        d[m.group("k").strip()] = m.group("v").strip()
    elif v:
        d[v] = ""


def _push_beat(ep: dict, line: str) -> None:
    """一条节拍：`地点｜人物｜动作｜转折`。

    段数不足时按顺序补前面的段（模型偶尔只写"动作｜转折"），
    全空的丢掉。
    """
    v = (line or "").strip()
    v = re.sub(r"^\s*\d+\s*[.、)）]\s*", "", v)
    if not v:
        return
    parts = [p.strip() for p in re.split(r"[｜|]", v)]
    while len(parts) < 4:
        parts.append("")
    beat = {"at": parts[0], "who": parts[1], "action": parts[2], "turn": parts[3]}
    if any(beat.values()):
        ep["_beats"].append(beat)


def _as_list(container: dict, key: str) -> list:
    """取一个必定是 list 的容器。

    字段首次出现时可能被写成空值（`本集边界：` 后面直接换行），
    若已经存成了字符串，这里就地纠正 —— 否则下一行 `.extend` 会炸。
    """
    v = container.get(key)
    if not isinstance(v, list):
        v = []
        container[key] = v
    return v


def _append_text(ep: dict, key: str, typ: str, line: str) -> None:
    """把认不出的行并进上一个字段。"""
    if typ == "list":
        _as_list(ep["_f"], key).extend(_strip_bullet_items(line))
        return
    if typ == "list_inline":
        _push_list(ep["_f"], key, line)
        return
    if typ == "list_kv":
        if not isinstance(ep["_f"].get(key), dict):
            ep["_f"][key] = {}
        _push_kv(ep["_f"][key], line)
        return
    if typ == "list_prefixed":
        _push_plant_payoff(ep, line)
        return
    if typ == "beat":
        _push_beat(ep, line)
        return
    old = str(ep["_f"].get(key) or "")
    ep["_f"][key] = (old + "\n" + line).strip() if old else line


#: 价值转变：`从"A"变成"B"` / `从A变成B` / `A → B`。
#: ⚠️ `a` 用非贪婪且**排除引号**，否则 `从"甲，乙"变成"丙"` 里的逗号会让
#: 引号内的顿号被当成结束标记，尾部残留一个逗号（实测第 1 集就是这样）。
#: 这些键只用于运输，装配时会被映射进嵌套结构，不能直接当集字段写出去。
_TRANSPORT_KEYS = frozenset({
    "value_shift_line", "value_shift_from", "value_shift_to",
    "power_pair", "power_focus",
    "hook_in_responds_to", "hook_in_mode", "hook_in_type", "hook_in_strength",
    "hook_in_leads_to",
    "hook_out_type", "hook_out_strength", "hook_out_leads_to",
    "hook_out_responds_to", "hook_out_mode",
})

_VS_RE = re.compile(
    r"^\s*从\s*[「\"“']?(?P<a>[^」\"”']+?)[」\"”']?\s*变(?:成|为)\s*"
    r"[「\"“']?(?P<b>[^」\"”']+?)[」\"”']?\s*[。.]?\s*$")
_POW_RE = re.compile(r"^\s*(?P<a>[^→|｜]+?)\s*(?:→|->|对抗|vs\.?)\s*(?P<b>[^→|｜]+?)\s*$", re.I)


def _finalize(out: dict, start: int) -> dict:
    """装配成**旧 JSON 的同款结构**，供 `_norm_chapters` / `_fill_outline_head` 消费。

    集号以批次为准：模型从 1 重编是常态（第 2 批以后每批都会犯），
    只要它能给出连续的集号就按顺序重编到 start 起；
    集号与批次完全对不上时也按出现顺序重编，并由调用方决定是否记为不符。
    """
    chapters, _ = _renumber(out.get("chapters") or [], start)
    out["chapters"] = chapters

    chars = []
    for c in out.get("characters") or []:
        rec = {"name": c.get("name", ""), "role": c.get("role", "")}
        rec.update(c.get("_f") or {})
        chars.append(rec)
    out["characters"] = chars

    w = out.get("world") or {}
    out["world"] = {k: v for k, v in w.items() if v}
    return out


def _renumber(eps: list[dict], start: int) -> tuple[list[dict], bool]:
    """按出现顺序重编集号；返回 (chapters, 是否与模型自报的一致)。

    2026-11-07：一集只产出 `order` / `title` / `synopsis`。
    大纲的正文就是要素块拼成的那一段 —— 用户看到的、模型收到的同一份。
    旧的契约字段（value_shift/hook_out/power/plant/payoff/beats…）不再产出；
    解析器仍认得那些行（老模板的输出不会炸），但结果只并入正文，不单独成键。
    """
    consistent = True
    out = []
    for i, ep in enumerate(eps):
        want = start + i
        got = ep.get("order")
        if got is not None and int(got) != want:
            consistent = False
        f = ep.get("_f") or {}

        # ---- 正文：要素块优先，其次旧的 `梗概：` ----
        elements = ep.get("_elements") or []
        blocks: list[str] = []
        for e in elements:
            k, v = str(e.get("k") or "").strip(), str(e.get("v") or "").strip()
            if not k and not v:
                continue
            blocks.append(f"【{k}】{v}".rstrip() if k else v)
        synopsis = "\n".join(blocks) if blocks else str(f.get("synopsis") or "").strip()

        # 旧模板给的是分散字段（没有【xx】要素）。把这些内容按固定顺序整理成
        # 同样的要素块，避免模型照老格式写时正文变空 —— 旧提示词还在 DB 里，
        # 上线后一段时间内一定会碰到。
        if not blocks:
            synopsis = _legacy_fields_to_body(f) or synopsis

        out.append({
            "order": want,
            "title": ep.get("title") or f"第{want}集",
            "synopsis": synopsis,
        })
    return out, consistent


#: 旧模板分散字段 → 要素名的映射。顺序即输出顺序。
_LEGACY_TO_ELEMENT: tuple[tuple[str, str], ...] = (
    ("hook_in_responds_to", "开场卡点"),
    ("core_push", "冲突"),
    ("opponent_move", "对手这一集做了什么"),
    ("payoff_moment", "爽点"),
    ("stakes", "失败代价"),
    ("escalation", "推进维度"),
    ("hook_out_type", "结尾钩子"),
    ("hook_out_leads_to", "直接引发"),
)


def _legacy_fields_to_body(f: dict) -> str:
    """把旧模板的分散字段攒成要素块正文。没有内容时返回空串。"""
    lines: list[str] = []
    for key, label in _LEGACY_TO_ELEMENT:
        v = str(f.get(key) or "").strip()
        if not v:
            continue
        if key == "hook_out_type" and str(f.get("hook_out_strength") or "").strip():
            v = f"{v}（强度：{str(f['hook_out_strength']).strip()}）"
        lines.append(f"【{label}】{v}")
    # 价值转变 / 伏笔 / 边界：旧字段里最实质的几项，一并留下来
    vf = _clean_val(str(f.get("value_shift_from") or ""))
    vt = _clean_val(str(f.get("value_shift_to") or ""))
    if vf or vt:
        lines.append(f"【价值转变】从「{vf}」变成「{vt}」")
    plants = [str(x).strip() for x in (f.get("plant") or []) if str(x).strip()]
    if plants:
        lines.append("【埋下的伏笔】" + "；".join(plants))
    payoffs = [str(x).strip() for x in (f.get("payoff") or []) if str(x).strip()]
    if payoffs:
        lines.append("【回收的伏笔】" + "；".join(payoffs))
    forb = [str(x).strip() for x in (f.get("forbidden") or []) if str(x).strip()]
    if forb:
        lines.append("【本集边界】" + "；".join(forb))
    return "\n".join(lines)



# ---------------------------------------------------------------------------
# 序列化：库内 JSON → 规约文本（续写上下文 / 改稿底稿 / 人工核对）
# ---------------------------------------------------------------------------

def dump_episode(ep: dict) -> str:
    """一集 → 一块规约文本。"""
    order = ep.get("order") or 0
    lines = [f"【第{order}集】{ep.get('title') or ''}".rstrip(), ""]

    def put(label: str, val) -> None:
        """单值字段。**内容里的换行与空白一律原样保留** —— 梗概/经历本来就是多段的，
        压成一行再解析回来就对不上（实测 159 条 synopsis 因此不一致）。"""
        # 换行统一：库里确有 Windows 换行的条目，不统一会让往返永远差一个回车符
        v = str(val or "").replace("\r\n", "\n").replace("\r", "\n")
        if not v.strip():
            return
        parts = v.split("\n")
        lines.append(f"{label}：{parts[0].rstrip()}")
        for extra in parts[1:]:
            # 行尾空白一律清掉：规约文本按行读，行尾空格无法在往返中保留
            # （读取时必然被 strip），留着只会造成"回读不一致"的假象。
            lines.append(_CONT + extra.rstrip())

    def put_list(label: str, vals) -> None:
        """列表字段：**一项一行**。

        不能用「、」拼一行 —— 条目自己就含顿号（"网络舆论危机爆发，旧照被曝光抹黑"），
        拼回去再拆开就会把一个条目拆成两条（实测 must_have 481 处）。
        """
        items = [str(v).strip() for v in (vals or []) if str(v).strip()]
        if not items:
            return
        lines.append(f"{label}：")
        for it in items:
            sub = it.split("\n")
            lines.append(f"- {sub[0]}")
            for extra in sub[1:]:
                lines.append(_CONT + extra)

    syn = str(ep.get("synopsis") or "").replace("\r\n", "\n").replace("\r", "\n")
    if syn.strip():
        # 新版 synopsis 本身就是要素块（`【冲突】…`），原样吐出即可 ——
        # 它和用户界面上看到的是同一份文本，也是模型收到的同一份。
        # 老数据是纯散文，退化成 `梗概：` 一节。
        is_elements = any(_ELEM_LINE.match(x) for x in syn.split("\n") if x.strip())
        if is_elements:
            for line in syn.split("\n"):
                lines.append(line.rstrip())
            lines.append("")
        else:
            parts = syn.split("\n")
            lines.append("梗概：")
            lines.append(parts[0].rstrip())
            for extra in parts[1:]:
                lines.append(_CONT + extra.rstrip())
            lines.append("")

    # 2026-11-07：**正文是唯一事实**。老数据身上还有 core_push/stakes/plant 等旧字段，
    # 但它们不进 dump —— 一旦写进同一份文本，解析回来就会把正文替换成这些要素，
    # 用户看到的散文梗概被悄悄丢掉（全库回归实测 2862 集命中这一条）。
    # 旧字段仍留在库里的原 dict 上，`build_contract_block` 之类读得到；
    # dump 只负责把"用户看得见的那份"吐出来。
    return "\n".join(lines).rstrip()


def dump_outline(chapters: list[dict], *, with_head: bool = False,
                 head: dict | None = None) -> str:
    """一批集 → 规约文本。`with_head=True` 时把剧名/主线/世界/角色也带上。"""
    parts: list[str] = []
    if with_head and head:
        if head.get("title"):
            parts.append(f"【剧名】{head['title']}")
        if head.get("synopsis"):
            parts.append("【全剧主线】\n" + str(head["synopsis"]).strip())
        w = head.get("world") or {}
        if isinstance(w, dict) and w:
            lines = ["【世界】"]
            if w.get("era"):
                lines.append(f"时代：{w['era']}")
            for label, key in (("核心场景", "setting"), ("行得通的规则", "rules"),
                               ("不出现的元素", "rules_forbidden")):
                vals = w.get(key)
                if isinstance(vals, list) and vals:
                    lines.append(f"{label}：")
                    lines.extend(f"- {v}" for v in vals)
                elif str(vals or "").strip():
                    lines.append(f"{label}：{vals}")
            parts.append("\n".join(lines))
        for c in (head.get("characters") or []):
            if not isinstance(c, dict) or not c.get("name"):
                continue
            lines = [f"【角色】{c['name']}" + (f"｜{c['role']}" if c.get("role") else "")]
            for label, key in (("身份", "identity"), ("标签", "tags"), ("外观", "appearance"),
                               ("性格", "traits"), ("经历", "backstory"),
                               ("动机", "motive"), ("关系", "relations")):
                v = c.get(key)
                if isinstance(v, list):
                    v = "、".join(str(x) for x in v if str(x).strip())
                if str(v or "").strip():
                    lines.append(f"{label}：{v}")
            parts.append("\n".join(lines))

    for ep in chapters or []:
        if isinstance(ep, dict):
            parts.append(dump_episode(ep))
    return "\n\n".join(p for p in parts if p.strip())


# ---------------------------------------------------------------------------
# 故事圣经（第 1、2 阶段的产物）：同一套解析器，只是字段更多
# ---------------------------------------------------------------------------

#: 圣经独有字段 → 中间键。世界观与角色块与大纲复用同一套前缀。
_BIBLE_FIELDS = {
    "剧名": ("title", "str"),
    "一句话故事": ("one_liner", "str"),
    "题材定位": ("tone", "str"),
    "全剧前提": ("premise", "str"),
    "人物绑定": ("binding", "str"),
    "爽点承诺": ("genre_promise", "str"),
    "卖点": ("selling_points", "list"),
    "核心悬念": ("core_mysteries", "list"),
    "升级阶梯": ("escalation_ladder", "list"),
    "硬约束": ("forbidden", "list"),
    "世界观硬约束": ("forbidden", "list"),
}

#: 受众四个小项
_AUDIENCE_FIELDS = {"性别": "gender", "年龄": "age", "观看场景": "scene",
                    "此刻想被满足的情绪": "craving", "想要的情绪": "craving"}

#: 对手块
_OPPONENT_FIELDS = {"对手姓名": "name", "目标": "goal", "为什么站得住": "right_about",
                    "手段升级路径": "escalation"}

#: 主线三件事
_MAINLINE_FIELDS = {"要什么": "want", "谁在挡": "blocker", "靠什么赢": "edge"}


#: 圣经里的块头：【受众】【卖点】【核心悬念】【主线三件事】【主要对手】【升级阶梯】【硬约束】…
_H_BLOCK = re.compile(r"^【\s*(?P<name>[^】]+?)\s*】\s*(?P<rest>.*)$")

#: 块头名 → 目标。`list:` 前缀表示整块是一个列表。
_BIBLE_BLOCKS = {
    "受众": ("audience", None),
    "卖点": ("list", "selling_points"),
    "核心悬念": ("list", "core_mysteries"),
    "升级阶梯": ("list", "escalation_ladder"),
    "硬约束": ("list", "forbidden"),
    "世界观硬约束": ("list", "forbidden"),
    "世界": ("world", None),
    "主线三件事": ("mainline", None),
    "主要对手": ("opponent", None),
    "角色": ("char", None),
}

#: 角色块的**裸写法**：模型常把 `【角色】` 省掉，直接写 `云舒｜女主` 一行。
#: 只在"当前不在角色块里、且下一行看起来是角色字段"时才认，避免误判。
_BARE_CHAR = re.compile(r"^(?P<name>[^｜|【】（）()\s]{1,12})\s*[｜|]\s*"
                        r"(?P<role>主角|男主|女主|反派|配角|反派（[^）]*）|.*?)$")

#: 单行块头（`【剧名】xxx`）→ 字段
_BIBLE_HEAD_FIELDS = {
    "剧名": "title",
    "一句话故事": "one_liner",
    "题材定位": "tone",
    "全剧前提": "premise",
    "人物绑定": "binding",
    "爽点承诺": "genre_promise",
}


def _is_list_line(line: str) -> bool:
    """`- xxx` / `• xxx` / `1. xxx` —— 列表行。

    ⚠️ 序号形式要求 `.` 后不是数字（`0.5%` 不是序号）。
    """
    t = (line or "").strip()
    if re.match(r"^[-—•·]\s+", t):
        return True
    return bool(re.match(r"^\d+\s*[.、)）](?!\d)\s+", t))


def _looks_like_bare_char(line: str) -> bool:
    """这一行是不是"姓名｜定位"（可带 `姓名：` 前缀）。

    要排除普通带冒号的字段（`身份：甲 -> 乙`），判据是：
    去掉 `姓名：` 前缀后，整行**有且只有一处**分隔符 `｜`/`|`，
    且冒号最多一个（就是 `姓名：` 那个）。
    """
    t = re.sub(r"^姓名\s*[：:]\s*", "", line.strip())
    if "｜" not in t and "|" not in t:
        return False
    if "：" in t or ":" in t:
        return False
    parts = re.split(r"[｜|]", t)
    return len(parts) == 2 and all(p.strip() for p in parts)


def _next_is_char_field(raw: str, after_line: str) -> bool:
    """`raw` 里 `after_line` 的下一行是否以角色字段名开头。

    用来确认"裸的一行确实是角色块头"而不是普通文字。
    """
    lines = raw.split("\n")
    target = re.sub(r"^姓名\s*[：:]\s*", "", after_line.strip())
    for i, ln in enumerate(lines):
        if ln.strip() == after_line.strip() or \
                re.sub(r"^姓名\s*[：:]\s*", "", ln.strip()) == target:
            for nxt in lines[i + 1:]:
                t = nxt.strip()
                if not t:
                    continue
                m = _FLD.match(t)
                return bool(m and m.group("k").strip() in _CHAR_FIELDS)
            return False
    return False


def parse_bible(text: str) -> dict:
    """把规约文本解析成故事圣经的结构。

    与 `parse_outline` 共用字段识别规则，但块的种类更多
    （受众/卖点/悬念/主线/对手/升级阶梯/硬约束）。

    返回形状与 `story_bible._normalize_bible()` 的输入完全一致 ——
    规范化那一层（白名单、兜底值）一行都不用改。
    """
    raw = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    raw = re.sub(r"^\s*```[a-zA-Z]*\s*", "", raw.strip())
    raw = re.sub(r"\s*```\s*$", "", raw).strip()
    if not raw:
        raise ValueError("故事圣经输出为空")

    if raw.lstrip()[:1] in "[{":
        try:
            import json as _json
            data = _json.loads(raw)
            if isinstance(data, dict):
                logger.info("故事圣经输出是 JSON，走兼容路径")
                return data
        except Exception:  # noqa: BLE001
            pass

    out: dict = {
        "title": "", "one_liner": "", "tone": "", "premise": "", "binding": "",
        "genre_promise": "", "audience": {}, "selling_points": [], "core_mysteries": [],
        "escalation_ladder": [], "forbidden": [], "main_line": {}, "opponent": {},
        "world": {}, "characters": [],
    }

    #: 当前块。`block` 决定一行该往哪儿落；`cur_key` 是块内的子字段。
    block = "top"
    block_target: str | None = None      # list 块的键名
    pending_char = False                 # 刚见到 `【角色】`、名字在下一行
    cur_key: str | None = None
    cur_type = "str"

    def add_scalar(target: dict | None, key: str, val: str, cont: bool = False) -> None:
        tgt = out if target is None else target
        old_v = str(tgt.get(key) or "")
        tgt[key] = (old_v + "\n" + val) if (cont and old_v) else (val if not cont else
                                                                  (old_v + "\n" + val))

    for ln in raw.split("\n"):
        # 续行：先于 strip 判断（内容里本来就有空行）
        if ln.startswith(_CONT):
            rest = ln[len(_CONT):]
            if block == "world" and cur_key:
                # setting 在旧结构里是字符串（多条用换行拼），与 _world_add 保持一致
                if cur_type == "list" and cur_key != "setting":
                    out["world"].setdefault(cur_key, []).extend(_strip_bullet_items(rest))
                else:
                    out["world"][cur_key] = str(out["world"].get(cur_key) or "") + "\n" + rest
            elif block == "char" and cur_key:
                c = out["characters"][-1] if out["characters"] else None
                if c is not None:
                    if isinstance(c.get(cur_key), list) and c[cur_key]:
                        c[cur_key][-1] = c[cur_key][-1] + "\n" + rest
                    else:
                        c[cur_key] = str(c.get(cur_key) or "") + "\n" + rest
            elif block == "list":
                lst = out.get(block_target or "")
                if isinstance(lst, list) and lst:
                    lst[-1] = lst[-1] + "\n" + rest
                elif block_target:
                    out.setdefault(block_target, []).append(rest)
            elif block == "audience":
                last = [k for k in _AUDIENCE_FIELDS.values() if str(out["audience"].get(k) or "").strip()]
                if last:
                    out["audience"][last[-1]] = str(out["audience"][last[-1]]) + "\n" + rest
            elif cur_key:
                add_scalar(None, cur_key, rest, cont=True)
            continue

        line = ln.strip()
        if not line:
            continue

        # ---- 块头 ----
        m = _H_BLOCK.match(line)
        if m:
            name = m.group("name").strip()
            rest = (m.group("rest") or "").strip()
            if name in _BIBLE_HEAD_FIELDS:
                fld = _BIBLE_HEAD_FIELDS[name]
                out[fld] = rest
                # 内容常常写在**块头下一行**（`【一句话故事】\n……`），
                # 所以把当前键指向它，后续裸行会并进来。
                block, cur_key, cur_type = "top", fld, "str"
                continue
            if name in _BIBLE_BLOCKS:
                kind, target = _BIBLE_BLOCKS[name]
                block, block_target, cur_key, cur_type = kind, target, None, "str"
                pending_char = False
                if kind == "char":
                    # 两种写法都常见：
                    #   `【角色】沈栀｜女主`      —— 名字写在块头这一行
                    #   `【角色】` + 下一行 `沈栀｜女主` —— 名字在下一行
                    # 后者不能在这里建记录，否则会先塞进一条空名字的。
                    if rest:
                        nm, _, role = rest.partition("｜")
                        out["characters"].append({"name": nm.strip(), "role": role.strip()})
                        pending_char = False
                    else:
                        pending_char = True
                elif kind == "list" and rest:
                    out.setdefault(target or "", []).extend(_strip_bullet_items(rest))
                elif kind == "world" and rest:
                    cur_key, cur_type = "setting", "str"
                    out["world"]["setting"] = rest
                continue

        # `【角色】` 之后的第一行就是"姓名｜定位"
        if pending_char:
            nm, _, role = re.sub(r"^姓名\s*[：:]\s*", "", line).partition("｜")
            if not role:
                nm, _, role = re.sub(r"^姓名\s*[：:]\s*", "", line).partition("|")
            out["characters"].append({"name": nm.strip(), "role": role.strip()})
            pending_char = False
            cur_key, cur_type = None, "str"
            continue

        # 裸角色块：`云舒｜女主` 或 `姓名：云舒｜女主`。
        # 判据是这一行**只有姓名与定位、没有别的冒号字段**，且下一行以角色字段开头。
        if block != "char" and _looks_like_bare_char(line):
            m2 = _BARE_CHAR.match(re.sub(r"^姓名\s*[：:]\s*", "", line))
            if m2 and _next_is_char_field(raw, line):
                out["characters"].append({"name": m2.group("name").strip(),
                                          "role": m2.group("role").strip()})
                block, block_target, cur_key, cur_type = "char", None, None, "str"
                continue

        # ---- 列表行（`- xxx` / `1. xxx`）先于字段行判定 ----
        # 条目自己就带冒号（`- 第1-3集：订婚宴反杀`），若先走字段正则，
        # 会被当成"说话人=第1-3集"这类假字段，内容就丢了（实测 genre_promise 整段消失）。
        if _is_list_line(line):
            item = _strip_bullet_items(line)[0] if _strip_bullet_items(line) else ""
            if block == "list" and block_target:
                out.setdefault(block_target, []).append(item)
            elif block == "world" and cur_key:
                _world_add(out["world"], cur_key, cur_type, line)
            elif block == "char" and out["characters"]:
                c = out["characters"][-1]
                if cur_key:
                    if isinstance(c.get(cur_key), list):
                        c[cur_key].append(item)
                    else:
                        c[cur_key] = (str(c.get(cur_key) or "") + "\n" + item).strip()
            elif cur_key and block == "top":
                out[cur_key] = (str(out.get(cur_key) or "") + "\n" + line).strip()
            continue

        m = _FLD.match(line)
        key = m.group("k").strip() if m else ""
        val = (m.group("v") or "").strip() if m else ""

        # 全剧级的单值字段**无论写在哪一块之后都归顶层**：
        # `【主要对手】…` 之后紧跟一行 `全剧前提：…` 是常见写法，
        # 不特殊处理就会被并进上一个块的最后一个字段（实测踩到）。
        if key in _BIBLE_HEAD_FIELDS:
            # 同一个字段可能写成块头（`【爽点承诺】`）也可能写成一行（`爽点承诺：…`）。
            # 后者的内容常常是**紧随其后的列表**，所以 cur_key 要指向它，
            # 否则那几行 `- 第1-3集：…` 找不到归属、整段消失。
            fld = _BIBLE_HEAD_FIELDS[key]
            out[fld] = val
            block, cur_key, cur_type = "top", fld, "str"
            continue

        if block == "world":
            if key in _WORLD_FIELDS:
                cur_key = _WORLD_FIELDS[key]
                cur_type = _world_type(cur_key)
                if val:
                    _world_add(out["world"], cur_key, cur_type, val)
                continue
            if cur_key:
                _world_add(out["world"], cur_key, cur_type, line)
            continue

        if block == "char" and out["characters"]:
            c = out["characters"][-1]
            if key in _CHAR_FIELDS:
                cur_key = _CHAR_FIELDS[key]
                cur_type = "list" if cur_key in ("tags", "traits") else "str"
                if val:
                    if cur_type == "list":
                        c.setdefault(cur_key, []).extend(_split_inline(val))
                    else:
                        c[cur_key] = val
                continue
            if cur_key:
                if cur_type == "list":
                    c.setdefault(cur_key, []).extend(_split_inline(line))
                else:
                    c[cur_key] = (str(c.get(cur_key) or "") + "\n" + line).strip()
            continue

        if block == "list":
            if val:
                out.setdefault(block_target or "", []).extend(_strip_bullet_items(val))
            else:
                out.setdefault(block_target or "", []).extend(_strip_bullet_items(line))
            continue

        if block == "audience":
            if key in _AUDIENCE_FIELDS:
                cur_key = _AUDIENCE_FIELDS[key]
                out["audience"][cur_key] = val
            continue

        if block == "mainline":
            if key in _MAINLINE_FIELDS:
                cur_key = _MAINLINE_FIELDS[key]
                out["main_line"][cur_key] = val
            elif cur_key:
                out["main_line"][cur_key] = (str(out["main_line"].get(cur_key) or "") + "\n" + line).strip()
            continue

        if block == "opponent":
            if key in _OPPONENT_FIELDS:
                cur_key = _OPPONENT_FIELDS[key]
                if cur_key == "escalation":
                    out["opponent"].setdefault("escalation", []).extend(_split_inline(val))
                else:
                    out["opponent"][cur_key] = val
            elif cur_key and cur_key != "escalation":
                out["opponent"][cur_key] = (str(out["opponent"].get(cur_key) or "") + "\n" + line).strip()
            continue

        # ---- 顶层零散字段 ----
        if key in _BIBLE_FIELDS:
            tgt, typ = _BIBLE_FIELDS[key]
            cur_key, cur_type = tgt, typ
            if val:
                if typ == "list":
                    out.setdefault(tgt, []).extend(_strip_bullet_items(val))
                else:
                    out[tgt] = val
            continue
        if cur_key and block == "top":
            if cur_type == "list":
                out.setdefault(cur_key, []).extend(_strip_bullet_items(line))
            else:
                out[cur_key] = (str(out.get(cur_key) or "") + "\n" + line).strip()

    out["characters"] = [c for c in out["characters"] if str(c.get("name") or "").strip()]
    for k in ("main_line", "opponent", "audience", "world"):
        if not out.get(k):
            out.pop(k, None)
    return out


def dump_bible(bible: dict) -> str:
    """故事圣经 → 规约文本（人工核对 / 改稿底稿用）。"""
    if not bible:
        return ""
    parts: list[str] = []

    def put(label: str, val) -> None:
        v = str(val or "").replace("\r\n", "\n").replace("\r", "\n")
        if not v.strip():
            return
        p = v.split("\n")
        parts.append(f"{label}：{p[0].rstrip()}")
        for extra in p[1:]:
            parts.append(_CONT + extra.rstrip())

    put("剧名", bible.get("title"))
    put("一句话故事", bible.get("one_liner"))
    put("题材定位", bible.get("tone"))

    aud = bible.get("audience") or {}
    if isinstance(aud, dict) and any(str(v or "").strip() for v in aud.values()):
        parts.append("【受众】")
        for k, label in (("gender", "性别"), ("age", "年龄"),
                         ("scene", "观看场景"), ("craving", "此刻想被满足的情绪")):
            put(label, aud.get(k))
        parts.append("")

    for label, key in (("卖点", "selling_points"), ("核心悬念", "core_mysteries")):
        vals = [str(x).strip() for x in (bible.get(key) or []) if str(x).strip()]
        if vals:
            parts.append(f"【{label}】")
            for i, v in enumerate(vals, 1):
                parts.append(f"{i}. {v}")
            parts.append("")

    ml = bible.get("main_line") or {}
    if isinstance(ml, dict) and any(str(v or "").strip() for v in ml.values()):
        parts.append("【主线三件事】")
        for k, label in (("want", "要什么"), ("blocker", "谁在挡"), ("edge", "靠什么赢")):
            put(label, ml.get(k))
        parts.append("")

    put("全剧前提", bible.get("premise"))
    put("人物绑定", bible.get("binding"))
    put("爽点承诺", bible.get("genre_promise"))

    opp = bible.get("opponent") or {}
    if isinstance(opp, dict) and opp.get("name"):
        parts.append("【主要对手】")
        put("对手姓名", opp.get("name"))
        put("目标", opp.get("goal"))
        put("为什么站得住", opp.get("right_about"))
        if opp.get("escalation"):
            parts.append("手段升级路径：" + " → ".join(opp["escalation"]))
        parts.append("")

    w = bible.get("world") or {}
    if isinstance(w, dict) and w:
        parts.append("【世界】")
        put("时代", w.get("era"))
        for label, key in (("核心场景", "setting"), ("行得通的规则", "rules"),
                           ("不出现的元素", "rules_forbidden")):
            vals = w.get(key)
            if isinstance(vals, list) and vals:
                parts.append(f"{label}：")
                parts.extend(f"- {v}" for v in vals)
            elif str(vals or "").strip():
                put(label, vals)
        parts.append("")

    for c in (bible.get("characters") or []):
        if not isinstance(c, dict) or not c.get("name"):
            continue
        head = f"【角色】{c['name']}" + (f"｜{c['role']}" if c.get("role") else "")
        parts.append(head)
        for label, key in (("身份", "identity"), ("标签", "tags"), ("外观", "appearance"),
                           ("性格", "traits"), ("经历", "backstory"), ("动机", "motive"),
                           ("关系", "relations"), ("弧光", "arc"), ("结局", "ending_state"),
                           ("伤口", "wound"), ("需要学会", "need"), ("自欺", "lie")):
            v = c.get(key)
            if isinstance(v, list):
                v = "、".join(str(x) for x in v if str(x).strip())
            put(label, v)
        parts.append("")

    ladder = [str(x).strip() for x in (bible.get("escalation_ladder") or []) if str(x).strip()]
    if ladder:
        parts.append("【升级阶梯】")
        parts.extend(f"{i}. {v}" for i, v in enumerate(ladder, 1))
        parts.append("")

    forb = [str(x).strip() for x in (bible.get("forbidden") or []) if str(x).strip()]
    if forb:
        parts.append("【硬约束】")
        parts.extend(f"- {v}" for v in forb)

    return "\n".join(parts).strip()


# ---------------------------------------------------------------------------
# 自检
# ---------------------------------------------------------------------------

def _assert_no_braces() -> None:
    """输出规约会被 `.format()` 处理，含花括号会被当占位符。"""
    assert "{" not in OUTPUT_SPEC and "}" not in OUTPUT_SPEC, \
        "outline_format.OUTPUT_SPEC 含花括号，会在 str.format 路径下崩溃"


_assert_no_braces()
