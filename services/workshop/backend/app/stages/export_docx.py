"""剧本导出为Word文档 - 剧本式格式

输出格式严格遵循中国短剧标准剧本:
- 集数标题
- 场次标题: 场:1-1, 景:日 内 地点, 人物:...
- 字幕(可选): (出字幕: ...)
- △画面描述
- 人物名(动作提示) 对白
- 【快速闪回】 ... 【闪出】
"""
from __future__ import annotations
import io
import logging
import re
from typing import Any
from docx import Document
from docx.shared import Pt, RGBColor, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH

logger = logging.getLogger("export_docx")

PURPLE = RGBColor(0x66, 0x33, 0x99)
GRAY = RGBColor(0x88, 0x88, 0x88)
DARK_GRAY = RGBColor(0x55, 0x55, 0x55)
BLACK = RGBColor(0x00, 0x00, 0x00)
ORANGE = RGBColor(0xCC, 0x66, 0x00)


def _set_default_font(doc: Document):
    """设置默认中文字体"""
    style = doc.styles['Normal']
    style.font.name = '宋体'
    style.font.size = Pt(11)


def _add_episode_title(doc: Document, episode_no: int, episode_title: str = ""):
    """第N集 标题。

    ⚠️ episode_no 必须是**真实集号**。传入 0/None/缺失会被下面直接拒掉 ——
    2026-10-07 用户报的就是这个：某个调用点忘了传 chapter_order，本函数
    原先把 `get("chapter_order", 0)` 的 0 照渲染成紫色的「第0集」，每集前面
    都多一行假的集号。**宁可炸掉也不许印出一个不存在的集号** —— 导出件是
    交付物，用户会拿它去拍，一个假的「第0集」比一次报错危险得多。

    ## 副标题与集号重复（2026-10-27 用户报）
    > "导出的文件中，总会出现两个集号。保留一个大的就行"

    紫色的「第N集」是标题，下面那行灰字是 `episode_title`。问题在于标题本身
    常常就叫「第2集」—— 库里 2210 条章节 title 恰好是 `^第N集$`，另有 1149 条
    以「第N集」开头（如「第2集 回归」）。于是页面/文档上出现两遍集号。

    处理：副标题若与标题重复就整行不渲染；若只是以「第N集」开头，把那段前缀
    剥掉只留真正的名字（「回归」）。剥完为空同样不渲染。
    """
    ep = int(episode_no or 0)
    if ep <= 0:
        raise ValueError(f"导出剧本时集号无效({episode_no!r})，拒绝渲染「第{ep}集」")
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(18)
    p.paragraph_format.space_after = Pt(12)
    run = p.add_run(f"第{ep}集")
    run.font.size = Pt(20)
    run.font.bold = True
    run.font.color.rgb = PURPLE

    sub_text = _strip_episode_prefix(episode_title, ep)
    if sub_text:
        sub = doc.add_paragraph()
        sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
        sub.paragraph_format.space_after = Pt(8)
        srun = sub.add_run(sub_text)
        srun.font.size = Pt(14)
        srun.font.color.rgb = GRAY


#: 「第2集」「第 2 集」「【第2集】」这类前缀 —— 后面可能紧跟空白、冒号或顿号
_EP_PREFIX_RE = re.compile(r"^\s*[【\[(（]?\s*第\s*\d+\s*集\s*[】\])）]?\s*[:：、,，.。\-—–]?\s*")


def _strip_episode_prefix(title: str | None, episode_no: int) -> str:
    """把副标题开头的集号前缀剥掉，返回真正需要显示的部分（可能为空串）。

    只剥**开头**那一处。中间出现的「第3集」可能是剧情内容（"他想起第3集"），
    不能动。剥完为空 = 这个标题没有信息量，调用方据此不渲染副标题。

    ⚠️ 即使前缀里的号码与当前集号不一致也照剥：库里存在标题与集号错位的脏数据
    （历史导入/重排导致）。这时把「第3集 回归」原样显示在一个大的「第2集」下面，
    等于在交付物上印两个互相矛盾的数字；剥掉之后只剩名字「回归」，至少不误导。
    `episode_no` 参数保留是为了调用点可读，当前实现不依赖它。
    """
    s = (title or "").strip()
    if not s:
        return ""
    # 只认与当前集号一致的前缀，避免把标题里本来就有的别的集号当噪音剥掉
    m = _EP_PREFIX_RE.match(s)
    if not m:
        return s
    stripped = s[m.end():].strip()
    return stripped


