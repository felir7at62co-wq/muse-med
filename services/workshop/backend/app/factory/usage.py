"""LLM Token 用量采集 — 工厂全链路记账。

在 LLM 调用出口拦截 usage_metadata 落库, 支撑按时间区间/阶段/模型/任务统计。
"""
from __future__ import annotations

import logging
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Integer, String, func

from ..db.models import Base

logger = logging.getLogger(__name__)


class LlmUsageLog(Base):
    """单次LLM调用的token用量记录"""
    __tablename__ = "llm_usage_logs"

    id = Column(Integer, primary_key=True, index=True)
    job_id = Column(Integer, index=True)          # 关联factory_job(可空:非任务调用)
    user_id = Column(Integer, index=True)
    stage = Column(String(50), index=True)        # brainstorm/outline/script/novel/tweet/check/...
    provider = Column(String(30))                 # gemini/qwen/...
    model = Column(String(100))                   # 实际模型名
    prompt_tokens = Column(Integer, default=0)
    completion_tokens = Column(Integer, default=0)
    total_tokens = Column(Integer, default=0)
    # 归属来源(""=历史行, 迁移前写入的): 见 set_usage_context 的 source 参数。
    # 用于把"链路根本没传人"与"这次调用天然无主"区分开 —— 前者是 bug, 后者是设计。
    attribution_source = Column(String(40), index=True)
    # 2026-10-18: 每次调用的渠道/耗时/成败(查长尾用); 失败的调用也落一行
    channel = Column(String(40))
    duration_ms = Column(Integer, index=True)
    ok = Column(Boolean, server_default="true")
    error = Column(String(300))
    # 2026-10-19: 提示缓存命中量（DeepSeek prompt_cache_hit_tokens / OpenAI prompt_tokens_details.cached_tokens）。
    # 查缓存是否真生效、核算换模型后的实际账单，只能靠这一列。
    cached_tokens = Column(Integer, default=0)
    created_at = Column(DateTime, nullable=False, server_default=func.now(), index=True)


def extract_usage(resp) -> dict:
    """从LangChain响应对象提取token用量(usage_metadata优先,response_metadata兜底)"""
    um = getattr(resp, "usage_metadata", None) or {}
    if um:
        return {
            "prompt_tokens": int(um.get("input_tokens") or 0),
            "completion_tokens": int(um.get("output_tokens") or 0),
            "total_tokens": int(um.get("total_tokens") or 0),
            # langchain 把缓存命中放在 input_token_details.cache_read；兼容自己构造的顶层 cached_tokens
            "cached_tokens": int((um.get("input_token_details") or {}).get("cache_read")
                                 or um.get("cached_tokens") or 0),
        }
    rm = getattr(resp, "response_metadata", None) or {}
    tu = rm.get("token_usage") or rm.get("usage") or {}
    return {
        "prompt_tokens": int(tu.get("prompt_tokens") or 0),
        "completion_tokens": int(tu.get("completion_tokens") or 0),
        "total_tokens": int(tu.get("total_tokens") or 0),
        "cached_tokens": int(tu.get("prompt_cache_hit_tokens")
                             or (tu.get("prompt_tokens_details") or {}).get("cached_tokens") or 0),
    }


#: 一次性告警去重(key=(provider, model, source)); 进程级, 重启清零。
_warned_unattributed: set = set()


def _warn_unattributed_once(*, provider: str, model: str, source: str,
                            user_id: int | None) -> None:
    """无归属时按 (provider, model, source) 只告警一次, 避免刷屏。

    为什么要有这个: 2026-09 的复盘里发现 16.7% 的 LLM 用量无法归到人,
    而当时**没有任何信号** —— 只能靠翻行为指纹(某小时全是同一个模型)反推。
    落一个 attribution_source + 打一条一次性 WARN, 下次缺口自己就冒出来了。
    """
    if user_id:
        return
    key = (provider, model, source)
    if key in _warned_unattributed:
        return
    _warned_unattributed.add(key)
    logger.warning(
        "LLM 用量无归属(首次): provider=%s model=%s source=%s "
        "— 该链路未设置归属上下文, 按人统计会漏掉这部分",
        provider, model, source or "(未标记)",
    )


