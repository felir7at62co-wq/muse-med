"""用量报表（P0 计价基建，2026-10-13）—— **只读**。

`GET /v2/usage/summary`   按 类别 / 模型 / 项目 / 人 / 日 汇总金额与用量
`GET /v2/usage/events`    原始流水（分页，最新在前）

数据来源是 `usage_events`（见 db.UsageEvent 与 app/usage.py）。
金额单位一律是**分**，另附 `*_yuan` 字符串便于直接展示。

## 可见性
  · 管理员：全平台；
  · 普通用户：**只看自己**提交的用量（user_id == 自己）。
  · 指定 project_id 时另走 `access.require_project_access`——看别人项目的用量
    与看别人项目的内容是同一件事。

⚠️ 文本（llm）一行的 cost 恒为 0：文本按用户操作收 0.5 元/次，由 P1 的提交闸门收，
不在单次调用上计。这里给的文本数字只有 token，供统计。
"""
from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func

from .. import access
from ..db import UsageEvent, get_session
from ..pricing import fen_to_yuan

router = APIRouter(prefix="/v2", tags=["usage"])

_GROUPS = {
    "category": UsageEvent.category,
    "model": UsageEvent.model_id,
    "project": UsageEvent.project_id,
    "user": UsageEvent.user_id,
    "job_kind": UsageEvent.job_kind,
    "day": func.substr(UsageEvent.ts, 1, 10),
}


def _scoped(q, session, project_id: Optional[str], since: Optional[str],
            until: Optional[str]):
    """套上可见性与时间窗。"""
    if project_id:
        access.require_project_access(session, project_id)
        q = q.filter(UsageEvent.project_id == project_id)
    if not access.is_admin():
        uid = access.current_user_id()
        if uid is None:
            # 未启用登录（dev 开放模式）时没有"自己"可言：不放全量出去
            raise HTTPException(403, "需要登录后查看用量")
        q = q.filter(UsageEvent.user_id == uid)
    if since:
        q = q.filter(UsageEvent.ts >= since)
    if until:
        q = q.filter(UsageEvent.ts < until)
    return q


@router.get("/usage/summary")
def usage_summary(group_by: str = Query("category"),
                  project_id: Optional[str] = None,
                  since: Optional[str] = Query(None, description="ISO 时间，含"),
                  until: Optional[str] = Query(None, description="ISO 时间，不含")) -> dict:
    """按维度汇总。group_by ∈ category|model|project|user|job_kind|day。"""
    col = _GROUPS.get(group_by)
    if col is None:
        raise HTTPException(400, f"group_by 只能是 {'/'.join(_GROUPS)}")
    with get_session() as s:
        q = s.query(
            col.label("k"),
            func.count(UsageEvent.id),
            func.sum(UsageEvent.ok),
            func.coalesce(func.sum(UsageEvent.cost_fen), 0),
            func.coalesce(func.sum(UsageEvent.total_tokens), 0),
            func.coalesce(func.sum(UsageEvent.gen_seconds), 0.0),
            func.coalesce(func.sum(UsageEvent.media_seconds), 0.0),
            func.coalesce(func.sum(UsageEvent.units), 0),
        )
        q = _scoped(q, s, project_id, since, until).group_by(col)
        rows = q.all()
    items = [{
        "key": k, "calls": n, "ok": int(ok or 0),
        "cost_fen": int(fen), "cost_yuan": fen_to_yuan(int(fen)),
        "tokens": int(tok), "gen_seconds": round(float(gs), 1),
        "media_seconds": round(float(ms), 1), "units": int(un),
    } for k, n, ok, fen, tok, gs, ms, un in rows]
    items.sort(key=lambda r: -r["cost_fen"])
    total = sum(r["cost_fen"] for r in items)
    return {"group_by": group_by, "items": items,
            "total_fen": total, "total_yuan": fen_to_yuan(total)}


@router.get("/usage/events")
def usage_events(project_id: Optional[str] = None, job_id: Optional[str] = None,
                 category: Optional[str] = None,
                 since: Optional[str] = None, until: Optional[str] = None,
                 limit: int = Query(100, ge=1, le=500),
                 offset: int = Query(0, ge=0)) -> dict:
    with get_session() as s:
        q = _scoped(s.query(UsageEvent), s, project_id, since, until)
        if job_id:
            q = q.filter(UsageEvent.job_id == job_id)
        if category:
            q = q.filter(UsageEvent.category == category)
        rows = q.order_by(UsageEvent.id.desc()).offset(offset).limit(limit).all()
        out = [{
            "id": r.id, "ts": r.ts, "category": r.category, "model_id": r.model_id,
            "channel": r.channel, "job_id": r.job_id, "job_kind": r.job_kind,
            "project_id": r.project_id, "user_id": r.user_id, "ok": bool(r.ok),
            "prompt_tokens": r.prompt_tokens, "completion_tokens": r.completion_tokens,
            "total_tokens": r.total_tokens, "gen_seconds": r.gen_seconds,
            "media_seconds": r.media_seconds, "units": r.units,
            "resolution": r.resolution, "vendor_money": r.vendor_money,
            "cost_fen": r.cost_fen, "cost_yuan": fen_to_yuan(r.cost_fen or 0),
            "meta": json.loads(r.meta) if r.meta else None,
        } for r in rows]
    return {"items": out, "limit": limit, "offset": offset}
