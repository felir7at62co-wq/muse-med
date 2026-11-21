"""高清放大（RunningHub SeedVR2 超分）的提交路由。

`POST /v2/projects/{pid}/upscale` —— 对项目里**当前采用的**所有片段跑超分，
产物落成新的 `ShotVersion`（原片保留可切回）。

进度与结果走现成的 `GET /v2/jobs/{id}`，前端不需要新轮询器。

## 为什么不写进 routes_v2.py

同 `routers/desub.py`：那个文件的行数预算在架构守卫里是「只许减」，
而这条路由与 `routes_v2` 里任何东西都没有共享状态。

## 为什么要转一手 `_run_job_guarded` 与 `_SUBMIT_LOCK`

同样的两条理由，在**这条**路由上比去字幕更硬：

  · 少了 `_SUBMIT_LOCK` 的查重，双击提交就是两批任务同时放大同一批镜头。
    放大按**机时**计费（实测 ¥6/h，2 秒片段 139 秒），
    一次重复提交在长片项目上就是几十块钱和几个小时的排队。
  · 少了 guard，runner 里 gather 抛异常会让 Job 永远停在 running，
    而 `find_active_job` 把 running 当"正在跑"，该项目之后**再也提交不了**
    同组任务 —— 包括出片。对一个会花钱的批量任务，卡死比失败更糟。

## ⚠️ 会花钱且不可撤销

钱花了就是花了，这一点与去字幕相同、与出片相同。区别是**产物可逆**
（新版本落 ShotVersion，原片仍在，版本区随时切回）。所以前端那次确认框
要复述的是「N 个片段 / 按机时计费」，而不是问"确定吗"。
"""
from __future__ import annotations

from typing import Optional

import uuid

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/v2", tags=["upscale"])


class UpscaleIn(BaseModel):
    #: 点名要放大的镜头。缺省 = 全片（当前有成片的那些）。
    #: 带了非空 shot_ids 即「定向提交」，按 find_active_job 的既有规则不参与去重
    #: （TB-04：用户点名了要哪几镜，不该被在跑的批量任务挡住）。
    shot_ids: list[str] | None = None
    #: 只放大某一集。**与 shot_ids 是两条独立的路**：按集必须走服务端过滤，
    #: 前端自己折成 shot_ids 会把它变成"定向提交"从而跳过去重（TB-04），
    #: 用户连点两次就开两批、重复烧机时。
    episode: int | None = None
    #: 是否跳过**当前采用版本已经是高清**的镜头。缺省（None）= 跳过。
    #:
    #: ⚠️ 这个字段是 2026-10-26 补上的。此前前端「全部（含已高清，重做一遍）」
    #:    那一档一直在发 `skip_hd: false`，而本模型**没有这个字段** ——
    #:    Pydantic 默认忽略未知字段，于是那个选项从来没生效过：选了"重做一遍"，
    #:    实际仍然按 skip_hd=True 跳过已高清的，全部已高清时直接 422
    #:    「没有可放大的片段」。用户看不到任何报错线索，只会觉得这个选项是坏的。
    skip_hd: bool | None = None


class UpscaleJobOut(BaseModel):
    """与 `POST /v2/jobs` 的 JobOut **逐字段同构**（有意为之）。

    前端于是能直接复用已有的 `JobOut` 类型与 `jobStatus()` 轮询器。
    """
    id: str
    kind: str
    status: str
    progress: int = 0
    result: Optional[str] = None
    error: Optional[str] = None
    deduped: bool = False
    #: 因已在跑而被剔掉的镜头 id。与 deduped 是两件事，见 job_models.JobOut。
    skipped: list[str] = []
    phase: Optional[dict] = None


