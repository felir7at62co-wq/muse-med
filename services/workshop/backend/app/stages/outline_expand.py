"""outline_expand — 把「只有一句梗概」的集，扩写成「有节拍、有契约」的集。

## 它解决什么（2026-10-09 用户提问）

> "用户导入大纲或原文时，大纲往往缺失甚至空白，或者结构不像我们设计的这么严谨。
>   有时用户导入的大纲信息量过少，导致生成剧本时 AI 还是会胡乱编造。"

实测：**51 字梗概 → 4423 字剧本**（87 倍）。模型只能自己补足缺的那一层。

## 为什么"扩写大纲"而不是"让剧本自己补"

两者都会产生"大纲里没有的内容"，但**后果完全不同**：

| | 编造发生在剧本层（现状） | 编造发生在大纲层（本模块） |
|---|---|---|
| 用户何时发现 | 读完成片 | 生成前，在大纲页 |
| 能改吗 | 只能整集重生成赌运气 | 逐条改节拍 |
| 成本 | 一次剧本生成 | 一次短调用 |
| 结果 | 剧情可能整段跑偏 | 剧情是用户点头过的 |

一句话：**编造无法避免时，让它发生在用户看得见、改得动的那一层。**

## ⚠️ 与 `settings_backfill` 的**语义区别**（绝不能互相复用）

| | `settings_backfill._CONTRACT_PROMPT` | 本模块 |
|---|---|---|
| 场景 | 稿子**已经写完** | 稿子**还没写** |
| 语义 | **据实归纳**（这一集实际做了什么） | **创作**（这一集应该怎么演） |
| 约束 | "稿子里没有的一律不要编" | "不得新增人物/支线/反转" |

把描述型 prompt 用在未写的稿子上，等于让模型从一句话倒推"这一集实际做了什么" ——
那是编，而且是**假装没有编**。所以本模块单独持有 prompt，宁可两处文案相似，
也不要共用一个语义错位的模板。

## 复用大纲生成框架（用户明确要求）

本模块**不另起一套写法**，而是与 `outline_gen` 对齐：

- 同一份 `drama_principles.outline_block()` 原则块，同样用 `_with_principles()` 注入
  （先 format、再拼接 —— 原则块内有字面花括号，参与 format 会被吃掉）；
- 同一套每集 schema（`beats` + 全部契约字段）；
- 同一套归一函数 `outline_gen._norm_beats` / `_norm_chapters`；
- 同样分批、同样把**已生成的集**作为前文脉络喂给后续批次。

差别只有一个：`outline_gen` 是**从零生成**（用户给题材），本模块是**就着已有梗概扩写**
（用户已经写了这一集讲什么，我们只把"怎么演"补出来）。
"""
from __future__ import annotations

import json
import logging
import re

from ..models.llm import get_llm
from . import drama_principles
from .outline_gen import _norm_beats, _with_principles, empty_episode
from .episode_render import _s

logger = logging.getLogger("outline_expand")

#: 一次调用处理几集。与 `outline_gen.BATCH_SIZE` 一致取 10，
#: ⚠️ 但**绝不接受**单次超大范围（见 `MAX_EPISODES_PER_CALL` 的用户裁定）。
BATCH_SIZE = 10

#: 单次调用的硬上限。
#:
#: 用户裁定（2026-10-09）：成本不是限制 —— *"1~2 万字的成本差异都很少"*。
#: 这个上限存在的理由与成本无关，是**质量**：一批里塞太多集，模型对每一集的
#: 注意力会摊薄（本仓已有的同源教训见 `settings_backfill.BATCH_EPISODES = 8` 的说明）。
#: 超出的部分由上层拆成多次调用，而不是一次问完。
MAX_EPISODES_PER_CALL = 12


