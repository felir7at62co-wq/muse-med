"""整本 AI 精修 —— 剧本文本 ↔ shots_json 结构 的双向可逆转换。

背景: 整本精修需要把结构化 shots_json 序列化成"和导出 Word 可见文本一致"的纯文本
交给 LLM 通读改写, 再把改写后的文本无损拆回 shots_json 结构覆写草稿。

本项目原有 4 套"分镜→文本"拼法(hardcheck/_shots_to_text、export_docx、
adaptation_prompts、router)都是单向只读, 无一为可逆设计。本模块新建一对专用可逆函数,
格式严格对齐 export_docx.py 的可见文本, 并配 round-trip 自检。

格式锚点(每行类型都有独占行首特征, 保证可无损拆回):
  第N集 / 第N集 标题     -> 集边界
  场:1-1                 -> scene_no
  景:日 内 地点          -> time_loc
  人物:A、B、C           -> characters
  (出字幕: ...)          -> subtitle
  【快速闪回】/【闪出】    -> flashback_start / flashback_end (全等匹配)
  △...                   -> action 元素 (content 以单个 △ 开头)
  姓名: 台词             -> dialogue (mode="")
  姓名(OS, 提示): 台词   -> dialogue (括号首段 OS/VO 为 mode, 其余为 action 表演提示)
"""
from __future__ import annotations

import re

__all__ = [
    "serialize_episode",
    "parse_episode",
    "serialize_full",
    "roundtrip_equivalent",
]

_RE_EP = re.compile(r"^第\s*(\d+)\s*集(?:\s+(.*))?$")
_RE_SCENE = re.compile(r"^场[:：]\s*(.+)$")
_RE_TIMELOC = re.compile(r"^景[:：]\s*(.+)$")
_RE_CHARS = re.compile(r"^人物[:：]\s*(.+)$")
_RE_SUBTITLE = re.compile(r"^[（(]出字幕[:：]\s*(.*?)\s*[)）]\s*$")
_FLASHBACK_START = "【快速闪回】"
_FLASHBACK_END = "【闪出】"
_RE_DIALOGUE = re.compile(
    r"^([^：:（(【△]{1,20}?)\s*"
    r"(?:[（(]([^)）]*)[)）])?\s*"
    r"[:：]\s*(.*)$"
)

#: 台词行的**宽松兜底**（只在严格版匹配失败后才试，见 parse_episode）。
#
# ⚠️ 2026-10-08 加。角色的名字里带括号时，严格版整行匹配不上：
#   · `沈清漪（年轻）(对着江水喃喃自语…): 外婆…` —— 名字组 `[^：:（(【△]`
#     不允许出现 `（`，遇到就断；
#   · `系统（VO）机械音: 【警告！…` —— 同理。
# 后果：这一行落进"都不是就按动作行处理"的兜底分支，**台词静默变成动作**。
# 于是 `roundtrip_equivalent` 报"格式无法被系统解析"，体检里显示成"硬伤"，
# 而用户看那份稿子完全正常 —— 这就是他报的**误判**来源之一（全库实测 65 集）。
#
# 为什么是函数而不是一条正则：表演提示可以很长（上面第一条的括号里就有 18 字），
# 固定长度的量词够不到冒号。这里改成**扫冒号**：从行首第一个冒号起，
# 取它左边的部分、剥掉紧贴末尾的一组括号当作表演提示，剩下的是名字。
# 名字得像个名字（1–20 字、不含句读标点）才认，否则试下一个冒号。
_RE_PROSE_CHARS = re.compile(r"[，。！？；、…—～·“”‘’\"']")


_PAREN_OPEN = "（("
_PAREN_CLOSE = "）)"


