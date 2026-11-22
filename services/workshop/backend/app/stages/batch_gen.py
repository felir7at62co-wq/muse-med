"""批量生成章节/剧本 - SSE实时反馈"""
import asyncio
import logging
import uuid
from typing import AsyncGenerator

from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from .chapter_gen import generate_chapter, summarize_chapter
from .storyboard_gen import generate_storyboard
from .episode_render import build_contract_block, build_beats_block
# 2026-11-07：场景卡停用（beats 取消后它没有原料），恢复时把下面这行接回去
# from .scene_card import cards_for_episode
from .candidate_store import save_candidate
from .progress_helper import (
    start_progress,
    tick_progress,
    finish_progress,
    is_cancel_requested,
    record_episode,
    clear_cancel_request,
)
from .log_helper import save_log
from ..db import ScriptDraft, ScriptChapter, ScriptStoryboard, session_scope
from sqlalchemy import and_, delete, select

logger = logging.getLogger("batch_gen")


async def _emit_post_check(
    draft_id: int,
    chapter_order: int,
    *,
    text: str | None = None,
    shots: list[dict] | None = None,
    word_target: int | None = None,
) -> None:
    """章节/剧本生成后跑一次质量+安全检查,把疑似问题写到 generation_logs。
    所有警告都是非阻塞的,只在前端日志面板上以红/黄标示。
    """
    # 1. 字数检查(章节才有)
    if text is not None and word_target:
        actual = len(text)
        word_min = int(word_target * 0.6)             # 低于 60% 才警告; 不再设硬下限
        word_max = int(word_target * 1.5)              # 高于 150% 也警告
        if actual < word_min:
            await save_log(
                draft_id, "chapter_quality",
                f"⚠ 第{chapter_order}章字数 {actual} 远低于目标 {word_target}(下限 {word_min})",
                "warn", chapter_order,
                {"actual": actual, "target": word_target, "min": word_min, "kind": "too_short"},
            )
        elif actual > word_max:
            await save_log(
                draft_id, "chapter_quality",
                f"⚠ 第{chapter_order}章字数 {actual} 远超目标 {word_target}(上限 {word_max})",
                "warn", chapter_order,
                {"actual": actual, "target": word_target, "max": word_max, "kind": "too_long"},
            )

    # 2. ⛔ 安全关键词扫描已从生成链路移除（2026-09-21 用户裁定）
    #
    # 原来每生成一章/一集就自动扫一遍，命中写成 🛡 safety_warn/safety_alert 日志。
    # 移除理由：
    #   · 平台不再做强制内容审核（见 app/safety/__init__.py 的裁定说明）；
    #   · 那套正则出自同一份过时文档，实测 300 章只命中 11 章（3%），
    #     且命中里有明显误报（"防割战术手套"命中「割…手」）与正常桥段（高利贷、
    #     剁了他的手）—— 自动刷进日志只是噪音，还会诱导用户去"改干净"。
    # 想自查仍可手动调 GET /safety/scan（不花钱、不阻断）。


