"""上传文档的落盘与按需检索 —— 修「长文档进上下文后被静默丢掉」。

## 事故（2026-10-10 定位）

用户 246 上传了一份 992KB（40 万字）小说原文到对话工坊，然后逐章"继续改第X章"。
到后面模型开始自己编 —— 因为它**早就读不到原文了**：

  · 上传内容被整篇拼进 user message，占满 10 轮历史窗口（`HISTORY_TURNS_FOR_LLM`）；
  · 约第 33~35 轮被 `compaction.prune_old_tool_outputs` 剪成 200 字占位符
    （"原 375,639 字符，开头为…"）；
  · 第 38 轮彻底滑出窗口。

⚠️ 注意**压缩根本没触发**：用的是 gemini-3.6-flash（阈值 921,464 token），
   而实际历史峰值才 409,250。真凶是"10 轮窗口 + 长消息剪枝"，不是压缩不够。

## 修法：落盘 + 每轮按需取用

上传即入 `agent_documents`（存全文）+ `agent_document_chapters`（章节索引）。
消息里只留一行引用，正文**不再进对话历史** → 体积与剪枝问题同时消失。

每轮组装上下文时：

  · 用户点名了集号/章号（`parse_focus_orders`，现成机制）→ 给这些章的**全文**
  · 没点名 → 给**章节目录 + 相邻一段正文**（用户裁定："给目录 + 更大范围"）

## 为什么检索由后端决定，而不是给模型一个工具

日常对话是 `tool_mode="off"` 的**纯文本单次调用**（routes.py:_stream_chat），
不在 Agent 循环里 —— 模型没有工具可调。所以"让它自己按需检索"这条路在这条
路径上不存在，检索必须在组装上下文时由后端完成。

## 切分

复用 `stages/import_script.smart_split_chapters`（已在生产验证过的章节识别，
支持第N章/话/回、分隔线、中文数字）。用户裁定：上传的小说一定有规范章节结构。

按**章节**切而非固定长度：固定分块会在对话中间截断，切出来的片段读起来是断的。

## 与对话历史的隔离

注入结果**不写入** `agent_messages`，每轮重新取。否则又会堆回历史里、
再被剪成占位符，等于绕一圈回到原点。
"""
from __future__ import annotations

import logging
import os
import re

from sqlalchemy import delete, select

from ..db import session_scope
from ..db.models_phase5 import AgentDocument, AgentDocumentChapter

logger = logging.getLogger("agent.doc_context")

#: 单轮注入的文档正文字符上限。可调（DRAMA_DOC_CONTEXT_CHARS）。
#:
#: 为什么默认给到 8 万字（用户裁定"更大范围"）：用户会连着说"继续改第三十九章"，
#: 这类操作**必须**看到原文才能改对。给少了模型就又开始编 —— 那正是要修的病。
#: 8 万字 ≈ 8 万 token（中文约 1 字 1 token），在用的模型里最小的窗口也有 12.8 万，
#: 加上系统提示与历史仍有余量；真超了还有压缩层兜底（L3 反应式压缩）。
DEFAULT_DOC_CHARS = int(os.environ.get("DRAMA_DOC_CONTEXT_CHARS") or 80_000)

#: 没点名章节时，围绕"最近提到过的章"取多少章作为上下文。
ADJACENT_CHAPTERS = int(os.environ.get("DRAMA_DOC_ADJACENT_CHAPTERS") or 3)


