"""去 AI 味引擎 · 词汇/句式层: 分级检测 + 注入。

三大能力:
  1. detect_ai_taste(text) -> AiTasteReport
     规则层检测"AI 味", 每条命中带 **A/B/C 三级**(见下), 返回 0-100 相对分 + 逐条样例。
  2. inject_human_flaws(text, level, allow_typo) -> str
     反向注入"人味瑕疵": 口语碎词、低频的/得/地混用、常见别字。带过量护栏。
  3. build_deai_prompt(text, ...) / build_deai_banned_words()
     构造"去 AI 味"改写提示词。

── 分级口径 (整理自四个中文去AI味开源项目, 见 docs/RESEARCH-去AI感方法论.md) ──
  A 级 = 硬信号, 命中即改。多源一致或可脚本量化。
  B 级 = 软信号, 只标出让用户定, 不擅自动。需语境判断。
  C 级 = 看着像 AI 味但实测站不住 / 属类型规范 / 属作者习惯。**一律不碰**。

  优先级: 作者风格 ＞ C 禁动 ＞ A 硬改 ＞ B 软判。

  两个容易搞反的点(多源实测结论, 别改回去):
    · 情绪**直说**("她怕了") 不是 AI 味 —— 人类比 AI 更常直说(29% vs 8%)。
      只有**抽象情绪壳**("心中涌起一股暖流")才是。所以 D1 只抓壳, 不抓直陈。
    · 标点的字形差异不是稳定信号。Pangram 的公开管线会 unidecode 压平标点;
      Gemini/GPT 系里破折号只有约 0.7 倍基线, 不是 5 倍。故 S3 降为 B 级。

设计为纯函数、无外部依赖(除标准库 re/random), 便于单测。
"""
from __future__ import annotations

import random
import re
from dataclasses import dataclass, field
from typing import Literal

# 分级与来源标记
Level3 = Literal["A", "B", "C"]

# ============================================================
# 一、词表 (分级)
# ============================================================
# 结构: {类别码: {"label": 中文说明, "level": A/B/C, "src": 来源, "words": [...]}}
# src: OS=oh-story deslop, HB=deai/hard-bans, LF=lieflat, HW=human-writing, SE=sepia, DR=本项目短剧特化

