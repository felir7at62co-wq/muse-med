"""剧本 → 排版良好的 Word 文档(.docx)生成。

排版规格:
- 剧名: 22pt 黑体加粗 居中
- 集标题: 16pt 黑体加粗, 段前12pt段后6pt
- 正文: 12pt(小四) 宋体, 1.5倍行距, 段后6pt
用于「导出剧本」下载与「分发到飞书」附件, 观感远优于纯txt。
"""
import io
import json
import logging
import re

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

logger = logging.getLogger(__name__)

_HEADING_FONT = "黑体"
_BODY_FONT = "宋体"

#: 「第2集」「第 2 集」「【第2集】」这类前缀 —— 后面可能紧跟空白、冒号或顿号
_EP_PREFIX_RE = re.compile(r"^\s*[【\[(（]?\s*第\s*\d+\s*集\s*[】\])）]?\s*[:：、,，.。\-—–]?\s*")


def _strip_episode_prefix(title: str | None) -> str:
    """剥掉标题开头的「第N集」，只留真正的名字。

    ⚠️ 为什么需要（2026-10-27 用户报「导出的文件中，总会出现两个集号」）：
    本文件把标题拼成 `第{order}集  {title}`。库里有 2210 条章节 title 恰好就是
    「第2集」、另有 1149 条以「第N集」开头，于是拼出来是「第2集  第2集」。

    只剥**开头**那一处：中间出现的「第3集」可能是剧情内容，不能动。
    剥完为空 = 标题没有信息量，调用方据此不拼那一截。
    与 `stages/export_docx._strip_episode_prefix` 同一口径（两个导出入口，
    口径必须一致，否则同一部剧从不同按钮导出来不一样）。
    """
    s = (title or "").strip()
    if not s:
        return ""
    m = _EP_PREFIX_RE.match(s)
    return s[m.end():].strip() if m else s


def _episode_heading(order, title) -> str:
    """集标题文案：`第N集  名字`；名字为空或只是集号时只留 `第N集`。"""
    ep = f"第{order}集" if order not in (None, "", 0) else "第?集"
    name = _strip_episode_prefix(title if isinstance(title, str) else "")
    return f"{ep}  {name}" if name else ep


def _set_font(run, name: str, size_pt: float, bold: bool = False, color: tuple = None):
    """设置run字体(含中文east-asia字体,否则中文会回退默认字体)"""
    run.font.name = name
    run.font.size = Pt(size_pt)
    run.font.bold = bold
    if color:
        run.font.color.rgb = RGBColor(*color)
    r = run._element.rPr.rFonts
    r.set(qn("w:eastAsia"), name)


