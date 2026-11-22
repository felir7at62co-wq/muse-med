"""批次 zip 打包 - 分目录 scripts/ + analysis/。

zip 结构:
  批次-N.zip
   ├── README.txt                  # 批次配置 + 生成统计
   ├── scripts/
   │   ├── 01_标题1.docx           # 大纲 + 章节正文 + 剧本
   │   └── ...
   └── analysis/
       ├── 01_标题1_分析.docx      # 复用 analysis/docx_export.py
       └── ...
"""
from __future__ import annotations

import io
import logging
import re
import zipfile
from datetime import datetime

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt, RGBColor
from sqlalchemy import select, desc

from ..analysis.docx_export import build_analysis_docx
from ..db import (
    AutoBatchJob, ScriptAnalysis, ScriptChapter, ScriptDraft, ScriptStoryboard,
    session_scope,
)
from ..stages.export_text import storyboard_to_text

logger = logging.getLogger("auto_batch.docx_zip")


# ---------------------------------------------------------------------------
# 单部草稿 docx (剧本正文)
# ---------------------------------------------------------------------------
def _heading(doc: Document, text: str, level: int = 1):
    h = doc.add_heading(text, level=level)
    h.alignment = WD_ALIGN_PARAGRAPH.LEFT
    return h


def _para(doc: Document, text: str, *, bold: bool = False, size: int | None = None):
    p = doc.add_paragraph()
    run = p.add_run(text or "")
    if bold:
        run.bold = True
    if size:
        run.font.size = Pt(size)
    return p


def _build_script_docx(
    *,
    draft: ScriptDraft,
    chapters: list[ScriptChapter],
    storyboards: list[ScriptStoryboard],
    grade: str | None = None,
    score: int | None = None,
) -> bytes:
    """生成单部剧本的 Word 正文。"""
    doc = Document()

    # ---- 封面
    title_p = doc.add_paragraph()
    title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title_p.add_run(f"《{draft.title or '未命名'}》")
    run.bold = True
    run.font.size = Pt(28)

    sub_p = doc.add_paragraph()
    sub_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    sub_p.add_run(f"全 {draft.episode_count or len(chapters)} 集 / 自动生成").font.size = Pt(11)

    if grade:
        rate_p = doc.add_paragraph()
        rate_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        rr = rate_p.add_run(f"评级 {grade}  {score or 0} / 100")
        rr.bold = True
        rr.font.size = Pt(16)
        rr.font.color.rgb = RGBColor(138, 43, 226)

    doc.add_page_break()

    # ---- 第一节: 大纲
    _heading(doc, "一、剧本大纲", level=1)
    outline = draft.outline or {}
    _para(doc, f"剧情概要: {outline.get('synopsis', '')}", size=11)
    _para(doc, "")

    world = outline.get("world") or {}
    if world:
        _heading(doc, "世界观", level=2)
        _para(doc, f"时代: {world.get('era', '')}")
        _para(doc, f"设定: {world.get('setting', '')}")
        rules = world.get("rules") or []
        if rules:
            _para(doc, "规则:")
            for r in rules:
                _para(doc, f"  · {r}")

    chars = outline.get("characters") or []
    if chars:
        _heading(doc, "角色表", level=2)
        for ch in chars:
            line = f"{ch.get('name', '')}({ch.get('role', '')}): {'/'.join(ch.get('traits') or [])}"
            _para(doc, line)

    # 集梗概
    eps = outline.get("chapters") or outline.get("episodes") or []
    if eps:
        _heading(doc, "分集梗概", level=2)
        for e in eps:
            order = e.get("order", "")
            _para(doc, f"第 {order} 集 「{e.get('title', '')}」", bold=True)
            _para(doc, e.get("synopsis", ""))

    doc.add_page_break()

    # ---- 第二节: 章节正文
    _heading(doc, "二、章节正文", level=1)
    chapters_sorted = sorted(chapters, key=lambda c: c.chapter_order or 0)
    for ch in chapters_sorted:
        _heading(doc, f"第 {ch.chapter_order} 集 「{ch.title or ''}」", level=2)
        for line in (ch.full_text or "").split("\n"):
            _para(doc, line)
        _para(doc, "")
    doc.add_page_break()

    # ---- 第三节: 剧本
    _heading(doc, "三、剧本", level=1)
    sb_map = {sb.chapter_order: sb for sb in storyboards}
    for ch in chapters_sorted:
        sb = sb_map.get(ch.chapter_order)
        if not sb or not sb.shots_json:
            continue
        _heading(doc, f"第 {ch.chapter_order} 集 「{ch.title or ''}」剧本", level=2)
        text = storyboard_to_text(
            title=draft.title or "",
            ch_title=ch.title or f"第{ch.chapter_order}集",
            shots=sb.shots_json or [],
        )
        for line in text.split("\n"):
            _para(doc, line)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
