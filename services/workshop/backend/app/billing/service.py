"""计费写入与查询。

- record_generate(job_id, user_id, model, size, n_images)
- record_upscale(job_id, user_id, duration_seconds)
- record_runninghub(biz_type, job_id, started_at, finished_at)  ← 音频/配音/视频高清
- 查询: 汇总 + 明细 (用户限定自己, 管理员可全量/按用户过滤)
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import func, select

from ..db import session_scope
from .models import ImageBilling
from .rh_models import RunninghubBilling
from . import pricing

logger = logging.getLogger("billing")


async def _exists(job_id: int) -> bool:
    async with session_scope() as s:
        row = (await s.execute(
            select(ImageBilling.id).where(ImageBilling.job_id == job_id)
        )).first()
        return row is not None


async def record_generate(
    *, job_id: int, user_id: int, model: str, size: Optional[str], n_images: int
) -> None:
    """生成成功后落计费记录 (幂等: 同 job 只记一次)。"""
    if n_images <= 0:
        return
    if await _exists(job_id):
        return
    unit, amount, detail = pricing.estimate_generate(model, size, n_images)
    try:
        async with session_scope() as s:
            s.add(ImageBilling(
                job_id=job_id, user_id=user_id, kind="generate", model=model,
                unit="张", quantity=float(n_images), unit_price=unit,
                amount=amount, detail=detail,
            ))
    except Exception as e:  # noqa: BLE001
        logger.warning("record_generate job %s failed: %s", job_id, e)


async def record_upscale(
    *, job_id: int, user_id: Optional[int] = None, duration_seconds: float,
    started_at: Optional[datetime] = None, finished_at: Optional[datetime] = None,
) -> None:
    """放大/润色落计费记录 (幂等: 同 job_id 只记一次)。

    started_at/finished_at 给了就用它算时长(排队时间不算算力); 未给则沿用调用方
    传进来的 duration_seconds(历史口径), 兼容尚未补时间戳的调用点。

    user_id 传 None 时从归属上下文兜底 —— 与 record_runninghub 同口径,
    这样启动恢复(resume_*)路径也能归到人头上。
    """
    if await _exists(job_id):
        return
    if user_id is None:
        try:
            from ..factory.usage import get_usage_user_id
            user_id = get_usage_user_id()
        except Exception:  # noqa: BLE001
            user_id = None
    if started_at is not None and finished_at is not None:
        duration_seconds = max(0.0, (finished_at - started_at).total_seconds())
    unit, amount, detail = pricing.estimate_upscale(duration_seconds)
    try:
        async with session_scope() as s:
            s.add(ImageBilling(
                job_id=job_id, user_id=user_id, kind="upscale", model="runninghub",
                unit="小时", quantity=detail.get("hours", 0.0), unit_price=unit,
                amount=amount, detail=detail,
            ))
    except Exception as e:  # noqa: BLE001
        logger.warning("record_upscale job %s failed: %s", job_id, e)


async def record_runninghub(
    *,
    biz_type: str,
    job_id: int,
    user_id: Optional[int] = None,
    started_at: Optional[datetime] = None,
    finished_at: Optional[datetime] = None,
    rh_task_id: str = "",
    status: str = "succeeded",
    detail: str = "",
    biz_key: str = "",
) -> None:
    """落一条 RunningHub 用量记录 (幂等: 同 (biz_type, job_id) 只记一次)。

    取代此前的 `now - created_at` 反推口径: 排队时间不计入算力时长。
    见 rh_models 里为什么单开一张表而不是复用 image_billing。

    user_id 传 None 时从归属上下文兜底 —— 与 volc/billing.record_usage 同口径,
    这样 worker 进程 / 后台协程里发起的任务也能归到人头上。
    """
    attribution_source = ""
    if user_id is None:
        try:
            from ..factory.usage import get_usage_context
            _ctx = get_usage_context()
        except Exception:  # noqa: BLE001
            _ctx = {}
        user_id = _ctx.get("user_id")
        attribution_source = _ctx.get("source") or ("none" if user_id is None else "")
    else:
        attribution_source = "explicit"

    duration = 0.0
    if started_at and finished_at:
        duration = max(0.0, (finished_at - started_at).total_seconds())
    unit, _amount, _detail = pricing.estimate_upscale(duration)
    hours = duration / 3600.0

    try:
        async with session_scope() as s:
            dup = (await s.execute(
                select(RunninghubBilling.id).where(
                    RunninghubBilling.biz_type == biz_type,
                    RunninghubBilling.job_id == job_id,
                )
            )).first()
            if dup is not None:
                return
            s.add(RunninghubBilling(
                biz_type=biz_type, job_id=job_id, biz_key=(biz_key or "")[:200],
                user_id=user_id,
                attribution_source=attribution_source,
                rh_task_id=(rh_task_id or "")[:128],
                started_at=started_at, finished_at=finished_at,
                duration_sec=duration,
                unit="小时", quantity=hours, unit_price=unit, amount=hours * unit,
                status=status, detail=(detail or "")[:2000],
            ))
    except Exception as e:  # noqa: BLE001
        logger.warning("record_runninghub %s/%s failed: %s", biz_type, job_id, e)


def stable_biz_key(biz_type: str, biz_key: str) -> int:
    """把业务串散列成 31 位正整数, 用作 RunninghubBilling.job_id。

    给"没有单行作业表"的链路(frontcut 每段口播各是一次独立远端任务)用:
    同一个 (biz_type, biz_key) 永远得到同一个整数, 于是重放/重试不会重复记账,
    而不同段之间又不会撞车。用 blake2b 而非内置 hash() —— 后者带进程随机盐,
    跨进程/重启结果不一致, 做幂等键会失效。

    取 4 字节再右移一位 = 31 位正整数: 该列与其他 biz_type 用的作业主键同列
    (Integer/int32), 不必为一个散列值把列改成 bigint。碰撞面是同一 biz_type
    内的段数, 31 位下可忽略; 真撞了也只是少记一条, 且 biz_key 列留了原文可核对。
    """
    import hashlib
    h = hashlib.blake2b(f"{biz_type}\x00{biz_key}".encode("utf-8"), digest_size=4)
    return int.from_bytes(h.digest(), "big") >> 1


async def summary(*, user_id: Optional[int] = None) -> dict:
    """汇总: 总额 + 按 kind/model 拆分。user_id=None 表示全量 (管理员)。"""
    async with session_scope() as s:
        base = select(
            func.coalesce(func.sum(ImageBilling.amount), 0.0),
            func.count(ImageBilling.id),
        )
        if user_id is not None:
            base = base.where(ImageBilling.user_id == user_id)
        total_amount, total_count = (await s.execute(base)).one()

        # 按 model 拆分
        by_model_q = select(
            ImageBilling.model,
            func.coalesce(func.sum(ImageBilling.amount), 0.0),
            func.count(ImageBilling.id),
        )
        if user_id is not None:
            by_model_q = by_model_q.where(ImageBilling.user_id == user_id)
        by_model_q = by_model_q.group_by(ImageBilling.model)
        by_model = [
            {"model": m, "amount": round(float(a), 4), "count": int(c)}
            for (m, a, c) in (await s.execute(by_model_q)).all()
        ]

    return {
        "total_amount": round(float(total_amount), 4),
        "total_count": int(total_count),
        "by_model": by_model,
    }


async def list_records(
    *,
    user_id: Optional[int] = None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """明细列表 (倒序)。user_id=None 表示全量 (管理员)。"""
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    async with session_scope() as s:
        q = select(ImageBilling)
        cnt_q = select(func.count(ImageBilling.id))
        if user_id is not None:
            q = q.where(ImageBilling.user_id == user_id)
            cnt_q = cnt_q.where(ImageBilling.user_id == user_id)
        total = (await s.execute(cnt_q)).scalar() or 0
        q = q.order_by(ImageBilling.id.desc()).limit(limit).offset(offset)
        rows = (await s.execute(q)).scalars().all()
        items = [
            {
                "id": r.id, "job_id": r.job_id, "user_id": r.user_id,
                "kind": r.kind, "model": r.model, "unit": r.unit,
                "quantity": r.quantity, "unit_price": r.unit_price,
                "amount": r.amount, "detail": r.detail,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]
    return {"items": items, "total": int(total), "limit": limit, "offset": offset}