"""P1: 故事圣经 (Story Bible) —— 大纲之前先定的不可漂移事实基线。

设计目标(见 PLAN-大纲与剧本生成-诊断与重构 §3.2):
  原文/题材进来先生成基线, 后续大纲/剧本/分镜都受其约束。

Bible JSON 结构:
{
  "characters": [
    {"name","role","arc","ending_state","appearance"}
  ],
  "core_mysteries": ["贯穿全剧的核心悬念"],
  "world": {"era","setting","rules":[]},
  "forbidden": ["世界观硬约束, 如'无法复活'"]
}

存进 ScriptDraft.outline["story_bible"], 零新表。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from ..models.llm import get_llm
from .outline_format import parse_bible

logger = logging.getLogger("story_bible")


_BIBLE_PROMPT = """你是资深剧本策划。根据用户给出的题材/概要, 提炼一份"故事圣经"——全剧不可漂移的事实基线 + 戏剧基线。它将约束后续所有大纲、剧本、分镜的生成, 确保剧情既自洽(不出现死人复活、设定矛盾), 又好看(有清楚的主线、有具体的对手、有在同一群人之间不断加码的升级)。

## 用户题材/概要
{user_input}

## 输出格式：分块文本（不要 JSON、不要解释）

【剧名】中国短剧风格的标题，一眼看出题材与爽点

【一句话故事】
谁 + 因为什么 + 做了什么 + 结果（30~60 字，能直接印在海报上）

【题材定位】一句话，如"都市豪门 + 情感甜宠 + 重生复仇"

【受众】
性别：女频/男频/全年龄
年龄：主要年龄段
观看场景：在什么场景下看
此刻想被满足的情绪：他们此刻想被满足的情绪，写成一个能看到画面的句子

【卖点】
1. 核心卖点，观众一眼看懂的钩子（身份差、关系差、逆袭方式）
2. 同上
3. 同上
（3~5 条，每条一行，以"编号. "开头）

【核心悬念】
- 贯穿全剧的核心悬念（每条一行，2~5 条）

【主线三件事】
要什么：主角要得到或守住的具体的人、物、位置或结果
谁在挡：谁在挡主角、为什么挡（对手具体的利益或执念）
靠什么赢：主角身上别人没有的哪样本事、资源或信息差

【全剧前提】
一句话，写出人物立场 + 核心冲突 + 结局方向，是一个能被剧情证明的主张

【人物绑定】
主角与关键人物之间为什么不能轻易分开，以及每次绑定如何升级

【爽点承诺】本剧向观众承诺的爽点是什么，预计在哪几集兑付

【主要对手】
对手姓名：须在下面的角色里
目标：他/她要达成的目标
为什么站得住：对手的动机为什么成立（稳定的利益、欲望或信念）
手段升级路径：第1层 → 第2层 → 第3层（用 → 分隔）

【世界】
时代：时代/世界观
核心场景：
- 场景名——属于谁、代表什么权力关系（3~5 处）
行得通的规则：
- 这个世界里什么事行得通
不出现的元素：
- 不能出现的东西

【角色】姓名｜定位（主角/男主/反派/配角）
身份：对外身份 + 真实身份
标签：标签1、标签2
外观：50 字内的视觉形象
性格：外在表现；内在性格；两者如何反差
经历：一整段，什么经历造成了现在的行为方式
动机：核心动机 + 当前困境
关系：与主角或其他人的关系，以及这段关系在全剧里怎么演变
弧光：这个角色从头到尾的转变，一句话
结局：存活/死亡/离场/待定（用户或原作已确定的照填，其余填"待定"）
伤口：人物的缺口（只对重要角色填）
需要学会：他真正需要学会的东西（只对重要角色填）
自欺：他自欺的信念（只对重要角色填）

【升级阶梯】
1. 第1档：主角面临失去什么
2. 第2档：…
3. 第3档：…

【硬约束】
- 世界观硬约束（现实题材至少一条关于生死的）

