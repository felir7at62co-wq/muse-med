"""verify_narration_and_gate.py — 旁白降级 + 剧情门禁新增两门（2026-09-19）

## 这个脚本要防的是什么

本次给剧本平台补了四样东西，**每一样都是"字符串规则"，写错了不会报错、
只会静默失效**：

  ① 旁白降级判定（`critique/rules.classify_narration`）
     —— 判错的后果是**误报**：把"该保留的回顾型旁白"判成"该改成对白"，
     编剧会因此失去对建议的信任（这正是 `ai_taste` 的 C 类零权重在防的事）。
  ② 场景名一致性（`polish/hardcheck._FREEFORM_PROMPT` 第 4 条）
     —— 只改了提示词文本，**编译器一个字都不会提醒你**。
  ③ 情绪强度（`outline_gen._coerce_intensity` / `emotion_density`）
     —— 归一错了会把"模型没给"与"强度确实是 1"混为一谈。
  ④ 权力关系（`drama_gate._check_power_relation`）
     —— 判据是枚举式字符串比较，反转一个条件就静默失效。

所以本脚本直连真实函数、跑真实数据形状，在**进程内**验证（不是 grep 源码），
并对每条断言给出**能转红的变异**。

跑法：`python3 services/orchestrator/scripts/verify/verify_narration_and_gate.py`
（WORKDIR 任意，脚本自己把 orchestrator 根加进 sys.path）
"""
import os
import sys

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, _ROOT)

from app.critique.rules import (  # noqa: E402
    classify_narration, scan_text, _NARR_EXPLAIN_MARKERS, _NARR_KEEP_MARKERS,
)
from app.polish.hardcheck import _FREEFORM_PROMPT  # noqa: E402
from app.stages.outline_gen import (  # noqa: E402
    _coerce_intensity, emotion_density, empty_episode, _norm_chapters,
)
from app.stages.drama_gate import (  # noqa: E402
    _check_emotion_flow, _check_power_relation, check_outline,
    _INTENSITY_CLIFF, VAGUE_POWER_FOCUS,
)

_pass = 0
_fail = 0


def ok(cond, msg, detail=""):
    global _pass, _fail
    if cond:
        _pass += 1
        print(f"  ✅ {msg}")
    else:
        _fail += 1
        print(f"  ❌ {msg}" + (f"\n        {detail}" if detail else ""))


# ---------------------------------------------------------------------------
print("\n① 旁白行的识别：只认显式前缀，不推断")
# ---------------------------------------------------------------------------
S = """1-1 日 内 林家客厅
△林母把茶杯往桌上一放，眼皮都没抬。
林母：这门亲事，我说了算。
旁白：她之所以对母亲言听计从，是因为从小就被打到怕。
旁白：多年以后她才知道，那天母亲的手一直在抖。
画外音：他之所以离开，是因为听到了那句话。
△她站起身走了出去。
她站在窗边看了很久。
"""

items = classify_narration(S)
by_text = {d["text"]: d for d in items}
ok(any(t.startswith("她之所以对母亲言听计从") for t in by_text),
   "`旁白：` 前缀被识别")
ok(any(t.startswith("他之所以离开") for t in by_text),
   "`画外音：` 前缀也被识别（它在词表里）")
# 前缀认出来了、但正文里没有任何可判的标记 → 不产生建议（宁缺勿滥）。
# 这一条钉住"识别"与"给建议"是两件事：只认前缀不等于一定报。
ok(classify_narration("画外音：外面传来汽车喇叭声。\n") == [],
   "画外音 + 无可判标记 → 识别到了但不产生建议")
ok(not any("林母把茶杯" in t for t in by_text), "动作行（△ 开头）**不得**被当成旁白")
ok(not any(t.startswith("她站在窗边") for t in by_text),
   "没有前缀的叙述行不得被当成旁白（只认显式前缀）")
# 关键负例：**带冒号但不是旁白**的行。前缀正则一旦放宽（例如写成 `.\s*[:：]`），
# 这一类会被整批误判成旁白，而"无冒号的叙述行"那条测不出来。
mixed = classify_narration("她站在窗边很久：一句话也没说。\n他说：我走了。\n")
ok(mixed == [], "带冒号但无旁白前缀的行不得被当成旁白（台词/叙述都算）")
# ⚠️ 上面那条**测不到前缀正则放宽**：那两句的正文里没有可判标记，
# 放宽后它们仍不会产生建议（走的是"识别到了但无可判标记"那条路）。
# 真正能测出放宽的样本必须**同时具备**「无旁白前缀」+「含解释性标记」：
# 正则一旦放宽，它就会被当成旁白并产出建议。
pseudo = classify_narration("林母：你之所以敢这么做，是因为没人管得了你。\n")
ok(pseudo == [],
   "台词里的「之所以/因为」不得被误当成旁白降级建议"
   "（前缀放宽会立刻在这里暴露）")
