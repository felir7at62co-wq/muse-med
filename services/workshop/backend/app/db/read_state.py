"""未读状态服务 —— 计算与标记（PLAN §4.2）

核心规则（与 models_read.py 的设计配套）：

    未读 = 该产物流的最新 updated_at > 该用户在该流上的 seen_at

这条规则的好处：内容重新生成后**自动**重新变红，不需要任何写回逻辑。
"""
from __future__ import annotations

import logging

from sqlalchemy import text

from . import session_scope

logger = logging.getLogger("read_state")

#: 产物流 → 该流的产物来自哪张表、用什么时间列。
#:
#: ⚠ 这里必须与工作台的 tab 语义对齐（见 components/workbench/WorkbenchSidebar.tsx）：
#:   chapters   = 原文
#:   storyboards= 剧本
#:   novel/tweet= 改编产物（chapter_adaptations，按 kind 区分）
#:   prompts    = 视频提示词，但**它不是用户"读"的内容**，所以不参与未读计算
#:                （见下方 STREAMS 注释）
STREAMS = (
    "outline",
    "chapters",
    "storyboards",
    "novel",
    "tweet",
)

#: SQL 片段：每个流"最新产物时间"的取法。
#:
#: 为什么用一条 UNION ALL 而不是循环查：列表页要一次算几百份草稿的未读，
#: 循环查会变成 N×5 次往返。这里一次拿到 (draft_id, stream, latest) 全表。
#:
#: 注意 outline 没有独立表 —— 它存在 script_drafts.outline 这个 JSONB 列里，
#: 所以它的"更新时间"退回草稿自身的 updated_at（大纲变更必然伴随草稿更新）。
_LATEST_SQL = """
SELECT draft_id, 'chapters' AS stream, MAX(COALESCE(updated_at, created_at)) AS latest
  FROM script_chapters WHERE draft_id = ANY(:ids) GROUP BY draft_id
UNION ALL
SELECT draft_id, 'storyboards', MAX(COALESCE(updated_at, created_at))
  FROM script_storyboards WHERE draft_id = ANY(:ids) GROUP BY draft_id
UNION ALL
SELECT draft_id, kind, MAX(COALESCE(updated_at, created_at))
  FROM chapter_adaptations WHERE draft_id = ANY(:ids) AND kind IN ('novel','tweet') GROUP BY draft_id, kind
"""


async def unread_counts(*, user_id: int, draft_ids: list[int]) -> dict[int, dict[str, int]]:
    """批量算未读数。

    返回 {draft_id: {stream: 未读数}}，只含**有未读**的项（为 0 的不出现，
    前端据此决定是否渲染红点，不需要自己判 0）。

    一次往返拿全部 —— 首页列表一屏十几条，逐条查会是十几次往返。
    """
    if not draft_ids:
        return {}

    async with session_scope() as s:
        # 1) 每个流的最新产物时间
        rows = (await s.execute(
            text(_LATEST_SQL), {"ids": draft_ids}
        )).all()
        latest: dict[int, dict[str, object]] = {}
        for did, stream, ts in rows:
            if ts is not None:
                latest.setdefault(did, {})[stream] = ts

        # 大纲流：用草稿自身的 updated_at
        drows = (await s.execute(
            text("SELECT id, updated_at FROM script_drafts WHERE id = ANY(:ids)"),
            {"ids": draft_ids},
        )).all()
        for did, ts in drows:
            if ts is not None:
                latest.setdefault(did, {})["outline"] = ts

        # 2) 该用户在这些草稿上的 seen_at
        srows = (await s.execute(
            text("""SELECT draft_id, stream, seen_at FROM draft_read_state
                    WHERE user_id = :u AND draft_id = ANY(:ids)"""),
            {"u": user_id, "ids": draft_ids},
        )).all()
        seen: dict[tuple[int, str], object] = {(d, st): ts for d, st, ts in srows}

        # 3) 未读数：某流只要有产物晚于 seen_at 就算 1（不是数条数）
        #
        # ⚠ 这里刻意是 0/1 而不是"共有几条未读"。原因是**用户无法处理"3 条未读"**
        #    这种信息 —— 他能做的就是"去看一眼"。数字会暗示"有 3 件待办"，
        #    而实际是"这一流有新内容"。所以红点是**存在性标记**，不是计数。
        out: dict[int, dict[str, int]] = {}
        for did, streams in latest.items():
            for stream, ts in streams.items():
                if stream not in STREAMS:
                    continue
                last_seen = seen.get((did, stream))
                if last_seen is None or ts > last_seen:
                    out.setdefault(did, {})[stream] = 1
        return out


async def mark_seen(*, user_id: int, draft_id: int, stream: str) -> None:
    """把某用户在某草稿某流上的"看过时间"推到现在。

    幂等：重复调用只是把时间往后推，不会报错（upsert）。
    """
    if stream not in STREAMS:
        logger.warning("mark_seen: 未知的产物流 %r，忽略", stream)
        return
    async with session_scope() as s:
        await s.execute(
            text("""INSERT INTO draft_read_state (user_id, draft_id, stream, seen_at, updated_at)
                    VALUES (:u, :d, :st, NOW(), NOW())
                    ON CONFLICT (user_id, draft_id, stream)
                    DO UPDATE SET seen_at = NOW(), updated_at = NOW()"""),
            {"u": user_id, "d": draft_id, "st": stream},
        )


async def unread_total(*, user_id: int) -> int:
    """用户全局未读数（草稿数口径，用于未来可能的全局入口红点）。"""
    async with session_scope() as s:
        rows = (await s.execute(
            text("SELECT id FROM script_drafts WHERE user_id = :u AND is_deleted = false"),
            {"u": user_id},
        )).all()
    ids = [r[0] for r in rows]
    counts = await unread_counts(user_id=user_id, draft_ids=ids)
    return len(counts)
