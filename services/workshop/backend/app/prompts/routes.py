"""视频提示词模块 — FastAPI 路由."""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from ..auth import User, get_current_user
from ..db import session_scope
from ..db.models import (
    PromptTemplate,
    ScriptChapter,
    ScriptDraft,
    ScriptStoryboard,
    ScriptVideoPrompt,
)
from ..stages.log_helper import save_log
from .engine import (
    plan_chapter_shots,
    render_task_prompt,
    render_template_directly,
)
from .templates import get_template_by_key, list_templates

logger = logging.getLogger("prompts.routes")
router = APIRouter(prefix="/v1", tags=["video_prompts"])

# 后台任务注册表 (防 GC)
_bg_tasks: dict[int, asyncio.Task] = {}


# ============================================================
# 模板列表 (用户/admin 都能看)
# ============================================================

@router.get("/prompt-templates")
async def list_prompt_templates(
    kind: Optional[str] = Query(None, pattern="^(video|image)$"),
    user: User = Depends(get_current_user),
):
    """列出可用模板. kind=video|image 过滤."""
    rows = await list_templates(kind=kind)
    return {
        "items": [
            {
                "id": r.id,
                "key": r.key,
                "label": r.label,
                "kind": r.kind,
                "provider": r.provider,
                "duration_min": r.duration_min,
                "duration_max": r.duration_max,
                "duration_default": r.duration_default,
                "aspect_ratio": r.aspect_ratio,
                "notes": r.notes,
            }
            for r in rows
        ]
    }


# ============================================================
# 草稿权限检查 helper
# ============================================================

async def _check_draft_owner(draft_id: int, user: User) -> ScriptDraft:
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise HTTPException(404, "draft not found")
        if user.role not in ("admin", "superadmin") and d.user_id != user.id:
            raise HTTPException(403, "无权访问此草稿")
        return d


async def _check_prompt_owner(prompt_id: int, user: User) -> ScriptVideoPrompt:
    async with session_scope() as s:
        row = await s.get(ScriptVideoPrompt, prompt_id)
        if not row:
            raise HTTPException(404, "prompt not found")
        d = await s.get(ScriptDraft, row.draft_id)
        if not d:
            raise HTTPException(404, "draft not found")
        if user.role not in ("admin", "superadmin") and d.user_id != user.id:
            raise HTTPException(403, "无权访问此 prompt")
        return row


# ============================================================
# Step 1: 规划 (plan)
# ============================================================

class PlanIn(BaseModel):
    chapter_orders: Optional[list[int]] = None  # null=全集
    video_template_key: str = Field(..., description="目标视频模型 key, 比如 seedance_2.0")


