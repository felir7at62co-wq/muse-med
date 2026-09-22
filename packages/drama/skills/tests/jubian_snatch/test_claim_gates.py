"""缺陷 2（基线读不成就停）、缺陷 3（成功/未知不得重复认领）、
缺陷 4（状态名一处来源）、缺陷 7（批处理以回读到的归属作结论）。

批处理测试真的把 snatch_batch 的轮询循环跑起来（一秒真实时间），但连接池是假的，
所以一个真实请求都不会发出去。
"""
import contextlib
import io
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import snatch_fixtures  # noqa: F401  导入即把 skill 的 scripts/ 放进 sys.path
import snatch_batch
from snatch_fixtures import FakePool, RealtimeClock, row, snatch_routes
from snatcher import config
from snatcher.claimer import Claimer
from snatcher.httpclient import TransportError
from snatcher.ledger import ClaimLedger, ClaimState, LedgerFormatError, claim_key

PACKAGE = Path(__file__).resolve().parents[2]
TARGET = row(859, 1, name="婆家吃绝户后悔疯了")


class FakeClient:
    """按调用次序应答的假客户端；异常实例直接抛出。"""

    def __init__(self, replies) -> None:
        self.replies = list(replies)
        self.calls: list[tuple[int, bool | None]] = []

    def claim(self, script_id, *, member=None):
        self.calls.append((script_id, member))
        reply = self.replies[min(len(self.calls), len(self.replies)) - 1]
        if isinstance(reply, BaseException):
            raise reply
        return reply


class LedgerCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=PACKAGE / "tests")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "claims.ndjson"

    def claimer(self, client, ledger=None) -> Claimer:
        return Claimer(client, ledger or ClaimLedger(self.path), concurrency=1)


class ClaimLedgerGates(LedgerCase):
    """缺陷 3：只有服务端明确说"没有发生"才允许重发。"""

    def test_accepted_claim_is_never_resubmitted(self):
        first = FakeClient([{"code": 200, "msg": "认领成功"}])
        self.assertIs(self.claimer(first).claim_one(TARGET).state, ClaimState.ACCEPTED)
        self.assertEqual(first.calls, [(859, None)])

        second = FakeClient([{"code": 200, "msg": "认领成功"}])
        replayed = self.claimer(second).claim_one(TARGET)
        self.assertTrue(replayed.replayed)
        self.assertIs(replayed.state, ClaimState.ACCEPTED)
        self.assertEqual(second.calls, [], "已到手的本不得再发一次认领")

    def test_unknown_result_blocks_resubmission(self):
        failing = FakeClient([TransportError("read timeout")])
        unknown = self.claimer(failing).claim_one(TARGET)
        self.assertIs(unknown.state, ClaimState.UNKNOWN)
        self.assertEqual(failing.calls, [(859, None)])

        healthy = FakeClient([{"code": 200, "msg": "认领成功"}])
        replayed = self.claimer(healthy).claim_one(TARGET)
        self.assertTrue(replayed.replayed)
        self.assertIs(replayed.state, ClaimState.UNKNOWN)
        self.assertEqual(healthy.calls, [], "结果未知的请求可能已经生效，不得盲目重发")

    def test_intent_without_settle_survives_a_restart(self):
        ClaimLedger(self.path).begin(claim_key(859), detail="进程在请求途中被杀")
        client = FakeClient([{"code": 200, "msg": "认领成功"}])
        replayed = Claimer(client, ClaimLedger(self.path), concurrency=1).claim_one(TARGET)
        self.assertTrue(replayed.replayed)
        self.assertEqual(client.calls, [])

    def test_rejected_claim_is_retryable(self):
        busy = FakeClient([{"code": 500, "msg": "系统繁忙"}])
        self.assertIs(self.claimer(busy).claim_one(TARGET).state, ClaimState.REJECTED)

        healthy = FakeClient([{"code": 200, "msg": "操作成功"}])
        result = self.claimer(healthy).claim_one(TARGET)
        self.assertIs(result.state, ClaimState.ACCEPTED)
        self.assertEqual(healthy.calls, [(859, None)], "服务端明确答复未发生，允许重试")

    def test_ledger_records_both_phases(self):
        self.claimer(FakeClient([{"code": 200, "msg": "认领成功"}])).claim_one(TARGET)
        lines = self.path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn("begin", lines[0])
        self.assertIn("accepted", lines[1])

    def test_corrupt_ledger_refuses_to_send(self):
        self.path.write_text('{"phase": "begin", "key": "claim/859"}\n不是 JSON\n', encoding="utf-8")
        client = FakeClient([{"code": 200, "msg": "认领成功"}])
        with self.assertRaises(LedgerFormatError):
            self.claimer(client).claim_one(TARGET)
        self.assertEqual(client.calls, [], "账本读不懂时一个请求都不许发")

    def test_non_claimable_row_is_refused_without_request(self):
        client = FakeClient([{"code": 200, "msg": "认领成功"}])
        result = self.claimer(client).claim_one(row(859, 0))
        self.assertIs(result.state, ClaimState.REJECTED)
        self.assertEqual(client.calls, [])

    def test_leader_rejection_falls_back_to_the_member_path(self):
        client = FakeClient(
            [{"code": 401, "msg": "只有制作组员可以认领"}, {"code": 200, "msg": "认领成功"}]
        )
        result = self.claimer(client).claim_one(TARGET)
        self.assertIs(result.state, ClaimState.ACCEPTED)
        self.assertEqual(client.calls, [(859, None), (859, True)])
        self.assertIs(self.claimer(client).claim_one(TARGET).state, ClaimState.ACCEPTED)
        self.assertEqual(len(client.calls), 2, "成功后不得再回退重试")