@router.post("/projects/{project_id}/upscale", response_model=UpscaleJobOut)
async def upscale(project_id: str, background: BackgroundTasks,
                  body: UpscaleIn | None = None) -> UpscaleJobOut:
    """对当前有成片的镜头整批跑高清放大（RunningHub，按机时计费）。

    「当前」的判据是 `shot.video_url` 非空 —— 它恒等于 `adopted_version`
    那一版，所以重新生成后被换下的旧版本天然不参与，这里不需要筛。
    """
    from ..db import get_session
    from ..jobs import (RUNNERS, create_job, get_job, get_job_phase,
                        group_covering_map)
    from ..routes_v2 import _run_job_guarded, _SUBMIT_LOCK
    from ..upscale_jobs import upscale_candidates

    from .. import charge

    kind = "upscale"
    payload = {"project_id": project_id}
    ids = (body.shot_ids if body else None) or []
    if ids:
        payload["shot_ids"] = ids
    if body is not None and body.episode is not None:
        payload["episode"] = int(body.episode)
    # ⚠️ 只有**显式给了 False** 才写进 payload：缺省是"跳过已高清的"，
    #    而下发 `skip_hd: true` 与不下发在语义上完全相同，多一个键只会让
    #    存进库的 payload 与老任务长得不一样、排查时多一层噪音。
    if body is not None and body.skip_hd is False:
        payload["skip_hd"] = False

    dropped: list[str] = []
    async with _SUBMIT_LOCK:
        # ---- 先算出这次**实际**要动哪几镜，再逐镜比冲突（2026-10-26）----
        #
        # 此前这里第一步是 `find_active_job(kind, project_id, payload)`：命中
        # `shots` 组里**任意**活跃任务就原样返回它（`deduped:true`），既不建
        # 任务也不扣费。于是"第 19 集重出一镜"能把"第 11 集整集放大"打回去，
        # 而两者一镜都不重叠。生产 14 天实测：72 次放大提交里 12 次一个任务
        # 都没建出来，11 次是被毫不相干的单镜重生成挡掉的。
        #
        # 冲突的正当理由（同组各 kind 都改 `shot.video_url`，同时写会互相覆盖）
        # 天生是**镜头级**的：不碰同一镜就互不干扰。所以判据换成
        # `group_covering_map`——它按真实镜头集合算交集，跨 kind 也认。
        #
        # ⚠️ 判据必须用 `upscale_candidates`（与 runner、与 charge.estimate
        #    共用同一处）：`{project_id}` 这种"全片"payload 说不清是哪几镜，
        #    只有展开成实际候选集才能比出交集。
        with get_session() as session:
            cand = upscale_candidates(session, project_id, payload=payload)
            want = [s.id for s in cand]
        if not want:
            # 与 runner 的报错同一句话：省掉一条注定失败的任务和不必要的预扣。
            raise HTTPException(
                status_code=422,
                detail="没有可放大的片段。请先生成片段，再跑高清放大。")

        covered = group_covering_map(kind, project_id, want)
        keep = [i for i in want if i not in covered]
        dropped = [i for i in want if i in covered]

        if not keep:
            # 一镜都排不上。两种截然不同的情况，不能混为一谈：
            jobs_touching = {covered[i] for i in dropped}
            one = next(iter(jobs_touching)) if len(jobs_touching) == 1 else None
            job = get_job(one) if one else None
            if job is not None and job.kind == kind:
                # ① 真重复：同一批镜头已经在放大（双击、刷新后重提交）。
                #    复用那条，界面照着看它的进度。
                return UpscaleJobOut(id=job.id, kind=job.kind, status=job.status,
                                     progress=job.progress, deduped=True,
                                     skipped=dropped, phase=get_job_phase(job.id))
            # ② 不是重复，是**冲突**：这些镜头正被另一类任务占着（出片/去字幕）
            #    而已。回一句 deduped 会把用户骗去盯一条根本不是放大的任务，
            #    所以这里如实说清是谁占的、等它跑完再试。
            if job is not None:
                who = {"shot_videos": "出片", "first_frames": "首帧生成",
                       "first_frame_pipeline": "一条龙出片",
                       "one_click_film": "一键成片",
                       "desub_scan": "字幕检测", "desub_apply": "字幕擦除",
                       }.get(job.kind, job.kind)
                detail = (f"要放大的 {len(dropped)} 个镜头正在{who}中，"
                          "等那一批跑完再放大即可——现在提交会拿到正在作废的素材")
            else:
                detail = ("这些镜头正在别的任务里处理，且查不到对应任务——"
                          "请稍后在「任务队列」确认后再试")
            raise HTTPException(status_code=409, detail=detail)

        jid = uuid.uuid4().hex[:12]
        # 有镜头被占用时，把这次提交**折成显式镜头集合**：只跑没被占用的那些。
        # 一镜都没被占用时保持原 payload（`episode` / `skip_hd` 原样带着），
        # 不制造无谓的差异。
        #
        # ⚠️ 折成 shot_ids 会不会让"已高清的也照做"？不会：`want` 本身就是
        #    `upscale_candidates` 按 skip_hd 筛过的结果，显式列出等于同一批。
        #    语义等价，不是放宽。
        submit = payload
        if dropped:
            submit = {"project_id": project_id, "shot_ids": keep}
        # ⚠️ 这条路由此前**整条都没有扣费**（2026-10-15 补上）：`charge.estimate`
        #    里写着高清的价，但没有任何地方调它，于是这条链路"用量记了、
        #    余额没扣"——报表里看得见花费，用户的积分一分没少。
        #    顺序与 POST /v2/jobs 一致：查重 → 扣 → 建 job，且共用同一个 id
        #    （预扣挂在别的 id 上就永远结算不了）。
        _est, _note = charge.estimate(kind, submit)
        charge.hold(kind, submit, jid, amount_fen=_est, note=_note)
        create_job(kind, submit, jid=jid)
    background.add_task(_run_job_guarded, RUNNERS[kind], jid, kind)
    return UpscaleJobOut(id=jid, kind=kind, status="pending", progress=0,
                      skipped=dropped)


