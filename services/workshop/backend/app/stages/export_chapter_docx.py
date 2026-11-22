"""章节原文导出为 Word 文档(支持双源混合模式)

为续写功能配套: 让用户可以选择哪些集用"章节原文(full_text)"导出,
哪些集用"AI 剧本(storyboard)"导出。

提供三种入口:
  1. export_chapter_full_text_docx — 单章原文导出
  2. export_mixed_docx              — 整剧混合导出, 每集源由 chapter_sources 字典指定
  3. _build_chapter_full_text_section / _build_storyboard_section — 内部组件
"""
from __future__ import annotations

import io
import logging
from typing import Literal

from docx import Document
from docx.shared import Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

# 复用 export_docx 内的渲染函数构造剧本部分
from .export_docx import (
    _set_default_font,
    _add_episode_title,
    _render_scene,
)

logger = logging.getLogger("export_chapter_docx")

PURPLE = RGBColor(0x66, 0x33, 0x99)
GRAY = RGBColor(0x88, 0x88, 0x88)
LIGHT_GRAY = RGBColor(0xBB, 0xBB, 0xBB)
ORANGE = RGBColor(0xCC, 0x66, 0x00)

ChapterSource = Literal["chapter", "storyboard"]


# ===========================================================================
# 单章原文导出
# ===========================================================================

def export_chapter_full_text_docx(
    *,
    draft_title: str,
    chapter_title: str,
    chapter_order: int,
    full_text: str,
) -> bytes:
    """把单章 full_text 输出为 docx (保留段落格式, 不做 LLM 解析)。"""
    doc = Document()
    _set_default_font(doc)

    if draft_title:
        ph = doc.add_paragraph()
        ph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        srun = ph.add_run(draft_title)
        srun.font.size = Pt(11)
        srun.font.color.rgb = GRAY

    doc.add_paragraph()  # 空行

    _render_full_text_to_doc(doc, full_text or "")

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _render_full_text_to_doc(doc: Document, full_text: str) -> None:
    """把 full_text 按段落渲染到 docx, 自动识别一些剧本符号:
       - △ 开头的行: 画面描述
       - 【...】 行: 闪回标记
       - 全空行: 段落分隔
    其他行保持普通段落。
    """
    if not full_text.strip():
        p = doc.add_paragraph()
        p.add_run("(本章正文为空)").font.color.rgb = LIGHT_GRAY
        return

    # 按双换行分段, 每段内部按单换行分行
    # 这种解析比较保守, 不破坏剧本里 用户辛苦排版的格式
    for raw_para in full_text.split("\n\n"):
        para_lines = [ln.rstrip() for ln in raw_para.split("\n") if ln.strip() != ""]
        if not para_lines:
            doc.add_paragraph()
            continue
        for line in para_lines:
            stripped = line.lstrip()
            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(4)
            run = p.add_run(line)
            run.font.size = Pt(11)
            # 一些常见剧本符号简单上色
            if stripped.startswith("△"):
                run.font.color.rgb = PURPLE
            elif stripped.startswith("【") and stripped.endswith("】"):
                run.font.bold = True
                run.font.color.rgb = ORANGE


# ===========================================================================
# 混合模式整剧导出
# ===========================================================================

def export_mixed_docx(
    *,
    draft_title: str,
    chapters: list[dict],
) -> bytes:
    """整剧混合导出。

    Args:
        chapters: list of dict, 每项形如:
            {
              "chapter_order": 1,
              "chapter_title": "第1集",
              "source": "chapter" | "storyboard",
              # 如果 source=chapter, 必须有 full_text
              "full_text": "...",
              # 如果 source=storyboard, 必须有 shots
              "shots": [...],
            }

    返回 docx 字节流。已选择 source=chapter 的集会用原文渲染,
    其他用剧本渲染。每集开头会有一个小徽标说明本集来源。
    """
    doc = Document()
    _set_default_font(doc)

    # 文档总标题
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(8)
    p.paragraph_format.space_after = Pt(6)
    title_run = p.add_run(draft_title or "未命名")
    title_run.font.size = Pt(22)
    title_run.font.bold = True
    title_run.font.color.rgb = PURPLE

    doc.add_paragraph()  # 标题下留白(不输出集数统计等机器标注)

    # 逐集渲染
    for ch in chapters:
        order = int(ch.get("chapter_order") or 0)
        title = ch.get("chapter_title") or f"第{order}集"
        source = ch.get("source") or "storyboard"

        if order > 0:
            doc.add_page_break()

        _add_episode_title(doc, order, title)

        # 注: 不再输出任何来源徽标(如"原文导出"/"AI 剧本"), 导出成品即用户作品, 不做机器标注。

        if source == "chapter":
            _render_full_text_to_doc(doc, ch.get("full_text") or "")
        else:
            shots = ch.get("shots") or []
            if not shots:
                pl = doc.add_paragraph()
                pl.add_run("(本集剧本为空)").font.color.rgb = LIGHT_GRAY
            else:
                _render_storyboard_shots(doc, shots)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _render_storyboard_shots(doc: Document, shots: list[dict]) -> None:
    """对剧本(shots)做和现有 export_docx.export_storyboard_to_docx 一致的渲染。

    复用 export_docx 内的 _render_scene, 保持视觉风格完全一致。
    """
    for shot in shots:
        if isinstance(shot, dict):
            _render_scene(doc, shot)


__all__ = [
    "export_chapter_full_text_docx",
    "export_mixed_docx",
]