class BatchRun(LedgerCase):
    """批处理：假的连接池 + 真实的轮询循环。"""

    def setUp(self) -> None:
        super().setUp()
        self.runs = 0
        self.env = patch.dict(
            os.environ,
            {"JUBIAN_TOKEN": "offline-fixture-token", "HOME": str(self.temp.name),
             "USERPROFILE": str(self.temp.name)},
        )
        self.env.start()
        self.addCleanup(self.env.stop)

    def run_batch(self, pool, *extra, seconds: int = 1, ledger: Path | None = None):
        self.runs += 1
        log_path = Path(self.temp.name) / f"run-{self.runs}.log"
        argv = [
            "--start", "00:00:00", "--burst", "00:00:00", "--end", f"00:00:0{seconds}",
            "--log", str(log_path), "--ledger", str(ledger or self.path), *extra,
        ]
        with patch.object(snatch_batch, "VERIFY_AFTER_SEC", 0.1), contextlib.redirect_stdout(io.StringIO()):
            code = snatch_batch.main(argv, pool=pool, clock=RealtimeClock(), sleep=time.sleep)
        return code, log_path.read_text(encoding="utf-8")


class BaselineIsMandatory(BatchRun):
    """缺陷 2：基线读不成就必须失败退出，绝不退化成"全部可抢"。"""

    def test_transport_failure_on_the_baseline_refuses_to_start(self):
        pool = FakePool(snatch_routes(poll_rows=[TARGET]))
        pool.routes["/script/center/pool/list"] = TransportError("connection reset")
        code, log = self.run_batch(pool)
        self.assertEqual(code, 2)
        self.assertEqual(pool.writes(), [], "基线不可用时不许发任何认领")
        self.assertIn("基线不可用，拒绝启动", log)

    def test_error_envelope_on_the_baseline_refuses_to_start(self):
        pool = FakePool(snatch_routes(poll_rows=[TARGET]))
        pool.routes["/script/center/pool/list"] = {"code": 401, "msg": "认证失败"}
        code, log = self.run_batch(pool)
        self.assertEqual(code, 2)
        self.assertEqual(pool.writes(), [])
        self.assertIn("基线不可用，拒绝启动", log)

    def test_incomplete_baseline_refuses_to_start(self):
        page = [row(i, 0) for i in range(1, 301)]
        pool = FakePool(snatch_routes(poll_rows=[TARGET]))
        pool.routes["/script/center/pool/list"] = lambda path: {
            "code": 200, "total": 40000, "rows": page,
        }
        code, log = self.run_batch(pool)
        self.assertEqual(code, 2)
        self.assertEqual(pool.writes(), [])
        self.assertIn("基线不可用，拒绝启动", log)

    def test_rejected_token_refuses_to_start(self):
        pool = FakePool(snatch_routes(poll_rows=[TARGET]))
        pool.routes["/getInfo"] = {"code": 401, "msg": "认证失败"}
        code, log = self.run_batch(pool)
        self.assertEqual(code, 2)
        self.assertEqual(pool.writes(), [])
        self.assertIn("token 被服务端拒绝", log)