LEXICON: dict[str, dict] = {
    # ---- 情态/程度: 网文一级模板词, 出现即处理 ----
    "W1_情态模板": {
        "label": "情态模板词(仿佛/一丝/隐约…)",
        "level": "A", "src": "OS",
        "words": [
            "仿佛", "犹如", "宛若", "如同", "一丝", "一抹", "一缕", "些许",
            "几分", "隐约", "毫无征兆", "几不可闻", "微不可察", "若有若无",
            "不易察觉", "悄无声息", "不露痕迹",
        ],
    },
    # ---- 表情/微动作: 短剧里最密的 AI 指纹 ----
    "W2_表情微动作": {
        "label": "表情微动作套话(眼中闪过/嘴角勾起…)",
        "level": "A", "src": "OS",
        "words": [
            "眼中闪过", "眼底闪过", "嘴角勾起", "嘴角微扬", "眉头微皱",
            "眉眼低垂", "瞳孔微缩", "瞳孔收缩", "瞳孔一缩", "指节泛白",
            "眼神锐利", "目光锐利", "眸光", "眸色", "深邃的目光",
        ],
    },
    # ---- 心理/判断: 抽象情绪壳, 读者看不到画面 ----
    "W3_心理判断": {
        "label": "心理套话与空判断(心头一震/不容置疑…)",
        "level": "A", "src": "OS",
        "words": [
            "心中一动", "心头一震", "心头一紧", "心中一凛", "心下了然",
            "心中暗道", "心底泛起", "心中涌起", "一股暖流", "喉头一紧",
            "不容置疑", "不容置喙", "显而易见", "毫无疑问", "不可否认",
            "前所未有", "令人窒息", "令人动容",
        ],
    },
    # ---- 动作套话 ----
    "W4_动作套话": {
        "label": "动作套话(深吸一口气/缓缓开口…)",
        "level": "A", "src": "OS",
        "words": [
            "深吸一口气", "深吸了口气", "缓缓开口", "缓缓说道", "沉声说道",
            "压低声音", "不由自主", "情不自禁", "自然而然", "话锋一转",
        ],
    },
    # ---- 商业/汇报黑话: 短剧里出现基本是 AI 或写串了 ----
    "W5_商业黑话": {
        "label": "商业/汇报黑话(赋能/抓手/闭环…)",
        "level": "A", "src": "HB",
        "words": [
            "赋能", "抓手", "商业闭环", "价值闭环", "能力沉淀", "拉通",
            "底层逻辑", "顶层设计", "认知跃迁", "价值释放", "能力建设",
            "降本增效", "内容矩阵", "全链路", "组合拳", "打开想象空间",
            "结构性机会", "关键命题", "深层逻辑", "技术底座", "技术壁垒",
            "单点风险", "颗粒度", "生态位", "方法论", "范式", "心智",
            "协同", "对齐", "沉淀", "链路",
        ],
    },
    # ---- 抽象名词化的抒情词 ----
    "W6_抒情装腔": {
        "label": "抒情装腔词(微光/褶皱/滚烫…)",
        "level": "B", "src": "HW+OS",
        "words": [
            "安放", "抵达", "微光", "褶皱", "丰盈", "滚烫", "轻盈", "赤裸",
            "剥开", "锋利", "坚硬", "柔软", "勇敢", "温柔",
        ],
    },
    # ---- 概念化抽象名词: 短剧台词里空泛 ----
    "W7_抽象名词": {
        "label": "抽象名词代替具体物(氛围/张力/温度…)",
        "level": "B", "src": "DR",
        "words": [
            "气息", "氛围", "意味", "张力", "温度", "重量", "轮廓", "边界",
            "维度", "质感", "底色", "情绪价值", "存在感", "疏离感", "宿命感",
            "宿命", "羁绊",
        ],
    },
    # ---- 万能动词: 万金油式抽象动作 ----
    "W8_万能动词": {
        "label": "万能抽象动词(弥漫/交织/涌动…)",
        "level": "A", "src": "DR",
        "words": [
            "弥漫", "蔓延", "交织", "涌动", "翻涌", "萦绕", "笼罩", "攫住",
            "侵蚀", "吞没", "撕扯", "碾过", "灼烧",
        ],
    },
    # ---- 全称量词: AI 抬高语气的典型 ----
    "W9_全称量词": {
        "label": "全称量词抬高(每一个/整个世界…)",
        "level": "A", "src": "DR",
        "words": [
            "每一个", "每一次", "每一寸", "每一丝", "整个世界", "所有的一切",
            "全部的", "倾尽所有", "用尽全力",
        ],
    },
    # ---- 套路喻体 ----
    "W10_套路喻体": {
        "label": "套路化喻体(潮水/绷紧的弦/漩涡…)",
        "level": "A", "src": "DR",
        "words": [
            "如潮水", "像潮水", "潮水般", "绷紧的弦", "藤蔓", "漩涡", "蛛网",
            "潮汐", "涟漪", "野火", "困兽", "如坠冰窟", "坠入深渊",
        ],
    },
    # ---- 廉价钩子/预告: 短剧里最伤观感的一类 ----
    "W11_廉价钩子": {
        "label": "廉价钩子与剧透预告(就在这时/他不知道的是…)",
        "level": "A", "src": "DR",
        "words": [
            "就在这时", "然而", "事情并没有这么简单", "他不知道的是",
            "她不知道的是", "命运的齿轮", "殊不知", "殊不知的是", "而这一切",
            "谁也没有想到", "谁能想到", "原来这一切", "从这一刻开始",
            "才刚刚开始", "真正的考验", "他这才意识到", "她这才意识到",
        ],
    },
    # ---- 弱化副词: 密度信号, 单独出现不算 ----
    "W12_弱化副词": {
        "label": "弱化副词成串(缓缓/微微/轻轻/淡淡)",
        "level": "B", "src": "OS",
        "words": ["缓缓", "微微", "轻轻", "淡淡", "慢慢", "渐渐"],
    },
    # ---- 语境敏感: 真实突发/口语里合法 ----
    "W13_语境敏感": {
        "label": "语境敏感词(突然/似乎/瞬间…)",
        "level": "B", "src": "OS",
        "words": ["陡然", "骤然", "猛然", "瞬间", "猛地", "赫然"],
    },
}

