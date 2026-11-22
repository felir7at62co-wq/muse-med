"""D1: 剧情结构门禁 (Drama Gate) —— 大纲层的戏剧契约校验。

定位（见 docs/PLAN-剧情结构与戏剧契约-v3.md §5-D1）：
  这里补的是"从大纲到正文之间"那道目前完全为空的关口。问题在大纲层产生、在 60 集
  正文里被继承放大、最后指望精修补句子——用行级重写去修"第 7 集没有价值转变"是最贵
  且最无效的位置。本模块在大纲展开完成、章节生成之前，用**零 LLM**的确定性规则把
  结构塌陷拦住。

与 consistency_lint 的分工：
  - consistency_lint 查"矛盾"（死人复活、设定打架）——目标函数是 **自洽**；
  - drama_gate 查"疲软"（没钩子、没升级、伏笔没收）——目标函数是 **好看**。
  两者互不替代。schema 对齐（level/code/episode/message/detail），复用同一套前端标注。

遵循 v2 已定决策 2「只标注，不自动重写」：
  **本模块只产出 issues，绝不改写大纲**。用户可一键按建议修订、手动改、或强制继续。

契约字段全部可选：缺失只报 warn 不报 error，老剧不会被判死（见 PLAN §9 旧数据兼容）。
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any

logger = logging.getLogger("drama_gate")

# --- 判据常量（用户已拍板：升级容忍 3 集）---
ESCALATION_STALL_TOLERANCE = 3   # 连续 3 集 stakes 不升级才报 error
HOOK_TYPE_REPEAT_WINDOW = 3      # 连续 3 集 hook_out.type 重复报 warn
DELAY_RESPONSE_LIMIT = 3         # "有意延迟"超过 3 集未回应报 error
VALUE_SHIFT_LOOKBACK = 5         # value_shift 与前 5 集比对查重

# 空泛的失败代价——命中即报（PLAN §5-D1 门禁 6）
#
# ⚠️ 2026-10-11：删掉原先的 "名声受损" / "名誉受损" 两条。
# 它们是**损失对象**（丢的是名声/名誉），不是"空泛得说不出丢了什么"——
# 恰恰相反，写出了丢什么正是这条门禁想要的东西。而 _CONCRETE_STAKE_WORDS
# 里本来就收着 "名声" / "名誉"，两张表对同一个词给出了相反结论。
#
# 实测代价（草稿 707，用户甲报的"误判"就是这个）：全库 stakes_vague 命中的
# 空泛词**只有 "名誉受损" 一个**，共 8 条，全落在两段本来写得很具体的代价上：
#   「沈南意面临被辞退或名誉受损的风险；刘浩面临失去组长职位的风险。」
#   「沈南意面临被道德绑架、名誉受损及被逼迫结账的风险。」
# 更糟的是它**会主动改坏稿子**：AI 照着这条错误判据"修复"，动作就是把
# 「名誉受损」删掉换成别的词（历史 5015 的 stakes 确实如此），越改越空。
VAGUE_STAKES_PATTERNS = [
    "丢脸", "丢人", "没面子", "大家会失望", "所有人都会失望",
    "不好过", "很难过", "会很惨", "情况不妙", "后果自负", "付出代价", "会有麻烦",
]

# 弱卡点黑名单（与 drama_principles 十八 结尾卡点 一致）
WEAK_HOOK_PATTERNS = [
    "若有所思", "更大的危机正在靠近", "一切才刚刚开始", "意味深长",
    "不详的预感", "不知道等待她的是什么", "不知道等待他的是什么",
]

# 抽象的"权力争夺焦点"——命中即报（与 VAGUE_STAKES_PATTERNS 同理：
# 焦点写成抽象概念就指导不了具体台词）
VAGUE_POWER_FOCUS = [
    "控制权", "话语权", "尊严", "面子", "地位", "命运", "人生", "未来",
    "信任", "感情", "爱情", "认可", "存在感", "主权", "主动权",
]

# 合法钩子类型（与 outline prompt 的枚举一致）
HOOK_TYPES = [
    "突然揭示", "紧急危机", "未完成动作", "身份反转", "两难选择",
    "神秘线索", "时间限制", "承诺威胁", "离奇消失", "言外之意",
]
# 模型常按"强卡点"的措辞来写类型（这些是 drama_principles 十八 里的分类名），
# 它们其实是同一批概念的不同称法，做别名归一而不是报"未知类型"。
HOOK_TYPE_ALIASES = {
    "危机爆发型": "紧急危机", "危机爆发": "紧急危机",
    "反转揭露型": "身份反转", "反转揭露": "身份反转",
    "对抗升级型": "承诺威胁", "对抗升级": "承诺威胁",
    "行动启动型": "未完成动作", "行动启动": "未完成动作",
    "奇观出现型": "神秘线索", "奇观出现": "神秘线索",
    "压力累积型": "时间限制",
}


def normalize_hook_type(raw: str) -> str:
    """把模型写出的钩子类型归一到标准枚举；无法归一则原样返回。"""
    t = str(raw or "").strip()
    if not t or t in HOOK_TYPES:
        return t
    if t in HOOK_TYPE_ALIASES:
        return HOOK_TYPE_ALIASES[t]
    for k, v in HOOK_TYPE_ALIASES.items():
        if k in t:
            return v
    for k in HOOK_TYPES:
        if k in t or t in k:
            return k
    return t

HOOK_STRENGTHS = ["好奇", "关切", "迫切", "生存", "终极"]
# 强度递进序（用于升级判定）
_STRENGTH_ORDER = {s: i for i, s in enumerate(HOOK_STRENGTHS)}

# 空泛升级措辞——escalation 只在换措辞不算升级
VAGUE_ESCALATION_PATTERNS = [
    "更紧张", "更激烈", "进一步升级", "难度加大", "更加复杂", "继续升级",
    "矛盾加深", "冲突升级",
]


# ---------------------------------------------------------------------------
# 文本工具
# ---------------------------------------------------------------------------

def _norm(text: Any) -> str:
    """归一化：去空白与常见标点，便于较真比较。"""
    s = str(text or "")
    s = re.sub(r"[\s，。、；：！？,.;:!?\"'“”‘’()（）\[\]【】—\-…]+", "", s)
    return s.lower()


def _len_of(text: Any) -> int:
    return len(_norm(text))


def _hit_any(text: str, patterns: list[str]) -> str | None:
    for p in patterns:
        if p in (text or ""):
            return p
    return None


def _bigrams(text: str) -> set[str]:
    n = _norm(text)
    return {n[i:i + 2] for i in range(len(n) - 1)} if len(n) >= 2 else ({n} if n else set())


def _similar(a: str, b: str) -> float:
    """两段短文本的相似度（零依赖）。

    先用 bigram Jaccard 抓"几乎同一句话"，再用**最长公共子序列占比**兜底——
    模型常做措辞改写（"扣住咽喉" vs "掐住咽喉"、"要求" vs "来电要求"），
    字符级 Jaccard 在这种改写上会低到 0.1 以下而误判为"不相关"。
    LCS 对插入/改写鲁棒，能正确识别"说的是同一件事"。
    """
    na, nb = _norm(a), _norm(b)
    if not na or not nb:
        return 0.0
    jac = 0.0
    ga, gb = _bigrams(na), _bigrams(nb)
    if ga and gb:
        jac = len(ga & gb) / len(ga | gb)
    # 子串直接命中
    if na in nb or nb in na:
        return 1.0
    return max(jac, _lcs_ratio(na, nb))


def _lcs_ratio(a: str, b: str) -> float:
    """最长公共子序列长度 / 较短串长度。对措辞改写鲁棒。"""
    if len(a) > 200:   # 防御性截断，避免 O(n*m) 过大
        a = a[:200]
    if len(b) > 200:
        b = b[:200]
    m, n = len(a), len(b)
    if not m or not n:
        return 0.0
    prev = [0] * (n + 1)
    for i in range(1, m + 1):
        cur = [0] * (n + 1)
        ai = a[i - 1]
        for j in range(1, n + 1):
            if ai == b[j - 1]:
                cur[j] = prev[j - 1] + 1
            else:
                cur[j] = cur[j - 1] if cur[j - 1] >= prev[j] else prev[j]
        prev = cur
    return prev[n] / min(m, n)


# 模型写"上一集结尾……"/"承接第2集结尾……"这类前缀时，剥掉后再比对，
# 避免前缀污染相似度。注意"承接第N集结尾"里的集号是变量，用正则处理。
_PREFIX_PATTERNS = [
    "上一集结尾", "上集结尾", "上一集", "上集", "上一章结尾", "上一章",
    "开头回应", "承接", "回应",
]
# "承接第2集结尾" / "承接第1集结尾的" —— 集号可变
_PREFIX_RE = re.compile(r"^(?:承接|回应)?\s*第\s*\d+\s*集(?:的)?(?:结尾|末尾|卡点|悬念)?(?:的)?")


def _strip_prefix(text: str) -> str:
    s = str(text or "").strip()
    changed = True
    while changed:
        changed = False
        m = _PREFIX_RE.match(s)
        if m and m.end() > 0:
            s = s[m.end():].lstrip("，。、：: 　")
            changed = True
            continue
        for p in _PREFIX_PATTERNS:
            if s.startswith(p):
                s = s[len(p):].lstrip("，。、：: 　")
                changed = True
                break
    return s


def _issue(level: str, code: str, episode: int | None, message: str,
           detail: dict | None = None, fix_hint: str = "") -> dict:
    """统一 issue schema（与 consistency_lint 对齐，前端可直接复用）。"""
    it = {
        "level": level,          # error | warn
        "code": code,
        "episode": episode,
        "message": message,
        "detail": detail or {},
    }
    if fix_hint:
        it["fix_hint"] = fix_hint
    return it


# ---------------------------------------------------------------------------
# 单集字段级检查
# ---------------------------------------------------------------------------

def _check_value_shift(ep: dict) -> list[dict]:
    """门禁 1b：价值转变必须真的发生（from == to 等于没转变）。"""
    vs = ep.get("value_shift") or {}
    f, t = str(vs.get("from") or "").strip(), str(vs.get("to") or "").strip()
    order = ep.get("order")
    if f and t and _norm(f) == _norm(t):
        return [_issue(
            "error", "value_shift_noop", order,
            f"第{order}集的 value_shift 起点与终点相同，本集没有发生价值转变",
            {"from": f, "to": t},
            "让本集结束时主角的处境/认知与开始时不同（换了场景但没变化不算转变）",
        )]
    return []


# 具体损失对象词——出现即认为 stakes 有实指，不再因字数短而报
_CONCRETE_STAKE_WORDS = [
    "命", "死", "失去", "丧失", "丢掉", "被夺", "资格", "身份", "继承", "股权", "财产",
    "遗产", "钱", "债", "自由", "牢", "入狱", "坐牢", "亲情", "父亲", "母亲", "父", "母",
    "儿子", "女儿", "孩子", "弟弟", "妹妹", "哥哥", "姐姐", "妻", "夫", "爱人", "婚约",
    "婚", "名声", "名誉", "清白", "信任", "机会", "名额", "工作", "职位", "学业", "学籍",
    "传承", "公司", "家产", "房子", "监", "抚养权", "性命", "生命", "被赶", "被开除",
    # ⚠️ 2026-10-11 补：**动作**也构成实指。上面全是"名词化的损失对象"，
    # 于是「被辞退」「被降职」这类**用动词说清丢了什么**的写法一个都不认 ——
    # 而这恰恰是实测里出现的那句："面临被辞退或名誉受损的风险"。
    "辞退", "被裁", "裁员", "解雇", "开除", "降职", "免职", "调岗", "停职", "失业", "下岗",
]

#: stakes 还没填时的占位写法。它们要报的是"缺字段"，不是"写太空泛"。
_STAKES_PLACEHOLDERS = {"无", "暂无", "待定", "待填", "-", "—", "N/A", "n/a", "无。", "（无）"}


def _stake_word_is_specific(hit: str, stakes: str) -> bool:
    """命中的"空泛词"所在句子里，是否**另有**具体损失对象。

    判据是「把命中词剥掉之后，剩下的部分还认不认得出具体损失」。
    这是 2026-10-11 那次误报的通用化修法：当时是「名誉受损」恰好同时躺在
    空泛黑名单和具体白名单里，靠手工删词法修掉的；但同类冲撞会再发生
    （下一次可能是「丢脸」配「失去继承权」），所以留一道结构性兜底。

    ⚠️ 两个口径都必须排除，实测数据在下面：

    1. **不能用整句判**（`any(w in stakes ...)`）—— 白名单里有 "命"/"钱"/"父"/"母"
       这类单字，短剧 stakes 几乎不可能不带这些字。全库实测 **414/557 = 74.3%**
       会被放行，等于把这条门禁整个废掉。
    2. **不能只看命中词本身**（`w in hit or hit in w`）—— 当前词表下这个条件是
       恒假的死代码（黑名单 × 白名单笛卡尔积为空），写了等于没写。

    剥掉命中词再判，两边都避开了：命中词自己不构成实指，
    但它旁边的「被辞退」「失去组长职位」算。
    """
    rest = stakes.replace(hit, "") if hit else stakes
    return any(w in rest for w in _CONCRETE_STAKE_WORDS)


def _check_stakes_wording(ep: dict) -> list[dict]:
    """门禁 6：失败代价必须是具体的，禁止空泛后果。"""
    stakes_raw = str(ep.get("stakes") or "").strip()
    order = ep.get("order")
    if not stakes_raw:
        return []

    # 「无」「暂无」这类占位不是"写得空泛"，是**字段还没填**。混进 stakes_too_vague_short
    # 里报出来，用户读到的是一条文笔批评（"既简略又空泛"），而实际该做的事是补字段 ——
    # 两件事的修法完全不同，所以单独报一条。
    # 实测来源：草稿 707 第 61 集 stakes 字面就是「无」。
    if stakes_raw in _STAKES_PLACEHOLDERS:
        return [_issue(
            "error", "stakes_missing", order,
            f"第{order}集还没有填写失败代价（当前是「{stakes_raw}」）",
            {"stakes": stakes_raw},
            "补上这一集主角会失去什么（身份/资格/亲情/自由/传承/机会/信任/性命）",
        )]

    hit = _hit_any(stakes_raw, VAGUE_STAKES_PATTERNS)
    if hit and not _stake_word_is_specific(hit, stakes_raw):
        return [_issue(
            "error", "stakes_vague", order,
            f"第{order}集的失败代价空泛（出现「{hit}」），观众感受不到风险",
            {"stakes": stakes_raw, "hit": hit},
            "改成具体后果：会失去身份/资格/亲情/自由/传承/机会/信任/性命中的哪一样",
        )]
    # 又短又没有任何"失去对象"的名词，才算不具体。
    # 注意：不能只按长度判——"弟弟会死"只有 4 字，但具体、有力，属合格表达。
    if _len_of(stakes_raw) < 6 and not any(w in stakes_raw for w in _CONCRETE_STAKE_WORDS):
        return [_issue(
            "error", "stakes_too_vague_short", order,
            f"第{order}集的失败代价既简略又空泛（「{stakes_raw}」），观众感受不到具体风险",
            {"stakes": stakes_raw},
            "写清楚主角会失去什么具体的东西（身份/资格/亲情/自由/传承/机会/信任/性命）",
        )]
    return []



def _check_hook_enum(ep: dict) -> list[dict]:
    """门禁 9b：hook_out.type 必须是合法枚举值（否则下游无法判重）。

    别名（"危机爆发型"→"紧急危机"等）会先归一，不报错；无法归一才提示。
    """
    ho = ep.get("hook_out") or {}
    t = str(ho.get("type") or "").strip()
    order = ep.get("order")
    if not t:
        return []
    if normalize_hook_type(t) in HOOK_TYPES:
        return []
    return [_issue(
        "warn", "hook_type_unknown", order,
        f"第{order}集的钩子类型「{t}」不在标准枚举内，无法参与类型查重",
        {"type": t, "allowed": HOOK_TYPES},
        f"改用标准类型之一：{'、'.join(HOOK_TYPES)}",
    )]


def _check_hook_leads_to(ep: dict) -> list[dict]:
    """门禁 9a：结尾卡点必须能引发下一集（leads_to 不能空、不能是弱卡点）。"""
    ho = ep.get("hook_out") or {}
    order = ep.get("order")
    t = str(ho.get("type") or "").strip()
    leads = str(ho.get("leads_to") or "").strip()
    if not t and not leads:
        return []   # 整块缺失由完整性检查覆盖，不重复报
    issues: list[dict] = []
    hit = _hit_any(t + leads, WEAK_HOOK_PATTERNS)
    if hit:
        issues.append(_issue(
            "error", "hook_weak", order,
            f"第{order}集结尾是弱卡点（出现「{hit}」），观众没有看下一集的理由",
            {"hook_out": ho, "hit": hit},
            "改用强卡点：危机爆发/反转揭露/对抗升级/行动启动/奇观出现",
        ))
    if t and not leads:
        issues.append(_issue(
            "error", "hook_missing_leads_to", order,
            f"第{order}集有结尾卡点但没有 leads_to，无法判断它是否引发下一集",
            {"hook_out": ho},
            "写明这个卡点会直接导致下一集发生什么",
        ))
    return issues


# ---------------------------------------------------------------------------
# 跨集检查（门禁 2/3/4/5/7/8/10）
# ---------------------------------------------------------------------------

def _has_contract(ep: dict) -> bool:
    """该集是否携带戏剧契约（老数据没有 → 跨集检查应跳过它，而不是判它不及格）。

    这是旧数据兼容的关键：老剧的每集只有 order/title/synopsis/must_have/characters，
    若不跳过，升级单调性等跨集检查会对"未标注"逐集刷屏报 error——
    而"没标注"不等于"没升级"，那是误判。
    """
    vs = ep.get("value_shift") or {}
    ho = ep.get("hook_out") or {}
    beats = ep.get("beats")
    return bool(
        str(ep.get("core_push") or "").strip()
        or str(ep.get("stakes") or "").strip()
        or str(ep.get("escalation") or "").strip()
        or str(ho.get("type") or "").strip()
        or str(ho.get("strength") or "").strip()
        or (str(vs.get("from") or "").strip() and str(vs.get("to") or "").strip())
        # 2026-10-09：beats 也是契约级信息（"这一集按顺序演哪几拍"），
        # 携带它的集同样值得参与跨集结构检查。
        or (isinstance(beats, list) and len(beats) > 0)
    )


def _check_beats_presence(eps: list[dict]) -> list[dict]:
    """门禁 13：本集有没有可演的**场景节拍**。

    ## 为什么这条要用 warn 单独报出来

    实测（2026-10-09）剧本步骤此前拿到 0 个契约字段、只有一句 synopsis，
    扩写倍率 46~56 倍 —— 模型不是在扩写，是在**从零写这一集**，
    于是"自己编大纲里没有的内容"。而 `beats` 正是那一层缺掉的决策。

    没有 beats 不等于这部剧有问题（老数据全都没有，不该刷屏报错），
    但**有契约却唯独缺 beats** 的那些集，就是下游最容易自由发挥的集 ——
    用户需要看得见它们在哪，否则"信息量不足"这件事永远是隐性的。

    所以：只在**本剧已有集携带 beats** 时才检查（说明这部剧走的是新格式），
    对全老数据的大纲整条跳过，不做误报。
    """
    if not eps:
        return []
    any_has = any(isinstance(e.get("beats"), list) and e["beats"] for e in eps)
    if not any_has:
        return []          # 老数据：全都没有 → 不报（与 contract_incomplete 同款兼容策略）
    missing = [e.get("order") for e in eps
               if not (isinstance(e.get("beats"), list) and e["beats"])]
    if not missing:
        return []
    shown = "、".join(str(x) for x in missing[:10])
    more = f" 等 {len(missing)} 集" if len(missing) > 10 else ""
    return [_issue(
        "warn", "beats_missing", None,
        f"第 {shown}{more} 没有场景节拍（beats）。这些集在写正文/剧本时"
        f"只有一句概要可依，模型容易自行补充大纲里没有的情节。",
        {"episodes": missing, "total": len(eps)},
        "用「重新生成此集」重做这些集的大纲，会自动带上场景节拍；"
        "或在「设定」面板重新生成大纲。",
    )]


#: 连续几集用同一种爽点算疲劳（与钩子同款窗口）
PAYOFF_KIND_REPEAT_WINDOW = 3


def _check_payoff_presence(eps: list[dict]) -> list[dict]:
    """门禁 14：本集有没有写"爽在哪里"（payoff_moment）。

    与 beats_missing 同款兼容策略：整部剧都没有 payoff_moment 时（老数据）不报；
    只要有一部分集写了，缺失的那些集就是**下游最容易写平**的集 —— 正文只能按
    synopsis 平铺直叙，爽点靠运气。

    为什么要单独一门：案例稿逐集标【爽点】，60 集里 52 集以动作收尾、13 集以
    悬念台词收尾 —— 观众能不能留下来，靠的是每集那一下，而不是"这一集讲了什么"。
    我们此前只有 core_push（推进了什么），没有任何字段回答"这一集爽在哪"。
    """
    if not eps:
        return []
    if not any(str(e.get("payoff_moment") or "").strip() for e in eps):
        return []          # 老数据整部都没有 → 不报
    missing = [e.get("order") for e in eps if not str(e.get("payoff_moment") or "").strip()]
    if not missing:
        return []
    shown = "、".join(str(x) for x in missing[:10])
    more = f" 等 {len(missing)} 集" if len(missing) > 10 else ""
    return [_issue(
        "warn", "payoff_missing", None,
        f"第 {shown}{more} 没有写本集的爽点（payoff_moment）。这些集写正文时"
        f"只有剧情推进、没有「这一集值回票价的那一下」。",
        {"episodes": missing, "total": len(eps)},
        "用「重新生成此集」重做这些集的大纲，会自动带上爽点。",
    )]


def _check_payoff_repeat(eps: list[dict]) -> list[dict]:
    """门禁 14b：连续几集用同一种爽点 → 观众觉得套路化。"""
    issues: list[dict] = []
    kinds = [str(e.get("payoff_kind") or "").strip() for e in eps]
    orders = [e.get("order") for e in eps]
    w = PAYOFF_KIND_REPEAT_WINDOW
    for i in range(len(kinds) - w + 1):
        window = kinds[i:i + w]
        if all(window) and len(set(window)) == 1:
            issues.append(_issue(
                "warn", "payoff_kind_repeat", orders[i + w - 1],
                f"第{orders[i]}~{orders[i+w-1]}集连续 {w} 集都是「{window[0]}」型爽点，观众会觉得套路",
                {"kind": window[0], "episodes": orders[i:i + w]},
                "换一种爽点类型（打脸/身份反转/情感兑现轮着用）",
            ))
    return issues


def _contract_eps(eps: list[dict]) -> list[dict]:
    """只保留带契约的集，供跨集检查使用（保持原有先后顺序）。"""
    return [e for e in eps if _has_contract(e)]


def _check_hook_chain(eps: list[dict]) -> list[dict]:
    """门禁 2：钩子链连续性。

    ⚠️ 实测结论（2026-09-12，真实 LLM 产出 9 对样本）：这是一条**低置信度**检查。
    模型写 hook_in.responds_to 时是在**概括**上一集的卡点（"上一集随嫁嬷嬷逼端毒交杯酒"），
    而 hook_out.leads_to 是**具体动作**（"沈昭必须当众处理这杯含毒的交杯酒"）——两者说的是
    同一件事，但字符级相似度只有 0.2~0.4。用 0.45 阈值会误判其中约一半为"断裂"。
    继续下调阈值只是在拟合样本，没有泛化能力。

    因此本检查只保留**能确凿判定**的两种情况，且均为 warn：
      1) hook_in.mode == "有意延迟" 却超过 DELAY_RESPONSE_LIMIT 集无人回应（结构性拖延，可确凿判定）；
      2) responds_to 完全为空但上一集有明确 leads_to（没写承接，属遗漏而非断裂）。
    语义层面的"钩子是否真的接上了"交给 LLM 评审侧（logic_reviewer / continuity_reviewer）——
    那本来就是语言模型的强项，而不是字符相似度的强项。

    ⚠️ 2026-10-11：情况 2 加了"整部剧都没有 hook_in 就不报"的前置守卫。
    用户甲报的"误判刷屏"根因就在这里 —— 她的草稿 707 是**从外部导入**的
    （session_id="import_outline_*"），导入路径对 hook_in 是"模型给了才带上"
    （见 import_outline.py 的契约字段块），于是 61 集 hook_in present 0/61、
    hook_out 61/61。检查器于是逐集报"没写承接"，一份报告 60 条里占了 56 条，
    把一个**上游没产出的字段**放大成了满屏噪声。
    （对照：同期由本系统生成的大纲草稿 702/701/694/692/691 都是有 hook_in 的。）
    判据与 beats_missing 同款：只有当这部剧**至少有一集带了 hook_in** 时才检查，
    这样新生成的大纲真漏了某几集仍会被提示，而导入的老稿一条都不报。
    """
    issues: list[dict] = []

    #: 情况 2 的前置守卫（同 beats_missing 的兼容策略）。
    #: 注意只守情况 2 —— 情况 1（有意延迟超期）判的是 mode 本身，
    #: 整部剧都没有 hook_in 时它本来也不会命中，两边互不影响。
    _any_hook_in = any(
        str((e.get("hook_in") or {}).get("responds_to") or "").strip()
        or str((e.get("hook_in") or {}).get("mode") or "").strip()
        for e in eps
    )

    for prev, cur in zip(eps, eps[1:]):
        ho = prev.get("hook_out") or {}
        hi = cur.get("hook_in") or {}
        p_order, c_order = prev.get("order"), cur.get("order")
        prev_leads = str(ho.get("leads_to") or "").strip()
        responds = str(hi.get("responds_to") or "").strip()
        mode = str(hi.get("mode") or "").strip()

        # 2) 上一集有明确卡点指向，本集却完全没写承接 —— 属于遗漏
        if _any_hook_in and prev_leads and not responds and mode != "有意延迟":
            issues.append(_issue(
                "warn", "hook_in_missing", c_order,
                f"第{c_order}集没有填写入口钩，未声明如何承接第{p_order}集的卡点",
                {"prev_leads_to": prev_leads},
                "补上 hook_in.responds_to，或在确认要延后回应时标 mode=有意延迟",
            ))

    # 1) 有意延迟超期未回应 —— 结构性拖延，可确凿判定
    pending: dict[int, int] = {}   # 集号 -> 已延迟集数
    for ep in eps:
        hi = ep.get("hook_in") or {}
        order = ep.get("order")
        if str(hi.get("mode") or "").strip() == "有意延迟":
            pending[order] = 0
        else:
            pending.clear()
        for start in list(pending.keys()):
            pending[start] += 1
            if pending[start] > DELAY_RESPONSE_LIMIT:
                issues.append(_issue(
                    "error", "hook_delay_too_long", order,
                    f"第{start}集的卡点被有意延迟，已过 {pending[start]} 集仍未回应，读者已失去耐心",
                    {"since_episode": start, "elapsed": pending[start]},
                    f"在 {DELAY_RESPONSE_LIMIT} 集内回应这个卡点，或去掉「有意延迟」",
                ))
                pending.pop(start, None)
    return issues


def _check_hook_type_repeat(eps: list[dict]) -> list[dict]:
    """门禁 3：连续 HOOK_TYPE_REPEAT_WINDOW 集用同一种钩子 → 模式疲劳。"""
    issues: list[dict] = []
    types = [normalize_hook_type(str((ep.get("hook_out") or {}).get("type") or "")) for ep in eps]
    orders = [ep.get("order") for ep in eps]
    for i in range(len(types) - HOOK_TYPE_REPEAT_WINDOW + 1):
        window = types[i:i + HOOK_TYPE_REPEAT_WINDOW]
        if all(window) and len(set(window)) == 1:
            issues.append(_issue(
                "warn", "hook_type_repeat", orders[i + HOOK_TYPE_REPEAT_WINDOW - 1],
                f"第{orders[i]}~{orders[i+HOOK_TYPE_REPEAT_WINDOW-1]}集连续 {HOOK_TYPE_REPEAT_WINDOW} "
                f"集都用了「{window[0]}」型钩子，观众会产生模式疲劳",
                {"type": window[0], "episodes": orders[i:i + HOOK_TYPE_REPEAT_WINDOW]},
                "换一种钩子类型，或其中一集用平静结尾反预期",
            ))
    return issues


def _check_escalation(eps: list[dict]) -> list[dict]:
    """门禁 4：升级单调性。

    用两个信号判断本集是否真在升级：钩子强度等级提高，或 escalation 文本
    与前几集不是"换措辞"。连续 ESCALATION_STALL_TOLERANCE 集没有升级 → error
    （用户已拍板容忍 3 集）。同一段停滞只报一次，报后清零避免刷屏。
    """
    issues: list[dict] = []
    prev_strength = -1
    prev_esc = ""
    stall = 0          # 已经连续多少集没有升级
    reported_at = 0    # 上一次报过的 stall 值，避免同一段重复报

    for ep in eps:
        order = ep.get("order")
        # 老数据没有契约字段：无法判断是否升级，跳过（不误判为停滞）
        if not _has_contract(ep):
            continue
        ho = ep.get("hook_out") or {}
        cur_strength = _STRENGTH_ORDER.get(str(ho.get("strength") or "").strip(), -1)
        cur_esc = str(ep.get("escalation") or "").strip()

        # 第 1 集是"建立初始困境"，不计入停滞
        if order == 1:
            is_upgrade = True
        else:
            climbed = cur_strength > prev_strength >= 0
            vague = _hit_any(cur_esc, VAGUE_ESCALATION_PATTERNS)
            # 与前几集不同的表述（且非空泛措辞）才算换了一件更难的事
            rewritten = bool(cur_esc) and not vague and _norm(cur_esc) != _norm(prev_esc) \
                and _similar(cur_esc, prev_esc) < 0.75
            is_upgrade = climbed or rewritten

        if is_upgrade:
            stall = 0
            reported_at = 0
        else:
            stall += 1
            # 连续 stall 集没有升级；stall+1 集里只有第 1 集是"起点"，不算停滞
            if stall >= ESCALATION_STALL_TOLERANCE and stall > reported_at:
                span = orders_span(eps, order, stall + 1)
                issues.append(_issue(
                    "error", "escalation_stall", order,
                    f"{span} 的压迫强度没有真正上升，中段会疲软",
                    {"escalation": cur_esc, "stall_episodes": stall + 1},
                    "让本集在某个维度真正变化：行动结果、人物关系、信息、资源、地位或情绪债务"
                    "至少一项发生不可逆的改变。不必每集都加大危险 —— 允许阶段性胜利"
                    "或局部降温，但要与前后几集明显不同，不要换种说法重复同一处境",
                ))
                reported_at = stall

        if cur_strength >= 0:
            prev_strength = cur_strength
        if cur_esc:
            prev_esc = cur_esc
    return issues


def orders_span(eps: list[dict], end_order: int, count: int) -> str:
    """生成「第X~Y集」这类区间描述。"""
    orders = [e.get("order") for e in eps]
    try:
        idx = orders.index(end_order)
    except ValueError:
        return f"第{end_order}集附近"
    start_idx = max(0, idx - count + 1)
    return f"第{orders[start_idx]}~{orders[idx]}集"


def _check_promises(eps: list[dict]) -> list[dict]:
    """门禁 5：伏笔逾期。

    匹配策略（按可靠性从高到低，前两级优先）：
      1) **显式集号**：模型写 payoff 时常带"回收第4集…"、"第7集埋下的…"，
         这是最可靠的信号——同集内只要 plant 文本与 payoff 文本有实质词面重合即可配对；
      2) 全剧模糊匹配：plant 全文 vs payoff 全文的相似度（对措辞改写的兜底）。
    ⚠️ 实测教训：第一版只用"全剧模糊匹配 + 严格阈值"，50 集里误报 41 条 overdue——
    因为 payoff 常写成"回收第7集埋下的养母原始户籍登记档案"，而 plant 是
    "养母当年收养苏念时的老旧户籍登记原始档案"，中间那串定语把相似度稀释到阈值以下。
    模型其实把答案写在了脸上（第7集），我却没用。改为集号优先后误报消失。
    """
    issues: list[dict] = []
    total = len(eps)
    by_order = {e.get("order"): e for e in eps}

    plant_recs: list[dict] = []       # 全部伏笔（按埋设顺序）
    seen_norm: set[str] = set()
    for ep in eps:
        order = ep.get("order")
        for p in (ep.get("plant") or []):
            text = str(p).strip()
            k = _norm(text)
            if not text or k in seen_norm:
                continue
            seen_norm.add(k)
            plant_recs.append({"text": text, "norm": k, "ep": order, "paid": False})

    # 解析 payoff：抽显式集号 + 去掉"回收/第N集/埋下"等格式词后的正文
    _REF_RE = re.compile(r"第\s*(\d+)\s*集")
    _NOISE_RE = re.compile(r"(回收|呼应|兑现|第\s*\d+\s*集|埋下|埋设|埋的|伏笔|的|地|得)")

    payoffs: list[dict] = []
    for ep in eps:
        order = ep.get("order")
        for p in (ep.get("payoff") or []):
            text = str(p).strip()
            if not text:
                continue
            refs = [int(x) for x in _REF_RE.findall(text)]
            core = _norm(_NOISE_RE.sub("", text))
            payoffs.append({"text": text, "ep": order, "refs": refs, "core": core})

    # 配对：先按显式集号 + 词面重合，再全剧模糊匹配
    for po in payoffs:
        best = None
        best_score = 0.0
        for rec in plant_recs:
            if rec["paid"]:
                continue
            if po["refs"] and rec["ep"] in po["refs"]:
                # 同集：放宽阈值
                score = max(_similar(rec["norm"], po["core"]), _similar(rec["norm"], _norm(po["text"])))
                if score >= 0.25 and score > best_score:
                    best, best_score = rec, score
            else:
                score = max(_similar(rec["norm"], po["core"]), _similar(rec["norm"], _norm(po["text"])))
                if score >= 0.6 and score > best_score:
                    best, best_score = rec, score
        if best is not None:
            best["paid"] = True

    # 逾期判定
    orders = [e.get("order") for e in eps]
    for rec in plant_recs:
        if rec["paid"]:
            continue
        try:
            idx = orders.index(rec["ep"])
        except ValueError:
            continue
        elapsed = total - 1 - idx
        if elapsed >= 8:
            issues.append(_issue(
                "error", "promise_overdue", rec["ep"],
                f"第{rec['ep']}集埋下的伏笔「{rec['text'][:40]}」已过 {elapsed} 集仍未回收",
                {"promise": rec["text"], "planted_at": rec["ep"], "elapsed": elapsed},
                "在后续集安排回收，或从大纲里删掉这个伏笔（埋了不收是创作事故）",
            ))
        elif elapsed >= 3:
            issues.append(_issue(
                "warn", "promise_pending", rec["ep"],
                f"第{rec['ep']}集埋下的伏笔「{rec['text'][:40]}」已过 {elapsed} 集未回收",
                {"promise": rec["text"], "planted_at": rec["ep"], "elapsed": elapsed},
                "确认后续有回收计划；小伏笔建议 1-3 集内收掉",
            ))
    return issues


def _check_value_shift_repeat(eps: list[dict]) -> list[dict]:
    """门禁 7：value_shift 与近几集语义重复（换个场景演同一件事）。"""
    issues: list[dict] = []
    for i, ep in enumerate(eps):
        vs = ep.get("value_shift") or {}
        cur = f"{vs.get('from','')} → {vs.get('to','')}".strip(" →")
        if _len_of(cur) < 6:
            continue
        order = ep.get("order")
        start = max(0, i - VALUE_SHIFT_LOOKBACK)
        for prev in eps[start:i]:
            pv = prev.get("value_shift") or {}
            prev_text = f"{pv.get('from','')} → {pv.get('to','')}".strip(" →")
            if _len_of(prev_text) < 6:
                continue
            sim = _similar(cur, prev_text)
            if sim >= 0.7:
                issues.append(_issue(
                    "warn", "value_shift_repeat", order,
                    f"第{order}集的价值转变与第{prev.get('order')}集高度相似（换场景演同一件事）",
                    {"current": cur, "previous": prev_text,
                     "previous_episode": prev.get("order"), "similarity": round(sim, 3)},
                    "让本集推进一件新的事，而不是重复同一种转变",
                ))
                break
    return issues


def _check_causality(eps: list[dict]) -> list[dict]:
    """门禁 8：集间因果——"因此/但是" vs 仅"然后"。

    ⚠️ 这是一条**低置信度**检查，因此只报 warn 且阈值刻意很松。
    理由（实测教训）：卡点是指向下一集的具体动作（"抛出车祸报告"），而 core_push 是
    对本集的概括（"确立复仇信念，潜入书房"）——两者因果成立但极少有词面重叠。
    词面重合不是因果的可靠代理，真正的因果判断由 LLM 评审侧负责（logic_reviewer）。
    这里只在**完全看不出关联**时提示一句，供人扫一眼，不作为结构结论。
    """
    issues: list[dict] = []
    for prev, cur in zip(eps, eps[1:]):
        ho = prev.get("hook_out") or {}
        leads = str(ho.get("leads_to") or "").strip()
        push = str(cur.get("core_push") or "").strip()
        order = cur.get("order")
        if not leads or not push:
            continue
        sim = _similar(_strip_prefix(leads), _strip_prefix(push))
        if sim < 0.15:
            issues.append(_issue(
                "warn", "weak_causality", order,
                f"第{order}集的核心推进点与上一集卡点的字面关联很弱（仅供参考）",
                {"prev_leads_to": leads, "core_push": push, "similarity": round(sim, 3)},
                "若本集确实不是上一集卡点的后果，才需要调整；因果的正式判断以逻辑评审为准",
            ))
    return issues


def _check_double_view(eps: list[dict], bible: dict | None) -> list[dict]:
    """门禁 10：双视图越界——不能提前曝光圣经里标为终局的秘密。

    圣经的 core_mysteries 是贯穿全剧的悬念；若某集 audience_knows_delta
    在剧集前半段就把某条核心悬念整条曝光，报 error。
    """
    issues: list[dict] = []
    mysteries = [str(m).strip() for m in ((bible or {}).get("core_mysteries") or []) if str(m).strip()]
    if not mysteries or not eps:
        return issues
    total = len(eps)
    for i, ep in enumerate(eps):
        delta = str(ep.get("audience_knows_delta") or "").strip()
        if not delta:
            continue
        order = ep.get("order")
        # 前半段（不含最后 1/3）曝光核心悬念 → 越界
        if i < total * 2 / 3:
            for m in mysteries:
                if _similar(delta, m) >= 0.5:
                    issues.append(_issue(
                        "error", "double_view_leak", order,
                        f"第{order}集就让观众知道了贯穿全剧的核心悬念「{m}」，"
                        f"后续反转会失去力量",
                        {"mystery": m, "audience_knows_delta": delta},
                        "把这条信息推到后段揭晓，本集只放出异常或部分线索",
                    ))
                    break
    return issues


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

#: 情绪强度的"悬崖"阈值（2026-09-19）。
#:
#: 只在**集号真正相邻、且两集都已标注**时判：相邻两集强度差 ≥ 该值时报 warn。
#: ⚠️ 这里**只判跳变，不判"太平"** —— "多密才算够"没有校准基线，
#: 给阈值等于拍脑袋（网文的"每 3000-5000 字一个爽点"搬到 500-700 字的短剧
#: 会得出"每集三次"的荒谬结论）。跳变是**相对量**，不需要绝对基线就站得住：
#: 上一集 2 分、下一集 9 分，观众会觉得"这两集不是一部剧"。
_INTENSITY_CLIFF = 5


def _check_emotion_flow(eps: list[dict]) -> list[dict]:
    """门禁 11：情绪强度的落笔与跳变（零 LLM）。

    只对**已标注**（`emotion_intensity` 非 0）的集判，未标注的不参与 ——
    老大纲没有这个字段，不能因此报错（与契约字段一致的兼容原则）。

    ⚠️ **集号必须连续**才判（`o2 - o1 == 1`）。只筛掉未标注的集再两两比较，
    会把第 2 集 → 第 4 集当成"相邻落差"报出来 —— 中间夹着未标注的第 3 集时，
    这两集在观众那里**并不相邻**，调性断裂的判据根本不成立。
    首轮实测（4 集里 1 集未标注）就因此多报了一条，属于会教用户忽略告警的噪音。
    代价是标注稀疏时本门禁会静默变少报 —— 这是**刻意选的方向**：
    "该报没报"远好于"乱报"，因为乱报会让用户学会不看。
    """
    issues: list[dict] = []
    labeled = [(e.get("order"), e.get("emotion_intensity") or 0) for e in eps]
    vals = [(o, v) for o, v in labeled if v]
    if len(vals) < 2:
        return issues

    for (o1, v1), (o2, v2) in zip(vals, vals[1:]):
        # 跨过未标注的集 → 不是真正的相邻对比，跳过
        if not isinstance(o1, int) or not isinstance(o2, int) or o2 - o1 != 1:
            continue
        if abs(v2 - v1) >= _INTENSITY_CLIFF:
            issues.append(_issue(
                "warn", "emotion_cliff", o2,
                f"第{o1}集情绪强度 {v1} 分 → 第{o2}集 {v2} 分，落差 {abs(v2-v1)} 分，"
                f"观众会觉得两集的调性断裂",
                {"from_episode": o1, "from": v1, "to_episode": o2, "to": v2},
                "要么在第{}集加一段过渡性冲突把强度抬上来，"
                "要么把第{}集的峰值拆到两集里".format(o2, o2),
            ))
    return issues


def _check_power_relation(eps: list[dict]) -> list[dict]:
    """门禁 12：权力关系是否落笔（零 LLM）。

    918 文件的「写前大纲」把"权力关系（最重要的步骤）"列为动笔前必做 ——
    它决定**台词给谁说什么**。这里只查"有没有写清"，不查"写得对不对"
    （后者的目标函数是"好看"，属于 LLM 审查的范畴）。

    三条判据，全部是确定性字符串判断：
      1. aggressor / defender 缺一 → warn（无法判断台词该给谁）；
      2. aggressor 与 defender 是**同一个人** → error（一集里没有冲突，是过场）；
      3. focus 缺失或属于"抽象概念"（公司控制权/尊严/命运） → warn
         （抽象焦点无法指导具体台词，与 stakes 的空泛判据同理）。
    """
    issues: list[dict] = []
    for ep in eps:
        pw = ep.get("power") or {}
        if not isinstance(pw, dict):
            continue
        order = ep.get("order")
        agg = str(pw.get("aggressor") or "").strip()
        dfd = str(pw.get("defender") or "").strip()
        focus = str(pw.get("focus") or "").strip()
        if not agg and not dfd and not focus:
            continue                       # 整块都没写 = 老数据，不报
        if agg and dfd and agg == dfd:
            issues.append(_issue(
                "error", "power_self", order,
                f"第{order}集的主动方与被动方是同一个角色「{agg}」——"
                f"这一集没有对抗关系，是过场",
                {"aggressor": agg, "defender": dfd},
                "让另一个人成为本集的施压方，或把这一集并入相邻的冲突集",
            ))
        elif not agg or not dfd:
            missing = "主动方" if not agg else "被动方"
            issues.append(_issue(
                "warn", "power_incomplete", order,
                f"第{order}集只写了{('被动方' if not agg else '主动方')}，"
                f"缺 {missing}——台词该给谁说不清楚",
                {"power": pw},
                "补上本集主动推进/施压的人，与承受压力的那一个",
            ))
        if focus:
            vague = [p for p in VAGUE_POWER_FOCUS if p in focus]
            if vague:
                issues.append(_issue(
                    "warn", "power_focus_vague", order,
                    f"第{order}集的争夺焦点「{focus}」太抽象，"
                    f"无法指导具体台词",
                    {"focus": focus, "hits": vague},
                    "把它落成一件**具体可执行**的目标"
                    "（如「她要拿到那份签字」而不是「公司控制权」）",
                ))
    return issues


def _check_structure(eps: list[dict]) -> list[dict]:
    """门禁（2026-11-07 重建中）：只查**能确凿判定**的结构问题。

    保留的两条：
      1) `episode_empty` —— 这一集没有正文（或仍是"待生成"占位符）。生成时
         必然从零编，是唯一不需要理解内容就能确定的事实。
      2) `episode_gap`   —— 集号不连续 / 有重号。数据坏了，下游按集号取内容
         会取错或取空。

    停用的（函数都还在，等 LLM 评审层来接，不要在这里重新发明）：
      · `_check_promises`           伏笔回收 —— 字符相似度做不了语义配对
      · `_check_hook_chain`         钩子承接
      · `_check_hook_type_repeat`   钩子类型套路化
      · `_check_escalation`         升级停滞
      · `_check_value_shift_repeat` 价值转变重复
      · `_check_causality`          因果强弱
      · `_check_double_view`        核心悬念提前曝光
      · `_check_payoff_presence` / `_check_payoff_repeat`  爽点缺失/套路
      · `_check_emotion_flow` / `_check_power_relation`
      · `_check_value_shift` / `_check_stakes_wording` /
        `_check_hook_enum` / `_check_hook_leads_to`  单集契约写法

    ⚠️ 停用它们的决定性理由（不是"懒得维护"）：draft #819 实测 44 条
    `promise_overdue` 里 25 条是配对失败而非真问题 —— plant 一格塞 2~3 条伏笔
    （38/85 条含分号）、payoff 也合条写，字符相似度被稀释到阈值以下。
    误报会训练用户忽略整份报告，比不报更糟。
    """
    issues: list[dict] = []
    if not eps:
        return issues

    orders = [e.get("order") for e in eps]
    # 重号
    seen: set = set()
    dups: list = []
    for o in orders:
        if o in seen:
            dups.append(o)
        seen.add(o)
    if dups:
        issues.append(_issue(
            "error", "episode_duplicate", None,
            f"有重复的集号：{'、'.join(str(x) for x in sorted(set(dups))[:10])}",
            {"orders": sorted(set(dups))},
            "集号必须唯一，否则按集号读写会取到别的集",
        ))

    # 断裂：只报缺口，不要求从 1 开始（导入的草稿可能只有后半段）
    try:
        ints = sorted(int(o) for o in orders if o is not None)
    except (TypeError, ValueError):
        ints = []
    if ints:
        gaps = [n for n in range(ints[0], ints[-1] + 1) if n not in set(ints)]
        if gaps:
            issues.append(_issue(
                "warn", "episode_gap", None,
                f"集号不连续，缺第 {'、'.join(str(x) for x in gaps[:10])}"
                f"{' 等' if len(gaps) > 10 else ''} 集",
                {"missing": gaps},
                "补齐缺失的集，或确认这是有意留空",
            ))

    # 空集
    empty = []
    for ep in eps:
        syn = str(ep.get("synopsis") or "").strip()
        if not syn or "待生成" in syn[:20]:
            empty.append(ep.get("order"))
    if empty:
        issues.append(_issue(
            "warn", "episode_empty", None,
            f"第 {'、'.join(str(x) for x in empty[:10])}"
            f"{' 等' if len(empty) > 10 else ''} 集还没有大纲正文"
            f"（共 {len(empty)} 集）。这些集生成剧本时没有依据，只能自由发挥。",
            {"episodes": empty, "total": len(eps)},
            "用「重新生成此集」补上这些集的大纲",
        ))

    return issues


def check_outline(outline: dict, *, bible: dict | None = None,
                  include_style: bool = True) -> dict:
    """对整部大纲跑剧情结构门禁。**零 LLM 调用**。

    返回 drama_report:
      {"issues": [...], "summary": {"error": n, "warn": n, "checked": n},
       "checked_at": ISO, "checked_upto": N, "passed": bool}
    issues 的 schema 与 consistency_lint 一致，前端可直接复用同一套标注。

    注意：只标注，不改写（v2 已定决策 2）。passed=False 也只表示"有问题需看"，
    不代表阻断——是否继续生成由用户决定。

    include_style: 是否顺带跑中文文风检查（翻译腔/外语残留/欧美剧术语）。
      默认 True —— 生成流水线与独立闸门只跑这一个函数，需要一份"全都查了"的报告。
      **体检引擎要传 False**：那边「文风」是独立的一类（check_style 会自己扫同一份
      大纲），两边都扫就会让「一键体检」把同一条问题报两遍（用户看到 4 个真问题
      变 8 条，还以为是不同的集）。
    """
    eps = list(outline.get("chapters") or outline.get("episodes") or [])
    eps = [e for e in eps if isinstance(e, dict)]
    eps.sort(key=lambda e: e.get("order", 0))
    bible = bible if bible is not None else (outline.get("story_bible") or {})

    issues: list[dict] = []

    # 2026-11-07：单集的内容性判据（价值转变写法、代价措辞、钩子枚举、钩子指向）
    # 随大纲改版一并停用 —— 它们读的是已不再产出的契约字段，留着只会对
    # 新版大纲全量空转、对老数据继续误报。函数保留，等 LLM 评审层来接。

    # 中文文风检查（翻译腔 / 外语残留 / 欧美剧术语）。零 LLM。
    # 用 error 的情况只有"出现外语正文"，其余是 warn——文风是建议性质。
    # include_style=False 时跳过：调用方（体检引擎）自己有独立的「文风」一类，
    # 见本函数 docstring。
    if include_style:
        try:
            from .chinese_style import scan_outline_style
            issues += scan_outline_style(outline)
        except Exception as e:  # noqa: BLE001
            logger.warning("chinese_style 检查失败: %s", e)

    # ------------------------------------------------------------------
    # 2026-11-07 裁定：**内容性判据全部停用**，只留结构性的
    # ------------------------------------------------------------------
    # 用户原话："机械化判断伏笔回收也不对。不能机械化的判断内容性的问题，
    # 这个应该单独给 llm 判断（现在可以先把这个机械话伏笔回收判断下掉）。"
    #
    # 这条裁定的依据是实测：draft #819（80 集）跑出 44 条 promise_overdue，
    # 其中 19 条是真没回收，另外 25 条是**配对失败**——plant 一格塞 2~3 条伏笔
    # （38/85 条含分号），payoff 也合条写，字符相似度被稀释到 0.25 阈值以下。
    # 而"这一集的钩子接没接上""因果强不强""爽点是否套路"更是纯语义判断，
    # 字符级相似度做不了，误报会训练用户忽略整个报告。
    #
    # 所以现在只剩：集号连续性、空集、缺正文。这些能确凿判定、不会误报。
    # 内容性检查等换成 LLM 评审之后再回来 —— 下面的函数**保留不删**，
    # 到时候接进 LLM 评审那一层复用，不要在这里重新发明一套。
    issues += _check_structure(eps)

    # 排序：error 优先、按集号
    issues.sort(key=lambda it: (0 if it["level"] == "error" else 1,
                                it.get("episode") or 0))

    n_err = sum(1 for it in issues if it["level"] == "error")
    n_warn = sum(1 for it in issues if it["level"] == "warn")
    report = {
        "issues": issues,
        "summary": {"error": n_err, "warn": n_warn, "checked": len(eps)},
        "checked_at": datetime.now().isoformat(timespec="seconds"),
        "checked_upto": (eps[-1].get("order") if eps else 0),
        "passed": n_err == 0,
    }
    # D3/D6: 带上正向账本的结构数据，供前端画钩子链与升级曲线（纯推导，零成本）
    try:
        from .state_ledger import build_positive_ledger
        report["structure"] = build_positive_ledger(outline)
    except Exception as e:  # noqa: BLE001
        logger.warning("structure 推导失败: %s", e)
        report["structure"] = {}
    logger.info("drama_gate: %d 集, error=%d warn=%d", len(eps), n_err, n_warn)
    return report


def build_fix_hints(report: dict) -> list[dict]:
    """把 issues 汇总成"按集可执行的修订建议"，供前端一键修订/手动参考。

    只产出建议，不调用 LLM、不改写（与 v2 决策 2 一致）。
    """
    by_ep: dict[Any, dict] = {}
    for it in report.get("issues") or []:
        ep = it.get("episode")
        slot = by_ep.setdefault(ep, {"episode": ep, "errors": [], "warnings": [], "suggestions": []})
        (slot["errors"] if it["level"] == "error" else slot["warnings"]).append(it["message"])
        hint = it.get("fix_hint") or ""
        if hint and hint not in slot["suggestions"]:
            slot["suggestions"].append(hint)
    out = [by_ep[k] for k in sorted(by_ep, key=lambda x: (x is None, x or 0))]
    return out
