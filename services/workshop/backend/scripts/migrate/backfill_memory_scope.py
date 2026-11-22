"""存量记忆作用域回填 —— 把历史记忆按类型归入 global / draft。

## 背景

2026-10-10 修复「AI 把别的剧本设定写进这个剧本」时，给 ``user_memories`` 启用了
``scope`` / ``scope_ref`` 两级隔离（见 ``app/agent/memory.py`` 模块文档）。但那个
修复只对**新写入**的记忆生效 —— 库里已有的记忆全都是 ``scope='global'``，
不处理的话隔离形同虚设：老的角色表照样能跨剧召回。

本脚本把存量按同一套判据回填：

  · ``preference`` / ``habit`` / ``style*`` / ``forbidden_topics`` /
    ``preferred_length`` / ``format_standard``                       → 作者级（不动）
  · **其余一切**（角色表/世界观/情节/fact/project_*/未登记类型）      → 剧本级

## 归属怎么定

只能靠 ``source_conv_id`` → ``agent_conversations.draft_id`` 这条链推：

  · 会话**有** ``draft_id``      → ``scope='draft'``、``scope_ref=<该 id>``
  · 会话**没有** ``draft_id``    → **保持 global**（推不出是哪部剧）

后一条是刻意的保守选择：宁可让这部分记忆继续宽松，也不猜一个 draft_id 塞进去 ——
猜错等于把它锁进一部**不相干**的剧，比不隔离更难发现（用户在下拉里找不到它）。

所以脚本会把"推不出来的条数"报出来。prod 实测这类占多数（19724 条里只有 3449 条的
来源会话带 draft_id），因为大量记忆来自没有绑定草稿的闲聊式对话。

## 用法

    docker cp services/orchestrator/scripts/migrate/backfill_memory_scope.py \
        drama-dev-orchestrator:/app/bf.py
    docker exec -w /app drama-dev-orchestrator python bf.py            # dry-run
    docker exec -w /app drama-dev-orchestrator python bf.py --apply    # 真写

⚠️ prod 上必须已获上线授权；默认 dry-run。
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

# 允许直接 `python scripts/migrate/xxx.py` 运行（把 orchestrator 根加进 path）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from sqlalchemy import text as sql_text

from app.db import session_scope
from app.agent.memory import _AUTHOR_LEVEL_TYPES

logger = logging.getLogger("backfill_memory_scope")


async def _stats() -> dict:
    """可回填 / 推不出 / 已经对 各多少条。"""
    async with session_scope() as s:
        row = (await s.execute(sql_text(f"""
            SELECT
              -- 白名单语义：剧本级 = **不属于作者级**的一切（含未登记的新类型）
              COUNT(*) FILTER (WHERE NOT (m.type = ANY(:t)) AND m.scope = 'global'
                                 AND c.draft_id IS NOT NULL)               AS fillable,
              COUNT(*) FILTER (WHERE NOT (m.type = ANY(:t)) AND m.scope = 'global'
                                 AND c.draft_id IS NULL)                   AS unassignable,
              COUNT(*) FILTER (WHERE NOT (m.type = ANY(:t)) AND m.scope <> 'global') AS already,
              COUNT(*) FILTER (WHERE m.type = ANY(:t))                         AS user_level,
              COUNT(*)                                                          AS total
            FROM user_memories m
            LEFT JOIN agent_conversations c ON c.id = m.source_conv_id
        """), {"t": sorted(_AUTHOR_LEVEL_TYPES)})).mappings().first()
    return dict(row or {})


async def backfill(*, apply: bool) -> dict:
    st = await _stats()
    print("=" * 62)
    print("存量记忆作用域回填")
    print("=" * 62)
    print(f"  总数                 {st.get('total', 0):>8,}")
    print(f"  用户级(偏好/习惯等)   {st.get('user_level', 0):>8,}  ← 保持不动")
    print(f"  已经是剧本级          {st.get('already', 0):>8,}  ← 已回填过")
    print(f"  可回填                {st.get('fillable', 0):>8,}  ← 本次会改")
    print(f"  推不出归属            {st.get('unassignable', 0):>8,}  ← 保持 global（保守）")

    if not st.get("fillable"):
        print("\n没有需要回填的记录。")
        return st

    if not apply:
        print("\n[dry-run] 未写库。确认无误后加 --apply 重跑。")
        # 抽样展示这次会改哪些
        async with session_scope() as s:
            rows = (await s.execute(sql_text(f"""
                SELECT m.id, m.type, c.draft_id, LEFT(COALESCE(m.title,''), 30) AS t
                FROM user_memories m
                JOIN agent_conversations c ON c.id = m.source_conv_id
                WHERE NOT (m.type = ANY(:t)) AND m.scope = 'global'
                  AND c.draft_id IS NOT NULL
                ORDER BY m.id LIMIT 12
            """), {"t": sorted(_AUTHOR_LEVEL_TYPES)})).mappings().all()
        print("\n  抽样（id / 类型 / 将归到草稿 / 标题）：")
        for r in rows:
            print(f"    {r['id']:>7}  {r['type']:<18} draft={r['draft_id']:<7} {r['t']}")
        return st

    async with session_scope() as s:
        r = await s.execute(sql_text(f"""
            UPDATE user_memories m
               SET scope = 'draft', scope_ref = c.draft_id::text
              FROM agent_conversations c
             WHERE c.id = m.source_conv_id
               AND NOT (m.type = ANY(:t))
               AND m.scope = 'global'
               AND c.draft_id IS NOT NULL
        """), {"t": sorted(_AUTHOR_LEVEL_TYPES)})
        changed = r.rowcount or 0
    print(f"\n✅ 已回填 {changed:,} 条为剧本级。")
    logger.info("memory scope backfill: %d rows", changed)
    return {**st, "changed": changed}


def main() -> None:
    ap = argparse.ArgumentParser(description="存量记忆作用域回填")
    ap.add_argument("--apply", action="store_true",
                    help="真正写库；不加则只 dry-run")
    args = ap.parse_args()
    asyncio.run(backfill(apply=args.apply))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
