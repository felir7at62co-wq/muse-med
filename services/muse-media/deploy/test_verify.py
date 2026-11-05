"""Check bounded HTTP response handling without contacting a service."""

import io
import contextlib
import hashlib
import os
import subprocess
import sys
import tempfile
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import urllib.error



import verify as verifier

from verify import MAX_RESPONSE_BYTES, request


class Response(io.BytesIO):
    status = 200


class Opener:
    def __init__(self, body):
        self.body = body

    def open(self, req, timeout):
        return Response(self.body)


class RequestTests(unittest.TestCase):
    def test_json_response_is_decoded(self):
        self.assertEqual(request(Opener(b'{"ok":true}'), "http://127.0.0.1", "/readyz"),
                         (200, {"ok": True}))

    def test_oversized_response_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "2 MiB"):
            request(Opener(b" " * (MAX_RESPONSE_BYTES + 1)), "http://127.0.0.1", "/readyz")

    def test_http_error_body_is_closed_without_reading_its_contents(self):
        body = Response(b"owned response fixture")
        error = urllib.error.HTTPError("http://127.0.0.1/readyz", 503, "unready", {}, body)
        opener = Mock()
        opener.open.side_effect = error
        self.assertEqual(request(opener, "http://127.0.0.1", "/readyz"), (503, {}))
        self.assertTrue(body.closed)


class Clock:
    def __init__(self):
        self.elapsed = 0.0
        self.sleeps = []

    def monotonic(self):
        return self.elapsed

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.elapsed += seconds


class UnreadyOpener:
    def __init__(self, clock):
        self.clock = clock

    def open(self, req, timeout):
        self.clock.elapsed += timeout
        raise urllib.error.URLError("owned unready fixture")


class ProbeProcess:
    def __init__(self, clock, code=3, elapsed=None, timed_out=False, wait_error=None):
        self.clock = clock
        self.code = code
        self.elapsed = elapsed
        self.timed_out = timed_out
        self.wait_error = wait_error
        self.returncode = None
        self.waits = []
        self.killed = False

    def wait(self, timeout=None):
        self.waits.append(timeout)
        if timeout is None:
            if self.returncode is None:
                raise AssertionError("an active probe must be terminated before reaping")
            return self.returncode
        self.clock.elapsed += timeout if self.elapsed is None else self.elapsed
        if self.wait_error is not None:
            raise self.wait_error
        if self.timed_out:
            raise subprocess.TimeoutExpired("owned probe", timeout)
        self.returncode = self.code
        return self.code

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9


