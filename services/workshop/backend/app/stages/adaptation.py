"""改编主调度 — 提炼原作蓝图 / 连带建议 / 确认合同后复制新草稿并改编大纲+正文。

交互流程(三步, 全 SSE 或同步):
  step1 analyze  : 调 LLM 把原作 outline(+章节摘要) 提炼成「原作蓝图」(同步返回)
  step2 suggest  : 用户编辑草案后, 调 LLM 给连带修改建议(同步返回; 支持 field 即时 / overall 整体)
  step3 commit   : 用户确认「改编合同」-> 复制原作为新草稿 -> 逐批改编大纲 -> 逐集生成正文(SSE)

正文严格"根据(改编后的)大纲逐集生成", 复用 batch_generate_chapters。
不涉及计费。改编元数据存进新草稿 outline.adaptation, 零 DB 迁移。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import AsyncGenerator, Optional

from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from ..db import ScriptChapter, ScriptDraft, ScriptStoryboard, session_scope
from ..models.llm import get_llm
from . import drama_principles
from .adaptation_prompts import (
    build_analyze_prompt,
    build_outline_adapt_prompt,
    build_propose_prompt,
    build_storyboard_imitation_prompt,
    build_suggest_prompt,
    normalize_adapted_chapters,
)
from .storyboard_gen import _normalize as _normalize_shots
from .log_helper import save_log
from .progress_helper import finish_progress, start_progress, tick_progress

logger = logging.getLogger("adaptation")

_OUTLINE_CHUNK = 12  # 每批改编多少集大纲


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def _strip_trailing_commas(s: str) -> str:
    """去掉对象/数组里的尾随逗号 (LLM 常见非法 JSON): ',}' -> '}', ',]' -> ']'。"""
    return re.sub(r",(\s*[}\]])", r"\1", s)


def _fix_inner_quotes(s: str) -> str:
    """把字符串值内部**未转义的英文双引号**换成中文引号「“”」。

    ⚠️ 2026-10-09 用户甲反复遇到「JSON解析失败: Expecting ',' delimiter」：
    模型写台词时用了英文引号 —— `"synopsis": "她冷笑："这卡是我的。"随后离开"` ——
    第二个 `"` 被当成字符串结束，后面的中文就成了非法结构。长剧大纲（61 集、
    1.6 万 token 输出）里只要**一处**这样写，整份就作废；越长越容易中，
    所以表现为"反复失败"。上面几种修复（尾逗号/控制字符）都管不到它。

    判据：字符串内遇到 `"` 时向后看 —— 跳过空白后若紧跟 `, } ] :`
    （且逗号后面确实是下一个 JSON 成分），才认定它是真正的收尾引号；
    否则就是正文里的引号。成对的正文引号依次换成 “ 和 ”，读起来与原意一致。

    只作为**兜底修复**使用（严格解析失败后才跑），对合法 JSON 不会被调用。
    """
    out: list[str] = []
    in_str = False
    escaped = False
    open_inner = True          # 下一个正文引号是开（“）还是闭（”）
    n = len(s)
    i = 0
    while i < n:
        ch = s[i]
        if not in_str:
            out.append(ch)
            if ch == '"':
                in_str = True
                open_inner = True
            i += 1
            continue
        if escaped:
            out.append(ch)
            escaped = False
            i += 1
            continue
        if ch == "\\":
            out.append(ch)
            escaped = True
            i += 1
            continue
        if ch == '"':
            j = i + 1
            while j < n and s[j] in " \t\r\n":
                j += 1
            nxt = s[j] if j < n else ""
            closing = nxt in ("}", "]", ":", "")
            if nxt == ",":
                k = j + 1
                while k < n and s[k] in " \t\r\n":
                    k += 1
                # 逗号后面必须是下一个 JSON 成分，才说明逗号是结构性的
                closing = k >= n or s[k] in '"{[-0123456789tfn]}'
            if closing:
                out.append(ch)
                in_str = False
            else:
                out.append("“" if open_inner else "”")
                open_inner = not open_inner
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _escape_bad_control_chars(s: str) -> str:
    """把字符串字面量内部裸露的换行/制表符转义 (LLM 常在 JSON 字符串里直接换行,
    导致 'Expecting , delimiter' / 'Invalid control character')。
    仅在字符串内部 (引号未闭合时) 转义, 不动结构性空白。"""
    out = []
    in_str = False
    escaped = False
    for ch in s:
        if in_str:
            if escaped:
                out.append(ch)
                escaped = False
                continue
            if ch == "\\":
                out.append(ch)
                escaped = True
                continue
            if ch == '"':
                out.append(ch)
                in_str = False
                continue
            if ch == "\n":
                out.append("\\n")
                continue
            if ch == "\r":
                out.append("\\r")
                continue
            if ch == "\t":
                out.append("\\t")
                continue
            out.append(ch)
        else:
            out.append(ch)
            if ch == '"':
                in_str = True
    return "".join(out)


def _extract_json(text: str):
    """从 LLM 输出提取 JSON(对象或数组), 容错 markdown 包装 + 常见非法写法。

    依次尝试: 原样 -> 去 markdown 围栏 -> 截取最外层 {}/[] ->
    去尾随逗号 -> 转义字符串内裸换行。任一成功即返回。
    """
    if not text:
        raise ValueError("empty LLM response")
    raw = text.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)

    candidates = [raw]
    m = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", raw)
    if m:
        candidates.append(m.group(0))

    last_err: Exception | None = None
    for cand in candidates:
        for repair in (lambda x: x,
                       _strip_trailing_commas,
                       _escape_bad_control_chars,
                       lambda x: _strip_trailing_commas(_escape_bad_control_chars(x)),
                       # 兜底：正文里的英文引号（见 _fix_inner_quotes）。放最后 ——
                       # 它是启发式，前面几种能解决的就不劳它动手。
                       lambda x: _strip_trailing_commas(
                           _escape_bad_control_chars(_fix_inner_quotes(x)))):
            try:
                return json.loads(repair(cand))
            except Exception as e:  # noqa: BLE001
                last_err = e
                continue
    raise last_err or ValueError("无法解析 LLM 返回的 JSON")


# ===========================================================================
# step1: 提炼原作蓝图
# ===========================================================================

async def analyze_source(draft_id: int) -> dict:
    """提炼原作蓝图。返回结构化 blueprint dict。"""
    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            return {"error": "草稿不存在"}
        outline = dict(draft.outline or {})
        provider = draft.model_provider or "gemini"
        rows = (await s.execute(
            select(ScriptChapter)
            .where(ScriptChapter.draft_id == draft_id)
            .order_by(ScriptChapter.chapter_order)
        )).scalars().all()
        chapter_summaries = [
            {"chapter_order": r.chapter_order, "summary": r.summary or ""}
            for r in rows
        ]

    if not (outline.get("chapters") or chapter_summaries):
        return {"error": "原作尚无大纲或章节, 无法提炼改编蓝图"}

    prompt = build_analyze_prompt(outline=outline, chapter_summaries=chapter_summaries)
    try:
        llm = get_llm("generate", temperature=0.4, provider=provider)
        resp = await llm.ainvoke(prompt)
        text = getattr(resp, "content", "") if resp else ""
        blueprint = _extract_json(text)
        if not isinstance(blueprint, dict):
            raise ValueError("blueprint not a dict")
    except Exception as e:  # noqa: BLE001
        logger.exception("analyze_source failed for draft %s", draft_id)
        return {"error": f"提炼失败: {e}"}

    # 把原作蓝图存到原作 outline.adaptation_source (缓存, 便于二次打开)
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if d:
            ol = dict(d.outline or {})
            ol["adaptation_source"] = {"blueprint": blueprint, "analyzed_at": _now_iso()}
            d.outline = ol
            flag_modified(d, "outline")
    try:
        await save_log(draft_id, "adaptation", "已提炼原作改编蓝图", "log", 0)
    except Exception:
        pass
    return {"ok": True, "blueprint": blueprint}


# ===========================================================================
# step2: 连带修改建议
# ===========================================================================

async def suggest_changes(
    draft_id: int,
    *,
    origin: dict,
    draft_blueprint: dict,
    scope: str = "overall",
    changed_field: Optional[str] = None,
) -> dict:
    """对用户改编草案给连带修改建议。scope: 'field' 即时 / 'overall' 整体。"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        provider = (d.model_provider if d else None) or "gemini"

    prompt = build_suggest_prompt(
        origin=origin or {},
        draft=draft_blueprint or {},
        scope=scope,
        changed_field=changed_field,
    )
    try:
        llm = get_llm("rewrite", temperature=0.5, provider=provider, max_tokens=2048)
        resp = await llm.ainvoke(prompt)
        text = getattr(resp, "content", "") if resp else ""
        result = _extract_json(text)
        if not isinstance(result, dict):
            raise ValueError("suggest result not a dict")
    except Exception as e:  # noqa: BLE001
        logger.exception("suggest_changes failed for draft %s", draft_id)
        return {"error": f"生成建议失败: {e}"}
    return {
        "ok": True,
        "suggestions": result.get("suggestions") or [],
        "overall": result.get("overall") or "",
    }


