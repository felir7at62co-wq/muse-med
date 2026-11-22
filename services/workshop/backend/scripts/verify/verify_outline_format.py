"""大纲输出形态（规约文本 ⇄ 库内 JSON）的机械验证。

跑法（容器内）：
    docker exec -w /app drama-dev-orchestrator python scripts/verify/verify_outline_format.py
    docker exec -w /app drama-dev-orchestrator python scripts/verify/verify_outline_format.py --db

判据：解析结果送进 `outline_gen._norm_chapters()` 之后，必须与"等价 JSON 送进去"
逐字段相同 —— `_norm_chapters` 及其下游 16 个门禁函数一行都不用改，
所以这一层的一致性就是整个迁移的安全边界。
"""
from __future__ import annotations

import argparse
import sys

sys.path.insert(0, "/app")

from app.stages.outline_format import (OUTPUT_SPEC, dump_bible, dump_episode,  # noqa: E402
                                       dump_outline, parse_bible, parse_outline)
from app.stages.story_bible import _normalize_bible  # noqa: E402
from app.stages.outline_gen import _norm_chapters  # noqa: E402


#: 一集的完整 JSON（旧形态）与它的规约文本写法必须等价。
JSON_EP = {
    "order": 11, "title": "她被锁在储物间",
    "synopsis": "沈栀被关进储物间，捡到妹妹扔掉的药瓶。\n她没声张，把它收了起来。",
    "beats": [
        {"at": "夜·储物间", "who": "沈栀", "action": "捡起药瓶", "turn": "她决定反击"},
        {"at": "夜·门外", "who": "林素云", "action": "吩咐锁门", "turn": "沈栀确认是继母主使"},
    ],
    "hook_out": {"type": "神秘线索", "strength": "迫切", "leads_to": "第12集她换药瓶"},
    "hook_in": {"responds_to": "承接第10集", "mode": "直接延续"},
    "must_have": ["药瓶被捡起", "0.5%排片率的刺眼数据"],
    "characters": ["沈栀", "林素云"],
    "core_push": "拿到反击证据",
    "value_shift": {"from": "无法行动", "to": "手里有东西"},
    "stakes": "药瓶被发现",
    "escalation": "信息",
    "plant": ["药瓶上留着指纹"], "payoff": ["第8集埋下的手套"],
    "forbidden": ["不谈身世"],
    "audience_knows_delta": "证据存在",
    "char_knows_delta": {"沈薇": "知道被看见"},
    "emotion_intensity": 6,
    "power": {"aggressor": "林素云", "defender": "沈栀", "focus": "谁说了算"},
    "payoff_moment": "在黑暗里笑了一下",
    "payoff_kind": "真相揭露",
    "opponent_move": "把门反锁",
    "selling_point": "3. 当众翻盘",
}

TEXT_EP = '''【第11集】她被锁在储物间

梗概：
沈栀被关进储物间，捡到妹妹扔掉的药瓶。
　　她没声张，把它收了起来。

本集戏怎么推进：拿到反击证据
爽点：在黑暗里笑了一下
爽点类型：真相揭露
对手这一集做了什么：把门反锁
兑现卖点：3. 当众翻盘
价值转变起点：无法行动
价值转变终点：手里有东西
失败代价：药瓶被发现
推进维度：信息
情绪强度：6
关键事件：
- 药瓶被捡起
- 0.5%排片率的刺眼数据
涉及角色：沈栀、林素云
观众新知道：证据存在
开场承接：承接第10集
承接方式：直接延续
结尾钩子：神秘线索
钩子强度：迫切
直接引发：第12集她换药瓶
权力关系：林素云 → 沈栀
争的是：谁说了算
伏笔：
- 埋：药瓶上留着指纹
- 收：第8集埋下的手套
本集边界：
- 不谈身世
角色新知道：
- 沈薇：知道被看见

场景节拍：
1. 夜·储物间｜沈栀｜捡起药瓶｜她决定反击
2. 夜·门外｜林素云｜吩咐锁门｜沈栀确认是继母主使
'''


