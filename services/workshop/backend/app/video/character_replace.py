"""角色代号 → 真实姓名 批量替换器

把 男1/男2/女1/女2/老1/童1 等占位代号,在以下三处全局替换为用户填写的真名:
1. script_chapters.full_text  (字符串全词替换)
2. script_storyboards.shots_json  (深层遍历,改 characters 列表 + elements.character + elements.content)
3. script_drafts.outline.characters / character_mapping  (登记映射 + 更新 name)

特点:
- 增量替换:只替换 mapping 里有值的 alias,空值跳过
- 撤销机制:把 mapping 反向跑一遍即可还原(由调用方决定是否保留)
- 占位名校验:只接受 (男|女|老|童)\d+ 这种代号,防止用户把现有人名当 alias 误传
- 全词匹配:用 lookaround 避免 "男12" 被替成 "陆远2"
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from sqlalchemy import select, update

from ..db import (
    ScriptChapter,
    ScriptDraft,
    ScriptStoryboard,
    session_scope,
)

logger = logging.getLogger("video.character_replace")


# 合法占位 alias: 男1 男2 ... 女1 ... 老1 ... 童1 ... 路人 旁白
PLACEHOLDER_RE = re.compile(r"^(?:男|女|老|童)\d+$|^路人$|^旁白$")


def _validate_alias(alias: str) -> bool:
    return bool(alias) and bool(PLACEHOLDER_RE.match(alias))


def _build_replace_pattern(alias: str) -> re.Pattern:
    """全词匹配 alias,避免 男1 撞上 男12

    中文没有 \\b 词边界,用 lookaround:
    - 前面不能紧跟同类汉字 / 数字
    - 后面不能紧跟数字
    """
    if alias in ("路人", "旁白"):
        return re.compile(re.escape(alias))
    # 男/女/老/童\d+ 形式
    head = alias[0]
    return re.compile(rf"(?<![{head}0-9]){re.escape(alias)}(?!\d)")


def _replace_in_text(text: str, mapping: dict[str, str], allow_any: bool = False) -> str:
    if not text or not mapping:
        return text
    # 优先处理长 alias(防止 男10 被 男1 先替掉)
    for alias in sorted(mapping.keys(), key=lambda x: -len(x)):
        real = mapping[alias]
        if not real:
            continue
        if not allow_any and not _validate_alias(alias):
            continue
        text = _build_replace_pattern(alias).sub(real, text)
    return text


def _deep_replace(obj, mapping: dict[str, str], allow_any: bool = False):
    """递归遍历任意嵌套(dict/list/str), 把所有字符串里的名字替换掉。
    用于把整个 outline(含 character_bible/character_registry/world/adaptation 等
    任意深度子块)里的人名一次扫干净, 避免逐 key 枚举漏字段。
    """
    if isinstance(obj, str):
        return _replace_in_text(obj, mapping, allow_any)
    if isinstance(obj, list):
        return [_deep_replace(x, mapping, allow_any) for x in obj]
    if isinstance(obj, dict):
        return {k: _deep_replace(v, mapping, allow_any) for k, v in obj.items()}
    return obj


def _replace_in_shot(shot: dict, mapping: dict[str, str], allow_any: bool = False) -> dict:
    """对单个 shot 做全字段深度替换, 返回新 shot。

    关键: 用 _deep_replace 递归替换 shot 里【任意字段、任意层级】的所有字符串,
    这样 action/dialogue/subtitle/time_loc/elements 以及任何"场景表头"类字段
    (如 scene_heading / header / 含'【场 1-1｜…｜出场：林晚、沈默｜5s】'的字段)
    都会被一次扫到, 不再因为逐 key 枚举而漏字段。
    """
    if not isinstance(shot, dict):
        return shot
    # 整个 shot 深度替换(覆盖所有字符串字段, 含 characters 列表里的名字)
    return _deep_replace(shot, mapping, allow_any)


async def apply_character_mapping(
    draft_id: int,
    mapping: dict[str, str],
    *,
    save_history: bool = True,
    allow_any: bool = False,
) -> dict[str, Any]:
    """把 mapping 应用到 draft 的所有 chapter 和 storyboard

    Args:
        draft_id: 草稿ID
        mapping: {alias: real_name},空 real_name 会被跳过
        save_history: 是否把本次替换登记到 outline.character_mapping 历史
        allow_any: True 时允许任意源名(不限于 男1/女1 占位代号), 用于通用"改名"
                   (如 陆淮→刘淮); 视频反推流程保持 False(只换占位代号)。

    Returns:
        {chapters_updated, storyboards_updated, mapping_saved}
    """
    # 校验 + 过滤
    clean_mapping: dict[str, str] = {}
    invalid: list[str] = []
    for alias, real in (mapping or {}).items():
        alias = (alias or "").strip()
        real = (real or "").strip()
        if not alias or not real:
            continue
        # allow_any=True(通用改名): 接受任意源名; 否则只接受 男1/女1 等占位代号
        if not allow_any and not _validate_alias(alias):
            invalid.append(alias)
            continue
        # 真名不能是另一个 alias 形式(防止用户填错); allow_any 模式不限制
        if not allow_any and PLACEHOLDER_RE.match(real):
            invalid.append(f"{alias}->{real}")
            continue
        clean_mapping[alias] = real

    if invalid:
        raise ValueError(f"非法的占位代号或真名: {invalid}")

    if not clean_mapping:
        return {"chapters_updated": 0, "storyboards_updated": 0, "mapping_saved": {}}

    chapters_updated = 0
    storyboards_updated = 0

    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            raise ValueError(f"draft {draft_id} 不存在")

        # 1. chapters.full_text
        chs = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
        )).scalars().all()
        for ch in chs:
            old = ch.full_text or ""
            new = _replace_in_text(old, clean_mapping, allow_any)
            if new != old:
                ch.full_text = new
                ch.word_count = len(new)
                chapters_updated += 1
            # summary 也跟着改
            if ch.summary:
                ch.summary = _replace_in_text(ch.summary, clean_mapping, allow_any)
            # title 通常无人名,但保险起见
            if ch.title:
                ch.title = _replace_in_text(ch.title, clean_mapping, allow_any)

        # 2. storyboards.shots_json
        sbs = (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
        )).scalars().all()
        for sb in sbs:
            shots = sb.shots_json or []
            if not isinstance(shots, list):
                continue
            new_shots = [_replace_in_shot(sh, clean_mapping, allow_any) for sh in shots]
            if new_shots != shots:
                sb.shots_json = new_shots
                # 强制 ORM 标记 JSON 字段已变(否则不会 update)
                from sqlalchemy.orm.attributes import flag_modified
                flag_modified(sb, "shots_json")
                storyboards_updated += 1

        # 3. outline 全量深度替换
        # 关键修复: 之前只替换了 outline 的 characters/chapters/synopsis 几个固定 key,
        # 导致 character_bible / character_registry / world / adaptation 等子块里的
        # 人名(及"陆氏""陆家"等称谓)残留没被替, 用户看到"改不干净"。
        # 现在改成对【整个 outline 字典】递归深度替换所有字符串, 保证 100% 覆盖, 不漏任何字段。
        # 注意: character_mapping(历史映射表)本身不能被替(否则旧 key 也被改), 先摘出来最后单独处理。
        outline = dict(draft.outline or {})
        saved_mapping_history = dict(outline.get("character_mapping") or {})
        outline.pop("character_mapping", None)

        # 深度替换整个 outline(characters/character_bible/character_registry/world/
        # adaptation/chapters/synopsis... 任意层级的字符串全部扫到)
        outline = _deep_replace(outline, clean_mapping, allow_any)

        # 角色卡: 深度替换已把描述文本改了, 这里再补一手 alias 字段保留(便于回退)
        for c in outline.get("characters") or []:
            if isinstance(c, dict):
                # name 已被深度替换为真名; 若原 alias 命中映射则保留原 alias 记录
                for old_alias in clean_mapping:
                    if c.get("alias") == old_alias or c.get("name") == clean_mapping[old_alias]:
                        c["alias"] = old_alias
                        break

        # 累积 character_mapping(增量合并, 历史表本身不参与替换)
        if save_history:
            saved_mapping_history.update(clean_mapping)
        outline["character_mapping"] = saved_mapping_history

        draft.outline = outline
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(draft, "outline")

    logger.info(
        "apply_character_mapping draft=%d mapping=%d ch=%d sb=%d",
        draft_id, len(clean_mapping), chapters_updated, storyboards_updated,
    )
    return {
        "chapters_updated": chapters_updated,
        "storyboards_updated": storyboards_updated,
        "mapping_saved": clean_mapping,
    }