def script_to_docx(title: str, content: str) -> bytes:
    """把剧本JSON({chapters:[{order,title,content}]})渲染为docx字节。

    content不是合法JSON或无chapters时,按纯文本逐段落渲染兜底。
    """
    doc = Document()
    # 页面默认样式: 正文字体
    style = doc.styles["Normal"]
    style.font.name = _BODY_FONT
    style.font.size = Pt(12)
    style._element.rPr.rFonts.set(qn("w:eastAsia"), _BODY_FONT)

    # 剧名大标题
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(f"《{title}》")
    _set_font(run, _HEADING_FONT, 22, bold=True)
    p.paragraph_format.space_after = Pt(18)

    chapters = []
    try:
        data = json.loads(content or "{}")
        chapters = data.get("chapters") or []
    except json.JSONDecodeError:
        pass

    if chapters:
        for ch in sorted(chapters, key=lambda c: c.get("order") or 0):
            # 集标题
            hp = doc.add_paragraph()
            hrun = hp.add_run(_episode_heading(ch.get("order"), ch.get("title")))
            _set_font(hrun, _HEADING_FONT, 16, bold=True)
            hp.paragraph_format.space_before = Pt(12)
            hp.paragraph_format.space_after = Pt(6)

            # 正文: 按空行分段
            body = ch.get("content", "") or ""
            for para_text in [s for s in body.split("\n") if s.strip()]:
                bp = doc.add_paragraph()
                brun = bp.add_run(para_text.strip())
                _set_font(brun, _BODY_FONT, 12)
                bp.paragraph_format.line_spacing_rule = WD_LINE_SPACING.ONE_POINT_FIVE
                bp.paragraph_format.space_after = Pt(6)
    else:
        # 兜底: 纯文本逐段
        for para_text in [s for s in (content or "").split("\n") if s.strip()]:
            bp = doc.add_paragraph()
            brun = bp.add_run(para_text.strip())
            _set_font(brun, _BODY_FONT, 12)
            bp.paragraph_format.line_spacing_rule = WD_LINE_SPACING.ONE_POINT_FIVE
            bp.paragraph_format.space_after = Pt(6)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def outline_to_docx(title: str, content: str) -> bytes:
    """把大纲JSON渲染为docx字节(简介/人物/分集大纲分节排版)"""
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = _BODY_FONT
    style.font.size = Pt(12)
    style._element.rPr.rFonts.set(qn("w:eastAsia"), _BODY_FONT)

    try:
        data = json.loads(content or "{}")
    except json.JSONDecodeError:
        data = {}

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(f"《{data.get('title') or title}》大纲")
    _set_font(run, _HEADING_FONT, 22, bold=True)
    p.paragraph_format.space_after = Pt(18)

    def _section(heading: str):
        hp = doc.add_paragraph()
        hrun = hp.add_run(heading)
        _set_font(hrun, _HEADING_FONT, 16, bold=True)
        hp.paragraph_format.space_before = Pt(12)
        hp.paragraph_format.space_after = Pt(6)

    def _body(text: str):
        bp = doc.add_paragraph()
        brun = bp.add_run(text)
        _set_font(brun, _BODY_FONT, 12)
        bp.paragraph_format.line_spacing_rule = WD_LINE_SPACING.ONE_POINT_FIVE
        bp.paragraph_format.space_after = Pt(6)

    if data.get("synopsis"):
        _section("简介")
        _body(data["synopsis"])

    chars = data.get("characters") or []
    if chars:
        _section("人物")
        for c in chars:
            if isinstance(c, dict):
                _body(f"{c.get('name', '')}: {c.get('description', '')}")
            else:
                _body(str(c))

    chapters = data.get("chapters") or []
    if chapters:
        _section("分集大纲")
        for ch in sorted(chapters, key=lambda c: c.get("order") or 0):
            hp = doc.add_paragraph()
            hrun = hp.add_run(_episode_heading(ch.get("order"), ch.get("title")))
            _set_font(hrun, _BODY_FONT, 12, bold=True)
            hp.paragraph_format.space_before = Pt(6)
            # ⚠️ 键名优先 `synopsis` —— 大纲 JSON 里每集的正文就叫这个
            # （写入端 `import_outline.build_outline_chapters` 与
            #  `outline_gen._norm_chapters` 都造 `synopsis`；lint / 续写 /
            #  状态账本 / auto_batch.docx_zip 也一律读它）。
            # 这里原本只读 `summary`/`plot` —— 那是 `parse_and_split_outline`
            # 的**中间结构**键名，落库前已被转写成 synopsis。结果：分集大纲
            # 每集只剩标题行、正文全空，而导出**不报错**，看起来像大纲本来
            # 就只写了标题。docx 是默认导出格式，所以用户首当其冲。
            # 保留 summary/plot 兜底，兼容历史的过渡数据。
            summary = ch.get("synopsis") or ch.get("summary") or ch.get("plot") or ""
            if summary:
                _body(summary)
            # 「下集钩子」单独一行（2026-10-23 用户要求每集大纲都带这个板块）。
            # ⚠️ 不能并进上面的 summary：导出件里这两件事语义不同 ——
            # 梗概是"这集讲什么"，钩子是"这集怎么把观众拽到下一集"。
            # 空着也写，让读者能分辨"没写"与"没有这个概念"。
            _hook = ch.get("hook_out")
            if isinstance(_hook, str):
                try:
                    _hook = json.loads(_hook)
                except Exception:  # noqa: BLE001
                    _hook = {"leads_to": _hook}
            _lead = str((_hook or {}).get("leads_to") or "").strip() if isinstance(_hook, dict) else ""
            _tag = ""
            if isinstance(_hook, dict):
                _t = str(_hook.get("type") or "").strip()
                _sf = str(_hook.get("strength") or "").strip()
                _tag = _t + (f"／{_sf}" if _sf else "")
            hp2 = doc.add_paragraph()
            r1 = hp2.add_run("下集钩子：")
            _set_font(r1, _BODY_FONT, 12, bold=True)
            r2 = hp2.add_run((_lead or "（这集没有写）") + (f"（{_tag}）" if (_lead and _tag) else ""))
            _set_font(r2, _BODY_FONT, 12)
            hp2.paragraph_format.space_after = Pt(6)

    if not (data.get("synopsis") or chars or chapters):
        _body(content or "")

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()