BIBLE_TEXT = '''【剧名】重生换嫁

【一句话故事】
被继母与妹妹害死的沈家养女重生回订婚宴当天。

【受众】
性别：女频
年龄：25-45
观看场景：通勤
此刻想被满足的情绪：看被亏待的人当场翻盘。

【卖点】
1. 真假千金
2. 重生先知
3. 当众翻盘

【核心悬念】
- 沈栀到底是不是沈家亲生女儿

【主线三件事】
要什么：拿回身份
谁在挡：林素云握着恩情
靠什么赢：重生的记忆

【全剧前提】复仇会让她变成她恨的那个人。

【人物绑定】一纸婚约把两人绑在一起，每次解除都要付出更大的代价。

【爽点承诺】
- 第20集：妹妹被送进监狱
- 第45集：继母失去一切

【主要对手】
对手姓名：林素云
目标：守住沈太太的位置
为什么站得住：她比谁都知道位置是偷来的
手段升级路径：断资源 → 动生母 → 拿婚姻绑她

【世界】
时代：现代都市
核心场景：
- 沈家老宅——权力中心
- 城郊疗养院——真正的秘密
行得通的规则：
- 豪门联姻由长辈拍板
不出现的元素：
- 没有超自然力量

【角色】
沈栀｜女主
身份：对外：沈家养女；真实：沈家亲生女儿
标签：扮猪吃虎、话少手狠
外观：24 岁，眼神冷
性格：外人面前温顺；关起门来算无遗策
经历：12 岁被送去寄宿。
经历续写：18 岁被赶进娱乐圈。
动机：拿回身份
关系：继母——猎人与猎物
弧光：从不敢冲突到不需要承认
结局：存活

【角色】林素云｜反派
身份：对外：沈家太太
标签：德高望重
外观：48 岁
性格：从不亲自动手
经历：旧仆之女。
动机：守住位置
关系：沈栀——她调换的孩子
弧光：从体面到崩坏
结局：身败名裂

【升级阶梯】
1. 第一档：失去身份
2. 第二档：失去亲人

【硬约束】
- 死亡不可逆
'''


def _compare(a: dict, b: dict, label: str) -> int:
    bad = 0
    for k in sorted(set(a) | set(b)):
        va, vb = a.get(k), b.get(k)
        if va == vb:
            continue
        if isinstance(va, str) and isinstance(vb, str) and va.strip() == vb.strip():
            continue
        print(f"  ❌ {label} 字段 {k}:\n     JSON: {va!r}\n    文本: {vb!r}")
        bad += 1
    return bad


def run_cases() -> int:
    failures = 0

    # 1) 文本与 JSON 等价（`_norm_chapters` 之后逐字段）
    a = _norm_chapters([JSON_EP], 11)[0]
    b = _norm_chapters(parse_outline(TEXT_EP, start=11)["chapters"], 11)[0]
    n = _compare(a, b, "等价")
    if n == 0:
        print(f"✅ 文本与 JSON 等价（{len(set(a) | set(b))} 个字段）")
    else:
        failures += 1

    # 2) 往返稳定：dump 之后再 parse 必须逐元素相同
    txt = dump_episode(a)
    back = _norm_chapters(parse_outline(txt, start=11)["chapters"], 11)[0]
    n = _compare(a, back, "往返")
    if n == 0:
        print("✅ 往返稳定（dump → parse → 逐字段相同）")
    else:
        failures += 1

    # 3) 集号以批次为准：模型从 1 重编也要改回 start
    shifted = TEXT_EP.replace("【第11集】", "【第1集】")
    got = parse_outline(shifted, start=41)["chapters"][0]["order"]
    if got == 41:
        print("✅ 集号以批次为准（模型写第1集 → 按批次改成第41集）")
    else:
        print(f"❌ 集号没被纠正，得到第{got}集")
        failures += 1

    # 4) 世界块：核心场景多条要拼回一个字符串（旧结构是字符串）
    w = parse_outline("【世界】\n时代：现代\na核心场景：".replace("a核心", "核心") +
                      "\n- 甲——属于谁\n- 乙——代表什么\n\n【第1集】x\n梗概：y", start=1)["world"]
    if isinstance(w.get("setting"), str) and "甲" in w["setting"] and "乙" in w["setting"]:
        print("✅ 世界块：核心场景多条拼回字符串")
    else:
        print(f"❌ 世界块核心场景形状不对: {w.get('setting')!r}")
        failures += 1

    # 5) 模型写成一行的价值转变也要能拆
    one = parse_outline('【第1集】x\n梗概：y\n价值转变：从"甲，"变成"乙"', start=1)["chapters"][0]
    if one["value_shift"] == {"from": "甲", "to": "乙"}:
        print("✅ 一行写法的价值转变能拆开且去掉多余逗号")
    else:
        print(f"❌ 一行价值转变解析不对: {one['value_shift']}")
        failures += 1

    # 6) 列表项自己含顿号时不能被拆开
    lst = parse_outline("【第1集】x\n梗概：y\n关键事件：\n- 舆论爆发，旧照被曝光", start=1)["chapters"][0]
    if lst.get("must_have") == ["舆论爆发，旧照被曝光"]:
        print("✅ 列表项含顿号不被拆开")
    else:
        print(f"❌ 列表项被拆开了: {lst.get('must_have')}")
        failures += 1

    # 7) 故事圣经：解析 → 规范化 → dump → 再解析，必须完全一致
    bible = _normalize_bible(parse_bible(BIBLE_TEXT))
    b2 = _normalize_bible(parse_bible(dump_bible(bible)))
    bd = [k for k in bible if bible[k] != b2.get(k)]
    if not bd:
        print("✅ 故事圣经往返一致")
    else:
        print(f"❌ 故事圣经往返不一致的字段: {bd}")
        for k in bd[:3]:
            print(f"     {k}:\n       原 {bible[k]!r}\n       回 {b2.get(k)!r}")
        failures += 1

    # 8) 故事圣经：`【角色】` 块头与角色名分两行也要认
    if [c["name"] for c in bible["characters"]] == ["沈栀", "林素云"]:
        print("✅ 故事圣经：角色块头与姓名分两行也能识别")
    else:
        print(f"❌ 角色块识别不对: {[c['name'] for c in bible['characters']]}")
        failures += 1

    # 9) 输出规约不含花括号（会被 format 当占位符）
    if "{" in OUTPUT_SPEC or "}" in OUTPUT_SPEC:
        print("❌ OUTPUT_SPEC 含花括号")
        failures += 1
    else:
        print("✅ OUTPUT_SPEC 无花括号")

    return failures


