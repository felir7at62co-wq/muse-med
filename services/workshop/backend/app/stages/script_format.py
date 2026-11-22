"""剧本的输出形态：**标准剧本格式**，不是 JSON。

## 为什么改（2026-11-06 用户裁定）

原先两条剧本路径的提示词自相矛盾：`_PROMPT` 第一句要求"原样转成**标准剧本格式**"，
末尾的 `JSON_OUTPUT_SPEC_BODY` 又要求"严格输出 **JSON 数组**"。这两件事互斥 ——
`elements` 的四个字段（action / dialogue / character / content）本来就是标准剧本格式的
序列化形式（`△` 动作行、`人物：台词` 行），JSON 只是换了个容器，还多付了转义的代价：

  · 台词里带引号、换行时，模型会绕开麻烦的写法，把话写简单了 —— JSON 特有的损失；
  · 一个 60 集的数组装不下，模型会按"这个格该多长"反过来压内容；
  · 长数组截断即全废；文本只丢到下刀处。

所以模型输出人类能直接读的剧本格式，解析由本模块机械完成。
**存储与 API 仍然是 JSON** —— 那是我们自己的形状，模型不需要知道。

## 输出格式（模型要写的样子）

```
【第12集】她把药瓶放进了继母的包里

1-1  夜 · 内 · 沈家储物间
人物：沈栀、沈薇（门外）、林素云（门外）
△沈栀靠在门后，手里攥着一把生锈的钥匙。门外传来说话声。
沈薇（门外）：妈，她会不会听见了？
林素云（门外）：听见又怎么样。她连这个家的门都出不去。
△沈栀低头看手里的药瓶，把它塞进外套内袋。

1-2  夜 · 内 · 沈家老宅客厅
人物：沈栀、林素云、沈老爷子
△水晶灯亮着。沈栀推门进来的时候，所有人的话都停了。
沈老爷子【不看她】：谁让你进来的。
```

行的种类只有六种，靠**行首特征**区分，顺序不可换：

| 行型 | 判据 | 落到哪 |
|---|---|---|
| 集标题 | `【第N集】标题` | 丢弃（集号由调用方决定，不信模型） |
| 场次头 | `<集号>-<场号>  <时间 · 内外 · 地点>` | scene_no / time_loc |
| 人物行 | `人物：A、B（门外）` | characters |
| 动作行 | 以 `△` 开头 | elements[].type=action |
| 闪回标记 | `〔闪回开始〕` / `〔闪回结束〕` | flashback_start / flashback_end |
| 字幕行 | `字幕：……` | 本场 subtitle |
| 对白行 | `人物（mode）【表演提示】：台词` | elements[].type=dialogue |

⚠️ **动作行必须先判**：动作行里常有冒号（`△沈栀说：……`），若先判对白会把它
误认成说话人"△沈栀说"。

## 兼容

`parse_script()` 先按文本格式解析；若整段里找不到任何场次头，且内容以 `[` / `{` 开头，
就退回旧的 JSON 解析。这样未迁移的 DB 模板、以及模型偶发不遵从格式的情况都不会炸，
可以在同一批任务里逐步切换。
"""
from __future__ import annotations

import json
import logging
import re

logger = logging.getLogger("script_format")


