"""P0 观测：找出「谁把 SQLite 写锁占住了」。

## 为什么需要这个模块

2026-11-03 的生产观测（见 `docs/PLAN-多核利用与卡顿根治-2026-11-03.md`）：

```
17:02-17:04 冻结窗口
  GET /fwp/media/...   正常 0.00s 的 307 重定向，冻结期 p50 = 44 秒、max = 80 秒
  写请求                 p50 = 30 秒、max = 155 秒
```

`/fwp/media` 那条路径的全部数据库动作只有**一条**
`UPDATE media_objects SET last_used_at=? WHERE rel_path=?`。一个 1 毫秒的单行更新
排队 44 秒，只可能是 **SQLite 的写锁被别的连接长期占住**（WAL 允许"多读 + 单写"，
写者互斥；等锁的都在 `busy_timeout=30s` 里睡）。

副本上已复现该机制：一个线程 `BEGIN IMMEDIATE` 持锁 3.5 秒，40 个并发
`_touch_used` 全部在锁释放那一刻一起完成（p50 = 3.63 秒）——
这正是线上"同时卡住、同时解锁"的签名。

**但元凶是谁，现在不知道。** SQLite 不暴露"谁持有锁"，也没有慢查询日志。
本模块就是补这一层：任何一条语句执行超过阈值、任何一次**写事务**跨度超过阈值，
都记一条带**完整调用栈**的日志，停机后从 journald 聚合即可点名。

## 读/写事务必须分开统计（否则全是噪音）

WAL 模式下**读事务不阻塞写者**，所以"一个开了 30 秒的只读 session"不是元凶；
但它会**挡住 WAL checkpoint 前进**，导致 WAL 只涨不缩、读时穿越更多帧。
所以两类分开记，日志文案也不同，聚合脚本分别列出：

  · `[db-slow] 写事务 Xs`  → **元凶候选**（真正持有写锁的人）
  · `[db-slow] 读事务 Xs`  → checkpoint 阻塞者（另一类问题）
  · `[db-slow] Xs WRITE-等锁?` → **受害者**（在等别人）

## 为什么用 SQLAlchemy 事件而不是包 sqlite3

- 事件同时覆盖 `with get_session()` 与 `with engine.begin()` 两条路径；
- `before_cursor_execute` → `after_cursor_execute` 的墙钟差**包含等锁时间**
  （sqlite3 的 `busy_timeout` 是在 `execute` 内部睡的），所以受害者也会被记到；
- 持有者由 `begin` → `commit/rollback` 的跨度 + begin 处的栈点名。

## 开销

默认只在超阈值时做字符串拼接与 `extract_stack`，稳态是一条
`perf_counter()` + 两次 dict/list 操作。整段可用 `FW_DB_SLOW_LOG=0` 关掉。

## 怎么读结果

```bash
python3 scripts/analyze_db_slow.py --since "2 hours ago"
```
"""
from __future__ import annotations

import logging
import os
import threading
import time
import traceback

from sqlalchemy import event
from sqlalchemy.orm import Session

logger = logging.getLogger("fw.dbslow")

#: 单条语句超过多少秒记一条。1 秒足够区分"正常慢"与"在等锁"——
#: 本库的单条业务语句正常都在 10 毫秒以内（`/detail` 全套也只 130–180 ms）。
_DEFAULT_SQL_SEC = 1.0
#: 一次事务（begin → commit/rollback）超过多少秒记一条。
#: 5 秒是"明显不该有"的水位：`_touch_used` 这类单行更新在 1 毫秒量级。
_DEFAULT_TX_SEC = 5.0
#: 连接被借出多少秒还没归还。单条连接正常借出是毫秒级；
#: 长借说明有代码在事务之外持着连接做别的事（典型：session 开着去做网络请求）。
_HOLD_SEC = 10.0

#: 单条日志里栈保留几帧。只留 app 自己的帧，标准库/SQLAlchemy 的帧对定位无价值。
_STACK_FRAMES = 8

#: 进程内累计计数。主出口是日志，这些数字给测试与以后的诊断端点用。
_stats: dict[str, int] = {
    "statements": 0, "slow_sql": 0, "slow_tx_write": 0, "slow_tx_write_wait": 0,
    "slow_tx_read": 0, "slow_session": 0, "long_hold": 0,
}

#: 每线程状态。SQLAlchemy 的同步执行模型保证同一条语句的 before/after 在同一线程。
_local = threading.local()

#: 连接借出的起点。⚠️ 不能用 `setattr(dbapi_conn, ...)`——
#: sqlite3.Connection 没有 `__dict__`，赋值会抛 AttributeError，
#: 而这个 listener 挂在每次取连接上，等于让全站每个请求都炸。
#: 按 id 记账；连接归还时删掉，不会无界增长。
_checkout_at: dict[int, tuple[float, list[str]]] = {}


def _enabled() -> bool:
    return (os.environ.get("FW_DB_SLOW_LOG") or "1").strip().lower() not in (
        "0", "false", "no", "off")


