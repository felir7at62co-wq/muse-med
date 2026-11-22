"""Agent 引擎工具层（唯一事实来源）。

规则（来自 2026-10-18 框架实测，违反任何一条都出过真实问题）：
  1. 进程内直接调用平台函数，不 HTTP 调自己；**每个涉及草稿的工具先做权限校验**——
     很多路由的鉴权写在装饰器 dependencies 里，直接调函数会绕过它。
  2. 写操作完成后**回读确认**，以回读结果为准（实测中"修大纲"接口 25 次全 200 却一字未写）。
  3b. 平台本来就跑在 orchestrator 进程里的后台任务（裂变/批量创建/分析/去AI味/小说推文）一律经
     internal.launch_in_orchestrator 交回 orchestrator 启动，不在 worker 里起（否则重启会丢或重复执行）。
  3. 长任务提交到持久化作业队列；同一草稿已有进行中的同类作业时**返回那个作业**而不是报错，
     这样运行崩溃后重放该工具也不会重复提交（在途工具会被重跑一次，必须幂等）。
  4. 大结果分页读，不截断塞满上下文。
  5. 工具说明里写清"做什么、会改什么、不会改什么"，并禁止试探性写入。
"""
from __future__ import annotations

import asyncio
import copy
import functools
import json
from datetime import datetime
import logging
import re
from dataclasses import dataclass
from typing import Any, Literal

from langchain.tools import ToolRuntime, tool
from sqlalchemy import func, select

from ..db import ScriptChapter, ScriptDraft, ScriptStoryboard, session_scope
from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from .context import EngineContext

logger = logging.getLogger("agent_engine.tools")

Risk = Literal["read", "meta", "generate", "overwrite", "export", "delete"]


@dataclass(frozen=True)
class ToolMeta:
    risk: Risk
    scope: Literal["draft", "global"]      # draft = 只操作一部草稿；global = 跨草稿/建草稿
    long_running: bool = False


META: dict[str, ToolMeta] = {}
_TOOLS: dict[str, Any] = {}


class ToolFailure(Exception):
    """可预期的失败：原因直接告诉模型（它据此改参数或换做法），不打异常栈。"""


def engine_tool(name: str, risk: Risk, scope: str = "draft", long_running: bool = False):
    """注册一个工具：记录元数据 + 统一错误处理（失败以文字返回给模型，不中断运行）。"""
    def deco(fn):
        @functools.wraps(fn)
        async def wrapped(*args, **kwargs):
            # 工具执行期间设好"写作模型"：工具里同步调用的平台写作函数（按意见重生成、补节拍、
            # 区间重写、角色卡……）经 get_llm 时被替换；入队的作业由 jobs.enqueue 带进 payload。
            from ..job_context import WRITING_MODEL
            rt = kwargs.get("runtime")
            wm = _writing_model(rt.context) if rt is not None and getattr(rt, "context", None) else None
            token = WRITING_MODEL.set(wm) if wm else None
            try:
                return await fn(*args, **kwargs)
            except ToolFailure as e:
                return f"[失败] {e}"
            except Exception as e:  # noqa: BLE001
                logger.exception("tool %s failed", name)
                return f"[失败] 工具执行出错：{str(e)[:300]}"
            finally:
                if token is not None:
                    WRITING_MODEL.reset(token)
        t = tool(name)(wrapped)
        META[name] = ToolMeta(risk=risk, scope=scope, long_running=long_running)  # type: ignore[arg-type]
        _TOOLS[name] = t
        return t
    return deco


def all_tools() -> dict[str, Any]:
    return dict(_TOOLS)


# ---------------------------------------------------------------- 公共辅助
JobKind = Literal["agent", "deai", "batch", "novel_tweet", "spawn", "batch_create"]


def _ctx(runtime: ToolRuntime[EngineContext]) -> EngineContext:
    return runtime.context


async def _user(ctx: EngineContext):
    from ..auth.models import User
    async with session_scope() as s:
        u = await s.get(User, ctx.user_id)
        if not u:
            raise ToolFailure("当前用户不存在")
        s.expunge(u)
        return u


async def _guard(ctx: EngineContext, draft_id: int, *, write: bool) -> Any:
    """配置档范围 + 草稿权限校验。返回 User。"""
    # 单剧本模式只限制**写**：对照原作改编时要读另一部草稿（原作），读权限仍由下面的
    # check_draft_access 把关，不会读到别人的稿子。
    if write and ctx.profile == "studio" and ctx.draft_id and int(draft_id) != int(ctx.draft_id):
        raise ToolFailure(f"当前是单剧本模式，只能修改草稿 #{ctx.draft_id}（其它草稿只能读取）")
    if write and ctx.profile == "readonly":
        raise ToolFailure("当前是只读模式，不能修改内容")
    from ..stages.access import check_draft_access
    u = await _user(ctx)
    async with session_scope() as s:
        try:
            await check_draft_access(s, int(draft_id), u, for_write=write)
        except Exception as e:  # noqa: BLE001 - HTTPException → 人话
            detail = getattr(e, "detail", None) or str(e)
            raise ToolFailure(f"无法访问草稿 #{draft_id}：{detail}") from None
    return u


def _j(x: Any, limit: int = 20000) -> str:
    s = json.dumps(x, ensure_ascii=False, default=str)
    if len(s) <= limit:
        return s
    return s[:limit] + f"…（已截断，原长 {len(s)} 字符；请用更窄的范围或分页参数重新读取）"


async def _active_job(draft_id: int) -> dict | None:
    """这部草稿现在有没有在跑的重任务 —— **三套机制一起看**。

    ⚠️ 2026-10-22：此前这里只查 agent_jobs（队列作业），看不见用户在顶栏
    点的「补全 / 强制重写」（进程内批量，状态在 outline.progress）。
    于是 Agent 会以为"没人占着"，提交一条与批量并行的覆写作业；批量写完后
    它的待办为空，回 done + generated:0。真实事故见 progress_helper.draft_activity。
    """
    from ..stages.progress_helper import draft_activity
    act = await draft_activity(draft_id)
    # ⚠️ 只认**占位**的那些（blocks=True）。审批点里的 Agent 会话不占位，
    # 而且往常见到的那一条往往就是**当前这一轮自己** —— 把它当成"别人占着"
    # 会让 Agent 明明可以提交却自我劝退。
    srcs = [x for x in (act.get("sources") or []) if x.get("blocks", True)]
    if not srcs:
        return None
    first = srcs[0]
    return {
        "job_id": first.get("job_id"),
        "kind": first.get("kind"),
        "status": first.get("status") or ("running" if first["mechanism"] == "inline" else ""),
        "mechanism": first["mechanism"],
        "label": first.get("label"),
        "activity": act,
    }


async def _start_or_existing(draft_id: int, res: dict, want_kind: str) -> str:
    """作业类工具的统一返回：成功 → job_id；冲突 → 返回已有作业（幂等）；其它失败 → ToolFailure。"""
    if res.get("ok") and res.get("job_id"):
        return _j({"job_id": res["job_id"], "kind": res.get("kind", want_kind), "status": "queued",
                   "next": "用 wait_job 等它完成，或用 get_job 查进度"})
    act = await _active_job(draft_id)
    if act:
        same = act["kind"] == want_kind
        return _j({**act, "note": ("这部草稿已有同类作业在跑，未重复提交，直接等它即可" if same
                                   else f"这部草稿已有另一项作业（{act['kind']}）在跑，等它结束后再提交")})
    raise ToolFailure(res.get("error") or "提交失败")


# ================================================================ 读取类
@engine_tool("list_drafts", "read", scope="global")
async def list_drafts(runtime: ToolRuntime[EngineContext], created_on: str | None = None,
                      min_score: int | None = None, batch_id: int | None = None,
                      keyword: str | None = None, limit: int = 100) -> str:
    """列出当前用户的草稿（一次返回每部草稿的 id/标题/状态/集数/剧本数/正文数/评分/创建时间，
    不需要再逐个查概况）。
    created_on：按北京日期筛（YYYY-MM-DD）；min_score：最新分析综合分下限；batch_id：批量创建批次；
    keyword：标题包含的关键词。"""
    ctx = _ctx(runtime)
    if ctx.profile == "studio":
        raise ToolFailure("单剧本模式下不需要列草稿，直接操作当前草稿即可")
    from ..stages.router import list_drafts as _list
    u = await _user(ctx)
    # ⚠️ 有 keyword 时必须取全量再筛：原先先取最近 limit 部再按关键词过滤，老草稿永远搜不到
    # （草稿多的账号有四五百部），模型拿到"没有"就会告诉用户"找不到这部剧"。
    r = await _list(session_id=None, limit=max(1, min(int(limit or 100), 500)), offset=0, all=bool(keyword),
                    created_on=created_on, min_score=min_score, batch_id=batch_id, user=u)
    items = r.get("items") if isinstance(r, dict) else r
    out = []
    for it in items or []:
        if keyword and keyword not in (it.get("title") or ""):
            continue
        out.append({k: it.get(k) for k in ("id", "title", "status", "episode_count", "storyboard_count",
                                            "chapter_count", "expected_chapters", "quality_score", "created_at")})
    return _j({"total": len(out), "items": out}, 60000)


_NAME_FILLER = re.compile(r"(那部|这部|那个|这个|一部|叫做|叫|名叫|短剧|剧本|草稿|小说|原作|的剧|的)")
_NAME_PUNCT = re.compile(r"[\s\-_—–·.,，。、:：;；!！?？\"'“”‘’《》<>()（）\[\]【】#]+")


def _name_norm(s: str) -> str:
    return _NAME_PUNCT.sub("", s or "").lower()


def _name_score(query: str, title: str) -> float:
    """标题与用户说法的相似度（0~1）。用户常说半截、换词、带"那部"，所以不能只做子串匹配。"""
    # 填充词两边都去掉：只去用户说法里的"的"会让"刷的却是我的卡"对不上原标题
    q = _name_norm(_NAME_FILLER.sub("", query or ""))
    t = _name_norm(_NAME_FILLER.sub("", title or ""))
    if not q or not t:
        return 0.0
    if q in t:
        return 1.0
    grams = {q[i:i + 2] for i in range(len(q) - 1)} or {q}
    hit = sum(1 for g in grams if g in t)
    return hit / len(grams)


@engine_tool("find_drafts", "read", scope="global")
async def find_drafts(runtime: ToolRuntime[EngineContext], name: str, limit: int = 8) -> str:
    """按**名称**找草稿（用户通常不知道草稿号，只说"同事请客那部""老捕头的那个"）。
    在用户全部草稿里做模糊匹配（不限最近多少部），返回候选：id、标题、集数、剧本数、最近修改时间、匹配度。
    用法：
    · 只有一个明显匹配（匹配度远高于其它）→ 直接用它，汇报里写出标题和 #id 让用户能核对；
    · 有几个相近的（同名系列、复制出来的副本）→ 把候选的标题、集数、修改时间列给用户，问是哪一部，不要猜；
    · 一个都没有 → 如实说没找到，请用户换个说法或给出标题里的几个字。
    name 里带 #数字 时直接按草稿号查。"""
    ctx = _ctx(runtime)
    # 只有"#729"或纯数字才当草稿号；"北原1998"这种标题里的数字不算
    m = re.search(r"#(\d{1,7})", name or "") or re.fullmatch(r"\s*(\d{1,7})\s*", name or "")
    from ..auth.models import User
    async with session_scope() as s:
        u = await s.get(User, ctx.user_id)
        is_admin = (getattr(u, "role", "") or "") in ("admin", "superadmin")
        stmt = select(ScriptDraft.id, ScriptDraft.title, ScriptDraft.user_id, ScriptDraft.episode_count,
                      ScriptDraft.updated_at).where(ScriptDraft.is_deleted.is_(False))
        if not is_admin:
            stmt = stmt.where(ScriptDraft.user_id == ctx.user_id)
        rows = (await s.execute(stmt)).all()
    scored = []
    for r in rows:
        sc = 1.0 if (m and str(r.id) == m.group(1)) else _name_score(name, r.title or "")
        if sc < 0.34:
            continue
        own = r.user_id == ctx.user_id
        # 管理员能看到所有人的草稿：自己的排前面，别人的降一档并标出归属
        scored.append((sc + (0.0 if own else -0.2), own, r))
    scored.sort(key=lambda x: (x[0], x[2].updated_at or datetime.min), reverse=True)
    top = scored[:max(1, min(int(limit or 8), 20))]
    ids = [r.id for _, _, r in top]
    sb_cnt: dict[int, int] = {}
    if ids:
        async with session_scope() as s:
            for did, n in (await s.execute(select(ScriptStoryboard.draft_id, func.count()).where(
                    ScriptStoryboard.draft_id.in_(ids)).group_by(ScriptStoryboard.draft_id))).all():
                sb_cnt[did] = n
    items = [{"id": r.id, "title": r.title, "episodes": r.episode_count, "storyboards": sb_cnt.get(r.id, 0),
              "updated_at": r.updated_at.isoformat(timespec="minutes") if r.updated_at else None,
              "match": round(max(sc, 0), 2), **({} if own else {"owner_user_id": r.user_id, "note": "不是当前用户的草稿"})}
             for sc, own, r in top]
    return _j({"query": name, "searched": len(rows), "candidates": items})


