"""概念生成 prompt 模板"""
from __future__ import annotations


CONCEPT_GEN_PROMPT = """你是资深短剧策划师。请生成 {count} 部独立的短剧概念。

# 题材偏好(组合标签)
{genre_hint}

# 短剧爆款公式
- 开场必须 30 秒内有强冲突
- 主角设定要有"反差感",但不要套路化
- 至少 1 个核心反派 + 1 个明确目标(复仇/守护/逆袭)
- 题材融合更易爆款(豪门+战神,重生+甜宠等)
- **人物关系自由设计**,不限模板,符合题材逻辑即可

# 输出要求(严格 JSON,无前后文字,无 Markdown 包装)
返回长度为 {count} 的 JSON 数组,每个元素如下:

[
  {{
    "title": "标题(8字内,有钩子)",
    "synopsis": "剧情概要(150-250字,讲清主角、目标、核心冲突、爆点)",
    "main_characters": [
      {{"name": "角色名", "role": "在故事中的定位(自由描述)", "key_trait": "性格关键词"}}
    ],
    "tags": ["豪门", "复仇"],
    "core_hook": "最大的爆点是什么(1句话)"
  }}
]

要求每部独立故事,差异化(避免雷同)。
不要给出任何解释,直接输出 JSON 数组。
"""


def build_genre_hint(genre_items: list[dict], adhoc_tags: list[str]) -> str:
    """把题材列表 + ad-hoc 词拼成 prompt 用的 genre_hint 字符串。

    genre_items: [{label, description, prompt_hint}]
    adhoc_tags: ["古风", "赛博朋克"]
    """
    parts = []
    for g in genre_items or []:
        label = g.get("label") or g.get("key", "")
        desc = g.get("prompt_hint") or g.get("description") or ""
        if desc:
            parts.append(f"{label}({desc})")
        else:
            parts.append(label)
    for t in adhoc_tags or []:
        if t and t.strip():
            parts.append(f"临时:{t.strip()}")

    if not parts:
        return "由你自由发挥,覆盖当下热门短剧题材(豪门/复仇/重生/战神/甜宠/悬疑等)"
    return "、".join(parts)
