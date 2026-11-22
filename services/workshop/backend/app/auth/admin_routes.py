"""管理员专用API"""
import logging
import os
import io
import zipfile
import json
import psutil
from datetime import datetime, timedelta
from typing import Any
from fastapi import APIRouter, HTTPException, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, func, delete, text, update, desc

from ..db import session_scope, ScriptDraft, ScriptChapter, ScriptStoryboard, GenerationLog
from .models import User, UserAuditLog
from .password import hash_password
from .dependencies import require_admin

router = APIRouter(prefix="/v1/admin-api", tags=["admin-api"])
logger = logging.getLogger("admin")


# ============ 内部工具: 给草稿批量打标签 ============

async def _ensure_tag(s, *, owner_user_id: int, name: str, color: str) -> int:
    """确保 (owner_user_id, name) 这个标签存在,返回其 id。
    依赖 tags 表上的 UNIQUE(user_id, name)。颜色仅在新建时写入,后续不覆盖。
    """
    # 先尝试拿现有
    row = (await s.execute(
        text("SELECT id FROM tags WHERE user_id=:uid AND name=:name"),
        {"uid": owner_user_id, "name": name},
    )).first()
    if row:
        return int(row[0])
    # 不存在则插入(并发场景靠 ON CONFLICT 兜底)
    res = await s.execute(
        text("""INSERT INTO tags (user_id, name, color) VALUES (:uid, :name, :color)
                ON CONFLICT (user_id, name) DO UPDATE SET name=EXCLUDED.name
                RETURNING id"""),
        {"uid": owner_user_id, "name": name, "color": color},
    )
    return int(res.scalar_one())


async def _attach_tag_to_drafts(s, *, tag_id: int, draft_ids: list[int]) -> int:
    """把同一个 tag 批量挂到一组 draft 上,跳过已存在的关联,返回新增条数。"""
    if not draft_ids:
        return 0
    res = await s.execute(
        text("""INSERT INTO draft_tags (draft_id, tag_id)
                SELECT did, :tid FROM unnest(CAST(:dids AS integer[])) AS did
                ON CONFLICT DO NOTHING"""),
        {"tid": tag_id, "dids": draft_ids},
    )
    return res.rowcount or 0


async def _attach_tag_by_name(
    s,
    *,
    owner_user_id: int,
    tag_name: str,
    tag_color: str,
    draft_ids: list[int],
) -> tuple[int, int]:
    """组合工具:确保 owner 名下 tag 存在,然后批量挂到 draft_ids 上。
    返回 (tag_id, 新增关联数)。空 draft_ids 时仍会保证标签存在,只是关联数 0。
    """
    tid = await _ensure_tag(s, owner_user_id=owner_user_id, name=tag_name, color=tag_color)
    n = await _attach_tag_to_drafts(s, tag_id=tid, draft_ids=draft_ids)
    return tid, n


# ============ 用户管理 ============

class CreateUserIn(BaseModel):
    username: str = Field(..., min_length=2, max_length=64)
    password: str = Field(..., min_length=6)
    display_name: str | None = None
    role: str = Field("user", pattern="^(user|admin|superadmin)$")
    status: str = Field("active", pattern="^(active|disabled|banned)$")


class UpdateUserIn(BaseModel):
    username: str | None = None     # admin 可改 username (受 7 天冷却,superadmin 可强改)
    display_name: str | None = None
    role: str | None = None
    status: str | None = None
    new_password: str | None = None
    force_username_change: bool = False   # superadmin 强改时绕过 7 天冷却
    feature_flags: dict | None = None     # 功能白名单开关(整体覆盖), 如 {"novel_video": true}


@router.get("/users")
async def list_users(
    search: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    admin: User = Depends(require_admin),
):
    """列出所有用户(含草稿数)。search 同时匹配 login_id / username / display_name。"""
    from sqlalchemy import or_
    async with session_scope() as s:
        stmt = select(User)
        if search:
            kw = f"%{search}%"
            stmt = stmt.where(or_(
                User.login_id.ilike(kw),
                User.username.ilike(kw),
                User.display_name.ilike(kw),
            ))
        stmt = stmt.order_by(User.created_at.desc()).offset(offset).limit(limit)
        rows = (await s.execute(stmt)).scalars().all()
        
        total = (await s.execute(select(func.count()).select_from(User))).scalar_one()
        
        items = []
        for u in rows:
            draft_count = (await s.execute(
                select(func.count()).select_from(ScriptDraft).where(ScriptDraft.user_id == u.id)
            )).scalar_one()
            items.append({
                "id": u.id,
                "username": u.username,
                "login_id": u.login_id,                                         # 永久不可改的登录 ID
                "username_changed_at": u.username_changed_at.isoformat() if u.username_changed_at else None,
                "display_name": u.display_name,
                "role": u.role,
                "status": u.status,
                "feature_flags": u.feature_flags or {},
                "quota_daily": u.quota_daily,
                "quota_used_today": u.quota_used_today,
                "draft_count": draft_count,
                "created_at": u.created_at.isoformat() if u.created_at else None,
                "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
                "last_login_ip": u.last_login_ip,
                # 飞书绑定状态。过去后台完全看不到这些字段,导致"扫码误建空白号"
                # 这类问题管理员既发现不了、也处理不了(见下面的 feishu/suspects)。
                "feishu_bound": bool(u.feishu_union_id),
                "feishu_name": u.feishu_name,
                "feishu_bound_at": u.feishu_bound_at.isoformat() if u.feishu_bound_at else None,
                "feishu_auto": bool(u.login_id and u.login_id.startswith("fs_")),
                "has_password": bool(u.password_hash),
            })
        return {"items": items, "total": total}


