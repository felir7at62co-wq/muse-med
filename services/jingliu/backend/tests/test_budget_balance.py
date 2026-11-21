"""「我的额度」（`budget.my_balance`，`GET /v2/budget/me`）与智能体工具 `get_my_balance`
带上积分闸门 `FW_BUDGET_ENFORCED` 开没开（`enforced`）。

闸门关着时不扣也不拦，余额 0 不等于停下。
"""
from __future__ import annotations

import json

import pytest

from conftest import PID, run

UID = 7


@pytest.fixture()
def balances(db, tools, monkeypatch):
    """以一个没有积分账户的登录用户身份读 `budget.my_balance()` 与 `get_my_balance`；参数是 `FW_BUDGET_ENFORCED` 的值。"""
    from app import access, budget, config
    from app.agent import registry
    from app.agent.executor import ToolCtx, execute_tool

    def read(enforced: str) -> tuple[dict, dict]:
        monkeypatch.setenv("FW_BUDGET_ENFORCED", enforced)
        config.get_settings.cache_clear()
        access.set_current_user({"id": UID, "username": f"u{UID}", "role": "user"})
        try:
            mine = budget.my_balance()
        finally:
            access.set_current_user(None)
        ctx = ToolCtx(run_id="test-run", project_id=PID, user_id=UID, role="viewer")
        tool = json.loads(run(execute_tool(ctx, registry.get_spec("get_my_balance"), {}, call_id="c1")))
        return mine, tool

    yield read
    config.get_settings.cache_clear()


def test_balance_reports_whether_the_credit_gate_is_on(balances):
    off, tool_off = balances("false")
    assert (off["enforced"], off["unlimited"], off["available_fen"]) == (False, False, 0)
    assert (tool_off["ok"], tool_off["enforced"], tool_off["available_fen"]) == (True, False, 0)
    on, tool_on = balances("true")
    assert (on["enforced"], on["unlimited"], on["available_fen"]) == (True, False, 0)
    assert (tool_on["enforced"], tool_on["available_fen"]) == (True, 0)


def test_both_read_the_gate_that_charging_uses(balances, monkeypatch):
    from app import charge
    monkeypatch.setattr(charge, "_budget_on", lambda: False)
    mine, tool = balances("true")
    assert (mine["enforced"], tool["enforced"]) == (False, False)