_EXPAND_PROMPT = """你是资深短剧编剧总策划。下面是一部剧里若干集的**现有大纲**。
这些大纲是用户写的，**剧情已经定了** —— 你要做的不是重写剧情，而是把它们
**扩写成可以直接开拍的一集**：补出「这一集按顺序演哪几拍」。

## 全剧设定（硬约束，不得违背）

{bible_block}

## 人物表（姓名固定，**严禁创造新人物或改名字**）

{characters_block}

{neighbor_block}

## 待扩写的集（**这几集的剧情已经定了，你只补"怎么演"**）

{episodes_block}

## 输出的核心：`beats`（本模块存在的唯一理由）

每一集的 `synopsis` 回答"这一集讲了什么"，**`beats` 回答"这一集按顺序演哪几拍"**。
后者才是下游写剧本时真正拿来用的东西 —— 没有它，写剧本只能凭一句概要自己编，
写出来的**不是你写的戏**。

每条 beat 必须齐备四样，**缺一不可**：
- `at`   地点 + 时间（如"城中村出租屋 夜"）—— 缺了，模型会自己换景；
- `who`  这一拍在场的**人物**，且必须是**本集梗概里已经出现过的那个称谓**
        （见下方硬规则第 2 条）—— 缺了，模型会拉错人进场；
- `action` 具体发生了什么，要求**能被拍出来**（谁对谁做了什么、说了哪句话）——
           缺了，模型会写成议论；
- `turn` 这一拍结束时局面/认知**变成了什么** —— 缺了，就会原地踏步。

**通常 3～6 个主要戏剧节拍**。这是本剧体裁实测出来的节奏：本平台已生成的
集纲里，每集中位数是 **3 拍**，九成落在 **3～5 拍**。
⚠️ **但这是参考区间，不是硬上限**：节拍以**局面、决定、认知或关系发生变化**为界，
复杂单集可以超出；普通手势、镜头、换位不单列为主要节拍。
⚠️ **拍数也不是越多越好**：一集硬塞十几拍，下游写剧本时只能每拍一句话带过，
反而把戏演薄了。宁可用 3 拍把一场戏演透，也不要 12 拍每拍一句交代。

## 🔴 扩写的边界（最重要，违反即失败）

1. **不得改变现有的剧情走向。** 用户写的 `synopsis` 是**结局已经定好**的：
   谁和谁对上、这一集结束在什么状态，都不能动。你补的是**中间怎么演**。
2. **不得新增人物，也不得给已有角色起名。** 这一条**与上面的"人物表"是不是空的无关**，
   即使人物表为空也照样成立。判据如下：
   - `who` 里只能写**该集自己那段梗概里已经出现过的称谓**，一字不改地沿用。
     梗概里写"海归精英男"，你就写"海归精英男"；
     **绝对不要**给他起名叫"林启文"——那个名字整部剧里根本不存在。
   - 梗概里写"外公""专家""精英男"这类**身份指代**时，直接沿用该指代即可，
     不要自作主张替换成一个人名，也不要补充他的姓名、学历、公司、履历。
   - 梗概里**没提到**的人，不得以任何理由进入这一集 —— 包括"表哥"这种
     在别的集才登场、这一集还没到的人。不要替用户提前排他的出场。
   - 确实需要"路人"（服务员、同事、路人甲）时，用这种**无名字**的通用指代。
3. **不得新增支线或反转。** 不能因为"觉得这一集不够精彩"就加一场意外、一个秘密、
   一个新人。**信息量不足不是加戏的理由** —— 你是把已有的事拆细，不是另编一件事。
4. **不得提前透支后文。** 只演到这一集 `synopsis` 写到的那个点为止；那之后的
   属于下一集，不要顺手演掉。**也不要新增"下集预告式"的结尾**：
   如果梗概结束在"他掏出手机发了一条信息"，就停在这里，
   不要自己加一个"门铃突然响起"来制造悬念。
5. **每条 beat 的 `action` 与 `turn` 必须因果相连**：因为发生了 A，所以变成了 B。
6. **不得把一集塞满。** 拍数以"局面/决定/认知/关系真正变化"为准，
   不要为了凑数把同一件事拆成好几拍来回演，也不要在没有新变化处硬加拍。

## 允许你补什么（这是让你"扩写"而不是"复述"的空间）

在**不改剧情**的前提下，你可以、也应该补出：
- 这一集的**开场画面**（第一拍怎么抓人 —— 但必须是 `synopsis` 里那件事的开头，
  不是新加的事件）；
- 中间**具体的对话与动作**（"她说服了他"要落成"她把病历单推过去，说：你签不签"）；
- 这一集**失败会失去什么**（`stakes`）：从既有人物处境里**具体化**，不是发明新处境；
- 这一集**比上一集难在哪**（`escalation`）；
- **结尾卡点**（`hook_out`）：必须落在 `synopsis` 已经写到的那个断点上。

## 输出格式（严格 JSON，不要 Markdown 包装、不要解释）

{{
  "episodes": [
    {{
      "order": 集号,
      "beats": [
        {{"at": "地点+时间", "who": "在场人物", "action": "能被拍出来的动作/台词", "turn": "这一拍结束时变成了什么"}}
      ],
      "core_push": "本集唯一核心推进点（一句话）",
      "value_shift": {{"from": "本集开始时主角的处境/认知", "to": "本集结束时变成了什么"}},
      "stakes": "本集失败会失去什么（具体到身份/资格/亲情/自由/传承/机会/信任/性命，禁止'丢脸''大家会失望'）",
      "hook_in": {{"responds_to": "如何承接上一集的结尾卡点", "mode": "直接延续|间接关联|有意延迟"}},
      "hook_out": {{"type": "突然揭示|紧急危机|未完成动作|身份反转|两难选择|神秘线索|时间限制|承诺威胁|离奇消失|言外之意", "strength": "好奇|关切|迫切|生存|终极", "leads_to": "它直接引发下一集发生什么"}},
      "escalation": "本集在哪个维度实质推进了主线（行动/关系/信息/资源/地位/情绪债务，允许阶段性胜利或局部降温）",
      "plant": ["本集埋下的伏笔（没有则空数组）"],
      "payoff": ["本集回收的伏笔（须是前文埋过的，没有则空数组）"],
      "forbidden": ["本集明确禁止发生的事"],
      "emotion_intensity": 7,
      "power": {{"aggressor": "本集主动推进/施压的人", "defender": "本集被推着走/守的人", "focus": "两人争的是什么（一句话）"}}
    }}
  ]
}}

## 必须满足
- `episodes` 必须覆盖上面给出的**每一集**，`order` 与给出的集号完全一致，一集不漏。
- **`beats` 要写足** —— 按上方"3～6 个主要节拍"的参考区间写，
  复杂单集可以超出，但**不要**把 synopsis 原句抄成一条 beat 交差（那等于没扩写），
  也**不要**把普通手势、换位、凝视单独凑成一条拍。
- 禁止弱卡点："若有所思""更大的危机正在靠近""一切才刚刚开始""意味深长的笑"。
- **只输出 JSON 对象**，禁止任何前后说明文字。"""


