"""模型清单 / 健康探测 / 按人按模型的用量 —— 前端模型选择器的后端。

五组接口:
  GET  /v1/models/catalog        分组模型清单(带"稳"标)+ 默认值, 所有登录用户可读
  POST /v1/models/probe          触发一轮实测探测(管理员) —— "稳"标的刷新入口
  GET  /v1/models/usage          按人按模型的用量(自己的; 管理员可看全部)
  PUT  /v1/models/preference     设置/清除**我的**默认模型偏好
  GET/PUT /v1/models/platform-default  查看/设置**平台**默认模型(管理员)

## 默认模型的三级回落(2026-09-17)

    用户偏好(user_profiles.preferred_model)
      > 平台默认(system_settings 的 default_model:<provider>, 管理员可改)
        > env(LLM_REWRITE_MODEL 等)
          > 代码常量

前两级是这个模块的职责, 后两级在 catalog._default_model。之所以把"用户偏好"
放在路由层而不是 catalog 里: catalog 的 default_choice/is_allowed 被一堆
**没有 user 上下文**的地方调用(作业执行、参数校验), 那里只该看平台默认。

⚠ 兜底链对用户不可见: catalog 默认**不下发**渠道名和错误详情, 只给
  stable / channels_ok / channels_total。管理员加 ?detail=1 才看得到是哪家中转站
  挂了 —— 这是用户 2026-09-09 明确要求的("兜底逻辑不要对用户可见")。
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select

from ..auth.dependencies import get_current_user, require_admin
from ..auth.models import User
from ..db.session import get_session
from ..factory.usage import LlmUsageLog
from .catalog import (
    VENDORS,
    default_choice,
    default_model_sources,
    is_allowed,
    persist_default_model,
    split_provider_model,
)
from .health import catalog_with_health, run_probe_round

logger = logging.getLogger("model_routes")

router = APIRouter(prefix="/v1/models", tags=["models"])

_VENDOR_IDS = {p for p, _ in VENDORS}


async def _read_preference(user_id: int) -> str:
    """读用户的模型偏好; 没有/读失败都返回空串(= 用平台默认)。

    用 get_or_create_profile 而不是自己写 SQL —— 它已经处理了"profile 行还不存在"
    这种情况(agent/memory.py)。
    """
    try:
        from ..agent.memory import get_or_create_profile
        profile = await get_or_create_profile(user_id)
        return (profile.get("preferred_model") or "").strip()
    except Exception as e:  # noqa: BLE001
        # 迁移还没跑的库会在这里抛(无 preferred_model 列)。降级成"没有偏好",
        # 绝不能让模型清单整个 500 —— 那会让所有页面的模型下拉变空。
        logger.warning("读取用户 %s 的模型偏好失败(按无偏好处理): %s", user_id, e)
        return ""


@router.get("/catalog")
async def api_catalog(
    detail: bool = Query(False, description="管理员用: 附带每条渠道的明细"),
    user: User = Depends(get_current_user),
):
    """分组模型清单。前端下拉完全由这份数据驱动, 不要在前端写死任何型号。

    每个模型带:
      value          提交给各接口的 model 字段值, 形如 "gemini:gemini-3.8-flash"
      stable         "稳"标 —— 实测该模型配置的每条渠道都通(见 health.summarize)
      channels_ok/total  可用渠道数 / 配置渠道数
      reason         为什么稳/不稳, 供 tooltip
      note           已知坑的一句话提醒

    顶层 defaults 是**这个用户**的默认值: 他设过偏好就是他的偏好, 否则是平台默认。
    前端 resolveModelValue 直接消费 defaults, 不需要知道这一层是怎么算出来的。
    """
    allow_detail = detail and user.role in ("admin", "superadmin")
    groups = await catalog_with_health(include_channels=allow_detail)

    # 平台默认 —— 各页面的默认选择保持原样(草稿精修默认 gpt5、裂变默认 gemini 等),
    # 这里只给出"某 provider 的默认型号"供前端拼默认值
    defaults = {g["provider"]: default_choice(g["provider"]) for g in groups}

    # 叠加用户个人偏好: 只覆盖偏好里指定的那一个 provider, 其余仍走平台默认
    pref = await _read_preference(user.id)
    if pref:
        prov, mid = split_provider_model(pref)
        # 偏好里的型号可能已经下架了(清单是逐型号实测后维护的), 那就当没设过,
        # 否则用户会被永久钉在一个必崩的选项上, 且自己无从察觉
        if prov in defaults and mid and is_allowed(prov, mid):
            defaults[prov] = pref
        elif prov in defaults:
            logger.info("用户 %s 的模型偏好 %s 已不在清单内, 回落平台默认", user.id, pref)
            pref = ""

    return {
        "groups": groups,
        "defaults": defaults,
        # 让前端能区分"这是我自己设的"还是"平台给的", 以便在 UI 上标注
        "user_preference": pref or None,
        "platform_defaults": {g["provider"]: default_choice(g["provider"]) for g in groups},
    }


class PreferenceIn(BaseModel):
    """model 传 null / 空串 = 清除偏好, 回落平台默认。"""
    model: str | None = None


@router.put("/preference")
async def api_set_preference(payload: PreferenceIn, user: User = Depends(get_current_user)):
    """设置我的默认模型偏好(形如 "gemini:gemini-3.8-flash")。"""
    spec = (payload.model or "").strip()
    if spec:
        prov, mid = split_provider_model(spec)
        if prov not in _VENDOR_IDS:
            raise HTTPException(400, f"未知厂商: {prov}")
        if not mid:
            raise HTTPException(400, "偏好必须精确到型号, 形如 gemini:gemini-3.8-flash")
        if not is_allowed(prov, mid):
            raise HTTPException(400, f"型号不在可选清单内: {mid}")

    from ..agent.memory import update_profile
    if spec:
        await update_profile(user.id, preferred_model=spec)
    else:
        # update_profile 会忽略 None 值(见 agent/memory.py), 清除只能走裸 SQL
        from sqlalchemy import text as _sql
        from ..db import session_scope
        from ..agent.memory import get_or_create_profile
        await get_or_create_profile(user.id)
        async with session_scope() as s:
            await s.execute(
                _sql("UPDATE user_profiles SET preferred_model = NULL, updated_at = NOW()"
                     " WHERE user_id = :u"),
                {"u": user.id},
            )
    logger.info("用户 %s 设置模型偏好: %s", user.id, spec or "(清除)")
    return {"ok": True, "model": spec or None}


class PlatformDefaultIn(BaseModel):
    provider: str
    #: 传 null / 空串 = 清除该 provider 的平台覆盖, 回落 env
    model: str | None = None


@router.get("/platform-default")
async def api_get_platform_default(user: User = Depends(require_admin)):
    """每个 provider 的平台默认型号, 以及它来自 DB 还是 env。"""
    return {"providers": default_model_sources()}


@router.put("/platform-default")
async def api_set_platform_default(payload: PlatformDefaultIn,
                                   admin: User = Depends(require_admin)):
    """设置平台默认型号 —— 写 system_settings 并就地生效, **无需重启**。

    不校验型号是否在清单内(只校验厂商): 上游新模型常常先能调通、我们才补进清单,
    这时管理员应该能先把默认切过去。不在清单里的型号会被 catalog() 自动置顶补入,
    所以用户仍然选得到它。
    """
    prov = (payload.provider or "").strip()
    if prov not in _VENDOR_IDS:
        raise HTTPException(400, f"未知厂商: {prov}")
    mid = (payload.model or "").strip()
    if mid and ":" in mid:
        raise HTTPException(400, "这里只填型号(如 gemini-3.8-flash), 不要带 provider 前缀")
    await persist_default_model(prov, mid, getattr(admin, "id", None))
    return {"ok": True, "providers": default_model_sources()}


@router.post("/probe")
async def api_probe(
    provider: str | None = Query(None, description="只探某个厂商, 不传=全部"),
    stream_check: bool = Query(True, description="是否同时探流式"),
    user: User = Depends(require_admin),
):
    """立刻跑一轮实测探测并刷新"稳"标。

    探测**不记任何用户用量** —— 它走裸 httpx, 不经 get_llm 的 usage callback,
    属于平台运维开销, 不该记到谁头上。
    """
    res = await run_probe_round(
        providers=[provider] if provider else None, check_stream=stream_check)
    logger.info("管理员 %s 手动触发模型探测: %d 格", user.username, res.get("probed", 0))
    return {"ok": True, "probed": res.get("probed", 0), "channels_ok": res.get("ok", 0)}


@router.get("/usage")
async def api_usage(
    days: int = Query(30, ge=1, le=365),
    all_users: bool = Query(False, description="管理员用: 汇总所有用户"),
    user: User = Depends(get_current_user),
):
    """按人按模型的用量统计。

    ⚠ 目前**只出用量, 不出金额** —— 各中转模型的单价尚未确定(用户 2026-09-09:
    "由于目前没有单价, 先计算每个人每个模型的用量即可")。等单价确定后, 在这里
    乘一层价目表即可, 不需要改采集侧。
    """
    is_admin = user.role in ("admin", "superadmin")
    scope_all = all_users and is_admin
    since = datetime.utcnow() - timedelta(days=days)

    cols = [LlmUsageLog.provider, LlmUsageLog.model,
            func.count(LlmUsageLog.id).label("calls"),
            func.sum(LlmUsageLog.prompt_tokens).label("prompt_tokens"),
            func.sum(LlmUsageLog.completion_tokens).label("completion_tokens"),
            func.sum(LlmUsageLog.total_tokens).label("total_tokens")]
    group_cols = [LlmUsageLog.provider, LlmUsageLog.model]
    if scope_all:
        cols.insert(0, LlmUsageLog.user_id)
        group_cols.insert(0, LlmUsageLog.user_id)

    stmt = select(*cols).where(LlmUsageLog.created_at >= since)
    if not scope_all:
        stmt = stmt.where(LlmUsageLog.user_id == user.id)
    stmt = stmt.group_by(*group_cols).order_by(func.sum(LlmUsageLog.total_tokens).desc())

    async for session in get_session():
        rows = (await session.execute(stmt)).all()
        break

    names: dict[int, str] = {}
    if scope_all:
        uids = {r.user_id for r in rows if r.user_id}
        if uids:
            async for session in get_session():
                for u in (await session.execute(
                        select(User).where(User.id.in_(uids)))).scalars().all():
                    names[u.id] = u.display_name or u.username
                break

    items = []
    for r in rows:
        it = {
            "provider": r.provider, "model": r.model,
            "calls": int(r.calls or 0),
            "prompt_tokens": int(r.prompt_tokens or 0),
            "completion_tokens": int(r.completion_tokens or 0),
            "total_tokens": int(r.total_tokens or 0),
        }
        if scope_all:
            it["user_id"] = r.user_id
            # user_id 为空 = 该调用发生在没有登录上下文的后台链路; 如实标出,
            # 不要归到某个人头上
            it["username"] = names.get(r.user_id or -1, "(无归属)")
        items.append(it)

    return {
        "days": days, "scope": "all" if scope_all else "self",
        "items": items,
        "totals": {
            "calls": sum(i["calls"] for i in items),
            "total_tokens": sum(i["total_tokens"] for i in items),
        },
        "note": "当前只统计用量, 未计金额(各模型单价尚未确定)",
    }
