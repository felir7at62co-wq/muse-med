"""上下文压缩 (Context Compaction) —— 分层压缩，不靠截断。

对齐 Claude Code / Codex CLI / OpenCode 的成熟做法（三家的机制已交叉核对）：

  L0 剪枝   ：清掉旧工具输出的**内容**，保留调用记录，替换为占位文本。**零成本**。
  L1 微压缩 ：缓存感知的轻度收缩（本实现合并进 L0 的"保留最近窗口"策略）。
  L2 摘要   ：一次 LLM 调用生成「交接摘要」，用它替换全部更早的历史。
  L3 反应式 ：捕获上游 prompt_too_long 错误 → 立即压缩 → 重试一次。
  L4 熔断   ：连续 N 次压缩失败即停止重试，避免烧配额。

关键工程约束（跨工具共识，必须遵守）：

  1. **剪枝决策要单调。** 滑动窗口式剪枝会让 prompt-cache 前缀每步都失效，
     缓存成本反超压缩节省。因此本实现按"轮次边界"切，切过的不再变回去。
  2. **摘要要增量，不要反复重写全部历史。** 每轮把全部历史重新摘要会累积信息损失
     （用户反馈连续压缩后模型"跑偏"）。做法：摘要 + 新增内容合并。
  3. **用真实 usage token，不用 len/3 估算。** 估算不准会导致要么压太早、
     要么压太晚而请求失败。

阈值与预留见 model_caps.py（按模型能力算，不搞一刀切）。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from ..models.llm import get_llm
from .model_caps import compaction_threshold, get_capability

logger = logging.getLogger("compaction")

#: 保留多少条最近消息**原文**（Claude Code 默认 ~10）。
#: 额外约束：不能切断 tool_call 与其结果的配对（本项目的对话历史是纯 role/content，
#: 无工具配对问题，但保留此注释以备将来接入工具循环时遵守）。
KEEP_RECENT_MESSAGES = 10

#: 连续压缩失败多少次后熔断（Claude Code 的做法）。
MAX_CONSECUTIVE_FAILURES = 3

#: 剪枝时，工具/检索类消息超过此长度才剪（短的留着，省得破坏可读性）。
PRUNE_MIN_CHARS = 2000

_PRUNE_PLACEHOLDER = "[旧工具结果内容已清理，调用记录保留]"

#: 交接摘要提示词。合并 Codex CLI / OpenCode / Claude Code 三家的要点。
SUMMARY_PROMPT = """你正在做一次上下文交接压缩。为接手这个任务的另一个模型写一份交接摘要。

必须包含：
- 已完成的工作与关键结果
- 当前进行中的任务，以及卡在哪一步
- 重要的约束、用户偏好、用户明确提出的要求
- 关键决策及其理由（为什么这么选）
- 待办事项与明确的下一步
- 继续工作所需的关键数据与引用（如草稿 id、集号、文件名、字数设定）

不要包含：冗长的工具原始输出、已解决的错误细节、寒暄。