def _extract_json(text: str) -> dict:
    """从模型输出里抠 JSON（可能裹着 ```json 或前后废话）。"""
    s = (text or "").strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"\s*```$", "", s)
    try:
        obj = json.loads(s)
    except Exception:
        m = re.search(r"\{.*\}", s, re.DOTALL)
        if not m:
            raise ValueError("模型未返回可解析的 JSON")
        obj = json.loads(m.group(0))
    if not isinstance(obj, dict):
        raise ValueError("模型返回的不是 JSON 对象")
    return obj


def _episodes_block(eps: list[dict]) -> str:
    """把待扩写的几集渲染成 prompt 段。

    ⚠️ 刻意**只给 title/synopsis**，不给已有的契约字段。
    理由是防止模型"抄作业"：把旧的 `core_push` 原样搬回来当成新扩写的结果，
    看起来填满了、实际一个字没想。要让它是**重新想一遍**。
    """
    blocks = []
    for e in eps:
        o = int(e.get("order") or 0)
        head = f"### 第{o}集"
        t = str(e.get("title") or "").strip()
        if t and t != f"第{o}集":
            head += f"「{t}」"
        syn = _s(e.get("synopsis"))
        blocks.append(f"{head}\n【现有梗概（剧情已定）】\n{syn or '（无，请按全剧主线与前后集合理补出本集剧情，但不得新增人物或支线）'}")
    return "\n\n".join(blocks)


async def expand_episodes(
    outline: dict,
    orders: list[int],
    *,
    provider: str = "gemini",
    draft_id: int | None = None,
    prev_text: str = "",
    next_text: str = "",
) -> dict[int, dict]:
    """把指定几集的大纲扩写出节拍与契约。返回 `{集号: 补出来的字段}`。

    ## 只返回**补出来的字段**，不返回整集
    调用方负责"只填空、不覆盖用户内容"式的合并（见 `merge_expanded`）。
    本函数**绝不碰** `title` / `synopsis` —— 那是用户写的剧情，不是我们该改的。

    ## 分批
    每批 `BATCH_SIZE` 集，且单批不超过 `MAX_EPISODES_PER_CALL`。
    后续批把**已扩写好的前批**作为脉络喂进去（与 `outline_gen` 的 `recap_block` 同理），
    否则第 2 批不知道第 1 批打算怎么演，会出现承接不上或重复演同一拍。

    ## 失败就是失败
    某批调用失败/解析失败时，**不返回该批的占位空值** —— 让缺的集保持"没扩写"，
    由上层如实告诉用户"这 N 集没成功"。绝不写入看起来成功的空壳
    （本仓反复踩过的"静默降级"坑）。
    """
    eps_all = [e for e in (outline.get("chapters") or []) if isinstance(e, dict)]
    by_order = {int(e.get("order") or 0): e for e in eps_all}
    want = [o for o in orders if o in by_order]
    if not want:
        return {}

    bible_block = _bible_block(outline)
    characters_block = _characters_block(outline)
    neighbor_block = _neighbor_block(outline, want, prev_text, next_text)
    # 全剧梗概拼接串，供 audit_characters 判断"这个名字整部剧里到底有没有"
    all_syn = "\n".join(_s(e.get("synopsis")) for e in eps_all)

    result: dict[int, dict] = {}
    done_eps: list[dict] = []
    for i in range(0, len(want), BATCH_SIZE):
        batch_orders = want[i:i + BATCH_SIZE][:MAX_EPISODES_PER_CALL]
        batch = [by_order[o] for o in batch_orders]
        prompt = _EXPAND_PROMPT.format(
            bible_block=bible_block,
            characters_block=characters_block,
            neighbor_block=neighbor_block,
            episodes_block=_episodes_block(batch),
        )
        # 前批已扩写的结果作为脉络（与 outline_gen 一致：让后续批接得上）
        if done_eps:
            recap = ["## 前面几集**已经扩写**的节拍（供衔接，勿重复）"]
            for e in done_eps:
                recap.append(f"### 第{e.get('order')}集")
                for j, b in enumerate(e.get("beats") or [], start=1):
                    if isinstance(b, dict):
                        recap.append(
                            f"  {j}) {_s(b.get('at'))} {_s(b.get('action'))}"
                            f" → {_s(b.get('turn'))}")
            prompt = prompt + "\n\n" + "\n".join(recap)

        # ⚠️ 与 outline_gen 同款：原则块内含字面 JSON 花括号，必须**先 format 再拼接**
        prompt = _with_principles(prompt)

        try:
            llm = get_llm("generate", temperature=0.6, provider=provider)
            resp = await llm.ainvoke(prompt)
            data = _extract_json(getattr(resp, "content", "") or "")
        except Exception as e:  # noqa: BLE001
            logger.warning("大纲扩写批次失败 (集 %s): %s", batch_orders, e)
            if draft_id:
                try:
                    from .log_helper import save_log
                    await save_log(
                        draft_id, "outline",
                        f"⚠ 扩写第 {'、'.join(str(o) for o in batch_orders)} 集失败: "
                        f"{type(e).__name__}: {str(e)[:200]}",
                        "warn", 0,
                    )
                except Exception:  # noqa: BLE001
                    pass
            continue

        for item in (data.get("episodes") or []):
            if not isinstance(item, dict):
                continue
            try:
                o = int(item.get("order"))
            except (TypeError, ValueError):
                continue
            if o not in batch_orders:
                # 模型回了我们没要的集 —— 丢弃，绝不写进 outline
                continue
            rec = _pick_fields(item)
            if rec:
                # 人物越界审计：只记录、不改内容（见 audit_characters 的说明）。
                # 挂在 rec 上而非单独返回，是因为下游是按集合并的，多一条通道
                # 就要多改一处调用方。`_` 开头的键由 merge_expanded 拦下，
                # 不会污染大纲字段。
                try:
                    rec["_char_audit"] = audit_characters(
                        by_order.get(o) or {}, rec, all_synopses=all_syn)
                except Exception as _e:  # noqa: BLE001
                    logger.debug("人物审计失败(第%s集): %s", o, _e)
                result[o] = rec
                done_eps.append({"order": o, "beats": rec.get("beats") or []})

        if draft_id:
            got = [o for o in batch_orders if o in result]
            try:
                from .log_helper import save_log
                await save_log(
                    draft_id, "outline",
                    f"扩写完成 {len(got)}/{len(batch_orders)} 集"
                    f"（第 {'、'.join(str(o) for o in batch_orders)} 集）",
                    "progress", 0,
                )
            except Exception:  # noqa: BLE001
                pass

    return result


