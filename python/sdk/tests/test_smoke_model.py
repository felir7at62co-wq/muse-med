from __future__ import annotations

import json
import io
import runpy
import subprocess
import sys
from urllib.error import HTTPError, URLError
import urllib.request
from email.message import Message
from pathlib import Path
from types import SimpleNamespace

import pytest

from deepseek_harness import RunResult


ROOT = Path(__file__).resolve().parents[3]
SMOKE = runpy.run_path(ROOT / "scripts" / "smoke-python-runtime.py")
SESSION_FORMAT_VERSION = int(
    (ROOT / "packages/core/session/src/types.ts").read_text(encoding="utf-8")
    .split("export const SESSION_FORMAT_VERSION = ", 1)[1].splitlines()[0]
)


def live_result(**overrides: object) -> RunResult:
    values = {
        "session_id": "installed-wheel-live-api",
        "final_response": SMOKE["LIVE_API_SENTINEL"],
        "finish_reason": "completed",
        "events": [{"type": "tool/call", "data": {"name": "unrelated_tool"}}],
        "notifications": [],
    }
    values.update(overrides)
    return RunResult(**values)


@pytest.fixture
def live_smoke(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    import deepseek_harness

    state = SimpleNamespace(
        prompts=[], session_ids=[], challenges=[], checked_logs=[], closed=False,
        create_bytes=SMOKE["LIVE_API_SENTINEL"].encode("utf-8"),
        create_result=live_result(), verify_result=live_result(), receipt_mode="copy",
        budget_activated=True,
    )
    globals_ = SMOKE["smoke_sdk_live"].__globals__
    token_hex = globals_["secrets"].token_hex

    def fresh_challenge(size: int) -> str:
        assert len(state.prompts) == 1
        value = token_hex(size)
        state.challenges.append(value)
        return value

    class ScriptedHarness:
        def __init__(self, **kwargs: object) -> None:
            state.root = Path(kwargs["cwd"])
            state.options = kwargs
            state.patches = [json.loads(Path(path).read_text(encoding="utf-8")) for path in kwargs.get("patches", ())]
            state.patch_entries = [entry for patch in state.patches for operation in patch for entry in operation.get("insert", [])]
            for entry in state.patch_entries:
                if entry["id"] == "muse-live-fetch-budget" and state.budget_activated:
                    Path(entry["config"]["receipt"]).write_text(json.dumps({"requests": 0}))
            assert "toolChoice" not in kwargs

        def __enter__(self) -> ScriptedHarness:
            return self

        def __exit__(self, *args: object) -> None:
            state.closed = True

        def close(self) -> None:
            state.closed = True

        def run(self, prompt: str, *, session_id: str) -> RunResult:
            state.prompts.append(prompt)
            state.session_ids.append(session_id)
            for entry in state.patch_entries:
                if entry["id"] == "muse-live-fetch-budget":
                    Path(entry["config"]["receipt"]).write_text(json.dumps({"requests": len(state.prompts) * 2}))
            if len(state.prompts) == 1:
                state.marker = Path(prompt.splitlines()[-1])
                assert state.marker.parent == state.root
                if state.create_bytes is not None:
                    state.marker.write_bytes(state.create_bytes)
                return state.create_result

            assert len(state.prompts) == 2
            assert len(state.challenges) == 1
            challenge = state.challenges[0]
            assert all(challenge not in sent for sent in state.prompts)
            assert str(state.marker) not in prompt
            assert "previous turn" in prompt and "changed externally" in prompt
            assert state.marker.read_bytes() == challenge.encode("ascii")
            receipt = Path(prompt.splitlines()[-1])
            assert receipt != state.marker and not receipt.exists()
            if state.receipt_mode == "copy":
                receipt.write_bytes(state.marker.read_bytes())
            elif state.receipt_mode == "stale":
                receipt.write_bytes(state.create_bytes)
            elif state.receipt_mode == "wrong":
                receipt.write_bytes(b"wrong")
            elif state.receipt_mode == "newline":
                receipt.write_bytes(state.marker.read_bytes() + b"\n")
            elif state.receipt_mode == "changed-source":
                receipt.write_bytes(state.marker.read_bytes())
                state.marker.write_bytes(b"changed")
            elif state.receipt_mode != "missing":
                raise AssertionError(state.receipt_mode)
            return state.verify_result

    monkeypatch.setenv("DEEPSEEK_API_KEY", "unit-test-key")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://api.invalid")
    monkeypatch.setattr(deepseek_harness, "DeepSeekHarness", ScriptedHarness)
    monkeypatch.setattr(globals_["secrets"], "token_hex", fresh_challenge)
    monkeypatch.setitem(globals_, "assert_zstd_session_log", state.checked_logs.append)
    return state


@pytest.fixture
def muse_smoke(live_smoke: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    state = live_smoke
    state.requests = []
    state.login_status = 303
    state.login_cookie = "__Host-muse=temporary_session; Path=/; Secure; HttpOnly"
    state.identity = {"username": "ordinary-ci", "admin": False}
    state.catalog = {"providers": [{"id": "deepseek-official", "models": [{
        "id": "muse-test-model", "name": "Muse test model", "contextWindow": 32768,
        "maxTokens": 4096, "input": ["text"], "reasoningEfforts": False,
    }]}]}
    state.logout_status = 303
    state.secret_checked_logs = []
    values = {"BASE_URL": "https://muse.invalid", "USERNAME": "ordinary-ci", "PASSWORD": "unit-account-password",
              "PROVIDER": "deepseek-official", "MODEL": "muse-test-model"}
    for field, value in values.items():
        monkeypatch.setenv("MUSE_E2E_" + field, value)

    def request(origin: str, path: str, method: str, body: bytes | None = None, cookie: str | None = None):
        assert origin == "https://muse.invalid"
        state.requests.append((path, method, body, cookie))
        headers = Message()
        if path == "/login":
            assert cookie is None
            headers["set-cookie"] = state.login_cookie
            return state.login_status, headers, b""
        assert cookie == "__Host-muse=temporary_session"
        if path == "/logout":
            return state.logout_status, headers, b""
        if path == "/api/muse.account":
            return 200, headers, json.dumps(state.identity).encode()
        assert path == "/api/desktop-models/providers"
        return 200, headers, json.dumps(state.catalog).encode()

    monkeypatch.setitem(SMOKE["smoke_sdk_muse_live"].__globals__, "muse_smoke_request", request)
    monkeypatch.setitem(SMOKE["smoke_sdk_muse_live"].__globals__, "assert_muse_logs_secret_free",
                        lambda sessions, sensitive: state.secret_checked_logs.append(sessions))
    return state


def test_muse_live_smoke_uses_session_authorized_relay_and_logs_out(muse_smoke: SimpleNamespace) -> None:
    SMOKE["smoke_sdk_muse_live"]()
    assert [(path, method) for path, method, _, _ in muse_smoke.requests] == [
        ("/login", "POST"), ("/api/muse.account", "GET"), ("/api/desktop-models/providers", "GET"), ("/logout", "POST"),
    ]
    assert muse_smoke.requests[0][2] == b"username=ordinary-ci&password=unit-account-password"
    assert len(muse_smoke.prompts) == 2 and len(muse_smoke.checked_logs) == 1
    assert muse_smoke.closed and not muse_smoke.root.exists()
    assert muse_smoke.options["provider"] == "muse-ci-relay"
    assert "api_key" not in muse_smoke.options and "base_url" not in muse_smoke.options
    assert muse_smoke.options["max_tokens"] == 1024
    assert len(muse_smoke.secret_checked_logs) == 1
    environment = muse_smoke.options["env"]
    assert environment["MUSE_E2E_PASSWORD"] == environment["DEEPSEEK_API_KEY"] == ""
    assert environment["MUSE_E2E_USERNAME"] == ""
    assert environment["DEEPSEEK_BASE_URL"] == ""
    assert environment["MUSE_E2E_SESSION_TOKEN"] == "temporary_session"
    patch = muse_smoke.patches[0]
    assert patch[:2] == [{"id": "llm-deepseek", "disabled": True}, {"id": "llm-deepseek-account", "disabled": True}]
    assert patch[2] == {"id": "llm-retry", "disabled": True}
    profile = patch[3]["config"]["providers"]["muse-ci-relay"]
    assert profile["baseURL"] == "https://muse.invalid/api/desktop-models/deepseek-official"
    assert profile["apiKeyEnv"] == "MUSE_E2E_SESSION_TOKEN"
    assert profile["headers"] == {"origin": "https://muse.invalid"}
    assert profile["retryPolicy"] == {"mode": "normal", "maxRetries": 0}
    assert patch[4]["insert"][0]["id"] == "muse-live-fetch-budget"
    assert patch[4]["insert"][0]["config"] == {
        "url": "https://muse.invalid/api/desktop-models/deepseek-official/chat/completions",
        "receipt": str(muse_smoke.root / "muse-fetch-budget.json"), "requests": 6, "tokens": 1024, "milliseconds": 180000,
    }
    assert "temporary_session" not in json.dumps(patch) and "unit-account-password" not in json.dumps(patch)


@pytest.mark.parametrize("field", ["BASE_URL", "USERNAME", "PASSWORD", "PROVIDER", "MODEL"])
def test_muse_live_smoke_requires_explicit_configuration(
    muse_smoke: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, field: str,
) -> None:
    monkeypatch.delenv("MUSE_E2E_" + field)
    with pytest.raises(AssertionError, match="requires MUSE_E2E_" + field):
        SMOKE["smoke_sdk_muse_live"]()
    assert not muse_smoke.requests


@pytest.mark.parametrize(("field", "value", "message"), [
    ("BASE_URL", "http://muse.invalid", "HTTPS origin"),
    ("BASE_URL", "https://user:password@muse.invalid", "HTTPS origin"),
    ("BASE_URL", "https://muse.invalid/api", "HTTPS origin"),
    ("BASE_URL", "https://muse.invalid:invalid", "HTTPS origin"),
    ("BASE_URL", "https://muse.invalid?token=private", "HTTPS origin"),
    ("PROVIDER", "../supplier", "PROVIDER is invalid"),
    ("MODEL", "bad\nmodel", "MODEL is invalid"),
])
def test_muse_live_smoke_rejects_invalid_configuration(
    muse_smoke: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, field: str, value: str, message: str,
) -> None:
    monkeypatch.setenv("MUSE_E2E_" + field, value)
    with pytest.raises(AssertionError, match=message):
        SMOKE["smoke_sdk_muse_live"]()
    assert not muse_smoke.requests


@pytest.mark.parametrize("failure", ["admin", "admin-shape", "identity", "direct", "access", "provider", "model", "limits", "input"])
def test_muse_live_smoke_refuses_privileged_or_unavailable_routes_and_revokes_login(
    muse_smoke: SimpleNamespace, failure: str,
) -> None:
    if failure == "admin":
        muse_smoke.identity["admin"] = True
    elif failure == "admin-shape":
        muse_smoke.identity["admin"] = "false"
    elif failure == "identity":
        muse_smoke.identity["username"] = "another-account"
    elif failure == "direct":
        muse_smoke.catalog["transport"] = "direct"
    elif failure == "access":
        muse_smoke.catalog["providers"][0]["access"] = {"apiKey": "must-never-use"}
    elif failure == "provider":
        muse_smoke.catalog["providers"] = []
    elif failure == "model":
        muse_smoke.catalog["providers"][0]["models"] = []
    elif failure == "limits":
        muse_smoke.catalog["providers"][0]["models"][0]["maxTokens"] = 0
    else:
        muse_smoke.catalog["providers"][0]["models"][0]["input"] = ["image"]
    with pytest.raises(AssertionError):
        SMOKE["smoke_sdk_muse_live"]()
    assert muse_smoke.requests[-1][:2] == ("/logout", "POST")
    assert not muse_smoke.prompts


@pytest.mark.parametrize(("status", "cookie"), [(401, "__Host-muse=temporary_session"), (302, "__Host-muse=temporary_session"),
                                               (303, "other=value"), (303, "__Host-muse=bad token")])
def test_muse_live_smoke_rejects_failed_login_without_model_calls(
    muse_smoke: SimpleNamespace, status: int, cookie: str,
) -> None:
    muse_smoke.login_status, muse_smoke.login_cookie = status, cookie
    with pytest.raises(AssertionError, match="login was rejected"):
        SMOKE["smoke_sdk_muse_live"]()
    assert len(muse_smoke.requests) == 1 and not muse_smoke.prompts


def test_muse_live_smoke_revokes_login_after_invalid_tool_receipt(muse_smoke: SimpleNamespace) -> None:
    muse_smoke.receipt_mode = "stale"
    with pytest.raises(AssertionError, match="verify turn wrote unexpected bytes"):
        SMOKE["smoke_sdk_muse_live"]()
    assert muse_smoke.requests[-1][:2] == ("/logout", "POST")
    assert muse_smoke.closed and not muse_smoke.root.exists()


def test_muse_live_smoke_requires_logout_success(muse_smoke: SimpleNamespace) -> None:
    muse_smoke.logout_status = 503
    with pytest.raises(AssertionError, match="logout was rejected"):
        SMOKE["smoke_sdk_muse_live"]()


def test_muse_live_smoke_requires_an_active_http_guard_before_any_model_use(muse_smoke: SimpleNamespace) -> None:
    muse_smoke.budget_activated = False
    with pytest.raises(AssertionError, match="did not activate its HTTP request guard"):
        SMOKE["smoke_sdk_muse_live"]()
    assert not muse_smoke.prompts
    assert muse_smoke.requests[-1][:2] == ("/logout", "POST")


def test_muse_live_smoke_rejects_sensitive_model_output_before_displaying_it(muse_smoke: SimpleNamespace) -> None:
    muse_smoke.create_result = live_result(final_response="temporary_session")
    with pytest.raises(AssertionError, match="sensitive account information") as error:
        SMOKE["smoke_sdk_muse_live"]()
    assert "temporary_session" not in str(error.value)
    assert muse_smoke.requests[-1][:2] == ("/logout", "POST")
    assert muse_smoke.closed and not muse_smoke.root.exists()


def test_muse_live_smoke_joins_its_expired_watchdog_before_cleanup(
    muse_smoke: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = SimpleNamespace(cancelled=False, joined=False)

    class Timer:
        def __init__(self, seconds: float, callback: object) -> None:
            assert 0 < seconds <= 180
            self.callback = callback

        def start(self) -> None:
            self.callback()

        def cancel(self) -> None:
            state.cancelled = True

        def join(self) -> None:
            assert state.cancelled
            state.joined = True

    monkeypatch.setattr(SMOKE["run_sdk_live_task"].__globals__["threading"], "Timer", Timer)
    with pytest.raises(AssertionError, match="total runtime deadline"):
        SMOKE["smoke_sdk_muse_live"]()
    assert state.cancelled and state.joined
    assert not muse_smoke.prompts and muse_smoke.closed and not muse_smoke.root.exists()
    assert muse_smoke.requests[-1][:2] == ("/logout", "POST")


def test_muse_live_budget_guards_actual_fetch_and_restores_process_state(tmp_path: Path) -> None:
    plugin = tmp_path / "budget.mjs"
    plugin.write_text(SMOKE["MUSE_FETCH_BUDGET_PLUGIN"], encoding="utf-8")
    script = """\
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { apply } = await import(pathToFileURL(process.argv[2]));
const receipt = process.argv[3];
const url = 'https://muse.invalid/api/desktop-models/provider/chat/completions';
const forwarded = [], timers = [];
const original = async (_input, init) => { forwarded.push(init.signal); return new Response('ok'); };
globalThis.fetch = original;
globalThis.setTimeout = callback => { const timer = { callback, unref() {} }; timers.push(timer); return timer; };
globalThis.clearTimeout = timer => { timer.cleared = true; };
let dispose;
const mount = () => apply({ effect(callback) { dispose = callback(); } }, {
  url, receipt, requests: 6, tokens: 1024, milliseconds: 180000,
});
const request = tokens => ({ method: 'POST', body: JSON.stringify({ max_tokens: tokens }) });
mount();
for (let index = 0; index < 6; index++) await fetch(url, request(1024));
await assert.rejects(fetch(url, request(1024)), /HTTP request budget/);
assert.equal(forwarded.length, 6);
assert.equal(JSON.parse(readFileSync(receipt)).requests, 6);
dispose();
assert.equal(globalThis.fetch, original);
assert.ok(forwarded.every(signal => signal.aborted));
assert.ok(timers.at(-1).cleared);
mount();
for (const body of [{}, { max_tokens: 0 }, { max_tokens: 1025 }, { max_tokens: 1024, max_completion_tokens: 1025 }]) {
  await assert.rejects(fetch(url, { body: JSON.stringify(body) }), /unbounded model output/);
}
await assert.rejects(fetch('https://supplier.invalid/chat/completions', request(1)), /unexpected network endpoint/);
assert.equal(forwarded.length, 6);
timers.at(-1).callback();
await assert.rejects(fetch(url, request(1)), /runtime deadline/);
dispose();
assert.equal(globalThis.fetch, original);
console.log('MUSE_HTTP_BUDGET_ENFORCED');
"""
    result = subprocess.run(["node", "--input-type=module", "-", str(plugin), str(tmp_path / "receipt.json")],
                            input=script, text=True, capture_output=True, timeout=20, check=False)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "MUSE_HTTP_BUDGET_ENFORCED"


def test_muse_session_scan_checks_decompressed_bytes(tmp_path: Path) -> None:
    import zstandard

    log = tmp_path / f"session.v{SESSION_FORMAT_VERSION}.jsonl.zstd"
    log.write_bytes(zstandard.ZstdCompressor().compress(b'{"content":"ordinary-account-token"}\n'))
    with pytest.raises(AssertionError, match="sensitive account information") as error:
        SMOKE["assert_muse_logs_secret_free"](tmp_path, ("ordinary-account-token",))
    assert "ordinary-account-token" not in str(error.value)
    SMOKE["assert_muse_logs_secret_free"](tmp_path, ("absent-token",))


def test_muse_session_scan_requires_a_persisted_log(tmp_path: Path) -> None:
    with pytest.raises(AssertionError, match="no persisted Session"):
        SMOKE["assert_muse_logs_secret_free"](tmp_path, ("sensitive-token",))


def test_muse_account_transport_never_negotiates_direct_or_follows_redirects(monkeypatch: pytest.MonkeyPatch) -> None:
    state = SimpleNamespace(request=None, handler=None, timeout=None)

    class Response(io.BytesIO):
        code = 200
        headers = Message()

    class Opener:
        def open(self, request: urllib.request.Request, *, timeout: int) -> Response:
            state.request, state.timeout = request, timeout
            return Response(b'{"providers":[]}')

    def opener(handler: object) -> Opener:
        state.handler = handler
        return Opener()

    globals_ = SMOKE["muse_smoke_request"].__globals__
    monkeypatch.setitem(globals_, "build_opener", opener)
    status, _, body = SMOKE["muse_smoke_request"](
        "https://muse.invalid", "/api/desktop-models/providers", "GET", cookie="__Host-muse=transport-test",
    )
    assert status == 200 and json.loads(body) == {"providers": []}
    assert state.request.full_url == "https://muse.invalid/api/desktop-models/providers"
    assert dict(state.request.header_items()) == {
        "Origin": "https://muse.invalid", "Accept": "application/json", "Cookie": "__Host-muse=transport-test",
    }
    assert state.timeout == 30
    assert state.handler.redirect_request(state.request, None, 303, "See Other", Message(), "https://elsewhere.invalid") is None


@pytest.mark.parametrize("failure", ["redirect", "network", "oversize"])
def test_muse_account_transport_bounds_and_sanitizes_responses(monkeypatch: pytest.MonkeyPatch, failure: str) -> None:
    class Response(io.BytesIO):
        code = 200
        headers = Message()

    class Opener:
        def open(self, request: urllib.request.Request, *, timeout: int) -> Response:
            if failure == "redirect":
                headers = Message()
                headers["set-cookie"] = "__Host-muse=issued-session; Path=/"
                raise HTTPError(request.full_url, 303, "See Other", headers, io.BytesIO(b""))
            if failure == "network":
                raise URLError("private credential detail")
            return Response(b"x" * (2 * 1024 * 1024 + 1))

    monkeypatch.setitem(SMOKE["muse_smoke_request"].__globals__, "build_opener", lambda _: Opener())
    if failure == "redirect":
        status, headers, body = SMOKE["muse_smoke_request"]("https://muse.invalid", "/login", "POST", b"username=ordinary")
        assert status == 303 and headers.get("set-cookie").startswith("__Host-muse=issued-session") and body == b""
    else:
        with pytest.raises(AssertionError, match="request failed" if failure == "network" else "exceeded its byte limit") as error:
            SMOKE["muse_smoke_request"]("https://muse.invalid", "/login", "POST", b"username=ordinary")
        assert "private credential detail" not in str(error.value)


@pytest.mark.parametrize("scenario", ["sdk-live", "sdk-muse-live"])
def test_live_scenarios_require_installed_wheels(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], scenario: str) -> None:
    monkeypatch.setattr(sys, "argv", ["smoke-python-runtime.py", "--scenario", scenario])
    with pytest.raises(SystemExit) as error:
        SMOKE["main"]()
    assert error.value.code == 2
    assert f"--scenario {scenario} requires --installed-wheel" in capsys.readouterr().err


def test_live_smoke_requires_fresh_external_content(live_smoke: SimpleNamespace) -> None:
    SMOKE["smoke_sdk_live"]()
    assert len(live_smoke.prompts) == 2
    assert live_smoke.session_ids == ["installed-wheel-live-api"] * 2
    assert len(live_smoke.checked_logs) == 1
    assert live_smoke.closed and not live_smoke.root.exists()


@pytest.mark.parametrize("label", ["create", "verify"])
@pytest.mark.parametrize(("overrides", "message"), [
    ({"finish_reason": "error"}, "turn ended with 'error'"),
    ({"finish_reason": "error", "events": [{
        "type": "turn/end", "data": {"turn": 1, "reason": {
            "kind": "error", "error": {"code": "AUTH", "status": 401},
        }},
    }]}, "turn ended with.*AUTH.*401"),
    ({"events": []}, "turn made no model-requested tool call"),
    ({"final_response": "PYTHON_SDK_LIVE_OK extra"}, "turn returned"),
])
def test_live_smoke_rejects_invalid_turn_before_continuing(
    live_smoke: SimpleNamespace, label: str, overrides: dict[str, object], message: str,
) -> None:
    setattr(live_smoke, f"{label}_result", live_result(**overrides))
    with pytest.raises(AssertionError, match=f"{label} {message}"):
        SMOKE["smoke_sdk_live"]()
    assert len(live_smoke.prompts) == (1 if label == "create" else 2)
    assert not live_smoke.checked_logs
    assert live_smoke.closed
    if label == "create":
        assert not live_smoke.challenges


@pytest.mark.parametrize("content", [None, b"wrong", b"PYTHON_SDK_LIVE_OK\n"])
def test_live_smoke_rejects_bad_create_before_host_overwrite(
    live_smoke: SimpleNamespace, content: bytes | None,
) -> None:
    live_smoke.create_bytes = content
    with pytest.raises(AssertionError, match="create turn (did not create|wrote unexpected bytes)"):
        SMOKE["smoke_sdk_live"]()
    assert len(live_smoke.prompts) == 1
    assert not live_smoke.challenges and not live_smoke.checked_logs
    assert live_smoke.closed


@pytest.mark.parametrize(("mode", "message"), [
    ("missing", "did not create receipt"),
    ("stale", "wrote unexpected bytes to receipt"),
    ("wrong", "wrote unexpected bytes to receipt"),
    ("newline", "wrote unexpected bytes to receipt"),
    ("changed-source", "changed source file"),
])
def test_live_smoke_rejects_unrelated_tool_without_exact_receipt(
    live_smoke: SimpleNamespace, mode: str, message: str,
) -> None:
    live_smoke.receipt_mode = mode
    with pytest.raises(AssertionError, match=f"verify turn {message}"):
        SMOKE["smoke_sdk_live"]()
    assert len(live_smoke.prompts) == 2
    assert not live_smoke.checked_logs
    assert live_smoke.closed


@pytest.mark.parametrize(
    ("prompt_name", "expected"),
    [
        ("SNAPSHOT_DIRECT_CHILD_PROMPT", "DIRECT_CHILD_OK"),
        ("SNAPSHOT_WORKFLOW_CHILD_PROMPT", "WORKFLOW_CHILD_OK"),
    ],
)
def test_child_prompt_precedes_runtime_context(prompt_name: str, expected: str) -> None:
    chunks = SMOKE["completion_chunks"]({
        "messages": [
            {"role": "user", "content": [
                {"type": "text", "text": SMOKE[prompt_name]},
                {"type": "text", "text": "Current runtime context"},
            ]},
        ],
    })

    assert any(
        chunk.get("delta", {}).get("text") == expected
        for chunk in chunks
    )


def test_mcp_smoke_requests_the_discovered_tool() -> None:
    chunks = SMOKE["completion_chunks"]({
        "messages": [{"role": "user", "content": [{"type": "text", "text": SMOKE["MCP_PROMPT"]}]}],
        "tools": [{"name": "mcp__fixture__add", "input_schema": {"type": "object"}}],
    })

    calls = [
        chunk["content_block"]
        for chunk in chunks
        if chunk.get("type") == "content_block_start"
    ]
    assert calls == [{"type": "tool_use", "id": "mcp-add", "name": "mcp__fixture__add", "input": {}}]
    arguments = next(chunk["delta"]["partial_json"] for chunk in chunks if chunk.get("type") == "content_block_delta")
    assert json.loads(arguments) == {"a": 19, "b": 23}


def test_mcp_smoke_accepts_the_external_server_result() -> None:
    chunks = SMOKE["completion_chunks"]({
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": SMOKE["MCP_PROMPT"]}]},
            {
                "role": "assistant",
                "content": [{
                    "type": "tool_use", "id": "mcp-add", "name": "mcp__fixture__add", "input": {},
                }],
            },
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "mcp-add", "content": [{"type": "text", "text": "42"}]},
            ]},
        ],
    })

    assert any(
        chunk.get("delta", {}).get("text") == SMOKE["MCP_TEXT"]
        for chunk in chunks
    )


