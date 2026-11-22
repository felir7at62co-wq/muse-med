"""⚠️ 2026-10-18: 本模块的工具（@tool 注册的 20 个）随 AgentLoop 下线已无调用方；
多步自主能力统一由 app/agent_engine 提供。仍在使用的只有 _resolve_draft（对话工坊生成按钮
缺草稿时自动解析/建草稿，依赖 t_import_outline），拆分它需要改生成路径，留作后续清理。

对话工坊工具集 (Chat Studio Skills) —— Agent 可调用的领域能力。

**刻意不复用超级 Agent 的 registry**（用户已确认超级 Agent 将来删除）：

  超级 Agent 的 `skills/registry.py` 有 54 个技能，但实测它有 5 处硬伤
  （静默截断 MAX_STEPS=40、上下文爆炸、模型选择写死、任务非持久、
  防假完成只做一次）。本模块**只借鉴"工具循环"这个模式**，代码全部重写：
    1. 每个工具返回结构化的 {ok, ...} 结果，便于 Agent 自证
    2. 工具分为「只读（零成本）」与「写入（需确认）」两类，风险显式声明
    3. 工具结果自带**验证信号**（如门禁返回 error 计数），让 Agent 能判断改好没有

工具设计原则：**能自证才算完整**。修复类工具必须能回答"修好了没有"。
"""
from __future__ import annotations

import functools
import logging
import time
from typing import Any, Callable, Awaitable

from sqlalchemy import select, func, delete, update
from sqlalchemy.orm.attributes import flag_modified

from ..db import ScriptDraft, ScriptChapter, ScriptStoryboard, session_scope
from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from ..stages.drama_gate import check_outline
from ..stages.chinese_style import scan_outline_style, scan_chinese_style
from ..stages.access import is_admin_role

logger = logging.getLogger("chat_skills")


# ---------------------------------------------------------------------------
# 参数强制转换
#
# ⚠️ 实测教训：LLM 通过工具调用传参时**经常把整数传成字符串**（"471" 而非 471），
# 直接用于 SQL 比较会报 `operator does not exist: integer = character varying`，
# 或 `'<=' not supported between instances of 'str' and 'int'`。
# 这是工具层必须自己兜住的，不能指望模型每次都传对类型。
# ---------------------------------------------------------------------------

def _coerce_args(fn, args: dict) -> dict:
    """按类型注解把传入参数转成正确类型。转换失败则保持原值（让工具自己报错）。"""
    import typing
    try:
        hints = typing.get_type_hints(fn)
    except Exception:  # noqa: BLE001
        return args
    out = dict(args)
    for k, v in list(out.items()):
        if k not in hints:
            continue
        hint = hints[k]
        origin = typing.get_origin(hint)
        if origin is typing.Union:      # Optional[int] → Union[int, None]
            hint = next((a for a in typing.get_args(hint) if a is not type(None)), hint)
        if isinstance(v, str):
            if hint is int:
                try:
                    out[k] = int(v.strip())
                except (ValueError, TypeError):
                    pass
            elif hint is float:
                try:
                    out[k] = float(v.strip())
                except (ValueError, TypeError):
                    pass
            elif hint is bool:
                out[k] = v.strip().lower() in ("1", "true", "yes", "y", "是")
        elif isinstance(v, (int, float)) and hint is str:
            out[k] = str(v)
    return out


# ---------------------------------------------------------------------------
# 工具注册表
# ---------------------------------------------------------------------------

class Tool:
    """一个可被 Agent 调用的工具。"""

    def __init__(self, *, name: str, label: str, desc: str, params: dict,
                 fn: Callable[..., Awaitable[dict]], writes: bool = False,
                 zero_cost: bool = True, hidden_params: tuple[str, ...] = ()):
        self.name = name
        self.label = label
        self.desc = desc          # 给 Agent 看的使用说明
        self.params = params      # {参数名: 说明}
        self.fn = fn
        self.writes = writes      # 是否修改数据
        self.zero_cost = zero_cost  # 是否零 LLM 成本
        # 由调度器**自动填充**、模型看不到也填不了的参数(如 user_id)。
        # 这类参数不能进 params —— 进了就会出现在工具 schema 的 required 里,
        # 模型会去编一个假的 user_id, 或者干脆不敢调这个工具。
        self.hidden_params = hidden_params


_TOOLS: dict[str, Tool] = {}


def tool(*, name: str, label: str, desc: str, params: dict | None = None,
         writes: bool = False, zero_cost: bool = True,
         hidden_params: tuple[str, ...] = ()):
    def deco(fn):
        # ⚠️ 这里**不能**用 functools.wraps——它会让 wrapper 继承原函数的
        # __wrapped__ 与签名，于是"工具内部互相调用"（如 patch_outline_episode
        # 里调 t_check_structure）会绕过 wrapper，参数直接按原函数签名绑定，
        # 报 "takes 0 positional arguments but 1 was given"。
        # 实测踩过：内部复检全部失败，AI 只好如实报告"工具报错、没改成功"。
        # 保留原函数名与文档，但**不暴露 __wrapped__**。
        wrapper = _make_wrapper(fn, name, label, desc)

        _TOOLS[name] = Tool(name=name, label=label, desc=desc,
                            params=params or {}, fn=wrapper,
                            writes=writes, zero_cost=zero_cost,
                            hidden_params=tuple(hidden_params))
        return wrapper
    return deco


def _make_wrapper(fn, name, label, desc):
    """构造工具的真实入口：负责参数强转 + 结果归一。

    结果归一很重要：模型有时会返回非 dict（None/str），调用方一律按失败处理，
    比抛异常好（抛异常会中断整个 Agent 回合）。
    """
    import inspect as _inspect
    _params = list(_inspect.signature(fn).parameters)

    async def _entry(*args, **kwargs) -> dict:
        """工具统一入口。

        同时支持位置参数与关键字参数——调用方（包括内部互调、测试脚本、
        未来的其他模块）两种写法都有，只认 kwargs 会踩坑（实测踩过）。
        """
        call_kwargs = dict(kwargs)
        for i, v in enumerate(args):
            if i < len(_params):
                call_kwargs.setdefault(_params[i], v)
        try:
            res = await fn(**_coerce_args(fn, call_kwargs))
        except TypeError as e:
            return {"ok": False, "error": f"{name} 参数不对: {e}"}
        if not isinstance(res, dict):
            return {"ok": True, "result": res}
        return res
    _entry.__name__ = name
    _entry.__doc__ = f"{label}。{desc}"
    return _entry


def get_tool(name: str) -> Tool | None:
    return _TOOLS.get(name)


def all_tools() -> list[Tool]:
    return list(_TOOLS.values())


def tools_spec_for_llm(*, include_writes: bool = True) -> str:
    """给 LLM 看的工具清单（自然语言 + 参数说明）。"""
    lines = ["## 你可以调用的工具", ""]
    for t in _TOOLS.values():
        if t.writes and not include_writes:
            continue
        cost = "零成本" if t.zero_cost else "消耗 1 次调用"
        head = f"### {t.name} —— {t.label}（{cost}{'，会修改数据' if t.writes else ''}）"
        lines.append(head)
        lines.append(t.desc.strip())
        if t.params:
            lines.append("参数：")
            for k, v in t.params.items():
                lines.append(f"  - {k}: {v}")
        lines.append("")
    lines.append(
        "调用格式：用工具调用（function call）传参。"
        "只读工具可自由调用；写入类工具会先请求用户确认。"
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 只读工具（零 LLM，可自由调用）
# ---------------------------------------------------------------------------

@tool(
    name="list_drafts", label="列出我的草稿",
    desc="列出当前用户的草稿（id/标题/集数/状态）。当用户问'我有哪些剧'"
         "或需要确定操作对象时调用。",
    params={"limit": "返回条数，默认 20"},
    hidden_params=("user_id",),
)
async def t_list_drafts(user_id: int, limit: int = 20) -> dict:
    async with session_scope() as s:
        rows = (await s.execute(
            select(ScriptDraft)
            .where(ScriptDraft.user_id == user_id, ScriptDraft.is_deleted == False)  # noqa: E712
            .order_by(ScriptDraft.id.desc()).limit(int(limit))
        )).scalars().all()
    return {"ok": True, "items": [
        {"id": r.id, "title": r.title, "episode_count": r.episode_count,
         "word_target": r.chapter_word_target, "status": r.status}
        for r in rows
    ]}


@tool(
    name="get_draft_overview", label="查草稿概况",
    desc="查一部剧的结构概况：集数、每集字数、已完成大纲/正文/分镜/小说/推文的集数。"
         "这是了解'这部剧做到哪一步了'的首选工具。",
    params={"draft_id": "草稿 id"},
)
async def t_get_draft_overview(draft_id: int) -> dict:
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        outline = dict(d.outline or {})
        eps = outline.get("chapters") or outline.get("episodes") or []
        chs = (await s.execute(select(ScriptChapter).where(
            ScriptChapter.draft_id == draft_id))).scalars().all()
        sbs = (await s.execute(select(ScriptStoryboard).where(
            ScriptStoryboard.draft_id == draft_id))).scalars().all()
        from ..adapt_products.models import ChapterAdaptation
        ads = (await s.execute(select(ChapterAdaptation).where(
            ChapterAdaptation.draft_id == draft_id))).scalars().all()
    novel = len([a for a in ads if a.kind == "novel"])
    tweet = len([a for a in ads if a.kind == "tweet"])
    done_ch = len([c for c in chs if (c.full_text or "").strip()])
    done_sb = len([x for x in sbs if (x.shots_json or [])])
    return {"ok": True,
        "draft_id": draft_id, "title": d.title,
        "episode_count_setting": d.episode_count,
        "word_target": d.chapter_word_target,
        "model_provider": d.model_provider,
        "outline_episodes": len(eps),
        "has_bible": bool(outline.get("story_bible")),
        "has_ledger": bool(outline.get("state_ledger")),
        "chapters_done": done_ch, "storyboards_done": done_sb,
        "novel_done": novel, "tweet_done": tweet,
        "outline_title": outline.get("title") or "",
    }


@tool(
    name="check_structure", label="跑剧情结构门禁",
    desc="检查这部剧的戏剧结构：钩子链是否连续、压迫强度是否在上升、伏笔有没有埋了没收、"
         "价值转变有没有发生。**零成本、秒级**。返回值里的 error_count/warn_count "
         "就是你的成绩单——修复前后对比这两个数字，就知道改好了没有。",
    params={"draft_id": "草稿 id"},
)
async def t_check_structure(draft_id: int) -> dict:
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        outline = dict(d.outline or {})
    eps = outline.get("chapters") or outline.get("episodes") or []
    if not eps:
        return {"ok": True, "error_count": 0, "warn_count": 0, "issues": [],
                "note": "这部剧还没有大纲，无法做结构检查"}
    rep = check_outline(outline, bible=outline.get("story_bible") or {})
    # 只回传前 40 条，避免把上下文打爆（这是超级 Agent 的教训之一）
    issues = (rep.get("issues") or [])[:40]
    return {
        "ok": True,
        "error_count": rep["summary"]["error"],
        "warn_count": rep["summary"]["warn"],
        "checked_episodes": rep["summary"]["checked"],
        "issues": [
            {"level": i["level"], "code": i["code"], "episode": i.get("episode"),
             "message": i["message"], "fix_hint": i.get("fix_hint", "")}
            for i in issues
        ],
        "truncated": len(rep.get("issues") or []) > 40,
    }


@tool(
    name="check_style", label="检查中文文风",
    desc="检查有没有翻译腔（'与此同时''的旅程'）、英文残留、欧美剧术语（救猫咪/B故事线）。"
         "**零成本**。改完之后再跑一次，看 error_count 是否归零。",
    params={"draft_id": "草稿 id", "target": "outline=只查大纲(默认) | chapters=只查正文 | all=都查"},
)
async def t_check_style(draft_id: int, target: str = "outline") -> dict:
    issues: list[dict] = []
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        outline = dict(d.outline or {})
        if target in ("chapters", "all"):
            chs = (await s.execute(select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id))).scalars().all()
    if target in ("outline", "all"):
        for i in scan_outline_style(outline):
            issues.append({"level": i["level"], "code": i["code"],
                           "message": i["message"], "where": "大纲"})
    if target in ("chapters", "all"):
        for c in chs:
            for i in scan_chinese_style(c.full_text or "", where=f"第{c.chapter_order}集"):
                issues.append({"level": i["level"], "code": i["code"],
                               "message": i["message"], "where": f"第{c.chapter_order}集正文"})
    errs = [i for i in issues if i["level"] == "error"]
    return {"ok": True,
            "error_count": len(errs), "warn_count": len(issues) - len(errs),
            "issues": issues[:40], "truncated": len(issues) > 40}


