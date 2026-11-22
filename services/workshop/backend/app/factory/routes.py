from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List, Optional
from pydantic import BaseModel
import asyncio
import logging
from datetime import datetime

from ..db.session import session_scope as get_async_session
from ..auth.dependencies import get_current_user
from ..auth.models import User
from .models import FactoryJob, FactoryProduct, FactoryDistTarget
from .create_spawn import run_create_spawn_job, resume_stuck_outlines, refill_script_episodes
from .import_spawn_impl import run_import_spawn_job

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/v1/factory", tags=["factory"])

class CreateJobRequest(BaseModel):
    job_type: str
    config: dict

class JobResponse(BaseModel):
    id: int
    job_type: str
    status: str
    progress: Optional[dict] = None
    result: Optional[dict] = None
    created_at: datetime
    updated_at: datetime
    
    class Config:
        from_attributes = True

class ProductResponse(BaseModel):
    id: int
    job_id: int
    product_type: str
    status: str
    data: dict
    created_at: datetime
    
    class Config:
        from_attributes = True


@router.post("/jobs")
async def create_factory_job(
    request: Request,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user)
):
    """创建工厂任务。支持两种提交方式:
    - JSON: {job_type, config}
    - multipart/form-data: file + config(JSON字符串) — 导入剧本的文件上传入口
    """
    content_type = (request.headers.get("content-type") or "").lower()
    if "multipart/form-data" in content_type:
        form = await request.form()
        upload = form.get("file")
        config_raw = form.get("config") or "{}"
        try:
            import json as _json
            config = _json.loads(config_raw)
        except Exception:
            raise HTTPException(status_code=400, detail="config 不是合法JSON")
        job_type = config.pop("job_type", None) or "import_spawn"
        if upload is not None and hasattr(upload, "filename"):
            # 用主平台的文件解析器(txt/docx/pdf/md)
            from ..stages.file_upload import parse_file
            parsed = await parse_file(upload)
            if not parsed.get("success"):
                raise HTTPException(status_code=400, detail=parsed.get("error") or "文件解析失败")
            src = config.get("import_source") or {}
            src["type"] = "file"
            src["content"] = parsed.get("content") or ""
            src["filename"] = parsed.get("title") or upload.filename
            config["import_source"] = src
    else:
        payload = await request.json()
        job_type = payload.get("job_type")
        config = payload.get("config") or {}
        if not job_type:
            raise HTTPException(status_code=400, detail="缺少 job_type")

    async with get_async_session() as session:
        job = FactoryJob(
            user_id=user.id,
            job_type=job_type,
            status="pending",
            config=config,
            progress={},
            result={}
        )
        session.add(job)
        await session.commit()
        await session.refresh(job)
        
        job_id = job.id
        
    logger.info(f"[Job {job_id}] Created {job_type}")
    
    if job_type == "create_spawn":
        background_tasks.add_task(run_create_spawn_job, job_id, config, user.id)
    elif job_type == "import_spawn":
        background_tasks.add_task(run_import_spawn_job, job_id, config, user.id)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown job_type: {job_type}")
    
    return {"job_id": job_id}


@router.get("/scripts-library")
async def list_scripts_library(
    user: User = Depends(get_current_user)
):
    """列出用户所有已完成的工厂剧本(供导入裂变批量选取)"""
    async with get_async_session() as session:
        result = await session.execute(
            select(FactoryProduct)
            .where(
                FactoryProduct.user_id == user.id,
                FactoryProduct.product_type == "script",
                FactoryProduct.status == "completed",
            )
            .order_by(FactoryProduct.job_id.desc(), FactoryProduct.id.desc())
        )
        scripts = result.scalars().all()
        return [{
            "id": p.id,
            "job_id": p.job_id,
            "title": p.title or f"剧本{p.id}",
            "episodes": (p.meta_data or {}).get("completed_episodes") or 0,
            "words": (p.meta_data or {}).get("words") or 0,
            "created_at": p.created_at.isoformat() if p.created_at else None,
        } for p in scripts]


@router.get("/jobs")
async def list_jobs(
    skip: int = 0,
    limit: int = 20,
    user: User = Depends(get_current_user)
):
    """列出用户的所有任务(手动序列化,兼容老数据progress为int的情况)"""
    async with get_async_session() as session:
        result = await session.execute(
            select(FactoryJob)
            .where(FactoryJob.user_id == user.id)
            .order_by(FactoryJob.created_at.desc())
            .offset(skip)
            .limit(limit)
        )
        jobs = result.scalars().all()
        
        # 批量统计各任务产物数(供列表进度条与状态标签) — 只统计剧本(最终交付物)
        job_ids = [j.id for j in jobs]
        product_stats: dict = {}
        if job_ids:
            presult = await session.execute(
                select(FactoryProduct)
                .where(
                    FactoryProduct.job_id.in_(job_ids),
                    FactoryProduct.product_type == "script"
                )
            )
            for p in presult.scalars().all():
                s = product_stats.setdefault(p.job_id, {
                    "total": 0, "finished": 0, "failed": 0,
                    "generating": 0, "missing": 0,
                    "distributed": 0, "dist_targets": set(),
                })
                s["total"] += 1
                md = p.meta_data or {}
                if p.status == "completed":
                    s["finished"] += 1
                elif p.status == "failed":
                    s["failed"] += 1
                elif p.status == "generating":
                    s["generating"] += 1
                # 缺集判定(仅已完成的剧本才算"缺集",生成中的算生成中)
                total_ep = int(md.get("episodes") or 0)
                done_ep = int(md.get("completed_episodes") or 0)
                if p.status == "completed" and total_ep and done_ep < total_ep:
                    s["missing"] += 1
                # 分发情况
                dist_history = md.get("dist_history") or []
                if dist_history:
                    s["distributed"] += 1
                    for h in dist_history:
                        if h.get("target"):
                            s["dist_targets"].add(h["target"])
        
        def _stat(jid: int, key: str, default=0):
            return product_stats.get(jid, {}).get(key, default)
        
        return [{
            "id": j.id,
            "job_type": j.job_type,
            "status": j.status,
            "progress": j.progress if isinstance(j.progress, dict) else {},
            "result": j.result or {},
            "error": j.error_message,
            # 任务名称与计划(创建时填写)
            "task_name": (j.config or {}).get("task_name") or "",
            "planned_scripts": (j.config or {}).get("total_scripts"),
            "planned_episodes": (j.config or {}).get("episodes"),
            "planned_dist_target_name": (j.config or {}).get("planned_dist_target_name") or "",
            "theme": (j.config or {}).get("theme") or "",
            # 实际生产情况
            "total_products": _stat(j.id, "total"),
            "finished_products": _stat(j.id, "finished"),
            "failed_products": _stat(j.id, "failed"),
            "generating_products": _stat(j.id, "generating"),
            "missing_products": _stat(j.id, "missing"),
            # 分发情况
            "distributed_products": _stat(j.id, "distributed"),
            "distributed_targets": sorted(product_stats.get(j.id, {}).get("dist_targets", set())),
            "created_at": j.created_at.isoformat() if j.created_at else None,
            "updated_at": j.updated_at.isoformat() if j.updated_at else None,
            "finished_at": j.finished_at.isoformat() if j.finished_at else None,
        } for j in jobs]


