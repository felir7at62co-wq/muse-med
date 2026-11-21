"""密钥脱敏：报错、任务结果、日志里不出现密钥（全部用假密钥）。"""
from __future__ import annotations

import json
import logging

import pytest

FAKE_ARK = "fixture-ark-key-0123456789abcd"
FAKE_ENV = "fixture-env-secret-9876543210wxyz"


@pytest.fixture()
def secrets(monkeypatch):
    """配置一把假方舟密钥（走 Settings）和一个只在环境变量里的假密钥。"""
    from app import config
    from app.redact import known_secrets
    monkeypatch.setenv("FW_ARK_API_KEY", FAKE_ARK)
    monkeypatch.setenv("VOLC_SECRET_KEY", FAKE_ENV)
    config.get_settings.cache_clear()
    known_secrets.cache_clear()
    yield
    config.get_settings.cache_clear()
    known_secrets.cache_clear()


@pytest.mark.parametrize("raw, leaked", [
    ("upstream 401: Authorization: Bearer abcDEF1234567890xyz", "abcDEF1234567890xyz"),
    ('RH 返回 {"apiKey": "rh-fixture-0011223344", "taskId": "1"}', "rh-fixture-0011223344"),
    ("GET https://api.test/v1/models?key=AIzaFixture123456&alt=json failed", "AIzaFixture123456"),
    ("invalid key sk-fixture0123456789abcdef", "sk-fixture0123456789abcdef"),
    ("signature mismatch X-Tos-Signature=deadbeefcafe0011 for object", "deadbeefcafe0011"),
    ("AccessKeyId AKLTfixture0123456789abcdef rejected", "AKLTfixture0123456789abcdef"),
    ("token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJlMTIz expired", "eyJzdWIiOiIxMjM0"),
])
def test_redact_text_hides_secret_shapes(raw, leaked):
    from app.redact import redact_text
    out = redact_text(raw)
    assert leaked not in out
    assert "[已隐藏]" in out


@pytest.mark.parametrize("plain", [
    "生成失败：上游超时，已退回",
    "max_tokens: 4096 超出上限",
    "task_id=cgt-20261119-abc 排队中",
    "https://cdn.test/a.png",
])
def test_redact_text_keeps_ordinary_text(plain):
    from app.redact import redact_text
    assert redact_text(plain) == plain


def test_configured_secrets_are_hidden_with_tail(secrets):
    from app.redact import redact_text
    out = redact_text(f"方舟拒绝 key={FAKE_ARK}；备用 {FAKE_ENV}")
    assert FAKE_ARK not in out and FAKE_ENV not in out
    assert "…wxyz" in out


def test_human_error_and_upload_message_are_redacted(secrets):
    from app.err_text import human_error, upload_failed_msg

    class _Resp:
        status_code = 401
        reason_phrase = "Unauthorized"
        text = f'{{"error": "bad apiKey={FAKE_ARK}"}}'
        headers = {"x-request-id": "req-1"}

    assert FAKE_ARK not in human_error(RuntimeError(f"HTTP 401 Bearer {FAKE_ARK}"))
    message = upload_failed_msg(_Resp(), "视频")
    assert FAKE_ARK not in message and "req-1" in message


def test_job_error_and_result_are_redacted_on_write(db, secrets):
    from app.db import Job
    signed = "https://tos.test/a.png?X-Tos-Signature=keepme0123456789&X-Tos-Expires=600"
    result = json.dumps({"items": [{"url": signed, "error": "apiKey=rh-fixture-0011223344"}],
                         "note": f"used {FAKE_ARK}"}, ensure_ascii=False)
    with db() as s:
        s.add(Job(id="job-redact-1", kind="shot_video", status="failed",
                  error=f"HTTP 401: Bearer {FAKE_ARK}", result=result))
        s.commit()
    with db() as s:
        job = s.get(Job, "job-redact-1")
        assert FAKE_ARK not in job.error and "[已隐藏密钥 …abcd]" in job.error
        stored = json.loads(job.result)
        assert stored["items"][0]["url"] == signed
        assert "rh-fixture-0011223344" not in stored["items"][0]["error"]
        assert FAKE_ARK not in stored["note"]
        job.error = "第二次失败 token=fixture-second-token-0001"
        s.commit()
    with db() as s:
        assert "fixture-second-token-0001" not in s.get(Job, "job-redact-1").error


