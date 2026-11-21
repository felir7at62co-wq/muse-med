"""只读工具：agent 动手前的"看"。

**全部不花钱、不改数据**。设计原则：一个只读工具返回的信息量应当刚好够模型
做下一步决策 —— 太多会让上下文爆掉，太少会让它反复查。
"""
from __future__ import annotations

import json
import logging
import re

from ..db import Asset, AssetStage, Project, Shot, ShotVersion, desc_of, get_session
from .executor import ToolCtx
from .registry import engine_tool

logger = logging.getLogger("fw.agent.tools.read")


def _j(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)


def _job_of_project(ctx: ToolCtx, job_id: str):
    """取一个任务，**仅当它属于本次调用的项目**；否则当作不存在。

    任务 id 由调用方给。不校验归属的话，一个人只要对**某个**项目有权限，就能
    读到（`get_job`/`wait_for_job`）甚至取消（`cancel_job`）别人项目的任务 ——
    桌面端把工具直接交给用户之后，这就是一个跨项目越权口（2026-10-30 补）。
    不区分"不存在"与"不是你的"，与全站 404 口径一致。

    归属优先看 `jobs.project_id` 索引列；老数据该列为空时退回 payload，
    与 `access._project_of_job` 同一判据。
    """
    from ..jobs import get_job

    j = get_job(job_id)
    if j is None:
        return None
    pid = j.project_id
    if not pid:
        try:
            pid = (json.loads(j.payload or "{}") or {}).get("project_id")
        except (ValueError, TypeError, AttributeError):
            pid = None
    return j if pid and pid == ctx.project_id else None


# ---------------------------------------------------------------------------

@engine_tool(
    name="list_projects",
    risk="read",
    role="viewer",
    # 账号级：不属于任何项目。桌面网关据此跳过项目成员校验（见 routers/desktop_agent.py）。
    tags=["account"],
    description="列出**我能进的项目**（管理员看全部，普通用户只看自己在的）。"
                "每个项目带已出片/总镜头数、时长、缩略图。"
                "**桌面端/新会话的第一步**：先拿到 project_id，再谈别的。",
)
async def list_projects(ctx: ToolCtx, q: str = "") -> dict:
    """项目列表。可见性与网页的 `GET /v2/projects` 同一实现。

    ⚠️ 不复用那个路由函数：它要 `Request`/分页参数，且会做一堆前端展示用的
    加工（缩略图排序、stat dict）。这里只给模型需要的字段，但**可见性判定
    必须走同一个 `access.visible_projects_query`** —— 复刻一份权限判断就是
    下一次越权的来源。
    """
    from .. import access
    from ..db import Project, Shot
    from sqlalchemy import func

    needle = (q or "").strip()
    with get_session() as s:
        qry = access.visible_projects_query(s)
        qry = qry.filter(Project.deleted_at.is_(None))
        if needle:
            qry = qry.filter(Project.title.ilike(f"%{needle}%"))
        rows = qry.order_by(Project.created_at.desc()).limit(200).all()
        stats = dict(
            ((pid, (n, done)) for pid, n, done in
             s.query(Shot.project_id, func.count(Shot.id),
                     func.sum(func.coalesce(Shot.video_url.is_not(None), 0)))
             .filter(Shot.disabled == 0).group_by(Shot.project_id).all()))
        out = []
        for p in rows:
            n, done = stats.get(p.id, (0, 0))
            out.append({"project_id": p.id, "title": p.title,
                        "shots": int(n or 0), "shots_done": int(done or 0),
                        "has_script": bool((p.raw_script or "").strip())})
    return {"ok": True, "count": len(out), "projects": out}


@engine_tool(
    name="get_my_balance",
    risk="read",
    role="viewer",
    # 账号级：不属于任何项目。桌面网关据此跳过项目成员校验（见 routers/desktop_agent.py）。
    tags=["account"],
    description="查**当前使用者**的积分余额（元）。管理员显示 unlimited。"
                "花钱之前先看它，再把余额告诉用户。",
)
async def get_my_balance(ctx: ToolCtx) -> dict:
    """本人余额。**必须用 `ctx.user_id`，不能用 `budget.my_balance()`**。

    ⚠️ `budget.my_balance()` 读的是 `access.current_user_id()` —— 那是 **HTTP
    请求上下文**里的调用者。可 agent 工具跑在后台作业里，那里 `_CURRENT` 是空的，
    于是它必然抛 `PermissionError: 需要登录`。这不是偶发，是每一条都失败，
    而且失败得"很像真的没登录"（实测 2026-10-29 第一次调用就撞上了）。

    所以这里按 `ctx.user_id` 自己算一遍，口径与 `budget.my_balance()` 对齐：
    同一个人一池（`MEMBER_PREFIX + uid`），余额走 `budget._balances`（那个函数
    本身就是按 uid 算的，不依赖请求上下文）。
    """
    from .. import budget
    from ..db import BudgetPool, UserBudget, get_session

    uid = ctx.user_id
    if not uid:
        return {"ok": False, "error": "这一轮没有登录者身份，读不到余额"}
    with get_session() as s:
        u = s.get(UserBudget, int(uid))
        pool = s.get(BudgetPool, budget._member_pool(int(uid)))
        bal = budget._balances(pool, int(uid))
        today_fen, running = _today_and_running(s, int(uid))
    role = budget.canon_role(u.org_role) if u else ""
    from .. import pricing

    return {"ok": True,
            "in_org": bool(u and u.active),
            "ungrouped": bool(u and u.manager_id is None and not budget.is_root_role(role)),
            "role": role or budget.ROLE_MEMBER,
            **bal,
            # 桌面端侧栏余额条展开时要显示这两项。放在这里而不是另开一个工具：
            # 它们与余额是同一个问题的三面，多一个工具就多一段系统提示。
            "today_spent_fen": today_fen,
            "today_spent_yuan": f"{today_fen / 100:.2f}",
            "running_jobs": running,
            # 界面用它在余额不足时变告警色。给的是**最便宜的那一档**
            # （单张图），不是某次具体生成的报价——报价要看 project 与镜头数，
            # 这里只回答"还够不够做点什么"。
            "min_generation_fen": pricing.IMAGE_PER_PIC,
            "available_yuan": f"{(bal.get('available_fen') or 0) / 100:.2f}"}


def _today_and_running(session, uid: int) -> tuple[int, int]:
    """(今日已花, 正在跑的任务数)，都**只算这个人自己的**。

    今日花费取 `usage_events` 而不是账本：账本是"钱怎么动"，用量表是
    "花在哪"，侧栏要回答的是后者；且账本里 hold 未结算的还没落地，
    显示成"今天花了"会让用户以为已经扣走了。

    "今天"按**服务器本地日**算（部署与用户同在 +08:00），但 `usage_events.ts`
    存的是 UTC ISO 串（`2026-10-30T05:37:56+00:00`）。⚠️ 不能拿本地日期字符串
    直接与它比：那样本地 00:00–08:00 的花费会因 UTC 还是前一天而漏算。
    所以先取本地零点、换成 UTC，再做同格式的字符串比较。
    """
    from datetime import datetime, timezone

    from ..db import AgentRun, Job, UsageEvent

    local_midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    since = local_midnight.astimezone(timezone.utc).isoformat(timespec="seconds")
    today = (session.query(UsageEvent.cost_fen)
             .filter(UsageEvent.user_id == uid, UsageEvent.ts >= since)
             .all())
    spent = sum(int(r[0] or 0) for r in today)
    # 生成任务 + 对话里的 Agent 轮次都算「在跑」。此前只数 jobs，于是用户在对话里
    # 让 Agent 干活（尤其「剧本」对话，它根本不产生 jobs 行）时，侧栏一直显示
    # 「没有在跑的任务」—— 2026-11-02 用户报的正是这个。
    # `waiting_approval` 不算：那一刻它在等人，不是在跑。
    running = (session.query(Job.id)
               .filter(Job.user_id == uid, Job.status.in_(("pending", "running")))
               .count())
    running += (session.query(AgentRun.id)
                .filter(AgentRun.user_id == uid, AgentRun.status.in_(("pending", "running")))
                .count())
    return spent, int(running)