# ---------------------------------------------------------------------------
# 输出规约（进 prompt 的那一段）
# ---------------------------------------------------------------------------
# ⚠️ 本常量**不含任何花括号** —— 它既可能被拼进 fallback 模板里随 `.format()` 走一遍，
# 也可能在 DB 模板路径下在 format **之后**追加，两种路径下都必须原样显示。
# （旧的 JSON 版示例里用了双写花括号，在 DB 模板路径下会原样漏出 `{{`，是个潜伏 bug。）
OUTPUT_SPEC = '''
## ⭐ 输出格式：标准剧本格式（直接输出剧本正文，不要 JSON、不要解释）

【第12集】她把药瓶放进了继母的包里

1-1  夜 · 内 · 沈家储物间
人物：沈栀、沈薇（门外）、林素云（门外）
△沈栀靠在门后，手里攥着一把生锈的钥匙。门外传来说话声。
沈薇（门外）：妈，她会不会听见了？
林素云（门外）：听见又怎么样。她连这个家的门都出不去。
△沈栀低头看手里的药瓶，把它塞进外套内袋。

1-2  夜 · 内 · 沈家老宅客厅
人物：沈栀、林素云、沈老爷子、沈家旁支三人
△水晶灯亮着。沈栀推门进来的时候，所有人的话都停了。
沈老爷子【不看她】：谁让你进来的。
沈栀：我来还一样东西。

## 格式要点
1. 第一行写 `【第N集】本集标题`。**集号以调用方给的为准，不要自己编号。**
2. 每一场以场次头开头：`集号-场号`，两个空格，然后 `时间 · 内/外 · 地点`。场号从 1 开始。
3. 场次头下一行固定写 `人物：` 加本场所有人物，用顿号分隔；只在门外/电话里出现的，
   写在名字后的括号里（如 `沈薇（门外）`）。
4. 动作行以 `△` 开头，一个画面一行，写到能拍出来的程度。
5. 对白行写成 `人物：台词`。需要表演提示时写 `人物【提示】：台词`；
   需要在门外/电话/画外时写 `人物（门外）：台词`。两者都用时：`人物（门外）【冷笑】：台词`。
   内心独白写 `人物（内心）：台词`，旁白写 `旁白：……`。
6. 屏幕上出现文字时，单独一行写 `字幕：……`，多条用「／」隔开。
7. 闪回用单独一行 `〔闪回开始〕` 与 `〔闪回结束〕` 包住，中间照常写场次头、人物、动作、对白。
8. 一场一事，相邻场次之间有明确的因果触发；台词完整写全，不要省略、不要用"……"代替。
9. 只输出剧本正文本身。不要开场白、不要总结、不要用代码块包裹。
'''


# ---------------------------------------------------------------------------
# 序列化：库里的 JSON → 给模型看的剧本格式
# ---------------------------------------------------------------------------

#: 表演提示（dialogue.action）与"门外/电话"（mode）在文本里的写法。
_MODE_LABEL = {"OS": "内心", "VO": "旁白"}


def _scene_no(raw: str, order: int, index: int) -> str:
    """把任意历史场号规整成 `集号-场号`。

    `1-3` 原样保留；`3` 这类裸场号把集号补上；空值按数组顺序编。
    """
    m = re.match(r"^(\d+)\s*-\s*(\d+)$", raw or "")
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    m = re.match(r"^(\d+)$", raw or "")
    seq = m.group(1) if m else str(index + 1)
    return f"{order or 1}-{seq}"


#: 续行前缀：内容里的换行要落在**同一个元素**里，不能变成独立行。
#: 用全角空格开头做标记 —— 剧本正文不会以它开头，且它不会被 strip 掉。
_CONT = "\u3000\u3000"


def _emit(text: str) -> list[str]:
    """一条内容可能含换行（多段描写、多条群杂台词），输出成续行块。

    模型看到的就是「一段连续文字」，不会被误读成多条独立台词；
    解析时 `_parse_text` 把以续行前缀开头的行并回上一条元素。
    """
    parts = [p.strip() for p in str(text or "").split("\n")]
    parts = [p for p in parts if p]
    if not parts:
        return []
    return [parts[0]] + [_CONT + p for p in parts[1:]]


def _join_names(names: list) -> str:
    return "、".join(str(n).strip() for n in names if str(n).strip())


