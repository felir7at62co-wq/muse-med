"""分析任务编排器(4 步串行+并行)

入口: run_analysis(draft_id, analysis_id) - 后台 task 调用

流程:
  Step 1: compute_metrics (秒级)
  Step 2: 整体评估 (1 次 gemini)
  Step 3: 爆点扫描 (每章 1 次 deepseek, 并发 ≤ 3)
  Step 4: 风险+建议 (1 次 gemini)
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime
from typing import Any

from sqlalchemy import select

from ..db import ScriptAnalysis, ScriptChapter, ScriptDraft, ScriptStoryboard, session_scope
from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from ..models.llm import get_llm
from .metrics import compute_metrics
from .prompts import HOOKS_PROMPT, OVERALL_PROMPT, RISKS_AND_SUGGESTIONS_PROMPT, DIAGNOSIS_REPORT_PROMPT

logger = logging.getLogger("analysis.analyzer")


# ---------------------------------------------------------------------------
# JSON 解析工具(复用 ai_review 的思路)
# ---------------------------------------------------------------------------
def _extract_json(text: str, expect_array: bool = False) -> Any:
    if not text:
        raise ValueError("empty LLM response")
    raw = text.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw)
    except Exception:
        if expect_array:
            m = re.search(r"\[.*\]", raw, re.DOTALL)
        else:
            m = re.search(r"\{.*\}", raw, re.DOTALL)
        if not m:
            raise
        return json.loads(m.group(0))


# ---------------------------------------------------------------------------
# 进度更新
# ---------------------------------------------------------------------------
async def _update_progress(analysis_id: int, **fields):
    """局部更新分析记录的字段(进度/状态/结果)"""
    async with session_scope() as s:
        row = await s.get(ScriptAnalysis, analysis_id)
        if not row:
            return
        for k, v in fields.items():
            if hasattr(row, k):
                setattr(row, k, v)


async def _set_failed(analysis_id: int, error: str):
    await _update_progress(analysis_id, status="failed", error=str(error)[:1000])


# ---------------------------------------------------------------------------
# Step 实现
# ---------------------------------------------------------------------------
def _build_chapter_summaries_block(chapters: list[dict], limit_per: int = 300) -> str:
    """把所有章节摘要拼成 markdown 列表,每章不超过 limit_per 字"""
    lines = []
    for ch in chapters:
        order = ch.get("chapter_order")
        title = ch.get("title", f"第{order}章")
        summary = (ch.get("summary") or "").strip()
        if len(summary) > limit_per:
            summary = summary[:limit_per] + "..."
        if not summary:
            # fallback: 取正文前 200 字
            summary = (ch.get("full_text") or "")[:200]
        lines.append(f"### 第 {order} 集 「{title}」\n{summary}")
    return "\n\n".join(lines) if lines else "(无章节)"


def _shorten_metrics(metrics: dict) -> dict:
    """精简 metrics,只留 LLM 需要的字段"""
    return {
        "total_chapters": metrics.get("total_chapters"),
        "total_words": metrics.get("total_words"),
        "avg_words_per_chapter": metrics.get("avg_words_per_chapter"),
        "avg_shots_per_chapter": metrics.get("avg_shots_per_chapter"),
        "has_full_storyboard": metrics.get("has_full_storyboard"),
    }


def _character_share_brief(metrics: dict) -> str:
    items = metrics.get("character_share") or []
    if not items:
        return "(无角色戏份数据)"
    parts = [f"{it['name']}({it['share_pct']}%)" for it in items[:5]]
    return ", ".join(parts)


def _word_deviation_brief(metrics: dict) -> str:
    items = metrics.get("chapter_word_counts") or []
    abnormal = [it for it in items if abs(it.get("deviation_pct", 0)) > 20]
    if not abnormal:
        return "字数全部在目标范围内"
    parts = [f"第{it['order']}集{it['deviation_pct']:+d}%" for it in abnormal[:5]]
    return ", ".join(parts) + (f" 等共 {len(abnormal)} 集异常" if len(abnormal) > 5 else "")


async def _step2_overall(draft: dict, chapters: list[dict], metrics: dict) -> dict:
    """Step 2: 整体评估 + 受众画像"""
    outline = draft.get("outline") or {}
    title = draft.get("title") or outline.get("title", "")
    synopsis = outline.get("synopsis", "") or draft.get("user_input", "") or "(无)"

    prompt = OVERALL_PROMPT.format(
        title=title,
        episode_count=len(chapters),
        total_words=metrics.get("total_words", 0),
        avg_words=metrics.get("avg_words_per_chapter", 0),
        synopsis=synopsis[:1500],
        chapter_summaries=_build_chapter_summaries_block(chapters, limit_per=250),
        total_storyboards=metrics.get("total_storyboards", 0),
        avg_shots=metrics.get("avg_shots_per_chapter", 0),
        character_share_brief=_character_share_brief(metrics),
        word_deviation_brief=_word_deviation_brief(metrics),
    )

    llm = get_llm("rewrite", temperature=0.3, provider="gemini", max_tokens=2048)
    resp = await llm.ainvoke(prompt)
    raw = (getattr(resp, "content", "") or "").strip()
    try:
        data = _extract_json(raw)
    except Exception as e:
        logger.warning("step2 parse failed: %s, raw=%r", e, raw[:300])
        # 降级
        return {
            "overall_grade": "C",
            "overall_score": 60,
            "summary": "AI 整体评估解析失败,请重试",
            "scores": {"completeness": 60, "character": 60, "pacing": 60, "market": 60},
            "audience": {"tags": [], "target_age": "", "target_gender": "", "target_region": "", "completion_rate_predict": "medium"},
            "_raw_excerpt": raw[:400],
            "_parse_error": str(e)[:200],
        }
    # 规范化
    grade = str(data.get("overall_grade", "C")).upper().strip()
    if grade not in ("S", "A", "B", "C", "D"):
        grade = "C"
    data["overall_grade"] = grade
    try:
        data["overall_score"] = int(data.get("overall_score", 60))
    except Exception:
        data["overall_score"] = 60
    return data


async def _step3_hooks_one(ch: dict, semaphore: asyncio.Semaphore) -> list[dict]:
    """单章爆点扫描"""
    order = ch.get("chapter_order")
    title = ch.get("title") or f"第{order}章"
    text = ch.get("full_text") or ""
    if len(text) < 100:
        return []
    # 截断: 单章最多 8000 字进 LLM
    if len(text) > 8000:
        text = text[:8000]

    prompt = HOOKS_PROMPT.format(
        chapter_order=order,
        chapter_title=title,
        chapter_content=text,
    )

    async with semaphore:
        llm = get_llm("rewrite", temperature=0.4, provider="deepseek", max_tokens=2048)
        try:
            resp = await llm.ainvoke(prompt)
        except Exception as e:
            logger.warning("hooks call failed for ch %s: %s", order, e)
            return []
        raw = (getattr(resp, "content", "") or "").strip()

    try:
        data = _extract_json(raw, expect_array=True)
    except Exception as e:
        logger.warning("hooks parse failed for ch %s: %s, raw=%r", order, e, raw[:200])
        return []
    if not isinstance(data, list):
        return []

    out = []
    for h in data[:6]:
        if not isinstance(h, dict):
            continue
        try:
            intensity = int(h.get("intensity", 3))
        except Exception:
            intensity = 3
        intensity = max(1, min(5, intensity))
        htype = str(h.get("type", "")).strip()
        if htype not in ("opening_hook", "twist", "cliffhanger", "emotional_peak", "iconic_line"):
            htype = "twist"
        out.append({
            "chapter_order": order,
            "type": htype,
            "intensity": intensity,
            "scene_no": str(h.get("scene_no", f"{order}-"))[:20],
            "snippet": str(h.get("snippet", ""))[:200],
            "comment": str(h.get("comment", ""))[:200],
            "improvement": str(h.get("improvement", ""))[:200],
        })
    return out


async def _step3_hooks_all(chapters: list[dict], analysis_id: int) -> list[dict]:
    """所有章节并发爆点扫描(并发 ≤ 3)"""
    if not chapters:
        return []
    semaphore = asyncio.Semaphore(3)
    total = len(chapters)
    done_count = [0]

    async def _wrap(ch):
        try:
            hooks = await _step3_hooks_one(ch, semaphore)
        except Exception as e:
            logger.warning("step3 single ch %s failed: %s", ch.get("chapter_order"), e)
            hooks = []
        done_count[0] += 1
        # 每章完成更新进度
        try:
            await _update_progress(analysis_id, progress_current=done_count[0], progress_total=total)
        except Exception:
            pass
        return hooks

    results = await asyncio.gather(*[_wrap(ch) for ch in chapters])
    all_hooks = []
    for r in results:
        all_hooks.extend(r)
    # 按集排序
    all_hooks.sort(key=lambda x: (x.get("chapter_order", 0), -x.get("intensity", 0)))
    return all_hooks


async def _step4_risks_suggestions(
    overall: dict,
    hooks: list[dict],
    metrics: dict,
) -> dict:
    """Step 4: 综合风险 + 改进建议"""
    # 爆点摘要(给 LLM 看)
    if not hooks:
        hooks_brief = "(无明显爆点钩子)"
    else:
        # 按集分组统计
        by_chapter: dict[int, list] = {}
        for h in hooks:
            by_chapter.setdefault(h["chapter_order"], []).append(h)
        lines = []
        for order in sorted(by_chapter.keys()):
            chs = by_chapter[order]
            types = [h["type"] for h in chs]
            avg_intensity = sum(h["intensity"] for h in chs) / len(chs)
            lines.append(f"第{order}集: {len(chs)}个钩子, 类型 {','.join(set(types))}, 平均强度 {avg_intensity:.1f}")
        hooks_brief = "\n".join(lines)

    scores_brief = json.dumps(overall.get("scores", {}), ensure_ascii=False)
    metrics_brief = json.dumps(_shorten_metrics(metrics), ensure_ascii=False)
    overall_summary = (
        f"评级 {overall.get('overall_grade', 'C')} / 综合分 {overall.get('overall_score', 60)} / "
        f"总评: {overall.get('summary', '')}"
    )

    prompt = RISKS_AND_SUGGESTIONS_PROMPT.format(
        overall_summary=overall_summary,
        scores_brief=scores_brief,
        total_hooks=len(hooks),
        hooks_brief=hooks_brief,
        metrics_brief=metrics_brief,
    )

    llm = get_llm("rewrite", temperature=0.4, provider="gemini", max_tokens=3072)
    resp = await llm.ainvoke(prompt)
    raw = (getattr(resp, "content", "") or "").strip()
    try:
        data = _extract_json(raw)
    except Exception as e:
        logger.warning("step4 parse failed: %s, raw=%r", e, raw[:300])
        return {
            "risks": [],
            "suggestions": [],
            "_raw_excerpt": raw[:400],
            "_parse_error": str(e)[:200],
        }

    # 规范化
    risks = []
    for r in (data.get("risks") or [])[:10]:
        if not isinstance(r, dict):
            continue
        risks.append({
            "category": str(r.get("category", ""))[:30],
            "severity": str(r.get("severity", "medium")).lower(),
            "location": str(r.get("location", ""))[:50],
            "description": str(r.get("description", ""))[:300],
            "suggestion": str(r.get("suggestion", ""))[:300],
        })

    suggestions = []
    for sg in (data.get("suggestions") or [])[:12]:
        if not isinstance(sg, dict):
            continue
        try:
            lift = int(sg.get("expected_score_lift", 2))
        except Exception:
            lift = 2
        suggestions.append({
            "priority": str(sg.get("priority", "P1")).upper()[:3],
            "location": str(sg.get("location", ""))[:50],
            "current_issue": str(sg.get("current_issue", ""))[:200],
            "suggestion": str(sg.get("suggestion", ""))[:300],
            "expected_score_lift": max(0, min(10, lift)),
        })

    return {"risks": risks, "suggestions": suggestions}


async def _step5_diagnosis_report(
    draft: dict,
    chapters: list[dict],
) -> str:
    """Step 5: 通读全剧正文, 产出总编诊断报告(Markdown 长文)。

    这一步直接喂全文(截断到上限), 让模型像 GPT/Gemini 网页版那样
    输出大框架改进建议: 连续性硬伤/时间线/世界观/人物/结构/版权/必修清单/最终评价。
    """
    MAX_CHARS = 120_000  # 全文上限, 超出按集均匀截断每集正文
    parts: list[str] = []
    n = max(1, len(chapters))
    per_cap = max(800, MAX_CHARS // n)
    for c in chapters:
        body = (c.get("full_text") or c.get("summary") or "").strip()
        if len(body) > per_cap:
            body = body[:per_cap] + " …(本集后文略)"
        parts.append(f"### 第{c.get('chapter_order')}集 {c.get('title') or ''}\n{body}")
    full_text = "\n\n".join(parts)
    if len(full_text) > MAX_CHARS:
        full_text = full_text[:MAX_CHARS] + "\n\n…(全剧过长, 后续略)"

    outline = draft.get("outline") or {}
    synopsis = outline.get("synopsis") or draft.get("user_input") or "(无)"

    prompt = DIAGNOSIS_REPORT_PROMPT.format(
        title=draft.get("title") or "未命名",
        episode_count=len(chapters),
        synopsis=str(synopsis)[:2000],
        full_text=full_text,
    )
    try:
        llm = get_llm("rewrite", temperature=0.5, provider="gemini", max_tokens=8192)
        resp = await llm.ainvoke(prompt)
        md = (getattr(resp, "content", "") or "").strip()
        # 去掉可能的 ```markdown 包裹
        md = re.sub(r"^```(?:markdown)?\s*", "", md)
        md = re.sub(r"\s*```$", "", md)
        return md
    except Exception as e:  # noqa: BLE001
        logger.warning("step5 diagnosis report failed: %s", e)
        return ""


async def _extract_health(report_md: str) -> dict:
    """从总编诊断报告里抽出结构化健康度: {score,p0_count,p1_count,verdict}。

    用于"自动打磨"工作流的收敛判定: p0_count==0 且 score>=阈值 → 达标退出。
    1次轻量 LLM 调用, 只输出 JSON。失败则返回保守默认(need_fix, 让循环继续)。
    """
    import json as _json, re as _re
    if not report_md or len(report_md) < 30:
        return {"score": None, "p0_count": 1, "p1_count": 0, "verdict": "need_fix"}
    prompt = (
        "下面是一份短剧总编诊断报告。请只输出一个 JSON 对象, 评估这部剧本的健康度:\n"
        '{"score": 0-100的综合质量分(整数), "p0_count": 必改级(P0/致命/硬伤)问题数量, '
        '"p1_count": 重要但非致命(P1)问题数量, "verdict": "pass"(基本无硬伤可交付) 或 "need_fix"(仍有必改硬伤)}\n'
        "判定标准: 有'穿帮/逻辑崩坏/死而复生/金手指自我打脸/时间线错乱'等致命问题就计入 p0_count。"
        "只输出 JSON, 不要多余文字。\n\n报告:\n" + report_md[:16000]
    )
    try:
        llm = get_llm("rewrite", temperature=0.1, provider="gemini", max_tokens=512)
        resp = await llm.ainvoke(prompt)
        txt = (getattr(resp, "content", "") or "").strip()
        txt = _re.sub(r"^```(?:json)?\s*", "", txt)
        txt = _re.sub(r"\s*```$", "", txt)
        d = _json.loads(txt)
        return {
            "score": int(d.get("score")) if d.get("score") is not None else None,
            "p0_count": int(d.get("p0_count") or 0),
            "p1_count": int(d.get("p1_count") or 0),
            "verdict": d.get("verdict") or "need_fix",
        }
    except Exception as e:  # noqa: BLE001
        logger.warning("extract_health failed: %s", e)
        return {"score": None, "p0_count": 1, "p1_count": 0, "verdict": "need_fix"}


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------
async def run_analysis(draft_id: int, analysis_id: int) -> None:
    """后台任务: 跑完整分析,把结果写回 ScriptAnalysis 记录"""
    started_at = datetime.utcnow()

    try:
        # ---- 准备数据
        async with session_scope() as s:
            draft = await s.get(ScriptDraft, draft_id)
            if not draft:
                await _set_failed(analysis_id, "draft not found")
                return

            chapters_rows = (await s.execute(
                select(ScriptChapter)
                .where(ScriptChapter.draft_id == draft_id)
                .order_by(ScriptChapter.chapter_order)
            )).scalars().all()
            sb_rows = (await s.execute(
                select(ScriptStoryboard)
                .where(ScriptStoryboard.draft_id == draft_id)
                .order_by(ScriptStoryboard.chapter_order)
            )).scalars().all()

            draft_dict = {
                "title": draft.title,
                "user_input": draft.user_input,
                "outline": draft.outline or {},
            }
            # ⭐数据源优先级: 剧本(storyboard) > 章节(chapter) > 大纲(outline)
            # 先把章节备着(第二优先), 剧本在下方优先合成
            _chapter_rows_list = [{
                "chapter_order": c.chapter_order,
                "title": c.title,
                "summary": c.summary,
                "full_text": c.full_text,
                "word_count": c.word_count,
            } for c in chapters_rows]
            chapters_list = []  # 按优先级填充
            storyboards_list = [{
                "chapter_order": sb.chapter_order,
                "shots_json": sb.shots_json,
            } for sb in sb_rows]
            word_target = draft.chapter_word_target or DEFAULT_CHAPTER_WORD_TARGET

        # 正文是可选流程(大纲→直接生成剧本)。没有章节正文时, 用【剧本(分镜)】合成伪章节,
        # 让剧情分析能基于剧本进行, 而不是硬卡"请先生成章节"。
        if storyboards_list:  # ⭐剧本优先
            def _shots_to_text(shots) -> str:
                if not isinstance(shots, list):
                    return ""
                lines: list[str] = []
                for sh in shots:
                    if not isinstance(sh, dict):
                        continue
                    for el in sh.get("elements") or []:
                        if isinstance(el, dict):
                            ch = el.get("character")
                            content = el.get("content") or el.get("action") or ""
                            if ch and content:
                                lines.append(f"{ch}：{content}")
                            elif content:
                                lines.append(str(content))
                    for k in ("action", "dialogue", "subtitle"):
                        v = sh.get(k)
                        if isinstance(v, str) and v:
                            lines.append(v)
                return "\n".join(lines)

            # outline.chapters 提供每集标题
            _ol = (draft_dict.get("outline") or {})
            _title_by_order = {
                int(c.get("order") or 0): c.get("title", "")
                for c in (_ol.get("chapters") or []) if isinstance(c, dict)
            }
            chapters_list = []
            for sb in storyboards_list:
                order = sb.get("chapter_order")
                ftext = _shots_to_text(sb.get("shots_json"))
                chapters_list.append({
                    "chapter_order": order,
                    "title": _title_by_order.get(order) or f"第{order}集",
                    "summary": (ftext or "")[:200],
                    "full_text": ftext,
                    "word_count": len(ftext or ""),
                })

        # 无剧本 → 退一步用【章节正文】(第二优先)
        if not chapters_list and _chapter_rows_list:
            chapters_list = _chapter_rows_list

        # 仍无(无剧本、无章节)→ 退而用【大纲】合成(第三优先)
        if not chapters_list:
            _ol = (draft_dict.get("outline") or {})
            _eps = _ol.get("chapters") or []
            if _eps:
                chapters_list = []
                for c in _eps:
                    if not isinstance(c, dict):
                        continue
                    order = int(c.get("order") or 0)
                    syn = str(c.get("synopsis") or "").strip()
                    chapters_list.append({
                        "chapter_order": order,
                        "title": c.get("title") or f"第{order}集",
                        "summary": syn[:200],
                        "full_text": syn,
                        "word_count": len(syn),
                    })

        if not chapters_list:
            await _set_failed(analysis_id, "草稿还没有任何内容(大纲/剧本/正文)可供分析, 请先生成大纲或剧本")
            return

        # ⭐ report_only: 超级Agent场景只要总编诊断报告(step5), 跳过 step1~4, 快50倍
        async with session_scope() as s:
            _an = await s.get(ScriptAnalysis, analysis_id)
            _scope = getattr(_an, "scope", "full") if _an else "full"
        if _scope == "report_only":
            await _update_progress(
                analysis_id, status="running", progress_step="report",
                progress_current=0, progress_total=1,
            )
            report_md = await _step5_diagnosis_report(draft_dict, chapters_list)
            # ⭐ 健康度提取: 从诊断报告里抽出结构化评分(用于自动打磨的收敛判定)
            health = await _extract_health(report_md)
            await _update_progress(
                analysis_id, status="done", report_md=report_md,
                overall_score=health.get("score"),
                scores_json=health,  # {score,p0_count,p1_count,verdict}
                progress_step="done", progress_current=1, progress_total=1,
                finished_at=datetime.utcnow(),
            )
            logger.info("analysis %d done (report_only) score=%s p0=%s", analysis_id, health.get("score"), health.get("p0_count"))
            return

        await _update_progress(
            analysis_id,
            status="running",
            progress_step="metrics",
            progress_current=0,
            progress_total=len(chapters_list) + 3,  # 1 metrics + 1 step2 + N step3 + 1 step4
        )

        # ---- Step 1: 程序化指标
        characters = (draft_dict.get("outline") or {}).get("characters") or []
        metrics = compute_metrics(
            chapters=chapters_list,
            storyboards=storyboards_list,
            word_target=word_target,
            characters=characters,
        )
        await _update_progress(
            analysis_id,
            metrics_json=metrics,
            progress_step="overall",
            progress_current=1,
        )

        # ---- Step 2: 整体评估
        overall = await _step2_overall(draft_dict, chapters_list, metrics)
        await _update_progress(
            analysis_id,
            overall_grade=overall.get("overall_grade"),
            overall_score=overall.get("overall_score"),
            summary=overall.get("summary", ""),
            scores_json=overall.get("scores", {}),
            audience_json=overall.get("audience", {}),
            progress_step="hooks",
            progress_current=2,
            progress_total=len(chapters_list) + 3,
        )

        # ---- Step 3: 爆点扫描(并发,内部会更新进度)
        hooks = await _step3_hooks_all(chapters_list, analysis_id)
        await _update_progress(
            analysis_id,
            hooks_json=hooks,
            progress_step="risks",
            progress_current=2 + len(chapters_list),
            progress_total=len(chapters_list) + 3,
        )

        # ---- Step 4: 风险 + 建议
        rs = await _step4_risks_suggestions(overall, hooks, metrics)
        await _update_progress(
            analysis_id,
            risks_json=rs.get("risks", []),
            suggestions_json=rs.get("suggestions", []),
            progress_step="report",
            progress_current=len(chapters_list) + 3,
            progress_total=len(chapters_list) + 4,
        )

        # ---- Step 5: 总编诊断报告(通读全文, Markdown 长文)
        report_md = await _step5_diagnosis_report(draft_dict, chapters_list)
        await _update_progress(
            analysis_id,
            report_md=report_md,
            progress_step="done",
            progress_current=len(chapters_list) + 4,
            status="done",
            error=None,
        )

        elapsed = (datetime.utcnow() - started_at).total_seconds()
        logger.info(
            "analysis %d done for draft %d, grade=%s score=%s hooks=%d risks=%d suggestions=%d, elapsed=%.1fs",
            analysis_id, draft_id,
            overall.get("overall_grade"), overall.get("overall_score"),
            len(hooks), len(rs.get("risks", [])), len(rs.get("suggestions", [])),
            elapsed,
        )

    except Exception as e:
        logger.exception("run_analysis failed for draft %d / analysis %d", draft_id, analysis_id)
        await _set_failed(analysis_id, f"{type(e).__name__}: {e}")
