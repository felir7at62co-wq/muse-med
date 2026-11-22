"""用户端功能: 标签/收藏/回收站/全文搜索/历史版本/AI评分/加入素材库"""
import logging
import json
from typing import Any
from datetime import datetime, timedelta
from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, text, func, update, and_, or_

from ..db import session_scope, ScriptDraft, ScriptChapter, ScriptStoryboard
from ..auth import get_current_user, User

router = APIRouter(prefix="/v1", tags=["user-features"])
logger = logging.getLogger("user-features")


# ============ 标签 ============

class TagIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    color: str = "#8b5cf6"


@router.get("/tags")
async def list_tags(user: User = Depends(get_current_user)):
    """列出当前用户的所有标签(含引用计数)"""
    async with session_scope() as s:
        rows = (await s.execute(
            text("""SELECT t.id, t.name, t.color, t.created_at, COUNT(dt.draft_id) AS count
                    FROM tags t LEFT JOIN draft_tags dt ON dt.tag_id = t.id
                    WHERE t.user_id = :uid
                    GROUP BY t.id, t.name, t.color, t.created_at
                    ORDER BY t.created_at"""),
            {"uid": user.id}
        )).mappings().all()
        return [dict(r) for r in rows]


@router.post("/tags")
async def create_tag(payload: TagIn, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        try:
            result = await s.execute(
                text("""INSERT INTO tags (user_id, name, color) VALUES (:uid, :name, :color)
                        RETURNING id, name, color"""),
                {"uid": user.id, "name": payload.name, "color": payload.color}
            )
            row = result.mappings().first()
            return dict(row)
        except Exception as e:
            raise HTTPException(409, "标签名已存在")


@router.delete("/tags/{tag_id}")
async def delete_tag(tag_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        tag = (await s.execute(
            text("SELECT user_id FROM tags WHERE id=:id"), {"id": tag_id}
        )).first()
        if not tag:
            raise HTTPException(404, "标签不存在")
        if tag[0] != user.id and user.role not in ("admin", "superadmin"):
            raise HTTPException(403, "无权删除")
        await s.execute(text("DELETE FROM tags WHERE id=:id"), {"id": tag_id})
        return {"ok": True}


class SetTagsIn(BaseModel):
    tag_ids: list[int]


@router.put("/drafts/{draft_id}/tags")
async def set_draft_tags(draft_id: int, payload: SetTagsIn, user: User = Depends(get_current_user)):
    """覆盖设置草稿标签"""
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "草稿不存在")
        if user.role not in ("admin", "superadmin") and draft.user_id != user.id:
            raise HTTPException(403, "无权操作此草稿")
        await s.execute(text("DELETE FROM draft_tags WHERE draft_id=:did"), {"did": draft_id})
        for tid in payload.tag_ids:
            await s.execute(
                text("INSERT INTO draft_tags (draft_id, tag_id) VALUES (:did, :tid) ON CONFLICT DO NOTHING"),
                {"did": draft_id, "tid": tid}
            )
        return {"ok": True}


@router.get("/drafts/{draft_id}/tags")
async def get_draft_tags(draft_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        rows = (await s.execute(
            text("""SELECT t.id, t.name, t.color FROM tags t
                    JOIN draft_tags dt ON dt.tag_id = t.id
                    WHERE dt.draft_id = :did"""),
            {"did": draft_id}
        )).mappings().all()
        return [dict(r) for r in rows]


# ============ 收藏 ============

@router.post("/drafts/{draft_id}/favorite")
async def toggle_favorite(draft_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "草稿不存在")
        if user.role not in ("admin", "superadmin") and draft.user_id != user.id:
            raise HTTPException(403, "无权操作此草稿")
        new_val = not bool(draft.is_favorite) if hasattr(draft, 'is_favorite') else True
        await s.execute(
            text("UPDATE script_drafts SET is_favorite=:v WHERE id=:id"),
            {"v": new_val, "id": draft_id}
        )
        return {"ok": True, "is_favorite": new_val}


# ============ 回收站(软删除) ============

@router.post("/drafts/{draft_id}/trash")
async def move_to_trash(draft_id: int, user: User = Depends(get_current_user)):
    """移入回收站(软删除)"""
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "草稿不存在")
        if user.role not in ("admin", "superadmin") and draft.user_id != user.id:
            raise HTTPException(403, "无权操作此草稿")
        await s.execute(
            text("UPDATE script_drafts SET is_deleted=true, deleted_at=NOW() WHERE id=:id"),
            {"id": draft_id}
        )
        return {"ok": True}


@router.get("/trash")
async def list_trash(user: User = Depends(get_current_user)):
    async with session_scope() as s:
        where_user = "" if user.role in ("admin", "superadmin") else "AND user_id = :uid"
        rows = (await s.execute(
            text(f"""SELECT id, title, user_input, deleted_at, user_id
                     FROM script_drafts
                     WHERE is_deleted=true {where_user}
                     ORDER BY deleted_at DESC"""),
            {"uid": user.id}
        )).mappings().all()
        return [dict(r) for r in rows]


@router.post("/trash/{draft_id}/restore")
async def restore_from_trash(draft_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "草稿不存在")
        if user.role not in ("admin", "superadmin") and draft.user_id != user.id:
            raise HTTPException(403, "无权操作")
        await s.execute(
            text("UPDATE script_drafts SET is_deleted=false, deleted_at=NULL WHERE id=:id"),
            {"id": draft_id}
        )
        return {"ok": True}


@router.delete("/trash/{draft_id}/permanent")
async def permanent_delete(draft_id: int, user: User = Depends(get_current_user)):
    """彻底删除(仅已在回收站的)"""
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "草稿不存在")
        if user.role not in ("admin", "superadmin") and draft.user_id != user.id:
            raise HTTPException(403, "无权操作")
        if not draft.is_deleted:
            raise HTTPException(400, "草稿未在回收站")
        # 级联删除
        await s.execute(text("DELETE FROM script_chapters WHERE draft_id=:id"), {"id": draft_id})
        await s.execute(text("DELETE FROM script_storyboards WHERE draft_id=:id"), {"id": draft_id})
        await s.execute(text("DELETE FROM script_drafts WHERE id=:id"), {"id": draft_id})
        return {"ok": True}


