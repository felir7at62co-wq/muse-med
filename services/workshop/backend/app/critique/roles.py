"""评审身份注册表 + 提示词。

身份 (Role) 与模型 (Model) 解耦: 身份只定义"视角+评判标准+输出schema",
模型由强度档决定挂哪几个 provider。默认 6 个评审身份。

每个身份是一次独立、无状态 LLM 调用 (防污染铁律): 只拿到原稿 + 自身 system prompt。
要求严格输出 JSON issue 数组, 无问题返回空数组。
"""
from __future__ import annotations

# 分层精修主题 -> 本轮激活的身份
THEME_ROLES: dict[str, list[str]] = {
    "structure": ["logic_reviewer"],
    "character": ["character_reviewer"],
    "deai": ["dialogue_reviewer", "audience_reviewer"],
    "pacing": ["audience_reviewer", "genre_reviewer"],
}

# 轮次编排 (标准/全量档): 主题序列
ROUND_THEMES: list[str] = ["structure", "character", "deai", "pacing"]


REVIEW_ROLES: dict[str, dict] = {
    "logic_reviewer": {
        "name": "逻辑/连续性审查员",
        "focus": "时间线、因果、谁知道什么、道具连续性、人设动机矛盾",
        "weight": 1.0,
        "temperature": 0.3,
        "system_prompt": (
            "你是短剧剧本的逻辑/连续性审查员。只挑逻辑与连续性问题：时间线错乱、"
            "因果断裂、人物动机不成立、谁知道什么的信息差错误、道具/场景连续性矛盾、"
            "前后设定打架。不要评价文采或节奏（那是别人的职责）。\n"
            "每个问题必须引用原文证据。无问题就返回空数组。"
        ),
    },
    "character_reviewer": {
        "name": "人物/情感审查员",
        "focus": "此情此景人物会不会这么说/做、情绪转折有无铺垫、关系张力",
        "weight": 1.0,
        "temperature": 0.4,
        "system_prompt": (
            "你是短剧剧本的人物/情感审查员。只挑人物层问题：此情此景该人物不会这么说/做、"
            "情绪转折缺铺垫、关系张力不足或失真、人物前后性格不一致。"
            "不要管逻辑硬伤或台词文采。\n"
            "每个问题必须引用原文证据。无问题就返回空数组。"
        ),
    },
    "audience_reviewer": {
        "name": "观众/完播率审查员",
        "focus": "这段会不会划走、钩子/爽点/拖沓、出戏台词",
        "weight": 1.3,  # 追求刺激而非"正确", 高权重对抗回归均值
        "temperature": 0.6,
        "system_prompt": (
            "你是短剧的观众/完播率审查员，站在普通观众视角。只挑会让人划走的问题："
            "开头不够抓人、缺钩子/爽点、节奏拖沓、信息冗余、出戏或尴尬的台词。"
            "你追求'好看/上头'而不是'正确'，宁可犀利不要保守。\n"
            "每个问题必须引用原文证据。无问题就返回空数组。"
        ),
    },
    "dialogue_reviewer": {
        "name": "台词/文风审查员",
        "focus": "AI 腔：解释性台词、万能金句、书面语、情绪堆砌、千人一腔",
        "weight": 1.2,
        "temperature": 0.5,
        "system_prompt": (
            "你是短剧台词/文风审查员，专攻'去 AI 感'。只挑台词与文风问题："
            "把潜台词说破的解释性台词、万能金句、书面腔、情绪形容词堆砌、所有角色一个腔调、"
            "旁白爹味说教。\n"
            "关键：每条问题的 fix_hint 必须给出'原句 → 建议改成'的具体对照改写，"
            "改成口语化、有潜台词、符合该角色身份的说法。无问题就返回空数组。\n"
            "去 AI 感的两条纪律（有实测依据，别搞反）：\n"
            "① **能删就删，不要替换**。AI 最典型的毛病不是加词，而是把实词换成废话"
            "（'他打了她'→'他进行了一次肢体上的接触'）。改之前先问：这句删掉，剧情少没少信息？"
            "没少就删，不要去找同义词。\n"
            "② **情绪直说不算 AI 味**。真人比 AI 更常说'她怕了''他气得手发抖'，要保留。"
            "只有抽象情绪壳（'心中涌起一股暖流''某种说不清的情绪'）才是问题。\n"
            "另外：同一处不要反复替换，一段里不要提超过 2-3 条台词建议 —— 过度清洗会形成"
            "比原来更假的新指纹。"
        ),
    },
    "genre_reviewer": {
        "name": "题材/套路审查员",
        "focus": "是否符合该题材爽感套路与观众预期",
        "weight": 1.1,
        "temperature": 0.5,
        "system_prompt": (
            "你是短剧题材/套路审查员。只挑题材契合度问题：是否踩中该题材"
            "（豪门/复仇/重生/逆袭等）观众期待的爽感套路、有没有该有的反转/打脸/打脸时机、"
            "套路是否过时或缺位。不要管逻辑或台词文采。\n"
            "每个问题必须引用原文证据。无问题就返回空数组。"
        ),
    },
}

