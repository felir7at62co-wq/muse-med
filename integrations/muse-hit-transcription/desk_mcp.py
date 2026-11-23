#!/usr/bin/env python3
"""MCP stdio server that gives cloud Muse Bots the 转写工作台 operations (desk.py) as tools.

Cloud Muse starts it as a DS Bot capability; each tool call is one request on the desk's Unix socket.
"""
import json
import socket
import sys

SOCKET = "/run/muse-transcription-desk/desk.sock"
PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
LIMIT = 256 * 1024
WORK_ID = {"type": "string", "description": "数据站作品编号，形如 hongguo:7550544718799588376。"}

#: name: (desk operation, title, description, input properties, required, read only, timeout seconds)
TOOLS = {
    "reserve_list": (
        "reserve", "查看储备库",
        "列出数据站储备库里排队待转写的剧（按数据站排队顺序）、正在被转写的剧，以及转写工作台手上的剧和各自交给了哪个 Bot。"
        "排队条目只有编号；剧名、集数、热度用 data_station_search 按编号查。",
        {"limit": {"type": "integer", "description": "最多列出几条排队的剧，1–100，默认 15。"}}, [], True, 60),
    "drama_claim": (
        "claim", "领剧并准备原片",
        "从储备库领一部剧交给一个转写 Bot：工作台向数据站占住这部剧，把全集原片放进这部剧的工作区（原片/0001.mp4…），"
        "并把这个 Bot 的工作文件夹设成那里。返回的 state 为 preparing 时原片还在准备（新剧下载可能要几小时），"
        "用 drama_status 看到 ready 再给 Bot 派单。一个 Bot 同时只拿一部剧。",
        {"work_id": WORK_ID, "bot": {"type": "string", "description": "接这部剧的转写 Bot 名字，例如 转写1。"}},
        ["work_id", "bot"], False, 120),
    "drama_status": (
        "status", "查看剧的交付情况",
        "查看工作台上一部剧的状态：原片是否就绪、工作区、哪个 Bot 在做；就绪后逐集检查交付（剧本 episodes/第N集.md、"
        "完整的逐帧审看、语音识别结果、Word final/第N集.docx；缺 qa/第N集-待核.md 或台词与语音识别差距大只作提醒），"
        "列出还没达标的集和缺什么。publishable 为 true 时可以上架。",
        {"work_id": WORK_ID}, ["work_id"], True, 300),
    "drama_publish": (
        "publish", "整剧上架",
        "全剧每集都达标后，把剧本合成一份上架到数据站储备看板，并删除服务器上的原片。有集没达标时拒绝并列出缺什么。",
        {"work_id": WORK_ID}, ["work_id"], False, 300),
    "drama_release": (
        "release", "退回这部剧",
        "做不下去时把这部剧退回数据站，标为待处理并写明原因；工作区和已做好的集保留，之后重新排队能接着做。",
        {"work_id": WORK_ID, "reason": {"type": "string", "description": "退回原因，用户会在储备看板上看到。"}},
        ["work_id", "reason"], False, 120),
}


def line(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"


def text_result(value, error=False):
    return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}], "isError": error}


def call(name, arguments, path=SOCKET):
    operation, _, _, properties, required, read_only, timeout = TOOLS[name]
    if not isinstance(arguments, dict) or set(arguments) - set(properties) or any(key not in arguments for key in required):
        return text_result({"code": "INVALID_ARGUMENTS", "message": f"{name} 需要参数：{'、'.join(required) or '无'}"}, error=True)
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(timeout)
            try:
                conn.connect(path)
            except OSError:
                return text_result({"code": "DESK_UNAVAILABLE", "message": "转写工作台暂时不可用，稍后再试。"}, error=True)
            conn.sendall(line({"operation": operation, "args": arguments}))
            with conn.makefile("rb") as stream:
                raw = stream.readline(LIMIT + 1)
        reply = json.loads(raw)
        if reply.get("ok") is True:
            return text_result(reply["result"])
        return text_result({"code": reply.get("code"), "message": reply.get("message")}, error=True)
    except (OSError, ValueError, AttributeError):
        if read_only:
            return text_result({"code": "DESK_NO_REPLY", "message": "没有读到工作台的回复，稍后再查。"}, error=True)
        return text_result({"code": "DESK_OUTCOME_UNKNOWN", "message": "不确定这次操作是否生效；先用 drama_status 查看再决定是否重试。"}, error=True)


def handle(message, path=SOCKET):
    if not isinstance(message, dict) or "id" not in message:
        return None
    request_id, method, params = message["id"], message.get("method"), message.get("params") or {}
    if method == "initialize":
        asked = params.get("protocolVersion")
        result = {"protocolVersion": asked if asked in PROTOCOLS else PROTOCOLS[0], "capabilities": {"tools": {}},
                  "serverInfo": {"name": "muse-transcription-desk", "version": "1.0.0"}}
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": [{"name": name, "description": description,
                             "inputSchema": {"type": "object", "properties": properties, "required": required, "additionalProperties": False},
                             "annotations": {"title": title, "readOnlyHint": read_only}}
                            for name, (_, title, description, properties, required, read_only, _) in TOOLS.items()]}
    elif method == "tools/call":
        name = params.get("name")
        if name not in TOOLS:
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": "Unknown tool"}}
        result = call(name, params.get("arguments") or {}, path)
    else:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not found"}}
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def serve(source=sys.stdin.buffer, sink=sys.stdout.buffer, path=SOCKET):
    while raw := source.readline(LIMIT + 1):
        try:
            response = handle(json.loads(raw), path)
        except ValueError:
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        if response is not None:
            sink.write(line(response))
            sink.flush()


if __name__ == "__main__":
    serve()