## 填写要点
- title / one_liner / audience / selling_points / tone 是**给发行和投放看的**：写出来要能直接拿去投流。卖点 3-5 条，每条都是观众能一眼看懂的钩子（身份差、关系差、逆袭方式），不写"剧情精彩"这类空话。
- main_line 三件事落到具体的人和物上；后面所有大纲都围绕它推进，全剧沿用。
  用户给的是一部原作、要求洗稿或改编时，main_line 写**新剧自己的**三件事：沿用原作的爽感结构（弱者被压—蓄力—反制），主角要守的东西、对手、主角的本事和对手的手段都换成新的；人物姓名也全部新起。
- premise 是一个可被剧情证明的主张。
- characters 覆盖所有重要角色(>=3个)，姓名全剧固定。**每个角色都写 identity / tags / appearance / traits / backstory / motive / relations**：这些是小传，后续所有集的人物言行都以它为准，写空了下游就只能自己编。relations 要写出**关系的演变轨迹**，不是一句"是夫妻"。
- ending_state 是角色的全剧最终结局，用于让后续生成保持生死一致：用户或原作已经确定的照填；没有确定的填"待定"，把生死反转的空间留给后面。
- opponent.right_about 写对手**可信的动机来源**(稳定的利益、欲望或信念)，让对手的每一步都有道理；纯粹逐利或操控型的对手，写清要什么、为什么这样算计即可，道德上可以完全错误。
- opponent.escalation 与 escalation_ladder 描述**同一群人之间的加码**：对手用自己惯用、与身份相符的手段，一层比一层押得多(自己的家业、面子、身边的人)；主角每一档面临失去的东西(身份/资格/亲情/自由/传承/机会/信任/财产/性命)离主角更近、更不可替代。阶梯 3-5 档，涉及的人都是第 1 集就出场或埋下的人。
- forbidden 至少一条关于生死或世界规则的硬约束。
- 只输出 JSON 对象本身。
"""


def _extract_json(text: str) -> dict:
    if not text:
        raise ValueError("empty LLM response")
    raw = text.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw)
    except Exception:
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if not m:
            raise
        return json.loads(m.group(0))


def _normalize_bible(data: Any) -> dict:
    if not isinstance(data, dict):
        raise ValueError("bible json is not an object")
    world = data.get("world") if isinstance(data.get("world"), dict) else {}
    out = {
        # 2026-11-04：发行/投放侧的设定（原先完全没有 —— 剧名靠大纲顺手给，
        # 受众与卖点一个字都没有，下游写"这一集该给谁看、要兑现哪种爽点"时无据可依）。
        # 全部可选：老圣经没有这些键时为空，渲染时整段不出现。
        "title": str(data.get("title", "") or "").strip(),
        "one_liner": str(data.get("one_liner", "") or "").strip(),
        "audience": {k: str((data.get("audience") or {}).get(k, "") or "").strip()
                     for k in ("gender", "age", "scene", "craving")}
        if isinstance(data.get("audience"), dict) else {},
        "selling_points": [str(x).strip() for x in (data.get("selling_points") or []) if str(x).strip()],
        "tone": str(data.get("tone", "") or "").strip(),
        "world": {
            "era": str(world.get("era", "")).strip(),
            "setting": str(world.get("setting", "")).strip(),
            "rules": [str(r).strip() for r in (world.get("rules") or []) if str(r).strip()],
            # 不能出现的东西与"必须遵守的规则"是两回事，单列一格：
            # 混进 rules 里会被模型当成"要写出来的规则"。
            "rules_forbidden": [str(r).strip() for r in (world.get("rules_forbidden") or []) if str(r).strip()],
        },
        "characters": [],
        "core_mysteries": [str(m).strip() for m in (data.get("core_mysteries") or []) if str(m).strip()],
        "forbidden": [str(f).strip() for f in (data.get("forbidden") or []) if str(f).strip()],
        # ---- D4 戏剧圣经字段（全部可选，老数据不受影响）----
        "premise": str(data.get("premise", "") or "").strip(),
        "binding": str(data.get("binding", "") or "").strip(),
        "genre_promise": str(data.get("genre_promise", "") or "").strip(),
        "escalation_ladder": [
            str(x).strip() for x in (data.get("escalation_ladder") or []) if str(x).strip()
        ],
        "opponent": {},
        # 2026-10-28：全剧主线三件事（白名单式规范化，新字段必须在这里登记，否则被静默丢弃）
        "main_line": {},
    }
    ml = data.get("main_line")
    if isinstance(ml, dict):
        out["main_line"] = {k: str(ml.get(k, "") or "").strip() for k in ("want", "blocker", "edge")}
    opp = data.get("opponent")
    if isinstance(opp, dict) and str(opp.get("name", "")).strip():
        out["opponent"] = {
            "name": str(opp.get("name", "")).strip(),
            "goal": str(opp.get("goal", "")).strip(),
            "right_about": str(opp.get("right_about", "")).strip(),
            "escalation": [str(x).strip() for x in (opp.get("escalation") or []) if str(x).strip()],
        }
    for c in (data.get("characters") or []):
        if not isinstance(c, dict):
            continue
        name = str(c.get("name", "")).strip()
        if not name:
            continue
        out["characters"].append({
            "name": name,
            "role": str(c.get("role", "")).strip(),
            "arc": str(c.get("arc", "")).strip(),
            "ending_state": str(c.get("ending_state", "待定")).strip() or "待定",
            "appearance": str(c.get("appearance", "")).strip(),
            # D4: 伤口/需求/自欺的信念——人物弧光的发动机
            "wound": str(c.get("wound", "") or "").strip(),
            "need": str(c.get("need", "") or "").strip(),
            "lie": str(c.get("lie", "") or "").strip(),
            # 2026-11-04：人物小传的其余几段。原先只有弧光和外形，
            # 下游写每一集时看不见"这个人的身份、标签、经历、动机、跟谁是什么关系"，
            # 于是同一个人在 60 集里被写出好几套性格。
            "identity": str(c.get("identity", "") or "").strip(),
            "tags": [str(x).strip() for x in (c.get("tags") or []) if str(x).strip()],
            "traits": [str(x).strip() for x in (c.get("traits") or []) if str(x).strip()]
            if isinstance(c.get("traits"), list) else
            ([str(c["traits"]).strip()] if str(c.get("traits") or "").strip() else []),
            "backstory": str(c.get("backstory", "") or "").strip(),
            "motive": str(c.get("motive", "") or "").strip(),
            "relations": str(c.get("relations", "") or "").strip(),
        })
    if not out["forbidden"]:
        out["forbidden"] = ["死亡不可逆"]
    return out


async def generate_story_bible(
    user_input: str,
    *,
    provider: str = "gemini",
    draft_id: int | None = None,
) -> dict:
    """从题材/概要生成故事圣经。失败时返回最小可用骨架, 不阻断主流程。"""
    prompt = _BIBLE_PROMPT.format(user_input=(user_input or "").strip() or "(无)")
    if draft_id:
        try:
            from .log_helper import save_log
            await save_log(draft_id, "outline", "正在构建故事圣经(事实基线)...", "progress", 0)
        except Exception:
            pass
    try:
        llm = get_llm("generate", temperature=0.5, provider=provider)
        resp = await llm.ainvoke(prompt)
        text = getattr(resp, "content", "") or ""
        # 2026-11-06：模型输出改成分块文本（见 outline_format.parse_bible），
        # 解析回与旧 JSON 同型的 dict，`_normalize_bible` 一行未改。
        data = parse_bible(text)
        return _normalize_bible(data)
    except Exception as e:  # noqa: BLE001
        logger.warning("story_bible 生成失败(降级为空骨架): %s", e)
        return {
            "world": {"era": "", "setting": "", "rules": []},
            "characters": [],
            "core_mysteries": [],
            "forbidden": ["死亡不可逆"],
            "premise": "", "binding": "", "genre_promise": "",
            "escalation_ladder": [], "opponent": {},
        }


_BIBLE_FROM_OUTLINE_PROMPT = """你是资深剧本策划。下面是一部剧**已经写好的大纲**，请你从大纲的实际内容中**提炼**出它的"故事圣经"(事实基线)。

