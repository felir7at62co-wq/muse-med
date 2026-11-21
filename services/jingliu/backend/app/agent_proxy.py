"""agent_proxy.py — 编辑器 Agent 的**后端转发**（批次 E6，PLAN §2.6.1 结论 2）

## 为什么不做一个通用的"代理转发"

PLAN §2.6.1 把 E6 的密钥方案从"建议"升级成**架构约束**：

    「客户端的 Agent 只是**把命令意图发给后端**，后端持有密钥、调模型、
      把结构化的命令**回传**给客户端执行。」

所以这个模块的输入**不是**聊天记录，而是：

    能力表（说明书）+ 时间轴快照（现状）+ 用户那句话

输出**不是**自由文本，而是**结构化的命令意图**：

    { "reply": "…", "done": false, "commands": [ {"id":"split_shot","args":{…}} ] }

客户端拿到 `commands` 后**在自己进程内**走 `dispatch.ts` 执行 ——
序列化的是**意图**（一小段 JSON），不是 `EditCommand` 本身，这一点是
PLAN §2.6.1 明确写过的：命令保持函数式、不序列化。

## ⚠️ 密钥一个字节都不出现在这里

客户端传上来的只有"用户身份"（`session_guard` 已经在路由层把住了，
见 `main.py` 的 `_OPEN_TREES`：`/v2/agent/*` 不在开放名单里，自动要 Bearer）。
真正的 key 只存在于 `LLMProvider` 读的 settings 里，从不回传。
本模块连"用了哪条渠道"都不写进返回值 —— `/health` 已经在暴露渠道名与
冷却标志了，再在 Agent 响应里带一份只会让前端多一个可以泄漏的位置。

## ⚠️ 能力表由**客户端**下发，后端不自己维护一份

这是刻意的：能力表的唯一真源是 `desktop/src/lib/agent/capability.ts`
（那里还带着 `verify-agent.ts` 的交叉校验）。后端再抄一份，
两边迟早漂移成"模型看到一个已经不存在的能力"。

安全性上没有因此放宽：模型只能**提议**，真正执行的是客户端 `dispatch()`，
它对每个 id 都会 `findCapability()` 并校验参数；
不在表里的 id 到了客户端就是一句"没有叫这个的能力"。
后端这里对 id 做的是**白名单式透传校验**（见 `_sanitize_commands`），
目的只是别把明显不成形的东西喂回客户端，不是安全边界。
"""
from __future__ import annotations

import json
import logging
import re

from .providers.llm import LLMProvider

log = logging.getLogger("fw.agent")


class AgentInputError(ValueError):
    """**请求本身**不合法（空指令、输入过长）。重试同一份输入必然再失败。"""


class AgentProtocolError(ValueError):
    """模型这轮回复没能解析成命令 JSON。

    与 `AgentInputError` 分开，是因为客户端对两者的处置不同：
    前者要让用户改输入，后者**值得重试**（模型偶尔先唠一句再给 JSON，
    换个温度/重发一次往往就成了）。
    """

#: 一次回复里最多接受几条命令。超过就**截断并明说**，不静默丢——
#: 模型一次吐 40 条命令，多半是它把"改 40 个镜头"和"改 1 个镜头的 40 个属性"
#: 搞混了；让用户看到"只执行了前 12 条"比让它悄悄跑完好得多。
MAX_COMMANDS = 12

#: 单次输入上限（字符）。超了**直接拒绝**而不是截断：
#: 截断后的时间轴快照会让模型基于不完整的数据下命令，而它不会知道自己
#: 看到的是半截 —— 那正是 `describeTimeline.ts` 文件头警告过的场景。
MAX_INPUT_CHARS = 400_000

