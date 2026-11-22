"""叙事健康度 API —— 事件时间轴 + 实体负荷检测。

- GET  /v1/stages/drafts/{id}/narrative-timeline          读时间轴(ledger 缺则重建并存回)
- POST /v1/stages/drafts/{id}/narrative-timeline/diagnose AI 诊断事件分布节奏
- GET  /v1/stages/drafts/{id}/entity-load                 读已存实体负荷报告
- POST /v1/stages/drafts/{id}/entity-load                 重新分析实体负荷并回写

一期只读 + AI 诊断; 二期(rebalance/optimize 回写大纲)见 PLAN。
"""
from __future__ import annotations

import json
import logging
import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm.attributes import flag_modified

from ..auth import get_current_user, User
from ..db import ScriptDraft, session_scope
from ..models.llm import get_llm
from ..stages.state_ledger import update_ledger_for_batch, empty_ledger
from .timeline import build_timeline
from .entity_load import analyze_entities

logger = logging.getLogger("narrative_routes")

router = APIRouter(prefix="/v1/stages", tags=["narrative"])


async def _load_draft(draft_id: int, user: User):
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or (d.user_id and d.user_id != user.id and user.role not in ("admin", "superadmin")):
            raise HTTPException(404, "草稿不存在")
        return dict(d.outline or {}), (d.model_provider or "gemini")


@router.get("/drafts/{draft_id}/narrative-timeline")
async def get_narrative_timeline(draft_id: int, user: User = Depends(get_current_user)):
    """读事件时间轴。若 ledger 缺失, 用大纲即时重建一次并存回。"""
    outline, provider = await _load_draft(draft_id, user)
    episodes = outline.get("chapters") or outline.get("episodes") or []
    if not episodes:
        raise HTTPException(400, "该草稿还没有大纲, 无法生成时间轴")

    ledger = outline.get("state_ledger") or {}
    if not (ledger.get("by_episode")):
        # ledger 缺失 → 即时重建并存回(复用 lint 同款逻辑)
        try:
            seed = (outline.get("story_bible") or {}).get("core_mysteries")
            led = await update_ledger_for_batch(empty_ledger(), episodes, open_threads_seed=seed, provider=provider)
            outline["state_ledger"] = led
            async with session_scope() as s:
                d = await s.get(ScriptDraft, draft_id)
                if d:
                    d.outline = outline
                    flag_modified(d, "outline")
                    await s.flush()
        except Exception as e:  # noqa: BLE001
            logger.warning("timeline 重建 ledger 失败(降级空账本): %s", e)
            outline.setdefault("state_ledger", empty_ledger())

    return {"draft_id": draft_id, "timeline": build_timeline(outline)}


_DIAGNOSE_PROMPT = """你是短剧节奏诊断专家。下面是一部短剧按集展开的"事件负荷"数据。
每集列出了发生的关键事件(死亡/揭秘/悬念解决/重大反转/新角色登场)和加权负荷分。

## 各集事件与负荷
{timeline_block}

## 全剧统计
平均每集负荷: {mean}，标准差: {std}，高负荷阈值(均值+标准差): {high_threshold}

## 你的任务
1. 找出**事件过载**的集或连续段(负荷远高于均值、事件扎堆、观众可能跟不上)。
2. 找出**节奏空洞**的集或连续段(负荷过低、缺少推进)。
3. 给出**具体可执行**的调整建议: 把哪个事件从第X集挪到第Y集、哪段该加缓冲戏、哪些事件该合并。
建议要具体到"事件名 + 集号", 不要泛泛而谈。

## 输出格式(严格 JSON, 不要 markdown)
{{
  "verdict": "一句话总体结论",
  "overloaded": [{{"start": 集号, "end": 集号, "reason": "为何过载", "suggestion": "怎么改"}}],
  "underloaded": [{{"start": 集号, "end": 集号, "reason": "为何空洞", "suggestion": "怎么改"}}],
  "moves": [{{"event": "事件名", "from_ep": 集号, "to_ep": 集号, "why": "理由"}}]
}}
只输出 JSON。
"""