@engine_tool(
    name="get_project",
    risk="read",
    role="viewer",
    description="查项目配置：片名、画幅、画风、影调、分辨率、生产模式（真人剧/解说剧）、"
                "图像与视频模型、是否有剧本。**任何操作之前先看它**。",
)
async def get_project(ctx: ToolCtx, project_id: str) -> dict:
    with get_session() as s:
        p = s.get(Project, project_id)
        if not p:
            return {"ok": False, "error": f"项目不存在: {project_id}"}
        from .. import db as dbmod
        prof = dbmod.profile_of(p)
        return {
            "ok": True,
            "project_id": p.id,
            "title": p.title,
            "aspect": p.base_aspect or "9:16",
            "art_style": p.art_style,
            "production_mode": p.production_mode or "drama",
            "has_script": bool((p.raw_script or "").strip()),
            "has_optimized_script": bool((p.optimized_script or "").strip()),
            "look": bool(p.look_json),
            "resolution": prof.get("resolution"),
            "image_model": prof.get("image_model"),
            "video_model": prof.get("video_model"),
            # 能改就得能看：set_ai_label 写的就是这一项，不回报的话模型改完无法核对。
            "ai_label": prof.get("ai_label") if isinstance(prof.get("ai_label"), dict) else None,
        }


@engine_tool(
    name="get_readiness",
    risk="read",
    role="viewer",
    description="生产就绪度体检：缺哪些资产图、多少镜头还没出片、"
                "多少提示词还是剧本原文。**判断该做什么的第一步**。",
)
async def get_readiness(ctx: ToolCtx, project_id: str) -> dict:
    from ..readiness import compute_readiness
    r = compute_readiness(project_id)
    if r.get("error"):
        return {"ok": False, "error": r["error"]}
    return {"ok": True, "readiness": r}


@engine_tool(
    name="get_episode_readiness",
    risk="read",
    role="viewer",
    description="一集的**逐镜就绪度**（只读、不花钱）：每一镜的全剧镜号 order、shot_id、场景 location"
                "（及归一后的场景名 scene）和该场景资产有没有可用的图（scene_has_image；镜头没写场景时为 null）、"
                "出场角色及各自有没有图、镜头脚本状态（prompt_state / locked）、是否过期（stale）、有没有首帧与成片。"
                "summary 汇总：还缺图的场景与角色（各自卡住了哪几镜）、哪些镜头还没锁定脚本、哪些过期了。"
                "**写镜头脚本之前先看它**：脚本要对着场景图写，scene_has_image=false 的镜头锁定脚本时会被拒绝，"
                "先用 run_asset_fill / run_asset_generate 把缺的图补齐。",
)
async def get_episode_readiness(ctx: ToolCtx, project_id: str, episode: int) -> dict:
    from ..readiness import SCENE_REASON_CN, episode_readiness

    try:
        ep = int(episode)
    except (TypeError, ValueError):
        return {"ok": False, "error": "episode 必须是整数"}
    r = episode_readiness(project_id, ep)
    if r.get("error"):
        return {"ok": False, "error": "项目不存在"}
    if not r["shots"]:
        return {"ok": True, **r,
                "note": f"第 {ep} 集还没有镜头：先 run_breakdown 拆解，或用 write_episode_shots 写入你自己的拆解"}
    sm = r["summary"]
    for m in sm["scenes_missing_image"]:
        m["reason_text"] = SCENE_REASON_CN.get(m.get("reason") or "", "场景资产没有可用的图")
    if sm["scenes_missing_image"]:
        note = (f"还有 {len(sm['scenes_missing_image'])} 个场景没有可用的图，"
                "先补齐再写这些镜头的脚本（run_asset_fill(kinds=[\"location\"]) 或 run_asset_generate）")
    elif sm["unlocked_orders"]:
        note = f"场景图已齐，还有 {len(sm['unlocked_orders'])} 镜没有锁定的镜头脚本"
    elif sm["stale_orders"]:
        note = f"有 {len(sm['stale_orders'])} 镜在锁定脚本之后又改过拆解（stale），脚本要重写并重新锁定"
    else:
        note = "这一集的镜头脚本都已锁定"
    return {"ok": True, **r, "note": note}


@engine_tool(
    name="list_episodes",
    risk="read",
    role="viewer",
    description="列出分集：集号、标题、字数、是否已拆解出镜头。",
)
async def list_episodes(ctx: ToolCtx, project_id: str) -> dict:
    with get_session() as s:
        p = s.get(Project, project_id)
        if not p:
            return {"ok": False, "error": "项目不存在"}
        try:
            eps = json.loads(p.episodes or "[]")
        except (ValueError, TypeError):
            eps = []
        shots = (s.query(Shot.episode).filter(Shot.project_id == project_id).all())
        have = {int(r[0] or 1) for r in shots}
    for e in eps:
        if isinstance(e, dict):
            e["has_shots"] = int(e.get("order") or e.get("index") or 0) in have
    return {"ok": True, "episodes": eps,
            "episodes_with_shots": sorted(have),
            "total_shots": len(shots)}


#: `check_episodes_progress` 能核对的步骤（按流程先后）。
#: 原先 `prompts` 与 `videos` 之间还有一步 `first_frames`（首帧），随首帧路线 2026-11-20 下线而删除。
PROGRESS_STEPS = ("breakdown", "assets", "prompts", "videos")


