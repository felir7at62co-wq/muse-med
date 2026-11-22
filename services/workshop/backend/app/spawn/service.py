"""DNA 裂变工厂 — 执行引擎。

## 两段式裂变(默认, stage=preview)

  第一段 run_spawn(job_id):
    1. 读原作 outline(+章节摘要) → LLM 提取「爆款 DNA」(缓存进 job.dna_json)
    2. LLM 基于 DNA + 用户意图 → 规划出 count 个各具新意的裂变方向
    3. 并发为每个方向生成**预览**(故事圣经 + 全剧设定 + 前 N 集), 落成 spawn_preview 草稿
    4. job.status=preview_ready → 停在这里等人工确认

  人工环节(routes 提供): 查看/编辑圣经与前 N 集 · 提意见让 AI 重出 · 弃用某方向

  第二段 run_expand(job_id, indices):
    5. 以(可能已被用户改过的)预览为基线, 续跑到全集 + 一致性校验, 原地更新同一草稿

  好处: 3 方向 × 60 集一次性跑完约 44 次 LLM 调用; 两段式在第一段只花约 1/6,
  方向不对可以立刻砍掉或改, 不必等全量跑完。

## 一步到位(stage=legacy, two_stage=false)

  保留原行为: DNA → 方向 → 每方向直接跑完整 generate_outline_pipeline。

与旧「换皮改编」的本质区别: 每个新作都是"重新创作"的, 不锁原作集数/节拍/场次。
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from ..db import session_scope, ScriptChapter, ScriptDraft
from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from ..models.catalog import sanitize_provider_spec
from ..models.llm import get_llm
from ..stages.adaptation import _extract_json  # 复用健壮 JSON 解析
from ..stages.outline_gen import (
    expand_outline_from_preview,
    generate_outline_pipeline,
    generate_outline_preview,
)
from ..stages.story_bible import bible_text
from .models import SpawnJob
from .prompts import (
    build_extract_dna_prompt,
    build_plan_variants_prompt,
    build_variant_brief,
    normalize_variants,
)

logger = logging.getLogger("spawn.service")

# 单个裂变作业内并发生成的方向数上限(移除限制, 让所有方向并发生成以加速)
_VARIANT_CONCURRENCY = 100
# 裂变新作默认集数(大纲级); 沿用原作集数, 但夹在合理区间
_MIN_EPS, _MAX_EPS = 6, 60
# 预览草稿状态(与 outline_done 区分, 便于草稿列表过滤半成品)
PREVIEW_STATUS = "spawn_preview"


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _update_job(job_id: int, **fields) -> None:
    async with session_scope() as s:
        job = await s.get(SpawnJob, job_id)
        if not job:
            return
        for k, v in fields.items():
            setattr(job, k, v)
        for jkey in ("dna_json", "variants_json"):
            if jkey in fields:
                flag_modified(job, jkey)


async def _is_canceled(job_id: int) -> bool:
    async with session_scope() as s:
        job = await s.get(SpawnJob, job_id)
        return bool(job and job.status == "canceled")


async def _load_source(draft_id: int) -> tuple[dict, list[dict], str, int, int]:
    """读原作 outline + 章节摘要 + provider + 集数。"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise ValueError("原作草稿不存在")
        outline = dict(d.outline or {})
        provider = d.model_provider or "gemini"
        ep_count = int(d.episode_count or len(outline.get("chapters") or []) or 24)
        word_target = int(d.chapter_word_target or DEFAULT_CHAPTER_WORD_TARGET)
        rows = (await s.execute(
            select(ScriptChapter)
            .where(ScriptChapter.draft_id == draft_id)
            .order_by(ScriptChapter.chapter_order)
        )).scalars().all()
        summaries = [
            {"chapter_order": r.chapter_order, "summary": r.summary or ""}
            for r in rows
        ]
    return outline, summaries, provider, ep_count, word_target


def _usage_of(resp) -> dict:
    """从 LLM 响应里抠 token usage(两种 metadata 形态都兼容)。"""
    if hasattr(resp, "usage_metadata") and resp.usage_metadata:
        return {
            "prompt_tokens": getattr(resp.usage_metadata, "input_tokens", 0),
            "completion_tokens": getattr(resp.usage_metadata, "output_tokens", 0),
            "total_tokens": getattr(resp.usage_metadata, "total_tokens", 0),
        }
    if hasattr(resp, "response_metadata") and resp.response_metadata:
        u = resp.response_metadata.get("token_usage", {})
        return {
            "prompt_tokens": u.get("prompt_tokens", 0),
            "completion_tokens": u.get("completion_tokens", 0),
            "total_tokens": u.get("total_tokens", 0),
        }
    return {}


