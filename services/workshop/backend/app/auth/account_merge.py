"""账号认领与合并：把"扫码误建的空白号"并回本人原来的账号。

## 这个模块存在的原因（务必先读，改代码时别把死结又装回去）

飞书回调过去对任何陌生 union_id **无条件自动建号**。老用户（有账号密码的）
一旦顺手扫了码，就会拿到一个空白新号；而 `users.feishu_union_id` 是 UNIQUE，
这个新号从此**永久占住**他的飞书身份。等他想起来用密码登旧号、再去扫码绑定时，
`/feishu/link` 只会报 409「该飞书账号已绑定到…」。而 `/feishu/unlink` 是硬 403
（"请联系管理员"），后台却从来没有过任何飞书相关功能 —— 死结成型：
**旧号绑不上，新号退不掉，只能人工改库**。

dev 库里就躺着一具完整的尸体：user 14 被人工 UPDATE 清掉 union_id 解了死结，
但绑定时密码已被清空、解绑又没补回密码，于是 `has_pwd=f, fs_bound=f`，
**永久登不进来**。所以解绑必须与重设密码是**同一个原子操作**，见
`admin_routes.admin_feishu_unlink`。

## 为什么是"合并"而不是"二选一"

生产上被误建的空白号里已经有草稿、会话、记忆、生图任务了（实测有人在新号上
攒了 6 个草稿，老号上还有 2 个）。让用户挑一个 = 让他扔掉另一半。

好在合并在数据层是干净的：`script_drafts` 上只有 `script_drafts_pkey(id)`，
没有 `(user_id, title)` 之类的组合唯一约束，`UPDATE ... SET user_id` 天然能把
两批草稿并成一张列表。全库只有两张表在 user_id 上带唯一约束：

  * `user_profiles` —— `PRIMARY KEY(user_id)`，一人一行 → 保留老号那行，弃掉新号的
  * `tags` —— `UNIQUE(user_id, name)` → 同名标签把 `draft_tags` 指过去再删，
    不同名的直接搬

这两张表由 `_SPECIAL_UNIQUE` 显式处理；`_assert_no_unknown_unique` 会在**每次
合并前**重新扫一遍 pg_index，将来谁给别的表加了 user_id 唯一约束，会在动手前
当场报错，而不是跑到一半炸在事务中间。

被合并掉的号**不物理删除**，只置 `status='merged'` 并摘掉飞书绑定 ——
保留行是为了审计，也为了万一要回滚时还查得到 id 对应的是谁。
"""
from __future__ import annotations

import logging
from datetime import datetime

from sqlalchemy import text

from . import ephemeral as eph
from .models import User, UserAuditLog

logger = logging.getLogger("auth.merge")

# ---------------------------------------------------------------- 短时令牌
#
# 与 feishu_oauth 的 state 共用 `ephemeral` 模块（Redis + 一次性 + 墓碑）。
# 原来两处各有一份进程内存 dict，注释里也写着"将来多实例换 Redis（两处一起换）"
# —— 现在换了，两处一起。进程内存版的毛病见 ephemeral 模块头部注释：
# 重放与超时分不开、重启即失忆、多 worker 下签发方与消费方不是同一个进程。
#
# 用途有二：
#   claim —— 回调发现是**陌生**飞书身份时，不再直接建号，而是把身份暂存在
#            服务端、只把 token 交给前端，由用户在认领页选"新用户"还是"我有老账号"。
#            身份留在服务端，前端拿不到 union_id，也就伪造不了别人的身份。
#   merge —— /feishu/link 撞上"已被自动号占用"时签发，用户确认后凭它完成合并，
#            **免去再扫一次码**（飞书 code 一次性且 5 分钟过期，让用户重扫体验很差）。
_TOKEN_TTL = 1800


async def issue_token(kind: str, data: dict) -> str:
    """签发一次性令牌。kind: claim / merge。"""
    tok = eph.new_token()
    await eph.put(kind, tok, data, _TOKEN_TTL)
    return tok


async def peek_token(kind: str, token: str) -> dict:
    """只读取不消费 —— 认领页要先把飞书姓名显示出来给用户确认。"""
    if not token:
        raise eph.EphemeralError("unknown", "链接无效，请返回登录页重新扫码。")
    return await eph.peek(kind, token)


async def consume_token(kind: str, token: str) -> dict:
    """校验并**消费**令牌（一次性，防重放）。"""
    if not token:
        raise eph.EphemeralError("unknown", "链接无效，请返回登录页重新扫码。")
    return await eph.consume(kind, token)


