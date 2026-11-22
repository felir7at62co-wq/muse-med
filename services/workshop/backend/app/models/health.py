"""模型渠道健康度: "稳"标的事实来源。

## 为什么必须是**实测现算**, 不能写死

用户 2026-09-09 的要求原话: "给那些实测三渠道可用的模型标个'稳', 这个标不要
打死, 因为后面一旦有资源变化, 这个标也要随之变化"。

这条要求是有来历的。同一天的三渠道实测里, api4me 的 gemini 分组正在退化,
一天之内就出现三种不同的失败信号:

============================  ==================================
gemini-3.8-flash              分组下"无可用渠道"(根本没上架)
gemini-3.7-flash              "当前分组上游负载已饱和"(429)
gemini-3.1-flash-lite-preview "Consumer api_key 已被停用"(上游账号被封)
============================  ==================================

也就是说"哪些模型三渠道全通"是一个**每天都在变**的事实。写死在代码里的清单,
上线第二天就是错的, 而错的方向最糟 —— 用户看着"稳"标去选了一个实际只剩一条
渠道的模型。

## 两个信号叠加得出"稳"

1. **探测轮次**(本模块): 逐 (模型 × 渠道) 真发一次最小请求, 落库 model_channel_health。
   周期性跑 + 可手动触发。这是"资源面"的事实。
2. **运行时冷却**(llm.py 的 _COOLDOWN): 某模型在某渠道刚失败过就会进冷却。
   这是"此刻"的事实, 比上一轮探测新。

``稳`` = 该模型配置的**每一条**渠道在最近一轮探测里都通(且非流式/流式都通),
且此刻没有任何一条渠道处于冷却中, 且探测结果没有过期(MODEL_PROBE_TTL_HOURS)。
只配到一条渠道的模型**不发"稳"标** —— 它本来就没有兜底, 标"稳"是误导;
前端改为直接显示可用渠道数。(2026-09-09 起 deepseek 也接了中转兜底, 所以
"单渠道"不再等于"某个厂商", 而是逐模型看 channels_for 实际返回几条。)

## 探测为什么绕开 get_llm 直接用 httpx

要拿到 HTTP 状态码、上游回显的 model 名、以及"是否被静默替换"这些信息,
必须看原始响应体; 经过 langchain 包装后这些都被吞掉了。
副作用是探测**不产生用量记账** —— 这是有意的: 探测是平台自身的运维开销,
不该记到任何用户头上。

⚠ 并发: 探测用自己的小并发(MODEL_PROBE_CONCURRENCY, 默认 4), 这是一个新增的
运维任务, **不涉及也不改动**平台任何既有并发配置(遵并发铁律)。若探测本身
频繁撞 429, 正确解法是找中转站加 KEY / 提配额, 不是把业务并发降下来。
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timedelta

import httpx
from sqlalchemy import (
    Boolean, Column, DateTime, Integer, String, Text, UniqueConstraint, func, select,
)

from ..db.models import Base
from .catalog import RELAY_PROVIDERS, ModelSpec, all_specs, catalog, normalize_model
from .llm import channels_for, cooldown_snapshot, upstream_model

logger = logging.getLogger("model_health")

#: 探测用的最小提问 —— 短到几乎不花钱, 又能确认"真的跑起来了"而不只是握手成功
_PROBE_PROMPT = "只回复两个字: 就绪"
_PROBE_TIMEOUT = 45.0


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def probe_ttl_hours() -> int:
    """探测结果的保鲜期: 超过就不再据此标"稳"(宁可不标, 不可标错)。"""
    return _int_env("MODEL_PROBE_TTL_HOURS", 24)


class ModelChannelHealth(Base):
    """一个 (provider, model, channel) 三元组的最近一次探测结果。

    只保留最新一次(按三元组 upsert): 这张表是"当前状态"而非历史流水,
    历史趋势不是这个功能要解决的问题, 留着只会让表无限膨胀。
    """

    __tablename__ = "model_channel_health"
    __table_args__ = (
        UniqueConstraint("provider", "model", "channel", name="uq_model_channel"),
    )

    id = Column(Integer, primary_key=True)
    provider = Column(String(30), nullable=False, index=True)
    model = Column(String(100), nullable=False, index=True)
    channel = Column(String(30), nullable=False)
    ok = Column(Boolean, default=False)             # 非流式是否成功
    stream_ok = Column(Boolean)                     # 流式是否成功(None=未测)
    http_status = Column(Integer)
    latency_ms = Column(Integer)
    echo_model = Column(String(100), default="")    # 上游回显的模型名(归一后)
    echo_raw = Column(String(100), default="")      # 归一前的原始回显, 用于排查
    substituted = Column(Boolean, default=False)    # 归一后仍与请求不符 = 被静默换模型
    error = Column(Text)
    checked_at = Column(DateTime, nullable=False, server_default=func.now(), index=True)


# ---------------------------------------------------------------------------
# 探测
# ---------------------------------------------------------------------------

async def _probe_once(client: httpx.AsyncClient, base: str, key: str, model: str,
                      *, stream: bool) -> dict:
    """对一条渠道发一次最小请求, 返回原始判定材料(不抛异常)。"""
    t0 = time.monotonic()
    body = {
        "model": model,
        "messages": [{"role": "user", "content": _PROBE_PROMPT}],
        "stream": stream,
        # 刻意不传 max_tokens: 全局策略是不下发(见 llm.py), 探测也必须用同一套
        # 参数, 否则探出来的"能用"和业务真实调用不是一回事。
    }
    try:
        r = await client.post(
            f"{base.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=body,
        )
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "http": None, "ms": int((time.monotonic() - t0) * 1000),
                "echo": "", "err": f"{type(e).__name__}: {str(e)[:200]}"}

    ms = int((time.monotonic() - t0) * 1000)
    if r.status_code != 200:
        return {"ok": False, "http": r.status_code, "ms": ms, "echo": "",
                "err": _scrub(r.text, key)[:400]}

    if stream:
        # 流式只要求"确实吐出了至少一段内容" —— zx1 的 __REDACTED__ 曾出现
        # HTTP 200 但整段是拒绝语, 那种情况这里仍算通, 由 note 另行提示。
        text = r.text
        got = "data:" in text and ("delta" in text or "[DONE]" in text)
        return {"ok": got, "http": 200, "ms": ms, "echo": "",
                "err": "" if got else "流式响应里没有任何 delta 分片"}

    try:
        data = r.json()
    except ValueError:
        return {"ok": False, "http": 200, "ms": ms, "echo": "", "err": "响应不是 JSON"}
    choices = data.get("choices") or []
    content = ""
    if choices:
        content = ((choices[0].get("message") or {}).get("content") or "")
    if not content.strip():
        return {"ok": False, "http": 200, "ms": ms, "echo": data.get("model") or "",
                "err": "200 但正文为空"}
    return {"ok": True, "http": 200, "ms": ms, "echo": data.get("model") or "", "err": ""}


def _scrub(text: str, key: str) -> str:
    """错误正文里可能回显 key, 落库前抹掉(库和接口都不该出现凭据)。"""
    out = text or ""
    if key and len(key) > 6:
        out = out.replace(key, "<redacted>")
    return out


async def _probe_model_channel(client: httpx.AsyncClient, spec: ModelSpec,
                               chan: tuple[str, str, str], *, check_stream: bool) -> dict:
    name, base, key = chan
    # ⚠️ 2026-10-25: 这里直接探 spec.id —— 因为 _relay_channels 已经把
    # **没有上架该型号的渠道整条剔除**了，能走进这个函数的渠道都是能直接提供
    # 该型号名的。不需要（也不应该）在这里做任何型号替换：
    # 把 k3.1-pro 探成 k3 会得到一个假的"可用"，而实际调用发的是 k3.1-pro。
    # 例外只有"同一型号在该渠道的登记名不同"（百炼）：按 upstream_model 下发，与真实调用一致。
    sent = upstream_model(name, spec.id)
    plain = await _probe_once(client, base, key, sent, stream=False)
    raw_echo = plain.get("echo") or ""
    echo = normalize_model(raw_echo)
    # 归一之后仍然对不上 = 上游把请求换成了另一个模型(zx1 的 gemini-3.1-pro
    # → gemini-pro-agent 就是这种; 但那一组已被厂商确认同模型, 已进别名表)
    substituted = bool(echo and echo != spec.id)

    stream_ok = None
    if check_stream and plain["ok"]:
        stream_ok = (await _probe_once(client, base, key, sent, stream=True))["ok"]

    return {
        "provider": spec.provider, "model": spec.id, "channel": name,
        "ok": bool(plain["ok"]), "stream_ok": stream_ok,
        "http_status": plain["http"], "latency_ms": plain["ms"],
        "echo_model": echo, "echo_raw": raw_echo, "substituted": substituted,
        "error": (plain["err"] or "")[:1000] or None,
    }


async def run_probe_round(*, providers: list[str] | None = None,
                          check_stream: bool = True) -> dict:
    """跑一轮完整探测并落库, 返回本轮汇总。

    providers=None 表示全量(catalog 里的所有 provider)。
    """
    specs = [s for s in all_specs() if not providers or s.provider in providers]
    tasks: list[tuple[ModelSpec, tuple[str, str, str]]] = []
    for spec in specs:
        for chan in channels_for(spec.provider, spec.id):
            tasks.append((spec, chan))
    if not tasks:
        return {"probed": 0, "rows": [], "note": "没有可探测的渠道(检查 key 配置)"}

    sem = asyncio.Semaphore(_int_env("MODEL_PROBE_CONCURRENCY", 4))
    results: list[dict] = []

    async with httpx.AsyncClient(timeout=httpx.Timeout(_PROBE_TIMEOUT)) as client:
        async def one(spec: ModelSpec, chan: tuple[str, str, str]) -> None:
            async with sem:
                try:
                    results.append(await _probe_model_channel(
                        client, spec, chan, check_stream=check_stream))
                except Exception as e:  # noqa: BLE001 - 单格失败不能拖垮整轮
                    logger.warning("探测 %s@%s 异常: %s", spec.id, chan[0], e)
                    results.append({
                        "provider": spec.provider, "model": spec.id, "channel": chan[0],
                        "ok": False, "stream_ok": None, "http_status": None,
                        "latency_ms": 0, "echo_model": "", "echo_raw": "",
                        "substituted": False, "error": f"探测异常 {type(e).__name__}",
                    })

        await asyncio.gather(*[one(s, c) for s, c in tasks])

    await _save(results)
    ok = sum(1 for r in results if r["ok"])
    logger.info("模型健康探测完成: %d/%d 格可用", ok, len(results))
    return {"probed": len(results), "ok": ok, "rows": results}


async def _save(rows: list[dict]) -> None:
    """按 (provider, model, channel) upsert 最新结果。"""
    from ..db.session import get_session

    now = datetime.utcnow()
    async for session in get_session():
        for r in rows:
            existing = (await session.execute(
                select(ModelChannelHealth).where(
                    ModelChannelHealth.provider == r["provider"],
                    ModelChannelHealth.model == r["model"],
                    ModelChannelHealth.channel == r["channel"],
                )
            )).scalar_one_or_none()
            if existing is None:
                session.add(ModelChannelHealth(checked_at=now, **r))
            else:
                for k, v in r.items():
                    setattr(existing, k, v)
                existing.checked_at = now
        await session.commit()
        break


# ---------------------------------------------------------------------------
# 判定: 把探测结果 + 运行时冷却 合成对外的"稳"标
# ---------------------------------------------------------------------------

async def health_snapshot() -> dict[tuple[str, str], dict]:
    """(provider, model) → 健康摘要。没探测过的模型不会出现在返回里。"""
    from ..db.session import get_session

    rows: list[ModelChannelHealth] = []
    async for session in get_session():
        rows = list((await session.execute(select(ModelChannelHealth))).scalars().all())
        break

    fresh_after = datetime.utcnow() - timedelta(hours=probe_ttl_hours())
    cooling = cooldown_snapshot()
    out: dict[tuple[str, str], dict] = {}
    for r in rows:
        # ⚠️ 2026-10-25: 跳过"这条渠道已不再参与该型号兜底"的历史行。
        # 探测结果按 (provider, model, channel) upsert，渠道被剔除后旧行**不会**
        # 自动消失；不在这里过滤的话，summarize 会拿旧行去比对 configured_channels
        # （来自 channels_for，已剔除），出现 "ok/total=3/1" 这种自相矛盾的读数，
        # 而且那几条早已不用的渠道还会以"不可用"的身份挂在冷却统计里。
        # 判据与调用侧同源：channels_for(provider, model)。
        if r.channel not in {c[0] for c in channels_for(r.provider, r.model)}:
            continue
        key = (r.provider, r.model)
        entry = out.setdefault(key, {"channels": [], "checked_at": None})
        # 运行时冷却优先于探测结果: 冷却中说明"刚刚真的失败过", 比上一轮探测更新
        cd = cooling.get(r.channel) or cooling.get(f"{r.channel}:{r.model}")
        entry["channels"].append({
            "name": r.channel,
            "ok": bool(r.ok) and cd is None,
            "stream_ok": r.stream_ok,
            "latency_ms": r.latency_ms,
            "http_status": r.http_status,
            "substituted": bool(r.substituted),
            "echo_model": r.echo_model or "",
            "error": r.error or "",
            "cooling_down_sec": cd,
            "stale": bool(r.checked_at and r.checked_at < fresh_after),
        })
        if entry["checked_at"] is None or (r.checked_at and r.checked_at > entry["checked_at"]):
            entry["checked_at"] = r.checked_at
    return out


def summarize(provider: str, model: str, entry: dict | None,
              configured_channels: int) -> dict:
    """把一个模型的渠道明细压成前端要的几个字段。

    stable(即"稳"标)的判据 —— 四条**同时**满足:
      1. 该 provider 配了 >= 2 条渠道(单渠道无兜底可言, 不发"稳")
      2. 配置的每一条渠道在最近一轮探测里都通
      3. 非流式与流式都通(平台两种都在用, 只通一半不叫稳)
      4. 结果没过期、且此刻没有任何渠道在冷却中
    """
    total = configured_channels
    if not entry or not entry.get("channels"):
        return {"stable": False, "channels_ok": 0, "channels_total": total,
                "checked_at": None, "reason": "尚未探测", "channels": []}

    chans = entry["channels"]
    ok = [c for c in chans if c["ok"] and c["stream_ok"] is not False]
    stale = any(c["stale"] for c in chans)
    cooling = [c["name"] for c in chans if c.get("cooling_down_sec") is not None]

    # ⚠ reason 会**原样显示给普通用户**, 所以只说"几条线路", 绝不出现线路名:
    # 兜底走哪几家中转站属于内部信息(用户 2026-09-09 明确要求不可见)。
    # 管理端要定位到具体是哪条挂了, 看 channels 明细表即可, 那里本就带名字。
    if total < 2:
        reason = "单线路直连, 无跨线路兜底" if ok else "当前不可用"
        stable = False
    elif stale:
        reason = f"探测结果已超过 {probe_ttl_hours()} 小时, 需重新探测"
        stable = False
    elif cooling:
        reason = f"{len(cooling)} 条线路正在冷却(刚发生过失败)"
        stable = False
    elif len(ok) >= total and len(chans) >= total:
        reason = f"{total} 条线路实测全通"
        stable = True
    else:
        down = [c for c in chans if c not in ok]
        reason = f"{len(down)} 条线路当前不可用" if down else "线路覆盖不全"
        stable = False

    return {
        "stable": stable,
        "channels_ok": len(ok),
        "channels_total": total,
        "checked_at": entry["checked_at"].isoformat() if entry.get("checked_at") else None,
        "reason": reason,
        # 渠道明细只在管理端展示 —— 普通用户不该知道我们挂了哪几家中转站
        "channels": chans,
    }


async def catalog_with_health(*, include_channels: bool = False) -> list[dict]:
    """给前端的分组模型清单(带"稳"标)。

    include_channels=False 时**不下发渠道名与错误详情**: 兜底链对用户不可见
    (用户 2026-09-09 明确要求), 用户只需要知道"稳不稳、几条路通"。
    """
    from .catalog import VENDOR_LABEL

    snap = await health_snapshot()
    groups: list[dict] = []
    for provider, specs in catalog().items():
        items = []
        for spec in specs:
            total = len(channels_for(provider, spec.id))
            info = summarize(provider, spec.id, snap.get((provider, spec.id)), total)
            if not include_channels:
                info.pop("channels", None)
            items.append({
                "provider": provider,
                "model": spec.id,
                "value": f"{provider}:{spec.id}",
                "label": spec.label,
                "note": spec.note,
                **info,
            })
        groups.append({
            "provider": provider,
            "label": VENDOR_LABEL.get(provider, provider),
            "relay": provider in RELAY_PROVIDERS,
            "models": items,
        })
    return groups


# ---------------------------------------------------------------------------
# 周期探测(可选): 让"稳"标自己跟着资源变化走, 不用人去点
# ---------------------------------------------------------------------------

async def periodic_probe_loop() -> None:
    """后台循环。MODEL_PROBE_INTERVAL_MIN<=0 时直接退出(默认 360 分钟)。"""
    interval = _int_env("MODEL_PROBE_INTERVAL_MIN", 360)
    if interval <= 0:
        logger.info("模型健康周期探测已关闭 (MODEL_PROBE_INTERVAL_MIN<=0)")
        return
    # 启动后先等一会儿, 别和服务冷启动抢资源
    await asyncio.sleep(_int_env("MODEL_PROBE_START_DELAY_SEC", 90))
    while True:
        try:
            await run_probe_round()
        except Exception as e:  # noqa: BLE001 - 探测失败绝不能弄挂进程
            logger.warning("周期探测失败(忽略): %s", e)
        await asyncio.sleep(interval * 60)
