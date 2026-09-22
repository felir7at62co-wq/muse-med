"""缺陷 1：写请求（POST 认领）绝不自动重试；只读请求照旧重连一次。"""
import http.client
import unittest

import snatch_fixtures  # noqa: F401  导入即把 skill 的 scripts/ 放进 sys.path
from snatcher import httpclient

CLAIM_PATH = "/script/center/pool/claim/859"


class FakeResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body


class FakeConnection:
    """记录成功发出的请求；fail_first=True 时第一次 request 抛连接中断。"""

    def __init__(self, host, port, timeout=None, context=None, *, fail_first=False) -> None:
        self.requests: list[tuple[str, str]] = []
        self.fail_first = fail_first
        self.body = b'{"code":200,"msg":"ok"}'
        self.closed = False

    def request(self, method, path, body=None, headers=None) -> None:
        if self.fail_first:
            self.fail_first = False
            raise http.client.RemoteDisconnected("dropped")
        self.requests.append((method, path))

    def getresponse(self) -> FakeResponse:
        return FakeResponse(self.body)

    def close(self) -> None:
        self.closed = True


class PoolCase(unittest.TestCase):
    def setUp(self) -> None:
        self.connections: list[FakeConnection] = []

        def build(host, port, timeout, context=None):
            connection = FakeConnection(host, port, timeout, context, fail_first=not self.connections)
            self.connections.append(connection)
            return connection

        # 只让第一条连接失效：旧实现会在重试里新建第二条并"成功"。
        self.pool = httpclient.ConnectionPool(
            host="h", port=443, timeout=5.0, connection_factory=build, base_path="/prod-api"
        )

    def healthy_pool(self) -> httpclient.ConnectionPool:
        return httpclient.ConnectionPool(
            host="h",
            port=443,
            timeout=5.0,
            connection_factory=lambda *args: FakeConnection(*args),
            base_path="/prod-api",
        )

    def sent(self) -> list[tuple[str, str]]:
        return [request for connection in self.connections for request in connection.requests]


class WriteRequestsAreNotRetried(PoolCase):
    def test_post_is_never_resent_after_a_connection_error(self):
        with self.assertRaises(httpclient.TransportError):
            self.pool.request("POST", CLAIM_PATH, "tok")
        self.assertEqual(len(self.connections), 1, "POST 失败后不得重建连接重发")
        self.assertEqual(self.sent(), [])

    def test_post_failure_says_the_request_may_have_landed(self):
        with self.assertRaises(httpclient.TransportError) as raised:
            self.pool.request("POST", CLAIM_PATH, "tok")
        self.assertIn("POST", str(raised.exception))
        self.assertIn(CLAIM_PATH, str(raised.exception))
        self.assertIn("未得到确定答复", str(raised.exception))

    def test_post_still_returns_a_parsed_envelope_on_success(self):
        pool = self.healthy_pool()
        self.assertEqual(pool.request("POST", CLAIM_PATH, "tok"), {"code": 200, "msg": "ok"})


class ReadRequestsStillReconnect(PoolCase):
    def test_get_reconnects_once_on_connection_error(self):
        self.assertEqual(self.pool.request("GET", "/getInfo", "tok"), {"code": 200, "msg": "ok"})
        self.assertEqual(len(self.connections), 2)
        self.assertEqual(self.sent(), [("GET", "/prod-api/getInfo")])

    def test_get_raises_after_the_single_retry(self):
        pool = httpclient.ConnectionPool(
            host="h",
            port=443,
            timeout=5.0,
            connection_factory=lambda *a, **k: FakeConnection(*a, **k, fail_first=True),
            base_path="/prod-api",
        )
        with self.assertRaises(httpclient.TransportError):
            pool.request("GET", "/getInfo", "tok")

    def test_non_json_response_is_a_transport_error(self):
        pool = self.healthy_pool()
        pool.get().body = b"<html>single page app</html>"
        with self.assertRaises(httpclient.TransportError):
            pool.request("GET", "/getInfo", "tok")


if __name__ == "__main__":
    unittest.main()