def _split_trailing_meta(head: str) -> tuple[str, str]:
    """把「名字(表演提示)」拆成 (名字, 提示)。

    只认**紧贴末尾**的那一组括号：``沈清漪（年轻）(喃喃自语)`` → ``('沈清漪（年轻）', '喃喃自语')``。
    括号里的名字（"沈清漪（年轻）"）因此得以保留，而提示不会被误当名字。

    ⚠️ 2026-10-08 修：必须**配对计数**，不能再用正则 ``[^（()）]*``。
    表演提示里常常再嵌一层括号，例如
    ``沈承业(声音带了哭腔，绝望地看向沈老太君（陆氏）)`` ——
    正则匹配不到内层的全角右括号就整组放弃，名字于是变成一整句（含逗号），
    被散文闸拦下，**台词降级成动作**（草稿 331/289/359/356/395 各 1 集）。
    这里从行尾往前数括号深度，直到配平为止，嵌套多少层都能剥对。
    """
    h = (head or "").strip()
    if not h or h[-1] not in _PAREN_CLOSE:
        return h, ""
    depth = 0
    for i in range(len(h) - 1, -1, -1):
        ch = h[i]
        if ch in _PAREN_CLOSE:
            depth += 1
        elif ch in _PAREN_OPEN:
            depth -= 1
            if depth == 0:
                return h[:i].strip(), h[i + 1:-1].strip()
    return h, ""


def _loose_dialogue(line: str) -> tuple[str, str, str] | None:
    """宽松切分一条台词行 → (名字, 括号内容, 台词)；切不出像话的结果返回 None。

    ⚠️ 放宽的代价是会把「描写句里带个冒号」的行也圈进来（``他转身: 离开``）。
    实测全库无此形态，但仍按"名字得像名字"设了闸：长度 ≤20、不含句读标点。
    真放行了也只是多一条台词元素，不会丢字 —— 名字与台词都原样保留。

    唯一的例外：整行左边**只有一组括号**（``(声音空灵而冰冷): 台词``）时允许名字为空。
    那是"没有明确说话人"的合法写法（画外音/系统播报），丢掉它就是**整条台词消失**；
    而文本格式本身没有别的办法表达它，所以照收。
    """
    for i, ch in enumerate(line):
        if ch not in "：:":
            continue
        content = line[i + 1:].strip()
        if not content:
            continue
        head = line[:i].strip()
        if not head:
            # 行首直接就是冒号（``: 霍——``）—— 这是**无名台词**序列化后的样子
            # （character 为空，见 serialize_episode 里那条注释）。不认它就会
            # 变成 ``△: 霍——`` 动作行，整条台词丢字（草稿 648/6 实测）。
            # 动作行永远带 △ 开头，绝不可能走到这，所以没有抢行的风险。
            return "", "", content
        name, meta = _split_trailing_meta(head)
        if not name:
            # 左半边整个就是一组括号 → 无名台词（上面注释里的例外）。
            if head[0] in _PAREN_OPEN and meta:
                return "", meta, content
            continue
        if len(name) > 20 or _RE_PROSE_CHARS.search(name):
            continue
        return name, meta, content
    return None


_WS_RUN_RE = re.compile(r"\s+")


def _elements_from_text(scene: dict) -> list[dict]:
    """elements 为空的老场景：从 ``dialogue`` / ``action`` 文本字段重建元素。

    ⚠️ 2026-10-08 加。有两批存量场景**没有 ``elements``**，只把文字放在
    ``dialogue`` / ``action`` 两个长字符串里（如草稿 307 / 273，各 50 与 40 集全中）：
      · 序列化侧旧代码写的是 ``if elements: … else: 按 \\n 拆 action/dialogue 逐行吐``
        —— 于是**一个字都不少地导出**了；
      · 比较侧 `_norm_elements` 只看 ``elements``，拿到空列表 ⇒ 原 0 个 vs 拆回 8 个，
        **往返必然不等**，体检就把整部剧报成"格式无法解析"的硬伤。
    而这份稿子的导出、生成分镜全都正常 —— 纯误判。

    现在两侧共用本函数：序列化吐什么，比较就比什么。重建顺序固定为
    ``dialogue`` 在前、``action`` 在后（老数据没存两者交错的顺序，
    但**两侧用同一个顺序**，所以往返稳定）。
    """
    body: list[str] = []
    for key in ("dialogue", "action"):
        txt = scene.get(key)
        if not isinstance(txt, str):
            continue
        for ln in txt.split("\n"):
            ln = ln.strip()
            if ln:
                body.append(ln)
    if not body:
        return []
    scenes = parse_episode("\n".join(body))
    return scenes[0].get("elements") if scenes else []