#: 本模块**允许**写回的字段。白名单，不是黑名单。
#: ⚠️ 刻意**不含** `title` / `synopsis` —— 那是用户写的剧情。
#: 也不含 `_beats_stale` 之类内部标记（由调用方管理）。
_EXPANDABLE = (
    "core_push", "stakes", "escalation", "forbidden", "audience_knows_delta",
    "emotion_intensity", "plant", "payoff", "beats",
    "value_shift", "hook_in", "hook_out", "char_knows_delta", "power",
)


#: 一集允许的 beat 条数。
#:
#: 这不是"成本的限制"，是**体裁节奏的实测值**：
#: 本平台已生成的大纲里，每集 beat 数的中位数是 3，p90 是 4，最大值是 5。
#: 下限取 2（低于 2 就是没扩写），上限取 8（比实测 p100 留一倍余量）。
#:
#: ⚠️ 2026-10-09 实测：同一条 prompt 下，**越强的模型越会冲破这个上限**。
#: 线上现用的 gemini-3.6-flash 与 3.8-flash 都稳定给 4～5 拍，
#: 而 claude-opus-5-5 给了 **11～13 拍**（基准的 3~4 倍），
#: 并且顺手编了不存在的人物名。所以"拍数"必须由**代码**兜住，不能只靠 prompt 里写。
BEAT_MIN = 2
BEAT_MAX = 8


def trim_beats(beats: list[dict], *, limit: int = BEAT_MAX) -> tuple[list[dict], int]:
    """把超量的 beat 砍到 `limit`，返回 `(保留的, 被砍掉的条数)`。

    ## 为什么"砍"是安全的

    超量几乎总是**同一件事被拆碎**（实测：opus 把"外公叫出精英男"拆成了
    "温晴张开双臂挡住"→"外公示意保镖停下"→"外公侧身让开半步"三拍），
    而不是"多演了一件梗概里没有的事"。所以砍掉的是**粒度**，不是**剧情** ——
    用户手里的 synopsis 仍然是完整的，下游写剧本时那场戏照样会演到。

    ## 为什么保留前 N 条而不是均匀抽样

    一集的信息结构是"起 → 推 → 转折 → 卡点"，**尾部是卡点**。
    均匀抽样会把中间的铺垫和结尾的钩子一起抽没；
    而"保留前 N 条"至少保证**开场**完整。
    尾部卡点由 `hook_out` 单独承载（它是独立字段，不受这里影响），
    所以不会因为砍 beat 而丢掉本集的断点。

    ## 什么情况下**不砍**

    只有 `beats` 特别多时才算"超量"。若去掉后面几拍会让这一集的
    `turn` 断了因果，那是模型没写好的问题，应当由 prompt 修，
    而不是在这里留一堆碎拍 —— 碎拍对下游是纯负担。
    """
    if not isinstance(beats, list) or len(beats) <= limit:
        return (beats or []), 0
    return beats[:limit], len(beats) - limit


