"""媒体落桶：文件一写完就进 TOS、记台账，返回永久地址 `/fw/media/<rel>`。

## 谁用它

每个把生成结果或上传文件写进 `DATA_DIR` 托管目录（`settings.tos_dirs`）的地方，
写完都调 `store_bytes` / `commit`（异步代码用 `*_async`）：

- 图片的字节本来就在内存里，`store_bytes` 写盘后直接用这份字节上传，不再读盘；
- 视频、音频、缩略图、导出包先落盘，`commit` 再按文件上传。

上传在任务被标成完成**之前**做完，所以出片结束时桶里已经有这份文件；
5 分钟一轮的 `media_cache.upload_pending` 只负责补传这里失败或漏掉的文件。

## 失败不连累生成

上传失败只记一行日志、计一次数，照常返回地址：文件还在本地，巡检下一轮补传。
没配桶（`storage.enabled()` 为假）时只写盘，不碰台账，行为与接入前完全相同。

## 本地副本什么时候删

`settings.media_keep_local` 为真（默认）时从不删。为假时：

- 任务（`job_submit._run_job_guarded`）开一个「作用域」，作用域里写出的文件
  在任务结束时删本地副本；
- 另一个仍在运行的任务读过同一个文件（`media.ensure_local*` 记读取）时不删，
  改由那个任务结束时再删；
- 不属于任何任务的文件（接口里直接写的、回填回来的缓存）由巡检
  `drop_stray_local` 在文件满一定年龄后删。

删之前都核对：台账有这一行、本地大小与台账一致、HEAD 桶里对象存在且大小一致。
任何一项不满足就保留本地文件。
"""
from __future__ import annotations

import logging
import mimetypes
import re
import threading
import time
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

from sqlalchemy import text

from . import storage
from .config import get_settings
from .executors import run_long_blocking

logger = logging.getLogger(__name__)

#: 库里与客户端使用的两种媒体地址前缀。
URL_PREFIXES = ("/fw/media/", "/fwp/media/")

#: 文件名（单个路径段）的最大长度。
MAX_SEGMENT = 200

#: 无论 `tos_dirs` 怎么配都不能当成媒体目录对外签名的目录：库备份。
_PRIVATE_DIRS = frozenset({"backups"})

#: 一个路径段里不允许的字符：控制字符、路径分隔符。
_BAD_SEGMENT = re.compile(r"[\x00-\x1f\x7f/\\]")

#: 扩展名 → Content-Type。`mimetypes` 在不同系统上对这几种给的值不一样，固定下来。
_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac", ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".zip": "application/zip", ".bat": "application/octet-stream",
}


def content_type_for(name: str) -> str:
    """按扩展名给 Content-Type；认不出的给 `application/octet-stream`。"""
    ext = Path(name).suffix.lower()
    return _TYPES.get(ext) or mimetypes.guess_type(name)[0] or "application/octet-stream"


def _data_dir() -> Path:
    from .media import DATA_DIR
    return DATA_DIR


# ---------------------------------------------------------------- 路径

def _safe_segment(seg: str) -> bool:
    return (0 < len(seg) <= MAX_SEGMENT and seg == seg.strip()
            and not seg.startswith(".") and not seg.endswith(".part")
            and not _BAD_SEGMENT.search(seg))


def managed_rel(rel: str) -> bool:
    """`rel`（相对 DATA_DIR）是否是一个归桶管、可以对外签名的文件。

    形如 `<托管目录>/<文件名>`；导出包只认 `exports/jianying/<文件名>`
    （打包中途的临时目录 `exports/jianying/<包名>/...` 不算）。
    """
    parts = rel.split("/")
    top = parts[0]
    if top in _PRIVATE_DIRS or top not in set(get_settings().tos_dirs):
        return False
    if top == "exports":
        if len(parts) != 3 or parts[1] != "jianying":
            return False
    elif len(parts) != 2:
        return False
    return all(_safe_segment(p) for p in parts[1:])