def dump_script(scenes: list[dict], *, order: int = 0, title: str = "") -> str:
    """把库里的场次数组渲染成模���可读、也可直接给人看的剧本格式。

    用途有两个：① 改稿时把"现有剧本"作为底稿交给模型；② 人工核对。
    """
    lines: list[str] = []
    if order or title:
        lines.append(f"【第{order}集】{title}".rstrip())
        lines.append("")

    for si, sc in enumerate(scenes or []):
        if not isinstance(sc, dict):
            continue
        # 场号统一写成「集号-场号」：历史数据里有 scene_no="1"（裸场号）的形态，
        # 原样输出会让下游误以为它是集号；这里按数组顺序重编，与 renumber_scenes 同义。
        scene_no = _scene_no(str(sc.get("scene_no") or "").strip(), order, si)
        time_loc = str(sc.get("time_loc") or "").strip() or "未注明"
        lines.append(f"{scene_no}  {time_loc}")

        names = [str(c).strip() for c in (sc.get("characters") or []) if str(c).strip()]
        if names:
            lines.append("人物：" + _join_names(names))

        if str(sc.get("subtitle") or "").strip():
            # 字幕内容本身也可能换行（实测有"〔字幕〕距离登基大典 仅剩半个时辰" +
            # 第二行" [实时倒计时 00:30:00]"），不续行就会变成一条独立动作行。
            lines.extend(_emit("〔字幕〕" + str(sc["subtitle"]).strip()))

        for e in sc.get("elements") or []:
            if not isinstance(e, dict):
                continue
            et = str(e.get("type") or "action").strip()

            if et in ("flashback_start", "flashback_end"):
                lines.append("〔闪回开始〕" if et == "flashback_start" else "〔闪回结束〕")
                continue

            if et == "action":
                c = str(e.get("content") or "").strip()
                if c:
                    lines.extend(_emit(c if c.startswith("△") else "△" + c))
                continue

            if et == "dialogue":
                who = str(e.get("character") or "").strip() or "旁白"
                text = str(e.get("content") or "").strip()
                if not text:
                    continue
                mode = str(e.get("mode") or "").strip()
                act = str(e.get("action") or "").strip()
                head = who
                if mode:
                    head += f"（{_MODE_LABEL.get(mode, mode)}）"
                if act:
                    head += f"【{act}】"
                lines.extend(_emit(f"{head}：{text}"))
                continue

            # 未知类型：当动作行兜底，宁可多一行也不要丢内容
            c = str(e.get("content") or "").strip()
            if c:
                lines.extend(_emit(c if c.startswith("△") else "△" + c))

        lines.append("")

    return "\n".join(lines).strip()


# ---------------------------------------------------------------------------
# 解析：模型输出的剧本格式 → 库里的 JSON
# ---------------------------------------------------------------------------

#: 场次头：`1-1  夜 · 内 · 沈家储物间`。
#: 集号与场号都允许是数字；两个空格不是硬要求（模型偶尔只写一个）。
#: 也接受裸场号 `1  夜 · 内 · …`（历史数据里有 scene_no="1" 的形态）。
_HEAD_RE = re.compile(r"^(?P<no>\d+(?:\s*-\s*\d+)?)\s+(?P<rest>\S.*)$")

#: 人物行
_CAST_RE = re.compile(r"^人物\s*[：:]\s*(?P<v>.*)$")

#: 字幕行。
#: ⚠️ 不能用 `字幕：…` —— 剧里真的有人物就叫"字幕"（库里 ID 123 就是一例），
#: 那样会把一条对白吞成字幕。用 〔〕 标记就不可能撞名。
_SUBTITLE_RE = re.compile(r"^[〔\[]\s*字幕\s*[〕\]]\s*(?P<v>.*)$")

#: 闪回标记（容忍几种括号）
_FLASH_ON_RE = re.compile(r"^[〔\[（(【]?\s*闪回开始\s*[〕\]）)】]?$")
_FLASH_OFF_RE = re.compile(r"^[〔\[（(【]?\s*闪回结束\s*[〕\]）)】]?$")

