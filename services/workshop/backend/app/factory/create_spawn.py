"""从零创作任务 - V4流式质量保障架构

核心改进:
1. 流式处理 - 大纲通过质检后立即进入剧本生成
2. 双轮质检 - 保留完整的分析+优化循环
3. 只生成剧本 - 不负责视频生成
4. 全链路追溯 - 每个大纲状态可追踪
"""
import asyncio
import json
import logging
import re
from typing import Optional, Dict, Any
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.session import get_session as get_async_session
from .models import FactoryJob, FactoryProduct
from ..stages.outline_gen import generate_outline
from ..stages.chapter_gen import generate_chapter
from ..models.llm import get_llm

logger = logging.getLogger(__name__)

# 创意发散每批数量(单次LLM能保质产出的差异化创意上限)
BRAINSTORM_BATCH_SIZE = 10
# LLM调用失败自动重试: 次数与指数退避基数(2s→4s→8s)
LLM_RETRY_ATTEMPTS = 3
LLM_RETRY_BASE_DELAY = 2.0

# 阶段级模型配置默认值(任务config.model_config可覆盖)
DEFAULT_MODEL_CONFIG = {
    "brainstorm": "gemini",   # 创意发散
    "outline": "gemini",      # 大纲生成
    "check": "gemini",        # 质检/优化
    "script": "gemini",       # 剧本(分镜)生成
}


def stage_provider(config: dict, stage: str) -> str:
    """从任务config取该阶段的模型provider(未配置用默认)"""
    mc = (config or {}).get("model_config") or {}
    return mc.get(stage) or DEFAULT_MODEL_CONFIG.get(stage, "gemini")


async def retry_async(coro_factory, attempts: int = LLM_RETRY_ATTEMPTS, base_delay: float = LLM_RETRY_BASE_DELAY, label: str = ""):
    """通用异步重试器: 指数退避,应对LLM/网络偶发失败。

    Args:
        coro_factory: 无参函数,每次调用返回新的coroutine(不能复用已await的coroutine)
    """
    last_exc: Optional[Exception] = None
    for i in range(attempts):
        try:
            return await coro_factory()
        except Exception as e:
            last_exc = e
            if i < attempts - 1:
                delay = base_delay * (2 ** i)
                logger.warning(f"retry[{label}] attempt {i+1}/{attempts} failed: {e}; retrying in {delay:.0f}s")
                await asyncio.sleep(delay)
            else:
                logger.error(f"retry[{label}] all {attempts} attempts failed: {e}")
    raise last_exc  # type: ignore[misc]


def _is_content_blocked(exc: Exception) -> bool:
    """判断是否为LLM内容审查拦截(确定性错误,重试同通道无意义,需换模型)"""
    s = str(exc)
    return "prompt_blocked" in s or "PROHIBITED" in s or "content_filter" in s


def shots_to_script_text(shots: list) -> str:
    """把主平台分镜结构渲染成标准剧本文本。

    格式与主平台"剧本式分镜"一致:
      1-1 日.地下停车场
      △小雨蹲在车位角落，手里攥着半张照片。
      林晨(哭腔)【抬头】: 你还知道回来？
    """
    lines: list = []
    for s in shots or []:
        if not isinstance(s, dict):
            continue
        header = " ".join(x for x in [
            str(s.get("scene_no", "") or "").strip(),
            str(s.get("time_loc", "") or "").strip(),
        ] if x)
        if header:
            lines.append(header)
        subtitle = str(s.get("subtitle", "") or "").strip()
        if subtitle:
            lines.append(f"【字幕: {subtitle}】")
        elements = s.get("elements") or []
        for e in elements:
            if not isinstance(e, dict):
                continue
            t = e.get("type")
            if t == "action":
                c = str(e.get("content", "") or "").strip()
                if c:
                    lines.append("△" + c.lstrip("△").strip())
            elif t == "dialogue":
                ch = str(e.get("character", "") or "").strip()
                mode = str(e.get("mode", "") or "").strip()
                act = str(e.get("action", "") or "").strip()
                c = str(e.get("content", "") or "").strip()
                if c:
                    lines.append(f"{ch}{f'({mode})' if mode else ''}{f'【{act}】' if act else ''}: {c}")
            elif t == "flashback_start":
                lines.append("【闪回开始】")
            elif t == "flashback_end":
                lines.append("【闪回结束】")
        # 旧镜头表格式兜底
        if not elements:
            if str(s.get("action", "") or "").strip():
                lines.append(str(s["action"]).strip())
            if str(s.get("dialogue", "") or "").strip():
                lines.append(str(s["dialogue"]).strip())
        lines.append("")
    return "\n".join(lines).strip()


def _episode_context(outline_data: dict, chapter_meta: dict, chapters: list) -> str:
    """组装单集剧本生成的全剧上下文(简介 + 主要人物)。

    🔴 2026-10-09：**不再**往里放「上一集概要」。

    用户已定结论：衔接要直接用**上下集原文**而非梗概。而梗概是模型的二次产物，
    偏差会被当成"已发生的事实"继承放大（2026-10-08 的草稿 2421 被第 5 章摘要
    一路污染到第 19 章）。此前这里放的是 `prev.get("synopsis")`，
    与 `generate_storyboard_from_outline` 新收的 `prev_text`（原文）**口径重复** ——
    同一条信息一精确一模糊地同时进 prompt，模型按哪个写是不确定的。

    上一集内容现在由调用方经 `prev_text` 传入（取不到才退回梗概），
    两者不会同时出现。
    """
    parts: list = []
    if outline_data.get("synopsis"):
        parts.append(f"全剧简介: {outline_data['synopsis']}")
    chars = outline_data.get("characters") or []
    if chars:
        names = "、".join(
            (c.get("name", "") if isinstance(c, dict) else str(c)) for c in chars[:12]
        )
        parts.append(f"主要人物: {names}")
    return "\n".join(parts)