#: 逗号等平级并列过密的判据(顿号三连): AI 约 3.21/千字 vs 人类 1.78/千字
_DUNHAO_DENSE_PER_KILO = 3.0
#: 弱化副词成串判据: 合计每千字 > 3 才算成串
_WEAK_ADV_PER_KILO = 3.0

# ============================================================
# 二、句式指纹 (S/D 系列)
# ============================================================
# 每条: (code, label, level, src, 正则, 权重)
# 权重沿用经验值: 3.0 = 强信号, 1.0 = 弱信号

_PAT_S1_TURN = re.compile(
    r"(不是[^，。！？,.!?]{1,20}?而是"
    r"|与其说[^，。！？,.!?]{1,20}?不如说"
    r"|并非[^，。！？,.!?]{1,20}?只是"
    r"|不仅[^，。！？,.!?]{1,20}?更是"
    r"|表面上[^，。！？,.!?]{1,20}?实际上"
    r"|与其[^，。！？,.!?]{1,20}?不如"
    r"|不在于[^，。！？,.!?]{1,20}?而在于"
    r"|看似[^，。！？,.!?]{1,20}?实则)"
)
# 三连排比: 逗号并列三项且末项带"更/还/甚至"
_PAT_S2_TRIPLE = re.compile(
    r"[，,][^，,。！？.!?]{2,15}[，,][^，,。！？.!?]{2,15}[，,]\s*"
    r"(更|还|甚至|以及)[^。！？.!?]{2,15}"
)
# 破折号抒情插入(B 级: 标点不是稳定信号)
_PAT_S3_DASH = re.compile(r"[—–]{1,2}[^。！？.!?]{4,40}")
# 抽象情绪壳: 情绪被"涌起/泛起"等抽象动词包装起来, 且没有具体动作
# 注意: "她怕了" / "他手在抖" 都不命中 —— 那是人类写法, 不是 AI 味。
_PAT_D1_EMO_SHELL = re.compile(
    r"(涌起|涌上|泛起|升起|涌现|袭来|蔓延)[一了]?[^，。,.]{0,6}"
    r"(恐惧|愤怒|悲伤|绝望|喜悦|不安|心悸|战栗|颤栗|寒意|暖意|酸楚|悲凉|惆怅|失落)"
    r"|(感到|感受到)[一了]?[^，。,.]{0,4}"
    r"(一丝|一抹|些许|难以言喻|说不清)[^。]{0,8}"
)
# 翻译腔①: 过长前置定语(名词前"的"字修饰超长, 或两个以上"的"连用)
_PAT_T1_LONG_MOD = re.compile(r"[^，。！？,.!?\s]{6,}的[^，。！？,.!?\s]{2,}的[^，。！？,.!?\s]{2,}")
# 翻译腔②: "当……的时候/时" 前置时间从句
_PAT_T2_WHEN = re.compile(r"当[^，。！？,.!?]{2,20}(的时候|时)[，,]")
# 翻译腔③: 前置话题壳 "对于……来说/对……而言/关于……"
_PAT_T3_TOPIC = re.compile(r"(对于[^，。！？,.!?]{2,20}(来说|而言)|就[^，。！？,.!?]{2,12}而言|关于[^，。！？,.!?]{2,12})[，,]")
# 翻译腔④: 句首连接词当路标(AI 连续段首尤其明显)
_PAT_T4_CONNECT = re.compile(r"(^|\n)\s*(然而|因此|此外|与此同时|更重要的是|总而言之)[，,]")
# 翻译腔⑤: "这意味着/换句话说" 抬价壳
_PAT_T5_MEANS = re.compile(r"(这意味着|这表明|这说明|换句话说|也就是说)[，,]")