@router.get("/jobs/{job_id}")
async def get_job(
    job_id: int,
    user: User = Depends(get_current_user)
):
    """获取任务详情(含产物列表与统计,匹配前端JobDetail结构)"""
    async with get_async_session() as session:
        result = await session.execute(
            select(FactoryJob).where(
                FactoryJob.id == job_id,
                FactoryJob.user_id == user.id
            )
        )
        job = result.scalar_one_or_none()
        
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        
        # 拉取该任务全部产物
        presult = await session.execute(
            select(FactoryProduct)
            .where(FactoryProduct.job_id == job_id)
            .order_by(FactoryProduct.created_at.asc())
        )
        products = list(presult.scalars().all())

        # import_spawn: 把源剧本(属上游任务)也纳入产物列表, 用户视角"剧本+小说+推文"齐全
        if job.job_type == "import_spawn":
            src_ids = [
                int(s.get("product_id") or 0)
                for s in ((job.config or {}).get("import_sources") or [])
                if s.get("type") == "factory_script" and s.get("product_id")
            ]
            if src_ids:
                srows = (await session.execute(
                    select(FactoryProduct).where(
                        FactoryProduct.id.in_(src_ids),
                        FactoryProduct.user_id == user.id)
                )).scalars().all()
                existing = {p.id for p in products}
                products = [p for p in srows if p.id not in existing] + products
        
        # 进度只统计剧本(最终交付物): 大纲是同一部作品的中间阶段,不计入产物进度
        scripts_only = [p for p in products if p.product_type == "script"]
        finished = sum(1 for p in scripts_only if p.status == "completed")
        failed = sum(1 for p in scripts_only if p.status == "failed")
        # 兼容老数据: progress可能是int(旧代码写入0)或dict
        progress = job.progress if isinstance(job.progress, dict) else {}
        # 总数取目标剧本数(config.total_scripts),无则取实际剧本数
        target_scripts = (job.config or {}).get("total_scripts") or len(scripts_only)
        
        return {
            "id": job.id,
            "user_id": job.user_id,
            "job_type": job.job_type,
            "status": job.status,
            "source_json": job.config or {},
            "config_json": job.config or {},
            "progress": progress,
            "result": job.result or {},
            "total_products": target_scripts,
            "finished_products": finished,
            "failed_products": failed,
            "validation_json": {},
            "retry_count": 0,
            "max_retries": 3,
            "error": job.error_message,
            "created_at": job.created_at.isoformat() if job.created_at else None,
            "finished_at": job.finished_at.isoformat() if job.finished_at else None,
            "total_tokens": job.total_tokens or 0,
            "total_cost": 0,
            "steps": [],
            "products": [{
                "id": p.id,
                "product_type": p.product_type,
                "draft_id": p.draft_id,
                "parent_id": p.parent_id,
                "title": p.title or "",
                "status": p.status,
                "error": (p.meta_data or {}).get("error"),
                # 剧本集数进度: episodes=目标集数, completed_episodes=已生成集数
                "episodes": (p.meta_data or {}).get("episodes"),
                "completed_episodes": (p.meta_data or {}).get("completed_episodes"),
                "words": (p.meta_data or {}).get("words"),
                # 裂变产物源头(来源于: XXX)与推文主角
                "source_label": (p.meta_data or {}).get("source_label"),
                "protagonist": (p.meta_data or {}).get("protagonist"),
                "created_at": p.created_at.isoformat() if p.created_at else None,
            } for p in products],
            # 任务目标集数(供前端对照剧本实际集数,判断缺集)
            "target_episodes": (job.config or {}).get("episodes"),
            "target_scripts": (job.config or {}).get("total_scripts"),
            "task_name": (job.config or {}).get("task_name") or "",
            "planned_dist_target_name": (job.config or {}).get("planned_dist_target_name") or "",
        }


@router.get("/jobs/{job_id}/products", response_model=List[ProductResponse])
async def get_job_products(
    job_id: int,
    product_type: Optional[str] = None,
    status: Optional[str] = None,
    user: User = Depends(get_current_user)
):
    """获取任务的所有产物"""
    async with get_async_session() as session:
        # 验证任务权限
        result = await session.execute(
            select(FactoryJob).where(
                FactoryJob.id == job_id,
                FactoryJob.user_id == user.id
            )
        )
        job = result.scalar_one_or_none()
        
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        
        query = select(FactoryProduct).where(FactoryProduct.job_id == job_id)
        
        if product_type:
            query = query.where(FactoryProduct.product_type == product_type)
        if status:
            query = query.where(FactoryProduct.status == status)
        
        query = query.order_by(FactoryProduct.created_at.asc())
        
        result = await session.execute(query)
        products = result.scalars().all()
        return products


@router.get("/products/{product_id}")
async def get_product(
    product_id: int,
    user: User = Depends(get_current_user)
):
    """获取单个产物完整内容(大纲/剧本详情弹窗用)"""
    async with get_async_session() as session:
        result = await session.execute(
            select(FactoryProduct).where(
                FactoryProduct.id == product_id,
                FactoryProduct.user_id == user.id
            )
        )
        product = result.scalar_one_or_none()
        
        if not product:
            raise HTTPException(status_code=404, detail="Product not found")
        
        return {
            "id": product.id,
            "job_id": product.job_id,
            "product_type": product.product_type,
            "title": product.title or "",
            "content": product.content or "",
            "status": product.status,
            "meta_data": product.meta_data or {},
            "parent_id": product.parent_id,
            "draft_id": product.draft_id,
            "created_at": product.created_at.isoformat() if product.created_at else None,
        }


