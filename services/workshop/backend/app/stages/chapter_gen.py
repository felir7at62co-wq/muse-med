"""M5.2 编剧阶段：章节滚动生成 + 章末摘要 + 人物名漂移检测。

核心思路：
  - 永远不一次喂全文给 LLM。每生成一章只给：
    * 稳定上下文（人物表 + 世界观 + 主线一句话）≈ 1-2k 字
    * 本章定位（取自 outline.chapters[k]）
    * 滚动记忆（前 1-2 章的 summary + 上一章末尾原文 300 字）
  - 单章产出后立刻调"摘要器"生成 summary 入库，下一章用
  - 人物名漂移：扫描产出文本，找出人物表里没有的"看起来像人名的 Token"，标黄返回给前端
"""
from __future__ import annotations

import logging
import re
from typing import Any

from ..prompt.loader import load_active_template
from ..models.llm import get_llm
from ..polish.deai_rules import build_deai_rules_block
from . import drama_principles
# 集纲字段 → prompt 文本的唯一渲染器（正文与剧本两条路共用，见该模块顶部说明）。
# ⚠️ 下方 `_s` / `_format_characters` / `_format_world_rules` / `_format_must_have` /
# `_build_contract_block` 全部是**别名**，不要在本文件里再定义一份 —— 定义两份
# 正是 2026-10-09 那次"剧本路径拿到 0 个契约字段"的成因。
from .episode_render import (
    _s,
    build_beats_block,
    build_contract_block,
    format_characters,
    format_must_have,
    format_world_rules,
)
# 本文件内部与历史调用点用的都是**下划线前缀**的旧名（本文件自己的 load 函数
# 也叫 `_load_prompt_or_fallback_ch`）。上面 import 的是新名，这里补一组别名 ——
# 少了它们，`generate_chapter` 会在跑起来那一刻抛 NameError。
_format_characters = format_characters
_format_world_rules = format_world_rules

_PROVIDER_LABEL = {"gemini": "跨世界观模型", "deepseek": "通用模型", "gpt5": "逻辑专项模型"}

logger = logging.getLogger("chapter_gen")


# ---------------------------------------------------------------------------
# Prompt 模板
# ---------------------------------------------------------------------------



async def _load_prompt_or_fallback_ch(stage: str, fallback: str) -> str:
    """DB优先加载prompt模板,fallback到代码默认值"""
    try:
        tpl = await load_active_template(stage)
        return tpl if tpl else fallback
    except Exception:
        return fallback


_CHAPTER_PROMPT = """你是资深短剧编剧，正在写第 {chapter_order} 章。请严格遵守以下设定，写出本章正文。


## 全剧主线
{synopsis}

## 世界观
- 时代/背景：{era}
- 核心场景：{setting}
{world_rules}

## 人物表（姓名固定，全文沿用这些姓名）
{characters_block}

## 前情原文（以下是前几章的**真实正文**，请自然衔接）
{rolling_memory}

## 截至本集的状态账本（硬约束，必须遵守）
{ledger_block}

{positive_block}

{contract_block}

{beats_block}

## 本章大纲
- 标题：{ch_title}
- 概要：{ch_synopsis}
- 必须出现的关键事件：
{must_have_block}
- 本章涉及人物：{ch_characters}

## 写作要求（按优先级排序）
1. **戏剧结构优先**：按上方"正文核心戏剧原则"写——主线推进、开场接住上一集、结尾钩子，
   这三项是本章成败的关键，优先级高于字数。
2. **字数**：目标 {word_target} 字，范围 {word_min} ~ {word_max} 字。动笔前按场景规划
   （每个场景约 {scene_target} 字），写完估算总字数；超过上限的部分会被系统截掉，
   所以篇幅优先保证开场与结尾钩子完整。
3. 人物只用人物表里的姓名；路人用"路人甲""老板"等称呼。
4. 从前情原文结束的地方接着写，每一场都是新发生的事。
5. 第三人称叙述 + 对话，以人物对话推进剧情，动作描写穿插其间。
6. 只输出本章正文本身（从第一句正文开始，到最后一句正文结束）。
"""


