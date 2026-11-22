"""OSS 直传 API。

路由 prefix: /v1/oss

  POST   /init                 创建上传会话
                               body: {filename, total_size, kind, sha256?, extra?}
                               返回:
                                 single 模式 -> {upload_id, oss_key, put_url, expires_at}
                                 multipart   -> {upload_id, oss_key, oss_upload_id,
                                                 chunk_size, total_parts, expires_at}

  POST   /{upload_id}/sign-part   (仅 multipart) 给某一片签名
                                  body: {part_number}
                                  返回: {url}

  POST   /{upload_id}/complete    完成
                                  body (single): {etag}
                                  body (multipart): {parts: [{number, etag, size?}, ...]}
                                  返回: {ok, oss_key, size, etag}

  POST   /{upload_id}/abort       主动取消, 释放 OSS 分片
                                  返回: {ok}

  GET    /{upload_id}             查会话状态 (用于断点续传判断)

  GET    /health                  OSS 自检 (admin)
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, func

from ..auth import User, get_current_user, require_admin
from ..config import get_settings
from ..db import session_scope
from ..db.models import UploadSession
from . import client as oss_client

logger = logging.getLogger("oss")
router = APIRouter(prefix="/v1/oss", tags=["oss-upload"])


# ============================================================
# Pydantic
# ============================================================

class InitIn(BaseModel):
    filename: str = Field(..., min_length=1, max_length=255)
    total_size: int = Field(..., gt=0)
    kind: str = Field(..., pattern="^(single|multipart|auto)$",
                      description="single=直接 PUT, multipart=分片, auto=后端按大小自动选")
    sha256: str | None = None
    content_type: str = "application/octet-stream"
    namespace: str = "uploads"  # 调用方可覆盖,例: 'video' / 'avatar'
    extra: dict[str, Any] = Field(default_factory=dict)  # 业务元数据


class SignPartIn(BaseModel):
    part_number: int = Field(..., ge=1, le=10000)


class CompleteIn(BaseModel):
    etag: str | None = None  # single 模式
    parts: list[dict[str, Any]] | None = None  # multipart 模式: [{number, etag, size?}]


# ============================================================
# Helper
# ============================================================

def _serialize_session(s: UploadSession) -> dict:
    return {
        "upload_id": s.id,
        "user_id": s.user_id,
        "filename": s.filename,
        "total_size": s.total_size,
        "oss_key": s.oss_key,
        "oss_upload_id": s.oss_upload_id,
        "kind": s.upload_kind,
        "status": s.status,
        "parts_completed": s.parts_completed or [],
        "extra": s.extra or {},
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "expires_at": s.expires_at.isoformat() if s.expires_at else None,
        "completed_at": s.completed_at.isoformat() if s.completed_at else None,
    }


async def _get_session_owned(s, *, upload_id: str, user: User) -> UploadSession:
    sess = await s.get(UploadSession, upload_id)
    if not sess:
        raise HTTPException(404, "upload_id 不存在")
    if sess.user_id != user.id and user.role not in ("admin", "superadmin"):
        raise HTTPException(403, "无权操作该上传会话")
    if sess.expires_at and sess.expires_at < datetime.utcnow() and sess.status == "pending":
        sess.status = "expired"
        await s.flush()
        raise HTTPException(410, "上传会话已过期, 请重新发起")
    return sess


# ============================================================
# 1) INIT
# ============================================================

@router.post("/init")
async def init_upload(payload: InitIn, user: User = Depends(get_current_user)):
    settings = get_settings()
    if not oss_client.is_configured():
        raise HTTPException(503, "OSS 未配置")
    if payload.total_size > settings.aliyun_oss_max_file_size:
        raise HTTPException(
            413,
            f"文件超过限制 ({payload.total_size} > {settings.aliyun_oss_max_file_size} bytes)",
        )

    # 决定 kind
    chunk_size = settings.aliyun_oss_chunk_size
    kind = payload.kind
    if kind == "auto":
        # < 50MB 用 single; >= 50MB 用 multipart
        kind = "single" if payload.total_size < 50 * 1024 * 1024 else "multipart"

    # 单用户 pending 数量限制
    async with session_scope() as s:
        # 2026-11-10：只统计**未过期**的 pending。
        #
        # 原先统计的是 `status == 'pending'` 的全部，包括已经超过 24h TTL、但清理
        # worker 还没扫到的死会话。清理 worker 每小时才跑一次，而用户点「取消上传」
        # 时前端只 abort 了本地 XHR、从不调 /abort（ossUpload.ts 里那行注释写了但
        # 代码不存在），所以每次"传一半取消""网络断""关标签页"都会留下来一条
        # 永久 pending —— 攒够 5 条，用户就再也传不了任何东西，且要等满 24h 才松绑。
        #
        # 加上 expires_at > now 之后，名额反映的是"真正还在传的数量"。
        # 注意：**不能**用缩短 TTL 来治这件事 —— 一个正常上传跑 10 小时甚至 20 小时
        # 是可能存在的，缩短 TTL 会在它还传着的时候把 OSS 分片 abort 掉，且不可逆；
        # 暂停中的会话更是没有任何请求，按"多久没活动"判断一样会误杀。
        pending_count = (await s.execute(
            select(func.count()).select_from(UploadSession)
            .where(
                UploadSession.user_id == user.id,
                UploadSession.status == "pending",
                UploadSession.expires_at > datetime.utcnow(),
            )
        )).scalar_one()
        if pending_count >= settings.aliyun_oss_max_pending_per_user:
            raise HTTPException(
                429,
                f"正在进行的上传有 {pending_count} 个（上限 {settings.aliyun_oss_max_pending_per_user}），"
                f"等其中一些传完再试",
            )

        upload_id = uuid.uuid4().hex
        oss_key = oss_client.build_oss_key(
            user_id=user.id,
            filename=payload.filename,
            namespace=payload.namespace,
        )
        expires_at = datetime.utcnow() + timedelta(seconds=settings.aliyun_oss_session_ttl_seconds)

        sess = UploadSession(
            id=upload_id,
            user_id=user.id,
            filename=payload.filename,
            total_size=payload.total_size,
            sha256=payload.sha256,
            oss_key=oss_key,
            upload_kind=kind,
            status="pending",
            parts_completed=[],
            extra=payload.extra or {},
            expires_at=expires_at,
        )

        if kind == "multipart":
            try:
                oss_upload_id = await oss_client.init_multipart_upload_async(
                    oss_key, content_type=payload.content_type
                )
            except Exception as e:
                logger.exception("OSS init_multipart_upload failed")
                raise HTTPException(502, f"OSS 初始化分片失败: {e}")
            sess.oss_upload_id = oss_upload_id

        s.add(sess)
        await s.flush()

        # 构造响应
        if kind == "single":
            put_url = oss_client.sign_put_url(
                oss_key,
                content_type=payload.content_type,
                ttl_seconds=settings.aliyun_oss_presign_ttl_seconds,
            )
            return {
                "upload_id": upload_id,
                "oss_key": oss_key,
                "kind": "single",
                "put_url": put_url,
                "expires_at": expires_at.isoformat(),
                "presign_ttl": settings.aliyun_oss_presign_ttl_seconds,
            }
        else:
            total_parts = (payload.total_size + chunk_size - 1) // chunk_size
            return {
                "upload_id": upload_id,
                "oss_key": oss_key,
                "oss_upload_id": sess.oss_upload_id,
                "kind": "multipart",
                "chunk_size": chunk_size,
                "total_parts": total_parts,
                "expires_at": expires_at.isoformat(),
                "presign_ttl": settings.aliyun_oss_presign_ttl_seconds,
            }


# ============================================================
# 2) SIGN PART (multipart 用)
# ============================================================

@router.post("/{upload_id}/sign-part")
async def sign_part(upload_id: str, payload: SignPartIn, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        sess = await _get_session_owned(s, upload_id=upload_id, user=user)
        if sess.upload_kind != "multipart":
            raise HTTPException(400, "该会话不是 multipart 模式")
        if sess.status != "pending":
            raise HTTPException(409, f"会话已 {sess.status}, 不能再签新分片")

    url = oss_client.sign_part_put_url(
        sess.oss_key,
        upload_id=sess.oss_upload_id,
        part_number=payload.part_number,
    )
    return {"part_number": payload.part_number, "url": url}


# ============================================================
# 3) COMPLETE
# ============================================================

@router.post("/{upload_id}/complete")
async def complete(upload_id: str, payload: CompleteIn, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        sess = await _get_session_owned(s, upload_id=upload_id, user=user)
        if sess.status != "pending":
            raise HTTPException(409, f"会话状态 {sess.status}, 不能 complete")

        if sess.upload_kind == "single":
            head = await oss_client.head_object_async(sess.oss_key)
            if not head:
                raise HTTPException(400, "OSS 上未找到对象, 请先 PUT 完成")
            if head["size"] != sess.total_size:
                raise HTTPException(
                    400,
                    f"对象大小 {head['size']} != 声明 {sess.total_size}",
                )
            etag = head["etag"]
            size = head["size"]

        else:  # multipart
            if not payload.parts:
                raise HTTPException(400, "multipart complete 必须传 parts")
            try:
                res = await oss_client.complete_multipart_upload_async(
                    sess.oss_key,
                    oss_upload_id=sess.oss_upload_id,
                    parts=payload.parts,
                )
            except Exception as e:
                logger.exception("OSS complete_multipart_upload failed")
                raise HTTPException(502, f"OSS 拼接分片失败: {e}")
            etag = res["etag"]
            size = res["size"]
            sess.parts_completed = payload.parts

        sess.status = "completed"
        sess.completed_at = datetime.utcnow()
        await s.flush()

        return {
            "ok": True,
            "upload_id": upload_id,
            "oss_key": sess.oss_key,
            "size": size,
            "etag": etag,
            "filename": sess.filename,
            "extra": sess.extra,
        }


# ============================================================
# 4) ABORT
# ============================================================

@router.post("/{upload_id}/abort")
async def abort(upload_id: str, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        sess = await _get_session_owned(s, upload_id=upload_id, user=user)
        if sess.status != "pending":
            return {"ok": True, "noop": True, "status": sess.status}

        if sess.upload_kind == "multipart" and sess.oss_upload_id:
            try:
                await oss_client.abort_multipart_upload_async(
                    sess.oss_key, oss_upload_id=sess.oss_upload_id
                )
            except Exception as e:
                logger.warning("abort_multipart_upload failed: %s", e)

        # single 模式: 如果已 PUT 过, 删掉对象
        if sess.upload_kind == "single":
            try:
                await oss_client.delete_object_async(sess.oss_key)
            except Exception:
                pass

        sess.status = "aborted"
        await s.flush()
        return {"ok": True, "status": "aborted"}


# ============================================================
# 5) STATUS
# ============================================================

@router.get("/{upload_id}")
async def get_status(upload_id: str, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        sess = await s.get(UploadSession, upload_id)
        if not sess:
            raise HTTPException(404, "upload_id 不存在")
        if sess.user_id != user.id and user.role not in ("admin", "superadmin"):
            raise HTTPException(403, "无权查询该上传会话")
        return _serialize_session(sess)


# ============================================================
# 6) Health (admin)
# ============================================================

@router.get("/health/check")
async def health(_: User = Depends(require_admin)):
    return oss_client.health_check()
