"""火山计费核心: 费率读取 + 高精度成本计算 + 落库。

计费口径:
- 成本(元) = total_tokens / 1_000_000 × unit_price_per_mtoken(元/百万token)
- 用 Decimal 全程高精度, 不做四舍五入(DB 列 Numeric 存多位小数)。
- 优先用火山返回的真实 usage.total_tokens; 缺失才按视频参数档位估算(is_estimated=True)。

model_key 说明:
- MK_VIDEO_UNDERSTAND: 视频理解/反推(seed2.1pro)
- 视频生成: 按"分辨率 × 输入是否含视频"拆 4 档(官方 doubao-seedance-2.0 分档定价)

火山官方 doubao-seedance-2.0 视频生成定价(2026-07 文档核对, 元/百万token):
- 480p/720p 输入不含视频: 46.00
- 480p/720p 输入含视频: 28.00
- 1080p 输入不含视频: 51.00
- 1080p 输入含视频: 31.00

doubao-seedance-2.0 等效 元/秒(16:9, 5秒, 含音频):
- 480p: 0.46 元/s
- 720p: 0.99 元/s
- 1080p: 2.48 元/s
"""
from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import select

from ..db import session_scope
from .models import VolcRateCard, VolcUsageRecord

logger = logging.getLogger("volc.billing")

# ============================================================
# model_key 常量
# ============================================================
# 视频理解 seed-2.1-pro: 官方在线推理按 输入/输出 分别计价(元/百万token):
#   输入(非音频) 6.00 / 输出 30.00 (输入长度[0,256]千token档, 覆盖我们所有反推)
# 因此拆成两条费率, 成本 = prompt_tokens×输入价 + completion_tokens×输出价。
MK_VIDEO_UNDERSTAND = "seed2.1pro-video-understand"              # 兼容旧记录(单一档, 已弃用)
MK_VIDEO_UNDERSTAND_IN = "seed2.1pro-video-understand-input"     # 输入 6.00
MK_VIDEO_UNDERSTAND_OUT = "seed2.1pro-video-understand-output"   # 输出 30.00

# 视频生成分档
MK_VIDEO_GEN_LOWRES_NOVID = "seedance-2.0-video-gen-480p720p-novideo"
MK_VIDEO_GEN_LOWRES_VID = "seedance-2.0-video-gen-480p720p-video"
MK_VIDEO_GEN_1080_NOVID = "seedance-2.0-video-gen-1080p-novideo"
MK_VIDEO_GEN_1080_VID = "seedance-2.0-video-gen-1080p-video"
MK_VIDEO_GEN_4K_NOVID = "seedance-2.0-video-gen-4k-novideo"
MK_VIDEO_GEN_4K_VID = "seedance-2.0-video-gen-4k-video"

# 兼容旧引用: 默认指向 480p/720p 不含视频
MK_VIDEO_GEN = MK_VIDEO_GEN_LOWRES_NOVID

