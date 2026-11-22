"""单集大纲字段的形状规则（唯一事实来源）。

三个写入口共用这一份规则，避免各写一套后互相漂移：
  · check/fixer.py           定点修复（只改白名单里的字段）
  · stages/adaptation_prompts 改编后的集纲整理（normalize_adapted_chapters）
  · router_m5_enhanced        单集大纲 PATCH 接口

形状不对的字段**丢弃该字段**，不整集作废 —— 读侧（drama_gate 等）普遍写成
`(ep.get("hook_out") or {}).get("type")`，只防 None 不防字符串，所以
dict 字段里混进一个字符串就会让整份结构体检崩掉。形状必须在写入口把住。
"""
from __future__ import annotations

import json
from typing import Any

#: 戏剧契约字段（大纲生成提示词要求模型输出的那一组）
CONTRACT_FIELDS: tuple[str, ...] = (
    "core_push", "value_shift", "stakes", "hook_in", "hook_out", "escalation",
    "plant", "payoff", "forbidden", "audience_knows_delta", "char_knows_delta",
)

#: 每个字段落库时应有的类型。实测自全库 17641 集（2026-10-11）。
FIELD_SHAPE: dict[str, type] = {
    "title": str, "synopsis": str, "core_push": str, "value_shift": dict,
    "stakes": str, "escalation": str, "hook_out": dict, "hook_in": dict,
    "audience_knows_delta": str, "char_knows_delta": dict,
    "must_have": list, "characters": list, "plant": list, "payoff": list,
    "forbidden": list, "beats": list,
}

#: 单集大纲 PATCH 接口允许修改的字段（= 形状表里的全部字段）
PATCHABLE_FIELDS: frozenset[str] = frozenset(FIELD_SHAPE)

#: 一集正文被整段重写后，这些旧字段与新正文必然不一致，应一并清掉。
#:
#: 2026-11-07：大纲改成"正文即唯一事实"（要素块写进 `synopsis`）。旧数据身上
#: 仍带着契约字段与 `beats`，而**下游生成读的是它们、用户在界面上看不见它们**。
#: 留着就是"改了一句梗概、模型却照旧契约写"的第二事实来源 —— 那正是
#: `_beats_stale` 这类补丁要遮的问题。凡是重写了 `synopsis` 的路径，
#: 都把这些键清掉，让正文说了算。
STALE_AFTER_REWRITE: tuple[str, ...] = (
    "beats", "_beats_stale", "scene_cards", "_scene_cards_expanded",
    "core_push", "value_shift", "stakes", "hook_in", "hook_out", "escalation",
    "plant", "payoff", "forbidden", "audience_knows_delta", "char_knows_delta",
    "must_have", "payoff_moment", "payoff_kind", "opponent_move", "selling_point",
    "emotion_intensity", "power",
)


def shape_ok(k: str, v: Any) -> tuple[bool, Any]:
    """字段形状是否可用。返回 (是否通过, 归一化后的值)。

    容忍模型把 dict / list 序列化成 JSON 字符串返回（很常见）——
    能解析回目标类型就收下，解析不出就判为不通过。
    不在形状表里的字段一律放行（由调用方的白名单决定收不收）。
    """
    want = FIELD_SHAPE.get(k)
    if want is None:
        return True, v
    if isinstance(v, want):
        return True, v
    if want in (dict, list) and isinstance(v, str):
        try:
            parsed = json.loads(v)
        except Exception:  # noqa: BLE001
            return False, None
        if isinstance(parsed, want):
            return True, parsed
    return False, None


def pick_contract(item: dict) -> dict:
    """从模型输出的一集里取出**形状正确**的契约字段（空值不取）。"""
    out: dict = {}
    for k in CONTRACT_FIELDS:
        if k not in item:
            continue
        ok, v = shape_ok(k, item[k])
        if not ok:
            continue
        if v in (None, "", [], {}):
            continue
        if isinstance(v, str):
            v = v.strip()
        out[k] = v
    return out
