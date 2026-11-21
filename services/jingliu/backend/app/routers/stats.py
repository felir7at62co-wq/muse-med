"""生产统计（组长 / 小组长 / 管理员看下属的消耗与效率指标，2026-11-04）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET /v2/stats/summary | 汇总：消耗/生成数/抽卡率/成片率（项目级）| 按角色看子树 |
| GET /v2/stats/daily   | 按日折线数据（消耗 + 生成数，最近 N 天）   | 同上 |
| GET /v2/stats/members | 子树每人一行（各项指标 + 人名）             | 同上 |

权限：管理员看全库；组长看自己子树（manager_id 路径）；生成师只看自己。
时间：参数 date_from / date_to（ISO8601 日期，UTC 基准，北京时间 +8h 由前端换算）。
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Query
from sqlalchemy import func, text

from .. import access, budget
from ..db import Shot, ShotVersion, UsageEvent, get_session
from ..pricing import fen_to_yuan

log = logging.getLogger(__name__)
router = APIRouter(prefix="/v2", tags=["stats"])


# ---------- 工具 ----------

def _actor_uids(a: budget.Actor) -> list[int]:
    """该 actor 可见范围内的全部 user_id（含自身）。"""
    if a.is_root:
        with get_session() as s:
            from ..db import UserBudget
            return [int(u.user_id) for u in s.query(UserBudget).filter_by(active=1).all()]
    # 自己 + 子树
    sub = budget.descendants(budget.MEMBER_PREFIX + str(a.uid))
    member_uids = [int(p[len(budget.MEMBER_PREFIX):]) for p in sub
                   if p.startswith(budget.MEMBER_PREFIX)]
    return sorted({a.uid} | set(member_uids))


def _date_range(date_from: str | None, date_to: str | None) -> tuple[str, str]:
    """把**北京日期**转成 UTC 时间范围。

    ⚠️ 2026-11-10 修：原来直接 `date_from + "T00:00:00+00:00"`，等于把用户看到的
    北京日期当成 UTC 零点用 —— 实际覆盖的是北京时间 08:00 到下一天 08:00。
    表现是「昨天晚上的消耗算到了今天」，做日报对不上账。这是系统性偏移，不是随机误差。

    现在按 UTC+8 反推：北京 11-04 00:00 = UTC 11-03 16:00。
    """
    now = datetime.now(timezone.utc)
    if not date_from:
        date_from = (now - timedelta(days=29)).strftime("%Y-%m-%d")
    if not date_to:
        date_to = now.strftime("%Y-%m-%d")
    cst = timezone(timedelta(hours=8))
    start = datetime.fromisoformat(date_from).replace(tzinfo=cst)
    end = datetime.fromisoformat(date_to).replace(tzinfo=cst) + timedelta(days=1)
    return (start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00"),
            (end - timedelta(seconds=1)).astimezone(timezone.utc)
            .strftime("%Y-%m-%dT%H:%M:%S+00:00"))


def _cst_day_expr():
    """把 UTC 的 ts 折成**北京日期**字符串，用于按天分组。

    SQLite 的 datetime 函数能直接加减时区偏移；PostgreSQL 走 to_char。
    两家都返回 `YYYY-MM-DD`，前端不必知道后端是哪个库。
    """
    from ..db import _IS_SQLITE

    if _IS_SQLITE:
        return func.date(UsageEvent.ts, "+8 hours")
    from sqlalchemy import DateTime
    return func.to_char(func.timezone("Asia/Shanghai", func.cast(UsageEvent.ts, DateTime)),
                        "YYYY-MM-DD")


def _cst_day_expr_version():
    """同上，但作用于 `shot_versions.created_at`（采用时间）。"""
    from ..db import _IS_SQLITE

    if _IS_SQLITE:
        return func.date(ShotVersion.created_at, "+8 hours")
    from sqlalchemy import DateTime
    return func.to_char(func.timezone("Asia/Shanghai", func.cast(ShotVersion.created_at, DateTime)),
                        "YYYY-MM-DD")


def _adopted_at_join(q):
    """把 shots 上的「采用版本」接回 shot_versions，拿到**采用发生的时间**。

    ⚠️ `shots.adopted_version` 存的是**版本号（int）**，不是 `shot_versions.id`。
    所以 join 条件是 `(shot_id = Shot.id) AND (version_no = Shot.adopted_version)`，
    按 id 连会一条都匹配不上（实测：全库 1856 个采用镜头，按 id 连返回 0 行，
    抽卡率直接变成 N/A）。

    2026-11-10：这是修「抽卡率/成片率没有时间过滤」的关键一环。
    """
    return q.join(ShotVersion,
                  (ShotVersion.shot_id == Shot.id)
                  & (ShotVersion.version_no == Shot.adopted_version))


def _days_cst(date_from: str | None, date_to: str | None) -> list[str]:
    """补齐的北京日期序列（含首尾）。缺省 = 最近 30 天。"""
    cst = timezone(timedelta(hours=8))
    today = datetime.now(cst).date()
    end = (datetime.fromisoformat(date_to).date() if date_to else today)
    start = (datetime.fromisoformat(date_from).date() if date_from
             else end - timedelta(days=29))
    out: list[str] = []
    d = start
    while d <= end:
        out.append(d.strftime("%Y-%m-%d"))
        d += timedelta(days=1)
    return out


def _scope_uids(a: budget.Actor, group_id: Optional[int]) -> tuple[list[int], bool]:
    """本次统计的人员范围。

    返回 (uids, is_all)。
      · `group_id` 给了：取该人的整个子树（含他本人）—— 但**不许越权**，
        必须落在 `_actor_uids(a)` 之内，否则等于让组长看别人的组。
      · 管理员且没给 group_id：is_all=True，不加 user_id 过滤（含 user_id 为空的记录）。
      · 其他人：自己的子树。
    """
    visible = _actor_uids(a)
    if group_id is not None:
        target = int(group_id)
        if target not in visible:
            raise PermissionError("你看不到这个小组")
        sub = budget.descendants(budget.MEMBER_PREFIX + str(target))
        uids = {target} | {int(p[len(budget.MEMBER_PREFIX):]) for p in sub
                           if p.startswith(budget.MEMBER_PREFIX)}
        return sorted(uids & set(visible)), False
    if a.is_root:
        return visible, True
    return visible, False


# ---------- 短缓存（2026-11-05） ----------
#
# 统计是**聚合查询**：管理员那条不带 user_id 过滤，是全表扫描
# （生产实测 usage_events 30 万行）。156 个人每点一次「统计」都重跑一遍
# 纯属浪费，而看板上的数字晚 60 秒更新没有任何业务影响。
#
# 缓存键**必须含权限范围**，不能只按日期缓存：否则组长先看、管理员后看，
# 管理员会拿到组长那份（少了别人）；反过来更糟——组长看到全库数据，
# 那是越权。所以键 = (接口, 日期区间, 项目, 可见 user_id 集合的摘要)。
_CACHE_TTL = 60.0
_cache: dict[tuple, tuple[float, dict]] = {}


def _cache_key(tag: str, ts_from: str, ts_to: str, project_id: str | None,
               uids: list[int] | None) -> tuple:
    """`uids is None` = 管理员看全库。用元组而非字符串，避免拼接歧义。"""
    return (tag, ts_from, ts_to, project_id,
            None if uids is None else tuple(sorted(uids)))


def _cached(key: tuple, build):
    """命中就直接返回；过期或没有就重建。**不缓存异常**（建失败就下次再试）。"""
    import time
    now = time.monotonic()
    hit = _cache.get(key)
    if hit is not None and now - hit[0] < _CACHE_TTL:
        return hit[1]
    val = build()
    # 顺手清掉过期项：这个字典最多几百个键，不必上 LRU
    if len(_cache) > 512:
        for k in [k for k, v in _cache.items() if now - v[0] >= _CACHE_TTL]:
            _cache.pop(k, None)
    _cache[key] = (now, val)
    return val


# ---------- 接口 ----------

@router.get("/stats/summary")
def stats_summary(
    date_from: Optional[str] = Query(None, description="起始日期 YYYY-MM-DD（北京）"),
    date_to: Optional[str] = Query(None, description="结束日期 YYYY-MM-DD（北京）"),
    project_id: Optional[str] = Query(None, description="只看这个项目"),
    group_id: Optional[int] = Query(None, description="只看这个小组及其下级（user_id）"),
) -> dict:
    """汇总卡片数据：消耗/生成数/抽卡率/成片率。

    ## 抽卡率（2026-11-10 重算口径）
    = 区间内生成次数 ÷ **区间内被采用的镜头数**。

    ⚠️ 原实现里分子有时间过滤、分母没有（只按 `shots.adopted_version is not null`
    数全库），于是「近 7 天」和「近 30 天」分子差 4 倍、分母一模一样，
    抽卡率跟着差 4 倍 —— 那个数字不能用于决策。

    现在分母改成「采用发生在区间内」：`shots.adopted_version` 关联
    `shot_versions` 上那一版的 `created_at`（shots 表本身没有采用时间字段）。

    ## 成片率
    = 区间内采用的镜头时长 ÷ 区间内生成的视频总时长。
    两侧都在同一个区间里，比率才有意义。
    """
    try:
        a = budget.current_actor()
    except PermissionError as e:
        from fastapi import HTTPException
        raise HTTPException(401, str(e)) from e

    try:
        uids, is_all = _scope_uids(a, group_id)
    except PermissionError as e:
        from fastapi import HTTPException
        raise HTTPException(403, str(e)) from e
    ts_from, ts_to = _date_range(date_from, date_to)
    key = _cache_key("summary", ts_from, ts_to, f"{project_id}|g{group_id}",
                     None if is_all else uids)

    def _build() -> dict:
        with get_session() as s:
            def _ev(q):
                """给 usage_events 查询统一套上范围过滤（时间在外层已加）。"""
                if not is_all:
                    q = q.filter(UsageEvent.user_id.in_(uids))
                if project_id:
                    q = q.filter(UsageEvent.project_id == project_id)
                return q

            # ---- 消耗（分） ----
            spent_fen = int(_ev(s.query(func.coalesce(func.sum(UsageEvent.cost_fen), 0))
                                .filter(UsageEvent.ts >= ts_from, UsageEvent.ts <= ts_to)
                                ).scalar() or 0)

            # ---- 视频生成次数 ----
            gen_count = int(_ev(s.query(func.count())
                                .filter(UsageEvent.category == "video",
                                        UsageEvent.ts >= ts_from, UsageEvent.ts <= ts_to)
                                ).scalar() or 0)

            # ---- 生成视频总时长（秒） ----
            gen_seconds = float(_ev(s.query(func.coalesce(func.sum(UsageEvent.media_seconds), 0))
                                    .filter(UsageEvent.category == "video",
                                            UsageEvent.media_seconds.isnot(None),
                                            UsageEvent.ts >= ts_from, UsageEvent.ts <= ts_to)
                                    ).scalar() or 0)

            # ---- 未归属（user_id 为空）的消耗 ----
            # 管理员看全库时：这部分**计入 KPI 但不进人员明细**，差额要在界面上显式补上，
            # 否则「KPI 消耗」永远大于「明细表之和」，用户第一反应是算错了。
            unattributed_fen = 0
            if is_all:
                q_un = (s.query(func.coalesce(func.sum(UsageEvent.cost_fen), 0))
                        .filter(UsageEvent.user_id.is_(None),
                                UsageEvent.ts >= ts_from, UsageEvent.ts <= ts_to))
                if project_id:
                    q_un = q_un.filter(UsageEvent.project_id == project_id)
                unattributed_fen = int(q_un.scalar() or 0)

            # ---- 区间内被采用的镜头数 & 时长 ----
            # 用 adopted_version 反查 shot_versions.created_at，拿"采用发生的时间"。
            # 两侧都限制在同一区间，比率才有意义。join 条件见 _adopted_at_join。
            adopt_q = (s.query(func.count(func.distinct(Shot.id)),
                               func.coalesce(func.sum(Shot.duration_sec), 0))
                       .select_from(Shot)
                       .filter(Shot.adopted_version.isnot(None),
                               ShotVersion.created_at >= ts_from,
                               ShotVersion.created_at <= ts_to))
            adopt_q = _adopted_at_join(adopt_q)
            if project_id:
                adopt_q = adopt_q.filter(Shot.project_id == project_id)
            if not is_all:
                # `shots` 没有 user_id，没法按人过滤。用「这批人在区间内产生过消耗的项目」
                # 界定范围 —— 只看小组时不这么收，组 81 / 组 70 会显示同一个全库采用数。
                proj_ids = [
                    r[0] for r in s.query(UsageEvent.project_id)
                    .filter(UsageEvent.user_id.in_(uids),
                            UsageEvent.ts >= ts_from, UsageEvent.ts <= ts_to,
                            UsageEvent.project_id.isnot(None))
                    .distinct().all()
                ]
                if not proj_ids:
                    # 这批人在区间内没有任何消耗 → 采用数也必然是 0，别再跑一次全库查询
                    adopted_shots, adopted_seconds = 0, 0.0
                    adopt_q = None
                else:
                    adopt_q = adopt_q.filter(Shot.project_id.in_(proj_ids))
            if adopt_q is not None:
                adopted_shots, adopted_seconds = adopt_q.one()
            adopted_shots = int(adopted_shots or 0)
            adopted_seconds = float(adopted_seconds or 0)

        draw_rate = round(gen_count / adopted_shots, 2) if adopted_shots else None
        cut_rate = round(adopted_seconds / gen_seconds, 4) if gen_seconds else None
        return {
            "date_from": ts_from[:10],
            "date_to": ts_to[:10],
            "group_id": group_id,
            "scope_uids": None if is_all else len(uids),
            "spent_fen": spent_fen,
            "spent_yuan": fen_to_yuan(spent_fen),
            "gen_count": gen_count,
            "gen_seconds": round(gen_seconds, 1),
            "adopted_shots": adopted_shots,
            "adopted_seconds": round(adopted_seconds, 1),
            # 抽卡率：平均几抽出一条（越小越好）
            "draw_rate": draw_rate,
            # 成片率：采用视频时长 / 生成视频总时长（0–1）
            "cut_rate": cut_rate,
            "cut_rate_pct": f"{cut_rate * 100:.1f}%" if cut_rate is not None else None,
            # 单位成本：每采用一个镜头花多少钱（元）。效率指标，比绝对值更能比人。
            "cost_per_adopted": (fen_to_yuan(spent_fen // adopted_shots)
                                 if adopted_shots else None),
            "unattributed_fen": unattributed_fen,
            "unattributed_yuan": fen_to_yuan(unattributed_fen),
            "note_user_id": ("部分生成记录 user_id 为空（后台任务未携带登录上下文），"
                             "消耗数字含这些记录，人员明细不含 —— 已单列「未归属」行")
                            if unattributed_fen else "",
        }

    return _cached(key, _build)


@router.get("/stats/daily")
def stats_daily(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    project_id: Optional[str] = Query(None),
    group_id: Optional[int] = Query(None, description="只看这个小组及其下级"),
) -> dict:
    """折线图数据：每天的消耗（元）+ 生成次数（视频）+ 采用数（新增）。

    ⚠️ 2026-11-10 修：原来按 `SUBSTR(ts,1,10)` 分组，那是 **UTC 日期**。
    用户看的是北京日期，于是晚上 8 点后的消耗被算进第二天。
    现在用 `_cst_day_expr()` 折成北京日期再分组。
    """
    try:
        a = budget.current_actor()
    except PermissionError as e:
        from fastapi import HTTPException
        raise HTTPException(401, str(e)) from e

    try:
        uids, is_all = _scope_uids(a, group_id)
    except PermissionError as e:
        from fastapi import HTTPException
        raise HTTPException(403, str(e)) from e
    ts_from, ts_to = _date_range(date_from, date_to)
    key = _cache_key("daily", ts_from, ts_to, f"{project_id}|g{group_id}",
                     None if is_all else uids)

    def _build() -> dict:
        day = _cst_day_expr()
        with get_session() as s:
            def _ev(q):
                if not is_all:
                    q = q.filter(UsageEvent.user_id.in_(uids))
                if project_id:
                    q = q.filter(UsageEvent.project_id == project_id)
                return q

            # 消耗（全类别）
            q = _ev(s.query(day.label("day"),
                            func.coalesce(func.sum(UsageEvent.cost_fen), 0).label("fen"))
                    .filter(UsageEvent.ts >= ts_from, UsageEvent.ts <= ts_to))
            spent_by_day = {str(r.day): int(r.fen) for r in q.group_by("day").all()}

            # 生成次数
            q2 = _ev(s.query(day.label("day"), func.count().label("cnt"))
                     .filter(UsageEvent.category == "video",
                             UsageEvent.ts >= ts_from, UsageEvent.ts <= ts_to))
            gen_by_day = {str(r.day): int(r.cnt) for r in q2.group_by("day").all()}

            # 采用数（按采用时间折北京日期）—— 让图能一起看"花了多少 / 拿到几条"
            day_v = _cst_day_expr_version()
            q3 = (s.query(day_v.label("day"), func.count(func.distinct(Shot.id)).label("cnt"))
                  .select_from(Shot)
                  .filter(Shot.adopted_version.isnot(None),
                          ShotVersion.created_at >= ts_from,
                          ShotVersion.created_at <= ts_to))
            q3 = _adopted_at_join(q3)
            if project_id:
                q3 = q3.filter(Shot.project_id == project_id)
            if not is_all:
                from ..access import visible_projects_query
                vpids = [p.id for p in visible_projects_query(s).all()]
                q3 = q3.filter(Shot.project_id.in_(vpids))
            adopt_by_day = {str(r.day): int(r.cnt) for r in q3.group_by("day").all()}

        # 补全日期序列（按北京日期，含首尾）
        days = _days_cst(date_from, date_to)

        return {
            "days": days,
            "spent_yuan": [round(spent_by_day.get(d, 0) / 100, 2) for d in days],
            "gen_count": [gen_by_day.get(d, 0) for d in days],
            "adopted": [adopt_by_day.get(d, 0) for d in days],
        }

    return _cached(key, _build)


@router.get("/stats/members")
def stats_members(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    project_id: Optional[str] = Query(None),
    group_id: Optional[int] = Query(None, description="只看这个小组及其下级"),
) -> dict:
    """每人一行的明细（横向条形图 + 表格数据源）。

    生成师只能看自己。组长/管理员看子树；给了 group_id 就只看那一支（不许越权）。

    返回里附带 `unattributed_fen`（user_id 为空的消耗）与 `total_spent_fen`，
    让前端能把「KPI 消耗」和「明细之和」的差额显式补成一行 ——
    否则用户会以为数字算错了。
    """
    try:
        a = budget.current_actor()
    except PermissionError as e:
        from fastapi import HTTPException
        raise HTTPException(401, str(e)) from e

    try:
        uids, is_all = _scope_uids(a, group_id)
    except PermissionError as e:
        from fastapi import HTTPException
        raise HTTPException(403, str(e)) from e
    ts_from, ts_to = _date_range(date_from, date_to)
    key = _cache_key("members", ts_from, ts_to, f"{project_id}|g{group_id}",
                     None if is_all else uids)

    def _build() -> dict:
        with get_session() as s:
            from ..db import UserBudget
            names = {int(u.user_id): u.name or u.username or str(u.user_id)
                     for u in s.query(UserBudget).filter(UserBudget.user_id.in_(uids)).all()}

            def _ev(q):
                if project_id:
                    q = q.filter(UsageEvent.project_id == project_id)
                return q

            # 消耗（有 user_id 的）
            spent = {int(r.user_id): int(r.fen) for r in _ev(
                s.query(UsageEvent.user_id,
                        func.coalesce(func.sum(UsageEvent.cost_fen), 0).label("fen"))
                .filter(UsageEvent.user_id.in_(uids),
                        UsageEvent.ts >= ts_from, UsageEvent.ts <= ts_to)
            ).group_by(UsageEvent.user_id).all()}

            # 视频生成次数（有 user_id 的）
            gen = {int(r.user_id): int(r.cnt) for r in _ev(
                s.query(UsageEvent.user_id, func.count().label("cnt"))
                .filter(UsageEvent.category == "video",
                        UsageEvent.user_id.in_(uids),
                        UsageEvent.ts >= ts_from, UsageEvent.ts <= ts_to)
            ).group_by(UsageEvent.user_id).all()}

            # 未归属：管理员全库视图下才有多出来的可能
            unattributed_fen = 0
            if is_all:
                q_un = (s.query(func.coalesce(func.sum(UsageEvent.cost_fen), 0))
                        .filter(UsageEvent.user_id.is_(None),
                                UsageEvent.ts >= ts_from, UsageEvent.ts <= ts_to))
                if project_id:
                    q_un = q_un.filter(UsageEvent.project_id == project_id)
                unattributed_fen = int(q_un.scalar() or 0)

        members = []
        for uid in uids:
            s_fen = spent.get(uid, 0)
            g_cnt = gen.get(uid, 0)
            members.append({
                "user_id": uid,
                "name": names.get(uid, str(uid)),
                "spent_fen": s_fen,
                "spent_yuan": fen_to_yuan(s_fen),
                "gen_count": g_cnt,
            })
        members.sort(key=lambda x: x["spent_fen"], reverse=True)
        return {
            "members": members,
            "date_from": ts_from[:10], "date_to": ts_to[:10],
            "group_id": group_id,
            "unattributed_fen": unattributed_fen,
            "unattributed_yuan": fen_to_yuan(unattributed_fen),
        }

    return _cached(key, _build)


@router.get("/stats/groups")
def stats_groups() -> dict:
    """可选的小组列表（给统计页的下拉框）。

    只返回**当前操作者能看的组**：管理员看全树，组长看自己那支。
    树结构直接复用 `budget.list_org()` —— 它已经按操作者裁剪过，
    另写一套等于把权限判断复制两份，早晚不一致。
    """
    try:
        a = budget.current_actor()
    except PermissionError as e:
        from fastapi import HTTPException
        raise HTTPException(401, str(e)) from e
    if not a.can_edit:
        return {"groups": [], "note": "生成师没有下辖小组"}

    tree = budget.list_org(a)

    # 只收「能带人」的角色：大组长 / 小组长。
    # ⚠️ 用 budget 的常量，不要手写字符串 —— 曾经写成 ("组长","小组长")，
    #    而 canonical 值是「大组长」，于是大组长被整个漏掉（只剩小组长）。
    LEADERS = {budget.ROLE_LEAD, budget.ROLE_SUBLEAD}
    out: list[dict] = []

    def walk(node: dict, depth: int) -> None:
        if node.get("role") in LEADERS:
            out.append({
                "user_id": node["user_id"],
                "name": node["name"],
                "role": node["role"],
                "headcount": node.get("headcount", 1),
                "depth": depth,
            })
        for m in node.get("members") or []:
            walk(m, depth + 1)

    for r in tree.get("roots") or []:
        walk(r, 0)
    return {"groups": out}