@engine_tool(
    name="check_episodes_progress",
    risk="read",
    role="viewer",
    description="核对指定几集做到了哪一步，列出每一步还差什么（不花钱）。step 是要核对到的那一步："
                "breakdown（拆镜）/ assets（资产图）/ prompts（镜头脚本已写入并锁定）/ videos（成片）。"
                "返回 done（全部达标）与每集缺口；通宵模式交报告前由客户端用它核对目标是否真的完成。",
)
async def check_episodes_progress(ctx: ToolCtx, project_id: str, episodes: list[int], step: str) -> dict:
    """只读。按集核对；资产图是全剧共用的，按项目整体核对（缺图会让任何一集出片换脸）。"""
    if step not in PROGRESS_STEPS:
        return {"ok": False, "error": f"step 只能是 {'、'.join(PROGRESS_STEPS)}"}
    wanted = sorted({int(e) for e in (episodes or []) if int(e) > 0})
    if not wanted:
        return {"ok": False, "error": "episodes 为空"}
    with get_session() as s:
        if s.get(Project, project_id) is None:
            return {"ok": False, "error": "项目不存在"}
        rows = (s.query(Shot).filter(Shot.project_id == project_id, Shot.episode.in_(wanted))
                .order_by(Shot.order).all())
        from ..jobs import _locked_prompt_of
        # 第 6 项：这一镜有没有**锁定的**镜头脚本（出片只认它，与 run_shot_videos 同一判据）。
        # 2026-11-19 之前这里看的是 prompt_state 不是 draft —— 那是「镜流自己按资产对齐过」
        # 的口径；现在镜流不写脚本了，存量的机器稿（aligned / sent）没锁定同样出不了片。
        shots = [(int(r.episode or 0), r.order, bool(r.disabled), bool(r.is_special), r.video_url,
                  bool(_locked_prompt_of(r.profile_override))) for r in rows]
    upto = PROGRESS_STEPS.index(step)
    per_ep: dict[int, dict] = {}
    for ep in wanted:
        mine = [x for x in shots if x[0] == ep and not x[2] and not x[3]]
        gaps: dict[str, list[int] | bool] = {}
        if not mine:
            gaps["breakdown"] = True
        else:
            if upto >= PROGRESS_STEPS.index("prompts"):
                unlocked = [x[1] for x in mine if not x[5]]
                if unlocked:
                    gaps["prompts"] = unlocked
            if upto >= PROGRESS_STEPS.index("videos"):
                nv = [x[1] for x in mine if not x[4]]
                if nv:
                    gaps["videos"] = nv
        per_ep[ep] = gaps
    asset_gap: dict = {}
    if upto >= PROGRESS_STEPS.index("assets"):
        from ..readiness import compute_readiness
        a = (compute_readiness(project_id) or {}).get("assets") or {}
        asset_gap = {k: a.get(k) for k in ("stages_no_image", "chars_no_asset", "locations_no_image", "props_no_image")
                     if a.get(k)}
    missing = {ep: g for ep, g in per_ep.items() if g}
    return {"ok": True, "step": step, "episodes": wanted,
            "done": not missing and not asset_gap,
            "missing_by_episode": {str(k): v for k, v in missing.items()},
            **({"assets_missing": asset_gap} if asset_gap else {}),
            "note": "镜号是全剧连续的 order；prompts 指还没有锁定镜头脚本的镜头（出片只认锁定稿）"}


@engine_tool(
    name="read_script",
    risk="read",
    role="viewer",
    description="读剧本正文。episode 为空读全片（过长会被截断并告知）。",
)
async def read_script(ctx: ToolCtx, project_id: str,
                      episode: int | None = None,
                      max_chars: int = 20000) -> dict:
    with get_session() as s:
        p = s.get(Project, project_id)
        if not p:
            return {"ok": False, "error": "项目不存在"}
        text = p.optimized_script or p.raw_script or ""
    if not text.strip():
        return {"ok": False, "error": "项目还没有剧本"}
    if episode is not None:
        from ..costumes import split_episodes
        eps = split_episodes(text)
        text = eps.get(int(episode), "")
        if not text.strip():
            return {"ok": False, "error": f"第 {episode} 集没有正文"}
    truncated = len(text) > max_chars
    return {"ok": True, "episode": episode, "chars": len(text),
            "truncated": truncated,
            "text": text[:max_chars],
            "note": (f"原文 {len(text)} 字，已截断到 {max_chars} 字；"
                     "需要更多请指定 episode") if truncated else ""}


@engine_tool(
    name="list_shots",
    risk="read",
    role="viewer",
    description="列镜头。可按集过滤。返回全剧镜号(order)与本集镜号、状态、"
                "是否有片、失败原因。**注意 order 是全剧连续的，不是本集序号**。",
)
async def list_shots(ctx: ToolCtx, project_id: str,
                     episode: int | None = None,
                     only_missing_video: bool = False,
                     limit: int = 300) -> dict:
    with get_session() as s:
        q = s.query(Shot).filter(Shot.project_id == project_id)
        if episode is not None:
            q = q.filter(Shot.episode == int(episode))
        shots = q.order_by(Shot.order).all()
    rows = []
    for sh in shots:
        if only_missing_video and sh.video_url:
            continue
        if sh.disabled:
            continue
        rows.append({
            "id": sh.id, "order": sh.order, "episode": sh.episode,
            "has_video": bool(sh.video_url),
            "has_prompt": bool((sh.gen_prompt or "").strip()),
            "prompt_state": sh.prompt_state,
            "stale": bool(sh.stale), "stale_reason": sh.stale_reason,
            "fail_kind": sh.fail_kind, "fail_reason": sh.fail_reason,
            "duration_sec": sh.duration_sec,
            "special": bool(sh.is_special), "special_name": sh.special_name,
        })
    total = len(rows)
    return {"ok": True, "total": total,
            "truncated": total > limit,
            "shots": rows[:limit]}


@engine_tool(
    name="get_shot",
    risk="read",
    role="viewer",
    description="看单镜详情：剧本段落、当前提示词、出场角色、场景、道具、"
                "人工覆盖、过期原因、当前采用版本。",
)
async def get_shot(ctx: ToolCtx, shot_id: str) -> dict:
    with get_session() as s:
        sh = s.get(Shot, shot_id)
        if not sh or sh.project_id != ctx.project_id:
            return {"ok": False, "error": f"镜头不存在: {shot_id}"}
        try:
            ov = json.loads(sh.profile_override) if sh.profile_override else {}
        except (ValueError, TypeError):
            ov = {}
        try:
            chars = json.loads(sh.characters or "[]")
        except (ValueError, TypeError):
            chars = []
        try:
            props = json.loads(sh.props or "[]")
        except (ValueError, TypeError):
            props = []
        from ..db import effective_characters
        return {
            "ok": True,
            "id": sh.id, "order": sh.order, "episode": sh.episode,
            "script_ref": sh.script_ref,
            "gen_prompt": sh.gen_prompt,
            "prompt_state": sh.prompt_state,
            "characters": chars,
            "effective_characters": effective_characters(sh),
            "location": sh.location,
            # 与上一镜的衔接：true = 连续（同一场戏接着演），false = 换场/转场
            "link_to_prev": sh.link_to_prev == "continuous",
            "props": props,
            "duration_sec": sh.duration_sec,
            "video_url": sh.video_url,
            "adopted_version": sh.adopted_version,
            "override": ov,
            "stale": bool(sh.stale), "stale_reason": sh.stale_reason,
            "fail_kind": sh.fail_kind,
            "first_frame_url": sh.first_frame_url,
            # 审片与音色要用的事实（与 read_shots 同一口径，见 shot_facts）
            **_facts_extra(s, sh),
        }


def _facts_extra(s, sh) -> dict:
    from .shot_facts import (ProjectVoices, last_voice_ref, model_cap_sec,
                             shot_facts)
    f = shot_facts(s, sh, ProjectVoices(s, sh.project_id),
                   model_cap_sec(sh.project_id, s), full_text=False)
    out = {k: f[k] for k in ("dialogue_chars", "model_cap_sec", "action_intensity",
                            "speakers", "voices", "measured_cps",
                            "measured_subtitle_sec") if k in f}
    if f.get("flags"):
        out["flags"] = f["flags"]
    out["last_voice_ref"] = last_voice_ref(s, sh.id)
    return out


#: read_shots 单次返回的正文预算（字）。一镜提示词常见 1~3 千字，按镜数切
#: 会忽大忽小；按字数切才能保证一次读进来的量稳定、且不会把上下文冲爆。
_READ_BUDGET_CHARS = 24000