_SUMMARY_PROMPT = """请为以下小说章节生成 200-300 字的浓缩摘要，要求：
- 抓住关键剧情转折（人物做了什么、与谁、结果如何）
- 保留重要伏笔
- 用客观第三人称
- 仅输出摘要正文，不要任何前后说明

## 章节正文
{chapter_text}
"""


# ---------------------------------------------------------------------------
# 工具：构造 prompt 各个 block
#
# ⚠️ 2026-10-09：`_format_characters` / `_format_world_rules` / `_format_must_have` /
# `_s` / `_build_contract_block` 的实现已移入 `episode_render.py`，此处只保留
# **同名别名**（文件顶部的 import）。
#
# 为什么留别名而不是删掉：`dev_ab_deai.py` 等代码会按引用替换本模块的属性
# （`chapter_gen.build_deai_rules_block = ...`），炸掉这些名字会连带炸掉它们；
# 而且本文件内部与历史调用点都还按旧名引用。
#
# 为什么必须收成一处：正文路径与剧本路径原先各写一份（剧本路径那份干脆没有），
# 结果 2026-10-09 实测发现剧本步骤拿到的集纲字段数是 **0** —— 模型写 5000 字
# 只看到 100 字梗概，扩写倍率 46~56 倍。渲染逻辑再分家一次，同样的洞就会再出现。
# ---------------------------------------------------------------------------


def _format_must_have(items: list[str], outline: dict | None = None,
                      order: int = 0) -> str:
    """本集必备情节点（→ episode_render.format_must_have）。

    ⚠️ 空值时的文案已不是"按概要发挥即可" —— 那是在邀请模型自己编。
    传入 `outline` 与 `order` 时，为空会改为指向本集已有的契约/节拍。
    """
    return format_must_have(items, outline, order)


#: 前情原文的字符预算。
#:
#: ⚠️ 2026-10-10：不再硬编码 9000。那个数字从没跟模型窗口对过账 ——
#: 在 70 万口径的 gemini-3.6-flash 上，它只用到可用窗口的 1%，等于白扔
#: 上下文（109 集的剧在生成第 60 集时，前 59 集全文只要约 13 万字）。
#: 现在按窗口算，见 `_prev_budget_chars()`。
_PREV_TEXT_BUDGET_FALLBACK = 9_000


def _prev_budget_chars() -> int:
    """本集前情能用多少字 —— 按模型窗口算（`stages.text_budget`）。

    取不到配置（或异常）时退回旧的 9000，绝不让生成失败。
    """
    try:
        from ..config import get_settings
        from .text_budget import text_budget_chars
        model = get_settings().llm_generate_model or ""
        return text_budget_chars(model, purpose="chapter_prev")
    except Exception:  # noqa: BLE001
        return _PREV_TEXT_BUDGET_FALLBACK


#: 单章贡献的下限兜底 —— 正常单章约 2200 字，这个数永不触发。
_PREV_TEXT_PER_CH = 6000


