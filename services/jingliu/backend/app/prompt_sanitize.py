"""剥掉富文本编辑器在提示词里留下的 HTML 残渣（镜流前端的 `@名字` chip）。

## 这些残渣是怎么来的

镜流前端 `promptHTML()` 把提示词里的 `@名字` 渲染成带样式的 chip：

    <span class="rchip manual" contenteditable="false" data-badge="图2"
          data-ref="断臂幸存者" data-src="/fw/media/generated/xxx.png"
          title="角色「断臂幸存者」">@断臂幸存者</span>

提示词编辑区是 `contenteditable`，失焦保存时读 `innerText` 写回后端。
修正前的替换实现是逐名字 `html.split(名字).join(chip)`，有两个缺陷叠加：

1. 它替换的是**裸子串**，会连上一步刚插进 HTML 的 chip **自己**一起替换 ——
   名字「幸存者」是「断臂幸存者」的后缀，轮到短名时把长名 chip 的
   `data-ref` / `title` **属性值**切开；
2. 切完拼出的破损片段会留在正文里，并被 `innerText` 原样存回。

生产实测（项目「21-22 10.07 测试2」，3 个镜头）留下的正是：

    …- @幸存者" data-src="/fw/media/generated/img_cabb22df113c.png"
      title="角色「断臂@幸存者」">@断臂@幸存者：参考 @图片2。…

前端已于 2026-10-07 修好（改为单次正则替换，见 `shotflow-web/app.js` 的
`promptHTML`），但**存量数据还在**，且 `profile_override.prompt` 里那份是
实际下发给模型的第一优先级来源 —— 所以后端必须自己再挡一道。

## 为什么不能"把尖括号都剥掉"

提示词里**合法**出现大量 `<...>`：`<d>`/`</d>`（台词，719 个镜头在用）、
H3 的 `<Subject N>` / `<Picture N>` / `<Audio N>` / `<Video N>`、
`<scenetrans>` / `<cutoff>`，以及中文音效标签 `<柴火爆裂声>`。
无差别剥尖括号会把这些一起毁掉。所以本模块只认**编辑器 chip 的指纹**。

## 判据

- `<span …>` / `</span>`：视频提示词里从不需要 span，直接删标签、留文字。
- **孤立的属性片段**：1 个以上的 `属性="值"` 连成一串，且**至少含一个
  chip 专有属性**（`data-badge` / `data-ref` / `data-src` / `contenteditable`，
  或 `class="rchip…"`）才算数 —— `class` / `title` 本身太通用，单独出现不动。

全库校验：对 2459 条 `gen_prompt` 跑一遍，**只有那 3 条已知破损被改动**，
其余逐字节不变（`scripts/verify_prompt_sanitize.py`）。
"""

from __future__ import annotations

import re

#: chip 模板里会用到的全部属性（`shotflow-web/app.js` 的 `promptHTML`）。
_ATTR = (r"(?:data-badge|data-ref|data-src|contenteditable|class|title)"
         r"\s*=\s*\"[^\"]*\"")

#: 只有这些属性单独出现才能证明"这是编辑器 chip"。
#: `class` / `title` 太通用（虽然实测全库只有 chip 在用），不作为判据。
_CHIP_MARK = re.compile(
    r"\b(?:data-badge|data-ref|data-src|contenteditable)\s*="
    r"|\bclass\s*=\s*\"rchip"
    r"|\bclass\s*=\s*\"[^\"]*\brchip\b"
)

#: 一段连续的属性，容许前面粘着一个孤立引号、后面跟着标签的 `>`。
#: 前后那两截都是 split/join 切出来的残骸（如 `幸存者" data-src=…">`）。
_ATTR_RUN = re.compile(rf"\"?\s*(?:{_ATTR}\s*)+>?")

#: span 标签本身。`\b` 保证不会误伤 `<spans>` 这类以 span 开头的词。
_SPAN_TAG = re.compile(r"</?span\b[^>]*>", re.IGNORECASE)


def _drop_run(m: re.Match[str]) -> str:
    """只删**带 chip 专有属性**的属性串；别的原样留着。"""
    return "" if _CHIP_MARK.search(m.group(0)) else m.group(0)


def strip_editor_chrome(text: str | None) -> str:
    """剥掉 chip 的 HTML（标签 + 孤立属性片段），返回正文。

    幂等：对已经干净、或已剥过一次的文本再调用不产生变化。

    ## 只做删除，不做重建（重要）

    被 chip 覆盖掉的原文在字符层面**不可还原**。以生产实际数据为例：

        原文（正确）      - @断臂幸存者：参考 @图片2。
        库里的破损形态    - @幸存者" data-src="…" title="角色「断臂@幸存者」">@断臂@幸存者：参考 @图片2。

    破损形态里同时留着 `@幸存者` 与 `@断臂@幸存者` 两截，谁也不包含那个
    正确的 `@断臂幸存者`。删掉属性残渣后得到 `@幸存者@断臂@幸存者` ——
    诚实，但仍是错的。

    本模块**刻意不去猜**：任何"从 title 属性反推原名"的修复都只对已知的
    这一种形态成立，遇到别的破损就会凭空写入一个用户没写过的名字，
    而这种错会被当成"AI 写坏了提示词"，排查成本极高。存量破损交给用户
    定夺（可走 `DELETE /shots/{id}/prompt` 撤销手改让 AI 重写）。

    ## 也不做空白归一化

    早期版本顺手把 `\\n{3,}` 折成 `\\n\\n`。全库实测那是**109 条无关改动**
    ——用户的正文排版不是编辑器残渣，净化器没有权限动它。
    """
    if not text:
        return text or ""
    out = _SPAN_TAG.sub("", text)
    out = _ATTR_RUN.sub(_drop_run, out)
    return out


def has_editor_chrome(text: str | None) -> bool:
    """只判断、不改动。给自检/巡检脚本用。"""
    if not text:
        return False
    if _SPAN_TAG.search(text):
        return True
    return any(_CHIP_MARK.search(m.group(0)) for m in _ATTR_RUN.finditer(text))
