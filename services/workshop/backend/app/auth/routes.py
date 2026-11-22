"""认证API路由"""
import logging
from datetime import datetime
from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.responses import RedirectResponse
from urllib.parse import urlencode
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..db import session_scope
from ..config import get_settings
from . import account_merge as am
from .models import User, UserAuditLog
from .password import hash_password, verify_password
from .jwt_helper import create_access_token, create_refresh_token, decode_token
from .dependencies import get_current_user
from jose import JWTError

router = APIRouter(prefix="/v1/auth", tags=["auth"])
logger = logging.getLogger("auth")


class RegisterIn(BaseModel):
    username: str = Field(..., min_length=2, max_length=64)
    password: str = Field(..., min_length=6, max_length=128)
    display_name: str | None = None


class LoginIn(BaseModel):
    username: str
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class ChangePasswordIn(BaseModel):
    old_password: str
    new_password: str = Field(..., min_length=6)


class UpdateProfileIn(BaseModel):
    display_name: str | None = None
    avatar_url: str | None = None


def _user_to_dict(u: User) -> dict:
    return {
        "id": u.id,
        "username": u.username,
        "login_id": u.login_id,
        "display_name": u.display_name,
        "role": u.role,
        "status": u.status,
        "avatar_url": u.avatar_url,
        "feature_flags": u.feature_flags or {},
        "quota_daily": u.quota_daily,
        "quota_used_today": u.quota_used_today,
        "created_at": u.created_at.isoformat() if u.created_at else None,
        "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
        "feishu_bound": bool(u.feishu_union_id),
        "feishu_name": u.feishu_name,
        # 飞书统一身份（与 users.feishu_union_id 同值）。2026-10-15 加：镜流按它把
        # 飞书审批单的发起人对到自己的账号上（审批接口用 user_id_type=union_id 返回
        # 发起人）。union_id 只是标识、不是凭据；不带它的话镜流只能按名字猜人，
        # 撞重名就会把额度拨给错的人。
        "feishu_union_id": u.feishu_union_id,
        # 是不是"扫码自动建出来的号"。前端据此决定要不要提示
        # "你以前是不是有账号？可以合并过来" —— 存量受害者多半正登录在这种号里。
        "feishu_auto": bool(u.login_id and u.login_id.startswith("fs_")),
        "has_password": bool(u.password_hash),
    }


async def _write_audit(s, user_id: int, action: str, resource_type: str = "", resource_id: int = 0, ip: str = "", ua: str = "", metadata: dict = None):
    log = UserAuditLog(
        user_id=user_id, action=action,
        resource_type=resource_type, resource_id=resource_id,
        ip=ip, user_agent=ua[:500] if ua else "",
        log_metadata=metadata or {},
    )
    s.add(log)


@router.post("/register")
async def register(payload: RegisterIn, request: Request):
    """注册新用户(仅username/password)"""
    from sqlalchemy import text as _text
    async with session_scope() as s:
        # 检查是否允许注册
        setting = (await s.execute(_text("SELECT value FROM system_settings WHERE key='allow_registration'"))).first()
        if not setting or str(setting[0]).lower() != 'true':
            raise HTTPException(403, "当前系统暂不开放注册,请联系管理员")
        
        # 唯一性: username 和 login_id 都不能重复(避免后续被改名时撞上某个老 login_id)
        existing = (await s.execute(
            select(User).where(
                (User.username == payload.username) | (User.login_id == payload.username)
            )
        )).scalar_one_or_none()
        if existing:
            raise HTTPException(409, "用户名已存在")

        user = User(
            login_id=payload.username,            # login_id 永久不可改, 注册时复制 username
            username=payload.username,
            password_hash=hash_password(payload.password),
            display_name=payload.display_name or payload.username,
            role="user",
            status="active",
            quota_daily=100,
        )
        s.add(user)
        await s.flush()
        await s.refresh(user)
        
        ip = request.client.host if request.client else ""
        ua = request.headers.get("user-agent", "")
        await _write_audit(s, user.id, "register", ip=ip, ua=ua)
        
        access_token, _ = create_access_token(user.id, user.username, user.role)
        refresh_token, _ = create_refresh_token(user.id)
        
        return {
            "user": _user_to_dict(user),
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_type": "bearer",
        }


