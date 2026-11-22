"""续写功能 — 三级上下文构造 + 大纲扩写 prompt。

档位策略 (按已锁定章节总字数):
  L1 全文档 (≤ 80,000 字): 前 N 集完整正文
  L2 摘要档 (80,000–400,000 字): 每集 summary + 最近 3 集完整正文
  L3 高度压缩档 (≥ 400,000 字): 大纲 + 每 5 集合并事件块 + 最近 2 集 + 人物状态卡
"""
from __future__ import annotations

import json
from typing import Literal

ContextLevel = Literal["L1", "L2", "L3"]

# 档位阈值(字数)
L1_MAX_CHARS = 80_000
L2_MAX_CHARS = 400_000


def detect_context_level(total_chars: int) -> ContextLevel:
    """根据已锁定章节总字数自动选档"""
    if total_chars <= L1_MAX_CHARS:
        return "L1"
    if total_chars <= L2_MAX_CHARS:
        return "L2"
    return "L3"


def build_context_for_extension(
    *,
    level: ContextLevel,
    outline: dict,
    locked_chapters: list[dict],
    include_planned_outline: bool = False,
) -> str:
    """构造续写大纲扩写时的前序剧情块。

    locked_chapters 按 chapter_order 升序传入, 每项至少含:
      { chapter_order, title, summary, full_text, word_count }

    无论档位高低, 都会在最前面注入"角色花名册"与"角色设定"(若 outline 中存在),
    作为续写的常驻硬约束, 防止角色名漂移与人设/立场漂移。

    include_planned_outline: True 时额外注入"已确定的后续分集大纲"(已锁定集之后、
    outline.chapters 中已存在的集) — 含用户自备集纲和前批 LLM 产出。
    空缺集的扩写必须与这些已确定的集保持剧情连贯(例: 第 21 集要承接第 20 集
    集纲的剧情, 而不是承接第 10 集正文)。
    """
    blocks: list[str] = []

    # 角色一致性锚点 (常驻注入, 不受 L1/L2/L3 档位影响)
    try:
        from .character_extract import build_registry_block, build_bible_block
        reg_block = build_registry_block(outline.get("character_registry") or {})
        bible_block = build_bible_block(outline.get("character_bible") or {})
        if reg_block:
            blocks.append(reg_block)
        if bible_block:
            blocks.append(bible_block)
    except Exception:
        pass

    # 头部: 全剧基本信息(三档共享)
    title = outline.get("title", "")
    synopsis = outline.get("synopsis", "")
    world = outline.get("world") or {}
    chars = outline.get("characters") or []

    blocks.append("# 全剧基本信息")
    if title:
        blocks.append(f"标题: {title}")
    if synopsis:
        blocks.append(f"主线: {synopsis}")
    if world:
        era = world.get("era", "")
        setting = world.get("setting", "")
        if era or setting:
            blocks.append(f"世界观: {era} | {setting}")
        rules = world.get("rules") or []
        if rules:
            blocks.append("世界观规则:\n  - " + "\n  - ".join(str(r) for r in rules))

    # 人物表 (三档都需要,L3 会再额外补人物状态卡)
    if chars:
        blocks.append("\n# 现有人物表")
        for c in chars:
            name = c.get("name", "")
            role = c.get("role", "")
            traits = "/".join(c.get("traits") or [])
            appearance = c.get("appearance", "")
            line = f"- {name} ({role})"
            if traits:
                line += f" · 性格: {traits}"
            if appearance:
                line += f" · 外貌: {appearance}"
            blocks.append(line)

    # 已有大纲的概览(三档共享, 但只展示已锁定的部分)
    locked_orders = {c["chapter_order"] for c in locked_chapters}
    outline_chapters = outline.get("chapters") or []
    locked_outline = [c for c in outline_chapters if c.get("order") in locked_orders]
    if locked_outline:
        blocks.append("\n# 已有大纲(已锁定的部分)")
        for c in locked_outline:
            blocks.append(f"- 第{c.get('order')}集 「{c.get('title','')}」: {c.get('synopsis','')}")

    # 按档位填充剧情主体
    if level == "L1":
        blocks.append("\n# 已写就的全部正文 (前 {} 集完整正文)".format(len(locked_chapters)))
        for ch in locked_chapters:
            blocks.append(f"\n## 第{ch['chapter_order']}集 「{ch.get('title','')}」")
            blocks.append((ch.get("full_text") or "").strip())

    elif level == "L2":
        blocks.append("\n# 已写就的剧情概览 (每集摘要)")
        last_n = 3
        head_chapters = locked_chapters[:-last_n] if len(locked_chapters) > last_n else []
        tail_chapters = locked_chapters[-last_n:]
        for ch in head_chapters:
            blocks.append(
                f"- 第{ch['chapter_order']}集 「{ch.get('title','')}」({ch.get('word_count',0)} 字): "
                f"{_episode_digest(ch)}"
            )
        if tail_chapters:
            blocks.append(f"\n# 最近 {len(tail_chapters)} 集完整正文 (用于无缝衔接)")
            for ch in tail_chapters:
                blocks.append(f"\n## 第{ch['chapter_order']}集 「{ch.get('title','')}」")
                blocks.append((ch.get("full_text") or "").strip())

    else:  # L3
        # L3: 大纲 + 每 5 集合并 + 最近 2 集完整 + 人物状态卡 + 未结伏笔
        last_n = 2
        head_chapters = locked_chapters[:-last_n] if len(locked_chapters) > last_n else []
        tail_chapters = locked_chapters[-last_n:]

        # 5 集合并 (按 chapter_order 分组)
        if head_chapters:
            blocks.append("\n# 已写就的剧情时间线 (每 5 集合并)")
            cluster: list[dict] = []
            for ch in head_chapters:
                cluster.append(ch)
                if len(cluster) == 5:
                    _emit_cluster(blocks, cluster)
                    cluster = []
            if cluster:
                _emit_cluster(blocks, cluster)

        if tail_chapters:
            blocks.append(f"\n# 最近 {len(tail_chapters)} 集完整正文")
            for ch in tail_chapters:
                blocks.append(f"\n## 第{ch['chapter_order']}集 「{ch.get('title','')}」")
                blocks.append((ch.get("full_text") or "").strip())

    # 已确定的后续分集大纲 (用户集纲 + 前批扩写产出): 空缺集必须与之衔接
    if include_planned_outline:
        max_locked = max((c["chapter_order"] for c in locked_chapters), default=0)
        planned = [
            c for c in (outline.get("chapters") or [])
            if int(c.get("order") or 0) > max_locked and (c.get("synopsis") or "").strip()
        ]
        planned.sort(key=lambda x: int(x.get("order") or 0))
        if planned:
            blocks.append(
                "\n# 已确定的后续分集大纲 (硬约束: 你为空缺集写的大纲必须与这些集的剧情无缝衔接、不得矛盾)"
            )
            for c in planned:
                src = " [用户提供]" if c.get("source") == "user_episode_outline" else ""
                blocks.append(f"- 第{c.get('order')}集 「{c.get('title','')}」{src}: {c.get('synopsis','')}")

    return "\n".join(blocks)