# ============================================================
# 费率种子(元/百万token): 仅在表里不存在时插入, 已存在不覆盖
# ============================================================
_DEFAULT_RATES: dict[str, dict[str, Any]] = {
    # 视频理解 seed-2.1-pro 官方在线推理价(元/百万token, 输入长度[0,256]千token档):
    MK_VIDEO_UNDERSTAND_IN: {"label": "豆包视频理解 seed2.1pro · 输入", "price": Decimal("6.00"),
                             "note": "官方 2026-07: 输入(非音频) 6元/百万token"},
    MK_VIDEO_UNDERSTAND_OUT: {"label": "豆包视频理解 seed2.1pro · 输出", "price": Decimal("30.00"),
                              "note": "官方 2026-07: 输出 30元/百万token"},
    MK_VIDEO_GEN_LOWRES_NOVID: {"label": "Seedance2.0 480p/720p(不含视频输入)", "price": Decimal("46.00"),
                                 "note": "官方定价 2026-07: 46元/百万token"},
    MK_VIDEO_GEN_LOWRES_VID: {"label": "Seedance2.0 480p/720p(含视频输入)", "price": Decimal("28.00"),
                               "note": "官方定价 2026-07: 28元/百万token"},
    MK_VIDEO_GEN_1080_NOVID: {"label": "Seedance2.0 1080p(不含视频输入)", "price": Decimal("51.00"),
                               "note": "官方定价 2026-07: 51元/百万token"},
    MK_VIDEO_GEN_1080_VID: {"label": "Seedance2.0 1080p(含视频输入)", "price": Decimal("31.00"),
                             "note": "官方定价 2026-07: 31元/百万token"},
    # 4k: 官方公布 元/秒=5.05(5秒=25.27元), 但未单列"元/百万token"档;
    # 火山按 token 计费, 4k 的高成本主要体现在 token 数更大(分辨率越高每秒 token 越多)。
    # 单价档默认沿用高分档 51/31, token 数由火山返回体现 4k 差异。请管理员按官方账单核对。
    MK_VIDEO_GEN_4K_NOVID: {"label": "Seedance2.0 4k(不含视频输入)", "price": Decimal("51.00"),
                             "note": "官方未单列4k的元/百万token; 暂沿用高分档51, token数体现4k, 请核对"},
    MK_VIDEO_GEN_4K_VID: {"label": "Seedance2.0 4k(含视频输入)", "price": Decimal("31.00"),
                           "note": "官方未单列4k的元/百万token; 暂沿用高分档31, token数体现4k, 请核对"},
}

# ============================================================
# 兜底: 缺 usage 时按 分辨率×秒 估算 token 数
# 反推公式: token/s = (官方元/秒) / (元/百万token) × 1e6
#   480p: 0.46/46*1e6 ≈ 10000
#   720p: 0.99/46*1e6 ≈ 21522
#   1080p: 2.48/51*1e6 ≈ 48627
#   4k:  5.05/51*1e6 ≈ 99020
# ============================================================
_FALLBACK_TOKENS_PER_SEC = {
    "480p": 10000,
    "720p": 21522,
    "1080p": 48627,
    "4k": 99020,
    "2k": 70000,  # 2k 官方未单列; 取 1080p 与 4k 之间的近似兜底(仅在缺 usage 时用)
}


def resolve_video_gen_model_key(resolution: str, has_video_input: bool) -> str:
    """按 分辨率 + 是否含视频输入 选对应的视频生成费率 model_key。

    分辨率归一:
      - 含 "4k" / "2160" → 4k 档
      - 含 "2k" / "1440" → 归 1080p 档(官方未单列 2k, 就近取高分档; token 数体现差异)
      - 含 "1080" → 1080p 档
      - 其余(480p/720p) → 低分档
    """
    res = (resolution or "").lower()
    if "4k" in res or "2160" in res:
        return MK_VIDEO_GEN_4K_VID if has_video_input else MK_VIDEO_GEN_4K_NOVID
    if "1080" in res or "2k" in res or "1440" in res:
        return MK_VIDEO_GEN_1080_VID if has_video_input else MK_VIDEO_GEN_1080_NOVID
    return MK_VIDEO_GEN_LOWRES_VID if has_video_input else MK_VIDEO_GEN_LOWRES_NOVID


async def ensure_rate_cards_seeded() -> None:
    """启动时确保费率表里有默认记录(不存在才插, 已存在不覆盖)。"""
    try:
        async with session_scope() as s:
            for mk, info in _DEFAULT_RATES.items():
                row = (await s.execute(
                    select(VolcRateCard).where(VolcRateCard.model_key == mk)
                )).scalar_one_or_none()
                if row is None:
                    s.add(VolcRateCard(
                        model_key=mk,
                        label=info["label"],
                        unit_price_per_mtoken=info["price"],
                        note=info.get("note", ""),
                    ))
    except Exception as e:  # noqa: BLE001
        logger.warning("ensure_rate_cards_seeded failed(不阻断): %s", e)