@router.post("/login")
async def login(payload: LoginIn, request: Request):
    """登录"""
    async with session_scope() as s:
        # 登录支持: 用 username (可变) 或 login_id (永久) 登录, 兼容用户改名前后的习惯
        user = (await s.execute(
            select(User).where(
                (User.username == payload.username) | (User.login_id == payload.username)
            )
        )).scalar_one_or_none()
        # 防御：飞书自动建的号没有密码，不能用密码登录
        if not user or not user.password_hash or not verify_password(payload.password, user.password_hash):
            # 统一错误信息，防止账号枚举
            raise HTTPException(401, "用户名或密码错误")

        # 已绑定飞书的账号一律走扫码，密码通道关闭。
        #
        # 为什么：绑定后若还留着密码入口，它就是一条绕过飞书准入的后门 ——
        # 员工离职被移出通讯录后扫码会被飞书拒，但密码仍然能进。
        # 准入交给飞书管理的前提，是这边不能有旁路。
        #
        # ⚠️ 这个判断必须放在密码校验**之后**：放前面的话，
        # 攻击者用任意密码就能区分"该账号已绑飞书"和"账号不存在"，
        # 等于送出一个账号枚举接口。
        if user.feishu_union_id:
            raise HTTPException(
                403,
                f"账号「{user.username}」已绑定飞书，请使用飞书扫码登录。"
                "（如需解绑请联系管理员）",
            )

        if user.status != "active":
            raise HTTPException(403, f"账号状态: {user.status}")
        
        ip = request.client.host if request.client else ""
        ua = request.headers.get("user-agent", "")
        
        from datetime import datetime
        user.last_login_at = datetime.utcnow()
        user.last_login_ip = ip
        
        await _write_audit(s, user.id, "login", ip=ip, ua=ua)
        await s.flush()
        await s.refresh(user)
        
        access_token, _ = create_access_token(user.id, user.username, user.role)
        refresh_token, _ = create_refresh_token(user.id)
        
        return {
            "user": _user_to_dict(user),
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_type": "bearer",
        }


@router.post("/logout")
async def logout(user: User = Depends(get_current_user)):
    """登出(前端丢弃token即可,后端记录审计)"""
    async with session_scope() as s:
        await _write_audit(s, user.id, "logout")
    return {"ok": True, "message": "已登出"}


@router.post("/refresh")
async def refresh(payload: RefreshIn):
    """用refresh_token续签access_token"""
    try:
        p = decode_token(payload.refresh_token)
    except JWTError:
        raise HTTPException(401, "refresh_token无效")
    
    if p.get("type") != "refresh":
        raise HTTPException(401, "token类型错误")
    
    user_id = int(p["sub"])
    async with session_scope() as s:
        user = await s.get(User, user_id)
        if not user or user.status != "active":
            raise HTTPException(401, "用户不可用")
        access_token, _ = create_access_token(user.id, user.username, user.role)
        return {"access_token": access_token, "token_type": "bearer"}


@router.get("/me")
async def get_me(user: User = Depends(get_current_user)):
    """获取当前用户"""
    return _user_to_dict(user)


@router.patch("/me")
async def update_profile(payload: UpdateProfileIn, user: User = Depends(get_current_user)):
    """修改个人资料"""
    async with session_scope() as s:
        u = await s.get(User, user.id)
        if payload.display_name is not None:
            u.display_name = payload.display_name
        if payload.avatar_url is not None:
            u.avatar_url = payload.avatar_url
        await s.flush()
        await s.refresh(u)
        return _user_to_dict(u)


@router.post("/change-password")
async def change_password(payload: ChangePasswordIn, user: User = Depends(get_current_user)):
    """修改密码"""
    async with session_scope() as s:
        u = await s.get(User, user.id)
        # 已绑定飞书的账号没有密码通道，不能再设密码 ——
        # 否则等于自己给自己开一条绕过飞书准入的后门。
        if u.feishu_union_id:
            raise HTTPException(
                403, "该账号已绑定飞书，通过扫码登录，无需也不能设置密码")
        # 飞书自动建的号 password_hash 为 NULL，
        # 直接丢给 verify_password 会炸，先挡掉。
        if not u.password_hash:
            raise HTTPException(400, "该账号未设置密码，无法修改")
        if not verify_password(payload.old_password, u.password_hash):
            raise HTTPException(400, "原密码错误")
        u.password_hash = hash_password(payload.new_password)
        await _write_audit(s, u.id, "change_password")
        await s.flush()
    return {"ok": True, "message": "密码已修改"}


