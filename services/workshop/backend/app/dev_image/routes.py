"""临时 UI 设计稿示意图批量生成路由 (gpt-image-2 via kegeai).

注意:
- 仅用于 dev 环境前端 UI 重构期对照, **不进入生产路由树**.
- 同步阻塞调用约 2 分钟/张, 因此采用"后台任务 + 状态轮询 + 文件落盘"的模式.
- 生成的 PNG 落盘到容器内 /app/uploads/ui-mockups/ (compose 已挂载到宿主 /root/drama-dev/uploads/).
- 同样的 (mockup_id, seed) 命中已存在的文件就直接返回, 避免重复消耗.

API:
  GET  /v1/dev/ui-mockups/list                     列出 25 条 prompt 元信息
  POST /v1/dev/ui-mockups/{mockup_id}/generate    触发后台生成 (返回任务 id, 立即返回)
  GET  /v1/dev/ui-mockups/{mockup_id}/status      查询某条的状态 (pending/running/done/error)
  GET  /v1/dev/ui-mockups/{mockup_id}/image       返回 PNG 图片二进制 (done 后可访问)
"""
from __future__ import annotations

import asyncio
import logging
import time
import os
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from .prompts import (
    DESIGN_V2,
    MOCKUPS,
    get_design_v2,
    get_prompt,
    list_design_v2,
    list_prompts,
)

router = APIRouter(prefix="/v1/dev/ui-mockups", tags=["dev_image"])
logger = logging.getLogger("dev_image")

# 输出目录 (容器内). compose 已把 /app/uploads 映射到宿主.
OUTPUT_DIR = (Path(os.environ["UPLOADS_DIR"]) / "ui-mockups")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# 状态: mockup_id -> {"status": "...", "started_at": ..., "finished_at": ..., "error": ...}
_STATE: dict[int, dict] = {}
_STATE_LOCK = asyncio.Lock()

# 限制全局并发 (kegeai 通道也有限速, 避免一把梭)
_SEM = asyncio.Semaphore(4)




def _file_path(mockup_id: int) -> Path:
    return OUTPUT_DIR / f"mockup_{mockup_id:02d}.png"


async def _do_generate(mockup_id: int, size: str = "1536x1024") -> None:
    """后台执行: 调 kegeai gpt-image-2, 落盘 PNG."""
    item = get_prompt(mockup_id)
    if not item:
        async with _STATE_LOCK:
            _STATE[mockup_id] = {"status": "error", "error": "invalid mockup_id"}
        return

    async with _SEM:
        async with _STATE_LOCK:
            _STATE[mockup_id] = {
                "status": "running",
                "started_at": time.time(),
                "title": item["title"],
            }

        try:
            # 复用 image_studio 的 GPT Image 2 双渠道兜底 (api4me ↔ zx1),
            # 不再自己拼单渠道 /images/generations 调用 (2026-08-15)。
            from ..image_studio import providers as _providers

            imgs = await _providers.generate_gpt_image(
                prompt=item["full_prompt"], n=1, size=size)
            if not imgs:
                raise RuntimeError("no image returned")
            raw = imgs[0]

            target = _file_path(mockup_id)
            target.write_bytes(raw)

            async with _STATE_LOCK:
                _STATE[mockup_id] = {
                    "status": "done",
                    "started_at": _STATE.get(mockup_id, {}).get("started_at"),
                    "finished_at": time.time(),
                    "title": item["title"],
                    "size_bytes": len(raw),
                }
            logger.info("ui-mockup #%s done, %d bytes", mockup_id, len(raw))
        except Exception as e:  # noqa: BLE001
            logger.exception("ui-mockup #%s failed", mockup_id)
            async with _STATE_LOCK:
                _STATE[mockup_id] = {
                    "status": "error",
                    "started_at": _STATE.get(mockup_id, {}).get("started_at"),
                    "finished_at": time.time(),
                    "error": str(e)[:500],
                    "title": item["title"],
                }


class GenerateBody(BaseModel):
    size: Optional[str] = "1536x1024"  # 16:9, 适合桌面端示意图
    force: bool = False  # True 时即使 PNG 已存在也重生