# ---------------------------------------------------------------- 表结构探查

# 在 user_id 上带唯一约束、必须特殊处理的表（下面 merge_user_data 里逐个处理）
_SPECIAL_UNIQUE = {"user_profiles", "tags"}

# 审计日志**不搬**：它记录的是"这个账号上发生过什么"，
# 搬过去等于把新号的历史伪装成老号的历史。合并本身也会各写一条，
# 顺着 resource_id 就能串起两个账号。
_SKIP_TABLES = {"user_audit_logs"}


async def tables_with_user_id(s) -> list[str]:
    """运行时探查所有带 user_id 的业务表。

    刻意不硬编码表名清单：这个系统还在长（合并当天是 54 张表），
    写死一份清单意味着以后每加一张表就多一处静默丢数据的地方。
    """
    rows = (await s.execute(text("""
        SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND c.column_name = 'user_id'
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name
    """))).all()
    return [r[0] for r in rows]


async def _assert_no_unknown_unique(s) -> None:
    """任何在 user_id 上带唯一约束、又不在白名单里的表 → 拒绝合并。

    宁可在动手前报错，也不要 UPDATE 到一半撞上唯一键、把事务炸在中间。
    """
    rows = (await s.execute(text("""
        SELECT DISTINCT t.relname
        FROM pg_index x
        JOIN pg_class t ON t.oid = x.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
        WHERE x.indisunique
          AND EXISTS (
              SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = t.oid
                AND a.attnum = ANY(x.indkey)
                AND a.attname = 'user_id')
    """))).all()
    unknown = sorted({r[0] for r in rows} - _SPECIAL_UNIQUE)
    if unknown:
        raise RuntimeError(
            "以下表在 user_id 上新增了唯一约束，合并逻辑尚未覆盖，已中止："
            + ", ".join(unknown)
            + "（请在 account_merge._SPECIAL_UNIQUE 里补上对应的冲突处理）")


# ---------------------------------------------------------------- 数据搬迁

async def merge_user_data(s, *, src_id: int, dst_id: int) -> dict[str, int]:
    """把 src 名下所有业务数据改挂到 dst 名下。返回 {表名: 搬迁行数}。

    调用方必须在同一个事务里调用；本函数不 commit。
    """
    if src_id == dst_id:
        raise ValueError("源账号与目标账号相同")

    await _assert_no_unknown_unique(s)
    tables = await tables_with_user_id(s)
    moved: dict[str, int] = {}

    # --- tags：先解同名冲突（此刻 src 的标签还挂在 src 名下，能按 user_id 找到）
    # 同名标签不能两个都留（UNIQUE(user_id,name)），所以把挂在 src 标签上的草稿
    # 改挂到 dst 的同名标签，再把 src 那个标签删掉 —— 草稿一条不丢，标签不重复。
    res = await s.execute(text("""
        INSERT INTO draft_tags (draft_id, tag_id)
        SELECT dt.draft_id, dst.id
        FROM draft_tags dt
        JOIN tags src ON src.id = dt.tag_id AND src.user_id = :src
        JOIN tags dst ON dst.user_id = :dst AND dst.name = src.name
        ON CONFLICT DO NOTHING
    """), {"src": src_id, "dst": dst_id})
    if res.rowcount:
        moved["draft_tags(重挂到同名标签)"] = res.rowcount
    res = await s.execute(text("""
        DELETE FROM tags
        WHERE user_id = :src
          AND name IN (SELECT name FROM tags WHERE user_id = :dst)
    """), {"src": src_id, "dst": dst_id})
    if res.rowcount:
        moved["tags(同名已合并)"] = res.rowcount
    res = await s.execute(
        text("UPDATE tags SET user_id = :dst WHERE user_id = :src"),
        {"src": src_id, "dst": dst_id})
    if res.rowcount:
        moved["tags"] = res.rowcount

    # --- user_profiles：PRIMARY KEY(user_id)，一人一行。老号那行是本人长期
    # 积累的偏好，优先保留；新号那行（多半是扫码后系统默认生成的）丢弃。
    res = await s.execute(text("""
        DELETE FROM user_profiles
        WHERE user_id = :src
          AND EXISTS (SELECT 1 FROM user_profiles WHERE user_id = :dst)
    """), {"src": src_id, "dst": dst_id})
    if res.rowcount:
        moved["user_profiles(以老账号为准，弃用新号的)"] = res.rowcount
    res = await s.execute(
        text("UPDATE user_profiles SET user_id = :dst WHERE user_id = :src"),
        {"src": src_id, "dst": dst_id})
    if res.rowcount:
        moved["user_profiles"] = res.rowcount

    # --- 其余表：没有任何涉及 user_id 的唯一约束，直接改归属
    for t in tables:
        if t in _SPECIAL_UNIQUE or t in _SKIP_TABLES:
            continue
        # 表名来自 information_schema，不是用户输入；加引号防大小写/保留字问题
        res = await s.execute(
            text(f'UPDATE "{t}" SET user_id = :dst WHERE user_id = :src'),
            {"src": src_id, "dst": dst_id})
        if res.rowcount:
            moved[t] = res.rowcount

    return moved


