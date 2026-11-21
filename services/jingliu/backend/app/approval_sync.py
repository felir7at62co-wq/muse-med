"""飞书审批 → 积分：读取审批结果、判定、拨款（方案 B，2026-10-15）。

## 触发方式：只在有人点按钮时读飞书

用户裁定**不轮询**（"每分钟读一次会带来大量无用的网络开销"）：
  · 大组长点「刷新积分」→ `sync(requester=他)`
  · 管理员点「全部刷新」 → `sync(requester=None)`
两者跑的是**同一个**同步（读到的每张已通过的单都会被处理，谁点的都一样），
区别只在返回给谁看哪些单，以及各自的冷却。

## 分三层，为方案 C 留口子

  1. 读：`feishu_open`（怎么调飞书）——以后加事件推送，只是多一个调用 `sync_one` 的入口。
  2. 判：`evaluate()` 纯函数，输入"审批详情 + 模板配置 + 人员表"，输出该拨多少给谁、
     或者为什么不拨。**不碰库、不碰网络**，单测直接喂 JSON。
  3. 拨：`_grant()`，一个事务里"状态 approved→granted 的条件更新 + 加余额 + 写流水"。
方案 C（镜流里发起申请）只是在 1 之前多一步"建 BudgetRequest(source=shotflow) 并调
飞书创建审批单"，2、3 完全复用。模板怎么解读全在 ApprovalTemplate 表里，不在代码里。

## 只拨一次

主键是飞书审批单号；`granted` 只能经由一条
`UPDATE … SET status='granted' WHERE instance_code=? AND status IN ('approved','review')`
进入，影响行数为 1 才继续加钱，且与加钱同一事务。并发两次刷新、重复读到同一张单、
进程中途重启，都不会多拨。
"""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from . import feishu_open
from .config import get_settings
from .db import ApprovalTemplate, BudgetLedger, BudgetRequest, UserBudget, get_session

log = logging.getLogger(__name__)

#: 本地终态：不再去飞书复查
_TERMINAL = {"granted", "rejected", "canceled", "dismissed", "revoked_after_grant"}
#: 发现新单时把时间窗往前多取一段，防止两边时钟差导致漏单
_OVERLAP_MS = 10 * 60 * 1000
#: 已拨款的单在这段时间内**仍会复查**，用来发现"拨款后飞书侧被撤销"。
#: 不复查的话那种情况永远发现不了（granted 是终态）；全量复查又是用户不要的无用开销。
#: 一周内拨的单数量很少，每次刷新多几次请求。
_RECHECK_GRANTED_SEC = 7 * 86400
#: 详情快照存多长（排查用，不要把整张表单塞爆库）
_SNAPSHOT_CAP = 8000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _iso_from_ms(v) -> str | None:
    try:
        return datetime.fromtimestamp(int(v) / 1000, timezone.utc).isoformat(timespec="seconds")
    except (TypeError, ValueError, OSError):
        return None


def _ms_from_iso(v: str | None) -> int:
    try:
        return int(datetime.fromisoformat(v).timestamp() * 1000)
    except (TypeError, ValueError):
        return 0


# ---------------------------------------------------------------------------
# 2. 判定（纯函数）
# ---------------------------------------------------------------------------

@dataclass
class Decision:
    status: str                       # pending/approved/rejected/canceled/review
    amount_fen: int | None = None
    applicant_id: int | None = None
    target_id: int | None = None
    initiator_union_id: str | None = None
    reason: str | None = None
    submitted_at: str | None = None
    decided_at: str | None = None


@dataclass
class People:
    """判定需要的人员信息（由调用方从库里取好，传进来）。"""
    by_union: dict[str, int] = field(default_factory=dict)        # union_id → uid
    roles: dict[int, tuple[str, bool]] = field(default_factory=dict)  # uid → (组织角色, 在岗)


def _widgets(detail: dict) -> list[dict]:
    raw = detail.get("form")
    if isinstance(raw, list):
        return raw
    try:
        v = json.loads(raw or "[]")
        return v if isinstance(v, list) else []
    except ValueError:
        return []


