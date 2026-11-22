"""去 AI 味 · 回归基线（plan §7）。

目的：本次开放的改动碰了 routes / chat_skills / agent 分派，**没有**碰
`polish/ai_taste.py` 和 `polish/deai_structure.py`。这个脚本的作用是把
"检测引擎行为在改动前后一致"钉成可比对的数字——如果这些数字变了，
说明有人动了规则（或规则依赖的东西），必须重新跑 docs/RESEARCH-去AI感方法论.md
里的方法论核对，而不是直接把新数字当成新基线。

跑法（WORKDIR=/app）:
    docker cp services/orchestrator/scripts/verify/verify_deai_baseline.py drama-dev-orchestrator:/app/
    docker exec -w /app drama-dev-orchestrator python verify_deai_baseline.py
"""
from app.polish.ai_taste import detect_ai_taste
from app.polish.deai_structure import diagnose_structure

HUMAN = """1-1 日 内 老宅

陈默推门进来，脚上的泥蹭了一地。

"你还知道回来？"母亲没回头，手里的菜刀剁得比刚才快。

"路上堵。"

"堵你个头。"她把刀往案板上一按，"你爸住院三天了，你堵了三天。"

陈默没接话，站在门口。屋里电视开着，声音很大，没人看。
"""

AI = (
    "夜幕降临，城市的霓虹灯如同无数双眼睛，静静地注视着这片繁华的土地。"
    "车流在楼下缓慢蠕动，像一条发光的河。楼里的人都回家了，只剩她一个人。\n\n"
    "林晚站在落地窗前，指尖轻轻划过冰凉的玻璃。她的内心满是复杂的情绪。"
    "她不知道的是，门外的走廊里已经站了一个人。\n\n"
    "记忆如潮水般涌来，她想起那些并肩走过的日子。那些欢笑都化作了柔软。"
    "她不知道的是，那个人已经抬手敲响了门。\n\n"
    "她想起他说过的话，家永远是最温暖的港湾。那些承诺都变成了灰烬。"
    "她不知道的是，门外的人正在慢慢放下手。\n\n"
    "她知道，命运的齿轮从这一刻起终于开始转动了。人生就是这样，有相聚就有别离。\n\n"
    "她终于明白了，有些路只能一个人走。从这一刻起，一切都将截然不同。\n\n"
    "她不知道的是，故事才刚刚开始。而她，也才刚刚懂得什么是真正的失去。\n"
)

ok = True


def chk(name, cond, extra=""):
    global ok
    if not cond:
        ok = False
    print(("  [PASS] " if cond else "  [FAIL] ") + name + (f"  -> {extra}" if extra else ""))


print("== 人写对话（应判为干净） ==")
h = detect_ai_taste(HUMAN)
hs = diagnose_structure(HUMAN)
print(f"   score={h.score} level={h.level} per_kilo={round(h.a_per_kilo, 2)} a={h.a_count} b={h.b_count}")
chk("人写对话 score=0", h.score == 0, h.score)
chk("人写对话 level=轻度", h.level == "轻度", h.level)
chk("人写对话 每千字 A 级 = 0", round(h.a_per_kilo, 2) == 0.0, round(h.a_per_kilo, 2))
chk("人写对话 无结构层问题", not hs.issues, [i["code"] for i in hs.issues])

print("\n== AI 腔样本（应判为重灾） ==")
a = detect_ai_taste(AI)
_st = diagnose_structure(AI)
codes = [i.code for i in _st.issues]
print(f"   score={a.score} level={a.level} per_kilo={round(a.a_per_kilo, 2)} a={a.a_count} b={a.b_count}")
print(f"   struct={codes}")
chk("AI 样本判为重灾 (level=重度)", a.level == "重度", a.level)
chk("AI 样本 score 落在 90-100", 90 <= a.score <= 100, a.score)
chk("AI 样本 每千字 A 级 > 15（硬信号密度显著）", a.a_per_kilo > 15, round(a.a_per_kilo, 2))
chk("结构层命中 R2_段末升华", "R2_段末升华" in codes, codes)
chk("结构层命中 R3_相邻同构", "R3_相邻同构" in codes, codes)
chk("结构层命中 R5_收尾", "R5_收尾" in codes, codes)

print("\n== C 级豁免（不算 AI 味的东西不该被算） ==")
# 情绪直说 / 类型惯例是 C 级：引擎**刻意不动**，这是"去 AI 味"最容易被做错的地方
c_text = "她心里一阵酸楚。\n\n他冷冷地看着他。\n\n" * 12
c = detect_ai_taste(c_text)
print(f"   score={c.score} level={c.level} c_exempt={len(getattr(c, 'c_exempt', []) or [])}")
chk("情绪直说不被判成硬信号（不因'直说情绪'而重度）", c.level != "重度", (c.score, c.level))

print("\n" + "=" * 60)
print("BASELINE OK" if ok else "BASELINE CHANGED —— 先别改基线，去查是谁动了规则")