@router.post("/drafts/{draft_id}/prompts/plan")
async def plan_prompts(
    draft_id: int,
    payload: PlanIn,
    user: User = Depends(get_current_user),
):
    """规划阶段: 把分镜按"是否能合并为同一段视频"分组, 写入 plan_json (但不渲染).

    立刻返回 task_id, 后台跑 LLM. 进度看 generation_logs (stage='video_prompt_plan').
    """
    await _check_draft_owner(draft_id, user)

    tpl = await get_template_by_key(payload.video_template_key)
    if not tpl:
        raise HTTPException(404, f"模板不存在: {payload.video_template_key}")
    if tpl.kind != "video":
        raise HTTPException(400, f"模板 {tpl.key} 不是 video 类型")

    # 在跑就拒
    existing = _bg_tasks.get(draft_id)
    if existing and not existing.done():
        raise HTTPException(409, "该草稿仍有 prompts 任务在跑, 请稍后")

    # 拿 storyboards (剧本分镜优先)
    async with session_scope() as s:
        stmt = select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
        if payload.chapter_orders:
            stmt = stmt.where(ScriptStoryboard.chapter_order.in_(payload.chapter_orders))
        stmt = stmt.order_by(ScriptStoryboard.chapter_order)
        sbs = list((await s.execute(stmt)).scalars().all())

    # 仅保留确有分镜内容的章节
    sbs = [sb for sb in sbs if (sb.shots_json or [])]

    chapters_payload: list[dict] = [
        {"chapter_order": sb.chapter_order, "shots": list(sb.shots_json or []), "source": "storyboard"}
        for sb in sbs
    ]

    # 剧本(分镜)为空 → 回退到章节正文, 用整章文本合成伪分镜供规划
    if not chapters_payload:
        async with session_scope() as s:
            cstmt = select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
            if payload.chapter_orders:
                cstmt = cstmt.where(ScriptChapter.chapter_order.in_(payload.chapter_orders))
            cstmt = cstmt.order_by(ScriptChapter.chapter_order)
            chapters = list((await s.execute(cstmt)).scalars().all())
        for ch in chapters:
            text = (ch.full_text or "").strip()
            if not text:
                continue
            # 按段落切成伪分镜 (每段一个 shot), 上限 30 段避免过长
            paras = [p.strip() for p in text.replace("\r", "").split("\n") if p.strip()]
            if not paras:
                paras = [text]
            paras = paras[:30]
            pseudo_shots = [
                {"shot_no": i + 1, "action": p[:500], "dialogue": "", "location": "", "shot_type": ""}
                for i, p in enumerate(paras)
            ]
            chapters_payload.append({
                "chapter_order": ch.chapter_order,
                "shots": pseudo_shots,
                "source": "chapter",
            })

    if not chapters_payload:
        raise HTTPException(400, "该草稿既无分镜也无章节正文, 请先完成分镜或章节内容")

    chapter_count = len(chapters_payload)
    total_shots = sum(len(c["shots"]) for c in chapters_payload)
    used_chapter_fallback = any(c.get("source") == "chapter" for c in chapters_payload)

    await save_log(
        draft_id, "video_prompt_plan",
        f"开始规划: {chapter_count} 章, 共 {total_shots} 个分镜 → 模板 {tpl.label}",
        "log", 0, {"template_key": tpl.key, "chapter_count": chapter_count, "shot_count": total_shots},
    )

    async def _run():
        try:
            total_tasks = 0
            for ch in chapters_payload:
                ch_order = ch["chapter_order"]
                shots = ch["shots"]
                if not shots:
                    continue
                await save_log(
                    draft_id, "video_prompt_plan",
                    f"第{ch_order}章: 规划 {len(shots)} 个分镜...",
                    "log", ch_order, {},
                )
                tasks = await plan_chapter_shots(
                    shots,
                    model_label=tpl.label,
                    model_notes=tpl.notes or "",
                )
                # 删旧
                async with session_scope() as s2:
                    await s2.execute(
                        delete(ScriptVideoPrompt).where(
                            ScriptVideoPrompt.draft_id == draft_id,
                            ScriptVideoPrompt.chapter_order == ch_order,
                        )
                    )
                # 写新
                async with session_scope() as s3:
                    for idx, t in enumerate(tasks, start=1):
                        # 找出 source shots 的完整内容快照 (供 render 时用)
                        src_shots = [sh for sh in shots if sh.get("shot_no") in t["shot_nos"]]
                        s3.add(ScriptVideoPrompt(
                            draft_id=draft_id,
                            chapter_order=ch_order,
                            task_index=idx,
                            duration_s=int(t["duration"]),
                            source_shot_nos=list(t["shot_nos"]),
                            summary=t.get("summary", ""),
                            video_template_key=tpl.key,
                            plan_json={
                                "task": t,
                                "shots_snapshot": src_shots,
                            },
                            status="draft",
                        ))
                total_tasks += len(tasks)
                await save_log(
                    draft_id, "video_prompt_plan",
                    f"第{ch_order}章: 规划完成, {len(shots)} 镜 → {len(tasks)} 段视频任务",
                    "log", ch_order, {"task_count": len(tasks)},
                )
            await save_log(
                draft_id, "video_prompt_plan",
                f"✓ 全部规划完成: 总 {total_tasks} 段视频任务",
                "done", 0, {"total_tasks": total_tasks},
            )
        except Exception as e:
            logger.exception("plan failed: %s", e)
            try:
                await save_log(draft_id, "video_prompt_plan", f"规划失败: {e}", "error", 0, {})
            except Exception:
                pass
        finally:
            _bg_tasks.pop(draft_id, None)

    task = asyncio.create_task(_run())
    _bg_tasks[draft_id] = task

    return {
        "ok": True,
        "draft_id": draft_id,
        "chapter_count": chapter_count,
        "shot_count": total_shots,
        "template_key": tpl.key,
        "message": f"已开始规划 {chapter_count} 章, 共 {total_shots} 个分镜",
    }


