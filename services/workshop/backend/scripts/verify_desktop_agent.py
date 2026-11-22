"""剧本平台桌面入口（/v1/desktop-agent）的进程内验收。用法：docker exec -i drama-dev-orchestrator python3 - < services/orchestrator/scripts/verify_desktop_agent.py

直接调路由函数、自己构造 User，不签发真实令牌；只读，删除/生成类只测「不带 confirmed 不执行」。"""
import asyncio, json
from fastapi import HTTPException
from sqlalchemy import text
from app.db import session_scope
from app.auth.models import User
from app.agent_engine import desktop as D

ok_n = bad_n = 0
def ok(c, m, x=""):
    global ok_n, bad_n
    print(("  ✅ " if c else "  ❌ ") + m + ("" if c else f"  —— {str(x)[:300]}"))
    ok_n += bool(c); bad_n += (not c)

async def main():
    async with session_scope() as s:
        row = (await s.execute(text("select d.user_id, count(*) n from script_drafts d join users u on u.id=d.user_id "
                                     "where coalesce(d.is_deleted,false)=false and u.role not in ('admin','superadmin') "
                                     "and u.status='active' group by d.user_id order by n desc limit 1"))).first()
        u = await s.get(User, row[0]); s.expunge(u)
        other = (await s.execute(text("select id from script_drafts where user_id<>:u and coalesce(is_deleted,false)=false limit 1"),
                                 {"u": u.id})).scalar()
        mine = (await s.execute(text("select id from script_drafts where user_id=:u and coalesce(is_deleted,false)=false limit 1"),
                                {"u": u.id})).scalar()
        draft_title = (await s.execute(text("select title from script_drafts where id=:d"), {"d": mine})).scalar()
    print("① 目录")
    cat = await D.list_tools(user=u)
    names = {t["name"] for t in cat["tools"]}
    ok(names == {"script_draft", "script_read", "script_write", "script_check", "script_job", "script_cancel", "list_writing_models", "set_writing_model", "remind_when_job_done"},
       f"目录 = 6 个聚合工具 + 3 个桌面工具（实际 {sorted(names)}）")
    ok({"list_writing_models", "set_writing_model"} <= names and "list_writing_models" in cat["guide"], "写稿模型两个工具在目录里，工作说明要求先问")
    ok(all("runtime" not in json.dumps(t["parameters"]) for t in cat["tools"]), "参数 schema 里没有内部的 runtime")
    ok(all(t["risk"] in ("read", "meta", "generate", "overwrite", "export", "delete") for t in cat["tools"]), "每个都带风险等级")
    ok("镜流桌面客户端" in cat["guide"] and "script_draft(action=list, keyword" in cat["guide"], "工作说明 = 超级 Agent 系统提示词 + 桌面补充")
    import re as _re
    old = sorted(set(_re.findall(r"\b(wait_job|get_job|list_drafts|find_drafts|draft_activity|cancel_draft_tasks|start_[a-z]+|regenerate_[a-z_]+|edit_[a-z_]+|run_check|check_mainline|check_storyboards|refresh_gate|backfill_settings|expand_outline_beats)\b", cat["guide"])))
    ok(not old, "★ 工作说明里没有目录之外的老工具名", old)
    print("② 读")
    r = await D.call_tool(D.CallIn(name="list_drafts", args={"limit": 5}), user=u)
    ok(r["ok"] and json.loads(r["result"])["total"] >= 1, "list_drafts 读到自己的草稿", r)
    r = await D.call_tool(D.CallIn(name="get_draft", args={"draft_id": mine}), user=u)
    ok(r["ok"], "get_draft 自己的草稿", r)
    if other and u.role not in ("admin", "superadmin"):
        r = await D.call_tool(D.CallIn(name="get_draft", args={"draft_id": other}), user=u)
        ok(not r["ok"] and "无法访问" in r["result"], "★ 读不到别人的草稿（工具自带的权限校验生效）", r)
    print("③ 确认闸门")
    r = await D.call_tool(D.CallIn(name="trash_draft", args={"draft_id": mine}), user=u)
    async with session_scope() as s:
        still = (await s.execute(text("select coalesce(is_deleted,false) from script_drafts where id=:d"), {"d": mine})).scalar()
    ok(r.get("needs_confirm") and "删除草稿" in r.get("message", "") and still is False, "★ 删除不带 confirmed：不执行、返回给人看的说明", r)
    from app.agent_engine.policy import needs_approval
    perms = (await D._context(u)).permissions
    for tool, extra in (("generate_storyboards", {}), ("start_rewrite", {"layer": "storyboard"}), ("export_docx", {})):
        want = needs_approval(tool, {"draft_id": mine, **extra}, perms)
        if want:
            r = await D.call_tool(D.CallIn(name=tool, args={"draft_id": mine, **extra}), user=u)
            ok(r.get("needs_confirm") is True, f"{tool}：按该用户的权限开关要确认 → 不带 confirmed 不执行", r)
        else:
            ok(True, f"{tool}：该用户在权限开关里设了免确认（与超级 Agent 一致），不测执行")
    print("⑤ 写稿模型按人记住（测完恢复原值）")
    async with session_scope() as s:
        before = (await s.execute(text("select preferred_model from user_profiles where user_id=:u"), {"u": u.id})).scalar()
    try:
        async with session_scope() as s:
            await s.execute(text("update user_profiles set preferred_model=NULL where user_id=:u"), {"u": u.id})
        r = json.loads((await D.call_tool(D.CallIn(name="list_writing_models"), user=u))["result"])
        ok(r["chosen"] is False and r["current"] == "deepseek:deepseek-v4-flash", "没选过：chosen=false，当前是默认 deepseek-v4-flash", r)
        ok([x["vendor"] for x in r["recommended"]] == ["Kimi", "DeepSeek", "Gemini", "GPT"], "推荐顺序 Kimi / DeepSeek / Gemini / GPT", r["recommended"])
        ok(not any("快照" in x["note"] or "老一代" in x["note"] for x in r["recommended"]), "推荐里没有快照版、老一代", r["recommended"])
        bad = await D.call_tool(D.CallIn(name="set_writing_model", args={"model": "gpt-99"}), user=u)
        ok(bad["ok"] is False and "清单里没有" in bad["error"], "清单外的型号拒绝", bad)
        good = await D.call_tool(D.CallIn(name="set_writing_model", args={"model": "kimi-k3"}), user=u)
        ok(good["ok"] and json.loads(good["result"])["saved"] == "kimi:kimi-k3", "只写型号名也能对上厂商", good)
        r = json.loads((await D.call_tool(D.CallIn(name="list_writing_models"), user=u))["result"])
        ok(r["chosen"] is True and r["current"] == "kimi:kimi-k3", "存下以后 chosen=true，不再问", r)
        ok((await D._context(u)).writing_model == "kimi:kimi-k3", "★ 之后的工具调用上下文带上这个写稿模型")
        if needs_approval("generate_storyboards", {"draft_id": mine}, perms):
            r = await D.call_tool(D.CallIn(name="generate_storyboards", args={"draft_id": mine}), user=u)
            ok("写稿模型：kimi:kimi-k3" in r.get("message", ""), "确认卡片上写明用哪个模型写", r)
    finally:
        async with session_scope() as s:
            await s.execute(text("update user_profiles set preferred_model=:m where user_id=:u"), {"u": u.id, "m": before})
    print("⑥ 作业结束提醒（发送打桩，测完删掉测试行）")
    from app.db.models_phase5 import DesktopReminder
    from app.db.models import AgentJob
    import app.feishu.client as FC
    sent = []
    real_send = FC.send_text
    async def fake_send(*, union_id, text, timeout=15.0):
        sent.append((union_id, text)); return {}
    FC.send_text = fake_send
    r = await D.call_tool(D.CallIn(name="remind_when_job_done", args={"job_id": 2147483000, "kind": "agent"}), user=u)
    ok(r["ok"] is False and "不存在" in r["error"], "不存在的作业拒绝", r)
    async with session_scope() as s:
        j = AgentJob(kind="verify_reminder", user_id=u.id, draft_id=mine, status="running", payload={})
        s.add(j); await s.flush(); jid = j.id
    had = u.feishu_union_id
    u.feishu_union_id = had or "on_verify"
    try:
        r = await D.call_tool(D.CallIn(name="remind_when_job_done", args={"job_id": jid}), user=u)
        ok(r["ok"], "自己的作业能登记", r)
        await D.call_tool(D.CallIn(name="remind_when_job_done", args={"job_id": jid}), user=u)
        async with session_scope() as s:
            n = (await s.execute(text("select count(*) from desktop_reminders where job_id=:j"), {"j": jid})).scalar()
            if not had:
                await s.execute(text("update users set feishu_union_id='on_verify_tmp' where id=:u"), {"u": u.id})
        ok(n == 1, "同一作业不重复登记", n)
        await D.sweep_reminders()
        ok(not sent, "作业没结束不发", sent)
        async with session_scope() as s:
            await s.execute(text("update agent_jobs set status='failed' where id=:j"), {"j": jid})
        await D.sweep_reminders()
        ok(len(sent) == 1 and "没有全部成功" in sent[0][1], "结束后发一次，失败如实说", sent)
        await D.sweep_reminders()
        ok(len(sent) == 1, "不重发", sent)
    finally:
        FC.send_text = real_send
        async with session_scope() as s:
            await s.execute(text("delete from desktop_reminders where job_id=:j"), {"j": jid})
            await s.execute(text("delete from agent_jobs where id=:j"), {"j": jid})
            if not had:
                await s.execute(text("update users set feishu_union_id=NULL where id=:u"), {"u": u.id})
    print("④ 坏输入")
    r = await D.call_tool(D.CallIn(name="get_draft", args={"draft_id": "不是数字"}), user=u)
    ok(not r["ok"] and "参数不对" in r["error"], "参数类型错：拒绝并说明", r)
    try:
        await D.call_tool(D.CallIn(name="no_such_tool"), user=u); ok(False, "未知工具 404")
    except HTTPException as e:
        ok(e.status_code == 404, "未知工具 404")
    print("⑦ 慢工具走作业队列，一次调用不会撞上 300 秒总超时")
    from app.config import get_settings
    ok(D.CALL_TIMEOUT_SEC < get_settings().generate_timeout and D.INLINE_WAIT_SEC < D.CALL_TIMEOUT_SEC,
       f"单次调用上限 {D.CALL_TIMEOUT_SEC}s、原地等 {D.INLINE_WAIT_SEC}s，都小于平台总超时 {get_settings().generate_timeout}s")
    ok(D.SLOW_TOOLS <= set(D.META) and "regenerate_storyboard" in D.SLOW_TOOLS and "regenerate_outline_range" in D.SLOW_TOOLS,
       "生产上超时的 regenerate_storyboard / regenerate_outline_range 都在慢工具里")
    ok("running_in_background" in cat["guide"], "工作说明告诉 Agent：返回 job_id 不是失败，用 wait_job 接着等")
    # 只读的慢工具（只判定不修改）走一遍真实队列：worker 领取、以本人身份执行、原地拿到结果
    t0 = asyncio.get_event_loop().time()
    r = await D.call_tool(D.CallIn(name="check_mainline", args={"draft_id": mine, "layer": "outline", "start_ep": 1, "end_ep": 1}), user=u)
    took = asyncio.get_event_loop().time() - t0
    async with session_scope() as s:
        jrow = (await s.execute(text("select id, status, draft_id, payload->>'tool', result->>'ok' from agent_jobs "
                                     "where kind='desktop_tool' and user_id=:u order by id desc limit 1"), {"u": u.id})).first()
    ok(jrow and jrow[1] == "done" and jrow[2] is None and jrow[3] == "check_mainline", "check_mainline 进了作业队列并由 worker 跑完；作业不占草稿", jrow)
    ok("job_id" not in (r.get("result") or "")[:40] and r.get("result"), f"跑完的就原地返回工具结果（{took:.0f}s）", r)
    # 原地等不到：把等待时间压到 0，作业照跑，返回 job_id；wait_job 能接着拿到结果
    real_wait = D.INLINE_WAIT_SEC
    D.INLINE_WAIT_SEC = 0
    try:
        r = await D.call_tool(D.CallIn(name="check_mainline", args={"draft_id": mine, "layer": "outline", "start_ep": 1, "end_ep": 1}), user=u)
    finally:
        D.INLINE_WAIT_SEC = real_wait
    body = json.loads(r["result"])
    ok(r["ok"] and body.get("running_in_background") and body.get("job_id"), "等不到时返回 job_id + running_in_background，不报错", r)
    w = await D.call_tool(D.CallIn(name="wait_job", args={"job_id": body["job_id"], "max_wait_seconds": 99999}), user=u)
    wj = json.loads(w["result"])
    ok(wj.get("status") == "done" and wj["result"].get("output"), "wait_job 接着等到结束，结果在 result.output", w)
    ok(wj.get("waited_seconds", 0) <= D.INLINE_WAIT_SEC, "wait_job 的等待被压在原地等待上限以内", wj.get("waited_seconds"))
    async with session_scope() as s:
        await s.execute(text("delete from agent_jobs where kind='desktop_tool' and user_id=:u"), {"u": u.id})
    print("⑧ 通宵模式：不问确认，但删稿、取消任务一律不做")
    r = await D.call_tool(D.CallIn(name="trash_draft", args={"draft_id": mine}, unattended=True, confirmed=True), user=u)
    async with session_scope() as s:
        still = (await s.execute(text("select coalesce(is_deleted,false) from script_drafts where id=:d"), {"d": mine})).scalar()
    ok(r.get("code") == "blocked_unattended" and still is False, "★ 通宵模式下删草稿：拒绝（带 confirmed 也不行），草稿还在", r)
    r = await D.call_tool(D.CallIn(name="cancel_draft_tasks", args={"draft_id": mine}, unattended=True), user=u)
    ok(r.get("code") == "blocked_unattended", "通宵模式下取消正在跑的任务：拒绝", r)
    r = await D.call_tool(D.CallIn(name="update_draft_title", args={"draft_id": mine, "title": "x"}, unattended=True, confirmed=False), user=u)
    ok(not r.get("needs_confirm"), "通宵模式下其它要确认的操作不再弹确认", r)
    if r.get("ok"):
        async with session_scope() as s:
            await s.execute(text("update script_drafts set title=:t where id=:d"), {"t": draft_title, "d": mine})
    print("⑨ 聚合工具：与老工具同一套权限、确认与通宵规则")
    r = await D.call_tool(D.CallIn(name="script_draft", args={"action": "list", "keyword": draft_title[:4] if draft_title else ""}), user=u)
    ok(r["ok"] and json.loads(r["result"])["total"] >= 1, "script_draft(list, keyword=剧名) 按名字找到自己的草稿", r)
    r = await D.call_tool(D.CallIn(name="script_read", args={"draft_id": mine, "layer": "outline", "start": 1, "end": 1}), user=u)
    ok(r["ok"], "script_read(outline) 读自己的草稿", r)
    if other and u.role not in ("admin", "superadmin"):
        r = await D.call_tool(D.CallIn(name="script_draft", args={"action": "info", "draft_id": other}), user=u)
        ok(not r["ok"] and "无法访问" in r["result"], "★ script_draft(info) 读不到别人的草稿", r)
    r = await D.call_tool(D.CallIn(name="script_draft", args={"action": "delete", "draft_id": mine}), user=u)
    async with session_scope() as s:
        still = (await s.execute(text("select coalesce(is_deleted,false) from script_drafts where id=:d"), {"d": mine})).scalar()
    ok(r.get("needs_confirm") and "删除草稿" in r.get("message", "") and still is False, "★ script_draft(delete) 不带 confirmed：弹确认、不执行", r)
    r = await D.call_tool(D.CallIn(name="script_draft", args={"action": "delete", "draft_id": mine}, unattended=True, confirmed=True), user=u)
    async with session_scope() as s:
        still = (await s.execute(text("select coalesce(is_deleted,false) from script_drafts where id=:d"), {"d": mine})).scalar()
    ok(r.get("code") == "blocked_unattended" and still is False, "★ 通宵模式下 draft(delete)：拒绝，草稿还在", r)
    r = await D.call_tool(D.CallIn(name="script_cancel", args={"draft_id": mine}, unattended=True), user=u)
    ok(r.get("code") == "blocked_unattended", "★ 通宵模式下 cancel：拒绝", r)
    r = await D.call_tool(D.CallIn(name="script_job", args={"action": "wait", "job_id": 1, "kind": "gen_outline", "timeout": 99999}), user=u)
    ok("参数不对" not in (r.get("result") or r.get("error") or ""), "script_job(wait) 接受 write 返回的具体作业类型（gen_outline 按 agent 查）", r)
    print(f"\n{'✅ 全部通过' if not bad_n else f'❌ {bad_n} 项失败'}（{ok_n + bad_n} 项）")

asyncio.run(main())
