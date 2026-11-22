"""Agent 引擎的模型构造：按渠道建 ChatOpenAI，主渠道在前、其余作为兜底。

⚠️ 超时必须分开写：单值 timeout 会同时成为**连接**超时，一条连不上的渠道要拖满整个时长
才切换（2026-10-18 原型实测：主渠道不可达时等了 15 分钟）。连接 10 秒，读取 900 秒。
⚠️ 渠道顺序沿用平台 channels_for；不支持工具调用的渠道靠兜底中间件跳过。
"""
from __future__ import annotations

import os

import httpx
from langchain_openai import ChatOpenAI


class _ToolNameChatOpenAI(ChatOpenAI):
    """给 role=tool 的消息补上 name。

    langchain_openai 序列化工具结果时只带 tool_call_id 不带 name；部分中转把请求转成 Gemini 原生格式时
    要求 function_response.name 必填（2026-10-18 评测：gemini-3.8-flash 报
    "contents[8].parts[1].function_response.name: [REQUIRED_FIELD_MISSING]"，整轮运行失败）。
    按前面 assistant 消息里的 tool_calls 把 id 对回工具名。OpenAI 规范允许该字段，其它模型不受影响。
    """

    def _get_request_payload(self, input_, *, stop=None, **kwargs):  # noqa: ANN001
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)
        names: dict[str, str] = {}
        for m in payload.get("messages") or []:
            for tc in m.get("tool_calls") or []:
                if tc.get("id") and (tc.get("function") or {}).get("name"):
                    names[tc["id"]] = tc["function"]["name"]
            if m.get("role") == "tool" and not m.get("name") and m.get("tool_call_id") in names:
                m["name"] = names[m["tool_call_id"]]
        return payload

#: 默认模型。2026-10-19 按评测结论（docs/RESEARCH-Agent模型选型评测.md）从 claude-fable-5-1 换成
#: deepseek-v4-flash：短任务与长任务均通过、盲评第一梯队，自带提示缓存且价格低一个量级。
DEFAULT_MODEL = os.environ.get("AGENT_ENGINE_MODEL", "deepseek-v4-flash")

#: Agent 派发的**写作作业**（大纲 / 正文 / 剧本 / 精修 / 修复 / 去AI味 / 改编）默认用哪个模型。
#: 与 DEFAULT_MODEL 分开：一个是"Agent 怎么想"，一个是"稿子由谁来写"。
#: 用户在对话栏选了模型就用用户选的；没选用这个。
#: ⚠ 必须是 "厂商:型号" 写法：get_llm 把不带冒号的整串当厂商名（"deepseek-v4-flash" 会被当成一个
#: 不存在的厂商，落到默认分支走 gemini 的渠道）。
DEFAULT_WRITING_MODEL = os.environ.get("AGENT_WRITING_MODEL", "deepseek:deepseek-v4-flash")


def _provider_of(model: str) -> str:
    m = model.lower()
    for prefix, prov in (("claude", "claude"), ("gpt", "gpt5"), ("gemini", "gemini"), ("grok", "grok"),
                         ("deepseek", "deepseek"), ("kimi", "kimi"), ("glm", "glm"), ("qwen", "qwenapi"),
                         ("minimax", "mini"), ("doubao", "doubao")):
        if m.startswith(prefix):
            return prov
    return "claude"