@router.get("/products/{product_id}/trace")
async def get_product_trace(
    product_id: int,
    user: User = Depends(get_current_user)
):
    """产物追溯: 基本信息 + parent/children构成的溯源树(供产物追溯页使用)

    跨任务追溯: 裂变产物(job B)的parent指向源剧本(job A), 树必须跨job构建 —
    向上沿parent_id/outline_id逐级找根, 向下BFS收集全部后代, 再补齐相关job的同任务产物。
    """
    async with get_async_session() as session:
        result = await session.execute(
            select(FactoryProduct).where(
                FactoryProduct.id == product_id,
                FactoryProduct.user_id == user.id
            )
        )
        product = result.scalar_one_or_none()
        if not product:
            raise HTTPException(status_code=404, detail="Product not found")

        def parent_of(p):
            return p.parent_id or (p.meta_data or {}).get("outline_id")

        # 1) 向上找根(跨任务, 逐级查询)
        root = product
        seen_ids = {root.id}
        while True:
            pid = parent_of(root)
            if not pid or pid in seen_ids:
                break
            parent = (await session.execute(
                select(FactoryProduct).where(
                    FactoryProduct.id == pid,
                    FactoryProduct.user_id == user.id)
            )).scalar_one_or_none()
            if not parent:
                break
            root = parent
            seen_ids.add(root.id)

        # 2) 向下BFS收集全部后代(跨任务, 按parent_id; 起点含root与当前产物, 
        #    因为root→当前可能经meta outline_id链接, parent_id扫不到)
        by_id = {root.id: root, product.id: product}
        frontier = list(by_id.keys())
        for _ in range(10):  # 深度上限, 防环
            if not frontier:
                break
            rows = (await session.execute(
                select(FactoryProduct).where(
                    FactoryProduct.parent_id.in_(frontier),
                    FactoryProduct.user_id == user.id)
            )).scalars().all()
            frontier = [r.id for r in rows if r.id not in by_id]
            for r in rows:
                by_id[r.id] = r

        # 3) 补齐相关job的同任务产物(覆盖outline_id这类meta链接)
        related_jobs = {p.job_id for p in by_id.values()}
        if related_jobs:
            rows = (await session.execute(
                select(FactoryProduct).where(
                    FactoryProduct.job_id.in_(related_jobs),
                    FactoryProduct.user_id == user.id)
            )).scalars().all()
            for r in rows:
                by_id.setdefault(r.id, r)

        children_map: dict = {}
        for p in by_id.values():
            pid = parent_of(p)
            if pid and pid in by_id:
                children_map.setdefault(pid, []).append(p)
        for lst in children_map.values():
            lst.sort(key=lambda p: p.id)

        # 根可能因补齐产物而有更上层(如剧本的outline在同job) → 再上探一次
        while True:
            pid = parent_of(root)
            if pid and pid in by_id and pid not in seen_ids:
                root = by_id[pid]
                seen_ids.add(root.id)
            else:
                break

        def node(p, depth: int = 0) -> dict:
            return {
                "id": p.id,
                "product_type": p.product_type,
                "title": p.title or f"产物 #{p.id}",
                "source_type": "original",
                "job_id": p.job_id,
                "created_at": p.created_at.isoformat() if p.created_at else None,
                "parent_id": p.parent_id,
                "children": [node(c, depth + 1) for c in children_map.get(p.id, [])] if depth < 8 else [],
            }

        md = product.meta_data or {}
        return {
            "id": product.id,
            "job_id": product.job_id,
            "product_type": product.product_type,
            "draft_id": product.draft_id,
            "title": product.title or f"产物 #{product.id}",
            "content_json": None,
            "parent_product_id": product.parent_id,
            "source_type": "original",
            "status": product.status,
            "episode_count": md.get("completed_episodes") or md.get("episodes"),
            "download_url": None,
            "validation_json": {},
            "error": md.get("error"),
            "created_at": product.created_at.isoformat() if product.created_at else None,
            "finished_at": None,
            "trace_tree": node(root),
            "quality_scores": [],
            "usage_records": [],
        }


def _script_to_text(title: str, content: str) -> str:
    """把剧本JSON({chapters:[{order,title,content,word_count}]})转成可读纯文本"""
    import json as _json
    try:
        data = _json.loads(content or "{}")
    except _json.JSONDecodeError:
        return content or ""
    chapters = data.get("chapters") or []
    if not chapters:
        return content or ""
    lines = [f"《{title}》", ""]
    for ch in sorted(chapters, key=lambda c: c.get("order") or 0):
        lines.append(f"—— 第{ch.get('order', '?')}集: {ch.get('title', '')} ——")
        lines.append("")
        lines.append(ch.get("content", ""))
        lines.append("")
    return "\n".join(lines)


def _outline_to_text(title: str, content: str) -> str:
    """把大纲JSON转成可读纯文本"""
    import json as _json
    try:
        data = _json.loads(content or "{}")
    except _json.JSONDecodeError:
        return content or ""
    lines = [f"《{data.get('title') or title}》", ""]
    if data.get("synopsis"):
        lines += ["【简介】", data["synopsis"], ""]
    chars = data.get("characters") or []
    if chars:
        lines.append("【人物】")
        for c in chars:
            if isinstance(c, dict):
                lines.append(f"- {c.get('name', '')}: {c.get('description', '')}")
            else:
                lines.append(f"- {c}")
        lines.append("")
    chapters = data.get("chapters") or []
    if chapters:
        lines.append("【分集大纲】")
        for ch in sorted(chapters, key=lambda c: c.get("order") or 0):
            lines.append(f"第{ch.get('order', '?')}集: {ch.get('title', '')}")
            # ⚠️ 与 docx_export.outline_to_docx 同源：大纲每集正文的键是 `synopsis`，
            # 只读 summary/plot 会让文本导出同样只剩标题（见那里的注释）。
            summary = ch.get("synopsis") or ch.get("summary") or ch.get("plot") or ""
            if summary:
                lines.append(f"  {summary}")
        lines.append("")
    return "\n".join(lines)


@router.get("/products/{product_id}/export")
async def export_product_text(
    product_id: int,
    user: User = Depends(get_current_user)
):
    """导出单个产物为排版好的Word文档(.docx)"""
    from fastapi.responses import Response
    from urllib.parse import quote
    from .docx_export import script_to_docx, outline_to_docx
    async with get_async_session() as session:
        result = await session.execute(
            select(FactoryProduct).where(
                FactoryProduct.id == product_id,
                FactoryProduct.user_id == user.id
            )
        )
        product = result.scalar_one_or_none()
        if not product:
            raise HTTPException(status_code=404, detail="Product not found")

        title = product.title or f"产物{product.id}"
        if product.product_type == "outline":
            payload = outline_to_docx(title, product.content or "")
        else:
            payload = script_to_docx(title, product.content or "")

        filename = quote(f"{title}.docx")
        return Response(
            content=payload,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
        )


@router.get("/jobs/{job_id}/export")
async def export_job_scripts(
    job_id: int,
    user: User = Depends(get_current_user)
):
    """导出任务的全部剧本Word文档: 单剧本→docx, 多剧本→zip打包"""
    from fastapi.responses import Response
    from urllib.parse import quote
    from .docx_export import script_to_docx
    import io
    import zipfile

    async with get_async_session() as session:
        jresult = await session.execute(
            select(FactoryJob).where(
                FactoryJob.id == job_id,
                FactoryJob.user_id == user.id
            )
        )
        job = jresult.scalar_one_or_none()
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")

        presult = await session.execute(
            select(FactoryProduct)
            .where(
                FactoryProduct.job_id == job_id,
                FactoryProduct.product_type == "script"
            )
            .order_by(FactoryProduct.created_at.asc())
        )
        scripts = presult.scalars().all()

        if not scripts:
            raise HTTPException(status_code=404, detail="该任务暂无剧本产物可导出")

        if len(scripts) == 1:
            s = scripts[0]
            title = s.title or f"剧本{s.id}"
            payload = script_to_docx(title, s.content or "")
            filename = quote(f"{title}.docx")
            return Response(
                content=payload,
                media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
            )

        buf = io.BytesIO()
        used_names: set = set()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for s in scripts:
                title = s.title or f"剧本{s.id}"
                name = f"{title}.docx"
                if name in used_names:
                    name = f"{title}-{s.id}.docx"
                used_names.add(name)
                zf.writestr(name, script_to_docx(title, s.content or ""))
        filename = quote(f"任务{job_id}-剧本合集.zip")
        return Response(
            content=buf.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
        )


@router.post("/products/{product_id}/refill")
async def refill_product_episodes(
    product_id: int,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user)
):
    """剧本补缺: 对照大纲分集,补齐剧本缺失的集数(后台任务)"""
    async with get_async_session() as session:
        result = await session.execute(
            select(FactoryProduct).where(
                FactoryProduct.id == product_id,
                FactoryProduct.user_id == user.id
            )
        )
        product = result.scalar_one_or_none()
        if not product:
            raise HTTPException(status_code=404, detail="Product not found")
        if product.product_type != "script":
            raise HTTPException(status_code=400, detail="只支持对剧本产物补缺")
        if product.status == "generating":
            raise HTTPException(status_code=400, detail="剧本正在生成中,请稍后再试")

        jresult = await session.execute(
            select(FactoryJob).where(FactoryJob.id == product.job_id)
        )
        job = jresult.scalar_one_or_none()
        config = (job.config or {}) if job else {}
        job_id = product.job_id

    background_tasks.add_task(refill_script_episodes, product_id, job_id, config)
    logger.info(f"[Product {product_id}] Refill episodes task started")
    return {"message": "补缺任务已启动,剧本将逐集补齐缺失集数", "product_id": product_id}