@engine_tool("get_draft", "read")
async def get_draft(runtime: ToolRuntime[EngineContext], draft_id: int) -> str:
    """查看一部草稿的概况：标题、状态、集数、**每集目标字数与实际字数**、
    哪些集已有正文/剧本、大纲门禁与一致性校验摘要、是否为改编作品、是否有进行中的作业。

    ⚠️ 用户问"这部剧每集写多少字""这集是不是太短了"时，答案在这里 ——
    不要靠数你读到的那段文本，read_chapter 是分段读的，只数一部分会低估。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=False)
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise ToolFailure(f"草稿 #{draft_id} 不存在")
        o = d.outline or {}
        ch_rows = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id))).scalars().all()
        text_orders = sorted(r.chapter_order for r in ch_rows if (r.full_text or "").strip())
        sb_orders = sorted(r.chapter_order for r in (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id))).scalars().all()
            if r.shots_json)
        # 实际字数：优先用 word_count 列（写入时就记了），没有才现算 ——
        # 存量行里两者偶有不一致（导入的稿子 word_count 可能没写），现算是兜底。
        actual = {int(r.chapter_order): int(r.word_count or len(r.full_text or ""))
                  for r in ch_rows if (r.full_text or "").strip()}
        target = int(d.chapter_word_target or DEFAULT_CHAPTER_WORD_TARGET)
    eps = o.get("chapters") or []
    # 区间摘要而不是逐集全列：60 集的草稿全列会把返回撑爆，而模型真正要的
    # 是"有没有系统性偏短/偏长"，中位数与区间已经足够回答。
    _v = sorted(actual.values())
    stats: dict[str, Any] = {"target": target}
    if _v:
        n = len(_v)
        stats.update({
            "episodes_written": n,
            "min": _v[0], "max": _v[-1],
            "median": _v[n // 2],
            "avg": round(sum(_v) / n),
            # 与生成侧 `_emit_post_check` 同一口径（<60% 或 >150% 会告警），
            # 这样模型看到的"偏短"与用户看到的警告是同一件事。
            "below_60pct": sum(1 for x in _v if x < target * 0.6),
            "above_150pct": sum(1 for x in _v if x > target * 1.5),
            "note": "target 是用户的设定值；想改它用对应工具改草稿设定，不要为此重写正文",
        })
    else:
        stats["episodes_written"] = 0
    from ..stages.outline_density import is_skeleton_outline
    return _j({
        "id": d.id, "title": d.title, "status": d.status, "episode_count": d.episode_count,
        "chapter_word_target": target,
        "word_stats": stats,
        # ⚠️ 导入的草稿没有真大纲，每集 synopsis 是正文前 200 字硬切（见 read_outline 的 warning）。
        # 这个布尔值就是让模型**一眼认出**这件事，不用先去踩 read_outline 才知道。
        "outline_is_skeleton": is_skeleton_outline(o),
        "outline_episodes": len(eps),
        # 2026-11-07：大纲只剩正文一个字段，"有 beats 的集"这个指标失去意义，
        # 换成"正文写得够不够厚"—— 这才是现在判断生成依据是否够用的口径。
        "episodes_with_body": sum(1 for e in eps if len(str(e.get("synopsis") or "").strip()) >= 80),
        "has_text": text_orders, "has_storyboard": sb_orders,
        "gate": (o.get("drama_report") or {}).get("summary"),
        "lint": (o.get("lint_report") or {}).get("summary"),
        "is_adaptation": bool((o.get("adaptation") or {}).get("is_adaptation")),
        "active_job": await _active_job(draft_id),
        "user_input": (d.user_input or "")[:600],
    })


_EP_FIELDS = ("order", "title", "synopsis")


@engine_tool("read_outline", "read")
async def read_outline(runtime: ToolRuntime[EngineContext], draft_id: int,
                       start: int = 0, end: int = 0) -> str:
    """读取分集大纲：每集标题与正文（正文就是用户看到的大纲，含【开场卡点】【冲突】【爽点】【结尾钩子】等要素），
    以及人物表、世界观、结构问题清单。start/end 限定集号范围（0 = 不限）。集数多时请分段读。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=False)
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise ToolFailure(f"草稿 #{draft_id} 不存在")
        o = d.outline or {}
    eps = [{k: e.get(k) for k in _EP_FIELDS if e.get(k) not in (None, "", [], {})}
           for e in (o.get("chapters") or [])
           if (not start or int(e.get("order") or 0) >= start) and (not end or int(e.get("order") or 0) <= end)]
    issues = [{"level": i.get("level"), "ep": i.get("episode"), "code": i.get("code"), "msg": i.get("message"),
               "fix": i.get("fix_hint")} for i in ((o.get("drama_report") or {}).get("issues") or [])
              if (not start or (i.get("episode") or 0) >= start) and (not end or (i.get("episode") or 0) <= end)]
    chars = [{k: c.get(k) for k in ("name", "role", "traits", "appearance") if c.get(k)}
             for c in (o.get("characters") or []) if isinstance(c, dict)]
    from ..stages.outline_density import SKELETON_CHUNK_CHARS, is_skeleton_outline
    skeleton = is_skeleton_outline(o)
    # 骨架大纲必须在**这一层**说清楚。字段名就叫 synopsis，不写明白模型一定会
    # 把它当梗概用 —— 2026-10-24 生产反馈"Agent 读的大纲不是大纲"就是这么来的。
    warning = (f"⚠️ 这份大纲是**导入时零模型生成的骨架**，不是大纲：每集 synopsis 是正文前 "
               f"{SKELETON_CHUNK_CHARS} 字硬切（常从句子中间断开），顶层 synopsis 是占位符，"
               f"人物表与世界观也没填。**不要据此判断剧情、不要据此提修改意见**；"
               f"要了解剧情请用 read_chapter 读正文，要真大纲请先 backfill_settings 补设定/契约，"
               f"或让用户确认后 generate_outline。") if skeleton else None
    return _j({"title": o.get("title"), "synopsis": o.get("synopsis"), "world": o.get("world"),
               "outline_is_skeleton": skeleton, "warning": warning,
               "characters": chars, "episodes": eps, "gate_issues": issues}, 80000)


@engine_tool("read_chapter", "read")
async def read_chapter(runtime: ToolRuntime[EngineContext], draft_id: int, order: int,
                       offset: int = 0, limit: int = 8000) -> str:
    """分段读取第 order 集正文（小说原文）。正文较长时用 offset 继续往后读，直到提示"已读完"。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=False)
    async with session_scope() as s:
        ch = (await s.execute(select(ScriptChapter).where(
            ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == order))).scalar_one_or_none()
    t = (ch.full_text or "") if ch else ""
    if not t.strip():
        return f"第{order}集没有正文"
    limit = max(500, min(int(limit or 8000), 20000))
    part = t[offset: offset + limit]
    more = offset + limit < len(t)
    return f"[第{order}集正文 {offset}-{offset + len(part)} / 共{len(t)}字{'，还有后续' if more else '，已读完'}]\n{part}"


@engine_tool("read_storyboard", "read")
async def read_storyboard(runtime: ToolRuntime[EngineContext], draft_id: int, order: int) -> str:
    """读取第 order 集剧本（场次、时间地点、人物、动作、台词），用于检查剧本质量后再决定是否重写。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=False)
    async with session_scope() as s:
        sb = (await s.execute(select(ScriptStoryboard).where(
            ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == order))).scalar_one_or_none()
    if not sb or not sb.shots_json:
        return f"第{order}集没有剧本"
    lines = [f"[第{order}集剧本{'（大纲已改动，此剧本可能过期）' if sb.is_stale else ''}]"]
    for sc in sb.shots_json:
        lines.append(f"## 场{sc.get('scene_no')} {sc.get('time_loc')} 人物:{'、'.join(sc.get('characters') or [])}")
        for el in sc.get("elements") or []:
            if el.get("type") == "dialogue":
                mode = f"({el.get('mode')})" if el.get("mode") else ""
                lines.append(f"{el.get('character')}{mode}：{el.get('content')}")
            elif el.get("content"):
                lines.append(el["content"])
    return _j("\n".join(lines), 30000)


@engine_tool("run_check", "read")
async def run_check(runtime: ToolRuntime[EngineContext], draft_id: int,
                    kinds: list[Literal["structure", "style", "consistency", "script", "divergence"]] | None = None,
                    start_ep: int = 0, end_ep: int = 0) -> str:
    """对草稿做体检（约 1 分钟），只标注不修改。kinds：structure 结构 / style 文风 / consistency 一致性 /
    script 剧本格式 / divergence 大纲分岔；不传 = 全部。返回 report_id 与按集的问题清单（每条带 issue_id），
    可交给 start_fix 定点修复。"""
    ctx = _ctx(runtime)
    u = await _guard(ctx, draft_id, write=False)
    from ..check.engine import ALL_KINDS
    from ..check.engine import run_check as _run
    from ..check.fixer import index_issues
    from ..db import CheckReport
    ks = tuple(kinds or ALL_KINDS)
    scope = {"start_ep": start_ep or None, "end_ep": end_ep or None} if (start_ep or end_ep) else None
    report = await _run(draft_id=draft_id, kinds=ks, scope=scope, deep=True)
    idx = index_issues(report)
    async with session_scope() as s:
        row = CheckReport(draft_id=draft_id, user_id=u.id, kinds=list(ks), scope=scope, report=report, issue_index=idx)
        s.add(row)
        await s.flush()
        rid = row.id
    issues = [{"issue_id": iid, "lv": v.get("level"), "ep": v.get("episode"), "kind": v.get("kind"),
               "msg": v.get("message"), "fix": v.get("fix_hint")} for iid, v in idx.items()]
    return _j({"report_id": rid, "totals": report.get("totals"), "issues": issues}, 40000)


@engine_tool("check_mainline", "read")
async def check_mainline(runtime: ToolRuntime[EngineContext], draft_id: int,
                         layer: Literal["outline", "storyboard"] = "outline",
                         start_ep: int = 0, end_ep: int = 0) -> str:
    """主线核对（约每 12 集 1 分钟），只判定不修改。逐集判断四件事：主角的本事这一集有没有真的出场、
    对手是不是主线上那位（胜负没有交给警察/法院/媒体/投资方）、手法是否真实可信、打法是否和上一集不同。
    layer=outline 查分集大纲，layer=storyboard 查已生成的剧本。
    不过关的集带 fix_feedback，可直接作为 regenerate_outline_episode / regenerate_storyboard 的意见。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=False)
    from ..check.review import mainline_review
    try:
        r = await mainline_review(draft_id, layer=layer, start_ep=start_ep, end_ep=end_ep)
    except ValueError as e:
        raise ToolFailure(str(e)) from None
    return _j(r, 30000)


@engine_tool("check_storyboards", "read")
async def check_storyboards(runtime: ToolRuntime[EngineContext], draft_id: int,
                            start_ep: int = 0, end_ep: int = 0) -> str:
    """剧本机械检查（几秒，不调模型）：每集字数是否贴合草稿设定、整场无对白的场、连续多条动作行、
    对白占比。返回每集指标与问题清单（problems，每条带集号和改法）。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=False)
    from ..check.review import storyboard_review
    try:
        return _j(await storyboard_review(draft_id, start_ep=start_ep, end_ep=end_ep), 20000)
    except ValueError as e:
        raise ToolFailure(str(e)) from None