class ReadinessTests(unittest.TestCase):
    def test_readiness_has_one_total_budget_including_each_failed_request(self):
        clock = Clock()
        children = []
        def probe(command, **kwargs):
            child = ProbeProcess(clock)
            children.append(child)
            return child
        with patch.object(verifier.time, "monotonic", clock.monotonic), \
             patch.object(verifier.time, "sleep", clock.sleep), \
             patch.object(verifier.urllib.request, "build_opener", return_value=UnreadyOpener(clock)), \
             patch.object(verifier.subprocess, "Popen", side_effect=probe):
            with self.assertRaises(RuntimeError):
                verifier.verify(Path("/owned-fixture/source"), Path("/owned-fixture/env"),
                                Path("/owned-fixture/admin"), Path("/owned-fixture/key"),
                                Path("/owned-fixture/receipt"), 19580)
        self.assertLessEqual(clock.elapsed, 120, "request time must consume the documented total budget")
        self.assertTrue(children)
        self.assertTrue(all(child.waits[-1] is None and child.returncode is not None for child in children))

    def test_last_retry_sleep_is_capped_by_remaining_budget(self):
        clock = Clock()
        def probe(command, **kwargs):
            return ProbeProcess(clock, elapsed=4)
        with patch.object(verifier.time, "monotonic", clock.monotonic), \
             patch.object(verifier.time, "sleep", clock.sleep), \
             patch.object(verifier.subprocess, "Popen", side_effect=probe) as popen:
            with self.assertRaisesRegex(RuntimeError, "within 5 seconds"):
                verifier.wait_ready("http://127.0.0.1:19580", 5)
        self.assertEqual(clock.elapsed, 5)
        self.assertEqual(clock.sleeps, [1])
        self.assertEqual(popen.call_count, 1)

    def test_spawn_time_reduces_the_worker_wait_budget(self):
        clock = Clock()
        child = ProbeProcess(clock)
        def probe(command, **kwargs):
            clock.elapsed += 4
            return child
        with patch.object(verifier.time, "monotonic", clock.monotonic), \
             patch.object(verifier.time, "sleep", clock.sleep), \
             patch.object(verifier.subprocess, "Popen", side_effect=probe):
            with self.assertRaisesRegex(RuntimeError, "within 5 seconds"):
                verifier.wait_ready("http://127.0.0.1:19580", 5)
        self.assertEqual(child.waits, [1, None])
        self.assertEqual(clock.elapsed, 5)

    def test_spawn_exhausting_the_budget_admits_no_wait_and_reaps_the_worker(self):
        clock = Clock()
        child = ProbeProcess(clock)
        def probe(command, **kwargs):
            clock.elapsed += 7
            return child
        with patch.object(verifier.time, "monotonic", clock.monotonic), \
             patch.object(verifier.time, "sleep", clock.sleep), \
             patch.object(verifier.subprocess, "Popen", side_effect=probe):
            with self.assertRaisesRegex(RuntimeError, "within 5 seconds"):
                verifier.wait_ready("http://127.0.0.1:19580", 5)
        self.assertEqual(child.waits, [None])
        self.assertTrue(child.killed)
        self.assertEqual(clock.elapsed, 7, "uninterruptible spawn overhead must not grant another request budget")

    def test_timeout_consumes_remaining_budget_and_kills_then_reaps(self):
        clock = Clock()
        child = ProbeProcess(clock, timed_out=True)
        with patch.object(verifier.time, "monotonic", clock.monotonic), \
             patch.object(verifier.time, "sleep", clock.sleep), \
             patch.object(verifier.subprocess, "Popen", return_value=child):
            with self.assertRaisesRegex(RuntimeError, "within 3.5 seconds"):
                verifier.wait_ready("http://127.0.0.1:19580", 3.5)
        self.assertEqual(clock.elapsed, 3.5)
        self.assertEqual(clock.sleeps, [])
        self.assertEqual(child.waits, [3.5, None])
        self.assertTrue(child.killed)
        self.assertEqual(child.returncode, -9)

    def test_success_is_not_accepted_after_the_deadline(self):
        clock = Clock()
        child = ProbeProcess(clock, code=0, elapsed=3)
        with patch.object(verifier.time, "monotonic", clock.monotonic), \
             patch.object(verifier.time, "sleep", clock.sleep), \
             patch.object(verifier.subprocess, "Popen", return_value=child):
            with self.assertRaisesRegex(RuntimeError, "within 2 seconds"):
                verifier.wait_ready("http://127.0.0.1:19580", 2)
        self.assertEqual(child.waits[-1], None)

    def test_a_retry_can_succeed_within_the_same_deadline_without_inheriting_secrets(self):
        clock = Clock()
        outcomes = iter([3, 0])
        children = []
        def probe(command, **kwargs):
            child = ProbeProcess(clock, code=next(outcomes), elapsed=1)
            children.append(child)
            return child
        with patch.object(verifier.time, "monotonic", clock.monotonic), \
             patch.object(verifier.time, "sleep", clock.sleep), \
             patch.object(verifier.subprocess, "Popen", side_effect=probe) as popen, \
             patch.dict(os.environ, {"DTK_SECRET_KEY": "owned-marker", "HTTP_PROXY": "owned-proxy", "PYTHONPATH": "owned-python-path"}):
            verifier.wait_ready("http://127.0.0.1:19580", 10)
        self.assertEqual(clock.elapsed, 4)
        self.assertEqual([child.waits for child in children], [[10, None], [7, None]])
        for call in popen.call_args_list:
            self.assertLessEqual(set(call.kwargs["env"]), {"SYSTEMROOT", "WINDIR"})
            self.assertEqual(call.args[0][1:3], ["-I", "-c"])
            self.assertNotIn("owned-marker", repr(call))
            self.assertNotIn("owned-proxy", repr(call))
            self.assertEqual(call.kwargs["stdout"], subprocess.DEVNULL)
            self.assertEqual(call.kwargs["stderr"], subprocess.DEVNULL)

    def test_unknown_worker_exit_and_startup_failure_stop_immediately(self):
        clock = Clock()
        for failure in [ProbeProcess(clock, code=19, elapsed=0), OSError("owned startup failure")]:
            with self.subTest(failure=type(failure).__name__), \
                 patch.object(verifier.subprocess, "Popen", side_effect=failure if isinstance(failure, Exception) else None,
                              return_value=failure) as popen, \
                 patch.object(verifier.time, "sleep") as sleep:
                with self.assertRaises(RuntimeError):
                    verifier.wait_ready("http://127.0.0.1:19580", 10)
                self.assertEqual(popen.call_count, 1)
                sleep.assert_not_called()

    def test_interrupted_wait_still_kills_and_reaps_the_worker(self):
        clock = Clock()
        child = ProbeProcess(clock, elapsed=0, wait_error=KeyboardInterrupt())
        with patch.object(verifier.subprocess, "Popen", return_value=child):
            with self.assertRaises(KeyboardInterrupt):
                verifier.wait_ready("http://127.0.0.1:19580", 10)
        self.assertTrue(child.killed)
        self.assertEqual(child.waits[-1], None)

    def test_nonpositive_and_nonfinite_budgets_fail_before_any_probe(self):
        for timeout in [0, -1, float("nan"), float("inf"), -float("inf")]:
            with self.subTest(timeout=timeout), patch.object(verifier.subprocess, "Popen") as popen:
                with self.assertRaises(ValueError):
                    verifier.wait_ready("http://127.0.0.1:19580", timeout)
                popen.assert_not_called()

    def test_worker_is_anonymous_proxy_free_and_reports_only_exit_status(self):
        with patch.object(verifier.urllib.request, "build_opener") as build, \
             patch.object(verifier, "request", return_value=(200, {})) as request:
            self.assertEqual(verifier.readiness_probe("http://127.0.0.1:19580", 4), 0)
        self.assertEqual(build.call_args.args[0].proxies, {})
        self.assertEqual(request.call_args.args[1:3], ("http://127.0.0.1:19580", "/readyz"))
        self.assertEqual(request.call_args.kwargs, {"timeout": 4})
        for outcome in [(503, {}), OSError("owned offline error"), ValueError("owned invalid JSON")]:
            with self.subTest(outcome=type(outcome).__name__), \
                 patch.object(verifier.urllib.request, "build_opener"), \
                 patch.object(verifier, "request", side_effect=outcome if isinstance(outcome, Exception) else None,
                              return_value=outcome):
                self.assertEqual(verifier.readiness_probe("http://127.0.0.1:19580", 4), 3)

    def test_cli_rejects_invalid_budgets_before_reading_operator_files(self):
        for value in ["0", "-1", "nan", "inf", "invalid"]:
            with self.subTest(value=value):
                result = subprocess.run([sys.executable, str(Path(verifier.__file__).resolve()),
                    "--source", "/owned-fixture/nonexistent", "--readiness-timeout", value],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20)
                self.assertEqual(result.returncode, 2)
                self.assertIn("positive finite number", result.stderr)


