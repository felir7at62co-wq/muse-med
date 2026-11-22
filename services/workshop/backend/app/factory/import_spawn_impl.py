"""
import_spawn任务实现: 导入剧本(飞书/文件/文本/工厂剧本) → 可选校验 → 裂变(小说/推文)

裂变使用主平台 adapt_products 的同一套提示词框架:
- 小说(novel): NOVEL_SYSTEM/NOVEL_USER — 铁律保剧情/人物/逻辑, 只增补画面/动作/神态
- 推文(tweet): TWEET_SYSTEM/TWEET_USER — 指定主角第一人称重写(先AI建议主角)
逐章串行生成保叙事连贯, 与主平台"章节改编"一致。
"""
import asyncio
import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from langchain_core.messages import SystemMessage, HumanMessage
from sqlalchemy import select

from ..db.session import get_session as get_async_session
from ..models.llm import get_llm
from ..adapt_products import prompts as AP
from .models import FactoryJob, FactoryProduct
from .create_spawn import (
    retry_async, _is_content_blocked,
    update_job_status, update_job_status_message, update_job_progress,
    create_product, update_product_status, update_product_content,
)

logger = logging.getLogger(__name__)

_PREV_TAIL = 600  # 上一章产物尾部衔接参考长度(与主平台一致)


def _strip_fence(text: str) -> str:
    t = re.sub(r"^```[a-zA-Z]*\s*", "", (text or "").strip())
    return re.sub(r"\s*```$", "", t).strip()