@router.post("/jobs/{job_id}/refill-all")
async def refill_all_job_episodes(
    job_id: int,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user)
):
    """一键补全集数: 为该任务下所有已完成(通过审核优化)但缺集的剧本批量发起补缺。

    条件: product_type=script, status=completed, completed_episodes < episodes。
    所有补缺任务并发启动,互不阻塞。
    """
    async with get_async_session() as session:
        jresult = await session.execute(
            select(FactoryJob).where(
                FactoryJob.id == job_id,
                FactoryJob.user_id == user.id
            )
        )
        job = jresult.scalar_one_or_none()
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        config = job.config or {}

        presult = await session.execute(
            select(FactoryProduct).where(
                FactoryProduct.job_id == job_id,
                FactoryProduct.product_type == "script",
                FactoryProduct.status == "completed"
            )
        )
        scripts = presult.scalars().all()

        # 目标集数: 单剧本meta里的episodes,兜底用任务config的episodes
        target_default = int(config.get("episodes") or 0)
        incomplete = []
        for s in scripts:
            md = s.meta_data or {}
            total = int(md.get("episodes") or target_default or 0)
            done = int(md.get("completed_episodes") or 0)
            if total and done < total:
                incomplete.append({"id": s.id, "title": s.title, "done": done, "total": total})

    if not incomplete:
        return {"message": "没有需要补缺的剧本", "refilled": 0, "scripts": []}

    # 先把所有目标剧本立刻置为 generating,前端马上能看到全部"生成中"
    async with get_async_session() as session:
        presult = await session.execute(
            select(FactoryProduct).where(
                FactoryProduct.id.in_([i["id"] for i in incomplete])
            )
        )
        for p in presult.scalars().all():
            p.status = "generating"
        await session.commit()

    # 注意: FastAPI BackgroundTasks 串行执行,逐个add_task会导致剧本排队补缺;
    # 这里改为单个后台任务内 asyncio.gather 并发跑全部补缺
    async def _refill_all_concurrent():
        results = await asyncio.gather(
            *[refill_script_episodes(item["id"], job_id, config) for item in incomplete],
            return_exceptions=True
        )
        errors = [r for r in results if isinstance(r, Exception)]
        if errors:
            logger.error(f"[Job {job_id}] Refill-all: {len(errors)}/{len(incomplete)} scripts failed: {errors}")
        logger.info(f"[Job {job_id}] Refill-all finished: {len(incomplete) - len(errors)}/{len(incomplete)} ok")

    background_tasks.add_task(_refill_all_concurrent)

    logger.info(f"[Job {job_id}] Refill-all started concurrently for {len(incomplete)} scripts: {[i['id'] for i in incomplete]}")
    return {
        "message": f"已为 {len(incomplete)} 部缺集剧本并发启动补缺",
        "refilled": len(incomplete),
        "scripts": incomplete,
    }


@router.post("/jobs/{job_id}/resume")
async def resume_job(
    job_id: int,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user)
):
    """恢复卡住的任务: 为ready_for_script但无剧本的大纲重启剧本生成
    
    典型场景: 服务重启导致BackgroundTask丢失,大纲卡在ready_for_script
    """
    async with get_async_session() as session:
        result = await session.execute(
            select(FactoryJob).where(
                FactoryJob.id == job_id,
                FactoryJob.user_id == user.id
            )
        )
        job = result.scalar_one_or_none()
        
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        
        # 找出ready_for_script的大纲
        oresult = await session.execute(
            select(FactoryProduct).where(
                FactoryProduct.job_id == job_id,
                FactoryProduct.product_type == "outline",
                FactoryProduct.status == "ready_for_script"
            )
        )
        ready_outlines = oresult.scalars().all()
        
        # 找出已有剧本关联的outline_id
        sresult = await session.execute(
            select(FactoryProduct).where(
                FactoryProduct.job_id == job_id,
                FactoryProduct.product_type == "script"
            )
        )
        scripts = sresult.scalars().all()
        done_outline_ids = {
            (s.meta_data or {}).get("outline_id") for s in scripts
        }
        
        # 卡住的大纲 = ready_for_script 且 无关联剧本
        stuck = [o.id for o in ready_outlines if o.id not in done_outline_ids]
        config = job.config or {}
    
    if not stuck:
        return {"message": "没有卡住的大纲", "resumed": 0}
    
    background_tasks.add_task(resume_stuck_outlines, job_id, stuck, config, user.id)
    logger.info(f"[Job {job_id}] Resuming {len(stuck)} stuck outlines: {stuck}")
    
    return {"message": f"已重启{len(stuck)}个大纲的剧本生成", "resumed": len(stuck), "outline_ids": stuck}


@router.post("/jobs/{job_id}/stop")
async def stop_job(
    job_id: int,
    user: User = Depends(get_current_user)
):
    """手动停止任务"""
    async with get_async_session() as session:
        result = await session.execute(
            select(FactoryJob).where(
                FactoryJob.id == job_id,
                FactoryJob.user_id == user.id
            )
        )
        job = result.scalar_one_or_none()
        
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        
        if job.status not in ["pending", "running"]:
            raise HTTPException(status_code=400, detail=f"Cannot stop job with status: {job.status}")
        
        result_data = job.result or {}
        result_data["manual_stop_requested"] = True
        job.result = result_data
        await session.commit()
        
        return {"message": "Stop signal sent", "job_id": job_id}


# V4大纲状态 → 看板列的映射
# 列1(生成/质检中): generated, analyzed_v1, repairable_pending, analyzed_v2, repairable_pending_v2
# 列2(优化中): optimized_v1
# 列3(已舍弃): rejected_fatal, rejected_fatal_v2
# 列4(通过/剧本生成): ready_for_script(剧本生成中) + completed(剧本已完成) + spare(达标后备用)
_KANBAN_COL1 = {"generated", "analyzed_v1", "repairable_pending", "analyzed_v2", "repairable_pending_v2"}
_KANBAN_COL2 = {"optimized_v1"}
_KANBAN_COL3 = {"rejected_fatal", "rejected_fatal_v2"}
_KANBAN_COL4 = {"ready_for_script", "completed", "spare"}