class DockerFixture:
    def __init__(self):
        self.pin = {"commit": "fixture-commit", "tag": "v5.1.10", "cloakBrowserCommit": "fixture-browser"}
        self.host_ip = "127.0.0.1"
        self.network_mode = "muse-dtk_default"
        self.api_transcriber = False
        self.worker_transcriber = False
        self.transcriber_running = False
        self.metadata_overrides = {}
        self.configuration_overrides = {}
        self.environment_keys = {}
        self.container_ids = {}

    def output(self, arguments, **kwargs):
        if arguments[:2] == ["docker", "compose"]:
            if "ps" in arguments:
                service = arguments[-1]
                if service in self.container_ids:
                    return self.container_ids[service]
                if service == "transcriber" and not self.transcriber_running:
                    return ""
                return "container-" + service
            if "exec" in arguments:
                service = arguments[arguments.index("-T") + 1]
                code = arguments[-1]
                if "head_revision" in code or "alembic_version" in code:
                    return "head-fixture"
                if "browser-rpc:9000" in code:
                    return json.dumps({"status": "ok", "backend": "cloak", "backend_pin": self.pin["cloakBrowserCommit"]})
                if "transcriber_url" in code:
                    return json.dumps(self.configuration_overrides.get(service, {"configured": self.api_transcriber if service == "api" else self.worker_transcriber}))
        if arguments[:2] == ["docker", "inspect"]:
            template = arguments[arguments.index("--format") + 1]
            service = arguments[-1].removeprefix("container-")
            if template == "{{.Image}}":
                return "image-" + service
            if "Config.Env" in template:
                return "\n".join(self.environment_keys.get(service, []))
            if "NetworkSettings.Ports" in template:
                ports = {"8000/tcp": [{"HostIp": self.host_ip, "HostPort": "19580"}]} if service == "api" else {}
                metadata = {"running": True, "networkMode": self.network_mode, "ports": ports}
                metadata.update(self.metadata_overrides.get(service, {}))
                return json.dumps(metadata)
            if "exitCode" in template:
                return json.dumps({"exitCode": 0, "status": "exited"})
        if arguments[:3] == ["docker", "image", "inspect"]:
            template = arguments[arguments.index("--format") + 1]
            if "RepoDigests" in template:
                return "[]"
            if "Config.Labels" in template:
                return json.dumps({"org.opencontainers.image.revision": self.pin["commit"], "org.opencontainers.image.version": self.pin["tag"]})
        raise AssertionError("unexpected fixture command: " + repr(arguments))


