"""项目与资产的**访问控制**（多用户隔离）。

## 这个模块解决什么

2026-10-09 用户反馈：「我发现所有的用户都能看到所有的项目，这显然是个严重的问题」。

排查确认属实，而且比描述的更彻底：全库 17 张表里**只有 `auth_sessions` 记录过用户**，
`projects` 连归属列都没有。任何登录用户都能 `GET /v2/projects` 列出全部项目、
用 `/v2/projects/{id}/detail` 打开任意一个（含全部镜头、资产、剧本），
而且只要知道 shot / asset / stage / job 的 id，就能绕开 project 路径直接读写
——那些端点的路径里根本没有 project_id，从 URL 上看不出跟项目有关。

## 设计：两道闸，一"自动"一"显式"

改 130 条路由、每条手写一遍校验，最大的风险恰恰是**漏掉一条**——而漏掉的那条
就是下一个越权漏洞，且不会有任何报错。所以分两层，让"漏掉"变得可检测：

**第一层 · 路径自动拦截**（`main.py` 里的中间件调用 `check_project_path`）
 凡路径形如 `/v2/projects/{pid}/...`，自动取出 pid 并校验。43 个以 project_id
 为路径参数的端点**一行都不用改**就受保护。

**第二层 · 显式守卫**（`req_shot` / `req_asset` / ... 系列）
 路径里没有 project_id 的那些（`/v2/shots/{id}`、`/v2/assets/{id}`、`/v2/jobs/{id}`…）
 中间件无从知道它属于哪个项目，必须由路由自己声明。这些函数**查找与鉴权合一**：
  `req_shot(session, sid)` 直接返回对象或抛 404，调用方**不需要**再写
  `session.get(Shot, sid)` —— 让"安全的那条路"同时也是"顺手的那条路"，
 否则下一个人写新路由时仍会自然地写回裸 `session.get()`。

`scripts/verify_access_control.py` 会**枚举全部路由**，逐条断言它被上面某一层覆盖。
加了新端点却忘了守卫，那条脚本会红 —— 这是本模块唯一的防回退机制，
也是"会不会又漏一条"这个问题的答案。

## 两个刻意的裁定

**① 越权一律回 404，不回 403。**
403 等于承认"这个 id 存在，只是你看不了"——把项目 id 变成了可探测的资源。
404 让"不存在"和"不是你的"从外部完全无法区分。代价是用户偶尔会看到
"项目不存在"这种略含糊的提示，但这个含糊是**特性**，不是缺陷。

**①′ 唯一的两处例外（2026-10-16 协作上线时新增第二处）。**
  · `routers/library.py` 的转交端点：非管理员调 → 403。那是能力问题，不是归属问题。
  · 本模块 `_role_guard`：**已经是成员、但档位不够**（查看者想改东西）→ 403。
    这条是安全的：调用者本来就能 GET 这个项目，"它存在"对他不是秘密；
    而回 404 会在用户正盯着这个项目时说"项目不存在"，是**主动误导**。
    两者的区分从外部可判定：404 = 不是成员（或不存在），403 = 是成员但档位不够。

**② 归属为 NULL 的项目 = 只有管理员可见。**
老项目在本列出现之前就存在，库里没有任何线索能推断是谁建的
（jobs 没存创建者、auth_sessions 过期即删）。用户裁定「全部划给管理员」。
NULL 恰好就是这个语义，且比"硬写成 admin 的 user_id"更稳——它在生产环境
（管理员的 uid 可能与 dev 不同）依然成立，不需要在迁移里猜一个数字。
详见 `_backfill_project_owner` 的注释。

  ⚠️ 协作名册（`project_collaborators`）**不改变**这一条：owner 为 NULL 的项目
  不会因为名册上有行就变得可访问（见 `project_role` 第 5 步）。
  "无主"仍然是一个真实存在、且只有管理员能处理的状态。

## 三档协作角色（2026-10-16）

`project_role()` 把"能不能访问"这个 bool 升级成"是什么身份"，档位由低到高：
`viewer` < `editor` < `manager` < `owner`。

  · **viewer** 只读：能看资产、历史版本、导出（剪映草稿 / purge-preview）；
  · **editor** 能改：剧本、生成、时间轴、回退版本；
  · **manager** 能管：邀请/移除协作者、改项目设置（改名 / 画风 / 影调）；
  · **owner** 是虚拟档，**不在名册里**，只来自 `projects.owner_id`。

`manager` **不能删除项目、不能转交** —— 这正是"名册上限是 manager、
`owner` 只在 `owner_id` 里"这条设计的表达方式。

档位的强制点在 `main.py` 的 `_role_guard` 依赖（声明式盖章 `@access.requires(...)`），
不在这里；本模块只提供 `project_role` 与 `_RANK` 这一份事实。
"""
from __future__ import annotations