def _threshold(env: str, default: float) -> float:
    try:
        return float(os.environ.get(env) or default)
    except (TypeError, ValueError):
        return default


def _app_stack() -> list[str]:
    """只保留项目自己的帧，形如 `app/jobs.py:3445 in _to_trusted_assets`。

    过滤掉 sqlalchemy / 标准库的帧：它们在任何一次调用里都长得一样，
    写进日志只会把真正有用的那几行挤掉。
    """
    out: list[str] = []
    for fr in traceback.extract_stack()[:-2]:
        fn = fr.filename
        if "/site-packages/" in fn or "/dist-packages/" in fn:
            continue
        if fn.startswith("<"):
            continue
        idx = fn.find("/app/")
        short = fn[idx + 1:] if idx >= 0 else os.path.basename(fn)
        out.append(f"{short}:{fr.lineno} in {fr.name}")
    return out[-_STACK_FRAMES:]


def _fmt_stack(frames: list[str]) -> str:
    return " <- ".join(reversed(frames)) if frames else "(no app frames)"


def _table_of(sql: str) -> str:
    """从 SQL 里粗取主表名，只用于聚合分类，不追求解析正确。"""
    s = " ".join((sql or "").split())
    low = s.lower()
    for kw in ("insert into ", "update ", "delete from ", "from "):
        i = low.find(kw)
        if i < 0:
            continue
        rest = s[i + len(kw):].strip()
        name = rest.split("(")[0].split()[0] if rest else ""
        name = name.strip('"`[];,')
        if name and name.lower() not in ("select", "where"):
            return name[:40]
    return "?"


def _is_write(sql: str) -> bool:
    op = (sql or "").lstrip()[:10].upper()
    return op.startswith(("UPDATE", "INSERT", "DELETE", "REPLACE"))