⚠️ 关键要求: 只从下面大纲的真实内容中提炼, 角色姓名、世界观、题材与大纲完全一致。

## 全剧标题
{title}

## 全剧主线
{synopsis}

## 已知角色(来自大纲)
{characters_block}

## 各集概要(逐集)
{episodes_block}

## 输出格式：分块文本（不要 JSON、不要解释）

【剧名】剧名（照大纲标题）

【一句话故事】
一句话故事（从大纲主线压缩成 30~60 字）

【题材定位】一句话，如"都市豪门 + 情感甜宠 + 重生复仇"

【受众】
性别：女频/男频/全年龄
年龄：主要年龄段
观看场景：在什么场景下看
此刻想被满足的情绪：他们此刻想被满足的情绪，写成一个能看到画面的句子

【卖点】
1. 核心卖点，观众一眼看懂的钩子（身份差、关系差、逆袭方式）
2. 同上
3. 同上
（3~5 条，每条一行，以"编号. "开头）

【核心悬念】
- 贯穿全剧的核心悬念（每条一行，2~5 条）

【主线三件事】
要什么：主角要得到或守住的具体的人、物、位置或结果
谁在挡：谁在挡主角、为什么挡（对手具体的利益或执念）
靠什么赢：主角身上别人没有的哪样本事、资源或信息差