def _episode_label(episode_no: int) -> str:
    """纯文本集号，供文件名等非 docx 场景复用同一口径。"""
    return f"第{int(episode_no)}集"


def _add_scene_header(doc: Document, scene: dict):
    """场次表头:
    场: 1-1
    景: 日 内 长信伯府 沈燕宁闺房
    人物: 沈燕宁、沈芝嫣、沈珍珠
    """
    scene_no = scene.get("scene_no", "")
    time_loc = scene.get("time_loc", "")
    characters = scene.get("characters") or []
    subtitle = scene.get("subtitle", "")
    
    # 场次三行(用紧凑段落)
    if scene_no:
        p1 = doc.add_paragraph()
        p1.paragraph_format.space_before = Pt(12)
        p1.paragraph_format.space_after = Pt(2)
        l = p1.add_run("场:")
        l.font.bold = True
        l.font.color.rgb = PURPLE
        l.font.size = Pt(11)
        v = p1.add_run(f"{scene_no}")
        v.font.size = Pt(11)
        v.font.bold = True
    
    if time_loc:
        p2 = doc.add_paragraph()
        p2.paragraph_format.space_after = Pt(2)
        l = p2.add_run("景:")
        l.font.bold = True
        l.font.color.rgb = PURPLE
        l.font.size = Pt(11)
        p2.add_run(f"{time_loc}").font.size = Pt(11)
    
    if characters:
        p3 = doc.add_paragraph()
        p3.paragraph_format.space_after = Pt(4)
        l = p3.add_run("人物:")
        l.font.bold = True
        l.font.color.rgb = PURPLE
        l.font.size = Pt(11)
        p3.add_run("、".join(characters)).font.size = Pt(11)
    
    # 字幕
    if subtitle:
        sp = doc.add_paragraph()
        sp.paragraph_format.space_after = Pt(4)
        sp.paragraph_format.left_indent = Cm(0.5)
        sr = sp.add_run(f"(出字幕: {subtitle})")
        sr.font.size = Pt(10)
        sr.font.color.rgb = ORANGE
        sr.italic = True


def _add_action(doc: Document, content: str):
    """△画面描述"""
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.first_line_indent = Cm(0.5)
    # content应该已经包含△
    text = content if content.startswith("△") else f"△{content}"
    run = p.add_run(text)
    run.font.size = Pt(11)
    run.font.color.rgb = BLACK


def _add_dialogue(doc: Document, character: str, mode: str, action: str, content: str):
    """人物对白
    格式:
    沈燕宁(OS, 低头穿针):
        做梦也没想到...
    """
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.left_indent = Cm(0.5)
    
    # 人物名
    name_run = p.add_run(character or "(无名)")
    name_run.font.bold = True
    name_run.font.color.rgb = PURPLE
    name_run.font.size = Pt(11)
    
    # 模式+表演提示
    parts = []
    if mode and mode.upper() in ("OS", "VO"):
        parts.append(mode.upper())
    if action:
        parts.append(action)
    if parts:
        meta_run = p.add_run(f"({', '.join(parts)})")
        meta_run.font.size = Pt(10)
        meta_run.font.color.rgb = ORANGE
        meta_run.italic = True
    
    # 冒号+对白(下一行,缩进)
    p.add_run(": ").font.bold = True
    
    content_run = p.add_run(content or "")
    content_run.font.size = Pt(11)
    content_run.font.color.rgb = DARK_GRAY


def _add_flashback_marker(doc: Document, is_start: bool):
    """【快速闪回】 / 【闪出】"""
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(2)
    text = "【快速闪回】" if is_start else "【闪出】"
    run = p.add_run(text)
    run.font.size = Pt(10)
    run.font.bold = True
    run.font.color.rgb = ORANGE


