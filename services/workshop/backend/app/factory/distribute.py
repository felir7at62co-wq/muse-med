"""分发实现: 把工厂剧本产物分发到飞书多维表格。

四要素 → 飞书表格列(按目标配置的field_mapping):
- title(剧名): product.title
- script(剧本): product.content 转纯文本; 目标列为附件类型时上传txt,文本类型时直接贴
- genre(类型): 大纲meta_data.concept.genre(创意发散产物); 存量任务降级用任务theme
- outline(大纲/初始创意): concept组装(前提/主角/冲突/钩子); 降级用大纲synopsis
"""
import asyncio
import json
import logging
from typing import Any, Optional

from sqlalchemy import select

from ..db.session import get_session as get_async_session
from ..feishu import client as feishu
from .models import FactoryProduct

logger = logging.getLogger(__name__)

# 飞书Drive上传接口频控严格(实测20部并发全部400),
# 上传必须串行化 + 失败重试(指数退避)
_UPLOAD_SEM = asyncio.Semaphore(2)
_UPLOAD_RETRIES = 4
_UPLOAD_BASE_DELAY = 1.5


async def _upload_with_ratelimit(app_token: str, filename: str, content: bytes) -> str:
    """带频控保护的飞书附件上传: 信号量限并发 + 400/429重试(指数退避)"""
    last_exc: Exception = None
    for i in range(_UPLOAD_RETRIES):
        try:
            async with _UPLOAD_SEM:
                token = await feishu.upload_media(app_token, filename, content)
                # 每次成功后小间隔,进一步压低QPS
                await asyncio.sleep(0.3)
                return token
        except Exception as e:
            last_exc = e
            msg = str(e)
            # 频控/服务端瞬时错误可重试; 参数类错误(如99991672权限)重试无意义
            retriable = ("HTTP400" in msg or "HTTP429" in msg or "99991400" in msg
                         or "frequency" in msg.lower() or "rate" in msg.lower())
            if retriable and i < _UPLOAD_RETRIES - 1:
                delay = _UPLOAD_BASE_DELAY * (2 ** i)
                logger.warning(f"[dist] upload {filename} attempt {i+1} failed({msg[:120]}), retry in {delay:.1f}s")
                await asyncio.sleep(delay)
            else:
                raise
    raise last_exc  # type: ignore[misc]


def script_to_text(title: str, content: str) -> str:
    """把剧本JSON({chapters:[...]})转成可读纯文本(与导出格式一致)"""
    try:
        data = json.loads(content or "{}")
    except json.JSONDecodeError:
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


def build_concept_text(concept: dict, synopsis: str = "") -> str:
    """把创意企划组装成'初始创意'文本; 无concept时降级用大纲synopsis"""
    parts = []
    if concept.get("premise"):
        parts.append(f"故事前提: {concept['premise']}")
    if concept.get("protagonist"):
        parts.append(f"主角设定: {concept['protagonist']}")
    if concept.get("conflict"):
        parts.append(f"核心冲突: {concept['conflict']}")
    if concept.get("hook"):
        parts.append(f"开篇钩子: {concept['hook']}")
    if parts:
        return "\n".join(parts)
    return synopsis or ""


async def collect_script_payload(script: FactoryProduct) -> dict:
    """收集单个产物的四要素(支持剧本/小说/推文)。

    - 剧本: genre/大纲创意来自父大纲的concept
    - 小说/推文(裂变产物): 沿source_product_id回溯源剧本再取其父大纲;
      类型标注"小说改编/推文改编",标题带体裁后缀
    """
    md = script.meta_data or {}
    ptype = script.product_type

    # 找到源头大纲: 剧本直接找parent; 裂变产物先回溯源剧本
    outline = None
    outline_id = None
    if ptype == "script":
        outline_id = md.get("outline_id") or script.parent_id
    else:
        src_id = md.get("source_product_id") or script.parent_id
        if src_id:
            async for session in get_async_session():
                result = await session.execute(
                    select(FactoryProduct).where(FactoryProduct.id == src_id)
                )
                src = result.scalar_one_or_none()
                break
            if src:
                outline_id = (src.meta_data or {}).get("outline_id") or src.parent_id

    if outline_id:
        async for session in get_async_session():
            result = await session.execute(
                select(FactoryProduct).where(FactoryProduct.id == outline_id)
            )
            outline = result.scalar_one_or_none()
            break

    concept = ((outline.meta_data if outline else {}) or {}).get("concept") or {}
    synopsis = ""
    if outline and outline.content:
        try:
            synopsis = (json.loads(outline.content) or {}).get("synopsis") or ""
        except json.JSONDecodeError:
            pass

    genre = concept.get("genre") or ""
    if ptype == "novel":
        genre = f"{genre}·小说改编" if genre else "小说改编"
    elif ptype == "tweet":
        genre = f"{genre}·推文改编" if genre else "推文(第一人称)改编"

    return {
        "title": script.title or f"产物{script.id}",
        "script_text": script_to_text(script.title or "", script.content or ""),
        "genre": genre,
        "outline_text": build_concept_text(concept, synopsis),
    }


