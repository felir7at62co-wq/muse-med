"""积分账户与额度划拨（P1，2026-10-14）。

| 方法 | 路径 | 谁能用 |
|---|---|---|
| GET  | /v2/budget/me | 登录者本人（顶栏余额用它） |
| GET  | /v2/budget/overview | 本人 + 全部后代的总余额/总花费 |
| GET  | /v2/budget/org | 管理员：全树；大小组长：**自己的子树** + 无组的人；生成师 403 |
| POST | /v2/budget/org/members | 管理员 / 大小组长：拉人进组、换上级、任命（按子树鉴权） |
| DELETE | /v2/budget/org/members/{user_id} | 同上：移出组 → 变成无组 |
| PUT  | /v2/budget/org | 仅最高管理员：覆盖式批量重写（播种/急救用） |
| GET  | /v2/budget/candidates | 管理员：全平台人员；组长：只回无组的人 |
| POST | /v2/budget/grant | 管理员 / 大小组长：下拨给子树里任何人（组长扣自己余额） |
| POST | /v2/budget/revoke | 同上：收回（回到收回者身上） |
| GET  | /v2/budget/users/{user_id} | 本人 / 子树上方任何一级 / 管理员：某人的账户与流水 |

权限规则全在 `app/budget.py`（`Actor` / `in_scope` / `set_member` 的拒绝表），
这里只做 HTTP 状态码翻译：PermissionError→403、ValueError→400、LookupError→404。
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import access, budget
from ..config import get_settings
from ..db import get_session
from ..err_text import human_error

log = logging.getLogger(__name__)

router = APIRouter(prefix="/v2", tags=["budget"])


class UserIn(BaseModel):
    user_id: int
    name: Optional[str] = None
    role: str = "生成师"
    manager_id: Optional[int] = None
    active: bool = True


class OrgIn(BaseModel):
    users: list[UserIn] = Field(default_factory=list)
    root_user_id: Optional[int] = None
    #: 名单即全量：不在名单里的人标为非在岗。**默认 False**（见 reconfigure 说明）。
    #: 编辑页已改走 /budget/org/members 增量接口，不再用它；只留给急救脚本。
    deactivate_missing: bool = False


class MemberIn(BaseModel):
    user_id: int
    manager_id: int
    role: str = "生成师"
    name: Optional[str] = None


class AmountIn(BaseModel):
    user_id: int
    amount_yuan: float


@router.get("/budget/me")
def my_credit() -> dict:
    """当前登录者的积分。顶栏余额就是这个数。"""
    try:
        return budget.my_balance()
    except PermissionError as e:
        raise HTTPException(401 if "登录" in str(e) else 403, str(e)) from e


@router.get("/budget/overview")
def overview() -> dict:
    """我这条线（本人 + 全部后代）的总余额与总花费。

    管理员看的是**全树**（所有最高管理员往下），组长看自己的子树。
    无组的人不在任何一条线里——包括管理员那条（见 budget 模块头「无组」）。
    """
    from ..db import BudgetPool, get_session
    try:
        a = budget.current_actor()
    except PermissionError as e:
        raise HTTPException(401, str(e)) from e
    pool_id = budget.ROOT_POOL if a.is_root else budget.MEMBER_PREFIX + str(a.uid)
    with get_session() as s:
        mine = s.get(BudgetPool, budget.MEMBER_PREFIX + str(a.uid))
        fen = int(mine.balance_fen or 0) if mine else 0
    desc = budget.descendants_of(pool_id)
    sub = budget.subtree_usage(pool_id)
    usage = budget.user_usage(a.uid)
    return {
        "pool_id": pool_id,
        # 前端拿它显示"我：大组长"。与 /budget/me 的 role 同一来源（budget.current_actor），
        # 两处不各自推断——否则同一页会出现两个"我的角色"。
        "role": budget.ROLE_ADMIN if a.is_root else a.role,
        "unlimited": a.is_root,
        "can_edit": a.can_edit,
        "self_available_fen": fen,
        "self_available_yuan": budget._yuan(fen),
        "self_spent_fen": usage["spent_fen"],
        "self_spent_yuan": usage["spent_yuan"],
        "subtree": sub,
        "descendant_pools": len(desc),
    }


@router.get("/budget/org")
def get_org() -> dict:
    # ⚠️ 必须接住 PermissionError：不接就是 500，而前端靠 **403** 判定
    #    "这个人是生成师、没有下辖" 并据此藏起成员表。500 会被当成真故障弹错误条
    #    ——每个普通生成师打开积分页都会看到一条报错。
    try:
        return budget.list_org(budget._require_editor())
    except PermissionError as e:
        raise HTTPException(401 if "登录" in str(e) else 403, str(e)) from e


@router.post("/budget/org/members")
def set_member(body: MemberIn) -> dict:
    """拉人进组 / 换上级 / 任命。返回更新后的（按操作者裁剪的）组织树。"""
    try:
        r = budget.set_member(body.user_id, body.manager_id, body.role, body.name)
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"member": r, **budget.list_org()}


@router.delete("/budget/org/members/{user_id}")
def remove_member(user_id: int) -> dict:
    """移出组 → 无组。**不是停用**，余额留在他身上（要收回先调 /budget/revoke）。"""
    try:
        r = budget.remove_member(user_id)
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"member": r, **budget.list_org()}


@router.get("/budget/candidates")
def candidates(q: str = "") -> dict:
    """可选的人：组织里还没有账户的、以及搜得到的历史登录者。

    组织编辑页要"把谁加进来"，而库里**没有用户表**——唯一的人口来源是
    `auth_sessions`（同 library.set_project_owner 的限制）。所以这里做两件事：

      · 已经在组织里的 → 带上现状（角色/上级/余额），供编辑现有行；
      · 登录过但还没进组织的 → 作为"可添加"的人列出来。

    ⚠️ 只回「用户id / 用户名 / 显示名 / 平台角色」，**不含任何 token**
    （`auth_sessions` 存的是摘要，本来也拿不到；这里连摘要都不读出来）。
    管理员拿到全平台名单；**大小组长只拿到无组的人**——他们要能"把没有组的人
    拉进来"，但不该借此看到别的组的人员与结构。
    """
    from ..db import UserBudget, get_session
    try:
        a = budget._require_editor()
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e

    kw = (q or "").strip()
    with get_session() as s:
        org = {int(u.user_id): u for u in s.query(UserBudget).all()}
        # 人口来源用**用户名录**（auth.KnownUser，不随会话过期）∪ 现存会话。
        # ⚠️ 此前只读 auth_sessions：会话一过期、启动时被清掉，这个人就从
        # 「拉人进组」的候选里消失了（与项目转交是同一个坑，2026-10-15 一并修）。
        from .library import _user_directory
        seen: dict[int, dict] = {}
        for uid, u in _user_directory(s).items():
            seen[int(uid)] = {"user_id": int(uid), "username": u["username"],
                              "display_name": u["display_name"] or u["username"],
                              "platform_role": u["role"] or "user"}
    people = []
    for uid, info in seen.items():
        row = org.get(uid)
        info["in_org"] = row is not None
        info["org_role"] = (budget.canon_role(row.org_role) or row.org_role) if row else None
        info["manager_id"] = row.manager_id if row else None
        info["active"] = bool(row.active) if row else False
        people.append(info)
    # 组织里可能有**从没在这台机器登录过**的人（管理员手工加的），也要带上
    for uid, row in org.items():
        if uid not in seen:
            people.append({"user_id": uid, "username": "",
                           "display_name": row.name or str(uid),
                           "platform_role": "user", "in_org": True,
                           "org_role": budget.canon_role(row.org_role) or row.org_role,
                           "manager_id": row.manager_id,
                           "active": bool(row.active)})
    if kw:
        low = kw.lower()
        people = [p for p in people
                  if low in (p["display_name"] or "").lower()
                  or low in (p["username"] or "").lower()
                  or kw in str(p["user_id"])]
    if not a.is_root:
        admins = budget._platform_admin_ids()
        people = [p for p in people
                  if not budget.is_root_role(p["org_role"])
                  and p["user_id"] not in admins
                  and (not p["in_org"] or p["manager_id"] is None)]
    people.sort(key=lambda p: (not p["in_org"], p["user_id"]))
    return {"people": people[:200], "truncated": len(people) > 200}


@router.put("/budget/org")
def put_org(body: OrgIn) -> dict:
    # ⚠️ 这里用 **_require_org_admin**（仅最高管理员），不是 `_require_editor`。
    #    reconfigure 是覆盖式的，拿到它的人可以把任何人改成任何角色——实测过一个
    #    组长一次请求就把自己和总控对调了。组长的日常操作走 /budget/org/members。
    try:
        budget._require_org_admin()
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e
    try:
        n = budget.reconfigure([u.model_dump() for u in body.users],
                               root_user_id=body.root_user_id,
                               deactivate_missing=body.deactivate_missing)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"synced": n, **budget.list_org()}


@router.post("/budget/grant")
def grant(body: AmountIn) -> dict:
    from .. import notify
    try:
        r = budget.grant_to_member(body.user_id, body.amount_yuan)
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    # 通知在钱到账**之后**发，失败不影响分配结果。
    # 管理员分配 = 没走审批 → 已在 grant_to_member 事务里计入未审批台账，这里只提醒
    # **被分配的人**尽快补审批（通知里不写未审批金额：台账只给管理员看）；
    # 组长/小组长分配 = 用他自己的余额，不计入未审批，只通知**分配人本人**（2026-10-17）。
    try:
        who = access.current_user_id()
        if budget.current_actor().is_root:
            notify.on_direct_grant(body.user_id, int(r.get("granted_fen") or 0), who)
        else:
            notify.on_leader_grant(body.user_id, int(r.get("granted_fen") or 0), who)
    except Exception:  # noqa: BLE001 通知失败不能连累下拨
        pass
    return r


@router.post("/budget/revoke")
def revoke(body: AmountIn) -> dict:
    try:
        return budget.revoke_from_member(body.user_id, body.amount_yuan)
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/budget/users/{user_id}")
def user_account(user_id: int, with_usage: bool = True) -> dict:
    try:
        out = budget.account(user_id)
    except LookupError as e:
        raise HTTPException(404, str(e)) from e
    except PermissionError as e:
        raise HTTPException(403, str(e)) from e
    if with_usage:
        out["usage"] = budget.user_usage(user_id)
    return out


# ---------------------------------------------------------------------------
# 飞书审批 → 积分（方案 B，2026-10-15）。逻辑全在 app/approval_sync.py
# ---------------------------------------------------------------------------

def _admin_or_403() -> int:
    try:
        return budget._require_org_admin()
    except PermissionError as e:
        raise HTTPException(403, "只有管理员可以操作审批设置") from e


def _me_or_401() -> int:
    uid = access.current_user_id()
    if uid is None:
        raise HTTPException(401, "需要登录")
    return int(uid)


class RefreshIn(BaseModel):
    #: true = 管理员「全部刷新」；false = 只看我自己的单（大组长「刷新积分」）
    all: bool = False


@router.post("/budget/approvals/refresh")
def refresh_approvals(body: RefreshIn) -> dict:
    """读飞书审批 → 已通过的自动拨款。**只在点按钮时读**（用户裁定不轮询）。"""
    from .. import approval_sync
    who = None if body.all else _me_or_401()
    if body.all:
        _admin_or_403()
    r = approval_sync.sync(who)
    me = budget.my_balance() if who is not None else None
    return {"ok": r.ok, "message": r.message, "checked": r.checked,
            "new_granted": r.new_granted, "review": r.review, "errors": r.errors,
            "cached": r.cached, "at": r.finished_at, "me": me}


@router.get("/budget/approvals")
def list_approvals(all: bool = False, limit: int = 100) -> dict:
    """审批单在本地的处理记录。普通人看自己的，管理员 `all=true` 看全部。"""
    from ..approval_sync import _row_out
    from ..db import BudgetRequest, get_session
    uid = _me_or_401()
    if all:
        _admin_or_403()
    with get_session() as s:
        q = s.query(BudgetRequest)
        if not all:
            q = q.filter((BudgetRequest.target_id == uid) | (BudgetRequest.applicant_id == uid))
        rows = q.order_by(BudgetRequest.submitted_at.desc()).limit(max(1, min(limit, 500))).all()
        return {"items": [_row_out(r) for r in rows]}


class ResolveIn(BaseModel):
    action: str        # grant | dismiss


@router.post("/budget/approvals/{code}/resolve")
def resolve_approval(code: str, body: ResolveIn) -> dict:
    """管理员处理「待人工」的单：照常拨款 / 不拨。"""
    from .. import approval_sync
    by = _admin_or_403()
    try:
        return approval_sync.resolve(code, body.action, by)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


class TemplateIn(BaseModel):
    approval_code: str
    name: Optional[str] = None
    enabled: bool = True
    amount_widget_id: str
    amount_unit: str = "yuan"
    target: str = "initiator"
    allowed_roles: str = "大组长"
    max_yuan: Optional[float] = None
    approver_union_ids: Optional[str] = None
    start_at: str
    source: str = "native"


def _tpl_out(t) -> dict:
    return {"approval_code": t.approval_code, "name": t.name, "enabled": bool(t.enabled),
            "amount_widget_id": t.amount_widget_id, "amount_unit": t.amount_unit,
            "target": t.target, "allowed_roles": t.allowed_roles,
            "max_yuan": (t.max_fen or 0) / 100, "approver_union_ids": t.approver_union_ids,
            "start_at": t.start_at, "source": t.source, "synced_until": t.synced_until}


@router.get("/budget/approval-templates")
def list_templates() -> dict:
    from ..db import ApprovalTemplate, get_session
    _admin_or_403()
    with get_session() as s:
        return {"items": [_tpl_out(t) for t in s.query(ApprovalTemplate).all()]}


@router.post("/budget/approval-templates/inspect")
def inspect_template(body: dict) -> dict:
    """读飞书上的审批定义（名字 + 表单控件），供管理员选"哪个是金额"。
    这也是开通权限后的第一道自检：读得到 = 权限已生效。"""
    from .. import feishu_open
    _admin_or_403()
    code = str((body or {}).get("approval_code") or "").strip()
    if not code:
        raise HTTPException(422, "缺 approval_code")
    try:
        d = feishu_open.get_definition(code)
    except feishu_open.FeishuError as e:
        raise HTTPException(502, e.user_text()) from e
    return {"name": d["name"],
            "widgets": [{"id": w.get("id"), "name": w.get("name"), "type": w.get("type")}
                        for w in d["widgets"] if isinstance(w, dict)]}


@router.put("/budget/approval-templates")
def save_template(body: TemplateIn) -> dict:
    from datetime import datetime
    from ..db import ApprovalTemplate, get_session
    _admin_or_403()
    if body.amount_unit not in ("yuan", "fen"):
        raise HTTPException(422, "amount_unit 只能是 yuan / fen")
    if not (body.target == "initiator" or body.target.startswith("widget:")):
        raise HTTPException(422, "target 只能是 initiator 或 widget:<控件id>")
    if body.source not in ("native", "shotflow"):
        raise HTTPException(422, "source 只能是 native / shotflow")
    try:
        datetime.fromisoformat(body.start_at)
    except ValueError as e:
        raise HTTPException(422, "start_at 必须是 ISO 时间，如 2026-10-16T00:00:00+08:00") from e
    now = budget._now()
    with get_session() as s:
        t = s.get(ApprovalTemplate, body.approval_code.strip())
        if t is None:
            t = ApprovalTemplate(approval_code=body.approval_code.strip(), created_at=now,
                                 amount_widget_id=body.amount_widget_id, start_at=body.start_at)
            s.add(t)
        elif t.start_at != body.start_at:
            # 起点往前挪 = 重新扫更早的单；往后挪也要重扫。清水位，让下次刷新按新起点发现
            t.synced_until = None
        t.name, t.enabled = body.name, 1 if body.enabled else 0
        t.amount_widget_id, t.amount_unit = body.amount_widget_id.strip(), body.amount_unit
        t.target, t.allowed_roles = body.target.strip(), body.allowed_roles
        t.max_fen = int(round((body.max_yuan or 0) * 100))
        t.approver_union_ids = (body.approver_union_ids or "").strip() or None
        t.start_at, t.source, t.updated_at = body.start_at, body.source, now
        s.commit()
        return _tpl_out(t)


# ---------------------------------------------------------------------------
# 通知文案与自检（2026-10-15）
#
# 文案存在 DB 里可覆盖（notify_templates），但"能改"和"改得到"是两回事——
# 没有编辑入口的话，那句覆盖能力就是纸面上的。这里给它一个入口，顺带一个
# "发一条给自己看看"的自检：飞书这条路出问题时，肉眼看得出是哪一段断了。
# ---------------------------------------------------------------------------

class NotifyTplIn(BaseModel):
    #: 事件名（notify.EVENT_LABEL 的键）
    event: str
    #: 空 = 删除覆盖，退回代码里的默认文案
    text: Optional[str] = None


@router.get("/budget/notify-templates")
def list_notify_templates() -> dict:
    """默认文案 + DB 覆盖，一起给出来（前端直接渲染，不在前端再抄一遍默认值）。"""
    from .. import notify
    from ..config import get_settings
    from ..db import NotifyTemplate, get_session
    _admin_or_403()
    over = {}
    with get_session() as s:
        for t in s.query(NotifyTemplate).all():
            over[t.event] = t.text
    return {"events": [{"event": k, "label": notify.EVENT_LABEL.get(k, k),
                        "default_text": v, "text": over.get(k, ""),
                        "overridden": k in over}
                       for k, v in notify.DEFAULTS.items()],
            "contact": get_settings().feishu_notify_contact,
            "enabled": bool(get_settings().feishu_notify_enabled)}


@router.put("/budget/notify-templates")
def save_notify_template(body: NotifyTplIn) -> dict:
    from .. import notify
    from ..db import NotifyTemplate, get_session
    _admin_or_403()
    ev = (body.event or "").strip()
    if ev not in notify.DEFAULTS:
        raise HTTPException(422, f"未知事件：{ev}")
    text = (body.text or "").strip()
    with get_session() as s:
        row = s.query(NotifyTemplate).filter(NotifyTemplate.event == ev).first()
        if not text:                       # 清空 = 恢复默认
            if row is not None:
                s.delete(row)
            s.commit()
            return {"event": ev, "overridden": False, "text": notify.DEFAULTS[ev]}
        if row is None:
            row = NotifyTemplate(event=ev, text=text)
            s.add(row)
        else:
            row.text = text
        s.commit()
    return {"event": ev, "overridden": True, "text": text}


@router.post("/budget/notify-test")
def notify_test() -> dict:
    """给自己发一条样例通知，验证"这条路通不通"。

    只发给**操作者本人**（拿他自己的 union_id），不发别人——自检不该变成
    "管理员一键骚扰全员"的口子。文案里的数字都是样例值。
    """
    from .. import notify
    uid = _me_or_401()
    if not notify._union_of(uid):
        raise HTTPException(409, "你的账号没有飞书身份（没通过飞书扫码登录过镜流），发不了")
    ok = notify.notify(uid, "approval_granted", amount_fen=10000, balance_fen=13500)
    if not ok:
        raise HTTPException(502, "发送失败，看后端日志里 [notify] 那几行")
    with notify.get_session() as s:
        row = s.query(notify.FeishuNotifyLog).order_by(notify.FeishuNotifyLog.ts.desc()).first()
        text = row.text if row else ""
    return {"ok": True, "text": text}


@router.get("/budget/notify-log")
def notify_log(limit: int = 50) -> dict:
    """最近的发送留痕。**给管理员看的排查入口**：
    "他到底收到没有"不该只能靠问当事人。文本是通知正文（不含任何令牌）。"""
    from ..db import FeishuNotifyLog, get_session, UserBudget
    _admin_or_403()
    n = max(1, min(int(limit or 50), 200))
    with get_session() as s:
        rows = (s.query(FeishuNotifyLog).order_by(FeishuNotifyLog.ts.desc()).limit(n).all())
        names = {int(u.user_id): u.name for u in s.query(UserBudget).all()}
        return {"items": [{"ts": r.ts, "user_id": r.user_id,
                           "name": names.get(r.user_id) or f"用户 {r.user_id}",
                           "event": r.event, "status": r.status,
                           "text": r.text, "detail": r.detail} for r in rows]}


# ---------------------------------------------------------------------------
# 群发公告（2026-10-19）
#
# 管理员在积分页发一条公告给飞书用户。此前发公告只能人肉跑脚本（10-17、10-19
# 两次都是），收件人从 known_users 现查、没有界面、没有二次确认，且事后只能翻
# 留痕表才知道发给了谁、谁没收到。这里把三件事做进产品：
#   ① 预览收件人（谁在范围里、谁没有飞书身份收不到）；
#   ② 发送并逐人留痕（沿用 notify 的 FeishuNotifyLog，事件名 `announcement`）；
#   ③ 发送后如实回报成功/失败/跳过，失败原因原样带回。
#
# ⚠️ 三个刻意的约束：
#   · **只发给有飞书身份的人**（没有 union_id 的人不是"发失败了"，是发不到，
#     单独列为 skipped，不让管理员误以为发出去了）；
#   · **同一个 union_id 只发一次**（名录里可能有历史重复行）；
#   · **幂等护栏**：10 分钟内内容相同且范围相同的公告拒绝重复提交 ——
#     群发不可撤回，"手抖点了两次"是这类功能最贵的错误。

#: 公告正文长度上限。飞书单条文本消息远大于此，这里限的是"人能审阅的长度"：
#: 一次群发的成本不可撤回，长到没人看完就等于没人审过。
ANNOUNCE_MAX = 2000
#: 同一管理员在这么多秒内重复提交**相同内容 + 相同范围**视为误触。
ANNOUNCE_DEDUP_SEC = 600


class AnnounceIn(BaseModel):
    """群发公告。`user_ids=None` 或空 = 全平台（所有有飞书身份的用户）。

    `dry_run=True` 只返回收件人名单，不发。
    """
    text: str
    user_ids: list[int] | None = None
    dry_run: bool = False


def _announce_recipients(user_ids: list[int] | None) -> tuple[list[dict], list[dict]]:
    """返回 (能发的, 收不到的)。按 known_users 名录取飞书身份，同一身份去重。

    `name` 取名录里的显示名，取不到再退回积分组织的名字，最后退回 id ——
    名录和组织的名字两个来源都可能缺（有人从没打开过积分页）。
    """
    from ..auth import KnownUser
    from ..db import UserBudget
    with get_session() as s:
        rows = s.query(KnownUser).all()
        org = {int(u.user_id): (u.name or "") for u in s.query(UserBudget).all()}
    want = {int(x) for x in user_ids} if user_ids else None
    sendable: list[dict] = []
    unreachable: list[dict] = []
    seen: set[str] = set()
    for r in sorted(rows, key=lambda x: int(x.user_id or 0)):
        uid = int(r.user_id or 0)
        if want is not None and uid not in want:
            continue
        name = (r.display_name or org.get(uid) or r.username or f"用户 {uid}")
        union = (r.feishu_union_id or "").strip()
        if not union:
            unreachable.append({"user_id": uid, "name": name, "reason": "没有飞书身份"})
            continue
        if union in seen:
            continue
        seen.add(union)
        sendable.append({"user_id": uid, "name": name})
    return sendable, unreachable


@router.get("/budget/announce/recipients")
def announce_recipients(q: str = "", limit: int = 500) -> dict:
    """可选的收件人清单（界面上的勾选列表）。只回有飞书身份的人 + 总数。

    `q` 按显示名/用户名模糊匹配；`limit` 只截返回的**列表**，`total` 始终是全量，
    免得界面把"没显示全"误报成"平台就这么多人"。
    """
    _admin_or_403()
    sendable, unreachable = _announce_recipients(None)
    q = (q or "").strip().lower()
    hits = [x for x in sendable if not q or q in x["name"].lower()]
    n = max(1, min(int(limit or 500), 2000))
    return {"total": len(sendable), "matched": len(hits),
            "items": hits[:n], "unreachable": len(unreachable)}


@router.post("/budget/announce")
def announce(body: AnnounceIn) -> dict:
    """群发公告给飞书用户。**不可撤回**，所以：先预览、再发送、逐人留痕、如实回报。"""
    from .. import feishu_open, notify
    admin = _admin_or_403()
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "公告内容不能为空")
    if len(text) > ANNOUNCE_MAX:
        raise HTTPException(400, f"公告太长（{len(text)} 字），上限 {ANNOUNCE_MAX} 字")
    sendable, unreachable = _announce_recipients(body.user_ids)
    if not sendable:
        raise HTTPException(400, "这个范围里没有能收到飞书消息的用户")
    if body.dry_run:
        return {"dry_run": True, "would_send": len(sendable), "unreachable": unreachable,
                "recipients": sendable}

    if not bool(getattr(get_settings(), "feishu_notify_enabled", True)):
        raise HTTPException(409, "飞书通知当前是关闭的（FW_FEISHU_NOTIFY_ENABLED=0）")
    if not feishu_open.configured():
        raise HTTPException(409, "飞书应用凭据未配置，发不了")

    # 幂等护栏：内容 + 范围完全相同、且在冷却窗口内 → 视为误触
    import hashlib
    import json as _json
    sig = hashlib.sha256(_json.dumps(
        {"t": text, "u": sorted(x["user_id"] for x in sendable)},
        ensure_ascii=False).encode()).hexdigest()[:16]
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=ANNOUNCE_DEDUP_SEC)
              ).isoformat(timespec="seconds")
    with get_session() as s:
        from ..db import FeishuNotifyLog
        dup = (s.query(FeishuNotifyLog)
               .filter(FeishuNotifyLog.event == f"announcement:{sig}",
                       FeishuNotifyLog.ts >= cutoff).first())
    if dup is not None:
        raise HTTPException(
            409, f"同样的公告刚发过（{dup.ts[:16].replace('T', ' ')}，"
                 f"发给 {len(sendable)} 人）。群发不可撤回，确认要重发请改一下内容或范围")

    sent, failed = 0, []
    for r in sendable:
        union = notify._union_of(r["user_id"])
        try:
            feishu_open.call("POST", "/open-apis/im/v1/messages",
                             params={"receive_id_type": "union_id"},
                             body={"receive_id": union, "msg_type": "text",
                                   "content": _json.dumps({"text": text}, ensure_ascii=False)},
                             timeout=10.0)
            notify._record(r["user_id"], f"announcement:{sig}", text, "sent",
                           f"群发公告 by {admin}")
            sent += 1
        except Exception as e:  # noqa: BLE001 单人失败不影响其他人
            failed.append({"user_id": r["user_id"], "name": r["name"],
                           "error": human_error(e, 160)})
            notify._record(r["user_id"], f"announcement:{sig}", "", "failed", repr(e)[:280])
    log.info("[announce] 管理员 %s 群发公告：成功 %d，失败 %d，收不到 %d",
             admin, sent, len(failed), len(unreachable))
    return {"sent": sent, "failed": failed, "unreachable": unreachable,
            "total": len(sendable), "sig": sig}