async def generate_episode_script_resilient(
    outline_data: dict,
    chapter_meta: dict,
    label: str,
    primary_provider: str = "gemini",
    prev_script_text: str = "",
) -> str:
    """单集剧本生成 — 与主平台同步的'大纲直生剧本'框架。

    调用主平台 storyboard_from_outline 模板(DB可配置)生成剧本式分镜,
    渲染为标准剧本文本。gemini重试耗尽且属内容拦截时自动切qwen。

    prev_script_text: 上一集**实际生成的剧本正文**(2026-10-05 新增)。
    此前只喂上一集梗概 → 模型看不见上一集写了什么 → 相邻集重演同一场戏。
    """
    from ..stages.storyboard_gen import generate_storyboard_from_outline
    from ..stages.episode_render import build_contract_block, build_beats_block

    chapters = outline_data.get("chapters") or []
    synopsis = (
        chapter_meta.get("synopsis") or chapter_meta.get("summary")
        or chapter_meta.get("plot") or ""
    )
    # 🔴 2026-10-09：原先这里把 must_have **拼进 synopsis 字符串**，是五个调用点里
    # 唯一这么做的（其余四个什么都不传）。结果是同一条信息在不同入口以不同形状
    # 到达模型，而且契约与节拍仍然全丢。现在统一改走 `episode_render` 渲染的
    # 独立块，与 batch_gen / router / chat_jobs 完全同款。
    # ⚠️ 此处 **不读** outline 里的 must_have —— 有 draft_id 的路径由那些调用点负责；
    # 这里只有内存里的 outline_data，直接由它渲染。
    order = chapter_meta.get("order", "?")
    title = f"第{order}集 {chapter_meta.get('title', '')}".strip()
    context = _episode_context(outline_data, chapter_meta, chapters)
    _single = {"chapters": [chapter_meta]}
    contract_block = build_contract_block(_single, chapter_meta.get("order") or 0)
    beats_block = build_beats_block(_single, chapter_meta.get("order") or 0)
    if not contract_block and (chapter_meta.get("must_have") or []):
        # 老集纲没有契约字段时，至少把 must_have 作为契约的替身递进去
        # （而不是拼进梗概 —— 拼进去后模型分不清哪句是剧情、哪句是要求）
        mh = "\n".join(f"- {m}" for m in chapter_meta["must_have"] if str(m).strip())
        if mh:
            contract_block = "【本集必备情节点（必须兑现）】\n" + mh

    async def _gen(provider: str) -> str:
        shots = await generate_storyboard_from_outline(
            episode_order=int(order) if str(order).isdigit() else 0,
            synopsis=synopsis,
            chapter_title=title,
            context=context,
            provider=provider,
            draft_id=None,
            prev_text=prev_script_text,
            contract_block=contract_block,
            beats_block=beats_block,
        )
        text = shots_to_script_text(shots)
        if not text.strip():
            raise RuntimeError("storyboard rendered empty")
        return text

    try:
        return await retry_async(lambda: _gen(primary_provider), label=label)
    except Exception as e:
        if _is_content_blocked(e):
            fb = "qwen" if primary_provider != "qwen" else "gemini"
            logger.warning(f"{label}: {primary_provider} content-blocked, fallback to {fb}")
            return await retry_async(lambda: _gen(fb), label=f"{label}-{fb}")
        raise


async def generate_chapter_resilient(
    outline_data: dict,
    chapter_order: int,
    word_target: int,
    prev_chapters: list,
    label: str,
) -> str:
    """单集生成: gemini重试 → 内容审查拦截时自动切换qwen通道再试。

    Gemini的PROHIBITED_CONTENT是确定性拦截(同prompt重试必然再被拦),
    唯一出路是换模型通道; 其他异常走常规指数退避重试。
    """
    from ..stages.chapter_gen import generate_chapter as _gc

    async def _gen(provider: str):
        return await _gc(
            outline=outline_data,
            chapter_order=chapter_order,
            word_target=word_target,
            prev_chapters=prev_chapters,
            provider=provider,
            draft_id=None
        )

    try:
        return await retry_async(lambda: _gen("gemini"), label=label)
    except Exception as e:
        if _is_content_blocked(e):
            logger.warning(f"{label}: gemini content-blocked, fallback to qwen")
            return await retry_async(lambda: _gen("qwen"), label=f"{label}-qwen")
        raise


# ============================================================
# 数据库辅助函数
# ============================================================

async def get_job(job_id: int) -> Optional[FactoryJob]:
    """获取Job"""
    async for session in get_async_session():
        result = await session.execute(
            select(FactoryJob).where(FactoryJob.id == job_id)
        )
        job = result.scalar_one_or_none()
        if job:
            await session.refresh(job)
        return job


async def update_job_status(job_id: int, status: str):
    """更新Job状态"""
    async for session in get_async_session():
        result = await session.execute(
            select(FactoryJob).where(FactoryJob.id == job_id)
        )
        job = result.scalar_one_or_none()
        if job:
            job.status = status
            await session.commit()


async def update_job_status_message(job_id: int, message: str):
    """更新Job的状态消息，让前端实时看到进度"""
    async for session in get_async_session():
        result = await session.execute(
            select(FactoryJob).where(FactoryJob.id == job_id)
        )
        job = result.scalar_one_or_none()
        if job:
            # 兼容老数据: progress可能是裸int(旧代码写入),必须归一化为dict
            # ⚠ 必须构造新dict: 原地修改同一对象SQLAlchemy检测不到JSONB变更,会静默不落库
            current = dict(job.progress) if isinstance(job.progress, dict) else {}
            current["status_message"] = message
            current["updated_at"] = __import__('datetime').datetime.utcnow().isoformat()
            job.progress = current
            await session.commit()
            return

async def update_job_progress(job_id: int, progress: int):
    """更新Job进度(0-100) — 统一写入dict格式{percent: N},不再写裸int"""
    async for session in get_async_session():
        result = await session.execute(
            select(FactoryJob).where(FactoryJob.id == job_id)
        )
        job = result.scalar_one_or_none()
        if job:
            current = dict(job.progress) if isinstance(job.progress, dict) else {}
            current["percent"] = max(0, min(100, progress))
            job.progress = current
            await session.commit()


async def update_job_result(job_id: int, result_data: dict):
    """更新Job结果数据"""
    async for session in get_async_session():
        result = await session.execute(
            select(FactoryJob).where(FactoryJob.id == job_id)
        )
        job = result.scalar_one_or_none()
        if job:
            job.result = result_data
            await session.commit()


async def check_manual_stop(job_id: int) -> bool:
    """检查是否手动停止"""
    job = await get_job(job_id)
    if not job or not job.result:
        return False
    return job.result.get("manual_stop_requested", False)