def _episode_digest(ch: dict) -> str:
    """续写时，一集的"概要"那一行显示什么。

    ⚠️ 2026-10-10：原来直接读 `summary`，空就写「(暂无摘要)」。
    两个问题：
      1. **假摘要会被当成真摘要**（库里 2319 章是正文前 500 字截断）——
         模型以为整集只讲了开头那些事；
      2. 空摘要写「暂无摘要」等于**告诉模型这一集空白**，它就会自己编。

    现在走统一口径：假摘要自动越过、空则退回原文（按预算裁剪），
    实在没有才回落到大纲梗概。**永不返回"暂无"这类空话。**
    """
    from .episode_text import pick_episode_text
    order = int(ch.get("chapter_order") or 0)
    text, _form = pick_episode_text(
        {"order": order}, ch, purpose="overview", budget_chars=600)
    return (text or "").strip() or "(本集暂无内容)"


def _emit_cluster(blocks: list[str], cluster: list[dict]) -> None:
    """把一批章节合并成一个事件块"""
    if not cluster:
        return
    first = cluster[0]["chapter_order"]
    last = cluster[-1]["chapter_order"]
    summaries = []
    for ch in cluster:
        s = _episode_digest(ch)
        if s:
            summaries.append(f"  · 第{ch['chapter_order']}集: {s}")
    if not summaries:
        summaries.append("  (本段集数暂无摘要)")
    blocks.append(f"\n## 第{first}-{last}集")
    blocks.extend(summaries)