@engine_tool("check_products", "read")
async def check_products(runtime: ToolRuntime[EngineContext], draft_id: int,
                         kind: Literal["novel", "tweet"]) -> str:
    """小说/推文机械检查（几秒，不调模型）：缺章、空章、内容是模型报错文字、字数偏离草稿设定、
    推文是否第一人称。返回问题清单（problems，每条带章号和改法）。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=False)
    from ..check.review import product_review
    try:
        return _j(await product_review(draft_id, kind), 20000)
    except ValueError as e:
        raise ToolFailure(str(e)) from None


@engine_tool("deai_detect", "read")
async def deai_detect(runtime: ToolRuntime[EngineContext], draft_id: int) -> str:
    """检测全剧剧本的 AI 味（规则扫描，几秒钟）：分数越高 AI 味越重，level 为 轻度/中度/重度，附命中类型。"""
    ctx = _ctx(runtime)
    u = await _guard(ctx, draft_id, write=False)
    from ..deai.routes import DetectBody, detect
    r = await detect(DetectBody(draft_id=draft_id), user=u)
    rep = (r or {}).get("report") or {}
    return _j({k: rep.get(k) for k in ("score", "level", "per_kilo", "a_count", "b_count", "char_count")}
              | {"top_hits": [h.get("label") for h in (rep.get("hits") or [])[:8]]})


@engine_tool("get_job", "read", scope="global")
async def get_job(runtime: ToolRuntime[EngineContext], job_id: int,
                  kind: JobKind = "agent") -> str:
    """查后台作业的真实状态与进度。kind：agent = 生成/精修/修复/改编/去AI味等作业（默认）；deai = 2026-10-30 之前的旧去AI味清洗稿；
    batch = 批量运营作业；novel_tweet = 小说/推文改写；spawn = 裂变；batch_create = 批量创建草稿。任何"已完成/进度 N%"的说法都必须来自这里的返回。"""
    return _j(await _job_snapshot(_ctx(runtime), job_id, kind))


async def _job_snapshot(ctx: EngineContext, job_id: int, kind: str) -> dict:
    admin = ctx.role in ("admin", "superadmin")
    if kind == "deai":
        # 2026-10-30 起去 AI 味是队列作业（deai_apply，kind=agent）；按旧名字问的也认出来，
        # 否则模型看到"去AI味作业不存在"会误以为提交失败（E2E 实测第一步就这么问）。
        from ..db.models import AgentJob
        async with session_scope() as s:
            aj = await s.get(AgentJob, job_id)
            if aj and aj.kind == "deai_apply":
                kind = "agent"
    async with session_scope() as s:
        if kind == "novel_tweet":
            from ..adapt_products.models import ChapterAdaptJob
            j = await s.get(ChapterAdaptJob, job_id)
            if not j or (j.user_id != ctx.user_id and not admin):
                raise ToolFailure(f"小说/推文作业 {job_id} 不存在")
            return {"job_id": j.id, "kind": j.kind, "status": j.status, "total": j.total,
                    "finished": j.finished, "error": j.error, "draft_id": j.draft_id}
        if kind == "spawn":
            from ..spawn.models import SpawnJob
            j = await s.get(SpawnJob, job_id)
            if not j or (j.user_id != ctx.user_id and not admin):
                raise ToolFailure(f"裂变作业 {job_id} 不存在")
            raw = j.variants_json or []
            raw = list(raw.values()) if isinstance(raw, dict) else raw   # 实际存的是 {"0": {...}, "1": {...}}
            vs = [{k: v.get(k) for k in ("idx", "title", "draft_id", "new_draft_id", "status", "error", "pitch")
                   if v.get(k) not in (None, "")} for v in raw if isinstance(v, dict)]
            return {"job_id": j.id, "kind": "spawn", "status": j.status, "stage": j.stage, "total": j.total,
                    "finished": j.finished, "failed": j.failed, "error": j.error, "variants": vs}
        if kind == "batch_create":
            from ..db.models import AutoBatchJob
            j = await s.get(AutoBatchJob, job_id)
            if not j or (j.created_by != ctx.user_id and not admin):
                raise ToolFailure(f"批量创建作业 {job_id} 不存在")
            return {"job_id": j.id, "kind": "batch_create", "status": j.status, "total": j.total_dramas,
                    "finished": j.finished_dramas, "failed": j.failed_dramas, "step": j.current_step,
                    "draft_ids": j.draft_ids, "error": j.error}
        if kind == "agent":
            from ..db.models import AgentJob
            j = await s.get(AgentJob, job_id)
            if not j or (j.user_id and j.user_id != ctx.user_id and not admin):
                raise ToolFailure(f"作业 {job_id} 不存在")
            res = j.result or {}
            snap = {"job_id": j.id, "kind": j.kind, "status": j.status, "progress": j.progress,
                    "note": j.progress_note, "error": j.error,
                    "result": {k: v for k, v in res.items() if k != "log"}}
        elif kind == "deai":
            from ..deai.models import DeaiJob
            j = await s.get(DeaiJob, job_id)
            if not j or (j.user_id != ctx.user_id and not admin):
                raise ToolFailure(f"去AI味作业 {job_id} 不存在")
            return {"job_id": j.id, "kind": "deai", "status": j.status, "error": getattr(j, "error", None)}
        else:
            from ..db.models import AgentBatchJob
            j = await s.get(AgentBatchJob, job_id)
            if not j or (j.user_id != ctx.user_id and not admin):
                raise ToolFailure(f"批量作业 {job_id} 不存在")
            return {"job_id": j.id, "kind": "batch", "status": j.status, "total": j.total, "finished": j.finished,
                    "failed": j.failed, "items": (j.items_json or [])[:50]}

    # ── 补上「到底在哪个阶段」 ────────────────────────────────────────
    # ⚠️ 2026-10-24：`status` 只有 queued/running/done/… 五个值，**排队和卡死在它
    # 眼里一模一样**。生产上 Agent 因此只会对用户说"我继续等"—— 因为它看到
    # progress=0，分不清是"还没轮到"还是"跑了很久没进展"。而那一等就是 2~3 小时。
    # `state` 把排队位置、心跳新鲜度、每集进度、预计剩余一次说清，让 Agent 能
    # 直接告诉用户"在排队，前面还有 6 个任务"而不是空等。
    from ..agent.job_status import describe
    from ..agent import jobs as _jobs
    pos = (await _jobs.queue_positions([job_id])).get(job_id) if snap["status"] == "queued" else None
    started = None
    _raw = (getattr(j, "payload", None) or {}).get("_started_at") if isinstance(getattr(j, "payload", None), dict) else None
    if _raw:
        try:
            from datetime import datetime as _dt, timezone as _tz
            started = _dt.fromtimestamp(float(_raw), _tz.utc).replace(tzinfo=None)
        except (TypeError, ValueError, OSError):
            started = None
    snap["state"] = describe(status=j.status, progress=j.progress, progress_note=j.progress_note,
                             heartbeat_at=getattr(j, "heartbeat_at", None), created_at=j.created_at,
                             started_at=started, attempt=getattr(j, "attempt", None), queue_position=pos)
    return snap


_TERMINAL = {"done", "failed", "canceled", "cancelled", "partial_failed", "partial", "error", "succeeded", "completed"}


@engine_tool("wait_job", "read", scope="global", long_running=True)
async def wait_job(runtime: ToolRuntime[EngineContext], job_id: int,
                   kind: JobKind = "agent", max_wait_seconds: int = 1800) -> str:
    """等待后台作业结束并返回最终状态（每 15 秒查一次，最多等 max_wait_seconds 秒，上限 3 小时）。
    超时返回当前进度，可再次调用继续等。

    ⚠️ 返回里的 `state.phase` 才是判活口径：
      · `queued`  = **还没轮到**，一个字都没写。这时候"继续等"是对的，但要**告诉用户
                    在排队、前面还有几个**，不要只回"进行中"；
      · `running` = 真在写，`state.eta_seconds` 是预计剩余；
      · `stalled` = 心跳断了，队列会重新派发 —— 要如实告诉用户"疑似卡住"，
                    而不是继续假装在跑；
      · `awaiting_approval` = 等人点确认，不会自己恢复。
    """
    ctx = _ctx(runtime)
    waited, cap = 0, max(60, min(int(max_wait_seconds or 1800), 10800))
    while True:
        snap = await _job_snapshot(ctx, job_id, kind)
        if snap.get("status") in _TERMINAL or waited >= cap:
            snap["waited_seconds"] = waited
            if snap.get("status") not in _TERMINAL:
                st = snap.get("state") or {}
                phase = st.get("phase")
                if phase == "queued":
                    snap["note_for_agent"] = (
                        f"**还在排队，一个字都还没写**（{st.get('label')}）。"
                        "这不是卡死；要么继续 wait_job，要么把排队情况告诉用户，"
                        "让他决定是等还是先做别的。")
                    snap["queued_only"] = True
                elif phase == "stalled":
                    snap["note_for_agent"] = (
                        "心跳已断，执行它的进程多半死了。队列会自动重新派发；"
                        "**如实告诉用户「疑似卡住、会自动重试」**，不要继续说「进行中」。")
                else:
                    snap["note_for_agent"] = "尚未结束，可再次调用 wait_job 继续等"
            return _j(snap)
        await asyncio.sleep(15)
        waited += 15


# ================================================================ 在跑什么 / 取消
@engine_tool("draft_activity", "read")
async def draft_activity_tool(runtime: ToolRuntime[EngineContext], draft_id: int) -> str:
    """查这部草稿**现在到底在跑什么任务** —— 三套机制一起看：顶栏的批量生成（补全/强制重写）、
    队列作业（生成/精修/修复/改编/体检）、整本精修。

    ⚠️ 在提交任何覆写型作业（生成、精修、修复、改编）之前先调它。
    平台上有两套互不相通的任务机制，只看其中一套会误判"没人占着"，
    提交后要么被 409 拒绝，要么（更糟）与正在跑的批量任务并行、互相覆盖，
    最后作业跑完是 0 集却回你"已启动"（2026-10-22 生产事故）。

    返回 busy / summary / sources（每项带 mechanism、label、进度、取消方式）。
    busy=true 时不要提交新的覆写型作业，先把情况告诉用户。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=False)
    from ..stages.progress_helper import draft_activity
    act = await draft_activity(draft_id)
    act["note"] = ("现在有任务在跑。不要提交新的覆写型作业；"
                   "要么等它完成，要么先问用户是否取消（用 cancel_draft_tasks）。"
                   if act.get("busy") else "空闲，可以提交生成/精修类作业。")
    return _j(act)


@engine_tool("cancel_draft_tasks", "overwrite")
async def cancel_draft_tasks(runtime: ToolRuntime[EngineContext], draft_id: int,
                             confirm_text: str = "") -> str:
    """取消这部草稿上**正在跑的重任务**（顶栏批量、队列作业、整本精修都算）。

    ⚠️ 这是破坏性操作，调用前必须先把「要取消什么、会丢掉什么」告诉用户并得到同意。
    confirm_text 里写用户的原话或你的确认依据（例如"用户说：先停掉，我改完大纲再跑"）。

    语义：**不是立即中断**。批量与精修都在"上一集已落库、下一集还没发请求"的安全边界退出，
    所以当前正在写的那一集会写完；已生成的内容不会丢。
    只取消、不删除任何已完成的稿子。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=True)
    if not (confirm_text or "").strip():
        raise ToolFailure("取消任务是对用户有影响的操作：先问清楚再调，并把用户同意的那句话写进 confirm_text。")
    from ..stages.progress_helper import draft_activity, request_cancel
    act = await draft_activity(draft_id)
    # ⚠️ 判据用 `sources` 而不是 `busy`：审批点（awaiting_approval）不占位（busy=False），
    # 但它正是用户最常想"停掉"的东西 —— 用 busy 判断会回他一句"没有在跑的任务"。
    if not act.get("sources"):
        return _j({"ok": False, "note": "这部草稿现在没有在跑的任务，无需取消。", "activity": act})

    done: list[dict] = []
    for src in act.get("sources") or []:
        if src["mechanism"] == "inline":
            ok = await request_cancel(draft_id)
            done.append({"mechanism": "inline", "label": src.get("label"), "requested": ok,
                         "note": "会在当前这一集写完后停"})
        elif src["mechanism"] == "agent":
            # Agent 自己的那一轮不能在这里"取消自己"—— 那会让正在执行的这一轮
            # 中途被杀掉，返回给用户的是半截结果。只报告，不动手。
            done.append({"mechanism": "agent", "label": src.get("label"), "requested": False,
                         "note": "这是某个 Agent 会话本身，请让用户在那个会话里点停止"})
        elif src["mechanism"] == "queue" and src.get("job_id"):
            from ..db.models import AgentJob
            async with session_scope() as s:
                j = await s.get(AgentJob, int(src["job_id"]))
                if j and j.status not in ("done", "failed", "canceled"):
                    if j.kind == "rewrite_script":      # 精修的取消要传导到 RewriteJob
                        from ..db.models import RewriteJob
                        rj_id = int((j.result or {}).get("rewrite_job_id") or 0)
                        if rj_id:
                            rj = await s.get(RewriteJob, rj_id)
                            if rj and rj.status not in ("done", "failed", "canceled"):
                                rj.status = "canceled"
                    j.status = "canceled"
                    j.lease_owner = None
                    j.lease_expires_at = None
                    await s.flush()
                    done.append({"mechanism": "queue", "job_id": src["job_id"],
                                 "label": src.get("label"), "requested": True})
        elif src["mechanism"] == "rewrite" and src.get("job_id"):
            from ..db.models import RewriteJob
            async with session_scope() as s:
                rj = await s.get(RewriteJob, int(src["job_id"]))
                if rj and rj.status not in ("done", "failed", "canceled"):
                    rj.status = "canceled"
                    await s.flush()
                    done.append({"mechanism": "rewrite", "job_id": src["job_id"],
                                 "label": src.get("label"), "requested": True})
    actually = [x for x in done if x.get("requested")]
    if not actually:
        # 一条都没真取消 —— 最典型的就是"只剩一个停在审批点的 Agent 会话"。
        # 这时回 ok:true 会让模型向用户报"已经停了"，而实际上什么都没停。
        return _j({"ok": False,
                   "note": "没有可以在这里取消的任务：" + "；".join(
                       f"{x.get('label') or x['mechanism']} —— {x.get('note') or ''}" for x in done),
                   "canceled": done})
    return _j({"ok": True, "canceled": done,
               "note": "已发出取消。正在写的那一集会写完才停；已完成的稿子不受影响。用 draft_activity 复查。"})


# ================================================================ 草稿与大纲
@engine_tool("create_draft", "generate", scope="global")
async def create_draft(runtime: ToolRuntime[EngineContext], title: str, idea: str,
                       episode_count: int = 10, chapter_word_target: int = DEFAULT_CHAPTER_WORD_TARGET) -> str:
    """新建一部空草稿（只建草稿，不生成任何内容）。idea 写清题材、人物、核心冲突与期望走向。"""
    ctx = _ctx(runtime)
    if ctx.profile != "producer":
        raise ToolFailure("只有全局制片模式可以新建草稿")
    from ..stages.router import CreateDraftIn
    from ..stages.router import create_draft as _create
    u = await _user(ctx)
    d = await _create(CreateDraftIn(title=title, user_input=idea, episode_count=episode_count,
                                    chapter_word_target=chapter_word_target), user=u)
    did = d.get("id") if isinstance(d, dict) else getattr(d, "id", None)
    if not did:
        raise ToolFailure("新建草稿失败")
    return _j({"draft_id": did, "title": title, "episode_count": episode_count,
               "next": "用 generate_outline 生成分集大纲"})


def _writing_model(ctx: EngineContext) -> str | None:
    """这一轮该用哪个模型写稿。空 = 让下游沿用草稿自己记的写作模型（既有行为）。

    ⚠️ 与 Agent 自己思考用的模型（run.model）是两件事，别混：用户可能想让 Agent 用
    一个稳的模型调度、用便宜的模型写稿；反过来也一样。所以这里只读 writing_model，
    绝不在缺省时拿 run.model 顶上 —— 那会在用户没有表达意愿时改掉稿子的模型。
    """
    m = (getattr(ctx, "writing_model", None) or "").strip()
    if m:
        return m
    # 用户没在对话栏选：用 Agent 的写作默认模型（当前 deepseek-v4-flash）。
    # ⚠️ 这里**不**回落到草稿自己记的 model_provider —— 用户已明确要求 Agent 写稿的默认
    # 模型是 deepseek-v4-flash；草稿上的设置是"在草稿页手动生成时"的口径。
    from .llm import DEFAULT_WRITING_MODEL
    return DEFAULT_WRITING_MODEL


async def _start_gen(ctx: EngineContext, draft_id: int, gen_kind: str, start: int, end: int, guidance: str) -> str:
    await _guard(ctx, draft_id, write=True)
    from ..agent.chat_jobs import start_generate
    res = await start_generate(draft_id=draft_id, user_id=ctx.user_id, gen_kind=gen_kind,
                               start=start or None, end=end or None, guidance=guidance or "",
                               writing_model=_writing_model(ctx))
    kind = {"outline": "gen_outline", "chapters": "gen_chapters", "storyboards": "gen_storyboards"}[gen_kind]
    return await _start_or_existing(draft_id, res, kind)


@engine_tool("generate_outline", "generate", long_running=True)
async def generate_outline(runtime: ToolRuntime[EngineContext], draft_id: int, guidance: str = "") -> str:
    """为草稿生成（或续写到计划集数的）分集大纲，带戏剧契约与结构门禁。提交后台作业，返回 job_id。"""
    return await _start_gen(_ctx(runtime), draft_id, "outline", 0, 0, guidance)


@engine_tool("generate_chapters", "generate", long_running=True)
async def generate_chapters(runtime: ToolRuntime[EngineContext], draft_id: int, start: int = 0, end: int = 0,
                            guidance: str = "") -> str:
    """按大纲批量生成正文（小说原文）。start/end 限定集号范围（0 = 全部尚无正文的集）；已有正文的集跳过。
    guidance 是这次的写作要求。提交后台作业，返回 job_id。注意：短剧主流程是"大纲→剧本"，正文不是必经步骤。"""
    return await _start_gen(_ctx(runtime), draft_id, "chapters", start, end, guidance)


@engine_tool("generate_storyboards", "generate", long_running=True)
async def generate_storyboards(runtime: ToolRuntime[EngineContext], draft_id: int, start: int = 0, end: int = 0,
                               guidance: str = "") -> str:
    """批量生成剧本（分镜）。start/end 限定集号范围（0 = 全部尚无剧本的集）；**已有剧本的集自动跳过**，
    要重做已有剧本的某集请用 regenerate_storyboard。有正文的集按正文转剧本，没有正文的集按大纲直接写
    （不需要先有正文）。提交后台作业，返回 job_id。"""
    return await _start_gen(_ctx(runtime), draft_id, "storyboards", start, end, guidance)


@engine_tool("patch_outline_episode", "overwrite")
async def patch_outline_episode(runtime: ToolRuntime[EngineContext], draft_id: int, order: int,
                                fields: dict[str, Any]) -> str:
    """把用户给出的文字**原样写进**第 order 集。可写：title（标题）、synopsis（整段正文）。

    ## 什么时候用（2026-11-07 用户裁定）

    **只在用户明确给出了成品文字时用**，例如"第 12 集的结尾钩子改成：她推开门，看见……"、
    "这段换成下面这篇"。

    用户只是说"这一集不好看""改得精彩点"这类没有给文字的诉求，**不要**用这个工具，
    也不许自己拼一段塞进去 —— 用 script_write(layer=..., task="revise", order=N, intent=意见)
    让平台按完整上下文重写。你并不总能拿到完整的上下文拼接，自己写上会有改坏别处的风险。

    ## 写了就不校验

    用户明确要求的内容不拦截：给什么写什么，包括整段覆盖、不常见的要素名、
    甚至在散文梗概上直接改。这一层不做格式判断，只负责把它落库。
    修改前自动保存历史版本，可随时回退。
    """
    ctx = _ctx(runtime)
    from ..stages.outline_fields import PATCHABLE_FIELDS
    from ..stages.router_m5_enhanced import UpdateOutlineEpisodeIn, update_outline_episode

    bad = [k for k in fields if k not in PATCHABLE_FIELDS]
    if bad:
        raise ToolFailure(f"不能修改这些字段：{bad}；可改字段：{sorted(PATCHABLE_FIELDS)}")
    if not fields:
        raise ToolFailure("没有要改的内容")

    await _guard(ctx, draft_id, write=True)

    try:
        await update_outline_episode(draft_id, order, UpdateOutlineEpisodeIn(**fields))
    except Exception as e:  # noqa: BLE001
        raise ToolFailure(getattr(e, "detail", None) or str(e)) from None
    async with session_scope() as s:   # 回读确认
        d = await s.get(ScriptDraft, draft_id)
        ep = next((e for e in ((d.outline or {}).get("chapters") or []) if e.get("order") == order), {})
    missing = [k for k in rest if k not in ep]
    if missing:
        raise ToolFailure(f"回读发现以下字段没有写进去：{missing}")
    return _j({"order": order,
               **({"changed_element": element} if element else {}),
               "synopsis": ep.get("synopsis"),
               "version": ep.get("version"),
               "note": "该集已有的正文/剧本被标为过期，如需同步请重写"})


@engine_tool("regenerate_outline_episode", "overwrite")
async def regenerate_outline_episode(runtime: ToolRuntime[EngineContext], draft_id: int, order: int,
                                     feedback: str) -> str:
    """按修改意见让 AI 重写第 order 集大纲（约 1 分钟，会覆盖该集大纲，自动留历史版本）。
    feedback 要具体：哪里不对、要改成什么。
    order 是「已有最后一集 + 1」时会**新写**这一集（大纲缺集时逐集补齐用），feedback 写这一集该演什么。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=True)
    from ..stages.router import FeedbackRegenerateIn, regenerate_episode_with_feedback
    await regenerate_episode_with_feedback(draft_id, order, FeedbackRegenerateIn(feedback=feedback))
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        ep = next((e for e in ((d.outline or {}).get("chapters") or []) if e.get("order") == order), None)
    if not ep:
        raise ToolFailure("回读找不到该集大纲")
    return _j({k: ep.get(k) for k in _EP_FIELDS if ep.get(k) not in (None, "", [], {})})


