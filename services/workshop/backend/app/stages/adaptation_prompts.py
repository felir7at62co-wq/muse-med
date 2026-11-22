"""改编功能 — 蓝图提炼 / 连带建议 / 大纲改编 的 prompt 构造。

改编 = 保留原作"剧情骨架 + 情绪节拍",按用户指定维度(人名/人际关系/时代/地点/
中心矛盾等)替换"表层设定",产出逻辑自洽、情绪曲线贴合原作的新作。

三类 prompt:
  1. analyze  —— 从原作 outline(+章节摘要) 提炼结构化「原作蓝图」
  2. suggest  —— 基于用户已做的改动, 给出符合逻辑的连带修改建议
  3. adapt    —— 按「改编合同」逐批改写大纲(骨架保留、表层替换、节拍对齐)
"""
from __future__ import annotations

import json


# ===========================================================================
# 1. 蓝图提炼
# ===========================================================================

ANALYZE_PROMPT = """你是资深短剧剧本分析师。下面是一部已完成短剧的结构化资料。
请把它提炼成一份「原作蓝图」, 用于后续改编。

# 原作资料
{source_block}

# 任务
提炼出下列要素, 严格输出 JSON(不要 Markdown 包装, 不要解释文字):

{{
  "title": "原作标题",
  "logline": "一句话主线(50字内)",
  "era": "时代背景(如 现代都市/民国/架空古代)",
  "locations": ["主要地点1", "主要地点2"],
  "central_conflict": "中心矛盾(一句话, 谁与谁因何对立)",
  "characters": [
    {{"name":"姓名","role":"角色定位(主角/反派/配角)","persona":"性格与动机一句话"}}
  ],
  "relations": [
    {{"a":"角色A","b":"角色B","relation":"关系(如 婆媳/上下级/恋人)","tension":"该关系的张力来源一句话"}}
  ],
  "emotion_beats": [
    {{"stage":"开端/发展/高潮/结局","beat":"情绪节拍(如 危机/反转/情感高点/和解)","note":"该节拍承载的剧情一句话"}}
  ]
}}

# 要求
- characters 覆盖所有有名有姓的主要角色(最多 12 个)
- relations 覆盖推动剧情的核心人际关系(最多 10 组)
- emotion_beats 按时间顺序概括全剧情绪曲线(6-12 个节拍), 这是改编时必须贴合的骨架
- 只输出 JSON, 前后不要有任何其他文字
"""


def build_source_block(*, outline: dict, chapter_summaries: list[dict]) -> str:
    """把原作 outline + 章节摘要拼成提炼用的资料块(有界, 防爆上下文)。"""
    blocks: list[str] = []
    title = (outline or {}).get("title") or ""
    synopsis = (outline or {}).get("synopsis") or ""
    world = (outline or {}).get("world") or {}
    chars = (outline or {}).get("characters") or []
    registry = (outline or {}).get("character_registry") or {}
    bible = (outline or {}).get("character_bible") or {}
    ol_chapters = (outline or {}).get("chapters") or []

    if title:
        blocks.append(f"标题: {title}")
    if synopsis:
        blocks.append(f"主线: {synopsis}")
    if world:
        era = world.get("era", "")
        setting = world.get("setting", "")
        if era or setting:
            blocks.append(f"世界观: {era} | {setting}")

    if chars:
        blocks.append("\n## 人物表")
        for c in chars[:20]:
            line = f"- {c.get('name','')} ({c.get('role','')})"
            traits = "/".join(c.get("traits") or [])
            if traits:
                line += f" · 性格: {traits}"
            blocks.append(line)

    # 角色圣经(含立场/动机)优先, 信息更丰富
    bible_chars = (bible or {}).get("characters") or []
    if bible_chars:
        blocks.append("\n## 角色设定(立场/动机)")
        for c in bible_chars[:12]:
            nm = c.get("name", "")
            stance = c.get("stance") or c.get("motivation") or c.get("persona") or ""
            if nm:
                blocks.append(f"- {nm}: {stance}")

    if ol_chapters:
        blocks.append("\n## 分集大纲")
        for c in ol_chapters[:60]:
            blocks.append(
                f"- 第{c.get('order')}集 「{c.get('title','')}」: {c.get('synopsis','')}"
            )

    if chapter_summaries:
        blocks.append("\n## 章节摘要(节选)")
        for c in chapter_summaries[:30]:
            # ⚠️ 2026-10-10：走统一口径，别直接读 summary ——
            # 库里 2319 章的 summary 是正文前 500 字截断，被当成"整集概要"
            # 会让改编蓝图基于错误的剧情认知生成。空摘要也不再静默跳过，
            # 而是退回原文（按预算裁剪）。
            from .episode_text import pick_episode_text
            _order = int(c.get("chapter_order") or 0)
            s = (pick_episode_text({"order": _order}, c,
                                   purpose="overview", budget_chars=600)[0] or "").strip()
            if s:
                blocks.append(f"- 第{c.get('chapter_order')}集: {s}")

    return "\n".join(blocks)


