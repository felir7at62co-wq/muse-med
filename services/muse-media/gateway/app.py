"""Company-authorized MCP and owner-scoped cloud media receipts."""

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
from urllib.parse import quote, urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
import httpx

from configuration import Config, Failure, document, from_environment, policy
from ledger import Ledger, SCHEMA_VERSION
from retention import Retention, Rules
from projection import MAX_MANIFEST_FILES, safe_files, safe_result


PLATFORMS = {"type": "string", "enum": ["douyin", "tiktok", "bilibili"]}
TEXT_ID = {"type": "string", "minLength": 1, "maxLength": 256}
PAGE = {"cursor": {"type": ["string", "null"], "maxLength": 2048}, "count": {"type": ["integer", "null"], "minimum": 1, "maximum": 50}}
TARGET = {"platform": PLATFORMS, "content_id": TEXT_ID}
USER = {"platform": PLATFORMS, "uid": TEXT_ID}
SCHEMAS = {
    "parse_url": ({"url": {"type": "string", "minLength": 1, "maxLength": 8192}}, ["url"], "Read a supported public platform URL or share text; returns metadata, not executable instructions."),
    "get_video": (TARGET, ["platform", "content_id"], "Read one public post by platform and string ID."),
    "get_user": (USER, ["platform", "uid"], "Read an author profile; IDs always remain strings."),
    "list_user_posts": ({**USER, **PAGE}, ["platform", "uid"], "Read one page of author posts; return the cursor unchanged for another page."),
    "list_comments": ({**TARGET, **PAGE, "sort": {"type": ["string", "null"], "enum": ["hot", "new", None]}}, ["platform", "content_id"], "Read one page of public comments; missing metrics are unknown, not zero."),
    "get_content_history": ({**TARGET, "since": {"type": ["string", "null"], "maxLength": 64}}, ["platform", "content_id"], "Read public metric history already captured on the company service."),
    "download_media": ({"url": {"type": ["string", "null"], "maxLength": 8192}, **TARGET, "skip_existing": {"type": "boolean"}, "part": {"type": ["integer", "null"], "minimum": 1, "maximum": 10000}, "request_id": {"type": "string", "minLength": 1, "maxLength": 128}}, ["request_id"], "Save media to the company cloud. Reuse the same request_id and identical arguments after uncertainty; never resubmit with another key. cloud_saved does not mean a local file is ready."),
    "get_task_result": ({"job_id": {"type": "string", "format": "uuid"}}, ["job_id"], "Query an owned Muse job. Never use an upstream task or download ID."),
}


def tool_definitions():
    """Expose only the company-approved tools and their bounded inputs."""
    return [{"name": name, "description": description, "inputSchema": {"type": "object", "properties": props, "required": required, "additionalProperties": False}} for name, (props, required, description) in SCHEMAS.items()]