def split_with_offsets(full_text: str) -> list[dict]:
    """按章节切分并给出每章在 full_text 里的字符区间。

    复用 import_script.smart_split_chapters 识别边界（生产已验证），
    再用顺序 find 反推 offset —— 这样正文只存一份，不重复占空间。

    `renumber=False`：**保留原文集号**。上传的是用户的原稿，"第73章"就该是 73，
    重排会把集号拉直成 1..N，导致按章号检索全部错位。
    """
    from ..stages.import_script import smart_split_chapters

    chunks = smart_split_chapters(full_text, renumber=False)
    if not chunks:
        # 切不出来（没有规范章节结构）→ 整篇当一章，至少保证能检索到
        return [{"order": 1, "title": "全文", "start": 0,
                 "end": len(full_text), "char_count": len(full_text)}]

    out: list[dict] = []
    cursor = 0
    for c in chunks:
        body = c.get("content") or ""
        # 从游标往后找，避免同一段文字重复时定位到错误位置
        idx = full_text.find(body[:200], cursor) if body else -1
        start = idx if idx >= 0 else cursor
        end = start + len(body)
        if end <= start:
            continue
        out.append({
            "order": int(c.get("order") or (len(out) + 1)),
            "title": (c.get("title") or "").strip() or f"第{len(out) + 1}章",
            "start": start,
            "end": min(end, len(full_text)),
            "char_count": end - start,
        })
        cursor = end
    return out


async def save_document(*, user_id: int, filename: str, content: str,
                        conversation_id: int | None = None,
                        draft_id: int | None = None) -> dict:
    """把上传文档落盘并建章节索引。返回 {id, filename, char_count, chapter_count}。"""
    text = content or ""
    chapters = split_with_offsets(text)
    async with session_scope() as s:
        doc = AgentDocument(
            user_id=user_id, conversation_id=conversation_id, draft_id=draft_id,
            filename=filename or "uploaded", char_count=len(text), full_text=text,
        )
        s.add(doc)
        await s.flush()
        doc_id = doc.id
        for ch in chapters:
            s.add(AgentDocumentChapter(
                document_id=doc_id, order=ch["order"], title=ch["title"][:256],
                start_offset=ch["start"], end_offset=ch["end"],
                char_count=ch["char_count"],
            ))
    logger.info("document saved: id=%d user=%d chars=%d chapters=%d",
                doc_id, user_id, len(text), len(chapters))
    return {"id": doc_id, "filename": filename, "char_count": len(text),
            "chapter_count": len(chapters)}


async def _docs_for(*, user_id: int, conversation_id: int | None,
                    draft_id: int | None) -> list[AgentDocument]:
    """这次对话能看到的文档。

    ⚠️ 越权边界：只认**本人**的文档。再按"本会话"或"本草稿"收窄 ——
    两个都为 None 时（还没绑草稿的闲聊）退回只看本会话，不放开到该用户全部文档，
    否则用户在同一部小说里的两份不同上传会互相串。
    """
    async with session_scope() as s:
        stmt = select(AgentDocument).where(AgentDocument.user_id == user_id)
        if conversation_id is not None:
            stmt = stmt.where(AgentDocument.conversation_id == conversation_id)
        elif draft_id is not None:
            stmt = stmt.where(AgentDocument.draft_id == draft_id)
        else:
            return []
        return list((await s.execute(stmt.order_by(AgentDocument.id))).scalars().all())


async def _chapters_of(doc_id: int) -> list[AgentDocumentChapter]:
    async with session_scope() as s:
        return list((await s.execute(
            select(AgentDocumentChapter)
            .where(AgentDocumentChapter.document_id == doc_id)
            .order_by(AgentDocumentChapter.order)
        )).scalars().all())


def _catalog_block(doc: AgentDocument, chs: list[AgentDocumentChapter]) -> str:
    """章节目录 —— 让模型知道这份文档有多少章、各是什么，从而能请用户指明章号。"""
    lines = [
        f"【上传文档】《{doc.filename}》 共 {len(chs)} 章 / {doc.char_count:,} 字",
        "（**这只是目录，不是正文**。需要某一章的内容时，请在回复里让用户写明章号；"
        "本轮根据用户的话已经附上了相关章节的正文，见下。）",
        "目录：",
    ]
    for c in chs:
        lines.append(f"  · 第{c.order}章 {c.title}（{c.char_count:,} 字）")
    return "\n".join(lines)