# ===========================================================================
# 大纲扩写 Prompt
# ===========================================================================

OUTLINE_EXTEND_PROMPT = """你是资深短剧编剧总策划。现在需要你**续写**一个已经存在的剧本大纲。

{prior_context}
{user_guidance_block}
# 任务
请基于上述全部已知信息,为第 {start_order} 集到第 {end_order} 集设计**新的大纲**(共 {chunk_count} 集)。
最终目标是把这部剧扩写到 {target_total} 集 (当前已有 {locked_count} 集)。

# 续写硬性要求
1. **严格承接已有剧情**: 已经发生的事件、人物状态、世界观规则不能矛盾。
2. **保持人物连续性**: 不能凭空让"已死亡"的角色复活, 不能让"已离开"的角色突然出现而无解释。
3. **可以引入新角色/新冲突**, 但必须服务于主线推进。
4. **节奏要求**(短剧风格):
   - 每集都要有**明确的推进**: 行动结果、关系变化、认知更新、局部胜利、反制或代价,
     至少占其一。推进不等于"每集固定一个新事故"。
   - 按**故事容量与阶段功能**安排高潮: 先看现有剧情还剩多少可兑现的主线目标、
     人物关系和情绪承诺, 再决定转折放在哪几集。
     ⚠️ **不要按"每 5 集中冲突、每 10 集大转折"这种固定频率制造事件** ——
     那会写出没有因果铺垫的反派升级和突发事故。
5. **撑住篇幅**: 距离最终目标 {target_total} 集还有 {remaining_after} 集, 不要把所有牌一次性打完。
   ⚠️ 但**集数是篇幅要求, 不是凑数指标**: 不能为了填满集数, 把一个本该做完的决定
   拆成好几集重复对话。真到了"没有新内容可写"的地步, 应该从**原核心矛盾**里
   引出新的策略层级或新的阻力, 而不是注水。
6. **must_have 要具体**: 不要写"主角发挥能力", 要写"主角识破假身份"这类**具体、可演**的事件。
7. **遵循用户走向**: 如果上方提供了"用户期望剧情走向", 你必须把它当作必须满足的硬约束 — 在确保不与已有剧情矛盾的前提下, 把用户提到的关键节点/反转/收束方式落实到对应集数的 synopsis 和 must_have 里。

# 输出格式 (严格 JSON 数组,不要 Markdown 包装、不要解释文字)
[
  {{
    "order": {start_order},
    "title": "本集标题(限 20 字内)",
    "synopsis": "本集 100-200 字概要,必须推动主线",
    "beats": [
      {{"at": "地点+时间", "who": "本拍在场人物", "action": "发生了什么(能被拍出来的动作/台词)", "turn": "这一拍结束时局面变成了什么"}}
    ],
    "must_have": ["具体事件 1", "具体事件 2"],
    "characters": ["本集涉及的角色姓名"],
    "core_push": "本集唯一核心推进点(一句话,本集所有事件都服务它)",
    "value_shift": {{"from": "本集开始时主角的处境/认知", "to": "本集结束时变成了什么"}},
    "stakes": "本集失败会失去什么(必须具体到身份/资格/亲情/自由/传承/机会/信任/性命,禁止'丢脸''大家会失望')",
    "hook_in": {{"responds_to": "如何承接上一集结尾卡点", "mode": "直接延续|间接关联|有意延迟"}},
    "hook_out": {{"type": "突然揭示|紧急危机|未完成动作|身份反转|两难选择|神秘线索|时间限制|承诺威胁|离奇消失|言外之意", "strength": "好奇|关切|迫切|生存|终极", "leads_to": "它直接引发下一集发生什么"}},
    "escalation": "本集在哪个维度实质推进了主线(行动/关系/信息/资源/地位/情绪债务,允许阶段性胜利或局部降温)",
    "plant": ["本集埋下的伏笔"], "payoff": ["本集回收的伏笔(须是前文埋过的)"],
    "forbidden": ["本集明确禁止发生的事"],
    "audience_knows_delta": "本集结束时观众新知道了什么",
    "char_knows_delta": {{"角色名": "该角色本集结束时新知道了什么"}},
    "emotion_intensity": 7,
    "power": {{"aggressor": "本集主动推进/施压的人", "defender": "本集被推着走/守的人", "focus": "两人争的是什么(一句话)"}}
  }},
  ...
]

# 戏剧契约字段要求(与大纲生成一致, 缺一不合格)
- value_shift 的 from 与 to 必须不同; 只是换场景不算转变。
- stakes 必须具体, 禁止"丢脸/大家会失望/名声受损"这类空泛后果。
- hook_out 必须是本集**最后一个**悬念, leads_to 要能直接引发下一集核心事件。
  禁止弱卡点:"若有所思""更大的危机正在靠近""一切才刚刚开始""意味深长的笑"。
- **hook_out 要推进观看问题**: 允许连续使用同类钩子, 只要每次产生新的事实、选项、
  代价或关系变化。禁止的是**换一种说法重复同一个未兑现的问题**。
- **escalation 表达实质推进**: 本集在行动/关系/信息/资源/地位/情绪债务里, 至少一个维度
  发生了不可逆的变化即可。**允许停顿、阶段性胜利或局部降温** —— 不要求每集危险级别单调上升。
- 上一集的 hook_out.leads_to 必须是本集核心事件(钩子链不能断)。
- **emotion_intensity 是 1-10 的整数**(本集情绪峰值): 1-3 平铺直叙;
  4-6 有明显起伏; 7-8 强冲突或强反转; 9-10 全集顶点。要与 synopsis 对得上。
- **power 是本集的权力关系**: aggressor 主动施压的人, defender 承受的人,
  focus 两人争的**具体那件事**(不是"公司控制权"这种抽象概念)。
- 续写的新集要与**已锁定集**的出口钩衔接: 第 {start_order} 集的 hook_in
  必须承接第 {start_order_minus_1} 集留下的卡点。

# 必须满足
- 数组**正好 {chunk_count} 项**
- order **从 {start_order} 连续递增到 {end_order}**, 不能跳过
- 每项的 characters 中提到的人名必须在"现有人物表"里(若需新人物,在 synopsis 中说明,但不要直接放进 characters 数组)
- 输出**只包含 JSON 数组**,前后不要有任何其他文字

# 语言与文风(最高优先级, 必须遵守)
- **全部字段一律使用简体中文**。禁止出现英文单词、英文句子或外语原文
  (角色名/品牌名/专有名词如确需保留原文, 必须同时给出中文译名或中文称呼)。
- 剧集标题必须是**中文短剧风格**的标题, 不要英文标题、不要"第N集: Title"这种混排。
- synopsis/must_have 等描述性文字要像**中国编剧写给中国制片人看的**口语化中文,
  不要翻译腔(如"这个角色经历了一段旅程""她的内心世界被触动")。
- 不要出现欧美剧的桥段命名与结构术语(如"第三幕转折点""B故事线""救猫咪"等),
  直接写中国短剧观众熟悉的说法(如"打脸""反转""追妻火葬场""身份揭晓")。
"""