def _extract_json(text: str) -> dict:
    if not text:
        return {}
    raw = text.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw)
    except Exception:
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if not m:
            return {}
        try:
            return json.loads(m.group(0))
        except Exception:
            return {}


def _fmt_timeline_block(timeline: dict) -> str:
    lines = []
    for ep in timeline.get("episodes", []):
        evs = "、".join(f"{e['label']}" for e in ep.get("events", [])) or "(无重大事件)"
        lines.append(f"第{ep['order']}集《{ep['title']}》 负荷{ep['load_score']}[{ep['load_level']}]: {evs}")
    return "\n".join(lines)


@router.post("/drafts/{draft_id}/narrative-timeline/diagnose")
async def diagnose_timeline(draft_id: int, user: User = Depends(get_current_user)):
    """AI 诊断事件分布节奏, 给出过载/空洞/事件搬迁建议(只分析, 不改大纲)。"""
    outline, provider = await _load_draft(draft_id, user)
    episodes = outline.get("chapters") or outline.get("episodes") or []
    if not episodes:
        raise HTTPException(400, "该草稿还没有大纲")

    ledger = outline.get("state_ledger") or {}
    if not ledger.get("by_episode"):
        try:
            seed = (outline.get("story_bible") or {}).get("core_mysteries")
            outline["state_ledger"] = await update_ledger_for_batch(
                empty_ledger(), episodes, open_threads_seed=seed, provider=provider
            )
            async with session_scope() as s:
                d = await s.get(ScriptDraft, draft_id)
                if d:
                    d.outline = outline
                    flag_modified(d, "outline")
                    await s.flush()
        except Exception as e:  # noqa: BLE001
            logger.warning("diagnose 重建 ledger 失败: %s", e)
            outline.setdefault("state_ledger", empty_ledger())

    timeline = build_timeline(outline)
    stats = timeline.get("stats", {})
    prompt = _DIAGNOSE_PROMPT.format(
        timeline_block=_fmt_timeline_block(timeline),
        mean=stats.get("mean", 0),
        std=stats.get("std", 0),
        high_threshold=stats.get("high_threshold", 0),
    )
    try:
        llm = get_llm("generate", temperature=0.3, provider=provider, max_tokens=2048)
        resp = await llm.ainvoke(prompt)
        diagnosis = _extract_json(getattr(resp, "content", "") or "")
    except Exception as e:  # noqa: BLE001
        logger.warning("timeline diagnose LLM 失败: %s", e)
        raise HTTPException(502, "AI 诊断失败, 请重试")

    if not diagnosis:
        raise HTTPException(502, "AI 未返回有效诊断")

    return {"draft_id": draft_id, "diagnosis": diagnosis, "timeline": timeline}


@router.get("/drafts/{draft_id}/entity-load")
async def get_entity_load(draft_id: int, user: User = Depends(get_current_user)):
    """读已存的实体负荷报告(outline.entity_report)。未分析过则返回空。"""
    outline, _ = await _load_draft(draft_id, user)
    report = outline.get("entity_report")
    return {"draft_id": draft_id, "entity_report": report, "analyzed": bool(report)}


@router.post("/drafts/{draft_id}/entity-load")
async def run_entity_load(draft_id: int, user: User = Depends(get_current_user)):
    """重新分析专有名词负荷并回写 outline.entity_report。"""
    outline, provider = await _load_draft(draft_id, user)
    episodes = outline.get("chapters") or outline.get("episodes") or []
    if not episodes:
        raise HTTPException(400, "该草稿还没有大纲, 无法分析实体负荷")

    report = await analyze_entities(outline, provider=provider)
    outline["entity_report"] = report
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if d:
            d.outline = outline
            flag_modified(d, "outline")
            await s.flush()

    return {"draft_id": draft_id, "entity_report": report}


