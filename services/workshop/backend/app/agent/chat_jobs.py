"""对话工坊作业处理器 —— 注册到 jobs 队列的长任务。

当前包含：
  · gen_outline       生成/续写大纲（可分批，带检查点）
  · gen_chapters      批量生成正文
  · gen_storyboards   批量生成剧本（分镜）
  · adapt_products    改编为小说/推文
  · rewrite_script    整本 AI 精修（两轮同上下文重写，覆写回草稿）

这些原先都是 fire-and-forget（跑在容器内存里，重启即丢）。
现在统一走 jobs 队列：租约 + 心跳 + 崩溃重放 + 幂等。

**幂等约定**（重放必须安全）：
  · 生成类：按"每集一行、有则覆盖"，重放最多重复生成一次，不产生脏数据
  · 已完成的集跳过（靠查库判断），所以重放通常只补未完成的部分
  · 精修类：走 RewriteJob 原有的"要么整本覆写、要么整本不动"铁律。
    ⚠️ 精修**不是**幂等的（第二次是在第一次结果上再改一遍），所以重放前
    先查 rewrite_jobs 是否已有本作业跑完/正在跑，避免重复扣费与重复覆写。
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

from ..db import ScriptDraft, ScriptChapter, ScriptStoryboard, session_scope
from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from ..db.models import RewriteJob
from ..rewrite import service as rewrite_svc
from . import jobs
from .chat_modes import get_mode_generation_note

logger = logging.getLogger("chat_jobs")


def _now_naive() -> datetime:
    """与 rewrite/service.py、agent/jobs.py 同一口径：库列是 naive UTC。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


#: 同一草稿同时只允许一个"重任务"在跑（生成/精修都一样）。
#: 理由：这些都是**覆写同一批集**的作业，并发跑会互相覆盖（后完成的赢），
#: 且都是重 LLM 开销的长任务。这不是并发限制（不违反"并发数铁律"）——
#: 单草稿同时跑两个整本精修在语义上就是错的，不是"慢"的问题。
_ACTIVE_STATES = ("queued", "running", "analyzing", "rewriting", "pending")

#: RewriteJob 视为"仍在跑"的状态。与 _ACTIVE_STATES 的区别：这张表没有租约，
#: 只有 status 一个字段，所以必须**额外**用心跳判活（见 _rewrite_still_alive）。
_REWRITE_ACTIVE_STATES = ("running", "analyzing", "rewriting")


def _rewrite_still_alive(row: RewriteJob, now: datetime) -> bool:
    """这个 RewriteJob 是真在跑，还是一具尸体？

    ⚠️ 这是 2026-10-08 事故的核心修复点。原先只看 ``status ∈ {running,
    analyzing, rewriting}``，而**没有任何机制**把这些字段改成终态：一次 worker
    重启（``jobs.requeue_expired`` 只管 agent_jobs）就能让一行永远停在
    rewriting，此后该草稿上的「修硬伤」「精修这批」「生成」全被拦，
    用户看到的是"按钮用不了"，而那个任务几小时前就死了。

    判据：``heartbeat_at``（或回落到 ``created_at``）距今未超过
    ``REWRITE_STALE_SECONDS``。回落到 created_at 是为了让**没有心跳的存量行**
    也有意义 —— 否则老数据会永远被当成活的，正是要修的病。

    没有心跳的老行若创建时间也很久远 → 判死 → 会被 ``reap_stale_rewrite_jobs``
    收成 failed，用户重新点一下即可。这是对的：那个作业确实不可能还在跑了。
    """
    last = row.heartbeat_at or row.created_at
    if last is None:
        return True     # 两个时间都没有：信息不足，宁可保守（不误杀）
    if last.tzinfo is not None:
        last = last.replace(tzinfo=None)
    return (now - last).total_seconds() <= rewrite_svc.REWRITE_STALE_SECONDS


async def reap_stale_rewrite_jobs(draft_id: int | None = None) -> int:
    """把卡死的 RewriteJob 收成 failed，返回回收条数。

    ``draft_id=None`` = 全库回收（worker 定期跑）；给定草稿 = 只回收那一部
    （用户点按钮时顺手清掉挡路的尸体，不用等下一次 GC）。

    为什么收成 failed 而不是删掉：用户要看得到"上次那个作业中断了"，
    否则他会以为从没跑过，然后又点一次同样的东西。原稿按精修铁律没被碰过，
    所以这里如实说"被中断"，不谎称失败于内容问题。
    """
    now = _now_naive()
    cutoff = now - timedelta(seconds=rewrite_svc.REWRITE_STALE_SECONDS)
    async with session_scope() as s:
        stmt = select(RewriteJob).where(
            RewriteJob.status.in_(_REWRITE_ACTIVE_STATES),
            func.coalesce(RewriteJob.heartbeat_at, RewriteJob.created_at) < cutoff,
        )
        if draft_id is not None:
            stmt = stmt.where(RewriteJob.draft_id == draft_id)
        rows = (await s.execute(stmt)).scalars().all()
        for r in rows:
            logger.warning("回收僵尸精修作业 #%s（draft=%s, status=%s, 最后心跳=%s）",
                           r.id, r.draft_id, r.status,
                           r.heartbeat_at or r.created_at)
            r.status = "failed"
            r.error = rewrite_svc.REAP_ERROR
            r.finished_at = now
        return len(rows)


async def has_active_job(draft_id: int) -> str | None:
    """返回该草稿当前正在跑的重任务描述（没有则 None）。供工具层做幂等拦截。

    ⚠️ 2026-10-22 起改为直接走 ``progress_helper.draft_activity``（三套机制一起看）。
    原先这里只查 RewriteJob + AgentJob 两张表，**看不见顶栏那套进程内批量任务** ——
    于是「Agent 入队」与「用户点补全」可以同时跑同一部草稿、互相覆盖。

    ⚠️ RewriteJob 那一支的判活口径（心跳，不能只看 status）已经搬进 draft_activity，
    2026-10-08 的取消失效事故由其保留 —— 别在这里重新实现一遍。
    """
    act = await _draft_activity(draft_id)
    if act.get("busy"):
        return act.get("summary") or "另一个任务"
    return None


async def _draft_activity(draft_id: int) -> dict:
    """[已废弃的轻包装] 统一活动查询的真实实现在 `stages.progress_helper.draft_activity`。

    放在那里而不是这里，是为了让 stages/router.py（进程内批量那条路）也能用：
    progress_helper 只依赖 db，两边可无环 import；反过来让 progress_helper 依赖
    chat_jobs 会成环（chat_jobs 已经 import 了 stages 里的东西）。
    """
    from ..stages.progress_helper import draft_activity
    return await draft_activity(draft_id)


# ---------------------------------------------------------------------------
# 大纲
# ---------------------------------------------------------------------------

async def _handle_gen_outline(job: dict) -> dict:
    """生成大纲。payload: {mode: 'preview'|'expand', chapter_count, preview_episodes}"""
    from ..stages.outline_gen import generate_outline_preview, expand_outline_from_preview
    from ..stages.drama_gate import check_outline
    from sqlalchemy.orm.attributes import flag_modified

    jid = job["id"]
    draft_id = job["draft_id"]
    payload = job.get("payload") or {}

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise ValueError(f"草稿 {draft_id} 不存在")
        ui = d.user_input or ""
        # 这一轮若指定了写作模型就用它；否则沿用草稿记的（既有行为，逐字不变）。
        provider = str(payload.get("writing_model") or "") or (d.model_provider or "gemini")
        # 幂等：已有足够集数就跳过生成，直接跑检查
        existing = (d.outline or {}).get("chapters") or []
        outline_now = dict(d.outline or {})

    mode = payload.get("mode") or "preview"
    total = int(payload.get("chapter_count") or 0) or 50

    if mode == "expand" and outline_now.get("chapters"):
        await jobs.set_progress(jid, progress=10, note="正在展开大纲")
        out = await expand_outline_from_preview(
            outline_now, chapter_count=total, provider=provider,
            user_input=ui, draft_id=draft_id, run_lint=False)
    elif len(existing) >= total:
        # 幂等：已经生成够了
        await jobs.set_progress(jid, note="大纲已存在，跳过生成")
        out = outline_now
    else:
        await jobs.set_progress(jid, progress=10, note="正在生成大纲预览")
        preview = int(payload.get("preview_episodes") or 3)
        out = await generate_outline_preview(
            ui, chapter_count=total, preview_episodes=preview,
            provider=provider, draft_id=draft_id)
        if payload.get("expand_after_preview", True):
            await jobs.set_progress(jid, progress=40, note="正在展开到全部集数")
            out = await expand_outline_from_preview(
                out, chapter_count=total, provider=provider,
                user_input=ui, draft_id=draft_id, run_lint=False)

    await jobs.set_progress(jid, progress=85, note="正在做结构检查")
    try:
        out["drama_report"] = check_outline(out, bible=out.get("story_bible") or {})
    except Exception as e:  # noqa: BLE001
        logger.warning("大纲门禁失败: %s", e)

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        d.outline = out
        flag_modified(d, "outline")
        if out.get("title") and (not d.title or d.title in ("新剧", "未命名")):
            d.title = str(out["title"])[:60]
        await s.flush()

    rep = out.get("drama_report") or {}
    return {
        "episodes": len(out.get("chapters") or []),
        "title": out.get("title") or "",
        "error_count": (rep.get("summary") or {}).get("error", 0),
        "warn_count": (rep.get("summary") or {}).get("warn", 0),
    }


