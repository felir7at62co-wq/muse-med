"""M5.4 剧本生成。把章节正文切成镜头表（JSON 数组）。

每个 shot 字段:
  - shot_no: 镜头序号
  - shot_type: 景别（远/全/中/近/特写）
  - duration: 估计秒数
  - location: 场景
  - characters: 出场人物
  - action: 角色动作描述
  - dialogue: 台词（可空）
  - notes: 拍摄注意事项（可空）
"""
from __future__ import annotations

import json
import logging
import re

from ..prompt.loader import load_active_template
from .scene_no import renumber_scenes
from ..models.llm import get_llm
from . import drama_principles
from .episode_render import render_neighbor_originals
from .script_format import parse_script, dump_script
from .scene_card import cards_for_episode, build_scene_cards_block

_PROVIDER_LABEL = {"gemini": "跨世界观模型", "deepseek": "通用模型", "gpt5": "逻辑专项模型"}

logger = logging.getLogger("storyboard_gen")




async def _load_prompt_or_fallback_sb(stage: str, fallback: str) -> str:
    try:
        tpl = await load_active_template(stage)
        return tpl if tpl else fallback
    except Exception:
        return fallback



# 章节正文版（有完整正文时使用）
#
# 2026-10-28：原先这条路实际跑的是 DB `storyboard_generate` 那份"转化准则"（8 条，多为否定式），
# 代码常量只在 DB 无行时才用。两份长期漂移，现把转化准则合并进来、DB 行在 dev 停用，
# 这里是唯一来源。
_PROMPT = """你是短剧剧本的格式编辑。下面是这一集已经写好的原文，请把它原样转成标准剧本格式：原文的每一句台词、每一段动作和画面描写都进入剧本，用原文的字句，顺序与原文一致。

## 章节信息
- 标题: {title}
- 正文:
{text}

""" + drama_principles.storyboard_block()

# 大纲梗概版（无章节正文时, 直接用本集 synopsis + 全剧上下文扩写）
#
# 🔴 2026-10-09 重写。原先本模板**只有一个 {synopsis}**（加相邻集梗概），
# 而本文件里 grep `core_push|stakes|plant|payoff|escalation|value_shift|hook_out|`
# `must_have|forbidden` 的命中数是 **0** —— 连传参的口子都没有。
# 实测后果（dev）：草稿 261 用 102 字梗概写出 5635 字剧本（55:1）、
# 652 用 97 字写出 5391 字（56:1）、653 用 107 字写出 4891 字（46:1）。
# 50 倍不是"扩写"，是**从零写**——用户反馈的"模型自己编大纲里没有的内容"
# 就是这个倍率的直接后果。而同期的 617/616/590 每一集都**有**完整契约，
# 只是被这条路丢掉了。所以缺的不是大纲质量，是**管道**。
_PROMPT_FROM_OUTLINE = """你是资深中国竖屏短剧编剧。本集已经有完整的大纲正文,还没有小说正文,请直接写成可拍摄的标准剧本分镜。竖屏短剧靠台词推进:每场都以人物交锋的对白为主体,冲突在对话里发生、爽点在对话里兑现,动作行交代谁在场、做了什么关键动作。

## 本集信息
- 标题: {title}

## 本集大纲（这一集要演的全部内容，按要素逐条兑现）
{synopsis}

{contract}

{beats}

## 全剧背景与上下文
{context}

{neighbors}
{ledger}

""" + drama_principles.storyboard_from_outline_block()


def _length_block(word_target: int) -> str:
    """单集篇幅目标（草稿的 chapter_word_target）。

    2026-10-28 补：此前剧本两条路径都**拿不到**草稿设置的每集字数，
    用户填了"每集 1000 字"只对正文路径生效，剧本长度完全由模型自由发挥。
    word_target<=0 时不注入（老调用方行为不变）。
    """
    if not word_target or word_target <= 0:
        return ""
    return (f"## 篇幅\n本集剧本（台词与动作行合计）约 {word_target} 字。"
            f"按场景节拍规划场数，篇幅优先分给人物交锋的对白。")


