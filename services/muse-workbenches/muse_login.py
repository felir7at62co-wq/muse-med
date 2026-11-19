"""Muse sign-in for the archived Script Workshop and Jingliu FastAPI applications."""
import asyncio
import base64
import hashlib
import html
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel

TOKEN = re.compile(r"[a-zA-Z0-9_-]{43}")
NO_STORE = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}


def origin(value, desktop=False):
    parts = urlsplit(value)
    local = parts.scheme == "http" and parts.hostname in {"localhost", "127.0.0.1", "::1"}
    native = desktop and parts.scheme == "dsh-app" and parts.hostname == "app"
    if (not parts.hostname or parts.username or parts.password or parts.path or parts.query or parts.fragment
            or value != f"{parts.scheme}://{parts.netloc}" or not (local or native or parts.scheme == "https")):
        raise ValueError("Expected an HTTPS origin or a loopback development origin")
    return value


def digest(value):
    return hashlib.sha256(value.encode("ascii")).digest()


def read_bindings(path, issuer, audience):
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate Muse workbench binding")
            result[key] = value
        return result

    data = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_pairs)
    users = data.get("users") if isinstance(data, dict) else None
    if (not isinstance(users, dict) or data.get("issuer") != issuer
            or any(not sub.strip() or type(owner) is not int or owner <= 0 for sub, owner in users.items())
            or len(set(users.values())) != len(users)):
        raise ValueError("Invalid Muse workbench bindings")
    roles = data.get("jingliuRoles", {})
    if (data.keys() - {"issuer", "users", "jingliuRoles"} or not isinstance(roles, dict)
            or (audience != "jingliu" and "jingliuRoles" in data) or roles.keys() - users.keys()
            or any(role not in ("user", "admin", "superadmin") for role in roles.values())):
        raise ValueError("Invalid Muse workbench role confirmation")
    return users, roles