async def create_product(
    job_id: int,
    user_id: int,
    product_type: str,
    title: str,
    content: str,
    status: str,
    meta_data: Optional[dict] = None,
    parent_id: Optional[int] = None
) -> int:
    """创建Product并返回ID"""
    async for session in get_async_session():
        product = FactoryProduct(
            job_id=job_id,
            user_id=user_id,
            product_type=product_type,
            title=title,
            content=content,
            status=status,
            meta_data=meta_data or {},
            parent_id=parent_id
        )
        session.add(product)
        await session.commit()
        await session.refresh(product)
        return product.id


async def update_product_status(product_id: int, status: str, meta_data: Optional[dict] = None):
    """更新Product状态"""
    async for session in get_async_session():
        result = await session.execute(
            select(FactoryProduct).where(FactoryProduct.id == product_id)
        )
        product = result.scalar_one_or_none()
        if product:
            product.status = status
            if meta_data:
                product.meta_data = {**(product.meta_data or {}), **meta_data}
            await session.commit()


async def update_product_content(product_id: int, content: str, version_label: Optional[str] = None):
    """更新Product内容
    
    version_label提供时,先把当前content快照存入meta_data.content_history,
    保留大纲的历史版本(初始版/一轮优化版)供前端追溯查看。
    """
    async for session in get_async_session():
        result = await session.execute(
            select(FactoryProduct).where(FactoryProduct.id == product_id)
        )
        product = result.scalar_one_or_none()
        if product:
            if version_label and product.content:
                md = dict(product.meta_data or {})
                history = list(md.get("content_history", []))
                history.append({"version": version_label, "content": product.content})
                md["content_history"] = history
                product.meta_data = md
            product.content = content
            await session.commit()


# ============================================================
# AI分析与优化
# ============================================================

async def analyze_outline(outline_data: dict, provider: str = "gemini") -> dict:
    """分析大纲质量
    
    Returns:
        {
            "decision": "repairable" | "fatal",
            "analysis": "详细分析文本",
            "raw_response": "原始LLM响应"
        }
    """
    outline_json = json.dumps(outline_data, ensure_ascii=False, indent=2)
    
    prompt = f"""你是专业短剧策划,分析以下大纲能否通过优化后使用。

大纲:
{outline_json}

判断标准:
- 致命硬伤(人物逻辑崩溃/时间线矛盾/核心冲突缺失) → 不可修复
- 一般问题(节奏单调/人物单薄/情节老套) → 可修复

按以下格式回答:

【判定结果】可修复 / 不可修复

【分析说明】
(详细说明问题)

【优化建议】
(如可修复,说明如何优化;如不可修复,说明致命问题)"""
    
    try:
        async def _call():
            llm = get_llm(role="extract", temperature=0.3, provider=provider, max_tokens=4000)
            response = await llm.ainvoke(prompt)
            return response.content
        content = await retry_async(_call, label="analyze_outline")
        
        # 匹配判定结果: 取【判定结果】后50字符窗口,兼容markdown加粗/换行
        # 注意"不可修复"包含"可修复"子串,必须先判fatal
        window = content.split("【判定结果】")[1][:50] if "【判定结果】" in content else ""
        if "不可修复" in window:
            decision = "fatal"
        elif "可修复" in window:
            decision = "repairable"
        else:
            logger.warning(f"Cannot parse decision, default fatal. Response: {content[:200]}")
            decision = "fatal"
        
        return {
            "decision": decision,
            "analysis": content,
            "raw_response": content
        }
    except Exception as e:
        # 重试仍失败(网络/服务偶发故障) → 按"可修复"放行,避免好大纲被系统性错误冤杀
        # (真正的质量问题会在二轮质检再次把关)
        logger.error(f"Failed to analyze outline after retries: {e}", exc_info=True)
        return {
            "decision": "repairable",
            "analysis": f"质检调用失败(已按可修复放行): {str(e)}",
            "raw_response": ""
        }


async def optimize_outline(outline_data: dict, analysis: str, provider: str = "gemini") -> dict:
    """优化大纲
    
    Returns:
        优化后的outline_data (dict)
    """
    outline_json = json.dumps(outline_data, ensure_ascii=False, indent=2)
    
    prompt = f"""你是专业短剧策划,根据优化建议改进大纲。

原大纲:
{outline_json}

优化建议:
{analysis}

要求:
1. 保留原故事核心设定和主要人物
2. 针对性解决建议中的问题
3. 不引入新逻辑矛盾
4. **分集数量必须与原大纲完全一致,严禁删减或合并任何分集**(只允许改写各集内容)
5. 直接输出优化后的完整大纲JSON,不要任何说明文字
6. 输出格式必须为: ```json ... ```"""
    
    try:
        async def _call():
            llm = get_llm(role="rewrite", temperature=0.7, provider=provider, max_tokens=12000)
            response = await llm.ainvoke(prompt)
            return response.content
        resp_content = await retry_async(_call, label="optimize_outline")
        
        # 多策略提取JSON
        json_str = None
        import re as _re
        m = _re.search(r'```json\s*\n(.*?)\n```', resp_content, _re.DOTALL)
        if m:
            json_str = m.group(1).strip()
        if not json_str:
            m = _re.search(r'```\s*\n(\{.*?\})\s*\n```', resp_content, _re.DOTALL)
            if m:
                json_str = m.group(1).strip()
        if not json_str:
            first = resp_content.find('{')
            last = resp_content.rfind('}')
            if first != -1 and last != -1 and last > first:
                json_str = resp_content[first:last + 1]
        if not json_str:
            logger.warning(f"No JSON in optimize response, keeping original. preview: {resp_content[:150]}")
            return outline_data
        
        optimized_data = json.loads(json_str)
        return optimized_data
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse optimized JSON: {e}\nResponse: {resp_content[:300]}")
        return outline_data
    except Exception as e:
        logger.error(f"Failed to optimize outline: {e}", exc_info=True)
        return outline_data


# ============================================================
# 统计数据
# ============================================================

def init_stats() -> dict:
    """初始化统计数据"""
    return {
        "outline_stats": {
            "total_generated": 0,
            "repairable": 0,
            "fatal": 0,
            "success_rate": 0.0
        },
        "optimization_stats": {
            "round_1_success": 0,
            "round_2_success": 0,
            "optimization_success_rate": 0.0
        },
        "final_stats": {
            "scripts_started": 0,
            "scripts_completed": 0,
            "script_success_rate": 0.0
        },
        # 创意发散记录(题材去重追溯)
        "concept_stats": {
            "rounds": []
        },
        "refill_rounds": 0
    }


