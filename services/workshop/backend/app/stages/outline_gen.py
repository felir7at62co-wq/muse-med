"""大纲生成（结构化 JSON 输出）。

P3 重构(见 PLAN-大纲与剧本生成-诊断与重构 §3.3):
  从"一次性出 N 集"改为"按批循环"(每批 10 集), 每批输入:
    - Story Bible(事实基线)
    - 账本快照(截至上一批: 谁死/在场/悬念/用过元素)
    - 已生成各集的一句话脉络
  每批产出后增量更新账本; 全部完成后跑一致性校验(只标注)。
  长序列失忆被物理切断。

对外主入口:
  - generate_outline(...)         : 兼容旧签名(单次), 内部走分批管线
  - generate_outline_pipeline(...): 完整管线(Bible + 分批 + 账本 + lint)
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from ..prompt.loader import load_active_template
from ..models.llm import get_llm
from .story_bible import generate_story_bible, bible_text
from .state_ledger import update_ledger_for_batch, snapshot_text, empty_ledger
from .consistency_lint import lint_outline
from . import drama_principles
from . import outline_format
from .outline_format import parse_outline


def _with_principles(prompt: str) -> str:
    """D2: 把集纲结构原则拼到 prompt 前面。

    必须在 .format 之后拼接：原则块内含字面 JSON 花括号，参与 format 会被吃掉。
    """
    return drama_principles.outline_block() + "\n\n" + prompt


def _with_mainline(prompt: str, synopsis: str) -> str:
    """后续批注入全剧主线（首批产出的 synopsis）。

    2026-10-28：后续批 prompt 只有"已生成剧集脉络"，看不到全剧主线 —— 每批只能顺着
    上一批往下续，中后段于是滑向模型最熟悉的套路战场（商战/律师/证据/打脸），
    与本剧主线渐行渐远。首批 synopsis 已按"主线三件事"写出，这里原样带给每一批。
    空串时不注入。
    """
    s = (synopsis or "").strip()
    if not s:
        return prompt
    return ("## 全剧主线（本批每一集的核心推进点都要回答：主线三件事里哪一件往前走了一步）\n"
            + s + "\n\n" + prompt)


def _with_plan_scope(prompt: str, user_input: str, start: int, end: int) -> str:
    """D3: 把"本批只能取材于用户规划的对应区间"拼到 prompt 最前面。

    2026-10-10 定位的事故：用户给了完整分集规划（第 1-5 集【入局与积怨】／
    第 6-15 集【充大方与道德绑架】），生成的大纲却把第 6-15 集的爆点演进了第 1 集，
    再倒回去补过程。机制是「用户的分集区间在代码里从未被解析过，只当散文背景读」，
    叠加原则块里"第 1 集必须让观众明确最大异常/危机""禁止慢热铺垫"在反向推。

    ⚠️ 三条不能破的约束：

      1. **必须在 .format 之后拼接** —— 用户标签里出现一个 `{` 就会让 format 崩溃；
      2. **没有规划就一个字都不注入**（`render_plan_block` 返回空串）——
         绝大多数历史草稿走的是散文式概要，行为与改前**逐字节一致**；
      3. 放在**最前面**（在原则块之前），因为本块的效力需要压过原则块里的
         "危机前置/尽快抓人"那几条，写在后面会被读者当成补充说明。

    与 `_with_principles` 同样只做拼接，不改骨架模板 —— DB 里已有的
    outline 模板（若有）无需改库即可吃到本约束。
    """
    from .user_plan import parse_episode_plan, render_plan_block

    try:
        block = render_plan_block(parse_episode_plan(user_input), start=start, end=end)
    except Exception as e:  # noqa: BLE001 —— 解析失败绝不能阻断大纲生成
        logger.warning("分集规划解析失败(不注入边界): %s", e)
        return prompt
    if not block:
        return prompt
    return block + "\n\n" + prompt

_PROVIDER_LABEL = {"gemini": "跨世界观模型", "deepseek": "通用模型", "gpt5": "逻辑专项模型"}

logger = logging.getLogger("outline_gen")

BATCH_SIZE = 10  # 已定决策5: 大纲分批粒度每批 10 集


# D1: 契约字段的规范空值——补位/降级时用它，保证每集结构一致（门禁才能统一判缺失）
_CONTRACT_KEYS = (
    "core_push", "stakes", "escalation", "audience_knows_delta",
)
_HOOK_KEYS = ("responds_to", "mode", "type", "strength", "leads_to")

#: 情绪强度（2026-09-19 新增）。
#:
#: 来源：918 文件里那套网文方法论反复把"情绪"当成**可设计、可计数**的对象 ——
#: "情绪强度 1-10""峰值维持 ≥2 节""每 3000-5000 字一个情绪节点"。
#: 我们此前只有定性的"情绪曲线"说法，**没有任何可统计的量**，
#: 于是"这段太平了"这种判断无法被检查、也无法被发现退化。
#:
#: ⚠️ **它的分档阈值不能照抄网文的字数密度**（那是番茄/起点的节奏，
#: 短剧单集 500-700 字，直接套会得出"每集要有三次爽点"这种荒谬结论）。
#: 这里只落**强度值本身**（1-10），"多密才算够"留给后续按真实成片校准。
_INTENSITY_MIN, _INTENSITY_MAX = 1, 10

#: 权力关系（2026-09-19 新增）。
#:
#: 来源：918 文件的「写前大纲」把"权力关系（最重要的步骤）"列为动笔前必做 ——
#: 主动方/被动方决定**台词给谁说什么**（同一句话由进攻方说还是防守方说，
#: 效果完全不同）。我们此前没有这一维，改稿时也就没有依据判断"这句该谁说的"。
#:
#: 只取两方 + 一句焦点：不做人物关系图，那会变成另一个没人维护的字段。
_POWER_KEYS = ("aggressor", "defender", "focus")


def empty_episode(order: int, *, placeholder: bool = True) -> dict:
    """一集的规范骨架。

    2026-11-07 改版：只剩 `order` / `title` / `synopsis` 三个键 —— 大纲正文
    就是唯一事实，模型写到的、用户看到的、下游读的是同一份（详见 `_norm_chapters`）。
    旧调用方若仍写 `ep["beats"] = ...` 之类，读侧一律 `.get()` 取空，不会炸。
    """
    return {
        "order": order,
        "title": f"第{order}集",
        "synopsis": "(待生成,请使用'重新生成此集'补全)" if placeholder else "",
    }


def _norm_beats(raw) -> list[dict]:
    """规范化本集场景节拍。

    ## 为什么这里**必须**规范而不是原样透传

    `beats` 是集纲里唯一"由模型自由发挥成数组"的字段，形状最不稳：
    实测同类字段（如 `char_knows_delta`、`value_shift`）在集纲里会从 dict 飘成
    list、从 list 飘成字符串。而下游 `build_beats_block` 要按 `at/who/action/turn`
    逐键取 —— 形状一旦飘，渲染出的却是一串 `['a','b']` 这种给模型看的噪声，
    **而且不会报错**（静默降级，正是本仓反复踩的坑）。

    所以三种形状都收：
      · 字符串  → 当成"只有 action"的一条（模型只写了动作时很常见）
      · dict    → 按四个键取，允许 `where/location`、`characters`、`what/beat`、
                  `result/shift` 等同义键（模型不总用我们给的名字）
      · 其它    → 丢弃

    一条四样全空的 beat 直接丢掉：留着只会变成 prompt 里的空行。
    """
    out: list[dict] = []
    for b in (raw if isinstance(raw, list) else []):
        if isinstance(b, str):
            s = b.strip()
            if s:
                out.append({"at": "", "who": "", "action": s, "turn": ""})
            continue
        if not isinstance(b, dict):
            continue
        rec = {
            "at": str(b.get("at") or b.get("where") or b.get("location") or "").strip(),
            "who": str(b.get("who") or b.get("characters") or "").strip(),
            "action": str(b.get("action") or b.get("what") or b.get("beat") or "").strip(),
            "turn": str(b.get("turn") or b.get("result") or b.get("shift") or "").strip(),
        }
        if any(rec.values()):
            out.append(rec)
    return out


async def _load_prompt_or_fallback(stage: str, fallback: str) -> str:
    """DB优先加载prompt模板,fallback到代码默认值"""
    try:
        tpl = await load_active_template(stage)
        return tpl if tpl else fallback
    except Exception:
        return fallback


# 集纲字段写法 —— 首批与后续批**共用**这一份。
#
# 2026-10-28：原先首批、后续批各写一份，后续批里还写着"写法与首批 prompt 的「下集钩子」
# 一节完全相同""见首批 prompt 的说明" —— 而生成后续批时模型根本看不到首批 prompt。
# 两份还互相矛盾：首批要求 escalation "比上一集更难、不能同级"，后续批写"允许停顿、
# 局部降温"。现合并为一份（取后者的口径），两批都嵌入。
# ⚠️ 本常量随骨架一起 str.format，不得含花括号。
_FIELD_RULES = """
## 每集怎么写成要素块（本批每一集都按此写）