【全剧前提】
一句话，写出人物立场 + 核心冲突 + 结局方向，是一个能被剧情证明的主张

【人物绑定】
主角与关键人物之间为什么不能轻易分开，以及每次绑定如何升级

【爽点承诺】本剧向观众承诺的爽点是什么，预计在哪几集兑付

【主要对手】
对手姓名：须在下面的角色里
目标：他/她要达成的目标
为什么站得住：对手的动机为什么成立（稳定的利益、欲望或信念）
手段升级路径：第1层 → 第2层 → 第3层（用 → 分隔）

【世界】
时代：时代/世界观
核心场景：
- 场景名——属于谁、代表什么权力关系（3~5 处）
行得通的规则：
- 这个世界里什么事行得通
不出现的元素：
- 不能出现的东西

【角色】姓名｜定位（主角/男主/反派/配角）
身份：对外身份 + 真实身份
标签：标签1、标签2
外观：50 字内的视觉形象
性格：外在表现；内在性格；两者如何反差
经历：一整段，什么经历造成了现在的行为方式
动机：核心动机 + 当前困境
关系：与主角或其他人的关系，以及这段关系在全剧里怎么演变
弧光：这个角色从头到尾的转变，一句话
结局：存活/死亡/离场/待定（用户或原作已确定的照填，其余填"待定"）
伤口：人物的缺口（只对重要角色填）
需要学会：他真正需要学会的东西（只对重要角色填）
自欺：他自欺的信念（只对重要角色填）

【升级阶梯】
1. 第1档：主角面临失去什么
2. 第2档：…
3. 第3档：…

【硬约束】
- 世界观硬约束（现实题材至少一条关于生死的）

