"""提示词速转 — FastAPI 路由.

数据存 redis 24h, key 前缀 `quickp:` + uuid.

API:
  POST /v1/quick-prompts/structure         自由文本 → shots[] (调 LLM)
  POST /v1/quick-prompts/from-draft        从已有草稿章节导入 → shots[]
  POST /v1/quick-prompts/run               shots[] → 视频任务列表 (plan + render, 后台跑)
  GET  /v1/quick-prompts/{task_id}         查询渲染结果
  PATCH /v1/quick-prompts/{task_id}/items/{idx}    单项编辑
  POST /v1/quick-prompts/{task_id}/items/{idx}/regenerate  单项重生
  POST /v1/quick-prompts/{task_id}/save    转存为正式草稿 (Phase 2)
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from redis import asyncio as aioredis
from sqlalchemy import select

from ..auth import User, get_current_user
from ..config import get_settings
from ..db import session_scope
from ..db.models import ScriptDraft, ScriptStoryboard
from ..prompts.engine import plan_chapter_shots, render_task_prompt
from ..prompts.templates import get_template_by_key
from .structurer import normalize_shots_json, structure_free_text

logger = logging.getLogger("quick_prompts.routes")
router = APIRouter(prefix="/v1/quick-prompts", tags=["quick_prompts"])

REDIS_TTL = 24 * 3600  # 24h
REDIS_KEY_PREFIX = "quickp:"

_redis: aioredis.Redis | None = None


def _r() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(get_settings().redis_url, decode_responses=True)
    return _redis


def _key(task_id: str) -> str:
    return f"{REDIS_KEY_PREFIX}{task_id}"


# ============================================================
# 1) 自由文本 → shots[]
# ============================================================

class StructureIn(BaseModel):
    text: str = Field(..., min_length=10, max_length=10000)


class StructureOut(BaseModel):
    ok: bool
    shots: list[dict]
    shot_count: int


@router.post("/structure", response_model=StructureOut)
async def structure_text(payload: StructureIn, user: User = Depends(get_current_user)):
    """自由文本 → 标准 shots[] (调 LLM 智能拆镜).

    仅返回 shots, 不存储. 用户可前端编辑后再调 /run.
    """
    try:
        shots = await structure_free_text(payload.text)
    except ValueError as e:
        raise HTTPException(400, f"结构化失败: {e}")
    except Exception as e:
        logger.exception("structure failed")
        raise HTTPException(500, f"AI 调用失败: {e}")
    return StructureOut(ok=True, shots=shots, shot_count=len(shots))


# ============================================================
# 2) 从已有草稿导入
# ============================================================

class FromDraftIn(BaseModel):
    draft_id: int
    chapter_orders: Optional[list[int]] = None  # null = 全集


@router.post("/from-draft", response_model=StructureOut)
async def from_draft(payload: FromDraftIn, user: User = Depends(get_current_user)):
    """从已有草稿的 storyboards 拉 shots, 用户后续可调 /run 渲染."""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, payload.draft_id)
        if not d:
            raise HTTPException(404, "draft not found")
        if user.role not in ("admin", "superadmin") and d.user_id != user.id:
            raise HTTPException(403, "无权访问此草稿")

        stmt = select(ScriptStoryboard).where(ScriptStoryboard.draft_id == payload.draft_id)
        if payload.chapter_orders:
            stmt = stmt.where(ScriptStoryboard.chapter_order.in_(payload.chapter_orders))
        stmt = stmt.order_by(ScriptStoryboard.chapter_order)
        sbs = list((await s.execute(stmt)).scalars().all())

    if not sbs:
        raise HTTPException(400, "该草稿尚无分镜数据")

    # 平铺所有章节的 shots, 重新编号
    flat: list[dict] = []
    for sb in sbs:
        for sh in (sb.shots_json or []):
            flat.append(sh)

    if not flat:
        raise HTTPException(400, "选定章节没有分镜")

    cleaned = normalize_shots_json(flat)
    return StructureOut(ok=True, shots=cleaned, shot_count=len(cleaned))


# ============================================================
# 3) shots[] → 视频任务渲染
# ============================================================

class RunIn(BaseModel):
    shots: list[dict] = Field(..., min_items=1)
    video_template_key: str
    image_template_key: Optional[str] = None
    title: str = Field(default="提示词速转", max_length=80)


class RunOut(BaseModel):
    ok: bool
    task_id: str
    message: str


@router.post("/run", response_model=RunOut)
async def run_quick_prompts(payload: RunIn, user: User = Depends(get_current_user)):
    """shots[] → plan + render, 后台异步跑, 立即返回 task_id."""
    # 校验模板
    video_tpl = await get_template_by_key(payload.video_template_key)
    if not video_tpl or video_tpl.kind != "video":
        raise HTTPException(404, f"video 模板不存在: {payload.video_template_key}")

    image_tpl = None
    if payload.image_template_key:
        image_tpl = await get_template_by_key(payload.image_template_key)
        if not image_tpl or image_tpl.kind != "image":
            raise HTTPException(404, f"image 模板不存在: {payload.image_template_key}")

    # 标准化 shots
    try:
        shots = normalize_shots_json(payload.shots)
    except ValueError as e:
        raise HTTPException(400, str(e))

    task_id = uuid.uuid4().hex[:12]

    # 模板数据快照 (避免后台任务里 detached)
    video_tpl_data = {
        "key": video_tpl.key,
        "label": video_tpl.label,
        "template": video_tpl.template,
        "ai_instruction": video_tpl.ai_instruction or "",
    }
    image_tpl_data = None
    if image_tpl:
        image_tpl_data = {
            "key": image_tpl.key,
            "label": image_tpl.label,
            "template": image_tpl.template,
            "ai_instruction": image_tpl.ai_instruction or "",
        }

    # 初始状态写 redis
    state = {
        "task_id": task_id,
        "user_id": user.id,
        "title": payload.title,
        "status": "running",
        "stage": "planning",
        "progress": 0,
        "shot_count": len(shots),
        "video_template_key": video_tpl.key,
        "video_template_label": video_tpl.label,
        "image_template_key": image_tpl.key if image_tpl else None,
        "image_template_label": image_tpl.label if image_tpl else None,
        "shots_input": shots,
        "items": [],          # 渲染结果, 按 task_index 顺序
        "error": None,
        "logs": ["开始规划..."],
    }
    await _r().setex(_key(task_id), REDIS_TTL, json.dumps(state, ensure_ascii=False))

    # 后台跑
    async def _run():
        try:
            # plan
            tasks = await plan_chapter_shots(
                shots,
                model_label=video_tpl_data["label"],
                model_notes="",
            )
            state["stage"] = "rendering"
            state["task_count"] = len(tasks)
            state["logs"].append(f"规划完成: {len(shots)} 镜 → {len(tasks)} 段")
            state["items"] = [
                {
                    "task_index": i + 1,
                    "duration_s": int(t["duration"]),
                    "source_shot_nos": list(t["shot_nos"]),
                    "summary": t.get("summary", ""),
                    "video_prompt": "",
                    "image_prompt": "",
                    "shots_snapshot": [sh for sh in shots if sh.get("shot_no") in t["shot_nos"]],
                    "user_edited": False,
                }
                for i, t in enumerate(tasks)
            ]
            await _r().setex(_key(task_id), REDIS_TTL, json.dumps(state, ensure_ascii=False))

            # render 每段
            for idx, item in enumerate(state["items"]):
                shots_snap = item["shots_snapshot"]
                try:
                    vp = await render_task_prompt(
                        shots=shots_snap,
                        duration=item["duration_s"],
                        summary=item["summary"],
                        template=video_tpl_data["template"],
                        template_label=video_tpl_data["label"],
                        ai_instruction=video_tpl_data["ai_instruction"],
                    )
                    item["video_prompt"] = vp
                    # 渲染→优化串联(seedance): 失败回退原稿, 不阻断
                    if vp and not vp.startswith("(渲染失败") and "seedance" in (video_tpl_data.get("key") or "").lower():
                        try:
                            from ..seedance_pe.service import optimize_to_prompt
                            opt = await optimize_to_prompt(vp)
                            if opt and opt.strip():
                                item["video_prompt"] = opt.strip()
                        except Exception:
                            logger.exception("seedance-pe optimize failed task=%s idx=%d (fallback)", task_id, idx)
                except Exception as e:
                    logger.exception("render video failed task=%s idx=%d", task_id, idx)
                    item["video_prompt"] = f"(渲染失败: {e})"

                if image_tpl_data:
                    try:
                        ip = await render_task_prompt(
                            shots=shots_snap,
                            duration=item["duration_s"],
                            summary=item["summary"],
                            template=image_tpl_data["template"],
                            template_label=image_tpl_data["label"],
                            ai_instruction=image_tpl_data["ai_instruction"],
                        )
                        item["image_prompt"] = ip
                    except Exception as e:
                        logger.exception("render image failed task=%s idx=%d", task_id, idx)
                        item["image_prompt"] = ""

                state["progress"] = int((idx + 1) / len(state["items"]) * 100)
                state["logs"].append(f"已渲染 {idx + 1}/{len(state['items'])}")
                await _r().setex(_key(task_id), REDIS_TTL, json.dumps(state, ensure_ascii=False))

            state["status"] = "done"
            state["stage"] = "done"
            state["progress"] = 100
            state["logs"].append(f"✓ 全部完成: {len(state['items'])} 段")
        except Exception as e:
            logger.exception("quick run failed: %s", e)
            state["status"] = "error"
            state["error"] = str(e)
            state["logs"].append(f"❌ 失败: {e}")
        finally:
            await _r().setex(_key(task_id), REDIS_TTL, json.dumps(state, ensure_ascii=False))

    asyncio.create_task(_run())

    return RunOut(ok=True, task_id=task_id, message=f"已开始, {len(shots)} 个分镜")


# ============================================================
# 4) 查询结果
# ============================================================

@router.get("/{task_id}")
async def get_task(task_id: str, user: User = Depends(get_current_user)):
    raw = await _r().get(_key(task_id))
    if not raw:
        raise HTTPException(404, "任务不存在或已过期 (24h)")
    state = json.loads(raw)
    if state.get("user_id") != user.id and user.role not in ("admin", "superadmin"):
        raise HTTPException(403, "无权访问")
    # 不返回 shots_snapshot (太大), 客户端不需要
    items = [
        {k: v for k, v in it.items() if k != "shots_snapshot"}
        for it in state.get("items", [])
    ]
    return {
        "task_id": state["task_id"],
        "title": state.get("title"),
        "status": state["status"],
        "stage": state.get("stage"),
        "progress": state.get("progress", 0),
        "shot_count": state.get("shot_count"),
        "task_count": state.get("task_count"),
        "video_template_key": state.get("video_template_key"),
        "video_template_label": state.get("video_template_label"),
        "image_template_key": state.get("image_template_key"),
        "image_template_label": state.get("image_template_label"),
        "items": items,
        "error": state.get("error"),
        "logs": state.get("logs", [])[-20:],
    }


# ============================================================
# 5) 单项编辑/重生
# ============================================================

class PatchItemIn(BaseModel):
    video_prompt: Optional[str] = None
    image_prompt: Optional[str] = None
    summary: Optional[str] = None
    duration_s: Optional[int] = Field(None, ge=1, le=15)


@router.patch("/{task_id}/items/{idx}")
async def patch_item(
    task_id: str,
    idx: int,
    payload: PatchItemIn,
    user: User = Depends(get_current_user),
):
    raw = await _r().get(_key(task_id))
    if not raw:
        raise HTTPException(404, "任务不存在或已过期")
    state = json.loads(raw)
    if state.get("user_id") != user.id and user.role not in ("admin", "superadmin"):
        raise HTTPException(403, "无权访问")

    items = state.get("items", [])
    if idx < 0 or idx >= len(items):
        raise HTTPException(404, "item idx 越界")

    it = items[idx]
    if payload.video_prompt is not None:
        it["video_prompt"] = payload.video_prompt
    if payload.image_prompt is not None:
        it["image_prompt"] = payload.image_prompt
    if payload.summary is not None:
        it["summary"] = payload.summary
    if payload.duration_s is not None:
        it["duration_s"] = payload.duration_s
    it["user_edited"] = True

    await _r().setex(_key(task_id), REDIS_TTL, json.dumps(state, ensure_ascii=False))
    return {"ok": True}


@router.post("/{task_id}/items/{idx}/regenerate")
async def regenerate_item(task_id: str, idx: int, user: User = Depends(get_current_user)):
    """单项重新渲染."""
    raw = await _r().get(_key(task_id))
    if not raw:
        raise HTTPException(404, "任务不存在或已过期")
    state = json.loads(raw)
    if state.get("user_id") != user.id and user.role not in ("admin", "superadmin"):
        raise HTTPException(403, "无权访问")

    items = state.get("items", [])
    if idx < 0 or idx >= len(items):
        raise HTTPException(404, "item idx 越界")
    it = items[idx]

    v_key = state.get("video_template_key")
    i_key = state.get("image_template_key")
    video_tpl = await get_template_by_key(v_key) if v_key else None
    image_tpl = await get_template_by_key(i_key) if i_key else None
    if not video_tpl:
        raise HTTPException(404, f"video 模板已不存在: {v_key}")

    shots_snap = it.get("shots_snapshot") or []
    if not shots_snap:
        raise HTTPException(400, "无 shots_snapshot, 无法重渲染")

    try:
        vp = await render_task_prompt(
            shots=shots_snap,
            duration=it["duration_s"],
            summary=it.get("summary", ""),
            template=video_tpl.template,
            template_label=video_tpl.label,
            ai_instruction=video_tpl.ai_instruction or "",
        )
    except Exception as e:
        raise HTTPException(500, f"渲染失败: {e}")
    it["video_prompt"] = vp
    # 渲染→优化串联(seedance): 失败回退原稿
    if vp and not vp.startswith("(渲染失败") and "seedance" in (video_tpl.key or "").lower():
        try:
            from ..seedance_pe.service import optimize_to_prompt
            opt = await optimize_to_prompt(vp)
            if opt and opt.strip():
                it["video_prompt"] = opt.strip()
        except Exception:
            logger.exception("seedance-pe optimize failed for regen task=%s idx=%d (fallback)", task_id, idx)

    if image_tpl:
        try:
            ip = await render_task_prompt(
                shots=shots_snap,
                duration=it["duration_s"],
                summary=it.get("summary", ""),
                template=image_tpl.template,
                template_label=image_tpl.label,
                ai_instruction=image_tpl.ai_instruction or "",
            )
            it["image_prompt"] = ip
        except Exception as e:
            logger.exception("regen image failed: %s", e)

    it["user_edited"] = False
    await _r().setex(_key(task_id), REDIS_TTL, json.dumps(state, ensure_ascii=False))
    return {"ok": True, "video_prompt": it["video_prompt"], "image_prompt": it.get("image_prompt", "")}


# ============================================================
# 6) 转存为正式草稿 (Phase 2)
# ============================================================

@router.post("/{task_id}/save-as-draft")
async def save_as_draft(task_id: str, user: User = Depends(get_current_user)):
    """把临时 task 转存为正式 ScriptDraft, 这样长期可访问.

    创建一个空 draft (无 chapter_gen/storyboard_gen), 直接把 items 写入 ScriptVideoPrompt 表.
    用户后续在 /drafts/{id}?tab=prompts 看到.
    """
    raw = await _r().get(_key(task_id))
    if not raw:
        raise HTTPException(404, "任务不存在或已过期")
    state = json.loads(raw)
    if state.get("user_id") != user.id and user.role not in ("admin", "superadmin"):
        raise HTTPException(403, "无权访问")

    if state.get("status") != "done":
        raise HTTPException(400, "任务未完成, 无法保存")

    items = state.get("items", [])
    if not items:
        raise HTTPException(400, "无可保存的内容")

    from ..db.models import ScriptVideoPrompt

    title = state.get("title") or "提示词速转"

    async with session_scope() as s:
        new_draft = ScriptDraft(
            user_id=user.id,
            title=f"[速转] {title}",
            user_input=f"[提示词速转任务 {task_id}]",
            status="prompts_ready",
        )
        s.add(new_draft)
        await s.flush()
        draft_id = new_draft.id

        for it in items:
            row = ScriptVideoPrompt(
                draft_id=draft_id,
                chapter_order=1,
                task_index=it["task_index"],
                duration_s=it["duration_s"],
                source_shot_nos=list(it.get("source_shot_nos") or []),
                summary=it.get("summary", ""),
                video_template_key=state.get("video_template_key"),
                video_prompt=it.get("video_prompt", ""),
                image_template_key=state.get("image_template_key"),
                image_prompt=it.get("image_prompt", ""),
                plan_json={"shots_snapshot": it.get("shots_snapshot") or [], "from_quick_task": task_id},
                status="draft",
                user_edited=bool(it.get("user_edited")),
            )
            s.add(row)

    return {"ok": True, "draft_id": draft_id, "message": f"已保存为草稿 #{draft_id}"}
