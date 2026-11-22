"""用户分集规划的解析 —— 把「第 1 - 5 集【入局与积怨】：…」这类区间规划
从 `user_input` 里抽成结构，供大纲生成注入"本批只能取材于本区间"的硬约束。

## 为什么需要它（2026-10-10 定位的事故）

用户甲在新建草稿里输入了完整的分集规划：

    第 1 - 5 集【……】：（前几集的规划）
    第 6 - 15 集【……】：（后面才出现的关键爆点）

生成出来的大纲，第 1 集就把第 6-15 集的爆点（POS 机报"请输入 6 位支付密码"）
演完了，第 2~7 集才倒回去补过程。她的原话是"后几集才应该出现的剧情在剧情的前端
就出现了"，并说"通过对话生成的大纲就没有这种偏离的问题"。

定位结论是三层叠加，本模块治的是第二层：

  ① 模型把 `user_input` 当**题材和概要**读，不当**结构约束**读 ——
     它在 prompt 里的位置是「## 用户要求」，与「## 输出格式」并列；
  ② **全文没有任何代码解析「第 N-M 集」这种区间语义。** ← 本模块
     （`parse_focus_orders` 只服务对话检索，大纲生成完全没碰过它。）
  ③ 注入的集纲原则块在**反向推**："禁止慢热铺垫"、"第 1 集必须让观众明确
     最大异常/危机"，读起来就是"把最猛的往前放"。

## 兼容性（最重要的一条）

认不出任何区间 → 返回 `[]`，调用方据此**不注入任何东西**，prompt 与改前逐字节一致。
这是本项目既有的兼容手法，见 `import_outline.parse_structured_fields`：
"认不出任何栏时返回 {}，此处原样跳过，行为与改前**完全一致**"。

所以本模块**新增能力，但不改变任何既有行为**：只有当真写了分集规划的草稿才会
吃到新约束，绝大多数历史草稿（散文式概要、单段题材描述）走原路径。

## 为什么用行首匹配

规划里同时存在这两种行：

    第 31 - 35 集【反派报复与抢单】：   ← 是区间定义，要认
    第二幕：抢高端农产品单…（第 31 - 45 集）  ← 是幕标题，括号里的区间是**指代**不是定义

只认**行首**（允许前导 `【` 与 `第`）就能把后者排除掉，不必额外规则。
另外强制要求 `集/话/回` 后缀，"5000 份礼盒""24 小时""2016 - 2020 年"这类
带数字的正文行就不会被误判。
"""
from __future__ import annotations

import re

from .import_outline import cn_to_int

#: 单个标签最长多少字符。超过这个长度的括号内容不是"区间标签"。
_LABEL_MAX = 40

#: 最多认多少段。防病态输入（有人把整部剧的每一集都列一遍）。
_MAX_SEGMENTS = 40

#: 数字：阿拉伯或中文数字
_NUM = r"[0-9]+|[零〇一二两三四五六七八九十百千]+"
#: 区间分隔符：- — – ~ ～ 到 至
_SEP = r"(?:-|—|–|~|～|到|至)"

#: 区间定义行：行首，允许前导 `【`，允许 `第`，区间后必须有 集/话/回 后缀。
_HEAD = re.compile(
    rf"^\s*(?:【\s*)?第?\s*({_NUM})\s*{_SEP}\s*({_NUM})\s*(?:集|话|回)\s*】?\s*"
)

#: 紧跟在区间之后的标签：【入局与积怨】 / （带极品亲戚蹭聚餐，刷卡死锁）
_LABEL = re.compile(r"^\s*[【（(]([^】）)]{1," + str(_LABEL_MAX) + r"})[】）)]\s*")


def _to_int(token: str) -> int | None:
    """阿拉伯或中文数字串 → int。失败返回 None。"""
    token = (token or "").strip()
    if not token:
        return None
    if token.isdigit():
        return int(token)
    return cn_to_int(token)


def _clean(s: str) -> str:
    """标签/正文压成一行，去掉多余空白。"""
    return re.sub(r"\s+", " ", (s or "")).strip()