async def get_job_script_titles(job_id: int) -> list:
    """取该任务已产出的剧本标题(供创意发散去重)"""
    async for session in get_async_session():
        result = await session.execute(
            select(FactoryProduct).where(
                FactoryProduct.job_id == job_id,
                FactoryProduct.product_type == "script"
            )
        )
        return [p.title for p in result.scalars().all() if p.title]
    return []


async def ensure_outline_chapters(outline_data: dict, target_episodes: int, provider: str = "gemini") -> dict:
    """确保大纲分集数达到目标集数。

    大纲管线偶发生成不足目标集数(如目标50实际只有40),
    此处调用LLM续写缺失的分集大纲并追加,最多重试2次。
    超出目标集数时截断到目标数。
    """
    chapters = [c for c in (outline_data.get("chapters") or []) if isinstance(c, dict)]
    if not target_episodes:
        return outline_data

    def _missing_orders() -> list:
        """计算1..target中缺失的集数序号(可能缺在中间,不只是末尾)"""
        existing = {int(c.get("order")) for c in chapters if c.get("order") is not None}
        return [o for o in range(1, target_episodes + 1) if o not in existing]

    attempts = 0
    while _missing_orders() and attempts < 2:
        attempts += 1
        missing = _missing_orders()
        outline_json = json.dumps(outline_data, ensure_ascii=False)
        missing_str = "、".join(f"第{o}集" for o in missing[:30])
        prompt = f"""你是专业短剧策划。以下大纲的分集缺失了 {missing_str}（全剧共{target_episodes}集）。

大纲:
{outline_json}

请补写这些缺失的分集大纲，要求:
1. 与前后已有分集剧情自然衔接（缺失集的前一集和后一集内容都在上面大纲里）
2. 每集字段与已有分集完全一致: order(集数序号,必须使用上述缺失的序号)、title(标题)、
   synopsis(该集剧情概要,120字以上)、must_have(本集必备情节点数组)、characters(本集出场人物数组)
3. 只输出JSON数组，格式: ```json
[{{"order": {missing[0]}, "title": "...", "synopsis": "...", "must_have": ["..."], "characters": ["..."]}}, ...]
```"""
        try:
            async def _call(p: str):
                llm = get_llm(role="rewrite", temperature=0.7, provider=p, max_tokens=12000)
                response = await llm.ainvoke(prompt)
                return response.content
            # gemini重试 → 内容拦截/配额类失败切qwen(否则扩展静默失败,补缺会停在缺集状态)
            try:
                text = await retry_async(lambda: _call(provider), label="ensure_chapters")
            except Exception as e1:
                logger.warning(f"ensure_outline_chapters: {provider} failed({e1}), fallback to qwen")
                text = await retry_async(lambda: _call("qwen"), label="ensure_chapters-qwen")
            m = re.search(r'```json\s*(.*?)```', text, re.DOTALL)
            json_str = m.group(1).strip() if m else None
            if not json_str:
                first = text.find('[')
                last = text.rfind(']')
                if first != -1 and last > first:
                    json_str = text[first:last + 1]
            if not json_str:
                logger.warning(f"ensure_outline_chapters: no JSON in response (attempt {attempts})")
                continue
            new_chapters = json.loads(json_str)
            if isinstance(new_chapters, dict):
                new_chapters = new_chapters.get("chapters") or []
            for i, ch in enumerate(new_chapters):
                if isinstance(ch, dict) and not ch.get("order"):
                    # 🔴 2026-10-09 修：这里原写作 `start_from + i`，而 `start_from`
                    # **从未定义过** —— 抛 NameError 后被下方 `except Exception`
                    # 吞掉，表现为"补写缺失集"整段静默失败（只留一条 warning）。
                    # 本循环上方已经算出 `missing`（要补的集号列表），且提示词里
                    # 明确要求模型用这些序号，所以缺号时按 missing 顺延才对。
                    ch["order"] = missing[0] + i
            # 合并去重(按order),排序
            seen: dict = {}
            for c in chapters + [c for c in new_chapters if isinstance(c, dict)]:
                o = c.get("order")
                if o is not None and o not in seen:
                    seen[o] = c
            chapters = [seen[o] for o in sorted(seen)]
            logger.info(f"ensure_outline_chapters: extended to {len(chapters)}/{target_episodes} (attempt {attempts})")
        except Exception as e:
            logger.warning(f"ensure_outline_chapters attempt {attempts} failed: {e}")

    if len(chapters) > target_episodes:
        chapters = chapters[:target_episodes]
    if chapters:
        outline_data["chapters"] = chapters
    return outline_data


async def brainstorm_concepts(
    count: int,
    theme: str,
    avoid_titles: Optional[list] = None,
    provider: str = "gemini"
) -> list:
    """创意发散: 一次LLM调用批量生成count个强制差异化的短剧创意企划。

    解决同一任务多剧本题材趋同问题——每条流水线不再各自用同一句
    提示词生成大纲(会收敛到相似创意),而是先统一发散出彼此不同的
    题材/世界观/主角/冲突,再分配给各流水线。

    Returns:
        [{"genre": "...", "premise": "...", "protagonist": "...", "conflict": "...", "hook": "..."}, ...]
        失败时返回空列表(调用方降级为旧行为)
    """
    theme_line = f"用户指定主题方向: {theme}" if theme and theme != "随机" else "主题不限,自由发挥"
    avoid_block = ""
    if avoid_titles:
        # 取最近60条(跨批去重清单可能很长,截断防提示词爆炸;最近的最重要)
        recent = avoid_titles[-60:]
        avoid_block = "\n已产出/已立项的作品(新创意必须与它们题材/设定明显不同):\n" + "\n".join(
            f"- {t}" for t in recent
        )

    prompt = f"""你是资深短剧内容策划总监,负责为一批短剧立项。请一次性提出{count}个**彼此差异极大**的短剧创意企划。

{theme_line}{avoid_block}

硬性要求:
1. {count}个创意必须覆盖**不同题材类型**(例如: 都市复仇、古装宫斗、悬疑刑侦、乡村温情、职场逆袭、奇幻脑洞、婚恋情感、年代创业、体育竞技、医疗行业等),同一题材最多出现1次
2. 主角设定必须各不相同: 性别、年龄段、职业、社会阶层都要拉开差距,禁止全是"豪门+复仇+假身份"套路
3. 核心冲突类型互不重复(如: 复仇 vs 救赎 vs 成长 vs 悬案 vs 家庭矛盾 vs 生存危机)
4. 每个创意都要有强钩子(前3集能抓住观众的爆点)

输出JSON数组,每项包含:
- genre: 题材类型(4-6字)
- premise: 一句话故事前提(50字内)
- protagonist: 主角设定(30字内,含性别/年龄/职业)
- conflict: 核心冲突(30字内)
- hook: 开篇钩子(40字内)

只输出JSON,格式:
```json
[{{"genre": "...", "premise": "...", "protagonist": "...", "conflict": "...", "hook": "..."}}]
```"""

    try:
        async def _call():
            llm = get_llm(role="rewrite", temperature=1.0, provider=provider, max_tokens=8000)
            response = await llm.ainvoke(prompt)
            return response.content
        text = await retry_async(_call, label="brainstorm")
        m = re.search(r'```json\s*(.*?)```', text, re.DOTALL)
        json_str = m.group(1).strip() if m else None
        if not json_str:
            first = text.find('[')
            last = text.rfind(']')
            if first != -1 and last > first:
                json_str = text[first:last + 1]
        if not json_str:
            logger.warning("brainstorm_concepts: no JSON in response")
            return []
        concepts = json.loads(json_str)
        if not isinstance(concepts, list):
            return []
        concepts = [c for c in concepts if isinstance(c, dict) and c.get("premise")]
        logger.info(f"brainstorm_concepts: generated {len(concepts)} concepts: {[c.get('genre') for c in concepts]}")
        return concepts
    except Exception as e:
        logger.error(f"brainstorm_concepts failed: {e}", exc_info=True)
        return []


