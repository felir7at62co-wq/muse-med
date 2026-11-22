"""第二阶段：长链路自主改编。python agent_eval_long.py <输出json> <模型,...>"""
import asyncio, copy, json, re, sys, time
from sqlalchemy import select
from app.db import session_scope, ScriptDraft, ScriptStoryboard
from app.db.models import AgentJob
from app.agent_engine.models import AgentRun, AgentRunEvent
sys.path.insert(0, "/tmp")
from agent_eval import user, run_task, UID

SRC = 719
TASK = open("/tmp/long_task.txt").read()
ANACHRO = ["手机", "微信", "DNA", "监控录像", "监控视频", "电脑", "互联网", "短信", "高铁", "支付宝", "摄像头", "笔记本电脑", "U盘", "导航"]

async def clone_src(model):
    async with session_scope() as s:
        src = await s.get(ScriptDraft, SRC)
        d = ScriptDraft(user_id=UID, title=f"长测源-{model}", user_input=src.user_input, outline=copy.deepcopy(src.outline),
                        outline_locked=1, status="done", episode_count=src.episode_count, model_provider=src.model_provider,
                        chapter_word_target=src.chapter_word_target)
        s.add(d); await s.flush(); did = d.id
        for r in (await s.execute(select(ScriptStoryboard).where(ScriptStoryboard.draft_id == SRC))).scalars().all():
            s.add(ScriptStoryboard(draft_id=did, chapter_order=r.chapter_order, shots_json=copy.deepcopy(r.shots_json)))
    return did

async def judge(model, src, res):
    out = {"model": model, "src": src, "status": res["status"], "secs": res["secs"], "usage": res["usage"],
           "tool_failures": res["tool_failures"], "calls": {}}
    for c in res["calls"]: out["calls"][c] = out["calls"].get(c, 0) + 1
    async with session_scope() as s:
        jobs = (await s.execute(select(AgentJob).where(AgentJob.kind == "adapt_commit", AgentJob.draft_id == src)
                                .order_by(AgentJob.id))).scalars().all()
        new_ids = [j.result.get("new_draft_id") for j in jobs if j.status == "done" and (j.result or {}).get("new_draft_id")]
    out["adapt_jobs"] = [(j.id, j.status) for j in jobs]
    nd = new_ids[-1] if new_ids else None
    out["new_draft"] = nd
    if not nd:
        return out
    async with session_scope() as s:
        rows = (await s.execute(select(ScriptStoryboard).where(ScriptStoryboard.draft_id == nd))).scalars().all()
        d = await s.get(ScriptDraft, nd)
        outline = dict(d.outline or {})
        rj = (await s.execute(select(AgentJob).where(AgentJob.kind == "rewrite_script", AgentJob.draft_id == nd)
                              .order_by(AgentJob.id.desc()))).scalars().first()
    sbs = [r for r in rows if r.shots_json]
    text = json.dumps([r.shots_json for r in sbs], ensure_ascii=False)
    out["storyboards"] = len(sbs)
    out["chars"] = len(text)
    out["anachronism"] = {w: text.count(w) for w in ANACHRO if text.count(w)}
    out["rewrite_done"] = bool(rj and rj.status == "done")
    from app.stages.drama_gate import check_outline
    g = check_outline(outline, bible=outline.get("story_bible") or {})
    out["gate"] = g.get("summary")
    from app.check.engine import run_check
    rep = await run_check(draft_id=nd, kinds=("structure", "consistency"), deep=True)
    out["check"] = rep.get("totals")
    out["report_mentions_draft"] = str(nd) in res["text"]
    out["report_claims_rewrite"] = bool(re.search(r"精修.{0,20}(完成|done|10/10)", res["text"]))
    out["report_honest_rewrite"] = (not out["report_claims_rewrite"]) or out["rewrite_done"]
    out["read_source_eps"] = len({1 for _ in range(0)})
    async with session_scope() as s:
        evs = (await s.execute(select(AgentRunEvent).where(AgentRunEvent.run_id == res["run_id"], AgentRunEvent.type == "assistant"))).scalars().all()
    read_orders = {tc["args"].get("order") for e in evs for tc in (e.payload.get("tool_calls") or [])
                   if tc["name"] == "read_storyboard" and tc["args"].get("draft_id") == src}
    out["read_source_eps"] = len(read_orders)
    out["final_text"] = res["text"][:3000]
    return out

async def one(model):
    src = await clone_src(model)
    msg = TASK.replace("#719", f"#{src}").replace("《沈捕头最后一案》", "")
    t0 = time.time()
    res = await run_task(model, "producer", src, msg, timeout=4 * 3600)
    r = await judge(model, src, res)
    print(f"[{model}] {json.dumps({k: r.get(k) for k in ('status','secs','new_draft','storyboards','gate','check','anachronism','rewrite_done','read_source_eps','report_mentions_draft','report_honest_rewrite','usage')}, ensure_ascii=False)}", flush=True)
    return r

async def main():
    rs = await asyncio.gather(*[one(m) for m in sys.argv[2].split(",")], return_exceptions=True)
    json.dump([r if isinstance(r, dict) else {"error": repr(r)} for r in rs], open(sys.argv[1], "w"), ensure_ascii=False, indent=1, default=str)
    print("DONE", flush=True)

asyncio.run(main())
