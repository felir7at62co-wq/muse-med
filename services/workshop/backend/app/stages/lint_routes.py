"""P2/P6: 一致性校验 API —— 触发校验 + 读取 lint_report。

- GET  /v1/stages/drafts/{id}/lint        读取已存 lint_report(存于 outline.lint_report)
- POST /v1/stages/drafts/{id}/lint         对当前大纲重新跑一致性校验并回写(只标注,不改大纲)

已定决策2: 只标注不自动重写。前端红/黄标注给用户看, 用户自行决定是否修订。
"""
from __future__ import annotations

import json
import logging
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm.attributes import flag_modified

from ..db import ScriptDraft, session_scope
from ..models.llm import get_llm
from ..auth.dependencies import get_current_user
from ..auth.models import User
from .consistency_lint import lint_outline
from .story_bible import generate_bible_from_outline, bible_text
from .drama_gate import check_outline, build_fix_hints
from ..critique.restructure import plan_restructure
from .state_ledger import update_ledger_for_batch, empty_ledger

logger = logging.getLogger("lint_routes")

router = APIRouter(prefix="/v1/stages", tags=["stages-lint"])


class LintFixIn(BaseModel):
    issue_ids: list[str] = []   # 用户勾选要修的 issue id(必修项)
    fix_all: bool = False       # true = 修复报告里的全部问题(勾选与否都修)


@router.get("/drafts/{draft_id}/lint")
async def get_lint_report(draft_id: int, user: User = Depends(get_current_user)):
    """读取已保存的一致性校验报告。"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or (d.user_id and d.user_id != user.id and not getattr(user, "is_admin", False)):
            raise HTTPException(404, "草稿不存在")
        outline = d.outline or {}
        report = outline.get("lint_report") or {"issues": [], "summary": {"error": 0, "warn": 0}}
        return {
            "draft_id": draft_id,
            "lint_report": report,
            "has_bible": bool(outline.get("story_bible")),
            "has_ledger": bool(outline.get("state_ledger")),
        }


@router.post("/drafts/{draft_id}/lint")
async def run_lint(draft_id: int, user: User = Depends(get_current_user)):
    """对当前大纲重新跑一致性校验并回写 lint_report(只标注, 不改大纲)。

    若大纲缺 story_bible / state_ledger(老数据), 会即时补建后再校验。
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or (d.user_id and d.user_id != user.id and not getattr(user, "is_admin", False)):
            raise HTTPException(404, "草稿不存在")
        outline = dict(d.outline or {})
        provider = d.model_provider or "gemini"
        user_input = d.user_input or ""

    episodes = outline.get("chapters") or outline.get("episodes") or []
    if not episodes:
        raise HTTPException(400, "该草稿还没有大纲, 无法校验")

    # 用户主动点"校验" => 总是基于**当前大纲的实际内容**重新提炼 Bible + 重建账本,
    # 而非复用旧的 story_bible/state_ledger。原因:
    #   1. 大纲可能已被编辑, 旧圣经/账本已过时;
    #   2. 早期版本可能用 user_input(占位符)误建了与剧情无关的圣经(如科幻设定套在都市剧上),
    #      导致大量误报; 每次从大纲实际内容重算可自愈这类污染数据。
    # 代价: 每次校验多 2 次 LLM 调用(提炼圣经 + 抽取账本), 属可接受的正确性成本。
    try:
        outline["story_bible"] = await generate_bible_from_outline(outline, provider=provider)
    except Exception as e:  # noqa: BLE001
        logger.warning("lint 提炼 bible 失败: %s", e)
        outline.setdefault("story_bible", {"world": {}, "characters": [], "core_mysteries": [], "forbidden": ["死亡不可逆"]})

    try:
        led = empty_ledger()
        seed = (outline.get("story_bible") or {}).get("core_mysteries")
        led = await update_ledger_for_batch(led, episodes, open_threads_seed=seed, provider=provider)
        outline["state_ledger"] = led
    except Exception as e:  # noqa: BLE001
        logger.warning("lint 重建账本失败: %s", e)
        outline.setdefault("state_ledger", empty_ledger())

    # 基线用**有效账本**（计划 + 稿子实况）：用户亲手改过的东西是意图，不是硬伤。
    # 计划与实际的差异走"大纲分岔"维度（info/warn），不在这里报 error。
    try:
        from .divergence import effective_ledger
        _eff = await effective_ledger(draft_id) or None
    except Exception as _e:  # noqa: BLE001
        logger.warning("lint 取有效账本失败，退回计划账本: %s", _e)
        _eff = None

    report = await lint_outline(outline, use_llm=True, provider=provider, ledger_override=_eff)
    outline["lint_report"] = report

    # 回写(含补建的 bible/ledger/report)
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if d:
            d.outline = outline
            await s.flush()

    return {"draft_id": draft_id, "lint_report": report}