async def batch_generate_chapters(draft_id: int, force: bool = False) -> AsyncGenerator[str, None]:
    """批量生成所有章节,SSE实时反馈

    force: True 时连已锁定的集也重写。
      ⚠️ locked 是个用户无从操作的字段(导入剧本时后端自动打标, 前端无解锁入口),
      所以"强制重写"必须能穿透它, 否则对导入的草稿整个按钮是死的 ——
      见 `stages/router.py` 的 start_batch_chapters 注释。
      默认 False 时行为与以前完全一致(锁定集跳过), 供续写/改编等路径继续使用。

    日志格式:
    data: {"type": "log", "message": "正在生成第1章..."}
    data: {"type": "progress", "current": 1, "total": 10}
    data: {"type": "complete", "chapter_order": 1}
    data: {"type": "error", "chapter_order": 1, "error": "..."}
    data: {"type": "done"}
    """
    import json

    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        if not draft:
            yield f'data: {json.dumps({"type": "error", "message": "草稿不存在"})}\n\n'
            return

        # 不再要求"手动锁定大纲": 有大纲(含 chapters)即可生成。
        # 首次生成时自动把 outline_locked 置 1, 沿用既有状态信号(overview/自动流程仍依赖它)。
        outline = draft.outline or {}
        chapters = outline.get("chapters") or []
        if not chapters:
            yield f'data: {json.dumps({"type": "error", "message": "请先生成大纲"})}\n\n'
            return
        if not draft.outline_locked:
            draft.outline_locked = 1
            if draft.status == "outline_done":
                draft.status = "outline_locked"
            await s.flush()
        total = len(chapters)
        word_target = draft.chapter_word_target or DEFAULT_CHAPTER_WORD_TARGET
        model_provider = draft.model_provider or "gemini"

    task_id = uuid.uuid4().hex[:12]
    await start_progress(draft_id, "chapters", total, task_id=task_id)
    # 新一轮开始: 清掉上一轮遗留的取消标志, 否则这个任务一进循环就自杀。
    await clear_cancel_request(draft_id)

    yield f'data: {json.dumps({"type": "log", "message": f"开始批量生成{total}个章节..."})}\n\n'

    # 计数用于收尾如实汇报 —— 旧实现无论中途失败多少集, 结束语一律是
    # "所有章节生成完成", 部分失败被显示成全部成功。见 2026-09-18 六入口核验表。
    succeeded: list[int] = []
    failed: list[int] = []
    skipped: list[int] = []
    canceled = False

    for idx, ch_meta in enumerate(chapters):
        order = ch_meta.get("order", idx + 1)

        # ⚠️ 取消检查放在**每集开头**, 不是每次 tick —— 单次 LLM 调用无法中途打断,
        # 能停的最早时机就是"上一集刚写完、下一集还没发请求"这一刻。
        # 取消后必须走正常收尾(finish_progress + done 事件), 不能直接 return,
        # 否则进度停在 running 上, 前端要等 180 秒心跳超时才知道停了。
        if await is_cancel_requested(draft_id):
            canceled = True
            yield f'data: {json.dumps({"type": "log", "message": "已按你的请求停止, 已完成的集保持不动"})}\n\n'
            break

        # 检查是否已存在
        # 优先级:
        #   1. locked=1 的章节: force=False 时永远跳过(即使 stale)
        #      —— 防止"导入的剧本格式正文"被 LLM 重写成小说体
        #      ⚠️ force=True 时必须穿透: locked 是用户无从操作的字段(导入时后端自动打标,
        #      前端没有任何解锁入口), 不穿透的话"强制重写"对导入的草稿整个是死的。
        #   2. is_stale=0 的章节: force=False 时跳过(普通"已存在")
        #   3. is_stale=1 或 force=True: 重新生成(但**不预先删除**旧稿, 见下方)
        async with session_scope() as s:
            existing = (await s.execute(
                select(ScriptChapter).where(
                    ScriptChapter.draft_id == draft_id,
                    ScriptChapter.chapter_order == order
                )
            )).scalar_one_or_none()

            if existing and getattr(existing, 'locked', 0) and not force:
                yield f'data: {json.dumps({"type": "log", "message": f"第{order}章已锁定(原文/手动锁定),跳过"})}\n\n'
                yield f'data: {json.dumps({"type": "progress", "current": idx + 1, "total": total})}\n\n'
                await tick_progress(draft_id, current=idx + 1, total=total, message=f"第{order}章已锁定,跳过")
                await record_episode(draft_id, order, "skipped", "已锁定")
                skipped.append(order)
                continue

            if existing and not getattr(existing, 'is_stale', 0) and not force:
                yield f'data: {json.dumps({"type": "log", "message": f"第{order}章已存在,跳过"})}\n\n'
                yield f'data: {json.dumps({"type": "progress", "current": idx + 1, "total": total})}\n\n'
                await tick_progress(draft_id, current=idx + 1, total=total, message=f"第{order}章已存在,跳过")
                await record_episode(draft_id, order, "skipped", "已存在")
                skipped.append(order)
                continue
            if existing and getattr(existing, 'is_stale', 0):
                # ⚠ 这里**不再预删**。
                #
                # 旧实现在此执行 DELETE 并 commit, 然后才去调模型 —— 生成一旦失败
                # (超时/限流/内容违规), 这一集就彻底空了, 而且没有历史可恢复,
                # 用户只能重新生成。同时新建行时 version 走默认值 1, 导致同一集
                # 反复重生成后版本号永远是 1, "当前是第几版"这个信息在批量路径上失效。
                #
                # 新做法: 旧稿原地不动, 生成成功后由 save_candidate 统一
                # "先存历史、再覆写、递增 version"; 生成失败则旧稿留在原处,
                # 只标 stale 并在收尾里如实报失败。
                yield f'data: {json.dumps({"type": "log", "message": f"第{order}章已过期,重新生成..."})}\n\n'
            elif existing and force:
                yield f'data: {json.dumps({"type": "log", "message": f"第{order}章强制重写中..."})}\n\n'

        yield f'data: {json.dumps({"type": "log", "message": f"正在生成第{order}章..."})}\n\n'
        await tick_progress(draft_id, current=idx, total=total, message=f"正在生成第{order}章...")

        try:
            # 获取前面章节用于上下文
            async with session_scope() as s:
                prev_rows = (await s.execute(
                    select(ScriptChapter)
                    .where(ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order < order)
                    .order_by(ScriptChapter.chapter_order)
                )).scalars().all()
                prev_chapters = [{"chapter_order": c.chapter_order, "summary": c.summary, "full_text": c.full_text} for c in prev_rows]
                
                draft = await s.get(ScriptDraft, draft_id)
                outline = draft.outline or {}
            
            # 生成章节
            # 修复: 之前漏传 provider/draft_id, 导致批量生成永远用默认模型
            # (无视草稿的 model_provider 设置), 且没有「使用模型/截断」日志
            full_text = await generate_chapter(
                outline=outline,
                chapter_order=order,
                word_target=word_target,
                prev_chapters=prev_chapters,
                provider=model_provider,
                draft_id=draft_id,
            )
            
            yield f'data: {json.dumps({"type": "log", "message": f"第{order}章生成完成,正在生成摘要..."})}\n\n'
            
            # 生成摘要
            summary = await summarize_chapter(full_text)
            
            # 保存: 统一走候选写入口 —— 先存历史、再覆写、递增 version。
            # 不再自己 s.add(ScriptChapter(...)): 那样 version 恒为 1,
            # 且旧稿没有归档, 用户的"撤销"无路可走。
            await save_candidate(
                draft_id=draft_id,
                order=order,
                stage="chapter",
                content=full_text,
                created_by="ai_generate",
                title=ch_meta.get("title", f"第{order}章"),
            )
            # summary 是本章的自动摘要(喂给下一章生成控制上下文长度),
            # 不属于"正文内容", 单独写; 它不影响历史版本语义。
            async with session_scope() as s:
                await s.execute(
                    ScriptChapter.__table__.update().where(and_(
                        ScriptChapter.draft_id == draft_id,
                        ScriptChapter.chapter_order == order,
                    )).values(summary=summary, is_stale=0)
                )

            succeeded.append(order)
            await record_episode(draft_id, order, "done")
            yield f'data: {json.dumps({"type": "complete", "chapter_order": order, "word_count": len(full_text)})}\n\n'
            yield f'data: {json.dumps({"type": "progress", "current": idx + 1, "total": total})}\n\n'
            await tick_progress(draft_id, current=idx + 1, total=total, message=f"第{order}章完成 ({len(full_text)} 字)")

            # 生成后质量+安全检查(非阻塞,只写警告日志)
            try:
                await _emit_post_check(
                    draft_id, order,
                    text=full_text,
                    word_target=word_target,
                )
            except Exception as ex:
                logger.warning("post_check chapter %d failed: %s", order, ex)

        except Exception as e:
            logger.error(f"生成第{order}章失败: {e}")
            failed.append(order)
            await record_episode(draft_id, order, "failed", str(e))
            # 失败时把这一集标为 stale, 让"下次重试"与"用户手动重生成"都能识别它;
            # 旧稿仍留在原处, 用户看到的是失败提示而不是空白集。
            if existing is not None:
                try:
                    async with session_scope() as s2:
                        await s2.execute(
                            ScriptChapter.__table__.update().where(and_(
                                ScriptChapter.draft_id == draft_id,
                                ScriptChapter.chapter_order == order,
                            )).values(is_stale=1)
                        )
                except Exception as mark_ex:
                    logger.warning("标记第%d章 stale 失败: %s", order, mark_ex)
            yield f'data: {json.dumps({"type": "error", "chapter_order": order, "error": str(e), "kept_old": existing is not None})}\n\n'
            await tick_progress(draft_id, current=idx + 1, total=total, message=f"第{order}章失败: {str(e)[:80]}")

    # 收尾如实汇报成败 —— 成功集数与失败集数分开, 不再一律宣称"全部完成"。
    # 前端据此显示"共 N 集: M 成功 / K 失败", 满足 v2 AC11 的
    # "没有成功产物时显示失败, 不能显示部分成功"。
    #
    # 取消的收尾也是 success=False: 它就是"没跑完", 报成成功会让状态栏显示绿色
    # 完成态, 而用户手里还有一多半集没重写。用户是主动取消的, 越如实越好。
    if canceled:
        msg = f"已取消: {len(succeeded)} 集完成, 剩余 {total - len(succeeded) - len(skipped)} 集未处理"
        if skipped:
            msg += f", {len(skipped)} 集跳过"
        yield f'data: {json.dumps({"type": "done", "message": msg, "ok": False, "canceled": True, "succeeded": succeeded, "failed": failed, "skipped": skipped})}\n\n'
        await finish_progress(draft_id, success=False, message=msg[:200])
    elif failed:
        msg = f"批量生成结束: {len(succeeded)} 集成功, {len(failed)} 集失败"
        if skipped:
            msg += f", {len(skipped)} 集跳过"
        msg += f"。失败集: {', '.join(str(x) for x in failed)}"
        yield f'data: {json.dumps({"type": "done", "message": msg, "ok": False, "succeeded": succeeded, "failed": failed, "skipped": skipped})}\n\n'
        await finish_progress(draft_id, success=False, message=msg[:200])
    else:
        msg = f"共 {len(succeeded)} 集生成完成"
        if skipped:
            msg += f", {len(skipped)} 集跳过"
        yield f'data: {json.dumps({"type": "done", "message": msg, "ok": True, "succeeded": succeeded, "failed": [], "skipped": skipped})}\n\n'
        await finish_progress(draft_id, success=True, message=msg[:200])
    # 收尾清掉标志, 免得下次任务一启动就被这轮的取消请求自杀。
    await clear_cancel_request(draft_id)


