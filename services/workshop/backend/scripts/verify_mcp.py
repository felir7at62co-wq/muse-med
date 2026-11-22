"""剧本平台 MCP 端点验收（打真实的 dev 服务，不调写稿模型、不改草稿）。

用法：python3 scripts/verify_mcp.py <base_url> <key 文件>
例如：python3 scripts/verify_mcp.py http://127.0.0.1:8001 /tmp/jl_mcp_key
key 只从文件读，不打印。
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

BASE, KEY_FILE = sys.argv[1].rstrip("/"), sys.argv[2]
KEY = open(KEY_FILE).read().strip()
ok_n = bad_n = 0


def ok(cond: bool, msg: str, extra: object = "") -> None:
    global ok_n, bad_n
    print(("  ✅ " if cond else "  ❌ ") + msg + ("" if cond else f"  —— {str(extra)[:300]}"))
    ok_n += bool(cond)
    bad_n += (not cond)


def http(method: str, path: str, body: object = None, token: str | None = KEY) -> tuple[int, object]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json, text/event-stream")
    if token is not None:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode(errors="replace")


def rpc(method: str, params: dict | None = None, mid: int = 1, token: str | None = KEY):
    return http("POST", "/v1/mcp", {"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}}, token)


print("① 握手与目录")
st, r = rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "verify", "version": "1"}})
res = r.get("result", {}) if isinstance(r, dict) else {}
ok(st == 200 and res.get("protocolVersion") == "2025-06-18" and "tools" in res.get("capabilities", {}), "initialize 回协议版本与 tools 能力", r)
instr = res.get("instructions", "")
ok("通过 MCP 接入了剧本平台" in instr and "镜流桌面客户端" not in instr, "★ 说明是 MCP 版，不含桌面客户端那段", instr[-200:])
ok(len(instr.encode()) < 30000, f"说明 {len(instr.encode())} 字节，低于客户端 32KB 上限")
st, r = rpc("initialize", {"protocolVersion": "1999-01-01"})
ok(r.get("result", {}).get("protocolVersion") == "2025-06-18", "不认识的协议版本回最新支持的")
st, _ = http("POST", "/v1/mcp", {"jsonrpc": "2.0", "method": "notifications/initialized"})
ok(st == 202, "通知回 202 无响应体", st)
st, r = rpc("tools/list")
tools = {t["name"]: t for t in r.get("result", {}).get("tools", [])}
ok(len(tools) >= 50, f"tools/list 列出 {len(tools)} 个工具")
ok(all(t["inputSchema"].get("type") == "object" for t in tools.values()), "每个工具的 inputSchema 都是 object")
changing = [n for n, t in tools.items() if not t["annotations"]["readOnlyHint"]]
ok(changing and all("confirmed" in tools[n]["inputSchema"]["properties"] for n in changing if tools[n]["annotations"]["destructiveHint"]),
   "★ 会改内容的工具带 confirmed 参数")
ok(all("confirmed" not in t["inputSchema"]["properties"] for t in tools.values() if t["annotations"]["readOnlyHint"]), "只读工具不带 confirmed")

print("② 调用")
read_tool = "list_drafts" if "list_drafts" in tools else next(n for n, t in tools.items() if t["annotations"]["readOnlyHint"])
st, r = rpc("tools/call", {"name": read_tool, "arguments": {}})
res = r.get("result", {})
ok(st == 200 and res.get("isError") is False and res["content"][0]["type"] == "text", f"★ 只读工具 {read_tool} 能调通", r)
st, r = rpc("tools/call", {"name": "no_such_tool", "arguments": {}})
ok(r.get("error", {}).get("code") == -32602, "没有的工具回 -32602", r)
if "trash_draft" in tools:
    st, r = rpc("tools/call", {"name": "trash_draft", "arguments": {"draft_id": 999999999}})
    text = r.get("result", {}).get("content", [{}])[0].get("text", "")
    ok("需要用户确认" in text or r.get("result", {}).get("isError"), "★ 删草稿不带 confirmed：先要确认（或因草稿不存在报错），不会直接执行", r)
st, r = rpc("no/such/method")
ok(r.get("error", {}).get("code") == -32601, "不支持的方法回 -32601")
st, r = http("POST", "/v1/mcp", [{"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/x"}])
ok(st == 200 and isinstance(r, list) and len(r) == 1, "批量请求：通知不回、请求回", r)
st, _ = http("GET", "/v1/mcp")
ok(st == 405, "GET 回 405（不提供推送流）", st)

print("③ 鉴权与影响面")
st, _ = rpc("tools/list", token=None)
ok(st == 401, "不带 key 401", st)
st, _ = rpc("tools/list", token="jlk_not_a_real_key")
ok(st == 401, "假 key 401", st)
st, _ = http("GET", "/v1/desktop-agent/tools")
ok(st == 401, "★ key 用在别的接口（桌面端工具目录）上 401", st)
st, _ = http("GET", "/v1/api-keys")
ok(st == 401, "★ key 不能用来管理 key（不能 key 生 key）", st)

print(f"\n{'✅ 全部通过' if not bad_n else f'❌ {bad_n} 项失败'}（{ok_n + bad_n} 项）")