@router.get("/jobs/{job_id}/debug")
async def debug_job(
    job_id: int,
    user: User = Depends(get_current_user)
):
    """V4看板追溯:返回四列看板数据结构供前端KanbanView渲染"""
    async with get_async_session() as session:
        result = await session.execute(
            select(FactoryJob).where(
                FactoryJob.id == job_id,
                FactoryJob.user_id == user.id
            )
        )
        job = result.scalar_one_or_none()
        
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        
        result = await session.execute(
            select(FactoryProduct)
            .where(FactoryProduct.job_id == job_id)
            .order_by(FactoryProduct.created_at.asc())
        )
        products = result.scalars().all()
        
        outlines = [p for p in products if p.product_type == "outline"]
        scripts = [p for p in products if p.product_type == "script"]
        
        # script通过meta_data.outline_id关联到大纲
        scripts_by_outline: dict = {}
        for s in scripts:
            oid = (s.meta_data or {}).get("outline_id")
            if oid:
                scripts_by_outline.setdefault(oid, []).append(s)
        
        def outline_brief(o):
            md = o.meta_data or {}
            return {
                "id": o.id,
                "status": o.status,
                "title": o.title or f"大纲 #{o.id}",
                "content_preview": (o.content or "")[:200],
                "analysis_v1": md.get("analysis_v1"),
                "analysis_v2": md.get("analysis_v2"),
                "created_at": str(o.created_at),
                "scripts": [{
                    "id": s.id,
                    "title": s.title or f"剧本 #{s.id}",
                    "status": s.status,
                    "created_at": str(s.created_at),
                } for s in scripts_by_outline.get(o.id, [])],
            }
        
        col1 = [outline_brief(o) for o in outlines if o.status in _KANBAN_COL1]
        col2 = [outline_brief(o) for o in outlines if o.status in _KANBAN_COL2]
        col3 = [outline_brief(o) for o in outlines if o.status in _KANBAN_COL3]
        col4 = [outline_brief(o) for o in outlines if o.status in _KANBAN_COL4]
        # 未知状态兜底放列1避免丢失
        known = _KANBAN_COL1 | _KANBAN_COL2 | _KANBAN_COL3 | _KANBAN_COL4
        col1 += [outline_brief(o) for o in outlines if o.status not in known]
        
        return {
            "mode": "v4",
            "job_id": job_id,
            "job_status": job.status,
            "job_progress": job.progress if isinstance(job.progress, dict) else {},
            "stats": job.result or {},
            "kanban": {
                "column1": col1,  # 生成/质检中
                "column2": col2,  # 优化中
                "column3": col3,  # 已舍弃
                "column4": col4,  # 通过→剧本生成
            },
            "total_outlines": len(outlines),
            "total_scripts": len(scripts),
        }

@router.get("/stats/dashboard")
async def get_dashboard_stats(user: User = Depends(get_current_user)):
    """获取统计面板数据(真实统计)"""
    from datetime import timedelta, timezone
    
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_ago = today_start - timedelta(days=6)
    
    async with get_async_session() as session:
        # 全部任务
        result = await session.execute(
            select(FactoryJob).where(FactoryJob.user_id == user.id)
        )
        all_jobs = result.scalars().all()
        
        # 今日任务
        today_jobs = [j for j in all_jobs if j.created_at and j.created_at >= today_start]
        today_success = sum(1 for j in today_jobs if j.status == "completed")
        today_failed = sum(1 for j in today_jobs if j.status == "failed")
        today_done = today_success + today_failed
        
        # 今日产物数与token
        presult = await session.execute(
            select(FactoryProduct).where(
                FactoryProduct.user_id == user.id,
                FactoryProduct.created_at >= today_start
            )
        )
        today_products = presult.scalars().all()
        today_tokens = sum(j.total_tokens or 0 for j in today_jobs)
        
        # 7日趋势
        trend = []
        for i in range(7):
            day_start = week_ago + timedelta(days=i)
            day_end = day_start + timedelta(days=1)
            day_jobs = [j for j in all_jobs if j.created_at and day_start <= j.created_at < day_end]
            day_success = sum(1 for j in day_jobs if j.status == "completed")
            day_done = sum(1 for j in day_jobs if j.status in ("completed", "failed"))
            trend.append({
                "date": day_start.strftime("%m-%d"),
                "jobs": len(day_jobs),
                "success_rate": round(day_success / day_done * 100, 1) if day_done else 0,
            })
        
        # 类型分布
        by_type_map: dict = {}
        for j in all_jobs:
            by_type_map.setdefault(j.job_type, {"count": 0, "durations": []})
            by_type_map[j.job_type]["count"] += 1
            if j.finished_at and j.created_at:
                by_type_map[j.job_type]["durations"].append(
                    (j.finished_at - j.created_at).total_seconds()
                )
        by_type = [{
            "job_type": k,
            "count": v["count"],
            "avg_duration": round(sum(v["durations"]) / len(v["durations"]), 1) if v["durations"] else 0,
        } for k, v in by_type_map.items()]
        
        return {
            "total_jobs": len(all_jobs),
            "pending": sum(1 for j in all_jobs if j.status == "pending"),
            "running": sum(1 for j in all_jobs if j.status == "running"),
            "completed": sum(1 for j in all_jobs if j.status == "completed"),
            "failed": sum(1 for j in all_jobs if j.status == "failed"),
            "today": {
                "total_jobs": len(today_jobs),
                "success_jobs": today_success,
                "failed_jobs": today_failed,
                "success_rate": round(today_success / today_done * 100, 1) if today_done else 0.0,
                "total_products": len(today_products),
                "total_tokens": today_tokens,
            },
            "trend_7d": trend,
            "by_type": by_type,
        }


@router.post("/jobs/{job_id}/sync-to-draft")
async def sync_job_to_draft(
    job_id: int,
    user: User = Depends(get_current_user),
):
    """将工厂 job 的outline+script 产物同步到草稿列表，便于查看完整内容和二次编辑。"""
    from .draft_sync import sync_script_to_draft
    async with get_async_session() as db:
        job_q = await db.execute(
            select(FactoryJob).where(FactoryJob.id == job_id, FactoryJob.user_id == user.id)
        )
        job = job_q.scalar_one_or_none()
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        result = await sync_script_to_draft(db, job_id=job_id, user_id=user.id)
        return result


# ==================== 分发到飞书多维表格 ====================

class DistTargetRequest(BaseModel):
    name: str
    url: str
    field_mapping: dict  # {"title": "剧名", "script": "剧本", "genre": "类型", "outline": "大纲"}


class DistributeRequest(BaseModel):
    target_id: int
    script_ids: Optional[List[int]] = None  # 不传则分发全部completed剧本


@router.get("/dist-targets")
async def list_dist_targets(user: User = Depends(get_current_user)):
    """分发目标列表(供'分发给谁'下拉)"""
    async with get_async_session() as session:
        result = await session.execute(
            select(FactoryDistTarget)
            .where(FactoryDistTarget.user_id == user.id)
            .order_by(FactoryDistTarget.created_at.asc())
        )
        targets = result.scalars().all()
        return [{
            "id": t.id,
            "name": t.name,
            "url": t.url,
            "field_mapping": t.field_mapping or {},
            "created_at": t.created_at.isoformat() if t.created_at else None,
        } for t in targets]


@router.post("/dist-targets")
async def create_dist_target(
    req: DistTargetRequest,
    user: User = Depends(get_current_user)
):
    """新建分发目标"""
    if not req.name.strip() or not req.url.strip():
        raise HTTPException(status_code=400, detail="名称与链接不能为空")
    async with get_async_session() as session:
        t = FactoryDistTarget(
            user_id=user.id,
            name=req.name.strip(),
            url=req.url.strip(),
            field_mapping=req.field_mapping or {},
        )
        session.add(t)
        await session.commit()
        await session.refresh(t)
        return {"id": t.id, "name": t.name}


