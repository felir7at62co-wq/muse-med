"""剧本平台的 MCP 端点：把桌面端那套工具开放给外部 Agent（2026-11-04）。

协议：MCP Streamable HTTP 的无状态子集——每个 JSON-RPC 请求一个 POST，响应直接是
``application/json``（规范允许服务端不开 SSE）。不发 ``Mcp-Session-Id``，GET / DELETE 回 405，
客户端据此知道没有服务端推送、也无需关闭会话。

执行路径与桌面端完全相同：``tools/call`` 直接调 ``desktop.call_tool``。所以慢工具转后台作业、
单次调用 280 秒上限、需要确认的操作先不执行，这些行为两边一致，不会分叉。

鉴权：``Authorization: Bearer <API Key>``（``auth/api_keys.py``）；正常登录令牌也认，便于自测。
身份就是 key 所属账号，能看到、能改的是这个账号的草稿。

确认：MCP 没有「弹卡片」的协议。会改内容的工具多一个 ``confirmed`` 参数；第一次调用返回
「需要确认、没有执行」，调用方把说明转给它的用户，用户同意后带 ``confirmed: true`` 再调一次。
"""
from __future__ import annotations

import copy
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from ..auth.api_keys import user_for_mcp
from ..auth.models import User
from .desktop import (BACKGROUND_JOB_NOTE, SWITCH_MODEL_NOTE, WRITING_MODEL_NOTE, CallIn, call_tool,
                      list_tools)
from .prompts import system_prompt

logger = logging.getLogger("agent_engine.mcp")

router = APIRouter(prefix="/v1", tags=["mcp"])

SERVER_INFO = {"name": "jubenpingtai", "title": "剧本平台", "version": "1"}
#: 支持的协议版本，新的在前。客户端要的版本在列表里就照它回，否则回第一个。
PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
#: 这些风险等级的工具可能要确认，schema 里加 ``confirmed`` 参数。
CHANGING = frozenset({"generate", "overwrite", "export", "delete"})

MCP_NOTE = """

# 你通过 MCP 接入了剧本平台
- 能做：大纲、正文、剧本（分镜剧本，文字）、体检精修、改编、去AI味、小说/推文、导出剧本文件。视频不在这里。
- 你的身份是这把 API Key 所属的账号：看到的、改动的都是这个账号的草稿。
- 会改内容的操作（生成、覆盖、删除、导出）可能先返回「需要确认，没有执行」：把返回里的说明原样告诉你的用户，用户同意后带上 confirmed: true、其余参数不变再调一次。用户不同意就照实说没做。
- 草稿 id 是数字（例如 2931）。
""" + WRITING_MODEL_NOTE + SWITCH_MODEL_NOTE + BACKGROUND_JOB_NOTE

# JSON-RPC 错误码
PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS = -32700, -32600, -32601, -32602


def _tool(entry: dict) -> dict:
    """桌面端目录条目 → MCP 工具定义。"""
    schema = copy.deepcopy(entry.get("parameters") or {})
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})
    schema.pop("title", None)
    risk = entry.get("risk") or "read"
    if risk in CHANGING:
        schema["properties"]["confirmed"] = {
            "type": "boolean",
            "description": "用户已同意执行。第一次调用不要带；返回「需要确认」并经用户同意后，带 true 再调一次。",
        }
    out = {"name": entry["name"], "description": entry.get("description") or "", "inputSchema": schema,
           "annotations": {"readOnlyHint": risk == "read",
                           "destructiveHint": risk in ("overwrite", "delete"),
                           "openWorldHint": False}}
    return out


async def _list(user: User) -> dict:
    catalog = await list_tools(user)
    return {"tools": [_tool(e) for e in catalog["tools"]]}


def _text(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)


async def _call(user: User, params: dict) -> dict:
    name = params.get("name")
    if not isinstance(name, str) or not name:
        raise _RpcError(INVALID_PARAMS, "tools/call 缺少 name")
    args = params.get("arguments") or {}
    if not isinstance(args, dict):
        raise _RpcError(INVALID_PARAMS, "arguments 必须是对象")
    args = dict(args)
    confirmed = args.pop("confirmed", False) is True
    try:
        out = await call_tool(CallIn(name=name, args=args, confirmed=confirmed), user)
    except HTTPException as e:
        if e.status_code == 404:
            raise _RpcError(INVALID_PARAMS, f"没有这个工具：{name}") from e
        raise
    if out.get("needs_confirm"):
        text = ("需要用户确认，这一步还没有执行。\n" + str(out.get("message") or "")
                + "\n把上面的说明告诉用户；用户同意后，带 confirmed: true、其余参数不变再调一次。")
        return {"content": [{"type": "text", "text": text}], "isError": False}
    if out.get("ok"):
        body = out.get("result") if "result" in out and len(out) == 2 else out
        return {"content": [{"type": "text", "text": _text(body)}], "isError": False}
    return {"content": [{"type": "text", "text": _text(out.get("error") or out)}], "isError": True}


class _RpcError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def _handle(user: User, msg: Any) -> dict | None:
    """处理一条 JSON-RPC 消息；通知（没有 id）返回 None。"""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
        return {"jsonrpc": "2.0", "id": msg.get("id") if isinstance(msg, dict) else None,
                "error": {"code": INVALID_REQUEST, "message": "不是有效的 JSON-RPC 2.0 请求"}}
    method, mid = msg["method"], msg.get("id")
    is_notification = "id" not in msg
    params = msg.get("params") or {}
    try:
        if method == "initialize":
            wanted = params.get("protocolVersion") if isinstance(params, dict) else None
            version = wanted if wanted in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
            result: dict = {"protocolVersion": version,
                            "capabilities": {"tools": {"listChanged": False}},
                            "serverInfo": SERVER_INFO,
                            "instructions": system_prompt("producer", None) + MCP_NOTE}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = await _list(user)
        elif method == "tools/call":
            result = await _call(user, params if isinstance(params, dict) else {})
        elif method.startswith("notifications/"):
            return None
        else:
            raise _RpcError(METHOD_NOT_FOUND, f"不支持的方法：{method}")
    except _RpcError as e:
        if is_notification:
            return None
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": e.code, "message": e.message}}
    if is_notification:
        return None
    return {"jsonrpc": "2.0", "id": mid, "result": result}


@router.post("/mcp")
async def mcp_post(request: Request, user: User = Depends(user_for_mcp)) -> Response:
    """MCP Streamable HTTP：一个 POST 一条（或一批）JSON-RPC 消息。"""
    try:
        payload = json.loads(await request.body() or b"null")
    except ValueError:
        return JSONResponse({"jsonrpc": "2.0", "id": None,
                             "error": {"code": PARSE_ERROR, "message": "请求体不是 JSON"}}, status_code=400)
    if isinstance(payload, list):
        replies = [r for r in [await _handle(user, m) for m in payload] if r is not None]
        return JSONResponse(replies) if replies else Response(status_code=202)
    reply = await _handle(user, payload)
    if reply is None:
        return Response(status_code=202)
    if isinstance(payload, dict) and payload.get("method") == "tools/call":
        tool = (payload.get("params") or {}).get("name")
        logger.info("mcp call user=%s tool=%s error=%s", user.id, tool,
                    "error" in reply or bool(reply.get("result", {}).get("isError")))
    return JSONResponse(reply)


@router.get("/mcp")
async def mcp_get() -> Response:
    """不提供服务端推送流。"""
    return Response(status_code=405, headers={"Allow": "POST"})


@router.delete("/mcp")
async def mcp_delete() -> Response:
    """无状态，没有会话可关。"""
    return Response(status_code=405, headers={"Allow": "POST"})
