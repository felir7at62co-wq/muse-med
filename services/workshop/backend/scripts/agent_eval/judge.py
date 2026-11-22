import asyncio, json, random, re, httpx, sys
from sqlalchemy import select
from app.db import session_scope, ScriptStoryboard
from app.models.llm import channels_for
R = json.load(open("/tmp/eval_long.json"))

def render(shots):
    out = []
    for sc in shots or []:
        out.append(f"## 场{sc.get('scene_no')} {sc.get('time_loc')}")
        for el in sc.get("elements") or []:
            out.append(f"{el.get('character')}：{el.get('content')}" if el.get("type") == "dialogue" else (el.get("content") or ""))
    return "\n".join(out)

async def ep(d, o):
    async with session_scope() as s:
        r = (await s.execute(select(ScriptStoryboard).where(ScriptStoryboard.draft_id == d, ScriptStoryboard.chapter_order == o))).scalar_one_or_none()
        return render(r.shots_json if r else None)

async def main():
    random.seed(7)
    entries = [r for r in R if r.get("new_draft")]
    random.shuffle(entries)
    labels = "ABCDEFGH"
    mapping = {labels[i]: e["model"] for i, e in enumerate(entries)}
    src1, src10 = await ep(719, 1), await ep(719, 10)
    body = [f"【原作第1集】\n{src1}\n\n【原作第10集】\n{src10}"]
    for i, e in enumerate(entries):
        body.append(f"=====【改编稿 {labels[i]}】=====\n[第1集]\n{await ep(e['new_draft'], 1)}\n\n[第10集]\n{await ep(e['new_draft'], 10)}")
    prompt = ("你是资深短剧总编审。下面是同一部原作（民国刑侦）改编到【1990年代东北工业小城、老队长与徒弟刑警】的 8 份改编稿（只给第1集和第10集）。"
              "改编要求：保留“师父退休前最后一案，凶手竟是自己徒弟”的核心悬念和师徒感情；职业、制度、证据手段、地点符合90年代东北。\n"
              "请对每份稿子按 5 个维度打 1-10 分：时代还原、核心悬念与师徒情感保留、戏剧张力与钩子、台词质感（像不像真人说话、有没有AI腔）、首尾完成度。"
              "最后给出总排名。只输出 JSON：{\"scores\":{\"A\":{\"时代\":x,\"悬念情感\":x,\"张力\":x,\"台词\":x,\"完成度\":x,\"总分\":x,\"一句话\":\"...\"},...},\"ranking\":[\"A\",...]}\n\n"
              + "\n\n".join(body))
    res = {"mapping": mapping}
    for judge, prov in (("claude-opus-5-5", "claude"), ("gpt-6.1-sol", "gpt5")):
        name, base, key = channels_for(prov, judge)[0]
        async with httpx.AsyncClient(timeout=900) as cl:
            r = await cl.post(base.rstrip("/") + "/chat/completions", headers={"Authorization": "Bearer " + key},
                              json={"model": judge, "messages": [{"role": "user", "content": prompt}], "max_tokens": 6000})
        txt = r.json()["choices"][0]["message"]["content"]
        m = re.search(r"\{.*\}", txt, re.S)
        res[judge] = json.loads(m.group(0)) if m else txt
    json.dump(res, open("/tmp/judge.json", "w"), ensure_ascii=False, indent=1)
    print("chars", len(prompt))
    for judge in ("claude-opus-5-5", "gpt-6.1-sol"):
        j = res[judge]
        print("==", judge, "排名:", [mapping[x] for x in j.get("ranking", [])])
        for k, v in sorted(j.get("scores", {}).items(), key=lambda kv: -float(kv[1].get("总分", 0))):
            print(f"  {mapping[k]:20s} 总{v.get('总分')} 时代{v.get('时代')} 悬念{v.get('悬念情感')} 张力{v.get('张力')} 台词{v.get('台词')} 完成{v.get('完成度')} | {v.get('一句话','')[:60]}")
asyncio.run(main())