def build_analyze_prompt(*, outline: dict, chapter_summaries: list[dict]) -> str:
    return ANALYZE_PROMPT.format(
        source_block=build_source_block(
            outline=outline, chapter_summaries=chapter_summaries
        )
    )


# ===========================================================================
# 2. 连带修改建议
# ===========================================================================

SUGGEST_PROMPT = """你是资深短剧改编策划。用户正在把一部原作改编成新作。
下面是「原作蓝图」与用户当前「改编蓝图(草案)」的对照。

# 原作蓝图
{origin_json}

# 用户当前改编草案
{draft_json}

{focus_block}
# 任务
检查用户的改动是否引发"逻辑连带问题", 给出**符合逻辑的修改建议**, 让新作自洽、连贯,
且情绪曲线仍贴合原作。重点关注:
- 人际关系变动牵动的连带项: 称呼体系、辈分、年龄差、利益动机链(例: 婆媳→姐妹, 则"争夺儿子"应改为"争夺父母偏爱/家产", 称呼"妈"应改为"姐")
- 时代/地点变动牵动的职业、场景、道具、台词风格是否需要同步调整
- 改名后是否在 relations / emotion_beats 中保持一致
- 中心矛盾若改变, 情绪节拍能否仍然成立

# 输出(严格 JSON, 不要 Markdown 包装, 不要解释文字)
{{
  "suggestions": [
    {{
      "target": "建议作用的对象(如 relations/角色'苏曼'/era/central_conflict)",
      "issue": "发现的连带问题一句话",
      "advice": "具体修改建议一句话",
      "patch": {{ "可选: 直接可套用的字段补丁, 形如 {{\\"field\\":\\"...\\",\\"value\\":\\"...\\"}}, 无则省略" }}
    }}
  ],
  "overall": "整体评估一句话(新作是否自洽、情绪曲线是否贴合原作)"
}}

# 要求
- 只针对"用户改动引发的"问题给建议, 不要无端推翻用户的创意
- 建议要具体、可执行, 不要空话
- 只输出 JSON
"""


def build_suggest_prompt(
    *,
    origin: dict,
    draft: dict,
    scope: str = "overall",
    changed_field: str | None = None,
) -> str:
    """scope='field' 时聚焦某字段的即时建议; 'overall' 时做整体统一检查。"""
    focus_block = ""
    if scope == "field" and changed_field:
        focus_block = (
            f"# 本次关注\n用户刚刚修改了「{changed_field}」, "
            "请优先围绕这一改动给出连带建议。\n\n"
        )
    return SUGGEST_PROMPT.format(
        origin_json=json.dumps(origin, ensure_ascii=False, indent=2),
        draft_json=json.dumps(draft, ensure_ascii=False, indent=2),
        focus_block=focus_block,
    )


# ===========================================================================
# 2.5 一键生成全套改编设定
# ===========================================================================

