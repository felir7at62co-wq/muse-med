"""登录认证（复用主平台用户体系，需求定稿 11.2）。

架构：FW 不建用户表、不碰密码哈希——身份一律来自主平台
（dev=drama-dev:8001；未来上线 prod 改 FW_AUTH_UPSTREAM 即可，用户数据自动对应）。
校验成功后 FW 自签会话 token 落 SQLite（重启不丢），中间件按会话校验。

启用开关：FW_AUTH_UPSTREAM 设置即启用登录；不设置保持开放（dev 默认）。
放行清单（防"无法登录→无法更新"死循环）：/health、/v2/auth/*、/v2/app/latest、/media 静态。

## 登录方式：只有飞书扫码（2026-08 起）

账号密码登录已**移除**（前端入口与后端接口一并删除），与剧本平台看齐。
织影没有生产环境，不存在存量用户迁移问题。

⚠️ 已装 v0.7.6 及更早版本的客户端只会调 `POST /v2/auth/login`，
该接口删除后它们会登录失败——这是用户明确确认过的取舍（"立刻删掉"）。
旧客户端仍可用登录页右下角的「⟳ 检查更新」升级到新版（那是刻意保留的逃生门）。

## 桌面端飞书登录为什么要绕一圈

飞书只认**已登记**的重定向 URL，而桌面应用没有 URL 可以接住回调。
所以链路是：

    桌面端 → POST /v2/auth/feishu/start        取 authorize_url + ticket
           → 用系统浏览器打开 authorize_url     用户扫码
    飞书   → GET  /v2/auth/feishu/callback     （已在飞书后台登记本地址）
           → 织影后端拿 code 去上游换身份 → 签发会话 → 存进 ticket
    桌面端 → GET  /v2/auth/feishu/poll         轮询取回会话 token

**凭据不落织影**：换 code 需要 app_secret，织影不复制它，而是把 code 交给上游
`/v1/auth/feishu/callback`（以非浏览器身份调用，它会返回 JSON）。
密钥只存在剧本平台一处，轮换时不必两边改，也少一处泄露面。

## 票据为什么要配一个 claim_secret（2026-09-11 修 S2）

上面这条链路里，**受害者扫的二维码只认 state，而 ticket 就编在 state 里**。
于是原实现有一条不需要猜任何随机串的劫持路径：

    攻击者自己 POST /feishu/start  → 拿到 {ticket, authorize_url}
    把 authorize_url 发给受害者   → 受害者扫码、授权（他看到的一切都是真的）
    飞书回调                      → **受害者的会话被投进攻击者手里的那张 ticket**
    攻击者 GET /feishu/poll       → 取走令牌，以受害者身份访问全部项目

病根是"谁发起的"和"谁能取走"之间没有任何绑定 —— poll 只要 ticket，而 ticket
必然要经过受害者的浏览器。修法是再发一个**只回给发起方、绝不进 state**
的随机串 `claim_secret`：受害者链路里全程不出现它，poll 必须同时出示
ticket + claim_secret。攻击者仍能让受害者扫码，但取不走结果。

`claim_secret` 走 **`X-FW-Claim` 请求头**而不是 query —— query 会进 nginx
access log，而 ticket 本来就在 query 里，两个都落日志的话拿到日志就等于
拿到会话，这道锁就白加了。
"""
from __future__ import annotations

import hashlib
import logging
import secrets
import time
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel
import json as _json

from sqlalchemy import String, Text
from sqlalchemy.orm import Mapped, mapped_column
from urllib.parse import quote

from .config import get_settings
from .db import Base, get_session
from .providers import http

log = logging.getLogger(__name__)

SESSION_TTL = timedelta(days=7)

#: 桌面端取号票据的存活时间。
#:
#: ⚠️ 2026-11-10 从 600 秒（10 分钟）提到 30 分钟。10 分钟不是"够不够用"的
#:    问题，而是和前端的等待窗口自相矛盾：
#:      · 网页端登录框轮询 **5 分钟**（`for (let i = 0; i < 150; i++)`，每 2 秒一次）；
#:      · 桌面端同样在这个量级上等用户扫码。
#:    也就是说用户完全可能合法地花到 6–9 分钟才扫完（找手机、切窗口、网络慢），
#:    而票据在第 10 分钟就被 `_gc_tickets` 清掉了。此后回调进来查不到票据，
#:    直接落到「登录已超时 / 这次登录请求已过期（超过 10 分钟）」——
#:    用户明明刚扫完码，却被判成超时。
#:
#:    留 30 分钟是给足余量：真正的上限是前端的等待窗口（5 分钟），票据只需要
#:    比它长，多出来的部分是防止"扫完码的那一刻恰好被清理"的竞态。
#:    清理仍然在每次 start / poll / callback 时顺带做，不会积压。
_TICKET_TTL = 1800.0