def build_outline_extend_prompt(
    *,
    prior_context: str,
    start_order: int,
    end_order: int,
    target_total: int,
    locked_count: int,
    user_guidance: str = "",
) -> str:
    """构造大纲扩写 prompt

    Args:
        user_guidance: 用户对剧情走向的期望(自然语言),为空则不注入。
    """
    chunk_count = end_order - start_order + 1
    remaining_after = target_total - end_order

    user_guidance_block = ""
    g = (user_guidance or "").strip()
    if g:
        user_guidance_block = (
            "\n# 用户期望剧情走向 (硬约束, 必须遵循)\n"
            "用户对续写部分提出了以下整体走向, 请把它视为写作纲领, "
            "在不破坏已有剧情连贯性的前提下逐集兑现:\n\n"
            f"{g}\n"
        )

    return OUTLINE_EXTEND_PROMPT.format(
        prior_context=prior_context,
        user_guidance_block=user_guidance_block,
        start_order=start_order,
        # 续写首集要承接的上一集(可能是已锁定集)。start_order=1 时不适用, 给占位说明。
        start_order_minus_1=(start_order - 1) if start_order > 1 else "上一集",
        end_order=end_order,
        chunk_count=chunk_count,
        target_total=target_total,
        locked_count=locked_count,
        remaining_after=remaining_after,
    )