def concept_to_user_input(concept: dict, theme: str) -> str:
    """把创意企划转成大纲生成的输入提示"""
    parts = []
    if concept.get("genre"):
        parts.append(f"题材类型: {concept['genre']}")
    if concept.get("premise"):
        parts.append(f"故事前提: {concept['premise']}")
    if concept.get("protagonist"):
        parts.append(f"主角设定: {concept['protagonist']}")
    if concept.get("conflict"):
        parts.append(f"核心冲突: {concept['conflict']}")
    if concept.get("hook"):
        parts.append(f"开篇钩子: {concept['hook']}")
    if parts:
        return "根据以下创意企划创作短剧故事:\n" + "\n".join(parts)
    return f"{theme or '现代都市爱情'}的短剧故事"


# ============================================================
# 流式流水线 - 核心创新
# ============================================================

async def outline_to_script_pipeline(
    job_id: int,
    config: dict,
    user_id: int,
    index: int,
    refill_round: int,
    stats: dict,
    concept: Optional[dict] = None,
    pipeline_attempt: int = 1
) -> Optional[int]:
    """单个大纲的完整流水线: 生成 → 双轮质检优化 → 剧本生成
    
    Args:
        concept: 创意发散阶段分配的差异化企划(genre/premise/protagonist/conflict/hook),
                 为None时降级为旧行为(用theme直接生成)
        pipeline_attempt: 流水线级重试计数(内部使用,失败时整条重跑一次)
    
    Returns:
        script_product_id if successful, None if rejected
    """
    try:
        # 阶段1: 生成大纲(基于分配的差异化创意企划)
        theme = config.get("theme") or "现代都市爱情"
        user_input = concept_to_user_input(concept or {}, theme)
        genre_tag = (concept or {}).get("genre") or ""
        from .usage import set_usage_stage as _sus
        _sus("outline")
        await update_job_status_message(job_id, f"[{index+1}] 正在生成大纲{f'({genre_tag})' if genre_tag else ''}...")
        async def _gen_outline():
            return await generate_outline(
                user_input=user_input,
                chapter_count=config["episodes"],
                chapter_word_target=config["words_per_chapter"],
                provider=stage_provider(config, "outline")
            )
        outline_data = await retry_async(_gen_outline, label=f"outline(job{job_id}#{index})")
        
        # 集数保险: 大纲分集不足目标数时自动续写补足
        outline_data = await ensure_outline_chapters(
            outline_data, int(config.get("episodes") or 0), provider=stage_provider(config, "check")
        )
        
        outline_id = await create_product(
            job_id=job_id,
            user_id=user_id,
            product_type="outline",
            title=outline_data.get("title", f"大纲-R{refill_round}-{index}"),
            content=json.dumps(outline_data, ensure_ascii=False),
            status="generated",
            meta_data={"refill_round": refill_round, "index": index, "concept": concept or {}}
        )
        
        stats["outline_stats"]["total_generated"] += 1
        logger.info(f"[Job {job_id}] Generated outline {outline_id}: {outline_data.get('title')}")
        
        # 阶段2: 质检v1
        _sus("check")
        analysis_v1 = await analyze_outline(outline_data, provider=stage_provider(config, "check"))
        await update_product_status(outline_id, "analyzed_v1", {"analysis_v1": analysis_v1})
        
        if analysis_v1["decision"] == "fatal":
            stats["outline_stats"]["fatal"] += 1
            await update_product_status(outline_id, "rejected_fatal")
            logger.info(f"[Job {job_id}] Outline {outline_id} rejected at v1")
            return None
        
        stats["outline_stats"]["repairable"] += 1
        
        # 阶段3: 优化v1
        await update_product_status(outline_id, "repairable_pending")
        outline_data = await optimize_outline(
            outline_data,
            analysis_v1["analysis"],
            provider=stage_provider(config, "check")
        )
        # 优化可能缩水分集(LLM擅自精简),立即补足回目标集数
        outline_data = await ensure_outline_chapters(
            outline_data, int(config.get("episodes") or 0), provider=stage_provider(config, "check")
        )
        await update_product_content(outline_id, json.dumps(outline_data, ensure_ascii=False), version_label="初始版本")
        await update_product_status(outline_id, "optimized_v1")
        stats["optimization_stats"]["round_1_success"] += 1
        logger.info(f"[Job {job_id}] Outline {outline_id} optimized v1")
        
        # 阶段4: 质检v2
        analysis_v2 = await analyze_outline(outline_data, provider=stage_provider(config, "check"))
        await update_product_status(outline_id, "analyzed_v2", {"analysis_v2": analysis_v2})
        
        if analysis_v2["decision"] == "fatal":
            await update_product_status(outline_id, "rejected_fatal_v2")
            logger.info(f"[Job {job_id}] Outline {outline_id} rejected at v2")
            return None
        
        # 阶段5: 优化v2
        await update_product_status(outline_id, "repairable_pending_v2")
        outline_data = await optimize_outline(
            outline_data,
            analysis_v2["analysis"],
            provider=stage_provider(config, "check")
        )
        # 优化可能缩水分集,进入剧本生成前必须补足到目标集数(最终保险)
        outline_data = await ensure_outline_chapters(
            outline_data, int(config.get("episodes") or 0), provider=stage_provider(config, "check")
        )
        await update_product_content(outline_id, json.dumps(outline_data, ensure_ascii=False), version_label="一轮优化版")
        await update_product_status(outline_id, "ready_for_script")
        stats["optimization_stats"]["round_2_success"] += 1
        logger.info(f"[Job {job_id}] Outline {outline_id} ready for script")
        
        # 阶段6: 立即生成剧本(流式处理关键点)
        # 剧本启动闸门: 已启动的剧本数达到目标时,多余大纲标记为spare备用,不再生成剧本
        target_count = int(config.get("total_scripts") or 0)
        if target_count and stats["final_stats"]["scripts_started"] >= target_count:
            await update_product_status(outline_id, "spare")
            logger.info(f"[Job {job_id}] Outline {outline_id} marked spare (target {target_count} reached)")
            return None
        stats["final_stats"]["scripts_started"] += 1
        _sus("script")
        await update_job_status_message(job_id, f"[{index+1}] 大纲通过质检，开始生成剧本...")
        script_id = await generate_full_script(
            job_id=job_id,
            user_id=user_id,
            outline_id=outline_id,
            outline_data=outline_data,
            config=config
        )
        
        stats["final_stats"]["scripts_completed"] += 1
        logger.info(f"[Job {job_id}] Script {script_id} completed for outline {outline_id}")
        
        return script_id
    
    except Exception as e:
        logger.error(f"[Job {job_id}] Pipeline failed for index {index} (attempt {pipeline_attempt}): {e}", exc_info=True)
        # 流水线级重试: 整条流水线失败(如大纲生成重试耗尽)时重跑一次,
        # 换一次LLM采样往往就能成功; 只重试1次避免无限循环浪费成本
        if pipeline_attempt < 2:
            await asyncio.sleep(LLM_RETRY_BASE_DELAY * 2)
            logger.info(f"[Job {job_id}] Retrying whole pipeline for index {index}")
            return await outline_to_script_pipeline(
                job_id=job_id,
                config=config,
                user_id=user_id,
                index=index,
                refill_round=refill_round,
                stats=stats,
                concept=concept,
                pipeline_attempt=pipeline_attempt + 1
            )
        return None