@router.post("/users")
async def create_user(payload: CreateUserIn, admin: User = Depends(require_admin)):
    """管理员创建用户"""
    async with session_scope() as s:
        # 唯一性: username 和 login_id 都不能撞
        existing = (await s.execute(
            select(User).where(
                (User.username == payload.username) | (User.login_id == payload.username)
            )
        )).scalar_one_or_none()
        if existing:
            raise HTTPException(409, "用户名已存在")
        user = User(
            login_id=payload.username,         # 永久不可改
            username=payload.username,
            password_hash=hash_password(payload.password),
            display_name=payload.display_name or payload.username,
            role=payload.role,
            status=payload.status,
            quota_daily=100,
        )
        s.add(user)
        await s.flush()
        await s.refresh(user)
        
        log = UserAuditLog(
            user_id=admin.id, action="admin_create_user",
            resource_type="user", resource_id=user.id,
            log_metadata={"username": user.username, "role": user.role},
        )
        s.add(log)
        
        return {
            "ok": True,
            "user": {
                "id": user.id,
                "username": user.username,
                "role": user.role,
            }
        }


@router.patch("/users/{user_id}")
async def update_user(user_id: int, payload: UpdateUserIn, admin: User = Depends(require_admin)):
    """修改用户"""
    async with session_scope() as s:
        user = await s.get(User, user_id)
        if not user:
            raise HTTPException(404, "用户不存在")
        
        # 禁止把自己降级
        if user_id == admin.id and payload.role and payload.role not in ("admin", "superadmin"):
            raise HTTPException(400, "不能把自己降级为非管理员")

        changes = {}
        # ---- username 修改 (7 天冷却 + 唯一性, superadmin 可强改)
        if payload.username is not None and payload.username != user.username:
            new_un = payload.username.strip()
            if len(new_un) < 2 or len(new_un) > 64:
                raise HTTPException(400, "username 长度需 2-64 字符")

            # 7 天冷却 (force=True 且 admin 是 superadmin 才可绕过)
            if user.username_changed_at:
                from datetime import timedelta
                cooldown_end = user.username_changed_at + timedelta(days=7)
                if datetime.utcnow() < cooldown_end:
                    bypass = payload.force_username_change and admin.role == "superadmin"
                    if not bypass:
                        remaining = (cooldown_end - datetime.utcnow()).days + 1
                        raise HTTPException(
                            400,
                            f"该用户的 username 在 {remaining} 天内不可修改 "
                            f"(上次修改于 {user.username_changed_at.strftime('%Y-%m-%d %H:%M')})",
                        )

            # 唯一性: 不能撞 username, 也不能撞别人的 login_id
            dup = (await s.execute(
                select(User).where(
                    User.id != user_id,
                    (User.username == new_un) | (User.login_id == new_un),
                )
            )).scalar_one_or_none()
            if dup:
                raise HTTPException(409, f"用户名 '{new_un}' 已被占用")

            old_un = user.username
            user.username = new_un
            user.username_changed_at = datetime.utcnow()
            changes["username"] = {"from": old_un, "to": new_un}

        if payload.display_name is not None:
            user.display_name = payload.display_name
            changes["display_name"] = payload.display_name
        if payload.role:
            user.role = payload.role
            changes["role"] = payload.role
        if payload.status:
            user.status = payload.status
            changes["status"] = payload.status
        if payload.new_password:
            user.password_hash = hash_password(payload.new_password)
            changes["password"] = "changed"
        if payload.feature_flags is not None:
            # 整体覆盖白名单; 只保留 bool 值, 防脏数据
            flags = {k: bool(v) for k, v in (payload.feature_flags or {}).items()}
            user.feature_flags = flags
            from sqlalchemy.orm.attributes import flag_modified
            flag_modified(user, "feature_flags")
            changes["feature_flags"] = flags

        log = UserAuditLog(
            user_id=admin.id, action="admin_update_user",
            resource_type="user", resource_id=user.id,
            log_metadata={"target_user": user.username, "changes": changes},
        )
        s.add(log)
        
        await s.flush()
        return {"ok": True}