一集正文就是这几个要素，按顺序写。**要素就是大纲本身**——用户在界面上读它，
下游写剧本也照着它写，不存在"另有一份更细的东西"。

【开场卡点】这一集开场时，谁被卡在什么处境上。第 2 集起必须接住上一集结尾的悬置；
 第 1 集写"开场就是强事件"，不要铺垫。
【冲突】谁要什么、谁挡着，两人争的具体是哪一件事。写具体的事（她要拿到那份签字），
 不写抽象的"矛盾"。对手要真的出手，否则主角的反击没有对手，这一集就是自说自话。
【期待点】观众看到这里最想看到的那一下，以及它落在哪。
【互动】本集最主要的一来一回：谁先出手、对方怎么接、局面怎么变。可以写几段。
【转折】本集哪个时刻局面变了，从什么变成什么。转折要与前几集的转变各不相同。
【爽点】本集最值回票价的那一下，写成能被拍出来的画面或台词（"她当众甩出DNA报告，全场安静"）。
 不是这一集的摘要，是观众看完会记住的那个瞬间；每集都要有。
【结尾钩子】这一集最后落在哪句话或哪个动作上，观众为什么非点下一集。
 写收尾那一刻具体发生的事，并且它就是下一集的核心事件（"她推开门，看见林母正把那沓病历塞进碎纸机"）。
 下一集在别的批次时也一样，要让下一批能直接照着开场。钩子只写收尾那一刻。

### 取舍与忌讳
- 【结尾钩子】每集必填。其余要素**按需取舍**：这一集没有独立的转折，就不写【转折】，
  不要为了凑要素硬写一段。写少而准，好过写全而空。
