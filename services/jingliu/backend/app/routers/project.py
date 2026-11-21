"""项目 CRUD、剧本导入、分集正文。

`GET/POST   /v2/projects`  `GET/PATCH/DELETE /v2/projects/{pid}`
`POST       /v2/projects/{pid}/restore`      —— 回收站恢复
`GET        /v2/projects/{pid}/purge-preview` —— 彻底删除前的清盘预览
`POST       /v2/script/import` / `script/import-file`
`GET/PUT    /v2/projects/{pid}/episodes/content`（含 `/{order}/content`）

## 为什么从 routes_v2.py 搬出来

行数预算「只许减」（见 `routers/__init__.py`）。这一段在原文件里是**开头的
一整块连续代码**（L276–654），搬走后 `routes_v2.py` 直接少了近 400 行。
它依赖的三个档案常量（`PRODUCTION_MODES` / `_LEGACY_DEFAULTS` / `BASE_ASPECTS`）
已下沉到 `project_defaults.py` —— 那三个常量的真实消费者是 jobs 与 migrations，
放在路由文件里会逼出反向 import。

## 两个容易踩的口径

- `purge-preview` 只**预览**清盘范围，真正删除走 `delete_project`；
  两者必须用同一份"独占文件"计算（`project_purge`），否则预览与实删会对不上。
- `_do_script_import` 是 import / import-file 两条路由的共用实现 ——
  分叉两份会让"粘贴导入"与"传文件导入"的解析规则慢慢漂移。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
import json
import uuid

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import case, func

from ..db import Job, Project, Shot, get_session, profile_of
from .. import access
from ..project_defaults import BASE_ASPECTS, PRODUCTION_MODES, _LEGACY_DEFAULTS
from ..script_import import smart_split_chapters
from .. import project_purge
from .. import stale as stale_mod
from .. import style_preset as _sp

router = APIRouter(prefix="/v2", tags=["project"])
logger = __import__("logging").getLogger(__name__)


class ProjectCreate(BaseModel):
    title: str
    base_aspect: str = "9:16"
    default_profile: Optional[str] = None
    production_mode: Optional[str] = None  # drama | narration | anime（旧值 fast/consistent/… 仍接受，迁移期兼容）
    #: 画风预设 key（urban/period/anime_3d/…，见 style_preset）。
    #: 不传 = 取该模式的默认档。非法值会被 `sanitize` 丢成 None，不报错——
    #: 画风是增强项，不该让一个拼错的 key 挡住建项目。
    art_style: Optional[str] = None
    #: 技术参数（video_model/image_model/generation_mode/resolution）存入 default_profile JSON
    custom_settings: Optional[dict] = None


class ProjectOut(BaseModel):
    id: str
    title: str
    base_aspect: str
    default_profile: Optional[str] = None
    production_mode: Optional[str] = None
    #: 用户选的画风 key（可能是尚未启用的档，如古风——那是意图记录）
    art_style: Optional[str] = None
    #: **实际生效**的画风 key。与 art_style 不同就说明选的那档还没启用、
    #: 本次按都市档出图。前端据此显示「当前按都市生成」的提示。
    effective_style: Optional[str] = None
    schema_version: str = "1.0.0"
    #: **我对这个项目是什么档**（owner / manager / editor / viewer）。
    #: 前端进查看者模式、显隐写按钮全靠它 —— 不返回的话前端只能猜，
    #: 而"猜错就把写按钮给查看者看"是这个代码库付过学费的一类 bug。
    #: 建项目时一定是 owner；打开被分享的项目时是名册里那一档。
    my_role: Optional[str] = None


def create_project_record(body: ProjectCreate, owner_id: Optional[int]) -> ProjectOut:
    """建一个项目并落库。网页端点与 Agent 工具 `create_project` 的**唯一**实现。

    `owner_id` 由调用方显式传入，不在这里读 `access.current_user_id()`：
    网页请求里那个值来自中间件放进的 ContextVar，而后台作业（服务端超级 Agent）
    里它是空的 —— 读空会建出 owner_id=NULL 的项目，NULL 的语义是「仅管理员可见」，
    建的人自己反而看不见（见 access 模块头）。

    Raises:
        ValueError: 生产模式或画幅不合法（文案可直接给用户看）。
    """
    # 接受新值（drama/narration）和旧预设值（迁移兼容）
    valid_modes = set(PRODUCTION_MODES.keys()) | set(_LEGACY_DEFAULTS.keys())
    if body.production_mode and body.production_mode not in valid_modes:
        raise ValueError(f"未知生产模式: {body.production_mode}")
    if body.base_aspect not in BASE_ASPECTS:
        raise ValueError(f"不支持的画幅 {body.base_aspect}；可选: {', '.join(BASE_ASPECTS)}")
    pid = uuid.uuid4().hex[:12]
    # 技术参数（video_model/image_model/generation_mode/resolution）统一存 default_profile。
    # 两种模式（drama/narration）都可以携带 custom_settings，
    # 不再有"只有 custom 才能带参数"的限制。
    default_profile = body.default_profile
    if body.custom_settings:
        # 首帧 / 首尾帧 / 尾帧三种生成模式已下线（2026-11-20）：旧网页还选得到时，
        # 按全能参考存，不把已下线的模式写进新项目。
        from ..providers.base import live_generation_mode
        settings = dict(body.custom_settings)
        if settings.get("generation_mode"):
            settings["generation_mode"] = live_generation_mode(settings["generation_mode"])
        default_profile = json.dumps(settings, ensure_ascii=False)
    # 画风：清洗后入库。`sanitize` **保留尚未启用的合法档**（如古风）——
    # 那是用户的意图记录，等它放开就自动生效，不用重设；不属于该模式或不存在
    # 的 key 一律丢成 None（= 用默认档），不报错。
    art_style = _sp.sanitize(body.production_mode, body.art_style)
    with get_session() as session:
        session.add(
            Project(
                id=pid,
                title=body.title,
                base_aspect=body.base_aspect,
                default_profile=default_profile,
                production_mode=body.production_mode,
                art_style=art_style,
                # 归属：建项目的人。此前没有这一列，于是所有人都能看见所有项目
                # （2026-10-09 用户反馈）。
                owner_id=owner_id,
                # 必须显式存：`pid` 是 uuid4().hex[:12]，**纯随机、不含时间**，
                # 从 id 还原不出创建顺序（列表页一度按 id 排序并注释"字典序即时序"，
                # 排出来其实是随机序）。格式与 jobs.created_at 一致，可直接字典序比较。
                created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            )
        )
        session.commit()
    return ProjectOut(
        id=pid,
        title=body.title,
        base_aspect=body.base_aspect,
        default_profile=default_profile,
        production_mode=body.production_mode,
        art_style=art_style,
        effective_style=_sp.resolve(body.production_mode, art_style).key,
        my_role="owner",
    )


@router.post("/projects", response_model=ProjectOut)
def create_project(body: ProjectCreate) -> ProjectOut:
    # 调用者由中间件放进了 ContextVar —— 见 access 模块头。
    try:
        return create_project_record(body, access.current_user_id())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: str) -> ProjectOut:
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        return ProjectOut(
            id=proj.id,
            title=proj.title,
            base_aspect=proj.base_aspect,
            default_profile=proj.default_profile,
            # production_mode 漏传了（B35）：ProjectOut 声明了这个字段，
            # 这里不填就恒为 null —— 响应模型在说谎。POST /projects 回填了它，
            # 于是"建项目返回 consistent、随后 GET 同一项目返回 null"。
            # 快/精/自定义档决定下发哪个视频模型，谁照这个响应做判断就会误判成默认档。
            production_mode=proj.production_mode,
            art_style=proj.art_style,
            effective_style=_sp.resolve(proj.production_mode, proj.art_style).key,
            schema_version=proj.schema_version,
            my_role=access.project_role(session, project_id),
        )


@router.get("/projects")
def list_projects(trash: bool = False, q: str = "") -> dict:
    """TB-11：列表接口带统计，消除前端 N+1 补拉。

    每个项目附带缩略图、已出片/总镜头数、总时长，前端 ProjectCards 直接消费，
    不再逐项目发 detail 请求（30 个项目 = 30 个请求）。

    统计口径与 detail 一致：只算未停用镜头。缩略图取该项目 order 最小的
    那个已出片镜头的 thumb_url——第一镜最能代表这部片子，比 max() 随机取一个好。

    `trash=false`（默认）只返回在用项目；`trash=true` **只**返回回收站里的墓碑行。
    两者互斥而非叠加：回收站是一块独立视图，混在一起会让用户以为删除没生效。

    `q` = 按**项目名**搜索（2026-10-22 用户需求）。放在服务端而不是前端筛：
    列表可能被截断/分页，前端筛会出现"明明有这个项目，搜不到"。
    **过滤在可见性之后**，所以它只会缩小范围、绝不放宽权限——搜别人的项目名
    不会把它搜出来。

    ⚠️ **可见性**（2026-10-09）：此前这里是 `session.query(Project)` 全表返回，
    任何登录用户都能看到所有人的项目 —— 那正是用户报的那个严重问题。
    现在走 `access.visible_projects_query()`：管理员看全部，普通用户只看自己
    名下的，`owner_id` 为 NULL 的老项目只有管理员看得到。
    """
    needle = (q or "").strip()
    with get_session() as session:
        qry = access.visible_projects_query(session)
        qry = qry.filter(Project.deleted_at.isnot(None)) if trash \
            else qry.filter(Project.deleted_at.is_(None))
        if needle:
            # ilike：SQLite 的 LIKE 对 ASCII 本就不区分大小写，但项目名里中英
            # 混写很常见（"Ep01 楔子"），统一走 ilike 免得换个库行为就变。
            qry = qry.filter(Project.title.ilike(f"%{needle}%"))
        projs = qry.all()
        _uid = access.current_user_id()

        # 一次查询把所有项目的镜头统计算出来（避免 N+1）
        stat_rows = (
            session.query(
                Shot.project_id,
                func.count(Shot.id),
                func.sum(case((Shot.video_url.isnot(None), 1), else_=0)),
                func.sum(func.coalesce(Shot.duration_sec, 5.0)),
            )
            .filter(Shot.disabled == 0)
            .group_by(Shot.project_id)
            .all()
        )
        stats = {r[0]: (int(r[1] or 0), int(r[2] or 0), float(r[3] or 0.0))
                 for r in stat_rows}

        # 「最近活动」= 该项目最后一个任务的时刻。
        # 刻意**不加** projects.updated_at 列：那要在几十个写路径上逐个 touch，
        # 漏一个就静默说谎（用户明明刚改过，列表里却显示三周前）。
        # 由 jobs 派生则永远与事实一致，代价只是这一条 group-by。
        act_rows = (session.query(Job.project_id, func.max(Job.created_at))
                    .filter(Job.project_id.isnot(None))
                    .group_by(Job.project_id).all())
        last_active = {r[0]: r[1] for r in act_rows if r[1]}

        # 每个项目的封面：order 最小的已出片镜头的缩略图
        thumb_rows = (
            session.query(Shot.project_id, Shot.thumb_url, Shot.order)
            .filter(Shot.disabled == 0, Shot.thumb_url.isnot(None))
            .order_by(Shot.project_id, Shot.order)
            .all()
        )
        thumbs: dict[str, str] = {}
        for pid, turl, _order in thumb_rows:
            thumbs.setdefault(pid, turl)

        # 管理员视图要能看出"这个是谁的"——此前只标「他人」，转交几十个项目时
        # 无从核对转对了没有。只给管理员：普通用户不该拿到别人的用户名单。
        _names: dict[int, str] = {}
        if access.is_admin():
            from .library import _user_directory
            _names = {uid: (u["display_name"] or u["username"])
                      for uid, u in _user_directory(session).items()}
        # 「我对每个项目是什么档」——协作者的列表页靠它显示角色标签、
        # 决定要不要进查看者模式。批量取（两条查询），逐个调会变成 2N 次。
        _roles = access.roles_for_projects(session, [p.id for p in projs])
        return {
            "projects": [
                {
                    "id": p.id,
                    "title": p.title,
                    "base_aspect": p.base_aspect,
                    "default_profile": p.default_profile,
                    "production_mode": p.production_mode,
                    "episodes_count": len(json.loads(p.episodes)) if p.episodes else 0,
                    "schema_version": p.schema_version,
                    # ---- TB-11 新增统计字段 ----
                    "shots_total": stats.get(p.id, (0, 0, 0.0))[0],
                    "shots_done": stats.get(p.id, (0, 0, 0.0))[1],
                    "total_sec": stats.get(p.id, (0, 0, 0.0))[2],
                    "thumb_url": thumbs.get(p.id),
                    # ---- 排序/回收站字段 ----
                    # created_at 可能为 null：迁移回填只认 jobs，从没跑过任务的
                    # 老空项目无从推断创建时刻。前端排序把 null 一律排最后，
                    # 不编造时间。
                    "created_at": p.created_at,
                    "deleted_at": p.deleted_at,
                    "last_active_at": last_active.get(p.id),
                    # ---- 协作（2026-10-16）----
                    # `my_role`：owner / manager / editor / viewer。
                    #   前端靠它决定进不进查看者模式、显不显示「协作者」按钮。
                    #   不给的话前端只能猜 —— 而"猜错就把写按钮给查看者看"
                    #   是这个代码库付过学费的一类 bug（见 access.Principal.is_admin）。
                    # `shared`：这个项目是**别人分享给我的**（我不是所有者）。
                    #   列表页据此打「协作者 · 查看者」标签。管理员看别人的项目时
                    #   my_role 是 owner（管理员全权），但 shared 仍为真。
                    "my_role": _roles.get(p.id),
                    "shared": bool(_uid is not None and p.owner_id is not None
                                   and int(p.owner_id) != _uid),
                    # 归属：管理员视图里要能分出"我的 / 别人的 / 无主"——
                    # 无主的是迁移前的存量项目，等管理员转交（见 library.set_project_owner）
                    "owner_id": p.owner_id,
                    "owner_name": _names.get(int(p.owner_id)) if p.owner_id is not None else None,
                    "mine": (_uid is not None and p.owner_id is not None
                             and int(p.owner_id) == _uid),
                }
                for p in projs
            ]
        }


# ---------- 项目 × 用户的界面偏好（2026-10-23）----------
#
# 用户需求：「视频生成位置的文本框中，提示词里的引用块很影响观感，加一个开关
# 隐藏/显示引用块」。明确要求**只做视觉隐藏**、且**对这个用户的这个项目**生效。
#
# ## 为什么是一个独立的表 + 独立端点
#
# 项目级设置（`projects.default_profile`：分辨率/模型/画风）对**全项目人**生效，
# 而这个偏好是"我有他无"的 —— 塞进去等于把我的观感强加给协作者。
# 详见 `db.ProjectUserPref` 的三条排除。
#
# ## ⚠️ 这里的"隐藏"是**样式降级**，不是 display:none
#
# 提示词编辑器保存时读的是 `#shot-prompt` 的 **innerText**。实测（无头 Chromium）：
#
#     display:none / visibility:hidden → innerText 里 chip 的文字**消失**
#     opacity:0 / font-size:0 / 去掉样式  → innerText 完整
#
# 也就是说，真用 display:none 隐藏，用户只要点一下输入框外面（触发失焦保存），
# 提示词正文里的 `@引用` 就会被**永久删掉**。所以前端把它降级成普通文字
# （去底色/边框/角标），一个字都不少。后端在这里不参与渲染，只记开关。

#: 允许的偏好键与默认值。**白名单**：前端传未知键一律忽略，
#: 免得任何人往 `prefs_json` 里塞任意大的东西（那一列没有长度上限）。
_PREFS_DEFAULT: dict[str, object] = {
    #: True = 提示词里的引用块降级为普通文字（去底色/边框/角标），文字不动
    "prompt_chips_hidden": False,
}


def _read_prefs_raw(session, project_id: str, user_id: int) -> dict:
    """读某人在某项目的偏好**原文**（不按白名单过滤，坏数据当空）。

    写侧必须用这个，不能用 `_read_prefs`：后者只保留 `_PREFS_DEFAULT` 里的键，
    拿它当合并基底会把库里已有的**别的键悄悄丢掉** —— 老版本前端保存一次，
    新版本加的开关就没了。这正是"合并而非覆盖"要防的那件事。
    """
    from ..db import ProjectUserPref
    row = session.get(ProjectUserPref, (project_id, int(user_id)))
    if row is None or not row.prefs_json:
        return {}
    try:
        got = json.loads(row.prefs_json)
    except (ValueError, TypeError):
        return {}
    return dict(got) if isinstance(got, dict) else {}


def _read_prefs(session, project_id: str, user_id: int) -> dict:
    """读某人在某项目的偏好，**永远返回一份完整的、只含已知键的 dict**。

    读侧按白名单过滤：库里可能留着已废弃的键，前端不该看见它们。
    ⚠️ 必须容错：`prefs_json` 是文本列，可能被写成非 JSON（手改、旧版本、
    截断）。解析失败就退回默认值 —— 一条坏偏好不该把提示词编辑器打挂。
    """
    got = _read_prefs_raw(session, project_id, user_id)
    out = dict(_PREFS_DEFAULT)
    for k in _PREFS_DEFAULT:
        if k in got:
            out[k] = bool(got[k])
    return out


class ProjectPrefsIn(BaseModel):
    #: 只传要改的键。**不传的键保持原样**（见下方 patch 语义）。
    prefs: dict[str, object] = Field(default_factory=dict)


@router.get("/projects/{project_id}/prefs")
def get_project_prefs(project_id: str) -> dict:
    """**我**在这个项目里的界面偏好。

    ⚠️ 读的是 `access.current_user_id()`，**不接受 user_id 参数**：
    让人传 user_id 就等于开了"看别人偏好"的口子，而它没有任何用途。
    没登录（开放模式）时返回默认值，不报错 —— 偏好缺失不该挡住页面渲染。
    """
    with get_session() as session:
        if not access.can_access_project(session, project_id):
            raise HTTPException(status_code=404, detail="project not found")
        uid = access.current_user_id()
        prefs = (_read_prefs(session, project_id, uid)
                 if uid is not None else dict(_PREFS_DEFAULT))
    return {"project_id": project_id, "prefs": prefs,
            "defaults": dict(_PREFS_DEFAULT)}


@router.put("/projects/{project_id}/prefs")
@access.requires(access.ROLE_VIEWER)
def put_project_prefs(project_id: str, body: ProjectPrefsIn) -> dict:
    """改**我**在这个项目里的界面偏好（合并，不是整份覆盖）。

    ## 为什么是合并而不是覆盖

    老前端保存一次会把新版本加的开关**抹掉** —— 它压根不知道那个键存在。
    所以这里只改请求里出现的键，其余原样保留。

    ## 为什么不需要 manager 档

    这是"我自己的界面"，不是项目设置。查看者（viewer）也应该能改自己的观感 ——
    把他挡在 403 后面毫无道理。但 `_role_guard` 对 PUT 默认要 editor 档，
    所以这里**显式盖 viewer**（与剪映导出那类只读 POST 同一手法）。
    """
    if not isinstance(body.prefs, dict) or not body.prefs:
        raise HTTPException(status_code=422, detail="prefs 不能为空")
    unknown = [k for k in body.prefs if k not in _PREFS_DEFAULT]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"未知偏好键 {unknown}；可选: {', '.join(_PREFS_DEFAULT)}")
    uid = access.current_user_id()
    if uid is None:
        raise HTTPException(status_code=401, detail="需要登录")
    from ..db import ProjectUserPref
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with get_session() as session:
        # 归属：中间件已按路径里的 project_id 校验过成员身份；这里再判一次
        # 是为了"只有 project_id、没有项目对象"的路径与 access 口径一致
        # （不存在与没权限都回 404，见 access 模块头 ①）。
        if not access.can_access_project(session, project_id):
            raise HTTPException(status_code=404, detail="project not found")
        # ⚠️ 合并基底必须用 `_read_prefs_raw`（原文、不过滤）：
        # 拿 `_read_prefs`（只保留当前白名单里的键）当基底，库里已有的其它键
        # 会被悄悄丢掉 —— 那正是"合并而非覆盖"要防的事。
        prefs = _read_prefs_raw(session, project_id, uid)
        for k in _PREFS_DEFAULT:
            if k in body.prefs:
                prefs[k] = bool(body.prefs[k])
        row = session.get(ProjectUserPref, (project_id, int(uid)))
        if row is None:
            row = ProjectUserPref(project_id=project_id, user_id=int(uid),
                                  prefs_json=json.dumps(prefs, ensure_ascii=False),
                                  updated_at=now)
            session.add(row)
        else:
            row.prefs_json = json.dumps(prefs, ensure_ascii=False)
            row.updated_at = now
        session.commit()
    return {"ok": True, "project_id": project_id, "prefs": prefs}


# ---------- 项目：分辨率档位（2026-10-19 用户需求）----------
#
# 背景：分辨率此前**只在建项目向导里能选一次**，之后没有任何入口能改
# （`default_profile` 只有 POST /projects 写得到，PATCH 只改 title）。
# 用户要给某个项目整体调档，或临时给一镜换档，都无处下手。
#
# 三层覆盖关系（jobs.run_shot_videos 里消费，改这里之前先读那段）：
#   镜头 profile_override.megapixels（最优先，数值 MP，不是档位名）
#     > 本次 job payload.resolution（出片时临时覆盖）
#     > 项目 default_profile.resolution（本端点写的就是这一层）
#
# ⚠️ 这个旋钮**不只是清晰度**，它同时影响两件事，面板上必须说清：
#   ① 单镜时长上限（`shot_timing.shot_seconds_cap`）——RunningHub H3 受显存
#      MP·s 约束，2MP 只能出 8s、0.5MP 能出 38s。调高分辨率会让**能拍的时长变短**；
#   ② 计费预估（`charge._video_model` 按档位算 token）——调高档位单条更贵。
# 而且两个模型都会让某些档位**静默不生效**（seedance 没有 2k、低价渠道恒 720p），
# 所以这里一并把"实际会按哪档出"算出来下发，不让用户以为选了就生效。


class ProjectResolutionIn(BaseModel):
    #: 目标档位（`shot_timing.RESOLUTION_TIERS` 的键：480p/720p/1080p/2k）。
    #: None 或空串 = **清除项目设置**，回到"跟随平台默认"。
    resolution: Optional[str] = None


def _resolution_report(proj) -> dict:
    """当前档位 + 该档在本项目选定模型下**实际**会长成什么样。

    抽成函数而不是内联：`GET` 与 `PUT` 两个端点都要回同一份口径，
    各写一遍必然漂移（本仓已经为"两套算法"付过学费，见 @图片N 那轮）。
    """
    from ..jobs import _resolve_project_resolution, _resolve_project_video_model
    from ..providers.registry import registry
    from ..shot_timing import RESOLUTION_TIERS, shot_duration_ceiling

    chosen = _resolve_project_resolution(proj)
    model_id = _resolve_project_video_model(proj) or ""
    prov = registry.get_video(model_id) if model_id else None
    supported = getattr(prov, "supported_resolutions", None) if prov else None
    mp = RESOLUTION_TIERS.get((chosen or "").lower())
    #: 本模型实际按哪一档出片。None = 该模型不按档位下发（如 RunningHub 按 MP 算像素）
    effective = prov.resolution_for(mp) if (prov is not None and mp) else None
    if effective is None and prov is None:
        # 拿不到模型（未配置/未知 id）：别撒谎说"实际=所选"
        effective = None
    return {
        "resolution": chosen,
        #: 该模型真正吃得下的档位。None = 未声明 = 不限制（前端不灰显任何档）
        "supported": supported,
        "effective": effective,
        #: 选了、但实际不按它出片（seedance 的 2k、低价渠道的一切非 720p）
        "pending": bool(chosen) and effective is not None
                   and effective != chosen.lower(),
        "model_id": model_id,
        #: 单镜时长上限随档位变（H3 是按 MP 反推的）。面板上要显示这句，
        #: 否则用户把 480p 调成 1080p 后，时间轴上能设的时长上限突然变短，
        #: 会以为是 bug。
        "shot_duration_max": shot_duration_ceiling(proj),
    }


@router.get("/projects/{project_id}/resolution")
def get_project_resolution(project_id: str) -> dict:
    """项目分辨率现状 + 可选档位 + 该档在本模型下的实际结果。"""
    from ..shot_timing import RESOLUTION_TIERS
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        rep = _resolution_report(proj)
    return {**rep, "tiers": list(RESOLUTION_TIERS.keys())}


@router.put("/projects/{project_id}/resolution")
@access.requires(access.ROLE_MANAGER)
def put_project_resolution(project_id: str, body: ProjectResolutionIn) -> dict:
    """改项目分辨率档位（此后**新生成**的镜头按新档出片）。

    ⚠️ **不会重出任何已生成的视频**：它是下发参数，不是后期处理。
    要让成片变清晰只能重新生成那几镜（另外「交付」页的高清放大是另一条路：
    对已有成片做超分，不重跑模型）。这句话前端必须写在面板上。

    ⚠️ 只改 `default_profile.resolution` 这一个键，其余键（video_model /
    image_model / generation_mode / subtitle_style）原样读回再写出——
    整份覆盖会把它们一起抹掉。与 subtitle-style 端点同款写法与同款注意
    （那一列声明成 String(64)，SQLite 不校验长度，换 DB 前要先改 Text）。
    """
    from ..shot_timing import RESOLUTION_TIERS
    val = (body.resolution or "").strip().lower()
    if val and val not in RESOLUTION_TIERS:
        raise HTTPException(
            status_code=422,
            detail=f"不支持的分辨率档位 {body.resolution!r}；"
                   f"可选: {', '.join(RESOLUTION_TIERS)}")
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        prof = dict(profile_of(proj))
        if val:
            prof["resolution"] = val
        else:
            prof.pop("resolution", None)      # 清除 = 回到平台默认
        proj.default_profile = json.dumps(prof, ensure_ascii=False) if prof else None
        session.commit()
        rep = _resolution_report(proj)
    logger.info("[project %s] 分辨率档位改为 %r（实际按 %r 出片）",
                project_id, val or None, rep.get("effective"))
    return {"ok": True, **rep, "tiers": list(RESOLUTION_TIERS.keys())}


# ---------- 项目：按类别选择生图模型（2026-10-21） ----------
class ImageModelByKindIn(BaseModel):
    #: character / location / prop → 模型 id；空串或 null = 跟随项目设置。
    #: **未出现在本次请求里的键保持原样**（与 PATCH 的语义一致）——
    #: 前端三个下拉分别保存时不能把另外两个重置掉。
    models: dict[str, Optional[str]] = Field(default_factory=dict)


def _image_model_report(proj) -> dict:
    """当前三类的实际生效模型 + 可选清单。

    抽成函数：GET 与 PUT 要回同一份口径。各写一遍必然漂移
    （本仓为"两套算法"付过学费，见 @图片N 那轮）。

    `effective` 是**实际会用的**，`by_kind` 是用户显式配的（空 = 跟随项目）。
    两者分开给：前端要把「跟随项目（GPT Image 2）」和「就是这个模型」区分开，
    否则用户不知道那一档到底是不是自己选的。
    """
    from ..jobs import ASSET_KINDS, asset_image_models, _resolve_project_gen_settings
    from ..providers.image import IMAGE_MODELS

    by_kind = asset_image_models(proj)
    proj_model = _resolve_project_gen_settings(proj)[1]
    return {
        "by_kind": by_kind,
        "project_model": proj_model,
        "effective": {k: (by_kind.get(k) or proj_model) for k in ASSET_KINDS},
        # 只上生图页的模型（Midjourney：不接参考图、接不住"同一张脸"）不给资产选
        "models": [m for m in IMAGE_MODELS if not m.get("image_page_only")],
    }


@router.get("/projects/{project_id}/image-model")
def get_project_image_model(project_id: str) -> dict:
    """本项目的生图模型现状：三类各自实际用哪个、可选哪些。"""
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        return _image_model_report(proj)


@router.put("/projects/{project_id}/image-model")
@access.requires(access.ROLE_MANAGER)
def put_project_image_model(project_id: str, body: ImageModelByKindIn) -> dict:
    """按类别设置本项目后续资产（角色 / 场景 / 道具）的生图模型。

    ## 为什么按类别而不是一刀切

    三类的出图需求本来就不同：角色要脸稳定、场景要大空间、道具要材质特写。
    此前只有一个全局 `image_model`，用户只能二选一，再靠导出去别的工具补救。

    ## 语义

    · 传模型 id → 该类用它；
    · 传空串 / null → **清除类别设置**，跟随项目（`default_profile.image_model`）；
    · 请求里没出现的键 → 保持原样。

    ⚠️ 只影响**此后新生成**的图，已生成的一张都不动（与分辨率端点同口径）。
    ⚠️ 存在既有 JSON 列 `default_profile.image_model_by_kind`，**不加列、不用迁移**。
    只改这一个键，其余键原样读回再写出——整份覆盖会把 video_model /
    resolution / subtitle_style 一起抹掉。
    """
    from ..jobs import ASSET_KINDS

    bad = [k for k in body.models if k not in ASSET_KINDS]
    if bad:
        raise HTTPException(
            status_code=422,
            detail=f"不支持的资产类别 {', '.join(bad)}；"
                   f"可选: {', '.join(ASSET_KINDS)}")
    # 模型 id 必须真实存在：接受任意字符串会让用户以为换了、实际
    # ImageProvider 静默回落到 gpt-image-2（见它的构造函数）。
    from ..providers.image import IMAGE_MODELS
    known = {m["id"] for m in IMAGE_MODELS if not m.get("image_page_only")}
    for k, v in body.models.items():
        v = (v or "").strip()
        if v and v not in known:
            raise HTTPException(
                status_code=422,
                detail=f"未知的生图模型 {v!r}；可选: {', '.join(sorted(known))}")

    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        prof = dict(profile_of(proj))
        cur = prof.get("image_model_by_kind")
        cur = dict(cur) if isinstance(cur, dict) else {}
        for k, v in body.models.items():
            v = (v or "").strip()
            if v:
                cur[k] = v
            else:
                cur.pop(k, None)      # 清除 = 跟随项目
        # 只留合法类别、去掉空值，避免 JSON 里堆一堆无效键
        cur = {k: v for k, v in cur.items() if k in ASSET_KINDS and v}
        if cur:
            prof["image_model_by_kind"] = cur
        else:
            prof.pop("image_model_by_kind", None)
        proj.default_profile = json.dumps(prof, ensure_ascii=False) if prof else None
        session.commit()
        rep = _image_model_report(proj)
    logger.info("[project %s] 生图模型按类别改为 %r（实际 %r）",
                project_id, rep["by_kind"], rep["effective"])
    return {"ok": True, **rep}


# ---------- 项目：改名 / 回收站 / 彻底删除 ----------
class ProjectPatch(BaseModel):
    title: str


@router.patch("/projects/{project_id}")
@access.requires(access.ROLE_MANAGER)
def rename_project(project_id: str, body: ProjectPatch) -> dict:
    """重命名项目。

    ⚠️ `title` 不只是展示用：`jobs.py` 会把它作为片名传进生成提示词
    （`scene_prompt(..., title=title, ...)`）。所以改名会影响**此后**新生成
    的图与视频的语境，已生成的内容不受影响。前端改名框必须把这句写给用户看。

    除此之外 title 没有连接键作用（与角色/场景资产改名不同，那边改名要迁移
    引用），所以这里只做一次 UPDATE。
    """
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(status_code=422, detail="项目名不能为空")
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        proj.title = title[:255]
        session.commit()
        return {"ok": True, "id": project_id, "title": proj.title}


@router.delete("/projects/{project_id}")
@access.requires(access.ROLE_OWNER)
def delete_project(project_id: str, purge: bool = False) -> dict:
    """删除项目。默认是**打墓碑进回收站**，数据与文件一个不动。

    `purge=true` 才真删库行 + 清该项目独占的磁盘文件，且**前置要求项目已在
    回收站**——不提供"一步删干净"的入口是刻意的：不可逆操作至少要隔一次
    页面切换，光靠一个确认框挡不住手快。

    ⚠️ **要 `owner` 档，管理者也不行**（2026-10-16 协作裁定）。收回站与彻底
    删除都算删除：purge 会连磁盘文件一起清掉，是这个系统里唯一不可逆的操作，
    交给"被邀请来协作的人"太远了。协作者要删项目，得让所有者自己来。
    """
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        if not purge:
            if not proj.deleted_at:
                proj.deleted_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
                session.commit()
            return {"ok": True, "mode": "trashed", "deleted_at": proj.deleted_at}
        if not proj.deleted_at:
            raise HTTPException(status_code=409, detail="请先移入回收站，再执行彻底删除")
        result = project_purge.purge(session, project_id)
        logger.info("[project] 彻底删除 %s: %s", project_id, result)
        return {"ok": True, "mode": "purged", **result}


@router.post("/projects/{project_id}/restore")
@access.requires(access.ROLE_MANAGER)
def restore_project(project_id: str) -> dict:
    """从回收站恢复。墓碑期间数据与文件全在，所以恢复就是清掉时间戳。"""
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        proj.deleted_at = None
        session.commit()
        return {"ok": True, "id": project_id}


@router.get("/projects/{project_id}/purge-preview")
def purge_preview(project_id: str) -> dict:
    """彻底删除会删掉什么（只算不删），给确认框填具体数字。

    没有这个预览的话，确认框只能写"此操作不可恢复"这种空话；有了它用户能看到
    "12 个文件 / 3.4 GB"，才判断得出自己是不是删错了项目。
    """
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        return project_purge.preview(session, project_id)


# ---------- 剧本导入：分集解析（T-R0-02，契约 C2）----------
class ScriptImportIn(BaseModel):
    text: str
    project_id: Optional[str] = None
    confirm: bool = False  # False=仅解析预览；True=落库


class EpisodeOut(BaseModel):
    order: int
    title: str
    word_count: int
    preview: str  # 前 120 字


@router.post("/script/import")
def script_import(body: ScriptImportIn) -> dict:
    """解析剧本分集（第N集/章/话/回 + 分隔线 + 长度兜底）。

    confirm=False 仅返回预览；confirm=True 且带 project_id 时落库
    （episodes 存 JSON 元信息，raw_script 存全文）。
    """
    return _do_script_import(body.text, body.project_id, body.confirm)


@router.post("/script/import-file")
async def script_import_file(
    file: UploadFile = File(...),
    project_id: Optional[str] = Form(None),
    confirm: bool = Form(False),
) -> dict:
    """文件版剧本导入：支持 txt/md/docx/pdf（.doc 提示转存）。解析为文本后与文本版同流程。"""
    from ..script_files import parse_script_file
    content = await file.read()
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="文件超过 50MB 上限")
    try:
        text = parse_script_file(file.filename or "unknown", content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not text.strip():
        raise HTTPException(status_code=400, detail="文件中未提取到文字内容")
    return _do_script_import(text, project_id, confirm)


def _do_script_import(text: str, project_id: Optional[str], confirm: bool) -> dict:
    """导入共用核心：分集解析 →（可选）落库 → 返回预览。"""
    # 归属校验（2026-10-09）**必须在这里显式做**：`script/import-file` 是
    # multipart，中间件不解析 multipart 表单。`script/import`（JSON）其实已被
    # 中间件拦过，这里再查一次无害，且两条路由汇到本函数，守一处即覆盖两者。
    # 放在解析**之前**：不是你的项目就不该替你跑一遍分集（即使不落库）。
    if project_id:
        with get_session() as session:
            access.require_project_access(session, project_id)
    chapters = smart_split_chapters(text)
    if not chapters:
        raise HTTPException(status_code=400, detail="剧本内容为空")

    if confirm and project_id:
        with get_session() as session:
            proj = session.get(Project, project_id)
            if not proj:
                raise HTTPException(status_code=404, detail="project not found")
            proj.raw_script = text
            proj.episodes = json.dumps(
                [{"order": c["order"], "title": c["title"],
                  "word_count": c["word_count"]} for c in chapters],
                ensure_ascii=False,
            )
            session.commit()

    return {
        "episodes": [
            EpisodeOut(order=c["order"], title=c["title"],
                       word_count=c["word_count"],
                       preview=c["content"][:120]).model_dump()
            for c in chapters
        ],
        "saved": bool(confirm and project_id),
        # 文件导入时前端需要拿解析出的文本用于确认后落库
        "text": text,
    }


# ---------- 按集编辑剧本（剧本页直接编辑；改动即把该集镜头标 stale）----------
class EpisodeContentIn(BaseModel):
    content: str


@router.get("/projects/{project_id}/episodes/content")
def episodes_content(project_id: str) -> dict:
    """按集返回剧本正文（剧本页每集一个文本框）。"""
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        raw = proj.raw_script or ""
    chapters = smart_split_chapters(raw) if raw else []
    return {"episodes": [
        {"order": c["order"], "title": c["title"], "content": c["content"]}
        for c in chapters
    ]}


@router.put("/projects/{project_id}/episodes/{order}/content")
def update_episode_content(project_id: str, order: int, body: EpisodeContentIn) -> dict:
    """更新某一集正文：重组 raw_script 落库，并把该集已有镜头标记 stale（过期）。"""
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        raw = proj.raw_script or ""
        chapters = smart_split_chapters(raw) if raw else []
        target = next((c for c in chapters if c["order"] == order), None)
        if target is None:
            raise HTTPException(status_code=404, detail=f"第 {order} 集不存在")
        target["content"] = body.content.strip()
        # 重组全文（标题行 + 正文），保持 smart_split_chapters 可再解析
        proj.raw_script = "\n".join(f"{c['title']}\n{c['content']}" for c in chapters)
        proj.episodes = json.dumps(
            [{"order": c["order"], "title": c["title"],
              "word_count": len(c["content"])} for c in chapters],
            ensure_ascii=False)
        # 该集镜头标过期（不删：旧拆解仍可看，重拆时才替换）
        # 原因 rebreak = 严重度最高，批量直写不会覆盖掉更严重的原因（没有更严重的）。
        n = (session.query(Shot)
             .filter(Shot.project_id == project_id, Shot.episode == order)
             .update({"stale": 1, "stale_reason": stale_mod.REBREAK}))
        session.commit()
        return {"ok": True, "stale_shots": n}
