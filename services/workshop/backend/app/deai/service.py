"""去 AI 味引擎: 对整部剧本逐集处理。

流程(单集): 读文本 → 检测 before 分 → (可选)LLM去味改写 → 注入人味瑕疵 → 写回 → 检测 after 分。
剧本(storyboard)与原文(chapter)两套数据都支持: 有剧本改剧本文本, 否则改章节 full_text。
"""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from ..db import session_scope, ScriptDraft, ScriptStoryboard, ScriptChapter
from ..db.models import DeaiJob
from ..models.catalog import sanitize_provider_spec
from ..models.llm import get_llm
from .. import polish  # noqa: F401  确保包已加载
from ..polish.ai_taste import detect_ai_taste, inject_human_flaws, build_deai_prompt
from ..polish.deai_structure import diagnose_structure

logger = logging.getLogger("deai.service")

# 单部剧本内逐集并发上限(避免单 job 打满 KEY; 草稿之间的并发由上层控制)
_EP_CONCURRENCY = 8

#: 对照指标说明。刻意写进 summary 里, 免得用户把分数当"检测平台通过率"去追。
_SCORE_NOTE = "score 为相对指标, 用于同一文本改前/改后对比, 不代表任何检测平台的通过率。"


def _snapshot(text: str) -> dict:
    """只取判定需要的字段(不存整份报告, 免得 per_ep_json 膨胀)。

    存 per_kilo / a_count / b_count / cats 而不只存 score: score 是 0-100 的相对分,
    单独看会误判"分数降了就是去干净了"。密度和命中类别才是能指导下一步改哪里的东西。
    """
    r = detect_ai_taste(text)
    cats: dict[str, int] = {}
    for h in r.hits:
        cats[str(h.code)] = cats.get(str(h.code), 0) + 1
    return {
        "score": r.score,
        "level": r.level,
        "per_kilo": r.a_per_kilo,
        "a_count": r.a_count,
        "b_count": r.b_count,
        "low_confidence": r.low_confidence,
        "cats": cats,
    }


async def _load_episodes(draft_id: int) -> list[tuple[int, str, str]]:
    """返回 [(ep, kind, text)] , kind ∈ {storyboard, chapter}。优先剧本。"""
    out: list[tuple[int, str, str]] = []
    async with session_scope() as s:
        sbs = (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
            .order_by(ScriptStoryboard.chapter_order)
        )).scalars().all()
        if sbs:
            from ..polish.hardcheck import _shots_to_text
            for sb in sbs:
                out.append((int(sb.chapter_order), "storyboard", _shots_to_text(sb.shots_json or [])))
            return out
        chs = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
            .order_by(ScriptChapter.chapter_order)
        )).scalars().all()
        for ch in chs:
            out.append((int(ch.chapter_order), "chapter", ch.full_text or ""))
    return out


# 剧本正文的起始标志: 分镜第一行通常是"出场角色:"或"[场景"或△
_SCRIPT_START = re.compile(r"^\s*(出场角色|[\[【]?场景|△|第[一二三四五六七八九十\d]+集)")


def _strip_llm_preamble(content: str) -> str:
    """去掉模型返回的开场白/客套话(如'这里是为您改写后的剧本：'), 只保留剧本正文。

    策略: 逐行扫描, 丢弃"剧本正文开始"之前的所有解说/客套行; 找不到则退回原样。
    同时去掉包裹的 ``` 代码块围栏。
    """
    if not content:
        return content
    # 去代码块围栏
    lines = content.split("\n")
    lines = [ln for ln in lines if not ln.strip().startswith("```")]
    # 找到第一行像"剧本正文"的位置, 丢弃它之前的所有行
    for i, ln in enumerate(lines):
        if _SCRIPT_START.match(ln):
            return "\n".join(lines[i:]).strip()
    # 没找到分镜起始标志(可能是纯散文剧本): 只去掉明显的开场白首行
    joined = "\n".join(lines).strip()
    for pre in ("改写后：", "改写后:", "【改写后】"):
        if joined.startswith(pre):
            joined = joined[len(pre):].strip()
    # 去掉以"这里是/以下是/好的"等开头且以冒号结尾的第一行客套
    first_nl = joined.find("\n")
    head = joined[:first_nl] if first_nl > 0 else joined
    if re.match(r"^(好的|这里是|以下是|下面是|为您).{0,30}[:：]\s*$", head.strip()):
        joined = joined[first_nl + 1:].lstrip() if first_nl > 0 else ""
    return joined