直接输出摘要正文，不要任何前言、标题或 markdown 代码块。"""

#: 摘要前缀（Codex 做法）：让接手的模型知道自己在接续谁的工作。
SUMMARY_PREFIX = (
    "另一个模型已经开始处理这个问题并留下了摘要。你也能看到它用过的工具状态。"
    "在此基础上继续，不要重复已完成的工作。摘要如下：\n\n"
)


@dataclass
class CompactionResult:
    """压缩结果：等价于一次 LLM 调用的产出。"""
    messages: list[dict]
    summary: str = ""
    pruned_chars: int = 0          # L0 剪掉的字符数
    compacted: bool = False        # 是否做了 L2 摘要
    reason: str = ""
    estimated_tokens_before: int = 0
    estimated_tokens_after: int = 0
    notes: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# token 估算（仅用于"决定要不要压"，不用于账目）
# ---------------------------------------------------------------------------

def estimate_tokens(text: str) -> int:
    """粗估 token 数。

    ⚠️ 这是**估算**，只在拿不到真实 usage 时用于判断"要不要压缩"。
    决策临界处宁可早压（多一次摘要调用）也不要晚压（请求直接失败）。

    中文约 1 字 ≈ 1 token（偏保守，实际常更少）；拉丁文本约 4 字符 ≈ 1 token。
    取两者中较大者，避免低估。
    """
    if not text:
        return 0
    n = len(text)
    cjk = sum(1 for c in text if "一" <= c <= "鿿")
    latin = n - cjk
    by_cjk = cjk + latin // 4
    by_len = n // 2                    # 混合文本的经验下限
    return max(by_cjk, by_len, 1)


def messages_tokens(messages: list[dict]) -> int:
    return sum(estimate_tokens(str(m.get("content") or "")) for m in messages or [])


# ---------------------------------------------------------------------------
# L0 剪枝（零成本，先做）
# ---------------------------------------------------------------------------

def prune_old_tool_outputs(messages: list[dict],
                           keep_recent: int = KEEP_RECENT_MESSAGES) -> tuple[list[dict], int]:
    """清掉较早的**超长非对话消息**内容，保留占位。

    本项目对话历史是 [{role, content}]，没有显式工具消息 —— 但用户粘贴的
    长文件、长原文会以用户消息形式进来，那些才是体积大头。策略：
      - 保留最近 keep_recent 条**完全不动**（原文，这是模型接续工作的依据）
      - 更早的消息里，超过 PRUNE_MIN_CHARS 的，内容替换为占位文本
      - **保留 role 与被裁剪的长度信息**，让模型知道"这里曾经有一大段内容"

    单调性：一旦被剪就永久是占位文本，不会因为窗口滑动而反复变化。

    返回 (新消息列表, 剪掉的字符数)。不改原列表。
    """
    if not messages:
        return [], 0
    n = len(messages)
    cut_upto = max(0, n - keep_recent)
    out: list[dict] = []
    pruned = 0
    for i, m in enumerate(messages):
        if i >= cut_upto:
            out.append(m)
            continue
        content = str(m.get("content") or "")
        if len(content) > PRUNE_MIN_CHARS:
            pruned += len(content)
            # 保留开头一小段作为线索，避免模型完全不知道这里是什么
            head = content[:200].replace("\n", " ")
            out.append({
                **m,
                "content": f"{_PRUNE_PLACEHOLDER}\n(原 {len(content)} 字符，开头为：{head}…)",
            })
        else:
            out.append(m)
    return out, pruned


# ---------------------------------------------------------------------------
# L2 摘要压缩（一次 LLM 调用）
# ---------------------------------------------------------------------------

async def summarize_history(messages: list[dict], *, provider: str = "gemini",
                            temperature: float = 0.2) -> str:
    """把消息历史压成一份交接摘要。失败抛异常（由调用方决定是否熔断）。"""
    if not messages:
        return ""
    # 拼接时给每条消息标注角色，让摘要模型知道谁说了什么
    body_parts: list[str] = []
    for m in messages:
        role = {"user": "用户", "assistant": "助手", "system": "系统"}.get(
            str(m.get("role") or ""), "其他")
        content = str(m.get("content") or "").strip()
        if content:
            body_parts.append(f"【{role}】{content}")
    body = "\n\n".join(body_parts)
    if not body.strip():
        return ""

    llm = get_llm("rewrite", temperature=temperature, provider=provider)
    resp = await llm.ainvoke([
        {"role": "system", "content": SUMMARY_PROMPT},
        {"role": "user", "content": body},
    ])
    summary = (getattr(resp, "content", "") or "").strip()
    if not summary:
        raise RuntimeError("摘要模型返回空内容")
    return summary


def build_compacted_messages(*, system_prompt: str, summary: str,
                             recent: list[dict]) -> list[dict]:
    """用 [摘要] + [最近 N 条原文] 重建消息列表。

    结构对齐成熟实现：
      [系统提示] + [摘要(带前缀)] + [最近原文]
    """
    out: list[dict] = [{"role": "system", "content": system_prompt}]
    if summary:
        out.append({"role": "user", "content": SUMMARY_PREFIX + summary})
        # 摘要作为"用户提供的背景"注入，助手回一句确认，使后续轮次自然接续
        out.append({"role": "assistant", "content": "收到，我基于以上背景继续。"})
    out.extend(recent)
    return out


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

class Compactor:
    """一次会话生命周期内的压缩器（记录熔断状态）。

    熔断状态放在实例里而不是全局，避免一个会话的失败影响其他会话。
    """

    def __init__(self) -> None:
        self.failures = 0
        self.last_summary: str = ""      # 增量摘要：上次的摘要作为本次的输入
        self.compressions = 0

    @property
    def tripped(self) -> bool:
        """是否已熔断（连续失败过多，不再尝试压缩）。"""
        return self.failures >= MAX_CONSECUTIVE_FAILURES

    def should_compact(self, messages: list[dict], *, model: str | None,
                       real_prompt_tokens: int | None = None) -> bool:
        """是否需要压缩。

        real_prompt_tokens: 上游返回的真实 usage.prompt_tokens（有则用它，最准）。
        """
        if self.tripped:
            return False
        used = real_prompt_tokens if real_prompt_tokens else messages_tokens(messages)
        return used >= compaction_threshold(model)

    async def compact(self, *, system_prompt: str, messages: list[dict],
                      model: str | None, provider: str = "gemini",
                      keep_recent: int = KEEP_RECENT_MESSAGES) -> CompactionResult:
        """执行压缩：先 L0 剪枝，仍超阈值才做 L2 摘要。

        返回 CompactionResult；失败时**原样返回输入**并把 failures+1（不抛错），
        保证调用方永远拿到可用的 messages。
        """
        before = messages_tokens(messages)
        res = CompactionResult(messages=list(messages), estimated_tokens_before=before)

        # ── L0：剪枝（零成本，先做）──
        pruned, pruned_chars = prune_old_tool_outputs(messages, keep_recent=keep_recent)
        if pruned_chars:
            res.pruned_chars = pruned_chars
            res.messages = pruned
            after_prune = messages_tokens(pruned)
            res.notes.append(f"剪枝释放约 {pruned_chars} 字符")
        else:
            after_prune = before

        # 剪枝后就够了 → 不做 LLM 摘要（省钱）
        if after_prune < compaction_threshold(model):
            res.reason = "仅剪枝即达标"
            res.estimated_tokens_after = after_prune
            return res

        # ── L2：摘要压缩（一次 LLM 调用）──
        if self.tripped:
            res.reason = "已熔断，跳过摘要"
            res.estimated_tokens_after = after_prune
            return res

        # 要摘要的部分 = 除最近 keep_recent 条以外的全部
        cut = max(0, len(pruned) - keep_recent)
        older, recent = pruned[:cut], pruned[cut:]
        # 增量摘要：把上次摘要作为"已压缩历史"的一部分一起喂进去，而不是丢弃它
        to_summarize = list(older)
        if self.last_summary:
            to_summarize = [{"role": "user", "content": f"【此前的压缩摘要】{self.last_summary}"}] + to_summarize

        try:
            summary = await summarize_history(to_summarize, provider=provider)
            self.last_summary = summary      # 记住，供下次增量合并
            self.failures = 0
            self.compressions += 1
            new_msgs = build_compacted_messages(
                system_prompt=system_prompt, summary=summary, recent=recent)
            res.messages = new_msgs
            res.summary = summary
            res.compacted = True
            res.reason = "剪枝 + 摘要"
            res.estimated_tokens_after = messages_tokens(new_msgs)
            logger.info(
                "compaction: %d→%d tokens (剪枝 %d 字符, 摘要 %d 字)",
                before, res.estimated_tokens_after, pruned_chars, len(summary),
            )
        except Exception as e:  # noqa: BLE001
            self.failures += 1
            res.reason = f"摘要失败({self.failures}/{MAX_CONSECUTIVE_FAILURES}): {e}"
            res.estimated_tokens_after = after_prune
            logger.warning("compaction 摘要失败: %s", e)
            if self.tripped:
                res.notes.append("压缩已熔断：连续失败过多，后续不再尝试")
                logger.error("compaction 熔断（连续 %d 次失败）", self.failures)
        return res


def looks_like_context_overflow(err: BaseException | str) -> bool:
    """判断异常是否是上游的"上下文超限"错误（L3 反应式压缩的触发器）。

    各中转站的措辞不一致，所以做宽松匹配。
    """
    s = str(err).lower()
    keys = (
        "prompt_too_long", "context_length_exceeded", "maximum context length",
        "context window", "too many tokens", "reduce the length",
        "exceeds the maximum", "input is too long", "request too large",
        "tokens in the messages", "超过最大长度", "上下文超", "too long",
    )
    return any(k in s for k in keys)


__all__ = [
    "Compactor", "CompactionResult", "SUMMARY_PROMPT", "SUMMARY_PREFIX",
    "KEEP_RECENT_MESSAGES", "MAX_CONSECUTIVE_FAILURES", "PRUNE_MIN_CHARS",
    "estimate_tokens", "messages_tokens", "prune_old_tool_outputs",
    "summarize_history", "build_compacted_messages", "looks_like_context_overflow",
]