def _fmt_power(pw: dict) -> str:
    """把 power 渲染成一句人话，供超级 Agent 阅读。

    ⚠️ 不要用 `f"...".strip(" （争：）")` 这种写法收尾 —— `str.strip` 剥的是
    **字符集合**不是后缀，实测会把「顾总（争：那份签字）」剥成
    「顾总（争：那份签字」（右括号被当成待剥字符吃掉），而只有 focus 时
    更会整段只剩「遗嘱」。所以这里逐段条件拼接，缺哪段就不出哪段。
    """
    agg = str(pw.get("aggressor") or "").strip()
    dfd = str(pw.get("defender") or "").strip()
    focus = str(pw.get("focus") or "").strip()
    if not (agg or dfd or focus):
        return "未标注"
    parts: list[str] = []
    if agg or dfd:
        parts.append(f"{agg or '（未写）'} → {dfd or '（未写）'}")
    if focus:
        parts.append(f"（争：{focus}）")
    return " ".join(parts)


@tool(
    name="list_episodes", label="看某几集的概要",
    desc="读大纲里某段集数的概要、核心推进点、价值转变、失败代价、结尾卡点。"
         "需要判断'第几集发生了什么'时用它，不要凭空猜。",
    params={"draft_id": "草稿 id", "start": "起始集号", "end": "结束集号"},
)
async def t_list_episodes(draft_id: int, start: int, end: int) -> dict:
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        outline = dict(d.outline or {})
    eps = sorted((outline.get("chapters") or []), key=lambda e: e.get("order", 0))
    picked = [e for e in eps if start <= e.get("order", 0) <= end][:20]
    out = []
    for e in picked:
        vs = e.get("value_shift") or {}
        ho = e.get("hook_out") or {}
        pw = e.get("power") or {}
        # 情绪强度 / 权力关系（2026-09-19 新增）也要透出去。
        # 理由：它们已经是**剧情门禁的判据**（emotion_cliff / power_self /
        # power_incomplete / power_focus_vague）。超级 Agent 看不到这两个字段，
        # 就无法解释"为什么第 8 集被判了 warn"，只能复述判决、说不出依据。
        # 未标注（0）时显式写"未标注"而不是 0 —— 那与"强度确实是 0"是两件事。
        intensity = e.get("emotion_intensity") or 0
        out.append({
            "order": e.get("order"), "title": e.get("title", ""),
            "synopsis": (e.get("synopsis") or "")[:300],
            "core_push": e.get("core_push", ""),
            "value_shift": f"{vs.get('from','')} → {vs.get('to','')}",
            "stakes": e.get("stakes", ""),
            "hook_out": f"{ho.get('type','')}/{ho.get('strength','')} → {ho.get('leads_to','')}",
            "emotion_intensity": intensity if intensity else "未标注",
            "power": _fmt_power(pw),
            "plant": e.get("plant") or [], "payoff": e.get("payoff") or [],
        })
    return {"ok": True, "episodes": out,
            "note": f"共 {len(eps)} 集，本次返回第 {start}~{end} 集"}


@tool(
    name="read_chapter", label="读某一集正文/剧本",
    desc="读某一集的正文（脚本）或剧本（分镜）的具体内容。判断文本质量、找具体问题时用。",
    params={"draft_id": "草稿 id", "order": "集号",
            "kind": "chapter=正文(默认) | storyboard=剧本(分镜)"},
)
async def t_read_chapter(draft_id: int, order: int, kind: str = "chapter") -> dict:
    async with session_scope() as s:
        if kind == "storyboard":
            row = (await s.execute(select(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id,
                ScriptStoryboard.chapter_order == order))).scalar_one_or_none()
            if not row:
                return {"ok": False, "error": f"第{order}集还没有剧本"}
            import json
            return {"ok": True, "kind": "storyboard", "order": order,
                    "content": json.dumps(row.shots_json or [], ensure_ascii=False)[:20000]}
        row = (await s.execute(select(ScriptChapter).where(
            ScriptChapter.draft_id == draft_id,
            ScriptChapter.chapter_order == order))).scalar_one_or_none()
        if not row:
            return {"ok": False, "error": f"第{order}集还没有正文"}
        return {"ok": True, "kind": "chapter", "order": order,
                "title": row.title, "chars": len(row.full_text or ""),
                "content": (row.full_text or "")[:20000]}


@tool(
    name="list_promises", label="看伏笔台账",
    desc="列出这部剧所有伏笔的埋设集、回收状态、是否逾期。"
         "当结构检查报了'伏笔埋了没收'时，用它看清具体是哪几条。",
    params={"draft_id": "草稿 id"},
)
async def t_list_promises(draft_id: int) -> dict:
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        outline = dict(d.outline or {})
    rep = check_outline(outline, bible=outline.get("story_bible") or {})
    st = rep.get("structure") or {}
    promises = st.get("promises") or []
    return {"ok": True, "total": len(promises), "promises": [
        {"id": p.get("id"), "text": (p.get("text") or "")[:80],
         "planted_at": p.get("planted_at"), "status": p.get("status"),
         "paid_at": p.get("paid_at"), "overdue": bool(p.get("overdue"))}
        for p in promises[:60]
    ]}


@tool(
    name="deai_detect", label="扫一遍 AI 味",
    desc="扫这部剧的 AI 腔：句式同构、段末升华/预告、排比堆叠、形容词通胀、冷热失调，"
         "再叠一层结构层诊断（段落长度方差、开门见山度、升华收尾）。"
         "**零成本、不调模型、秒级**，返回逐集分数与命中样例。\n"
         "用户问'这稿子像不像 AI 写的''AI 味重不重''有没有 AI 腔'时用它，不要凭印象回答。\n"
         "⚠️ 两条必须如实告诉用户的话：① 分数是**相对指标**（同一文本改前改后对比），"
         "**不是**任何检测平台的通过率，也不是'AI 生成概率'；② 情绪直说、"
         "类型惯例写法**不算** AI 味，引擎分 A/B/C 三级，只有 A 级才是硬信号。\n"
         "这个工具**只读**：它不改草稿、不改任何内容。要真的清洗，让用户去「去 AI 味」"
         "（出一份独立清洗稿）或整本精修。",
    params={"draft_id": "草稿 id",
            "max_episodes": "最多返回几集明细（默认 8，防止打爆上下文）"},
)
async def t_deai_detect(draft_id: int, max_episodes: int = 8) -> dict:
    from ..deai import service as _deai_service
    from ..polish.ai_taste import detect_ai_taste
    from ..polish.deai_structure import diagnose_structure

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        title = d.title or f"草稿{draft_id}"

    eps = await _deai_service._load_episodes(draft_id)
    eps = [(ep, kind, txt) for ep, kind, txt in eps if (txt or "").strip()]
    # 空草稿也要带「相对指标」声明：否则模型拿到一个没有 note 的返回，播报时
    # 很容易把 0 分说成"这篇稿子 100% 人类写的，检测平台包过"——那是假的。
    if not eps:
        return {"ok": True, "score": 0, "level": "轻度", "per_kilo": 0.0,
                "episodes": [], "worst": [], "truncated": False,
                "note": "这部剧还没有正文/剧本，没有可检测的文本。"
                        "（另：分数是相对指标，不是检测平台通过率。）"}

    # 整本聚合分：逐集分别算再取"最差几集"——整体分开算比拼成一大段更有指导性
    # （用户要知道"是哪几集"，不是"整本一个数"）。
    per_ep: list[dict] = []
    for ep, _kind, txt in eps:
        r = detect_ai_taste(txt)
        per_ep.append({
            "ep": ep, "score": r.score, "level": r.level,
            "per_kilo": round(r.a_per_kilo, 2),
            "a_count": r.a_count, "b_count": r.b_count,
            "low_confidence": r.low_confidence,
            "top_hits": [
                {"code": h.code, "label": h.label, "level": h.level,
                 "count": h.count, "sample": (h.samples[0] if h.samples else "")[:60]}
                for h in sorted(r.hits, key=lambda x: -x.count)[:3]
            ],
        })

    joined = "\n".join(t for _, _, t in eps)
    whole = detect_ai_taste(joined)
    struct = diagnose_structure(joined)

    ranked = sorted(per_ep, key=lambda x: -x["score"])
    n = max(1, min(int(max_episodes or 8), 40))
    return {
        "ok": True,
        "draft_id": draft_id, "title": title,
        "episode_count": len(eps),
        "score": whole.score, "level": whole.level,
        "per_kilo": round(whole.a_per_kilo, 2),
        "a_count": whole.a_count, "b_count": whole.b_count,
        "low_confidence": whole.low_confidence,
        "worst": ranked[:5],
        "episodes": per_ep[:n],
        "truncated": len(per_ep) > n,
        "struct_issues": [
            {"code": i.get("code"), "label": i.get("label"),
             "message": (i.get("message") or "")[:120],
             "where": i.get("where"), "level": i.get("level")}
            for i in (struct.issues or [])[:20]
        ],
        "struct_stats": {"paragraph_count": getattr(struct, "paragraph_count", None),
                         "avg_para_len": getattr(struct, "avg_para_len", None),
                         "cv_para_len": getattr(struct, "cv_para_len", None)},
        "c_exempt": whole.c_exempt[:10],
        "note": "score 为相对指标（同一文本改前/改后对比），不代表任何检测平台的通过率，"
                "也不是'AI 生成概率'。C 级（c_exempt）是'看着像 AI 味但经验上不成立'的"
                "写法，**引擎刻意不动它们**——不要建议用户去改这些。",
    }


# ---------------------------------------------------------------------------
# 修复类工具（规则优先，零成本或低成本）
# ---------------------------------------------------------------------------

#: 文风修复规则（原片段 → 改后）。与 chinese_style 的检测规则对应。
_STYLE_FIXES: list[tuple[str, str]] = [
    ("。与此同时，", "。另一头，"),
    ("，与此同时，", "，另一头，"),
    ("与此同时，", "另一头，"),
    ("与此同时,", "另一头，"),
    ("充满了", "全都是"),
    ("这是一个关于", "说的是"),
    ("的旅程", "的经历"),
    ("值得注意的是，", "更麻烦的是，"),
    ("在某种程度上，", "多少"),
    ("这不仅仅是", "这不只是"),
    ("令人惊叹", "叫人吃惊"),
    ("彰显了", "显出了"),
    # 欧美剧结构术语 → 中文短剧说法（与 chinese_style.WESTERN_TERMS 对应）
    ("人物弧光", "人物转变"),
    ("的弧光", "的转变"),
    ("救猫咪", "开场钩子"),
    ("B故事线", "副线"),
    ("节拍表", "剧情节点"),
    ("叙事弧", "主线走向"),
]