def _scene_elements(scene: dict) -> list[dict]:
    """取一个场景的**有效元素列表** —— 序列化与往返比较共用这一个口径。

    ⚠️ 这个函数存在的唯一理由就是**两侧口径必须一致**。此前序列化侧有
    "没有 elements 就退回 action/dialogue 文本"的兜底，比较侧却没有，
    于是那批老数据的往返校验永远是假的（见 _elements_from_text 的注释）。
    """
    els = scene.get("elements")
    if isinstance(els, list) and els:
        return els
    return _elements_from_text(scene)


def _scene_no_for_text(scene: dict) -> str:
    """序列化时这一场该写什么场号。

    ⚠️ 2026-10-08 加。旧镜头表（扁平结构，只有 ``shot_no`` 没有 ``scene_no``，
    见草稿 21/23/27/28/30/31/51/11）每一格其实**各自是一场**。旧代码见
    ``scene_no`` 为空就不写 ``场:`` 行，于是连续多个 ``景:`` 全落进同一个场景，
    拆回时 31 场塌成 1 场 —— 体检报"硬伤"，而那批稿子只是**用的旧格式**。

    ``stages/export_text.py`` 早就有同款兜底（``shot.get("scene_no") or shot.get("shot_no")``），
    本模块的 docstring 也自称"对齐导出 Word 可见文本"，所以这里向它看齐：
    **没有场号时用 shot_no 顶上**，只在"既无 elements 又无场号"的老结构上生效。
    """
    sn = str(scene.get("scene_no") or "").strip()
    if sn:
        return sn
    if (scene.get("elements") or []):
        return ""
    shot_no = scene.get("shot_no")
    return str(shot_no).strip() if shot_no not in (None, "") else ""


def _one_line(text: str) -> str:
    """把内容里的换行/连续空白压成单个空格 —— 保证一个元素**只占一行**。

    ⚠️ 2026-10-08 修。模型偶尔往一个 action 或台词里塞换行，例如
    ``△面板文字滚动：【世界回收进度：100%】\\n【正在剥离宿主意识…】``。
    序列化是逐行吐的，这一行会被 `parse_episode` 拆成**两个** action 元素：
    原文 1 个 vs 拆回 2 个 —— 往返判定不等，体检报"硬伤"（全库实测 249/44）。
    而这份稿子导出、生成分镜全都没问题，纯属**误判**。

    本项目的行格式里没有"续行"标记（见模块头部的格式锚点表），
    所以这里在**序列化与比较两侧同时**把换行压平：
    写出去的是一行，比的时候也按一行比，两侧一致。
    """
    return _WS_RUN_RE.sub(" ", (text or "").replace("　", " ")).strip()


def _clean_triangle(text: str) -> str:
    """把动作 content 前导的一个或多个 △ 规范成单个 △。

    ⚠️ 2026-10-08 修。旧实现是 ``re.sub(r"^[△]+\\s*", "", t)`` —— 它**只吃连着的**
    △，遇到 ``△ △特写：…``（两个 △ 中间夹一个空格，模型偶尔这么吐）就只吃掉第一个，
    剥完剩 ``△特写：…``，再补一个 △ 变成 ``△△特写：…``。
    序列化写的是 ``△△…``，拆回时又被 `_clean_triangle` 规整成 ``△…`` ——
    两侧差一个 △，**往返永久不等**，体检就把这一集报成"硬伤"（全库实测 269/17）。
    说好的"规范成单个"没做到，这里改成把行首的 △ 与空白**一并**吃干净再补一个。
    """
    t = re.sub(r"^[\s△]+", "", text or "")
    return "△" + t


_OUTER_PAREN_RE = re.compile(r"^[（(]\s*(.*?)\s*[）)]$", re.DOTALL)


