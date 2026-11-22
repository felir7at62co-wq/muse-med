"""草稿访问控制 —— 路由级鉴权依赖。

## 为什么单独一个模块

`_check_draft_access` 原本长在 `stages/router.py` 里，而 `router_m5_enhanced.py` 要用它
只能在函数体里延迟 import（两个模块互相引用，顶层 import 会成环）。放到这个只依赖
`..auth` / `..db` 的中立模块后，两边都能顶层 import，不再有环。

## 为什么用 `dependencies=[...]` 而不是往 handler 签名里塞参数

```python
@router.patch("/drafts/{draft_id}/chapters/{n}", dependencies=[Depends(require_draft_access)])
async def patch_chapter(draft_id: int, n: int, payload: ...):   # 签名一个字都不用改
```

好处：
- handler 的**签名和函数体完全不动** —— 仓库里以普通 Python 函数形式直接调用这些
  handler 的地方（内部编排、验证脚本）不会因为多了个必填 `user` 参数而报错；
- 鉴权只在 HTTP 层生效，语义清晰，一行一个路由，review 时一眼能看出哪些路由被保护了；
- `draft_id` 由 FastAPI 从**路径参数**自动绑定，不需要手动传。

⚠️ 代价：handler 内部拿不到 `user` 对象。需要按用户身份分支的（比如按角色给不同数据），
仍应显式在签名里写 `user: User = Depends(get_current_user)` 并自行调用 `check_draft_access`。
"""
from __future__ import annotations

from fastapi import Depends, HTTPException

from ..auth import get_current_user, User
from ..db import ScriptDraft, session_scope


ADMIN_ROLES = ("admin", "superadmin")


def is_admin_role(role: str | None) -> bool:
    """管理员角色判据 —— **全仓唯一**，别在别处再抄一份。

    ⚠️ 2026-10-25: 之前这段判断在十几处各写一遍，而 agent 的上下文组装
    (`context_loader.build_draft_context`) 与工具层 (`chat_skills`) **漏了这一段**，
    只比较 `draft.user_id != user_id`。后果不是"权限过宽"，而是**管理员看不到
    别人的稿子**：路由层 `check_draft_access` 放行，到了上下文层被静默清空，
    AI 于是回答"你没有把剧本内容贴上来"。
    """
    return (role or "").strip().lower() in ADMIN_ROLES


async def check_draft_access(s, draft_id: int, user: User, for_write: bool = False):
    """检查用户对 draft 的访问权限，返回 draft 对象。无权限抛 HTTPException。

    admin / superadmin 放行任意草稿；普通用户只能碰 `user_id` 等于自己的。

    ⚠️ `user_id IS NULL` 的历史草稿（dev 库有 3 条，2026-05 遗留）对普通用户一律 403。
    这与仓库里其它早就带鉴权的端点行为一致，不是本次改造引入的新限制。
    """
    row = await s.get(ScriptDraft, draft_id)
    if not row:
        raise HTTPException(404, "draft not found")
    if not is_admin_role(user.role) and row.user_id != user.id:
        raise HTTPException(403, "无权访问此草稿")
    return row


async def require_draft_access(draft_id: int, user: User = Depends(get_current_user)) -> None:
    """路由级依赖：要求登录 **且** 是该草稿的归属者（或管理员）。

    只加 `Depends(get_current_user)` 是不够的 —— 那只挡住了未登录，A 用户仍能改
    B 用户的草稿（draft_id 是自增整数，猜得到）。归属校验才是重点。
    """
    async with session_scope() as s:
        await check_draft_access(s, draft_id, user)
