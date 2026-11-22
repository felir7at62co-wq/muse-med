"""分析报告导出为 Word(.docx)"""
from __future__ import annotations

import io
from datetime import datetime
from typing import Any

from docx import Document
from docx.shared import Pt, RGBColor, Cm, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH


GRADE_DESC = {
    "S": "精品爆款潜质,强推制作",
    "A": "优质作品,小爆款可能",
    "B": "及格线,需打磨",
    "C": "有明显问题,需重写部分",
    "D": "建议大改或弃用",
}

SEVERITY_LABEL = {"high": "🔴 严重", "medium": "🟡 中等", "low": "🟢 轻微"}
PRIORITY_LABEL = {"P0": "🔴 必改", "P1": "🟡 推荐", "P2": "🟢 可选"}
HOOK_TYPE_LABEL = {
    "opening_hook": "开场钩",
    "twist": "中段反转",
    "cliffhanger": "结尾悬念",
    "emotional_peak": "情绪炸裂",
    "iconic_line": "名场面台词",
}
RISK_CATEGORY_LABEL = {
    "audience_loss": "观众流失",
    "logic_gap": "逻辑漏洞",
    "homogeneous": "同质化",
    "character_imbalance": "角色失衡",
    "completion_risk": "完播风险",
    "safety": "合规风险",
}


def _heading(doc: Document, text: str, level: int = 1):
    h = doc.add_heading(text, level=level)
    return h


def _para(doc: Document, text: str, *, bold: bool = False, size: int | None = None, color: tuple | None = None):
    p = doc.add_paragraph()
    run = p.add_run(text)
    if bold:
        run.bold = True
    if size:
        run.font.size = Pt(size)
    if color:
        run.font.color.rgb = RGBColor(*color)
    return p


def _kv_table(doc: Document, items: list[tuple[str, str]]):
    """简易 key-value 表格"""
    table = doc.add_table(rows=len(items), cols=2)
    table.style = "Light Grid Accent 1"
    for i, (k, v) in enumerate(items):
        cells = table.rows[i].cells
        cells[0].text = str(k)
        cells[1].text = str(v)
        # 加粗 key
        for run in cells[0].paragraphs[0].runs:
            run.bold = True


