"""生成过程日志持久化helper"""
from __future__ import annotations
import logging
import asyncio
from typing import Any
from ..db import GenerationLog, session_scope

logger = logging.getLogger("log_helper")


async def save_log(
    draft_id: int,
    stage: str,
    message: str,
    log_type: str = "log",
    chapter_order: int = 0,
    metadata: dict | None = None,
) -> None:
    """保存日志到数据库(异步,不阻塞)
    
    Args:
        draft_id: 草稿ID
        stage: outline/chapter/storyboard/direct
        message: 日志内容
        log_type: log/progress/error/rag_hit/done
        chapter_order: 对应章节号(0表示整体)
        metadata: 额外信息(如RAG召回的scripts列表)
    """
    try:
        async with session_scope() as s:
            row = GenerationLog(
                draft_id=draft_id,
                stage=stage,
                chapter_order=chapter_order,
                log_type=log_type,
                message=message,
                log_metadata=metadata or {},
            )
            s.add(row)
    except Exception as e:
        logger.warning(f"save_log failed: {e}")


def save_log_fire_and_forget(
    draft_id: int,
    stage: str,
    message: str,
    log_type: str = "log",
    chapter_order: int = 0,
    metadata: dict | None = None,
) -> None:
    """非await版本,用于同步context(fire and forget)"""
    try:
        asyncio.create_task(save_log(draft_id, stage, message, log_type, chapter_order, metadata))
    except Exception:
        pass
