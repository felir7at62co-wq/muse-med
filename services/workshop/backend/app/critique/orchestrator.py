"""评审精修编排核心: 多身份审查 -> 合议 -> 仲裁 -> 编辑改写, 分层多轮。

单集为单位。每轮按主题激活对应身份，多模型并行审查，合议去重，
仲裁排序成编辑工单，编辑(用户创作模型)定向改写，进入下一轮。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Optional

from ..models.llm import ainvoke_with_fallback
from . import roles as R
from .rules import scan_text

logger = logging.getLogger("critique")


def _parse_json(text: str, fallback):
    """从 LLM 输出里抽 JSON (容忍 markdown 代码块包裹)。"""
    if not text:
        return fallback
    s = text.strip()
    # 去掉 ```json ... ``` 包裹
    m = re.search(r"```(?:json)?\s*(.+?)\s*```", s, re.DOTALL)
    if m:
        s = m.group(1).strip()
    try:
        return json.loads(s)
    except Exception:  # noqa: BLE001
        # 尝试截取第一个 [ 或 { 到最后一个 ] 或 }
        for lb, rb in (("[", "]"), ("{", "}")):
            i, j = s.find(lb), s.rfind(rb)
            if i != -1 and j != -1 and j > i:
                try:
                    return json.loads(s[i:j + 1])
                except Exception:  # noqa: BLE001
                    continue
        return fallback


async def _run_one_reviewer(*, role_id: str, role_cfg: dict, model: str, content: str) -> list[dict]:
    """单身份单模型审查, 返回 issue 列表 (打上 role/model 标记)。"""
    sys = role_cfg["system_prompt"] + "\n\n" + R.issue_output_schema_hint(role_id)
    user = f"【待审查稿件】\n{content}"
    try:
        resp = await ainvoke_with_fallback(
            [{"role": "system", "content": sys}, {"role": "user", "content": user}],
            role="rewrite",
            temperature=role_cfg.get("temperature", 0.4),
            primary=model,  # type: ignore[arg-type]
        )
        raw = resp.content if hasattr(resp, "content") else str(resp)
        arr = _parse_json(raw, [])
        if not isinstance(arr, list):
            arr = []
        out = []
        for it in arr:
            if not isinstance(it, dict):
                continue
            it["role"] = role_id
            it["model"] = model
            out.append(it)
        return out
    except Exception as e:  # noqa: BLE001
        logger.warning("reviewer %s/%s failed: %s", role_id, model, e)
        return []


def _merge_same_role(issues: list[dict], total_models: int) -> list[dict]:
    """同身份跨模型合议: 按 (issue 文本前20字) 粗粒度去重, 计置信度 = 命中模型数/总模型数。"""
    bucket: dict[str, dict] = {}
    for it in issues:
        key = (it.get("issue") or "")[:20]
        if not key:
            continue
        if key not in bucket:
            models = set()
            it = dict(it)
            it["_models"] = models
            bucket[key] = it
        bucket[key]["_models"].add(it.get("model", ""))
    out = []
    for it in bucket.values():
        n = len(it.pop("_models") or [])
        it["confidence"] = int(round(100 * n / max(1, total_models)))
        out.append(it)
    return out


async def review_episode(*, content: str, theme: str, models: list[str], emit=None) -> list[dict]:
    """对一集当前稿做一轮审查: 非LLM规则 + 本主题激活身份 × 多模型并行。"""
    issues: list[dict] = []

    # 1) 非 LLM 规则层 (仅 deai 主题跑, 其它主题规则意义不大)
    if theme == "deai":
        issues.extend(scan_text(content))

    # 2) 本主题激活的评审身份
    active_roles = R.THEME_ROLES.get(theme, [])
    tasks = []
    meta = []
    for role_id in active_roles:
        cfg = R.REVIEW_ROLES.get(role_id)
        if not cfg:
            continue
        if not R.role_enabled(role_id):  # admin 在后台关掉了该身份
            continue
        for model in models:
            if emit:
                emit("reviewer_start", role=role_id, model=model)
            tasks.append(_run_one_reviewer(role_id=role_id, role_cfg=cfg, model=model, content=content))
            meta.append((role_id, model))
    results = await asyncio.gather(*tasks, return_exceptions=True)

    by_role: dict[str, list[dict]] = {}
    for (role_id, model), res in zip(meta, results):
        if isinstance(res, Exception) or not res:
            if emit:
                emit("reviewer_done", role=role_id, model=model, count=0)
            continue
        by_role.setdefault(role_id, []).extend(res)
        if emit:
            emit("reviewer_done", role=role_id, model=model, count=len(res))

    # 3) 同身份合议
    for role_id, role_issues in by_role.items():
        issues.extend(_merge_same_role(role_issues, total_models=len(models)))
    return issues


async def review_global(*, episodes_text: dict[int, str], models: list[str], emit=None) -> dict[int, list[dict]]:
    """跨集连贯审查 (M3): 看全剧梗概序列, 产出按集归类的全局问题。

    返回 {episode_order: [issue, ...]}, 供各集 structure 轮注入。
    """
    cfg = R.GLOBAL_REVIEWER
    # 拼装全剧梗概 (每集取前 600 字摘要, 控制 token)
    parts = []
    for ep in sorted(episodes_text.keys()):
        body = (episodes_text[ep] or "")[:600]
        parts.append(f"【第{ep}集】\n{body}")
    overview = "\n\n".join(parts)
    if not overview.strip():
        return {}

    sys = cfg["system_prompt"] + "\n\n" + R.issue_output_schema_hint(cfg.get("id"))
    user = f"【全剧各集梗概序列】\n{overview}"
    all_issues: list[dict] = []
    for model in models:
        if emit:
            emit("reviewer_start", role="continuity_reviewer", model=model, scope="global")
        try:
            resp = await ainvoke_with_fallback(
                [{"role": "system", "content": sys}, {"role": "user", "content": user}],
                role="rewrite", temperature=cfg.get("temperature", 0.3), primary=model,  # type: ignore[arg-type]
            )
            raw = resp.content if hasattr(resp, "content") else str(resp)
            arr = _parse_json(raw, [])
            if isinstance(arr, list):
                for it in arr:
                    if isinstance(it, dict):
                        it["role"] = "continuity_reviewer"
                        it["model"] = model
                        all_issues.append(it)
            if emit:
                emit("reviewer_done", role="continuity_reviewer", model=model,
                     count=len([x for x in arr if isinstance(x, dict)]) if isinstance(arr, list) else 0)
        except Exception as e:  # noqa: BLE001
            logger.warning("global reviewer/%s failed: %s", model, e)
            if emit:
                emit("reviewer_done", role="continuity_reviewer", model=model, count=0)

    merged = _merge_same_role(all_issues, total_models=len(models))
    # 按集号归类 (从 locator.scene_no 抽第一个出现的集号)
    import re as _re
    by_ep: dict[int, list[dict]] = {}
    for it in merged:
        loc = str((it.get("locator") or {}).get("scene_no", ""))
        nums = _re.findall(r"(\d+)", loc)
        target = int(nums[0]) if nums else (sorted(episodes_text.keys())[0] if episodes_text else 1)
        by_ep.setdefault(target, []).append(it)
    return by_ep


async def arbitrate(issues: list[dict], *, model: str = "gemini") -> dict:
    """仲裁: 合并去重 + severity×置信排序 + 标矛盾。失败则代码兜底排序。"""
    if not issues:
        return {"items": [], "conflicts": []}

    def _sev_rank(s):
        return {"high": 3, "mid": 2, "low": 1}.get(s, 0)

    # 代码侧先排序 (兜底 + 给 LLM 减负)
    sorted_issues = sorted(
        issues,
        key=lambda it: (_sev_rank(it.get("severity")), it.get("confidence", 0)),
        reverse=True,
    )
    # 控制工单规模, 最多 20 条
    sorted_issues = sorted_issues[:20]
    return {"items": sorted_issues, "conflicts": []}


async def chief_edit_plan(*, content: str, issues: list[dict], model: str,
                          bible_constraint: str = "", global_warnings: str = "") -> dict:
    """总编辑决策层(v2): 综合本集全部评审意见 + 圣经 + 全局预警 → 输出确定改写方案。

    返回 {"plan":[...], "dropped":[...], "note":"..."}。失败则降级为空方案
    (上层会回退到直接用原始 issues 工单)。
    """
    if not issues:
        return {"plan": [], "dropped": [], "note": ""}
    lines = []
    for i, it in enumerate(issues):
        lines.append(
            f"{i}. [{it.get('severity','?')}|{it.get('role','')}|置信{it.get('confidence',0)}%] "
            f"{it.get('issue','')}｜证据:{it.get('evidence','')}｜建议:{it.get('fix_hint','')}"
        )
    issues_text = "\n".join(lines)
    sys = R.CHIEF_EDITOR_SYSTEM
    if bible_constraint:
        sys += "\n\n" + bible_constraint
    parts = [f"【本集原文】\n{content}", f"【评审意见清单】\n{issues_text}"]
    if global_warnings:
        parts.append(f"【全局总览预警(本集相关)】\n{global_warnings}")
    user = "\n\n".join(parts)
    try:
        resp = await ainvoke_with_fallback(
            [{"role": "system", "content": sys}, {"role": "user", "content": user}],
            role="rewrite", temperature=0.3, primary=model,  # type: ignore[arg-type]
        )
        raw = resp.content if hasattr(resp, "content") else str(resp)
        parsed = _parse_json(raw, None)
        if isinstance(parsed, dict) and isinstance(parsed.get("plan"), list):
            return {
                "plan": parsed.get("plan", []),
                "dropped": parsed.get("dropped", []),
                "note": parsed.get("note", ""),
            }
    except Exception as e:  # noqa: BLE001
        logger.warning("chief_edit_plan failed (fallback to raw issues): %s", e)
    return {"plan": [], "dropped": [], "note": ""}


def _plan_to_order(plan: dict) -> dict:
    """把总编辑方案转成 editor 可消费的工单格式 (items)。"""
    items = []
    for p in (plan.get("plan") or []):
        if not isinstance(p, dict):
            continue
        items.append({
            "severity": p.get("severity", "mid"),
            "confidence": 100,
            "role": "chief_editor",
            "issue": p.get("problem", ""),
            "evidence": p.get("target", ""),
            "fix_hint": p.get("action", ""),
        })
    return {"items": items, "conflicts": []}


async def edit_episode(*, content: str, order: dict, model: str, is_storyboard: bool,
                       bible_constraint: str = "", chief_note: str = "") -> dict:
    """编辑按工单定向改写, 返回 {new_text, applied, rejected}。

    bible_constraint: 设定圣经硬约束(可空)。注入 system, 确保改写不违反世界观/
    人物正名/称谓/核心驱动力, 不引入时代违禁词。
    """
    items = order.get("items", [])
    if not items:
        return {"new_text": content, "applied": [], "rejected": []}

    lines = []
    for i, it in enumerate(items):
        lines.append(
            f"{i}. [{it.get('severity','?')}|置信{it.get('confidence',0)}%] "
            f"{it.get('issue','')}｜证据:{it.get('evidence','')}｜建议:{it.get('fix_hint','')}"
        )
    order_text = "\n".join(lines)

    fmt_note = "当前稿是剧本分镜（JSON 文本），改写后保持同样的 JSON 结构。" if is_storyboard \
        else "当前稿是章节正文（纯文本），改写后保持纯文本。"
    sys = R.EDITOR_SYSTEM + "\n" + fmt_note
    if bible_constraint:
        sys = sys + "\n\n" + bible_constraint
    note_block = f"\n\n【总编辑整体说明(必须遵循)】\n{chief_note}" if chief_note else ""
    user = f"【当前稿】\n{content}\n\n【编辑工单(总编辑既定方案, 直接执行)】\n{order_text}{note_block}"

    resp = await ainvoke_with_fallback(
        [{"role": "system", "content": sys}, {"role": "user", "content": user}],
        role="rewrite",
        temperature=0.5,
        primary=model,  # type: ignore[arg-type]
    )
    raw = resp.content if hasattr(resp, "content") else str(resp)
    parsed = _parse_json(raw, None)
    if isinstance(parsed, dict) and parsed.get("new_text"):
        return {
            "new_text": parsed.get("new_text") or content,
            "applied": parsed.get("applied", []),
            "rejected": parsed.get("rejected", []),
        }
    # 解析失败: 视为本轮未改 (安全兜底, 不破坏原稿)
    logger.warning("editor output unparseable, keep original")
    return {"new_text": content, "applied": [], "rejected": []}