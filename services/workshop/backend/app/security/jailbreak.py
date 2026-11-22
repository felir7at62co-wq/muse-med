"""入口 Jailbreak 检测：拦截试图反推系统指令的恶意输入。

M3：关键词 + 模式匹配。M4 可引入轻量 LLM 分类。
"""
from __future__ import annotations

import re
from typing import Sequence

# 高危模式：试图获取 system prompt / 绕过限制
_PATTERNS: list[re.Pattern] = [
    re.compile(p, re.IGNORECASE)
    for p in [
        r"(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)",
        r"(repeat|print|output|show|tell|reveal|display)\s+(your\s+)?(system|initial|hidden|secret)\s+(prompt|instructions?|message|rules?)",
        r"what\s+(is|are)\s+your\s+(system|hidden|secret)\s+(prompt|instructions?|rules?)",
        r"你的系统(提示|指令|规则)",
        r"(输出|打印|重复|显示|泄露).{0,10}(系统|隐藏|内部).{0,10}(提示|指令|模板|规则)",
        r"(忽略|无视|忘记).{0,10}(之前|以上|先前).{0,10}(指令|规则|提示)",
        r"DAN\s+mode|jailbreak|developer\s+mode|god\s+mode",
    ]
]


def is_jailbreak(text: str) -> bool:
    """返回 True 表示检测到 Jailbreak 尝试。"""
    for pat in _PATTERNS:
        if pat.search(text):
            return True
    return False


BLOCK_RESPONSE = "⚠️ 检测到不当请求，已被安全策略拦截。请正常使用创作功能。"