async def batch_generate_storyboards(draft_id: int, force: bool = False) -> AsyncGenerator[str, None]:
    """批量生成所有剧本,SSE实时反馈。

    force: True 时连已存在的剧本也重写(剧本无 locked 概念, 但 is_stale=0 的会跳过)。
      默认 False 与以前完全一致。

    数据源优先级: 有章节正文(ScriptChapter)就逐章用正文生成剧本;
    若该草稿没有任何章节(允许"大纲直接生成剧本"), 则回退到大纲里的每集
    synopsis + 全剧上下文, 直接扩写生成剧本。
    """
    import json
    from .storyboard_gen import generate_storyboard_from_outline

    # 剧本与章节完全解离: 集数**以大纲 outline.chapters 为准**, 不再被"已有章节数"卡死。
    # (历史 bug: 旧逻辑"只要有任意一集章节, episodes 就只等于已有章节",
    #  导致 50 集大纲但只写了第 1 集章节时, 剧本只生成第 1 集。)
    #
    # 每集数据源优先级:
    #   1. 该集已有章节正文(ScriptChapter.full_text) → 用正文生成(更丰富、含用户编辑)
    #   2. 否则 → 用大纲该集 synopsis + 全剧上下文, 直接扩写生成剧本
    # 大纲缺失时才回退到"按已有章节"(极端兜底), 仍保证不为空。
    episodes: list[dict] = []
    # P5: 状态账本(供分镜生成注入硬约束; 无则为 None, 分镜按旧逻辑)
    # ⚠️ 2026-10-05 修正两处, 此前账本等于从未生效:
    #   1. 原来读 outline["state_ledger"](计划账本), 而用户点「重建账本」写的是
    #      outline["state_ledger_effective"](见 divergence._persist), key 根本对不上;
    #      且计划账本不含用户改稿后的实况。改为与 chapter_gen 同款 effective_ledger()。
    #   2. 即便取到了账本, 下游 from_outline 分支也从不读取(见生成循环)。
    # ⚠️ 必须放在下面的 session 之外: effective_ledger 可能跑几十秒(甚至调 LLM
    #    重建), 且它自己会开 session 写 state_ledger_effective —— 塞在长 session 里
    #    会把连接占住、并与其读快照打架。
    _state_ledger = None
    try:
        from .divergence import effective_ledger
        _state_ledger = await effective_ledger(draft_id) or None
    except Exception as _e:  # noqa: BLE001
        logger.warning("批量剧本: 有效账本获取失败, 回退计划账本: %s", _e)

    async with session_scope() as s:
        draft = await s.get(ScriptDraft, draft_id)
        outline = (draft.outline or {}) if draft else {}
        # 修复: 之前漏传 provider, 批量剧本生成永远用默认模型(无视草稿 model_provider)
        model_provider = (draft.model_provider if draft else None) or "gemini"
        sb_word_target = int((draft.chapter_word_target if draft else 0) or 0)
        ol_chapters = (outline.get("chapters") or []) if isinstance(outline, dict) else []
        if _state_ledger is None and isinstance(outline, dict):
            _state_ledger = outline.get("state_ledger")

        # 已有章节正文索引: order -> full_text (用于每集优先取正文)
        chapters = (await s.execute(
            select(ScriptChapter)
            .where(ScriptChapter.draft_id == draft_id)
            .order_by(ScriptChapter.chapter_order)
        )).scalars().all()
        ch_by_order = {c.chapter_order: c for c in chapters}

        if ol_chapters:
            # 主路径: 以大纲集数为准, 逐集决定数据源
            base_ctx = []
            if isinstance(outline, dict):
                if outline.get("title"):
                    base_ctx.append(f"【全剧标题】{outline['title']}")
                if outline.get("synopsis"):
                    base_ctx.append(f"【全剧主线】{outline['synopsis']}")
            for i, c in enumerate(ol_chapters):
                order = int(c.get("order", i + 1))
                ch = ch_by_order.get(order)
                full_text = (ch.full_text or "").strip() if ch else ""
                title = (ch.title if ch and ch.title else str(c.get("title", "") or f"第{order}集"))
                # 🔴 2026-10-09：**不再**把「上一集梗概 / 下一集梗概」塞进 context。
                #
                # 用户已定结论：衔接要直接用**上下集原文**而非梗概。而梗概是模型
                # 的二次产物，偏差会被当成"已发生的事实"继承放大 —— 2026-10-08
                # 的草稿 2421 就是被第 5 章的摘要一路污染到第 19 章。
                # 眼下这里若继续留着梗概，同一条信息会以两个口径（原文 + 梗概）
                # 同时进 prompt，一个精确一个模糊，模型按哪个写是不确定的。
                # 原文改由生成时取（见下方 collect_neighbor_originals），
                # 取不到才退回梗概，两者不会同时出现。
                ctx = list(base_ctx)
                episodes.append({
                    "order": order,
                    "title": title,
                    "full_text": full_text,                       # 有正文用正文
                    "synopsis": str(c.get("synopsis", "") or ""),  # 否则用大纲梗概
                    "context": "\n".join(ctx),
                    "_ledger": _state_ledger,                      # P5: 状态账本(分镜硬约束)
                })
        elif chapters:
            # 兜底: 没有大纲但有章节(极少见, 如老数据) → 按已有章节正文
            for ch in chapters:
                episodes.append({
                    "order": ch.chapter_order,
                    "title": ch.title or f"第{ch.chapter_order}章",
                    "full_text": ch.full_text or "",
                    "synopsis": "",
                    "context": "",
                })
        else:
            yield f'data: {json.dumps({"type": "error", "message": "请先生成大纲或章节"})}\n\n'
            return

        total = len(episodes)

    task_id = uuid.uuid4().hex[:12]
    await start_progress(draft_id, "storyboards", total, task_id=task_id)
    await clear_cancel_request(draft_id)

    yield f'data: {json.dumps({"type": "log", "message": f"开始批量生成{total}个剧本..."})}\n\n'

    sb_succeeded: list[int] = []
    sb_failed: list[int] = []
    sb_skipped: list[int] = []
    sb_canceled = False

    for idx, ep in enumerate(episodes):
        order = ep["order"]

        # 取消检查: 与章节路径同理, 只在"上一集写完、下一集还没发请求"这一刻能停。
        if await is_cancel_requested(draft_id):
            sb_canceled = True
            yield f'data: {json.dumps({"type": "log", "message": "已按你的请求停止, 已完成的集保持不动"})}\n\n'
            break

        # 检查是否已存在
        async with session_scope() as s:
            existing = (await s.execute(
                select(ScriptStoryboard).where(
                    ScriptStoryboard.draft_id == draft_id,
                    ScriptStoryboard.chapter_order == order
                )
            )).scalar_one_or_none()

            existing_shots = (existing.shots_json or []) if existing else []
            existing_has_content = isinstance(existing_shots, list) and len(existing_shots) > 0

            if existing and not getattr(existing, 'is_stale', 0) and existing_has_content and not force:
                yield f'data: {json.dumps({"type": "log", "message": f"第{order}章剧本已存在,跳过"})}\n\n'
                yield f'data: {json.dumps({"type": "progress", "current": idx + 1, "total": total})}\n\n'
                await tick_progress(draft_id, current=idx + 1, total=total, message=f"第{order}章剧本已存在,跳过")
                await record_episode(draft_id, order, "skipped", "已存在")
                sb_skipped.append(order)
                continue
            if existing and (getattr(existing, 'is_stale', 0) or not existing_has_content):
                reason = "已过期" if getattr(existing, 'is_stale', 0) else "为空"
                # ⚠ 与章节路径同理: 不再预删。旧分镜留到 save_candidate 覆写时归档,
                # 生成失败也不会把这一集的剧本弄丢。
                yield f'data: {json.dumps({"type": "log", "message": f"第{order}章剧本{reason},重新生成..."})}\n\n'
            elif existing and force:
                yield f'data: {json.dumps({"type": "log", "message": f"第{order}章剧本强制重写中..."})}\n\n'

        from_outline = not (ep.get("full_text") or "").strip()
        mode_label = "(大纲直生)" if from_outline else ""
        yield f'data: {json.dumps({"type": "log", "message": f"正在生成第{order}章剧本{mode_label}..."})}\n\n'
        await tick_progress(draft_id, current=idx, total=total, message=f"正在生成第{order}章剧本{mode_label}...")

        try:
            if from_outline:
                if not (ep.get("synopsis") or "").strip():
                    raise ValueError("该集既无正文也无大纲梗概")
                # 🔴 2026-10-05: 注入「上一集实际演过的内容」, 治相邻集重演。
                # 此前这条路径只喂上一集**梗概**, 模型看不见上一集写了什么,
                # 而每集梗概的核心冲突往往就是承接上一集断点的那句对话 →
                # 只能把同一场戏从头再演一遍(换命 ep1/ep2、此刻 ep4/ep5 即此)。
                # 循环是顺序的(见上方 for), 上一集已在轮末 save_candidate 落库。
                #
                # 🔴 2026-10-09: 改为**上下集都取原文**（用户已定结论）。
                # 取不到原文才退回该集大纲梗概；两者不会同时出现。
                _prev_sb = ""
                try:
                    _prev_led = ep.get("_ledger")
                    if _prev_led:
                        from .state_ledger import snapshot_text
                        _prev_sb = snapshot_text(_prev_led, order - 1)
                except Exception:
                    _prev_sb = ""
                _nb = {"prev": None, "next": None}
                try:
                    from .episode_render import (
                        collect_neighbor_originals, _synopsis_fallback,
                    )
                    _nb = await collect_neighbor_originals(
                        draft_id=draft_id, order=order, outline=outline)
                    for _k, _n in (("prev", order - 1), ("next", order + 1)):
                        if not _nb.get(_k) and _n >= 1:
                            _fb = _synopsis_fallback(outline, _n)
                            if _fb:
                                _nb[_k] = _fb
                except Exception as _pe:  # noqa: BLE001
                    # 取不到只是少一层衔接上下文，不该让整集失败；
                    # 但要留痕 —— 否则会静默退化成"看不见相邻集"的老行为。
                    logger.warning("第%d集: 取相邻集原文失败(本集仍会生成): %s", order, _pe)
                    _nb = {"prev": None, "next": None}
                _prev_text = _nb.get("prev") or ""
                _next_text = _nb.get("next") or ""
                # 2026-11-07：场景卡这一层停用，剧本直接按大纲正文分场。
                # 场景卡原本是 beats 的下游（一拍一张卡），beats 取消后它没有原料；
                # 而大纲正文（要素块）本身已经写清了这一集要演什么，
                # 再插一层派生卡只是把同样的内容搬两遍。`scene_card.py` 保留不删，
                # 想恢复时把下面几行接回去即可。
                shots = await generate_storyboard_from_outline(
                    episode_order=order,
                    synopsis=ep["synopsis"],
                    chapter_title=ep["title"],
                    context=ep.get("context", ""),
                    provider=model_provider,
                    draft_id=draft_id,
                    prev_text=_prev_text,
                    next_text=_next_text,
                    ledger_block=_prev_sb,
                    # 🔴 2026-10-09：把集纲契约与场景节拍接进来。
                    # 此前这条路只有一句 synopsis（实测扩写倍率 46~56 倍），
                    # 模型缺的整整一层"演什么"的决策只能自己编 ——
                    # 这正是用户反馈的"大纲里没有的内容"。
                    contract_block=build_contract_block(outline, order),
                    beats_block=build_beats_block(outline, order),
                    word_target=sb_word_target,
                )
            else:
                # P5: 携带该集状态账本快照, 保证分镜不引入已死角色
                _lb = ""
                try:
                    _led = ep.get("_ledger")
                    if _led:
                        from .state_ledger import snapshot_text
                        _lb = snapshot_text(_led, order - 1)
                except Exception:
                    _lb = ""
                shots = await generate_storyboard(
                    episode_order=order,
                    chapter_text=ep["full_text"],
                    chapter_title=ep["title"],
                    provider=model_provider,
                    draft_id=draft_id,
                    ledger_block=_lb,
                    word_target=sb_word_target,
                )

            # 保存: 统一走候选写入口(与章节路径同款) —— 先归档旧分镜、再覆写、递增 version。
            await save_candidate(
                draft_id=draft_id,
                order=order,
                stage="storyboard",
                content=shots,
                created_by="ai_generate",
            )

            sb_succeeded.append(order)
            await record_episode(draft_id, order, "done")
            yield f'data: {json.dumps({"type": "complete", "chapter_order": order, "shots_count": len(shots)})}\n\n'
            yield f'data: {json.dumps({"type": "progress", "current": idx + 1, "total": total})}\n\n'
            await tick_progress(draft_id, current=idx + 1, total=total, message=f"第{order}章剧本完成 ({len(shots)} 镜)")

            # 第五步：机械指标记录（不自动重写）
            # 2026-11-07 用户裁定：字数/对白/动作行等数值指标不应拿固定阈值机械判断并触发
            # 自动重写。原来的"验收单+自动闭环（最多三轮）"在用户不知情的情况下最多改 3 次
            # 稿子，使用的阈值是拍脑袋的经验值（对白35%/连续6行动作/字数0.7-1.4倍）。
            # 现在：只记指标到日志，由主线核对的 LLM 结合内容判断，不在生成管线里自动重写。
            try:
                from ..check.review import _sb_stats
                _stats = _sb_stats(shots)
                _word_target = sb_word_target or 3000
                await save_log(draft_id, "storyboard_stats",
                               f"第{order}集：字数={_stats.get('chars',0)}"
                               f"（目标~{_word_target}）"
                               f" 对白={int(_stats.get('dialogue_ratio',0)*100)}%"
                               f" 最长连续动作={_stats.get('max_action_run',0)}行"
                               f" 整场无对白={_stats.get('silent_scenes',0)}场",
                               "log", order)
            except Exception as _se:
                logger.warning("第%d集指标记录失败(不阻断): %s", order, _se)

            # 生成后安全扫描(非阻塞,只写警告日志)
            try:
                await _emit_post_check(draft_id, order, shots=shots)
            except Exception as ex:
                logger.warning("post_check storyboard %d failed: %s", order, ex)

        except Exception as e:
            logger.error(f"生成第{order}章剧本失败: {e}")
            sb_failed.append(order)
            await record_episode(draft_id, order, "failed", str(e))
            yield f'data: {json.dumps({"type": "error", "chapter_order": order, "error": str(e), "kept_old": existing is not None})}\n\n'
            await tick_progress(draft_id, current=idx + 1, total=total, message=f"第{order}章剧本失败: {str(e)[:80]}")

    # 取消的收尾与章节路径同款: 报成"没跑完"而不是成功。
    if sb_canceled:
        msg = f"已取消: {len(sb_succeeded)} 集剧本完成, 剩余 {total - len(sb_succeeded) - len(sb_skipped)} 集未处理"
        if sb_skipped:
            msg += f", {len(sb_skipped)} 集跳过"
        yield f'data: {json.dumps({"type": "done", "message": msg, "ok": False, "canceled": True, "succeeded": sb_succeeded, "failed": sb_failed, "skipped": sb_skipped})}\n\n'
        await finish_progress(draft_id, success=False, message=msg[:200])
    elif sb_failed:
        msg = f"批量剧本生成结束: {len(sb_succeeded)} 集成功, {len(sb_failed)} 集失败"
        if sb_skipped:
            msg += f", {len(sb_skipped)} 集跳过"
        msg += f"。失败集: {', '.join(str(x) for x in sb_failed)}"
        yield f'data: {json.dumps({"type": "done", "message": msg, "ok": False, "succeeded": sb_succeeded, "failed": sb_failed, "skipped": sb_skipped})}\n\n'
        await finish_progress(draft_id, success=False, message=msg[:200])
    else:
        msg = f"共 {len(sb_succeeded)} 集剧本生成完成"
        if sb_skipped:
            msg += f", {len(sb_skipped)} 集跳过"
        yield f'data: {json.dumps({"type": "done", "message": msg, "ok": True, "succeeded": sb_succeeded, "failed": [], "skipped": sb_skipped})}\n\n'
        await finish_progress(draft_id, success=True, message=msg[:200])
    await clear_cancel_request(draft_id)


