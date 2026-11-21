"""素材缓存管家：上传进桶、按水位淘汰本地副本、记录元数据。

## 分工

- `app/storage.py` 只管"怎么跟桶说话"（签名、PUT/GET/HEAD/DELETE）。
- 本模块管"什么时候传、什么时候删"，以及 `media_objects` 台账的维护。

## 直传为主，扫目录补传

各写入点写完文件就经 `media_store.commit` 直传进桶（失败只记日志，不判
生成失败）。本模块的巡检扫托管目录，把直传失败或漏掉的文件补传上去：
桶挂了也只是这一轮没传上，下一轮继续。刚写出不到 `FRESH_SEC` 的文件跳过，
那是写入点自己正在传、甚至还没写完的文件。

## 删本地的前提是"确认传成功"

`put_file` 会比对 ETag（TOS 非分片上传回的是内容 MD5）。只有比对通过、
且台账落了库，本地文件才有资格进入淘汰候选——否则就是**不可逆地丢数据**。
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import text

from . import storage
from .config import get_settings
from .db import engine
from .media import DATA_DIR

logger = logging.getLogger(__name__)

#: 单轮最多传多少个。巡检 300 秒一轮，不限量的话首轮会试图传 8000 个文件、
#: 把带宽和事件循环占满几十分钟；分摊到多轮对用户无感。
UPLOAD_BATCH = 300

#: 淘汰候选的最小年龄（秒）。刚生成的文件极可能马上被读（抽帧、注入参考图），
#: 删了立刻要从桶拉回，纯属来回折腾。`FW_MEDIA_KEEP_LOCAL=false` 时，不属于
#: 任何任务的本地副本也按这个年龄删（`media_store.drop_stray_local`）。
MIN_AGE_SEC = 3600

#: 补传跳过多新的文件（秒）。写入点直传完之前，巡检不去碰它。
FRESH_SEC = 120


def _managed_dirs() -> list[Path]:
    return [DATA_DIR / d for d in get_settings().tos_dirs]


def _rel(p: Path) -> str:
    return p.relative_to(DATA_DIR).as_posix()


# ---------------- 元数据（给剪映导出用） ----------------

_VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm"}
_AUDIO_EXT = {".mp3", ".wav", ".aac", ".m4a", ".flac"}
_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}


def probe_meta(p: Path) -> dict:
    """探测宽高与时长。**只在文件还在本地时做**（上传前那一刻）。

    剪映草稿构造原本靠 pyJianYingDraft 自己 ffprobe 本地文件，素材进桶后那条路
    就断了。在这里记一次，导出时直接读表——否则 601 镜的项目导出要先把几十 GB
    拉回本地，只为读几个数字。
    """
    ext = p.suffix.lower()
    out = {"width": None, "height": None, "duration_us": None}
    if ext not in _VIDEO_EXT | _AUDIO_EXT | _IMAGE_EXT:
        return out
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0" if ext not in _AUDIO_EXT else "a:0",
             "-show_entries", "stream=width,height:format=duration",
             "-of", "default=noprint_wrappers=1", str(p)],
            capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            return out
        for line in r.stdout.splitlines():
            k, _, v = line.partition("=")
            if k == "width" and v.isdigit():
                out["width"] = int(v)
            elif k == "height" and v.isdigit():
                out["height"] = int(v)
            elif k == "duration":
                try:
                    out["duration_us"] = int(round(float(v) * 1_000_000))
                except ValueError:
                    pass
    except (subprocess.TimeoutExpired, OSError):
        logger.debug("[cache] 探测元数据失败: %s", p.name, exc_info=True)
    return out


# ---------------- 上传 ----------------

def upload_pending(limit: int = UPLOAD_BATCH) -> dict:
    """扫托管目录，把还没进台账的文件传进桶。返回 {uploaded, failed, bytes}。"""
    if not storage.enabled():
        return {"uploaded": 0, "failed": 0, "bytes": 0, "skipped": "未配置桶"}

    from .media_store import managed_rel

    with engine.begin() as conn:
        known = {r[0] for r in conn.execute(text("SELECT rel_path FROM media_objects"))}

    fresh = datetime.now(timezone.utc).timestamp() - FRESH_SEC
    todo: list[Path] = []
    for d in _managed_dirs():
        if not d.is_dir():
            continue
        for p in d.rglob("*"):
            try:
                if not p.is_file() or p.stat().st_mtime > fresh:
                    continue
            except OSError:
                continue
            rel = _rel(p)
            if rel in known or not managed_rel(rel):
                continue
            todo.append(p)
            if len(todo) >= limit:
                break
        if len(todo) >= limit:
            break

    from .media_store import content_type_for, note_failure, upsert_ledger

    up = fail = total = 0
    for p in todo:
        rel = _rel(p)
        try:
            meta = probe_meta(p)
            r = storage.put_file(p, rel, content_type=content_type_for(p.name))
            upsert_ledger(rel, key=r["key"], size=r["size"], etag=r["etag"], meta=meta)
        except Exception as e:      # noqa: BLE001
            fail += 1
            note_failure("upload", rel, e)
            continue
        up += 1
        total += r["size"]
    return {"uploaded": up, "failed": fail, "bytes": total}


# ---------------- 淘汰 ----------------

def disk_pct() -> float:
    u = shutil.disk_usage(DATA_DIR)
    return u.used / u.total * 100 if u.total else 0.0


def evict(*, high: int | None = None, low: int | None = None) -> dict:
    """盘用量超过 high% 时，按最久未用删本地副本，降到 low% 为止。

    只删**台账里有、且远端确实存在**的文件。不做这道检查的话，一次失败的上传
    加一次乐观删除就等于永久丢素材——而素材是花钱生成的、不可再生。
    """
    s = get_settings()
    high = s.cache_disk_high_pct if high is None else high
    low = s.cache_disk_low_pct if low is None else low
    if not storage.enabled():
        return {"evicted": 0, "bytes": 0, "skipped": "未配置桶"}

    pct = disk_pct()
    if pct < high:
        return {"evicted": 0, "bytes": 0, "disk_pct": round(pct, 1)}

    u = shutil.disk_usage(DATA_DIR)
    need = int(u.used - u.total * low / 100)       # 要腾出的字节数
    logger.info("[cache] 盘用量 %.1f%% 超过 %d%%，需腾出 %.1f GB",
                pct, high, need / 1073741824)

    cutoff = datetime.now(timezone.utc).timestamp() - MIN_AGE_SEC
    freed = n = 0
    with engine.begin() as conn:
        rows = conn.execute(text("""
            SELECT rel_path, size, etag FROM media_objects
            WHERE uploaded_at IS NOT NULL
            ORDER BY COALESCE(last_used_at, uploaded_at) ASC
        """)).fetchall()

    for rel, size, etag in rows:
        if freed >= need:
            break
        p = DATA_DIR / rel
        if not p.is_file():
            continue
        try:
            if p.stat().st_mtime > cutoff:
                continue                      # 太新，留着
        except OSError:
            continue
        # 删之前再确认远端真的有，且大小对得上
        try:
            h = storage.head(rel)
        except Exception:      # noqa: BLE001
            logger.warning("[cache] HEAD 失败，跳过淘汰: %s", rel)
            continue
        if not h or (size and h["size"] != size):
            logger.warning("[cache] 远端缺失/大小不符，**不删**本地: %s", rel)
            continue
        try:
            p.unlink()
        except OSError:
            continue
        freed += size or 0
        n += 1
    if n:
        logger.info("[cache] 淘汰 %d 个本地副本，释放 %.1f GB → 盘用量 %.1f%%",
                    n, freed / 1073741824, disk_pct())
    return {"evicted": n, "bytes": freed, "disk_pct": round(disk_pct(), 1)}


def sweep_export_objects(ttl_sec: int | None = None) -> int:
    """导出包在桶里的副本按导出包的 TTL 删（本地那份由 `jianying.sweep_exports` 删）。
    返回删掉的个数。"""
    if not storage.enabled():
        return 0
    if ttl_sec is None:
        from .routers.jianying import EXPORT_TTL_SEC
        ttl_sec = EXPORT_TTL_SEC
    cutoff = datetime.fromtimestamp(
        datetime.now(timezone.utc).timestamp() - ttl_sec, timezone.utc
    ).isoformat(timespec="seconds")
    with engine.begin() as conn:
        rels = [r[0] for r in conn.execute(text(
            "SELECT rel_path FROM media_objects "
            "WHERE rel_path LIKE 'exports/%' AND uploaded_at < :c"), {"c": cutoff})]
    n = 0
    for rel in rels:
        try:
            storage.delete(rel)
        except Exception:      # noqa: BLE001
            logger.warning("[cache] 删除过期导出包失败，下一轮重试: %s", rel)
            continue
        (DATA_DIR / rel).unlink(missing_ok=True)
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM media_objects WHERE rel_path=:r"), {"r": rel})
        from .providers.base import invalidate_in_ledger
        invalidate_in_ledger(rel)
        n += 1
    return n


def sweep() -> dict:
    """一轮：补传、删过期导出包、按设置删本地副本、按水位淘汰，
    最后记一行本周期的计数。供常驻巡检调用。"""
    from . import media_store

    up = upload_pending()
    exports = 0
    local = 0
    try:
        exports = sweep_export_objects()
        local = media_store.drop_stray_local(MIN_AGE_SEC)
    except Exception as e:      # noqa: BLE001
        logger.warning("[cache] 本地副本清理失败: %s", media_store.brief_error(e))
    ev = evict()
    if storage.enabled():
        c = media_store.take_counts()
        logger.info(
            "[media] 本周期：直传 %d，补传 %d，上传失败 %d，回填 %d，回填失败 %d，"
            "删本地 %d，过期导出包 %d，淘汰 %d",
            c["uploaded"], up.get("uploaded", 0), c["upload_failed"],
            c["restored"], c["restore_failed"], c["local_deleted"], exports,
            ev.get("evicted", 0))
    return {"upload": up, "evict": ev, "exports": exports, "local_deleted": local}


def ledger_sizes(paths: list[Path]) -> dict[Path, int]:
    """台账里登记过的文件 → 大小。用于"本地已淘汰但桶里还有"的场景。"""
    rels: dict[str, Path] = {}
    for p in paths:
        try:
            rels[p.resolve().relative_to(DATA_DIR.resolve()).as_posix()] = p
        except (ValueError, OSError):
            continue
    if not rels:
        return {}
    out: dict[Path, int] = {}
    keys = list(rels)
    with engine.begin() as conn:
        for i in range(0, len(keys), 500):
            chunk = keys[i:i + 500]
            ph = ",".join(f":p{j}" for j in range(len(chunk)))
            params = {f"p{j}": v for j, v in enumerate(chunk)}
            for r in conn.execute(text(
                    f"SELECT rel_path, size FROM media_objects "
                    f"WHERE rel_path IN ({ph})"), params):
                out[rels[r[0]]] = r[1] or 0
    return out


def drop_media(p: Path) -> None:
    """彻底删掉一份素材：本地副本 + 桶里的对象 + 台账行。

    顺序是**先删远端再删本地**：反过来一旦远端删除失败，本地已经没了、
    台账也可能已清，那个对象就成了没人认领的孤儿，只能靠对账脚本捞回来。
    远端先失败的话本地还在，重试一次即可。

    不在托管目录下的文件（outputs / work / appcast）照旧只删本地。
    """
    try:
        rel = p.resolve().relative_to(DATA_DIR.resolve()).as_posix()
    except (ValueError, OSError):
        p.unlink(missing_ok=True)
        return
    managed = rel.split("/", 1)[0] in set(get_settings().tos_dirs)
    if managed and storage.enabled():
        try:
            storage.delete(rel)
        except Exception:      # noqa: BLE001
            logger.warning("[cache] 删除远端对象失败，本地保留待重试: %s", rel)
            return
        try:
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM media_objects WHERE rel_path=:r"),
                             {"r": rel})
        except Exception:      # noqa: BLE001
            logger.warning("[cache] 台账清理失败: %s", rel, exc_info=True)
        # 台账行没了，`_in_ledger` 的进程内缓存必须一起失效 —— 否则它还会
        # 说"这个对象在桶里"，出片拿到一个已经 404 的地址（2026-10-24）。
        from .providers.base import invalidate_in_ledger
        invalidate_in_ledger(rel)
    p.unlink(missing_ok=True)


def meta_of(rel_paths: list[str]) -> dict[str, dict]:
    """批量取元数据（剪映导出用）。返回 {rel_path: {size,width,height,duration_us}}。"""
    if not rel_paths:
        return {}
    out: dict[str, dict] = {}
    with engine.begin() as conn:
        # 分批 IN，避免 SQLite 的变量数上限（999）
        for i in range(0, len(rel_paths), 500):
            chunk = rel_paths[i:i + 500]
            ph = ",".join(f":p{j}" for j in range(len(chunk)))
            params = {f"p{j}": v for j, v in enumerate(chunk)}
            for r in conn.execute(text(
                    f"SELECT rel_path, size, width, height, duration_us "
                    f"FROM media_objects WHERE rel_path IN ({ph})"), params):
                out[r[0]] = {"size": r[1], "width": r[2], "height": r[3],
                             "duration_us": r[4]}
    return out
