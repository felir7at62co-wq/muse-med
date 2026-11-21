"""去字幕的两条提交路由。

`POST /v2/projects/{pid}/desub/scan`   —— 识别全片的烧录字幕（只写标记，不花钱）
`POST /v2/projects/{pid}/desub/apply`  —— 把确认过的区间真正擦掉（**按时长计费**）

进度与结果走现成的 `GET /v2/jobs/{id}`，前端不需要新轮询器。

## 为什么不写进 routes_v2.py

那个文件的行数预算在架构守卫里是「只许减」。更实际的理由是：这两条路由与
`routes_v2` 里任何东西都没有共享状态，放进去只会让那个已经很难读的文件再长一截。

## 为什么要转一手 `_run_job_guarded` 与 `_SUBMIT_LOCK`

通用的 `POST /v2/jobs` 已经把「查重 → 建 job」的原子性和「runner 抛异常也要落
终态」这两件事做对了，而两者**都不是可选的**：
  · 少了锁，双击提交就是两批任务同时擦同一批镜头（去字幕按时长计费，直接翻倍）；
  · 少了 guard，runner 里 gather 抛异常会让 Job 永远停在 running，
    而 `find_active_job` 把 running 当"正在跑"，该项目之后**再也提交不了**同组任务。
所以这里复用它们，而不是另写一份看起来更简单的提交逻辑。
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/v2", tags=["desub"])


class DesubIn(BaseModel):
    #: 点名要处理的镜头。缺省 = 全片。
    #: 带了非空 shot_ids 即「定向提交」，按 find_active_job 的既有规则不参与去重
    #: （TB-04：用户点名了要哪几镜，不该被在跑的批量任务挡住）。
    shot_ids: list[str] | None = None
    #: 只处理这一集（2026-10-16）。与 shot_ids 同给时两者**同时生效**（取交集）。
    #: 走这个字段而不是让前端展开成 shot_ids：后者会绕过去重，见 desub_jobs._in_scope。
    episode: int | None = None
    #: 只擦**这几条**已识别出的区间（2026-10-19）。检测与擦除拆成两步之后，
    #: 用户可能在同一个镜头里只勾了一部分区间；按镜头提交会把没勾的也擦掉
    #: （白花钱且不可逆）。空/缺省 = 该镜头所有未执行的区间。
    region_ids: list[str] | None = None


class DesubJobOut(BaseModel):
    """与 `POST /v2/jobs` 的 JobOut **逐字段同构**（有意为之）。

    前端于是能直接复用已有的 `JobOut` 类型与 `jobStatus()` 轮询器，
    不必为去字幕单开一套返回类型 —— 少一个类型就少一处会漂的契约。
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