# ==========================================================================
# 飞书扫码登录 / 认领 / 绑定 / 合并
# ==========================================================================
#
# 流程（2026-08-31 改版；改掉的正是"扫码即无条件建号"这一条）：
#
# 1. 扫码 → union_id 已绑定 → 直接登录
#
# 2. 扫码 → union_id 陌生 → **不建号**，签发 claim_token 并把人送到认领页：
#      "我是新用户"   → POST /feishu/claim/new       建 fs_ 新号并登录
#      "我已有账号"   → POST /feishu/claim/existing  输原账号密码，绑上去并登录
#
#    为什么必须先问一句：老用户顺手扫一下就被自动建了个空白号，而
#    users.feishu_union_id 是 UNIQUE —— 这个空号从此永久占住他的飞书身份，
#    他回头用密码登旧号再想绑定，只会得到 409，而解绑接口是硬 403。
#    死结的源头就是这一次没问。详见 account_merge 模块头部注释。
#
# 3. 旧账号绑定飞书 → POST /feishu/link（带旧账号 token + 飞书 code）
#
# 4. 存量受害者（改版前已经被自动建号占住身份的人）两条自助出路：
#      - 登录态在**老号**：/feishu/link 撞 409 时返回 merge_token → POST /feishu/merge
#      - 登录态在**新号**：POST /feishu/claim-legacy（输老账号密码）
#    两条都走 account_merge.merge_accounts，把新号的草稿等数据并进老号，一条不丢。


def _fs_login_id(union_id: str) -> str:
    """飞书身份 → 自动建号用的 login_id（永久稳定）。

    必须由**完整** union_id 派生：早期截断前 12 位，实测两个不同员工截断后
    一模一样，第二个人建号时撞 login_id 唯一键直接登不进来。
    """
    import hashlib
    return "fs_" + hashlib.sha1(union_id.encode("utf-8")).hexdigest()[:16]


async def _unique_username(s, base: str) -> str:
    """把飞书姓名变成不撞车的 username（撞了就加数字后缀）。

    ⚠️ 这个后缀正是识别"误建空白号"的线索：生产上「余锦豪1」「李彤彤1」
    这类名字，几乎都意味着同名的老账号就在旁边（见 admin_routes 的疑似配对）。
    """
    name = (base or "飞书用户").strip()[:60] or "飞书用户"
    candidate = name
    for i in range(1, 100):
        dup = (await s.execute(select(User).where(
            (User.username == candidate) | (User.login_id == candidate)
        ))).scalar_one_or_none()
        if not dup:
            return candidate
        candidate = f"{name}{i}"
    raise HTTPException(500, "无法生成不重复的用户名，请联系管理员")


def _login_payload(u: User, extra: dict | None = None) -> dict:
    """统一的登录响应体（签发 token + 用户信息）。"""
    access_token, _ = create_access_token(u.id, u.username, u.role)
    refresh_token, _ = create_refresh_token(u.id)
    out = {
        "ok": True,
        "user": _user_to_dict(u),
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
    }
    out.update(extra or {})
    return out


def _feishu_redirect_uri(request: Request, override: str | None = None) -> str:
    """回调地址，必须与飞书【安全设置→重定向URL】完全一致。"""
    if override:
        return override
    s = get_settings()
    base = (getattr(s, "feishu_login_redirect_base", "") or "").strip()
    if base:
        return base.rstrip("/") + "/v1/auth/feishu/callback"
    return str(request.url_for("feishu_callback"))


