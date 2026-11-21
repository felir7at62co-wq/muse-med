"""桌面端 Agent 的**大模型转发**。

```
GET  /v2/desktop-models/providers                可用模型目录
POST /v2/desktop-models/{provider}/chat/completions    OpenAI 兼容转发（支持 SSE + tools）
```

## 为什么必须服务端转发（用户裁定：大模型用服务器转发）

桌面客户端上**不放任何模型 key**。用户电脑上只有本人 7 天的织影会话 token：
吊销 = 服务端删会话；计费按人走织影积分。

muse-med 的做法是把平台管理员 token 发给每个客户端，那种东西一旦泄露，
等于把整个平台的生成额度交出去，且无法追溯是谁漏的。这里从架构上不存在这个问题。

## 与 `providers/llm.py` 的关系

那一层是**业务侧**出口（剧本优化、拆解、提示词构建），它的 `_call_message`
是非流式的、且把消息压成 `(system, user)` 两段。桌面 Agent 需要的是：
  · 原样的 `messages` 数组（含 `tool_calls` / `role=tool` 的历史）；
  · `tools` 定义；
  · **流式**增量（首字节时间决定体感，一轮对话几十秒不流式等于卡死）。

所以这里复用的是它的**渠道选择与健康度**（`build_channels` / `_order_by_health`
/ `_mark_down`），而不是它的请求组装。请求组装在这里重写一份是必要的——
两边要的东西本来就不同，硬套会让业务侧的封装多出一堆只为 Agent 服务的分支。

⚠️ 但**渠道冷却表是共享的**（process 内单例）：桌面端把某条渠道打挂，
业务侧的文本调用也会跳过它。这是对的——打挂是渠道的属性，不是调用方的属性。

## 流式与兜底的关系（唯一容易写错的地方）

**渠道兜底只在首字节到达之前生效。**

一旦开始往客户端推 SSE 增量，就不能再换渠道：换一条意味着前半段来自 zx1、
后半段来自 kege，用户会看到一句说到一半突然变了个说话风格的话，
而且 token 计费会把两次调用的用量混在一起。

所以：`_open_stream()` 负责"首字节前"的轮询与切换；拿到第一个
`data:` 片段就算成功，此后任何异常都只能把错误**写进流里**然后结束，
不能重试。
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .. import access
from ..config import get_settings
from ..providers.llm import (Channel, ChannelDown, _agent_channels, _mark_down,
                             _max_tokens_key, _order_by_health, build_channels)
from ..redact import redact_text

logger = logging.getLogger("fw.desktop_models")

router = APIRouter(prefix="/v2", tags=["desktop-models"])

#: 桌面端可选的模型（2026-10-30 用户裁定三档，默认 deepseek-flash）。
#: 要加模型改这里，客户端的模型清单（jingliu-edition 的 llm-pi-ai 行）同步改。
#:
#: `id` 必须与网关上的模型名**完全一致** —— 客户端会把它原样回传，
#: 而这里的路由按 `build_channels(model)` 选 key（kege 按模型名分四把 key，
#: 写错等于那条渠道白配，报错是"无可用渠道"而不是"模型名不对"）。
#:
#: `pricePerMTokenFen`：每百万 token（输入 + 输出合计）收多少分，结算与开跑前的余额检查都按它。
#: 渠道实测（2026-10-30，并行工具调用 + 看图 + 输出上限）：
#:   deepseek-flash   阿里云百炼（deepseek-v4.1-flash-1017，2026-11-05 起优先）→ DeepSeek 官方；各中转站 503/400
#:   gpt-6.1-sol      kege 完整；zx1 并行调用丢参数（已排后）
#:   claude-opus-5-5  只有 kege 有
#: `maxTokens`：单次回复的输出上限，桌面端按它截断（2026-11-02 实测各模型主渠道接受的上限：
#:   deepseek-flash / gpt-6.1-sol 131072 可用；claude-opus-5-5 65536 可用、131072 被 kege 拒）。
#:   此前三档都是 16384，长剧本整篇写入会被截断；后台任务（拆解、提示词）的 llm_max_tokens 不受影响。
_ALLOWED_MODELS: dict[str, dict] = {
    "deepseek-flash": {
        "id": "deepseek-flash",
        "name": "DeepSeek Flash",
        "contextWindow": 1048576,
        "maxTokens": 131072,
        "input": ["text", "image"],
        "reasoningEfforts": ["low", "medium", "high"],
        "pricePerMTokenFen": 200,
        "default": True,
    },
    "gpt-6.1-sol": {
        "id": "gpt-6.1-sol",
        "name": "GPT-6.1 Sol",
        "contextWindow": 256000,
        "maxTokens": 131072,
        "input": ["text", "image"],
        "reasoningEfforts": ["low", "medium", "high"],
        "pricePerMTokenFen": 800,
    },
    "claude-opus-5-5": {
        "id": "claude-opus-5-5",
        "name": "Claude Opus 5.5",
        "contextWindow": 200000,
        "maxTokens": 65536,
        "input": ["text", "image"],
        # 只接受自适应思考：kege 流式下把 low/medium/high 换成固定思考预算会 400（2026-10-31 实测）。
        "reasoningEfforts": [],
        "pricePerMTokenFen": 1800,
    },
}


def model_cost_fen(model: str, tokens: int | None) -> int:
    """这个模型用了 `tokens` 个 token 收多少分（不足 1 分向上取整）。

    @raises KeyError: 模型不在清单里（调用方都已先过 `_check_model`）。
    """
    import math
    per_m = int(_ALLOWED_MODELS[model]["pricePerMTokenFen"])
    return int(math.ceil(max(0, int(tokens or 0)) * per_m / 1_000_000))

#: 单次请求的输入上限（字符）。防的是一个坏掉的客户端把整本小说塞进来：
#: 按 token 计费的话那是真金白银，而这个端点不设闸门就等于不设上限。
_MAX_BODY_CHARS = 2_000_000

#: 图片按**张数**管，不按字符：一张 1.5 MB 的截图转成 base64 就是 200 万字符，而模型那边
#: 它只算一两千 token。此前把图片也计入字符上限，结果一张大图就让整轮 413，而客户端的
#: 上下文压缩按 token 判断、永远不会因为它触发（2026-10-31 用户实测「请求体过大」两连）。
#: 只保留最近这么多张，更早的换成一句占位文字（文字记录仍在，模型知道那里曾有图）。
_KEEP_IMAGES = 24
#: 保留下来的图片总量上限（字节，base64 后）。超过时从最早的开始继续换成占位。
_MAX_IMAGE_CHARS = 30_000_000
_IMAGE_PLACEHOLDER = "[较早的一张图片已省略以控制请求大小；需要时请重新读取]"


def _shrink_images(msgs: list) -> tuple[int, int]:
    """就地把较早的图片换成占位文字。返回 (保留张数, 省略张数)。"""
    slots = []          # (msg_idx, part_idx, chars)
    for i, m in enumerate(msgs):
        parts = m.get("content") if isinstance(m, dict) else None
        if not isinstance(parts, list):
            continue
        for j, part in enumerate(parts):
            if isinstance(part, dict) and part.get("type") == "image_url":
                url = (part.get("image_url") or {}).get("url") if isinstance(part.get("image_url"), dict) else ""
                slots.append((i, j, len(url or "")))
    keep, total = set(), 0
    for i, j, n in reversed(slots):          # 从最新的往前留
        if len(keep) >= _KEEP_IMAGES or total + n > _MAX_IMAGE_CHARS:
            break
        keep.add((i, j))
        total += n
    dropped = 0
    for i, j, _n in slots:
        if (i, j) not in keep:
            msgs[i]["content"][j] = {"type": "text", "text": _IMAGE_PLACEHOLDER}
            dropped += 1
    return len(keep), dropped


def _text_chars(body: dict) -> int:
    """请求的文字量：整个请求体去掉图片数据之后的字符数。"""
    def strip(x):
        if isinstance(x, dict):
            if x.get("type") == "image_url":
                return {"type": "image_url"}
            return {k: strip(v) for k, v in x.items()}
        if isinstance(x, list):
            return [strip(v) for v in x]
        return x
    return len(json.dumps(strip(body), ensure_ascii=False))


def _catalog() -> list[dict]:
    return list(_ALLOWED_MODELS.values())


def _check_model(model: str) -> str:
    m = (model or "").strip()
    if m not in _ALLOWED_MODELS:
        raise HTTPException(400, {
            "code": "model_not_allowed",
            "message": f"这个模型不在桌面端可用清单里：{m}",
            "allowed": sorted(_ALLOWED_MODELS),
        })
    return m


@router.get("/desktop-models/providers")
def list_providers() -> dict:
    """可用模型目录。

    ⚠️ **不回任何渠道信息**（base_url / key / 渠道名）。客户端只需要知道
    "有哪几个模型、能不能看图、上下文多长"。渠道名已经在 `/health` 里暴露，
    没必要再多一个泄漏面。
    """
    return {"providers": _catalog()}


def _estimate_precheck_fen(model: str) -> int:
    """开跑前的最低余额要求（分）。

    按"一次 16k token"、该模型的单价估一档。作用是**别让余额为 0 的人把一轮对话跑到
    一半才 402** —— 那种体验比一开始就拒绝更糟，而且前半段的钱已经花掉了。
    真正的计费在流结束时按实际 token 结算（见 `_settle`）。
    """
    return model_cost_fen(model, 16000)


#: 剧本平台在桌面端的工具名前缀（`agent_engine/tools.py` 的聚合工具）。
#: 客户端会把这些工具的定义原样放进请求的 `tools` 里，所以「这一轮带没带剧本工具」
#: 是一个**客观可见**的判据，不用信任客户端自报。
_SCRIPT_TOOL_PREFIX = "script_"


def _is_script_mode(body: dict) -> bool:
    """这一轮对话是不是「剧本」模式。

    ## 为什么要判、判了做什么（用户裁定 2026-11-11）

    剧本平台的文本生成**不计费**（`agent_engine/desktop.py` 的模块头：与网页一致，
    只记用量）。但驱动这些工具的那个 Agent 本身跑在本网关的模型上，原先按 token 扣
    织影积分 —— 于是只用剧本模式的编剧被卡在 402「额度已用尽」，连大纲都出不了。

    判据用工具名前缀而不是客户端自报的模式：客户端不必改、也不会因为漏传一个头就
    把免费用户变成收费用户。`script_` 前缀是剧本平台独有的（镜流模式带的是
    `jubian_*` / `drama_*`），误判风险为零。

    没有 `tools` 的轮次（比如开场那句寒暄）会按计费走，但那时用量只有几百分之一分，
    而且下一次带工具的调用就会切回免计费口径。
    """
    tools = body.get("tools")
    if not isinstance(tools, list):
        return False
    for t in tools:
        name = ""
        if isinstance(t, dict):
            fn = t.get("function")
            name = str((fn.get("name") if isinstance(fn, dict) else t.get("name")) or "")
        if name.startswith(_SCRIPT_TOOL_PREFIX):
            return True
    return False


def _settle(tokens: int, model: str, channel: str,
            prompt_tokens: int | None, completion_tokens: int | None,
            *, free: bool = False) -> int:
    """按实际 token 扣费并记流水。返回扣掉的分。

    按模型单价（`_ALLOWED_MODELS[*].pricePerMTokenFen`，输入 + 输出合计）。不套
    `charge_sync("reprompt")` 那 50 分/次的文本口径：那个是"用户点一次按钮"的业务操作价，
    而这里是 Agent 自己在思考 —— 一轮对话可能几十次调用，按次收会把用户收破产。

    `free=True`（剧本模式，用户裁定 2026-11-11）：照记用量、不扣分。
    """
    from .. import charge, usage

    usage.record("llm", model_id=model, channel=channel,
                 prompt_tokens=prompt_tokens,
                 completion_tokens=completion_tokens,
                 total_tokens=tokens)
    if free:
        # 用量台账照写：报表里要看得见剧本模式吃了多少 token，只是不从任何池扣。
        return 0
    fen = model_cost_fen(model, tokens)
    if fen <= 0:
        return 0
    try:
        return charge.charge_now("desktop_agent_llm", fen,
                                 desc=f"桌面 Agent 对话（{model}）")
    except charge.InsufficientCredit as e:
        # 已经跑完了才发现不够：**不能把结果收回**（内容已在客户端手上），
        # 只记日志。余额会走到负数，下次开跑前的前置检查会拦住。
        logger.warning("[desktop-models] 流结束后扣费失败（余额转负）：%s", e)
        return 0
    except Exception:  # noqa: BLE001 — 扣费失败不该让已经生成的回复丢失
        logger.warning("[desktop-models] 结算异常", exc_info=True)
        return 0


def _upstream_payload(body: dict, model: str) -> dict:
    """客户端的请求体 → 上游请求体。

    只放行**已知安全**的字段。不这么做的话，客户端可以塞任意键进来
    （`logprobs`、自定义 provider 扩展……），每一条都是我们白付一次的钱，
    而且有些会让上游 400。
    """
    s = get_settings()
    messages = body.get("messages") or []
    # `developer` 是 OpenAI 自家的角色；DeepSeek 官方直接 422（只认 system/user/assistant/tool）。
    # 新客户端已对非 OpenAI 模型改发 system，这里兜住老客户端与漏配的模型。
    if not model.startswith("gpt"):
        messages = [{**m, "role": "system"} if isinstance(m, dict) and m.get("role") == "developer" else m
                    for m in messages]
    p: dict = {"model": model, "messages": messages}
    if body.get("temperature") is not None:
        p["temperature"] = body["temperature"]
    # 输出上限：不信任客户端传的值（传 1M 就是想白嫖一次超长输出），一律用服务端的每模型上限
    # （`_ALLOWED_MODELS[model]["maxTokens"]`）；字段名按模型选（见 providers/llm.py 的教训）。
    # 按实际输出 token 计费，上限放大不会多收没用到的部分。
    cap = int(_ALLOWED_MODELS.get(model, {}).get("maxTokens") or s.llm_max_tokens or 0)
    if cap > 0:
        p[_max_tokens_key(model)] = cap
    for k in ("tools", "tool_choice", "response_format", "stop",
              "parallel_tool_calls", "reasoning_effort"):
        if body.get(k) is not None:
            p[k] = body[k]
    # 清单里没给推理档位的模型（Claude Opus 5.5）不转发 reasoning_effort：上游会 400。
    if not _ALLOWED_MODELS.get(model, {}).get("reasoningEfforts"):
        p.pop("reasoning_effort", None)
    # ⚠️ 流式必须原样转发：漏了 `stream`，上游按非流式回一整段 JSON，
    # 而这边按 SSE 透传 —— 客户端拿到的是一坨它解析不了的东西。
    # `include_usage` 必须强制打开：流式下上游只在末帧给 usage，不要就没有，
    # 按 token 结算就会恒为 0（白送）。
    if body.get("stream"):
        p["stream"] = True
        p["stream_options"] = {"include_usage": True}
    return p


async def _post_stream(ch: Channel, payload: dict, *, model: str):
    """在一条渠道上发起流式请求；**首字节前**的失败抛 ChannelDown。

    返回 `(response, client)` —— 调用方负责 `aclose()`。

    ⚠️ 这里是**唯一**不该换共享客户端的地方（2026-11-11 P0 统一改造时确认）。
    本函数把 client 交给调用方，由 `_relay` / 非流式分支在流结束时 `aclose()`。
    换成 `http.client(...)` 的共享池后，这次 `aclose()` 会把全站共用的连接池
    关掉，下一个请求直接报 `Cannot reopen a client instance`。

    代价可以接受：这是**每轮对话一次**（不是轮询），42 ms 的构造对几十秒的
    对话延迟是噪声。真正要治的是 TTS/生图/出片那些每任务几十上百次请求的路径，
    那些已经全部改走 `http.client()`。
    """
    client = httpx.AsyncClient(timeout=httpx.Timeout(
        connect=20.0, read=get_settings().llm_timeout, write=60.0, pool=20.0))
    url = f"{ch.base_url}/chat/completions"
    headers = {"Authorization": f"Bearer {ch.api_key}",
               "Content-Type": "application/json"}
    try:
        req = client.build_request("POST", url, headers=headers, json=ch.payload_for(payload))
        resp = await client.send(req, stream=True)
    except (httpx.TimeoutException, httpx.TransportError) as e:
        await client.aclose()
        raise ChannelDown(f"网络异常 {type(e).__name__}: {e}") from e

    if resp.status_code >= 400:
        try:
            text = (await resp.aread()).decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001
            text = ""
        await resp.aclose()
        await client.aclose()
        raise ChannelDown(f"HTTP {resp.status_code}: {text}",
                          account_level=resp.status_code in (401, 402, 403))
    return resp, client


@router.post("/desktop-models/{provider}/chat/completions")
async def chat_completions(provider: str, request: Request):
    """OpenAI Chat Completions 兼容转发。

    `provider` 路径段只为与客户端的多 provider 结构对齐；模型名以 body 里的
    `model` 为准（客户端的路由配置会把两者写成同一个值）。
    """
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(400, "请求体必须是 JSON 对象")
    msgs = body.get("messages")
    if not isinstance(msgs, list) or not msgs:
        raise HTTPException(400, "messages 不能为空")
    kept, dropped = _shrink_images(msgs)
    if dropped:
        logger.info("[desktop-models] 省略较早的图片 %d 张，保留最近 %d 张", dropped, kept)
    if _text_chars(body) > _MAX_BODY_CHARS:
        raise HTTPException(413, f"对话文字太长（超过 {_MAX_BODY_CHARS} 字）：请输入 /compact 压缩上下文，或新开一个对话")

    model = _check_model(str(body.get("model") or ""))

    # 剧本模式（带 script_* 工具）：免计费，也就不做余额预检 —— 余额 0 的编剧照样能写。
    free = _is_script_mode(body)
    if free:
        logger.info("[desktop-models] 剧本模式：本轮免计费（照记用量）")

    # 开跑前的前置余额检查：宁可一开始就拒，也不要跑到一半 402。
    from .. import charge
    need = _estimate_precheck_fen(model)
    uid = access.current_user_id()
    have = charge.my_available_fen(uid)
    # 管理员 `my_available_fen` 返回池余额（可能为 0），但他们无限额度。
    # 用 should_charge 判一下，避免把管理员挡在门外。
    allowed, _why = charge.should_charge("desktop_agent_llm", {})
    if allowed and uid and not free and have < need:
        raise HTTPException(402, {
            "code": "insufficient_credit",
            "message": f"积分不足：本次对话建议至少留 "
                       f"{need / 100:.2f} 元，当前 {have / 100:.2f} 元。",
            "need_fen": need, "have_fen": have,
        })

    payload = _upstream_payload(body, model)
    stream = bool(body.get("stream"))

    settings = get_settings()
    # 带工具的请求（Agent 的绝大多数轮次）走工具专用的渠道表：剔掉不支持 tools 的，
    # 丢并行调用参数的排到最后（见 providers/llm.py 的两张表）。
    chans = (_agent_channels(model, settings) if payload.get("tools")
             else build_channels(model, settings))
    if not chans:
        raise HTTPException(503, {
            "code": "no_channel",
            "message": f"模型 {model} 没有任何可用文本渠道（请检查服务端渠道配置）",
        })

    errors: list[str] = []
    resp = None
    client = None
    used: Channel | None = None
    for ch in _order_by_health(chans, model):
        try:
            resp, client = await _post_stream(ch, payload, model=model)
            used = ch
            if errors:
                logger.info("[desktop-models] 渠道已切换到 %s（前序失败：%s）",
                            ch.name, "；".join(errors))
            break
        except ChannelDown as e:
            _mark_down(ch.name, model, settings.llm_channel_cooldown, e)
            errors.append(f"{ch.name} → {e}")
            continue

    if resp is None or client is None or used is None:
        raise HTTPException(503, {
            "code": "all_channels_down",
            "message": f"全部 {len(chans)} 个渠道均不可用：{'；'.join(errors)}"
                       "（若为限流，请增加 API Key 或提升配额，而不是降并发）",
        })

    if stream:
        return StreamingResponse(
            _relay(resp, client, used, model, free=free),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    # ---- 非流式 ----
    try:
        raw = await resp.aread()
    finally:
        await resp.aclose()
        await client.aclose()
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        raise HTTPException(502, "上游返回了非 JSON 响应")

    u = data.get("usage") if isinstance(data, dict) else None
    u = u if isinstance(u, dict) else {}
    tot = int(u.get("total_tokens") or 0)
    _settle(tot, model, used.name, u.get("prompt_tokens"),
            u.get("completion_tokens"), free=free)
    return JSONResponse(data)


async def _relay(resp, client: httpx.AsyncClient, ch: Channel, model: str, *, free: bool = False):
    """把上游 SSE 原样转给客户端，同时累计 token 用于结算。

    ## 为什么是"原样转"而不是"解析后重组"

    客户端的 dsh 走的是 OpenAI 兼容协议，上游给的也是同一种格式。
    中间解析一遍再拼回去只会引入两类 bug（字段漏转、增量边界错位），
    而收益是零。这里只在旁边**顺带看**每个片段的 `usage`。

    ## 为什么异常不能再换渠道

    见模块头：一旦开始推增量，前半段已经到客户端了。换渠道会拼出
    "两个模型接力说完的一句话"，且用量会把两次调用算在一起。
    这里只把错误封成一条 `data:` 事件然后结束。
    """
    total = prompt = completion = 0
    try:
        async for chunk in resp.aiter_bytes():
            # 顺带统计：SSE 每行形如 `data: {...}`，usage 通常只在末帧出现
            if b'"usage"' in chunk:
                for line in chunk.split(b"\n"):
                    line = line.strip()
                    if not line.startswith(b"data:"):
                        continue
                    frag = line[5:].strip()
                    if not frag or frag == b"[DONE]":
                        continue
                    try:
                        obj = json.loads(frag)
                    except (ValueError, TypeError):
                        continue
                    u = obj.get("usage") if isinstance(obj, dict) else None
                    if isinstance(u, dict):
                        total = int(u.get("total_tokens") or total)
                        prompt = int(u.get("prompt_tokens") or prompt)
                        completion = int(u.get("completion_tokens") or completion)
            yield chunk
    except Exception as e:  # noqa: BLE001 — 流中途出错只能告知，不能重试
        logger.warning("[desktop-models] 流中途断开（%s）：%r", ch.name, e)
        err = {"error": {"message": redact_text(f"上游流中断：{type(e).__name__}: {e}"),
                         "type": "upstream_stream_error"}}
        yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n".encode()
    finally:
        try:
            await resp.aclose()
        finally:
            await client.aclose()
        _settle(total, model, ch.name, prompt, completion, free=free)
