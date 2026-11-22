"""draft_cover.routes — 草稿封面生成与回填.

行为:
  - generate(draft_id): 调 LLM 生成 prompt → image2 重试 3 次 → 失败落 SVG fallback.
  - 异步运行, _STATE 暴露进度. 跑完写 draft.cover_url 进 DB.
  - 静态文件落 /app/uploads/draft-covers/<draft_id>.<ext>, 通过 /v1/drafts/uploads/draft-covers/<file> 回读.
  - admin 批量回填: 一次任务, 串行扫描所有 cover_url 为空的 draft, 限并发 1
    避免一把梭撞限速; 进度可查, 可中断.
"""
from __future__ import annotations

import asyncio
import html
import logging
import os
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select, update

from ..auth.dependencies import get_current_user, require_admin
from ..auth.models import User
from ..db import ScriptDraft, session_scope
from .prompts import build_image_prompt

logger = logging.getLogger("draft_cover")

router = APIRouter(prefix="/v1/drafts", tags=["draft-cover"])

# 静态目录: 与 uploads 卷一致, 通过 /v1/drafts/uploads/draft-covers/* 暴露
OUTPUT_DIR = (Path(os.environ["UPLOADS_DIR"]) / "draft-covers")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# 单张生成的并发与重试
_SEM = asyncio.Semaphore(2)
_IMAGE_RETRIES = 3        # 失败重试 3 次后才走 SVG fallback
_RETRY_BACKOFF = 4.0      # 秒, 指数退避基

# 单张状态: draft_id -> {status, started_at, finished_at, attempts, error, kind}
_STATE: dict[int, dict] = {}
_STATE_LOCK = asyncio.Lock()

# 批量回填状态
_BACKFILL: dict = {
    "running": False,
    "started_at": None,
    "finished_at": None,
    "total": 0,
    "done": 0,
    "ok": 0,
    "failed": 0,
    "svg_fallback": 0,
    "current_id": None,
    "errors": [],  # 最后 N 条错误
}
_BACKFILL_LOCK = asyncio.Lock()
_BACKFILL_TASK: asyncio.Task | None = None




def _png_path(draft_id: int) -> Path:
    return OUTPUT_DIR / f"{draft_id}.png"


def _svg_path(draft_id: int) -> Path:
    return OUTPUT_DIR / f"{draft_id}.svg"


def _public_url(filename: str) -> str:
    return f"/jubengongfang/v1/drafts/uploads/draft-covers/{filename}"


# ────────────────────── SVG fallback (内容相关的纯程序化封面) ──────────────────────

# 题材调色 (跟 globals.css 一致风格, 紫黑为主)
_GENRE_PALETTE = {
    "古装": ("#7c2d12", "#1e293b"),    # 暗红 + 暗蓝
    "都市": ("#0f172a", "#7c3aed"),    # 蓝紫
    "玄幻": ("#312e81", "#06b6d4"),    # 靛 + 青
    "悬疑": ("#1f2937", "#7e22ce"),    # 灰黑 + 紫
    "科幻": ("#0c4a6e", "#06b6d4"),    # 深蓝 + 青
    "校园": ("#9333ea", "#f59e0b"),    # 紫 + 琥珀
    "权谋": ("#581c87", "#0f172a"),
    "言情": ("#9d174d", "#fbcfe8"),
    "default": ("#1e1b4b", "#7c3aed"),  # 默认深紫
}


def _pick_palette(tags: list[str] | None, draft_id: int) -> tuple[str, str]:
    if tags:
        for t in tags:
            if t in _GENRE_PALETTE:
                return _GENRE_PALETTE[t]
    # 退回 hash, 让相似 ID 不撞色
    keys = list(_GENRE_PALETTE.keys())
    keys.remove("default")
    return _GENRE_PALETTE[keys[draft_id % len(keys)]]