# ---------------------------------------------------------------------------
# 入队前的"到底有没有活可干"预检
# ---------------------------------------------------------------------------

async def pending_counts(draft_id: int, kind: str,
                         start: int = 0, end: int = 0) -> dict:
    """入队前先数一遍：这个范围里**真正还没做过**的集有几集。

    为什么要它（2026-10-08 用户甲的 dev 事故）：
    她导入 61 集原文后点「生成正文」，助手回的是
    *"已对《同事请客…》启动**生成正文**。作业号 #66"*，
    而那个作业跑完是 `generated: 0, skipped: 61`、note 写着「没有待生成的集」——
    **一集没写、一次模型调用都没发**。她 5 分钟后问"生成好了吗"，
    助手还答"后台的长任务还在快马加鞭生成中哦"。

    根因：导入的草稿**每一集都已有正文**，而 `_handle_gen_chapters` 的 todo
    只按"这集有没有正文"过滤（`e["order"] not in done`），于是待办天然为空。
    入队这条路从头到尾**没人检查过待办是不是空的** —— 入队成功、立刻空转结束，
    但返回给模型的是"已启动"，模型只能照着那个报喜。

    判据必须和 handler 里**完全一致**（正文看 full_text，剧本看 shots_json），
    否则又会出现"预检说没活、handler 说有活"的错位。所以这里与
    `_handle_gen_chapters` / `_handle_gen_storyboards` 读同一批字段。

    返回 {episodes, done, pending, pending_orders, first_pending, scope_total}
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"episodes": 0, "done": 0, "pending": 0, "pending_orders": [],
                    "first_pending": 0, "scope_total": 0}
        outline = dict(d.outline or {})
        if kind == "gen_chapters":
            done = {c.chapter_order for c in (await s.execute(
                select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
            )).scalars().all() if (c.full_text or "").strip()}
        elif kind == "gen_storyboards":
            done = {r.chapter_order for r in (await s.execute(
                select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
            )).scalars().all() if (r.shots_json or [])}
        else:
            done = set()

    eps = sorted(outline.get("chapters") or [], key=lambda e: e.get("order", 0))
    scope = [e for e in eps
             if (not start or int(e.get("order") or 0) >= start)
             and (not end or int(e.get("order") or 0) <= end)]
    # ⚠️ pending_orders 必须按集号升序 —— 调用方靠它把窗口挪到"接下来真正待做的集"。
    pending_orders = sorted(int(e.get("order") or 0) for e in scope
                            if int(e.get("order") or 0) not in done)
    return {
        "episodes": len(eps),
        "done": len([e for e in scope if int(e.get("order") or 0) in done]),
        "pending": len(pending_orders),
        "pending_orders": pending_orders,
        "first_pending": pending_orders[0] if pending_orders else 0,
        "scope_total": len(scope),
    }


# ---------------------------------------------------------------------------
# 正文
# ---------------------------------------------------------------------------

async def _handle_gen_chapters(job: dict) -> dict:
    """批量生成正文。payload: {start, end, guidance}（缺省=全部未生成的）

    guidance: 用户这次临时给的要求（"按这个风格写""别写旁白"），由发起方
    （动作栏 / Agent 工具）从用户那句话里取，逐集注入 prompt。空则行为与改前一致。
    加了它之后 guidance 也进了**幂等键的语义**：改了 guidance 就是另一遍，
    但重放（同一 payload）仍然安全 —— 每集一次覆盖写，重复跑最多重写一遍。
    """
    from ..stages.chapter_gen import generate_chapter, summarize_chapter

    jid = job["id"]
    draft_id = job["draft_id"]
    payload = job.get("payload") or {}
    guidance = str(payload.get("guidance") or "").strip()

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise ValueError(f"草稿 {draft_id} 不存在")
        outline = dict(d.outline or {})
        target = int(d.chapter_word_target or DEFAULT_CHAPTER_WORD_TARGET)
        # 这一轮若指定了写作模型就用它；否则沿用草稿记的（既有行为，逐字不变）。
        provider = str(payload.get("writing_model") or "") or (d.model_provider or "gemini")
        done = {c.chapter_order for c in (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
        )).scalars().all() if (c.full_text or "").strip()}

    eps = sorted(outline.get("chapters") or [], key=lambda e: e.get("order", 0))
    if not eps:
        raise ValueError("还没有大纲，无法生成正文")

    start = int(payload.get("start") or 0)
    end = int(payload.get("end") or 0)
    todo = [e for e in eps
            if (not start or e["order"] >= start)
            and (not end or e["order"] <= end)
            and e["order"] not in done]

    total = len(todo) or 1
    # 进度语义（用户反馈「进度始终是 0」的修复）：
    #   旧实现只在**一集写完之后**才 set_progress，于是"第一集写完"之前进度恒为 0 ——
    #   而一集的 LLM 调用要几分钟。用户看到 0% + "正在生成稍后反馈"，合理判断为卡死。
    #   现在：入场先写 5%，**每集开始前**推到本集的起点，完成后推到本集终点。
    #   进度条因此从第一秒就在动，且 note 会说清"第几集、总共几集"。
    await jobs.set_progress(jid, progress=5,
                            note=f"共 {total} 集待写，准备从第{todo[0]['order']}集开始"
                            if todo else "没有待生成的集")
    # 「生成的内容我不能及时查看」的修复：每写完一集就把**开头一段**塞进作业 result。
    # 不落库、不入聊天（避免几十万字撑爆轮询接口），但用户在对话里挂着进度条时
    # 能一路看到"第一集开头长这样"，不必等整本跑完再回草稿页翻。
    # 为什么是开头 240 字：够判断文风和口径对不对，又不至于把 /jobs/{id} 撑大。
    previews: list[dict] = []
    for i, ep in enumerate(todo, start=1):
        order = ep["order"]
        await jobs.set_progress(
            jid, progress=int(95 * (i - 1) / total) + 5,
            note=f"正在写第{order}集（第 {i}/{total} 集）"
                 + ("（已套用你的要求）" if guidance else ""))
        # 幂等 + 断点重放：已完成的集天然不在 todo 里
        async with session_scope() as s:
            # 取足够多的前章 —— 预算由 chapter_gen._prev_budget_chars() 按模型
            # 窗口控制（70 万口径下约 21 万字），这里不再预设 2 集。
            #
            # ⚠️ 2026-10-10：原为 `limit(2)`。那与 batch_gen / auto_batch / router
            # 的"全部前章"不一致 —— 同一件事，对话触发时只看最近 2 章、
            # 从草稿页生成时看全部。模型拿到的前情随入口而变，正是
            # 剧情偏移在不同入口表现不一的来源之一。
            # 多取一些（上限 60 集）交由生成侧按预算裁剪，比在这里先砍掉更安全。
            prev = (await s.execute(
                select(ScriptChapter).where(
                    ScriptChapter.draft_id == draft_id,
                    ScriptChapter.chapter_order < order,
                    ScriptChapter.full_text.isnot(None),
                ).order_by(ScriptChapter.chapter_order.desc()).limit(60)
            )).scalars().all()
            prev_list = [{"chapter_order": p.chapter_order, "title": p.title,
                          "summary": p.summary, "full_text": p.full_text}
                         for p in reversed(prev)]

        text = await generate_chapter(
            outline=outline, chapter_order=order, word_target=target,
            prev_chapters=prev_list, provider=provider, draft_id=draft_id,
            guidance=guidance)
        summary = await summarize_chapter(text)

        # 生成后自动校验（PLAN §3.3 / B8）—— 零 LLM、秒级，所以每章都跑。
        #
        # 为什么要在这一步：用户问"为什么不能生成时就确认结果是对的"，
        # 根因是校验要用户手动点。大纲层早已自动跑，章节层此前完全没有。
        #
        # ⚠ 只跑免费的那部分。LLM 层（语义级硬伤）保持手动 ——
        #   它贵且慢，用户主动点「校验」或走对话工坊「一键体检」时才跑。
        #   分级而不是"全都自动"，是为了不让生成变慢、不让成本失控。
        try:
            from ..stages.auto_check import check_chapter_zero_llm
            auto_issues = check_chapter_zero_llm(
                text=text, chapter_order=order, outline=outline, word_target=target,
            )
        except Exception as e:  # noqa: BLE001
            # 校验失败绝不能连累正文落库 —— 它是"多一道提示"，不是必经环节
            logger.warning("第%s章自动校验失败（忽略）: %s", order, e)
            auto_issues = []

        async with session_scope() as s:
            row = (await s.execute(select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order == order))).scalar_one_or_none()
            if row is None:
                row = ScriptChapter(draft_id=draft_id, chapter_order=order)
                s.add(row)
            row.title = ep.get("title", "")
            row.full_text = text
            row.summary = summary
            # 自动校验结论一并落库，前端在集卡片上直接标出来（红/黄点）
            row.auto_checks = auto_issues or None
            # word_count 必须一起写 —— 界面的集数字数、总字数统计都读这个字段，
            # 漏了它正文明明有几千字、界面显示"0 字"(2026-09-16 实测: 对话工坊
            # 「生成正文」出的 10 集全是 0，而正文实有 2489~5267 字)。
            # 另外 9 处写 ScriptChapter 的地方都有，只有这条对话工坊的路径漏了。
            row.word_count = len(text or "")
            await s.flush()

        previews.append({"order": order, "title": ep.get("title", ""),
                         "chars": len(text), "head": text[:240]})
        await jobs.set_progress(jid, progress=int(95 * i / total),
                                note=f"第{order}集完成（{len(text)}字）",
                                result={"generated": i, "total": total,
                                        "guidance": guidance[:500],
                                        "previews": previews[-3:]})

    return {"generated": len(todo), "skipped": len(done),
            "guidance": guidance[:2000], "previews": previews}


# ---------------------------------------------------------------------------
# 剧本（分镜）
# ---------------------------------------------------------------------------

async def _handle_gen_storyboards(job: dict) -> dict:
    """批量生成剧本。payload: {start, end}"""
    from ..stages.storyboard_gen import generate_storyboard, generate_storyboard_from_outline
    from ..stages.episode_render import build_contract_block, build_beats_block
    from ..stages.state_ledger import snapshot_text

    jid = job["id"]
    draft_id = job["draft_id"]
    payload = job.get("payload") or {}

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise ValueError(f"草稿 {draft_id} 不存在")
        outline = dict(d.outline or {})
        # 这一轮若指定了写作模型就用它；否则沿用草稿记的（既有行为，逐字不变）。
        provider = str(payload.get("writing_model") or "") or (d.model_provider or "gemini")
        sb_word_target = int(d.chapter_word_target or 0)
        chs = {c.chapter_order: c for c in (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
        )).scalars().all()}
        done = {r.chapter_order for r in (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
        )).scalars().all() if (r.shots_json or [])}

    eps = sorted(outline.get("chapters") or [], key=lambda e: e.get("order", 0))
    start = int(payload.get("start") or 0)
    end = int(payload.get("end") or 0)
    todo = [e for e in eps
            if (not start or e["order"] >= start)
            and (not end or e["order"] <= end)
            and e["order"] not in done]
    total = len(todo) or 1

    # 与正文同一条进度语义修复：入场先给一格，每集**开始前**推进度。
    # 旧实现只在整集写完才写进度，用户在"第一集写完之前"看到的一直是 0%。
    await jobs.set_progress(jid, progress=5,
                            note=f"共 {total} 集待写剧本，准备从第{todo[0]['order']}集开始"
                            if todo else "没有待生成的集")
    for i, ep in enumerate(todo, start=1):
        order = ep["order"]
        await jobs.set_progress(jid, progress=int(95 * (i - 1) / total) + 5,
                                note=f"正在写第{order}集剧本（第 {i}/{total} 集）")
        ch = chs.get(order)
        text = (ch.full_text or "") if ch else ""
        # 🔴 2026-10-05: 与批量路径同款 —— 注入上一集实际正文, 治相邻集重演。
        # 此前这里从大纲同步读 state_ledger(计划账本, key 与「重建账本」写的不一致),
        # 且 context 硬编码空串、不传上一集内容。
        ledger = outline.get("state_ledger_effective") or outline.get("state_ledger")
        prev_text = ""
        next_text = ""
        if not text.strip():
            # 🔴 2026-10-09：改为**上下集都取原文**（用户已定结论），取不到才退回梗概。
            # 与 batch_gen / router 走同一个取数函数，避免三个入口各写一套。
            try:
                from ..stages.episode_render import (
                    collect_neighbor_originals, _synopsis_fallback,
                )
                _nb = await collect_neighbor_originals(
                    draft_id=draft_id, order=order, outline=outline)
                for _k, _n in (("prev", order - 1), ("next", order + 1)):
                    if not _nb.get(_k) and _n >= 1:
                        _fb = _synopsis_fallback(outline, _n)
                        if _fb:
                            _nb[_k] = _fb
                prev_text = _nb.get("prev") or ""
                next_text = _nb.get("next") or ""
            except Exception as _ne:  # noqa: BLE001
                # 取不到只是少一层衔接上下文，不该让整集失败；留痕以免静默退化。
                logger.warning("第%d集: 取相邻集原文失败(本集仍会生成): %s", order, _ne)
                prev_text = ""
                next_text = ""
        if text.strip():
            lb = ""
            try:
                if ledger:
                    lb = snapshot_text(ledger, order - 1)
            except Exception:  # noqa: BLE001
                lb = ""
            shots = await generate_storyboard(
                episode_order=order,
                chapter_text=text, chapter_title=ep.get("title", ""),
                provider=provider, draft_id=draft_id, ledger_block=lb,
                word_target=sb_word_target)
        else:
            ctx = outline.get("synopsis") or ""
            lb2 = ""
            try:
                if ledger:
                    lb2 = snapshot_text(ledger, order - 1)
            except Exception:  # noqa: BLE001
                lb2 = ""
            shots = await generate_storyboard_from_outline(
                episode_order=order,
                synopsis=ep.get("synopsis", ""), chapter_title=ep.get("title", ""),
                context=ctx, provider=provider, draft_id=draft_id,
                prev_text=prev_text, next_text=next_text, ledger_block=lb2,
                # 🔴 2026-10-09：对话入口与批量/单集入口必须同款，
                # 否则同一集经由不同入口生成的结果不一致。
                contract_block=build_contract_block(outline, order),
                beats_block=build_beats_block(outline, order),
                word_target=sb_word_target)

        async with session_scope() as s:
            row = (await s.execute(select(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id,
                ScriptStoryboard.chapter_order == order))).scalar_one_or_none()
            if row is None:
                row = ScriptStoryboard(draft_id=draft_id, chapter_order=order)
                s.add(row)
            row.shots_json = shots
            await s.flush()
        await jobs.set_progress(jid, progress=int(95 * i / total),
                                note=f"第{order}集剧本完成")

    return {"generated": len(todo), "skipped": len(done)}


# ---------------------------------------------------------------------------
# 改编（小说 / 推文）
# ---------------------------------------------------------------------------

async def _handle_adapt(job: dict) -> dict:
    """改编。payload: {kind: 'novel'|'tweet'}"""
    from ..adapt_products import service as adapt_svc

    jid = job["id"]
    draft_id = job["draft_id"]
    payload = job.get("payload") or {}
    kind = payload.get("kind") or "novel"

    chapters = await adapt_svc._load_chapters(draft_id)
    if not chapters:
        raise ValueError("没有原文可改编")
    word_target = await adapt_svc._load_word_target(draft_id)
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        provider = adapt_svc._map_provider(d.model_provider if d else None)
        protagonist = str(payload.get("protagonist") or "")
        if not protagonist:
            protagonist = "主角"

    prev_out = None
    done = 0
    for i, (order, _title, full_text) in enumerate(chapters, start=1):
        if not (full_text or "").strip():
            continue
        out = await adapt_svc._gen_one(kind, provider, full_text, protagonist,
                                       prev_out, word_target)
        await adapt_svc._upsert_adaptation(draft_id, kind, order, out,
                                           protagonist=protagonist)
        prev_out = out
        done += 1
        await jobs.set_progress(jid, progress=int(95 * i / len(chapters)),
                                note=f"第{order}集 {kind} 完成")
    return {"kind": kind, "done": done}


# ---------------------------------------------------------------------------
# 生成（大纲 / 正文 / 剧本）
# ---------------------------------------------------------------------------

#: 生成类作业的**前置条件**（谁必须先有谁）。写成表而不是 if 串，是为了
#: 让"报错怎么说"和"怎么判"待在一起 —— 这两件事分开写过一次就漂了。
#: 生成大纲时，草稿没给集数就用这个（短剧的常识量级）。
_DEFAULT_EPS = 50
#: 低于这个数的 episode_count 视为"从没设过"（建表默认值就是 3），不予采信。
_MIN_PLANNED_EPS = 10


def _compose_guidance(mode_note: str, guidance: str) -> str:
    """把「模式写法约定」和「用户原话」并成一段，交给逐集 prompt 注入。

    两段都为空 → 返回 ""（调用方据此完全不写 payload，行为与加这个功能之前一致）。

    为什么在这里合而不是让 handler 自己读模式：handler 只认 payload 一个输入，
    模式是**入队那一刻**的用户状态，把它固化进 payload 才和队列的"重放安全"
    对得上——用户后来换了模式，已经排队的作业不该中途改变写法。
    """
    parts: list[str] = []
    if mode_note.strip():
        parts.append(
            "【本次模式约定（用户选的模式，写法参考）】\n" + mode_note.strip()
            + "\n（与下文的用户具体要求冲突时，**以用户要求为准**。）")
    if guidance.strip():
        parts.append(guidance.strip())
    return "\n\n".join(parts)

_GEN_PRE: dict[str, tuple[str, str]] = {
    # kind: (前置的 payload 字段, 缺了怎么跟用户说)
    "outline": ("", ""),
    "chapters": (
        "outline_chapters",
        "这部剧还没有大纲，正文没有依据可写。先点「生成 ▸ 生成大纲」。",
    ),
    "storyboards": (
        "source_text",
        "这部剧还没有正文，剧本是从正文改写来的。先点「生成 ▸ 生成正文」。",
    ),
}


async def start_generate(*, draft_id: int | None, user_id: int,
                         gen_kind: str,
                         start: int | None = None,
                         end: int | None = None,
                         guidance: str = "",
                         mode: str | None = None,
                         conversation_id: int | None = None,
                         writing_model: str | None = None) -> dict:
    """把一次「生成」入队。返回 ``{ok, job_id, kind, label}`` 或 ``{ok: False, error}``。

    draft_id: **可以为 None**。用户反馈"我就想在对话里直接写，不想碰草稿"——
    生成又必须落在某部草稿上，于是缺 draft_id 时这里自己解析一部
    （见 ``chat_skills._resolve_draft``：会话已绑的 → 会话原文能解析成集纲就导一份
    → 都没有才新建空草稿），用户全程不需要知道"草稿"这个词。
    ⚠️ 以前这里是 ``draft_id: int`` 且直接 ``s.get(ScriptDraft, draft_id)``，
    没草稿时用户看到的是"草稿 None 不存在"——那句报错对用户毫无意义。

    start / end: 只生成这个集区间。缺省（0/None）= 全部待生成的集。
    动作栏的「生成 ▾」以前把用户圈好的范围在这里丢掉，圈 3~10 集也按整本跑；
    现在原样传进 payload，由 ``_handle_gen_chapters`` / ``_handle_gen_storyboards``
    的 ``start``/``end`` 收口。**只对 chapters / storyboards 有意义** ——
    大纲生成是整本的，给 outline 传范围没有语义，忽略。

    guidance: 用户这次的临时写作要求（可为空），透传进 payload，由
    ``_handle_gen_chapters`` 逐集注入 prompt（见 ``chapter_gen._build_guidance_block``）。
    ⚠️ 这是 2026-09 用户反馈的修复点：**生成路径以前没有任何指令通道**，
    用户在对话里补的那几句要求一个字也进不去，模型只能照大纲硬写 ——
    这就是"他直接拿剧情细纲去生成，剧本 AI 感很重、细节僵硬"的结构性原因。
    精修（rewrite）一直有 guidance，生成这条路漏了。

    mode: 会话当前选的模式 key（剧本/小说/…）。**只是写法参考**，和 guidance 合并进
    payload；冲突时 guidance 赢（见 ``_compose_guidance``）。为什么由这里合并而不是让
    用户去选"模式"期望它生效：模式原本只进聊天的 system prompt，**完全够不着生成**，
    用户"选择剧本模式也没有用"的观察是准确的。

    ⚠️ 为什么要有这个函数（而不是继续让 Agent 去调 start_generation 工具）：
    对话工坊动作栏上那三颗按钮以前只把一句人话填进输入框（"帮我写一版分集大纲。"），
    指望模型自己读懂并调 ``start_generation``。实测结果是**点了就报错/毫无反应** ——
    查库可见 ``agent_jobs`` 里 ``gen_*`` 一行都没有，即失败发生在入队**之前**
    （模型没调工具、或工具被守卫提前拒了）。用户点的是按钮，意图是确定的，
    不该再赌一轮模型的自由发挥。所以动作栏的生成按钮直接走这里，确定性入队。

    三件事的前置条件不同，逐条先说清楚再入队（不建必然失败的作业）：
      · outline      —— 无前置。草稿里连题材都没有也能生成（后端会用草稿的 user_input，
                        空的话模型自己起一版）。集数取草稿已规划集数，缺省 50。
      · chapters     —— 必须先有分集大纲。
      · storyboards  —— 必须先有正文。
    """
    kind_map = {"outline": "gen_outline", "chapters": "gen_chapters",
                "storyboards": "gen_storyboards"}
    label_map = {"outline": "生成大纲", "chapters": "生成正文",
                 "storyboards": "生成剧本"}
    gen_kind = (gen_kind or "").strip()

    # 小说 / 推文（改编产物）走**另一套作业表**（ChapterAdaptJob），
    # 不经过 agent jobs 队列 —— 所以在这里分流，而不是硬塞进 kind_map。
    # 这样用户在对话里说"生成小说"与点生成菜单是同一条路（PLAN-v2收编 §3.2）。
    if gen_kind in ("novel", "tweet"):
        return await _start_adapt(gen_kind, draft_id, user_id, conversation_id)

    if gen_kind not in kind_map:
        return {"ok": False, "error": f"不认识的生成类型：{gen_kind}"}

    # 没有草稿就自己准备一部（用户不必知道）。这一步在**入队之前**做：
    # 解析失败要当场告诉用户"没能准备出可写的草稿"，而不是建一个跑起来必失败的作业。
    resolved_note = ""
    if not draft_id:
        from . import chat_skills
        draft_id, _meta = await chat_skills._resolve_draft(user_id, None, conversation_id)
        if not draft_id:
            return {"ok": False,
                    "error": "没能准备出可写的草稿。请先贴一份分集大纲（或先建草稿）再生成。"}
        if _meta.get("created"):
            resolved_note = f"（草稿 #{draft_id}：{_meta.get('how')}）"

    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        title = d.title or f"草稿{draft_id}"
        outline = dict(d.outline or {})
        eps = [e for e in (outline.get("chapters") or []) if isinstance(e, dict)]
        n_ch = (await s.execute(
            select(func.count()).select_from(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                func.coalesce(ScriptChapter.full_text, "") != "")
        )).scalar_one()
        n_sb = (await s.execute(
            select(func.count()).select_from(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id)
        )).scalar_one()
        # ⚠️ ScriptDraft.episode_count 的建表默认值是 **3**，直接拿它当生成集数
        # 会让用户点「生成大纲」得到一部 3 集的剧 —— 而短剧的常识量级是几十集。
        # 分不清"用户真想要 3 集"和"从来没设过"，所以取一个常识下限：
        # 低于 _MIN_PLANNED_EPS 的规划值一律按 _DEFAULT_EPS 生成（用户可以再要求重做）。
        planned = int(d.episode_count or 0)
        target_words = int(d.chapter_word_target or 0)

    # 前置条件（表驱动，报错文案见 _GEN_PRE）
    if gen_kind == "chapters" and not eps:
        return {"ok": False, "error": _GEN_PRE["chapters"][1],
                "hint": "先 start_generation(kind='outline')"}
    # 🔴 2026-10-18: 原先要求"必须先有正文"，与平台主流程（大纲 → 直接出剧本）矛盾——
    # 处理器 _handle_gen_storyboards 本来就会对没有正文的集按大纲生成（generate_storyboard_from_outline），
    # 只是被这条前置检查拦住：对话工坊「生成剧本」与 Agent 在纯大纲草稿上都直接报"先生成正文"。
    if gen_kind == "storyboards" and not eps:
        return {"ok": False, "error": "这部剧还没有大纲，剧本没有依据可写。先生成大纲。",
                "hint": "先 generate_outline"}

    # 同一部剧同时只允许一个覆写型重任务：生成和精修都会覆写整本，并发会互相盖。
    #
    # 🔴 2026-10-22 生产事故修复：这里原先只看 `has_active_job`（agent_jobs +
    # rewrite_jobs），**看不见进程内批量任务**（顶栏「补全/强制重写」写的是
    # outline.progress，不建 AgentJob）。实测草稿 2679：Agent 入队 #239 的同时
    # 用户在顶栏点了「补全剧本」，两条覆写型任务并行；批量先写完了 18~20 集，
    # #239 被领到时待办已空 → done + generated:0，一集没写却回"已启动"。
    # 现在用 draft_activity 把三套机制一起看。
    activity = await _draft_activity(draft_id)
    if activity.get("busy"):
        return {"ok": False,
                "error": f"《{title}》现在有任务在跑（{activity.get('summary')}），"
                         f"同时跑会互相覆盖。等它完成或先取消，再试一次。",
                "active_sources": activity.get("sources"),
                "hint": "如果确实要改做别的层，先取消在跑的那个；"
                        "不要让两条覆写型任务并行 —— 后完成的会盖掉先完成的。"}

    # 入队前先数一遍「这几集到底有没有活可干」（见 pending_counts 的 docstring）。
    # ⚠️ 2026-10-22：这段预检原先只在**对话栏**那条路（chat_skills）里有，
    # Agent 工具走的是本函数，于是 Agent 会理直气壮地回"已启动"然后空转。
    # 现在两条路共用同一套判据。
    if gen_kind in ("chapters", "storyboards"):
        _lo = int(start or 0)
        _hi = int(end or 0)
        pc = await pending_counts(draft_id, kind_map[gen_kind], _lo, _hi)
        _what = "正文" if gen_kind == "chapters" else "剧本"
        if pc["pending"] == 0:
            whole = await pending_counts(draft_id, kind_map[gen_kind], 0, 0)
            if whole["pending"] == 0:
                return {"ok": False,
                        "error": f"这部剧 {whole['scope_total']} 集**都已经有{_what}了**，"
                                 f"没有可以生成的部分，所以**没有启动任何任务**。",
                        "hint": f"**务必如实告诉用户「没有启动」**，不要说「已启动」。"
                                f"要全部重做让他用「强制重写」；只想重做某几集，"
                                f"用 regenerate_{'chapter' if gen_kind == 'chapters' else 'storyboard'} 逐集改。"}
            return {"ok": False,
                    "error": f"你指定的第{_lo}~{_hi}集都已经有{_what}了，这一段没有可做的，"
                             f"**没有启动任何任务**。整本还有 {whole['pending']} 集没做，"
                             f"第一集是第 {whole['first_pending']} 集。",
                    "hint": "**不要说「已启动」**；把这个情况告诉用户，问他要不要改做那些集。"}

    #: 这次实际会按多少集走。**必须和下面 payload 里给 _handle_gen_outline 的
    #: chapter_count 用同一个值** —— 否则回执说"3 集"、作业实际跑 8 集，
    #: 用户会以为系统在乱来。草稿 474 就是这种：episode_count 是建表默认的 3，
    #: 而它的大纲里实打实有 8 集。
    eff_eps = planned if planned >= _MIN_PLANNED_EPS else (len(eps) or _DEFAULT_EPS)

    payload: dict = {}
    if gen_kind == "outline":
        # 幂等：已有集数 >= 目标时 _handle_gen_outline 会跳过生成直接跑门禁。
        # chapter_count 取草稿已规划集数，其次已有大纲集数，最后 50。
        payload = {"mode": "preview", "chapter_count": eff_eps,
                   "expand_after_preview": True}
        if (writing_model or "").strip():
            payload["writing_model"] = writing_model.strip()
        if target_words:
            payload["chapter_word_target"] = target_words
    elif gen_kind in ("chapters", "storyboards"):
        # 不传 start/end = 只补还没生成的集（handler 里 done 集合天然排除）。
        # 传了范围 = 只做这个区间里还没生成的集，区间外一字不碰。
        # 正文与剧本共用同一对 start/end，两个 handler 都认。
        payload = {}
        if start or end:
            payload["start"] = max(1, int(start or 0)) if start else 0
            payload["end"] = int(end or 0)
        # 用户这次的临时要求 + 模式写法约定 —— 只有正文/剧本在意（大纲不写正文，吃不到）。
        # 两段都为空时不写 payload，行为与加这个功能之前逐字一致。
        _note = get_mode_generation_note(mode)
        _merged = _compose_guidance(_note, guidance)
        if _merged:
            payload["guidance"] = _merged

    # 写作模型：用户在对话栏选的那一个。空 = 用草稿自己记的 model_provider（既有行为）。
    # 落进 payload 而不是改草稿字段：这是"这一次用什么写"，不是"这部剧以后都用什么写"。
    if (writing_model or "").strip():
        payload["writing_model"] = writing_model.strip()

    try:
        job_id = await jobs.enqueue(
            kind=kind_map[gen_kind], draft_id=draft_id, user_id=user_id,
            payload=payload,
        )
    except Exception as ex:  # noqa: BLE001
        logger.exception("start_generate enqueue failed: %s", ex)
        return {"ok": False, "error": f"启动失败：{ex}"}

    if gen_kind == "outline":
        planned_out = eff_eps
    else:
        # 回执要说"这次实际会做几集"。带范围时按范围算，否则用户圈了 3~10 集
        # 却看到"依据：现有正文（60 集）"，会以为范围没生效。
        scoped = [e for e in eps
                  if (not start or int(e.get("order") or 0) >= int(start))
                  and (not end or int(e.get("order") or 0) <= int(end))]
        planned_out = len(scoped) if (start or end) else (
            len(eps) if gen_kind == "chapters" else int(n_ch))
    span = ""
    if (start or end) and gen_kind != "outline":
        orders = sorted(int(e.get("order") or 0) for e in scoped) or [0]
        span = f"第{orders[0]}~{orders[-1]}集"
    return {"ok": True, "job_id": job_id, "kind": kind_map[gen_kind],
            "label": label_map[gen_kind], "title": title,
            "planned": planned_out, "span": span, "draft_id": draft_id,
            "guidance_applied": bool((payload or {}).get("guidance")),
            "resolved_note": resolved_note,
            "has_outline": bool(eps), "chapters": int(n_ch), "storyboards": int(n_sb)}


# ---------------------------------------------------------------------------
# 整本 AI 精修（重任务）
# ---------------------------------------------------------------------------

async def start_rewrite(*, draft_id: int, user_id: int, model: str = "gpt5",
                        guidance: str = "", scope: dict | None = None) -> dict:
    """把「整本 AI 精修」入队。返回 {job_id, ...}。

    scope: ``{"start_ep": int|null, "end_ep": int|null}`` —— 只精修某个范围。
    缺省(None/两端都空)= 整本。非法值在 rewrite.service._norm_scope 里退回整本。

    ⚠️ 与 rewrite/routes.submit 的区别（同一套 service，两种投递方式）：
      · routes.submit 走 asyncio.create_task —— 容器重启就丢，状态僵死 running。
        它服务的是草稿页上用户手点的按钮（有人盯着，重发成本低），保持原样不动。
      · 这里走 jobs 队列 —— 租约 + 心跳 + 崩溃重放。对话工坊是**用户关掉页面
        也要跑完**的场景（用户可能说一句"整本精修一遍"就去做别的了），
        跑在内存里等于不可靠。

    只入队、不建 RewriteJob 行 —— 建行放在处理器里（``_handle_rewrite_script``），
    这样走通用的 ``POST /v1/agent/jobs {kind: "rewrite_script"}`` 也能用，
    不必让调用方先自己造一个改写作业。payload 合同见该处理器。
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
    job_id = await jobs.enqueue(
        kind="rewrite_script", draft_id=draft_id, user_id=user_id,
        payload={"model": model or "gpt5", "guidance": (guidance or "").strip()[:8000],
                 "scope": scope if isinstance(scope, dict) else None},
    )
    return {"ok": True, "job_id": job_id, "kind": "rewrite_script"}


