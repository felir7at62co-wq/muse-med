"""LangGraph 图：state / 节点 / 路由。

## 为什么是这张图

```
START → model ─┬─ 无 tool_calls ───────────────────────→ END
               ├─ 普通调用（含花钱，受账户余额约束）──→ tools ──→ model
               └─ 找不回来的操作 ─→ approve ─┬─ 批准 → tools → model
                                             └─ 驳回 → END（用户回一句话就在同一轮接着做）
```

## 三条踩过的坑，改动前必读

1. **`interrupt()` 不能写在工具里**（实测 `ToolNode` 内部拿不到 config）。
   审批必须是**独立节点**。

2. **审批节点必须 async 且手动灌 contextvar**（Python 3.10）。
   `langgraph.config.get_config()` 对 3.10 的 async 上下文直接抛
   `Called get_config outside of a runnable context`，而生产就是 3.10.12。
   见 `_prepare_async_node`。

3. **审批节点必须无副作用**。LangGraph 在 `Command(resume=...)` 之后会
   **从头重跑整个节点**，而不是从 `interrupt()` 那一行继续。所以"批准后真正执行"
   必须发生在后面的 `tools` 节点里。
"""
from __future__ import annotations

import json
import logging
from typing import Annotated, Any, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langgraph.config import var_child_runnable_config
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langgraph.types import interrupt

logger = logging.getLogger("fw.agent.graph")


# ---------------------------------------------------------------------------
# inbox 的 reducer
# ---------------------------------------------------------------------------

def merge_inbox(left: list[dict] | None, right: list[dict] | None) -> list[dict]:
    """用户插话队列的合并规则。**空列表 = 清空**。

    ## 为什么不能直接用 `operator.add`

    计划里写的是 `Annotated[list[dict], operator.add]` + "节点返回 [] 把它清空"，
    但这两件事在 `operator.add` 下是**互斥**的：`old + [] == old`，
    节点返回空列表只会追加零个元素，**永远清不掉**。于是同一句话会在每一轮
    model 节点被重复读到，模型会以为用户一直在催同一件事。

    所以用自定义 reducer，显式约定：
      · `right` 为空（`[]` / `None`）→ 清空队列。model 节点读完就返回 `{"inbox": []}`；
      · 否则 → 追加，并按 `seq` 去重（runner 重放时可能把同一句再灌一次）。
    """
    if not right:
        return []
    out = list(left or [])
    seen = {x.get("seq") for x in out if isinstance(x, dict) and x.get("seq") is not None}
    for it in right:
        if not isinstance(it, dict):
            continue
        seq = it.get("seq")
        if seq is not None and seq in seen:
            continue          # 重放：同一句话已经在队列里了
        out.append(it)
        if seq is not None:
            seen.add(seq)
    return out


class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    run_id: str
    project_id: str
    stage: str
    cap_fen: int
    #: 预扣口径的花费（见 store.recalc_spent 的说明）
    spent_fen: int
    todo: list[dict]
    #: 用户中途插的话（§10.3）。**model 节点开头排空**，不直接进 messages。
    #:
    #: ⚠️ reducer 是 `merge_inbox`，不是 `operator.add`，也不是 `add_messages`：
    #:   · `add_messages` 是消息归并语义，会按 id 去重/替换；
    #:   · `operator.add` 清不掉（`old + [] == old`），同一句话会被反复读到。
    #: 见 `merge_inbox` 的说明。
    inbox: Annotated[list[dict], merge_inbox]


# ---------------------------------------------------------------------------
# 节点
# ---------------------------------------------------------------------------

def _prepare_async_node(fn):
    """让 async 节点在 Python 3.10 下也能用 `interrupt()`。

    ⚠️ 这不是可选的兼容层，是**必需**的：langgraph 1.1.10 的
    `get_config()` 内有

        if sys.version_info < (3, 11):
            if asyncio.current_task():
                raise RuntimeError("Python 3.11 or later required…")

    而生产是 3.10.12。实测任何 async 节点里直接 `interrupt()` 都抛
    `Called get_config outside of a runnable context`。

    解法是把本次运行的 config 手动塞进 langgraph 用的那个 contextvar
    ——这正是 `get_config()` 要读的东西。同步节点没这个问题（走线程池，
    `asyncio.current_task()` 为空），但同步节点里的阻塞调用会卡住事件循环，
    所以统一用 async + 本包装。
    """
    async def wrapper(state, config=None):
        if config is not None:
            var_child_runnable_config.set(config)
        return await fn(state)
    wrapper.__name__ = getattr(fn, "__name__", "node")
    return wrapper