async def _rewrite_text(text: str, model: str, inject_flaws: bool) -> str:
    """LLM 去味改写。失败则原样返回。"""
    if not text.strip():
        return text
    try:
        # get_llm 第一参数是 role, provider 才是 gemini/deepseek 等; 用高温度让改写更大胆
        provider = sanitize_provider_spec(
            model, ("gemini", "deepseek", "gpt5", "claude", "qwen"), "gemini")
        llm = get_llm("rewrite", temperature=0.85, provider=provider, max_tokens=8192)
        prompt = build_deai_prompt(text, inject_flaws=inject_flaws)
        resp = await llm.ainvoke(prompt)
        content = (getattr(resp, "content", None) or "").strip()
        content = _strip_llm_preamble(content)
        return content or text
    except Exception as e:  # noqa: BLE001
        logger.warning("deai rewrite failed: %s", e)
        return text


# ⚠️ 去 AI 味的结果【绝不覆盖回草稿】: 改写文本只存进 DeaiJob.per_ep_json[ep].rewritten_text,
#   草稿原文/剧本完全不动。用户在工作室里对照查看/自行取用, 不破坏用户数据。


async def _update_job(job_id: int, **fields) -> None:
    async with session_scope() as s:
        job = await s.get(DeaiJob, job_id)
        if not job:
            return
        for k, v in fields.items():
            setattr(job, k, v)
        for jkey in ("per_ep_json", "summary_json"):
            if jkey in fields:
                flag_modified(job, jkey)


async def _is_canceled(job_id: int) -> bool:
    async with session_scope() as s:
        job = await s.get(DeaiJob, job_id)
        return bool(job and job.status == "canceled")