async def _handle_rewrite_script(job: dict) -> dict:
    """执行整本精修。payload: {model?, guidance?, scope?, rewrite_job_id?}

    幂等（重放必须安全，精修是覆写操作，跑两遍 = 在第一次结果上再改一遍）：
      · payload 带 rewrite_job_id → 直接按那个改写作业的状态决定（done→返回上次产出）
      · 不带 → 新建一个改写作业。**重放保护靠上一次尝试的 result**（里面记着
        rewrite_job_id）：重放时若那个作业已完成，就不再跑一遍。
        ⚠️ 刻意**不**用"本草稿已有 done 的精修就跳过"来兜底 —— 用户完全可能
        想再精修一遍（改完设定再审一次），那种"保护"会把正常请求吞掉。

    scope 落到 ``RewriteJob.scope_json`` 而不是只留在 payload：重放时若 payload 读不到
    范围，第二次会把整本重写一遍 —— 用户圈的范围被无声放大，这是不可接受的。
    """
    from ..rewrite import service as rewrite_svc

    jid = job["id"]
    draft_id = job["draft_id"]
    payload = job.get("payload") or {}
    model = str(payload.get("model") or "gpt5")
    guidance = (payload.get("guidance") or "").strip()
    scope = payload.get("scope") if isinstance(payload.get("scope"), dict) else None

    rewrite_job_id = int(payload.get("rewrite_job_id") or 0)

    if rewrite_job_id:
        async with session_scope() as s:
            rj = await s.get(RewriteJob, rewrite_job_id)
            if not rj:
                raise ValueError(f"改写作业 {rewrite_job_id} 不存在")
            status, rj_draft = rj.status, rj.draft_id
            finished = rj.finished or 0
            alive = _rewrite_still_alive(rj, _now_naive())
        if status == "done":
            await jobs.set_progress(jid, progress=100, note="精修已完成（重放，未重复执行）")
            return {"rewrite_job_id": rewrite_job_id, "status": "done",
                    "applied_eps": finished, "replayed": True}
        if status == "canceled":
            return {"rewrite_job_id": rewrite_job_id, "status": "canceled"}
        # ⚠️ 还是 running/analyzing/rewriting，但**已经死了**（心跳超时）：
        # 那是上一次尝试留下的尸体，而我们自己就是它的重放 —— 继续往下走、
        # 接管这次执行即可。旧代码在这里直接 return，于是尸体永远是尸体，
        # 把整部草稿的按钮锁死（2026-10-08 事故）。
        if not alive:
            logger.warning("改写作业 #%s 心跳超时（status=%s），重放接管继续执行",
                           rewrite_job_id, status)
        draft_id = rj_draft

    else:
        # 重放保护：本队列作业上次尝试建的改写作业 id 记在自己的 result 里(见下)。
        # 这次能读到 result 是因为 claim_one 的 RETURNING 带了 result —— 少了它
        # 这里永远是 0，重放就会再建一个改写作业、把同一部剧精修两遍。
        prev_id = int((job.get("result") or {}).get("rewrite_job_id") or 0)
        if prev_id:
            async with session_scope() as s:
                rj = await s.get(RewriteJob, prev_id)
                if rj and rj.status == "done":
                    return {"rewrite_job_id": prev_id, "status": "done",
                            "applied_eps": rj.finished or 0, "replayed": True}
                if rj and rj.status in ("running", "analyzing", "rewriting", "canceled"):
                    # 同样必须判活：canceled 是用户的明确意图（尊重它），
                    # 但 running/analyzing/rewriting 只有在**还活着**时才算
                    # "另一个 worker 正在跑，别插手"。死了就要接管。
                    if rj.status == "canceled" or _rewrite_still_alive(rj, _now_naive()):
                        return {"rewrite_job_id": prev_id, "status": rj.status,
                                "replayed": True}
                    logger.warning("改写作业 #%s 心跳超时（status=%s），重放接管继续执行",
                                   prev_id, rj.status)
                    rewrite_job_id = prev_id
        if not rewrite_job_id:
            async with session_scope() as s:
                d = await s.get(ScriptDraft, draft_id)
                if not d:
                    raise ValueError(f"草稿 {draft_id} 不存在")
                rj = RewriteJob(
                    user_id=job.get("user_id"), draft_id=draft_id,
                    title=(d.title or f"草稿{draft_id}"),
                    status="running", model=model, guidance=guidance,
                    scope_json=scope,
                    heartbeat_at=_now_naive(),
                )
                s.add(rj)
                await s.flush()
                await s.refresh(rj)
                rewrite_job_id = rj.id

    # 立刻把 rewrite_job_id 记进本队列作业的 result：崩溃重放时靠它认出"上次
    # 已经建过改写作业了"，否则会再建一个、把同一部剧精修两遍。
    await jobs.set_progress(jid, progress=2, note="已创建精修作业",
                            result={"rewrite_job_id": rewrite_job_id})

    async def _prog(note: str, pct: int):
        await jobs.set_progress(jid, progress=max(3, min(97, int(pct))), note=note)

    await _prog("正在通读全剧做诊断", 5)
    await rewrite_svc.run_rewrite(rewrite_job_id, progress=_prog)

    async with session_scope() as s:
        rj = await s.get(RewriteJob, rewrite_job_id)
        status = rj.status if rj else "failed"
        total = (rj.total if rj else 0) or 0
        finished = (rj.finished if rj else 0) or 0
        err = (rj.error if rj else "") or ""
        summ = dict(rj.summary_json or {}) if rj else {}

    if status == "failed":
        # 范围落空(ScopeMiss)是**用户输入问题**, 重试必然再失败 —— 直接把人话
        # 提示交回前端, 不抛异常触发队列重试。判据是 service 打的 scope_miss 标,
        # 不是 error 文案匹配(文案会改)。
        if summ.get("scope_miss"):
            await jobs.set_progress(jid, progress=100, note=err or "精修范围落空")
            return {"rewrite_job_id": rewrite_job_id, "status": "failed",
                    "applied_eps": 0, "error": err, "scope_miss": True,
                    "scope_label": summ.get("scope_label") or ""}
        # 其余失败时原稿完全未动（service 的铁律），所以让队列重试是安全的
        raise RuntimeError(err or "整本精修失败")

    scope_label = summ.get("scope_label") or "整本"
    await jobs.set_progress(jid, progress=100,
                            note=f"精修完成（{scope_label}），覆写 {finished} 集")
    return {"rewrite_job_id": rewrite_job_id, "status": status,
            "total": total, "applied_eps": finished, "error": err,
            "scope_label": scope_label, "summary": summ}