class Requests:
    """Store confidential PKCE verifiers across callbacks, HTTP workers and process restarts."""

    def __init__(self, path):
        self.path = path
        fd = os.open(path, os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(fd)
        with closing(sqlite3.connect(path)) as db:
            db.execute("CREATE TABLE IF NOT EXISTS pending (id BLOB PRIMARY KEY, verifier TEXT, expiry INTEGER)")

    def create(self, seconds):
        key, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        now = int(time.time())
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM pending WHERE expiry <= ?", (now,))
            if db.execute("SELECT COUNT(*) FROM pending").fetchone()[0] >= 1024:
                raise HTTPException(429, "登录请求较多，请稍后再试")
            db.execute("INSERT INTO pending VALUES (?, ?, ?)", (digest(key), verifier, now + seconds))
        challenge = base64.urlsafe_b64encode(digest(verifier)).decode().rstrip("=")
        return {"requestId": key, "challenge": challenge}

    def consume(self, key):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            record = db.execute("SELECT verifier, expiry FROM pending WHERE id = ?", (digest(key),)).fetchone()
            db.execute("DELETE FROM pending WHERE id = ?", (digest(key),))
        if not record or record[1] <= int(time.time()):
            raise HTTPException(410, "登录请求已失效，请重新登录")
        return record[0]


async def issue_native_session(audience, owner, native_role):
    """Sign in to the original, explicitly linked workbench account."""
    if audience == "script-workshop":
        from .auth.models import User
        from .auth.routes import _login_payload
        from .db import session_scope
        async with session_scope() as db:
            user = await db.get(User, owner)
            if user is None or user.status != "active":
                raise HTTPException(403, "关联的工坊账号不可用")
            return _login_payload(user)
    return await asyncio.to_thread(issue_jingliu_session, owner, native_role)


def issue_jingliu_session(owner, native_role):
    from .auth import KnownUser, _issue_session, effective_role
    from .db import get_session
    with get_session() as db:
        user = db.get(KnownUser, owner)
        if user is None:
            raise HTTPException(403, "关联的镜流账号不存在")
        # Cached roles combine upstream privileges and local overrides. Resolve discrepancies before writing.
        if native_role is None and effective_role(owner, "user") != user.role:
            raise HTTPException(403, "镜流账号角色待管理员确认，请核对工作台账号绑定")
        profile = {"id": owner, "username": user.username, "display_name": user.display_name,
                   "role": native_role or "user"}
    return _issue_session(profile)


class Exchange(BaseModel):
    requestId: str
    code: str


def configure_muse_login(app: FastAPI, audience: str):
    if audience not in {"jingliu", "script-workshop"}:
        raise ValueError("Unknown Muse workbench audience")
    from .config import get_settings
    settings = get_settings()
    studio = audience == "jingliu"
    if studio and not settings.auth_upstream:
        raise ValueError("FW_AUTH_UPSTREAM must enable Jingliu project authentication")
    if not studio and not settings.auth_required:
        raise ValueError("AUTH_REQUIRED must enable Script Workshop authentication")
    if not studio and (len(os.environ.get("JWT_SECRET", "")) < 32
                       or os.environ["JWT_SECRET"].startswith("drama-dev-secret")):
        raise ValueError("Set a private Script Workshop JWT_SECRET before enabling Muse sign-in")
    prefix = "/v2/auth/muse" if studio else "/v1/auth/muse"
    public_prefix = ("/fwp" if studio else "") + prefix
    issuer = origin(os.environ["MUSE_WORKBENCH_ISSUER"])
    public_origin = origin(os.environ["MUSE_WORKBENCH_PUBLIC_ORIGIN"])
    parent = os.environ.get("MUSE_WORKBENCH_PARENT_ORIGIN", "")
    if parent:
        origin(parent, desktop=True)
    secret = os.environ["MUSE_WORKBENCH_SECRET"]
    if not re.fullmatch(r"[A-Za-z0-9._~-]{32,256}", secret):
        raise ValueError("Invalid MUSE_WORKBENCH_SECRET")
    bindings = Path(os.environ["MUSE_WORKBENCH_BINDINGS"])
    read_bindings(bindings, issuer, audience)
    pending = Requests(os.environ["MUSE_WORKBENCH_STATE_DB"])
    router = APIRouter(prefix=prefix)
    script = Path(__file__).with_name("muse_login.js").read_text(encoding="utf-8")
    storage_script = Path(__file__).with_name("muse_storage.js").read_text(encoding="utf-8")

    async def gateway(operation, **fields):
        try:
            async with httpx.AsyncClient(follow_redirects=False, trust_env=False, timeout=10) as client:
                response = await client.post(f"{issuer}/api/workbench-login/{operation}",
                                             headers={"Authorization": f"Bearer {secret}"},
                                             json={"audience": audience, **fields})
        except httpx.RequestError:
            raise HTTPException(503, "暂时无法连接 Muse 账号服务") from None
        if response.status_code != 200:
            if response.status_code == 410:
                raise HTTPException(410, "Muse 授权已失效，请重新登录")
            if response.status_code == 429:
                raise HTTPException(429, "登录请求较多，请稍后再试")
            raise HTTPException(502, "Muse 账号服务未能完成授权")
        try:
            value = response.json()
        except ValueError:
            value = None
        if not isinstance(value, dict):
            raise HTTPException(502, "Muse 账号服务响应无效")
        return value

    # Close every legacy interactive sign-in / account-claim path, including on lazy router versions.
    old_prefix = prefix.removesuffix("/muse") + "/"
    @app.middleware("http")
    async def require_muse_signin(request, call_next):
        path = request.url.path.rstrip("/")
        if (path.startswith(old_prefix + "feishu/") or path in {old_prefix + "login", old_prefix + "register"}):
            return JSONResponse({"detail": "请使用 Muse 账号登录"}, status_code=410, headers=NO_STORE)
        if path.startswith(prefix + "/") and request.method == "POST":
            if request.headers.get("origin", public_origin) != public_origin:
                return JSONResponse({"detail": "登录来源不匹配"}, status_code=403, headers=NO_STORE)
        return await call_next(request)

    if os.environ.get("MUSE_WORKBENCH_SHARED_HOST") == "1":
        @router.post("/internal-session", include_in_schema=False)
        async def internal_session(request: Request):
            """Issue a native session for the subject verified by the local shared-host gateway."""
            supplied = request.headers.get("authorization", "")
            if not secrets.compare_digest(supplied.encode(), ("Bearer " + secret).encode()):
                raise HTTPException(403, "工作台身份无效")
            payload = await request.json()
            subject = payload.get("sub") if isinstance(payload, dict) else None
            accounts, roles = await asyncio.to_thread(read_bindings, bindings, issuer, audience)
            if not isinstance(subject, str) or subject not in accounts:
                raise HTTPException(403, "此 Muse 账号尚未开通工作台")
            session = await issue_native_session(audience, accounts[subject], roles.get(subject))
            return JSONResponse(session, headers=NO_STORE)

    @router.post("/challenge")
    def challenge():
        return JSONResponse(pending.create(120), headers=NO_STORE)

    @router.post("/browser/start")
    async def start(request: Request):
        if request.headers.get("origin") != public_origin:
            raise HTTPException(403, "请在工作台登录")
        attempt = await asyncio.to_thread(pending.create, 300)
        state = secrets.token_urlsafe(32)
        try:
            reply = await gateway("start", state=state, challenge=attempt["challenge"])
            url = reply.get("authorizeUrl")
            if not isinstance(url, str) or not url.startswith(issuer + "/"):
                raise HTTPException(502, "Muse 授权地址无效")
        except Exception:
            await asyncio.to_thread(pending.consume, attempt["requestId"])
            raise
        return JSONResponse({"requestId": attempt["requestId"], "state": state, "authorizeUrl": url}, headers=NO_STORE)

    @router.post("/exchange")
    async def exchange(data: Exchange):
        if not TOKEN.fullmatch(data.requestId) or not TOKEN.fullmatch(data.code):
            raise HTTPException(400, "登录请求格式有误")
        verifier = await asyncio.to_thread(pending.consume, data.requestId)
        identity = await gateway("redeem", code=data.code, verifier=verifier)
        if identity.get("issuer") != issuer or not isinstance(identity.get("sub"), str):
            raise HTTPException(403, "Muse 身份无法验证")
        accounts, roles = await asyncio.to_thread(read_bindings, bindings, issuer, audience)
        owner = accounts.get(identity["sub"])
        if owner is None:
            raise HTTPException(403, "此 Muse 账号尚未关联工作台账号，请联系管理员")
        payload = await issue_native_session(audience, owner, roles.get(identity["sub"]))
        return JSONResponse(payload, headers=NO_STORE)

    @router.get("/login.js")
    def javascript():
        return Response(script, media_type="text/javascript", headers=NO_STORE)

    @router.get("/storage.js")
    def embedded_storage():
        return Response(storage_script, media_type="text/javascript", headers=NO_STORE)

    @router.get("/embed")
    @router.get("/login")
    @router.get("/callback")
    def page():
        title = "镜流" if studio else "剧本工坊"
        policy = ("default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; "
                  "base-uri 'none'; form-action 'none'; frame-ancestors " + (parent or "'none'"))
        content = f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{title} · Muse 登录</title>
<style>html{{color-scheme:light dark;font:16px system-ui}}body{{min-height:94vh;display:grid;place-items:center;margin:0}}
main{{max-width:24rem;padding:24px}}button{{font:inherit;padding:.55rem 1.2rem;cursor:pointer}}p:empty{{display:none}}</style>
<main data-audience="{audience}" data-prefix="{public_prefix}" data-parent="{html.escape(parent, quote=True)}">
<h1>{title}</h1><button id="login" type="button">使用 Muse 账号登录</button><p id="message" role="status"></p></main>
<script src="{public_prefix}/storage.js"></script><script src="{public_prefix}/login.js" defer></script></html>"""
        return HTMLResponse(content, headers={**NO_STORE, "Content-Security-Policy": policy})

    app.include_router(router)