def _render_scene(doc: Document, scene: dict):
    """渲染单场"""
    _add_scene_header(doc, scene)
    
    elements = scene.get("elements") or []

    # 健壮性: 若 elements 存在但有元素缺少可识别的 type (历史脏数据里键被
    # 损坏成 "ype" 等), 渲染时该元素会被静默跳过 -> Word 丢字。
    # 此时回退到 action/dialogue 字段 (页面也用这两个字段, 内容完整)。
    _VALID_TYPES = {
        "action", "dialogue", "flashback_start", "flashback_end",
        "subtitle", "narration", "ost", "monologue",
    }
    if elements and any(
        (not isinstance(e, dict)) or (e.get("type", "") not in _VALID_TYPES)
        for e in elements
    ):
        if scene.get("action") or scene.get("dialogue"):
            elements = []  # 丢弃损坏的 elements, 走下方 action/dialogue 回退

    # 兼容旧格式 / 损坏回退: 没有可用 elements 时用 action+dialogue
    if not elements and (scene.get("action") or scene.get("dialogue")):
        if scene.get("action"):
            _add_action(doc, scene["action"])
        if scene.get("dialogue"):
            for line in scene["dialogue"].split("\n"):
                line = line.strip()
                if not line:
                    continue
                if ":" in line or "：" in line:
                    name, _, content = line.replace("：", ":").partition(":")
                    _add_dialogue(doc, name.strip(), "", "", content.strip())
                else:
                    _add_dialogue(doc, "", "", "", line)
        return
    
    # 新格式
    for e in elements:
        etype = e.get("type", "")
        if etype == "action":
            _add_action(doc, e.get("content", ""))
        elif etype == "dialogue":
            _add_dialogue(
                doc,
                character=e.get("character", ""),
                mode=e.get("mode", ""),
                action=e.get("action", ""),
                content=e.get("content", ""),
            )
        elif etype == "flashback_start":
            _add_flashback_marker(doc, True)
        elif etype == "flashback_end":
            _add_flashback_marker(doc, False)


def export_storyboard_to_docx(
    draft_title: str,
    chapter_title: str,
    chapter_order: int,
    shots: list[dict],
) -> bytes:
    """导出单章节剧本为Word(剧本式格式)"""
    doc = Document()
    _set_default_font(doc)
    
    # 大标题
    title_p = doc.add_paragraph()
    title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_run = title_p.add_run(f"《{draft_title}》")
    title_run.font.size = Pt(24)
    title_run.font.bold = True
    title_run.font.color.rgb = PURPLE
    
    _add_episode_title(doc, chapter_order, chapter_title)

    # 场号按真实集号重排（见 stages/scene_no.py）：生成侧原先不知道自己是第几集，
    # 第 2 集以后一律从 1-1 起编，dev 库 17780 条分镜受影响。
    from .scene_no import renumber_scenes
    shots = renumber_scenes(shots, chapter_order)

    # 渲染每场
    for scene in shots:
        if isinstance(scene, dict):
            _render_scene(doc, scene)
    
    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    return buf.read()


def export_all_storyboards_to_docx(
    draft_title: str,
    chapters_with_shots: list[dict],
) -> bytes:
    """导出整剧所有章节"""
    doc = Document()
    _set_default_font(doc)
    
    # 封面
    title_p = doc.add_paragraph()
    title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_p.paragraph_format.space_before = Pt(60)
    title_run = title_p.add_run(f"《{draft_title}》")
    title_run.font.size = Pt(36)
    title_run.font.bold = True
    title_run.font.color.rgb = PURPLE
    
    sub_p = doc.add_paragraph()
    sub_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    sub_run = sub_p.add_run(f"完整剧本 · 共 {len(chapters_with_shots)} 集")
    sub_run.font.size = Pt(14)
    sub_run.font.color.rgb = GRAY
    
    doc.add_page_break()
    
    # 每集
    for ch_data in chapters_with_shots:
        ch_order = ch_data.get("chapter_order", 0)
        ch_title = ch_data.get("chapter_title", "")
        scenes = ch_data.get("shots") or []
        
        _add_episode_title(doc, ch_order, ch_title)

        # 同上：场号按真实集号重排
        from .scene_no import renumber_scenes
        scenes = renumber_scenes(scenes, ch_order)

        for scene in scenes:
            if isinstance(scene, dict):
                _render_scene(doc, scene)
        
        doc.add_page_break()
    
    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    return buf.read()