async def generate_full_script(
    job_id: int,
    user_id: int,
    outline_id: int,
    outline_data: dict,
    config: dict
) -> int:
    """生成完整剧本(所有集数) — 边生成边写入,每集完成立即可见"""
    chapters = outline_data.get("chapters", [])
    if not chapters:
        raise ValueError(f"Outline {outline_id} has no chapters")

    # 先创建 generating 状态的剧本产物,让前端立即能看到
    script_id = await create_product(
        job_id=job_id,
        user_id=user_id,
        product_type="script",
        title=outline_data.get("title", "剧本"),
        content=json.dumps({"chapters": [], "generating": True}, ensure_ascii=False),
        status="generating",
        meta_data={
            "episodes": len(chapters),
            "words": 0,
            "outline_id": outline_id,
            "completed_episodes": 0
        },
        parent_id=outline_id
    )

    full_script_chapters = []
    prev_chapters = []
    failed_orders: list = []

    for chapter_meta in chapters:
        chapter_order = chapter_meta.get("order", 1)

        # 单集剧本生成(主平台同步的大纲直生剧本框架); 内容拦截自动切qwen;
        # 仍失败则跳过该集(缺集可用"补缺集数"功能补齐)
        _prev_script = (
            full_script_chapters[-1].get("content", "") if full_script_chapters else ""
        )
        try:
            chapter_text = await generate_episode_script_resilient(
                outline_data=outline_data,
                chapter_meta=chapter_meta,
                label=f"chapter{chapter_order}(script{script_id})",
                primary_provider=stage_provider(config, "script"),
                prev_script_text=_prev_script,
            )
        except Exception as e:
            failed_orders.append(chapter_order)
            logger.error(f"[Job {job_id}] Chapter {chapter_order} failed after retries (script_id={script_id}), skipping: {e}")
            await update_product_status(script_id, "generating", {
                "failed_episodes": failed_orders,
            })
            continue

        chapter_dict = {
            "order": chapter_order,
            "title": chapter_meta.get("title", f"第{chapter_order}集"),
            "content": chapter_text,
            "word_count": len(chapter_text)
        }
        full_script_chapters.append(chapter_dict)
        # chapter_gen期望的rolling memory格式: chapter_order/full_text/summary
        # content字段用于DB存储; full_text/chapter_order用于chapter_gen的滚动记忆
        prev_chapters.append({
            "chapter_order": chapter_order,
            "title": chapter_meta.get("title", f"第{chapter_order}集"),
            "full_text": chapter_text,    # chapter_gen用于末尾300字衔接
            "summary": "",               # 暂不生成摘要,chapter_gen会显示"暂无摘要"
        })

        # 每集完成后立即更新,让前端实时查看
        total_words_so_far = sum(c["word_count"] for c in full_script_chapters)
        await update_product_content(
            script_id,
            json.dumps({"chapters": full_script_chapters, "generating": True}, ensure_ascii=False)
        )
        await update_product_status(script_id, "generating", {
            "completed_episodes": len(full_script_chapters),
            "words": total_words_so_far,
            "outline_id": outline_id,
            "episodes": len(chapters)
        })

        await update_job_status_message(job_id, f"第{chapter_order}/{len(chapters)}集生成完成 ({total_words_so_far}字)")
        logger.info(f"[Job {job_id}] Chapter {chapter_order}/{len(chapters)} done (script_id={script_id})")

    total_words = sum(c["word_count"] for c in full_script_chapters)

    # 所有集处理完,标记为 completed
    # episodes 保持大纲总集数(而非实际生成数): 有跳过的失败集时前端才能显示"缺集"警示并提供补缺入口
    await update_product_content(
        script_id,
        json.dumps({"chapters": full_script_chapters}, ensure_ascii=False)
    )
    final_meta = {
        "episodes": len(chapters),
        "words": total_words,
        "outline_id": outline_id,
        "completed_episodes": len(full_script_chapters)
    }
    if failed_orders:
        final_meta["failed_episodes"] = failed_orders
        logger.warning(f"[Job {job_id}] Script {script_id} completed with {len(failed_orders)} missing episodes: {failed_orders}")
    await update_product_status(script_id, "completed", final_meta)

    # 大纲状态回写: 剧本已完成,大纲生命周期结束 → completed
    # (否则大纲永远停在 ready_for_script,前端显示"剧本生成中")
    await update_product_status(outline_id, "completed")

    return script_id


