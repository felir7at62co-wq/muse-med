"""异步记忆抽取 worker - 每会话结束/章节生成后调用."""
from __future__ import annotations
import asyncio, logging
from sqlalchemy import text as sql_text
from ..db import session_scope
from .intent import extract_memories
from .memory import insert_memory, insert_snippet, update_profile, get_or_create_profile

logger = logging.getLogger("agent.extraction")


async def _load_messages(conv_id: int, max_n: int = 30) -> list[dict]:
    async with session_scope() as s:
        rows = (await s.execute(sql_text("""
            SELECT role, content FROM agent_messages
            WHERE conversation_id=:c ORDER BY id DESC LIMIT :n"""),
            {"c": conv_id, "n": max_n})).mappings().all()
    return list(reversed([dict(r) for r in rows]))


async def _conv_draft_id(conv_id: int) -> int | None:
    """这个会话挂在哪个草稿上 —— 决定抽出来的记忆该隔离到哪部剧。"""
    async with session_scope() as s:
        row = (await s.execute(sql_text(
            "SELECT draft_id FROM agent_conversations WHERE id=:c"), {"c": conv_id})).first()
    return int(row[0]) if row and row[0] is not None else None


async def extract_for_conversation(conv_id: int, user_id: int) -> dict:
    """对一个会话做记忆抽取."""
    profile = await get_or_create_profile(user_id)
    if not profile.get("memory_enabled", True):
        return {"skipped": "memory_disabled"}
    draft_id = await _conv_draft_id(conv_id)
    msgs = await _load_messages(conv_id)
    if len(msgs) < 4:  # 太短的会话不抽
        return {"skipped": "too_short", "msg_count": len(msgs)}
    data = await extract_memories(msgs)
    if not data:
        return {"skipped": "empty_extraction"}

    inserted_mems = 0
    for m in (data.get("new_memories") or [])[:8]:
        if not m.get("content"): continue
        try:
            # ⚠️ draft_id 必须传：世界观/角色/情节类会据此标成剧本级，只在该剧对话里召回。
            # 不传的话它们会以 global 落到池子里，跨剧污染（2026-10-10 串台事故的成因）。
            await insert_memory(
                user_id, type=m.get("type", "preference"),
                content=m["content"], title=m.get("title"),
                importance=int(m.get("importance", 5)),
                source_conv_id=conv_id, draft_id=draft_id,
            )
            inserted_mems += 1
        except Exception as e:
            logger.warning("insert memory failed: %s", e)

    inserted_snippets = 0
    for sp in (data.get("snippet_candidates") or [])[:3]:
        if not sp.get("content"): continue
        try:
            await insert_snippet(
                user_id, content=sp["content"],
                category=sp.get("category", "other"),
                rating=int(sp.get("rating", 7)),
                source_type="conversation", source_id=conv_id,
            )
            inserted_snippets += 1
        except Exception as e:
            logger.warning("insert snippet failed: %s", e)

    profile_patches = data.get("profile_updates") or {}
    if profile_patches:
        try:
            allowed = {k: v for k, v in profile_patches.items()
                       if k in ("preferred_genres", "forbidden_topics", "preferred_length",
                                "preferred_pace", "style_summary", "tone_keywords") and v}
            if allowed:
                # style_summary 增量(用 ;分隔合并)
                if "style_summary" in allowed and profile.get("style_summary"):
                    allowed["style_summary"] = (profile["style_summary"][:200] + " ; " + allowed["style_summary"])[:500]
                await update_profile(user_id, **allowed, last_summarized_at_now=True)  # type: ignore
        except Exception as e:
            logger.warning("update profile failed: %s", e)

    async with session_scope() as s:
        await s.execute(sql_text("UPDATE user_profiles SET total_chats = COALESCE(total_chats,0)+1, last_summarized_at=NOW() WHERE user_id=:u"), {"u": user_id})
    return {"memories_added": inserted_mems, "snippets_added": inserted_snippets, "profile_updated": bool(profile_patches)}


def schedule_extraction(conv_id: int, user_id: int):
    """fire-and-forget 后台任务"""
    async def _run():
        try:
            await asyncio.sleep(2)  # 让最后一条消息落库
            r = await extract_for_conversation(conv_id, user_id)
            logger.info("extraction conv=%d user=%d: %s", conv_id, user_id, r)
        except Exception as e:
            logger.error("extraction failed: %s", e)
    try:
        asyncio.create_task(_run())
    except RuntimeError:
        pass
