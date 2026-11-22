"""导出任务异步 worker (Phase 5 §12.6.3).

设计:
- 由 FastAPI BackgroundTasks 触发, 不引入额外队列依赖
- 支持 kind ∈ {mixed_docx}; 后续可加 chapter_docx / video_zip / etc.
- 把生成的 docx 上传到 OSS, 拿一个 24h 过期的预签名 URL 写到 ExportJob.output_url
- 任何阶段失败都记录 error 并把 status 置为 failed
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote

from sqlalchemy import select

from ..db.session import session_scope
from ..db.models import ScriptDraft, ScriptChapter, ScriptStoryboard
from ..db.models_phase5 import ExportJob
from ..oss import client as oss_client

logger = logging.getLogger("export_worker")


async def _set_status(job_id: int, *, status: str, progress: int | None = None,
                      output_url: str | None = None, error: str | None = None,
                      finish: bool = False) -> None:
    """局部更新 ExportJob 状态 / 进度."""
    async with session_scope() as s:
        j = await s.get(ExportJob, job_id)
        if not j:
            logger.warning("ExportJob #%s not found", job_id)
            return
        j.status = status
        if progress is not None:
            j.progress = max(0, min(100, progress))
        if output_url is not None:
            j.output_url = output_url
        if error is not None:
            j.error = error[:500]
        if finish:
            j.finished_at = datetime.now(timezone.utc)
        if status == "running" and not j.started_at:
            j.started_at = datetime.now(timezone.utc)


async def _run_mixed_docx(job: ExportJob) -> bytes:
    """跑混合导出, 直接复用 export_chapter_docx.export_mixed_docx."""
    # 复用 stages.router 中已有的逻辑 (拉 chapters + storyboards + 决定 source)
    from ..stages.export_chapter_docx import export_mixed_docx as _export_mixed_docx

    cfg = job.config_json or {}
    mode = cfg.get("mode", "auto")
    src_map = cfg.get("chapter_sources") or {}

    async with session_scope() as s:
        draft = await s.get(ScriptDraft, job.draft_id)
        if not draft:
            raise RuntimeError("draft not found")
        chapters = (await s.execute(
            select(ScriptChapter)
            .where(ScriptChapter.draft_id == job.draft_id)
            .order_by(ScriptChapter.chapter_order)
        )).scalars().all()
        sb_rows = (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == job.draft_id)
        )).scalars().all()
        sb_by_order: dict[int, list] = {}
        for sb in sb_rows:
            shots = sb.shots_json if isinstance(sb.shots_json, list) else []
            sb_by_order[sb.chapter_order] = shots

        # "大纲直接生成剧本" / 导入的剧本: 没有章节正文, 只有剧本(分镜)。
        # 与 stages.router.export_mixed_docx_endpoint 同源处理: 用 outline.chapters 提供标题、
        # storyboards 集号合成"伪章节", 让这类草稿也能导出(否则误报"尚无章节")。
        if not chapters:
            if not sb_by_order:
                raise RuntimeError("尚无章节或剧本, 无法导出")
            ol = dict(draft.outline or {})
            title_by_order = {
                int(c.get("order") or 0): c.get("title", "")
                for c in (ol.get("chapters") or [])
            }

            class _PseudoChapter:
                def __init__(self, order: int, title: str):
                    self.chapter_order = order
                    self.title = title
                    self.full_text = ""
                    self.locked = 0
            chapters = [
                _PseudoChapter(o, title_by_order.get(o) or f"第{o}集")
                for o in sorted(sb_by_order.keys())
            ]
        draft_title = draft.title or "未命名"

    items: list[dict] = []
    for ch in chapters:
        order = ch.chapter_order
        order_str = str(order)
        chapter_locked = bool(getattr(ch, "locked", 0))
        has_full_text = bool((ch.full_text or "").strip())
        has_storyboard = bool(sb_by_order.get(order))

        if mode == "all_chapter":
            source = "chapter"
        elif mode == "all_storyboard":
            source = "storyboard"
        elif mode == "manual":
            source = src_map.get(order_str) or ("chapter" if chapter_locked else "storyboard")
        else:
            source = "chapter" if chapter_locked else "storyboard"

        if source == "chapter" and not has_full_text and has_storyboard:
            source = "storyboard"
        elif source == "storyboard" and not has_storyboard and has_full_text:
            source = "chapter"

        items.append({
            "chapter_order": order,
            "chapter_title": ch.title or f"第{order}集",
            "source": source,
            "full_text": ch.full_text or "",
            "shots": sb_by_order.get(order, []),
        })

    # 同步生成 docx (CPU 任务, 不太重)
    docx_bytes = await asyncio.to_thread(_export_mixed_docx, draft_title=draft_title, chapters=items)

    # 文件名保持中性: 不带"原文X集/剧本Y集"等来源标注(导出即用户作品)。
    filename = f"{draft_title}.docx"
    job._filename = filename  # type: ignore  # 临时挂在对象上, 给上传函数用
    return docx_bytes


async def _run_batch_zip(job: ExportJob) -> tuple[bytes, str]:
    """批量导出打包: 对 config_json.draft_ids 里每部草稿各生成一份 docx, 全部塞进一个 ZIP。
    返回 (zip_bytes, zip_filename)。单文件失败不阻断整体, 记进 _errors.txt。
    """
    import io
    import zipfile

    cfg = job.config_json or {}
    draft_ids = list(cfg.get("draft_ids") or [])
    mode = cfg.get("mode", "auto")
    if not draft_ids:
        raise RuntimeError("draft_ids 为空, 无法批量打包")

    buf = io.BytesIO()
    used_names: dict[str, int] = {}
    errors: list[str] = []
    ok_count = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for did in draft_ids:
            # 复用单部导出逻辑: 临时构造一个 ExportJob 壳传给 _run_mixed_docx
            sub = ExportJob(
                id=job.id, user_id=job.user_id, draft_id=did,
                kind="mixed_docx", status="running",
                config_json={"mode": mode},
            )
            try:
                blob = await _run_mixed_docx(sub)
                name = getattr(sub, "_filename", f"draft_{did}.docx")
                # 去重: 同名剧本加序号后缀 (a.docx / a (2).docx)
                if name in used_names:
                    used_names[name] += 1
                    stem = name[:-5] if name.endswith(".docx") else name
                    name = f"{stem} ({used_names[name]}).docx"
                else:
                    used_names[name] = 1
                zf.writestr(name, blob)
                ok_count += 1
            except Exception as e:  # noqa: BLE001
                logger.warning("[batch_zip] draft %s 导出失败: %s", did, e)
                errors.append(f"草稿 {did}: {type(e).__name__}: {e}")
        if errors:
            zf.writestr(
                "_导出失败清单.txt",
                ("以下草稿导出失败, 已跳过:\n\n" + "\n".join(errors)).encode("utf-8"),
            )
    if ok_count == 0:
        raise RuntimeError("全部草稿导出失败, 无可打包内容")

    zip_bytes = buf.getvalue()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M")
    zip_name = f"批量导出_{ok_count}部_{stamp}.zip"
    return zip_bytes, zip_name


async def _upload_to_oss(*, user_id: int, filename: str, blob: bytes,
                         content_type: str | None = None) -> str:
    """上传字节流到 OSS, 返回 24h 预签名 GET URL."""
    if not oss_client.is_configured():
        raise RuntimeError("OSS 未配置, 无法持久化导出结果")
    key = oss_client.build_oss_key(
        user_id=user_id,
        filename=filename,
        namespace="exports",
    )
    ct = content_type or "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    bucket = oss_client.get_bucket_internal()
    await asyncio.to_thread(
        bucket.put_object,
        key,
        blob,
        headers={"Content-Type": ct},
    )
    # 24h 过期下载 URL。
    # ⚠️ 用 oss_client.sign_get_url (兼容 TOS 的封装), 不能用 bucket.sign_url
    #   (_Oss2CompatBucket 无该方法, 会 AttributeError 导致导出全失败)。
    download_url = await asyncio.to_thread(
        oss_client.sign_get_url, key, ttl_seconds=86400
    )
    return download_url


async def run_export_job(job_id: int) -> None:
    """主入口: BackgroundTasks 调到这里. 不抛异常, 内部捕获并更新 status."""
    logger.info("[export_worker] start job=%s", job_id)
    try:
        async with session_scope() as s:
            j = await s.get(ExportJob, job_id)
            if not j:
                logger.warning("job %s vanished", job_id)
                return
            user_id = j.user_id
            kind = j.kind
            # 拷贝一份(避免 session 关闭后访问)
            job_snapshot = ExportJob(
                id=j.id, user_id=j.user_id, draft_id=j.draft_id,
                kind=j.kind, status=j.status,
                config_json=dict(j.config_json) if j.config_json else {},
            )

        await _set_status(job_id, status="running", progress=10)

        if kind == "mixed_docx":
            blob = await _run_mixed_docx(job_snapshot)
            await _set_status(job_id, status="running", progress=70)
            filename = getattr(job_snapshot, "_filename", "export.docx")
            url = await _upload_to_oss(user_id=user_id, filename=filename, blob=blob)
            await _set_status(job_id, status="done", progress=100, output_url=url, finish=True)
            logger.info("[export_worker] job=%s done size=%s", job_id, len(blob))
        elif kind == "batch_zip":
            blob, zip_name = await _run_batch_zip(job_snapshot)
            await _set_status(job_id, status="running", progress=80)
            url = await _upload_to_oss(user_id=user_id, filename=zip_name, blob=blob, content_type="application/zip")
            await _set_status(job_id, status="done", progress=100, output_url=url, finish=True)
            logger.info("[export_worker] job=%s batch_zip done size=%s", job_id, len(blob))
        else:
            await _set_status(job_id, status="failed", error=f"unsupported kind: {kind}", finish=True)

    except Exception as e:  # noqa: BLE001
        logger.exception("[export_worker] job=%s failed", job_id)
        await _set_status(job_id, status="failed", error=f"{type(e).__name__}: {e}", finish=True)
