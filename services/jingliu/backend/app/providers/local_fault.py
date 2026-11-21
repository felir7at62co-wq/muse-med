"""本地资源错误识别 —— 用于把"我们自己的机器出问题了"和"上游渠道挂了"分开。

## 为什么要有这个模块（2026-10-19 事故）

10:25 织影生产后端（8003）撞上 systemd 默认的 fd 软限制 1024，进程内
`accept()` 与 SQLite 打开文件同时失败，日志是：

    ConnectError: [Errno 24] Too many open files
    sqlite3.OperationalError: unable to open database file

而 `providers/image.py` 与 `providers/llm.py` 把**所有** httpx 异常一律包装成
`ChannelDown`，于是这条本地错误被当成"渠道不可用"，`_mark_down()` 把
zx1 / kege / modelverse **全部**写进 120 秒冷却表。后果：

    fd 在 10:26 就已经随连接关闭恢复了，
    但请求一直撞冷却表，直到 10:45 才缓过来 —— 一次几秒的本地资源问题
    被放大成了 20 分钟的全渠道不可用。

## 判据

只有两类算"本地问题"：

1. **本地资源耗尽**：`EMFILE(24)` / `ENFILE(23)` / `ENOMEM(12)` / `EAGAIN(11)`。
   注意 `OSError.errno` 可能藏在 `__cause__` 里（httpx 会把底层 OSError 包一层），
   所以要顺着异常链找。
2. **目标是本机回环**：连接 127.0.0.1 / localhost 失败，说明是本机服务的问题
   （fd 耗尽、端口没起、进程正在重启），**不是**远端渠道的问题。

⚠️ 这里刻意**不**把 `TimeoutException` 算进来：远端超时是真实的渠道信号，
仍应触发冷却。只有"本地"才豁免。
"""

from __future__ import annotations

import errno
from typing import Final

import httpx

#: 本地资源类 errno。命中任意一个即视为"本机出问题"。
_LOCAL_ERRNOS: Final[frozenset[int]] = frozenset({
    errno.EMFILE,   # 24 进程 fd 用尽
    errno.ENFILE,   # 23 系统 fd 用尽
    errno.ENOMEM,   # 12 内存不足
    errno.EAGAIN,   # 11 临时资源不可用
})

#: 视为"本机"的主机名。
_LOCAL_HOSTS: Final[frozenset[str]] = frozenset({
    "127.0.0.1", "localhost", "::1", "0.0.0.0",
})


def _iter_causes(exc: BaseException):
    """顺着 __cause__ / __context__ 走一遍异常链（带环保护）。"""
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        yield cur
        nxt = cur.__cause__ or cur.__context__
        cur = nxt if isinstance(nxt, BaseException) else None


def is_local_resource_error(exc: BaseException) -> bool:
    """这条异常是不是"本机出问题了"（不该算渠道故障）。

    True  => 调用方应当**立刻失败并告警**，但**不要**写渠道冷却表。
    False => 按原有渠道故障逻辑处理。
    """
    for e in _iter_causes(exc):
        # 1) 本地资源耗尽
        code = getattr(e, "errno", None)
        if isinstance(code, int) and code in _LOCAL_ERRNOS:
            return True

        # 2) 目标是本机回环（只对连接类异常判断）
        if isinstance(e, httpx.ConnectError):
            req = getattr(e, "request", None)
            url = getattr(req, "url", None)
            host = getattr(url, "host", None)
            if isinstance(host, str) and host.lower() in _LOCAL_HOSTS:
                return True
    return False


class LocalResourceError(RuntimeError):
    """本机资源不足（fd / 内存 / 回环连接失败）。

    刻意**不**继承 `ChannelDown`：这样各处的
    `except ChannelDown:` 分支不会把它写进冷却表，
    它会一路冒泡到用户面前，同时在日志里留下 ERROR。
    """

    def __init__(self, message: str, *, original: BaseException | None = None):
        super().__init__(message)
        self.original = original


def fd_usage() -> str:
    """一行 fd 用量摘要，供告警日志使用。读不到就返回 unknown，绝不抛。"""
    try:  # pragma: no cover - 纯诊断用途
        import os
        soft, hard = 0, 0
        with open("/proc/self/limits", "r", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("Max open files"):
                    parts = line.split()
                    # 形如: Max open files  65535  65535  files
                    soft, hard = int(parts[3]), int(parts[4])
                    break
        used = len(os.listdir("/proc/self/fd"))
        return f"fd {used}/{soft} (hard {hard})"
    except Exception:  # noqa: BLE001
        return "fd n/a"