#: 提示词契约版本。**改提示词格式/字段名时必须 +1**。
#: 客户端 `desktop/src/lib/agent/prompt.ts` 里有同名的 `PROMPT_CONTRACT_VERSION`，
#: `GET /v2/agent/protocol` 把它暴露出去由 `verify-agent.ts` 比对。
#: 两端漂移的后果是"模型按一端的格式回答、另一端解析不了"，
#: 表现为"模型偶尔乱回"这种最难查的故障 —— 所以要让它变成一条红灯。
AGENT_CONTRACT_VERSION = 3

_SYSTEM_HEAD = (
    "你是短剧剪辑软件 FilmWeaver 里的剪辑助理。用户会用自然语言让你改时间轴。\n"
    "\n"
    "【你的工作方式】\n"
    "你不是在聊天——你的回复会被程序解析，用来**真的修改用户的项目**。\n"
    "每一步都要：先想清楚改哪一个镜头（用 id，不是 #序号），"
    "再挑一个**能力表里存在的**能力，把参数填对。\n"
    "\n"
    "【硬性约束】\n"
    "1. 只能使用下面【能力表】里列出的 id。**不存在的能力一律不许编**，"
    "编出来的 id 会被程序拒掉，用户看到的是「操作失败」。\n"
    "2. 镜头一律用 **id**（那一串 uuid）指定，绝不要用 #order 或第几个——"
    "order 会随增删变化，用它会改错镜头且不报错。\n"
    "3. 只改用户要求的那件事。用户没提的镜头不要顺手改。\n"
    "4. **花钱的能力（标了 costly）**：不要直接执行。先在 reply 里说清"
    "「要改哪几个、大概几个、会花额度」，让用户点头。除非用户这句话本身"
    "已经明确同意了（如「就按这个生成」）。\n"
    "5. 如果用户的要求做不到（信息不足、镜头不存在、能力表里没有对应操作），"
    "**不要硬凑一个命令**：把 commands 留空，在 reply 里说清楚缺什么。\n"
    "6. 一次最多回 12 条命令。要改的更多就**先做一批**，在 reply 里说明"
    "「先改了这几个，确认后继续」。\n"
    "\n"
    "【输出格式】\n"
    "只输出一个 JSON 对象，不要解释、不要 Markdown 代码块：\n"
    '{"reply": "<给用户看的一句话，中文>", '
    '"done": true/false, '
    '"commands": [{"id": "<能力 id>", "args": {<参数>}}]}\n'
    "  · done=true 表示这一轮的事情做完了；done=false 表示还需要再看一次"
    "时间轴继续（比如需要翻页看更多镜头）。\n"
    "  · 不需要改任何东西时 commands 是空数组 []。\n"
)


def _balanced_object(text: str, start: int) -> str | None:
    """从 `text[start]`（必须是 `{`）起取**第一个括号配平的对象**，含两端。

    跳过字符串字面量内部的括号（提示词里常有 `{"a":"}"}` 这种内容），
    并处理反斜杠转义。括号没配平（被截断）时返回 `None`，由调用方
    把原始文本交给 `json.loads` 去报一个更准确的错。
    """
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if esc:
            esc = False
            continue
        if ch == "\\":
            if in_str:
                esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def _parse_json(raw: str) -> dict:
    """容错解析。失败抛 ValueError。

    ⚠️ **取值口径必须与客户端 `desktop/src/lib/agent/protocol.ts` 的
    `extractJsonObject` 一致**：那里数括号深度并跳过字符串内的括号，
    这里以前用的是 `find("{") … rfind("}")`，在"JSON 之后还跟了一句带花括号的
    解释"或"JSON 前后有别的内容"时会**多取**、`json.loads` 炸掉，
    而这一炸是 `AgentProtocolError` → 502 → **客户端连模型那句话都看不到**，
    它的容错（`extractJsonObject`）根本没机会上场。两端各有一套容错却没对齐，
    等于只有最严的那一套生效 —— 所以这里改成同一套扫描。

    与 `char_alias._parse_json` / `costumes._parse_json` 刻意不抽公共函数：
    那两处要的是"整段就是 JSON"，容错范围与本处不同（这里还要处理
    "模型先回一句人话、后面跟个 JSON"的情形），抽出去会让三处互相迁就。
    """
    text = (raw or "").strip()
    if text.startswith("```"):
        # 剥围栏：去掉首行的 ``` / ```json 与末尾的一行 ```
        nl = text.find("\n")
        if nl >= 0:
            text = text[nl + 1:]
            tail = text.rfind("```")
            if tail >= 0:
                text = text[:tail]
        else:
            text = text.strip("`").lstrip("json").lstrip()
        text = text.strip()
    start = text.find("{")
    if start >= 0:
        span = _balanced_object(text, start)
        text = span if span is not None else text[start:]
    return json.loads(text)