def _find_widget(ws: list[dict], wid: str) -> dict | None:
    """按控件 id 找；明细/分组控件里的子控件也找一层。"""
    for w in ws:
        if str(w.get("id")) == wid:
            return w
        sub = w.get("children") or w.get("value")
        if isinstance(sub, list):
            for c in sub:
                if isinstance(c, dict) and str(c.get("id")) == wid:
                    return c
    return None


def parse_amount(detail: dict, widget_id: str, unit: str = "yuan") -> tuple[int | None, str]:
    """从表单取金额 → 分。读不出返回 (None, 原因)。

    ⚠️ 只认**数字**：飞书"金额/数字"控件的值是数字或数字字符串。"五千"、"5000元"
    这类文本一律不猜——猜错的代价是把钱拨错，转人工的代价只是多点一下。
    """
    w = _find_widget(_widgets(detail), widget_id)
    if w is None:
        return None, f"表单里找不到金额控件（id={widget_id}），可能模板被改过"
    v = w.get("value")
    if isinstance(v, dict):                  # 个别控件把值包一层
        v = v.get("value", v.get("amount"))
    try:
        d = Decimal(str(v).strip())
    except (InvalidOperation, AttributeError):
        return None, f"金额不是数字：{str(v)[:40]!r}"
    if d <= 0:
        return None, f"金额不是正数：{d}"
    fen = d if unit == "fen" else d * 100
    if fen != fen.to_integral_value():
        return None, f"金额精度超过 1 分：{d}"
    return int(fen), ""


def _target_union(detail: dict, tpl_target: str) -> tuple[str | None, str]:
    if tpl_target == "initiator" or not tpl_target:
        return (detail.get("user_id") or None), ""
    if tpl_target.startswith("widget:"):
        w = _find_widget(_widgets(detail), tpl_target[len("widget:"):])
        if w is None:
            return None, "表单里找不到收款人控件"
        v = w.get("value")
        if isinstance(v, list):
            v = v[0] if len(v) == 1 else None
            if v is None:
                return None, "收款人控件选了多个人，无法确定拨给谁"
        if isinstance(v, dict):
            v = v.get("user_id") or v.get("union_id") or v.get("id")
        return (str(v) if v else None), ("" if v else "收款人控件为空")
    return None, f"未知的收款人规则：{tpl_target}"


def _approvers(detail: dict) -> set[str]:
    """时间线里做过"同意"的人（union_id）。"""
    out = set()
    for t in detail.get("timeline") or []:
        if str(t.get("type")).upper() in ("PASS", "AUTO_PASS") and t.get("user_id"):
            out.add(str(t["user_id"]))
    return out


def evaluate(detail: dict, tpl: ApprovalTemplate, people: People) -> Decision:
    """一张审批单在当前规则下应处于什么状态。**只读输入，无副作用。**"""
    st = str(detail.get("status") or "").upper()
    dec = Decision(status="pending",
                   initiator_union_id=detail.get("user_id") or None,
                   submitted_at=_iso_from_ms(detail.get("start_time")),
                   decided_at=_iso_from_ms(detail.get("end_time")) if detail.get("end_time") not in (None, "", "0") else None)
    dec.applicant_id = people.by_union.get(dec.initiator_union_id or "")
    if st == "REJECTED":
        dec.status = "rejected"
        return dec
    if st in ("CANCELED", "DELETED", "REVERTED"):
        dec.status = "canceled"
        return dec
    if st != "APPROVED":
        return dec                                     # 审批中：什么都不做

    def review(why: str) -> Decision:
        dec.status, dec.reason = "review", why
        return dec

    amt, why = parse_amount(detail, tpl.amount_widget_id, tpl.amount_unit or "yuan")
    if amt is None:
        return review(why)
    dec.amount_fen = amt
    tu, why = _target_union(detail, tpl.target or "initiator")
    if not tu:
        return review(why or "确定不了拨给谁")
    uid = people.by_union.get(tu)
    if uid is None:
        return review("收款人没有登录过镜流（或登录时还没带飞书身份），对不上账号——请他登录一次后再刷新")
    dec.target_id = uid
    role, active = people.roles.get(uid, ("", False))
    allowed = {r.strip() for r in (tpl.allowed_roles or "").replace("，", ",").split(",") if r.strip()}
    if not role:
        return review("收款人不在积分组织里，先把他拉进组")
    if not active:
        return review("收款人已不在岗")
    if allowed and role not in allowed:
        return review(f"收款人的角色是「{role}」，此模板只允许：{'、'.join(sorted(allowed))}")
    if tpl.max_fen and amt > tpl.max_fen:
        return review(f"金额 {amt / 100:g} 超过单笔上限 {tpl.max_fen / 100:g}")
    need = {x.strip() for x in (tpl.approver_union_ids or "").split(",") if x.strip()}
    if need and not (_approvers(detail) & need):
        return review("批准人不在指定名单里")
    dec.status = "approved"
    return dec