# ============================================================
# Step 2: 渲染 (render)
# ============================================================

class RenderIn(BaseModel):
    chapter_orders: Optional[list[int]] = None
    video_template_key: Optional[str] = None  # 可选视频模板 (二者至少其一)
    image_template_key: Optional[str] = None  # 可选首帧图模板
    skip_user_edited: bool = True             # 默认跳过用户已改过的


@router.post("/drafts/{draft_id}/prompts/render")
async def render_prompts(
    draft_id: int,
    payload: RenderIn,
    user: User = Depends(get_current_user),
):
    """渲染阶段: 基于已有 plan_json, 用模板 + LLM 生成最终 video_prompt + image_prompt.

    video_template_key / image_template_key 至少提供其一:
    - 仅 video: 生成视频提示词
    - 仅 image: 仅生成首帧图提示词 (不动 video_prompt)
    - 两者都给: 同时生成
    """
    await _check_draft_owner(draft_id, user)

    if not payload.video_template_key and not payload.image_template_key:
        raise HTTPException(400, "请至少选择视频模板或首帧图模板其一")

    video_tpl = None
    if payload.video_template_key:
        video_tpl = await get_template_by_key(payload.video_template_key)
        if not video_tpl or video_tpl.kind != "video":
            raise HTTPException(404, f"video 模板不存在: {payload.video_template_key}")

    image_tpl = None
    if payload.image_template_key:
        image_tpl = await get_template_by_key(payload.image_template_key)
        if not image_tpl or image_tpl.kind != "image":
            raise HTTPException(404, f"image 模板不存在: {payload.image_template_key}")

    existing = _bg_tasks.get(draft_id)
    if existing and not existing.done():
        raise HTTPException(409, "该草稿仍有 prompts 任务在跑, 请稍后")

    # 取所有 plan 行
    async with session_scope() as s:
        stmt = select(ScriptVideoPrompt).where(ScriptVideoPrompt.draft_id == draft_id)
        if payload.chapter_orders:
            stmt = stmt.where(ScriptVideoPrompt.chapter_order.in_(payload.chapter_orders))
        if payload.skip_user_edited:
            stmt = stmt.where(ScriptVideoPrompt.user_edited == False)  # noqa: E712
        stmt = stmt.order_by(ScriptVideoPrompt.chapter_order, ScriptVideoPrompt.task_index)
        rows = list((await s.execute(stmt)).scalars().all())

    if not rows:
        raise HTTPException(400, "没有可渲染的任务. 请先调用 /plan 规划, 或确认未跳过过.")

    rows_payload = [
        {
            "id": r.id,
            "chapter_order": r.chapter_order,
            "task_index": r.task_index,
            "duration_s": r.duration_s,
            "summary": r.summary or "",
            "plan_json": dict(r.plan_json or {}),
        }
        for r in rows
    ]

    _render_label = (f"视频模板 {video_tpl.label}" if video_tpl else "") + (f", 首帧 {image_tpl.label}" if image_tpl else "")
    await save_log(
        draft_id, "video_prompt_render",
        f"开始渲染: {len(rows_payload)} 个任务 → {_render_label.lstrip(', ')}",
        "log", 0, {"video_template_key": (video_tpl.key if video_tpl else None), "image_template_key": (image_tpl.key if image_tpl else None), "task_count": len(rows_payload)},
    )

    # 在生成器中收集模板属性, 避免在后台任务里 detached 实例访问报错
    video_tpl_data = None
    if video_tpl:
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

    async def _run():
        try:
            done = 0
            for r in rows_payload:
                shots = (r["plan_json"] or {}).get("shots_snapshot") or []
                if not shots:
                    logger.warning("prompt id=%d no shots_snapshot, skip", r["id"])
                    continue
                video_prompt = None
                if video_tpl_data:
                    try:
                        video_prompt = await render_task_prompt(
                            shots=shots,
                            duration=r["duration_s"],
                            summary=r["summary"],
                            template=video_tpl_data["template"],
                            template_label=video_tpl_data["label"],
                            ai_instruction=video_tpl_data["ai_instruction"],
                        )
                    except Exception as e:
                        logger.exception("render video failed for prompt %d", r["id"])
                        video_prompt = f"(渲染失败: {e})"

                    # 渲染→优化 串联(seedance 模板): 渲染好的初版 prompt 再用
                    # byted-ark-seedance-pe skill 优化一遍, 只保留优化后的纯提示词。
                    # 失败则回退原渲染稿, 绝不阻断渲染流程。用户无感(一次渲染=渲染+优化)。
                    if (
                        video_prompt
                        and not video_prompt.startswith("(渲染失败")
                        and video_tpl_data
                        and "seedance" in (video_tpl_data.get("key") or "").lower()
                    ):
                        try:
                            from ..seedance_pe.service import optimize_to_prompt
                            optimized = await optimize_to_prompt(video_prompt)
                            if optimized and optimized.strip():
                                video_prompt = optimized.strip()
                        except Exception:
                            logger.exception("seedance-pe optimize failed for prompt %d (fallback to rendered)", r["id"])

                image_prompt = None
                if image_tpl_data:
                    # 首帧图调 LLM (让模型按 ai_instruction 改写, 例如 GPT Image 2 要求英文)
                    try:
                        image_prompt = await render_task_prompt(
                            shots=shots,
                            duration=r["duration_s"],
                            summary=r["summary"],
                            template=image_tpl_data["template"],
                            template_label=image_tpl_data["label"],
                            ai_instruction=image_tpl_data["ai_instruction"],
                        )
                    except Exception as e:
                        logger.exception("render image failed for prompt %d", r["id"])
                        image_prompt = ""

                async with session_scope() as s2:
                    row = await s2.get(ScriptVideoPrompt, r["id"])
                    if row:
                        if video_tpl_data:
                            row.video_template_key = video_tpl_data["key"]
                            row.video_prompt = video_prompt
                        if image_tpl_data:
                            row.image_template_key = image_tpl_data["key"]
                            row.image_prompt = image_prompt or ""
                        row.status = "draft"
                done += 1
                if done % 5 == 0 or done == len(rows_payload):
                    await save_log(
                        draft_id, "video_prompt_render",
                        f"已渲染 {done}/{len(rows_payload)}",
                        "log", 0, {"done": done, "total": len(rows_payload)},
                    )
            await save_log(
                draft_id, "video_prompt_render",
                f"✓ 全部渲染完成: {done} 段",
                "done", 0, {"done": done},
            )
        except Exception as e:
            logger.exception("render failed: %s", e)
            try:
                await save_log(draft_id, "video_prompt_render", f"渲染失败: {e}", "error", 0, {})
            except Exception:
                pass
        finally:
            _bg_tasks.pop(draft_id, None)

    task = asyncio.create_task(_run())
    _bg_tasks[draft_id] = task

    return {
        "ok": True,
        "draft_id": draft_id,
        "task_count": len(rows_payload),
        "message": f"已开始渲染 {len(rows_payload)} 段视频任务",
    }