async def run_deai(job_id: int) -> None:
    """执行一个去 AI 味作业。"""
    try:
        async with session_scope() as s:
            job = await s.get(DeaiJob, job_id)
            if not job:
                return
            draft_id = job.draft_id
            rewrite = bool(job.rewrite)
            inject_level = job.inject_level or "light"
            allow_typo = bool(job.allow_typo)
            model = job.model or "gemini"

        eps = await _load_episodes(draft_id)
        total = len(eps)
        per_ep: dict[str, dict] = {}
        await _update_job(job_id, total=total, status="running")
        if total == 0:
            await _update_job(job_id, status="failed", error="该草稿无剧本/原文可处理",
                              finished_at=datetime.now(timezone.utc))
            return

        sem = asyncio.Semaphore(_EP_CONCURRENCY)
        before_scores: list[int] = []
        after_scores: list[int] = []
        before_pk: list[float] = []
        after_pk: list[float] = []
        counters = {"finished": 0, "failed": 0}

        async def _one(ep: int, kind: str, text: str):
            async with sem:
                if await _is_canceled(job_id):
                    return
                try:
                    rep_b = _snapshot(text)
                    new_text = text
                    if rewrite:
                        new_text = await _rewrite_text(text, model, inject_flaws=(inject_level != "none"))
                    # 规则层瑕疵注入(在 LLM 改写之上再叠加确定性瑕疵)
                    if inject_level != "none":
                        new_text = inject_human_flaws(new_text, level=inject_level, allow_typo=allow_typo, seed=ep)
                    rep_a = _snapshot(new_text)
                    # 结构层诊断只对"改后"跑: 词句干净了但段落节奏还是 AI 的, 用户需要看到这一层
                    struct = diagnose_structure(new_text)
                    before_scores.append(rep_b["score"])
                    after_scores.append(rep_a["score"])
                    before_pk.append(rep_b["per_kilo"])
                    after_pk.append(rep_a["per_kilo"])
                    # 结果只存进任务(不写回草稿): 原文 + 改写文本对照
                    per_ep[str(ep)] = {
                        "before_score": rep_b["score"],
                        "after_score": rep_a["score"],
                        "before": rep_b,
                        "after": rep_a,
                        "structure": struct.to_dict(),
                        "status": "完成",
                        "original_text": text[:8000],
                        "rewritten_text": new_text[:8000],
                    }
                    counters["finished"] += 1
                except Exception as e:  # noqa: BLE001
                    logger.warning("deai ep %d failed: %s", ep, e)
                    per_ep[str(ep)] = {"status": "失败", "error": str(e)[:100]}
                    counters["failed"] += 1
                # 每集刷新进度
                await _update_job(
                    job_id, per_ep_json=dict(per_ep),
                    finished=counters["finished"], failed=counters["failed"],
                )

        await asyncio.gather(*[_one(ep, kind, text) for ep, kind, text in eps])

        if await _is_canceled(job_id):
            return
        avg_b = round(sum(before_scores) / len(before_scores), 1) if before_scores else 0
        avg_a = round(sum(after_scores) / len(after_scores), 1) if after_scores else 0
        pk_b = round(sum(before_pk) / len(before_pk), 1) if before_pk else 0
        pk_a = round(sum(after_pk) / len(after_pk), 1) if after_pk else 0
        # 结构层症状按 code 汇总: 用户最该先看的是"通篇还残留哪些结构问题"
        struct_tally: dict[str, int] = {}
        for ep_data in per_ep.values():
            for it in (ep_data.get("structure") or {}).get("issues", []):
                struct_tally[it["code"]] = struct_tally.get(it["code"], 0) + 1
        status = "done" if counters["failed"] == 0 else ("failed" if counters["finished"] == 0 else "done")
        await _update_job(
            job_id, status=status,
            summary_json={
                "avg_before": avg_b, "avg_after": avg_a,
                "per_kilo_before": pk_b, "per_kilo_after": pk_a,
                "structure_tally": struct_tally,
                "note": _SCORE_NOTE,
            },
            per_ep_json=dict(per_ep),
            finished=counters["finished"], failed=counters["failed"],
            finished_at=datetime.now(timezone.utc),
        )
        logger.info("deai job %d done: avg %.1f -> %.1f (每千字 A 级 %.1f -> %.1f) (%d/%d)",
                    job_id, avg_b, avg_a, pk_b, pk_a, counters["finished"], total)
    except Exception as e:  # noqa: BLE001
        logger.exception("deai job %d crashed", job_id)
        await _update_job(job_id, status="failed", error=str(e)[:500],
                          finished_at=datetime.now(timezone.utc))

# =====================================================================
# 写回模式（2026-10-30 起的唯一入口）
# =====================================================================
# 用户裁定：去 AI 味要么**改在原稿里**，要么**按用户要求建副本、改在副本里**；
# 不再出"独立清洗稿 + 去AI味页面下载"那种旁路（上面的 run_deai 只为展示历史作业保留）。
#
# 走作业队列（kind=deai_apply），因此：
#   · 与精修/生成同一把"同草稿串行"的锁，不会和它们并发覆写同一集；
#   · 每集覆写前 snapshot_in 留历史（created_by="ai_deai"，job_id 自动注入），
#     v2 状态栏「看改动」、对话工坊的改前/改后对照、逐集"历史→恢复"全都直接可用；
#   · 关掉页面、重启 worker 都能续上（租约 + 重放）。
#
# 剧本层用 rewrite/parser 的可逆格式（serialize_episode / parse_episode）喂给模型、再拆回结构，
# 拆回后**逐场逐行比对骨架**：场数、每场的场号/时间地点/人物、每行的类型与说话人都必须不变，
# 只允许文字变。对不上就整集跳过、原稿不动，并在结果里写明原因 —— 宁可少改一集，也不把剧本结构改坏。