@engine_tool(
    name="read_shots",
    risk="read",
    role="viewer",
    description="**逐镜读全文**：剧本原文、完整视频提示词，以及审片要用的事实——"
                "时长、这一镜要念多少字(dialogue_chars)、模型单镜上限(model_cap_sec)、"
                "动作强度、出场角色、剧本里解析出的说话人及其有无音色、本镜已挂的音色编号。"
                "有真实字幕的镜头还会带 measured_cps（这镜实测的字/秒）与 measured_subtitle_sec。"
                "按全剧镜号分页：一次读一段，返回 next_from_order 接着读。"
                "**判断重复动作/画面、单镜塞了太多事、谁说了话，都要先用它读原文。**",
)
async def read_shots(ctx: ToolCtx, project_id: str,
                     episode: int | None = None,
                     from_order: int | None = None,
                     shot_ids: list[str] | None = None,
                     max_shots: int = 30) -> dict:
    from .shot_facts import ProjectVoices, model_cap_sec, shot_facts

    with get_session() as s:
        q = s.query(Shot).filter(Shot.project_id == project_id,
                                 (Shot.disabled == 0) | (Shot.disabled.is_(None)))
        if shot_ids:
            q = q.filter(Shot.id.in_(list(shot_ids)))
        if episode is not None:
            q = q.filter(Shot.episode == int(episode))
        if from_order is not None:
            q = q.filter(Shot.order >= int(from_order))
        shots = q.order_by(Shot.order).all()
        if not shots:
            return {"ok": True, "shots": [], "next_from_order": None,
                    "note": "这个范围里没有镜头"}
        voices = ProjectVoices(s, project_id)
        cap = model_cap_sec(project_id, s)
        # 本项目**实测**的逐镜语速（只对有真实 ASR 字幕的镜头有值）。
        # 没有就传空 dict —— 模型拿不到 measured_cps 这个键，也就不会去用它。
        from ..speech_rate import shot_rates
        rates = shot_rates(project_id)
        rows: list[dict] = []
        used = 0
        nxt = None
        for sh in shots:
            if len(rows) >= max(1, min(int(max_shots or 30), 60)):
                nxt = sh.order
                break
            r = shot_facts(s, sh, voices, cap, rates=rates)
            size = len(r.get("prompt") or "") + len(r.get("script_ref") or "")
            # 至少给一镜：单镜就超预算时也要读得到它，否则会永远卡在这一镜
            if rows and used + size > _READ_BUDGET_CHARS:
                nxt = sh.order
                break
            rows.append(r)
            used += size
    return {"ok": True, "count": len(rows), "shots": rows,
            "next_from_order": nxt,
            "characters_with_voice": sorted(voices.by_name),
            "note": ("还有后续镜头，用 from_order=next_from_order 接着读"
                     if nxt else "这个范围已读完")}


@engine_tool(
    name="list_assets",
    risk="read",
    role="viewer",
    description="列资产（角色/场景/道具）与造型，标出哪些缺图。"
                "**角色的图怎么用**：一个镜头只归一套造型，用那套的**造型图**（stages，带集/镜号范围）；"
                "没被任何造型覆盖的镜头用**通用定妆图**兜底 = 资产页卡片上那张图：角色有造型图时就是基础造型"
                "（整集、集最早的那套）的图，一套造型图都没有时才是 assets 里角色自己的 image_url。"
                "所以「角色只有造型图、assets 里 image_url 为空」**不是缺口**，不要报给用户。"
                "每个造型带 diagnosis 说明它为什么可能不生效。"
                "compact=true：只给每个资产的 id/类型/名字/被多少镜引用/有没有图和音色/"
                "一句描述，按类型分组——**找重复资产时用它**（几百个资产也放得下）。"
                "**站位图**以 kind=blocking 一并列在 assets 里（带所属场景与适用镜头 scope），"
                "它不是角色/场景/道具：登记、绑定、删除用 *_blocking_image 那几个工具，"
                "rename_asset / delete_asset / merge_assets / set_asset_images 对它无效。",
)
async def list_assets(ctx: ToolCtx, project_id: str,
                      only_missing_image: bool = False,
                      compact: bool = False) -> dict:
    from .. import asset_gate, stage_gate
    from ..costumes import resolve_stage_image

    if compact:
        return _assets_compact(project_id)

    with get_session() as s:
        assets = asset_gate.alive(
            s.query(Asset).filter(Asset.project_id == project_id)).all()
        stages = (stage_gate.alive(
                  s.query(AssetStage).filter(AssetStage.project_id == project_id))
                  .order_by(AssetStage.character_name, AssetStage.ep_from).all())
        out_a = []
        for a in assets:
            img = a.image_url or ""
            if only_missing_image and img:
                continue
            row = {"id": a.id, "kind": a.kind, "name": a.name,
                   "has_image": bool(img), "image_url": img or None,
                   "prompt": (a.prompt or "")[:300] or None,
                   "desc_auto": (desc_of(a) or "")[:300] or None}
            if a.kind == "character":
                # 用户在要素页上传的角色音色。agent 要靠它判断"这一镜说话的人
                # 有没有音色可挂"——此前不返回，用户问"我传的音色没生效"时
                # agent 连他传没传都查不到。
                row["has_voice"] = bool((a.voice_url or "").strip())
                if row["has_voice"]:
                    row["voice_token"] = f"@{a.name}的音色"
            out_a.append(row)
        out_s = []
        for st in stages:
            img = st.image_url or resolve_stage_image(s, st) or ""
            if only_missing_image and img:
                continue
            out_s.append({
                "id": st.id, "character": st.character_name,
                "stage": st.stage_name,
                "ep_from": st.ep_from, "ep_to": st.ep_to,
                "shot_from": st.shot_from, "shot_to": st.shot_to,
                "location": st.location, "scene_bound": bool(st.scene_bound),
                "has_image": bool(img), "status": st.status,
                "description": (st.description or "")[:300] or None,
            })
        # 站位图（kind=blocking）：另一张表里的东西，接在后面一并给出。它一定有图，
        # 所以「只看缺图的」不列它，也不计入下面两个缺图数。
        if not only_missing_image:
            from .. import blocking_images
            for row in blocking_images.list_rows(s, project_id):
                row["prompt"] = (row["prompt"] or "")[:300] or None
                out_a.append(row)
    return {"ok": True, "assets": out_a, "stages": out_s,
            "terms": "一镜只归一套造型，用 stages[].image_url（造型图）；没被覆盖的镜头用资产页卡片那张兜底"
                     "（有造型图时=基础造型的图，否则=assets 里角色的 image_url）。只有造型图不算缺图",
            "characters_with_voice": [x["name"] for x in out_a if x.get("has_voice")],
            "assets_missing_image": sum(1 for x in out_a if not x["has_image"]),
            "stages_missing_image": sum(1 for x in out_s if not x["has_image"])}


@engine_tool(
    name="list_blocking_images",
    risk="read",
    role="viewer",
    description="列出本项目的**站位图**（一场戏里各角色站位与朝向的全景参考图）：名字、图、所属场景、"
                "绑在哪些镜头上（shots 带全剧镜号 order 与本集镜号 no；scope 是给人看的一句话，"
                "如「渡口清晨 · 第 6 集 2–4 镜」）。ref 是提示词里引用它的写法。不花钱。",
)
async def list_blocking_images(ctx: ToolCtx, project_id: str) -> dict:
    from .. import blocking_images

    with get_session() as s:
        rows = blocking_images.list_rows(s, project_id)
    return {"ok": True, "count": len(rows), "blocking_images": rows,
            "note": "本集镜号 no 按没停用的镜头从 1 数（与 read_shots 的顺序一致）；"
                    "没绑任何镜头的站位图出片时不会被带上"}