#: 上下文上限（字符）。2026-10-05 由 4000 放宽：
#:   4000 是早期拍脑袋常数，不是模型窗口限制；而「上一集全文」放不进 4000，
#:   于是模型永远看不见上一集写了什么 → 逐集独立扩写 → 相邻集重演同一场戏。
#:   实测本场景最大需求约 8400 字符（全剧背景 850 + 上下集梗概 200
#:   + 上一集全文 4766 + 账本 2527），20 万有 24 倍余量。
#:   ⚠️ 单位是**字符**不是 token（中文约 1-2 token/字），故不取 100 万。
_CTX_MAX_CHARS = 200_000


def _clip_chapter_text(chapter_text: str) -> str:
    """本集正文进入分镜 prompt 前的裁剪 —— 上限按模型窗口算。

    ⚠️ 2026-10-10：原实现是硬编码 `chapter_text[:15000]`。那个数字是
    "拍脑袋防爆"的产物，既不跟窗口对账，也不区分正文字数：
    5000 字的一集在 70 万口径下被无端砍掉 2/3，而它本来完全装得下。

    现在走 `text_budget`（purpose="storyboard"）。取不到配置时退回
    `_CHAPTER_TEXT_FALLBACK`，绝不让整集失败。
    """
    t = chapter_text or ""
    limit = _CHAPTER_TEXT_FALLBACK
    try:
        from ..config import get_settings
        from .text_budget import text_budget_chars
        limit = text_budget_chars(
            get_settings().llm_generate_model or "", purpose="storyboard")
    except Exception:  # noqa: BLE001
        pass
    if len(t) <= limit:
        return t
    # 保头 + 保尾：分镜要覆盖全集，中间略去并显式标注。
    from .episode_text import clip
    return clip(t, limit, keep="both")


#: 取不到窗口配置时的正文字符上限（沿用改前的 15000 作为保守兜底）。
_CHAPTER_TEXT_FALLBACK = 15_000


def _repair_bare_quotes(s: str) -> str:
    """给 JSON 字符串值内部**未转义的裸双引号**补上转义。

    🔴 2026-10-05 加：这是本解析器崩溃的主因。模型写中文内容时爱用 ASCII
    双引号（`他说"我不签"`），而在 JSON 里那个 `"` 会被当成**字符串结束符**，
    于是报 `Expecting ',' delimiter`。2026-10-05 那次全量重跑实测 300 集里
    有约 34% 栽在这一条上——而失败集**静默保留旧内容**（batch_gen 只记
    `kept_old` 不重试），等于三分之一白跑。

    判定规则：字符串内部遇到的 `"`，若其后第一个非空白字符不是
    `,` `:` `}` `]` 之一，它就不是结束引号，而是内容里的字面引号。
    """
    out = []
    i, n = 0, len(s)
    in_str = False
    while i < n:
        c = s[i]
        if not in_str:
            out.append(c)
            if c == '"':
                in_str = True
            i += 1
            continue
        # —— 以下都在字符串内部 ——
        if c == "\\":
            out.append(c)
            if i + 1 < n:
                out.append(s[i + 1])
            i += 2
            continue
        if c == '"':
            j = i + 1
            while j < n and s[j] in " \t\r\n":
                j += 1
            if j >= n or s[j] in ",:}]":
                out.append(c)      # 真的是结束引号
                in_str = False
            else:
                out.append('\\"')  # 内容里的裸引号
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _extract_json(text: str) -> list:
    """兼容路径专用（`script_format._parse_json_compat` 与 adaptation 会调）。

    ⚠️ 2026-11-06：剧本的三条生成路径已不再走这里 —— 模型现在输出标准剧本格式，
    由 `script_format.parse_script()` 解析。本函数只服务于：
      · 解析器对旧 JSON 输出的回退；
      · `adaptation.py` 的剧本仿写（那里仍是独立的 JSON 提示词，尚未迁移）。
    """
    """从模型返回里解析出镜头数组。

    ⚠️ 这里的容错不是"锦上添花"，是**必需**：解析失败会让这一集**静默保留
    旧内容**（batch_gen 记 `kept_old` 后继续下一集，不重试），用户看到的是
    "重跑过了"，实际那一集一个字没变。同仓库的 `critique/service.py`、
    `polish/ledger.py`、`features/preview_routes.py` 早就都用宽松解析了，
    只有这里裸调 `json.loads` —— 2026-10-05 实测 34% 失败率即由此而来。
    """
    if not text:
        raise ValueError("empty LLM response")
    raw = text.strip()
    # 去 ```json 围栏（前后可能还夹着说明文字）
    m = re.search(r"```(?:json)?\s*(.+?)\s*```", raw, re.DOTALL)
    if m:
        raw = m.group(1).strip()
    else:
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    # 截到最外层数组，去掉前后噪声
    i, j = raw.find("["), raw.rfind("]")
    if i != -1 and j != -1 and j > i:
        raw = raw[i:j + 1]

    fixed = _repair_bare_quotes(raw)
    no_trail = re.sub(r",\s*([}\]])", r"\1", fixed)   # 尾随逗号
    key_quote = re.sub(r'([{,]\s*)\\?([A-Za-z_][A-Za-z0-9_]*)("\s*:)',
                       r'\1"\2\3', no_trail)          # 键的起始引号丢失

    last: Exception | None = None
    for cand in (raw, fixed, no_trail, key_quote):
        for strict in (True, False):        # strict=False 容忍串内控制字符
            try:
                data = json.loads(cand, strict=strict)
            except Exception as e:  # noqa: BLE001
                last = e
                continue
            if isinstance(data, list):
                return data
            if isinstance(data, dict):
                return [data]
            last = ValueError(f"expected JSON array, got {type(data).__name__}")
    logger.warning("剧本 JSON 解析失败, 原始返回前 400 字: %s", raw[:400])
    raise ValueError(f"JSON 解析失败: {last}")