async def _extract_dna(outline: dict, summaries: list[dict], provider: str) -> tuple[dict, dict]:
    """提取 DNA，返回 (dna, usage)"""
    prompt = build_extract_dna_prompt(outline=outline, chapter_summaries=summaries)
    llm = get_llm("generate", temperature=0.4, provider=provider)
    resp = await llm.ainvoke(prompt)
    text = getattr(resp, "content", "") if resp else ""
    dna = _extract_json(text)
    if not isinstance(dna, dict):
        raise ValueError("DNA 提炼输出非对象")
    return dna, _usage_of(resp)


async def _plan_variants(
    dna: dict, count: int, mode: str, intent: str, provider: str
) -> tuple[list[dict], dict]:
    """规划裂变方向，返回 (variants, usage)"""
    prompt = build_plan_variants_prompt(dna=dna, count=count, mode=mode, intent=intent)
    # 高温度让方向更发散, 各具新意
    llm = get_llm("generate", temperature=0.9, provider=provider)
    resp = await llm.ainvoke(prompt)
    text = getattr(resp, "content", "") if resp else ""
    try:
        raw = _extract_json(text)
    except Exception:  # noqa: BLE001
        raw = None
    return normalize_variants(raw, count), _usage_of(resp)


# ---------------------------------------------------------------------------
# variant 摘要: 把大纲里值得在卡片上"试读"的信息抽出来存进 variants_json
# (卡片以前只显示 30 字的 pitch —— 那是策划期的一句话卖点, 不是大纲内容)
# ---------------------------------------------------------------------------

def _variant_digest(outline: dict, preview_n: int) -> dict:
    chapters = outline.get("chapters") or []
    return {
        "title": (outline.get("title") or "").strip(),
        "synopsis": (outline.get("synopsis") or "").strip(),
        "world": outline.get("world") or {},
        "characters": [
            {"name": c.get("name", ""), "role": c.get("role", ""),
             "traits": list(c.get("traits") or [])[:3]}
            for c in (outline.get("characters") or [])[:8]
        ],
        "preview_chapters": [
            {"order": c.get("order"), "title": c.get("title", ""),
             "synopsis": c.get("synopsis", "")}
            for c in chapters[:preview_n]
        ],
        "lint": (outline.get("lint_report") or {}).get("summary") or {"error": 0, "warn": 0},
    }


def _spawn_meta(*, source_draft_id: int, mode: str, variant: dict, job_id: int) -> dict:
    return {
        "is_spawn": True,
        "source_draft_id": source_draft_id,
        "spawn_job_id": job_id,
        "mode": mode,
        "angle": variant.get("angle", ""),
        "pitch": variant.get("pitch", ""),
        "genre": variant.get("genre", ""),
        "twist": variant.get("twist", ""),
    }


async def _create_placeholder_draft(
    *, user_id: int, source_draft_id: int, variant: dict, mode: str,
    provider: str, eps: int, word_target: int, brief: str, job_id: int,
) -> int:
    """先落一条空壳草稿拿 draft_id —— 这样预览生成过程的日志能落库(可在草稿页看进度)。"""
    async with session_scope() as s:
        d = ScriptDraft(
            user_id=user_id,
            session_id=None,
            title=(variant.get("angle") or "裂变新作").strip(),
            user_input=brief,
            outline={"spawn": _spawn_meta(
                source_draft_id=source_draft_id, mode=mode, variant=variant, job_id=job_id)},
            outline_locked=0,
            status=PREVIEW_STATUS,
            episode_count=eps,
            is_favorite=False,
            is_deleted=False,
            preview_batch_running=0,
            model_provider=provider,
            parent_draft_id=source_draft_id,
            chapter_word_target=word_target,
        )
        s.add(d)
        await s.flush()
        return d.id


async def _drop_draft(draft_id: int) -> None:
    """生成失败时软删占位草稿 —— 别在草稿列表里留一堆空壳。"""
    try:
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            if d:
                d.is_deleted = True
                d.status = "failed"
    except Exception:  # noqa: BLE001
        logger.warning("清理占位草稿 %s 失败", draft_id, exc_info=True)