async def _get_unit_price(model_key: str) -> Decimal:
    """取某 model_key 的当前单价(元/百万token)。缺失回退默认值。"""
    try:
        async with session_scope() as s:
            row = (await s.execute(
                select(VolcRateCard).where(VolcRateCard.model_key == model_key)
            )).scalar_one_or_none()
            if row and row.unit_price_per_mtoken is not None:
                return Decimal(str(row.unit_price_per_mtoken))
    except Exception as e:  # noqa: BLE001
        logger.warning("_get_unit_price failed for %s(用默认): %s", model_key, e)
    d = _DEFAULT_RATES.get(model_key)
    return d["price"] if d else Decimal("0")


def extract_usage(resp: Any) -> dict[str, int]:
    """从火山返回(dict)里提取 prompt/completion/total tokens。"""
    usage = None
    if isinstance(resp, dict):
        usage = resp.get("usage")
    else:
        usage = getattr(resp, "usage", None)
    if usage is None:
        return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    if not isinstance(usage, dict):
        usage = {
            "prompt_tokens": getattr(usage, "prompt_tokens", 0) or 0,
            "completion_tokens": getattr(usage, "completion_tokens", 0) or 0,
            "total_tokens": getattr(usage, "total_tokens", 0) or 0,
        }
    pt = int(usage.get("prompt_tokens") or 0)
    ct = int(usage.get("completion_tokens") or 0)
    tt = int(usage.get("total_tokens") or 0)
    if tt == 0 and (pt or ct):
        tt = pt + ct
    return {"prompt_tokens": pt, "completion_tokens": ct, "total_tokens": tt}


def _estimate_video_tokens(resolution: str, duration_sec: float) -> int:
    """返回缺 usage 时的视频生成 token 兜底估算。"""
    per = _FALLBACK_TOKENS_PER_SEC.get((resolution or "").lower(), _FALLBACK_TOKENS_PER_SEC["720p"])
    try:
        return int(per * float(duration_sec or 0))
    except Exception:  # noqa: BLE001
        return 0