DEAI_HISTORY_WRITER = "ai_deai"


def _skeleton(shots: list) -> list:
    """剧本骨架：场号/时间地点/人物 + 每行(类型, 说话人, 模式)。去 AI 味只许改文字，骨架必须不变。"""
    from ..rewrite.parser import _scene_elements, _split_name_mode
    out = []
    for sc in shots or []:
        if not isinstance(sc, dict):
            continue
        rows = []
        for e in _scene_elements(sc):
            if e.get("type") == "dialogue":
                nm, md, _ = _split_name_mode(e.get("character", ""), e.get("mode", ""), e.get("action", ""))
                rows.append(("dialogue", nm.strip(), (md or "").strip().upper()))
            else:
                rows.append((str(e.get("type") or "action"), "", ""))
        chars = sc.get("characters") or []
        out.append((str(sc.get("scene_no") or "").strip(), str(sc.get("time_loc") or "").strip(),
                    tuple(str(c).strip() for c in chars if str(c).strip()), tuple(rows)))
    return out


def _skeleton_diff(a: list, b: list) -> str:
    """两份骨架不同时说清第一处差在哪（给用户看的原因）。空串 = 一致。"""
    if len(a) != len(b):
        return f"场次数变了（{len(a)}→{len(b)}）"
    for i, (x, y) in enumerate(zip(a, b), 1):
        if x[:3] != y[:3]:
            return f"第 {i} 场的场号/时间地点/人物被改动"
        if len(x[3]) != len(y[3]):
            return f"第 {i} 场行数变了（{len(x[3])}→{len(y[3])}）"
        for j, (r1, r2) in enumerate(zip(x[3], y[3]), 1):
            if r1 != r2:
                return f"第 {i} 场第 {j} 行的类型或说话人变了"
    return ""


def _merge_texts(orig: list, parsed: list) -> list:
    """把改写后的文字填回**原来的**场次结构：保留原 shots 的全部字段（时长/备注/镜头号等），
    只替换每行的 content 与台词表演提示，再重算派生字段。前提是骨架已比对一致。"""
    import copy
    from ..rewrite.parser import _add_derived, _scene_elements
    new_shots = []
    p_scenes = [s for s in parsed if isinstance(s, dict)]
    for idx, (o, p) in enumerate(zip([s for s in orig if isinstance(s, dict)], p_scenes)):
        sc = copy.deepcopy(o)
        o_els = [dict(e) for e in _scene_elements(o)]
        p_els = p.get("elements") or []
        for oe, pe in zip(o_els, p_els):
            oe["content"] = pe.get("content", oe.get("content", ""))
            if oe.get("type") == "dialogue" and pe.get("action") is not None:
                oe["action"] = pe.get("action", "")
        sc["elements"] = o_els
        _add_derived(sc, idx)
        new_shots.append(sc)
    return new_shots


async def _deai_one_text(text: str, *, kind: str, model: str, inject_level: str, allow_typo: bool, seed: int) -> str:
    provider = sanitize_provider_spec(model, ("gemini", "deepseek", "gpt5", "claude", "qwen", "grok"), "gemini")
    # max_tokens 按原文给足：此前写死 8192、结果再截 8000 字，长集会被静默截断
    llm = get_llm("rewrite", temperature=0.85, provider=provider, max_tokens=max(8192, len(text) * 3))
    resp = await llm.ainvoke(build_deai_prompt(text, inject_flaws=(inject_level != "none"), kind=kind))
    out = _strip_llm_preamble((getattr(resp, "content", None) or "").strip())
    if inject_level != "none" and out:
        out = inject_human_flaws(out, level=inject_level, allow_typo=allow_typo, seed=seed)
    return out


