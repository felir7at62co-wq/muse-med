"""episode_render — 集纲字段 → prompt 文本的**唯一**渲染器。

## 为什么要有这个模块（2026-10-09）

原先"把集纲字段渲染成人话"这件事被写了两遍，而且两遍不一致：

| 路径 | 拿到的集纲信息 |
|---|---|
| 正文 `chapter_gen.generate_chapter` | 契约块（core_push/stakes/hook/plant/payoff/forbidden） |
| 剧本 `storyboard_gen.generate_storyboard_from_outline` | **只有 synopsis 一句话** |

`storyboard_gen.py` 里 grep `core_push|stakes|plant|payoff|escalation|value_shift|`
`hook_out|must_have|forbidden` 命中数是 **0** —— 那条路的函数签名里根本没有传参的口子。
于是剧本步骤拿 100 字梗概去写 5000 字成片：

    dev 实测扩写倍率：草稿 261 = 55:1，652 = 56:1，653 = 46:1

50 倍不是"扩写"，是**从零写**。用户反馈的"模型经常自己编大纲里没有的内容"
就是这个倍率的直接后果 —— 而同期草稿 617/616/590 的每一集都**有**完整契约，
只是剧本路径把它们全丢了。所以问题不在大纲写得薄，在于**信息生成出来后被扔掉了**。

本模块把渲染收到一处，两条路共用，从结构上杜绝再次漂移。

## 内容
- `_s`            任意取值 → 可安全拼接的字符串（集纲是人手填的，同字段类型会飘）
- `format_characters`  人物表（含 goal/obstacle/arc —— 原先被静默丢弃）
- `format_must_have`   必备情节点（**不再**输出"按概要发挥即可"）
- `build_contract_block`  本集戏剧契约
- `build_beats_block`     本集场景节拍
- `build_neighbor_originals`  上下集**原文**

## 与 `chapter_gen` 的关系
原先 `_s` / `_format_characters` / `_format_must_have` / `_build_contract_block`
定义在 `chapter_gen.py`，现移到此处并在那边保留同名别名（`dev_ab_deai.py` 等
按引用替换模块属性的代码依赖这一点）。**不要**在 chapter_gen 里重新定义一份。
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 取值收敛
# ---------------------------------------------------------------------------

def _s(value) -> str:
    """把集纲里的任意取值收敛成一个可安全拼接的字符串。

    集纲字段是人手填的、也是模型重写的，同一个字段这一集是字符串、下一集可能就是列表
    （"value_shift.from": ["被动挨打", "失去母亲"]）。列表按 `、` 拼成人话，
    而不是把 `['被动挨打', '失去母亲']` 原样写进 prompt 里给模型看。
    """
    if value is None:
        return ""
    if isinstance(value, (list, tuple, set)):
        return "、".join(str(x).strip() for x in value if str(x or "").strip())
    if isinstance(value, dict):
        return "、".join(f"{k}:{_s(v)}" for k, v in value.items() if _s(v))
    return str(value).strip()


# ---------------------------------------------------------------------------
# 人物表
# ---------------------------------------------------------------------------

def format_characters(characters: list[dict]) -> str:
    """人物表。

    ⚠️ 2026-10-09：补上 goal / obstacle / arc / ending_state。
    原先只渲染 name/role/traits/appearance 四个键，而大纲 prompt 里
    **明确要求模型产出** goal/obstacle/arc —— 也就是说模型老老实实写了，
    渲染时被丢掉，模型再也看不见。这是纯浪费：信息已经生成过了。

    这些键在旧数据里不存在时自然为空、不占行，所以对老草稿零影响。
    """
    if not characters:
        return "（无）"
    lines = []
    for c in characters:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name", "") or "").strip()
        if not name:
            continue
        role = _s(c.get("role"))
        traits = _s(c.get("traits"))
        appearance = _s(c.get("appearance"))
        seg = f"- {name}"
        if role:
            seg += f"（{role}）"
        if traits:
            seg += f"：性格 [{traits}]"
        if appearance:
            seg += f"；外貌 {appearance}"
        # 目标 / 阻碍 / 弧光：能拍到的东西，比性格标签更能约束台词与行动
        goal = _s(c.get("goal"))
        obstacle = _s(c.get("obstacle"))
        arc = _s(c.get("arc"))
        ending = _s(c.get("ending_state"))
        extra: list[str] = []
        if goal:
            extra.append(f"本剧想要：{goal}")
        if obstacle:
            extra.append(f"阻碍：{obstacle}")
        if arc:
            extra.append(f"变化弧线：{arc}")
        if ending:
            extra.append(f"结局：{ending}")
        if extra:
            seg += "\n    - " + "；".join(extra)
        lines.append(seg)
    return "\n".join(lines) or "（无）"


def format_world_rules(rules: list[str]) -> str:
    if not rules:
        return ""
    lines = ["- 世界观规则："]
    for r in rules:
        lines.append(f"  * {r}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 必备情节点
# ---------------------------------------------------------------------------

def format_must_have(items: list[str], outline: dict | None = None,
                     order: int = 0) -> str:
    """本集必备情节点。

    ## 🔴 2026-10-09：删掉了"按概要发挥即可"

    旧实现在 `must_have` 为空时输出：

        （无明确要求，按概要发挥即可）

    这是一句**字面上的许可，让模型自己编**。而它在真实数据上命中率极高 ——
    草稿 580 是 50 集里 50 集全空；导入路径（`import_outline.py`）建构出的
    `{order, title, synopsis, must_have: [], characters: []}` 本身就带空数组。
    于是"模型编大纲里没有的内容"这件事，是先被 prompt 邀请、再被数据放大的。

    改为：没有 must_have 时，指向同集**已经存在的其他约束**（契约 / 节拍 / 概要），
    并明确"不许自行添加新事件"。有约束可依时就不再是自由发挥，没有约束时才如实说。

    `outline` / `order` 两个入参是可选的：不传（老调用方）时退回一句中性说明，
    不再输出"发挥即可"。
    """
    if items:
        return "\n".join(f"  * {_s(x)}" for x in items if _s(x))
    if outline and order:
        ch = next((c for c in (outline.get("chapters") or [])
                   if int(c.get("order") or 0) == int(order)), None)
        if isinstance(ch, dict) and _has_any_constraint(ch):
            return ("  （本集未单独列出必备情节点 —— **以上方「本集戏剧契约」与"
                    "「本集场景节拍」为准展开**，不要因为这里为空就自行添加新事件、"
                    "新人物或新支线。）")
    return ("  （本集无额外必备情节点。以「本集概要」为剧情边界展开，"
            "不得自行添加概要之外的新人物、新支线或新反转。）")


#: 判定一集"到底有没有可依的约束"。与 settings_backfill._CONTRACT_KEYS 同源语义，
#: 但**故意不复用那个常量**：那个是"反推时哪些键算已填"的口径，这里是
#: "渲染时哪些键能当约束用"。两者将来会各自演化（例如 beats 只在这里算数）。
_CONSTRAINT_KEYS = ("core_push", "stakes", "escalation", "value_shift",
                    "hook_out", "plant", "payoff", "forbidden", "beats")


def _has_any_constraint(ch: dict) -> bool:
    for k in _CONSTRAINT_KEYS:
        v = ch.get(k)
        if isinstance(v, (list, dict)):
            if v:
                return True
        elif str(v or "").strip():
            return True
    return False


# ---------------------------------------------------------------------------
# 戏剧契约
# ---------------------------------------------------------------------------

def build_contract_block(outline: dict, chapter_order: int) -> str:
    """本集的戏剧契约——本集生成必须兑现的那几件事。

    契约由大纲生成时产出（value_shift / stakes / hook / escalation / plant / payoff /
    forbidden）。老数据没有这些字段时返回空串，prompt 里不出现该段。

    ⚠️ 2026-10-09：本函数原先私有在 `chapter_gen.py`，只有**正文**路径用得上；
    剧本路径因为函数签名里没有传参口子，整套契约被丢弃。现移入本模块，
    两条路径共用（`chapter_gen` 保留同名别名）。
    """
    ch = next((c for c in (outline.get("chapters") or [])
               if int(c.get("order") or 0) == int(chapter_order)), None)
    if not isinstance(ch, dict):
        return ""
    lines: list[str] = []

    def _add(label: str, value: str) -> None:
        v = _s(value)
        if v:
            lines.append(f"- {label}：{v}")

    _add("本集唯一核心推进点", ch.get("core_push"))
    # ---- 2026-11-04：集纲标签（爽点 / 对手动作 / 兑现的卖点）----
    # 案例稿逐集写【爽点】【互动】【冲突】；我们此前没有"这一集爽在哪"这一层，
    # 正文只能按 synopsis 平铺直叙，爽点靠运气。
    _add("本集必须兑现的爽点（这一下必须写出来，是本集值回票价的地方）", ch.get("payoff_moment"))
    _add("爽点类型（与相邻集不要重复）", ch.get("payoff_kind"))
    _add("本集对手做了什么（主角的反击要有对手可打）", ch.get("opponent_move"))
    _add("本集兑现的卖点", ch.get("selling_point"))
    vs = ch.get("value_shift") or {}
    if isinstance(vs, dict) and _s(vs.get("from")) and _s(vs.get("to")):
        # ⚠️ 取值一律走 _s()：集纲是人（或模型）填的，`value_shift.from` 里偶尔是
        # **列表**（例："从[被动挨打, 失去母亲]变为主动出击"）。直接 .strip() 会抛
        # `'list' object has no attribute 'strip'`，整部剧的生成当场失败，
        # 而报错信息里连是哪一集、哪个字段都看不出来。
        # 生产实测踩过两次（作业 #1 gen_chapters、#2 gen_storyboards，同一部草稿 1879）。
        _add("价值转变", f"从「{_s(vs['from'])}」变为「{_s(vs['to'])}」")
    _add("失败代价（必须让观众在前 30% 内清楚）", ch.get("stakes"))
    _add("本集比上一集更难在哪", ch.get("escalation"))
    hi = ch.get("hook_in") or {}
    if isinstance(hi, dict) and _s(hi.get("responds_to")):
        _add("开场须回应的上一集卡点", hi.get("responds_to"))
    ho = ch.get("hook_out") or {}
    if isinstance(ho, dict) and _s(ho.get("type")):
        seg = f"类型 {_s(ho['type'])}"
        if _s(ho.get("strength")):
            seg += f"、强度 {_s(ho['strength'])}"
        if _s(ho.get("leads_to")):
            seg += f"；必须引发下一集：{_s(ho['leads_to'])}"
        _add("结尾卡点", seg)
    if ch.get("plant"):
        _add("本集须埋下的伏笔", "；".join(_s(x) for x in ch["plant"] if _s(x)))
    if ch.get("payoff"):
        _add("本集须回收的伏笔", "；".join(_s(x) for x in ch["payoff"] if _s(x)))
    if ch.get("forbidden"):
        _add("本集边界（这一集里不发生的事）", "；".join(_s(x) for x in ch["forbidden"] if _s(x)))
    # 权力关系：决定台词给谁说什么（同意的内容由进攻方说还是防守方说，效果完全不同）
    pw = ch.get("power") or {}
    if isinstance(pw, dict) and _s(pw.get("focus")):
        seg = ""
        if _s(pw.get("aggressor")):
            seg += f"主动推进/施压：{_s(pw['aggressor'])}"
        if _s(pw.get("defender")):
            seg += ("；" if seg else "") + f"回应/退让/抵抗：{_s(pw['defender'])}"
        seg += ("；" if seg else "") + f"争的是：{_s(pw['focus'])}"
        _add("本集权力关系（决定台词给谁说什么）", seg)

    if not lines:
        return ""
    return ("【本集戏剧契约（必须兑现，与下方写作要求同等效力）】\n"
            + "\n".join(lines))


# ---------------------------------------------------------------------------
# 场景节拍（beats）
# ---------------------------------------------------------------------------

def build_beats_block(outline: dict, chapter_order: int) -> str:
    """本集**场景节拍** —— 从"一句话概要"到"可演的一串拍子"。

    ## 为什么需要它

    影视工业的标准管线是三级递进的细节：

        beat sheet（~2 页电报式拍子） → outline（同一批拍子扩成散文场景） → script

    beat sheet 里只有**情节点**，例如"—Max 和 Dave 露了馅，说漏了 Penny 的生日
    被诅咒了 / —Penny 否认，然后灯灭了"。outline 再把**同一批拍子**扩写成带
    场次标题、人物态度和语气的完整散文。

    我们此前只有"一句话梗概"，等于**跳过了中间那级**，直接要求模型从一句
    概要写到 5000 字成片 —— 中间整整一层"演什么"的决策是空着的，模型只能自己补。
    这正是"模型经常自编大纲里没有的内容"的机制性来源。

    ## 一条 beat 长什么样

    每条必须带**地点/时间**、**在场人物**、**发生了什么（动作）**、**这一拍结束时
    局面变成了什么（转折）**。四样缺一不可 —— 缺地点模型会换景，缺人物会拉错人
    进场，缺动作会写成议论，缺转折会原地踏步。

    ⚠️ 刻意**不设条数上限**（2026-10-09 用户裁定："1~2 万字的成本差异都很少"）。
    集纲是纯文本、token 量级安全；而上限会逼模型把该分两拍的事压成一拍，
    那正是我们想消灭的"信息量不足"。

    ## 与 synopsis 的分工
    `synopsis` 回答"这一集讲了什么"（给人和检索看）；
    `beats` 回答"这一集按顺序演哪几拍"（给生成看）。两者都要有，不是替代关系。

    ## ⚠️ 过期节拍必须让位（`_beats_stale`）

    节拍一旦成为生成的依据，就出现一个新的**危险组合**：用户手改了 `synopsis`，
    而 `beats` 还描述着改之前的那一集。此时两段同时在 prompt 里，模型会照着
    **更具体的节拍**写 —— 也就是**无视用户的修改**。这比没有节拍更糟。

    所以凡是"改了梗概但没重算节拍"的写回路径，都会打上 `_beats_stale`；
    本函数见到该标记就**主动弃用节拍**并说明原因，让梗概重新说了算。
    """
    ch = next((c for c in (outline.get("chapters") or [])
               if int(c.get("order") or 0) == int(chapter_order)), None)
    if not isinstance(ch, dict):
        return ""
    if ch.get("_beats_stale"):
        return ("（本集梗概已被修改，原有的场景节拍与之不一致，故**已停用**。"
                "请严格按上方的「本集梗概」与「本集戏剧契约」来写；"
                "想要恢复逐拍依据，用「重新生成此集」重做本集大纲。）")
    beats = ch.get("beats")
    if not isinstance(beats, list) or not beats:
        return ""

    rows: list[str] = []
    for i, b in enumerate(beats, start=1):
        if isinstance(b, str):
            # 兼容模型直接给一串字符串（"她推门进去，看见……"）
            if b.strip():
                rows.append(f"{i}. {b.strip()}")
            continue
        if not isinstance(b, dict):
            continue
        at = _s(b.get("at")) or _s(b.get("where")) or _s(b.get("location"))
        who = _s(b.get("who")) or _s(b.get("characters"))
        act = _s(b.get("action")) or _s(b.get("what")) or _s(b.get("beat"))
        turn = _s(b.get("turn")) or _s(b.get("result")) or _s(b.get("shift"))
        if not (at or who or act or turn):
            continue
        head = f"{i}. "
        if at:
            head += f"{at}"
        if who:
            head += ("｜" if at else "") + f"在场：{who}"
        seg = head
        if act:
            seg += f"\n   动作：{act}"
        if turn:
            seg += f"\n   转折：{turn}"
        rows.append(seg)

    if not rows:
        return ""
    return (
        "【本集场景节拍（按顺序落地，一条一拍 —— 这是"
        "「演什么」的清单，不是「写什么」的摘要）】\n"
        + "\n".join(rows)
        + "\n\n"
        # 2026-10-28：原先这里挂着三条"⚠️ 不得……"，与原则块「单集写法」第一、三条重复。
        # 现只保留节拍块自己的用法说明，约束统一由原则块给出（见 drama_principles）。
        "按顺序把每一拍演出来：有交锋、有台词、有画面；每一拍演到「转折」写明的局面为止。"
    )


# ---------------------------------------------------------------------------
# 上下集原文
# ---------------------------------------------------------------------------

#: 单侧邻集原文注入上限（字符）。不设时会把整部剧拖进 prompt。
#: 用户裁定（2026-10-09）："应该直接使用上下集的原文而非梗概"；
#: "1~2 万字的成本差异都很少" —— 所以这个值给得很宽。
_NEIGHBOR_MAX_CHARS = 20_000

#: 某一集两侧合起来的上限。
_NEIGHBOR_TOTAL_CHARS = 40_000


def _clip_neighbor(text: str, keep_tail: bool) -> str:
    """邻集原文超长时截到上限。

    上一集留**尾**（离本集最近，衔接价值最高）；下一集留**头**（本集要往它那里去）。
    截断处显式标注，不用省略号糊过去 —— 让模型知道这里断了。
    """
    t = (text or "").strip()
    if len(t) <= _NEIGHBOR_MAX_CHARS:
        return t
    if keep_tail:
        return "…（前文略）\n" + t[-_NEIGHBOR_MAX_CHARS:]
    return t[:_NEIGHBOR_MAX_CHARS] + "\n…（后文略）"


def render_neighbor_originals(neighbors: dict,
                              limit: int = _NEIGHBOR_TOTAL_CHARS) -> str:
    """把"上一集/下一集**原文**"渲染成 prompt 块。

    ## 为什么是原文不是梗概（用户已定结论，本处只是落实）

    2026-10-05 已发现过一次同类问题：只喂上一集**梗概**时，模型看不见上一集
    实际写了什么，而每集梗概的核心冲突往往正是承接上一集断点的那句对话 →
    模型只能把同一场戏从头再演一遍（换命 ep1/ep2、此刻 ep4/ep5 即此）。
    当时的处置是**另外**加一路 `prev_text`（上一集实际剧本），但 `context` 里
    那两行「上一集梗概 / 下一集梗概」**没有删**，于是同一条信息以两个口径同时
    在 prompt 里 —— 一个精确、一个模糊，模型按哪个写是不确定的。

    现在统一：**原文优先，原文没有才退回梗概**，且两者不会同时出现。

    `neighbors` 形如 `{"prev": text|None, "next": text|None}`；
    值为 None/空 时该侧不出现。**两侧都没有时返回空串**（宁少勿假，
    不编、也不退回"（无）"占位）。

    ⚠️ 本函数**不做任何 IO**：取原文是实现细节，由调用方按各路径的可用源
    分档取好再传进来（见 `collect_neighbor_originals`）。
    """
    blocks: list[str] = []
    total = 0
    for key, label, tail in (("prev", "上一集", True), ("next", "下一集", False)):
        raw = (neighbors or {}).get(key)
        t = _clip_neighbor(raw, keep_tail=tail) if raw else ""
        if not t:
            continue
        room = limit - total
        if room <= 0:
            break
        t = t[:room]
        total += len(t)
        blocks.append(f"### {label}已演过的内容（原文）\n{t}")
    if not blocks:
        return ""
    return ("【相邻集原文（衔接依据）】\n"
            "以下是本集前后两集**已经写好的原文**：本集从上一集的**结果**接起，"
            "收在通往下一集的那一拍上。\n\n"
            + "\n\n".join(blocks))


async def collect_neighbor_originals(*, draft_id: int, order: int,
                                     outline: dict,
                                     uploaded: dict[int, str] | None = None,
                                     known: dict[int, str] | None = None) -> dict:
    """取上/下集的**原文**，按可信度分档，取到就用、取不到就 None。

    ## 分档（高 → 低）
    1. `uploaded` —— 本次批量内存里刚生成、可能还没落库的成品（最新）
    2. `known`    —— 调用方手上已有的文本（如 batch_gen 循环里已经取好的上一集剧本）
    3. 数据库     —— 正文 `script_chapters` 优先，其次剧本 `script_storyboards`

    ⚠️ 正文优先于剧本：同一集两样都有时，正文是更权威的"已演内容"，
    而剧本是它的转换产物。

    ⚠️ **只在需要的那两集上查库**，不做全表扫描；批量循环里逐集调用是安全的。

    ⚠️ 与"梗概兜底"的关系：本函数**只回原文，不回梗概**。梗概兜底由调用方
    在拿到空值后自行决定（`build_neighbor_originals` 的 `fallback` 参数），
    这样"原文"与"梗概"两个口径在 prompt 里不会同时出现。
    """
    uploaded = uploaded or {}
    known = known or {}
    out: dict[str, str | None] = {"prev": None, "next": None}

    for key, n in (("prev", order - 1), ("next", order + 1)):
        if n < 1:
            continue
        for src in (uploaded, known):
            t = (src.get(n) or "").strip()
            if t:
                out[key] = t
                break
        if out[key]:
            continue
        # 数据库兜底 —— 只查这一集
        try:
            from sqlalchemy import select
            from ..db import ScriptChapter, ScriptStoryboard, session_scope
            async with session_scope() as s:
                ch = (await s.execute(
                    select(ScriptChapter).where(
                        ScriptChapter.draft_id == draft_id,
                        ScriptChapter.chapter_order == n))).scalar_one_or_none()
                t = (ch.full_text or "").strip() if ch else ""
                if not t:
                    sb = (await s.execute(
                        select(ScriptStoryboard).where(
                            ScriptStoryboard.draft_id == draft_id,
                            ScriptStoryboard.chapter_order == n))).scalar_one_or_none()
                    shots = (sb.shots_json or []) if sb else []
                    if isinstance(shots, list) and shots:
                        from ..critique.rules import storyboard_to_text
                        t = (storyboard_to_text(shots) or "").strip()
                if t:
                    out[key] = t
        except Exception as e:  # noqa: BLE001
            logger.warning("取第%d集邻集原文失败(仅影响衔接上下文): %s", n, e)
    return out


def _synopsis_fallback(outline: dict, order: int) -> str:
    """邻集原文拿不到时的**唯一**兜底：该集大纲梗概。取不到返回空串。"""
    ch = next((c for c in (outline.get("chapters") or [])
               if int(c.get("order") or 0) == int(order)), None)
    if isinstance(ch, dict):
        return _s(ch.get("synopsis"))
    return ""


async def build_neighbor_block(*, draft_id: int, order: int, outline: dict,
                               uploaded: dict[int, str] | None = None,
                               known: dict[int, str] | None = None,
                               allow_synopsis_fallback: bool = True) -> str:
    """一步到位：取邻集原文（必要时退回梗概）并渲染成 prompt 块。"""
    got = await collect_neighbor_originals(
        draft_id=draft_id, order=order, outline=outline,
        uploaded=uploaded, known=known)
    if allow_synopsis_fallback:
        for key, n in (("prev", order - 1), ("next", order + 1)):
            if not got.get(key) and n >= 1:
                fb = _synopsis_fallback(outline, n)
                if fb:
                    got[key] = fb
    return render_neighbor_originals(got, order=order)


__all__ = [
    "_s", "format_characters", "format_world_rules", "format_must_have",
    "build_contract_block", "build_beats_block",
    "render_neighbor_originals", "collect_neighbor_originals",
    "build_neighbor_block",
]
