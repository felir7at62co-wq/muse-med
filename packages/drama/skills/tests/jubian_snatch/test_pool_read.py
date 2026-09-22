"""缺陷 5（分页读全）、缺陷 6（诊断不绕过 canClaim）、缺陷 7（认领结论以回读为准）。"""
import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import snatch_fixtures  # noqa: F401  导入即把 skill 的 scripts/ 放进 sys.path
import check_pool_live
from snatch_fixtures import FakePool, paged_rows, row, snatch_routes
from snatcher import api, config

PACKAGE = Path(__file__).resolve().parents[2]


def pool_route(rows, **kwargs):
    """只读核对用的固定池子：带不带 status 的读都看到同一批行。"""
    return snatch_routes(poll_rows=rows, full_rows=list(rows), **kwargs)


class PoolPaging(unittest.TestCase):
    """缺陷 5：只读第一页不等于读完了池子。"""

    def test_reads_every_page_and_reports_the_total(self):
        rows = [row(i) for i in range(1, 451)]
        pool = FakePool({"/script/center/pool/list": paged_rows(rows)})
        read = api.read_pool(pool, "tok", page_size=300)
        self.assertEqual(len(read.rows), 450)
        self.assertEqual(read.total, 450)
        self.assertTrue(read.complete)
        self.assertEqual(read.pages, 2)
        self.assertIn("pageNum=2", pool.pool_requests()[1])

    def test_single_page_pool_costs_one_request(self):
        pool = FakePool({"/script/center/pool/list": paged_rows([row(i) for i in range(1, 11)])})
        read = api.read_pool(pool, "tok")
        self.assertEqual(len(read.rows), 10)
        self.assertTrue(read.complete)
        self.assertEqual(read.pages, 1)

    def test_truncated_read_reports_itself_incomplete_instead_of_lying(self):
        rows = [row(i) for i in range(1, 40001)]
        pool = FakePool({"/script/center/pool/list": paged_rows(rows)})
        read = api.read_pool(pool, "tok", page_size=300, max_pages=3)
        self.assertEqual(read.pages, 3)
        self.assertEqual(len(read.rows), 900)
        self.assertFalse(read.complete, "没读完必须如实报告")

    def test_error_envelope_is_not_an_empty_pool(self):
        pool = FakePool({"/script/center/pool/list": {"code": 401, "msg": "认证失败"}})
        with self.assertRaises(api.ApiError):
            api.read_pool(pool, "tok")

    def test_empty_page_with_a_larger_total_is_not_complete(self):
        pool = FakePool(
            {"/script/center/pool/list": lambda path: {"code": 200, "total": 100, "rows": []}}
        )
        read = api.read_pool(pool, "tok", max_pages=2)
        self.assertEqual(read.rows, ())
        self.assertFalse(read.complete, "服务端报了 100 本却给了空页，不能宣布读完了")

    def test_pool_without_total_ends_on_a_short_page(self):
        pool = FakePool(
            {"/script/center/pool/list": lambda path: {"code": 200, "rows": [row(1), row(2)]}}
        )
        read = api.read_pool(pool, "tok", page_size=300)
        self.assertEqual(len(read.rows), 2)
        self.assertTrue(read.complete)

    def test_repeated_rows_in_one_page_are_collapsed_by_id(self):
        rows = [row(1), row(2), row(1)]
        pool = FakePool({"/script/center/pool/list": lambda path: {"code": 200, "total": 3, "rows": rows}})
        read = api.read_pool(pool, "tok", page_size=300)
        self.assertEqual([item["id"] for item in read.rows], [1, 2])