def _sanitize_commands(raw) -> tuple[list[dict], list[str]]:
    """把模型给的 commands 收成 `[{id, args}]`，顺手记下被丢掉的原因。

    **不是安全边界**（真正的闸门在客户端 `dispatch()`），是一次"别把明显
    不成形的东西送回去"的整形。丢掉的东西**要报出来**——静默丢弃会让
    客户端与用户都以为"模型没提这条"，而实际上是这里吃掉了。
    """
    out: list[dict] = []
    dropped: list[str] = []
    if not isinstance(raw, list):
        if raw is not None:
            dropped.append(f"commands 不是数组（是 {type(raw).__name__}）")
        return out, dropped
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            dropped.append(f"第 {i + 1} 条不是对象")
            continue
        cid = item.get("id")
        if not isinstance(cid, str) or not cid.strip():
            dropped.append(f"第 {i + 1} 条没有 id")
            continue
        args = item.get("args")
        if args is None:
            args = {}
        if not isinstance(args, dict):
            dropped.append(f"第 {i + 1} 条（{cid}）的 args 不是对象")
            continue
        out.append({"id": cid.strip(), "args": args})
    return out, dropped


def build_system_prompt(capabilities: list[dict], timeline_text: str,
                        project_id: str | None) -> str:
    """拼系统提示词：能力表 + 时间轴快照。

    ⚠️ 能力表的 `params` 是 JSON Schema 形状的**纯数据**（客户端保证），
    这里直接 `json.dumps` —— 不要试图"美化"成自然语言，
    那等于把能力表在两边各写一遍，模型看到的两份一不一致没人知道。
    """
    caps = capabilities if isinstance(capabilities, list) else []
    lines: list[str] = [_SYSTEM_HEAD, "【能力表】"]
    for c in caps:
        if not isinstance(c, dict):
            continue
        cid = c.get("id")
        if not isinstance(cid, str):
            continue
        costly = "  ⚠️花钱/不可逆，执行前必须用户确认" if c.get("costly") else ""
        lines.append(f"- {cid}{costly}")
        desc = c.get("desc")
        if isinstance(desc, str) and desc.strip():
            lines.append(f"    说明：{desc.strip()}")
        params = c.get("params")
        if isinstance(params, dict):
            lines.append("    参数："
                         + json.dumps(params, ensure_ascii=False))
    lines.append("")
    lines.append("【当前时间轴】")
    if project_id:
        lines.append(f"当前打开的项目 id = {project_id}"
                     "（能力表里要 project_id 的地方填这个）")
    lines.append(timeline_text.strip() or "(空)")
    lines.append("")
    lines.append("现在按【输出格式】输出那一个 JSON 对象。")
    return "\n".join(lines)