## 填写要点
- 角色姓名、世界观、题材 100% 来自上面的大纲
- 小传里没写到的项（身份/经历/关系）宁可留空，也不要按题材套路编
- core_mysteries 取大纲里真实出现的悬念/未解问题
- 只输出 JSON 对象本身
"""


def _fmt_chars_for_bible(characters: list) -> str:
    if not characters:
        return "（大纲未显式列出角色, 请从各集概要中提取真实出现的角色）"
    lines = []
    for c in characters:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name", "")).strip()
        if not name:
            continue
        lines.append(f"- {name}（{c.get('role','')}）{c.get('appearance','')}")
    return "\n".join(lines) or "（无）"


def _fmt_eps_for_bible(episodes: list, limit: int = 40) -> str:
    lines = []
    for ep in (episodes or [])[:limit]:
        if not isinstance(ep, dict):
            continue
        lines.append(f"第{ep.get('order')}集《{ep.get('title','')}》: {ep.get('synopsis','')[:120]}")
    return "\n".join(lines) or "（无）"


async def generate_bible_from_outline(
    outline: dict,
    *,
    provider: str = "gemini",
) -> dict:
    """从**已有大纲的实际内容**提炼故事圣经(用于老数据/导入剧本补建)。

    与 generate_story_bible(基于用户题材输入) 不同: 这里严格基于大纲的
    title/synopsis/characters/chapters 提炼, 避免凭空编造与实际内容不符的设定。
    """
    episodes = outline.get("chapters") or outline.get("episodes") or []
    prompt = _BIBLE_FROM_OUTLINE_PROMPT.format(
        title=str(outline.get("title", "")).strip() or "(无)",
        synopsis=str(outline.get("synopsis", "")).strip() or "(无)",
        characters_block=_fmt_chars_for_bible(outline.get("characters") or []),
        episodes_block=_fmt_eps_for_bible(episodes),
    )
    try:
        llm = get_llm("generate", temperature=0.3, provider=provider)
        resp = await llm.ainvoke(prompt)
        text = getattr(resp, "content", "") or ""
        data = parse_bible(text)
        return _normalize_bible(data)
    except Exception as e:  # noqa: BLE001
        logger.warning("generate_bible_from_outline 失败(降级为空骨架): %s", e)
        # 降级: 至少用大纲已有的 world/characters, 不编造
        return {
            "world": outline.get("world") if isinstance(outline.get("world"), dict) else {"era": "", "setting": "", "rules": []},
            "characters": [
                {"name": c.get("name", ""), "role": c.get("role", ""), "arc": "", "ending_state": "待定", "appearance": c.get("appearance", "")}
                for c in (outline.get("characters") or []) if isinstance(c, dict) and c.get("name")
            ],
            "core_mysteries": [],
            "forbidden": ["死亡不可逆"],
            "premise": "", "binding": "", "genre_promise": "",
            "escalation_ladder": [], "opponent": {},
        }


def bible_text(bible: dict | None) -> str:
    """把 Bible 渲染成给大纲/剧本生成用的约束文本块。"""
    if not bible:
        return ""
    lines = ["【故事圣经(全剧不可漂移的事实基线,必须严格遵守)】"]
    # ---- 2026-11-04：立项信息（发行/投放侧）----
    # 这几行不只是给人看的：大纲每一批都要回答"这一集推进了什么、兑现了哪种爽点"，
    # 而"观众是什么样的、这部剧答应给什么"正是判断依据。原先这份信息完全不在
    # prompt 里，集纲只能按通用套路走。
    if bible.get("title"):
        lines.append(f"- 剧名: {bible['title']}")
    if bible.get("one_liner"):
        lines.append(f"- 一句话故事: {bible['one_liner']}")
    aud = bible.get("audience") or {}
    _AUD_LABEL = {"gender": "性别", "age": "年龄", "scene": "观看场景", "craving": "此刻想被满足的情绪"}
    aud_bits = [f"{_AUD_LABEL[k]} {aud[k]}" for k in ("gender", "age", "scene", "craving")
                if str(aud.get(k) or "").strip()]
    if aud_bits:
        lines.append("- 目标受众: " + "｜".join(aud_bits))
    if bible.get("selling_points"):
        # 编号渲染：大纲的 selling_point 字段要求**点名其中一条**，
        # 没有编号时模型会自己改写（实测第一轮 6 集全部改写成了新句子）。
        lines.append("- 核心卖点(每一集都至少兑现其中一项，编号供集纲的 selling_point 字段引用):")
        for i, sp in enumerate(bible["selling_points"], start=1):
            lines.append(f"    {i}. {sp}")
    if bible.get("tone"):
        lines.append(f"- 题材定位: {bible['tone']}")
    w = bible.get("world") or {}
    if w.get("era") or w.get("setting"):
        lines.append(f"- 世界观: {w.get('era','')} / {w.get('setting','')}")
    for r in (w.get("rules") or []):
        lines.append(f"  · 规则: {r}")
    for r in (w.get("rules_forbidden") or []):
        lines.append(f"  · 不出现: {r}")
    chars = bible.get("characters") or []
    if chars:
        lines.append("- 角色基线(姓名固定,结局状态不可违背):")
        for c in chars:
            head = f"  · {c.get('name','')}({c.get('role','')})"
            if c.get("identity"):
                head += f" 身份:{c['identity']}"
            if c.get("tags"):
                head += f" 标签:{'/'.join(c['tags'])}"
            lines.append(head)
            for label, key in (("外形", "appearance"), ("性格", "traits"), ("经历", "backstory"),
                               ("动机", "motive"), ("关系", "relations"), ("弧光", "arc")):
                v = c.get(key)
                if isinstance(v, list):
                    v = "、".join(str(x) for x in v if str(x).strip())
                if str(v or "").strip():
                    lines.append(f"    {label}: {v}")
            lines.append(f"    结局: {c.get('ending_state','待定')}")
    if bible.get("core_mysteries"):
        lines.append(f"- 核心悬念: {'; '.join(bible['core_mysteries'])}")
    # ---- D4 戏剧基线（老圣经无这些字段时整段不出现，输出与改前一致）----
    # 2026-10-28：全剧主线三件事。经 bible_block 进入**每一批**大纲 prompt —— 后续批
    # 此前只看得见前文脉络，中后段于是滑向与主线无关的套路战场。
    ml = bible.get("main_line") or {}
    if isinstance(ml, dict) and any(str(ml.get(k) or "").strip() for k in ("want", "blocker", "edge")):
        lines.append(f"- 全剧主线(每一集都往这里推): 主角要{ml.get('want','')}｜挡主角的是{ml.get('blocker','')}｜主角靠{ml.get('edge','')}赢")
    if bible.get("premise"):
        lines.append(f"- 全剧前提(每个重要情节都应服务它): {bible['premise']}")
    opp = bible.get("opponent") or {}
    if opp.get("name"):
        seg = f"- 主要对手: {opp['name']}"
        if opp.get("goal"):
            seg += f"｜目标: {opp['goal']}"
        if opp.get("right_about"):
            seg += f"｜动机为什么站得住: {opp['right_about']}"
        lines.append(seg)
        if opp.get("escalation"):
            lines.append(f"  · 手段升级路径: {' → '.join(opp['escalation'])}")
    if bible.get("binding"):
        lines.append(f"- 人物绑定(为什么不能轻易分开): {bible['binding']}")
    ladder = bible.get("escalation_ladder") or []
    if ladder:
        lines.append(f"- 全剧压迫升级阶梯: {' → '.join(ladder)}")
    if bible.get("genre_promise"):
        lines.append(f"- 向观众的爽点承诺: {bible['genre_promise']}")
    # 人物伤口/需求（只渲染填了的）
    wounded = [c for c in chars if (c.get("wound") or c.get("need") or c.get("lie"))]
    if wounded:
        lines.append("- 人物内在驱动(伤口/需求/自欺的信念):")
        for c in wounded:
            bits = []
            if c.get("wound"):
                bits.append(f"伤口: {c['wound']}")
            if c.get("need"):
                bits.append(f"需要学会: {c['need']}")
            if c.get("lie"):
                bits.append(f"自欺: {c['lie']}")
            lines.append(f"  · {c.get('name','')}｜" + "｜".join(bits))
    if bible.get("forbidden"):
        lines.append(f"- 世界观硬约束: {'; '.join(bible['forbidden'])}")
    return "\n".join(lines)