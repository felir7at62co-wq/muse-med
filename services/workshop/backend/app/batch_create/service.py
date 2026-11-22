"""批量创建编排服务。

流程(每个草稿):
  1. AI 基于用户方向发散一个"不雷同"的创意 (title + user_input)
  2. 创建草稿 ScriptDraft
  3. 生成大纲 generate_outline
  4. 按 mode 生成:  novel(小说正文, batch_generate_chapters) | script(剧本/分镜, batch_generate_storyboards)
  5. 剧情分析 + 打分 (run_analysis), 把 overall_score 回写到草稿(供列表排序)

并发: 信号量限流(默认 5)。批次状态持久化在 AutoBatchJob(复用现有表):
  - config_json: 入参快照 {direction, count, words, episodes, mode, per_draft:[{draft_id,title,step,score}...]}
  - status/total_dramas/finished_dramas/failed_dramas/draft_ids
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from ..db import ScriptDraft, session_scope
from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from ..db.models import AutoBatchJob, ScriptAnalysis
from ..models.llm import get_llm
from ..stages.outline_gen import generate_outline
from ..stages.batch_gen import batch_generate_chapters, batch_generate_storyboards
from ..analysis.analyzer import run_analysis

logger = logging.getLogger("batch_create")

# 草稿级并发: 之前=5 太低, 批量创建上百部剧时排队太久。放到 50, 让几十部剧同时开跑。
# 底层生成(大纲/剧本/分析)各有独立并发队列限流, 这里只是同时发起多少条流水线, 高并发安全。
MAX_CONCURRENCY = 50    # 高额并发上限
MAX_COUNT = 100         # 单批上限


async def _update_job(job_id: int, **fields):
    async with session_scope() as s:
        job = await s.get(AutoBatchJob, job_id)
        if not job:
            return
        for k, v in fields.items():
            setattr(job, k, v)
        await s.flush()


async def _update_per_draft(job_id: int, idx: int, **patch):
    """更新 config_json.per_draft[idx] 的进度字段(step/draft_id/score/error)。"""
    async with session_scope() as s:
        job = await s.get(AutoBatchJob, job_id)
        if not job:
            return
        cfg = dict(job.config_json or {})
        pd = list(cfg.get("per_draft") or [])
        while len(pd) <= idx:
            pd.append({})
        pd[idx] = {**pd[idx], **patch}
        cfg["per_draft"] = pd
        job.config_json = cfg
        flag_modified(job, "config_json")
        await s.flush()


async def _bump_counter(job_id: int, *, finished: bool = False, failed: bool = False, draft_id: int | None = None):
    async with session_scope() as s:
        job = await s.get(AutoBatchJob, job_id)
        if not job:
            return
        if finished:
            job.finished_dramas = (job.finished_dramas or 0) + 1
        if failed:
            job.failed_dramas = (job.failed_dramas or 0) + 1
        if draft_id is not None:
            ids = list(job.draft_ids or [])
            if draft_id not in ids:
                ids.append(draft_id)
            job.draft_ids = ids
            flag_modified(job, "draft_ids")
        await s.flush()


async def _drain(agen):
    """把 SSE 生成器跑完(我们只关心副作用: 写库), 丢弃产出的事件。"""
    async for _ in agen:
        pass


async def _invent_idea(direction: str, index: int, provider: str) -> dict:
    """让 AI 基于用户方向发散出第 index 个不雷同的短剧创意。

    返回 {title, premise}。失败时给个兜底。
    """
    prompt = f"""你是短剧策划。用户给了一个粗略方向, 请据此构思【第 {index} 个】短剧创意。
要求这个创意与同方向的其他创意**尽量不雷同**(换主角设定/核心冲突/爽点切入角度)。

用户方向:
{direction or '(未指定, 自由发挥当下热门短剧类型)'}