def audit_characters(ep: dict, expanded: dict, *, all_synopses: str = "") -> list[str]:
    """检查扩写出来的一集里，有没有**编出来的人**。返回问题描述列表（空=没问题）。

    ## 为什么需要它（2026-10-09 实测）

    同一条 prompt 下：
      · gemini-3.6/3.8-flash —— 老实照抄梗概里的称谓（"海归精英男"）；
      · claude-opus-5-5 —— 给"海归精英男"起了个名字叫 **林启文**，
        而这个名字在全剧 60 集梗概里出现 **0 次**；
        还把第 25 集才登场的"表哥"写进了第 **28** 集。

    两者都**违反 prompt 里白纸黑字的"不得新增人物"**。区别只是：
    flash 档没有足够的"创作冲动"去违反，opus 有。
    **提示词越强，越需要代码兜底** —— 所以这里不看 prompt 写得够不够狠，
    只看结果里有没有梗概里根本没有的称谓。

    ## 判据：只判"**全剧都找不到**"，不判"本集没提到"（这是重点）

    第一版写的是"`who` 必须能在**本集梗概**里找到"，实测**误报率高到没法用**：
    第 21 集梗概写"精英男"、模型写"海归精英男"就被判越界；
    "温晴"没被写进那一集的梗概，也照样被报。
    一集报出 6 条、全是误报 —— 用户看两次就会彻底无视这个提示，
    那比不做审计更糟（它把真问题也淹掉了）。

    改为只判**全剧检索**：一个在整部剧任何一集梗概里都找不到的称谓，才报。

    代价是"把第 25 集才登场的表哥写进第 28 集"这类**跨集提前拉人**抓不到了——
    那个角色确实存在，只是来早了。但那是**轻错**（人物是真的），
    而凭空编造一个不存在的人是**重错**。宁可漏报轻的，也不要误报把提示变成噪声。

    **只报不改** —— 结果进 `_char_audit` 供前端提示与日志，不动模型产出的内容。
    """
    issues: list[str] = []
    syn = _s(ep.get("synopsis"))
    for i, b in enumerate((expanded or {}).get("beats") or [], start=1):
        if not isinstance(b, dict):
            continue
        who = _s(b.get("who"))
        if not who:
            continue
        # who 常见写法是"甲、乙、丙"，按顿号/逗号/斜杠切开逐个核
        for raw in re.split(r"[、,，/／和与]", who):
            nm = raw.strip()
            if not nm or len(nm) < 2:
                continue
            # 通用指代（服务员/同事甲/路人）一律放过 —— prompt 明确允许
            if re.search(r"(服务员|同事|路人|记者|医生|护士|保镖|管家|司机|"
                         r"工作人员|群演|众人|人群|旁观|乘客|顾客|学生|员工|"
                         r"等人|们|甲|乙|丙)", nm):
                continue
            # 本集梗概里有 → 正常，短路放过（绝大多数情况走这条）
            if nm in syn:
                continue
            # 全剧别处有 → 这个角色是真的，只是可能来早了。**不报**（见 docstring）
            if all_synopses and nm in all_synopses:
                continue
            issues.append(f"第{i}拍 who 里的「{nm}」在本剧任何一集梗概中都不存在，"
                          f"疑似模型自行编造的人物")
    return issues


def _pick_fields(item: dict) -> dict:
    """从模型返回的一集里，挑出我们允许写回的字段并归一。"""
    rec: dict = {}
    beats = _norm_beats(item.get("beats"))
    if beats:
        beats, dropped = trim_beats(beats)
        if dropped:
            logger.info("扩写：本集节拍 %d 条超出上限 %d，保留前 %d 条（砍掉 %d）",
                        len(beats) + dropped, BEAT_MAX, len(beats), dropped)
        rec["beats"] = beats
        rec["_beats_trimmed"] = dropped

    for k in ("core_push", "stakes", "escalation", "forbidden",
              "audience_knows_delta"):
        v = str(item.get(k) or "").strip()
        if v:
            rec[k] = v

    for k in ("plant", "payoff"):
        v = item.get(k)
        if isinstance(v, list):
            items = [str(x).strip() for x in v if str(x or "").strip()]
            # plant/payoff 的**空数组是结论**（"这集没有伏笔"），要写回；
            # 但只在模型确实给了这个键时才写，不给就保持原值。
            rec[k] = items

    vs = item.get("value_shift")
    if isinstance(vs, dict):
        rec["value_shift"] = {
            "from": str(vs.get("from") or "").strip(),
            "to": str(vs.get("to") or "").strip(),
        }

    for key, sub in (("hook_in", ("responds_to", "mode")),
                     ("hook_out", ("type", "strength", "leads_to"))):
        v = item.get(key)
        if isinstance(v, dict):
            rec[key] = {k: str(v.get(k) or "").strip() for k in sub}

    ckd = item.get("char_knows_delta")
    if isinstance(ckd, dict):
        rec["char_knows_delta"] = {
            str(k).strip(): str(v).strip() for k, v in ckd.items() if str(k).strip()
        }

    pw = item.get("power")
    if isinstance(pw, dict):
        rec["power"] = {k: str(pw.get(k) or "").strip()
                        for k in ("aggressor", "defender", "focus")}

    # 情绪强度：复用 outline_gen 的归一（非法/越界 → 0 = 未标注）
    from .outline_gen import _coerce_intensity
    ei = _coerce_intensity(item.get("emotion_intensity"))
    if ei:
        rec["emotion_intensity"] = ei

    return rec