# ---------------------------------------------------------------- 账号级合并

def is_feishu_auto_account(u: User) -> bool:
    """是不是"扫码自动建出来的号"。

    判据用 login_id 前缀而不是"有没有密码"：正经老账号绑定飞书后密码也会被清空
    （见 routes.feishu_link 的注释），只看密码会把老账号误判成自动号。
    `fs_` 前缀只有回调建号那一条路径会写，是可靠的出身标记。
    """
    return bool(u.login_id and u.login_id.startswith("fs_"))


async def merge_accounts(
    s, *, src: User, dst: User, actor_user_id: int | None,
    reason: str, ip: str = "", ua: str = "",
) -> dict:
    """把 src（扫码误建的空白号）整体并入 dst（本人原来的账号）。

    调用方负责鉴权 —— 必须已经证明操作者同时拥有这两个身份
    （典型组合：持有飞书扫码结果 + 知道老账号密码）。本函数只管数据正确。

    返回 {"moved": {...}, "union_id_transferred": bool}。不 commit。
    """
    if src.id == dst.id:
        raise ValueError("源账号与目标账号相同")

    union_id = src.feishu_union_id
    open_id = src.feishu_open_id
    fs_name = src.feishu_name

    # ① 先把飞书身份从 src 上摘下来并落盘。
    #    feishu_union_id 是 UNIQUE：不先释放就给 dst 赋值，会直接撞唯一键。
    src.feishu_union_id = None
    src.feishu_open_id = None
    src.status = "merged"        # 软删除：行留着可审计、可回滚，但登不进来
    await s.flush()

    # ② 搬数据
    moved = await merge_user_data(s, src_id=src.id, dst_id=dst.id)

    # ③ 飞书身份落到 dst 上
    if union_id:
        dst.feishu_union_id = union_id
        dst.feishu_open_id = open_id
        dst.feishu_name = fs_name
        dst.feishu_bound_at = datetime.utcnow()
        # 绑定即清密码（与 /feishu/link 同一条规矩）：留着密码等于给飞书准入
        # 开一条后门 —— 员工离职被移出通讯录后扫码会被拒，密码却仍能进。
        dst.password_hash = None

    # ④ 权限与配额取并集，避免合并反而把人的权限合没了
    flags = dict(dst.feature_flags or {})
    for k, v in (src.feature_flags or {}).items():
        flags[k] = bool(flags.get(k)) or bool(v)
    if flags != (dst.feature_flags or {}):
        dst.feature_flags = flags
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(dst, "feature_flags")
    if (src.quota_daily or 0) > (dst.quota_daily or 0):
        dst.quota_daily = src.quota_daily

    # ⑤ 两边各记一条，便于从任一账号查到对面
    meta = {
        "src_user_id": src.id, "src_login_id": src.login_id,
        "src_username": src.username,
        "dst_user_id": dst.id, "dst_login_id": dst.login_id,
        "dst_username": dst.username,
        "feishu_name": fs_name, "reason": reason,
        "moved": moved,
    }
    s.add(UserAuditLog(
        user_id=actor_user_id, action="account_merged",
        resource_type="user", resource_id=dst.id,
        ip=ip, user_agent=(ua or "")[:500], log_metadata=meta))
    s.add(UserAuditLog(
        user_id=None, action="account_merged_away",
        resource_type="user", resource_id=src.id,
        ip=ip, user_agent=(ua or "")[:500], log_metadata=meta))

    await s.flush()
    logger.info("account merged: %s(%s) -> %s(%s) reason=%s moved=%s",
                src.id, src.login_id, dst.id, dst.login_id, reason, moved)
    return {"moved": moved, "union_id_transferred": bool(union_id)}
