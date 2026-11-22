"""去 AI 味 API。**对全部登录用户开放**（原为仅管理员）。

安全模型（开放给所有用户后必须成立的四条）：
  1. 草稿归属：任何带 draft_id 的入口都过 ``_load_draft_checked``（照抄 app/check/routes.py）。
  2. 作业归属：``GET /{id}`` / ``/download`` / ``/cancel`` 全过 ``_load_job_checked``。
     不属于自己时返回 **404**（不是 403）—— 作业 id 是可遍历的整数，403 会变成
     "这个 id 存在"的探测器。与 chat_skills.t_get_job_status 的口径一致。
  3. 管理员放行（管理后台要能查所有人的作业），与 check 子系统同款。
  4. 同一草稿同时只允许一个在跑的作业（逐集 8 路 LLM 改写，重复提交 = 白烧 KEY）。

## 2026-10-30 起：写回草稿（或副本），不再出"独立清洗稿"

用户裁定：清洗稿 + 去AI味页面下载那条旁路不对 —— 用户在 v2 / Agent 里发起，
既看不到改了哪里，也拿不到结果。现在只有一种做法：
  · ``target="inplace"``：改在原稿里（逐集先留历史，可「看改动」、可逐集恢复）；
  · ``target="copy"``：先完整复制一份草稿，改在副本里，原稿一个字不动。
统一入口 ``start_deai_apply``（作业队列 kind=deai_apply）。旧的 DeaiJob 只读接口保留，
用于查看历史作业；新提交一律不再写 DeaiJob。
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..auth import get_current_user, User
from ..db import session_scope, ScriptDraft
from ..db.models import DeaiJob
from ..polish.ai_taste import detect_ai_taste
from ..polish.deai_structure import diagnose_structure
from . import service

logger = logging.getLogger("deai.routes")

router = APIRouter(prefix="/v1/deai", tags=["deai"])

#: 一个作业"还在跑"的状态集合。与 service 里的写入口径保持一致。
_ACTIVE_STATES = ("running", "pending")


def _is_admin(user: User) -> bool:
    return user.role in ("admin", "superadmin")


async def _load_draft_checked(draft_id: int, user: User) -> ScriptDraft:
    """取草稿并校验归属。管理员放行。

    404 = 不存在；403 = 存在但不是你的。这两个必须分开 —— 草稿 id 是用户
    从自己的列表里点进来的，"存在但不是你的"是用户能理解且有意义的反馈。
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
    if not d:
        raise HTTPException(404, "draft not found")
    if not _is_admin(user) and d.user_id != user.id:
        raise HTTPException(403, "无权操作该草稿")
    return d


async def _load_job_checked(job_id: int, user: User) -> DeaiJob:
    """取作业并校验归属。管理员放行。

    ⚠️ 不属于自己时返回 **404 而不是 403**（与 _load_draft_checked 刻意不同）：
    作业 id 是可遍历的整数，403 等于告诉扫描者"这个 id 真的存在"。
    这里的 per_ep_json 存着用户剧本的**原文 + 改写全文**，泄露一条就是整本剧透。
    """
    async with session_scope() as s:
        j = await s.get(DeaiJob, job_id)
    if not j:
        raise HTTPException(404, "job not found")
    if not _is_admin(user) and j.user_id != user.id:
        raise HTTPException(404, "job not found")
    return j


async def _active_job_for_draft(draft_id: int) -> int | None:
    """返回该草稿正在跑的 deai 作业 id（没有则 None）。"""
    async with session_scope() as s:
        row = (await s.execute(
            select(DeaiJob).where(
                DeaiJob.draft_id == draft_id,
                DeaiJob.status.in_(_ACTIVE_STATES),
            ).order_by(DeaiJob.id.desc()).limit(1)
        )).scalars().first()
        return int(row.id) if row else None


class DetectBody(BaseModel):
    text: str = ""
    draft_id: int | None = None