# ===========================================================================
# 二期: AI 优化 → 回写大纲 (复用"改 outline.chapters → 重建 ledger → 存回"闭环)
# ===========================================================================
_REBALANCE_PROMPT = """你是短剧节奏优化专家。下面是一部短剧的完整大纲, 以及诊断出的"事件分布问题"。
请通过**跨集调整事件分布**来优化节奏: 把过载集的部分事件后移/前移到空洞集, 让高潮与铺垫更均匀,
避免观众在某几集被信息轰炸。

## 全剧大纲(共 {total} 集)
{full_outline_block}

## 诊断出的问题与建议
{diagnosis_block}

## 修改原则
1. 你拥有全剧视野, 允许跨集调整: 把某集的事件挪到相邻集, 或拆分/合并事件。
2. 保持主线走向与因果链不变, 只重新分配事件的"出现时机", 不要凭空增删关键情节。
3. 调整后各集梗概要自洽连贯, 与前后集衔接自然。
4. 只输出**被你改动过的集**(没改的不要输出)。

## 输出格式(严格 JSON, 不要 markdown)
{{
  "changed_chapters": [
    {{"order": 集号, "title": "标题", "synopsis": "调整后的概要(100-200字)", "must_have": ["关键事件"], "characters": ["涉及角色"]}}
  ]
}}
只输出 JSON。
"""

_ENTITY_OPTIMIZE_PROMPT = """你是短剧信息密度优化专家。下面是一部短剧的完整大纲, 以及检测出的"专有名词过载问题"。
请通过**合并同类专有名词、把只出现一次的名词改用泛称**来减轻观众记忆负担, 让剧更好懂。

## 全剧大纲(共 {total} 集)
{full_outline_block}

## 专有名词负荷问题
{entity_block}

## 修改原则
1. 把功能重复的组织/势力名合并成一个(如"东辰集团"和"远洋控股"若作用相同则统一为其一)。
2. 只出现一次、非关键的专有名词改用泛称(如"南疆盟"→"那伙人"、"星辰科技"→"一家科技公司")。
3. 保持剧情与人物关系不变, 只做名词层面的精简替换; 全剧统一, 不要漏改。
4. 只输出**被你改动过的集**。

## 输出格式(严格 JSON, 不要 markdown)
{{
  "changed_chapters": [
    {{"order": 集号, "title": "标题", "synopsis": "精简后的概要", "must_have": ["关键事件"], "characters": ["涉及角色"]}}
  ]
}}
只输出 JSON。
"""


def _fmt_full_outline(episodes: list[dict]) -> str:
    lines = []
    for e in sorted(episodes, key=lambda x: int(x.get("order", 0) or 0)):
        lines.append(
            f"第{e.get('order')}集《{e.get('title','')}》\n"
            f"  概要: {e.get('synopsis','')}\n"
            f"  关键事件: {'、'.join(e.get('must_have') or []) or '(无)'}"
        )
    return "\n\n".join(lines)