async def refill_script_episodes(script_id: int, job_id: int, config: dict):
    """为缺集的剧本补齐缺失集数。

    对照 parent 大纲的分集列表,找出剧本中缺失的 order,
    逐集调用 generate_chapter 补生成并插入到正确位置。
    """
    async for session in get_async_session():
        result = await session.execute(
            select(FactoryProduct).where(FactoryProduct.id == script_id)
        )
        script = result.scalar_one_or_none()
        break
    if not script:
        logger.warning(f"refill_script_episodes: script {script_id} not found")
        return

    outline_id = (script.meta_data or {}).get("outline_id") or script.parent_id
    if not outline_id:
        logger.warning(f"refill_script_episodes: script {script_id} has no outline")
        return

    async for session in get_async_session():
        result = await session.execute(
            select(FactoryProduct).where(FactoryProduct.id == outline_id)
        )
        outline = result.scalar_one_or_none()
        break
    if not outline or not outline.content:
        logger.warning(f"refill_script_episodes: outline {outline_id} missing")
        return

    try:
        outline_data = json.loads(outline.content)
        script_data = json.loads(script.content or "{}")
    except json.JSONDecodeError as e:
        logger.error(f"refill_script_episodes: bad JSON for script {script_id}: {e}")
        return

    target_episodes = int(config.get("episodes") or 0)
    # 大纲分集也可能不足目标数,先补大纲
    if target_episodes:
        outline_data = await ensure_outline_chapters(outline_data, target_episodes, provider=stage_provider(config, "check"))
        await update_product_content(outline_id, json.dumps(outline_data, ensure_ascii=False))

    outline_chapters = outline_data.get("chapters") or []
    existing = {c.get("order") for c in (script_data.get("chapters") or [])}
    missing = [c for c in outline_chapters if c.get("order") not in existing]
    if not missing:
        logger.info(f"refill_script_episodes: script {script_id} has no missing episodes")
        await update_product_status(script_id, "completed")
        return

    logger.info(f"refill_script_episodes: script {script_id} missing {len(missing)} episodes: {[c.get('order') for c in missing]}")
    await update_product_status(script_id, "generating")
    await update_job_status_message(job_id, f"《{script.title}》开始补缺 {len(missing)} 集...")

    chapters_list = list(script_data.get("chapters") or [])

    for ch_meta in sorted(missing, key=lambda c: c.get("order") or 0):
        order = ch_meta.get("order")
        try:
            chapter_text = await generate_episode_script_resilient(
                outline_data=outline_data,
                chapter_meta=ch_meta,
                label=f"refill-ch{order}(script{script_id})",
                primary_provider=stage_provider(config, "script"),
            )
            chapters_list.append({
                "order": order,
                "title": ch_meta.get("title", f"第{order}集"),
                "content": chapter_text,
                "word_count": len(chapter_text)
            })
            chapters_list.sort(key=lambda c: c.get("order") or 0)
            total_words = sum(c.get("word_count", 0) for c in chapters_list)
            await update_product_content(
                script_id,
                json.dumps({"chapters": chapters_list, "generating": True}, ensure_ascii=False)
            )
            await update_product_status(script_id, "generating", {
                "completed_episodes": len(chapters_list),
                "words": total_words,
                "episodes": max(len(outline_chapters), target_episodes or 0),
            })
            await update_job_status_message(job_id, f"《{script.title}》补缺第{order}集完成")
            logger.info(f"refill_script_episodes: script {script_id} episode {order} done")
        except Exception as e:
            logger.error(f"refill_script_episodes: episode {order} failed for script {script_id}: {e}", exc_info=True)

    total_words = sum(c.get("word_count", 0) for c in chapters_list)
    await update_product_content(script_id, json.dumps({"chapters": chapters_list}, ensure_ascii=False))
    await update_product_status(script_id, "completed", {
        "completed_episodes": len(chapters_list),
        "words": total_words,
        "episodes": max(len(outline_chapters), target_episodes or 0),
    })
    await update_product_status(outline_id, "completed")
    await update_job_status_message(job_id, f"《{script.title}》补缺完成,共{len(chapters_list)}集")
    logger.info(f"refill_script_episodes: script {script_id} refilled to {len(chapters_list)} episodes")


# ============================================================
# 恢复卡住的大纲(服务重启后BackgroundTask丢失场景)
# ============================================================

async def resume_stuck_outlines(job_id: int, outline_ids: list, config: dict, user_id: int):
    """为卡在ready_for_script的大纲重启剧本生成
    
    场景: 服务重启导致原BackgroundTask丢失,大纲已通过质检但剧本未生成
    """
    logger.info(f"[Job {job_id}] Resume: generating scripts for outlines {outline_ids}")
    
    completed = 0
    for outline_id in outline_ids:
        try:
            # 读取大纲内容
            async for session in get_async_session():
                result = await session.execute(
                    select(FactoryProduct).where(FactoryProduct.id == outline_id)
                )
                outline = result.scalar_one_or_none()
                break
            
            if not outline or not outline.content:
                logger.warning(f"[Job {job_id}] Resume: outline {outline_id} not found or empty")
                continue
            
            outline_data = json.loads(outline.content)
            
            # 生成剧本(复用现有逻辑)
            script_id = await generate_full_script(
                job_id=job_id,
                user_id=user_id,
                outline_id=outline_id,
                outline_data=outline_data,
                config=config
            )
            completed += 1
            logger.info(f"[Job {job_id}] Resume: script {script_id} done for outline {outline_id}")
        
        except Exception as e:
            logger.error(f"[Job {job_id}] Resume failed for outline {outline_id}: {e}", exc_info=True)
    
    # 更新job状态: 如果完成数达到目标则标记completed
    target = config.get("total_scripts", 0)
    async for session in get_async_session():
        result = await session.execute(
            select(FactoryProduct).where(
                FactoryProduct.job_id == job_id,
                FactoryProduct.product_type == "script",
                FactoryProduct.status == "completed"
            )
        )
        total_scripts = len(result.scalars().all())
        break
    
    if total_scripts >= target:
        await update_job_status(job_id, "completed")
        await update_job_progress(job_id, 100)
        logger.info(f"[Job {job_id}] Resume: job completed with {total_scripts} scripts")
    
    logger.info(f"[Job {job_id}] Resume finished: {completed}/{len(outline_ids)} scripts generated")