@router.get("/list")
async def api_list_mockups():
    """列出 25 条 prompt 元信息 + 每条的当前状态."""
    items = list_prompts()
    result = []
    for it in items:
        mid = it["id"]
        st = _STATE.get(mid, {})
        path = _file_path(mid)
        if path.exists() and st.get("status") != "running":
            # 文件已存在视为 done (服务重启会丢内存状态)
            status = "done"
        else:
            status = st.get("status", "idle")
        result.append({
            **it,
            "status": status,
            "error": st.get("error"),
            "size_bytes": path.stat().st_size if path.exists() else None,
            "image_url": f"/jubengongfang/v1/dev/ui-mockups/{mid}/image" if path.exists() else None,
        })
    return result


@router.post("/{mockup_id}/generate")
async def api_generate(mockup_id: int, body: GenerateBody, bg: BackgroundTasks):
    """触发某张示意图的后台生成 (立即返回, 不阻塞)."""
    if not get_prompt(mockup_id):
        raise HTTPException(404, "invalid mockup_id (1..25)")

    path = _file_path(mockup_id)
    cur = _STATE.get(mockup_id, {})
    if cur.get("status") == "running":
        return {"status": "running", "msg": "already running"}
    if path.exists() and not body.force:
        return {"status": "done", "msg": "already exists, use force=true to regenerate"}

    async with _STATE_LOCK:
        _STATE[mockup_id] = {"status": "pending", "queued_at": time.time()}

    bg.add_task(_do_generate, mockup_id, body.size or "1536x1024")
    return {"status": "queued", "mockup_id": mockup_id}


@router.post("/generate-all")
async def api_generate_all(body: GenerateBody, bg: BackgroundTasks):
    """批量入队所有未生成的示意图 (并发由 _SEM 控制)."""
    queued = []
    for it in MOCKUPS:
        mid = it["id"]
        path = _file_path(mid)
        cur = _STATE.get(mid, {})
        if cur.get("status") == "running":
            continue
        if path.exists() and not body.force:
            continue
        async with _STATE_LOCK:
            _STATE[mid] = {"status": "pending", "queued_at": time.time()}
        bg.add_task(_do_generate, mid, body.size or "1536x1024")
        queued.append(mid)
    return {"queued": queued, "count": len(queued)}


@router.get("/{mockup_id}/status")
async def api_status(mockup_id: int):
    if not get_prompt(mockup_id):
        raise HTTPException(404, "invalid mockup_id")
    st = _STATE.get(mockup_id, {})
    path = _file_path(mockup_id)
    if path.exists() and st.get("status") not in ("running", "pending"):
        return {
            "status": "done",
            "size_bytes": path.stat().st_size,
            "image_url": f"/jubengongfang/v1/dev/ui-mockups/{mockup_id}/image",
        }
    return {"status": st.get("status", "idle"), **st}


