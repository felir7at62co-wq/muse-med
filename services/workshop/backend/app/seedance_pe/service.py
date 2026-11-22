"""Seedance PE 服务: 加载 skill 资产 → 组装 system prompt → LLM 优化原始提示词。

设计:
- 启动时一次性把 SKILL.txt + references/*.txt 读入内存(进程级缓存), 避免每次 IO。
- SKILL 明确要求"每次优化必须依据全部 6 个参考文档", 所以把它们整体拼进 system prompt
  (总量 ~93KB ≈ 30-40K tokens, 现代长上下文模型单次可承载)。
- LLM 用 SystemMessage(skill+refs) + HumanMessage(用户原始提示词) 调用。
"""
from __future__ import annotations

import os
from functools import lru_cache
from typing import Optional

from langchain_core.messages import SystemMessage, HumanMessage

from ..models.llm import get_llm

_ASSETS_DIR = os.path.join(os.path.dirname(__file__), "skill_assets")
_REF_DIR = os.path.join(_ASSETS_DIR, "references")

# SKILL 里声明的 6 个参考文档(顺序固定, 与 SKILL.txt 一致)
_REFERENCE_FILES = [
    "prompt-guide.txt",
    "api-doc-rules.txt",
    "business-guide-examples.txt",
    "engineering-prompt-methodology.txt",
    "seedance-2-troubleshooting-guide.txt",
    "typical-effect-cases.txt",
]


def _read(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception as e:  # noqa: BLE001
        return f"(读取失败: {os.path.basename(path)}: {e})"


@lru_cache(maxsize=1)
def build_system_prompt() -> str:
    """组装 system prompt = SKILL 方法论 + 全部 6 个参考文档。进程级缓存。"""
    skill = _read(os.path.join(_ASSETS_DIR, "SKILL.txt"))
    parts = [
        "你是 Seedance 2.0 视频提示词优化专家。严格遵循下方《技能说明》的工作流程与硬性约束, "
        "并在每次优化前充分参考随附的全部参考文档。",
        "\n\n========== 技能说明 (SKILL) ==========\n",
        skill,
        "\n\n========== 参考文档 (references, 每次优化必须依据) ==========\n",
    ]
    for fn in _REFERENCE_FILES:
        content = _read(os.path.join(_REF_DIR, fn))
        parts.append(f"\n\n### 参考文档: {fn}\n{content}\n")
    parts.append(
        "\n\n========== 输出要求 ==========\n"
        "按 SKILL 第五步输出: 1) 问题分析  2) 优化后的标准提示词(放在代码块中, 内部禁止出现任何特殊图标符号)  "
        "3) 优化说明  4) 【依据参考文档】明确标注本次依据的 reference 文档名与章节。"
        "严格保留用户原始意图、台词与音频信息, 不得丢弃。"
    )
    return "".join(parts)


def get_asset_status() -> dict:
    """自检: skill 资产是否齐全(给健康检查/排错用)。"""
    skill_ok = os.path.isfile(os.path.join(_ASSETS_DIR, "SKILL.txt"))
    refs = {fn: os.path.isfile(os.path.join(_REF_DIR, fn)) for fn in _REFERENCE_FILES}
    sys_len = len(build_system_prompt())
    return {
        "skill_present": skill_ok,
        "references": refs,
        "all_references_present": all(refs.values()),
        "system_prompt_chars": sys_len,
    }


def extract_optimized_prompt(markdown: str) -> Optional[str]:
    """从优化结果 markdown 里抽出'优化后的标准提示词'代码块的纯文本。

    渲染流程串联时只需要这段最终提示词(喂给 Seedance API), 不要问题分析/说明。
    取第一个 ``` 代码块内容; 取不到则返回 None。
    """
    import re
    if not markdown:
        return None
    # 匹配 ```text ... ``` 或 ``` ... ```; 容错换行(grok 可能紧跟内容无\n)
    blocks = re.findall(r"```(?:[a-zA-Z]*)\s*(.*?)```", markdown, re.DOTALL)
    for b in blocks:
        t = b.strip()
        if t:
            return t
    return None


async def optimize_to_prompt(
    rendered_prompt: str,
    *,
    provider: str = "gemini",
    extra_context: Optional[str] = None,
) -> Optional[str]:
    """渲染流程专用: 把渲染好的初版 prompt 再优化, 只返回'优化后的纯提示词'(无分析说明)。

    extra_context: 可选补充背景(如"本次可用参考图清单"), 拼在用户消息后, 用于约束优化行为。
    优化失败/抽不到代码块时返回 None, 调用方应回退用原渲染稿(不阻断渲染流程)。
    """
    r = await optimize_prompt(rendered_prompt, provider=provider, extra_context=extra_context)
    if not r.get("ok"):
        return None
    return extract_optimized_prompt(r.get("optimized_markdown") or "")


async def optimize_prompt(
    raw_prompt: str,
    *,
    provider: str = "gemini",
    extra_context: Optional[str] = None,
) -> dict:
    """优化用户的原始视频提示词。

    raw_prompt: 用户的原始/口语化提示词, 或可公开分享的完整请求体文本。
    返回: { ok, optimized_markdown, provider }  (optimized_markdown 为完整 markdown 回复)
    """
    raw = (raw_prompt or "").strip()
    if not raw:
        return {"ok": False, "error": "原始提示词为空, 请提供需要优化的视频提示词。"}

    system_prompt = build_system_prompt()
    human = raw
    if extra_context:
        human = f"{raw}\n\n[补充背景]\n{extra_context.strip()}"

    try:
        # 长 system prompt + 需要稳定结构化输出 → 低温度
        llm = get_llm("generate", temperature=0.3, provider=provider)  # type: ignore[arg-type]
        resp = await llm.ainvoke([
            SystemMessage(content=system_prompt),
            HumanMessage(content=human),
        ])
        text = getattr(resp, "content", "") if resp else ""
        if not text or not str(text).strip():
            return {"ok": False, "error": "模型未返回内容, 请重试。"}
        return {"ok": True, "optimized_markdown": str(text).strip(), "provider": provider}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"优化失败: {e}"}