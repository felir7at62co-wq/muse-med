"""小说转视频 弹性算力 worker — 消费进程。

在算力机上以 ROLE=worker 启动(不起 web / 不接用户流量)。职责:
  循环轮询主库 → 原子认领一个待处理任务 → 复用 service 的 run_job/_safe_resume 跑完 → 回写。
  连续空闲 IDLE_EXIT_SEC 秒无任务则退出(配合主服务 DeleteInstance 释放实例, 停机零费用)。

认领范围:
  - pending: 新任务(主服务派发时置 pending)
  - 存量失败/中断任务: 由主服务(或运维脚本)把要重跑的任务 status 批量重置为 'pending' 后, worker 自动认领。
    这样避免误跑用户已放弃的 failed 任务(白名单式重跑)。

认领用 Postgres `FOR UPDATE SKIP LOCKED` 保证多 worker 并行不抢同一任务。
本机单 worker 一次跑 1 个 job(job 内部已有分镜/配音并发); 多 worker = 多实例并行(主服务控 ≤N 台)。

数据全走网络: 主库(任务状态) + TOS(素材/成片) + RunningHub/kegeai(生图配音)。与主站同一份 .env。
ffmpeg 合成限 -threads(见 service.py, 保持), 不打满核。
"""
from __future__ import annotations

import asyncio
import logging
import os
import socket
import time

from sqlalchemy import text

from ..db import session_scope
from . import service as nv

logger = logging.getLogger("novel_video.worker")

POLL_INTERVAL = int(os.getenv("WORKER_POLL_INTERVAL", "8"))       # 轮询间隔秒
IDLE_EXIT_SEC = int(os.getenv("WORKER_IDLE_EXIT_SEC", "600"))     # 空闲多久退出(默认10分钟, 与释放阈值一致)
WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"


async def _claim_one_job() -> int | None:
    """原子认领一个 pending 任务 → 置为运行中(防其它 worker 抢)。返回 job_id 或 None。

    用 FOR UPDATE SKIP LOCKED: 多 worker 并行时各认各的, 不冲突。
    认领后 status 先置 'pending'(保持), 由 run_job/_safe_resume 接管推进状态;
    这里用 claimed_by/claimed_at 字段占位(若表无该字段则退化为仅按 status 认领)。
    """
    async with session_scope() as s:
        # 原子认领: 单条 UPDATE...WHERE id=(SELECT...FOR UPDATE SKIP LOCKED) RETURNING id。
        #
        # 为什么不用"先 SELECT FOR UPDATE 再单独 UPDATE"两步式:
        #   两步式依赖"整个 session_scope 是一个事务、行锁持有到提交"才安全。但若 session 是
        #   每语句 autocommit(或事务边界不如预期), SELECT FOR UPDATE 提交后行锁立即释放, 在下一条
        #   UPDATE 把 status 改成 'prompting' 之前存在窗口 → 另一个 worker 也能 SELECT 到同一
        #   pending 任务 → 两个 worker 都认领 → run_job 跑两次 → 每个分镜 idx 生成两条 shot 记录
        #   (实测 dev job40: 30 shots / 15 distinct idx, 每 idx 正好 2 条, 即 run_job 执行了 2 次)。
        #
        # 单条 UPDATE...RETURNING 是天然原子的: PostgreSQL 保证子查询选中的行被行锁保护到本 UPDATE
        #   完成, 且只有一个并发事务能成功把该行从 pending 改走并 RETURNING 到 id, 其它并发 worker
        #   的子查询因 SKIP LOCKED 跳过该行、拿不到 → 返回空, 彻底杜绝重复认领(不依赖事务隔离级别)。
        row = (await s.execute(text(
            """
            UPDATE novel_video_jobs SET status = 'prompting'
            WHERE id = (
                SELECT id FROM novel_video_jobs
                WHERE status = 'pending'
                ORDER BY id
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id
            """
        ))).first()
        if not row:
            return None
        return int(row[0])


