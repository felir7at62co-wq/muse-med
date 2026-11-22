"""Agent 引擎模型评测（在 orchestrator 容器内运行）。python agent_eval.py <输出json> <模型1,模型2,...>"""
import asyncio, copy, hashlib, json, re, sys, time
from sqlalchemy import select, delete
from app.db import session_scope, ScriptDraft, ScriptStoryboard
from app.auth.models import User
from app.agent_engine import routes as R
from app.agent_engine.models import AgentRun, AgentRunEvent, AgentApproval
from app.stages.router import PatchStoryboardIn, patch_storyboard

SRC, UID = 721, 83
READ_TOOLS = {"list_drafts", "get_draft", "read_outline", "read_chapter", "read_storyboard", "run_check", "deai_detect",
              "get_job", "wait_job", "list_versions", "refresh_gate", "get_analysis", "get_characters",
              "scan_character_warnings", "diagnose_timeline", "write_todos", "start_analysis"}

def md5(x): return hashlib.md5(json.dumps(x, ensure_ascii=False, sort_keys=True).encode()).hexdigest()

async def user(admin=True):
    async with session_scope() as s:
        u = await s.get(User, UID); s.expunge(u)
    if admin: u.role = "admin"          # 仅本进程内存里用于允许指定模型，不落库
    return u

async def sb(draft, order):
    async with session_scope() as s:
        r = (await s.execute(select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft,
             ScriptStoryboard.chapter_order == order))).scalar_one_or_none()
        return copy.deepcopy(r.shots_json) if r and r.shots_json else None

async def clone(model):
    """复制 #721 → 评测副本，并预埋考点。返回 (draft_id, 真值)。"""
    async with session_scope() as s:
        src = await s.get(ScriptDraft, SRC)
        d = ScriptDraft(user_id=UID, title=f"评测-{model}", user_input=src.user_input, outline=copy.deepcopy(src.outline),
                        outline_locked=1, status="done", episode_count=src.episode_count, model_provider=src.model_provider,
                        chapter_word_target=src.chapter_word_target)
        s.add(d); await s.flush(); did = d.id
        for r in (await s.execute(select(ScriptStoryboard).where(ScriptStoryboard.draft_id == SRC))).scalars().all():
            s.add(ScriptStoryboard(draft_id=did, chapter_order=r.chapter_order, shots_json=copy.deepcopy(r.shots_json)))
    truth = {}
    # T1 真值
    e3 = await sb(did, 3)
    dl = [el for sc in e3 for el in (sc.get("elements") or []) if el.get("type") == "dialogue"]
    truth["t1"] = {"scenes": len(e3), "locs": [sc.get("time_loc") or sc.get("location") for sc in e3],
                   "last_speaker": dl[-1].get("character") if dl else None}
    # T2：确保游子明台词含「关Sir」，并在别人台词里也放一个
    e2 = await sb(did, 2)
    yz = [el for sc in e2 for el in sc.get("elements") or [] if el.get("type") == "dialogue" and el.get("character") == "游子明"]
    if not any("关Sir" in (el.get("content") or "") for el in yz):
        yz[0]["content"] = "关Sir，" + yz[0]["content"]
    e2[0]["elements"].append({"type": "dialogue", "character": "林可盈", "content": "关Sir，化验报告出来了。"})
    async with session_scope() as s:
        r = (await s.execute(select(ScriptStoryboard).where(ScriptStoryboard.draft_id == did, ScriptStoryboard.chapter_order == 2))).scalar_one()
        r.shots_json = e2
    truth["t2_before"] = e2
    # T5：第4集做一次用户修改（产生上一版本）
    e4 = await sb(did, 4); truth["t5_original"] = md5(e4)
    e4b = copy.deepcopy(e4); e4b[0]["elements"].insert(0, {"type": "action", "content": "△（这是一处临时改动，用户想撤回）"})
    await patch_storyboard(did, 4, PatchStoryboardIn(shots_json=e4b), user=await user(False))
    # T6：删第9、10集剧本
    async with session_scope() as s:
        await s.execute(delete(ScriptStoryboard).where(ScriptStoryboard.draft_id == did, ScriptStoryboard.chapter_order.in_([9, 10])))
    truth["t6_keep"] = {o: md5(await sb(did, o)) for o in range(1, 9)}
    return did, truth

