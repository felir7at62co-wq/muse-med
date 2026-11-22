"""章节改编—— 作业执行 + 单章生成 + 主角建议。

只用原文chapters 做输入,逐章串行生成(保叙事连贯), 独立表存储, 不复写原文。
覆盖前存ScriptEpisodeHistory(stage=kind) 可回滚。
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone

from langchain_core.messages import SystemMessage, HumanMessage
from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from ..db import session_scope, ScriptChapter, ScriptDraft
from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from ..models.catalog import sanitize_provider_spec
from ..models.llm import get_llm
from .models import ChapterAdaptation, ChapterAdaptJob
from . import prompts as P

logger = logging.getLogger("adapt.service")

KINDS = ("novel", "tweet")
_ACTIVE = {"running", "pending"}
# 上一章产物尾部作为衔接参考的截断长度
_PREV_TAIL = 600


def _map_provider(model: str | None) -> str:
    m = (model or "").strip()
    return sanitize_provider_spec(m, ("gemini", "deepseek", "gpt5", "claude", "qwen"), "gemini")


def _strip_fence(text: str) -> str:
    t = re.sub(r"^```[a-zA-Z]*\s*", "", (text or "").strip())
    return re.sub(r"\s*```$", "", t).strip()


def _word_params(word_target: int) -> dict:
    """从目标字数计算 min/max 约束，与 chapter_gen 的算法保持一致。"""
    return {
        "word_target": word_target,
        "word_min": int(word_target * 0.7),
        "word_max": int(word_target * 1.4),
    }


async def _load_chapters(draft_id: int) -> list[tuple[int, str, str]]:
    """返回 [(chapter_order, title, full_text)], 按 order 升序。"""
    async with session_scope() as s:
        rows = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id).order_by(ScriptChapter.chapter_order)
        )).scalars().all()
    return [(int(c.chapter_order), c.title or "", c.full_text or "") for c in rows]


async def _existing_orders(draft_id: int, kind: str) -> set[int]:
    """已经有**非空**产物的集号。补全模式据此跳过。"""
    async with session_scope() as s:
        rows = (await s.execute(
            select(ChapterAdaptation.chapter_order, ChapterAdaptation.content)
            .where(ChapterAdaptation.draft_id == draft_id,
                   ChapterAdaptation.kind == kind)
        )).all()
    return {int(o) for o, c in rows if (c or "").strip()}


async def _load_word_target(draft_id: int) -> int:
    """读取草稿的每章目标字数；没设则用平台默认（见 app/defaults.py）。"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        return int((d.chapter_word_target or DEFAULT_CHAPTER_WORD_TARGET) if d
                   else DEFAULT_CHAPTER_WORD_TARGET)


def _build_messages(kind: str, chapter_text: str, protagonist: str, prev_out: str | None,
                    word_target: int = DEFAULT_CHAPTER_WORD_TARGET):
    prev_hint = ""
    if prev_out:
        tail = prev_out[-_PREV_TAIL:]
        prev_hint = "【上一章改写结尾(仅供衔接语气, 不要重复其内容)】\n" + tail + "\n\n"
    wp = _word_params(word_target)
    if kind == "novel":
        return [
            SystemMessage(content=P.NOVEL_SYSTEM),
            HumanMessage(content=P.NOVEL_USER.format(
                prev_hint=prev_hint, chapter=chapter_text, **wp,
            )),
        ]
    else:  # tweet
        return [
            SystemMessage(content=P.TWEET_SYSTEM.format(protagonist=protagonist or "主角")),
            HumanMessage(content=P.TWEET_USER.format(
                protagonist=protagonist or "主角", prev_hint=prev_hint,
                chapter=chapter_text, **wp,
            )),
        ]


# 模型返回的**平台/审核错误文本**特征。这些不是正文，绝不能落库——
# 实测事故（2026-09-12）：推文第23集内容被存成
# "The prompt could not be submitted. The prompt contains sensitive words..."，
# 因为上游安全审核拦截后把错误信息当作正常回复返回了。用户会直接看到这段报错。
_UPSTREAM_ERROR_MARKERS = (
    "could not be submitted",
    "prompt contains sensitive words",
    "prohibited use policy",
    "generative ai prohibited",
    "try again",
    "i cannot",
    "i'm sorry, but",
    "as an ai",
    "作为ai",
    "无法处理该请求",
    "内容违反了",
)


def _looks_like_upstream_error(text: str) -> bool:
    """判断返回内容是不是上游报错/拒答文本（而非正文）。"""
    t = (text or "").strip().lower()
    if not t:
        return True
    return any(m in t for m in _UPSTREAM_ERROR_MARKERS)


async def _gen_one(kind: str, provider: str, chapter_text: str, protagonist: str,
                   prev_out: str | None, word_target: int = DEFAULT_CHAPTER_WORD_TARGET) -> str:
    """调用 LLM 生成一章改编产物, 返回纯文本。

    上游被安全审核拦截时会返回错误说明文本而非正文——这里检测出来并**抛错**，
    让调用方按"本章失败"处理（可重试），而不是把报错当正文存进库。
    """
    llm = get_llm("rewrite", temperature=0.6, provider=provider, max_tokens=16384)
    resp = await llm.ainvoke(_build_messages(kind, chapter_text, protagonist, prev_out, word_target))
    out = _strip_fence(getattr(resp, "content", None) or "")
    if _looks_like_upstream_error(out):
        raise RuntimeError(f"上游返回疑似审核/错误文本，已拒绝落库: {out[:120]}")
    return out


