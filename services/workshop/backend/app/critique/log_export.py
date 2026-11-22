"""把一次"评审精修"的完整过程导出为面向编剧/用户的可读 Word 文档。

设计目标 (非技术读者友好):
- 纯文字叙述 + 清晰分级标题, 不出现 JSON / 代码 / 字段名。
- 用"第几轮 → 谁提了什么建议 → 编辑怎么处理(采纳/未采纳及原因)"的故事线组织。
- 每集一节, 集内按"审阅意见汇总 / 逐轮修改记录 / 修改前后对照"分块。
- 排版讲究: 标题层级、颜色、留白、分隔线、要点符号。

数据来源 (由 routes 组装后传入, 已是普通 dict, 不含模型内部结构):
  run:        任务基本信息 (强度档/范围/时间/状态)
  result:     run.result_json (逐集 original/refined/curve/edits)
  issues_by_ep: {episode_order: [issue,...]}  评审身份提出的全部意见
  role_label / theme_label / model_label / intensity_label: id->中文名 映射
"""
from __future__ import annotations

import io
from typing import Any, Callable, Optional

from docx import Document
from docx.shared import Pt, RGBColor, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH

# 配色 (与剧本导出风格一致)
PURPLE = RGBColor(0x66, 0x33, 0x99)
GRAY = RGBColor(0x88, 0x88, 0x88)
DARK_GRAY = RGBColor(0x55, 0x55, 0x55)
BLACK = RGBColor(0x22, 0x22, 0x22)
GREEN = RGBColor(0x2E, 0x7D, 0x32)   # 采纳
ORANGE = RGBColor(0xC6, 0x28, 0x28)  # 驳回/未采纳
BLUE = RGBColor(0x15, 0x65, 0xC0)    # 建议

_SEV_LABEL = {"high": "严重", "mid": "中等", "low": "轻微"}


def _set_default_font(doc: Document) -> None:
    style = doc.styles["Normal"]
    style.font.name = "宋体"
    style.font.size = Pt(11)


def _h1(doc: Document, text: str) -> None:
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(6)
    p.paragraph_format.space_after = Pt(10)
    r = p.add_run(text)
    r.font.size = Pt(22)
    r.font.bold = True
    r.font.color.rgb = PURPLE


def _h2(doc: Document, text: str) -> None:
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(16)
    p.paragraph_format.space_after = Pt(6)
    r = p.add_run(text)
    r.font.size = Pt(16)
    r.font.bold = True
    r.font.color.rgb = PURPLE


def _h3(doc: Document, text: str, color: RGBColor = DARK_GRAY) -> None:
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(10)
    p.paragraph_format.space_after = Pt(3)
    r = p.add_run(text)
    r.font.size = Pt(13)
    r.font.bold = True
    r.font.color.rgb = color


def _para(doc: Document, text: str, *, indent: float = 0.0, size: int = 11,
          color: RGBColor = BLACK, italic: bool = False, space_after: int = 3) -> None:
    p = doc.add_paragraph()
    if indent:
        p.paragraph_format.left_indent = Cm(indent)
    p.paragraph_format.space_after = Pt(space_after)
    r = p.add_run(text)
    r.font.size = Pt(size)
    r.font.color.rgb = color
    r.italic = italic


def _label_value(doc: Document, label: str, value: str, *, vcolor: RGBColor = BLACK) -> None:
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(2)
    lr = p.add_run(label)
    lr.font.size = Pt(11)
    lr.font.bold = True
    lr.font.color.rgb = DARK_GRAY
    vr = p.add_run(value)
    vr.font.size = Pt(11)
    vr.font.color.rgb = vcolor


def _bullet(doc: Document, text: str, *, color: RGBColor = BLACK, indent: float = 0.8,
            bold_prefix: Optional[str] = None, prefix_color: RGBColor = BLUE) -> None:
    p = doc.add_paragraph()
    p.paragraph_format.left_indent = Cm(indent)
    p.paragraph_format.space_after = Pt(2)
    dot = p.add_run("• ")
    dot.font.size = Pt(11)
    dot.font.color.rgb = prefix_color
    if bold_prefix:
        br = p.add_run(bold_prefix)
        br.font.size = Pt(11)
        br.font.bold = True
        br.font.color.rgb = prefix_color
    tr = p.add_run(text)
    tr.font.size = Pt(11)
    tr.font.color.rgb = color


def _divider(doc: Document) -> None:
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(4)
    r = p.add_run("─" * 30)
    r.font.color.rgb = RGBColor(0xCC, 0xCC, 0xCC)


