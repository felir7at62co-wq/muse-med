"""市场数据 (网文大数据) REST 路由 — 前端"市场数据"页用。

内部通过 MCP 客户端查询只读数据仓库, 转成前端友好的 JSON(columns/rows)。
所有登录用户可见。Key 在后端环境变量, 前端拿不到。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..auth import User, get_current_user
from . import mcp_client

router = APIRouter(prefix="/v1/market", tags=["market-data"])
logger = logging.getLogger("market.routes")

# 安全: 只允许只读 SELECT, 防止前端传入危险 SQL
_FORBIDDEN = ("insert", "update", "delete", "drop", "alter", "truncate", "create", "attach", "rename")


def _guard_sql(sql: str):
    low = sql.strip().lower()
    if not low.startswith("select") and not low.startswith("with"):
        raise HTTPException(400, "只允许 SELECT 查询")
    for kw in _FORBIDDEN:
        # 粗粒度拦截写操作关键字
        if f" {kw} " in f" {low} " or low.startswith(kw):
            raise HTTPException(400, f"禁止的操作: {kw}")


@router.get("/tables")
async def market_tables(user: User = Depends(get_current_user)):
    """列出所有可查数据表(给'数据字典'tab用)。"""
    res = await mcp_client.list_tables()
    if not res.get("ok"):
        raise HTTPException(502, res.get("error", "查询失败"))
    return res


@router.get("/rank-names")
async def market_rank_names(
    table: str = Query(..., description="榜单表名 lg_*"),
    user: User = Depends(get_current_user),
):
    """列出某榜单表里有哪些榜单名(rank_name)及其最新日期。"""
    date_col = "release_date" if table == "lg_fanqie_novel_snapshot" else "dt"
    sql = f"SELECT rank_name, max({date_col}) AS latest_date, count() AS rows FROM {table} GROUP BY rank_name ORDER BY rank_name LIMIT 100"
    res = await mcp_client.query_sql(sql)
    if not res.get("ok"):
        raise HTTPException(502, res.get("error", "查询失败"))
    return res


@router.get("/rank")
async def market_rank(
    table: str = Query(..., description="榜单表名 lg_*"),
    rank_name: str = Query(..., description="榜单名称"),
    limit: int = Query(30, ge=1, le=100),
    user: User = Depends(get_current_user),
):
    """取某榜单"最新一天"的排名列表(自动取该榜单 max 日期)。"""
    date_col = "release_date" if table == "lg_fanqie_novel_snapshot" else "dt"
    name_col = "book_id" if table == "lg_fanqie_novel_snapshot" else "series_name"
    safe_rank = rank_name.replace("'", "''")
    sql = (
        f"SELECT * FROM {table} "
        f"WHERE rank_name = '{safe_rank}' "
        f"AND {date_col} = (SELECT max({date_col}) FROM {table} WHERE rank_name = '{safe_rank}') "
        f"ORDER BY rank_num ASC LIMIT {limit}"
    )
    res = await mcp_client.query_sql(sql)
    if not res.get("ok"):
        raise HTTPException(502, res.get("error", "查询失败"))
    return res


class QueryIn(BaseModel):
    sql: str


@router.post("/query")
async def market_query(payload: QueryIn, user: User = Depends(get_current_user)):
    """高级: 直接跑只读 SQL(供'自助查询'tab)。仅 SELECT。"""
    _guard_sql(payload.sql)
    res = await mcp_client.query_sql(payload.sql)
    if not res.get("ok"):
        raise HTTPException(502, res.get("error", "查询失败"))
    return res


@router.get("/health")
async def market_health(user: User = Depends(get_current_user)):
    """探测 MCP 是否可用(给前端显示连接状态)。"""
    res = await mcp_client.list_tables()
    return {"ok": res.get("ok", False), "table_count": len(res.get("tables", []) or [])}