@router.post("/detect")
async def detect(body: DetectBody, user: User = Depends(get_current_user)):
    """检测一段文本(或某草稿全文)的 AI 味。**同步、零成本、不调模型。**

    传 text = 检测任意一段文本（不限所属）；传 draft_id = 检测整部剧本
    （**校验草稿归属**）。两个都不传 → 400。
    """
    if body.text:
        # 纯文本检测无归属可言 —— 用户贴进来的东西就是他自己的，不做额外校验
        return {
            "ok": True,
            "report": detect_ai_taste(body.text).to_dict(),
            "structure": diagnose_structure(body.text).to_dict(),
        }
    if body.draft_id:
        await _load_draft_checked(body.draft_id, user)
        eps = await service._load_episodes(body.draft_id)
        joined = "\n".join(t for _, _, t in eps)
        rep = detect_ai_taste(joined)
        return {
            "ok": True, "report": rep.to_dict(),
            "structure": diagnose_structure(joined).to_dict(),
            "episode_count": len(eps),
        }
    raise HTTPException(400, "需要 text 或 draft_id")


class SubmitBody(BaseModel):
    draft_id: int
    rewrite: bool = True                       # LLM 去味改写
    inject_level: str = Field("light")         # none/light/medium/heavy
    allow_typo: bool = True                    # 注入错别字(默认开)
    model: str = "gemini"


def _job_view(j: DeaiJob) -> dict:
    return {
        "id": j.id,
        "draft_id": j.draft_id,
        "title": j.title,
        "status": j.status,
        "total": j.total,
        "finished": j.finished,
        "failed": j.failed,
        "rewrite": bool(j.rewrite),
        "inject_level": j.inject_level,
        "allow_typo": bool(j.allow_typo),
        "per_ep": j.per_ep_json or {},
        "summary": j.summary_json or {},
        "error": j.error or "",
        "created_at": j.created_at.isoformat() if j.created_at else None,
    }


async def create_deai_job(*, draft_id: int, user_id: int, rewrite: bool = True,
                          inject_level: str = "light", allow_typo: bool = True,
                          model: str = "gemini") -> dict:
    """建作业 + 起后台任务。HTTP 路由与对话工坊动作**共用这一个口**。

    返回 ``{"ok": True, "job_id": N}`` 或 ``{"ok": False, "error": ...}``（含在跑的作业 id）。
    归属校验由调用方负责（HTTP 走 _load_draft_checked；对话工坊在 _stream_action 里
    已经校验过会话→草稿→用户这条链）。
    """
    if inject_level not in ("none", "light", "medium", "heavy"):
        return {"ok": False, "error": "inject_level 非法"}

    # 同一草稿串行：逐集 8 路并发改写，连点三次就是 24 路对着同一部稿子烧 KEY，
    # 而且产出的三份清洗稿内容几乎一样 —— 语义上重复，不是"慢"的问题。
    # ⚠️ 这是**语义去重**，不是限流降速，不涉及任何并发数调整。
    running = await _active_job_for_draft(draft_id)
    if running:
        return {"ok": False, "error": f"这部剧已有去 AI 味作业 #{running} 在跑，等它完成再提交。",
                "job_id": running, "already_running": True}

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        job = DeaiJob(
            user_id=user_id, draft_id=draft_id, title=(d.title or f"草稿{draft_id}"),
            status="running", rewrite=1 if rewrite else 0,
            inject_level=inject_level, allow_typo=1 if allow_typo else 0,
            model=model,
        )
        s.add(job)
        await s.flush()
        job_id = job.id
    asyncio.create_task(service.run_deai(job_id))
    logger.info("deai job %d submitted for draft %d by user %d", job_id, draft_id, user_id)
    return {"ok": True, "job_id": job_id}