@router.get("/feishu/login-url")
async def feishu_login_url(request: Request, redirect_uri: str | None = None,
                           purpose: str = "auto_login"):
    """前端取授权 URL。

    purpose:
      auto_login — 扫码登录/自动建号（默认）
      link       — 已登录用户绑定飞书；callback 只把 code 回传给前端，
                   由前端带着当前登录态去调 /feishu/link，
                   **不会**在这一步替换登录身份
    """
    from . import feishu_oauth as fo
    if purpose not in ("auto_login", "link"):
        raise HTTPException(400, "purpose 只能是 auto_login 或 link")
    try:
        st = await fo.issue_state(purpose)
        return {"authorize_url": fo.build_authorize_url(
            _feishu_redirect_uri(request, redirect_uri), st)}
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@router.get("/feishu/callback", name="feishu_callback")
async def feishu_callback(request: Request, code: str = "", state: str = ""):
    """飞书授权回调：自动建号或登录已绑账号。

    返回形态取决于调用方：
      - 浏览器直接跳转过来（Accept: text/html）→ 302 到前端页，
        token 放 URL fragment（`#` 后面不进服务器日志、不带进 Referer）
      - fetch/XHR 调用（前端回调页、绑定流程）→ 返回 JSON

    为什么要分：飞书是整页跳转过来的，若直接返回 JSON，
    浏览器会把 access_token 原样糊在屏幕上（实测确实如此）。
    """
    from . import feishu_oauth as fo

    def _wants_html() -> bool:
        return "text/html" in (request.headers.get("accept") or "")

    def _redirect(payload: dict, path: str = "/auth/feishu/done") -> RedirectResponse:
        """把结果塞进 fragment 交给前端页处理。"""
        s = get_settings()
        base = (getattr(s, "feishu_login_redirect_base", "") or "").strip()
        # origin 拼法：
        #   base 形如 http://host/api → 去掉 "/api" 后缀得前端 origin
        #   base 形如 http://host    → 直接当 origin（生产配置形式）
        #   base 未配置             → 兜底用 PUBLIC_BASE_URL
        # ⚠️ 不能返回相对路径：callback 在 orchestrator(8000/8001) 上，
        #    相对 redirect 会留在 API 域而不是 Next.js 前端，token fragment 送不过去。
        if base:
            stripped = base.rstrip("/")
            origin = stripped[:-4].rstrip("/") if stripped.endswith("/api") else stripped
        else:
            origin = (getattr(s, "public_base_url", "") or "").rstrip("/")
        frag = urlencode({k: v for k, v in payload.items() if v is not None})
        return RedirectResponse(f"{origin}{path}#{frag}", status_code=302)

    def _fail(status: int, msg: str, code: str = ""):
        """失败出口。

        `code` 会一并塞进 fragment：前端据此决定给什么按钮 ——
        state 类失败（used/expired/unknown）该给的是「重新扫码」，
        而不是原来那个只会把人送回登录页首屏的「返回登录」。
        这类错误全程只出现在 fragment 里（`#` 不进服务器日志），
        所以生产上查不到任何痕迹，用户却在反复撞 —— 现在补一条服务端日志。
        """
        if code:
            logger.warning("feishu callback failed: code=%s msg=%s", code, msg)
        if _wants_html():
            return _redirect({"error": msg, "error_code": code or "callback"})
        raise HTTPException(status, msg)

    if not code:
        return _fail(400, "缺少 code（用户可能取消了授权）", "no_code")
    try:
        purpose, _ = await fo.consume_state(state)
    except ValueError as e:
        # EphemeralError 带 code（used / expired / unknown）；普通 ValueError 没有
        return _fail(400, str(e), getattr(e, "code", "state_invalid"))

    # 绑定意图：把 code 原样交还前端，由前端带着**当前登录态**去调 /feishu/link。
    # 这里绝不能 exchange_user_info —— 飞书 code 只能用一次，
    # 在这里换掉的话前端再拿去绑定就会失败（20003 code is invalid）。
    if purpose == "link":
        if _wants_html():
            return _redirect({"link_code": code, "action": "link"})
        return {"ok": True, "action": "link", "link_code": code}

    try:
        info = await fo.exchange_user_info(code)
    except RuntimeError as e:
        # 最常见的是飞书 20003（code 一次性、5 分钟过期）。用户视角与 state 失效
        # 完全一样：刷新/后退了一下就撞上。所以也归到"重新扫码"那一类。
        return _fail(400, str(e), "code_used")

    union_id = info["union_id"]
    open_id = info.get("open_id") or ""
    fs_name = info.get("name") or "飞书用户"
    ip = request.client.host if request.client else ""
    ua = request.headers.get("user-agent", "")

    async with session_scope() as s:
        bound = (await s.execute(
            select(User).where(User.feishu_union_id == union_id)
        )).scalar_one_or_none()

        if bound:
            # 已绑定 → 直接登录
            if bound.status != "active":
                return _fail(403, f"账号状态：{bound.status}")
            bound.last_login_at = datetime.utcnow()
            bound.last_login_ip = ip
            await _write_audit(s, bound.id, "login_feishu", ip=ip, ua=ua)
            await s.flush()
            await s.refresh(bound)
            access_token, _ = create_access_token(bound.id, bound.username, bound.role)
            refresh_token, _ = create_refresh_token(bound.id)
            if _wants_html():
                return _redirect({"access_token": access_token,
                                  "refresh_token": refresh_token,
                                  "action": "login"})
            return {
                "ok": True, "action": "login",
                "user": _user_to_dict(bound),
                "access_token": access_token,
                "refresh_token": refresh_token,
                "token_type": "bearer",
            }

        # union_id 陌生 —— 先看是不是历史脏数据，再决定是否请用户认领。
        #
        # login_id 必须由**完整** union_id 派生：截断前 N 位会撞车
        # （飞书 union_id 前缀常相同，实测两个不同用户截断后一模一样，
        #  导致第二个人建号时报 login_id 冲突而登不进来）。
        # 用 sha1 取 16 位十六进制：碰撞概率可忽略，且长度可控、字符集安全。
        login_id = _fs_login_id(union_id)
        existing = (await s.execute(
            select(User).where(User.login_id == login_id)
        )).scalar_one_or_none()
        # ⚠️ 必须限定 active：被合并掉的号 status='merged'，它的 login_id 仍是
        # fs_<同一个 digest>。不加这个条件的话，管理员一旦给老号解绑，
        # 下次扫码就会"修复"到那具已经被合并掉的空壳上去。
        if existing and existing.status == "active" and not existing.feishu_union_id:
            # 同一 union_id 已建过号但 feishu_union_id 没写上（历史脏数据），
            # 补写绑定后按登录处理，不再报错把人挡在外面
            existing.feishu_union_id = union_id
            existing.feishu_open_id = open_id
            existing.feishu_name = fs_name
            existing.feishu_bound_at = datetime.utcnow()
            existing.last_login_at = datetime.utcnow()
            existing.last_login_ip = ip
            await _write_audit(s, existing.id, "login_feishu_repair", ip=ip, ua=ua)
            await s.flush()
            await s.refresh(existing)
            access_token, _ = create_access_token(existing.id, existing.username, existing.role)
            refresh_token, _ = create_refresh_token(existing.id)
            if _wants_html():
                return _redirect({"access_token": access_token,
                                  "refresh_token": refresh_token,
                                  "action": "login"})
            return {
                "ok": True, "action": "login",
                "user": _user_to_dict(existing),
                "access_token": access_token,
                "refresh_token": refresh_token,
                "token_type": "bearer",
            }

    # 到这里说明这是一个**陌生**飞书身份——直接建号并登录。
    async with session_scope() as s:
        login_id = _fs_login_id(union_id)
        taken = (await s.execute(
            select(User).where(User.login_id == login_id)
        )).scalar_one_or_none()
        if taken:
            import secrets as _secrets
            login_id = f"{login_id}_{_secrets.token_hex(3)}"

        username = await _unique_username(s, fs_name)
        new_user = User(
            login_id=login_id,
            username=username,
            display_name=fs_name,
            password_hash=None,
            role="user",
            status="active",
            quota_daily=100,
            feishu_union_id=union_id,
            feishu_open_id=open_id,
            feishu_name=fs_name,
            feishu_bound_at=datetime.utcnow(),
            created_at=datetime.utcnow(),
            last_login_at=datetime.utcnow(),
            last_login_ip=ip,
        )
        s.add(new_user)
        await s.flush()
        await s.refresh(new_user)
        await _write_audit(s, new_user.id, "register_feishu_auto", ip=ip, ua=ua,
                           metadata={"feishu_name": fs_name, "login_id": login_id})
        access_token, _ = create_access_token(new_user.id, new_user.username, new_user.role)
        refresh_token, _ = create_refresh_token(new_user.id)
        if _wants_html():
            return _redirect({"access_token": access_token,
                              "refresh_token": refresh_token,
                              "action": "register"})
        return {
            "ok": True, "action": "register",
            "user": _user_to_dict(new_user),
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_type": "bearer",
        }