def _apply_style_fixes(text: str) -> tuple[str, list[dict]]:
    """对一段文本应用文风修复，返回 (新文本, 改动列表)。"""
    changes: list[dict] = []
    if not isinstance(text, str) or not text:
        return text, changes
    out = text
    for old, new in _STYLE_FIXES:
        if old in out:
            out = out.replace(old, new)
            changes.append({"before": old, "after": new})
    return out, changes


@tool(
    name="fix_style_issues", label="自动修复文风问题",
    desc="按规则修掉翻译腔与套话（'与此同时'→'另一头'等）。**零 LLM 成本**。"
         "修完会**自动重新检查**并把前后 error 数一起返回——你据此判断是否还需要再修。"
         "注意：只修规则能判定的；英文残留和欧美术语需要你另外处理。",
    params={"draft_id": "草稿 id", "target": "outline=只修大纲(默认) | chapters=只修正文 | all=都修"},
    writes=True, zero_cost=True,
)
async def t_fix_style_issues(draft_id: int, target: str = "outline") -> dict:
    # 修前基线
    before = await t_check_style(draft_id=draft_id, target=target)
    all_changes: list[dict] = []

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        outline = dict(d.outline or {})
        chs = []
        if target in ("chapters", "all"):
            chs = (await s.execute(select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id))).scalars().all()
            ch_snapshot = [(c.id, c.chapter_order, c.full_text or "") for c in chs]

    # 修大纲
    if target in ("outline", "all"):
        def _fix_ep(ep: dict, order) -> None:
            for f in ("title", "synopsis", "core_push", "stakes", "escalation",
                      "audience_knows_delta"):
                if isinstance(ep.get(f), str):
                    new, ch = _apply_style_fixes(ep[f])
                    if ch:
                        all_changes.append({"where": f"第{order}集.{f}", "changes": ch})
                        ep[f] = new
            for k in ("plant", "payoff", "forbidden", "must_have"):
                if isinstance(ep.get(k), list):
                    newlist = []
                    for x in ep[k]:
                        nx, ch = _apply_style_fixes(x)
                        if ch:
                            all_changes.append({"where": f"第{order}集.{k}", "changes": ch})
                        newlist.append(nx)
                    ep[k] = newlist
            for f in ("hook_in", "hook_out", "value_shift"):
                if isinstance(ep.get(f), dict):
                    ep[f] = {kk: (_apply_style_fixes(vv)[0] if isinstance(vv, str) else vv)
                             for kk, vv in ep[f].items()}

        for ep in (outline.get("chapters") or []):
            _fix_ep(ep, ep.get("order"))
        for f in ("title", "synopsis"):
            if isinstance(outline.get(f), str):
                nx, ch = _apply_style_fixes(outline[f])
                if ch:
                    all_changes.append({"where": f"全剧.{f}", "changes": ch})
                    outline[f] = nx
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            d.outline = outline
            flag_modified(d, "outline")
            await s.flush()

    # 修正文
    if target in ("chapters", "all"):
        for cid, order, text in ch_snapshot:
            new, ch = _apply_style_fixes(text)
            if ch:
                all_changes.append({"where": f"第{order}集正文", "changes": ch})
                async with session_scope() as s:
                    row = await s.get(ScriptChapter, cid)
                    row.full_text = new
                    await s.flush()

    # 修后复检（自证）
    after = await t_check_style(draft_id=draft_id, target=target)
    return {
        "ok": True,
        "fixed_count": len(all_changes),
        "error_before": before.get("error_count", 0),
        "error_after": after.get("error_count", 0),
        "warn_before": before.get("warn_count", 0),
        "warn_after": after.get("warn_count", 0),
        "changes": all_changes[:30],
        "remaining_issues": after.get("issues", [])[:15],
        "note": ("error 数没有下降就说明还有别的问题，看看 remaining_issues。"
                 "英文残留与欧美术语本工具不处理，需要你直接改文本。"),
    }


@tool(
    name="set_draft_settings", label="改草稿设定",
    desc="改集数、每集目标字数、标题。用户说'改成 60 集''每集 1200 字'时用它。"
         "注意：这只改设定，不会重新生成已有内容。",
    params={"draft_id": "草稿 id", "episode_count": "集数(可选)",
            "word_target": "每集目标字数(可选)", "title": "标题(可选)"},
    writes=True, zero_cost=True,
)
async def t_set_draft_settings(draft_id: int, episode_count: int | None = None,
                               word_target: int | None = None,
                               title: str | None = None) -> dict:
    changed: dict[str, Any] = {}
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        if episode_count is not None and int(episode_count) > 0:
            changed["episode_count"] = {"before": d.episode_count, "after": int(episode_count)}
            d.episode_count = int(episode_count)
        if word_target is not None and int(word_target) > 0:
            changed["word_target"] = {"before": d.chapter_word_target, "after": int(word_target)}
            d.chapter_word_target = int(word_target)
        if title and str(title).strip():
            changed["title"] = {"before": d.title, "after": str(title).strip()}
            d.title = str(title).strip()
        await s.flush()
    return {"ok": True, "changed": changed,
            "note": "设定已更新。这只影响后续生成，已有内容不变。"}


@tool(
    name="create_draft", label="创建草稿",
    desc="新建一部剧的草稿。当用户提出创作需求但当前没有草稿时调用。"
         "标题可由你根据用户需求生成（不超过 20 字）。",
    params={"title": "剧名", "user_input": "用户的完整需求描述（原话，不要改写）",
            "episode_count": "集数，默认 50", "word_target": "每集字数，默认 900"},
    writes=True, zero_cost=True,
    hidden_params=("user_id",),
)
async def t_create_draft(user_id: int, title: str, user_input: str,
                         episode_count: int = 50, word_target: int = DEFAULT_CHAPTER_WORD_TARGET) -> dict:
    async with session_scope() as s:
        d = ScriptDraft(
            session_id="", user_id=user_id,
            title=(title or "新剧").strip()[:60],
            user_input=user_input or "",
            model_provider=None,        # 留给用户/上层决定，不写死
            chapter_word_target=int(word_target),
            episode_count=int(episode_count),
            status="draft", outline={},
        )
        s.add(d)
        await s.flush()
        await s.refresh(d)
        return {"ok": True, "draft_id": d.id, "title": d.title,
                "episode_count": d.episode_count, "word_target": d.chapter_word_target}


@tool(
    name="patch_outline_episode", label="改某一集的大纲字段",
    desc="精确修改某一集的某个字段（概要/核心推进点/标题/失败代价/结尾卡点等）。"
         "**当你发现某处文本需要改成具体内容时用它，不要只在回复里写'已改'**。"
         "改完会自动重新跑结构检查与文风检查，把前后数字一起返回。",
    params={"draft_id": "草稿 id", "order": "集号",
            "field": "字段名: title|synopsis|core_push|stakes|escalation|"
                     "audience_knows_delta|hook_out.leads_to|hook_out.type|"
                     "value_shift.from|value_shift.to",
            "new_value": "改成什么（完整的新文本）"},
    writes=True, zero_cost=True,
)
async def t_patch_outline_episode(draft_id: int, order: int, field: str,
                                  new_value: str) -> dict:
    order = int(order)
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        outline = dict(d.outline or {})

    ep = next((e for e in (outline.get("chapters") or [])
               if e.get("order") == order), None)
    if ep is None:
        return {"ok": False, "error": f"第{order}集不在大纲里"}

    # 支持 "hook_out.leads_to" 这种嵌套路径
    parts = str(field).split(".")
    node = ep
    for p in parts[:-1]:
        if not isinstance(node.get(p), dict):
            node[p] = {}
        node = node[p]
    before = node.get(parts[-1], "")
    if not isinstance(before, str):
        before = str(before or "")
    # 防呆：新旧完全相同就没必要写
    if before == new_value:
        return {"ok": True, "changed": False, "before": before, "after": new_value,
                "note": "新值与现值相同，未做修改"}
    node[parts[-1]] = str(new_value)

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        d.outline = outline
        flag_modified(d, "outline")
        await s.flush()

    # 自证：改完复检
    st = await t_check_structure(draft_id=draft_id)
    sty = await t_check_style(draft_id=draft_id, target="outline")
    return {
        "ok": True, "changed": True,
        "where": f"第{order}集·{field}",
        "before": before, "after": str(new_value),
        "structure_error": st.get("error_count"), "style_error": sty.get("error_count"),
        "note": "已写入数据库并复检。请用下面的结构诚实汇报：before→after。",
    }


@tool(
    name="patch_promise_payoff", label="补一条伏笔回收",
    desc="给某一集补上'回收第N集伏笔'的条目。当结构检查报'伏笔埋了没收'时用它。"
         "payoff_line 要写成'回收第N集提到的XXX，…'，其中 N 必须是该伏笔**真实埋设的集号**。",
    params={"draft_id": "草稿 id", "order": "在哪一集回收(集号)",
            "payoff_line": "回收条目文本，形如'回收第1集提到的养母重病欠费单，…'"},
    writes=True, zero_cost=True,
)
async def t_patch_promise_payoff(draft_id: int, order: int, payoff_line: str) -> dict:
    order = int(order)
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        outline = dict(d.outline or {})
    ep = next((e for e in (outline.get("chapters") or [])
               if e.get("order") == order), None)
    if ep is None:
        return {"ok": False, "error": f"第{order}集不在大纲里"}
    before_n = len(ep.get("payoff") or [])
    ep.setdefault("payoff", [])
    if payoff_line not in ep["payoff"]:
        ep["payoff"].append(str(payoff_line))
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        d.outline = outline
        flag_modified(d, "outline")
        await s.flush()
    st = await t_check_structure(draft_id=draft_id)
    return {"ok": True, "where": f"第{order}集·payoff",
            "payoff_count": f"{before_n} → {len(ep['payoff'])}",
            "structure_error": st.get("error_count"),
            "note": "已写入并复检。如果 structure_error 没下降，说明这条没对上任何未回收伏笔。"}