def _fmt_dt(s: Optional[str]) -> str:
    if not s:
        return "—"
    return str(s).replace("T", " ")[:19]


def build_critique_log_docx(
    *,
    draft_title: str,
    run: dict,
    result: dict,
    issues_by_ep: dict[int, list[dict]],
    role_label: Callable[[str], str],
    theme_label: Callable[[str], str],
    model_label: Callable[[str], str],
    intensity_label: Callable[[str], str],
) -> bytes:
    """生成"精修全过程"Word, 返回 bytes。"""
    doc = Document()
    _set_default_font(doc)

    # ============ 封面 / 概述 ============
    _h1(doc, "剧本精修全过程报告")
    sub = doc.add_paragraph()
    sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    sr = sub.add_run(f"《{draft_title}》")
    sr.font.size = Pt(15)
    sr.font.color.rgb = GRAY
    sub.paragraph_format.space_after = Pt(14)

    params = run.get("params") or {}
    eps_sorted = sorted(int(k) for k in (result.get("episodes") or {}).keys())
    changed_eps = [e for e in eps_sorted if (result.get("episodes") or {}).get(str(e), {}).get("changed")]

    _h2(doc, "一、本次精修概览")
    _label_value(doc, "精修强度：", intensity_label(run.get("intensity", "")))
    _label_value(doc, "精修对象：", "剧本分镜" if run.get("source") == "storyboard" else "章节正文")
    _label_value(doc, "执行模型：", model_label(params.get("editor_model", "gemini")))
    if params.get("focus"):
        _label_value(doc, "重点关注：", str(params.get("focus")))
    _label_value(doc, "涉及集数：", f"共 {len(eps_sorted)} 集" + (f"（{','.join(f'第{e}集' for e in eps_sorted)}）" if len(eps_sorted) <= 20 else ""))
    _label_value(doc, "实际改动：", f"{len(changed_eps)} 集发生修改", vcolor=GREEN if changed_eps else GRAY)
    _label_value(doc, "开始时间：", _fmt_dt(run.get("created_at")))
    _label_value(doc, "完成时间：", _fmt_dt(run.get("updated_at")))

    # 总体建议/采纳统计
    total_sugg = sum(len(v) for v in issues_by_ep.values())
    total_applied = 0
    total_rejected = 0
    for e in eps_sorted:
        for rd in (result.get("episodes") or {}).get(str(e), {}).get("edits", []) or []:
            total_applied += len(rd.get("applied", []) or [])
            total_rejected += len(rd.get("rejected", []) or [])
    _para(doc, "")
    _label_value(doc, "审阅意见总数：", f"{total_sugg} 条")
    _label_value(doc, "编辑采纳：", f"{total_applied} 条", vcolor=GREEN)
    _label_value(doc, "编辑未采纳：", f"{total_rejected} 条（含说明）", vcolor=ORANGE)

    _para(doc, "")
    _para(doc,
          "说明：本报告完整记录了多位 AI 审阅专家提出的修改建议、以及编辑在每一轮对这些建议的处理"
          "（采纳或保留原样及其原因），并附每集的修改前后对照，供您核对与存档。",
          color=GRAY, italic=True, size=10)

    # ============ 逐集明细 ============
    _h2(doc, "二、各集精修明细")

    for ep in eps_sorted:
        data = (result.get("episodes") or {}).get(str(ep), {})
        doc.add_page_break()
        _h2(doc, f"第 {ep} 集")

        changed = data.get("changed")
        curve = data.get("curve") or []
        _label_value(doc, "本集结论：",
                     "已修改" if changed else "审阅后保持原样",
                     vcolor=GREEN if changed else GRAY)
        if curve and len(curve) >= 2:
            _label_value(doc, "问题收敛：",
                         f"首轮发现 {curve[0]} 处 → 末轮 {curve[-1]} 处")

        # —— 审阅意见汇总 ——
        sugg = issues_by_ep.get(ep, [])
        _h3(doc, "【一】审阅专家提出的意见", color=BLUE)
        if not sugg:
            _para(doc, "本集未发现需要修改的问题。", color=GRAY, indent=0.5)
        else:
            # 按评审身份分组, 更像"专家意见汇总"
            by_role: dict[str, list[dict]] = {}
            for it in sugg:
                by_role.setdefault(it.get("role") or "其他", []).append(it)
            for role_id, items in by_role.items():
                _para(doc, f"▸ {role_label(role_id)}（{len(items)} 条）",
                      indent=0.3, size=12, color=DARK_GRAY, space_after=2)
                for it in items:
                    sev = _SEV_LABEL.get(it.get("severity") or "", "")
                    conf = it.get("confidence") or 0
                    head = f"［{sev}］" if sev else ""
                    if conf:
                        head += f"（{conf}% 把握）"
                    _bullet(doc, f"{head} {it.get('issue') or ''}".strip(),
                            indent=0.9, bold_prefix="问题：", prefix_color=BLUE)
                    if it.get("evidence"):
                        _para(doc, f"原文：{it['evidence']}", indent=1.5, size=10, color=GRAY)
                    if it.get("fix_hint"):
                        _para(doc, f"建议：{it['fix_hint']}", indent=1.5, size=10, color=DARK_GRAY)

        # —— 逐轮修改记录 ——
        edits = data.get("edits") or []
        _h3(doc, "【二】编辑逐轮处理记录", color=PURPLE)
        if not edits:
            _para(doc, "本集没有进入改写环节（无待处理意见）。", color=GRAY, indent=0.5)
        else:
            for rd in edits:
                ridx = rd.get("round")
                theme = theme_label(rd.get("theme") or "")
                items = rd.get("items") or []
                applied = set(rd.get("applied") or [])
                # rejected 项可能是 dict({index,reason}) / 纯 int(索引) / 纯 str(索引或原因),
                # 历史数据混杂, 这里逐一容错解析, 避免 .get() 在 str 上崩溃。
                rejected = {}
                for rj in (rd.get("rejected") or []):
                    if isinstance(rj, dict):
                        idx = rj.get("index")
                        reason = rj.get("reason", "")
                    elif isinstance(rj, int):
                        idx, reason = rj, ""
                    elif isinstance(rj, str):
                        # 纯字符串: 若是数字当索引, 否则跳过(无法定位到具体意见)
                        idx = int(rj) if rj.strip().isdigit() else None
                        reason = "" if (idx is not None) else rj
                        if idx is None:
                            continue
                    else:
                        continue
                    if idx is not None:
                        try:
                            rejected[int(idx)] = reason or ""
                        except (TypeError, ValueError):
                            continue
                _para(doc, f"第 {ridx} 轮 · {theme}",
                      indent=0.3, size=12, color=PURPLE, space_after=2)
                if not items:
                    _para(doc, "（本轮无意见）", indent=0.9, color=GRAY, size=10)
                    continue
                for i, it in enumerate(items):
                    issue_txt = it.get("issue") or ""
                    if i in applied:
                        _bullet(doc, issue_txt, indent=0.9,
                                bold_prefix="✓ 已采纳：", prefix_color=GREEN, color=BLACK)
                    elif i in rejected:
                        _bullet(doc, issue_txt, indent=0.9,
                                bold_prefix="✗ 未采纳：", prefix_color=ORANGE, color=BLACK)
                        reason = rejected.get(i) or "（编辑判断此处保持原样更佳）"
                        _para(doc, f"原因：{reason}", indent=1.5, size=10, color=ORANGE)
                    else:
                        # 既不在 applied 也不在 rejected (编辑未显式标注)
                        _bullet(doc, issue_txt, indent=0.9,
                                bold_prefix="… 已综合考量：",
                                prefix_color=GRAY, color=DARK_GRAY)

        # —— 修改前后对照 ——
        _h3(doc, "【三】修改前后对照", color=DARK_GRAY)
        original = data.get("original") or ""
        refined = data.get("refined") or ""
        if data.get("is_storyboard"):
            _para(doc, "（本集为剧本分镜，下方为结构化文本节选对照）", color=GRAY, italic=True, size=10)
        if not changed:
            _para(doc, "本集未改动，正文与原稿一致。", color=GRAY, indent=0.5)
        else:
            _para(doc, "▼ 修改前", size=12, color=ORANGE, space_after=2)
            _render_block(doc, original)
            _divider(doc)
            _para(doc, "▼ 修改后", size=12, color=GREEN, space_after=2)
            _render_block(doc, refined)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _render_block(doc: Document, text: str, *, max_chars: int = 4000) -> None:
    """把一段长文本按行渲染进文档 (剧本 JSON 也直接当文本展示前若干字)。"""
    t = (text or "").strip()
    if not t:
        _para(doc, "（空）", color=GRAY, indent=0.5)
        return
    if len(t) > max_chars:
        t = t[:max_chars] + " …（后略）"
    for line in t.split("\n"):
        line = line.rstrip()
        if not line:
            continue
        _para(doc, line, indent=0.5, size=10, color=DARK_GRAY, space_after=1)


__all__ = ["build_critique_log_docx"]