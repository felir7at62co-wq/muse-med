"""自动化流水线(Pipeline) — 预设编排: 从零创作→裂变→分发 模块自由组合。

设计原则: 编排器只做"顺序触发已有job + 等待完成 + 产物传递",
创作/裂变/分发全部复用现有实现(重试/补缺/频控等可靠性机制自动继承)。
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, String, Text, func, select
from sqlalchemy.dialects.postgresql import JSONB

from ..db.models import Base

logger = logging.getLogger(__name__)


class FactoryPipeline(Base):
    """自动化预设: 步骤链 + 模型配置"""
    __tablename__ = "factory_pipelines"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, nullable=False, index=True)
    name = Column(String(200), nullable=False)
    # steps: [{type: create_spawn|import_spawn|distribute, config: {...}}]
    steps = Column(JSONB, nullable=False, default=[])
    # model_config: {brainstorm: gemini, outline: gemini, script: gemini, novel: qwen, tweet: qwen}
    model_config = Column(JSONB, nullable=False, default={})
    created_at = Column(DateTime, nullable=False, server_default=func.now())
    updated_at = Column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())


class FactoryPipelineRun(Base):
    """预设的一次执行: 运行监控数据源"""
    __tablename__ = "factory_pipeline_runs"

    id = Column(Integer, primary_key=True, index=True)
    pipeline_id = Column(Integer, nullable=False, index=True)
    user_id = Column(Integer, nullable=False, index=True)
    pipeline_name = Column(String(200))
    status = Column(String(30), nullable=False, default="running")  # running/completed/failed/stopped
    current_step = Column(Integer, nullable=False, default=0)       # 当前执行到第几步(0-based)
    total_steps = Column(Integer, nullable=False, default=0)
    # step_runs: [{type, job_id, status, started_at, finished_at, summary}]
    step_runs = Column(JSONB, nullable=False, default=[])
    error_message = Column(Text)
    created_at = Column(DateTime, nullable=False, server_default=func.now(), index=True)
    finished_at = Column(DateTime)


async def _update_run(run_id: int, **fields):
    from ..db.session import get_session
    async for session in get_session():
        run = (await session.execute(
            select(FactoryPipelineRun).where(FactoryPipelineRun.id == run_id)
        )).scalar_one_or_none()
        if run:
            for k, v in fields.items():
                setattr(run, k, v)
            await session.commit()
        break


async def _wait_job(job_id: int, poll: float = 5.0, timeout: float = 3600 * 6) -> str:
    """轮询等待factory_job结束,返回最终status"""
    from ..db.session import get_session
    from .models import FactoryJob
    waited = 0.0
    while waited < timeout:
        async for session in get_session():
            job = (await session.execute(
                select(FactoryJob).where(FactoryJob.id == job_id)
            )).scalar_one_or_none()
            status = job.status if job else "failed"
            break
        if status in ("completed", "succeeded", "failed", "stopped"):
            return status
        await asyncio.sleep(poll)
        waited += poll
    return "timeout"


async def _job_scripts(job_id: int) -> list:
    """取job产出的已完成剧本ID列表(供步骤间产物传递)"""
    from ..db.session import get_session
    from .models import FactoryProduct
    async for session in get_session():
        rows = (await session.execute(
            select(FactoryProduct).where(
                FactoryProduct.job_id == job_id,
                FactoryProduct.product_type == "script",
                FactoryProduct.status == "completed",
            )
        )).scalars().all()
        return [p.id for p in rows]
    return []


async def _job_all_products(job_id: int, types: list | None = None) -> list:
    """取job全部已完成可分发产物(默认剧本/小说/推文, types可筛选)"""
    from ..db.session import get_session
    from .models import FactoryProduct
    ptypes = types or ["script", "novel", "tweet"]
    async for session in get_session():
        rows = (await session.execute(
            select(FactoryProduct).where(
                FactoryProduct.job_id == job_id,
                FactoryProduct.product_type.in_(ptypes),
                FactoryProduct.status == "completed",
            )
        )).scalars().all()
        return [p.id for p in rows]
    return []

async def run_pipeline(run_id: int, pipeline_id: int, user_id: int, resume: bool = False):
    """执行一条自动流: 顺序执行步骤链,产物在步骤间传递。

    步骤类型:
    - create_spawn: 从零创作(config同create_spawn任务)
    - import_spawn: 裂变(自动用上一步产出的剧本作为源)
    - distribute: 分发(自动分发此前所有步骤的产物; 失败不中断流)

    resume=True: 服务重启后断点续跑 — 已完成步骤跳过,
    进行中步骤复用原job(裂变产物按章断点续写), 其后步骤正常执行。
    """
    from ..db.session import get_session
    from .models import FactoryJob
    from .create_spawn import run_create_spawn_job
    from .import_spawn_impl import run_import_spawn_job

    # 读预设
    async for session in get_session():
        pl = (await session.execute(
            select(FactoryPipeline).where(FactoryPipeline.id == pipeline_id)
        )).scalar_one_or_none()
        break
    if not pl:
        await _update_run(run_id, status="failed", error_message="预设不存在", finished_at=datetime.utcnow())
        return

    steps = list(pl.steps or [])
    model_cfg = dict(pl.model_config or {})
    step_runs: list = []
    prev_script_ids: list = []
    all_job_ids: list = []
    start_idx = 0
    resume_job_id = None  # 进行中步骤的原job(断点续跑用)

    if resume:
        async for session in get_session():
            run = (await session.execute(
                select(FactoryPipelineRun).where(FactoryPipelineRun.id == run_id)
            )).scalar_one_or_none()
            break
        existing_runs = list(run.step_runs or []) if run else []
        for e in existing_runs:
            if e.get("status") in ("completed", "succeeded"):
                step_runs.append(e)
                jid = e.get("job_id")
                if jid:
                    all_job_ids.append(jid)
                    if e.get("type") in ("create_spawn", "video_transcribe"):
                        prev_script_ids = await _job_scripts(jid)
            else:
                resume_job_id = e.get("job_id")
                break
        start_idx = len(step_runs)
        if start_idx >= len(steps):
            await _update_run(run_id, status="completed", finished_at=datetime.utcnow())
            return
        await _update_run(run_id, status="running", error_message=None,
                          step_runs=list(step_runs), finished_at=None)
        logger.info(f"[pipeline {run_id}] resume from step {start_idx}, reuse job {resume_job_id}")

    try:
        for idx in range(start_idx, len(steps)):
            step = steps[idx]
            stype = step.get("type")
            scfg = dict(step.get("config") or {})
            entry = {"type": stype, "job_id": None, "status": "running",
                     "started_at": datetime.utcnow().isoformat(), "summary": ""}
            step_runs.append(entry)
            await _update_run(run_id, current_step=idx, step_runs=list(step_runs))

            if stype == "create_spawn":
                scfg["model_config"] = model_cfg
                scfg.setdefault("task_name", f"[自动流]{pl.name}")
                async for session in get_session():
                    job = FactoryJob(user_id=user_id, job_type="create_spawn",
                                     status="pending", config=scfg, progress={}, result={})
                    session.add(job)
                    await session.commit()
                    await session.refresh(job)
                    job_id = job.id
                    break
                entry["job_id"] = job_id
                await _update_run(run_id, step_runs=list(step_runs))
                task = asyncio.create_task(run_create_spawn_job(job_id, scfg, user_id))
                status = await _wait_job(job_id)
                entry["status"] = status
                prev_script_ids = await _job_scripts(job_id)
                all_job_ids.append(job_id)
                entry["summary"] = f"产出剧本 {len(prev_script_ids)} 部"
                if status not in ("completed", "succeeded") and not prev_script_ids:
                    raise RuntimeError(f"创作步骤失败(status={status})")

            elif stype == "video_transcribe":
                from .video_transcribe import run_video_transcribe_job
                scfg.setdefault("task_name", f"[自动流]{pl.name}")
                if resume and resume_job_id:
                    job_id = resume_job_id
                    resume_job_id = None
                    async for session in get_session():
                        job = (await session.execute(
                            select(FactoryJob).where(FactoryJob.id == job_id)
                        )).scalar_one_or_none()
                        if job and job.status != "running":
                            job.status = "pending"
                            await session.commit()
                        break
                else:
                    async for session in get_session():
                        job = FactoryJob(user_id=user_id, job_type="video_transcribe",
                                         status="pending", config=scfg, progress={}, result={})
                        session.add(job)
                        await session.commit()
                        await session.refresh(job)
                        job_id = job.id
                        break
                entry["job_id"] = job_id
                await _update_run(run_id, step_runs=list(step_runs))
                task = asyncio.create_task(run_video_transcribe_job(job_id, scfg, user_id))
                status = await _wait_job(job_id, timeout=float("inf"))
                entry["status"] = status
                prev_script_ids = await _job_scripts(job_id)
                all_job_ids.append(job_id)
                entry["summary"] = f"出稿 {len(prev_script_ids)} 部"
                if status == "stopped":
                    entry["finished_at"] = datetime.utcnow().isoformat()
                    await _update_run(run_id, status="stopped", step_runs=list(step_runs),
                                      finished_at=datetime.utcnow())
                    return
                if status not in ("completed", "succeeded") and not prev_script_ids:
                    raise RuntimeError(f"视频转剧本步骤失败(status={status})")

            elif stype == "video_transcribe":
                from .video_transcribe import run_video_transcribe_job
                scfg.setdefault("task_name", f"[自动流]{pl.name}")
                if resume and resume_job_id:
                    job_id = resume_job_id
                    resume_job_id = None
                    async for session in get_session():
                        job = (await session.execute(
                            select(FactoryJob).where(FactoryJob.id == job_id)
                        )).scalar_one_or_none()
                        if job and job.status != "running":
                            from .video_transcribe import reopen
                            reopen(job)
                            await session.commit()
                        break
                else:
                    async for session in get_session():
                        job = FactoryJob(user_id=user_id, job_type="video_transcribe",
                                         status="pending", config=scfg, progress={}, result={})
                        session.add(job)
                        await session.commit()
                        await session.refresh(job)
                        job_id = job.id
                        break
                entry["job_id"] = job_id
                await _update_run(run_id, step_runs=list(step_runs))
                task = asyncio.create_task(run_video_transcribe_job(job_id, scfg, user_id))
                status = await _wait_job(job_id, timeout=float("inf"))
                entry["status"] = status
                prev_script_ids = await _job_scripts(job_id)
                all_job_ids.append(job_id)
                entry["summary"] = f"出稿 {len(prev_script_ids)} 部"
                if status == "stopped":
                    entry["finished_at"] = datetime.utcnow().isoformat()
                    await _update_run(run_id, status="stopped", step_runs=list(step_runs),
                                      finished_at=datetime.utcnow())
                    return
                if status not in ("completed", "succeeded") and not prev_script_ids:
                    raise RuntimeError(f"视频转剧本步骤失败(status={status})")

            elif stype == "import_spawn":
                if not prev_script_ids:
                    raise RuntimeError("裂变步骤无上游剧本可用")
                scfg["model_config"] = model_cfg
                scfg["import_sources"] = [
                    {"type": "factory_script", "product_id": pid} for pid in prev_script_ids
                ]
                if resume and resume_job_id:
                    # 断点续跑: 复用原job, 已完成产物在_spawn_adaptation内按parent_id跳过/续写
                    job_id = resume_job_id
                    resume_job_id = None
                    async for session in get_session():
                        job = (await session.execute(
                            select(FactoryJob).where(FactoryJob.id == job_id)
                        )).scalar_one_or_none()
                        if job:
                            job.status = "pending"
                            job.error_message = None
                            await session.commit()
                        break
                    logger.info(f"[pipeline {run_id}] resume import_spawn job {job_id}")
                else:
                    async for session in get_session():
                        job = FactoryJob(user_id=user_id, job_type="import_spawn",
                                         status="pending", config=scfg, progress={}, result={})
                        session.add(job)
                        await session.commit()
                        await session.refresh(job)
                        job_id = job.id
                        break
                entry["job_id"] = job_id
                await _update_run(run_id, step_runs=list(step_runs))
                task = asyncio.create_task(run_import_spawn_job(job_id, scfg, user_id))
                status = await _wait_job(job_id)
                entry["status"] = status
                all_job_ids.append(job_id)
                n = len(await _job_all_products(job_id))
                entry["summary"] = f"裂变产物 {n} 部"
                if status not in ("completed", "succeeded"):
                    logger.warning(f"[pipeline {run_id}] import step status={status}, continue")

            elif stype == "distribute":
                # 分发此前所有job的全部产物; 失败不中断流
                from .distribute import distribute_scripts
                from .models import FactoryDistTarget
                target_id = int(scfg.get("target_id") or 0)
                async for session in get_session():
                    target = (await session.execute(
                        select(FactoryDistTarget).where(FactoryDistTarget.id == target_id)
                    )).scalar_one_or_none()
                    break
                if not target:
                    entry["status"] = "failed"
                    entry["summary"] = "分发目标不存在"
                else:
                    # 可选产物类型筛选(product_types: ["script","novel","tweet"], 缺省全部)
                    dist_types = scfg.get("product_types") or None
                    ids: list = []
                    for jid in all_job_ids:
                        ids.extend(await _job_all_products(jid, types=dist_types))
                    if not ids:
                        entry["status"] = "failed"
                        entry["summary"] = "无可分发产物"
                    else:
                        try:
                            result = await distribute_scripts(
                                script_ids=ids, url=target.url,
                                field_mapping=target.field_mapping or {},
                                job_id=all_job_ids[-1] if all_job_ids else 0,
                                target_name=target.name)
                            entry["status"] = "completed"
                            entry["summary"] = f"分发成功{len(result['ok'])}部/失败{len(result['failed'])}部 → {target.name}"
                        except Exception as e:
                            entry["status"] = "failed"
                            entry["summary"] = f"分发失败: {str(e)[:100]}"
                            logger.error(f"[pipeline {run_id}] distribute failed: {e}")
            else:
                entry["status"] = "skipped"
                entry["summary"] = f"未知步骤类型: {stype}"

            entry["finished_at"] = datetime.utcnow().isoformat()
            await _update_run(run_id, step_runs=list(step_runs))

        await _update_run(run_id, status="completed", current_step=len(steps),
                          finished_at=datetime.utcnow())
        logger.info(f"[pipeline {run_id}] completed")
    except Exception as e:
        logger.exception(f"[pipeline {run_id}] failed")
        if step_runs:
            step_runs[-1]["status"] = "failed"
            step_runs[-1]["finished_at"] = datetime.utcnow().isoformat()
        await _update_run(run_id, status="failed", error_message=str(e)[:500],
                          step_runs=list(step_runs), finished_at=datetime.utcnow())