import re
from contextvars import ContextVar
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .db import (Asset, AssetStage, AudioClip, Job, MediaClip, Project,
                 ProjectCollaborator, Shot, SubtitleClip, Transition)

#: 当前请求的调用者。由 `main.py` 的 `session_guard` 中间件写入。
#:
#: ⚠️ 用 ContextVar 而不是 `request.state`：路由签名里要拿到 Request 就得给
#: 每个函数加参数（130 处），而 `req_*` 系列只收 session。ContextVar 实测能
#: 穿过 Starlette 中间件到达同步路由（线程池）与异步路由（事件循环）**两者**
#: —— 这条已由 `scripts/verify_access_control.py` 的行为用例守住。
#:
#: 默认 None = "没有调用者"。此时 `is_admin()` 为假、`current_user_id()` 为 None，
#: 一切按"最小权限"处理。后台任务（无 HTTP 请求）也走这个默认值，
#: 所以它们**不受**项目归属限制——那是对的：作业跑在服务端，本就该能读写
#: 自己那个项目，见 `require_project_access` 里 `_in_request()` 那段。
_CURRENT: ContextVar["Principal | None"] = ContextVar("fw_current_user",
                                                      default=None)

#: 本请求已收集到的 project_id（中间件算好，档位依赖直接用）。
#:
#: ## 为什么要用 ContextVar 传递，而不是让依赖自己再收一遍
#:
#: 请求体**只能读一次**。中间件为了校验成员关系必须读它（`POST /v2/assets
#: {project_id: 别人的}` 这种，路径和查询串里都没有 project_id），
#: 读完之后依赖再调 `request.body()` 会直接抛
#: `RuntimeError: Stream consumed` —— 实测就是这么炸的。
#:
#: 复制一份"解析后的 pid 列表"比复制 body 更小也更安全：依赖拿到的是**已经
#: 归一好的**结果，不可能出现两处解析口径不一致。
#:
#: `None` = 中间件没跑过（开放模式：没配 `FW_AUTH_UPSTREAM`，中间件压根不装）。
#: 那种情况下没有任何身份，档位依赖本来就会全部放行。
#:
#: ⚠️ 与 `_CURRENT` 同款：两个 ContextVar 必须在**同一次请求**里被写入与读取。
#: 别把它们搬进 `request.state`，也别在依赖里 `set` 指望路由能看见
#: （同步 `def` 依赖里 set 的值对同步路由**不可见**，实测）。
_REQUEST_PIDS: ContextVar["tuple[str, ...] | None"] = ContextVar(
    "fw_request_pids", default=None)


def set_request_project_ids(pids) -> None:
    """中间件调用：记录本请求涉及的 project_id，供 `_role_guard` 复用。"""
    _REQUEST_PIDS.set(tuple(pids or ()))


def request_project_ids() -> tuple[str, ...] | None:
    """本请求涉及的 project_id；`None` = 中间件没跑过。"""
    return _REQUEST_PIDS.get()


#: 本请求**要求的档位**（由 `main._role_guard` 从路由盖的章算出来）。
#:
#: ## 为什么需要它：对象 id 路由是档位闸门够不到的那一半
#:
#: `/v2/projects/{pid}/...` 那 43 条路由，pid 就在路径里，闸门直接查得到。
#: 但 `PATCH /v2/assets/{asset_id}`、`DELETE /v2/shots/{shot_id}` 这类**只带对象 id**
#: 的路由，project_id 既不在路径、也不在查询串、也不在请求体 —— 依赖层根本不知道
#: 这次请求属于哪个项目，只能等处理函数调 `req_asset()` 拿到对象之后才知道。
#:
#: 所以：闸门**无论有没有 pid 都把档位算出来**放进这个 ContextVar，
#: `_require` 在处理函数里拿到对象、解析出 pid 之后，用它做档位判定。
#: 两条路合起来才覆盖全部路由，且**不需要改 36 个 `req_*` 调用点**。
#:
#: ⚠️ 必须由 **async** 依赖写入（实测：同步 `def` 依赖里 `ContextVar.set`
#: 对同步路由**不可见**，异步依赖才可见）。`main._role_guard` 是 async def。
#:
#: `None` = 没有档位要求（开放模式、或非 /v2 路径）—— 此时只做成员判定，
#: 与协作上线前的行为完全一致。
_LEVEL: ContextVar["str | None"] = ContextVar("fw_request_level", default=None)


def set_request_level(level: str | None) -> None:
    """`main._role_guard` 调用：记录本请求要求的档位。"""
    _LEVEL.set(level)


def request_level() -> str | None:
    return _LEVEL.get()


def _forbidden(role: str, level: str) -> HTTPException:
    """档位不够的 403。结构化 detail —— 见 `enforce_role` 的说明。"""
    return HTTPException(status_code=403, detail={
        "reason": "forbidden_project_role",
        "message": (f"你是该项目的{_ROLE_CN.get(role, role)}，"
                    f"此操作需要{_ROLE_CN.get(level, level)}权限"),
        "your_role": role,
        "required_role": level,
    })

#: 视作管理员的 role 取值。**这是唯一的一份**，别处不要再写 `role == "admin"`。
#:
#: 两个值都来自主平台（drama `auth/models.py` 的注释就写着
#: `# user/admin/superadmin`），生产库实测两种都出现过。见 `Principal.is_admin`
#: 的文档，那里记着"只认 admin"会造成什么后果。
#:
#: 刻意用白名单而非 `!= "user"`：多一个角色时要有人显式加进来，
#: 而不是让任何新出现的拼写自动获得管理员权限。
_ADMIN_ROLES = frozenset({"admin", "superadmin"})

#: 协作档位（2026-10-16）。**这是唯一的一份**，别处不要再写 `role == "manager"`。
#:
#: 名册里允许出现的取值。**读侧也用它做白名单**：库里出现别的字符串时一律当
#: "不是成员"（fail closed），而不是当成某个默认档放行 —— 拼错的 role 宁可少给
#: 权限。与 `_ADMIN_ROLES` 同一条纪律：多一档要有人显式加进来。
ROLE_VIEWER = "viewer"
ROLE_EDITOR = "editor"
ROLE_MANAGER = "manager"
#: 虚拟档，**永远不写进 `project_collaborators`**，只来自 `projects.owner_id`。
#: 见 `db.ProjectCollaborator` 的注释（为什么所有者不进名册）。
ROLE_OWNER = "owner"
_ROSTER_ROLES = (ROLE_VIEWER, ROLE_EDITOR, ROLE_MANAGER)

#: 档位高低。`None` = 不是成员。**这是唯一的比较依据** ——
#: 任何地方要判"够不够档"都走 `_RANK[a] < _RANK[b]`，不要自己写 `role ==`。
_RANK: dict[str | None, int] = {
    None: -1, ROLE_VIEWER: 0, ROLE_EDITOR: 1, ROLE_MANAGER: 2, ROLE_OWNER: 3,
}

#: 面向用户的中文档位名。403 消息里用。
_ROLE_CN: dict[str, str] = {
    ROLE_VIEWER: "查看者", ROLE_EDITOR: "编辑者",
    ROLE_MANAGER: "管理者", ROLE_OWNER: "所有者",
}


def requires(level: str):
    """给路由盖章：这个端点至少需要 `level` 档。

    用法：`@router.post("/projects/{project_id}/…")` 之上再叠一层 `@access.requires("editor")`。

    ## 为什么是"挂在 endpoint 上的函数属性"，而不是中间件里的路径表

    路径表会与路由漂移 —— 改个 URL、加个子路径，表就悄悄对不上了，而且不会报错。
    属性跟着 endpoint 对象走，路由怎么写它都跟着。`scripts/verify_access_control.py`
    会枚举全部路由断言没人漏盖章（A 段），所以"漏一个"是可检测的。

    ## 谁来读这个属性

    `main.py` 的 `_role_guard` 依赖。它可以拿到匹配到的 `APIRoute` 与 `endpoint`，
    从而读到这里盖的章 —— 中间件做不到（它在 `call_next` 之前
    `request.scope["route"]` 还是 None）。

    ## 不盖章会怎样

    写方法（POST/PUT/PATCH/DELETE）默认要 `editor`，读方法默认只要 `viewer`。
    **默认方向刻意保守**：漏盖章是"多要了一档"，用户看得见 403；
    而不是"少要了一档"的静默越权。真正的只读 POST（剪映导出那类）
    必须**显式**盖 `viewer`，否则查看者会被自己的导出按钮挡住。
    """
    if level not in _ROSTER_ROLES and level != ROLE_OWNER:
        raise ValueError(f"未知档位 {level!r}——只能是 {_ROSTER_ROLES} 或 {ROLE_OWNER}")

    def deco(fn):
        fn._fw_role = level
        return fn
    return deco


@dataclass(frozen=True)
class Principal:
    """一个已认证的调用者。字段来自 `auth_sessions`（最终来自主平台）。"""
    user_id: int
    username: str
    role: str

    @property
    def is_admin(self) -> bool:
        """管理员判定。**同时认 `admin` 与 `superadmin`。**

        ## 为什么必须认 superadmin（2026-10-11，上线前拦下的事故）

        初版只写了 `role == "admin"`，理由是"别让一个拼错的 role 悄悄升级成
        管理员"。那个顾虑本身对，但它建立在一个**没核实过的前提**上：假设主平台
        只会下发 `admin`。事实上没有。

        证据是**生产库自己**：`filmweaver_prod.db` 的 `auth_sessions` 里
        唯一的那个管理员会话，role 正是 `superadmin`（1 个 superadmin +
        5 个 user，**一个 `admin` 都没有**）。主平台的判据也一直是
        `role in ("admin", "superadmin")`（见 drama 的 `stages/access.py`）。
        也就是说：按初版口径，**生产上没有任何人是管理员**。

        单看这一条只是"管理员少了几个按钮"，实际后果是**全库锁死**：
        `access.can_access_project` 对非管理员只放行 `owner_id == 自己`，
        而存量项目的 `owner_id` 一律是 NULL（裁定"全划给管理员"，见模块头 ②）。
        两者相乘 = 迁移一跑完，**37 个生产项目对所有人不可见，连管理员也打不开**。

        ## 仍然是白名单，不是"非 user 即管理员"

        写成 `role != "user"` 或随便什么前缀匹配，才会让拼错的 role 升级；
        显式列出两个已知取值不会。新增角色时这里要同步加 —— 这是**刻意的**：
        角色升级必须有人改这一行，不能靠"没被排除"自动获得。
        """
        return self.role in _ADMIN_ROLES


def set_current_user(user: dict | None) -> None:
    """中间件调用：把本请求的调用者放进上下文。"""
    if not user:
        _CURRENT.set(None)
        return
    _CURRENT.set(Principal(
        user_id=int(user.get("id") or 0),
        username=user.get("username") or "",
        role=user.get("role") or "user",
    ))


def current_principal() -> Principal | None:
    return _CURRENT.get()


def current_user_id() -> int | None:
    p = _CURRENT.get()
    return p.user_id if p else None


def is_admin() -> bool:
    p = _CURRENT.get()
    return bool(p and p.is_admin)


def _in_request() -> bool:
    """当前是否处在一次 HTTP 请求里（而不是后台作业/脚本）。

    ⚠️ 这个区分是必须的，不是洁癖。后台作业（生图、出片、剪映导出）大量调用
    `session.get(...)` 拿不属于"任何人"的数据，而它们**没有**调用者上下文。
    如果对它们也一律按"无主即拒绝"处理，整个生成链路会全线 404。
    """
    return _CURRENT.get() is not None


# ---------------------------------------------------------------------------
# 项目
# ---------------------------------------------------------------------------

#: `/v2/projects/{id}` 或 `/v2/projects/{id}/...`。刻意不匹配 `/v2/projects`
#: （列表/新建，没有 id）——`(?:/|$)` 要求 id 后面必须跟斜杠或结尾。
_PROJECT_PATH = re.compile(r"^/v2/projects/([A-Za-z0-9_-]{1,32})(?:/|$)")


def project_id_in_path(path: str) -> str | None:
    """从 URL 路径里取出项目 id；不是项目路径则返回 None。"""
    m = _PROJECT_PATH.match(path)
    return m.group(1) if m else None


#: 请求体里**可能**装着项目 id 的键。只认顶层这两个——
#: `/v2/jobs` 的项目 id 在 `payload.project_id`，其余端点都在顶层 `project_id`。
#: 刻意不做"递归找所有叫 project_id 的键"：嵌套结构里出现同名键可能另有含义
#: （例如"从哪个项目导入"），一律当成归属去校验会误拦。需要的地方单独处理。
_BODY_PID_KEYS = ("project_id",)


def project_ids_in_body(raw: bytes, content_type: str) -> list[str]:
    """从请求体里抽出项目 id（JSON 顶层 / jobs 的 payload / 表单字段）。

    为什么在中间件里做（而不是逐个路由）：带 project_id 的请求体端点有 24 个，
    散在 9 个文件里。逐个改最怕的就是漏一个 —— 而漏掉的那一个，攻击者只要
    把 body 里的 project_id 换成别人的，就能往别人的项目里写东西。

    ⚠️ 解析失败一律返回空列表、**不抛错**：坏 JSON 由路由自己的 422 处理，
    这里不该把"格式错误"变成"项目不存在"让用户摸不着头脑。

    ⚠️ **不设体积上限**。第一版为了省事跳过了 >32 KiB 的 JSON，结果
    `script/optimize`、`script/breakdown` 这类"整本剧本 + project_id"的端点
    就能靠一个够长的剧本绕过校验，往别人的项目里写。按端点逐个补是在给
    "漏一个"留机会；而解析几 MB 的 JSON 一次只要几十毫秒，不值得为它开口子。
    """
    out: list[str] = []
    ct = (content_type or "").lower()
    try:
        if "application/json" in ct:
            import json as _json
            data = _json.loads(raw or b"null")
            if isinstance(data, dict):
                for k in _BODY_PID_KEYS:
                    v = data.get(k)
                    if isinstance(v, str) and v:
                        out.append(v)
                pl = data.get("payload")
                if isinstance(pl, dict):
                    v = pl.get("project_id")
                    if isinstance(v, str) and v:
                        out.append(v)
        elif "application/x-www-form-urlencoded" in ct:
            from urllib.parse import parse_qs
            for k in _BODY_PID_KEYS:
                for v in parse_qs(raw.decode("utf-8", "replace")).get(k, []):
                    if v:
                        out.append(v)
        # multipart（文件上传）在中间件里解析代价高且要整包缓冲；
        # 那两个端点（media/upload、script/import-file）由路由自己显式校验，
        # 并由 verify_access_control 的"显式守卫清单"守住。
    except (ValueError, UnicodeDecodeError):
        return []
    return out



def collect_project_ids(*, path: str, method: str, query_params=None,
                        path_params=None, body: bytes = b"",
                        content_type: str = "") -> list[str]:
    """收集一次请求里**所有可能相关**的 project_id（去重保序）。

    四个来源：路径 / 路径参数 / 查询串 / 请求体。

    ## 为什么中间件与 `main._role_guard` 必须共用这一个函数

    两处各自实现必然漂移，而漂移的后果是**不对称的**两种事故：
      · 中间件收了、档位没收 → 成员闸门过了但档位没查 = 静默越权；
      · 档位收了、中间件没收 → 把不是成员的人当成"档位不够"回 403，
        等于用 403 承认"这个项目存在"（违反模块头 ①）。
    所以要收哪些来源**只能有一份清单**。这是那一份。

    ⚠️ 请求体只在写方法上收，且**跳过 multipart**（在中间件里解析代价高且要
    整包缓冲）。那两个 multipart 端点（media/upload、script/import-file）
    由路由自己显式校验，并由 `verify_access_control` 的显式守卫清单守住。
    """
    out: list[str] = []
    p = project_id_in_path(path)
    if p:
        out.append(p)
    for src in (path_params, query_params):
        if src:
            v = src.get("project_id")
            if isinstance(v, str) and v:
                out.append(v)
    if method in ("POST", "PUT", "PATCH", "DELETE"):
        if "multipart/form-data" not in (content_type or "").lower():
            out.extend(project_ids_in_body(body, content_type))
    return list(dict.fromkeys(out))     # 去重保序


def roles_for_projects(session: Session, project_ids) -> dict[str, str | None]:
    """批量取"我对这些项目各是什么档"。**语义与 `project_role` 完全一致**，
    只是把 N 次点查压成两条查询。

    列表页要逐项目标出"我是所有者 / 协作者（什么档）"，逐个调 `project_role`
    就是 2N 次查询。这里一次查 owner、一次查名册。

    ⚠️ 两条路的口径必须与 `project_role` 严丝合缝，改一处必须改另一处：
    管理员与无调用者都是 `owner`；`owner_id` 为 NULL 的项目**不**因为名册上有行
    而变得可访问；名册里不在白名单的 role 一律当"不是成员"。
    """
    ids = [p for p in dict.fromkeys(project_ids or []) if p]
    out: dict[str, str | None] = {p: None for p in ids}
    if not ids:
        return out
    if not _in_request():
        return {p: ROLE_OWNER for p in ids}
    princ = _CURRENT.get()
    if princ is None:
        return out
    if princ.is_admin:
        return {p: ROLE_OWNER for p in ids}
    uid = princ.user_id
    rows = (session.query(Project.id, Project.owner_id)
            .filter(Project.id.in_(ids)).all())
    for pid, owner in rows:
        if owner is None:
            continue                    # 无主：仅管理员，名册救不了（裁定 ②）
        if int(owner) == uid:
            out[pid] = ROLE_OWNER
    rest = [p for p in ids if out[p] is None]
    if rest:
        for pid, role in (session.query(ProjectCollaborator.project_id,
                                        ProjectCollaborator.role)
                          .filter(ProjectCollaborator.project_id.in_(rest),
                                  ProjectCollaborator.user_id == uid).all()):
            if role in _ROSTER_ROLES:
                out[pid] = role
    return out


def project_role(session: Session, project_id: str | None) -> str | None:
    """这个调用者对项目**是什么身份**。`None` = 不是成员（或项目不存在）。

    返回值是 `viewer` / `editor` / `manager` / `owner` 之一，或 `None`。
    判定顺序与旧的 `can_access_project` 逐条对齐，**只是多查了一级名册**：

      1. 没有 project_id                → None
      2. 无调用者（lifespan/巡检/CLI）   → owner（全权限）
      3. 有请求但没身份                  → None
      4. 管理员                          → owner（**不查库**，与旧行为一致）
      5. `projects.owner_id`：
           · 项目不存在                  → None（调用方据此回 404）
           · 等于我                      → owner
           · 为 NULL（无主老项目）        → None（裁定 ②，名册救不了它）
      6. 查名册：值在白名单内才返回，否则 None（fail closed）

    ## 为什么不缓存

    每次调用最多两次走索引的点查（owner 一次、名册一次），微秒级。而缓存正是
    "刚被邀请、下一个请求拿到旧答案"和"请求中途被移除协作者仍按旧档执行"这类
    错误的来源。这个代码库的既有取向也是不缓存会漂移的状态（见前端拒绝缓存业务
    数据、`_CURRENT` 是唯一的 ContextVar）。

    真要加的话，memo **必须挂在 `session.info`**（随 `with get_session()` 消亡，
    不会越过事务），**并且**所有改名的端点要绕过它。附一条实测陷阱：
    **同步 `def` 依赖里 `ContextVar.set` 对同步路由不可见**，`async def` 依赖才可见
    —— 所以 `main._role_guard` 必须是 `async def`。

    ## N+1 不会发生（已核对真实路由表）

    本函数收的是 project_id 而不是对象，所以与调用次数无关地只做点查。
    实测没有任何端点在循环里调 `req_*`（最多 2 次，且都是同一个项目）；
    `GET /v2/projects/{pid}/detail` 这个"加载资产/镜头/版本"的重量级端点
    **根本不调任何守卫**，鉴权由中间件那一次路径检查完成。
    """
    if not project_id:
        return None
    if not _in_request():
        # 后台巡检 / CLI / lifespan：没有调用者，按最高权限。
        # ⚠️ 这**不**等价于"后台作业" —— BackgroundTasks 跑在请求的上下文副本里，
        # 会继承提交者的 Principal（2026-10-16 实测：提交 tts_batch 后
        # `_in_request()` 为 True）。所以 HTTP 触发的作业走的是提交者那一档，
        # 那条路由靠"提交闸门"挡（提交时就校验档位），这里是巡检/脚本的通道。
        return ROLE_OWNER
    p = _CURRENT.get()
    if p is None:
        return None
    if p.is_admin:
        # 管理员不必查库：省一次查询，且管理员看回收站里的墓碑项目也要放行
        return ROLE_OWNER
    row = session.query(Project.owner_id).filter(Project.id == project_id).first()
    if row is None:
        return None
    if row[0] is not None and int(row[0]) == p.user_id:
        return ROLE_OWNER
    if row[0] is None:
        # 无主老项目：只有管理员（裁定 ②）。**刻意在查名册之前返回** ——
        # 名册不该让一个"无主"项目变得可访问，那种状态只应由管理员经转交处理。
        return None
    r = (session.query(ProjectCollaborator.role)
         .filter(ProjectCollaborator.project_id == project_id,
                 ProjectCollaborator.user_id == p.user_id).first())
    if r is None:
        return None
    # fail closed：库里出现拼错的 role 时当"不是成员"，而不是当成某个默认档放行
    return r[0] if r[0] in _ROSTER_ROLES else None


def can_access_project(session: Session, project_id: str | None) -> bool:
    """这个调用者能不能访问该项目（能不能≠能改，档位另见 `project_role`）。

    **签名与语义与协作上线前完全一致** —— 所有既有调用点零改动：
    中间件、`require_project_access`、8 个 `req_*` 守卫、`_require`、
    `library.py`、`routers/usage.py`、`project.py`、`stage_scene.py`。
    它们表达的都是"能不能碰这个项目"（成员底线），档位由 `_role_guard` 单独管。

    ⚠️ 项目**不存在**时返回 False（而不是 True）。调用方据此统一回 404，
       "不存在"与"不是你的"从外部不可区分。
    """
    return project_role(session, project_id) is not None


def require_project_access(session: Session, project_id: str | None) -> None:
    """无权限即抛 404；**有档位要求时不够档抛 403**。用于只有 project_id、不需要项目对象的端点。

    ## 为什么它也必须管档位

    只做成员判定的话，这条路上的写端点就漏了 —— 尤其是 **multipart 上传**：
    中间件与档位依赖都刻意不解析 multipart 请求体（代价高且要整包缓冲），
    所以闸门拿不到 pid、`_role_guard` 只能设好档位就返回。此时**唯一**的判定点
    就是处理函数里的这一句。它若不看档位，查看者就能往项目里传素材。

    档位来自 `_LEVEL`（`_role_guard` 提前算好的），所以本函数**不需要**知道
    自己是被哪个路由调的。
    """
    level = _LEVEL.get()
    if level is None:
        if not can_access_project(session, project_id):
            raise HTTPException(status_code=404, detail="项目不存在")
        return
    enforce_role(session, project_id, level)


def enforce_role(session: Session, project_id: str, level: str) -> None:
    """校验调用者对项目的**档位**。不是成员 → 404；是成员但不够档 → 403。

    与中间件的分工：中间件管"是不是成员"（不是就回 404），本函数管"够不够档"
    （是成员但不够就回 403）。两处都判一次成员是**有意的冗余** ——
    中间件只在启用登录（`FW_AUTH_UPSTREAM`）时安装，而本函数在任何部署形态下
    都要得出正确结果。

    403 的 detail 是**结构化**的（带 `reason` / `your_role` / `required_role`），
    理由见模块头 ①′：前端要能把"档位不够"和"项目不存在"分开，
    并且 `api.js` 的 `humanize()` 只认结构化的 `detail.message`，
    给纯字符串以外的形状会被渲染成"请求失败（403）"。
    """
    role = project_role(session, project_id)
    if role is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    if _RANK[role] < _RANK[level]:
        raise _forbidden(role, level)


def visible_projects_query(session: Session):
    """列表用的过滤后的查询。管理员拿到全部，普通用户拿到自己的 + 受邀协作的。

    ⚠️ 判据**始终是正向的成员关系**（我拥有 或 名册里有我），任何情况下都
    **不要**改成 `!= 别人`：`owner_id` 为 NULL 的行在 SQL 里既不等于任何用户 id、
    也不被 `!=` 命中 —— 用正向判据它自然落选（= 只有管理员看得到），
    用 `!=` 则会因为 NULL 比较返回 NULL 而**把无主项目漏给所有人**。

    这条在加了 EXISTS 之后**仍然成立**，且理由值得写下来：`EXISTS` 只返回
    TRUE/FALSE、永远不会是 NULL，所以它**救不了一个 owner_id 为 NULL 的项目**
    —— owner 为 NULL 时两个分支都是假，"无主 = 仅管理员"这条裁定不受影响。
    这正是我们要的性质，不是漏洞。

    ⚠️ 名册为空时，这条查询与协作上线前的 `owner_id == uid` **可证明等价**。
    这是 Phase 2 能做成"行为零变更"的依据，也是现有行为用例必须原样全绿的原因。
    """
    q = session.query(Project)
    if is_admin() or not _in_request():
        return q
    uid = current_user_id()
    if uid is None:
        # 有调用者上下文却没有 id —— 不该发生（登录必然带 id）。
        # 返回空集而不是全部：这是"最小权限"，也是唯一安全的兜底。
        return q.filter(Project.id.is_(None))
    # 相关子查询，走 project_collaborators 的复合主键前缀 (project_id, user_id)。
    # 外层 `owner_id == uid` 走 ix_projects_owner（2026-10-16 补的索引，
    # 此前这一列没有索引、每次列表加载都是全表扫）。
    member = (session.query(ProjectCollaborator.project_id)
              .filter(ProjectCollaborator.project_id == Project.id,
                      ProjectCollaborator.user_id == uid).exists())
    return q.filter(or_(Project.owner_id == uid, member))


def transfer_owner(session: Session, project_id: str, owner_id: int | None) -> None:
    """把项目转给另一个用户（`owner_id=None` = 收回为无主/仅管理员）。

    这是"存量 109 个项目全划给管理员"之后，管理员把其中某个交给实际作者的
    唯一出口——没有它，那些项目永远只能管理员自己看。
    """
    p = session.get(Project, project_id)
    if p is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    p.owner_id = owner_id
    session.commit()


# ---------------------------------------------------------------------------
# 由 id 直接取对象 —— 查找与鉴权合一
# ---------------------------------------------------------------------------
#
# 每个 `req_*` 都做同一件事：取出对象 → 顺着链子回到 project_id → 校验归属。
# 路径里没有 project_id 的端点**必须**用它们代替裸 `session.get()`。

def _project_of_shot(session: Session, shot: Shot) -> str | None:
    return shot.project_id


def _project_of_asset(session: Session, asset: Asset) -> str | None:
    return asset.project_id


def _project_of_stage(session: Session, st: AssetStage) -> str | None:
    return st.project_id


def _project_of_job(session: Session, j: Job) -> str | None:
    # ⚠️ `Job.project_id` 可为 NULL（7 条历史 job：compose / asset_batch，
    # 见 db.Job 的注释）。NULL 时无法判定归属 —— 这种 job 一律回 404。
    # 不去 payload 里翻 project_id 兜底：payload 是可变结构，不同 kind 的键
    # 不一样，猜错就会把别人的 job 放出去，而这里的收益只是让几条历史记录可见。
    return j.project_id


def _project_of_audio_clip(session: Session, c: AudioClip) -> str | None:
    return c.project_id


def _project_of_subtitle_clip(session: Session, c: SubtitleClip) -> str | None:
    return c.project_id


def _project_of_media_clip(session: Session, c: MediaClip) -> str | None:
    return c.project_id


def _project_of_transition(session: Session, t: Transition) -> str | None:
    return t.project_id


def _require(session: Session, obj, pid: str | None, what: str) -> None:
    """对象级守卫的公共出口：不是成员 → 404（`{what}不存在`）；档位不够 → 403。

    ## 为什么档位判定在这里

    这条路上的端点（`PATCH /v2/assets/{id}`、`DELETE /v2/shots/{id}`…）路径里
    **没有 project_id**，闸门依赖无从得知这次请求属于哪个项目 —— 它只能等
    处理函数调 `req_asset()` 把对象取出来、顺着链子回到 pid。所以档位判定必须
    在这里补一刀，用的是闸门提前算好并放进 `_LEVEL` 的档位（见 `_LEVEL` 的注释）。

    这样做的代价是零：36 个既有 `req_*` 调用点**一行都不用改**，
    挡在写路由上的判定自动生效（写方法未盖章默认 editor）。
    """
    if obj is None:
        # 消息统一用中文名，但**不区分**"不存在"与"无权限" —— 见模块头 ①
        raise HTTPException(status_code=404, detail=f"{what}不存在")
    role = project_role(session, pid)
    if role is None:
        raise HTTPException(status_code=404, detail=f"{what}不存在")
    level = _LEVEL.get()
    if level is not None and _RANK[role] < _RANK[level]:
        raise _forbidden(role, level)


def req_shot(session: Session, shot_id: str) -> Shot:
    s = session.get(Shot, shot_id)
    _require(session, s, _project_of_shot(session, s) if s else None, "镜头")
    return s


def req_asset(session: Session, asset_id: str) -> Asset:
    a = session.get(Asset, asset_id)
    _require(session, a, _project_of_asset(session, a) if a else None, "资产")
    return a


def req_stage(session: Session, stage_id: str) -> AssetStage:
    st = session.get(AssetStage, stage_id)
    _require(session, st, _project_of_stage(session, st) if st else None, "造型")
    return st


def req_job(session: Session, job_id: str) -> Job:
    j = session.get(Job, job_id)
    _require(session, j, _project_of_job(session, j) if j else None, "任务")
    return j


def req_audio_clip(session: Session, clip_id: str) -> AudioClip:
    c = session.get(AudioClip, clip_id)
    _require(session, c, _project_of_audio_clip(session, c) if c else None, "音频片段")
    return c


def req_subtitle_clip(session: Session, clip_id: str) -> SubtitleClip:
    c = session.get(SubtitleClip, clip_id)
    _require(session, c, _project_of_subtitle_clip(session, c) if c else None,
             "字幕片段")
    return c


def req_media_clip(session: Session, clip_id: str) -> MediaClip:
    c = session.get(MediaClip, clip_id)
    _require(session, c, _project_of_media_clip(session, c) if c else None, "素材片段")
    return c


def req_transition(session: Session, trans_id: str) -> Transition:
    t = session.get(Transition, trans_id)
    _require(session, t, _project_of_transition(session, t) if t else None, "转场")
    return t


def require_shots_of_project(session: Session, shot_ids, project_id: str) -> None:
    """一批 shot id 是否**全部**属于该项目。不满足即 404。

    用于 `transitions.create`（裸传 from/to shot id）、`stages.merge`
    （裸传 stage_ids）、`shots/detach-audio` 这类"一批 id + 一个 project_id"的入参：
    只校验 project_id 归属是不够的 —— 攻击者可以把别人的 shot id 塞进这批里，
    带着自己的 project_id 一起提交。
    """
    ids = [x for x in (shot_ids or []) if x]
    if not ids:
        return
    n = (session.query(Shot.id)
         .filter(Shot.id.in_(ids), Shot.project_id == project_id).count())
    if n != len(set(ids)):
        raise HTTPException(status_code=404, detail="镜头不存在")


def require_stages_of_project(session: Session, stage_ids, project_id: str) -> None:
    """同上，用于 asset_stages。"""
    ids = [x for x in (stage_ids or []) if x]
    if not ids:
        return
    n = (session.query(AssetStage.id)
         .filter(AssetStage.id.in_(ids), AssetStage.project_id == project_id).count())
    if n != len(set(ids)):
        raise HTTPException(status_code=404, detail="造型不存在")