_SAFE_FN_RE = re.compile(r"[\\/:*?\"<>|\x00-\x1f]")


def _safe_filename(name: str, max_len: int = 40) -> str:
    """剔除文件系统不允许的字符。"""
    s = _SAFE_FN_RE.sub("", (name or "").strip())
    s = s.replace(" ", "_")
    if len(s) > max_len:
        s = s[:max_len]
    return s or "untitled"


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------
async def build_batch_zip(job_id: int) -> bytes:
    """打包整批为 zip 字节流。

    docx 渲染是 CPU 密集型同步操作。
    一次性把整个 zip 丢到 to_thread 会让 python-docx 持续持有 GIL, 主 event loop 仍被堵 90s。
    改为"每部一次 to_thread + sleep(0)", 部与部之间让出 event loop, 其他请求能正常响应。
    """
    import asyncio

    # 1) 数据预加载: 必须在 async 上下文里做
    data = await _prepare_batch_data(job_id)

    # 2) 渲染 README
    readme = _build_readme(data)

    # 3) 在内存构建 zip; 每部 docx 渲染丢 to_thread, 之间 sleep(0) 让出
    buf = io.BytesIO()
    zf = zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED)
    try:
        zf.writestr("README.txt", readme.encode("utf-8"))

        for idx, item in enumerate(data["all_data"], start=1):
            base_name, script_bytes, script_err, analysis_pair = await asyncio.to_thread(
                _render_one_drama, idx, item
            )
            # 写入 zip(zip 本身的 writestr 是纯 Python 字典操作, 极快, 不需要 to_thread)
            if script_err:
                zf.writestr(f"scripts/{base_name}_ERROR.txt", script_err.encode("utf-8"))
            else:
                zf.writestr(f"scripts/{base_name}.docx", script_bytes)
            if analysis_pair:
                a_bytes, a_err = analysis_pair
                if a_err:
                    zf.writestr(f"analysis/{base_name}_分析_ERROR.txt", a_err.encode("utf-8"))
                else:
                    zf.writestr(f"analysis/{base_name}_分析.docx", a_bytes)
            # 让事件循环喘口气
            await asyncio.sleep(0)
    finally:
        zf.close()

    return buf.getvalue()


def _build_readme(data: dict) -> str:
    job = data["job"]
    job_id = data["job_id"]
    job_name = data["job_name"]
    cfg = data["cfg"]
    finished = data["finished"]
    failed = data["failed"]
    total = data["total"]
    lines = [
        f"批次名称: {job_name}",
        f"批次 ID: {job_id}",
        f"创建时间: {job.created_at.isoformat() if job.created_at else ''}",
        f"完成时间: {job.finished_at.isoformat() if job.finished_at else ''}",
        f"配置:",
        f"  部数: {cfg.get('batch_count')}",
        f"  每部集数: {cfg.get('episodes_per_drama')}",
        f"  每集字数: {cfg.get('words_per_episode')}",
        f"  题材: {cfg.get('genre_keys') or '自由'}",
        f"  临时题材: {cfg.get('adhoc_tags') or '无'}",
        f"  概念模型: {cfg.get('concept_model')}",
        f"  生成模型: {cfg.get('gen_model')}",
        f"  部级并发: {cfg.get('drama_concurrency')}",
        f"统计:",
        f"  总数: {total}",
        f"  完成: {finished}",
        f"  失败: {failed}",
        f"  LLM 调用预估/实际: {job.llm_calls_estimated or 0} / {job.llm_calls_actual or 0}",
        "",
        f"目录说明:",
        f"  scripts/   - 每部剧本正文 (含大纲/章节/剧本)",
        f"  analysis/  - 每部独立分析报告 (评级/爆点/风险/建议)",
        "",
        f"导出时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
    ]
    return "\n".join(lines)