@tool(
    name="start_generation", label="启动整本生成（长任务）",
    desc="**真正开始生成内容**——大纲/正文/剧本/小说/推文。创建草稿或改完设定后,"
         "用户说'开始写''生成吧'时调用这个,而不是只口头说'已经开始了'。\n"
         "这是**长任务**：立即返回作业 id，你要如实告诉用户'已在后台开始、可关页面、"
         "进度看作业列表'，**不要**说'已经写完了'——它不可能几秒跑完几十集。\n"
         "顺序有依赖：没有大纲不能生成正文，没有正文/大纲不能生成剧本。\n"
         "一次别铺太满：默认只生成前若干集，让用户先看效果再续,避免几十集跑完发现方向不对。",
    params={"kind": "generation=大纲(需先有) | chapters=正文 | storyboards=剧本(分镜) | "
                  "novel=小说 | tweet=推文",
            "draft_id": "**通常不用传**。不传时系统自己找一部（找不到就建一部），"
                        "并在会话里记下来。只有用户明确说'写到那部剧里'时才显式传。",
            "guidance": "用户这次补的写作要求**原话**(可选)：'不要旁白''对白多一点'"
                        "'节奏快一点'之类。原样填入，不要你自己总结或润色。"
                        "会逐集注入生成 prompt，是用户唯一能让模型「照我说的写」的"
                        "通道。用户没提就留空",
            "start": "从第几集开始(可选,默认从第 1 集 / 大纲则不限)",
            "end": "到第几集(可选,默认到最后一集)",
            "limit": "本次最多生成几集(可选,默认 10; 用户明确要求整本时用 9999)"},
    writes=True, zero_cost=True,
    hidden_params=("user_id", "conversation_id", "mode"),
)
async def t_start_generation(user_id: int, kind: str, draft_id: int | None = None,
                             start: int = 0, end: int = 0, limit: int = 10,
                             guidance: str = "",
                             conversation_id: int | None = None,
                             mode: str | None = None) -> dict:
    """把生成任务交给持久化队列，立即返回。

    draft_id 缺省时**不再报错**，而是走 `_resolve_draft` 自动找/建一部草稿
    （用户反馈「显示没有选定草稿」的修复点：用户不想知道草稿存在）。

    guidance 是用户这次的临时写作要求，透传进 payload，由 `_handle_gen_chapters`
    逐集注入 prompt。以前生成路径**没有**这条通道，用户在对话里补的要求一个字
    也进不去，模型只能照大纲硬写 —— 这就是"AI 感很重、细节僵硬"的结构性原因。
    """
    from . import chat_jobs, jobs

    kind = str(kind or "").strip().lower()
    resolved_note = ""
    if not draft_id:
        draft_id, meta = await _resolve_draft(user_id, None, conversation_id)
        if not draft_id:
            return {"ok": False,
                    "error": "没能准备出可写的草稿。请让用户贴一份集纲，或先 create_draft。"}
        if meta.get("created"):
            resolved_note = (f"（自动准备了草稿 #{draft_id}：{meta.get('how')}"
                             + (f"，含 {meta.get('imported_episodes')} 集大纲"
                                if meta.get("imported_episodes") else "")
                             + "。**汇报时不必向用户强调'草稿'这个词** —— "
                               "他要的是'已经在写了'，不是多一个要管理的对象。）")

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        if d.user_id and d.user_id != user_id:
            return {"ok": False, "error": f"草稿 {draft_id} 不属于当前用户"}
        outline = dict(d.outline or {})
        provider = d.model_provider or "gemini"
        episode_count = int(d.episode_count or 0) or 50
        title = d.title

    eps = sorted(outline.get("chapters") or [], key=lambda e: e.get("order", 0))

    # 依赖前置校验：这几条不查就是"入队后立刻失败"，用户等半天只等到一句报错。
    if kind in ("chapters", "storyboards", "novel", "tweet") and not eps:
        return {"ok": False,
                "error": f"还没有大纲，不能生成{kind}。先 start_generation(kind='generation')。"}
    if kind in ("novel", "tweet"):
        async with session_scope() as s:
            done_ch = (await s.execute(select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id))).scalars().all()
        if not [c for c in done_ch if (c.full_text or "").strip()]:
            return {"ok": False, "error": "还没有正文，不能改编。先 start_generation(kind='chapters')。"}

    payload: dict[str, Any] = {}
    if kind in ("generation", "outline"):
        payload = {"mode": "preview" if not eps else "expand",
                   "chapter_count": episode_count, "expand_after_preview": True}
        kind = "gen_outline"
    elif kind in ("chapters", "chapter", "正文"):
        kind = "gen_chapters"
    elif kind in ("storyboards", "storyboard", "剧本", "分镜"):
        kind = "gen_storyboards"
    elif kind in ("novel", "tweet"):
        payload = {"kind": kind}
        kind = "adapt_products"
    else:
        return {"ok": False, "error": f"不认识的生成类型: {kind}"}

    # 集范围：默认收敛到 limit 集，避免一次铺几十集的 LLM 开销
    if kind in ("gen_chapters", "gen_storyboards") and eps:
        all_orders = [int(e.get("order") or 0) for e in eps]
        explicit = bool(start or end)      # 用户/调用方点名了范围
        lo = int(start or 0) or min(all_orders)
        hi = int(end or 0) or max(all_orders)
        cap = max(1, int(limit or 10))
        if hi - lo + 1 > cap:
            hi = lo + cap - 1      # 只做前 cap 集，剩下的等用户确认
        payload["start"], payload["end"] = lo, hi

        # ⚠️ 入队前**必须**先数一遍到底有没有活可干（2026-10-08 用户甲事故）。
        #
        # 导入的草稿每一集都已经有正文，窗口 1~10 全是完成的集 → handler 的 todo
        # 为空 → 作业毫秒级空转结束，result 是 `generated: 0, skipped: 61`。
        # 但入队这条路**没人检查过空待办**，于是返回给模型的是"已启动（作业 #66）"，
        # 模型只能照着报喜："已对《…》启动生成正文"。用户白等，还去问"生成好了吗"。
        #
        # 三件事，缺一不可：
        #   · 空待办 → **如实拒绝入队**，并且明确禁止模型说"已启动"；
        #   · 窗口内前几集已完成 → 把窗口挪到第一集待做的，别让作业白"跳过"一遍；
        #   · 窗口内全空但整本还有活 → 挪到那一集重新开窗（仅当没点名范围时）。
        pc = await chat_jobs.pending_counts(draft_id, kind, lo, hi)
        what = "正文" if kind == "gen_chapters" else "剧本"
        # ⚠️ 挪窗口时 end **必须夹在真实集号上限内**。
        #   写 `first + cap - 1` 不夹的话，5 集的草稿会算出「第2~11集」这种
        #   根本不存在的范围（2026-10-08 自测当场打出来），用户看到会以为
        #   这剧有 11 集。
        top = max(all_orders)
        if pc["pending"] == 0:
            whole = await chat_jobs.pending_counts(draft_id, kind, 0, 0)
            if whole["pending"] == 0:
                return {
                    "ok": False,
                    "error": f"这部剧 {whole['scope_total']} 集**都已经有{what}了**，"
                             f"没有可以生成的部分，所以**没有启动任何任务**。",
                    "hint": "**务必如实告诉用户「没有启动」**，不要说「已启动」。"
                            "他要是想全部重做，用「强制重写」；只想重做某几集，"
                            "让他圈定范围或直接说「重写第3集」。",
                }
            if explicit:
                return {
                    "ok": False,
                    "error": f"你指定的第{lo}~{hi}集都已经有{what}了，"
                             f"这一段没有可以生成的部分，**没有启动任何任务**。",
                    "hint": f"整本还有 {whole['pending']} 集没做，第一集是"
                            f"第{whole['first_pending']}集。**不要说「已启动」**；"
                            f"先把这件事告诉用户，问他要不要改做那些集。",
                }
            # 没点名范围：把窗口挪到第一集真正待做的
            first = whole["first_pending"]
            payload["start"], payload["end"] = first, min(first + cap - 1, top)
        elif not explicit and pc["first_pending"] > lo:
            # 窗口内前面几集已完成：从第一集待做的开始，免得作业把已完成的集
            # 再"跳过"一遍、进度条看着像卡住。
            first = pc["first_pending"]
            payload["start"], payload["end"] = first, min(first + cap - 1, top)

    # 用户这次的临时写作要求 + 会话模式的写法约定 —— 只有正文/剧本吃得到
    # （大纲不写正文）。合并规则与动作栏那条路**同一份**（chat_jobs._compose_guidance）：
    # 模式只是参考，冲突时用户原话为准。分头合并 = 两条路迟早给出不同写法。
    # 限长 4000 字：够放几十条要求，又不至于把作业 payload 撑成一篇小说。
    from .chat_jobs import _compose_guidance
    from .chat_modes import get_mode_generation_note
    g = _compose_guidance(get_mode_generation_note(mode), str(guidance or ""))
    if g and kind in ("gen_chapters", "gen_storyboards"):
        payload["guidance"] = g[:4000]

    active = await chat_jobs.has_active_job(draft_id)
    if active:
        return {"ok": False,
                "error": f"这部剧已有任务在跑（{active}），同时跑会互相覆盖。"
                         "等它完成或先取消它。"}

    job_id = await jobs.enqueue(kind=kind, draft_id=draft_id, user_id=user_id,
                                payload=payload)
    span = ""
    if payload.get("start"):
        span = f"，范围 第{payload['start']}~{payload['end']}集"
    return {
        "ok": True, "job_id": job_id, "kind": kind, "draft_id": draft_id,
        "title": title, "span": span, "provider": provider,
        "guidance_applied": bool(payload.get("guidance")),
        "note": f"已在后台启动（作业 #{job_id}{span}）。这是长任务，不会立刻完成。"
                f"请如实告诉用户：已经开始、可以关页面、进度用 get_job_status 查。"
                f"**不要**说已写完。"
                + ("已把你补的写作要求带进去了，会逐集生效。"
                   if payload.get("guidance") else "")
                + resolved_note,
        "how_to_report": "进度查询：get_job_status(job_id)。用户要看结果时用它。",
    }


@tool(
    name="save_chapter_text", label="把写好的正文存进某一集",
    desc="**你自己在对话里写好了某一集正文时，用它存进草稿**——否则用户只看到聊天里"
         "一段字，草稿页那一集还是空的，关掉页面就没了。\n"
         "用户要求'写第3集''把 3~5 集写出来''这几集重写一下'这类**小范围(通常≤3集)**"
         "的活儿时，正确的做法是：**你直接在回复里把正文写出来**（用户要的是立刻看到字），"
         "写完对每一集调一次本工具落库。\n"
         "反过来，**整本/大范围**(十几集以上)才用 `start_generation` 交后台跑——"
         "那种量你一个回合写不完，硬写只会又慢又碎。\n"
         "本工具只负责存，不负责写；正文内容必须由你在 text 里给出，且要完整（别写'……'省略）。",
    params={"draft_id": "**通常不用传**。不传时系统自己找一部（找不到就建一部）。",
            "order": "存到第几集",
            "text": "这一集的正文全文（完整内容，不要省略号）",
            "title": "这一集的标题(可选,默认沿用大纲里的标题)"},
    writes=True, zero_cost=True,
    hidden_params=("user_id", "conversation_id"),
)
async def t_save_chapter_text(user_id: int, order: int, text: str,
                              draft_id: int | None = None,
                              title: str = "",
                              conversation_id: int | None = None) -> dict:
    """把模型在聊天里写好的正文落进 ScriptChapter。

    为什么要单独有这个工具：`start_generation` 是**入队**——用户在聊天里说
    "把第3集写出来"，如果只能走它，用户等来的是一个作业号而不是那几个字，
    想看内容还得去草稿页等后台跑完。小范围的场景下这比直接写出来**又慢又绕**。
    但模型写出来的字如果不能落库，就只是聊天记录，刷新即失。
    两者配对使用才是完整的：小范围 → 直接写 + 本工具落库；大范围 → 入队。

    draft_id 缺省时同样走 `_resolve_draft`：用户在无草稿对话里说"写第3集正文"，
    工具必须自己把草稿备好，而不是回一句"没有指定草稿，无法保存"。
    """
    from ..stages.import_script import sanitize_text

    order = int(order)
    body = sanitize_text(str(text or ""))
    if not body.strip():
        return {"ok": False, "error": "text 是空的，没有内容可存。"}
    if not draft_id:
        draft_id, _meta = await _resolve_draft(user_id, None, conversation_id)
        if not draft_id:
            return {"ok": False,
                    "error": "没能准备出可写的草稿，正文暂时存不下。"
                             "请让用户先把集纲贴进来（import_outline）。"}

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        if d.user_id and d.user_id != user_id:
            return {"ok": False, "error": f"草稿 {draft_id} 不属于当前用户"}
        outline = dict(d.outline or {})

        ep = next((e for e in (outline.get("chapters") or [])
                   if int(e.get("order") or 0) == order), None)
        if ep is None:
            return {"ok": False,
                    "error": f"第{order}集不在大纲里。先确认集号，或先用 import_outline "
                             f"把大纲铺好再写正文。"}

        row = (await s.execute(select(ScriptChapter).where(
            ScriptChapter.draft_id == draft_id,
            ScriptChapter.chapter_order == order))).scalar_one_or_none()
        replaced = bool(row is not None and (row.full_text or "").strip())
        if row is None:
            row = ScriptChapter(draft_id=draft_id, chapter_order=order)
            s.add(row)
        else:
            # 版本号自增，和前端的"第N版可回滚"口径保持一致
            row.version = int(row.version or 1) + 1
        row.title = title or ep.get("title") or f"第{order}集"
        row.full_text = body
        row.word_count = len(body)
        row.summary = ""     # 摘要留给下一次批量生成时补；这里不额外花一次 LLM 调用
        row.is_stale = 0
        # 正文换了，下游剧本就过期了——这是 is_stale 的设计语义（见 operations.py 的用法）
        await s.execute(
            ScriptStoryboard.__table__.update()
            .where(ScriptStoryboard.draft_id == draft_id,
                   ScriptStoryboard.chapter_order == order)
            .values(is_stale=1))
        await s.flush()

    return {
        "ok": True, "order": order, "words": len(body),
        "replaced": replaced,
        "where": f"第{order}集·正文",
        "note": ("已存入草稿正文栏，用户刷新草稿页即可看到这一集的完整正文。"
                 + ("（这一集原有正文已被覆盖，旧版本可在草稿页回滚。）" if replaced else "")),
    }