# ============ 全文搜索 ============

@router.get("/search/drafts")
async def search_drafts(
    q: str = Query(..., min_length=1),
    user: User = Depends(get_current_user),
):
    """搜索草稿(标题/梗概/章节正文)"""
    async with session_scope() as s:
        where_user = "" if user.role in ("admin", "superadmin") else "AND d.user_id = :uid"
        rows = (await s.execute(
            text(f"""SELECT DISTINCT d.id, d.title, d.user_input, d.status, d.updated_at,
                     d.is_favorite
                     FROM script_drafts d
                     LEFT JOIN script_chapters c ON c.draft_id = d.id
                     WHERE d.is_deleted = false {where_user}
                     AND (d.title ILIKE :q
                          OR d.user_input ILIKE :q
                          OR (d.outline::text) ILIKE :q
                          OR c.full_text ILIKE :q)
                     ORDER BY d.updated_at DESC
                     LIMIT 50"""),
            {"q": f"%{q}%", "uid": user.id}
        )).mappings().all()
        return [dict(r) for r in rows]


# ============ 历史版本 ============

@router.get("/drafts/{draft_id}/history")
async def list_history(
    draft_id: int,
    stage: str | None = Query(None),
    chapter_order: int | None = Query(None),
    user: User = Depends(get_current_user),
):
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise HTTPException(404, "草稿不存在")
        if user.role not in ("admin", "superadmin") and draft.user_id != user.id:
            raise HTTPException(403, "无权访问")
        
        where = ["draft_id = :did"]
        params = {"did": draft_id}
        if stage:
            where.append("stage = :stage")
            params["stage"] = stage
        if chapter_order is not None:
            where.append("chapter_order = :co")
            params["co"] = chapter_order
        
        rows = (await s.execute(
            text(f"""SELECT id, stage, chapter_order, change_reason, user_feedback, created_at
                     FROM content_history WHERE {' AND '.join(where)}
                     ORDER BY id DESC LIMIT 100"""),
            params
        )).mappings().all()
        return [dict(r) for r in rows]