def merge_expanded(outline: dict, expanded: dict[int, dict],
                   *, overwrite: bool = False) -> tuple[dict, dict]:
    """把扩写结果合并进 outline。返回 `(新 outline, 统计)`。

    ## `overwrite=False`（默认）：**只填空**
    与 `settings_backfill` 同一套安全原则 —— 用户已有的东西一个字不动：
      · 已有 `beats` 就不覆盖（用户可能自己改过节拍，那是他的创作）；
      · 契约字段逐**键**判断，缺哪个补哪个。
    这样重复点是安全的：第二次只会补第一次没补上的。

    ## `overwrite=True`：用户明确要求"重做这一集的节拍"
    只有在这种情况下才覆盖已有的 `beats`。

    ⚠️ 无论哪种模式，`title` / `synopsis` **永不改动** —— `_pick_fields` 的白名单
    里根本没有这两个键。

    ⚠️ 合并时必须**清掉** `_beats_stale` 标记：扩写产出的节拍与当前 synopsis
    是对齐的（prompt 里给的正是当前 synopsis），标记继续留着会导致
    `episode_render.build_beats_block` 把刚补好的节拍**判为过期而弃用** ——
    白干一场，且没有任何报错。
    """
    out = dict(outline or {})
    eps = [dict(e) if isinstance(e, dict) else e
           for e in (out.get("chapters") or [])]
    stats = {"filled": 0, "beats_added": 0, "skipped": 0, "beats_trimmed": 0}
    for e in eps:
        if not isinstance(e, dict):
            continue
        o = int(e.get("order") or 0)
        rec = expanded.get(o)
        if not rec:
            continue
        touched = False
        for k, v in rec.items():
            # 下划线开头的是**本模块的内部标记**，不是大纲字段。
            # ⚠️ 不拦住的话 `_beats_trimmed` 会被这个循环原样写进 outline，
            # 在每一集里留下一个下游看不懂的键（本仓"静默多写字段"的老坑）。
            if k.startswith("_"):
                if k == "_beats_trimmed":
                    stats["beats_trimmed"] += int(v or 0)
                continue
            if k == "beats":
                if isinstance(e.get("beats"), list) and e["beats"] and not overwrite:
                    continue
                if v:
                    e["beats"] = v
                    stats["beats_added"] += 1
                    touched = True
                continue
            # 与 settings_backfill._has 同款：列表类型"键存在即算有"（空数组是结论）
            if not overwrite and _has_value(e, k):
                continue
            e[k] = v
            touched = True
        if touched:
            stats["filled"] += 1
            # 节拍已与当前 synopsis 对齐 → 撤掉过期标记
            e.pop("_beats_stale", None)
        else:
            stats["skipped"] += 1
    out["chapters"] = eps
    return out, stats


def _has_value(ep: dict, k: str) -> bool:
    """这一集的某个键**算不算已经有了**。

    ⚠️ 不能简单用真值判断：`plant: []` 表示"这集确实没有伏笔"，是**结论**不是空缺
    （与 `settings_backfill._has` 同一考量）。列表/字典只要键存在就算有。
    """
    if k not in ep:
        return False
    v = ep[k]
    if isinstance(v, (list, dict)):
        return True
    return bool(str(v or "").strip())


# ---------------------------------------------------------------------------
# prompt 各块的取数（与 outline_gen / chapter_gen 一致性优先）
# ---------------------------------------------------------------------------

def _bible_block(outline: dict) -> str:
    """全剧设定块。优先用 story_bible，没有就退回 world。"""
    bible = outline.get("story_bible")
    if isinstance(bible, dict) and bible:
        try:
            from .story_bible import bible_text
            t = bible_text(bible)
            if t and t.strip():
                return t
        except Exception as e:  # noqa: BLE001
            logger.warning("bible_text 渲染失败，退回 world: %s", e)
    world = outline.get("world") or {}
    if not isinstance(world, dict) or not world:
        return "（本剧未提供世界观设定）"
    lines = []
    if _s(world.get("era")):
        lines.append(f"- 时代/背景：{_s(world['era'])}")
    if _s(world.get("setting")):
        lines.append(f"- 核心场景：{_s(world['setting'])}")
    for r in (world.get("rules") or []):
        if _s(r):
            lines.append(f"- 规则：{_s(r)}")
    syn = _s(outline.get("synopsis"))
    if syn:
        lines.append(f"- 全剧主线：{syn}")
    return "\n".join(lines) or "（本剧未提供世界观设定）"


def _characters_block(outline: dict) -> str:
    from .episode_render import format_characters
    chars = outline.get("characters") or []
    if not chars:
        # 退回 character_registry（部分导入路径只写了 registry，没写 characters —— 老坑）
        reg = (outline.get("character_registry") or {}).get("characters") or []
        chars = reg if isinstance(reg, list) else []
    if chars:
        return format_characters(chars)
    return _roster_from_synopses(outline)


#: 从梗概里挑"称谓"时的排除词。这些是**明显不是人物**的高频词，
#: 不排掉的话"没有""已经""现在"会挤满参照表，等于没给。
_NOT_A_NAME = frozenset("""
什么 怎么 这个 那个 可是 但是 因为 所以 如果 虽然 已经 正在 现在 刚才 现场
地方 时候 一切 所有 大家 一下 一些 一直 非常 马上 立刻 突然 忽然 明白 知道
看到 听到 想到 说道 回答 回应 沉默 点头 摇头 他们 她们 我们 你们 自己 别人
然后 后来 之后 今天 明天 昨天 早上 晚上 下午 上午 开始 结束 为了 不过 只是
就是 还是 于是 同时 此时 此刻 终于 竟然 果然 居然 根本 简直 除了 接着 随后
一眼 一脸 一声 一句 一把 一步 一阵 一片 之外 之前 当时 当场 直接 瞬间
带着 而是 企图 不仅 就在 结果 要求 女方 全场 两人 三人 一个 我的 里的
""".split())