PROPOSE_PROMPT = """你是资深短剧改编策划。下面是一部原作的「原作蓝图」。
请基于它生成**一套全新的、自洽的改编设定**, 与原作明显区分开, 但保留原作的
戏剧骨架与情绪张力。

# 原作蓝图
{origin_json}

{guidance_block}
# 题材选择(重要硬约束)
新设定的时代背景**必须**从下列主流短剧题材中挑选, 选最贴合原作戏剧内核的一个:
- 现代都市(豪门恩怨/商战/职场/都市情感/婚姻家庭)
- 穿越/重生(穿越古代、重生改命、回到过去)
- 架空古代/古装(架空王朝宫廷、古风宅斗、江湖恩怨)
- 民国(民国大家族、乱世情缘)
- 校园青春(校园、初恋、青春成长)
- 仙侠玄幻(修仙、宗门、神魔)——仅当原作本身就偏奇幻时才选

**严禁**生成赛博朋克、未来科技、末世废土、星际科幻、人工智能、虚拟世界等小众/科技向题材——
这些不符合目标受众(大众短剧观众)的口味。优先选用观众一眼就懂、代入门槛低的题材。
若用户在改编意向里另有指定, 以用户意向为准。

# 改编前提检验(动手换皮之前先做)
原作里的每一个关键情节, 都依赖它那个世界的**权力结构、法律制度、证据形式与可用资源**。
换时代/职业之后, 这些前提**不一定还成立** —— 直接照搬会得到"场景换了、因果还是旧时代的"违和。
所以先逐条问自己: 这个行为在新世界里, 谁有权做? 靠什么证据成立? 人物手上有没有这个资源?
- 成立 → 照搬其功能。
- 不成立 → **改变实现方法, 但保留它兑现的情绪**(如"当众拿出亲子鉴定"在
  无法做鉴定的世界设定里, 换成"请出唯一在场的接生婆作证")。
原则: **保留情绪兑现, 允许改变实现方法。**

# 任务
产出一份与原作结构一一对应、但"换了一层皮"的新设定:
- 人名全部换新(贴合新时代/新关系, 用符合该题材的常见中文姓名)
- 人际关系可整体改写(如 婆媳→姐妹、上下级→竞争对手), 并保证称呼、辈分、动机链自洽
- 时代背景从上述主流题材中选取, 地点、中心矛盾整体焕新, 但戏剧张力强度与原作相当
- **情绪功能等价**优先于位置机械相同: 原作的关键情绪承诺(羞辱→反击、误会→澄清、
  失去→夺回等)必须在改编版得到合理兑现。因时代、职业、关系变化导致**必要的前因重排**
  是允许的 —— 高潮可以在更早或更晚的位置, 只要新前因铺得够、不提前透支、不无故拖延。
  ⚠️ 但**用户明确锁定的事件顺序必须保留**, 不得以"改编自由"为由调换。
- 情绪节拍数量与原作保持一致, 逐拍对应其戏剧功能(不要求逐镜逐句复制)。

# 输出(严格 JSON, 结构与原作蓝图完全一致, 不要 Markdown 包装, 不要解释文字)
{{
  "title": "新作标题",
  "logline": "一句话主线",
  "era": "新时代背景",
  "locations": ["新地点1","新地点2"],
  "central_conflict": "新中心矛盾",
  "characters": [{{"name":"新名","role":"定位","persona":"性格与动机"}}],
  "relations": [{{"a":"角色A","b":"角色B","relation":"新关系","tension":"张力来源"}}],
  "emotion_beats": [{{"stage":"开端/发展/高潮/结局","beat":"情绪节拍","note":"改编后承载剧情"}}]
}}

# 必须满足
- characters 数量与原作一致, 顺序与原作对应(第 i 个新角色 = 原作第 i 个角色的改编)
- emotion_beats 数量与原作一致, 逐拍对应
- 只输出 JSON
"""


def build_propose_prompt(*, origin: dict, guidance: str = "") -> str:
    guidance_block = ""
    g = (guidance or "").strip()
    if g:
        guidance_block = (
            "# 用户改编意向(硬约束, 优先满足)\n"
            f"{g}\n\n"
        )
    return PROPOSE_PROMPT.format(
        origin_json=json.dumps(origin or {}, ensure_ascii=False, indent=2),
        guidance_block=guidance_block,
    )


# ===========================================================================
# 3. 大纲改编
# ===========================================================================

