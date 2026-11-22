"""A线: 飞书表抖音链接 批量反推 → 回写飞书。

流程(每行):
  读飞书「链接」列的抖音链接 → tikhub 解析出公网 play_url
    → 本机流式下载到临时文件(防 OOM) → 转存到我们 TOS → 签名直链喂豆包反推
      (抖音 CDN 直链有防盗链, 豆包服务器抓不动会 HTTP400 Timeout, 必须转存 TOS)
    → 反推结果回写飞书「文本」列(经 field_map 映射)
    → 清理本地临时文件 + OSS 临时文件

field_map 约定:
  "douyin_url":  抖音链接列名(本表为「链接」)
  "reverse_out": 反推结果回写列名(本表为「文本」)
"""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import uuid

import httpx

from ..config import get_settings
from ..db import session_scope
from ..feishu import client as feishu
from ..tikhub import service as tikhub
from ..oss import client as oss_client
from .models import FeishuReverseJob
from .reverse import reverse_video

logger = logging.getLogger("frontcut.feishu_reverse")

_SEM = asyncio.Semaphore(3)  # 反推是长任务(40-60s/条), 控并发

# 抖音 CDN 常需的请求头(防盗链), 下载时带上更易成功
_DL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    "Referer": "https://www.douyin.com/",
}


async def _download_to_file(play_url: str, dest_path: str, *, timeout: float = 180.0) -> None:
    """流式下载视频直链到本地临时文件(不把整个视频塞内存, 防 OOM)。"""
    total = 0
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as c:
        async with c.stream("GET", play_url, headers=_DL_HEADERS) as r:
            r.raise_for_status()
            with open(dest_path, "wb") as f:
                async for chunk in r.aiter_bytes(chunk_size=1024 * 256):
                    f.write(chunk)
                    total += len(chunk)
    if total == 0:
        raise RuntimeError("下载视频为空")


def _put_from_file(oss_key: str, file_path: str) -> None:
    """从本地文件上传到 TOS(内部客户端, 不经内存)。"""
    s = get_settings()
    oss_client.get_client_internal().put_object_from_file(
        s.aliyun_oss_bucket, oss_key, file_path
    )


async def _douyin_play_url(share_url: str, *, user_id: int | None = None) -> str:
    """抖音分享链接 → 公网可访问的视频直链。"""
    info = await tikhub.resolve_share_url(share_url, user_id=user_id)
    play = (info or {}).get("play_url")
    if play:
        return play
    aweme_id = (info or {}).get("aweme_id")
    if aweme_id:
        play = await tikhub.get_play_url(str(aweme_id), user_id=user_id)
        if play:
            return play
    raise RuntimeError(f"无法取得视频播放直链: {str(info)[:200]}")


async def _process_row(app_token: str, table_id: str, rec: dict, fmap: dict, *, user_id: int | None) -> str:
    """处理一行: 下载→转存TOS→豆包反推→回写「文本」列。返回状态串。"""
    record_id = rec.get("record_id") or rec.get("id")
    fields = rec.get("fields") or {}
    url = feishu.cell_text(fields.get(fmap.get("douyin_url", "")))
    if not url:
        return "skip(无链接)"
    # 幂等: 反推列已有内容则跳过
    if feishu.cell_text(fields.get(fmap.get("reverse_out", ""))):
        return "skip(已反推)"
    async with _SEM:
        oss_key = None
        tmp_path = None
        try:
            play = await _douyin_play_url(url, user_id=user_id)
            fd, tmp_path = tempfile.mkstemp(suffix=".mp4", dir="/tmp")
            os.close(fd)
            await _download_to_file(play, tmp_path)
            oss_key = f"drama/frontcut-reverse-tmp/{uuid.uuid4().hex}.mp4"
            await asyncio.to_thread(_put_from_file, oss_key, tmp_path)
            signed = oss_client.sign_get_url(oss_key, ttl_seconds=3600)
            rev = await reverse_video(signed)
            await feishu.update_record(app_token, table_id, record_id, {fmap["reverse_out"]: rev})
            return "ok"
        except Exception as e:  # noqa: BLE001
            logger.warning("行 %s 反推失败: %s", record_id, e)
            try:
                await feishu.update_record(app_token, table_id, record_id, {fmap["reverse_out"]: f"反推失败: {str(e)[:100]}"})
            except Exception:  # noqa: BLE001
                pass
            return f"fail: {e}"
        finally:
            if tmp_path:
                try:
                    os.remove(tmp_path)
                except Exception:  # noqa: BLE001
                    pass
            if oss_key:
                try:
                    await asyncio.to_thread(oss_client.delete_object, oss_key)
                except Exception:  # noqa: BLE001
                    pass


