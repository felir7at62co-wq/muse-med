#!/usr/bin/env python3
"""Import a logged-in Douyin cookie jar into the private DTK identity pool.

The operator types the cookie at a hidden prompt; it travels to the server on
SSH standard input, never in a command line, a file or this script's output.
The identity is stored reserved, so rotation never hands it to unnamed
requests; only requests that name its id use it.
"""
import argparse
import base64
import os
import termios
import http.cookiejar
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

NOTE = "Muse 抖音搜索小号"


def request(opener, base, path, body=None, timeout=30):
    """Send one JSON request to the loopback DTK API.

    @param opener urllib opener carrying the administrator session cookie.
    @param base API origin, for example ``http://127.0.0.1:19580``.
    @param path API path beginning with ``/``.
    @param body JSON body for POST, or None for GET.
    @returns ``(status, parsed JSON or None)``.
    """
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method="GET" if body is None else "POST")
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw) if raw else None
        except ValueError:
            return error.code, None


def error_text(result):
    """Return the API error code and message without echoing request content."""
    if isinstance(result, dict) and isinstance(result.get("error"), dict):
        error = result["error"]
        return f"{error.get('code')}: {error.get('message')}"
    return "no error body"


def server_import(payload, admin_file, base):
    """Validate, store and check one identity on the server; print only non-secret facts.

    @param payload ``{"cookies", "user_agent", "note"}`` read from standard input.
    @param admin_file Path of the private administrator credential file.
    @param base Loopback API origin.
    @returns Process exit status.
    """
    credentials = json.loads(Path(admin_file).read_text())
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    status, result = request(opener, base, "/api/v1/auth/login", {"username": credentials["username"], "password": credentials["password"]})
    if status != 200:
        print(f"管理员登录失败：HTTP {status}", file=sys.stderr)
        return 1
    body = {"platform": "douyin", "cookies": payload["cookies"], "user_agent": payload["user_agent"], "note": payload["note"], "reserved": True, "dry_run": True}
    status, result = request(opener, base, "/api/v1/admin/identities/import", body)
    if status != 200:
        print(f"预检失败：HTTP {status} {error_text(result)}", file=sys.stderr)
        return 1
    report = result["data"]["report"]
    print(f"格式：{report['detected_format']}；平台：{report['detected_platform']}；浏览器：{report['browser_family']} {report['browser_major']}")
    print(f"带登录态：{'是' if report['authenticated'] else '否'}；登录过期时间：{report['expires_at'] or '未知'}")
    if report["missing_required"]:
        print(f"缺少必需 cookie：{', '.join(report['missing_required'])}")
    for code in report["warning_codes"]:
        print(f"提示：{code}")
    if not report["usable"]:
        print("这份 cookie 不能用作身份，没有保存。", file=sys.stderr)
        return 1
    if not report["authenticated"]:
        print("这份 cookie 没有登录态（缺 sessionid 等），没有保存。请确认小号已在这个浏览器登录抖音。", file=sys.stderr)
        return 1
    body["dry_run"] = False
    status, result = request(opener, base, "/api/v1/admin/identities/import", body)
    if status != 201:
        print(f"保存失败：HTTP {status} {error_text(result)}", file=sys.stderr)
        return 1
    identity_id = result["data"]["identity_id"]
    print(f"已保存，身份 ID：{identity_id}（只服务点名它的请求，不参与轮换）")
    status, result = request(opener, base, f"/api/v1/admin/identities/{identity_id}/session", {})
    if status != 202:
        print(f"登录检查没有排上队：HTTP {status} {error_text(result)}")
        return 0
    task_id = result["data"]["task_id"]
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        time.sleep(3)
        status, result = request(opener, base, f"/api/v1/tasks/{task_id}")
        task = result.get("data") if isinstance(result, dict) else None
        if not isinstance(task, dict) or task.get("state") in ("queued", "running"):
            continue
        if task.get("state") == "done":
            check = task.get("data") or {}
            print(f"登录检查：{check.get('reason')}；平台账号：{check.get('account_id') or '未给出'}")
        else:
            print(f"登录检查失败：{(task.get('error') or {}).get('code')}")
        return 0
    print("登录检查 90 秒内没有结果，稍后可在控制台查看。")
    return 0


def read_hidden(prompt):
    """Read one line without echo, in non-canonical mode.

    A terminal in canonical mode holds at most 4095 bytes per line, and a
    logged-in Douyin cookie is longer, so getpass() silently loses it.
    """
    print(prompt, end="", flush=True)
    if not sys.stdin.isatty():
        return sys.stdin.readline().strip()
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    changed = termios.tcgetattr(fd)
    changed[3] &= ~(termios.ICANON | termios.ECHO)
    changed[6][termios.VMIN], changed[6][termios.VTIME] = 1, 0
    data = b""
    try:
        termios.tcsetattr(fd, termios.TCSADRAIN, changed)
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            data += chunk.replace(b"\x1b[200~", b"").replace(b"\x1b[201~", b"")
            if b"\n" in data or b"\r" in data:
                break
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        print()
    return data.decode("utf-8", "replace").replace("\r", "\n").split("\n")[0].strip()


def remote_entry():
    """Run on the server: read the payload JSON from standard input."""
    payload = json.loads(sys.stdin.read())
    sys.exit(server_import(payload, payload.pop("admin_file"), payload.pop("base")))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--ssh", default="root@100.123.97.104", help="SSH target of the DTK host.")
    parser.add_argument("--ssh-key", type=Path, default=Path.home() / ".ssh/muse-cloud-tailscale")
    parser.add_argument("--admin-file", default="/etc/muse/dtk-admin.json")
    parser.add_argument("--base", default="http://127.0.0.1:19580")
    parser.add_argument("--note", default=NOTE)
    args = parser.parse_args()
    print("在登录了小号的浏览器里打开 www.douyin.com，F12 → 网络 → 刷新 → 点任意一个发往 www.douyin.com 的请求 → 请求标头。")
    hint = "没收到粘贴内容。这个终端里 Ctrl+V 不是粘贴：请用 Ctrl+Shift+V，或右键 → 粘贴（Mac 上用 Cmd+V）。"
    while True:
        cookies = read_hidden("粘贴 cookie 那一行的值（输入不会显示，粘贴后回车）：")
        if cookies.lower().startswith("cookie:"):
            cookies = cookies[7:].strip()
        if len(cookies) >= 100 and cookies.isprintable() and "=" in cookies:
            break
        print(hint)
    print(f"已收到 cookie，共 {len(cookies)} 个字符。")
    while True:
        user_agent = read_hidden("粘贴同一个请求里 user-agent 的值（同样不显示）：")
        if user_agent.lower().startswith("user-agent:"):
            user_agent = user_agent[11:].strip()
        if user_agent.startswith("Mozilla/") and user_agent.isprintable():
            break
        print(hint)
    print(f"已收到 user-agent：{user_agent}")
    payload = {"cookies": cookies, "user_agent": user_agent, "note": args.note, "admin_file": args.admin_file, "base": args.base}
    source = Path(__file__).read_text()
    code = base64.b64encode((source + "\nremote_entry()\n").encode()).decode()
    command = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-i", str(args.ssh_key), args.ssh,
               f"python3 -c \"import base64;exec(compile(base64.b64decode('{code}'),'import-identity','exec'),{{'__name__':'remote'}})\""]
    return subprocess.run(command, input=json.dumps(payload), text=True).returncode


if __name__ == "__main__":
    sys.exit(main())