def make_model_node(llm_factory, tools_schema: list[dict], store):
    """模型节点：一次带工具的对话。"""
    async def _node(state: AgentState):
        from ..config import get_settings
        from . import prompt as prompt_mod

        llm = llm_factory()
        msgs = [{"role": "system",
                 "content": prompt_mod.system_prompt(
                     state["project_id"], state.get("stage") or "")}]
        msgs += fit_context(_to_openai_messages(state["messages"]), get_settings().agent_context_chars)

        # ---- 中途插话（§10.3）----
        # ⚠️ 必须在**发出去的消息**里追加，并且与"清空 inbox"在同一个返回值里完成。
        # 顺序反了（先返回再读）会在 resume 时被 checkpoint 覆盖，用户说的话就丢了。
        pending = _drain_inbox(state)
        if pending:
            msgs.append({
                "role": "user",
                "content": "[用户中途指示] " + "；".join(pending),
            })

        msg = await llm.chat_with_tools(msgs, tools_schema)

        # token 记账：按 2 元/百万 折算（pricing.agent_llm_cost）
        u = msg.get("_usage") or {}
        total_tok = int(u.get("total_tokens") or 0)
        if total_tok:
            store.add_tokens(state["run_id"], total_tok)

        ai = _to_ai_message(msg)
        text = (msg.get("content") or "").strip()
        if text:
            store.add_step(state["run_id"], kind="message", result=text[:4000])
        for tc in (msg.get("tool_calls") or []):
            store.add_step(state["run_id"], kind="tool_call",
                           tool=tc["function"]["name"],
                           args=json.dumps(tc["function"].get("arguments"),
                                           ensure_ascii=False)[:4000])
        out: dict = {"messages": [ai], "inbox": []}
        return out
    return _prepare_async_node(_node)


def _drain_inbox(state: AgentState) -> list[str]:
    """取出并清空 inbox 里的用户插话。

    读的时候就把 `AgentStep(kind="ack")` 补上：用户必须看到"我说的话它读到了"，
    否则他会重复说三遍。这一步在**模型调用之前**做（而不是之后），
    因为模型可能在等一个 300 秒的 job —— 确认要立刻可见。
    """
    items = state.get("inbox") or []
    texts: list[str] = []
    for it in items:
        t = (it or {}).get("text") if isinstance(it, dict) else str(it or "")
        t = (t or "").strip()
        if t:
            texts.append(t)
    if texts:
        store = _STORE_FOR_ACK.get()
        if store is not None:
            store.add_step(state["run_id"], kind="ack",
                           result="已收到，将在下一步处理")
    return texts


#: ack 步骤要写库，但 `_drain_inbox` 是个纯函数式的小工具，不想为它加参数。
#: 用一个模块级 contextvar 由 runner 设置 —— 单线程事件循环里不存在串号。
import contextvars

_STORE_FOR_ACK: contextvars.ContextVar[Any] = contextvars.ContextVar(
    "agent_store_for_ack", default=None)


def bind_store(store):
    """把 store 绑到本 context，供 `_drain_inbox` 写 ack 步骤。"""
    return _STORE_FOR_ACK.set(store)


def reset_ack_store(tok) -> None:
    try:
        _STORE_FOR_ACK.reset(tok)
    except (ValueError, LookupError):
        pass


def make_approve_node(registry_mod, policy_mod, store):
    """确认闸门：**只拦真正找不回来的操作**（`policy.needs_confirm`）。

    批准之前无副作用（批准后 LangGraph 会从头重跑本节点，interrupt 直接返回决定）。
    批准后图走到 tools 节点，执行器**不再判第二次** —— 判据只有这一处。
    """
    async def _node(state: AgentState):
        last = state["messages"][-1]
        calls = getattr(last, "tool_calls", None) or []
        items = []
        total = 0
        for tc in calls:
            spec = registry_mod.get_spec(tc["name"])
            if spec is None:
                continue
            est, note = policy_mod.estimate_for(spec, tc.get("args") or {})
            total += est
            items.append({
                "tool": tc["name"],
                "args": tc.get("args") or {},
                "needs_confirm": policy_mod.needs_confirm(spec, tc.get("args") or {}),
                "what": policy_mod.confirm_text(spec, tc.get("args") or {}),
                "estimate_fen": est,
                "estimate_note": note,
            })
        if not items:
            return {}

        # 进度：这一轮到目前为止成功执行了几次同类工具。
        # 用户在连续审批里唯一的信息是"还要点几次"——不报总数的话，
        # 他点到第五张就以为"每五组一轮"，再问还有没有（2026-10-27 用户反馈）。
        from . import store as _st
        done = _st.count_tools(state["run_id"])
        for it in items:
            it["done_so_far"] = done.get(it["tool"], 0)
            it["summary"] = _item_summary(it["tool"], it["args"])

        decision = interrupt({
            "kind": "approval",
            "calls": items,
            "estimate_fen": total,
            "spent_fen": state.get("spent_fen") or 0,
            "cap_fen": state.get("cap_fen") or 0,
            "question": _question(items),
        })

        if not decision or not decision.get("ok"):
            reason = (decision or {}).get("reason") or "用户未批准"
            store.add_step(state["run_id"], kind="approval",
                           result=f"驳回：{reason}", approval="rejected",
                           decided_by=(decision or {}).get("by"))
            # 把工具调用清掉，让模型看到"被驳回"而不是"执行完了"
            return {"messages": [AIMessage(content=
                    f"用户没有批准这一步（{reason}）。请换一个方案，或向用户说明为什么需要它。")]}
        store.add_step(state["run_id"], kind="approval",
                       result="已批准", approval="approved",
                       decided_by=decision.get("by"))
        return {}
    return _prepare_async_node(_node)


