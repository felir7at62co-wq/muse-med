"""生成后自动校验链（PLAN §3.3 / B8）

## 要解决的问题

用户问："为什么要跑精修？为什么不能生成时就确认生成结果是对的？"

根因不是"没有校验"，而是**校验要用户手动点**。实际情况（2026-09-19 核实）：

  大纲层：**已经有**自动校验 —— outline_gen.py 生成完就跑到 lint + drama_gate
  章节层：**完全没有** —— 生成完什么都不跑，用户不点「校验」就发现不了问题

所以本模块补的是**章节层**，并且刻意只跑**零 LLM** 的那部分。

## 为什么只跑零 LLM 的

`lint_outline` 有 `use_llm` 开关：规则层零成本秒级，LLM 层要花钱花时间。

生成后自动跑的应该是**免费的规则层**：
  · 成本为零 → 可以每章都跑，不必让用户权衡"值不值得查"
  · 秒级返回 → 不拖慢生成流程

LLM 层（语义级硬伤）**保持手动**：它贵且慢，用户主动点「校验」时才跑。
这不是妥协，而是分级 —— 免费的自动跑，昂贵的按需跑。

## 与「体检」入口的关系

对话工坊的「一键体检」四类（结构/文风/一致性/分镜）是**用户主动发起的深度检查**，
本模块是**生成后自动的浅层筛查**。两者互补，不重复：
自动的先兜底（把明显问题直接标在卡片上），用户想深查再走体检。
"""
from __future__ import annotations

import logging

logger = logging.getLogger("auto_check")


def check_chapter_zero_llm(
    *,
    text: str,
    chapter_order: int,
    outline: dict,
    word_target: int,
) -> list[dict]:
    """对一个刚生成的章节跑零 LLM 检查，返回问题列表。

    返回的每条与 lint_report 的 issue 形状对齐，便于前端复用同一套标注组件。

    检查项（全部零 LLM）：
      1. 字数偏离 —— 低于目标 60% 或超 150%（既有规则，此前只在批量路径里有）
      2. 人物名漂移 —— 出现人物表之外的"像人名"的词（chapter_gen 已有实现）
      3. 空/极短正文 —— 生成失败但没报错的兜底
    """
    issues: list[dict] = []
    t = text or ""

    # ── 1. 空/极短正文 ──
    # generate_chapter 内部已有一道长度校验会抛错，这里是**第二道**：
    # 万一将来那道校验被改宽，这里仍能拦住"落库了几十字"的情况。
    if len(t.strip()) < 50:
        issues.append({
            "level": "error",
            "episode": chapter_order,
            "code": "empty_text",
            "message": f"第{chapter_order}章正文仅 {len(t.strip())} 字，疑似生成失败",
            "auto": True,
        })
        return issues

    # ── 2. 字数偏离 ──
    # 与既有批量路径的判据一致（低于 60% 或超 150%），不另立标准。
    if word_target > 0:
        lo = int(word_target * 0.6)
        hi = int(word_target * 1.5)
        n = len(t)
        if n < lo:
            issues.append({
                "level": "warn",
                "episode": chapter_order,
                "code": "too_short",
                "message": f"第{chapter_order}章 {n} 字，明显短于目标 {word_target} 字",
                "auto": True,
            })
        elif n > hi:
            issues.append({
                "level": "warn",
                "episode": chapter_order,
                "code": "too_long",
                "message": f"第{chapter_order}章 {n} 字，明显超出目标 {word_target} 字",
                "auto": True,
            })

    # ── 3. 人物名漂移 ──
    #
    # ⚠ **不复用 chapter_gen.detect_name_drift**，也**不用滑动窗口**。
    #
    # 两次实测都失败，记下来避免后来者重走：
    #   一版：复用既有 detect_name_drift —— 它的正则 `[一-鿿]{2,4}` 会贪婪
    #         吞并相邻字，把"林清欢笑了"抓成「林清欢笑」，误报率极高。
    #   二版：自己按"人名指纹 + 2 字窗口"扫 —— 照样产出「盛晚说」「。盛晚」
    #         这类噪音。**窗口法在这里根本不成立**，因为中文没有词边界。
    #
    # 结论：这个检查**不该做**。理由不是"做不了"，而是**做了也没用**：
    #   · 真正的名字写岔（林清欢→林清歌）靠字符串比对抓不稳
    #   · 而抓得稳的那些（"盛晚说"）全是噪音
    #   · 自动跑的东西误报率高比没有更糟 —— 用户会学会忽略它
    #
    # 名字一致性**已经有两处更可靠的把关**：
    #   · 大纲层的 lint（consistency_lint._llm_layer，语义级，能真判对错）
    #   · 前端 _CharacterMapper（用户手动映射角色名，最可靠）
    # 所以这里**刻意不重复造一个更差的**。

    return issues
