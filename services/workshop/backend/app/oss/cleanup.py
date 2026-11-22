"""OSS 上传会话清理 worker。

每小时扫一次 upload_sessions 表:
- status=pending 且 expires_at < now → 标记为 expired
- 同时调 OSS abort_multipart_upload 释放分片(避免计费)
- single 模式且对象已写入但 session 未 complete 也删掉对象

启动: 在 main.py 的 lifespan 中创建 asyncio.create_task(run_oss_cleanup_worker())
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from sqlalchemy import select

from ..db import session_scope
from ..db.models import UploadSession
from . import client as oss_client

logger = logging.getLogger("oss.cleanup")

_INTERVAL_SECONDS = 3600          # 每小时扫一次
_INITIAL_DELAY_SECONDS = 120       # 启动 2 分钟后第一次扫(避开热启动)


async def cleanup_expired_once() -> dict:
    """单次清扫: 找到所有过期的 pending 会话, abort 后置为 expired。"""
    now = datetime.utcnow()
    cleaned_multipart = 0
    cleaned_single = 0
    errors = 0

    if not oss_client.is_configured():
        return {"skipped": "oss not configured"}

    async with session_scope() as s:
        rows = (await s.execute(
            select(UploadSession)
            .where(
                UploadSession.status == "pending",
                UploadSession.expires_at < now,
            )
            .limit(500)
        )).scalars().all()

        for sess in rows:
            try:
                if sess.upload_kind == "multipart" and sess.oss_upload_id:
                    await oss_client.abort_multipart_upload_async(
                        sess.oss_key, oss_upload_id=sess.oss_upload_id
                    )
                    cleaned_multipart += 1
                else:
                    # single 模式: 删可能已写入的对象
                    await oss_client.delete_object_async(sess.oss_key)
                    cleaned_single += 1
                sess.status = "expired"
            except Exception as e:
                errors += 1
                logger.warning("cleanup session %s failed: %s", sess.id, e)
                # 失败也标 expired, 防止下次再扫(管理员可手工查)
                sess.status = "expired"

    if cleaned_multipart or cleaned_single or errors:
        logger.info(
            "OSS cleanup: multipart=%d single=%d errors=%d",
            cleaned_multipart, cleaned_single, errors,
        )
    return {
        "cleaned_multipart": cleaned_multipart,
        "cleaned_single": cleaned_single,
        "errors": errors,
        "scanned_at": now.isoformat(),
    }


async def run_oss_cleanup_worker(interval: int = _INTERVAL_SECONDS) -> None:
    """常驻协程: 周期性清扫过期上传会话。

    出错不退出, 等下个周期重试。
    """
    logger.info(
        "OSS cleanup worker started (initial_delay=%ds, interval=%ds)",
        _INITIAL_DELAY_SECONDS, interval,
    )
    try:
        await asyncio.sleep(_INITIAL_DELAY_SECONDS)
        while True:
            try:
                await cleanup_expired_once()
            except Exception as e:
                logger.exception("OSS cleanup tick failed (continue): %s", e)
            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        logger.info("OSS cleanup worker stopped")
        raise