_CONFIRM_CN = {
    "import_script": "用新剧本替换整个剧本（旧剧本不留历史）",
    "run_breakdown": "强制重新拆解（会删掉这些集已有的镜头）",
}


def _question(items: list[dict]) -> str:
    what = "；".join(x.get("what") or _CONFIRM_CN.get(x["tool"], x["tool"])
                    for x in items if x.get("needs_confirm"))
    return f"要{what}，这一步做了就找不回来。确认吗？"


def _item_summary(tool: str, args: dict) -> str:
    """一次调用**具体在动什么**（谁并进谁）。只给工具名，用户无从判断该不该点。

    只覆盖需要人点头的那几个；其余返回空串，卡片照旧显示 `what`。
    名字一律从库里现查：args 里只有 id，而"把 3 个 id 并成一个"对人没有意义。
    """
    if tool != "merge_assets":
        return ""
    try:
        ids = [str(x) for x in (args.get("asset_ids") or [])]
        if not ids:
            return ""
        from ..db import Asset, get_session
        with get_session() as s:
            names = {a.id: a.name for a in
                     (s.get(Asset, i) for i in ids) if a is not None}
        keep = names.get(str(args.get("keep_id") or ""))
        drops = [names.get(i) or i for i in ids if names.get(i) != keep]
        if not names:
            return ""
        head = ("合并进「{}」".format(keep) if keep else "合并")
        return f"{head}：{'、'.join(f'「{d}」' for d in drops)}"
    except Exception:  # noqa: BLE001 — 摘要失败不能挡住审批
        return ""


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------

def make_router(registry_mod, policy_mod):
    def route(state: AgentState):
        last = state["messages"][-1]
        calls = getattr(last, "tool_calls", None) or []
        if not calls:
            return END
        for tc in calls:
            spec = registry_mod.get_spec(tc["name"])
            # 未知工具交给 tools 节点（它会返回"没有这个工具"给模型）
            if spec is not None and policy_mod.needs_confirm(spec, tc.get("args") or {}):
                return "approve"
        return "tools"
    return route


def route_after_approve(state: AgentState):
    last = state["messages"][-1]
    if isinstance(last, AIMessage) and not (getattr(last, "tool_calls", None) or []):
        return END
    return "tools"


# ---------------------------------------------------------------------------
# 构建
# ---------------------------------------------------------------------------

def build_graph(*, registry_mod, policy_mod, store, ctx, tools_schema: list[dict],
                llm_factory=None):
    """编译好的图（未挂 checkpointer，由 runner 挂）。

    `llm_factory` 用于测试注入脚本化的假模型。**只替换模型调用**，
    工具执行仍走真实路径 —— 只替换模型不替换工具，否则等于没测。
    """
    factory = llm_factory or (lambda: _llm(ctx))
    tree = StateGraph(AgentState)
    tree.add_node("model", make_model_node(factory, tools_schema, store))
    tree.add_node("approve", make_approve_node(registry_mod, policy_mod, store))

    lc_tools = registry_mod.build_langchain_tools(ctx)
    tree.add_node("tools", ToolNode(lc_tools))

    tree.add_edge(START, "model")
    tree.add_conditional_edges("model", make_router(registry_mod, policy_mod),
                               {"approve": "approve", "tools": "tools", END: END})
    tree.add_conditional_edges("approve", route_after_approve,
                               {"tools": "tools", END: END})
    tree.add_edge("tools", "model")
    return tree