def _normalize(items: list) -> list[dict]:
    """兼容两种格式:
    1. 新版剧本式(scene_no/time_loc/elements) - 直接保留
    2. 旧版镜头表(shot_no/action/dialogue) - 转为兼容结构

    重排不在这里做 —— 本函数不知道自己在做第几集，调用方拿到结果后统一走
    `scene_no.renumber_scenes(shots, 真实集号)`。

    ## 为什么必须在这里重排（2026-10-23 用户报的 bug）
    提示词要求 scene_no 用「集号-场号」且**从 1-1 开始递增**，但本函数所属的
    生成链**根本不知道自己在生成第几集**（集号从来不是它的入参）—— 模型只能
    照字面从 1-1 起编，于是第 2 集以后每一集都成了 "1-1/1-2"。
    dev 库实测 52813 个分镜里 17780 个前缀是错的，且**错的全是退化成 1-x**。
    修法与完整说明见 `stages/scene_no.py`。
    """
    out = []
    for i, s in enumerate(items):
        if not isinstance(s, dict):
            continue
        # 新格式: 包含scene_no或elements
        if "scene_no" in s or "elements" in s:
            elements = s.get("elements") or []
            # 验证elements格式
            valid_elements = []
            for e in elements:
                if not isinstance(e, dict):
                    continue
                etype = e.get("type", "action")
                if etype == "action":
                    valid_elements.append({"type": "action", "content": str(e.get("content", "")).strip()})
                elif etype == "dialogue":
                    valid_elements.append({
                        "type": "dialogue",
                        "character": str(e.get("character", "")).strip(),
                        "mode": str(e.get("mode", "")).strip(),
                        "action": str(e.get("action", "")).strip(),
                        "content": str(e.get("content", "")).strip(),
                    })
                elif etype in ("flashback_start", "flashback_end"):
                    valid_elements.append({"type": etype})
            out.append({
                "scene_no": str(s.get("scene_no", f"1-{i+1}")).strip(),
                "time_loc": str(s.get("time_loc", "")).strip(),
                "characters": list(s.get("characters") or []),
                "subtitle": str(s.get("subtitle", "")).strip(),
                "is_flashback": bool(s.get("is_flashback", False)),
                "elements": valid_elements,
                # 兼容旧前端的shot_no/action字段
                "shot_no": i + 1,
                "shot_type": "中景",
                "duration": 5,
                "location": str(s.get("time_loc", "")).strip(),
                # ⚠️ 拼接时要防重复加前缀：模型产出的 element content 里**通常已经带了 `△`**，
                # 无条件再加就会拼成 `△△`（实测 50 集里 1400 行全部如此）。
                # 这里做成幂等：已有 △ 就原样用，没有才补一个。
                "action": "\n".join(
                    (
                        c if c.startswith("△") else "△" + c
                    )
                    for e in valid_elements
                    if e.get("type") == "action"
                    for c in [(e.get("content", "") or "").strip()]
                    if c
                ),
                "dialogue": "\n".join(
                    (
                        (e.get("character", "") or "").strip()
                        + (f"({e['mode']})" if (e.get("mode", "") or "").strip() else "")
                        + (f"【{e['action']}】" if (e.get("action", "") or "").strip() else "")
                        + ": "
                        + (e.get("content", "") or "").strip()
                    )
                    for e in valid_elements
                    if e.get("type") == "dialogue" and (e.get("content", "") or "").strip()
                ),
                "notes": "",
            })
        else:
            # 旧格式: 保留原结构
            out.append({
                "shot_no": i + 1,
                "shot_type": str(s.get("shot_type", "中景")).strip(),
                "duration": int(s.get("duration", 5) or 5),
                "location": str(s.get("location", "")).strip(),
                "characters": list(s.get("characters") or []),
                "action": str(s.get("action", "")).strip(),
                "dialogue": str(s.get("dialogue", "")).strip(),
                "notes": str(s.get("notes", "")).strip(),
            })
    return out


