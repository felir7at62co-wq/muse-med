"""P2: 一致性校验器 (Consistency Linter) —— 大纲/剧本硬伤检测。

见 PLAN-大纲与剧本生成-诊断与重构 §3.5 + 已定决策2:
  - 账本证据层 + LLM层
  - **只标注不自动重写**: 产出 lint_report(warn), 前端黄标注, 用户自行决定是否修订
  - 不做自动定向重写

## 2026-11-07 设计变更

旧版有一个"规则层"，用字符匹配直接产出 error 级标注：
  - dead_reappear    死亡角色复活（字符包含 + 闪回关键词）
  - revive_violation 复活违规（账本 present ∩ dead_prev）
  - element_repeat   重大元素重复（账本 used_elements 计数）
  - mystery_unresolved 悬念悬空（字符包含）
  - character_drift  花名册外角色（读旧字段 characters，新版大纲不产出此字段）

用户裁定（2026-11-07）：
  · 这四条信息来源（账本、圣经）是有效的，但字符匹配不够可靠，不应直接产出 error。
    应作为**证据**喂给 LLM，由 LLM 结合正文内容判断是否真有问题，一律输出 warn。
  · `character_drift` 读的是新版大纲不再产出的 characters 字段，直接删除。

所以规则层改成"账本证据提取"，证据送进 LLM 提示词统一判断。

lint_report 结构:
{
  "issues": [
    {"level":"warn", "code":"dead_reappear", "episode":5,
     "message":"第5集出现已死角色 A（账本证据，LLM 综合判断）", "detail":{...}}
  ],
  "summary": {"error": 0, "warn": 1},
  "checked_at": "ISO时间",
  "checked_upto": 10
}
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Any

from ..models.llm import get_llm
from .state_ledger import snapshot

logger = logging.getLogger("consistency_lint")


# 闪回/回忆/幻觉/诈死等合法"死者可出场"的标记词
_FLASHBACK_MARKERS = ["闪回", "回忆", "往事", "幻觉", "梦境", "梦中", "假死", "诈死", "生前", "遗像", "照片", "画像"]


def _has_flashback_marker(text: str) -> bool:
    return any(m in (text or "") for m in _FLASHBACK_MARKERS)


def _episode_text(ep: dict) -> str:
    """取一集的可检索文本（标题+概要+must_have）。

    characters 字段已随大纲改版（2026-11-07）废弃，新版大纲不再产出此字段，
    故不在此取——name in text 已足够检测角色是否出场。
    """
    parts = [ep.get("title", ""), ep.get("synopsis", "")]
    parts += [str(x) for x in (ep.get("must_have") or [])]
    return "\n".join(parts)


def _ledger_evidence(episodes: list[dict], bible: dict, ledger: dict) -> list[dict]:
    """从账本与圣经中提取**事实**，供 LLM 判断。不产出 issue。

    2026-11-07 用户裁定：账本和圣经的信息源是有效的，但字符匹配不够可靠，
    不应直接产出 error 级标注。这里只提取事实（"账本记录此人已死，但第N集出现"），
    交给 LLM 结合正文判断是否真有问题。全部判定一律降为 warn。

    提取的证据类型：
      - dead_character_appears  账本记录已死的角色在后续集出现
      - revive_suspicion         世界观禁止复活，但账本记录该角色重新出现
      - element_reuse            同一重大元素在多集出现
      - mystery_unresolved       核心悬念到结局未进入 resolved_threads
    """
    evidence: list[dict] = []
    forbidden = bible.get("forbidden") or []
    no_revive = any(("复活" in f) or ("不可逆" in f) or ("无法复活" in f) for f in forbidden)
    core_mysteries = bible.get("core_mysteries") or []

    # used_elements 全局计数(检测重复)
    element_first_ep: dict[str, int] = {}
    element_repeat: dict[str, list[int]] = {}

    for ep in sorted(episodes, key=lambda e: e.get("order", 0)):
        order = ep.get("order", 0)
        text = _episode_text(ep)
        snap_prev = snapshot(ledger, order - 1)
        dead_prev = set(snap_prev.get("dead") or [])

        # 1) 死亡角色出现 —— 事实，不判定
        for name in dead_prev:
            if name in text:
                has_flashback = _has_flashback_marker(text)
                evidence.append({
                    "type": "dead_character_appears",
                    "episode": order,
                    "character": name,
                    "has_flashback_marker": has_flashback,
                    "note": f"账本记录「{name}」在此集之前已死亡；本集正文出现该名字，"
                            f"{'有' if has_flashback else '无'}闪回标记",
                })

        # 2) 复活嫌疑 —— 事实，不判定
        if no_revive:
            ep_ledger = (ledger.get("by_episode") or {}).get(str(order)) or {}
            revived = [n for n in (ep_ledger.get("present") or []) if n in dead_prev]
            for name in revived:
                has_flashback = _has_flashback_marker(text)
                evidence.append({
                    "type": "revive_suspicion",
                    "episode": order,
                    "character": name,
                    "has_flashback_marker": has_flashback,
                    "note": f"世界观禁止复活；账本记录「{name}」在此集重新出现（present），"
                            f"{'有' if has_flashback else '无'}闪回标记",
                })

        # 3) 元素重复 —— 事实，不判定
        ep_ledger = (ledger.get("by_episode") or {}).get(str(order)) or {}
        for el in (ep_ledger.get("used_elements") or []):
            el = str(el or "").strip()
            if not el:
                continue
            if el in element_first_ep:
                element_repeat.setdefault(el, [element_first_ep[el]])
                element_repeat[el].append(order)
            else:
                element_first_ep[el] = order

    for el, eps in element_repeat.items():
        evidence.append({
            "type": "element_reuse",
            "element": el,
            "episodes": eps,
            "note": f"账本记录元素「{el}」在第 {', '.join(map(str, eps))} 集出现",
        })

    # 4) 悬念悬空 —— 事实，不判定
    if episodes:
        last_order = max(e.get("order", 0) for e in episodes)
        final_snap = snapshot(ledger, last_order)
        resolved_all = set(final_snap.get("resolved_threads") or [])
        for mystery in core_mysteries:
            m = str(mystery or "").strip()
            if not m:
                continue
            covered = any((m in r) or (r in m) for r in resolved_all)
            if not covered:
                evidence.append({
                    "type": "mystery_unresolved",
                    "mystery": m,
                    "last_episode": last_order,
                    "resolved_threads": list(resolved_all)[:10],
                    "note": f"核心悬念「{m}」到结局（第{last_order}集）未进入resolved_threads",
                })

    return evidence


_LLM_LINT_PROMPT = """你是剧情逻辑审校专家。下面给你"前序世界状态"和"本批各集概要", 请找出与既定事实的逻辑矛盾。