PATTERNS: list[tuple] = [
    ("S1", "翻案腔(不是A而是B / 看似A实则B)", "A", "LF+HW+OS", _PAT_S1_TURN, 3.0),
    ("S2", "三连排比抬价", "A", "LF", _PAT_S2_TRIPLE, 2.0),
    ("S3", "破折号抒情插入", "B", "OS", _PAT_S3_DASH, 1.0),
    ("D1", "抽象情绪壳(情绪被抽象动词包装)", "A", "OS+SE", _PAT_D1_EMO_SHELL, 2.5),
    ("T1", "翻译腔·过长前置定语", "A", "LF", _PAT_T1_LONG_MOD, 0.5),
    ("T2", "翻译腔·'当…时'前置从句", "A", "LF", _PAT_T2_WHEN, 0.5),
    ("T3", "翻译腔·前置话题壳", "A", "LF", _PAT_T3_TOPIC, 0.5),
    ("T4", "翻译腔·句首连接词路标", "B", "LF", _PAT_T4_CONNECT, 0.5),
    ("T5", "翻译腔·'这意味着'抬价壳", "B", "LF", _PAT_T5_MEANS, 0.5),
]

# ============================================================
# 三、C 级禁动清单 (看着像 AI 味但实测站不住 / 类型规范 / 作者习惯)
# ============================================================
# 这些是**说明性**的, 不参与打分, 只在报告里回传, 提醒改写方和用户"别动这些"。
# 依据: deai/calibration.md 0.5-0.6 反误伤总表 + sepia 网文误伤点 + oh-story 保留创作意图。
C_禁动 = [
    "句长/段长不够参差 —— 与人类无显著差别, 不为此拆句拆段",
    "被动句、名词化、长句本身 —— 正常中文书面语, 人类同样用",
    "正文里的'首先…其次…最后' —— 与人类无差别",
    "句内同构排比('更高效、更专注') —— 人类用得不比 AI 少",
    "设问与问句小标题 —— 不是 AI 味",
    "网文/短剧的强因果、伏笔回收、爽点按期结算 —— 读者的追读契约",
    "短段落、密集分段、角色多、线性推进 —— 类型规范",
    "主角心理独白多 —— 短剧强项; 病在'独白只有抽象情绪壳'(见 D1)",
    "情绪直说('她怕了') —— 人类比 AI 更常直说, 不是 AI 味",
    "角色口癖、作者惯用句式 —— 作者习惯优先级最高",
]

# ============================================================
# 四、命中与报告
# ============================================================


@dataclass
class AiTasteHit:
    """一类指纹的命中结果。"""
    code: str          # S1 / W1 / D1 ...
    label: str         # 中文说明
    count: int
    samples: list[str] = field(default_factory=list)  # 命中片段样例(最多8条)
    level: str = "A"   # A 必改 / B 标出 / C 禁动
    src: str = ""      # 来源标记, 便于回溯口径

    def to_dict(self) -> dict:
        return {
            "code": self.code, "label": self.label, "count": self.count,
            "samples": self.samples[:8], "level": self.level, "src": self.src,
        }


@dataclass
class AiTasteReport:
    """检测报告。

    ⚠️ `score` 是**相对指标**, 不是校准过的概率, 更不是"AI 率"。
       它的用途是"同一批文本改前改后比一比", 别当验收标准用:
       sepia 的 detector 研究记录过, 迭代改写可把人类文本的检测分从 0% 推到 100%
       —— 追着分数改, 结果是越改越可疑。
    """
    score: int                       # 0-100, 越高越 AI
    per_kilo: float                  # 每千字加权命中数(A 级为主)
    char_count: int
    hits: list[AiTasteHit] = field(default_factory=list)
    level: str = "轻度"               # 轻度/中度/重度, 按 A 级密度与段长均匀度估
    low_confidence: bool = False     # 样本过短, 密度不稳
    a_count: int = 0                 # A 级命中总次数
    b_count: int = 0                 # B 级命中总次数
    c_exempt: list[str] = field(default_factory=list)  # C 级"别动这些"提醒

    @property
    def a_per_kilo(self) -> float:
        return self.a_count / (self.char_count / 1000.0) if self.char_count else 0.0

    def to_dict(self) -> dict:
        return {
            "score": self.score,
            "per_kilo": round(self.per_kilo, 2),
            "a_count": self.a_count,
            "b_count": self.b_count,
            "a_per_kilo": round(self.a_per_kilo, 2),
            "level": self.level,
            "low_confidence": self.low_confidence,
            "char_count": self.char_count,
            "hits": [h.to_dict() for h in self.hits],
            "c_exempt": self.c_exempt,
            "note": "score 为相对指标, 用于同一文本改前/改后对比, 不代表任何检测平台的通过率。",
        }