# ---------------------------------------------------------------------------
# 3. 拨款（一个事务）
# ---------------------------------------------------------------------------

def _grant(code: str, by: int | None) -> tuple[bool, str]:
    """把一张 approved/review 的单变成 granted，**先冲抵、后拨款**。返回 (是否这次处理了, 说明)。

    ## 先冲抵（2026-10-17 用户裁定）

    管理员常常先直接拨钱、事后让大组长补审批。审批额若照常到账，同一笔钱就发了
    两次。所以审批额先抵掉申请人这一支「已发未批」的部分（`budget.offset_unapproved`，
    范围见 `budget.approval_scope`），**只有超出部分才真到账**。冲抵额记在单上
    （`offset_fen`），实际到账 = amount_fen − offset_fen；整张单都被冲抵时不写
    拨款流水（没有钱动），单照样置 granted。冲抵与拨款在同一个事务里。
    """
    from .budget import _give, _member_pool, offset_unapproved
    with get_session() as s:
        r = s.get(BudgetRequest, code)
        if r is None or r.target_id is None or not r.amount_fen:
            return False, "单据缺收款人或金额"
        u = s.get(UserBudget, r.target_id)
        if u is None or not u.active:
            return False, "收款人不在积分组织里或已不在岗"
        lid = uuid.uuid4().hex[:16]
        n = (s.query(BudgetRequest)
             .filter(BudgetRequest.instance_code == code,
                     BudgetRequest.status.in_(("approved", "review")))
             .update({BudgetRequest.status: "granted",
                      BudgetRequest.granted_by: by, BudgetRequest.granted_at: _now(),
                      BudgetRequest.updated_at: _now()}, synchronize_session=False))
        if n != 1:
            s.rollback()
            return False, "这张单已经处理过（可能被另一次刷新抢先拨了）"
        amount = int(r.amount_fen)
        offset = offset_unapproved(s, r.target_id, amount)
        paid = amount - offset
        if paid > 0:
            pool = _member_pool(r.target_id)
            _give(s, pool, paid, u.name or "")
            note = f"飞书审批{'自动' if by is None else '人工'}拨款 {code}"
            if offset:
                note += f"（审批 {amount / 100:g}，冲抵已发 {offset / 100:g}）"
            s.add(BudgetLedger(id=lid, ts=_now(), pool_id=pool, user_id=by, entry="grant",
                               amount=paid, note=note[:255]))
        (s.query(BudgetRequest).filter(BudgetRequest.instance_code == code)
         .update({BudgetRequest.offset_fen: offset,
                  BudgetRequest.ledger_id: lid if paid > 0 else None},
                 synchronize_session=False))
        s.commit()
        target = r.target_id
    # ⚠️ 通知放在**事务之后**，且失败绝不影响拨款（钱已经算完了，通知只是告知）
    try:
        from . import notify
        notify.on_approval_granted(target, amount, offset_fen=offset)
    except Exception:      # noqa: BLE001
        log.warning("[approval] 到账通知失败 code=%s", code, exc_info=True)
    return True, ""


# ---------------------------------------------------------------------------
# 1+2+3 串起来
# ---------------------------------------------------------------------------

