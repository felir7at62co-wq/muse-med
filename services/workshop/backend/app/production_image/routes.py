"""
production_image.routes — 生产级 image2 资产生成路由（admin 触发）

API:
  GET  /v1/admin-api/production-images/static/list                    8 张静态资产 + 状态
  POST /v1/admin-api/production-images/static/{key}/generate          单张触发后台生成
  POST /v1/admin-api/production-images/static/generate-all            一键全部触发
  GET  /v1/admin-api/production-images/static/{key}/status            查询单张状态
  GET  /v1/admin-api/production-images/static/{key}/image             返回 PNG/WEBP 二进制

行为：
- 复用 dev_image 的 kegeai gpt-image-2 通道 + 同一 IMAGE_API_KEY 配置
- 落盘到 /app/uploads/production-images/<key>.<ext>（与 dev_image 隔离）
- 后续可由用户复制到 apps/web/public/ 对应路径并提交到 git
- 受 require_admin 保护
"""

from __future__ import annotations

import asyncio
import logging
import time
import os
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..security import require_admin
from .prompts import STATIC_ASSETS, get_static_asset

router = APIRouter(
    prefix="/v1/admin-api/production-images",
    tags=["production-images"],
    dependencies=[Depends(require_admin)],
)
logger = logging.getLogger("production_image")

# 输出目录（与 dev_image 隔离，方便 admin 一次清理）
OUTPUT_DIR = (Path(os.environ["UPLOADS_DIR"]) / "production-images")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# 状态: key -> {status, started_at, finished_at, error, size_bytes, ...}
_STATE: dict[str, dict] = {}
_STATE_LOCK = asyncio.Lock()
_SEM = asyncio.Semaphore(2)  # 限制并发，避免 kegeai 限速




def _file_path(key: str) -> Path:
    """落盘文件路径：以 key 命名，扩展名跟 spec.output_path 一致（webp/png）。"""
    spec = get_static_asset(key)
    if not spec:
        return OUTPUT_DIR / f"{key}.png"
    ext = Path(spec.output_path).suffix or ".png"
    return OUTPUT_DIR / f"{key}{ext}"


def _pick_size(spec) -> str:
    """把 spec.width / spec.height 映射到 image2 支持的 size。

    gpt-image-2 接受任意 size 字符串，按 spec 直接拼即可。
    """
    return f"{spec.width}x{spec.height}"


async def _do_generate(key: str) -> None:
    """后台执行：调 kegeai gpt-image-2，落盘资产。"""
    spec = get_static_asset(key)
    if not spec:
        async with _STATE_LOCK:
            _STATE[key] = {"status": "error", "error": "invalid key"}
        return

    async with _SEM:
        async with _STATE_LOCK:
            _STATE[key] = {
                "status": "running",
                "started_at": time.time(),
                "key": key,
                "title": spec.notes or key,
            }
        try:
            # 双渠道兜底 (api4me ↔ zx1) 由 providers.generate_gpt_image 内部完成;
            # 这里再叠一层指数退避, 应对两条渠道同时被上游限流的情况。
            # 参数类错误 (user_error / invalid size) 立即抛出, 不重试。
            from ..image_studio import providers as _providers

            size = _pick_size(spec)
            raw = None
            last_err = ""
            for attempt in range(5):
                try:
                    imgs = await _providers.generate_gpt_image(
                        prompt=spec.prompt, n=1, size=size)
                    if imgs:
                        raw = imgs[0]
                        break
                    last_err = "no image returned"
                except Exception as e:  # noqa: BLE001
                    last_err = str(e)[:300]
                    err_lower = last_err.lower()
                    is_user_error = (
                        "user_error" in err_lower
                        or "invalid size" in err_lower
                        or "invalid_request" in err_lower
                        or "must be divisible" in err_lower
                    )
                    if is_user_error:
                        raise RuntimeError(f"upstream user error (no retry) {last_err}")
                if attempt >= 4:
                    break
                wait = min(60, 5 * (2 ** attempt))  # 5s -> 10 -> 20 -> 40
                logger.warning(
                    "production-image '%s' 全渠道失败, retry %d/5 after %ds: %s",
                    key, attempt + 1, wait, last_err,
                )
                async with _STATE_LOCK:
                    cur = _STATE.get(key, {})
                    cur["status"] = "running"
                    cur["retry_attempt"] = attempt + 1
                    cur["last_warning"] = last_err
                    _STATE[key] = cur
                await asyncio.sleep(wait)
            if raw is None:
                raise RuntimeError(f"upstream after retries: {last_err}")

            target = _file_path(key)
            target.write_bytes(raw)
            async with _STATE_LOCK:
                _STATE[key] = {
                    "status": "done",
                    "started_at": _STATE.get(key, {}).get("started_at"),
                    "finished_at": time.time(),
                    "key": key,
                    "size_bytes": len(raw),
                }
            logger.info("production-image '%s' done, %d bytes", key, len(raw))
        except Exception as e:  # noqa: BLE001
            logger.exception("production-image '%s' failed", key)
            async with _STATE_LOCK:
                _STATE[key] = {
                    "status": "error",
                    "started_at": _STATE.get(key, {}).get("started_at"),
                    "finished_at": time.time(),
                    "error": str(e)[:500],
                    "key": key,
                }