@router.get("/drafts/{draft_id}/history/{history_id}")
async def get_history_detail(draft_id: int, history_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft or (user.role not in ("admin", "superadmin") and draft.user_id != user.id):
            raise HTTPException(403, "无权访问")
        row = (await s.execute(
            text("SELECT * FROM content_history WHERE id=:id AND draft_id=:did"),
            {"id": history_id, "did": draft_id}
        )).mappings().first()
        if not row:
            raise HTTPException(404, "版本不存在")
        return dict(row)


@router.post("/drafts/{draft_id}/history/{history_id}/restore")
async def restore_history(draft_id: int, history_id: int, user: User = Depends(get_current_user)):
    """恢复指定版本"""
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft or (user.role not in ("admin", "superadmin") and draft.user_id != user.id):
            raise HTTPException(403, "无权操作")
        row = (await s.execute(
            text("SELECT stage, chapter_order, content FROM content_history WHERE id=:id AND draft_id=:did"),
            {"id": history_id, "did": draft_id}
        )).first()
        if not row:
            raise HTTPException(404, "版本不存在")
        stage, chapter_order, content_data = row[0], row[1], row[2]
        # 先备份当前为history(再恢复旧版本)
        if stage == "outline":
            await _save_history(s, draft_id, 0, "outline", {"outline": draft.outline}, "restore_old_version", user.id)
            await s.execute(text("UPDATE script_drafts SET outline=:o WHERE id=:id"),
                          {"o": json.dumps(content_data.get("outline", {})), "id": draft_id})
        elif stage == "chapter":
            ch = (await s.execute(
                select(ScriptChapter).where(ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == chapter_order)
            )).scalar_one_or_none()
            if ch:
                await _save_history(s, draft_id, chapter_order, "chapter",
                                    {"full_text": ch.full_text, "summary": ch.summary, "title": ch.title},
                                    "restore_old_version", user.id)
                ch.full_text = content_data.get("full_text", ch.full_text)
                ch.summary = content_data.get("summary", ch.summary)
                ch.title = content_data.get("title", ch.title)
        elif stage == "storyboard":
            sb = (await s.execute(
                select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == chapter_order)
            )).scalar_one_or_none()
            if sb:
                await _save_history(s, draft_id, chapter_order, "storyboard",
                                    {"shots_json": sb.shots_json}, "restore_old_version", user.id)
                sb.shots_json = content_data.get("shots_json", sb.shots_json)
        return {"ok": True}


async def _save_history(s, draft_id: int, chapter_order: int, stage: str,
                        content: dict, reason: str, user_id: int, feedback: str = None):
    """内部辅助:写历史记录"""
    await s.execute(
        text("""INSERT INTO content_history (draft_id, chapter_order, stage, content, change_reason, user_feedback, created_by)
                VALUES (:did, :co, :st, :c, :r, :fb, :uid)"""),
        {"did": draft_id, "co": chapter_order, "st": stage,
         "c": json.dumps(content, ensure_ascii=False),
         "r": reason, "fb": feedback, "uid": user_id}
    )


# ============ AI质量评分(主动触发) ============

class QualityScoreIn(BaseModel):
    stage: str = Field(..., pattern="^(outline|chapter|storyboard)$")
    chapter_order: int | None = None


