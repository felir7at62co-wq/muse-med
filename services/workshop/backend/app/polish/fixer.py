"""定向修复: 对单条硬伤工单, 只改相关集做最小 diff 式修复, 改完复核是否消除。

原则:
  - 只喂"涉及集", 指令强调"只消除本条硬伤的最小改动, 勿动无关情节" → 降低"修A坏B"。
  - 复用 stages.router.regenerate_storyboard_with_feedback / regenerate_chapter_with_feedback
    (逐集带反馈重写), 注入 bible 硬约束。
  - 复核: 时代穿帮/姓名/称谓 → 重跑 scan_against_bible(规则, 0次LLM);
          死人复活/设定冲突 → 复用账本重抽相关集(1次LLM)判断矛盾是否消除。
不顺手做别的: 不重排结构、不追分数、不做全剧重写。
"""
from __future__ import annotations

import logging

from sqlalchemy import select

from ..db import session_scope, ScriptStoryboard, ScriptChapter
from ..critique.bible import bible_constraint_text, scan_against_bible
from .hardcheck import _shots_to_text
from .ledger import build_ledger, detect_ledger_issues

logger = logging.getLogger("polish.fixer")

# 规则可复核的硬伤类型(改完重扫即可判断关闭)
_RULE_VERIFIABLE = {"anachronism", "name_drift", "address_conflict"}
# 账本可复核的硬伤类型(需重抽相关集事实)
_LEDGER_VERIFIABLE = {"dead_revive", "fact_conflict"}


def _build_feedback(issue: dict, bible: dict) -> str:
    """构造给逐集重写的反馈: 全约束 + 本条硬伤 + 最小改动要求。"""
    constraint = bible_constraint_text(bible) if bible else ""
    lines = []
    if constraint:
        lines.append(constraint)
        lines.append("")
    lines.append("【本次只修复这一个硬伤, 做最小必要改动】")
    lines.append(f"硬伤: {issue.get('title','')}")
    if issue.get("evidence"):
        lines.append(f"依据: {issue['evidence']}")
    if issue.get("anchor"):
        lines.append(f"修复方向: {issue['anchor']}")
    lines.append(
        "要求: 只做能消除上述硬伤的最小改动; 严禁改动与此硬伤无关的情节、人物、台词、场景; "
        "保持本集其余内容与原文一致; 不要新增其它设定。"
    )
    return "\n".join(lines)


async def _has_storyboard(draft_id: int) -> bool:
    async with session_scope() as s:
        row = (await s.execute(
            select(ScriptStoryboard.id).where(ScriptStoryboard.draft_id == draft_id).limit(1)
        )).first()
    return row is not None


async def fix_issue(draft_id: int, issue: dict, bible: dict) -> dict:
    """修复单条工单: 对其涉及集逐集定向改写。返回 {fixed_eps, error}。"""
    from ..stages.router import (
        regenerate_storyboard_with_feedback,
        regenerate_chapter_with_feedback,
        FeedbackRegenerateIn,
    )
    feedback = _build_feedback(issue, bible)
    use_sb = await _has_storyboard(draft_id)
    eps = sorted(set(int(e) for e in (issue.get("episodes") or []) if e is not None))
    fixed = 0
    err = ""
    for ep in eps:
        try:
            payload = FeedbackRegenerateIn(feedback=feedback)
            if use_sb:
                await regenerate_storyboard_with_feedback(
                    draft_id=draft_id, chapter_order=ep, payload=payload)
            else:
                await regenerate_chapter_with_feedback(
                    draft_id=draft_id, chapter_order=ep, payload=payload)
            fixed += 1
        except Exception as e:  # noqa: BLE001
            err = str(e)[:150]
            logger.warning("fix draft %d issue ep %d failed: %s", draft_id, ep, e)
    return {"fixed_eps": fixed, "error": err}


async def _load_eps_text(draft_id: int, eps: list[int]) -> dict[int, str]:
    """只读涉及集的正文(复核用, 省资源)。"""
    texts: dict[int, str] = {}
    if not eps:
        return texts
    async with session_scope() as s:
        sbs = (await s.execute(
            select(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id,
                ScriptStoryboard.chapter_order.in_(eps),
            )
        )).scalars().all()
        if sbs:
            for sb in sbs:
                texts[int(sb.chapter_order)] = _shots_to_text(sb.shots_json or [])
            return texts
        chs = (await s.execute(
            select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order.in_(eps),
            )
        )).scalars().all()
        for ch in chs:
            texts[int(ch.chapter_order)] = ch.full_text or ""
    return texts


async def verify_issue(draft_id: int, issue: dict, bible: dict) -> bool:
    """复核单条工单是否已消除。返回 True=已关闭。

    - 规则类(时代/姓名/称谓): 重跑 scan_against_bible, 该类问题在涉及集不再命中 → 关闭。
    - 账本类(死人复活/设定冲突): 重抽涉及集事实, detect_ledger_issues 不再报同类 → 关闭。
    """
    itype = issue.get("type")
    eps = sorted(set(int(e) for e in (issue.get("episodes") or []) if e is not None))
    texts = await _load_eps_text(draft_id, eps)
    if not texts:
        return False

    if itype in _RULE_VERIFIABLE:
        gate_role = {
            "anachronism": "gate_anachronism",
            "name_drift": "gate_name_drift",
            "address_conflict": "gate_address",
        }[itype]
        for ep, txt in texts.items():
            for raw in scan_against_bible(txt or "", bible or {}, episode=ep):
                if raw.get("role") == gate_role:
                    return False  # 仍命中同类 → 未关闭
        return True

    if itype in _LEDGER_VERIFIABLE:
        # 重抽涉及集(可能不足以覆盖全剧, 但对"该条矛盾"够用)
        ledger = await build_ledger(texts)
        new_issues = detect_ledger_issues(ledger)
        # 同类型且涉及集有交集 → 视为仍存在
        for ni in new_issues:
            if ni.get("type") == itype:
                if set(ni.get("episodes") or []) & set(eps):
                    return False
        return True

    # 未知类型: 保守视为未关闭
    return False