async def _process_job(job_id: int) -> None:
    """跑一个任务: 按 pending_action 分派。
    - 'run'      : 全流程(配音+生图[+封面]+可选合成)
    - 'compose'  : 仅重新合成成片(图/配音已就绪)
    - 'regen_cover': 重新生成封面(不重跑整段)
    - 'regen_shot' : 重新生成某个分镜图(action_params.shot_id/new_prompt)
    - None(兼容旧逻辑/重置重跑): 有分镜+配音走续跑, 否则全流程 run_job。
    动作参数存在 job.action_params。处理前先清空 pending_action/action_params(避免重复执行)。
    """
    from sqlalchemy import select, func
    from .models import NovelVideoJob, NovelVideoShot
    async with session_scope() as s:
        job = await s.get(NovelVideoJob, job_id)
        if not job:
            return
        action = (job.pending_action or "").strip()
        params = dict(job.action_params or {})
        has_audio = bool(job.audio_oss_key)
        has_video = bool(job.video_oss_key)
        model = job.image_model or "gpt-image-2"
        size = f"{job.width}x{job.height}"
        style_prompt = job.style_prompt or ""
        ref_image_keys = list(job.ref_image_oss_keys or ([] if not job.ref_image_oss_key else [job.ref_image_oss_key]))
        shot_cnt = (await s.execute(
            select(func.count()).select_from(NovelVideoShot).where(NovelVideoShot.job_id == job_id)
        )).scalar() or 0
        # 认领后即清空待办动作, 防重复执行
        job.pending_action = None
        job.action_params = None

    # 按动作显式分派(优先于 has_video/has_audio 的启发式判断)
    if action == "compose":
        logger.info("worker %s: job %s 仅合成(compose)", WORKER_ID, job_id)
        await nv.compose_job(job_id)
        return
    if action == "regen_cover":
        logger.info("worker %s: job %s 重生成封面(regen_cover)", WORKER_ID, job_id)
        await nv.regenerate_cover(job_id, model=model, size=size,
                                  style_prompt=style_prompt, ref_image_keys=ref_image_keys)
        # 封面重生成后不自动合成; 保持原状态(用户再点合成)。这里恢复为 await_confirm 便于前端操作。
        await nv._set_job(job_id, status="await_confirm")
        return
    if action == "regen_shot":
        shot_id = int(params.get("shot_id") or 0)
        new_prompt = params.get("new_prompt")
        logger.info("worker %s: job %s 重生成单图(regen_shot shot=%s)", WORKER_ID, job_id, shot_id)
        if shot_id:
            await nv.regenerate_shot(shot_id, new_prompt=new_prompt)
        await nv._set_job(job_id, status="await_confirm")
        return
    if action == "run":
        logger.info("worker %s: job %s 全流程(run)", WORKER_ID, job_id)
        await nv.run_job(job_id)
        return

    # ---- 无显式 action: 兼容旧的重置重跑逻辑 ----
    if has_video:
        await nv._set_job(job_id, status="succeeded", progress=100)
        return
    if has_audio and shot_cnt > 0:
        logger.info("worker %s: job %s 续跑(补图+合成)", WORKER_ID, job_id)
        await nv._safe_resume(job_id)
    else:
        logger.info("worker %s: job %s 全流程", WORKER_ID, job_id)
        await nv.run_job(job_id)


async def run_worker_loop() -> None:
    """worker 主循环: 认领→处理→循环; 连续空闲超时则退出。"""
    logger.info("novel_video worker 启动 id=%s poll=%ss idle_exit=%ss", WORKER_ID, POLL_INTERVAL, IDLE_EXIT_SEC)
    last_active = time.monotonic()
    while True:
        try:
            job_id = await _claim_one_job()
        except Exception as e:  # noqa: BLE001
            logger.warning("worker 认领任务失败: %s", e)
            job_id = None

        if job_id is None:
            if time.monotonic() - last_active >= IDLE_EXIT_SEC:
                logger.info("worker %s 空闲 %ss, 退出(等待实例释放)", WORKER_ID, IDLE_EXIT_SEC)
                return
            await asyncio.sleep(POLL_INTERVAL)
            continue

        last_active = time.monotonic()
        try:
            await _process_job(job_id)
            logger.info("worker %s: job %s 处理完成", WORKER_ID, job_id)
        except Exception as e:  # noqa: BLE001
            logger.exception("worker %s: job %s 处理失败", WORKER_ID, job_id)
            try:
                await nv._set_job(job_id, status="failed", error=f"worker 处理失败: {str(e)[:500]}")
            except Exception:  # noqa: BLE001
                pass
        # 回写飞书: 若该 job 是飞书来源, 按终态(succeeded/failed)回写下载链接/生成失败。
        # 关键: 视频由本 worker 独立进程跑, 回写必须在这里做 —— 主服务的 sync 不再 await run_job,
        #       故"谁跑完谁回写"。非飞书任务 writeback_feishu_job 内部会直接 return, 无副作用。
        try:
            from ..feishu.service import writeback_feishu_job
            await writeback_feishu_job(job_id)
        except Exception:  # noqa: BLE001
            logger.exception("worker %s: job %s 飞书回写失败", WORKER_ID, job_id)
        last_active = time.monotonic()


async def requeue_jobs(job_ids: list[int] | None = None, *, include_failed: bool = True,
                       include_stuck: bool = True) -> dict:
    """把存量失败/中断任务重置为 pending, 交给 worker 断点续跑(白名单式重跑)。

    - job_ids 指定则只重置这些; 否则按条件批量:
      include_failed: status='failed' 的
      include_stuck:  卡在运行中态(_RUNNING_STATUSES, 非 pending)但进程已死的僵尸任务
    - 已有成片(video_oss_key)的跳过(已完成, 无需重跑)。
    返回 {requeued: N, ids: [...]}。
    主服务调用此函数标记重跑范围, 再确保拉起 worker。
    """
    conds = []
    if job_ids:
        id_list = ",".join(str(int(i)) for i in job_ids)
        conds.append(f"id IN ({id_list})")
    else:
        st = []
        if include_failed:
            st.append("'failed'")
        if include_stuck:
            st += [f"'{s}'" for s in nv._RUNNING_STATUSES if s != "pending"]
        if st:
            conds.append(f"status IN ({','.join(st)})")
    if not conds:
        return {"requeued": 0, "ids": []}
    where = " AND ".join(conds) + " AND (video_oss_key IS NULL OR video_oss_key = '')"
    async with session_scope() as s:
        rows = (await s.execute(text(f"SELECT id FROM novel_video_jobs WHERE {where} ORDER BY id"))).all()
        ids = [int(r[0]) for r in rows]
        if ids:
            await s.execute(text(
                "UPDATE novel_video_jobs SET status='pending', error=NULL "
                f"WHERE id IN ({','.join(str(i) for i in ids)})"
            ))
    logger.info("requeue_jobs: 重置 %d 个任务为 pending: %s", len(ids), ids)
    return {"requeued": len(ids), "ids": ids}


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    asyncio.run(run_worker_loop())


if __name__ == "__main__":
    main()