def _render_svg_fallback(*, draft_id: int, title: str, tags: list[str] | None) -> bytes:
    """生成 720x1080 SVG. 标题 + 题材 chip + 装饰几何."""
    c1, c2 = _pick_palette(tags, draft_id)
    safe_title = html.escape((title or "未命名").strip()[:40])
    chip_text = html.escape(("·".join(tags[:3]) if tags else "草稿"))
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1080" viewBox="0 0 720 1080">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{c1}"/>
      <stop offset="100%" stop-color="{c2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.3" r="0.5">
      <stop offset="0%" stop-color="rgba(255,255,255,0.18)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </radialGradient>
  </defs>
  <rect width="720" height="1080" fill="url(#bg)"/>
  <rect width="720" height="1080" fill="url(#glow)"/>
  <!-- 装饰几何 -->
  <circle cx="180" cy="220" r="120" fill="rgba(255,255,255,0.06)"/>
  <circle cx="600" cy="900" r="200" fill="rgba(255,255,255,0.04)"/>
  <line x1="60" y1="540" x2="660" y2="540" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
  <!-- 题材 chip -->
  <rect x="60" y="800" rx="14" ry="14" width="200" height="40" fill="rgba(255,255,255,0.14)"/>
  <text x="160" y="826" text-anchor="middle" fill="white" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif" font-size="18" font-weight="500">{chip_text}</text>
  <!-- 标题 -->
  <text x="60" y="920" fill="white" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif" font-size="56" font-weight="700">{safe_title}</text>
  <text x="60" y="980" fill="rgba(255,255,255,0.7)" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif" font-size="20">DRAMA #{draft_id}</text>