OUTLINE_ADAPT_PROMPT = """你是资深短剧改编编剧。请把原作大纲按「改编合同」改写成新作大纲。

# 改编合同(必须严格遵循的硬约束)
{contract_block}

# 原作分集大纲(第 {start_order}~{end_order} 集)
{origin_chunk}

# 改编铁律
1. **保留剧情骨架与情绪节拍**: 每集承担的功能(铺垫/冲突/反转/情感点)应贴合原作,
   情绪强度曲线大体对应原作 —— 这是改编质量的核心。
   ⚠️ **但不要求每个小节点都落在同一位置**: 时代、职业、关系变化会让高潮需要不同的
   铺垫长度, 合理重排前因是允许的, 只要情绪承诺最终被兑现。
   用户锁定的事件顺序、角色命运与结局**不得改变**。
2. **改编前提检验**: 先检查新世界里的权力、法律、证据形式与人物可用资源,
   再决定这一集的具体行为是否还成立。不成立时, **换一种功能等价的行为**,
   保留它兑现的情绪, 而不是硬搬旧世界的机制。
3. **替换表层设定**: 按合同替换人名、人际关系、时代、地点、中心矛盾等; 称呼、动机、场景、
   职业等连带要素必须同步改到位, 不能出现"换了关系却没换称呼"的违和。
4. **逻辑自洽**: 新设定下每一集的因果链必须成立; 若原作某情节在新设定下不合理, 在保持
   "相同情绪功能"的前提下重新设计该情节, 而不是生硬照搬。
5. **人名一致**: 严格使用合同里 name_map 的新名字, 全程不得回退到原名。

# 输出格式(严格 JSON 数组, 不要 Markdown 包装、不要解释文字)
[
  {{
    "order": {start_order},
    "title": "改编后本集标题(20字内)",
    "synopsis": "改编后本集 100-200 字概要, 推动主线, 体现新设定",
    "must_have": ["本集必须保留的关键情绪节拍/事件(改编后版本)"],
    "characters": ["本集涉及的新角色姓名"],
    "core_push": "本集唯一核心推进点(一句话)",
    "value_shift": {{"from": "本集开始时主角的处境/认知", "to": "本集结束时变成了什么"}},
    "stakes": "本集失败会失去什么(具体到身份/资格/亲情/自由/传承/机会/信任/性命)",
    "hook_in": {{"responds_to": "如何承接上一集结尾卡点", "mode": "直接延续|间接关联|有意延迟"}},
    "hook_out": {{"type": "突然揭示|紧急危机|未完成动作|身份反转|两难选择|神秘线索|时间限制|承诺威胁|离奇消失|言外之意", "strength": "好奇|关切|迫切|生存|终极", "leads_to": "它直接引发下一集发生什么"}},
    "escalation": "本集在哪个维度实质推进了主线(行动/关系/信息/资源/地位/情绪债务,允许阶段性胜利或局部降温)",
    "plant": ["本集埋下的伏笔(改编后)"], "payoff": ["本集回收的伏笔(须是前文埋过的)"],
    "forbidden": ["本集明确禁止发生的事"],
    "audience_knows_delta": "本集结束时观众新知道了什么",
    "char_knows_delta": {{"新角色名": "该角色本集结束时新知道了什么"}}
  }}
]

# 戏剧契约字段要求
- **契约必须与原作对应集同构**: 原作第 N 集的价值转变/失败代价/钩子功能是什么,
  改编后第 N 集就要保留同样的功能(换了设定, 但戏剧作用不变)——这是"保留情绪节拍"的落地。
- 原作大纲里若已带 core_push/value_shift/stakes/hook_out 等字段(见上方原作大纲),
  **以它为蓝本改写**, 不要凭空另设计一套。
- value_shift 的 from 与 to 必须不同; stakes 必须具体, 禁止"丢脸/大家会失望"这类空泛后果。
- hook_out 是本集最后一个悬念, leads_to 要能直接引发下一集; 禁止弱卡点
  ("若有所思""更大的危机正在靠近""一切才刚刚开始")。

# 必须满足
- 数组正好 {chunk_count} 项, order 从 {start_order} 连续递增到 {end_order}
- characters 使用改编后的新名字
- 只输出 JSON 数组

# 语言与文风(最高优先级, 必须遵守)
- **全部字段一律使用简体中文**。禁止出现英文句子或外语原文; 确需保留的专名要同时给中文称呼。
- 标题必须是中文短剧风格的标题, 不要英文标题或"第N集: English Title"混排。
- 不要出现欧美剧结构术语(救猫咪/B故事线/第三幕/人物弧光/节拍表),
  直接用中文短剧说法(开场钩子/副线/后段/人物转变/剧情节点)。
- 不要翻译腔: "这是一个关于…的故事""内心世界被触动""经历了一段旅程"都要改写成人话。
"""