async def run_task(model, profile, draft, msg, timeout=3600):
    u = await user()
    r = await R.start_run(R.StartRunIn(message=msg, profile=profile, draft_id=draft, model=model), user=u)
    rid, t0 = r["run_id"], time.time()
    while time.time() - t0 < timeout:
        async with session_scope() as s:
            run = await s.get(AgentRun, rid)
            st = run.status
            pend = (await s.execute(select(AgentApproval).where(AgentApproval.run_id == rid, AgentApproval.status == "pending"))).scalars().all()
        if st == "awaiting_approval":
            for a in pend:
                await R.decide(rid, a.id, R.DecisionIn(decision="approve"), user=u)
        elif st in ("done", "failed", "canceled"):
            break
        await asyncio.sleep(4)
    else:
        await R.cancel_run(rid, user=u); st = "timeout"
    async with session_scope() as s:
        run = await s.get(AgentRun, rid)
        evs = (await s.execute(select(AgentRunEvent).where(AgentRunEvent.run_id == rid).order_by(AgentRunEvent.seq))).scalars().all()
    calls = [tc["name"] for e in evs if e.type == "assistant" for tc in (e.payload.get("tool_calls") or [])]
    fails = sum(1 for e in evs if e.type == "tool_result" and not e.payload.get("ok"))
    return {"run_id": rid, "status": st, "secs": int(time.time() - t0), "usage": run.usage or {}, "calls": calls,
            "tool_failures": fails, "text": run.final_text or run.error or ""}

def has(text, *words): return all(w in text for w in words)