def _find_samples(pattern: re.Pattern, text: str, limit: int = 8) -> list[str]:
    out = []
    for m in pattern.finditer(text):
        s = m.group(0).strip()
        if s and s not in out:
            out.append(s)
        if len(out) >= limit:
            break
    return out


def _is_format_line(line: str) -> bool:
    """分镜格式行: 这些行里的词/标点是格式的一部分, 不是文风。

    短剧剧本(storyboard)的 △动作 / [场景] / 出场角色 / 角色名【提示】: 台词
    等行, 直接拿去算文风会严重误报 —— 例如"【特效：光影弥漫】"里的"弥漫"。
    """
    s = line.strip()
    if not s:
        return True
    if s.startswith(("△", "[", "【", "出场角色", "场景", "场:", "景:", "人物:", "(出字幕")):
        return True
    if "△" in s or "【特效" in s or "【慢镜" in s:
        return True
    return False


def strip_format_lines(text: str) -> str:
    """剔除分镜格式行, 只留"人写的文字"部分用于文风检测。

    注意: 台词行本身保留 —— 台词是最能看出 AI 腔的地方。
    """
    keep = [ln for ln in (text or "").split("\n") if not _is_format_line(ln)]
    return "\n".join(keep)


def detect_ai_taste(text: str) -> AiTasteReport:
    """规则层 AI 味检测。返回相对分(0-100)+分级命中。"""
    raw = text or ""
    n = len(raw)
    if n == 0:
        return AiTasteReport(score=0, per_kilo=0.0, char_count=0, c_exempt=list(C_禁动))

    # 标点类(破折号)只在剔掉格式行后的文本上统计, 否则分镜的 —— 分隔符会误报。
    text_for_punct = strip_format_lines(raw)
    # 统计口径: 用剔格式行后的长度, 避免分镜格式把分母撑大、把密度压低。
    denom_src = text_for_punct or raw
    n_eff = len(denom_src)

    hits: list[AiTasteHit] = []
    weighted = 0.0
    a_count = 0
    b_count = 0

    # ---- 句式指纹 ----
    for code, label, level, src, pat, weight in PATTERNS:
        src_text = text_for_punct if code == "S3" else denom_src
        c = len(pat.findall(src_text))
        if not c:
            continue
        hits.append(AiTasteHit(code, label, c, _find_samples(pat, src_text), level, src))
        weighted += c * weight
        if level == "A":
            a_count += c
        else:
            b_count += c

    # ---- 词表指纹 ----
    for cat, meta in LEXICON.items():
        code = cat.split("_")[0]
        level = meta["level"]
        words = meta["words"]
        cnt = 0
        samples: list[str] = []
        for w in words:
            k = denom_src.count(w)
            if not k:
                continue
            cnt += k
            if w not in samples and len(samples) < 8:
                samples.append(w)
        if not cnt:
            continue

        # W12 弱化副词 / W13 语境敏感 是**密度**信号: 孤立出现合法,
        # 成串才算病。这里先按普通权重收, 结算时看密度降级。
        dense_only = code in ("W12", "W13")
        per_kilo_cat = cnt / (n_eff / 1000.0) if n_eff else 0.0
        if dense_only and per_kilo_cat <= _WEAK_ADV_PER_KILO:
            level = "C"          # 未成串 → 不碰
        elif dense_only:
            level = "B"          # 成串 → 标出让用户定

        weight = 1.5 if code in ("W10_套路喻体", "W11_廉价钩子") else 1.0
        # W7/W6 是 B 级软信号, 权重打折, 免得喧宾夺主
        if level == "B":
            weight *= 0.5
        elif level == "C":
            weight = 0.0

        hits.append(AiTasteHit(code, meta["label"], cnt, samples, level, meta["src"]))
        weighted += cnt * weight
        if level == "A":
            a_count += cnt
        elif level == "B":
            b_count += cnt

    # ---- 顿号三连(A 级, 量化判据) ----
    dunhao = denom_src.count("、")
    dunhao_pk = dunhao / (n_eff / 1000.0) if n_eff else 0.0
    if dunhao and dunhao_pk > _DUNHAO_DENSE_PER_KILO:
        hits.append(AiTasteHit(
            "P1", "顿号并列过密(每千字顿号偏多)", dunhao,
            [f"{dunhao_pk:.1f}/千字"], "A", "LF"))
        weighted += (dunhao_pk - _DUNHAO_DENSE_PER_KILO) * 2.0
        a_count += 1

    per_kilo = weighted / (n_eff / 1000.0) if n_eff else 0.0
    # 评分: per_kilo 到 score 的映射。经验: 真人网文 per_kilo≈2-4, AI≈8-20。
    # 用 sigmoid 风格压缩到 0-100, per_kilo=6 → ~50 分, per_kilo=15 → ~85 分。
    score = int(round(100 * (1 - 1 / (1 + (per_kilo / 6.0) ** 1.6))))
    score = max(0, min(100, score))

    a_pk = a_count / (n_eff / 1000.0) if n_eff else 0.0
    if a_pk < 3:
        grade = "轻度"
    elif a_pk < 8:
        grade = "中度"
    else:
        grade = "重度"

    return AiTasteReport(
        score=score, per_kilo=per_kilo, char_count=n, hits=hits,
        level=grade, low_confidence=n < 200,
        a_count=a_count, b_count=b_count, c_exempt=list(C_禁动),
    )