class LoginTicket(Base):
    """飞书登录票据持久化表。

    替代原先的进程内 `_TICKETS` 字典——后端重启后票据不丢失，
    用户扫码完成时回调仍能找到对应票据。

    `result` 列存 JSON 字符串（登录成功后写入），None 表示尚未扫码完成。
    `claim`  列是只返回给发起方的取号密钥（S2 防劫持，不进 state/URL）。
    `ip`     列是发起时的调用方 IP（纵深信号，不是唯一防线）。
    """

    __tablename__ = "login_tickets"

    ticket: Mapped[str] = mapped_column(String(64), primary_key=True)
    created: Mapped[float] = mapped_column()          # Unix epoch（float）
    claim: Mapped[str] = mapped_column(String(64))
    ip: Mapped[str] = mapped_column(String(64), default="")
    result: Mapped[str | None] = mapped_column(Text, nullable=True, default=None)


# ---------------------------------------------------------------------------
# 内部辅助：把 DB 行转成旧代码兼容的 dict 格式
# ---------------------------------------------------------------------------

def _row_to_item(row: LoginTicket) -> dict:
    return {
        "created": row.created,
        "claim": row.claim,
        "ip": row.ip,
        "result": _json.loads(row.result) if row.result is not None else None,
    }


def _gc_tickets() -> None:
    """清掉过期票据，防数据库无界增长。"""
    cutoff = time.time() - _TICKET_TTL
    with get_session() as session:
        session.query(LoginTicket).filter(LoginTicket.created < cutoff).delete()
        session.commit()