async def run_turn(*, capabilities: list[dict], timeline_text: str,
                   user_text: str, history: list[dict] | None = None,
                   project_id: str | None = None,
                   model_id: str | None = None) -> dict:
    """跑一轮：调模型 → 解析出结构化意图。

    ⚠️ 本函数**不落库、不碰项目数据**。它唯一的外部副作用是一次 LLM 调用。
    改项目的永远是客户端的 `dispatch()` —— 这条边界一旦模糊，
    "AI 改了什么"就会有两处事实来源，而两处事实来源必然对不上。
    """
    if not isinstance(user_text, str) or not user_text.strip():
        raise AgentInputError("user_text 不能为空")
    system = build_system_prompt(capabilities, timeline_text, project_id)

    total = len(system) + len(user_text)
    if total > MAX_INPUT_CHARS:
        raise AgentInputError(
            f"输入过长（{total} 字符 > 上限 {MAX_INPUT_CHARS}）。"
            f"请缩小 describe_timeline 的 limit 或按集查看后再试。")

    # 历史对话：把之前的（用户说了什么、模型回了什么）压成一小段附在 user 里。
    # 不做原生多轮 messages，因为本后端的文本通道是纯补全（见 capability.ts 注释），
    # 多轮拼接的写法在三个中转站上行为不一致。
    hist_txt = ""
    if history:
        rows: list[str] = []
        for h in history[-6:]:
            if not isinstance(h, dict):
                continue
            role = "用户" if h.get("role") == "user" else "你"
            txt = h.get("text")
            if isinstance(txt, str) and txt.strip():
                rows.append(f"{role}：{txt.strip()[:500]}")
        if rows:
            hist_txt = "【之前的对话】\n" + "\n".join(rows) + "\n\n"

    user = f"{hist_txt}【用户这次说】\n{user_text.strip()}"

    llm = LLMProvider(model_id=model_id)
    # temperature 取低值：这不是创作，是**填参数**。创意温度只会让它把
    # 镜头 id 记岔、把 at_sec 编成看着合理的数。
    #
    # ⚠️ⓘ 模型选择：默认走 `settings.llm_model`（当前 gemini-3.6-flash），
    #   见 `config.py` 那段注 —— **它是临时的当前最优，不是终选**。
    #   本模块对模型的要求比其它文本阶段**更硬**：输出必须是机器可解析的
    #   JSON（见 `_parse_json` 的容错范围），而 flash 档模型靠提示词约束
    #   才肯只回 JSON。**出现更强指令跟随 / 原生 JSON mode / 更长上下文的
    #   模型时，应优先替换给这一条通路**（可先只给 Agent 单独指定 model_id，
    #   不必动全局默认）。判断能不能换的实测口径：连跑若干轮指令，
    #   `dropped` 恒为空、reply 里没有多余的唠嗑、args 不出现编造字段。
    raw = await llm.complete(system, user, temperature=0.2)

    try:
        data = _parse_json(raw)
    except Exception as e:  # noqa: BLE001
        # 解析不了**不抛 502**：模型偶尔会先唠一句再给 JSON，客户端重试一次
        # 往往就成了。把原文回给客户端，由它决定是重试还是展示。
        log.warning("Agent 回复无法解析为 JSON：%s", str(e)[:200])
        raise AgentProtocolError(f"模型回复不是合法 JSON：{str(e)[:120]}") from e

    commands, dropped = _sanitize_commands(data.get("commands"))
    reply = data.get("reply")
    if not isinstance(reply, str):
        reply = ""
    if len(commands) > MAX_COMMANDS:
        dropped.append(f"超出单次上限，第 {MAX_COMMANDS + 1} 条起未下发")
        commands = commands[:MAX_COMMANDS]

    return {
        "reply": reply.strip(),
        "done": bool(data.get("done", True)),
        "commands": commands,
        "dropped": dropped,
        "model_id": llm.model_id,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 帧格式自检（给 verify 脚本与运维用）
# ─────────────────────────────────────────────────────────────────────────────

_FENCE = re.compile(r"^\s*```")


def looks_like_fence(text: str) -> bool:
    """模型是否在用 Markdown 代码块 —— 提示词里明确禁了，出现说明它没听。"""
    return bool(_FENCE.match(text or ""))


# ─────────────────────────────────────────────────────────────────────────────
# 给路由用的常量读口（避免路由 import 一堆模块级名字）
# ─────────────────────────────────────────────────────────────────────────────

def agent_max_commands() -> int:
    return MAX_COMMANDS


def agent_max_input_chars() -> int:
    return MAX_INPUT_CHARS