# ============================================================
# 五、人味瑕疵注入 (H1-H6) —— 带过量护栏
# ============================================================

FlawLevel = Literal["none", "light", "medium", "heavy"]

# H2 常见别字/谐音替换对 (双向或单向). 只替换"叙述"里出现的, 频率极低.
# 用最常见、读者一眼能懂是"手误"的那种, 不影响理解。
_TYPO_PAIRS: list[tuple[str, str]] = [
    ("的话说", "得话说"),
    ("在意", "再意"),
    ("已经", "己经"),
    ("那么", "那末"),
    ("应该", "因该"),
    ("突然", "突燃"),
]

#: 台词行的引号形式。短剧分镜两种都常见: 中文引号"…" / "…" 与 ASCII "…"。
#  ⚠️ 必须同时认 ASCII 引号: 生成的分镜里 `林晚: "我不信。"` 是最常见形态,
#     只认中文引号会导致 H3/H4(口语前缀)**整篇一处都不动**——实测踩过。
_QUOTE_OPEN = ("“", "「", "『", '"', "‘")
# H1 的/得/地: 在"动词+得+副词"或"副词+地+动词"场景做低频混用
_DE_DI: list[tuple[re.Pattern, str]] = [
    (re.compile(r"([一-龥])地([一-龥])"), r"\1的\2"),
]

# H3/H4 口语碎词, 加在台词句首/句尾
# ⚠️ 替换不复用: 同一个前缀在一篇里最多用 2 次, 否则"每个动作都垫了一下"
#    本身就成了新指纹(oh-story/deai 都点过这条)。
_ORAL_PREFIX = ["嗯，", "那个，", "啧，", "咳，", "唉，", "呃，", "哎，", "行吧，"]
_ORAL_SUFFIX = ["啊。", "呗。", "呢。", "嘛。", "吧。", "……"]

#: 按档位的**改动比例上限**(oh-story 过度去AI味保护):
#: 轻度 ≤15% / 中度 ≤25% / 重度 ≤35%。超限就不再动手, 宁可少改。
_CAP = {"none": 0.0, "light": 0.15, "medium": 0.25, "heavy": 0.35}
#: 按档位的单行命中概率
_RATE = {"none": 0.0, "light": 0.15, "medium": 0.35, "heavy": 0.6}
#: 同一个口语前缀最多复用次数
_ORAL_REUSE_MAX = 2


def _rate_for_level(level: FlawLevel) -> float:
    return _RATE.get(level, 0.0)


def _cap_for_level(level: FlawLevel) -> float:
    return _CAP.get(level, 0.0)