def _render_one_drama(idx: int, item: dict) -> tuple[str, bytes | None, str | None, tuple[bytes | None, str | None] | None]:
    """渲染单部草稿 (同步, to_thread 调用)。

    返回: (base_name, script_bytes, script_err, (analysis_bytes, analysis_err) | None)
      - script_bytes / script_err 二选一
      - analysis_pair 为 None 表示该部无分析报告
    """
    d: ScriptDraft = item["draft"]
    chs = item["chapters"]
    sbs = item["storyboards"]
    analysis: ScriptAnalysis | None = item["analysis"]

    base_name = f"{idx:02d}_{_safe_filename(d.title or '未命名')}"

    # 1) 正文 docx
    script_bytes = None
    script_err = None
    try:
        grade = analysis.overall_grade if analysis else None
        score = analysis.overall_score if analysis else None
        script_bytes = _build_script_docx(
            draft=d, chapters=chs, storyboards=sbs, grade=grade, score=score,
        )
    except Exception as e:
        logger.exception("build script docx failed: draft=%d", d.id)
        script_err = f"导出失败: {type(e).__name__}: {e}"

    # 2) 分析 docx
    analysis_pair = None
    if analysis:
        try:
            analysis_dict = {
                "id": analysis.id,
                "overall_grade": analysis.overall_grade,
                "overall_score": analysis.overall_score,
                "summary": analysis.summary,
                "scores_json": analysis.scores_json or {},
                "hooks_json": analysis.hooks_json or [],
                "risks_json": analysis.risks_json or [],
                "audience_json": analysis.audience_json or {},
                "suggestions_json": analysis.suggestions_json or [],
                "metrics_json": analysis.metrics_json or {},
                "created_at": analysis.created_at,
            }
            a_bytes = build_analysis_docx(
                draft_title=d.title or "未命名",
                analysis=analysis_dict,
            )
            analysis_pair = (a_bytes, None)
        except Exception as e:
            logger.exception("build analysis docx failed: draft=%d", d.id)
            analysis_pair = (None, f"导出失败: {type(e).__name__}: {e}")

    return base_name, script_bytes, script_err, analysis_pair


async def _prepare_batch_data(job_id: int) -> dict:
    """从 DB 拿到所有需要的数据 (预加载, 后续 zip 构建只用纯 Python)。"""
    async with session_scope() as s:
        job = await s.get(AutoBatchJob, job_id)
        if not job:
            raise ValueError(f"batch {job_id} not found")

        draft_ids = job.draft_ids or []
        if not draft_ids:
            raise ValueError("batch has no drafts")

        drafts = (await s.execute(
            select(ScriptDraft).where(ScriptDraft.id.in_(draft_ids))
        )).scalars().all()
        order_map = {did: i for i, did in enumerate(draft_ids)}
        drafts.sort(key=lambda d: order_map.get(d.id, 9999))

        all_data: list[dict] = []
        for d in drafts:
            chapters = (await s.execute(
                select(ScriptChapter)
                .where(ScriptChapter.draft_id == d.id)
                .order_by(ScriptChapter.chapter_order)
            )).scalars().all()
            sbs = (await s.execute(
                select(ScriptStoryboard)
                .where(ScriptStoryboard.draft_id == d.id)
                .order_by(ScriptStoryboard.chapter_order)
            )).scalars().all()
            analysis = (await s.execute(
                select(ScriptAnalysis)
                .where(ScriptAnalysis.draft_id == d.id, ScriptAnalysis.status == "done")
                .order_by(desc(ScriptAnalysis.created_at))
            )).scalars().first()

            all_data.append({
                "draft": d,
                "chapters": list(chapters),
                "storyboards": list(sbs),
                "analysis": analysis,
            })

        job_name = job.name or f"批次{job_id}"
        cfg = job.config_json or {}
        finished = job.finished_dramas or 0
        failed = job.failed_dramas or 0
        total = job.total_dramas or len(drafts)

    return {
        "job": job,
        "job_id": job_id,
        "job_name": job_name,
        "cfg": cfg,
        "finished": finished,
        "failed": failed,
        "total": total,
        "all_data": all_data,
    }


