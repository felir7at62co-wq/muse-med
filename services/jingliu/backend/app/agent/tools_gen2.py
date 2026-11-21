"""生成工具（第二组）：把**网页上有按钮、但 Agent 调不到**的那批能力接进来。

## 为什么单独一个文件

`tools_gen.py` 已经 1700+ 行，而且它的成员都是「提交一个异步 job」。
这批不是：有的是同步的（拼设定板、写画风、建转场），有的是"调用一个已有
的 HTTP 端点"。混进去会让那个文件的分类失去意义。

## 为什么这些原来是缺口

它们各自在 `routers/{look,upscale,transitions,shots}.py` 里都有端点，
网页上有按钮，但从未注册成 agent 工具。于是：
  · 用户对 Agent 说「把这个场景的八张参考图补齐」——它只能说做不到；
  · 说「加一个淡出转场」——同上。

这不是"Agent 能力不足"，是**同一批能力有两条入口，只接通了其中一条**。
本文件的每个工具都只是薄壳：真正干活的是路由里那段逻辑（或它调的服务），
这里不复制判断。

## ⚠️ 薄壳不等于复制路由

能调路由函数就调路由函数（`create_transition` / `build_scene_board` 这类纯同步的），
调不了的（需要 `BackgroundTasks` 的参数、需要 `Request`）就调它内部那个服务。
**绝不在工具里重写一遍业务逻辑** —— 两份必然漂移，而漂移的方向永远是
"网页上做对了、Agent 做出来不对"。
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

from ..db import Asset, Project, Shot, get_session
from .executor import ToolCtx
from .registry import engine_tool

logger = logging.getLogger("fw.agent.tools_gen2")


# ---------------------------------------------------------------------------
# 场景多视角
# ---------------------------------------------------------------------------

@engine_tool(
    name="generate_scene_views",
    risk="generate",
    role="editor",
    costs=True,
    long_running=True,
    description="给一个**场景**资产生成/补齐多视角参考图（最多 8 张机位）。"
                "view_keys 留空 = 只补还没图的视角（省钱）；点名 = 无论有没有图都重画那几张。"
                "走 asset_batch 任务，返回 job_id，记得 wait_for_job。",
)
async def generate_scene_views(ctx: ToolCtx, project_id: str, asset_id: str,
                               view_keys: list[str] | None = None,
                               model_id: str | None = None) -> dict:
    from .. import charge
    from ..jobs import (RUNNERS, _resolve_asset_image_model,
                        create_job, find_active_job, get_job, scene_view_items_for_asset)
    from ..job_submit import _SUBMIT_LOCK, spawn_job
    from ..look_profile import ensure as _ensure_look
    from ..scene_view import BY_KEY
    from . import store
    from .registry import deterministic_job_id
    from .tools_gen import _cid

    with get_session() as session:
        a = session.get(Asset, asset_id)
        if not a or a.project_id != project_id:
            return {"ok": False, "error": "资产不存在或不属于本项目"}
        if a.kind != "location":
            return {"ok": False, "error": "只有场景资产有多视角参考图"}
        proj = session.get(Project, project_id)
        title = proj.title if proj else ""
        image_model = model_id or _resolve_asset_image_model(proj, "location")

    keys = [k for k in (view_keys or []) if k]
    bad = [k for k in keys if k not in BY_KEY]
    if bad:
        return {"ok": False, "error": f"未知视角: {'、'.join(bad)}",
                "valid_keys": sorted(BY_KEY)}

    try:
        look = await _ensure_look(project_id)
    except Exception as e:  # noqa: BLE001 影调是增强项，绝不阻断出图
        logger.warning("[tool] 场景视角生成时取影调失败，按无影调继续: %r", e)
        look = None

    # job id 与 `registry.submit_idempotent` 同一算法：同一个 (run, tool_call) 只提交、只预扣一次。
    # 桌面端 `call_id` 的约定（重发只接管已有任务）靠它兑现；点名视角时下面的
    # `find_active_job` 不去重，重发会再建一条任务、再扣一次钱。
    jid = deterministic_job_id(ctx.run_id, _cid(ctx, "scene_views"))

    async with _SUBMIT_LOCK:
        existing = get_job(jid)
        if existing is not None:
            # 从未推进过的 pending 行没有执行体（进程重启留下的），重新派发；running 一律不动。
            if (existing.status == "pending"
                    and (existing.updated_at or "") == (existing.created_at or "")):
                spawn_job(None, jid, existing.kind)
            ctx.spent_fen += store.reserved_of_job(jid)
            return {"ok": True, "job_id": jid, "kind": existing.kind,
                    "status": existing.status, "deduped": True,
                    "note": "这次调用已提交过，直接接管那条任务，没有重复提交。"}
        # 与端点同一条去重规则：没点名视角时与在跑的 asset_batch 完全重叠。
        if not keys:
            dup = find_active_job("asset_batch", project_id)
            if dup:
                return {"ok": True, "job_id": dup, "deduped": True,
                        "note": "该项目的资产生图任务正在跑，缺失视角会由它一并补齐。"
                                "要立刻重画某一张请点名 view_keys。"}
        with get_session() as session:
            a = session.get(Asset, asset_id)
            items = scene_view_items_for_asset(session, a, title, look, keys or None)
            session.commit()
        if not items:
            return {"ok": True, "nothing_to_do": True,
                    "note": "这个场景的参考图都已生成。要重画请指定 view_keys。"}
        payload = {"project_id": project_id, "items": items,
                   "size": "1792x1024", "model_id": image_model}
        # 报价与扣费分开算（同 registry.submit_idempotent）：不扣钱的人（管理员、
        # 闸门关着）照样拿到报价。2026-11-21 之前这里只把报价记进 `ctx.spent_fen`，
        # 从不预扣，视角图不收钱。预扣挂在先算好的 job id 上，
        # `_run_job_guarded` 结束时按实际出图张数多退少补。
        est, note = charge.estimate("asset_batch", payload)
        charged, _why = charge.should_charge("asset_batch", payload)
        if charged and est > 0:
            charge.hold("asset_batch", payload, jid, amount_fen=est, note=note)
        create_job("asset_batch", payload, jid=jid)
        # 连到本轮：重发时按这一行补记预扣额，停止本轮时这条任务一并停掉。
        store.link_run_job(ctx.run_id, jid, "generate_scene_views", est)
        ctx.spent_fen += est

    # 派发放在锁外：`spawn_job` 一进去就要读 job 行，持锁只是让出控制权。
    spawn_job(None, jid, "asset_batch")
    return {"ok": True, "job_id": jid, "kind": "asset_batch",
            "count": len(items), "estimate_fen": est,
            "note": "已派发，用 wait_for_job 等它跑完"}


@engine_tool(
    name="build_scene_board",
    risk="write",
    role="editor",
    description="把一个场景已有的多视角图拼成**美术设定板**（`Asset.board_url`）。"
                "纯本地合成，不花钱、不调模型、不生成新图。"
                "⚠️ 设定板只给人看，**不会**被当成参考图注入镜头。",
)
async def build_scene_board(ctx: ToolCtx, project_id: str, asset_id: str) -> dict:
    from .. import scene_board
    from ..db import desc_of
    from .. import look_profile as _lp
    from .. import scene_view as _sv

    with get_session() as session:
        a = session.get(Asset, asset_id)
        if not a or a.project_id != project_id:
            return {"ok": False, "error": "资产不存在或不属于本项目"}
        if a.kind != "location":
            return {"ok": False, "error": "只有场景资产有设定板"}
        proj = session.get(Project, project_id)
        title = proj.title if proj else ""
        look_text = _lp.phrase(_lp.decode(proj.look_json) if proj else None)
        views = [{"label": r.label, "kind": r.kind, "image_url": r.image_url}
                 for r in _sv.ensure_views(session, a)]
        desc, name = desc_of(a), a.name
        session.commit()

    # 拼板与直传进桶都是同步 IO，放进线程，不占事件循环
    url = await asyncio.to_thread(scene_board.build, title, name, views, description=desc,
                                  look_text=look_text or None)
    if not url:
        return {"ok": False, "error": "设定板拼装失败（详见后端日志）"}
    with get_session() as session:
        a = session.get(Asset, asset_id)
        if a is not None:
            a.board_url = url
            session.commit()
    return {"ok": True, "asset_id": asset_id, "board_url": url}


@engine_tool(
    name="read_scene_views",
    risk="read",
    role="viewer",
    description="看一个**场景**资产的多视角参考图现状：哪些视角有图、哪些缺、体检结论。"
                "判断该不该补图之前先看它。",
)
async def read_scene_views(ctx: ToolCtx, project_id: str, asset_id: str) -> dict:
    from .. import scene_view as _sv

    with get_session() as session:
        a = session.get(Asset, asset_id)
        if not a or a.project_id != project_id:
            return {"ok": False, "error": "资产不存在或不属于本项目"}
        if a.kind != "location":
            return {"ok": False, "error": "只有场景资产有多视角参考图"}
        rows = _sv.ensure_views(session, a)
        session.commit()
        # ⚠️ session 一关，`a` 就 detach 了：后面再读 `a.name` / `a.board_url`
        # 会抛 DetachedInstanceError。必须在会话内取出来。
        name, board_url = a.name, a.board_url
        out = []
        for r in rows:
            qc = None
            if (r.qc_json or "").strip():
                try:
                    qc = json.loads(r.qc_json)
                except (ValueError, TypeError):
                    qc = None
            out.append({"view_key": r.view_key, "label": r.label,
                        "has_image": bool((r.image_url or "").strip()),
                        "qc_ok": (qc or {}).get("ok") if qc else None})
    return {"ok": True, "asset_id": asset_id, "name": name,
            "views": out,
            "missing": [v["view_key"] for v in out if not v["has_image"]],
            "board_url": board_url}


@engine_tool(
    name="qc_asset_image",
    risk="generate",
    role="editor",
    costs=True,
    description="视觉体检：核验「人物图里没有场景 / 场景图里没有人 / 标注是否到位」。"
                "调多模态模型要花钱。**只出结论、不删图**。",
)
async def qc_asset_image(ctx: ToolCtx, project_id: str, asset_id: str,
                         view_keys: list[str] | None = None,
                         expect_three_view: bool = True,
                         expect_name_label: bool = True) -> dict:
    import asyncio

    from .. import asset_qc
    from .. import scene_view as _sv

    with get_session() as session:
        a = session.get(Asset, asset_id)
        if not a or a.project_id != project_id:
            return {"ok": False, "error": "资产不存在或不属于本项目"}
        kind, name = a.kind, a.name
        if kind == "location":
            rows = _sv.ensure_views(session, a)
            session.commit()
            want = set(view_keys or [])
            targets = [(r.id, r.view_key, r.label, r.image_url) for r in rows
                       if (r.image_url or "").strip()
                       and (not want or r.view_key in want)]
        else:
            targets = [(None, None, "通用定妆图", a.image_url)] if (a.image_url or "").strip() else []
            from .. import stage_gate
            from ..db import AssetStage
            for st in stage_gate.alive(
                    session.query(AssetStage)
                    .filter(AssetStage.project_id == a.project_id,
                            AssetStage.character_name == a.name)).all():
                if (st.image_url or "").strip():
                    targets.append((None, None, st.stage_name or "造型", st.image_url))
    if not targets:
        return {"ok": False, "error": "这个资产还没有可体检的图"}

    async def _one(t):
        _rid, _key, label, url = t
        if kind == "location":
            res = await asset_qc.check_scene(url, expect_name_label=expect_name_label)
        else:
            res = await asset_qc.check_character(
                url, expect_three_view=expect_three_view,
                expect_name_label=expect_name_label)
        return {"label": label, "image_url": url, "result": res,
                "summary": asset_qc.describe(res)}

    out = await asyncio.gather(*[_one(t) for t in targets])
    bad = [i for i in out if i["result"] and not i["result"].get("ok")]
    return {"ok": True, "name": name, "kind": kind, "checked": len(out),
            "failed": len(bad),
            "items": [{k: v for k, v in i.items() if k != "image_url"} for i in out]}


# ---------------------------------------------------------------------------
# 影调 / 画风
# ---------------------------------------------------------------------------

@engine_tool(
    name="get_project_look",
    risk="read",
    role="viewer",
    description="读项目的**影调档案**（全片调色基调 + 可选词表）。"
                "影调决定所有资产图与首帧的调色是否统一。",
)
async def get_project_look(ctx: ToolCtx, project_id: str) -> dict:
    from .. import look_profile as _lp

    with get_session() as session:
        p = session.get(Project, project_id)
        if not p:
            return {"ok": False, "error": "项目不存在"}
        look = _lp.decode(p.look_json)
    return {"ok": True, "look": look, "phrase": _lp.phrase(look),
            "has_look": bool(look)}


@engine_tool(
    name="regenerate_project_look",
    risk="generate",
    role="manager",
    costs=True,
    confirm="会**清空现有影调档案**再按剧本重判一套。已有的调色基调会丢，" \
            "且已生成的图不会重画（只影响此后新生成的）。确定要重判吗？",
    description="按剧本重新判一套**影调**（清空旧档案后重跑）。"
                "影调是审美判断，重判几乎必然给出不同结果，所以只由用户显式触发。",
)
async def regenerate_project_look(ctx: ToolCtx, project_id: str) -> dict:
    from .. import look_profile as _lp

    with get_session() as session:
        p = session.get(Project, project_id)
        if not p:
            return {"ok": False, "error": "项目不存在"}
        p.look_json = None          # 清空才会被 ensure 当作"缺档案"
        session.commit()
    look = await _lp.ensure(project_id)
    if not look:
        return {"ok": False, "error": "影调档案生成失败，请重试"}
    return {"ok": True, "look": look, "phrase": _lp.phrase(look)}


@engine_tool(
    name="set_project_art_style",
    risk="write",
    role="manager",
    description="改项目**画风**（都市真人/古风/3D 等）。"
                "⚠️ 不会重画任何已生成的图，只影响此后新生成的资产图、"
                "场景视角、首帧与视频提示词。传空串 = 回到该模式默认档。",
)
async def set_project_art_style(ctx: ToolCtx, project_id: str, art_style: str) -> dict:
    from .. import style_preset as _sp

    with get_session() as session:
        p = session.get(Project, project_id)
        if not p:
            return {"ok": False, "error": "项目不存在"}
        p.art_style = _sp.sanitize(p.production_mode, art_style or None)
        session.commit()
        mode, chosen = p.production_mode, p.art_style
    eff = _sp.resolve(mode, chosen)
    return {"ok": True, "art_style": chosen, "effective_style": eff.key,
            "effective_label": eff.label,
            # 选了一档但它还没启用时要说清楚，否则用户以为古风已生效
            "pending": bool(chosen) and chosen != eff.key}


@engine_tool(
    name="list_art_styles",
    risk="read",
    role="viewer",
    description="列当前生产模式下可选的画风档位（key + 中文名 + 是否已启用）。"
                "改画风之前先看它。",
)
async def list_art_styles(ctx: ToolCtx, project_id: str) -> dict:
    from .. import style_preset as _sp

    with get_session() as session:
        p = session.get(Project, project_id)
        if not p:
            return {"ok": False, "error": "项目不存在"}
        mode, chosen = p.production_mode, p.art_style
    eff = _sp.resolve(mode, chosen)
    cat = {m["key"]: m for m in _sp.catalog()["modes"]}
    m = cat.get((mode or "drama"), cat["drama"])
    return {"ok": True, "production_mode": mode, "art_style": chosen,
            "effective_style": eff.key, "effective_label": eff.label,
            "styles": m["styles"], "default_style": m["default"]}


# ---------------------------------------------------------------------------
# 转场
# ---------------------------------------------------------------------------

@engine_tool(
    name="list_transitions",
    risk="read",
    role="viewer",
    description="列项目的全部**转场**（接缝 + 类型 + 时长）。",
)
async def list_transitions(ctx: ToolCtx, project_id: str) -> dict:
    from ..db import Transition
    with get_session() as session:
        rows = (session.query(Transition)
                .filter(Transition.project_id == project_id).all())
        return {"ok": True, "transitions": [{
            "id": t.id, "type": t.type, "duration": t.duration,
            "from_shot_id": t.from_shot_id, "to_shot_id": t.to_shot_id,
        } for t in rows]}


@engine_tool(
    name="set_transition",
    risk="write",
    role="editor",
    description="在两个**相邻**镜头的接缝处设转场（同一接缝只允许一个，重复提交视为替换）。"
                "type 例如 fade/dissolve/wipe；duration 会被钳到两侧镜头各一半以内。",
)
async def set_transition(ctx: ToolCtx, project_id: str, from_shot_id: str,
                         to_shot_id: str, type: str = "fade",
                         duration: float = 0.5) -> dict:
    """薄壳：直接调路由函数，不复制它的校验。

    `create_transition` 是**同步纯函数**（只写库），所以可以在这里直接调 ——
    这正是"判断只有一份"能成立的前提。它内部会核对两个镜头都属于本项目、
    且必须相邻。
    """
    from ..routers.transitions import TransitionIn, create_transition

    body = TransitionIn(project_id=project_id, from_shot_id=from_shot_id,
                        to_shot_id=to_shot_id, type=type, duration=duration)
    try:
        return {"ok": True, **create_transition(body)}
    except Exception as e:  # noqa: BLE001 — HTTPException 也是异常，转成 ok=false
        from fastapi import HTTPException
        if isinstance(e, HTTPException):
            return {"ok": False, "error": str(e.detail)}
        raise


@engine_tool(
    name="delete_transition",
    risk="write",
    role="editor",
    description="删掉一条转场（按 id）。",
)
async def delete_transition(ctx: ToolCtx, project_id: str, trans_id: str) -> dict:
    from fastapi import HTTPException
    from ..routers.transitions import delete_transition as _del

    # 归属：转场表没有 project_id 之外的归属校验，先确认它属于本项目
    from ..db import Transition
    with get_session() as session:
        t = session.get(Transition, trans_id)
        if not t or t.project_id != project_id:
            return {"ok": False, "error": "转场不存在或不属于本项目"}
    try:
        return {"ok": True, **_del(trans_id)}
    except HTTPException as e:
        return {"ok": False, "error": str(e.detail)}


# ---------------------------------------------------------------------------
# 高清：独立视频放大（≠ run_upscale）
# ---------------------------------------------------------------------------

@engine_tool(
    name="run_video_upscale",
    risk="generate",
    role="editor",
    costs=True,
    long_running=True,
    description="把**已上传的若干视频文件**整批送去做高清放大（SeedVR2，按机时计费）。"
                "urls 是 `/v2/media/upload` 返回的地址，必须属于本项目。"
                "⚠️ 与 run_upscale 不是一回事：那个放大的是**镜头已出的片**，"
                "这个放大的是任意上传素材。",
)
async def run_video_upscale(ctx: ToolCtx, project_id: str,
                            urls: list[str]) -> dict:
    from .. import charge
    from ..db import MediaClip
    from ..jobs import RUNNERS, create_job
    from ..job_submit import _SUBMIT_LOCK, spawn_job
    from ..media import probe_duration_local
    import asyncio as _aio

    cand = list(dict.fromkeys(u.strip() for u in (urls or []) if u and u.strip()))
    if not cand:
        return {"ok": False, "error": "先上传至少一个视频"}
    with get_session() as session:
        rows = (session.query(MediaClip)
                .filter(MediaClip.project_id == project_id,
                        MediaClip.url.in_(cand)).all())
    by_url = {r.url: r for r in rows}
    missing = [u for u in cand if u not in by_url]
    if missing:
        return {"ok": False, "error": f"有 {len(missing)} 个文件不在这个项目的素材里"}
    not_video = [by_url[u].name for u in cand if by_url[u].kind != "video"]
    if not_video:
        return {"ok": False, "error": "只能放大视频：" + "、".join(not_video[:5])}

    durs = await _aio.gather(*(probe_duration_local(u) for u in cand))
    bad = [by_url[u].name for u, d in zip(cand, durs) if d <= 0]
    if bad:
        return {"ok": False,
                "error": "读不出时长，文件可能已损坏：" + "、".join(bad[:5])}
    items = [{"url": u, "name": by_url[u].name, "duration": round(float(d), 3)}
             for u, d in zip(cand, durs)]
    payload = {"project_id": project_id, "items": items}
    est, _note = charge.estimate("video_upscale", payload)
    async with _SUBMIT_LOCK:
        jid = create_job("video_upscale", payload)
    spawn_job(None, jid, "video_upscale")
    ctx.spent_fen += est
    return {"ok": True, "job_id": jid, "kind": "video_upscale",
            "count": len(items), "estimate_fen": est,
            "note": "已派发，用 wait_for_job 等它跑完"}


# ---------------------------------------------------------------------------
# 首帧 / 一键成片（两个工具都已删除）
# ---------------------------------------------------------------------------

# ⚠️ 这里原有 `regen_first_frame` 工具（给单个镜头重出首帧图），2026-11-20 从 Agent
# 工具面删除：首帧路线整体下线（用户裁定），理由见 `tools_gen.py` 里 `run_first_frames`
# 原位置的说明。对应的 HTTP 路由 `POST /shots/{id}/first-frame` 恒回 410。


# ⚠️ 这里原有 `run_one_click_film` 工具（拆解 → 资产 → 首帧 → 片段 一条龙），
# 2026-11-19 从 Agent 工具面删除。
#
# 一键成片里并没有一个独立的「写提示词」阶段可以单独摘掉：提示词原先是**夹在**
# 拆解里（拆完逐镜预生成）和出片里（没有稿就现写）产生的。这两处都已删除，
# 于是这条链在「资产」与「片段」之间缺了必须由 Muse 来做的一步 ——
# 对着场景图写镜头脚本并锁定。对 Agent 来说它不再是一个能一口气跑完的工具，
# 留着只会让它提交一条注定在出片环节全部失败的任务。
# Agent 现在按步骤走：run_breakdown（或 write_episode_shots）→ run_asset_fill →
# get_episode_readiness → set_shot_prompts(lock=true) → run_shot_videos。
#
# 任务本身（`jobs.run_one_click_film`，kind=one_click_film）没有删：网页上的按钮还在用，
# 对已经锁好镜头脚本的项目仍然有效；一镜锁定稿都没有时它会在出片之前停下并说明。