@router.delete("/users/{user_id}")
async def delete_user(user_id: int, admin: User = Depends(require_admin)):
    """删除用户(草稿转给 admin,并在转过来的草稿上自动打 📥 来自-XXX 标签)"""
    if user_id == admin.id:
        raise HTTPException(400, "不能删除自己")

    async with session_scope() as s:
        user = await s.get(User, user_id)
        if not user:
            raise HTTPException(404, "用户不存在")

        # 1) 先记下被删用户的草稿 id 列表(转移前还能按原 user_id 查到)
        draft_rows = (await s.execute(
            select(ScriptDraft.id).where(ScriptDraft.user_id == user_id)
        )).all()
        transferred_draft_ids = [int(r[0]) for r in draft_rows]

        # 2) 草稿 owner 转给 admin
        admin_id = admin.id
        result = await s.execute(
            update(ScriptDraft).where(ScriptDraft.user_id == user_id).values(user_id=admin_id)
        )
        transferred = result.rowcount or len(transferred_draft_ids)

        # 3) 给转过来的草稿在 admin 名下打"📥 来自-{显示名}-{原uid}"标签
        username = user.username
        display = (user.display_name or username or user.login_id or f"user{user_id}").strip()
        # 标签名加 user_id 后缀避免历史同名用户合并;tags.name varchar(64) 最长 64 字符
        raw_label = f"📥 来自-{display}-{user_id}"
        tag_name = raw_label[:64]
        tagged_count = 0
        try:
            _, tagged_count = await _attach_tag_by_name(
                s,
                owner_user_id=admin_id,
                tag_name=tag_name,
                tag_color="#3b82f6",   # 蓝色: 用户转移
                draft_ids=transferred_draft_ids,
            )
        except Exception as e:
            # 打标失败不阻塞删除,仅记日志
            logger.exception("delete_user: tag attach failed: user_id=%s err=%s", user_id, e)

        # 4) 审计日志保留(把指向被删用户的日志 user_id 置 NULL)
        await s.execute(update(UserAuditLog).where(UserAuditLog.user_id == user_id).values(user_id=None))

        await s.delete(user)

        log = UserAuditLog(
            user_id=admin.id, action="admin_delete_user",
            resource_type="user", resource_id=user_id,
            log_metadata={
                "deleted_username": username,
                "deleted_display_name": display,
                "drafts_transferred": transferred,
                "tag_name": tag_name,
                "tagged_count": tagged_count,
            },
        )
        s.add(log)

        return {
            "ok": True,
            "drafts_transferred": transferred,
            "tag_name": tag_name,
            "tagged_count": tagged_count,
        }


# ============ 飞书绑定：管理员兜底 ============
#
# 这一节是补上一个长期存在的空洞:后台**完全没有**飞书相关功能。
# 后果是死结 —— 用户自助解绑被 403 挡住("请联系管理员"),而管理员这边
# 一个能用的按钮都没有,只能人工连数据库改 users 表。
# dev 库里就有一个人工改坏的样本:union_id 被 UPDATE 清掉了,但绑定时清空的
# 密码没人补回去,于是 has_pwd=false / fs_bound=false,**永久登不进来**。
# 所以下面的解绑接口把"重设密码"做成了必填参数,两件事必须原子完成。

class AdminFeishuUnlinkIn(BaseModel):
    new_password: str = Field(..., min_length=6, max_length=128)
    note: str | None = None


class AdminMergeUsersIn(BaseModel):
    src_user_id: int = Field(..., gt=0)   # 被合并掉的号(通常是扫码误建的空白号)
    dst_user_id: int = Field(..., gt=0)   # 保留下来的号(通常是用户原来的账号)
    confirm: bool = False
    note: str | None = None


@router.get("/users/feishu/suspects")
async def feishu_suspects(admin: User = Depends(require_admin)):
    """列出"疑似同一个人被拆成两个账号"的配对,供管理员主动通知本人来合并。

    识别依据是建号时留下的痕迹:自动建号用飞书姓名做 username,撞名了就加数字
    后缀(见 auth/routes._unique_username)。所以「余锦豪1」旁边多半就站着
    一个有密码、没绑飞书的「余锦豪」。

    ⚠️ 这是**启发式**,不是判定:
      - 会漏 —— 老账号用英文 ID 登录(如 zjh0909 / 昵称"曽佳好")就匹配不上,
        名字里有异体字(曽/曾)也一样。所以自助合并入口不能撤,只靠这张表救不全。
      - 会多 —— 两个真同名的同事会被列出来。
    因此这里只给线索和数据量,**不提供一键批量合并**;真正的合并要么由本人
    自助完成(两边的凭据都在他手上),要么由管理员逐对确认后调 /users/merge。
    """
    async with session_scope() as s:
        rows = (await s.execute(text("""
            SELECT f.id, f.username, f.login_id, f.feishu_name,
                   f.created_at, f.last_login_at,
                   o.id, o.username, o.login_id, o.display_name,
                   o.created_at, o.last_login_at,
                   (o.username = f.feishu_name OR o.display_name = f.feishu_name)
                     AS exact_name
            FROM users f
            JOIN users o
              ON o.id <> f.id
             AND o.feishu_union_id IS NULL
             AND o.password_hash IS NOT NULL
             AND o.status = 'active'
             AND (
                   o.username = f.feishu_name
                OR o.display_name = f.feishu_name
                OR o.username = regexp_replace(f.username, '[0-9]+$', '')
                OR o.display_name = regexp_replace(f.username, '[0-9]+$', '')
             )
            WHERE left(f.login_id, 3) = 'fs_'
              AND f.status = 'active'
              AND f.feishu_union_id IS NOT NULL
            ORDER BY f.created_at DESC, o.id
        """))).all()

        # 草稿数一次查完,避免 N+1
        ids = sorted({int(r[0]) for r in rows} | {int(r[6]) for r in rows})
        counts: dict[int, int] = {}
        if ids:
            crows = (await s.execute(
                select(ScriptDraft.user_id, func.count())
                .where(ScriptDraft.user_id.in_(ids))
                .group_by(ScriptDraft.user_id)
            )).all()
            counts = {int(a): int(b) for a, b in crows}

        items = []
        for r in rows:
            items.append({
                "feishu_account": {
                    "id": int(r[0]), "username": r[1], "login_id": r[2],
                    "feishu_name": r[3],
                    "created_at": r[4].isoformat() if r[4] else None,
                    "last_login_at": r[5].isoformat() if r[5] else None,
                    "draft_count": counts.get(int(r[0]), 0),
                },
                "legacy_account": {
                    "id": int(r[6]), "username": r[7], "login_id": r[8],
                    "display_name": r[9],
                    "created_at": r[10].isoformat() if r[10] else None,
                    "last_login_at": r[11].isoformat() if r[11] else None,
                    "draft_count": counts.get(int(r[6]), 0),
                },
                # exact = 飞书姓名与老账号名完全一致; suffix = 只能靠去掉数字后缀对上
                "confidence": "exact" if r[12] else "suffix",
            })
        return {"items": items, "total": len(items)}