async def _apply_changed_chapters(draft_id: int, outline: dict, changed: list[dict], provider: str) -> list[int]:
    """把 LLM 返回的改动集合并进 outline.chapters, 标 stale, 重建 ledger, 存回。返回改动的集号。"""
    episodes = outline.get("chapters") or outline.get("episodes") or []
    changed_by_order = {int(c.get("order", 0)): c for c in changed if c.get("order")}
    applied: list[int] = []
    merged = []
    for e in episodes:
        o = int(e.get("order", 0))
        if o in changed_by_order:
            c = changed_by_order[o]
            e = dict(e)
            if str(c.get("title", "")).strip():
                e["title"] = str(c["title"]).strip()
            if str(c.get("synopsis", "")).strip():
                e["synopsis"] = str(c["synopsis"]).strip()
            if isinstance(c.get("must_have"), list):
                e["must_have"] = c["must_have"]
            if isinstance(c.get("characters"), list):
                e["characters"] = c["characters"]
            applied.append(o)
        merged.append(e)
    if not applied:
        return []
    outline["chapters"] = merged
    # 重建 ledger(事件时间轴数据源)
    try:
        seed = (outline.get("story_bible") or {}).get("core_mysteries")
        outline["state_ledger"] = await update_ledger_for_batch(
            empty_ledger(), merged, open_threads_seed=seed, provider=provider
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("apply_changed 重建 ledger 失败: %s", e)
    async with session_scope() as s:
        from sqlalchemy import update as _upd
        from ..db import ScriptChapter, ScriptStoryboard
        d = await s.get(ScriptDraft, draft_id)
        if d:
            d.outline = outline
            flag_modified(d, "outline")
            # 改动集的章节/剧本标 stale, 提示重生
            for o in applied:
                await s.execute(_upd(ScriptChapter).where(ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == o).values(is_stale=1))
                await s.execute(_upd(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == o).values(is_stale=1))
            await s.flush()
    return sorted(applied)


@router.post("/drafts/{draft_id}/narrative-timeline/rebalance")
async def rebalance_timeline(draft_id: int, user: User = Depends(get_current_user)):
    """AI 优化事件分布 → 回写大纲(受影响集标 stale, 提示重生章节/剧本)。"""
    outline, provider = await _load_draft(draft_id, user)
    episodes = outline.get("chapters") or outline.get("episodes") or []
    if not episodes:
        raise HTTPException(400, "该草稿还没有大纲")

    ledger = outline.get("state_ledger") or {}
    if not ledger.get("by_episode"):
        try:
            seed = (outline.get("story_bible") or {}).get("core_mysteries")
            outline["state_ledger"] = await update_ledger_for_batch(empty_ledger(), episodes, open_threads_seed=seed, provider=provider)
        except Exception:
            outline.setdefault("state_ledger", empty_ledger())

    # 先跑一次诊断作为改写依据
    timeline = build_timeline(outline)
    stats = timeline.get("stats", {})
    diag_prompt = _DIAGNOSE_PROMPT.format(
        timeline_block=_fmt_timeline_block(timeline),
        mean=stats.get("mean", 0), std=stats.get("std", 0), high_threshold=stats.get("high_threshold", 0),
    )
    try:
        llm = get_llm("generate", temperature=0.3, provider=provider, max_tokens=2048)
        diag = _extract_json(getattr(await llm.ainvoke(diag_prompt), "content", "") or "")
    except Exception as e:  # noqa: BLE001
        logger.warning("rebalance 诊断失败: %s", e)
        diag = {}

    diagnosis_block = json.dumps(diag, ensure_ascii=False, indent=2) if diag else "(无诊断, 请自行判断过载/空洞)"
    prompt = _REBALANCE_PROMPT.format(
        total=len(episodes),
        full_outline_block=_fmt_full_outline(episodes),
        diagnosis_block=diagnosis_block,
    )
    try:
        llm = get_llm("generate", temperature=0.3, provider=provider, max_tokens=4096)
        data = _extract_json(getattr(await llm.ainvoke(prompt), "content", "") or "")
    except Exception as e:  # noqa: BLE001
        logger.warning("rebalance LLM 失败: %s", e)
        raise HTTPException(502, "AI 优化失败, 请重试")

    changed = data.get("changed_chapters") or []
    if not changed:
        raise HTTPException(502, "AI 未返回有效调整")

    applied = await _apply_changed_chapters(draft_id, outline, changed, provider)
    if not applied:
        raise HTTPException(502, "AI 调整未能应用")

    # 回写后重算时间轴返回
    new_timeline = build_timeline(outline)
    return {"draft_id": draft_id, "changed_orders": applied, "timeline": new_timeline}


@router.post("/drafts/{draft_id}/entity-load/optimize")
async def optimize_entities(draft_id: int, user: User = Depends(get_current_user)):
    """AI 精简专有名词(合并/泛化) → 回写大纲。"""
    outline, provider = await _load_draft(draft_id, user)
    episodes = outline.get("chapters") or outline.get("episodes") or []
    if not episodes:
        raise HTTPException(400, "该草稿还没有大纲")

    report = outline.get("entity_report")
    if not report:
        # 未分析过则先分析
        report = await analyze_entities(outline, provider=provider)
        outline["entity_report"] = report

    entity_block = json.dumps({
        "issues": report.get("issues", []),
        "once_only": [e["name"] for e in report.get("entities", []) if e.get("count") == 1],
        "all_orgs": [e["name"] for e in report.get("entities", []) if e.get("type") in ("org", "nation")],
    }, ensure_ascii=False, indent=2)

    prompt = _ENTITY_OPTIMIZE_PROMPT.format(
        total=len(episodes),
        full_outline_block=_fmt_full_outline(episodes),
        entity_block=entity_block,
    )
    try:
        llm = get_llm("generate", temperature=0.3, provider=provider, max_tokens=4096)
        data = _extract_json(getattr(await llm.ainvoke(prompt), "content", "") or "")
    except Exception as e:  # noqa: BLE001
        logger.warning("entity optimize LLM 失败: %s", e)
        raise HTTPException(502, "AI 精简失败, 请重试")

    changed = data.get("changed_chapters") or []
    if not changed:
        raise HTTPException(502, "AI 未返回有效精简")

    applied = await _apply_changed_chapters(draft_id, outline, changed, provider)
    if not applied:
        raise HTTPException(502, "AI 精简未能应用")

    # 回写后重新分析实体返回
    new_report = await analyze_entities(outline, provider=provider)
    outline["entity_report"] = new_report
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if d:
            d.outline = outline
            flag_modified(d, "outline")
            await s.flush()

    return {"draft_id": draft_id, "changed_orders": applied, "entity_report": new_report}


# ===========================================================================
# 三期: 手动编辑事件时间轴 (直接改 ledger.by_episode, 可选触发对应集大纲重写)
# ===========================================================================
from pydantic import BaseModel

# 前端 type <-> ledger.by_episode 字段名映射(与 timeline.py 的 _EVENT_SPECS 一致)
_TYPE_TO_FIELD = {
    "death": "deaths",
    "reveal": "revealed_secrets",
    "resolve": "resolved_threads",
    "twist": "used_elements",
    "new_char": "births",
}


class TimelineEventEdit(BaseModel):
    """一集的事件手动编辑请求。events 为该集的完整事件列表(全量覆盖该集事件)。"""
    episode: int
    events: list[dict] = []  # [{type, label}], type 见 _TYPE_TO_FIELD


@router.put("/drafts/{draft_id}/narrative-timeline/events")
async def edit_timeline_events(draft_id: int, payload: TimelineEventEdit, user: User = Depends(get_current_user)):
    """手动增删改某一集的事件(直接改 ledger.by_episode, 不调 LLM)。

    前端把该集编辑后的完整事件列表传来, 后端按 type 归类回写到 by_episode[集号] 的对应字段,
    仅覆盖这 5 类可视事件字段(deaths/births/revealed_secrets/resolved_threads/used_elements),
    present/location 等保持不变。改完重算时间轴返回, 前端即时刷新柱状/事件卡。

    注意: 这只改"事件时间轴的展示与负荷数据", 不自动改大纲正文。若要让大纲跟着变,
    用「AI 优化重排并回写」或逐集「重写大纲」。
    """
    outline, provider = await _load_draft(draft_id, user)
    ep = int(payload.episode)
    ledger = dict(outline.get("state_ledger") or empty_ledger())
    by_ep = dict(ledger.get("by_episode") or {})
    cur = dict(by_ep.get(str(ep)) or {})

    # 按 type 归类前端传来的事件
    grouped: dict[str, list[str]] = {f: [] for f in _TYPE_TO_FIELD.values()}
    for it in (payload.events or []):
        if not isinstance(it, dict):
            continue
        t = str(it.get("type", "")).strip()
        label = str(it.get("label", "")).strip()
        field = _TYPE_TO_FIELD.get(t)
        if field and label and label not in grouped[field]:
            grouped[field].append(label)

    # 覆盖这 5 类字段, 其余(present/location)保留
    for field in _TYPE_TO_FIELD.values():
        cur[field] = grouped[field]
    cur.setdefault("present", cur.get("present") or [])
    cur.setdefault("location", cur.get("location") or "")
    by_ep[str(ep)] = cur
    ledger["by_episode"] = by_ep
    # cumulative 不重算(手动编辑仅影响时间轴展示; 累计状态由 AI 重建时再校正)
    outline["state_ledger"] = ledger

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if d:
            d.outline = outline
            flag_modified(d, "outline")
            await s.flush()

    return {"draft_id": draft_id, "timeline": build_timeline(outline)}
