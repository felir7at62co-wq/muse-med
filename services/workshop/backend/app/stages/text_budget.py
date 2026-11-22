"""文本预算 —— 唯一决定"这一轮能给剧本文本多少字"的地方。

## 为什么要有这个模块（2026-10-10 审计结论）

审计发现全项目有 **13 处互不协调的硬编码预算常量**：

    _PREV_TEXT_BUDGET   =  9_000   chapter_gen.py
    _CTX_MAX_CHARS      = 200_000  storyboard_gen.py   ← 危险
    SKELETON_CHAR_BUDGET= 146_000  context_loader.py
    _NEIGHBOR_MAX_CHARS =  20_000  episode_render.py
    DEFAULT_DOC_CHARS   =  80_000  doc_context.py
    _FREEFORM_MAX_CHARS = 120_000  hardcheck.py
    ... 另有 7 处

这些数字**从没跟模型窗口对过账**。`_CTX_MAX_CHARS = 200_000` 在 128k 窗口的模型上
本身就超阈值；而在 1M 窗口上又把上下文压得过小、白丢信息。同一条剧集文本，
走不同路径拿到不同额度，质量随作者当时的心情浮动。

## 窗口前提（用户 2026-10-10 裁定）

> "模型总上下文长度几乎都能稳定 70 万左右，预算比例可以按你的方案设计。"

实测核对：当前主力 `gemini-3.6-flash` 登记窗口 1,000,000 token（可用 934,464），
压缩阈值 921,464 —— 与用户的 70 万经验值一致且有余量。

**这个数字直接改变了设计权重**：全库最大剧本实测 550,161 字 / 109 集，
按中文 ≈ 1 字 1 token 算，**全文装得下**。所以正确的策略是
「**全文优先，摘要是长剧兜底**」，而不是"默认用摘要省空间"。

（更正：审计初稿建议"摘要优先"，那是基于 128k 窗口的误判。以 70 万为准时，
多数剧本根本不需要摘要介入。）

## 比例怎么定

不让各调用点自己拍数字，而是从窗口倒推、按用途分配：

    usable = min(模型可用窗口, STABLE_INPUT_TOKENS)
    budget = usable × PURPOSE_RATIOS[purpose]

用途之间不共享一个池子 —— 它们发生在不同请求里，各自独享整个窗口。
"""
from __future__ import annotations

from ..agent.model_caps import get_capability

# ---------------------------------------------------------------------------
# 窗口前提
# ---------------------------------------------------------------------------

#: 用户 2026-10-10 实测口径："模型总上下文长度几乎都能稳定 70 万左右"。
#:
#: 为什么是"钳制"而不是"直接用模型窗口"：登记的 1M 是**理论上限**，实际在
#: 长 prompt 下会有衰减与限流，压到 70 万是稳妥的工程口径。模型窗口比它小的
#: （grok-4.6 的 256k、deepseek 的 128k）取小值，不硬套。
STABLE_INPUT_TOKENS = 700_000

#: 中文 ≈ 1 字 1 token。**故意取 1.0 而不是实测的 0.94** —— 预算宁可低估容量，
#: 也别高估（高估的后果是请求直接失败，不可恢复）。
CHARS_PER_TOKEN = 1.0

#: 各用途占可用窗口的比例。
#:
#: 比例之和**不需要**等于 1：这些用途发生在不同请求里，各自独享整个窗口。
#: 数字偏大是有意的 —— 中文短剧的正文密度高，能给就多给；
#: 真正超预算时由 `episode_text` 的分配器按优先级裁剪，而不是这里预先砍掉。
PURPOSE_RATIOS: dict[str, float] = {
    # 对话工坊：用户与 AI 聊剧本。要给足，否则 AI 看不见用户在说的那一集。
    "chat": 0.45,
    # 正文生成的前情（前几章原文）。
    "chapter_prev": 0.30,
    # 分镜生成的上下文（本集正文 + 邻集）。
    "storyboard": 0.50,
    # 上传文档的按需取用。
    "doc": 0.45,
    # 体检 / 硬伤通读：要"通读全剧"，给得最多。
    "check": 0.60,
    # 精修的事实抽取。
    "polish": 0.40,
    # 续写扩写。
    "continuation": 0.50,
}

#: 未知用途的兜底比例。
DEFAULT_RATIO = 0.40

#: 单次请求里，剧本文本至少要留出的空间（字符）。
#: 低于这个数就没有"给上下文"的意义了，不如让调用方直接报错。
MIN_TEXT_BUDGET_CHARS = 8_000


def usable_input_tokens(model: str | None) -> int:
    """这个模型实际可用于输入的 token 数。

    = min(模型可用窗口, STABLE_INPUT_TOKENS)

    模型不在登记表里时走 `DEFAULT_SPEC`（保守 128k），**绝不抛错**。
    """
    cap = get_capability(model)
    return max(4096, min(cap.usable_window, STABLE_INPUT_TOKENS))


def text_budget_chars(model: str | None, *, purpose: str) -> int:
    """这一轮能给"剧本文本"的字符预算。

    调用方拿到它之后应当**按优先级分配到具体的集**（见 episode_text.allocate），
    而不是自己拍一个数字再截断。
    """
    ratio = PURPOSE_RATIOS.get(purpose, DEFAULT_RATIO)
    raw = int(usable_input_tokens(model) * ratio / CHARS_PER_TOKEN)
    return max(MIN_TEXT_BUDGET_CHARS, raw)


def estimate_chars(text: str) -> int:
    """文本要吃多少 token（用于判断装不装得下）。

    与 `agent.compaction.estimate_tokens` 同口径，但**这里取上界**：
    预算宁可低估容量。CJK 按 1、拉丁按 4 字符 1 token，两者取大。
    """
    if not text:
        return 0
    n = len(text)
    cjk = sum(1 for c in text if "一" <= c <= "鿿")
    latin = n - cjk
    return max(cjk + latin // 4, n // 2, 1)


def fits(text: str, budget_chars: int) -> bool:
    """这段文本能不能进预算。"""
    return estimate_chars(text) <= budget_chars