class DiagnosticGate(unittest.TestCase):
    """缺陷 6：诊断脚本不得绕过 canClaim（也不得绕过账本）。"""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(dir=PACKAGE / "tests")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ledger = self.root / "claims.ndjson"
        self.env = patch.dict(
            os.environ,
            {"JUBIAN_TOKEN": "offline-fixture-token", "HOME": str(self.root), "USERPROFILE": str(self.root)},
        )
        self.env.start()
        self.addCleanup(self.env.stop)

    def run_check(self, pool, *extra) -> tuple[int, str]:
        argv = ["--ledger", str(self.ledger), *extra]
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = check_pool_live.main(argv, pool=pool)
        return code, output.getvalue()

    def test_not_claimable_row_is_refused_without_any_write(self):
        pool = FakePool(pool_route([row(859, 0)]))
        code, output = self.run_check(pool, "--claim", "859")
        self.assertEqual(code, 1)
        self.assertEqual(pool.writes(), [], "canClaim 不是可领时一个请求都不许发")
        self.assertIn("不是可领", output)

    def test_unknown_id_is_refused(self):
        pool = FakePool(pool_route([row(1, 1)]))
        code, _ = self.run_check(pool, "--claim", "859")
        self.assertEqual(code, 1)
        self.assertEqual(pool.writes(), [])

    def test_incomplete_pool_read_refuses_the_claim_and_says_so(self):
        rows = [row(i, 1) for i in range(1, 40001)]
        routes = pool_route(rows)
        routes["/script/center/pool/list"] = paged_rows(rows)
        pool = FakePool(routes)
        code, output = self.run_check(pool, "--claim", "1")
        self.assertEqual(code, 1)
        self.assertEqual(pool.writes(), [])
        self.assertIn("没读完", output)

    def test_claimable_id_goes_through_the_ledger_exactly_once(self):
        pool = FakePool(pool_route([row(859, 1)]))
        code, output = self.run_check(pool, "--claim", "859")
        self.assertEqual(code, 0)
        self.assertEqual(pool.writes(), ["/script/center/pool/claim/859"])
        self.assertIn("state=accepted", output)
        # 第二次：账本已有 accepted，同一个 id 不再发第二次写请求。
        code, output = self.run_check(pool, "--claim", "859")
        self.assertEqual(code, 0)
        self.assertEqual(pool.writes(), ["/script/center/pool/claim/859"])
        self.assertIn("replayed=True", output)

    def test_read_only_run_never_writes(self):
        pool = FakePool(pool_route([row(859, 1)]))
        code, output = self.run_check(pool)
        self.assertEqual(code, 0)
        self.assertEqual(pool.writes(), [])
        self.assertIn("canClaim", output)


class OwnershipEvidence(unittest.TestCase):
    """缺陷 7：只有回读到"这本写在我们名下"才算认领成功。"""

    def test_vanished_row_is_not_evidence(self):
        self.assertIs(api.classify_ownership(None, "杨礼楷"), api.Ownership.UNCONFIRMED)

    def test_row_naming_us_is_held(self):
        row_ = row(859, 0, status="pending_distribute", claimLeaderName="杨礼楷")
        self.assertIs(api.classify_ownership(row_, "杨礼楷"), api.Ownership.HELD)

    def test_member_hold_is_held(self):
        row_ = row(859, 0, status="claimed", claimMemberName="杨礼楷")
        self.assertIs(api.classify_ownership(row_, "杨礼楷"), api.Ownership.HELD)

    def test_returned_row_is_lost(self):
        row_ = row(859, 0, status="returned", claimLeaderName=None, sendbackCount=2)
        self.assertIs(api.classify_ownership(row_, "杨礼楷"), api.Ownership.LOST)

    def test_row_back_in_the_claimable_pool_is_lost(self):
        self.assertIs(api.classify_ownership(row(859, 1), "杨礼楷"), api.Ownership.LOST)

    def test_row_held_by_someone_else_never_confirms(self):
        row_ = row(859, 0, status="in_production", claimLeaderName="别人")
        self.assertIs(api.classify_ownership(row_, "杨礼楷"), api.Ownership.UNCONFIRMED)

    def test_unknown_actor_name_never_confirms(self):
        self.assertIs(api.classify_ownership(row(859, 1), ""), api.Ownership.UNCONFIRMED)


class CandidatePredicate(unittest.TestCase):
    """canClaim 是唯一判据，且只认明确的三种写法。"""

    def test_accepts_only_explicit_truthy_literals(self):
        for value in (1, True, "1"):
            with self.subTest(value=value):
                self.assertTrue(api.is_claimable({"canClaim": value}))
        for value in (0, False, "0", "true", "yes", None, 2, " 1 "):
            with self.subTest(value=value):
                self.assertFalse(api.is_claimable({"canClaim": value}))

    def test_empty_value_is_not_claimable(self):
        self.assertFalse(api.is_claimable({}))

    def test_status_names_are_not_a_predicate(self):
        self.assertTrue(api.is_claimable(row(1, 1, status="pending_distribute")))
        self.assertFalse(api.is_claimable(row(1, 0, status="pending_leader_claim")))


class StatusVocabulary(unittest.TestCase):
    """缺陷 4：状态名只有一处来源，且两种组长写法都被覆盖。"""

    def test_config_carries_both_leader_spellings(self):
        self.assertEqual(
            set(config.CLAIMABLE_STATUSES),
            {"pending_leader_claim", "pending_lead_claim", "pending_member_claim"},
        )


if __name__ == "__main__":
    unittest.main()