async def _bind_conversation(conversation_id: int | None, draft_id: int) -> None:
    """把新草稿绑回会话，使下次调用命中「会话已关联」而不是再新建一部。

    只写 draft_id 一个字段：会话的标题/模式/provider 都不该被这里覆盖。
    失败不抛——绑定只是省事的缓存，绑不上最多下次再解析一遍会话原文。
    """
    if not conversation_id:
        return
    try:
        from ..db import AgentConversation
        async with session_scope() as s:
            await s.execute(update(AgentConversation)
                            .where(AgentConversation.id == int(conversation_id))
                            .values(draft_id=int(draft_id)))
    except Exception as e:  # noqa: BLE001
        logger.warning("绑定会话 %s → 草稿 %s 失败: %s", conversation_id, draft_id, e)


async def _resolve_draft(user_id: int, draft_id: int | None,
                         conversation_id: int | None = None,
                         user_role: str | None = None) -> tuple[int | None, dict]:
    """拿到一部可写的草稿；没有就**建一部**，而不是把"没有选定草稿"甩给用户。

    为什么要这么做（2026-09 用户反馈，原话）：
      「我想像之前一样，不涉及草稿，直接在对话里加入 60 集的剧情细纲和前六集正文…
        但每次到生成正文的时候，他就会自动转进草稿，然后显示没有选定草稿」
    用户根本不想知道"草稿"这个东西存在。他要的是"贴进去、说开始写、看着字出来"。
    但在当前架构里，生成 / 落库 / 精修三条路全部挂在 draft_id 上，谁也绕不开草稿。
    既然绕不开，就**别让用户看见它**：工具层自己找一部、建一部，把 id 悄悄补上。

    解析顺序（每一步都记在返回的 note 里，好让模型如实转述）：
      1. 调用方显式给了 draft_id 且属于本用户            → 用它
      2. 会话已经绑了一部草稿                            → 用它（最多用户预期）
      3. 会话原文里能认出分集集纲                        → 建草稿并把大纲落进去
      4. 以上都没有                                      → 建一部空草稿（只用到会话原文件当题材）

    返回 (draft_id | None, meta)。meta 里 created=True 表示这次是新建的，
    imported_episodes 是自动落进去的集数（0 表示没认出大纲）。
    """
    from ..db import AgentConversation
    from ..stages.import_script import sanitize_text

    # 1) 显式指定
    # ⚠️ 2026-10-25: 管理员放行（与 stages/access.check_draft_access 同一判据）。
    # 原先只比较 user_id，管理员在别人的草稿里让 Agent 写东西会被静默建一部**新草稿**，
    # 而不是写进他正看着的那部。
    if draft_id:
        async with session_scope() as s:
            d = await s.get(ScriptDraft, int(draft_id))
            if d and (not d.user_id or d.user_id == user_id or is_admin_role(user_role)):
                return int(draft_id), {"created": False, "how": "显式指定"}

    # 2) 会话已绑定的草稿
    conv_text = ""
    if conversation_id:
        async with session_scope() as s:
            conv = await s.get(AgentConversation, int(conversation_id))
            if conv and conv.user_id == user_id and conv.draft_id:
                d = await s.get(ScriptDraft, conv.draft_id)
                # ⚠️ 2026-10-25: 管理员同样放行。漏了这里的后果比上面更隐蔽 ——
                # 管理员在别人草稿的会话里说"写第 35 集"，第 1/2 步都放空，
                # 直接落到第 4 步**新建一部空草稿**：字写进了新草稿，他正看着的
                # 那部一动不动。用户看到的是"生成了但页面没变"。
                if d and (not d.user_id or d.user_id == user_id
                          or is_admin_role(user_role)):
                    return int(conv.draft_id), {"created": False, "how": "会话已关联"}
        conv_text = await _latest_user_text(int(conversation_id)) or ""

    # 3) 会话原文里认得出分集集纲 → 建草稿并把大纲落进去
    #    ⚠️ 复用 t_import_outline 而不是自己再写一份解析+落库：那条路已经把
    #    「合并集（第41-43集）调 AI 拆」「空集报错」「outline 整树重写 +
    #    flag_modified」这些坑趟平了。这里重复实现 = 迟早和导入路径漂移。
    if conv_text.strip():
        res = await t_import_outline(
            user_id=user_id, source_text=conv_text, title="", mode="new",
            provider="gemini", conversation_id=conversation_id)
        if res.get("ok") and res.get("draft_id"):
            new_id = int(res["draft_id"])
            await _bind_conversation(conversation_id, new_id)
            return new_id, {"created": True, "how": "从会话原文自动导入集纲",
                            "imported_episodes": int(res.get("episodes_imported") or 0),
                            "title": res.get("title") or ""}

    # 4) 连集纲都认不出 → 建一部空草稿，至少让生成能启动
    title = (_guess_title(conv_text) or "对话新建的剧")[:60] if conv_text else "对话新建的剧"
    async with session_scope() as s:
        d = ScriptDraft(
            session_id="", user_id=user_id,
            title=sanitize_text(title),
            user_input=sanitize_text((conv_text or "")[:20000]),
            model_provider="gemini",
            chapter_word_target=1000,
            episode_count=50,
            status="draft",
            outline={},
        )
        s.add(d)
        await s.flush()
        await s.refresh(d)
        new_id = int(d.id)
    await _bind_conversation(conversation_id, new_id)
    return new_id, {"created": True, "how": "新建空草稿", "imported_episodes": 0,
                    "title": title}


@tool(
    name="start_from_conversation", label="从这段对话直接开写（自动建草稿）",
    desc="**用户不想管草稿、只想'贴进来就开始写'时，用这个。**\n"
         "用户在对话里贴了集纲/正文，接着说'开始写''按这个写''生成前几集'——"
         "正确做法是调本工具一次，它会把该做的都做掉：\n"
         "  1. 找到或**自动新建**一部草稿（用户不需要知道草稿存在）\n"
         "  2. 会话原文里如果认得出分集集纲，自动导入大纲\n"
         "  3. 按你要的 kind 直接启动生成（正文/剧本/大纲）\n"
         "⛔ **不要再让用户「先选一部草稿」** —— 那是旧行为，用户明确反馈过这是在折腾他。\n"
         "⛔ 也不要先 create_draft 再 start_generation 两步走：本工具一步到位，"
         "而且会把用户补的那几句要求（guidance）一起带上。\n"
         "⚠️ guidance 是**用户原话**，不是你的转述或总结。用户说'不要旁白''对白多一点'"
         "就原样填进去；没有就留空，别自己编。",
    params={"kind": "要生成什么: outline=大纲 | chapters=正文 | storyboards=剧本(分镜)",
            "guidance": "用户这次补的写作要求**原话**(可选)。会逐集注入生成 prompt。"
                        "留空则只按大纲写",
            "start": "从第几集开始(可选)",
            "end": "到第几集(可选)",
            "limit": "本次最多几集(可选,默认 10；用户明确要整本用 9999)"},
    writes=True, zero_cost=True,
    hidden_params=("user_id", "conversation_id", "mode"),
)
async def t_start_from_conversation(user_id: int, kind: str = "chapters",
                                    guidance: str = "",
                                    start: int = 0, end: int = 0,
                                    limit: int = 10,
                                    conversation_id: int | None = None,
                                    mode: str | None = None) -> dict:
    """对话 → 草稿 → 生成，一步到位。"""
    kind_l = str(kind or "chapters").strip().lower()
    # 不自己解析草稿 —— t_start_generation 缺 draft_id 时会走 _resolve_draft，
    # 逻辑只有一处，避免"工具层建了一部、生成层又建一部"的漂移。
    return await t_start_generation(
        user_id=user_id, kind=kind_l, draft_id=None,
        start=int(start or 0), end=int(end or 0), limit=int(limit or 10),
        guidance=guidance, conversation_id=conversation_id, mode=mode)


@tool(
    name="get_job_status", label="查长任务进度",
    desc="查一个后台作业跑到哪了（进度百分比、当前在做什么、结果是成功还是失败）。"
         "用户问'写完了吗''进度如何'时用它，不要凭印象回答。",
    params={"job_id": "作业 id（start_generation / start_rewrite 返回的那个）"},
    hidden_params=("user_id",),
)
async def t_get_job_status(user_id: int, job_id: int) -> dict:
    from ..db import AgentJob

    async with session_scope() as s:
        j = await s.get(AgentJob, int(job_id))
        if not j:
            return {"ok": False, "error": f"作业 {job_id} 不存在"}
        if j.user_id and j.user_id != user_id:
            # 不暴露"存在但不属于你"—— 与其它工具的口径一致
            return {"ok": False, "error": f"作业 {job_id} 不存在"}
        return {
            "ok": True, "job_id": j.id, "kind": j.kind, "status": j.status,
            "progress": j.progress or 0, "note": j.progress_note or "",
            "result": j.result or {}, "error": j.error or "",
            "attempt": j.attempt or 0,
            "hint": ("status=queued 表示还在排队（worker 可能忙）；"
                     "done 才是真完成；failed 看 error 字段，不要自己猜原因。"),
        }