def inject_human_flaws(
    text: str,
    level: FlawLevel = "light",
    allow_typo: bool = True,
    seed: int | None = None,
) -> str:
    """按档位注入人味瑕疵。level 越高改动越多, 但**改动行数有上限**。

    护栏(整理自 oh-story 的"过度去AI味保护", 见 docs/RESEARCH-去AI感方法论.md):
      · 累计改动行数不超过 `_CAP[level]` 比例 —— 超过就停手, 宁可少改。
        改过头会造出比原来更假的新指纹。
      · 同一口语前缀最多复用 `_ORAL_REUSE_MAX` 次(替换不复用)。
      · 只做"轻量、可懂"的改动, 不动数字; 分镜格式行(△/【】/出场角色/场景)一律跳过。

    返回新文本, 原文本不变。
    """
    if level == "none" or not text:
        return text
    rng = random.Random(seed)
    rate = _rate_for_level(level)
    cap_lines = max(1, int(len(text.split("\n")) * _cap_for_level(level)))

    lines = text.split("\n")
    out_lines: list[str] = []
    changed = 0                       # 已改动的行数(受 cap 约束)
    prefix_used: dict[str, int] = {}

    for line in lines:
        s = line
        if changed >= cap_lines or _is_format_line(line):
            out_lines.append(s)
            continue

        touched = False
        # H3/H4: 台词句加口语前缀(中/英文引号都认, 见 _QUOTE_OPEN 注释)
        if any(q in s for q in _QUOTE_OPEN) and rng.random() < rate:
            for lq in _QUOTE_OPEN:
                idx = s.find(lq)
                if idx >= 0 and rng.random() < 0.6:
                    # 替换不复用: 挑一个还没用满的前缀
                    avail = [p for p in _ORAL_PREFIX
                             if prefix_used.get(p, 0) < _ORAL_REUSE_MAX]
                    if avail:
                        pre = rng.choice(avail)
                        prefix_used[pre] = prefix_used.get(pre, 0) + 1
                        s = s[: idx + 1] + pre + s[idx + 1:]
                        touched = True
                    break
        # H5: 句尾口语语气词(仅台词行, 且该行已有前缀时不再叠加)
        if (not touched and allow_typo and any(q in s for q in _QUOTE_OPEN)
                and rng.random() < rate * 0.3):
            for lq_close in ("”", "」", '"'):
                idx = s.rfind(lq_close)
                if idx > 0 and s[idx - 1] in "。！？!?":
                    suf = rng.choice(_ORAL_SUFFIX)
                    s = s[: idx - 1] + suf + s[idx:]
                    touched = True
                    break
        # H1: 地→的 低频混用(仅叙述)
        if allow_typo and rng.random() < rate * 0.5:
            pat, _ = _DE_DI[0]
            m = pat.search(s)
            if m:
                s = s[: m.start()] + m.group(1) + "的" + m.group(2) + s[m.end():]
                touched = True
        # H2: 别字替换(极低频, 每行最多1处)
        if allow_typo and rng.random() < rate * 0.4:
            cand = [(a, b) for a, b in _TYPO_PAIRS
                    if a in s and a != b and not a.isascii()]
            if cand:
                a, b = rng.choice(cand)
                s = s.replace(a, b, 1)
                touched = True

        if touched:
            changed += 1
        out_lines.append(s)

    return "\n".join(out_lines)


# ============================================================
# 六、去味改写提示词构造 (给 LLM 用)
# ============================================================


def build_deai_banned_words(*, level: str = "A") -> list[str]:
    """汇总套话词, 作为改写提示词的 banned list。

    level="A" 只给 A 级硬信号(默认); level="AB" 连 B 级软信号一起给。
    """
    out: list[str] = []
    for meta in LEXICON.values():
        if meta["level"] == "A" or (level == "AB" and meta["level"] == "B"):
            out.extend(meta["words"])
    return out


#: 反向提示: 这些话**不要**改, 改了反而更假(C 级禁动, 说明性)
_NO_TOUCH = """【不要改的地方 — 这些看着像 AI 味, 其实不是】
- 情绪直说: "她怕了""他手在抖"是真人写法, 不要改成"涌起一股莫名的恐惧"。
- 被动句、长句、名词化表达、句内三连排比("更狠、更快、更准")。
- 人物口癖、反复出现的惯用句式(那是作者习惯, 优先级高于本清单)。
- 短段落、密集分段、角色多、线性推进 —— 短剧的类型规范。
- 强因果、伏笔按期回收、爽点按期结算 —— 观众的追读契约。"""