async def _write_outline(draft_id: int, outline: dict, *, status: str, title: str) -> None:
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return
        # 保留已有的 spawn 元数据(创建占位草稿时写入的)
        meta = (d.outline or {}).get("spawn")
        ol = dict(outline)
        if meta:
            ol["spawn"] = meta
        d.outline = ol
        d.status = status
        if title:
            d.title = title
        flag_modified(d, "outline")


# ===========================================================================
# 第一段: DNA → 方向 → 预览(或 legacy 全量)
# ===========================================================================

async def _preview_one(
    *, user_id: int, source_draft_id: int, job_id: int, dna: dict, variant: dict,
    mode: str, intent: str, provider: str, ep_count: int, word_target: int,
    preview_episodes: int,
) -> dict:
    """为一个方向生成预览(圣经 + 前 N 集), 落成 spawn_preview 草稿。"""
    brief = build_variant_brief(dna=dna, variant=variant, mode=mode, intent=intent)
    eps = max(_MIN_EPS, min(ep_count, _MAX_EPS))
    did = await _create_placeholder_draft(
        user_id=user_id, source_draft_id=source_draft_id, variant=variant, mode=mode,
        provider=provider, eps=eps, word_target=word_target, brief=brief, job_id=job_id,
    )
    try:
        outline = await generate_outline_preview(
            brief, chapter_count=eps, preview_episodes=preview_episodes,
            provider=provider, draft_id=did,
        )
    except Exception:
        await _drop_draft(did)   # 别在草稿列表里留空壳
        raise
    title = (outline.get("title") or variant.get("angle") or "裂变新作").strip()
    await _write_outline(did, outline, status=PREVIEW_STATUS, title=title)
    return {"draft_id": did, "episode_count": eps,
            **_variant_digest(outline, preview_episodes)}


async def _spawn_one_draft(
    *, user_id: int, source_draft_id: int, job_id: int, dna: dict, variant: dict,
    mode: str, intent: str, provider: str, ep_count: int, word_target: int = DEFAULT_CHAPTER_WORD_TARGET,
) -> dict:
    """legacy 一步到位: 为一个方向生成完整大纲并落成新草稿。"""
    brief = build_variant_brief(dna=dna, variant=variant, mode=mode, intent=intent)
    eps = max(_MIN_EPS, min(ep_count, _MAX_EPS))
    did = await _create_placeholder_draft(
        user_id=user_id, source_draft_id=source_draft_id, variant=variant, mode=mode,
        provider=provider, eps=eps, word_target=word_target, brief=brief, job_id=job_id,
    )
    try:
        outline = await generate_outline_pipeline(
            brief, chapter_count=eps, provider=provider, draft_id=did, run_lint=True,
        )
    except Exception:
        await _drop_draft(did)
        raise
    title = (outline.get("title") or variant.get("angle") or "裂变新作").strip()
    await _write_outline(did, outline, status="outline_done", title=title)
    return {"draft_id": did, "episode_count": eps, **_variant_digest(outline, 3)}


