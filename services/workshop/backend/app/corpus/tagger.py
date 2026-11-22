"""语料库二次打标服务 — 对反推完成的语料条目进行 LLM 分析打标。

当前打标版本: TAG_VERSION = 1

打标输出字段(写入 FrontcutCorpusItem):protagonist_gender: male / female / mixed / unknown
  protagonist_role    : 一句话人设
  theme_tags          : JSON数组, 从THEME_TAG_CANDIDATES 选2-4 个
  hook_type: 视觉奇观/ 性张力 / 情绪冲突 / 悬疑 / 反常识
  scenario_summary    : 核心设定一句话
  content_rating: safe / sensitive / adult_lite
  auto_tagged         : True
  tag_version: TAG_VERSION

公开接口:
  tag_item(item_id)— 打标单条(异步)
  batch_tag_untagged(limit=50)    — 批量打标所有 auto_tagged=False 的条目
  batch_retag_by_version(v, n)    — 重打标旧版本条目(升级 prompt 后用)
  build_topic_hints_from_items— 把打标结果拼成 topic_hints 字符串供注入前贴生成
"""
from __future__ import annotations

import json
import logging

from ..db import session_scope
from ..models.llm import get_llm
from .models import FrontcutCorpusItem

logger = logging.getLogger("corpus.tagger")

# 当前打标版本号; 升级 prompt 后递增, 配合 batch-retag 接口重打旧数据
TAG_VERSION = 1

# 题材标签候选集(LLM 只能从这里选)
THEME_TAG_CANDIDATES: list[str] = [
    # 感官刺激型
    "恐怖", "猎奇", "性感", "反常识", "异常现象", "灵异",
    # 爽感型
    "逆袭", "复仇", "撕脸", "打脸", "秘密揭露", "身份反转",
    # 奇情型
    "救援", "偶遇", "奇遇", "危机",
    # 情感向
    "婚姻", "出轨", "背叛", "重逢", "感情纠葛",
]

_HOOK_TYPE_CANDIDATES = ["视觉奇观", "性张力", "情绪冲突", "悬疑", "反常识"]
_CONTENT_RATING_CANDIDATES = ["safe", "sensitive", "adult_lite"]

_TAG_SYSTEM_PROMPT = f"""你是短视频内容分析专家。下面给你一段短视频的剧情/画面描述文本。
请分析并严格按以下 JSON 格式输出(不要解释, 不要 markdown, 只输出 JSON):

{{
  "protagonist_gender": "male 或 female 或 mixed 或 unknown",
  "protagonist_role": "一句话概括主角人设, 如 '农村女孩' / '婆婆与儿媳' / '陌生男女' / '独居女性'",
  "theme_tags": ["从以下候选中选 2 到 4 个最符合的: {', '.join(THEME_TAG_CANDIDATES)}"],
  "hook_type": "从以下中选一个最主要的: {', '.join(_HOOK_TYPE_CANDIDATES)}",
  "scenario_summary": "用一句话概括最能引发点击的核心设定, 如 '女人从土里挖出大蛇' 或 '男人拦住跳河女子发现是前妻'",
  "content_rating": "safe(无敏感内容) 或 sensitive(含轻微暴力/恐怖) 或 adult_lite(含轻度性张力但无露骨)"
}}
"""


def _parse_tag_result(raw: str) -> dict | None:
    """解析 LLM 返回的 JSON 打标结果; 校验关键字段, 失败返回 None。"""
    try:
        text = (raw or "").strip()
        # 去掉可能的 markdown 包裹
        text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        data = json.loads(text)
        # 校验 +兜底
        gender = str(data.get("protagonist_gender") or "unknown").strip()
        if gender not in ("male", "female", "mixed", "unknown"):
            gender = "unknown"
        role = str(data.get("protagonist_role") or "").strip()[:100]
        tags_raw = data.get("theme_tags") or []
        if not isinstance(tags_raw, list):
            tags_raw = []
        # 只保留候选集内的标签, 去重
        tags = list(dict.fromkeys(
            t for t in tags_raw if isinstance(t, str) and t in THEME_TAG_CANDIDATES
        ))[:4]
        hook = str(data.get("hook_type") or "").strip()
        if hook not in _HOOK_TYPE_CANDIDATES:
            hook = ""
        summary = str(data.get("scenario_summary") or "").strip()[:300]
        rating = str(data.get("content_rating") or "safe").strip()
        if rating not in _CONTENT_RATING_CANDIDATES:
            rating = "safe"
        return {
            "protagonist_gender": gender,
            "protagonist_role": role,
            "theme_tags": tags,
            "hook_type": hook,
            "scenario_summary": summary,
            "content_rating": rating,
        }
    except Exception as e:  # noqa: BLE001
        logger.warning("tag result parse failed: %s | raw=%s", e, (raw or "")[:200])
        return None