def _llm(ctx):
    from ..providers.llm import LLMProvider
    return LLMProvider(model_id=ctx.model)


# ---------------------------------------------------------------------------
# 消息格式转换（langchain ↔ OpenAI）
# ---------------------------------------------------------------------------

#: 缩旧工具结果时不动最近这几条：模型正在用它们。
_FIT_KEEP_RECENT = 8
_FIT_TOOL_CHARS = 500


def _size(m: dict) -> int:
    return len(str(m.get("content") or "")) + len(json.dumps(m.get("tool_calls") or "", ensure_ascii=False))


def fit_context(msgs: list[dict], limit: int) -> list[dict]:
    """把要发给模型的历史压到 `limit` 字符以内。只影响这次请求，checkpoint 里的完整历史不动。

    服务端 Agent 的一轮可以被反复接续，历史只增不减，不压的话迟早超过模型窗口，每步的
    费用也跟着涨。依次：缩旧工具结果 → 省略最早的对话（保留第一句，那是用户的目标）→
    截断最后还放不下的单条。省略从非 tool 消息处开始，否则 tool 结果找不到对应的调用，上游 400。
    """
    if sum(_size(m) for m in msgs) <= limit:
        return msgs
    out = [dict(m) for m in msgs]
    for m in out[:-_FIT_KEEP_RECENT]:
        c = m.get("content")
        if m.get("role") == "tool" and isinstance(c, str) and len(c) > _FIT_TOOL_CHARS:
            m["content"] = c[:_FIT_TOOL_CHARS] + f"…（已省略，原长 {len(c)} 字；需要时重新读取）"
    total = sum(_size(m) for m in out)
    if total > limit and len(out) > 2:
        i = 1
        while i < len(out) - 1 and (total > limit or out[i].get("role") == "tool"):
            total -= _size(out[i])
            i += 1
        out = [out[0], {"role": "user", "content": "[更早的对话已省略；需要时重新读取项目状态]"}, *out[i:]]
    for m in sorted(out, key=_size, reverse=True):
        over = sum(_size(x) for x in out) - limit
        c = m.get("content")
        if over <= 0 or not isinstance(c, str) or len(c) <= over:
            continue
        m["content"] = c[:len(c) - over] + "…（已截断）"
    return out


def _to_openai_messages(msgs: list[BaseMessage]) -> list[dict]:
    """LangChain 消息 → OpenAI messages。

    为什么手写而不依赖 langchain 的转换器：ToolMessage 必须带
    `tool_call_id`，而 LangChain 在某些版本会把它放在 additional_kwargs 里
    而不是顶层 —— 缺了它上游直接 400。手写一遍比追版本行为省心。
    """
    out: list[dict] = []
    for m in msgs:
        if isinstance(m, ToolMessage):
            out.append({"role": "tool", "tool_call_id": m.tool_call_id,
                        "content": _text_of(m.content)})
        elif isinstance(m, AIMessage):
            row: dict = {"role": "assistant", "content": _text_of(m.content) or ""}
            tcs = getattr(m, "tool_calls", None) or []
            if tcs:
                row["tool_calls"] = [{
                    "id": tc["id"],
                    "type": "function",
                    "function": {"name": tc["name"],
                                 "arguments": json.dumps(tc.get("args") or {},
                                                         ensure_ascii=False)},
                } for tc in tcs]
            out.append(row)
        else:
            role = "system" if m.type == "system" else "user"
            out.append({"role": role, "content": _text_of(m.content)})
    return out


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict):
                parts.append(str(c.get("text") or ""))
            else:
                parts.append(str(c))
        return "".join(parts)
    return str(content or "")


def _to_ai_message(msg: dict) -> AIMessage:
    tcs = []
    for tc in (msg.get("tool_calls") or []):
        fn = tc.get("function") or {}
        args = fn.get("arguments")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except ValueError:
                args = {"_raw": args}
        tcs.append({"id": tc.get("id") or "", "name": fn.get("name") or "",
                    "args": args or {}, "type": "tool_call"})
    return AIMessage(content=msg.get("content") or "", tool_calls=tcs)


def messages_to_ai_with_tools(names_and_args: list[tuple[str, dict]],
                              call_ids: list[str] | None = None) -> AIMessage:
    """测试用：直接造一条带 tool_calls 的 AIMessage。"""
    ids = call_ids or [f"c{i}" for i in range(len(names_and_args))]
    return AIMessage(content="", tool_calls=[
        {"id": cid, "name": n, "args": a, "type": "tool_call"}
        for cid, (n, a) in zip(ids, names_and_args)])