#: 对白行：`沈薇（门外）【冷笑】：台词`
#: 说话人限 1~12 字且**不能以外括号开头**，避免把 `（以下略）` 这类行当成对白。
#: 说话人：1~12 字，且**不许含任何括号与引号类字符**。
#: 否则 `[实时倒计时 00:30:00]` 这种以方括号开头的画面文字会被切成"说话人=实时倒计时 00"。
_DLG_RE = re.compile(
    r"^(?P<who>[^\s（）()【】〔〕\[\]「」『』《》“”:：]"
    r"[^（）()【】〔〕\[\]「」『』《》“”:：]{0,11})"
    r"(?:[（(](?P<mode>[^）)]*)[）)])?"
    r"(?:[【\[](?P<act>[^】\]]*)[】\]])?"
    r"\s*[：:]\s*(?P<text>.*)$"
)

#: 模型爱加的包裹与客套
_FENCE_RE = re.compile(r"^\s*```[a-zA-Z]*\s*|\s*```\s*$")

#: mode 文本 → 库里的取值
_MODE_BACK = {"内心": "OS", "内心独白": "OS", "画外音": "VO", "旁白": "VO", "门外": "门外"}


def _is_name(who: str) -> bool:
    """说话人得像个名字：至少含一个汉字/字母，且不含句读。"""
    w = (who or "").strip()
    if not w or w.isdigit():
        return False
    return bool(re.search(r"[\u4e00-\u9fffA-Za-z]", w))


def _strip_noise(text: str) -> str:
    """去掉代码块围栏与首尾客套话，但**不碰正文**。"""
    t = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    t = _FENCE_RE.sub("", t).strip()
    out = []
    for ln in t.split("\n"):
        s = ln.strip()
        # 只掐掉开头的"好的，以下是……"这类整行客套；行内出现的不动
        if not out and s and re.match(
                r"^(好的|好[的，,]|以下是|下面是我|这是.*剧本|已按要求|根据.*要求)", s):
            continue
        out.append(ln.rstrip())
    while out and not out[-1].strip():
        out.pop()
    return "\n".join(out)


def _looks_like_json(text: str) -> bool:
    t = (text or "").lstrip()
    return t.startswith("[") or t.startswith("{")


def parse_script(text: str, *, order: int = 0) -> list[dict]:
    """把模型输出的剧本格式解析成场次数组（未做集号重排，调用方后处理）。

    `order` 只用于给"没写场次头就来了内容"的兜底场景编号，正常路径不依赖它。

    ⚠️ 与旧 JSON 路径的取舍：旧路径是"要么整份解析成功、要么整份失败"。
       这里**逐行解析、逐场装配**，某一行认不出来只丢那一行并记日志，
       不会让整集作废。这也是换格式的直接收益之一。
    """
    raw = _strip_noise(text)
    if not raw:
        raise ValueError("剧本输出为空")

    scenes = _parse_text(raw)
    if not scenes:
        # 退回 JSON：未迁移的模板、或模型偶发不遵从格式时走这条
        if _looks_like_json(raw):
            logger.info("剧本输出是 JSON，走兼容解析")
            return _parse_json_compat(raw)
        raise ValueError("剧本输出里找不到场次头，也没有可解析的 JSON")

    _log_unparsed(raw, scenes)
    return scenes