def _people() -> People:
    from .auth import KnownUser
    from .budget import canon_role
    p = People()
    with get_session() as s:
        for k in s.query(KnownUser).filter(KnownUser.feishu_union_id.isnot(None)).all():
            p.by_union[k.feishu_union_id] = int(k.user_id)
        # 审批接口给的是**租户 user_id**（不是 union_id），所以两张表都要能对。
        # ⚠️ 这一条不能省：省了就是"每张审批单都对不上账号、全部转人工"。
        for k in s.query(KnownUser).filter(KnownUser.feishu_user_id.isnot(None)).all():
            p.by_union.setdefault(str(k.feishu_user_id), int(k.user_id))
        for u in s.query(UserBudget).all():
            p.roles[int(u.user_id)] = (canon_role(u.org_role) or u.org_role or "", bool(u.active))
    return p


def learn_feishu_ids(tenant_user_ids: list[str]) -> int:
    """把飞书**租户 user_id** 换算成 union_id 并记进名录（换算结果一并缓存）。

    审批详情里的发起人/收款人 ID 是租户 user_id；只有换算了才能对上镜流账号。
    一个人一生查一次（结果存进 known_users），之后刷新不再碰通讯录。
    """
    from .auth import KnownUser
    ids = [i for i in dict.fromkeys(str(x) for x in tenant_user_ids if x)]
    if not ids:
        return 0
    with get_session() as s:
        have = {str(k.feishu_user_id) for k in s.query(KnownUser)
                .filter(KnownUser.feishu_user_id.isnot(None)).all()}
    todo = [i for i in ids if i not in have]
    if not todo:
        return 0
    try:
        mapping = feishu_open.resolve_users(todo)
    except feishu_open.FeishuError as e:
        log.warning("[approval] 换算飞书 user_id 失败：%s", e.user_text())
        return 0
    n = 0
    with get_session() as s:
        for tid, union in mapping.items():
            k = (s.query(KnownUser).filter(KnownUser.feishu_union_id == union).first()
                 or s.query(KnownUser).filter(KnownUser.feishu_user_id == tid).first())
            if k is None:
                continue          # 没登录过镜流的人：不认识就是不认识，不猜
            k.feishu_user_id, k.feishu_union_id = tid, union
            n += 1
        s.commit()
    return n


def _tenant_ids_in(detail: dict) -> list[str]:
    """审批详情里出现的飞书**租户 user_id**（发起人 + 联系人类控件里选的人）。"""
    ids = [str(detail.get("user_id") or "")]
    for w in _widgets(detail):
        v = w.get("value")
        if isinstance(v, list):
            ids += [str(x) for x in v if isinstance(x, str)]
    return [i for i in dict.fromkeys(ids) if i]


