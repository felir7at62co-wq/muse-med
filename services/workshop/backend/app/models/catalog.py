"""用户可选文本模型清单 + "provider:model" 编码 + 模型别名归一。

## 为什么把型号编进 provider 串, 而不是给 get_llm 加一个 model 参数

平台里 ``provider`` 是一个**贯穿 77 个 get_llm 调用点、几十个 stage 函数签名**
的纯字符串(``generate_chapter(..., provider="gemini")``)。要让用户选到具体型号,
若给沿途每个函数都补一个 model 参数, 改动面覆盖整个 stages/ 且极易漏改 ——
而漏改的那条链路会**静默**退回 env 默认模型: 用户选了 3.8、实际跑 3.6、
用量日志记的也是 3.6, 从任何一端都发现不了。

改成把型号编进 provider 串(``"gemini:gemini-3.8-flash"``), 中间所有函数原样透传,
**只有 get_llm 一处解析**。零签名改动 = 零漏改风险。不带冒号的旧值(``"gemini"``)
行为完全不变, 老调用点与库里的历史作业记录都无需迁移。

## 别名: 中转站会静默换名, 必须归一后再判定与记账

实测(2026-09-09, 三渠道逐一探测)zx1 会在回显里改掉模型名:

===========================  =============================  ==================
请求                          zx1 实际回显                    性质
===========================  =============================  ==================
gemini-3.1-pro               gemini-pro-agent               厂商确认同一模型
gemini-3.8/3.7/3.6-flash     gemini-3.x-flash-**high**      同模型的高推理档
gemini-3-flash-preview       gemini-3-flash                 preview 转正
===========================  =============================  ==================

按用户 2026-09-09 的裁定: 这几组按**同一个模型**处理, 统一归一到左列的名字。
归一发生在两处 —— 健康探测判"是否被静默替换", 以及用量记账写哪个 model,
否则同一个模型会在报表里裂成两行、"稳"标也会因为名字对不上而永远打不出来。

⚠ 归一只用于"判定与记账", **下发给上游的仍是用户选的原名**: 我们不去猜
上游想要哪个写法, 只把回来的名字对齐。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from ..config import get_settings

logger = logging.getLogger("model_catalog")

#: 用户可见的厂商分组, 顺序即下拉里的顺序。
#:
#: ⚠️ 2026-10-10 新增五个第三方分组(MiniMax / Kimi / GLM / Qwen / 豆包)。
#: 它们**只存在于两家中转**(kege 与 modelverse), zx1 上没有 —— 见 llm.py 里
#: 这些 provider 的接线: 不传主渠道, 直接由 `_relay_channels` 拼出可用的那几条。
#:
#: ⚠️ provider id 取 "mini" / "kimi" / "glm" / "qwenapi" / "doubao", 而**不是**
#: "minimax" / "qwen"。原因是两处会撞:
#:   1. `_kege_key` 按**模型名里是否含 "gemini"** 选 key(catalog 与 llm 两个
#:      方向的匹配都会用到), provider id 里带 "gemini" 会误命中 gemini 分组;
#:   2. `qwen` 这个 provider id **已被占用** —— 它是 dashscope 官方直连的
#:      **跨厂商最后一道保险**(见 llm.get_llm 的 qwen 分支与 ainvoke_with_fallback),
#:      十几处 fallback 逻辑写死了这个字串。用户可见的"通义千问"必须另起一个 id,
#:      否则会把保险丝和普通分组搅在一起。
#: 这些 id 只出现在"provider:model"串里, 用户看到的是 label, 短名更省下拉宽度。
VENDORS: tuple[tuple[str, str], ...] = (
    ("gemini", "Gemini"),
    ("claude", "Claude"),
    ("gpt5", "GPT"),
    ("grok", "Grok"),
    ("deepseek", "DeepSeek"),
    ("mini", "MiniMax"),
    ("kimi", "Kimi"),
    ("glm", "GLM"),
    ("qwenapi", "通义千问"),
    ("doubao", "豆包"),
)
VENDOR_LABEL = dict(VENDORS)

#: 走多渠道兜底的 provider。
#: ⚠ deepseek 于 2026-09-09 从"官方直连单线"改为"官方直连 + 中转兜底"(见 llm.py
#: channels_for): 实测两家中转都上架了 deepseek 系, 官方挂掉时没有理由整条链路陪葬。
#: qwen 仍是单线 —— 它本身就是**跨厂商**的最后一道保险, 不需要自己再兜底。
#:
#: 2026-10-10: 五个第三方分组也是多渠道(只有 kege + modelverse 两条),
#: 它们**没有官方直连**, 所以没有主渠道, 全靠这里的兜底链 —— 必须登记进本集合,
#: 否则健康探测不会去枚举它们的渠道, "稳"标永远算不出来。
RELAY_PROVIDERS = frozenset({
    "gemini", "gpt5", "grok", "claude", "deepseek",
    "mini", "kimi", "glm", "qwenapi", "doubao",
})


@dataclass(frozen=True)
class ModelSpec:
    """一个可选模型。

    id      真正下发给上游的模型 id, 不做任何美化
    label   下拉里的展示名
    note    给用户的一句话提醒(已知坑), 没有就留空
    """

    provider: str
    id: str
    label: str
    note: str = ""


#: Gemini 文本模型清单 —— 三个渠道 /v1/models 的**并集**, 只留纯文本对话模型
#: (image / image-preview / embedding / tts / live / omni / batch 变体都不在此列:
#:  它们要么不是对话接口, 要么语义不同, 混进来只会让用户选到一个必崩的选项)。
#:
#: 按用户要求: **不按"有几条渠道兜底"筛选** —— 全部上架, 由 model_channel_health
#: 现算出的"稳"标和可用渠道数去表达差异, 而不是在这里替用户做决定。
_GEMINI_MODELS: tuple[tuple[str, str], ...] = (
    # (model id, note)
    ("gemini-3.8-flash", ""),
    ("gemini-3.7-flash", ""),
    ("gemini-3.6-flash", ""),
    ("__REDACTED__", ""),
    ("__REDACTED__-lite", "轻量档, 长文生成偏弱"),
    ("gemini-3.1-pro", ""),
    ("__REDACTED__", ""),
    ("gemini-3.1-flash-lite", "轻量档, 长文生成偏弱"),
    ("gemini-3.1-flash-lite-preview", ""),
    ("gemini-3-flash-preview", ""),
    ("gemini-3-pro-preview", "Google 已下线, 保留仅供查证"),
    ("gemini-2.5-pro", "老一代, 响应明显慢"),
    ("gemini-2.5-flash", "老一代"),
    ("gemini-2.5-flash-lite", "老一代轻量档"),
)

#: Grok / GPT / DeepSeek 清单 —— 2026-09-09 逐 (模型 × 线路) 实测后确定。
#:
#: 收录标准: **至少一条线路实测跑通**(真发一次 chat/completions 拿到正文)。
#: 不收录:
#:   - 一条都没跑通的(zx1 广告了 gpt-5.4 但报"模型不存在", modelverse 广告了
#:     gpt-5.4-pro 但 400 —— 上游 /v1/models 列表**不等于**真能调用, 只能实测)
#:   - `gpt-5.2-pro`: 上游明确回 "not a chat model", 只走 responses 接口, 上架必崩
#:   - 只在单一渠道存在的私有写法(`-sg` 后缀、`deepseek-ai/` 前缀): 换条线路就没有,
#:     等于把渠道细节泄露进用户可见的型号名, 且天然无法兜底
#:   - `deepseek-chat` / `deepseek-reasoner`: 是官方给的**别名**, 回显 deepseek-v4-flash,
#:     上架会让同一个模型在下拉里出现两次、用量报表也裂成两行(已登记进 MODEL_ALIASES)
#:
#: 与 Gemini 同一条原则: **不按"有几条线路兜底"筛选** —— 只通一条的也上架,
#: 由 model_channel_health 现算的"稳"标和线路数去表达差异(用户 2026-09-09 裁定)。
#: ⚠ 带日期的快照名(-0813/-0731/-0309)保留为独立条目: 实测它们各自原样回显,
#: **没有**证据证明与裸名是同一模型, 按本文件原则不做猜测性合并。
_GROK_MODELS: tuple[tuple[str, str], ...] = (
    # 2026-10-10 补：grok-4.7 实测**三渠道全通**，此前漏收。
    ("grok-4.7", ""),
    ("grok-4.6", ""),
    ("grok-4.5", ""),
    ("grok-4.3", ""),
    ("grok-4.20-0309-reasoning", "0309 快照, 推理档"),
    ("grok-4.20-0309-non-reasoning", "0309 快照, 非推理档"),
    ("grok-4", "老一代"),
)

_GPT5_MODELS: tuple[tuple[str, str], ...] = (
    # 2026-10-10 补：gpt-6-astra 在列，但同代的 sol 系漏了 ——
    # gpt-6-sol / gpt-6.1-sol 实测**三渠道全通**，看着是遗漏而非有意排除。
    ("gpt-6.1-sol", ""),
    ("gpt-6-sol", ""),
    ("gpt-6-astra", ""),
    ("gpt-6-luna", "仅两家中转有，无主渠道兜底"),
    ("gpt-5.6-luna", ""),
    ("gpt-5.6-sol", ""),
    ("gpt-5.6-terra", ""),
    ("gpt-5.5", ""),
    ("gpt-5.5-pro", "pro 档"),
    ("gpt-5.4", ""),
    ("gpt-5.4-mini", "轻量档, 长文生成偏弱"),
    ("gpt-5.4-nano", "轻量档, 长文生成偏弱"),
    ("gpt-5.4-pro", "pro 档"),
    ("gpt-5.2", "老一代"),
    ("gpt-5.1", "老一代"),
    ("gpt-5", "老一代"),
    ("gpt-5-pro", "老一代 pro 档"),
    ("gpt-5-mini", "老一代轻量档"),
    ("gpt-5-nano", "老一代轻量档"),
    ("gpt-5-chat-latest", "老一代对话档(非推理), 长文逻辑偏弱"),
)

_DEEPSEEK_MODELS: tuple[tuple[str, str], ...] = (
    ("__REDACTED__", ""),
    ("deepseek-v4-flash", ""),
    ("__REDACTED__-0813", "0813 快照版"),
    ("deepseek-v4-flash-0731", "0731 快照版"),
    ("deepseek-v3.2", "老一代"),
)

#: claude 系（2026-09-25 新增，用户授权上架）
#: 收录标准同上：**至少一条线路实测跑通**。2026-09-25 在 zx1 上逐模型实测：
#:   `claude-opus-5-5` ✓ / `__REDACTED__` ✓ / `claude-opus-5` ✓（均在 /v1/models 列表内且可调）
#: ⚠️ `__REDACTED__` 长期被平台当作 claude provider 的 env 默认值，
#:    但它此前**不在任何用户可见清单里** —— 即"平台自己在用，用户却选不到"。
#:    顺带一并上架，避免这个自相矛盾继续存在。
#:
#: 🔴 2026-10-10 补足：此前清单里**只有 opus 三档，整个 Sonnet 线一个都没有** ——
#:    等于用户完全选不到 claude 的中档主力。实测可用但未上架的有 8 个，已补齐。
#:    逐 (模型 × 渠道) 实测（同一套 _probe_once，与平台自己的"稳"标同源）：
#:      sonnet-5-5 / sonnet-5 / opus-4-7 / opus-4-6 / fable-5-1 / sonnet-4-6 → **三渠道全通**
#:      haiku-5-5  → kege + modelverse（zx1 503 无可用渠道）
#:      fable-5    → zx1 + modelverse（kege HTTP 200 但**正文为空**，即"看着通、实际吐不出字"）
#:    带日期的快照名(opus-4-5-20251101 / sonnet-4-5-20250929 / haiku-4-5-20251001)
#:    实测也全通，但它们是**老一代**且与不带日期的写法分属不同名字空间，按本文件
#:    "不猜测性合并"的原则**不收录**——避免下拉里为同一个模型出现三个入口。
_CLAUD_MODELS: tuple[tuple[str, str], ...] = (
    ("claude-opus-5-5", ""),
    ("claude-sonnet-5-5", ""),
    ("claude-fable-5-1", ""),
    ("claude-opus-4-7", ""),
    ("claude-sonnet-5", ""),
    ("claude-opus-4-6", ""),
    ("claude-sonnet-4-6", ""),
    ("claude-opus-5", ""),
    ("__REDACTED__", "老一代"),
    ("claude-haiku-5-5", "轻量档，长文生成偏弱"),
    ("claude-fable-5", "轻量档，长文生成偏弱"),
)

#: ── 第三方厂商分组（2026-10-10 新增，用户授权）───────────────────────────
#:
#: 收录标准与上面四家**完全一致**：至少一条线路真跑通一次 chat/completions。
#: 不照抄上游 /v1/models —— 那里面有大量"广告了却调不通"的型号。
#:
#: ⚠️ 这五家的共同点：**zx1 上完全没有**，只存在于 kege 与 modelverse 两家中转。
#:    所以它们没有"主渠道"，全靠 `_relay_channels` 拼出可用渠道（见 llm.py）。
#:    单家中转的型号**也上架**（沿用本文件"不按兜底数筛选、交给稳标表达"的原则），
#:    但 note 里会点明，让用户知道自己选的这条没有兜底。
#:
#: ⚠️ 实测(2026-10-10) kege 的 key 分组：这批模型**只有 gemini / gpt / grok
#:    三把 key 能用，claude 那把一定 503**。按 `_kege_key` 的判据（模型名不含
#:    gemini、不以 claude/gpt/o1/o3/o4 开头）它们会落到 grok 那把 —— 实测可用，
#:    所以**不需要改 _kege_key**。这层依赖很隐晦，改动 key 分组时务必回头复测
#:    这五家，否则它们会集体变成"只剩 modelverse 一条"而无人察觉。
#:    另：mimo-v2.6-pro 在 kege 上四把 key 全 503，只有 modelverse 有 —— 故未收 Mimo 分组。
_MINIMAX_MODELS: tuple[tuple[str, str], ...] = (
    # ⚠️ 实测(2026-10-10) MiniMax-M3 在**生成类** prompt 上会把 ` thinking...`
    # 整段思维链泄漏进正文 —— 用小 prompt 试不出来，用真实分镜 prompt 必现。
    # 那正是本仓库最怕的失败模式(reasoning 混进落库正文，见 llm.py 顶部的
    # draft 1273 截断事故)；分镜正文里出现 `<think>` 会直接污染剧本。
    # 它**仍然上架**(用户可主动选)，但不做默认值，并且 note 必须点明。
    # 默认给实测干净的 M2.7 —— 默认值是"不读文档直接点生成"的人实际会用的那个。
    ("MiniMax-M2.7", ""),
    ("MiniMax-M3", "⚠️ 生成长文时可能把思维链(<think>…)混进正文"),
)

#: Kimi（Moonshot）模型清单。
#:
#: 🔴 2026-10-25 重建：接入 Moonshot **官方直连**后，以官方 `/v1/models` 为基准重新核对。
#: 官方清单只有 6 个模型，全部逐个实调通过（去掉 temperature 参数后）：
#:   kimi-k3.1-pro / kimi-k3.1-pro-highspeed / kimi-k3
#:   kimi-k2.7-code / kimi-k2.7-code-highspeed / kimi-k2.6
#:
#: ⚠️ 两个「只在高通档存在」的型号必须上架，否则选了它们在**官方渠道**上会 404：
#:   kimi-k3.1-pro-highspeed / kimi-k2.7-code-highspeed —— 原先清单里一个都没有。
#:
#: ⚠️ 收录标准照旧是"至少一条渠道实测跑通"，但这次的口径是**官方**这条主渠道：
#: 两家中转的上架情况与官方不同 —— kege 只有 k2.5/k2.6/k2.7-code/k3，modelverse 多
#: 一个 k2.7-code-highspeed、但**没有** k3.1-pro 系列。差集不影响上架：主渠道(官方)
#: 全都有，中转只是兜底，缺的那几条会在兜底时跳过去（见 llm.py 的渠道别名表）。
#:
#: ⚠️ 全部 6 个模型**只接受 temperature=1**（实测：传 0.2 直接 400
#: "invalid temperature: only 1 is allowed for this model"）。写作链路固定传
#: temperature，所以它们必须登记进 llm._NO_TEMPERATURE_MODELS，否则"选了就什么都写不出来"。
#:
#: ⚠️ 这批模型都带推理（思考链走独立的 reasoning_content 字段，**不会**混进正文 ——
#: 与 MiniMax-M3 的 `<think>` 泄漏是两回事，因此不需要在 note 里警告）。
#: 代价是同样一句话的耗时明显更长（实测 k3.1-pro 一次简单问答 reasoning 502 字）。
#:
#: 默认给 kimi-k3：旗舰 k3.1-pro 实测**会间歇 429**（engine overloaded，4 次里挂 1 次），
#: 而 k3、k2.6、k2.7-code、k3.1-pro-highspeed 各 4/4 全通。默认值是"不读文档直接点生成"
#: 的人实际会用的那个，所以选稳定的旗舰而不是最贵的那个。
_KIMI_MODELS: tuple[tuple[str, str], ...] = (
    ("kimi-k3", "默认档, 旗舰推理, 实测稳定"),
    ("kimi-k3.1-pro", "最新旗舰, 长文最强; 高峰期可能短暂过载"),
    ("kimi-k3.1-pro-highspeed", "旗舰高速档"),
    ("kimi-k2.7-code", ""),
    ("kimi-k2.7-code-highspeed", "代码高速档, 长文生成偏弱"),
    ("kimi-k2.6", "上一代, 较轻量"),
)

_GLM_MODELS: tuple[tuple[str, str], ...] = (
    ("glm-5.3", ""),
    ("glm-5.2", ""),
    ("glm-5.3-flash", "轻量档, 长文生成偏弱"),
    ("glm-5.1", "老一代"),
)

#: ⚠️ provider id 是 "qwenapi" 不是 "qwen" —— 见 VENDORS 上方的撞名说明。
_QWEN_API_MODELS: tuple[tuple[str, str], ...] = (
    ("qwen3.8-max", ""),
    ("qwen3.7-max", ""),
    ("qwen3.8-flash", "单家中转(kege), 无兜底"),
)

_DOUBAO_MODELS: tuple[tuple[str, str], ...] = (
    ("doubao-seed-evolving", ""),
    ("doubao-seed-2-1-pro-260628", "单家中转, 无兜底"),
    ("doubao-seed-2-1-turbo-260628", "单家中转, 无兜底"),
)

#: provider → 清单。顺序即下拉里的顺序(新的在前)。
_VENDOR_MODELS: dict[str, tuple[tuple[str, str], ...]] = {
    "gemini": _GEMINI_MODELS,
    "deepseek": _DEEPSEEK_MODELS,
    "gpt5": _GPT5_MODELS,
    "grok": _GROK_MODELS,
    "claude": _CLAUD_MODELS,
    "mini": _MINIMAX_MODELS,
    "kimi": _KIMI_MODELS,
    "glm": _GLM_MODELS,
    "qwenapi": _QWEN_API_MODELS,
    "doubao": _DOUBAO_MODELS,
}

#: 回显名 → 归一名。左边是上游实际回来的, 右边是我们记账/判定用的。
#: ⚠ note 字段是**直接下发给用户**的, 里面不得出现任何中转站名/线路信息
#: (用户 2026-09-09 要求): 别名的来历写在本文件注释里就够了。
#: 只登记**已实测确认**的等价关系, 不做猜测性合并。
MODEL_ALIASES: dict[str, str] = {
    "gemini-pro-agent": "gemini-3.1-pro",
    "gemini-3-flash": "gemini-3-flash-preview",
    # DeepSeek 官方保留的两个通用别名, 实测都回显 deepseek-v4-flash
    # (同一个模型的两个入口名)。不归一的话, 老代码/老作业里写着 deepseek-chat
    # 的调用会在用量报表里单独占一行, "稳"标也因为名字对不上永远打不出来。
    "deepseek-chat": "deepseek-v4-flash",
    "deepseek-reasoner": "deepseek-v4-flash",
    # 2026-10-19 用户确认官方已更新为 DeepSeek-V4.1-Flash-1017；百炼/modelverse 只认这个带版本号的名字，
    # 回显也是它 —— 与 deepseek-v4-flash 是同一个模型，不归一会被判成"被静默换模型"。
    "deepseek-v4.1-flash-1017": "deepseek-v4-flash",
    # 2026-10-25: kege 对 Kimi 会回显带厂商前缀的名字（实测 `moonshotai/kimi-k3`）。
    # 不归一的话，那条渠道会被判成 substituted=True（"被静默换模型"），
    # 而实际发出去的就是 k3 本身 —— 前缀是渠道的记账习惯，不是换了模型。
    "moonshotai/kimi-k3": "kimi-k3",
    "moonshot/kimi-k3": "kimi-k3",
}

#: zx1 给 flash 系挂的推理档后缀, 属同一模型的不同档位, 判定时一律去掉。
#: (代价不同 —— 同一道"1+1"实测 zx1 的 3.6-flash 花 216 个补全 token、
#:  api4me 只花 151 个 —— 但那是渠道成本差异, 不是"另一个模型"。)
_TIER_SUFFIXES: tuple[str, ...] = ("-high", "-medium", "-low")


def normalize_model(model: str) -> str:
    """把上游回显的模型名归一成 catalog 里的 id。

    顺序: 显式别名表 → 去推理档后缀 → 去后再查一次别名表 → 原样返回。
    """
    m = (model or "").strip()
    if not m:
        return ""
    if m in MODEL_ALIASES:
        return MODEL_ALIASES[m]
    low = m.lower()
    for suf in _TIER_SUFFIXES:
        if low.endswith(suf):
            base = m[: -len(suf)]
            return MODEL_ALIASES.get(base, base)
    return m


def split_provider_model(spec: str | None) -> tuple[str, str | None]:
    """解析 "gemini:gemini-3.8-flash" → ("gemini", "gemini-3.8-flash")。

    不含冒号的老值原样返回 provider、model 为 None(= 用 env 默认模型),
    保证既有调用点与库里存的历史 job.model 行为完全不变。
    """
    s = (spec or "").strip()
    if not s:
        return "gemini", None
    if ":" not in s:
        return s, None
    provider, _, model = s.partition(":")
    provider = provider.strip() or "gemini"
    model = model.strip()
    return provider, (model or None)


def join_provider_model(provider: str, model: str | None) -> str:
    """反向: 拼成接口/库里存的那一个字符串。"""
    return f"{provider}:{model}" if model else provider


#: system_settings 里存平台默认型号的 key 前缀, 完整 key 形如 "default_model:gemini"。
DEFAULT_MODEL_SETTING_PREFIX = "default_model:"

#: 平台默认型号的运行时覆盖层 {provider: model_id}, 来源是 system_settings 表。
#:
#: ## 为什么要缓存, 而不是每次读库
#: ``_default_model`` 是**同步**函数, 被 catalog() / is_allowed() / default_choice()
#: 一串同步调用点使用, 改成 async 会波及整条链路(以及 77 个 get_llm 调用点的上游);
#: 而它每个请求要被调用四五次, 也不该每次打库。
#:
#: ## 为什么不用 TTL
#: catalog() 承诺"改了立刻生效"。TTL 会让管理员改完后在一个不确定的窗口里
#: 继续看到旧值 —— 比没有缓存更糟, 因为他会以为自己没改成功而反复改。
#: 所以只在**写入端**失效: set_default_model_override() 就地刷新这个 dict。
_DEFAULT_MODEL_OVERRIDES: dict[str, str] = {}


def _env_default_model(provider: str) -> str:
    """env / 代码常量给出的默认型号 —— 三级回落里的后两级。

    ⚠️ 新增 provider 必须在这里登记，否则"平台默认型号"为空 —— 后果是下拉里
    没有预选项，而且 catalog() 那条"平台默认若不在清单里就补进去置顶"的保护
    也失效（它靠本函数的返回值）。unknown provider 一律回落空串。
    """
    s = get_settings()
    return {
        # 对话/精修走 role="rewrite", 与 chat_model_catalog 的口径保持一致
        "gemini": getattr(s, "llm_rewrite_model", "") or "gemini-3.6-flash",
        "deepseek": getattr(s, "deepseek_model", "") or "__REDACTED__",
        "gpt5": getattr(s, "gpt5_model", "") or "gpt-5.5",
        "grok": getattr(s, "grok_model", "") or "grok-4.5",
        "claude": getattr(s, "claude_model", "") or "__REDACTED__",
        # 第三方分组：平台默认取实测最稳的那一档（不必配 env，没有官方直连）
        # ⚠️ mini 的默认是 M2.7 不是 M3 —— M3 会把思维链混进正文，见 _MINIMAX_MODELS
        "mini": "MiniMax-M2.7",
        "kimi": getattr(s, "kimi_model", "") or "kimi-k3",
        "glm": "glm-5.3",
        "qwenapi": "qwen3.8-max",
        "doubao": "doubao-seed-evolving",
    }.get(provider, "")


def _default_model(provider: str) -> str:
    """该 provider 当前的**平台**默认型号。

    三级回落: system_settings(DB, 管理员可改) > env > 代码常量。

    ⚠ 这里不含**用户个人偏好** —— 那一层在 catalog_routes.api_catalog 里叠加,
    因为它需要 user 上下文, 而本函数被一堆无用户上下文的地方调用(如 is_allowed)。
    """
    override = (_DEFAULT_MODEL_OVERRIDES.get(provider) or "").strip()
    if override:
        return override
    return _env_default_model(provider)


def platform_override(provider: str) -> str:
    """管理员在后台配的平台默认型号; **没配过返回空串**(不回落 env)。

    与 _default_model 的区别很重要, 别混用:
      _default_model     —— 带 env 回落, 给"必须给出一个型号"的地方(下拉默认值)
      platform_override  —— 不回落, 给 get_llm 那种**后面还有一条自己的 env 链**
                            的地方。gemini 的 env 链是**按 role 分的**
                            (generate/rewrite/extract/summary 各一个变量), 若在那里
                            用 _default_model, 管理员没配过时也会被压成 rewrite 那一个,
                            把四个角色的差异静默抹平。
    """
    return (_DEFAULT_MODEL_OVERRIDES.get(provider) or "").strip()


def set_default_model_override(provider: str, model: str | None) -> None:
    """就地刷新进程内的平台默认型号(管理员改设置后调用)。

    model 传空 = 清除覆盖, 回落到 env。
    """
    prov = (provider or "").strip()
    if not prov:
        return
    mid = (model or "").strip()
    if mid:
        _DEFAULT_MODEL_OVERRIDES[prov] = mid
    else:
        _DEFAULT_MODEL_OVERRIDES.pop(prov, None)


def default_model_sources() -> dict[str, dict[str, str]]:
    """每个 provider 的默认型号来自哪一级 —— 给管理员后台显示用。

    返回 {provider: {"effective":…, "db":…, "env":…, "source": "db"|"env"}}
    """
    out: dict[str, dict[str, str]] = {}
    for prov, _ in VENDORS:
        db_val = (_DEFAULT_MODEL_OVERRIDES.get(prov) or "").strip()
        env_val = _env_default_model(prov)
        out[prov] = {
            "effective": db_val or env_val,
            "db": db_val,
            "env": env_val,
            "source": "db" if db_val else "env",
        }
    return out


def catalog() -> dict[str, list[ModelSpec]]:
    """provider → 可选模型列表(现算, 不缓存: env 改了立刻生效)。

    四家的清单都来自 2026-09-09 的逐 (模型 × 线路) 实测(见 _VENDOR_MODELS 上方
    的收录标准), 不是照抄上游 /v1/models —— 那个列表里有一批广告了却根本调不通的
    型号, 直接上架等于让用户选到一个必崩的选项。
    """
    out: dict[str, list[ModelSpec]] = {}
    for prov, rows in _VENDOR_MODELS.items():
        specs = [ModelSpec(prov, mid, mid, note) for mid, note in rows]
        # 平台默认模型若不在清单里(管理员配了/env 换了一个我们没登记的型号),
        # 补进去置顶, 否则会出现"平台正在用的模型反而选不到"
        dm = _default_model(prov)
        if dm and all(m.id != dm for m in specs):
            specs.insert(0, ModelSpec(prov, dm, dm, "平台当前默认型号"))
        out[prov] = specs
    return out


def all_specs() -> list[ModelSpec]:
    return [m for models in catalog().values() for m in models]


def is_allowed(provider: str, model: str | None) -> bool:
    """model 是否在该 provider 的白名单内(None = 用默认, 恒为 True)。"""
    if not model:
        return True
    return any(m.id == model for m in catalog().get(provider, ()))


def default_choice(provider: str) -> str:
    """该 provider 的**平台**默认下拉值, 形如 "gemini:gemini-3.8-flash"。

    不含用户个人偏好, 叠加逻辑见 catalog_routes.api_catalog。
    """
    return join_provider_model(provider, _default_model(provider) or None)


async def load_default_models_from_db() -> None:
    """容器启动时调用: 把 system_settings 里的平台默认型号灌进进程内覆盖层。

    对标 stages.router.restore_concurrency_from_db —— 同一张 system_settings 表、
    同一个"重启后自动恢复"的诉求。库里没记录就什么都不做(回落 env)。
    """
    try:
        from sqlalchemy import text
        from ..db import session_scope
        async with session_scope() as s:
            rows = (await s.execute(
                text("SELECT key, value FROM system_settings WHERE key LIKE :p"),
                {"p": f"{DEFAULT_MODEL_SETTING_PREFIX}%"},
            )).all()
    except Exception as e:  # noqa: BLE001
        # 比如 system_settings 表还没建(老库): 降级成沿用 env, 不阻塞启动
        logger.warning("默认模型: 从 DB 恢复失败(沿用 env): %s", e)
        return

    loaded = 0
    for key, value in rows:
        prov = str(key)[len(DEFAULT_MODEL_SETTING_PREFIX):].strip()
        mid = (value or "").strip()
        if not prov or not mid:
            continue
        set_default_model_override(prov, mid)
        loaded += 1
    if loaded:
        logger.info("默认模型: 从 system_settings 恢复 %d 个 provider 覆盖: %s",
                    loaded, _DEFAULT_MODEL_OVERRIDES)
    else:
        logger.info("默认模型: system_settings 无覆盖记录, 沿用 env")


async def persist_default_model(provider: str, model: str | None,
                                admin_id: int | None) -> None:
    """管理员设置平台默认型号: 写库 + 就地刷新缓存。

    先刷缓存再写库会让"写库失败但接口返回成功"变成一个静默的假生效, 所以顺序反过来:
    **写库成功才刷缓存**, 失败直接抛给调用方由接口报错。
    """
    from sqlalchemy import text
    from ..db import session_scope

    prov = (provider or "").strip()
    mid = (model or "").strip()
    key = f"{DEFAULT_MODEL_SETTING_PREFIX}{prov}"
    async with session_scope() as s:
        if mid:
            await s.execute(
                text("""INSERT INTO system_settings (key, value, updated_by, updated_at)
                        VALUES (:k, :v, :uid, NOW())
                        ON CONFLICT (key) DO UPDATE SET
                            value = :v, updated_by = :uid, updated_at = NOW()"""),
                {"k": key, "v": mid, "uid": admin_id},
            )
        else:
            # 空值 = 清除覆盖, 回落 env。删行而不是存空串: 存空串会让
            # load_default_models_from_db 每次启动都读到一条无意义的记录。
            await s.execute(text("DELETE FROM system_settings WHERE key = :k"), {"k": key})
    set_default_model_override(prov, mid)
    logger.info("默认模型: %s -> %s (admin=%s)", prov, mid or "(清除, 回落 env)", admin_id)


def sanitize_provider_spec(spec: str | None, allowed: tuple[str, ...] | frozenset[str],
                           default: str) -> str:
    """把库里/接口里拿到的模型选择规范化成 get_llm 认的串。

    各业务链路(精修/裂变/改编/去味/超级 Agent 编排)原本都写着
    ``provider = model if model in ("gemini", "deepseek", "gpt5") else <默认>``。
    这类判断遇到新的编码值 ``"gemini:gemini-3.8-flash"`` 会**整串对不上**,
    于是静默落到默认厂商 —— 用户在下拉里选了 Gemini 3.8, 实际跑的是 gpt5,
    且从日志到用量表全都记着 gpt5, 两头都查不出来。所以每一处都要换成本函数。

    规则:
      - 空值 → 返回 default。⚠ 不能直接交给 split_provider_model —— 它对空串
        兜的是 "gemini"(它服务的是"用户明确选了厂商"的场景), 而各链路的默认厂商
        并不都是 gemini(精修默认 gpt5、超级 Agent 默认 claude)。漏了这一条,
        没传 model 的老任务会被静默改判到另一个厂商。
      - 厂商不在该链路允许的范围 → 返回 default(保持各链路原有的默认厂商不变)
      - 型号不在白名单(已下架/伪造) → 丢掉型号, 保留厂商, 用该厂商默认型号
      - 其余原样返回(含不带冒号的老值)
    """
    if not (spec or "").strip():
        return default
    provider, model = split_provider_model(spec)
    if provider not in allowed:
        return default
    if model and not is_allowed(provider, model):
        return provider
    return join_provider_model(provider, model)
