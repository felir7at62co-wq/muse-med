"""网文大数据 MCP 客户端 (raw JSON-RPC over Streamable HTTP)。

不用额外装 mcp SDK, 直接用 httpx 走协议(已实测连通):
  1. POST initialize → 拿响应头 mcp-session-id
  2. POST notifications/initialized (带 session)
  3. POST tools/call (带 session) → 解析 SSE(data: {...})

对外只暴露 query_sql / list_tables / describe_table / list_column_values。
Key/URL 走环境变量, 不硬编码。
"""
from __future__ import annotations

import json
import logging
import os

import httpx

logger = logging.getLogger("market.mcp")

MCP_URL = os.environ.get("WW_MCP_URL", "https://wwdsj-mcp.lingjingai.cn/mcp")
MCP_KEY = os.environ.get("WW_MCP_API_KEY", "")

_HEADERS_BASE = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}


def _headers(session_id: str | None = None) -> dict:
    h = dict(_HEADERS_BASE)
    if MCP_KEY:
        h["X-MCP-API-Key"] = MCP_KEY
    if session_id:
        h["mcp-session-id"] = session_id
    return h


def _parse_sse(text: str) -> dict | None:
    """从 SSE 文本里取出第一条 data: {json} 。"""
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            payload = line[5:].strip()
            try:
                return json.loads(payload)
            except Exception:
                continue
        elif line.startswith("{"):
            try:
                return json.loads(line)
            except Exception:
                continue
    return None


class MCPError(Exception):
    pass


async def _new_session(client: httpx.AsyncClient) -> str:
    """initialize 握手, 返回 session id。"""
    init_body = {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "drama-market", "version": "1.0"},
        },
    }
    r = await client.post(MCP_URL, headers=_headers(), json=init_body)
    sid = r.headers.get("mcp-session-id") or r.headers.get("Mcp-Session-Id")
    if not sid:
        raise MCPError("MCP 初始化失败: 未拿到 session id")
    # 通知 initialized
    await client.post(MCP_URL, headers=_headers(sid),
                      json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    return sid


async def call_tool(name: str, arguments: dict, *, timeout: float = 40.0) -> dict:
    """调用某个 MCP 工具, 返回 {ok, text, raw}。"""
    if not MCP_KEY:
        return {"ok": False, "error": "未配置 WW_MCP_API_KEY"}
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            sid = await _new_session(client)
            body = {
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }
            r = await client.post(MCP_URL, headers=_headers(sid), json=body)
            data = _parse_sse(r.text)
            if not data:
                return {"ok": False, "error": f"无法解析 MCP 响应: {r.text[:300]}"}
            if "error" in data:
                return {"ok": False, "error": data["error"].get("message", "MCP 调用出错")}
            content = (data.get("result") or {}).get("content") or []
            texts = [c.get("text", "") for c in content if c.get("type") == "text"]
            return {"ok": True, "text": "\n".join(texts), "raw": data.get("result")}
    except httpx.HTTPError as e:
        logger.warning("MCP HTTP error: %s", e)
        return {"ok": False, "error": f"连接市场数据服务失败: {e}"}
    except Exception as e:
        logger.exception("MCP call failed")
        return {"ok": False, "error": str(e)}


async def query_sql(sql: str) -> dict:
    """执行只读 SQL, 把返回的 markdown 表格解析成 {columns, rows}。"""
    res = await call_tool("query_sql", {"sql": sql})
    if not res.get("ok"):
        return res
    parsed = _parse_markdown_table(res.get("text", ""))
    return {"ok": True, "sql": sql, **parsed, "raw_text": res.get("text", "")}


async def list_tables() -> dict:
    res = await call_tool("list_tables", {})
    if not res.get("ok"):
        return res
    try:
        arr = json.loads(res["text"])
        return {"ok": True, "tables": arr}
    except Exception:
        return {"ok": True, "tables": [], "raw_text": res.get("text", "")}


def _parse_markdown_table(md: str) -> dict:
    """把 MCP 返回的 markdown 表格解析成 {columns:[...], rows:[[...]]}。"""
    lines = [l for l in md.splitlines() if l.strip().startswith("|")]
    if len(lines) < 2:
        return {"columns": [], "rows": []}
    def split_row(l: str) -> list[str]:
        cells = [c.strip() for c in l.strip().strip("|").split("|")]
        return cells
    columns = split_row(lines[0])
    rows = []
    for l in lines[2:]:  # 跳过表头 + 分隔行
        cells = split_row(l)
        if len(cells) == len(columns):
            rows.append(cells)
    return {"columns": columns, "rows": rows}