async def log_usage(*, job_id: int | None, user_id: int | None, stage: str,
                    provider: str, model: str, resp,
                    attribution_source: str | None = None,
                    channel: str | None = None, duration_ms: int | None = None,
                    ok: bool = True, error: str | None = None) -> None:
    """记一笔LLM用量(失败静默,绝不影响业务)

    没有 token 数但有耗时/失败信息时也记(查长尾与渠道故障需要这些行)。
    """
    try:
        u = extract_usage(resp) if resp is not None else {"prompt_tokens": 0, "completion_tokens": 0,
                                                          "total_tokens": 0, "cached_tokens": 0}
        u.setdefault("cached_tokens", 0)
        if not u["total_tokens"]:
            u["total_tokens"] = u["prompt_tokens"] + u["completion_tokens"]
        if not u["total_tokens"] and duration_ms is None and ok:
            return
        if attribution_source is None:
            attribution_source = (_usage_ctx.get() or {}).get("source") or ""
        _warn_unattributed_once(provider=provider, model=model,
                                source=attribution_source, user_id=user_id)
        from ..db.session import get_session
        async for session in get_session():
            session.add(LlmUsageLog(
                job_id=job_id, user_id=user_id, stage=stage,
                provider=provider, model=model,
                attribution_source=attribution_source,
                channel=channel, duration_ms=duration_ms, ok=ok,
                error=(error or None) and str(error)[:300], **u,
            ))
            await session.commit()
            break
        # 同步累加到factory_job汇总字段
        if job_id:
            from sqlalchemy import select
            from .models import FactoryJob
            async for session in get_session():
                job = (await session.execute(
                    select(FactoryJob).where(FactoryJob.id == job_id)
                )).scalar_one_or_none()
                if job:
                    job.total_tokens = (job.total_tokens or 0) + u["total_tokens"]
                    job.prompt_tokens = (job.prompt_tokens or 0) + u["prompt_tokens"]
                    job.completion_tokens = (job.completion_tokens or 0) + u["completion_tokens"]
                    await session.commit()
                break
    except Exception as e:  # noqa: BLE001
        logger.debug(f"log_usage failed (ignored): {e}")

# ---------------------------------------------------------------------------
# 调用上下文: 工厂任务入口set一次, 嵌套LLM调用点(含stages/内部)都能拿到job/user
# asyncio任务创建时自动继承contextvars, 并发流水线互不串台
# ---------------------------------------------------------------------------
import contextvars

_usage_ctx: contextvars.ContextVar = contextvars.ContextVar("llm_usage_ctx", default=None)


def set_usage_context(job_id: int | None = None, user_id: int | None = None, *,
                      source: str = "", force: bool = False) -> None:
    """在后台任务/守护进程等**无请求上下文**的入口播种归属。

    常规 HTTP 链路不需要调它: ``auth/dependencies.py`` 的鉴权依赖已经
    ``set_usage_user`` 过了, 且 ``asyncio.create_task`` 会复制 contextvars,
    派生协程自动继承。这里只服务三类入口:
      1) 独立 worker 进程(novel_video.worker) — 整个进程没有请求上下文;
      2) 守护任务(feishu 写回 daemon、启动恢复) — 同上;
      3) 业务代码想显式指定比鉴权卡点更权威的归属。

    ## 为什么默认是"只补不冲"

    历史实现是无条件覆盖: ``set_usage_context(None, None)`` 会把已有归属抹掉。
    并发流水线里一旦有人这么调, 同一条链上后续调用就全变无主 —— 而且**无声**。
    现在 ``user_id``/``job_id`` 为 None 时保留现有值, 只有拿到真值才覆盖;
    确实要清空请显式 ``force=True``。

    ## source

    标记"这次归属是谁盖的章", 落到 ``llm_usage_logs.attribution_source`` /
    ``volc_usage_records.attribution_source``。排查归属缺口时可以一句
    ``SELECT attribution_source, count(*) ... GROUP BY 1`` 定位到具体链路,
    而不必再靠行为指纹反推。
    """
    ctx = dict(_usage_ctx.get() or {})
    if force:
        ctx = {}
    if user_id is not None:
        ctx["user_id"] = user_id
    if job_id is not None:
        ctx["job_id"] = job_id
    if source:
        ctx["source"] = source
    _usage_ctx.set(ctx)


def get_usage_context() -> dict:
    """读当前归属上下文(给 volc/billing 等非 LangChain 消费方用)。无则空 dict。"""
    return dict(_usage_ctx.get() or {})


