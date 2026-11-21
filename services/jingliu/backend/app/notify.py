"""积分相关的飞书机器人通知（2026-10-15）。

## 发给谁、发什么

事件 → 收件人：
  · `approval_granted` 审批通过并到账        → 申请人（大组长）
  · `direct_grant`      管理员直接分配（无审批）→ 被分配的人
  · `grant_from_leader` 组长/小组长用自己的额度分配 → **分配人本人**（2026-10-17 用户裁定）
  · `rejected`          审批被驳回 / 撤回      → 申请人

措辞全部走模板（`notify_templates` 表可覆盖代码里的默认值），叫法如"找管理员甲反馈"
里的那个名字在 `FW_FEISHU_NOTIFY_CONTACT`，都不写死在逻辑里。

## 「其中 XXX 未审批」是怎么算的

用户的原话是"管理员直接分配额度时，要提醒他还有多少没走审批"。所以单独记一笔台账
（`budget_unapproved`）：**管理员直接分配**（无审批依据）时累加；之后**审批通过拨款**时
冲减（下限 0）——即那张审批单把以前"先垫后补"的部分补上了。
组长从自己余额里往下分配**不计入**：那是他自己池子里的钱，不是平台的垫付。

## 三条硬规矩

1. **绝不因为它失败而影响正事**：发消息失败只记日志与日志表，钱该拨的还是拨。
2. **无 union_id 的人不发**（没登录过平台 = 拿不到飞书身份），记 `skipped` 而不是报错。
3. **每次发送留痕**（`feishu_notify_log`）：否则"他到底收到没有"永远只能靠问。
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from .config import get_settings
from .db import BudgetUnapproved, FeishuNotifyLog, NotifyTemplate, get_session

log = logging.getLogger(__name__)

#: 北京时间（用户要求按北京时间问好）
_CST = timezone(timedelta(hours=8))

#: 通知里自称的平台名是「LimuGen」（2026-10-17 由「镜流」改名；前端显示名是
#: 「LimuGen灵幕」，用户点名飞书通知只用「LimuGen」）。

#: 没配审批模板时 `{apply_form}` 的兜底叫法。**不写具体表单名**：写了而飞书里
#: 没有这个表单，用户照着去搜会扑空。
_APPLY_FORM_FALLBACK = "积分申请审批"

#: 事件 → 默认文案。占位符见 _render()。
#: ⚠️ **生产专属（2026-10-17 上线时用户裁定）**：改名「LimuGen」暂不上线，
#: 这里的品牌字样保持「镜流」，审批表单名保持写死。dev 上是新名字 + `{apply_form}`。
#: 改名获准上线时，撤销生产仓里这个提交即可（`git revert <本提交>`）。
DEFAULTS: dict[str, str] = {
    # {offset_tail}：补审批时说明"其中多少是冲抵此前已发的、不重复到账"（2026-10-17）
    "approval_granted": "{greet}，你的镜流平台 {amount} 积分审批已通过{offset_tail}，"
                        "当前余额 {balance}，如有问题请找{contact}反馈。",
    # ⚠️ 不再带 {unapproved_tail}：未审批台账只给管理员看（2026-10-17 用户裁定），
    #    而这条发给的是被分配的人（多为生成师）。
    "direct_grant": "{greet}，管理员向你直接分配积分 {amount}，当前积分余额 {balance}"
                    "，请尽快通过飞书「镜流平台积分申请」进行审批，谢谢。",
    # 发给**分配人**自己（不是被分配的人）：{name}=被分配的人，{balance}=分配人自己的余额
    "grant_from_leader": "{greet}，你已向 {name} 分配积分 {amount}，你的当前积分余额 {balance}。",
    "rejected": "{greet}，你的镜流平台积分申请（{amount}）未通过审批，"
                "如有疑问请找{contact}反馈。",
}

#: 事件的中文名（界面与日志用）
EVENT_LABEL = {
    "approval_granted": "审批通过并到账",
    "direct_grant": "管理员直接分配（未经审批）",
    "grant_from_leader": "组长/小组长分配（发给分配人）",
    "rejected": "审批被驳回 / 撤回",
}


def greet(now: datetime | None = None) -> str:
    """按**北京时间**问好。用户点名要这个（消息里带上问候语更像人发的）。

    传入的 `now` 若是 naive，按 UTC 解释；带时区的按原样换算。整点边界：
    05–09 早上、09–11:30 上午、11:30–14 中午、14–18 下午、其余晚上。
    （凌晨 0–5 点归入"晚上好"——五档里没有"凌晨"，且这个点发的多半是夜间补录。）
    """
    t = (now or datetime.now(timezone.utc))
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    t = t.astimezone(_CST)
    h, m = t.hour, t.minute
    if 5 <= h < 9:
        return "早上好"
    if 9 <= h < 11 or (h == 11 and m < 30):
        return "上午好"
    if 11 <= h < 14:
        return "中午好"
    if 14 <= h < 18:
        return "下午好"
    return "晚上好"


def fmt_amount(fen: int) -> str:
    """积分显示：整数不带小数，有零头才带（100 → "100"，150 → "1.5"，12345 → "123.45"）。"""
    if fen % 100 == 0:
        return str(fen // 100)
    return f"{fen / 100:.2f}".rstrip("0").rstrip(".")


def texts() -> dict[str, str]:
    """文案：DB 覆盖 > 代码默认。"""
    out = dict(DEFAULTS)
    try:
        with get_session() as s:
            for t in s.query(NotifyTemplate).all():
                if (t.text or "").strip():
                    out[t.event] = t.text
    except Exception:      # noqa: BLE001 读不到就用默认，通知不该因此消失
        log.warning("[notify] 读文案失败，用默认", exc_info=True)
    return out


def _union_of(uid: int) -> str | None:
    from .auth import KnownUser
    with get_session() as s:
        k = s.get(KnownUser, uid)
        return (k.feishu_union_id or "").strip() or None if k else None


def _balance_fen(uid: int) -> int:
    from .budget import _member_pool
    from .db import BudgetPool
    with get_session() as s:
        p = s.get(BudgetPool, _member_pool(uid))
        return int(p.balance_fen or 0) if p else 0


def _name_of(uid: int | None) -> str:
    from .db import UserBudget
    if uid is None:
        return "管理员"
    with get_session() as s:
        u = s.get(UserBudget, uid)
        return (u.name if u and u.name else "") or f"用户 {uid}"


def unapproved_add(uid: int, fen: int) -> int:
    """累加"未经审批就分配"的金额（管理员直接分配时调用）。返回累加后的值。"""
    if fen <= 0:
        return 0
    with get_session() as s:
        row = s.get(BudgetUnapproved, uid)
        if row is None:
            row = BudgetUnapproved(user_id=uid, fen=0, updated_at=_now())
            s.add(row)
        row.fen = int(row.fen or 0) + int(fen)
        row.updated_at = _now()
        s.commit()
        return int(row.fen)


def unapproved_consume(uid: int, fen: int) -> int:
    """审批通过拨款时冲减（那张单把以前"先垫后补"的部分补上了，下限 0）。"""
    if fen <= 0:
        return 0
    with get_session() as s:
        row = s.get(BudgetUnapproved, uid)
        if row is None:
            return 0
        row.fen = max(0, int(row.fen or 0) - int(fen))
        row.updated_at = _now()
        s.commit()
        return int(row.fen)


def unapproved_fen(uid: int) -> int:
    with get_session() as s:
        row = s.get(BudgetUnapproved, uid)
        return int(row.fen or 0) if row else 0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _apply_form_name() -> str:
    """飞书里那张积分申请审批表单的**真实名字**（取已启用的审批模板）。

    为什么不写死：原文案写的是「镜流平台积分申请」，平台改名时若把它一起改成
    「LimuGen平台积分申请」而飞书后台的表单没改名，用户照着搜就找不到。
    表单名以审批设置里登记的为准，飞书那边改名后在审批设置里同步即可。
    """
    try:
        from .db import ApprovalTemplate
        with get_session() as s:
            t = (s.query(ApprovalTemplate).filter(ApprovalTemplate.enabled == 1)
                 .order_by(ApprovalTemplate.created_at).first())
            name = (t.name or "").strip() if t else ""
            return name or _APPLY_FORM_FALLBACK
    except Exception:      # noqa: BLE001 读不到就用兜底叫法，通知不该因此消失
        log.warning("[notify] 读审批模板名失败，用兜底", exc_info=True)
        return _APPLY_FORM_FALLBACK


def _render(event: str, ctx: dict) -> str:
    tpl = texts().get(event) or DEFAULTS.get(event) or ""
    v = {
        "greet": greet(),
        "contact": (get_settings().feishu_notify_contact or "管理员").strip(),
        "amount": fmt_amount(int(ctx.get("amount_fen") or 0)),
        "balance": fmt_amount(int(ctx.get("balance_fen") or 0)),
        "granter": ctx.get("granter") or "管理员",
        "name": ctx.get("name") or "",
        "reason": (ctx.get("reason") or "").strip(),
        "apply_form": _apply_form_name(),
    }
    u = int(ctx.get("unapproved_fen") or 0)
    # 「其中 XXX 未审批」：**只对管理员收件人**有内容（台账只给管理员看）。
    # 占位符保留是为了不让管理员写过的自定义文案因"占位符不存在"退回默认。
    v["unapproved_tail"] = (f"，其中 {fmt_amount(u)} 未审批"
                            if u > 0 and ctx.get("to_admin") else "")
    off = int(ctx.get("offset_fen") or 0)
    paid = int(ctx.get("amount_fen") or 0) - off
    v["offset_tail"] = ("" if off <= 0 else
                        f"（其中 {fmt_amount(off)} 是此前已发放额度的补审批，不重复到账"
                        + (f"；本次实际到账 {fmt_amount(paid)}" if paid > 0 else "") + "）")
    try:
        return tpl.format(**v).strip()
    except (KeyError, IndexError, ValueError):
        # 模板被改坏（写了个不存在的占位符）：退回默认文案，别把通知整没了
        log.warning("[notify] 文案 %s 占位符有误，用默认", event)
        return DEFAULTS[event].format(**v).strip()


def _record(uid: int | None, event: str, text: str, status: str, detail: str = "") -> None:
    try:
        with get_session() as s:
            s.add(FeishuNotifyLog(id=uuid.uuid4().hex[:16], ts=_now(), user_id=uid,
                                  event=event, status=status, text=text[:500],
                                  detail=detail[:300]))
            s.commit()
    except Exception:      # noqa: BLE001 留痕失败也不能影响正事
        log.warning("[notify] 留痕失败", exc_info=True)


def notify(uid: int | None, event: str, **ctx) -> bool:
    """给 `uid` 发一条通知。**永远不抛异常**（返回是否发出）。

    ⚠️ 这是刻意的：调用点全在"钱已经算完"之后，通知失败要是往外抛，
    用户看到的是"分配失败"，而钱其实已经进了——比不通知糟得多。
    """
    if uid is None:
        return False
    if not bool(getattr(get_settings(), "feishu_notify_enabled", True)):
        return False
    try:
        from . import feishu_open
        if not feishu_open.configured():
            return False
        union = _union_of(uid)
        if not union:
            _record(uid, event, "", "skipped", "该用户没有飞书身份（没登录过镜流）")
            return False
        if "balance_fen" not in ctx:
            ctx["balance_fen"] = _balance_fen(uid)
        if "to_admin" not in ctx:
            from .budget import _platform_admin_ids
            ctx["to_admin"] = uid in _platform_admin_ids()
        text = _render(event, ctx)
        import json as _json
        feishu_open.call("POST", "/open-apis/im/v1/messages",
                         params={"receive_id_type": "union_id"},
                         body={"receive_id": union, "msg_type": "text",
                               "content": _json.dumps({"text": text}, ensure_ascii=False)},
                         timeout=8.0)
        _record(uid, event, text, "sent")
        return True
    except Exception as e:      # noqa: BLE001
        log.warning("[notify] 发送失败 uid=%s event=%s: %r", uid, event, e)
        try:
            _record(uid, event, "", "failed", repr(e))
        except Exception:       # noqa: BLE001
            pass
        return False


# ---------------------------------------------------------------------------
# 业务事件封装 —— 调用点只写意图，措辞与收件人在本模块内定
# ---------------------------------------------------------------------------

def on_approval_granted(uid: int, amount_fen: int, offset_fen: int = 0) -> None:
    """审批通过 → 通知申请人。

    冲抵台账已在 `approval_sync._grant` 的拨款事务里做完（先冲抵、后拨款），
    这里只负责告知；`offset_fen` 用来说明"其中多少是补审批、不重复到账"。
    """
    notify(uid, "approval_granted", amount_fen=amount_fen, offset_fen=offset_fen)


def on_direct_grant(uid: int, amount_fen: int, granter_id: int | None) -> None:
    """管理员直接分配（无审批依据）→ 通知被分配的人。

    计入未审批台账已挪进 `budget.grant_to_member` 的拨款事务（2026-10-17）：
    原先只在这里累加，接口层之外的拨款就漏记了。这里**不能再加一次**。
    """
    notify(uid, "direct_grant", amount_fen=amount_fen)


def on_leader_grant(uid: int, amount_fen: int, granter_id: int | None) -> None:
    """组长/小组长用自己的余额分配给 `uid` → **只通知分配人本人**（不计入未审批）。

    2026-10-17 用户裁定：被分配的人不收这条，收件人是 `granter_id`。
    `{balance}` 因此是分配人自己扣完后的余额（notify 按收件人取余额）。
    """
    if granter_id is None:
        return
    notify(granter_id, "grant_from_leader", amount_fen=amount_fen,
           name=_name_of(uid), granter=_name_of(granter_id))


def on_rejected(uid: int, amount_fen: int | None) -> None:
    notify(uid, "rejected", amount_fen=amount_fen or 0)