@router.post("/users/{user_id}/feishu/unlink")
async def admin_feishu_unlink(user_id: int, payload: AdminFeishuUnlinkIn,
                              admin: User = Depends(require_admin)):
    """管理员解绑飞书 —— **同时**重设密码,两步原子。

    绑定飞书时密码会被清空(那是有意的:留着密码等于给飞书准入开后门)。
    因此单独解绑 = 把人锁在门外:飞书没了,密码也没有。这里强制要求
    new_password,就是为了让这种半成品状态在接口层面不可能被造出来。
    """
    async with session_scope() as s:
        u = await s.get(User, user_id)
        if not u:
            raise HTTPException(404, "用户不存在")
        if not u.feishu_union_id:
            raise HTTPException(400, f"账号「{u.username}」当前未绑定飞书")

        old_name = u.feishu_name
        u.feishu_union_id = None
        u.feishu_open_id = None
        u.feishu_bound_at = None
        # feishu_name 留着:它是"这个号曾经绑的是谁"的唯一线索,排查时有用
        u.password_hash = hash_password(payload.new_password)

        s.add(UserAuditLog(
            user_id=admin.id, action="admin_feishu_unlink",
            resource_type="user", resource_id=u.id,
            log_metadata={"target_username": u.username,
                          "feishu_name": old_name,
                          "password_reset": True,
                          "note": payload.note},
        ))
        await s.flush()
        return {"ok": True,
                "message": f"已解绑「{u.username}」的飞书并重设密码,"
                           f"该账号现在可以用账号密码登录"}


@router.post("/users/merge")
async def admin_merge_users(payload: AdminMergeUsersIn,
                            admin: User = Depends(require_admin)):
    """管理员把 src 账号整体并入 dst 账号(数据全搬,飞书绑定跟着走)。

    用于用户自己走不通自助流程时兜底(比如他已经忘了老账号密码)。
    src 不物理删除,只置 status='merged' —— 留行是为了审计和万一要回滚。
    """
    if not payload.confirm:
        raise HTTPException(400, "合并不可撤销,请带 confirm=true 再调用")
    if payload.src_user_id == payload.dst_user_id:
        raise HTTPException(400, "源账号与目标账号相同")
    if payload.src_user_id == admin.id:
        raise HTTPException(400, "不能把自己当作被合并掉的一方")

    from . import account_merge as am

    async with session_scope() as s:
        src = await s.get(User, payload.src_user_id)
        dst = await s.get(User, payload.dst_user_id)
        if not src or not dst:
            raise HTTPException(404, "账号不存在")
        if dst.status != "active":
            raise HTTPException(400, f"目标账号状态为 {dst.status},不能作为合并目标")
        if src.feishu_union_id and dst.feishu_union_id:
            raise HTTPException(400,
                f"两个账号各自绑着不同的飞书身份,不能直接合并。"
                f"请先解绑「{src.username}」或「{dst.username}」再操作")

        out = await am.merge_accounts(
            s, src=src, dst=dst, actor_user_id=admin.id,
            reason=f"admin_merge:{payload.note or ''}")
        return {
            "ok": True,
            "moved": out["moved"],
            "feishu_transferred": out["union_id_transferred"],
            "message": (f"已把「{src.username}」并入「{dst.username}」;"
                        f"原账号已标记为 merged,数据全部转移"),
        }


# ============ 管理员主动分配草稿 ============

class AssignDraftsIn(BaseModel):
    draft_ids: list[int] = Field(..., min_length=1, max_length=500)
    target_user_id: int = Field(..., gt=0)
    note: str | None = None     # 可选:备注,会写进审计日志


