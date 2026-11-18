"""Use the data station's existing claim, heartbeat and delivery API."""

from datetime import datetime, timezone
from http.client import HTTPException
from ipaddress import ip_address
import json
from pathlib import Path
import re
import stat
from threading import Event, Lock, Thread
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import uuid4

from common import WorkError, digest, series_id

ACTIVE = ("downloading", "transcribing", "checking")
TERMINAL = ("published", "failed", "rejected", "needs-attention")


class StationError(WorkError):
    """A refused or unconfirmed data station request."""

    def __init__(self, status):
        super().__init__("STATION_UNAVAILABLE", f"数据站请求未确认（HTTP {status}）" if status else "数据站暂未响应")
        self.status = status


class NoRedirect(HTTPRedirectHandler):
    """Keep the station credential on its configured service."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def station_url(value):
    """Resolve the receiver to the on-host service port and fixed API path."""
    parsed = urlsplit(value)
    try:
        valid = parsed.scheme == "http" and ip_address(parsed.hostname or "").is_loopback and parsed.port
    except ValueError:
        valid = False
    if not valid or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path != "/api/service/hits":
        raise WorkError("STATION_ADDRESS", "爆款队列需要本机数据站地址")
    return value


def read_token(path):
    """Read an existing private credential without logging or copying it."""
    if not path.is_file() or path.resolve() != path or stat.S_IMODE(path.stat().st_mode) not in (0o600, 0o640):
        raise WorkError("STATION_AUTH", "数据站服务凭据需要普通私有文件")
    token = path.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"[A-Za-z0-9._~+/=-]{32,512}", token):
        raise WorkError("STATION_AUTH", "数据站服务凭据格式不正确")
    return token


class Station:
    """Read station jobs and perform idempotent updates under their real lease."""

    def __init__(self, base, token_file, timeout):
        self.base = station_url(base)
        self.token_file = Path(token_file)
        self.timeout = timeout
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, method, route, value=None, *, body=None, content_type=None):
        """Send a bounded request to the local station service."""
        headers = {"Accept": "application/json", "X-Muse-Data-Service-Token": read_token(self.token_file)}
        if value is not None:
            body = json.dumps(value, ensure_ascii=False).encode()
            content_type = "application/json"
        if content_type:
            headers["Content-Type"] = content_type
        try:
            with self.opener.open(Request(self.base + route, data=body, headers=headers, method=method),
                                  timeout=self.timeout) as response:
                data = response.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise StationError(None)
            result = json.loads(data)
            if not isinstance(result, dict):
                raise StationError(None)
            return result
        except HTTPError as error:
            error.close()
            raise StationError(error.code) from error
        except (OSError, URLError, HTTPException, ValueError) as error:
            raise StationError(None) from error

    def candidates(self):
        return self.request("GET", "/candidates?limit=500")

    def job(self, key):
        return self.request("GET", f"/jobs/{series_id(key)}")

    def claim(self, worker_id, key):
        return self.request("POST", "/claim", {"workerId": worker_id, "workId": "hongguo:" + series_id(key)})

    def progress(self, key, lease, **changes):
        return self.request("POST", f"/jobs/{series_id(key)}/progress", {"lease": lease, **changes})

    def attention(self, key, lease, code, message):
        return self.request("POST", f"/jobs/{series_id(key)}/fail", {
            "lease": lease, "stage": code, "reason": message[:420], "needsAttention": True, "retryable": False,
        })

    def reject(self, key, lease, reason):
        return self.request("POST", f"/jobs/{series_id(key)}/reject", {"lease": lease, "reason": reason[:420]})

    def publish(self, key, lease, manuscript, verification):
        """Send a locally checked complete script through the existing idempotent upload."""
        if manuscript.stat().st_size > 20 * 1024 * 1024 or digest(manuscript) != verification["scriptSHA256"]:
            raise WorkError("DELIVERY_CHANGED", "全集稿件与已核对版本不一致")
        source = manuscript.read_bytes()
        boundary = "MuseHit" + uuid4().hex
        checks = json.dumps({"passed": True, "summary": f'{verification["episodes"]} 集已完成原片、字幕、看帧和稿件版本检查'},
                            ensure_ascii=False).encode()
        parts = [
            ("lease", "", lease.encode()),
            ("checks", "", checks),
            ("file", '; filename="screenplay.md"\r\nContent-Type: text/markdown', source),
        ]
        body = b"".join(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"{suffix}\r\n\r\n'.encode()
                        + value + b"\r\n" for name, suffix, value in parts) + f"--{boundary}--\r\n".encode()
        return self.request("POST", f"/jobs/{series_id(key)}/script", body=body,
                            content_type="multipart/form-data; boundary=" + boundary)


class Lease:
    """Refresh and supervise one lease while the worker owns a native process."""

    def __init__(self, station, key, lease, worker_id, interval):
        self.station, self.key, self.value, self.worker_id = station, key, lease, worker_id
        self.interval = interval
        self.stop = Event()
        self.lock = Lock()
        self.fault = None
        self.expires = None
        self.thread = Thread(target=self.maintain, name="muse-station-heartbeat")

    def __enter__(self):
        self.update()
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        self.thread.join()

    def check(self):
        if self.fault or self.expires is None or datetime.now(timezone.utc) >= self.expires:
            raise WorkError("LEASE_UNCONFIRMED", "数据站租约未确认，已保留进度")

    def update(self, **values):
        """Refresh the lease and optionally send durable episode progress."""
        with self.lock:
            if self.fault:
                self.check()
            row = self.station.progress(self.key, self.value, **values)
            try:
                expires = datetime.fromisoformat(row["leaseExpiresAt"])
                valid = (row["workId"] == "hongguo:" + self.key and row["workerId"] == self.worker_id and
                         row["state"] in ACTIVE and expires > datetime.now(timezone.utc))
            except (KeyError, TypeError, ValueError):
                valid = False
            if not valid:
                self.fault = True
                self.check()
            self.expires = expires
            return row

    def maintain(self):
        while True:
            delay = min(self.interval, max(1, (self.expires - datetime.now(timezone.utc)).total_seconds() / 3))
            if self.stop.wait(delay):
                return
            try:
                self.update()
            except WorkError:
                self.fault = True
                return
