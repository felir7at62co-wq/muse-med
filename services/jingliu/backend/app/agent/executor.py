"""工具执行层：权限、报价、审计、副作用全部在这里收口。

**所有工具调用都必须经过 `execute_tool`**，包括只读的。理由：

  · 权限（role）在这里校验 —— 工具自己校验容易漏，而漏的后果是越权；
  · 审计在这里落库 —— 散在几十个工具里写 `add_step` 必然有的写有的忘；
  · 花费在这里记账 —— 花钱工具自己记，等于让被审计者记账。

没有每轮预算上限（2026-11-02 删除）；钱由账户余额兜底。

"要不要人确认"**不在这里**，只在图的审批节点判一次（见 policy 头注释）。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass

from ..redact import redact_json_text, redact_text

logger = logging.getLogger("fw.agent.executor")

#: 单步结果落库的截断长度。全片出片的返回体可能几十 KB，
#: 原样存会让步骤表迅速膨胀，而用户真正要看的只有前面那几行。
RESULT_CAP = 8000


class ToolDenied(Exception):
    """工具被拒（权限不足等）。**不是故障**，是要汇报给模型的事实。"""


@dataclass
class ToolCtx:
    """一次 run 的执行上下文。由 runner 构造，闭包进每个工具。"""

    run_id: str
    project_id: str
    user_id: int | None
    role: str                      # owner|manager|editor|viewer|None
    #: 历史字段，已不参与任何判断（每轮预算上限 2026-11-02 删除）。
    cap_fen: int = 0
    spent_fen: int = 0
    model: str = "gpt-6.1-sol"
    #: 当前 tool_call 的 id（registry 用 InjectedToolCallId 拿到后由 execute_tool 写入）。
    #: 确定性 job id 靠它：为空时同一轮的两次同类调用会撞同一个 job id。
    tool_call_id: str = ""

    def remaining_fen(self) -> int:
        return max(0, self.cap_fen - self.spent_fen)


# ---------------------------------------------------------------------------
# 权限
# ---------------------------------------------------------------------------

_ROLE_RANK = {"viewer": 1, "editor": 2, "manager": 3, "owner": 4}


def role_allows(role: str | None, need: str) -> bool:
    """当前档位是否够用。role=None（不是成员）一律拒绝。"""
    if role is None:
        return False
    return _ROLE_RANK.get(role, 0) >= _ROLE_RANK.get(need, 99)


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

async def execute_tool(ctx: ToolCtx, spec, kwargs: dict, call_id: str = "") -> str:
    """执行一个工具，返回**字符串**（ToolMessage 的内容）。

    只做三件事：权限 → 报价 → 执行并记账。

    ⚠️ **这里不判"要不要人确认"**。那只在图的审批节点判一次（`policy.needs_confirm`），
    走到这里的调用要么不需要确认、要么用户已经点过头。2026-10-21 之前这里会再判
    一次、且不知道刚批过，于是批准了也执行不了。

    为什么返回字符串而不是 dict：LangGraph 会把返回值原样塞进 ToolMessage，
    返回 dict 会被序列化成 Python repr（单引号、True/False），模型读起来费劲。
    """
    from . import policy, store

    name = spec.name

    # ---- ① 权限 ----
    if not role_allows(ctx.role, spec.role):
        return _err(f"权限不足：需要「{spec.role}」档，当前是「{ctx.role or '非成员'}」")

    # ---- ② 报价 ----
    # 只报价、不设上限（2026-11-02 用户裁定：「直接删掉预算的设计，这个没用也不该成为限制」）。
    # 真正的钱由账户余额兜底：余额不够时 charge 扣款会抛「余额不足」，那条路径不变。
    est, _note = policy.estimate_for(spec, kwargs)

    # ---- ③ 执行 ----
    prev_cid = ctx.tool_call_id
    ctx.tool_call_id = call_id or ""
    try:
        out = await spec.fn(ctx, **kwargs)
    except ToolDenied as e:
        return _err(str(e))
    except Exception as e:  # noqa: BLE001 — 工具失败不该炸掉整轮 run
        logger.exception("[agent] 工具 %s 执行失败", name)
        store.add_step(ctx.run_id, kind="tool_result", tool=name,
                       result=f"{type(e).__name__}: {e}", ok=0,
                       estimate_fen=est)
        return _err(f"工具执行失败：{type(e).__name__}: {e}")
    finally:
        ctx.tool_call_id = prev_cid

    # ---- ④ 记账 ----
    text = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False,
                                                      default=str)
    # 工具结果会进模型上下文、桌面端会话和步骤表：先去掉密钥（见 app/redact.py）。
    text = redact_json_text(text) or text
    # ⚠️ **扣减与展示是两件事，别合并**。
    #
    # `cost_fen` = 这个工具自己往 `ctx.spent_fen` 里加过的钱；工具不返回它
    # 就说明它没自己记账（只读工具、改数据工具）。此前只读 `cost_fen`，
    # 于是提交型工具的步骤行 `cost_fen` 恒为 0 —— 界面上每一步都看不到钱，
    # 用户只看到最后汇总的 token 费（2026-10-23「已花 ¥0.36」困惑的一半）。
    #
    # 但**不能让 executor 拿 `estimate_fen` 去加 `spent_fen`**：提交型工具在
    # `registry.submit_idempotent` 里已经加过一次了，再加一次就是双倍扣预算。
    # 所以：展示值退到报价，扣减值仍只认 `cost_fen`。
    cost = int(out.get("cost_fen") or 0) if isinstance(out, dict) else 0
    shown_cost = cost
    if not shown_cost and isinstance(out, dict):
        shown_cost = int(out.get("estimate_fen") or 0)
    ctx.spent_fen += cost
    store.add_step(ctx.run_id, kind="tool_result", tool=name,
                   result=text[:RESULT_CAP], ok=1,
                   estimate_fen=est, cost_fen=shown_cost,
                   decided_by=ctx.user_id)
    return text


def _err(msg: str) -> str:
    """给模型的错误返回。**必须是 JSON 且带 ok=false** ——
    纯文本错误会让模型以为是正常结果继续往下走（实测过）。"""
    return json.dumps({"ok": False, "error": redact_text(msg) or msg}, ensure_ascii=False)