def _split_chapters(content: str) -> List[Tuple[str, str]]:
    """把导入内容切分成 [(标题, 正文)] 章节列表。

    优先级:
    1. 工厂剧本JSON({chapters:[{order,title,content}]})
    2. "第X集/第X章"标题行切分
    3. 整体按4000字定长切块
    """
    content = (content or "").strip()
    # 1) 工厂JSON
    try:
        data = json.loads(content)
        chapters = data.get("chapters") or []
        if chapters:
            return [
                (f"第{c.get('order', i+1)}集 {c.get('title', '')}".strip(), c.get("content", "") or "")
                for i, c in enumerate(chapters)
                if (c.get("content") or "").strip()
            ]
    except (json.JSONDecodeError, AttributeError):
        pass
    # 2) 第X集/章 标记切分
    pattern = re.compile(r"^\s*(?:——\s*)?(第\s*[0-9一二三四五六七八九十百]+\s*[集章][^\n]*)", re.M)
    matches = list(pattern.finditer(content))
    if len(matches) >= 2:
        out = []
        for i, m in enumerate(matches):
            start = m.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
            body = content[start:end].strip()
            if body:
                out.append((m.group(1).strip(), body))
        if out:
            return out
    # 3) 定长切块
    chunk = 4000
    return [
        (f"第{i+1}部分", content[i * chunk:(i + 1) * chunk])
        for i in range((len(content) + chunk - 1) // chunk)
    ]


def _word_params(word_target: int) -> dict:
    """与主平台 adapt_products 相同的字数约束算法"""
    return {
        "word_target": word_target,
        "word_min": int(word_target * 0.7),
        "word_max": int(word_target * 1.4),
    }


async def _llm_call_resilient(messages, label: str, temperature: float = 0.7, primary: str = "gemini", min_len: int = 50) -> str:
    """LLM调用: 主通道重试 → 内容拦截切备用通道。空输出视为失败触发重试。

    min_len: 最短有效输出(短JSON类任务如主角建议应调低, 否则合法输出被误判为空)
    """
    async def _call(provider: str) -> str:
        llm = get_llm(role="rewrite", temperature=temperature, provider=provider)
        resp = await llm.ainvoke(messages)
        text = _strip_fence(getattr(resp, "content", "") or "")
        if len(text.strip()) < min_len:
            raise RuntimeError(f"LLM returned empty/too-short output ({len(text)} chars)")
        return text
    try:
        return await retry_async(lambda: _call(primary), label=label)
    except Exception as e:
        if _is_content_blocked(e):
            fb = "qwen" if primary != "qwen" else "gemini"
            logger.warning(f"{label}: {primary} content-blocked, fallback to {fb}")
            return await retry_async(lambda: _call(fb), label=f"{label}-{fb}")
        raise


async def _suggest_protagonist(chapters: List[Tuple[str, str]]) -> str:
    """AI建议第一人称主角(主平台 SUGGEST_PROTAGONIST_PROMPT)"""
    sample = "\n\n".join(f"{t}\n{c[:1500]}" for t, c in chapters[:3])[:5000]
    try:
        text = await _llm_call_resilient(
            [HumanMessage(content=AP.SUGGEST_PROTAGONIST_PROMPT.format(sample=sample))],
            label="suggest-protagonist", temperature=0.2, min_len=8,
        )
        m = re.search(r'\{.*\}', text, re.DOTALL)
        if m:
            return (json.loads(m.group(0)).get("name") or "").strip() or "主角"
    except Exception as e:
        logger.warning(f"suggest_protagonist failed: {e}")
    return "主角"


async def _adapt_one_chapter(
    kind: str,
    chapter_text: str,
    protagonist: str,
    prev_out: Optional[str],
    word_target: int,
    label: str,
    primary: str = "gemini",
) -> str:
    """单章改编(主平台 NOVEL/TWEET 提示词框架)"""
    prev_hint = ""
    if prev_out:
        prev_hint = "【上一章改写结尾(仅供衔接语气, 不要重复其内容)】\n" + prev_out[-_PREV_TAIL:] + "\n\n"
    wp = _word_params(word_target)
    if kind == "novel":
        messages = [
            SystemMessage(content=AP.NOVEL_SYSTEM),
            HumanMessage(content=AP.NOVEL_USER.format(prev_hint=prev_hint, chapter=chapter_text, **wp)),
        ]
    else:
        messages = [
            SystemMessage(content=AP.TWEET_SYSTEM.format(protagonist=protagonist)),
            HumanMessage(content=AP.TWEET_USER.format(
                prev_hint=prev_hint, chapter=chapter_text, protagonist=protagonist, **wp)),
        ]
    return await _llm_call_resilient(messages, label=label, primary=primary)


async def _spawn_adaptation(
    job_id: int,
    user_id: int,
    kind: str,
    chapters: List[Tuple[str, str]],
    title: str,
    protagonist: str = "",
    source_label: str = "",
    source_product_id: Optional[int] = None,
    primary: str = "gemini",
) -> int:
    """逐章串行生成一部完整改编作品(小说/推文),边生成边写入。

    断点续跑: 若该job下同源同类产物已存在(服务重启恢复场景):
    - completed → 直接复用, 不重新生成
    - generating → 载入已完成章节, 从下一章继续
    """
    kind_label = "小说" if kind == "novel" else "推文"

    existing = None
    if source_product_id:
        async for session in get_async_session():
            existing = (await session.execute(
                select(FactoryProduct).where(
                    FactoryProduct.job_id == job_id,
                    FactoryProduct.product_type == kind,
                    FactoryProduct.parent_id == source_product_id,
                )
            )).scalars().first()
            break
    if existing is not None and existing.status == "completed":
        _md = existing.meta_data or {}
        if int(_md.get("completed_episodes") or 0) >= int(_md.get("episodes") or len(chapters)):
            logger.info(f"[Job {job_id}] {kind} p{existing.id} already completed, skip")
            return existing.id
        # 完成但有缺章 → 走下方续跑逻辑补缺
        logger.info(f"[Job {job_id}] {kind} p{existing.id} completed with missing chapters, repairing")

    out_chapters: list = []
    prev_out: Optional[str] = None
    done_orders: set = set()
    if existing is not None:
        product_id = existing.id
        # 断点续跑推文: 沿用原产物已定的主角, 避免中途换人称
        if kind == "tweet":
            protagonist = ((existing.meta_data or {}).get("protagonist") or protagonist or "").strip()
        try:
            data = json.loads(existing.content or "{}")
            out_chapters = [c for c in (data.get("chapters") or []) if (c.get("content") or "").strip()]
        except (json.JSONDecodeError, AttributeError):
            out_chapters = []
        # 按章节序号认领(避免中间缺章导致位置错位跳过)
        done_orders = {int(c.get("order") or 0) for c in out_chapters}
        if out_chapters:
            prev_out = max(out_chapters, key=lambda c: int(c.get("order") or 0))["content"]
        logger.info(f"[Job {job_id}] resume {kind} p{product_id}: {len(done_orders)}/{len(chapters)} chapters done")
    else:
        product_id = await create_product(
            job_id=job_id,
            user_id=user_id,
            product_type=kind,
            title=f"{title}({kind_label}版)",
            content=json.dumps({"chapters": [], "generating": True}, ensure_ascii=False),
            status="generating",
            meta_data={
                "episodes": len(chapters),
                "completed_episodes": 0,
                "words": 0,
                "kind": kind,
                # 裂变源头(前端显示"来源于: XXX")
                "source_label": source_label or title,
                **({"source_product_id": source_product_id} if source_product_id else {}),
                **({"protagonist": protagonist} if kind == "tweet" else {}),
            },
            parent_id=source_product_id,
        )

    failed: list = []

    async def _gen_chapter(i: int, ch_title: str, ch_text: str) -> bool:
        """生成第i章(0-based), 成功返回True"""
        nonlocal prev_out
        # 目标字数取原文长度(与主平台按草稿目标字数同思路,这里按原文自适应)
        word_target = max(600, min(len(ch_text), 5000))
        try:
            text = await _adapt_one_chapter(
                kind=kind,
                chapter_text=ch_text[:12000],
                protagonist=protagonist,
                prev_out=prev_out,
                word_target=word_target,
                label=f"{kind}-ch{i+1}(p{product_id})",
                primary=primary,
            )
            out_chapters.append({
                "order": i + 1,
                "title": ch_title,
                "content": text,
                "word_count": len(text),
            })
            prev_out = text
        except Exception as e:
            logger.error(f"[Job {job_id}] {kind} chapter {i+1} failed: {e}")
            return False

        out_chapters.sort(key=lambda c: int(c.get("order") or 0))
        total_words = sum(c["word_count"] for c in out_chapters)
        await update_product_content(
            product_id,
            json.dumps({"chapters": out_chapters, "generating": True}, ensure_ascii=False)
        )
        await update_product_status(product_id, "generating", {
            "completed_episodes": len(out_chapters),
            "words": total_words,
        })
        await update_job_status_message(job_id, f"{kind_label}改编 {len(out_chapters)}/{len(chapters)}章")
        return True

    for i, (ch_title, ch_text) in enumerate(chapters):
        if (i + 1) in done_orders:
            continue  # 断点续跑: 按章节序号跳过已有章节
        if not await _gen_chapter(i, ch_title, ch_text):
            failed.append(i + 1)

    # 缺章补跑一轮(首轮失败的章节各再试一次, 尽量交付满章)
    if failed:
        logger.info(f"[Job {job_id}] {kind} p{product_id} repair pass for chapters {failed}")
        still_failed = []
        for order in failed:
            ch_title, ch_text = chapters[order - 1]
            if not await _gen_chapter(order - 1, ch_title, ch_text):
                still_failed.append(order)
        failed = still_failed

    out_chapters.sort(key=lambda c: int(c.get("order") or 0))
    total_words = sum(c["word_count"] for c in out_chapters)
    await update_product_content(product_id, json.dumps({"chapters": out_chapters}, ensure_ascii=False))
    meta = {
        "completed_episodes": len(out_chapters),
        "words": total_words,
        "episodes": len(chapters),
    }
    if failed:
        meta["failed_episodes"] = failed
    # 有缺章时不标completed, 标partial便于筛查/续补
    final_status = "completed" if len(out_chapters) >= len(chapters) else "partial"
    await update_product_status(product_id, final_status, meta)
    logger.info(f"[Job {job_id}] {kind} adaptation done({final_status}): {len(out_chapters)}/{len(chapters)} chapters")
    return product_id


async def _import_content(import_source: Dict[str, Any], user_id: int) -> Tuple[str, str]:
    """从飞书/文件/文本/工厂剧本获取内容。返回 (标题, 内容)。"""
    source_type = import_source.get("type")

    if source_type == "feishu":
        # 真实飞书多维表格集成: 读指定文本字段,多行合并
        from ..feishu import client as feishu
        url = import_source.get("url", "")
        text_field = import_source.get("text_field_name") or "content"
        token, table_id = feishu.parse_bitable_ref(url)
        if not token or not table_id:
            raise ValueError("飞书链接无效: 需要含 ?table= 的多维表格链接")
        app_token = await feishu.resolve_app_token(token)
        records = await feishu.list_records(app_token, table_id)
        texts = []
        for r in records:
            fields = r.get("fields", {})
            cell = fields.get(text_field)
            t = feishu.cell_text(cell)
            if t:
                texts.append(t)
        if not texts:
            raise ValueError(f"飞书表格字段'{text_field}'下未读到任何文本内容")
        return ("飞书导入剧本", "\n\n".join(texts))

    elif source_type == "file":
        content = import_source.get("content", "")
        if not content:
            raise ValueError("文件内容为空")
        return (import_source.get("filename") or "上传剧本", content)

    elif source_type == "text":
        content = import_source.get("content", "")
        if not content:
            raise ValueError("文本内容为空")
        return ("粘贴剧本", content)

    elif source_type == "factory_script":
        # 从工厂已生成的剧本选取
        product_id = int(import_source.get("product_id") or 0)
        if not product_id:
            raise ValueError("未指定工厂剧本ID")
        async for session in get_async_session():
            result = await session.execute(
                select(FactoryProduct).where(
                    FactoryProduct.id == product_id,
                    FactoryProduct.user_id == user_id,
                    FactoryProduct.product_type == "script",
                )
            )
            p = result.scalar_one_or_none()
            break
        if not p or not p.content:
            raise ValueError(f"工厂剧本 {product_id} 不存在或内容为空")
        return (p.title or f"剧本{product_id}", p.content)

    else:
        raise ValueError(f"未知的导入类型: {source_type}")


async def run_import_spawn_job(job_id: int, config: dict, user_id: int) -> None:
    """执行 import_spawn 任务: 导入 → 裂变(小说/推文)

    config:
      - import_source: {type: feishu|file|text|factory_script, ...}
        多源批量: import_sources: [同上结构, ...] (批量选取工厂剧本时用)
      - spawn_config: {novel: {enabled,count}, tweet: {enabled,count}}
    """
    from .usage import set_usage_context
    set_usage_context(job_id, user_id)

    try:
        await update_job_status(job_id, "running")
        await update_job_status_message(job_id, "正在导入内容...")
        await update_job_progress(job_id, 5)

        # 支持单源与多源(批量选取工厂剧本)
        sources = config.get("import_sources")
        if not sources:
            sources = [config.get("import_source", {})]

        spawn_config = config.get("spawn_config", {})
        novel_cfg = spawn_config.get("novel", {}) or {}
        tweet_cfg = spawn_config.get("tweet", {}) or {}
        if not novel_cfg.get("enabled") and not tweet_cfg.get("enabled"):
            await update_job_status(job_id, "failed")
            await update_job_status_message(job_id, "未选择任何裂变方式")
            return

        total_sources = len(sources)
        done_sources = 0
        # 多源并发裂变(默认全并行; SPAWN_SOURCE_CONCURRENCY可调小以规避频控)
        import os as _os
        sem = asyncio.Semaphore(max(1, int(_os.environ.get("SPAWN_SOURCE_CONCURRENCY", "999"))))

        async def _process_source(src: dict) -> bool:
            """处理单个源: 导入→并发小说/推文。返回该源是否有成功产物"""
            nonlocal done_sources
            try:
                async with sem:
                    title, content = await _import_content(src, user_id)
                    if not content or len(content.strip()) < 100:
                        logger.warning(f"[Job {job_id}] source skipped: content too short")
                        return False

                    chapters = _split_chapters(content)
                    if not chapters:
                        logger.warning(f"[Job {job_id}] source skipped: no chapters parsed")
                        return False

                    await update_job_status_message(
                        job_id, f"《{title}》已导入 {len(chapters)} 章,开始裂变..."
                    )

                    # 推文需先确定第一人称主角(主平台同步逻辑)
                    protagonist = ""
                    if tweet_cfg.get("enabled"):
                        protagonist = (tweet_cfg.get("protagonist") or "").strip()
                        # 断点续跑: 该源推文产物已存在则沿用其主角, 跳过AI建议
                        _spid = int(src.get("product_id") or 0) or None
                        if not protagonist and _spid:
                            async for session in get_async_session():
                                _tw = (await session.execute(
                                    select(FactoryProduct).where(
                                        FactoryProduct.job_id == job_id,
                                        FactoryProduct.product_type == "tweet",
                                        FactoryProduct.parent_id == _spid,
                                    )
                                )).scalars().first()
                                break
                            if _tw is not None:
                                protagonist = ((_tw.meta_data or {}).get("protagonist") or "").strip()
                        if not protagonist:
                            await update_job_status_message(job_id, f"《{title}》正在AI建议第一人称主角...")
                            protagonist = await _suggest_protagonist(chapters)
                            logger.info(f"[Job {job_id}] suggested protagonist: {protagonist}")

                    # 裂变源头标识(用于产物"来源于"标签与溯源)
                    src_product_id = int(src.get("product_id") or 0) or None
                    src_label = title

                    # 小说与推文并发(各自内部逐章串行保连贯)
                    tasks = []
                    mc = config.get("model_config") or {}
                    if novel_cfg.get("enabled"):
                        for n in range(max(1, int(novel_cfg.get("count") or 1))):
                            tasks.append(_spawn_adaptation(
                                job_id, user_id, "novel", chapters,
                                f"{title}" + (f" #{n+1}" if n else ""),
                                source_label=src_label,
                                source_product_id=src_product_id,
                                primary=mc.get("novel") or "gemini",
                            ))
                    if tweet_cfg.get("enabled"):
                        for n in range(max(1, int(tweet_cfg.get("count") or 1))):
                            tasks.append(_spawn_adaptation(
                                job_id, user_id, "tweet", chapters,
                                f"{title}" + (f" #{n+1}" if n else ""),
                                protagonist=protagonist,
                                source_label=src_label,
                                source_product_id=src_product_id,
                                primary=mc.get("tweet") or "gemini",
                            ))

                    results = await asyncio.gather(*tasks, return_exceptions=True)
                    for r in results:
                        if isinstance(r, Exception):
                            logger.error(f"[Job {job_id}] adaptation task failed: {r}")
                    return any(not isinstance(r, Exception) for r in results)

            except Exception as e:
                logger.error(f"[Job {job_id}] source failed: {e}", exc_info=True)
                return False
            finally:
                done_sources += 1
                await update_job_progress(job_id, min(95, int(done_sources / max(1, total_sources) * 95)))

        src_results = await asyncio.gather(*[_process_source(s) for s in sources])
        any_ok = any(src_results)

        if any_ok:
            await update_job_status(job_id, "completed")
            await update_job_progress(job_id, 100)
            await update_job_status_message(job_id, "裂变完成")
            logger.info(f"[Job {job_id}] import_spawn completed")
        else:
            await update_job_status(job_id, "failed")
            await update_job_status_message(job_id, "所有源均裂变失败")

    except Exception as e:
        logger.exception(f"[Job {job_id}] import_spawn failed")
        await update_job_status(job_id, "failed")
        await update_job_status_message(job_id, f"失败: {str(e)[:200]}")


__all__ = ["run_import_spawn_job"]