# ---------------------------------------------------------------------------
# 体检 / 定点修复（对话工坊 v3）
# ---------------------------------------------------------------------------

async def start_check(*, draft_id: int, user_id: int, kinds: list | None = None,
                      scope: dict | None = None, deep: bool = True,
                      provider: str = "gemini", message_id: int = 0) -> dict:
    """把一次体检入队。返回 {job_id}。

    ⚠️ 对话工坊的主路径**不**走这里 —— 那里用 ``POST /v1/check`` 同步跑(秒级返回,
    用户点一下立刻出卡片)。这个入队口是给**批量/自动**场景用的: 自动体检、
    批量运营里"生成完自动体检一遍"这类没人盯着、要求可重放的场合。
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
    job_id = await jobs.enqueue(
        kind="check_script", draft_id=draft_id, user_id=user_id,
        payload={"kinds": list(kinds or []), "scope": scope if isinstance(scope, dict) else None,
                 "deep": bool(deep), "provider": provider or "gemini",
                 "message_id": int(message_id or 0)},
    )
    return {"ok": True, "job_id": job_id, "kind": "check_script"}


async def _handle_check_script(job: dict) -> dict:
    """执行一次体检并把报告落库。payload: {kinds?, scope?, deep?, provider?, message_id?}

    幂等: 体检是**纯读 + 只读 LLM 分析**, 不改任何稿件数据。重放最多多存一行报告,
    没有脏数据风险 —— 所以这里不需要像精修那样的重放保护。
    """
    from ..check.engine import run_check, ALL_KINDS, KIND_LABEL
    from ..check.fixer import index_issues
    from ..db import CheckReport

    jid = job["id"]
    draft_id = job["draft_id"]
    payload = job.get("payload") or {}
    kinds = tuple(k for k in (payload.get("kinds") or []) if k in ALL_KINDS) or ALL_KINDS
    scope = payload.get("scope") if isinstance(payload.get("scope"), dict) else None

    await jobs.set_progress(jid, progress=10, note="正在做体检")
    report = await run_check(
        draft_id=draft_id, kinds=kinds, scope=scope,
        provider=str(payload.get("provider") or "gemini"),
        deep=bool(payload.get("deep", True)))

    idx = index_issues(report)
    async with session_scope() as s:
        row = CheckReport(draft_id=draft_id, user_id=job.get("user_id") or 0,
                          kinds=list(kinds), scope=scope, report=report, issue_index=idx)
        s.add(row)
        await s.flush()
        report_id = row.id
        mid = int(payload.get("message_id") or 0)
        if mid:
            from ..db import AgentMessage
            m = await s.get(AgentMessage, mid)
            if m:
                m.report_json = {"report_id": report_id, **report}

    report["report_id"] = report_id
    totals = report.get("totals") or {}
    await jobs.set_progress(
        jid, progress=100,
        note=f"体检完成：{totals.get('error', 0)} 个硬伤 / {totals.get('warn', 0)} 个提醒",
        result={"report_id": report_id, "totals": totals, "issue_count": len(idx)})
    return {"report_id": report_id, "totals": totals,
            "kinds": [KIND_LABEL.get(k, k) for k in kinds], "issue_count": len(idx)}


async def start_fix(*, draft_id: int, user_id: int, issue_ids: list,
                    report_id: int = 0, writing_model: str | None = None) -> dict:
    """把"定点修复"入队。返回 {job_id}。

    只接受 issue_id —— 问题内容在处理器里从 ``check_reports.issue_index`` 取回。
    前端(或任何调用方)不可能构造一条不存在的问题让引擎去执行。
    """
    if not issue_ids:
        return {"ok": False, "error": "没有要修复的问题"}
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在"}
        if not report_id:
            from ..db import CheckReport
            row = (await s.execute(
                select(CheckReport).where(CheckReport.draft_id == draft_id)
                .order_by(CheckReport.id.desc()).limit(1)
            )).scalars().first()
            if not row:
                return {"ok": False, "error": "这份草稿还没有体检报告，请先体检"}
            report_id = row.id
    job_id = await jobs.enqueue(
        kind="fix_script", draft_id=draft_id, user_id=user_id,
        payload={"issue_ids": [str(x) for x in issue_ids][:200],
                 "report_id": int(report_id),
                 # 这一轮指定的写作模型；空 = 沿用草稿的 model_provider（既有行为）
                 **({"writing_model": writing_model.strip()} if (writing_model or "").strip() else {})},
    )
    return {"ok": True, "job_id": job_id, "kind": "fix_script", "report_id": report_id}


async def _handle_fix_script(job: dict) -> dict:
    """执行定点修复。payload: {issue_ids, report_id}

    幂等: **不幂等, 且不需要**。修复是"把这条问题改掉", 跑两遍 = 在已改好的稿上
    再改一遍。但重放是安全的: 每集修复前写 ``ScriptEpisodeHistory``(可回滚),
    且修完的集上那条问题已经不存在 —— 再修一次模型会发现"没得改"而返回原样,
    不会产生新破坏。所以这里刻意不做"已跑过就跳过"的保护: 用户看完报告想再修
    一遍完全合理(比如上次模型没改到位), 那种保护会把正常请求吞掉。
    """
    from ..check.fixer import run_fix
    from ..db import CheckReport

    jid = job["id"]
    draft_id = job["draft_id"]
    payload = job.get("payload") or {}
    issue_ids = [str(x) for x in (payload.get("issue_ids") or [])]
    report_id = int(payload.get("report_id") or 0)
    if not issue_ids:
        raise ValueError("没有要修复的问题")

    async with session_scope() as s:
        r = await s.get(CheckReport, report_id) if report_id else None
        if not r:
            r = (await s.execute(
                select(CheckReport).where(CheckReport.draft_id == draft_id)
                .order_by(CheckReport.id.desc()).limit(1)
            )).scalars().first()
        if not r:
            raise ValueError("找不到体检报告，请先体检")
        if int(r.draft_id) != int(draft_id):
            raise ValueError("报告与草稿不匹配")
        issue_index = dict(r.issue_index or {})
        report_id = r.id

    async def _prog(note: str, pct: int):
        await jobs.set_progress(jid, progress=max(5, min(96, int(pct))), note=note)

    await _prog(f"正在修复 {len(issue_ids)} 个问题", 10)

    _wm = str(payload.get("writing_model") or "").strip()
    if not _wm:
        async with session_scope() as s:
            _d = await s.get(ScriptDraft, draft_id)
            _wm = (_d.model_provider if _d else None) or "gemini"
    res = await run_fix(draft_id=draft_id, issue_index=issue_index,
                        issue_ids=issue_ids, user_id=job.get("user_id"),
                        provider=_wm, progress=_prog)
    if not res.get("ok"):
        raise RuntimeError(res.get("error") or "修复未能执行")

    # ---- 修完立刻复检: 拿**同一把尺子**量 before → after ----
    # ⚠️ 2026-10-08 修。此前两边口径不同，那个"修前 12 → 修后 7"根本不可比：
    #   · before 取整份报告 issue_index 的**全部**问题（含用户没点名要修的集）；
    #   · after 只筛"动过的集 + 无集号问题"。
    # 于是"没降下来"可能只是因为分母里混进了压根没打算改的集，反之亦然。
    # 现在两边都用同一个 _count_issues(..., within=touched)：只数**动过的集**上的
    # 问题，外加无集号的全局问题（它们不属于任何一集，改没改都该在场）。
    await _prog("正在复检修复结果", 96)
    # ⚠️ 必须把**大纲集**并进来。touched_eps 只装剧本路径成功的集
    # （check/fixer.py 的 touched.add 只在那一条分支里），而 structure 类问题
    # 改的是大纲 —— 漏掉它们的后果是"修前 → 修后"这个数字在大纲类修复上
    # 恒定显示 0 → 0，看起来像什么都没发生，即使 3 集大纲真的被改了。
    touched = sorted({int(e) for e in (res.get("touched_eps") or [])}
                     | {int(e) for e in (res.get("touched_outline_eps") or [])})

    def _count_issues(items, within: set) -> tuple[int, int]:
        """按统一口径数 (硬伤, 提醒)：只算 within 里的集 + 无集号问题。"""
        err = warn = 0
        for it in items:
            ep = it.get("episode")
            if ep is not None:
                try:
                    if int(ep) not in within:
                        continue
                except (TypeError, ValueError):
                    continue
            if it.get("level") == "error":
                err += 1
            else:
                warn += 1
        return err, warn

    touched_set = {int(e) for e in touched}
    #: before 用**同一把尺子**重新数一遍（而不是沿用上面那个含全本的 before）
    before_scoped = _count_issues(list(issue_index.values()), touched_set)
    try:
        from ..check.engine import run_check
        after_report = await run_check(
            draft_id=draft_id, kinds=("structure", "style", "consistency", "script"),
            scope=None, provider="gemini", deep=False)
        after_items = [it for c in (after_report.get("checks") or {}).values()
                       for it in (c.get("issues") or [])]
        e2, w2 = _count_issues(after_items, touched_set)
        # touched 为空（一条都没改成功）时，before 会数成"无集号问题"那几个，
        # 那是唯一诚实的读数：动过的集 = 空集，本来就没有可比的分母。
        res["after"] = {"error": e2, "warn": w2,
                        "before_error": before_scoped[0], "before_warn": before_scoped[1],
                        "touched_eps": touched, "report_id": report_id,
                        "scope_note": "口径：只统计本次动过的集 + 无集号的全剧级问题"}
        res["improved"] = e2 < before_scoped[0]
        res["after_report"] = {k: v for k, v in after_report.items()
                               if k in ("checks", "totals", "scope", "checked_at", "kinds")}
        if not res["improved"] and before_scoped[0]:
            res["notes"] = (res.get("notes") or []) + [
                f"复检后问题数没有下降（{before_scoped[0]} → {e2}），"
                f"说明这次没改到位 —— 原稿已存历史版本可回滚，也可以换个说法再让它改一次。"]
    except Exception as ex:  # noqa: BLE001
        logger.warning("修复后复检失败（不影响已落库的修复）: %s", ex)
        res["after"] = {"before_error": before_scoped[0], "before_warn": before_scoped[1],
                        "touched_eps": touched, "report_id": report_id,
                        "recheck_failed": str(ex)[:200]}

    # ⚠️ 2026-10-11：计数必须**两条路径都算**。
    # structure 类问题全走大纲路径进 outline_fixed（check/fixer.py:_fix_outline_episode），
    # 而 touched.add() 只在剧本路径被调用 —— 于是"改了 3 集大纲"的作业报出来是
    # 「改好 0 集 / 未改好 0 集」。用户甲看到的就是"卡说改 3 个问题、作业说改好 0 集"。
    # 两处数字各自诚实，只是口径没合上。
    n_script = len(res.get("fixed_eps") or [])
    n_outline = len(res.get("outline_fixed") or [])
    fail_n = len(res.get("failed_eps") or [])
    ok_n = n_script + n_outline

    # 分开说，别把两类合成一个数字：用户据此判断"我点的那几条到底改到了没有"，
    # 混在一起就看不出一集大纲都没改成功。
    parts = []
    if n_script:
        parts.append(f"正文/剧本 {n_script} 集")
    if n_outline:
        parts.append(f"大纲 {n_outline} 集")
    note = ("修复完成：改好 " + "、".join(parts)) if parts else "修复完成：没有可修的集"
    if fail_n:
        note += f"；未改好 {fail_n} 集"

    await jobs.set_progress(
        jid, progress=100,
        note=note,
        result={k: res.get(k) for k in
                ("fixed_eps", "failed_eps", "outline_fixed", "after", "improved", "notes")})
    # ⚠️ outline_fixed 必须一起回传：run_job 收尾时会用这个返回值**整体覆盖** result
    # 列（jobs.py 的 `finish(result=result or {})`），漏掉它上面刚写的明细分就没了。
    return {"report_id": report_id, "fixed": ok_n, "failed": fail_n,
            "fixed_script": n_script, "fixed_outline": n_outline,
            "outline_fixed": res.get("outline_fixed") or [],
            "improved": res.get("improved"), "after": res.get("after"),
            "notes": res.get("notes") or []}


async def _handle_deai_apply(job: dict) -> dict:
    """去 AI 味：逐集改写并写回（原稿或副本，作业挂在哪部就写哪部）。payload 见 deai.routes.start_deai_apply。

    重放安全：每集写回前比对"读时指纹"，已写过的集在重放时读到的就是新文本，
    会被当成一次新的去味 —— 为避免同一集被洗两遍，重放直接返回上次的结果。
    """
    from ..deai.service import run_deai_apply
    prev = job.get("result") or {}
    if prev.get("applied_eps") is not None and not prev.get("partial"):
        return {**prev, "replayed": True}
    p = job.get("payload") or {}
    await jobs.set_progress(job["id"], progress=1, note="去 AI 味：准备中")
    res = await run_deai_apply(
        job_id=job["id"], draft_id=job["draft_id"], model=str(p.get("model") or "gemini"),
        inject_level=str(p.get("inject_level") or "light"), allow_typo=bool(p.get("allow_typo", True)),
        start_ep=int(p.get("start_ep") or 0), end_ep=int(p.get("end_ep") or 0), layer=p.get("layer"))
    res.update({"target": p.get("target") or "inplace", "source_draft_id": p.get("source_draft_id")})
    note = f"去 AI 味完成：改了 {res['applied']}/{res['total']} 集"
    if res["skipped"]:
        note += f"，{len(res['skipped'])} 集未改"
    await jobs.set_progress(job["id"], progress=100, note=note, result=res)
    return res


async def _handle_adapt_commit(job: dict) -> dict:
    """改编确认（复制新草稿 → 改编大纲 → 补节拍 → 校验 → 逐集仿写剧本）。

    payload: {source_draft_id, contract}；作业的 draft_id = 源草稿（同一原作不能并发改编两次）。
    重放安全：上一次尝试的 result 记着新草稿 id 与已完成阶段，原样传回续跑。
    """
    from ..stages.adaptation import run_adapt_commit
    payload = job.get("payload") or {}
    return await run_adapt_commit(
        job_id=job["id"], source_draft_id=int(payload["source_draft_id"]),
        user_id=int(job.get("user_id") or 0), contract=payload.get("contract") or {},
        state=job.get("result") or None,
        writing_model=(payload.get("writing_model") or None),
    )


def register_all() -> None:
    """把处理器注册进队列。服务启动时调用一次。"""
    jobs.register_handler("gen_outline", _handle_gen_outline)
    jobs.register_handler("gen_chapters", _handle_gen_chapters)
    jobs.register_handler("gen_storyboards", _handle_gen_storyboards)
    jobs.register_handler("adapt_products", _handle_adapt)
    jobs.register_handler("rewrite_script", _handle_rewrite_script)
    jobs.register_handler("check_script", _handle_check_script)
    jobs.register_handler("fix_script", _handle_fix_script)
    jobs.register_handler("adapt_commit", _handle_adapt_commit)
    jobs.register_handler("deai_apply", _handle_deai_apply)


__all__ = ["register_all", "has_active_job", "start_rewrite", "start_check",
           "start_fix", "start_generate"]


async def _start_adapt(kind: str, draft_id: int | None, user_id: int,
                       conversation_id: int | None) -> dict:
    """启动小说 / 推文改编（PLAN-v2收编与v1退役 §3.2）。

    与三种主产物的差别：它用自己的作业表 `ChapterAdaptJob`，
    **不在** `/v1/stages/drafts/{id}/progress` 的统计里 ——
    所以回执里不能说"上方进度条会实时走"，那是骗人。

    推文比小说多一个「主角」参数：不为它加表单，
    这里自动调 `suggest_protagonist` 拿一个建议值，并在回执里写明是谁、
    想换人直接在对话里说（PLAN §3.2 的裁定）。
    """
    from ..db import ScriptChapter, ScriptDraft, session_scope as _scope
    from ..adapt_products.models import ChapterAdaptJob
    from ..adapt_products import service as adapt_service
    from sqlalchemy import func as _func, select as _select

    if not draft_id:
        from . import chat_skills
        draft_id, _m = await chat_skills._resolve_draft(user_id, None, conversation_id)
        if not draft_id:
            return {"ok": False, "error": "没能确定要给哪部剧做改编，先在页面上选一部。"}

    async with _scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"ok": False, "error": f"草稿 {draft_id} 不存在。"}
        title = d.title or f"草稿{draft_id}"
        n_ch = (await s.execute(
            _select(_func.count(ScriptChapter.id)).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.full_text.isnot(None)))).scalar() or 0

    label = "小说" if kind == "novel" else "推文"
    if not n_ch:
        return {"ok": False,
                "error": f"《{title}》还没有正文，{label}是从正文改写来的。先生成正文再来。"}

    protagonist = ""
    if kind == "tweet":
        try:
            data = await adapt_service.suggest_protagonist(draft_id, "gemini")
            # ⚠️ 它返回的是 {name, reason}，不是 {protagonist}
            protagonist = str((data or {}).get("name") or "").strip()
        except Exception as e:  # noqa: BLE001
            logger.warning("suggest_protagonist 失败（继续，按默认主角）: %s", e)

    async with _scope() as s:
        job = ChapterAdaptJob(user_id=user_id, draft_id=draft_id, kind=kind,
                              status="running", model="gemini", protagonist=protagonist)
        s.add(job)
        await s.flush()
        job_id = job.id

    import asyncio as _asyncio
    _asyncio.create_task(adapt_service.run_adapt(job_id))

    extra = f"- **主角**：{protagonist}（想换人直接跟我说）\n" if protagonist else ""
    return {
        "ok": True, "job_id": job_id, "draft_id": draft_id,
        "kind": f"gen_{kind}", "label": f"生成{label}", "title": title,
        "planned": n_ch, "adapt": True,
        "extra": (f"- **依据**：现有正文（{n_ch} 集），逐章改写成{label}\n"
                  + extra
                  + f"- 跑完在右栏「{label}」页签里看（**进度条不跟这个作业**，"
                    f"刷新那个页签即可）\n"),
    }
