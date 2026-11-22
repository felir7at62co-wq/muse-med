"""剧本输出形态（标准剧本格式 ⇄ 库内 JSON）的机械验证。

跑法（容器内）：
    docker exec -w /app drama-dev-orchestrator python scripts/verify/verify_script_format.py
    docker exec -w /app drama-dev-orchestrator python scripts/verify/verify_script_format.py --db

`--db` 会把库里**所有**分镜做一遍 dump→parse 往返，统计一致率。
不带 `--db` 只跑内置用例（不连库，可在 CI/本地跑）。

判定标准（为什么不是 100%）：
  库里有三种历史形态本来就渲染不出原文 ——
    · 只有人名、没有台词的空 dialogue（渲染为空行，解析时必然不回来）
    · 整集塞进一个场次、场次头与人物行都写在 action.content 里的遗留数据
    · 动作行用 `▲` 而不是 `△`（旧导入格式）
  这些是**有意的规范化**，不是内容丢失。所以 --db 的模式是：
    · 有内容的元素必须逐条回来
    · 空元素与遗留格式计入「已规范化」，单独报数，不算失败
"""
from __future__ import annotations

import argparse
import json
import sys

sys.path.insert(0, "/app")

from app.stages.script_format import OUTPUT_SPEC, dump_script, parse_script  # noqa: E402


CASES = [
    (
        "基本场次 + 门外 + 表演提示 + 字幕 + 闪回",
        """【第12集】她把药瓶放进了继母的包里

1-1  夜 · 内 · 沈家储物间
人物：沈栀、沈薇（门外）
△沈栀靠在门后，手里攥着一把生锈的钥匙。
沈薇（门外）：妈，她会不会听见了？
林素云（门外）【压低声音】：听见又怎么样。
〔字幕〕三个月前 · 沈家老宅
△沈栀闭上眼。

1-2  日 · 外 · 沈家老宅门口
人物：沈栀、傅时
〔闪回开始〕
△雨。沈栀站在门外。
傅时（内心）：她不该出现在这里。
〔闪回结束〕
△沈栀转身走了。
""",
        # 场1：2 动作 + 2 对白（字幕进 scene.subtitle，不是元素）
        # 场2：闪回开始 + 动作 + 对白 + 闪回结束 + 动作
        dict(scenes=2, elements=[4, 5]),
    ),
    (
        "开场客套与代码块围栏要被剥掉",
        """好的，以下是剧本：

```text
【第3集】测试

3-1  日 · 内 · 某处
人物：张三
△张三坐下。
张三：我来了。
```
""",
        dict(scenes=1, elements=[2]),
    ),
    (
        # 模型直接吐出的**裸行**没法判定归属（可能是上一条的续行，也可能是新的一条），
        # 现在一律收成动作行 —— 内容不丢、顺序不变，代价是元素数变多。
        # 真正要保证的是「dump 之后再 parse 必须稳定」，见下面的 ROUNDTRIP_CASES。
        "裸行一律收成动作行，内容不丢",
        """【第5集】测试

5-1  日 · 内 · 某处
人物：张三
△快速剪辑：
1. 特写：油锅冒烟。
2. 中景：路人停步。
张三：苏公子来了！
真的是苏慕白！
""",
        dict(scenes=1, elements=[5]),
    ),
    (
        "对话里带冒号、动作行带冒号都不能被误判",
        """【第6集】测试

6-1  日 · 内 · 某处
人物：张三
△张三说：我不同意。
张三：时间：下午三点。
""",
        dict(scenes=1, elements=[2]),
    ),
    (
        "方括号开头的画面文字不能当成对白",
        """【第7集】测试

7-1  日 · 内 · 某处
人物：张三
[实时倒计时 00:30:00]
△张三抬头。
""",
        dict(scenes=1, elements=[2]),
    ),
    (
        "有一个人物就叫「字幕」，不能被当成字幕行",
        """【第8集】测试

8-1  日 · 内 · 某处
人物：字幕
字幕：我是旁白，名字就叫字幕。
""",
        dict(scenes=1, elements=[1]),
    ),
]


def _meaningful(els) -> list:
    out = []
    for e in els or []:
        if not isinstance(e, dict):
            continue
        t = str(e.get("type") or "action")
        if t in ("flashback_start", "flashback_end") or str(e.get("content") or "").strip():
            out.append(e)
    return out