# ===========================================================================
# step2.5: 一键生成全套改编设定
# ===========================================================================

async def propose_blueprint(
    draft_id: int,
    *,
    origin: dict,
    guidance: str = "",
) -> dict:
    """基于原作蓝图(+可选意向) 一键生成一套全新的、与原作区分的改编设定。"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        provider = (d.model_provider if d else None) or "gemini"

    prompt = build_propose_prompt(origin=origin or {}, guidance=guidance)
    try:
        llm = get_llm("generate", temperature=0.85, provider=provider)
        resp = await llm.ainvoke(prompt)
        text = getattr(resp, "content", "") if resp else ""
        proposed = _extract_json(text)
        if not isinstance(proposed, dict):
            raise ValueError("proposed blueprint not a dict")
    except Exception as e:  # noqa: BLE001
        logger.exception("propose_blueprint failed for draft %s", draft_id)
        return {"error": f"生成改编设定失败: {e}"}
    return {"ok": True, "blueprint": proposed}


# ===========================================================================
# step3: 确认合同 -> 复制新草稿 -> 改编大纲 -> 生成正文
# ===========================================================================

async def _copy_draft_for_adaptation(*, source_draft_id: int, user_id: int) -> Optional[int]:
    """复制原作为一份新草稿(不含章节正文/剧本, 因为正文要按改编后大纲重生)。

    复制: draft 基本信息 + outline(随后会被改编大纲覆盖)。
    不复制: 章节正文 / 剧本(改编流程会逐集重生)。
    """
    async with session_scope() as s:
        original = await s.get(ScriptDraft, source_draft_id)
        if not original:
            return None
        new_draft = ScriptDraft(
            user_id=user_id,
            session_id=None,
            title=(original.title or "") + "（改编）",
            user_input=original.user_input,
            outline=dict(original.outline or {}),
            outline_locked=0,
            status="adapting",
            episode_count=original.episode_count,
            is_favorite=False,
            is_deleted=False,
            preview_batch_running=0,
            model_provider=original.model_provider,
            chapter_word_target=original.chapter_word_target,
            parent_draft_id=original.id,
        )
        s.add(new_draft)
        await s.flush()
        return new_draft.id


class AdaptCanceled(Exception):
    """用户取消了改编作业（协作式退出）。"""


async def _find_draft_of_job(source_draft_id: int, job_id: int) -> Optional[int]:
    """重放时找回本作业已经建好的新草稿（作业号记在新草稿的 outline.adaptation.job_id）。

    这样即使"建好草稿、还没来得及把 id 写进作业结果"时进程崩溃，重放也不会再建第二个。
    """
    async with session_scope() as s:
        rows = (await s.execute(
            select(ScriptDraft).where(ScriptDraft.parent_draft_id == source_draft_id,
                                      ScriptDraft.is_deleted.is_(False))
        )).scalars().all()
        for d in rows:
            meta = (d.outline or {}).get("adaptation") or {}
            if meta.get("job_id") == job_id:
                return d.id
    return None


async def _set_draft_status(draft_id: int, status: str) -> None:
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if d:
            d.status = status
            await s.flush()


def normalize_contract(c: dict | None) -> dict:
    """改编合同字段归一：列表里的字符串转成对象，非法类型丢弃。

    🔴 2026-10-18: build_contract_block 对 characters/relations/emotion_beats 逐项 .get()，
    传入字符串数组（Agent 实测就这么传过）会抛 'str' object has no attribute 'get'，
    改编在 2% 处失败。前端恰好总传对象才一直没暴露。
    """
    c = dict(c or {})

    def _objs(v, key: str) -> list[dict]:
        out = []
        for x in (v if isinstance(v, list) else []):
            if isinstance(x, dict):
                out.append(x)
            elif isinstance(x, str) and x.strip():
                out.append({key: x.strip()})
        return out

    c["characters"] = _objs(c.get("characters"), "name")
    c["relations"] = _objs(c.get("relations"), "relation")
    c["emotion_beats"] = _objs(c.get("emotion_beats"), "beat")
    locs = c.get("locations")
    if isinstance(locs, str):
        locs = [locs]
    c["locations"] = [str(x) for x in (locs or []) if isinstance(x, (str, int, float)) and str(x).strip()]
    nm = c.get("name_map")
    c["name_map"] = {str(k): str(v) for k, v in nm.items() if k and v} if isinstance(nm, dict) else {}
    for k in ("title", "era", "central_conflict", "guidance"):
        if c.get(k) is not None and not isinstance(c[k], str):
            c[k] = str(c[k])
    return c


async def run_adapt_commit(*, job_id: int, source_draft_id: int, user_id: int,
                           contract: dict, state: dict | None = None,
                           writing_model: str | None = None) -> dict:
    """确认改编合同后的完整流程（后台作业版）。返回最终 result。

    🔴 2026-10-18 由 SSE 流改为后台作业。原先是一个持续 6~15 分钟的流式请求：
       用户关弹窗/刷新/跳转、nginx 600s 读超时（重建基线那段长时间没有输出）、
       上线重启服务，**都会中止改编**，留下一个只改了一半、状态停在中间的新草稿。

    阶段（每个阶段都能凭数据库现状判断"做没做过"，作业重放时跳过已完成部分）：
      1 建新草稿 + 写合同        —— 按作业号找回已建的草稿，不会重复建
      2 分批改编大纲             —— 新草稿里已有的集跳过
      3 补场景节拍（A2）         —— 只补没有节拍的集
      4 重建基线 + 一致性校验 + 结构门禁
      5 逐集仿写原作剧本         —— 已有剧本的集跳过
    取消：每个阶段、每一集开头检查；任何退出路径都给新草稿状态收尾。
    """
    from ..agent import jobs as _jobs

    contract = normalize_contract(contract)
    st: dict = dict(state or {})
    st.setdefault("log", [])

    async def emit(note: str, progress: int | None = None) -> None:
        st["log"] = (st["log"] + [f"{datetime.now().strftime('%H:%M:%S')} {note}"])[-30:]
        if progress is not None:
            # 续跑时会经过已完成阶段的较低进度点, 进度只增不减(避免进度条倒退)
            progress = max(int(progress), int(st.get("pct") or 0))
            st["pct"] = progress
        await _jobs.set_progress(job_id, progress=progress, note=note, result=dict(st))

    async def check_cancel() -> None:
        if await _jobs.is_canceled(job_id):
            raise AdaptCanceled()

    # ---- 读原作
    async with session_scope() as s:
        src = await s.get(ScriptDraft, source_draft_id)
        if not src:
            raise ValueError("原作草稿不存在")
        src_outline = dict(src.outline or {})
        # 这一轮指定的写作模型优先（对话栏选的那个）；没指定才沿用原作草稿的设置。
        provider = (writing_model or "").strip() or (src.model_provider or "gemini")
        src_sb_rows = (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == source_draft_id)
            .order_by(ScriptStoryboard.chapter_order)
        )).scalars().all()
        origin_shots_by_order: dict[int, list] = {
            r.chapter_order: (r.shots_json if isinstance(r.shots_json, list) else [])
            for r in src_sb_rows
        }
    origin_chapters = list(src_outline.get("chapters") or [])
    if not origin_chapters:
        raise ValueError("原作没有分集大纲, 无法改编")
    total_eps = len(origin_chapters)

    # ---- 阶段 1：新草稿（可重放）
    new_draft_id = st.get("new_draft_id") or await _find_draft_of_job(source_draft_id, job_id)
    if not new_draft_id:
        await emit("改编流程启动，正在创建新草稿…", 1)
        new_draft_id = await _copy_draft_for_adaptation(source_draft_id=source_draft_id, user_id=user_id)
        if not new_draft_id:
            raise ValueError("复制新草稿失败")
        async with session_scope() as s:
            d = await s.get(ScriptDraft, new_draft_id)
            ol = dict(d.outline or {})
            ol["adaptation"] = {
                "is_adaptation": True, "source_draft_id": source_draft_id,
                "job_id": job_id, "created_at": _now_iso(), "contract": contract,
                "backup": {"original_outline_chapters": origin_chapters},
            }
            if (contract.get("title") or "").strip():
                d.title = contract["title"].strip()
                ol["title"] = contract["title"].strip()
            name_map = contract.get("name_map") or {}
            if name_map and isinstance(ol.get("characters"), list):
                for ch in ol["characters"]:
                    if ch.get("name") in name_map:
                        ch["name"] = name_map[ch["name"]]
            ol["chapters"] = []
            # 原作的基线/账本/报告属于原作, 不能带进改编草稿（下面会按改编后的大纲重建）
            for k in ("story_bible", "state_ledger", "lint_report", "drama_report", "progress"):
                ol.pop(k, None)
            d.outline = ol
            flag_modified(d, "outline")
        await save_log(new_draft_id, "adaptation", f"改编新作创建, 源自草稿#{source_draft_id}", "log", 0)
        st["new_draft_id"] = new_draft_id
        await emit(f"已创建改编新草稿 #{new_draft_id}", 2)
    else:
        st["new_draft_id"] = new_draft_id
        await emit(f"续跑改编作业（新草稿 #{new_draft_id}）")

    try:
        chunk_total = (total_eps + _OUTLINE_CHUNK - 1) // _OUTLINE_CHUNK
        await start_progress(new_draft_id, "adaptation", chunk_total + total_eps, task_id=f"adapt-job-{job_id}")

        # ---- 阶段 2：分批改编大纲（进度 2→30）
        for chunk_idx in range(chunk_total):
            await check_cancel()
            chunk_src = origin_chapters[chunk_idx * _OUTLINE_CHUNK:(chunk_idx + 1) * _OUTLINE_CHUNK]
            start_order = int(chunk_src[0].get("order") or (chunk_idx * _OUTLINE_CHUNK + 1))
            end_order = int(chunk_src[-1].get("order") or (start_order + len(chunk_src) - 1))
            async with session_scope() as s:
                d = await s.get(ScriptDraft, new_draft_id)
                have = {int(c.get("order") or 0) for c in ((d.outline or {}).get("chapters") or [])}
            if all(o in have for o in range(start_order, end_order + 1)):
                continue
            await emit(f"改编大纲 第 {chunk_idx + 1}/{chunk_total} 批（第 {start_order}~{end_order} 集）",
                       2 + int(28 * chunk_idx / chunk_total))
            prompt = drama_principles.outline_block() + "\n\n" + build_outline_adapt_prompt(
                contract=contract, origin_chapters=chunk_src, start_order=start_order, end_order=end_order)
            llm = get_llm("generate", temperature=0.7, provider=provider)
            resp = await llm.ainvoke(prompt)
            adapted = normalize_adapted_chapters(
                _extract_json(getattr(resp, "content", "") if resp else ""),
                start_order=start_order, end_order=end_order, origin_chapters=chunk_src)
            async with session_scope() as s:
                d = await s.get(ScriptDraft, new_draft_id, with_for_update=True)
                ol = dict(d.outline or {})
                chs = [c for c in (ol.get("chapters") or []) if int(c.get("order") or 0) not in
                       {e["order"] for e in adapted}]
                chs.extend(adapted)
                chs.sort(key=lambda x: int(x.get("order") or 0))
                ol["chapters"] = chs
                d.outline = ol
                d.episode_count = max(d.episode_count or 0, end_order)
                flag_modified(d, "outline")
            await tick_progress(new_draft_id, current=chunk_idx + 1, total=chunk_total + total_eps,
                                message=f"大纲改编 {chunk_idx + 1}/{chunk_total} 批完成")
        await emit("大纲改编完成", 30)

        async with session_scope() as s:
            d = await s.get(ScriptDraft, new_draft_id)
            d.outline_locked = 1
            d.status = "storyboarding"
            _adapt_user_input = d.user_input or ""

        # ---- 阶段 3（A2）：补场景节拍（进度 30→45）
        # 节拍是下游剧本"不自己编剧情"的关键一层; 已保留的契约字段不覆盖(merge 默认只填空)。
        if not st.get("beats_done"):
            await check_cancel()
            from .outline_expand import expand_episodes, expandable_orders, merge_expanded
            async with session_scope() as s:
                d = await s.get(ScriptDraft, new_draft_id)
                outline_now = dict(d.outline or {})
            orders = expandable_orders(outline_now)
            if orders:
                await emit(f"正在为 {len(orders)} 集补场景节拍…", 32)
                try:
                    expanded = await expand_episodes(outline_now, orders, provider=provider, draft_id=new_draft_id)
                    async with session_scope() as s:
                        d = await s.get(ScriptDraft, new_draft_id, with_for_update=True)
                        merged, stats = merge_expanded(dict(d.outline or {}), expanded, overwrite=False)
                        d.outline = merged
                        flag_modified(d, "outline")
                    await emit(f"场景节拍已补齐：{stats.get('beats_added', 0)} 集新增节拍，"
                               f"{stats.get('filled', 0)} 个字段补全", 45)
                except AdaptCanceled:
                    raise
                except Exception as e:  # noqa: BLE001 - 补节拍失败不阻断改编
                    logger.exception("adapt beats expand failed draft=%s", new_draft_id)
                    await emit(f"⚠️ 补场景节拍失败（不影响后续步骤）：{str(e)[:80]}", 45)
            st["beats_done"] = True

        # ---- 阶段 4：重建基线 + 一致性校验 + 结构门禁（进度 45→55）
        if not st.get("baseline_done"):
            await check_cancel()
            await emit("正在为改编大纲重建事实基线与状态账本…", 46)
            try:
                from .story_bible import generate_story_bible
                from .state_ledger import update_ledger_for_batch, empty_ledger
                from .consistency_lint import lint_outline
                from .drama_gate import check_outline as _gate
                async with session_scope() as s:
                    d = await s.get(ScriptDraft, new_draft_id)
                    adapted_chapters = list(((d.outline or {}).get("chapters")) or [])
                _src_bible = (src_outline.get("story_bible") or {})
                _hint = _adapt_user_input
                if _src_bible.get("premise") or _src_bible.get("opponent"):
                    _hint += ("\n\n【原作已确立的戏剧基线（改编须保留其戏剧功能，只替换表层设定）】\n"
                              + json.dumps({k: _src_bible.get(k) for k in
                                            ("premise", "opponent", "binding", "escalation_ladder", "genre_promise")},
                                           ensure_ascii=False, indent=2))
                _bible = await generate_story_bible(_hint, provider=provider)
                await emit("事实基线已重建，正在生成状态账本…", 49)
                _led = await update_ledger_for_batch(empty_ledger(), adapted_chapters,
                                                     open_threads_seed=_bible.get("core_mysteries"), provider=provider)
                await emit("状态账本已生成，正在做一致性校验…", 52)
                _ol_for_lint = {"chapters": adapted_chapters, "story_bible": _bible, "state_ledger": _led}
                _report = await lint_outline(_ol_for_lint, use_llm=True, provider=provider)
                _drama = _gate(_ol_for_lint, bible=_bible)
                async with session_scope() as s:
                    d = await s.get(ScriptDraft, new_draft_id, with_for_update=True)
                    ol = dict(d.outline or {})
                    ol.update({"story_bible": _bible, "state_ledger": _led,
                               "lint_report": _report, "drama_report": _drama})
                    d.outline = ol
                    flag_modified(d, "outline")
                _ls, _ds = _report.get("summary", {}), _drama.get("summary", {})
                await emit(f"校验完成：一致性 {_ls.get('error', 0)} 硬伤 / {_ls.get('warn', 0)} 提醒；"
                           f"结构门禁 {_ds.get('error', 0)} 问题 / {_ds.get('warn', 0)} 提醒", 55)
            except AdaptCanceled:
                raise
            except Exception as e:  # noqa: BLE001 - 校验失败不阻断主流程
                logger.warning("adapt baseline/lint failed: %s", e)
                await emit(f"⚠️ 重建基线或校验失败（不影响剧本仿写）：{str(e)[:80]}", 55)
            st["baseline_done"] = True

        # ---- 阶段 5：逐集仿写原作剧本（进度 55→99）
        async with session_scope() as s:
            d = await s.get(ScriptDraft, new_draft_id)
            adapted_title = {int(c.get("order") or 0): c.get("title", "")
                             for c in ((d.outline or {}).get("chapters") or [])}
            have_sb = {r.chapter_order for r in (await s.execute(
                select(ScriptStoryboard).where(ScriptStoryboard.draft_id == new_draft_id)
            )).scalars().all() if r.shots_json}
        st.setdefault("done_orders", [])
        st.setdefault("skipped_orders", [])
        st.setdefault("failed_orders", [])
        for idx, src_ch in enumerate(origin_chapters):
            await check_cancel()
            order = int(src_ch.get("order") or (idx + 1))
            pct = 55 + int(44 * (idx + 1) / total_eps)
            if order in have_sb:
                continue
            origin_shots = origin_shots_by_order.get(order, [])
            if not origin_shots:
                if order not in st["skipped_orders"]:
                    st["skipped_orders"].append(order)
                await tick_progress(new_draft_id, current=chunk_total + idx + 1, total=chunk_total + total_eps,
                                    message=f"第{order}集无原作剧本, 跳过")
                await emit(f"第{order}集原作没有剧本，跳过（可在新草稿里单独生成剧本）", pct)
                continue
            await emit(f"正在仿写第{order}集剧本（原作 {len(origin_shots)} 场）…")
            try:
                new_title = adapted_title.get(order) or src_ch.get("title", "") or f"第{order}集"
                llm = get_llm("generate", temperature=0.6, provider=provider, max_tokens=8192)
                resp = await llm.ainvoke(build_storyboard_imitation_prompt(
                    contract=contract, order=order, title=new_title, origin_shots=origin_shots))
                raw = _extract_json(getattr(resp, "content", "") if resp else "")
                if not isinstance(raw, list):
                    raise ValueError("剧本仿写输出非数组")
                shots = _normalize_shots(raw)
                if not shots:
                    raise ValueError("剧本仿写输出为空")
            except Exception as e:  # noqa: BLE001 - 单集失败不中断整批
                logger.exception("storyboard imitation failed order=%s", order)
                if order not in st["failed_orders"]:
                    st["failed_orders"].append(order)
                await emit(f"⚠️ 第{order}集剧本仿写失败：{str(e)[:60]}", pct)
                continue
            async with session_scope() as s:
                existing = (await s.execute(select(ScriptStoryboard).where(
                    ScriptStoryboard.draft_id == new_draft_id, ScriptStoryboard.chapter_order == order,
                ))).scalar_one_or_none()
                if existing:
                    existing.shots_json = shots
                    existing.is_stale = 0
                else:
                    s.add(ScriptStoryboard(draft_id=new_draft_id, chapter_order=order, shots_json=shots))
                await s.flush()
            st["done_orders"].append(order)
            await tick_progress(new_draft_id, current=chunk_total + idx + 1, total=chunk_total + total_eps,
                                message=f"第{order}集剧本仿写完成 ({len(shots)} 场)")
            await emit(f"第{order}集剧本完成（{len(shots)} 场）", pct)

        await _set_draft_status(new_draft_id, "done")
        await finish_progress(new_draft_id, success=True, message="改编完成")
        st["phase"] = "done"
        await emit("✅ 改编完成", 100)
        return dict(st)
    except AdaptCanceled:
        await _set_draft_status(new_draft_id, "interrupted")
        await finish_progress(new_draft_id, success=False, message="改编已取消")
        st["phase"] = "canceled"
        await emit("改编已取消（已完成的部分保留在新草稿里）")
        return dict(st)
    except asyncio.CancelledError:
        # worker 被要求停止(如重启): 不收尾, 作业留在 running 等租约过期后重放续跑
        raise
    except Exception as e:  # noqa: BLE001
        # 失败也要收尾: 原先异常退出会把新草稿永远留在 adapting/storyboarding
        attempt_left = True
        try:
            from ..db.models import AgentJob
            async with session_scope() as s:
                j = await s.get(AgentJob, job_id)
                attempt_left = bool(j and (j.attempt or 0) < (j.max_attempts or 3))
        except Exception:  # noqa: BLE001
            pass
        if not attempt_left:
            await _set_draft_status(new_draft_id, "failed")
            await finish_progress(new_draft_id, success=False, message=f"改编失败: {str(e)[:60]}")
        await emit(f"❌ 改编出错：{str(e)[:120]}" + ("（将自动重试）" if attempt_left else ""))
        raise


# ===========================================================================
# 元信息查询
# ===========================================================================

async def get_adapt_meta(draft_id: int) -> dict:
    """返回改编面板初始化所需信息: 原作概况 + 已缓存的蓝图(若有)。"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"error": "草稿不存在"}
        outline = dict(d.outline or {})
        rows = (await s.execute(
            select(ScriptChapter)
            .where(ScriptChapter.draft_id == draft_id)
            .order_by(ScriptChapter.chapter_order)
        )).scalars().all()
        chapter_count = len(rows)
    cached = (outline.get("adaptation_source") or {}).get("blueprint")
    return {
        "draft_id": draft_id,
        "title": d.title or "",
        "episode_count": d.episode_count or 0,
        "outline_episode_count": len(outline.get("chapters") or []),
        "chapter_count": chapter_count,
        "cached_blueprint": cached,
    }


__all__ = [
    "analyze_source",
    "suggest_changes",
    "propose_blueprint",
    "run_adapt_commit",
    "AdaptCanceled",
    "get_adapt_meta",
]
