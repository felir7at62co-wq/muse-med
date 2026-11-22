"""对话上下文加载器 —— 决定 AI 在工作台里"看得见什么"。

见 `docs/PLAN-对话上下文重构与分岔治理.md`（2026-09-21 定稿）。

## 它解决的问题

改这版之前：上下文里只有大纲的**皮**（概要截 300 字、规则 5 条、角色 10 人、
分集梗概前 50 集各 80 字），正文只有最新一章的 1500 字片段，
**剧本一个字都没有**（加载器只查 ScriptChapter），账本与分集契约更是从来没进过。
于是"看着剧本聊剧本，AI 手里是正文"，用户在第 7 章上说"这段改紧点"，
AI 手里只有那集的 80 字梗概。

## 现在的取数规则（从用户视角推导，见 PLAN §2）

编剧只会问两类问题，而这个二分恰好等于"说不说集号"：

  · **说了集号** → 问某集 → 给那几集**当前页签那种产物**的全文
  · **没说集号** → 问整本 → 给全剧骨架（正文一个字都不需要）

两个定位维度缺一不可：
  · **集号**（用户自己说，不做"这一集"的隐式推断）定位**哪一集**
  · **kind**（右栏当前页签）定位**哪一份稿子** —— 同一句"第7集这段太平"，
    在原文页指正文、在剧本页指分镜、在大纲页指契约

## 邻集：按区间外扩，给全文

邻集的作用是看衔接，所以按衔接的边界给：把点名的集合并成连续区间，
每个区间向外各扩一集（「5~8集」→ 4~9；「第3集和第30集」→ 2~4 与 29~31）。

## 分层（为上千集超长剧而设，不是为了迁就模型）

没有一个"整本类问题"需要逐集梗概全文——"哪几集钩子重复"只要每集的 hook 类型，
"伏笔收了没"只要 plant/payoff。所以：

  L0 全剧索引  每集一行（集号/标题/钩子/升级/状态位）—— 1000 集也才 ~50k，永远全量
  L1 邻域详情  点名区间的完整条目（梗概或摘要 + 完整契约 + 账本快照）
  L2 产物全文  点名区间内、当前页签那种产物的全文

骨架估算小于阈值时 L0 与 L1 合并（109 集的剧 54k 全给）；超过才降级为索引。

⚠️ **不做的事**（用户 2026-09-21 逐条裁定）：不猜"这一集"、不写"本集无正文由
大纲直生"这类说明句（状态已经在索引的每集一行里）、不因模型窗口做特殊处理
（换模型是用户自己的事，分层是为超长剧服务的）。
"""
from __future__ import annotations

import logging
import re
from typing import Any

from sqlalchemy import select

from ..db import ScriptChapter, ScriptDraft, ScriptStoryboard, session_scope
from ..stages.access import is_admin_role

logger = logging.getLogger("agent.context_loader")


# ---------------------------------------------------------------------------
# 唯一的体量开关：骨架估算超过它才降级为 L0 索引模式
#
# 292 字符/集（实测 draft 584 的分集条目均值）× 500 集 ≈ 146k。
# ⚠️ 这不是"模型装不下"的阈值——是"超长剧不该逐集铺开"的阈值。
#    109 集的剧骨架全量才 54k，远在阈值内，全给。
# ---------------------------------------------------------------------------
SKELETON_CHAR_BUDGET = 146_000

#: 每集产物全文的保护上限。**不是**为了省 token，而是防单条脏数据
#: （曾出现过一章存了几十万字的情况）把整个上下文顶爆。正常单集正文 2.2k、
#: 剧本 7.3k，离这个数很远，等于不生效。
MAX_CHARS_PER_EPISODE_PRODUCT = 60_000