async def record_usage(
    *,
    biz_type: str,
    model_key: str,
    user_id: Optional[int] = None,
    source: str = "",
    ep_id: str = "",
    request_id: str = "",
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    total_tokens: int = 0,
    resolution: str = "",
    duration_sec: float = 0,
    ratio: str = "",
    fps: int = 0,
    has_audio: bool = False,
    has_video_input: bool = False,
    draft_id: Optional[int] = None,
    extra: str = "",
) -> Optional[int]:
    """落一条火山用量+成本记录。返回记录 id(失败返回 None, 绝不抛出)。

    视频生成: model_key 会被 resolve_video_gen_model_key 覆盖为对应分辨率档费率 key。
    成本 = total_tokens / 1e6 × 对应档 单价。缺 usage 按参数档位估算(is_estimated)。

    ## 归属: 显式 kwarg 优先, 否则回退到调用上下文

    2026-09 复盘发现火山视频理解 1037 次调用**全部**无归属(28.1M token),
    根因是 `analyze_video_file` 明明收 user_id, 但 `video_pipeline` / `clip`
    两条链的调用方就是不传。逐个改调用点是一次性的, 且下一个新调用点还会忘。

    改为: 传了就用手上的值(更精确, 能覆盖上下文继承来的); 没传就从
    `factory.usage` 的归属上下文兜底 —— 该上下文由鉴权依赖或后台入口播种,
    `asyncio.create_task` 会复制它, 所以后台协程同样拿得到。

    `attribution_source` 记"这次归属从哪来", 便于日后再查缺口。
    """
    attribution_source = ""
    try:
        from ..factory.usage import get_usage_context
        _ctx = get_usage_context()
    except Exception:  # noqa: BLE001
        _ctx = {}
    if user_id is None:
        user_id = _ctx.get("user_id")
        attribution_source = _ctx.get("source") or ""
        if user_id is None:
            attribution_source = attribution_source or "none"
    else:
        attribution_source = "explicit"
    if draft_id is None:
        draft_id = _ctx.get("draft_id")

    try:
        is_estimated = False
        tt = int(total_tokens or 0)
        pt = int(prompt_tokens or 0)
        ct = int(completion_tokens or 0)

        # 视频理解: 官方按 输入/输出 分别计价, 成本 = 输入token×6 + 输出token×30 (元/百万token)
        if biz_type == "video_understand":
            in_price = await _get_unit_price(MK_VIDEO_UNDERSTAND_IN)
            out_price = await _get_unit_price(MK_VIDEO_UNDERSTAND_OUT)
            # prompt/completion 缺失时, 退化为按 total 用输入价估(不精确, 标估算)
            if pt == 0 and ct == 0 and tt > 0:
                cost = (Decimal(tt) / Decimal(1_000_000)) * in_price
                is_estimated = True
                unit_price = in_price
            else:
                cost = (Decimal(pt) / Decimal(1_000_000)) * in_price + \
                       (Decimal(ct) / Decimal(1_000_000)) * out_price
                # unit_price 字段存"加权综合单价"(便于展示); tt=0 时避免除零
                unit_price = (cost / (Decimal(tt) / Decimal(1_000_000))) if tt > 0 else in_price
            model_key = MK_VIDEO_UNDERSTAND_IN  # 记录归到视频理解(输入)档下, 展示用
            async with session_scope() as s:
                rec = VolcUsageRecord(
                    user_id=user_id, biz_type=biz_type, source=source or "",
                    model_key=model_key, ep_id=ep_id or "", request_id=(request_id or "")[:96],
                    prompt_tokens=pt, completion_tokens=ct, total_tokens=tt,
                    resolution="", duration_sec=Decimal("0"), ratio="", fps=0, has_audio=False,
                    unit_price_per_mtoken=unit_price, cost_cny=cost, is_estimated=is_estimated,
                    draft_id=draft_id, extra=(extra or "")[:2000],
                    attribution_source=attribution_source,
                )
                s.add(rec); await s.flush(); rid = rec.id
            logger.info("volc usage recorded id=%s biz=video_understand in=%s out=%s cost=%s",
                        rid, pt, ct, cost)
            return rid

        # 视频生成: 按 分辨率+是否含视频 选对应费率档
        if biz_type == "video_gen":
            model_key = resolve_video_gen_model_key(resolution, has_video_input)

        if tt <= 0 and biz_type == "video_gen":
            tt = _estimate_video_tokens(resolution, duration_sec)
            is_estimated = tt > 0

        unit_price = await _get_unit_price(model_key)
        cost = (Decimal(tt) / Decimal(1_000_000)) * unit_price

        async with session_scope() as s:
            rec = VolcUsageRecord(
                user_id=user_id,
                biz_type=biz_type,
                source=source or "",
                model_key=model_key,
                ep_id=ep_id or "",
                request_id=(request_id or "")[:96],
                prompt_tokens=int(prompt_tokens or 0),
                completion_tokens=int(completion_tokens or 0),
                total_tokens=tt,
                resolution=(resolution or "")[:16],
                duration_sec=Decimal(str(duration_sec or 0)),
                ratio=(ratio or "")[:16],
                fps=int(fps or 0),
                has_audio=bool(has_audio),
                unit_price_per_mtoken=unit_price,
                cost_cny=cost,
                is_estimated=is_estimated,
                draft_id=draft_id,
                extra=(extra or "")[:2000],
                attribution_source=attribution_source,
            )
            s.add(rec)
            await s.flush()
            rid = rec.id
        logger.info(
            "volc usage recorded id=%s biz=%s model=%s user=%s tokens=%s cost=%s est=%s",
            rid, biz_type, model_key, user_id, tt, cost, is_estimated,
        )
        return rid
    except Exception as e:  # noqa: BLE001
        logger.warning("record_usage failed(不阻断主业务): %s", e)
        return None