def test_mock_model_serves_native_messages_events() -> None:
    with SMOKE["MockModel"]() as model:
        body = {"model": "smoke-model", "stream": True, "messages": [{
            "role": "user", "content": [{"type": "text", "text": "hello"}],
        }]}
        request = urllib.request.Request(
            model.url + "/v1/messages", data=json.dumps(body).encode(),
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(request) as response:
            stream = response.read().decode()
        frames = [frame.splitlines() for frame in stream.strip().split("\n\n")]
        events = [json.loads(frame[1].removeprefix("data: ")) for frame in frames]
        assert all(frame[0] == f"event: {event['type']}" for frame, event in zip(frames, events))
        assert events[0]["type"] == "message_start"
        assert events[-1] == {"type": "message_stop"}
        assert next(event["delta"]["text"] for event in events if event["type"] == "content_block_delta") == SMOKE["EXPECTED_TEXT"]


def test_advanced_snapshot_normalizes_catalog_child_creation_time() -> None:
    value = {
        "type": "subagent/catalog",
        "data": {
            "childCreatedAt": 1788246207176,
        },
    }

    assert SMOKE["normalize_snapshot_value"](value, []) == {
        "type": "subagent/catalog",
        "data": {
            "childCreatedAt": 0,
        },
    }

    assert SMOKE["normalize_snapshot_value"](
        {"type": "fixture/event", "data": {"childCreatedAt": 1788246207176}},
        [],
    ) == {"type": "fixture/event", "data": {"childCreatedAt": 1788246207176}}


def test_snapshot_comparison_preserves_opaque_generation_qualifiers() -> None:
    normalize = SMOKE["normalize_session_format_comparison"]
    expected = {
        "header": {"type": "session", "version": 0, "otherVersion": 7},
        "accepted": {
            "type": "session-log-deepseek/delivery-accepted",
            "data": {"sessionId": "s", "throughSeq": 4},
        },
        "source": {
            "kind": "session-reference",
            "references": [{"sessionId": "other", "capturedThroughSeq": 8}],
        },
    }
    actual = {
        "header": {"type": "session", "version": 1, "otherVersion": 7},
        "accepted": {
            "type": "session-log-deepseek/delivery-accepted",
            "data": {"sessionId": "s", "sessionFormatVersion": 1, "throughSeq": 4},
        },
        "source": {
            "kind": "session-reference",
            "references": [{
                "sessionId": "other",
                "capturedFormatVersion": 1,
                "capturedThroughSeq": 8,
            }],
        },
    }

    assert normalize(expected) != normalize(actual)
    assert normalize(expected)["header"] == normalize(actual)["header"]
    assert normalize(expected)["header"]["otherVersion"] == 7
    assert normalize(actual)["accepted"] == actual["accepted"]
    assert normalize(actual)["source"] == actual["source"]


def test_snapshot_value_scrubs_system_nodes_without_erasing_header_fields() -> None:
    normalize = SMOKE["normalize_snapshot_value"]
    system = {
        "type": "system/message",
        "data": {"message": {"role": "system", "content": [{"type": "text", "text": "prompt"}]}},
    }
    header = {"type": "request/header", "data": {"header": {"system": "unexpected"}}}
    assert normalize(system, [])["data"]["message"]["content"] == [{"type": "text", "text": "{{system}}"}]
    assert normalize(header, []) == header
    empty = {"type": "system/message", "data": {"message": {"role": "system", "content": []}}}
    assert normalize(empty, []) == empty


def test_snapshot_value_preserves_deterministic_tool_repair_ids() -> None:
    normalize = SMOKE["normalize_snapshot_value"]
    repair = {
        "type": "tool/result", "seq": 19, "time": 123,
        "data": {"message": {
            "id": "interrupted-tool-result-scheduler-unstarted-19",
            "role": "tool", "source": {"kind": "tool", "callId": "scheduler-unstarted"},
            "toolCallId": "scheduler-unstarted", "isError": True,
            "content": [{"type": "text", "text": "The tool did not start."}],
        }},
    }
    normalized = normalize(repair, [])
    assert normalized["data"]["message"]["id"] == repair["data"]["message"]["id"]
    assert normalized["seq"] == 19
    assert normalized["time"] == 0
    ordinary = {
        "id": "521f38bb-fb22-45cb-af5f-a9cc370a1814", "role": "tool",
        "toolCallId": "scheduler-complete",
        "source": {"kind": "tool", "callId": "scheduler-complete"}, "content": [],
    }
    assert normalize(ordinary, [])["id"] == "{{messageId}}"
    wrong_call = {**repair["data"]["message"], "toolCallId": "other"}
    assert normalize(wrong_call, [])["id"] == "{{messageId}}"
    historical = {**repair["data"]["message"], "role": "user"}
    historical.pop("toolCallId")
    assert normalize(historical, [])["id"] == repair["data"]["message"]["id"]


def test_snapshot_value_normalizes_embedded_assistant_stream_timing() -> None:
    normalize = SMOKE["normalize_snapshot_value"]
    event = {
        "type": "assistant/message",
        "seq": 4,
        "time": 100,
        "data": {
            "stream": [
                {"type": "chunk", "time": 101, "chunk": {"type": "finish"}},
                {"type": "text-chunks", "time0": 102, "dt": [1, 2], "texts": ["a", "b", "c"]},
            ],
        },
    }

    normalized = normalize(event, [])

    assert normalized["time"] == 0
    assert normalized["data"]["stream"] == [
        {"type": "chunk", "time": 0, "chunk": {"type": "finish"}},
        {"type": "text-chunks", "time0": 0, "dt": [0, 0], "texts": ["a", "b", "c"]},
    ]


def test_snapshot_comparison_expands_embedded_assistant_streams() -> None:
    normalize = SMOKE["normalize_session_format_comparison"]
    expected = [
        {
            "type": "assistant/chunk",
            "seq": 4,
            "time": 0,
            "data": {"turn": 1, "step": 1, "chunk": {
                "type": "text-delta", "index": 0, "text": "done",
            }},
        },
        {
            "type": "assistant/message",
            "seq": 5,
            "time": 0,
            "data": {"turn": 1, "step": 1, "message": {"role": "assistant"}},
            "sourceEventSeqs": [4],
            "surfaceOp": "append",
        },
    ]
    actual = [{
        "type": "assistant/message",
        "seq": 4,
        "time": 0,
        "data": {
            "turn": 1,
            "step": 1,
            "message": {"role": "assistant"},
            "stream": [{
                "type": "text-chunks", "time0": 0, "index": 0, "dt": [], "texts": ["done"],
            }],
        },
        "surfaceOp": "append",
    }]

    assert normalize(actual, 2) == normalize(expected, 1)

    tool_result = {
        "type": "tool/result",
        "data": {"turn": 1, "step": 1},
        "sourceEventSeqs": [4],
    }
    assert normalize(tool_result, 1)["sourceEventSeqs"] == [4]
    assert normalize(tool_result, 2)["sourceEventSeqs"] == [4]


def test_snapshot_stream_expands_reasoning_and_tool_call_records() -> None:
    expand = SMOKE["expand_snapshot_stream_member"]

    assert expand({
        "type": "reasoning-chunks", "time0": 0, "index": 1,
        "dt": [], "texts": ["think"],
    }) == [{"type": "reasoning-delta", "index": 1, "text": "think"}]
    assert expand({
        "type": "tool-call-chunks", "time0": 0, "index": 2,
        "id": "call-1", "name": "read", "dt": [1], "args": ["{", "}"],
    }) == [
        {"type": "tool-call-delta", "index": 2, "id": "call-1", "name": "read", "argumentsDelta": "{"},
        {"type": "tool-call-delta", "index": 2, "id": "call-1", "name": "read", "argumentsDelta": "}"},
    ]


def test_snapshot_file_builder_order_is_checked_outside_update_mode(tmp_path: Path) -> None:
    compare = SMOKE["compare_snapshot_files"]

    with pytest.raises(AssertionError, match="snapshot builder produced"):
        compare({}, False, tmp_path, ("result.json",))


def test_snapshot_comparison_expands_sdk_wrapped_attempts() -> None:
    normalize = SMOKE["normalize_session_format_comparison"]
    actual = [{
        "method": "session.event",
        "payload": {
            "sessionId": "s",
            "event": {
                "type": "assistant/attempt",
                "seq": 7,
                "time": 0,
                "data": {
                    "turn": 1,
                    "step": 1,
                    "stream": [{"type": "chunk", "time": 0, "chunk": {"type": "finish"}}],
                },
            },
        },
    }]

    assert normalize(actual) == [{
        "method": "session.event",
        "payload": {
            "sessionId": "s",
            "event": {
                "type": "assistant/chunk",
                "data": {"turn": 1, "step": 1, "chunk": {"type": "finish"}},
            },
        },
    }]


def test_snapshot_generation_names_select_highest_role_without_double_counting(
    tmp_path: Path,
) -> None:
    render = SMOKE["snapshot_session_filename"]
    select = SMOKE["selected_snapshot_session_files"]
    assert render(0, 0) == "session.jsonl"
    assert render(0, 2) == "session.v2.jsonl"
    assert render(3, 0) == "session.3.jsonl"
    assert render(3, 2) == "session.3.v2.jsonl"

    (tmp_path / "session.jsonl").write_text(
        '{"type":"session","version":0}\n', encoding="utf-8",
    )
    (tmp_path / "session.v1.jsonl").write_text(
        '{"type":"session","version":1}\n', encoding="utf-8",
    )
    (tmp_path / "session.1.jsonl").write_text(
        '{"type":"session","version":0}\n', encoding="utf-8",
    )

    assert {index: path.name for index, path in select(tmp_path).items()} == {
        0: "session.v1.jsonl",
        1: "session.1.jsonl",
    }


def test_snapshot_comparison_accepts_current_output_against_v2_without_rewriting(tmp_path: Path) -> None:
    predecessor = '{"type":"session","version":2}\n'
    successor = json.dumps({"type": "session", "version": SESSION_FORMAT_VERSION}) + "\n"
    successor_name = f"session.v{SESSION_FORMAT_VERSION}.jsonl"
    old_path = tmp_path / "session.v2.jsonl"
    old_path.write_text(predecessor, encoding="utf-8")
    files = {successor_name: successor}

    SMOKE["compare_snapshot_files"](files, False, tmp_path, ("session.v2.jsonl",))
    assert old_path.read_text(encoding="utf-8") == predecessor
    assert not (tmp_path / successor_name).exists()

    SMOKE["compare_snapshot_files"](files, True, tmp_path, ("session.v2.jsonl",))
    assert old_path.read_text(encoding="utf-8") == predecessor
    assert (tmp_path / successor_name).read_text(encoding="utf-8") == successor
    assert SMOKE["selected_snapshot_session_files"](tmp_path) == {0: tmp_path / successor_name}


def native_delivery_snapshot(version: int) -> dict[str, str]:
    event = {
        "type": "session-log-deepseek/delivery-accepted",
        "data": {"sessionId": "s", "throughSeq": 0, "sessionFormatVersion": version},
    }
    return {
        "result.json": json.dumps({
            "events": [event],
            "notifications": [{"method": "session.event", "payload": {"sessionId": "s", "event": event}}],
        }) + "\n",
        f"session.v{version}.jsonl": SMOKE["render_jsonl"]([
            {"type": "session", "version": version, "id": "s"},
            {"type": "turn/start", "data": {"turn": 1}},
            event,
        ]),
    }


def test_native_writer_comparison_requires_opt_in_and_preserves_written_generations(tmp_path: Path) -> None:
    golden = native_delivery_snapshot(3)
    fresh = native_delivery_snapshot(SESSION_FORMAT_VERSION)
    for name, content in golden.items():
        (tmp_path / name).write_text(content, encoding="utf-8")
    compare = SMOKE["compare_snapshot_files"]
    with pytest.raises(AssertionError, match="executable snapshot mismatch"):
        compare(fresh, False, tmp_path, tuple(golden))
    compare(fresh, False, tmp_path, tuple(golden), native_writer_output=True)
    assert {path.name: path.read_text(encoding="utf-8") for path in tmp_path.iterdir()} == golden
    compare(fresh, True, tmp_path, tuple(golden), native_writer_output=True)
    assert (tmp_path / "session.v3.jsonl").read_text(encoding="utf-8") == golden["session.v3.jsonl"]
    for name, content in fresh.items():
        assert (tmp_path / name).read_text(encoding="utf-8") == content
        assert "{{sourceSessionFormatVersion}}" not in content


@pytest.mark.parametrize("surface", ["session", "events", "notifications"])
def test_native_writer_comparison_rejects_stale_current_delivery(tmp_path: Path, surface: str) -> None:
    golden = native_delivery_snapshot(3)
    fresh = native_delivery_snapshot(SESSION_FORMAT_VERSION)
    for name, content in golden.items():
        (tmp_path / name).write_text(content, encoding="utf-8")
    if surface == "session":
        name = f"session.v{SESSION_FORMAT_VERSION}.jsonl"
        records = [json.loads(line) for line in fresh[name].splitlines()]
        records[-1]["data"]["sessionFormatVersion"] = 3
        fresh[name] = SMOKE["render_jsonl"](records)
    else:
        result = json.loads(fresh["result.json"])
        event = result["events"][0] if surface == "events" else result["notifications"][0]["payload"]["event"]
        event["data"]["sessionFormatVersion"] = 3
        fresh["result.json"] = json.dumps(result) + "\n"
    with pytest.raises(AssertionError, match="executable snapshot mismatch"):
        SMOKE["compare_snapshot_files"](fresh, False, tmp_path, tuple(golden), native_writer_output=True)


def test_native_writer_comparison_preserves_captured_and_nested_delivery_values() -> None:
    delivery = {
        "type": "session-log-deepseek/delivery-accepted",
        "data": {"sessionId": "s", "throughSeq": 0, "sessionFormatVersion": 3},
    }
    captured = {"type": "custom/event", "data": {
        "capturedFormatVersion": 3, "sessionFormatVersion": 3, "nested": delivery,
    }}
    value = {
        "events": [delivery, captured, {**delivery, "data": {**delivery["data"], "sessionFormatVersion": 2}}],
        "notifications": [
            {"method": "session.event", "params": {"event": delivery}},
            {"method": "other.event", "payload": {"event": delivery}},
        ],
    }
    normalized = json.loads(SMOKE["normalize_snapshot_comparison_text"]("result.json", json.dumps(value), 3))
    assert normalized["events"][0]["data"]["sessionFormatVersion"] == "{{sourceSessionFormatVersion}}"
    assert normalized["events"][1] == captured
    assert normalized["events"][2]["data"]["sessionFormatVersion"] == 2
    assert normalized["notifications"][0]["params"]["event"]["data"]["sessionFormatVersion"] == "{{sourceSessionFormatVersion}}"
    assert normalized["notifications"][1] == value["notifications"][1]
    assert SMOKE["normalize_session_format_comparison"](delivery) == delivery


def test_default_comparison_keeps_a_migrated_delivery_generation_exact() -> None:
    source = native_delivery_snapshot(3)["session.v3.jsonl"]
    target_records = [json.loads(line) for line in source.splitlines()]
    target_records[0]["version"] = SESSION_FORMAT_VERSION
    target = SMOKE["render_jsonl"](target_records)
    normalize = SMOKE["normalize_snapshot_comparison_text"]
    assert normalize("session.v3.jsonl", source) == normalize(f"session.v{SESSION_FORMAT_VERSION}.jsonl", target)
    assert '"sessionFormatVersion":3' in normalize(f"session.v{SESSION_FORMAT_VERSION}.jsonl", target)


def test_native_writer_comparison_rejects_mixed_expected_role_generations(tmp_path: Path) -> None:
    golden = {"session.v2.jsonl": 2, "session.1.v3.jsonl": 3}
    fresh = {}
    for index, (name, version) in enumerate(golden.items()):
        (tmp_path / name).write_text(SMOKE["render_jsonl"]([
            {"type": "session", "version": version},
        ]), encoding="utf-8")
        fresh[SMOKE["snapshot_session_filename"](index, SESSION_FORMAT_VERSION)] = SMOKE["render_jsonl"]([
            {"type": "session", "version": SESSION_FORMAT_VERSION},
        ])
    with pytest.raises(AssertionError, match="requires one Session generation across all roles"):
        SMOKE["compare_snapshot_files"](fresh, False, tmp_path, tuple(golden), native_writer_output=True)


@pytest.mark.parametrize("scenario", ["ADVANCED", "RESTART", "RECOVERY"])
def test_committed_python_native_goldens_compare_current_output_without_rewriting(scenario: str) -> None:
    directory = SMOKE[f"{scenario}_SNAPSHOT_DIRECTORY"]
    filenames = SMOKE[f"{scenario}_SNAPSHOT_FILENAMES"]
    before = {path.name: path.read_bytes() for path in directory.iterdir() if path.is_file()}
    selected = SMOKE["selected_snapshot_session_files"](directory)
    if scenario in {"ADVANCED", "RECOVERY"}:
        selected = {index: directory / (
            "writer.expected.jsonl" if index == 0 else f"writer.{index}.expected.jsonl"
        ) for index in selected}
    first = next(iter(selected.values()))
    source_version = SMOKE["session_header_version"](before[first.name].decode("utf-8"), first.name)

    def current_writer(value: object) -> object:
        if isinstance(value, list):
            return [current_writer(item) for item in value]
        if not isinstance(value, dict):
            return value
        result = {key: current_writer(item) for key, item in value.items()}
        if result.get("type") == "session":
            assert result["version"] == source_version
            result["version"] = SESSION_FORMAT_VERSION
        if result.get("type") == "session-log-deepseek/delivery-accepted":
            assert result["data"]["sessionFormatVersion"] == source_version
            result["data"]["sessionFormatVersion"] = SESSION_FORMAT_VERSION
        return result

    fresh = {}
    for name in filenames:
        parsed = SMOKE["parse_snapshot_session_filename"](name)
        source_name = selected[parsed[0]].name if parsed is not None else name
        content = before[source_name].decode("utf-8")
        if parsed is not None:
            fresh[SMOKE["snapshot_session_filename"](parsed[0], SESSION_FORMAT_VERSION)] = SMOKE["render_jsonl"]([
                current_writer(json.loads(line)) for line in content.splitlines() if line
            ])
        else:
            fresh[name] = json.dumps(current_writer(json.loads(content)), indent=2, ensure_ascii=False) + "\n"
    SMOKE["compare_snapshot_files"](
        fresh, False, directory, filenames, native_writer_output=True,
        writer_expected=scenario in {"ADVANCED", "RECOVERY"},
    )
    assert {path.name: path.read_bytes() for path in directory.iterdir() if path.is_file()} == before


def test_writer_oracle_updates_leave_same_generation_recordings_immutable(tmp_path: Path) -> None:
    fresh = native_delivery_snapshot(SESSION_FORMAT_VERSION)
    name = f"session.v{SESSION_FORMAT_VERSION}.jsonl"
    recording = fresh[name].replace('"turn":1', '"turn":2')
    (tmp_path / name).write_text(recording, encoding="utf-8")
    compare = SMOKE["compare_snapshot_files"]
    compare(fresh, True, tmp_path, tuple(fresh), native_writer_output=True, writer_expected=True)
    assert (tmp_path / name).read_text(encoding="utf-8") == recording
    assert (tmp_path / "writer.expected.jsonl").read_text(encoding="utf-8") == fresh[name]
    compare(fresh, False, tmp_path, tuple(fresh), native_writer_output=True, writer_expected=True)
    (tmp_path / "writer.expected.jsonl").unlink()
    with pytest.raises(AssertionError, match="writer oracle inventory"):
        compare(fresh, False, tmp_path, tuple(fresh), native_writer_output=True, writer_expected=True)


@pytest.mark.parametrize("filenames", [
    ("session.1.v2.jsonl", "session.v2.jsonl"),
    ("session.v2.jsonl",),
    ("session.v2.jsonl", "session.2.v2.jsonl"),
])
def test_snapshot_builder_checks_role_order_and_count_across_generations(
    tmp_path: Path, filenames: tuple[str, ...],
) -> None:
    files = {f"session.v{SESSION_FORMAT_VERSION}.jsonl": "", f"session.1.v{SESSION_FORMAT_VERSION}.jsonl": ""}
    with pytest.raises(AssertionError, match="snapshot builder produced"):
        SMOKE["compare_snapshot_files"](files, False, tmp_path, filenames)


def test_snapshot_generation_comparison_rejects_changed_payload(tmp_path: Path) -> None:
    (tmp_path / "session.v2.jsonl").write_text(
        '{"type":"session","version":2,"id":"expected"}\n', encoding="utf-8",
    )
    with pytest.raises(AssertionError, match="executable snapshot mismatch"):
        SMOKE["compare_snapshot_files"](
            {f"session.v{SESSION_FORMAT_VERSION}.jsonl": json.dumps({
                "type": "session", "version": SESSION_FORMAT_VERSION, "id": "changed",
            }) + "\n"},
            False, tmp_path, ("session.v2.jsonl",),
        )


@pytest.mark.parametrize("version", [SESSION_FORMAT_VERSION - 1, SESSION_FORMAT_VERSION + 1])
@pytest.mark.parametrize("update", [False, True])
def test_snapshot_comparison_rejects_noncurrent_writer(
    tmp_path: Path, version: int, update: bool,
) -> None:
    golden = '{"type":"session","version":2}\n'
    (tmp_path / "session.v2.jsonl").write_text(golden, encoding="utf-8")
    content = json.dumps({"type": "session", "version": version}) + "\n"
    with pytest.raises(AssertionError, match=f"expected current Session format v{SESSION_FORMAT_VERSION}"):
        SMOKE["compare_snapshot_files"](
            {f"session.v{version}.jsonl": content}, update, tmp_path, ("session.v2.jsonl",),
        )
    assert (tmp_path / "session.v2.jsonl").read_text(encoding="utf-8") == golden
    assert not (tmp_path / f"session.v{SESSION_FORMAT_VERSION}.jsonl").exists()


@pytest.mark.parametrize("version", [SESSION_FORMAT_VERSION - 1, SESSION_FORMAT_VERSION, SESSION_FORMAT_VERSION + 1])
def test_persisted_session_requires_current_writer(version: int) -> None:
    content = json.dumps({"type": "session", "version": version}) + "\n"
    path = Path(f"session.v{version}.jsonl")
    if version == SESSION_FORMAT_VERSION:
        assert SMOKE["assert_persisted_session_version"](path, content) == version
    else:
        with pytest.raises(AssertionError, match=f"expected current Session format v{SESSION_FORMAT_VERSION}"):
            SMOKE["assert_persisted_session_version"](path, content)


def test_snapshot_generation_filename_must_match_header(tmp_path: Path) -> None:
    (tmp_path / "session.v1.jsonl").write_text(
        '{"type":"session","version":0}\n', encoding="utf-8",
    )

    with pytest.raises(AssertionError, match="filename declares Session format v1"):
        SMOKE["selected_snapshot_session_files"](tmp_path)


@pytest.mark.parametrize("returncode", [1, -1073741819, 3221225477])
def test_profile_plugin_failure_reports_native_exit_status(monkeypatch: pytest.MonkeyPatch, returncode: int) -> None:
    def failed_install(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(args=[], returncode=returncode, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", failed_install)
    with pytest.raises(AssertionError) as error:
        SMOKE["smoke_sdk_profile_plugin"]("http://127.0.0.1:1")
    message = str(error.value)
    assert f"returncode={returncode}" in message
    assert f"0x{returncode & 0xffffffff:08x}" in message
    assert "stdout='' stderr=''" in message


@pytest.mark.parametrize("prefix", ["", "File created with exactly 18 bytes.\n\n"])
def test_live_turn_accepts_explanation_before_final_sentinel(prefix: str) -> None:
    SMOKE["assert_live_turn"]("create", live_result(final_response=prefix + SMOKE["LIVE_API_SENTINEL"]))


@pytest.mark.parametrize("answer", ["", "PYTHON_SDK_LIVE_OK but the operation failed", "PYTHON_SDK_LIVE_OK\nFailure"])
def test_live_turn_rejects_missing_final_sentinel(answer: str) -> None:
    with pytest.raises(AssertionError, match="turn returned"):
        SMOKE["assert_live_turn"]("create", live_result(final_response=answer))