@router.put("/dist-targets/{target_id}")
async def update_dist_target(
    target_id: int,
    req: DistTargetRequest,
    user: User = Depends(get_current_user)
):
    """更新分发目标"""
    async with get_async_session() as session:
        result = await session.execute(
            select(FactoryDistTarget).where(
                FactoryDistTarget.id == target_id,
                FactoryDistTarget.user_id == user.id
            )
        )
        t = result.scalar_one_or_none()
        if not t:
            raise HTTPException(status_code=404, detail="分发目标不存在")
        t.name = req.name.strip()
        t.url = req.url.strip()
        t.field_mapping = req.field_mapping or {}
        await session.commit()
        return {"id": t.id, "name": t.name}


@router.delete("/dist-targets/{target_id}")
async def delete_dist_target(
    target_id: int,
    user: User = Depends(get_current_user)
):
    """删除分发目标"""
    async with get_async_session() as session:
        result = await session.execute(
            select(FactoryDistTarget).where(
                FactoryDistTarget.id == target_id,
                FactoryDistTarget.user_id == user.id
            )
        )
        t = result.scalar_one_or_none()
        if not t:
            raise HTTPException(status_code=404, detail="分发目标不存在")
        await session.delete(t)
        await session.commit()
        return {"deleted": target_id}


@router.post("/dist-targets/preview")
async def preview_dist_target(
    req: DistTargetRequest,
    user: User = Depends(get_current_user)
):
    """校验飞书链接连通性并返回表头字段(供字段映射下拉选择; type=17为附件列)"""
    from ..feishu import client as feishu
    token, table_id = feishu.parse_bitable_ref(req.url)
    if not token or not table_id:
        raise HTTPException(status_code=400, detail="链接无效: 需要含 ?table= 的多维表格链接")
    try:
        app_token = await feishu.resolve_app_token(token)
        fields = await feishu.list_fields(app_token, table_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"飞书表格访问失败: {e}")
    return {
        "fields": [{"name": f.get("field_name"), "type": f.get("type")} for f in fields],
    }


@router.get("/jobs/{job_id}/dist-precheck")
async def dist_precheck(
    job_id: int,
    user: User = Depends(get_current_user)
):
    """分发前检查: 返回可分发产物清单(剧本/小说/推文分类,含进度达标与已分发记录)"""
    async with get_async_session() as session:
        jresult = await session.execute(
            select(FactoryJob).where(
                FactoryJob.id == job_id,
                FactoryJob.user_id == user.id
            )
        )
        job = jresult.scalar_one_or_none()
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        config = job.config or {}
        target_episodes = int(config.get("episodes") or 0)

        presult = await session.execute(
            select(FactoryProduct).where(
                FactoryProduct.job_id == job_id,
                FactoryProduct.product_type.in_(["script", "novel", "tweet"])
            ).order_by(FactoryProduct.id.asc())
        )
        products = presult.scalars().all()

        items = []
        for s in products:
            md = s.meta_data or {}
            total = int(md.get("episodes") or (target_episodes if s.product_type == "script" else 0) or 0)
            done = int(md.get("completed_episodes") or 0)
            dist_history = md.get("dist_history") or []
            items.append({
                "id": s.id,
                "product_type": s.product_type,
                "title": s.title,
                "status": s.status,
                "episodes": total,
                "completed_episodes": done,
                "episodes_ok": bool(total and done >= total),
                "source_label": md.get("source_label"),
                "protagonist": md.get("protagonist"),
                "distributed_to": [h.get("target") for h in dist_history],
            })
        return {
            "job_id": job_id,
            "target_scripts": config.get("total_scripts"),
            "target_episodes": target_episodes,
            "scripts": items,
        }


@router.post("/jobs/{job_id}/distribute")
async def distribute_job(
    job_id: int,
    req: DistributeRequest,
    user: User = Depends(get_current_user)
):
    """分发剧本到飞书多维表格(同步执行,返回逐部结果)"""
    from .distribute import distribute_scripts
    async with get_async_session() as session:
        jresult = await session.execute(
            select(FactoryJob).where(
                FactoryJob.id == job_id,
                FactoryJob.user_id == user.id
            )
        )
        job = jresult.scalar_one_or_none()
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")

        tresult = await session.execute(
            select(FactoryDistTarget).where(
                FactoryDistTarget.id == req.target_id,
                FactoryDistTarget.user_id == user.id
            )
        )
        target = tresult.scalar_one_or_none()
        if not target:
            raise HTTPException(status_code=404, detail="分发目标不存在")

        script_ids = req.script_ids
        if not script_ids:
            presult = await session.execute(
                select(FactoryProduct).where(
                    FactoryProduct.job_id == job_id,
                    FactoryProduct.product_type.in_(["script", "novel", "tweet"]),
                    FactoryProduct.status == "completed"
                )
            )
            script_ids = [s.id for s in presult.scalars().all()]

        target_url = target.url
        target_mapping = target.field_mapping or {}
        target_name = target.name

    if not script_ids:
        raise HTTPException(status_code=400, detail="没有可分发的产物(剧本/小说/推文)")

    try:
        result = await distribute_scripts(
            script_ids=script_ids,
            url=target_url,
            field_mapping=target_mapping,
            job_id=job_id,
            target_name=target_name,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "message": f"分发完成: 成功 {len(result['ok'])} 部, 失败 {len(result['failed'])} 部",
        "target": target_name,
        **result,
    }


# ==================== 自动化流水线(预设) ====================

class PipelineRequest(BaseModel):
    name: str
    steps: list  # [{type, config}]
    model_config_map: Optional[dict] = None


@router.get("/pipelines")
async def list_pipelines(user: User = Depends(get_current_user)):
    """预设列表"""
    from .pipeline import FactoryPipeline
    async with get_async_session() as session:
        rows = (await session.execute(
            select(FactoryPipeline).where(FactoryPipeline.user_id == user.id)
            .order_by(FactoryPipeline.created_at.asc())
        )).scalars().all()
        return [{
            "id": p.id, "name": p.name, "steps": p.steps or [],
            "model_config": p.model_config or {},
            "created_at": p.created_at.isoformat() if p.created_at else None,
        } for p in rows]


@router.post("/pipelines")
async def create_pipeline(req: PipelineRequest, user: User = Depends(get_current_user)):
    from .pipeline import FactoryPipeline
    if not req.name.strip() or not req.steps:
        raise HTTPException(status_code=400, detail="名称与步骤不能为空")
    async with get_async_session() as session:
        p = FactoryPipeline(user_id=user.id, name=req.name.strip(),
                            steps=req.steps, model_config=req.model_config_map or {})
        session.add(p)
        await session.commit()
        await session.refresh(p)
        return {"id": p.id, "name": p.name}


@router.put("/pipelines/{pipeline_id}")
async def update_pipeline(pipeline_id: int, req: PipelineRequest, user: User = Depends(get_current_user)):
    from .pipeline import FactoryPipeline
    async with get_async_session() as session:
        p = (await session.execute(
            select(FactoryPipeline).where(FactoryPipeline.id == pipeline_id, FactoryPipeline.user_id == user.id)
        )).scalar_one_or_none()
        if not p:
            raise HTTPException(status_code=404, detail="预设不存在")
        p.name = req.name.strip()
        p.steps = req.steps
        p.model_config = req.model_config_map or {}
        await session.commit()
        return {"id": p.id, "name": p.name}