@engine_tool(
    name="find_duplicate_assets",
    risk="read",
    role="viewer",
    description="找出**疑似重复**的角色/场景/道具，一次返回**完整**的候选分组清单"
                "（每组带 id、被多少镜引用、有图没图、判定依据）。"
                "做「检查重复资产并合并」这件事**先调它**——它给出的是全量，"
                "不要自己从 list_assets 里挑一部分就开始合并，也不要凭印象说「还有 N 组」。"
                "它只给候选，最终是不是同一个实体仍由你判断（称呼变体它认不出来）。",
)
async def find_duplicate_assets(ctx: ToolCtx, project_id: str,
                                kinds: list[str] | None = None) -> dict:
    """疑似重复资产的分组清单（**确定性**判据，只读）。

    ## 为什么要有它（2026-10-27 用户反馈）

    「agent 合并每做完五组就显示已完成，再问还有，前面也没有显示总共多少」。
    提示词让模型自己从 `list_assets(compact=true)` 里挑重复项，而那个清单
    只是**按名字排好的全量资产**，没有任何"哪些像重复"的提示。模型于是：
      · 每一轮只挑出几组能一眼认出的，合并完就说"已完成"；
      · 用户再问，它再翻一遍、又找出几组 —— 看起来像"永远做不完"；
      · 它报不出总数，因为从没有一份可数的清单。

    本工具把「候选」这件事变成**可数的**：同一份数据、同一套判据，每次结果一致。
    合并过的资产会变成墓碑 + 别名，不在 `alive` 里，所以再跑一次列表会自然变短 ——
    这正好让"还剩几组"有一个诚实的答案。

    ## 判据（**保守**，只做高精度的那几条）

      · 归一后同名（「王建国 」vs「王建国」）—— 多半是拆解重复建行；
      · 描述（`desc_auto`）完全相同且非空 —— 同一段描述写了两行；
      · 名字互相包含（「王建国」⊂「王建国总」）；
      · 场景归一前缀后相同（「夜 内 公馆客厅」vs「公馆客厅」）。

    刻意**不做**语义判断（「王总」和「老王」可能是也可能不是一个人）：
    那种判断只能由模型看原文做，做错了就是并掉一个真实存在的人。

    ## 实现已移到 `asset_dedupe.find_groups()`（2026-10-28）

    原先整段判据内联在这里，于是**只有 agent 能调用**，要素页的「一键查重」
    按钮想用就得重写一份。现在判据只有一份，agent 工具与 HTTP 路由共用，
    保证"按钮说 21 组"和"agent 说 21 组"是同一个数。
    """
    from .. import asset_dedupe

    want = [k for k in (kinds or asset_dedupe.KINDS) if k in asset_dedupe.KINDS]
    if not want:
        return {"ok": False, "error": f"kinds 只能是 {list(asset_dedupe.KINDS)}"}
    with get_session() as s:
        found = asset_dedupe.find_groups(s, project_id, want)
    out_groups = found["groups"]
    # 只把 agent 需要的字段给它：`tier` / `needs_ai` / `verdict` 是给前端弹窗的，
    # 塞给模型只会让上下文变长、还容易让它把 `default_checked` 当结论。
    return {
        "ok": True,
        "total_groups": len(out_groups),
        "groups": [{
            "kind": g["kind"], "reason": g["reason"],
            "assets": g["assets"], "suggest_keep": g["suggest_keep"],
        } for g in out_groups],
        "instructions": (
            "这是**全量**候选清单，共 %d 组。逐组 preview_asset_merge → merge_assets 合并；"
            "每组合并前把「留哪个名字、并进哪几个」写清楚。全部做完后回报"
            "「共 N 组、已合并 N 组、跳过 N 组及原因」，不要说「已完成」了事。"
            "清单之外若还能从 list_assets 看出重复（称呼变体如「王总/老王」），"
            "单独列出来说明理由再合并." % len(out_groups)),
    }


def _assets_compact(project_id: str) -> dict:
    """找重复资产用的精简清单：判断"王总 / 老王 / 王建国是不是同一个人"要看的就这些。

    `shot_refs` 是剧本里引用这个名字的镜头数（与合并预演 `asset_merge` 同一口径）：
    0 次的多半是拆解改过稿留下的幽灵行。描述截到 80 字，够分辨"是不是同一人"，
    又不至于几百个资产把上下文撑爆。
    """
    from .. import asset_gate
    from ..asset_merge import MERGEABLE, _shot_index

    out: dict[str, list] = {k: [] for k in MERGEABLE}
    with get_session() as s:
        rows = asset_gate.alive(s.query(Asset).filter(Asset.project_id == project_id)).all()
        refs = {k: _shot_index(s, project_id, k) for k in MERGEABLE}
        for a in rows:
            if a.kind not in out:
                continue
            out[a.kind].append({
                "id": a.id, "name": a.name,
                "shot_refs": refs[a.kind].get(a.name or "", 0),
                "has_image": bool(a.image_url),
                "has_voice": bool((a.voice_url or "").strip()) if a.kind == "character" else None,
                "desc": (desc_of(a) or "")[:80] or None,
            })
    for k in out:
        out[k].sort(key=lambda x: (x["name"] or ""))
    return {"ok": True, "characters": out["character"], "locations": out["location"],
            "props": out["prop"],
            "counts": {k: len(v) for k, v in out.items()}}


@engine_tool(
    name="preview_asset_merge",
    risk="read",
    role="viewer",
    description="合并资产的**预演**（只算不写）：会留哪一行、哪几行并进来、各自被多少镜引用、"
                "有没有图和音色、角色造型有没有区间冲突以及系统建议丢掉哪套。"
                "asset_ids 是同一类的 2 个以上资产；keep_id 不填按系统规则自动选。",
)
async def preview_asset_merge(ctx: ToolCtx, project_id: str, asset_ids: list[str],
                              keep_id: str | None = None) -> dict:
    from .. import asset_merge

    with get_session() as s:
        bad = [i for i in asset_ids
               if not (a := s.get(Asset, i)) or a.project_id != project_id]
        if bad:
            return {"ok": False, "error": f"这些资产不存在或不属于本项目：{bad}"}
        p = asset_merge.plan(s, project_id, list(asset_ids))
    if keep_id and p.get("ok"):
        ids = [p["keep"]["id"]] + [d["id"] for d in p.get("drops") or []]
        if keep_id not in ids:
            return {"ok": False, "error": "keep_id 不在这批资产里"}
    return p


@engine_tool(
    name="list_versions",
    risk="read",
    role="viewer",
    description="看某镜的版本链（第几版、哪个模型产的、是否高清、是否去字幕）。"
                "版本链是**唯一的撤销手段**，改片前先看它。",
)
async def list_versions(ctx: ToolCtx, shot_id: str) -> dict:
    with get_session() as s:
        sh = s.get(Shot, shot_id)
        if not sh or sh.project_id != ctx.project_id:
            return {"ok": False, "error": "镜头不存在"}
        vers = (s.query(ShotVersion).filter(ShotVersion.shot_id == shot_id)
                .order_by(ShotVersion.version_no).all())
        return {
            "ok": True,
            "adopted_version": sh.adopted_version,
            "versions": [{"version_no": v.version_no, "model_id": v.model_id,
                          "video_url": v.video_url,
                          "created_at": v.created_at} for v in vers],
        }