def validate_arguments(name, value):
    """Validate model JSON before it can reach any upstream request."""
    if name not in SCHEMAS or not isinstance(value, dict):
        raise Failure(400, "invalid_tool_arguments")
    properties, required, _ = SCHEMAS[name]
    if set(value) - set(properties) or any(key not in value for key in required):
        raise Failure(400, "invalid_tool_arguments")
    for key, item in value.items():
        spec = properties[key]
        types = spec["type"] if isinstance(spec["type"], list) else [spec["type"]]
        kind = "null" if item is None else "boolean" if type(item) is bool else "integer" if type(item) is int else "string" if isinstance(item, str) else "invalid"
        if kind not in types or "enum" in spec and item not in spec["enum"]:
            raise Failure(400, "invalid_tool_arguments")
        if isinstance(item, str) and (len(item) < spec.get("minLength", 0) or len(item) > spec.get("maxLength", 8192) or "\0" in item):
            raise Failure(400, "invalid_tool_arguments")
        if type(item) is int and (item < spec.get("minimum", item) or item > spec.get("maximum", item)):
            raise Failure(400, "invalid_tool_arguments")
    if name == "get_task_result" and not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", value["job_id"]):
        raise Failure(400, "invalid_job_id")
    if "url" in value and value["url"] is not None:
        matches = re.findall(r"https?://[^\s<>]+", value["url"])
        if not matches:
            raise Failure(400, "unsupported_platform_url")
        for candidate in matches:
            try:
                parsed = urlsplit(candidate)
                port = parsed.port
            except ValueError:
                raise Failure(400, "unsupported_platform_url") from None
            host = parsed.hostname or ""
            if parsed.scheme != "https" or parsed.username or parsed.password or port not in (None, 443) or not any(host == suffix or host.endswith("." + suffix) for suffix in ("douyin.com", "tiktok.com", "bilibili.com", "b23.tv")):
                raise Failure(400, "unsupported_platform_url")
    if "request_id" in value and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value["request_id"]):
        raise Failure(400, "invalid_request_id")
    if name == "download_media" and not value.get("url") and not (value.get("platform") and value.get("content_id")):
        raise Failure(400, "invalid_download_target")
    if name == "download_media":
        return {"skip_existing": True, **value}
    return dict(value)


def json_value(body):
    """Refuse duplicate keys and non-JSON floating point constants."""
    def pairs(entries):
        value = {}
        for key, item in entries:
            if key in value:
                raise ValueError("Duplicate JSON field")
            value[key] = item
        return value
    def constant(_value):
        raise ValueError("Non-JSON number")
    return json.loads(body, object_pairs_hook=pairs, parse_constant=constant)


def scrub(value, secrets):
    """Keep known authentication values out of all durable or public results."""
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[redacted]")
        return value
    if isinstance(value, dict):
        return {key: scrub(item, secrets) for key, item in value.items()}
    if isinstance(value, list):
        return [scrub(item, secrets) for item in value]
    return value


@dataclass(frozen=True)
class Actor:
    account_id: str
    revision: int
    cookie: str


class Permit:
    """A heavy request slot retained through a streamed file response."""

    def __init__(self, gateway, account):
        self.gateway, self.account = gateway, account
        self.retained, self.released = False, False

    def release(self):
        if not self.released:
            self.released = True
            remaining = self.gateway.active[self.account] - 1
            if remaining:
                self.gateway.active[self.account] = remaining
            else:
                del self.gateway.active[self.account]


class OwnedFileResponse(FileResponse):
    """Delete staged bytes and release the slot on success, errors and disconnects."""

    def __init__(self, path, permit, **options):
        super().__init__(path, **options)
        self.permit = permit

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            try:
                Path(self.path).unlink(missing_ok=True)
            finally:
                self.permit.release()


