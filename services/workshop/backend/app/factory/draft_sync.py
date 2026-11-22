"""工厂产物同步到草稿系统

将工厂生成的 outline + script 产物同步到主站草稿列表，
让用户可以在草稿列表中查看完整剧本内容并进行二次编辑。
"""
import json
import logging
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from ..db.models import ScriptDraft as Draft, ScriptChapter
from .models import FactoryProduct

logger = logging.getLogger("factory.draft_sync")


async def sync_script_to_draft(
    db: AsyncSession,
    job_id: int,
    user_id: int,
    script_product_id: Optional[int] = None,
) -> dict:
    """
    将工厂 job 的outline + script 产物同步到草稿系统。逻辑：
    1. 找到 job 关联的 outline产物（取最新的）
    2. 找到 job 关联的 script 产物（若指定 script_product_id 则只同步该产物）
    3. 为每个 script 产物创建一个草稿（若draft_id 已存在则更新）
    4. 将 script 的每个章节写入 script_chapters 表
    5. 更新 factory_products.draft_id

    返回: {"synced": [{"product_id": N, "draft_id": M, "title": ...}]}
    """
    # 1. 取outline 产物
    outline_q = await db.execute(
        select(FactoryProduct).where(
            FactoryProduct.job_id == job_id,
            FactoryProduct.product_type == "outline",
            FactoryProduct.user_id == user_id,
        ).order_by(FactoryProduct.id.desc()).limit(1)
    )
    outline_product = outline_q.scalar_one_or_none()

    outline_data = {}
    if outline_product and outline_product.content:
        try:
            raw = outline_product.content
            if isinstance(raw, str):
                raw = json.loads(raw)
            outline_data = raw if isinstance(raw, dict) else {}
        except Exception:
            pass

    # 2. 取 script 产物
    script_q_stmt = select(FactoryProduct).where(
        FactoryProduct.job_id == job_id,
        FactoryProduct.product_type == "script",
        FactoryProduct.user_id == user_id,
    )
    if script_product_id:
        script_q_stmt = script_q_stmt.where(FactoryProduct.id == script_product_id)
    script_q_stmt = script_q_stmt.order_by(FactoryProduct.id)
    script_q = await db.execute(script_q_stmt)
    script_products = script_q.scalars().all()

    if not script_products:
        return {"synced": [], "message": "没有找到 script 产物"}

    synced = []

    for sp in script_products:
        # 解析 script 内容
        content: dict = {}
        try:
            raw_content = sp.content
            if isinstance(raw_content, str):
                content = json.loads(raw_content)
            elif isinstance(raw_content, dict):
                content = raw_content
        except Exception:
            content = {}

        chapters = content.get("chapters", []) if isinstance(content, dict) else []
        title = sp.title or outline_data.get("title", f"工厂剧本 #{sp.id}")

        # 构建草稿大纲（用工厂大纲数据填充）
        draft_outline = _build_draft_outline(outline_data, chapters)

        if sp.draft_id:
            # 已存在草稿 → 更新
            draft_q = await db.execute(
                select(Draft).where(Draft.id == sp.draft_id)
            )
            draft = draft_q.scalar_one_or_none()
            if draft:
                draft.title = title
                draft.outline = draft_outline
                draft.status = "scripted"
                await db.flush()
                draft_id = draft.id
            else:
                draft_id = await _create_draft(db, user_id, title, draft_outline)
                sp.draft_id = draft_id
        else:
            draft_id = await _create_draft(db, user_id, title, draft_outline)
            sp.draft_id = draft_id

        await db.flush()

        # 写入/更新 script_chapters
        await _upsert_chapters(db, draft_id, chapters)

        synced.append({
            "product_id": sp.id,
            "draft_id": draft_id,
            "title": title,
            "chapter_count": len(chapters),
        })

        logger.info(
            "synced script product %d -> draft %d (%d chapters)",
            sp.id, draft_id, len(chapters),
        )

    await db.commit()
    return {"synced": synced}


async def _create_draft(
    db: AsyncSession, user_id: int, title: str, outline: dict
) -> int:
    """创建一个新草稿并返回 draft_id。"""
    draft = Draft(
        user_id=user_id,
        title=title,
        outline=outline,
        original_outline=outline,
        status="scripted",
        outline_locked=1,
    )
    db.add(draft)
    await db.flush()
    return draft.id


def _build_draft_outline(outline_data: dict, chapters: list) -> dict:
    """从工厂大纲数据+ chapters 构建草稿系统格式的outline JSON。"""
    # 工厂大纲已经是标准格式时直接用
    if outline_data.get("episodes"):
        return outline_data

    # 从 chapters 重建 episodes
    episodes = []
    for ch in chapters:
        order = ch.get("order", ch.get("chapter_order", 0))
        episodes.append({
            "order": order,
            "title": ch.get("title", f"第{order}集"),
            "synopsis": ch.get("synopsis", ""),
            "must_have": ch.get("must_have", []),
            "characters": ch.get("characters", []),
            "locked": False,
            "version": 1,
        })

    return {
        "title": outline_data.get("title", ""),
        "synopsis": outline_data.get("synopsis", ""),
        "world": outline_data.get("world", {}),
        "characters": outline_data.get("characters", []),
        "episodes": episodes,
    }


async def _upsert_chapters(db: AsyncSession, draft_id: int, chapters: list) -> None:
    """将 chapters 列表写入 script_chapters 表（upsert by draft_id + chapter_order）。"""
    for ch in chapters:
        order = ch.get("order", ch.get("chapter_order", 0))
        full_text = ch.get("content", "")
        word_count = ch.get("word_count", len(full_text))
        ch_title = ch.get("title", f"第{order}集")

        # 查是否已存在
        existing_q = await db.execute(
            select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order == order,
            )
        )
        existing = existing_q.scalar_one_or_none()

        if existing:
            existing.title = ch_title
            existing.full_text = full_text
            existing.word_count = word_count
            existing.is_stale = 0
        else:
            new_ch = ScriptChapter(
                draft_id=draft_id,
                chapter_order=order,
                title=ch_title,
                summary="",
                full_text=full_text,
                word_count=word_count,
                locked=0,
                is_stale=0,
                version=1,
            )
            db.add(new_ch)

    await db.flush()