async def _upsert_adaptation(draft_id: int, kind: str, chapter_order: int, content: str,
                             protagonist: str = "", user_edited: bool = False) -> None:
    """覆盖前存历史, 再 upsert 产物。

    ⚠ 快照必须**无条件**存, 包括"行不存在"和"行在但内容为空"这两种从无到有的情况。
    否则用户在空集上一键替换后想撤销, 会因为查不到任何历史而卡死
    (前端报"没有可回退的历史版本")。空快照恢复后就是回到替换前的空白态。

    快照走 stages 的 _save_episode_history(每集每阶段封顶 10 版)。原先是本函数
    直接 s.add(ScriptEpisodeHistory), **没有任何上限**, 与章节/剧本不一致且会无限增长。
    """
    # 延迟导入: 避免 adapt_products 与 stages 在顶层互相 import。
    from ..stages.router_m5_enhanced import _save_episode_history

    async with session_scope() as s:
        row = (await s.execute(
            select(ChapterAdaptation).where(
                ChapterAdaptation.draft_id == draft_id,
                ChapterAdaptation.kind == kind,
                ChapterAdaptation.chapter_order == chapter_order,
            )
        )).scalars().first()
        created_by = "user_edit" if user_edited else "ai_generate"
        if row:
            # 原本这里有 `if row.content:` 守卫, 空内容不存快照 —— 正是撤销失效的洞之一。
            await _save_episode_history(
                draft_id, chapter_order, kind,
                {"content": row.content or ""}, (row.version or 1), created_by,
            )
            row.content = content
            row.word_count = len(content)
            row.version = (row.version or 1) + 1
            row.user_edited = user_edited
            if protagonist:
                meta = dict(row.meta_json or {})
                meta["protagonist"] = protagonist
                row.meta_json = meta
                flag_modified(row, "meta_json")
        else:
            # 新建: 先落一版空快照(v1), 内容记为 v2, 与"已有行"路径同形。
            await _save_episode_history(
                draft_id, chapter_order, kind, {"content": ""}, 1, created_by,
            )
            s.add(ChapterAdaptation(
                draft_id=draft_id, kind=kind, chapter_order=chapter_order,
                content=content, word_count=len(content), version=2,
                user_edited=user_edited,
                meta_json=({"protagonist": protagonist} if protagonist else {}),
            ))


async def _update_job(job_id: int, **fields) -> None:
    async with session_scope() as s:
        job = await s.get(ChapterAdaptJob, job_id)
        if not job:
            return
        for k, v in fields.items():
            setattr(job, k, v)
        if "per_ep_json" in fields:
            flag_modified(job, "per_ep_json")


async def _is_canceled(job_id: int) -> bool:
    async with session_scope() as s:
        job = await s.get(ChapterAdaptJob, job_id)
        return bool(job and job.status == "canceled")