def _parse_text(raw: str) -> list[dict]:
    scenes: list[dict] = []
    cur: dict | None = None
    #: 有没有真正开过场（用于区分"文本格式但一场没写"与"根本不是文本格式"）
    opened = False

    prev_el: dict | None = None

    for ln in raw.split("\n"):
        # ⚠️ 续行必须在 strip 之前判：它的特征就是行首的全角空格。
        if ln.startswith(_CONT):
            if prev_el is not None:
                prev_el["content"] = (prev_el.get("content") or "") + "\n" + ln[len(_CONT):].strip()
            continue
        line = ln.strip()
        if not line:
            continue

        # 集标题行：丢掉（集号以调用方为准）
        if re.match(r"^【\s*第\s*\d+\s*集\s*】", line):
            continue

        m = _HEAD_RE.match(line)
        if m and not line.startswith("△"):
            cur = {
                "scene_no": re.sub(r"\s+", "", m.group("no")),
                "time_loc": m.group("rest").strip(),
                "characters": [],
                "subtitle": "",
                "is_flashback": False,
                "elements": [],
            }
            scenes.append(cur)
            prev_el = None
            opened = True
            continue

        if cur is None:
            # 场次头之前的内容：若是集标题之外的散句，先收着当"场 1 之前的动作"，
            # 避免模型把开场白写成一句话就丢。等真正的场次头出现时不再需要它。
            continue

        if _FLASH_ON_RE.match(line):
            cur["is_flashback"] = True
            prev_el = {"type": "flashback_start"}
            cur["elements"].append(prev_el)
            continue
        if _FLASH_OFF_RE.match(line):
            cur["is_flashback"] = False
            prev_el = {"type": "flashback_end"}
            cur["elements"].append(prev_el)
            continue

        m = _CAST_RE.match(line)
        if m:
            cur["characters"] = [
                s.strip() for s in re.split(r"[、,，/｜|]", m.group("v")) if s.strip()
            ]
            continue

        m = _SUBTITLE_RE.match(line)
        if m:
            add = m.group("v").strip()
            cur["subtitle"] = (cur["subtitle"] + "／" + add) if cur["subtitle"] else add
            continue

        # ⚠️ 动作行先判：动作里带冒号很常见，先判对白会把它认成说话人
        if line.startswith("△"):
            prev_el = {"type": "action", "content": line}
            cur["elements"].append(prev_el)
            continue

        m = _DLG_RE.match(line)
        if m and (m.group("text") or "").strip() and _is_name(m.group("who")):
            who = m.group("who").strip()
            mode_raw = (m.group("mode") or "").strip()
            prev_el = {
                "type": "dialogue",
                "character": who,
                # 保留模型原话：只有认识的几种折算成 OS/VO，其余（门外/电话）原样留着，
                # 这样 `人物（门外）` 不会在往返中变成空串。
                "mode": _MODE_BACK.get(mode_raw, mode_raw),
                "action": (m.group("act") or "").strip(),
                "content": (m.group("text") or "").strip(),
            }
            cur["elements"].append(prev_el)
            continue

        # 认不出来的行：不丢，当动作行收下（剧本里裸行几乎都是画面描述），
        # 并在 _log_unparsed 里计数，便于发现格式漂移。
        prev_el = {"type": "action", "content": "△" + line}
        cur["elements"].append(prev_el)

    return scenes if opened else []


def _log_unparsed(raw: str, scenes: list[dict]) -> None:
    """格式漂移的早期预警：全篇没有一行 Δ、或某场一个元素都没有。"""
    total_el = sum(len(s.get("elements") or []) for s in scenes)
    if total_el == 0:
        logger.warning("剧本解析出 %d 场但 0 个元素，原始返回前 300 字: %s",
                       len(scenes), raw[:300])
        return
    empty = [s["scene_no"] for s in scenes if not (s.get("elements") or [])]
    if empty:
        logger.warning("以下场次解析后没有元素（可能格式不对）: %s", ", ".join(empty))


def _parse_json_compat(raw: str) -> list[dict]:
    """兼容旧的 JSON 数组输出。逻辑与迁移前 `_extract_json` 一致。"""
    from .storyboard_gen import _extract_json, _normalize
    return _normalize(_extract_json(raw))


# ---------------------------------------------------------------------------
# 自检
# ---------------------------------------------------------------------------

def _assert_no_braces() -> None:
    """本块的输出规约不许含花括号。

    它可能被拼进 fallback 模板随 `.format()` 走一遍（那里花括号会被当占位符），
    也常在 format 之后被追加。含花括号必炸其中一条路径。
    """
    assert "{" not in OUTPUT_SPEC and "}" not in OUTPUT_SPEC, \
        "script_format.OUTPUT_SPEC 含花括号，会在 str.format 路径下崩溃"


_assert_no_braces()