def build_deai_prompt(text: str, inject_flaws: bool = True, *, kind: str = "script") -> str:
    """构造"去 AI 味"改写提示词。

    kind: "script"=分镜剧本(默认) / "chapter"=章节正文
    """
    banned = "、".join(build_deai_banned_words())
    flaw_rule = (
        "11) 适度加入真人自然瑕疵: 台词可用口语('嗯''那个''啧')、可不完整; "
        "极少量'的/得/地'偶尔混用、个别常见别字, 每集至多1-2处, "
        "但人名、数字、关键剧情信息绝不能错。**同一句口语词不要反复用**。"
        if inject_flaws else ""
    )
    if kind == "chapter":
        what = "一章**小说正文**"
        fmt = """【正文结构原样保留】(只改文字腔调, 不动骨架):
- 段落顺序、分段位置、对话归属保持不变; 不增删情节, 不合并或拆散场景。
- 人物对话保留引号与说话人。"""
        tail = "【改写后(保持原有分段, 直接输出正文, 不要任何解释或开场白)】"
    else:
        what = "一集**分镜剧本**"
        # ⚠️ 格式与 rewrite/parser.serialize_episode 逐字对齐: 改写结果要用
        # parse_episode 拆回 shots_json 写回草稿, 格式行一动就拆不回来。
        fmt = """【分镜格式必须原样保留】(只改文字腔调, 不动骨架; 改完要按这些行首拆回剧本结构):
- `第N集` / `场:` / `景:` / `人物:` / `(出字幕: …)` / `【快速闪回】` / `【闪出】` 这些行**一字不改**、顺序不变。
- `△` 开头的动作行: 保留 △ 前缀, 只把里面文字改利落、口语、有画面。
- `角色名: 台词` 与 `角色名(表演提示): 台词` 台词行: 角色名、括号、冒号保持原样, 只改台词与括号里的提示。
- `(OS)` `(VO)` 内心独白只改腔调。
- 每一行都保留, 不合并、不拆分、不增删场次; 一行动作对应一行动作, 一句台词对应一句台词。"""
        tail = "【改写后(保持分镜格式, 直接输出结果, 不要任何解释或开场白)】"
    return f"""你是资深短剧编剧。下面是{what}, "AI味/翻译腔/书面腔"太重, 请大胆改写成真人爆款短剧的文风。

{fmt}

【去味要求 — 改动要明显, 但**不要改过头**】:
1) 禁用这些套话词, 换成具体、口语的表达: {banned}
2) **抽象情绪壳必须拆掉**: "涌起一股难以言喻的恐惧""心中泛起一丝酸楚"这种, 改成能看见的动作或直接把情绪说出来 —— "她怕了""他手在抖"都是好写法, 不必绕。
3) 删掉"营造出…紧迫感/窒息感"这类解说式套话, 直接写画面。
4) 打碎又长又工整的书面句, 变成短句、口语。
5) 比喻少用且不套路化(潮水/绷紧的弦/漩涡等禁用)。
6) 台词去掉翻译腔和文绉绉, 接地气。翻译腔五症状逐条清:
   过长前置定语拆成两句; 删掉"当…的时候"的"当/时"; 删掉"对于…来说"这类前置话题壳;
   段首的"然而/因此/此外"不要连续当路标; "这意味着/换句话说"与前句同义就并进去。
7) **神态描写要短、要直白, 禁止抽象堆砌**: 把"嘴角勾起一抹得意且挑衅的冷笑"直接砍成"冷笑""眯起眼"。宁可简单直接, 别形容词叠形容词。
8) **多用感叹号等强情绪标点**: 该用"！"就用"！", 情绪外放有冲击力。
9) **大幅减少环境/场景铺陈**: 除非剧情必需, 不写大段光线/氛围/空气; 笔墨让给对白和直接冲突, **能用对白推进就用对白**。
10) 整体: 短平快、口语、情绪外放、以对白和动作为主。
{flaw_rule}

{_NO_TOUCH}

【改完自查 — 这两条比"改得多"更重要】
· **删除测试**: 把你这次加进去的每个字、每个短语划掉一次。句子还通顺、意思没变 → 那是填料, 删掉。
  AI 改稿最大的指纹不是"加了什么词", 是**用填料把内容冲淡**(实测内容词比例会明显下降)。
· **还原测试**: 把被你替换掉的旧写法放回去比一比。旧写法更短且意思相同 → 留旧的。

【绝不能改】剧情走向、人物名、时间线、数字、专有名词、△格式前缀、场景行。只改文字风格。

【本集原文】
{text}

{tail}"""
