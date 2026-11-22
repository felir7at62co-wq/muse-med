"""对象存储客户端工厂 + key 生成 + 公共工具(火山 TOS 版)。

迁移说明:
- 原阿里云 OSS(oss2)整体替换为火山引擎 TOS(tos SDK, S3 风格对象存储)。
- 对外函数签名保持不变,调用方(routes/splitter 等)无需改动。
- DB 内存的是相对 key(如 drama/audio-studio/1/...),不存完整域名,
  因此换存储后只要 key 不变即可直接复用,无需订正历史数据。

配置项(沿用 aliyun_oss_* 命名以最小化改动, 值改为火山 TOS):
- aliyun_oss_access_key_id / secret  -> 火山 AK/SK
- aliyun_oss_bucket                  -> TOS 桶名
- aliyun_oss_region                  -> 如 cn-shanghai
- aliyun_oss_endpoint_internal       -> 内网域名 __REDACTED__
- aliyun_oss_endpoint_public         -> 外网域名 __REDACTED__
- aliyun_oss_key_prefix              -> drama/
"""
from __future__ import annotations

import asyncio
import logging
import re
import uuid
from datetime import datetime
from functools import lru_cache
from pathlib import PurePosixPath
from typing import Optional

import tos
from tos import HttpMethodType

from ..config import get_settings

logger = logging.getLogger(__name__)


# ============================================================
# 客户端工厂 (lru_cache 单例)
# ============================================================

def _region_from_endpoint(endpoint: str) -> str:
    """从 endpoint 反推 region: __REDACTED__ -> cn-shanghai。"""
    s = get_settings()
    if getattr(s, "aliyun_oss_region", ""):
        # region 配置项里若直接写 cn-shanghai 就用它; 若残留 oss-cn-* 则忽略
        r = s.aliyun_oss_region
        if not r.startswith("oss-"):
            return r
    m = re.search(r"tos-([a-z0-9-]+)\.i?volces\.com", endpoint or "")
    return m.group(1) if m else "cn-shanghai"


@lru_cache(maxsize=1)
def get_client_internal() -> tos.TosClientV2:
    """容器内部用,走内网 endpoint(免公网流量费)。put/head/abort/list 等服务端操作。"""
    s = get_settings()
    if not s.aliyun_oss_access_key_id or not s.aliyun_oss_access_key_secret:
        raise RuntimeError("TOS AK/SK 未配置 (ALIYUN_OSS_ACCESS_KEY_ID / SECRET)")
    ep = s.aliyun_oss_endpoint_internal
    return tos.TosClientV2(
        s.aliyun_oss_access_key_id,
        s.aliyun_oss_access_key_secret,
        ep,
        _region_from_endpoint(ep),
        connection_time=10,
    )


@lru_cache(maxsize=1)
def get_client_public() -> tos.TosClientV2:
    """给浏览器签名时用,公网 endpoint(浏览器能解析)。"""
    s = get_settings()
    if not s.aliyun_oss_access_key_id or not s.aliyun_oss_access_key_secret:
        raise RuntimeError("TOS AK/SK 未配置 (ALIYUN_OSS_ACCESS_KEY_ID / SECRET)")
    ep = s.aliyun_oss_endpoint_public
    return tos.TosClientV2(
        s.aliyun_oss_access_key_id,
        s.aliyun_oss_access_key_secret,
        ep,
        _region_from_endpoint(ep),
        connection_time=10,
    )


# ============================================================
# Key 生成 (后端单方面决定,防恶意覆盖)
# ============================================================

_SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._\u4e00-\u9fa5-]")


def _safe_filename(name: str, *, max_len: int = 80) -> str:
    base = PurePosixPath(name.replace("\\", "/")).name or "file"
    cleaned = _SAFE_FILENAME_RE.sub("_", base).strip("._")
    if not cleaned:
        cleaned = "file"
    if len(cleaned) > max_len:
        if "." in cleaned:
            stem, _, ext = cleaned.rpartition(".")
            keep = max_len - len(ext) - 1
            if keep > 0:
                cleaned = stem[:keep] + "." + ext
            else:
                cleaned = cleaned[:max_len]
        else:
            cleaned = cleaned[:max_len]
    return cleaned