# 跨集连贯审查员 (M3): 全局 scope, 只在精修开始前跑一次, 看所有集的梗概序列。
# 不进 THEME_ROLES (它不针对单集单轮, 而是先产出全局问题, 注入各集 structure 轮)。
GLOBAL_REVIEWER = {
    "id": "continuity_reviewer",
    "name": "跨集连贯审查员",
    "focus": "跨集人设/伏笔/称呼/时间线一致性",
    "weight": 1.0,
    "temperature": 0.3,
    "system_prompt": (
        "你是短剧的跨集连贯审查员，拿到的是全剧各集的梗概序列。只挑跨集层面的问题："
        "跨集人物性格/目标突变且无交代、伏笔埋了没回收或回收了没埋、称呼/关系跨集错位、"
        "时间线跨集矛盾、同一事件跨集描述打架。不要评价单集内部细节。\n"
        "每条问题在 locator.scene_no 标出涉及的集号(如 '第2集↔第5集')。"
        "每个问题必须引用证据。无问题就返回空数组。"
    ),
}

# 仲裁者: 合并去重各身份意见 -> 编辑工单
ARBITER_SYSTEM = (
    "你是评审仲裁者。输入是多个评审身份产出的问题清单（已含各自 severity/confidence）。"
    "你的职责：合并语义重复的问题（保留证据最具体的一条，confidence 取较高值），"
    "按 severity(high>mid>low) × confidence 排序，标注互相矛盾的意见。"
    "你只整理不新增问题、不评判对错。输出 JSON：{\"items\":[...], \"conflicts\":[...]}。"
)

# 总编辑: 动笔前的决策层 (v2)。综合本集全部评审意见 + 圣经 + 全局预警,
# 逐条裁定采纳/驳回/合并, 补充身份漏掉的逻辑/设定问题, 输出一份"确定的改写方案"。
# 编辑(执行器)拿到这份方案直接落笔, 不再自行决策。
CHIEF_EDITOR_SYSTEM = (
    "你是短剧的总编辑(主编), 是改稿决策的唯一负责人。下面会给你: 本集原文、多个评审身份"
    "提出的问题清单(含确定性闸门命中的硬问题)、设定圣经硬约束、以及来自全局总览的跨集预警。\n"
    "你的职责(只决策, 不亲自改写):\n"
    "1. 通读全部意见, 合并重复、消解互相矛盾的意见, 剔除误判或与更高优先目标冲突的建议;\n"
    "2. 从逻辑/设定/人物/称谓/节奏全角度补充评审身份遗漏的问题;\n"
    "3. 严格对照设定圣经: 凡涉及世界观/人物正名/称谓/核心驱动力/违禁词的, 圣经为准, 不可妥协;\n"
    "4. 产出一份【确定的改写方案】交执行编辑直接落笔: 每条指令要可执行、定位明确、给出改写方向。\n"
    "严格输出 JSON: {\"plan\":[{\"target\":\"定位(场次/段落/原句片段)\",\"problem\":\"要解决什么\","
    "\"action\":\"具体怎么改(给出方向或改写示例)\",\"reason\":\"依据(可引用圣经/评审)\","
    "\"severity\":\"high|mid|low\"}], \"dropped\":[\"驳回的意见及原因\"], \"note\":\"给执行编辑的整体说明\"}。"
    "只输出 JSON, 不要解释或 markdown 标记。"
)

# 编辑: 按工单定向改写 (= 用户创作模型)
EDITOR_SYSTEM = (
    "你是剧本编辑，是唯一能改稿的人。根据'编辑工单'对当前稿做定向修改，不要推翻重写、"
    "不要改动工单未提及的部分。对台词类问题，优先采用审查员给出的'建议改写'。\n"
    "你有反驳权：若某条意见明显误判，或采纳它会破坏更重要的目标，可不采纳并说明理由。\n"
    "严格保持原文的格式结构（章节正文保持纯文本；剧本分镜保持原 JSON 结构）。\n"
    "输出 JSON：{\"new_text\":\"改写后的完整正文\", \"applied\":[问题序号...], "
    "\"rejected\":[{\"index\":序号,\"reason\":\"...\"}]}。"
)


