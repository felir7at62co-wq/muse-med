"""Company gateway behavior through its real ASGI routes and durable ledger."""

import asyncio
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import httpx

from app import Actor, create_app
from configuration import Config
from starlette.requests import Request


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.accounts = {"A": {"id": "a" * 16, "username": "alice", "revision": 1, "disabled": False, "feishuIdentities": [{"appId": "cli_company", "tenantKey": "company"}]}, "B": {"id": "b" * 16, "username": "bob", "revision": 1, "disabled": False, "feishuIdentities": [{"appId": "cli_company", "tenantKey": "company"}]}, "C": {"id": "c" * 16, "username": "legacy", "revision": 1, "disabled": False, "admin": True}}
        self.write_accounts()
        (self.root / "policy.json").write_text(json.dumps({"version": 1, "authorizationMode": "company-identities", "allowedCompanyIdentities": [{"appId": "cli_company", "tenantKey": "company"}], "allowedAccountIds": []}))
        self.key = "dtk_private_service_key_not_for_users"
        (self.root / "key").write_text(self.key)
        self.config = Config(version=1, auth_origin="http://127.0.0.1:19389", auth_host="muse.test", auth_public_origin="https://muse.test", upstream_origin="http://127.0.0.1:19580", upstream_key_file=str(self.root / "key"), accounts_file=str(self.root / "accounts.json"), policy_file=str(self.root / "policy.json"), database_file=str(self.root / "jobs.sqlite3"), requests_per_minute=60, max_requests_per_account=2, max_downloads_per_day=20, max_downloads_per_account=2, max_downloads_global=4, reservation_ttl_seconds=900, request_timeout_seconds=5, auth_timeout_seconds=1, max_request_bytes=32768, max_response_bytes=1048576, max_file_bytes=536870912, max_jobs_per_page=100, sqlite_timeout_seconds=2)
        self.now = 1800000000.0
        self.upstream_calls, self.auth_calls = [], []
        self.on_upstream = None
        self.on_auth = None
        self.media_bytes = b"controlled-test-video"
        self.media_served = 0
        await self.start()

    def write_accounts(self):
        temporary = self.root / "accounts.next"
        temporary.write_text(json.dumps({"version": 2, "accounts": list(self.accounts.values())}))
        temporary.replace(self.root / "accounts.json")

    async def start(self):
        self.app = create_app(self.config, transport=httpx.MockTransport(self.transport), clock=lambda: self.now)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="https://muse.test")

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.app.state.gateway.close()
        self.temporary.cleanup()

    def download(self, state="done"):
        return {"status": "ok", "task_id": "upstream-task-private", "download_id": "upstream-download-private", "data": {"state": state, "directory": "/var/lib/dtk/private", "files": [{"name": "video.mp4", "state": "done", "kind": "video", "bytes": len(self.media_bytes), "sha256": hashlib.sha256(self.media_bytes).hexdigest()}]}}

    async def transport(self, request):
        if request.url.port == 19389:
            self.auth_calls.append(request)
            token = request.headers.get("cookie", "").removeprefix("__Host-muse=")
            account = self.accounts.get(token[:1]) if len(token) == 43 else None
            if self.on_auth:
                value = self.on_auth(request, account)
                if value is not None:
                    return value
            if not account:
                return httpx.Response(303, headers={"location": "/login"})
            return httpx.Response(200, json={"accountId": account["id"], "username": account["username"], "admin": account.get("admin", False)})
        self.assertEqual(request.url.port, 19580)
        self.assertEqual(request.headers.get("authorization"), "Bearer " + self.key)
        self.assertNotIn("cookie", request.headers)
        if request.method == "GET":
            if request.url.path == "/api/v1/downloads/upstream-download-private":
                return httpx.Response(200, json={"success": True, "data": {"state": "running", "files": []}})
            self.assertEqual(str(request.url), "http://127.0.0.1:19580/api/v1/downloads/upstream-download-private/files/video.mp4")
            self.media_served += 1
            return httpx.Response(200, content=self.media_bytes)
        value = json.loads(request.content)
        self.upstream_calls.append(value["params"])
        response = await self.on_upstream(value["params"]) if self.on_upstream else {"status": "ok", "data": {"content_id": "post-one", "title": "Public sample", "stats": {"play_count": None, "digg_count": 1}}}
        if isinstance(response, httpx.Response):
            return response
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": "media", "result": {"structuredContent": response}})

    def headers(self, actor="A", **extra):
        return {"cookie": "__Host-muse=" + actor * 43, "origin": "https://muse.test", **extra}

    async def rpc(self, name=None, args=None, *, actor="A", method="tools/call", headers=None):
        params = {"name": name, "arguments": args or {}} if name else {}
        return await self.client.post("/api/media/mcp/", json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, headers=headers or self.headers(actor))

    def output(self, response):
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["result"]["structuredContent"]

    def tool_failure(self, response, code):
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["result"]["isError"])
        self.assertEqual(self.output(response), {"state": "failed", "code": code})

    async def test_identity_and_company_policy_do_not_trust_admin_or_request_account(self):
        self.assertEqual((await self.client.get("/api/media/jobs")).status_code, 401)
        self.assertEqual((await self.rpc(method="tools/list", actor="C")).status_code, 403)
        response = await self.rpc(method="tools/list")
        tools = response.json()["result"]["tools"]
        self.assertEqual(len(tools), 8)
        self.assertNotIn("pool_status", [tool["name"] for tool in tools])
        self.assertNotIn("transcribe_video", [tool["name"] for tool in tools])
        self.tool_failure(await self.rpc("get_video", {"platform": "douyin", "content_id": "1", "account_id": "b" * 16}), "invalid_tool_arguments")
        self.assertEqual(self.upstream_calls, [])

    async def test_own_job_and_verified_file_are_not_visible_to_another_company_user(self):
        async def finish(_params):
            return self.download()
        self.on_upstream = finish
        receipt = self.output(await self.rpc("download_media", {"platform": "douyin", "content_id": "1", "request_id": "receipt-one"}))
        self.assertEqual(receipt["state"], "cloud_saved")
        job_id = receipt["job_id"]
        for private in (self.key, "upstream-task-private", "upstream-download-private", "/var/lib/dtk"):
            self.assertNotIn(private, json.dumps(receipt))
        self.assertEqual((await self.client.get(f"/api/media/jobs/{job_id}", headers=self.headers("B"))).status_code, 404)
        self.assertEqual((await self.client.get(f"/api/media/jobs/{job_id}/files/video.mp4", headers=self.headers("B"))).status_code, 404)
        self.assertEqual(self.media_served, 0)
        own = await self.client.get(f"/api/media/jobs/{job_id}/files/video.mp4", headers=self.headers())
        self.assertEqual(own.status_code, 200)
        self.assertEqual(own.content, self.media_bytes)
        self.assertEqual(list((self.root / "staging").iterdir()), [])
        self.assertEqual((await self.client.get(f"/api/media/jobs/{job_id}/files/secret.env", headers=self.headers())).status_code, 404)
        listed = await self.client.get("/api/media/jobs", headers=self.headers("B"))
        self.assertEqual(listed.json()["jobs"], [])

    async def test_import_acknowledgement_is_owned_digest_bound_and_idempotent(self):
        async def finish(_params):
            return self.download()
        self.on_upstream = finish
        receipt = self.output(await self.rpc('download_media', {'url': 'https://www.douyin.com/video/1', 'request_id': 'ack-one'}))
        path = f"/api/media/jobs/{receipt['job_id']}/files/video.mp4"
        response = await self.client.get(path, headers=self.headers())
        lease = response.headers['x-muse-media-lease']
        sha = receipt['files'][0]['sha256']
        self.assertEqual((await self.client.post(path + '/imported', headers=self.headers('B'), json={'lease': lease, 'sha256': sha})).status_code, 404)
        self.assertEqual((await self.client.post(path + '/imported', headers=self.headers(), json={'lease': lease, 'sha256': '0' * 64})).status_code, 409)
        for _ in range(2):
            accepted = await self.client.post(path + '/imported', headers=self.headers(), json={'lease': lease, 'sha256': sha})
            self.assertEqual(accepted.json(), {'state': 'acknowledged'})
        self.assertEqual((await self.client.post(path + '/imported', headers=self.headers(origin='https://evil.test'), json={'lease': lease, 'sha256': sha})).status_code, 403)
        self.assertEqual((await self.client.post(path + '/imported', headers=self.headers(), json={'lease': lease, 'sha256': sha, 'account_id': 'b' * 16})).status_code, 400)

    async def test_expired_and_disabled_account_cannot_confirm_import(self):
        async def finish(_params):
            return self.download()
        self.on_upstream = finish
        receipt = self.output(await self.rpc('download_media', {'url': 'https://www.douyin.com/video/1', 'request_id': 'ack-expired'}))
        path = f"/api/media/jobs/{receipt['job_id']}/files/video.mp4"
        response = await self.client.get(path, headers=self.headers())
        value = {'lease': response.headers['x-muse-media-lease'], 'sha256': receipt['files'][0]['sha256']}
        self.now += 7201
        self.assertEqual((await self.client.post(path + '/imported', headers=self.headers(), json=value)).status_code, 409)
        self.accounts['A']['disabled'] = True
        self.write_accounts()
        self.assertEqual((await self.client.post(path + '/imported', headers=self.headers(), json=value)).status_code, 401)

    async def test_account_limit_is_independent_of_network_address_and_account(self):
        self.app.state.gateway.config = self.config = replace(self.config, requests_per_minute=1)
        self.assertEqual((await self.rpc(method="tools/list", headers=self.headers(**{"x-real-ip": "1.1.1.1"}))).status_code, 200)
        rejected = await self.rpc(method="tools/list", headers=self.headers(**{"x-real-ip": "8.8.8.8"}))
        self.assertEqual(rejected.status_code, 429)
        self.assertGreater(int(rejected.headers["retry-after"]), 0)
        self.assertEqual((await self.rpc(method="tools/list", actor="B")).status_code, 200)
        self.now += 61
        self.assertEqual((await self.rpc(method="tools/list")).status_code, 200)

    async def test_disable_or_revision_change_during_operation_blocks_delivery(self):
        async def disable(_params):
            self.accounts["A"]["disabled"] = True
            self.write_accounts()
            return {"status": "ok", "data": {"title": "must not be delivered"}}
        self.on_upstream = disable
        response = await self.rpc("get_video", {"platform": "douyin", "content_id": "1"})
        self.assertEqual(response.status_code, 401)
        self.assertNotIn("must not be delivered", response.text)
        self.accounts["A"]["disabled"] = False
        self.write_accounts()
        async def revise(_params):
            self.accounts["A"]["revision"] += 1
            self.write_accounts()
            return {"status": "ok", "data": {"title": "must not be delivered"}}
        self.on_upstream = revise
        self.assertEqual((await self.rpc("get_video", {"platform": "douyin", "content_id": "2"})).status_code, 401)

    async def test_parallel_same_request_only_submits_once_and_content_conflicts(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def pending(_params):
            entered.set()
            await release.wait()
            return {"status": "pending", "task_id": "upstream-task-private", "download_id": "upstream-download-private"}
        self.on_upstream = pending
        args = {"platform": "douyin", "content_id": "1", "request_id": "same-request"}
        first = asyncio.create_task(self.rpc("download_media", args))
        await entered.wait()
        duplicate = self.output(await self.rpc("download_media", args))
        release.set()
        receipt = self.output(await first)
        self.assertEqual(receipt["job_id"], duplicate["job_id"])
        self.assertEqual(len(self.upstream_calls), 1)
        conflict = await self.rpc("download_media", {**args, "content_id": "2"})
        self.tool_failure(conflict, "request_id_conflict")

    async def test_unknown_submission_is_durable_not_reissued_and_reservation_expires(self):
        async def timeout(_params):
            raise httpx.ReadTimeout("private upstream timeout " + self.key)
        self.on_upstream = timeout
        self.config = replace(self.config, max_downloads_per_account=1)
        self.app.state.gateway.config = self.config
        self.app.state.gateway.ledger.config = self.config
        args = {"platform": "douyin", "content_id": "1", "request_id": "unknown-request"}
        receipt = self.output(await self.rpc("download_media", args))
        self.assertEqual(receipt["state"], "unconfirmed")
        self.assertEqual(receipt["code"], "upstream_unconfirmed")
        self.assertTrue(receipt["reservation_active"])
        self.assertEqual(self.output(await self.rpc("download_media", args))["job_id"], receipt["job_id"])
        self.assertEqual(len(self.upstream_calls), 1)
        self.assertEqual((await self.rpc("download_media", {**args, "request_id": "new-request"})).status_code, 429)
        await self.client.aclose()
        await self.app.state.gateway.close()
        await self.start()
        stored = await self.client.get("/api/media/jobs/" + receipt["job_id"], headers=self.headers())
        self.assertEqual(stored.json()["state"], "unconfirmed")
        self.assertEqual((await self.client.get("/api/media/jobs/" + receipt["job_id"], headers=self.headers("B"))).status_code, 404)
        self.now += 901
        previous = await self.client.get("/api/media/jobs/" + receipt["job_id"], headers=self.headers())
        self.assertFalse(previous.json()["reservation_active"])
        self.assertEqual(self.output(await self.rpc("download_media", {**args, "request_id": "after-expiry"}))["state"], "unconfirmed")
        self.assertEqual(len(self.upstream_calls), 2)

    async def test_quota_survives_process_restart(self):
        self.config = replace(self.config, max_downloads_per_day=1)
        self.app.state.gateway.ledger.config = self.config
        async def done(_params):
            return self.download()
        self.on_upstream = done
        args = {"platform": "douyin", "content_id": "1", "request_id": "daily-one"}
        self.output(await self.rpc("download_media", args))
        await self.client.aclose()
        await self.app.state.gateway.close()
        await self.start()
        self.assertEqual((await self.rpc("download_media", {**args, "request_id": "daily-two"})).status_code, 429)
        self.assertEqual(len(self.upstream_calls), 1)

    async def test_queries_can_complete_while_heavy_request_slots_are_full(self):
        async def pending(_params):
            return {"status": "pending", "task_id": "upstream-task-private", "download_id": "upstream-download-private"}
        self.on_upstream = pending
        receipt = self.output(await self.rpc("download_media", {"platform": "douyin", "content_id": "1", "request_id": "pending"}))
        self.app.state.gateway.active["a" * 16] = 2
        async def done(params):
            self.assertEqual(params["name"], "get_task_result")
            self.assertEqual(params["arguments"], {"task_id": "upstream-task-private"})
            return self.download()
        self.on_upstream = done
        result = self.output(await self.rpc("get_task_result", {"job_id": receipt["job_id"]}))
        self.assertEqual(result["state"], "cloud_saved")
        self.assertEqual(self.app.state.gateway.active["a" * 16], 2)

    async def test_malformed_methods_inputs_and_sized_responses_are_contained(self):
        self.tool_failure(await self.rpc("transcribe_video", {}), "invalid_tool_arguments")
        self.tool_failure(await self.rpc("pool_status", {}), "invalid_tool_arguments")
        for url in ("https://127.0.0.1/private", "https://[broken", "https://douyin.com:8443/private", "https://douyin.com:invalid/private"):
            self.tool_failure(await self.rpc("parse_url", {"url": url}), "unsupported_platform_url")
        self.tool_failure(await self.rpc("get_video", {"platform": "douyin", "content_id": 42}), "invalid_tool_arguments")
        self.tool_failure(await self.rpc("get_task_result", {"task_id": "upstream-task-private"}), "invalid_tool_arguments")
        self.assertEqual((await self.rpc(method="admin/delete")).json()["error"]["code"], -32601)
        oversized = await self.client.post("/api/media/mcp/", content="x" * 32769, headers=self.headers(**{"content-type": "application/json"}))
        self.assertEqual(oversized.status_code, 413)
        self.assertEqual(self.upstream_calls, [])
        async def large(_params):
            return httpx.Response(200, content=b"x" * 1048577)
        self.on_upstream = large
        receipt = self.output(await self.rpc("get_video", {"platform": "douyin", "content_id": "1"}))
        self.assertEqual(receipt["state"], "unconfirmed")

    async def test_sse_is_bounded_projected_and_known_secrets_removed(self):
        async def sse(_params):
            value = {"status": "ok", "task_id": "private-task", "raw": {"cookie": "secret"}, "data": {"title": self.key + " " + "A" * 43, "description": "Public context", "stats": {"play_count": None}}}
            return httpx.Response(200, text="event: message\r\ndata: " + json.dumps({"jsonrpc": "2.0", "id": "media", "result": {"structuredContent": value}}) + "\r\n\r\n", headers={"content-type": "text/event-stream"})
        self.on_upstream = sse
        receipt = self.output(await self.rpc("get_video", {"platform": "douyin", "content_id": "1"}))
        self.assertEqual(receipt["state"], "ok")
        self.assertIsNone(receipt["data"]["stats"]["play_count"])
        self.assertNotIn(self.key, json.dumps(receipt))
        self.assertNotIn("A" * 43, json.dumps(receipt))
        self.assertNotIn("private-task", json.dumps(receipt))

    async def test_authentication_switch_and_revocation_before_delivery(self):
        async def change(_params):
            self.on_auth = lambda _request, _account: httpx.Response(200, json={"accountId": "b" * 16})
            return {"status": "ok", "data": {"title": "alice result"}}
        self.on_upstream = change
        self.assertEqual((await self.rpc("get_video", {"platform": "douyin", "content_id": "1"})).status_code, 401)
        self.on_auth = lambda _request, _account: httpx.Response(303, headers={"location": "/login"})
        self.assertEqual((await self.rpc(method="tools/list")).status_code, 401)

    async def test_file_integrity_failure_does_not_release_bytes_to_client(self):
        async def done(_params):
            return self.download()
        self.on_upstream = done
        receipt = self.output(await self.rpc("download_media", {"platform": "douyin", "content_id": "1", "request_id": "file-one"}))
        self.media_bytes = b"wrong bytes"
        response = await self.client.get(f"/api/media/jobs/{receipt['job_id']}/files/video.mp4", headers=self.headers())
        self.assertEqual(response.status_code, 502)
        self.assertNotIn(b"wrong bytes", response.content)
        self.assertEqual(list((self.root / "staging").iterdir()), [])

    async def test_startup_refuses_invalid_config_and_future_database(self):
        with self.assertRaises(ValueError):
            replace(self.config, max_requests_per_account=0)
        with self.assertRaises(ValueError):
            replace(self.config, upstream_origin="https://attacker.test")
        with self.assertRaises(ValueError):
            replace(self.config, upstream_origin="http://127.0.0.1:19580/")
        self.app.state.gateway.ledger.db.execute("PRAGMA user_version=3")
        with self.assertRaises(ValueError):
            create_app(self.config, transport=httpx.MockTransport(self.transport))

    async def test_expired_pending_retains_receipt_and_releases_reservation(self):
        async def pending(_params):
            return {"status": "pending", "task_id": "upstream-task-private"}
        self.on_upstream = pending
        self.app.state.gateway.ledger.config = replace(self.config, max_downloads_per_account=1)
        args = {"platform": "douyin", "content_id": "1", "request_id": "old-pending"}
        receipt = self.output(await self.rpc("download_media", args))
        self.assertEqual((await self.rpc("download_media", {**args, "request_id": "second"})).status_code, 429)
        self.now += 901
        listed = await self.client.get("/api/media/jobs", headers=self.headers())
        old = listed.json()["jobs"][0]
        self.assertEqual(old["job_id"], receipt["job_id"])
        self.assertEqual(old["state"], "unconfirmed")
        self.assertFalse(old["reservation_active"])
        self.output(await self.rpc("download_media", {**args, "request_id": "after-pending-expiry"}))
        self.assertEqual(len(self.upstream_calls), 2)

    async def test_invalid_upstream_status_never_becomes_a_success(self):
        async def malformed(_params):
            return {"data": {"title": "unsupported"}}
        self.on_upstream = malformed
        receipt = self.output(await self.rpc("get_video", {"platform": "douyin", "content_id": "1"}))
        self.assertEqual(receipt["state"], "unconfirmed")
        self.assertNotIn("data", receipt)

    async def test_file_slot_and_cleanup_follow_send_failure(self):
        async def done(_params):
            return self.download()
        self.on_upstream = done
        receipt = self.output(await self.rpc("download_media", {"platform": "douyin", "content_id": "1", "request_id": "disconnect"}))
        scope = {"type": "http", "method": "GET", "path": "/", "headers": [(b"cookie", ("__Host-muse=" + "A" * 43).encode())], "http_version": "1.1", "extensions": {}, "asgi": {"spec_version": "2.4"}}
        gateway = self.app.state.gateway
        response = await gateway.file(Request(scope), Actor("a" * 16, 1, "__Host-muse=" + "A" * 43), receipt["job_id"], "video.mp4")
        self.assertEqual(gateway.active["a" * 16], 1)
        self.assertTrue(list((self.root / "staging").iterdir()))
        async def receive():
            return {"type": "http.disconnect"}
        async def send(message):
            if message["type"] == "http.response.body":
                raise RuntimeError("controlled disconnect")
        with self.assertRaises(RuntimeError):
            await response(scope, receive, send)
        self.assertNotIn("a" * 16, gateway.active)
        self.assertEqual(list((self.root / "staging").iterdir()), [])

    async def test_mcp_business_failure_keeps_rpc_id_and_rest_ownership_status(self):
        payload = {"jsonrpc": "2.0", "id": "caller-owned-rpc-id", "method": "tools/call", "params": {"name": "get_task_result", "arguments": {"job_id": "00000000-0000-4000-8000-000000000000"}}}
        response = await self.client.post("/api/media/mcp/", json=payload, headers=self.headers())
        self.tool_failure(response, "job_not_found")
        self.assertEqual(response.json()["id"], payload["id"])
        self.assertEqual(json.loads(response.json()["result"]["content"][0]["text"]), response.json()["result"]["structuredContent"])
        self.assertEqual((await self.client.get("/api/media/jobs/00000000-0000-4000-8000-000000000000", headers=self.headers())).status_code, 404)
        async def complete(_params):
            return self.download()
        self.on_upstream = complete
        receipt = self.output(await self.rpc("download_media", {"platform": "douyin", "content_id": "1", "request_id": "owner-mcp"}))
        self.tool_failure(await self.rpc("get_task_result", {"job_id": receipt["job_id"]}, actor="B"), "job_not_found")

    async def test_business_error_still_revalidates_actor_and_initialization_uses_legacy(self):
        count = 0
        def revoke(_request, _account):
            nonlocal count
            count += 1
            if count >= 2:
                return httpx.Response(303, headers={"location": "/login"})
            return None
        self.on_auth = revoke
        response = await self.rpc("get_task_result", {"job_id": "00000000-0000-4000-8000-000000000000"})
        self.assertEqual(response.status_code, 401)
        self.on_auth = None
        payload = {"jsonrpc": "2.0", "id": 17, "method": "initialize", "params": {"protocolVersion": "2026-07-28", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}}
        result = await self.client.post("/api/media/mcp/", json=payload, headers=self.headers())
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["result"]["protocolVersion"], "2025-03-26")

    async def test_explicit_upstream_rejection_is_failed_and_does_not_resubmit(self):
        async def rejected(_params):
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": "media", "result": {"isError": True, "content": [{"type": "text", "text": "private failure " + self.key}]}})
        self.on_upstream = rejected
        args = {"platform": "douyin", "content_id": "1", "request_id": "declined"}
        first = await self.rpc("download_media", args)
        self.assertTrue(first.json()["result"]["isError"])
        receipt = self.output(first)
        self.assertEqual(receipt["state"], "failed")
        self.assertEqual(receipt["code"], "upstream_rejected")
        self.assertNotIn(self.key, json.dumps(receipt))
        repeated = self.output(await self.rpc("download_media", args))
        self.assertEqual(repeated["job_id"], receipt["job_id"])
        self.assertEqual(len(self.upstream_calls), 1)
        read = await self.rpc("get_video", {"platform": "douyin", "content_id": "1"})
        self.assertTrue(read.json()["result"]["isError"])
        self.assertEqual(self.output(read)["state"], "failed")
        self.assertEqual(self.output(read)["code"], "upstream_rejected")

    async def test_finished_manifest_with_rejected_entries_is_partial_or_failed(self):
        base = self.download()
        valid = base["data"]["files"][0]
        invalid = {**valid, "name": "image.jpg", "kind": "image", "sha256": None}
        manifests = ([valid, invalid], [valid, valid], [valid, {**valid, "name": "other.mp4", "state": "failed"}], [invalid])
        for index, manifest in enumerate(manifests):
            async def finished(_params, entries=manifest):
                return {**base, "data": {"state": "stored", "files": entries}}
            self.on_upstream = finished
            receipt = self.output(await self.rpc("download_media", {"platform": "douyin", "content_id": str(index), "request_id": f"manifest-{index}"}))
            self.assertNotEqual(receipt["state"], "cloud_saved")
            self.assertEqual(receipt["state"], "partial" if index < 3 else "failed")
            self.assertFalse(receipt["file_coverage"]["complete"])
            self.assertEqual(receipt["file_coverage"]["reported"], len(manifest))
            self.assertEqual(receipt["file_coverage"]["rejected"], 1)
            self.assertEqual(receipt["file_coverage"]["accepted"], 1 if index < 3 else 0)

    async def test_oversized_manifest_discloses_truncation(self):
        base = self.download()
        valid = base["data"]["files"][0]
        async def finished(_params):
            return {**base, "data": {"state": "stored", "files": [{**valid, "name": f"video-{index}.mp4"} for index in range(129)]}}
        self.on_upstream = finished
        receipt = self.output(await self.rpc("download_media", {"platform": "douyin", "content_id": "1", "request_id": "manifest-truncated"}))
        self.assertEqual(receipt["state"], "partial")
        self.assertTrue(receipt["file_coverage"]["truncated"])
        self.assertEqual(receipt["file_coverage"]["accepted"], 128)


if __name__ == "__main__":
    unittest.main()