@router.post("/drafts/assign")
async def assign_drafts(payload: AssignDraftsIn, admin: User = Depends(require_admin)):
    """管理员把若干草稿划拨给指定用户,并在草稿上自动打"🎁 管理员分配"标签。

    行为:
    - script_drafts.user_id 改为 target_user_id
    - 在 target 名下确保标签"🎁 管理员分配"存在,挂到这些草稿上
    - 写审计日志 admin_assign_draft
    - 不复制内容、不动数据库其他表
    """
    target_user_id = payload.target_user_id

    async with session_scope() as s:
        target = await s.get(User, target_user_id)
        if not target:
            raise HTTPException(404, "目标用户不存在")
        if target.status == "banned":
            raise HTTPException(400, "目标用户已被封禁,不可分配")

        # 1) 找出实际存在的草稿,记录每条原 owner
        rows = (await s.execute(
            select(ScriptDraft.id, ScriptDraft.user_id).where(ScriptDraft.id.in_(payload.draft_ids))
        )).all()
        if not rows:
            raise HTTPException(404, "没有可分配的草稿")
        existing_ids = [int(r[0]) for r in rows]
        original_owners = {int(r[0]): (int(r[1]) if r[1] is not None else None) for r in rows}
        missing = sorted(set(payload.draft_ids) - set(existing_ids))

        # 2) 转 owner
        upd = await s.execute(
            update(ScriptDraft)
            .where(ScriptDraft.id.in_(existing_ids))
            .values(user_id=target_user_id)
        )
        moved = upd.rowcount or len(existing_ids)

        # 3) 在 target 名下打"🎁 管理员分配"标签
        tag_name = "🎁 管理员分配"
        tagged_count = 0
        try:
            _, tagged_count = await _attach_tag_by_name(
                s,
                owner_user_id=target_user_id,
                tag_name=tag_name,
                tag_color="#f59e0b",     # 橙色: 管理员分配
                draft_ids=existing_ids,
            )
        except Exception as e:
            logger.exception("assign_drafts: tag attach failed: target=%s err=%s", target_user_id, e)

        # 4) 审计日志
        log = UserAuditLog(
            user_id=admin.id, action="admin_assign_draft",
            resource_type="user", resource_id=target_user_id,
            log_metadata={
                "target_user_id": target_user_id,
                "target_username": target.username,
                "draft_ids": existing_ids,
                "missing_ids": missing,
                "moved": moved,
                "tag_name": tag_name,
                "tagged_count": tagged_count,
                "original_owners": original_owners,
                "note": payload.note,
            },
        )
        s.add(log)

        return {
            "ok": True,
            "moved": moved,
            "missing_ids": missing,
            "tag_name": tag_name,
            "tagged_count": tagged_count,
        }