async def run_feishu_reverse_batch(app_token: str, table_id: str, field_map: dict, *, user_id: int | None = None) -> dict:
    """扫描飞书表所有行批量反推+回写(同步版, 小表用)。"""
    for k in ("douyin_url", "reverse_out"):
        if not field_map.get(k):
            raise ValueError(f"field_map 缺少必填列: {k}")
    records = await feishu.list_records(app_token, table_id)
    results = await asyncio.gather(*[
        _process_row(app_token, table_id, rec, field_map, user_id=user_id) for rec in records
    ])
    ok = sum(1 for r in results if r == "ok")
    skip = sum(1 for r in results if r.startswith("skip"))
    fail = sum(1 for r in results if r.startswith("fail"))
    return {"total": len(results), "ok": ok, "skip": skip, "fail": fail}


async def _job_set(job_id: int, **kw) -> None:
    async with session_scope() as s:
        j = await s.get(FeishuReverseJob, job_id)
        if not j:
            return
        for k, v in kw.items():
            setattr(j, k, v)


async def run_reverse_job(job_id: int) -> None:
    """后台执行飞书批量反推任务, 边处理边写进度到 FeishuReverseJob。"""
    async with session_scope() as s:
        j = await s.get(FeishuReverseJob, job_id)
        if not j:
            return
        app_token, table_id, fmap, user_id = j.app_token, j.table_id, dict(j.field_map or {}), j.user_id

    try:
        for k in ("douyin_url", "reverse_out"):
            if not fmap.get(k):
                raise ValueError(f"field_map 缺少必填列: {k}")
        picked = set(fmap.pop("__record_ids__", []) or [])
        await _job_set(job_id, status="running", progress=1)
        records = await feishu.list_records(app_token, table_id)
        if picked:
            records = [r for r in records if (r.get("record_id") or r.get("id")) in picked]
        total = len(records)
        await _job_set(job_id, total=total)
        if total == 0:
            await _job_set(job_id, status="succeeded", progress=100)
            return

        counters = {"done": 0, "ok": 0, "skip": 0, "fail": 0}
        lock = asyncio.Lock()

        async def _one(rec: dict) -> None:
            r = await _process_row(app_token, table_id, rec, fmap, user_id=user_id)
            async with lock:
                counters["done"] += 1
                if r == "ok":
                    counters["ok"] += 1
                elif r.startswith("skip"):
                    counters["skip"] += 1
                else:
                    counters["fail"] += 1
                prog = 1 + int(counters["done"] / total * 98)
            await _job_set(
                job_id, progress=prog,
                done=counters["done"], ok=counters["ok"],
                skip=counters["skip"], fail=counters["fail"],
            )

        await asyncio.gather(*[_one(rec) for rec in records])

        status = "succeeded" if counters["fail"] == 0 else "partial_failed"
        await _job_set(
            job_id, status=status, progress=100,
            done=counters["done"], ok=counters["ok"],
            skip=counters["skip"], fail=counters["fail"],
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("feishu reverse job %s failed", job_id)
        await _job_set(job_id, status="failed", error=str(e)[:1000])