_FIX_PROMPT = """你是资深短剧编剧总策划, 正在修订一部剧的**完整大纲**, 以消除审校发现的硬伤(逻辑矛盾/死人复活/人名漂移/时间线倒错/悬念悬空/元素重复等)。

{bible_block}

## 全剧完整大纲(共 {total} 集, 这是你的全局视野)
{full_outline_block}

## 必须修复的问题
{must_fix_block}
{optional_block}
## 修改原则(重要)
1. 你拥有全剧所有集的视野, **允许跨集修改**: 为了从根本上消除硬伤, 你可以同时调整多集(例如把某集提前交代的信息挪到后面、统一前后矛盾的人名/设定、补上缺失的因果铺垫)。
2. **允许较大范围的改动**, 只要能让整部剧在逻辑、时间线、人物、世界观上前后自洽。不要为了"少改"而留下未消除的矛盾。
3. 修改后必须与故事圣经一致(人名统一、世界观一致、已死角色不再出场除非明确闪回、已揭穿的秘密不再当未知)。
4. 保持全剧的核心主线与整体走向不变, 只修正硬伤本身, 不要凭空改写风格或推翻立意。
5. 只输出**被你改动过的集**(没改的集不要输出), 但改动的集可以是任意集、任意数量。

## 输出格式(严格 JSON, 不要 markdown 包装, 不要解释)
{{
  "fixed_chapters": [
    {{"order": 集号数字, "title": "修正后的标题", "synopsis": "修正后的概要(100-200字)", "must_have": ["关键事件"], "characters": ["涉及角色"]}}
  ]
}}
只输出 JSON 对象。
"""


def _fix_extract_json(text: str) -> dict:
    if not text:
        return {"fixed_chapters": []}
    raw = text.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw)
    except Exception:
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if not m:
            return {"fixed_chapters": []}
        try:
            return json.loads(m.group(0))
        except Exception:
            return {"fixed_chapters": []}


def _fmt_full_outline(episodes: list[dict]) -> str:
    """把全剧所有集渲染成给 LLM 的全局视野文本块。"""
    lines = []
    for e in sorted(episodes, key=lambda x: int(x.get("order", 0))):
        lines.append(
            f"第{e.get('order')}集《{e.get('title','')}》\n"
            f"  概要: {e.get('synopsis','')}\n"
            f"  关键事件: {'、'.join(e.get('must_have') or []) or '(无)'}\n"
            f"  涉及人物: {'、'.join(e.get('characters') or []) or '(无)'}"
        )
    return "\n\n".join(lines)