def _strip_outer_parens(text: str) -> str:
    """剥掉表演提示外层多余的括号。

    ⚠️ 2026-10-08 加。根因见 _dialogue_meta 的注释：模型产出的 ``action``
    有时**自带括号**（``（电话里，声音紧绷）``），而拼接时又加了一层，
    于是序列化出 ``池煜(（电话里，声音紧绷）): 是我。`` ——
    ``_RE_DIALOGUE`` 的括号组 ``[^)）]*`` 匹配不进内层的全角右括号，
    整行匹配失败被当动作行，**台词变成动作**，往返校验随即报错。

    这里以及 `_norm_elements` 都调用它：序列化侧剥一层 ⇒ 输出不再套双括号；
    比较侧也剥一层 ⇒ 存量的"自带括号"数据与拆回结果仍被判定为等价
    （否则改完序列化后，老数据反而会因为 action 差一对括号而永远等不上）。
    """
    t = (text or "").strip()
    m = _OUTER_PAREN_RE.match(t)
    return m.group(1).strip() if m else t


_RE_ACTION_MODE = re.compile(r"^[（(]?\s*(OS|VO)\s*[)）]?$", re.IGNORECASE)


def _canon_mode_action(mode: str, action: str) -> tuple[str, str]:
    """把 (mode, action) 归一成**唯一写法**：(OS/VO 或空, 表演提示 或空)。

    ⚠️ 2026-10-08 加。``OS``/``VO`` 到底存哪，历史上有三种写法：
      · ``mode='VO'``                —— 新数据、`_parse_dialogue_meta` 拆出来的写法；
      · ``action='VO'``              —— 生成链路有时只填了 action（草稿 118/15）；
      · ``character='手机录音(VO)'`` —— 写进名字里（见 _split_name_mode）。
    三种写法**序列化出去长得差不多**（都会拼成 ``(VO)``），但拆回来的永远是第一种，
    于是另外两种的往返校验永久失败。

    这里统一收敛到第一种：mode 字段**优先**，其次从 action 里认领，最后才是空。
    序列化与比较两侧共用，写出去的和比的时候就是同一个规范形态。
    """
    m = (mode or "").strip().strip('"').strip("“”").upper()
    m = m if m in ("OS", "VO") else ""
    a = _strip_outer_parens(action)
    if not m:
        am = _RE_ACTION_MODE.match(a)
        if am:
            return am.group(1).upper(), ""
    return m, (a.strip() if a.strip() else "")


def _dialogue_meta(mode: str, action: str) -> str:
    """把 mode(OS/VO) + action(表演提示) 拼成括号内容。普通对白不显示 mode。

    ⚠️ 传入的 ``action`` 必须先剥掉自带的外层括号再拼 —— 见 _strip_outer_parens。
    ⚠️ ``action`` 为纯空白时必须当作**没有**表演提示。此前只判 ``if a:``，
       而 ``a = " "`` 是非空串 → 拼出 ``角色( ): 台词``，拆回时
       ``_parse_dialogue_meta(" ")`` 得到 ``action=" "``（strip 过又是空）→
       两侧的 action 一个 ``" "`` 一个 ``""`` 对不上，**往返永久报错**。
       `_norm_elements` 也 strip，所以这里统一按 strip 后的结果判断。
    """
    parts: list[str] = []
    m, a = _canon_mode_action(mode, action)
    if m:
        parts.append(m)
    if a:
        parts.append(a)
    return f"({', '.join(parts)})" if parts else ""