def _render_batch_zip(data: dict) -> bytes:
    """同步函数: 在 thread pool 里跑, 不要 await 任何东西。"""
    job = data["job"]
    job_id = data["job_id"]
    job_name = data["job_name"]
    cfg = data["cfg"]
    finished = data["finished"]
    failed = data["failed"]
    total = data["total"]
    all_data = data["all_data"]

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # README
        readme_lines = [
            f"批次名称: {job_name}",
            f"批次 ID: {job_id}",
            f"创建时间: {job.created_at.isoformat() if job.created_at else ''}",
            f"完成时间: {job.finished_at.isoformat() if job.finished_at else ''}",
            f"配置:",
            f"  部数: {cfg.get('batch_count')}",
            f"  每部集数: {cfg.get('episodes_per_drama')}",
            f"  每集字数: {cfg.get('words_per_episode')}",
            f"  题材: {cfg.get('genre_keys') or '自由'}",
            f"  临时题材: {cfg.get('adhoc_tags') or '无'}",
            f"  概念模型: {cfg.get('concept_model')}",
            f"  生成模型: {cfg.get('gen_model')}",
            f"  部级并发: {cfg.get('drama_concurrency')}",
            f"统计:",
            f"  总数: {total}",
            f"  完成: {finished}",
            f"  失败: {failed}",
            f"  LLM 调用预估/实际: {job.llm_calls_estimated or 0} / {job.llm_calls_actual or 0}",
            "",
            f"目录说明:",
            f"  scripts/   - 每部剧本正文 (含大纲/章节/剧本)",
            f"  analysis/  - 每部独立分析报告 (评级/爆点/风险/建议)",
            "",
            f"导出时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        ]
        zf.writestr("README.txt", "\n".join(readme_lines).encode("utf-8"))

        # 每部
        for idx, item in enumerate(all_data, start=1):
            d: ScriptDraft = item["draft"]
            chs = item["chapters"]
            sbs = item["storyboards"]
            analysis: ScriptAnalysis | None = item["analysis"]

            base_name = f"{idx:02d}_{_safe_filename(d.title or '未命名')}"

            # 1) 正文 docx
            try:
                grade = analysis.overall_grade if analysis else None
                score = analysis.overall_score if analysis else None
                script_bytes = _build_script_docx(
                    draft=d,
                    chapters=chs,
                    storyboards=sbs,
                    grade=grade,
                    score=score,
                )
                zf.writestr(f"scripts/{base_name}.docx", script_bytes)
            except Exception as e:
                logger.exception("build script docx failed: draft=%d", d.id)
                zf.writestr(
                    f"scripts/{base_name}_ERROR.txt",
                    f"导出失败: {type(e).__name__}: {e}".encode("utf-8"),
                )

            # 2) 分析 docx (可选)
            if analysis:
                try:
                    analysis_dict = {
                        "id": analysis.id,
                        "overall_grade": analysis.overall_grade,
                        "overall_score": analysis.overall_score,
                        "summary": analysis.summary,
                        "scores_json": analysis.scores_json or {},
                        "hooks_json": analysis.hooks_json or [],
                        "risks_json": analysis.risks_json or [],
                        "audience_json": analysis.audience_json or {},
                        "suggestions_json": analysis.suggestions_json or [],
                        "metrics_json": analysis.metrics_json or {},
                        "created_at": analysis.created_at,
                    }
                    analysis_bytes = build_analysis_docx(
                        draft_title=d.title or "未命名",
                        analysis=analysis_dict,
                    )
                    zf.writestr(f"analysis/{base_name}_分析.docx", analysis_bytes)
                except Exception as e:
                    logger.exception("build analysis docx failed: draft=%d", d.id)
                    zf.writestr(
                        f"analysis/{base_name}_分析_ERROR.txt",
                        f"导出失败: {type(e).__name__}: {e}".encode("utf-8"),
                    )

    buf.seek(0)
    return buf.getvalue()