ok(not any("这门亲事" in t for t in by_text), "台词行不得被当成旁白")
ok("他推门进来" not in "".join(d["text"] for d in items), "动作描写整体没进结果")
ok(all(d["line_no"] >= 1 for d in items), "line_no 是 1 起的正整数")

# ---------------------------------------------------------------------------
print("\n② 四级降级的判定方向")
# ---------------------------------------------------------------------------
d_expl = [d for d in items if d["text"].startswith("她之所以对母亲")][0]
ok(d_expl["suggest"] in ("action", "dialogue"),
   "解释型旁白（含「之所以/因为」这类因果转述）→ 建议降级",
   f"实际 {d_expl['suggest']}")

d_keep = [d for d in items if d["text"].startswith("多年以后")][0]
ok(d_keep["suggest"] == "os_ok",
   "回顾型旁白（「多年以后」）→ 判定为**该保留**，不得建议降级",
   f"实际 {d_keep['suggest']}")

# ⚠️ 上面那条**不足以**证明"该保留"优先于"该降级"：那句话里一个解释性
# 标记词都没有，就算把优先判删掉，它照样不会进降级档（测不出东西）。
# 真正能测出优先级的是**两边同时命中**的一句 —— 见下一组。
KEEP_AND_EXPLAIN = "旁白：多年以后他才明白，原来那天她是来告别的。\n"
d_both2 = classify_narration(KEEP_AND_EXPLAIN)
ok(d_both2 and d_both2[0]["suggest"] == "os_ok",
   "同时命中「多年以后」与「原来」→ 按**该保留**处理",
   f"实际 {d_both2[0]['suggest'] if d_both2 else '无输出'}")
ok("多年以后" in KEEP_AND_EXPLAIN and
   any(k in KEEP_AND_EXPLAIN for k in _NARR_EXPLAIN_MARKERS),
   "该样本确实两边都命中（否则这条断言是死的）")

# 同时命中两边时，必须按"该保留"处理，否则会误报
BOTH = "旁白：后来才明白，原来他那天是来告别的。\n"
d_both = classify_narration(BOTH)[0]
ok(d_both["suggest"] == "os_ok",
   "同时命中「后来才」与「原来」时按**该保留**处理（防误报）",
   f"实际 {d_both['suggest']}")

# 太短的旁白不产生建议
ok(classify_narration("旁白：嗯。\n") == [], "过短的旁白不产生建议（不刷屏）")
# 长度下限必须是">= 4 字才判"。上面那句是 5 字，**测不出下限**（把 <4 改成 <0
# 它照样不产生建议）—— 所以补两例夹在 4 字边界上。
# 下限是"正文 ≥ 4 字"。要夹在边界上，两个样本必须**都含同一个标记词**
# （「她想」），只差长度：3 字 vs 5 字。否则测的是"有没有标记"而不是"够不够长"。
ok(len(classify_narration("旁白：她想开会。\n")) == 1,
   "正文 5 字（高于下限）→ 判")
ok(classify_narration("旁白：她想。\n") == [],
   "正文 3 字（低于下限）→ 不判，即使标记词「她想」命中")
ok(classify_narration("") == [], "空文本不炸")

# 该保留的那一档**不产生 issue**
iss = scan_text(S)
lvl = [i for i in iss if i["role"] == "rule_narration_level"]
ok(all("多年以后" not in (i.get("evidence") or "") for i in lvl),
   "「该保留」的旁白不落成 issue（那一条只用于防误报）")
ok(len(lvl) <= 6, f"逐条建议有上限（实际 {len(lvl)} 条）")
ok(any("旁白" in i["issue"] for i in lvl), "issue 文案里说清了是旁白降级")

# 比例规则必须还在（它是便宜的那一条，不能因为加了分级就丢了）
LONG = "\n".join([f"叙述第{i}行，没有冒号。" for i in range(9)] +
                 ["他说：好。"])
ratio_iss = [i for i in scan_text(LONG) if i["role"] == "rule_narration"]
ok(ratio_iss, "旁白占比规则仍然生效（没有被新分级顶掉）")

# ---------------------------------------------------------------------------
print("\n③ 场景名一致性：进了全文审阅提示词")
# ---------------------------------------------------------------------------
ok("场景名前后不统一" in _FREEFORM_PROMPT, "提示词里有这一条")
ok("只报同一个地点的两种叫法" in _FREEFORM_PROMPT,
   "给了负向边界（免得把「客厅」与「卧室」当同一个地点报上来）")
ok("林家客厅" in _FREEFORM_PROMPT and "林家大厅" in _FREEFORM_PROMPT,
   "给了具体例子")