def get_usage_user_id() -> int | None:
    """当前上下文里的 user_id(没有则 None)。"""
    return (_usage_ctx.get() or {}).get("user_id")


def set_usage_user(user_id: int | None) -> None:
    """只补 user_id, 不动 job_id / stage。

    在鉴权依赖里对**每个已登录请求**调一次, 这样非工厂链路(对话工坊、草稿页
    直接触发的生成等)的 LLM 调用也能归到人头上。
    在此之前只有 create_spawn / import_spawn 两条工厂链路 set 过上下文, 其余
    调用的 user_id 全是空 —— 用量表里那部分行等于**无法归属**, 按人计费直接落空。

    ⚠ 有值时**覆盖**而不是跳过: 鉴权依赖总是先于端点执行, 所以工厂链路随后
    调 set_usage_context 指定的归属仍然会赢(它更晚、更权威)。反过来若这里"有值
    就不覆盖", 万一某个上下文被复用, A 的调用会被记到 B 头上 —— 那是更坏的错。
    """
    if user_id is None:
        return
    ctx = dict(_usage_ctx.get() or {})
    if ctx.get("user_id") == user_id:
        return
    ctx["user_id"] = user_id
    # 只在没被业务代码显式标记过时盖章为"鉴权卡点", 否则会盖掉更精确的 source
    ctx.setdefault("source", "auth")
    _usage_ctx.set(ctx)


async def log_from_context(resp, *, provider: str, stage: str, model: str = "") -> None:
    """从上下文取job/user记一笔用量(无上下文也记,job_id为空)"""
    ctx = _usage_ctx.get() or {}
    await log_usage(job_id=ctx.get("job_id"), user_id=ctx.get("user_id"),
                    stage=stage, provider=provider, model=model, resp=resp)


def set_usage_stage(stage: str) -> None:
    """在当前asyncio任务内标记阶段(继承job/user,仅改stage)"""
    ctx = dict(_usage_ctx.get() or {})
    ctx["stage"] = stage
    _usage_ctx.set(ctx)


# ---------------------------------------------------------------------------
# Provider 健康登记(进程级内存, 重启清零) — 供工作台"AI资源"指示灯
# 数据来源: UsageCallbackHandler 的 on_llm_end(成功) / on_llm_error(失败)
# ---------------------------------------------------------------------------
_provider_health: dict = {}  # {provider: {ok, err, last_ok, last_err, last_err_msg}}


def record_provider_result(provider: str, *, ok: bool, err_msg: str = "") -> None:
    if not provider:
        return
    h = _provider_health.setdefault(provider, {
        "ok": 0, "err": 0, "last_ok": None, "last_err": None, "last_err_msg": "",
    })
    now_iso = datetime.utcnow().isoformat()
    if ok:
        h["ok"] += 1
        h["last_ok"] = now_iso
    else:
        h["err"] += 1
        h["last_err"] = now_iso
        h["last_err_msg"] = err_msg


def get_provider_health() -> dict:
    """返回各 provider 健康快照 + 判定状态: ok/error/idle"""
    out = {}
    now = datetime.utcnow()
    for prov, h in _provider_health.items():
        status = "ok"
        if h["last_err"]:
            err_dt = datetime.fromisoformat(h["last_err"])
            ok_dt = datetime.fromisoformat(h["last_ok"]) if h["last_ok"] else None
            # 最近10分钟内有错误且之后无成功 → error
            if (now - err_dt).total_seconds() < 600 and (ok_dt is None or ok_dt < err_dt):
                status = "error"
        out[prov] = {**h, "status": status}
    return out


