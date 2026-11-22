"""概念生成器: 题材→剧情概要+标题+人物"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from ..models.llm import get_llm
from .prompts import CONCEPT_GEN_PROMPT, build_genre_hint

logger = logging.getLogger("auto_batch.concept_gen")


def _extract_json_array(text: str) -> list:
    if not text:
        return []
    raw = text.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        data = json.loads(raw)
    except Exception:
        m = re.search(r"\[.*\]", raw, re.DOTALL)
        if not m:
            raise ValueError(f"无法解析 JSON 数组: {raw[:200]}")
        data = json.loads(m.group(0))
    if not isinstance(data, list):
        raise ValueError("LLM 输出不是 JSON 数组")
    return data


def _normalize_concept(item: Any, idx: int) -> dict:
    """规范化单条概念, 容错填充缺失字段"""
    if not isinstance(item, dict):
        item = {}
    title = str(item.get("title") or f"未命名 #{idx + 1}")[:60]
    synopsis = str(item.get("synopsis") or "").strip()
    if not synopsis:
        synopsis = f"(自动生成的剧本概要 #{idx + 1})"
    chars = item.get("main_characters") or []
    if not isinstance(chars, list):
        chars = []
    norm_chars = []
    for c in chars[:8]:
        if isinstance(c, dict):
            norm_chars.append({
                "name": str(c.get("name", "") or "")[:30],
                "role": str(c.get("role", "") or "")[:50],
                "key_trait": str(c.get("key_trait", "") or "")[:80],
            })
    tags = item.get("tags") or []
    if not isinstance(tags, list):
        tags = []
    norm_tags = [str(t)[:20] for t in tags[:8] if t]
    core_hook = str(item.get("core_hook") or "")[:120]
    return {
        "title": title,
        "synopsis": synopsis[:1500],
        "main_characters": norm_chars,
        "tags": norm_tags,
        "core_hook": core_hook,
    }


async def _gen_one_batch(
    *,
    count: int,
    genre_hint: str,
    provider: str,
) -> list[dict]:
    """跑一次 LLM, 生成 count 条概念"""
    prompt = CONCEPT_GEN_PROMPT.format(count=count, genre_hint=genre_hint)
    llm = get_llm("generate", temperature=0.85, provider=provider, max_tokens=4096)
    resp = await llm.ainvoke(prompt)
    raw = (getattr(resp, "content", "") or "").strip()
    items = _extract_json_array(raw)
    return [_normalize_concept(it, i) for i, it in enumerate(items)]


async def generate_concepts(
    *,
    count: int,
    genre_items: list[dict],
    adhoc_tags: list[str] | None = None,
    provider: str = "gemini",
) -> list[dict]:
    """生成 count 条剧本概念。

    Args:
        count: 要生成的部数
        genre_items: 从 auto_batch_genres 拉取的题材列表
        adhoc_tags: 临时题材词
        provider: 概念生成模型(gemini/deepseek)

    Returns:
        list of {title, synopsis, main_characters, tags, core_hook}
    """
    if count <= 0:
        return []
    genre_hint = build_genre_hint(genre_items, adhoc_tags or [])
    logger.info("generate_concepts: count=%d provider=%s genre_hint=%r", count, provider, genre_hint[:200])

    BATCH_SIZE = 10
    if count <= BATCH_SIZE:
        # 一次出全部
        try:
            results = await _gen_one_batch(count=count, genre_hint=genre_hint, provider=provider)
        except Exception as e:
            logger.exception("concept gen failed (single batch): %s", e)
            results = []
        # 不足/超额时容错补齐/截断
        if len(results) < count:
            for i in range(len(results), count):
                results.append(_normalize_concept({}, i))
        return results[:count]

    # 多批
    semaphore = asyncio.Semaphore(2)
    batch_count = (count + BATCH_SIZE - 1) // BATCH_SIZE
    sizes = [BATCH_SIZE] * batch_count
    sizes[-1] = count - BATCH_SIZE * (batch_count - 1)

    async def _wrap(size):
        async with semaphore:
            try:
                return await _gen_one_batch(count=size, genre_hint=genre_hint, provider=provider)
            except Exception as e:
                logger.warning("concept batch failed: %s", e)
                return [_normalize_concept({}, i) for i in range(size)]

    results_arr = await asyncio.gather(*[_wrap(s) for s in sizes])
    flat = []
    for r in results_arr:
        flat.extend(r)
    # 容错补齐/截断
    while len(flat) < count:
        flat.append(_normalize_concept({}, len(flat)))
    return flat[:count]
