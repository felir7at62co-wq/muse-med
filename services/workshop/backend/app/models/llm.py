"""LLM model registry - 支持多提供商切换 + 中转站双渠道兜底 + qwen fallback

模型:
- gemini (中转站代理) - 默认, "跨世界观模型"
- deepseek (官方直连优先, 两家中转垫后) - "通用模型"
- gpt5 (中转站上的 gpt-5.5) - "逻辑专项模型"
- claude / grok (中转站) - 编排大脑 / 短视频流水线
- qwen (阿里云百炼 dashscope 兼容 API) - 跨厂商 fallback 用

## 中转站双渠道兜底(2026-08 事故对策)

zx1 账号余额跑成负数后, **所有**走 zx1 的文本调用一律 403
`insufficient_user_quota`, 草稿生成 / 分镜拆解 100% 失败。而 api4me 上同一批
模型完全正常 —— 两个中转站承载的是同一批模型、能力等价, 本就该互为备份,
却因为代码里只写死一条 base_url 而白白全挂。

同时暴露出第二个隐患: zx1 上 `__REDACTED__` / `grok-4.5` 早已
503 "无可用渠道"(不是余额问题), 即超级 Agent 编排大脑一直是坏的,
接入 api4me 后一并恢复。

故 gemini/gpt5/claude/grok 四个"中转站类"provider 统一返回
`ChannelFallbackLLM`: 按渠道顺序尝试, 任一渠道欠费/无渠道/5xx/网络故障
自动切下一条, 全挂才抛错。

### deepseek 也接上兜底了(2026-09-09)

原先 deepseek 是裸 `ChatOpenAI` 单线直连官方, 理由是"不同厂商, 本就独立"。
但 2026-09-09 逐模型实测发现: **两家中转都上架了 deepseek 系**
(v4-pro / v4-flash / 带日期的快照 / v3.2 共 10 个 (模型×线路) 组合可用),
即官方一抽风时明明有现成的替代路径, 代码却让整条 deepseek 链路陪葬。

现改为 `官方直连 → kege → modelverse`(2026-10-09 前第二顺位是 api4me)。**官方必须排第一**: 实测它中位延迟
0.9s(中转 1.8~4.3s)且单价最低, 中转只是"官方挂了才走"的备胎, 不是分流。
顺序由 `_relay_channels` 里 primary 永远居首保证, 见那里的 order 例外说明。

qwen(百炼)仍保持单线不包装 —— 它本身就是 `ainvoke_with_fallback` 里
**跨厂商**的最后一道保险, 再给保险上保险没有意义。

### kege 替换 api4me(2026-10-09)
api4me 已全线失效(实测 6 个主力模型全部 403"额度不足"或 503"无可用渠道"),
第二顺位换成 kege(vip.kegeai.top)。渠道名仍由 base_url 推出, 叫 `kege`。
⚠ 它与 2026-08 失联的 ai.kegeai.top 疑为同一家换了域名 —— 有过整体失联的前科,
  所以它只当第二顺位, modelverse 仍保留做最后一道防线。

### 四把 kege key 按厂商分组, 不可混用
- `gemini-*` → `KEGE_GEMINI_API_KEY`; `gpt-*` → `KEGE_GPT_API_KEY`
- `claude-*` → `KEGE_CLAUDE_API_KEY`(该分组**只有** claude 系 19 个模型)
- 其余(grok / deepseek / …) → `KEGE_GROK_API_KEY`
所以选哪把 key 必须**按模型名自动判定**(`_kege_key`), 写错等于这条渠道白配。
实测已知坑: 该渠道的 gpt-5.5 长文稳定返回空内容、短问答 140~190s, 真正兜住 gpt-5.5
的是 modelverse; 其余在用模型(gemini/claude/grok/deepseek/gpt-5.6-sol)长文均能写完。

### 冷却而非降并发
某渠道判定不可用后冷却 `LLM_CHANNEL_COOLDOWN` 秒, 期间直接跳过, 避免高并发下
每个请求都去撞一次死渠道白等一个 RTT。
⚠ 这是"跳过已知坏渠道", **不改任何并发数**(遵并发铁律)。
"""
from __future__ import annotations

import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlparse

from langchain_openai import ChatOpenAI

from ..config import get_settings
from .catalog import (
    _env_default_model,
    is_allowed,
    platform_override,
    split_provider_model,
)

#: 第三方厂商分组 —— 它们原本没有官方直连、只有 kege 与 modelverse 两家中转，
#: 故在 get_llm 里走单独一条分支（见该分支里的说明）。
#: 与 catalog.VENDORS 里的对应项必须保持一致。
#:
#: ⚠️ 2026-10-25：**kimi 已从本集合移除** —— 它现在有 Moonshot 官方直连
#: （KIMI_API_KEY / KIMI_BASE_URL），走"官方优先 + 两家中转兜底"的常规 relay 分支，
#: 与 deepseek 的模式一致（见 get_llm 里 kimi 分支）。留在本集合会让它继续走
#: "没有主渠道"那条，官方直连永远不会被用到。
_THIRD_PARTY_PROVIDERS = frozenset({"mini", "glm", "qwenapi", "doubao"})

logger = logging.getLogger("llm")

Role = Literal["generate", "rewrite", "extract", "summary", "orchestrator"]
#: 合法 provider id 的**声明性**清单（供阅读与 IDE；实际校验走 catalog.is_allowed）。
#: 2026-10-10 补上五个第三方分组，与 catalog.VENDORS 保持一致。
#: ⚠️ "qwen" 是 dashscope 官方直连的**跨厂商保险**（不是用户可见分组，用户看到的
#: "通义千问" 是 "qwenapi"，见 catalog.VENDORS 的撞名说明）。
Provider = Literal[
    "gemini", "deepseek", "gpt5", "qwen", "claude", "grok",
    "mini", "kimi", "glm", "qwenapi", "doubao",
]
#: provider 参数从 2026-09-09 起额外接受 "provider:model" 形式(如
#: "gemini:gemini-3.8-flash"), 让用户选中的具体型号能穿过几十层 stage 函数
#: 而不用给每个函数补参数。解析只发生在 get_llm 一处, 详见 catalog.py 的说明。
ProviderSpec = str