- 各要素之间要因果相连：因为【冲突】里的那件事，所以【转折】成立，所以【结尾钩子】逼出下一集。
- 写能被拍出来的东西：谁做了什么、说了哪句话。"她意识到事情不对"是结论，不是内容。
- 只写这一集的剧情。不写分析、不写复盘、不解释为什么这么安排。
- 不要再加别的标签（尤其不要写"地点""时间""在场人物"这类）。地点与人物由剧本阶段按场次决定，
  一集本就会横跨多个场景，在大纲里定死只会自相矛盾。
- 一集三四百字是正常量；不要为了短而省掉冲突与转折，也不要为了长而复述。

### 全剧层面要守住的
- 主线主要承诺在结局前都要有交代；可以留符合题材的余味。
- 前面埋下、观众记住了的东西，到合适的时机要兑现；不要埋了就忘。
- 连续几集不要用同一种套路收尾，每集都换一种打法。
"""

# 首批(第一批)大纲 prompt: 含全剧标题/世界观/人物, 以及第一批集
_OUTLINE_FIRST_PROMPT = """你是一名资深短剧编剧总策划。用户给出题材和概要，请产出**结构化大纲的第一批**（共 {total} 集，本批生成第 {start}~{end} 集）。

## 用户要求
{user_input}

{bible_block}

## 输出格式：分块文本（不要 JSON、不要解释）

### 剧名、主线、世界与角色（只在第一批给）

{head_spec}

### 每一集一块

{ep_spec}

""" + _FIELD_RULES + """
## 必须满足
- 角色覆盖全剧重要人物（>=3 个），与故事圣经一致
- 本批集号从 {start} 连续到 {end}，不跳号
- 每集都推动主线、与前后衔接；严格遵守故事圣经的角色结局与世界观
- 只输出上面这些分块，不要开场白、不要总结
"""

# 后续批 prompt: 只出本批集, 带账本快照约束
_OUTLINE_NEXT_PROMPT = """你是一名资深短剧编剧总策划。你正在续写一部短剧的大纲（全剧共 {total} 集），现在生成第 {start}~{end} 集。

## 用户要求
{user_input}

{bible_block}

{ledger_block}

## 已生成剧集脉络（供衔接，勿重复）
{recap_block}

## 输出格式：分块文本（不要 JSON、不要解释）

### 每一集一块

{ep_spec}

""" + _FIELD_RULES + """
## 必须满足（硬约束）
- 本批集号从 {start} 连续到 {end}，不跳号
- 钩子链连续：上一集【结尾钩子】里那件正在发生的事，就是本批第一集【开场卡点】的起点
- 账本状态照实延续：已死亡的角色只在闪回或回忆里出现（在正文中注明）；已揭穿的秘密按已知处理；
  已解决的悬念按已解决处理
