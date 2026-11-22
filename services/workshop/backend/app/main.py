"""FastAPI 应用入口。"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware

from .auth.routes import router as auth_router
from .auth.admin_routes import router as admin_new_router, public_router as public_router_v2
from .features import user_features_router, assets_router, analytics_router, theme_router, theme_admin_router, theme_public_router, preview_router, video_router, overview_router, phase5_router  # 新版用户认证(替代旧的auth_routes)
from .oss import router as oss_router
from .prompts import router as prompts_router
from .quick_prompts import router as quick_prompts_router
from .seedance_pe.routes import router as seedance_pe_router
from .volc.routes import router as volc_billing_router
from .volc.models import VolcUsageRecord as _VolcUsageRecord, VolcRateCard as _VolcRateCard  # noqa: F401  触发 create_all 建火山计费表
from .billing.rh_models import RunninghubBilling as _RHBilling  # noqa: F401  触发 create_all 建 runninghub_billing 表
from .clip.routes import router as clip_router
from .clip.asset_routes import router as clip_asset_router
from .clip.models import ClipJob as _ClipJob  # noqa: F401  触发 create_all 建表
from .clip.models import ClipAsset as _ClipAsset  # noqa: F401  触发 create_all 建 clip_assets 表
from .video_delivery.routes import router as video_delivery_router
from .video_delivery.models import VideoDownloadLog as _VDL  # noqa: F401  触发 create_all 建表
from .frontcut.routes import router as frontcut_router
from .frontcut.models import FrontcutJob as _FrontcutJob  # noqa: F401  触发 create_all 建 frontcut_jobs 表
from .frontcut.models import FeishuReverseJob as _FeishuReverseJob  # noqa: F401  触发建 feishu_reverse_jobs 表
from .corpus.routes import router as corpus_router
from .corpus.models import FrontcutCorpusItem as _FrontcutCorpusItem  # noqa: F401  触发 create_all 建 frontcut_corpus_items 表
from .tikhub.models import TikHubUsage as _TikHubUsage  # noqa: F401  触发 create_all 建 tikhub_usage 表
from .novel_video.models import NovelVideoJob as _NVJob, NovelVideoShot as _NVShot, NovelVideoAudioChunk as _NVAudio  # noqa: F401 触发建表
from .novel_video.models import NovelVideoOverlayPreset as _NVOverlay, FeishuBitableSync as _FBSync  # noqa: F401 触发建表
from .db.models import AgentBatchJob as _AgentBatchJob  # noqa: F401  触发 create_all 建 agent_batch_jobs 表
from .db.models import PolishJob as _PolishJob  # noqa: F401  触发 create_all 建 polish_jobs 表
from .polish.routes import router as polish_router
from .db.models import DeaiJob as _DeaiJob  # noqa: F401  触发 create_all 建 deai_jobs 表
from .deai.routes import router as deai_router
from .spawn.models import SpawnJob as _SpawnJob  # noqa: F401  触发 create_all 建 spawn_jobs 表
from .spawn.routes import router as spawn_router
from .factory.models import FactoryJob as _FactoryJob, FactoryProduct as _FactoryProduct, FactoryStats as _FactoryStats, FactoryDistTarget as _FactoryDistTarget  # noqa: F401  触发 create_all 建 factory 表
from .factory.pipeline import FactoryPipeline as _FactoryPipeline, FactoryPipelineRun as _FactoryPipelineRun  # noqa: F401  触发 create_all 建自动流表
from .factory.usage import LlmUsageLog as _LlmUsageLog  # noqa: F401  触发 create_all 建token用量表
from .adapt_products.models import ChapterAdaptation as _ChapterAdaptation, ChapterAdaptJob as _ChapterAdaptJob  # noqa: F401  触发 create_all 建 chapter_adaptations / chapter_adapt_jobs 表
from .db.models_read import DraftReadState as _DraftReadState  # noqa: F401  触发 create_all 建 draft_read_state 表
# 对话工坊上传的长文档（落盘 + 按需检索，2026-10-10）。正文不再进对话历史，
# 否则 40 万字原文约第 33~35 轮会被剪成占位符、第 38 轮滑出窗口，模型开始瞎写。
from .db.models_phase5 import AgentDocument as _AgentDocument, AgentDocumentChapter as _AgentDocumentChapter  # noqa: F401  触发 create_all 建 agent_documents / agent_document_chapters 表
# 对话工坊发给 AI 的图片（截图/参考图，2026-10-28）。库里只存元数据，
# 图落在 /app/uploads/chat-images/。只在"发送这一轮"取出喂给多模态模型，
# 之后的历史轮次只留一行文字引用 —— 图片每轮重发会把上下文撑爆。
from .db.models_phase5 import AgentImage as _AgentImage  # noqa: F401  触发 create_all 建 agent_images 表
from .script_library import ScriptEntry as _ScriptEntry, ScriptVersion as _ScriptVersion  # noqa: F401  触发 create_all 建定稿剧本库表
from .dev_image import design_router as dev_design_v2_router  # 工作台改版方案 v2 效果图 (临时)
from .dev_image import router as dev_image_router
from .production_image.routes import router as production_image_router
from .draft_cover import router as draft_cover_router
from .draft_image import router as draft_image_router
from .stages import router as stages_router
from .stages.router_m5_enhanced import router as stages_m5_router
from .stages.router_m5_regenerate import router as stages_m5_regen_router
from .config import get_settings
from .db import init_db
from .middleware import TimeoutMiddleware
from .security import require_admin

logger = logging.getLogger("orchestrator")


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        await init_db()
        logger.info("DB initialized")
    except Exception as e:  # noqa: BLE001
        logger.warning("init_db failed (continue): %s", e)
    # 自动产线: 内置题材库 seed
    try:
        from .auto_batch.genres import seed_builtin_genres
        await seed_builtin_genres()
    except Exception as e:  # noqa: BLE001
        logger.warning("seed_builtin_genres failed (continue): %s", e)
    # Agent 助手: 默认人设 prompt seed
    try:
        from .agent.prompts import seed_default_prompt
        await seed_default_prompt()
    except Exception as e:  # noqa: BLE001
        logger.warning("agent seed_default_prompt failed (continue): %s", e)
    # 对话工坊 AI 编排: 注册长任务处理器
    # 处理器注册在**两个进程都要做**：worker 负责执行；orchestrator 注册是
    # 为了让"入队后本进程也能兜底执行"（例如单机部署时没起 worker 也不至于卡住）。
    # 真正的可靠执行以 worker 为准（租约+心跳，见 agent/jobs.py）。
    try:
        from .agent import chat_jobs as _cjobs
        _cjobs.register_all()
        logger.info("chat job handlers registered: %s",
                    __import__("app.agent.jobs", fromlist=["x"]).registered_kinds())
    except Exception as e:  # noqa: BLE001
        logger.warning("register chat job handlers failed (continue): %s", e)

    # Factory任务恢复: 容器重启后自动继续进行中的任务(BackgroundTask不持久化)
    try:
        import asyncio as _asyncio
        from sqlalchemy import select as _select
        from .factory.models import FactoryJob as _FJob
        from .db.session import get_session as _fs
        from .factory.create_spawn import run_create_spawn_job as _rcs
        from .factory.import_spawn_impl import run_import_spawn_job as _ris
        async def _recover():
            async for _s in _fs():
                _r = await _s.execute(_select(_FJob).where(_FJob.status == "running"))
                _jobs = _r.scalars().all(); break
            for _j in _jobs:
                logger.info(f"[startup] Recovering factory job {_j.id} type={_j.job_type}")
                if _j.job_type == "create_spawn": _asyncio.create_task(_rcs(_j.id, _j.config or {}, _j.user_id))
                elif _j.job_type == "import_spawn": _asyncio.create_task(_ris(_j.id, _j.config or {}, _j.user_id))
                elif _j.job_type == "video_transcribe":
                    from .factory.video_transcribe import run_video_transcribe_job as _rvt
                    _asyncio.create_task(_rvt(_j.id, _j.config or {}, _j.user_id))
        await _recover()
        logger.info("Factory job recovery done")
    except Exception as _e:
        logger.warning("factory job recovery failed: %s", _e)
    # 火山计费: 种子费率表(不存在才插占位单价, 已存在不覆盖)
    try:
        from .volc.billing import ensure_rate_cards_seeded
        await ensure_rate_cards_seeded()
    except Exception as e:  # noqa: BLE001
        logger.warning("volc ensure_rate_cards_seeded failed (continue): %s", e)
    # 自动产线: 清扫孤儿 running 批次
    # (容器重启会 kill 所有 asyncio task, 但 DB 状态还是 running, 这里恢复成 partial_failed
    #  让用户能点"续跑"按钮做增量补全)
    try:
        from datetime import datetime
        from sqlalchemy import select, update
        from .db import AutoBatchJob, session_scope
        async with session_scope() as s:
            stale = (await s.execute(
                select(AutoBatchJob).where(AutoBatchJob.status.in_(("running", "pending")))
            )).scalars().all()
            for j in stale:
                j.status = "partial_failed"
                j.error = "服务重启,任务被中断 (可点续跑恢复)"
                j.current_step = "interrupted"
                j.finished_at = datetime.utcnow()
            if stale:
                logger.warning("auto_batch: 清扫 %d 个孤儿 running/pending 批次 -> partial_failed", len(stale))
    except Exception as e:  # noqa: BLE001
        logger.warning("auto_batch stale cleanup failed (continue): %s", e)
    # 剧本分析: 清扫孤儿 running/pending 分析
    # (容器重启会 kill 分析协程, 但 DB 状态卡 running, 永远不会完成; 标 failed 让用户可重跑,
    #  也让依赖它的 agent_batch reanalyze 不再无限等待)
    try:
        from datetime import datetime
        from sqlalchemy import select
        from .db.models import ScriptAnalysis
        from .db import session_scope
        async with session_scope() as s:
            stale_an = (await s.execute(
                select(ScriptAnalysis).where(ScriptAnalysis.status.in_(("running", "pending")))
            )).scalars().all()
            for a in stale_an:
                a.status = "failed"
                a.error = "服务重启导致分析中断, 请重新分析"
                a.updated_at = datetime.utcnow()
            if stale_an:
                logger.warning("script_analysis: 清扫 %d 个孤儿 running/pending 分析 -> failed", len(stale_an))
    except Exception as e:  # noqa: BLE001
        logger.warning("script_analysis stale cleanup failed (continue): %s", e)
    # 去 AI 味: 清扫孤儿 running 作业
    # 去 AI 味作业跑在**本进程内存**里(asyncio.create_task), 容器一重启就丢,
    # 但库里那条 DeaiJob 会永远停在 running —— 用户看到"进行中"却永远不动。
    # 刻意**不**自动重跑: 重跑 = 每个容器重启都全量烧一遍 LLM KEY, 而用户可能早走了。
    # 去 AI 味不改草稿(核心不变量), 所以让用户自己决定要不要重来最省钱也最不越权。
    # error 文案必须答掉用户看到"失败"时的第一反应("我的稿子是不是坏了")。
    try:
        from datetime import datetime
        from sqlalchemy import select
        from .db.models import DeaiJob
        from .db import session_scope
        async with session_scope() as s:
            stale_deai = (await s.execute(
                select(DeaiJob).where(DeaiJob.status == "running")
            )).scalars().all()
            for dj in stale_deai:
                dj.status = "failed"
                dj.error = ("服务重启导致作业中断。去 AI 味不改动草稿，"
                            "你的剧本内容没有任何变化，可以直接重新提交。")
                dj.finished_at = datetime.utcnow()
            if stale_deai:
                logger.warning("deai: 清扫 %d 个孤儿 running 作业 -> failed", len(stale_deai))
    except Exception as e:  # noqa: BLE001
        logger.warning("deai stale cleanup failed (continue): %s", e)
    # 文生图: 恢复孤儿任务
    # - upscale 且已有 rh_task_id: RunningHub 远端仍在跑, 重新挂轮询续查
    # - 其余 running/pending (本地协程型生成/未取得 task_id 的放大): 标记 interrupted
    try:
        import asyncio as _asyncio_is
        from sqlalchemy import select as _sel_is
        from .db import session_scope as _scope_is
        from .image_studio.models import ImageJob as _ImageJob
        from .image_studio import service as _is_service
        async with _scope_is() as s:
            rows = (await s.execute(
                _sel_is(_ImageJob).where(_ImageJob.status.in_(("running", "pending")))
            )).scalars().all()
            resume_ids = []
            resume_polish_ids = []
            for j in rows:
                params = dict(j.params or {})
                if j.kind == "upscale" and params.get("rh_task_id"):
                    resume_ids.append(j.id)
                elif j.kind == "polish" and params.get("rh_task_id"):
                    resume_polish_ids.append(j.id)
                else:
                    j.status = "interrupted"
                    j.error = "服务重启,任务被中断"
        for jid in resume_ids:
            _asyncio_is.create_task(_is_service.resume_upscale_job(jid))
        for jid in resume_polish_ids:
            _asyncio_is.create_task(_is_service.resume_polish_job(jid))
        if rows:
            logger.warning(
                "image_studio: 恢复 %d 个放大 + %d 个润色任务, 其余标记 interrupted",
                len(resume_ids), len(resume_polish_ids),
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("image_studio recovery failed (continue): %s", e)
    # 音频生成: 恢复孤儿任务 (与 image_studio 同源)
    # - 已有 rh_task_id: RunningHub 远端仍在跑, 重新挂轮询续查
    # - 其余 running/pending: 标记 interrupted
    try:
        import asyncio as _asyncio_au
        from sqlalchemy import select as _sel_au
        from .db import session_scope as _scope_au
        from .audio_studio.models import AudioJob as _AudioJob
        from .audio_studio import service as _au_service
        async with _scope_au() as s:
            rows = (await s.execute(
                _sel_au(_AudioJob).where(_AudioJob.status.in_(("running", "pending")))
            )).scalars().all()
            resume_ids = []
            for j in rows:
                params = dict(j.params or {})
                if params.get("rh_task_id"):
                    resume_ids.append(j.id)
                else:
                    j.status = "interrupted"
                    j.error = "服务重启,任务被中断"
        for jid in resume_ids:
            _asyncio_au.create_task(_au_service.resume_audio_job(jid))
        if rows:
            logger.warning("audio_studio: 恢复 %d 个音频任务, 其余标记 interrupted", len(resume_ids))
    except Exception as e:  # noqa: BLE001
        logger.warning("audio_studio recovery failed (continue): %s", e)
    # 评审精修: 本地协程型任务, 重启即中断, 残留 running/pending 标记 interrupted
    try:
        from sqlalchemy import select as _sel_cr
        from .db import session_scope as _scope_cr
        from .critique.models import CritiqueRun as _CritiqueRun
        async with _scope_cr() as s:
            rows = (await s.execute(
                _sel_cr(_CritiqueRun).where(_CritiqueRun.status.in_(("running", "pending")))
            )).scalars().all()
            for j in rows:
                j.status = "interrupted"
                j.error = "服务重启,任务被中断"
            if rows:
                logger.warning("critique: 标记 %d 个中断任务", len(rows))
    except Exception as e:  # noqa: BLE001
        logger.warning("critique recovery failed (continue): %s", e)
    # 批量创建(AI广撒网): 自动恢复中断的批次(本地协程,重启即断→自动resume续跑)
    try:
        import asyncio as _asyncio_bc
        from sqlalchemy import select as _sel_bc
        from .db import session_scope as _scope_bc
        from .db.models import AutoBatchJob as _AutoBatchJob
        from .batch_create import service as _bc_service
        async with _scope_bc() as s:
            stale = (await s.execute(
                _sel_bc(_AutoBatchJob).where(_AutoBatchJob.status.in_(("running", "pending", "partial_failed")))
            )).scalars().all()
            resume_ids = []
            for j in stale:
                done = j.finished_dramas or 0
                total = j.total_dramas or 0
                if done < total:  # 有未完成的才resume
                    resume_ids.append(j.id)
            for jid in resume_ids:
                _asyncio_bc.create_task(_bc_service.run_batch(jid, resume=True))
            if resume_ids:
                logger.warning("batch_create: 自动恢复 %d 个中断批次(断点续跑)", len(resume_ids))
    except Exception as e:  # noqa: BLE001
        logger.warning("batch_create recovery failed (continue): %s", e)
    # Agent批量运营: 自动恢复中断的批次(本地协程,重启即断→自动resume续跑)
    try:
        import asyncio as _asyncio_ab
        from sqlalchemy import select as _sel_ab
        from .db import session_scope as _scope_ab
        from .db.models import AgentBatchJob as _AgentBatchJob
        from .agent_batch import service as _ab_service
        async with _scope_ab() as s:
            stale = (await s.execute(
                _sel_ab(_AgentBatchJob).where(_AgentBatchJob.status.in_(("running", "pending", "partial_failed")))
            )).scalars().all()
            resume_ids = []
            for j in stale:
                done = (j.finished or 0) + (j.failed or 0)
                total = j.total or 0
                if done < total:  # 有未完成的才resume
                    resume_ids.append(j.id)
            for jid in resume_ids:
                _asyncio_ab.create_task(_ab_service.run_agent_batch(jid, resume=True))
            if resume_ids:
                logger.warning("agent_batch: 自动恢复 %d 个中断批次(断点续跑)", len(resume_ids))
    except Exception as e:  # noqa: BLE001
        logger.warning("agent_batch recovery failed (continue): %s", e)
    # 自动打磨: 自动恢复中断的打磨作业(本地协程,重启即断→自动resume续跑;已收敛草稿跳过)
    try:
        import asyncio as _asyncio_po
        from sqlalchemy import select as _sel_po
        from .db import session_scope as _scope_po
        from .db.models import PolishJob as _PolishJobR
        from .polish import service as _po_service
        # 新引擎(硬伤账本)草稿收敛状态: 已清零/仍有残留; "失败"也算终态不再补跑。
        # (旧引擎是"达标/已达最大轮", 已弃用; 状态名不一致会导致预筛失效→重复 resume。)
        _PO_DONE = {"已清零", "仍有残留", "失败"}
        async with _scope_po() as s:
            stale = (await s.execute(
                _sel_po(_PolishJobR).where(_PolishJobR.status.in_(("running", "pending", "partial_failed")))
            )).scalars().all()
            resume_ids = []
            for j in stale:
                per = dict(j.per_draft_json or {})
                draft_ids = list(j.draft_ids or [])
                remaining = sum(1 for d in draft_ids if (per.get(str(d)) or {}).get("status") not in _PO_DONE)
                if remaining > 0:  # 有未收敛的才resume
                    resume_ids.append(j.id)
            for jid in resume_ids:
                _asyncio_po.create_task(_po_service.run_polish(jid, resume=True))
            if resume_ids:
                logger.warning("polish: 自动恢复 %d 个中断打磨作业(断点续跑)", len(resume_ids))
    except Exception as e:  # noqa: BLE001
        logger.warning("polish recovery failed (continue): %s", e)
    # DNA 裂变工厂: 本地协程型作业, 重启即中断; 残留 running/pending 标记 failed(可重发)
    try:
        from datetime import datetime as _dt_sp
        from sqlalchemy import select as _sel_sp
        from .db import session_scope as _scope_sp
        from .spawn.models import SpawnJob as _SpawnJobR
        async with _scope_sp() as s:
            rows = (await s.execute(
                _sel_sp(_SpawnJobR).where(_SpawnJobR.status.in_(("running", "pending")))
            )).scalars().all()
            for j in rows:
                j.status = "failed"
                j.error = "服务重启导致裂变中断, 请重新发起"
                j.finished_at = _dt_sp.utcnow()
            if rows:
                logger.warning("spawn: 标记 %d 个中断裂变作业 -> failed", len(rows))
    except Exception as e:  # noqa: BLE001
        logger.warning("spawn recovery failed (continue): %s", e)
    # OSS 上传会话清理 worker (常驻协程, 每小时扫一次过期 pending 会话)
    oss_cleanup_task = None
    try:
        from .oss.cleanup import run_oss_cleanup_worker
        import asyncio as _asyncio
        oss_cleanup_task = _asyncio.create_task(run_oss_cleanup_worker())
    except Exception as e:  # noqa: BLE001
        logger.warning("OSS cleanup worker failed to start (continue): %s", e)

    # 草稿封面自动重试 worker (常驻协程, 每隔 N 分钟扫描 cover_url 为空 / 落 SVG 的草稿
    # 自动调 _generate_one 重生; 限流 + cooldown + max_attempts 防止反复打 image2)
    cover_retry_task = None
    try:
        from .draft_cover.routes import run_cover_retry_daemon
        import asyncio as _asyncio_cov
        cover_retry_task = _asyncio_cov.create_task(run_cover_retry_daemon())
    except Exception as e:  # noqa: BLE001
        logger.warning("draft cover retry daemon failed to start (continue): %s", e)

    # 飞书回写兜底 daemon (常驻协程, 每 10 分钟扫所有飞书配置, 把"已出片但飞书链接列空着"
    # 的行自动补写; 与 worker 实时回写(带重试)互补, 保证最终一致, 用户无需手动补写)
    feishu_writeback_task = None
    try:
        from .feishu.service import run_feishu_writeback_daemon
        import asyncio as _asyncio_fw
        feishu_writeback_task = _asyncio_fw.create_task(run_feishu_writeback_daemon())
    except Exception as e:  # noqa: BLE001
        logger.warning("feishu writeback daemon failed to start (continue): %s", e)

    # 模型健康周期探测 (常驻协程): 逐 模型×渠道 发最小请求, 刷新"稳"标。
    # 中转站的资源天天在变(某天 api4me 的 gemini 分组同时出现"无可用渠道"/
    # "上游饱和"/"账号被停"三种故障), 写死的清单第二天就是错的 —— 所以这个
    # 标必须靠实测现算。关掉: MODEL_PROBE_INTERVAL_MIN=0
    desktop_reminder_task = None
    try:
        from .agent_engine.desktop import run_reminder_daemon
        import asyncio as _asyncio_dr
        desktop_reminder_task = _asyncio_dr.create_task(run_reminder_daemon())
    except Exception as e:  # noqa: BLE001
        logger.warning("desktop reminder daemon failed to start (continue): %s", e)

    model_probe_task = None
    try:
        from .models.health import periodic_probe_loop
        import asyncio as _asyncio_mp
        model_probe_task = _asyncio_mp.create_task(periodic_probe_loop())
    except Exception as e:  # noqa: BLE001
        logger.warning("model health probe failed to start (continue): %s", e)

    # 前贴(frontcut)高清任务恢复: 高清轮询是进程内协程, 重启后死亡 → 凭 hd_rh_task_id 续查 RH,
    # 不再让候选永远卡在"高清处理中…"(2026-08 任务32事故)。
    try:
        from .frontcut.service import resume_hd_upscales as _fc_resume_hd
        import asyncio as _asyncio_fc
        _asyncio_fc.create_task(_fc_resume_hd())
    except Exception as e:  # noqa: BLE001
        logger.warning("frontcut hd upscale recovery failed to start (continue): %s", e)

    # 生成队列并发数: 从 system_settings 表恢复上次运行时的值
    # 解决问题: admin 通过 /v1/stages/system/set-concurrency 把并发数从 3 调到 50,
    # 之前每次容器重启都会回到默认 3 (因为只改了内存里的全局变量); 现在 set-concurrency
    # 同时持久化到 system_settings, 这里启动时读出来覆盖默认值, 实现"重启后自动恢复".
    try:
        from .stages.router import restore_concurrency_from_db
        await restore_concurrency_from_db()
    except Exception as e:  # noqa: BLE001
        logger.warning("restore generation concurrency from DB failed (continue): %s", e)

    # 平台默认模型: 从 system_settings 恢复管理员配的 default_model:<provider>
    # 与并发数同一套机制(同一张表 / 同一个"重启后自动恢复"诉求)。没配过就沿用 env,
    # 所以这一步失败不影响启动 —— 只是回落到 env 的默认型号。
    try:
        from .models.catalog import load_default_models_from_db
        await load_default_models_from_db()
    except Exception as e:  # noqa: BLE001
        logger.warning("restore platform default models from DB failed (continue): %s", e)

    # 小说转视频: 恢复重启遗留的僵尸任务
    # 容器重启会 kill 掉进程内的 run_job/compose_job asyncio 任务, 卡在
    # pending/audio/prompting/imaging/compositing 的 job 会永久停住。这里启动时:
    #   有成片→置 succeeded; 有配音+分镜→补未完成的图再合成(续跑); 早期数据不全→标 failed。
    try:
        from .novel_video import service as _nv_service
        await _nv_service.recover_interrupted_jobs()
    except Exception as e:  # noqa: BLE001
        logger.warning("recover novel_video interrupted jobs failed (continue): %s", e)
    # 短视频资产库: 恢复孤儿反推任务
    # 容器重启会 kill 所有 asyncio task, 卡在 uploaded/describing/optimizing 的资产
    # 会永久卡住; 这里启动时重新 enqueue 让反推+提示词优化继续跑完。
    try:
        import asyncio as _asyncio_clip
        from sqlalchemy import select as _sel_clip
        from .db import session_scope as _scope_clip
        from .clip.models import ClipAsset as _CA
        from .clip import asset_service as _clip_svc
        async with _scope_clip() as s:
            rows = (await s.execute(
                _sel_clip(_CA).where(_CA.status.in_(("uploaded", "describing", "optimizing")))
            )).scalars().all()
            resume_ids = [a.id for a in rows]
            for a in rows:
                a.status = "uploaded"  # 回退到起点重跑
                a.error = ""
        for aid in resume_ids:
            _asyncio_clip.create_task(_clip_svc.run_pipeline(aid))
        if resume_ids:
            logger.warning("clip_assets: 恢复 %d 个孤儿反推任务(重启续跑)", len(resume_ids))
    except Exception as e:  # noqa: BLE001
        logger.warning("clip_assets recovery failed (continue): %s", e)
    # 视频反推剧本: 收拾被重启打断的反推
    # 反推是**进程内协程**(features/video_routes._bg_tasks), 容器一重启就静默没了,
    # 草稿却停在 video_running / video_pulling —— 进度页"第N集 开始分析"再也不动,
    # 用户以为还在跑, 实际早就断了(2026-09-15 一次部署打断 5 个草稿, 3 个跑过一半)。
    # 这里做**保守**收拾: 只改状态让前端能说出实情, 不自动续跑——
    # 每集反推要烧一次视频理解 token, 有的草稿本来就是用户放弃的,
    # 静默续跑等于替用户花钱。续跑由用户点按钮触发(POST /v1/video/drafts/{id}/resume)。
    try:
        from sqlalchemy import select as _sel_vid
        from .db import session_scope as _scope_vid
        from .db import ScriptDraft as _SD
        from .video.video_pipeline import orders_with_text as _orders_done
        from .video.video_pipeline import resume_sources as _resume_src

        async with _scope_vid() as s:
            stalled = (await s.execute(
                _sel_vid(_SD).where(_SD.status.in_(("video_running", "video_pulling")))
            )).scalars().all()
            stalled_ids = [(d.id, d.status) for d in stalled]

        resumable: list[int] = []
        dead: list[int] = []
        for did, _st in stalled_ids:
            src = await _resume_src(did)
            if not src:
                dead.append(did)   # 连素材都没了(本地文件被清), 续跑无从谈起
                continue
            done = await _orders_done(did)
            if set(src.keys()) - done:
                resumable.append(did)   # 还有没做完的集
            # 集全做完了(只是有失败集) → 保持原样, 那是"部分失败", 不是中断

        if resumable:
            async with _scope_vid() as s:
                rows = (await s.execute(
                    _sel_vid(_SD).where(_SD.id.in_(resumable))
                )).scalars().all()
                for d in rows:
                    d.status = "interrupted"
        if dead:
            async with _scope_vid() as s:
                rows = (await s.execute(
                    _sel_vid(_SD).where(_SD.id.in_(dead))
                )).scalars().all()
                for d in rows:
                    d.status = "failed"
        if resumable or dead:
            logger.warning(
                "video reverse: 重启后清理 %d 个僵死反推草稿 —— 可续跑 %s / 无素材标 failed %s",
                len(resumable) + len(dead), resumable, dead,
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("video reverse interrupted recovery failed (continue): %s", e)
    try:
        yield
    finally:
        if oss_cleanup_task and not oss_cleanup_task.done():
            oss_cleanup_task.cancel()
        if cover_retry_task and not cover_retry_task.done():
            cover_retry_task.cancel()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Drama Script Orchestrator",
        version="0.4.0",
        description="长剧本生成编排服务",
        lifespan=lifespan,
    )

    # Middleware
    app.add_middleware(TimeoutMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Total-Count"],
    )

    # Routes
    from .muse_login import configure_muse_login
    configure_muse_login(app, "script-workshop")
    app.include_router(auth_router)  # 新版auth自带/v1/auth prefix
    app.include_router(admin_new_router)  # 新admin管理API(/v1/admin-api)
    app.include_router(public_router_v2)  # 公开API(/v1/public,含公告/settings)
    app.include_router(user_features_router)  # 用户功能
    app.include_router(assets_router)
    app.include_router(analytics_router)
    app.include_router(theme_router)  # 用户主题 /v1
    app.include_router(theme_admin_router)  # admin预设背景 /v1/admin-api/preset-backgrounds
    app.include_router(theme_public_router)  # 公开预设背景列表
    app.include_router(preview_router)  # 大纲预览(多模型)
    app.include_router(video_router)  # 视频反推剧本
    app.include_router(overview_router)  # 草稿工作台总览聚合 (KPI/最近章节/最近日志/AI 建议)
    app.include_router(phase5_router)  # Phase 5: 角色/安全/导出/配额/邮箱验证/续写偏好/Agent 附件
    app.include_router(oss_router)    # OSS 大文件直传 (上传会话/预签名 URL/multipart)
    app.include_router(video_delivery_router)  # 视频交付中心 (CDN下载/统计)
    app.include_router(prompts_router)  # 视频提示词生成 (规划+渲染+模板管理)
    app.include_router(quick_prompts_router)  # 提示词速转 (脱离剧本流的独立工具)
    app.include_router(seedance_pe_router)  # Seedance 2.0 提示词优化 (byted-ark-seedance-pe skill)
    app.include_router(volc_billing_router)  # 火山计费 (管理员: 用量/成本/费率, /v1/admin-api/volc-billing)
    app.include_router(clip_asset_router)  # 短视频资产库 (⚠️必须在 clip_router 之前注册, 否则 /v1/clip/{job_id} 会抢占 /v1/clip/assets)
    app.include_router(clip_router)  # 短视频流水线 (输入→合成→首帧图→RunningHub生视频)
    app.include_router(frontcut_router)  # 前贴生成 (剧情视频反推→5框架生成前贴提示词/视频→挑选→拼接)
    app.include_router(corpus_router)  # 前贴语料库 (预置+自上传参考文本/视频反推, 替代飞书库作生成参考)
    from .tikhub import tikhub_router
    app.include_router(tikhub_router)  # TikHub 短视频大数据(抖音检索/下载/榜单/评论) + 用量统计
    from .novel_video import novel_video_router
    app.include_router(novel_video_router)  # 小说转视频(仅管理员)
    from .feishu.routes import router as feishu_router
    app.include_router(feishu_router)  # 飞书多维表格自动化(仅授权用户)
    from .batch_create import router as batch_create_router
    app.include_router(batch_create_router)  # 批量创建工厂: 批量AI原创草稿→全流程→打分, 靠分数筛底子好的
    from .agent_batch.routes import router as agent_batch_router
    app.include_router(agent_batch_router)  # 超级Agent批量运营: 筛选草稿→顺序执行动作链(精修→采纳等)
    # ⛔ 已停用（2026-09-18 入口审计裁定）：自动打磨 polish 工作流
    #    理由：验证后完全没有可用性 —— 近 30 天 prod 仅 1 次调用（7 人历史），
    #    独立入口已被对话工坊的「精修这批」取代（用户 2026-09-18 明确裁定：
    #    "这些功能已经完全被现在唯一对话工坊中的精修这批按钮替换，旧逻辑都可以不要"）。
    #    ⚠ 与 polish 循环收敛能力相关的问题：它的"分析↔优化循环至收敛"确实与
    #    对话工坊的一次性精修不同，但既然实测无人使用，按裁定一并停用。
    #    恢复方式：取消下面两行注释即可（代码与 service 均完整保留）。
    # app.include_router(polish_router)  # 自动打磨工作流: 批量草稿"分析↔优化"循环至收敛(无硬伤/达标)
    app.include_router(deai_router)  # 去 AI 味工作室: 检测+LLM去味改写+注入人味瑕疵(所有登录用户; 逐条草稿/作业归属校验见 deai/routes.py)
    app.include_router(spawn_router)  # DNA 裂变工厂: 从原作提取爆款DNA→批量裂变出N个各具新意的完整新作(大纲级)
    from .factory.routes import router as factory_router
    app.include_router(factory_router)  # 内容裂变工厂: 从零创作→导入→批量转视频完整工作流
    from .script_library import router as script_library_router
    app.include_router(script_library_router)  # 定稿剧本库: Muse 定稿上传, 全员可看, 组长选用
    from .narrative import narrative_router
    app.include_router(narrative_router)  # 叙事健康度: 事件时间轴 + 实体负荷检测(读 state_ledger, 零新表)
    from .rewrite import rewrite_router
    app.include_router(rewrite_router)  # 整本AI精修: 两轮同上下文全局重写→格式无损拆回覆写草稿(替代旧打磨单稿入口)
    from .check import check_router
    app.include_router(check_router)  # 对话工坊体检/定点修复: 四类体检(结构/文风/一致性/剧本) + 按 issue_id 最小改动修复
    from .adapt_products import adapt_router
    app.include_router(adapt_router)  # 章节改编: 原文→小说(增描)/推文(第一人称), 逐章产出独立表存储
    from .models.catalog_routes import router as models_router
    app.include_router(models_router)  # 可选模型清单(带实测"稳"标) + 健康探测 + 按人按模型用量
    # 市场数据已切换为 TikHub 短视频大数据源(旧网文大数据 MCP 因定价不明已弃用)
    # from .market import market_router
    # app.include_router(market_router)
    # ⚠️ 临时: dev 环境 UI 重构期示意图生成 (gpt-image-2 via kegeai), 仅用于内部对照, 上线时可移除
    app.include_router(dev_image_router)
    # ⚠️ 临时: 工作台改版设计方案 v2 的效果图 (同一条生图通道, 独立前缀 /v1/dev/design-v2)
    app.include_router(dev_design_v2_router)
    # 生产级 image2 资产生成 (admin only): 8 张静态资产 + 草稿封面/角色头像/速转首帧图运行时模板
    app.include_router(production_image_router)
    # 草稿封面: 单张生成 + admin 批量回填 + 静态文件 (prefix /v1/drafts)
    app.include_router(draft_cover_router)
    # 草稿内「生图」版块: 提示词→生图联动 + 九宫格 + 角色垫图 (prefix /v1)
    app.include_router(draft_image_router)
    # 旧 langgraph 生成端点(/v1/generate,/v1/generate/stream)与 admin 语料库上传(admin_api)已废弃下线, 不再挂载
    app.include_router(stages_router)  # M5: 三阶段创作（自带 prefix /v1/stages）
    app.include_router(stages_m5_router)  # M5增强: 单集锁定/修改/历史版本
    app.include_router(stages_m5_regen_router)  # M5增强: 区间/单集重新生成
    from .stages.lint_routes import router as stages_lint_router
    app.include_router(stages_lint_router)  # P2/P6: 大纲一致性校验(硬伤检测,只标注)
    # 剧本分析(评级/爆点/风险/受众/建议),自带 prefix /v1/stages
    from .analysis.routes import router as analysis_router
    app.include_router(analysis_router)

    # 全自动批量产线 (admin 专用,自带 prefix /v1/admin-api/auto-batch)
    from .auto_batch.routes import router as auto_batch_router
    app.include_router(auto_batch_router)

    # Agent 助手浮窗 (用户专用, prefix /v1/agent)
    from .agent import router as agent_router
    app.include_router(agent_router)
    from .agent_engine.routes import router as agent_engine_router
    app.include_router(agent_engine_router)  # Agent 引擎（LangGraph）：超级 Agent 与对话工坊的统一执行层
    from .agent_engine.desktop import router as agent_engine_desktop_router
    app.include_router(agent_engine_desktop_router)  # 镜流桌面客户端调剧本平台工具（/v1/desktop-agent）
    from .agent_engine.mcp import router as agent_engine_mcp_router
    app.include_router(agent_engine_mcp_router)  # 外部 Agent 经 MCP 调同一套工具（/v1/mcp，API Key 鉴权）
    from .auth.api_keys import router as api_keys_router
    app.include_router(api_keys_router)  # 本人的 API Key：建、列、吊销（/v1/api-keys，只认登录令牌）
    from .agent_engine.internal import router as agent_engine_internal_router
    app.include_router(agent_engine_internal_router)  # worker→orchestrator 内部通道（密钥+拒绝经 nginx 转发）
    from .agent_engine.bridge import router as agent_engine_bridge_router
    app.include_router(agent_engine_bridge_router)  # 飞书机器人→剧本平台 Agent（密钥+拒绝经 nginx 转发）

    # 文生图工作台 (用户端 /v1/image-studio + 管理端 /v1/admin-api/image-studio)
    from .image_studio.routes import router as image_studio_router, admin_router as image_studio_admin_router
    app.include_router(image_studio_router)
    app.include_router(image_studio_admin_router)

    # 音频生成工作台 (用户端 /v1/audio-studio; RunningHub IndexTTS, 与生图共享 100 并发)
    from .audio_studio import audio_studio_router
    app.include_router(audio_studio_router)

    # ⛔ 已停用（2026-09-18 入口审计裁定）：评审精修 critique **功能**（用户端 + 管理端）
    #    理由：验证后完全没有可用性 —— 近 30 天 prod 仅 2 次调用（16 人共 39 次，
    #    最后一次 2026-09-01）。它与「整本 AI 精修」都做"AI 审整本 + 改写覆写"，
    #    入口高度重叠而用户分不清该点哪个；按用户 2026-09-18 裁定统一收归对话工坊。
    #
    #    ⚠️ 但**不能整块停用**：story-bible 的 3 个端点
    #       (GET/POST/PUT /drafts/{id}/story-bible, 见 critique/routes.py:266-293)
    #       与评审精修共用同一个 router 前缀 /v1/critique，而**工作台总览中心**
    #       (_OverviewHub.tsx → lib/critique.ts) 正在用它们。整块注释会让总览一起失效。
    #
    #    所以拆成两半：story-bible 三个端点保留（在 critique/routes.py 里未停用），
    #    评审精修本身的 10 个端点在该文件里逐个注释掉了。
    #    恢复评审精修时：取消该文件里 10 处 [STOPPED] 注释 + 取消下面 admin_router 的注释。
    from .critique import critique_router
    app.include_router(critique_router)  # 仅保留 story-bible 三个端点（评审精修已停用）
    # from .critique.routes import admin_router as critique_admin_router
    # app.include_router(critique_admin_router)

    # 计费 (生图/放大费用查询: 用户看自己, 管理员看所有人)
    from .billing.routes import router as billing_router, admin_router as billing_admin_router
    app.include_router(billing_router)
    app.include_router(billing_admin_router)
    from .feedback.routes import router as feedback_router, admin_router as feedback_admin_router
    app.include_router(feedback_router)
    app.include_router(feedback_admin_router)

    @app.get("/")
    async def root() -> dict[str, str]:
        return {"service": settings.app_name, "status": "running", "version": "0.4.0"}

    # ---------------------------------------------------------------- 500 兜底
    #
    # 用户投诉里那句光秃秃的「HTTP 500」是这么来的：FastAPI 未捕获异常时回的是
    # **纯文本** `Internal Server Error`，前端 `res.json()` 解析失败 → `{}` →
    # `err.detail || \`HTTP ${res.status}\`` 退化成 "HTTP 500"。全站几十处
    # fetch 都是这个写法，逐个去改既改不干净也压不住下一个新写的。
    #
    # 所以在服务端统一兜住：500 也回 JSON，带一句人能看懂的话和一个 trace_id。
    # 用户把 trace_id 报过来，`grep` 日志就能直接定位到那一次请求 ——
    # 过去只能靠时间点大海捞针。
    #
    # 注意：**不把异常详情返回给客户端**（可能含 SQL / 路径 / 内部结构），
    # 详情只进日志。
    from fastapi.responses import JSONResponse
    from starlette.requests import Request as _Req

    @app.exception_handler(Exception)
    async def _unhandled(request: _Req, exc: Exception):
        import uuid
        trace_id = uuid.uuid4().hex[:12]
        logger.exception("unhandled error trace_id=%s %s %s",
                         trace_id, request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={
                "detail": f"服务器处理这个请求时出错了（错误编号 {trace_id}）。"
                          "请稍后重试；若反复出现，把这个编号发给管理员即可定位。",
                "trace_id": trace_id,
            },
        )

    return app


app = create_app()