只输出 JSON, 不要解释:
{{"title": "有网感的短剧名(6-14字)", "premise": "一句话核心设定+主要冲突+爽点(60-120字)"}}"""
    try:
        llm = get_llm(role="generate", provider=provider, temperature=0.95, max_tokens=400)
        resp = await llm.ainvoke(prompt)
        raw = (resp.content if isinstance(resp.content, str) else "").strip()
        import re
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        data = json.loads(m.group()) if m else {}
        title = (data.get("title") or "").strip()
        premise = (data.get("premise") or "").strip()
        if title and premise:
            return {"title": title, "premise": premise}
    except Exception as e:
        logger.warning("invent idea #%d failed: %s", index, e)
    # 兜底
    return {
        "title": f"AI创意#{index}",
        "premise": (direction or "都市逆袭爽剧") + f" (方向{index})",
    }


async def _run_one(
    job_id: int, idx: int, *,
    direction: str, words: int, episodes: int, mode: str, provider: str, user_id: int,
    sem: asyncio.Semaphore,
):
    """跑单个草稿全流程。任何异常都被吞掉并记到 per_draft, 不影响其它草稿。

    幂等: resume 补跑某个 idx 时, 若该 idx 之前已建过草稿(per_draft[idx].draft_id 存在),
    则复用那个草稿继续跑, 绝不重建。否则(全新 idx)才新建草稿并发散创意。
    这修复了"多次 resume 导致同一个 count 反复新建草稿、草稿数翻倍"的 bug。
    """
    async with sem:
        draft_id = None
        try:
            # 0. 幂等检查: 该 idx 是否已建过草稿?
            existing_draft_id = None
            async with session_scope() as s:
                job = await s.get(AutoBatchJob, job_id)
                if job:
                    pd = list((job.config_json or {}).get("per_draft") or [])
                    if idx < len(pd) and isinstance(pd[idx], dict):
                        existing_draft_id = pd[idx].get("draft_id")
                # 校验该 draft 确实还存在(没被手工删除)
                if existing_draft_id:
                    d = await s.get(ScriptDraft, existing_draft_id)
                    if not d:
                        existing_draft_id = None

            if existing_draft_id:
                # ── 复用已建草稿, 从断点续跑(不重新发散创意、不新建) ──
                draft_id = existing_draft_id
                await _update_per_draft(job_id, idx, step="续跑-检查大纲")
            else:
                # ── 全新 idx: AI 发散创意 + 新建草稿 ──
                await _update_per_draft(job_id, idx, step="构思创意")
                idea = await _invent_idea(direction, idx + 1, provider)
                async with session_scope() as s:
                    row = ScriptDraft(
                        session_id="",
                        user_id=user_id,
                        title=idea["title"],
                        user_input=idea["premise"],
                        model_provider=provider,
                        chapter_word_target=words,
                        episode_count=episodes,
                        status="draft",
                        outline={},
                        auto_generated=True,
                        auto_batch_job_id=job_id,
                    )
                    s.add(row)
                    await s.flush()
                    await s.refresh(row)
                    draft_id = row.id
                await _update_per_draft(job_id, idx, draft_id=draft_id, title=idea["title"], step="生成大纲")
                await _bump_counter(job_id, draft_id=draft_id)

            # 3. 大纲(幂等: 该草稿已有非空大纲则跳过, 避免 resume 重复生成/覆盖)
            async with session_scope() as s:
                d = await s.get(ScriptDraft, draft_id)
                has_outline = bool(d and d.outline and (d.outline.get("chapters")))
                premise = (d.user_input if d else "") or ""
            if not has_outline:
                await _update_per_draft(job_id, idx, step="生成大纲")
                outline = await generate_outline(
                    user_input=premise, chapter_count=episodes,
                    chapter_word_target=words, provider=provider, draft_id=draft_id,
                )
                async with session_scope() as s:
                    d = await s.get(ScriptDraft, draft_id)
                    if d:
                        d.outline = outline
                        d.outline_locked = 1
                        d.status = "outline_locked"
                        if not (d.title or "").strip() and outline.get("title"):
                            d.title = outline["title"]
                        await s.flush()

            # 4. 小说 or 剧本
            if mode == "novel":
                await _update_per_draft(job_id, idx, step="生成小说正文")
                await _drain(batch_generate_chapters(draft_id))
                # 小说完再补剧本? 需求是二选一, 只生成所选。
            else:  # script
                await _update_per_draft(job_id, idx, step="生成剧本")
                await _drain(batch_generate_storyboards(draft_id))

            # 5. 分析 + 打分
            await _update_per_draft(job_id, idx, step="分析打分")
            score = await _analyze_and_score(draft_id)
            await _update_per_draft(job_id, idx, step="完成", score=score)
            await _bump_counter(job_id, finished=True)

        except Exception as e:
            logger.exception("batch_create draft idx=%d (draft_id=%s) failed: %s", idx, draft_id, e)
            await _update_per_draft(job_id, idx, step="失败", error=str(e)[:200])
            await _bump_counter(job_id, failed=True)


async def _analyze_and_score(draft_id: int) -> int | None:
    """新建一次 ScriptAnalysis 并同步跑 run_analysis, 返回 overall_score(0-100)。

    分析结果本身就是"草稿总览页的评分流程"数据, 直接复用。
    """
    # 建分析记录
    async with session_scope() as s:
        analysis = ScriptAnalysis(draft_id=draft_id, scope="full", status="pending")
        s.add(analysis)
        await s.flush()
        await s.refresh(analysis)
        analysis_id = analysis.id
    # 跑分析(内部会把 overall_score 写进该行)
    try:
        await run_analysis(draft_id, analysis_id)
    except Exception as e:
        logger.warning("analyze draft %d failed: %s", draft_id, e)
    # 读回分数
    async with session_scope() as s:
        a = await s.get(ScriptAnalysis, analysis_id)
        return int(a.overall_score) if (a and a.overall_score is not None) else None


async def run_batch(job_id: int, *, resume: bool = False):
    """批次主协程: 并发跑所有草稿, 全部结束后置 job 终态。

    resume=True 时(继续/断点续跑): 跳过 per_draft 里 step=='完成' 的 idx,
    只补跑未完成的(含从未开始的 pending 和被中途打断的半成品)。
    进程重启会打断内存协程, 此时 DB 里 job 会停在 running/partial_failed, 用继续即可补齐。
    """
    async with session_scope() as s:
        job = await s.get(AutoBatchJob, job_id)
        if not job:
            return
        cfg = dict(job.config_json or {})
        job.status = "running"
        if not job.started_at:
            job.started_at = datetime.now(timezone.utc)
        job.finished_at = None
        await s.flush()

    direction = cfg.get("direction") or ""
    count = int(cfg.get("count") or 1)
    words = int(cfg.get("words") or DEFAULT_CHAPTER_WORD_TARGET)
    episodes = int(cfg.get("episodes") or 12)
    mode = cfg.get("mode") or "script"
    provider = cfg.get("provider") or "gemini"
    user_id = int(cfg.get("user_id"))
    # 计费归属: 本函数是后台批量协程(重启恢复路径同样走这里), 无请求上下文, 显式盖一次
    from ..factory.usage import set_usage_context
    set_usage_context(job_id=job_id, user_id=user_id, source="batch_create")

    # 计算要跑哪些 idx: resume 只跑未完成的; 否则全量
    per_draft = list(cfg.get("per_draft") or [])
    done_idx = {i for i, pd in enumerate(per_draft) if isinstance(pd, dict) and pd.get("step") == "完成"}
    if resume:
        todo = [i for i in range(count) if i not in done_idx]
        # 计数器对齐: finished 应等于已完成数, failed 归零(未完成的重跑)
        async with session_scope() as s:
            job = await s.get(AutoBatchJob, job_id)
            if job:
                job.finished_dramas = len(done_idx)
                job.failed_dramas = 0
                await s.flush()
        logger.info("batch_create job %d RESUME: %d/%d 已完成, 补跑 %d 个", job_id, len(done_idx), count, len(todo))
        if not todo:
            # 已全部完成, 直接置终态
            async with session_scope() as s:
                job = await s.get(AutoBatchJob, job_id)
                if job:
                    job.status = "done"
                    job.finished_at = datetime.now(timezone.utc)
                    await s.flush()
            return
    else:
        todo = list(range(count))

    sem = asyncio.Semaphore(MAX_CONCURRENCY)
    tasks = [
        _run_one(job_id, i, direction=direction, words=words, episodes=episodes,
                 mode=mode, provider=provider, user_id=user_id, sem=sem)
        for i in todo
    ]
    try:
        await asyncio.gather(*tasks)
    except Exception as e:
        logger.exception("run_batch gather error: %s", e)

    # 终态
    async with session_scope() as s:
        job = await s.get(AutoBatchJob, job_id)
        if job:
            failed = job.failed_dramas or 0
            total = job.total_dramas or count
            if failed == 0:
                job.status = "done"
            elif failed >= total:
                job.status = "failed"
            else:
                job.status = "partial_failed"
            job.finished_at = datetime.now(timezone.utc)
            await s.flush()
    logger.info("batch_create job %d finished", job_id)