- "已用过的重大元素"里的反转和桥段，本批换成新的
- 严格遵守故事圣经的角色结局与世界观
- 只输出上面这些分块，不要开场白、不要总结
"""


def _parse_batch(text: str, start: int) -> dict:
    """模型返回 → 中间 dict（与旧 JSON 结构同型）。

    2026-11-06：模型输出改成分块文本（见 `outline_format`），这里解析回原来的
    `{"title","synopsis","world","characters","chapters"}`。
    `parse_outline` 内部对 JSON 输出也有回退，所以未迁移的模板不会炸。
    """
    if not (text or "").strip():
        return {}
    try:
        return parse_outline(text, start=start)
    except Exception as e:  # noqa: BLE001
        logger.warning("大纲文本解析失败，退回 JSON 解析: %s", e)
        try:
            return _extract_json(text)
        except Exception:  # noqa: BLE001
            logger.warning("大纲 JSON 回退也失败，本批按空处理")
            return {}


def _extract_json(text: str) -> dict:
    """从模型输出里抠出 JSON **对象**。

    ⚠️ 必须保证返回 dict：调用方一律当 dict 用（`data.get("chapters")`）。
    模型完全可能回一个**裸 JSON 数组**（比如直接把 chapters 列表甩出来、
    或者把 `{"chapters": [...]}` 写成 `[...]`）—— `json.loads` 对数组同样成功，
    于是这个函数会"成功地"把一个 list 交出去，调用方在下一行才炸：
    `'list' object has no attribute 'get'`。

    2026-10-09 实测事故：作业 #87（草稿 694 生成大纲）就是这么死的，
    进度停在 40%（正好是展开阶段第一批）；错误信息里没有任何上下文，
    从栈上完全看不出是大纲模型回了个数组。

    数组是能救的：里面若都是"看着像一集"的对象，包进 {"chapters": [...]}；
    否则按失败处理（返回 {} 交给调用方的兜底），**不要**把畸形数据当成功。
    """
    if not text:
        raise ValueError("empty LLM response")
    raw = text.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        parsed = json.loads(raw)
    except Exception:
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if not match:
            # 没有花括号，但可能有方括号 —— 数组形态要救，不能直接抛。
            arr = re.search(r"\[.*\]", raw, re.DOTALL)
            if not arr:
                raise
            parsed = json.loads(arr.group(0))
    if isinstance(parsed, list):
        # 纯数组：看元素是不是"集"。是就当成 chapters，否则算解析失败。
        if parsed and all(isinstance(x, dict) and ("synopsis" in x or "title" in x)
                          for x in parsed):
            logger.warning("大纲模型返回裸数组(%d 个元素)，按 chapters 收下", len(parsed))
            return {"chapters": parsed}
        logger.warning("大纲模型返回裸数组但元素不像集，按失败处理: %r", str(parsed)[:200])
        return {}
    if not isinstance(parsed, dict):
        logger.warning("大纲模型返回了 %s，按失败处理: %r",
                       type(parsed).__name__, str(parsed)[:200])
        return {}
    return parsed


def _norm_chapters(raw_chs: list, start: int) -> list[dict]:
    """规范化一批 chapters, order 从 start 起连续。

    ## 2026-11-07 改版：一集只留 `order` / `title` / `synopsis`

    此前每集有 20 多个槽位（契约 15 字段 + beats 四段式 + 各类标签），模型在格子里
    写内容，用户在界面上只看得到 `synopsis`，而下游生成读的是那些格子 ——
    **用户看到的大纲和模型读到的大纲是两份东西**。用户改梗概、beats 没跟着改时，
    平台还会打 `_beats_stale` 让节拍整块失效，等于用户改的那句根本没进模型。

    现在大纲正文就是唯一事实：要素块（【开场卡点】【冲突】…【结尾钩子】）按顺序
    拼成 `synopsis`，用户读的就是模型读的。地点/时间/人物不在大纲里定死，
    由剧本按场次决定 —— 一集本就横跨多个场景。

    老数据里那些契约字段仍在库里、仍能被 `episode_render` 读到（它对缺失一律
    返回空串），但**新生成不再产出它们**，下游也不再依赖它们。
    """
    out = []
    for idx, ch in enumerate(raw_chs or []):
        if not isinstance(ch, dict):
            continue
        out.append({
            "order": start + len(out),
            "title": str(ch.get("title", f"第{start+len(out)}集")).strip(),
            "synopsis": str(ch.get("synopsis", "") or "").strip(),
        })
    return out


def _coerce_intensity(v) -> int:
    """情绪强度归一：只接受 1-10 的整数（字符串数字也认）；其余一律 0。

    `0` 是**未标注**的哨兵，不是"强度为零"。这样：
      · 老项目的契约里没有这个字段 → 0，门禁不会误报它"强度太低"；
      · 模型写了 "8 分" / "强烈" / 越界的 15 → 0，同样不误报。
    """
    try:
        n = int(float(str(v).strip()))
    except (TypeError, ValueError):
        return 0
    return n if _INTENSITY_MIN <= n <= _INTENSITY_MAX else 0


def emotion_density(episodes: list[dict]) -> dict:
    """按已标注的集算"情绪节点密度"（**只统计，不做判定**）。

    返回 `{"labeled": n, "unlabeled": n, "peak": [集号...], "avg": float}`。

    ⚠️ **故意不产出"密度太低"这类结论**。网文那套"每 3000-5000 字一个爽点"
    的分档不能直接搬到短剧（单集 500-700 字，搬过来等于要求每集三个爽点）。
    先把数字算出来、让它在看板上可见；阈值等一部真实作品跑完再校准 ——
    在那之前给出任何"该多密"的建议都是拍脑袋。
    """
    labeled = [(e.get("order"), e.get("emotion_intensity") or 0) for e in (episodes or [])]
    vals = [(o, v) for o, v in labeled if v]
    if not vals:
        return {"labeled": 0, "unlabeled": len(labeled), "peak": [], "avg": 0.0}
    peak_at = max(v for _, v in vals)
    return {
        "labeled": len(vals),
        "unlabeled": len(labeled) - len(vals),
        "peak": [o for o, v in vals if v == peak_at],
        "avg": round(sum(v for _, v in vals) / len(vals), 1),
    }


def _recap_block(episodes: list[dict], last_n: int | None = None) -> str:
    """已生成集的脉络。

    默认(last_n=None)返回**全部已生成集的完整概要**, 让后续批次拥有全局前情视野,
    从根本上减少"后批与前批矛盾"的失忆问题(大纲纯文本, token 量级安全)。
    传入 last_n 时只取最近 N 集(兼容旧调用)。

    🔴 2026-10-09：一并带上**场景节拍**。

    只给后批看 synopsis 是不够的 —— 后批要接的是"上一批演到哪一拍"，
    而 synopsis 是那一批的**摘要**，节拍才是实际行进的位置。不带节拍时，
    后批容易出现两种毛病：把上一批已经演完的拍子再演一遍，或者接不上
    上一批留下的那一拍（"他推开门"之后发生了什么，只有节拍写清楚了）。

    ⚠️ 成本：用户已裁定"1~2 万字的成本差异都很少"，故不设条数/字数上限 ——
    与 beats 本身的取舍一致（上限会逼模型把该分两拍的事压成一拍）。
    """
    if not episodes:
        return "（无）"
    picked = episodes if last_n is None else episodes[-last_n:]
    lines = []
    for e in picked:
        must = "、".join(e.get("must_have") or [])
        line = f"第{e['order']}集《{e.get('title','')}》: {e.get('synopsis','')}"
        if must:
            line += f"\n  关键事件: {must}"
        beats = e.get("beats")
        if isinstance(beats, list) and beats:
            bl = []
            for i, b in enumerate(beats, start=1):
                if isinstance(b, dict):
                    at = str(b.get("at") or "").strip()
                    act = str(b.get("action") or "").strip()
                    turn = str(b.get("turn") or "").strip()
                    seg = f"    {i}) " + (f"[{at}] " if at else "") + act
                    if turn:
                        seg += f" → {turn}"
                    if seg.strip() and (act or turn):
                        bl.append(seg)
                elif isinstance(b, str) and b.strip():
                    bl.append(f"    {i}) {b.strip()}")
            if bl:
                line += "\n  已演的拍子:\n" + "\n".join(bl)
        lines.append(line)
    return "\n".join(lines)


async def generate_outline_pipeline(
    user_input: str,
    *,
    chapter_count: int = 24,
    chapter_word_target: int = DEFAULT_CHAPTER_WORD_TARGET,
    provider: str = "gemini",
    draft_id: int | None = None,
    run_lint: bool = True,
) -> dict:
    """完整大纲管线: Bible → 分批生成 → 每批更新账本 → 一致性校验。

    返回 outline dict, 额外携带:
      - story_bible: 事实基线
      - state_ledger: 状态账本
      - lint_report: 一致性校验报告(只标注)
    """
    async def _log(msg: str, log_type: str = "progress"):
        if not draft_id:
            return
        try:
            from .log_helper import save_log
            await save_log(draft_id, "outline", msg, log_type, 0)
        except Exception:
            pass

    await _log(f"使用模型: {_PROVIDER_LABEL.get(provider, provider)}", "log")

    # 1) 故事圣经
    bible = await generate_story_bible(user_input, provider=provider, draft_id=draft_id)
    b_text = bible_text(bible)

    # 2) 分批生成
    outline: dict = {
        "title": "",
        "synopsis": "",
        "world": bible.get("world") or {},
        "characters": [],
        "chapters": [],
    }
    ledger = empty_ledger()
    first_batch_prompt = await _load_prompt_or_fallback("outline_generate_first", _OUTLINE_FIRST_PROMPT)
    next_batch_prompt = await _load_prompt_or_fallback("outline_generate_next", _OUTLINE_NEXT_PROMPT)

    start = 1
    while start <= chapter_count:
        end = min(start + BATCH_SIZE - 1, chapter_count)
        await _log(f"正在生成大纲第 {start}~{end} 集（共 {chapter_count} 集）...")

        if start == 1:
            prompt = first_batch_prompt.format(
                user_input=(user_input or "").strip() or "(无)",
                total=chapter_count, start=start, end=end,
                bible_block=b_text,
                head_spec=outline_format.HEAD_SPEC, ep_spec=outline_format.EP_SPEC,
            )
        else:
            prompt = next_batch_prompt.format(
                user_input=(user_input or "").strip() or "(无)",
                total=chapter_count, start=start, end=end,
                bible_block=b_text,
                ledger_block=snapshot_text(ledger, start - 1),
                recap_block=_recap_block(outline["chapters"]),
                head_spec=outline_format.HEAD_SPEC, ep_spec=outline_format.EP_SPEC,
            )
        # D2: 注入集纲结构原则（先 format 骨架、再拼接——原则块内含字面 JSON 花括号，
        # 不能参与 format 渲染）。让"留存优先/事件密度/失败代价/明暗线/结尾卡点"
        # 在集纲生成阶段就成为约束，而不是等分镜阶段才提。
        if start > 1:
            prompt = _with_mainline(prompt, outline.get("synopsis", ""))
        prompt = _with_principles(prompt)
        # D3: 用户分集规划的取数边界，压在原则块**之前**（见 _with_plan_scope 文档）。
        # 没有规划时不注入任何内容，prompt 与改前逐字节一致。
        prompt = _with_plan_scope(prompt, user_input, start, end)

        llm = get_llm("generate", temperature=0.7, provider=provider)
        try:
            resp = await llm.ainvoke(prompt)
            data = _parse_batch(getattr(resp, "content", "") or "", start)
        except Exception as e:  # noqa: BLE001
            logger.warning("大纲批次 %d~%d 生成失败: %s", start, end, e)
            data = {}

        # 首批填充全剧级字段
        if start == 1:
            outline["title"] = str(data.get("title", "")).strip()
            outline["synopsis"] = str(data.get("synopsis", "")).strip()
            if isinstance(data.get("world"), dict):
                outline["world"] = data["world"]
            for c in (data.get("characters") or []):
                if isinstance(c, dict) and str(c.get("name", "")).strip():
                    outline["characters"].append({
                        "name": str(c.get("name", "")).strip(),
                        "role": str(c.get("role", "")).strip(),
                        "traits": list(c.get("traits") or []),
                        "appearance": str(c.get("appearance", "")).strip(),
                        # 2026-11-04：把故事圣经里的小传一并带到大纲的人物表。
                        # 只带 name/role/appearance 时，下游（正文、剧本、重写）
                        # 看到的人物卡是空壳，每集都要重新"猜"这个人是什么人。
                        "identity": str(c.get("identity", "") or "").strip(),
                        "tags": [str(x).strip() for x in (c.get("tags") or []) if str(x).strip()],
                        "backstory": str(c.get("backstory", "") or "").strip(),
                        "motive": str(c.get("motive", "") or "").strip(),
                        "relations": str(c.get("relations", "") or "").strip(),
                    })
            # 若首批没给出人物, 用 Bible 的
            if not outline["characters"] and bible.get("characters"):
                for c in bible["characters"]:
                    outline["characters"].append({
                        "name": c.get("name", ""), "role": c.get("role", ""),
                        "traits": list(c.get("traits") or []), "appearance": c.get("appearance", ""),
                        "identity": c.get("identity", ""), "tags": list(c.get("tags") or []),
                        "backstory": c.get("backstory", ""), "motive": c.get("motive", ""),
                        "relations": c.get("relations", ""),
                    })

        batch_chs = _norm_chapters(data.get("chapters") or [], start)
        # 补齐本批缺失
        while len(batch_chs) < (end - start + 1):
            idx = start + len(batch_chs)
            batch_chs.append(empty_episode(idx))
        batch_chs = batch_chs[: end - start + 1]
        outline["chapters"].extend(batch_chs)

        # 3) 每批更新账本
        seed = bible.get("core_mysteries") if start == 1 else None
        try:
            ledger = await update_ledger_for_batch(
                ledger, batch_chs, open_threads_seed=seed, provider=provider
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("账本更新失败(批 %d~%d): %s", start, end, e)

        # 2026-11-07：每批落库（与 expand_outline_from_preview 同款，见那里的说明）。
        # 这条路是一段式生成（不走预览），原先同样只在全部批次跑完后写一次。
        outline["story_bible"] = bible
        outline["state_ledger"] = ledger
        await _persist_outline_progress(draft_id, outline,
                                        done=len(outline["chapters"]),
                                        total=chapter_count)
        start = end + 1

    outline["story_bible"] = bible
    outline["state_ledger"] = ledger

    # 4) 一致性校验(只标注)
    if run_lint:
        await _log("正在做一致性校验(硬伤检测)...")
        try:
            outline["lint_report"] = await lint_outline(outline, use_llm=True, provider=provider)
            s = outline["lint_report"]["summary"]
            await _log(f"校验完成: {s['error']} 个错误, {s['warn']} 个警告", "log")
        except Exception as e:  # noqa: BLE001
            logger.warning("lint 失败: %s", e)
            outline["lint_report"] = {"issues": [], "summary": {"error": 0, "warn": 0}}
        # D1: 剧情结构门禁(零 LLM, 仅标注不阻断)
        try:
            from .drama_gate import check_outline as _gate
            outline["drama_report"] = _gate(outline, bible=outline.get("story_bible"))
        except Exception as _e:
            logger.warning("drama_gate 失败: %s", _e)

    return outline


async def generate_outline(
    user_input: str,
    *,
    chapter_count: int = 24,
    chapter_word_target: int = DEFAULT_CHAPTER_WORD_TARGET,
    provider: str = "gemini",
    draft_id: int | None = None,
) -> dict:
    """兼容旧签名的大纲生成入口。内部走 P3 分批管线。"""
    return await generate_outline_pipeline(
        user_input,
        chapter_count=chapter_count,
        chapter_word_target=chapter_word_target,
        provider=provider,
        draft_id=draft_id,
        run_lint=True,
    )


# ===========================================================================
# 两段式大纲: 先出「故事圣经 + 前 N 集」供人工确认, 确认(可编辑)后再展开全集
#
# 动机: 一次性跑满 60 集才发现方向不对 = 白烧 6 批 LLM + 6 次账本。拆成:
#   generate_outline_preview()     —— 只到 bible + 前 N 集, 不跑 lint(省一次 LLM)
#   expand_outline_from_preview()  —— 从(可能已被用户改过的)预览续跑到全集 + lint
#
# ⚠ 原 generate_outline_pipeline 保持原样不动, 所有旧调用方零影响。
# 两个新函数与它共用同一套 prompt / 账本 / recap 逻辑, 行为对齐。
# ===========================================================================

# 预览阶段默认集数(够看出方向对不对, 又不至于烧太多)
PREVIEW_EPISODES = 3


def _fill_outline_head(outline: dict, data: dict, bible: dict) -> None:
    """把首批返回里的全剧级字段(标题/主线/世界观/人物)写进 outline。

    与 generate_outline_pipeline 首批逻辑保持一致, 含"首批没给人物则回落 Bible"。
    """
    outline["title"] = str(data.get("title", "")).strip()
    outline["synopsis"] = str(data.get("synopsis", "")).strip()
    if isinstance(data.get("world"), dict):
        outline["world"] = data["world"]
    for c in (data.get("characters") or []):
        if isinstance(c, dict) and str(c.get("name", "")).strip():
            outline["characters"].append({
                "name": str(c.get("name", "")).strip(),
                "role": str(c.get("role", "")).strip(),
                "traits": list(c.get("traits") or []),
                "appearance": str(c.get("appearance", "")).strip(),
                "identity": str(c.get("identity", "") or "").strip(),
                "tags": [str(x).strip() for x in (c.get("tags") or []) if str(x).strip()],
                "backstory": str(c.get("backstory", "") or "").strip(),
                "motive": str(c.get("motive", "") or "").strip(),
                "relations": str(c.get("relations", "") or "").strip(),
            })
    if not outline["characters"] and bible.get("characters"):
        for c in bible["characters"]:
            outline["characters"].append({
                "name": c.get("name", ""), "role": c.get("role", ""),
                "traits": list(c.get("traits") or []), "appearance": c.get("appearance", ""),
                "identity": c.get("identity", ""), "tags": list(c.get("tags") or []),
                "backstory": c.get("backstory", ""), "motive": c.get("motive", ""),
                "relations": c.get("relations", ""),
            })


async def _gen_batch(
    *,
    user_input: str,
    bible_block: str,
    ledger_block: str,
    recap_block: str,
    start: int,
    end: int,
    total: int,
    provider: str,
    prompt_tpl: str,
    is_first: bool,
    mainline: str = "",
) -> dict:
    """跑一批大纲, 返回 LLM 解析后的原始 dict(失败返回 {})。"""
    if is_first:
        prompt = prompt_tpl.format(
            user_input=(user_input or "").strip() or "(无)",
            total=total, start=start, end=end, bible_block=bible_block,
            head_spec=outline_format.HEAD_SPEC, ep_spec=outline_format.EP_SPEC,
        )
    else:
        prompt = prompt_tpl.format(
            user_input=(user_input or "").strip() or "(无)",
            total=total, start=start, end=end, bible_block=bible_block,
            ledger_block=ledger_block, recap_block=recap_block,
            head_spec=outline_format.HEAD_SPEC, ep_spec=outline_format.EP_SPEC,
        )
    if not is_first:
        prompt = _with_mainline(prompt, mainline)
    prompt = _with_principles(prompt)  # D2: 注入集纲结构原则
    # D3: 用户分集规划的取数边界，压在原则块之前（预览/展开两条路径都经过这里）。
    prompt = _with_plan_scope(prompt, user_input, start, end)
    llm = get_llm("generate", temperature=0.7, provider=provider)
    try:
        resp = await llm.ainvoke(prompt)
        return _parse_batch(getattr(resp, "content", "") or "", start)
    except Exception as e:  # noqa: BLE001
        logger.warning("大纲批次 %d~%d 生成失败: %s", start, end, e)
        return {}


def _pad_batch(batch_chs: list[dict], start: int, end: int) -> list[dict]:
    """补齐本批缺失集并截断到本批长度(与主管线一致)。"""
    while len(batch_chs) < (end - start + 1):
        idx = start + len(batch_chs)
        batch_chs.append(empty_episode(idx))
    return batch_chs[: end - start + 1]


async def generate_outline_preview(
    user_input: str,
    *,
    chapter_count: int = 24,
    preview_episodes: int = PREVIEW_EPISODES,
    provider: str = "gemini",
    draft_id: int | None = None,
) -> dict:
    """两段式第一段: 只产出「故事圣经 + 全剧级设定 + 前 N 集」。

    返回的 outline 里带 `_preview` 元信息, 供 expand_outline_from_preview 续跑:
      {"stage": "preview", "generated": N, "target": chapter_count, "user_input": ...}
    不跑 lint —— 前 N 集不足以做全剧一致性校验, 留到展开后再跑。
    """
    async def _log(msg: str, log_type: str = "progress"):
        if not draft_id:
            return
        try:
            from .log_helper import save_log
            await save_log(draft_id, "outline", msg, log_type, 0)
        except Exception:
            pass

    n = max(1, min(int(preview_episodes or PREVIEW_EPISODES), int(chapter_count)))
    await _log(f"使用模型: {_PROVIDER_LABEL.get(provider, provider)}", "log")
    await _log(f"正在生成故事圣经与前 {n} 集预览（全剧共 {chapter_count} 集）...")

    bible = await generate_story_bible(user_input, provider=provider, draft_id=draft_id)
    b_text = bible_text(bible)

    outline: dict = {
        "title": "", "synopsis": "",
        "world": bible.get("world") or {},
        "characters": [], "chapters": [],
    }
    first_tpl = await _load_prompt_or_fallback("outline_generate_first", _OUTLINE_FIRST_PROMPT)
    data = await _gen_batch(
        user_input=user_input, bible_block=b_text, ledger_block="", recap_block="",
        start=1, end=n, total=chapter_count, provider=provider,
        prompt_tpl=first_tpl, is_first=True,
    )
    _fill_outline_head(outline, data, bible)
    outline["chapters"] = _pad_batch(_norm_chapters(data.get("chapters") or [], 1), 1, n)

    ledger = empty_ledger()
    try:
        ledger = await update_ledger_for_batch(
            ledger, outline["chapters"],
            open_threads_seed=bible.get("core_mysteries"), provider=provider,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("预览账本更新失败: %s", e)

    outline["story_bible"] = bible
    outline["state_ledger"] = ledger
    outline["lint_report"] = {"issues": [], "summary": {"error": 0, "warn": 0}}
    outline["_preview"] = {
        "stage": "preview",
        "generated": len(outline["chapters"]),
        "target": int(chapter_count),
        "user_input": user_input or "",
    }
    await _log(f"预览已生成: 《{outline['title']}》前 {len(outline['chapters'])} 集", "log")
    # 2026-11-07：预览也立刻落库。此前预览完只打一条日志就继续展开，
    # 于是"预览跑完 10 分钟、随后展开 70 分钟"这段里草稿始终是空的 ——
    # 用户既看不到已完成的 3 集，中途取消也全白做。
    await _persist_outline_progress(draft_id, outline,
                                    done=len(outline["chapters"]),
                                    total=int(chapter_count))
    return outline


async def _persist_outline_progress(draft_id: int | None, outline: dict,
                                    *, done: int, total: int) -> None:
    """把展开过程中的中间成果写回草稿。**每批调用一次。**

    ## 为什么（2026-11-07 用户裁定：「每批结束就落库」）

    原先整个展开过程只在内存里累积，`_handle_gen_outline` 跑完全部批次才写一次。
    实测代价：draft #821 用 kimi-k3 跑到第 53/80 集被取消，85 分钟全部蒸发，
    草稿 outline 仍是 `{}`；同款事故 2026-10-28 让草稿 #2952 白丢 41 分钟。

    现在一批一存：中断最多丢当前这一批，用户也能边跑边看到已完成的集。

    ⚠️ 只写 outline 一个列。不改 title（标题由调用方在最终收尾时按需改）、
    不碰 episode_count，避免中途把草稿状态改乱。
    """
    if not draft_id:
        return
    try:
        from sqlalchemy.orm.attributes import flag_modified
        from ..db import session_scope, ScriptDraft
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            if not d:
                return
            # 深拷贝后整体赋值：outline 是 JSON 列，原地改内嵌 dict 不会触发 UPDATE
            # （2026-10-28 的事故就是这么来的：接口返回成功、库里一个字没变）。
            import copy
            d.outline = copy.deepcopy(outline)
            flag_modified(d, "outline")
            await s.flush()
        logger.info("大纲中间成果已落库 draft=%s %d/%d 集", draft_id, done, total)
    except Exception as e:  # noqa: BLE001
        # 落库失败不该让整批生成白跑 —— 继续往下，最终收尾还会再写一次。
        logger.warning("大纲中间落库失败 draft=%s（继续生成）: %s", draft_id, e)


async def expand_outline_from_preview(
    outline: dict,
    *,
    chapter_count: int | None = None,
    provider: str = "gemini",
    user_input: str | None = None,
    draft_id: int | None = None,
    run_lint: bool = True,
) -> dict:
    """两段式第二段: 以「(可能被用户改过的)预览」为基线, 续跑到全集并跑 lint。

    基线取自传入 outline 的 story_bible / state_ledger / chapters —— 用户在预览阶段
    对圣经、主线、前 N 集所做的任何修改, 都会成为后续所有批次的硬约束。
    幂等: 已有 >= 目标集数时直接跑 lint 返回, 不重复生成。
    """
    async def _log(msg: str, log_type: str = "progress"):
        if not draft_id:
            return
        try:
            from .log_helper import save_log
            await save_log(draft_id, "outline", msg, log_type, 0)
        except Exception:
            pass

    outline = dict(outline or {})
    meta = dict(outline.get("_preview") or {})
    total = int(chapter_count or meta.get("target") or 24)
    ui = user_input if user_input is not None else str(meta.get("user_input") or "")

    bible = outline.get("story_bible") or {}
    b_text = bible_text(bible)
    ledger = outline.get("state_ledger") or empty_ledger()
    chapters: list[dict] = list(outline.get("chapters") or [])
    outline.setdefault("characters", [])
    outline.setdefault("world", bible.get("world") or {})

    next_tpl = await _load_prompt_or_fallback("outline_generate_next", _OUTLINE_NEXT_PROMPT)

    start = len(chapters) + 1
    while start <= total:
        end = min(start + BATCH_SIZE - 1, total)
        await _log(f"正在展开大纲第 {start}~{end} 集（共 {total} 集）...")
        data = await _gen_batch(
            user_input=ui, bible_block=b_text,
            ledger_block=snapshot_text(ledger, start - 1),
            recap_block=_recap_block(chapters),
            start=start, end=end, total=total, provider=provider,
            prompt_tpl=next_tpl, is_first=False,
            mainline=outline.get("synopsis", ""),
        )
        batch_chs = _pad_batch(_norm_chapters(data.get("chapters") or [], start), start, end)
        chapters.extend(batch_chs)
        try:
            ledger = await update_ledger_for_batch(ledger, batch_chs, provider=provider)
        except Exception as e:  # noqa: BLE001
            logger.warning("账本更新失败(批 %d~%d): %s", start, end, e)
        # 2026-11-07：**每批落库**（用户裁定）。
        #
        # 原先整个展开过程只在内存里累积，`_handle_gen_outline` 跑完全部批次才写一次。
        # 实测代价：草稿 821 用 kimi-k3 跑到第 53/80 集被取消，85 分钟全部蒸发，
        # 草稿 outline 仍是 `{}`。同款事故 2026-10-28 也让草稿 #2952 白丢 41 分钟。
        # 现在一批一存：中断最多丢当前这一批，用户还能边跑边看到已完成的集。
        outline["chapters"] = chapters
        outline["state_ledger"] = ledger
        await _persist_outline_progress(draft_id, outline, done=len(chapters), total=total)
        start = end + 1

    outline["chapters"] = chapters
    outline["state_ledger"] = ledger

    if run_lint:
        await _log("正在做一致性校验(硬伤检测)...")
        try:
            outline["lint_report"] = await lint_outline(outline, use_llm=True, provider=provider)
            s = outline["lint_report"]["summary"]
            await _log(f"校验完成: {s['error']} 个错误, {s['warn']} 个警告", "log")
        except Exception as e:  # noqa: BLE001
            logger.warning("lint 失败: %s", e)
            outline["lint_report"] = {"issues": [], "summary": {"error": 0, "warn": 0}}

    # D1: 剧情结构门禁(零 LLM, 仅标注不阻断)
    try:
        from .drama_gate import check_outline as _gate
        outline["drama_report"] = _gate(outline, bible=outline.get("story_bible"))
    except Exception as _e:  # noqa: BLE001
        logger.warning("drama_gate 失败: %s", _e)

    meta.update({"stage": "expanded", "generated": len(chapters), "target": total})
    outline["_preview"] = meta
    return outline