try:
    from langchain_core.callbacks import AsyncCallbackHandler

    class UsageCallbackHandler(AsyncCallbackHandler):
        """全局LLM用量采集: 挂在get_llm上,覆盖所有调用点。
        从contextvars取job/user/stage; 非工厂调用(无上下文)job_id为空但仍记账。"""

        def __init__(self, provider: str = "", model: str = "", channel: str = ""):
            self.provider = provider
            self.model = model
            # 渠道名由 models.llm._relay_llm 构造每条渠道的回调时注入(zx1/kege/...)
            self.channel = channel
            self._t0: dict = {}   # run_id -> 开始时间(同一回调对象会被并发调用复用)

        def _start(self, run_id) -> None:
            import time as _time
            self._t0[run_id] = _time.monotonic()

        def _elapsed_ms(self, run_id) -> int | None:
            import time as _time
            t0 = self._t0.pop(run_id, None)
            return None if t0 is None else int((_time.monotonic() - t0) * 1000)

        async def on_chat_model_start(self, serialized, messages, *, run_id, **kwargs):  # noqa: ANN001
            self._start(run_id)

        async def on_llm_start(self, serialized, prompts, *, run_id, **kwargs):  # noqa: ANN001
            self._start(run_id)

        async def on_llm_error(self, error, *, run_id=None, **kwargs):  # noqa: ANN001
            try:
                record_provider_result(self.provider, ok=False, err_msg=str(error)[:200])
            except Exception:  # noqa: BLE001
                pass
            # 失败的调用也落一行(原先不入表): 渠道故障与超时长尾都在这里
            try:
                ctx = _usage_ctx.get() or {}
                await log_usage(
                    job_id=ctx.get("job_id"), user_id=ctx.get("user_id"),
                    stage=ctx.get("stage") or "other", provider=self.provider, model=self.model,
                    resp=None, channel=self.channel or None,
                    duration_ms=self._elapsed_ms(run_id), ok=False, error=str(error))
            except Exception as e:  # noqa: BLE001
                logger.debug(f"usage error-log failed (ignored): {e}")

        async def on_llm_end(self, response, *, run_id=None, **kwargs):  # noqa: ANN001
            duration_ms = self._elapsed_ms(run_id)
            try:
                record_provider_result(self.provider, ok=True)
            except Exception:  # noqa: BLE001
                pass
            try:
                usage = {}
                llm_output = getattr(response, "llm_output", None) or {}
                tu = llm_output.get("token_usage") or llm_output.get("usage") or {}
                if tu:
                    usage = {
                        "prompt_tokens": int(tu.get("prompt_tokens") or 0),
                        "completion_tokens": int(tu.get("completion_tokens") or 0),
                        "total_tokens": int(tu.get("total_tokens") or 0),
                    }
                if not usage or not usage.get("total_tokens"):
                    gens = getattr(response, "generations", None) or []
                    if gens and gens[0]:
                        msg = getattr(gens[0][0], "message", None)
                        um = getattr(msg, "usage_metadata", None) or {}
                        if um:
                            usage = {
                                "prompt_tokens": int(um.get("input_tokens") or 0),
                                "completion_tokens": int(um.get("output_tokens") or 0),
                                "total_tokens": int(um.get("total_tokens") or 0),
                            }
                if not usage:
                    usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                if not usage["total_tokens"]:
                    usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
                # 提示缓存命中量。三种来源按可用性取：
                #   · langchain 的 usage_metadata.input_token_details.cache_read（流式也走这条）
                #   · DeepSeek 官方 prompt_cache_hit_tokens
                #   · OpenAI 兼容 prompt_tokens_details.cached_tokens
                # 2026-10-19 实测：读错字段时 result 一直是 0，"缓存有没有生效"完全无法判断。
                hit = int(tu.get("prompt_cache_hit_tokens") or 0) if tu else 0
                if not hit and tu:
                    hit = int((tu.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
                if not hit:
                    for gens in (getattr(response, "generations", None) or []):
                        for g in gens or []:
                            um2 = getattr(getattr(g, "message", None), "usage_metadata", None) or {}
                            hit = int((um2.get("input_token_details") or {}).get("cache_read") or 0)
                            if hit:
                                break
                        if hit:
                            break
                ctx = _usage_ctx.get() or {}

                class _FakeResp:
                    usage_metadata = {
                        "input_tokens": usage["prompt_tokens"],
                        "output_tokens": usage["completion_tokens"],
                        "total_tokens": usage["total_tokens"],
                        "cached_tokens": hit,
                    }

                await log_usage(
                    job_id=ctx.get("job_id"), user_id=ctx.get("user_id"),
                    stage=ctx.get("stage") or "other",
                    provider=self.provider, model=self.model, resp=_FakeResp(),
                    channel=self.channel or None, duration_ms=duration_ms, ok=True)
            except Exception as e:  # noqa: BLE001
                logger.debug(f"usage callback failed (ignored): {e}")
except ImportError:
    UsageCallbackHandler = None  # type: ignore[assignment]
