"""拆解新流程：模型切「段」（散文）→ 代码装「镜」（2026-11-10，用户裁定）。

方案见 `docs/PLAN-提示词上下文重组-2026-11-10.md` 第四节。一句话：

    旧：模型一次给出 镜头边界 + 秒数 + 是否连着 + 人物 + 道具 + 场景 + 10 项导演意图
        （严格 JSON，14 个键），代码事后并碎片 —— 并得不彻底
        （seedance-2.5 每集中位 5 镜、28% 短于 15 秒），且 JSON 一处破损整块报废。
    新：模型只切段并标注 场景 / 是否换场 / 人物 / 道具 + 原文（散文，5 个固定行首）；
        秒数与装箱由代码做：同场的段依次装，装满上限才封箱，**只在换场时断开**。

## 用户裁定的几条口径

· 一个镜头尽可能接近模型上限（2.5 = 30 秒），除非换场。人物换了不断开。
· 动作戏上限同样是 30 秒，不单独断开。动作戏的拍法由提示词那一步按原文
  机械判定（`prompt_compose.is_action_scene`），拆解不再标注动作强度。
· 导演意图取消。
· 纯环境描写合计最多 1.5 秒（`drama_timing.SCENERY_CAP_SEC`），不吃表演余量。

## 装箱看的是"最终下发秒数"

封箱后整镜还要过 `_clamp_duration`（加表演余量、台词下限）与
`_split_overlong_drama_shots`（按自然语速判要不要拆）。装箱若只看内容秒数，
28 秒内容加 3 秒余量就超了；按 5 字/秒装出来的镜头按 3.1 字/秒又会被拆开。
所以判据用与这两步**同口径**的 `final_seconds()`。
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

from . import drama_timing

log = logging.getLogger("fw.breakdown_segments")


# ---------------------------------------------------------------- 第一步：提示词

SEGMENT_SYSTEM = (
    "你是分镜师的助手。把剧本按剧情切成连续的「段」，并标注每段的场景与在场人物。\n"
    "\n"
    "【怎么切】\n"
    "1) 一段 = 一个连续的剧情单元：一轮对话、一个完整动作、一次情绪转折。"
    "在剧情自然停顿处切开。不用管时长，时长由系统计算。\n"
    "2) 同一个连续动作、同一件道具的一段过程必须在同一段里"
    "（开门进屋、接打同一通电话、递交并接过同一件物品、同一段追逐或撕扯）。\n"
    "3) 纯环境描写（如「阳光照在衣柜上」）不单独成段，归入它后面那一段。\n"
    "4) 场景标题行（如「日 内 某某房间」）和「人物：」名单行是元数据，"
    "不要抄进正文，用它们来填「场景」「人物」。\n"
    "5) **正文必须逐字照抄原文**，按原顺序，一个字都不能改、删、补；"
    "所有段的正文首尾相接，应当覆盖全部剧情。\n"
    "\n"
    "【怎么标注】\n"
    "· 场景：这一段发生在哪里（沿用剧本的场景名，如「夜 内 顾家客厅」）。\n"
    "· 换场：「是」= 这一段和上一段**不是同一个场景/同一段连续时间**"
    "（换了地点、时间跳跃、闪回）；同一场戏里继续往下演一律写「否」。第一段写「是」。\n"
    "· 人物：这一段**画面里在场**的全部角色，用顿号分隔。"
    "在画面里但不说话的也要列；不在画面里的不许列。"
    "「众人」「路人」「几个保安」这类群体不是角色，不要列。"
    "没有写离场的人默认还在原地。\n"
    "· 道具：这一段里**被点名、有戏份**的具体物件（被拿起、递出、打开、注视、砸碎），"
    "用顿号分隔；桌椅、杯子、衣服这类陈设与衣饰不算。没有就写「无」。\n"
    "\n"
    "【输出格式】严格照下面的样子，不要 JSON、不要代码块、不要任何解释：\n"
    "第1段\n"
    "场景：夜 内 顾家客厅\n"
    "换场：是\n"
    "人物：顾耀东、白薇\n"
    "道具：催款单\n"
    "正文：\n"
    "△深夜，顾家客厅只亮着一盏台灯。白薇攥着催款单站在桌边。\n"
    "白薇【哽咽】：这个月再还不上，房子就没了。\n"
    "\n"
    "第2段\n"
    "场景：夜 内 顾家客厅\n"
    "换场：否\n"
    "人物：顾耀东、白薇\n"
    "道具：钢笔、合同\n"
    "正文：\n"
    "△顾耀东咬牙拿起了钢笔。\n"
    "顾耀东【沉声】：仅此一次！\n"
)


# ---------------------------------------------------------------- 第一步：解析

@dataclass
class Segment:
    order: int
    script_ref: str
    location: str | None = None
    scene_change: bool = False
    characters: list[str] = field(default_factory=list)
    props: list[str] = field(default_factory=list)


_SEG_HEAD = re.compile(r"^\s*(?:#+\s*)?(?:\*\*)?\s*第\s*(\d+)\s*段\s*(?:\*\*)?\s*[：:]?\s*$")
_FIELD = re.compile(r"^\s*(场景|换场|人物|道具|正文)\s*[：:]\s*(.*)$")
_LIST_SPLIT = re.compile(r"[、，,；;/／\s]+")
_NONE_WORDS = {"", "无", "没有", "暂无", "none", "None", "-", "—"}


def _as_list(v: str) -> list[str]:
    out: list[str] = []
    for x in _LIST_SPLIT.split(v or ""):
        x = x.strip().strip("。.")
        if x and x not in _NONE_WORDS and x not in out:
            out.append(x)
    return out


def parse_segments(text: str) -> tuple[list[Segment], list[str]]:
    """把模型输出解析成段。返回 (段列表, 解析告警)。

    宽松：缺字段给默认值（换场默认"否"、场景沿用上一段、人物道具为空），
    只记告警不报错。坏一段只丢这一段，不影响其它段（这正是放弃 JSON 的理由）。
    """
    text = (text or "").replace("\r\n", "\n")
    # 模型偶尔还是会包代码块，剥掉围栏
    text = re.sub(r"^```[a-zA-Z]*\s*$", "", text, flags=re.M)
    lines = text.split("\n")
    blocks: list[tuple[int, list[str]]] = []
    cur: list[str] | None = None
    for line in lines:
        m = _SEG_HEAD.match(line)
        if m:
            cur = []
            blocks.append((int(m.group(1)), cur))
            continue
        if cur is not None:
            cur.append(line)
    warns: list[str] = []
    segs: list[Segment] = []
    prev_loc: str | None = None
    for n, body in blocks:
        meta: dict[str, str] = {}
        ref_lines: list[str] = []
        in_body = False
        for line in body:
            if in_body:
                ref_lines.append(line)
                continue
            m = _FIELD.match(line)
            if m:
                key, val = m.group(1), m.group(2)
                if key == "正文":
                    in_body = True
                    if val.strip():
                        ref_lines.append(val)
                else:
                    meta[key] = val.strip()
            elif line.strip():
                # 没写「正文：」就直接开始写正文 —— 从这一行起都算正文
                in_body = True
                ref_lines.append(line)
        ref = "\n".join(ref_lines).strip()
        if not ref:
            warns.append(f"第{n}段没有正文，已跳过")
            continue
        loc = meta.get("场景") or prev_loc
        if "场景" not in meta:
            warns.append(f"第{n}段缺「场景」，沿用上一段")
        sc_raw = meta.get("换场", "")
        scene_change = sc_raw.startswith("是") or not segs
        segs.append(Segment(
            order=len(segs) + 1, script_ref=ref, location=loc,
            scene_change=scene_change,
            characters=_as_list(meta.get("人物", "")),
            props=_as_list(meta.get("道具", ""))))
        prev_loc = loc
    return segs, warns


# ---------------------------------------------------------------- 第二步：装箱

def content_seconds(seg_ref: str, names: list[str]) -> float:
    """一段内容值多少秒（纯内容，纯环境描写已封顶）。与 `_raw_duration` 同口径。"""
    return drama_timing.estimate_seconds(seg_ref, drama_timing._SPEECH_CPS, names)


def final_seconds(ref: str, names: list[str]) -> float:
    """这段内容**最终会被下发多少秒**（与落库时 `_clamp_duration` + 拆分判据同口径）。

    取三者最大：
      · 内容 + 表演余量（余量不算纯环境描写那部分）——`_clamp_duration` 的主值；
      · 台词按自然语速念完 —— `_clamp_duration` 的台词下限；
      · 全部内容按自然语速 —— `_split_overlong_drama_shots` 的"要不要拆"判据。
    装箱必须用它判"装不装得下"：只用分组口径（5 字/秒）的话，装出来的 26 秒
    镜头按自然语速是 40 秒，下一步又被拆开，等于白装。
    """
    base = content_seconds(ref, names)
    scen = drama_timing.scenery_seconds(ref, names) if names else 0.0
    withroom = base + drama_timing.performance_bump(max(0.0, base - scen))
    need = drama_timing.dialogue_floor(ref)
    natural = drama_timing.estimate_seconds(ref, drama_timing.NATURAL_CPS, names)
    return max(withroom, need, natural)


def fits(ref: str, names: list[str], cap_sec: float) -> bool:
    """这段内容最终下发的秒数是否装得进 `cap_sec`。"""
    return final_seconds(ref, names) <= cap_sec


def pack(segs: list[Segment], cap_sec: float,
         loc_related=None) -> list[dict]:
    """把段装进镜头。返回与旧拆解同形状的 shot dict 列表（供下游原样复用）。

    规则（用户裁定）：
      · 同场的段依次往里装，装到「内容 + 余量 > 上限」就封箱；
      · **只有换场才强制断开**；人物换了、动作戏开始都不断；
      · 模型标了换场、但场景名相关（`loc_related`）且人物有交集 → 视为没换场
        （沿用现有合并规则的纠偏，全库实测误标约 0.12%）；
      · 单段就超上限 → 不在这里切，交给下游 `_split_overlong_drama_shots`。
    """
    shots: list[dict] = []
    cur: dict | None = None
    for seg in segs:
        names = seg.characters
        hard_break = seg.scene_change
        if hard_break and cur is not None and loc_related is not None:
            if (set(cur["characters"]) & set(names)
                    and loc_related(cur.get("location"), seg.location)):
                hard_break = False
        if cur is not None and not hard_break:
            merged_names = cur["characters"] + [c for c in names if c not in cur["characters"]]
            merged_ref = f"{cur['script_ref']}\n{seg.script_ref}"
            if fits(merged_ref, merged_names, cap_sec):
                cur["script_ref"] = merged_ref
                cur["characters"] = merged_names
                cur["props"] = cur["props"] + [p for p in seg.props if p not in cur["props"]]
                # 合并后取**后一段**的场景名：走廊→客厅这种推入，落点才是资产该锚的那个
                cur["location"] = seg.location or cur.get("location")
                continue
        cur = {
            "order": len(shots) + 1,
            "script_ref": seg.script_ref,
            "link_to_prev": "transition" if (seg.scene_change or not shots) else "continuous",
            "characters": list(names),
            "props": list(seg.props),
            "location": seg.location,
            "duration_sec": None,
        }
        shots.append(cur)
    for s in shots:
        s["duration_sec"] = round(final_seconds(s["script_ref"], s["characters"]), 1)
    return shots


def settle_durations(shots: list[dict], cap_sec: float, floor_sec: float) -> None:
    """落库前定稿时长：**与装箱同一把尺子**（`final_seconds`），钳到 [floor, cap]。

    ⚠️ 不能交给老的 `_clamp_duration`：它按 5 字/秒估内容再加余量，
    比装箱用的自然语速（3.1 字/秒）短一截 —— 实测同一集新流程合计 125s、
    老流程 148s，等于把 2026-09-22 治好的「台词语速过快」又带回来。
    装箱判"装得下"用的是哪个秒数，下发就得是哪个秒数。
    """
    for s in shots:
        sec = final_seconds(s["script_ref"], list(s.get("characters") or []))
        s["duration_sec"] = round(max(floor_sec, min(cap_sec, sec)), 1)