class ClaimThroughTheLoop(BatchRun):
    """缺陷 3 + 4 + 7：真正走一遍 轮询 → 认领 → 回读 的路径。"""

    def routes(self, verify_rows=None, **kwargs):
        return snatch_routes(
            baseline_rows=[],
            poll_rows=[TARGET],
            verify_rows=(
                [row(859, 0, status="pending_distribute", claimLeaderName="杨礼楷")]
                if verify_rows is None else verify_rows
            ),
            **kwargs,
        )

    def test_accepted_claim_is_not_resubmitted_on_the_next_run(self):
        first = FakePool(self.routes(claim_reply={"code": 200, "msg": "认领成功"}))
        code, log = self.run_batch(first)
        self.assertEqual(code, 0)
        self.assertEqual(first.writes(), ["/script/center/pool/claim/859"])
        self.assertIn("服务端确认认领 1 本 ids=[859]", log)
        self.assertIn("归属=held", log)
        self.assertIn("回读确认归属 1 本 ids=[859]", log)

        second = FakePool(self.routes(claim_reply={"code": 200, "msg": "认领成功"}))
        code, log = self.run_batch(second)
        self.assertEqual(code, 0)
        self.assertEqual(second.writes(), [], "第二次运行不得重发同一个 id")
        self.assertIn("跳过 id=859", log)

    def test_unknown_claim_is_not_resubmitted_on_the_next_run(self):
        first = FakePool(self.routes(claim_reply=TransportError("read timeout")))
        code, log = self.run_batch(first)
        self.assertEqual(code, 0)
        self.assertEqual(first.writes(), ["/script/center/pool/claim/859"])
        self.assertIn("认领结果未知", log)
        self.assertIn("结果未知 1 本 ids=[859]", log)

        second = FakePool(self.routes(claim_reply={"code": 200, "msg": "认领成功"}))
        self.run_batch(second)
        self.assertEqual(second.writes(), [], "结果未知的本在查清之前不得重发")

    def test_verification_reports_absence_as_unconfirmed_evidence(self):
        pool = FakePool(self.routes(verify_rows=[]))
        code, log = self.run_batch(pool)
        self.assertEqual(code, 0)
        self.assertIn("归属=unconfirmed", log)
        self.assertIn("从池中消失**不是**认领成功的证据", log)
        self.assertIn("回读确认归属 0 本", log)
        self.assertNotIn("回读确认归属 1 本", log)

    def test_dry_run_sends_nothing(self):
        pool = FakePool(self.routes())
        code, log = self.run_batch(pool, "--dry-run")
        self.assertEqual(code, 0)
        self.assertEqual(pool.writes(), [])
        self.assertIn("演练命中", log)

    def test_preexisting_rows_are_left_alone(self):
        pool = FakePool(
            snatch_routes(
                baseline_rows=[row(700, 1, name="开局就摆在那里的旧本")],
                poll_rows=[row(700, 1, name="开局就摆在那里的旧本"), TARGET],
            )
        )
        code, _ = self.run_batch(pool)
        self.assertEqual(code, 0)
        self.assertEqual(pool.writes(), ["/script/center/pool/claim/859"])

    def test_polled_status_names_come_from_the_single_source(self):
        pool = FakePool(self.routes())
        self.run_batch(pool)
        polled = {
            part.split("=", 1)[1]
            for path in pool.pool_requests()
            for part in path.split("?", 1)[1].split("&")
            if part.startswith("status=")
        }
        self.assertTrue(polled, "循环里必须真的按状态轮询")
        self.assertEqual(polled, set(config.CLAIMABLE_STATUSES))
        self.assertFalse(hasattr(snatch_batch, "POLL_STATUSES"),
                         "状态名只允许有 config.CLAIMABLE_STATUSES 一处")


if __name__ == "__main__":
    unittest.main()
