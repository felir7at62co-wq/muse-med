"""模型能力登记表 (Model Capabilities) —— 上下文窗口 / 输出预留 / 压缩阈值。

为什么需要它：
  各模型的上下文上限差异极大（200k 与 1M 并存），而压缩阈值、输出预留都必须
  按**具体模型**算，不能一刀切。Codex CLI 用 max(output_limit, 20000) 的保守默认，
  那是 GPT-5 时代的产物 —— 实测本项目真实用量（llm_usage_logs 11,375 条有效记录）
  completion_tokens p99 = 24,608，20000 连 p99 都兜不住。

本项目的特殊约束（决定了预留怎么算）：
  `models/llm.py:370-384` 有既定全局策略 —— **不下发 max_tokens**。原因是平台在用的
  全是推理模型，reasoning token 与正文共享同一预算，任何"按正文长度算预算"的方案
  都会失效（draft 1273 截断事故）。因此这里的输出预留必须覆盖【思维链 + 正文】。

设计原则：
  1. **保守优先**：不确定的模型按小窗口 + 大预留守。压得太晚 = 请求直接失败；
     压得太早 = 多一次摘要调用。前者不可恢复，后者只是多花一点钱。
  2. **可探测**：`PROBE_SPECS` 供收尾阶段的实测脚本使用（见 docs 收尾工作一节）。
  3. **未知模型有兜底**：不在表里的模型走 `DEFAULT_SPEC`，绝不抛错。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger("model_caps")


@dataclass(frozen=True)
class Capability:
    """一个模型的能力画像。"""
    context_window: int          # 上下文总窗口(token)
    output_reserve: int          # 给"输出"预留的 token(含 reasoning)
    note: str = ""

    @property
    def usable_window(self) -> int:
        """可用于输入的窗口 = 总窗口 − 输出预留。"""
        return max(4096, self.context_window - self.output_reserve)


# 输出预留的钳制区间。下限依据见模块 docstring（实测 p99 = 24,608）：
#   下限 32768 = 兜住 p99 并给 reasoning 留空间。低于此值，长文场景会"刚压完又超"，
#              白白烧一次摘要调用，反而更贵。
#   上限 131072 = 再高就没有压缩的意义了（预留把窗口吃光）。
RESERVE_FLOOR = 32_768
RESERVE_CEIL = 131_072


def compute_reserve(p99_output_tokens: int | None = None,
                    hard_output_limit: int | None = None) -> int:
    """算输出预留。

    优先级：
      1. 有硬输出上限（模型元数据明确给出）→ 用它，但仍受钳制区间约束
      2. 没有 → 实测 p99 × 2（×2 是给 reasoning + 波动留余量）
      3. 都没有 → 用下限
    """
    if hard_output_limit and hard_output_limit > 0:
        return max(RESERVE_FLOOR, min(RESERVE_CEIL, int(hard_output_limit)))
    if p99_output_tokens and p99_output_tokens > 0:
        return max(RESERVE_FLOOR, min(RESERVE_CEIL, int(p99_output_tokens * 2)))
    return RESERVE_FLOOR


# ---------------------------------------------------------------------------
# 各模型能力表
#
# ⚠️ 这里的数值是**保守估计**，不是厂商公布的精确值。理由：经中转站调用时，
#    真实窗口以中转站为准，厂商文档不可直接采信。收尾阶段会做逐模型实测
#    （见 PROBE_SPECS 与 docs），届时用实测值替换。
#
# 收尾实测后再校准的参数：context_window / output_reserve。
# ---------------------------------------------------------------------------
DEFAULT_SPEC = Capability(
    context_window=128_000,
    output_reserve=RESERVE_FLOOR,
    note="未知模型的保守兜底",
)

_SPECS: dict[str, Capability] = {
    # ── Gemini ──────────────────────────────────────────────────────────
    # 3.x 系列普遍为 1M 级窗口；轻量档(lite)窗口与输出都更小。
    "gemini-3.8-flash":        Capability(1_000_000, 65_536, "3.x 主力"),
    "gemini-3.7-flash":        Capability(1_000_000, 65_536),
    "gemini-3.6-flash":        Capability(1_000_000, 65_536, "本项目实测主力"),
    "__REDACTED__":        Capability(1_000_000, 65_536),
    "__REDACTED__-lite":   Capability(1_000_000, RESERVE_FLOOR, "轻量档"),
    "gemini-3.1-pro":          Capability(1_000_000, 65_536, "pro 档"),
    "__REDACTED__":  Capability(1_000_000, 65_536),
    "gemini-3.1-flash-lite":   Capability(1_000_000, RESERVE_FLOOR, "轻量档"),
    "gemini-3.1-flash-lite-preview": Capability(1_000_000, RESERVE_FLOOR),
    "gemini-3-flash-preview":  Capability(1_000_000, 65_536),
    "gemini-3-pro-preview":    Capability(1_000_000, 65_536, "Google 已下线"),
    "gemini-2.5-pro":          Capability(1_000_000, RESERVE_FLOOR, "老一代"),
    "gemini-2.5-flash":        Capability(1_000_000, RESERVE_FLOOR, "老一代"),
    "gemini-2.5-flash-lite":   Capability(1_000_000, RESERVE_FLOOR, "老一代轻量"),

    # ── Grok ────────────────────────────────────────────────────────────
    "grok-4.6":                Capability(256_000, RESERVE_FLOOR),
    "grok-4.5":                Capability(256_000, RESERVE_FLOOR),
    "grok-4.3":                Capability(256_000, RESERVE_FLOOR),
    "grok-4.20-0309-reasoning":     Capability(256_000, 65_536, "推理档"),
    "grok-4.20-0309-non-reasoning": Capability(256_000, RESERVE_FLOOR, "非推理档"),
    "grok-4":                  Capability(131_072, RESERVE_FLOOR, "老一代"),

    # ── GPT ─────────────────────────────────────────────────────────────
    "gpt-6-astra":             Capability(400_000, 65_536),
    "gpt-5.6-luna":            Capability(400_000, 65_536),
    "gpt-5.6-sol":             Capability(400_000, 65_536),
    "gpt-5.6-terra":           Capability(400_000, 65_536),
    "gpt-5.5":                 Capability(400_000, 65_536, "实测可写 2 万字"),
    "gpt-5.5-pro":             Capability(400_000, 65_536, "pro 档"),
    "gpt-5.4":                 Capability(400_000, 65_536),
    "gpt-5.4-mini":            Capability(400_000, RESERVE_FLOOR, "轻量档"),
    "gpt-5.4-nano":            Capability(400_000, RESERVE_FLOOR, "轻量档"),
    "gpt-5.4-pro":             Capability(400_000, 65_536, "pro 档"),
    "gpt-5.2":                 Capability(400_000, RESERVE_FLOOR, "老一代"),
    "gpt-5.1":                 Capability(400_000, RESERVE_FLOOR, "老一代"),
    "gpt-5":                   Capability(400_000, RESERVE_FLOOR, "老一代"),
    "gpt-5-pro":               Capability(400_000, 65_536, "老一代 pro"),
    "gpt-5-mini":              Capability(400_000, RESERVE_FLOOR, "老一代轻量"),
    "gpt-5-nano":              Capability(400_000, RESERVE_FLOOR, "老一代轻量"),
    "gpt-5-chat-latest":       Capability(400_000, RESERVE_FLOOR, "老一代对话档"),

    # ── DeepSeek ────────────────────────────────────────────────────────
    "__REDACTED__":         Capability(128_000, RESERVE_FLOOR),
    "deepseek-v4-flash":       Capability(128_000, RESERVE_FLOOR),
    "__REDACTED__-0813":    Capability(128_000, RESERVE_FLOOR, "快照版"),
    "deepseek-v4-flash-0731":  Capability(128_000, RESERVE_FLOOR, "快照版"),
    "deepseek-v3.2":           Capability(128_000, RESERVE_FLOOR, "老一代"),
}

#: 收尾阶段实测用：每个 provider 挑代表模型探测真实窗口与输出能力。
PROBE_SPECS: dict[str, list[str]] = {
    "gemini": ["gemini-3.6-flash", "gemini-3.1-pro", "__REDACTED__-lite"],
    "gpt5": ["gpt-5.5", "gpt-5.4-mini", "gpt-6-astra"],
    "deepseek": ["__REDACTED__", "deepseek-v4-flash"],
    "grok": ["grok-4.6", "grok-4.3"],
}


def get_capability(model: str | None) -> Capability:
    """查模型能力。未知模型返回保守兜底，绝不抛错。

    模糊匹配：带日期快照后缀(-0813/-0309)或渠道后缀的型号，先精确查，
    查不到再按前缀归一到已知型号。
    """
    if not model:
        return DEFAULT_SPEC
    m = str(model).strip().lower()
    if m in _SPECS:
        return _SPECS[m]
    # 前缀归一：__REDACTED__-0813 → __REDACTED__
    for known, cap in _SPECS.items():
        if m.startswith(known):
            return cap
    logger.debug("模型 %s 无能力登记, 用保守兜底 %s", model, DEFAULT_SPEC)
    return DEFAULT_SPEC


# 安全余量：留出"发起压缩请求本身 + 系统提示波动"的空间。
SAFETY_MARGIN = 13_000


def compaction_threshold(model: str | None) -> int:
    """触发压缩的 token 阈值。"""
    cap = get_capability(model)
    return max(8192, cap.usable_window - SAFETY_MARGIN)


__all__ = [
    "Capability", "DEFAULT_SPEC", "PROBE_SPECS",
    "RESERVE_FLOOR", "RESERVE_CEIL", "SAFETY_MARGIN",
    "compute_reserve", "get_capability", "compaction_threshold",
]