def run_db() -> int:
    import asyncio
    import json
    import re

    from sqlalchemy import text

    from app.db.session import session_scope

    async def _fetch():
        async with session_scope() as s:
            return (await s.execute(text(
                "SELECT id, outline FROM script_drafts WHERE outline IS NOT NULL"))).fetchall()

    rows = asyncio.run(_fetch())

    def _norm_ws(x) -> str:
        t = str(x).replace("\r\n", "\n").replace("\r", "\n")
        return re.sub(r"[ \t]+$", "", t, flags=re.MULTILINE).strip()

    FIELDS = ("title", "synopsis", "beats", "must_have", "characters", "core_push",
              "value_shift", "stakes", "hook_in", "hook_out", "escalation",
              "payoff_moment", "payoff_kind", "opponent_move", "selling_point",
              "plant", "payoff", "forbidden", "audience_knows_delta",
              "char_knows_delta", "emotion_intensity", "power")

    tot = ok = skip = 0
    fails = []
    for _rid, ol in rows:
        if isinstance(ol, str):
            try:
                ol = json.loads(ol)
            except Exception:
                continue
        if not isinstance(ol, dict):
            continue
        chs = ol.get("chapters") or []
        if not isinstance(chs, list) or not chs:
            skip += 1
            continue
        start = int(chs[0].get("order") or 1)
        tot += 1
        try:
            a = _norm_chapters(chs, start)
            b = _norm_chapters(parse_outline(dump_outline(chs), start=start).get("chapters") or [],
                               start)
        except Exception as e:  # noqa: BLE001
            fails.append((_rid, "EXC", repr(e)[:100]))
            continue
        if len(a) != len(b):
            fails.append((_rid, f"集数 {len(a)}→{len(b)}"))
            continue
        bad = []
        for ea, eb in zip(a, b):
            for f in FIELDS:
                va, vb = ea.get(f), eb.get(f)
                if va == vb:
                    continue
                if isinstance(va, str) and isinstance(vb, str) and _norm_ws(va) == _norm_ws(vb):
                    continue
                bad.append((ea.get("order"), f, str(va)[:40], str(vb)[:40]))
        if bad:
            fails.append((_rid, bad[:2]))
        else:
            ok += 1

    rate = (ok / tot * 100) if tot else 100.0
    print(f"\n库内大纲往返：{ok}/{tot} 完全一致（{rate:.2f}%）；无 chapters 跳过 {skip}；失败 {len(fails)}")
    for f in fails[:10]:
        print("   ", f)
    return 0 if not fails else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", action="store_true", help="额外跑全库往返")
    args = ap.parse_args()

    failures = run_cases()
    if args.db:
        failures += run_db()

    print("\n结果:", "通过" if failures == 0 else f"失败 {failures} 项")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