async def start_deai_apply(*, draft_id: int, user_id: int, target: str = "inplace",
                           inject_level: str = "light", allow_typo: bool = True,
                           model: str = "gemini", start_ep: int = 0, end_ep: int = 0,
                           layer: str | None = None) -> dict:
    """去 AI 味的**唯一提交入口**（HTTP / 对话工坊动作 / Agent 工具共用）。

    target="copy" 时先建副本，作业挂在副本上 —— 这样作业互斥、「看改动」、草稿活动
    全都自然指向副本，不需要任何地方再分辨"源稿还是副本"。
    返回 ``{ok, job_id, kind, draft_id, copied_from?}``；归属校验由调用方负责。
    """
    from ..agent import jobs
    from .service import copy_draft_for_deai
    if inject_level not in ("none", "light", "medium", "heavy"):
        return {"ok": False, "error": "inject_level 非法"}
    if target not in ("inplace", "copy"):
        return {"ok": False, "error": "target 只能是 inplace（改原稿）或 copy（建副本）"}
    work_id = draft_id
    if target == "copy":
        work_id = await copy_draft_for_deai(draft_id, user_id)
    job_id = await jobs.enqueue(
        kind="deai_apply", draft_id=work_id, user_id=user_id,
        payload={"model": model or "gemini", "inject_level": inject_level, "allow_typo": bool(allow_typo),
                 "start_ep": int(start_ep or 0), "end_ep": int(end_ep or 0),
                 "target": target, "source_draft_id": draft_id,
                 "layer": layer if layer in ("storyboard", "chapter") else None},
    )
    out = {"ok": True, "job_id": job_id, "kind": "deai_apply", "draft_id": work_id}
    if target == "copy":
        out["copied_from"] = draft_id
    return out


class ApplyBody(BaseModel):
    draft_id: int
    target: str = Field("inplace", description="inplace=改原稿 / copy=建副本改副本")
    inject_level: str = Field("light")
    allow_typo: bool = True
    model: str = "gemini"
    start_ep: int = 0
    end_ep: int = 0
    layer: str | None = Field(None, description="storyboard=剧本 / chapter=正文；不传=有剧本改剧本")


@router.post("")
async def submit(body: ApplyBody, user: User = Depends(get_current_user)):
    """提交去 AI 味（写回原稿或副本）。进度/改动走 /v1/agent/jobs/{job_id}（及 /changes）。"""
    await _load_draft_checked(body.draft_id, user)
    res = await start_deai_apply(
        draft_id=body.draft_id, user_id=user.id, target=body.target,
        inject_level=body.inject_level, allow_typo=body.allow_typo, model=body.model,
        start_ep=body.start_ep, end_ep=body.end_ep, layer=body.layer)
    if not res.get("ok"):
        raise HTTPException(400, res.get("error") or "提交失败")
    return res


@router.get("")
async def list_jobs(user: User = Depends(get_current_user)):
    """列我自己的去 AI 味作业（最近 30 条）。"""
    async with session_scope() as s:
        rows = (await s.execute(
            select(DeaiJob).where(DeaiJob.user_id == user.id)
            .order_by(DeaiJob.created_at.desc()).limit(30)
        )).scalars().all()
    return {"ok": True, "items": [_job_view(r) for r in rows]}


@router.get("/{job_id}")
async def get_job(job_id: int, user: User = Depends(get_current_user)):
    j = await _load_job_checked(job_id, user)
    return {"ok": True, "job": _job_view(j)}


@router.get("/{job_id}/download")
async def download_result(job_id: int, user: User = Depends(get_current_user)):
    """下载去味后的整部剧本(txt): 按集拼接 rewritten_text。"""
    j = await _load_job_checked(job_id, user)
    per = j.per_ep_json or {}
    title = j.title or f"draft{j.draft_id}"
    if not per:
        raise HTTPException(400, "该作业暂无可下载的结果")
    # 按集号排序拼接(纯剧本正文, 不加任何多余标题/说明)
    parts: list[str] = []
    for ep in sorted(per.keys(), key=lambda x: int(x) if str(x).isdigit() else 0):
        info = per[ep] or {}
        txt = (info.get("rewritten_text") or "").strip()
        if not txt:
            continue
        parts.append(service._strip_llm_preamble(txt))  # 兼容历史数据: 再清一次开场白
    body = "\n\n\n".join(parts)
    from urllib.parse import quote
    fname = quote(f"{title}-去AI味.txt")
    return Response(
        content=body.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{fname}"},
    )


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: int, user: User = Depends(get_current_user)):
    j = await _load_job_checked(job_id, user)
    async with session_scope() as s:
        row = await s.get(DeaiJob, j.id)
        if row and row.status in _ACTIVE_STATES:
            row.status = "canceled"
    return {"ok": True}