class FeishuLinkIn(BaseModel):
    link_code: str


async def _bind_feishu(s, u: User, *, union_id: str, open_id: str, fs_name: str,
                       ip: str, ua: str, action: str = "feishu_link") -> None:
    """把飞书身份挂到账号 u 上，并按规矩清空密码。

    绑定成功即清空密码：此后该账号只能扫码登录。
    不清的话密码哈希会一直躺在库里 —— 登录接口虽已拦截，
    但它仍是一份可被离线爆破/泄露后复用的凭据，没有留存价值；
    更要紧的是，留着它就等于给"飞书管准入"开了一条旁路：
    员工离职被移出通讯录后扫码会被飞书拒，密码却仍然进得来。
    """
    u.feishu_union_id = union_id
    u.feishu_open_id = open_id
    u.feishu_name = fs_name
    u.feishu_bound_at = datetime.utcnow()
    had_password = bool(u.password_hash)
    u.password_hash = None
    await _write_audit(s, u.id, action, ip=ip, ua=ua,
                       metadata={"feishu_name": fs_name,
                                 "password_cleared": had_password})


@router.post("/feishu/link")
async def feishu_link(payload: FeishuLinkIn, request: Request,
                      user: User = Depends(get_current_user)):
    """旧账号反向绑定飞书。前提：已用密码登录旧账号。"""
    from . import feishu_oauth as fo

    if not payload.link_code:
        raise HTTPException(400, "缺少 link_code")

    try:
        info = await fo.exchange_user_info(payload.link_code)
    except RuntimeError as e:
        raise HTTPException(400, str(e))

    union_id = info["union_id"]
    open_id = info.get("open_id") or ""
    fs_name = info.get("name") or ""
    ip = request.client.host if request.client else ""
    ua = request.headers.get("user-agent", "")

    async with session_scope() as s:
        bound = (await s.execute(
            select(User).where(User.feishu_union_id == union_id)
        )).scalar_one_or_none()
        if bound and bound.id != user.id:
            # 撞上的如果是"扫码误建的空白号"，这不是冲突，是同一个人 ——
            # 他之前顺手扫过一次码。过去这里只会甩一句 409 就结束，而
            # /feishu/unlink 是硬 403，用户走到这一步就彻底没有出路了。
            #
            # 现在给出路：签发 merge_token，用户确认后调 /feishu/merge 把
            # 那个空白号（连同它上面已经产生的草稿等数据）并进当前账号。
            # 不要求重新扫码 —— 飞书 code 一次性且 5 分钟过期，让用户重扫
            # 只是白白增加失败率；merge_token 已经绑定了"谁能用它"。
            if am.is_feishu_auto_account(bound):
                merge_token = await am.issue_token("merge", {
                    "union_id": union_id,
                    "src_user_id": bound.id,
                    "dst_user_id": user.id,
                })
                summary = await _account_data_summary(s, bound.id)
                raise HTTPException(409, {
                    "code": "mergeable",
                    "merge_token": merge_token,
                    "holder": {
                        "id": bound.id, "username": bound.username,
                        "feishu_name": bound.feishu_name,
                        "created_at": bound.created_at.isoformat() if bound.created_at else None,
                    },
                    "holder_data": summary,
                    "message": (
                        f"这个飞书身份已经被账号「{bound.username}」占用 —— "
                        "多半是你之前顺手扫过一次码，系统当时自动建了个号。"
                        "确认合并后，它上面的数据会全部并到当前账号，一条不丢。"
                    ),
                })
            raise HTTPException(409,
                f"该飞书账号已绑定到「{bound.username}」，不能重复绑定")

        u = await s.get(User, user.id)
        if not u:
            raise HTTPException(400, "当前账号不存在")
        await _bind_feishu(s, u, union_id=union_id, open_id=open_id,
                           fs_name=fs_name, ip=ip, ua=ua)
        await s.flush()
        await s.refresh(u)
        return {"ok": True, "user": _user_to_dict(u),
                "message": f"已绑定飞书账号「{fs_name}」，此后请用飞书扫码登录"}