async def run_deai_apply(*, job_id: int, draft_id: int, model: str = "gemini", inject_level: str = "light",
                         allow_typo: bool = True, start_ep: int = 0, end_ep: int = 0,
                         layer: str | None = None) -> dict:
    """对草稿逐集去 AI 味并**写回草稿本身**（副本模式下 draft_id 就是副本）。返回结果摘要。

    layer：用户选的层（"storyboard" 剧本 / "chapter" 正文）。选了就只改那一层，那层没有内容就报错，
    **绝不悄悄换层**（与精修同一条裁定）。不传 = 有剧本改剧本，没有剧本改正文。"""
    import hashlib
    import json as _json

    from ..agent import jobs
    from ..rewrite.parser import parse_episode, serialize_episode
    from ..stages.candidate_store import snapshot_in

    def _fp(x) -> str:
        return hashlib.md5(_json.dumps(x, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()

    lo, hi = int(start_ep or 0) or 1, int(end_ep or 0) or 10 ** 6
    async with session_scope() as s:
        sbs = (await s.execute(select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
                               .order_by(ScriptStoryboard.chapter_order))).scalars().all()
        has_sb = any(sb.shots_json for sb in sbs)
        if layer not in ("storyboard", "chapter"):
            layer = "storyboard" if has_sb else "chapter"
        if layer == "storyboard":
            eps = [(int(sb.chapter_order), sb.shots_json or []) for sb in sbs
                   if sb.shots_json and lo <= int(sb.chapter_order) <= hi]
        else:
            chs = (await s.execute(select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
                                   .order_by(ScriptChapter.chapter_order))).scalars().all()
            eps = [(int(c.chapter_order), c.full_text or "") for c in chs
                   if (c.full_text or "").strip() and lo <= int(c.chapter_order) <= hi]
    if not eps:
        name = "剧本" if layer == "storyboard" else "正文"
        raise ValueError(f"这部草稿在所选范围内没有{name}可处理（去 AI 味不会改用另一层）")

    total = len(eps)
    applied: list[int] = []
    skipped: list[dict] = []
    pk_before: list[float] = []
    pk_after: list[float] = []
    done = {"n": 0}
    sem = asyncio.Semaphore(_EP_CONCURRENCY)

    async def _one(ep: int, orig) -> None:
        async with sem:
            if await jobs.is_canceled(job_id):
                return
            try:
                if layer == "storyboard":
                    src = serialize_episode(orig, ep=ep)
                    out = await _deai_one_text(src, kind="script", model=model, inject_level=inject_level,
                                               allow_typo=allow_typo, seed=ep)
                    parsed = parse_episode(out) if out.strip() else []
                    why = "模型没有返回内容" if not parsed else _skeleton_diff(_skeleton(orig), _skeleton(parsed))
                    if why:
                        skipped.append({"ep": ep, "reason": f"改写结果{why}，为保护剧本结构未写回"})
                        return
                    new_val = _merge_texts(orig, parsed)
                    before_t, after_t = src, serialize_episode(new_val, ep=ep)
                else:
                    out = await _deai_one_text(orig, kind="chapter", model=model, inject_level=inject_level,
                                               allow_typo=allow_typo, seed=ep)
                    n0, n1 = len(orig.strip()), len(out.strip())
                    if not n1 or not (0.6 * n0 <= n1 <= 1.6 * n0):
                        skipped.append({"ep": ep, "reason": f"改写后字数 {n1} 与原文 {n0} 相差过大，未写回"})
                        return
                    new_val, before_t, after_t = out, orig, out
                if before_t.strip() == after_t.strip():
                    skipped.append({"ep": ep, "reason": "没有需要改的地方"})
                    return
                # 写回：锁行 + 读时指纹比对。改写期间这一集被用户手改过 → 不覆盖用户的改动
                async with session_scope() as s:
                    if layer == "storyboard":
                        row = (await s.execute(select(ScriptStoryboard).where(
                            ScriptStoryboard.draft_id == draft_id, ScriptStoryboard.chapter_order == ep)
                            .with_for_update())).scalars().first()
                        cur = row.shots_json if row else None
                    else:
                        row = (await s.execute(select(ScriptChapter).where(
                            ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == ep)
                            .with_for_update())).scalars().first()
                        cur = row.full_text if row else None
                    if row is None or _fp(cur) != _fp(orig):
                        skipped.append({"ep": ep, "reason": "处理期间这一集被修改过，为不覆盖你的改动未写回"})
                        return
                    await snapshot_in(s, draft_id=draft_id, order=ep, stage=layer,
                                      content=(cur if layer == "storyboard" else {"full_text": cur}),
                                      version=int(row.version or 1), created_by=DEAI_HISTORY_WRITER)
                    if layer == "storyboard":
                        row.shots_json = new_val
                        flag_modified(row, "shots_json")
                    else:
                        row.full_text = new_val
                        row.word_count = len(new_val)
                    row.version = int(row.version or 1) + 1
                pk_before.append(detect_ai_taste(before_t).a_per_kilo)
                pk_after.append(detect_ai_taste(after_t).a_per_kilo)
                applied.append(ep)
            except Exception as e:  # noqa: BLE001
                logger.warning("deai_apply 草稿 %s 第 %s 集失败: %s", draft_id, ep, e)
                skipped.append({"ep": ep, "reason": f"处理出错：{str(e)[:120]}"})
            finally:
                done["n"] += 1
                await jobs.set_progress(job_id, progress=int(95 * done["n"] / total),
                                        note=f"去 AI 味 {done['n']}/{total} 集（已改 {len(applied)} 集）")

    await asyncio.gather(*[_one(ep, orig) for ep, orig in eps])
    avg = lambda xs: round(sum(xs) / len(xs), 1) if xs else 0  # noqa: E731
    return {
        "draft_id": draft_id, "layer": layer, "total": total,
        "applied_eps": sorted(applied), "applied": len(applied),
        "skipped": sorted(skipped, key=lambda x: x["ep"]),
        "per_kilo_before": avg(pk_before), "per_kilo_after": avg(pk_after),
        "canceled": await jobs.is_canceled(job_id),
        "note": _SCORE_NOTE,
    }


async def copy_draft_for_deai(source_draft_id: int, user_id: int) -> int:
    """建一份完整副本（大纲 + 正文 + 剧本），返回新草稿 id。原稿不动，副本记 parent_draft_id。"""
    async with session_scope() as s:
        src = await s.get(ScriptDraft, source_draft_id)
        if not src:
            raise ValueError(f"草稿 {source_draft_id} 不存在")
        nd = ScriptDraft(
            user_id=user_id, session_id=None,
            title=(src.title or "未命名") if (src.title or "").endswith("（去AI味副本）") else f"{src.title or '未命名'}（去AI味副本）",
            user_input=src.user_input, outline=src.outline, original_outline=src.original_outline,
            outline_locked=src.outline_locked, status=src.status, episode_count=src.episode_count,
            model_provider=src.model_provider, chapter_word_target=src.chapter_word_target,
            parent_draft_id=src.id, source_oss_key=src.source_oss_key,
            cover_url=src.cover_url, story_bible_json=src.story_bible_json,
        )
        s.add(nd)
        await s.flush()
        new_id = nd.id
        for ch in (await s.execute(select(ScriptChapter).where(ScriptChapter.draft_id == source_draft_id))).scalars():
            s.add(ScriptChapter(draft_id=new_id, chapter_order=ch.chapter_order, title=ch.title, summary=ch.summary,
                                full_text=ch.full_text, word_count=ch.word_count, locked=ch.locked,
                                is_stale=ch.is_stale, version=1, auto_checks=ch.auto_checks))
        for sb in (await s.execute(select(ScriptStoryboard).where(ScriptStoryboard.draft_id == source_draft_id))).scalars():
            s.add(ScriptStoryboard(draft_id=new_id, chapter_order=sb.chapter_order, shots_json=sb.shots_json,
                                   locked=sb.locked, is_stale=sb.is_stale, version=1))
    logger.info("deai copy: draft %s -> %s (user %s)", source_draft_id, new_id, user_id)
    return new_id
