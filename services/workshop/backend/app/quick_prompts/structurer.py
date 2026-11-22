"""自由文本 → 分镜 shots[] 智能结构化.

输入: 用户粘贴的章节文字/剧本片段/分镜表 (任意格式).
输出: shots[] 数组, 字段对齐 storyboards.shots_json 格式.

shot 标准字段:
  shot_no: int       分镜编号 (从 1 起)
  location: str      "时间 内/外 地点" (如 "日 外 山林深处")
  shot_type: str     景别 (近景/中景/全景/特写/大全景)
  characters: list   涉及角色 (短标签, 例 ["女1", "男1"])
  action: str        动作描述 (单帧或一段动作)
  dialogue: str      对白 (可空)
  duration_s: int    建议时长 (秒)
"""
from __future__ import annotations

import json
import logging
import re
from typing import Optional

from langchain_core.messages import HumanMessage

from ..models.llm import ainvoke_with_fallback

logger = logging.getLogger("quick_prompts.structurer")


STRUCTURE_PROMPT = """你是中国短剧分镜结构化专家. 把用户输入的"自由文本剧本/章节/分镜描述"转写为标准的分镜数组 (JSON 格式).

# 任务
读懂下面的内容, 拆为若干个连续分镜 (shots). 每个分镜代表一个连续镜头, 时长 3-10 秒.

# 输入
{user_text}

# 输出 JSON 格式 (严格遵守, 不要 markdown 代码块)

[
  {{
    "shot_no": 1,
    "location": "日 外 山林深处",
    "shot_type": "近景",
    "characters": ["女1", "童1"],
    "action": "女1 怀抱襁褓在崎岖山道上慌乱奔跑, 长辫剧烈甩动",
    "dialogue": "",
    "duration_s": 5
  }},
  ...
]

# 规则

1. **数量**: 拆分为合理的镜头数, 每镜 3-10 秒. 一段 10 秒内的剧情 → 1-2 个镜头. 一段 30-60 秒剧情 → 5-10 个镜头.
2. **location**: 用 "时间 内/外 地点" 三段格式, 例: "日 外 山林" / "夜 内 卧室". 时间用 日/夜/晨/黄昏.
3. **shot_type**: 选 近景/中景/全景/特写/大全景 之一.
4. **characters**: 用短标签 (女1/男1/童1/老1...), 严禁真人姓名.
5. **action**: 一句话描述这个镜头的动作或氛围, 控制在 30-60 字.
6. **dialogue**: 如果用户文本里有对白就保留, 没有就空字符串.
7. **duration_s**: 整数秒, 默认 5.
8. **严禁**: 不要添加 markdown 代码块标记 (```), 不要解释, 不要 JSON 外的任何文字.

# 输入文本类型识别

如果用户输入是:
- **章节小说文字** (有大段叙述): 你需要主动拆分为镜头
- **分镜表/分镜稿** (已有镜头编号、景别等): 保留原意, 转为标准格式
- **剧本对话** (大量人物对白): 把对话场景切为多个对话特写镜头

直接输出 JSON 数组, 现在开始:
"""


def _strip_json(text: str) -> str:
    """去除 markdown code fence."""
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```\s*$", "", text)
    return text.strip()


async def structure_free_text(user_text: str) -> list[dict]:
    """LLM 把自由文本结构化为 shots[].

    Raises:
        ValueError: 解析失败/没有有效分镜
    """
    if not user_text or not user_text.strip():
        raise ValueError("输入文本不能为空")

    text = user_text[:8000]  # 截断防爆
    prompt = STRUCTURE_PROMPT.format(user_text=text)

    logger.info("structurer: input %d chars", len(text))
    msg = await ainvoke_with_fallback(
        [HumanMessage(content=prompt)],
        role="generate",
        temperature=0.3,
        primary="gemini",
    )
    raw = (msg.content if hasattr(msg, "content") else str(msg)).strip()
    raw = _strip_json(raw)

    try:
        shots = json.loads(raw)
    except json.JSONDecodeError as e:
        # 兜底: 截取第一个 [ ... ]
        m = re.search(r"\[.*\]", raw, re.DOTALL)
        if not m:
            raise ValueError(f"AI 返回不是 JSON: {raw[:200]}") from e
        shots = json.loads(m.group(0))

    if not isinstance(shots, list) or not shots:
        raise ValueError("解析后没有有效分镜")

    # 标准化字段, 容错
    cleaned: list[dict] = []
    for i, s in enumerate(shots, start=1):
        if not isinstance(s, dict):
            continue
        chars = s.get("characters") or []
        if isinstance(chars, str):
            chars = [c.strip() for c in re.split(r"[,，、]", chars) if c.strip()]
        cleaned.append({
            "shot_no": int(s.get("shot_no") or i),
            "location": str(s.get("location") or s.get("time_loc") or "")[:60],
            "shot_type": str(s.get("shot_type") or "中景")[:16],
            "characters": list(chars)[:6],
            "action": str(s.get("action") or "")[:200],
            "dialogue": str(s.get("dialogue") or "")[:200],
            "duration_s": max(1, min(15, int(s.get("duration_s") or 5))),
        })

    if not cleaned:
        raise ValueError("解析后没有有效分镜 (字段全部为空)")

    logger.info("structurer: parsed %d shots", len(cleaned))
    return cleaned


def normalize_shots_json(shots: list) -> list[dict]:
    """直接用户给的 shots[], 字段标准化 + 容错."""
    if not isinstance(shots, list) or not shots:
        raise ValueError("shots 必须是非空数组")

    cleaned: list[dict] = []
    for i, s in enumerate(shots, start=1):
        if not isinstance(s, dict):
            continue
        chars = s.get("characters") or []
        if isinstance(chars, str):
            chars = [c.strip() for c in re.split(r"[,，、]", chars) if c.strip()]
        cleaned.append({
            "shot_no": int(s.get("shot_no") or i),
            "location": str(s.get("location") or s.get("time_loc") or "")[:60],
            "shot_type": str(s.get("shot_type") or "中景")[:16],
            "characters": list(chars)[:6],
            "action": str(s.get("action") or "")[:200],
            "dialogue": str(s.get("dialogue") or "")[:200],
            "duration_s": max(1, min(15, int(s.get("duration_s") or 5))),
        })
    if not cleaned:
        raise ValueError("shots 数组无有效项")
    return cleaned