@engine_tool("expand_outline_beats", "generate")
async def expand_outline_beats(runtime: ToolRuntime[EngineContext], draft_id: int,
                               orders: list[int] | None = None) -> str:
    """为缺少场景节拍/戏剧契约的集补齐（只补空的，不覆盖已有内容；约 1 分钟/10 集）。
    orders 不传 = 自动挑出所有缺节拍的集。"""
    ctx = _ctx(runtime)
    u = await _guard(ctx, draft_id, write=True)
    from ..stages.router import ExpandOutlineIn, expand_outline_episodes
    # ⚠️ `user=u` **必须传**。`expand_outline_episodes` 是 FastAPI 路由函数，它的
    # `user: User = Depends(get_current_user)` 只在**经由 HTTP 路由**时才会被注入；
    # 在进程内直接调时拿到的是那个 `Depends(...)` 对象本身，函数体里
    # `_check_draft_access(s, draft_id, user, ...)` 一碰 `user.role` 就炸：
    #   AttributeError: 'Depends' object has no attribute 'role'
    # 2026-10-24 生产实测：用户甲这个工具调了 25 次，**25 次全失败**，
    # 而且从引擎上线（e52d64e）起就一直是坏的 —— Agent 只能反复重试、改用别的手段。
    r = await expand_outline_episodes(draft_id, ExpandOutlineIn(orders=orders or None), user=u)
    return _j({k: r.get(k) for k in ("expanded", "requested", "filled", "beats_added", "missing")} if isinstance(r, dict) else r)


@engine_tool("extend_outline", "generate", long_running=True)
async def extend_outline(runtime: ToolRuntime[EngineContext], draft_id: int, target_episode_count: int,
                         guidance: str = "") -> str:
    """把大纲续写到 target_episode_count 集（只续写大纲，不生成剧本）。会等续写完成后返回（每 20 集约 3 分钟）。
    guidance 写期望的后续走向。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=True)
    from ..stages.router import ExtendIn, start_extend
    # 2026-10-28：按**大纲里实际有几集**判断，不看草稿设定的总集数 episode_count ——
    # 生产草稿 #2952 设定 126 集、大纲实际 108 集，这里回"已有 126 集，不需要续写"，Agent 只好绕路。
    async with session_scope() as s:
        d0 = await s.get(ScriptDraft, draft_id)
        before = len(((d0.outline or {}).get("chapters")) or [])
        n_text = (await s.execute(select(func.count()).select_from(ScriptChapter).where(
            ScriptChapter.draft_id == draft_id, func.length(func.coalesce(ScriptChapter.full_text, "")) > 0))).scalar() or 0
    if target_episode_count <= before:
        return _j({"note": f"大纲里已有 {before} 集，不需要续写"})
    # 续写以已生成的正文为基础，没有正文会在后台直接报错退出 —— 而下面会轮询等最长 1 小时
    if not n_text:
        raise ToolFailure(f"续写需要先有正文，这部草稿还没有正文。只补大纲的话，用 regenerate_outline_episode "
                          f"从第 {before + 1} 集起逐集新写，或用 regenerate_outline_range(start_order={before + 1})")
    await start_extend(draft_id, ExtendIn(target_episode_count=target_episode_count, user_guidance=guidance))
    for _ in range(240):                     # 最多等 1 小时
        await asyncio.sleep(15)
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            n = len(((d.outline or {}).get("chapters")) or [])
        if n >= target_episode_count:
            return _j({"episode_count": n, "note": "续写完成"})
    return _j({"episode_count": n, "note": "续写仍在进行或未达目标，请稍后用 get_draft 查看"})


# ================================================================ 正文与剧本
@engine_tool("regenerate_chapter", "overwrite")
async def regenerate_chapter(runtime: ToolRuntime[EngineContext], draft_id: int, order: int, feedback: str) -> str:
    """按修改意见重写第 order 集正文（约 1~2 分钟，覆盖该集正文，自动留历史版本）。feedback 要具体。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=True)
    from ..stages.router import FeedbackRegenerateIn, regenerate_chapter_with_feedback
    await regenerate_chapter_with_feedback(draft_id, order, FeedbackRegenerateIn(feedback=feedback))
    async with session_scope() as s:
        ch = (await s.execute(select(ScriptChapter).where(
            ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == order))).scalar_one_or_none()
    n = len((ch.full_text or "") if ch else "")
    if not n:
        raise ToolFailure("回读发现该集正文为空，重写没有成功")
    return _j({"order": order, "chars": n})


@engine_tool("regenerate_storyboard", "overwrite")
async def regenerate_storyboard(runtime: ToolRuntime[EngineContext], draft_id: int, order: int, feedback: str) -> str:
    """按修改意见重写第 order 集剧本（约 1~3 分钟，覆盖该集剧本，自动留历史版本）。
    feedback 要具体指出问题和改法（例如"第 3 场苏秋月称呼错了，应称'楚探长'"）。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=True)
    from ..stages.router import FeedbackRegenerateIn, regenerate_storyboard_with_feedback
    await regenerate_storyboard_with_feedback(draft_id, order, FeedbackRegenerateIn(feedback=feedback))
    async with session_scope() as s:   # 回读确认（不依赖接口返回结构）
        sb = (await s.execute(select(ScriptStoryboard).where(
            ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == order))).scalar_one_or_none()
    shots = (sb.shots_json if sb else None) or []
    if not shots:
        raise ToolFailure("回读发现该集剧本为空，重写没有成功")
    return _j({"order": order, "scenes": len(shots), "elements": sum(len(x.get("elements") or []) for x in shots),
               "next": "用 read_storyboard 读一遍确认内容"})


@engine_tool("start_rewrite", "overwrite", long_running=True)
async def start_rewrite(runtime: ToolRuntime[EngineContext], draft_id: int, layer: Literal["storyboard", "chapter"],
                        guidance: str = "", start_ep: int = 0, end_ep: int = 0) -> str:
    """整本（或 start_ep~end_ep 范围）AI 精修：先诊断再逐批改写，**会覆盖所选那一层**。
    layer 必填：storyboard 改剧本 / chapter 改正文（平台规定必须明确改哪一层，不会替用户选）。
    用户没说清楚、且这部剧两层都有内容时，先问用户再提交。guidance 写这次精修的重点。
    提交后台作业，返回 job_id，之后用 wait_job 等。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=True)
    from ..agent.chat_jobs import start_rewrite as _sr
    scope = {"start_ep": start_ep or None, "end_ep": end_ep or None, "target": layer}
    res = await _sr(draft_id=draft_id, user_id=ctx.user_id, guidance=guidance or "", scope=scope,
                    model=_writing_model(ctx))
    return await _start_or_existing(draft_id, res, "rewrite_script")


@engine_tool("start_fix", "overwrite", long_running=True)
async def start_fix(runtime: ToolRuntime[EngineContext], draft_id: int, report_id: int, issue_ids: list[str]) -> str:
    """按体检报告里的 issue_id 定点修复（只改问题所在的那几集，改完自动复检）。提交后台作业，返回 job_id。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=True)
    from ..agent.chat_jobs import start_fix as _sf
    res = await _sf(draft_id=draft_id, user_id=ctx.user_id, issue_ids=issue_ids, report_id=report_id,
                    writing_model=_writing_model(ctx))
    return await _start_or_existing(draft_id, res, "fix_script")


@engine_tool("start_deai", "overwrite", long_running=True)
async def start_deai(runtime: ToolRuntime[EngineContext], draft_id: int,
                     target: Literal["inplace", "copy"] = "inplace",
                     inject_level: Literal["none", "light", "medium"] = "light",
                     start_ep: int = 0, end_ep: int = 0,
                     layer: Literal["auto", "storyboard", "chapter"] = "auto") -> str:
    """去 AI 味：逐集清掉 AI 腔并**写回草稿**（只改文字腔调，场次/行数/说话人不变）。
    target=inplace 改在这部剧里（每集先留历史，可「看改动」、可 restore_version 恢复）；
    target=copy 先复制出一部新草稿、改在副本里，原稿不动 —— 用户说"建副本/别动原稿/另存一份"时用它。
    start_ep/end_ep 不传 = 全剧。layer：storyboard=剧本 / chapter=正文 / auto=有剧本改剧本；
    用户说了改哪一层就按用户的传，那层没有内容会失败而不是换层。返回 job_id，用 wait_job 等完成；结果里有改了哪几集、哪几集没改及原因。"""
    ctx = _ctx(runtime)
    u = await _guard(ctx, draft_id, write=(target == "inplace"))
    # 单剧本模式也允许 copy：副本是用户明确要求的、只由这部剧派生，原稿不动（2026-10-30 用户裁定"按需求建副本"）
    if target == "inplace":
        act = await _active_job(draft_id)
        if act:
            return _j({**act, "note": "这部草稿已有任务在跑，等它结束后再去 AI 味（同时改同一集会互相覆盖）"})
    from ..deai.routes import start_deai_apply
    r = await start_deai_apply(draft_id=draft_id, user_id=u.id, target=target, inject_level=inject_level,
                               model=_writing_model(ctx) or "gemini", start_ep=start_ep, end_ep=end_ep,
                               layer=None if layer == "auto" else layer)
    if not r.get("ok"):
        raise ToolFailure(r.get("error") or "提交失败")
    out = {"job_id": r["job_id"], "kind": "deai_apply", "draft_id": r["draft_id"], "status": "queued",
           "next": "用 wait_job(kind=agent) 等它完成；完成后结果里有 applied_eps / skipped"}
    if target == "copy":
        out["note"] = f"已复制出新草稿 #{r['draft_id']}，去 AI 味改在副本上，原稿 #{draft_id} 不动"
    return _j(out)


# ================================================================ 改编
@engine_tool("adapt_analyze", "read")
async def adapt_analyze(runtime: ToolRuntime[EngineContext], draft_id: int) -> str:
    """分析原作，得到改编蓝图（人物、关系、时代、中心矛盾、情绪节拍）。改编的第一步。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=True)   # 会把蓝图缓存进原作
    from ..stages.adaptation import analyze_source
    r = await analyze_source(draft_id)
    if r.get("error"):
        raise ToolFailure(r["error"])
    return _j(r.get("blueprint") or r, 30000)