@router.post("/drafts/{draft_id}/lint/fix")
async def fix_lint_issues(draft_id: int, payload: LintFixIn, user: User = Depends(get_current_user)):
    """AI 修改硬伤(全局视野 + 允许跨集大范围修改), 修改后回写并重新校验。

    与旧版"只把勾选集发给 LLM"不同: 现在把**全剧完整大纲**都发给 LLM, 并授权它跨集修改,
    从根本上消除硬伤, 避免"改了A集又和没看到的B集冲突"的反复问题。
    - fix_all=True : 修复报告里的全部问题;
    - 否则         : 以 issue_ids 勾选项为"必须修复", 其余问题作为"可顺带修复"参考。
    修完自动重跑一致性校验返回新报告。
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or (d.user_id and d.user_id != user.id and not getattr(user, "is_admin", False)):
            raise HTTPException(404, "草稿不存在")
        outline = dict(d.outline or {})
        provider = d.model_provider or "gemini"

    episodes = outline.get("chapters") or outline.get("episodes") or []
    if not episodes:
        raise HTTPException(400, "该草稿还没有大纲")

    report = outline.get("lint_report") or {}
    all_issues = report.get("issues") or []
    if not all_issues:
        raise HTTPException(400, "当前没有检测到问题(请先重新校验)")

    if payload.fix_all:
        must_fix = all_issues
        optional = []
    else:
        if not payload.issue_ids:
            raise HTTPException(400, "未选择要修复的问题")
        sel_ids = set(payload.issue_ids)
        must_fix = [it for it in all_issues if it.get("id") in sel_ids]
        optional = [it for it in all_issues if it.get("id") not in sel_ids]
        if not must_fix:
            raise HTTPException(400, "勾选的问题未找到(请先重新校验)")

    bible = outline.get("story_bible") or {}
    must_fix_block = "\n".join(
        f"- 第{it.get('episode')}集[{it.get('level')}] {it.get('message')}" for it in must_fix
    ) or "(无)"
    if optional:
        opt_lines = "\n".join(
            f"- 第{it.get('episode')}集[{it.get('level')}] {it.get('message')}" for it in optional
        )
        optional_block = f"\n## 可顺带修复的问题(如与上面问题相关, 可一并修正)\n{opt_lines}\n"
    else:
        optional_block = ""

    # ── 多轮自动收敛 ──
    # 单轮修复可能引入新硬伤(跨集改动的连带效应), 故循环: 修 → 重建账本 → 重校验,
    # 只要还有 error 级"硬伤"就再修一轮, 直到硬伤归零或到轮次上限。
    # 这样用户点一次就拿到"已尽力修净"的结果, 不用手动反复点。
    MAX_ROUNDS = 3
    all_applied: set[int] = set()
    new_report = outline.get("lint_report") or report

    async def _run_one_round(cur_episodes: list[dict], must_fix_issues: list[dict], optional_issues: list[dict]) -> list[dict] | None:
        """跑一轮修复, 返回被改动后的完整 chapters 列表; 无有效修改返回 None。"""
        mf_block = "\n".join(
            f"- 第{it.get('episode')}集[{it.get('level')}] {it.get('message')}" for it in must_fix_issues
        ) or "(无)"
        if optional_issues:
            opt_lines = "\n".join(
                f"- 第{it.get('episode')}集[{it.get('level')}] {it.get('message')}" for it in optional_issues
            )
            opt_block = f"\n## 可顺带修复的问题(如与上面问题相关, 可一并修正)\n{opt_lines}\n"
        else:
            opt_block = ""
        prompt = _FIX_PROMPT.format(
            bible_block=bible_text(bible) or "(无故事圣经)",
            total=len(cur_episodes),
            full_outline_block=_fmt_full_outline(cur_episodes),
            must_fix_block=mf_block,
            optional_block=opt_block,
        )
        try:
            # 温度=0.2: 修复也尽量确定, 减少每轮随机漂移
            llm = get_llm("generate", temperature=0.2, provider=provider)
            resp = await llm.ainvoke(prompt)
            data = _fix_extract_json(getattr(resp, "content", "") or "")
        except Exception as e:  # noqa: BLE001
            logger.warning("lint fix LLM 失败: %s", e)
            return None
        fixed = data.get("fixed_chapters") or []
        if not fixed:
            return None
        fixed_by_order = {int(f.get("order", 0)): f for f in fixed if f.get("order")}
        merged = []
        for e in cur_episodes:
            o = int(e.get("order", 0))
            if o in fixed_by_order:
                f = fixed_by_order[o]
                e = dict(e)
                if str(f.get("title", "")).strip():
                    e["title"] = str(f["title"]).strip()
                if str(f.get("synopsis", "")).strip():
                    e["synopsis"] = str(f["synopsis"]).strip()
                if isinstance(f.get("must_have"), list):
                    e["must_have"] = f["must_have"]
                if isinstance(f.get("characters"), list):
                    e["characters"] = f["characters"]
                # 🔴 2026-10-09：**保留契约字段**。
                #
                # 本提示词只要求模型回 order/title/synopsis/must_have/characters，
                # 而原实现是 `e = dict(e)` 后**逐键覆盖**——没回契约字段时旧值还在，
                # 这点没问题；但真正的问题在**语义**上：模型修正 synopsis 后，
                # 旧的 core_push/stakes/hook_out/beats 描述的是**改之前**的那集，
                # 二者会悄悄对不上，而下游正文/剧本按契约写 → 写出来的不是修完的剧情。
                # 所以：模型若**主动回了**契约字段就采纳；没回就**标注失效**，
                # 由下游的 gate（drama_gate）与用户复核，而不是假装它还有效。
                _CONTRACT_PRESERVE_KEYS = (
                    "core_push", "stakes", "escalation", "value_shift",
                    "hook_in", "hook_out", "plant", "payoff", "forbidden",
                    "audience_knows_delta", "char_knows_delta", "beats",
                )
                _touched = False
                for _k in _CONTRACT_PRESERVE_KEYS:
                    if _k in f and f[_k] not in (None, "", [], {}):
                        e[_k] = f[_k]
                        _touched = True
                if not _touched and any(k in e for k in _CONTRACT_PRESERVE_KEYS):
                    # synopsis 被改过、契约没跟着改 → 该集契约已不可信，明确标出来。
                    # 不静默保留（那会让下游拿旧契约写新剧情），也不直接清空
                    # （用户可能只是手改正文，想留着参考）。
                    _old = e.get("synopsis", "")
                    if str(f.get("synopsis", "")).strip() and str(f["synopsis"]).strip() != _old:
                        e["_contract_stale"] = True
                all_applied.add(o)
            merged.append(e)
        return merged

    cur_must_fix = must_fix
    cur_optional = optional
    got_any_fix = False
    for round_i in range(MAX_ROUNDS):
        merged = await _run_one_round(episodes, cur_must_fix, cur_optional)
        if merged is None:
            break
        got_any_fix = True
        episodes = merged
        outline["chapters"] = merged
        # 重建账本 + 重新校验
        try:
            led = empty_ledger()
            seed = (outline.get("story_bible") or {}).get("core_mysteries")
            outline["state_ledger"] = await update_ledger_for_batch(led, merged, open_threads_seed=seed, provider=provider)
        except Exception as e:  # noqa: BLE001
            logger.warning("fix 后重建账本失败: %s", e)
        new_report = await lint_outline(outline, use_llm=True, provider=provider)
        outline["lint_report"] = new_report
        # 只有 error 级"硬伤"才需要继续收敛; warn(含 LLM 语义层提示)不强制修
        remaining_errors = [it for it in (new_report.get("issues") or []) if it.get("level") == "error"]
        if not remaining_errors:
            break  # 硬伤已归零, 收敛完成
        # 下一轮: 把仍存在的硬伤作为必修, 其余作参考
        err_ids = {it.get("id") for it in remaining_errors}
        cur_must_fix = remaining_errors
        cur_optional = [it for it in (new_report.get("issues") or []) if it.get("id") not in err_ids]

    if not got_any_fix:
        raise HTTPException(502, "AI 未返回有效修改")

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if d:
            d.outline = outline
            flag_modified(d, "outline")
            await s.flush()

    return {
        "draft_id": draft_id,
        "fixed_orders": sorted(all_applied),
        "lint_report": new_report,
    }


# ===========================================================================
# D1: 剧情结构门禁（Drama Gate）—— 大纲层的戏剧契约校验
#
# 与上面的一致性校验(lint)分工不同:
#   lint  查"矛盾"(死人复活/设定打架) —— 目标函数是 自洽
#   gate  查"疲软"(没钩子/没升级/伏笔没收) —— 目标函数是 好看
# 两者互不替代, 共用同一套 issue schema, 前端复用同一套红黄标注。
#
# 零 LLM 调用: 纯确定性规则, 秒级返回, 不计费。
# 遵循已定决策2: 只标注, 不改写大纲。
# ===========================================================================


@router.get("/drafts/{draft_id}/drama-gate")
async def get_drama_gate(draft_id: int, user: User = Depends(get_current_user)):
    """读取已保存的剧情结构门禁报告。"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or (d.user_id and d.user_id != user.id and not getattr(user, "is_admin", False)):
            raise HTTPException(404, "草稿不存在")
        outline = d.outline or {}
        report = outline.get("drama_report") or {
            "issues": [], "summary": {"error": 0, "warn": 0, "checked": 0}, "passed": True,
        }
        return {"draft_id": draft_id, "drama_report": report}


