"""积分账本：预算池、划拨、流水（P1，2026-10-14）。

设计见 docs/DESIGN-积分预算与飞书审批-2026-10-13.md 第三节与第八节裁定。
**单位一律是「分」**（1 积分 = 1 元 = 100 分），整数累加，不碰浮点。
生成扣减在 `charge.py`（P1 下半，2026-10-14 已开闸）。

## 组织模型（2026-10-14 重做）

```
管理员（最高管理员 = 树根，无限积分）
  └─ 大组长   ── 管**整棵子树**
      └─ 小组长 ── 把普通生成师拉进自己的组
          └─ 生成师
```

| 谁 | 能看 | 能改组织 | 能下拨 |
|---|---|---|---|
| 管理员 | 全树 | 全部 | 全部，**不扣自己的钱**（无限） |
| 大组长 | 自己的子树 | 自己的子树 | 自己的子树，**扣自己的余额** |
| 小组长 | 自己 + 组员 | 自己 + 组员 | 自己的组，**扣自己的余额** |
| 生成师 | 自己 | 无 | 无 |

**「管理员」是组织角色，不是平台 role。** 库里早先把根角色写成「总控」，
两者都接受（见 `MANAGER_ALIASES`），但新写的一律是「管理员」——
组织编辑页只写它，免得界面上「总控」和「管理员」两个词指的是同一个人。

**「无组」是合法状态**：把人移出组 ≠ 离职。他照样能登录、只是不归任何人管、
不进任何人的子树汇总。表现就是 `manager_id = NULL` 且角色**不是**根角色。
刻意**不**再引入一个 `ungrouped` 标志位：`manager_id` 这一个字段已经能表达
"我没有上级"，再加一个布尔量就有两个真相来源，迟早出现"标志说无组、
manager_id 却挂着人"的自相矛盾行，而且没人知道该信哪个。

⚠️ 因此**根角色的判据是 `org_role`，不是 `manager_id IS NULL`**。早先
`_root_user_id` 取的是"第一个没有上级的人"，于是把人移出组就会让他
**变成一棵树的新根**——实测出现过「生成师根」，`list_org` 里多出一棵无意义的树。

## 池模型：层层包含
```
总控池 → 组池 → 小组池 → 个人池
```
下拨**只转移，不销毁**：钱从上级池的"可用"变成下级池的"可用"，
所以任何一层都能看到"我这条线总共还能花多少"。

| 视图 | 含义 | 用途 |
|---|---|---|
| 池自身 available | granted − used − held | 我还能往下分多少 |
| 子树 available | 自身 + 所有后代之和 | 我这条线总共还剩多少 |

⚠️ 两者都不落库、只计算。落库就会与叶子扣减不同步。

## 精度与幂等
  · 金额整数「分」，单笔换算在 pricing 里已向上取整；
  · 划拨在**一个事务**里同时改两个池并写两条流水（一负一正），
    中途失败两边一起回滚——否则会出现"钱扣了没到"或"凭空多出"。
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import func

from .db import BudgetLedger, BudgetPool, UserBudget, get_session

log = logging.getLogger(__name__)

ROOT_POOL = "root"            # 兼容保留：不再使用，一切金额都在个人池里
MEMBER_PREFIX = "u:"          # 个人池 id：u:<user_id>

#: ⚠️ **一人一池**（2026-10-14 修正）。
#: 早先给"组"另开一个 `g:<uid>` 池，结果是同一个组长身上挂着 `u:lead1`（余额）
#: 与 `g:lead1`（组织节点池）两个池：后代遍历只看其中一个，汇总时漏掉组长本人，
#: 总控那条线少算一大截，而且两边都"看着对"。组织树只描述**谁归谁管**，
#: 钱一律落在个人池上——组池这个概念在账上不存在。

#: 组织角色的字面量。**只有这几个值是合法的**，拼错的会被 `reconfigure` 拒掉
#: （见 `_norm_role`）——否则一个「组长 」带空格的 typo 会静默变成一个既没有
#: 下辖权限、也进不了任何汇总的角色，而界面上它看着就是「组长」。
ROLE_ADMIN = "管理员"      # 最高管理员 = 树根，全平台唯一，无限积分
ROLE_LEAD = "大组长"       # 管整棵子树
ROLE_SUBLEAD = "小组长"    # 管自己那一组
ROLE_MEMBER = "生成师"     # 普通成员
ALL_ROLES = (ROLE_ADMIN, ROLE_LEAD, ROLE_SUBLEAD, ROLE_MEMBER)

#: 新旧角色名的等价表。库里 2026-10-14 之前写下的根角色是「总控」，
#: 当时也用过「组长」表示大组长。**读的时候两种都认**（存量行不改数据就能用），
#: 写的时候一律落新名（见 `_norm_role`）。
ROLE_ALIASES = {"总控": ROLE_ADMIN, "组长": ROLE_LEAD, "组员": ROLE_MEMBER}

#: 能下辖的人（可以给自己子树里的人划拨）。**管理员不在其中**——
#: 他的划拨走另一条路（`grant_to_member` 里对根单独分支：不扣自己的钱）。
_GRANT_ROLES = (ROLE_ADMIN, ROLE_LEAD, ROLE_SUBLEAD)

#: 「管理员」在旧数据里的写法。跨版本读的地方一律用 `is_root_role`，不要直接
#: 拿 `org_role == ROLE_ADMIN` 比——库里现存的行写的是「总控」。
_ROOT_ROLE = ROLE_ADMIN


def is_root_role(role: str | None) -> bool:
    """这个角色是不是"最高管理员"。新旧名都认（见 `ROLE_ALIASES`）。"""
    r = (role or "").strip()
    return ROLE_ALIASES.get(r, r) == ROLE_ADMIN


def canon_role(role: str | None) -> str:
    """归一到一个合法角色名。认不出来的返回空串（由调用方决定是拒还是兜底）。"""
    r = (role or "").strip()
    if not r:
        return ""
    r = ROLE_ALIASES.get(r, r)
    return r if r in ALL_ROLES else ""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _fen(v) -> int:
    try:
        return int(round(float(v) * 100))
    except (TypeError, ValueError):
        return 0


# ------------------------------------------------------------------ 组织与角色

def reconfigure(users: Iterable[dict], *, root_user_id: int | None = None,
                deactivate_missing: bool = False) -> int:
    """按名单同步组织（幂等，可重复调用）。

    `users` 每项：`{"user_id": int, "name": str, "role": 管理员|大组长|小组长|生成师,
    "manager_id": int | None}`。角色名旧写法（`总控`/`组长`）也认，落库统一成新名。

    ## 组织的**唯一事实来源**是 `manager_id`
    早先还并行维护了一张 `org_nodes`（节点的成员名单），两处各记一份"谁归谁管"，
    结果汇总时两处对不上（组长既不是任何节点的成员、又是自己节点的负责人，
    于是被漏算，总控那条线凭空少一大截）。**已删除那张表**：一个人只有一个上级，
    表达层级有 `manager_id` 就够了。

    ## 「无组」怎么写
    把人移出组 = `manager_id` 置空，**角色保持原样**（他不会因此变成树根，
    树的根只看 `org_role`）。在名单里就是 `manager_id: None`。
    日常的拉人/移出不走这里，走 `set_member` / `remove_member`（按子树鉴权）；
    本函数是覆盖式批量写，只给最高管理员与脚本用。

    ## 两种模式（`deactivate_missing`）

    | | 名单外的人 | 谁用 |
    |---|---|---|
    | `False`（默认） | **原样不动** | 播种、测试、补录几个人 |
    | `True` | **标为不在岗** | 组织编辑页保存（名单即全量） |

    ⚠️ 这个参数**必须显式传**，不能默认 True。本函数是"upsert + 可选修剪"，
    而调用方经常只传自己关心的几个人（测试播种、临时补录），默认修剪会把
    名单外的人悄悄停用——那是比"没删干净"更糟的错：那人还在上班，
    却突然不能提交生成了，而且没人知道为什么。

    ⚠️ 编辑页**不再传 True**（2026-10-14 改）：那页现在是按子树增量改的，
    提交的只是自己那一段名单，拿它当"全量"会把全平台其他人一并停用。
    离职的人本来就登不上（飞书那边已经挂了），不需要在这一侧再标记一次。

    **余额与流水只增不改**——重建只动"谁归谁管 / 在不在岗"，不动任何金额。
    """
    users = list(users)
    n = 0
    with get_session() as s:
        # 名单里出现的人；修剪模式要靠它算差集
        listed = {int(u["user_id"]) for u in users}
        for u in users:
            uid = int(u["user_id"])
            role = canon_role(u.get("role") or ROLE_MEMBER)
            if not role:
                # 拼错的角色**整批拒绝**，不兜底成生成师：兜底会让一个本该是
                # 小组长的人静默失去下辖权限，而界面上看不出原因。
                raise ValueError(f"未知角色「{u.get('role')}」（可选：{' / '.join(ALL_ROLES)}）")
            row = s.get(UserBudget, uid)
            if row is None:
                row = UserBudget(user_id=uid, created_at=_now())
                s.add(row)
            row.name = (u.get("name") or row.name or "")[:64]
            row.org_role = role
            mgr = u.get("manager_id")
            # ⚠️ 不再把"没给上级的组长"自动挂到根下（2026-10-14 前的行为）。
            # 那时没有「无组」这个状态，游离的组长只能当作配置疏漏来补；
            # 现在 manager_id 为空就是**明确的无组**，自动挂上去等于替用户做决定。
            row.manager_id = (int(mgr) if mgr and not is_root_role(role)
                              and uid != root_user_id else None)
            row.active = 1 if u.get("active", True) else 0
            row.updated_at = _now()
            # 一人一池（幂等建）
            if s.get(BudgetPool, _member_pool(uid)) is None:
                s.add(BudgetPool(pool_id=_member_pool(uid), label=row.name,
                                 created_at=_now(), updated_at=_now()))
            n += 1
        s.flush()
        # 修剪：名单里没出现的人标非在岗。
        #
        # ⚠️ 只标 active=0，**不删行也不清 manager_id**：余额和流水挂在这个
        #    user_id 上，删行会让历史分账变成孤儿。账还在。
        #
        # ⚠️ 必须排除最高管理员：调用方可能只传了部分人，
        #    把根停用 = 全平台再没人能改组织（只剩平台管理员那条急救口）。
        if deactivate_missing:
            stale = (s.query(UserBudget)
                     .filter(UserBudget.user_id.notin_(listed), UserBudget.active == 1)
                     .all())
            for row in stale:
                if is_root_role(row.org_role):
                    log.warning("[budget] 修剪时跳过最高管理员 %s", row.user_id)
                    continue
                row.active = 0
                row.updated_at = _now()
        _assert_acyclic(s)
        s.commit()
    log.info("[budget] 组织同步 %d 人（修剪=%s）", n, deactivate_missing)
    return n


def _assert_acyclic(s) -> None:
    """校验 `manager_id` 构成的图**没有环**，有则整体拒绝。

    ⚠️ 这是必须的：A 是 B 的上级、B 又是 A 的上级时，`descendants` 靠 visited
    不会死循环，但"谁是总控"变成未定义——两人的余额都算进对方的子树，
    总额凭空翻倍；而界面上两棵树各自看着都正常。宁可整批同步失败并要求改数据，
    也不能把一份自相矛盾的组织关系写进库。
    """
    rows = {int(u.user_id): u.manager_id for u in s.query(UserBudget).all()}
    for start in rows:
        seen, cur, steps = set(), start, 0
        while cur is not None and steps <= len(rows) + 1:
            if cur in seen:
                raise ValueError(
                    f"组织关系存在环：用户 {start} 顺着上级走回到了自己。"
                    f"请检查 manager_id。")
            seen.add(cur)
            cur = rows.get(int(cur))
            steps += 1


# ------------------------------------------------------------------ 谁在操作

#: 角色的级别。**只能任命/管理比自己低的人**，这是防提权的唯一规则：
#: 小组长(1) 只能动生成师(0)，大组长(2) 能动小组长及以下，管理员(3) 能动大组长及以下。
#: 不在这里列的角色（或拼错的）按 0 处理 —— 宁可让他什么都管不了。
_RANK = {ROLE_ADMIN: 3, ROLE_LEAD: 2, ROLE_SUBLEAD: 1, ROLE_MEMBER: 0}


def rank(role: str | None) -> int:
    return _RANK.get(canon_role(role), 0)


@dataclass(frozen=True)
class Actor:
    """本次请求的操作者在组织里的身份。**每个写操作都从这里取权限，不要各自现查。**

    `is_root` = 组织里的最高管理员 **或** 平台管理员（admin/superadmin）。
    后者是急救口：组织数据配错（比如根被误停用）时总得有人能改。
    """
    uid: int
    role: str          # 归一后的组织角色；不在组织里 = 生成师
    is_root: bool
    in_org: bool

    @property
    def rank(self) -> int:
        return 3 if self.is_root else rank(self.role)

    @property
    def can_edit(self) -> bool:
        """「编辑组织」按钮给不给看。只有管理员与大小组长。"""
        return self.rank >= 1


def _display_name(s, uid: int) -> str:
    """组织里没登记名字时，取这个人的显示名。

    ⚠️ 来源是**名录**（`known_users`），不是会话表（2026-10-22）。
    只查会话时，一个"登录过但会话已失效"的人取不到名字，`set_member` 会
    退到 `str(uid)` —— 组织树里就出现一个叫「292」的人。名录里存着登录当时
    的显示名，且不随会话过期删除，正是这里要的东西。
    """
    from .auth import KnownUser
    k = s.get(KnownUser, int(uid))
    return (k.display_name or k.username or "") if k else ""


def _bootstrap_root(uid: int) -> None:
    """把**平台管理员**懒初始化为组织树的根（最高管理员）。

    用户最初的口径是"当前唯一的管理员账号应该设置为最高管理员"。不做成一次性脚本
    而是懒初始化，是因为上线后没人去跑脚本——管理员第一次打开积分页时它就到位了。

    ⚠️ 2026-10-15 改：原来**只在一个根都没有时**才做（"组织树只能有一个顶"）。
    那是只有一个管理员时的实现选择，不是用户裁定。用户随后定了**两个**管理员
    （管理员甲 + 管理员乙），第二个进来不会被提升 —— 他照样有全权，但**不在树里**，
    积分页上根本看不到他（用户原话"管理员乙现在根本没有出现在组织树中"）。
    树本来就支持多根（`_root_ids` 返回列表，`descendants(ROOT_POOL)` 从所有根往下），
    所以改为：每个平台管理员都是一个根。

    只在**没有组织行**时建；已经在树里且不是根的（例如先当组员、后被提权）**不动**，
    只记日志——悄悄把人从某个组里拔出来重挂成根，会改掉别人的组织结构。
    """
    with get_session() as s:
        row = s.get(UserBudget, uid)
        if row is not None:
            if not (is_root_role(row.org_role) and row.active):
                log.warning("[budget] 平台管理员 %s 已在组织树里且不是根（%s），未改动",
                            uid, row.org_role)
            return
        row = UserBudget(user_id=uid, created_at=_now())
        s.add(row)
        row.name = (_display_name(s, uid) or f"管理员{uid}")[:64]
        row.org_role = ROLE_ADMIN
        row.manager_id = None
        row.active = 1
        row.updated_at = _now()
        _ensure_member_pool(s, uid, row.name)
        s.commit()
    log.info("[budget] 平台管理员 %s 设为组织树的根", uid)


def ensure_admin_roots() -> int:
    """把所有登录过的平台管理员都初始化为根。管理员打开组织树时调用——
    这样另一个管理员**不必自己先打开过积分页**，也会出现在树里。"""
    n = 0
    for uid in sorted(_platform_admin_ids()):
        with get_session() as s:
            had = s.get(UserBudget, uid) is not None
        _bootstrap_root(uid)
        n += not had
    return n


def current_actor() -> Actor:
    from . import access
    me = access.current_user_id()
    if me is None:
        raise PermissionError("需要登录")
    platform_admin = access.is_admin()
    if platform_admin:
        _bootstrap_root(me)
    with get_session() as s:
        u = s.get(UserBudget, me)
    in_org = bool(u and u.active)
    role = canon_role(u.org_role) if in_org else ""
    return Actor(uid=me, role=role or ROLE_MEMBER,
                 is_root=platform_admin or is_root_role(role), in_org=in_org)


def _require_editor() -> Actor:
    a = current_actor()
    if not a.can_edit:
        raise PermissionError("你没有下辖成员，不能编辑组织或划拨额度")
    return a


def _require_org_admin() -> int:
    """谁能**覆盖式重写整棵组织树**（`PUT /v2/budget/org`）：只有最高管理员与平台管理员。

    ⚠️ 日常的拉人/移出/任命走 `set_member` / `remove_member`，那两个按**子树**
    鉴权，大小组长都能用。这里是批量覆盖，拿到它的人能把任何人改成任何角色
    （实测过：组长一次请求就把自己和总控对调了，2026-10-14），所以收到最紧。
    """
    a = current_actor()
    if a.is_root:
        return a.uid
    raise PermissionError("只有最高管理员可以批量重写组织架构")


#: 兼容旧调用名：下拨/编辑的门槛（管理员 + 大小组长）
def _require_budget_admin() -> int:
    return _require_editor().uid


# ------------------------------------------------------------------ 树的遍历

def _member_pool(uid: int) -> str:
    return f"{MEMBER_PREFIX}{uid}"


def _ensure_member_pool(s, uid: int, label: str = "") -> str:
    pid = _member_pool(uid)
    if s.get(BudgetPool, pid) is None:
        s.add(BudgetPool(pool_id=pid, label=(label or "")[:64],
                         created_at=_now(), updated_at=_now()))
    return pid


def _children(rows: dict[int, UserBudget]) -> dict[int, list[int]]:
    kids: dict[int, list[int]] = {}
    for uid, u in rows.items():
        if u.manager_id is not None:
            kids.setdefault(int(u.manager_id), []).append(uid)
    for v in kids.values():
        v.sort()
    return kids


# ---------------------------------------------------------------- 未审批台账
#
# 「管理员直接拨了、还没走审批」的金额，**按收款人逐人**记在 `budget_unapproved`。
#
# 用户裁定（2026-10-17）：
#   · **所有**管理员直接拨款都计入（此前只在接口层的通知里顺手累加，脚本/别的
#     入口拨的钱就漏了；现在在拨款事务内记，和余额同生同死）。
#   · 补审批通过时**先冲抵、后拨款**：审批额先抵掉这一支已发未批的部分，
#     只有超出的才真到账 —— 否则大组长补一张审批，钱就重复发一次。
#   · 台账**只有管理员能看**（组织树里对非管理员不返回，通知里也不写）。

def _unapproved_add(s, uid: int, fen: int) -> None:
    """管理员拨款时调用，**与拨款同一个事务**。"""
    from .db import BudgetUnapproved
    if fen <= 0:
        return
    row = s.get(BudgetUnapproved, uid)
    if row is None:
        row = BudgetUnapproved(user_id=uid, fen=0, updated_at=_now())
        s.add(row)
    row.fen = int(row.fen or 0) + int(fen)
    row.updated_at = _now()


def _unapproved_take(s, uid: int, fen: int) -> int:
    """从某人的未审批额里扣掉最多 `fen`（下限 0），返回实际扣掉的。"""
    from .db import BudgetUnapproved
    row = s.get(BudgetUnapproved, uid)
    if row is None or fen <= 0:
        return 0
    took = min(int(row.fen or 0), int(fen))
    row.fen = int(row.fen or 0) - took
    row.updated_at = _now()
    return took


def approval_scope(s, target_uid: int) -> list[int]:
    """一张审批单能冲抵哪些人的未审批额：**申请人这一支**。

    = 申请人自己 + 名下所有人，但**不穿过下面的另一个大组长**（那是另一支，
    由那位大组长自己补审批）。于是：
      · 大组长 → 自己这一组；
      · 管理员乙这样的管理员 → 他名下**没有归属大组长**的小组长/生成师
        （用户裁定：这部分额度算在他头上）；
      · 小组长自己提的单 → 他和他名下的人。
    """
    rows = {int(u.user_id): u for u in s.query(UserBudget).all()}
    kids = _children(rows)
    out, stack, seen = [], [int(target_uid)], set()
    while stack:
        u = stack.pop()
        if u in seen:
            continue
        seen.add(u)
        out.append(u)
        for k in kids.get(u, []):
            if k in rows and canon_role(rows[k].org_role) == ROLE_LEAD:
                continue
            stack.append(k)
    return out


def offset_unapproved(s, target_uid: int, amount: int) -> int:
    """审批通过时用审批额冲抵申请人这一支的未审批额，返回冲抵掉的总额。

    逐人冲减，余额大的先冲（顺序只影响"台账里冲的是谁那一笔"，不影响总额）。
    调用方负责在同一个事务里把剩下的 `amount - 返回值` 拨出去。
    """
    from .db import BudgetUnapproved
    scope = approval_scope(s, target_uid)
    rows = (s.query(BudgetUnapproved)
            .filter(BudgetUnapproved.user_id.in_(scope), BudgetUnapproved.fen > 0)
            .order_by(BudgetUnapproved.fen.desc(), BudgetUnapproved.user_id).all())
    left = int(amount)
    for r in rows:
        if left <= 0:
            break
        left -= _unapproved_take(s, int(r.user_id), left)
    return int(amount) - left


def _subtree(uid: int, rows: dict[int, UserBudget] | None = None) -> set[int]:
    """`uid` 的全部后代（**不含自己**）。纯按 manager_id 向下，visited 防环。"""
    if rows is None:
        with get_session() as s:
            rows = {int(u.user_id): u for u in s.query(UserBudget).all()}
    kids = _children(rows)
    out: set[int] = set()
    stack = [int(uid)]
    while stack:
        cur = stack.pop()
        for k in kids.get(cur, []):
            if k not in out and k != uid:
                out.add(k)
                stack.append(k)
    return out


def in_scope(a: Actor, target: int, rows: dict[int, UserBudget] | None = None) -> bool:
    """`target` 归不归 `a` 管：管理员管全部，组长管**整棵子树**（不含自己）。"""
    if target == a.uid:
        return False
    if a.is_root:
        return True
    return target in _subtree(a.uid, rows)


def _root_ids(rows: dict[int, UserBudget]) -> list[int]:
    """树根 = **角色是最高管理员**的人。不看 manager_id 是否为空——
    无组的人 manager_id 也是空，按那个判就会多出一棵棵"生成师树"。"""
    return sorted(uid for uid, u in rows.items()
                  if is_root_role(u.org_role) and u.active)


def descendants(pool_id: str) -> list[str]:
    """池的全部后代个人池（不含自身）。`ROOT_POOL` = 从所有最高管理员往下。

    ⚠️ 无组的人**不在任何人的后代里**（包括管理员）——这正是"无组"的含义：
    他的钱和花费不进任何一条线的汇总。
    """
    with get_session() as s:
        rows = {int(u.user_id): u for u in s.query(UserBudget).all()}
    if pool_id == ROOT_POOL:
        starts = _root_ids(rows)
        found: set[int] = set()
        for r in starts:
            found |= _subtree(r, rows)
        found -= set(starts)
    elif pool_id.startswith(MEMBER_PREFIX):
        found = _subtree(int(pool_id[len(MEMBER_PREFIX):]), rows)
    else:
        found = set()
    return [_member_pool(u) for u in sorted(found)]


#: 兼容旧调用名
descendants_of = descendants


def save_org(name: str, user_ids: list[int], manager_id: int,
             node_id: str | None = None) -> dict:
    """（已废弃）组织关系一律走 `reconfigure` / `set_member`。"""
    raise RuntimeError("save_org 已废弃：组织关系请用 set_member / reconfigure")


def _root_user_id() -> int | None:
    """（兼容）第一个在岗的最高管理员。**按角色找，不按 manager_id 为空找**。"""
    with get_session() as s:
        rows = {int(u.user_id): u for u in s.query(UserBudget).all()}
    ids = _root_ids(rows)
    return ids[0] if ids else None


# ------------------------------------------------------------------ 组织视图

def _yuan(fen: int) -> str:
    fen = int(fen or 0)
    sign = "-" if fen < 0 else ""
    fen = abs(fen)
    return f"{sign}{fen // 100}.{fen % 100:02d}"


def _spent_by_user(uids: Iterable[int]) -> dict[int, int]:
    from .db import UsageEvent
    uids = list(uids)
    if not uids:
        return {}
    with get_session() as s:
        rows = (s.query(UsageEvent.user_id, func.coalesce(func.sum(UsageEvent.cost_fen), 0))
                .filter(UsageEvent.user_id.in_(uids))
                .group_by(UsageEvent.user_id).all())
    return {int(u): int(f or 0) for u, f in rows}


def _platform_admin_ids() -> set[int]:
    """登录过的平台管理员（admin / superadmin）。

    ⚠️ 他们**不能被拉进任何组**："管理员账号"是树根、无限积分，挂到某个
    大组长名下当生成师是个没有意义、而且会让界面自相矛盾的状态。
    实测出现过：dev 的平台管理员还没打开过积分页（所以还没被初始化成根），
    就以「无组的人」身份出现在了大组长的可拉名单里（2026-10-14）。
    """
    from .access import _ADMIN_ROLES
    from .auth import AuthSession
    with get_session() as s:
        return {int(u) for (u,) in s.query(AuthSession.user_id)
                .filter(AuthSession.role.in_(tuple(_ADMIN_ROLES))).distinct().all()}


def _admin_ids_any() -> set[int]:
    """**曾经**是平台管理员的人（会话 ∪ 名录）。只给"不能被拉进组"这类**保护性**
    判定用，不放行任何东西。

    ## 为什么需要它（而 `_platform_admin_ids` 又刻意不改）

    `_platform_admin_ids` 只看**活着**的会话，这是对的：角色是"此刻的权限"，
    上游把人从 admin 降级之后，只要他没再登录，名录里仍写着 admin ——
    拿陈旧的角色去**放行**是不行的。

    但"不能被拉进组"是反方向的要求：**宁可少给一个入口，也不能把管理员
    挂到某个组长名下**。把无组名单的人口来源换成名录之后，一个会话已失效的
    管理员会以"无组的人"身份出现，而 `set_member` 里那句
    `if user_id in _platform_admin_ids()` 也查不到他 —— 于是**真的会被拉进组**。
    所以排除判定用这个并集，放行判定仍用会话版。
    """
    from .access import _ADMIN_ROLES
    from .auth import AuthSession, KnownUser
    roles = tuple(_ADMIN_ROLES)
    with get_session() as s:
        out = {int(u) for (u,) in s.query(AuthSession.user_id)
               .filter(AuthSession.role.in_(roles)).distinct().all()}
        out |= {int(u.user_id) for u in s.query(KnownUser)
                .filter(KnownUser.role.in_(roles)).all()}
    return out


def _ungrouped(rows: dict[int, UserBudget], pools: dict[str, BudgetPool]) -> list[dict]:
    """可以被拉进组的人：组织里无组的 + 登录过但还没进组织的。

    ## 人口来源是**名录**，不是会话表（2026-10-22 修）

    此前这里只读 `auth_sessions`，于是「登录过、但会话已过期 / 已退出、还没进组织」
    的人从界面上**彻底消失**：积分页的无组栏没有他，编辑组织也搜不到他，
    管理员没有任何入口把他拉进组。生产上真实发生过（用户乙，
    名录取有登录记录、会话表零行），同期另有两人同状态。

    判据改成 `user_directory.directory()`（名录 ∪ 会话）。名录是会话的**严格超集**
    （登录时两者在同一事务里写入，会话删了名录还在），所以这个改动不会让任何人
    从名单里消失，只会让原本看不到的人出现。

    每人多带两个字段：
      · `last_login_at` —— 上次登录时间，界面显示"上次登录 10-14"；
      · `stale` —— True = 当前没有有效会话。**不影响能不能拉**：
        拉人写的是组织表，与他的会话无关；标出来只是让管理员知道
        "这个人现在登录不进来"（会话过期而已，他重新登录即可）。

    ⚠️ 只给名字和 id，**不给**他们原来的上下级关系——小组长要能看到"谁可拉"，
    但不该借此看到别的组的结构。在组里的人一律不出现在这里，所以一个组长
    没法通过这个列表把别人组里的人"抢"过来（`set_member` 也会再拒一次）。
    """
    from .user_directory import active_session_user_ids, directory
    out: dict[int, dict] = {}
    for uid, u in rows.items():
        if u.manager_id is None and not is_root_role(u.org_role):
            p = pools.get(_member_pool(uid))
            out[uid] = {"user_id": uid, "name": u.name or str(uid), "username": "",
                        "in_org": True, "active": bool(u.active),
                        "balance_fen": int(p.balance_fen or 0) if p else 0,
                        "last_login_at": None, "stale": False}
    admins = _admin_ids_any()
    with get_session() as s:
        people = directory(s)
        alive = active_session_user_ids(s)
    for uid in admins:
        out.pop(uid, None)
    for uid, u in people.items():
        uid = int(uid)
        if uid in admins:
            continue
        username = u.get("username") or ""
        if uid in rows:
            if uid in out and not out[uid]["username"]:
                out[uid]["username"] = username
            if uid in out:
                out[uid]["last_login_at"] = u.get("last_login_at")
            continue
        if uid not in out:
            out[uid] = {"user_id": uid,
                        "name": (u.get("display_name") or username or str(uid)),
                        "username": username, "in_org": False, "active": True,
                        "balance_fen": 0,
                        "last_login_at": u.get("last_login_at"),
                        "stale": uid not in alive}
    # 最近登录的排前面：名录只增不减，不排序的话历史账号会把活跃的人挤到后面。
    #
    # 用**稳定的多次排序**而不是拼一个混合升降序的 key：
    # `sorted` 是稳定的，所以从最次要的键开始排、最后排最重要的键即可，
    # 不必把时间戳反转成字符串（那种写法遇到不补零的存量值就会错位）。
    res = sorted(out.values(), key=lambda x: (x["name"], x["user_id"]))
    res.sort(key=lambda x: x.get("last_login_at") or "", reverse=True)  # 新的在前
    res.sort(key=lambda x: bool(x.get("last_login_at")))                # 有时间的在前
    res.sort(key=lambda x: bool(x["in_org"]))                           # 已在组织的在前
    for r in res:
        r["balance_yuan"] = _yuan(r["balance_fen"])
    return res


def list_org(actor: Actor | None = None) -> dict:
    """组织树视图，**按操作者裁剪**：

      · 最高管理员 / 平台管理员：全树 + 全部无组的人；
      · 大组长 / 小组长：以**自己**为根的那棵子树 + 无组的人（供拉人）；
      · 生成师：无权（PermissionError → 403，前端据此藏起整块）。

    每个节点带：余额、本人花费、子树人数、子树合计余额/花费 —— 编辑页和积分页
    共用这一份，界面上"这一组还剩多少钱、花了多少"直接读，不在前端再加一遍。
    """
    a = actor or _require_editor()
    if not a.can_edit:
        raise PermissionError("你没有下辖成员")
    if a.is_root:
        ensure_admin_roots()          # 其他管理员也要在树里（见 _bootstrap_root）
    with get_session() as s:
        rows = {int(u.user_id): u for u in s.query(UserBudget).all()}
        pools = {p.pool_id: p for p in s.query(BudgetPool).all()}
        # 「其中 XXX 未审批」：管理员先垫、还没走完审批的金额（见 notify.unapproved_*）。
        # 一次全取，避免每个节点查一次。
        from .db import BudgetUnapproved
        pend = {int(x.user_id): int(x.fen or 0) for x in s.query(BudgetUnapproved).all()}
    kids = _children(rows)
    spent = _spent_by_user(rows.keys())

    def dto(uid: int, depth: int = 0, seen: frozenset = frozenset()) -> dict:
        u = rows[uid]
        p = pools.get(_member_pool(uid))
        bal = int(p.balance_fen or 0) if p else 0
        members = [dto(k, depth + 1, seen | {uid}) for k in kids.get(uid, [])
                   if k not in seen and depth < 16]
        sub_bal = bal + sum(m["subtree_balance_fen"] for m in members)
        sub_spent = spent.get(uid, 0) + sum(m["subtree_spent_fen"] for m in members)
        sub_pend = pend.get(uid, 0) + sum(m.get("subtree_unapproved_fen", 0) for m in members)
        head = 1 + sum(m["headcount"] for m in members)
        return {
            "user_id": uid, "name": u.name or str(uid),
            "role": canon_role(u.org_role) or ROLE_MEMBER,
            "manager_id": u.manager_id, "active": bool(u.active),
            "balance_fen": bal, "balance_yuan": _yuan(bal),
            "spent_fen": spent.get(uid, 0), "spent_yuan": _yuan(spent.get(uid, 0)),
            "headcount": head,
            "subtree_balance_fen": sub_bal, "subtree_balance_yuan": _yuan(sub_bal),
            "subtree_spent_fen": sub_spent, "subtree_spent_yuan": _yuan(sub_spent),
            "members": members,
            # 未审批台账**只给管理员**（2026-10-17 用户裁定）：组长看自己那棵子树时
            # 整对字段都不出现，而不是给 0 —— 给 0 等于告诉他"你这一支都批过了"。
            **({"unapproved_fen": pend.get(uid, 0), "unapproved_yuan": _yuan(pend.get(uid, 0)),
                "subtree_unapproved_fen": sub_pend, "subtree_unapproved_yuan": _yuan(sub_pend)}
               if a.is_root else {}),
        }

    if a.is_root:
        tops = _root_ids(rows)
        if a.uid in rows and a.uid not in tops and rows[a.uid].manager_id is None:
            tops = [a.uid] + tops     # 不在树里的平台管理员：至少看得到自己
        roots = [dto(t) for t in tops if t in rows]
    else:
        roots = [dto(a.uid)] if a.uid in rows else []

    assignable = [r for r in (ROLE_LEAD, ROLE_SUBLEAD, ROLE_MEMBER) if rank(r) < a.rank]
    return {
        "me": {"user_id": a.uid, "role": ROLE_ADMIN if a.is_root else a.role,
               "is_root": a.is_root, "can_edit": a.can_edit,
               # 管理员下拨不扣自己的钱（"管理员账号无限积分"）
               "unlimited": a.is_root,
               "assignable_roles": assignable},
        "roots": roots,
        "ungrouped": _ungrouped(rows, pools),
    }


# ------------------------------------------------------------------ 拉人 / 移出 / 任命

def set_member(user_id: int, manager_id: int, role: str = ROLE_MEMBER,
               name: str | None = None) -> dict:
    """把 `user_id` 放到 `manager_id` 名下、并设为 `role`。三种用法同一个入口：

      · **拉人**：对象是无组的人（或还没进组织的人）→ 进我的组；
      · **调整**：对象已在我子树里 → 换上级 / 改角色；
      · 管理员：对象可以是任何人（除最高管理员自己）。

    ## 拒绝的情形（每一条都是一个真实的提权/错账路径）

    | 规则 | 不这样会怎样 |
    |---|---|
    | 只能任命**比自己低**的角色 | 小组长把组员提成大组长 → 越过自己的上级 |
    | 新上级必须是我或我子树里的人 | 把人挂到别的组下 = 往别人组里塞人 |
    | 对象在别人组里 → 拒 | 拉人变成"抢人"，原组长的人凭空少了 |
    | 新上级的级别必须高于对象 | 小组长挂在生成师下面，树倒挂 |
    | 名下还有级别不低于新角色的人 → 拒 | 降级后出现"生成师管着小组长" |
    | 新上级是对象自己的后代 → 拒 | 成环，两人的钱互相算进对方子树 |
    """
    a = _require_editor()
    user_id, manager_id = int(user_id), int(manager_id)
    new_role = canon_role(role)
    if not new_role:
        raise ValueError(f"未知角色「{role}」（可选：{' / '.join(ALL_ROLES)}）")
    if new_role == ROLE_ADMIN:
        raise ValueError("最高管理员全平台只有一位，不能在这里任命")
    if rank(new_role) >= a.rank:
        raise PermissionError(f"你只能任命比自己低的角色，不能任命「{new_role}」")
    if user_id == a.uid:
        raise ValueError("不能修改自己的位置")
    if manager_id == user_id:
        raise ValueError("上级不能是他自己")

    with get_session() as s:
        rows = {int(u.user_id): u for u in s.query(UserBudget).all()}
        t = rows.get(user_id)
        if t is not None and is_root_role(t.org_role):
            raise PermissionError("不能调整最高管理员")
        if user_id in _admin_ids_any():
            raise PermissionError("平台管理员账号不能被拉进组（他是组织的最高管理员）")
        grouped = t is not None and t.manager_id is not None and bool(t.active)
        if grouped and not in_scope(a, user_id, rows):
            raise PermissionError(
                f"{t.name or user_id} 在别人的组里。需要先由他现在的上级把他移出，"
                f"变成无组之后才能拉进来")
        if t is not None and not a.is_root and grouped and rank(t.org_role) >= a.rank:
            raise PermissionError(f"{t.name} 的级别不低于你，不能调整")

        m = rows.get(manager_id)
        if m is None or not m.active:
            raise ValueError(f"上级 {manager_id} 不在组织里或已停用")
        if not (a.is_root or manager_id == a.uid or manager_id in _subtree(a.uid, rows)):
            raise PermissionError("只能把人放到你自己或你组里的人名下")
        if rank(m.org_role) <= rank(new_role):
            raise ValueError(f"{m.name}（{canon_role(m.org_role) or m.org_role}）"
                             f"不能管理「{new_role}」——上级的级别必须更高")
        if manager_id in _subtree(user_id, rows):
            raise ValueError(f"{m.name} 是 {t.name if t else user_id} 的下属，不能反过来当他的上级")
        if t is not None:
            blockers = [rows[k] for k in _children(rows).get(user_id, [])
                        if rank(rows[k].org_role) >= rank(new_role)]
            if blockers:
                raise ValueError(
                    f"{t.name} 名下还有 {len(blockers)} 人的级别不低于「{new_role}」"
                    f"（{'、'.join((b.name or str(b.user_id)) for b in blockers[:3])}），"
                    f"先把他们移走再改")

        if t is None:
            t = UserBudget(user_id=user_id, created_at=_now())
            s.add(t)
        t.name = ((name or "").strip() or t.name or _display_name(s, user_id)
                  or str(user_id))[:64]
        t.org_role = new_role
        t.manager_id = manager_id
        t.active = 1
        t.updated_at = _now()
        _ensure_member_pool(s, user_id, t.name)
        s.flush()
        _assert_acyclic(s)
        s.commit()
        log.info("[budget] %s 把 %s 设为 %s 名下的%s", a.uid, user_id, manager_id, new_role)
        return {"user_id": user_id, "name": t.name, "role": new_role,
                "manager_id": manager_id}


def remove_member(user_id: int) -> dict:
    """把人**移出组** → 变成无组（`manager_id = NULL`，角色回到生成师）。

    ⚠️ **不是停用**。人照样能登录、账户和流水都在，只是不归任何人管、
    不进任何一条线的汇总；任何组长都可以再把他拉进自己的组。离职的人
    飞书那边已经登不上了，不需要在这一侧另做标记（用户裁定，2026-10-14）。

    角色回到生成师：组长/小组长是"组里的位置"，人出了组位置就不在了。
    留着头衔会出现"无组的大组长"，下次被拉进某个小组时还得先降级。

    ⚠️ 名下还有人时**拒绝**，不连带移出也不自动转交：那两种都是替用户
    做了一个他没说的决定（整组人突然无组 / 突然换了领导）。

    余额**留在他身上**，不自动收回 —— 要收回请先调 `revoke_from_member`
    （编辑页的移出确认框里默认勾了"同时收回余额"，就是走那条）。
    """
    a = _require_editor()
    user_id = int(user_id)
    if user_id == a.uid:
        raise ValueError("不能把自己移出")
    with get_session() as s:
        rows = {int(u.user_id): u for u in s.query(UserBudget).all()}
        t = rows.get(user_id)
        if t is None:
            raise LookupError("该用户不在组织里")
        if is_root_role(t.org_role):
            raise PermissionError("不能移出最高管理员")
        if not in_scope(a, user_id, rows):
            raise PermissionError(f"{t.name or user_id} 不在你的组里")
        if t.manager_id is None:
            raise ValueError(f"{t.name} 已经是无组状态")
        kids = _children(rows).get(user_id, [])
        if kids:
            names = "、".join((rows[k].name or str(k)) for k in kids[:3])
            raise ValueError(f"{t.name} 名下还有 {len(kids)} 人（{names}），"
                             f"先把他们移走或转给别人")
        t.manager_id = None
        t.org_role = ROLE_MEMBER
        t.updated_at = _now()
        s.commit()
        p = s.get(BudgetPool, _member_pool(user_id))
        bal = int(p.balance_fen or 0) if p else 0
    log.info("[budget] %s 把 %s 移出组（余额 %d 分留在其账上）", a.uid, user_id, bal)
    return {"user_id": user_id, "ungrouped": True, "balance_fen": bal,
            "balance_yuan": _yuan(bal)}


# ------------------------------------------------------------------ 余额与划拨

def _balances(pool: BudgetPool | None, uid: int | None = None) -> dict:
    """余额 + 累计进出。**单位分。**

      · granted_fen   = 收入类流水之和（grant / revoke 的负值）
      · allotted_fen  = 下拨给下属的净额（allot − reclaim）
      · used_fen      = 已花掉的净额（spend + 已结算的 hold − 退款）
      · held_fen      = 还在冻结中的预扣（尚未结算）
      · available_fen = 池里的现钱（唯一能从 pools 表直接读的数）

    恒等式：**可用 = 累计 − 下拨 − 已花 − 冻结**。
    """
    if pool is None:
        return {"granted_fen": 0, "allotted_fen": 0, "used_fen": 0, "held_fen": 0,
                "available_fen": 0, "available_yuan": "0.00"}
    g = int(pool.balance_fen or 0)
    granted = allotted = used = held = 0
    if uid is not None:
        granted, allotted, used, held = _flow_totals(uid)
    return {
        "granted_fen": granted,
        "allotted_fen": allotted,
        "used_fen": used,
        "held_fen": held,
        "available_fen": g,
        "available_yuan": _yuan(g),
    }


def _flow_totals(uid: int) -> tuple[int, int, int, int]:
    """(累计入账, 下拨出去, 已花费, 冻结中) —— 全部从 `budget_ledger` 现算。

    行数级：一个人一辈子的流水也就是几百行，且这个函数只在看账户/顶栏时调。
    刻意不缓存、不加冗余列——钱的账最怕两套数打架，宁可每次现算。

    ## 口径（必须满足恒等式：可用 = 累计 − 下拨 − 已花 − 冻结）

    | 流水 entry | 含义 | 归到哪一项 |
    |---|---|---|
    | grant   | 上级划拨进来 | 累计 + |
    | revoke  | 被上级收回（负数） | 累计 +（负数） |
    | allot   | 我下拨给下属（负数，2026-10-14 起组长下拨扣自己） | 下拨 + |
    | reclaim | 我从下属收回（正数） | 下拨 − |
    | spend   | 同步旁路即时扣（负数） | 已花 + |
    | hold    | 预扣冻结（负数） | 先记冻结，见下 |
    | settle / refund | 结算落地的标记，amount=**退回来的钱** | 见下 |

    冻结与已花的换算（这是最容易写错的地方）：
      · 一笔 hold **没有**对应的 settle → 钱还没落地，算**冻结**；
      · 有 settle → 那笔 hold 全额算**已花**，再把 settle 退回来的钱**减掉**，
        剩下的正好是这次任务的**实际花费**（= 预扣 − 退款）。

    ⚠️ 下拨**不算花费**：组长把 500 分给组员，那 500 没被花掉，只是换了口袋。
    算进"已花"的话，组长的花费会是他全组花费的两倍（他下拨一次、组员花一次）。

    ⚠️ `refund` 是 P1 下半早期的写法，仍被识别为结算标记，免得存量数据算成"永远冻结"。
    """
    from .db import BudgetLedger
    pool_id = _member_pool(uid)
    with get_session() as s:
        rows = (s.query(BudgetLedger.entry, BudgetLedger.amount,
                        BudgetLedger.job_id)
                .filter(BudgetLedger.pool_id == pool_id).all())
    granted = allotted = used = 0
    holds: dict[str, int] = {}       # job_id → 冻结额（正数）
    settled: set[str] = set()        # 已落地的 job_id
    for entry, amount, job_id in rows:
        a = int(amount or 0)
        if entry in ("grant", "revoke"):
            granted += a
        elif entry in ("allot", "reclaim"):
            allotted += -a
        elif entry == "spend":
            used += -a
        elif entry == "hold":
            if job_id:
                holds[job_id] = holds.get(job_id, 0) + (-a)
        elif entry in ("settle", "refund"):
            if job_id:
                settled.add(job_id)
            used -= a                    # 退回来的钱不算花掉
    held = sum(v for k, v in holds.items() if k not in settled)
    used += sum(v for k, v in holds.items() if k in settled)
    return granted, allotted, max(0, used), max(0, held)


def _take(s, pool_id: str, amount: int) -> bool:
    """从池里**原子地**扣 `amount`，余额不够返回 False、一分不动。

    ⚠️ 必须是一条带条件的 UPDATE，不能"先读余额、判断、再写回"：
    那样两个并发请求（组长同时下拨两笔、或下拨与提交生成撞上）会各自读到
    同一个旧余额，都判"够"，后写的那个把先写的扣减覆盖掉 —— 钱凭空多出来。
    """
    n = (s.query(BudgetPool)
         .filter(BudgetPool.pool_id == pool_id, BudgetPool.balance_fen >= amount)
         .update({BudgetPool.balance_fen: BudgetPool.balance_fen - amount,
                  BudgetPool.updated_at: _now()}, synchronize_session=False))
    return n == 1


def _give(s, pool_id: str, amount: int, label: str = "") -> None:
    _ensure_member_pool(s, int(pool_id[len(MEMBER_PREFIX):]), label)
    s.flush()
    (s.query(BudgetPool).filter(BudgetPool.pool_id == pool_id)
     .update({BudgetPool.balance_fen: BudgetPool.balance_fen + amount,
              BudgetPool.updated_at: _now()}, synchronize_session=False))


def _pool_fen(s, uid: int) -> int:
    p = s.get(BudgetPool, _member_pool(uid))
    if p is not None:
        s.refresh(p)
    return int(p.balance_fen or 0) if p else 0


def grant_to_member(uid: int, amount_yuan) -> dict:
    """下拨额度给自己组里的人（**可以跨级**，子树里任何人都行）。

    | 谁下拨 | 钱从哪来 |
    |---|---|
    | 最高管理员 / 平台管理员 | **无限**，不扣任何人（用户裁定："管理员账号无限积分"） |
    | 大组长 / 小组长 | **扣自己的余额**，不能超过自己的余额 |

    扣与加在**同一个事务**里，并写两条对称流水（我 `allot −x`、对方 `grant +x`），
    中途失败两边一起回滚 —— 否则会出现"钱扣了没到"或"凭空多出"。
    """
    amount = _fen(amount_yuan)
    if amount <= 0:
        raise ValueError("划拨金额必须大于 0")
    a = _require_editor()
    if uid == a.uid:
        raise ValueError("不能给自己划拨")
    target = _require_grant_target(uid)
    if not in_scope(a, uid):
        raise ValueError(f"只能给自己组里的人划拨（{target.name} 不在你的组里）")
    with get_session() as s:
        tid = _member_pool(uid)
        if a.is_root:
            src_note = "管理员分配"
        else:
            if not _take(s, _member_pool(a.uid), amount):
                have = _pool_fen(s, a.uid)
                raise ValueError(f"你的余额不足：可用 {_yuan(have)} 积分，"
                                 f"要分配 {_yuan(amount)} 积分")
            s.add(BudgetLedger(id=uuid.uuid4().hex[:16], ts=_now(),
                               pool_id=_member_pool(a.uid), user_id=a.uid,
                               entry="allot", amount=-amount,
                               note=f"分配给 {target.name}（{a.uid}→{uid}）"[:255]))
            src_note = "上级分配"
        _give(s, tid, amount, target.name)
        s.add(BudgetLedger(id=uuid.uuid4().hex[:16], ts=_now(), pool_id=tid,
                           user_id=a.uid, entry="grant", amount=amount,
                           note=f"{src_note}（{a.uid}→{uid}）"))
        if a.is_root:
            # 管理员直接拨 = 没有审批依据 → 记进未审批台账（与拨款同一事务）
            _unapproved_add(s, uid, amount)
        s.commit()
        bal = _pool_fen(s, uid)
        mine = None if a.is_root else _pool_fen(s, a.uid)
    return {"user_id": uid, "granted_fen": amount,
            "available_fen": bal, "available_yuan": _yuan(bal),
            "my_available_fen": mine,
            "my_available_yuan": None if mine is None else _yuan(mine)}


def revoke_from_member(uid: int, amount_yuan) -> dict:
    """从自己组里的人收回额度。不能把对方收成负数。

    收回的钱**回到收回者身上**（与下拨对称）；管理员收回的钱直接消失
    （他是无限的，没有"回到哪"）。
    """
    a = _require_editor()
    amount = _fen(amount_yuan)
    if amount <= 0:
        raise ValueError("回收金额必须大于 0")
    if uid == a.uid:
        raise ValueError("不能收回自己的额度")
    target = _require_grant_target(uid, allow_inactive=True)
    if not in_scope(a, uid):
        raise ValueError(f"只能回收自己组里的人的额度（{target.name} 不在你的组里）")
    with get_session() as s:
        tid = _member_pool(uid)
        _ensure_member_pool(s, uid, target.name)
        s.flush()
        if not _take(s, tid, amount):
            raise ValueError(f"回收额超过余额（{target.name} 现有 {_yuan(_pool_fen(s, uid))} 积分）")
        s.add(BudgetLedger(id=uuid.uuid4().hex[:16], ts=_now(), pool_id=tid,
                           user_id=a.uid, entry="revoke", amount=-amount,
                           note=f"回收（{a.uid}←{uid}）"))
        if a.is_root:
            # 管理员把没审批的钱收回去了 → 这部分也就不用补审批了
            _unapproved_take(s, uid, amount)
        if not a.is_root:
            _give(s, _member_pool(a.uid), amount)
            s.add(BudgetLedger(id=uuid.uuid4().hex[:16], ts=_now(),
                               pool_id=_member_pool(a.uid), user_id=a.uid,
                               entry="reclaim", amount=amount,
                               note=f"从 {target.name} 收回（{a.uid}←{uid}）"[:255]))
        s.commit()
        bal = _pool_fen(s, uid)
    return {"user_id": uid, "revoked_fen": amount,
            "available_fen": bal, "available_yuan": _yuan(bal)}


def _require_grant_target(uid: int, *, allow_inactive: bool = False) -> UserBudget:
    with get_session() as s:
        u = s.get(UserBudget, uid)
        if u is None:
            raise ValueError(f"用户 {uid} 还没有积分账户（先把他拉进组）")
        if not u.active and not allow_inactive:
            raise ValueError(f"{u.name} 已不在岗")
        return u


def my_balance() -> dict:
    """当前登录者的额度（一人一池）。管理员额外带 `unlimited: true`。"""
    a = current_actor()
    with get_session() as s:
        u = s.get(UserBudget, a.uid)
        pool = s.get(BudgetPool, _member_pool(a.uid))
    bal = _balances(pool, a.uid)
    out = {"role": ROLE_ADMIN if a.is_root else (canon_role(u.org_role) if u else ROLE_MEMBER),
           "name": u.name if u else "", "unlimited": a.is_root,
           "ungrouped": bool(u and u.manager_id is None and not a.is_root),
           "in_org": a.in_org, **bal}
    out["ledger"] = []
    return out


def account(user_id: int) -> dict:
    """某人账户详情 + 流水（本人 / 子树上方的任何一级 / 管理员）。"""
    from . import access
    me = access.current_user_id()
    with get_session() as s:
        target = s.get(UserBudget, user_id)
        if target is None:
            raise LookupError("该用户没有积分账户")
        pool = s.get(BudgetPool, _member_pool(user_id))
        rows = (s.query(BudgetLedger)
                .filter(BudgetLedger.pool_id == _member_pool(user_id))
                .order_by(BudgetLedger.ts.desc(), BudgetLedger.id.desc()).limit(200).all())
    if not _can_view_account(me, user_id):
        raise PermissionError("无权查看该账户")
    return {
        "user_id": user_id, "name": target.name,
        "role": canon_role(target.org_role) or target.org_role,
        "manager_id": target.manager_id, **_balances(pool, user_id),
        "ledger": [{"ts": r.ts, "entry": r.entry, "amount_fen": r.amount,
                    "amount_yuan": _yuan(r.amount), "note": r.note} for r in rows],
    }


def _can_view_account(me: int | None, target: int) -> bool:
    """本人、管理员、以及**子树上方任何一级**（大组长能看小组长组里的人）。"""
    if me is None:
        return False
    if me == target:
        return True
    a = current_actor()
    return in_scope(a, target)


def user_usage(user_id: int, *, since: str | None = None,
               until: str | None = None) -> dict:
    """某人花了多少（来自 usage_events，P0 采集）。只读。"""
    from .db import UsageEvent
    from .pricing import fen_to_yuan
    with get_session() as s:
        q = s.query(func.coalesce(func.sum(UsageEvent.cost_fen), 0),
                    func.count(UsageEvent.id))
        q = q.filter(UsageEvent.user_id == user_id)
        if since:
            q = q.filter(UsageEvent.ts >= since)
        if until:
            q = q.filter(UsageEvent.ts < until)
        fen, n = q.one()
    fen = int(fen or 0)
    return {"user_id": user_id, "spent_fen": fen, "spent_yuan": fen_to_yuan(fen),
            "calls": int(n or 0)}


def subtree_usage(pool_id: str) -> dict:
    """一条线（本人 + 全部后代）的总花费与总余额。

    ⚠️ `ROOT_POOL` 是遍历哨兵：翻译成"所有最高管理员本人 + 他们的子树"，
    否则管理员自己账上的钱不计入他这条线（实测复现过，2026-10-14）。
    """
    from .db import UsageEvent
    from .pricing import fen_to_yuan

    with get_session() as s:
        pools = {p.pool_id: p for p in s.query(BudgetPool).all()}
        rows = {int(u.user_id): u for u in s.query(UserBudget).all()}

    if pool_id == ROOT_POOL:
        heads = [_member_pool(r) for r in _root_ids(rows)]
    else:
        heads = [pool_id]
    ids = list(dict.fromkeys(heads + [d for h in heads for d in descendants_of(h)]))
    member_uids = sorted({int(i[len(MEMBER_PREFIX):]) for i in ids
                          if i.startswith(MEMBER_PREFIX)})
    granted = sum(int(pools[i].balance_fen or 0) for i in ids if i in pools)
    fen = 0
    with get_session() as s:
        if member_uids:
            fen = int(s.query(func.coalesce(func.sum(UsageEvent.cost_fen), 0))
                      .filter(UsageEvent.user_id.in_(member_uids)).scalar() or 0)
    return {"pool_id": heads[0] if heads else pool_id, "user_ids": member_uids,
            "granted_fen": granted, "granted_yuan": fen_to_yuan(granted),
            "spent_fen": fen, "spent_yuan": fen_to_yuan(fen),
            "pool_count": len(ids)}