async def _submit(kind: str, project_id: str, body: DesubIn | None,
                  background: BackgroundTasks) -> DesubJobOut:
    from ..db import get_session
    from ..jobs import RUNNERS, create_job, get_job, get_job_phase
    from ..job_submit import _SUBMIT_LOCK, _run_job_guarded

    payload = {"project_id": project_id}
    ids = (body.shot_ids if body else None) or []
    if ids:
        payload["shot_ids"] = ids
    if body is not None and body.episode is not None:
        # ⚠️ 2026-10-26 更正：去重**看**它了。此前这里是按**项目**整体互斥，
        # 于是"第 3 集正在擦"会把"第 5 集也要擦"判成重复并返回那条 job
        # （deduped）。现在 `shots` 组按**镜头集合相交**判冲突
        # （见 jobs.find_active_job）：集不同 = 一镜不重叠 = 放行。
        # 同一集连点两次仍然会被挡住，这正是要防的重复烧钱。
        payload["episode"] = int(body.episode)
    if body is not None and body.region_ids:
        payload["region_ids"] = [str(x) for x in body.region_ids if x]

    async with _SUBMIT_LOCK:
        # ---- 先算出这次**实际**要动哪几镜，再逐镜比冲突（2026-10-26）----
        #
        # 与 `routers/upscale.py` 同一处修复、同一个根因：此前第一步是
        # `find_active_job(kind, project_id, payload)`，命中 `shots` 组里**任意**
        # 活跃任务就原样返回并标 `deduped`。于是"第 3 集正在出片"会让"第 5 集
        # 去字幕"拿回一条**出片**任务 —— 前端拿那个 id 去 waitJob，界面就一直
        # 停在「识别中…」，和交付页放大按钮那个 bug 一模一样。
        #
        # 冲突的正当理由（同组各 kind 都改 `shot.video_url`）天生是**镜头级**的：
        # 不碰同一镜就互不干扰。判据换成 `group_covering_map`（跨 kind、按真实
        # 镜头集合）。⚠️ 必须用 `desub_plan` 展开：`{episode: 5}` 与缺省（全片）
        # 都说不清具体是哪几镜，而且 apply 还要剔掉"没有待擦区间"的镜头。
        from ..desub_jobs import desub_empty_message, desub_plan
        from ..jobs import group_covering_map
        with get_session() as session:
            want = [r["id"] for r in desub_plan(session, project_id, kind, payload)]
        if not want:
            # 与 runner 用同一句话：同一种空集在提交时与跑起来后说法必须一致。
            raise HTTPException(status_code=422,
                                detail=desub_empty_message(kind, payload))

        covered = group_covering_map(kind, project_id, want)
        keep = [i for i in want if i not in covered]
        dropped = [i for i in want if i in covered]

        if not keep:
            touching = {covered[i] for i in dropped}
            one = next(iter(touching)) if len(touching) == 1 else None
            job = get_job(one) if one else None
            if job is not None and job.kind == kind:
                # ① 真重复：同一批镜头已经在跑同类任务（双击、刷新后重提交）。
                return DesubJobOut(id=job.id, kind=job.kind, status=job.status,
                                   progress=job.progress, deduped=True,
                                   skipped=dropped, phase=get_job_phase(job.id))
            # ② 不是重复，是**冲突**：这些镜头正被别的任务占着。
            #    回 deduped 会把用户骗去盯一条根本不是去字幕的任务。
            if job is not None:
                who = {"shot_videos": "出片", "first_frames": "首帧生成",
                       "first_frame_pipeline": "一条龙出片",
                       "one_click_film": "一键成片", "upscale": "高清放大",
                       "desub_scan": "字幕检测", "desub_apply": "字幕擦除",
                       }.get(job.kind, job.kind)
                detail = (f"要处理的 {len(dropped)} 个镜头正在{who}中，"
                          "等那一批跑完再试——现在提交会拿到正在作废的素材")
            else:
                detail = ("这些镜头正被别的任务处理，且查不到对应任务——"
                          "请稍后在「任务队列」确认后再试")
            raise HTTPException(status_code=409, detail=detail)

        # 有镜头被占用时折成显式集合，只跑没被占用的那些；
        # 一镜都没被占用时保持原 payload（`episode` / `region_ids` 原样带着）。
        submit = payload
        if dropped:
            submit = {k: v for k, v in payload.items() if k != "episode"}
            submit["shot_ids"] = keep
        jid = create_job(kind, submit)
    background.add_task(_run_job_guarded, RUNNERS[kind], jid, kind)
    return DesubJobOut(id=jid, kind=kind, status="pending", progress=0,
                      skipped=dropped)


@router.post("/projects/{project_id}/desub/scan", response_model=DesubJobOut)
async def desub_scan(project_id: str, background: BackgroundTasks,
                     body: DesubIn | None = None) -> DesubJobOut:
    """识别画面里的烧录字幕，结果写进各镜的 `transform_meta.desub`。

    只花 VLM 的 token，**不动任何素材**。识别出来的每一条都要用户在去字幕面板里
    核对过才会进入 apply —— 「这块字是台词还是剧情」判断再准也有出错的可能，
    而擦错是不可逆的。
    """
    return await _submit("desub_scan", project_id, body, background)


@router.post("/projects/{project_id}/desub/apply", response_model=DesubJobOut)
async def desub_apply(project_id: str, background: BackgroundTasks,
                      body: DesubIn | None = None) -> DesubJobOut:
    """把 `transform_meta.desub` 里还没执行的区间送去擦除。

    ⚠️ **会花钱**（服务方按处理的视频长度计费）且产物是有损重编码。
    原片保留在 `ShotVersion` 里可随时切回，但擦掉的字回不来 ——
    前端必须先弹一次确认，复述「N 镜 / xx.x 秒 / 结果存为新版本，原片保留」。
    """
    return await _submit("desub_apply", project_id, body, background)