def serialize_episode(shots: list[dict], *, ep: int, title: str = "") -> str:
    """把一集 shots_json 序列化为纯文本(对齐导出 Word 可见文本)。"""
    lines: list[str] = []
    lines.append(f"第{ep}集" + (f" {title}" if title else ""))
    for scene in (shots or []):
        if not isinstance(scene, dict):
            continue
        lines.append("")
        # ⚠️ 用 _scene_no_for_text 而不是直接读 scene_no：老镜头表没有场号，
        # 得拿 shot_no 顶上，否则多场会塌成一场（见该函数的注释）。
        scene_no = _scene_no_for_text(scene)
        if scene_no:
            lines.append(f"场:{scene_no}")
        time_loc = str(scene.get("time_loc") or scene.get("location") or "").strip()
        if time_loc:
            lines.append(f"景:{time_loc}")
        chars = scene.get("characters") or []
        if isinstance(chars, list) and chars:
            lines.append("人物:" + "、".join(str(c).strip() for c in chars if str(c).strip()))
        subtitle = str(scene.get("subtitle") or "").strip()
        if subtitle:
            # ⚠️ 字幕里的换行必须在**序列化侧**压平：字幕行是单行格式
            # ``(出字幕: …)``，内部留换行会被拆回成多行、后半截变成动作/台词
            # （实测草稿 328/33、393/50 就是这么坏的）。
            lines.append(f"(出字幕: {_one_line(subtitle)})")

        # ⚠️ 统一走 _scene_elements：没有 elements 的老场景会从 action/dialogue
        # 文本重建，与往返比较侧**共用同一个口径**（见该函数的注释）。
        # 旧代码是 `if elements: … else: 逐行吐 action/dialogue`，比较侧却只读
        # elements —— 那批老数据的往返校验因此永远是假的。
        for e in _scene_elements(scene):
            if not isinstance(e, dict):
                continue
            etype = e.get("type", "")
            if etype == "action":
                # ⚠️ 必须先 _one_line 再 _clean_triangle：content 里的换行会让
                # 这一行在拆回时裂成两个 action（见 _one_line 的注释）。
                c = _one_line(str(e.get("content") or ""))
                if c:
                    lines.append(_clean_triangle(c))
            elif etype == "dialogue":
                nm = _one_line(str(e.get("character") or ""))
                content = _one_line(str(e.get("content") or ""))
                meta = _dialogue_meta(e.get("mode", ""), e.get("action", ""))
                # 无名台词会序列化成 ``(提示): 台词``，被拆成动作行 —— 整条台词丢失。
                # 这种情况只可能来自脏数据（正常生成的人名都不会为空）；
                # 与其静默改写成动作，不如照原样吐出去让**往返校验如实报错**，
                # 让体检指出来，而不是把它藏起来。
                lines.append(f"{nm}{meta}: {content}")
            elif etype == "flashback_start":
                lines.append(_FLASHBACK_START)
            elif etype == "flashback_end":
                lines.append(_FLASHBACK_END)
    return "\n".join(lines)


# 括号内容开头的 OS/VO(后跟逗号或结束) 才算 mode; 其余全部作为 action(保留内部逗号)
_RE_META_MODE = re.compile(r"^(OS|VO)(?:\s*[,，]\s*(.*))?$", re.IGNORECASE | re.DOTALL)


def _parse_dialogue_meta(meta: str) -> tuple[str, str]:
    """括号内容 -> (mode, action)。

    仅当开头是 OS/VO(独立一段) 时剥离为 mode, 剩余整体作为 action(不再按逗号切分,
    以免表演提示内部的逗号被吞掉)。否则整个括号内容都是 action。
    """
    meta = (meta or "").strip()
    if not meta:
        return "", ""
    m = _RE_META_MODE.match(meta)
    if m:
        return m.group(1).upper(), (m.group(2) or "").strip()
    return "", meta


def _flush_scene(cur: dict | None, scenes: list[dict]) -> None:
    if cur is not None and (cur.get("elements") or cur.get("scene_no") or cur.get("time_loc")):
        scenes.append(cur)