async def run_spawn(job_id: int) -> None:
    """执行一个裂变作业的第一段(两段式则停在预览待确认)。"""
    try:
        async with session_scope() as s:
            job = await s.get(SpawnJob, job_id)
            if not job:
                return
            user_id = job.user_id
            source_draft_id = job.source_draft_id
            mode = job.mode or "homage"
            intent = job.intent or ""
            model = job.model or "gemini"
            count = int(job.count or 3)
            stage = job.stage or "legacy"
            preview_n = int(job.preview_episodes or 3)
            cached_dna = dict(job.dna_json or {})
            # 用户自定义字数(来自 SubmitBody.word_target, 存在 dna_json._word_target):
            # 取出后从 cached_dna 中移除, 避免"仅含 _word_target 的 dna_json"被误判为已缓存 DNA 而跳过提取
            user_word_target = int(cached_dna.pop("_word_target", 0) or 0)

        two_stage = stage != "legacy"
        await _update_job(job_id, status="running", started_at=_now(), total=count)

        # 1) 读原作
        try:
            outline, summaries, src_provider, ep_count, word_target = await _load_source(source_draft_id)
        except Exception as e:  # noqa: BLE001
            await _update_job(job_id, status="failed", error=f"读取原作失败: {e}",
                              finished_at=_now())
            return
        # 用户在裂变弹窗自定义的字数优先级高于继承原作的设置
        if user_word_target > 0:
            word_target = user_word_target
        provider = sanitize_provider_spec(
            model, ("gemini", "deepseek", "gpt5"), src_provider)

        if not (outline.get("chapters") or summaries):
            await _update_job(job_id, status="failed",
                              error="原作尚无大纲或章节, 无法提取裂变 DNA", finished_at=_now())
            return

        # 2) 提取 DNA(有缓存则复用)
        dna = cached_dna
        tok = {"total": 0, "prompt": 0, "completion": 0}

        if not dna:
            try:
                dna, usage = await _extract_dna(outline, summaries, provider)
                tok["total"] += usage.get("total_tokens", 0)
                tok["prompt"] += usage.get("prompt_tokens", 0)
                tok["completion"] += usage.get("completion_tokens", 0)
                await _update_job(
                    job_id, dna_json=dna, total_tokens=tok["total"],
                    prompt_tokens=tok["prompt"], completion_tokens=tok["completion"],
                )
            except Exception as e:  # noqa: BLE001
                logger.exception("spawn %d: DNA 提取失败", job_id)
                await _update_job(job_id, status="failed", error=f"DNA 提取失败: {e}",
                                  finished_at=_now())
                return

        if await _is_canceled(job_id):
            return

        # 3) 规划裂变方向
        try:
            variants, usage = await _plan_variants(dna, count, mode, intent, provider)
            tok["total"] += usage.get("total_tokens", 0)
            tok["prompt"] += usage.get("prompt_tokens", 0)
            tok["completion"] += usage.get("completion_tokens", 0)
            await _update_job(
                job_id, total_tokens=tok["total"], prompt_tokens=tok["prompt"],
                completion_tokens=tok["completion"],
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("spawn %d: 方向规划失败", job_id)
            await _update_job(job_id, status="failed", error=f"裂变方向规划失败: {e}",
                              finished_at=_now())
            return

        # 初始化 variants_json(全部"排队中"; 占位方向直接判失败, 不浪费一整条管线)
        per: dict[str, dict] = {}
        for i, v in enumerate(variants):
            ph = bool(v.get("_placeholder"))
            per[str(i)] = {
                "idx": i,
                "angle": v.get("angle", ""),
                "pitch": v.get("pitch", ""),
                "genre": v.get("genre", ""),
                "twist": v.get("twist", ""),
                "status": "失败" if ph else "排队中",
                "draft_id": None,
                "new_draft_id": None,   # 兼容旧前端
                "title": "",
                "synopsis": "",
                "characters": [],
                "preview_chapters": [],
                "episode_count": 0,
                "lint": {"error": 0, "warn": 0},
                "error": "方向规划输出不足, 已跳过(未消耗大纲生成)" if ph else "",
            }
        await _update_job(job_id, variants_json=dict(per))

        # 4) 并发生成每个方向(预览 或 legacy 全量)
        sem = asyncio.Semaphore(_VARIANT_CONCURRENCY)
        counters = {"finished": 0, "failed": sum(1 for v in variants if v.get("_placeholder"))}
        lock = asyncio.Lock()

        async def _one(i: int, variant: dict):
            if variant.get("_placeholder"):
                return
            async with sem:
                if await _is_canceled(job_id):
                    return
                per[str(i)]["status"] = "预览生成中" if two_stage else "生成中"
                await _update_job(job_id, variants_json=dict(per))
                try:
                    kw = dict(
                        user_id=user_id, source_draft_id=source_draft_id, job_id=job_id,
                        dna=dna, variant=variant, mode=mode, intent=intent,
                        provider=provider, ep_count=ep_count, word_target=word_target,
                    )
                    r = (await _preview_one(**kw, preview_episodes=preview_n)
                         if two_stage else await _spawn_one_draft(**kw))
                    per[str(i)].update({
                        "status": "待确认" if two_stage else "完成",
                        "draft_id": r["draft_id"],
                        "new_draft_id": r["draft_id"],
                        "title": r["title"],
                        "synopsis": r["synopsis"],
                        "world": r.get("world") or {},
                        "characters": r["characters"],
                        "preview_chapters": r["preview_chapters"],
                        "episode_count": r["episode_count"],
                        "lint": r["lint"],
                    })
                    counters["finished"] += 1
                except Exception as e:  # noqa: BLE001
                    logger.exception("spawn %d: 方向 %d 生成失败", job_id, i)
                    per[str(i)].update({"status": "失败", "error": str(e)[:200]})
                    counters["failed"] += 1

                async with lock:
                    async with session_scope() as s:
                        j = await s.get(SpawnJob, job_id)
                        if j:
                            j.finished = counters["finished"]
                            j.failed = counters["failed"]
                            j.variants_json = dict(per)
                            flag_modified(j, "variants_json")

        await asyncio.gather(*[_one(i, v) for i, v in enumerate(variants)])

        if await _is_canceled(job_id):
            return

        if counters["finished"] == 0:
            status, new_stage = "failed", stage
        elif two_stage:
            # 停在预览: 等用户确认/编辑后再调 run_expand
            status, new_stage = "preview_ready", "preview"
        else:
            status = "partial_failed" if counters["failed"] > 0 else "done"
            new_stage = "legacy"
        await _update_job(
            job_id, status=status, stage=new_stage, variants_json=dict(per),
            finished=counters["finished"], failed=counters["failed"],
            finished_at=None if status == "preview_ready" else _now(),
        )
        logger.info("spawn job %d stage-1 done: %d/%d (%s/%s)", job_id,
                    counters["finished"], count, status, new_stage)
    except Exception as e:  # noqa: BLE001
        logger.exception("spawn job %d crashed", job_id)
        await _update_job(job_id, status="failed", error=str(e)[:500], finished_at=_now())


# ===========================================================================
# 第二段: 把确认过的预览展开成全集
# ===========================================================================

async def run_expand(job_id: int, indices: list[int] | None = None) -> None:
    """把指定方向(默认全部"待确认")的预览展开成全集大纲。

    基线取自草稿当前的 outline —— 用户在预览阶段对故事圣经/主线/前 N 集的任何
    修改都已经写回草稿, 因此会成为后续所有批次的硬约束。
    """
    try:
        async with session_scope() as s:
            job = await s.get(SpawnJob, job_id)
            if not job:
                return
            per = dict(job.variants_json or {})
            model = job.model or "gemini"
            src_id = job.source_draft_id

        targets = [
            k for k, v in per.items()
            if v.get("status") == "待确认"
            and v.get("draft_id")
            and (indices is None or int(v.get("idx", -1)) in set(indices))
        ]
        if not targets:
            await _update_job(job_id, status="done", stage="done", finished_at=_now())
            return

        async with session_scope() as s:
            d = await s.get(ScriptDraft, src_id)
            src_provider = (d.model_provider if d else None) or "gemini"
        provider = sanitize_provider_spec(
            model, ("gemini", "deepseek", "gpt5"), src_provider)

        await _update_job(job_id, status="running", stage="expanding")

        sem = asyncio.Semaphore(_VARIANT_CONCURRENCY)
        counters = {"ok": 0, "failed": 0}
        lock = asyncio.Lock()

        async def _one(key: str):
            async with sem:
                if await _is_canceled(job_id):
                    return
                v = per[key]
                did = int(v["draft_id"])
                per[key]["status"] = "展开中"
                await _update_job(job_id, variants_json=dict(per))
                try:
                    async with session_scope() as s:
                        d = await s.get(ScriptDraft, did)
                        if not d:
                            raise ValueError("预览草稿不存在(可能已被删除)")
                        base = dict(d.outline or {})
                        eps = int(d.episode_count or v.get("episode_count") or 24)
                    outline = await expand_outline_from_preview(
                        base, chapter_count=eps, provider=provider,
                        draft_id=did, run_lint=True,
                    )
                    title = (outline.get("title") or v.get("title") or "裂变新作").strip()
                    await _write_outline(did, outline, status="outline_done", title=title)
                    per[key].update({
                        "status": "完成",
                        "episode_count": len(outline.get("chapters") or []),
                        "lint": (outline.get("lint_report") or {}).get("summary")
                                or {"error": 0, "warn": 0},
                        "synopsis": (outline.get("synopsis") or v.get("synopsis") or "").strip(),
                        "title": title,
                    })
                    counters["ok"] += 1
                except Exception as e:  # noqa: BLE001
                    logger.exception("spawn %d: 方向 %s 展开失败", job_id, key)
                    per[key].update({"status": "失败", "error": str(e)[:200]})
                    counters["failed"] += 1

                async with lock:
                    async with session_scope() as s:
                        j = await s.get(SpawnJob, job_id)
                        if j:
                            j.variants_json = dict(per)
                            flag_modified(j, "variants_json")

        await asyncio.gather(*[_one(k) for k in targets])

        if await _is_canceled(job_id):
            return

        done_n = sum(1 for v in per.values() if v.get("status") == "完成")
        fail_n = sum(1 for v in per.values() if v.get("status") == "失败")
        pending = sum(1 for v in per.values() if v.get("status") == "待确认")
        if counters["ok"] == 0:
            status, new_stage = "failed", "preview"
        elif pending:
            # 还有没展开的方向, 保持在预览阶段供用户继续处理
            status, new_stage = "preview_ready", "preview"
        else:
            status = "partial_failed" if fail_n else "done"
            new_stage = "done"
        await _update_job(
            job_id, status=status, stage=new_stage, variants_json=dict(per),
            finished=done_n, failed=fail_n,
            finished_at=None if status == "preview_ready" else _now(),
        )
        logger.info("spawn job %d expand done: ok=%d failed=%d (%s)",
                    job_id, counters["ok"], counters["failed"], status)
    except Exception as e:  # noqa: BLE001
        logger.exception("spawn job %d expand crashed", job_id)
        await _update_job(job_id, status="failed", error=str(e)[:500], finished_at=_now())


# ===========================================================================
# 预览精修: 按用户意见重出某个方向的预览
# ===========================================================================

_REFINE_PROMPT = """你是资深短剧编剧总策划。下面是一部新剧的**故事圣经与前 {n} 集大纲**,
用户对它提出了修改意见。请据此重出一版, 保持结构完整、前后自洽。

## 当前故事圣经
{bible_block}

## 当前全剧设定
标题: {title}
主线: {synopsis}

## 当前前 {n} 集
{chapters_block}

## 用户修改意见(硬约束, 必须落实)
{feedback}

## 输出格式(严格 JSON, 不要 Markdown 包装、不要解释)
{{
  "title": "全剧标题",
  "synopsis": "全剧一句话主线(30-60字)",
  "world": {{"era": "", "setting": "", "rules": []}},
  "characters": [{{"name":"","role":"","traits":[],"appearance":""}}],
  "chapters": [{{"order":1,"title":"","synopsis":"本集100-200字概要","must_have":[],"characters":[]}}]
}}

## 必须满足
- chapters 正好 {n} 集, order 从 1 连续到 {n}
- 落实用户意见, 未提及的部分尽量保持原样
- 只输出 JSON 对象
"""


async def refine_preview(draft_id: int, feedback: str, provider: str = "gemini") -> dict:
    """按用户意见重出一版预览(圣经保持, 重写设定与前 N 集), 就地写回草稿。"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise ValueError("预览草稿不存在")
        base = dict(d.outline or {})
        prov = d.model_provider or provider

    chapters = base.get("chapters") or []
    n = max(1, len(chapters))
    ch_block = "\n".join(
        f"第{c.get('order')}集《{c.get('title','')}》: {c.get('synopsis','')}"
        for c in chapters
    ) or "(无)"

    prompt = _REFINE_PROMPT.format(
        n=n,
        bible_block=bible_text(base.get("story_bible") or {}) or "(无)",
        title=base.get("title", ""),
        synopsis=base.get("synopsis", ""),
        chapters_block=ch_block,
        feedback=(feedback or "").strip() or "(无具体意见, 请整体优化)",
    )
    llm = get_llm("generate", temperature=0.8, provider=prov)
    resp = await llm.ainvoke(prompt)
    data = _extract_json(getattr(resp, "content", "") or "")
    if not isinstance(data, dict):
        raise ValueError("精修输出非对象")

    out = dict(base)
    if str(data.get("title", "")).strip():
        out["title"] = str(data["title"]).strip()
    if str(data.get("synopsis", "")).strip():
        out["synopsis"] = str(data["synopsis"]).strip()
    if isinstance(data.get("world"), dict):
        out["world"] = data["world"]
    chars = [
        {"name": str(c.get("name", "")).strip(), "role": str(c.get("role", "")).strip(),
         "traits": list(c.get("traits") or []), "appearance": str(c.get("appearance", "")).strip()}
        for c in (data.get("characters") or [])
        if isinstance(c, dict) and str(c.get("name", "")).strip()
    ]
    if chars:
        out["characters"] = chars
    new_chs = []
    for idx, c in enumerate(data.get("chapters") or []):
        if not isinstance(c, dict):
            continue
        new_chs.append({
            "order": idx + 1,
            "title": str(c.get("title", f"第{idx+1}集")).strip(),
            "synopsis": str(c.get("synopsis", "")).strip(),
            "must_have": list(c.get("must_have") or []),
            "characters": list(c.get("characters") or []),
        })
    if new_chs:
        out["chapters"] = new_chs[:n]

    await _write_outline(draft_id, out, status=PREVIEW_STATUS, title=out.get("title", ""))
    return out


__all__ = ["run_spawn", "run_expand", "refine_preview", "PREVIEW_STATUS"]