## 前序世界状态
{snapshot}

## 本批各集概要
{episodes_block}

## 账本提示的证据（来自状态账本与设定圣经，仅供参考，不一定成立）
{evidence_block}

## 需要你重点检查的矛盾类型
- 时间线倒错: 后一集事件时间早于前一集且无闪回标记
- 关系矛盾: 已确立的关系(如"已揭穿身份")在后续被当作未发生
- 数量/设定矛盾: 同一实体属性前后冲突(人数、地点、能力上限)
- 因果断裂: 某集结果缺少前因, 或前因未导向应有结果
- 角色生死矛盾: 账本记录已死亡的角色再次出场，需结合正文判断是闪回/假死/诈死还是真矛盾
- 元素重复: 同一重大元素在多集出现，需判断是贯穿全剧的设定还是不该重复的桥段
- 核心悬念悬空: 核心悬念到结局未回收，需结合正文判断是否已被解决（字符不完全匹配时以语义为准）

对上面的账本证据：若正文实际已处理（闪回/假死/贯穿设定/已用其他方式回收），不要报为问题；
只有确实构成矛盾时才报。证据只是提示，不是结论。

## 输出格式(严格 JSON, 不要 markdown, 不要解释)
{{
  "issues": [
    {{"level": "warn", "episode": 集号数字, "code": "timeline|relation|setting|causal|dead_reappear|element_repeat|mystery_unresolved", "message": "一句话说明矛盾"}}
  ]
}}
若无矛盾, 输出 {{"issues": []}}。只输出 JSON。
"""


def _extract_json(text: str) -> dict:
    if not text:
        return {"issues": []}
    raw = text.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw)
    except Exception:
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if not m:
            return {"issues": []}
        try:
            return json.loads(m.group(0))
        except Exception:
            return {"issues": []}


async def _llm_layer(episodes: list[dict], ledger: dict, *,
                     evidence: list[dict] | None = None,
                     provider: str = "gemini") -> list[dict]:
    """LLM 语义层校验(按需)。失败返回空, 不阻断。

    2026-11-07：规则层已改为账本证据提取（`_ledger_evidence`），证据作为提示送进
    本层，由 LLM 结合正文判断是否真有问题。所有产出一律 warn —— 不再有 error 级
    硬伤由规则层直接产出，因为字符匹配不够可靠。
    """
    if not episodes:
        return []
    from .state_ledger import snapshot_text
    min_order = min(e.get("order", 0) for e in episodes)
    prev_order = min_order - 1
    if prev_order >= 1:
        snap_txt = snapshot_text(ledger, prev_order)
    else:
        # 本批从第 1 集起 = 故事开头, 没有任何前序集。
        # 绝不能注入"截至第0集"的快照, 否则 LLM 会臆造出不存在的"第0集"并报时间线倒错的假硬伤。
        snap_txt = (
            "（本批从第1集开始，是故事开头，之前没有任何已发生的剧情。"
            "不存在“第0集”或更早的集，请勿据此臆造前序世界状态或时间线矛盾。）"
        )
    lines = []
    for ep in sorted(episodes, key=lambda e: e.get("order", 0)):
        lines.append(f"[第{ep.get('order')}集]{ep.get('title','')}: {ep.get('synopsis','')}")
    evidence_block = "\n".join(f"- {ev.get('note', '')}" for ev in (evidence or [])) or "（无）"
    prompt = _LLM_LINT_PROMPT.format(
        snapshot=snap_txt, episodes_block="\n".join(lines), evidence_block=evidence_block)
    try:
        # 温度=0: 让 LLM 语义层结果尽量可复现(同一份大纲连跑两次不再报出不同问题),
        # 避免"修完又冒新问题"其实只是校验器每次换了一批说法的错觉。
        llm = get_llm("extract", temperature=0, provider=provider)
        resp = await llm.ainvoke(prompt)
        data = _extract_json(getattr(resp, "content", "") or "")
        # 本批实际存在的合法集号集合, 用于过滤 LLM 臆造的"第0集/越界集号"
        valid_orders = {int(e.get("order")) for e in episodes if str(e.get("order", "")).lstrip("-").isdigit()}
        out = []
        for it in (data.get("issues") or []):
            ep_raw = it.get("episode", 0)
            try:
                ep_no = int(ep_raw)
            except (TypeError, ValueError):
                ep_no = 0
            # 丢弃臆造/非法集号(如第0集、超出本批范围的集号)
            if ep_no not in valid_orders:
                logger.info("过滤 LLM 越界集号 issue: episode=%s message=%s", ep_raw, it.get("message"))
                continue
            out.append({
                # 2026-11-07：所有产出一律 warn。不再有规则层直接产出 error ——
                # 字符匹配的账本证据不够可靠，硬伤判定交给 LLM 综合判断，
                # 而即便 LLM 也不产出 error，避免"修完又冒新问题"的反复打脸。
                "level": "warn",
                "code": "llm_" + str(it.get("code", "semantic")),
                "episode": ep_no,
                "message": str(it.get("message", "")).strip(),
                "detail": {"source": "llm"},
            })
        return [x for x in out if x["message"]]
    except Exception as e:  # noqa: BLE001
        logger.warning("LLM 语义层校验失败(降级跳过): %s", e)
        return []


async def lint_outline(
    outline: dict,
    *,
    use_llm: bool = True,
    provider: str = "gemini",
    ledger_override: dict | None = None,
) -> dict:
    """对整份大纲跑一致性校验, 产出 lint_report。只标注不修改。

    outline 需包含: chapters/episodes(集列表), story_bible, state_ledger

    ⚠️ `ledger_override` = **有效账本**（计划 + 稿子实况覆盖，见 stages/divergence.py）。
    不传它的话，用户亲手把"A 第3集死"改成"第5集死"之后，这里会拿计划账本当基线，
    把第5集报成误报 —— 把用户的**意图**判成问题（2026-09-21 用户提出的问题）。
    计划与实际的差异归"大纲分岔"维度，不是 error。

    2026-11-07 变更：旧版规则层直接产出 error（字符匹配+账本），现在改为把账本证据
    作为提示（evidence block）送进 LLM，由 LLM 结合正文判断是否真有问题，一律输出
    warn。不再有 error 级的规则层产出——字符匹配的准确率不达到"硬伤"标准。
    """
    episodes = outline.get("chapters") or outline.get("episodes") or []
    bible = outline.get("story_bible") or {}
    ledger = ledger_override if ledger_override is not None else (outline.get("state_ledger") or {})

    # 账本证据提取（不产出 issue，仅作为 LLM 提示）
    evidence = _ledger_evidence(episodes, bible, ledger)
    issues = await _llm_layer(episodes, ledger, evidence=evidence, provider=provider) \
        if use_llm else []

    # 排序: error 优先, 再按集号（2026-11-07 后不再产出 error，保留排序以兼容前端）
    issues.sort(key=lambda x: (0 if x.get("level") == "error" else 1, x.get("episode", 0)))
    # 为每条 issue 分配稳定 id(前端勾选/AI定向修改用)
    for i, it in enumerate(issues):
        it["id"] = f"{it.get('code','issue')}-{it.get('episode',0)}-{i}"
    summary = {
        "error": sum(1 for i in issues if i.get("level") == "error"),
        "warn": sum(1 for i in issues if i.get("level") == "warn"),
    }
    checked_upto = max((e.get("order", 0) for e in episodes), default=0)
    return {
        "issues": issues,
        "summary": summary,
        "checked_at": datetime.utcnow().isoformat() + "Z",
        "checked_upto": checked_upto,
    }