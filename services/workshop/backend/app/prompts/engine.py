"""规划 + 渲染引擎 — 调用 LLM 把分镜变成视频任务和最终 prompt.

两段式工作流:
  plan_chapter_shots:   分镜 → AI → 任务 JSON [{shot_nos, duration, summary}, ...]
  render_task_prompts:  任务 + 模板 → AI → 最终视频/图片 prompt 字符串
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage

from ..models.llm import ainvoke_with_fallback
from .templates import (
    extract_characters,
    render_template,
    shots_to_brief,
    shots_to_text,
)

logger = logging.getLogger("prompts.engine")


# ============================================================
# 规划阶段 (plan)
# ============================================================

PLANNER_PROMPT = """你是短剧视频生成的镜头规划师. 下面是一章的分镜全文, 你的任务:

1. 把这些镜头按"是否能合并为一个连续视频片段"分组.
   合并条件 (满足任一即可):
   - 同一场景同一时刻的连续镜头 (近景/中景/特写在同一互动)
   - 单纯切换景别但镜头内容连续 (没有时间/空间跳跃)
   - 时长合并后 ≤ 15 秒
   不合并的情况:
   - 时间跳跃 (黑场/转场)
   - 空间跳跃 (不同地点/不同人物组)
   - 角色情绪/对白发生重大转折

2. 为每组指定一个时长 (秒, 1-15 整数), 推荐范围:
   - 单镜头: 2-5 秒
   - 2-3 镜合并: 5-8 秒
   - 长场景: 8-12 秒

3. 给每组写 1-2 句中文总结 (将作为视频生成的核心提示).

输出严格 JSON, 不要任何解释, 不要 markdown:
{{
  "tasks": [
    {{"shot_nos": [1, 2], "duration": 6, "summary": "..."}},
    {{"shot_nos": [3], "duration": 4, "summary": "..."}}
  ]
}}

【目标视频模型: {model_label}】
{model_notes}