def test_job_update_path_redacts(db, secrets):
    from app import jobs
    from app.db import Job
    with db() as s:
        s.add(Job(id="job-redact-2", kind="asset_batch", status="running"))
        s.commit()
    jobs._update("job-redact-2", status="failed", error=f"上游原话：invalid api_key {FAKE_ARK}")
    with db() as s:
        assert FAKE_ARK not in s.get(Job, "job-redact-2").error


def test_shot_fail_reason_is_redacted(db, secrets):
    from conftest import add_shot, make_project
    from app.db import Shot
    pid = make_project(db)
    sid = add_shot(db, pid, 1)
    with db() as s:
        s.get(Shot, sid).fail_reason = f"provider said Authorization: Bearer {FAKE_ARK}"
        s.commit()
    with db() as s:
        assert FAKE_ARK not in s.get(Shot, sid).fail_reason


def test_log_messages_and_tracebacks_are_redacted(secrets, caplog):
    from app.redact import install_log_redaction
    install_log_redaction()
    log = logging.getLogger("jingliu.test.redact")
    with caplog.at_level(logging.INFO, logger="jingliu.test.redact"):
        log.info("calling %s", f"https://api.test/v1?key={FAKE_ARK}")
        try:
            raise RuntimeError(f"401 Bearer {FAKE_ARK}")
        except RuntimeError:
            log.exception("upstream failed")
    assert FAKE_ARK not in caplog.text
    assert "[已隐藏" in caplog.text


def test_http_error_detail_is_redacted(secrets):
    from fastapi import HTTPException
    from fastapi.testclient import TestClient

    from app.main import create_app
    app = create_app()

    def _fails() -> None:
        raise HTTPException(status_code=502, detail=f"LLM 调用失败: RuntimeError('401 Bearer {FAKE_ARK}')")

    def _fails_structured() -> None:
        raise HTTPException(status_code=400, detail={"reason": "upstream", "message": f"apiKey={FAKE_ENV}"})

    app.add_api_route("/__test/fails", _fails)
    app.add_api_route("/__test/fails-structured", _fails_structured)
    client = TestClient(app)
    plain = client.get("/__test/fails")
    assert plain.status_code == 502 and FAKE_ARK not in plain.text and "LLM 调用失败" in plain.text
    structured = client.get("/__test/fails-structured")
    assert structured.status_code == 400 and FAKE_ENV not in structured.text
    assert structured.json()["detail"]["reason"] == "upstream"
    assert client.get("/__test/missing").status_code == 404


def test_agent_tool_results_and_failures_are_redacted(db, secrets):
    from conftest import run, tool_ctx
    from pydantic import BaseModel

    from app.agent.executor import execute_tool
    from app.agent.registry import ToolSpec

    class _NoArgs(BaseModel):
        pass

    async def _returns(_ctx):
        return {"ok": False, "error": f"upstream said apiKey={FAKE_ARK}",
                "url": "https://tos.test/a.png?X-Tos-Signature=keepme0123456789"}

    async def _raises(_ctx):
        raise RuntimeError(f"401 Bearer {FAKE_ENV}")

    def spec(name, fn):
        return ToolSpec(name=name, fn=fn, description="test", args_schema=_NoArgs, risk="read", role="viewer")

    returned = json.loads(run(execute_tool(tool_ctx(), spec("redact_returns", _returns), {})))
    assert FAKE_ARK not in returned["error"]
    assert returned["url"].endswith("X-Tos-Signature=keepme0123456789")
    failed = json.loads(run(execute_tool(tool_ctx(), spec("redact_raises", _raises), {})))
    assert failed["ok"] is False and FAKE_ENV not in failed["error"]