@router.delete("/pipelines/{pipeline_id}")
async def delete_pipeline(pipeline_id: int, user: User = Depends(get_current_user)):
    from .pipeline import FactoryPipeline
    async with get_async_session() as session:
        p = (await session.execute(
            select(FactoryPipeline).where(FactoryPipeline.id == pipeline_id, FactoryPipeline.user_id == user.id)
        )).scalar_one_or_none()
        if not p:
            raise HTTPException(status_code=404, detail="预设不存在")
        await session.delete(p)
        await session.commit()
        return {"deleted": pipeline_id}


@router.post("/pipelines/{pipeline_id}/run")
async def run_pipeline_api(pipeline_id: int, background_tasks: BackgroundTasks,
                           user: User = Depends(get_current_user)):
    """执行预设(后台自动流)"""
    from .pipeline import FactoryPipeline, FactoryPipelineRun, run_pipeline
    async with get_async_session() as session:
        p = (await session.execute(
            select(FactoryPipeline).where(FactoryPipeline.id == pipeline_id, FactoryPipeline.user_id == user.id)
        )).scalar_one_or_none()
        if not p:
            raise HTTPException(status_code=404, detail="预设不存在")
        run = FactoryPipelineRun(
            pipeline_id=p.id, user_id=user.id, pipeline_name=p.name,
            status="running", current_step=0, total_steps=len(p.steps or []), step_runs=[])
        session.add(run)
        await session.commit()
        await session.refresh(run)
        run_id = run.id
    background_tasks.add_task(run_pipeline, run_id, pipeline_id, user.id)
    return {"run_id": run_id}


@router.post("/pipeline-runs/{run_id}/resume")
async def resume_pipeline_run(run_id: int, background_tasks: BackgroundTasks,
                              user: User = Depends(get_current_user)):
    """断点续跑自动流(服务重启后恢复):
    已完成步骤跳过; 进行中的裂变步骤复用原job, 产物按章断点续写; 后续步骤正常执行。
    """
    from .pipeline import FactoryPipelineRun, run_pipeline
    async with get_async_session() as session:
        run = (await session.execute(
            select(FactoryPipelineRun).where(
                FactoryPipelineRun.id == run_id, FactoryPipelineRun.user_id == user.id)
        )).scalar_one_or_none()
        if not run:
            raise HTTPException(status_code=404, detail="执行记录不存在")
        if run.status == "completed":
            raise HTTPException(status_code=400, detail="该执行已完成, 无需续跑")
        pipeline_id = run.pipeline_id
    background_tasks.add_task(run_pipeline, run_id, pipeline_id, user.id, True)
    return {"run_id": run_id, "resumed": True}


@router.get("/pipeline-runs")
async def list_pipeline_runs(limit: int = 10, user: User = Depends(get_current_user)):
    """自动流执行记录(运行监控数据源)"""
    from .pipeline import FactoryPipelineRun
    async with get_async_session() as session:
        rows = (await session.execute(
            select(FactoryPipelineRun).where(FactoryPipelineRun.user_id == user.id)
            .order_by(FactoryPipelineRun.created_at.desc()).limit(limit)
        )).scalars().all()
        return [{
            "id": r.id, "pipeline_id": r.pipeline_id, "pipeline_name": r.pipeline_name,
            "status": r.status, "current_step": r.current_step, "total_steps": r.total_steps,
            "step_runs": r.step_runs or [], "error": r.error_message,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        } for r in rows]


# ==================== Token用量统计 ====================

@router.get("/usage-stats")
async def usage_stats(
    start: Optional[str] = None,  # YYYY-MM-DD
    end: Optional[str] = None,
    user: User = Depends(get_current_user),
):
    """Token用量统计: 按时间区间,返回按天/按阶段/按模型聚合"""
    from datetime import datetime as dt, timedelta
    from sqlalchemy import func as sqlfunc
    from .usage import LlmUsageLog

    try:
        start_dt = dt.strptime(start, "%Y-%m-%d") if start else dt.utcnow() - timedelta(days=7)
        end_dt = dt.strptime(end, "%Y-%m-%d") + timedelta(days=1) if end else dt.utcnow() + timedelta(days=1)
    except ValueError:
        raise HTTPException(status_code=400, detail="日期格式需为 YYYY-MM-DD")

    async with get_async_session() as session:
        base = select(LlmUsageLog).where(
            LlmUsageLog.user_id == user.id,
            LlmUsageLog.created_at >= start_dt,
            LlmUsageLog.created_at < end_dt,
        )
        rows = (await session.execute(base)).scalars().all()

    by_day: dict = {}
    by_stage: dict = {}
    by_provider: dict = {}
    total = {"prompt": 0, "completion": 0, "total": 0, "calls": 0}
    for r in rows:
        day = r.created_at.strftime("%m-%d") if r.created_at else "?"
        by_day.setdefault(day, 0)
        by_day[day] += r.total_tokens or 0
        by_stage.setdefault(r.stage or "?", 0)
        by_stage[r.stage or "?"] += r.total_tokens or 0
        by_provider.setdefault(r.provider or "?", 0)
        by_provider[r.provider or "?"] += r.total_tokens or 0
        total["prompt"] += r.prompt_tokens or 0
        total["completion"] += r.completion_tokens or 0
        total["total"] += r.total_tokens or 0
        total["calls"] += 1

    return {
        "total": total,
        "by_day": [{"date": k, "tokens": v} for k, v in sorted(by_day.items())],
        "by_stage": [{"stage": k, "tokens": v} for k, v in sorted(by_stage.items(), key=lambda x: -x[1])],
        "by_provider": [{"provider": k, "tokens": v} for k, v in sorted(by_provider.items(), key=lambda x: -x[1])],
    }


# ==================== 剧本总库(全产物聚合) ====================

@router.get("/library")
async def product_library(
    ptype: Optional[str] = None,      # script/novel/tweet
    q: Optional[str] = None,          # 标题搜索
    distributed: Optional[str] = None,  # yes/no
    limit: int = 50,
    offset: int = 0,
    user: User = Depends(get_current_user),
):
    """剧本总库: 跨任务聚合全部产物(剧本/小说/推文),含溯源与分发信息"""
    async with get_async_session() as session:
        query = select(FactoryProduct).where(
            FactoryProduct.user_id == user.id,
            FactoryProduct.product_type.in_([ptype] if ptype else ["script", "novel", "tweet"]),
        )
        if q:
            query = query.where(FactoryProduct.title.ilike(f"%{q}%"))
        query = query.order_by(FactoryProduct.id.desc())
        rows = (await session.execute(query)).scalars().all()

    items = []
    for p in rows:
        md = p.meta_data or {}
        dist_history = md.get("dist_history") or []
        is_dist = bool(dist_history)
        if distributed == "yes" and not is_dist:
            continue
        if distributed == "no" and is_dist:
            continue
        items.append({
            "id": p.id,
            "job_id": p.job_id,
            "product_type": p.product_type,
            "title": p.title or f"产物{p.id}",
            "status": p.status,
            "episodes": md.get("episodes"),
            "completed_episodes": md.get("completed_episodes"),
            "words": md.get("words"),
            "genre": (md.get("concept") or {}).get("genre") or "",
            "source_label": md.get("source_label"),
            "protagonist": md.get("protagonist"),
            "distributed_to": sorted({h.get("target") for h in dist_history if h.get("target")}),
            "created_at": p.created_at.isoformat() if p.created_at else None,
        })

    total_count = len(items)
    return {"total": total_count, "items": items[offset:offset + limit]}