# --------------------------------------------------------------- 独立「高清」页
#
# 镜流左栏「高清」（2026-10-17 用户需求）：上传一个或多个视频，整批放大、全部并发。
# 与上面那条按镜头放大的区别：**不挂镜头**。产物只活在 job.result 里，
# 列表端点就是它们唯一能被找回来的入口（同「生图」页的 image-jobs）。

class VideoUpscaleIn(BaseModel):
    #: 已上传素材的地址（`POST /v2/media/upload` 返回的 `/fw/media/uploads/…`）。
    urls: list[str]


@router.post("/projects/{project_id}/video-upscale", response_model=UpscaleJobOut)
async def video_upscale(project_id: str, body: VideoUpscaleIn,
                        background: BackgroundTasks) -> UpscaleJobOut:
    """把上传的若干视频整批送去高清放大（RunningHub SeedVR2，按机时计费）。

    ## 三道校验，都在花钱之前

    1. **文件必须属于这个项目**：按 `media_clips` 反查（上传时带 project_id 就会登记）。
       只校验"URL 长得像上传目录"不够——别的项目的上传地址也长这样，
       直接收下就等于拿别人的素材、花自己的钱，或者反过来。
    2. **必须是视频**：`media_clips.kind == "video"`。
    3. **能读出时长**（服务端 ffprobe）：读不出 = 文件坏了 / 不是真视频，当场 422，
       不让用户提交后干等一个注定失败的任务。

    ## 计费：按 RunningHub 实际机时，不按源文件时长

    实际扣费 = RunningHub 回报的 `taskCostTime`（真实运行秒数）× 6 元/小时，
    由 provider 在出片时记进 usage、任务结束时 `charge.settle` 按它结算。
    源文件时长**只用来估预扣**（提交时先冻结一笔、跑完多退）——没有预扣，
    余额为 0 的人也能提交一批，跑完才发现欠费。

    ## 去重：按**文件**，交集剔除（与 10-16 镜头去重同一语义）

    同一个文件已经在某条在跑的放大任务里 → 从这次里剔掉，剩下的照常提交；
    全部都在跑才复用原任务（deduped）。批与批之间**不互斥**——
    放大 A 批的时候 B 批照样能提交，这正是这个页面"全部并发"的意思。
    """
    from ..db import Job, MediaClip, get_session
    from ..jobs import RUNNERS, create_job, get_job, get_job_phase
    from ..job_submit import _SUBMIT_LOCK, _run_job_guarded
    from ..media import probe_duration_local
    from .. import charge
    import asyncio as _aio
    import json as _json

    urls = list(dict.fromkeys(u.strip() for u in (body.urls or []) if u and u.strip()))
    if not urls:
        raise HTTPException(status_code=422, detail="先上传至少一个视频")

    with get_session() as s:
        rows = (s.query(MediaClip)
                .filter(MediaClip.project_id == project_id, MediaClip.url.in_(urls))
                .all())
    by_url = {r.url: r for r in rows}
    missing = [u for u in urls if u not in by_url]
    if missing:
        raise HTTPException(status_code=404,
                            detail=f"有 {len(missing)} 个文件不在这个项目的素材里，请重新上传")
    not_video = [by_url[u].name for u in urls if by_url[u].kind != "video"]
    if not_video:
        raise HTTPException(status_code=422,
                            detail="只能放大视频：" + "、".join(not_video[:5]))

    # 量时长（只用于预扣估算与坏文件拦截；并发，且在锁外：
    # ffprobe 是 await，放进 _SUBMIT_LOCK 里会让别人的提交排队）
    durs = await _aio.gather(*(probe_duration_local(u) for u in urls))
    bad = [by_url[u].name for u, d in zip(urls, durs) if d <= 0]
    if bad:
        raise HTTPException(status_code=422,
                            detail="读不出时长，文件可能已损坏：" + "、".join(bad[:5]))
    items = [{"url": u, "name": by_url[u].name, "duration": round(float(d), 3)}
             for u, d in zip(urls, durs)]

    kind = "video_upscale"
    dropped: list[str] = []
    async with _SUBMIT_LOCK:
        # 已在跑的文件：剔掉（同一个文件放大两遍 = 机时翻倍、产物一模一样）
        with get_session() as s:
            active = (s.query(Job)
                      .filter(Job.kind == kind, Job.project_id == project_id,
                              Job.status.in_(("pending", "running")))
                      .all())
        running: dict[str, str] = {}
        for j in active:
            try:
                for it in (_json.loads(j.payload or "{}").get("items") or []):
                    if isinstance(it, dict) and it.get("url"):
                        running.setdefault(it["url"], j.id)
            except ValueError:
                continue
        keep = [it for it in items if it["url"] not in running]
        dropped = [it["url"] for it in items if it["url"] in running]
        if not keep:
            job = get_job(running[items[0]["url"]])
            if job:
                return UpscaleJobOut(id=job.id, kind=job.kind, status=job.status,
                                     progress=job.progress, deduped=True,
                                     phase=get_job_phase(job.id))
            raise HTTPException(status_code=409,
                                detail="这些视频都已在放大队列里了，请在下方记录里看进度")

        payload = {"project_id": project_id, "items": keep}
        jid = uuid.uuid4().hex[:12]
        # 顺序与 POST /v2/jobs 一致：查重 → 扣 → 建 job，钱和任务共用同一个 id
        _charged, _ = charge.should_charge(kind, payload)
        if _charged:
            _est, _note = charge.estimate(kind, payload)
            if _est > 0:
                charge.hold(kind, payload, jid, amount_fen=_est, note=_note)
        create_job(kind, payload, jid=jid)
    background.add_task(_run_job_guarded, RUNNERS[kind], jid, kind)
    return UpscaleJobOut(id=jid, kind=kind, status="pending", progress=0,
                         skipped=dropped)