def parse_episode(text: str) -> list[dict]:
    """把一集纯文本拆回 shots_json 结构(标准 scene 列表)。"""
    scenes: list[dict] = []
    cur: dict | None = None

    def _new_scene(scene_no: str = "") -> dict:
        return {
            "scene_no": scene_no,
            "time_loc": "",
            "characters": [],
            "subtitle": "",
            "is_flashback": False,
            "elements": [],
        }

    for raw in (text or "").split("\n"):
        line = raw.strip()
        if not line:
            continue
        if _RE_EP.match(line):
            continue
        m = _RE_SCENE.match(line)
        if m:
            _flush_scene(cur, scenes)
            cur = _new_scene(m.group(1).strip())
            continue
        if cur is None:
            cur = _new_scene()
        m = _RE_TIMELOC.match(line)
        if m:
            cur["time_loc"] = m.group(1).strip()
            continue
        m = _RE_CHARS.match(line)
        if m:
            cur["characters"] = [c.strip() for c in re.split(r"[、,，]", m.group(1)) if c.strip()]
            continue
        m = _RE_SUBTITLE.match(line)
        if m:
            cur["subtitle"] = m.group(1).strip()
            continue
        if line == _FLASHBACK_START:
            cur["elements"].append({"type": "flashback_start"})
            cur["is_flashback"] = True
            continue
        if line == _FLASHBACK_END:
            cur["elements"].append({"type": "flashback_end"})
            continue
        if line.startswith("△"):
            cur["elements"].append({"type": "action", "content": _clean_triangle(line)})
            continue
        dm = _RE_DIALOGUE.match(line)
        if dm:
            name = dm.group(1).strip()
            mode, action = _parse_dialogue_meta(dm.group(2) or "")
            content = dm.group(3).strip()
            cur["elements"].append({
                "type": "dialogue",
                "character": name,
                "mode": mode,
                "action": action,
                "content": content,
            })
            continue
        # 严格版失败 → 再试宽松兜底（角色名里带括号的情形）。见 _loose_dialogue。
        #
        # ⚠️ 放在这里（而不是替换严格版）是刻意的：已经能解析的行走原分支，
        # 字节级行为不变；只有原本会掉进"当动作行"的那些行才换一种解读。
        # 序列化出来的动作行永远带 △ 前缀，在上面就被拦下了，不会走到这。
        loose = _loose_dialogue(line)
        if loose:
            name, meta, content = loose
            mode, action = _parse_dialogue_meta(meta)
            cur["elements"].append({
                "type": "dialogue",
                "character": name,
                "mode": mode,
                "action": action,
                "content": content,
            })
            continue
        cur["elements"].append({"type": "action", "content": _clean_triangle(line)})

    _flush_scene(cur, scenes)

    for i, s in enumerate(scenes):
        _add_derived(s, i)
    return scenes


def _add_derived(scene: dict, idx: int) -> None:
    """补 shot_no / location / action / dialogue 派生字段(前端/导出兼容)。"""
    els = scene.get("elements") or []
    scene.setdefault("shot_no", idx + 1)
    scene["location"] = scene.get("time_loc", "")
    scene["action"] = "\n".join(
        (e.get("content", "") or "").strip()
        for e in els if e.get("type") == "action" and (e.get("content", "") or "").strip()
    )
    scene["dialogue"] = "\n".join(
        (
            (e.get("character", "") or "").strip()
            + _dialogue_meta(e.get("mode", ""), e.get("action", ""))
            + ": " + (e.get("content", "") or "").strip()
        )
        for e in els if e.get("type") == "dialogue" and (e.get("content", "") or "").strip()
    )


_RE_NAME_PAREN = re.compile(r"^(.*?)\s*[（(]\s*([^（()）]*)\s*[)）]\s*$")


def _split_name_mode(character: str, mode: str, action: str = "") -> tuple[str, str, str]:
    """把「名字里自带括号」的写法归一成 (干净名字, mode, action)。

    ⚠️ 2026-10-08 加。生成链路有时把括号内容**写进角色名**而不是 mode/action 字段：
      · ``character='手机录音(VO)'``      → 画外音标记，应归入 mode；
      · ``character='张姐（电话声）'``     → 表演提示，应归入 action。
    序列化出去都是 ``名字(括号): 台词``，而 `_RE_DIALOGUE` / 宽松兜底会把它拆成
    ``名字干净 + mode 或 action``。于是"存量：名字带括号、mode/action 全空"
    vs "拆回：名字干净、mode/action 有值"永远对不上，**往返永久报错**
    （实测草稿 269 共 113 集 + 651）。

    解析器读出来的那个结构才是对的，所以这里把**存量数据的比较口径**向它靠拢：
    只在 ``mode``/``action`` 本来就都为空时才从名字里摘，已经有值的一律不动。
    括号里是 OS/VO 就归 mode，其余归 action —— 与 `_parse_dialogue_meta` 同一口径。
    """
    nm = (character or "").strip()
    if (mode or "").strip() or (action or "").strip():
        return nm, mode, action
    m = _RE_NAME_PAREN.match(nm)
    if not m:
        return nm, mode, action
    head, inner = m.group(1).strip(), m.group(2).strip()
    if not head:
        return nm, mode, action
    md, act = _parse_dialogue_meta(inner)
    return head, md, act