# ==================== 工作台聚合接口(三栏控制台单次轮询) ====================

@router.get("/workspace-state")
async def workspace_state(user: User = Depends(get_current_user)):
    """一次轮询返回控制台所需全部实时数据:
    queue(任务队列分组) / kpi(今日紧凑指标) / providers(AI资源健康) /
    node_stats(节点级token统计) / pipeline_runs(自动流) / events(伪日志)
    """
    from datetime import timedelta, timezone
    from sqlalchemy import func as sqlfunc
    from .usage import LlmUsageLog, get_provider_health
    from .pipeline import FactoryPipelineRun

    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_naive = today_start.replace(tzinfo=None)

    async with get_async_session() as session:
        # ---- 任务队列(近60条, 含产物统计) ----
        jobs = (await session.execute(
            select(FactoryJob).where(FactoryJob.user_id == user.id)
            .order_by(FactoryJob.created_at.desc()).limit(60)
        )).scalars().all()

        job_ids = [j.id for j in jobs]
        pstats: dict = {}
        if job_ids:
            for p in (await session.execute(
                select(FactoryProduct).where(
                    FactoryProduct.job_id.in_(job_ids),
                    FactoryProduct.product_type == "script")
            )).scalars().all():
                s = pstats.setdefault(p.job_id, {"total": 0, "finished": 0, "failed": 0, "generating": 0})
                s["total"] += 1
                if p.status == "completed":
                    s["finished"] += 1
                elif p.status == "failed":
                    s["failed"] += 1
                elif p.status == "generating":
                    s["generating"] += 1

        def _job_row(j):
            st = pstats.get(j.id, {})
            prog = j.progress if isinstance(j.progress, dict) else {}
            return {
                "id": j.id, "job_type": j.job_type, "status": j.status,
                "task_name": (j.config or {}).get("task_name") or "",
                "theme": (j.config or {}).get("theme") or "",
                "planned_scripts": (j.config or {}).get("total_scripts"),
                "planned_episodes": (j.config or {}).get("episodes"),
                "percent": prog.get("percent"),
                "status_message": prog.get("status_message") or "",
                "total_products": st.get("total", 0),
                "finished_products": st.get("finished", 0),
                "failed_products": st.get("failed", 0),
                "generating_products": st.get("generating", 0),
                "total_tokens": j.total_tokens or 0,
                "error": j.error_message,
                "created_at": j.created_at.isoformat() if j.created_at else None,
                "finished_at": j.finished_at.isoformat() if j.finished_at else None,
            }

        queue = {"running": [], "pending": [], "failed": [], "done": []}
        for j in jobs:
            row = _job_row(j)
            if j.status == "running":
                queue["running"].append(row)
            elif j.status == "pending":
                queue["pending"].append(row)
            elif j.status in ("failed", "partial_failed"):
                queue["failed"].append(row)
            else:
                queue["done"].append(row)

        # ---- 今日 KPI(紧凑) ----
        today_jobs = [j for j in jobs if j.created_at and j.created_at.replace(tzinfo=None) >= today_naive]
        t_success = sum(1 for j in today_jobs if j.status == "completed")
        t_failed = sum(1 for j in today_jobs if j.status in ("failed", "partial_failed"))
        t_done = t_success + t_failed
        today_tokens = (await session.execute(
            select(sqlfunc.coalesce(sqlfunc.sum(LlmUsageLog.total_tokens), 0)).where(
                LlmUsageLog.user_id == user.id,
                LlmUsageLog.created_at >= today_naive)
        )).scalar() or 0
        kpi = {
            "jobs": len(today_jobs), "success": t_success, "failed": t_failed,
            "success_rate": round(t_success / t_done * 100, 1) if t_done else 100.0,
            "tokens": int(today_tokens),
            "running": len(queue["running"]), "pending": len(queue["pending"]),
        }

        # ---- 节点级统计(近7日): token/调用(按阶段) ----
        week_naive = today_naive - timedelta(days=6)
        stage_rows = (await session.execute(
            select(
                LlmUsageLog.stage,
                sqlfunc.count(LlmUsageLog.id),
                sqlfunc.coalesce(sqlfunc.sum(LlmUsageLog.total_tokens), 0),
                sqlfunc.coalesce(sqlfunc.avg(LlmUsageLog.total_tokens), 0),
            ).where(
                LlmUsageLog.user_id == user.id,
                LlmUsageLog.created_at >= week_naive,
            ).group_by(LlmUsageLog.stage)
        )).all()
        node_stats = [{
            "stage": r[0] or "other", "calls": int(r[1]),
            "tokens": int(r[2]), "avg_tokens": int(r[3]),
        } for r in stage_rows]

        # ---- 模型用量表(近7日, 替代饼图) ----
        prov_rows = (await session.execute(
            select(
                LlmUsageLog.provider,
                sqlfunc.count(LlmUsageLog.id),
                sqlfunc.coalesce(sqlfunc.sum(LlmUsageLog.total_tokens), 0),
            ).where(
                LlmUsageLog.user_id == user.id,
                LlmUsageLog.created_at >= week_naive,
            ).group_by(LlmUsageLog.provider)
        )).all()
        provider_usage = [{
            "provider": r[0] or "?", "calls": int(r[1]), "tokens": int(r[2]),
        } for r in sorted(prov_rows, key=lambda x: -x[2])]

        # ---- 自动流 ----
        runs = (await session.execute(
            select(FactoryPipelineRun).where(FactoryPipelineRun.user_id == user.id)
            .order_by(FactoryPipelineRun.created_at.desc()).limit(5)
        )).scalars().all()
        pipeline_runs = [{
            "id": r.id, "pipeline_name": r.pipeline_name, "status": r.status,
            "current_step": r.current_step, "total_steps": r.total_steps,
            "step_runs": r.step_runs or [], "error": r.error_message,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        } for r in runs]

        # ---- 伪日志(近30条事件: job状态时间线 + 用量调用) ----
        events = []
        for j in jobs[:20]:
            if j.created_at:
                events.append({"ts": j.created_at.isoformat(), "level": "info",
                               "text": f"任务{j.id} 创建 ({(j.config or {}).get('task_name') or j.job_type})"})
            if j.finished_at:
                lvl = "error" if j.status in ("failed", "partial_failed") else "success"
                events.append({"ts": j.finished_at.isoformat(), "level": lvl,
                               "text": f"任务{j.id} {'失败' if lvl == 'error' else '完成'}"
                                       + (f": {(j.error_message or '')[:60]}" if lvl == "error" else "")})
        recent_calls = (await session.execute(
            select(LlmUsageLog).where(LlmUsageLog.user_id == user.id)
            .order_by(LlmUsageLog.created_at.desc()).limit(15)
        )).scalars().all()
        for c in recent_calls:
            if c.created_at:
                events.append({"ts": c.created_at.isoformat(), "level": "debug",
                               "text": f"{c.provider} 调用 [{c.stage or 'other'}] {round((c.total_tokens or 0) / 1000, 1)}k tok"
                                       + (f" (任务{c.job_id})" if c.job_id else "")})
        events.sort(key=lambda e: e["ts"], reverse=True)

    return {
        "queue": queue,
        "kpi": kpi,
        "providers": get_provider_health(),
        "node_stats": node_stats,
        "provider_usage": provider_usage,
        "pipeline_runs": pipeline_runs,
        "events": events[:30],
        "ts": now.isoformat(),
    }