def parse_episode_plan(user_input: str) -> list[dict]:
    """解析用户输入里的分集规划。

    返回 `[{"start":1,"end":5,"label":"入局与积怨","body":"…"}, …]`。

    ⚠️ 返回 `[]` 是**正常结果**，不是错误 —— 调用方必须据此完全不注入约束。
    认不出来就什么都不做，这是本模块与调用方之间的契约。
    """
    text = (user_input or "").replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        return []

    segs: list[dict] = []
    cur: dict | None = None

    for raw in text.split("\n"):
        m = _HEAD.match(raw)
        if not m:
            # 不是区间定义行：续到当前段的正文里；还没有当前段就忽略（前导说明）
            if cur is not None:
                cur["_lines"].append(raw)
            continue

        a, b = _to_int(m.group(1)), _to_int(m.group(2))
        if a is None or b is None:
            # 形状像区间但读不出数字（例如"第一百零几集"）→ 当成普通正文行
            if cur is not None:
                cur["_lines"].append(raw)
            continue

        start, end = (a, b) if a <= b else (b, a)
        rest = raw[m.end():]

        label = ""
        lm = _LABEL.match(rest)
        if lm:
            label = lm.group(1)
            rest = rest[lm.end():]
        rest = rest.lstrip("：: 　\t")

        cur = {
            "start": start,
            "end": end,
            "label": _clean(label),
            "_lines": [rest] if rest else [],
        }
        segs.append(cur)

    if not segs:
        return []

    # 只认出一段、且**不是从第 1 集起**的 —— 多半是正文里偶然提到的一个区间，
    # 不是分集规划。宁可不注入，也不要注入一条错的边界。
    if len(segs) == 1 and segs[0]["start"] != 1:
        return []

    for s in segs:
        s["body"] = _clean("\n".join(s.pop("_lines")))
    return segs[:_MAX_SEGMENTS]


def _range_text(s: dict) -> str:
    if s["start"] == s["end"]:
        return f"第 {s['start']} 集"
    return f"第 {s['start']}-{s['end']} 集"


def render_plan_block(segments: list[dict], *, start: int, end: int) -> str:
    """把规划渲染成注入大纲 prompt 的约束块。

    `start` / `end` 是本批要生成的集号区间。没有规划时返回空串。

    ⚠️ 两种边界情况必须分别处理，否则会**造出比原 bug 更糟的后果**：

      · 本批落在规划覆盖**之外**（用户只规划了 1-32 集，却在生成第 33-61 集）——
        若无脑写"严禁取材于 ⛔ 区间"，模型在本批没有任何合法素材，会拒写或乱写。
        故此时改为"不做区间限制，但不得回退重演已过区间"。
      · 本批**横跨**多个区间（例如第 1-10 集同时覆盖 1-5 与 6-15）——
        此时两个区间都是 ✅，属正常，不必特殊处理。
    """
    if not segments:
        return ""

    rows: list[str] = []
    covered: list[dict] = []
    for s in segments:
        if s["end"] < start:
            state = "⏳ 已经演过（本批不得重演）"
        elif s["start"] > end:
            state = "⛔ 后续区间（本批不得提前揭示）"
        else:
            state = "✅ 本批可取材"
            covered.append(s)
        label = f"【{s['label']}】" if s["label"] else ""
        rows.append(f"  · {_range_text(s)}{label} —— {state}")

    head = (
        "## ⚠️ 本批取数边界（硬约束，**优先于本文其它一切关于"
        '"尽快揭示危机""尽快抓人"的描述**）\n\n'
        f"用户已经给出了明确的分集规划。本批要生成的是第 {start}~{end} 集。\n\n"
        + "\n".join(rows)
        + "\n"
    )

    if not covered:
        # 本批不在用户规划的覆盖范围内
        tail = (
            "\n**本批（第 "
            f"{start}~{end} 集）落在用户规划的覆盖范围之外**，"
            "因此上面标 ⛔ 的区间**对本批不构成取材限制** —— 本批可以自由展开，"
            "但必须遵守以下两条：\n"
            "1. **不得回退重演**上面标 ⏳ 的区间里已经演过的事件（那是「重演」，"
            "不是新剧情）。\n"
            "2. 不得把用户规划里**已经写明属于后面某段**的重大事件提前到本批。\n"
        )
        return head + tail

    tail = (
        "\n**硬性要求：**\n"
        "1. 本批只生成第 "
        f"{start}~{end} 集；上面标 ✅ 的区间，才是本批可以取材的范围。\n"
        "2. **严禁把标 ⛔ 的后续区间里的核心事件、转折、爆点、关键道具、关键台词"
        "提前到本批的任何一集** —— 哪怕它更能抓人、哪怕它更符合"
        '"第 1 集要让观众看到最大异常/危机"的常规做法。**用户的规划优先于点位设计。**\n'
        "3. 本批内部也要按用户写明的先后顺序推进，不得把本批区间内的后段内容"
        "提到前段。\n"
        "4. 用户规划里已经写定的具体设定（谁做什么、用什么物件、以什么方式、"
        "关键数字与专有名词）必须**原样沿用**，不得替换成同类但不同的东西。\n"
        "5. 若用户的规划与本文其它原则冲突（尤其「开场强事件」「危机前置」"
        "「第 1 集必须亮最大异常/危机」），**一律以用户的分集规划为准**。\n"
    )
    return head + tail