def build_oss_key(
    *,
    user_id: int,
    filename: str,
    namespace: str = "uploads",
) -> str:
    """生成对象 key。格式: {prefix}{namespace}/{user_id}/{yyyymm}/{uuid8}_{safe_filename}"""
    s = get_settings()
    prefix = (s.aliyun_oss_key_prefix or "").lstrip("/")
    if prefix and not prefix.endswith("/"):
        prefix = prefix + "/"
    yyyymm = datetime.utcnow().strftime("%Y%m")
    uid8 = uuid.uuid4().hex[:8]
    safe = _safe_filename(filename)
    return f"{prefix}{namespace}/{user_id}/{yyyymm}/{uid8}_{safe}"


# ============================================================
# 预签名 URL
# ============================================================

def sign_put_url(
    key: str,
    *,
    ttl_seconds: Optional[int] = None,
    content_type: str = "application/octet-stream",
) -> str:
    """生成单文件 PUT 预签名 URL (浏览器直接 PUT 整文件)。"""
    s = get_settings()
    out = get_client_public().pre_signed_url(
        HttpMethodType.Http_Method_Put,
        s.aliyun_oss_bucket,
        key,
        expires=ttl_seconds or s.aliyun_oss_presign_ttl_seconds,
    )
    return out.signed_url


def sign_part_put_url(
    key: str,
    *,
    upload_id: str,
    part_number: int,
    ttl_seconds: Optional[int] = None,
    content_type: str = "application/octet-stream",
) -> str:
    """生成 multipart upload 单分片的 PUT 预签名 URL。

    分片 PUT 需带 query: uploadId / partNumber, 计入签名。
    """
    s = get_settings()
    out = get_client_public().pre_signed_url(
        HttpMethodType.Http_Method_Put,
        s.aliyun_oss_bucket,
        key,
        expires=ttl_seconds or s.aliyun_oss_presign_ttl_seconds,
        query={"uploadId": upload_id, "partNumber": str(part_number)},
    )
    return out.signed_url


# ============================================================
# 服务端操作 (走内网)
# ============================================================

def head_object(key: str) -> Optional[dict]:
    """看对象是否存在 + 拿 size/etag/content-type。返回 None 表示不存在。"""
    s = get_settings()
    try:
        h = get_client_internal().head_object(s.aliyun_oss_bucket, key)
        return {
            "size": h.content_length,
            "etag": (h.etag or "").strip('"'),
            "content_type": h.content_type,
            "last_modified": getattr(h, "last_modified", None),
        }
    except tos.exceptions.TosServerError as e:
        if getattr(e, "status_code", None) == 404:
            return None
        logger.warning("head_object failed: key=%s err=%s", key, e)
        return None
    except Exception as e:
        logger.warning("head_object failed: key=%s err=%s", key, e)
        return None


def init_multipart_upload(key: str, *, content_type: str = "application/octet-stream") -> str:
    """初始化分片上传, 返回 TOS 的 upload_id。"""
    s = get_settings()
    res = get_client_internal().create_multipart_upload(
        s.aliyun_oss_bucket,
        key,
        content_type=content_type,
    )
    return res.upload_id


def complete_multipart_upload(
    key: str,
    *,
    oss_upload_id: str,
    parts: list[dict],
) -> dict:
    """完成 multipart, 拼接成最终对象。

    parts 格式: [{"number": 1, "etag": "..."}, ...] (number 从 1 开始连续)
    返回 {"etag", "size"}
    """
    from tos.models2 import UploadedPart

    s = get_settings()
    part_objs = [
        UploadedPart(int(p["number"]), p["etag"])
        for p in sorted(parts, key=lambda x: int(x["number"]))
    ]
    res = get_client_internal().complete_multipart_upload(
        s.aliyun_oss_bucket, key, oss_upload_id, parts=part_objs
    )
    final = head_object(key)
    return {
        "etag": (getattr(res, "etag", "") or "").strip('"'),
        "size": (final or {}).get("size", 0),
    }


def abort_multipart_upload(key: str, *, oss_upload_id: str) -> None:
    """放弃分片上传, 释放临时分片(避免长期占用计费)。"""
    s = get_settings()
    try:
        get_client_internal().abort_multipart_upload(s.aliyun_oss_bucket, key, oss_upload_id)
    except tos.exceptions.TosServerError as e:
        if getattr(e, "status_code", None) == 404:
            return
        raise


def delete_object(key: str) -> None:
    s = get_settings()
    try:
        get_client_internal().delete_object(s.aliyun_oss_bucket, key)
    except tos.exceptions.TosServerError as e:
        if getattr(e, "status_code", None) == 404:
            return
        raise


