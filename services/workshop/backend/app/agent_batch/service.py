"""Agent 批量运营作业: worker + 动作实现。

设计:
- 一个 AgentBatchJob = 一批草稿 + 一条动作链(action_chain) + 参数。
- 后台协程 run_agent_batch(job_id) 逐草稿执行动作链; 单草稿链内动作**顺序**执行,
  因此天然支持"精修(长任务)完成 → 自动采纳"这种依赖。
- 草稿之间用 Semaphore 限并发(默认 2), 防 100 个草稿同时打爆 LLM。
- 每个草稿的进度写进 job.items_json, 前端/Agent 轮询即可看到。

支持的动作(action):
- "optimize_by_analysis": 读该草稿最新剧情分析 → 逐集把改进意见作为反馈重做剧本
- "critique":             发起评审精修(长任务, 内部等待完成)
- "apply_critique":       采纳上一步精修结果(覆盖回写); 仅 auto_apply=1 时自动执行
- "fill_missing_storyboards": 对比计划集数 vs 已生成剧本, 缺失的集补生成
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from ..db import session_scope, ScriptDraft, ScriptStoryboard
from ..db.models import AgentBatchJob

logger = logging.getLogger("agent_batch")

# 草稿级并发: 每个草稿内部动作串行, 草稿之间高并发。
# 之前=2 太保守: 50部剧做评审精修若近乎串行, 要跑近一个月。放到 50, 让几十部剧同时开跑。
# 真正的资源瓶颈在底层"生成队列"(stages 里有独立并发控制, admin 可调到几十上百),
# 这里只是"同时发起多少个草稿的流水线", 高并发只是把请求更快压到那个队列, 不会打爆。
MAX_CONCURRENCY = 500        # 草稿级并发(高额上限; 每个草稿内部动作仍串行)
CRITIQUE_POLL_SEC = 10        # 轮询精修进度间隔
# 单草稿精修最长等待: 之前 3600(1h) 太短——几十部剧并发精修时, 单部逐集深度改写(多模型多轮)
# 排队+执行常超 1h, 到点被误判 timeout。放到 14400(4h)。且超时也不再算 failed(见 _run_draft),
# 底层 run 会继续跑, resume 能接着等。
CRITIQUE_TIMEOUT_SEC = 14400  # 4 小时


# ---------------------------------------------------------------------------
# 作业/进度读写
# ---------------------------------------------------------------------------
async def _set_job(job_id: int, **fields):
    async with session_scope() as s:
        job = await s.get(AgentBatchJob, job_id)
        if not job:
            return
        for k, v in fields.items():
            setattr(job, k, v)
        await s.flush()


async def _patch_item(job_id: int, idx: int, **patch):
    """更新某个草稿项的进度(items_json[idx])。"""
    async with session_scope() as s:
        job = await s.get(AgentBatchJob, job_id)
        if not job:
            return
        items = list(job.items_json or [])
        if 0 <= idx < len(items):
            it = dict(items[idx])
            it.update(patch)
            items[idx] = it
            job.items_json = items
            from sqlalchemy.orm.attributes import flag_modified
            flag_modified(job, "items_json")
            await s.flush()


async def _bump(job_id: int, *, finished=False, failed=False):
    async with session_scope() as s:
        job = await s.get(AgentBatchJob, job_id)
        if not job:
            return
        if finished:
            job.finished = (job.finished or 0) + 1
        if failed:
            job.failed = (job.failed or 0) + 1
        await s.flush()


# ---------------------------------------------------------------------------
# 单个动作实现
# ---------------------------------------------------------------------------
async def _act_reanalyze(draft_id: int, user_id: int, params: dict) -> str:
    """批量重跑'剧本分析'。轮询等真正完成再返回(不做并发限制, 与其它动作一致)。"""
    import asyncio as _aio
    from ..analysis.routes import run_analysis
    from ..db.models import ScriptAnalysis
    try:
        async with session_scope() as s:
            running = (await s.execute(
                select(ScriptAnalysis).where(
                    ScriptAnalysis.draft_id == draft_id,
                    ScriptAnalysis.status.in_(["pending", "running"]),
                )
            )).scalars().first()
            if running:
                analysis_id = running.id
                spawned = False
            else:
                new_row = ScriptAnalysis(
                    draft_id=draft_id, scope="report_only", status="pending",  # ⭐只跑诊断报告(step5)
                    progress_step="queued", progress_current=0, progress_total=0,
                )
                s.add(new_row)
                await s.flush()
                analysis_id = new_row.id
                spawned = True
        if spawned:
            _aio.create_task(run_analysis(draft_id, analysis_id))
        # 轮询等真正跑完(不是 spawn 后就返回, 否则批量作业会秒标 done)
        waited = 0
        POLL, TIMEOUT = 15, 3600
        while waited < TIMEOUT:
            await _aio.sleep(POLL)
            waited += POLL
            async with session_scope() as s:
                row = await s.get(ScriptAnalysis, analysis_id)
                st = row.status if row else "gone"
            if st in ("done", "failed", "error"):
                if st == "done":
                    return "已重新生成剧本分析(剧情分析报告已刷新)"
                return f"剧本分析未成功(状态={st})"
        return "剧本分析仍在后台运行(超出等待窗口, 稍后可再查)"
    except Exception as e:  # noqa: BLE001
        logger.warning("reanalyze draft %d failed: %s", draft_id, e)
        return f"重跑剧本分析失败: {str(e)[:120]}"


async def _act_optimize_by_analysis(draft_id: int, user_id: int, params: dict) -> str:
    """按【总编诊断报告 report_md】优化剧本。

    方案: 吃 step5 的 report_md 全文, 用一次 LLM 把报告解析成:
      - global_constraints: 全剧必须遵守的一致性硬约束(跨集硬伤, 如"父亲死因全剧统一为X"
        "反派状态不得反复横跳")—— 这些**逐集重做时必须都遵守**, 否则单集改写会各改各的、
        反而制造新矛盾(这正是打磨越打越差的根因)。
      - per_episode: {集号: 该集具体改法}
    再逐集重做, 每集反馈 = 全局硬约束 + 本集改法, 让每一集都在同一套全局约束下改写。
    """
    import json as _json
    from ..db.models import ScriptAnalysis
    from ..models.llm import get_llm

    # ① 取最新一份成功分析的诊断报告全文
    async with session_scope() as s:
        row = (await s.execute(
            select(ScriptAnalysis)
            .where(ScriptAnalysis.draft_id == draft_id, ScriptAnalysis.status == "done")
            .order_by(ScriptAnalysis.created_at.desc())
        )).scalars().first()
        report_md = (row.report_md or "").strip() if row else ""

    if not report_md:
        return "该草稿还没有总编诊断报告, 请先重新分析(reanalyze)再优化"

    # ② 只对有剧本的集做优化
    async with session_scope() as s:
        sb_orders = sorted(set((await s.execute(
            select(ScriptStoryboard.chapter_order).where(ScriptStoryboard.draft_id == draft_id)
        )).scalars().all()))
    if not sb_orders:
        return "该草稿没有剧本(分镜)可优化, 跳过"

    # ③ 用一次 LLM 把诊断报告解析成 {global_constraints:[...], per_episode:{集号:改法}}
    parse_prompt = (
        "你是资深剧本编辑。下面是某短剧的【总编诊断报告】。请提炼成 JSON, 结构如下:\n"
        '{\n'
        '  "global_constraints": ["全剧必须统一遵守的一致性硬约束(针对跨集硬伤/连续性矛盾, '
        '如\'男主父亲死因全剧统一为空难, 不得出现其它版本\'、\'反派顾浩然被捕后不得再自由行动\'。'
        '把报告里的 P0 级/致命/逻辑崩塌类问题都转成这种\'全剧统一\'的可执行约束)"],\n'
        '  "per_episode": {"集号(整数)": "该集要做的具体改法(一句话, 可执行)"}\n'
        "}\n"
        "要求: ①把报告里所有指向逻辑硬伤/人物状态连续性/设定冲突的问题, 优先写进 global_constraints, "
        "因为这些必须全剧一致才能真正修掉; ②per_episode 只放能定位到具体集号的局部改法。"
        "只输出 JSON, 不要多余文字。\n"
        f"可优化的集号范围: {sb_orders}\n\n诊断报告:\n{report_md[:20000]}"
    )
    per_ep: dict[int, str] = {}
    global_constraints: list[str] = []
    try:
        llm = get_llm("rewrite", temperature=0.3, provider="gemini", max_tokens=4096)
        resp = await llm.ainvoke(parse_prompt)
        txt = (getattr(resp, "content", "") or "").strip()
        import re as _re2
        txt = _re2.sub(r"^```(?:json)?\s*", "", txt)
        txt = _re2.sub(r"\s*```$", "", txt)
        raw = _json.loads(txt)
        gc = raw.get("global_constraints") if isinstance(raw, dict) else None
        if isinstance(gc, list):
            global_constraints = [str(x).strip() for x in gc if str(x).strip()]
        pe = raw.get("per_episode") if isinstance(raw, dict) else raw
        for k, v in (pe or {}).items():
            try:
                o = int(k)
            except Exception:
                continue
            if o in sb_orders and str(v).strip():
                per_ep[o] = str(v).strip()
    except Exception as e:  # noqa: BLE001
        logger.warning("optimize: parse report_md failed (draft %d): %s", draft_id, e)
        return f"解析诊断报告失败: {str(e)[:120]}"

    # 若只有全局约束没有具体集号改法: 把全局约束应用到全部有剧本的集(逐集在统一约束下自查重写)
    target_orders = sorted(per_ep) if per_ep else list(sb_orders)
    if not target_orders:
        return "诊断报告里没有可执行的改法, 跳过"

    # 全局硬约束前缀(每集都带上, 保证跨集一致性硬伤被统一修复)
    global_hint = ""
    if global_constraints:
        global_hint = (
            "【全剧必须统一遵守的一致性硬约束(逐集改写时都要满足, 不得与之冲突)】:\n"
            + "\n".join(f"- {c}" for c in global_constraints)
            + "\n\n【本集具体改法】: "
        )

    # ④ 逐集把(全局约束 + 本集改法)作为反馈重做剧本
    from ..stages.router import regenerate_storyboard_with_feedback, FeedbackRegenerateIn
    done = 0
    for order in target_orders:
        ep_change = per_ep.get(order, "对照上述全局硬约束自查本集, 修正任何与之冲突的情节/人物状态。")
        feedback = (global_hint + ep_change) if global_hint else ep_change
        try:
            await regenerate_storyboard_with_feedback(
                draft_id=draft_id, chapter_order=order,
                payload=FeedbackRegenerateIn(feedback=feedback),
            )
            done += 1
        except Exception as e:
            logger.warning("optimize draft %d ep %d failed: %s", draft_id, order, e)
    gc_note = f"(全局硬约束 {len(global_constraints)} 条)" if global_constraints else ""
    return f"按诊断报告重做了 {done} 集剧本{gc_note}"


async def _act_critique(draft_id: int, user_id: int, params: dict) -> dict:
    """发起精修并等待完成, 返回 {run_id, status}。"""
    from ..critique import service as critique_service
    # 有正文用 chapter, 否则 storyboard
    from ..db import ScriptChapter
    async with session_scope() as s:
        has_chapter = (await s.execute(
            select(ScriptChapter.id).where(ScriptChapter.draft_id == draft_id).limit(1)
        )).first() is not None
    source = params.get("source") or ("chapter" if has_chapter else "storyboard")
    intensity = params.get("intensity") or "中度"
    run_id = await critique_service.create_and_run(
        user_id=user_id, draft_id=draft_id, source=source,
        intensity=intensity, episodes=None,
        editor_model=params.get("editor_model") or "deepseek",
        focus=params.get("focus"),
    )
    # 轮询等完成
    from ..critique.models import CritiqueRun
    waited = 0
    while waited < CRITIQUE_TIMEOUT_SEC:
        await asyncio.sleep(CRITIQUE_POLL_SEC)
        waited += CRITIQUE_POLL_SEC
        async with session_scope() as s:
            run = await s.get(CritiqueRun, run_id)
            st = run.status if run else "gone"
        if st in ("succeeded", "failed", "canceled"):
            return {"run_id": run_id, "status": st}
    return {"run_id": run_id, "status": "timeout"}


async def _act_apply_critique(draft_id: int, user_id: int, run_id: int) -> str:
    """采纳精修结果(覆盖回写)。"""
    from ..critique import service as critique_service
    r = await critique_service.apply_run(run_id=run_id, user_id=user_id, episode_orders=None)
    return f"已采纳精修 run#{run_id}: {r}"


async def _act_fill_missing_storyboards(draft_id: int, user_id: int, params: dict) -> str:
    """对比计划集数(大纲) vs 已生成剧本, 补齐缺失的集。"""
    from ..stages.router import run_storyboard
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        outline = (draft.outline or {}) if draft else {}
        planned = [int(c.get("order", i + 1)) for i, c in enumerate(outline.get("chapters") or [])]
        have = set((await s.execute(
            select(ScriptStoryboard.chapter_order).where(ScriptStoryboard.draft_id == draft_id)
        )).scalars().all())
    missing = [o for o in planned if o not in have]
    if not missing:
        return f"剧本完整({len(planned)}集), 无需补全"
    filled = 0
    for order in missing:
        try:
            await run_storyboard(draft_id=draft_id, chapter_order=order)
            filled += 1
        except Exception as e:
            logger.warning("fill draft %d ep %d failed: %s", draft_id, order, e)
    return f"补全了 {filled}/{len(missing)} 集缺失剧本(计划{len(planned)}集)"


# ---------------------------------------------------------------------------
# 单草稿: 顺序执行动作链
# ---------------------------------------------------------------------------
async def _run_draft(job_id: int, idx: int, draft_id: int, user_id: int,
                     action_chain: list, params: dict, auto_apply: bool, sem: asyncio.Semaphore):
    async with sem:
        await _patch_item(job_id, idx, status="running", step="开始")
        last_run_id = None
        try:
            for action in action_chain:
                # 取消检查点: 用户点了取消/暂停 → job.status 变 canceled, 这里感知到即停手
                async with session_scope() as _s:
                    _job = await _s.get(AgentBatchJob, job_id)
                    if _job and _job.status == "canceled":
                        await _patch_item(job_id, idx, status="canceled", step="已取消")
                        return
                if action == "reanalyze":
                    await _patch_item(job_id, idx, step="重跑剧本分析")
                    detail = await _act_reanalyze(draft_id, user_id, params)
                elif action == "optimize_by_analysis":
                    await _patch_item(job_id, idx, step="按分析优化剧本")
                    detail = await _act_optimize_by_analysis(draft_id, user_id, params)
                elif action == "critique":
                    await _patch_item(job_id, idx, step="评审精修中")
                    r = await _act_critique(draft_id, user_id, params)
                    last_run_id = r.get("run_id")
                    st = r.get("status")
                    if st == "timeout":
                        # ⚠️ 超时≠失败: 底层 critique run 往往还在 running/pending, 只是 agent_batch
                        # 等待窗口到了。绝不能记 failed(会误报 + 让用户以为坏了)。标记为"进行中",
                        # item 保持未完成状态, 下次「继续」会 resume 重新轮询, 等它真正跑完。
                        await _patch_item(job_id, idx, status="running", step="精修仍在后台运行",
                                          detail=f"精修 run#{last_run_id} 仍在进行(未超时失败), 点「继续」可等它完成",
                                          pending_run_id=last_run_id)
                        return  # 不 bump finished 也不 bump failed, 留给 resume 补跑
                    if st != "succeeded":
                        await _patch_item(job_id, idx, status="failed",
                                          step="精修未成功", detail=f"精修状态={st}")
                        await _bump(job_id, failed=True)
                        return
                    detail = f"精修完成 run#{last_run_id}"
                elif action == "apply_critique":
                    if not auto_apply:
                        detail = f"精修完成(run#{last_run_id}), 未开全自动模式, 待手动采纳"
                        await _patch_item(job_id, idx, step="待采纳", pending_run_id=last_run_id)
                    elif last_run_id:
                        await _patch_item(job_id, idx, step="采纳精修结果")
                        detail = await _act_apply_critique(draft_id, user_id, last_run_id)
                    else:
                        detail = "无可采纳的精修结果"
                elif action == "fill_missing_storyboards":
                    await _patch_item(job_id, idx, step="补全缺失剧本")
                    detail = await _act_fill_missing_storyboards(draft_id, user_id, params)
                else:
                    detail = f"未知动作 {action}, 跳过"
                await _patch_item(job_id, idx, detail=detail)
            await _patch_item(job_id, idx, status="done", step="完成")
            await _bump(job_id, finished=True)
        except Exception as e:
            logger.exception("agent_batch draft %d failed: %s", draft_id, e)
            await _patch_item(job_id, idx, status="failed", step="异常", detail=str(e)[:200])
            await _bump(job_id, failed=True)


# ---------------------------------------------------------------------------
# 作业主协程
# ---------------------------------------------------------------------------
async def run_agent_batch(job_id: int, *, resume: bool = False):
    """批次主协程。resume=True(继续/断点续跑)时跳过 status=='done' 的 item, 只补跑未完成的。

    进程重启会打断内存协程, 此时 DB 里 job 停在 running/partial_failed, 部分 item 卡在假 running。
    用继续即可从断点补齐(已完成的不重复处理)。
    """
    async with session_scope() as s:
        job = await s.get(AgentBatchJob, job_id)
        if not job:
            return
        job.status = "running"
        if not job.started_at:
            job.started_at = datetime.now(timezone.utc)
        job.finished_at = None
        items = list(job.items_json or [])
        action_chain = list(job.action_chain or [])
        params = dict(job.params_json or {})
        auto_apply = bool(job.auto_apply)
        user_id = job.user_id
        await s.flush()
    # 计费归属: 后台批量/重启恢复路径无请求上下文, 显式盖一次
    from ..factory.usage import set_usage_context
    set_usage_context(job_id=job_id, user_id=user_id, source="agent_batch")

    # resume: 只跑未完成的 idx(status != 'done'); 并对齐计数器
    if resume:
        todo_idx = [i for i, it in enumerate(items) if (it or {}).get("status") != "done"]
        done_cnt = len(items) - len(todo_idx)
        async with session_scope() as s:
            job = await s.get(AgentBatchJob, job_id)
            if job:
                job.finished = done_cnt
                job.failed = 0
                await s.flush()
        logger.info("agent_batch job %d RESUME: %d 已完成, 补跑 %d 个", job_id, done_cnt, len(todo_idx))
        if not todo_idx:
            async with session_scope() as s:
                job = await s.get(AgentBatchJob, job_id)
                if job:
                    job.status = "done"
                    job.finished_at = datetime.now(timezone.utc)
                    await s.flush()
            return
    else:
        todo_idx = list(range(len(items)))

    sem = asyncio.Semaphore(MAX_CONCURRENCY)
    tasks = [
        _run_draft(job_id, i, items[i]["draft_id"], user_id, action_chain, params, auto_apply, sem)
        for i in todo_idx
    ]
    try:
        await asyncio.gather(*tasks)
    except Exception as e:
        logger.exception("run_agent_batch gather error: %s", e)

    async with session_scope() as s:
        job = await s.get(AgentBatchJob, job_id)
        if job:
            # ⭐ 以 items 真实状态为准重算(防止 gather 提前结束/协程静默退出导致计数虚高)。
            # 之前的 bug: 只看 failed==0 就标 done, 但可能还有 pending/running 的 item 没跑完
            # (如 62/96 却报"全部完成")。现在: 统计真实的 done/failed, 只有全部 done 才算 done,
            # 有未处理完(pending/running)的一律 partial_failed, 让用户能点"继续"补跑。
            items = list(job.items_json or [])
            real_done = sum(1 for it in items if (it or {}).get("status") == "done")
            real_failed = sum(1 for it in items if (it or {}).get("status") == "failed")
            unfinished = len(items) - real_done - real_failed  # pending/running/canceled 等
            job.finished = real_done
            job.failed = real_failed
            if unfinished > 0:
                # 还有没跑完的 → 中断态, 可"继续"补跑
                job.status = "partial_failed"
            elif real_failed == 0:
                job.status = "done"
            elif real_failed >= (job.total or 0):
                job.status = "failed"
            else:
                job.status = "partial_failed"
            job.finished_at = datetime.now(timezone.utc)
            await s.flush()
            logger.info("agent_batch job %d 收尾: done=%d failed=%d unfinished=%d -> %s",
                        job_id, real_done, real_failed, unfinished, job.status)
    logger.info("agent_batch job %d finished", job_id)