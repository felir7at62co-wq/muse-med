"""评审精修业务编排: 建任务 -> 后台逐集逐轮精修 -> 落库 -> 采纳覆盖。

抗重启: 进度写 critique_runs.progress_json; 本地协程型任务, 重启中断标记 interrupted。
并发: draft 级独占 (一个 draft 同时只允许一个 running run)。
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import select

from ..db import session_scope
from ..db.models import (
    ScriptChapter,
    ScriptStoryboard,
    ScriptDraft,
)
from . import orchestrator as O
from . import roles as R
from . import bible as B
from .models import CritiqueRun, CritiqueIssue
from .rules import storyboard_to_text
# 归档统一走 candidate_store.snapshot_in(带每集每阶段 10 版上限)。
# 之前本模块是裸 s.add(ScriptEpisodeHistory(...)), 没有上限。
from ..stages.candidate_store import snapshot_in

logger = logging.getLogger("critique")

# 全局并发闸 (限制同时运行的精修任务数), 锁定 500。
# 说明: 这是【精修模块独立的并发闸】, 与 stages/router.py 里"底层生成队列"的 500 是
# 两条不同通道 —— 之前把生成队列调到 500 时没覆盖到这里, 导致精修仍卡在 50。
# 精修是 IO 密集(全程等 LLM), 高并发不吃 CPU/内存; 500 足以让批量续跑的近百个精修
# 全部同时开跑, 不再互相堵塞排队。与底层生成并发对齐, 统一为 500。
_SEM = asyncio.Semaphore(500)
_CANCELLED: set[int] = set()


def request_cancel(run_id: int) -> None:
    _CANCELLED.add(run_id)


def is_cancelled(run_id: int) -> bool:
    return run_id in _CANCELLED


async def _set(run_id: int, **kw) -> None:
    async with session_scope() as s:
        run = await s.get(CritiqueRun, run_id)
        if not run:
            return
        for k, v in kw.items():
            setattr(run, k, v)
        run.updated_at = datetime.utcnow()


async def _load_episode_text(draft_id: int, order: int, source: str) -> tuple[str, bool]:
    """读一集当前稿。返回 (text, is_storyboard)。"""
    async with session_scope() as s:
        if source == "storyboard":
            sb = (await s.execute(
                select(ScriptStoryboard).where(
                    ScriptStoryboard.draft_id == draft_id,
                    ScriptStoryboard.chapter_order == order,
                )
            )).scalars().first()
            if sb:
                import json as _j
                return _j.dumps(sb.shots_json or [], ensure_ascii=False), True
            return "", True
        ch = (await s.execute(
            select(ScriptChapter).where(
                ScriptChapter.draft_id == draft_id,
                ScriptChapter.chapter_order == order,
            )
        )).scalars().first()
        return (ch.full_text if ch else "") or "", False


async def _list_episodes(draft_id: int, source: str) -> list[int]:
    async with session_scope() as s:
        Model = ScriptStoryboard if source == "storyboard" else ScriptChapter
        rows = (await s.execute(
            select(Model.chapter_order).where(Model.draft_id == draft_id).order_by(Model.chapter_order)
        )).scalars().all()
        return list(rows)


async def run_critique(run_id: int) -> None:
    """后台执行一次精修任务。"""
    async with _SEM:
        if is_cancelled(run_id):
            await _set(run_id, status="canceled", error="用户取消")
            _CANCELLED.discard(run_id)
            return
        await _set(run_id, status="running", progress=2)
        try:
            async with session_scope() as s:
                run = await s.get(CritiqueRun, run_id)
                if not run:
                    return
                draft_id = run.draft_id
                source = run.source
                intensity = run.intensity
                params = dict(run.params or {})
            editor_model = params.get("editor_model") or "gemini"
            episodes = params.get("episodes") or await _list_episodes(draft_id, source)
            if not episodes:
                await _set(run_id, status="failed", error="没有可精修的集")
                return

            # M5: 注入 admin 配置 (角色开关/权重/强度档模型)
            try:
                from .models import CritiqueConfig
                async with session_scope() as s:
                    cfg_row = await s.get(CritiqueConfig, 1)
                    R.set_runtime_config(cfg_row.config_json if cfg_row else None)
            except Exception as e:  # noqa: BLE001
                logger.warning("load critique_config failed (use defaults): %s", e)
                R.set_runtime_config(None)

            # 强度档已删除: 一律全量(3模型 + 全部主题轮)
            review_models = FULL_MODELS
            round_themes = R.ROUND_THEMES

            # 断点续跑: 载入已存结果, 跳过已完成的集 (resume 模式)。
            # 这样崩溃/中断后再次运行, 只补未完成的集, 不重复消耗已完成的。
            async with session_scope() as s:
                _run0 = await s.get(CritiqueRun, run_id)
                prior = dict((_run0.result_json or {}).get("episodes") or {}) if _run0 else {}
            result_by_ep: dict[int, dict] = {int(k): v for k, v in prior.items()}
            done_eps = set(result_by_ep.keys())

            board: dict = {
                "episodes": episodes, "round_themes": round_themes,
                "review_models": review_models, "events": [],
                "current": {}, "convergence": [],
                "resumed_from": sorted(done_eps) or None,
            }

            def emit(kind: str, **kw):
                ev = {"t": datetime.utcnow().isoformat(), "kind": kind, **kw}
                board["events"].append(ev)
                board["events"] = board["events"][-200:]  # 限长

            # 全剧文本 (圣经抽取 + 跨集审查共用)
            all_ep_texts: dict[int, str] = {}
            if len(episodes) >= 2:
                for ep in episodes:
                    txt, _ = await _load_episode_text(draft_id, ep, source)
                    if txt.strip():
                        all_ep_texts[ep] = txt

            # ── 防线一: 开篇整体审查 → 抽取《设定圣经》(唯一事实源) ──
            # 复用已有圣经 (断点续跑); 否则三模型抽取+裁决。失败则降级(不启用闸门)。
            bible = board.get("bible") or None
            if not bible and len(all_ep_texts) >= 2:
                try:
                    emit("bible_start", episodes=len(all_ep_texts))
                    await _set(run_id, progress_json=board)
                    bible = await B.extract_bible(
                        episodes_text=all_ep_texts, models=review_models, emit=emit,
                    )
                    if bible:
                        board["bible"] = bible
                        emit("bible_done",
                             chars=len(bible.get("characters") or []),
                             era=(bible.get("world") or {}).get("era", ""))
                        await _set(run_id, progress_json=board,
                                   result_json={"episodes": result_by_ep, "board": board, "bible": bible})
                except Exception as e:  # noqa: BLE001
                    logger.warning("bible extract failed (continue without gates): %s", e)

            # 桥段去重台账 (跨集累计, 支持续跑恢复)
            trope_ledger: dict = dict(board.get("trope_ledger") or {})

            # ── 全局问题待办表 (v2): {集号: [{id,source,severity,issue,evidence,fix_hint,status}]} ──
            # 总览(开始/中途/结束)只往这里"记账", 真正改写永远在处理对应集时单集执行, 防串集。
            ledger: dict = dict((result_by_ep and board.get("global_issues_ledger")) or {})
            board.setdefault("global_reviews", [])
            bible_ct = B.bible_constraint_text(bible) if bible else ""

            def _ledger_add(by_ep: dict[int, list[dict]], src: str):
                """把一次总览产出的"按集归类问题"并入 ledger(去重, 标 pending)。"""
                added = 0
                for tgt, items in (by_ep or {}).items():
                    bucket = ledger.setdefault(str(tgt), [])
                    seen = {(x.get("issue") or "")[:40] for x in bucket}
                    for it in items:
                        key = (it.get("issue") or "")[:40]
                        if key in seen:
                            continue
                        bucket.append({
                            "source": src, "severity": it.get("severity", "mid"),
                            "issue": it.get("issue", ""), "evidence": it.get("evidence", ""),
                            "fix_hint": it.get("fix_hint", ""), "status": "pending",
                        })
                        seen.add(key)
                        added += 1
                board["global_issues_ledger"] = ledger
                return added

            async def _run_overview(scope_text: dict[int, str], src: str):
                """跑一次全局总览(只读), 结果记账进 ledger; 返回新增问题数。"""
                if not bible or len(scope_text) < 2:
                    return 0
                emit("overview_start", source=src, episodes=sorted(scope_text.keys()))
                await _set(run_id, progress_json=board)
                try:
                    by_ep = await B.global_audit(
                        bible=bible, episodes_text=scope_text, models=review_models, emit=emit,
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning("overview(%s) failed: %s", src, e)
                    by_ep = {}
                n = _ledger_add(by_ep, src)
                board["global_reviews"].append({
                    "source": src, "scope": sorted(scope_text.keys()),
                    "found": n, "t": datetime.utcnow().isoformat(),
                })
                emit("overview_done", source=src, found=n)
                await _set(run_id, progress_json=board,
                           result_json={"episodes": result_by_ep, "board": board, "bible": bible})
                return n

            # ── 开始总览 (精修前) → 预警入 ledger, 逐集精修时前置注入 ──
            if bible and len(all_ep_texts) >= 2:
                await _run_overview(all_ep_texts, "start")

            total_units = len(episodes) * len(round_themes)
            done_units = 0
            MID_INTERVAL = 10  # 每 10 集一次中途总览
            done_since_mid = 0

            for ep in episodes:
                if is_cancelled(run_id):
                    break
                if ep in done_eps:
                    done_units += len(round_themes)
                    continue
                content, is_sb = await _load_episode_text(draft_id, ep, source)
                if not content.strip():
                    continue
                original = content
                ep_issues_all: list[dict] = []

                # 1) 多身份多轮审查(只评审收集, 不逐轮改写) — 在原文上收集本集全部意见
                #
                # D5.2: 阈值触发定向轮次。原先是固定 4 轮 × N 集无条件全跑，达标的集
                # 也照样烧 4 轮。现在跑完首轮(structure)后判断这集是否"达标"：
                #   - 首轮一条问题都没挑出来 => 达标，跳过余下的主题轮（省调用）
                #   - 只要有任何问题，就跑满全部主题轮（不达标的集才需要更多视角）
                # 判据刻意保守：宁可多烧一轮，也不要把有问题的集当达标跳过。
                ran_themes: list[str] = []

                for ridx, theme in enumerate(round_themes, start=1):
                    if is_cancelled(run_id):
                        break
                    if ridx > 1 and ran_themes and not ep_issues_all:
                        emit("round_skipped", episode=ep,
                             reason="首轮未发现任何问题，判定本集达标")
                        break
                    board["current"] = {"episode": ep, "round": ridx, "theme": theme}
                    emit("round_start", episode=ep, round=ridx, theme=theme)
                    await _set(run_id, progress_json=board)
                    issues = await O.review_episode(
                        content=content, theme=theme, models=review_models, emit=emit,
                    )
                    for it in issues:
                        it.setdefault("_round", ridx)
                        it.setdefault("_theme", theme)
                    ep_issues_all.extend(issues)
                    ran_themes.append(theme)
                    done_units += 1
                    await _set(run_id, progress=min(95, int(90 * done_units / total_units) + 2),
                               progress_json=board)
                # 提前退出时补齐进度计数, 避免进度条卡住
                done_units += max(0, len(round_themes) - len(ran_themes))

                # 2) 确定性闸门 (零模型成本, 零漏检)
                if bible:
                    try:
                        gate_issues = B.scan_against_bible(content, bible, episode=ep)
                        gate_issues += B.update_trope_ledger(trope_ledger, content, bible, episode=ep)
                        if gate_issues:
                            ep_issues_all.extend(gate_issues)
                            board["trope_ledger"] = trope_ledger
                            emit("gate_hits", episode=ep, count=len(gate_issues))
                    except Exception as _ge:  # noqa: BLE001
                        logger.warning("bible gate scan ep%s failed: %s", ep, _ge)

                # 3) 取本集 ledger 的 pending 全局预警(开始总览/已有中途总览发现的)
                pend = [x for x in ledger.get(str(ep), []) if x.get("status") == "pending"]
                global_warnings = "\n".join(
                    f"- [{x.get('severity','')}|{x.get('source','')}] {x.get('issue','')}"
                    f"（证据:{x.get('evidence','')}; 建议:{x.get('fix_hint','')}）"
                    for x in pend
                )

                # 持久化本集评审问题(审计/结果区理由标签)
                if ep_issues_all:
                    async with session_scope() as s:
                        for it in ep_issues_all:
                            s.add(CritiqueIssue(
                                run_id=run_id, episode_order=ep,
                                round=it.get("_round", 1), theme=it.get("_theme", ""),
                                role=it.get("role"), severity=it.get("severity"),
                                confidence=int(it.get("confidence", 0) or 0),
                                issue=it.get("issue"), evidence=it.get("evidence"),
                                fix_hint=it.get("fix_hint"), locator=it.get("locator"),
                            ))

                # 4) 总编辑(动笔前): 综合本集全部意见 + 圣经 + 全局预警 → 确定改写方案
                emit("chief_start", episode=ep, issues=len(ep_issues_all))
                await _set(run_id, progress_json=board)
                plan = await O.chief_edit_plan(
                    content=content, issues=ep_issues_all, model=editor_model,
                    bible_constraint=bible_ct, global_warnings=global_warnings,
                )
                order = O._plan_to_order(plan)
                if not order.get("items"):
                    # 总编辑无方案(或失败), 回退: 直接用机械排序的原始工单
                    order = await O.arbitrate(ep_issues_all, model=editor_model)
                n_items = len(order.get("items", []))
                emit("chief_done", episode=ep, plan=n_items, dropped=len(plan.get("dropped") or []))

                # 5) 执行编辑(一次): 直接落笔总编辑既定方案
                content_new = content
                if n_items > 0:
                    emit("editor_start", episode=ep)
                    edited = await O.edit_episode(
                        content=content, order=order, model=editor_model, is_storyboard=is_sb,
                        bible_constraint=bible_ct, chief_note=plan.get("note", ""),
                    )
                    nt = edited.get("new_text") or content
                    if not isinstance(nt, str):
                        import json as _jj
                        try:
                            nt = _jj.dumps(nt, ensure_ascii=False)
                        except Exception:  # noqa: BLE001
                            nt = str(nt)
                    content_new = nt
                    emit("editor_done", episode=ep,
                         applied=len(edited.get("applied", []) or []),
                         rejected=len(edited.get("rejected", []) or []))

                # 本集 ledger pending 预警视为已在动笔时处理 → 标 resolved
                for x in ledger.get(str(ep), []):
                    if x.get("status") == "pending":
                        x["status"] = "resolved"
                board["global_issues_ledger"] = ledger

                result_by_ep[ep] = {
                    "original": original,
                    "refined": content_new,
                    "changed": content_new.strip() != original.strip(),
                    "issue_count": len(ep_issues_all),
                    "is_storyboard": is_sb,
                    "chief_plan": plan.get("plan", []),
                    "chief_note": plan.get("note", ""),
                    "edits": [{
                        "round": 0, "theme": "chief",
                        "items": order.get("items", []),
                        "applied": [], "rejected": plan.get("dropped", []),
                    }],
                }
                await _set(run_id, result_json={"episodes": result_by_ep, "board": board, "bible": bible})

                # 6) 每满 N 集 → 中途总览(只看已精修的这一段, 记账进 ledger)
                done_since_mid += 1
                if done_since_mid >= MID_INTERVAL:
                    done_since_mid = 0
                    seg = {e: (result_by_ep[e].get("refined") or "")
                           for e in result_by_ep if not result_by_ep[e].get("audit_fixed")}
                    await _run_overview(seg, f"mid@ep{ep}")

            # ── 结束总览 + 末尾统一定向补修 (v2) ──
            # 结束总览记账, 然后遍历 ledger 仍 pending 的集, 逐集(单集输入)定向补修, 防串集。
            if not is_cancelled(run_id) and bible and len(result_by_ep) >= 2:
                try:
                    final_text = {e: (d.get("refined") or "") for e, d in result_by_ep.items()}
                    await _run_overview(final_text, "final")

                    # 收集仍 pending 的集 (中途/结束总览发现、尚未处理的)
                    pending_eps = sorted(
                        int(k) for k, v in ledger.items()
                        if any(x.get("status") == "pending" for x in v) and int(k) in result_by_ep
                    )
                    emit("repair_phase_start", episodes=pending_eps)
                    await _set(run_id, progress_json=board)
                    for ep in pending_eps:
                        if is_cancelled(run_id):
                            break
                        data = result_by_ep[ep]
                        cur_text = data.get("refined") or ""
                        if not cur_text:
                            continue
                        pend = [x for x in ledger.get(str(ep), []) if x.get("status") == "pending"]
                        warnings = "\n".join(
                            f"- [{x.get('severity','')}] {x.get('issue','')}"
                            f"（证据:{x.get('evidence','')}; 建议:{x.get('fix_hint','')}）"
                            for x in pend
                        )
                        # 单集输入: 总编辑出方案 → 编辑改写 → 只覆盖本集 (物理上不可能串集)
                        emit("repair_start", episode=ep, issues=len(pend))
                        plan = await O.chief_edit_plan(
                            content=cur_text, issues=[
                                {"severity": x.get("severity", "mid"), "role": x.get("source", "overview"),
                                 "issue": x.get("issue", ""), "evidence": x.get("evidence", ""),
                                 "fix_hint": x.get("fix_hint", "")} for x in pend
                            ], model=editor_model, bible_constraint=bible_ct, global_warnings=warnings,
                        )
                        order = O._plan_to_order(plan)
                        if order.get("items"):
                            edited = await O.edit_episode(
                                content=cur_text, order=order, model=editor_model,
                                is_storyboard=(source == "storyboard"),
                                bible_constraint=bible_ct, chief_note=plan.get("note", ""),
                            )
                            nt = edited.get("new_text") or cur_text
                            if not isinstance(nt, str):
                                import json as _jj
                                try:
                                    nt = _jj.dumps(nt, ensure_ascii=False)
                                except Exception:  # noqa: BLE001
                                    nt = str(nt)
                            data["refined"] = nt
                            data["changed"] = nt.strip() != (data.get("original") or "").strip()
                            data["audit_fixed"] = True
                        # 标 resolved (同集只补修一次, 防抖)
                        for x in ledger.get(str(ep), []):
                            x["status"] = "resolved"
                        board["global_issues_ledger"] = ledger
                        emit("repair_done", episode=ep)
                        await _set(run_id, result_json={"episodes": result_by_ep, "board": board, "bible": bible})
                    emit("repair_phase_done", episodes=pending_eps)
                except Exception as e:  # noqa: BLE001
                    logger.warning("final overview/repair phase failed (continue): %s", e)

            if is_cancelled(run_id):
                await _set(run_id, status="canceled", error="用户取消",
                           result_json={"episodes": result_by_ep, "board": board, "bible": bible})
                _CANCELLED.discard(run_id)
                return

            await _set(run_id, status="succeeded", progress=100,
                       result_json={"episodes": result_by_ep, "board": board, "bible": bible})
            logger.info("critique run %s done, %d episodes", run_id, len(result_by_ep))
        except Exception as e:  # noqa: BLE001
            logger.exception("critique run %s failed", run_id)
            await _set(run_id, status="failed", error=str(e))


async def create_and_run(
    *, user_id: int, draft_id: int, source: str, intensity: str,
    episodes: Optional[list[int]], editor_model: str, focus: Optional[str],
) -> int:
    """建任务 + 起后台协程; draft 级独占 (有 running 则拒绝)。"""
    async with session_scope() as s:
        existing = (await s.execute(
            select(CritiqueRun).where(
                CritiqueRun.draft_id == draft_id,
                CritiqueRun.status.in_(("pending", "running")),
            )
        )).scalars().first()
        if existing:
            raise ValueError("该草稿已有进行中的精修任务")
        run = CritiqueRun(
            user_id=user_id, draft_id=draft_id, source=source, intensity=intensity,
            status="pending", progress=0,
            params={
                "episodes": episodes, "editor_model": editor_model,
                "focus": focus, "intensity": intensity, "source": source,
            },
        )
        s.add(run)
        await s.flush()
        run_id = run.id
    asyncio.create_task(run_critique(run_id))
    return run_id


async def apply_run(run_id: int, user_id: int, episode_orders: Optional[list[int]]) -> dict:
    """采纳覆盖: 把精修后的稿覆盖回 chapters/storyboards, 覆盖前存历史版本。"""
    async with session_scope() as s:
        run = await s.get(CritiqueRun, run_id)
        if not run or run.user_id != user_id:
            raise ValueError("任务不存在或无权限")
        if run.status != "succeeded":
            raise ValueError("仅成功的任务可采纳")
        result = dict(run.result_json or {})
        draft_id = run.draft_id
        source = run.source
    eps = (result.get("episodes") or {})
    applied = []
    skipped = []
    import json as _j
    import re as _re

    def _repair_json(s: str) -> str:
        """修复编辑模型(尤其剧本 JSON)常见的结构性缺陷, 避免整集被丢弃。

        这些都是"内容完整、仅标点/转义损坏"的可逆缺陷, 故用确定性正则修复,
        不需要重新调用模型精修。已知三类 (来自真实任务样本):
          D1 键的起始引号丢失/被写成反斜杠: `{\\type":` / `{type":` / `,\\content":`
             -> `{"type":` / `,"content":`
          D2 值内裸双引号对(模型把空括号写成带引号): `("")` / `（""）` -> `()` / `（）`
          D3 元素第二个键名缺失, 冒号顶替逗号: `{"type": "action": "..."}`
             -> `{"type": "action", "content": "..."}`
        """
        # D1
        s = _re.sub(r'([{,]\s*)\\?([A-Za-z_][A-Za-z0-9_]*)("\s*:)', r'\1"\2\3', s)
        # D2
        s = s.replace('("")', '()').replace('（""）', '（）')
        # D3
        s = _re.sub(r'("type"\s*:\s*"[A-Za-z_]+")\s*:\s*(")', r'\1, "content": \2', s)
        return s

    def _coerce_json(text: str):
        """从编辑输出里解析 JSON (容忍 ```json 围栏 / 前后噪声 / 键引号损坏)。"""
        if isinstance(text, (list, dict)):
            return text
        s = str(text or "").strip()
        m = _re.search(r"```(?:json)?\s*(.+?)\s*```", s, _re.DOTALL)
        if m:
            s = m.group(1).strip()
        # 先截到最外层数组/对象范围, 去掉前后噪声
        i, j = s.find("["), s.rfind("]")
        if i != -1 and j != -1 and j > i:
            s = s[i:j + 1]
        for candidate in (s, _repair_json(s)):
            try:
                return _j.loads(candidate)
            except Exception:  # noqa: BLE001
                continue
        return None

    for ep_str, data in eps.items():
        ep = int(ep_str)
        if episode_orders and ep not in episode_orders:
            continue
        if not data.get("changed"):
            continue
        refined = data.get("refined")
        if not refined:
            continue
        async with session_scope() as s:
            if source == "storyboard":
                sb = (await s.execute(
                    select(ScriptStoryboard).where(
                        ScriptStoryboard.draft_id == draft_id,
                        ScriptStoryboard.chapter_order == ep,
                    )
                )).scalars().first()
                if not sb:
                    skipped.append(ep)
                    continue
                parsed = _coerce_json(refined)
                if parsed is None:
                    # 解析失败不静默吞掉, 记入 skipped 让前端可见
                    logger.warning("critique apply: ep%s storyboard refined unparseable, skip", ep)
                    skipped.append(ep)
                    continue
                # 存历史 (可回滚)。走 candidate_store.snapshot_in: 带上限
                # (每集每阶段 10 版), 与章节/剧本路径一致。原先是裸 s.add, 无上限。
                await snapshot_in(
                    s, draft_id=draft_id, order=ep, stage="storyboard",
                    content=sb.shots_json or [], version=(sb.version or 1),
                    created_by="critique",
                )
                sb.shots_json = parsed
                sb.version = (sb.version or 1) + 1
                sb.updated_at = datetime.utcnow()
            else:
                ch = (await s.execute(
                    select(ScriptChapter).where(
                        ScriptChapter.draft_id == draft_id,
                        ScriptChapter.chapter_order == ep,
                    )
                )).scalars().first()
                if not ch:
                    continue
                await snapshot_in(
                    s, draft_id=draft_id, order=ep, stage="chapter",
                    content={"full_text": ch.full_text or ""}, version=(ch.version or 1),
                    created_by="critique",
                )
                ch.full_text = refined
                ch.word_count = len(refined)
                ch.version = (ch.version or 1) + 1
                ch.updated_at = datetime.utcnow()
                # 下游标记 stale
                sb = (await s.execute(
                    select(ScriptStoryboard).where(
                        ScriptStoryboard.draft_id == draft_id,
                        ScriptStoryboard.chapter_order == ep,
                    )
                )).scalars().first()
                if sb:
                    sb.is_stale = 1
        applied.append(ep)
    # 仅当确有集被覆盖才标记已采纳; 否则保持未采纳, 前端不会误显示"已覆盖"
    if applied:
        await _set(run_id, applied=1)
    return {"applied_episodes": applied, "skipped_episodes": skipped}


# ======================================================================
# 设定圣经: 独立构建 / 读取 / 人工微调 (v2, 常驻 ScriptDraft.story_bible_json)
# ======================================================================

# 全量精修固定模型组 (强度档已删除, 一律全量)
FULL_MODELS = ["gemini", "deepseek", "gpt5"]


async def build_story_bible(draft_id: int, user_id: int, *, source: str = "chapter") -> dict:
    """通读全剧 → 三模型抽取+裁决 → 落库 ScriptDraft.story_bible_json。返回圣经 dict。"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or (d.user_id and d.user_id != user_id):
            raise ValueError("草稿不存在或无权限")
    episodes = await _list_episodes(draft_id, source)
    if not episodes:
        # 章节没有就退回剧本源
        source = "storyboard" if source == "chapter" else "chapter"
        episodes = await _list_episodes(draft_id, source)
    if len(episodes) < 1:
        raise ValueError("没有可用于构建圣经的章节/剧本")
    ep_texts: dict[int, str] = {}
    for ep in episodes:
        txt, _ = await _load_episode_text(draft_id, ep, source)
        if txt.strip():
            ep_texts[ep] = txt
    if not ep_texts:
        raise ValueError("章节/剧本内容为空, 无法构建圣经")
    bible = await B.extract_bible(episodes_text=ep_texts, models=FULL_MODELS, emit=None)
    if not bible:
        raise ValueError("圣经抽取失败, 请稍后重试")
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        d.story_bible_json = bible
        d.updated_at = datetime.utcnow()
    return bible


async def get_story_bible(draft_id: int, user_id: int) -> dict:
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or (d.user_id and d.user_id != user_id):
            raise ValueError("草稿不存在或无权限")
        return d.story_bible_json or {}


async def update_story_bible(draft_id: int, user_id: int, bible: dict) -> dict:
    """人工微调后整体覆盖保存 (前端总览页编辑后调用)。补全派生字段。"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or (d.user_id and d.user_id != user_id):
            raise ValueError("草稿不存在或无权限")
        b = dict(bible or {})
        try:
            B._normalize_bible(b)  # 补 name_whitelist 等派生字段
        except Exception:  # noqa: BLE001
            pass
        d.story_bible_json = b
        d.updated_at = datetime.utcnow()
        return b


async def cancel_run(run_id: int, user_id: int) -> str:
    async with session_scope() as s:
        run = await s.get(CritiqueRun, run_id)
        if not run or run.user_id != user_id:
            raise ValueError("任务不存在或无权限")
        if run.status in ("succeeded", "failed", "canceled", "interrupted"):
            return run.status
        request_cancel(run_id)
        run.status = "canceled"
        run.error = "用户取消"
        run.updated_at = datetime.utcnow()
        return "canceled"