@engine_tool(
    name="check_prompt_health",
    risk="read",
    role="viewer",
    description="检查哪些镜头的提示词还是剧本原文（存量数据：旧版自动生成失败时的降级产物）。"
                "这些镜头没有可用的镜头脚本，要重新写好并用 set_shot_prompt(s)(lock=true) 锁定才能出片。",
)
async def check_prompt_health(ctx: ToolCtx, project_id: str,
                              episode: int | None = None) -> dict:
    from .. import prompt_health as ph

    with get_session() as s:
        p = s.get(Project, project_id)
        legacy = ph.project_has_framework(p) if p else True
        q = s.query(Shot).filter(Shot.project_id == project_id)
        if episode is not None:
            q = q.filter(Shot.episode == int(episode))
        shots = q.order_by(Shot.order).all()
        raw = [{"id": sh.id, "order": sh.order, "episode": sh.episode}
               for sh in shots
               if ph.is_raw(sh.gen_prompt, sh.script_ref, sh.prompt_state,
                            legacy=legacy)]
        manual = [{"id": sh.id, "order": sh.order}
                  for sh in shots if sh.prompt_state == "manual"]
    return {"ok": True, "raw_count": len(raw), "raw": raw[:100],
            "manual_count": len(manual),
            "note": ("raw = 提示词与剧本原文一字不差（旧版自动生成降级的存量），需要重写并锁定；"
                     "manual = 已锁定的镜头脚本，出片时原样发送")}


@engine_tool(
    name="get_prompt_rules",
    risk="read",
    role="viewer",
    description="读本项目**存量**视频提示词的写法说明：排版格式、引用写法，以及哪些看起来奇怪的写法是有意为之"
                "（反应镜、景别来回切换、段长错落等）。改旧稿前读一次，避免把有意的写法当错误改掉。"
                "只读、不调模型。镜流不再自己生成镜头提示词：新稿由你按自己的框架写，"
                "用 set_shot_prompt(s)(lock=true) 写入并锁定。",
)
async def get_prompt_rules(ctx: ToolCtx, project_id: str) -> dict:
    from ..jobs import _resolve_project_video_model
    from ..prompt_opt.service import framework_for_model

    with get_session() as s:
        p = s.get(Project, project_id)
        if not p:
            return {"ok": False, "error": "项目不存在"}
        model = _resolve_project_video_model(p)
    from ..config import get_settings
    model = model or get_settings().video_model
    fw = framework_for_model(model or "")
    if not fw:
        return {"ok": True, "video_model": model, "framework": None,
                "note": "这个视频模型没有提示词框架，提示词按原样发送；改的时候只需保持原有写法"}
    # 只给改稿需要的两样——排版，与「哪些写法是故意的」，都是在存量成片提示词里本来就
    # 看得见的东西。原先据以生成这些稿子的出品规则（house_rules）与技能文档已于
    # 2026-11-19 随提示词引擎一起删除，这里没有、也不再有规则全文可给。
    return {
        "ok": True, "video_model": model, "framework": fw,
        "scope": "存量稿（旧版镜流自动生成的提示词）的写法说明；新稿由 Muse 按自己的框架写并锁定",
        "format": ("段首四格「时间码｜主体｜景别｜镜头运动」，下一行「画面：」，"
                   "台词写成 某某说：{台词}；开头一段交代场景与轴线，结尾一段是影调与画质要求。"),
        "references": ("提示词里写 @角色名 / @场景名 / @道具名 引用参考图，@角色名的音色 引用音色；"
                       "出片时自动换成 图片N / 音频N。只有本镜实际送出的素材能被引用（set_ref_overrides 加角色/场景，"
                       "patch_shot 改道具，set_shot_voices 挂音色）。"),
        "intentional": [
            "同一场戏里镜头在人物、道具特写、双人之间来回切，是有意的节拍变化，不是重复",
            "关键台词后一两刀内去拍受影响的人（反应镜），是有意的",
            "各段时长长短错落、不等长，是有意的；时间码是节奏设计，不要求逐帧兑现",
            "画面里只写在场的人；没写离场的人默认仍在",
        ],
    }


@engine_tool(
    name="preview_prompt",
    risk="read",
    role="viewer",
    description="预览某个资产/造型此刻**生成时真正会用**的生图提示词（只读、不落库、不调模型）。资产：用户写过整段稿就返回用户稿（source=user），否则返回系统自动拼装的稿（source=auto）。看造型（换装）图的稿传 stage_id——造型没有可保存的整段稿，永远是自动拼装；要按自己的稿出造型图，用 run_asset_generate(stage_id=…, prompt=…)。",
)
async def preview_prompt(ctx: ToolCtx, project_id: str,
                         kind: str = "character",
                         name: str = "",
                         stage_id: str | None = None) -> dict:
    """与出图同一个函数（`jobs.asset_prompt_for`）：此前这里自己拼一份，既不看用户稿，
    也不带影调与画风，预览和真正出图对不上——用户写了自己的提示词，预览还显示系统稿。"""
    from ..jobs import asset_prompt_for

    if kind not in ("character", "location", "prop", "custom"):
        return {"ok": False, "error": "kind 只能是 character/location/prop/custom"}
    with get_session() as s:
        got = asset_prompt_for(s, project_id, kind, name, stage_id=stage_id)
    if got is None:
        return {"ok": False, "error": "资产或造型不存在（名字要与 list_assets 一字不差）"}
    # asset_prompt_for 只在返回用户终稿时带 auto_prompt 键（值为 None）。
    user = "auto_prompt" in got
    return {"ok": True, "kind": kind, "name": name, "stage_id": got.get("stage_id"),
            "source": "user" if user else "auto", "prompt": got.get("prompt") or ""}


@engine_tool(
    name="cost_estimate",
    risk="read",
    role="viewer",
    description="给一个操作报价（**不执行**）。做决定前先问它要花多少钱。",
)
async def cost_estimate(ctx: ToolCtx, project_id: str, kind: str,
                        shot_ids: list[str] | None = None,
                        episode: int | None = None) -> dict:
    from .. import charge

    payload: dict = {"project_id": project_id}
    if shot_ids:
        payload["shot_ids"] = shot_ids
    if episode is not None:
        payload["episode"] = int(episode)
    fen, note = charge.estimate(kind, payload)
    charged, reason = charge.should_charge(kind, payload)
    return {"ok": True, "kind": kind, "estimate_fen": fen if charged else 0,
            "estimate_yuan": f"{(fen if charged else 0) / 100:.2f}",
            "note": note if charged else reason}