def _current_model() -> str:
    """当前配置的生成模型。

    ⚠️ 必须用真实模型名：`text_budget` 按模型窗口算预算。传 None 会落到
    `DEFAULT_SPEC`（保守 128k），比实际配置的 gemini-3.6-flash（70 万口径）
    小 7 倍 —— 实测每集额度会从 2,889 字符掉到 393 字符，等于白白丢掉上下文。
    """
    try:
        from ..config import get_settings
        return get_settings().llm_generate_model or ""
    except Exception:  # noqa: BLE001 —— 取不到就退回保守默认，不阻断对话
        return ""


def choose_episode_budget(episode_count: int, *, named=(), neighbors=(),
                          model: str | None = None) -> int:
    """每集给多少字符 —— 走 `stages.text_budget` 按模型窗口算，不拍脑袋。

    2026-10-10：此前每集额度是隐式的（靠 `_episode_text` 返回什么就吃什么），
    而它返回的是 summary —— summary 好就看见全篇，summary 是截断就只见开头。
    现在额度显式化：总预算来自窗口（用户口径 70 万），按"点名集 > 邻集 > 其他"
    分配，且**每集都有保底**。

    返回的是"每集额度"（分配结果里的中位值），供 `_skeleton` 逐集使用。
    集数极多时 `allocate` 会自动退化为均分，不会让任何一集归零。
    """
    from ..stages.text_budget import text_budget_chars
    from ..stages.episode_text import allocate, MIN_PER_EPISODE_CHARS

    n = max(1, int(episode_count or 1))
    total = text_budget_chars(model if model is not None else _current_model(),
                              purpose="chat")
    alloc = allocate(total, orders=range(1, n + 1),
                     named=named, neighbors=neighbors)
    if not alloc:
        return MIN_PER_EPISODE_CHARS
    # 取中位数而非平均数：点名集权重高会把平均数拉偏，
    # 而绝大多数集应当拿的是"普通集"的额度。
    vals = sorted(alloc.values())
    return vals[len(vals) // 2]


#: 点名区间两侧各取几集算"邻集"（分配时给较高权重）。
_NEIGHBOR_SPAN = 1


def _neighbors_of(window: list[int] | None) -> set[int]:
    """点名区间的相邻集 —— 它们也是用户接下来最可能看的。"""
    if not window:
        return set()
    lo, hi = min(window), max(window)
    return set(range(max(1, lo - _NEIGHBOR_SPAN), lo)) | set(
        range(hi + 1, hi + 1 + _NEIGHBOR_SPAN))


_CN_NUM = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
           "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


def _cn_to_int(tok: str) -> int | None:
    """'12'→12; '十二'→12; '二十'→20; '三十五'→35。只处理 100 以内, 够用。"""
    if tok.isdigit():
        return int(tok)
    if "十" not in tok:
        return _CN_NUM.get(tok)
    head, _, tail = tok.partition("十")
    tens = 1 if head == "" else _CN_NUM.get(head)
    if tens is None:
        return None
    if tail == "":
        return tens * 10
    ones = _CN_NUM.get(tail)
    return None if ones is None else tens * 10 + ones


_NUM = r"[0-9]{1,4}|[一二两三四五六七八九十]{1,4}"
#: 区间：第5~8集 / 第5-8集 / 第5到8集 / 5～8集
_RANGE_RE = re.compile(
    rf"第?\s*({_NUM})\s*(?:[-–—~～]|到|至)\s*第?\s*({_NUM})\s*[集章话]")
#: 单集：第5集 / 第五章
_SINGLE_RE = re.compile(rf"第\s*({_NUM})\s*[集章话]")


def parse_focus_orders(text: str) -> list[int]:
    """从用户消息里抓出他点名的集号（去重、保序）。

    支持「第7集」「第五章」，以及**区间**「5~8集」「第5到8集」——
    区间会展开成逐集列表，因为下游一律按集号集合处理。

    ⚠️ 只认用户**明写**的集号。"这一集""当前这集"一律不认：
    用户 2026-09-21 裁定不做隐式推断（让用户说明集号符合操作习惯，
    而猜错集会让 AI 拿着错的稿子一本正经地改）。
    """
    if not text:
        return []
    out: list[int] = []

    def _add(n: int | None) -> None:
        if n and 0 < n <= 9999 and n not in out:
            out.append(n)

    consumed: list[tuple[int, int]] = []
    for m in _RANGE_RE.finditer(text):
        a, b = _cn_to_int(m.group(1)), _cn_to_int(m.group(2))
        if a and b and a <= b and (b - a) <= 200:   # 200 集以上的"区间"当误匹配
            for n in range(a, b + 1):
                _add(n)
            consumed.append((m.start(), m.end()))

    for m in _SINGLE_RE.finditer(text):
        # 落在已消费的区间里就跳过（"第5到8集"里的"第5"不要再算一遍）
        if any(s <= m.start() < e for s, e in consumed):
            continue
        _add(_cn_to_int(m.group(1)))

    return sorted(out)


def expand_to_intervals(orders: list[int], *, max_order: int | None = None) -> list[int]:
    """把点名的集合并成连续区间，每个区间向外各扩一集。

    「5,6,7,8」→ 4~9      「3」→ 2~4      「3,30」→ 2~4 与 29~31

    邻集的作用是**看衔接**，所以按衔接的边界给，而不是给头尾片段
    （用户 2026-09-21：能不能把第六集和第八集全放上去 —— 能）。
    """
    if not orders:
        return []
    src = sorted(set(int(o) for o in orders if o))
    out: set[int] = set()
    start = prev = src[0]
    for cur in src[1:] + [None]:  # type: ignore[list-item]
        if cur is not None and cur == prev + 1:
            prev = cur
            continue
        lo, hi = max(1, start - 1), prev + 1
        if max_order:
            hi = min(hi, max_order)
        out.update(range(lo, hi + 1))
        if cur is not None:
            start = prev = cur
    return sorted(out)


# ---------------------------------------------------------------------------
# 骨架
# ---------------------------------------------------------------------------

def _s(v: Any) -> str:
    """把大纲里的任意取值收敛成人话。

    集纲字段是人填的、也是模型重写的，同一个字段这一集是字符串、下一集可能是列表
    （`value_shift.from` 实测出现过 `["被动挨打","失去母亲"]`）。
    """
    if v is None:
        return ""
    if isinstance(v, (list, tuple, set)):
        return "、".join(_s(x) for x in v if _s(x))
    if isinstance(v, dict):
        return "、".join(f"{k}:{_s(x)}" for k, x in v.items() if _s(x))
    return str(v).strip()


def _world_block(outline: dict) -> str:
    world = outline.get("world") or {}
    if not isinstance(world, dict) or not world:
        return ""
    lines = []
    for label, key in (("时代", "era"), ("设定", "setting")):
        v = _s(world.get(key))
        if v:
            lines.append(f"- {label}：{v}")
    rules = world.get("rules") or []
    if isinstance(rules, list) and rules:
        # 全部规则，不截 —— 世界观规则正是"这部剧能不能这么写"的依据
        lines.append("- 规则：")
        lines.extend(f"  · {_s(r)}" for r in rules if _s(r))
    for k, v in world.items():
        if k in ("era", "setting", "rules"):
            continue
        sv = _s(v)
        if sv:
            lines.append(f"- {k}：{sv}")
    return "## 世界观\n" + "\n".join(lines) if lines else ""


def _characters_block(outline: dict) -> str:
    chars = outline.get("characters") or []
    if not isinstance(chars, list) or not chars:
        return ""
    lines = []
    for c in chars:
        if not isinstance(c, dict):
            lines.append(f"- {_s(c)}")
            continue
        name = _s(c.get("name")) or "(无名)"
        head = [name]
        if _s(c.get("role")):
            head.append(f"（{_s(c.get('role'))}）")
        lines.append(f"- {''.join(head)}")
        # 全部字段照搬 —— 外貌/动机/关键经历都是写人物时真正用得上的
        for k, v in c.items():
            if k in ("name", "role"):
                continue
            sv = _s(v)
            if sv:
                lines.append(f"  · {k}：{sv}")
    return "## 角色\n" + "\n".join(lines)


def _contract_line(ep: dict) -> str:
    """一集的戏剧契约压成一行（没有契约字段的老数据返回空串）。"""
    bits: list[str] = []
    if _s(ep.get("core_push")):
        bits.append(f"核心推进={_s(ep['core_push'])}")
    vs = ep.get("value_shift") or {}
    if isinstance(vs, dict) and _s(vs.get("from")) and _s(vs.get("to")):
        bits.append(f"价值转变={_s(vs['from'])}→{_s(vs['to'])}")
    for label, key in (("代价", "stakes"), ("升级", "escalation")):
        if _s(ep.get(key)):
            bits.append(f"{label}={_s(ep[key])}")
    ho = ep.get("hook_out") or {}
    if isinstance(ho, dict) and _s(ho.get("type")):
        seg = f"钩子={_s(ho['type'])}"
        if _s(ho.get("strength")):
            seg += f"/{_s(ho['strength'])}"
        if _s(ho.get("leads_to")):
            seg += f"→{_s(ho['leads_to'])}"
        bits.append(seg)
    for label, key in (("埋", "plant"), ("收", "payoff"), ("禁止", "forbidden")):
        if ep.get(key):
            bits.append(f"{label}={_s(ep[key])}")
    return " | ".join(bits)


def _status_bits(order: int, ch: Any, sb: Any) -> str:
    """每集一行里的状态位 —— 状态进索引，不进句子。"""
    bits = []
    bits.append("正文✓" if ch is not None and (ch.full_text or "").strip() else "正文✗")
    bits.append("剧本✓" if sb is not None and (sb.shots_json or []) else "剧本✗")
    if (ch is not None and ch.is_stale == 1) or (sb is not None and sb.is_stale == 1):
        bits.append("过期")
    if ch is not None and getattr(ch, "locked", 0):
        bits.append("锁定")
    return "[" + " ".join(bits) + "]"


def _episode_text(ep: dict, ch: Any, *, budget_chars: int = 4_000) -> str:
    """这一集用哪段文字代表它 —— 一律走 `stages.episode_text` 的统一口径。

    ## ⚠️ 2026-10-10 改：不再用 summary

    原实现是「有正文用 **summary**（实况），没正文用大纲梗概（计划）」。
    那个判断在写下时（2026-09-21）也许成立，但审计发现 summary 这个字段
    被**九处不同的写入者**填出过质量天差地别的三种东西：

        真摘要              4072 章（52%）  ← 可用
        正文前 500 字截断    2319 章（29%）  ← **不是摘要**
        summary 为空        1415 章（18%）  ← 这一集在对话里完全不可见

    平均可见度只有 32%（实例：草稿 584 第 3 集，AI 只见 500/1584 字）。
    于是"AI 看见的是这一集的实况"这个前提根本不成立 —— 它看见的是开头。

    现在统一交给 `pick_episode_text`，它做三件事：
      1. **识别假摘要**（`is_trustworthy_summary`）并越过它 → 落回全文；
      2. 按预算裁剪、显式标注断点；
      3. **永不返回空** —— 最低退到大纲梗概。

    方向用 `continuity`（保尾）：对话里 AI 要接的是"演到哪了"。
    """
    from ..stages.episode_text import pick_episode_text
    text, _form = pick_episode_text(
        ep or {}, ch, purpose="continuity", budget_chars=budget_chars)
    return _s(text) if text else _s(ep.get("synopsis"))


def _skeleton(
    outline: dict, chapters: dict[int, Any], boards: dict[int, Any],
    *, detailed: bool, only_orders: set[int] | None = None,
    episode_budget: int = 4_000,
) -> str:
    """分集骨架。

    detailed=True  出完整条目（L1）；False 出一行索引（L0）。
    only_orders    只铺这些集 —— 索引模式下用来把**点名区间**单独展开成 L1，
                   否则超长剧里用户点名的那几集反而只有一行索引，
                   等于"问了也看不到细节"。
    episode_budget 每集分到的字符额度（由 `choose_episode_budget` 算好传入）。
    """
    eps = outline.get("episodes") or outline.get("chapters") or []
    if not isinstance(eps, list) or not eps:
        return ""
    lines: list[str] = []
    for i, ep in enumerate(eps):
        if not isinstance(ep, dict):
            continue
        order = ep.get("order") or (i + 1)
        try:
            order = int(order)
        except Exception:
            order = i + 1
        if only_orders is not None and order not in only_orders:
            continue
        title = _s(ep.get("title"))
        ch, sb = chapters.get(order), boards.get(order)
        head = f"{order}. 「{title}」" if title else f"{order}."
        status = _status_bits(order, ch, sb)

        if not detailed:
            # L0：一行。整本类问题（钩子重复/伏笔未收/升级停滞）靠的就是这一行
            ho = ep.get("hook_out") or {}
            brief = []
            if isinstance(ho, dict) and _s(ho.get("type")):
                brief.append(f"钩子={_s(ho['type'])}")
            if _s(ep.get("escalation")):
                brief.append(f"升级={_s(ep['escalation'])}")
            for label, key in (("埋", "plant"), ("收", "payoff")):
                if ep.get(key):
                    brief.append(f"{label}={_s(ep[key])}")
            lines.append(f"  {head} {status} " + " ".join(brief))
            continue

        lines.append(f"  {head} {status}")
        body = _episode_text(ep, ch, budget_chars=episode_budget)
        if body:
            lines.append(f"     {body}")
        contract = _contract_line(ep)
        if contract:
            lines.append(f"     {contract}")
    if not lines:
        return ""
    if only_orders is not None:
        label = "## 你问到的这几集（完整条目）"
    else:
        label = "## 分集详情" if detailed else "## 全剧索引（每集一行）"
    return f"{label}\n" + "\n".join(lines)


def _estimate_skeleton_chars(outline: dict) -> int:
    eps = outline.get("episodes") or outline.get("chapters") or []
    try:
        import json
        return len(json.dumps(eps, ensure_ascii=False))
    except Exception:
        return len(str(eps))


# ---------------------------------------------------------------------------
# 产物全文
# ---------------------------------------------------------------------------

def _product_label(kind: str | None) -> str:
    return {
        "chapters": "正文", "storyboards": "剧本", "outline": "大纲",
        "novel": "小说", "tweet": "推文",
    }.get(kind or "chapters", "正文")


async def _load_products(
    s, draft_id: int, kind: str | None, orders: list[int],
) -> dict[int, tuple[str, str]]:
    """加载点名区间里、**当前页签那种**产物的全文。

    返回 {集号: (产物名, 全文)}。

    ⚠️ 剧本页要额外带上"来源正文"——但**不假设剧本来自正文**：
    全库 5,479 集是"大纲直接生成剧本"、根本没有正文（见 PLAN §2.4）。
    有就给，没有就不给，**不写"本集无正文"这种说明句**（状态已在索引里）。
    """
    if not orders:
        return {}
    out: dict[int, tuple[str, str]] = {}

    if kind == "storyboards":
        rows = (await s.execute(
            select(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id,
                ScriptStoryboard.chapter_order.in_(orders),
            )
        )).scalars().all()
        from ..critique.rules import storyboard_to_text
        for r in rows:
            txt = storyboard_to_text(r.shots_json or [])
            if txt.strip():
                out[int(r.chapter_order)] = ("剧本", txt[:MAX_CHARS_PER_EPISODE_PRODUCT])
        return out

    if kind in ("novel", "tweet"):
        from ..adapt_products.models import ChapterAdaptation
        rows = (await s.execute(
            select(ChapterAdaptation).where(
                ChapterAdaptation.draft_id == draft_id,
                ChapterAdaptation.kind == kind,
                ChapterAdaptation.chapter_order.in_(orders),
            )
        )).scalars().all()
        for r in rows:
            if (r.content or "").strip():
                out[int(r.chapter_order)] = (
                    _product_label(kind), (r.content or "")[:MAX_CHARS_PER_EPISODE_PRODUCT])
        return out

    if kind == "outline":
        # 大纲页：契约已在骨架的分集详情里，这里不重复铺一遍
        return out

    rows = (await s.execute(
        select(ScriptChapter).where(
            ScriptChapter.draft_id == draft_id,
            ScriptChapter.chapter_order.in_(orders),
        )
    )).scalars().all()
    for r in rows:
        if (r.full_text or "").strip():
            out[int(r.chapter_order)] = (
                "正文", (r.full_text or "")[:MAX_CHARS_PER_EPISODE_PRODUCT])
    return out


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

async def build_draft_context(
    draft_id: int, user_id: int,
    focus_orders: list[int] | None = None,
    kind: str | None = None,
    user_role: str | None = None,
) -> str:
    """拼出这次对话要喂给模型的草稿上下文。

    focus_orders: 用户这句话点名的集号（`parse_focus_orders` 的结果）。
    kind: 右栏当前页签（chapters/storyboards/outline/novel/tweet）——
          决定"点名的集给哪一种产物"。
    user_role: 调用者的角色。**管理员必须能看别人的草稿** —— 见下方越权校验的说明。
    """
    if not draft_id:
        return ""

    try:
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            if not d:
                return ""
            # 越权校验：普通用户只能看自己的草稿；**管理员可以看任意草稿**。
            #
            # ⚠️ 2026-10-25 修：这里原先只比较 user_id，没有管理员放行。
            # 而路由层 `stages/access.check_draft_access` 是放行 admin/superadmin 的
            # —— 两层口径不一致，后果是**管理员打开别人的剧本、AI 说"你没贴原文"**：
            # 页面能看（路由放行）、对话看不到（这里整段上下文被清空）。
            # 用户实测反馈："治愈系夫人力拔山河明明有原文，对话却显示没有"。
            # 现在统一走 access.is_admin_role，别再各写一份。
            if not is_admin_role(user_role) and d.user_id is not None and d.user_id != user_id:
                logger.info("agent context: draft %d not owned by user %d (role=%s)",
                            draft_id, user_id, user_role)
                return ""

            outline = d.outline or {}
            eps_meta = outline.get("episodes") or outline.get("chapters") or []
            max_order = 0
            for i, ep in enumerate(eps_meta if isinstance(eps_meta, list) else []):
                if isinstance(ep, dict):
                    try:
                        max_order = max(max_order, int(ep.get("order") or (i + 1)))
                    except Exception:
                        max_order = max(max_order, i + 1)
            max_order = max(max_order, int(d.episode_count or 0))

            chapters = {
                int(c.chapter_order): c for c in (await s.execute(
                    select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
                )).scalars().all() if c.chapter_order is not None
            }
            boards = {
                int(b.chapter_order): b for b in (await s.execute(
                    select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
                )).scalars().all() if b.chapter_order is not None
            }

            focus = sorted(set(focus_orders or []))
            window = expand_to_intervals(focus, max_order=max_order or None)

            parts: list[str] = [
                f"【当前草稿】《{d.title or '未命名'}》  状态: {d.status}"
                + (f"  共 {d.episode_count} 集" if d.episode_count else "")
                + (f"  当前页签: {_product_label(kind)}" if kind else "")
            ]

            syn = _s(outline.get("synopsis"))
            if syn:
                parts.append("## 剧情概要\n" + syn)          # 全量，不截
            wb = _world_block(outline)
            if wb:
                parts.append(wb)
            cb = _characters_block(outline)
            if cb:
                parts.append(cb)

            # 分档：小剧全量详情，超长剧降为一行索引（见 PLAN §3.2/§3.3）
            detailed = _estimate_skeleton_chars(outline) < SKELETON_CHAR_BUDGET
            # 每集额度：按模型窗口算总预算，再按"点名集优先"分配给各集。
            # 用户 2026-10-10 裁定：预算按窗口设计；且**任何一集都不许归零**
            # （allocate 内部先扣每集保底，再按权重分余量）。
            ep_budget = choose_episode_budget(
                max_order or len(eps_meta) or 1,
                named=focus, neighbors=_neighbors_of(window),
            )
            sk = _skeleton(outline, chapters, boards, detailed=detailed,
                           episode_budget=ep_budget)
            if sk:
                parts.append(sk)
                if not detailed:
                    parts.append(
                        "（本剧集数过多，上面是每集一行的索引；"
                        "需要某几集的细节时，在提问里写明集号即可。）")
                    # L1：索引模式下，把点名区间单独展开成完整条目。
                    # 少了这一步，用户在千集剧里问"第700集"，拿到的仍只有一行索引。
                    if window:
                        # 点名的那几集单独展开时给更大的额度：用户明确要看它们。
                        l1 = _skeleton(outline, chapters, boards,
                                       detailed=True, only_orders=set(window),
                                       episode_budget=max(ep_budget, 8_000))
                        if l1:
                            parts.append(l1)

            # 状态账本：点名了就给截至该集的快照，否则给全量
            ledger = outline.get("state_ledger")
            if ledger:
                try:
                    from ..stages.state_ledger import snapshot_text
                    upto = max(focus) if focus else max_order
                    snap = snapshot_text(ledger, upto)
                    if snap.strip():
                        parts.append(f"## 世界状态（截至第 {upto} 集）\n{snap}")
                except Exception as e:  # noqa: BLE001
                    logger.warning("ledger snapshot failed: %s", e)

            # 点名区间的产物全文
            if window:
                products = await _load_products(s, draft_id, kind, window)
                # 剧本页额外带来源正文（有才给）
                extra: dict[int, str] = {}
                if kind == "storyboards":
                    for o in window:
                        ch = chapters.get(o)
                        if ch is not None and (ch.full_text or "").strip():
                            extra[o] = (ch.full_text or "")[:MAX_CHARS_PER_EPISODE_PRODUCT]
                elif kind in ("novel", "tweet"):
                    for o in window:
                        ch = chapters.get(o)
                        if ch is not None and (ch.full_text or "").strip():
                            extra[o] = (ch.full_text or "")[:MAX_CHARS_PER_EPISODE_PRODUCT]

                blocks: list[str] = []
                for o in window:
                    got = products.get(o)
                    if got:
                        label, txt = got
                        tag = "（你正在问的）" if o in focus else "（相邻集，用于看衔接）"
                        blocks.append(f"### 第 {o} 集 {label}{tag}\n{txt}")
                    if o in extra:
                        blocks.append(f"### 第 {o} 集 正文（对照用）\n{extra[o]}")
                if blocks:
                    parts.append("\n\n".join(blocks))

            parts.append(
                "（以上是用户当前正在创作的剧本。上面给出全文的集，"
                "用户让你改写/分析时直接基于那份全文动手，不要再要求他粘贴原文；"
                "上面没有给出全文的集，若用户要针对它动手，请他写明集号。）"
            )
            return "\n\n".join(p for p in parts if p and p.strip())
    except Exception as ex:
        logger.exception("build_draft_context failed: %s", ex)
        return ""


# ===========================================================================
# 增强: 用户长期记忆 + 画像 + 优秀片段注入
# ===========================================================================

async def build_full_context(
    *, user_id: int, draft_id: int | None = None,
    recent_user_message: str = "", include_snippets: bool = True,
    kind: str | None = None, conversation_id: int | None = None,
    user_role: str | None = None,
) -> str:
    """组装完整上下文 (用户画像 + 长期记忆 + 优秀片段 + 上传文档 + 草稿上下文)。

    user_role: 调用者角色，透传给 build_draft_context 做草稿越权校验
    （管理员放行任意草稿，见那里的说明）。
    """
    from .memory import (
        get_or_create_profile, recall_memories, recall_snippets,
        render_profile_block, render_memories_block, render_snippets_block,
    )
    parts: list[str] = []

    profile = await get_or_create_profile(user_id)
    if profile.get("memory_enabled", True):
        prof_block = render_profile_block(profile)
        if prof_block:
            parts.append(prof_block)

        ci = profile.get("custom_instructions")
        if ci:
            parts.append(f"==== 用户自定义指令 ====\n{str(ci)[:1000]}")

        # ⚠️ 必须把 draft_id 传下去：记忆里角色表/世界观是**按剧本隔离**的，
        # 不传就等于"这部戏的提示词里可以出现上一部戏的角色"（2026-10-10 串台事故）。
        # 这里的 draft_id 取自 draft_id 形参本身，不是 draft_id_for_ctx —— 后者在
        # 别处被 fallback 成 conv.draft_id，而本函数收到的就是最终生效的那个。
        try:
            mems = await recall_memories(user_id, recent_user_message or "短剧创作",
                                         top_k=8, draft_id=draft_id)
            mem_block = render_memories_block(mems)
            if mem_block:
                parts.append(mem_block)
        except Exception as e:
            logger.warning("recall_memories failed: %s", e)

        if include_snippets and recent_user_message:
            kw = ("写" in recent_user_message or "改" in recent_user_message or
                  "续" in recent_user_message or "扩" in recent_user_message or
                  "重新" in recent_user_message)
            if kw:
                try:
                    sps = await recall_snippets(user_id, recent_user_message, top_k=3)
                    sp_block = render_snippets_block(sps)
                    if sp_block:
                        parts.append(sp_block)
                except Exception as e:
                    logger.warning("recall_snippets failed: %s", e)

    if draft_id:
        focus = parse_focus_orders(recent_user_message)
        draft_ctx = await build_draft_context(draft_id, user_id, focus_orders=focus,
                                              kind=kind, user_role=user_role)
        if draft_ctx:
            parts.append(draft_ctx)

    # 上传的长文档：已落盘，这里按需取用（不再整篇进对话历史）。
    # ⚠️ 放在最后：它是**最大的一块**，前面的用户画像/记忆/草稿上下文优先级更高，
    # 万一整体超限，先被压缩的应该是文档正文而不是"这部剧是什么"。
    try:
        from .doc_context import build_document_block
        doc_block = await build_document_block(
            user_id=user_id, conversation_id=conversation_id,
            draft_id=draft_id, recent_user_message=recent_user_message)
        if doc_block:
            parts.append(doc_block)
    except Exception as e:  # noqa: BLE001 — 检索失败绝不阻断对话
        logger.warning("build_document_block failed: %s", e)

    return "\n\n---\n\n".join(parts)


async def get_intent_context(user_id: int, draft_id: int | None, user_role: str | None = None) -> dict:
    """给意图识别用的轻量上下文.

    user_role: 同 build_draft_context —— 管理员要看得到别人的草稿，
    否则意图识别拿不到集号/标题，会把"分析这个剧本"这类指令判错。
    """
    if not draft_id: return {}
    try:
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            if not d or (not is_admin_role(user_role)
                         and d.user_id is not None and d.user_id != user_id):
                return {}
            chs = (await s.execute(
                select(ScriptChapter.chapter_order)
                .where(ScriptChapter.draft_id == draft_id)
                .order_by(ScriptChapter.chapter_order)
            )).scalars().all()
            outline = d.outline or {}
            ep_count = len(outline.get("chapters") or outline.get("episodes") or [])
            return {
                "draft_id": draft_id,
                "draft_title": d.title or "",
                "chapter_orders": list(chs),
                "episode_count": ep_count,
            }
    except Exception as e:
        logger.warning("get_intent_context failed: %s", e)
        return {}