def get_object_to_file(key: str, local_path: str) -> int:
    """从 TOS 下载对象到本地文件 (走内网, 给 splitter 用)。返回字节数。"""
    s = get_settings()
    get_client_internal().get_object_to_file(s.aliyun_oss_bucket, key, local_path)
    h = head_object(key)
    return (h or {}).get("size", 0)


# ============================================================
# oss2 兼容垫片: 老代码用 get_bucket_public().put_object(key, data) 风格 (阿里云 oss2),
# 这里用 TOS client 适配同名方法, 避免改动所有调用方。
#   bucket.put_object(key, data)   -> TosClientV2.put_object(bucket, key, content=data)
#   bucket.delete_object(key)      -> delete_object(key)
#   bucket.get_object_to_file(k,p) -> get_object_to_file(k, p)
# ============================================================

class _Oss2CompatBucket:
    def __init__(self, tos_client, bucket: str):
        self._c = tos_client
        self._b = bucket

    def put_object(self, key: str, data, **kwargs):
        return self._c.put_object(self._b, key, content=data)

    def delete_object(self, key: str):
        return delete_object(key)

    def get_object_to_file(self, key: str, local_path: str):
        self._c.get_object_to_file(self._b, key, local_path)
        return None


def get_bucket_public() -> "_Oss2CompatBucket":
    """oss2 兼容: 返回带 put_object/delete_object 的 public bucket 包装。"""
    s = get_settings()
    return _Oss2CompatBucket(get_client_public(), s.aliyun_oss_bucket)


def get_bucket_internal() -> "_Oss2CompatBucket":
    """oss2 兼容: 返回带 put_object/delete_object 的 internal bucket 包装。"""
    s = get_settings()
    return _Oss2CompatBucket(get_client_internal(), s.aliyun_oss_bucket)


# ============================================================
# 异步包装（2026-10-21）
# ============================================================
#
# 为什么需要这一组：tos SDK 底层是**同步的 requests/urllib3**。直接把它写在
# `async def` 里，整个事件循环就陪着一次 TLS 上传一起等 —— 这一个进程是单
# uvicorn worker，于是全站所有请求（页面、SSE 推送、任务心跳）一起排队。
#
# 实测（2026-10-21 14:00）：进程栈抓到主线程停在
#   send(ssl.py) <- put_object(tos/clientv2.py:1776) <- _finish_upscale_from_outputs
# 那一刻 CPU 空闲 92%、iowait 0.04 —— 不是资源不够，是唯一的事件循环被同步调用按住。
# 同小时慢请求(urt>30s) 1607 条，而 15 点请求量还多 29%、只有 101 条。
#
# 判据不是"有没有 await"，是"这段代码跑在谁的线程上"。tos 没有 async 版本，
# 所以只能丢进线程池：asyncio.to_thread 用的是默认 ThreadPoolExecutor。
#
# ⚠️ 不要在同步上下文里调用它们（会白起一个线程）；同步调用方继续用原函数。

async def put_object_async(key: str, data, *, internal: bool = False) -> None:
    """把字节上传到对象存储，不阻塞事件循环。

    `internal=True` 走内网端点（同 VPC 内免流量费），默认走公网桶。
    """

    def _put() -> None:
        bucket = get_bucket_internal() if internal else get_bucket_public()
        bucket.put_object(key, data)

    await asyncio.to_thread(_put)


async def delete_object_async(key: str) -> None:
    """删除对象，不阻塞事件循环。404 视为已删（同 `delete_object`）。"""
    await asyncio.to_thread(delete_object, key)


async def abort_multipart_upload_async(key: str, *, oss_upload_id: str) -> None:
    """中止分片上传，不阻塞事件循环。"""
    await asyncio.to_thread(abort_multipart_upload, key, oss_upload_id=oss_upload_id)


async def head_object_async(key: str) -> Optional[dict]:
    """HEAD 对象，不阻塞事件循环。"""
    return await asyncio.to_thread(head_object, key)


async def init_multipart_upload_async(
    key: str, *, content_type: str = "application/octet-stream"
) -> str:
    """初始化分片上传，不阻塞事件循环。"""
    return await asyncio.to_thread(
        init_multipart_upload, key, content_type=content_type
    )


async def complete_multipart_upload_async(
    key: str, *, oss_upload_id: str, parts: list
) -> dict:
    """拼接分片，不阻塞事件循环。"""
    return await asyncio.to_thread(
        complete_multipart_upload, key, oss_upload_id=oss_upload_id, parts=parts
    )


