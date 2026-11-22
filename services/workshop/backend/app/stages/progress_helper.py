"""批量生成进度持久化工具

把 batch_generate_* 流程的实时进度写到 script_drafts.outline.progress,
这样:
- 前端刷新后还能看到进度条(不再是内存 state)
- 多标签打开、多人同时查看,看到的都是同一份权威数据
- 任务卡死超过心跳阈值可以被识别为"疑似中断"

进度结构 (outline.progress):
{
  "stage": "chapters" | "storyboards" | "outline" | "video" | "idle",
  "sub_stage": "running" | "done" | "failed" | "",
  "current": 7,              # 当前完成个数
  "total": 20,               # 总数
  "started_at": "2026-05-13T10:00:00Z",
  "last_beat_at": "2026-05-13T10:05:13Z",
  "last_message": "正在生成第 7 章...",
  "task_id": "abc123-uuid",   # 用于幂等保护,同 draft 不允许同时两个任务
  "eps": [                    # 逐集结果, 供状态栏"点开看是哪几集"
    {"order": 1, "state": "done"},
    {"order": 2, "state": "skipped", "reason": "已存在"},
    {"order": 3, "state": "failed", "reason": "超时"}
  ],
  "cancel_requested": false   # 用户点了取消, 循环在下一集边界退出
}
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from ..db import ScriptDraft, session_scope
from ..db.models import AgentJob, RewriteJob

logger = logging.getLogger("progress_helper")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def start_progress(
    draft_id: int,
    stage: str,
    total: int,
    task_id: str = "",
) -> None:
    """标记进度为 running,并清零 current"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return
        outline = dict(d.outline or {})
        outline["progress"] = {
            "stage": stage,
            "sub_stage": "running",
            "current": 0,
            "total": int(total or 0),
            "started_at": _now_iso(),
            "last_beat_at": _now_iso(),
            "last_message": f"开始执行 {stage}...",
            "task_id": task_id,
        }
        d.outline = outline
        flag_modified(d, "outline")


async def tick_progress(
    draft_id: int,
    *,
    current: int | None = None,
    total: int | None = None,
    message: str = "",
) -> None:
    """每一步完成时调用,更新 current / last_beat_at / last_message"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return
        outline = dict(d.outline or {})
        p = dict(outline.get("progress") or {})
        if current is not None:
            p["current"] = int(current)
        if total is not None:
            p["total"] = int(total)
        p["last_beat_at"] = _now_iso()
        if message:
            p["last_message"] = message[:200]
        p.setdefault("sub_stage", "running")
        outline["progress"] = p
        d.outline = outline
        flag_modified(d, "outline")


async def finish_progress(
    draft_id: int,
    success: bool = True,
    message: str = "",
) -> None:
    """标记进度为 done/failed"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return
        outline = dict(d.outline or {})
        p = dict(outline.get("progress") or {})
        p["sub_stage"] = "done" if success else "failed"
        p["last_beat_at"] = _now_iso()
        if message:
            p["last_message"] = message[:200]
        # 完成时 current 置为 total
        if success and "total" in p:
            p["current"] = p["total"]
        outline["progress"] = p
        d.outline = outline
        flag_modified(d, "outline")


def is_progress_running(progress: dict | None, stale_threshold_s: int = 180) -> bool:
    """判断一个 progress 是否仍在运行中。
    规则: sub_stage=running 且 last_beat_at 距现在 < stale_threshold_s 秒。
    """
    if not isinstance(progress, dict):
        return False
    if (progress.get("sub_stage") or "") != "running":
        return False
    beat_at = progress.get("last_beat_at") or ""
    if not beat_at:
        return False
    try:
        t = datetime.fromisoformat(beat_at.replace("Z", "+00:00"))
    except Exception:
        return False
    now = datetime.now(timezone.utc)
    delta = (now - t).total_seconds()
    return 0 <= delta < stale_threshold_s


