"""镜头提示词「是不是剧本原文」的唯一判据（2026-10-19）。

## 背景

拆解后会逐镜预生成视频提示词（`jobs` 里的 pregen）。优化器失败时（渠道挂了、
模型输出解析不了）那一镜**回退成剧本原文**，而此前落库时照样标 `draft`——
与优化成功在库里、在界面上完全一样。无参考图的镜头出片时会直接拿预生成稿走，
于是剧本原文原封不动发给了视频模型。用户报的「拆解失败直接把原文输出进提示词」
即此；dev 库实测 11020 条提示词里 1004 条与原文一字不差。

## 判据

1. `prompt_state == "raw"`：2026-10-19 起回退时直接打这个标。
2. 老数据没有标：去掉 `lock_style_line` 拼在最前面的那行画风句后，
   **与 script_ref 逐字相等**即视为原文。只认"逐字相等"，不认"包含"——
   优化器正常产出也常常引用原句，按包含判会大面积误报。
3. `manual`（用户手改过）一律不算：哪怕他手改成了原文，那也是他的意图。
4. ⚠️ **没有提示词框架的视频模型**（veo 等）本来就直通原文、不算降级——
   这类项目里"提示词 == 原文"是设计行为。所以第 2 条只在 `legacy=True`
   （项目的视频模型确有就绪框架）时生效，见 `project_has_framework`。
   显式打了 `raw` 标的不受影响：那是优化器真的失败了。
"""
from __future__ import annotations

RAW = "raw"


def _strip_style_head(text: str) -> str:
    """去掉 `lock_style_line` 拼的首行画风句（`<video_line><render_line>\\n…`）。"""
    if "\n" not in text:
        return text
    first, rest = text.split("\n", 1)
    if "渲染规格：" in first and first.startswith("全片画风："):
        return rest
    return text


def is_raw(gen_prompt: str | None, script_ref: str | None,
           prompt_state: str | None, *, legacy: bool = True) -> bool:
    if prompt_state == RAW:
        return True
    if prompt_state == "manual" or not legacy:
        return False
    g = (gen_prompt or "").strip()
    r = (script_ref or "").strip()
    if not g or not r:
        return False
    return _strip_style_head(g).strip() == r


def project_has_framework(proj) -> bool:
    """项目的视频模型有没有提示词框架（没有 = 直通原文是设计行为）。

    与出片选模型同一口径（`jobs._resolve_project_video_model` → 配置兜底）。
    判不出来时返回 True：宁可多报一个"原文提示词"让用户看一眼，也不漏报。

    2026-11-19：镜流自带的提示词引擎已删除（镜头脚本由 Muse 撰写），框架"就绪"
    （技能文档在不在）这一层随之没有了；这里只看模型属不属于有框架的那一族。
    本函数现在只服务于**存量数据**的体检（旧版预生成回退成原文的那批镜头）。
    """
    try:
        from .config import get_settings
        from .jobs import _resolve_project_video_model
        from .prompt_opt.service import framework_for_model
        model = _resolve_project_video_model(proj) or get_settings().video_model
        return bool(framework_for_model(model)) if model else False
    except Exception:          # noqa: BLE001
        return True