# ============================================================
# 列表 / 编辑 / 重生 / 删除 / 导出
# ============================================================

@router.get("/drafts/{draft_id}/prompts")
async def list_draft_prompts(
    draft_id: int,
    chapter_order: Optional[int] = None,
    user: User = Depends(get_current_user),
):
    await _check_draft_owner(draft_id, user)
    async with session_scope() as s:
        stmt = select(ScriptVideoPrompt).where(ScriptVideoPrompt.draft_id == draft_id)
        if chapter_order is not None:
            stmt = stmt.where(ScriptVideoPrompt.chapter_order == chapter_order)
        stmt = stmt.order_by(ScriptVideoPrompt.chapter_order, ScriptVideoPrompt.task_index)
        rows = list((await s.execute(stmt)).scalars().all())

    return {
        "items": [
            {
                "id": r.id,
                "chapter_order": r.chapter_order,
                "task_index": r.task_index,
                "duration_s": r.duration_s,
                "source_shot_nos": list(r.source_shot_nos or []),
                "summary": r.summary,
                "video_template_key": r.video_template_key,
                "video_prompt": r.video_prompt,
                "image_template_key": r.image_template_key,
                "image_prompt": r.image_prompt,
                "status": r.status,
                "user_edited": r.user_edited,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
            for r in rows
        ],
        "running": (draft_id in _bg_tasks) and (not _bg_tasks[draft_id].done()),
    }


class PatchPromptIn(BaseModel):
    duration_s: Optional[int] = Field(None, ge=1, le=15)
    summary: Optional[str] = None
    video_prompt: Optional[str] = None
    image_prompt: Optional[str] = None


@router.patch("/drafts/{draft_id}/prompts/{prompt_id}")
async def patch_prompt(
    draft_id: int,
    prompt_id: int,
    payload: PatchPromptIn,
    user: User = Depends(get_current_user),
):
    await _check_draft_owner(draft_id, user)
    async with session_scope() as s:
        row = await s.get(ScriptVideoPrompt, prompt_id)
        if not row or row.draft_id != draft_id:
            raise HTTPException(404, "prompt not found")
        if payload.duration_s is not None:
            row.duration_s = payload.duration_s
        if payload.summary is not None:
            row.summary = payload.summary
        if payload.video_prompt is not None:
            row.video_prompt = payload.video_prompt
        if payload.image_prompt is not None:
            row.image_prompt = payload.image_prompt
        row.user_edited = True
        row.status = "edited"
    return {"ok": True}


@router.post("/drafts/{draft_id}/prompts/{prompt_id}/regenerate")
async def regenerate_single_prompt(
    draft_id: int,
    prompt_id: int,
    user: User = Depends(get_current_user),
):
    """对单段重跑渲染 (不重做规划)."""
    await _check_draft_owner(draft_id, user)
    async with session_scope() as s:
        row = await s.get(ScriptVideoPrompt, prompt_id)
        if not row or row.draft_id != draft_id:
            raise HTTPException(404, "prompt not found")
        if not row.video_template_key:
            raise HTTPException(400, "该 prompt 还没指定模板, 请先跑 render")
        plan = dict(row.plan_json or {})
        shots = plan.get("shots_snapshot") or []
        duration = row.duration_s
        summary = row.summary or ""
        v_key = row.video_template_key
        i_key = row.image_template_key

    if not shots:
        raise HTTPException(400, "无 shots_snapshot, 无法重渲染. 请重新跑规划.")

    video_tpl = await get_template_by_key(v_key)
    if not video_tpl:
        raise HTTPException(404, f"模板已删除: {v_key}")
    image_tpl = await get_template_by_key(i_key) if i_key else None

    try:
        new_video = await render_task_prompt(
            shots=shots, duration=duration, summary=summary,
            template=video_tpl.template,
            template_label=video_tpl.label,
            ai_instruction=video_tpl.ai_instruction or "",
        )
    except Exception as e:
        raise HTTPException(500, f"渲染失败: {e}")

    new_image = None
    if image_tpl:
        new_image = render_template_directly(
            shots=shots, duration=duration, summary=summary,
            template=image_tpl.template,
        )

    async with session_scope() as s:
        row = await s.get(ScriptVideoPrompt, prompt_id)
        if row:
            row.video_prompt = new_video
            if image_tpl:
                row.image_prompt = new_image
            row.user_edited = False
            row.status = "draft"

    return {"ok": True, "video_prompt": new_video, "image_prompt": new_image}


@router.delete("/drafts/{draft_id}/prompts/{prompt_id}")
async def delete_prompt(
    draft_id: int,
    prompt_id: int,
    user: User = Depends(get_current_user),
):
    await _check_draft_owner(draft_id, user)
    async with session_scope() as s:
        row = await s.get(ScriptVideoPrompt, prompt_id)
        if not row or row.draft_id != draft_id:
            raise HTTPException(404, "not found")
        await s.delete(row)
    return {"ok": True}


@router.get("/drafts/{draft_id}/prompts/export")
async def export_prompts(
    draft_id: int,
    format: str = Query("json", pattern="^(json|txt|csv)$"),
    user: User = Depends(get_current_user),
):
    await _check_draft_owner(draft_id, user)
    async with session_scope() as s:
        rows = list((await s.execute(
            select(ScriptVideoPrompt)
            .where(ScriptVideoPrompt.draft_id == draft_id)
            .order_by(ScriptVideoPrompt.chapter_order, ScriptVideoPrompt.task_index)
        )).scalars().all())

    items = [
        {
            "chapter": r.chapter_order,
            "task": r.task_index,
            "duration_s": r.duration_s,
            "shots": list(r.source_shot_nos or []),
            "summary": r.summary or "",
            "video_template": r.video_template_key,
            "video_prompt": r.video_prompt or "",
            "image_template": r.image_template_key,
            "image_prompt": r.image_prompt or "",
        }
        for r in rows
    ]

    if format == "json":
        return {"items": items}
    if format == "txt":
        lines = []
        for it in items:
            lines.append(f"=== Ch{it['chapter']} · 任务{it['task']} · {it['duration_s']}s · 镜{it['shots']} ===")
            lines.append(f"摘要: {it['summary']}")
            lines.append(f"[视频/{it['video_template']}]\n{it['video_prompt']}")
            if it.get("image_prompt"):
                lines.append(f"[首帧/{it['image_template']}]\n{it['image_prompt']}")
            lines.append("")
        return {"text": "\n".join(lines)}
    # csv
    import csv, io
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["chapter", "task", "duration_s", "shots", "summary", "video_template", "video_prompt", "image_template", "image_prompt"])
    for it in items:
        w.writerow([it["chapter"], it["task"], it["duration_s"], ",".join(map(str, it["shots"])),
                    it["summary"], it["video_template"], it["video_prompt"], it["image_template"], it["image_prompt"]])
    return {"csv": buf.getvalue()}