# ---------------------------------------------------------------------------
# 中转站渠道兜底
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class _Chan:
    """一个 OpenAI 兼容中转站。"""

    name: str
    base_url: str
    api_key: str
    #: 上游的型号名与我们的模型 id 不同时填（百炼的 deepseek-v4.1-flash-1017）；空 = 原样下发。
    model: str = ""


#: 走阿里云百炼官方渠道的 DeepSeek Flash 模型 id（2026-11-05 用户裁定：该渠道优先）。
_BAILIAN_DEEPSEEK_FLASH_IDS = frozenset({"deepseek-v4-flash", "deepseek-flash"})


def _bailian_channel(model: str) -> "_Chan | None":
    """阿里云百炼官方渠道；只服务 DeepSeek Flash，没配 BAILIAN_LLM_API_KEY 就不存在。

    ⚠ 与 qwen 用的 DASHSCOPE_API_KEY 分开：那把是 qwen 的，这把是用户为 DeepSeek Flash 单独给的。
    """
    key = os.environ.get("BAILIAN_LLM_API_KEY", "")
    if (model or "").lower() not in _BAILIAN_DEEPSEEK_FLASH_IDS or not key:
        return None
    base = os.environ.get("BAILIAN_LLM_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
    return _Chan("bailian", base.rstrip("/"), key,
                 os.environ.get("BAILIAN_DEEPSEEK_FLASH_MODEL", "deepseek-v4.1-flash-1017"))


def upstream_model(channel: str, model: str) -> str:
    """该渠道上实际下发的型号名。主链路、健康探测、Agent 引擎三处共用，探到的才等于真调用的。"""
    if channel == "bailian":
        chan = _bailian_channel(model)
        if chan is not None:
            return chan.model
    return model


#: 渠道健康度: key -> 冷却截止时刻(time.monotonic)。进程内内存态即可,
#: 重启自动清空, 多 worker 各自独立探测, 无需共享存储。
#: key 有两种粒度:
#:   - "zx1"              账号级故障(401/402/403 欠费或鉴权) → 该渠道所有模型都别试了
#:   - "zx1:grok-4.5"     模型级故障(503 无可用渠道/404) → 只有这个模型不可用,
#:                        同渠道其它模型照常走(zx1 有余额但没上架 grok 就是这种)
_COOLDOWN: dict[str, float] = {}


def _cooldown_seconds() -> int:
    try:
        return int(os.environ.get("LLM_CHANNEL_COOLDOWN", "120"))
    except ValueError:
        return 120


def _mark_down(chan: str, model: str, reason: str, account_level: bool) -> None:
    key = chan if account_level else f"{chan}:{model}"
    _COOLDOWN[key] = time.monotonic() + _cooldown_seconds()
    logger.warning("文本渠道 %s 判定不可用(%s), 冷却 %ds: %s",
                   key, "账号级" if account_level else "模型级",
                   _cooldown_seconds(), str(reason)[:200])


def _healthy(chan: str, model: str) -> bool:
    now = time.monotonic()
    for key in (chan, f"{chan}:{model}"):
        until = _COOLDOWN.get(key)
        if until is None:
            continue
        if now >= until:
            _COOLDOWN.pop(key, None)   # 冷却到期, 重新纳入探测
        else:
            return False
    return True


#: 上游 SDK 把状态码写进异常文本, 形如 "Error code: 403 - {...}"。
_STATUS_RE = re.compile(r"[Ee]rror code:\s*(\d{3})")
_ACCOUNT_STATUS = frozenset({"401", "402", "403"})


def _is_account_level(err: Exception) -> bool:
    """区分"账号废了"(401/402/403)与"这个模型这条渠道没有"(503/404)。

    ⚠ 不能用 ``"403" in str(err)`` 这种裸子串匹配(2026-09-09 修): 各家的错误体里
    都带 trace_id / request id ——  api4me 的形如 ``(request id: 20260909…)``、
    modelverse 的形如 ``[trace_id: f79b063c-…]`` —— 里面随便撞上 "401/402/403"
    三个数字, 就会把一条**完全健康**的渠道误判成"账号级故障"而整条冷却 120s,
    连同它上面所有模型一起被跳过。这类误伤不报错、只表现为"莫名少了一条兜底",
    正好把兜底能力悄悄削掉。所以先按状态码字段精确取, 取不到才退回边界匹配。
    """
    text = str(err)
    m = _STATUS_RE.search(text)
    if m:
        return m.group(1) in _ACCOUNT_STATUS
    if re.search(r"(?<!\d)(401|402|403)(?!\d)", text):
        return True
    return any(k in text for k in ("额度不足", "insufficient", "quota", "欠费",
                                   "invalid_api_key", "Incorrect API key"))


def _chan_name(base_url: str) -> str:
    """从 base_url 推渠道名(zx1.deepwl.net → zx1, ai.api4me.xyz → api4me)。"""
    host = (urlparse(base_url).hostname or base_url or "?").split(".")
    # ai.api4me.xyz → 取 api4me 这种"最长的那段"更稳, 避免都叫 "ai"
    parts = [p for p in host if p not in ("www", "ai", "api", "com", "cn", "net", "xyz")]
    return (parts[0] if parts else host[0]) or "primary"


def _kege_key(model: str) -> str:
    """kege 四把 key 按厂商分组(见模块文档): 按模型名选, 不可混用。"""
    m = (model or "").lower()
    if "gemini" in m:
        return os.environ.get("KEGE_GEMINI_API_KEY", "")
    if m.startswith("claude"):
        return os.environ.get("KEGE_CLAUDE_API_KEY", "")
    if m.startswith(("gpt", "o1", "o3", "o4")):
        return os.environ.get("KEGE_GPT_API_KEY", "")
    return os.environ.get("KEGE_GROK_API_KEY", "")


def _relay_channels(model: str, primary_base: str, primary_key: str) -> list[_Chan]:
    """构造该模型的中转站渠道列表(key/base 缺失的渠道自动剔除)。

    顺序默认 primary(zx1) → kege → modelverse,
    可用 LLM_CHANNEL_ORDER 覆盖(逗号分隔渠道名)。

    modelverse(UCloud)排最后是**成本考量**: 它单价明显高于前两家,
    定位是"前两条都挂了才用"的终极兜底。实测 40/40 零失败、覆盖我们
    在用的全部 6 个中转模型, 且 zx1 上必现拒绝语的 __REDACTED__
    流式在它这里完全正常 —— 可靠性够格当最后一道防线。
    ⚠ 注意 catalog 是 dict, 靠**插入顺序**决定优先级, 新渠道要加在最后。
    """
    catalog: dict[str, _Chan] = {}
    primary_name = ""
    if primary_base and primary_key and primary_key != "sk-placeholder":
        n = _chan_name(primary_base)
        primary_name = n
        catalog[n] = _Chan(n, primary_base.rstrip("/"), primary_key)
    # kege(2026-10-09 起替换 api4me)。不给默认 base: 没配就整条不存在, 而不是连一个
    # 不知道是谁的地址。
    kg_base = os.environ.get("KEGE_BASE_URL", "").rstrip("/")
    kg_key = _kege_key(model)
    if kg_base and kg_key:
        if not kg_base.endswith("/v1"):
            kg_base += "/v1"
        catalog["kege"] = _Chan("kege", kg_base, kg_key)
    # modelverse: 单 key 覆盖全部模型, 没有 kege 那种分组区分
    mv_base = os.environ.get("MODELVERSE_BASE_URL", "https://api.modelverse.cn").rstrip("/")
    mv_key = os.environ.get("MODELVERSE_API_KEY", "")
    if mv_base and mv_key:
        if not mv_base.endswith("/v1"):
            mv_base += "/v1"
        catalog["modelverse"] = _Chan("modelverse", mv_base, mv_key)

    order = [x.strip() for x in os.environ.get("LLM_CHANNEL_ORDER", "").split(",") if x.strip()]
    chans = [catalog[n] for n in order if n in catalog]
    # 顺序里没列到的也追加, 避免新增渠道忘改 order 就静默失效。
    # ⚠ 但 primary 是例外: 它没被点名时要**顶到最前**, 不能跟着新渠道一起垫底。
    # 因为 order 最自然的写法就是照抄默认值 "zx1,kege,modelverse"(三个中转站名),
    # 而 deepseek 的 primary 叫 "deepseek"(官方直连) —— 按"未列到就追加"处理会把
    # 最快最便宜的官方线悄悄排到两家中转之后, 与"官方优先"的既定策略正好相反,
    # 且这种翻转不报错、只体现在账单和延迟上, 极难发现。
    rest = [(n, c) for n, c in catalog.items() if n not in order]
    head = [c for n, c in rest if n == primary_name]
    chans = head + chans + [c for n, c in rest if n != primary_name]
    # DeepSeek Flash 最优先走阿里云百炼官方渠道（排在 DeepSeek 官方直连之前），不受 LLM_CHANNEL_ORDER 影响。
    bailian = _bailian_channel(model)
    if bailian is not None:
        chans = [bailian] + chans
    # ⚠️ 2026-10-25: 剔除**没有上架该型号**的渠道。
    # 不这么做的话，官方一挂，兜底那条会对一个不存在的型号反复 404 —— 空转，
    # 用户等完一轮才拿到错误。剔掉后语义是明确的：该型号可用的渠道就这几条，
    # 全挂了就如实报错。
    # ⚠️ 必须在 _relay_channels（而不是 _relay_llm）里过滤：健康探测走
    # channels_for → _relay_channels，两处共用同一份列表，"探到的"才等于
    # "实际会尝试的"。
    chans = [c for c in chans if channel_supports_model(c.name, model)]
    return chans


def _primary_endpoint(provider: str) -> tuple[str, str]:
    """某 provider 的"主渠道"(base_url, api_key)。

    抽出来是因为**健康探测**要用与真实调用**完全同一套** key/base 解析:
    探测用 A 套配置、业务用 B 套, 探出来的"稳"就是假的。
    """
    s = get_settings()
    if provider == "gpt5":
        key = (getattr(s, "gpt5_api_key", "") or os.environ.get("GPT5_API_KEY")
               or s.openai_api_key or "sk-placeholder")
        return (getattr(s, "gpt5_base_url", "") or s.openai_base_url), key
    if provider == "claude":
        key = (getattr(s, "claude_api_key", "") or os.environ.get("CLAUDE_API_KEY")
               or "sk-placeholder")
        return (getattr(s, "claude_base_url", "") or s.openai_base_url), key
    if provider == "grok":
        key = (getattr(s, "grok_api_key", "") or os.environ.get("GROK_API_KEY")
               or "sk-placeholder")
        return (getattr(s, "grok_base_url", "") or "https://zx1.deepwl.net/v1"), key
    if provider == "deepseek":
        return "https://api.deepseek.com", (getattr(s, "deepseek_api_key", "") or "")
    if provider == "kimi":
        # Moonshot 官方直连（2026-10-25 接入）。**只有 .cn 站对这把 key 有效**：
        # .ai 国际站实测 401 Invalid Authentication，别改成国际站。
        # 与 deepseek 同款写法：config 字段优先，env 变量兜底。
        key = (getattr(s, "kimi_api_key", "") or os.environ.get("KIMI_API_KEY") or "")
        base = (getattr(s, "kimi_base_url", "") or os.environ.get("KIMI_BASE_URL")
                or "https://api.moonshot.cn/v1")
        return base, key
    if provider == "qwen":
        key = (os.environ.get("DASHSCOPE_API_KEY") or os.environ.get("QWEN_API_KEY")
               or getattr(s, "dashscope_api_key", "") or os.environ.get("EMBED_API_KEY") or "")
        return "https://dashscope.aliyuncs.com/compatible-mode/v1", key
    # gemini(默认): 走主中转站
    return s.openai_base_url, (s.openai_api_key or "")


def channels_for(provider: str, model: str) -> list[tuple[str, str, str]]:
    """该 provider+model 实际会依次尝试的渠道 [(名字, base_url, api_key)]。

    供健康探测枚举渠道用 —— 与 ``get_llm`` 走的是同一份 ``_relay_channels``,
    所以探测结果和真实调用的落点一致。
    qwen 是"跨厂商的最后一道保险"本身, 不再往下兜底, 保持单条。

    ⚠️ 2026-10-10: 第三方分组必须**和 get_llm 走同一个分支** —— 它们没有主渠道。
    此处原先会让它们落进 `_primary_endpoint` 的**默认返回**(即 gemini 主渠道 zx1),
    而 zx1 上根本没有这批模型。后果很隐蔽且很坏:
      · 探测器会真的去 zx1 打一枪 → 必然失败
      · 于是"稳"标永远算不出来(必有一条渠道不通)
      · 用户看到的是"未实测/暂不可用", 而他选的模型其实是好的
    也就是说 —— **探测口径与调用口径必须逐分支一致**, 这里是第二个落点。
    """
    if provider in _THIRD_PARTY_PROVIDERS:
        # 与 get_llm 同一套: 不传主渠道, 只靠 kege / modelverse。
        return [(c.name, c.base_url, c.api_key)
                for c in _relay_channels(model, "", "")]
    base, key = _primary_endpoint(provider)
    if provider == "qwen":
        return [(provider, base, key)] if key else []
    return [(c.name, c.base_url, c.api_key) for c in _relay_channels(model, base, key)]


def cooldown_snapshot() -> dict[str, float]:
    """当前处于冷却中的渠道 → 剩余秒数(供"稳"标实时降级用)。

    这是**运行时**的真实故障信号: 某模型在某渠道刚失败过, 即使上一轮探测
    显示三渠道全通, 也不该继续标"稳"。
    """
    now = time.monotonic()
    return {k: round(v - now, 1) for k, v in _COOLDOWN.items() if v > now}


class ChannelFallbackLLM:
    """按渠道顺序尝试的 LLM 包装。

    只实现仓库内实际用到的三个入口: ``ainvoke`` / ``astream`` / ``bind_tools``
    (全量调用点已核对: 63 处 ainvoke、1 处 astream、1 处 bind_tools)。
    刻意不做成通用 Runnable —— 少一层抽象, 行为可控可读。
    """

    def __init__(self, variants: list[tuple[str, Any]], model: str) -> None:
        self._variants = variants          # [(渠道名, ChatOpenAI 或其 bind_tools 产物)]
        self._model = model

    def __repr__(self) -> str:  # pragma: no cover - 仅调试用
        return f"<ChannelFallbackLLM {self._model} via {[n for n, _ in self._variants]}>"

    def bind_tools(self, *args, **kwargs) -> "ChannelFallbackLLM":
        """逐渠道绑定工具, 返回同样具备兜底能力的包装(超级 Agent 编排用)。"""
        return ChannelFallbackLLM(
            [(n, v.bind_tools(*args, **kwargs)) for n, v in self._variants], self._model)

    def _ordered(self) -> list[tuple[str, Any]]:
        """健康的排前面; 全在冷却中则保持原序(宁可撞一次也不能无渠道可用)。"""
        ok = [(n, v) for n, v in self._variants if _healthy(n, self._model)]
        return ok + [x for x in self._variants if x not in ok] if ok else self._variants

    async def ainvoke(self, *args, **kwargs):
        errors: list[str] = []
        variants = self._ordered()
        for name, runnable in variants:
            try:
                resp = await runnable.ainvoke(*args, **kwargs)
                if errors:
                    logger.info("文本渠道已切换到 %s(前序失败: %s)", name, "; ".join(errors))
                return resp
            except Exception as e:  # noqa: BLE001 - 任何失败都值得换条渠道再试
                _mark_down(name, self._model, e, _is_account_level(e))
                errors.append(f"{name} → {str(e)[:150]}")
        raise RuntimeError(
            f"全部 {len(variants)} 个中转站渠道均不可用(模型 {self._model}): {'; '.join(errors)}。"
            f"请检查各渠道余额/配额; 若为限流, 建议增加 API KEY 或提升配额, 而非降并发。")

    async def astream(self, *args, **kwargs):
        """流式输出。

        ⚠ 只在"还没吐出任何 chunk"时才允许换渠道 —— 已经流出去的内容无法撤回,
        中途换渠道会让前端拿到两段拼接的重复正文。
        """
        errors: list[str] = []
        variants = self._ordered()
        for name, runnable in variants:
            started = False
            try:
                async for chunk in runnable.astream(*args, **kwargs):
                    started = True
                    yield chunk
                return
            except Exception as e:  # noqa: BLE001
                if started:
                    raise      # 已出过内容, 只能如实失败, 不能重来
                _mark_down(name, self._model, e, _is_account_level(e))
                errors.append(f"{name} → {str(e)[:150]}")
        raise RuntimeError(
            f"全部 {len(variants)} 个中转站渠道均不可用(模型 {self._model}, 流式): "
            f"{'; '.join(errors)}")


#: 不接受自定义 temperature 的模型（实测 2026-10-19，经中转统一报
#: "does not support non-default temperature" / Bedrock "temperature 校验失败"）。
#: 这类模型只要请求体里出现 temperature 就 400，整条链路全部渠道一起失败 ——
#: 而写作链路是固定传 temperature 的，等于"选了这个模型就什么都写不出来"。
#: 处理方式：对它们**不下发**该参数（用模型自身默认），而不是让调用方各自判断。
#:
#: 2026-10-25 补：Kimi 全部 6 个模型都是这一类，且要求更严格 ——
#: 官方直连对非 1 的 temperature 直接回
#: `invalid temperature: only 1 is allowed for this model`（传 0.2 实测 400）。
#: 剔除该参数后模型自身默认就是 1，行为正是它要求的。
#: 用**前缀**而不是逐个列名字：官方型号带 .1/-highspeed 等后缀，
#: 逐个列会漏掉下次新增的变体，而漏掉的后果是"选了就 400"，很难归因。
_NO_TEMPERATURE_PREFIXES: tuple[str, ...] = ("kimi-", "moonshot-")
_NO_TEMPERATURE_MODELS: frozenset[str] = frozenset({"claude-haiku-5-5"})


def _strip_unsupported(model: str, kw: dict) -> dict:
    """去掉该模型不支持的采样参数。目前只有 temperature。"""
    base = (model or "").split(":")[-1].strip().lower()
    if "temperature" in kw and (
        base in _NO_TEMPERATURE_MODELS
        or base.startswith(_NO_TEMPERATURE_PREFIXES)
    ):
        kw = {k: v for k, v in kw.items() if k != "temperature"}
    return kw


#: 哪些渠道**根本没有**这个模型（渠道名 → 该渠道未上架的型号集合）。
#:
#: 用途：构造渠道链时把它们**剔除**，而不是把型号名换成别的。
#:
#: ⚠️ 2026-10-25 用户纠正：原先这里做的"降级别名"（kimi-k3.1-pro → kimi-k3）是错的。
#: k3.1-pro 与 k3 是**两个不同的模型**，静默换过去只会让用户莫名其妙觉得模型降智了，
#: 而且用量记录里写着 k3.1-pro、实际跑的是 k3 —— 口径也崩了。
#: 仓库自己的原则就是「宁可明确失败，也不静默降级到别的模型」。
#:
#: 正确语义：**中转站没上架的型号，就让那条渠道别参与这个模型的兜底**。
#: 因此 k3.1 系列只有官方一条路，官方挂了就明确失败 —— 用户已确认
#: 「官方的稳定性应该是值得相信的」，不需要用降智换可用性。
#:
#: 实测依据（2026-10-25 拉取三家 /v1/models）：
#:   官方        k3.1-pro / k3.1-pro-highspeed / k3 / k2.7-code / k2.7-code-highspeed / k2.6
#:   kege        k2.5 / k2.6 / k2.7-code / k3                     ← 无 3.1、无 code 高速档
#:   modelverse  k2.6 / k2.7-code / k2.7-code-highspeed / k3     ← 无 3.1
KIMI_CHANNEL_UNSUPPORTED: dict[str, frozenset[str]] = {
    "kege": frozenset({
        "kimi-k3.1-pro",
        "kimi-k3.1-pro-highspeed",
        "kimi-k2.7-code-highspeed",
    }),
    "modelverse": frozenset({
        "kimi-k3.1-pro",
        "kimi-k3.1-pro-highspeed",
    }),
}


def channel_supports_model(channel: str, model: str) -> bool:
    """该渠道是否能直接提供这个型号（能则原样下发，不能则整条渠道不参与兜底）。

    ⚠️ _relay_channels 拿不到 provider（调用方没传），这里按**模型名前缀**判断是不是
    Kimi。Kimi 的型号全部以 kimi- / moonshot- 开头，误判风险可忽略；反过来为了判断
    provider 而给 _relay_channels 加形参，会牵动 6 个调用点，不划算。

    ⚠️ 这个判断必须在 **_relay_channels** 里生效，而不是只在 _relay_llm 里：
    健康探测走的是 channels_for → _relay_channels，两处共用同一份过滤，
    探到的渠道集合才等于实际会尝试的渠道集合。
    """
    m = model or ""
    if not m.lower().startswith(("kimi-", "moonshot-")):
        return True
    return m not in KIMI_CHANNEL_UNSUPPORTED.get(channel, frozenset())


def _relay_llm(*, model: str, primary_base: str, primary_key: str,
               callbacks_factory, **chat_kwargs):
    """按渠道构造 ChatOpenAI 并包装兜底; 只有一条渠道时退化成裸 ChatOpenAI。"""
    chat_kwargs = _strip_unsupported(model, chat_kwargs)
    chans = _relay_channels(model, primary_base, primary_key)
    if not chans:   # 什么都没配: 保持旧行为(占位 key), 由调用方收到明确的鉴权错误
        return ChatOpenAI(model=model, api_key="sk-placeholder",
                          base_url=primary_base, **chat_kwargs)
    def _cbs(channel: str) -> list:
        cbs = callbacks_factory()
        for cb in cbs:   # 给用量回调注入渠道名(记录每次调用走了哪条渠道、耗时多少)
            if hasattr(cb, "channel"):
                cb.channel = channel
        return cbs

    variants = [
        (c.name, ChatOpenAI(callbacks=_cbs(c.name), model=c.model or model,
                            api_key=c.api_key, base_url=c.base_url, **chat_kwargs))
        for c in chans
    ]
    if len(variants) == 1:
        return variants[0][1]
    return ChannelFallbackLLM(variants, model)


def usage_callbacks(provider: str, model: str, channel: str = "") -> list:
    """模块外（如 Agent 引擎自建的 ChatOpenAI）挂用量回调用：记 token、渠道、耗时、成败。"""
    try:
        from ..factory.usage import UsageCallbackHandler
        if UsageCallbackHandler is not None:
            return [UsageCallbackHandler(provider=provider, model=model, channel=channel)]
    except Exception:  # noqa: BLE001
        pass
    return []


def get_llm(
    role: Role = "generate",
    temperature: float = 0.7,
    provider: ProviderSpec = "gemini",
    max_tokens: int | None = None,
    streaming: bool = True,
    top_p: float | None = None,
    model: str | None = None,
) -> ChatOpenAI | ChannelFallbackLLM:
    """获取LLM实例。

    返回值:
      - 多渠道 provider(gemini/gpt5/claude/grok/deepseek) 且实际配到两条以上 →
        ``ChannelFallbackLLM``(支持 ainvoke / astream / bind_tools, 自动跨渠道兜底)
      - 只配到一条渠道, 或 qwen(跨厂商保险本身) → 裸 ``ChatOpenAI``
      两者在本仓库的用法(ainvoke / astream / bind_tools)完全一致, 调用点无需改动。

    ⚠ provider 支持 "provider:model" 形式(2026-09-09 起):
      ``get_llm(provider="gemini:gemini-3.8-flash")`` 等价于
      ``get_llm(provider="gemini", model="gemini-3.8-flash")``。
      之所以用编码串而不是逐层加参数: ``provider`` 已经穿过几十个 stage 函数签名,
      逐层补 model 必然漏改, 而漏改的链路会**静默**用回 env 默认模型 —— 用户选了
      3.8、实际跑 3.6、日志也记 3.6, 两端都发现不了。编码串让中间层原样透传,
      只在这里解析一次。不带冒号的老值行为完全不变。

      型号必须在 ``catalog.py`` 白名单内; 不在则**忽略并退回默认模型**并记 warning
      (而不是抛错): 库里存着的历史作业可能带已下架的型号, 不该因此整条流水线失败。

    ⚠ 关于 max_tokens(2026-08 全局策略变更, draft 1273 截断事故复盘):
      平台在用的 gemini-3.x / gpt-5.x 全是推理模型, reasoning tokens 计入
      max_tokens 总预算且不可单独限制(thinking_budget 为厂商私有参数, 各模型
      支持度不一致, 不可持续)。实测 max_tokens 稍紧就会被推理吃光 →
      finish_reason=length → 正文只剩几十字/思维链泄漏进正文落库。
      因此: **全局不再向 API 下发 max_tokens**(实测所有在用模型不设上限时
      均能完整输出且小任务不会跑飞)。字数控制统一由应用层负责:
      prompt 字数约束 + word_hard_cap 事后截断/打回(chapter_gen 等)。
      参数保留仅为兼容既有调用点签名, 传入值会被忽略并记 debug 日志。
      配套保险丝: finish_reason=='length' 校验见本模块 looks_truncated()。

    top_p(可选, 默认 None=不下发):
      与 max_tokens 不同, 这个参数是**真下发**的。None 时完全不出现在请求体里,
      保持各模型自身默认(等价 1.0), 因此对既有调用点零影响; 只有对话工坊等
      显式传值的地方才会带上。仅在用户主动调低时使用 —— 同时压 temperature
      和 top_p 容易把输出压得过于呆板。
    """
    s = get_settings()
    # 写作模型覆盖（对话栏选的模型 → 这次触发的全部平台写作调用），说明见 job_context.WRITING_MODEL。
    # qwen 是跨厂商最后兜底，不替换。
    from ..job_context import current_writing_model
    _wm = current_writing_model()
    if _wm and split_provider_model(provider)[0] != "qwen":
        provider, model = _wm, None
    provider, encoded_model = split_provider_model(provider)
    chosen = model or encoded_model
    if chosen and not is_allowed(provider, chosen):
        logger.warning("get_llm: 模型 %s 不在 %s 的白名单内, 退回默认模型", chosen, provider)
        chosen = None

    extra_kwargs: dict = {}
    if max_tokens:
        logger.debug("get_llm: max_tokens=%s 已被全局策略忽略(推理模型截断防护)", max_tokens)
    if top_p is not None:
        extra_kwargs["top_p"] = top_p

    # 全局Token用量采集: 挂callback,覆盖所有调用点(工厂任务通过contextvars关联job)
    def _usage_cb(prov: str, model_name: str):
        try:
            from ..factory.usage import UsageCallbackHandler
            if UsageCallbackHandler is not None:
                return [UsageCallbackHandler(provider=prov, model=model_name)]
        except Exception:  # noqa: BLE001
            pass
        return []

    if provider == "deepseek":
        # DeepSeek: 官方直连**优先**, 两家中转垫后(2026-09-09 起)
        # 官方是最快最便宜的那条(实测中位 0.9s, 中转 1.8~4.3s), 所以必须排第一;
        # 中转只在官方挂掉时接手 —— 以前这里是裸 ChatOpenAI 单线, 官方一抽风
        # 整条 deepseek 链路就全灭, 而同一批模型在中转上好好的。
        # ⚠ 排序靠 _relay_channels 里 catalog 的插入顺序(primary 第一个), 别动。
        primary_base, api_key = _primary_endpoint("deepseek")
        model = chosen or platform_override("deepseek") or getattr(s, "deepseek_model", "__REDACTED__")
        return _relay_llm(
            model=model,
            primary_base=primary_base,
            primary_key=api_key,
            callbacks_factory=lambda: _usage_cb("deepseek", model),
            temperature=temperature,
            streaming=streaming,
            timeout=600,  # 不设max_tokens后长输出耗时上涨(实测gpt-5.5写2万字591s), 统一放宽
            **extra_kwargs,
        )

    if provider == "kimi":
        # Kimi (Moonshot): **官方直连优先**, 两家中转垫后(2026-10-25 接入)
        #
        # 与 deepseek 同款模式：官方是最直接的那条，中转在官方挂掉（限流/欠费/网络）
        # 时接手 —— **但只对中转真正上架了的型号生效**。
        #
        # ⚠️ 排序靠 _relay_channels 里 catalog 的插入顺序(primary 第一个), 别动。
        # ⚠️ temperature 已由 _strip_unsupported 按 kimi- 前缀剔除 —— 这批模型
        #    只接受 temperature=1，传别的值官方直接 400。
        # ⚠️ 3.1 系列只有官方有（两家中转都没上架）。_relay_channels 会把没有该型号
        #    的渠道**整条剔除**，所以这几个型号是**单渠道**，官方挂了就明确失败。
        #    不要改成"退到 k3"——k3.1-pro 与 k3 是两个不同模型，静默换过去＝降智
        #    且用量口径造假（用户 2026-10-25 明确否掉）。见 KIMI_CHANNEL_UNSUPPORTED。
        primary_base, api_key = _primary_endpoint("kimi")
        model = chosen or platform_override("kimi") or _env_default_model("kimi")
        return _relay_llm(
            model=model,
            primary_base=primary_base,
            primary_key=api_key,
            callbacks_factory=lambda: _usage_cb("kimi", model),
            temperature=temperature,
            streaming=streaming,
            timeout=600,  # 同其它 provider：推理模型长输出耗时上涨
            **extra_kwargs,
        )

    if provider == "gpt5":
        # 中转站上的 gpt-5.5, "逻辑专项模型"
        # 用独立 key (GPT5_API_KEY), 与 OPENAI_API_KEY 分开
        # 兜底: 显式 GPT5_API_KEY > 同代理的 OPENAI_API_KEY; 再不行换 kege 渠道
        primary_base, api_key = _primary_endpoint("gpt5")
        model = chosen or platform_override("gpt5") or getattr(s, "gpt5_model", "gpt-5.5")
        return _relay_llm(
            model=model,
            primary_base=primary_base,
            primary_key=api_key,
            callbacks_factory=lambda: _usage_cb("gpt5", model),
            temperature=temperature,
            streaming=streaming,
            timeout=600,  # 不设max_tokens后长输出耗时上涨(实测gpt-5.5写2万字591s), 统一放宽
            **extra_kwargs,
        )

    if provider == "claude":
        # 中转站上的 claude 系, "超级 Agent 编排大脑"
        # 走独立 key (CLAUDE_API_KEY); 经 OpenAI 兼容层支持 function-calling(bind_tools)
        # ⚠ 2026-08 实测 zx1 已下架 __REDACTED__(503 无可用渠道), 靠第二顺位中转(2026-10-09 起为 kege)兜底
        # ✅ 2026-09-25 重新实测: zx1 上 claude-opus-5-5 / opus-5 可用且稳定
        primary_base, api_key = _primary_endpoint("claude")
        model = chosen or platform_override("claude") or getattr(s, "claude_model", "__REDACTED__")
        return _relay_llm(
            model=model,
            primary_base=primary_base,
            primary_key=api_key,
            callbacks_factory=lambda: _usage_cb("claude", model),
            temperature=temperature,
            streaming=streaming,
            timeout=600,  # 不设max_tokens后长输出耗时上涨, 统一放宽
            # ⚠️ 只给 claude 放宽"分块间隔"超时, 不动全局(见下)。
            # 实测(2026-09-25, 真实分镜 prompt 6580 字):
            #   claude-opus-5-5 会先静默思考 ~200s 才吐第一个 chunk。
            #   langchain 的 stream_chunk_timeout 默认 120s
            #   (env LANGCHAIN_OPENAI_STREAM_CHUNK_TIMEOUT_S), 于是每集必被误杀:
            #   "No streaming chunk received for 120.0s (chunks_received=6)",
            #   随后 zx1 被判不可用 → 降级 api4me → 同样 503 → 整集生成失败。
            #   直连 HTTP 不复现, 因为直连能收到 reasoning 增量;
            #   而 langchain 只把**内容**增量算作 chunk, 思考期在它眼里就是纯静默。
            # 不设成全局: 该超时同时承担"渠道假死检测", 全局放宽会让其他
            # provider 的坏渠道迟迟不被判死(宁慢勿错 vs 宁快勿误, 这里选前者只限 claude)。
            # ⚠️ 只给 claude **单独放行 max_tokens**, 不推翻全局策略。
            # 全局"不下发 max_tokens"是为 gemini/gpt-5.x 那类**推理模型**定的:
            # 它们的 reasoning tokens 计入 max_tokens 预算, 卡紧会把正文饿死
            # (见本函数文档顶部的 draft 1273 截断事故). 但那条策略的直接后果是
            # **请求体里没有 max_tokens → 中转站按各自默认值兜底**。
            # 实测(2026-09-25, 真实分镜 prompt, claude-opus-5-5):
            #   不给 max_tokens  → 上游按 8192 截断, finish_reason=length,
            #                      JSON 被拦腰切断 → 解析必然失败 → 整集生成失败
            #   给 32000          → finish_reason=stop, 完整输出 16151 字, 315s
            # claude 是**非推理档**(output_token_details.reasoning=0), 不存在
            # "思考吃预算"的问题, 所以给它一个足够大的上限是安全的。
            #
            # ⚠️⚠️ 必须同时走 extra_body, 不能只传 max_tokens 形参:
            # langchain 会把 `max_tokens` **改名成** `max_completion_tokens` 再发出,
            # 而中转站只认原名字段 —— 实测(2026-09-25):
            #   传形参 max_tokens=32000 → langchain 发出 max_completion_tokens=32000
            #     → 中转站忽略 → 按默认 8192 截断 → finish_reason=length → JSON 断在半句
            #   直连 HTTP 发字面 `max_tokens`=32000 → finish_reason=stop, 完整 16151 字 ✓
            # 所以这里双保险: 形参给 langchain 自己记账用, extra_body 把原名字段送到线上。
            max_tokens=int(os.environ.get("CLAUDE_MAX_TOKENS", "32000")),
            extra_body={"max_tokens": int(os.environ.get("CLAUDE_MAX_TOKENS", "32000"))},
            stream_chunk_timeout=float(os.environ.get("CLAUDE_STREAM_CHUNK_TIMEOUT_S", "600")),
            **extra_kwargs,
        )

    if provider in _THIRD_PARTY_PROVIDERS:
        # 第三方厂商分组（MiniMax / Kimi / GLM / 通义千问 / 豆包）—— 2026-10-10 新增。
        #
        # ⚠️ 它们**没有主渠道**：zx1 上完全没有这些模型，只有 kege 与 modelverse
        #    两家中转有。所以这里不传 primary，让 `_relay_channels` 自己拼出可用的
        #    那几条（primary 那一段因为 key 为空会自动剔除，见那里的判断）。
        #
        # ⚠️ 空 base + 空 key 是有意的，不是漏填：`_relay_channels` 只在
        #    "primary_key 存在且不是占位符" 时才建第一条渠道，所以传空正好跳过。
        #    `_relay_llm` 里 "一条渠道都没有" 的兜底分支也仍成立（真没配 key 时
        #    会拿到一个必报鉴权错误的 ChatOpenAI，而不是静默走错渠道）。
        model = chosen or platform_override(provider) or _env_default_model(provider)
        return _relay_llm(
            model=model,
            primary_base="",
            primary_key="",
            callbacks_factory=lambda: _usage_cb(provider, model),
            temperature=temperature,
            streaming=streaming,
            timeout=600,  # 与其它 provider 一致：不设 max_tokens 后长输出耗时上涨
            **extra_kwargs,
        )

    if provider == "grok":
        # 中转站上的 grok-4.5, 仅短视频流水线内部使用(不对用户暴露模型名)
        # ⚠ 同 claude: zx1 已 503 无可用渠道, 靠第二顺位中转(kege)兜底
        primary_base, api_key = _primary_endpoint("grok")
        model = chosen or platform_override("grok") or getattr(s, "grok_model", "grok-4.5")
        return _relay_llm(
            model=model,
            primary_base=primary_base,
            primary_key=api_key,
            callbacks_factory=lambda: _usage_cb("grok", model),
            temperature=temperature,
            streaming=True,
            timeout=600,  # 不设max_tokens后长输出耗时上涨, 统一放宽
            **extra_kwargs,
        )

    if provider == "qwen":
        # 阿里云百炼 (dashscope OpenAI 兼容协议)
        # 兜底链: 显式 DASHSCOPE_API_KEY > QWEN_API_KEY > config 字段 > EMBED_API_KEY
        # (项目里只配了 EMBED_API_KEY 走 dashscope, 这里复用同一把 key)
        base_url, api_key = _primary_endpoint("qwen")
        model = chosen or os.environ.get("QWEN_MODEL", "qwen-max")
        return ChatOpenAI(
            callbacks=_usage_cb("qwen", model),
            model=model,
            api_key=api_key or "sk-placeholder",
            base_url=base_url,
            temperature=temperature,
            streaming=streaming,
            timeout=600,  # 不设max_tokens后长输出耗时上涨(实测gpt-5.5写2万字591s), 统一放宽
            **extra_kwargs,
        )

    # gemini (默认, 中转站代理) —— 草稿生成/拆解的主力, 双渠道兜底
    model_map = {
        "generate": s.llm_generate_model,
        "rewrite": s.llm_rewrite_model,
        "extract": s.llm_extract_model,
        "summary": s.llm_summary_model,
        # orchestrator 角色未单列模型时退回 rewrite(与既有行为一致)
        "orchestrator": getattr(s, "llm_rewrite_model", s.llm_generate_model),
    }
    # 型号优先级: 用户显式选的 > 管理员配的平台默认 > role→env 映射 > env 总兜底
    #
    # ⚠ platform_override 必须夹在中间, 不能省: 库里的历史作业、以及几十个内部调用点
    # 传的都是**裸 provider 串**("gemini"), 那些路径下 chosen 是空的。少了这一层,
    # 管理员在后台改默认就只改到了前端下拉的预选值, 真正执行生成的还是 env 里的老型号
    # —— 那正是"改了没用"里最难查的一种: 界面显示新模型, 用量日志记的也可能对不上。
    #
    # 用 platform_override(不回落 env)而不是 _default_model, 是为了在管理员**没配过**时
    # 保留下面按 role 分的 env 映射(四个角色各有各的模型), 见 catalog.platform_override。
    model = chosen or platform_override("gemini") or model_map.get(role) or s.llm_generate_model
    return _relay_llm(
        model=model,
        primary_base=s.openai_base_url,
        primary_key=s.openai_api_key or "sk-placeholder",
        callbacks_factory=lambda: _usage_cb("gemini", model),
        temperature=temperature,
        streaming=streaming,
        timeout=600,  # 不设max_tokens后长输出耗时上涨(实测gpt-5.5写2万字591s), 统一放宽
        **extra_kwargs,
    )


async def ainvoke_with_fallback(
    prompt,
    *,
    role: Role = "generate",
    temperature: float = 0.7,
    primary: ProviderSpec = "gemini",
    max_tokens: int | None = None,
):
    """主 LLM 调用, 失败自动 fallback 到 qwen.

    两层兜底, 各管一段:
      1. **渠道级**(本模块 ChannelFallbackLLM): 同一模型在 zx1 / kege / modelverse 之间切,
         模型能力完全不变 —— 优先级更高, 在 get_llm 返回的对象内部就完成了。
      2. **厂商级**(这里): 中转站全挂时退到百炼 qwen, 换了模型, 质量可能有落差,
         所以只当最后一道保险。

    返回 LangChain BaseMessage 对象 (.content 取文本)。
    """
    try:
        llm = get_llm(role=role, temperature=temperature, provider=primary, max_tokens=max_tokens)
        return await llm.ainvoke(prompt)
    except Exception as e:
        logger.warning("primary LLM (%s) failed: %s, fallback to qwen", primary, e)
        try:
            llm = get_llm(role=role, temperature=temperature, provider="qwen", max_tokens=max_tokens)
            return await llm.ainvoke(prompt)
        except Exception as e2:
            logger.error("qwen fallback also failed: %s", e2)
            raise


# ---------------------------------------------------------------------------
# 截断保险丝(公共助手)
# ---------------------------------------------------------------------------
# 全局不设 max_tokens 后, 理论上不会再出现 finish_reason=length。
# 但保留此校验作为"免费保险丝": 万一未来某模型/代理引入隐藏输出上限,
# 调用方能第一时间报错/告警, 而不是把被截断的残文(甚至泄漏的思维链)落库。
# 用法(落库前):
#     resp = await llm.ainvoke(prompt)
#     text = (getattr(resp, "content", "") or "").strip()
#     if looks_truncated(resp, text):
#         raise RuntimeError(f"LLM输出疑似被截断(finish_reason={finish_reason_of(resp)})")

def finish_reason_of(resp) -> str:
    """从 LangChain BaseMessage 取 finish_reason(取不到返回空串)。"""
    try:
        return ((getattr(resp, "response_metadata", None) or {}).get("finish_reason") or "")
    except Exception:  # noqa: BLE001
        return ""


def looks_truncated(resp, text: str = "", min_len: int | None = None) -> bool:
    """判断一次 LLM 响应是否疑似被截断。

    - finish_reason == 'length': 输出被 token 上限掐断(推理模型下正文可能只剩
      几十字甚至是泄漏的思维链片段), 一律视为截断。
    - min_len: 可选的业务最短长度(如章节下限), text 短于它也视为异常。
    """
    if finish_reason_of(resp) == "length":
        return True
    if min_len is not None and len(text) < min_len:
        return True
    return False