async def _call_llm_tag(content: str) -> dict | None:
    """调用 LLM 对content 文本进行打标, 最多重试 3 次; 成功返回解析后的 dict, 失败返回 None。"""
    llm = get_llm("generate", temperature=0.3, provider="grok")
    for attempt in range(3):
        try:
            resp = await llm.ainvoke([
                {"role": "system", "content": _TAG_SYSTEM_PROMPT},
                {"role": "user", "content": (content or "")[:4000]},
            ])
            raw = (getattr(resp, "content", None) or "").strip()
            result = _parse_tag_result(raw)
            if result:
                return result
            logger.warning("tagger attempt %d: parse failed, retry", attempt + 1)
        except Exception as e:  # noqa: BLE001
            logger.warning("tagger attempt %d LLM error: %s", attempt + 1, e)
    return None


async def tag_item(item_id: int) -> bool:
    """对单条语料进行 LLM 打标并写回DB。返回 True=成功, False=失败(内容为空或LLM 失败)。"""
    # 读取 content (在 session_scope 内, 出块后session 关闭)
    async with session_scope() as s:
        item = await s.get(FrontcutCorpusItem, item_id)
        if not item:
            logger.warning("tag_item: item %s not found", item_id)
            return False
        content = (item.content or "").strip()
        if not content:
            logger.info("tag_item: item %s content empty, skip", item_id)
            return False
# LLM 调用在 session_scope 外(耗时操作, 不占DB 连接)
    result = await _call_llm_tag(content)
    if not result:
        logger.warning("tag_item: item %s LLM tagging failed", item_id)
        return False

    # 写回 DB
    async with session_scope() as s:
        item = await s.get(FrontcutCorpusItem, item_id)
        if not item:
            return False
        item.protagonist_gender = result["protagonist_gender"]
        item.protagonist_role = result["protagonist_role"]
        item.theme_tags = result["theme_tags"]
        item.hook_type = result["hook_type"]
        item.scenario_summary = result["scenario_summary"]
        item.content_rating = result["content_rating"]
        item.auto_tagged = True
        item.tag_version = TAG_VERSION

    logger.info(
        "tag_item: item %s tagged OK: %s / %s / %s",
        item_id, result["protagonist_gender"],
        result["theme_tags"], result["scenario_summary"][:50],
    )
    return True


async def batch_tag_untagged(limit: int = 50) -> dict:
    """批量打标所有 auto_tagged=False 的条目(内容非空)。
    返回 {"total": N, "ok": M, "failed": K}。
    """
    from sqlalchemy import select as _select

    async with session_scope() as s:
        rows = (await s.execute(
            _select(FrontcutCorpusItem.id).where(
                FrontcutCorpusItem.auto_tagged.is_(False),FrontcutCorpusItem.content != "",
                FrontcutCorpusItem.status == "done",
            ).limit(limit)
        )).scalars().all()

    ids = list(rows)
    ok = failed = 0
    for iid in ids:
        success = await tag_item(iid)
        if success:
            ok += 1
        else:
            failed += 1
    logger.info("batch_tag_untagged: total=%d ok=%d failed=%d", len(ids), ok, failed)
    return {"total": len(ids), "ok": ok, "failed": failed}


async def batch_retag_by_version(old_version: int, limit: int = 50) -> dict:
    """重打标所有 tag_version <= old_version 的条目(升级 prompt 后用)。"""
    from sqlalchemy import select as _select

    async with session_scope() as s:
        rows = (await s.execute(
            _select(FrontcutCorpusItem.id).where(
                FrontcutCorpusItem.tag_version <= old_version,
                FrontcutCorpusItem.content != "",
                FrontcutCorpusItem.status == "done",
            ).limit(limit)
        )).scalars().all()

    ids = list(rows)
    ok = failed = 0
    for iid in ids:
        success = await tag_item(iid)
        if success:
            ok += 1
        else:
            failed += 1
    logger.info(
        "batch_retag_by_version(<=%d): total=%d ok=%d failed=%d",
        old_version, len(ids), ok, failed,
    )
    return {"total": len(ids), "ok": ok, "failed": failed}


def build_topic_hints_from_items(items: list[FrontcutCorpusItem]) -> str:
    """把一批语料条目的打标结果拼成 topic_hints 字符串, 供注入到build_meta_prompt。

    格式示例:
      [猎奇/视觉奇观] 核心设定: 女人从荒地挖出蟒蛇 | 主角: 农村女性
      [性感/救援] 核心设定: 男人从桥上拦住跳河女子 | 主角: 陌生男女"""
    lines: list[str] = []
    for item in items:
        tags = item.theme_tags or []
        hook = item.hook_type or ""
        summary = (item.scenario_summary or "").strip()
        role = (item.protagonist_role or "").strip()
        if not summary:
            continue
        tag_str = "/".join(tags[:2]) if tags else ""
        if tag_str and hook:
            label = f"[{tag_str}/{hook}]"
        elif hook:
            label = f"[{hook}]"
        else:
            label = f"[{tag_str}]"
        role_str = f" | 主角: {role}" if role else ""
        lines.append(f"{label}核心设定: {summary}{role_str}")
    return "\n".join(lines)