async def run_adapt(job_id: int, *, only_missing: bool = False) -> None:
    """执行一键逐章改编作业。逐章串行, 单章失败不影响其它章。

    Args:
        only_missing: True 时**跳过已经有产物的集**，只补空缺。
            工作台顶栏的「补全小说/推文」走这条，与正文/剧本的「补全」同义：
            已有的一律不碰（尤其 user_edited 的，绝不能被重写覆盖），
            跳过的集**一次模型调用都不花**。
            默认 False 保持原契约：对话里的「生成小说」仍是整本重生。
    """
    try:
        async with session_scope() as s:
            job = await s.get(ChapterAdaptJob, job_id)
            if not job:
                return
            draft_id, kind, model, protagonist = job.draft_id, job.kind, job.model, job.protagonist or ""
        provider = _map_provider(model)

        chapters = await _load_chapters(draft_id)

        # 「补全」模式：把已经有产物的集先摘掉。
        # 注意要在 total 之前做 —— total 是进度条分母，
        # 补 3 集却显示 "0/109" 会让用户以为没动。
        skipped_existing: list[int] = []
        if only_missing:
            done = await _existing_orders(draft_id, kind)
            if done:
                skipped_existing = [o for o, _t, _x in chapters if o in done]
                chapters = [c for c in chapters if c[0] not in done]

        total = len(chapters)
        if total == 0:
            msg = ("这部剧的%s已经每集都有了，没有要补的。" % ("小说" if kind == "novel" else "推文")
                   if only_missing and skipped_existing else "该草稿无原文章节可改编")
            await _update_job(job_id, status="done" if skipped_existing else "failed",
                              error="" if skipped_existing else msg,
                              finished_at=datetime.now(timezone.utc))
            return
        await _update_job(job_id, total=total, status="running")

        # 读取草稿每章目标字数
        word_target = await _load_word_target(draft_id)
        logger.info("adapt job %d: kind=%s word_target=%d", job_id, kind, word_target)

        per_ep: dict[str, dict] = {
            str(o): {"status": "skipped", "reason": "已有内容，补全模式跳过"}
            for o in skipped_existing
        }
        finished = 0
        prev_out: str | None = None
        for order, _title, full_text in chapters:
            if await _is_canceled(job_id):
                return
            if not (full_text or "").strip():
                per_ep[str(order)] = {"status": "skipped", "reason": "原文为空"}
                await _update_job(job_id, per_ep_json=per_ep)
                continue
            try:
                out = await _gen_one(kind, provider, full_text, protagonist, prev_out, word_target)
                if not out:
                    per_ep[str(order)] = {"status": "failed", "reason": "模型未返回内容"}
                else:
                    await _upsert_adaptation(draft_id, kind, order, out, protagonist=protagonist)
                    prev_out = out
                    finished += 1
                    per_ep[str(order)] = {"status": "ok", "chars": len(out)}
            except Exception as e:  # noqa: BLE001
                logger.exception("adapt job %d chapter %d failed", job_id, order)
                per_ep[str(order)] = {"status": "failed", "reason": str(e)[:200]}
            await _update_job(job_id, finished=finished, per_ep_json=per_ep)

        ok_count = sum(1 for v in per_ep.values() if v.get("status") == "ok")
        status = "done" if ok_count == total else ("partial" if ok_count > 0 else "failed")
        await _update_job(job_id, status=status, finished=finished, per_ep_json=per_ep,
                          finished_at=datetime.now(timezone.utc))
        logger.info("adapt job %d %s: kind=%s ok=%d/%d", job_id, status, kind, ok_count, total)
    except Exception as e:  # noqa: BLE001
        logger.exception("adapt job %d crashed", job_id)
        await _update_job(job_id, status="failed", error=str(e)[:500],
                          finished_at=datetime.now(timezone.utc))


async def regenerate_one(draft_id: int, kind: str, chapter_order: int, model: str,
                         feedback: str = "") -> str:
    """单章重新生成(可带意见)。返回新内容。同步执行(单章较快)。"""
    provider = _map_provider(model)
    chapters = await _load_chapters(draft_id)
    ch = next((c for c in chapters if c[0] == chapter_order), None)
    if not ch:
        raise ValueError(f"第{chapter_order}章原文不存在")
    _order, _title, full_text = ch
    if not (full_text or "").strip():
        raise ValueError("该章原文为空")

    # 取该kind 已存的主角(tweet 用)
    protagonist = ""
    async with session_scope() as s:
        row = (await s.execute(
            select(ChapterAdaptation).where(
                ChapterAdaptation.draft_id == draft_id,
                ChapterAdaptation.kind == kind,
                ChapterAdaptation.chapter_order == chapter_order,
            )
        )).scalars().first()
        if row:
            protagonist = (row.meta_json or {}).get("protagonist", "")

    # 上一章产物作衔接
    prev_out = None
    async with session_scope() as s:
        prev = (await s.execute(
            select(ChapterAdaptation).where(
                ChapterAdaptation.draft_id == draft_id,
                ChapterAdaptation.kind == kind,
                ChapterAdaptation.chapter_order == chapter_order - 1,
            )
        )).scalars().first()
        if prev:
            prev_out = prev.content

    # 读取草稿每章目标字数
    word_target = await _load_word_target(draft_id)
    msgs = _build_messages(kind, full_text, protagonist, prev_out, word_target)
    if feedback and feedback.strip():
        msgs.append(HumanMessage(content="【额外修改意见, 请在遵守全部铁律的前提下满足】\n" + feedback.strip()))
    llm = get_llm("rewrite", temperature=0.6, provider=provider, max_tokens=16384)
    resp = await llm.ainvoke(msgs)
    out = _strip_fence(getattr(resp, "content", None) or "")
    if not out:
        raise ValueError("模型未返回内容")
    await _upsert_adaptation(draft_id, kind, chapter_order, out, protagonist=protagonist)
    return out


async def suggest_protagonist(draft_id: int, model: str) -> dict:
    """读原文前几章, 让AI 建议一个第一人称主角。返回 {name, reason}。"""
    provider = _map_provider(model)
    chapters = await _load_chapters(draft_id)
    if not chapters:
        raise ValueError("该草稿无原文章节")
    sample = "\n\n".join(t for _o, _ti, t in chapters[:3] if t)[:8000]
    llm = get_llm("rewrite", temperature=0.2, provider=provider, max_tokens=512)
    resp = await llm.ainvoke([
        HumanMessage(content=P.SUGGEST_PROTAGONIST_PROMPT.format(sample=sample)),
    ])
    raw = _strip_fence(getattr(resp, "content", None) or "")
    try:
        data = json.loads(raw)
        name = str(data.get("name", "")).strip()
        reason = str(data.get("reason", "")).strip()
    except Exception:  # noqa: BLE001
        name = (raw.splitlines() or [""])[0].strip()[:32]
        reason = ""
    if not name:
        name = "主角"
    return {"name": name, "reason": reason}