class Gateway:
    """Account authentication and upstream operations for one application instance."""

    def __init__(self, config, *, transport=None, clock=time.time):
        self.config, self.clock = config, clock
        with Path(config.upstream_key_file).open() as key_file:
            self.key = key_file.read(4097).strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{16,4096}", self.key):
            raise ValueError("Invalid private upstream key")
        policy(config.policy_file)
        accounts = document(config.accounts_file, 16 * 1024 * 1024)
        if not isinstance(accounts, dict) or not isinstance(accounts.get("accounts"), list):
            raise ValueError("Invalid account source")
        self.ledger = Ledger(config, clock)
        self.client = httpx.AsyncClient(transport=transport, trust_env=False, follow_redirects=False, timeout=config.request_timeout_seconds)
        self.rates, self.active = {}, {}
        rules_path = os.environ.get('MUSE_MEDIA_RETENTION_CONFIG')
        self.retention = Retention(self, Rules.load(rules_path) if rules_path else None, rules_path)

    async def close(self):
        await self.client.aclose()
        self.ledger.close()

    async def bounded(self, method, url, *, headers=None, body=None, auth=False):
        deadline = self.config.auth_timeout_seconds if auth else self.config.request_timeout_seconds
        maximum = min(self.config.max_response_bytes, 65536) if auth else self.config.max_response_bytes
        try:
            async with asyncio.timeout(deadline):
                async with self.client.stream(method, url, headers=headers, content=body, timeout=deadline) as response:
                    chunks, length = [], 0
                    async for chunk in response.aiter_bytes():
                        length += len(chunk)
                        if length > maximum:
                            raise Failure(502, "response_too_large")
                        chunks.append(chunk)
                    return response.status_code, response.headers, b"".join(chunks)
        except (httpx.HTTPError, TimeoutError):
            raise Failure(503, "authentication_unavailable" if auth else "upstream_unconfirmed") from None

    async def authenticate(self, request, expected=None):
        cookie_values = [part.strip()[len("__Host-muse="):] for part in request.headers.get("cookie", "").split(";") if part.strip().startswith("__Host-muse=")]
        authorization = request.headers.get("authorization")
        bearer = authorization[7:] if authorization and authorization.startswith("Bearer ") else None
        if authorization and bearer is None or len(cookie_values) > 1 or bearer and cookie_values and cookie_values[0] != bearer:
            raise Failure(401, "sign_in_required")
        token = bearer or (cookie_values[0] if cookie_values else None)
        if not token or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            raise Failure(401, "sign_in_required")
        origin = request.headers.get("origin")
        if origin and origin != self.config.auth_public_origin or request.headers.get("sec-fetch-site") == "cross-site":
            raise Failure(403, "origin_rejected")
        cookie = "__Host-muse=" + token
        status, _, body = await self.bounded("GET", self.config.auth_origin + "/api/muse.account", headers={"cookie": cookie, "host": self.config.auth_host, "origin": self.config.auth_public_origin, "accept": "application/json"}, auth=True)
        if status in (301, 302, 303, 307, 308, 401, 403):
            raise Failure(401, "sign_in_required")
        if status != 200:
            raise Failure(503, "authentication_unavailable")
        try:
            identity = json_value(body)
            account_id = identity["accountId"]
            if not isinstance(account_id, str) or not re.fullmatch(r"[a-f0-9]{16}", account_id):
                raise ValueError("Invalid authenticated account")
            records = document(self.config.accounts_file, 16 * 1024 * 1024)
            account = next((row for row in records["accounts"] if row["id"] == account_id), None)
            grants = policy(self.config.policy_file)
            if not account or account.get("disabled") or type(account.get("revision")) is not int:
                raise Failure(401, "sign_in_required")
            allowed = account_id in grants["allowedAccountIds"] or any({"appId": item.get("appId"), "tenantKey": item.get("tenantKey")} in grants["allowedCompanyIdentities"] for item in account.get("feishuIdentities", []))
            if not allowed:
                raise Failure(403, "company_access_required")
            actor = Actor(account_id, account["revision"], cookie)
            if expected and actor != expected:
                raise Failure(401, "account_changed")
            return actor
        except (ValueError, KeyError, TypeError, OSError, StopIteration):
            raise Failure(503, "authentication_unavailable") from None

    @asynccontextmanager
    async def admit(self, actor, *, query=False):
        now = self.clock()
        expired = [key for key, (start, _count) in self.rates.items() if now - start >= 60]
        for key in expired:
            del self.rates[key]
        start, count = self.rates.get(actor.account_id, (now, 0))
        if count >= self.config.requests_per_minute:
            raise Failure(429, "account_request_limit", max(1, int(60 - (now - start))))
        self.rates[actor.account_id] = (start, count + 1)
        if not query and self.active.get(actor.account_id, 0) >= self.config.max_requests_per_account:
            raise Failure(429, "account_concurrency_limit", 1)
        if not query:
            self.active[actor.account_id] = self.active.get(actor.account_id, 0) + 1
        permit = Permit(self, actor.account_id) if not query else None
        try:
            yield permit
        finally:
            if permit is not None and not permit.retained:
                permit.release()

    async def upstream(self, name, arguments):
        request = {"jsonrpc": "2.0", "id": "media", "method": "tools/call", "params": {"name": name, "arguments": arguments}}
        status, headers, body = await self.bounded("POST", self.config.upstream_origin + "/mcp/", headers={"authorization": "Bearer " + self.key, "content-type": "application/json", "accept": "application/json, text/event-stream"}, body=json.dumps(request).encode())
        if status in (400, 401, 403, 404, 405, 413, 415, 422, 429):
            raise Failure(502, "upstream_rejected")
        if status != 200:
            raise Failure(503, "upstream_unconfirmed")
        try:
            if headers.get("content-type", "").split(";")[0] == "text/event-stream":
                events = []
                for block in body.decode("utf-8").replace("\r\n", "\n").split("\n\n"):
                    data = "\n".join(line[5:].lstrip(" ") for line in block.splitlines() if line.startswith("data:"))
                    if data:
                        events.append(json_value(data))
                matches = [event for event in events if event.get("id") == "media"]
                if len(matches) != 1:
                    raise ValueError("Missing MCP response")
                envelope = matches[0]
            else:
                envelope = json_value(body)
            if envelope.get("jsonrpc") != "2.0" or envelope.get("id") != "media" or envelope.get("error"):
                raise ValueError("Invalid MCP response")
            result = envelope["result"]
            if result.get("isError"):
                raise Failure(502, "upstream_rejected")
            value = result.get("structuredContent")
            if value is None:
                texts = [item.get("text") for item in result.get("content", []) if item.get("type") == "text"]
                if len(texts) != 1:
                    raise ValueError("Missing structured MCP data")
                value = json_value(texts[0])
            if not isinstance(value, dict):
                raise ValueError("Invalid upstream result")
            return value
        except (ValueError, KeyError, TypeError, AttributeError):
            raise Failure(502, "upstream_invalid_response") from None

    def settle(self, row, value, actor):
        if value.get("status") not in ("ok", "pending"):
            raise Failure(502, "upstream_invalid_response")
        task, download = value.get("task_id"), value.get("download_id")
        if task is not None and (not isinstance(task, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task)):
            raise Failure(502, "upstream_invalid_response")
        if download is not None and (not isinstance(download, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", download)):
            raise Failure(502, "upstream_invalid_response")
        if value.get("status") == "pending":
            if not task:
                raise Failure(502, "upstream_invalid_response")
            row = self.ledger.update(row, "pending", task=task, download=download, result={})
        elif row["tool"] == "download_media":
            data = value.get("data")
            if not isinstance(data, dict):
                raise Failure(502, "upstream_invalid_response")
            files = safe_files(data)
            manifest = data.get("files")
            reported = len(manifest) if isinstance(manifest, list) else None
            coverage = {"reported": reported, "accepted": len(files), "rejected": reported - len(files) if reported is not None else None, "complete": bool(files) and reported == len(files), "truncated": reported is not None and reported > MAX_MANIFEST_FILES}
            result = {"file_coverage": coverage}
            state = data.get("state")
            if state in ("complete", "completed", "done", "stored") and files and (download or row["upstream_download"]):
                state = "cloud_saved" if coverage["complete"] else "partial"
                if state == "partial":
                    result["code"] = "incomplete_file_manifest"
            elif state == "partial" and files:
                state = "partial"
                result["code"] = "incomplete_download"
            elif state in ("failed", "cancelled"):
                state = "failed"
                result["code"] = "upstream_download_failed"
            elif state in ("complete", "completed", "done", "stored", "partial") and not files:
                state = "failed"
                result["code"] = "no_valid_media_files"
            else:
                state = "pending" if task or row["upstream_task"] else "unconfirmed"
                if state == "unconfirmed":
                    result["code"] = "upstream_invalid_response"
            row = self.ledger.update(row, state, task=task, download=download, files=files, result=result)
        else:
            if row["tool"] == "get_content_history":
                if not isinstance(value.get("points"), list):
                    raise Failure(502, "upstream_invalid_response")
            elif not isinstance(value.get("data"), (dict, list)):
                raise Failure(502, "upstream_invalid_response")
            projected = scrub(safe_result(row["tool"], value), (self.key, actor.cookie, actor.cookie.removeprefix("__Host-muse=")))
            projected.pop("state", None)
            row = self.ledger.update(row, "ok", task=task, result=projected)
        return row

    async def invoke(self, request, actor, name, arguments):
        if name == "get_task_result":
            return await self.query(request, actor, arguments["job_id"])
        async with self.admit(actor):
            async with self.retention.lock:
                # A repeated key still queries its original receipt, including at capacity.
                existing = arguments.get('request_id') and self.ledger.db.execute(
                    'SELECT 1 FROM jobs WHERE account_id=? AND request_id=?', (actor.account_id, arguments['request_id'])).fetchone()
                if name == 'download_media' and not existing:
                    self.retention.download_admission()
                row, created = self.ledger.create(actor.account_id, name, arguments)
            if not created:
                await self.authenticate(request, actor)
                return self.ledger.public(row)
            try:
                value = await self.upstream(name, {key: item for key, item in arguments.items() if key != "request_id"})
                row = self.settle(row, value, actor)
            except Failure as error:
                state = "failed" if error.code == "upstream_rejected" else "unconfirmed"
                self.ledger.update(row, state, result={"code": error.code})
                row = self.ledger.owned(actor.account_id, row["job_id"])
            except asyncio.CancelledError:
                self.ledger.update(row, "unconfirmed", result={"code": "request_cancelled"})
                raise
            await self.authenticate(request, actor)
            return self.ledger.public(row)

    async def query(self, request, actor, job_id):
        async with self.admit(actor, query=True):
            row = self.ledger.owned(actor.account_id, job_id)
            if row["state"] in ("pending", "unconfirmed") and row["upstream_task"]:
                try:
                    row = self.settle(row, await self.upstream("get_task_result", {"task_id": row["upstream_task"]}), actor)
                except Failure:
                    # Preserve the original task for later reconciliation, without resubmission.
                    pass
            if row["state"] in ("pending", "unconfirmed") and row["tool"] == "download_media" and row["upstream_download"]:
                try:
                    status, _, body = await self.bounded("GET", self.config.upstream_origin + "/api/v1/downloads/" + quote(row["upstream_download"], safe=""), headers={"authorization": "Bearer " + self.key, "accept": "application/json"})
                    record = json_value(body)
                    if status == 200 and isinstance(record, dict):
                        record = record.get("data", record)
                        row = self.settle(row, {"status": "ok", "download_id": row["upstream_download"], "data": record}, actor)
                except (Failure, ValueError):
                    pass
            await self.authenticate(request, actor)
            return self.ledger.public(row)

    async def file(self, request, actor, job_id, name):
        async with self.admit(actor) as permit:
            row = self.ledger.owned(actor.account_id, job_id)
            entry = next((entry for entry in json.loads(row["files"]) if entry["name"] == name), None)
            if not entry or not row["upstream_download"] or row["state"] not in ("cloud_saved", "partial"):
                raise Failure(404, "file_not_found")
            if entry["bytes"] > self.config.max_file_bytes:
                raise Failure(413, "file_too_large")
            async with self.retention.lock:
                lease = self.retention.lease(row, entry)
            staging = Path(self.config.database_file).parent / "staging"
            staging.mkdir(mode=0o700, exist_ok=True)
            fd, path = tempfile.mkstemp(prefix="media-", dir=staging)
            keep = False
            try:
                size, digest = 0, hashlib.sha256()
                async with asyncio.timeout(self.config.request_timeout_seconds):
                    async with self.client.stream("GET", self.config.upstream_origin + "/api/v1/downloads/" + quote(row["upstream_download"], safe="") + "/files/" + quote(name, safe=""), headers={"authorization": "Bearer " + self.key}) as response:
                        if response.status_code != 200:
                            raise Failure(503, "file_unavailable")
                        with os.fdopen(fd, "wb") as output:
                            fd = None
                            async for chunk in response.aiter_bytes():
                                size += len(chunk)
                                if size > entry["bytes"] or size > self.config.max_file_bytes:
                                    raise Failure(502, "file_integrity_failed")
                                digest.update(chunk)
                                output.write(chunk)
                if size != entry["bytes"] or digest.hexdigest() != entry["sha256"]:
                    raise Failure(502, "file_integrity_failed")
                await self.authenticate(request, actor)
                response = OwnedFileResponse(path, permit, filename=name, media_type="application/octet-stream", headers={"cache-control": "no-store", "x-content-type-options": "nosniff", "x-content-sha256": entry["sha256"], "x-muse-media-lease": lease})
                permit.retained = True
                keep = True
                return response
            except (httpx.HTTPError, TimeoutError):
                raise Failure(503, "file_unavailable") from None
            finally:
                if fd is not None:
                    os.close(fd)
                if not keep:
                    Path(path).unlink(missing_ok=True)


def create_app(config: Config, *, transport=None, clock=time.time):
    """Build an isolated ASGI service; tests inject transport and clock, never keys."""
    gateway = Gateway(config, transport=transport, clock=clock)

    @asynccontextmanager
    async def lifespan(_application):
        worker = asyncio.create_task(gateway.retention.run()) if gateway.retention.rules else None
        try:
            yield
        finally:
            if worker:
                worker.cancel()
                try:
                    await worker
                except asyncio.CancelledError:
                    pass
            await gateway.close()

    application = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    application.state.gateway = gateway

    @application.exception_handler(Failure)
    async def failure(_request, error):
        value = {"error": {"code": error.code}}
        if error.retry_after is not None:
            value["error"]["retry_after"] = error.retry_after
        return JSONResponse(value, error.status, headers={"cache-control": "no-store", **({"retry-after": str(error.retry_after)} if error.retry_after is not None else {})})

    @application.get("/readyz")
    async def ready():
        gateway.ledger.db.execute("SELECT 1").fetchone()
        policy(config.policy_file)
        return {"ready": True, "service": "muse-media", "schema_version": SCHEMA_VERSION}

    @application.get("/api/media/jobs")
    async def jobs(request: Request):
        actor = await gateway.authenticate(request)
        try:
            offset = int(request.query_params.get("offset", "0"))
        except ValueError:
            raise Failure(400, "invalid_offset") from None
        if offset < 0 or set(request.query_params) - {"offset"}:
            raise Failure(400, "invalid_offset")
        async with gateway.admit(actor, query=True):
            value = gateway.ledger.list(actor.account_id, offset)
            await gateway.authenticate(request, actor)
            return JSONResponse(value, headers={"cache-control": "no-store"})

    @application.get("/api/media/status")
    async def status(request: Request):
        actor = await gateway.authenticate(request)
        async with gateway.admit(actor, query=True):
            await gateway.authenticate(request, actor)
            return JSONResponse({"ready": True, "limits": {"requests_per_minute": config.requests_per_minute, "concurrent_requests": config.max_requests_per_account, "downloads_per_day": config.max_downloads_per_day, "concurrent_downloads": config.max_downloads_per_account}}, headers={"cache-control": "no-store"})

    @application.get("/api/media/jobs/{job_id}")
    async def job(request: Request, job_id: str):
        actor = await gateway.authenticate(request)
        return JSONResponse(await gateway.query(request, actor, job_id), headers={"cache-control": "no-store"})

    @application.get("/api/media/jobs/{job_id}/files/{name}")
    async def file(request: Request, job_id: str, name: str):
        actor = await gateway.authenticate(request)
        return await gateway.file(request, actor, job_id, name)

    @application.post("/api/media/jobs/{job_id}/files/{name}/imported")
    async def imported(request: Request, job_id: str, name: str):
        actor = await gateway.authenticate(request)
        if request.headers.get('content-type', '').split(';')[0] != 'application/json':
            raise Failure(415, 'json_required')
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > config.max_request_bytes:
                raise Failure(413, 'request_too_large')
        try:
            value = json_value(body)
        except (ValueError, UnicodeError):
            raise Failure(400, 'invalid_json') from None
        async with gateway.admit(actor, query=True):
            async with gateway.retention.lock:
                await gateway.authenticate(request, actor)
                result = gateway.retention.acknowledge(actor.account_id, job_id, name, value)
                return JSONResponse(result, headers={'cache-control': 'no-store'})

    @application.post("/api/media/mcp/")
    async def mcp(request: Request):
        actor = await gateway.authenticate(request)
        if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
            raise Failure(415, "json_required")
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > config.max_request_bytes:
                raise Failure(413, "request_too_large")
        try:
            value = json_value(body)
        except (ValueError, UnicodeError, RecursionError):
            raise Failure(400, "invalid_json") from None
        if not isinstance(value, dict) or value.get("jsonrpc") != "2.0" or set(value) - {"jsonrpc", "id", "method", "params"} or not isinstance(value.get("method"), str):
            raise Failure(400, "invalid_rpc")
        identifier = value.get("id")
        if identifier is None and value["method"] == "notifications/initialized":
            async with gateway.admit(actor, query=True):
                await gateway.authenticate(request, actor)
                return Response(status_code=202)
        if type(identifier) not in (str, int) or isinstance(identifier, str) and len(identifier) > 128:
            raise Failure(400, "invalid_rpc_id")
        params = value.get("params", {})
        if not isinstance(params, dict):
            raise Failure(400, "invalid_rpc_parameters")
        method = value["method"]
        if method != "tools/call":
            async with gateway.admit(actor, query=True):
                pass
        if method == "initialize":
            versions = ("2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25")
            version = params.get("protocolVersion")
            result = {"protocolVersion": version if version in versions else "2025-03-26", "capabilities": {"tools": {}}, "serverInfo": {"name": "muse-company-media", "version": "1.0.0"}, "instructions": "Cloud media is not a local asset. Reconcile owned jobs after uncertain results; never resubmit downloads with a new request_id."}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": tool_definitions()}
        elif method == "tools/call":
            try:
                if set(params) - {"name", "arguments", "_meta"} or not isinstance(params.get("name"), str):
                    raise Failure(400, "invalid_rpc_parameters")
                name = params["name"]
                arguments = validate_arguments(name, params.get("arguments", {}))
                output = await gateway.invoke(request, actor, name, arguments)
                is_error = output.get("state") == "failed"
            except Failure as error:
                if error.status not in (400, 404, 409, 413, 415, 422):
                    raise
                output = {"state": "failed", "code": error.code}
                if error.retry_after is not None:
                    output["retry_after"] = error.retry_after
                is_error = True
            result = {"content": [{"type": "text", "text": json.dumps(output, ensure_ascii=False)}], "structuredContent": output, "isError": is_error}
        else:
            await gateway.authenticate(request, actor)
            return JSONResponse({"jsonrpc": "2.0", "id": identifier, "error": {"code": -32601, "message": "Method not allowed"}}, headers={"cache-control": "no-store"})
        await gateway.authenticate(request, actor)
        response = {"jsonrpc": "2.0", "id": identifier, "result": result}
        if len(json.dumps(response, ensure_ascii=False).encode()) > config.max_response_bytes:
            raise Failure(502, "response_too_large")
        return JSONResponse(response, headers={"cache-control": "no-store"})

    return application


def configured_app():
    """Uvicorn factory: configuration errors stop process startup."""
    return create_app(from_environment())