@engine_tool("adapt_propose", "read")
async def adapt_propose(runtime: ToolRuntime[EngineContext], draft_id: int, guidance: str) -> str:
    """按改编指引生成一套改编设定草案（新标题、时代、地点、中心矛盾、人物、关系、情绪节拍）。
    需先 adapt_analyze。guidance 写清楚改编要求。返回的设定可修改后交给 adapt_commit。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=False)
    from ..stages.adaptation import get_adapt_meta, propose_blueprint
    meta = await get_adapt_meta(draft_id)
    origin = meta.get("cached_blueprint") or {}
    if not origin:
        raise ToolFailure("请先调用 adapt_analyze 生成原作蓝图")
    r = await propose_blueprint(draft_id, origin=origin, guidance=guidance)
    if r.get("error"):
        raise ToolFailure(r["error"])
    return _j({"origin_characters": [c.get("name") for c in origin.get("characters") or []],
               "proposed": r.get("blueprint")}, 30000)


@engine_tool("adapt_commit", "generate", long_running=True)
async def adapt_commit(runtime: ToolRuntime[EngineContext], draft_id: int, contract: dict[str, Any]) -> str:
    """执行改编（后台作业，约 10~30 分钟）：复制出新草稿 → 改编全部分集大纲（含戏剧契约）→ 补场景节拍 →
    一致性校验与结构门禁 → 逐集仿写原作已有的剧本（原作没剧本的集跳过，之后可用 generate_storyboards 生成）。
    contract：title, era, locations[], central_conflict, characters[{name,role,persona}], relations[{a,b,relation,tension}],
    emotion_beats[], name_map{原作人名: 新人名}（必填）, guidance（逐集改编的具体指引）。
    返回 job_id；用 wait_job 等完成，结果里的 new_draft_id 就是新草稿。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=False)
    from ..stages.adaptation import normalize_contract
    contract = normalize_contract(contract)
    if not contract["name_map"]:
        raise ToolFailure("contract 缺少 name_map（原作人名 → 新人名）")
    from ..agent import jobs as _jobs
    from ..stages.router import _active_adapt_job
    act = await _active_adapt_job(draft_id)
    if act:
        return _j({"job_id": act["id"], "status": act["status"], "note": "这部作品已有进行中的改编，未重复提交"})
    _p = {"source_draft_id": draft_id, "contract": contract}
    if _writing_model(ctx):
        _p["writing_model"] = _writing_model(ctx)
    jid = await _jobs.enqueue(kind="adapt_commit", draft_id=draft_id, user_id=ctx.user_id, payload=_p)
    return _j({"job_id": jid, "status": "queued", "next": "用 wait_job 等待；完成后 result.new_draft_id 为新草稿"})


# ================================================================ 批量与管理
@engine_tool("submit_batch_job", "overwrite", scope="global", long_running=True)
async def submit_batch_job(runtime: ToolRuntime[EngineContext], draft_ids: list[int],
                           action_chain: list[Literal["reanalyze", "optimize_by_analysis", "critique",
                                                      "apply_critique", "fill_missing_storyboards"]],
                           title: str = "", auto_apply: bool = False) -> str:
    """对一批草稿在后台顺序执行动作链（上限 300 部）。draft_ids 必须来自 list_drafts 的真实返回。
    动作：reanalyze 重新分析（只读）；optimize_by_analysis 按分析逐集重做剧本（立即覆盖）；
    critique 精修评审（产出建议，需采纳）；apply_critique 采纳评审；fill_missing_storyboards 补齐缺失剧本。
    返回批量作业 job_id（get_job/wait_job 用 kind=batch）。"""
    ctx = _ctx(runtime)
    if ctx.profile != "producer":
        raise ToolFailure("只有全局制片模式可以批量处理")
    from ..agent_batch.routes import SubmitBody, submit
    u = await _user(ctx)
    try:
        r = await submit(SubmitBody(title=title, draft_ids=draft_ids, action_chain=list(action_chain),
                                    auto_apply=auto_apply), user=u)
    except Exception as e:  # noqa: BLE001
        raise ToolFailure(getattr(e, "detail", None) or str(e)) from None
    return _j({k: r.get(k) for k in ("job_id", "total", "auto_apply", "message")} | {"kind": "batch"})


@engine_tool("update_draft_title", "meta")
async def update_draft_title(runtime: ToolRuntime[EngineContext], draft_id: int, title: str) -> str:
    """修改草稿标题。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=True)
    title = (title or "").strip()[:200]
    if not title:
        raise ToolFailure("标题不能为空")
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        d.title = title
        await s.flush()
    async with session_scope() as s:
        got = (await s.get(ScriptDraft, draft_id)).title
    if got != title:
        raise ToolFailure("回读发现标题没有改成功")
    return _j({"draft_id": draft_id, "title": got})


@engine_tool("trash_draft", "delete")
async def trash_draft(runtime: ToolRuntime[EngineContext], draft_id: int) -> str:
    """把草稿移入回收站（可在回收站恢复）。"""
    ctx = _ctx(runtime)
    u = await _guard(ctx, draft_id, write=True)
    from ..features.user_features_routes import move_to_trash
    await move_to_trash(draft_id, user=u)
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
    if not (d and d.is_deleted):
        raise ToolFailure("回读发现草稿没有进入回收站")
    return _j({"draft_id": draft_id, "trashed": True})


# ================================================================ 版本与精确修改
_LAYER = Literal["outline", "chapter", "storyboard"]
_LAYER_NAME = {"outline": "大纲", "chapter": "正文", "storyboard": "剧本"}


@engine_tool("list_versions", "read")
async def list_versions(runtime: ToolRuntime[EngineContext], draft_id: int, order: int, layer: _LAYER) -> str:
    """列出第 order 集某一层（outline 大纲 / chapter 正文 / storyboard 剧本）的历史版本。
    ⚠️ 每个历史版本都是**某次修改发生之前**的内容快照（当前内容不在列表里）。
    所以"撤销最近一次修改"= restore_version 到**最新**的那个历史版本；
    "回到更早的样子"= 选更早的版本。changed_by 表示是哪类修改触发了这次留档。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=False)
    from ..db.models import ScriptEpisodeHistory
    async with session_scope() as s:
        rows = (await s.execute(select(ScriptEpisodeHistory).where(
            ScriptEpisodeHistory.draft_id == draft_id, ScriptEpisodeHistory.episode_order == order,
            ScriptEpisodeHistory.stage == layer).order_by(ScriptEpisodeHistory.created_at.desc()).limit(30))).scalars().all()
    if not rows:
        return f"第{order}集{_LAYER_NAME[layer]}没有历史版本（从未被覆盖过）"
    by = {"user_edit": "用户手动编辑", "ai_generate": "AI 生成/重写", "ai_rewrite": "AI 精修", "restore": "回退"}
    return _j({"note": "以下每个版本 = 那次修改之前的内容；最上面一个就是最近一次修改前的样子",
               "versions": [{"version": r.version,
                             "snapshot_taken_at": r.created_at.isoformat(timespec="minutes") if r.created_at else None,
                             "changed_by": by.get(r.created_by, r.created_by), "from_job": r.job_id,
                             "size": len(json.dumps(r.content, ensure_ascii=False)) if r.content is not None else 0}
                            for r in rows]})


@engine_tool("restore_version", "overwrite")
async def restore_version(runtime: ToolRuntime[EngineContext], draft_id: int, order: int, layer: _LAYER,
                          version: int) -> str:
    """把第 order 集某一层恢复成指定历史版本的内容（版本号来自 list_versions；撤销最近一次修改就选最新的版本）。
    恢复前的当前内容也会自动留一个版本，所以回退本身也可以再撤销。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=True)
    from ..stages.router_m5_enhanced import RestoreVersionIn, restore_episode_version
    try:
        await restore_episode_version(draft_id, order, RestoreVersionIn(stage=layer, version=version))
    except Exception as e:  # noqa: BLE001
        raise ToolFailure(getattr(e, "detail", None) or str(e)) from None
    return _j({"order": order, "layer": _LAYER_NAME[layer], "restored_to": version,
               "next": "用对应的 read_* 工具读一遍确认"})


def _apply_edits(text: str, edits: list[dict], where: str) -> tuple[str, list[str]]:
    report = []
    for ed in edits:
        f, r = str(ed.get("find") or ""), str(ed.get("replace") if ed.get("replace") is not None else "")
        if not f:
            raise ToolFailure("每条修改都要有 find（要被替换的原文）")
        n = text.count(f)
        if n == 0:
            raise ToolFailure(f"在{where}里找不到「{f[:40]}」，没有做任何修改。请先读原文，find 必须与原文逐字一致")
        cap = int(ed.get("max_count") or 0)
        text = text.replace(f, r, cap) if cap > 0 else text.replace(f, r)
        report.append(f"「{f[:30]}」→「{r[:30]}」×{min(n, cap) if cap > 0 else n}")
    return text, report



_SPEAKER_PREFIX = re.compile(r"^\s*([^：:\n]{1,12}?)(?:[（(][^）)]{0,8}[）)])?\s*[：:]\s*")


@engine_tool("edit_storyboard_text", "overwrite")
async def edit_storyboard_text(runtime: ToolRuntime[EngineContext], draft_id: int, order: int,
                               edits: list[dict[str, Any]], scene_no: str | None = None) -> str:
    """对第 order 集剧本做精确的文字替换（改称呼、改一句台词、改道具名等），不重写整集。
    edits：[{"find": "要替换的原文", "replace": "新文字", "speaker": "只改这个角色说的台词（可选）",
             "max_count": 0=全部}]。
    · find 只匹配台词或动作描写的**文字本身**，不含 read_storyboard 显示的「角色名：」前缀
      （带了前缀会自动识别成 speaker）。
    · 只想改某个角色说的话时一定要填 speaker，否则会连别人的台词一起改。
    · scene_no 可限定只改某一场（如 "1-3"）。任何一条一处都没匹配到，整批都不写入。修改前自动留历史版本。"""
    ctx = _ctx(runtime)
    u = await _guard(ctx, draft_id, write=True)
    async with session_scope() as s:
        sb = (await s.execute(select(ScriptStoryboard).where(
            ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == order))).scalar_one_or_none()
    shots = copy.deepcopy(list((sb.shots_json if sb else None) or []))
    if not shots:
        raise ToolFailure(f"第{order}集没有剧本")
    scenes = [sc for sc in shots if not scene_no or str(sc.get("scene_no")) == str(scene_no)]
    if not scenes:
        raise ToolFailure(f"第{order}集没有场次 {scene_no}")
    report = []
    for ed in edits:
        f = str(ed.get("find") or "")
        r = str(ed.get("replace") if ed.get("replace") is not None else "")
        speaker = (ed.get("speaker") or "").strip() or None
        m = _SPEAKER_PREFIX.match(f)
        if m and not speaker and any(m.group(1).strip() == (el.get("character") or "")
                                     for sc in scenes for el in sc.get("elements") or []):
            speaker = m.group(1).strip()
            f = f[m.end():]
            mr = _SPEAKER_PREFIX.match(r)
            if mr and mr.group(1).strip() == speaker:
                r = r[mr.end():]
        if not f:
            raise ToolFailure("每条修改都要有 find（要被替换的原文）")
        cap = int(ed.get("max_count") or 0)
        done = 0
        for sc in scenes:
            for el in sc.get("elements") or []:
                if speaker and not (el.get("type") == "dialogue" and (el.get("character") or "") == speaker):
                    continue
                c = el.get("content") or ""
                n = c.count(f)
                if not n:
                    continue
                if cap:
                    n = min(n, cap - done)
                    if n <= 0:
                        break
                el["content"] = c.replace(f, r, n)
                done += n
        if not done:
            where = f"第{order}集剧本" + (f"场{scene_no}" if scene_no else "") + (f"「{speaker}」的台词" if speaker else "")
            raise ToolFailure(f"在{where}里找不到「{f[:40]}」，没有做任何修改。find 要与台词/动作文字逐字一致"
                              "（不含「角色名：」前缀）；先用 read_storyboard 确认原文")
        report.append(f"{'「' + speaker + '」台词中 ' if speaker else ''}「{f[:30]}」→「{r[:30]}」×{done}")
    from ..stages.router import PatchStoryboardIn, patch_storyboard
    await patch_storyboard(draft_id, order, PatchStoryboardIn(shots_json=shots), user=u)
    async with session_scope() as s:
        got = (await s.execute(select(ScriptStoryboard).where(
            ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == order))).scalar_one()
    if got.shots_json != shots:
        raise ToolFailure("回读发现剧本没有按修改写入")
    return _j({"order": order, "applied": report})


@engine_tool("edit_chapter_text", "overwrite")
async def edit_chapter_text(runtime: ToolRuntime[EngineContext], draft_id: int, order: int,
                            edits: list[dict[str, Any]]) -> str:
    """对第 order 集正文做精确的查找替换，不重写整集。edits 格式同 edit_storyboard_text。
    任何一条找不到都不会写入。修改前自动留历史版本。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=True)
    async with session_scope() as s:
        ch = (await s.execute(select(ScriptChapter).where(
            ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == order))).scalar_one_or_none()
    text = (ch.full_text or "") if ch else ""
    if not text.strip():
        raise ToolFailure(f"第{order}集没有正文")
    new, report = _apply_edits(text, edits, f"第{order}集正文")
    from ..stages.router import PatchChapterIn, patch_chapter
    await patch_chapter(draft_id, order, PatchChapterIn(full_text=new))
    async with session_scope() as s:
        got = (await s.execute(select(ScriptChapter).where(
            ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == order))).scalar_one()
    if got.full_text != new:
        raise ToolFailure("回读发现正文没有按修改写入")
    return _j({"order": order, "applied": report, "chars": len(new)})