@engine_tool(
    name="analyze_episode_duration",
    risk="read",
    role="viewer",
    description="整集（或全片）时间轴体检：现在的成片总时长是多少、目标还差多少秒、"
                "哪些镜头能压。用户说「把这集压进 100 秒」「这集太长了」时**先调这个**。"
                "返回每镜的输出时长、要念多少字、本镜实测语速（有字幕的镜头才有）、"
                "可压缩空间、以及加速到某个倍数后还剩多少。不花钱、不改任何数据。",
)
async def analyze_episode_duration(ctx: ToolCtx, project_id: str,
                                   episode: int | None = None,
                                   target_sec: float | None = None) -> dict:
    """回答"还差多少、从哪减"，不替用户决定减哪一镜。

    ## 为什么这个工具必须存在

    模型能靠 `list_shots` 自己把 duration_sec 加起来，但那样会**算错三件事**：
    ① 变速过的镜头它看不到 speed，加起来比实际成片长；
    ② 已停用/没出片的镜头不占时间轴，而 `duration_sec` 照样有个数；
    ③ 台词镜要多久，光看 `duration_sec` 看不出来。

    所以这里给的是**已经算对的事实**（时长、字数、实测语速），判断（哪镜该剪、
    哪镜该提速、这镜的时长够不够念完）留给模型。

    ## 为什么不再给"台词至少要几秒"（2026-10-24）

    原先这里给 `speak_floor_sec` = 字数 / 3.1。用户指出那个标准不对、不该让
    agent 用。核过：拿 74 个已正常出片的带台词镜头反查，那条线把 40 个（54%）
    判成"念不完"，而它们全都出片成功——3.1 恰好是中位数，拿中位数当下限必然
    判掉一半；实测跨度 1.80~4.76 字/秒，项目之间也不同。

    现在只给事实：`dialogue_chars`（数得出来的字数）与 `measured_cps`
    （本项目自己量出来的语速，有真实字幕才有）。**没有实测数据时不给任何语速数字**
    —— 宁可让模型自己判断，也不要塞一个假权威。
    """
    from ..drama_timing import dialogue_chars
    from ..shot_timing import shot_output_sec, shot_source_window, shot_speed
    from ..speech_rate import measure, shot_rates

    with get_session() as s:
        q = (s.query(Shot).filter(Shot.project_id == project_id)
             .order_by(Shot.order))
        if episode is not None:
            q = q.filter(Shot.episode == int(episode))
        shots = q.all()

    rates = shot_rates(project_id)
    rows, total = [], 0.0
    disabled_n = no_video_n = 0
    for sh in shots:
        if sh.disabled:
            disabled_n += 1
            continue
        if not sh.video_url:
            no_video_n += 1
            continue
        cin, src_dur = shot_source_window(sh)
        spd = shot_speed(sh)
        out_sec = shot_output_sec(sh)
        total += out_sec
        nchars = dialogue_chars(sh.script_ref or "")
        # 变速会同时改变声音的播放速度：2 倍速时同一句台词只占一半时间，
        # 但音调会升高。所以给出**当前速度下**这一镜实际有多少秒可用，
        # 判断"够不够念完"由模型结合 measured_cps 自己做。
        row = {
            "shot_id": sh.id, "order": sh.order,
            "source_sec": round(src_dur, 2), "clip_in_sec": round(cin, 2),
            "speed": spd, "output_sec": round(out_sec, 2),
            "dialogue_chars": nchars,
            "has_dialogue": bool(nchars),
        }
        m = rates.get(sh.id)
        if m:
            row["measured_cps"] = m.get("cps")
            row["measured_subtitle_sec"] = m.get("subtitle_sec")
            #: 这一镜**实际转写**出来念了多少字 —— 比 `dialogue_chars`（剧本解析）
            #: 更硬。两个数差得多时，说明剧本解析不准或剧本改过，看原文判断。
            row["subtitle_chars"] = m.get("subtitle_chars")
            #: **本镜有多少秒是没人说话的**（画面在动、但没台词/停顿）。
            #: 这是"该裁还是该提速"的分界线，2026-10-24 加：
            #: 用户报"有些片段加速竟高达 1.8 倍"——一刀切提速把人声也提快了。
            #: 而多数长镜头里真正占时间的往往是**空档**，裁掉它既不失真也不变声。
            #: 只有在 idle 太小、确实没有可裁的余地时，才轮到提速。
            if m.get("subtitle_sec"):
                row["idle_sec"] = round(max(0.0, out_sec - float(m["subtitle_sec"])), 2)
        # 可压缩空间：提速到 1.5 倍 / 2 倍分别省多少（台词镜提到 4 倍会听不清）
        for k in (1.5, 2.0):
            row[f"save_at_{k}x"] = round(out_sec - src_dur / k, 2)
        rows.append(row)

    total = round(total, 2)
    out: dict = {
        "ok": True, "episode": episode,
        "total_sec": total,
        "counted_shots": len(rows),
        "skipped_disabled": disabled_n,
        "skipped_no_video": no_video_n,
    }
    if target_sec:
        gap = round(total - float(target_sec), 2)
        out["target_sec"] = float(target_sec)
        out["gap_sec"] = gap
        out["fits"] = gap <= 0
        if gap > 0:
            # 两条路的粗估，让模型知道"够不够"，不必自己反推
            dialog_sec = sum(r["output_sec"] for r in rows if r["has_dialogue"])
            action_sec = total - dialog_sec
            out["rough_plan"] = {
                "dialogue_sec": round(dialog_sec, 1),
                "action_sec": round(action_sec, 1),
                "hint": ("全部提到 1.5 倍可省 "
                         f"{round(total - total / 1.5, 1)}s；"
                         "纯动作镜（无台词）提到 2~3 倍不伤听感，"
                         "台词镜超过 1.5 倍人声会发尖。仍不够就得真删镜头。"),
            }
    out["shots"] = rows
    out["note"] = ("这些时长**已经算进变速与取片窗口**，可以直接拿来判断还差多少。"
                   "改：set_shots_speed / patch_shot_timeline / disabled=true 停用。")
    return out


@engine_tool(
    name="list_audio_clips",
    risk="read",
    role="viewer",
    description="列当前所有音轨段（配音/旁白/配乐/音效），带锚定镜头、时长、音量。",
)
async def list_audio_clips(ctx: ToolCtx, project_id: str) -> dict:
    from ..db import AudioClip

    with get_session() as s:
        rows = (s.query(AudioClip).filter(AudioClip.project_id == project_id)
                .order_by(AudioClip.start_shot_order).all())
        out = [{"id": c.id, "kind": c.kind, "text": (c.text or "")[:120] or None,
                "url": c.url, "duration": c.duration,
                "start_shot_order": c.start_shot_order,
                "start_offset_sec": c.start_offset_sec,
                "status": c.status} for c in rows]
    by_kind: dict[str, int] = {}
    for x in out:
        by_kind[x["kind"]] = by_kind.get(x["kind"], 0) + 1
    return {"ok": True, "clips": out, "counts": by_kind,
            "has_music": by_kind.get("music", 0) > 0}


@engine_tool(
    name="list_subtitle_clips",
    risk="read",
    role="viewer",
    description="列当前字幕段落（文本、锚定镜头、时长）。",
)
async def list_subtitle_clips(ctx: ToolCtx, project_id: str,
                              limit: int = 200) -> dict:
    from ..db import SubtitleClip

    with get_session() as s:
        rows = (s.query(SubtitleClip).filter(SubtitleClip.project_id == project_id)
                .order_by(SubtitleClip.start_shot_order).limit(limit).all())
        out = [{"id": c.id, "text": c.text, "kind": c.kind,
                "start_shot_order": c.start_shot_order,
                "start_offset_sec": c.start_offset_sec,
                "duration": c.duration} for c in rows]
    return {"ok": True, "count": len(out), "clips": out}