def _drop_title_echo(text: str, title: str = "") -> str:
    """导入的原文开头常有一行"半句复读"：正文第一句的前 20 字被截出来单独成行，
    下一段又是完整的同一句（如「画面呈现许流年家外的场景：带花纹装饰的黑」）。
    逐句转格式会把这半句照抄成一条动作行。只在首行很短、且紧跟的一段以它开头时去掉。"""
    t = (text or "").lstrip()
    head, _, rest = t.partition("\n")
    h, r = head.strip(), rest.lstrip()
    if h and len(h) <= 30 and r.startswith(h) and len(r) > len(h):
        return r
    return text


async def generate_storyboard(*, chapter_text: str, chapter_title: str, provider: str = "gemini", draft_id: int | None = None, ledger_block: str = "", episode_order: int = 0, word_target: int = 0) -> list[dict]:
    """生成单章剧本。

    P5: ledger_block 为该集的状态账本快照(可选), 有值时作为硬约束注入,
    保证分镜不引入已死角色等硬伤。
    """
    # 章节太长就截断 —— 但上限按模型窗口算，不再硬编码 15000。
    # ⚠️ 2026-10-10：15000 从不跟窗口对账，在 70 万口径下令 5000 字的一集
    # 被无理由裁掉三分之二。现在按用途预算取（text_budget）。
    text = _clip_chapter_text(_drop_title_echo(chapter_text, chapter_title))
    base_prompt_sb = await _load_prompt_or_fallback_sb("storyboard_generate", _PROMPT)
    if draft_id:
        try:
            from .log_helper import save_log
            await save_log(draft_id, "storyboard", f"{chapter_title}使用模型: {_PROVIDER_LABEL.get(provider, provider)}", "log", 0)
        except Exception:
            pass
    if ledger_block:
        text = f"{ledger_block}\n\n（以上为世界状态硬约束: 已死角色不得出场,除非明确闪回/回忆）\n\n{text}"
    prompt = base_prompt_sb.format(title=chapter_title, text=text)
    # 🔴 2026-10-14：镜头语言原则改为**代码侧注入**，不再靠 DB 模板内联。
    #
    # 原状：DB `storyboard_generate v5` 把 LENS/SHARED/OUTLINE/ENDING 四套原则
    #   全部内联进模板。于是 DB 有行时代码兜底 `_PROMPT` 里那句
    #   `+ drama_principles.storyboard_block()` **根本不执行** —— 库模板独占了
    #   原则注入，而它与代码常量长期漂移（首集规则三处重复即由此而来）。
    #
    # 现在 DB 模板瘦身为"转化准则"，镜头语言原则回到唯一事实来源
    #   `drama_principles.storyboard_block()`，DB 里也改也同步生效（存量模板
    #   若仍内联原则，会被下面 `_PH` 判据识别，不会拼第二遍）。
    #
    # ⚠️ 判据必须是"原则块的**标题**是否已在模板里"，不能用 `{placeholder}`
    #   是否出现来判断：本块含字面 JSON 花括号，**不能**走 format，
    #   所以它从来不会以占位符形式出现在模板中。
    _PH = "## 🎯 分镜核心原则"
    if _PH not in base_prompt_sb:
        prompt = prompt + "\n\n" + drama_principles.storyboard_block()
    # 原文转剧本不注入篇幅目标：长短由原文决定（2026-10-30，按字数增删正是"改原文"的来源之一）。
    # word_target 参数保留只为调用方签名兼容。
    # max_tokens 按原文给足：剧本 JSON 约是原文字数的 2–3 倍，写死 8192 会截断长集。
    # ⛔ 2026-09-21 用户裁定：不再注入内容审核红线（详见 chapter_gen 同位置的说明）
    llm = get_llm("generate", temperature=0.2, provider=provider, max_tokens=max(8192, len(text) * 4))
    try:
        await save_log(draft_id, "storyboard", f"{chapter_title}正在调用AI生成剧本...", "progress", 0)
    except: pass
    resp = await llm.ainvoke(prompt)
    try:
        await save_log(draft_id, "storyboard", f"{chapter_title}AI返回,正在解析剧本数据...", "progress", 0)
    except: pass
    raw = (getattr(resp, "content", "") or "").strip()
    logger.info("storyboard raw len=%d", len(raw))
    # 2026-11-06：模型输出的是**标准剧本格式**（见 script_format.OUTPUT_SPEC），
    # 这里机械解析成场次数组。旧的 JSON 输出仍被兼容（parse_script 内部回退）。
    data = parse_script(raw, order=episode_order)
    return renumber_scenes(data, episode_order)