def build_contract_block(contract: dict) -> str:
    """把改编合同渲染成给 LLM 的硬约束文本。"""
    c = contract or {}
    blocks: list[str] = []

    blocks.append(f"新作标题: {c.get('title') or '(沿用原作或自拟)'}")
    if c.get("era"):
        blocks.append(f"时代背景: {c['era']}")
    locs = c.get("locations") or []
    if locs:
        blocks.append(f"主要地点: {', '.join(locs)}")
    if c.get("central_conflict"):
        blocks.append(f"中心矛盾: {c['central_conflict']}")

    name_map = c.get("name_map") or {}
    if name_map:
        blocks.append("\n人名映射(旧→新, 全程严格使用新名):")
        for old, new in name_map.items():
            blocks.append(f"  - {old} → {new}")

    relations = c.get("relations") or []
    if relations:
        blocks.append("\n人际关系(改编后):")
        for r in relations:
            line = f"  - {r.get('a','')} 与 {r.get('b','')}: {r.get('relation','')}"
            if r.get("motive") or r.get("tension"):
                line += f" (张力: {r.get('motive') or r.get('tension')})"
            blocks.append(line)

    chars = c.get("characters") or []
    if chars:
        blocks.append("\n角色设定(改编后):")
        for ch in chars[:12]:
            blocks.append(
                f"  - {ch.get('name','')} ({ch.get('role','')}): {ch.get('persona','')}"
            )

    beats = c.get("emotion_beats") or []
    if beats:
        blocks.append("\n情绪曲线节拍(必须贴合, 按顺序):")
        for b in beats:
            blocks.append(
                f"  - [{b.get('stage','')}] {b.get('beat','')}: {b.get('note','')}"
            )

    if (c.get("guidance") or "").strip():
        blocks.append(f"\n改编总纲(用户自由指令, 硬约束):\n{c['guidance'].strip()}")

    return "\n".join(blocks)


def build_origin_chunk_block(origin_chapters: list[dict]) -> str:
    lines: list[str] = []
    for c in origin_chapters:
        lines.append(
            f"- 第{c.get('order')}集 「{c.get('title','')}」: {c.get('synopsis','')}"
        )
        mh = c.get("must_have") or []
        if mh:
            lines.append(f"  关键点: {'; '.join(str(x) for x in mh)}")
        # 原作的戏剧契约要一并给出，作为改编的蓝本（保留情绪节拍 = 保留戏剧功能）
        vs = c.get("value_shift") or {}
        if str(vs.get("from") or "").strip() or str(vs.get("to") or "").strip():
            lines.append(f"  价值转变: {vs.get('from','')} → {vs.get('to','')}")
        if str(c.get("stakes") or "").strip():
            lines.append(f"  失败代价: {c['stakes']}")
        ho = c.get("hook_out") or {}
        if str(ho.get("type") or "").strip() or str(ho.get("leads_to") or "").strip():
            lines.append(f"  结尾卡点: {ho.get('type','')} / {ho.get('strength','')} → {ho.get('leads_to','')}")
        if str(c.get("escalation") or "").strip():
            lines.append(f"  升级点: {c['escalation']}")
        for key, label in (("plant", "埋伏笔"), ("payoff", "收伏笔")):
            v = c.get(key) or []
            if v:
                lines.append(f"  {label}: {'; '.join(str(x) for x in v)}")
    return "\n".join(lines)


def build_outline_adapt_prompt(
    *,
    contract: dict,
    origin_chapters: list[dict],
    start_order: int,
    end_order: int,
) -> str:
    chunk_count = end_order - start_order + 1
    return OUTLINE_ADAPT_PROMPT.format(
        contract_block=build_contract_block(contract),
        origin_chunk=build_origin_chunk_block(origin_chapters),
        start_order=start_order,
        end_order=end_order,
        chunk_count=chunk_count,
    )


# ===========================================================================
# 4. 逐集正文仿写 (高度相似改编)
# ===========================================================================