</svg>
"""
    return svg.encode("utf-8")


# ────────────────────── image2 调用 ──────────────────────

async def _call_image2(prompt: str, *, size: str = "1536x1024") -> bytes:
    """单次生成草稿封面, 返回 PNG bytes.

    size 默认 16:9 横屏 (1536x1024), 与 DraftCard 的 aspect-[16/9] 一致.
    早期版本用 832x1216 (9:16 竖屏), 在卡片里被裁掉头部的标题区, 已弃用.

    2026-08-15: 由"自己拼 IMAGE_API_KEY + /images/generations 单渠道调用"改为
    复用 image_studio.providers.generate_gpt_image —— 直接继承那边的 GPT Image 2
    双渠道兜底 (api4me ↔ zx1), 任一渠道挂掉不再整条链失败退 SVG。
    """
    from ..image_studio import providers as _providers

    imgs = await _providers.generate_gpt_image(prompt=prompt, n=1, size=size)
    if not imgs:
        raise RuntimeError("no image returned")
    return imgs[0]


# ────────────────────── 主流程 ──────────────────────

async def _generate_one(draft_id: int) -> dict:
    """同步等待型: 一次性跑完单张 (LLM prompt + 重试 3 次 + svg fallback).

    返回 {status, kind, url, error?}
    kind: 'ai' | 'svg'
    """
    async with _STATE_LOCK:
        _STATE[draft_id] = {
            "status": "running", "started_at": time.time(),
            "attempts": 0, "kind": None, "error": None,
        }

    async with _SEM:
        # 1) 取草稿
        async with session_scope() as s:
            d = await s.get(ScriptDraft, draft_id)
            if not d:
                async with _STATE_LOCK:
                    _STATE[draft_id].update(status="error", error="draft not found", finished_at=time.time())
                return {"status": "error", "error": "draft not found"}
            title = d.title or ""
            tags = d.outline.get("tags") if isinstance(d.outline, dict) else None
            # 兼容: tags 可能在 outline 里也可能没有
            if not tags:
                tags = []
            user_input = d.user_input or ""
            outline = d.outline if isinstance(d.outline, dict) else {}

        # 2) 构造 prompt
        try:
            image_prompt = await build_image_prompt(
                title=title, tags=tags, user_input=user_input, outline=outline,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("build_image_prompt failed for #%d: %s", draft_id, e)
            image_prompt = f"Cinematic vertical poster cover for a Chinese short drama '{title}'. Premium painterly mood."

        # 3) 重试 image2
        last_err = ""
        for attempt in range(1, _IMAGE_RETRIES + 1):
            async with _STATE_LOCK:
                _STATE[draft_id]["attempts"] = attempt
            try:
                raw = await _call_image2(image_prompt)
                target = _png_path(draft_id)
                target.write_bytes(raw)
                cover_url = _public_url(target.name)
                # 写库
                async with session_scope() as s:
                    await s.execute(
                        update(ScriptDraft).where(ScriptDraft.id == draft_id).values(cover_url=cover_url)
                    )
                async with _STATE_LOCK:
                    _STATE[draft_id].update(
                        status="done", finished_at=time.time(), kind="ai", url=cover_url,
                        size_bytes=len(raw),
                    )
                logger.info("draft #%d cover AI ok @ attempt %d, %d bytes", draft_id, attempt, len(raw))
                return {"status": "done", "kind": "ai", "url": cover_url, "attempts": attempt}
            except Exception as e:  # noqa: BLE001
                last_err = str(e)[:300]
                logger.warning("draft #%d image2 attempt %d failed: %s", draft_id, attempt, last_err)
                if attempt < _IMAGE_RETRIES:
                    await asyncio.sleep(_RETRY_BACKOFF * attempt)

        # 4) 全部失败 → SVG fallback
        try:
            svg_bytes = _render_svg_fallback(draft_id=draft_id, title=title, tags=tags)
            target = _svg_path(draft_id)
            target.write_bytes(svg_bytes)
            cover_url = _public_url(target.name)
            async with session_scope() as s:
                await s.execute(
                    update(ScriptDraft).where(ScriptDraft.id == draft_id).values(cover_url=cover_url)
                )
            async with _STATE_LOCK:
                _STATE[draft_id].update(
                    status="done", finished_at=time.time(), kind="svg",
                    url=cover_url, error=f"AI failed after {_IMAGE_RETRIES}x: {last_err}",
                )
            logger.warning("draft #%d AI failed, SVG fallback written", draft_id)
            return {"status": "done", "kind": "svg", "url": cover_url, "error": last_err}
        except Exception as e:  # noqa: BLE001
            logger.exception("draft #%d SVG fallback also failed", draft_id)
            async with _STATE_LOCK:
                _STATE[draft_id].update(status="error", finished_at=time.time(), error=str(e)[:300])
            return {"status": "error", "error": str(e)[:300]}


# ────────────────────── 用户/管理员路由 ──────────────────────

class GenerateBody(BaseModel):
    force: bool = False  # True 时即使 cover_url 已存在也重生


@router.post("/{draft_id}/cover/generate")
async def api_generate(
    draft_id: int,
    body: GenerateBody,
    bg: BackgroundTasks,
    user: User = Depends(get_current_user),
):
    """触发某个草稿的封面生成. 立即返回, 后台 1-3 分钟跑完."""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise HTTPException(404, "draft not found")
        # 鉴权: 草稿主人或 admin
        if d.user_id != user.id and (user.role or "").lower() not in ("admin", "superadmin"):
            raise HTTPException(403, "permission denied")
        if d.cover_url and not body.force:
            return {"already": True, "url": d.cover_url}

    async with _STATE_LOCK:
        cur = _STATE.get(draft_id, {}).get("status")
    if cur == "running":
        return {"running": True, "draft_id": draft_id}

    bg.add_task(_generate_one, draft_id)
    return {"scheduled": True, "draft_id": draft_id}


@router.get("/{draft_id}/cover/status")
async def api_status(draft_id: int, user: User = Depends(get_current_user)):
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise HTTPException(404, "draft not found")
        if d.user_id != user.id and (user.role or "").lower() not in ("admin", "superadmin"):
            raise HTTPException(403, "permission denied")
        cover_url = d.cover_url or ""
    async with _STATE_LOCK:
        st = dict(_STATE.get(draft_id) or {})
    return {"draft_id": draft_id, "cover_url": cover_url, "state": st}


# ────────────────────── 静态文件 (无鉴权, 让前端直接打 cover_url) ──────────────────────

#: 缩略图目录与尺寸。
#:
#: ## 为什么需要它
#: 原图是 1536×1024 的 PNG、**平均 2MB**（dev 实测 458 张共 983MB）。
#: 而卡片只显示约 390×220（新版列表更小），也就是说**为了显示一张邮票，
#: 每次要拉 2MB**。草稿列表页"卡非常久"就是这么来的 —— 不是接口慢，
#: 是图片体积比它该有的大了两个数量级。
#:
#: 缩略图统一 480px 宽（够 2 倍图渲染 240px 宽的卡片，兼顾将来的中号卡片），
#: JPEG q=82。
#:
#: ## 为什么按需生成 + 落盘缓存，而不是只在生成时压缩
#: 存量 458 张（prod 1524 张）已经躺在盘上了。只改生成端的话，
#: 老图永远是大图，用户还是卡。按需生成让**老图也能立刻变小**，
#: 且不需要一次性迁移（迁移要动 prod 数据目录，是另一件需要授权的事）。
#: 落盘缓存保证同一张只算一次。
THUMB_DIR = OUTPUT_DIR / "_thumbs"
THUMB_WIDTH = 480
THUMB_QUALITY = 82


def _thumb_path(stem: str) -> Path:
    return THUMB_DIR / f"{stem}.jpg"


def _build_thumb(src: Path, dst: Path) -> bool:
    """把 src 缩成 dst（JPEG）。返回是否成功。

    ⚠️ 缩略图不是"必须成功"的东西：失败了就让调用方回退到原图，
    用户最多是多等一会儿，不该因此看不到封面。所以这里吞掉异常只记日志。
    """
    try:
        from PIL import Image
        dst.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(src) as im:
            im = im.convert("RGB")          # PNG 可能是 RGBA/P，JPEG 不接受
            if im.width > THUMB_WIDTH:
                h = max(1, round(im.height * THUMB_WIDTH / im.width))
                im = im.resize((THUMB_WIDTH, h), Image.LANCZOS)
            # 先写临时文件再原子改名：并发请求同一张时，
            # 后来者可能读到一个"写了一半"的 JPEG（表现为图片显示不全/损坏）。
            tmp = dst.with_suffix(f".{os.getpid()}.tmp")
            im.save(tmp, "JPEG", quality=THUMB_QUALITY, optimize=True)
            os.replace(tmp, dst)
        return True
    except Exception as e:                                   # noqa: BLE001
        logger.warning("缩略图生成失败 %s: %s", src, e)
        return False


@router.get("/uploads/draft-covers/{filename}")
async def api_cover_static(filename: str, w: int | None = None):
    """取封面。带 `?w=` 时返回缩略图（首次生成、之后命中缓存）。

    `w` 只是"要不要缩略图"的开关，不参与实际尺寸计算 ——
    尺寸由前端布局决定，而布局随时会变；让客户端指定像素宽会让
    同一张图按不同 w 缓存成好几份（缓存命中率骤降、磁盘翻倍）。
    真正的宽度统一由 THUMB_WIDTH 决定。
    """
    # 防穿越
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(400, "invalid filename")
    fp = OUTPUT_DIR / filename
    if not fp.is_file():
        raise HTTPException(404, "not found")

    # 缩略图：只对位图做，SVG 本来就是矢量（放大缩小都不糊，且很小）
    if w is not None and not filename.endswith(".svg"):
        thumb = _thumb_path(Path(filename).stem)
        # 原图比缩略图**更新**时需要重做（封面被重新生成过）
        if not thumb.is_file() or thumb.stat().st_mtime < fp.stat().st_mtime:
            # 同步生成：封面最大 2MB，PIL 缩放是几十毫秒级。
            # 放线程池避免阻塞事件循环（本服务是单进程 asyncio）。
            await asyncio.to_thread(_build_thumb, fp, thumb)
        if thumb.is_file():
            # 长缓存：文件名即草稿 id，封面重生成时 mtime 会变、URL 也会带新的时间戳
            return FileResponse(
                thumb, media_type="image/jpeg",
                headers={"Cache-Control": "public, max-age=604800"},
            )
        # 生成失败 → 落到下面回原图（宁可慢，不可看不到）

    if filename.endswith(".png"):
        return FileResponse(fp, media_type="image/png")
    if filename.endswith(".svg"):
        return FileResponse(fp, media_type="image/svg+xml")
    if filename.endswith(".webp"):
        return FileResponse(fp, media_type="image/webp")
    return FileResponse(fp)


# ────────────────────── admin: 批量回填 ──────────────────────

class BackfillBody(BaseModel):
    only_empty: bool = True   # True 仅处理 cover_url 为空的; False 全量重刷
    limit: int | None = None  # 调试用, 限制本次最多处理多少条


async def _backfill_worker(only_empty: bool, limit: int | None):
    async with _BACKFILL_LOCK:
        _BACKFILL.update(
            running=True, started_at=time.time(), finished_at=None,
            total=0, done=0, ok=0, failed=0, svg_fallback=0,
            current_id=None, errors=[],
        )

    try:
        # 拉一遍 ID 列表
        async with session_scope() as s:
            stmt = select(ScriptDraft.id).where(ScriptDraft.is_deleted == False)  # noqa: E712
            if only_empty:
                stmt = stmt.where(
                    (ScriptDraft.cover_url == None)  # noqa: E711
                    | (ScriptDraft.cover_url == "")
                )
            stmt = stmt.order_by(ScriptDraft.id.desc())
            ids = [r[0] for r in (await s.execute(stmt)).all()]
        if limit:
            ids = ids[:limit]

        async with _BACKFILL_LOCK:
            _BACKFILL["total"] = len(ids)

        for did in ids:
            async with _BACKFILL_LOCK:
                _BACKFILL["current_id"] = did
            try:
                res = await _generate_one(did)
                async with _BACKFILL_LOCK:
                    if res.get("status") == "done":
                        _BACKFILL["ok"] += 1
                        if res.get("kind") == "svg":
                            _BACKFILL["svg_fallback"] += 1
                    else:
                        _BACKFILL["failed"] += 1
                        if res.get("error"):
                            errs = _BACKFILL["errors"]
                            errs.append(f"#{did}: {res['error']}")
                            _BACKFILL["errors"] = errs[-30:]
            except Exception as e:  # noqa: BLE001
                logger.exception("backfill draft #%d unexpected error", did)
                async with _BACKFILL_LOCK:
                    _BACKFILL["failed"] += 1
                    errs = _BACKFILL["errors"]
                    errs.append(f"#{did}: {e}")
                    _BACKFILL["errors"] = errs[-30:]
            finally:
                async with _BACKFILL_LOCK:
                    _BACKFILL["done"] += 1
    finally:
        async with _BACKFILL_LOCK:
            _BACKFILL.update(running=False, finished_at=time.time(), current_id=None)


@router.post("/admin/cover/backfill")
async def api_backfill(
    body: BackfillBody,
    _admin: User = Depends(require_admin),
):
    """admin: 批量回填全部空 cover. 返回立即, 后台跑."""
    global _BACKFILL_TASK
    async with _BACKFILL_LOCK:
        if _BACKFILL["running"]:
            return {"running": True, "progress": dict(_BACKFILL)}
    _BACKFILL_TASK = asyncio.create_task(_backfill_worker(body.only_empty, body.limit))
    return {"scheduled": True}


@router.get("/admin/cover/backfill/status")
async def api_backfill_status(_admin: User = Depends(require_admin)):
    async with _BACKFILL_LOCK:
        return dict(_BACKFILL)


@router.post("/admin/cover/backfill/stop")
async def api_backfill_stop(_admin: User = Depends(require_admin)):
    """中止当前批量任务 (优雅: 设 running=False, worker 自然退出当前一张就停)."""
    global _BACKFILL_TASK
    if _BACKFILL_TASK and not _BACKFILL_TASK.done():
        _BACKFILL_TASK.cancel()
    async with _BACKFILL_LOCK:
        if _BACKFILL["running"]:
            _BACKFILL.update(running=False, finished_at=time.time())
    return {"stopped": True}


# ────────────────────── admin: 批量预热缩略图 ──────────────────────

_THUMB_WARM: dict = {
    "running": False, "started_at": None, "finished_at": None,
    "total": 0, "done": 0, "built": 0, "skipped": 0, "failed": 0,
}
_THUMB_WARM_LOCK = asyncio.Lock()
_THUMB_WARM_TASK: asyncio.Task | None = None


async def _thumb_warm_worker(limit: int | None = None):
    """把现有封面全部预生成一遍缩略图。

    ## 为什么需要"预热"而不是只靠按需生成
    按需生成对**第一次访问**没有帮助：500 张封面就是 500 次"首次"，
    而那一次要读 2MB 的 PNG 再缩放。列表页一屏 20 张、用户快速滚动时，
    这一下会堆出可观的并发读盘。预热把这件事挪到没人用的时候做完，
    用户侧只剩"命中缓存"。

    ## 为什么要跳过已是最新的
    `_build_thumb` 每张要几十毫秒，500 张就是十几秒；
    重复跑一次都会白做。判据与原图 mtime 比较（封面重生成过才重做），
    所以这个接口可以随便重复调。
    """
    global _THUMB_WARM
    async with _THUMB_WARM_LOCK:
        if _THUMB_WARM["running"]:
            return
        _THUMB_WARM.update(running=True, started_at=time.time(), finished_at=None,
                           total=0, done=0, built=0, skipped=0, failed=0)
    try:
        # 只扫数据库里真有 cover_url 的草稿 —— 直接遍历目录会把
        # 已经被删掉/换掉的孤儿文件也算进来（那是另一件事，不该混在预热里）
        async with session_scope() as s:
            rows = (await s.execute(
                select(ScriptDraft.cover_url).where(
                    ScriptDraft.cover_url.isnot(None),
                    ScriptDraft.cover_url != "",
                )
            )).scalars().all()
        files = []
        for url in rows:
            name = str(url).rsplit("/", 1)[-1]
            if name and not name.endswith(".svg"):
                fp = OUTPUT_DIR / name
                if fp.is_file():
                    files.append(fp)
        if limit:
            files = files[:limit]

        async with _THUMB_WARM_LOCK:
            _THUMB_WARM["total"] = len(files)

        for fp in files:
            thumb = _thumb_path(fp.stem)
            if thumb.is_file() and thumb.stat().st_mtime >= fp.stat().st_mtime:
                async with _THUMB_WARM_LOCK:
                    _THUMB_WARM["skipped"] += 1
                    _THUMB_WARM["done"] += 1
                continue
            ok = await asyncio.to_thread(_build_thumb, fp, thumb)
            async with _THUMB_WARM_LOCK:
                _THUMB_WARM["done"] += 1
                if ok:
                    _THUMB_WARM["built"] += 1
                else:
                    _THUMB_WARM["failed"] += 1
        logger.info("缩略图预热完成: %s", _THUMB_WARM)
    finally:
        async with _THUMB_WARM_LOCK:
            _THUMB_WARM.update(running=False, finished_at=time.time())


class ThumbWarmBody(BaseModel):
    limit: int | None = None   # 调试用：只处理前 N 张


@router.post("/admin/cover/thumbs/warm", dependencies=[Depends(require_admin)])
async def api_thumb_warm(body: ThumbWarmBody | None = None):
    """admin: 批量预生成封面缩略图（幂等，可重复调）。返回立即，后台跑。"""
    global _THUMB_WARM_TASK
    async with _THUMB_WARM_LOCK:
        if _THUMB_WARM["running"]:
            return {"running": True, "progress": dict(_THUMB_WARM)}
    _THUMB_WARM_TASK = asyncio.create_task(
        _thumb_warm_worker(body.limit if body else None)
    )
    return {"scheduled": True}


@router.get("/admin/cover/thumbs/status", dependencies=[Depends(require_admin)])
async def api_thumb_warm_status():
    async with _THUMB_WARM_LOCK:
        return dict(_THUMB_WARM)


# ────────────────────── 自动重试守护 worker ──────────────────────
# 解决场景:
#   - 创建草稿/选定大纲后异步触发的封面生成失败 (image2 限速 / 网络抖动 / LLM
#     抽视觉意象失败), 三次重试都没成功就落 SVG 了, 用户看到的是兜底 SVG.
#   - admin 批量回填里失败的 (失败计入 _BACKFILL.failed) 之后没人主动重试,
#     那张草稿永远停在 SVG 上.
# 守护 worker 周期性扫描 "cover_url 为空" 或 "cover_url 落到 .svg" 的草稿,
# 自动调 _generate_one() 重试. 限流 + cooldown 防止反复打同一张失败的 key.

# 配置 (启动时读环境变量, 可热改 _RETRY_DAEMON 内字段)
_RETRY_DAEMON: dict = {
    "enabled": True,
    "interval_sec": 600,        # 每 10 分钟扫一次
    "batch_per_round": 10,      # 每轮最多触发 10 张
    "max_attempts_per_draft": 6,  # 同一张连续失败这么多次就放弃 (避开"永远画不出标题"的死草稿)
    "cooldown_sec": 1800,       # 每张草稿两次自动重试间隔 30min
    "running": False,
    "started_at": None,
    "last_round_at": None,
    "rounds": 0,
    "triggered_total": 0,
    "succeeded_total": 0,
    "fallback_total": 0,
    # draft_id -> {"attempts": int, "last_at": float}
    "tracker": {},
}
_RETRY_DAEMON_LOCK = asyncio.Lock()
_RETRY_DAEMON_TASK: asyncio.Task | None = None


def _retry_daemon_load_env():
    """允许通过环境变量覆盖默认值."""
    enabled = os.environ.get("DRAFT_COVER_RETRY_ENABLED", "1").strip().lower()
    _RETRY_DAEMON["enabled"] = enabled in ("1", "true", "yes", "on")
    try:
        _RETRY_DAEMON["interval_sec"] = max(60, int(
            os.environ.get("DRAFT_COVER_RETRY_INTERVAL", _RETRY_DAEMON["interval_sec"])
        ))
    except Exception:
        pass
    try:
        _RETRY_DAEMON["batch_per_round"] = max(1, int(
            os.environ.get("DRAFT_COVER_RETRY_BATCH", _RETRY_DAEMON["batch_per_round"])
        ))
    except Exception:
        pass
    try:
        _RETRY_DAEMON["max_attempts_per_draft"] = max(1, int(
            os.environ.get("DRAFT_COVER_RETRY_MAX_ATTEMPTS", _RETRY_DAEMON["max_attempts_per_draft"])
        ))
    except Exception:
        pass
    try:
        _RETRY_DAEMON["cooldown_sec"] = max(60, int(
            os.environ.get("DRAFT_COVER_RETRY_COOLDOWN", _RETRY_DAEMON["cooldown_sec"])
        ))
    except Exception:
        pass


async def _retry_one_round() -> dict:
    """跑一轮: 选出候选, 触发重试, 返回本轮统计."""
    triggered = 0
    succeeded = 0
    fallback = 0
    skipped_cooldown = 0
    skipped_max_attempts = 0
    now = time.time()
    cooldown = float(_RETRY_DAEMON["cooldown_sec"])
    max_attempts = int(_RETRY_DAEMON["max_attempts_per_draft"])
    batch = int(_RETRY_DAEMON["batch_per_round"])

    async with session_scope() as s:
        # 选出 cover_url 为空 或 落到 .svg 的草稿; 优先最近更新的
        from sqlalchemy import or_
        stmt = (
            select(ScriptDraft.id)
            .where(ScriptDraft.is_deleted == False)  # noqa: E712
            .where(or_(
                ScriptDraft.cover_url == None,  # noqa: E711
                ScriptDraft.cover_url == "",
                ScriptDraft.cover_url.like("%.svg"),
            ))
            .order_by(ScriptDraft.updated_at.desc())
            .limit(batch * 4)  # 多拉一些, 后面 cooldown / max_attempts 会过滤掉一部分
        )
        candidates = [r[0] for r in (await s.execute(stmt)).all()]

    if not candidates:
        return {
            "triggered": 0, "succeeded": 0, "fallback": 0,
            "skipped_cooldown": 0, "skipped_max_attempts": 0,
            "candidates": 0,
        }

    tracker = _RETRY_DAEMON["tracker"]
    for did in candidates:
        if triggered >= batch:
            break
        rec = tracker.get(did) or {"attempts": 0, "last_at": 0.0}
        if rec["attempts"] >= max_attempts:
            skipped_max_attempts += 1
            continue
        if rec["last_at"] and (now - rec["last_at"]) < cooldown:
            skipped_cooldown += 1
            continue

        # 触发重试 (_generate_one 内部已经有 3 次 retry + svg fallback)
        triggered += 1
        rec["attempts"] += 1
        rec["last_at"] = time.time()
        tracker[did] = rec

        try:
            res = await _generate_one(did)
            kind = res.get("kind")
            if res.get("status") == "done":
                if kind == "ai":
                    succeeded += 1
                    # 出图成功就把它从 tracker 里清掉, 让以后用户改了大纲再重生时
                    # 不被"max_attempts 用完"卡住
                    tracker.pop(did, None)
                elif kind == "svg":
                    fallback += 1
            logger.info(
                "draft_cover retry daemon: #%d → %s/%s (attempts %d)",
                did, res.get("status"), kind, rec["attempts"],
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("draft_cover retry daemon: #%d unexpected %s", did, e)

    async with _RETRY_DAEMON_LOCK:
        _RETRY_DAEMON["last_round_at"] = time.time()
        _RETRY_DAEMON["rounds"] = int(_RETRY_DAEMON.get("rounds", 0)) + 1
        _RETRY_DAEMON["triggered_total"] = int(_RETRY_DAEMON.get("triggered_total", 0)) + triggered
        _RETRY_DAEMON["succeeded_total"] = int(_RETRY_DAEMON.get("succeeded_total", 0)) + succeeded
        _RETRY_DAEMON["fallback_total"] = int(_RETRY_DAEMON.get("fallback_total", 0)) + fallback

    return {
        "triggered": triggered, "succeeded": succeeded, "fallback": fallback,
        "skipped_cooldown": skipped_cooldown,
        "skipped_max_attempts": skipped_max_attempts,
        "candidates": len(candidates),
    }


async def run_cover_retry_daemon():
    """常驻 worker: 每 interval_sec 跑一轮.

    被 main.py 的 lifespan 调起, 容器停止时会被 cancel.
    """
    _retry_daemon_load_env()
    if not _RETRY_DAEMON["enabled"]:
        logger.info("draft_cover retry daemon disabled by env")
        return

    async with _RETRY_DAEMON_LOCK:
        _RETRY_DAEMON.update(running=True, started_at=time.time())

    logger.info(
        "draft_cover retry daemon started: interval=%ds batch=%d max_attempts=%d cooldown=%ds",
        _RETRY_DAEMON["interval_sec"], _RETRY_DAEMON["batch_per_round"],
        _RETRY_DAEMON["max_attempts_per_draft"], _RETRY_DAEMON["cooldown_sec"],
    )

    # 启动后稍等一会再开扫, 避免容器刚起来就和创建草稿/批量回填挤在一起
    await asyncio.sleep(60)

    try:
        while True:
            try:
                stats = await _retry_one_round()
                if stats["triggered"]:
                    logger.info(
                        "draft_cover retry round: triggered=%d ok=%d svg=%d "
                        "(cd_skipped=%d max_skipped=%d / cands=%d)",
                        stats["triggered"], stats["succeeded"], stats["fallback"],
                        stats["skipped_cooldown"], stats["skipped_max_attempts"],
                        stats["candidates"],
                    )
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                logger.warning("draft_cover retry daemon round failed: %s", e)
            await asyncio.sleep(_RETRY_DAEMON["interval_sec"])
    except asyncio.CancelledError:
        logger.info("draft_cover retry daemon cancelled")
    finally:
        async with _RETRY_DAEMON_LOCK:
            _RETRY_DAEMON.update(running=False)


@router.get("/admin/cover/retry-daemon/status")
async def api_retry_daemon_status(_admin: User = Depends(require_admin)):
    """admin 看自动重试守护进程的状态."""
    async with _RETRY_DAEMON_LOCK:
        snap = {k: v for k, v in _RETRY_DAEMON.items() if k != "tracker"}
        snap["tracked_drafts"] = len(_RETRY_DAEMON["tracker"])
    return snap


class RetryDaemonConfigBody(BaseModel):
    interval_sec: int | None = None
    batch_per_round: int | None = None
    max_attempts_per_draft: int | None = None
    cooldown_sec: int | None = None
    enabled: bool | None = None


@router.post("/admin/cover/retry-daemon/config")
async def api_retry_daemon_config(
    body: RetryDaemonConfigBody,
    _admin: User = Depends(require_admin),
):
    """admin 热改自动重试守护配置 (重启容器后从环境变量重新加载)."""
    async with _RETRY_DAEMON_LOCK:
        if body.interval_sec is not None:
            _RETRY_DAEMON["interval_sec"] = max(60, int(body.interval_sec))
        if body.batch_per_round is not None:
            _RETRY_DAEMON["batch_per_round"] = max(1, int(body.batch_per_round))
        if body.max_attempts_per_draft is not None:
            _RETRY_DAEMON["max_attempts_per_draft"] = max(1, int(body.max_attempts_per_draft))
        if body.cooldown_sec is not None:
            _RETRY_DAEMON["cooldown_sec"] = max(60, int(body.cooldown_sec))
        if body.enabled is not None:
            _RETRY_DAEMON["enabled"] = bool(body.enabled)
        return {k: v for k, v in _RETRY_DAEMON.items() if k != "tracker"}


@router.post("/admin/cover/retry-daemon/run-now")
async def api_retry_daemon_run_now(_admin: User = Depends(require_admin)):
    """admin 手动触发立即跑一轮 (不影响后续定时调度)."""
    stats = await _retry_one_round()
    return {"ok": True, "round": stats}


@router.post("/admin/cover/retry-daemon/reset-tracker")
async def api_retry_daemon_reset(
    draft_id: int | None = None,
    _admin: User = Depends(require_admin),
):
    """admin 重置 tracker:
       - draft_id 为 None: 清空全部, 让所有"已用完次数"的草稿能再次自动重试
       - 指定 draft_id: 只清这一张
    """
    async with _RETRY_DAEMON_LOCK:
        if draft_id is None:
            n = len(_RETRY_DAEMON["tracker"])
            _RETRY_DAEMON["tracker"] = {}
            return {"reset": "all", "count": n}
        _RETRY_DAEMON["tracker"].pop(draft_id, None)
        return {"reset": draft_id}
