"""定点修复器 —— 体检发现的问题, 按集最小改动地修掉。

与 rewrite/ 的分工(这是本模块存在的理由):

| | rewrite/service.py | check/fixer.py |
|---|---|---|
| 触发 | 用户说"整本精修一遍" | 体检报告卡上点"让 AI 改这个"/"一键全修" |
| 改动面 | **整本覆写**(每批 6 集全量重写) | **只动被点名的那几集, 且只动相关句子** |
| 依据 | 第一轮诊断(自由发挥) | 结构化的 issue 列表(精确到集) |
| 风险 | 高(全本重写 ⇒ 文风漂移、末尾退化) | 低(未点名的集一字不碰) |
| 验证 | 场次/字数不雪崩 | 往返等价 + 字数不雪崩 + **修后复检数字必须下降** |

用户不喜欢每步确认, 所以修复**不问**是否继续: 能修的集直接改、改不了的如实说,
改前存 History 可回滚。但**绝不假装成功** —— 修完立刻复检, error 数没降就照实说。

三条安全线:
  1. **只信 issue_id, 不信前端传来的 message/fix_hint**。前端被篡改(或版本漂移)
     不可能让引擎去执行一条凭空捏造的问题。
  2. **往返等价**: 剧本修完必须能被 parser 拆回 → 否则这一集作废、保持原稿。
  3. **字数雪崩**: 修完比原文短一半或长一倍 → 说明模型删戏或加戏了, 作废。
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from ..db import session_scope, ScriptChapter, ScriptStoryboard
from ..models.llm import get_llm
from ..rewrite.parser import parse_episode, roundtrip_equivalent
from . import prompts as P
from .engine import load_draft_episodes, _pack, KIND_LABEL

logger = logging.getLogger("check.fixer")

#: 字数雪崩阈值: 修复后与修复前的长度比必须落在这个区间。
#: 超出即判定"模型删戏/加戏", 该集作废。修复名义上是"只改相关句子",
#: 正常改动量远小于 30%, 留到 0.5~2.0 是为了容忍模型顺手重排段落。
_MIN_RATIO, _MAX_RATIO = 0.5, 2.0

#: 单次修复最多处理的集数。防止用户点"一键全修"时把 50 集全丢给 LLM
#: —— 那样既慢又容易让模型在第 40 集开始敷衍(正是我们要修的病)。
#: 超出的部分如实告知"这次先修了 N 集, 剩下的一起再点一次"。
MAX_EPS_PER_RUN = 20

_RE_EP_HEAD = re.compile(r"^第\s*(\d+)\s*集")


# ---------------------------------------------------------------------------
# issue 索引: 体检结果 → {issue_id: issue}
# ---------------------------------------------------------------------------

def index_issues(report: dict) -> dict[str, dict]:
    """把整份报告的 issues 摊平成 {id: issue + kind}, 供按 id 取回。

    id 统一为 ``{kind}:{code}-{ep}-{i}``(与 engine.run_check 的 issues_flat 一致)。
    必须加 kind 前缀: 修复是**按 id 回传**的, 两个区块的 code 撞名时, 用户点 A 会被修成 B。
    """
    out: dict[str, dict] = {}
    for kind, c in (report.get("checks") or {}).items():
        for it in (c.get("issues") or []):
            iid = it.get("id")
            if not iid:
                continue
            key = iid if ":" in iid else f"{kind}:{iid}"
            out[key] = {**it, "id": key, "kind": kind}
    return out


# ---------------------------------------------------------------------------
# 分派: 大纲类问题 → outline 补丁; 正文/剧本类 → 整集重写
# ---------------------------------------------------------------------------

#: 这些 code 属于"大纲字段"问题, 走 outline patch 而不是改正文。
#: 判据不是 code 而是 episode + kind: structure 区块的问题全在大纲里。
def _target_of(kind: str, issue: dict) -> str:
    if kind == "structure":
        return "outline"
    return "script"


async def run_fix(*, draft_id: int, issue_index: dict, issue_ids: list,
                  provider: str = "gemini", user_id: int | None = None,
                  progress=None) -> dict:
    """修复指定问题。返回 {fixed_eps, failed_eps, outline_patched, issues_after, before/after}。

    issue_index: 来自 check_reports.issue_index（服务端存的，不信任前端）。
    progress: 可选 async callable(note: str, pct: int)。
    """
    wanted: list[dict] = []
    missing: list[str] = []
    for iid in (issue_ids or []):
        it = issue_index.get(str(iid))
        if it:
            wanted.append(it)
        else:
            missing.append(str(iid))
    if not wanted:
        return {"ok": False, "error": "没有找到要修复的问题（报告可能已过期，请重新体检）",
                "missing": missing[:20]}

    data = await load_draft_episodes(draft_id)
    if data.get("error"):
        return {"ok": False, "error": data["error"]}

    # 按 (target, episode) 分组
    outline_issues: dict[int, list[dict]] = {}
    script_issues: dict[int, list[dict]] = {}
    global_outline: list[dict] = []
    for it in wanted:
        ep = it.get("episode")
        if _target_of(it.get("kind") or "", it) == "outline":
            if ep is None:
                global_outline.append(it)
            else:
                outline_issues.setdefault(int(ep), []).append(it)
        else:
            if ep is None:
                continue      # 无集号的文风问题(如全剧标题)不进正文修复
            script_issues.setdefault(int(ep), []).append(it)

    by_order = {int(e["order"]): e for e in (data.get("episodes") or [])}
    is_sb = data.get("kind") == "storyboard"

    result = {
        "ok": True, "draft_id": draft_id, "kind": data.get("kind"),
        "before": _snapshot_totals(issue_index),
        "fixed_eps": [], "failed_eps": [], "outline_fixed": [],
        "notes": [], "missing": missing[:20],
    }
    if global_outline:
        result["notes"].append(
            f"{len(global_outline)} 条问题没有具体集号（如全剧标题/缺少契约字段），"
            f"无法定点修复。这类问题用「整本精修」或重新生成大纲更合适。")

    touched: set[int] = set()

    # ---- 大纲类 ----
    # ⚠️ 2026-10-11：这里原本**没有上限、也没有 progress**，是这次改动才让它变得危险的。
    # 报告卡新加的「同类合并 + 全改」会因为一条 `hook_in_missing ×56` 给出一个
    # 「全改（56）」按钮，一点就是 56 次 LLM 调用；而进度回调缺失，前端
    # progress_note 在整段大纲循环里一动不动，用户看到的是"进度条卡死"。
    # 正文/剧本路径一直有这两样东西（下面那段），大纲路径照抄同款即可。
    orders_o = sorted(outline_issues)
    if len(orders_o) > MAX_EPS_PER_RUN:
        result["notes"].append(
            f"大纲类这次先修 {MAX_EPS_PER_RUN} 集（共 {len(orders_o)} 集有问题），"
            f"剩下的修完这批再点一次即可。")
        orders_o = orders_o[:MAX_EPS_PER_RUN]

    for n, ep in enumerate(orders_o, start=1):
        # 进度区间取 10~30：调用方在进来之前已经 set 到 10（"正在修复 N 个问题"），
        # 起点低于它会让进度条**往回退**。大纲在正文之前跑，正文那段用的是
        # 90*n/len，把大纲压在前段就不会出现"先冲到 90% 再回退"的观感。
        if progress:
            await progress(f"正在修第{ep}集大纲（{n}/{len(orders_o)}）",
                           int(10 + 20 * n / max(1, len(orders_o))))
        try:
            ok = await _fix_outline_episode(draft_id, ep, outline_issues[ep], provider, user_id)
            if ok:
                result["outline_fixed"].append(ep)
            else:
                result["failed_eps"].append({"episode": ep, "target": "outline",
                                             "reason": "模型未返回有效补丁"})
        except Exception as ex:  # noqa: BLE001
            logger.exception("修复大纲第%d集失败: %s", ep, ex)
            result["failed_eps"].append({"episode": ep, "target": "outline",
                                         "reason": str(ex)[:200]})

    # ---- 正文/剧本类 ----
    orders = sorted(script_issues)
    if len(orders) > MAX_EPS_PER_RUN:
        result["notes"].append(
            f"这次先修 {MAX_EPS_PER_RUN} 集（共 {len(orders)} 集有问题），"
            f"剩下的修完这批再点一次即可。")
        orders = orders[:MAX_EPS_PER_RUN]

    for n, ep in enumerate(orders, start=1):
        e = by_order.get(ep)
        if progress:
            await progress(f"正在修第{ep}集（{n}/{len(orders)}）",
                           int(90 * n / max(1, len(orders))))
        if not e:
            result["failed_eps"].append({"episode": ep, "target": "script",
                                         "reason": "这一集在草稿里不存在"})
            continue
        try:
            r = await _fix_script_episode(draft_id, e, script_issues[ep],
                                          is_sb=is_sb, provider=provider, user_id=user_id)
        except Exception as ex:  # noqa: BLE001
            logger.exception("修复第%d集失败: %s", ep, ex)
            r = {"ok": False, "reason": str(ex)[:200]}
        if r.get("ok"):
            result["fixed_eps"].append({"episode": ep, **_strip_internal(r)})
            touched.add(ep)
        else:
            result["failed_eps"].append({"episode": ep, "target": "script",
                                         "reason": r.get("reason") or "校验未通过"})

    result["touched_eps"] = sorted(touched)
    result["touched_outline_eps"] = result["outline_fixed"]
    return result


def _strip_internal(r: dict) -> dict:
    return {k: v for k, v in r.items() if k != "ok"}


def _snapshot_totals(issue_index: dict) -> dict:
    return {"error": sum(1 for i in issue_index.values() if i.get("level") == "error"),
            "warn": sum(1 for i in issue_index.values() if i.get("level") == "warn"),
            "loaded": len(issue_index)}


# ---------------------------------------------------------------------------
# 正文 / 剧本: 一集一次 LLM, 最小改动
# ---------------------------------------------------------------------------

async def _fix_script_episode(draft_id: int, ep: dict, issues: list[dict], *,
                              is_sb: bool, provider: str, user_id: int | None) -> dict:
    from ..stages.consistency_lint import _extract_json

    order = int(ep["order"])
    orig_text = ep.get("text") or ""
    if not orig_text.strip():
        return {"ok": False, "reason": "这一集是空的，没有可修的内容"}

    issue_lines = "\n".join(
        f"- [{i.get('id')}] {i.get('message')}"
        + (f"（怎么改：{i['fix_hint']}）" if i.get("fix_hint") else "")
        for i in issues)

    prompt = P.FIX_PROMPT.format(ep=order, n=len(issues),
                                 issues=issue_lines, script=orig_text)
    llm = get_llm("rewrite", temperature=0.2, provider=provider, max_tokens=16384)
    resp = await llm.ainvoke([{"role": "system", "content": P.FIX_SYSTEM},
                              {"role": "user", "content": prompt}])
    d = _extract_json(getattr(resp, "content", "") or "")
    new_text = str(d.get("fixed_text") or "").strip()
    if not new_text:
        return {"ok": False, "reason": "模型未返回修复后的文本"}

    # 模型常把集标题行一起吐出来; 正文路径要剥掉它再比对。
    body = new_text
    m = _RE_EP_HEAD.match(body)
    if m and not is_sb:
        body = re.sub(r"^第\s*\d+\s*集.*?(\n|$)", "", body, count=1).strip()
    if not body:
        return {"ok": False, "reason": "修复后内容为空"}

    # ---- 校验 1: 字数雪崩 ----
    ratio = len(body) / max(1, len(orig_text))
    if not (_MIN_RATIO <= ratio <= _MAX_RATIO):
        return {"ok": False,
                "reason": f"修复后长度是原文的 {ratio:.0%}（{len(orig_text)}→{len(body)} 字），"
                          f"疑似删戏或加戏，已放弃这一集"}

    new_shots = None
    # ---- 校验 2: 剧本必须能被 parser 拆回, 且往返等价 ----
    if is_sb:
        new_shots = parse_episode(body)
        if not new_shots:
            return {"ok": False, "reason": "修复后的剧本拆不出任何场次（格式坏了），已放弃这一集"}
        ok, diff = roundtrip_equivalent(new_shots, ep=order)
        if not ok:
            return {"ok": False, "reason": f"修复后的剧本格式无法被系统解析：{diff[:160]}"}

    # ---- 落库: 先存 History 再覆写(可回滚) ----
    async with session_scope() as s:
        if is_sb:
            row = (await s.execute(
                select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id,
                                               ScriptStoryboard.chapter_order == order)
            )).scalars().first()
        else:
            row = (await s.execute(
                select(ScriptChapter).where(ScriptChapter.draft_id == draft_id,
                                            ScriptChapter.chapter_order == order)
            )).scalars().first()
        if not row:
            return {"ok": False, "reason": "数据库里找不到这一集"}

        # 归档走 candidate_store.snapshot_in: 带上限(每集每阶段 10 版)。
        # 原先是裸 s.add(ScriptEpisodeHistory(...)), 没有上限, 与章节路径不一致。
        # 用 snapshot_in 而非 save_candidate: 本函数已在一个事务里同时改正文与
        # 下游 stale 位, 换成 save_candidate 会另开事务破坏原子性。
        from ..stages.candidate_store import snapshot_in
        await snapshot_in(
            s, draft_id=draft_id, order=order,
            stage="storyboard" if is_sb else "chapter",
            content=row.shots_json if is_sb else {"full_text": row.full_text or ""},
            version=row.version or 1, created_by="ai_fix")

        if is_sb:
            row.shots_json = new_shots
            flag_modified(row, "shots_json")
            row.is_stale = 0
        else:
            row.full_text = body
            row.word_count = len(body)
            row.is_stale = 1     # 正文改了, 下游剧本需要重出
        row.version = (row.version or 1) + 1

    return {"ok": True, "before_chars": len(orig_text), "after_chars": len(body),
            "before_scenes": len(ep.get("shots") or []) if is_sb else None,
            "after_scenes": len(new_shots) if is_sb else None,
            "fixed_issues": d.get("fixed_issues") or [],
            "unfixed": d.get("unfixed") or []}


# ---------------------------------------------------------------------------
# 大纲: 只 patch 被点名那一集的字段
# ---------------------------------------------------------------------------

#: 定点修复**允许模型写回**的大纲字段。
#:
#: ⚠️ 2026-10-11 修正。这份表原先与实际字段对不上，代价是**静默的功能失效**：
#: 名单里列着 `hook` / `contract` 两个键 —— 全库 17641 集里**一条都没有**
#: （`hook` 只是导入路径的入站字段名，[import_outline.py:440] 会把它映射成
#: `hook_out`；`contract` 则是 `_has_contract()` 的**概念名**，落库的四个真身是
#: core_push / value_shift / stakes / hook_out）。而真正在用的 `hook_out`（557 集）
#: 和 `hook_in`（496 集）**都不在名单里**，于是：
#:
#:     hook_weak / hook_type_repeat / hook_missing_leads_to / hook_in_missing
#:     被路由到大纲修复 → 模型返回 {"hook_out": ...} → 白名单过滤掉 →
#:     clean 为空 → 返回「模型未返回有效补丁」
#:
#: 用户看到的是"点了几次都修不动"，且**报错指不到真正的原因**。
#: 现已按实测数据补齐。字段以 `order` 之外、实际落库的键为准。
#:
#: ⛔ 不要往回加 `hook` / `contract` / `locked` / `version` / `order`：
#: 前两个是死键，后三个是系统列（`locked` 尤其——它是导入时自动打标的僵尸字段，
#: 让模型能改它会直接破坏强制重写的穿透逻辑）。
#:
#: 另有三个字段**刻意不在**白名单：`beats` / `power` / `emotion_intensity`。
#: 它们是导演层字段，不该由"修一个结构问题"顺手改写；`beats` 更有 `_beats_stale`
#: 这类依赖（改写它得连带决定 stale 位），不是一次字段 patch 能负责的。
OUTLINE_EDITABLE_FIELDS = {
    # 基本信息
    "title", "synopsis", "must_have", "characters",
    # 戏剧契约（_has_contract 认的就是这几个真身）
    "core_push", "value_shift", "stakes", "escalation", "hook_out",
    # 钩子链与观众认知
    "hook_in", "audience_knows_delta", "plant", "payoff",
    # 硬约束
    "forbidden",
}

#: 兼容旧名（本模块内多处引用）。新代码请用 `OUTLINE_EDITABLE_FIELDS`。
_ALLOWED_OUTLINE_FIELDS = OUTLINE_EDITABLE_FIELDS

#: 字段形状规则已统一到 stages/outline_fields.py（改编整理、单集 PATCH、定点修复三处共用）。
#: 这里保留旧名以兼容本模块内的引用。形状为什么必须在写入口把住，见那边的说明。
from ..stages.outline_fields import FIELD_SHAPE as _OUTLINE_FIELD_SHAPE, shape_ok as _shape_ok  # noqa: E402


async def _fix_outline_episode(draft_id: int, order: int, issues: list[dict],
                               provider: str, user_id: int | None) -> bool:
    """原地 patch outline 里某一集。返回是否真的改了。"""
    import json as _json

    from ..stages.consistency_lint import _extract_json
    from ..db import ScriptDraft

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return False
        outline = d.outline or {}
        key = "chapters" if outline.get("chapters") else "episodes"
        eps = outline.get(key) or []
        target = None
        for e in eps:
            if isinstance(e, dict) and int(e.get("order") or 0) == order:
                target = e
                break
        if target is None:
            return False
        siblings = "\n".join(
            f"第{e.get('order')}集 {e.get('title') or ''}: "
            f"{str(e.get('synopsis') or '')[:80]}"
            for e in eps if isinstance(e, dict) and int(e.get("order") or 0) != order)
        ep_json = _json.dumps(target, ensure_ascii=False, indent=1)

    issue_lines = "\n".join(
        f"- [{i.get('id')}] {i.get('message')}"
        + (f"（怎么改：{i['fix_hint']}）" if i.get("fix_hint") else "")
        for i in issues)
    prompt = P.OUTLINE_FIX_PROMPT.format(ep=order, n=len(issues),
                                         episode_json=ep_json, siblings=siblings[:3000],
                                         issues=issue_lines)
    llm = get_llm("generate", temperature=0.2, provider=provider)
    resp = await llm.ainvoke([{"role": "system", "content": P.OUTLINE_FIX_SYSTEM},
                              {"role": "user", "content": prompt}])
    d = _extract_json(getattr(resp, "content", "") or "")
    patch = d.get("patch") or {}
    if not isinstance(patch, dict) or not patch:
        return False

    # 白名单字段: 模型不能往 outline 里塞任意键(那会污染下游所有读 outline 的代码)。
    # 形状也要过 —— 见 _OUTLINE_FIELD_SHAPE 的说明, 字符串塞进 dict 字段会崩体检。
    clean: dict = {}
    rejected: list[str] = []
    for k, v in patch.items():
        if k not in OUTLINE_EDITABLE_FIELDS:
            continue
        ok, val = _shape_ok(k, v)
        if ok:
            clean[k] = val
        else:
            rejected.append(f"{k}({type(v).__name__})")
    # 被打回时把字段名一起记下来 —— 说明模型想去改我们没有授权的字段,
    # 或者把形状给错了。只说"未返回有效补丁"会把这两种情况和真的空响应混在一起,
    # 排查时无从下手（hook_out 那次静默失效就是栽在这里）。
    if not clean:
        logger.warning("大纲修复没有可落地的字段: 非法=%s 形状不合=%s",
                       [k for k in patch if k not in OUTLINE_EDITABLE_FIELDS][:10],
                       rejected[:10])
        return False
    if rejected:
        logger.info("大纲修复丢弃了形状不合的字段: %s", rejected[:10])

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        outline = d.outline or {}
        key = "chapters" if outline.get("chapters") else "episodes"
        eps = outline.get(key) or []
        for e in eps:
            if isinstance(e, dict) and int(e.get("order") or 0) == order:
                # 归档走 candidate_store.snapshot_in(带 10 版上限):
                # 大纲也存在 script_episode_history 里(stage="outline"),
                # 原先裸 s.add 同样没有上限。
                from ..stages.candidate_store import snapshot_in
                await snapshot_in(
                    s, draft_id=draft_id, order=order, stage="outline",
                    content=_json.loads(_json.dumps(e, ensure_ascii=False)),
                    version=int(e.get("version") or 1), created_by="ai_fix")
                e.update(clean)
                e["version"] = int(e.get("version") or 1) + 1
                break
        outline[key] = eps
        d.outline = outline
        flag_modified(d, "outline")
    return True


# ---------------------------------------------------------------------------
# 修后复检
# ---------------------------------------------------------------------------

async def recheck_after_fix(draft_id: int, touched: list, provider: str = "gemini") -> dict:
    """只对动过的集重跑体检, 返回 {before, after, improved}。

    这是"防假完成"的根本手段: 修复到底有没有把 error 数降下来, 由同一个体检器
    说了算 —— 不是由模型的自我报告说了算。数字没降就照实说, 不谎报成功。
    """
    from .engine import run_check

    if not touched:
        return {"ran": False}
    report = await run_check(
        draft_id=draft_id, kinds=("structure", "style", "consistency", "script"),
        scope=None, provider=provider, deep=False)
    return {"ran": True, "report": report}
