"""DNA 裂变工厂 API。

用户在某部原作草稿上, 一句话说清创作意图 + 选裂变强度/个数 →
后台并发裂变出 N 个各具新意的完整新作(大纲级), 进裂变结果供挑选。

默认走**两段式**: 先出「故事圣经 + 前 N 集」→ 用户确认/编辑/砍方向 → 再展开全集。
  POST   /v1/spawn                                 提交(two_stage=true 时停在预览)
  GET    /v1/spawn/{id}                            查进度(含 stage / 预览内容)
  PATCH  /v1/spawn/{id}/variants/{idx}             手改预览(圣经/主线/人物/前 N 集)
  POST   /v1/spawn/{id}/variants/{idx}/refine      按意见让 AI 重出预览
  POST   /v1/spawn/{id}/variants/{idx}/drop        弃用该方向
  POST   /v1/spawn/{id}/expand                     确认后展开成全集
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from ..auth import get_current_user, User
from ..db import session_scope, ScriptDraft
from ..stages.story_bible import _normalize_bible
from .models import SpawnJob
from . import service

logger = logging.getLogger("spawn.routes")

router = APIRouter(prefix="/v1/spawn", tags=["spawn"])

_MODES = {"clone", "homage", "inspired"}
_MAX_COUNT = 8
_MAX_PREVIEW_EPS = 6


def _job_view(j: SpawnJob) -> dict:
    return {
        "id": j.id,
        "source_draft_id": j.source_draft_id,
        "title": j.title,
        "intent": j.intent or "",
        "mode": j.mode,
        "model": j.model,
        "count": j.count,
        "status": j.status,
        "stage": j.stage or "legacy",
        "preview_episodes": j.preview_episodes or 3,
        "total": j.total,
        "finished": j.finished,
        "failed": j.failed,
        "dna": j.dna_json or {},
        "variants": j.variants_json or {},
        "error": j.error or "",
        "total_tokens": j.total_tokens or 0,
        "prompt_tokens": j.prompt_tokens or 0,
        "completion_tokens": j.completion_tokens or 0,
        "cached_tokens": j.cached_tokens or 0,
        "created_at": j.created_at.isoformat() if j.created_at else None,
        "finished_at": j.finished_at.isoformat() if j.finished_at else None,
    }


async def _owned_job(s, job_id: int, user: User) -> SpawnJob:
    j = await s.get(SpawnJob, job_id)
    if not j:
        raise HTTPException(404, "job not found")
    if j.user_id != user.id and user.role not in ("admin", "superadmin"):
        raise HTTPException(403, "无权操作")
    return j


def _variant_of(j: SpawnJob, idx: int) -> tuple[dict, dict, str]:
    """取某个裂变方向; 返回 (variants_json 副本, 该方向, key)。"""
    per = dict(j.variants_json or {})
    key = str(idx)
    if key not in per:
        raise HTTPException(404, "该裂变方向不存在")
    return per, dict(per[key]), key


class SubmitBody(BaseModel):
    word_target: int = 0  # 0=继承原作设置; >0=用户自定义
    source_draft_id: int
    intent: str = ""                        # 用户创作意图(自由文本, 可空)
    mode: str = Field("homage")             # clone | homage | inspired
    count: int = Field(3, ge=1, le=_MAX_COUNT)
    model: str = "gemini"
    # 两段式: 先出"圣经+前 N 集"待人工确认(默认开)。false 则一步到位跑完全集(旧行为)
    two_stage: bool = True
    preview_episodes: int = Field(3, ge=1, le=_MAX_PREVIEW_EPS)


@router.post("")
async def submit(body: SubmitBody, user: User = Depends(get_current_user)):
    """提交一个裂变作业。"""
    if body.mode not in _MODES:
        raise HTTPException(400, "mode 非法(clone|homage|inspired)")
    async with session_scope() as s:
        d = await s.get(ScriptDraft, body.source_draft_id)
        if not d:
            raise HTTPException(404, "原作草稿不存在")
        if d.user_id != user.id and user.role not in ("admin", "superadmin"):
            raise HTTPException(403, "无权对该草稿裂变")
        if not (d.outline or {}).get("chapters"):
            raise HTTPException(400, "原作尚无大纲, 请先生成大纲再裂变")
        src_title = d.title or f"草稿{body.source_draft_id}"
        job = SpawnJob(
            user_id=user.id,
            source_draft_id=body.source_draft_id,
            title=f"《{src_title}》裂变 ×{body.count}",
            intent=body.intent or "",
            mode=body.mode,
            model=body.model,
            count=body.count,
            stage="preview" if body.two_stage else "legacy",
            preview_episodes=body.preview_episodes,
            dna_json=({"_word_target": body.word_target} if body.word_target > 0 else {}),
            status="pending",
            total=body.count,
        )
        s.add(job)
        await s.flush()
        job_id = job.id
    asyncio.create_task(service.run_spawn(job_id))
    logger.info("spawn job %d submitted (draft=%d, count=%d, mode=%s, two_stage=%s)",
                job_id, body.source_draft_id, body.count, body.mode, body.two_stage)
    return {"ok": True, "job_id": job_id}


@router.get("")
async def list_jobs(
    source_draft_id: int | None = None,
    user: User = Depends(get_current_user),
):
    """列出当前用户的裂变作业(可按原作过滤)。"""
    async with session_scope() as s:
        q = select(SpawnJob).where(SpawnJob.user_id == user.id)
        if source_draft_id:
            q = q.where(SpawnJob.source_draft_id == source_draft_id)
        rows = (await s.execute(
            q.order_by(SpawnJob.created_at.desc()).limit(30)
        )).scalars().all()
    return {"ok": True, "items": [_job_view(r) for r in rows]}


@router.get("/{job_id}")
async def get_job(job_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        j = await s.get(SpawnJob, job_id)
        if not j:
            raise HTTPException(404, "job not found")
        if j.user_id != user.id and user.role not in ("admin", "superadmin"):
            raise HTTPException(403, "无权查看")
        return {"ok": True, "job": _job_view(j)}


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        j = await s.get(SpawnJob, job_id)
        if not j:
            raise HTTPException(404, "job not found")
        if j.user_id != user.id and user.role not in ("admin", "superadmin"):
            raise HTTPException(403, "无权操作")
        if j.status in ("running", "pending"):
            j.status = "canceled"
    return {"ok": True}


# ===========================================================================
# 两段式: 预览确认环节
# ===========================================================================

class PatchVariantBody(BaseModel):
    """手改预览。所有字段都可选, 只改传了的那些。"""
    title: str | None = None
    synopsis: str | None = None          # 全剧主线
    world: dict | None = None
    characters: list[dict] | None = None
    story_bible: dict | None = None      # 故事圣经(硬约束, 会喂给后续所有批次)
    chapters: list[dict] | None = None   # 前 N 集(order 会重排为 1..N)


def _norm_edit_chapters(raw: list[dict]) -> list[dict]:
    out: list[dict] = []
    for c in raw or []:
        if not isinstance(c, dict):
            continue
        out.append({
            "order": len(out) + 1,
            "title": str(c.get("title", f"第{len(out)+1}集")).strip(),
            "synopsis": str(c.get("synopsis", "")).strip(),
            "must_have": list(c.get("must_have") or []),
            "characters": list(c.get("characters") or []),
        })
    return out


@router.patch("/{job_id}/variants/{idx}")
async def patch_variant(
    job_id: int, idx: int, body: PatchVariantBody,
    user: User = Depends(get_current_user),
):
    """把用户对预览的修改写回预览草稿 —— 展开时它们就是后续所有批次的硬约束。"""
    async with session_scope() as s:
        j = await _owned_job(s, job_id, user)
        per, v, key = _variant_of(j, idx)
        if v.get("status") not in ("待确认",):
            raise HTTPException(400, f"该方向当前状态为「{v.get('status')}」, 不可编辑")
        did = v.get("draft_id")
        if not did:
            raise HTTPException(400, "该方向尚无预览草稿")

        d = await s.get(ScriptDraft, int(did))
        if not d or d.is_deleted:
            raise HTTPException(404, "预览草稿不存在")
        ol = dict(d.outline or {})

        if body.title is not None and body.title.strip():
            ol["title"] = body.title.strip()
            d.title = ol["title"]
        if body.synopsis is not None:
            ol["synopsis"] = body.synopsis.strip()
        if body.world is not None:
            ol["world"] = body.world
        if body.characters is not None:
            ol["characters"] = [
                {"name": str(c.get("name", "")).strip(),
                 "role": str(c.get("role", "")).strip(),
                 "traits": list(c.get("traits") or []),
                 "appearance": str(c.get("appearance", "")).strip()}
                for c in body.characters
                if isinstance(c, dict) and str(c.get("name", "")).strip()
            ]
        if body.story_bible is not None:
            # 复用大纲侧的归一化, 保证用户手改后的圣经结构仍合法
            ol["story_bible"] = _normalize_bible(body.story_bible)
        if body.chapters is not None:
            chs = _norm_edit_chapters(body.chapters)
            if not chs:
                raise HTTPException(400, "chapters 不能为空")
            ol["chapters"] = chs

        d.outline = ol
        flag_modified(d, "outline")

        # 同步卡片摘要, 让前端不必等下一次轮询才看到自己的修改
        preview_n = len(ol.get("chapters") or [])
        v.update({
            "title": ol.get("title", ""),
            "synopsis": ol.get("synopsis", ""),
            "world": ol.get("world") or {},
            "characters": [{"name": c.get("name", ""), "role": c.get("role", ""),
                            "traits": list(c.get("traits") or [])[:3]}
                           for c in (ol.get("characters") or [])[:8]],
            "preview_chapters": [{"order": c.get("order"), "title": c.get("title", ""),
                                  "synopsis": c.get("synopsis", "")}
                                 for c in (ol.get("chapters") or [])[:preview_n]],
            "edited": True,
        })
        per[key] = v
        j.variants_json = per
        flag_modified(j, "variants_json")
        return {"ok": True, "variant": v}


class RefineBody(BaseModel):
    feedback: str = Field("", max_length=4000)   # 用户修改意见(自然语言)


@router.post("/{job_id}/variants/{idx}/refine")
async def refine_variant(
    job_id: int, idx: int, body: RefineBody,
    user: User = Depends(get_current_user),
):
    """按用户意见让 AI 重出一版预览(同步返回, 单次 LLM 调用, 秒级~十几秒)。"""
    async with session_scope() as s:
        j = await _owned_job(s, job_id, user)
        _, v, _ = _variant_of(j, idx)
        if v.get("status") != "待确认":
            raise HTTPException(400, f"该方向当前状态为「{v.get('status')}」, 不可精修")
        did = v.get("draft_id")
        provider = j.model or "gemini"
    if not did:
        raise HTTPException(400, "该方向尚无预览草稿")

    try:
        ol = await service.refine_preview(int(did), body.feedback, provider=provider)
    except Exception as e:  # noqa: BLE001
        logger.exception("spawn %d variant %d refine failed", job_id, idx)
        raise HTTPException(500, f"精修失败: {e}") from e

    async with session_scope() as s:
        j = await _owned_job(s, job_id, user)
        per, v, key = _variant_of(j, idx)
        n = len(ol.get("chapters") or [])
        v.update({
            "title": ol.get("title", ""),
            "synopsis": ol.get("synopsis", ""),
            "world": ol.get("world") or {},
            "characters": [{"name": c.get("name", ""), "role": c.get("role", ""),
                            "traits": list(c.get("traits") or [])[:3]}
                           for c in (ol.get("characters") or [])[:8]],
            "preview_chapters": [{"order": c.get("order"), "title": c.get("title", ""),
                                  "synopsis": c.get("synopsis", "")}
                                 for c in (ol.get("chapters") or [])[:n]],
            "refined": int(v.get("refined") or 0) + 1,
        })
        per[key] = v
        j.variants_json = per
        flag_modified(j, "variants_json")
        return {"ok": True, "variant": v}


@router.post("/{job_id}/variants/{idx}/drop")
async def drop_variant(job_id: int, idx: int, user: User = Depends(get_current_user)):
    """弃用某个方向: 软删它的预览草稿, 展开时跳过。"""
    async with session_scope() as s:
        j = await _owned_job(s, job_id, user)
        per, v, key = _variant_of(j, idx)
        if v.get("status") == "完成":
            raise HTTPException(400, "该方向已展开完成, 请到草稿列表删除")
        did = v.get("draft_id")
        if did:
            d = await s.get(ScriptDraft, int(did))
            if d:
                d.is_deleted = True
        v["status"] = "已弃用"
        per[key] = v
        j.variants_json = per
        flag_modified(j, "variants_json")
        # 全部方向都被弃用 → 作业收尾
        if all(x.get("status") in ("已弃用", "失败") for x in per.values()):
            j.status = "canceled"
            j.stage = "done"
    return {"ok": True}


class ExpandBody(BaseModel):
    indices: list[int] | None = None   # 不传=展开所有"待确认"的方向


@router.post("/{job_id}/expand")
async def expand_job(
    job_id: int, body: ExpandBody | None = None,
    user: User = Depends(get_current_user),
):
    """确认预览后, 把选中的方向展开成全集大纲(后台跑, 轮询 GET /v1/spawn/{id} 看进度)。"""
    async with session_scope() as s:
        j = await _owned_job(s, job_id, user)
        if j.status not in ("preview_ready",):
            raise HTTPException(400, f"作业当前状态为「{j.status}」, 不可展开")
        per = dict(j.variants_json or {})
        pending = [int(v.get("idx", -1)) for v in per.values() if v.get("status") == "待确认"]
        if not pending:
            raise HTTPException(400, "没有待确认的方向可展开")
        idxs = body.indices if (body and body.indices) else None
        if idxs is not None:
            picked = [i for i in idxs if i in pending]
            if not picked:
                raise HTTPException(400, "选中的方向都不处于「待确认」状态")
            idxs = picked
    asyncio.create_task(service.run_expand(job_id, idxs))
    logger.info("spawn job %d expand requested (indices=%s)", job_id, idxs or "all")
    return {"ok": True, "job_id": job_id, "expanding": idxs or pending}


__all__ = ["router"]