def build_analysis_docx(*, draft_title: str, analysis: dict) -> bytes:
    """生成 Word 分析报告。

    analysis 来自 ScriptAnalysis row 的 dict 形式。
    """
    doc = Document()

    # ---- 封面页
    title_p = doc.add_paragraph()
    title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_run = title_p.add_run(f"《{draft_title}》剧本分析报告")
    title_run.bold = True
    title_run.font.size = Pt(22)

    # 评级
    grade = analysis.get("overall_grade") or "C"
    score = analysis.get("overall_score") or 0
    grade_p = doc.add_paragraph()
    grade_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    grade_run = grade_p.add_run(f"\n综合评级 {grade}    {score} / 100")
    grade_run.bold = True
    grade_run.font.size = Pt(28)
    grade_color = {
        "S": (255, 165, 0),
        "A": (138, 43, 226),
        "B": (30, 144, 255),
        "C": (218, 165, 32),
        "D": (128, 128, 128),
    }.get(grade, (128, 128, 128))
    grade_run.font.color.rgb = RGBColor(*grade_color)

    desc_p = doc.add_paragraph()
    desc_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    desc_p.add_run(GRADE_DESC.get(grade, "")).italic = True

    summary_p = doc.add_paragraph()
    summary_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    summary_p.add_run(analysis.get("summary") or "")

    meta_p = doc.add_paragraph()
    meta_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    created = analysis.get("created_at")
    if isinstance(created, datetime):
        created_str = created.strftime("%Y-%m-%d %H:%M")
    else:
        created_str = str(created or "")
    meta_p.add_run(f"分析时间: {created_str}    分析 ID: #{analysis.get('id', '')}").font.size = Pt(9)

    doc.add_page_break()

    # ---- 第一节: 综合评级
    _heading(doc, "一、综合评级", level=1)
    scores = analysis.get("scores_json") or {}
    metrics = analysis.get("metrics_json") or {}

    _kv_table(doc, [
        ("综合评级", f"{grade}  ({GRADE_DESC.get(grade, '')})"),
        ("综合分数", f"{score} / 100"),
        ("剧情完整度", f"{scores.get('completeness', 0)} / 100"),
        ("角色塑造", f"{scores.get('character', 0)} / 100"),
        ("节奏密度", f"{scores.get('pacing', 0)} / 100"),
        ("市场潜力", f"{scores.get('market', 0)} / 100"),
        ("总集数", str(metrics.get("total_chapters", 0))),
        ("总字数", f"{metrics.get('total_words', 0):,}"),
        ("平均每集字数", f"{metrics.get('avg_words_per_chapter', 0):,}"),
        ("平均每集镜头", str(metrics.get("avg_shots_per_chapter", 0))),
    ])

    _para(doc, "")
    _para(doc, f"总评: {analysis.get('summary', '')}", size=11)

    # ---- 第二节: 爆点分析
    doc.add_paragraph()
    _heading(doc, "二、爆点分析", level=1)
    hooks = analysis.get("hooks_json") or []
    if not hooks:
        _para(doc, "(本次分析未识别到明显的投流钩子,建议加强冲突和情绪高潮)")
    else:
        _para(doc, f"共识别到 {len(hooks)} 个爆点钩子,平均每集 {round(len(hooks) / max(1, metrics.get('total_chapters', 1)), 1)} 个。")
        # 按集分组
        by_chapter: dict[int, list] = {}
        for h in hooks:
            by_chapter.setdefault(h.get("chapter_order", 0), []).append(h)
        for order in sorted(by_chapter.keys()):
            _heading(doc, f"第 {order} 集", level=2)
            for h in by_chapter[order]:
                p = doc.add_paragraph(style="List Bullet")
                run = p.add_run(
                    f"【{HOOK_TYPE_LABEL.get(h.get('type'), h.get('type'))}】"
                    f" 强度 {'⚡' * h.get('intensity', 1)} (场次 {h.get('scene_no', '-')})"
                )
                run.bold = True
                if h.get("snippet"):
                    doc.add_paragraph(f"  原文: {h['snippet']}")
                if h.get("comment"):
                    doc.add_paragraph(f"  点评: {h['comment']}")
                if h.get("improvement"):
                    doc.add_paragraph(f"  优化建议: {h['improvement']}")

    # ---- 第三节: 风险提示
    doc.add_paragraph()
    _heading(doc, "三、风险提示", level=1)
    risks = analysis.get("risks_json") or []
    if not risks:
        _para(doc, "未识别到明显风险")
    else:
        # 按 severity 分组
        by_sev = {"high": [], "medium": [], "low": []}
        for r in risks:
            sev = r.get("severity", "medium")
            by_sev.setdefault(sev, []).append(r)
        for sev in ["high", "medium", "low"]:
            items = by_sev.get(sev, [])
            if not items:
                continue
            _heading(doc, f"{SEVERITY_LABEL.get(sev, sev)} ({len(items)} 条)", level=2)
            for r in items:
                p = doc.add_paragraph(style="List Number")
                cat_label = RISK_CATEGORY_LABEL.get(r.get("category"), r.get("category", ""))
                run = p.add_run(f"[{cat_label}] {r.get('location', '')}")
                run.bold = True
                doc.add_paragraph(f"  问题: {r.get('description', '')}")
                doc.add_paragraph(f"  建议: {r.get('suggestion', '')}")

    # ---- 第四节: 受众画像
    doc.add_paragraph()
    _heading(doc, "四、受众画像", level=1)
    audience = analysis.get("audience_json") or {}
    completion_label = {"high": "高", "medium": "中", "low": "低"}.get(
        audience.get("completion_rate_predict"), "未知"
    )
    _kv_table(doc, [
        ("题材标签", "、".join(audience.get("tags") or []) or "(无)"),
        ("目标年龄", audience.get("target_age") or "(无)"),
        ("目标性别", audience.get("target_gender") or "(无)"),
        ("目标地域", audience.get("target_region") or "(无)"),
        ("完播率预测", completion_label),
    ])

    # 角色戏份占比
    char_share = (analysis.get("metrics_json") or {}).get("character_share") or []
    if char_share:
        doc.add_paragraph()
        _heading(doc, "主要角色戏份占比", level=2)
        table = doc.add_table(rows=1 + len(char_share), cols=4)
        table.style = "Light Grid Accent 1"
        hdr = table.rows[0].cells
        hdr[0].text = "角色"
        hdr[1].text = "出场次数"
        hdr[2].text = "戏份占比"
        hdr[3].text = "台词数"
        for i, c in enumerate(char_share, 1):
            row = table.rows[i].cells
            row[0].text = c.get("name", "")
            row[1].text = str(c.get("appearances", 0))
            row[2].text = f"{c.get('share_pct', 0)}%"
            row[3].text = str(c.get("line_count", 0))

    # ---- 第五节: 改进建议
    doc.add_paragraph()
    _heading(doc, "五、改进建议", level=1)
    suggestions = analysis.get("suggestions_json") or []
    if not suggestions:
        _para(doc, "暂无改进建议")
    else:
        # 按优先级分组
        by_pri = {"P0": [], "P1": [], "P2": []}
        for sg in suggestions:
            by_pri.setdefault(sg.get("priority", "P1"), []).append(sg)

        for pri in ["P0", "P1", "P2"]:
            items = by_pri.get(pri, [])
            if not items:
                continue
            label = PRIORITY_LABEL.get(pri, pri)
            _heading(doc, f"{label} ({len(items)} 条)", level=2)
            for sg in items:
                p = doc.add_paragraph(style="List Number")
                run = p.add_run(f"{sg.get('location', '')}  (预计提升 +{sg.get('expected_score_lift', 0)} 分)")
                run.bold = True
                doc.add_paragraph(f"  当前问题: {sg.get('current_issue', '')}")
                doc.add_paragraph(f"  改进建议: {sg.get('suggestion', '')}")

    # ---- 字数偏离表(附录)
    word_counts = (analysis.get("metrics_json") or {}).get("chapter_word_counts") or []
    if word_counts:
        doc.add_paragraph()
        _heading(doc, "附录: 章节字数详情", level=1)
        table = doc.add_table(rows=1 + len(word_counts), cols=4)
        table.style = "Light Grid Accent 1"
        hdr = table.rows[0].cells
        hdr[0].text = "集号"
        hdr[1].text = "标题"
        hdr[2].text = "字数"
        hdr[3].text = "偏离目标"
        for i, w in enumerate(word_counts, 1):
            row = table.rows[i].cells
            row[0].text = str(w.get("order", ""))
            row[1].text = w.get("title", "")
            row[2].text = str(w.get("word_count", 0))
            dev = w.get("deviation_pct", 0)
            row[3].text = f"{dev:+d}%"

    # ---- 序列化
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