@router.get("/drafts/search")
async def admin_search_drafts(
    q: str | None = Query(None, description="按标题模糊搜"),
    user_id: int | None = Query(None, description="按当前 owner 过滤"),
    limit: int = Query(30, ge=1, le=200),
    admin: User = Depends(require_admin),
):
    """admin 端找草稿(用于"分配草稿"对话框)。
    返回当前 owner、标题、id;不返回正文。
    """
    async with session_scope() as s:
        stmt = select(ScriptDraft).order_by(desc(ScriptDraft.id)).limit(limit)
        if q:
            stmt = stmt.where(ScriptDraft.title.ilike(f"%{q}%"))
        if user_id:
            stmt = stmt.where(ScriptDraft.user_id == user_id)
        rows = (await s.execute(stmt)).scalars().all()

        owner_ids = list({r.user_id for r in rows if r.user_id})
        owners_map: dict[int, str] = {}
        if owner_ids:
            us = (await s.execute(select(User).where(User.id.in_(owner_ids)))).scalars().all()
            for u in us:
                owners_map[u.id] = u.display_name or u.username or u.login_id

        return [
            {
                "id": r.id,
                "title": r.title or "(未命名)",
                "user_id": r.user_id,
                "owner_name": owners_map.get(r.user_id, "(unknown)") if r.user_id else None,
                "status": r.status,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]


# ============ 公告 ============

class AnnouncementIn(BaseModel):
    title: str
    content: str
    type: str = Field("info", pattern="^(info|warning|error)$")
    active: bool = True
    start_at: datetime | None = None
    end_at: datetime | None = None


@router.get("/announcements")
async def list_announcements(admin: User = Depends(require_admin)):
    async with session_scope() as s:
        rows = (await s.execute(
            text("SELECT * FROM announcements ORDER BY id DESC")
        )).mappings().all()
        return [dict(r) for r in rows]


@router.post("/announcements")
async def create_announcement(payload: AnnouncementIn, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        result = await s.execute(
            text("""INSERT INTO announcements (title, content, type, active, start_at, end_at, created_by)
                    VALUES (:title, :content, :type, :active, :start_at, :end_at, :uid)
                    RETURNING id"""),
            {
                "title": payload.title, "content": payload.content,
                "type": payload.type, "active": payload.active,
                "start_at": payload.start_at, "end_at": payload.end_at,
                "uid": admin.id,
            }
        )
        new_id = result.scalar_one()
        return {"ok": True, "id": new_id}


@router.patch("/announcements/{ann_id}")
async def update_announcement(ann_id: int, payload: AnnouncementIn, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        await s.execute(
            text("""UPDATE announcements SET title=:title, content=:content, type=:type,
                    active=:active, start_at=:start_at, end_at=:end_at, updated_at=NOW()
                    WHERE id=:id"""),
            {
                "id": ann_id, "title": payload.title, "content": payload.content,
                "type": payload.type, "active": payload.active,
                "start_at": payload.start_at, "end_at": payload.end_at,
            }
        )
        return {"ok": True}


@router.delete("/announcements/{ann_id}")
async def delete_announcement(ann_id: int, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        await s.execute(text("DELETE FROM announcements WHERE id=:id"), {"id": ann_id})
        return {"ok": True}


# ---------------------------------------------------------------------------
# 公告群发（飞书私信）
#
# 上面那几个端点只维护**网页顶部横幅**：它只覆盖"正好打开着网页的人"。用户在织影
# 里剪片、在生成长任务里等结果、或者这几天没开网页，就一个字都看不到。
# 下面这组把公告主动推到人的飞书里。
#
# ⚠️ 群发不可撤回，所以规矩是：**先预览名单，再发送，逐人留痕**。
#    前端必须把「将发给 N 人 / M 人收不到」摆在确认按钮之前。
# ---------------------------------------------------------------------------

class AnnouncePushIn(BaseModel):
    text: str
    title: str = ""
    #: None 或空 = 全平台（所有 active 且有飞书身份的账号）
    user_ids: list[int] | None = None
    #: 只算名单不发。界面上「预览」走这个。
    dry_run: bool = False
    #: 无视 10 分钟幂等护栏强制重发（幂等拦截后，管理员确认要重发时必须显式勾）
    force: bool = False
    #: 同时把这条落成一条网页横幅（可选）
    also_banner: bool = False
    banner_type: str = Field("info", pattern="^(info|warning|error)$")


@router.get("/announcements/recipients")
async def announcement_recipients(q: str = "", limit: int = 500,
                                  admin: User = Depends(require_admin)):
    """可选的收件人清单（界面上的勾选列表）。只回**有飞书身份的正常账号**。

    `limit` 只截返回列表，`total` 始终是全量 —— 免得界面把"没显示全"当成"平台就这些人"。
    """
    from ..announce import service as announce
    return await announce.list_candidates(q=q, limit=limit)


@router.post("/announcements/send")
async def send_announcement_push(payload: AnnouncePushIn,
                                 admin: User = Depends(require_admin)):
    """把公告推送到飞书。`dry_run=true` 只返回名单，一条都不发。

    返回里 `skipped` 是**发不到的人**（没绑飞书 / 账号停用），不是发送失败 ——
    这两类必须分开，否则管理员会以为飞书在抽风、反复重发一个本来就发不到的人。
    """
    from ..announce import service as announce

    announcement_id = None
    if payload.also_banner and not payload.dry_run:
        # 横幅与推送互不依赖：横幅的可见性仍由 active / start_at / end_at 控制。
        async with session_scope() as s:
            row = (await s.execute(text(
                """INSERT INTO announcements (title, content, type, active, start_at, end_at, created_by)
                   VALUES (:title, :content, :type, true, NULL, NULL, :uid)
                   RETURNING id"""
            ), {"title": (payload.title or payload.text[:40])[:128],
                "content": payload.text, "type": payload.banner_type,
                "uid": admin.id})).first()
            announcement_id = int(row[0])

    try:
        res = await announce.send_announcement(
            text_=payload.text,
            title=payload.title,
            user_ids=payload.user_ids,
            announcement_id=announcement_id,
            created_by=admin.id,
            dry_run=payload.dry_run,
            force=payload.force,
        )
    except announce.AnnounceError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        # 飞书凭据没配 / 取 token 失败 —— 归到"服务端还没准备好"，不是管理员的错
        raise HTTPException(503, f"飞书通道不可用：{e}")

    if announcement_id:
        res["announcement_id"] = announcement_id
    return res


@router.get("/announcements/pushes")
async def announcement_pushes(limit: int = 50, admin: User = Depends(require_admin)):
    """群发历史。"""
    from ..announce import service as announce
    return await announce.list_pushes(limit=limit)


@router.get("/announcements/pushes/{push_id}/deliveries")
async def announcement_deliveries(push_id: int, limit: int = 500,
                                  admin: User = Depends(require_admin)):
    """某一次群发的逐人投递结果 —— 「他到底收到没有」查这里。"""
    from ..announce import service as announce
    return await announce.list_deliveries(push_id, limit=limit)


# 公开的活跃公告(无需admin)
public_router = APIRouter(prefix="/v1/public", tags=["public"])

@public_router.get("/announcements")
async def public_active_announcements():
    """用户端获取当前生效的公告"""
    async with session_scope() as s:
        now = datetime.utcnow()
        rows = (await s.execute(
            text("""SELECT id, title, content, type FROM announcements
                    WHERE active=true
                    AND (start_at IS NULL OR start_at <= :now)
                    AND (end_at IS NULL OR end_at >= :now)
                    ORDER BY id DESC LIMIT 5"""),
            {"now": now}
        )).mappings().all()
        return [dict(r) for r in rows]


# ============ 系统设置 ============

class SettingUpdateIn(BaseModel):
    value: str


@router.get("/settings")
async def list_settings(admin: User = Depends(require_admin)):
    async with session_scope() as s:
        rows = (await s.execute(text("SELECT * FROM system_settings ORDER BY key"))).mappings().all()
        return [dict(r) for r in rows]


@router.patch("/settings/{key}")
async def update_setting(key: str, payload: SettingUpdateIn, admin: User = Depends(require_admin)):
    async with session_scope() as s:
        await s.execute(
            text("""INSERT INTO system_settings (key, value, updated_by, updated_at)
                    VALUES (:key, :value, :uid, NOW())
                    ON CONFLICT (key) DO UPDATE SET value=:value, updated_by=:uid, updated_at=NOW()"""),
            {"key": key, "value": payload.value, "uid": admin.id}
        )
    # 平台默认模型在进程内有一份缓存(见 models/catalog.py 为什么不能每次读库)。
    # 从这个通用设置接口改 default_model:* 时必须同步刷新, 否则库是新值、
    # 进程里还是旧值, 管理员会看到"改了没用"直到下次重启。
    # ⚠ 局部 import: 顶层的 `from .models import ...` 指的是 auth/models.py,
    #   而这里要的是 app/models/catalog.py, 局部导入既避免歧义也避免 import 环。
    try:
        from ..models.catalog import DEFAULT_MODEL_SETTING_PREFIX, set_default_model_override
        if key.startswith(DEFAULT_MODEL_SETTING_PREFIX):
            set_default_model_override(key[len(DEFAULT_MODEL_SETTING_PREFIX):], payload.value)
    except Exception as e:  # noqa: BLE001
        logger.warning("刷新平台默认模型缓存失败(下次重启会生效): %s", e)
    return {"ok": True}


@public_router.get("/settings/public")
async def public_settings():
    """公开的设置(如allow_registration)"""
    async with session_scope() as s:
        rows = (await s.execute(
            text("SELECT key, value FROM system_settings WHERE key IN ('allow_registration', 'site_name')")
        )).mappings().all()
        return {r["key"]: r["value"] for r in rows}


# ============ 系统状态(内存/CPU/磁盘) ============

@router.get("/system/resources")
async def system_resources(admin: User = Depends(require_admin)):
    """实时系统资源"""
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    cpu = psutil.cpu_percent(interval=0.5)
    loadavg = os.getloadavg()
    
    return {
        "cpu": {
            "percent": cpu,
            "count": psutil.cpu_count(),
            "count_logical": psutil.cpu_count(logical=True),
            "loadavg_1min": loadavg[0],
            "loadavg_5min": loadavg[1],
            "loadavg_15min": loadavg[2],
        },
        "memory": {
            "total_gb": round(mem.total / 1024 / 1024 / 1024, 2),
            "used_gb": round(mem.used / 1024 / 1024 / 1024, 2),
            "available_gb": round(mem.available / 1024 / 1024 / 1024, 2),
            "percent": mem.percent,
        },
        "disk": {
            "total_gb": round(disk.total / 1024 / 1024 / 1024, 2),
            "used_gb": round(disk.used / 1024 / 1024 / 1024, 2),
            "free_gb": round(disk.free / 1024 / 1024 / 1024, 2),
            "percent": disk.percent,
        },
        "timestamp": datetime.utcnow().isoformat(),
    }


# ============ 审计日志 ============

@router.get("/audit-logs")
async def list_audit_logs(
    user_id: int | None = Query(None),
    action: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    admin: User = Depends(require_admin),
):
    async with session_scope() as s:
        stmt = select(UserAuditLog).order_by(UserAuditLog.id.desc())
        if user_id:
            stmt = stmt.where(UserAuditLog.user_id == user_id)
        if action:
            stmt = stmt.where(UserAuditLog.action == action)
        stmt = stmt.offset(offset).limit(limit)
        rows = (await s.execute(stmt)).scalars().all()
        
        # 查user信息
        user_ids = list({r.user_id for r in rows if r.user_id})
        users_map = {}
        if user_ids:
            user_rows = (await s.execute(select(User).where(User.id.in_(user_ids)))).scalars().all()
            users_map = {u.id: u.username for u in user_rows}
        
        items = []
        for r in rows:
            items.append({
                "id": r.id,
                "user_id": r.user_id,
                "username": users_map.get(r.user_id, "(deleted)") if r.user_id else None,
                "action": r.action,
                "resource_type": r.resource_type,
                "resource_id": r.resource_id,
                "ip": r.ip,
                "metadata": r.log_metadata or {},
                "created_at": r.created_at.isoformat() if r.created_at else None,
            })
        
        total = (await s.execute(select(func.count()).select_from(UserAuditLog))).scalar_one()
        return {"items": items, "total": total}


# ============ 任务管理 ============

@router.get("/tasks/running")
async def list_running_tasks(admin: User = Depends(require_admin)):
    """所有运行中的草稿任务"""
    async with session_scope() as s:
        rows = (await s.execute(
            select(ScriptDraft).where(
                ScriptDraft.status.in_([
                    "outline_running", "chapter_running", "storyboard_running",
                    "generating_outline", "generating_chapters", "generating_storyboards"
                ])
            )
        )).scalars().all()
        
        user_ids = list({r.user_id for r in rows if r.user_id})
        users_map = {}
        if user_ids:
            urows = (await s.execute(select(User).where(User.id.in_(user_ids)))).scalars().all()
            users_map = {u.id: u.username for u in urows}
        
        return [
            {
                "id": r.id,
                "title": r.title,
                "status": r.status,
                "user_id": r.user_id,
                "username": users_map.get(r.user_id, "(unknown)"),
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
            for r in rows
        ]


# ============ Dashboard统计 ============

@router.get("/dashboard")
async def dashboard_stats(admin: User = Depends(require_admin)):
    """管理员首页统计"""
    async with session_scope() as s:
        now = datetime.utcnow()
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        week_ago = now - timedelta(days=7)
        
        # 用户统计
        total_users = (await s.execute(select(func.count()).select_from(User))).scalar_one()
        active_users = (await s.execute(
            select(func.count()).select_from(User).where(User.last_login_at >= week_ago)
        )).scalar_one()
        new_users_today = (await s.execute(
            select(func.count()).select_from(User).where(User.created_at >= today_start)
        )).scalar_one()
        
        # 内容统计
        total_drafts = (await s.execute(select(func.count()).select_from(ScriptDraft))).scalar_one()
        total_chapters = (await s.execute(select(func.count()).select_from(ScriptChapter))).scalar_one()
        total_storyboards = (await s.execute(select(func.count()).select_from(ScriptStoryboard))).scalar_one()
        
        # 最近24h生成任务
        recent_gens = (await s.execute(
            select(func.count()).select_from(GenerationLog).where(
                GenerationLog.created_at >= now - timedelta(hours=24)
            )
        )).scalar_one()
        
        # TOP活跃用户(按draft count)
        top_users = (await s.execute(
            text("""SELECT u.id, u.username, u.display_name, COUNT(d.id) as draft_count
                    FROM users u LEFT JOIN script_drafts d ON d.user_id=u.id
                    GROUP BY u.id, u.username, u.display_name
                    ORDER BY draft_count DESC LIMIT 5""")
        )).mappings().all()
        
        # API使用统计(今日)
        api_stats = (await s.execute(
            text("""SELECT COUNT(*) as calls, COALESCE(SUM(total_tokens), 0) as tokens,
                    COALESCE(SUM(estimated_cost), 0) as cost
                    FROM api_usage_logs WHERE created_at >= :today""")
            , {"today": today_start}
        )).mappings().first()
        
        return {
            "users": {
                "total": total_users,
                "active_7d": active_users,
                "new_today": new_users_today,
            },
            "content": {
                "drafts": total_drafts,
                "chapters": total_chapters,
                "storyboards": total_storyboards,
            },
            "activity": {
                "recent_generations_24h": recent_gens,
            },
            "top_users": [dict(r) for r in top_users],
            "api_usage_today": dict(api_stats) if api_stats else {"calls": 0, "tokens": 0, "cost": 0},
            "generated_at": now.isoformat(),
        }


# ============ 数据导出 ============

@router.get("/export/user/{user_id}")
async def export_user_data(user_id: int, admin: User = Depends(require_admin)):
    """导出单用户的所有数据为zip"""
    async with session_scope() as s:
        user = await s.get(User, user_id)
        if not user:
            raise HTTPException(404, "用户不存在")
        
        drafts = (await s.execute(
            select(ScriptDraft).where(ScriptDraft.user_id == user_id)
        )).scalars().all()
        
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("user.json", json.dumps({
                "id": user.id, "username": user.username,
                "display_name": user.display_name, "role": user.role,
                "created_at": user.created_at.isoformat() if user.created_at else None,
            }, ensure_ascii=False, indent=2))
            
            for d in drafts:
                chs = (await s.execute(
                    select(ScriptChapter).where(ScriptChapter.draft_id == d.id).order_by(ScriptChapter.chapter_order)
                )).scalars().all()
                sbs = (await s.execute(
                    select(ScriptStoryboard).where(ScriptStoryboard.draft_id == d.id).order_by(ScriptStoryboard.chapter_order)
                )).scalars().all()
                
                data = {
                    "draft": {
                        "id": d.id, "title": d.title,
                        "user_input": d.user_input, "outline": d.outline,
                        "status": d.status,
                        "created_at": d.created_at.isoformat() if d.created_at else None,
                    },
                    "chapters": [{"order": c.chapter_order, "title": c.title, "full_text": c.full_text} for c in chs],
                    "storyboards": [{"order": s2.chapter_order, "shots": s2.shots_json} for s2 in sbs],
                }
                zf.writestr(f"drafts/{d.id}_{(d.title or 'untitled')[:20]}.json",
                           json.dumps(data, ensure_ascii=False, indent=2))
        
        buf.seek(0)
        from urllib.parse import quote
        filename = f"export_{user.username}_{datetime.now().strftime('%Y%m%d')}.zip"
        return StreamingResponse(
            iter([buf.read()]),
            media_type="application/zip",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
        )