【分镜原文】
{shots_text}
"""


def _strip_json(text: str) -> str:
    """从 LLM 输出中提取 JSON (剥离 ```json fence)."""
    text = text.strip()
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    # 直接找第一个 { ... 最后一个 }
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return text[start:end + 1]
    return text


async def plan_chapter_shots(
    shots: list[dict],
    *,
    model_label: str,
    model_notes: str = "",
) -> list[dict]:
    """规划阶段: 调 LLM, 输出任务列表.

    返回: [{"shot_nos": [int], "duration": int, "summary": str}, ...]
    """
    if not shots:
        return []

    shots_text = shots_to_text(shots)
    prompt = PLANNER_PROMPT.format(
        model_label=model_label,
        model_notes=model_notes or "(无特殊说明)",
        shots_text=shots_text,
    )

    logger.info("planner: calling LLM for %d shots, model=%s", len(shots), model_label)
    msg = await ainvoke_with_fallback(
        [HumanMessage(content=prompt)],
        role="extract",
        temperature=0.3,
        primary="gemini",
    )
    raw = (msg.content if hasattr(msg, "content") else str(msg)).strip()
    logger.debug("planner raw output: %s", raw[:500])

    try:
        parsed = json.loads(_strip_json(raw))
    except Exception as e:
        logger.error("planner JSON 解析失败: %s\nraw: %s", e, raw[:1000])
        # 兜底: 每镜单独一段
        return [
            {"shot_nos": [shot.get("shot_no", i + 1)], "duration": int(shot.get("duration", 5)) or 5, "summary": (shot.get("action") or "")[:60]}
            for i, shot in enumerate(shots)
        ]

    tasks_in = parsed.get("tasks") or []
    # 校验 + 标准化
    valid: list[dict] = []
    all_shot_nos = {shot.get("shot_no") for shot in shots}
    seen_shot_nos: set[int] = set()
    for t in tasks_in:
        nos = t.get("shot_nos") or []
        if not isinstance(nos, list):
            continue
        nos = [int(n) for n in nos if isinstance(n, (int, str)) and str(n).isdigit()]
        nos = [n for n in nos if n in all_shot_nos and n not in seen_shot_nos]
        if not nos:
            continue
        seen_shot_nos.update(nos)
        dur = int(t.get("duration") or 5)
        dur = max(1, min(15, dur))
        summary = (t.get("summary") or "").strip()[:200]
        valid.append({"shot_nos": sorted(nos), "duration": dur, "summary": summary})

    # 漏掉的 shot_no 单独成一段
    missing = sorted(all_shot_nos - seen_shot_nos)
    for n in missing:
        shot = next((s for s in shots if s.get("shot_no") == n), None)
        if shot:
            valid.append({
                "shot_nos": [n],
                "duration": int(shot.get("duration", 5)) or 5,
                "summary": (shot.get("action") or "")[:80],
            })

    # 按 shot_nos 第一个排序
    valid.sort(key=lambda t: t["shot_nos"][0] if t["shot_nos"] else 99999)
    return valid


# ============================================================
# 渲染阶段 (render)
# ============================================================

RENDERER_PROMPT = """你是 {model_label} 视频生成模型的提示词专家.
{ai_instruction}

下面是一段视频任务的素材, 请按指定模板填充, 直接输出最终 prompt 字符串 (不要 JSON, 不要解释, 不要 markdown 代码块):

【模板】
{template}

【任务素材】
- 时长: {duration}s
- 总结: {summary}
- 涉及角色: {characters}
- 来源分镜:
{shots_detail}
"""


async def render_task_prompt(
    *,
    shots: list[dict],
    duration: int,
    summary: str,
    template: str,
    template_label: str,
    ai_instruction: str = "",
) -> str:
    """渲染阶段: 单个任务 → 最终 prompt 字符串."""
    chars = extract_characters(shots)
    chars_str = ", ".join(chars) if chars else "(无对白角色)"
    prompt = RENDERER_PROMPT.format(
        model_label=template_label,
        ai_instruction=ai_instruction or "请按模板格式生成, 保留关键人物/动作/情绪.",
        template=template,
        duration=duration,
        summary=summary,
        characters=chars_str,
        shots_detail=shots_to_brief(shots),
    )

    logger.info("renderer: %s, %d shots, duration=%ds", template_label, len(shots), duration)
    msg = await ainvoke_with_fallback(
        [HumanMessage(content=prompt)],
        role="generate",
        temperature=0.5,
        primary="gemini",
    )
    out = (msg.content if hasattr(msg, "content") else str(msg)).strip()
    # 去 markdown 代码块
    out = re.sub(r"^```[a-z]*\s*", "", out, flags=re.MULTILINE).rstrip("`").strip()
    return out


def render_template_directly(
    *,
    shots: list[dict],
    duration: int,
    summary: str,
    template: str,
    extra_vars: dict | None = None,
) -> str:
    """不调 LLM, 直接把可推断的字段填入模板 (供首帧图模板用, 节省 LLM 调用).

    会从 shots 抽出: location, time_of_day, characters, visual, action, mood, shot_type, camera_motion, dialogue.
    """
    if not shots:
        return ""
    first = shots[0]
    last = shots[-1]
    chars = extract_characters(shots)
    chars_str = ", ".join(chars) if chars else ""

    # 简单从 location 拆 time_of_day
    loc_full = first.get("location") or first.get("time_loc") or ""
    parts = loc_full.split()
    time_of_day = parts[0] if parts else ""

    actions = " | ".join((s.get("action") or "")[:80] for s in shots if s.get("action"))
    dialogue_text = " | ".join((s.get("dialogue") or "")[:60] for s in shots if s.get("dialogue"))

    variables = {
        "location": loc_full,
        "time_of_day": time_of_day,
        "characters": chars_str,
        "characters_visual": chars_str,
        "visual": (first.get("action") or "")[:120],
        "action": actions[:300],
        "dialogue": dialogue_text[:300],
        "mood": "",
        "shot_type": first.get("shot_type", ""),
        "camera_motion": "",
        "duration": str(duration),
        "summary": summary,
    }
    if extra_vars:
        variables.update(extra_vars)
    return render_template(template, variables)
