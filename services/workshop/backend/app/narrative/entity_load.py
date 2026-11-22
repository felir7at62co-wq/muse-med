"""实体负荷分析 —— 检测专有名词(国名/企业/组织/地名)泛滥导致的认知过载。

用一次 LLM 抽取每集出现的专有名词, 统计:
  - 每集"新引入实体数"(per_episode_new)
  - 全剧实体清单(首现集/出现集/次数)
  - burst: 连续集集中引入大量新实体
  - once_only: 全剧只出现一次的专有名词(短剧大忌, 建议合并/泛化)

结果挂 outline["entity_report"]。
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Any

from ..models.llm import get_llm

logger = logging.getLogger("entity_load")

# 连续窗口内新实体数超过此值 => burst 提醒
_BURST_WINDOW = 2      # 连续 2 集
_BURST_THRESHOLD = 5   # 窗口内新实体 >= 5 个


_EXTRACT_PROMPT = """你是剧本信息密度分析助手。下面是一部短剧各集的大纲概要。
请抽取每一集中出现的**专有名词**(仅限: 国家/势力名、企业/公司名、组织/机构/门派名、特殊地名),
不要抽取人物姓名、不要抽取普通名词。

## 各集概要
{episodes_block}

## 输出格式(严格 JSON, 不要 markdown, 不要解释)
{{
  "by_episode": {{
    "集号(字符串)": [
      {{"name": "东辰集团", "type": "org"}},
      {{"name": "南疆", "type": "place"}}
    ]
  }}
}}
type 取值: nation(国/势力) | org(企业/组织/机构/门派) | place(特殊地名)。
同一名词在同集重复只输出一次。没有专有名词的集输出空数组。只输出 JSON。
"""


def _extract_json(text: str) -> dict:
    if not text:
        return {"by_episode": {}}
    raw = text.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw)
    except Exception:
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if not m:
            return {"by_episode": {}}
        try:
            return json.loads(m.group(0))
        except Exception:
            return {"by_episode": {}}


def _fmt_episodes(episodes: list[dict]) -> str:
    lines = []
    for ep in sorted(episodes, key=lambda e: int(e.get("order", 0) or 0)):
        must = "、".join(ep.get("must_have") or [])
        lines.append(
            f"[第{ep.get('order')}集]{ep.get('title','')}\n"
            f"概要: {ep.get('synopsis','')}\n"
            f"关键事件: {must}"
        )
    return "\n\n".join(lines)


async def analyze_entities(outline: dict, *, provider: str = "gemini") -> dict[str, Any]:
    """抽取专有名词并生成实体负荷报告。"""
    episodes = outline.get("chapters") or outline.get("episodes") or []
    if not episodes:
        return {
            "entities": [], "per_episode_new": {}, "issues": [],
            "summary": {"total": 0, "once_only": 0, "orgs": 0},
            "analyzed_at": datetime.utcnow().isoformat() + "Z",
        }

    prompt = _EXTRACT_PROMPT.format(episodes_block=_fmt_episodes(episodes))
    try:
        llm = get_llm("extract", temperature=0, provider=provider)
        resp = await llm.ainvoke(prompt)
        data = _extract_json(getattr(resp, "content", "") or "")
    except Exception as e:  # noqa: BLE001
        logger.warning("entity 抽取失败(降级为空): %s", e)
        data = {"by_episode": {}}

    by_ep = data.get("by_episode") or {}

    # 归并同名实体, 记录首现集/出现集/次数/类型
    entity_map: dict[str, dict] = {}
    per_episode_new: dict[str, int] = {}
    for ep_no in sorted(by_ep.keys(), key=lambda x: int(x) if str(x).isdigit() else 0):
        if not str(ep_no).isdigit():
            continue
        o = int(ep_no)
        seen_this_ep = set()
        new_in_ep = 0
        for item in (by_ep[ep_no] or []):
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", "")).strip()
            if not name or name in seen_this_ep:
                continue
            seen_this_ep.add(name)
            etype = str(item.get("type", "org")).strip() or "org"
            if name not in entity_map:
                entity_map[name] = {
                    "name": name, "type": etype,
                    "first_episode": o, "episodes": [o], "count": 1,
                }
                new_in_ep += 1
            else:
                em = entity_map[name]
                if o not in em["episodes"]:
                    em["episodes"].append(o)
                em["count"] += 1
        if new_in_ep:
            per_episode_new[str(o)] = new_in_ep

    entities = sorted(entity_map.values(), key=lambda e: (e["first_episode"], e["name"]))

    # ── 生成 issues ──
    issues: list[dict] = []

    # 1) burst: 滑动窗口内新实体数超阈值
    ordered_new = sorted(((int(k), v) for k, v in per_episode_new.items()), key=lambda x: x[0])
    for i in range(len(ordered_new)):
        win = [ordered_new[j] for j in range(i, min(i + _BURST_WINDOW, len(ordered_new)))
               if ordered_new[j][0] < ordered_new[i][0] + _BURST_WINDOW]
        total_new = sum(v for _, v in win)
        if total_new >= _BURST_THRESHOLD:
            start_ep = win[0][0]
            end_ep = win[-1][0]
            issues.append({
                "level": "warn",
                "code": "entity_burst",
                "episode": start_ep,
                "message": f"第{start_ep}-{end_ep}集连续引入 {total_new} 个新专有名词，观众认知过载，建议分散或合并",
                "detail": {"start": start_ep, "end": end_ep, "count": total_new},
            })

    # burst 去重(相邻窗口可能重复报同一段)
    seen_bursts = set()
    dedup_issues = []
    for it in issues:
        if it["code"] == "entity_burst":
            key = (it["detail"]["start"], it["detail"]["end"])
            if key in seen_bursts:
                continue
            seen_bursts.add(key)
        dedup_issues.append(it)
    issues = dedup_issues

    # 2) once_only: 全剧只出现一次的专有名词
    once = [e for e in entities if e["count"] == 1]
    if len(once) >= 3:
        names = "、".join(e["name"] for e in once[:10])
        more = f" 等{len(once)}个" if len(once) > 10 else ""
        issues.append({
            "level": "warn",
            "code": "entity_once",
            "episode": 0,
            "message": f"{len(once)}个专有名词全剧只出现一次（{names}{more}），建议合并同类或改用泛称减轻记忆负担",
            "detail": {"names": [e["name"] for e in once]},
        })

    orgs = sum(1 for e in entities if e["type"] in ("org", "nation"))
    summary = {
        "total": len(entities),
        "once_only": len(once),
        "orgs": orgs,
    }

    return {
        "entities": entities,
        "per_episode_new": per_episode_new,
        "issues": issues,
        "summary": summary,
        "analyzed_at": datetime.utcnow().isoformat() + "Z",
    }