def _client_ip(request: Request) -> str:
    """取调用方 IP（票据绑定用的纵深信号）。

    nginx 的 `/fw/` 块写的是 `proxy_set_header X-Real-IP $remote_addr` ——
    **覆盖**而非追加，所以经 nginx 进来的请求这个头不可被客户端伪造。
    直连 8002 的（只有本机可达）落到 `request.client`。

    ⚠️ 只用来比"start 与 poll 是否同一来源"，**不作为唯一防线** ——
    真正拦住劫持的是 `claim_secret`。桌面端与系统浏览器是两个进程，
    出口 IP 通常一致但 UA 必然不同，所以**只比 IP，不比 UA**。
    """
    xr = (request.headers.get("X-Real-IP") or "").strip()
    if xr:
        return xr
    xff = (request.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
    if xff:
        return xff
    return (request.client.host if request.client else "") or ""


def _same_client_net(a: str, b: str) -> bool:
    """两个 IP 是否属于同一个客户端网段（IPv4 比 /24，IPv6 比 /64）。

    用途见 `feishu_poll` 的 IP 纵深那一段。判据刻意宽松到"同一小区/同一运营商
    NAT 池"这个粒度，而不是精确 IP：

      · 精确相等会把移动网络用户挡在门外 —— 实测同一人 4 分钟内出口从
        `203.0.113.10` 变成 `203.0.113.11`（运营商轮换），
        登录成功却在取号时被拒。
      · 放宽到 /24 仍然拦得住"换了网络/换了地方"这类真正的来源变化。

    解析不出来（非 IP、IPv6 混合等）时**按不匹配处理**：宁可让用户重扫一次，
    也不要在判不清的情况放行。
    """
    import ipaddress
    try:
        ia, ib = ipaddress.ip_address(a), ipaddress.ip_address(b)
    except ValueError:
        return False
    if ia.version != ib.version:
        return False
    if ia.version == 4:
        # /24：如 203.0.113.0/24
        return (int(ia) >> 8) == (int(ib) >> 8)
    # /64：一个 IPv6 用户通常整段都是他的
    return (int(ia) >> 64) == (int(ib) >> 64)


def _hash_token(token: str) -> str:
    """会话 token 的落库形态：sha256 十六进制（64 字符）。

    为什么不明文存（S3 的无争议项）：库文件、备份、任何一次误贴的 SELECT
    结果都等于一批可直接使用的 7 天有效会话。哈希后库里那串**不能**当令牌用，
    而校验只需把来访 token 哈希一次再查主键，成本与明文查完全一样。

    不加盐、不用 PBKDF2 是刻意的：token 本身是 `token_urlsafe(32)`（256 bit
    真随机），不存在字典/彩虹表攻击面，慢哈希只会给每个请求凭空加延迟。
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class AuthSession(Base):
    """FW 会话：token 随机生成，与主平台 JWT 解耦（不共享对方密钥）。

    ⚠️ `token` 列存的是 **sha256 十六进制摘要**，不是令牌本身（见 `_hash_token`）。
    所以这张表里的任何一行都**不能**被拿去当凭据用；反过来，也无法从库里
    捞回某个用户的 token（只能吊销）。
    """

    __tablename__ = "auth_sessions"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column()
    username: Mapped[str] = mapped_column(String(64))
    display_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    role: Mapped[str] = mapped_column(String(16), default="user")
    expires_at: Mapped[str] = mapped_column(String(32))  # ISO UTC


class KnownUser(Base):
    """登录过本服务的用户名录（每人一行，**不随会话过期删除**）。

    ## 为什么要有它（2026-10-15，生产上线前补）

    项目转交按用户名找人，此前唯一的来源是 `auth_sessions`——而会话过期会被
    启动时的 `cleanup_expired_sessions` 删掉。于是一个两周前登录过的作者，
    会话一过期就**再也按名字找不到**，管理员要把他的项目还给他只能干等他再登录。
    生产当时有 38 个无主项目等着逐个转交，这条依赖不能留。

    本服务没有自己的用户表（用户在上游主平台），这里只记"见过谁"，不是权威名单：
    没登录过的人仍然找不到（让他先登录一次即可）。
    """

    __tablename__ = "known_users"

    user_id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64))
    display_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    role: Mapped[str] = mapped_column(String(16), default="user")
    last_login_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    #: 飞书统一身份。飞书审批接口按它返回发起人，镜流据此把审批单对到账号
    #: （见 approval_sync）。上游登录响应 2026-10-15 起才带这个字段，老记录为 NULL，
    #: 下次登录自动补上。
    feishu_union_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    #: 租户内的飞书 user_id（如 `316462eg`）。**飞书审批接口返回的是这个**，不是 union_id，
    #: 只能靠通讯录接口换算。记下来就不用每次刷新（每个人都）去查通讯录——
    #: 不记的话，审批接口给了个 ID 空间不同的值，会让所有审批单都"对不上账号"转人工。
    feishu_user_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)


def _local_admin_ids() -> set[int]:
    raw = getattr(get_settings(), "admin_user_ids", "") or ""
    out: set[int] = set()
    for part in raw.replace("，", ",").split(","):
        part = part.strip()
        if part.isdigit():
            out.add(int(part))
    return out


def effective_role(user_id: int | None, upstream_role: str | None) -> str:
    """本服务里实际生效的角色：上游角色，叠加 `admin_user_ids` 本地提权（只升不降）。

    ⚠️ 必须写进**会话行**而不只在内存里套用：积分模块（budget._platform_admin_ids）、
    用户名录等好几处直接读 `auth_sessions.role`，只改请求上下文的话，
    "转交里他是管理员、积分页里他又不是"——同一个人两种身份。
    """
    role = upstream_role or "user"
    if user_id and int(user_id) in _local_admin_ids() and role not in ("admin", "superadmin"):
        return "admin"
    return role


def apply_admin_overrides() -> int:
    """启动时把名单里的人的**现存会话与名录**改成 admin，免得要等他重新登录。"""
    ids = _local_admin_ids()
    if not ids:
        return 0
    n = 0
    with get_session() as session:
        for row in (list(session.query(AuthSession).filter(AuthSession.user_id.in_(ids)).all())
                    + list(session.query(KnownUser).filter(KnownUser.user_id.in_(ids)).all())):
            r = effective_role(row.user_id, row.role)
            if r != row.role:
                row.role = r
                n += 1
        session.commit()
    return n


def _remember_user(session, user_id: int, username: str, display_name: str | None,
                   role: str, seen_at: str, union_id: str | None = None) -> None:
    """upsert 一条用户名录。只往"更新"的方向写：老记录不覆盖新记录。"""
    if not user_id:
        return
    k = session.get(KnownUser, user_id)
    if k is None:
        session.add(KnownUser(user_id=user_id, username=username or "",
                              display_name=display_name, role=role or "user",
                              last_login_at=seen_at, feishu_union_id=union_id or None))
    elif (k.last_login_at or "") <= (seen_at or ""):
        k.username = username or k.username
        k.display_name = display_name or k.display_name
        k.role = role or k.role
        k.last_login_at = seen_at
        if union_id:
            k.feishu_union_id = union_id


def seed_known_users() -> int:
    """把现存会话里的用户补进名录。**必须在清理过期会话之前调用**——
    否则这次重启就会把还没进名录的人（多半是上线前登录的那批）一起抹掉。"""
    n = 0
    with get_session() as session:
        for s in session.query(AuthSession).all():
            before = session.get(KnownUser, s.user_id)
            # 会话没有登录时刻，用"到期时刻 − 有效期"近似；只用于排序与择新
            try:
                seen = (datetime.fromisoformat(s.expires_at) - SESSION_TTL
                        ).isoformat(timespec="seconds")
            except (TypeError, ValueError):
                seen = ""
            _remember_user(session, s.user_id, s.username, s.display_name, s.role, seen)
            n += before is None
        session.commit()
    return n


router = APIRouter(prefix="/v2/auth", tags=["auth"])


def _upstream() -> str:
    up = (get_settings().auth_upstream or "").rstrip("/")
    if not up:
        raise HTTPException(status_code=400,
                            detail="后端未启用登录（FW_AUTH_UPSTREAM 未配置）")
    return up


def _shown_name(user: dict) -> str | None:
    """本服务里显示的名字：**飞书真实姓名优先**，其次上游昵称。

    ## 为什么不能直接用上游的 display_name（2026-10-15 用户问"为什么有 123 / == / Zed"）

    剧变时代平台每个用户有三个名字：`username`（账号）、`display_name`（自填昵称）、
    `feishu_name`（飞书真实姓名）。扫码**新建**的号三者都是飞书名，看着正常；
    但**先用账号密码注册、后来才绑飞书**的老号，绑定时平台只补 `feishu_name`，
    账号与昵称保持原样——于是出现「123456789 / ==」「张三 / Zed」「剧变时代」。
    本服务此前只取 username + display_name，`feishu_name` 一次都没读过。

    username 不动：它是账号、唯一，按名字转交项目仍可以用它找人。
    """
    fs = (user.get("feishu_name") or "").strip()
    if fs and fs != "飞书用户":          # 上游拿不到飞书名时的占位，不当真名用
        return fs
    return user.get("display_name")


def _issue_session(user: dict) -> dict:
    """按上游返回的用户信息签发 FW 会话。登录链路的唯一签发口。

    明文 token 只在本函数的返回值里出现一次（交给调用方发给客户端），
    库里落的是它的 sha256（见 `_hash_token`）。
    """
    if (user.get("status") or "active") != "active":
        raise HTTPException(status_code=403, detail="账号已被禁用，请联系管理员")
    # 飞书身份缺口必须看得见（2026-10-17）：机器人私信（积分通知/更新公告）按它寻址。
    # 剧本平台 f13c0ee 之前的版本不在用户信息里带 feishu_union_id，生产因此 74 个账号
    # 全部为空、通知全被跳过，却没有任何报错。"绑定了飞书却没给身份"就记一笔，
    # 补救见 scripts/backfill_feishu_union.py。
    if user.get("feishu_bound") and not (user.get("feishu_union_id") or "").strip():
        log.warning("[auth] 用户 %s 已绑定飞书，但认证服务没返回 feishu_union_id"
                    "（剧本平台版本过旧？）——飞书通知将发不到此人", user.get("id"))
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + SESSION_TTL
    with get_session() as session:
        session.add(AuthSession(
            token=_hash_token(token), user_id=int(user.get("id") or 0),
            username=user.get("username") or "",
            display_name=_shown_name(user),
            role=effective_role(user.get("id"), user.get("role")),
            expires_at=expires.isoformat(timespec="seconds"),
        ))
        _remember_user(session, int(user.get("id") or 0), user.get("username") or "",
                       _shown_name(user), effective_role(user.get("id"), user.get("role")),
                       datetime.now(timezone.utc).isoformat(timespec="seconds"),
                       union_id=(user.get("feishu_union_id") or "").strip() or None)
        session.commit()
    return {
        "token": token,
        "expires_at": expires.isoformat(timespec="seconds"),
        "user": {"id": user.get("id"), "username": user.get("username"),
                 "display_name": _shown_name(user),
                 "role": effective_role(user.get("id"), user.get("role"))},
    }


def _callback_url() -> str:
    """本服务的飞书回调地址，必须与飞书后台登记的**完全一致**。

    用户已在飞书后台登记：
        http://118.196.33.51:9080/fw/v2/auth/feishu/callback
    """
    base = (get_settings().feishu_callback_base or "").rstrip("/")
    return f"{base}/v2/auth/feishu/callback"


@router.post("/feishu/start")
async def feishu_start(request: Request, mode: str = "desktop") -> dict:
    """发起飞书登录：向上游取授权 URL，并签发一张取号票据。

    `redirect_uri` 传的是**织影自己的** callback——上游 `login-url` 支持覆盖，
    而 state 仍由上游签发，回调时它自己能校验通过。

    ⚠️ 关键：飞书回调时只会带 `code` 和 `state`（OAuth2 标准参数），
    不可能带我们自己加的 `ticket`。所以把 ticket **编码进 state** 一起签发，
    回调时从 state 解出来。格式：`{上游state}.{mode标记}{ticket}`。

    ⚠️ 正因为 ticket 必然经过**扫码那个人**的浏览器，它不能是取号的唯一凭据。
    桌面端模式额外返回 `claim_secret`：它只出现在本次响应里，**不进 state、
    不进授权 URL**，`poll` 必须用 `X-FW-Claim` 头带上它（详见模块 docstring）。
    网页端不返回 —— 它压根不走 poll（见 `_finish`），多发一个密钥只是多一处泄露面。

    `mode` 决定回调怎么收尾（两种客户端的形态完全不同）：
      desktop — 浏览器与应用是**两个窗口**，回调只能显示一张"可以回去了"的
                落地页，会话投进 ticket 等桌面端轮询取走
      web     — 授权前后是**同一个标签页**，回调应当直接 302 回应用并带上会话，
                用户眼里就是"扫完码就进来了"。多一张落地页纯属打断
    """
    _gc_tickets()
    up = _upstream()
    is_web = mode == "web"
    # 票据带 mode 前缀：飞书只回传 state，回调时得从里面认出客户端形态
    ticket = ("w-" if is_web else "d-") + secrets.token_urlsafe(24)
    # 取号密钥：与 ticket 同强度，但**只回给本次调用方**，绝不进 state / 授权 URL
    claim_secret = secrets.token_urlsafe(24)
    try:
        # 先取上游 authorize_url，从中提取 state
        async with http.client(up, timeout=15.0) as client:
            resp = await client.get(
                f"{up}/v1/auth/feishu/login-url",
                params={"redirect_uri": _callback_url(), "purpose": "auto_login"})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"认证服务不可达: {e!r}")
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"取授权地址失败 HTTP {resp.status_code}: {resp.text[:120]}")
    url = (resp.json() or {}).get("authorize_url")
    if not url:
        raise HTTPException(status_code=502, detail="上游未返回 authorize_url")

    # 从 authorize_url 提取 state，拼上 ticket
    try:
        from urllib.parse import parse_qs, urlparse, urlencode, urlunparse
        u = urlparse(url)
        q = parse_qs(u.query)
        upstream_state = (q.get("state") or [""])[0]
        if not upstream_state:
            raise ValueError("上游 state 为空")
        combined_state = f"{upstream_state}.{ticket}"
        q["state"] = [combined_state]
        new_url = urlunparse((u.scheme, u.netloc, u.path,
                              u.params, urlencode(q, doseq=True), u.fragment))
    except Exception as e:  # noqa: BLE001
        log.warning("[feishu] 改写 state 失败: %r", e)
        raise HTTPException(status_code=500, detail="内部状态拼接失败")

    with get_session() as session:
        session.add(LoginTicket(ticket=ticket, created=time.time(),
                                claim=claim_secret, ip=_client_ip(request)))
        session.commit()
    out = {"ticket": ticket, "authorize_url": new_url}
    if not is_web:
        out["claim_secret"] = claim_secret
    return out


def _done_page(title: str, msg: str, ok: bool) -> HTMLResponse:
    """回调落地页。用户是在系统浏览器里看到这一页的，所以要能自解释。"""
    color = "#16a34a" if ok else "#dc2626"
    icon = "✓" if ok else "✕"
    return HTMLResponse(
        "<!doctype html><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{title}</title>"
        "<div style=\"font-family:system-ui,-apple-system,'Segoe UI',sans-serif;"
        "display:flex;align-items:center;justify-content:center;height:100vh;"
        "margin:0;background:#0b0d10;color:#e5e7eb\">"
        "<div style='text-align:center;max-width:420px;padding:32px'>"
        f"<div style='font-size:48px;color:{color};line-height:1'>{icon}</div>"
        f"<h2 style='margin:16px 0 8px;font-weight:600'>{title}</h2>"
        f"<p style='margin:0;color:#9ca3af;line-height:1.6'>{msg}</p>"
        "</div></div>")


def _web_app_url() -> str:
    """网页端应用地址（回调后 302 回这里）。"""
    return f"{(get_settings().feishu_callback_base or '').rstrip('/')}/app/"


def _finish(ticket: str, ok: bool, title: str, msg: str,
            frag: str = "") -> HTMLResponse | RedirectResponse:
    """回调收尾：按客户端形态选择"落地页"还是"跳回应用"。

    网页端（ticket 以 `w-` 开头）：授权前后是同一个标签页，直接 302 回
    `/fw/app/`，把结果放 **fragment**（`#` 后的内容不发给服务器，
    因此不进 nginx access log、也不带进 Referer——与剧本平台落地页同理）。
    用户眼里就是"扫完码就进来了"，不再多一张要手动关掉的页。

    桌面端：浏览器与应用是两个窗口，只能显示落地页告诉用户可以回去了。
    """
    if ticket.startswith("w-"):
        sep = "#" + (frag if ok else f"error={quote(msg)}")
        return RedirectResponse(_web_app_url() + sep, status_code=302)
    return _done_page(title, msg, ok)


@router.get("/feishu/callback", response_model=None)
async def feishu_callback(code: str = "",
                          state: str = "") -> HTMLResponse | RedirectResponse:
    """飞书授权回调（浏览器跳转到这里）。

    拿 code 去上游换身份——**不在本服务换**，因为换 code 需要 app_secret，
    而那个密钥只应存在剧本平台一处（少一处泄露面，轮换时也不必两边改）。
    上游 callback 在非浏览器调用时返回 JSON，正好可当作服务端接口用。

    `state` 是 `feishu_start` 拼的 `{上游state}.{ticket}`——飞书原样带回来。
    这里拆开：上游那半交还给上游校验，ticket 那半用来投递会话。

    收尾分两种（见 `_finish`）：桌面端显示落地页等轮询，网页端直接 302 回应用。
    """
    _gc_tickets()
    # 先拆 state 拿 ticket：后面所有分支的收尾方式都取决于它
    upstream_state, _, ticket = state.rpartition(".")
    if not upstream_state:
        # 没拼过的 state（例如有人直接访问回调地址）：无 ticket 可投递
        upstream_state, ticket = state, ""

    if not code:
        return _finish(ticket, False, "授权未完成",
                       "没有收到授权码，可能是取消了授权。请重新发起登录。")

    with get_session() as session:
        row = session.get(LoginTicket, ticket) if ticket else None
    item = _row_to_item(row) if row is not None else None
    if ticket and item is None:
        return _finish(ticket, False, "登录已超时",
                       "这次登录请求已过期（超过 10 分钟），请重新发起登录。")

    # 幂等保护：同一 ticket 已经成功过（飞书有时会重复回调同一个 state）。
    # 直接返回成功落地页，不再拿失效的 code 调上游（调必然失败并覆盖成功结果）。
    if item is not None and item.get("result") is not None:
        name = (item["result"].get("user_name") or
                item["result"].get("display_name") or "你")
        return _finish(ticket, True, "登录成功",
                       f"欢迎，{name}。可以关掉这个页面，回到织影了。",
                       frag=f"token={quote(item['result']['token'])}" if item["result"].get("token") else "")

    up = _upstream()
    try:
        async with http.client(up, timeout=20.0) as client:
            # 不带 Accept: text/html —— 上游据此返回 JSON 而不是 302
            resp = await client.get(f"{up}/v1/auth/feishu/callback",
                                    params={"code": code, "state": upstream_state},
                                    headers={"Accept": "application/json"})
    except Exception as e:  # noqa: BLE001
        log.warning("[feishu] 上游换取身份失败: %r", e)
        return _finish(ticket, False, "登录失败", "认证服务暂时不可达，请稍后重试。")

    if resp.status_code != 200:
        log.warning("[feishu] 上游返回 %s: %s", resp.status_code, resp.text[:200])
        detail = ""
        try:
            detail = (resp.json() or {}).get("detail") or ""
        except ValueError:
            pass
        return _finish(ticket, False, "登录失败",
                       detail or f"认证服务返回 HTTP {resp.status_code}。")

    data = resp.json() or {}
    user = data.get("user") or {}
    if not user:
        # 上游登录成功但没带 user（例如返回的是 link 流程）——用 access_token 兜底查一次
        jwt = data.get("access_token") or ""
        if jwt:
            try:
                async with http.client(up, timeout=15.0) as client:
                    me_resp = await client.get(
                        f"{up}/v1/auth/me",
                        headers={"Authorization": f"Bearer {jwt}"})
                if me_resp.status_code == 200:
                    user = me_resp.json() or {}
            except Exception as e:  # noqa: BLE001
                log.warning("[feishu] 回查用户信息失败: %r", e)
    if not user:
        return _finish(ticket, False, "登录失败", "认证服务未返回用户信息。")

    try:
        issued = _issue_session(user)
    except HTTPException as e:
        return _finish(ticket, False, "登录被拒绝", str(e.detail))

    if item is None:
        # 没带 ticket（例如用户直接访问回调地址）：会话已签发但无处投递。
        # 明确告知，而不是让用户对着一个"成功"页干等。
        log.info("[feishu] 回调未带 ticket，会话已签发但无处投递")
        return _finish(ticket, False, "登录成功",
                       "但这次请求缺少票据，织影无法自动接收。请重新发起一次登录。")

    result_to_store = issued
    # 桌面端：把剧本平台签给这个人的令牌一并转交（2026-11-01 用户裁定的登录方案 A）——
    # 客户端的「剧本」对话直接用它调剧本平台。**本服务不保存**：只放在这张一次性票据里，
    # 客户端用 claim_secret 取走即作废（同 token）；网页端票据不经轮询、也不需要它，不放。
    if ticket.startswith("d-"):
        drama = {k: data.get(k) for k in ("access_token", "refresh_token")
                 if isinstance(data.get(k), str) and data.get(k)}
        if len(drama) == 2:
            result_to_store = {**issued, "script_platform": drama}
    # 持久化结果到 DB，回调完成后 poll 可从 DB 取到
    with get_session() as session:
        row = session.get(LoginTicket, ticket)
        if row is not None:
            row.result = _json.dumps(result_to_store)
            session.commit()
    name = user.get("display_name") or user.get("username") or "你"
    # 网页端：会话直接放 fragment 带回应用，用户无需再看任何中间页。
    # 桌面端：会话留在 ticket 里等轮询，这里只显示"可以回去了"。
    return _finish(ticket, True, "登录成功",
                   f"欢迎，{name}。可以关掉这个页面，回到织影了。",
                   frag=f"token={quote(issued['token'])}")


@router.get("/feishu/poll")
def feishu_poll(request: Request, ticket: str = "",
                x_fw_claim: str = Header("")) -> dict:
    """桌面端轮询取会话。

    取号要两样东西：query 里的 `ticket` + `X-FW-Claim` 头里的 `claim_secret`。
    后者只在 `start` 的响应里出现过一次，**不曾经过扫码那个人的浏览器**，
    所以"把授权链接发给别人扫"拿不到会话（S2）。

    `status`：
      pending — 用户还没扫完码
      ok      — 已签发，`token`/`user` 可用（**取走即销毁**，票据不复用）
      expired — 票据过期或不存在

    校验不过一律 **403**（不是 401）：401 会被前端的会话拦截逻辑当成"登录过期"
    而弹登录页，可这里本来就在登录流程里，那样只会转圈。
    """
    _gc_tickets()
    # 网页端票据根本不经 poll：回调直接 302 回 `/fw/app/#token=`（见 `_finish`）。
    # 它没有 claim_secret，若允许 poll 就等于给劫持留了一条没有锁的门。
    if ticket.startswith("w-"):
        raise HTTPException(status_code=403,
                            detail="网页端登录不经轮询取号")
    with get_session() as session:
        row = session.get(LoginTicket, ticket) if ticket else None
        item = _row_to_item(row) if row is not None else None
    if item is None:
        return {"status": "expired"}
    # compare_digest 而非 `!=`：取号密钥是可被反复试探的短命秘密，
    # 顺手消掉时序侧信道，成本为零。
    if not (x_fw_claim and secrets.compare_digest(x_fw_claim, item["claim"])):
        log.warning("[feishu] poll 取号密钥不匹配，已拒绝（ticket 前 4 位 %s…）",
                    ticket[:4])
        raise HTTPException(status_code=403, detail="取号密钥不匹配，请重新发起登录")
    # IP 纵深：start 与 poll 应当来自同一个客户端。
    #
    # ⚠️ 用 `/24` 而不是精确相等（2026-11-10 修）。原来的 `!=` 判断把**正常的
    #    移动网络登录**全拒了：实测同一用户在 4 分钟里两次登录，出口 IP 分别是
    #    `203.0.113.10` 与 `203.0.113.11` —— 同一个运营商 NAT 池的两个地址。
    #    扫码完成、会话已签发（票据 result 有值），却在取号这一步被拒，
    #    用户看到的就是"扫完码反复显示登录来源已变化"。
    #
    #    这不是安全防线的削弱：这道 IP 检查本来也只是**纵深**，真正拦住票据劫持
    #    的是 claim_secret（只回给发起方、不进 state/授权 URL）。放宽到同 /24
    #    并不让攻击者更容易 —— 他若已经拿到 claim_secret，IP 那关本就不是唯一门槛；
    #    而他拿不到时，IP 相同也取不走（见上面那条 403）。
    #    跨网段/跨国仍然会拒：那种"来源真的换了"的情况保留原行为。
    now_ip = _client_ip(request)
    if item["ip"] and now_ip and not _same_client_net(item["ip"], now_ip):
        log.warning("[feishu] poll 来源 IP 与发起时不在同一网段（%s → %s），已拒绝",
                    item["ip"], now_ip)
        raise HTTPException(status_code=403, detail="登录来源已变化，请重新发起登录")
    if item["result"] is None:
        return {"status": "pending"}
    # 一次性：取走就作废
    with get_session() as session:
        session.query(LoginTicket).filter(LoginTicket.ticket == ticket).delete()
        session.commit()
    return {"status": "ok", **item["result"]}


class LogoutIn(BaseModel):
    """登出请求体。

    `token` 保留是为了兼容既有客户端（它们会带上自己的 token），但现在
    **只允许等于调用方自己的 token** —— 谁是调用方由 `Authorization` 头决定。
    """

    token: str = ""


@router.post("/logout")
def logout_route(request: Request, body: LogoutIn | None = None) -> dict:
    """显式吊销会话（数据安全：登出即失效，而非仅前端丢弃）。

    ⚠️ 只能吊销**自己**的会话（S2 同类问题）：原实现直接 revoke 请求体里的
    token，只校验"这 token 是真的"、不校验"调用者是它的主人" —— 任何拿到
    他人 token 的人都能把对方踢下线。现在主体一律取自 `Authorization: Bearer`，
    请求体里的 token 只做一致性校验，不一致直接 403。

    对无效/过期 token 返回 `ok` 而不是报错：登出是幂等动作，会话已经没了
    也算达到目的；报错只会让前端在"会话刚过期时点登出"这种常见情形里卡住。
    """
    authz = request.headers.get("Authorization", "")
    mine = authz[7:] if authz.startswith("Bearer ") else ""
    if not mine:
        raise HTTPException(status_code=401,
                            detail="登出需带 Authorization: Bearer <会话token>")
    claimed = (body.token if body else "") or ""
    if claimed and not secrets.compare_digest(claimed, mine):
        raise HTTPException(status_code=403, detail="只能吊销自己的会话")
    revoke_session(mine)
    return {"ok": True}


@router.get("/me")
def me(request: Request) -> dict:
    """会话查询（前端恢复现场用）。

    只认 `Authorization: Bearer <token>`。原来还兜底读 `?token=` query 参数，
    已于 2026-09-11 删掉（S3）：query 会进 nginx access log 与浏览器历史，
    而这里传的正是 7 天有效的会话令牌 —— 一条日志行就是一次可重放的登录。
    前端 `api.authMe()` 早已只走 header，删除不影响任何在用客户端。
    """
    authz = request.headers.get("Authorization", "")
    token = authz[7:] if authz.startswith("Bearer ") else ""
    info = verify_session(token)
    if not info:
        raise HTTPException(status_code=401, detail="会话无效或已过期")
    return {"user": info}


def verify_session(token: str) -> dict | None:
    """校验会话 token；有效返回用户信息，无效返回 None。

    入参是**明文** token（来自 Authorization 头），查库前哈希一次 ——
    库里存的是摘要，见 `_hash_token`。
    """
    if not token:
        return None
    with get_session() as session:
        s = session.get(AuthSession, _hash_token(token))
        if not s:
            return None
        try:
            exp = datetime.fromisoformat(s.expires_at)
        except ValueError:
            return None
        if exp < datetime.now(timezone.utc):
            session.delete(s)
            session.commit()
            return None
        return {"id": s.user_id, "username": s.username,
                "display_name": s.display_name, "role": s.role}


def revoke_session(token: str) -> None:
    """吊销一个会话。入参是明文 token（库里按摘要存）。"""
    with get_session() as session:
        s = session.get(AuthSession, _hash_token(token))
        if s:
            session.delete(s)
            session.commit()


def cleanup_expired_sessions() -> int:
    """启动时清过期会话（维护任务）。"""
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with get_session() as session:
        n = (session.query(AuthSession)
             .filter(AuthSession.expires_at < now).delete())
        session.commit()
        return n