# ================================================================ 门禁、分析、基线
@engine_tool("refresh_gate", "read")
async def refresh_gate(runtime: ToolRuntime[EngineContext], draft_id: int) -> str:
    """按当前大纲重新跑一遍剧情结构门禁（不调模型，几秒），并更新草稿概况里的门禁结果。
    修改大纲后、要确认问题是否消除时用它。"""
    ctx = _ctx(runtime)
    u = await _guard(ctx, draft_id, write=False)
    from ..stages.lint_routes import run_drama_gate
    try:
        r = await run_drama_gate(draft_id, user=u)
    except Exception as e:  # noqa: BLE001
        raise ToolFailure(getattr(e, "detail", None) or str(e)) from None
    rep = (r or {}).get("drama_report") or {}
    return _j({"summary": rep.get("summary"), "issues": [
        {"level": i.get("level"), "ep": i.get("episode"), "code": i.get("code"), "msg": i.get("message"),
         "fix": i.get("fix_hint")} for i in (rep.get("issues") or [])]}, 30000)


@engine_tool("start_analysis", "read", long_running=True)
async def start_analysis(runtime: ToolRuntime[EngineContext], draft_id: int) -> str:
    """对全剧做一次剧本分析（综合评分、各维度得分、钩子、风险、受众、改进建议；约 2~5 分钟，只读不改稿）。
    已有分析在跑时返回那一次。之后用 get_analysis(wait_seconds=...) 取结果。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=False)
    from .internal import launch_in_orchestrator
    try:
        r = await launch_in_orchestrator("analysis", ctx.user_id, {"draft_id": draft_id})
    except Exception as e:  # noqa: BLE001
        raise ToolFailure(str(e)) from None
    return _j({k: r.get(k) for k in ("analysis_id", "status", "message") if k in r}
              | {"next": "用 get_analysis 取结果（可带 wait_seconds 等它完成）"})


@engine_tool("get_analysis", "read")
async def get_analysis(runtime: ToolRuntime[EngineContext], draft_id: int, wait_seconds: int = 0) -> str:
    """读取最近一次剧本分析结果：综合等级与分数、各维度分、摘要、风险、改进建议。
    wait_seconds>0 时若分析仍在进行会等它完成（最多 900 秒）。"""
    ctx = _ctx(runtime)
    u = await _guard(ctx, draft_id, write=False)
    from ..analysis.routes import get_latest_analysis
    waited, cap = 0, max(0, min(int(wait_seconds or 0), 900))
    while True:
        a = ((await get_latest_analysis(draft_id, user=u)) or {}).get("analysis")
        if not a:
            return "这部剧还没有分析记录，可用 start_analysis 发起"
        if a.get("status") not in ("pending", "running") or waited >= cap:
            break
        await asyncio.sleep(15)
        waited += 15
    keep = ("id", "status", "overall_grade", "overall_score", "summary", "scores", "scores_json", "risks",
            "risks_json", "suggestions", "suggestions_json", "hooks", "hooks_json", "error", "created_at",
            "progress_step")
    return _j({k: a.get(k) for k in keep if a.get(k) not in (None, "", [], {})}, 30000)


@engine_tool("build_story_bible", "meta")
async def build_story_bible(runtime: ToolRuntime[EngineContext], draft_id: int,
                            source: Literal["chapter", "storyboard"] = "storyboard") -> str:
    """通读全剧抽取设定圣经（人物设定、世界规则、关键事实），供后续生成与一致性检查对照（约 1 分钟）。
    source：依据正文 chapter 还是剧本 storyboard。"""
    ctx = _ctx(runtime)
    u = await _guard(ctx, draft_id, write=True)
    from ..critique.routes import BuildBibleBody, build_bible
    try:
        r = await build_bible(draft_id, BuildBibleBody(source=source), user=u)
    except Exception as e:  # noqa: BLE001
        raise ToolFailure(getattr(e, "detail", None) or str(e)) from None
    return _j(r, 12000)


@engine_tool("backfill_settings", "generate", long_running=True)
async def backfill_settings_tool(runtime: ToolRuntime[EngineContext], draft_id: int,
                                 parts: list[str] | None = None) -> str:
    """从已有稿子**反推**设定：世界观、角色卡（约 1 分钟）。
    parts 可选 world / characters，不传 = 两块都补。
    2026-11-07：逐集契约/伏笔不再反推（大纲只剩正文一个字段，那些字段已无读侧）。
    **只填空，绝不覆盖**：已有值的键不碰，title / synopsis 完全不碰 —— 所以重复调是安全的，
    它不是"重新生成大纲"，不会盖掉用户的分集计划。
    ⚠️ 只能从**已有内容**（正文/剧本/梗概）反推；这三样都没有的草稿补不了。
    草稿是导入骨架（get_draft.outline_is_skeleton=true）时，这是让设定可用的第一步。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=True)
    from ..stages.settings_backfill import ALL_PARTS, backfill_settings, begin_manual, end_manual
    want = tuple(p for p in (parts or ALL_PARTS) if p in ALL_PARTS)
    if not want:
        raise ToolFailure(f"parts 只能是 {list(ALL_PARTS)} 的子集")
    # 与手动端点共用守卫：用户此刻可能正在页面上点「补全设定」，两边一起跑
    # 会各烧一遍模型调用；同时这个标记会让导入时的静默反推让路（见 spawn_silent_backfill）。
    if not begin_manual(draft_id):
        raise ToolFailure("这部剧的设定正在补全中（可能用户刚从页面点了「补全设定」），请稍后再试或直接读结果。")
    try:
        res = await backfill_settings(draft_id, parts=want)
    except Exception as e:  # noqa: BLE001
        raise ToolFailure(getattr(e, "detail", None) or str(e)) from None
    finally:
        end_manual(draft_id)
    # 回读确认：反推的写入在这部草稿上到底落没落。
    from ..stages.outline_density import is_skeleton_outline
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        o = dict(d.outline or {}) if d else {}
    eps = [e for e in (o.get("chapters") or []) if isinstance(e, dict)]
    return _j({
        **(res or {}),
        "after": {"world_filled": bool(o.get("world")), "characters": len(o.get("characters") or []),
                  # 2026-11-07：此过程不再补契约/节拍（大纲只剩正文），
                  # 回读口径改成"正文够厚的集数"，否则会一直报 0 让人误以为没生效。
                  "episodes_with_body": sum(
                      1 for e in eps if len(str(e.get("synopsis") or "").strip()) >= 80)},
        "outline_is_skeleton": is_skeleton_outline(o),
        "note": "只补了空着的字段；已有值原样保留。synopsis 仍是原文切片时，要真大纲需 generate_outline（会覆盖分集计划，先问用户）。",
    }, 12000)


@engine_tool("refresh_ledger", "meta")
async def refresh_ledger(runtime: ToolRuntime[EngineContext], draft_id: int) -> str:
    """按现有正文/剧本重建状态账本（人物位置、伤势、持有物、已知信息等逐集状态），生成与体检都会对照它。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=True)
    from ..stages.router import refresh_ledger as _refresh
    try:
        r = await _refresh(draft_id)
    except Exception as e:  # noqa: BLE001
        raise ToolFailure(getattr(e, "detail", None) or str(e)) from None
    return _j(r, 8000)


@engine_tool("generate_scene_cards", "overwrite")
async def generate_scene_cards(runtime: ToolRuntime[EngineContext], draft_id: int,
                               order: int, expand: bool = False) -> str:
    """生成或重算第 order 集的场景卡（每场的意图与障碍）并写回大纲。

    先从 beats 零成本派生，expand=true 时追加一次 LLM 调用补全 intent/obstacle 字段。
    场景卡是场景节拍（beats）和剧本之间的中间层：beats 告诉生成"演哪几拍"，
    场景卡额外给出"为什么这样演（意图与障碍）"，减少模型自编大纲里没有的内容。
    """
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=True)
    from ..stages.scene_card import derive_from_beats, expand_cards_with_llm, write_cards_to_episode
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise ToolFailure(f"草稿 #{draft_id} 不存在")
        outline = dict(d.outline or {})
    ep = next((c for c in (outline.get("chapters") or [])
               if int(c.get("order") or 0) == int(order)), None)
    if not isinstance(ep, dict):
        raise ToolFailure(f"找不到第 {order} 集大纲")
    if not ep.get("beats"):
        raise ToolFailure(f"第 {order} 集没有场景节拍（beats），无法派生场景卡；请先生成大纲")
    cards = derive_from_beats(ep)
    if expand:
        try:
            from ..models.llm import get_llm as _g  # noqa: F401 — side-effect check
        except Exception:
            pass
        cards = await expand_cards_with_llm(ep, cards)
    write_cards_to_episode(outline, order, cards)
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise ToolFailure(f"草稿 #{draft_id} 不存在")
        d.outline = outline
        s.add(d)
    return _j({
        "episode": order,
        "cards": len(cards),
        "expanded": expand and any(c.get("intent") for c in cards),
        "drama_roles": {c["card_no"]: c["drama_role"] for c in cards if isinstance(c, dict)},
        "first_card": cards[0] if cards else None,
    }, 8000)


@engine_tool("read_scene_cards", "read")
async def read_scene_cards(runtime: ToolRuntime[EngineContext], draft_id: int,
                           order: int) -> str:
    """读取第 order 集已有的场景卡；若没有则实时从 beats 派生（不写回）。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=False)
    from ..stages.scene_card import cards_for_episode, build_scene_cards_block
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise ToolFailure(f"草稿 #{draft_id} 不存在")
        outline = dict(d.outline or {})
    ep = next((c for c in (outline.get("chapters") or [])
               if int(c.get("order") or 0) == int(order)), None)
    if not isinstance(ep, dict):
        raise ToolFailure(f"找不到第 {order} 集大纲")
    cards = cards_for_episode(outline, order)
    persisted = bool(ep.get("scene_cards"))
    return _j({
        "episode": order,
        "persisted": persisted,
        "cards": cards,
        "render_block": build_scene_cards_block(outline, order),
    }, 12000)


@engine_tool("read_ledger", "read")
async def read_ledger(runtime: ToolRuntime[EngineContext], draft_id: int,
                      upto: int = 0) -> str:
    """读取故事状态账本：死亡/存活角色、已揭穿的秘密、未决悬念、已用过的重大元素。

    账本是写作约束的唯一事实源——生成与体检都对照它，Agent 修改或核查剧情前应先读它。
    `upto` 为非零时，只返回截至第 upto 集的快照；为 0 时返回完整累计状态与逐集记录。
    没有账本时返回空骨架提示（可用 refresh_ledger 重建）。
    """
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=False)
    from ..stages.state_ledger import snapshot, snapshot_text
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise ToolFailure(f"草稿 #{draft_id} 不存在")
        o = d.outline or {}
    # 优先用有效账本（已按实际稿子校正），退而用计划账本
    ledger = o.get("state_ledger_effective") or o.get("state_ledger")
    if not ledger:
        return _j({
            "warning": "该草稿暂无状态账本，可用 refresh_ledger 重建。",
            "cumulative": {"alive": [], "dead": [], "open_threads": [],
                           "resolved_threads": [], "revealed_secrets": [],
                           "used_elements": []},
            "by_episode": {},
        }, 8000)
    if upto:
        snap = snapshot(ledger, int(upto))
        return _j({
            "snapshot_upto": int(upto),
            "text": snapshot_text(ledger, int(upto)),
            **snap,
        }, 8000)
    # 完整账本：cumulative + 逐集
    return _j({
        "source": "effective" if o.get("state_ledger_effective") else "plan",
        "cumulative": ledger.get("cumulative") or {},
        "by_episode": ledger.get("by_episode") or {},
    }, 20000)


@engine_tool("diagnose_timeline", "read")
async def diagnose_timeline(runtime: ToolRuntime[EngineContext], draft_id: int) -> str:
    """AI 诊断全剧事件分布节奏：哪些集过载、哪些集空洞、建议把哪些事件挪到哪一集（只分析不改大纲）。"""
    ctx = _ctx(runtime)
    u = await _guard(ctx, draft_id, write=False)
    from ..narrative.routes import diagnose_timeline as _diag
    try:
        return _j(await _diag(draft_id, user=u), 30000)
    except Exception as e:  # noqa: BLE001
        raise ToolFailure(getattr(e, "detail", None) or str(e)) from None


@engine_tool("rebalance_timeline", "overwrite")
async def rebalance_timeline(runtime: ToolRuntime[EngineContext], draft_id: int) -> str:
    """AI 重新分配全剧事件节奏并**改写大纲**；受影响的集其正文/剧本会被标为过期，需要再重写。"""
    ctx = _ctx(runtime)
    u = await _guard(ctx, draft_id, write=True)
    from ..narrative.routes import rebalance_timeline as _reb
    try:
        return _j(await _reb(draft_id, user=u), 20000)
    except Exception as e:  # noqa: BLE001
        raise ToolFailure(getattr(e, "detail", None) or str(e)) from None