CHAPTER_IMITATION_PROMPT = """你是资深短剧改编编剧。请把下面这一集的原作正文, 按「改编合同」做
**高度相似的换皮仿写**: 严格沿用原文的场次顺序、段落结构、篇幅长度、对白节奏与桥段密度,
只把表层设定(人名/人际关系/时代/地点/中心矛盾)按合同替换, 不要重新编故事。

# 改编合同(硬约束, 全程严格遵守)
{contract_block}

# 本集元信息
- 集号: 第 {order} 集
- 改编后标题: {title}

# 原作正文(仿写模板, 必须逐场对应)
{origin_text}

# 仿写铁律
1. **结构 1:1 对齐**: 原文有几场戏、什么顺序、各场多长, 仿写必须一一对应, 不增删场次、不改顺序。
2. **逐句换皮**: 按 name_map 替换所有人名; 按 relations 调整称呼/辈分/动机用语; 按时代/地点
   替换职业、场景、道具、口头禅等表层元素。原文每一段都要有对应的改写段。
3. **保留肌理**: 对白长度、叙述/对白比例、情绪起伏的位置与强度, 都要贴合原文。
4. **只换皮不重写**: 除非某设定在新背景下完全不成立, 否则不要改动情节走向; 即便要改, 也只在
   该处做最小调整, 保持与原文相同的篇幅和功能。
5. **人名一致**: 全程只用 name_map 的新名, 不得出现原名。
6. **篇幅相当**: 仿写正文字数应与原文基本持平(±15%以内)。

# 输出
直接输出改编后的本集正文(纯文本, 与原文同样的分段/对白格式), 不要任何解释、不要 JSON、不要标题。
"""


def build_chapter_imitation_prompt(
    *,
    contract: dict,
    order: int,
    title: str,
    origin_text: str,
) -> str:
    return CHAPTER_IMITATION_PROMPT.format(
        contract_block=build_contract_block(contract),
        order=order,
        title=title or f"第{order}集",
        origin_text=origin_text or "",
    )


# ===========================================================================
# 5. 逐集剧本(分镜)仿写 — 关联原作剧本, 高度相似换皮
# ===========================================================================

STORYBOARD_IMITATION_PROMPT = """你是资深短剧分镜师。下面是原作某一集的**剧本(分镜表)**, 请按
「改编合同」转成改编后该集的分镜表。

# 改编强度(默认第二档)
- **严格复刻**(仅当用户明确要求逐镜对齐时): 场次数、镜头数、顺序、景别与节奏一一对应。
- **情节同构**(默认): 保留核心事件、动作目的、情绪位置与重要结果;
  允许因时代、地点、关系、制作条件而**改变镜头数量、场次拆分与台词长度**。
  这仍然不是"另写一集" —— 情节功能必须对得上, 只是承载它的镜头组织可以不同。
- **自由改编**(仅当用户明确指定时): 只保留情绪承诺与人物选择, 场面可重新设计。

⚠️ 不要因为"换了时代"就把情节也换掉; 也不要因为"要忠实"就逐镜硬搬
在新世界里根本不成立的场面。**判据是情节功能, 不是镜头编号。**

# 改编合同(硬约束, 全程严格遵守)
{contract_block}

# 本集元信息
- 集号: 第 {order} 集
- 改编后标题: {title}

# 原作剧本(改编蓝本, 按上方档位对应)
{origin_storyboard}

# 仿写铁律
1. **核心事件与情绪位置对齐**: 原作承担了哪些情节功能、情绪落点在哪几拍, 改编版要对应上。
   默认档位下, 场次数与镜头数**可以**变化; 只有用户明确选了"严格复刻"才要求 1:1。
2. **逐句换皮**: 动作描述(action)、台词(dialogue)里的人名按 name_map 全部替换;
   称呼/辈分/动机用语按 relations 调整; 场景(time_loc/location)、职业、道具按时代/地点替换。
3. **保留肌理**: 每场镜头数、台词长度、动作密度、情绪强度位置都贴合原作。
4. **不重编剧情**: 不新增或删除**核心事件**, 不改变每个镜头的叙事功能(建立/推进/反应/落点)。
5. **人名一致**: 全程只用 name_map 的新名, 不得出现原名。
6. **新世界前提成立**: 每个动作、道具、证据形式都要在新世界的资源与社会规则下说得通;
   只把名词换掉、却原样移植旧时代因果的, 必须重做。

# 输出格式(严格 JSON 数组, 不要 Markdown 包装、不要解释文字)
每个场景对象:
[
  {{
    "scene_no": "1-1",
    "time_loc": "日 / 内 / 场景地点",
    "characters": ["出场新角色名"],
    "subtitle": "",
    "is_flashback": false,
    "elements": [
      {{"type":"action","content":"动作/场景描述(已换皮)"}},
      {{"type":"dialogue","character":"新角色名","mode":"","action":"","content":"台词(已换皮)"}}
    ]
  }}
]

# 必须满足
- 默认(情节同构)档位: scene 数量可以变化, 但每个核心事件与情绪落点都有对应镜头
- 严格复刻档位: scene 数量、每个 scene 的 elements 数量与原作对应集一致
- 只输出 JSON 数组
"""


