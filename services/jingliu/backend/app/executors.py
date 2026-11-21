"""两个互不相干的线程池：**快任务**与**长阻塞**分开，别让它们互相排队。

## 为什么要有这个模块

`asyncio.to_thread()` 用的是事件循环的**默认 executor**，上限是
`min(32, cpu_count + 4)`——这台机器 16 核，于是全仓 25 处调用共用一个
**20 槽**的池子。被塞进去的东西耗时差了几个数量级：

    verify_session          每个 /v2 请求都要走         ~1 ms
    _touch_used             每次命中 /media 都要走      ~0.1 ms
    火山人像库 wait_active   首次入库最长              180 s
    storage.fetch/put_file  桶的回填与上传             600 s

这些任务之间**没有任何业务因果关系**，却排队排在一起。后果不是"某个功能慢"，
而是**全站一起慢**：鉴权在中间件里，所以任何请求（包括你只是打开项目库）
都会在那个 20 槽队列里排在 180 秒的火山等待后面。

2026-10-27 实测形态：16:03 avg 18.99s / 16:16 avg 20.56s，而同一时刻
16:13 avg 1.21s、16:18 avg 1.02s——排队是突发性的，取决于有没有人在出片。

## 分池原则

分池的依据**不是"哪个模块"，而是"可能阻塞多久"**：

    LONG_POOL  调用时长由**外部服务**决定，上限是分钟级
               → 火山素材入库、对象存储回填/上传、PIL/ffmpeg 解码

    EPOLL      其余全部（默认 executor）
               → 鉴权、媒体打点、小文件读写

判断标准只有一条：**最坏情况下会不会被网络/磁盘挂住几十秒以上。**
会，就进 LONG_POOL；不会，就留在默认池。这样以后新增调用点时不需要
记住"哪些模块是一伙的"，只需要问一句"它最坏等多久"。

## LONG_POOL 为什么不能太大

它的任务是"占着线程等网络"，加线程等于加并发去打上游。32 个足够覆盖
正常出片（同一批参考图通常十几个角色），又不会把火山/桶打爆。
真正要调，走 `FW_LONG_BLOCKING_THREADS` 环境变量。

⚠️ 不要为了"解决排队"把这个数往大调——那是拿上游配额换本地排队时间，
和并发数铁律（加 KEY / 扩容，而不是降并发）是两件事：这里的池是**本地
线程**，不是上游并发，调大它不会让上游多干活，只会让本地多开线程等。
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import contextvars
import functools
import logging
from typing import Any, TypeVar

log = logging.getLogger(__name__)

T = TypeVar("T")

#: 长阻塞池的线程数。见模块头「LONG_POOL 为什么不能太大」。
DEFAULT_LONG_BLOCKING_THREADS = 32

_LONG_POOL: concurrent.futures.ThreadPoolExecutor | None = None


def get_long_pool() -> concurrent.futures.ThreadPoolExecutor:
    """取（懒建）长阻塞池。线程名带 `fwp-long-` 前缀，py-spy 一眼能认出。"""
    global _LONG_POOL
    if _LONG_POOL is None:
        from .config import get_settings
        n = int(getattr(get_settings(), "long_blocking_threads", 0)
                or DEFAULT_LONG_BLOCKING_THREADS)
        _LONG_POOL = concurrent.futures.ThreadPoolExecutor(
            max_workers=max(4, n), thread_name_prefix="fwp-long")
        log.info("[executors] 长阻塞线程池已建立：%d 线程", max(4, n))
    return _LONG_POOL


async def run_long_blocking(func, /, *args, **kwargs) -> Any:
    """把**会被外部服务挂住几十秒以上**的同步函数丢进长阻塞池。

    用法与 `asyncio.to_thread` 完全一致，只是换了一个池：

        await run_long_blocking(resolve_reference_url, st, public, project_id)

    为什么不能直接用 `loop.run_in_executor(pool, ...)`：那需要自己传
    contextvars（本项目的 access/Principal 靠 contextvar 传递请求上下文），
    漏了就会在子线程里读不到当前用户。这里统一补上，调用方不用记。
    """
    loop = asyncio.get_running_loop()
    ctx = contextvars.copy_context()
    call = functools.partial(ctx.run, func, *args, **kwargs)
    return await loop.run_in_executor(get_long_pool(), call)