def issue_output_schema_hint(role_id: str | None = None) -> str:
    """评审身份统一的 JSON 输出格式说明。

    D5: audience_reviewer(观众/完播率审查员)额外被要求输出**结构化的钩子体检**——
    把"开头不够抓人"这种定性抱怨，变成六变量 + 分数 + 可逐条采纳的 rewrite_strategy。
    其他身份维持原 schema（改动面最小，且它们的问题本就适合定性描述）。
    """
    base = (
        '严格输出 JSON 数组，每个元素：'
        '{"severity":"high|mid|low","issue":"一句话问题",'
        '"evidence":"原文引用（必填）","fix_hint":"怎么改，台词类给\'原句→建议\'对照",'
        '"locator":{"scene_no":"场次或段落定位"}}。'
    )
    if role_id == "audience_reviewer":
        base += (
            '此外，若本集是剧集开头或你认为钩子/留存有问题，**额外**追加一个特殊元素：'
            '{"severity":"high|mid|low","role_kind":"hook_audit","hook_score":0-100,'
            '"variables":{"disruption":"ok|weak|missing","info_gap":"ok|weak|missing",'
            '"stakes":"ok|weak|missing","conflict":"ok|weak|missing",'
            '"promise":"ok|weak|missing","open_loop":"ok|weak|missing"},'
            '"issue":"一句话说清钩子的问题",'
            '"rewrite_strategy":["可执行的动作1","可执行的动作2","可执行的动作3"],'
            '"evidence":"原文引用"}。'
            '六变量含义：disruption=前几秒有无异常事件；info_gap=观众是否知道自己缺什么信息；'
            'stakes=主角会失去什么；conflict=是否立即存在人与人/人与环境的冲突；'
            'promise=本集向观众承诺了什么爽点或谜底；open_loop=结尾是否留下未闭合的问题。'
            'rewrite_strategy 必须是**具体可执行**的动作（如"把离婚通知提前到前20秒"），'
            '禁止"增加冲突""让剧情更抓人"这类空话。'
        )
    base += '无问题返回 []。只输出 JSON，不要任何解释或 markdown 代码块标记。'
    return base


# admin 运行时覆盖 (由 service 在每次 run 前从 critique_config 注入; None=用内置默认)
_RUNTIME_CONFIG: dict | None = None


def set_runtime_config(cfg: dict | None) -> None:
    """service 在任务开始前调用, 注入 admin 配置 (角色开关/权重/强度档)。"""
    global _RUNTIME_CONFIG
    _RUNTIME_CONFIG = cfg or None


def role_enabled(role_id: str) -> bool:
    """该评审身份是否启用 (admin 可在后台关掉某身份)。"""
    if not _RUNTIME_CONFIG:
        return True
    r = (_RUNTIME_CONFIG.get("roles") or {}).get(role_id)
    if not r:
        return True
    return bool(r.get("enabled", True))


def role_weight(role_id: str) -> float:
    """该身份权重 (admin 可调; 默认取内置 weight)。"""
    base = (REVIEW_ROLES.get(role_id) or {}).get("weight", 1.0)
    if not _RUNTIME_CONFIG:
        return base
    r = (_RUNTIME_CONFIG.get("roles") or {}).get(role_id)
    if r and "weight" in r:
        try:
            return float(r["weight"])
        except Exception:  # noqa: BLE001
            return base
    return base


def default_config() -> dict:
    """返回内置默认配置 (供 admin GET 初始展示)。"""
    return {
        "default_intensity": "standard",
        "roles": {
            rid: {"enabled": True, "weight": cfg.get("weight", 1.0), "name": cfg.get("name", rid)}
            for rid, cfg in {**REVIEW_ROLES, GLOBAL_REVIEWER["id"]: GLOBAL_REVIEWER}.items()
        },
        "intensity": {
            "light": {"models": ["gemini"], "rounds": 2},
            "standard": {"models": ["gemini", "deepseek"], "rounds": 4},
            "full": {"models": ["gemini", "gpt5", "deepseek"], "rounds": 6},
        },
    }


def models_for_intensity(intensity: str) -> list[str]:
    """强度档 -> 每个身份挂的模型列表。

    轻量: 单模型(gemini); 标准: 2 模型; 全量: 3 模型(含 gpt5 逻辑强项 + deepseek)。
    admin 可在 critique_config.intensity.<档>.models 覆盖。
    """
    if _RUNTIME_CONFIG:
        m = ((_RUNTIME_CONFIG.get("intensity") or {}).get(intensity) or {}).get("models")
        if isinstance(m, list) and m:
            return m
    if intensity == "light":
        return ["gemini"]
    if intensity == "full":
        return ["gemini", "gpt5", "deepseek"]
    return ["gemini", "deepseek"]  # standard


def rounds_for_intensity(intensity: str) -> list[str]:
    """强度档 -> 轮次主题序列。"""
    if intensity == "light":
        return ["structure", "deai"]
    if intensity == "full":
        return ROUND_THEMES + ["deai", "pacing"]  # 8 轮: 4 主题, deai/pacing 各加一轮
    return ROUND_THEMES  # standard: 4 轮