def normalize_extended_chapters(
    raw: list,
    *,
    start_order: int,
    end_order: int,
) -> list[dict]:
    """把 LLM 返回的章节数组规范化, 强制 order 连续。

    LLM 偶尔会跳号或乱序, 这里强制按位置截断/补齐到 [start_order, end_order]。

    ⚠️ 关键: 必须保留**全部**集字段, 尤其是 D1 戏剧契约字段。原先这里用硬编码
    白名单只留 order/title/synopsis/must_have/characters, 导致续写产出的集静默丢掉
    契约 —— 后续剧情门禁把它们全判成"无契约", 结构诊断对续写部分完全失效。
    现在复用 outline_gen._norm_chapters 的统一归一逻辑(它已覆盖契约字段),
    并把提示词允许的额外字段(如 locked/version 等)一并透传。
    """
    from .outline_gen import _norm_chapters   # 局部导入避免模块级循环依赖

    expected = end_order - start_order + 1
    items: list[dict] = []

    if isinstance(raw, list):
        # 先用统一归一逻辑处理(含契约字段), 再强制 order 按位置排列
        normalized = _norm_chapters(
            [it for it in raw[:expected] if isinstance(it, dict)], start_order
        )
        for i, ep in enumerate(normalized):
            ep["order"] = start_order + i         # 强制位置(忽略 LLM 跳号)
            src = raw[i] if i < len(raw) and isinstance(raw[i], dict) else {}
            # 透传归一逻辑不认识的额外字段, 避免"顺手丢字段"的老毛病
            for k, v in src.items():
                if k not in ep and k != "order":
                    ep[k] = v
            items.append(ep)

    # 不足则用占位补齐(让用户后续手动补正或重生)
    from .outline_gen import empty_episode
    while len(items) < expected:
        idx = len(items)
        ph = empty_episode(start_order + idx)
        ph["synopsis"] = "(LLM 输出不足, 请用'重新生成此集'补全)"
        items.append(ph)
    return items


__all__ = [
    "ContextLevel",
    "L1_MAX_CHARS",
    "L2_MAX_CHARS",
    "detect_context_level",
    "build_context_for_extension",
    "build_outline_extend_prompt",
    "normalize_extended_chapters",
]