def sync_one(tpl: ApprovalTemplate, code: str, people: People) -> str:
    """读一张单、更新本地影子、该拨就拨。返回本地最终状态。

    ⚠️ 只读**一次**详情（`get_instance`）。发起人对不上账号时，才就地把它换算成
    union_id 再判一遍——绝不为了换算把每张单多读一次（用户明确要求别有无用开销）。
    """
    detail = feishu_open.get_instance(code)
    dec = evaluate(detail, tpl, people)
    if dec.applicant_id is None or (dec.status == "review" and dec.target_id is None):
        if learn_feishu_ids(_tenant_ids_in(detail)):
            people = _people()          # 映射变了，重取一次再用新映射判
            dec = evaluate(detail, tpl, people)
    snap = json.dumps(detail, ensure_ascii=False)[:_SNAPSHOT_CAP]
    with get_session() as s:
        r = s.get(BudgetRequest, code)
        if r is None:
            r = BudgetRequest(instance_code=code, approval_code=tpl.approval_code,
                              source=tpl.source or "native", status="pending", created_at=_now())
            s.add(r)
        r.feishu_status = str(detail.get("status") or "")
        r.snapshot, r.updated_at = snap, _now()
        for k in ("initiator_union_id", "applicant_id", "submitted_at", "decided_at"):
            setattr(r, k, getattr(dec, k))
        # ⚠️ 必须先初始化：granted 那一支**不会赋值**，漏了就是"复查一张已拨款的单时
        # NameError"，而它会被外层吞成"这次刷新有 1 处失败"并阻止水位前进——
        # 表现是每次刷新都失败、却看不出哪里错。
        _tell = None
        if r.status == "granted":
            if dec.status in ("canceled", "rejected"):
                r.status, r.reason = "revoked_after_grant", "拨款后飞书侧被撤销/驳回，未自动扣回，请人工处理"
        elif r.status not in _TERMINAL:
            _prev = r.status
            r.status, r.reason = dec.status, dec.reason
            r.amount_fen, r.target_id = dec.amount_fen, dec.target_id
            # 只在本状态**真的变了**时通知一次（否则每次刷新都会重发同一条）
            _tell = (r.applicant_id, r.amount_fen) if (
                _prev != r.status and r.status in ("rejected", "canceled")) else None
            # ⛔ 转人工（review）也不发飞书通知（2026-10-17 用户裁定，别加回来）：
            #   与回执同理，只在有人点刷新时才知道，发出去也是迟到的；
            #   待人工的单在积分页「审批记录」里照常列出，管理员在那里处理。
            # ⛔ 这里曾有「申请已收到」回执（2026-10-17 用户裁定删除，别加回来）：
            #   我们只在有人点刷新时才读飞书，"已收到"可能晚到几小时、甚至晚于结果，
            #   不准时的通知会拉低用户对所有通知的信任。要加回来，前提是先接上
            #   飞书审批事件推送、能在提交当时就知道。
        else:
            _tell = None
        s.commit()
        status = r.status
    if _tell:
        try:
            from . import notify
            notify.on_rejected(_tell[0], _tell[1])
        except Exception:      # noqa: BLE001
            log.warning("[approval] 审批通知失败 code=%s", code, exc_info=True)
    if status == "approved":
        ok, why = _grant(code, None)
        if ok:
            return "granted"
        with get_session() as s:
            r = s.get(BudgetRequest, code)
            if r is not None and r.status == "approved":
                r.status, r.reason = "review", why
                s.commit()
            return r.status if r else "review"
    return status


@dataclass
class SyncResult:
    ok: bool = True
    message: str = ""
    checked: int = 0
    new_granted: list[dict] = field(default_factory=list)
    review: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    finished_at: str = ""
    cached: bool = False


_LOCK = threading.Lock()
_LAST: dict[str, tuple[float, SyncResult]] = {}


def _row_out(r: BudgetRequest) -> dict:
    return {"instance_code": r.instance_code, "status": r.status,
            "amount_fen": r.amount_fen, "amount_yuan": None if r.amount_fen is None else f"{r.amount_fen / 100:.2f}",
            "applicant_id": r.applicant_id, "target_id": r.target_id,
            "reason": r.reason, "submitted_at": r.submitted_at, "granted_at": r.granted_at,
            "feishu_status": r.feishu_status, "source": r.source,
            # 先冲抵后拨款（2026-10-17）：实际到账 = 审批额 − 冲抵额
            "offset_fen": int(r.offset_fen or 0),
            "paid_fen": None if r.amount_fen is None else int(r.amount_fen) - int(r.offset_fen or 0)}