#: 往返用例：dump_script 之后再 parse，必须**逐元素完全稳定**。
#: 这是真正的保证 —— 模型输出经解析进库后，改稿时再 dump 给它、再解析回来，
#: 内容不能漂。裸行用例（上面那条）在 dump 之后就会被规范化，属于预期。
ROUNDTRIP_CASES = [
    (
        "改稿往返：门外 / 表演提示 / 内心 / 字幕 / 闪回",
        [
            {"scene_no": "12-1", "time_loc": "夜 · 内 · 沈家储物间",
             "characters": ["沈栀", "沈薇（门外）"], "subtitle": "三个月前 · 沈家老宅",
             "elements": [
                 {"type": "action", "content": "△沈栀靠在门后。"},
                 {"type": "dialogue", "character": "沈薇", "mode": "门外", "action": "",
                  "content": "妈，她会不会听见了？"},
                 {"type": "dialogue", "character": "林素云", "mode": "门外", "action": "压低声音",
                  "content": "听见又怎么样。"},
             ]},
            {"scene_no": "12-2", "time_loc": "日 · 外 · 沈家老宅门口",
             "characters": ["沈栀", "傅时"], "subtitle": "",
             "elements": [
                 {"type": "flashback_start"},
                 {"type": "action", "content": "△雨。沈栀站在门外。"},
                 {"type": "dialogue", "character": "傅时", "mode": "OS", "action": "",
                  "content": "她不该出现在这里。"},
                 {"type": "flashback_end"},
                 {"type": "action", "content": "△沈栀转身走了。"},
             ]},
        ],
    ),
    (
        "改稿往返：一个元素里的多段文字不能被拆开",
        [
            {"scene_no": "12-1", "time_loc": "日 · 内 · 某处",
             "characters": ["张三"], "subtitle": "",
             "elements": [
                 {"type": "action", "content": "△快速剪辑：\n1. 特写：油锅冒烟。\n2. 中景：路人停步。"},
                 {"type": "dialogue", "character": "群杂", "mode": "", "action": "",
                  "content": "苏公子来了！\n真的是苏慕白！"},
                 {"type": "action", "content": "△张三抬头说：我不同意。"},
             ]},
        ],
    ),
    (
        "改稿往返：裸场号要被补成 集号-场号",
        [
            {"scene_no": "3", "time_loc": "日 · 内 · 某处", "characters": ["张三"],
             "subtitle": "", "elements": [{"type": "action", "content": "△张三坐着。"}]},
        ],
    ),
]


def run_roundtrip() -> int:
    failures = 0
    for name, scenes in ROUNDTRIP_CASES:
        order = 12
        txt = dump_script(scenes, order=order, title="往返测试")
        back = parse_script(txt, order=order)
        if len(back) != len(scenes):
            print(f"❌ {name}: 场数 {len(scenes)} -> {len(back)}")
            failures += 1
            continue
        bad = 0
        for a, b in zip(scenes, back):
            if (a.get("elements") or []) != (b.get("elements") or []):
                bad += 1
                print(f"❌ {name}: 第 {a.get('scene_no')} 场元素不一致")
                for x, y in zip(a.get("elements") or [], b.get("elements") or []):
                    if x != y:
                        print(f"     期望 {x}")
                        print(f"     实得 {y}")
                        break
        if bad:
            failures += 1
        else:
            print(f"✅ {name}")
    return failures


def run_cases() -> int:
    failures = 0
    for name, raw, want in CASES:
        try:
            got = parse_script(raw, order=1)
        except Exception as e:  # noqa: BLE001
            print(f"❌ {name}: 解析抛异常 {e!r}")
            failures += 1
            continue
        n_scenes = len(got)
        n_els = [len(s.get("elements") or []) for s in got]
        if n_scenes == want["scenes"] and n_els == want["elements"]:
            print(f"✅ {name}: {n_scenes} 场 {n_els}")
        else:
            print(f"❌ {name}: 期望 {want['scenes']} 场 {want['elements']}，实得 {n_scenes} 场 {n_els}")
            failures += 1

    # 输出规约本身：不许含花括号（会被 format 当占位符）
    if "{" in OUTPUT_SPEC or "}" in OUTPUT_SPEC:
        print("❌ OUTPUT_SPEC 含花括号")
        failures += 1
    else:
        print("✅ OUTPUT_SPEC 无花括号")

    return failures


def run_db() -> int:
    import asyncio

    from sqlalchemy import text

    from app.db.session import session_scope

    async def _fetch():
        async with session_scope() as s:
            return (await s.execute(text(
                "SELECT id, chapter_order, shots_json FROM script_storyboards "
                "WHERE shots_json IS NOT NULL"))).fetchall()

    rows = asyncio.run(_fetch())

    tot = ok = normalized = legacy = 0
    fails = []
    for rid, order, raw in rows:
        try:
            scenes = json.loads(raw) if isinstance(raw, str) else raw
        except Exception:
            continue
        if isinstance(scenes, dict):
            scenes = scenes.get("shots")
        if not isinstance(scenes, list) or not scenes:
            continue
        # 遗留形态：整集塞进一个场次，场次头/人物行/集标题全写在 elements 里，
        # scene_no / time_loc / characters 一律是 None。这类**本来就没有场次结构**，
        # dump 时 `人物：…` 会被正确识别成场次人物（不再是元素），属于规范化。
        if all(isinstance(s, dict) and not any(
                str(s.get(k) or "").strip() for k in ("scene_no", "time_loc", "characters"))
               for s in scenes):
            legacy += 1
            continue
        want = sum(len(_meaningful(s.get("elements"))) for s in scenes if isinstance(s, dict))
        if want == 0:
            normalized += 1
            continue
        tot += 1
        try:
            back = parse_script(dump_script(scenes, order=order or 1), order=order or 1)
        except Exception as e:  # noqa: BLE001
            fails.append((rid, "EXC", repr(e)[:100]))
            continue
        got = sum(len(_meaningful(s.get("elements"))) for s in back)
        if len(back) == len(scenes) and got == want:
            ok += 1
        else:
            fails.append((rid, len(scenes), len(back), want, got))

    rate = (ok / tot * 100) if tot else 100.0
    print(f"\n库内往返：{ok}/{tot} 一致（{rate:.2f}%）")
    print(f"  已规范化：无内容元素 {normalized} 条、无场次结构的遗留记录 {legacy} 条（不计入分母）")
    for f in fails[:20]:
        print("   ", f)
    # 阈值：有内容的元素必须 100% 回来。失败即回归。
    return 0 if not fails else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", action="store_true", help="额外跑全库往返")
    args = ap.parse_args()

    failures = run_cases() + run_roundtrip()
    if args.db:
        failures += run_db()

    print("\n结果:", "通过" if failures == 0 else f"失败 {failures} 项")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