@router.get("/projects/{project_id}/video-upscale-jobs")
def list_video_upscale_jobs(project_id: str, limit: int = 30) -> dict:
    """「高清」页的历史：本项目最近若干批独立放大，带每个文件的结果。

    按 rowid 倒序（Job 表的插入顺序，同 image-jobs）。只回 `video_upscale`，
    不掺按镜头放大的 `upscale`——那些产物已经是镜头的新版本，归属在分镜页。
    """
    import json as _json
    from sqlalchemy import text as _sql_text
    from ..db import Job, get_session
    from ..upscale_jobs import video_upscale_items

    limit = max(1, min(int(limit or 30), 100))
    with get_session() as s:
        rows = (s.query(Job)
                .filter(Job.kind == "video_upscale", Job.project_id == project_id)
                .order_by(_sql_text("rowid DESC")).limit(limit).all())
    out = []
    for j in rows:
        try:
            res = _json.loads(j.result) if j.result else {}
        except ValueError:
            res = {}
        try:
            pl = _json.loads(j.payload or "{}")
        except ValueError:
            pl = {}
        # 还没开跑（pending）时 result 为空：用 payload 里的清单撑出"排队中"的行，
        # 否则刚提交的那一批在列表里是空的，用户会以为没提交上
        items = res.get("items") or [
            {**it, "status": "pending"} for it in video_upscale_items(pl)]
        out.append({"job_id": j.id, "status": j.status, "progress": j.progress,
                    "created_at": j.created_at, "user_id": j.user_id,
                    "error": j.error, "items": items,
                    "cost_sec": res.get("cost_sec") or 0.0})
    return {"items": out}