_REVISE_PROMPT = """你是资深中国竖屏短剧编剧。下面是第{order}集《{title}》**现有的剧本**，请**按修改意见在它的基础上重新写一遍这一集**。

## 修改意见（必须逐条落实）
{feedback}

## 修改规则
1. 这是修改，不是重写：意见没有提到的场次、动作、台词保持原样（含措辞），不要顺手润色。
2. 意见要求的改动必须真实体现在输出里；意见里引用的原文台词/动作，照引用写入，不要改写成别的说法。
3. 输出**整集**，格式与下面的底稿完全一致（场次头、人物行、△ 动作行、`人物：台词` 行）。
4. 没有改动的行原样抄回来，一行都不要删。

## 现有剧本（底稿）
{current}

{reference}

""" + drama_principles.storyboard_from_outline_block()


async def revise_storyboard(*, current_shots: list, feedback: str, title: str, order: int,
                            reference_text: str = "", provider: str = "gemini",
                            draft_id: int | None = None) -> list[dict]:
    """在现有剧本上按意见修改（不是重新生成）。

    🔴 2026-10-19 新增。此前"按意见重写剧本"复用 generate_storyboard：把正文、现有剧本、意见
    全塞进"请把下面的章节正文转化为剧本"的 {text} 槽里，结果三个问题叠在一起 ——
      · 模型把它当成一次全新的正文转剧本，上一轮按意见改好的地方被冲掉（实测：预埋的改动
        在一轮无关意见后消失），多轮意见无法叠加；
      · 意见拼在 text 末尾，而裁剪是从末尾砍，长集里**意见本身会被静默截掉**；
      · 分镜原则块追加在意见之后，进一步稀释意见。
    现在：意见放在最前、现有剧本是底稿、正文只作参照（只裁参照，不裁底稿与意见）。
    """
    ref = ""
    if (reference_text or "").strip():
        ref = "## 参照（本集正文，事实以它为准；不要据此重写整集）\n" + _clip_chapter_text(reference_text)
    prompt = _REVISE_PROMPT.format(
        order=order, title=title, feedback=feedback.strip(),
        # 底稿用**剧本格式**交给模型，不是 JSON：它读自己写出来的形状更容易保持一致，
        # 也不会被 JSON 的转义带着把台词写短。
        current=dump_script(current_shots, order=order, title=title),
        reference=ref)
    llm = get_llm("generate", temperature=0.4, provider=provider)
    resp = await llm.ainvoke(prompt)
    raw = (getattr(resp, "content", "") or "").strip()
    shots = renumber_scenes(parse_script(raw, order=order), order)
    if not shots:
        raise ValueError("按意见修改剧本没有得到可解析的输出，原剧本未改动")
    return shots