class GenerateBody(BaseModel):
    force: bool = False  # True 时即使文件已存在也重生


@router.get("/static/list")
async def list_static_assets():
    """列出 8 张静态资产 + 当前状态。"""
    out = []
    for spec in STATIC_ASSETS:
        path = _file_path(spec.key)
        st = _STATE.get(spec.key, {})
        if path.exists() and st.get("status") != "running":
            status = "done"
        else:
            status = st.get("status", "idle")
        out.append(
            {
                "key": spec.key,
                "title": spec.notes or spec.key,
                "output_path": spec.output_path,
                "width": spec.width,
                "height": spec.height,
                "status": status,
                "error": st.get("error"),
                "size_bytes": path.stat().st_size if path.exists() else None,
                "image_url": f"/jubengongfang/v1/admin-api/production-images/static/{spec.key}/image"
                if path.exists()
                else None,
                "prompt_preview": spec.prompt[:140] + ("..." if len(spec.prompt) > 140 else ""),
            }
        )
    return out


@router.post("/static/{key}/generate")
async def generate_one(key: str, body: GenerateBody, bg: BackgroundTasks):
    """触发单张静态资产生成（立即返回）。"""
    if not get_static_asset(key):
        raise HTTPException(404, "invalid key, see /list for valid keys")
    path = _file_path(key)
    cur = _STATE.get(key, {})
    if cur.get("status") == "running":
        return {"status": "running", "msg": "already running"}
    if path.exists() and not body.force:
        return {"status": "done", "msg": "already exists, use force=true to regenerate"}
    async with _STATE_LOCK:
        _STATE[key] = {"status": "pending", "queued_at": time.time(), "key": key}
    bg.add_task(_do_generate, key)
    return {"status": "pending", "key": key}


@router.post("/static/generate-all")
async def generate_all(body: GenerateBody, bg: BackgroundTasks):
    """一键触发所有 8 张静态资产生成（已存在的若 force=false 跳过）。"""
    queued: list[str] = []
    skipped: list[str] = []
    for spec in STATIC_ASSETS:
        path = _file_path(spec.key)
        cur = _STATE.get(spec.key, {})
        if cur.get("status") == "running":
            skipped.append(spec.key)
            continue
        if path.exists() and not body.force:
            skipped.append(spec.key)
            continue
        async with _STATE_LOCK:
            _STATE[spec.key] = {"status": "pending", "queued_at": time.time(), "key": spec.key}
        bg.add_task(_do_generate, spec.key)
        queued.append(spec.key)
    return {"queued": queued, "skipped": skipped, "total": len(STATIC_ASSETS)}


@router.get("/static/{key}/status")
async def get_status(key: str):
    if not get_static_asset(key):
        raise HTTPException(404, "invalid key")
    path = _file_path(key)
    st = _STATE.get(key, {})
    if path.exists() and st.get("status") != "running":
        return {**st, "status": "done", "size_bytes": path.stat().st_size, "key": key}
    return {**st, "key": key, "status": st.get("status", "idle")}


@router.get("/static/{key}/image")
async def get_image(key: str):
    if not get_static_asset(key):
        raise HTTPException(404, "invalid key")
    path = _file_path(key)
    if not path.exists():
        raise HTTPException(404, "image not yet generated; call /generate first")
    media_type = "image/webp" if path.suffix == ".webp" else "image/png"
    return FileResponse(path, media_type=media_type, filename=path.name)