@router.post("/drafts/{draft_id}/drama-gate")
async def run_drama_gate(draft_id: int, user: User = Depends(get_current_user)):
    """对当前大纲跑剧情结构门禁并回写 drama_report。

    零 LLM: 不重新提炼圣经、不重建账本, 直接拿当前 outline 的契约字段做确定性校验,
    因此可秒级返回。只标注不改写(已定决策2), passed=False 也不阻断生成。
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or (d.user_id and d.user_id != user.id and not getattr(user, "is_admin", False)):
            raise HTTPException(404, "草稿不存在")
        outline = dict(d.outline or {})

    episodes = outline.get("chapters") or outline.get("episodes") or []
    if not episodes:
        raise HTTPException(400, "该草稿还没有大纲, 无法跑剧情门禁")

    report = check_outline(outline, bible=outline.get("story_bible") or {})
    report["fix_plan"] = build_fix_hints(report)
    outline["drama_report"] = report

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if d:
            d.outline = outline
            flag_modified(d, "outline")
            await s.flush()

    logger.info("drama-gate draft %d: error=%d warn=%d",
                draft_id, report["summary"]["error"], report["summary"]["warn"])
    return {"draft_id": draft_id, "drama_report": report}


# ===========================================================================
# D5.3: 结构性重写通路 —— 结构问题走"改集合同 → 重生成该集"
#
# 行级重写修不好结构问题（"这一集没有价值转变"改多少句子都没用）。
# 这里只做**识别 + 给修订方案**，实际重生成由用户另行触发（已定决策2：不自动重写）。
# ===========================================================================


@router.get("/drafts/{draft_id}/restructure-plan")
async def get_restructure_plan(draft_id: int, user: User = Depends(get_current_user)):
    """列出该剧当前的结构性问题，以及每个问题的集合同修订建议。

    数据源：已存的 drama_report + lint_report（缺哪个就用哪个）。零 LLM。
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or (d.user_id and d.user_id != user.id and not getattr(user, "is_admin", False)):
            raise HTTPException(404, "草稿不存在")
        outline = dict(d.outline or {})

    issues: list[dict] = []
    issues += (outline.get("drama_report") or {}).get("issues") or []
    issues += (outline.get("lint_report") or {}).get("issues") or []

    plan = plan_restructure(outline, issues)
    return {"draft_id": draft_id, "restructure_plan": plan}
