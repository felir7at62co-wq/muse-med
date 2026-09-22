"""jubian-snatch 离线回归测试的公共假件：脚本化连接池与假时钟。

全部离线：FakePool 直接实现 ConnectionPool 的 request 接口，任何没有被显式路由的
请求都判为测试缺陷（抛 AssertionError），因此测试不可能悄悄打真实网络。
"""
from __future__ import annotations

import datetime as dt
import sys
import time
import urllib.parse
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[2]
SCRIPTS = PACKAGE / "skills" / "jubian-snatch" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

_UNROUTED = AssertionError("FakePool 没有为这个请求配置路由")


def query_of(path: str) -> dict[str, list[str]]:
    return urllib.parse.parse_qs(urllib.parse.urlparse(path).query)


class FakePool:
    """按路径前缀应答的假连接池：记录每一个请求。

    routes 的值可以是 envelope 字典、异常实例，或接受 path 返回 envelope 的可调用对象。
    没有命中的请求直接失败，避免测试在没有预期的情况下"成功"。
    """

    def __init__(self, routes, *, default=_UNROUTED):
        self.routes = dict(routes)
        self.default = default
        self.requests: list[tuple[str, str]] = []
        self.closed = False

    def request(self, method: str, path: str, token: str):
        self.requests.append((method, path))
        for prefix, reply in self.routes.items():
            if path.startswith(prefix):
                return self._resolve(reply, path)
        return self._resolve(self.default, path)

    @staticmethod
    def _resolve(reply, path: str):
        if isinstance(reply, BaseException):
            raise reply
        if callable(reply):
            return reply(path)
        return reply

    def writes(self) -> list[str]:
        return [path for method, path in self.requests if method == "POST"]

    def pool_requests(self) -> list[str]:
        return [path for method, path in self.requests if "/pool/list" in path]

    def close_all(self) -> None:
        self.closed = True


def identity_envelope(name: str = "杨礼楷", code: int = 200) -> dict:
    if code != 200:
        return {"code": code, "msg": "认证失败"}
    return {
        "code": 200,
        "user": {"userId": 7, "userName": name, "dept": {"deptName": "制作组"}},
        "permissions": ["script:pool:claim"],
    }


def row(script_id: int, can_claim=1, *, status: str = "pending_leader_claim", name: str = "剧", **extra):
    return {"id": script_id, "scriptName": name, "status": status, "canClaim": can_claim, **extra}


def paged_rows(rows, *, status: str | None = None) -> callable:
    """按请求里的 pageNum/pageSize 切片的假服务端；响应带 total。"""

    def respond(path: str) -> dict:
        params = query_of(path)
        page = int(params.get("pageNum", ["1"])[0])
        size = int(params.get("pageSize", ["300"])[0])
        selected = [r for r in rows if status is None or r.get("status") == status]
        start = (page - 1) * size
        return {"code": 200, "total": len(selected), "rows": selected[start:start + size]}

    return respond


def snatch_routes(
    *,
    name: str = "杨礼楷",
    baseline_rows=(),
    poll_rows=(),
    verify_rows=(),
    full_rows=None,
    claim_reply: dict | None = None,
    member_reply: dict | None = None,
):
    """一个 snatch_batch 运行会用到的全部路由。

    不带 status 的 /pool/list 请求按调用次序应答：第 1 次是启动基线，之后是认领复核。
    只需要一个固定池子（例如 check_pool_live 的只读核对）时传 full_rows。
    """
    state = {"unfiltered": 0}

    def pool_list(path: str) -> dict:
        params = query_of(path)
        if "status" in params:
            selected = [r for r in poll_rows if r.get("status") == params["status"][0]]
            return {"code": 200, "total": len(selected), "rows": selected}
        if full_rows is not None:
            return {"code": 200, "total": len(full_rows), "rows": list(full_rows)}
        state["unfiltered"] += 1
        rows = baseline_rows if state["unfiltered"] == 1 else verify_rows
        return {"code": 200, "total": len(rows), "rows": list(rows)}

    return {
        "/getInfo": identity_envelope(name),
        "/script/center/pool/viewRole": {"code": 200, "data": "prodlead"},
        "/script/center/pool/statusCount": {"code": 200, "data": {"total": len(poll_rows)}},
        "/aigc/script/list": {"code": 200, "total": 3, "rows": []},
        "/script/center/pool/list": pool_list,
        "/script/center/pool/claim/": claim_reply or {"code": 200, "msg": "认领成功"},
        "/script/center/pool/memberClaim/": member_reply or {"code": 200, "msg": "认领成功"},
    }


class RealtimeClock:
    """把真实流逝时间映射到"今天 00:00 起"的假时钟。

    循环真的按秒跑，认领线程真的有完成时间；`--end 00:00:02` 就是两秒后收工。
    基准日每次调用重新取，跨零点最多提前收工，不会把循环拖成 24 小时。
    """

    def __init__(self) -> None:
        self._origin = time.monotonic()

    def __call__(self) -> float:
        midnight = dt.datetime.combine(dt.date.today(), dt.time(0, 0)).timestamp()
        return midnight + (time.monotonic() - self._origin)