# ============================================================
# 主流程
# ============================================================

async def run_create_spawn_job(job_id: int, config: dict, user_id: int):
    """从零创作主流程 - V4流式版
    
    config: {
        "theme": str,  # 可选
        "total_scripts": int,
        "episodes": int,
        "words_per_chapter": int
    }
    """
    from .usage import set_usage_context
    set_usage_context(job_id, user_id)

    target_count = config["total_scripts"]
    completed_scripts = 0
    refill_round = 0
    stats = init_stats()
    produced_titles: list = []  # 已产出剧本标题(供补货轮创意发散去重)
    
    logger.info(f"[Job {job_id}] Starting V4 create_spawn, target={target_count}")
    
    try:
        await update_job_status(job_id, "running")
        await update_job_status_message(job_id, "任务启动中，开始批量生成...")
        await update_job_progress(job_id, 5)
        
        # 持续循环直到完成目标数量
        while completed_scripts < target_count:
            # 检查手动停止
            if await check_manual_stop(job_id):
                logger.info(f"[Job {job_id}] Manual stop detected")
                await update_job_status(job_id, "stopped")
                await update_job_result(job_id, stats)
                return
            
            # 计算本轮需生成的大纲数(大目标降低缓冲比例省成本,反正有剧本闸门+补货轮兜底)
            if refill_round == 0:
                buffer_ratio = 1.5 if target_count <= 20 else 1.2
                to_generate = max(1, int(target_count * buffer_ratio))
            else:
                shortage = target_count - completed_scripts
                to_generate = max(1, int(shortage * 1.3))
            
            logger.info(f"[Job {job_id}] Round {refill_round}: generating {to_generate} outlines")
            
            # 创意发散(分批): 每批最多BRAINSTORM_BATCH_SIZE个创意,保证单批质量;
            # 跨批携带已用"题材·前提"清单去重; 每批就绪立即启动该批流水线(发散与生产交错并行);
            # 不限并发(渠道与服务器可支撑),偶发失败由各环节的自动重试兜底

            # 跨批去重清单: 已产出剧本标题 + 本轮已发散创意的"题材·前提"
            avoid_list: list = list(produced_titles)
            tasks = []
            launched = 0
            batch_no = 0
            total_batches = (to_generate + BRAINSTORM_BATCH_SIZE - 1) // BRAINSTORM_BATCH_SIZE

            while launched < to_generate:
                if await check_manual_stop(job_id):
                    break
                batch_no += 1
                batch_count = min(BRAINSTORM_BATCH_SIZE, to_generate - launched)
                await update_job_status_message(
                    job_id,
                    f"创意发散 第{batch_no}/{total_batches}批({batch_count}个)..."
                    + (f" 已启动{launched}条流水线" if launched else "")
                )
                from .usage import set_usage_stage as _sus
                _sus("brainstorm")
                concepts = await brainstorm_concepts(
                    count=batch_count,
                    theme=config.get("theme") or "",
                    avoid_titles=avoid_list if avoid_list else None,
                    provider=stage_provider(config, "brainstorm")
                )
                if concepts:
                    stats["concept_stats"]["rounds"].append({
                        "round": refill_round,
                        "batch": batch_no,
                        "requested": batch_count,
                        "generated": len(concepts),
                        "genres": [c.get("genre") for c in concepts],
                    })
                    await update_job_result(job_id, stats)
                    # 把本批创意计入跨批去重清单
                    for c in concepts:
                        tag = f"{c.get('genre', '')}·{c.get('premise', '')}"[:60]
                        if tag.strip("·"):
                            avoid_list.append(tag)
                    logger.info(f"[Job {job_id}] Round {refill_round} batch {batch_no} concepts: {[c.get('genre') for c in concepts]}")
                else:
                    logger.warning(f"[Job {job_id}] Round {refill_round} batch {batch_no}: brainstorm failed, fallback to theme-only generation")

                # 本批创意就绪 → 立即启动对应流水线(不等后续批次发散,全并发)
                for i in range(batch_count):
                    task = asyncio.ensure_future(outline_to_script_pipeline(
                        job_id=job_id,
                        config=config,
                        user_id=user_id,
                        index=launched + i,
                        refill_round=refill_round,
                        stats=stats,
                        concept=concepts[i] if i < len(concepts) else None
                    ))
                    tasks.append(task)
                launched += batch_count
            
            # 等待本批次完成
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            # 统计本轮成功的剧本数
            successful = [r for r in results if r and not isinstance(r, Exception)]
            completed_scripts += len(successful)
            
            # 收集已产出标题,供下一轮创意发散去重
            produced_titles = await get_job_script_titles(job_id)
            
            logger.info(f"[Job {job_id}] Round {refill_round} completed: {len(successful)} scripts, total {completed_scripts}/{target_count}")
            
            # 更新进度
            progress = int((completed_scripts / target_count) * 95)
            await update_job_progress(job_id, min(progress, 99))
            
            # 更新统计
            if stats["outline_stats"]["total_generated"] > 0:
                stats["outline_stats"]["success_rate"] = (
                    stats["outline_stats"]["repairable"] / stats["outline_stats"]["total_generated"]
                )
            
            total_repairable = stats["outline_stats"]["repairable"]
            if total_repairable > 0:
                stats["optimization_stats"]["optimization_success_rate"] = (
                    (stats["optimization_stats"]["round_1_success"] + 
                     stats["optimization_stats"]["round_2_success"]) / total_repairable
                )
            
            if target_count > 0:
                stats["final_stats"]["script_success_rate"] = completed_scripts / target_count
            
            stats["refill_rounds"] = refill_round
            await update_job_result(job_id, stats)
            
            refill_round += 1
        
        # 完成
        await update_job_status(job_id, "completed")
        await update_job_progress(job_id, 100)
        await update_job_result(job_id, stats)
        
        logger.info(f"[Job {job_id}] Completed: {completed_scripts} scripts generated")
    
    except Exception as e:
        logger.error(f"[Job {job_id}] Job failed: {e}", exc_info=True)
        await update_job_status(job_id, "failed")
        await update_job_result(job_id, {
            "error": str(e),
            "stats": stats
        })