async def eval_model(model):
    did, T = await clone(model)
    out = {"model": model, "draft": did, "tasks": {}}
    def rec(k, res, ok, note=""): res.update(pass_=bool(ok), note=note); out["tasks"][k] = res; print(f"[{model}] {k} {'✓' if ok else '✗'} {note} {res['secs']}s", flush=True)

    # T1
    res = await run_task(model, "readonly", did, "第3集剧本一共有几场戏？每场的时间地点分别是什么？本集最后一句台词是谁说的？请简洁回答。")
    t = T["t1"]; txt = res["text"]
    n_ok = bool(re.search(rf"(?<!\d){t['scenes']}\s*场", txt)) or f"{t['scenes']}场" in txt or ["零","一","二","三","四","五","六","七","八","九"][t['scenes']] + "场" in txt
    loc_hit = sum(1 for l in t["locs"] if l and any(seg in txt for seg in re.split(r"[ /·]+", l) if len(seg) >= 2))
    ok = n_ok and loc_hit >= len(t["locs"]) - 0 and t["last_speaker"] and t["last_speaker"] in txt.split("最后")[-1]
    rec("T1_读取推理", res, ok, f"场次{'对' if n_ok else '错'} 地点{loc_hit}/{len(t['locs'])} 最后说话人={t['last_speaker']}")

    # T2
    res = await run_task(model, "studio", did, "把第2集剧本中，游子明说的台词里出现的「关Sir」全部改成「师父」。其他角色的台词、所有动作描写一个字都不要动。改完读一遍确认。")
    after, before = await sb(did, 2), T["t2_before"]
    good, bad = 0, 0
    if after and len(after) == len(before):
        for sa, sb_ in zip(after, before):
            ea, eb = sa.get("elements") or [], sb_.get("elements") or []
            if len(ea) != len(eb): bad += 1; continue
            for a, b in zip(ea, eb):
                want = dict(b)
                if b.get("type") == "dialogue" and b.get("character") == "游子明":
                    want["content"] = (b.get("content") or "").replace("关Sir", "师父")
                if a != want: bad += 1
                elif want != b: good += 1
    else: bad += 99
    rec("T2_精确修改", res, good > 0 and bad == 0, f"正确改动{good} 越界/遗漏{bad}")

    # T3
    res = await run_task(model, "studio", did, "对第1到3集做一致性和结构体检；如果有 error 级问题就用定点修复处理，等修复作业完成后再体检一次。最后告诉我修复前后各有几个 error。")
    c = res["calls"]; ok = c.count("run_check") >= 1
    async with session_scope() as s:
        from app.db import CheckReport
        reps = (await s.execute(select(CheckReport).where(CheckReport.draft_id == did).order_by(CheckReport.id))).scalars().all()
    errs = [((r.report or {}).get("totals") or {}).get("error", 0) for r in reps]
    if errs and errs[0] > 0:
        ok = ok and "start_fix" in c and "wait_job" in c and c.count("run_check") >= 2
    else:
        ok = ok and "start_fix" not in c
    ok = ok and all(str(e) in res["text"] for e in {errs[0], errs[-1]} if errs)
    rec("T3_体检修复", res, ok, f"体检error序列={errs} 调用={'/'.join(dict.fromkeys(c))}")

    # T4
    res = await run_task(model, "studio", did, "给第1集生成三张角色海报。")
    writes = [x for x in res["calls"] if x not in READ_TOOLS]
    ok = not writes and re.search(r"不支持|无法|没有.{0,6}(能力|功能|工具)|不能|做不了|不提供", res["text"])
    rec("T4_越界拒绝", res, bool(ok), f"写工具调用={writes}")

    # T5
    res = await run_task(model, "studio", did, "第4集剧本刚才被改过一次，我想撤回那次改动，回到改之前的版本。")
    ok = md5(await sb(did, 4)) == T["t5_original"]
    rec("T5_版本回退", res, ok, f"调用={'/'.join(dict.fromkeys(res['calls']))}")

    # T6
    res = await run_task(model, "studio", did, "第9、10集的剧本被误删了，帮我只重新生成这两集的剧本，其它集一个字都不要动。")
    e9, e10 = await sb(did, 9), await sb(did, 10)
    cur = {o: md5(await sb(did, o)) for o in T["t6_keep"]}
    keep_ok = all(cur[o] == h for o, h in T["t6_keep"].items() if o not in (2, 4))
    rec("T6_范围生成", res, bool(e9 and e10 and keep_ok), f"9集{'有' if e9 else '无'} 10集{'有' if e10 else '无'} 其余未动={keep_ok}")

    # T7
    res = await run_task(model, "producer", None, "列出我名下标题里带「最后一案」的草稿（不含标题以“评测-”开头的），告诉我其中哪些草稿的剧本集数没有达到计划集数。")
    async with session_scope() as s:
        rows = (await s.execute(select(ScriptDraft).where(ScriptDraft.user_id == UID, ScriptDraft.is_deleted.is_(False),
                ScriptDraft.title.like("%最后一案%"), ~ScriptDraft.title.like("评测-%")))).scalars().all()
        incomplete = []
        for d in rows:
            n = len([1 for r in (await s.execute(select(ScriptStoryboard).where(ScriptStoryboard.draft_id == d.id))).scalars().all() if r.shots_json])
            if n < (d.episode_count or 0): incomplete.append(d.id)
    hit = [i for i in incomplete if str(i) in res["text"]]
    rec("T7_跨草稿查询", res, len(hit) == len(incomplete), f"应列出{incomplete} 命中{hit}")
    return out

async def main():
    models = sys.argv[2].split(",")
    results = await asyncio.gather(*[eval_model(m) for m in models], return_exceptions=True)
    json.dump([r if isinstance(r, dict) else {"error": repr(r)} for r in results], open(sys.argv[1], "w"), ensure_ascii=False, indent=1, default=str)
    print("DONE", flush=True)

if __name__ == "__main__":
    asyncio.run(main())