async def get_progress_snapshot(draft_id: int) -> dict:
    """读出当前进度快照,返回 {stage,current,total,sub_stage,running,last_beat_at,last_message,task_id,eps,cancel_requested}"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or not isinstance(d.outline, dict):
            return {"stage": "idle", "sub_stage": "", "current": 0, "total": 0, "running": False,
                    "eps": [], "cancel_requested": False}
        p = d.outline.get("progress") or {}
        return {
            "stage": p.get("stage") or "idle",
            "sub_stage": p.get("sub_stage") or "",
            "current": int(p.get("current") or 0),
            "total": int(p.get("total") or 0),
            "started_at": p.get("started_at") or "",
            "last_beat_at": p.get("last_beat_at") or "",
            "last_message": p.get("last_message") or "",
            "task_id": p.get("task_id") or "",
            "running": is_progress_running(p),
            # 逐集结果 —— 状态栏展开后画"哪几集成了/跳过/失败"用。
            # 只在 batch_gen 的循环里由 record_episode 写, 其他 stage 可能为空数组。
            "eps": list(p.get("eps") or []),
            "cancel_requested": bool(p.get("cancel_requested")),
        }


# ---------------------------------------------------------------------------
# 逐集结果 + 取消 (2026-10-06 加)
#
# 背景: 批量生成此前只写 current/total, 用户点开只能看到一个 38/50 的数字,
# 说不出"到底哪几集没成"。而批量任务走的是进程内 _running_tasks + 这里的
# outline.progress, **不建 AgentJob**, 所以队列那套取消/查明细的机制它一样都借不到。
# 这两个函数就是给批量路径补上"看得见明细"和"停得下来"。
# ---------------------------------------------------------------------------

#: eps 数组的封顶长度。一集一条记录, 极端草稿(几百集)不至于把 outline JSON 撑爆。
#: 超出后不再追加 —— 状态栏是"看个大概", 不是完整台账。
_EPS_LOG_CAP = 400


async def record_episode(draft_id: int, order: int, state: str, reason: str = "") -> None:
    """记一集的最终结果到 outline.progress.eps。

    state: done | failed | skipped
    ⚠️ 调用方必须**每集只调一次**(循环的每个出口), 否则同一集会出现两条记录。
    写入用"同 order 覆盖"而不是追加, 这样即使被重复调用也只会更新那一条。
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or not isinstance(d.outline, dict):
            return
        outline = dict(d.outline)
        p = dict(outline.get("progress") or {})
        eps = [e for e in (p.get("eps") or []) if isinstance(e, dict)]
        rec: dict[str, Any] = {"order": int(order), "state": state}
        if reason:
            rec["reason"] = reason[:80]
        # 同 order 覆盖, 顺序按 order 排 —— 前端直接渲染, 不用自己排
        eps = [e for e in eps if int(e.get("order") or 0) != int(order)]
        if len(eps) < _EPS_LOG_CAP:
            eps.append(rec)
        eps.sort(key=lambda e: int(e.get("order") or 0))
        p["eps"] = eps
        outline["progress"] = p
        d.outline = outline
        flag_modified(d, "outline")


async def request_cancel(draft_id: int) -> bool:
    """请求取消当前批量任务。返回是否确实有一个在跑的批量进度被标记。

    只是**置标志**, 真正的退出由 batch_gen 的循环在下一集边界完成 ——
    单次 LLM 调用无法中途打断。所以这个函数返回 True 只代表"信号已发出",
    不代表"已经停了"; UI 必须如实区分这两个状态(见 batch/cancel 端点)。
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or not isinstance(d.outline, dict):
            return False
        outline = dict(d.outline)
        p = dict(outline.get("progress") or {})
        if (p.get("sub_stage") or "") != "running":
            return False
        p["cancel_requested"] = True
        p["last_message"] = "已收到取消请求, 将在当前这一集结束后停止"
        outline["progress"] = p
        d.outline = outline
        flag_modified(d, "outline")
        return True


async def is_cancel_requested(draft_id: int) -> bool:
    """循环每集开头调用: 用户是否请求了取消。

    ⚠️ 刻意**不缓存、每次现查**。缓存意味着要么取消延迟生效, 要么为了及时
    而在进程里存一份状态 —— 而批量任务本就是进程内的, 重启即丢, 存库才是
    唯一在"刷新页面/换标签页"下依然成立的地方。
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or not isinstance(d.outline, dict):
            return False
        p = d.outline.get("progress") or {}
        return bool(p.get("cancel_requested"))