#: 明显**不是人**的构词特征：机构、物件、文书、量词、时间。
#: 梗概里这些词频很高，光靠停用词表挡不住（实测"病房""手机""资产""画面"都进过表）。
_NOT_PERSON_RE = re.compile(
    r"(公司|集团|科技|有限|医院|病房|诊所|手机|电话|短信|视频|录音|代码|数据|"
    r"资产|股权|股份|资金|现金|合同|协议|文件|证据|流水|账户|监控|走廊|大门|"
    r"门外|楼下|画面|作品|字幕|底部|全程|显示|出场人|人物|内心|"
    r"点钟|分钟|万元|亿元|块钱|第一|第二|第三|"
    r"时候|地方|东西|事情|问题|办法|原因|方式|情况|状态|"
    r"看着|说道|来了|去了|不是|没有|已经|就是)"
)


def _strip_labels(t: str) -> str:
    """剥掉嵌在梗概正文里的**字段标签**（`【结尾卡点】：…`、`[本集对手]…`）。

    ⚠️ 2026-10-09 实测：导入的梗概里大量嵌着这种标记，且**标签名本身会污染词频**。
    草稿 624 里"卡点"出现 15 次、"结尾卡"出现 14 次 —— 于是它们稳稳进了
    自动归纳的"人物称谓参考表"，等于往白名单里塞了 29 次噪声。
    剥掉括号再统计，"卡点""结尾"就自然消失了。
    """
    t = re.sub(r"【[^】]*】", "", t or "")
    return re.sub(r"\[[^\]]*\]", "", t)