async def get_object_to_file_async(key: str, local_path: str) -> int:
    """下载对象到本地文件，不阻塞事件循环。"""
    return await asyncio.to_thread(get_object_to_file, key, local_path)


# 预签名 GET URL 缓存 (同 OSS 版逻辑, 避免前端轮询时图片闪烁)
_GET_URL_CACHE: dict[tuple[str, int], tuple[str, float]] = {}
_GET_URL_CACHE_WINDOW = 600


def get_public_cdn_url(key: str) -> str | None:
    """若配置了 CDN 公开直链 + key 命中白名单前缀, 返回 CDN 直链; 否则返回 None (调用方回退到预签名)。
    
    CDN 加速方案(方案 A): 特定业务前缀走公开读 + CDN 直链(无签名, 高缓存命中率)。
    未命中白名单的 key 维持原预签名行为, 保持私有访问。
    """
    s = get_settings()
    base = s.cdn_public_base_url.strip()
    if not base:
        return None
    prefixes = s.cdn_public_prefixes
    if not prefixes:
        return None
    for p in prefixes:
        if key.startswith(p):
            return f"{base.rstrip('/')}/{key}"
    return None


def sign_get_url(key: str, *, ttl_seconds: int = 3600) -> str:
    """给已上传对象生成下载 URL。
    
    优先尝试 CDN 公开直链(若配置且 key 命中白名单), 否则回退到预签名 URL(私有访问)。
    带进程内缓存(避免前端轮询时图片闪烁)。
    """
    # 优先 CDN 公开直链
    cdn_url = get_public_cdn_url(key)
    if cdn_url:
        return cdn_url
    # 回退到预签名 URL
    import time as _time
    now = _time.time()
    cache_key = (key, ttl_seconds)
    hit = _GET_URL_CACHE.get(cache_key)
    if hit is not None:
        url, signed_at = hit
        if now - signed_at < _GET_URL_CACHE_WINDOW and now - signed_at < ttl_seconds - 60:
            return url
    s = get_settings()
    out = get_client_public().pre_signed_url(
        HttpMethodType.Http_Method_Get,
        s.aliyun_oss_bucket,
        key,
        expires=ttl_seconds,
    )
    url = out.signed_url
    _GET_URL_CACHE[cache_key] = (url, now)
    if len(_GET_URL_CACHE) > 5000:
        for k, (_u, ts) in list(_GET_URL_CACHE.items()):
            if now - ts >= _GET_URL_CACHE_WINDOW:
                _GET_URL_CACHE.pop(k, None)
    return url


def sign_download_url(key: str, *, filename: str, ttl_seconds: int = 3600) -> str:
    """生成"强制下载 + 指定文件名"的预签名 URL。

    通过 TOS 的 response-content-disposition 覆盖响应头, 浏览器直连 OSS 下载(不经后端代理/nginx缓冲),
    大文件也秒开下载。filename 需为已清洗的安全文件名。
    """
    from urllib.parse import quote
    s = get_settings()
    disposition = f"attachment; filename*=UTF-8''{quote(filename)}"
    out = get_client_public().pre_signed_url(
        HttpMethodType.Http_Method_Get,
        s.aliyun_oss_bucket,
        key,
        expires=ttl_seconds,
        query={"response-content-disposition": disposition},
    )
    return out.signed_url


# ============================================================
# 配置自检 (启动时调用)
# ============================================================

def is_configured() -> bool:
    s = get_settings()
    return bool(
        s.aliyun_oss_access_key_id
        and s.aliyun_oss_access_key_secret
        and s.aliyun_oss_bucket
    )


def health_check() -> dict:
    """启动时跑一次 head_bucket, 给运维一个 TOS 连通性信号。"""
    s = get_settings()
    if not is_configured():
        return {"ok": False, "reason": "TOS 未配置"}
    try:
        get_client_internal().head_bucket(s.aliyun_oss_bucket)
        return {
            "ok": True,
            "bucket": s.aliyun_oss_bucket,
            "region": _region_from_endpoint(s.aliyun_oss_endpoint_internal),
            "endpoint_internal": s.aliyun_oss_endpoint_internal,
            "endpoint_public": s.aliyun_oss_endpoint_public,
        }
    except Exception as e:
        logger.exception("TOS health check failed")
        return {"ok": False, "reason": f"{type(e).__name__}: {e}"}