async def clear_cancel_request(draft_id: int) -> None:
    """新一轮任务开始时清掉上一轮的取消标志, 否则新任务一启动就自杀。"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or not isinstance(d.outline, dict):
            return
        outline = dict(d.outline)
        p = dict(outline.get("progress") or {})
        if p.pop("cancel_requested", None) is not None:
            outline["progress"] = p
            d.outline = outline
            flag_modified(d, "outline")


async def reap_stale_progress(draft_id: int, *, min_age_seconds: int = 300) -> bool:
    """把停在 ``sub_stage='running'`` 却早已没有心跳的进度收成 failed。返回是否改动。

    ## 为什么需要（2026-10-22）

    `sub_stage` 只有 batch_gen 的循环会写回 done/failed。进程重启、容器重建、
    生成器抛异常没走 finish_progress —— 这三种情况都会让 progress **永远停在
    running**。实测生产上 20+ 部草稿从 2026-07 起就是这样。

    后果不是"显示不准"，是**实际锁死**：
      · `_check_running_or_409` 会拦 —— 用户点补全直接 409；
      · 而 `is_progress_running` 只看 180 秒心跳窗口，明明判它是死的；
      · 于是一边判死、一边拦人，谁也说不清为什么点不动。

    `POST /system/reset-stuck` 此前只重置 `ScriptDraft.status`，**没碰 outline.progress**，
    所以跑完那个管理员按钮，这些草稿照样点不动。

    ⚠️ 阈值刻意比 `is_progress_running` 的 180 秒宽：调用方可能是"顺手清一下"，
    而真在跑的任务每一集都在 tick。用同一个阈值会让刚起第一集、还没来得及
    写心跳的那几十秒变成可趁之机。
    """
    now = datetime.now(timezone.utc)
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d or not isinstance(d.outline, dict):
            return False
        outline = dict(d.outline)
        p = dict(outline.get("progress") or {})
        if (p.get("sub_stage") or "") != "running" or is_progress_running(p):
            return False
        beat_at = p.get("last_beat_at") or p.get("started_at") or ""
        try:
            t = datetime.fromisoformat(str(beat_at).replace("Z", "+00:00"))
        except Exception:
            t = None
        if t is not None and (now - t).total_seconds() < min_age_seconds:
            return False
        p["sub_stage"] = "failed"
        p["last_message"] = ("这个任务已中断（进程重启或异常退出），状态由管理员重置。"
                             "已完成的集都在，可以重新点补全继续。")
        outline["progress"] = p
        d.outline = outline
        flag_modified(d, "outline")
        return True


# ---------------------------------------------------------------------------
# 「这部草稿现在到底在跑什么」—— 两套任务机制的**唯一汇总口径**
#
# 为什么不写在 chat_jobs 或 router 里：这两边各自只看得见自己那一套，
# 正是 2026-10-22 事故的结构性原因（详见 draft_activity 的 docstring）。
# 放在 progress_helper 是因为它是两边都无副作用可 import 的底层模块
# （只依赖 db，不依赖 agent / jobs，不会成环）。
# ---------------------------------------------------------------------------

async def draft_activity(draft_id: int) -> dict:
    """汇总这部草稿上**所有**正在跑的重任务，不管它属于哪套机制。

    ## 为什么必须汇总（2026-10-22 生产事故）

    平台上同时存在两套互不相通的任务机制：

    | 机制 | 谁启动 | 状态存在哪 | 互斥检查函数 |
    |---|---|---|---|
    | 进程内批量 | 顶栏「补全 / 强制重写」 | `outline.progress` + `_running_tasks` | `_check_running_or_409` |
    | 队列作业 | 对话栏动作 / Agent 工具 | `agent_jobs` | `has_active_job` |

    两个检查函数**各看各的**，于是同一部草稿可以同时跑两条覆写型任务。
    实测事故（生产草稿 2679）：

      03:24:35 Agent 建了 gen_storyboards #239（start=18,end=20）
      03:39:54 用户点「补全剧本」→ 进程内批量从第 1 集开始写
      03:40-03:52 批量把 18~20 集写完了
      03:52     #239 才被 worker 领到 → 待办集合为空 → done + generated:0

    用户看到"已启动作业 #239"，实际上**一集没写、一次模型调用都没发**。
    这不是慢，是两条路互相踩。

    返回::

        {
          "busy": bool,              # 任意一边在跑
          "sources": [ {...}, ... ], # 每一项 {mechanism, kind, label, ...}
          "repeated": bool,          # 两边都在跑（正是事故形态）
          "summary": "…",            # 给人看的一句话；空闲时为空串
        }

    ⚠️ 判活口径刻意与各自机制内部一致，**不统一阈值**：
      · 进程内批量：`is_progress_running`（last_beat_at < 180s）
      · 队列作业：status ∈ 活跃集合（租约由 requeue_expired 负责回收）
    统一阈值会让"刚启动还没写第一集心跳"的任务被误判为死任务。
    """
    sources: list[dict] = []

    # ── 1) 进程内批量任务（outline.progress） ────────────────────────────
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        outline = dict(d.outline or {}) if d else {}
    p = outline.get("progress") or {}
    if is_progress_running(p):
        sources.append({
            "mechanism": "inline",
            "kind": p.get("stage") or "",
            "label": _STAGE_CN.get(p.get("stage") or "", p.get("stage") or "生成"),
            "current": int(p.get("current") or 0),
            "total": int(p.get("total") or 0),
            "last_message": p.get("last_message") or "",
            "last_beat_at": p.get("last_beat_at") or "",
            "cancel_requested": bool(p.get("cancel_requested")),
            "cancellable": True,
            "cancel_how": "POST /v1/stages/drafts/{id}/batch/cancel（当前这一集跑完后停）",
        })

    # ── 2) 队列作业（agent_jobs） ────────────────────────────────────────
    #
    # 状态集合与 `agent/chat_jobs._ACTIVE_STATES` 逐字一致：那边不能 import 这里
    # 之外的东西（会成环），所以两边各写一份，改一处必须改另一处 ——
    # 漏掉 analyzing/rewriting/pending 会让"正在跑"的作业在这里看不见。
    async with session_scope() as s:
        rows = (await s.execute(
            select(AgentJob).where(
                AgentJob.draft_id == draft_id,
                AgentJob.status.in_(_AGENT_ACTIVE_STATES),
            ).order_by(AgentJob.id.desc())
        )).scalars().all()
    for j in rows:
        sources.append({
            "mechanism": "queue",
            "kind": j.kind,
            "label": _JOB_CN.get(j.kind, j.kind),
            "job_id": j.id,
            "status": j.status,
            "progress": j.progress,
            "last_message": j.progress_note or "",
            "queued_since": j.created_at.isoformat() if j.created_at else "",
            "cancellable": True,
            "cancel_how": f"POST /v1/agent/jobs/{j.id}/cancel",
        })

    # ── 3) 整本精修（rewrite_jobs，没有租约，**必须靠心跳判活**） ─────────
    #
    # ⚠️ 这里只看 status 会重犯 2026-10-08 那个事故：RewriteJob 没有任何机制把自己
    # 改成终态，一次 worker 重启就能让一行永远停在 rewriting。那时该草稿上的
    # 生成/精修/修复会**全部被拦**，而那个作业几小时前就死了 —— 用户看到的是
    # "按钮用不了"。判活口径沿用 `chat_jobs._rewrite_still_alive`（同一份常量
    # rewrite.service.REWRITE_STALE_SECONDS），不要在这里另立阈值。
    now_naive = datetime.now(timezone.utc).replace(tzinfo=None)
    async with session_scope() as s:
        jobs_rows = (await s.execute(
            select(RewriteJob).where(
                RewriteJob.draft_id == draft_id,
                RewriteJob.status.in_(("running", "analyzing", "rewriting")),
            ).order_by(RewriteJob.id.desc())
        )).scalars().all()
    for r in jobs_rows:
        last = r.heartbeat_at or r.created_at
        if last is not None:
            if last.tzinfo is not None:
                last = last.replace(tzinfo=None)
            if (now_naive - last).total_seconds() > _rewrite_stale_seconds():
                continue          # 尸体：不算在跑（reap_stale_rewrite_jobs 会收掉它）
        sources.append({
            "mechanism": "rewrite",
            "kind": "rewrite_script",
            "label": "整本精修",
            "job_id": r.id,
            "status": r.status,
            "cancellable": True,
            "cancel_how": f"POST /v1/agent/jobs/{r.id}/cancel（精修作业 id）",
        })

    # ── 4) Agent 运行本身（agent_runs） ───────────────────────────────────
    #
    # ⚠️ 这一条**不拦**新任务（`blocks: False`），只负责「让人看见」。
    #
    # 为什么必须列出来：Agent 的一轮运行有三个阶段，其中 `awaiting_approval`
    # 是**最不像在跑、实际却没结束**的那个 —— worker 已经释放、库里没有 agent_jobs
    # 行、界面上什么都不动。2026-10-22 生产上三个用户就卡在这里（分别 1 天、20 小时、
    # 10 小时），管理员查「作业」只看到空的，于是判定成"他们根本没发起过生成"。
    # 真相是他们发起了、Agent 停在审批点没人点，而**没有任何地方显示这件事**。
    #
    # 为什么用 blocks=False：审批点是"等你拍板"，此刻没有任何东西在写库。
    # 如果它也算 busy，一条一周前没处理的待审批会让这部草稿**永远无法生成**，
    # 那是拿更坏的问题换更小的问题。用户真去批准时，工具提交那一步有
    # `start_generate` 的 draft_activity 检查兜底，不会因为这里放行就踩车。
    try:
        from ..agent_engine.heal import heal_runs
        from ..agent_engine.models import AgentRun
        async with session_scope() as s:
            ids = (await s.execute(select(AgentRun.id).where(
                AgentRun.draft_id == draft_id,
                AgentRun.status.in_(("queued", "running", "awaiting_approval"))))).scalars().all()
        # 先自愈（2026-10-28）：「等你确认」却一个待确认项都没有的运行，原先会让这一行
        # 提示永远挂着，用户在对话栏里找不到任何可点的卡片。
        if ids:
            await heal_runs(list(ids))
        async with session_scope() as s:
            runs = (await s.execute(
                select(AgentRun).where(
                    AgentRun.draft_id == draft_id,
                    AgentRun.status.in_(("queued", "running", "awaiting_approval")),
                ).order_by(AgentRun.id.desc())
            )).scalars().all()
        for r in runs:
            sources.append({
                "mechanism": "agent",
                "kind": "agent_run",
                "label": "Agent 运行" + ("（等你确认）" if r.status == "awaiting_approval" else ""),
                "job_id": r.id,
                "status": r.status,
                "awaiting_approval": r.status == "awaiting_approval",
                "last_message": (r.message or "")[:80],
                # 停在审批点的那一轮属于哪个会话：可能不是用户眼前开着的那个，
                # 提示里要说清楚，否则"去对话栏点确认"找不到卡片。
                "conversation_id": r.conversation_id,
                "started_at": r.created_at.isoformat() if r.created_at else "",
                # 见上：审批点不占位，不让一条陈旧的待审批把草稿锁死。
                "blocks": False,
                "cancellable": True,
                "cancel_how": f"POST /v1/agent-engine/runs/{r.id}/cancel",
            })
    except Exception:                      # noqa: BLE001
        # 这一条是"锦上添花"的信息源，查不到不应连累前面的判活。
        logger.warning("draft_activity: 读取 agent_runs 失败 draft=%s", draft_id, exc_info=True)

    #:「在占位」的口径 = 真的有一套写库流程在跑。
    # agent_run 之外的三种（进程内批量 / 队列作业 / 整本精修）都是覆写型。
    blocking = [x for x in sources if x.get("blocks", True)]

    summary = ""
    if sources:
        parts = []
        for s_ in sources:
            if s_["mechanism"] == "inline":
                parts.append(f"{s_['label']}正在跑（{s_['current']}/{s_['total']}）")
            elif s_["mechanism"] == "queue":
                parts.append(f"{s_['label']}作业 #{s_['job_id']}（{s_['status']}）")
            elif s_["mechanism"] == "agent":
                parts.append(f"Agent {'等你确认' if s_.get('awaiting_approval') else '正在执行'}")
            else:
                parts.append(f"{s_['label']} #{s_['job_id']}（{s_['status']}）")
        summary = "；".join(parts)

    return {
        # busy 只算**真正占位**的那些 —— 409 与 start_generate 都读它。
        "busy": bool(blocking),
        "sources": sources,
        # 有没有 Agent 在等你点确认：界面要用它把话说明白，而不是让用户猜"为什么没反应"。
        "approval_pending": any(x.get("awaiting_approval") for x in sources),
        "approval_runs": [{"run_id": x["job_id"], "conversation_id": x.get("conversation_id"),
                           "message": x.get("last_message", "")}
                          for x in sources if x.get("awaiting_approval")],
        "repeated": len({x["mechanism"] for x in blocking}) > 1,
        "summary": summary,
    }


_STAGE_CN = {
    "chapters": "正文批量生成",
    "storyboards": "剧本批量生成",
    "outline": "大纲生成",
    "continuation": "续写",
    "adaptation": "改编",
    "video": "视频生成",
}

#: 队列作业的活跃状态。**必须与 `agent/chat_jobs._ACTIVE_STATES` 逐字一致** ——
#: 本模块是两边共用的底层，不能反过来 import chat_jobs（会成环），所以各写一份。
_AGENT_ACTIVE_STATES = ("queued", "running", "analyzing", "rewriting", "pending")

#: 精修作业的判活阈值。**唯一来源**是 `rewrite.service.REWRITE_STALE_SECONDS`，
#: 但那个模块会连锁 import langchain / models.llm，放在模块顶层会让这里（被
#: router 在启动路径上 import）多背一串依赖，也可能与 rewrite 成环。
#: 所以运行时按需取，拿不到时的兜底值**必须与那边当前值相同**。
_REWRITE_STALE_FALLBACK = 180


def _rewrite_stale_seconds() -> int:
    try:
        from ..rewrite import service as _svc
        return int(_svc.REWRITE_STALE_SECONDS)
    except Exception:                       # noqa: BLE001
        return _REWRITE_STALE_FALLBACK

_JOB_CN = {
    "gen_outline": "生成大纲",
    "gen_chapters": "生成正文",
    "gen_storyboards": "生成剧本",
    "rewrite_script": "整本精修",
    "deai_apply": "去 AI 味",
    "fix_script": "定点修复",
    "check_script": "体检",
    "adapt_products": "改编小说/推文",
    "adapt_commit": "执行改编",
    "agent_run": "Agent 运行",
    "desktop_tool": "桌面端操作",
}