def render_origin_storyboard(shots: list) -> str:
    """把原作 shots_json 渲染成可读文本, 作为仿写模板喂给模型。"""
    if not isinstance(shots, list) or not shots:
        return "(原作该集无剧本数据)"
    lines: list[str] = []
    for i, s in enumerate(shots):
        if not isinstance(s, dict):
            continue
        scene_no = s.get("scene_no") or s.get("shot_no") or (i + 1)
        time_loc = s.get("time_loc") or s.get("location") or ""
        chars = "、".join(s.get("characters") or [])
        lines.append(f"【场景 {scene_no}】{time_loc}" + (f" 出场:{chars}" if chars else ""))
        elements = s.get("elements") or []
        if elements:
            for e in elements:
                if not isinstance(e, dict):
                    continue
                if e.get("type") == "action":
                    c = (e.get("content") or "").strip()
                    if c:
                        lines.append(f"  △ {c}")
                elif e.get("type") == "dialogue":
                    nm = (e.get("character") or "").strip()
                    mode = (e.get("mode") or "").strip()
                    content = (e.get("content") or "").strip()
                    if content:
                        lines.append(f"  {nm}{f'({mode})' if mode else ''}: {content}")
        else:
            # 旧格式 action/dialogue 字段
            act = (s.get("action") or "").strip()
            dlg = (s.get("dialogue") or "").strip()
            if act:
                lines.append(f"  △ {act}")
            if dlg:
                lines.append(f"  {dlg}")
    return "\n".join(lines)


def build_storyboard_imitation_prompt(
    *,
    contract: dict,
    order: int,
    title: str,
    origin_shots: list,
) -> str:
    return STORYBOARD_IMITATION_PROMPT.format(
        contract_block=build_contract_block(contract),
        order=order,
        title=title or f"第{order}集",
        origin_storyboard=render_origin_storyboard(origin_shots),
    )


def normalize_adapted_chapters(
    raw: list,
    *,
    start_order: int,
    end_order: int,
    origin_chapters: list[dict],
) -> list[dict]:
    """规范化 LLM 返回的改编大纲, 强制 order 连续; 不足用原作对应集占位兜底。

    🔴 2026-10-18: 原先只保留 order/title/synopsis/must_have/characters 五个键,
    提示词要求模型输出的 11 个戏剧契约字段(core_push/stakes/hook_out…)全部被丢掉。
    后果: 改编草稿下游生成剧本时没有契约可注入(只能凭一句梗概自由发挥),
    结构门禁也在缺字段的大纲上跑, 对改编草稿基本没在检查。
    与 2026-10-09 修过的"重新生成此集丢契约"是同一类问题。
    现在: 契约字段按 outline_fields 的形状规则逐字段收下, 形状不对只丢该字段。

    另修: 原先 order 用数组下标算, 非 dict 元素被 continue 跳过但下标照样递增,
    后面补位又用 len(items) 算 order → 可能产生重复集号。现在按"已产出条数"编号。
    """
    from .outline_fields import pick_contract

    expected = end_order - start_order + 1
    origin_by_order = {int(c.get("order") or 0): c for c in origin_chapters}
    items: list[dict] = []
    if isinstance(raw, list):
        for item in raw:
            if len(items) >= expected:
                break
            if not isinstance(item, dict):
                continue
            order = start_order + len(items)
            items.append({
                "order": order,
                "title": str(item.get("title", "")).strip() or f"第{order}集",
                "synopsis": str(item.get("synopsis", "")).strip(),
                "must_have": list(item.get("must_have") or []),
                "characters": list(item.get("characters") or []),
                **pick_contract(item),
            })
    while len(items) < expected:
        idx = len(items)
        order = start_order + idx
        src = origin_by_order.get(order, {})
        items.append({
            "order": order,
            "title": str(src.get("title", "") or f"第{order}集"),
            "synopsis": "(改编输出不足, 请用'重新生成此集'补全)",
            "must_have": list(src.get("must_have") or []),
            "characters": [],
        })
    return items


__all__ = [
    "build_source_block",
    "build_analyze_prompt",
    "build_suggest_prompt",
    "build_propose_prompt",
    "build_contract_block",
    "build_outline_adapt_prompt",
    "build_chapter_imitation_prompt",
    "build_storyboard_imitation_prompt",
    "render_origin_storyboard",
    "normalize_adapted_chapters",
]