# -------------------------------------------------------------------------
# 认领：陌生飞书身份 → 由用户选择"新建"还是"关联已有账号"
# -------------------------------------------------------------------------

class ClaimTokenIn(BaseModel):
    claim_token: str


class ClaimExistingIn(BaseModel):
    claim_token: str
    username: str
    password: str


async def _account_data_summary(s, user_id: int) -> dict:
    """账号上已经有多少东西 —— 合并/认领前给用户看，让他知道不会丢东西。"""
    from ..db import ScriptDraft
    from sqlalchemy import func as _f
    drafts = (await s.execute(
        select(_f.count()).select_from(ScriptDraft)
        .where(ScriptDraft.user_id == user_id))).scalar_one()
    return {"drafts": int(drafts)}


@router.get("/feishu/claim/info")
async def feishu_claim_info(claim_token: str):
    """认领页开屏：把飞书姓名显示出来（此时还没消费 token）。"""
    try:
        data = await am.peek_token("claim", claim_token)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "feishu_name": data.get("feishu_name") or "飞书用户"}


@router.post("/feishu/claim/new")
async def feishu_claim_new(payload: ClaimTokenIn, request: Request):
    """认领页 ①「我是新用户」→ 建号并登录。

    等价于旧版的自动建号，区别只有一个：**这是用户自己按的**。
    """
    try:
        data = await am.consume_token("claim", payload.claim_token)
    except ValueError as e:
        raise HTTPException(400, str(e))

    union_id = data["union_id"]
    open_id = data.get("open_id") or ""
    fs_name = data.get("feishu_name") or "飞书用户"
    ip = request.client.host if request.client else ""
    ua = request.headers.get("user-agent", "")

    async with session_scope() as s:
        # 竞态复核：签发 token 到现在这几分钟里，可能已经有人认领了
        bound = (await s.execute(
            select(User).where(User.feishu_union_id == union_id)
        )).scalar_one_or_none()
        if bound:
            raise HTTPException(409, f"该飞书账号已关联到「{bound.username}」，请直接扫码登录")

        login_id = _fs_login_id(union_id)
        taken = (await s.execute(
            select(User).where(User.login_id == login_id)
        )).scalar_one_or_none()
        if taken:
            # 同一个 union_id 的旧壳还在（多半是被合并掉、status='merged' 的那个）。
            # login_id 永久不可改且唯一，只能换一个，不能覆盖历史行。
            import secrets as _secrets
            login_id = f"{login_id}_{_secrets.token_hex(3)}"

        username = await _unique_username(s, fs_name)
        new_user = User(
            login_id=login_id,
            username=username,
            display_name=fs_name,
            password_hash=None,
            role="user",
            status="active",
            quota_daily=100,
            feishu_union_id=union_id,
            feishu_open_id=open_id,
            feishu_name=fs_name,
            feishu_bound_at=datetime.utcnow(),
            created_at=datetime.utcnow(),
            last_login_at=datetime.utcnow(),
            last_login_ip=ip,
        )
        s.add(new_user)
        await s.flush()
        await s.refresh(new_user)
        await _write_audit(s, new_user.id, "register_feishu_claim", ip=ip, ua=ua,
                           metadata={"feishu_name": fs_name, "login_id": login_id})
        return _login_payload(new_user, {
            "action": "claim_new",
            "message": f"已创建账号「{username}」并完成登录",
        })