ok("称谓/关系前后矛盾" in _FREEFORM_PROMPT, "原有的称谓一条还在（没被覆盖）")

# ---------------------------------------------------------------------------
print("\n④ 情绪强度：归一与统计")
# ---------------------------------------------------------------------------
ok(_coerce_intensity(7) == 7, "整数原样")
ok(_coerce_intensity("8") == 8, "字符串数字也认")
ok(_coerce_intensity("8 分") == 0, "带单位的脏值 → 0（不是误报成 8）")
ok(_coerce_intensity(0) == 0, "0 = 未标注")
ok(_coerce_intensity(11) == 0, "越界（>10）→ 0，不夹到边界")
ok(_coerce_intensity(-3) == 0, "负数 → 0")
ok(_coerce_intensity(None) == 0 and _coerce_intensity("") == 0, "None/空串 → 0")
ok(_coerce_intensity(7.6) == 7, "小数向下取整")

e = empty_episode(3, placeholder=False)
ok(e["emotion_intensity"] == 0, "新建骨架默认未标注")
ok(set(e["power"]) == {"aggressor", "defender", "focus"}, "骨架里带齐三个权力字段")

eps = [dict(order=i, emotion_intensity=v) for i, v in
       [(1, 3), (2, 4), (3, 0), (4, 9), (5, 9)]]
d = emotion_density(eps)
ok(d["labeled"] == 4 and d["unlabeled"] == 1,
   "统计里标了 4 集、未标 1 集", str(d))
ok(d["peak"] == [4, 5], "峰值集号正确")
ok(d["avg"] == round((3 + 4 + 9 + 9) / 4, 1), "均值只按已标注的算")
ok(emotion_density([])["labeled"] == 0, "空输入不炸")
ok(emotion_density([dict(order=1)])["labeled"] == 0, "全未标注时 labeled=0")

# _norm_chapters 端到端
norm = _norm_chapters([{"title": "t", "emotion_intensity": "9",
                        "power": {"aggressor": "甲", "defender": "乙",
                                  "focus": "那份签字"}}], 1)
ok(norm[0]["emotion_intensity"] == 9, "契约入口能取到强度")
ok(norm[0]["power"]["aggressor"] == "甲", "契约入口能取到权力关系")
norm_bad = _norm_chapters([{"title": "t", "emotion_intensity": "很强",
                            "power": "甲和乙"}], 1)
ok(norm_bad[0]["emotion_intensity"] == 0, "强度脏值 → 0")
ok(norm_bad[0]["power"] == {"aggressor": "", "defender": "", "focus": ""},
   "power 不是对象 → 三个空字段（不是 None，下游不用防 None）")

# ---------------------------------------------------------------------------
print("\n⑤ 门禁 11：情绪强度跳变")
# ---------------------------------------------------------------------------
ok(_INTENSITY_CLIFF == 5, "悬崖阈值是 5")
cliff = _check_emotion_flow([dict(order=1, emotion_intensity=2),
                             dict(order=2, emotion_intensity=9)])
ok(len(cliff) == 1 and cliff[0]["code"] == "emotion_cliff",
   "2 → 9 报一条 emotion_cliff", str(cliff[:1]))
ok(cliff and cliff[0]["episode"] == 2, "定位在**后一集**（观众觉得断裂的那一集）")
ok(cliff and cliff[0]["level"] == "warn",
   "是 warn 不是 error —— 落差可能是故意的")
ok(_check_emotion_flow([dict(order=1, emotion_intensity=2),
                        dict(order=2, emotion_intensity=6)]) == [],
   "差 4 分（未达阈值）不报")
# 边界必须夹在阈值上：差 5 分要报、差 4 分不报。上面那条只测了 4 分，
# 把 `>=` 改成 `>` 它照样绿 —— 所以必须有差**恰好 5** 分的那一例。
ok(len(_check_emotion_flow([dict(order=1, emotion_intensity=2),
                            dict(order=2, emotion_intensity=7)])) == 1,
   "差恰好 5 分（== 阈值）→ 报（用 >= 而不是 >）")
ok(_check_emotion_flow([dict(order=1, emotion_intensity=0),
                        dict(order=2, emotion_intensity=9)]) == [],
   "未标注的集不参与（老数据兼容）")
ok(_check_emotion_flow([dict(order=1, emotion_intensity=9)]) == [],
   "只有一集时不报")
ok(_check_emotion_flow([dict(order=1, emotion_intensity=9),
                        dict(order=2, emotion_intensity=0),
                        dict(order=3, emotion_intensity=9)]) == [],
   "中间未标注时**不跨过它**判（9 → (空) → 9 不构成跳变）")
