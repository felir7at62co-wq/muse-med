"""火山计费 — 管理员 API。挂在 /v1/admin-api/volc-billing 下, require_admin 保护。

- GET  /summary                总览(总成本/总token/调用数, 按 biz_type 分组)
- GET  /by-user                 按用户聚合(成本/token/次数)
- GET  /records                 明细(可按 user_id/biz_type/时间过滤, 分页)
- GET  /rates                   费率表
- PATCH /rates/{model_key}      改单价
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..auth.dependencies import require_admin
from ..auth.models import User
from ..db import session_scope
from .models import VolcRateCard, VolcUsageRecord

logger = logging.getLogger("volc.routes")
router = APIRouter(prefix="/v1/admin-api/volc-billing", tags=["volc-billing"])


def _parse_range(days: int | None, start: str | None, end: str | None):
    """返回 (start_dt, end_dt)。优先用显式 start/end(ISO), 否则用最近 days 天。"""
    end_dt = datetime.utcnow()
    start_dt = None
    if start:
        try:
            start_dt = datetime.fromisoformat(start)
        except Exception:  # noqa: BLE001
            start_dt = None
    if end:
        try:
            end_dt = datetime.fromisoformat(end)
        except Exception:  # noqa: BLE001
            pass
    if start_dt is None:
        start_dt = end_dt - timedelta(days=days or 30)
    return start_dt, end_dt


@router.get("/summary")
async def summary(
    days: int = Query(30, ge=1, le=365),
    start: str | None = Query(None),
    end: str | None = Query(None),
    admin: User = Depends(require_admin),
):
    """总览: 时间段内总成本/总token/调用数 + 按 biz_type 分组。"""
    start_dt, end_dt = _parse_range(days, start, end)
    async with session_scope() as s:
        base = select(
            func.count().label("calls"),
            func.coalesce(func.sum(VolcUsageRecord.total_tokens), 0).label("tokens"),
            func.coalesce(func.sum(VolcUsageRecord.cost_cny), 0).label("cost"),
        ).where(
            VolcUsageRecord.created_at >= start_dt,
            VolcUsageRecord.created_at <= end_dt,
        )
        total = (await s.execute(base)).first()

        grp = (await s.execute(
            select(
                VolcUsageRecord.biz_type,
                func.count().label("calls"),
                func.coalesce(func.sum(VolcUsageRecord.total_tokens), 0).label("tokens"),
                func.coalesce(func.sum(VolcUsageRecord.cost_cny), 0).label("cost"),
            ).where(
                VolcUsageRecord.created_at >= start_dt,
                VolcUsageRecord.created_at <= end_dt,
            ).group_by(VolcUsageRecord.biz_type)
        )).all()

    return {
        "range": {"start": start_dt.isoformat(), "end": end_dt.isoformat()},
        "total": {
            "calls": int(total.calls or 0),
            "tokens": int(total.tokens or 0),
            "cost_cny": str(total.cost or 0),
        },
        "by_biz_type": [
            {
                "biz_type": r.biz_type,
                "calls": int(r.calls or 0),
                "tokens": int(r.tokens or 0),
                "cost_cny": str(r.cost or 0),
            }
            for r in grp
        ],
    }


@router.get("/by-user")
async def by_user(
    days: int = Query(30, ge=1, le=365),
    start: str | None = Query(None),
    end: str | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    admin: User = Depends(require_admin),
):
    """按用户聚合成本/token/次数, 降序。"""
    start_dt, end_dt = _parse_range(days, start, end)
    async with session_scope() as s:
        rows = (await s.execute(
            select(
                VolcUsageRecord.user_id,
                func.count().label("calls"),
                func.coalesce(func.sum(VolcUsageRecord.total_tokens), 0).label("tokens"),
                func.coalesce(func.sum(VolcUsageRecord.cost_cny), 0).label("cost"),
            ).where(
                VolcUsageRecord.created_at >= start_dt,
                VolcUsageRecord.created_at <= end_dt,
            ).group_by(VolcUsageRecord.user_id)
            .order_by(func.sum(VolcUsageRecord.cost_cny).desc())
            .limit(limit)
        )).all()

        uids = [r.user_id for r in rows if r.user_id is not None]
        umap: dict[int, str] = {}
        if uids:
            us = (await s.execute(select(User).where(User.id.in_(uids)))).scalars().all()
            for u in us:
                umap[u.id] = u.display_name or u.username or u.login_id

    return {
        "range": {"start": start_dt.isoformat(), "end": end_dt.isoformat()},
        "items": [
            {
                "user_id": r.user_id,
                "user_name": umap.get(r.user_id, "(系统/未知)") if r.user_id else "(系统/无归属)",
                "calls": int(r.calls or 0),
                "tokens": int(r.tokens or 0),
                "cost_cny": str(r.cost or 0),
            }
            for r in rows
        ],
    }


@router.get("/records")
async def records(
    user_id: int | None = Query(None),
    biz_type: str | None = Query(None),
    days: int = Query(30, ge=1, le=365),
    start: str | None = Query(None),
    end: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    admin: User = Depends(require_admin),
):
    """明细列表(分页)。"""
    start_dt, end_dt = _parse_range(days, start, end)
    async with session_scope() as s:
        stmt = select(VolcUsageRecord).where(
            VolcUsageRecord.created_at >= start_dt,
            VolcUsageRecord.created_at <= end_dt,
        )
        if user_id is not None:
            stmt = stmt.where(VolcUsageRecord.user_id == user_id)
        if biz_type:
            stmt = stmt.where(VolcUsageRecord.biz_type == biz_type)
        total = (await s.execute(
            select(func.count()).select_from(stmt.subquery())
        )).scalar_one()
        stmt = stmt.order_by(VolcUsageRecord.id.desc()).offset(offset).limit(limit)
        rows = (await s.execute(stmt)).scalars().all()

        uids = list({r.user_id for r in rows if r.user_id is not None})
        umap: dict[int, str] = {}
        if uids:
            us = (await s.execute(select(User).where(User.id.in_(uids)))).scalars().all()
            for u in us:
                umap[u.id] = u.display_name or u.username or u.login_id

    return {
        "total": int(total or 0),
        "items": [
            {
                "id": r.id,
                "user_id": r.user_id,
                "user_name": umap.get(r.user_id, "(系统/无归属)") if r.user_id else "(系统/无归属)",
                "biz_type": r.biz_type,
                "source": r.source,
                "model_key": r.model_key,
                "ep_id": r.ep_id,
                "request_id": r.request_id,
                "prompt_tokens": r.prompt_tokens,
                "completion_tokens": r.completion_tokens,
                "total_tokens": r.total_tokens,
                "resolution": r.resolution,
                "duration_sec": str(r.duration_sec or 0),
                "ratio": r.ratio,
                "has_audio": r.has_audio,
                "unit_price_per_mtoken": str(r.unit_price_per_mtoken or 0),
                "cost_cny": str(r.cost_cny or 0),
                "is_estimated": r.is_estimated,
                "draft_id": r.draft_id,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }


@router.get("/rates")
async def list_rates(admin: User = Depends(require_admin)):
    """费率表。"""
    async with session_scope() as s:
        rows = (await s.execute(select(VolcRateCard).order_by(VolcRateCard.id))).scalars().all()
    return {
        "items": [
            {
                "id": r.id,
                "model_key": r.model_key,
                "label": r.label,
                "unit_price_per_mtoken": str(r.unit_price_per_mtoken or 0),
                "note": r.note,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
            for r in rows
        ]
    }


class RateUpdateIn(BaseModel):
    unit_price_per_mtoken: str = Field(..., description="元/百万token, 高精度字符串")
    label: str | None = None
    note: str | None = None


@router.patch("/rates/{model_key}")
async def update_rate(model_key: str, payload: RateUpdateIn, admin: User = Depends(require_admin)):
    """改某模型单价(元/百万token)。不存在则创建。"""
    try:
        price = Decimal(payload.unit_price_per_mtoken)
        if price < 0:
            raise ValueError("单价不能为负")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"单价格式非法: {e}")

    async with session_scope() as s:
        row = (await s.execute(
            select(VolcRateCard).where(VolcRateCard.model_key == model_key)
        )).scalar_one_or_none()
        if row is None:
            row = VolcRateCard(model_key=model_key, label=payload.label or model_key)
            s.add(row)
        row.unit_price_per_mtoken = price
        if payload.label is not None:
            row.label = payload.label
        if payload.note is not None:
            row.note = payload.note
        row.updated_by = admin.id
    return {"ok": True}