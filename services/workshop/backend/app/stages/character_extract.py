"""角色一致性 — 花名册(registry) + 角色圣经(bible) 抽取与合并。

存储位置 (挂在 draft.outline JSON 下, 不新建表):
  outline.character_registry = {
    "version": int, "updated_at": iso,
    "characters": [{"name", "aliases":[], "one_line"}]
  }
  outline.character_bible = {
    "version": int, "updated_at": iso,
    "characters": [{"name","stance","traits":[],"motivation","relation","speech_style"}]
  }

设计要点:
  - 抽取即生效 (用户不改默认确认); 用户可在前端「角色」页编辑覆盖。
  - registry 解决"角色名漂移": 续写时无视档位永远注入完整花名册。
  - bible 解决"人设/立场漂移": 续写时注入立场/性格硬约束。
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone

from ..models.llm import get_llm

logger = logging.getLogger("character_extract")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _extract_json_obj(text: str) -> dict:
    """从 LLM 输出中提取 JSON 对象, 容错 markdown 包装。"""
    if not text:
        raise ValueError("empty LLM response")
    raw = text.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw)
    except Exception:
        m = re.search(r"\{[\s\S]*\}", raw)
        if not m:
            raise
        return json.loads(m.group(0))


_EXTRACT_PROMPT = """你是剧本设定整理专家。请从下面的剧本/小说正文中,抽取**全部出场角色**的设定信息。

# 正文(节选)
{corpus}

# 任务
抽取所有有名字的角色,为每个角色给出:
- name: 角色正式姓名(最常用的那个)
- aliases: 别名/小名/称呼数组(如"阿深""林少""他爹"),没有则空数组
- one_line: 一句话身份(如"男主,财阀私生子")
- stance: 立场, 只能是 "正"/"反"/"中立" 之一
- traits: 性格关键词数组(2-4个,如["隐忍","护短","表面冷漠"])
- motivation: 核心动机(一句话,没有则空字符串)
- relation: 与主角/核心人物的关系(一句话,没有则空字符串)
- speech_style: 说话风格(一句话,没有则空字符串)

# 输出格式(严格 JSON 对象,不要 markdown 包装,不要解释文字)
{{
  "characters": [
    {{
      "name": "林深",
      "aliases": ["阿深","林少"],
      "one_line": "男主,财阀私生子",
      "stance": "正",
      "traits": ["隐忍","护短","表面冷漠"],
      "motivation": "查清母亲死因",
      "relation": "苏晚的契约丈夫",
      "speech_style": "话少,命令式短句"
    }}
  ]
}}