@router.post("/feishu/claim/existing")
async def feishu_claim_existing(payload: ClaimExistingIn, request: Request):
    """认领页 ②「我已经有账号」→ 校验原账号密码，把飞书绑上去并登录。

    这条路径**不需要**先登录：原账号的密码就是身份证明，
    再加上手里这个只能扫码拿到的 claim_token，两个因素都齐了。
    """
    try:
        data = await am.peek_token("claim", payload.claim_token)
    except ValueError as e:
        raise HTTPException(400, str(e))

    union_id = data["union_id"]
    open_id = data.get("open_id") or ""
    fs_name = data.get("feishu_name") or "飞书用户"
    ip = request.client.host if request.client else ""
    ua = request.headers.get("user-agent", "")

    async with session_scope() as s:
        u = (await s.execute(select(User).where(
            (User.username == payload.username) | (User.login_id == payload.username)
        ))).scalar_one_or_none()
        # 与 /login 同一套口径：错误信息统一，避免变成账号枚举接口
        if not u or not u.password_hash or not verify_password(payload.password, u.password_hash):
            raise HTTPException(401, "用户名或密码错误")
        if u.status != "active":
            raise HTTPException(403, f"账号状态：{u.status}")
        if u.feishu_union_id:
            raise HTTPException(400,
                f"账号「{u.username}」已经绑定了另一个飞书身份，请联系管理员处理")

        bound = (await s.execute(
            select(User).where(User.feishu_union_id == union_id)
        )).scalar_one_or_none()
        if bound:
            raise HTTPException(409, f"该飞书账号已关联到「{bound.username}」，请直接扫码登录")

        # 走到这里才真正消费 token：上面任何一步失败（密码打错最常见）
        # 都不该让用户重新扫一次码。
        await am.consume_token("claim", payload.claim_token)

        await _bind_feishu(s, u, union_id=union_id, open_id=open_id,
                           fs_name=fs_name, ip=ip, ua=ua, action="feishu_claim_existing")
        u.last_login_at = datetime.utcnow()
        u.last_login_ip = ip
        await s.flush()
        await s.refresh(u)
        return _login_payload(u, {
            "action": "claim_existing",
            "message": f"已把飞书「{fs_name}」绑定到账号「{u.username}」，此后扫码即可登录",
        })


# -------------------------------------------------------------------------
# 合并：救回改版前已经被"自动建号"占住身份的存量用户
# -------------------------------------------------------------------------

class FeishuMergeIn(BaseModel):
    merge_token: str


class ClaimLegacyIn(BaseModel):
    username: str
    password: str