def sync(requester: int | None) -> SyncResult:
    """读飞书、处理所有模板的单。`requester=None` = 管理员全部刷新。

    冷却：同一个刷新键在 `approval_refresh_cooldown_sec` 内再点，直接返回上次结果。
    互斥：同一时刻只跑一个同步（两个大组长同时点，后到的直接拿前一个的结果）。
    """
    key = "all" if requester is None else f"u{requester}"
    cd = max(0, int(get_settings().approval_refresh_cooldown_sec or 0))
    hit = _LAST.get(key)
    if hit and time.time() - hit[0] < cd:
        res = hit[1]
        res.cached = True
        return res
    if not feishu_open.configured():
        return SyncResult(ok=False, message="后端没有配置飞书应用，暂时无法读取审批")
    if not _LOCK.acquire(timeout=60):
        return SyncResult(ok=False, message="另一次刷新正在进行，请稍后再点")
    res = SyncResult()
    started = _now()
    try:
        with get_session() as s:
            tpls = s.query(ApprovalTemplate).filter(ApprovalTemplate.enabled == 1).all()
            s.expunge_all()
        if not tpls:
            res.ok, res.message = False, "还没有配置审批模板（管理员在积分页「审批设置」里添加）"
            return res
        people = _people()
        now_ms = int(time.time() * 1000)
        for tpl in tpls:
            start_ms = max(_ms_from_iso(tpl.start_at),
                           _ms_from_iso(tpl.synced_until) - _OVERLAP_MS)
            try:
                codes = feishu_open.list_instance_codes(tpl.approval_code, start_ms, now_ms)
            except feishu_open.FeishuError as e:
                res.errors.append(f"{tpl.name or tpl.approval_code}：{e.user_text()}")
                continue
            recent = datetime.fromtimestamp(time.time() - _RECHECK_GRANTED_SEC,
                                            timezone.utc).isoformat(timespec="seconds")
            with get_session() as s:
                rows = s.query(BudgetRequest).filter(
                    BudgetRequest.approval_code == tpl.approval_code).all()
                known = {r.instance_code: r.status for r in rows}
                fresh_grants = {r.instance_code for r in rows
                                if r.status == "granted" and (r.granted_at or "") >= recent}
            # 新发现的 + 本地还没定局的（审批中/待人工）+ 一周内刚拨的（查撤销）。
            # 其余终态的不再打扰飞书。
            def _need(c: str) -> bool:
                return known.get(c) not in _TERMINAL or c in fresh_grants
            todo = [c for c in codes if _need(c)]
            todo += [c for c in known if _need(c) and c not in todo]
            failed = False
            for c in todo:
                try:
                    st = sync_one(tpl, c, people)
                    res.checked += 1
                    if st == "granted" and known.get(c) != "granted":
                        res.new_granted.append({"instance_code": c})
                except feishu_open.FeishuError as e:
                    failed = True
                    res.errors.append(f"审批单 {c}：{e.user_text()}")
                except Exception as e:  # noqa: BLE001 一张单出错不能拖垮其余
                    failed = True
                    log.exception("[approval] 处理 %s 失败", c)
                    res.errors.append(f"审批单 {c}：{e!r}"[:300])
            if not failed:
                with get_session() as s:
                    t = s.get(ApprovalTemplate, tpl.approval_code)
                    if t is not None:
                        t.synced_until = _iso_from_ms(now_ms)
                        s.commit()
        with get_session() as s:
            q = s.query(BudgetRequest)
            if requester is not None:
                q = q.filter((BudgetRequest.target_id == requester)
                             | (BudgetRequest.applicant_id == requester))
            rows = {r.instance_code: r for r in q.all()}
            res.new_granted = [_row_out(rows[g["instance_code"]]) for g in res.new_granted
                               if g["instance_code"] in rows]
            res.review = [_row_out(r) for r in rows.values() if r.status in ("review", "revoked_after_grant")]
        n = len(res.new_granted)
        total = sum((x["amount_fen"] or 0) for x in res.new_granted) / 100
        res.message = (f"新到账 {n} 笔，共 {total:g} 积分" if n else "没有新到账的审批") + \
            (f"；{len(res.review)} 笔待管理员处理" if res.review else "") + \
            (f"；{len(res.errors)} 处读取失败" if res.errors else "")
        res.ok = not res.errors
        return res
    finally:
        res.finished_at = started
        _LAST[key] = (time.time(), res)
        _LOCK.release()


def resolve(code: str, action: str, by: int) -> dict:
    """管理员处理一张「待人工」的单：grant（照常拨）/ dismiss（不拨）。"""
    if action == "grant":
        ok, why = _grant(code, by)
        if not ok:
            raise ValueError(why)
    elif action == "dismiss":
        with get_session() as s:
            r = s.get(BudgetRequest, code)
            if r is None or r.status not in ("review", "approved", "revoked_after_grant"):
                raise ValueError("这张单不在待处理状态")
            r.status, r.granted_by, r.updated_at = "dismissed", by, _now()
            s.commit()
    else:
        raise ValueError("action 只能是 grant / dismiss")
    with get_session() as s:
        return _row_out(s.get(BudgetRequest, code))
