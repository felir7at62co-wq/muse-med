"""模板辅助 — 按 key 加载模板, 渲染 Jinja2 风格变量."""
from __future__ import annotations

import re
from typing import Any, Optional

from sqlalchemy import select

from ..db import session_scope
from ..db.models import PromptTemplate


_VAR_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


async def get_template_by_key(key: str) -> Optional[PromptTemplate]:
    async with session_scope() as s:
        row = (await s.execute(
            select(PromptTemplate).where(PromptTemplate.key == key, PromptTemplate.is_active == True)
        )).scalar_one_or_none()
        return row


async def list_templates(kind: Optional[str] = None) -> list[PromptTemplate]:
    async with session_scope() as s:
        stmt = select(PromptTemplate).where(PromptTemplate.is_active == True)
        if kind:
            stmt = stmt.where(PromptTemplate.kind == kind)
        stmt = stmt.order_by(PromptTemplate.kind, PromptTemplate.display_order, PromptTemplate.id)
        return list((await s.execute(stmt)).scalars().all())


def render_template(template: str, variables: dict[str, Any]) -> str:
    """简易 Jinja2 风格变量替换 ({{var}}).

    缺失变量替换为空字符串 (不报错, 让 LLM 自行处理).
    """
    def _sub(m: re.Match) -> str:
        name = m.group(1)
        v = variables.get(name, "")
        return str(v) if v is not None else ""
    return _VAR_RE.sub(_sub, template)


def shots_to_text(shots: list[dict]) -> str:
    """把 shots_json 列表渲染成给 LLM 看的纯文本.

    每镜一段:
        ## 镜 1 [中景, 5s]
        【场景】日 外 二舅家门口
        【动作】△中景: ...
        【对白】刘强【敲门后】: 二舅, 在家吗?
                二舅【画外音】: 强子啊, ...
        【备注】
    """
    parts = []
    for shot in shots:
        sn = shot.get("shot_no", "?")
        st = shot.get("shot_type", "")
        dur = shot.get("duration", "")
        loc = shot.get("location") or shot.get("time_loc", "")
        action = (shot.get("action") or "").strip()
        dialogue = (shot.get("dialogue") or "").strip()
        notes = (shot.get("notes") or "").strip()
        head = f"## 镜 {sn} [{st}, {dur}s]"
        chunk = [head]
        if loc:
            chunk.append(f"【场景】{loc}")
        if action:
            chunk.append(f"【动作】{action}")
        if dialogue:
            chunk.append(f"【对白】{dialogue}")
        if notes:
            chunk.append(f"【备注】{notes}")
        parts.append("\n".join(chunk))
    return "\n\n".join(parts)


def shots_to_brief(shots: list[dict]) -> str:
    """更紧凑的版本, 给渲染阶段用 (单任务素材)."""
    lines = []
    for shot in shots:
        sn = shot.get("shot_no", "?")
        st = shot.get("shot_type", "")
        action = (shot.get("action") or "").strip()
        dialogue = (shot.get("dialogue") or "").strip()
        line = f"  - 镜{sn} [{st}]: {action}"
        if dialogue:
            line += f" | 对白: {dialogue}"
        lines.append(line)
    return "\n".join(lines)


def extract_characters(shots: list[dict]) -> list[str]:
    """从 shots[*].elements[type=dialogue].character 抽出角色列表 (去重保序)."""
    seen = set()
    chars = []
    for shot in shots:
        for el in shot.get("elements", []) or []:
            if el.get("type") == "dialogue":
                ch = el.get("character") or ""
                if ch and ch not in seen:
                    seen.add(ch)
                    chars.append(ch)
    return chars