@engine_tool("regenerate_outline_range", "overwrite")
async def regenerate_outline_range(runtime: ToolRuntime[EngineContext], draft_id: int, start_order: int,
                                   end_order: int) -> str:
    """重新生成第 start_order~end_order 集大纲（覆盖，自动留历史版本；超出已有集数的部分会新写）。
    适合一段剧情整体走偏时重做。逐集生成、逐集保存：中途失败时已写好的集保留，
    返回 saved_orders 与 failed_at，从 failed_at 继续即可。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=True)
    from ..stages.router_m5_regenerate import RegenerateRangeIn, regenerate_outline_range as _rr
    try:
        r = await _rr(draft_id, RegenerateRangeIn(start_order=start_order, end_order=end_order))
    except Exception as e:  # noqa: BLE001
        raise ToolFailure(getattr(e, "detail", None) or str(e)) from None
    return _j(r if isinstance(r, dict) else {"ok": True}, 8000)


# ================================================================ 角色
@engine_tool("get_characters", "read")
async def get_characters(runtime: ToolRuntime[EngineContext], draft_id: int) -> str:
    """查看角色：花名册与角色圣经、角色卡、人物关系、未处理的人设冲突预警。"""
    ctx = _ctx(runtime)
    u = await _guard(ctx, draft_id, write=False)
    from ..features.phase5_routes import list_characters, list_relationships, list_warnings
    from ..stages.router import get_draft_characters
    reg = await get_draft_characters(draft_id, user=u)
    cards = await list_characters(draft_id, user=u)
    rels = await list_relationships(draft_id, user=u)
    warns = await list_warnings(draft_id, user=u)
    items = lambda x: x.get("items", x) if isinstance(x, dict) else x  # noqa: E731
    w = [x for x in (items(warns) or []) if isinstance(x, dict) and not x.get("resolved")]
    return _j({"registry": reg.get("registry"), "bible": reg.get("bible"),
               "cards": [{k: c.get(k) for k in ("name", "role", "personality", "backstory") if c.get(k)}
                         for c in (items(cards) or []) if isinstance(c, dict)],
               "relationships": items(rels), "open_warnings": w}, 40000)


@engine_tool("extract_characters", "overwrite")
async def extract_characters(runtime: ToolRuntime[EngineContext], draft_id: int) -> str:
    """从正文重新抽取角色花名册与角色圣经（会覆盖「角色」页现有内容；需要先有正文）。"""
    ctx = _ctx(runtime)
    u = await _guard(ctx, draft_id, write=True)
    from ..stages.router import extract_draft_characters
    try:
        r = await extract_draft_characters(draft_id, user=u)
    except Exception as e:  # noqa: BLE001
        raise ToolFailure(getattr(e, "detail", None) or str(e)) from None
    return _j(r, 12000)


@engine_tool("build_character_cards", "generate")
async def build_character_cards(runtime: ToolRuntime[EngineContext], draft_id: int) -> str:
    """全盘扫描剧情，生成全员角色卡与人际关系网（约 1~3 分钟，完成后返回数量）。"""
    ctx = _ctx(runtime)
    u = await _guard(ctx, draft_id, write=True)
    from ..features.character_cards_worker import build_character_cards as _build
    from ..features.phase5_routes import list_characters, list_relationships
    await _build(draft_id)
    items = lambda x: x.get("items", x) if isinstance(x, dict) else x  # noqa: E731
    return _j({"cards": len(items(await list_characters(draft_id, user=u)) or []),
               "relationships": len(items(await list_relationships(draft_id, user=u)) or []),
               "next": "用 get_characters 查看"})


@engine_tool("scan_character_warnings", "read")
async def scan_character_warnings(runtime: ToolRuntime[EngineContext], draft_id: int) -> str:
    """扫描人设一致性（性格/称呼/关系前后矛盾等），返回未处理的预警（约 1~3 分钟，只标注不修改）。"""
    ctx = _ctx(runtime)
    u = await _guard(ctx, draft_id, write=False)
    from ..features.character_consistency_worker import scan_character_consistency
    from ..features.phase5_routes import list_warnings
    await scan_character_consistency(draft_id)
    ws = await list_warnings(draft_id, user=u)
    ws = ws.get("items", ws) if isinstance(ws, dict) else ws
    return _j([w for w in (ws or []) if isinstance(w, dict) and not w.get("resolved")], 20000)


@engine_tool("replace_character_names", "overwrite")
async def replace_character_names(runtime: ToolRuntime[EngineContext], draft_id: int, mapping: dict[str, str]) -> str:
    """把人名批量替换为新名字，作用于全剧大纲、正文、剧本（如 {"陆淮": "刘淮"}；自动留历史版本）。"""
    ctx = _ctx(runtime)
    u = await _guard(ctx, draft_id, write=True)
    mapping = {str(k).strip(): str(v).strip() for k, v in (mapping or {}).items() if str(k).strip() and str(v).strip()}
    if not mapping:
        raise ToolFailure("mapping 为空")
    from ..features.video_routes import CharacterReplaceIn, character_replace
    try:
        r = await character_replace(draft_id, CharacterReplaceIn(mapping=mapping), user=u)
    except Exception as e:  # noqa: BLE001
        raise ToolFailure(getattr(e, "detail", None) or str(e)) from None
    return _j(r, 8000)


# ================================================================ 衍生产出
async def _start_product(ctx: EngineContext, draft_id: int, kind: str) -> str:
    await _guard(ctx, draft_id, write=True)
    from .internal import launch_in_orchestrator
    try:
        r = await launch_in_orchestrator("novel_tweet", ctx.user_id, {"draft_id": draft_id, "gen_kind": kind})
    except Exception as e:  # noqa: BLE001
        raise ToolFailure(str(e)) from None
    if not r.get("ok"):
        raise ToolFailure(r.get("error") or "提交失败")
    return _j({"job_id": r.get("job_id"), "kind": "novel_tweet", "planned_episodes": r.get("planned"),
               "next": "用 wait_job(kind=novel_tweet) 等它完成"})


@engine_tool("generate_novel", "generate", long_running=True)
async def generate_novel(runtime: ToolRuntime[EngineContext], draft_id: int) -> str:
    """把现有正文逐章改写成网文小说版（另存为小说版本，不覆盖正文；需要先有正文）。返回 job_id。"""
    return await _start_product(_ctx(runtime), draft_id, "novel")


@engine_tool("generate_tweet", "generate", long_running=True)
async def generate_tweet(runtime: ToolRuntime[EngineContext], draft_id: int) -> str:
    """把现有正文逐章改写成第一人称推文版（另存，不覆盖正文；需要先有正文）。返回 job_id。"""
    return await _start_product(_ctx(runtime), draft_id, "tweet")


@engine_tool("read_product", "read")
async def read_product(runtime: ToolRuntime[EngineContext], draft_id: int,
                       kind: Literal["novel", "tweet"], order: int) -> str:
    """读取第 order 章的小说版或推文版全文。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=False)
    from ..adapt_products.models import ChapterAdaptation
    async with session_scope() as s:
        a = (await s.execute(select(ChapterAdaptation).where(
            ChapterAdaptation.draft_id == draft_id, ChapterAdaptation.kind == kind,
            ChapterAdaptation.chapter_order == order))).scalars().first()
    if not a or not (a.content or "").strip():
        raise ToolFailure(f"第 {order} 章还没有{'小说版' if kind == 'novel' else '推文版'}")
    return _j({"order": order, "kind": kind, "chars": len(a.content or ""),
               "user_edited": bool(a.user_edited), "content": a.content}, 30000)