# 要求
- 只抽取真正出场、有姓名的角色,跑龙套的路人不要。
- stance 必须基于正文表现判断,无法判断时填"中立"。
- 仅输出 JSON 对象。
"""


async def extract_characters(corpus: str, *, provider: str = "gemini",
                             max_chars: int = 30000) -> list[dict]:
    """从正文抽取角色信息(含 registry + bible 所需全部字段)。

    Returns: [{name, aliases, one_line, stance, traits, motivation, relation, speech_style}]
    失败返回空列表(不阻断主流程)。
    """
    text = (corpus or "").strip()
    if not text:
        return []
    # 控制 prompt 体积。
    # ⚠️ 默认 30000 是老行为，不动；`settings_backfill` 会传更大的值 ——
    # 它送进来的语料已经是**跨全剧均匀采样**的，按 30k 截断会把后半部剧
    # 连同只在后期出场的角色一起切掉。
    text = text[:max_chars]
    prompt = _EXTRACT_PROMPT.format(corpus=text)
    try:
        llm = get_llm("generate", temperature=0.3, provider=provider)
        resp = await llm.ainvoke(prompt)
        raw = getattr(resp, "content", "") if resp else ""
        obj = _extract_json_obj(raw)
        chars = obj.get("characters") or []
    except Exception as ex:
        logger.warning("extract_characters failed: %s", ex)
        return []

    out: list[dict] = []
    for c in chars:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name", "")).strip()
        if not name:
            continue
        stance = str(c.get("stance", "中立")).strip()
        if stance not in ("正", "反", "中立"):
            stance = "中立"
        out.append({
            "name": name,
            "aliases": [str(a).strip() for a in (c.get("aliases") or []) if str(a).strip()],
            "one_line": str(c.get("one_line", "")).strip(),
            "stance": stance,
            "traits": [str(t).strip() for t in (c.get("traits") or []) if str(t).strip()],
            "motivation": str(c.get("motivation", "")).strip(),
            "relation": str(c.get("relation", "")).strip(),
            "speech_style": str(c.get("speech_style", "")).strip(),
        })
    return out


def split_registry_bible(characters: list[dict]) -> tuple[dict, dict]:
    """把抽取结果拆成 registry 与 bible 两个结构。"""
    registry = {
        "version": 1,
        "updated_at": _now_iso(),
        "characters": [
            {
                "name": c["name"],
                "aliases": c.get("aliases") or [],
                "one_line": c.get("one_line", ""),
            }
            for c in characters
        ],
    }
    bible = {
        "version": 1,
        "updated_at": _now_iso(),
        "characters": [
            {
                "name": c["name"],
                "stance": c.get("stance", "中立"),
                "traits": c.get("traits") or [],
                "motivation": c.get("motivation", ""),
                "relation": c.get("relation", ""),
                "speech_style": c.get("speech_style", ""),
            }
            for c in characters
        ],
    }
    return registry, bible


def merge_new_names(registry: dict, new_characters: list[str]) -> dict:
    """把续写新章节里出现的新角色名增量并入 registry(只加名字, 详情留空待补)。"""
    reg = dict(registry or {})
    chars = list(reg.get("characters") or [])
    known = {c.get("name") for c in chars}
    known |= {a for c in chars for a in (c.get("aliases") or [])}
    added = False
    for name in new_characters:
        nm = (name or "").strip()
        if nm and nm not in known:
            chars.append({"name": nm, "aliases": [], "one_line": ""})
            known.add(nm)
            added = True
    if added:
        reg["characters"] = chars
        reg["version"] = int(reg.get("version") or 1) + 1
        reg["updated_at"] = _now_iso()
    return reg


def build_registry_block(registry: dict) -> str:
    """生成续写 prompt 注入的"角色花名册"块(永远注入, 不占多少 token)。"""
    chars = (registry or {}).get("characters") or []
    if not chars:
        return ""
    lines = ["# 角色花名册（权威姓名，续写中只能使用以下名字）"]
    for c in chars:
        name = c.get("name", "")
        aliases = c.get("aliases") or []
        one = c.get("one_line", "")
        line = f"- {name}"
        if aliases:
            line += f"（别名：{'/'.join(aliases)}）"
        if one:
            line += f"：{one}"
        lines.append(line)
    lines.append(
        "【硬约束】续写只能使用上表中的姓名；禁止改名或新造同义名；"
        "确需新增角色时，必须是全新人物并在 synopsis 中显式说明。"
    )
    return "\n".join(lines)


def build_bible_block(bible: dict) -> str:
    """生成续写 prompt 注入的"角色设定"块(立场/性格硬约束)。"""
    chars = (bible or {}).get("characters") or []
    if not chars:
        return ""
    lines = ["# 角色设定（严格遵守，不得违背）"]
    for c in chars:
        name = c.get("name", "")
        stance = c.get("stance", "中立")
        traits = "/".join(c.get("traits") or [])
        motiv = c.get("motivation", "")
        seg = f"- {name}｜立场：{stance}"
        if traits:
            seg += f"｜性格：{traits}"
        if motiv:
            seg += f"｜动机：{motiv}"
        lines.append(seg)
    lines.append(
        "【硬约束】严格遵守每个角色的立场与性格。正派不得无故黑化、"
        "反派不得无理由洗白，除非大纲 must_have 中明确写了该转变情节。"
    )
    return "\n".join(lines)


__all__ = [
    "extract_characters",
    "split_registry_bible",
    "merge_new_names",
    "build_registry_block",
    "build_bible_block",
]