@router.post("/feishu/merge")
async def feishu_merge(payload: FeishuMergeIn, request: Request,
                       user: User = Depends(get_current_user)):
    """登录态在**老账号**：确认合并 /feishu/link 返回的那个空白号。

    鉴权靠两件事同时成立：
      ① 当前 bearer 证明你是老账号本人
      ② merge_token 由刚才那次扫码换来，且签发时就钉死了 dst_user_id
    """
    try:
        data = await am.peek_token("merge", payload.merge_token)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if int(data.get("dst_user_id") or 0) != user.id:
        # token 不是发给这个账号的 —— 换了登录态就别想用
        raise HTTPException(403, "合并凭证与当前登录账号不匹配，请重新扫码")

    ip = request.client.host if request.client else ""
    ua = request.headers.get("user-agent", "")

    async with session_scope() as s:
        src = await s.get(User, int(data["src_user_id"]))
        dst = await s.get(User, user.id)
        if not src or not dst:
            raise HTTPException(404, "账号不存在")
        if src.feishu_union_id != data.get("union_id"):
            raise HTTPException(409, "该飞书账号的绑定关系已发生变化，请重新扫码")
        if not am.is_feishu_auto_account(src):
            raise HTTPException(403, "对方不是扫码自动创建的账号，不能自助合并，请联系管理员")

        await am.consume_token("merge", payload.merge_token)
        out = await am.merge_accounts(s, src=src, dst=dst, actor_user_id=dst.id,
                                      reason="self_merge_from_legacy_account",
                                      ip=ip, ua=ua)
        await s.refresh(dst)
        return _login_payload(dst, {
            "action": "merged",
            "merged_from": {"id": src.id, "username": src.username},
            "moved": out["moved"],
            "message": (f"已把「{src.username}」并入当前账号，"
                        "此后请用飞书扫码登录"),
        })


@router.post("/feishu/claim-legacy")
async def feishu_claim_legacy(payload: ClaimLegacyIn, request: Request,
                              user: User = Depends(get_current_user)):
    """登录态在**扫码自动建的新号**：输入原账号密码，把当前号并回去。

    这是给存量受害者的主路径：他们现在多半就正登录在那个空白号里，
    根本意识不到自己还有个老账号。要求他先退出去、用密码登老号、再扫一次码
    才能合并，实际上没人走得完。这里让他原地输一次老账号密码即可。

    鉴权同样是两个因素：当前登录态（= 持有飞书身份）+ 老账号密码。
    """
    if not am.is_feishu_auto_account(user):
        raise HTTPException(400,
            "当前账号不是扫码自动创建的账号，无需合并。"
            "若要把飞书绑到别的账号，请先登录那个账号再扫码绑定。")

    ip = request.client.host if request.client else ""
    ua = request.headers.get("user-agent", "")

    async with session_scope() as s:
        dst = (await s.execute(select(User).where(
            (User.username == payload.username) | (User.login_id == payload.username)
        ))).scalar_one_or_none()
        if not dst or not dst.password_hash or not verify_password(payload.password, dst.password_hash):
            raise HTTPException(401, "用户名或密码错误")
        if dst.id == user.id:
            raise HTTPException(400, "不能和自己合并")
        if dst.status != "active":
            raise HTTPException(403, f"目标账号状态：{dst.status}")
        if dst.feishu_union_id:
            raise HTTPException(400,
                f"账号「{dst.username}」已经绑定了另一个飞书身份，请联系管理员处理")

        src = await s.get(User, user.id)
        out = await am.merge_accounts(s, src=src, dst=dst, actor_user_id=dst.id,
                                      reason="self_claim_legacy_account",
                                      ip=ip, ua=ua)
        await s.refresh(dst)
        return _login_payload(dst, {
            "action": "merged",
            "merged_into": {"id": dst.id, "username": dst.username},
            "moved": out["moved"],
            "message": (f"已并入你的原账号「{dst.username}」，"
                        "两边的草稿现在都在这一个账号下；此后扫码即可登录"),
        })


@router.post("/feishu/unlink")
async def feishu_unlink(user: User = Depends(get_current_user)):
    """解绑飞书。

    ⚠️ 绑定时会清空密码，所以解绑 = 自断唯一的登录方式，
    解完就再也进不来了（密码没了、飞书也解了）。这里直接禁止，
    确有需要由管理员在后台操作 —— 后台的解绑接口
    (`POST /v1/admin-api/users/{id}/feishu/unlink`) **强制同时重设密码**，
    这两步必须原子：dev 库里就有一个账号是"人工解了绑却没补密码"，
    从此 has_pwd=false / fs_bound=false，永久登不进来。
    """
    raise HTTPException(
        403,
        "绑定飞书后账号仅支持扫码登录，自助解绑会导致无法登录。"
        "如确需解绑，请联系管理员处理。",
    )