@tool(
    name="start_rewrite", label="启动整本 AI 精修（长任务）",
    desc="对**已有内容**做整本精修：两轮同上下文重写（先通读诊断，再按诊断改写整本），"
         "覆盖人称一致/人物关系自洽/去AI味/剧情闭环四个维度，改完写回草稿。\n"
         "其中'去AI味'的处理是**先结构后词句、能删就删**——不要为了显得自然去加语气词或"
         "环境描写凑字数，那会形成新的 AI 味；也不要追任何检测平台的分数。\n"
         "用户说'精修一遍''整本润色''统一一下人称和称呼'时用它。\n"
         "是**长任务**（几十集要跑很久），立即返回作业 id。"
         "**至少要有一集正文或剧本**才有东西可修。\n"
         "⚠️ 这是**覆写**操作：会改掉草稿里的内容（每集存历史可回滚）。"
         "开场白式的空话不要调它——用户没有真的要求精修就别动。",
    params={"draft_id": "**通常不用传**。不传时系统自己找一部（找不到就建一部）。",
            "guidance": "用户的参考意见原话（可选）。比如'第3集的电话改成当面说'"
                        "'把称呼统一成陆先生'。有就填，没有留空"},
    writes=True, zero_cost=False,
    hidden_params=("user_id", "conversation_id"),
)
async def t_start_rewrite(user_id: int, draft_id: int | None = None,
                          guidance: str = "",
                          conversation_id: int | None = None) -> dict:
    from . import chat_jobs

    if not draft_id:
        # 与 start_generation 同一条口径：用户不选草稿就自己找/建，
        # 而不是把"没有指定草稿"变成他要处理的问题。
        draft_id, _meta = await _resolve_draft(user_id, None, conversation_id)
        if not draft_id:
            return {"ok": False, "error": "没能准备出可精修的草稿。"}
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        if d.user_id and d.user_id != user_id:
            return {"ok": False, "error": f"草稿 {draft_id} 不属于当前用户"}
        provider = d.model_provider or "gemini"
        title = d.title
        chs = (await s.execute(select(ScriptChapter).where(
            ScriptChapter.draft_id == draft_id))).scalars().all()
        sbs = (await s.execute(select(ScriptStoryboard).where(
            ScriptStoryboard.draft_id == draft_id))).scalars().all()

    done_ch = len([c for c in chs if (c.full_text or "").strip()])
    done_sb = len([x for x in sbs if (x.shots_json or [])])
    if not done_ch and not done_sb:
        return {"ok": False,
                "error": "这部剧还没有任何正文或剧本，没有可精修的内容。"
                         "先用 start_generation 生成。"}

    active = await chat_jobs.has_active_job(draft_id)
    if active:
        return {"ok": False, "error": f"这部剧已有任务在跑（{active}），等它完成再精修。"}

    res = await chat_jobs.start_rewrite(
        draft_id=draft_id, user_id=user_id, model=provider, guidance=guidance)
    if not res.get("ok"):
        return res
    return {
        "ok": True, "job_id": res["job_id"], "draft_id": draft_id, "title": title,
        "guidance": (guidance or "")[:200],
        "note": f"整本精修已在后台启动（作业 #{res['job_id']}）。"
                f"**这是覆写操作，会改草稿内容**（每集已存历史，可回滚）。"
                f"请如实告诉用户：已开始、耗时较长、可关页面；"
                f"完成后每集改了什么可以在草稿的『精修』里看。不要说已改完。",
    }


