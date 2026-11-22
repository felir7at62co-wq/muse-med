"""公告群发：把一条公告通过飞书私信发给平台上的人。

## 它解决什么

公告此前只有网页顶部横幅（`announcements` 表 / `_AnnouncementBar.tsx`）。
横幅的前提是"人正好打开着剧本平台网页"——用户在织影里剪片、在生成长任务里
等结果、或者这几天根本没开网页，就一个字都看不到。飞书私信是**推**而不是**拉**。

## 三个刻意的口径（都有代价，写在这里免得以后被"优化"掉）

1. **只发给能收到的人，且如实分开三类**：
   - `sent` 成功
   - `failed` 暂态失败（限流/网络/飞书 5xx），**可以重发**
   - `skipped` 这个人本来就发不到（没绑飞书、账号停用、union_id 无效）
   把 skipped 混进 failed 会让管理员以为"飞书在抽风"，实际是这个人没有飞书身份，
   重发一百次也不会成功。

2. **同一 union_id 只发一次**：历史脏数据里可能存在两个 user 共用同一个飞书身份
   （换号后重建账号）。群发不看这一点就会给同一个人连发两条。

3. **发送前必须先预览**：群发不可撤回。界面上必须先看"将发给 N 人，M 人收不到"，
   再确认发送。服务端另外有幂等护栏（`_recent_duplicate`），挡住"手抖点两次"。

## 平台范围

`scope=all` 是"本平台所有 active 且有飞书身份的账号"。**不单独提供"织影"档**：
织影不建用户表，它的登录身份全部来自本平台（filmweaver-dev/backend/app/auth.py），
user_id 与本站完全一致，所以全平台天然覆盖织影用户。另建一档只会让
"全平台"和"全平台+织影"两个选项含义重叠、更容易发错人。
"""
from __future__ import annotations

import asyncio
import json
import logging
from sqlalchemy import select, text

from ..db import session_scope
from ..feishu import client as feishu
from ..feishu.client import FeishuSendError, is_invalid_recipient

logger = logging.getLogger("announce")

#: 单条公告正文上限。飞书单条文本消息远大于此 —— 这里限的是"人能审阅的长度"。
#: 一次群发不可撤回，长到没人看完就等于没人审过。
MAX_TEXT = 2000
#: 群发时对飞书接口的并发。飞书对单应用有 QPS 限制，太高会成片 429；
#: 这里是**发送侧**的并发，与平台生成作业的并发无关，不要和那边混为一谈。
SEND_CONCURRENCY = 8


class AnnounceError(ValueError):
    """可预期的失败：原因直接给管理员看。"""


# ---------------------------------------------------------------------------
# 收件人
# ---------------------------------------------------------------------------

async def resolve_recipients(user_ids: list[int] | None = None) -> tuple[list[dict], list[dict]]:
    """算出这次能发给谁，返回 `(sendable, skipped)`。

    sendable: [{user_id, name, union_id}] —— 同一个 union_id 只出现一次
    skipped:  [{user_id, name, reason}]  —— 发不到的人及原因

    `user_ids=None` 或空 = 全平台。
    """
    want = {int(x) for x in user_ids} if user_ids else None

    async with session_scope() as s:
        rows = (await s.execute(text(
            """SELECT id, username, display_name, role, status, feishu_union_id
               FROM users ORDER BY id"""
        ))).mappings().all()

    sendable: list[dict] = []
    skipped: list[dict] = []
    seen_union: dict[str, int] = {}

    for r in rows:
        uid = int(r["id"])
        if want is not None and uid not in want:
            continue
        name = (r["display_name"] or r["username"] or f"用户 {uid}")
        status = (r["status"] or "").strip().lower()
        union = (r["feishu_union_id"] or "").strip()

        if status != "active":
            # 停用/合并账号不推：给人发了他也进不来，反而像诈尸。
            skipped.append({"user_id": uid, "name": name,
                            "reason": f"账号状态为 {status or '未知'}"})
            continue
        if not union:
            skipped.append({"user_id": uid, "name": name, "reason": "没有绑定飞书"})
            continue
        if union in seen_union:
            skipped.append({"user_id": uid, "name": name,
                            "reason": f"与用户 {seen_union[union]} 共用同一个飞书身份，只发一次"})
            continue
        seen_union[union] = uid
        sendable.append({"user_id": uid, "name": name, "union_id": union})

    # 指定名单里点了但查无此人（已被删号）也要说清楚
    if want is not None:
        found = {x["user_id"] for x in sendable} | {x["user_id"] for x in skipped}
        for uid in sorted(want - found):
            skipped.append({"user_id": uid, "name": f"用户 {uid}", "reason": "账号不存在"})

    return sendable, skipped