def parse_media_path(path: object) -> tuple[str | None, str | None]:
    """客户端给的地址 → `(rel, None)` 或 `(None, 错误码)`。

    接受 `/fw/media/...` 与 `/fwp/media/...`，去掉查询串与片段，百分号解码一次。
    错误码：`invalid`（不是媒体地址、带 `..`/控制字符/空段等）、
    `not_in_tos`（格式正确但目录不归桶管，例如 `outputs/`）。
    """
    if not isinstance(path, str) or not path or len(path) > 1024:
        return None, "invalid"
    for pre in URL_PREFIXES:
        if path.startswith(pre):
            raw = path[len(pre):]
            break
    else:
        return None, "invalid"
    raw = raw.split("?", 1)[0].split("#", 1)[0]
    rel = unquote(raw)
    if managed_rel(rel):
        return rel, None
    parts = rel.split("/")
    if (len(parts) >= 2 and parts[0] not in _PRIVATE_DIRS
            and all(_safe_segment(p) for p in parts)):
        return None, "not_in_tos"
    return None, "invalid"


def url_for(rel: str) -> str:
    return f"/fw/media/{rel}"


def rel_of_path(p: Path) -> str | None:
    """本地绝对路径 → 相对 DATA_DIR 的 rel；不在 DATA_DIR 下返回 None。"""
    try:
        return p.resolve().relative_to(_data_dir().resolve()).as_posix()
    except (ValueError, OSError):
        return None


