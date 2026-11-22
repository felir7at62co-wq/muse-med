"""去 AI 味 · 段落与结构层诊断(只报告, 不改写)。

为什么单独一层: 多家去 AI 味项目独立得出了同一条结论 ——
**AI 味最深的地方在结构, 不在词句。结构有缺陷时只做句级清理, 反而更显 AI**
(source: sepia "architecture before word choice"; deai 的"先结构后词句"铁律)。
词句层见 `ai_taste.py`, 本模块只补它没有的两块:

  1. **段落节奏**: 通篇段长均匀、段段 4-6 句 —— AI 文本的典型形态。
     真人写短剧会"爽点压短、情绪链放长", 长度随 beat 起伏。
  2. **叙事功能**: 段末是否在总结/升华、该收的地方有没有收、相邻句是否同骨架连复现。
     这些是**语义判断**, 规则只能给"疑似"提示, 全部按 B 级(标出让用户定)输出。

刻意不做的两件事(实测站不住, 做了会误伤):
  · 不因为"句长/段长不够参差"就要求改 —— 与人类无显著差别。
  · 不因为"长句、被动句、名词化"就要求改 —— 正常中文书面语。

设计为纯函数、只用标准库, 便于单测。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .ai_taste import strip_format_lines

#: 段落节奏判据
_MIN_PARAS_FOR_RHYTHM = 6          # 少于 6 段不谈节奏
_CV_UNIFORM = 0.35                 # 段长变异系数低于此值 → 过于均匀
_AVG_SENT_UNIFORM = (4.0, 6.0)     # 段段 4-6 句 → 整齐

#: 段末"总结升华"壳。这是短剧结尾最伤观感的一类, 也是 AI 收尾的默认动作。
# ⚠️ 刻意收窄: "真正的""这一切""命运"这类词单独出现极常见("真正的凶手是他"),
#    只把**成型的升华壳**算命中, 否则误报会淹没真信号。
_SUM_UP = re.compile(
    r"(这一刻[^。！？]{0,8}(终于|才)|从这一刻起|直到这一刻"
    r"|(他|她|他们|她们)[^。！？]{0,6}终于(明白|知道|懂得|意识到)"
    r"|(这|那)?(一切|故事|命运)[^。！？]{0,4}才(刚刚)?(开始|拉开)"
    r"|才刚刚开始|而这仅仅是开始|谁也没有想到|故事才刚刚开始)"
)
#: 段末点题/预告(廉价钩子, 与 W11 同源, 这里看的是**位置**: 段末尤其毒)
_TRAILER_TAIL = re.compile(
    r"((他|她|他们|她们)不知道的是|殊不知|谁能想到|谁也没有想到"
    r"|(然而|但)[^。！？]{0,12}这才|但这只是|更大的[^。！？]{0,6}(还|才)在)"
)
#: 一行一段(分镜格式)时, "段长"天然均匀, 不能据此报节奏问题
_SINGLE_LINE_PARAS = 0.8


@dataclass
class StructureIssue:
    """一条结构层提示(B 级: 只报告, 不改写)。"""
    code: str            # R1_节奏 / R2_段末升华 / R3_相邻同构 / R4_解释腔 / R5_该收没收
    label: str
    message: str         # 一句话说清问题 + 怎么改
    where: str = ""      # 位置描述(第N段 / 第N-M段)
    samples: list[str] = field(default_factory=list)
    level: str = "B"

    def to_dict(self) -> dict:
        return {
            "code": self.code, "label": self.label, "message": self.message,
            "where": self.where, "samples": self.samples[:3], "level": self.level,
        }


@dataclass
class StructureReport:
    paragraph_count: int
    avg_para_len: float
    cv_para_len: float
    issues: list[StructureIssue] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "paragraph_count": self.paragraph_count,
            "avg_para_len": round(self.avg_para_len, 1),
            "cv_para_len": round(self.cv_para_len, 2),
            "issues": [i.to_dict() for i in self.issues],
        }


def _paragraphs(text: str) -> list[str]:
    """按空行切段; 没有空行时按非空行切(短剧分镜常一行一段)。"""
    blocks = [b.strip() for b in re.split(r"\n\s*\n", text or "") if b.strip()]
    if len(blocks) > 1:
        return blocks
    return [ln.strip() for ln in (text or "").split("\n") if ln.strip()]


def _sentence_count(para: str) -> int:
    return max(1, len(re.findall(r"[。！？!?…]+", para)))


def _sentences(para: str) -> list[str]:
    parts = re.split(r"(?<=[。！？!?…])", para)
    return [p.strip() for p in parts if p.strip()]


def _skeleton(sent: str) -> str:
    """抽句骨架: 只留标点结构、长度档、首尾词性近似, 用于比对相邻句同构。

    刻意做得粗 —— 目的是"连着两句读起来一个模子", 精确语法分析反而会漏掉。
    """
    s = re.sub(r"[一-龥]", "字", sent)
    s = re.sub(r"[A-Za-z]+", "A", s)
    s = re.sub(r"\d+", "9", s)
    return s


def diagnose_structure(text: str) -> StructureReport:
    """结构层诊断。全部按 B 级输出 —— 只提示, 不擅自改。"""
    raw = text or ""
    # 只诊断"人写的文字", 分镜格式行(△/【】)不参与节奏统计
    body = strip_format_lines(raw)
    paras = [p for p in _paragraphs(body) if p]
    n = len(paras)
    lens = [len(p) for p in paras]
    avg = sum(lens) / n if n else 0.0
    var = sum((x - avg) ** 2 for x in lens) / n if n else 0.0
    cv = (var ** 0.5) / avg if avg else 0.0

    issues: list[StructureIssue] = []

    # ---- R1 段落节奏过于均匀 ----
    one_liner_ratio = (sum(1 for p in paras if len(_sentences(p)) <= 2) / n) if n else 0.0
    if (n >= _MIN_PARAS_FOR_RHYTHM and cv < _CV_UNIFORM
            and one_liner_ratio < _SINGLE_LINE_PARAS):
        sc = [_sentence_count(p) for p in paras]
        sc_avg = sum(sc) / len(sc)
        tight = _AVG_SENT_UNIFORM[0] <= sc_avg <= _AVG_SENT_UNIFORM[1]
        if tight:
            issues.append(StructureIssue(
                "R1_节奏", "段落节奏过于均匀",
                f"{n} 个段落长度几乎一样(变异系数 {cv:.2f}), 每段约 {sc_avg:.1f} 句。"
                "真人写短剧会让长度随 beat 起伏: 冲突/爽点压成一两句, "
                "情绪链或推理才铺长。建议挑 2-3 处关键的压短, 不要全篇均匀改。",
                where=f"全篇({n}段)",
            ))

    # ---- R2 段末总结/升华 ----
    tail_hits: list[tuple[int, str]] = []
    for i, p in enumerate(paras):
        last = _sentences(p)[-1] if _sentences(p) else p
        if _SUM_UP.search(last) or _TRAILER_TAIL.search(last):
            tail_hits.append((i + 1, last[:60]))
    if tail_hits:
        issues.append(StructureIssue(
            "R2_段末升华", "段末在做总结/预告",
            f"{len(tail_hits)} 个段落以「点题/升华/预告」收尾。短剧该用动作或台词收, "
            "让观众自己得出结论; 叙述者出来总结主题是最典型的 AI 收尾动作。"
            "改法: 删掉收尾那句壳, 停在前一句的动作或画面上。",
            where="第 " + "、".join(str(i) for i, _ in tail_hits[:6]) + " 段",
            samples=[s for _, s in tail_hits[:3]],
        ))

    # ---- R3 相邻句同骨架连复现 ----
    repeats: list[tuple[int, str]] = []
    for i, p in enumerate(paras):
        sents = _sentences(p)
        for j in range(len(sents) - 1):
            a, b = _skeleton(sents[j]), _skeleton(sents[j + 1])
            # 骨架高度一致 + 长度接近 → 连着两句一个模子
            if a == b or (len(a) > 8 and a == b):
                repeats.append((i + 1, f"{sents[j][:28]} / {sents[j + 1][:28]}"))
                break
            if abs(len(a) - len(b)) <= 2 and len(a) > 10 and a[:6] == b[:6] and a[-4:] == b[-4:]:
                repeats.append((i + 1, f"{sents[j][:28]} / {sents[j + 1][:28]}"))
                break
    if repeats:
        issues.append(StructureIssue(
            "R3_相邻同构", "相邻句同骨架连复现",
            f"{len(repeats)} 处连着两句结构一个模子(成分顺序、长度都接近)。"
            "打散其中一句的句法(合并、拆分、换语序), 只改句内, 不动段落顺序也不删信息。",
            where="第 " + "、".join(str(i) for i, _ in repeats[:6]) + " 段",
            samples=[s for _, s in repeats[:3]],
        ))

    # ---- R4 解释腔 / 上帝视角 ----
    explain = re.findall(
        r"(之所以[^。！？]{2,20}是因为|原来[^。！？]{2,20}(才|就)|这意味着|这表明"
        r"|演得真好|他就是这样|她就是这样|不难看出|值得注意的是[^。！？]{0,10})",
        body)
    if explain:
        issues.append(StructureIssue(
            "R4_解释腔", "叙述者跳出角色做解释",
            f"{len(explain)} 处叙述者在替读者下判断/解释因果/剧透。"
            "删掉这些壳, 因果关系让读者从动作和对话自己拼出来。",
            samples=[(e if isinstance(e, str) else e[0]) for e in explain[:3]],
        ))

    # ---- R5 收尾位置(该收没收) ----
    if n >= 3:
        last_paras = paras[-2:]
        last_txt = "".join(last_paras)
        if _SUM_UP.search(last_txt) or _TRAILER_TAIL.search(last_txt):
            issues.append(StructureIssue(
                "R5_收尾", "结尾早一拍",
                "最后两段里出现了点题/预告。删掉它, 停在前面那个已经落地的动作或后果上 —— "
                "读者已经感到的东西, 不要再让叙述者说一遍。",
                where=f"第 {n-1}-{n} 段",
            ))

    return StructureReport(paragraph_count=n, avg_para_len=avg, cv_para_len=cv, issues=issues)