@tool(
    name="import_outline", label="导入集纲（把大纲落进草稿）",
    desc="把**整篇分集大纲**导入草稿，落到 outline.chapters —— 导入完之后草稿页"
         "就能看到一集一集的大纲卡片，跟用户在平台主页点『导入大纲』得到的东西完全一样。\n"
         "**用户贴了一篇集纲/大纲/分集剧情概要，说'导入''存进去''按这个写'时，必须调它。**"
         "⛔ 不要用 create_draft 代替——那个只建空壳（集数和字数设定），一集大纲都不会有，"
         "用户回草稿页看到的是空白，会以为你什么都没做。\n"
         "source_text 通常**不用传**：系统会自己从用户上一条消息里取原文，"
         "所以用户贴了几十集你也不必把内容再抄一遍——直接调用即可。\n"
         "宁可多传一点：把用户消息里凡是属于集纲的部分都算进去（标题行、说明行都无妨），"
         "解析器会自己挑出集号。\n"
         "⚠️ 导入**不等于开始写**。导入后大纲就在了，用户说'开始写'时再调 start_generation。",
    params={"source_text": "集纲原文（**留空即自动取用户上一条消息**，通常留空）",
            "title": "剧名(可选;留空则取集纲首行或当前草稿的标题)",
            "mode": "new=新建草稿(默认) | replace=整本替换当前草稿的大纲 | "
                    "append=追加到当前草稿大纲后面",
            "draft_id": "草稿 id(可省略,系统会自动带上当前草稿)",
            "provider": "用于拆解合并集(如'第41-43集：…')的模型(可选,默认 gemini)。"
                        "逐集写全的集纲用不到它"},
    writes=True, zero_cost=True,
    hidden_params=("user_id", "conversation_id"),
)
async def t_import_outline(user_id: int, source_text: str = "",
                           title: str = "", mode: str = "new",
                           draft_id: int | None = None, provider: str = "",
                           conversation_id: int | None = None) -> dict:
    """解析整篇集纲 → 写 outline.chapters。

    这条路径与主页的 /import-outline/preview + /import-outline/create 是**同一套解析器**：
      规则解析: stages/import_outline.parse_outline_text  (逐集标记, 零成本)
      AI 兜底:  仅当出现合并集(第X-Y集)时才调 _ai_split_range
      结构构建: stages/import_outline.build_outline_chapters / make_outline

    历史背景(为什么要有这个工具):
      用户曾把 60 集集纲整篇贴进对话工坊要求导入, 工坊没有这个技能, 模型只好用
      create_draft 硬凑 —— 建出来的草稿 episode_count=60、word_target=750 看着都对,
      但 outline={} 一章都没有; 紧接着用户说"开始写", start_generation 又因缺 user_id
      报错。用户贴了两遍几万字的集纲, 最后得到一部空壳剧。本工具即为此而加。
    """
    from ..stages.import_outline import (
        parse_and_split_outline, build_outline_chapters, make_outline,
        has_unsplittable_range,
    )
    from ..stages.import_script import sanitize_deep
    from ..models.catalog import sanitize_provider_spec
    from . import chat_jobs

    mode = (str(mode or "new").strip().lower() or "new")
    if mode not in ("new", "replace", "append"):
        return {"ok": False, "error": f"mode 只能是 new / replace / append，收到 {mode!r}"}

    # ---- 1) 取原文 -------------------------------------------------------
    text = str(source_text or "")
    got_from = "参数"
    if len(text.strip()) < 80 and conversation_id:
        # 模型常常只传个片段或干脆不传 —— 从会话里回读用户原话。
        # 这是本工具不需要模型重吐几十 KB 文本的关键。
        fetched = await _latest_user_text(conversation_id)
        if fetched and len(fetched) > len(text):
            text, got_from = fetched, "会话原文"
    text = str(text or "").strip()
    if not text:
        return {"ok": False,
                "error": "没有拿到集纲原文。请让用户把集纲贴进来，"
                         "或把集纲文本作为 source_text 传给我。"}

    from ..stages.import_script import sanitize_text
    text = sanitize_text(text)

    # ---- 2) 解析（规则为主, 只有合并集才调 AI）----------------------------
    need_ai = has_unsplittable_range(text)
    prov = sanitize_provider_spec(provider or None,
                                  ("gemini", "deepseek", "gpt5", "grok"), "gemini")
    episodes = await parse_and_split_outline(text, provider=prov)
    if not episodes:
        # parse_outline_text 对"一个集号都没认出来"的文本会兜底返回一个包裹整体
        # 的容器(可能被清成空列表), 所以这里正常走不到。留着是防它哪天改了行为。
        return {"ok": False,
                "error": "没能从这段文本里认出任何一集。"
                         "请让用户确认贴的是分集大纲(每集以「第3集：…」这类集号开头)，"
                         "而不是剧本正文或一段普通说明。"}

    # ---- 3) 定位目标草稿 --------------------------------------------------
    async with session_scope() as s:
        target = None
        if mode in ("replace", "append"):
            if not draft_id:
                return {"ok": False,
                        "error": f"{mode} 模式需要指定草稿，但当前没有选定的草稿。"}
            target = await s.get(ScriptDraft, draft_id)
            if not target:
                return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
            if target.user_id and target.user_id != user_id:
                return {"ok": False, "error": f"草稿 {draft_id} 不属于当前用户"}
            active = await chat_jobs.has_active_job(draft_id)
            if active:
                return {"ok": False,
                        "error": f"这部剧有任务在跑（{active}），"
                                 f"改写大纲会和它打架。等它完成再导入。"}
            existing = dict(target.outline or {})
            old_eps = existing.get("chapters") or existing.get("episodes") or []
            base = (max([int(e.get("order", 0) or 0) for e in old_eps] or [0]) + 1
                    if mode == "append" else 1)
            old_count = len(old_eps)
            final_title = (str(title).strip() or target.title or "导入的大纲")
        else:
            base = 1
            old_count = 0
            final_title = str(title).strip() or _guess_title(text) or "导入的大纲"

    # ---- 4) 构建章节 ------------------------------------------------------
    try:
        chapters = build_outline_chapters(episodes, start_order=base)
    except ValueError as e:
        return {"ok": False, "error": str(e),
                "hint": "集纲里有集号但没内容。请告诉用户是哪几集空着，让他补上。"}

    # ---- 5) 落库 ----------------------------------------------------------
    if mode == "new":
        async with session_scope() as s:
            d = ScriptDraft(
                session_id="", user_id=user_id,
                title=sanitize_text(final_title)[:60],
                user_input=sanitize_text(text[:20000]),
                model_provider=prov,
                chapter_word_target=1000,
                episode_count=len(chapters),
                status="outline_done",
                outline=sanitize_deep(make_outline(final_title, chapters)),
                outline_locked=0,
            )
            s.add(d)
            await s.flush()
            await s.refresh(d)
            new_id = d.id
        # 静默反推设定（与 replace/append 分支、以及与导入剧本那条路径同一口径）。
        # 新草稿的 world/characters 是 make_outline 给的空壳，而 chapter_gen 正是
        # 靠这两块当锚点；素材用 outline 里已有的分集梗概兜底，不额外花调用。
        try:
            from ..stages.settings_backfill import spawn_silent_backfill
            spawn_silent_backfill(new_id)
        except Exception as e:  # noqa: BLE001
            logger.warning("silent backfill 启动失败 draft %s: %s", new_id, e)
        return {
            "ok": True, "draft_id": new_id, "mode": mode,
            "title": final_title, "episodes_imported": len(chapters),
            "order_range": f"{chapters[0]['order']}-{chapters[-1]['order']}",
            "source": got_from, "ai_split_used": need_ai,
            "note": f"集纲已导入，草稿 #{new_id} 现有 {len(chapters)} 集大纲。"
                    f"**注意：只是大纲进来了，正文一集都没生成。**"
                    f"用户说'开始写'时再调 start_generation(kind='chapters')。",
        }

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        existing = dict(d.outline or {})
        if mode == "replace":
            merged = chapters
            # ⚠️ 绝不能再用 `make_outline(...)` —— 它返回的是**空壳骨架**
            # （world={} / characters=[]），会把已经反推出来的设定整块抹掉。
            #
            # 2026-10-08 实测（本函数 replace 前后对比）：
            #   调用前  world={'era':'现代都市',...} characters=2 registry=1 ledger=1
            #   调用后  world={}  characters=[]  registry=None  ledger=None
            # 用户只是想换一版集纲，结果人物表和世界观**一声不响地没了** ——
            # 而 chapter_gen 正是靠这两块当锚点，抹掉之后每章都成了"没有设定的裸写"。
            # 这正是 prod 草稿 2421 第 5~19 集整段跑偏的同款成因。
            #
            # 集纲替换只该动 chapters。其余键一律**原地保留**（与 append 同一口径）。
            outline = existing
            outline["chapters"] = merged
            if not outline.get("title"):
                outline["title"] = final_title
            # 兼容历史数据: 有些草稿只写了 episodes 键, 一并更新, 免得两个键打架
            if "episodes" in existing:
                outline["episodes"] = merged
        else:  # append
            old = list(existing.get("chapters") or existing.get("episodes") or [])
            merged = old + chapters
            outline = dict(existing)
            outline["chapters"] = merged
            if not outline.get("title"):
                outline["title"] = final_title
            # 兼容历史数据: 有些草稿只写了 episodes 键, 一并更新, 免得两个键打架
            if "episodes" in existing:
                outline["episodes"] = merged
        d.outline = sanitize_deep(outline)
        flag_modified(d, "outline")
        d.episode_count = len(merged)
        if not d.title:
            d.title = final_title
        await s.flush()
        await s.refresh(d)
        total = len(merged)

    # 静默反推设定（2026-10-08）——
    # 集纲导入后 chapters 是全新的，但 world/characters 可能仍是空的（很多草稿本来
    # 就没反推过）。不阻塞、不建作业、失败只记日志，与导入剧本那条路径同一口径。
    # 放在这里而不是更早，是因为本函数 `new` 分支已经 return 走了，只有
    # replace / append 会落到这 —— 那两种模式下草稿都有素材可供反推。
    try:
        from ..stages.settings_backfill import spawn_silent_backfill
        spawn_silent_backfill(draft_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("silent backfill 启动失败 draft %s: %s", draft_id, e)

    return {
        "ok": True, "draft_id": draft_id, "mode": mode,
        "title": final_title, "episodes_imported": len(chapters),
        "episodes_total": total, "episodes_before": old_count,
        "order_range": f"{chapters[0]['order']}-{chapters[-1]['order']}",
        "source": got_from, "ai_split_used": need_ai,
        "note": (f"大纲已{'整本替换' if mode == 'replace' else '追加'}，"
                 f"草稿 #{draft_id} 现有 {total} 集大纲"
                 + (f"（原有内容里的正文/剧本未动）" if mode == "replace" else "")
                 + f"。**正文没有生成。**"),
    }


@tool(
    name="import_script", label="导入剧本正文（把原文落进草稿）",
    desc="把**已经写好的剧本正文**（不是大纲）导入草稿：按集号把原文切成章节正文，"
         "存成草稿的「原文」（script_chapters），用户随后可在草稿页逐集查看/生成剧本。\n"
         "切分**纯规则、不花 AI**：靠「第N集/章/话/回」「===」分隔线、或每 5000 字兜底。"
         "`extract_outline=true` 时额外用 AI 从正文里提炼一份大纲（草稿页要用，建议开着）。\n"
         "⛔ 适用判据：用户贴的是**剧本正文**（有场景、台词、动作），不是分集大纲。"
         "若贴的是分集大纲，请改用 `import_outline`。\n"
         "📍 **用户说「导入前六集」「导入第 10~15 集」这类范围时，用 `start` 指定落点**："
         "正文自带的是它自己的集号，不是草稿里的位置。不传 start 就默认从第 1 集起排。\n"
         "⚠️ 导入只把原文存进草稿，**不会自动开写剧本**。用户要写的话另说。",
    params={"source_text": "剧本正文全文。通常**不用传**：系统会自己从用户上一条消息里取原文。",
            "title": "剧名。不传则取正文首行。",
            "mode": "new=新建草稿 | replace=替换指定区间的正文(默认覆盖整本) | "
                    "append=追加到当前草稿末尾。**用户说「导入到这部剧」时不要用 new** —— "
                    "那会另建一部新剧，用户当前的剧一个字都不会变",
            "draft_id": "mode 为 replace/append 时必填",
            "start": "这次导入的第一集落在草稿的第几集。用户说「导入前六集」就是 1；"
                     "说「把第10~15集补上」就是 10。为 0/不传 = 从第 1 集起（append 则接在末尾）",
            "end": "落点的最后一集（可选）。只在 replace 里有意义：用来界定"
                   "「只覆盖第 start~end 集，区间外保持不动」。不传则 replace 作用于从 start 起的全部",
            "confirm": "replace 要覆盖已有正文时**必须**显式传 true。"
                       "先向用户确认「会覆盖第 X~Y 集已有正文」，得到同意再传 true",
            "extract_outline": "是否用 AI 从正文提炼大纲，默认 true（草稿页需要大纲才有集卡）",
            "provider": "提炼大纲用的模型提供方"},
    writes=True, zero_cost=False,
    hidden_params=("user_id", "conversation_id"),
)
async def t_import_script(user_id: int, source_text: str = "",
                          title: str = "", mode: str = "new",
                          draft_id: int | None = None,
                          start: int = 0, end: int = 0, confirm: bool = False,
                          extract_outline: bool = True,
                          provider: str = "", conversation_id: int | None = None) -> dict:
    """把已写好的剧本正文切成章节、落成草稿的「原文」。

    与主页的 /import-script/preview + /import-script/create 共用同一套规则切分器
    （stages/import_script.smart_split_chapters）与同一套 AI 提炼函数
    （extract_outline_with_ai），避免两个入口各切一套、切出来集数不一样。

    start / end（落点）：
      · mode="new"      —— 忽略 start/end（新草稿从第 1 集起）。
      · mode="append"   —— 默认接在草稿末尾（start=0）；用户给了 start 就按 start 放。
      · mode="replace"  —— **默认覆盖整本**（向后兼容旧调用）；给了 start 就只覆盖
                           [start, end]，区间外的大纲与正文**一个字不动**。
      这是修一个真实缺口：用户说「把这个剧本导入前六集」，以前三种 mode 没有一种
      能把 6 集放进第 1~6 格 —— new 会另建一部只有 6 集的新剧，append 会接成第 61~66 集，
      replace 会把整部 60 集的剧砍成 6 集。

    ⛔ 刻意**不**复刻主页导入的那三个后台任务（batch_generate_storyboards /
       build_character_cards / _spawn_auto_analysis）：那是三笔真金白银的消耗，
       主页上是用户勾了「自动生成」才跑。对话里用户只说「导入」，
       擅自替他起点钱的任务是越权 —— 要生成请显式调 start_generation。
    """
    from ..stages.import_script import (
        smart_split_chapters, extract_outline_with_ai, sanitize_text, sanitize_deep,
    )
    from ..models.catalog import sanitize_provider_spec

    text = sanitize_text(source_text or "")
    got_from = "参数 source_text"
    if len(text.strip()) < 80 and conversation_id:
        text = sanitize_text(await _latest_user_text(conversation_id) or "")
        got_from = "会话原文"
    if len(text.strip()) < 80:
        return {"ok": False,
                "error": "没有拿到剧本正文。请让用户把正文贴进来，"
                         "或把正文作为 source_text 传给我。"}

    if mode not in ("new", "replace", "append"):
        mode = "new"

    # ---- 1) 规则切分（零成本）--------------------------------------------
    chapters = smart_split_chapters(text)
    if not chapters:
        return {"ok": False,
                "error": "没能从这段正文里切出任何一章。请让用户确认贴的是剧本正文，"
                         "每集以「第3集」「第三集」「===」这类标记开头。"}

    # ---- 2) 定位目标草稿 + 覆盖护栏 ---------------------------------------
    #     replace 默认覆盖整本。在一部已有几十集的草稿上这是**破坏性**动作：
    #     60 集大纲会被砍成 6 集，且旧正文全没了。所以只要会盖掉已有正文，
    #     就必须要 confirm=true —— 由模型先向用户确认再传。
    g_start = max(0, int(start or 0))
    g_end = max(0, int(end or 0))
    old_count = 0
    async with session_scope() as s:
        if mode in ("replace", "append"):
            if not draft_id:
                return {"ok": False,
                        "error": f"{mode} 模式需要指定草稿，但当前没有选定的草稿。"}
            target = await s.get(ScriptDraft, draft_id)
            if not target:
                return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
            if target.user_id and target.user_id != user_id:
                return {"ok": False, "error": f"草稿 {draft_id} 不属于当前用户"}
            from . import chat_jobs
            active = await chat_jobs.has_active_job(draft_id)
            if active:
                return {"ok": False,
                        "error": f"这部剧有任务在跑（{active}），"
                                 f"换正文会和它打架。等它完成再导入。"}
            old_count = (await s.execute(
                select(func.count()).select_from(ScriptChapter)
                .where(ScriptChapter.draft_id == draft_id)
            )).scalar_one()
            final_title = str(title).strip() or target.title or "导入的剧本"
        else:
            final_title = str(title).strip() or _guess_title(text) or "导入的剧本"
    final_title = sanitize_text(final_title)[:60] or "导入的剧本"

    # ---- 3) 集号重排 ------------------------------------------------------
    #     script_chapters 上有 UNIQUE(draft_id, chapter_order)，重号会直接
    #     IntegrityError。smart_split_chapters 认到的集号是正文自带的（常从 1 起），
    #     而这里的 `order` 是**正文在草稿里的落点**，两者不是一回事：
    #       · new     —— 新草稿，从第 1 集起
    #       · append  —— 默认接在已有集号之后；用户给了 start 就按 start 放
    #       · replace —— 默认覆盖整本（从第 1 集起）；给了 start 就从 start 放
    #     统一按顺序重排成连续集号，既避免撞库，也让「导入前六集」真的落在第 1~6 格。
    if mode == "append" and not g_start:
        async with session_scope() as s:
            mx = (await s.execute(
                select(func.max(ScriptChapter.chapter_order))
                .where(ScriptChapter.draft_id == draft_id)
            )).scalar()
        first_order = int(mx or 0) + 1
    elif mode == "new":
        first_order = 1
    else:
        first_order = g_start or 1
    cleaned: list[dict] = []
    for i, ch in enumerate(chapters):
        body = sanitize_text(str(ch.get("content") or ""))
        if not body.strip():
            continue
        order = first_order + i
        cleaned.append({
            "order": order,
            "title": sanitize_text(str(ch.get("title") or f"第{order}集")),
            "content": body,
        })
    if not cleaned:
        return {"ok": False, "error": "切出来的每一章正文都是空的，无法导入。"}
    # 判据一律用**实际落点**，不用用户给的 start/end —— 两者可能对不上
    # （用户说 end=6、但正文只切出 4 集，实际只占 3~6 格）。
    #
    # ⚠️ 覆盖护栏报出的范围和下面删行的范围**必须是同一个 [lo, hi]**：
    #    报 1~6 却只删 3~5，第 6 格就会被"先说一声"骗过去（用户同意了确认，
    #    但真正被删的格子和他以为的不一样）。一把尺子，不能两把。
    lo = cleaned[0]["order"]
    hi = cleaned[-1]["order"]

    # ---- 3b) 覆盖护栏（必须在拿到实际落点之后判）--------------------------
    #      只挡**真的会盖掉已有正文**的那种；空着的位置随便写。
    if mode == "replace":
        async with session_scope() as s:
            rows = (await s.execute(
                select(ScriptChapter.chapter_order)
                .where(ScriptChapter.draft_id == draft_id,
                       ScriptChapter.chapter_order >= lo,
                       ScriptChapter.chapter_order <= hi)
            )).scalars().all()
            outline_eps = (await s.get(ScriptDraft, draft_id)).outline or {}
        outlined = {int(e.get("order") or 0)
                    for e in (outline_eps.get("chapters") or []) if isinstance(e, dict)}
        hit = sorted(o for o in set(rows) | {o for o in outlined if lo <= o <= hi})
        if hit and not confirm:
            return {
                "ok": False,
                "need_confirm": True,
                "will_overwrite": len(hit),
                "will_overwrite_range":
                    f"第{hit[0]}~{hit[-1]}集" if len(hit) > 1 else f"第{hit[0]}集",
                "error": (f"这一步会**覆盖第{hit[0]}~{hit[-1]}集已有的正文/大纲**"
                          f"（共 {len(hit)} 集）。请先跟用户确认，"
                          f"用户同意后再带 confirm=true 重调一次。"
                          f"如果用户要的是「只补前六集、别动别的」，"
                          f"请确认 mode 是 replace 且带 start=1、end=6。"),
            }

    # ---- 4) AI 提炼大纲（可选，草稿页靠它出集卡）--------------------------
    #     切分本身不花 AI，这里的 AI 是**之后**的提炼，且失败了不影响导入。
    prov = sanitize_provider_spec(provider or None,
                                  ("gemini", "deepseek", "gpt5", "grok"), "gemini")
    outline: dict | None = None
    ai_outline_used = False
    if extract_outline:
        try:
            outline = await extract_outline_with_ai(cleaned, final_title)
            outline["title"] = final_title
            ai_outline_used = True
        except Exception as e:  # noqa: BLE001
            logger.warning(f"对话导入: AI 提炼大纲失败, 降级为正文切片: {e}")
            outline = None
    if outline is None:
        outline = {
            "title": final_title,
            "synopsis": "(从已有剧本导入)",
            "characters": [],
            "world": {},
            "chapters": [{
                "order": ch["order"],
                "title": ch["title"],
                "synopsis": ch["content"][:200],
                "must_have": [],
                "characters": [],
            } for ch in cleaned],
        }

    # ---- 5) 落库 ----------------------------------------------------------
    #
    # 大纲里的 order 必须和章节的落点**对齐**：AI 提炼出来的大纲 order 从 1 起，
    # 而正文可能落在第 10~15 格。不对齐的话草稿页第 10 格点开是"第1集"的梗概。
    if isinstance(outline, dict):
        out_eps = [e for e in (outline.get("chapters") or []) if isinstance(e, dict)]
        for i, e in enumerate(out_eps):
            if i < len(cleaned):
                e["order"] = cleaned[i]["order"]
                e["title"] = e.get("title") or cleaned[i]["title"]
        outline["chapters"] = out_eps

    def _ep_stub(ch: dict) -> dict:
        """正文切片兜底用的最小集骨架（**没有 AI 提炼结果时**才走这里）。"""
        return {"order": ch["order"], "title": ch["title"],
                "synopsis": ch["content"][:200],
                "must_have": [], "characters": []}

    def _ep_for_import(idx: int, ch: dict) -> dict:
        """导入落库时这一集用哪份数据。

        🔴 2026-10-09 修：原实现在 replace / append 分支**一律**调 `_ep_stub`，
        把 `extract_outline_with_ai` 刚提炼出来的东西（含新加的 beats 与契约）
        整块丢掉，只留 `content[:200]`。也就是说：
          · 用户开了「AI 提炼大纲」→ 花了这次调用 →
          · 结果进库时被降级成"正文前 200 字"。
        AI 提炼的结果只写进了注释里那个 `outline` 变量，**从没落到 chapters**。
        这与本仓反复出现的"生成出来了、写回时丢掉"是同一类事故
        （见 outline_expand 模块顶部那张对照表）。

        现在：有 AI 提炼结果就用它（按位置对齐），没有才退回正文切片。
        """
        base = _ep_stub(ch)
        if not (ai_outline_used and isinstance(outline, dict)):
            return base
        src = [e for e in (outline.get("chapters") or []) if isinstance(e, dict)]
        if idx >= len(src):
            return base
        got = dict(src[idx])
        # 落点/标题以**实际章节**为准（AI 的 order 从 1 起，而正文可能落在第 10 格）
        got["order"] = ch["order"]
        got["title"] = got.get("title") or ch["title"]
        return got

    def _merge_outline(ex: dict, new_eps: list[dict],
                       lo: int, hi: int, fallback_title: str) -> list[dict]:
        """把 new_eps 并进已有大纲：**同格覆盖、区间外保留**，并按 order 重排。

        没有这一步，「导入前六集」会得到一个 66 条的大纲（60 + 6 重复），
        大纲说 66 集、正文只有 6 集，之后按大纲生成正文会重复写一遍。

        区间判据用的是**落点** [lo, hi]，和上面删章节行的判据完全一致 ——
        两边必须同一把尺子，否则会出现"章节删了、大纲还在"或反过来的错位。
        hi=0 表示不封顶（append 时用户没给 end 的情形）。
        """
        cur = [e for e in (ex.get("chapters") or []) if isinstance(e, dict)]
        kept = [e for e in cur
                if not (int(e.get("order") or 0) >= lo
                        and (not hi or int(e.get("order") or 0) <= hi))]
        merged = kept + list(new_eps)
        merged.sort(key=lambda e: int(e.get("order") or 0))
        ex["chapters"] = merged
        if not ex.get("title"):
            ex["title"] = fallback_title
        return merged

    async with session_scope() as s:
        if mode == "new":
            d = ScriptDraft(
                session_id=f"chatimport_{int(time.time())}",
                user_id=user_id,
                title=final_title,
                user_input=sanitize_text(text[:20000]),
                episode_count=len(cleaned),
                status="imported",
                outline=sanitize_deep(outline),
                outline_locked=1,      # 与主页导入一致：正文导入即锁大纲
            )
            s.add(d)
            await s.flush()
            draft_id = d.id
        else:
            d = await s.get(ScriptDraft, draft_id)
            if mode == "replace":
                # 只删**落点区间内**的旧章节行，区间外一字不动；大纲同格覆盖。
                # 用户说「导入前六集」时，第 7~60 集的大纲与正文必须原样保留 ——
                # 旧实现是删光整本的章节行 + 把 outline 整份换掉，会把 60 集砍成 6 集。
                ex = dict(d.outline or {})
                merged = _merge_outline(ex,
                                        [_ep_for_import(i, c) for i, c in enumerate(cleaned)],
                                        lo, hi, final_title)
                d.outline = sanitize_deep(ex)
                d.episode_count = len(merged)
                d.status = "imported"
            else:
                # 追加：保留旧大纲与旧章节，把新集**按 order 覆盖并入**（不是无脑 extend）。
                ex = dict(d.outline or {})
                merged = _merge_outline(ex,
                                        [_ep_for_import(i, c) for i, c in enumerate(cleaned)],
                                        lo, hi, final_title)
                d.outline = sanitize_deep(ex)
                d.episode_count = len(merged)
            flag_modified(d, "outline")

        # 删旧行 / 插新行**必须走同一条 Core DELETE + INSERT**，不能靠 ORM 的
        # `s.delete(row)`。原因：script_chapters 上有 UNIQUE(draft_id, chapter_order)，
        # 而 SQLAlchemy 的工作单元**不保证**先 DELETE 再 INSERT —— 同一个 flush 里
        # 新行常常先落库（实测 draft 495 第1集、draft 520 第6集都是这么炸的
        # IntegrityError）。这里显式先发一条 DELETE，再插。
        if mode == "replace" and cleaned:
            await s.execute(
                delete(ScriptChapter).where(
                    ScriptChapter.draft_id == draft_id,
                    ScriptChapter.chapter_order >= lo,
                    ScriptChapter.chapter_order <= hi,
                )
            )
            await s.flush()
        for ch in cleaned:
            # summary 留空 = 交给读取侧 `stages/episode_text.pick_episode_text`
            # 退回本集全文。原来写 `ch["content"][:500]` 是正文前 500 字，
            # 不是摘要 —— 全库 2319 章如此，导致对话上下文里每集只见开头。
            # 用户 2026-10-10 裁定：兜底应当是**这一集的全文**。
            s.add(ScriptChapter(
                draft_id=draft_id, chapter_order=ch["order"],
                title=ch["title"], summary="",
                full_text=ch["content"], word_count=len(ch["content"]),
                locked=1, version=1,
            ))

    # 静默反推世界观/角色卡 —— 与主页导入同一个实现（见
    # settings_backfill.spawn_silent_backfill：不阻塞、不干扰、只跑这两块）。
    # 这是 2026-10-07 事故的防线：导入草稿的人物表/世界观为空时，生成没有锚点，
    # 某章一跑偏就再也拉不回来（prod 草稿 2421 第 5-19 集整段写成另一套特工戏）。
    try:
        from ..stages.settings_backfill import spawn_silent_backfill
        spawn_silent_backfill(draft_id, prov)
    except Exception as e:  # noqa: BLE001
        logger.warning("silent backfill 启动失败 draft %s: %s", draft_id, e)

    return {
        "ok": True, "draft_id": draft_id, "mode": mode,
        "title": final_title, "chapters_imported": len(cleaned),
        "chapters_before": old_count,
        "order_range": f"{cleaned[0]['order']}-{cleaned[-1]['order']}",
        "total_words": sum(len(c["content"]) for c in cleaned),
        "source": got_from, "ai_outline_used": ai_outline_used,
        "note": (f"原文已存进草稿第 {cleaned[0]['order']}~{cleaned[-1]['order']} 集的「原文」栏，"
                 f"范围外的集一字未动。**剧本正文尚未生成**"
                 "（那是另一件事，要生成请告诉用户去点/明说）"),
    }


def _guess_title(text: str) -> str:
    """从集纲原文里猜一个剧名：取第一行（通常就是标题），去掉书名号与集号。

    猜不出就返回空串，由调用方兜底，绝不编造。
    """
    import re as _re
    for line in (text or "").split("\n"):
        s = line.strip().strip("《》【】[]〈〉\"'“”")
        if not s:
            continue
        # 第一行若本身就是「第1集：…」那它不是标题，放弃猜测
        if _re.match(r"^第\s*[一二三四五六七八九十百千零\d]+\s*[集章节话回]", s):
            return ""
        return s[:30]
    return ""


async def _latest_user_text(conversation_id: int) -> str:
    """取该会话里最近一条**用户**消息的原文。

    用途: 用户把几十集集纲整篇贴进来时, 让工具直接回读原文, 而不是让模型把
    几万字重新吐一遍（既费 token 又必然被截断失真）。

    取最长的候选而不是最新一条: 用户常见节奏是「贴集纲 → 再补一句'就按这个写'」,
    最新那条只有几个字。所以回看最近若干条用户消息, 取其中最长的一条。
    """
    from ..db import AgentMessage
    async with session_scope() as s:
        rows = (await s.execute(
            select(AgentMessage)
            .where(AgentMessage.conversation_id == conversation_id,
                   AgentMessage.role == "user")
            .order_by(AgentMessage.id.desc())
            .limit(5)
        )).scalars().all()
    cands = [str(m.content or "") for m in rows if m.is_active is not False]
    if not cands:
        return ""
    best = max(cands, key=len)
    return best if len(best.strip()) >= 80 else ""


__all__ = ["tool", "get_tool", "all_tools", "tools_spec_for_llm",
           "t_list_drafts", "t_get_draft_overview", "t_check_structure",
           "t_check_style", "t_list_episodes", "t_read_chapter",
           "t_list_promises", "t_fix_style_issues", "t_set_draft_settings",
           "t_create_draft", "t_deai_detect",
           "t_patch_outline_episode", "t_patch_promise_payoff",
           "t_start_generation", "t_start_from_conversation", "t_get_job_status",
           "t_start_rewrite", "t_save_chapter_text",
           "t_import_outline", "t_import_script"]