@router.get("/{mockup_id}/image")
async def api_image(mockup_id: int):
    if not get_prompt(mockup_id):
        raise HTTPException(404, "invalid mockup_id")
    path = _file_path(mockup_id)
    if not path.exists():
        raise HTTPException(404, "image not generated yet")
    return FileResponse(
        path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ════════════════════════════════════════════════════════════════════════════
# 工作台改版设计方案 v2 —— 独立 router + 独立前缀
#
# 为什么另起一个 router 而不是往上面加路由:
#   上面有 `/{mockup_id}/status` 这类**参数化**路由, 而 mockup_id 声明成 int。
#   新列表的 id 从 101 起, 走的是同一套 int 参数, 但 `/design-v2/list` 这种
#   字面量路径会被 `/{mockup_id}/status` 的匹配优先级卷进去 —— 结果要么 404
#   要么变成不可预期的行为, 取决于 Starlette 的路由排序。换个前缀最省事,
#   也保证与历史 25 条端点**完全零耦合**。
#
# 图与 v1 共用输出目录, 但文件名前缀区分(d101_ 而不是 mockup_01_), 便于归档。
# ════════════════════════════════════════════════════════════════════════════

design_router = APIRouter(prefix="/v1/dev/design-v2", tags=["dev_image_v2"])


def _v2_file_path(mockup_id: int) -> Path:
    return OUTPUT_DIR / f"d{mockup_id:03d}.png"


async def _do_generate_v2(mockup_id: int, size: str = "1536x1024") -> None:
    """后台执行: 调 kegeai gpt-image-2, 落盘 PNG。逻辑与 v1 同构, 只是取词与落盘名不同。"""
    item = get_design_v2(mockup_id)
    if not item:
        async with _STATE_LOCK:
            _STATE[mockup_id] = {"status": "error", "error": "invalid design id"}
        return

    async with _SEM:
        async with _STATE_LOCK:
            _STATE[mockup_id] = {
                "status": "running",
                "started_at": time.time(),
                "title": item["title"],
            }

        try:
            from ..image_studio import providers as _providers

            imgs = await _providers.generate_gpt_image(
                prompt=item["full_prompt"], n=1, size=size)
            if not imgs:
                raise RuntimeError("no image returned")
            raw = imgs[0]

            _v2_file_path(mockup_id).write_bytes(raw)

            async with _STATE_LOCK:
                _STATE[mockup_id] = {
                    "status": "done",
                    "started_at": _STATE.get(mockup_id, {}).get("started_at"),
                    "finished_at": time.time(),
                    "title": item["title"],
                    "size_bytes": len(raw),
                }
            logger.info("design-v2 #%s done, %d bytes", mockup_id, len(raw))
        except Exception as e:  # noqa: BLE001
            logger.exception("design-v2 #%s failed", mockup_id)
            async with _STATE_LOCK:
                _STATE[mockup_id] = {
                    "status": "error",
                    "started_at": _STATE.get(mockup_id, {}).get("started_at"),
                    "finished_at": time.time(),
                    "error": str(e)[:500],
                    "title": item["title"],
                }


@design_router.get("/list")
async def api_v2_list():
    """列出 6 条 v2 设计的元信息 + 状态。note 字段是给评审页显示的设计说明。"""
    result = []
    for it in list_design_v2():
        mid = it["id"]
        st = _STATE.get(mid, {})
        path = _v2_file_path(mid)
        if path.exists() and st.get("status") != "running":
            status = "done"
        else:
            status = st.get("status", "idle")
        result.append({
            **it,
            "status": status,
            "error": st.get("error"),
            "size_bytes": path.stat().st_size if path.exists() else None,
            "image_url": f"/jubengongfang/v1/dev/design-v2/{mid}/image" if path.exists() else None,
        })
    return result


@design_router.post("/generate-all")
async def api_v2_generate_all(body: GenerateBody, bg: BackgroundTasks):
    """批量入队所有未生成的 v2 效果图(并发由 _SEM 控制, 上限 4)。"""
    queued = []
    for it in DESIGN_V2:
        mid = it["id"]
        path = _v2_file_path(mid)
        cur = _STATE.get(mid, {})
        if cur.get("status") == "running":
            continue
        if path.exists() and not body.force:
            continue
        async with _STATE_LOCK:
            _STATE[mid] = {"status": "pending", "queued_at": time.time()}
        bg.add_task(_do_generate_v2, mid, body.size or "1536x1024")
        queued.append(mid)
    return {"queued": queued, "count": len(queued)}


@design_router.post("/{design_id}/generate")
async def api_v2_generate(design_id: int, body: GenerateBody, bg: BackgroundTasks):
    if not get_design_v2(design_id):
        raise HTTPException(404, "invalid design id (101/102/103/104/105/106)")

    path = _v2_file_path(design_id)
    cur = _STATE.get(design_id, {})
    if cur.get("status") == "running":
        return {"status": "running", "msg": "already running"}
    if path.exists() and not body.force:
        return {"status": "done", "msg": "already exists, use force=true to regenerate"}

    async with _STATE_LOCK:
        _STATE[design_id] = {"status": "pending", "queued_at": time.time()}

    bg.add_task(_do_generate_v2, design_id, body.size or "1536x1024")
    return {"status": "queued", "design_id": design_id}


@design_router.get("/{design_id}/status")
async def api_v2_status(design_id: int):
    if not get_design_v2(design_id):
        raise HTTPException(404, "invalid design id")
    st = _STATE.get(design_id, {})
    path = _v2_file_path(design_id)
    if path.exists() and st.get("status") not in ("running", "pending"):
        return {
            "status": "done",
            "size_bytes": path.stat().st_size,
            "image_url": f"/jubengongfang/v1/dev/design-v2/{design_id}/image",
        }
    return {"status": st.get("status", "idle"), **st}


@design_router.get("/{design_id}/image")
async def api_v2_image(design_id: int):
    path = _v2_file_path(design_id)
    if not path.exists():
        raise HTTPException(404, "image not generated yet")
    return FileResponse(
        path,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )
