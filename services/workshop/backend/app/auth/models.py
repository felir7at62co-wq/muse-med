"""User ORM模型"""
from sqlalchemy import Column, Integer, String, DateTime, JSON
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func
from ..db.models import Base


"""用户模型 (含 login_id 双字段方案)。

字段语义:
  - login_id  : 永久不可改, 登录用 (内部追溯)
  - username  : 可改, 加粗展示给 admin 看 (内部管理代号)
  - display_name : 用户自己填的昵称 (前台展示)

迁移说明: 现有用户的 login_id 在迁移时直接复制 username, 后续两者独立。
"""
class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    # 永久不可改的登录账号 (内部追溯)
    login_id = Column(String(64), unique=True, nullable=False, index=True)
    # 可由 admin 修改的展示账号
    username = Column(String(64), unique=True, nullable=False)
    # 上次 username 修改时间 (用于冷却期判断)
    username_changed_at = Column(DateTime)
    email = Column(String(128), unique=True)
    phone = Column(String(32), unique=True)
    # 飞书自动建号的用户没有密码(password_hash=NULL), 只能扫码登录。
    # 所以这里必须 nullable —— 数据库侧已同步 DROP NOT NULL。
    password_hash = Column(String(128))
    display_name = Column(String(64))
    avatar_url = Column(String(512))
    role = Column(String(16), default="user")        # user/admin/superadmin
    status = Column(String(16), default="active")    # active/disabled/banned
    # 功能白名单开关 (可扩展): {"novel_video": true, ...}。admin/superadmin 默认全通, 无需在此登记。
    feature_flags = Column(JSONB, default=dict)
    quota_daily = Column(Integer, default=100)
    quota_used_today = Column(Integer, default=0)
    quota_reset_at = Column(DateTime)
    # ---- 飞书绑定(企业身份) ----
    # union_id 作绑定键: 同一开发者下跨应用一致, 且不同企业的用户天然区分。
    # 不用 open_id —— 它是"应用内"唯一, 换/新建应用就全部失效。
    # 不用 user_id/employee_no —— 属敏感字段, 需额外申请权限才返回。
    feishu_union_id = Column(String(64), unique=True, index=True)
    feishu_open_id = Column(String(64))      # 备查: 调飞书其他接口时常需要
    feishu_name = Column(String(64))         # 飞书侧姓名, 用于管理后台核对是谁
    feishu_bound_at = Column(DateTime)       # 绑定时间, 用于统计过渡期进度
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    last_login_at = Column(DateTime)
    last_login_ip = Column(String(45))


class UserAuditLog(Base):
    __tablename__ = "user_audit_logs"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True)
    action = Column(String(64))
    resource_type = Column(String(32))
    resource_id = Column(Integer)
    ip = Column(String(45))
    user_agent = Column(String(512))
    log_metadata = Column("metadata", JSON, default=dict)
    created_at = Column(DateTime, server_default=func.now())
