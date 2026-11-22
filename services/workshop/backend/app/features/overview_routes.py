"""
overview_routes — 草稿工作台总览聚合 API（PLAN §6 / 02 号图）

GET /v1/drafts/{draft_id}/overview
返回:
{
  "draft": {...基本信息},
  "kpis": {chapters, storyboards, characters, issues},
  "recent_chapters": [...最近5],
  "recent_logs": [...最近8],
  "todos": [...启发式建议]
}

不依赖新表，全部用现有 ScriptDraft / ScriptChapter / ScriptStoryboard /
GenerationLog 拼出。本服务采用 async sqlalchemy + session_scope。
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, text

from ..auth import get_current_user, User
from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from ..db import session_scope, ScriptDraft, ScriptChapter, ScriptStoryboard
from ..db.models import GenerationLog

router = APIRouter(prefix="/v1", tags=["draft-overview"])
log = logging.getLogger("overview")


def _build_todos(
    draft: ScriptDraft,
    chapters: list[ScriptChapter],
    storyboards: list[ScriptStoryboard],
) -> list[dict[str, Any]]:
    """启发式生成"AI 建议的下一步操作"列表（无外部 LLM 调用，纯规则）。

    7 条规则覆盖 大纲 → 锁定 → 章节 → 剧本 → 导出 全流程。
    每条 todo: {id, level: 'info'|'warning'|'success', title, description,
                action, target_tab}
    """
    out: list[dict[str, Any]] = []
    outline = draft.outline or {}
    has_outline = bool(outline) and bool(outline.get("chapters") or outline.get("episodes"))
    expected = draft.episode_count or 0
    chap_total = expected or len(chapters)
    chap_done = len(chapters)
    chap_stale = sum(1 for c in chapters if (c.is_stale or 0) == 1)
    sb_done = len(storyboards)
    sb_stale = sum(1 for s in storyboards if (s.is_stale or 0) == 1)

    # 1
    if not has_outline:
        out.append(
            {
                "id": "todo:outline",
                "level": "info",
                "title": "开始生成大纲",
                "description": f"AI 将根据剧情概要生成 {expected or 3} 集大纲",
                "action": "生成大纲",
                "target_tab": "outline",
            }
        )
        return out

    # 2 (原"锁定大纲"待办已移除: 大纲/原文/剧本已解离, 有大纲即可直接生成章节, 不再需要锁定)
    # 3 (原"还有 N 章未生成"待办已移除: 大纲/原文/剧本已解离, 不再强制引导生成章节)

    # 4
    if chap_stale > 0:
        out.append(
            {
                "id": "todo:stale-chapters",
                "level": "warning",
                "title": f"{chap_stale} 个章节已过期",
                "description": "章节字数或大纲被改过，建议重新生成保持一致",
                "action": "重新生成",
                "target_tab": "chapters",
            }
        )

    # 5
    if chap_done > 0 and sb_done < chap_done:
        missing = chap_done - sb_done
        out.append(
            {
                "id": "todo:gen-storyboards",
                "level": "info",
                "title": f"还有 {missing} 章剧本未生成",
                "description": f"已生成 {sb_done}/{chap_done}",
                "action": "批量生成",
                "target_tab": "storyboards",
            }
        )

    # 6
    if sb_stale > 0:
        out.append(
            {
                "id": "todo:stale-storyboards",
                "level": "warning",
                "title": f"{sb_stale} 个剧本已过期",
                "description": "对应章节已更新，建议同步重写剧本",
                "action": "重新生成",
                "target_tab": "storyboards",
            }
        )

    # 7
    if (
        has_outline
        and chap_done >= chap_total
        and sb_done >= chap_done
        and chap_stale == 0
        and sb_stale == 0
    ):
        out.append(
            {
                "id": "todo:export",
                "level": "success",
                "title": "全部就绪，可以导出 / 续写",
                "description": "建议先做一次安全扫描和分析评分",
                "action": "去导出",
                "target_tab": "storyboards",
            }
        )

    return out


@router.get("/drafts/{draft_id}/overview")
async def get_draft_overview(
    draft_id: int,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    async with session_scope() as s:
        d_row = (
            await s.execute(select(ScriptDraft).where(ScriptDraft.id == draft_id))
        ).scalar_one_or_none()
        if not d_row:
            raise HTTPException(status_code=404, detail="draft not found")
        if d_row.user_id and d_row.user_id != user.id:
            raise HTTPException(status_code=403, detail="not your draft")

        # ⚠️ 只取用得到的列, 不要 select(整实体)。
        # 下面全程只用 计数 / is_stale / locked / 最近 5 章的元信息,
        # full_text 与 shots_json 一次都没被读过, 但整实体查询会把它们
        # (实测单草稿合计可达 2 MB)从 PG 搬进内存再序列化丢弃 ——
        # 草稿页每 5 秒轮询一次 overview, 这是纯白费的往返。
        chapters = (
            await s.execute(
                select(
                    ScriptChapter.id,
                    ScriptChapter.chapter_order,
                    ScriptChapter.title,
                    ScriptChapter.word_count,
                    ScriptChapter.is_stale,
                    ScriptChapter.locked,
                    ScriptChapter.updated_at,
                    ScriptChapter.created_at,
                )
                .where(ScriptChapter.draft_id == draft_id)
                .order_by(ScriptChapter.chapter_order.asc())
            )
        ).all()
        storyboards = (
            await s.execute(
                select(ScriptStoryboard.is_stale)
                .where(ScriptStoryboard.draft_id == draft_id)
                .order_by(ScriptStoryboard.chapter_order.asc())
            )
        ).all()
        recent_logs_rows = (
            await s.execute(
                select(GenerationLog)
                .where(GenerationLog.draft_id == draft_id)
                .order_by(GenerationLog.id.desc())
                .limit(8)
            )
        ).scalars().all()

        outline = d_row.outline or {}
        characters_count = len(outline.get("characters") or [])

        chap_done = len(chapters)
        chap_total = d_row.episode_count or chap_done or 0
        chap_locked = sum(1 for c in chapters if (c.locked or 0) == 1)
        chap_stale = sum(1 for c in chapters if (c.is_stale or 0) == 1)
        sb_total = chap_done
        sb_done = len(storyboards)
        sb_stale = sum(1 for sb in storyboards if (sb.is_stale or 0) == 1)

        recent_chapters = sorted(
            chapters, key=lambda c: c.updated_at or c.created_at, reverse=True
        )[:5]
        recent_chapter_dicts = [
            {
                "id": c.id,
                "order": c.chapter_order,
                "title": c.title or "",
                "word_count": c.word_count or 0,
                "is_stale": (c.is_stale or 0) == 1,
                "locked": (c.locked or 0) == 1,
                "updated_at": c.updated_at.isoformat() if c.updated_at else None,
            }
            for c in recent_chapters
        ]
        recent_log_dicts = [
            {
                "id": lg.id,
                "stage": lg.stage,
                "log_type": lg.log_type,
                "message": lg.message,
                "created_at": lg.created_at.isoformat() if lg.created_at else None,
            }
            for lg in recent_logs_rows
        ]

        todos = _build_todos(d_row, list(chapters), list(storyboards))

        return {
            "draft": {
                "id": d_row.id,
                "title": d_row.title or "",
                "status": d_row.status,
                "episode_count": d_row.episode_count or 0,
                "chapter_word_target": d_row.chapter_word_target or DEFAULT_CHAPTER_WORD_TARGET,
                "updated_at": d_row.updated_at.isoformat() if d_row.updated_at else None,
                "is_favorite": bool(d_row.is_favorite),
                "outline_locked": bool(d_row.outline_locked),
                "model_provider": d_row.model_provider or "gemini",
            },
            "kpis": {
                "chapters": {
                    "done": chap_done,
                    "total": chap_total,
                    "locked": chap_locked,
                    "stale": chap_stale,
                },
                "storyboards": {
                    "done": sb_done,
                    "total": sb_total,
                    "stale": sb_stale,
                },
                "characters": {"count": characters_count},
                # 暂无 safety_reports 表，全部置 0；待接入后改这里
                "issues": {"total": 0, "high": 0, "medium": 0, "low": 0},
            },
            "recent_chapters": recent_chapter_dicts,
            "recent_logs": recent_log_dicts,
            "todos": todos,
        }


# ══════════════════════════════════════════════════════════════════════════
# 未读状态（PLAN §4.2 的两级红点）
#
# 前端用这两个接口驱动红点：
#   GET  /v1/drafts/unread        → 首页草稿列表的批量未读（一次拿十几条）
#   POST /v1/drafts/{id}/seen     → 进某个 tab 时标记已读
#
# ⚠ 与下面 /overview 的关系：overview 也给 streams 未读，但那是**单草稿**用；
#    列表页要一次算几百份，必须走批量接口。两者共用 db/read_state.py 的同一套规则，
#    不会出现"列表说未读、进去说已读"的不一致。
# ══════════════════════════════════════════════════════════════════════════

@router.get("/drafts/unread")
async def get_unread(
    draft_ids: str = Query("", description="逗号分隔的草稿 id；不传=该用户全部草稿"),
    user: User = Depends(get_current_user),
):
    """批量算未读数。

    返回 {draft_id: {stream: 1}}，**只含有未读的项** —— 前端据此决定是否渲染红点，
    不需要自己判 0。

    ⚠ 值是 0/1 而不是"几条未读"：用户无法处理"3 条未读"这种信息，
    他能做的就是"去看一眼"。所以红点是**存在性标记**，不是计数。
    详见 db/read_state.py 的说明。
    """
    from ..db.read_state import unread_counts, STREAMS

    if draft_ids.strip():
        try:
            ids = [int(x) for x in draft_ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(400, "draft_ids 应为逗号分隔的整数")
        # 越权保护：只算该用户自己的草稿（管理员可看全部）
        async with session_scope() as s:
            if user.role in ("admin", "superadmin"):
                rows = (await s.execute(
                    text("SELECT id FROM script_drafts WHERE id = ANY(:ids)"),
                    {"ids": ids},
                )).all()
            else:
                rows = (await s.execute(
                    text("""SELECT id FROM script_drafts
                            WHERE id = ANY(:ids) AND user_id = :u"""),
                    {"ids": ids, "u": user.id},
                )).all()
        ids = [r[0] for r in rows]
    else:
        async with session_scope() as s:
            stmt = "SELECT id FROM script_drafts WHERE is_deleted = false"
            params: dict = {}
            if user.role not in ("admin", "superadmin"):
                stmt += " AND user_id = :u"
                params["u"] = user.id
            rows = (await s.execute(text(stmt), params)).all()
        ids = [r[0] for r in rows]

    counts = await unread_counts(user_id=user.id, draft_ids=ids)
    return {"items": counts, "streams": list(STREAMS)}


class SeenIn(BaseModel):
    stream: str


@router.post("/drafts/{draft_id}/seen")
async def mark_draft_seen(
    draft_id: int,
    payload: SeenIn,
    user: User = Depends(get_current_user),
):
    """标记某草稿的某产物流为已读（进对应 tab 时调用）。

    幂等：重复调用只是把 seen_at 往后推。
    """
    from ..db.read_state import mark_seen, STREAMS

    if payload.stream not in STREAMS:
        raise HTTPException(400, f"未知的产物流: {payload.stream}")

    # 归属校验：只能标记自己的草稿
    async with session_scope() as s:
        if user.role in ("admin", "superadmin"):
            row = (await s.execute(
                text("SELECT id FROM script_drafts WHERE id = :i"), {"i": draft_id}
            )).first()
        else:
            row = (await s.execute(
                text("SELECT id FROM script_drafts WHERE id = :i AND user_id = :u"),
                {"i": draft_id, "u": user.id},
            )).first()
    if not row:
        raise HTTPException(404, "草稿不存在")

    await mark_seen(user_id=user.id, draft_id=draft_id, stream=payload.stream)
    return {"ok": True, "draft_id": draft_id, "stream": payload.stream}