# ============================================================
# Admin: 模板 CRUD (仅 admin)
# ============================================================

class TemplateIn(BaseModel):
    key: str = Field(..., max_length=64)
    label: str = Field(..., max_length=64)
    kind: str = Field(..., pattern="^(video|image)$")
    provider: Optional[str] = Field(None, max_length=32)
    template: str
    duration_min: int = 1
    duration_max: int = 15
    duration_default: int = 5
    aspect_ratio: Optional[str] = None
    notes: Optional[str] = None
    ai_instruction: Optional[str] = None
    is_active: bool = True
    display_order: int = 0


def _require_admin(user: User):
    if user.role not in ("admin", "superadmin"):
        raise HTTPException(403, "需要管理员权限")


@router.get("/admin-api/prompt-templates")
async def admin_list_templates(user: User = Depends(get_current_user)):
    _require_admin(user)
    async with session_scope() as s:
        rows = list((await s.execute(
            select(PromptTemplate).order_by(PromptTemplate.kind, PromptTemplate.display_order, PromptTemplate.id)
        )).scalars().all())
    return {
        "items": [
            {
                "id": r.id,
                "key": r.key,
                "label": r.label,
                "kind": r.kind,
                "provider": r.provider,
                "template": r.template,
                "duration_min": r.duration_min,
                "duration_max": r.duration_max,
                "duration_default": r.duration_default,
                "aspect_ratio": r.aspect_ratio,
                "notes": r.notes,
                "ai_instruction": r.ai_instruction,
                "is_builtin": r.is_builtin,
                "is_active": r.is_active,
                "display_order": r.display_order,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
            for r in rows
        ]
    }


@router.post("/admin-api/prompt-templates")
async def admin_create_template(payload: TemplateIn, user: User = Depends(get_current_user)):
    _require_admin(user)
    async with session_scope() as s:
        existing = (await s.execute(select(PromptTemplate).where(PromptTemplate.key == payload.key))).scalar_one_or_none()
        if existing:
            raise HTTPException(409, f"key 已存在: {payload.key}")
        row = PromptTemplate(**payload.model_dump(), is_builtin=False)
        s.add(row)
        await s.flush()
        return {"ok": True, "id": row.id}


@router.patch("/admin-api/prompt-templates/{tpl_id}")
async def admin_update_template(tpl_id: int, payload: TemplateIn, user: User = Depends(get_current_user)):
    _require_admin(user)
    async with session_scope() as s:
        row = await s.get(PromptTemplate, tpl_id)
        if not row:
            raise HTTPException(404, "not found")
        # 不允许改 builtin 的 key
        if row.is_builtin and payload.key != row.key:
            raise HTTPException(400, "内置模板不允许改 key")
        for k, v in payload.model_dump().items():
            setattr(row, k, v)
        return {"ok": True}


@router.delete("/admin-api/prompt-templates/{tpl_id}")
async def admin_delete_template(tpl_id: int, user: User = Depends(get_current_user)):
    _require_admin(user)
    async with session_scope() as s:
        row = await s.get(PromptTemplate, tpl_id)
        if not row:
            raise HTTPException(404, "not found")
        if row.is_builtin:
            raise HTTPException(400, "内置模板不允许删除, 可改 is_active=false 隐藏")
        await s.delete(row)
    return {"ok": True}
