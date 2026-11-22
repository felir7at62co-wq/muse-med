"""题材库 CRUD + 内置题材 seed。

routes.py 期望的接口:
  - list_genres() -> list[AutoBatchGenre]
  - create_genre(key, label, description, prompt_hint) -> AutoBatchGenre
  - update_genre(genre_id, label, description, prompt_hint) -> AutoBatchGenre
  - delete_genre(genre_id) -> None
  - reorder_genres(ids) -> None
  - seed_builtin_genres() -> None  (启动时调用,幂等)
"""
from __future__ import annotations

import logging

from fastapi import HTTPException
from sqlalchemy import select

from ..db import AutoBatchGenre, session_scope

logger = logging.getLogger("auto_batch.genres")


# 内置 10 个题材
BUILTIN_GENRES = [
    {"key": "haomen",    "label": "豪门",     "description": "豪门恩怨/商战",     "prompt_hint": "关键词:总裁、豪门联姻、商战、家族纠纷、私生子"},
    {"key": "fuchou",    "label": "复仇",     "description": "黑化反击/打脸爽文", "prompt_hint": "关键词:背叛、复仇、打脸、逆袭、黑化"},
    {"key": "zhanshen",  "label": "战神",     "description": "兵王回归/龙王归来", "prompt_hint": "关键词:兵王、退伍、龙组、特种兵、扮猪吃虎"},
    {"key": "chongsheng","label": "重生",     "description": "重生改命/穿越",     "prompt_hint": "关键词:重生、穿越、前世今生、改命、修罗场"},
    {"key": "tianchong", "label": "甜宠",     "description": "霸总甜宠/CP糖",     "prompt_hint": "关键词:霸总、甜宠、契约婚姻、追妻、CP糖"},
    {"key": "xuanyi",    "label": "悬疑",     "description": "案件推理/烧脑",     "prompt_hint": "关键词:悬疑、推理、案件、谋杀、心理"},
    {"key": "xianxia",   "label": "仙侠",     "description": "修仙/玄幻",         "prompt_hint": "关键词:修仙、灵气、宗门、渡劫、飞升"},
    {"key": "xiaoyuan",  "label": "校园",     "description": "青春校园/初恋",     "prompt_hint": "关键词:青春、校园、初恋、暗恋、毕业"},
    {"key": "junlv",     "label": "军旅",     "description": "热血军旅/特种兵",   "prompt_hint": "关键词:军旅、热血、战友、退役、保家卫国"},
    {"key": "zhichang",  "label": "职场",     "description": "职场逆袭/都市精英", "prompt_hint": "关键词:职场、逆袭、白领、商业、都市精英"},
]


# ---------------------------------------------------------------------------
# 启动 seed
# ---------------------------------------------------------------------------
async def seed_builtin_genres() -> None:
    """启动时调用,确保内置题材存在(幂等)。"""
    async with session_scope() as s:
        existing = (await s.execute(
            select(AutoBatchGenre).where(AutoBatchGenre.is_builtin == True)  # noqa: E712
        )).scalars().all()
        existing_keys = {r.key for r in existing}

        added = 0
        for idx, g in enumerate(BUILTIN_GENRES):
            if g["key"] in existing_keys:
                continue
            row = AutoBatchGenre(
                key=g["key"],
                label=g["label"],
                description=g["description"],
                prompt_hint=g["prompt_hint"],
                is_builtin=True,
                display_order=idx + 1,
            )
            s.add(row)
            added += 1

        if added:
            logger.info("seed_builtin_genres: 新增 %d 个内置题材", added)


# ---------------------------------------------------------------------------
# CRUD (返回 ORM 对象)
# ---------------------------------------------------------------------------
async def list_genres() -> list[AutoBatchGenre]:
    """所有题材,按 display_order 排序。"""
    async with session_scope() as s:
        rows = (await s.execute(
            select(AutoBatchGenre).order_by(
                AutoBatchGenre.display_order, AutoBatchGenre.id
            )
        )).scalars().all()
        # 将 ORM 对象从 session 解绑,以便外部使用
        for r in rows:
            s.expunge(r)
        return list(rows)


async def get_genre(genre_id: int) -> AutoBatchGenre:
    async with session_scope() as s:
        row = await s.get(AutoBatchGenre, genre_id)
        if not row:
            raise HTTPException(404, "题材不存在")
        s.expunge(row)
        return row


async def create_genre(
    *,
    key: str,
    label: str,
    description: str = "",
    prompt_hint: str = "",
) -> AutoBatchGenre:
    """新增自定义题材(非 builtin)。"""
    key = (key or "").strip().lower()
    label = (label or "").strip()
    if not key or not label:
        raise HTTPException(400, "key 和 label 不能为空")
    if not key.replace("_", "").isalnum():
        raise HTTPException(400, "key 只能含字母/数字/下划线")

    async with session_scope() as s:
        # 唯一性检查
        dup = (await s.execute(
            select(AutoBatchGenre).where(AutoBatchGenre.key == key)
        )).scalar_one_or_none()
        if dup:
            raise HTTPException(400, f"key '{key}' 已存在")

        # 取最大 display_order
        max_order = (await s.execute(
            select(AutoBatchGenre.display_order).order_by(
                AutoBatchGenre.display_order.desc()
            ).limit(1)
        )).scalar() or 0

        row = AutoBatchGenre(
            key=key,
            label=label,
            description=description,
            prompt_hint=prompt_hint,
            is_builtin=False,
            display_order=max_order + 1,
        )
        s.add(row)
        await s.flush()
        await s.refresh(row)
        s.expunge(row)
        return row


async def update_genre(
    *,
    genre_id: int,
    label: str | None = None,
    description: str | None = None,
    prompt_hint: str | None = None,
) -> AutoBatchGenre:
    """编辑题材。内置题材的 key 不允许改,但 label/description/prompt_hint 可以改。"""
    async with session_scope() as s:
        row = await s.get(AutoBatchGenre, genre_id)
        if not row:
            raise HTTPException(404, "题材不存在")

        if label is not None:
            row.label = label.strip()
        if description is not None:
            row.description = description
        if prompt_hint is not None:
            row.prompt_hint = prompt_hint
        await s.flush()
        await s.refresh(row)
        s.expunge(row)
        return row


async def delete_genre(genre_id: int) -> None:
    """删除题材(内置不能删)。"""
    async with session_scope() as s:
        row = await s.get(AutoBatchGenre, genre_id)
        if not row:
            raise HTTPException(404, "题材不存在")
        if row.is_builtin:
            raise HTTPException(400, "内置题材不可删除")
        await s.delete(row)


async def reorder_genres(ids: list[int]) -> None:
    """按 ids 顺序重排。"""
    if not ids:
        return
    async with session_scope() as s:
        for order, gid in enumerate(ids, start=1):
            row = await s.get(AutoBatchGenre, gid)
            if row:
                row.display_order = order
