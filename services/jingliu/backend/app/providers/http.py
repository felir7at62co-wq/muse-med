"""共享 httpx 客户端（2026-10-21）。

## 为什么要这个模块

`httpx.AsyncClient(...)` 每次构造都要重新建一套 SSL 上下文、重新读一遍
CA 证书包（本机 certifi 的 cacert.pem 约 281 KB）和连接池。实测在本机单次
构造约 **42 毫秒**，而且这部分是**同步**的 —— 即使 `AsyncClient` 本身是异步的，
构造它并不会让出事件循环。

视频生成是**轮询**驱动的：`video_seedance._query` 每 `poll_interval`（默认 10 秒）
查一次状态，一次任务要查几十次。原来每次查询都 `async with httpx.AsyncClient(...)`，
等于每 10 秒在事件循环上同步烧掉 42 毫秒 —— 一个 `_MAX_QUERY_ERRORS` 周期内
十来个任务并发时，这些同步片段会连成串，其他请求就排在后面。

2026-10-21 14:00 的现场证据：py-spy 在进程栈里抓到主线程持有 GIL 执行
`create_default_context`，调用链是
`_query(video_seedance.py:478) <- submit(:400) <- _run_one(jobs.py:2044)`。

## 用法

按 **base URL** 复用。同一个上游（同 host、同超时、同重定向策略）共享一个客户端；
不同上游超时差异很大（提交 120s、查询 60s、下片 600s），所以分组键里带超时，
不要为了"少建几个"把超时挤成同一个。

    from . import http
    c = http.get(base, timeout=60.0)
    r = await c.get(f"{base}/contents/generations/tasks/{tid}", headers=headers)

**不要 `async with` 它** —— 那是共享对象，退出 with 会把池关掉，别人再用就报
`Cannot reopen a client instance`。用完不用管，进程退出时 `aclose_all()` 统一回收。

连接池上限（`limits`）刻意放宽：视频轮询 + 图像生成会有几十个并发同时在途，
httpx 默认 `max_connections=100` 对我们是够的，这里显式写出来是为了以后调时有据可依。
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

import httpx

log = logging.getLogger(__name__)

#: 共享客户端的连接池参数。并发上限不是限流开关 —— 真要限流应该在业务侧
#: 用信号量做（且遵并发铁律，不许擅自降并发）。这里只是防止连接泄漏把 fd 吃光。
_LIMITS = httpx.Limits(max_connections=200, max_keepalive_connections=50)

_clients: dict[tuple[str, float, bool], httpx.AsyncClient] = {}
_lock = asyncio.Lock()


def get(base: str, *, timeout: float = 60.0,
        follow_redirects: bool = False) -> httpx.AsyncClient:
    """取（或首次创建）对应上游的共享客户端。

    同步函数：首次调用才会真正构造 httpx 客户端。**首次**那一次仍要付
    42 毫秒的构造成本，所以更稳妥的做法是在模块级预热常用上游，或者接受
    "每个上游只慢第一次"。
    """
    key = (base, float(timeout), bool(follow_redirects))
    c = _clients.get(key)
    if c is not None and not c.is_closed:
        return c
    c = httpx.AsyncClient(timeout=timeout, follow_redirects=follow_redirects,
                          limits=_LIMITS)
    _clients[key] = c
    log.debug("[http] 新建共享客户端 base=%s timeout=%s", base, timeout)
    return c


@asynccontextmanager
async def client(base: str, *, timeout: float = 60.0,
                 follow_redirects: bool = False):
    """`async with http.client(base, timeout=...) as c:` —— 共享客户端的**安全**取用方式。

    ## 为什么需要这层（2026-11-11）

    项目里到处是 `async with httpx.AsyncClient(...) as c:`。每构造一次就要重读一遍
    281 KB 的 CA 证书包，实测 **41.5 ms 且是同步的**——即使 `AsyncClient` 本身是
    异步的，构造它并不会让出事件循环。

    出片/生图/TTS 全是**轮询**驱动：一段 TTS = 1 次 create + 60 次 status + 1 次
    outputs = 62 次请求。若每次都新建客户端，单段就要在事件循环上同步烧掉
    **2.6 秒**；1631 段并发就是 70 分钟纯 CPU，全站请求排队。

    ## 为什么不直接用 `get()`

    `get()` 返回的是共享对象，而 `async with` 退出时会 `aclose()` 它 ——
    下一个调用方拿到的是已关闭的客户端，报 `Cannot reopen a client instance`。
    本函数把"进入/退出"包成空操作，所以它和 `async with httpx.AsyncClient(...)`
    **调用形状完全一致，可以逐处机械替换**，但退出时不会关掉共享池。

    ## 分组键里必须带 timeout

    不同上游超时差异很大（提交 120s、查询 60s、下片 600s）。`get()` 用
    (base, timeout, follow_redirects) 做键，超时不同就是不同客户端，不会互相污染。
    """
    yield get(base, timeout=timeout, follow_redirects=follow_redirects)


async def aclose_all() -> None:
    """关停时回收全部共享客户端。在 lifespan 的 finally 里调用。"""
    clients = list(_clients.values())
    _clients.clear()
    for c in clients:
        try:
            await c.aclose()
        except Exception:  # noqa: BLE001 —— 关停期的异常不该冒出去
            log.debug("[http] 关闭客户端失败", exc_info=True)


def stats() -> dict:
    """排查用：当前共享了几个客户端、每个是什么。"""
    return {
        "count": len(_clients),
        "clients": [
            {"base": k[0], "timeout": k[1], "follow_redirects": k[2],
             "closed": c.is_closed}
            for k, c in _clients.items()
        ],
    }