async def generate_storyboard_from_outline(
    *,
    synopsis: str,
    chapter_title: str,
    context: str = "",
    provider: str = "gemini",
    draft_id: int | None = None,
    prev_text: str = "",
    next_text: str = "",
    ledger_block: str = "",
    contract_block: str = "",
    beats_block: str = "",
    episode_order: int = 0,
    word_target: int = 0,
) -> list[dict]:
    """无章节正文时, 用本集梗概 + 戏剧契约 + 场景节拍 + 全剧上下文扩写生成剧本。

    2026-10-05 新增两个入参, 治「相邻集重演」:
      prev_text    上一集**实际生成的剧本正文**(不是梗概)。此前四个调用点
                   一律只喂梗概, 模型看不见上一集写了什么, 只能把本集梗概
                   里那个"承接上一集断点"的节拍从头再演一遍 —— 换命 ep1/ep2
                   把「你签的时候看了吗」演了两遍即此因。
      ledger_block 状态账本硬约束快照(与有正文路径同款)。此前大纲直生分支
                   完全不注入, 而全库 5479 集走的都是这条路, 等于账本从未生效。

    🔴 2026-10-09 新增两个入参, 治**根本病因「信息量不足所以自己编」**:
      contract_block 本集戏剧契约(推进点/价值转变/失败代价/升级/钩子/伏笔/禁区)。
      beats_block    本集场景节拍(按顺序演哪几拍, 每条带地点/在场人物/动作/转折)。

    这两个块的来源是集纲, 由调用方用 `episode_render` 渲染好传入 ——
    **不在本函数里读 outline**，因为本函数也被 `create_spawn` 那种没有 draft_id
    的路径调用，读 outline 会把签名和职责搅在一起。

    ⚠️ 此前这条路 `synopsis` 是唯一的剧情依据。实测 46~56 倍扩写倍率下，
    模型只能自己补足缺的那一层决策 —— 这不是模型"不听话"，是**没告诉它**。
    """
    syn = (synopsis or "").strip()
    ctx = (context or "").strip()
    prev = (prev_text or "").strip()
    nxt = (next_text or "").strip()
    led = (ledger_block or "").strip()
    # ⚠️ 契约与节拍**不参与截断**：它们是"本集演什么"的规格，砍了就等于退回
    # 只有一句梗概的旧行为。要砍先砍全剧上下文（最可牺牲）与邻集原文。
    ctr = (contract_block or "").strip()
    bts = (beats_block or "").strip()

    # 保护性截断: 超出预算时**先砍上下文、再砍相邻集原文**,
    # 绝不砍本集梗概/契约/节拍。
    # (旧代码是 ctx[:4000] 从头保留, 而新内容拼在末尾 → 越重要越先被切掉。)
    budget = _CTX_MAX_CHARS
    protected = len(ctr) + len(bts)
    if len(ctx) + len(prev) + len(nxt) + len(led) + protected > budget:
        room = budget - len(prev) - len(nxt) - len(led) - protected
        if room < 0:  # 邻集与账本各自也超了, 先保账本(短且是硬约束), 再保相邻集
            led = led[: max(0, (budget - protected) // 4)]
            rest = max(0, budget - protected - len(led))
            # 上下集对半——上一集管衔接、下一集管避让，都要留
            prev = prev[: rest // 2]
            nxt = nxt[: rest - len(prev)]
            room = 0
        ctx = ctx[:room] if room > 0 else ""

    # 🔴 2026-10-09：相邻集改用**原文**（用户已定结论：直接使用上下集的原文而非梗概）。
    #
    # 2026-10-05 已发现同类问题：只喂上一集**梗概**时模型看不见上一集实际写了什么，
    # 而每集梗概的核心冲突往往正是承接上一集断点的那句对话 → 只能把同一场戏
    # 从头再演一遍（换命 ep1/ep2、此刻 ep4/ep5 即此）。当时的处置是**另加**一路
    # prev_text，但 context 里那两行「上一集梗概 / 下一集梗概」**没有删** ——
    # 同一条信息以两个口径同时在 prompt 里，一个精确一个模糊，按哪个写是不确定的。
    # 现在统一：原文优先，原文没有才由调用方退回梗概，且两者不会同时出现。
    neighbors = render_neighbor_originals(
        {"prev": prev or None, "next": nxt or None})
    ledger = f"\n{led}\n" if led else ""
    contract = f"\n{ctr}\n" if ctr else ""
    beats = f"\n{bts}\n" if bts else ""
    # 兼容：DB 若存在带 {prev_text} 的旧模板，仍给它一份上一集内容（不会与
    # {neighbors} 同时出现在同一份模板里 —— 代码常量只认 {neighbors}）。
    legacy_prev = f"{prev}\n" if prev else ""

    base_prompt_sb = await _load_prompt_or_fallback_sb("storyboard_from_outline", _PROMPT_FROM_OUTLINE)
    if draft_id:
        try:
            from .log_helper import save_log
            await save_log(draft_id, "storyboard", f"{chapter_title}(大纲直生)使用模型: {_PROVIDER_LABEL.get(provider, provider)}", "log", 0)
        except Exception:
            pass
    fmt = dict(
        title=chapter_title,
        synopsis=syn,
        context=ctx or "(无额外上下文)",
        neighbors=neighbors,
        prev_text=legacy_prev,
        ledger=ledger,
        contract=contract,
        beats=beats,
    )
    try:
        prompt = base_prompt_sb.format(**fmt)
    except KeyError:
        # DB 模板含本代码不识别的 placeholder → 降级为朴素替换，不让整集失败
        prompt = base_prompt_sb
        for k, v in fmt.items():
            prompt = prompt.replace("{" + k + "}", str(v))
    # ⚠️ 上面 try 成功**不代表契约/节拍进了 prompt**：`.format()` 对多余的 kwargs
    # 不报错，DB 模板没有 {contract}/{beats} 时它们会被**静默丢掉**，而代码里
    # 看着"明明传了"（chapter_gen 2026-09-21 踩过同一脚，注释见那里）。
    # 判据是占位符是否出现在原始模板里 → 没有就拼在后面，有就不会拼第二遍。
    # ⚠️ 与有正文路径同款（见 generate_storyboard 里的长注释）：原则块按**标题**
    #    判重后拼接，这样将来若给 storyboard_from_outline 也配 DB 模板，
    #    瘦身模板不会把镜头语言原则一起丢掉。
    _SB_PH = "## 🎯 分镜核心原则"
    if _SB_PH not in base_prompt_sb:
        prompt = prompt + "\n\n" + drama_principles.storyboard_from_outline_block()
    for _ph, _val in (("{contract}", contract), ("{beats}", beats),
                      ("{neighbors}", neighbors)):
        if _ph not in base_prompt_sb and str(_val or "").strip():
            prompt = prompt + "\n\n" + str(_val)
    if _length_block(word_target):
        prompt = prompt + "\n\n" + _length_block(word_target)
    logger.info(
        "storyboard(from_outline) prompt parts: ctx=%d neighbors=%d ledger=%d contract=%d beats=%d total=%d",
        len(ctx), len(prev), len(led), len(ctr), len(bts), len(prompt),
    )
    # ⛔ 2026-09-21：同上，不注入红线
    llm = get_llm("generate", temperature=0.6, provider=provider, max_tokens=8192)
    try:
        await save_log(draft_id, "storyboard", f"{chapter_title}正在根据大纲直接生成剧本...", "progress", 0)
    except Exception:
        pass
    resp = await llm.ainvoke(prompt)
    try:
        await save_log(draft_id, "storyboard", f"{chapter_title}AI返回,正在解析剧本数据...", "progress", 0)
    except Exception:
        pass
    raw = (getattr(resp, "content", "") or "").strip()
    logger.info("storyboard(from_outline) raw len=%d", len(raw))
    # 同上：剧本格式文本 → 场次数组。这是全库 5479 集走的主路径。
    data = parse_script(raw, order=episode_order)
    return renumber_scenes(data, episode_order)


# ---------------------------------------------------------------------------
# 按场生成剧本（第四步）
# ---------------------------------------------------------------------------

_PROMPT_BY_SCENE = """你是资深中国竖屏短剧编剧。下面给你**这一场**的场景卡，只写这一场的剧本。
竖屏短剧靠台词推进：冲突在对话里发生、爽点在对话里兑现，动作行只交代谁在场、做了什么关键动作。

## 本集信息
- 第 {order} 集《{title}》
- 本场：场{card_no} {at}

## 本场场景卡
- 在场人物：{who}
- **意图**（核心人物这一场想要什么）：{intent}
- **障碍**（阻止他/她的是什么）：{obstacle}
- 动作：{action}
- 这一场结束时局面变成：{turn}
- 戏剧功能：{drama_role}

## 本集戏剧契约（必须贯穿本场）
{contract_block}

## 上一场已生成的剧本（用于衔接，不要重演）
{prev_scene_text}

""" + drama_principles.storyboard_from_outline_block()

_MERGE_HEADER = "# 集{order}集-场{card_no}"


async def generate_storyboard_by_scene(
    *,
    outline: dict,
    chapter_order: int,
    provider: str = "gemini",
    draft_id: int | None = None,
    ledger_block: str = "",
    word_target: int = 0,
) -> list[dict]:
    """按场景卡逐场生成剧本，每场独立调用，上一场实际文本作为衔接上下文。

    有场景卡（且至少一张有 intent）时才走这条路；否则调用方应退回整集生成。
    每场只生成该场的场景，最后合并成整集 shots。

    失败策略：
    - 单场解析失败 → 该场返回空 shots，继续下一场（不阻断）
    - 全场失败 → 调用方 fallback 到整集生成
    """
    ep = next((c for c in (outline.get("chapters") or [])
               if int(c.get("order") or 0) == int(chapter_order)), None)
    if not isinstance(ep, dict):
        return []

    from .scene_card import cards_for_episode
    from .episode_render import build_contract_block

    cards = cards_for_episode(outline, chapter_order)
    if not cards or not any(c.get("intent") for c in cards):
        return []

    title = ep.get("title") or f"第{chapter_order}集"
    contract_blk = build_contract_block(outline, chapter_order)
    n = len(cards)
    all_shots: list[dict] = []
    prev_scene_text = ""

    for i, card in enumerate(cards, 1):
        card_no = card.get("card_no", i)
        at = (card.get("at") or "").strip()
        who = (card.get("who") or "").strip()
        intent = (card.get("intent") or "（暂无）").strip()
        obstacle = (card.get("obstacle") or "（暂无）").strip()
        action = (card.get("action") or "").strip()
        turn = (card.get("turn") or "").strip()
        drama_role = (card.get("drama_role") or "").strip()

        prev_blk = ""
        if prev_scene_text.strip():
            preview = prev_scene_text.strip()[:1200]
            prev_blk = f"【上一场节选（最后 1200 字）】\n{preview}"
        else:
            prev_blk = "（本集第一场）"

        prompt = _PROMPT_BY_SCENE.format(
            order=chapter_order, title=title,
            card_no=card_no, at=at, who=who,
            intent=intent, obstacle=obstacle,
            action=action, turn=turn,
            drama_role=drama_role,
            contract_block=contract_blk or "（无）",
            prev_scene_text=prev_blk,
        )
        if _length_block(word_target):
            scene_wt = max(300, word_target // n)
            prompt += f"\n\n本场篇幅约 {scene_wt} 字（台词与动作行合计）。"

        try:
            if draft_id:
                try:
                    from .log_helper import save_log
                    await save_log(draft_id, "storyboard",
                                   f"第{chapter_order}集·场{card_no}/{n} 正在生成...", "progress", 0)
                except Exception:
                    pass
            llm = get_llm("generate", temperature=0.65, provider=provider, max_tokens=4096)
            resp = await llm.ainvoke(prompt)
            raw = (getattr(resp, "content", "") or "").strip()
            logger.info("storyboard_by_scene ep=%d card=%d/%d raw_len=%d",
                        chapter_order, card_no, n, len(raw))
            shots = parse_script(raw, order=chapter_order)
            if shots:
                all_shots.extend(shots)
                # 用上一场的剧本文本作为下一场的衔接上下文
                prev_scene_text = dump_script(shots, order=chapter_order,
                                             title=f"场{card_no}节选")
            else:
                logger.warning("storyboard_by_scene ep=%d card=%d parse 返回空 shots",
                               chapter_order, card_no)
        except Exception as e:  # noqa: BLE001
            logger.warning("storyboard_by_scene ep=%d card=%d 生成失败: %s",
                           chapter_order, card_no, e)

    if not all_shots:
        return []
    return renumber_scenes(all_shots, chapter_order)
