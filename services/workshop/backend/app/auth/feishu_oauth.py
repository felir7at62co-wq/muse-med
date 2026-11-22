"""飞书网页扫码登录(OAuth 授权码流程)。

与 feishu/client.py 的区别:
  - feishu/client.py 用 **tenant_access_token**, 代表"应用"身份, 读写多维表格
  - 本模块用 **app_access_token + user_access_token**, 代表"登录用户"身份

准入控制不在我们这边做白名单, 而是靠飞书应用的【可用范围】:
  不在可用范围内的员工, 在飞书授权页就会被拒, 根本拿不到 code。
  员工离职被移出通讯录后自动失去访问权 —— 生命周期交给飞书管, 我们不维护名单。

绑定键用 union_id(见 auth/models.py 注释)。
"""
from __future__ import annotations

import logging
from typing import Any
from urllib.parse import quote

import httpx

from ..config import get_settings
from . import ephemeral as eph

logger = logging.getLogger("auth.feishu")

# state 防 CSRF。存 Redis(见 ephemeral 模块): 进程内存 dict 有三个坑 ——
# 重放/超时分不开、orchestrator 一重启全丢、加 --workers 后签发与回调不在同一进程。
# 生产上「state 无效或已过期」的报错就是这么来的。
#
# TTL 从 300s 提到 1800s: state 是**渲染二维码时**就签发的, 用户把登录页
# 晾几分钟再扫是常态。原注释说的"飞书 code 有效期 5 分钟"是**扫完之后**
# 才开始算的另一个计时器, 两者不是一回事, 不该拿它来卡 state。
# state 一次性且只做 CSRF 防护, 放宽窗口的代价可接受。
_STATE_TTL = 1800
_NS = "state"


def _cfg() -> tuple[str, str, str]:
    s = get_settings()
    app_id = (s.feishu_app_id or "").strip()
    secret = (s.feishu_app_secret or "").strip()
    base = (s.feishu_base_url or "https://open.feishu.cn").rstrip("/")
    if not app_id or not secret:
        raise RuntimeError("FEISHU_APP_ID / FEISHU_APP_SECRET 未配置, 无法使用飞书登录")
    return app_id, secret, base


async def issue_state(purpose: str = "login", bind_user_id: int | None = None) -> str:
    """签发一次性 state。purpose: login(扫码登录) / bind(已登录用户绑定)。"""
    st = eph.new_token()
    await eph.put(_NS, st, {"purpose": purpose, "bind_user_id": bind_user_id},
                  _STATE_TTL)
    return st


async def consume_state(state: str) -> tuple[str, int | None]:
    """校验并**消费** state(一次性)。返回 (purpose, bind_user_id)。

    失败抛 `eph.EphemeralError`(ValueError 子类), 带 `code` 区分
    used / expired / unknown, 调用方据此给出不同的引导文案。
    """
    if not state:
        raise eph.EphemeralError("unknown", "登录链接缺少 state，请返回登录页重新扫码。")
    data = await eph.consume(_NS, state)
    return data.get("purpose") or "login", data.get("bind_user_id")


def build_authorize_url(redirect_uri: str, state: str) -> str:
    """构造飞书授权页 URL。用户在此扫码/免登。"""
    app_id, _, base = _cfg()
    # ⚠️ 内嵌二维码 SDK 的 goto 必须用 passport 端点(OAuth2 风格, client_id +
    # response_type)。用 open-apis/authen/v1/index 那个旧端点时, SDK 的 iframe
    # 里会显示 "The page does not exist" —— 页面本身没错, 是端点不被 SDK 支持。
    # 实测: 两个端点直连都返回 200, 差异只在 iframe 内嵌场景, 很难从报错看出来。
    return ("https://passport.feishu.cn/suite/passport/oauth/authorize"
            f"?client_id={app_id}"
            f"&redirect_uri={quote(redirect_uri, safe='')}"
            f"&response_type=code"
            f"&state={quote(state, safe='')}")


async def _app_access_token() -> str:
    """自建应用的 app_access_token。

    注意: 换 code 用的是 app_access_token, **不是** tenant_access_token,
    两者不能混用(混用会报权限错误, 排查起来很费时)。
    这里不做缓存 —— 登录是低频操作, 每次重取更简单也更不容易出错。
    """
    app_id, secret, base = _cfg()
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{base}/open-apis/auth/v3/app_access_token/internal",
                         json={"app_id": app_id, "app_secret": secret})
    j = r.json()
    if j.get("code") != 0:
        raise RuntimeError(f"获取 app_access_token 失败: code={j.get('code')} {j.get('msg')}")
    return j["app_access_token"]


async def exchange_user_info(code: str) -> dict[str, Any]:
    """用登录预授权码换用户身份。返回飞书 user_info 原始字段。

    关键字段: union_id(绑定键) / open_id / name / avatar_url。
    email、mobile、user_id、employee_no 属敏感字段, 未单独申请权限时为空,
    所以**不要**依赖它们做业务判断。
    """
    _, _, base = _cfg()
    app_token = await _app_access_token()
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(
            f"{base}/open-apis/authen/v1/access_token",
            headers={"Authorization": f"Bearer {app_token}",
                     "Content-Type": "application/json; charset=utf-8"},
            json={"grant_type": "authorization_code", "code": code},
        )
    j = r.json()
    if j.get("code") != 0:
        # 20003 = code 无效/已用过/过期(飞书 code 只能用一次, 有效期 5 分钟)
        raise RuntimeError(f"飞书授权失败: code={j.get('code')} {j.get('msg')}")
    data = j.get("data") or {}
    union_id = (data.get("union_id") or "").strip()
    if not union_id:
        raise RuntimeError("飞书未返回 union_id, 无法绑定身份(请检查应用权限配置)")
    return data