def _per_chapter_cap(total: int) -> int:
    """单章最多贡献多少字。

    防某一章特别长（异常数据）时把预算吃光，导致更早的章一个字都进不来。
    取总量的一半：正常单章约 2200 字，这个上限永远不触发。
    """
    return max(_PREV_TEXT_PER_CH, total // 2)


def _build_rolling_memory(prev_chapters: list[dict]) -> str:
    """前情 = 前几章的**真实正文**（从最近一章往前累加到预算上限）。

    ## ⚠️ 2026-10-08 改：不再用「摘要」

    原实现取最近 2 章的 `summary` + 上一章末尾 300 字。用户实测的
    prod 草稿 2421（「同事请客，刷的却是我的卡」）因此**整段跑偏**：

      第 5 章某次生成跑偏，写出了"陆沉 / 黑刀 / 狙击弹"（那是另一套
      特工戏的桥段，本剧是都市职场剧），第 5 章**摘要**把这段偏差记了下来；
      生成第 6 章时该摘要作为前情喂进去 → 第 6 章接着写陆沉 → 第 6 章摘要
      又含陆沉……**自我强化，一路传到第 19 章**（20 章之后才碰巧跳出）。

    根因不是模型弱，是**喂进去的东西先天不准确**：摘要本身是模型的二次
    产物，偏差会被当成"已发生的事实"继承并放大，而正文原文不会 ——
    原文里根本不存在"陆沉"，模型看得见的东西也就没有这条污染。

    用户原话（2026-10-08）：*"'本集梗概 + 前情摘要'这个内容先天就带有
    不准确性，甚至不如把本集和前集原文直接组合给模型。"*

    ## 取舍
    原文比摘要长得多，所以这里按预算**从新往旧**装，装满即止；最近的
    一章一定完整，更早的章可能被截掉开头。宁少勿假：给不完整的真话，
    好过给完整但可能带偏差的转述。

    ## 为什么不再单列"上一章末尾原文片段"
    原实现先给摘要、再补 300 字尾巴，因为摘要丢了语感。现在整段都是原文，
    语感天然连续，那个补丁没有存在必要了。

    ## 调用方注意
    `prev_chapters` 必须带 `full_text`。四条调用路径都已确认会带
    （batch_gen / router / chat_jobs / auto_batch）。
    没有 full_text（如导入未生成）时**返回"无前情"而非退回摘要** ——
    退回摘要正是本次要消灭的行为，宁可少给上下文。
    """
    if not prev_chapters:
        return "（这是第一章，无前情）"

    budget = _prev_budget_chars()
    per_cap = _per_chapter_cap(budget)

    picked: list[tuple[int, str, str]] = []
    used = 0
    # 从最近一章往前装，装到预算上限为止
    for ch in reversed(prev_chapters):
        body = (ch.get("full_text") or "").strip()
        if not body:
            continue
        if len(body) > per_cap:
            # 超长章只保留**末尾**（离本章最近的部分，衔接价值最高）
            body = "…（本章前半略）\n" + body[-per_cap:]
        if used + len(body) > budget and picked:
            break
        picked.append((int(ch.get("chapter_order") or 0),
                       ch.get("title") or "", body))
        used += len(body)

    if not picked:
        # 前几章都还没有正文（例如刚导入、尚未生成）——如实说，不编前情。
        return "（前几章还没有正文，无可供衔接的前情）"

    blocks = []
    for order, title, body in reversed(picked):   # 按集号升序呈现，符合阅读顺序
        head = f"### 第{order}集" + (f" 「{title}」" if title else "")
        blocks.append(f"{head}\n\n{body}")
    return "\n\n".join(blocks)


def _build_ledger_block(outline: dict, chapter_order: int,
                        ledger_override: dict | None = None) -> str:
    """P4: 取"截至本集"的状态快照, 作为生成的硬约束。

    已死角色不得出场(除非闪回)、已揭秘密不得当未知、已解悬念不得再悬置。
    无账本时返回占位, 不影响旧数据。

    ⚠️ `ledger_override` 是**有效账本**（计划 + 稿子实况覆盖，见 stages/divergence.py）。
    没有它的话：用户在剧本里把"A 第3集死"改成"第5集才死"之后，
    这里仍会按计划账本写出「已死角色不得出场」，生成第4集时把 A 排除掉 ——
    和用户刚写的稿子对着干（2026-09-21 用户提出的问题）。
    """
    ledger = ledger_override if ledger_override is not None else outline.get("state_ledger")
    if not ledger:
        return "（本剧未启用状态账本，按人物表与大纲自洽即可）"
    try:
        from .state_ledger import snapshot_text
        return snapshot_text(ledger, chapter_order - 1)
    except Exception:
        return "（状态账本读取失败，按人物表与大纲自洽即可）"


def _build_positive_block(outline: dict, chapter_order: int) -> str:
    """D3: 正向剧情约束——告诉本集"必须往哪走"，而不只是"不能做什么"。

    负向账本(snapshot_text)防矛盾；本块防疲软：未回收的伏笔、上一集的钩子指向、
    当前升级档位、观众已知边界。零 LLM，纯推导。
    """
    try:
        from .state_ledger import positive_ledger_text
        return positive_ledger_text(outline, chapter_order)
    except Exception:
        return "（正向剧情约束读取失败，按大纲与契约自洽即可）"


def _s(value) -> str:  # noqa: D401 —— 别名，实现见 episode_render._s
    """集纲取值收敛（→ episode_render._s）。保留本名供历史调用点使用。"""
    from .episode_render import _s as _impl
    return _impl(value)


def _build_contract_block(outline: dict, chapter_order: int) -> str:
    """本集的戏剧契约（→ episode_render.build_contract_block）。

    ⚠️ 实现已移入 `episode_render`，**正文与剧本两条路共用同一份**。
    保留本名是因为历史调用点与 `state_ledger.py` 的注释都按这个名字引用。
    """
    return build_contract_block(outline, chapter_order)


# ---------------------------------------------------------------------------
# 主入口：生成一章
# ---------------------------------------------------------------------------

def _build_guidance_block(guidance: str, chapter_order: int = 0) -> str:
    """用户临时指令块 —— "这一遍照我说的写"。

    为什么必须有这块（2026-09 用户反馈）：
      用户把 60 集细纲和前六集正文贴进对话、又补了几句自己的要求，然后点生成。
      结果成片"AI 感很重、细节僵硬"——因为 `generate_chapter` 的 prompt 完全由
      outline 字典（synopsis / era / setting / world_rules / characters_block）
      拼成，**用户那几句指令根本没有任何落点**，等于白说。
      精修路径（rewrite）一直有 guidance 通道，生成路径漏了，这个块就是补这个洞。

    块内文本是**用户原话**——
    它不是指令注入面（用户本来就有权指挥自己的剧），但仍被清洗过一次
    （调用方 sanitize），并限长（调用方截断）。章节内联写（guidance 里带"第N集"）
    时，块会点名"本集只兑现与本集相关的那几条"。
    """
    g = str(guidance or "").strip()
    if not g:
        return ""
    scope_line = ("本集只兑现与本集相关的要求；其余要求属于别的集，"
                  "不要提前写进来。" if chapter_order else "")
    return (
        "【本次写作要求（用户原话，最高优先级）】\n"
        "以下是用户针对这一遍生成提出的具体要求。它们与「本章大纲」「写作要求」"
        "冲突时，**以本块为准**；与本块不冲突的大纲内容照常兑现。\n"
        + (scope_line + "\n" if scope_line else "")
        + "---\n" + g + "\n---"
    )


async def generate_chapter(*, outline: dict, chapter_order: int, word_target: int, prev_chapters: list[dict], provider: str = "gemini", draft_id: int | None = None, guidance: str = "") -> str:
    """生成第 chapter_order 章正文文本。

    guidance: 用户这次临时给的写作要求（可为空）。空时行为与改前**完全一致**。
    """
    chapters_meta = outline.get("chapters") or []
    ch_meta = next((c for c in chapters_meta if c.get("order") == chapter_order), None)
    if not ch_meta:
        raise ValueError(f"chapter {chapter_order} not in outline")

    base_prompt_ch = await _load_prompt_or_fallback_ch("chapter_generate", _CHAPTER_PROMPT)
    if draft_id:
        try:
            from .log_helper import save_log
            await save_log(draft_id, "chapter", f"第{chapter_order}章使用模型: {_PROVIDER_LABEL.get(provider, provider)}", "log", chapter_order)
        except Exception:
            pass

    # 有效账本：计划账本 + 稿子实况覆盖（见 stages/divergence.py）。
    # ⚠️ 这一步必须在**生成任务内部**做，不能等用户去点检查 ——
    # 否则用户改了稿、却从不检查，生成就一直拿过期计划压着 AI。
    # 代价极小：指纹一致时零成本；改过几集时也只重算那几集（占本次生成 <1%）。
    _eff_ledger = None
    if draft_id:
        try:
            from .divergence import effective_ledger
            _eff_ledger = await effective_ledger(draft_id) or None
        except Exception as _e:  # noqa: BLE001
            logger.warning("有效账本获取失败，退回计划账本: %s", _e)

    # 字数控制参数(基于 word_target 计算允许范围)
    # 去掉最低字数硬底, 完全按用户设定的目标字数比例算
    word_min = max(1, int(word_target * 0.8))
    word_max = max(2, int(word_target * 1.2))
    # 硬截断阈值(允许比 word_max 再宽松 30%, 之后仍超长就在段落边界截掉)
    word_hard_cap = int(word_target * 1.5)
    scene_target = max(50, word_target // 6)  # 假设一章 5-6 个场景

    # 兼容旧模板:如果模板里没有 {word_min}/{word_max}/{scene_target} 占位,format 会忽略额外参数
    fmt_kwargs = dict(
        chapter_order=chapter_order,
        synopsis=outline.get("synopsis", ""),
        era=(outline.get("world") or {}).get("era", ""),
        setting=(outline.get("world") or {}).get("setting", ""),
        world_rules=_format_world_rules((outline.get("world") or {}).get("rules") or []),
        characters_block=_format_characters(outline.get("characters") or []),
        rolling_memory=_build_rolling_memory(prev_chapters),
        ledger_block=_build_ledger_block(outline, chapter_order, _eff_ledger),
        positive_block=_build_positive_block(outline, chapter_order),
        contract_block=_build_contract_block(outline, chapter_order),
        beats_block=build_beats_block(outline, chapter_order),
        ch_title=ch_meta.get("title", ""),
        ch_synopsis=ch_meta.get("synopsis", ""),
        # ⚠️ 必须把 outline/order 传进去：must_have 为空时靠它们决定是"指向本集契约"
        # 还是"如实说没有"，否则退回旧行为（一句"按概要发挥即可"= 邀请自编）。
        must_have_block=_format_must_have(
            ch_meta.get("must_have") or [], outline, chapter_order),
        ch_characters="、".join(ch_meta.get("characters") or []) or "（按需）",
        word_target=word_target,
        word_min=word_min,
        word_max=word_max,
        scene_target=scene_target,
    )
    try:
        prompt = base_prompt_ch.format(**fmt_kwargs)
    except KeyError as e:
        # DB 模板含本代码不识别的 placeholder,降级为无格式化的拼接
        logger.warning("chapter prompt template missing placeholder %s, fallback", e)
        prompt = base_prompt_ch + "\n\n[运行时参数]\n" + "\n".join(f"- {k}: {v}" for k, v in fmt_kwargs.items() if isinstance(v, (str, int)))

    # ⚠️ 旧 DB 模板会**静默丢掉**硬约束块（2026-09-21 发现）
    #
    # 库里 stage='chapter_generate' 的激活模板只认 12 个占位符，
    # **没有** {ledger_block} / {contract_block} / {positive_block}。
    # `.format()` 对多余的 kwargs 不报错 —— 于是状态账本、戏剧契约、正向约束
    # 全都算好了却一个字都没进 prompt，而代码里看着"明明传了"。
    # （这也解释了为什么"已死角色不得出场"在这些草稿上从没生效过。）
    #
    # 沿用本文件既有的补救手法：**模板没有占位符就拼在后面**
    # （guidance_block / drama_principles 早就是这么干的）。
    # 判据是占位符是否出现在原始模板里，所以有占位符的模板不会被拼第二遍。
    for _ph, _val in (("{ledger_block}", fmt_kwargs["ledger_block"]),
                      ("{contract_block}", fmt_kwargs["contract_block"]),
                      ("{positive_block}", fmt_kwargs["positive_block"]),
                      # 🔴 2026-10-09：{beats_block} 与上面三个同类 ——
                      # 库里 active 的 chapter_generate 模板只认 12 个占位符，
                      # **不含** beats。不加进这个循环，场景节拍就会算好了却
                      # 一个字都没进 prompt（`.format()` 对多余 kwargs 不报错），
                      # 而代码里看着"明明传了"。这正是本文件 2026-09-21 踩过的坑。
                      ("{beats_block}", fmt_kwargs["beats_block"])):
        if _ph not in base_prompt_ch and str(_val or "").strip():
            prompt = prompt + "\n\n" + str(_val)

    # D2: 注入戏剧原则（先 format 骨架、再拼接——原则块内含字面 JSON 花括号，
    # 不能参与 format 渲染）。放在骨架模板之后、安全红线之前。
    # 好处：DB 里已有的 chapter_generate 模板也能吃到这批原则，无需逐个改库。
    prompt = drama_principles.chapter_block() + "\n\n" + prompt

    # 质量内建（PLAN §3.2 / B7）：把"去 AI 味"从**事后清洗**改成**生成时不产生**。
    #
    # 注入方式沿用上面 drama_principles 的手法（拼接而非 format），
    # 这样 DB 里已有的 chapter_generate 模板也能吃到这批规则，无需逐个改库。
    #
    # ⚠ 只注入 A 级规则（翻案腔/三连排比/抽象情绪壳/顿挫节奏）。B 级需语境判断、
    #   C 级是短剧类型规范（情绪直说、主角独白多），注进去只会损害作品。
    #   详见 polish/deai_rules.py 顶部对取舍的说明。
    #
    # 位置：放在 guidance_block **之前** —— 这是通用写作规则，
    # 不该压过用户当次的临时要求（guidance 的说明里明写"冲突时以它为准"）。
    #
    # ⚠️ 由 settings.deai_rules_in_generate 控制，**默认关**。
    #   A/B 实测（8 集，2026-09-20）显示两组无显著差异（p=1.000，4/8），
    #   而它会改变每一次生成的产出 —— 证据不足时不改行为。
    #   完整数据与推理见 config.py 里该字段的注释。
    try:
        from ..config import get_settings
        _deai_on = bool(get_settings().deai_rules_in_generate)
    except Exception:
        _deai_on = False          # 读不到配置就不注入（安全默认）
    deai_block = build_deai_rules_block(_deai_on)
    if deai_block:
        prompt = prompt + "\n\n" + deai_block

    # 用户这次的临时要求：拼接（不进 format），DB 里的旧模板同样吃得到。
    # 放在模板之后 = 离模型更近，权重更高；写作要求里明写"冲突时以它为准"。
    guidance_block = _build_guidance_block(guidance, chapter_order)
    if guidance_block:
        prompt = prompt + "\n\n" + guidance_block

    # ⛔ 2026-09-21 用户裁定：**不再注入任何内容审核红线**。
    #
    # 原来这里会把 safety/guidelines.py 的 1188 字红线清单（27 个"禁止"）拼到
    # prompt **最前面**，作为最高优先级约束。它是"产出平淡乏味"的首要来源：
    #   · 清单里【四】禁止投胎转世/灵魂附身 → 直接封杀重生/穿越（本平台最大类型）
    #   · 【七】现代背景禁止主角用暴力/违法手段报复 → 封杀复仇打脸的发动机
    #   · 尾部三条"创作建议"（正向化解/克制笔法/优先情感张力而非视觉刺激）
    #     根本不是安全条款，是**伪装成红线的文风指令**，等于明令模型写淡一点
    #
    # 裁定理由：真正违法的文本模型厂商侧会拦，人工编辑还会再审一道，
    # 平台没有必要在提示词层再加一层自我审查。
    # ⚠️ 要恢复请先确认是哪条业务需求（投放平台过审？），不要凭"稳妥"直觉加回来。

    # 全局策略(2026-08): 不设 max_tokens——推理模型的 reasoning tokens 与正文共享
    # 预算且无法可靠单独限制, 任何"算预算"方案都会在模型更新后失效(draft 1273 事故)。
    # 字数控制完全交给应用层: prompt 内 word_min/word_max 约束 + 下方 word_hard_cap 硬截断。
    # streaming=False: 推理模型下 LangChain 流式聚合会提前截断长输出, 长文本场景必须关。

    async def _invoke() -> tuple[str, str]:
        llm = get_llm("generate", temperature=0.85, provider=provider, streaming=False)
        resp = await llm.ainvoke(prompt)
        t = (getattr(resp, "content", "") or "").strip()
        fr = ((getattr(resp, "response_metadata", None) or {}).get("finish_reason") or "")
        return t, fr

    text, finish_reason = await _invoke()

    # 保险丝: 不设 max_tokens 后理论上不会再有 finish_reason=length, 但保留校验——
    # 万一未来模型/代理引入隐藏输出上限, 或模型偶发输出过短, 重试一次而不是把残文落库
    def _looks_truncated(t: str, fr: str) -> bool:
        return fr == "length" or len(t) < min(100, word_min)

    if _looks_truncated(text, finish_reason):
        logger.warning(
            "chapter %s 疑似被截断/输出异常(finish_reason=%s, len=%d), 重试一次",
            chapter_order, finish_reason, len(text),
        )
        if draft_id:
            try:
                from .log_helper import save_log
                await save_log(
                    draft_id, "chapter",
                    f"⚠ 第{chapter_order}章输出异常(finish={finish_reason}, {len(text)}字), 正在重试...",
                    "warn", chapter_order,
                    {"finish_reason": finish_reason, "len": len(text)},
                )
            except Exception:
                pass
        text, finish_reason = await _invoke()
        if _looks_truncated(text, finish_reason):
            # 重试仍异常 → 抛错让调用方标记本章失败, 用户可重试; 绝不落几十字的垃圾正文
            raise RuntimeError(
                f"第{chapter_order}章生成输出异常(finish_reason={finish_reason}, 仅{len(text)}字), "
                f"请重试或更换模型"
            )

    # 硬截断: 字数 > word_hard_cap 就在最近段落边界(双换行/句号)切掉, 防止 LLM 越界离谱
    if len(text) > word_hard_cap:
        full_text_raw = text          # 截断前的完整稿 —— 必须留下, 见下
        truncated = text[:word_hard_cap]
        # 优先在双换行处切, 否则在中文句号/问号/感叹号处切
        for sep in ("\n\n", "。", "？", "！", "."):
            idx = truncated.rfind(sep)
            if idx > word_hard_cap * 0.7:  # 不要切得太狠
                truncated = truncated[: idx + len(sep)]
                break
        logger.warning("chapter %s 超长截断: %d -> %d (target=%d, hard_cap=%d)",
                       chapter_order, len(text), len(truncated), word_target, word_hard_cap)
        # ★ 把**未截断的完整稿**归档。
        #
        # 旧实现只写一条 generation_logs 警告就丢弃了截断部分 —— 日志里记着
        # "original_len=12000, truncated_len=7500", 但被切掉的 4500 字再也拿不回来。
        # 用户看到的是"生成完了", 实际上结尾被砍掉, 只能重新生成一次赌运气。
        # 归档后: 调用方落库的是截断稿, 而完整稿在历史版本里可取回。
        #
        # 这一步必须在截断稿写入之前完成 —— save_candidate 会往同一
        # (draft_id, order, "chapter") 序列追加一条, 后加的排在后、
        # 时间更晚不会被 10 版上限先淘汰掉, 完整稿因此能稳定留一段时间。
        if draft_id:
            try:
                from .candidate_store import snapshot_only
                await snapshot_only(
                    draft_id=draft_id,
                    order=chapter_order,
                    stage="chapter",
                    content={"full_text": full_text_raw, "title": "", "truncated": True},
                    version=0,
                    created_by="ai_generate_truncated",
                )
            except Exception as snap_ex:  # noqa: BLE001
                # 归档失败不能连累正文生成 —— 但要在日志里留痕, 不然就成了静默丢失。
                logger.warning("chapter %s 完整稿归档失败: %s", chapter_order, snap_ex)
        if draft_id:
            try:
                from .log_helper import save_log
                await save_log(
                    draft_id, "chapter",
                    f"⚠ 第{chapter_order}章超长 {len(text)} 字, 已截断到 {len(truncated)} 字 (目标 {word_target}, 上限 {word_hard_cap})；完整稿已存入历史版本，可从「历史版本」取回",
                    "warn", chapter_order,
                    {"original_len": len(text), "truncated_len": len(truncated), "target": word_target, "hard_cap": word_hard_cap,
                     "full_snapshot": True},
                )
            except Exception:
                pass
        text = truncated

    logger.info("chapter %s generated, len=%d (target=%d, range=[%d,%d], hard_cap=%d)",
                chapter_order, len(text), word_target, word_min, word_max, word_hard_cap)
    return text


async def summarize_chapter(chapter_text: str) -> str:
    """生成章末摘要（200-300 字）。

    ⚠️ 2026-10-10：不再 `chapter_text[:8000]`。

    那个截断是**偏差逐级放大的源头**（见 `_build_rolling_memory` 记的
    草稿 2421 事故）：5000 字的正文压成 250 字摘要，却只喂了前 8000 字 ——
    尾部情节**永远进不了摘要**。而摘要又是前情、续写、重写的输入，
    于是"摘要漏掉的事"在下游被当成"没发生"。

    现在按窗口给足（`text_budget`）；超长时保头+保尾，
    因为**集尾断点**恰恰是最该进摘要的那一拍。
    """
    if not chapter_text or len(chapter_text) < 50:
        return ""
    from .text_budget import text_budget_chars
    cap = _summarize_cap()
    body = chapter_text
    if len(body) > cap:
        from .episode_text import clip
        body = clip(body, cap, keep="both")
    summary_tpl = await _load_prompt_or_fallback_ch("chapter_summary", _SUMMARY_PROMPT)
    prompt = summary_tpl.format(chapter_text=body)
    llm = get_llm("generate", temperature=0.3)
    resp = await llm.ainvoke(prompt)
    return (getattr(resp, "content", "") or "").strip()


def _summarize_cap() -> int:
    """摘要生成能读多少正文 —— 按模型窗口算，取不到则退回改前的 8000。"""
    try:
        from ..config import get_settings
        from .text_budget import text_budget_chars
        return text_budget_chars(
            get_settings().llm_generate_model or "", purpose="chapter_prev")
    except Exception:  # noqa: BLE001
        return 8_000


# ---------------------------------------------------------------------------
# 人物名漂移检测
# ---------------------------------------------------------------------------

# 中文人名候选：连续 2-4 个汉字，前后不接其他汉字（粗略）。
# 我们再用人物表过滤；同时排除一些常见非人名词（"今天"/"明天"等）。
_NAME_CANDIDATE_RE = re.compile(r"[\u4e00-\u9fff]{2,4}")

_COMMON_NON_NAMES = {
    "今天", "明天", "昨天", "现在", "刚才", "突然", "忽然", "立刻", "马上",
    "似乎", "好像", "真的", "也许", "或许", "可能", "其实", "一边", "另一边",
    "于是", "然后", "接着", "随后", "终于", "竟然", "原来", "果然",
    "什么", "怎么", "为什么", "哪里", "这里", "那里",
    "自己", "别人", "大家", "他们", "她们", "我们", "你们",
    "一下", "几个", "许多", "很多", "一些", "全部", "所有",
    "起来", "下来", "出去", "进来", "回来", "过去",
}


def detect_name_drift(text: str, known_names: list[str]) -> list[dict]:
    """扫描文本，找出疑似人名但不在 known_names 列表里的 token。

    返回 [{candidate, frequency, suggestion}]，suggestion 是已知人物表里最相近的名字。
    用前端高亮 + "是否替换为 XX" 提示。
    """
    if not text or not known_names:
        return []
    known = set(str(n).strip() for n in known_names if str(n or "").strip())
    if not known:
        return []

    # 统计候选频次
    freq: dict[str, int] = {}
    for m in _NAME_CANDIDATE_RE.findall(text):
        if m in known or m in _COMMON_NON_NAMES:
            continue
        # 只关心比较像人名的：3 个字最常见，2 字也接受
        if len(m) > 4:
            continue
        freq[m] = freq.get(m, 0) + 1

    # 至少出现 2 次才算可疑（避免噪声）
    suspects = [(name, n) for name, n in freq.items() if n >= 2]
    suspects.sort(key=lambda x: -x[1])

    # 限制返回数量
    out = []
    for name, n in suspects[:10]:
        # 找最相似的已知人名（首字相同 / 含相同字）
        suggestion = ""
        for kn in known:
            if kn[0] == name[0] or any(c in kn for c in name):
                suggestion = kn
                break
        out.append({
            "candidate": name,
            "frequency": n,
            "suggestion": suggestion,
        })
    return out
