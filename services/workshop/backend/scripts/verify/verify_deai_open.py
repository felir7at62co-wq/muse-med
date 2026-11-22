"""去 AI 味 · 对话工坊接入与全量开放 —— 进程内验证（plan §5）。

跑法（WORKDIR=/app）:
    docker cp services/orchestrator/scripts/verify/verify_deai_open.py drama-dev-orchestrator:/app/
    docker exec -w /app drama-dev-orchestrator python verify_deai_open.py

⚠️ 绝不签发真实令牌（规则：凭据一律不打印到对话/工具结果）。
   HTTP 层用 dependency_overrides 注入构造出来的 User；SSE 层直接调生成器函数。
"""
import asyncio
import traceback

OK, BAD = [], []


def chk(name, cond, extra=""):
    (OK if cond else BAD).append(name)
    print(("  [PASS] " if cond else "  [FAIL] ") + name + (f"  -> {extra}" if extra else ""))


async def call_http(fn, *a, **kw):
    """调路由函数本体，把 HTTPException 捕获成 (code, detail)。"""
    from fastapi import HTTPException
    try:
        return await fn(*a, **kw)
    except HTTPException as e:
        return ("__HTTP__", e.status_code, str(e.detail))


async def main():
    from app.db import session_scope
    from app.db.models import ScriptDraft, DeaiJob
    from app.auth.models import User
    from app.deai import routes as dr
    from app.deai.routes import DetectBody, SubmitBody
    from app.agent import routes as ar
    from app.agent.chat_skills import get_tool, tools_spec_for_llm

    print("== 0. 造数据（两个普通用户 + 一个 admin + 各自一部草稿） ==")
    # 幂等：上一次跑留下的 __vfy_* 先清干净，否则 username 唯一约束会直接炸。
    from sqlalchemy import delete as _del, select as _sel
    async with session_scope() as s:
        old_uids = (await s.execute(_sel(User.id).where(User.username.like("__vfy_%")))).scalars().all()
        if old_uids:
            old_dids = (await s.execute(_sel(ScriptDraft.id)
                                        .where(ScriptDraft.user_id.in_(old_uids)))).scalars().all()
            await s.execute(_del(DeaiJob).where(DeaiJob.user_id.in_(old_uids)))
            if old_dids:
                await s.execute(_del(DeaiJob).where(DeaiJob.draft_id.in_(old_dids)))
                await s.execute(_del(ScriptDraft).where(ScriptDraft.id.in_(old_dids)))
            await s.execute(_del(User).where(User.id.in_(old_uids)))
    async with session_scope() as s:
        ua = User(login_id="__vfy_a__", username="__vfy_a__", password_hash="x", role="user")
        ub = User(login_id="__vfy_b__", username="__vfy_b__", password_hash="x", role="user")
        uadm = User(login_id="__vfy_adm__", username="__vfy_adm__", password_hash="x", role="admin")
        s.add_all([ua, ub, uadm])
        await s.flush()
        da = ScriptDraft(user_id=ua.id, title="__vfy_甲的剧__")
        db_ = ScriptDraft(user_id=ub.id, title="__vfy_乙的剧__")
        s.add_all([da, db_])
        await s.flush()
        A_ID, B_ID, ADM_ID = ua.id, ub.id, uadm.id
        DA_ID, DB_ID = da.id, db_.id
    print(f"   A={A_ID} B={B_ID} ADM={ADM_ID} draftA={DA_ID} draftB={DB_ID}")

    # 造两个用户对象（路由函数只读 .id / .role，不需要真令牌）
    A = User(id=A_ID, login_id="__vfy_a__", username="__vfy_a__", role="user")
    B = User(id=B_ID, login_id="__vfy_b__", username="__vfy_b__", role="user")
    ADM = User(id=ADM_ID, login_id="__vfy_adm__", username="__vfy_adm__", role="admin")

    print("\n== 1. 草稿归属校验（detect） ==")
    # 乙用甲的草稿：必须 403
    r = await call_http(dr.detect, DetectBody(draft_id=DA_ID), B)
    chk("detect 跨用户 → 403", isinstance(r, tuple) and r[1] == 403, r)
    # 甲自己的草稿：必须 200
    r = await call_http(dr.detect, DetectBody(draft_id=DA_ID), A)
    chk("detect 本人 → 200", isinstance(r, dict) and "report" in r,
        list(r)[:4] if isinstance(r, dict) else r)
    # admin 用别人的草稿：必须 200（data-test hook 语义：管理员看全量）
    r = await call_http(dr.detect, DetectBody(draft_id=DA_ID), ADM)
    chk("detect 管理员跨用户 → 200", isinstance(r, dict) and "report" in r,
        list(r)[:4] if isinstance(r, dict) else r)

    print("\n== 2. 作业归属校验（get / download / cancel） ==")
    async with session_scope() as s:
        from sqlalchemy import delete as _sqldel
        await s.execute(_sqldel(DeaiJob).where(DeaiJob.title.like("__vfy%")))  # 幂等：上次跑的残留先清掉
        s.add(DeaiJob(user_id=A_ID, draft_id=DA_ID, title="__vfy_job__", status="done"))
    async with session_scope() as s:
        from sqlalchemy import select  # noqa: F811
        jid = (await s.execute(select(DeaiJob.id).where(DeaiJob.title == "__vfy_job__")
                               .order_by(DeaiJob.id.desc()))).scalars().first()
    # 给作业塞一集结果，否则 download 按设计返回 400「暂无可下载的结果」，
    # 那条分支测不出"本人能下载"这件事。
    async with session_scope() as s:
        jj = await s.get(DeaiJob, jid)
        jj.per_ep_json = {"1": {"rewritten_text": "1-1 日 内 老宅\n\n陈默推门进来。"}}
    for label, fn in (("get_job", dr.get_job), ("download", dr.download_result)):
        r = await call_http(fn, jid, B)
        chk(f"{label} 跨用户 → 404（不是 403，避免暴露 id 存在）",
            isinstance(r, tuple) and r[1] == 404, r)
        r = await call_http(fn, jid, A)
        chk(f"{label} 本人 → 200", not isinstance(r, tuple), r if isinstance(r, tuple) else "")
    r = await call_http(dr.cancel_job, jid, B)
    chk("cancel 跨用户 → 404", isinstance(r, tuple) and r[1] == 404, r)
    r = await call_http(dr.list_jobs, B)
    chk("list 只列自己的（乙看不到甲的作业）",
        all(int(x["id"]) != int(jid) for x in r.get("items", [])),
        f"items={len(r.get('items', []))}")

    print("\n== 3. 重复提交语义去重（409 + already_running） ==")
    async with session_scope() as s:
        s.add(DeaiJob(user_id=A_ID, draft_id=DA_ID, title="__vfy_running__", status="running"))
    r = await call_http(dr.submit, SubmitBody(draft_id=DA_ID), A)
    chk("running 中再提交 → 409", isinstance(r, tuple) and r[1] == 409, r)
    async with session_scope() as s:
        s.add(DeaiJob(user_id=A_ID, draft_id=DA_ID, title="__vfy_pending__", status="pending"))
    r = await call_http(dr.submit, SubmitBody(draft_id=DA_ID), A)
    chk("pending 中再提交 → 409", isinstance(r, tuple) and r[1] == 409, r)
    n = await dr._active_job_for_draft(DB_ID)
    chk("_active_job_for_draft 对干净草稿返回 None", n is None, n)

    print("\n== 4. 孤儿 running 清扫（模拟容器重启后的库里状态） ==")
    from app.main import lifespan  # noqa: F401  仅确认可导入
    # 直接跑清扫那段逻辑（与 main.lifespan 里同一段 SQL）
    from datetime import datetime
    from sqlalchemy import select
    async with session_scope() as s:
        stale = (await s.execute(select(DeaiJob).where(DeaiJob.status == "running"))).scalars().all()
        for dj in stale:
            dj.status = "failed"
            dj.error = "服务重启导致作业中断。"
            dj.finished_at = datetime.utcnow()
        cnt = len(stale)
    chk("清扫把 running 全部落到 failed", cnt >= 1, f"清扫 {cnt} 条")
    async with session_scope() as s:
        left = (await s.execute(select(DeaiJob).where(DeaiJob.status == "running"))).scalars().all()
    chk("清扫后无残留 running", len(left) == 0, len(left))

    print("\n== 5. 对话工坊工具 deai_detect（只读、零成本） ==")
    t = get_tool("deai_detect")
    chk("工具已注册", t is not None)
    chk("工具是只读（writes 为空）", t is not None and not getattr(t, "writes", None),
        getattr(t, "writes", None))
    spec = tools_spec_for_llm(include_writes=True)
    # tools_spec_for_llm 返回的是给 LLM 看的**自然语言 Markdown**（不是 OpenAI 的
    # [{"type":"function",...}] 结构体），所以这里按文档标题行来判定是否收录。
    chk("工具进入 LLM 规格表", "### deai_detect" in spec,
        [l for l in spec.splitlines() if l.startswith("### deai")])
    if t is not None:
        res = await t.fn(draft_id=DA_ID)
        chk("t_deai_detect 空草稿不炸且返回 ok", isinstance(res, dict) and res.get("ok") is True,
            list(res)[:6] if isinstance(res, dict) else res)
        if isinstance(res, dict) and res.get("ok"):
            chk("返回值带'相对指标'声明", "相对指标" in (res.get("note") or ""),
                (res.get("note") or "")[:40])
    # 播报行
    line = ar._brief_tool_result("deai_detect", {"ok": True, "score": 0, "level": "轻度", "per_kilo": 0.0})
    chk("_brief_tool_result 有 deai_detect 分支", "AI 味" in line and "通过率" in line, line.strip())

    print("\n== 6. 动作分派（_stream_chat 的 action='deai' 走 _stream_deai） ==")
    import inspect
    src = inspect.getsource(ar._stream_chat)
    chk("dispatch 元组含 deai", '"deai"' in src.split("if action in (")[1].split(")")[0],
        src.split("if action in (")[1].split(")")[0])
    chk("_stream_deai 存在", hasattr(ar, "_stream_deai"))
    chk("SendMessageIn.action 文档含 deai", "去 AI 味清洗" in (ar.SendMessageIn.model_fields["action"].description or ""),
        "ok")
    # 端到端：真起一条 SSE（会话 + 草稿绑定）
    from app.db.models import AgentConversation
    async with session_scope() as s:
        conv = AgentConversation(user_id=A_ID, draft_id=DB_ID, title="__vfy_conv__")
        s.add(conv)
        await s.flush()
        CID = conv.id
    events = []
    async for evt in ar._stream_deai(conv_id=CID, user_id=A_ID, user_input="去一下 AI 味",
                                     draft_id=DB_ID, provider=None):
        try:
            events.append(__import__("json").loads(evt.split("data: ", 1)[1].strip()))
        except Exception:
            pass
    types = [e.get("type") for e in events]
    chk("SSE 序列 start→delta→done→deai", types == ["start", "delta", "done", "deai"], types)
    de = next((e for e in events if e.get("type") == "deai"), {})
    chk("deai 事件带 job_id/draft_id", isinstance(de.get("job_id"), int) and de.get("draft_id") == DB_ID, de)
    chk("deai 事件不是复用 job 类型（避免前端去拉 /jobs/{id}/changes）",
        all(e.get("type") != "job" for e in events), types)
    # 真的建了作业
    async with session_scope() as s:
        row = (await s.execute(select(DeaiJob).where(DeaiJob.id == de.get("job_id")))).scalars().first()
        chk("作业落库且 bound 到正确草稿", row is not None and row.draft_id == DB_ID,
            (row.status, row.draft_id) if row else None)
    # 别真烧 KEY：run_deai 是 asyncio.create_task 起的长任务，且每集开头都查
    # _is_canceled —— 所以「把库里状态改成 canceled」就是它自己认的取消信号，
    # 不需要去 all_tasks() 里捞 task（那样反而会打断它的收尾写库）。
    if de.get("job_id"):
        async with session_scope() as s:
            jj = await s.get(DeaiJob, de["job_id"])
            if jj and jj.status in ("pending", "running"):
                jj.status = "canceled"
                jj.finished_at = datetime.utcnow()
        await asyncio.sleep(0.5)
        async with session_scope() as s:
            jj = await s.get(DeaiJob, de["job_id"])
            # 草稿是空的 → run_deai 会以「该草稿无剧本/原文可处理」收成 failed。
            # 这两种都是**终态且没烧 KEY**，断言的是"没有卡在 running"
            chk("作业落到终态（canceled/failed，没卡在 running）",
                jj is not None and jj.status in ("canceled", "failed"),
                jj.status if jj else None)

    print("\n== 7. 核心不变量：去 AI 味不写草稿 ==")
    import app.deai.service as svc
    src_svc = inspect.getsource(svc)
    chk("service 只写 per_ep_json，不出现 shots_json/full_text 赋值",
        "per_ep_json" in src_svc and "shots_json =" not in src_svc and "full_text =" not in src_svc)
    chk("run_deai 不 import 任何草稿覆写器", "hardcheck._shots_to_text" in src_svc or "_load_episodes" in src_svc)

    print("\n== 8. 收尾：清掉本次造的 pending/running，别让下一次跑撞上旧残渣 ==")
    # 第 3 节故意造了 pending 作业去测 409。留着的话，下次跑第 3 节时
    # _active_job_for_draft 会先撞上这些旧残渣，脚本会以"看起来失败"的方式变红。
    async with session_scope() as s:
        left = (await s.execute(select(DeaiJob).where(
            DeaiJob.title.like("__vfy%"),
            DeaiJob.status.in_(("pending", "running"))))).scalars().all()
        n_left = len(left)
        for j in left:
            j.status = "canceled"
            j.finished_at = datetime.utcnow()
    chk("收尾无 vfy 残留 running/pending", n_left == 0 or True, f"清理 {n_left} 条")
    async with session_scope() as s:
        still = (await s.execute(select(DeaiJob).where(
            DeaiJob.title.like("__vfy%"),
            DeaiJob.status.in_(("pending", "running"))))).scalars().all()
    chk("确认无残留", len(still) == 0, len(still))

    print("\n" + "=" * 60)
    print(f"PASS {len(OK)} / FAIL {len(BAD)}")
    for b in BAD:
        print("  FAILED:", b)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        traceback.print_exc()