@router.post("/drafts/{draft_id}/quality-score")
async def quality_score(draft_id: int, payload: QualityScoreIn, user: User = Depends(get_current_user)):
    """由用户主动触发的AI质量评分"""
    from ..models.llm import get_llm
    
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft or (user.role not in ("admin", "superadmin") and draft.user_id != user.id):
            raise HTTPException(403, "无权访问")
        
        content = ""
        title = ""
        if payload.stage == "outline":
            content = json.dumps(draft.outline, ensure_ascii=False)
            title = "大纲"
        elif payload.stage == "chapter" and payload.chapter_order is not None:
            ch = (await s.execute(
                select(ScriptChapter).where(ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == payload.chapter_order)
            )).scalar_one_or_none()
            if not ch:
                raise HTTPException(404, "章节不存在")
            content = ch.full_text or ""
            title = f"第{payload.chapter_order}章"
        elif payload.stage == "storyboard" and payload.chapter_order is not None:
            sb = (await s.execute(
                select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == payload.chapter_order)
            )).scalar_one_or_none()
            if not sb:
                raise HTTPException(404, "剧本不存在")
            content = json.dumps(sb.shots_json, ensure_ascii=False)
            title = f"第{payload.chapter_order}集剧本"
        else:
            raise HTTPException(400, "参数错误")
        
        model_provider = draft.model_provider or "gemini"

    prompt = f"""你是资深短剧编剧审稿人。请对以下【{title}】从5个维度进行专业评分(每项0-10分)并给出改进建议。

## 待评内容
{content[:8000]}

## 评分维度
1. 叙事连贯性(故事线是否流畅)
2. 冲突张力(矛盾是否有吸引力)
3. 人物塑造(角色立体度)
4. 对白质量(是否生动自然,仅chapter/storyboard)
5. 节奏感(篇幅与情节推进的匹配度)

## 输出格式(严格JSON,仅输出JSON)
{{
  "scores": {{
    "narrative": 0,
    "tension": 0,
    "character": 0,
    "dialogue": 0,
    "pacing": 0
  }},
  "total": 0,
  "level": "优秀/良好/一般/需改进",
  "strengths": ["优点1", "优点2"],
  "weaknesses": ["问题1", "问题2"],
  "suggestions": ["具体改进建议1", "具体改进建议2", "具体改进建议3"]
}}"""

    try:
        llm = get_llm("summary", temperature=0.3, provider=model_provider, max_tokens=2048)
        resp = await llm.ainvoke(prompt)
        raw = resp.content.strip()
        import re
        m = re.search(r'\{.*\}', raw, re.DOTALL)
        if m:
            result = json.loads(m.group())
        else:
            result = {"error": "AI返回格式错误", "raw": raw[:500]}
        return {"ok": True, "result": result}
    except Exception as e:
        logger.warning(f"质量评分失败: {e}")
        raise HTTPException(500, f"评分失败: {e}")


# ============ 加入素材库(从章节) ============

class AddToSnippetsIn(BaseModel):
    title: str | None = None
    category: str = "台词"
    content: str
    tags: list[str] = []
    source_draft_id: int | None = None


@router.post("/snippets/add")
async def add_snippet(payload: AddToSnippetsIn, user: User = Depends(get_current_user)):
    """把选中的文字加入素材库"""
    async with session_scope() as s:
        result = await s.execute(
            text("""INSERT INTO snippets (title, category, content, tags, created_by, source_draft_id)
                    VALUES (:title, :cat, :content, :tags, :uid, :src)
                    RETURNING id"""),
            {
                "title": payload.title or payload.content[:32],
                "cat": payload.category,
                "content": payload.content,
                "tags": payload.tags,
                "uid": user.id,
                "src": payload.source_draft_id,
            }
        )
        new_id = result.scalar_one()
        return {"ok": True, "id": new_id}


# ============ 公开资产(用户可浏览和引用) ============

@router.get("/assets/characters")
async def list_public_characters(user: User = Depends(get_current_user)):
    """用户可引用的公开角色"""
    async with session_scope() as s:
        rows = (await s.execute(
            text("""SELECT id, name, avatar_url, background, personality, appearance, tags
                    FROM characters WHERE is_public=true ORDER BY usage_count DESC, id""")
        )).mappings().all()
        return [dict(r) for r in rows]


@router.get("/assets/worlds")
async def list_public_worlds(user: User = Depends(get_current_user)):
    async with session_scope() as s:
        rows = (await s.execute(
            text("""SELECT id, name, era, location, setting, rules, tags
                    FROM worlds WHERE is_public=true ORDER BY usage_count DESC, id""")
        )).mappings().all()
        return [dict(r) for r in rows]


@router.get("/assets/snippets")
async def list_public_snippets(category: str | None = Query(None), user: User = Depends(get_current_user)):
    async with session_scope() as s:
        where = "is_public=true"
        params: dict[str, Any] = {}
        if category:
            where += " AND category=:cat"
            params["cat"] = category
        rows = (await s.execute(
            text(f"""SELECT id, title, category, content, tags
                    FROM snippets WHERE {where} ORDER BY usage_count DESC, id LIMIT 100"""),
            params
        )).mappings().all()
        return [dict(r) for r in rows]
