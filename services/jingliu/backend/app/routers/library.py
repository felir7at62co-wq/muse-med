"""共享资产库（全平台）与项目归属管理。

`GET  /v2/library`             —— 浏览共享资产库（按 kind+name 归并）
`POST /v2/library/import`      —— 把库里的资产复制进自己的项目
`PUT  /v2/library/visibility`  —— 把自己的资产设为公开 / 隐私
`PUT  /v2/projects/{pid}/owner`—— （仅管理员）把项目转给某个用户

## 用户裁定（2026-10-09）

  · 资产库**全平台所有用户共享**；
  · 用户可以给**自己的**资产设为隐私或公开，**默认公开**；
  · 同名归并：同一个名字只展示一条（库里 1495 个角色行只有 728 个名字，
    「林晨」在 18 个项目里各一行，不归并就满屏重名）。

## "我的资产"怎么定义

资产没有自己的归属列 —— 它挂在项目下，**项目的主人就是资产的主人**
（`Project.owner_id`）。不另开 `Asset.owner_id`：那会出现"资产归 A、
它所在的项目归 B"这种两个事实互相打架的状态，而且项目转交时要同步改
几千行资产。由项目派生则永远一致。

## 隐私挡到什么程度（用户裁定：列表层面）

隐私资产**不出现在别人的资产库里、也不能被别人导入**。但图片文件本身仍走
公开的 `/media`（`<img src>` 发不出鉴权头，见 main.py `_OPEN_TREES`）——
知道 URL 的人仍能取到图。本模块因此**绝不**把别人隐私资产的 URL 放进响应：
不出现在列表里，URL 就无从得知（文件名是 48 位随机 hex，不可枚举）。

## 别人的项目名不外露

列表里每条资产只告诉你"是不是你的"和"有几个项目在用"，**不**给别人的
项目标题/id：项目归属刚收紧，资产库不能变成"顺着资产名反查别人在做什么项目"
的侧门。自己的资产照常给出项目名，方便认出是哪个片子里的。
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, func, literal, or_, select, tuple_

from .. import access
from ..db import Asset, AssetStage, Project, desc_of, get_session

router = APIRouter(prefix="/v2", tags=["library"])

#: 能进资产库的种类。`custom` 是时间轴拖进来的杂项素材，不是"可复用的设定"。
_LIB_KINDS = ("character", "location", "prop")
_VISIBILITY = ("public", "private")


def _is_public(a: Asset) -> bool:
    # NULL = 没设过 = 公开（见 db.Asset.visibility 的注释：存量 4276 行全是 NULL，
    # 把 NULL 当私有的话，共享库一上线就是空的）
    return (a.visibility or "public") == "public"


def _stage_images(session, project_ids: set[str]) -> dict[tuple[str, str], str]:
    """(project_id, 角色名) → 该角色**最早一套**造型的图。

    ⚠️ 必须查造型层：角色的图大多只存在于 `AssetStage`（dev 库 1415 个角色里
    只有 182 个在资产层有图，另有 405 个的图只在造型上）。只看 `Asset.image_url`
    的话，资产库里绝大多数角色都是"未生成"的空卡 —— 那会让用户以为库是空的。
    取 ep_from 最小的那套：第一集的造型最能代表"这个角色长什么样"。
    """
    out: dict[tuple[str, str], tuple[int, str]] = {}
    if not project_ids:
        return {}
    rows = (session.query(AssetStage.project_id, AssetStage.character_name,
                          AssetStage.ep_from, AssetStage.image_url)
            .filter(AssetStage.project_id.in_(project_ids),
                    AssetStage.image_url.isnot(None),
                    AssetStage.deleted_at.is_(None)).all())
    for pid, cname, ep, url in rows:
        if not url:
            continue
        k = (pid, cname)
        if k not in out or (ep or 0) < out[k][0]:
            out[k] = (ep or 0, url)
    return {k: v[1] for k, v in out.items()}


def _visible_rows(session, *, kind: Optional[str]):
    """⛔ **已废弃，当前没有任何调用点。** 保留仅为记录 2026-10-24 的事故成因。

    它原先在**每次**打开资产库时 `query(Asset, Project)`，把两张表的全部列
    实例化成 ORM 对象。dev 库 7923 行实测 **1663 ms** —— 只为读一个 `name`
    和 `visibility`，却把 `brief_json` / `profile_json` / `prompt` 这些大文本
    全读进内存。生产库大五倍，单次请求 8~10 秒，而前端轮询让这类请求**并发
    24 个**，直接把 AnyIO 线程池（40 个槽）和 SQLAlchemy 连接池（20+30）
    一起占满，其他所有接口——连 `/v2/auth/me`——都排在后面。这就是 2026-10-24
    那次全站卡死。

    现在的实现是「SQL 侧 GROUP BY + HAVING + ORDER BY + LIMIT/OFFSET」，
    见 `_group_query` / `_page_groups` / `_rows_for_groups`。新代码**不要**
    回头用这个函数：它做的正是那件被换掉的事。

    ## 口径（供对照，改造后必须逐字保持）

    看得见 =（公开 或 我的）且 资产未删 且 所在项目未进回收站；
    **管理员看得见全部，含别人的隐私资产。**
    """
    uid = access.current_user_id()
    admin = access.is_admin()
    q = (session.query(*_LIB_COLS)
         .join(Project, Project.id == Asset.project_id)
         .filter(Asset.deleted_at.is_(None), Project.deleted_at.is_(None),
                 Asset.kind.in_(_LIB_KINDS)))
    if kind:
        q = q.filter(Asset.kind == kind)
    out = []
    for r in q.all():
        owner_id = r[7]
        mine = uid is not None and owner_id is not None and int(owner_id) == uid
        if admin or mine or (r[5] or "public") == "public":
            out.append(_LibRow(r, mine))
    return out


#: `_visible_rows` / `_rows_for_groups` 取的列，顺序被 `_LibRow` 按位解读。
#: **改这个列表要同步改 `_LibRow` 的索引**。
#:
#: 带上了 `desc_auto` / `prompt`：选"代表行"（`desc_of`）和响应里的 `prompt`
#: 字段都要它们。实测这两列**几乎不增加开销**（7923 行：9 列 39 ms / 11 列 26 ms，
#: 差异在噪声内）—— 真正贵的是 ORM 实例化本身，以及 `brief_json`/`profile_json`
#: 这类整段 JSON，所以那两个仍然不取。
_LIB_COLS = (
    Asset.id,            # 0
    Asset.project_id,    # 1
    Asset.kind,          # 2
    Asset.name,          # 3
    Asset.image_url,     # 4
    Asset.visibility,    # 5
    Asset.created_at,    # 6
    Project.owner_id,    # 7
    Project.title,       # 8
    Asset.desc_auto,     # 9
    Asset.prompt,        # 10
)


class _LibRow:
    """`_visible_rows` 的行包装：只带资产库里用得到的字段。

    刻意做成轻量对象而不是 ORM 实例 —— 见 `_visible_rows` 的说明。
    字段名保持与 `Asset` 一致，`desc_of()` 这类读 `desc_auto`/`prompt` 的工具
    函数可以直接吃它。
    """

    __slots__ = ("id", "project_id", "kind", "name", "image_url",
                 "visibility", "created_at", "project_title", "is_mine",
                 "desc_auto", "prompt")

    def __init__(self, r, is_mine: bool) -> None:
        (self.id, self.project_id, self.kind, self.name, self.image_url,
         self.visibility, self.created_at, _owner, self.project_title,
         self.desc_auto, self.prompt) = r
        self.is_mine = is_mine

    @property
    def project(self):
        """兼容旧写法 `p.title` —— 只给标题（别人的项目名不外露，见模块头）。"""
        return _LibProject(self.project_title)


class _LibProject:
    """`_LibRow.project` 的最小替身：只暴露 `title`。"""

    __slots__ = ("title",)

    def __init__(self, title) -> None:
        self.title = title


def _group_query(uid, admin, *, kind, needle, with_image, scope):
    """资产库分组的**基础查询**：只出 (kind, name) 这一层的聚合。

    返回 `(base_sel, having)`：
      · `base_sel` 是已带 GROUP BY 的 select，列依次为
        kind / name / uses / mine_rows / my_private / my_public / first_at；
      · `having` 是整组级判定（范围 + 搜索 + 有图），拼在 GROUP BY 之后。

    ⚠️ 范围判定**必须在 HAVING 里**，不能在建组前筛行 —— 见 `_SCOPES`
    的注释：同一个「林晨」可能"我的私密 + 别人的公开"，先筛行会让整组
    只剩下别人的行，用户就找不到自己那张了。
    """
    mine_flag = case(
        (Asset.project_id.in_(
            select(Project.id).where(Project.owner_id == uid)), 1)
        if uid is not None else (literal(False), 1),
        else_=0)
    # 可见性：管理员看全部；其他人只看公开（含 NULL）或自己项目的
    visible = [or_(Asset.visibility.is_(None), Asset.visibility == "public")]
    if uid is not None:
        visible.append(Project.owner_id == uid)
    cond = [Asset.deleted_at.is_(None), Project.deleted_at.is_(None),
            Asset.kind.in_(_LIB_KINDS)]
    if kind:
        cond.append(Asset.kind == kind)
    if not admin:
        cond.append(or_(*visible))
    if needle:
        cond.append(Asset.name.contains(needle))

    my_rows = func.sum(mine_flag)
    my_private = func.sum(case(
        (and_(mine_flag == 1,
              func.coalesce(Asset.visibility, "public") != "public"), 1),
        else_=0))
    my_public = func.sum(case(
        (and_(mine_flag == 1,
              func.coalesce(Asset.visibility, "public") == "public"), 1),
        else_=0))

    # ---- `with_image` 是**行级**条件，必须进 WHERE ----
    #
    # ⚠️ 2026-10-24 踩过的坑：把它写成 HAVING 里的裸列引用，SQLite 在
    # GROUP BY 下不报错、只从组里**随便取一行**（实际是首行）来比，
    # 于是"整组任一行有图"退化成"首行有图"，1966 组凭空少掉 486 组。
    # 而且它在原实现里是 `if with_image and not img: continue`——**建组之前**
    # 就把行丢了，所以 `uses` / `my_asset_ids` / 可见性全都只数有图的行。
    # 放 HAVING 只能筛组，数不回这些聚合值。只有 WHERE 才语义等价。
    stage_has_img = None
    if with_image:
        # "有图"= 资产自己那张，或者角色在造型层有图。造型侧用 DISTINCT 派生表
        # 左连：`(project_id, character_name)` 去重后每个资产行最多连上一条，
        # 不会像直接 join `AssetStage` 那样把 count(*) 变成造型套数。
        stage_has_img = (
            select(AssetStage.project_id.label("sid"),
                   AssetStage.character_name.label("sname"))
            .where(AssetStage.image_url.isnot(None), AssetStage.image_url != "",
                   AssetStage.deleted_at.is_(None))
            .distinct().subquery())
        cond.append(or_(
            and_(Asset.image_url.isnot(None), Asset.image_url != ""),
            and_(Asset.kind == "character", stage_has_img.c.sid.isnot(None))))

    sel = (select(Asset.kind, Asset.name,
                  func.count().label("uses"),
                  my_rows.label("mine_rows"),
                  my_private.label("my_private"),
                  my_public.label("my_public"),
                  func.min(Asset.created_at).label("first_at"))
           .join(Project, Project.id == Asset.project_id))
    if stage_has_img is not None:
        sel = sel.outerjoin(
            stage_has_img,
            and_(stage_has_img.c.sid == Asset.project_id,
                 stage_has_img.c.sname == Asset.name))
    sel = sel.where(*cond).group_by(Asset.kind, Asset.name)

    having = []
    if scope == "mine":
        having.append(my_rows > 0)
    elif scope == "mine_private":
        having.append(my_private > 0)
    elif scope == "mine_public":
        having.append(my_public > 0)
    elif scope == "others":
        having.append(my_rows == 0)
    return sel, having


def _page_groups(session, *, kind, needle, with_image, scope, sort,
                 limit: int, offset: int, uid, admin):
    """算出**当前页**的组和总数。返回 `(total, [(kind, name), ...])`。

    总数用同一套条件下单独 count，避免把全部组取回 Python 才知道有几条
    （前端要显示"共 N 个有图的要素"）。
    """
    sel, having = _group_query(uid, admin, kind=kind, needle=needle,
                               with_image=with_image, scope=scope)
    if having:
        sel = sel.having(*having)
    # 总数
    sub = sel.subquery()
    total = session.execute(select(func.count()).select_from(sub)).scalar() or 0
    if not total:
        return 0, []
    # 排序：与 Python 侧口径一一对应
    mine_first = (sub.c.mine_rows > 0)
    if sort in ("newest", "oldest"):
        # created_at 是 ISO 字符串可字典序比较；NULL 一律排最后
        order = [sub.c.first_at.is_(None)]
        order.append((sub.c.first_at.desc() if sort == "newest"
                      else sub.c.first_at.asc()))
        order.append(sub.c.name)
    elif sort == "uses":
        order = [sub.c.uses.desc(), sub.c.name]
    elif sort == "least_used":
        order = [sub.c.uses.asc(), sub.c.name]
    else:
        order = [mine_first.desc(), sub.c.uses.desc(), sub.c.name]
    page = session.execute(
        select(sub.c.kind, sub.c.name).order_by(*order)
        .limit(limit).offset(offset)).all()
    return total, [(r[0], r[1]) for r in page]


def _rows_for_groups(session, keys: list[tuple[str, str]]):
    """取这些组（kind, name）下的**全部成员行**。

    只有当前页的组会进来（约 120 组、平均 1.8 行/组），不再是全表。

    ## 可见性口径（与改造前逐字一致）

    看得见 =（公开 或 我的）且 资产未删 且 所在项目未进回收站；
    **管理员看得见全部，含别人的隐私资产** —— 与"管理员本来就能打开所有项目、
    看到同一批资产"一致，库里藏起来没有意义。

    ⚠️ 2026-10-24 回归：重写时这里曾写成"管理员再补筛一次隐私行、非本人且
    非公开就跳过"，方向正好反了。后果是管理员看不到别人的隐私资产，而
    `_group_query` 的计数（管理员分支不过滤）却把它们算进去了 —— 同一个响应里
    `uses` 与 `rows` 自相矛盾。**非管理员已在上面 SQL 里筛过，这里不能再筛一次。**
    """
    if not keys:
        return []
    uid = access.current_user_id()
    admin = access.is_admin()
    q = (session.query(*_LIB_COLS)
         .join(Project, Project.id == Asset.project_id)
         .filter(Asset.deleted_at.is_(None), Project.deleted_at.is_(None),
                 tuple_(Asset.kind, Asset.name).in_(keys)))
    if not admin:
        visible = [or_(Asset.visibility.is_(None), Asset.visibility == "public")]
        if uid is not None:
            visible.append(Project.owner_id == uid)
        q = q.filter(or_(*visible))
    out = []
    for r in q.all():
        owner_id = r[7]
        mine = uid is not None and owner_id is not None and int(owner_id) == uid
        out.append(_LibRow(r, mine))
    return out


#: 资产库的筛选范围（2026-10-22 用户需求：私人的与其他人的公开能分开）。
#:
#: 归并是**按名字**做的，而可见性挂在**每一行**上（同一个「林晨」在 18 个项目里
#: 各一行，各有各的 visibility）。所以范围必须在**归并之后**按整组判定，
#: 不能在建组之前把行筛掉——那样"我的私密 + 别人的公开"同名时，组里只剩
#: 别人的行，卡片会显示成"别人的资产"，用户就找不到自己那张了。
_SCOPES = ("all", "mine", "mine_private", "mine_public", "others")

#: 排序方式。`newest/oldest` 按建组时间（组内最早一条），`uses` 按项目数。
_SORTS = ("default", "newest", "oldest", "uses", "least_used")


from ..muse_references import shared_page


@router.get("/library")
def list_library(kind: Optional[str] = None, q: Optional[str] = None,
                 mine: bool = False, with_image: bool = True,
                 scope: str = "all", sort: str = "default", limit: int = 120, offset: int = 0,
                 importable_only: bool = False) -> dict:
    return shared_page(_native_library, kind=kind, q=q, mine=mine, with_image=with_image, scope=scope,
                       sort=sort, limit=limit, offset=offset, importable_only=importable_only)


def _native_library(kind: Optional[str] = None, q: Optional[str] = None,
                 mine: bool = False, with_image: bool = True,
                 scope: str = "all", sort: str = "default",
                 limit: int = 120, offset: int = 0) -> dict:
    """浏览共享资产库，按 (kind, name) 归并。

    `with_image=true`（默认）只列有图的：没图的资产在库里没有复用价值
    （复用的就是那张图），列出来只是一屏"未生成"占位。

    ## `scope`（2026-10-22）
    用户要把"自己的"和"其他人公开的"分开看。取值见 `_SCOPES`：
      · `all`          全部（默认，与改动前一致）
      · `mine`         我名下有这个资产的组（公开+私密都算）
      · `mine_private` 我设成隐私的那几组
      · `mine_public`  我设成公开的那几组
      · `others`       我名下**没有**、纯别人的组（管理员视角下含别人的隐私，
                       与"管理员本来就能看到所有项目"的既有口径一致）
    兼容旧的 `mine=true`（等价 `scope=mine`）：别处还有调用点在传它。

    ## `uses`
    **每参与一个项目算一次**，不是每生成一个镜头算一次 —— 归并的单位就是
    (kind, name) 在**每个项目**里的那一行，所以 `len(rs)` 天然就是这个口径。
    """
    if kind and kind not in _LIB_KINDS:
        raise HTTPException(400, f"kind 只能是 {', '.join(_LIB_KINDS)}")
    scope = (scope or "all").strip().lower()
    if mine and scope == "all":
        scope = "mine"          # 旧参数向后兼容
    if scope not in _SCOPES:
        raise HTTPException(400, f"scope 只能是 {', '.join(_SCOPES)}")
    sort = (sort or "default").strip().lower()
    if sort not in _SORTS:
        raise HTTPException(400, f"sort 只能是 {', '.join(_SORTS)}")
    limit = max(1, min(int(limit or 120), 500))
    offset = max(0, int(offset or 0))
    needle = (q or "").strip()
    with get_session() as session:
        # ---- 2026-10-24：把"分组 + 可见性 + 范围 + 搜索 + 排序 + 分页"
        # 全部下推到 SQL，只在最后取**当前页**那 120 个组。
        #
        # 改之前：`_visible_rows` 取全表 7923 行 → Python 分组 1966 组 →
        # 全量排序 → 最后才 `items[offset:offset+limit]`。也就是说**每次翻页
        # 都在做全量工作**，`limit/offset` 只影响了切片的最后一行代码。
        # 生产库比 dev 大五倍，加上前端轮询，24 个并发请求同时跑这段，
        # AnyIO 线程池（40 槽）和连接池（20+30）一起被占满 —— 全站卡死。
        #
        # 现在：SQL 侧 GROUP BY 出组（实测 10.7 ms），HAVING 做整组级判定，
        # ORDER BY + LIMIT/OFFSET 只回当前页。**语义完全等价**，见下面的
        # 对拍说明。
        total, page_groups = _page_groups(
            session, kind=kind, needle=needle, with_image=with_image,
            scope=scope, sort=sort, limit=limit, offset=offset,
            uid=access.current_user_id(), admin=access.is_admin())
        if not page_groups:
            return {"total": total, "items": []}
        # 取当前页这些组（kind, name）的**全部行** —— 只有组内成员进来，
        # 不再是全表。组平均 1.8 行，120 组约 220 行。
        rows = _rows_for_groups(session, page_groups)
        stage_img = _stage_images(
            session, {r.project_id for r in rows if r.kind == "character"})

        groups: dict[tuple[str, str], dict] = {}
        for a in rows:
            p, is_mine = a.project, a.is_mine
            if needle and needle not in a.name:
                continue
            if mine and not is_mine:
                continue
            img = a.image_url or (stage_img.get((a.project_id, a.name))
                                  if a.kind == "character" else None)
            if with_image and not img:
                continue
            key = (a.kind, a.name)
            g = groups.setdefault(key, {"kind": a.kind, "name": a.name,
                                        "rows": []})
            g["rows"].append((a, p, is_mine, img))

        items = []
        for g in groups.values():
            rs = g["rows"]
            # 代表行：我的优先（用户最可能想认出自己做过的那张），
            # 其次有描述的（导入后能直接用），最后按 id 稳定排序。
            rs.sort(key=lambda r: (not r[2], not desc_of(r[0]), r[0].id))
            rep, rep_p, rep_mine, rep_img = rs[0]
            my_rows = [r for r in rs if r[2]]
            # ---- 范围判定（按整组，见 _SCOPES 的注释）----
            has_mine = bool(my_rows)
            my_private = any(not _is_public(r[0]) for r in my_rows)
            my_public = any(_is_public(r[0]) for r in my_rows)
            if scope == "mine" and not has_mine:
                continue
            if scope == "mine_private" and not my_private:
                continue
            if scope == "mine_public" and not my_public:
                continue
            if scope == "others" and has_mine:
                continue
            # ---- 建组时间：组内最早那条（"这个东西第一次在平台里出现"）----
            # 存量行的 created_at 是 NULL（迁移刻意不回填，见 db.Asset.created_at），
            # 这里**不编造**：全部为 NULL 时给 None，前端把 None 排到最后。
            stamps = sorted(r[0].created_at for r in rs if r[0].created_at)
            items.append({
                "kind": g["kind"],
                "name": g["name"],
                "asset_id": rep.id,
                "image_url": rep_img,
                # 描述（供卡片显示 / 导入后直接用）。用户终稿 `prompt` 不对外：
                # 它整段都带着本项目的画风与影调，原样搬到别人项目里是错的。
                "prompt": desc_of(rep),
                "mine": rep_mine,
                # 只给"我的"那几行的 id：设隐私是对**我名下所有同名资产**生效
                "my_asset_ids": [r[0].id for r in my_rows],
                # 我的同名资产里只要有一条公开，整组就按"公开"显示
                "visibility": ("public" if my_public else "private") if has_mine else "public",
                # 「每参与一个项目算一次」：一行 = 一个项目里的一个同名资产
                "uses": len(rs),
                "created_at": stamps[0] if stamps else None,
                # 别人的项目名不外露，见模块头
                "my_projects": sorted({r[1].title for r in my_rows}),
            })
        # ---- 排序 ----
        # 任何排序都要保留"我的在前"这个默认倾向？不：用户点了「按使用次数」，
        # 他要的就是全局第一名，而不是"我的里面第一"。所以只有 default 才把
        # mine 放第一位；显式排序一律全局比。
        #
        # 时间排序用**多趟稳定排序**而不是取反/取负：`created_at` 是 ISO 字符串，
        # 没有干净的"反向字符串"（逐字符取反不是 ASCII，且长度一变就乱）。
        # 三趟分别是「名字 → 时间（倒/正）→ 空值排最后」，最后一趟是布尔排序，
        # False（有时间）在前、True（NULL）在后，正是要的顺序。
        if sort in ("newest", "oldest"):
            items.sort(key=lambda x: x["name"])
            items.sort(key=lambda x: x["created_at"] or "",
                       reverse=(sort == "newest"))
            items.sort(key=lambda x: x["created_at"] is None)
        elif sort == "uses":
            items.sort(key=lambda x: (-x["uses"], x["name"]))
        elif sort == "least_used":
            items.sort(key=lambda x: (x["uses"], x["name"]))
        else:
            items.sort(key=lambda x: (not x["mine"], -x["uses"], x["name"]))
        # `total` 来自 SQL 的组计数（全量），**不是**本页条数 —— 前端拿它显示
        # "共 N 个有图的要素"。items 已经在 SQL 侧切好页，这里不再切片。
        return {"total": total, "items": items}


class LibraryImportIn(BaseModel):
    project_id: str
    asset_ids: list[str] = Field(default_factory=list)


@router.post("/library/import")
def import_from_library(body: LibraryImportIn) -> dict:
    """把库里的资产**复制**成目标项目的新资产行（名字、描述、那张图）。

    目标项目的归属由中间件按请求体的 project_id 校验过了；这里校验的是
    **来源**：每一条都必须是调用者在库里看得见的（公开 / 我的 / 我是管理员）。
    别人的隐私资产一律当"不存在"（404），与 access 模块头 ① 口径一致。

    只复制图片地址、不复制文件；`project_purge.url_owners` 会认出"两个项目
    都在用这张图"从而在来源项目清盘时保留它。造型阶段与项目级设置不搬
    （它们的集区间只在来源项目里有意义）。

    目标项目已有同名同类资产的跳过（`skipped`），不覆盖 —— 用户自己项目里的
    那张图可能是专门调过的，被库里的同名资产冲掉是不可逆的损失。
    """
    ids = list(dict.fromkeys(x for x in body.asset_ids if x))
    if not ids:
        raise HTTPException(400, "没有选择要导入的资产")
    if len(ids) > 200:
        raise HTTPException(400, "一次最多导入 200 个")
    with get_session() as session:
        access.require_project_access(session, body.project_id)
        if any(aid.startswith("mref-") for aid in ids):
            raise HTTPException(409, "所选角色为创作参考素材，不能直接绑定到项目。")
        uid = access.current_user_id()
        admin = access.is_admin()
        pairs = (session.query(Asset, Project)
                 .join(Project, Project.id == Asset.project_id)
                 .filter(Asset.id.in_(ids)).all())
        found = {a.id: (a, p) for a, p in pairs}
        for aid in ids:
            got = found.get(aid)
            if got is None:
                raise HTTPException(404, "资产不存在")
            a, p = got
            mine = uid is not None and p.owner_id is not None and int(p.owner_id) == uid
            if (a.deleted_at or p.deleted_at
                    or not (admin or mine or _is_public(a))):
                raise HTTPException(404, "资产不存在")

        stage_img = _stage_images(
            session, {p.id for a, p in found.values() if a.kind == "character"})
        existing = {(k, n) for k, n in session.query(Asset.kind, Asset.name)
                    .filter(Asset.project_id == body.project_id,
                            Asset.deleted_at.is_(None)).all()}
        created, skipped = [], []
        for aid in ids:
            a, p = found[aid]
            if (a.kind, a.name) in existing:
                skipped.append(a.name)
                continue
            img = a.image_url or (stage_img.get((p.id, a.name))
                                  if a.kind == "character" else None)
            nid = uuid.uuid4().hex[:12]
            # ⚠️ 搬的是**描述**（desc_auto），不搬用户终稿 `prompt`：
            # 终稿里含有来源项目的画风前缀/构图句/影调句，到了目标项目
            # （别的画风、别的影调）会直接打架，而它在目标项目里又会被当作
            # "用户改过的稿"整段覆盖拼装结果 —— 等于把画风悄悄换回来源项目的。
            session.add(Asset(id=nid, project_id=body.project_id, kind=a.kind,
                              name=a.name, desc_auto=desc_of(a), image_url=img,
                              # 形象档案（五官/骨相）是"这个人长什么样"的事实来源，
                              # 跟着图一起走；不带的话导入的角色下次重生成会换脸
                              profile_json=a.profile_json if a.kind == "character" else None))
            existing.add((a.kind, a.name))
            created.append({"id": nid, "kind": a.kind, "name": a.name})
        session.commit()
    return {"ok": True, "created": created, "skipped": skipped}


class VisibilityIn(BaseModel):
    asset_ids: list[str] = Field(default_factory=list)
    visibility: str


@router.put("/library/visibility")
def set_visibility(body: VisibilityIn) -> dict:
    """把**自己的**资产设为公开 / 隐私。

    每一条都过 `access.req_asset`：不是你项目里的资产一律 404，
    所以拿别人的 asset_id 改不了别人的可见性（管理员除外）。
    """
    if body.visibility not in _VISIBILITY:
        raise HTTPException(400, "visibility 只能是 public 或 private")
    ids = list(dict.fromkeys(x for x in body.asset_ids if x))
    if not ids:
        raise HTTPException(400, "没有选择资产")
    with get_session() as session:
        rows = [access.req_asset(session, i) for i in ids]
        for a in rows:
            a.visibility = body.visibility
        session.commit()
    return {"ok": True, "updated": len(ids), "visibility": body.visibility}


class OwnerIn(BaseModel):
    #: 二选一：上游用户 id（推荐，前端下拉选人传这个），或用户名/显示名。
    #: 两者都为空 = 收回为"无主"（只有管理员可见）。
    owner_id: Optional[int] = None
    username: Optional[str] = None


class OwnerBatchIn(BaseModel):
    project_ids: list[str]
    owner_id: Optional[int] = None
    username: Optional[str] = None


def _user_directory(session) -> dict[int, dict]:
    """登录过的用户：名录（auth.KnownUser，不随会话过期）∪ 现存会话（名录上线前的兜底）。

    实现在 `app/user_directory.py`（数据拼接不属于任何一个路由，且 `budget` 也要用）。
    这里保留一个转发壳：本文件内与其余调用点都照旧调它，本次不顺手做大范围重构。
    """
    from ..user_directory import directory

    return directory(session)


def _resolve_owner(session, owner_id: Optional[int], username: Optional[str]) -> Optional[int]:
    """把转交目标解析成 user_id。None = 收回为无主。

    ⚠️ 两条硬规则（2026-10-15，上线前补）：
      · **重名必须报错，不能取第一个**。旧实现 `.filter(username==x | display_name==x).first()`
        在两人同名（或一人的显示名恰好是另一人的用户名）时把项目**静默转给错的人**——
        而对方此后就能看见、修改、花钱生成这个项目。生产上就有显示名为「123」「==」的账号。
      · **owner_id 必须是登录过的用户**。手滑填错一个数字，项目就被转给"不存在的人"，
        除管理员外谁也看不见，作者会以为项目丢了。
    """
    users = _user_directory(session)
    if owner_id is not None:
        if int(owner_id) not in users:
            raise HTTPException(404, f"用户 id {owner_id} 没有登录过本服务——请对方先登录一次")
        return int(owner_id)
    name = (username or "").strip()
    if not name:
        return None
    hits = [u for u in users.values() if name in (u["username"], u["display_name"])]
    if not hits:
        raise HTTPException(404, f"找不到用户「{name}」——对方需要先登录过一次")
    if len(hits) > 1:
        who = "、".join(f"{u['username']}（id {u['id']}）" for u in hits[:5])
        raise HTTPException(409, f"「{name}」对应多个用户：{who}——请在列表里直接选人")
    return int(hits[0]["id"])


@router.get("/admin/users")
def list_users() -> dict:
    """（仅管理员）可作为转交目标的用户，附各自名下的项目数。"""
    if not access.is_admin():
        raise HTTPException(403, "只有管理员可以查看用户列表")
    from ..db import Project
    from sqlalchemy import func
    with get_session() as session:
        users = _user_directory(session)
        counts = dict(session.query(Project.owner_id, func.count(Project.id))
                      .filter(Project.deleted_at.is_(None))
                      .group_by(Project.owner_id).all())
        items = sorted(users.values(),
                       key=lambda u: (u["role"] not in ("admin", "superadmin"),
                                      (u["username"] or "")))
        for u in items:
            u["projects"] = int(counts.get(u["id"], 0))
        return {"users": items, "unowned": int(counts.get(None, 0))}


@router.put("/projects/{project_id}/owner")
def set_project_owner(project_id: str, body: OwnerIn) -> dict:
    """（仅管理员）把项目转给某个用户（或收回为无主）。

    存量项目迁移后一律"无主 = 仅管理员可见"（用户裁定），这是管理员把其中
    某个交还给实际作者的唯一出口。解析规则见 `_resolve_owner`。
    """
    if not access.is_admin():
        raise HTTPException(403, "只有管理员可以转交项目")
    with get_session() as session:
        uid = _resolve_owner(session, body.owner_id, body.username)
        access.transfer_owner(session, project_id, uid)
        u = _user_directory(session).get(uid) if uid is not None else None
    return {"ok": True, "project_id": project_id, "owner_id": uid,
            "owner_name": (u["display_name"] or u["username"]) if u else None}


@router.post("/admin/projects/owner")
def set_project_owner_batch(body: OwnerBatchIn) -> dict:
    """（仅管理员）一次把多个项目转给同一个人。

    上线时有几十个无主项目要逐个还给作者，一个个点是给出错制造机会。
    **全有或全无**：先解析目标、再校验每个项目都存在，任何一步不过都不改任何一行。
    """
    if not access.is_admin():
        raise HTTPException(403, "只有管理员可以转交项目")
    from ..db import Project
    ids = [i for i in dict.fromkeys(body.project_ids or []) if i]
    if not ids:
        raise HTTPException(422, "没有选中任何项目")
    with get_session() as session:
        uid = _resolve_owner(session, body.owner_id, body.username)
        rows = session.query(Project).filter(Project.id.in_(ids)).all()
        missing = set(ids) - {p.id for p in rows}
        if missing:
            raise HTTPException(404, f"有 {len(missing)} 个项目不存在，未做任何改动")
        for p in rows:
            p.owner_id = uid
        session.commit()
    return {"ok": True, "updated": len(rows), "owner_id": uid}


# ===========================================================================
# 项目协作者（2026-10-16 协作）
# ===========================================================================
#
# 三档：viewer（只看）/ editor（可改可生成）/ manager（可邀请、可改项目设置）。
# **owner 不在名册里**，他只在 `projects.owner_id` —— 详见 db.ProjectCollaborator。
# "manager 不能删除项目、不能转交"就是靠这条实现的（删除要 owner 档）。
#
# 路由全部挂在 `/v2/projects/{pid}/...` 下，于是：
#   · 中间件自动完成"是不是成员"的闸门（404）—— 零代码；
#   · `_role_guard` 按下面盖的章判档位（403）。


class CollabIn(BaseModel):
    """加人/改档。**只收 user_id，不收名字** —— 理由见 `_resolve_owner`。"""
    user_id: int
    role: str


class CollabRoleIn(BaseModel):
    role: str


def _role_or_422(role: str) -> str:
    r = (role or "").strip().lower()
    if r not in access._ROSTER_ROLES:
        raise HTTPException(422, f"未知档位「{role}」——只能是 "
                                 + " / ".join(access._ROSTER_ROLES))
    return r


def _known(session, uid: int) -> dict:
    """名录里的一个人。找不到 → 404（措辞与转交一致）。"""
    u = _user_directory(session).get(int(uid))
    if not u:
        raise HTTPException(404, f"用户 id {uid} 没有登录过本服务——请对方先登录一次")
    return u


def _collab_rows(session, project_id: str) -> list[dict]:
    from ..auth import KnownUser
    from ..db import ProjectCollaborator
    names = {u.user_id: u for u in session.query(KnownUser).all()}
    rows = (session.query(ProjectCollaborator)
            .filter(ProjectCollaborator.project_id == project_id)
            .order_by(ProjectCollaborator.created_at).all())
    out = []
    for r in rows:
        k = names.get(r.user_id)
        out.append({
            "user_id": r.user_id,
            "username": (k.username if k else ""),
            "display_name": (k.display_name if k else None),
            "role": r.role,
            "invited_by": r.invited_by,
            "created_at": r.created_at,
        })
    return out


@router.get("/projects/{project_id}/collaborators")
def list_collaborators(project_id: str) -> dict:
    """这个项目现有的协作者 + 所有者 + **我是什么档**。

    `my_role` 是前端的判据：查看者模式、按钮显隐全靠它。后端不返回它的话，
    前端只能猜（或再发一次请求），而"猜错就把写按钮给查看者看"是这个代码库
    已经付过学费的一类 bug（见 access.Principal.is_admin 的注释）。
    """
    from ..db import Project
    with get_session() as session:
        proj = session.get(Project, project_id)
        if proj is None:
            raise HTTPException(404, "项目不存在")
        owner = _user_directory(session).get(proj.owner_id) if proj.owner_id else None
        return {
            "project_id": project_id,
            "my_role": access.project_role(session, project_id),
            "owner": ({"user_id": owner["id"], "username": owner["username"],
                       "display_name": owner["display_name"]} if owner else None),
            "collaborators": _collab_rows(session, project_id),
        }


@router.post("/projects/{project_id}/collaborators")
@access.requires(access.ROLE_MANAGER)
def add_collaborator(project_id: str, body: CollabIn) -> dict:
    """加人 / 改档（同一个人只有一个档，重复提交是覆盖不是叠加）。

    **提交 `user_id`，不提交名字** —— 与项目转交同一条纪律：生产库里有叫
    `123`、`==`、`Zed` 的账号，按名字找人曾把项目**静默转给了错的人**。
    前端从候选人列表里选人，拿到的就是 id。
    """
    from datetime import datetime, timezone
    from ..db import Project, ProjectCollaborator
    role = _role_or_422(body.role)
    with get_session() as session:
        proj = session.get(Project, project_id)
        if proj is None:
            raise HTTPException(404, "项目不存在")
        uid = int(body.user_id)
        me = access.current_user_id()
        if uid == me:
            raise HTTPException(409, "不能把自己加为协作者——你是这个项目的所有者")
        if proj.owner_id is not None and uid == int(proj.owner_id):
            # 名册里不该出现所有者（db.ProjectCollaborator 的注释解释了为什么）
            raise HTTPException(409, "项目所有者不需要加入协作者")
        _known(session, uid)
        row = session.get(ProjectCollaborator, (project_id, uid))
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        created = row is None
        if row is None:
            row = ProjectCollaborator(project_id=project_id, user_id=uid,
                                      role=role, invited_by=me, created_at=now,
                                      updated_at=now)
            session.add(row)
        else:
            row.role = role
            row.updated_at = now
        session.commit()
        person = _user_directory(session).get(uid) or {}
        return {"ok": True, "created": created,
                "collaborator": {"user_id": uid,
                                 "username": person.get("username", ""),
                                 "display_name": person.get("display_name"),
                                 "role": role, "invited_by": me,
                                 "created_at": row.created_at}}


@router.patch("/projects/{project_id}/collaborators/{user_id}")
@access.requires(access.ROLE_MANAGER)
def set_collaborator_role(project_id: str, user_id: int, body: CollabRoleIn) -> dict:
    """改某人的档位。"""
    from datetime import datetime, timezone
    from ..db import ProjectCollaborator
    role = _role_or_422(body.role)
    with get_session() as session:
        row = session.get(ProjectCollaborator, (project_id, int(user_id)))
        if row is None:
            raise HTTPException(404, "这个人不是该项目的协作者")
        row.role = role
        row.updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        session.commit()
    return {"ok": True, "user_id": int(user_id), "role": role}


@router.delete("/projects/{project_id}/collaborators/{user_id}")
@access.requires(access.ROLE_VIEWER)
def remove_collaborator(project_id: str, user_id: int) -> dict:
    """移出协作者。**自助退出是允许的**（任何档位都可以），所以这里盖的是
    `viewer` 底线 + 函数内细化"要么是 manager、要么是移出自己"。

    ⚠️ 为什么不能盖 `manager`：`manager OR self` 不是单一档位能表达的；
    而且这行删掉的正是**授权这一次调用**的那一行（自己的名册行），
    档位闸门已经在处理函数**之前**跑过了（依赖先于端点），这里不能再依赖它
    ——所以档位判断必须在删除之前自己做一次。
    """
    from ..db import ProjectCollaborator, get_session as _gs
    with _gs() as session:
        me = access.current_user_id()
        target = int(user_id)
        if target != me:
            role = access.project_role(session, project_id)
            if role is None:
                raise HTTPException(404, "项目不存在")
            if access._RANK[role] < access._RANK[access.ROLE_MANAGER]:
                raise HTTPException(403, {
                    "reason": "forbidden_project_role",
                    "message": "只有项目所有者与管理者可以移出协作者",
                    "your_role": role, "required_role": access.ROLE_MANAGER,
                })
        row = session.get(ProjectCollaborator, (project_id, target))
        if row is None:
            # 幂等：重复移出不报错（与 delete_stage 等既有做法一致）
            return {"ok": True, "removed": False, "left": target == me}
        session.delete(row)
        session.commit()
    return {"ok": True, "removed": True, "left": target == me}


@router.get("/projects/{project_id}/collaborators/candidates")
@access.requires(access.ROLE_MANAGER)
def collaborator_candidates(project_id: str, q: str = "", limit: int = 20) -> dict:
    """邀请时可搜的人（**只给 owner / manager 用**）。

    ## 隐私：为什么这条是安全的

    它嵌在 `/v2/projects/{pid}/...` 之下，所以中间件**先**过了成员闸门，
    再加上 `manager` 档 —— 只有项目所有者已经背书过的人才能查。
    返回的字段也刻意克制：`id / username / display_name`，**不给 role、
    不给项目数、不给最后登录时间**。这比组长现有的 `/v2/budget/candidates`
    返回得还少（那个带 platform_role 与组织角色）。

    ## 只返回登录过的人

    数据源是 `known_users`（"见过谁"），所以**没登录过的人搜不到** ——
    这是刻意的，与转交同一条约束：放一个没登录过的人进名册，等于给了他一个
    打不开的项目。前端要提示"请对方先登录一次"。
    """
    from ..auth import KnownUser
    from ..db import Project, ProjectCollaborator
    kw = (q or "").strip()
    if len(kw) < 2:
        # 不给"空查询列全平台"的口子。全平台名录是管理员的视图，不是这条的。
        return {"users": []}
    lim = max(1, min(int(limit or 20), 50))
    like = f"%{kw}%"
    with get_session() as session:
        proj = session.get(Project, project_id)
        if proj is None:
            raise HTTPException(404, "项目不存在")
        taken = {r[0] for r in session.query(ProjectCollaborator.user_id)
                 .filter(ProjectCollaborator.project_id == project_id).all()}
        if proj.owner_id is not None:
            taken.add(int(proj.owner_id))
        rows = (session.query(KnownUser)
                .filter(or_(KnownUser.username.like(like),
                            KnownUser.display_name.like(like)))
                .order_by(KnownUser.username).limit(lim * 2).all())
        users = [{"id": u.user_id, "username": u.username,
                  "display_name": u.display_name}
                 for u in rows if u.user_id not in taken][:lim]
    return {"users": users}