# ---------------------------------------------------------------- 台账

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def upsert_ledger(rel: str, *, key: str, size: int, etag: str,
                  meta: dict | None = None) -> None:
    """写（或覆盖）`media_objects` 的一行。直传与巡检补传都走这里，
    同一个文件被两边各传一次时只留一行，以后写的为准。"""
    from .db import engine
    m = meta or {}
    with engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO media_objects
              (rel_path, obj_key, size, etag, width, height, duration_us,
               uploaded_at, last_used_at)
            VALUES (:rel, :key, :size, :etag, :w, :h, :dur, :now, :now)
            ON CONFLICT(rel_path) DO UPDATE SET
              obj_key=excluded.obj_key, size=excluded.size, etag=excluded.etag,
              width=COALESCE(excluded.width, media_objects.width),
              height=COALESCE(excluded.height, media_objects.height),
              duration_us=COALESCE(excluded.duration_us, media_objects.duration_us),
              uploaded_at=excluded.uploaded_at
        """), {"rel": rel, "key": key, "size": int(size), "etag": etag or "",
               "w": m.get("width"), "h": m.get("height"), "dur": m.get("duration_us"),
               "now": _now()})
    # 出片热路径上的「在不在桶里」缓存：刚写进台账的文件要立刻转正
    from .providers.base import invalidate_in_ledger
    invalidate_in_ledger(rel)


def ledger_rows(rels: list[str]) -> dict[str, dict]:
    """批量取台账行：{rel: {size, etag}}。"""
    from .db import engine
    out: dict[str, dict] = {}
    with engine.begin() as conn:
        for i in range(0, len(rels), 500):
            chunk = rels[i:i + 500]
            ph = ",".join(f":p{j}" for j in range(len(chunk)))
            params = {f"p{j}": v for j, v in enumerate(chunk)}
            for r in conn.execute(text(
                    f"SELECT rel_path, size, etag FROM media_objects "
                    f"WHERE rel_path IN ({ph})"), params):
                out[r[0]] = {"size": r[1] or 0, "etag": r[2] or ""}
    return out


# ---------------------------------------------------------------- 计数与失败日志

_COUNT_NAMES = ("uploaded", "upload_failed", "restored", "restore_failed",
                "local_deleted", "check_failed", "backup_failed")
_COUNTS: dict[str, int] = dict.fromkeys(_COUNT_NAMES, 0)
_COUNTS_LOCK = threading.Lock()

_FAILURE_LABELS = {"upload": "上传", "restore": "回填", "check": "删本地前核对",
                   "backup": "备份进桶"}

_URL_RE = re.compile(r"https?://\S+")


def count(name: str, n: int = 1) -> None:
    with _COUNTS_LOCK:
        _COUNTS[name] = _COUNTS.get(name, 0) + n


def take_counts() -> dict[str, int]:
    """取出本周期的计数并清零。"""
    with _COUNTS_LOCK:
        out = dict(_COUNTS)
        for k in _COUNTS:
            _COUNTS[k] = 0
    return out


def brief_error(exc: BaseException) -> str:
    """异常的一句话摘要，去掉其中的地址（预签名地址里带凭据与签名）。"""
    msg = _URL_RE.sub("<url>", str(exc)).strip().replace("\n", " ")[:120]
    return f"{type(exc).__name__}: {msg}" if msg else type(exc).__name__


def note_failure(what: str, rel: str, exc: BaseException) -> None:
    """记一次上传 / 回填 / 核对失败：一行日志，不带地址与密钥，不打堆栈。"""
    count(f"{what}_failed")
    logger.warning("[media] %s失败 %s: %s", _FAILURE_LABELS.get(what, what), rel,
                   brief_error(exc))


# ---------------------------------------------------------------- 作用域（任务）

@dataclass(eq=False)
class MediaScope:
    """一次任务执行期间写出与读过的文件（rel）。"""

    written: set[str] = field(default_factory=set)
    read: set[str] = field(default_factory=set)
    token: Token | None = None


_SCOPE: ContextVar[MediaScope | None] = ContextVar("fw_media_scope", default=None)
_ACTIVE: set[MediaScope] = set()
_SCOPE_LOCK = threading.Lock()

#: 不在任何任务里的读取（接口直接读文件）：rel → 最近一次读取的 monotonic 时刻。
#: 这段时间内不删它的本地副本，免得刚交出去的路径马上失效。
_UNSCOPED_READS: dict[str, float] = {}
UNSCOPED_READ_HOLD_SEC = 600.0


def open_scope() -> MediaScope:
    """在当前上下文里开一个作用域。与 `close_scope` 成对，在同一个协程里调用。"""
    scope = MediaScope()
    scope.token = _SCOPE.set(scope)
    with _SCOPE_LOCK:
        _ACTIVE.add(scope)
    return scope


def close_scope(scope: MediaScope) -> None:
    """结束作用域（不做 I/O）。之后再调 `drop_local_copies(scope)` 删本地副本。"""
    with _SCOPE_LOCK:
        _ACTIVE.discard(scope)
    if scope.token is not None:
        try:
            _SCOPE.reset(scope.token)
        except ValueError:
            # 不在开它的那个上下文里：作用域已从 _ACTIVE 摘掉，变量随上下文一起丢弃
            pass
        scope.token = None


def _track_written(rel: str) -> None:
    scope = _SCOPE.get()
    if scope is not None:
        with _SCOPE_LOCK:
            scope.written.add(rel)


def note_read(rel: str) -> None:
    """`media.ensure_local*` 交出一个本地路径时调用。"""
    scope = _SCOPE.get()
    if scope is not None:
        with _SCOPE_LOCK:
            scope.read.add(rel)
    else:
        with _SCOPE_LOCK:
            _UNSCOPED_READS[rel] = time.monotonic()
            if len(_UNSCOPED_READS) > 20000:
                _UNSCOPED_READS.clear()


def note_restored(rel: str) -> None:
    """`media.ensure_local*` 从桶里拉回了一个本地副本。"""
    count("restored")
    _track_written(rel)
    note_read(rel)


def _held(rel: str) -> MediaScope | bool | None:
    """仍在用这个文件的作用域；不在作用域里的近期读取返回 True；没人用返回 None。"""
    with _SCOPE_LOCK:
        for s in _ACTIVE:
            if rel in s.read or rel in s.written:
                return s
        t = _UNSCOPED_READS.get(rel)
        if t is not None and time.monotonic() - t < UNSCOPED_READ_HOLD_SEC:
            return True
    return None


def _may_drop_local() -> bool:
    return (not get_settings().media_keep_local) and storage.enabled()


def _drop_if_safe(rel: str, row: dict | None) -> bool:
    """确认桶里有完整的一份后删本地副本。返回是否删了。"""
    p = _data_dir() / rel
    try:
        size = p.stat().st_size
    except OSError:
        return False
    if not row or int(row.get("size") or 0) != size:
        return False
    try:
        h = storage.head(rel)
    except Exception as e:      # noqa: BLE001
        note_failure("check", rel, e)
        return False
    if not h or int(h.get("size") or 0) != size:
        return False
    try:
        p.unlink()
    except FileNotFoundError:
        return False
    count("local_deleted")
    return True


def drop_local_copies(scope: MediaScope) -> int:
    """作用域结束后删它写出的本地副本。同步（有 HEAD 请求），放线程里跑。

    别的仍在运行的作用域读过或写过同一个文件时不删，把它交给那个作用域。
    """
    if not scope.written or not _may_drop_local():
        return 0
    pending: list[str] = []
    for rel in sorted(scope.written):
        holder = _held(rel)
        if isinstance(holder, MediaScope):
            with _SCOPE_LOCK:
                holder.written.add(rel)
            continue
        if holder is True or not managed_rel(rel):
            continue
        pending.append(rel)
    if not pending:
        return 0
    rows = ledger_rows(pending)
    return sum(1 for rel in pending if _drop_if_safe(rel, rows.get(rel)))


def drop_stray_local(min_age_sec: float) -> int:
    """巡检用：删不属于任何作用域、满 `min_age_sec` 的本地副本。"""
    if not _may_drop_local():
        return 0
    cutoff = time.time() - min_age_sec
    base = _data_dir()
    cands: list[str] = []
    for d in get_settings().tos_dirs:
        root = base / d
        if not root.is_dir():
            continue
        for p in root.rglob("*"):
            try:
                if not p.is_file() or p.stat().st_mtime > cutoff:
                    continue
            except OSError:
                continue
            rel = p.relative_to(base).as_posix()
            if managed_rel(rel) and _held(rel) is None:
                cands.append(rel)
    if not cands:
        return 0
    rows = ledger_rows(cands)
    return sum(1 for rel in cands if rel in rows and _drop_if_safe(rel, rows[rel]))


# ---------------------------------------------------------------- 写入

def commit(path: Path, *, data: bytes | None = None) -> str:
    """`path` 已经完整写好：传进桶、写台账，返回 `/fw/media/<rel>`。同步，会阻塞。

    `data` 非空时它就是文件内容，直接从内存上传。上传失败只记日志
    （见模块头），不抛异常。`path` 必须在 DATA_DIR 下。
    """
    rel = rel_of_path(path)
    if rel is None:
        raise ValueError(f"不在数据目录下：{path.name}")
    _track_written(rel)
    if not storage.enabled() or not managed_rel(rel):
        return url_for(rel)
    try:
        from .media_cache import probe_meta
        meta = probe_meta(path)
        ct = content_type_for(path.name)
        if data is not None:
            r = storage.put_bytes(data, rel, content_type=ct)
        else:
            r = storage.put_file(path, rel, content_type=ct)
        upsert_ledger(rel, key=r["key"], size=r["size"], etag=r["etag"], meta=meta)
        count("uploaded")
    except Exception as e:      # noqa: BLE001
        note_failure("upload", rel, e)
    return url_for(rel)


def store_bytes(data: bytes, dest: Path) -> str:
    """把字节写到 `dest`（先写临时文件再改名），再 `commit`。返回 `/fw/media/<rel>`。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    try:
        tmp.write_bytes(data)
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)
    return commit(dest, data=data)


async def commit_async(path: Path) -> str:
    """`commit` 的异步版：上传放进长阻塞池（见 `app/executors.py`）。"""
    return await run_long_blocking(commit, path)


async def store_bytes_async(data: bytes, dest: Path) -> str:
    return await run_long_blocking(store_bytes, data, dest)