def _norm_elements(shots: list[dict]) -> list[dict]:
    """抽取用于比较的规范结构(忽略 duration/notes/shot_no 等)。

    ⚠️ **每个字段都必须与 serialize_episode 用同一套归一函数**，否则比较侧与
    序列化侧的规范化程度不一致，往返会**永久报假错**。当前四处对齐：
      · action / dialogue.content  → `_one_line`（压平换行，见其注释）
      · action 元素 content        → `_clean_triangle`（行首 △ 归一）
      · dialogue.action            → `_strip_outer_parens`（剥离自带括号）
      · dialogue.character          → `_split_name_mode`（把名字里的 (VO) 摘成 mode）
    """
    out = []
    for s in (shots or []):
        if not isinstance(s, dict):
            continue
        els = []
        # ⚠️ 必须走 _scene_elements（与 serialize_episode 同一个口径）：
        # 没有 elements 的老场景会从 action/dialogue 重建，否则这里永远拿到空列表，
        # 往返必然不等（见 _elements_from_text 的注释）。
        for e in _scene_elements(s):
            if not isinstance(e, dict):
                continue
            t = e.get("type")
            if t == "action":
                els.append(("action",
                            _clean_triangle(_one_line(str(e.get("content") or ""))).strip()))
            elif t == "dialogue":
                # ⚠️ 与序列化侧的 _dialogue_meta 共用 _canon_mode_action：
                # OS/VO 存 mode 还是存 action 历史上写法不一，收敛到同一形态再比。
                mode, action = _canon_mode_action(
                    e.get("mode", ""),
                    _one_line(str(e.get("action") or "")),
                )
                nm, mode, action = _split_name_mode(
                    _one_line(str(e.get("character") or "")), mode, action)
                els.append((
                    "dialogue",
                    nm,
                    mode,
                    action,
                    _one_line(str(e.get("content") or "")),
                ))
            elif t in ("flashback_start", "flashback_end"):
                els.append((t,))
        out.append({
            # ⚠️ 必须与序列化侧同用 _scene_no_for_text：老镜头表靠 shot_no 顶场号，
            # 这里若直接读 scene_no 就永远是 ""，而拆回的是 "1" —— 又一处假不等。
            "scene_no": _scene_no_for_text(s),
            "time_loc": str(s.get("time_loc") or s.get("location") or "").strip(),
            "characters": [str(c).strip() for c in (s.get("characters") or []) if str(c).strip()],
            # 与序列化侧同用 _one_line：字幕里的换行在序列化时被压平了。
            "subtitle": _one_line(str(s.get("subtitle") or "")),
            "elements": els,
        })
    return out


def roundtrip_equivalent(shots: list[dict], *, ep: int = 1) -> tuple[bool, str]:
    """校验 shots -> serialize -> parse 是否结构等价。返回 (是否等价, 差异说明)。"""
    text = serialize_episode(shots, ep=ep)
    parsed = parse_episode(text)
    a = _norm_elements(shots)
    b = _norm_elements(parsed)
    if len(a) != len(b):
        return False, f"场数不一致: 原 {len(a)} vs 拆回 {len(b)}"
    for i, (sa, sb) in enumerate(zip(a, b)):
        if sa != sb:
            return False, f"第{i+1}场不一致:\n  原: {sa}\n  拆回: {sb}"
    return True, "ok"


def serialize_full(episodes: list[tuple[int, str, list[dict]]]) -> str:
    """整本序列化。episodes: [(ep, title, shots), ...] 按集号排序。"""
    blocks = []
    for ep, title, shots in sorted(episodes, key=lambda x: x[0]):
        blocks.append(serialize_episode(shots, ep=ep, title=title))
    return "\n\n".join(blocks)