@engine_tool(
    name="measure_speech_rate",
    risk="read",
    role="viewer",
    description="量**本项目自己**的语速（字/秒），给判断镜头时长用。"
                "数据来自真实出片音轨的 ASR 字幕或 TTS 旁白的实测时长，"
                "给出中位数与 p10~p90 区间。"
                "**没有足够样本时会明说没有数据** —— 那就按你自己的判断来，"
                "不要去找一个『标准语速』，那个数字不存在"
                "（实测跨度 1.8~4.8 字/秒，项目之间也不一样）。不花钱、不改数据。",
)
async def measure_speech_rate(ctx: ToolCtx, project_id: str) -> dict:
    """本项目实测语速。用户说「语速对不对」「这镜台词念得完吗」时先量一下。

    ## 为什么不给一个常数（2026-10-24 用户裁定）

    用户原话：「你给的那个语速标准完全不对，不能让 agent 使用。
    agent 应该自己判断语速。」核过数据，这个判断成立：

      · 原常数 3.1 字/秒只标定于 **n=2** 个样本；
      · 拿 74 个**已正常出片**的带台词镜头反查，按它算的"台词下限"
        把其中 **40 个（54%）** 判成"念不完"——而它们全都出片成功；
      · 3.1 恰好是这批镜头的**中位数**，拿中位数当下限必然判掉一半；
      · 实测跨度 **1.80~4.76 字/秒（p10~p90）**，项目之间也有差异
        （四个 ASR 项目实测 3.77 / 3.33 / 4.09 / 3.07）。

    所以语速是**这个项目的数据**，不是平台常数。量得出来就给区间，
    量不出来就如实说没数据——让模型自己判断，比塞一个假权威好。

    ## 两组数据不能混用

    `asr`（真出片音轨，视频模型念的）≈ 3~5 字/秒；
    `tts`（TTS 朗读旁白）≈ 4.4~6 字/秒。差得不少。判断**台词镜**用 `asr`。
    """
    from ..speech_rate import measure

    return measure(project_id)


@engine_tool(
    name="list_bgm",
    risk="read",
    role="viewer",
    description="查配乐库。可按 mood（tension/suspense/triumph/warm/sad/comedy/"
                "epic/ambient/neutral）与强度过滤。库可能为空。",
)
async def list_bgm(ctx: ToolCtx, mood: str | None = None,
                   min_intensity: int = 1, max_intensity: int = 5) -> dict:
    from ..bgm import list_library

    return list_library(mood=mood, min_intensity=min_intensity,
                        max_intensity=max_intensity)


@engine_tool(
    name="list_sfx",
    risk="read",
    role="viewer",
    description="查音效库（关门、脚步、打斗、提示音等短音效）。按关键词与分类检索："
                "query 按空格切词、要求每个词都命中（中英文都行）；"
                "category 见返回的 categories；max_duration 用来排除比画面还长的音效。"
                "**最关键的是 usage**：你听不到声音，光看名字（「微光」「10月23日」）"
                "猜不出它该挂在哪。每条都带 usage（hit/accent/bed/texture）+ usage_hint 一句人话，"
                "直接按它决定：hit=挂在动作那一下，accent=挂在节拍点，bed=铺满一整段。"
                "也可以直接 usage=\"hit\" 按档位筛，比猜关键词快。"
                "**库可能为空** —— 空的时候跳过配音效这一步并如实告诉用户。",
)
async def list_sfx(ctx: ToolCtx, project_id: str = "",
                   query: str | None = None,
                   category: str | None = None,
                   usage: str | None = None,
                   max_duration: float | None = None,
                   limit: int = 40) -> dict:
    """音效库检索。`project_id` 只为与其他工具同形（音效库是平台级的，不分项目）。"""
    from ..sfx import list_library

    return list_library(query=query, category=category, usage=usage,
                        max_duration=max_duration, limit=limit)


@engine_tool(
    name="inspect_image",
    # `risk=generate`：它调多模态模型要花钱（只作展示标签）。
    risk="generate",
    costs=True,
    role="viewer",
    description="看一张图并描述它（首帧、通用定妆图、造型图、参考图）。"
                "用于核对生成结果是否符合预期。传 url 或 shot_id。",
)
async def inspect_image(ctx: ToolCtx, project_id: str,
                        url: str | None = None,
                        shot_id: str | None = None,
                        question: str = "这张图里有什么？人物外观、服装、场景是否一致？") -> dict:
    from ..providers.llm import LLMProvider

    target = url
    if not target and shot_id:
        with get_session() as s:
            sh = s.get(Shot, shot_id)
            if not sh or sh.project_id != project_id:
                return {"ok": False, "error": "镜头不存在"}
            target = sh.first_frame_url or sh.thumb_url
    if not target:
        return {"ok": False, "error": "没有可看的图：请传 url 或一个已有首帧/缩略图的 shot_id"}

    llm = LLMProvider()
    text = await llm.complete_vision(
        "你是影视画面审片员。客观描述你看到的内容，指出与要求不符之处。",
        question, target)
    return {"ok": True, "description": text, "url": target}


@engine_tool(
    name="wait_for_job",
    risk="read",
    role="viewer",
    description="等一个异步任务跑完（最长 300 秒）。**提交完生成任务必须调它**，"
                "否则下一步会拿到还没生成完的空数据。",
)
async def wait_for_job(ctx: ToolCtx, job_id: str, timeout_sec: int = 300) -> dict:
    import asyncio

    from ..jobs import get_job_phase

    waited = 0.0
    last = None
    while waited < max(1, min(timeout_sec, 300)):
        j = _job_of_project(ctx, job_id)
        if not j:
            return {"ok": False, "error": f"任务不存在: {job_id}"}
        last = j
        if j.status in ("done", "failed", "cancelled"):
            try:
                result = json.loads(j.result) if j.result else {}
            except (ValueError, TypeError):
                result = {}
            return {
                "ok": j.status == "done",
                "job_id": job_id, "kind": j.kind, "status": j.status,
                "progress": j.progress,
                "error": j.error,
                "result": result,
                "phase": get_job_phase(job_id),
            }
        await asyncio.sleep(2)
        waited += 2
    return {
        "ok": True, "job_id": job_id, "status": (last.status if last else "unknown"),
        "progress": (last.progress if last else 0),
        "timed_out": True,
        "note": "还没跑完，但已到本次等待上限。任务仍在后台运行，可以稍后再调 wait_for_job。",
    }


@engine_tool(
    name="get_job",
    risk="read",
    role="viewer",
    description="看一个任务的当前状态（不等待）。",
)
async def get_job_status(ctx: ToolCtx, job_id: str) -> dict:
    from ..jobs import get_job_phase

    j = _job_of_project(ctx, job_id)
    if not j:
        return {"ok": False, "error": f"任务不存在: {job_id}"}
    try:
        result = json.loads(j.result) if j.result else {}
    except (ValueError, TypeError):
        result = {}
    return {"ok": True, "job_id": j.id, "kind": j.kind, "status": j.status,
            "progress": j.progress, "error": j.error, "result": result,
            "phase": get_job_phase(j.id)}


@engine_tool(
    name="list_jobs",
    risk="read",
    role="viewer",
    description="列本项目最近的任务，看哪些在跑、哪些失败了。",
)
async def list_jobs(ctx: ToolCtx, project_id: str, limit: int = 20) -> dict:
    from ..db import Job

    with get_session() as s:
        rows = (s.query(Job).filter(Job.project_id == project_id)
                .order_by(Job.created_at.desc()).limit(limit).all())
        out = [{"id": j.id, "kind": j.kind, "status": j.status,
                "progress": j.progress, "error": j.error,
                "created_at": j.created_at} for j in rows]
        # 还在跑的必须都在：只看最近 `limit` 条的话，一条长任务排到后面就整条消失，
        # 侧栏显示「没有在跑的任务」而它其实还在出片（2026-11-02）。多给几条不贵。
        active_q = (s.query(Job).filter(Job.project_id == project_id,
                                        Job.status.in_(("pending", "running")))
                    .order_by(Job.created_at.desc()))
        have = {x["id"] for x in out}
        out = [{"id": j.id, "kind": j.kind, "status": j.status,
                "progress": j.progress, "error": j.error,
                "created_at": j.created_at} for j in active_q.all() if j.id not in have] + out
    return {"ok": True, "jobs": out,
            "active": [x for x in out if x["status"] in ("pending", "running")]}