def _body_block(doc: AgentDocument, chs: list[AgentDocumentChapter],
                picked: list[AgentDocumentChapter], *, budget: int) -> str:
    """把选中章节的正文拼出来，受 budget 约束。"""
    parts: list[str] = []
    used = 0
    for c in picked:
        seg = doc.full_text[c.start_offset:c.end_offset]
        if not seg:
            continue
        if used + len(seg) > budget and parts:
            parts.append(
                f"（后续章节因篇幅未附上：第{c.order}章起。需要时指明章号即可。）")
            break
        parts.append(f"--- 第{c.order}章 {c.title} ---\n{seg}")
        used += len(seg)
    if not parts:
        return ""
    return "\n\n".join(parts)


async def build_document_block(*, user_id: int, conversation_id: int | None = None,
                               draft_id: int | None = None,
                               recent_user_message: str = "") -> str:
    """组装上传文档的注入块。没有文档就返回空串。

    取值策略（用户 2026-10-10 裁定）：
      · 用户点名了章号 → 那些章**全文**
      · 没点名         → 章节目录 + 更大范围（从最近提到的章起，连续若干章）
    """
    try:
        docs = await _docs_for(user_id=user_id, conversation_id=conversation_id,
                               draft_id=draft_id)
    except Exception as e:  # noqa: BLE001 — 检索失败绝不能阻断对话
        logger.warning("document lookup failed: %s", e)
        return ""
    if not docs:
        return ""

    from .context_loader import parse_focus_orders
    focus = parse_focus_orders(recent_user_message or "")
    blocks: list[str] = []
    budget = DEFAULT_DOC_CHARS

    for doc in docs:
        try:
            chs = await _chapters_of(doc.id)
        except Exception as e:  # noqa: BLE001
            logger.warning("chapter lookup failed doc=%d: %s", doc.id, e)
            continue
        if not chs:
            continue

        by_order = {c.order: c for c in chs}
        picked: list[AgentDocumentChapter] = []
        hit_named = False
        if focus:
            picked = [by_order[o] for o in focus if o in by_order]
            hit_named = bool(picked)
            # 点名的章可能超出文档范围（用户记错章号 / 说的是集号而文档是章节）
            if not hit_named:
                logger.info("doc %d: 点名的章号 %s 不在文档章节范围内", doc.id, focus)
        if not picked:
            # 没点名、或点名的章不存在 → 目录 + 相邻一段正文。
            # ⚠️ 点名的章不存在时**必须**退回默认范围：只回一个光秃秃的标题
            #   等于什么也没给，用户会以为文档丢了。退回开头几章 + 目录，
            #   至少让模型能说"这份文档一共 N 章，你说的第 300 章不在其中"。
            start = chs[0].order
            picked = [c for c in chs if start <= c.order < start + ADJACENT_CHAPTERS]

        # 点名且命中 → 只给正文（目录没必要，用户已经知道要哪章）；
        # 其余情况给目录，让模型知道这份文档的全貌。
        head = (f"【上传文档】《{doc.filename}》 共 {len(chs)} 章 / {doc.char_count:,} 字"
                if hit_named else _catalog_block(doc, chs))
        body = _body_block(doc, chs, picked, budget=budget)
        blocks.append(head + ("\n\n" + body if body else ""))
        budget -= min(budget, len(body or ""))

    if not blocks:
        return ""
    return ("==== 用户上传的文档（已入库，以下为按需取用的内容）====\n"
            + "\n\n".join(blocks))


async def delete_conversation_documents(conversation_id: int) -> int:
    """会话删除时清掉它的文档（章节走 ON DELETE CASCADE）。"""
    async with session_scope() as s:
        r = await s.execute(delete(AgentDocument).where(
            AgentDocument.conversation_id == conversation_id))
        return r.rowcount or 0