@engine_tool("regenerate_product", "overwrite")
async def regenerate_product(runtime: ToolRuntime[EngineContext], draft_id: int,
                             kind: Literal["novel", "tweet"], order: int, feedback: str) -> str:
    """按修改意见重写第 order 章的小说版或推文版（约 1 分钟，覆盖该章，自动留历史版本）。feedback 要具体。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=True)
    if not (feedback or "").strip():
        raise ToolFailure("请给出具体的修改意见")
    from ..adapt_products import service as _ap
    try:
        content = await _ap.regenerate_one(draft_id, kind, order, "gemini", feedback=feedback)
    except ValueError as e:
        raise ToolFailure(str(e)) from None
    if not (content or "").strip():
        raise ToolFailure("回读发现该章内容为空，重写没有成功")
    return _j({"order": order, "kind": kind, "chars": len(content),
               "next": "用 read_product 读一遍、或 check_products 复查"})


@engine_tool("export_docx", "export")
async def export_docx(runtime: ToolRuntime[EngineContext], draft_id: int,
                      mode: Literal["auto", "all_storyboard", "all_chapter"] = "auto") -> str:
    """把整部剧导出成 Word 文档，返回下载链接。mode：auto 有剧本用剧本、没剧本用正文；
    all_storyboard 仅剧本；all_chapter 仅正文。"""
    ctx = _ctx(runtime)
    await _guard(ctx, draft_id, write=False)
    from ..db.models_phase5 import ExportJob
    from ..features.export_worker import run_export_job
    async with session_scope() as s:
        j = ExportJob(user_id=ctx.user_id, draft_id=draft_id, kind="mixed_docx", config_json={"mode": mode})
        s.add(j)
        await s.flush()
        jid = j.id
    await run_export_job(jid)
    async with session_scope() as s:
        j = await s.get(ExportJob, jid)
    if j.status != "done" or not j.output_url:
        raise ToolFailure(f"导出失败：{j.error or j.status}")
    return _j({"download_url": j.output_url, "note": "把这个链接原样给用户；链接有有效期"})


# ================================================================ 批量产出（全局）
@engine_tool("start_spawn", "generate", scope="global", long_running=True)
async def start_spawn(runtime: ToolRuntime[EngineContext], source_draft_id: int, count: int = 3,
                      mode: Literal["clone", "homage", "inspired"] = "homage", intent: str = "") -> str:
    """裂变：以一部剧为母本，一次生成 count 部（1~10）**新故事**，每部是独立新草稿，**只生成大纲**。
    mode：clone 贴近原作结构 / homage 致敬（默认）/ inspired 只借灵感。intent 写清想要的方向。
    ⚠️ 它从原作的章节摘要提炼"DNA"再另写，不读原文；即使 clone 模式，情节保真也很低。
    用户要"高度还原/照着原作改"时不要单独用它交付，按系统提示里的"还原改编"流程做。
    返回裂变作业 job_id（kind=spawn）。"""
    ctx = _ctx(runtime)
    if ctx.profile != "producer":
        raise ToolFailure("只有全局制片模式可以裂变")
    await _guard(ctx, source_draft_id, write=False)
    from .internal import launch_in_orchestrator
    try:
        r = await launch_in_orchestrator("spawn", ctx.user_id, {"source_draft_id": source_draft_id, "count": count,
                                                                  "mode": mode, "intent": intent, "two_stage": False})
    except Exception as e:  # noqa: BLE001
        raise ToolFailure(str(e)) from None
    jid = r.get("job_id") or r.get("id") or (r.get("job") or {}).get("id")
    return _j({"job_id": jid, "kind": "spawn", "next": "用 wait_job(kind=spawn) 等完成，结果里有各新草稿 id"})


@engine_tool("batch_create_drafts", "generate", scope="global", long_running=True)
async def batch_create_drafts(runtime: ToolRuntime[EngineContext], direction: str, count: int = 5,
                              episodes: int = 12, mode: Literal["script", "novel"] = "script") -> str:
    """按一个创作方向一次批量新建 count 部草稿（≤100）并自动跑完大纲与剧本（mode=script）或正文（novel）。
    direction 写题材、时代、粗略情节。返回批量作业 job_id（kind=batch_create）。"""
    ctx = _ctx(runtime)
    if ctx.profile != "producer":
        raise ToolFailure("只有全局制片模式可以批量创建")
    from .internal import launch_in_orchestrator
    try:
        r = await launch_in_orchestrator("batch_create", ctx.user_id, {"direction": direction, "count": count,
                                                                         "episodes": episodes, "mode": mode})
    except Exception as e:  # noqa: BLE001
        raise ToolFailure(str(e)) from None
    return _j({"job_id": r.get("id") or r.get("job_id"), "kind": "batch_create", "count": count,
               "next": "用 wait_job(kind=batch_create) 等完成"})


# ===========================================================================
# 第六步：聚合工具（精简配置档 minimal 专用）
# 内部实现全部调已有工具，老工具保留为内部实现。
# ===========================================================================

# 聚合工具 → 实际执行的老工具。一处定义，执行（_run_aggregate）、审批（policy）、
# 桌面端的通宵拦截与慢工具转作业都按它解析出来的老工具判断，所以老工具上的
# 安全规则（删除必确认、取消必确认、通宵不删稿）对聚合入口同样生效。
AGGREGATES = frozenset({"script_draft", "script_read", "script_write", "script_check", "script_job", "script_cancel"})
_JOB_KINDS = frozenset(JobKind.__args__)

#: 老工具结果里提示"下一步调哪个工具"时用的名字 → 6 个工具里的等价调用。
_HINT_NAMES = {
    "wait_job": 'script_job(action="wait")', "get_job": 'script_job(action="status")', "draft_activity": 'script_job(action="activity")',
    "generate_outline": 'script_write(layer="outline")', "regenerate_outline_episode": 'script_write(layer="outline", scope="single")',
    "read_storyboard": 'script_read(layer="storyboard")', "read_chapter": 'script_read(layer="chapter")',
    "read_outline": 'script_read(layer="outline")', "read_scene_cards": 'script_read(layer="scene_cards")',
    "get_characters": 'script_read(layer="characters")', "get_draft": 'script_draft(action="info")',
    "list_drafts": 'script_draft(action="list")', "list_versions": 'script_draft(action="versions")',
    "restore_version": 'script_draft(action="restore")', "cancel_draft_tasks": "script_cancel",
    "generate_storyboards": 'script_write(layer="storyboard")', "generate_chapters": 'script_write(layer="chapter")',
    "regenerate_storyboard": 'script_write(layer="storyboard", task="revise")',
    "regenerate_chapter": 'script_write(layer="chapter", task="revise")',
    "regenerate_outline_range": 'script_write(layer="outline", scope="range")',
    "run_check": 'script_check(layer="outline")', "check_storyboards": 'script_check(layer="storyboard")',
    "check_mainline": 'script_check(layer="mainline")',
}
_HINT_NAMES["read_*"] = "read"
_HINT_RE = re.compile(r"(?<![A-Za-z0-9_])(" + "|".join(re.escape(k) for k in _HINT_NAMES) + r")(?![A-Za-z0-9_])")


def _need(cond: Any, msg: str) -> None:
    if not cond:
        raise ToolFailure(msg)


def aggregate_target(name: str, args: dict) -> tuple[str, dict]:
    """把一次聚合工具调用解析成 ``(老工具名, 老工具参数)``；参数不对时抛 ToolFailure。"""
    a = {k: v for k, v in (args or {}).items() if v is not None}
    did = a.get("draft_id")
    order, start, end = int(a.get("order") or 0), int(a.get("start") or 0), int(a.get("end") or 0)
    if name == "script_draft":
        action = a.get("action")
        if action == "list":
            return "list_drafts", {"limit": 20, **({"keyword": a["keyword"]} if a.get("keyword") else {})}
        if action in ("info", "rename", "delete", "versions", "restore"):
            _need(did, f"{action} 需要 draft_id")
        if action == "info":
            return "get_draft", {"draft_id": did}
        if action == "create":
            _need(a.get("title"), "create 需要 title（剧名或创作方向）")
            return "create_draft", {"title": a["title"], "idea": a.get("direction") or a["title"],
                                    "episode_count": int(a.get("episodes") or 60)}
        if action == "rename":
            _need(a.get("title"), "rename 需要 title")
            return "update_draft_title", {"draft_id": did, "title": a["title"]}
        if action == "delete":
            return "trash_draft", {"draft_id": did}
        if action in ("versions", "restore"):
            _need(order, f"{action} 需要 order（集号）")
            layer = a.get("layer") or "storyboard"
            if action == "versions":
                return "list_versions", {"draft_id": did, "order": order, "layer": layer}
            _need(a.get("version"), "restore 需要 version（版本号，先用 versions 看）")
            return "restore_version", {"draft_id": did, "order": order, "layer": layer, "version": int(a["version"])}
        raise ToolFailure(f"未知 action：{action!r}，可选：list/info/create/rename/delete/versions/restore")
    if name == "script_read":
        layer = a.get("layer")
        if layer in ("chapter", "storyboard"):
            _need(order, f"{layer} 需要 order（集号）")
        table = {
            "outline": ("read_outline", {"draft_id": did, "start": start, "end": end}),
            "chapter": ("read_chapter", {"draft_id": did, "order": order}),
            "storyboard": ("read_storyboard", {"draft_id": did, "order": order}),
            # 2026-11-07：scene_cards 层随场景卡一起停用（beats 取消后它没有原料）。
            # 留着这一行会让 Agent 调到一个必然报错的分支，比没有更糟。
            "ledger": ("read_ledger", {"draft_id": did, "upto": order}),
            "check": ("run_check", {"draft_id": did}),
            "characters": ("get_characters", {"draft_id": did}),
        }
        _need(layer in table, f"未知 layer：{layer!r}，可选：{'/'.join(table)}")
        return table[layer]
    if name == "script_write":
        layer, task, scope, intent = a.get("layer"), a.get("task") or "generate", a.get("scope") or "all", a.get("intent") or ""
        revising = task in ("revise", "rewrite") or bool(intent)
        rng = {"start": start, "end": end} if scope == "range" else {}
        if scope == "range":
            _need(start and end, "range 需要 start 和 end")
        if layer == "outline":
            if scope == "single":
                _need(order, "scope=single 需要 order")
                # 2026-11-07 用户裁定：**不给 Agent 直写整段正文的能力。**
                # 原文："agent 可能并不能保证自己总能拿到正确的上下文拼接，这个能力
                # 应该仅仅在人工干预明确指明该改什么时才用，绝不能让 agent 自己直接乱改。"
                # 所以这里只走"按意见让平台重写整集"，不提供覆盖正文的入口；
                # 要精确改某一个要素，走 patch_outline_episode（点名到要素、永远需确认）。
                return "regenerate_outline_episode", {"draft_id": did, "order": order, "feedback": intent}
            if scope == "range":
                _need(not intent, "区间重写大纲不接受修改意见；要按意见改，请逐集用 scope=single")
                return "regenerate_outline_range", {"draft_id": did, "start_order": start, "end_order": end}
            return "generate_outline", {"draft_id": did, "guidance": intent}
        if layer in ("chapter", "storyboard"):
            if revising:
                _need(order, f"按意见改{('正文' if layer == 'chapter' else '剧本')}需要 order（集号）")
                return ("regenerate_chapter" if layer == "chapter" else "regenerate_storyboard"), \
                    {"draft_id": did, "order": order, "feedback": intent}
            return ("generate_chapters" if layer == "chapter" else "generate_storyboards"), \
                {"draft_id": did, **rng, "guidance": intent}
        if layer == "scene_cards":
            # 2026-11-07：场景卡随 beats 一起停用。这里明确说"已下线"，
            # 比让它走通再失败要好 —— 模型会照着报错去猜别的参数。
            raise ToolFailure(
                "场景卡已下线：大纲正文本身就写清了一集要演什么，"
                "直接 script_write(layer=\"storyboard\", scope=\"single\", order=N) 生成剧本即可。")
        raise ToolFailure(f"未知 layer：{layer!r}，可选：outline/chapter/storyboard")
    if name == "script_check":
        layer = a.get("layer") or "outline"
        if layer == "outline":
            return "run_check", {"draft_id": did}
        if layer == "storyboard":
            return "check_storyboards", {"draft_id": did, "start_ep": start, "end_ep": end}
        if layer in ("mainline", "mainline_storyboard"):
            return "check_mainline", {"draft_id": did, "layer": "storyboard" if layer == "mainline_storyboard" else "outline",
                                      "start_ep": start, "end_ep": end}
        raise ToolFailure(f"未知 layer：{layer!r}，可选：outline/storyboard/mainline/mainline_storyboard")
    if name == "script_job":
        action = a.get("action")
        # write 返回的 kind 是具体作业类型（gen_outline、gen_storyboards…），它们都属于 agent 作业队列。
        kind = {"kind": a["kind"] if a.get("kind") in _JOB_KINDS else "agent"}
        if action in ("status", "wait"):
            _need(str(a.get("job_id") or "").strip().isdigit(), f"{action} 需要 job_id（数字）")
            jid = int(a["job_id"])
            if action == "status":
                return "get_job", {"job_id": jid, **kind}
            return "wait_job", {"job_id": jid, **kind, "max_wait_seconds": int(a.get("timeout") or 120)}
        if action == "activity":
            _need(did, "activity 需要 draft_id")
            return "draft_activity", {"draft_id": did}
        raise ToolFailure(f"未知 action：{action!r}，可选：status/wait/activity")
    if name == "script_cancel":
        return "cancel_draft_tasks", {"draft_id": did, "confirm_text": a.get("confirm_text") or ""}
    raise ToolFailure(f"不是聚合工具：{name}")


def resolve_tool(name: str, args: dict) -> tuple[str, dict]:
    """聚合工具解析成老工具；老工具原样返回。参数不对时返回聚合工具本身（执行时会报出原因）。"""
    if name not in AGGREGATES:
        return name, args
    try:
        return aggregate_target(name, args)
    except ToolFailure:
        return name, args


async def _run_aggregate(runtime: ToolRuntime[EngineContext], name: str, args: dict) -> str:
    inner, inner_args = aggregate_target(name, args)
    if _ctx(runtime).profile == "readonly" and META[inner].risk != "read":
        raise ToolFailure("只读诊断模式下不能修改内容")
    return rewrite_hints(await _TOOLS[inner].coroutine(runtime=runtime, **inner_args))


def rewrite_hints(out: Any) -> Any:
    """把老工具结果里"下一步调哪个工具"的名字改写成 6 个工具的写法（聚合入口的结果都要过这一步）。"""
    return _HINT_RE.sub(lambda m: _HINT_NAMES[m.group(1)], out) if isinstance(out, str) else out


@engine_tool("script_draft", "read", scope="global")
async def draft_tool(
    runtime: ToolRuntime[EngineContext],
    action: Literal["list", "info", "create", "rename", "delete", "versions", "restore"],
    draft_id: int | None = None,
    keyword: str | None = None,
    title: str | None = None,
    direction: str | None = None,
    episodes: int = 60,
    order: int = 0,
    layer: Literal["outline", "chapter", "storyboard"] = "storyboard",
    version: int | None = None,
) -> str:
    """草稿与版本管理。

    action：
    - list      最近的草稿；keyword 按剧名找（用户说名字时用它）
    - info      草稿概况（标题、集数、各层进度）
    - create    新建草稿：title（剧名或方向）、direction（一句话创意，可选）、episodes（集数，默认 60）
    - rename    改标题：draft_id + title
    - delete    移入回收站：draft_id
    - versions  某集的历史版本：draft_id + order（+ layer，默认剧本）
    - restore   回退到某一版：draft_id + order + version（+ layer）
    """
    return await _run_aggregate(runtime, "script_draft", {
        "action": action, "draft_id": draft_id, "keyword": keyword, "title": title, "direction": direction,
        "episodes": episodes, "order": order, "layer": layer, "version": version})


@engine_tool("script_read", "read")
async def read_tool(
    runtime: ToolRuntime[EngineContext],
    draft_id: int,
    layer: Literal["outline", "chapter", "storyboard", "ledger", "check", "characters"],
    start: int = 0,
    end: int = 0,
    order: int = 0,
) -> str:
    """读取任意阶段的产物。

    layer：
    - outline      分集大纲（start/end 限定集号，0 = 全部）
    - chapter      单集正文，需要 order
    - storyboard   单集剧本，需要 order
    - ledger       状态账本（截至第 order 集；0 = 完整账本）
    - check        大纲结构验收单
    - characters   角色表
    """
    return await _run_aggregate(runtime, "script_read", {
        "draft_id": draft_id, "layer": layer, "start": start, "end": end, "order": order})


@engine_tool("script_write", "overwrite")
async def write_tool(
    runtime: ToolRuntime[EngineContext],
    draft_id: int,
    layer: Literal["outline", "chapter", "storyboard"],
    task: Literal["generate", "revise", "rewrite"] = "generate",
    scope: Literal["all", "single", "range"] = "all",
    intent: str = "",
    order: int = 0,
    start: int = 0,
    end: int = 0,
    expand_scene_cards: bool = False,
) -> str:
    """生成、重做或按意见修改某一层产物。

    layer：outline（大纲）/ chapter（正文）/ storyboard（剧本）
    task：generate 初次生成（默认）；revise 按意见改，intent 写具体意见；rewrite 不带意见重写
    scope：all 全部；single 单集（order）；range 区间（start + end）

    改稿一律走"写意见让平台重写"，这里**不接受**你直接给出正文 ——
    你并不总能拿到完整上下文，直接覆盖会把用户没提到的段落一起改坏。
    只改某一句台词/某个要素，用对应的 edit_* / patch_* 工具点名改。

    批量生成（generate）是后台作业，返回 job_id 后用 script_job(action="wait", job_id=…) 等它完成。
    按意见改单集通常几十秒内直接返回结果。
    """
    return await _run_aggregate(runtime, "script_write", {
        "draft_id": draft_id, "layer": layer, "task": task, "scope": scope, "intent": intent,
        "order": order, "start": start, "end": end, "expand_scene_cards": expand_scene_cards})


@engine_tool("script_check", "read")
async def check_tool(
    runtime: ToolRuntime[EngineContext],
    draft_id: int,
    layer: Literal["outline", "storyboard", "mainline", "mainline_storyboard"] = "outline",
    start: int = 0,
    end: int = 0,
) -> str:
    """出验收单。

    layer：
    - outline     大纲结构门禁（价值转变、钩子、升级、伏笔等）
    - storyboard  剧本机械指标（字数、对白比例、连续动作行、静默场）
    - mainline             大纲的主线一致性；不过关的集带 fix_feedback
    - mainline_storyboard  剧本的主线一致性；不过关的集带 fix_feedback
    start/end 限定集号，0 = 全部。
    """
    return await _run_aggregate(runtime, "script_check", {"draft_id": draft_id, "layer": layer, "start": start, "end": end})


@engine_tool("script_job", "read", scope="global")
async def job_tool(
    runtime: ToolRuntime[EngineContext],
    action: Literal["status", "wait", "activity"],
    job_id: int | None = None,
    draft_id: int | None = None,
    kind: str | None = None,
    timeout: int = 120,
) -> str:
    """查看或等待后台作业。

    action：
    - status    作业状态：job_id
    - wait      等作业完成：job_id（timeout 秒，默认 120）；没等完就再调一次
    - activity  这部草稿现在在跑什么：draft_id
    kind：write / check 返回里的 kind 照填即可；不填按 agent。
    """
    return await _run_aggregate(runtime, "script_job", {
        "action": action, "job_id": job_id, "draft_id": draft_id, "kind": kind, "timeout": timeout})


@engine_tool("script_cancel", "overwrite")
async def cancel_tool(
    runtime: ToolRuntime[EngineContext],
    draft_id: int,
    confirm_text: str = "",
) -> str:
    """取消这部草稿上正在跑的后台任务：当前这一集写完后停下，已完成的稿子不丢。

    confirm_text 写用户同意取消的原话。
    """
    return await _run_aggregate(runtime, "script_cancel", {"draft_id": draft_id, "confirm_text": confirm_text})
