"""D5.3: 结构性重写通路 —— 结构问题走"改集合同 → 重生成该集"。

动机（见 docs/PLAN-剧情结构与戏剧契约-v3.md §5-D5.3）：
  现有精修只有**行级重写**通路（rewrite/service.py 改句子）。但"这一集没有价值转变"
  "压迫强度三集没升级""结尾卡点无效"这类问题是**结构问题**——编辑句子永远修不好它们。
  本模块识别这类诊断，并把它们转成对集合同的修订建议 + 触发单集重生成。

与 v2 已定决策2 的关系：
  "硬伤只标注，不自动重写"针对的是**校验器**。本模块是**用户显式触发**的动作
  （点击"按新契约重生成本集"），不在生成链路里自动跑，也不修改大纲之外的任何东西。
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("restructure")

# 结构性问题码（来自 drama_gate）→ 这是"要改结构"而非"要改句子"的信号
STRUCTURAL_GATE_CODES = {
    "value_shift_noop": "本集没有发生价值转变",
    "value_shift_repeat": "本集的价值转变与前几集重复",
    "escalation_stall": "压迫强度停滞",
    "hook_weak": "结尾卡点无效",
    "hook_missing_leads_to": "卡点没有指向下一集",
    "stakes_vague": "失败代价空泛",
    "stakes_too_vague_short": "失败代价空泛",
    # 2026-10-11：drama_gate 新拆出的 code。原先「无」「暂无」这类**字段没填**
    # 被混报成 stakes_too_vague_short（读起来像文笔批评），拆开后这里必须一并
    # 登记，否则它在前端结构性门禁里是个认不出来的孤儿 code。
    "stakes_missing": "还没有填写失败代价",
    "promise_overdue": "伏笔逾期未回收",
}

# 结构性问题在评审侧的表现（LLM issue 文本关键词）——定性描述兜底识别
_STRUCTURAL_ISSUE_KEYWORDS = [
    "没有价值转变", "价值转变", "节奏拖沓", "中段疲软", "集与集", "因果",
    "钩子", "卡点", "失败代价", "赌注", "升级", "反转无力", "高潮无力",
    "开头不够抓人", "缺少冲突", "流水账",
]


def _norm(text: Any) -> str:
    import re
    return re.sub(r"[\s，。、；：！？,.;:!?\"'“”‘’()（）\[\]【】—\-…]+", "", str(text or "")).lower()


def classify_issues(issues: list[dict]) -> dict:
    """把一批 issue 分成"结构问题"与"行文问题"。

    结构问题 → 走改集合同 + 重生成该集
    行文问题 → 走原有行级重写（rewrite/service.py）

    返回 {"structural": [...], "textual": [...], "structural_episodes": [集号]}
    """
    structural: list[dict] = []
    textual: list[dict] = []

    for it in (issues or []):
        if not isinstance(it, dict):
            continue
        code = str(it.get("code") or "")
        role_kind = str(it.get("role_kind") or "")

        # 1) 门禁的结构码，直接判定
        if code in STRUCTURAL_GATE_CODES:
            structural.append({**it, "_why": STRUCTURAL_GATE_CODES[code]})
            continue
        # 2) 钩子体检（D5.1 结构化输出）
        if role_kind == "hook_audit":
            structural.append({**it, "_why": "钩子结构问题"})
            continue
        # 3) 评审侧定性描述里的结构性关键词
        text = f"{it.get('issue') or ''}{it.get('fix_hint') or ''}"
        if any(k in text for k in _STRUCTURAL_ISSUE_KEYWORDS):
            structural.append({**it, "_why": "结构性问题（评审判定）"})
            continue
        textual.append(it)

    eps: list[int] = []
    for it in structural:
        ep = it.get("episode")
        if isinstance(ep, int) and ep not in eps:
            eps.append(ep)

    return {"structural": structural, "textual": textual,
            "structural_episodes": sorted(eps)}


def build_contract_revision(episode: dict, structural_issues: list[dict]) -> dict:
    """根据结构性问题，给出该集**集合同的修订建议**（不改写正文）。

    返回 {"episode","revisions":[{"field","current","suggest","reason"}],"note"}
    只产出建议，落笔由用户/生成链路决定——与 v2 决策2 一致。
    """
    revisions: list[dict] = []
    codes = {str(i.get("code") or "") for i in structural_issues}

    def _cur(*path, default=""):
        node: Any = episode
        for k in path:
            if not isinstance(node, dict):
                return default
            node = node.get(k)
        return node if isinstance(node, str) else default

    if codes & {"value_shift_noop", "value_shift_repeat"}:
        revisions.append({
            "field": "value_shift",
            "current": f"{_cur('value_shift','from')} → {_cur('value_shift','to')}",
            "suggest": "重新设计本集的价值转变：让主角在本集结束时，处境或认知与开始时不同",
            "reason": "本集没有发生价值转变（或与前几集重复），观众会觉得白看一集",
        })

    if "escalation_stall" in codes:
        revisions.append({
            "field": "escalation",
            "current": _cur("escalation"),
            "suggest": "把本集的失败代价提上一档：让主角失去更重要的东西，或让退路更少",
            "reason": "连续多集压迫强度没有上升，中段会疲软",
        })

    if codes & {"stakes_vague", "stakes_too_vague_short", "stakes_missing"}:
        revisions.append({
            "field": "stakes",
            "current": _cur("stakes"),
            "suggest": "写成具体后果：失去身份/资格/亲情/自由/传承/机会/信任/性命中的哪一样",
            "reason": "失败代价空泛，观众感受不到风险",
        })

    if codes & {"hook_weak", "hook_missing_leads_to"}:
        revisions.append({
            "field": "hook_out",
            "current": f"{_cur('hook_out','type')}／{_cur('hook_out','leads_to')}",
            "suggest": "改用强卡点（危机爆发/反转揭露/对抗升级/行动启动/奇观出现），"
                      "并写明它直接引发下一集发生什么",
            "reason": "结尾卡点无效，观众没有看下一集的理由",
        })

    if "promise_overdue" in codes:
        revisions.append({
            "field": "payoff",
            "current": "；".join(episode.get("payoff") or []),
            "suggest": "在本集安排回收前文埋下的伏笔，或从大纲里删掉那个伏笔",
            "reason": "伏笔埋了没收是创作事故",
        })

    return {
        "episode": episode.get("order"),
        "revisions": revisions,
        "note": ("本集的问题是**结构问题**，改句子修不好——"
                 "请先按上面的建议修改集合同，再重新生成本集正文。"),
    }


def plan_restructure(outline: dict, issues: list[dict]) -> dict:
    """给出整部剧的结构性重构计划（不执行）。

    返回 {"structural_episodes":[...], "per_episode":[{episode,revisions,note}],
          "textual_count": n, "note": ...}
    """
    cls = classify_issues(issues)
    eps = list(outline.get("chapters") or outline.get("episodes") or [])
    by_order = {e.get("order"): e for e in eps if isinstance(e, dict)}

    per_episode: list[dict] = []
    for order in cls["structural_episodes"]:
        ep = by_order.get(order)
        if not ep:
            continue
        own = [i for i in cls["structural"] if i.get("episode") == order]
        plan = build_contract_revision(ep, own)
        if plan["revisions"]:
            per_episode.append(plan)

    return {
        "structural_episodes": cls["structural_episodes"],
        "per_episode": per_episode,
        "textual_count": len(cls["textual"]),
        "note": (
            f"共识别 {len(cls['structural'])} 条结构性问题（涉及 "
            f"{len(cls['structural_episodes'])} 集）与 {len(cls['textual'])} 条行文问题。"
            "结构性问题需改集合同后重生成该集；行文问题走常规精修即可。"
        ),
    }