async def direct_generate_storyboards(
    draft_id: int,
    user_input: str,
    episode_count: int
) -> AsyncGenerator[str, None]:
    """直接生成剧本(隐式生成大纲/章节)
    
    流程:
    1. 生成大纲
    2. 生成所有章节
    3. 生成所有剧本
    """
    import json
    from .outline_gen import generate_outline
    
    yield f'data: {json.dumps({"type": "log", "message": "开始直接生成剧本模式..."})}\n\n'
    yield f'data: {json.dumps({"type": "stage", "stage": "outline", "message": "正在生成大纲..."})}\n\n'
    
    try:
        # 读取用户在创建草稿时设置的每章目标字数(向创建时看齐; 用户之后也可在页面修改)。
        # 之前这里硬编码 5000, 导致"大纲直接生成剧本"完全忽略用户的字数设置。
        async with session_scope() as s0:
            _d0 = await s0.get(ScriptDraft, draft_id)
            _word_target = (_d0.chapter_word_target if _d0 else None) or DEFAULT_CHAPTER_WORD_TARGET

        # 1. 生成大纲
        outline = await generate_outline(
            user_input=user_input,
            chapter_count=episode_count,
            chapter_word_target=_word_target
        )

        async with session_scope() as s:
            draft = await s.get(ScriptDraft, draft_id)
            if draft:
                draft.outline = outline
                draft.outline_locked = 1
                draft.status = "outline_locked"
                await s.flush()
        
        chapter_cnt = len(outline.get("chapters", []))
        yield f'data: {json.dumps({"type": "log", "message": f"大纲生成完成,共{chapter_cnt}集"})}\n\n'
        yield f'data: {json.dumps({"type": "stage", "stage": "chapters", "message": "正在生成章节..."})}\n\n'
        
        # 2. 批量生成章节
        async for event in batch_generate_chapters(draft_id):
            yield event
        
        yield f'data: {json.dumps({"type": "stage", "stage": "storyboards", "message": "正在生成剧本..."})}\n\n'
        
        # 3. 批量生成剧本
        async for event in batch_generate_storyboards(draft_id):
            yield event
        
        yield f'data: {json.dumps({"type": "done", "message": "直接生成剧本完成"})}\n\n'
        
    except Exception as e:
        logger.error(f"直接生成剧本失败: {e}")
        yield f'data: {json.dumps({"type": "error", "error": str(e)})}\n\n'