def install(engine) -> None:  # noqa: ANN001 — 只要是个 Engine 就行
    """给 engine 挂上慢语句 / 长事务探针。重复调用是安全的（同一 engine 只挂一次）。"""
    if getattr(engine, "_fw_slow_installed", False) or not _enabled():
        return
    engine._fw_slow_installed = True  # type: ignore[attr-defined]

    sql_sec = _threshold("FW_SLOW_SQL_SEC", _DEFAULT_SQL_SEC)
    tx_sec = _threshold("FW_SLOW_TX_SEC", _DEFAULT_TX_SEC)

    # ------------------------------------------------------------------
    # 单条语句
    # ------------------------------------------------------------------
    @event.listens_for(engine, "before_cursor_execute")
    def _before(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
        st = _local.__dict__
        st.setdefault("sql", []).append((time.perf_counter(), statement))
        _stats["statements"] += 1
        # ⚠️ 写标记必须在 before 就打，不能等 after。
        # 受害者（在等锁的那些）**根本执行不到 after** —— 实测：被长写事务挡住的
        # INSERT 在事务超时后才 rollback，它的 after 从未触发，于是被归成
        # "读事务（挡 checkpoint）"，把元凶和受害者的身份彻底搞反。
        if _is_write(statement):
            tx = getattr(_local, "tx", None)
            if tx:
                tx[-1][2] = True

    @event.listens_for(engine, "after_cursor_execute")
    def _after(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
        stack = getattr(_local, "sql", None)
        if not stack:
            return
        t0, sql = stack.pop()
        dt = time.perf_counter() - t0
        # 累加"语句真正花掉的时间"，供事务结束时区分「持有者」与「等锁者」。
        # ⚠️ 必须在超阈值判断**之前**累加：受害者的那条语句往往正是慢的那条，
        # 若只在超阈值分支里加，它的 sql_time 会恒为 0 而被误判成持有者。
        tx = getattr(_local, "tx", None)
        if tx:
            tx[-1][3] += dt
        if dt < sql_sec:
            return
        _stats["slow_sql"] += 1
        op = (sql or "").lstrip().split(" ", 1)[0].upper()[:8]
        # 本库没有"慢更新"的业务理由，写操作慢几乎一定是等锁；读慢更可能是缺索引。
        kind = "WRITE-等锁?" if _is_write(sql) else "READ"
        logger.warning(
            "[db-slow] %.2fs %s op=%s table=%s sql=%s | 栈: %s",
            dt, kind, op, _table_of(sql),
            " ".join((sql or "").split())[:200], _fmt_stack(_app_stack()),
        )

    # ------------------------------------------------------------------
    # 事务跨度（找"锁的持有者"）
    # ------------------------------------------------------------------
    @event.listens_for(engine, "begin")
    def _tx_begin(conn):  # noqa: ANN001
        # 每项：[开始时刻, begin 处栈, 是否写过, 语句累计耗时]
        _local.__dict__.setdefault("tx", []).append(
            [time.perf_counter(), _app_stack(), False, 0.0])

    def _tx_end(outcome: str) -> None:
        tx = getattr(_local, "tx", None)
        if not tx:
            return
        t0, frames, is_write, sql_time = tx.pop()
        dt = time.perf_counter() - t0
        if dt < tx_sec:
            return
        if not is_write:
            _stats["slow_tx_read"] += 1
            # 只读事务不挡写，但挡 WAL checkpoint → WAL 只涨不缩、读要穿越更多帧。
            logger.warning("[db-slow] 读事务 %.1fs（%s，挡 checkpoint）开始于: %s",
                           dt, outcome, _fmt_stack(frames))
            return
        # ⚠️ 区分「持有者」与「等锁者」，否则两者都会被写成"持有写锁"。
        #
        # SQLite 的 `BEGIN` 是**延迟**的（默认 DEFERRED）：`with engine.begin()`
        # 一进来就触发 begin 事件，但写锁要到**第一条写语句**时才真正获取。
        # 于是：
        #   · 持有者：自己的语句很快（毫秒级），但两条语句之间隔了很久
        #            → 语句耗时 << 事务跨度，差值就是"它攥着锁在干活"的时间
        #   · 等锁者：事务跨度 ≈ 语句耗时（全部时间都花在那条被挡住的语句上）
        # 实测（2 秒写事务 + 3 个并发写入）：若不分，三个受害者全被标成"持有写锁"，
        # 元凶和受害者各 4 条日志，聚合时根本分不出谁是谁。
        idle = dt - sql_time
        if idle > sql_time and idle > 0.5:
            _stats["slow_tx_write"] += 1
            logger.warning(
                "[db-slow] 写事务 %.1fs（%s）其中语句仅占 %.2fs，"
                "**持有写锁 %0.1fs** ← 元凶候选 | begin 于: %s",
                dt, outcome, sql_time, idle, _fmt_stack(frames))
        else:
            _stats["slow_tx_write_wait"] += 1
            logger.warning(
                "[db-slow] 写事务 %.1fs（%s）其中语句占 %.2fs，"
                "**大部分在等锁** ← 受害者 | begin 于: %s",
                dt, outcome, sql_time, _fmt_stack(frames))

    @event.listens_for(engine, "commit")
    def _tx_commit(conn):  # noqa: ANN001
        _tx_end("commit")

    @event.listens_for(engine, "rollback")
    def _tx_rollback(conn):  # noqa: ANN001
        _tx_end("rollback")

    # ------------------------------------------------------------------
    # 连接被借出太久（事务外持连接 = 池被占 + 可能是锁的间接原因）
    # ------------------------------------------------------------------
    @event.listens_for(engine, "checkout")
    def _checkout(dbapi_conn, record, proxy):  # noqa: ANN001
        _checkout_at[id(dbapi_conn)] = (time.perf_counter(), _app_stack())

    @event.listens_for(engine, "checkin")
    def _checkin(dbapi_conn, record):  # noqa: ANN001
        got = _checkout_at.pop(id(dbapi_conn), None)
        if not got:
            return
        t0, frames = got
        dt = time.perf_counter() - t0
        if dt > _HOLD_SEC:
            _stats["long_hold"] += 1
            logger.warning("[db-slow] 连接被借出 %.1fs 未归还: %s",
                           dt, _fmt_stack(frames))

    logger.info("[db-slow] 探针已挂载：语句阈值 %.1fs，事务阈值 %.1fs",
                sql_sec, tx_sec)


class SlowWatchSession(Session):
    """给 `with get_session() as s:` 记墙钟时长。

    只管"这个 session 活了多久"，不判断读写 —— 读写由事务事件按
    真实发生过的语句判定，更准。这里超阈值只是提示"有代码把 session 开着干别的"。

    ⚠️ 只覆盖 `with` 路径。部分调用方是 `s = get_session()` 后自己 close，
       那时不会计时——**有意不改调用方**，统计不该反向约束业务写法。
    """

    def __enter__(self):  # noqa: ANN204
        if not _enabled():
            return super().__enter__()
        self.__dict__.setdefault("_fw_with", (time.perf_counter(), _app_stack()))
        return super().__enter__()

    def __exit__(self, *exc):  # noqa: ANN002, ANN204
        started = self.__dict__.pop("_fw_with", None)
        if started is not None:
            t0, frames = started
            dt = time.perf_counter() - t0
            limit = _threshold("FW_SLOW_TX_SEC", _DEFAULT_TX_SEC)
            if dt >= limit:
                _stats["slow_session"] += 1
                logger.warning("[db-slow] session 持有 %.1fs（with 块整段）: %s",
                               dt, _fmt_stack(frames))
        # ⚠️ 不能在 finally 里 return：那会把 super().__exit__ 的异常吞掉。
        # 上面的统计若抛异常，也不能挡住宿主类的 close。
        return super().__exit__(*exc)


def snapshot() -> dict[str, int]:
    """进程内累计计数（给测试与以后的诊断端点用）。"""
    return dict(_stats)
