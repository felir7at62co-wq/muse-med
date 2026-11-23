"""Clocks, ISO timestamps, atomic files and the advisory helper lock."""
from __future__ import annotations

import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import secrets
import threading
import time


class Clock:
    """Wall time plus a clock that stops while the Mac sleeps.

    On macOS `CLOCK_UPTIME_RAW` does not advance during sleep, so a wall-clock delta that exceeds the uptime delta
    reveals a sleep gap. Elsewhere `time.monotonic` is used (tests replace the whole clock).
    """

    def wall(self) -> float:
        """Current POSIX time in seconds."""
        return time.time()

    def uptime(self) -> float:
        """Seconds that do not advance while the machine sleeps."""
        if hasattr(time, 'CLOCK_UPTIME_RAW'):
            return time.clock_gettime(time.CLOCK_UPTIME_RAW)
        return time.monotonic()

    def sleep(self, seconds: float, stop: threading.Event) -> bool:
        """Wait up to `seconds` or until `stop` is set; returns whether `stop` is set."""
        return stop.wait(max(0.0, seconds))


def iso(timestamp: float, tz: dt.tzinfo) -> str:
    """Format a POSIX timestamp as second-precision ISO 8601 with the offset of `tz`."""
    return dt.datetime.fromtimestamp(int(timestamp), tz).isoformat()


def parse_iso(value: object) -> float | None:
    """Parse an offset-aware ISO 8601 string; anything else yields `None`."""
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed.timestamp() if parsed.tzinfo is not None else None


def write_atomic(path: Path, raw: bytes, mode: int = 0o600) -> None:
    """Replace `path` with `raw` via a same-directory temporary file, fsync and rename, so readers never see a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name('.' + path.name + '.' + secrets.token_hex(6) + '.tmp')
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def write_json(path: Path, value: object) -> None:
    """Write `value` as UTF-8 JSON atomically with mode 0600."""
    write_atomic(path, (json.dumps(value, ensure_ascii=False, indent=1) + '\n').encode('utf8'))


def read_json(path: Path, limit: int = 4 << 20) -> dict | None:
    """Return the JSON object at `path`, or `None` when it is missing, oversized or not an object."""
    try:
        if path.stat().st_size > limit:
            return None
        value = json.loads(path.read_text(encoding='utf8'))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


class FileLock:
    """Non-blocking `flock` on a shared lock file; the kernel releases it when the holder dies.

    The Muse desktop plugin can take the same lock before it starts its own helper, so only one helper binds 127.0.0.1:9421.
    """

    def __init__(self, path: Path):
        self.path = path
        self._descriptor: int | None = None

    def acquire(self) -> bool:
        """Take the lock if it is free; returns `False` when another process holds it."""
        if self._descriptor is not None:
            return True
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(descriptor)
            return False
        os.ftruncate(descriptor, 0)
        os.write(descriptor, json.dumps({'pid': os.getpid(), 'owner': 'lvpaopao-collector'}).encode() + b'\n')
        self._descriptor = descriptor
        return True

    def release(self) -> None:
        """Release the lock if this object holds it."""
        if self._descriptor is None:
            return
        try:
            fcntl.flock(self._descriptor, fcntl.LOCK_UN)
        finally:
            os.close(self._descriptor)
            self._descriptor = None
