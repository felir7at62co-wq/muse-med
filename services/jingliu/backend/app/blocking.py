"""站位分析 —— 独立调用，产出纯文本，确定性拼进**下一镜**的提示词（2026-11-10）。

⚠️ **2026-11-19 起本模块已无调用方（死代码，可整体删除）。** 它只在镜流自己用文本模型
写镜头提示词的三条路径里被调用（拆解后预生成 / 「重新生成提示词」/ 出片时兜底现写），
用来给同场下一镜准备「开场站位」行。镜头脚本改由 Muse 撰写并锁定之后，那三条路径
都已删除，这里的文本模型调用不会再被触发。下面是当时的设计说明，留作参考。

## 为什么从提示词生成里拆出来

此前站位（走位台账）是让提示词模型"顺带"在同一次调用里输出一个 JSON 块，
下一镜再把它作为【上一镜人物位置】塞进提示词模型的上下文。两个问题：

  1. 它要求模型输出 JSON —— 用户裁定：产出内容对格式几乎没有要求，
     能用散文就不用 JSON；
  2. 它进了提示词模型的上下文，而那是"不属于本镜原文的文字" ——
     与这次要根除的上下文污染是同一类东西。

## 现在的做法

    上一镜提示词生成完 → analyze(上一镜原文, 上一镜开场站位) → 一两行纯文本
                       → 存上一镜的 blocking_out（"这一镜结束时谁在哪"）
    下一镜拼装时        → prompt_compose.blocking_for(下一镜) 读出来
                       → 作为「开场站位：……」拼在最终提示词开头
                         （**不经过提示词模型**）

输入里**没有下一镜的任何内容**，所以不可能把下一镜的台词串进来；
输出只是一两行描述，不是另一套分镜脚本。

## 失败不影响出片

分析失败 / 模型说不清 → 不写，下一镜就不拼站位行（与以前没有台账时一样）。
宁缺毋错：拼进去的站位提示词模型没机会纠正，所以提示词要求"不确定就不写那个人"。

## 并发

只在**同场连续**、且下一镜存在时才分析（换场的镜头分析了也没人用）。
不新增并发闸门，走调用方已经持有的那一份（并发数铁律：不擅自改并发）。
"""
from __future__ import annotations

import logging

log = logging.getLogger("fw.blocking")

_SYSTEM = (
    "你是场记。读一段剧本，写出这段剧情**结束那一刻**，画面里每个人在哪、什么姿态、"
    "面向哪里、手上拿着什么。\n"
    "要求：\n"
    "· 只写一到两行纯文本，人与人之间用「；」分隔。不要标题、不要解释、不要 JSON。\n"
    "· 位置用场景里的固定物作参照（如「餐桌北侧」「门边」「沙发左端」），"
    "不要用「画面左侧」「镜头前方」这类随机位变化的说法。\n"
    "· 只写位置、姿态、朝向、手持物四项。不写镜头怎么拍（景别/机位/运镜/时间码），"
    "不写动作过程（「先…再…」），不写情绪、服装、台词、外貌。\n"
    "· 剧本没写清、你拿不准的人，**不要写**。宁缺毋错。\n"
    "· 已离场的人不写。\n"
    "· 实在什么都确定不了，只输出「无」。\n"
    "示例输出：林晨站在餐桌北侧，面向门口，右手握着文件袋；沈修杰坐在餐桌南侧，低头看手机"
)

#: 输出上限（字）。站位是一两行的事，超长说明模型在复述剧情，截断宁可丢尾。
_MAX_CHARS = 300


async def analyze(script_ref: str, opening: str | None = None,
                  llm_model_id: str | None = None) -> str:
    """分析一段剧本结束时的站位。失败或说不清返回空串（调用方不拼即可）。"""
    ref = (script_ref or "").strip()
    if not ref:
        return ""
    from .config import get_settings
    from .providers.llm import LLMProvider

    user = ref if not opening else f"这段剧情开始时：{opening.strip()}\n\n剧本：\n{ref}"
    try:
        s = get_settings()
        llm = LLMProvider(model_id=llm_model_id or s.llm_model_prompt or s.llm_model)
        out = await llm.complete(_SYSTEM, user, temperature=0.2)
    except Exception as e:  # noqa: BLE001 站位是增强项，不能挡住出片
        log.warning("[blocking] 站位分析失败（下一镜不拼站位）：%r", e)
        return ""
    return clean(out)


def clean(text: str | None) -> str:
    """把模型输出收成一行纯文本；"无"/空/像 JSON 的一律当没有。"""
    t = (text or "").strip().strip("`").strip()
    if not t or t in ("无", "无。", "None", "none") or t.startswith("{"):
        return ""
    t = " ".join(x.strip() for x in t.splitlines() if x.strip())
    for prefix in ("开场站位：", "开场站位:", "站位：", "站位:"):
        if t.startswith(prefix):
            t = t[len(prefix):].strip()
    return t[:_MAX_CHARS]


async def analyze_and_save(sid: str) -> str:
    """分析本镜结束时的站位并写进 `blocking_out`；只在**有下一镜要用**时才调用模型。

    "有下一镜要用" = 本镜不是所在连续段的最后一镜。
    本镜自己的开场站位（来自上一镜）作为输入一并给：这样链条是接上的，
    不会每镜都从零猜一遍。
    """
    from .continuity import cached_runs
    from .db import Shot, get_session
    from .prompt_compose import blocking_for

    with get_session() as s:
        sh = s.get(Shot, sid)
        if sh is None:
            return ""
        run = next((r for r in cached_runs(s, sh.project_id) if sid in r), None)
        if not run or run.index(sid) == len(run) - 1:
            return ""            # 段尾 / 单镜成段：下一镜是换场，不需要站位
        ref = sh.script_ref or ""
    text = await analyze(ref, blocking_for(sid) or None)
    if not text:
        return ""
    try:
        with get_session() as s:
            sh = s.get(Shot, sid)
            if sh is not None:
                sh.blocking_out = text
                s.commit()
    except Exception:  # noqa: BLE001
        log.exception("[blocking] 站位落库失败（不影响出片）")
        return ""
    return text