async def list_candidates(q: str = "", limit: int = 500) -> dict:
    """给界面用的勾选列表：所有有飞书身份的正常账号。

    `q` 按名字模糊匹配。`limit` 只截返回的**列表**，`total` 始终是全量 ——
    免得界面把"没显示全"误报成"平台就这么多人"。
    """
    sendable, skipped = await resolve_recipients(None)
    total = len(sendable)
    q = (q or "").strip().lower()
    hits = [{"user_id": x["user_id"], "name": x["name"]}
            for x in sendable if not q or q in x["name"].lower()]
    n = max(1, min(int(limit or 500), 2000))
    return {
        "total": total,
        "matched": len(hits),
        "items": hits[:n],
        "skipped_total": len(skipped),
        "skipped": skipped[:50],
    }


# ---------------------------------------------------------------------------
# 发送
# ---------------------------------------------------------------------------

async def _recent_duplicate(text_: str, user_ids: list[int],
                            within_seconds: int = 600) -> dict | None:
    """同一份内容 + **同一批人**，刚发过没有？群发不可撤回，这条护栏专防手抖。

    ⚠️ 必须同时比内容与收件人集合：只比内容会误伤"同样的文案发给另一批人"
    （分批发给不同组是正常用法）；只比人会把"追发一条补充说明"当成重复。
    """
    async with session_scope() as s:
        row = (await s.execute(text(
            """SELECT id, created_at, sent, total, target_ids FROM announcement_pushes
               WHERE created_at >= now() - CAST((:sec || ' seconds') AS interval)
                 AND text = :t
               ORDER BY id DESC LIMIT 1"""
        ), {"sec": within_seconds, "t": text_})).mappings().first()
        if not row:
            return None
        prev = sorted(int(x) for x in (row["target_ids"] or []))
        if prev != sorted(user_ids):
            return None
        return dict(row)


async def send_announcement(*, text_: str, title: str = "",
                            user_ids: list[int] | None = None,
                            announcement_id: int | None = None,
                            created_by: int | None = None,
                            dry_run: bool = False,
                            force: bool = False) -> dict:
    """群发一条公告。`dry_run=True` 只返回名单，一条都不发。

    返回：
      dry_run 时 —— {dry_run, would_send, recipients, skipped}
      正式发送 —— {ok, push_id, total, sent, failed, skipped, failures, duplicates}
    """
    await _ensure_tables()

    body = (text_ or "").strip()
    if not body:
        raise AnnounceError("公告内容不能为空")
    if len(body) > MAX_TEXT:
        raise AnnounceError(f"公告太长（{len(body)} 字），上限 {MAX_TEXT} 字")

    sendable, skipped = await resolve_recipients(user_ids)

    if dry_run:
        return {
            "dry_run": True,
            "would_send": len(sendable),
            "recipients": [{"user_id": x["user_id"], "name": x["name"]} for x in sendable],
            "skipped": skipped,
        }

    if not sendable:
        raise AnnounceError("这个范围里没有能收到飞书消息的人")

    ids = [x["user_id"] for x in sendable]

    if not force:
        dup = await _recent_duplicate(body, ids)
        if dup:
            raise AnnounceError(
                f"同样的内容刚刚已经发过（{str(dup['created_at'])[:16]}，"
                f"发给 {dup['total']} 人，成功 {dup['sent']}）。"
                f"群发不可撤回 —— 确认要重发请勾选「强制重发」或改一下内容/范围。")

    # 先落批次，拿到 push_id —— 中途崩溃时至少知道"发起了什么"
    async with session_scope() as s:
        row = (await s.execute(text(
            """INSERT INTO announcement_pushes
                 (announcement_id, title, text, scope, target_ids, total, created_by)
               VALUES (:aid, :title, :text, :scope, CAST(:targets AS jsonb), :total, :by)
               RETURNING id"""
        ), {
            "aid": announcement_id, "title": (title or "")[:128], "text": body,
            "scope": "users" if user_ids else "all",
            # ⚠️ target_ids 一律存**本次实际解析出的收件人**，不只存"指定名单"那种。
            # 以前 scope=all 时存空数组，而 `_recent_duplicate` 拿它和本次收件人集合
            # 比对 —— 空数组永远对不上，"全平台"这一档的防重复等于没有，
            # 而它恰恰是最容易被手抖点两次的那一档。
            "targets": json.dumps(ids, ensure_ascii=False),
            "total": len(sendable), "by": created_by,
        })).first()
        push_id = int(row[0])

    sem = asyncio.Semaphore(SEND_CONCURRENCY)

    async def _one(rec: dict) -> dict:
        async with sem:
            try:
                data = await feishu.send_text(union_id=rec["union_id"], text=body)
                return {"user_id": rec["user_id"], "name": rec["name"],
                        "status": "sent", "reason": "",
                        "message_id": str(data.get("message_id") or "")}
            except FeishuSendError as e:
                return {"user_id": rec["user_id"], "name": rec["name"],
                        "status": "skipped" if is_invalid_recipient(e) else "failed",
                        "reason": str(e)[:280], "message_id": ""}
            except Exception as e:  # noqa: BLE001  单人失败不影响其他人
                logger.warning("announce send to %s failed: %s", rec["user_id"], e)
                return {"user_id": rec["user_id"], "name": rec["name"],
                        "status": "failed", "reason": repr(e)[:280], "message_id": ""}

    results = await asyncio.gather(*[_one(r) for r in sendable])

    sent = sum(1 for r in results if r["status"] == "sent")
    failed = sum(1 for r in results if r["status"] == "failed")
    bad = sum(1 for r in results if r["status"] == "skipped")

    rows = results + [{"user_id": x["user_id"], "name": x["name"],
                       "status": "skipped", "reason": x["reason"], "message_id": ""}
                      for x in skipped]

    async with session_scope() as s:
        for r in rows:
            await s.execute(text(
                """INSERT INTO announcement_deliveries
                     (push_id, user_id, user_name, status, reason, message_id)
                   VALUES (:p, :u, :n, :st, :rs, :mid)"""
            ), {"p": push_id, "u": r["user_id"], "n": (r["name"] or "")[:128],
                "st": r["status"], "rs": (r["reason"] or "")[:300],
                "mid": (r["message_id"] or "")[:120]})
        await s.execute(text(
            """UPDATE announcement_pushes
               SET sent=:s, failed=:f, skipped=:k WHERE id=:p"""
        ), {"s": sent, "f": failed, "k": bad + len(skipped), "p": push_id})

    logger.info("[announce] push=%s by=%s 成功 %d 失败 %d 发不到 %d（范围 %d 人）",
                push_id, created_by, sent, failed, bad + len(skipped), len(sendable))

    return {
        "ok": True,
        "push_id": push_id,
        "total": len(sendable),
        "sent": sent,
        "failed": failed,
        "skipped": bad + len(skipped),
        "failures": [r for r in results if r["status"] != "sent"],
        "unreachable": skipped,
    }


