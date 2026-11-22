"""自动打磨工作流引擎 v2: run_polish(job_id) —— 事实账本 + 硬伤工单 + 定向修复。

设计(替换了旧的"逐集重写追分数", 详见 docs/PLAN-硬伤打磨引擎-事实账本方案.md):
- 一个 PolishJob = 一批草稿 + 参数(max_rounds=最大修复轮, target_p0=允许残留P0数)。
- 每个草稿独立跑, 草稿之间用 Semaphore 高并发。
- 单草稿循环(单调收敛, 不追分数):
    for round in 1..max_rounds:
      1. 体检: find_hard_issues → 硬伤工单(死人复活/设定冲突/时代穿帮/姓名/称谓)
      2. 收敛: 残留 P0 <= target_p0 → 标"已清零" break
      3. 否则逐条定向修复(只改相关集的最小改动) + 逐条复核是否真消除
    跑满 max_rounds 仍有残留 → 标"仍有残留(N 个)"
- 双保险退出: 清零 OR 满轮, 绝不无限循环。

复用(只取需要的, 不顺手做别的):
- hardcheck.find_hard_issues : 世界观圣经(有则复用/无则单模型抽) + 规则扫描 + 账本检测
- fixer.fix_issue / verify_issue : 逐工单定向改写(复用 router.regenerate_*_with_feedback) + 复核
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select, text

from ..db import session_scope
from ..db.models import PolishJob

logger = logging.getLogger("polish")

# 草稿级并发: 每个草稿内部串行(体检→修复依赖前一步), 草稿之间高并发。
# 遵循并发铁律: 不擅自降并发, 瓶颈靠加 KEY/扩容。
MAX_CONCURRENCY = 500


# ---------------------------------------------------------------------------
# 作业/进度读写
# ---------------------------------------------------------------------------
async def _set_job(job_id: int, **fields):
    async with session_scope() as s:
        job = await s.get(PolishJob, job_id)
        if not job:
            return
        for k, v in fields.items():
            setattr(job, k, v)
        await s.flush()


async def _set_draft(job_id: int, draft_id: int, **patch):
    """原子更新某草稿轨迹的若干字段(per_draft_json[draft_id][k]=v)。

    用 Postgres jsonb_set 逐字段原子更新, 避免高并发下"整份读改写"互相覆盖。
    每个 key 单独一条 jsonb_set, 只改自己那个字段, 不触碰同草稿的 rounds/其他字段。
    """
    import json as _json
    if not patch:
        return
    key = str(draft_id)
    async with session_scope() as s:
        # 确保该草稿的对象存在(缺失则初始化为 {}), 再逐字段 set
        await s.execute(
            text(
                "UPDATE polish_jobs "
                "SET per_draft_json = jsonb_set(COALESCE(per_draft_json,'{}'::jsonb), "
                "  ARRAY[:key], COALESCE(per_draft_json->:key, '{}'::jsonb), true) "
                "WHERE id=:jid"
            ),
            {"jid": job_id, "key": key},
        )
        for k, v in patch.items():
            await s.execute(
                text(
                    "UPDATE polish_jobs "
                    "SET per_draft_json = jsonb_set(per_draft_json, ARRAY[:key, :field], "
                    "  CAST(:val AS jsonb), true) "
                    "WHERE id=:jid"
                ),
                {"jid": job_id, "key": key, "field": k, "val": _json.dumps(v)},
            )
        await s.flush()


async def _append_round(job_id: int, draft_id: int, round_rec: dict):
    """原子给某草稿追加一轮记录(rounds 数组尾部 append)。

    用 jsonb || 拼接实现并发安全的数组追加, 不整份读改写。
    """
    import json as _json
    key = str(draft_id)
    async with session_scope() as s:
        # 确保草稿对象 + rounds 数组存在
        await s.execute(
            text(
                "UPDATE polish_jobs "
                "SET per_draft_json = jsonb_set(COALESCE(per_draft_json,'{}'::jsonb), "
                "  ARRAY[:key], COALESCE(per_draft_json->:key, '{}'::jsonb), true) "
                "WHERE id=:jid"
            ),
            {"jid": job_id, "key": key},
        )
        await s.execute(
            text(
                "UPDATE polish_jobs "
                "SET per_draft_json = jsonb_set(per_draft_json, ARRAY[:key,'rounds'], "
                "  COALESCE(per_draft_json->:key->'rounds', '[]'::jsonb) || CAST(:rec AS jsonb), true) "
                "WHERE id=:jid"
            ),
            {"jid": job_id, "key": key, "rec": _json.dumps([round_rec])},
        )
        await s.flush()


async def _patch_last_round(job_id: int, draft_id: int, **patch):
    """原子回填某草稿"最后一轮"记录的字段(如把上一轮的 score_after 填上)。

    用 jsonb_set + 数组末位索引(-1)只改最后一个元素的指定字段。
    """
    import json as _json
    if not patch:
        return
    key = str(draft_id)
    async with session_scope() as s:
        # 取当前 rounds 长度以定位末位索引
        row = (await s.execute(
            text("SELECT jsonb_array_length(COALESCE(per_draft_json->:key->'rounds','[]'::jsonb)) "
                 "FROM polish_jobs WHERE id=:jid"),
            {"jid": job_id, "key": key},
        )).first()
        n = int(row[0]) if row and row[0] is not None else 0
        if n <= 0:
            return
        last = n - 1
        for k, v in patch.items():
            await s.execute(
                text(
                    "UPDATE polish_jobs "
                    "SET per_draft_json = jsonb_set(per_draft_json, "
                    "  ARRAY[:key,'rounds',:idx,:field], CAST(:val AS jsonb), true) "
                    "WHERE id=:jid"
                ),
                {"jid": job_id, "key": key, "idx": str(last), "field": k, "val": _json.dumps(v)},
            )
        await s.flush()


# ---------------------------------------------------------------------------
# 单草稿: 硬伤检查 → 逐工单定向修复 → 复核, 直到 P0 清零或达最大修复轮
# ---------------------------------------------------------------------------
async def _run_draft(job_id: int, draft_id: int, title: str, user_id: int,
                     max_rounds: int, target_score: int, target_p0: int,
                     sem: asyncio.Semaphore):
    """新引擎(事实账本+硬伤工单+定向修复)。

    - target_p0 复用为"允许残留P0数"(默认0)。target_score 弃用(仅记录参考)。
    - max_rounds 复用为"最大修复轮"(默认2): 每轮 = 重新体检 + 修当前所有 open 的 P0。
    """
    from .hardcheck import find_hard_issues
    from .fixer import fix_issue, verify_issue

    async with sem:
        await _set_draft(job_id, draft_id, title=title, status="优化中",
                         current_step="体检中(建账本+扫世界观)")
        try:
            bible: dict = {}
            last_open_p0 = None
            for rnd in range(1, max_rounds + 1):
                # 取消检查点
                async with session_scope() as s:
                    job = await s.get(PolishJob, job_id)
                    if job and job.status == "canceled":
                        await _set_draft(job_id, draft_id, status="已取消")
                        return

                # ① 体检: 找硬伤工单
                await _set_draft(job_id, draft_id, current_step=f"第{rnd}轮·体检中")
                issues, bible, fact_cnt = await find_hard_issues(draft_id)
                p0_issues = [it for it in issues if it.get("severity") == "P0"]
                p0_found = len(p0_issues)
                if rnd == 1:
                    await _set_draft(job_id, draft_id, bible_ready=bool(bible),
                                     ledger_facts=fact_cnt, p0_found=p0_found,
                                     issues=issues)

                # ② 收敛: 残留 P0 <= 允许值 → 清零达标
                if p0_found <= (target_p0 or 0):
                    await _append_round(job_id, draft_id, {
                        "round": rnd, "p0_before": p0_found, "p0_after": p0_found,
                        "fixed": 0, "detail": f"第{rnd}轮体检: P0={p0_found} 已达标(允许残留{target_p0 or 0})",
                    })
                    await _set_draft(job_id, draft_id, status="已清零",
                                     current_step=f"P0清零(残留{p0_found})", p0_left=p0_found)
                    await _bump_finished(job_id)
                    return

                # ③ 逐条定向修复 P0
                await _set_draft(job_id, draft_id,
                                 current_step=f"第{rnd}轮·修复 {p0_found} 个硬伤")
                fixed_cnt = 0
                closed_cnt = 0
                fix_notes = []
                for it in p0_issues:
                    # 取消检查点(修复中也响应)
                    async with session_scope() as s:
                        job = await s.get(PolishJob, job_id)
                        if job and job.status == "canceled":
                            await _set_draft(job_id, draft_id, status="已取消")
                            return
                    res = await fix_issue(draft_id, it, bible)
                    if res.get("fixed_eps"):
                        fixed_cnt += 1
                        # 复核该条是否消除
                        try:
                            closed = await verify_issue(draft_id, it, bible)
                        except Exception:  # noqa: BLE001
                            closed = False
                        if closed:
                            closed_cnt += 1
                        fix_notes.append(f"[{it.get('type')}]{'✓关闭' if closed else '仍在'}")

                await _append_round(job_id, draft_id, {
                    "round": rnd, "p0_before": p0_found,
                    "fixed": fixed_cnt, "closed": closed_cnt,
                    "detail": f"修复 {fixed_cnt}/{p0_found} 条, 复核关闭 {closed_cnt} 条; " + "、".join(fix_notes[:8]),
                })
                last_open_p0 = p0_found - closed_cnt

            # 跑满修复轮: 末次体检拿残留
            issues, bible, _ = await find_hard_issues(draft_id)
            p0_left = len([it for it in issues if it.get("severity") == "P0"])
            await _patch_last_round(job_id, draft_id, p0_after=p0_left)
            if p0_left <= (target_p0 or 0):
                await _set_draft(job_id, draft_id, status="已清零",
                                 current_step=f"满轮末次: P0残留{p0_left}(达标)",
                                 p0_left=p0_left, issues=issues)
            else:
                await _set_draft(job_id, draft_id, status="仍有残留",
                                 current_step=f"已达最大修复轮, 仍残留 {p0_left} 个硬伤",
                                 p0_left=p0_left, issues=issues)
            await _bump_finished(job_id)
        except Exception as e:  # noqa: BLE001
            logger.exception("polish draft %d failed: %s", draft_id, e)
            await _set_draft(job_id, draft_id, status="失败",
                             current_step="异常", detail=str(e)[:200])
            await _bump_failed(job_id)


async def _bump_finished(job_id: int):
    async with session_scope() as s:
        job = await s.get(PolishJob, job_id)
        if job:
            job.finished = (job.finished or 0) + 1
            await s.flush()


async def _bump_failed(job_id: int):
    async with session_scope() as s:
        job = await s.get(PolishJob, job_id)
        if job:
            job.failed = (job.failed or 0) + 1
            await s.flush()


# ---------------------------------------------------------------------------
# 作业主协程
# ---------------------------------------------------------------------------
_DONE_DRAFT_STATUS = {"已清零", "仍有残留"}  # 视为已完成(不再 resume 重跑)


async def run_polish(job_id: int, *, resume: bool = False):
    """打磨作业主协程。resume=True 时跳过已收敛/已达最大轮的草稿, 只补跑未完成的。"""
    async with session_scope() as s:
        job = await s.get(PolishJob, job_id)
        if not job:
            return
        job.status = "running"
        if not job.started_at:
            job.started_at = datetime.now(timezone.utc)
        job.finished_at = None
        draft_ids = list(job.draft_ids or [])
        per = dict(job.per_draft_json or {})
        max_rounds = job.max_rounds or 2
        target_score = job.target_score if job.target_score is not None else 0  # v2 弃用, 仅占位
        target_p0 = job.target_p0 if job.target_p0 is not None else 0
        user_id = job.user_id
        await s.flush()
    # 计费归属: 后台打磨/重启恢复路径无请求上下文, 显式盖一次
    from ..factory.usage import set_usage_context
    set_usage_context(job_id=job_id, user_id=user_id, source="polish")

    # 决定要跑哪些草稿
    if resume:
        todo = [d for d in draft_ids if (per.get(str(d)) or {}).get("status") not in _DONE_DRAFT_STATUS]
        done_cnt = len(draft_ids) - len(todo)
        async with session_scope() as s:
            job = await s.get(PolishJob, job_id)
            if job:
                job.finished = done_cnt
                job.failed = 0
                await s.flush()
        logger.info("polish job %d RESUME: %d 已完成, 补跑 %d 个", job_id, done_cnt, len(todo))
        if not todo:
            await _finalize(job_id)
            return
    else:
        todo = list(draft_ids)

    # 拿标题(用于展示)
    titles: dict[int, str] = {}
    try:
        from ..db import ScriptDraft
        async with session_scope() as s:
            rows = (await s.execute(
                select(ScriptDraft.id, ScriptDraft.title).where(ScriptDraft.id.in_(todo))
            )).all()
            for did, t in rows:
                titles[did] = t or f"草稿#{did}"
    except Exception:
        pass

    sem = asyncio.Semaphore(MAX_CONCURRENCY)
    tasks = [
        _run_draft(job_id, d, titles.get(d, f"草稿#{d}"), user_id,
                   max_rounds, target_score, target_p0, sem)
        for d in todo
    ]
    try:
        await asyncio.gather(*tasks)
    except Exception as e:  # noqa: BLE001
        logger.exception("run_polish gather error: %s", e)

    await _finalize(job_id)


async def _finalize(job_id: int):
    """收尾: 按 per_draft 真实状态重算 job 状态。"""
    async with session_scope() as s:
        job = await s.get(PolishJob, job_id)
        if not job:
            return
        per = dict(job.per_draft_json or {})
        draft_ids = list(job.draft_ids or [])
        real_done = sum(1 for d in draft_ids if (per.get(str(d)) or {}).get("status") in _DONE_DRAFT_STATUS)
        real_failed = sum(1 for d in draft_ids if (per.get(str(d)) or {}).get("status") == "失败")
        unfinished = len(draft_ids) - real_done - real_failed
        job.finished = real_done
        job.failed = real_failed
        if unfinished > 0:
            job.status = "partial_failed"
        elif real_failed == 0:
            job.status = "done"
        elif real_failed >= (job.total or 0):
            job.status = "failed"
        else:
            job.status = "partial_failed"
        job.finished_at = datetime.now(timezone.utc)
        await s.flush()
        logger.info("polish job %d 收尾: done=%d failed=%d unfinished=%d -> %s",
                    job_id, real_done, real_failed, unfinished, job.status)