"""关键词/正则扫描器

基于原文《动画微短剧(漫剧)内容创作建议》提取的高风险关键词。
设计原则:
- 宁可误报,不可漏报(用户可以忽略警告,但不能让违规内容漏过)
- 分级: high(严重违规) / medium(疑似) / low(边缘)
- 返回命中位置,便于前端高亮展示
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass
class SafetyHit:
    """一次命中记录"""
    category: str  # 违规类别,如 "低俗色情" / "暴力血腥"
    keyword: str   # 命中的关键词或模式
    snippet: str   # 命中上下文(前后各 20 字)
    severity: str  # high / medium / low
    position: int  # 在原文中的字符位置


# 关键词库(按类别组织)
# 格式: {类别: [(关键词或正则, 严重度), ...]}
KEYWORD_RULES: dict[str, list[tuple[str, str]]] = {
    "低俗色情": [
        (r"性交|做爱|上床|性行为|性爱", "high"),
        (r"招嫖|嫖娼|卖淫|性服务|色情网站", "high"),
        (r"裸体|裸露|暴露.*敏感部位|敏感部位.*暴露", "high"),
        (r"情趣.*道具|性.*道具", "medium"),
        (r"性能力|性暗示|性诱导", "medium"),
        (r"(胸|乳|臀|下体|私处).{0,3}(特写|镜头|展示)", "medium"),
    ],
    "暴力血腥": [
        (r"剖腹取子|胎儿.*药引", "high"),
        (r"血肉模糊|断肢|爆头|开膛|剖腹", "high"),
        (r"灭门|灭族|屠杀", "high"),
        (r"凌迟|酷刑|虐待.*致死", "high"),
        (r"(砍|割|剁|斩).{0,3}(手|脚|头|肢)", "medium"),
        (r"鲜血.*喷溅|血.*飞溅", "medium"),
    ],
    "封建迷信": [
        (r"投胎转世|灵魂附身|阴曹地府|地狱.*轮回", "high"),
        (r"(法术|符咒|阵法).{0,5}(害人|杀人|谋害)", "high"),
        (r"算命.*改命|风水.*改运|命理.*逆天", "medium"),
        (r"(丹药|仙丹|灵药).{0,5}(起死回生|长生不老)", "medium"),
    ],
    "错误伦理观": [
        (r"(一夫多妻|一妻多夫|多角恋).{0,5}(赞扬|鼓励|美化)", "high"),
        (r"(出轨|偷情|婚外情).{0,5}(称赞|鼓励|美化|正当)", "high"),
        (r"(乱伦|师生恋|父女恋|母子恋)", "high"),
        (r"(哥哥|妹妹|姐姐|弟弟).{0,10}(恋人|情侣|暧昧)", "medium"),
    ],
    "错误金钱观": [
        (r"(为了钱|为了金钱).{0,10}(杀人|害人|不择手段)", "high"),
        (r"非法.*借贷|高利贷|套路贷", "high"),
        (r"金钱.*万能|有钱.*为所欲为", "medium"),
        (r"(富人|有钱人).{0,10}(欺压|践踏|侮辱).{0,10}(穷人|贫民)", "medium"),
    ],
    "暴力犯罪": [
        (r"(主角|主人公).{0,20}(杀人|谋杀|暗杀).{0,20}(未.*批判|逍遥法外)", "high"),
        (r"详细.*作案.*手法|犯罪.*详细.*过程", "medium"),
        (r"黑社会|帮派.*斗殴|黑帮", "medium"),
    ],
    "未成年负面": [
        (r"(未成年|儿童|小孩|学生).{0,10}(抽烟|酗酒|赌博|吸毒)", "high"),
        (r"(未成年|儿童).{0,10}(性|色情|裸露)", "high"),
        (r"(未成年|儿童).{0,10}(虐待|殴打|欺凌)", "high"),
        (r"(小学生|中学生|高中生).{0,10}(早恋|性行为)", "medium"),
    ],
    "社会议题": [
        (r"(歪曲|抹黑|恶搞).{0,10}(历史|英雄|烈士)", "high"),
        (r"(种族|地域|民族|性别).{0,5}歧视", "high"),
        (r"(蹭|炒作).{0,5}(热点|舆情)", "medium"),
    ],
    "恐怖惊悚": [
        (r"(阴森|恐怖|惊悚|诡异).{0,5}(氛围|画面|音效)", "medium"),
        (r"(鬼|僵尸|丧尸|恶灵).{0,5}(袭击|杀人)", "medium"),
    ],
    "极端侮辱": [
        (r"(钻胯|狗链|狗笼|骨灰盒.*砸)", "high"),
        (r"(强迫|逼迫).{0,5}(下跪|磕头|吃.*排泄物)", "high"),
        (r"(扇.*巴掌|泼.*水|吐.*口水).{5,30}(反复|多次|持续)", "medium"),
    ],
}


def scan_text(text: str, *, category_filter: set[str] | None = None) -> list[SafetyHit]:
    """扫描文本,返回所有命中的违规点。

    Args:
        text: 待扫描文本(章节正文/剧本 action/dialogue 等)
        category_filter: 只扫描指定类别,None=全扫

    Returns:
        命中列表,按 position 排序
    """
    if not text:
        return []

    hits: list[SafetyHit] = []
    rules = KEYWORD_RULES if not category_filter else {k: v for k, v in KEYWORD_RULES.items() if k in category_filter}

    for category, patterns in rules.items():
        for pattern, severity in patterns:
            for m in re.finditer(pattern, text, re.IGNORECASE):
                start = m.start()
                end = m.end()
                # 提取上下文(前后各 20 字)
                ctx_start = max(0, start - 20)
                ctx_end = min(len(text), end + 20)
                snippet = text[ctx_start:ctx_end]
                if ctx_start > 0:
                    snippet = "..." + snippet
                if ctx_end < len(text):
                    snippet = snippet + "..."

                hits.append(SafetyHit(
                    category=category,
                    keyword=m.group(0),
                    snippet=snippet,
                    severity=severity,
                    position=start,
                ))

    # 按位置排序,便于前端按顺序展示
    hits.sort(key=lambda h: h.position)
    return hits


def scan_storyboard_shots(shots: list[dict]) -> list[SafetyHit]:
    """扫描剧本 shots 数组,合并所有 action/dialogue 后扫描。

    Args:
        shots: storyboard.shots_json

    Returns:
        命中列表
    """
    if not shots:
        return []

    # 拼接所有文本
    texts = []
    for s in shots:
        if isinstance(s, dict):
            texts.append(s.get("action", "") or "")
            texts.append(s.get("dialogue", "") or "")
            # 新格式 elements
            for e in (s.get("elements") or []):
                if isinstance(e, dict):
                    texts.append(e.get("content", "") or "")

    full_text = "\n".join(t for t in texts if t)
    return scan_text(full_text)


def format_hits_for_log(hits: list[SafetyHit]) -> str:
    """把命中列表格式化成日志字符串,便于写入 generation_logs.message"""
    if not hits:
        return "未发现明显违规关键词"

    high = [h for h in hits if h.severity == "high"]
    medium = [h for h in hits if h.severity == "medium"]
    low = [h for h in hits if h.severity == "low"]

    parts = []
    if high:
        parts.append(f"🔴 严重: {len(high)} 处 ({', '.join(h.keyword for h in high[:3])}...)")
    if medium:
        parts.append(f"🟡 疑似: {len(medium)} 处")
    if low:
        parts.append(f"🟢 边缘: {len(low)} 处")

    return " | ".join(parts)
