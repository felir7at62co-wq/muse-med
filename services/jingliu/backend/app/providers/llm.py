"""LLM Provider：走 OpenAI 兼容网关的 /chat/completions，**三中转站互为兜底**。

用于剧本优化、镜头拆解等文本阶段。默认模型取 settings.llm_model
（gemini-3.6-flash，三个中转站均实测可用）。

## 为什么要多渠道（2026-08 血泪）

zx1 账号余额跑成负数后，**所有**文本调用一律 403 `insufficient_user_quota`，
剧本导入的镜头拆解 100% 失败。而 api4me 上同一批模型完全正常——
两个中转站承载的是同一批模型、能力等价，本就该互为备份，
却因为代码里只写死了一条 base_url 而白白全挂。

故本模块把"渠道"抽象出来，任一渠道欠费 / 无可用渠道 / 5xx / 网络故障
自动切到下一条，只有**全部**渠道都失败才向上抛错。

## 渠道顺序：zx1 → api4me → modelverse

modelverse(UCloud) 于 2026-09 加入（与主平台 drama 对齐），排最后是
**成本考量**：单价明显高于前两家，定位是"前两条都挂了才用"的终极兜底。
它单 key 覆盖全部模型，没有 api4me 那种分组之分。

## 两把 api4me key 不可混用

api4me 的两把 key 属于不同分组，实测：
- `gemini-*`  → 只有 `api4me_gemini_api_key`（优质gemini 分组）能用，主 key 报 503 无可用渠道
- 非 gemini（如 gpt-5.5）→ 只有 `api4me_api_key` 能用，gemini key 报 503

所以选哪把 key 必须**按模型名自动判定**（`_api4me_key`），写错等于这条渠道白配。

## 冷却而非降并发

某渠道判定不可用后冷却 `llm_channel_cooldown` 秒，期间直接跳过，
避免高并发下每个请求都去撞一次死渠道白等一个 RTT。
⚠️ 这是"跳过已知坏渠道"，**不改任何并发数**（遵并发铁律）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass

import httpx

from ..config import get_settings
from . import http
from .local_fault import LocalResourceError, fd_usage, is_local_resource_error

logger = logging.getLogger("fw.llm")

# ⚠️ⓘ **关于"换个更好的模型"的落点（2026-09-11 记）**
#
# 本模块目前只发 `{model, messages, temperature, max_tokens}` —— 即最朴素的
# 补全请求，**没有用任何厂商的结构化输出能力**（`response_format` /
# JSON mode / tool use）。调用方因此都得自己容错剥 JSON（见
# `agent_proxy._parse_json` 与 `desktop/src/lib/agent/protocol.ts`）。
#
# 默认模型 `settings.llm_model`（gemini-3.6-flash）是**临时的当前最优**：
# 三条渠道共同上架、实测可用、单价合适，但属 flash 档。
# **将来出现更合适的模型时，值得做的不是只改模型名，而是同时把
# `response_format={"type":"json_object"}`（或该厂商的等价物）接进来** ——
# 那才是"接强模型"的完整收益，能把 JSON 合规从"提示词求它"变成"协议要求它"。
# 注意三点，别盲改：
#   ① 三条中转站对 `response_format` 的支持**不一致**，某条不支持可能直接 400，
#      所以它应当与渠道能力绑定（`build_channels` 里加标记），而不是无脑带上；
#   ② 它只对**要求 JSON 的那几个调用点**有用，剧本优化这类要散文的调用点
#      带上反而会让模型回一个被 JSON 包起来的段落；
#   ③ 改完必须把 `agent_proxy.py` / `protocol.ts` 的容错范围重新审一遍
#      —— 那时剥围栏可能已经是死代码。


@dataclass(frozen=True)
class Channel:
    """一个 OpenAI 兼容中转站。"""

    name: str
    base_url: str   # 已含 /v1，末尾无斜杠
    api_key: str
    #: 上游的型号名与我们的模型 id 不同时填（如百炼的 deepseek-v4.1-flash-1017）；空 = 原样发送。
    model: str = ""

    def payload_for(self, payload: dict) -> dict:
        """按本渠道的型号名改写请求体（不改调用方的 dict）。"""
        return {**payload, "model": self.model} if self.model else payload


class ChannelDown(Exception):
    """该渠道当前不可用（欠费/鉴权/无渠道/5xx/网络），应当切换到下一条。"""

    def __init__(self, msg: str, account_level: bool = False) -> None:
        super().__init__(msg)
        #: True = 账号级故障（欠费/鉴权），该渠道所有模型都别试了；
        #: False = 模型级故障（无可用渠道/404），同渠道其它模型照常走。
        self.account_level = account_level


def _raise_network_fault(e: Exception) -> None:
    """把网络类异常转成"渠道故障"或"本机故障"，**永远不会正常返回**。

    ⚠️ 2026-10-19：此前这里无条件 `raise ChannelDown(...)`，于是本地 fd 耗尽
    （`[Errno 24] Too many open files`）被当成渠道故障，把所有文本渠道一起写进
    冷却表。本地资源问题必须**不进冷却表**，否则故障会被我们自己放大。
    """
    if is_local_resource_error(e):
        logger.error("本机资源故障（非渠道问题）：%s | %s",
                     f"{type(e).__name__}: {e}", fd_usage())
        raise LocalResourceError(
            f"本机资源不足，请稍后重试（{type(e).__name__}: {e}）；"
            f"运行状态 {fd_usage()}", original=e,
        ) from e
    raise ChannelDown(f"网络异常 {type(e).__name__}: {e}") from e


# ---- 输出上限字段名：按模型选，且会"改口记住" ----
#
# 为什么需要这个：**字段名由模型决定，不是由渠道决定**。
# 实测（2026-10-10）：
#   gemini-3.6-flash      zx1/kege/modelverse 两种都收
#   gpt-6-sol / gpt-6-astra / gpt-5.6-*   只认 max_completion_tokens；
#                         带 max_tokens 会被 modelverse 直接 400
#                         "Unsupported parameter: 'max_tokens' is not supported
#                          with this model"
# 而 modelverse 是渠道链的**最后一道兜底**：带着错参数撞上去，等于前两条挂了
# 之后兜底也一起失效 —— 那正是这次要接的模型自己造成的。
#
# 两段式：
#   · `_max_tokens_key` 按模型名前缀**预测**。前缀是已知事实，省掉第一次报错重试。
#   · 真收到"不支持该参数"的 400 时，`_note_max_tokens_rejected` 记住正确字段名，
#     并**当场重发一次**。这一条才是关键：下个月再上架新模型（名字猜不到的），
#     不必等谁改代码，第一次调用自己就学会了。
#
# key 用模型名（不带渠道）：字段名是模型的属性，同一个模型换到哪条渠道都一样。
_MAXTOKENS_KEY: dict[str, str] = {}

#: 认 `max_completion_tokens` 的模型前缀。新发现的反例交给运行时自学习补。
_COMPLETION_TOKENS_PREFIXES = ("o1", "o2", "o3", "o4", "gpt-5", "gpt-6", "gpt-7")


# ---------------------------------------------------------------------------
# temperature：某些模型根本不接受这个参数
#
# ⚠️ 2026-11-10 修。生产日志实测（zx1 渠道）：
#
#     文本渠道 zx1:gpt-6-sol 判定不可用（模型级），冷却 120s：
#       HTTP 400: Unsupported parameter: 'temperature' is not supported with this model.
#
# 11-09 一天 337 次、11-10 49 次。后果不是"这次调用失败"这么轻：
#   · 每次调用先白撞一个 400，该渠道被整体冷却 120 秒；
#   · 提示词优化随后降级 —— 拿不到代码块就回退剧本原文，
#     而原文没有分镜节奏与口型约束，**这正是"吞台词/加戏/说话人错"的来源**。
#
# 与 max_tokens 同一套两段式：先按模型名预测，再从 400 自学习。
# key 用模型名（不带渠道）：能不能吃 temperature 是模型的属性。
_TEMPERATURE_SUPPORTED: dict[str, bool] = {}

#: 已知**不接受** temperature 的模型前缀。
#: gpt-5/gpt-6/gpt-7 系（o 系列同族）在新版网关上已把 temperature 删掉，
#: 改成只认 reasoning_effort。新发现的反例交给运行时自学习补。
_NO_TEMPERATURE_PREFIXES = ("o1", "o2", "o3", "o4", "gpt-5", "gpt-6", "gpt-7")


def _temperature_supported(model: str) -> bool:
    """该模型接不接受 `temperature` 参数。"""
    known = _TEMPERATURE_SUPPORTED.get(model or "")
    if known is not None:
        return known
    m = (model or "").lower()
    return not m.startswith(_NO_TEMPERATURE_PREFIXES)


def _learn_temperature_unsupported(model: str, error_body: str) -> bool:
    """从 400 响应里认出"该模型不吃 temperature"，记住并返回 True。

    ⚠️ 只认特征明确的错误（正文里出现 temperature 且带 unsupported / not supported）。
    别的 400 一律返回 False，否则会把一次无关报错记成"这个模型不要 temperature"，
    从此永久丢掉温度控制 —— 那不会报错，只会让输出变得不稳定。
    """
    body = (error_body or "").lower()
    if "temperature" not in body:
        return False
    if not ("unsupported" in body or "not supported" in body or "不支持" in body):
        return False
    if not _temperature_supported(model):
        return False                     # 已经是不发了，说明是别的问题
    _TEMPERATURE_SUPPORTED[model] = False
    logger.warning("模型 %s 不接受 temperature，已改为不下发该参数"
                   "（本次及后续调用生效）", model)
    return True


def _apply_temperature(payload: dict, model: str) -> None:
    """按模型能力决定要不要带 temperature（就地改 payload）。"""
    if not _temperature_supported(model):
        payload.pop("temperature", None)


def _max_tokens_key(model: str) -> str:
    """该模型该用哪个字段传输出上限。"""
    learned = _MAXTOKENS_KEY.get(model or "")
    if learned:
        return learned
    m = (model or "").lower()
    return ("max_completion_tokens" if m.startswith(_COMPLETION_TOKENS_PREFIXES)
            else "max_tokens")


def _learn_max_tokens_key(model: str, error_body: str) -> str | None:
    """从 400 响应里认出"该用哪个字段"，记住并返回；认不出返回 None。

    ⚠️ 只认这一种特征明确的错误。别的 400（参数越界、模型不存在…）一律返回 None，
    否则会把一次无关的报错记成"这个模型要用另一个字段名"，从此每次都发错。
    """
    body = (error_body or "").lower()
    if "max_completion_tokens" not in body or "max_tokens" not in body:
        return None
    if _max_tokens_key(model) == "max_completion_tokens":
        return None                      # 已经是它了，说明是别的问题
    _MAXTOKENS_KEY[model] = "max_completion_tokens"
    logger.warning("模型 %s 不接受 max_tokens，已改口用 max_completion_tokens"
                   "（本次及后续调用生效）", model)
    return "max_completion_tokens"


#: 输出上限**被明确拒绝**时用的探路值。比正常值小得多，只为确认参数名能被接受。
_PROBE_MAX_TOKENS = 512


# ---- 渠道健康度：key -> 冷却截止时刻（time.monotonic）----
# 进程内内存态即可：重启自动清空，多 worker 各自独立探测，无需共享存储。
# key 两种粒度：
#   "zx1"                  账号级（余额/鉴权）——该渠道整体跳过
#   "zx1:grok-4.5"         模型级（该渠道没上架这个模型）——只跳过这一个模型
_COOLDOWN: dict[str, float] = {}


def _mark_down(name: str, model: str, seconds: int, exc: ChannelDown) -> None:
    key = name if exc.account_level else f"{name}:{model}"
    _COOLDOWN[key] = time.monotonic() + seconds
    logger.warning("文本渠道 %s 判定不可用（%s），冷却 %ds：%s", key,
                   "账号级" if exc.account_level else "模型级", seconds, exc)


def _healthy(name: str, model: str) -> bool:
    now = time.monotonic()
    for key in (name, f"{name}:{model}"):
        until = _COOLDOWN.get(key)
        if until is None:
            continue
        if now >= until:
            _COOLDOWN.pop(key, None)   # 冷却到期，重新纳入探测
        else:
            return False
    return True


def _is_gpt(model: str) -> bool:
    m = (model or "").lower()
    return m.startswith("gpt") or m.startswith(("o1", "o2", "o3", "o4"))


def _zx1_key(model: str, s) -> str:
    """zx1 的 key：gpt 系文本模型优先用专用 key（用户实测更稳），其余走通用 key。

    专用 key 没配就回退通用 key —— 不配它时行为与改动前完全一致。
    gpt 判定与 `_kege_key` 的 gpt 分组同口径。
    """
    if _is_gpt(model) and getattr(s, "gateway_gpt_api_key", ""):
        return s.gateway_gpt_api_key
    return s.llm_api_key


def _kege_key(model: str, s) -> str:
    """kege 四把 key 分组不同，**按模型名自动判定**（写错等于这条渠道白配）。

    口径与主平台 drama 的 40e1c3b 一致：
      gemini-*           → gemini 分组
      gpt-* / o1-o4 系   → gpt 分组
      claude-*           → claude 分组
      其余（grok/deepseek…）→ grok 分组
    """
    m = (model or "").lower()
    if "gemini" in m:
        return s.kege_gemini_api_key or ""
    if "claude" in m:
        return s.kege_claude_api_key or ""
    if m.startswith(("gpt-", "gpt")) or m.startswith(("o1", "o2", "o3", "o4")):
        return s.kege_gpt_api_key or ""
    return s.kege_grok_api_key or ""


def _api4me_key(model: str, s) -> str:
    """api4me 两把 key 分组不同：gemini 系走 gemini key，其余走主 key。

    ⚠️ **2026-10-10 起 api4me 已从渠道链中移除**（全线 403 额度不足），
    本函数保留只为回滚与 ASR；文本/图像链不再调用它。
    """
    if "gemini" in (model or "").lower():
        return s.api4me_gemini_api_key or ""
    return s.api4me_api_key or ""


#: 我们对外的 DeepSeek Flash 模型 id（桌面端、飞书前台与服务端 Agent 用的都是它）。
DEEPSEEK_FLASH_MODELS = frozenset({"deepseek-flash"})


def build_channels(model: str, settings=None) -> list[Channel]:
    """按配置顺序构造该模型的可用渠道列表（key/base 缺失的渠道自动剔除）。"""
    s = settings or get_settings()
    catalog: dict[str, Channel] = {}
    zx1_key = _zx1_key(model, s)
    if s.llm_base_url and zx1_key:
        catalog["zx1"] = Channel("zx1", s.llm_base_url.rstrip("/"), zx1_key)
    # kege：2026-10-10 起的第二顺位（替换已失效的 api4me）。
    # base_url 未配则整条不存在（config 里不给默认值），与 modelverse 同款设计。
    kege_key = _kege_key(model, s)
    if s.kege_v1_base and kege_key:
        catalog["kege"] = Channel("kege", s.kege_v1_base, kege_key)
    # api4me：⚠️ 已停用（2026-10-09 起全线 403 额度不足）。**故意不再注册**——
    # 留在链里只会让每个请求白等一个 RTT 再切渠道。key 配置保留仅为回滚。
    # modelverse：单 key 覆盖全部模型，无分组之分。
    # 默认排最后（见 config.llm_channel_order）——单价高，只当终极兜底。
    if s.modelverse_v1_base and s.modelverse_api_key:
        catalog["modelverse"] = Channel(
            "modelverse", s.modelverse_v1_base, s.modelverse_api_key)

    order = [x.strip() for x in (s.llm_channel_order or "").split(",") if x.strip()]
    chans = [catalog[n] for n in order if n in catalog]
    # 配置顺序里没列到的渠道也追加进来，避免新增渠道忘了改 order 就静默失效
    chans += [c for n, c in catalog.items() if n not in order]
    # DeepSeek 自家模型走官方 API 优先（不受 llm_channel_order 影响：那张表管的是中转站之间的先后）。
    if (model or "").lower().startswith("deepseek") and getattr(s, "deepseek_api_key", ""):
        chans.insert(0, Channel("deepseek", (s.deepseek_base_url or "https://api.deepseek.com/v1").rstrip("/"),
                                s.deepseek_api_key))
    # DeepSeek Flash 再优先走阿里云百炼官方渠道（2026-11-05 用户裁定），排在 DeepSeek 官方之前。
    if (model or "").lower() in DEEPSEEK_FLASH_MODELS and getattr(s, "bailian_llm_api_key", ""):
        chans.insert(0, Channel("bailian", (s.bailian_llm_base_url or "").rstrip("/"), s.bailian_llm_api_key,
                                model=s.bailian_deepseek_flash_model))
    return chans


def _order_by_health(chans: list[Channel], model: str) -> list[Channel]:
    """健康的排前面；全在冷却中则保持原序（宁可撞一次也不能无渠道可用）。"""
    healthy = [c for c in chans if _healthy(c.name, model)]
    return healthy + [c for c in chans if c not in healthy] if healthy else chans


#: 已知**不支持** `tools` 的 (模型前缀, 渠道) 组合。命中的渠道会被整条剔除。
#:
#: 实测（2026-10-20，均为 400，非偶发）：
#:   gpt-6.1-sol @ modelverse → "Function tools with reasoning_effort are not supported"
#:       且连 `reasoning_effort=none` 都报 "Unsupported value"，无绕过路径
#:   gpt-6-sol   @ modelverse → 同上，但 `reasoning_effort=none` 可以过
#:
#: 不在这里剔掉的后果：每次工具调用都先撞一次 400 再切渠道。一轮 run 几十次
#: 调用，等于几十个白等的 RTT，且冷却表会被这些必然失败反复刷写。
_TOOLS_UNSUPPORTED: tuple[tuple[str, str], ...] = (
    ("gpt-6.1-sol", "modelverse"),
)

#: 已知**丢并行工具调用参数**的 (模型前缀, 渠道) 组合：一条回复里有两个及以上
#: tool_calls 时，每个的 arguments 都是空串；单个调用正常。命中的渠道排到最后。
#:
#: 实测（2026-10-30）：gpt-6-sol @ zx1 → 并行两个调用 arguments 均为 ''，流式与
#: 非流式一样，`parallel_tool_calls=false` 被忽略；同一请求 @ kege 参数完整。
#: 桌面端表现为模型反复收到"缺少 project_id"、一轮里连撞十次。
#:
#: 只排后不剔除：其它渠道全挂时，它的单个调用仍然可用，比无渠道强。
_PARALLEL_TOOL_ARGS_LOST: tuple[tuple[str, str], ...] = (
    ("gpt-6-sol", "zx1"),
    # 2026-10-30 同法实测：gpt-6.1-sol @ zx1 一样两个调用都没有参数（kege 完整）。
    ("gpt-6.1-sol", "zx1"),
)


def _agent_channels(model: str, settings=None) -> list[Channel]:
    """工具调用可用的渠道列表（= `build_channels` 剔掉已知不兼容的，丢并行参数的排到最后）。

    与 `build_channels` 分开而不是塞进去：那个函数服务全部文本调用，
    而"不支持 tools"只影响工具调用这一种用法，别的调用走 modelverse 照旧正常。
    """
    m = (model or "").lower()
    chans = build_channels(model, settings)
    banned = {ch for pre, ch in _TOOLS_UNSUPPORTED if m.startswith(pre)}
    kept = [c for c in chans if c.name not in banned]
    if len(kept) != len(chans):
        logger.info("工具调用已跳过不兼容渠道 %s（模型 %s）", sorted(banned), model)
    demoted = {ch for pre, ch in _PARALLEL_TOOL_ARGS_LOST if m.startswith(pre)}
    return [c for c in kept if c.name not in demoted] + [c for c in kept if c.name in demoted]


def _repair_tool_pairs(messages: list[dict]) -> list[dict]:
    """补上"发了 tool_calls 却没有对应 tool 结果"的那种消息对。

    ## 为什么必须补（2026-10-27 生产实测）

    生产日志 `文本渠道 kege:gpt-6.1-sol 判定不可用（模型级），冷却 120s：
    HTTP 400: No tool output found for function call fc_0b9cbf…`，随后
    「全部 2 个工具调用渠道均不可用」—— 一条**格式**问题被记成了"渠道挂了"，
    把唯一可用的渠道冷却 120 秒，用户看到的是整轮 agent 失败。

    触发路径不止一处：用户在等确认时**插话**（= 不批准，`graph` 用一个
    `AIMessage("用户没有批准…")` **替换**掉带 tool_calls 的那条 assistant 消息）、
    上一轮被停止、`_close_dangling_calls` 没覆盖到的边界。OpenAI 协议要求每个
    tool_call 后面紧跟一条 `role=tool`，缺一条整个请求 400。

    这里在**发出去之前**统一补齐：缺结果就补一条 `ok=false` 的占位结果，内容
    如实说明"这一步没有执行"。补而不是删：删掉 assistant 那条会连带丢掉模型
    说过的正文，而占位结果对下一轮推理是有用的信息。
    """
    if not messages:
        return messages
    answered: set[str] = set()
    for m in messages:
        if m.get("role") == "tool" and m.get("tool_call_id"):
            answered.add(str(m["tool_call_id"]))
    out: list[dict] = []
    for m in messages:
        out.append(m)
        if m.get("role") != "assistant":
            continue
        missing = [tc for tc in (m.get("tool_calls") or [])
                   if str(tc.get("id") or "") and str(tc.get("id")) not in answered]
        for tc in missing:
            out.append({"role": "tool", "tool_call_id": str(tc["id"]),
                        "content": json.dumps(
                            {"ok": False,
                             "error": "这一步没有执行（上一轮已停止或未获批准）"},
                            ensure_ascii=False)})
            answered.add(str(tc["id"]))
    return out


class LLMProvider:
    def __init__(self, model_id: str | None = None) -> None:
        self.settings = get_settings()
        # 解析顺序：显式传参 > 全局排障覆盖 > 通用缺省。
        # ⚠️ `llm_model_override` 只顶"没人点名"的情况 —— 显式传参优先级最高，
        # 否则排障开关会把"测某个模型"这类刻意指定的调用也一起劫持，
        # 让排障本身变得不可信。
        self.model_id = (model_id or self.settings.llm_model_override
                         or self.settings.llm_model)
        self.last_channel: str | None = None   # 实际出结果的渠道，便于排查/记 meta

    async def complete(self, system: str, user: str, temperature: float = 0.7,
                       allow_truncated: bool = False) -> str:
        """对话补全，跨渠道兜底。

        max_tokens 策略：协议上不存在"无限"取值，省略=网关默认（可能偏小）。
        故 FW_LLM_MAX_TOKENS>0 时显式带上，把输出上限顶到配置值（应设为
        模型输出硬上限附近）；=0 保持省略。
        截断检测：finish_reason=="length" 说明输出被拦腰截断（半截 JSON 的根因），
        默认直接报错让上层走分块/重试。**截断不是渠道故障，不触发换渠道**——
        换一条也是同样结果，白花一次钱。
        """
        payload: dict = {
            "model": self.model_id,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
        }
        # 某些模型（gpt-5/6/7、o 系列）不接受 temperature，发过去直接 400。
        # 见 `_temperature_supported` 的模块注释。
        _apply_temperature(payload, self.model_id)
        if self.settings.llm_max_tokens > 0:
            # 字段名按模型选（见 _max_tokens_key）。写死 max_tokens 会让
            # gpt-6-* 在 modelverse 上 400，兜底渠道当场失效。
            payload[_max_tokens_key(self.model_id)] = self.settings.llm_max_tokens

        chans = build_channels(self.model_id, self.settings)
        if not chans:
            raise RuntimeError(
                f"模型 {self.model_id} 没有任何可用文本渠道：请检查 FW_GATEWAY_API_KEY "
                f"与 FW_KEGE_* / FW_MODELVERSE_API_KEY 是否配置"
                f"（gemini 系模型必须配 kege 的 gemini 分组那把）。")

        errors: list[str] = []
        # 文本用 llm_timeout（不是 request_timeout）：gpt-6/gpt-5.6 实测 64~188s，
        # 120s 会让它们成批超时。见 config.llm_timeout。
        async with http.client("llm", timeout=self.settings.llm_timeout) as client:
            for ch in _order_by_health(chans, self.model_id):
                try:
                    content = await self._call(client, ch, payload, allow_truncated)
                    self.last_channel = ch.name
                    if errors:   # 前面有渠道失败过，记一笔便于事后追因
                        logger.info("文本渠道已切换到 %s（前序失败：%s）",
                                    ch.name, "；".join(errors))
                    return content
                except ChannelDown as e:
                    _mark_down(ch.name, self.model_id,
                               self.settings.llm_channel_cooldown, e)
                    errors.append(f"{ch.name} → {e}")
                    continue

        raise RuntimeError(
            f"全部 {len(chans)} 个文本渠道均不可用（模型 {self.model_id}）：{'；'.join(errors)}。"
            f"请检查各渠道余额/配额；若为限流，建议增加 API KEY 或提升配额，而非降并发。")

    async def _call(self, client: httpx.AsyncClient, ch: Channel,
                    payload: dict, allow_truncated: bool) -> str:
        """在单条渠道上完成一次调用，返回**文本内容**。

        渠道级故障抛 ChannelDown，内容级问题照常抛。
        只取 content —— 需要 tool_calls 的调用方请用 `_call_message`。
        """
        msg = await self._call_message(client, ch, payload, allow_truncated)
        return msg.get("content") or ""

    async def _call_message(self, client: httpx.AsyncClient, ch: Channel,
                            payload: dict, allow_truncated: bool) -> dict:
        """在单条渠道上完成一次调用，返回**完整的 message 对象**。

        `complete` / `complete_vision` / `chat_with_tools` 全部汇到这里，
        于是渠道切换、max_tokens 字段自学、用量记账、截断检测只有一份实现。

        ⚠️ 与工具调用的关系（2026-10-20）：`finish_reason == "tool_calls"` 是
        **正常结束**，不是截断。下面的判定只认 `== "length"`，别顺手改成
        `!= "stop"` —— 那会让每一次工具调用都被当成输出被截断而抛错。
        """
        url = f"{ch.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {ch.api_key}",
            "Content-Type": "application/json",
        }
        # 针对瞬时 429 限流做轻量指数退避重试（非降并发，仅容忍网关瞬时限流）；
        # 退避后仍 429 则判定该渠道当前不可用，换另一条——等于把压力分散到两个渠道。
        for attempt in range(3):
            try:
                resp = await client.post(url, headers=headers, json=ch.payload_for(payload))
            except (httpx.TimeoutException, httpx.TransportError) as e:
                _raise_network_fault(e)

            if resp.status_code == 429:
                if attempt < 2:
                    await asyncio.sleep(2 ** attempt)   # 1s, 2s
                    continue
                raise ChannelDown("持续 429 限流（本渠道重试 3 次）")

            if resp.status_code >= 400:
                # 「输出上限字段名不被接受」→ 当场学会正确字段名并**重发一次**。
                #
                # 这是本函数唯一一处"改参数重试"，加限定条件很关键：
                #   · 只在 400 且响应正文同时提到两个字段名时触发（_learn_max_tokens_key
                #     自己会判），别的 400 一律照常当渠道故障；
                #   · 每个模型终身只学一次（学会后 _max_tokens_key 直接命中）；
                #   · 探路值故意取小（_PROBE_MAX_TOKENS），万一判断有误，代价是
                #     一次很短的重发，而不是又一轮超长烧钱。
                # 不这么做的话：modelverse 是最后一道兜底，带错参数撞上去 = 前两条
                # 挂了之后彻底没有兜底，而这正是本次要接的模型自己造成的。
                if resp.status_code == 400 and not getattr(self, "_args_fixed", False):
                    _body = _err_text(resp)
                    _newkey = _learn_max_tokens_key(payload.get("model") or "", _body)
                    if _newkey:
                        self._args_fixed = True      # 只改一次，防死循环
                        payload.pop("max_tokens", None)
                        payload.pop("max_completion_tokens", None)
                        payload[_newkey] = _PROBE_MAX_TOKENS
                        resp = await client.post(url, headers=headers, json=ch.payload_for(payload))
                # 401/402/403 = 账号级（余额/鉴权）→ 整条渠道拉黑；
                # 其余（503 无可用渠道 / 404 无此模型 / 5xx）= 模型级，同渠道别的模型照常。
                if resp.status_code >= 400:
                    raise ChannelDown(f"HTTP {resp.status_code}: {_err_text(resp)}",
                                      account_level=resp.status_code in (401, 402, 403))

            try:
                data = resp.json()
                choice = data["choices"][0]
                msg = choice["message"]
                content = msg.get("content")
            except Exception as e:
                # 200 但结构不对 = 该渠道返回异常，换一条比原地失败更有机会成功
                raise ChannelDown(f"响应结构异常: {type(e).__name__} {str(e)[:120]}") from e

            # token 用量——放在截断判定**之前**：被截断的输出同样已计费。
            # （只统计、不计价：文本按用户操作收费，见 app/pricing.py）。
            # 这里是全项目**唯一**的真实文本上游出口，所有文本调用都汇到这里。
            _u = data.get("usage") if isinstance(data, dict) else None
            _u = _u if isinstance(_u, dict) else {}
            from .. import usage as _usage
            _usage.record("llm", model_id=payload.get("model"), channel=ch.name,
                          prompt_tokens=_u.get("prompt_tokens"),
                          completion_tokens=_u.get("completion_tokens"),
                          total_tokens=_u.get("total_tokens"))
            if choice.get("finish_reason") == "length" and not allow_truncated:
                raise RuntimeError(
                    f"LLM 输出被截断(finish_reason=length, 已输出{len(content or '')}字符)。"
                    "输入过长导致输出超上限，请缩短单次输入（拆解链路会自动分块）。"
                )
            # 把本次的用量挂回 message，供 agent 按 token 计费（见 chat_with_tools）。
            msg = dict(msg)
            msg["_usage"] = _u
            return msg

        raise ChannelDown("重试耗尽")   # 理论不可达，兜底防御

    # ------------------------------------------------------------ 工具调用

    def _payload_base(self, messages: list[dict], temperature: float) -> dict:
        p: dict = {"model": self.model_id, "messages": messages,
                   "temperature": temperature}
        if self.settings.llm_max_tokens > 0:
            p[_max_tokens_key(self.model_id)] = self.settings.llm_max_tokens
        # 工具调用这条路同样要按模型能力剔除（gpt-6 系不吃 temperature）
        _apply_temperature(p, self.model_id)
        return p

    async def chat_with_tools(self, messages: list[dict], tools: list[dict],
                              *, temperature: float = 0.2,
                              tool_choice: str = "auto",
                              allow_truncated: bool = True) -> dict:
        """带工具定义的一次对话，返回完整 message（含 `tool_calls`）。

        与 `complete` 走**完全相同的**渠道轮询与故障切换，只有两点不同：
          1. 请求里带 `tools` / `tool_choice`；
          2. 返回完整 message 而不是 content —— 工具调用时 `content` 常为空串。

        `allow_truncated` 默认 **True**：agent 的输出被截断时，正确的处置是让
        它下一轮接着说，而不是整轮失败（一轮 run 可能几十次调用，任何一次
        输出超长就抛错会让长任务永远做不完）。截断信息仍会回给调用方
        ——`finish_reason == "length"` 原样留在返回的 message 里。

        ## gpt-6.1-sol 不能走 modelverse

        实测（2026-10-20）：modelverse 对 `tools` + `reasoning_effort` 同时出现
        直接 400，且 gpt-6.1-sol 连 `reasoning_effort=none` 都拒绝（gpt-6-sol
        反而能过）。所以这里的渠道列表要剔掉已知不兼容的组合，否则每次调用都
        白撞一个 RTT 再切走。
        """
        payload = self._payload_base(_repair_tool_pairs(messages), temperature)
        payload["tools"] = tools
        payload["tool_choice"] = tool_choice

        chans = _agent_channels(self.model_id, self.settings)
        if not chans:
            raise RuntimeError(
                f"模型 {self.model_id} 没有任何可用的工具调用渠道："
                "请检查 FW_GATEWAY_API_KEY / FW_KEGE_* 是否配置"
                "（gpt-6.1-sol 只有 zx1 与 kege 两条，modelverse 不支持工具调用）")

        errors: list[str] = []
        async with http.client("llm", timeout=self.settings.llm_timeout) as client:
            for ch in _order_by_health(chans, self.model_id):
                try:
                    msg = await self._call_message(client, ch, payload,
                                                   allow_truncated)
                    self.last_channel = ch.name
                    if errors:
                        logger.info("工具调用渠道已切换到 %s（前序失败：%s）",
                                    ch.name, "；".join(errors))
                    return msg
                except ChannelDown as e:
                    _mark_down(ch.name, self.model_id,
                               self.settings.llm_channel_cooldown, e)
                    errors.append(f"{ch.name} → {e}")
                    continue

        raise RuntimeError(
            f"全部 {len(chans)} 个工具调用渠道均不可用（模型 {self.model_id}）："
            f"{'；'.join(errors)}")

    async def complete_vision(self, system: str, user: str, image_url: str,
                              temperature: float = 0.2) -> str:
        """多模态对话补全（文本+图片），跨渠道兜底。

        默认模型 gpt-5.6-terra（视觉任务专用，不走 settings.llm_model）。
        image_url 支持三种格式：
          1) data:image/png;base64,...  直接传 base64
          2) /fw/media/uploads/x.png    本地路径，自动转 data URI（**文件必须存在**，
                                       读不到直接抛，理由见下方）
          3) http(s)://...              外链，原样下发（网关自行拉取）
        """
        # 视觉模型固定 gpt-5.6-terra，不受 self.model_id 影响
        vision_model = "gpt-5.6-terra"

        # 本地路径 → data URI
        if image_url.startswith("/fw/media/") or image_url.startswith("/media/"):
            from ..media import ensure_local_async
            p = await ensure_local_async(image_url)
            # 解析不到或文件不在，必须**当场报错**，不能把这个相对路径原样下发。
            # 它对网关是一个取不到的地址，实测两种结局都很坏：
            #   ① 逐渠道超时重试，一次调用拖到几分钟才失败；
            #   ② 更糟——模型直接照着系统提示词**编**一段造型描述回来，
            #      调用方拿到的是一段"看上去很像"的假描述并落库，
            #      正是我们在修的"参考图与文字不一致→人物外观漂移"。
            # 图读不到时唯一正确的行为是失败，不是猜。
            if not (p and p.is_file()):
                raise RuntimeError(f"图片不存在或无法读取：{image_url}")
            import base64
            with open(p, "rb") as f:
                b64 = base64.b64encode(f.read()).decode()
            ext = p.suffix.lower().lstrip(".")
            mime = f"image/{ext if ext in ('png','jpeg','jpg','webp') else 'png'}"
            image_url = f"data:{mime};base64,{b64}"

        payload: dict = {
            "model": vision_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": [
                    {"type": "text", "text": user},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ]},
            ],
            "temperature": temperature,
        }
        if self.settings.llm_max_tokens > 0:
            payload["max_tokens"] = self.settings.llm_max_tokens
        # 视觉模型 gpt-5.6-terra 同样不吃 temperature（2026-11-10 实测 400）
        _apply_temperature(payload, vision_model)
        # ⚠️ 这一行是上面所有视觉调用的前提，**不能删**。fc11f53 加
        # `_apply_temperature` 时把它挤掉了，于是 dev 上每一次视觉调用都在
        # 下面 `if not chans` 处 NameError —— 去字幕识别、素材质检全挂，
        # 而模块能正常 import、py_compile 全绿，只有真跑起来才炸
        # （与 `_probe_wh` 那次同一个形态：惰性路径上的名字缺失）。
        chans = build_channels(vision_model, self.settings)
        if not chans:
            raise RuntimeError(
                f"视觉模型 {vision_model} 没有任何可用文本渠道：请检查 "
                "FW_GATEWAY_API_KEY / FW_API4ME_API_KEY 配置。")

        errors: list[str] = []
        async with http.client("llm-vision", timeout=self.settings.request_timeout) as client:
            for ch in _order_by_health(chans, vision_model):
                try:
                    content = await self._call(client, ch, payload, allow_truncated=False)
                    self.last_channel = ch.name
                    if errors:
                        logger.info("视觉渠道已切换到 %s（前序失败：%s）",
                                    ch.name, "；".join(errors))
                    return content
                except ChannelDown as e:
                    _mark_down(ch.name, vision_model,
                               self.settings.llm_channel_cooldown, e)
                    errors.append(f"{ch.name} → {e}")
                    continue

        raise RuntimeError(
            f"全部 {len(chans)} 个视觉渠道均不可用（模型 {vision_model}）：{'；'.join(errors)}。")


def _err_text(resp: httpx.Response) -> str:
    """把网关错误体压成一行可读信息（优先取 error.message）。"""
    try:
        body = resp.json()
        msg = (body.get("error") or {}).get("message") or body.get("message")
        if msg:
            return str(msg)[:200]
    except Exception:
        pass
    return (resp.text or "")[:200].replace("\n", " ")


async def channel_health(model: str | None = None) -> list[dict]:
    """逐渠道实测可用性（供运维/排查用，不写任何状态）。"""
    s = get_settings()
    m = model or s.llm_model
    out: list[dict] = []
    async with http.client("llm-health", timeout=60) as client:
        for ch in build_channels(m, s):
            item = {"channel": ch.name, "base_url": ch.base_url,
                    "cooling_down": not _healthy(ch.name, m)}
            try:
                r = await client.post(
                    f"{ch.base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {ch.api_key}"},
                    json=ch.payload_for({"model": m, "messages": [{"role": "user", "content": "ping"}],
                                         "max_tokens": 4}))
                item["status"] = r.status_code
                item["ok"] = r.status_code < 400
                if r.status_code >= 400:
                    item["error"] = _err_text(r)
            except Exception as e:
                item["ok"] = False
                item["error"] = f"{type(e).__name__}: {e}"
            out.append(item)
    return out