async def distribute_scripts(
    script_ids: list,
    url: str,
    field_mapping: dict,
    job_id: int,
    target_name: str = "",
) -> dict:
    """把多部剧本并发分发到飞书多维表格。

    Returns:
        {"ok": [...], "failed": [{"id":..,"title":..,"error":..}]}
    """
    token, table_id = feishu.parse_bitable_ref(url)
    if not token or not table_id:
        raise ValueError("飞书链接无效: 需要含 ?table= 的多维表格链接")
    app_token = await feishu.resolve_app_token(token)

    # 拉字段元信息,判断"剧本"目标列是否为附件类型(type=17)
    fields_meta = await feishu.list_fields(app_token, table_id)
    field_types = {f.get("field_name"): f.get("type") for f in fields_meta}

    async def _send_one(script_id: int) -> dict:
        try:
            async for session in get_async_session():
                result = await session.execute(
                    select(FactoryProduct).where(FactoryProduct.id == script_id)
                )
                script = result.scalar_one_or_none()
                break
            if not script:
                return {"id": script_id, "ok": False, "error": "剧本不存在"}

            payload = await collect_script_payload(script)
            fields: dict = {}

            # 剧名
            col = field_mapping.get("title")
            if col:
                fields[col] = payload["title"]
            # 类型(单选列直接传字符串,飞书会自动建/匹配选项)
            col = field_mapping.get("genre")
            if col and payload["genre"]:
                fields[col] = payload["genre"]
            # 大纲(初始创意)
            col = field_mapping.get("outline")
            if col and payload["outline_text"]:
                fields[col] = payload["outline_text"]
            # 剧本: 附件列上传docx(排版好的Word文档),文本列直接贴纯文本
            col = field_mapping.get("script")
            if col:
                if field_types.get(col) == 17:  # 附件类型
                    from .docx_export import script_to_docx
                    docx_bytes = script_to_docx(payload["title"], script.content or "")
                    file_token = await _upload_with_ratelimit(
                        app_token,
                        f"{payload['title']}.docx",
                        docx_bytes,
                    )
                    fields[col] = [{"file_token": file_token}]
                else:
                    fields[col] = payload["script_text"]

            record_id = await feishu.create_record(app_token, table_id, fields)

            # 记录分发历史到剧本meta_data
            md = dict(script.meta_data or {})
            history = list(md.get("dist_history", []))
            history.append({
                "target": target_name,
                "record_id": record_id,
                "at": __import__("datetime").datetime.utcnow().isoformat(),
            })
            md["dist_history"] = history
            async for session in get_async_session():
                result = await session.execute(
                    select(FactoryProduct).where(FactoryProduct.id == script_id)
                )
                s2 = result.scalar_one_or_none()
                if s2:
                    s2.meta_data = md
                    await session.commit()
                break

            logger.info(f"[dist] script {script_id} -> {target_name} record={record_id}")
            return {"id": script_id, "title": payload["title"], "ok": True, "record_id": record_id}
        except Exception as e:
            logger.error(f"[dist] script {script_id} failed: {e}", exc_info=True)
            return {"id": script_id, "ok": False, "error": str(e)}

    results = await asyncio.gather(*[_send_one(sid) for sid in script_ids])
    ok = [r for r in results if r.get("ok")]
    failed = [r for r in results if not r.get("ok")]
    logger.info(f"[dist] job {job_id} -> {target_name}: {len(ok)} ok, {len(failed)} failed")
    return {"ok": ok, "failed": failed}