async def _ensure_tables() -> None:
    """确保两张表存在。

    为什么不只靠 alembic：本模块可能被"测试脚本 / 手工调用"直接 import 使用，
    那时不一定跑过迁移；而建表是幂等的，多这一步免得调一次崩一次。
    与 db/models.py 的定义必须一致（改字段时两边一起改）。
    """
    async with session_scope() as s:
        await s.execute(text("""
            CREATE TABLE IF NOT EXISTS announcement_pushes (
                id SERIAL PRIMARY KEY,
                announcement_id INTEGER,
                title VARCHAR(128) NOT NULL DEFAULT '',
                text TEXT NOT NULL,
                scope VARCHAR(16) NOT NULL DEFAULT 'all',
                target_ids JSONB DEFAULT '[]'::jsonb,
                total INTEGER DEFAULT 0,
                sent INTEGER DEFAULT 0,
                failed INTEGER DEFAULT 0,
                skipped INTEGER DEFAULT 0,
                created_by INTEGER,
                created_at TIMESTAMP DEFAULT now()
            )"""))
        await s.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_announcement_pushes_created_at "
            "ON announcement_pushes (created_at)"))
        await s.execute(text("""
            CREATE TABLE IF NOT EXISTS announcement_deliveries (
                id SERIAL PRIMARY KEY,
                push_id INTEGER NOT NULL,
                user_id INTEGER,
                user_name VARCHAR(128) DEFAULT '',
                status VARCHAR(16) NOT NULL,
                reason VARCHAR(300) DEFAULT '',
                message_id VARCHAR(120) DEFAULT '',
                created_at TIMESTAMP DEFAULT now()
            )"""))
        await s.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_announcement_deliveries_push_id "
            "ON announcement_deliveries (push_id)"))
        await s.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_announcement_deliveries_status "
            "ON announcement_deliveries (status)"))


# ---------------------------------------------------------------------------
# 查询
# ---------------------------------------------------------------------------

async def list_pushes(limit: int = 50) -> list[dict]:
    await _ensure_tables()
    n = max(1, min(int(limit or 50), 200))
    async with session_scope() as s:
        rows = (await s.execute(text(
            """SELECT p.id, p.announcement_id, p.title, p.text, p.scope,
                      p.total, p.sent, p.failed, p.skipped,
                      p.created_by, p.created_at, u.username AS creator_name
               FROM announcement_pushes p
               LEFT JOIN users u ON u.id = p.created_by
               ORDER BY p.id DESC LIMIT :n"""
        ), {"n": n})).mappings().all()
        return [dict(r) for r in rows]


async def list_deliveries(push_id: int, limit: int = 500) -> dict:
    await _ensure_tables()
    n = max(1, min(int(limit or 500), 2000))
    async with session_scope() as s:
        rows = (await s.execute(text(
            """SELECT user_id, user_name, status, reason, message_id, created_at
               FROM announcement_deliveries WHERE push_id=:p
               ORDER BY id LIMIT :n"""
        ), {"p": push_id, "n": n})).mappings().all()
        return {"push_id": push_id, "items": [dict(r) for r in rows]}