class RuntimeTests(unittest.TestCase):
    def test_public_host_bindings_cannot_be_certified_private(self):
        docker = DockerFixture()
        docker.host_ip = "0.0.0.0"
        with patch.object(verifier.subprocess, "check_output", side_effect=docker.output):
            with self.assertRaises(RuntimeError):
                verifier.runtime(Path("/owned-fixture/source"), Path("/owned-fixture/env"), docker.pin)


    def test_runtime_receipt_uses_observed_bindings_and_effective_configuration(self):
        docker = DockerFixture()
        with patch.object(verifier.subprocess, "check_output", side_effect=docker.output) as output:
            result = verifier.runtime(Path("/owned-fixture/source"), Path("/owned-fixture/env"), docker.pin)
        self.assertEqual(result["listen"], "127.0.0.1:19580")
        self.assertEqual(result["publishedBindings"]["api"], [{"containerPort": "8000/tcp", "hostIp": "127.0.0.1", "hostPort": 19580}])
        self.assertEqual(result["networkModes"]["api"], "muse-dtk_default")
        self.assertEqual(result["transcriberRuntime"], {"api": False, "worker": False, "containerRunning": False})
        self.assertIs(result["transcriberEnabled"], False)
        self.assertNotIn("profiles", result)
        for call in output.call_args_list:
            self.assertNotIn("{{json .Config.Env}}", call.args[0])

    def test_public_missing_ambiguous_and_shared_network_states_are_rejected(self):
        api_port = lambda ip, port="19580": {"8000/tcp": [{"HostIp": ip, "HostPort": port}]}
        cases = [
            ("api", {"ports": api_port("::")}),
            ("api", {"ports": api_port("")}),
            ("api", {"ports": api_port("localhost")}),
            ("api", {"ports": api_port("127.0.0.1", "19581")}),
            ("api", {"ports": {}}),
            ("api", {"ports": None}),
            ("api", {"ports": {"8000/tcp": "unknown"}}),
            ("api", {"ports": {"8000/tcp": [{"HostIp": "127.0.0.1"}]}}),
            ("worker", {"ports": {"unknown": [{"HostIp": "127.0.0.1", "HostPort": "1234"}]}}),
            ("browser-rpc", {"ports": {"9000/tcp": [{"HostIp": "0.0.0.0", "HostPort": "19000"}]}}),
            ("api", {"running": False}),
            ("api", {"networkMode": "host"}),
            ("worker", {"networkMode": "container:shared-fixture"}),
            ("worker", {"networkMode": None}),
        ]
        for service, metadata in cases:
            docker = DockerFixture()
            docker.metadata_overrides[service] = metadata
            with self.subTest(service=service, metadata=metadata), \
                 patch.object(verifier.subprocess, "check_output", side_effect=docker.output):
                with self.assertRaises(RuntimeError):
                    verifier.runtime(Path("/owned-fixture/source"), Path("/owned-fixture/env"), docker.pin)
        for ids in ["", "container-api-one\ncontainer-api-two"]:
            docker = DockerFixture()
            docker.container_ids["api"] = ids
            with self.subTest(ids=ids), patch.object(verifier.subprocess, "check_output", side_effect=docker.output):
                with self.assertRaises(RuntimeError):
                    verifier.runtime(Path("/owned-fixture/source"), Path("/owned-fixture/env"), docker.pin)

    def test_api_worker_or_running_transcriber_cannot_be_reported_disabled(self):
        for field in ["api_transcriber", "worker_transcriber", "transcriber_running"]:
            docker = DockerFixture()
            setattr(docker, field, True)
            with self.subTest(field=field), patch.object(verifier.subprocess, "check_output", side_effect=docker.output):
                with self.assertRaisesRegex(RuntimeError, "transcriber"):
                    verifier.runtime(Path("/owned-fixture/source"), Path("/owned-fixture/env"), docker.pin)
        for value in [None, "false", 0, {}]:
            docker = DockerFixture()
            docker.configuration_overrides["worker"] = {"configured": value}
            with self.subTest(value=value), patch.object(verifier.subprocess, "check_output", side_effect=docker.output):
                with self.assertRaisesRegex(RuntimeError, "transcriber"):
                    verifier.runtime(Path("/owned-fixture/source"), Path("/owned-fixture/env"), docker.pin)

    def test_ipv6_loopback_publications_are_observed_without_rejecting_private_bindings(self):
        docker = DockerFixture()
        docker.metadata_overrides["api"] = {"ports": {"8000/tcp": [
            {"HostIp": "127.0.0.1", "HostPort": "19580"}, {"HostIp": "::1", "HostPort": "19580"}]}}
        with patch.object(verifier.subprocess, "check_output", side_effect=docker.output):
            result = verifier.runtime(Path("/owned-fixture/source"), Path("/owned-fixture/env"), docker.pin)
        self.assertEqual(len(result["publishedBindings"]["api"]), 2)
        self.assertEqual({row["hostIp"] for row in result["publishedBindings"]["api"]}, {"127.0.0.1", "::1"})

    def test_runtime_proxy_key_is_rejected_without_fetching_its_value(self):
        docker = DockerFixture()
        docker.environment_keys["worker"] = ["PATH", "hTTp_PrOxY"]
        with patch.object(verifier.subprocess, "check_output", side_effect=docker.output):
            with self.assertRaisesRegex(RuntimeError, "runtime proxy"):
                verifier.runtime(Path("/owned-fixture/source"), Path("/owned-fixture/env"), docker.pin)


class VerifyFlowTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="muse-dtk-verify-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.deploy = self.root / "deploy"
        self.deploy.mkdir()
        self.admin = self.root / "owned-admin.json"
        self.admin.write_text(json.dumps({"username": "owned-admin", "password": "owned-fixture-password"}))
        self.key = self.root / "owned-key"
        self.receipt = self.root / "receipt.json"
        archive = self.root / "source-v5.1.10.tar.gz"
        archive.write_bytes(b"owned source archive")
        self.docker = DockerFixture()
        self.docker.pin["sourceArchiveSha256"] = hashlib.sha256(archive.read_bytes()).hexdigest()
        (self.deploy / "upstream.json").write_text(json.dumps(self.docker.pin))
        dockerfile = self.deploy / "Dockerfile.browser"
        dockerfile.write_bytes(b"owned browser Dockerfile")
        (self.deploy / "browser-build.json").write_text(json.dumps({"deploymentDockerfileSha256": hashlib.sha256(dockerfile.read_bytes()).hexdigest()}))
        self.transcriber = {"configured": False, "ok": None}
        self.calls = []

    def request(self, opener, base, path, body=None, key=None, timeout=20):
        self.calls.append(path)
        if path == "/api/setup/status":
            return 200, {"data": {"initialized": True}}
        if path == "/api/v1/auth/login":
            return 200, {}
        if path == "/api/v1/system/status":
            components = {"browser_rpc": {"configured": True, "ok": True}, "downloader": {"configured": True, "ok": True}}
            if self.transcriber is not None:
                components["transcriber"] = self.transcriber
            return 200, {"data": {"version": "5.1.10", "components": components}}
        if path == "/api/v1/admin/api-keys":
            return 201, {"data": {"key": "owned-fixture-service-key"}}
        if path == "/mcp/":
            if key is None:
                return 401, {}
            return 200, {"result": {"tools": [{"name": name} for name in sorted(verifier.TOOLS)]}}
        if path == "/api/v1/admin/users":
            return 403, {}
        raise AssertionError("unexpected fixture HTTP path: " + path)

    def run_verify(self, admin=None):
        with patch.object(verifier, "__file__", str(self.deploy / "verify.py")), \
             patch.object(verifier, "wait_ready") as readiness, \
             patch.object(verifier, "request", side_effect=self.request) as request, \
             patch.object(verifier.subprocess, "check_output", side_effect=self.docker.output), \
             contextlib.redirect_stdout(io.StringIO()):
            verifier.verify(self.source, self.root / "owned-env", self.admin if admin is None else admin,
                            self.key, self.receipt, 19580, 17)
        readiness.assert_called_once_with("http://127.0.0.1:19580", 17)
        return request

    def test_safe_complete_flow_records_only_observed_security_states(self):
        self.run_verify()
        receipt = json.loads(self.receipt.read_text())
        self.assertEqual(receipt["listen"], "127.0.0.1:19580")
        self.assertEqual(receipt["publishedBindings"]["api"][0]["hostIp"], "127.0.0.1")
        self.assertEqual(receipt["components"]["browser_rpc"], {"configured": True, "ok": True})
        self.assertEqual(receipt["components"]["transcriber"], {"configured": False, "ok": None})
        self.assertEqual(receipt["transcriberRuntime"], {"api": False, "worker": False, "containerRunning": False})
        self.assertIs(receipt["transcriberEnabled"], False)
        self.assertNotIn("profiles", receipt)
        self.assertLess(self.calls.index("/api/v1/system/status"), self.calls.index("/api/v1/admin/api-keys"))
        self.assertNotIn("owned-fixture-service-key", self.receipt.read_text())
        self.assertNotIn("owned-fixture-password", self.receipt.read_text())
        self.assertEqual(self.key.stat().st_mode & 0o077, 0)

    def test_every_verifier_opener_targets_loopback_directly_without_environment_proxies(self):
        build_opener = verifier.urllib.request.build_opener
        with patch.dict(os.environ, {"HTTP_PROXY": "http://owned.invalid:8080"}), \
             patch.object(verifier.urllib.request, "build_opener", wraps=build_opener) as build:
            self.run_verify()
            with patch.object(verifier, "request", return_value=(200, {})):
                self.assertEqual(verifier.readiness_probe("http://127.0.0.1:19580", 2), 0)
        self.assertEqual(build.call_count, 3)
        for call in build.call_args_list:
            proxies = [handler for handler in call.args if isinstance(handler, verifier.urllib.request.ProxyHandler)]
            self.assertEqual(len(proxies), 1)
            self.assertEqual(proxies[0].proxies, {})
        self.assertTrue(any(isinstance(handler, verifier.urllib.request.HTTPCookieProcessor)
                            for handler in build.call_args_list[0].args))

    def test_unsafe_runtime_stops_before_credentials_authentication_and_key_creation(self):
        for field in ["host_ip", "worker_transcriber", "transcriber_running"]:
            self.calls.clear()
            self.docker = DockerFixture()
            self.docker.pin["sourceArchiveSha256"] = "unused before security gate"
            setattr(self.docker, field, "0.0.0.0" if field == "host_ip" else True)
            admin = Mock(spec=Path)
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                self.run_verify(admin=admin)
            admin.read_text.assert_not_called()
            self.assertEqual(self.calls, [])
            self.assertFalse(self.key.exists())
            self.assertFalse(self.receipt.exists())

    def test_enabled_missing_or_unknown_api_transcriber_never_mints_a_key_or_safe_receipt(self):
        for state in [None, {"configured": True, "ok": False}, {"configured": True, "ok": True},
                      {"configured": False}, {"configured": False, "ok": False}, {"configured": "false", "ok": None}, {}]:
            self.calls.clear()
            self.transcriber = state
            with self.subTest(state=state), self.assertRaisesRegex(RuntimeError, "transcriber"):
                self.run_verify()
            self.assertNotIn("/api/v1/admin/api-keys", self.calls)
            self.assertFalse(self.key.exists())
            self.assertFalse(self.receipt.exists())


if __name__ == "__main__":
    unittest.main()