def _roster_from_synopses(outline: dict, *, limit: int = 40) -> str:
    """人物表为空时，从全剧梗概里现推一份**称谓参考**。

    ## 为什么必须有这个兜底

    实测（2026-10-09，草稿 624「外卖--集纲」）：`outline.characters` 是空数组，
    于是提示词里"人物表"那一段渲染成**空白** —— 而同一段还写着
    "严禁创造新人物"。那句话当时**没有任何参照物**，模型只能自己编。
    结果是它给"海归精英男"起了个名字叫**林启文**，而这个名字在全剧 60 集梗概里
    出现 **0 次**；还把第 25 集才登场的"表哥"写进了第 28 集。

    全库 372 个有集的草稿里，**90 个**的人物表是空的。空表 = 没有边界。

    ## 为什么是"称谓"而不是"人名"

    这些导入的草稿里，人物本来就以**身份指代**出现（"外公""精英男""专家"）。
    它们不是人名，但**足以当边界用**：模型照着抄就不会发明新称谓。
    所以这里不猜人名、不做实体识别，只把梗概里出现频次够高的 2-4 字词
    捞出来当"看来这部剧里有这些角色"的证据。

    ## 与 `import_script.extract_character_names_fast` 的区别

    那个是从**正文**提人名（有对白引号、"说"字等结构可依），本函数是从**梗概**
    提称谓（没有这些结构，只能靠频次 + 停用词表）。两者的输入性质不同，
    故不复用 —— 硬套过来会把"外卖""病房""监控"这类高频名词当人物。

    推不出来就如实说"没推出来"，宁可让模型知道这里缺东西，也不要给一份假名单。
    """
    eps = [e for e in (outline.get("chapters") or []) if isinstance(e, dict)]
    # ⚠️ 必须先剥掉嵌在正文里的字段标签（`【结尾卡点】：…`），
    # 否则标签名本身会以高得离谱的频次占据候选表（详见 _strip_labels）。
    texts = [_strip_labels(_s(e.get("synopsis"))) for e in eps]
    text = "\n".join(texts)
    if not text.strip():
        return ("（未提供。⚠️ 这种情况下**更要严格**：人物只能从各方**本集梗概**里"
                "已经出现的称谓中选取，不得发明新称谓，也不得给身份指代补人名。）")

    def spread(tok: str) -> int:
        """这个词出现在**多少集**里。

        ⚠️ 光看总频次不够：一次集里反复出现的普通名词（"病房"在第 28 集出现 8 次）
        总频次很高却只在一两集里。真正的常驻角色会**跨很多集**出现，
        所以"跨集数"比"总频次"更能区分人与物。
        """
        return sum(1 for t in texts if tok in t)

    import collections
    counter: collections.Counter = collections.Counter()
    for t in texts:
        # 2-3 字滑窗。不取 4 字：四字窗口跨词边界，捞出来的多是"许舟没有"这种碎片。
        for n in (3, 2):
            for m in re.finditer(rf"[一-龥]{{{n}}}", t):
                w = m.group(0)
                if w in _NOT_A_NAME or _NOT_PERSON_RE.search(w):
                    continue
                counter[w] += 1

    # 双阈值：总频次 ≥5，且**跨 ≥6 集**出现。
    # 只满足其一的多半是局部名词或口头禅，不配当白名单。
    cands = [(w, c) for w, c in counter.most_common(300)
             if c >= 5 and spread(w) >= min(6, max(2, len(eps) // 6))]
    if not cands:
        return ("（未能从梗概中推得。⚠️ 人物只能从各方**本集梗概**里已经出现的称谓中"
                "选取，不得发明新称谓，也不得给身份指代补人名。）")

    # 去重：**短词优先**，且丢弃"含有已选词"的长候选。
    #
    # ⚠️ 这里的两个方向都曾经写反，且后果很隐蔽：
    #   ① 排序：按频次降序时，切词碎片"许舟却"（来自"许舟却死死挡在"）
    #      频次往往不低于真名"许舟"，于是**碎片先入表**；
    #   ② 包含判断：写成 `any(cand in picked)` 是"候选被已选词包含"，
    #      于是真名"许舟"因为被"许舟却"包含而**被丢掉**，
    #      最后表里剩下的全是"许舟却""许舟没"这种碎片 —— 恰好把有用的挤走了。
    #   正确方向：短词先入表，长候选若**含有**已选短词就丢弃。
    #   "许舟"入选后，"许舟却""许舟没有"都会因包含它而被丢弃。
    cands.sort(key=lambda kv: (len(kv[0]), -kv[1]))
    picked: list[str] = []
    for w, _c in cands:
        if any(p in w for p in picked):
            continue
        picked.append(w)
        if len(picked) >= limit:
            break

    return ("（⚠️ 本剧**没有单独维护人物表**，以下是从全剧梗概里自动归纳的**称谓**，"
            "供你判断『这部剧里都有谁』。它们多半是身份指代而不是人名，"
            "**请原样沿用，不要替换成人名、也不要补充姓名/学历/公司/履历**：\n  "
            + "、".join(picked)
            + "）")


#: 邻集上限的保守兜底（取不到窗口配置时用）。
_NEIGHBOR_CAP_FALLBACK = 8_000


def _neighbor_cap_chars() -> int:
    """邻集能给多少字 —— 按模型窗口算。

    ⚠️ 2026-10-10：原实现硬编码 `prev_text[:8000]` / `next_text[:8000]`。
    8000 < 单集平均 1606 字的 5 倍看似够，但正文集可达 20000+ 字，
    邻集被腰斩后模型就接不上"上一集演到哪一拍" —— 而这正是重演的成因。
    """
    try:
        from ..config import get_settings
        from .text_budget import text_budget_chars
        return text_budget_chars(
            get_settings().llm_generate_model or "", purpose="continuation")
    except Exception:  # noqa: BLE001
        return _NEIGHBOR_CAP_FALLBACK


def _clip_prev(text: str, cap: int) -> str:
    """上一集留**尾** —— 离本批最近的部分，衔接价值最高。"""
    from .episode_text import clip
    return clip(text, cap, keep="tail")


def _clip_next(text: str, cap: int) -> str:
    """下一集留**头** —— 本批要往它那里去，开头说明它从哪演起。"""
    from .episode_text import clip
    return clip(text, cap, keep="head")


def _neighbor_block(outline: dict, orders: list[int],
                    prev_text: str, next_text: str) -> str:
    """前后集上下文。

    与两条生成路径同口径：**原文优先**（用户已定结论），
    扩写场景下更要紧 —— 扩出来的节拍必须接得上前后集已经演过的内容。
    取不到原文就退回该集梗概。
    """
    eps = [e for e in (outline.get("chapters") or []) if isinstance(e, dict)]
    lo, hi = (min(orders), max(orders)) if orders else (0, 0)
    parts: list[str] = []
    # 邻集上限按模型窗口算（2026-10-10：不再硬编码 8000 —— 那个数在
    # 70 万口径下把邻集砍掉大半，而邻集正是"接得上/不越界"的唯一依据）。
    _cap = _neighbor_cap_chars()

    if prev_text:
        parts.append(f"### 上一集（第{lo-1}集）已演过的内容（原文）\n"
                     f"{_clip_prev(prev_text, _cap)}")
    else:
        prev = next((e for e in eps if int(e.get("order") or 0) == lo - 1), None)
        if prev and _s(prev.get("synopsis")):
            parts.append(f"### 上一集（第{lo-1}集）梗概\n{_s(prev['synopsis'])}")

    if next_text:
        parts.append(f"### 下一集（第{hi+1}集）已写好的内容（原文，本批不得提前演掉）\n"
                     f"{_clip_next(next_text, _cap)}")
    else:
        nxt = next((e for e in eps if int(e.get("order") or 0) == hi + 1), None)
        if nxt and _s(nxt.get("synopsis")):
            parts.append(f"### 下一集（第{hi+1}集）梗概（本批不得提前演掉）\n"
                         f"{_s(nxt['synopsis'])}")

    if not parts:
        return ""
    return ("## 前后集（衔接依据）\n"
            "扩写出来的节拍必须与它们衔接：上一集演过的不要重演，"
            "下一集要演的不要提前演掉。\n\n" + "\n\n".join(parts))


def expandable_orders(outline: dict, *, only_orders: list[int] | None = None) -> list[int]:
    """挑出"值得扩写"的集号：只有梗概、没有节拍的那些。

    ⚠️ 判据与 `outline_density` 一致，但这里**不复用它的分档** ——
    `outline_density` 是给用户看的"要不要提醒"，本函数是"能不能动手"。
    两者将来会各自演化（例如用户主动要求给已经够厚的集重做节拍）。
    """
    eps = [e for e in (outline.get("chapters") or []) if isinstance(e, dict)]
    out = []
    for e in eps:
        o = int(e.get("order") or 0)
        if only_orders is not None and o not in only_orders:
            continue
        if isinstance(e.get("beats"), list) and e["beats"]:
            continue
        out.append(o)
    return sorted(out)


def apply_to_outline(outline: dict, expanded: dict[int, dict],
                     *, overwrite: bool = False) -> dict:
    """便捷入口：合并并返回新 outline（原地不改传入对象）。"""
    merged, _ = merge_expanded(outline, expanded, overwrite=overwrite)
    return merged


__all__ = [
    "BATCH_SIZE", "MAX_EPISODES_PER_CALL", "expand_episodes",
    "merge_expanded", "apply_to_outline", "expandable_orders",
]
