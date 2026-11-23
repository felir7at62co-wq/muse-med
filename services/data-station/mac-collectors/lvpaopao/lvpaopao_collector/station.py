"""HTTPS client for the data station's `/api/service/lvpaopao/*` routes (docs/lvpaopao.md)."""
from __future__ import annotations

import base64
from dataclasses import dataclass
import json
import ssl
import urllib.error
import urllib.request

from .util import iso

MAX_BODY = 2 * 1024 * 1024


@dataclass(frozen=True)
class Response:
    """HTTP status (0 for network failure) and the parsed JSON body (or `None`)."""

    status: int
    body: dict | None

    @property
    def ok(self) -> bool:
        """2xx."""
        return 200 <= self.status < 300

    @property
    def retryable(self) -> bool:
        """Network errors, 5xx, 408 and 429 are retried with backoff; other 4xx are not."""
        return self.status == 0 or self.status >= 500 or self.status in (408, 429)


class Station:
    """Token-authenticated JSON client. The token is read once and never logged."""

    def __init__(self, config, token: str, clock):
        self.base = config['station']['baseUrl'].rstrip('/')
        self.timeout = config['station']['timeoutSeconds']
        self.token = token
        self.clock = clock
        self.tz = config.tz
        self.context = ssl.create_default_context(cafile=config['station']['caFile']) if self.base.startswith('https://') else None
        self.last_contact: float | None = None

    def request(self, method: str, path: str, payload: dict | None = None) -> Response:
        """Send one request; never raises for HTTP or network errors."""
        data = None
        headers = {'X-Muse-Data-Service-Token': self.token, 'Accept': 'application/json', 'User-Agent': 'lvpaopao-collector'}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf8')
            if len(data) > MAX_BODY:
                return Response(413, {'error': 'body too large (local check)'})
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout, context=self.context) as reply:
                status, raw = reply.status, reply.read(MAX_BODY)
        except urllib.error.HTTPError as error:
            status, raw = error.code, error.read(65536)
        except (urllib.error.URLError, OSError, ValueError):
            return Response(0, None)
        if status < 500:
            self.last_contact = self.clock.wall()
        try:
            body = json.loads(raw) if raw else None
        except ValueError:
            body = None
        return Response(status, body if isinstance(body, dict) else None)

    def post_run(self, run: dict) -> Response:
        """`POST /runs`: idempotent by `runId`."""
        return self.request('POST', '/runs', run)

    def heartbeat(self, payload: dict) -> Response:
        """`POST /heartbeat`: returns pending commands."""
        return self.request('POST', '/heartbeat', payload)

    def ack(self, command_id: str, result: str, message: str) -> Response:
        """`POST /commands/:id/ack` with `done` or `failed`."""
        return self.request('POST', f'/commands/{command_id}/ack', {'result': result, 'message': message[:300]})

    def put_login_screen(self, png: bytes, kind: str) -> bool:
        """`PUT /login-screen` with the login window PNG; returns success."""
        payload = {'capturedAt': iso(self.clock.wall(), self.tz), 'kind': kind, 'png': base64.b64encode(png).decode('ascii')}
        return self.request('PUT', '/login-screen', payload).ok

    def delete_login_screen(self) -> bool:
        """`DELETE /login-screen` after login succeeded; returns success."""
        return self.request('DELETE', '/login-screen').ok