#: 同一模型在不同渠道的**实际叫法**。2026-10-19 逐一探测（/models + 实调）：
#:   · 官方    只认 deepseek-flash / __REDACTED__，传 deepseek-v4-flash 会被别名接受并回显 deepseek-flash
#:   · kege    有 deepseek-v4-flash / deepseek-v4-1-flash
#:   · modelverse 只有 deepseek-v4.1-flash-1017（带点号），传 deepseek-v4-flash 直接 400
#: 不做这张表的话，"官方 + 中转兜底"里的中转那条路是**空转**的：官方一挂就整条链路失败。
#: 用户 2026-10-19 指出官方已更新为 DeepSeek-V4.1-Flash-1017，故兜底优先取明确带版本号的那个名字，
#: 而不是含义模糊的 deepseek-v4-flash。
_CHANNEL_MODEL_ALIAS: dict[str, dict[str, list[str]]] = {
    "deepseek": {
        # 官方 /models 只登记 deepseek-flash 与 __REDACTED__；deepseek-v4-flash 是别名。
        # 用登记名，少依赖一个未文档化的别名。
        "deepseek-v4-flash": ["deepseek-flash"],
    },
    # ⚠️ 2026-10-25: Kimi 的 3.1 系列**不在这里做降级别名**。
    # 两家中转都没上架 k3.1-pro / k3.1-pro-highspeed，而把它们映射到 k3 属于
    # 静默换模型（用户明确否掉：会让用户莫名觉得模型降智，用量口径也对不上）。
    # 正确做法在 models/llm.py 的 KIMI_CHANNEL_UNSUPPORTED —— 没有该型号的渠道
    # 整条不参与兜底，于是这些型号是单渠道（官方），官方挂了就明确失败。
    "kege": {
        "deepseek-v4-flash": ["deepseek-v4-flash", "deepseek-v4-1-flash"],
    },
    "modelverse": {
        "deepseek-v4-flash": ["deepseek-v4.1-flash-1017", "deepseek-v4-flash"],
    },
}


def model_on_channel(channel: str, model: str) -> str:
    """该渠道上应该下发的模型名（没有专门映射就原样下发）。"""
    if channel == "bailian":      # 百炼的叫法与主链路共用一处定义（models/llm.py::upstream_model）
        from ..models.llm import upstream_model
        return upstream_model(channel, model)
    cands = _CHANNEL_MODEL_ALIAS.get(channel, {}).get(model)
    return cands[0] if cands else model


def build_models(model: str | None = None) -> list[tuple[str, str, ChatOpenAI]]:
    """[(渠道名, 实际下发的模型名, LLM), ...]；全部渠道都不可用时抛错。

    宁可明确失败，也不静默降级到别的模型：用户选了哪个模型，用量记录里就该是哪个。
    """
    from ..models.catalog import split_provider_model
    from ..models.llm import channels_for, usage_callbacks
    model = model or DEFAULT_MODEL
    # 允许两种写法："deepseek-v4-flash"（引擎内部，按名字前缀判厂商）
    # 与 "deepseek:deepseek-v4-flash"（前端选择器的原生格式，厂商显式给出）
    provider, model_id = split_provider_model(model)
    if model_id is None:
        # 没有 "厂商:型号" 冒号写法时，按**模型名前缀**判厂商。
        # 🔴 2026-10-19: 这里曾写成"不在 (gpt5,gpt,qwenapi) 里就把整串当厂商名"，
        # 于是 provider="deepseek-v4-flash" 这个不存在的厂商落进 _primary_endpoint 的
        # 默认分支 → 拿到 zx1(gemini 的主渠道) → 每次先 503 model_not_found 再兜到 kege。
        # 症状是"能用但每次多一次失败调用、延迟多 2 秒"，日志里全是 zx1 失败行。
        provider = _provider_of(model)
        model_id = model
        if model_id == provider:          # 兜底：只给了厂商名，用该厂商的平台默认型号
            from ..models.catalog import _default_model
            model_id = _default_model(provider) or DEFAULT_MODEL
    # 各渠道是否支持该模型的工具调用因模型而异（2026-10-18 探测：modelverse 对 gpt-6 返回 400），
    # 不在这里写死白名单——不支持的渠道报错后由 ModelFallbackMiddleware 自动换下一条。
    chans = channels_for(provider, model_id)
    if not chans:
        raise RuntimeError(f"模型 {model_id} 没有可用的渠道")
    out = []
    for name, base, key in chans:
        real = model_on_channel(name, model_id)
        out.append((name, real, _ToolNameChatOpenAI(
            model=real, base_url=base, api_key=key, max_retries=1,
            timeout=httpx.Timeout(900, connect=10),
            callbacks=usage_callbacks(provider, model_id, channel=name),
        )))
    return out
