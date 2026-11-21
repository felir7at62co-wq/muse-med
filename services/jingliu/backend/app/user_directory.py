"""「登录过的人」的唯一人口来源：名录 ∪ 现存会话。

## 为什么这个模块存在（2026-10-22 事故）

本服务**没有用户表**——用户在上游剧本平台，登录时随会话信息一起下发。
此前各处各自决定"从哪张表读人"，于是出现了两份事实来源：

  · `auth_sessions` = 谁**此刻**有有效会话。会话过期（7 天）、用户主动退出、
    服务启动时的 `cleanup_expired_sessions` 都会让它**减少**；
  · `known_users`  = 谁**曾经**登录过。`auth._remember_user` 在签发会话的同一个
    事务里写入，**从不删除**。

生产事故：用户乙登录过（名录取 `last_login_at` 有值），但他没有会话行、
也还没进积分组织——而积分页「无组的人」只读会话表，于是他在界面上**不存在**，
管理员连"把他拉进组"的入口都没有。同期还有两个人处在这个状态。

结论：**判"这个人该不该被看见"要用名录**；只有判"他此刻的权限是什么"才该用会话
（见 `budget._platform_admin_ids` 的说明——那里刻意不动）。

## 为什么放在 `app/` 而不是 `routers/`

原先这个函数长在 `routers/library.py`，而 `budget.py`、`routes_v2.py`、
`routers/project.py` 都要跨层 import 它（`from .routers.library import ...`）。
数据拼接不属于任何一个路由，下沉之后那些跨层 import 可以逐处消掉。

`routers/library.py::_user_directory` 保留为一个转发壳，其余调用点一行不改 ——
这是刻意的：本次只修人口来源，不顺手做大范围重构。
"""
from __future__ import annotations


def directory(session) -> dict[int, dict]:
    """登录过的用户：`{user_id: {id, username, display_name, role, last_login_at}}`。

    名录优先、现存会话兜底：

      · 名录里的行**一定**带上 `last_login_at`（可能为 NULL，存量行）；
      · 只在会话里、还没进名录的人（名录上线之前的会话 / 名录写入失败）
        也要能列出来，否则那批人会凭空消失——`last_login_at` 给 None。

    `role` 是**平台角色**（user / admin / superadmin），不是积分组织里的角色。
    别拿它做权限判定：它是"上次登录时的角色"，可能已经过时（见模块头最后一段）。
    """
    from .auth import AuthSession, KnownUser

    out: dict[int, dict] = {}
    for k in session.query(KnownUser).all():
        out[int(k.user_id)] = {
            "id": int(k.user_id), "username": k.username or "",
            "display_name": k.display_name, "role": k.role or "user",
            "last_login_at": k.last_login_at,
        }
    for a in session.query(AuthSession).all():
        uid = int(a.user_id)
        if uid in out:
            continue
        out[uid] = {
            "id": uid, "username": a.username or "",
            "display_name": a.display_name, "role": a.role or "user",
            "last_login_at": None,
        }
    return out


def active_session_user_ids(session) -> set[int]:
    """当前**有有效会话**的人。

    只回答"谁此刻登录着"，不回答"谁该被看见"。会话过期后这里会少人，
    这正是它不适合当人口来源的原因——需要人口来源请用 `directory()`。
    """
    from .auth import AuthSession

    return {int(u) for (u,) in session.query(AuthSession.user_id).distinct().all()}