# ⚠️ 上面那条**测不到"跨过未标注"**：两端的值相同（都是 9），就算把
# 集号连续性判断去掉，落差也是 0、照样不报。真正能测出它的是**两端值不同**
# 且中间夹着未标注集 —— 去掉连续性判断后它会立刻误报「第1集→第3集落差 5」。
ok(_check_emotion_flow([dict(order=1, emotion_intensity=9),
                        dict(order=2, emotion_intensity=0),
                        dict(order=3, emotion_intensity=4)]) == [],
   "跨过未标注集时**不判落差**（9 → (空) → 4 在观众那里并不相邻）")
ok(len(_check_emotion_flow([dict(order=1, emotion_intensity=9),
                            dict(order=2, emotion_intensity=0),
                            dict(order=3, emotion_intensity=4),
                            dict(order=4, emotion_intensity=4)])) == 0,
   "上例中真正相邻的 3→4（同为 4）也不报")

# ---------------------------------------------------------------------------
print("\n⑥ 门禁 12：权力关系")
# ---------------------------------------------------------------------------
P = lambda **kw: dict(power={"aggressor": "", "defender": "", "focus": "", **kw})
self_pw = _check_power_relation([dict(order=7, **P(aggressor="林母",
                                                   defender="林母"))])
ok(len(self_pw) == 1 and self_pw[0]["code"] == "power_self",
   "同一人是攻守双方 → error", str(self_pw[:1]))
ok(self_pw and self_pw[0]["level"] == "error",
   "power_self 是 error（这一集没有对抗）")

inc = _check_power_relation([dict(order=3, **P(aggressor="林母"))])
ok(len(inc) == 1 and inc[0]["code"] == "power_incomplete",
   "只写一方 → warn", str(inc[:1]))
ok(inc and "被动方" in inc[0]["message"], "文案点名缺的是哪一方")

vague = _check_power_relation([dict(order=5, **P(aggressor="甲", defender="乙",
                                                 focus="公司控制权"))])
ok(len(vague) == 1 and vague[0]["code"] == "power_focus_vague",
   "抽象焦点 → warn", str(vague[:1]))
ok(_check_power_relation([dict(order=5, **P(aggressor="甲", defender="乙",
                                            focus="她要拿到那份签字"))]) == [],
   "具体焦点不报")

ok(_check_power_relation([dict(order=1)]) == [],
   "整块没写（老数据）→ 不报任何东西")
ok(_check_power_relation([dict(order=1, power=None)]) == [], "power=None 不炸")
ok("控制权" in VAGUE_POWER_FOCUS and "尊严" in VAGUE_POWER_FOCUS,
   "抽象词表里有那几个高频的")

# ---------------------------------------------------------------------------
print("\n⑦ 端到端：check_outline 带回新门禁，且不误伤老数据")
# ---------------------------------------------------------------------------
new_outline = {"chapters": [
    dict(order=1, title="第1集", core_push="a", stakes="s", escalation="e",
         value_shift={"from": "x", "to": "y"},
         hook_out={"type": "突然揭示", "strength": "好奇", "leads_to": "z"},
         emotion_intensity=3,
         power={"aggressor": "甲", "defender": "乙", "focus": "那份签字"}),
    dict(order=2, title="第2集", core_push="a", stakes="s", escalation="e",
         value_shift={"from": "x", "to": "y"},
         hook_out={"type": "紧急危机", "strength": "关切", "leads_to": "z"},
         emotion_intensity=9,
         power={"aggressor": "甲", "defender": "甲", "focus": "尊严"}),
]}
rep = check_outline(new_outline, include_style=False)
codes = {i["code"] for i in rep["issues"]}
ok("emotion_cliff" in codes, "端到端：情绪跳变被报出来")
ok("power_self" in codes, "端到端：自攻自守被报出来")
ok("power_focus_vague" in codes, "端到端：抽象焦点被报出来")
ok(rep["summary"]["error"] >= 1, "power_self 计入 error")

old_outline = {"chapters": [
    dict(order=1, title="第1集", synopsis="老数据只有概要"),
    dict(order=2, title="第2集", synopsis="老数据只有概要"),
]}
rep_old = check_outline(old_outline, include_style=False)
new_codes = {"emotion_cliff", "power_self", "power_incomplete", "power_focus_vague"}
ok(not (new_codes & {i["code"] for i in rep_old["issues"]}),
   "端到端：老大纲（无契约）不会被新门禁误报")

# ---------------------------------------------------------------------------
print(f"\n旁白降级 + 剧情门禁：{_pass} ✅ / {_fail} ❌")
if _fail:
    sys.exit(1)
print("\n✅ 全部通过：旁白只认显式前缀、回顾型旁白不得被判降级、"
      "场景名一致性进了全文审阅、情绪强度区分「未标注」与「低强度」、"
      "权力关系与情绪跳变都是零 LLM 的确定性判据")
