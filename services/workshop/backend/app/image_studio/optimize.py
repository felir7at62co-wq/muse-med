"""生图提示词优化 (可选)。

用户在生图工作台勾选「提示词优化」时, 先用与所选生图模型对应的文本模型,
把用户提示词改写成更适合该绘图模型的高质量提示词, 再送绘图。

模型映射:
- gpt-image-2                -> gpt5 文本模型 (逻辑专项, 英文绘图提示更佳)
- gemini-3-pro-image-preview -> gemini 文本模型 (跨世界观) — Nano Banana Pro
- gemini-3.1-flash-image     -> gemini 文本模型 (跨世界观) — Nano Banana 2
"""
from __future__ import annotations

import logging

from ..models.llm import ainvoke_with_fallback

logger = logging.getLogger("image_studio.optimize")

# 生图模型 -> 文本优化模型 provider
_MODEL_TO_TEXT_PROVIDER = {
    "gpt-image-2": "gpt5",
    "gemini-3-pro-image-preview": "gemini",
    "gemini-3.1-flash-image": "gemini",
}

_SYS_PROMPT = (
    "你是专业的 AI 绘画提示词工程师。请把用户给的画面描述改写成一段更高质量、"
    "更利于文生图模型出图的提示词。要求:\n"
    "1. 保留原意与所有关键主体、动作、场景、镜头与情绪;\n"
    "2. 补充有助于画质的细节(光线、材质、构图、风格、镜头语言等), 但不要臆造与原意冲突的内容;\n"
    "3. 如果原文中包含明确的尺寸/宽高比/九宫格/网格等结构性指令, 必须原样保留, 不得删改;\n"
    "4. 只输出优化后的提示词正文, 不要加解释、标题或 markdown 包裹。"
)


async def optimize_prompt(prompt: str, image_model: str) -> str:
    """返回优化后的提示词; 失败时抛异常由调用方兜底。"""
    provider = _MODEL_TO_TEXT_PROVIDER.get(image_model, "gemini")
    messages = [
        {"role": "system", "content": _SYS_PROMPT},
        {"role": "user", "content": (prompt or "").strip()},
    ]
    msg = await ainvoke_with_fallback(
        messages, role="rewrite", temperature=0.7, primary=provider, max_tokens=1200,
    )
    out = (getattr(msg, "content", "") or "").strip()
    if not out:
        raise RuntimeError("优化结果为空")
    return out