"""镜头轨：编辑（分割/重排/重切）、提示词、版本、首帧，以及剧本拆解。

`POST   /v2/shots/{id}/override|special|ref-overrides`   —— 注入与特殊镜头
`PATCH  /v2/shots/{id}/timeline|breakdown|prompt`
`POST   /v2/shots/{id}/split|unsplit|recut|undo-recut`    —— 时间轴编辑核心
`DELETE /v2/shots/{id}`  `GET /v2/shots/{id}/versions`
`POST   /v2/shots/{id}/first-frame|adopt`
`POST   /v2/projects/{pid}/backfill-thumbs`
`POST   /v2/script/optimize|breakdown` + 拆解的全部内部实现

## 为什么从 routes_v2.py 搬出来

它是原文件里**第二个大块**（1854 行、19 条路由），行数预算「只许减」
（见 `routers/__init__.py`）。

## 拆解实现为什么与编辑路由同模块

`do_breakdown` / `_merge_short_shots` / `_split_overlong_shots` /
`_loc_*` / `_parse_breakdown_json` 这一批被 `script_breakdown` 与
`jobs.py` 同时调用（jobs 里仍是函数内局部导入 —— 那是**任务层依赖路由实现**，
方向本就别扭，将来若要把拆解整体下沉到 `breakdown/` 包，从这里起手）。

## 与拆解时长有关的两条口径（已下沉到 shot_timing）

`breakdown_shot_cap`（真人剧按模型厂商硬钳）与 `shot_duration_ceiling`
（时间轴允许的最长秒数，只放宽不收紧）都定义了"一镜多长"，故随其它时长
工具一起住在 `shot_timing.py`，不在这里重复一份。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from ..db import (Asset, Project, Shot, ShotVersion, get_session, profile_of,
                  reset_clip_window)
from ..config import get_settings
from ..providers.llm import LLMProvider
from ..providers.registry import registry
from ..prompt_sanitize import strip_editor_chrome
from .. import access   # 多用户隔离：shot_id 类端点的归属校验（2026-10-09）
from .. import drama_timing
from .. import stale as stale_mod
from ..continuity import refresh_present_characters
from ..shot_timing import (_DUR_FLOOR, _DUR_WINDOW_DEFAULT, _DurWindow,
                           _RECUT_MIN_FALLBACK, _narration_duration, _renumber,
                           action_window, breakdown_shot_cap,
                           remap_anchors_by_identity,
                           remap_stage_ranges_by_identity,
                           shot_duration_ceiling,
                           shot_override_ceiling,
                           snapshot_anchors, snapshot_stage_ranges)

router = APIRouter(prefix="/v2", tags=["shots"])
logger = logging.getLogger(__name__)


class ShotOverrideIn(BaseModel):
    #: 镜头级策略覆盖（契约 C7 最高优先级）；null=清除覆盖回到继承
    profile_override: Optional[dict] = None
    is_special: Optional[bool] = None


class ShotRefImageIn(BaseModel):
    """生成视频页「给这一镜换一张参考图」（2026-10-21 用户需求）。

    三类资产的落点**不同**，因为它们在数据模型里的"作用域"本就不同：

      · 角色 → 建/改一条 **造型阶段**（`AssetStage`），区间正好圈住这一镜。
        这是用户的原话：「用户直接在这里切换的图片应该创建对应的造型范围」。
        角色图本来就只存在于造型层（注入读的是 `AssetStage.image_url`），
        写到 `Asset.image_url` 上是**通用图**，会把全剧这个角色都换掉。
      · 场景 / 道具 → 没有造型这一层，走镜头级覆写
        （`profile_override.refs` 加新图 + `refs_hide` 藏旧图），
        只影响这一镜，与既有的「@ 一张图 / 不带」是同一套机制。
    """
    #: character | location | prop
    kind: str
    name: str
    #: 已经在 `/media/upload` 落好盘的地址（前端先传文件，再调本接口）
    image_url: str
    #: 被替换掉的那张（场景/道具用它记 `refs_hide`）。角色侧可不传——
    #: 换了哪套造型由造型阶段本身回答，不需要再记一份。
    old_url: Optional[str] = None
    #: 可选：用户填的造型说明（会成为新造型阶段的 description，
    #: 提示词优化时用来把服装逐件对齐）。留空则沿用被替换那套的说明。
    description: Optional[str] = None


@router.post("/shots/{shot_id}/ref-image")
def switch_shot_ref_image(shot_id: str, body: ShotRefImageIn) -> dict:
    """给**当前这一镜**换掉某个资产的参考图。

    ## 为什么角色要建造型阶段，而不是直接改资产图

    出片注入角色图时读的是 `AssetStage.image_url`（见
    `jobs._auto_inject_refs_detailed`），`Asset.image_url` 只是**兜底通用图**。
    在"生成视频"这一页换图，用户要的是"这一镜用这张脸/这身衣服"，
    写通用图等于把全剧这个角色都换掉——那不是他点的那个动作，而且没有撤销入口。

    建一条 `shot_from == shot_to == 本镜 order` 的阶段，恰好就是"只对这一镜生效
    的造型范围"：它会在要素页的「造型阶段」里出现，用户可以随时把范围改大
    （改成整集、或绑一个场景），也可以删掉。**不是隐藏在 override 里的一次性东西。**

    ## 落在已有造型上时建指针行，不复制图

    用户换的那张图如果**正好是这位角色另一套造型的图**（最常见的情况：
    "这一镜我想穿第 3 集那件旗袍"），就建一条 `source_stage_id` 指针行 ——
    与既有"同一件衣服在相隔很远的镜头各出现一次"用的是同一种行
    （见 `db.AssetStage` 的列注释）：两处共用同一张图，既不会长出两张不一样的脸，
    也不用重新花钱生图。

    ## 与原本覆盖这一镜的造型

    一镜只归一套（`stage_coverage.claim`）：新建的这条接管这一镜，原来覆盖它的造型在这一镜上让开，
    被切开的后半段建成指针行、仍是同一张图。改了哪几套在返回的 `adjusted` 里逐条说明。
    """
    kind = (body.kind or "").strip()
    name = (body.name or "").strip()
    url = (body.image_url or "").strip()
    if kind not in ("character", "location", "prop"):
        raise HTTPException(status_code=400, detail="kind 只能是 character/location/prop")
    if not name:
        raise HTTPException(status_code=422, detail="缺少资产名")
    if not url:
        raise HTTPException(status_code=422, detail="缺少图片地址")

    with get_session() as session:
        shot = access.req_shot(session, shot_id)
        pid = shot.project_id
        if kind != "character":
            # 场景 / 道具：镜头级覆写。只动这一镜的 override，不碰资产表。
            try:
                ov = json.loads(shot.profile_override) if shot.profile_override else {}
            except (ValueError, TypeError):
                ov = {}
            # 归属（2026-10-22）：`refs` 从"一串网址"改成"网址 + 它属于谁"。
            #
            # 病根：refs 只存 URL，不记录这张图是哪件东西的。于是角色换演员、
            # 资产合并、重新拆解之后，那条 URL 还钉在镜头上，而它指向的角色可能
            # 早就不在这一镜里了——没有任何机制会把它清掉。生产实测（2026-10-22）：
            # 1055 个带手动 refs 的镜头里，**732 处**指向不在本镜 characters 的实体，
            # 涉及 37 个项目。用户看到的就是"这一镜莫名多带了一张别人的图"。
            #
            # 兼容：读侧同时接受裸字符串（存量数据的形态，见 jobs.run_shot_videos），
            # 写侧一律写 {url, kind, name}。不迁移存量——那是有损操作，要单独授权。
            refs = [u for u in (ov.get("refs") or [])
                    if isinstance(u, str) and u.strip()]
            ref_own = [o for o in (ov.get("ref_owners") or [])
                       if isinstance(o, dict) and o.get("url")]
            hide = [u for u in (ov.get("refs_hide") or []) if isinstance(u, str) and u.strip()]
            if url not in refs:
                refs.append(url)
            # 同一张图重复换到不同实体上时以后写为准（用户最后一次的意图）
            ref_own = [o for o in ref_own if o.get("url") != url]
            ref_own.append({"url": url, "kind": kind, "name": name})
            old = (body.old_url or "").strip()
            if old and old != url and old not in hide:
                hide.append(old)
            ov["refs"] = refs
            ov["ref_owners"] = ref_own
            if hide:
                ov["refs_hide"] = hide
            # 标签：上传的新图在资产表里查不到，"@图片N = 谁" 就会退化成
            # 「补充参考图」，提示词优化器没法把 @名字 转写成编号（等于白带）。
            # 所以这里把**明确知道的名字**写进 override，由 jobs 优先读它。
            labels = dict(ov.get("ref_labels") or {})
            labels[url] = f"{'场景' if kind == 'location' else '道具'}「{name}」"
            ov["ref_labels"] = labels
            shot.profile_override = json.dumps(ov, ensure_ascii=False)
            if shot.video_url:
                shot.refs_stale = 1
            session.commit()
            return {"ok": True, "kind": kind, "scope": "shot",
                    "message": f"只对这一镜生效；已换用新图，旧图不再带进本镜。"}

        # ---- 角色：建/改一条只圈住这一镜的造型阶段 ----
        from ..db import AssetStage
        from .. import stage_gate
        chk = (session.query(AssetStage)
               .filter(AssetStage.project_id == pid,
                       AssetStage.character_name == name,
                       AssetStage.deleted_at.is_(None)))
        stages = stage_gate.alive(chk).all()
        # 本集内的镜序（用于给造型起一个人类可读的名字）
        ep = int(shot.episode or 1)
        ep_orders = [o for (o,) in (session.query(Shot.order)
                                    .filter(Shot.project_id == pid, Shot.episode == ep)
                                    .order_by(Shot.order).all())]
        local = (ep_orders.index(shot.order) + 1) if shot.order in ep_orders else None
        auto_name = (f"第{ep}集 #{local} 换装" if local
                     else f"第{ep}集 #{shot.order} 换装")

        # ① 这一镜已经有"逐镜"造型（区间正好是这一镜）→ 就地换图，不新增行。
        #    不这么做的话，用户在同一镜换两次图就会留下一条永远赢不了的孤儿阶段。
        own = next((x for x in stages
                    if x.shot_from == shot.order and x.shot_to == shot.order), None)
        out: dict | None = None
        # ② 用户换的那张图正好是这位角色另一套造型的图 → 建指针行共用那张图
        same_img = next((x for x in stages
                         if (x.image_url or "").strip() == url
                         and x.source_stage_id is None), None)

        if own is not None:
            own.image_url = url
            own.source_stage_id = None      # 人工给了图 → 它自己就是源（同 patch_stage）
            if (body.description or "").strip():
                own.description = body.description.strip()
            session.commit()
            _after_stage_change(session, pid, own, shot)
            out = {"ok": True, "kind": kind, "scope": "stage", "created": False,
                   "stage_id": own.id, "stage_name": own.stage_name,
                   "message": f"已换图：这一镜仍由「{own.stage_name}」覆盖。"}
        else:
            st = AssetStage(
                id=uuid.uuid4().hex[:12], project_id=pid,
                character_name=name, stage_name=auto_name,
                ep_from=ep, ep_to=ep,
                shot_from=shot.order, shot_to=shot.order,
                image_url=None if same_img is not None else url,
                source_stage_id=same_img.id if same_img is not None else None,
                description=(body.description or "").strip() or (
                    same_img.description if same_img is not None else None),
                status="draft")
            # 一镜只归一套造型（2026-10-31，见 stage_coverage）：新建的这条接管这一镜，
            # 原本覆盖它的造型自动在这一镜上让开（被切开的后半段建成指针行，仍是同一张图）。
            from .stage_scene import _check_stage_ranges
            from ..stage_coverage import claim
            _check_stage_ranges(session, st)
            session.add(st)
            try:
                notes = claim(session, st)
            except ValueError as e:
                session.rollback()
                raise HTTPException(status_code=400, detail=str(e)) from None
            session.commit()
            out = {"ok": True, "kind": kind, "scope": "stage", "created": True,
                   "stage_id": st.id, "stage_name": st.stage_name,
                   "pointer": same_img is not None, "adjusted": notes,
                   "message": (f"已新建造型「{st.stage_name}」，范围只有这一镜"
                               + ("（沿用已有造型的图）" if same_img is not None else "")
                               + "。" + ("".join(notes) if notes else ""))}
            _after_stage_change(session, pid, st, shot)
        # 换图要落版本，否则这个造型换过多少次都只有一个版本（同 patch_stage）
        _rec_img = (same_img.image_url if same_img is not None and out["created"]
                    else url)
        _rec_id = out["stage_id"]
        _rec_label = f"{name} · {out['stage_name']}"
        _rec_desc = (body.description or "").strip() or None
    from ..asset_versions import record as _rec
    _rec(project_id=pid, kind="stage", target_id=_rec_id, image_url=_rec_img,
         prompt=_rec_desc, desc_in=_rec_desc, source="upload", label=_rec_label)
    return out


def _after_stage_change(session, project_id: str, st, shot) -> None:
    """造型换图之后：覆盖到的、已经出过片的镜头标 `refs_stale`。

    只标不重跑——重跑要花钱，由用户在页面上自己点。但不标的话，界面会显示
    "已出片、一切正常"，而画面里还是旧的那张脸。
    """
    lo = st.shot_from if st.shot_from is not None else -10 ** 9
    hi = st.shot_to if st.shot_to is not None else 10 ** 9
    # ⚠️ 不要写成 `st.shot_from or -10**9`：0 也是假值，会把它当成"不限"。
    q = session.query(Shot).filter(Shot.project_id == project_id,
                                   Shot.order >= lo, Shot.order <= hi,
                                   Shot.episode >= st.ep_from,
                                   Shot.episode <= st.ep_to)
    for x in q.all():
        if x.video_url:
            x.refs_stale = 1
    session.commit()


@router.post("/shots/{shot_id}/override")
def set_shot_override(shot_id: str, body: ShotOverrideIn) -> dict:
    """保存镜头级覆盖（模型/模式/时长/画质/参考素材/提示词，R1-1 三层策略）。"""
    with get_session() as session:
        shot = access.req_shot(session, shot_id)
        shot.profile_override = (
            json.dumps(body.profile_override, ensure_ascii=False)
            if body.profile_override else None)
        if body.is_special is not None:
            shot.is_special = 1 if body.is_special else 0
        session.commit()
        return {"ok": True, "shot_id": shot_id,
                "has_override": shot.profile_override is not None}


# ---------- 时间轴归一（P0-3）：镜头轨是唯一真源 ----------
# 设计：外部素材（片头/片尾/转场/实拍）作为 is_special=1 的镜头插入镜头轨，
# 与 AI 镜头共用同一条轨、同一套导出逻辑，不再有第二条"剪辑时间轴"。
# 轻剪辑只保留三件事：改时长（整数秒，上限随视频模型）、改顺序、停用。


class SpecialShotIn(BaseModel):
    project_id: str
    #: 展示名（片头/片尾/转场/实拍片段等）
    name: str
    #: 已上传素材的相对地址（/fw/media/uploads/xxx）
    video_url: str
    #: 插入位置：放在该 order 之后；缺省=追加到末尾
    after_order: Optional[int] = None
    duration_sec: Optional[float] = None


@router.post("/shots/special")
def add_special_shot(body: SpecialShotIn) -> dict:
    """把外部素材作为特殊镜头插入镜头轨（片头/片尾/转场/实拍）。"""
    with get_session() as session:
        if not session.get(Project, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        name = (body.name or "").strip()
        if not name:
            raise HTTPException(status_code=422, detail="name required")
        if not (body.video_url or "").strip():
            raise HTTPException(status_code=422, detail="video_url required")

        shots = (session.query(Shot).filter(Shot.project_id == body.project_id)
                 .order_by(Shot.order).all())
        # ⚠️ 快照必须在手动让位**之前**取（理由见 shot_timing.snapshot_anchors）
        snap = snapshot_anchors(session, body.project_id)
        # 造型阶段的镜号区间是**同一类锚点**（2026-10-22）：不一起搬，
        # 插入一镜就会让后面的造型整体错位到别的镜头/别的集上，且无提示。
        snap_st = snapshot_stage_ranges(session, body.project_id)
        if body.after_order is None:
            insert_at = (shots[-1].order + 1) if shots else 1
        else:
            insert_at = body.after_order + 1
            for s in shots:
                if s.order >= insert_at:
                    s.order += 1
        session.flush()

        dur = body.duration_sec
        if dur is not None:
            # 上限跟项目的视频模型走：粘贴一段 28s 的 2.5 长镜时，写死 15
            # 会让副本比原件短一半（时间轴上就是"粘贴出来的那条对不上"）。
            dur = max(1.0, min(shot_duration_ceiling(
                session.get(Project, body.project_id)), float(dur)))
        # 继承插入位置前一镜的集号，保证按集分组/集号色条不出现空洞
        prev_ep = 1
        for s in shots:
            if s.order < insert_at:
                prev_ep = s.episode
        shot = Shot(
            id=uuid.uuid4().hex[:12], project_id=body.project_id, order=insert_at,
            script_ref=name, link_to_prev="cut", characters="[]",
            location=None, video_url=body.video_url.strip(),
            episode=prev_ep, status="adopted", is_special=1,
            special_name=name, duration_sec=dur,
        )
        session.add(shot)
        session.flush()
        _renumber(session, body.project_id)
        remap_anchors_by_identity(session, body.project_id, snap)
        remap_stage_ranges_by_identity(session, body.project_id, snap_st)
        session.commit()
        return {"ok": True, "shot_id": shot.id, "order": shot.order}


class RefOverridesIn(BaseModel):
    """P1-2 资产轨拖拽落库：一次事务批量增删某角色/场景的注入覆写（L3）。

    语义（PLAN §4.4）：向外拖 → 被纳入的镜头进 shot_ids_add；向内拖 → 被排除的进
    shot_ids_remove；「↺ 重置为 AI 判定」→ reset_shot_ids（清掉该角色在这些镜头上的
    全部人工痕迹）。写入时与 L1（Shot.characters）对消：
    - add 且 L1 本来就有 → 只是撤销此前的 remove；
    - remove 且 L1 本来就没有 → 只是撤销此前的 add；
    保证 ref_overrides 里只存「与 AI 判定不同」的最小差集，重拆后语义依旧成立。
    P1-3：is_location=True 时 character 字段填场景名，覆写走 add_loc/remove_loc，
    L1 真值为 Shot.location（单值）。
    """
    project_id: str
    character: str
    shot_ids_add: list[str] = []
    shot_ids_remove: list[str] = []
    reset_shot_ids: list[str] = []
    is_location: bool = False


@router.post("/shots/ref-overrides")
def patch_ref_overrides(body: RefOverridesIn) -> dict:
    from ..db import effective_characters
    from ..scenes import canonical_locations, canonical_of
    char = (body.character or "").strip()
    if not char:
        raise HTTPException(status_code=422, detail="character required")
    ids = set(body.shot_ids_add) | set(body.shot_ids_remove) | set(body.reset_shot_ids)
    if not ids:
        return {"ok": True, "affected": [], "stale": []}
    if set(body.shot_ids_add) & set(body.shot_ids_remove):
        raise HTTPException(status_code=400, detail="同一镜头不能同时 add 和 remove")

    # 角色与场景共用同一套对消逻辑，仅 L1 取值与 JSON 键名不同
    k_add = "add_loc" if body.is_location else "add"
    k_rm = "remove_loc" if body.is_location else "remove"

    affected: list[dict] = []
    stale_orders: list[int] = []
    with get_session() as session:
        # 场景侧全程走**归一名**：场景轨展示的是归一名，用户点"移除"传回来的
        # 就是归一名。若拿它去比原名 L1（「夜 内 楚家公馆-客厅」），
        # 下面 `char in l1` 恒为假 → remove 压根不会写进去，移除**静默失效**。
        if body.is_location:
            char = canonical_of(session, body.project_id, char) or char

        def effective(s) -> list[str]:
            return (canonical_locations(session, body.project_id, s)
                    if body.is_location else effective_characters(s))

        shots = (session.query(Shot)
                 .filter(Shot.project_id == body.project_id, Shot.id.in_(ids))
                 .order_by(Shot.order).all())
        found = {s.id for s in shots}
        missing = ids - found
        if missing:
            raise HTTPException(status_code=404,
                                detail=f"镜头不存在或不属于该项目: {sorted(missing)}")
        for s in shots:
            before = set(effective(s))
            if body.is_location:
                cn = canonical_of(session, body.project_id, s.location)
                l1 = {cn} if cn else set()
            else:
                try:
                    l1 = {c for c in json.loads(s.characters or "[]")
                          if isinstance(c, str) and c}
                except json.JSONDecodeError:
                    l1 = set()
            try:
                ov = json.loads(s.ref_overrides) if s.ref_overrides else {}
            except json.JSONDecodeError:
                ov = {}
            add = [c for c in ov.get(k_add, []) if isinstance(c, str)]
            remove = [c for c in ov.get(k_rm, []) if isinstance(c, str)]
            if body.is_location:
                # 存量覆写里可能还是原名，与归一后的 char 比不相等 →
                # "撤销加入/撤销排除"会失效。写回前就地归一，顺手把老数据洗干净。
                add = list(dict.fromkeys(
                    x for x in (canonical_of(session, body.project_id, c)
                                for c in add) if x))
                remove = list(dict.fromkeys(
                    x for x in (canonical_of(session, body.project_id, c)
                                for c in remove) if x))

            if s.id in set(body.reset_shot_ids):
                add = [c for c in add if c != char]
                remove = [c for c in remove if c != char]
            elif s.id in set(body.shot_ids_add):
                remove = [c for c in remove if c != char]      # 撤销排除
                if char not in l1 and char not in add:
                    add.append(char)                            # 真值没有才需显式 add
            else:  # shot_ids_remove
                add = [c for c in add if c != char]             # 撤销加入
                if char in l1 and char not in remove:
                    remove.append(char)                         # 真值有才需显式 remove

            # 只存最小差集；全空则回 NULL（= 完全跟随 AI 判定）
            keep = {k: v for k, v in ov.items() if k not in (k_add, k_rm)}
            if add:
                keep[k_add] = add
            if remove:
                keep[k_rm] = remove
            s.ref_overrides = (json.dumps(keep, ensure_ascii=False) if keep else None)

            after = set(effective(s))
            changed = after != before
            # 已出片镜头的注入集合真的变了 → 标记待重生成（不自动重跑，避免烧钱）
            if changed and s.video_url:
                s.refs_stale = 1
                stale_orders.append(s.order)
            affected.append({"shot_id": s.id, "order": s.order,
                             "changed": changed,
                             "effective_characters": sorted(after),
                             "refs_stale": bool(s.refs_stale)})
        session.commit()
    return {"ok": True, "affected": affected, "stale": sorted(stale_orders)}


def transform_rev(raw: str | None) -> str:
    """`transform_meta` 的版本号（2.3 乐观锁）——**由内容算出，不新增列**。

    为什么不加 `updated_at`/`version` 列：
      · 新列对**老数据**一律是 NULL/0，那批镜头等于没有锁，而它们恰恰是
        用户手里最多的数据；内容哈希对每一行**当场就有效**。
      · 哈希的语义正是锁要表达的那句话——「我这次改动是基于这份内容的」。
        两个端各自把同一个值写一遍时（例如都把 opacity 拖到 100）内容相同、
        rev 相同，不会冒出一个假冲突；而列式版本号会。

    已知且可接受的边界：A→B→A 的回退会让 rev 回到 A，此时持有旧 rev 的端
    可以写入——但它写的确实是**基于当前内容**的改动，不存在"盖掉了谁的东西"，
    所以这不是 ABA 漏洞，只是"没有冲突"。

    取 sha1 前 12 位：这是并发检测用的短令牌，不是安全用途；
    每次写入都会换值，碰撞的后果最坏也只是漏掉一次冲突提示。
    """
    if not raw:
        return "0"           # 没有任何调整也要有个稳定的版本号，否则首次写入无从比对
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


class ShotTimelineIn(BaseModel):
    """轻剪辑：时长 / 顺序 / 停用 / 画面调整。各项都可单独下发。"""
    #: 目标时长（秒）；服务端按 2 位小数钳到 [1, 模型单镜上限]。
    #: 小数是刻意允许的（3.2）：剪辑的落点由台词/动作决定，不会正好落在整秒。
    duration_sec: Optional[float] = None
    #: 目标位置（1-based order）；移动后全项目重新连续编号
    to_order: Optional[int] = None
    disabled: Optional[bool] = None
    #: TB-03/TB-10 画面与音频调整（缩放/旋转/位移/不透明度/镜像/变速/音量/淡化）。
    #: 传空字典 {} = 清除全部调整，回到原始画面。
    transform_meta: Optional[dict] = None
    #: 2.3 乐观锁：客户端这次改动**所基于的** transform_meta 版本号
    #: （见 transform_rev()，由 /detail 与本接口的响应下发）。
    #: 与当前库里的不一致 → 409，不静默覆盖。
    #: None = 不做并发校验（老客户端、以及只改时长/顺序的调用）。
    base_transform_rev: Optional[str] = None
    #: Render V2 多轨：移到第几条视频轨（0=主轨，1+=Overlay）
    track_index: Optional[int] = None
    #: 移到 Overlay 轨时的起始秒（主轨忽略）
    overlay_start_sec: Optional[float] = None
    #: 3.1 取片窗口的入点（秒，相对**素材**开头）。导出与字幕定时读的是窗口，
    #: 不是 duration_sec —— 所以"左边缘修剪"必须走这里，改 duration_sec 没用。
    clip_in_sec: Optional[float] = None
    #: 3.1 取片窗口的长度（秒）。落库时**同步回写 duration_sec**，见下方不变式说明。
    clip_dur_sec: Optional[float] = None
    #: 3.1 取消入点：把 clip_in_sec / clip_dur_sec 一起清空（回到"整段使用"）。
    #: 需要一个显式开关是因为 None 已经表示"本次不动该字段"，无法用它表达"清空"。
    clear_clip_window: Optional[bool] = None


@router.patch("/shots/{shot_id}/timeline")
def patch_shot_timeline(shot_id: str, body: ShotTimelineIn) -> dict:
    """镜头轨上的轻剪辑操作（唯一真源，导出直接消费本表）。"""
    with get_session() as session:
        shot = access.req_shot(session, shot_id)

        # 2.3 乐观锁：校验放在**任何改动之前**——本接口一次可以同时改时长、
        # 顺序和画面，若先改了前两项再发现画面冲突，用户会得到一次"半成功"的
        # 保存（时长变了、画面没变，而提示只说了冲突）。这里直接拒整笔。
        if body.transform_meta is not None and body.base_transform_rev is not None:
            cur = transform_rev(shot.transform_meta)
            if cur != body.base_transform_rev:
                raise HTTPException(
                    status_code=409,
                    detail=(f"该镜头的画面调整已被其他窗口修改"
                            f"（当前版本 {cur}，你基于 {body.base_transform_rev}）"),
                )

        if body.duration_sec is not None:
            # 钳到 [1, 模型单镜上限]。上限**不是常数 15**：seedance-2.5 是 30s，
            # 见 shot_duration_ceiling。
            #
            # 3.2：这里原来是 `round(float(...))` —— **整数秒**。那不是精度问题，
            # 是"这个软件不能用来剪片"：一句台词说完在 2.4s，用户只能选 2s
            # （切掉半个字）或 3s（留 0.6s 空镜），而且前端拖到 2.4 也会被这一行
            # 悄悄改成 2，用户看到的是"我拖了它自己弹回去"。
            # 改为保留 2 位小数（与 split_shot 的 round(x, 2) 同精度）。
            # 生成侧不受影响：provider 自己会 int(round(duration_ms/1000)) 并
            # 吸附到 duration_slots，小数进得去、出来仍是合法档位。
            # ⚠️ 用**这一镜实际生效的模型**算上限（2026-10-20）：镜头可以单独
            # 换模型，项目用 2.0 建、这镜改成 2.5 时上限应是 30 而不是 15。
            ceil = shot_override_ceiling(session, shot)
            shot.duration_sec = float(
                max(1.0, min(float(ceil), round(float(body.duration_sec), 2))))
        # ---- 3.1 取片窗口（入点/出点）----
        #
        # 顺序要紧：窗口在 duration_sec 之后处理，因为写窗口长度时要**同步回写**
        # duration_sec 以维持不变式，必须盖在上面那一段之后。
        #
        # 不变式：`duration_sec == clip_dur_sec`（窗口存在时）。
        # `split_shot` / `unsplit_shot` 一直在维持它，本接口是第三个写入者。
        # 不维持会怎样：时间轴按 duration_sec 排版、导出按 clip_dur_sec 取片，
        # 于是"轨上是 2.4s、成片里是 5s"，且没有任何提示 —— 这正是 3.2 落地后
        # 仍然残留的那个缺口（改右边缘对 split 过的镜头不生效）。
        if body.clear_clip_window:
            # 取消入点：回到"整段使用"。**不动 duration_sec** ——
            # 后端不知道源文件多长，能诚实做到的只是"起点回到 0，长度不变"。
            shot.clip_in_sec = None
            shot.clip_dur_sec = None
        if body.clip_in_sec is not None:
            shot.clip_in_sec = max(0.0, round(float(body.clip_in_sec), 2))
        if body.clip_dur_sec is not None:
            # 下界取 0.1 而不是 1.0：`split_shot` 只保证两侧各留 0.5s，
            # 库里真实存在 0.75s / 0.99s 的碎片。若这里 floor 到 1.0，
            # 用户拖一个 0.75s 的碎片会被**拉长**成 1.0s —— 想剪短反而变长。
            # 窗口是"在已有素材上取片"，不受生成侧时长档位约束；
            # 上面那条 duration_sec 分支的 1.0 下界保持不动（那里它还是生成目标）。
            ceil2 = shot_override_ceiling(session, shot)
            shot.clip_dur_sec = float(
                max(0.1, min(float(ceil2), round(float(body.clip_dur_sec), 2))))
            shot.duration_sec = shot.clip_dur_sec       # ← 不变式，见上
        if shot.clip_in_sec is not None and shot.clip_dur_sec is None:
            # 只给了入点、没给长度：这是**半个窗口**，而它是有害的 ——
            # 导出侧读 `clip_in_sec ?? 0` 作为 -ss、读 `clip_dur_sec ?? duration_sec`
            # 作为 -t，于是成片会从入点起取满 duration_sec（比用户看到的长）；
            # 而前端判"有没有窗口"看的是 clip_dur_sec，会认为这镜没被修剪过。
            # 补齐成完整窗口，两边口径就一致了。正常调用方（inPatch）总是两个一起发，
            # 这里是兜住"将来有人只发一半"的结构性防线。
            shot.clip_dur_sec = float(shot.duration_sec or 0) or None
        if body.track_index is not None:
            # 移到 Overlay 轨的镜头不再参与主轨顺序累加，必须有显式起点，
            # 否则它会"消失"在时间轴上（既不排队也没有位置）
            shot.track_index = max(0, int(body.track_index))
            if shot.track_index > 0 and shot.overlay_start_sec is None:
                shot.overlay_start_sec = 0.0
        if body.overlay_start_sec is not None:
            shot.overlay_start_sec = max(0.0, float(body.overlay_start_sec))
        if body.transform_meta is not None:
            # TB-03/TB-10：空字典视为"清除全部调整"，存 NULL 让导出走常规快路径
            shot.transform_meta = (json.dumps(body.transform_meta, ensure_ascii=False)
                                   if body.transform_meta else None)
        if body.disabled is not None:
            shot.disabled = 1 if body.disabled else 0
        if body.to_order is not None:
            others = (session.query(Shot)
                      .filter(Shot.project_id == shot.project_id, Shot.id != shot.id)
                      .order_by(Shot.order).all())
            tgt = max(1, min(len(others) + 1, int(body.to_order)))
            # ⚠️ 重排序同样要按身份回填锚点：下面把 order 直接写成了 1..N 的
            #    排列，`_renumber` 反推出的 mapping 恒为空。不补这一步，
            #    拖一次镜头就会让它之后的所有旁白/字幕挂到别的镜头上。
            snap = snapshot_anchors(session, shot.project_id)
            snap_st = snapshot_stage_ranges(session, shot.project_id)
            # 其余镜头按目标位让位，自己占住 tgt，再统一重排收敛为 1..N
            for i, s in enumerate(others, start=1):
                s.order = i if i < tgt else i + 1
            shot.order = tgt
            session.flush()
            _renumber(session, shot.project_id)
            remap_anchors_by_identity(session, shot.project_id, snap)
            remap_stage_ranges_by_identity(session, shot.project_id, snap_st)

        session.commit()
        return {"ok": True, "shot_id": shot.id, "order": shot.order,
                "duration_sec": shot.duration_sec, "disabled": bool(shot.disabled),
                # 3.1：把落库后的取片窗口回给客户端。前端拖左边缘是"出点钉住、
                # 入点跟手"，下一次拖动要基于**服务端认定的**入点算，
                # 不回传就只能等一次 /detail，中间那一下会基于旧入点算出错位的窗口。
                "clip_in_sec": shot.clip_in_sec, "clip_dur_sec": shot.clip_dur_sec,
                # 2.3：把落库后的新版本号一并回给客户端，让它**不必**等一次
                # /detail 就能继续连着改（连续拖动是常态，中间少一个 GET
                # 也少一个"用旧 rev 撞上自己刚写的值"的假冲突窗口）。
                "transform_rev": transform_rev(shot.transform_meta)}


class ShotBreakdownIn(BaseModel):
    """镜头拆解结果的人工修正。各项都可单独下发（None = 不动该字段）。

    用途：AI 拆镜难免有偏差（把两个动作并成一镜、认错出场角色、场景名写岔）。
    此前只能重跑整集拆解，会把用户已经调好的其他镜头一起冲掉；现在可以单镜改。
    """
    #: 该镜对应的剧本片段（提示词的原始依据）
    script_ref: Optional[str] = None
    #: 出场角色名列表。注意：这里改的是**拆解真值**，与 ref_overrides 的
    #: 人工增删是两层——那层是"注入时加/减谁"，这层是"这镜里到底有谁"。
    characters: Optional[list[str]] = None
    location: Optional[str] = None
    #: continuous = 与上一镜连续；transition = 与上一镜之间有转场
    link_to_prev: Optional[str] = None


@router.patch("/shots/{shot_id}/breakdown")
def patch_shot_breakdown(shot_id: str, body: ShotBreakdownIn) -> dict:
    """修正单镜的拆解结果。

    **不自动重算提示词**：重算要调文本模型花钱，用户可能连着微调好几个字段，
    每次都触发就是反复烧钱。改完置 stale，由用户显式点「重新生成提示词」。
    """
    with get_session() as session:
        shot = access.req_shot(session, shot_id)

        changed: list[str] = []
        if body.script_ref is not None:
            new_ref = body.script_ref.strip()
            if not new_ref:
                raise HTTPException(status_code=400, detail="script_ref 不能为空")
            if new_ref != (shot.script_ref or ""):
                shot.script_ref = new_ref
                changed.append("script_ref")
        if body.characters is not None:
            # 去空白去重但保持顺序：顺序决定参考图注入的优先级（前面的先占位）
            seen: set[str] = set()
            names = []
            for c in body.characters:
                n = (c or "").strip()
                if n and n not in seen:
                    seen.add(n)
                    names.append(n)
            if json.dumps(names, ensure_ascii=False) != (shot.characters or "[]"):
                shot.characters = json.dumps(names, ensure_ascii=False)
                changed.append("characters")
        if body.location is not None:
            loc = body.location.strip() or None
            # N3：拆解偶尔把镜号前缀（如「5-1」）写进 location，导致同一个物理空间
            # 在 Asset 里分裂成多个不同名字的场景资产。在写库前清洗掉前缀。
            from ..scene_desc import strip_shot_prefix
            if loc:
                loc = strip_shot_prefix(loc) or loc
            if loc != shot.location:
                shot.location = loc
                changed.append("location")
        if body.link_to_prev is not None:
            lp = body.link_to_prev.strip()
            if lp not in ("continuous", "transition"):
                raise HTTPException(status_code=400,
                                    detail="link_to_prev 只能是 continuous / transition")
            if lp != shot.link_to_prev:
                shot.link_to_prev = lp
                changed.append("link_to_prev")

        if changed:
            # 拆解变了 → 现有提示词与已出片都基于旧拆解，标过期提醒重生。
            # 不删 video_url：用户可能只是修个错别字，不该把片子弄没。
            # reprompt 而非 rebreak：切分没动，重出提示词 + 重出片即可，
            # 不必把整集拆解推倒（那会作废本集其它镜头已出的片）。
            stale_mod.mark_stale(shot, stale_mod.REPROMPT)
        session.commit()
        # 拆解改了 location / link_to_prev → 连续段切分可能变，丢掉缓存。
        # 不丢的话，本进程后续的 `_scene_run_ctx` 会按旧分组算 k/n 与 anchor。
        # （只清本进程；别的进程的缓存由它自己的入口失效，见 continuity 的说明。）
        if "location" in changed or "link_to_prev" in changed:
            from ..continuity import invalidate_run_cache
            invalidate_run_cache(shot.project_id)
        return {"ok": True, "shot_id": shot.id, "changed": changed,
                "stale": bool(shot.stale), "stale_reason": shot.stale_reason}


class ShotPromptIn(BaseModel):
    """直接改提示词（跳过 AI 重写）。"""
    gen_prompt: str


@router.patch("/shots/{shot_id}/prompt")
def patch_shot_prompt(shot_id: str, body: ShotPromptIn) -> dict:
    """保存用户手改的提示词，并保证它**真的会被下发**。

    ⚠️ 只写 gen_prompt 是不够的：run_shot_videos 里只有纯文生视频才直接用
    gen_prompt，一旦有参考图（全参考/首帧路线，也就是绝大多数情况）就会带
    ctx 重新优化一遍，用户改的词会被 AI 悄悄重写回去。
    真正的"不被覆盖"通道是 profile_override.prompt（jobs.py:983 第一优先级），
    所以两处都写：gen_prompt 供 UI 展示，override 供生成时实际取用。

    ⚠️ 2026-10-07：入口先过一遍 `strip_editor_chrome`。提示词编辑区是
    `contenteditable`，前端失焦保存读的是 `innerText`——一旦编辑器把 `@名字`
    渲染成 chip，chip 的 HTML 属性就可能被存进来（生产上确实发生过，
    3 个镜头的 `gen_prompt` / `profile_override` 都被写进了
    `data-src="…" title="角色「断臂@幸存者」">` 这种残渣）。
    前端已修，但存量与其它写入路径都可能有，所以**后端自己再挡一道**。
    """
    with get_session() as session:
        shot = access.req_shot(session, shot_id)
        text = strip_editor_chrome(body.gen_prompt or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="提示词不能为空")
        shot.gen_prompt = text
        shot.prompt_state = "manual"
        ov = json.loads(shot.profile_override) if shot.profile_override else {}
        ov["prompt"] = text
        shot.profile_override = json.dumps(ov, ensure_ascii=False)
        session.commit()
        return {"ok": True, "shot_id": shot.id, "prompt_state": "manual"}


class ShotPromptReviseIn(BaseModel):
    """按**意图**改提示词（不是逐字替换）。"""

    #: 用户那句话，例如「把雨改成雪」「这句台词别念出来，改成打字屏」。
    instruction: str
    #: true = 直接落库；false = 只回 before/after 给人看（默认 false）。
    #:
    #: 为什么默认不落库：改写是模型重新生成整段，用户要的是**先看再决定**。
    #: 直接落库等于让一次误解覆盖掉他刚校对好的稿子，而旧稿只存在返回值里。
    save: bool = False


def _shot_script_gone(what: str) -> HTTPException:
    """「镜头脚本改由 Muse 撰写」的统一 410（2026-11-19 用户裁定）。

    镜流自带的提示词引擎（按规则生成 / 按意图改写 / 交还 AI 重写）已整体删除，
    镜流只负责存与出片。网页上对应的按钮还在，所以用 410 + 一句人话，
    而不是 404：前端据此能提示「这个功能没了，去让 Muse 写」。
    """
    from ..jobs import SHOT_SCRIPT_BY_MUSE
    return HTTPException(status_code=410, detail=f"{SHOT_SCRIPT_BY_MUSE}，{what}已下线")


@router.post("/shots/{shot_id}/prompt/revise")
async def revise_shot_prompt(shot_id: str,
                             body: Optional[ShotPromptReviseIn] = None) -> dict:
    """（已下线，恒 410）原「按用户意图让 AI 重写这一镜的视频提示词」。

    镜头脚本由 Muse 撰写并锁定；要改就让 Muse 改完用 `set_shot_prompt(lock=true)`
    写回，或在编辑器里手改后走 `PATCH /shots/{id}/prompt`。
    """
    raise _shot_script_gone("「AI 改写提示词」")


@router.delete("/shots/{shot_id}/prompt")
def reset_shot_prompt(shot_id: str) -> dict:
    """（已下线，恒 410）原「撤销手改，把提示词交还给 AI，下次生成重新优化」。

    现在没有可以交还的 AI：出片只认锁定的镜头脚本（`profile_override.prompt`），
    清掉它这一镜就出不了片。要换稿直接写新的（Muse `set_shot_prompt(lock=true)`
    或 `PATCH /shots/{id}/prompt`），旧稿会被新稿替换。
    """
    raise _shot_script_gone("「交还 AI 重写」")


class ShotSplitIn(BaseModel):
    """TB-01 镜头分割：在镜内第 at_sec 秒把一个镜头切成前后两段。"""

    at_sec: float


@router.post("/shots/{shot_id}/split")
def split_shot(shot_id: str, body: ShotSplitIn) -> dict:
    """在镜内指定秒处把镜头拆成两段（时间轴 Ctrl+B）。

    语义（为什么这样切）：

    - **后半段是一个新镜头行**，紧跟在原镜之后，order 由 _renumber 收敛。
      不复用原行是因为版本历史（ShotVersion）挂在 shot_id 上，复用会让
      "后半段"莫名其妙继承前半段的全部生成版本。

    - **视频与首帧不做实际裁剪**：后半段沿用同一个 video_url。真正按秒裁剪
      要重新转码（几十秒到几分钟），放在这个同步接口里会把请求挂死。
      导出时 media.py 已支持 -ss/-t 裁剪，届时按 clip_in/clip_dur 消费即可。
      因此这里把切点记进新增的两个字段，导出与预览据此取片段。

    - **后半段是派生行，不是新的待生成镜头**：status 沿用原镜，避免它被
      "生成待出片镜头"当成缺片镜头又烧一次钱。

    - 参考注入（characters/location/ref_overrides）整份复制：切开的两段在
      剧情上仍是同一场戏，参考资产理应一致。
    """
    with get_session() as session:
        shot = access.req_shot(session, shot_id)

        dur = float(shot.duration_sec or 5.0)
        at = float(body.at_sec)
        # 两侧各留 0.5s，避免切出 0 长度的段（导出时 -t 0 会产出空文件）
        if at <= 0.5 or at >= dur - 0.5:
            raise HTTPException(
                status_code=422,
                detail=f"切点需在 0.5s 与 {dur - 0.5:.1f}s 之间（当前镜头时长 {dur:.1f}s）")

        base_in = float(getattr(shot, "clip_in_sec", None) or 0.0)

        # 后半段
        tail = Shot(
            id=uuid.uuid4().hex[:12], project_id=shot.project_id,
            order=shot.order + 1,
            script_ref=shot.script_ref,
            link_to_prev="continuous",
            characters=shot.characters,
            location=shot.location,
            video_url=shot.video_url,
            thumb_url=shot.thumb_url,
            first_frame_url=None,          # 后半段的首帧不是原首帧，留空更诚实
            episode=shot.episode,
            status=shot.status,
            profile_override=shot.profile_override,
            is_special=shot.is_special,
            adopted_version=shot.adopted_version,
            gen_prompt=shot.gen_prompt,
            prompt_state=shot.prompt_state,
            # 走位台账也要复制：切开的两段是同一场戏的连续两半，
            # 后半段的下一镜同样需要"上一镜结束时谁在哪"。
            # 不复制的话后半段台账为空 → 它的下一镜拿不到任何位置约束
            # （见 docs/PLAN-跨镜站位一致性.md §2-C）。
            # ⚠️ 台账是"本镜**结束**时刻"的状态，而后半段是第一半的延续、
            # 结尾状态与整镜相同，所以整份复制在语义上是对的。
            blocking_out=shot.blocking_out,
            present_characters=shot.present_characters,
            stale=shot.stale,
            stale_reason=shot.stale_reason,   # 分割出的后半段与原镜同因同命
            duration_sec=round(dur - at, 2),
            disabled=shot.disabled,
            special_name=shot.special_name,
            ref_overrides=shot.ref_overrides,
            refs_stale=shot.refs_stale,
            clip_in_sec=base_in + at,
            clip_dur_sec=round(dur - at, 2),
            # ⚠️ 派生字段必须显式复制（2026-10-24 修）：`Shot(...)` 是**新建一行**，
            # 没写进构造参数的列一律取默认值。此前这里漏了 `transform_meta`，
            # 于是"分割一个已经变速过的镜头"会让后半段**变回原速** ——
            # 前半段仍是 1.7 倍、后半段是 1.0，两段画面接在一起就跳一下，
            # 而且用户完全看不出原因（两边时长都对得上，只有播放速度不同）。
            # 变速是"这一镜怎么播"，切开的两段是同一段素材的连续两半，
            # 速度理应一致。
            #
            # 顺带把同源的其它派生状态一并带上：颜色（lut）与已擦字幕区间（desub）
            # 同样是"对这段画面做的事"，不复制会让后半段掉调色、字幕重新冒出来。
            # `crop` 是构图，两段同源同构图，也照搬。
            transform_meta=shot.transform_meta,
        )
        # 前半段：只改时长与裁剪窗口
        shot.duration_sec = round(at, 2)
        shot.clip_in_sec = base_in
        shot.clip_dur_sec = round(at, 2)

        # ⚠️ 快照必须在**改 order 之前**取：往下那一步手动 +1 之后，order 序列
        #    就已是连续的 1..N，`_renumber` 反推不出任何映射，锚点会原地不动
        #    → 被分割镜之后的所有旁白/字幕整体挂到别的镜头上。
        snap = snapshot_anchors(session, shot.project_id)
        # 分割会让后面所有镜头 +1，造型区间必须同步（2026-10-22）
        snap_st = snapshot_stage_ranges(session, shot.project_id)
        # 给后面的镜头让位
        for s in (session.query(Shot)
                  .filter(Shot.project_id == shot.project_id,
                          Shot.order > shot.order).all()):
            s.order += 1
        session.add(tail)
        session.flush()
        _renumber(session, shot.project_id)
        remap_anchors_by_identity(session, shot.project_id, snap)
        remap_stage_ranges_by_identity(session, shot.project_id, snap_st)
        session.commit()
        return {"ok": True, "head_shot_id": shot.id, "tail_shot_id": tail.id,
                "head_order": shot.order, "tail_order": tail.order,
                "head_duration": shot.duration_sec, "tail_duration": tail.duration_sec}


class ShotUnsplitIn(BaseModel):
    """撤销分割：把 tail_shot_id 那一段合回本镜（Ctrl+B 的逆操作）。"""

    tail_shot_id: str


@router.post("/shots/{shot_id}/unsplit")
def unsplit_shot(shot_id: str, body: ShotUnsplitIn) -> dict:
    """把 split_shot 切出来的后半段合回前半段——即 Ctrl+B 的撤销。

    没有这个端点的话 Ctrl+B 就是不可撤销的：后半段是一个 is_special=0 的
    AI 镜头行，而 `delete_shot` 明确拒绝删 AI 镜头，前端凑不出逆操作。

    校验从严，宁可 409 也不做"尽力而为的合并"——合错了会静默吞掉用户
    在后半段上做的工作（重新生成的版本、改过的提示词/时长）：

      · 必须同项目、tail 紧跟在 head 之后（order 相邻）
      · 必须同一条 video_url（后半段被单独重新生成过就不是原来那一刀了）
      · 裁剪窗口必须首尾相接（tail.clip_in == head.clip_in + head.clip_dur）
      · tail 不能有自己的版本历史（有就说明它被单独生成过）
    """
    with get_session() as session:
        head = access.req_shot(session, shot_id)
        tail = access.req_shot(session, body.tail_shot_id)
        if head.project_id != tail.project_id:
            raise HTTPException(status_code=422, detail="两个镜头不属于同一项目")
        if tail.order != head.order + 1:
            raise HTTPException(
                status_code=409,
                detail=f"两段已不相邻（#{head.order} / #{tail.order}），无法合并")
        if (head.video_url or "") != (tail.video_url or ""):
            # 两种来源，文案必须分开：`split` 切出来的两段**同源**，url 不等就
            # 只能是"后半段被单独重新生成过"；而 `recut` 切出来的 B 段本来就
            # 没有 url（`video_url=None` 是它的定义，见 recut_shot），合并它是
            # 另一件事、失败原因也完全不同。混用一句话会把划线用户吓一跳：
            # 他会以为自己刚切的那段被谁偷偷生成过了。
            if not head.video_url and not tail.video_url:
                raise HTTPException(
                    status_code=409, detail="这两段都还没有画面，合并起来没有意义")
            if not tail.video_url:
                raise HTTPException(
                    status_code=409,
                    detail="后半段是待重新生成的区间（还没有画面），"
                           "删除它即可取消这次划分")
            raise HTTPException(
                status_code=409, detail="后半段已被重新生成，合并会丢失该结果")
        if session.query(ShotVersion).filter(ShotVersion.shot_id == tail.id).count():
            raise HTTPException(
                status_code=409, detail="后半段已有独立的生成版本，合并会丢失它们")

        h_in = float(getattr(head, "clip_in_sec", None) or 0.0)
        h_dur = float(getattr(head, "clip_dur_sec", None) or head.duration_sec or 0.0)
        t_in = float(getattr(tail, "clip_in_sec", None) or 0.0)
        t_dur = float(getattr(tail, "clip_dur_sec", None) or tail.duration_sec or 0.0)
        if abs((h_in + h_dur) - t_in) > 0.05:
            raise HTTPException(
                status_code=409,
                detail="两段的裁剪窗口已不连续（时长被单独改过），无法合并")

        merged = round(h_dur + t_dur, 2)
        head.duration_sec = merged
        head.clip_in_sec = h_in
        head.clip_dur_sec = merged
        pid = head.project_id
        session.delete(tail)
        session.flush()
        _renumber(session, pid)
        session.commit()
        return {"ok": True, "shot_id": head.id,
                "order": head.order, "duration": merged}


class ShotRecutIn(BaseModel):
    """3.11 R2：把镜头划成 三段 A|B|C，只让 **B 段**重新生成。

    两个切点都是**镜内秒**（与 `split` 的 `at_sec` 同口径，不是素材秒）。
    必须满足 `0 < cut_a < cut_b < duration` 且两侧各留边距。
    """

    cut_a: float
    cut_b: float


@router.post("/shots/{shot_id}/recut")
def recut_shot(shot_id: str, body: ShotRecutIn) -> dict:
    """把一镜划成 A|B|C 三段，B 段置为"待重新生成"（3.11 R2，用户要的"只重做中间一段"）。

    用户的原话就是这个需求：一个 10s 片段，前 3s 和后 3s 可用，中间 4s 要重做。

    为什么是"切成三段"而不是"原地替换中段"：

    - 原地替换要不转码就把三段拼回去**做不到**。`split_shot` 早就为同一个
      理由拒绝过转码（几十秒到几分钟的同步操作会把请求挂死），这里沿用同一
      条架构决策：三段各自记住自己的取片窗口，导出时按 `-ss/-t` 取片，
      成片里照样是连续的。代价只是镜头列表多两行。

    - 复用现成的两个原语（窗口 + `stale`），所以**可撤销**：
      `unsplit` 能把相邻两段合回去，且它的校验（同 video_url / 窗口首尾相接 /
      tail 无独立版本）在这里全都成立。

    与 `split_shot` 的三处关键差别：

    1. **一次成型**。调两次 `split` 也能切出三段，但那样中间段的 `clip_in`
       会被算成相对"第二刀"的偏移（第二刀是在*前半段*的坐标系里切的），
       窗口会错位。这里从**原始窗口**一次算出三段，没有中间坐标系。
    2. **B 段 `video_url=None` 且置 stale（原因 `recut`）**。`split` 出来的
       两段都有片（本就是同一条片子的两半），而 B 段是要**被替换**的那一段，
       留着旧 `video_url` 会让用户/导出以为它已经出好了。
    3. **B 段没有自己的提示词**。它继承的是原镜那一整段的 `script_ref`，
       直接出片 = 拿一整段剧本去生中间 4 秒，内容必然对不上。所以标记为
       `recut`（`needs_prompt_rebuild` 为真 ⇒ 出片前会弃用继承来的
       `gen_prompt` 并从 `script_ref` 重新优化），且前端**不提供**
       "划完立刻批量出片"的快捷入口。用户在出片前该自己改这一段的依据。
    """
    with get_session() as session:
        shot = access.req_shot(session, shot_id)

        dur = float(shot.duration_sec or 0.0)
        if dur <= 0:
            raise HTTPException(status_code=422, detail="该镜还没有时长，无法划定区间")
        if shot.is_special:
            raise HTTPException(
                status_code=422,
                detail="外部素材镜头没有可重新生成的画面依据，请用分割/修剪")

        a = float(body.cut_a)
        b = float(body.cut_b)
        margin = 0.5
        if not (margin <= a < b <= dur - margin):
            raise HTTPException(
                status_code=422,
                detail=f"两个切点需在 {margin}s 与 {dur - margin:.1f}s 之间且不能重合"
                       f"（当前镜头时长 {dur:.1f}s）")

        # 下限：B 段要真的能出片。各家模型的下限不同（seedance 系列 4s、veo 8s、
        # H3 2s），按**项目当前视频模型**取，走 `min_seconds()` —— 与时长上限
        # `shot_duration_ceiling` 同一份事实来源（provider 的 duration_slots），
        # 不另立一份写死的表。
        # 拿不到模型（老项目/档案缺 video_model）时退回 4s：这是 seedance 的口径，
        # 也是本改动之前的时间轴默认。宁可偶尔放行一个偏短的请求（出片时 provider
        # 会明确报错），也别拿一个凭空的数字把用户的正常划线拦下来。
        floor = _RECUT_MIN_FALLBACK
        _proj = session.get(Project, shot.project_id)
        _model = str((profile_of(_proj) if _proj else {}).get("video_model") or "").strip()
        _p = registry.get_video(_model) if _model else None
        _floor = _p.min_seconds() if _p is not None else None
        if _floor and _floor > 0:
            floor = float(_floor)
        mid = b - a
        if mid < floor:
            raise HTTPException(
                status_code=422,
                detail=f"中间段只有 {mid:.1f}s，短于可生成的最短时长 {floor:.1f}s")

        base_in = float(getattr(shot, "clip_in_sec", None) or 0.0)

        # ---- B 段：待重生成。参考注入整份复制（同一场戏，参考资产理应一致）----
        mid_shot = Shot(
            id=uuid.uuid4().hex[:12], project_id=shot.project_id,
            order=shot.order + 1,
            script_ref=shot.script_ref,
            link_to_prev=shot.link_to_prev,
            characters=shot.characters,
            location=shot.location,
            # 没有片：这一段就是被替换掉的那一段
            video_url=None,
            thumb_url=None,
            first_frame_url=None,
            episode=shot.episode,
            status="pending",
            profile_override=shot.profile_override,
            is_special=False,
            adopted_version=None,
            gen_prompt=shot.gen_prompt,
            prompt_state=shot.prompt_state,
            stale=True,
            stale_reason=stale_mod.RECUT,
            duration_sec=round(mid, 2),
            disabled=shot.disabled,
            special_name=None,
            ref_overrides=shot.ref_overrides,
            refs_stale=shot.refs_stale,
            track_index=shot.track_index,
            # 窗口留空：新生成的片是**独立的素材**，不该继承原素材的坐标。
            # （出片成功后 jobs.py 会按生成时长重设，这里给 None 就是"从素材头开始"。）
            clip_in_sec=None,
            clip_dur_sec=None,
        )
        # ---- C 段：原素材的后半截 ----
        tail_shot = Shot(
            id=uuid.uuid4().hex[:12], project_id=shot.project_id,
            order=shot.order + 2,
            script_ref=shot.script_ref,
            link_to_prev="continuous",
            characters=shot.characters,
            location=shot.location,
            video_url=shot.video_url,
            thumb_url=shot.thumb_url,
            first_frame_url=None,
            episode=shot.episode,
            status=shot.status,
            profile_override=shot.profile_override,
            is_special=shot.is_special,
            adopted_version=shot.adopted_version,
            gen_prompt=shot.gen_prompt,
            prompt_state=shot.prompt_state,
            # C 段不是"待生成"，它本来就是原素材的一部分，不需要重做
            stale=False,
            stale_reason=None,
            duration_sec=round(dur - b, 2),
            disabled=shot.disabled,
            special_name=shot.special_name,
            ref_overrides=shot.ref_overrides,
            refs_stale=shot.refs_stale,
            track_index=shot.track_index,
            clip_in_sec=base_in + b,
            clip_dur_sec=round(dur - b, 2),
        )
        # ---- A 段：就是原行，只改窗口 ----
        shot.duration_sec = round(a, 2)
        shot.clip_in_sec = base_in
        shot.clip_dur_sec = round(a, 2)
        # A 段留着原片，但它现在只播原素材的前 a 秒 —— 若它原本整段已过期，
        # 那条过期原因说的是"整段"的事，截短之后是否还成立无法自动判断。
        # 保留原标记不动：宁可让用户多看一眼，也别替他把旗标洗掉。

        # ⚠️ 快照必须在手动让位**之前**取（理由见 shot_timing.snapshot_anchors）
        snap = snapshot_anchors(session, shot.project_id)
        # 一分为三：后面所有镜头 +2，造型区间必须同步（2026-10-22）
        snap_st = snapshot_stage_ranges(session, shot.project_id)
        # 给后面的镜头让位（+2：这一镜变成了三镜）
        for s in (session.query(Shot)
                  .filter(Shot.project_id == shot.project_id,
                          Shot.order > shot.order).all()):
            s.order += 2
        session.add(mid_shot)
        session.add(tail_shot)
        session.flush()
        _renumber(session, shot.project_id)
        remap_anchors_by_identity(session, shot.project_id, snap)
        remap_stage_ranges_by_identity(session, shot.project_id, snap_st)
        session.commit()
        return {
            "ok": True,
            "head_shot_id": shot.id, "mid_shot_id": mid_shot.id,
            "tail_shot_id": tail_shot.id,
            "head_duration": shot.duration_sec,
            "mid_duration": mid_shot.duration_sec,
            "tail_duration": tail_shot.duration_sec,
            "min_duration": floor,
        }


class ShotUndoRecutIn(BaseModel):
    """3.11 R2：撤销一次 `recut`。

    只需给中间段（B）的 id —— A 与 C 由它两侧的相邻行推出，与 `unsplit`
    只需要 tail 是同一套"能少要一个参数就少要一个"的口径：多传的每一个 id
    都是一次可以传错的机会。
    """

    mid_shot_id: str


@router.post("/shots/{shot_id}/undo-recut")
def undo_recut(shot_id: str, body: ShotUndoRecutIn) -> dict:
    """把 `recut` 划出来的 A|B|C 合回原来的一镜（撤销划线）。

    为什么不能像 `split` 那样只靠 `unsplit` 撤销：

    - A|B 合不了 —— B 没有 `video_url`，两段的 url 不等，合并等于把用户
      刚划出来的空缺直接抹掉；`unsplit` 会（且应该）409。
    - B|C 也一样合不了 —— C 有片、B 没有，合起来 B 会凭空继承 C 的画面，
      那不是用户划的那一段。
    - 而 B 段是 `is_special=0` 的 AI 镜头，`delete_shot` 明确拒删，前端
      自己凑不出逆操作（与 `split` 需要 `unsplit` 是同一个理由）。

    所以撤销必须是**一个原子动作**：删掉 B 与 C，把 A 恢复成完整时长与原窗口。
    A 是"原素材 + 原窗口"的持有者，这也是 `recut` 里刻意让**原行**当 A 段
    的原因 —— 撤销时不必去猜哪一行才是正统。

    校验从严，宁可 409 也不做"尽力而为"的合并：

      · B 与 C 必须真的是 A 的后两行（order 相邻）
      · C 必须与 A 同源同窗口连续（说明这三行确实是一次 recut 的产物）
      · **B 不能有片**：有片说明它被重新生成过了，删掉就是删掉用户花过钱
        的结果。此时不撤，让用户自己决定（他可以用 B 的新片往前后接）。
    """
    with get_session() as session:
        head = access.req_shot(session, shot_id)
        mid = access.req_shot(session, body.mid_shot_id)
        if head.project_id != mid.project_id:
            raise HTTPException(status_code=422, detail="两个镜头不属于同一项目")
        if mid.order != head.order + 1:
            raise HTTPException(
                status_code=409,
                detail=f"这两段已不相邻（#{head.order} / #{mid.order}），无法撤销")
        tail = (session.query(Shot)
                .filter(Shot.project_id == head.project_id,
                        Shot.order == mid.order + 1).first())
        if not tail:
            raise HTTPException(status_code=409, detail="划分后的第三段已不在，无法撤销")
        if mid.video_url:
            raise HTTPException(
                status_code=409,
                detail="中间段已经重新生成过了，撤销会丢掉它的画面；"
                       "请先决定要不要保留它")
        # A 与 C 必须同源且窗口首尾相接 —— 这是"这三行确实来自一次 recut"的
        # 唯一凭据。缺了它，用户在 A 被单独改过之后撤销会得到一个时长对不上
        # 的镜头（静默的错误比报错糟得多）。
        #
        # 判据是**素材坐标**：C 的入点要等于 A 的入点 + A 的取片长度 + B 的长度。
        #
        # ⚠️ `+ mid.duration_sec` 这一项不能省。recut 把一次连续的取片切成
        # A[base_in, base_in+a) / B[base_in+a, base_in+b) / C[base_in+b, …)，
        # 还原成"A 直接把 C 接上"要回到**原始窗口**，而 A 与 C 之间本来就隔着
        # 一个 B。只比 `h_in + h_dur` vs `t_in`，差的值恒等于 B 的长度，于是
        # **每一次正常的 recut 都撤销失败**（实测 A 终点 3.0、C 入点 7.08、
        # B 长 4.08 ⇒ 差 4.08 > 0.05，永远报 409）。
        #
        # 也别拿 C 的入点去和 A 的"段内位置"比：recut 给 C 写的是 `base_in + b`
        # （相对素材），而这个镜头被剪过时 `base_in ≠ 0`，两个坐标系混着比必然误判。
        if (head.video_url or "") != (tail.video_url or ""):
            raise HTTPException(status_code=409, detail="首尾两段已经不是同一条素材，无法撤销")
        h_in = float(getattr(head, "clip_in_sec", None) or 0.0)
        h_dur = float(getattr(head, "clip_dur_sec", None) or head.duration_sec or 0.0)
        m_dur = float(mid.duration_sec or 0.0)
        t_in = float(getattr(tail, "clip_in_sec", None) or 0.0)
        t_dur = float(getattr(tail, "clip_dur_sec", None) or tail.duration_sec or 0.0)
        if abs((h_in + h_dur + m_dur) - t_in) > 0.05:
            raise HTTPException(
                status_code=409, detail="首尾两段的取片窗口已不连续，无法撤销")

        # 还原成**一整段原始窗口**：A + B + C。B 虽然从没出过片，但它的时长
        # 属于这条素材的连续区间，漏掉它合并出来的镜头会凭空短一截。
        merged = round(h_dur + m_dur + t_dur, 2)
        head.duration_sec = merged
        # 窗口按 db.Shot 的那条不变式归位：窗口存在时 `duration_sec == clip_dur_sec`。
        # 破了它的后果是「轨道上显示 2.4s、成片里却是 5s」（导出读窗口、布局读
        # duration_sec），即静默损坏。
        #
        #   · 原本整段使用（h_in == 0）：回到整段使用 —— clip 两列清空，
        #     而不是写 "0.0 / merged"。`None` 才表示"没被剪过"，留着会让
        #     时间轴上从此多一个"已修剪"角标，且此后每次重生成都要多走一次
        #     清窗口的提示。
        #   · 原本就被修剪过（h_in > 0，recut 允许在剪过的镜头上划线）：
        #     入点原样保留，长度扩到合并后的总长。
        if h_in > 0:
            head.clip_in_sec = h_in
            head.clip_dur_sec = merged
        else:
            head.clip_in_sec = None
            head.clip_dur_sec = None
        pid = head.project_id
        session.delete(mid)
        session.delete(tail)
        session.flush()
        _renumber(session, pid)
        session.commit()
        return {"ok": True, "shot_id": head.id, "order": head.order,
                "duration": merged}


@router.delete("/shots/{shot_id}")
def delete_shot(shot_id: str) -> dict:
    """删除镜头（仅允许删外部素材镜头；AI 镜头请用停用，避免破坏拆解对应关系）。"""
    with get_session() as session:
        shot = access.req_shot(session, shot_id)
        if not shot.is_special:
            raise HTTPException(
                status_code=400,
                detail="AI 镜头不可删除，请改用停用（PATCH /shots/{id}/timeline disabled=true）")
        pid = shot.project_id
        session.delete(shot)
        session.flush()
        _renumber(session, pid)
        session.commit()
        return {"ok": True}


# ---------- 镜头版本历史（R2，契约 C10）----------
@router.get("/shots/{shot_id}/versions")
def shot_versions(shot_id: str) -> dict:
    """版本历史（精编器回退面板用）；回退=POST adopt 指旧 version_no。

    `is_current` 由**服务端**按 `Shot.adopted_version` 判定，前端直接用它打勾。
    此前前端拿 `版本行.video_url === 镜头.video_url` 猜，与资产侧同款：
    同一个 URL 若在历史里出现多行就会**同时勾上好几版**。镜头侧目前正好没有
    重复 URL（`_save_shot_version` 每次生成都产出新地址），但这个判据本身是错的
    ——资产侧就是这么炸的（用户实测一个造型勾了四个版本、点哪个都取消不掉）。
    指针本来就在（adopt / desub / upscale 三处都会写它），读它即可。
    """
    with get_session() as session:
        shot = access.req_shot(session, shot_id)
        rows = (session.query(ShotVersion)
                .filter(ShotVersion.shot_id == shot_id)
                .order_by(ShotVersion.version_no.desc()).all())
        adopted = shot.adopted_version
        have = {r.version_no for r in rows}
        # 与资产侧 `asset_versions._adopted_no` 同一套规则，两处口径必须一致：
        #   ① 指针可信（在列表里、且指向的版本与当前片一致）→ 用它
        #   ② 否则退回"与当前片一致的最新一版"，**只取一版**
        cur = shot.video_url or ""
        cur_ok = bool(adopted and adopted in have
                      and (next(r for r in rows
                                if r.version_no == adopted).video_url or "") == cur)
        if not cur_ok:
            adopted = next((r.version_no for r in rows
                            if (r.video_url or "") == cur and cur), None)
        return {"adopted_version": adopted, "versions": [
            {"version_no": v.version_no, "video_url": v.video_url,
             "thumb_url": v.thumb_url,
             "model_id": v.model_id, "prompt": v.prompt,
             "meta": json.loads(v.meta) if v.meta else None,
             "created_at": v.created_at,
             "is_current": v.version_no == adopted,
             }
            for v in rows
        ]}


# ---------- 首帧图：已下线 ----------
class FirstFrameIn(BaseModel):
    """（已下线）原单镜首帧的请求体。字段留着只为旧网页发来的请求能被解析后回 410。"""
    regen_anchor: bool = False
    image_model: Optional[str] = None
    frame_prompt: Optional[str] = None


@router.post("/shots/{shot_id}/first-frame")
async def regen_first_frame(shot_id: str, body: Optional[FirstFrameIn] = None) -> dict:
    """（已下线，恒 410）原「为单个镜头生成 / 重生首帧图」。

    首帧 / 首尾帧 / 尾帧三种生成模式于 2026-11-20 整体下线（用户裁定），出片统一走
    全能参考，镜流不再给镜头出首帧图。要指定开头或结尾画面，把那张图作为参考图加进
    镜头。网页上对应的按钮还在，所以用 410 + 一句人话，而不是 404。
    """
    from ..jobs import FIRST_FRAME_RETIRED
    raise HTTPException(status_code=410, detail=FIRST_FRAME_RETIRED)


class AdoptIn(BaseModel):
    version_no: int


@router.post("/shots/{shot_id}/adopt")
async def adopt_shot_version(shot_id: str, body: AdoptIn) -> dict:
    from ..media import make_thumb
    with get_session() as session:
        shot = access.req_shot(session, shot_id)
        ver = (session.query(ShotVersion)
               .filter(ShotVersion.shot_id == shot_id,
                       ShotVersion.version_no == body.version_no).first())
        if not ver:
            raise HTTPException(status_code=404, detail=f"版本 {body.version_no} 不存在")
        thumb = ver.thumb_url
        video_url = ver.video_url
    # P1-1：存量版本（缩略图上线前生成的）没有 thumb，切到它会让轨道变空白。
    # 这里按需补抽一次并回写版本记录，之后再切就直接命中。抽帧在 session 外做，不占连接。
    if not thumb and video_url:
        thumb = await make_thumb(video_url)
    with get_session() as session:
        shot = session.get(Shot, shot_id)
        ver = (session.query(ShotVersion)
               .filter(ShotVersion.shot_id == shot_id,
                       ShotVersion.version_no == body.version_no).first())
        if not shot or not ver:
            raise HTTPException(status_code=404, detail="shot not found")
        if thumb and not ver.thumb_url:
            ver.thumb_url = thumb
        shot.video_url = ver.video_url
        # 3.1：切版本 = 换素材，取片窗口失效（旧窗口是相对**上一个** video_url
        # 的坐标）。这里会丢掉用户在上一版素材上修剪的入点/出点——但相比
        # 「时间轴显示 3s、成片里是黑帧」这种静默损坏，看得见的丢失是可接受的，
        # 且用户重新拖一次即可。回报 clip_window_cleared 让前端提示这件事。
        window_cleared = reset_clip_window(shot)
        # 只在真拿到缩略图时才覆盖。
        # 原来是无条件赋值：make_thumb 失败（ffmpeg 抽帧超时、源文件损坏、
        # 磁盘满）时 thumb 为 None，于是把镜头**原有的好缩略图擦成空白**——
        # 用户切一次版本，轨道上那一格就白了，而且切回去也不会自动恢复。
        # 宁可留旧图（内容可能对不上新版本，但比整格空白可用）。
        if thumb:
            shot.thumb_url = thumb
        shot.adopted_version = ver.version_no
        shot.status = "adopted"
        session.commit()
        # 回报**实际生效**的缩略图，而不是可能为 None 的本次抽帧结果 ——
        # 前端拿它直接更新卡片，报 None 会让已有的图在界面上消失
        return {"ok": True, "shot_id": shot_id,
                "adopted_version": ver.version_no, "video_url": ver.video_url,
                "thumb_url": shot.thumb_url,
                "clip_window_cleared": window_cleared}


# ---------- 拆解体检：镜头页「重新拆解」的数据来源（2026-10-19） ----------
@router.get("/projects/{project_id}/breakdown-health")
def breakdown_health(project_id: str) -> dict:
    """按集报告拆解有没有出问题，供镜头页「重新拆解」挑集与选修法。

    三类问题，各自对应不同的修法：

    - **raw**：提示词就是剧本原文（存量数据：旧版拆解后预生成提示词时优化失败、
      回退成原文）。修法 = 让 Muse 重写并锁定这几镜的镜头脚本（原 `reprompt`
      任务已于 2026-11-19 下线），镜头切分与已出片都不动。
    - **missing**：剧本里有这一集，库里一镜都没有（这一集拆解直接失败了）。
      修法 = 重新拆解这一集。
    - **error**：最近一次拆解任务给这一集记了错误（模型没返回合法 JSON / 403 …）。
      仅作说明：哪怕后来又拆成功了，用户也想知道上次为什么失败。

    `with_video`：已出片的镜头数。**整集重新拆解会替换掉这一集的全部镜头**，
    前端必须在确认框里报出这个数，别让用户以为只是"刷新一下提示词"。
    """
    from ..db import Job
    from ..prompt_health import is_raw, project_has_framework
    from ..script_import import smart_split_chapters

    with get_session() as session:
        proj = session.get(Project, project_id)
        if proj is None:
            raise HTTPException(status_code=404, detail="项目不存在")
        script = proj.raw_script or ""
        # 无框架的视频模型（veo 等）本来就直通原文：那不是失败，别报成"原文提示词"
        legacy = project_has_framework(proj)
        shots = (session.query(Shot)
                 .filter(Shot.project_id == project_id)
                 .order_by(Shot.episode, Shot.order).all())
        last = (session.query(Job)
                .filter(Job.project_id == project_id, Job.kind == "breakdown_all",
                        Job.status.in_(("done", "failed")))
                .order_by(Job.created_at.desc()).first())
        last_at = last.created_at if last else None
        last_res = last.result if last else None

    eps: dict[int, dict] = {}

    def ep_row(n: int, title: str | None = None) -> dict:
        if n not in eps:
            eps[n] = {"episode": n, "title": title, "shots": 0, "raw": 0,
                      "raw_shot_ids": [], "with_video": 0, "raw_with_video": 0,
                      "in_script": False, "error": None}
        elif title and not eps[n]["title"]:
            eps[n]["title"] = title
        return eps[n]

    try:
        for ch in smart_split_chapters(script):
            o = ch.get("order")
            if isinstance(o, int) and o > 0:
                ep_row(o, ch.get("title"))["in_script"] = True
    except Exception:  # noqa: BLE001 分集解析失败不该让体检整个 500
        logger.warning("[breakdown-health] %s 分集解析失败", project_id, exc_info=True)

    for s in shots:
        if s.disabled:
            continue
        r = ep_row(int(s.episode or 1))
        r["shots"] += 1
        has_video = bool(s.video_url)
        r["with_video"] += int(has_video)
        if is_raw(s.gen_prompt, s.script_ref, s.prompt_state, legacy=legacy):
            r["raw"] += 1
            r["raw_shot_ids"].append(s.id)
            r["raw_with_video"] += int(has_video)

    if last_res:
        try:
            for e in json.loads(last_res).get("episodes") or []:
                if not isinstance(e, dict) or not e.get("error"):
                    continue
                try:
                    n = int(str(e.get("episode")).strip())
                except ValueError:
                    continue
                ep_row(n, e.get("title"))["error"] = str(e["error"])[:300]
        except (ValueError, AttributeError):
            pass

    out = []
    for n in sorted(eps):
        r = eps[n]
        r["missing"] = r["in_script"] and r["shots"] == 0
        out.append(r)
    return {
        "episodes": out,
        "total_shots": sum(r["shots"] for r in out),
        "total_raw": sum(r["raw"] for r in out),
        "missing_episodes": [r["episode"] for r in out if r["missing"]],
        "last_breakdown_at": last_at,
        #: False = 本项目的视频模型没有提示词框架，提示词本就直通原文
        "has_framework": legacy,
    }


# ---------- P1-1 存量缩略图回填 ----------
@router.post("/projects/{project_id}/backfill-thumbs")
async def backfill_thumbs(project_id: str) -> dict:
    """为已有视频但没缩略图的镜头补抽首帧（缩略图上线前生成的存量数据用）。

    串行抽帧：ffmpeg 关键帧定位单张只需几十毫秒，几百镜也在可接受范围内，
    且串行不会和正在跑的生成任务抢 CPU。同时回写 Shot 与其采用版本。
    """
    from ..media import make_thumb
    with get_session() as session:
        if not session.get(Project, project_id):
            raise HTTPException(status_code=404, detail="project not found")
        targets = [
            (s.id, s.video_url, s.adopted_version)
            for s in session.query(Shot).filter(Shot.project_id == project_id).all()
            if s.video_url and not s.thumb_url
        ]
    filled, failed = 0, 0
    for sid, video_url, adopted in targets:
        thumb = await make_thumb(video_url)
        if not thumb:
            failed += 1
            continue
        with get_session() as session:
            shot = session.get(Shot, sid)
            if shot:
                shot.thumb_url = thumb
            if adopted is not None:
                ver = (session.query(ShotVersion)
                       .filter(ShotVersion.shot_id == sid,
                               ShotVersion.version_no == adopted).first())
                if ver and not ver.thumb_url:
                    ver.thumb_url = thumb
            session.commit()
        filled += 1
    return {"ok": True, "scanned": len(targets), "filled": filled, "failed": failed}


# ---------- 阶段①：剧本优化 ----------
class ScriptOptimizeIn(BaseModel):
    raw: str
    model_id: Optional[str] = None  # 缺省用 settings.llm_model
    instruction: Optional[str] = None
    project_id: Optional[str] = None  # 传入则原文/优化结果落库


class ScriptOptimizeOut(BaseModel):
    optimized: str
    model_id: str


_OPTIMIZE_SYSTEM = (
    "你是资深短剧编剧。将用户提供的原始剧本/文本优化为适合分镜成片的剧本："
    "保留核心剧情与人物，强化画面感与镜头感，删除冗余，使每个段落都能对应可拍摄的镜头。"
    "只输出优化后的剧本正文，不要解释。"
)


@router.post("/script/optimize", response_model=ScriptOptimizeOut)
async def script_optimize(body: ScriptOptimizeIn) -> ScriptOptimizeOut:
    from .. import charge

    # 文本操作按**次**收（一次优化底层可能几十次调用，按 token 计会失控）。
    charge.charge_sync("reprompt", {"project_id": body.project_id},
                       desc="剧本优化", project_id=body.project_id)
    llm = LLMProvider(model_id=body.model_id)
    user = body.raw if not body.instruction else f"额外要求：{body.instruction}\n\n原文：\n{body.raw}"
    try:
        optimized = await llm.complete(_OPTIMIZE_SYSTEM, user)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"LLM 调用失败: {e!r}")
    # 落库：切页/重启不丢
    if body.project_id:
        with get_session() as session:
            proj = session.get(Project, body.project_id)
            if proj:
                proj.raw_script = body.raw
                from ..script_import import episodes_json
                proj.episodes = episodes_json(body.raw)
                proj.optimized_script = optimized.strip()
                session.commit()
    return ScriptOptimizeOut(optimized=optimized.strip(), model_id=llm.model_id)


# ---------- 阶段②：镜头拆解 + 资产盘点 ----------
class ScriptBreakdownIn(BaseModel):
    script: str
    model_id: Optional[str] = None  # 缺省用 settings.llm_model
    project_id: Optional[str] = None  # 传入则拆解结果自动落库
    episode: Optional[int] = None  # 按集拆解：只覆盖该集镜头；缺省=整项目重拆(episode=1)


class ShotDraft(BaseModel):
    order: int
    script_ref: str
    link_to_prev: str = "continuous"  # continuous | transition
    characters: list[str] = []
    location: Optional[str] = None
    #: 本镜画面里**在场的关键道具**名（2026-10-08 新增）。
    #:
    #: ⚠️ 与 `directing_note` 同一个坑，且更容易中招：Pydantic 默认忽略未声明的键，
    #: 而 `do_breakdown` 是 `ShotDraft(**s)` 直接展开模型返回的 dict ——
    #: 提示词里写了要产出、模型也真产出了，**这一行没声明就静默消失**，
    #: 落库自然为空且零报错。这是纯文本链路最典型的"加了产出端忘了接收端"。
    props: list[str] = []
    duration_sec: Optional[float] = None  # AI 拆镜判定时长（钳制后 [7, 模型上限]）
    #: 拆解阶段一并产出的**导演意图**（2026-09-20 新增）。
    #:
    #: ⚠️ 这个字段必须声明在这里 —— Pydantic 默认**忽略未声明的键**，
    #: 而 `do_breakdown` 是 `ShotDraft(**s)` 直接展开模型返回的 dict。
    #: 漏声明的后果是**静默丢弃**：拆解提示词里写了要产出，模型也真的产出了，
    #: 但解析这一步就没了，落库自然为空（实测 17 镜全部丢失、零报错）。
    #: 这类「加了产出端忘了接收端」是纯文本链路最典型的静默故障。
    #:
    #: 结构：{dramatic_function, emotional_beat, focus, shot_scale_suggestion,
    #:       action_intensity}
    #: `action_intensity`（2026-09-23 加）驱动规则21条「动作镜」：
    #: 标成 `high` 时优化器改用运镜 + 一镜一动作 + 蓄力/爆发/余波 + 物理连带，
    #: 并覆盖第 1 条（默认固定机位）与第 9 条（每切片换景别）。
    #: 加在这里而不是新开顶层字段：`directing_note` 已经有完整的产出→落库→
    #: 双路径消费链路，新开一个要把那条链路再铺一遍。
    #: 落库时进 `profile_override`（不新增列），消费在 jobs 的提示词两条路径。
    directing_note: Optional[dict] = None


def _dur_window(cap_sec: float | None) -> _DurWindow:
    """模型单镜上限 → 合并参数。

    `cap_sec` 是**模型宣称一镜能出多长**（不扣 TTS 余量：真人剧没有旁白，
    时长直接下发给视频模型，贴着厂商硬钳走是安全的）。

    ≤16s 退回历史参数，保证 seedance-2.0 / veo / H3 的拆解结果与改动前一致。

    更长的模型（seedance-2.5 = 30s）令 `floor = ceil`：**只要相邻两镜加起来
    装得下就并**，一路打包到 30 秒。这才是长镜模型的正确用法——
    把本来要切成 3 刀的一场戏用 1 个镜头拍完，AI 只需想象一次那扇门，
    总时长一秒不变（合并只是把秒数相加），变的只有刀数。
    """
    if not cap_sec or cap_sec <= 16.0:
        return _DUR_WINDOW_DEFAULT
    ceil = float(int(cap_sec))
    return _DurWindow(ceil, ceil)


def _raw_duration(ref: str, ai_sec: float | None,
                  names: "list[str] | None" = None) -> float:
    """内容本身值多少秒（**不钳到甜点区间**）：合并判定用它。

    合并判定必须看"真实内容量"，不能看钳制后的值——钳完人人都 ≥7s，
    就再也看不出哪一镜其实是碎片、该并进邻镜了。

    2026-09-01 重写：改由 `drama_timing` 按**剧本格式**逐行估算
    （同期台词 + max(动作节拍, 画外音)），并用 `reconcile` 把 LLM 报的秒数
    收进内容允许的区间。老实现只认引号内对白，而本系统剧本写作
    `角色【情绪】：台词`，一个引号都没有 —— 对白下限恒为 0，
    LLM 报多少就是多少。项目「9125」镜 6 因此 182 字塞进 23 秒
    （7.9 字/秒，语速失真），镜 7 则 33 字注水到 10 秒。
    """
    #: `names`（2026-11-10）：本镜人物。给了就把纯环境描写合计封顶 1.5 秒
    #: （`drama_timing.SCENERY_CAP_SEC`）—— 用户反馈"经常出现三四秒的空镜头"。
    return drama_timing.reconcile(
        drama_timing.estimate_seconds(ref, names=names), ai_sec)


def _clamp_duration(ref: str, ai_sec: float | None,
                    win: _DurWindow = _DUR_WINDOW_DEFAULT,
                    names: "list[str] | None" = None) -> float:
    """时长三层控制的第 2 层：确定性钳制到 [7, win.ceil]。

    - 对白物理下限：引号内字数 / 4字每秒 + 1s 动作缓冲（保台词说得完）
    - AI 缺失/离谱值时按内容兜底估算
    - 上限取 `win.ceil`（模型单次上限：2.0 是 15s，2.5 是 30s）——超了会被
      厂商静默钳掉，画面早停而后面的镜头时间轴还按下发值排，必然错位。
    - 下限**恒为 7s，不跟着窗口抬高**：合并兜底之后仍不足 7s 的（整集最后一个
      孤立节拍、无法与邻镜合并的转场）按 7s 下发。长窗口下若把下限抬到 25s，
      一个真只有 8 秒内容的收尾镜会被注水成 25 秒的慢镜——那比碎片更难看。

    ## 2026-09-22：补两级，治「动作过快 / 台词语速非常快」

    用户报告拆镜时长**普遍偏短**。实测（2299 个真实有台词镜）确认：
    隐含语速中位 3.26 字/秒尚属健康，但 **32.8% 超 3.6、15.5% 超 4.4**，
    而实测标定的失真阈值正在这个区间（3.62 念成不换气的一长串、
    4.42 开始吞字，见 `drama_timing.NATURAL_CPS`）。所以补两级：

    ① **表演余量** `performance_bump`：在原判断上加 1~4 秒（按原长度比例）。
       这是用户定的口径，治的是"整体偏紧"——纯动作镜 7.0s → 9.1s，
       动作终于有时间演完。单这一步就把 >4.4 的比例从 15.5% 压到 5.0%。
    ② **台词物理下限** `dialogue_floor`：台词按自然语速 3.1 字/秒念完所需。
       余量是加法，补不了「差 4~6 倍」的镜头（实测有 75 计时字塞进 3.7s 的），
       这一级把 >4.4 从 5.0% 再压到 0.3%。
       它**平时不介入**：多数镜头 ① 之后已经超过这个下限。

    顺序是 ①→②→钳上限。下限若超过上限，说明这一镜物理装不下，
    该由 `_split_overlong_drama_shots` 拆开——本函数只负责钳，不负责拆。
    """
    base = _raw_duration(ref, ai_sec, names)
    # 表演余量只按**有人的内容**算：纯环境描写不需要"演"，不该再给它加 1~4 秒
    # （2026-11-10，空镜注水的第二层，见 drama_timing.SCENERY_CAP_SEC）。
    scenery = drama_timing.scenery_seconds(ref, names) if names else 0.0
    withroom = base + drama_timing.performance_bump(max(0.0, base - scenery))
    need = drama_timing.dialogue_floor(ref)
    return round(max(_DUR_FLOOR, min(win.ceil, max(withroom, need))), 1)


def _split_overlong_shots(shots: list[dict], max_chars: int | None) -> list[dict]:
    """确定性兜底：把"文字读不完"的镜头按句界拆开（解说剧专用）。

    拆镜提示词是按「7-15 秒**视频**」设计的，但解说剧的镜头时长由旁白朗读时长
    决定，上限来自视频模型的显存包线（720p 海螺 H3 只有 19.1s ≈ 85 字）。
    实测项目 930 拆出的镜头平均 116 字、要读 26 秒——**一镜的文字根本读不完**，
    多出来的部分要么被截断、要么盖到下一镜上，两种都是声画错位。

    提示词里已经写了字数上限，但 LLM 不保证遵守，所以这里再确定性地补一刀。
    切分复用 `script_import.plan_narration_by_shot`（与旁白切分**同一个函数**）：
    两处用不同算法切同一段文字，正是本次事故的成因，不能再犯第二次。
    """
    if not max_chars or max_chars <= 0:
        return shots
    from ..script_import import plan_narration_by_shot, _CHARS_PER_SEC_SLOW
    max_sec = max_chars / _CHARS_PER_SEC_SLOW
    plans = plan_narration_by_shot([s.get("script_ref") or "" for s in shots], max_sec)
    out: list[dict] = []
    for s, segs in zip(shots, plans):
        if len(segs) <= 1:
            out.append(s)
            continue
        # 克隆画面字段、只换 script_ref：解说剧的画面本就是旁白的视觉陪衬，
        # 同一场景连着几个镜头是常态，不必为每段现编一个新画面描述。
        for k, seg in enumerate(segs):
            child = dict(s)
            child["script_ref"] = seg
            child["duration_sec"] = None      # 由下游按朗读时长/TTS 实测回写
            if k > 0:
                child["link_to_prev"] = "continuous"
            out.append(child)
    for i, s in enumerate(out):
        s["order"] = i + 1
    return out


def _split_overlong_drama_shots(shots: list[dict],
                                win: _DurWindow) -> list[dict]:
    """确定性兜底：真人剧里"台词念不完"的镜头按内容单元拆开。

    与 `_split_overlong_shots`（解说剧、按字数）对称的真人剧版本，按**秒**判。
    在此之前真人剧根本没有拆分兜底：超过模型上限的镜头只会被 `_clamp_duration`
    静默钳到 ceil，于是内容 36.7 秒的镜头下发 30 秒，多出的台词要么被模型
    加速念完（语速失真，正是项目「9125」镜 6 的现象），要么直接截断。
    钳制改变的只是下发的数字，改变不了要念的字数——必须真的切一刀。

    ⚠️ 拆分只在**内容确实超过模型单镜上限**时发生，不会凭空增加刀数：
    合并阶段（`_merge_short_shots`）已经把能并的都并到 ceil 以内了，
    能走到这里的都是单镜内容本身就超容量的。拆开不增加总时长。

    ## 动作镜按更小的窗口拆（2026-09-23）

    `action_intensity == "high"` 的镜头改用 `action_window(win)`（≤[7,15]）。
    合并阶段已经不再给动作镜打包长镜，这里是**第二道**：LLM 自己就给出一个
    27 秒动作镜时（拆解提示词第 6 条「同一段追逐或撕扯不得拆成两镜」会诱发
    这种输出），仍能确定性地切开。两道都只认 `high`，非动作镜逐字走老路径。
    """
    out: list[dict] = []
    action_win = action_window(win)
    for s in shots:
        ref = s.get("script_ref") or ""
        w = action_win if _is_action_shot(s) else win
        # ⚠️ 拆不拆按**自然语速**判，不能按分组口径（5.0 字/秒）判。
        # 按 5.0 判的话，106 计时字算成 21.7s、在 2.5 的 28s 上限内"放得下"
        # 而不拆，实际念完要 34.7s —— 模型只能压缩语速甚至吞字。
        # 见 drama_timing.NATURAL_CPS 与 split_ref_by_cap 的 cps 参数。
        est = drama_timing.estimate_seconds(ref, drama_timing.NATURAL_CPS,
                                            list(s.get("characters") or []))
        if est <= w.ceil:
            out.append(s)
            continue
        parts = drama_timing.split_ref_by_cap(ref, w.ceil,
                                              drama_timing.NATURAL_CPS)
        if len(parts) <= 1:
            out.append(s)
            continue
        for k, (seg, sec) in enumerate(parts):
            child = dict(s)
            child["script_ref"] = seg
            # 🐛 2026-09-22：这里原本直接写 `round(sec, 1)`，也就是裸内容估算值,
            # **绕过了 `_clamp_duration`** —— 于是拆出来的段既不过 7s 下限、
            # 也不过表演余量与台词物理下限。实测后果：drama 有 17.3%（761 个）
            # 镜头低于 7s，最极端的是 **75 计时字塞进 3.7 秒**（15.4 字/秒），
            # 而 `_clamp_duration` 的下限明明是 7.0。
            # 修法是让每一段都走与未拆镜头**完全相同**的那条链路。
            #
            # ⚠️ 钳制用的也是 `w`（动作镜是收紧后的窗口）：用原 win 的话，
            # 刚按 15s 切开的动作段会被表演余量 bump 到 16s+ 而不受约束，
            # 等于又把刚切开的刀补回去一半。
            child["duration_sec"] = _clamp_duration(
                seg, sec, w, list(s.get("characters") or []))
            if k > 0:
                # 拆出来的后续段与前段是同一场戏的连续时刻
                child["link_to_prev"] = "continuous"
            out.append(child)
    for i, s in enumerate(out):
        s["order"] = i + 1
    return out


class BreakdownOut(BaseModel):
    shots: list[ShotDraft]
    characters: list[str]
    locations: list[str]
    #: 道具总表（跨块去重）。**必须有默认值**：老版本的调用方（一键成片等）
    #: 与本文件的其它构造点都是按关键字传这三项，加了必填字段会当场炸。
    props: list[str] = []
    model_id: str
    #: 拆解质量告警（2026-10-13）。**这就是"静默丢剧情"的出口。**
    #:
    #: 此前 `_salvaged` 只被 `_parse_breakdown_json` 赋值，全代码库无人读取，
    #: 于是"只抢救出前 5 个镜头、后面 4 个镜头的剧情全丢了"和"正常拆完"
    #: 在日志、UI、数据库里长得**一模一样**。用户只能等成片时发现剧情跳了，
    #: 且完全无从归因 —— 这是多人反馈的"丢失剧情"一直查不出来的原因。
    #:
    #: 每条是人话，直接给用户看，例如：
    #:   · "本集输出被截断，仅抢救出前 5 个镜头，尾部剧情已丢失（建议重拆）"
    #:   · "第 9 个镜头与第 8 个重复（相似度 0.89），已丢弃后者"
    warnings: list[str] = []
    #: 是否有**有损**抢救（截断）。为 True 时该集应当整集重试 ——
    #: 因为丢掉的剧情不会自己回来。
    lossy: bool = False


#: 拆解 system 提示词。**对所有视频模型完全一致**，不随模型能力变。
#:
#: 曾经把它改成随模型窗口生成的函数（seedance-2.5 时写「目标 25-30 秒」），
#: 实测证明那是错的：LLM 会照着给定区间填数字，而不是估算内容——
#: 同一集 1870 字的剧本，8-12 秒窗口下报 90 秒，25-30 秒窗口下报 120 秒，
#: 每个字分到的银幕时间凭空多了 30%，而 script_ref 的文字量几乎没变。
#: 那 30% 是注水的慢镜，不是多出来的内容。
#:
#: 所以「模型能出多长」只允许影响**分组**（几个节拍并成一镜，见
#: `_merge_short_shots`），绝不允许影响**秒数**。秒数永远是对内容的诚实估计。
_BREAKDOWN_SYSTEM = (
    "你是分镜师。把剧本拆成镜头序列，并盘点资产。\n"
    #: ⚠️ 2026-10-11 改：开头这两句曾是
    #:   「生成为一个 7-15 秒的连续片段」「一镜可以包含 2-3 个前后相继的动作节拍」
    #: 两处都是旧口径，且**与规则1条直接冲突**（那里要求镜内切 4-8 段）。
    #: 模型读到"2-3 个节拍"就按 2-3 段组织，短剧节奏出不来 ——
    #: 实测新项目 1011：26.5 秒的镜头只切 4 段、段均 6.6 秒。
    #: 现在只交代「一镜 = 一次生成」，容量与段数由规则 5 与提示词层各管一头，
    #: **不在两处写同一个数字**（那正是漂移的来源，见 audit_framework_conflicts.py）。
    "每个镜头会被 AI 视频模型生成为**一个连续的片段**（时长与容量见第 5 条）："
    "一镜是**一段可一镜到底拍完的连续叙事**，内部可以有多个前后相继的动作节拍"
    "（如「走到门前→发现门虚掩→推门而入」），节拍之间由镜头运动与剪接承载。\n"
    "⚠️ **不要在拆解阶段决定镜内切几刀** —— 那是提示词层的事"
    "（规则1条）。你只负责把剧情切成「一次生成能拍完」的单元。\n"
    "拆分规则（严格遵守）：\n"
    "1) 一个镜头 = 一段可一镜到底拍完的连续叙事，必须包含具体剧情事件："
    "人物动作、对白、情绪反应或关键剧情信息。\n"
    "2) 纯环境/氛围/景物描写（如\"阳光穿过百叶窗照在衣柜上\"）**不得独立成镜**，"
    "必须并入它所引出的下一个有人物/事件的镜头，作为该镜的画面开场氛围写进 script_ref。\n"
    "   ⚠️ **唯一的例外：每集/每场开头允许一个短的强制空镜**（2026-10-11 用户授权）。"
    "条件是三条全满足：① 它是本场**第一个**镜头；② **短**（≤3 秒）；"
    "③ 内容只交代地点、天气、光线、空气这些**环境事实**，不含人物、不含剧情动作、"
    "不含移动载具。这种空镜的作用是给观众一个「这里是什么地方」的呼吸口，"
    "外部标杆的做法正是以它开场（19.2 秒的 13 刀里第 1 刀就是强制空镜）。\n"
    "   ⚠️ 本例外**仅限开场**：中段与结尾的环境描写仍按本条前一句处理（并入邻镜），"
    "不得因为有了这个口子就把每一处景物描写都独立成镜 —— 那会把节奏拖垮。\n"
    "3) 场景标题行（如\"日 内 某某房间\"\"夜 外 街道\"）是元数据：写入 location 字段，"
    "不要出现在 script_ref、更不得独立成镜。\n"
    "3b) **`人物:` 行同样是元数据，不是镜头内容**（如"
    "\"人物:林羽、断臂幸存者（包括但不限ABCDE）、幸存者若干（包括但不限ABC）、沈随…\"）。"
    "它是**这一场戏**的出场人物表，不是**某一个镜头**的在场面孔。\n"
    "   ⚠️ 把整行抄进 `characters` 是最常见也最贵的错误：实测 2167 个镜头里"
    "有 1572 个（73%）的 characters 逐项等于某条 `人物:` 行，于是"
    "「一个人对另一个人说话」的镜头也挂着全场十个人，下游按人注入参考图，"
    "名额立刻被占满、真正该出镜的角色反而被截断。\n"
    "   `characters` 必须**逐镜**从该镜 script_ref 的正文推：谁在这段画面里。"
    "`人物:` 行只能用来**兜底校验**（本镜的人不该超出该表），绝不能直接复制。\n"
    "3c) **群像代称不是角色**。剧本里的「幸存者若干」「众人」「几个女人」"
    "「路人」这类是**群体**，不是一个具体人物，不得写进 `characters`、"
    "更不得按它登记角色资产（否则会给一个不存在的「幸存者」生成定妆图）。"
    "只有当剧本给了**具体署名**（如「幸存者A」「断臂幸存者B」有台词、被点名）"
    "才算一个角色。\n"
    "4) script_ref 完整保留原文文字（合并时按顺序拼接），不要改写、缩写。\n"
    "5) 为每镜估算时长 duration_sec：**先用满模型容量，装不下才切刀**"
    "（2026-10-11 改，见下）。\n"
    "   有对白按中文语速约 4 字/秒加 1 秒动作缓冲计算。\n"
    "   ⚠️ **本条曾被写死成「必须落在 7-15 秒、目标 8-12 秒」，那是错的**：\n"
    "   它让选 seedance-2.5（单镜 30 秒）的项目照样被拆成 8-12 秒一镜，"
    "**这个模型唯一的优势被拆解阶段扔掉了**；而且提示词里一发区间，"
    "模型就照着区间**填数字**而不是估内容（实测：1870 字的一集，"
    "8-12 秒窗口下报 90 秒、25-30 秒窗口下报 120 秒，两版 script_ref 几乎相同"
    "—— 多出来的 30 秒是注水的慢镜）。\n"
    "   ⚠️ **不要混淆两件事（用户 2026-10-11 澄清，极重要）**：\n"
    "     · **「尽可能用长」说的是「视频总长」** —— 也就是说，"
    "**非必要不要产出一个 20 秒以下的视频片段**。同一场戏能用一次生成拍完，"
    "就不要为了凑镜头数拆成两次。\n"
    "     · **它绝不是说「镜头内部节奏要慢」**。"
    "镜头内部的切镜节奏要**尽可能快**（见下游提示词规则第 9、15 条），"
    "两者互不冲突：一个 30 秒的片段里可以切 15 刀。\n"
    "   所以时长的正确判据是：**按内容估多少就是多少，"
    "只要不超过模型单镜上限就不切**；超过了才在最自然的"
    "说话轮次/动作段落处断开。**不要**为了落进某个甜点区间而切割，"
    "**也不要**为了凑时长而注水。\n"
    "6) **同一个连续动作、同一件道具的一段过程，必须放在同一个镜头里**："
    "开门/关门、上下车、接打同一通电话、递交并接过同一件物品、"
    "同一段追逐或撕扯——不得拆成两个镜头。原因：道具与场景的外观由 AI 逐镜生成，"
    "拆成两镜就会出现前一镜是木门、后一镜变成玻璃门这类穿帮。"
    "涉及门/车/电梯/信件等具体道具时尤其注意把「接近-接触-完成」写进同一镜。\n"
    "7) 只有真正的场景切换、时间跳跃或叙事视角转移才断镜（link_to_prev 写 transition）；"
    "同一场戏内部的连续动作一律 continuous。\n"
    "8) **characters 要列出该镜画面中「在场」的全部角色，不是只列有台词或有动作的人。**"
    "坐在旁边不说话、站在一边旁观、被搀扶着、正在听别人讲话的人，只要画面里有他，"
    "就必须列进去。判据是**离场描写**：某角色出现之后，只有当剧本明确写了他离开"
    "（走出画面/离开/起身离去/摔门而去/挂断电话下线/下车/被带走等）才可以从后续镜头里去掉；"
    "**没有写离场就默认他还在原地**。\n"
    "   这条极其重要：漏掉一个在场角色，成片里这个人就会凭空消失，"
    "下一镜又突然出现，观众会以为剪辑出错。\n"
    "   ⚠️ 本条的\"在场\"指的是**这一镜的画面里**，不是这一场戏。"
    "不要用\"把 `人物:` 行整行抄上、多列几个保平安\"来规避漏人："
    "多列一个**根本不在本镜画面里**的角色，代价是每镜多注入一张参考图，"
    "名额被占满后真正在该镜出镜的角色反而进不去（这正是规则 3b 说的那个 73%）。"
    "分辨两类人的口诀：**在画面里但不说话 → 必须列；不在画面里 → 不许列。**\n"
    "9) 另外用 enters / exits 两个数组标明本镜**新进画**和**离开画面**的角色"
    "（没有就给空数组）。这两个字段用来校验第 8 条，不要漏。\n"
    "9b) **本镜画面里的关键道具写进 `props` 数组**（没有就给空数组）。"
    "道具指剧本里**被点名、有戏份**的具象物件：信、刀、手机、药瓶、"
    "那辆黑色轿车、母亲留下的怀表。判据是它**参与了这一镜的动作或叙事**"
    "（被拿起/递出/打开/注视/砸碎/打翻），而不只是画面里有。\n"
    "   ⚠️ 三类**不要**写进 props：\n"
    "     · 通用陈设（桌椅、杯子、窗帘、路灯、树）—— 那是 `location` 的事，"
    "写进来会让每个镜头都长出一堆道具资产，每个都要出一张图。\n"
    "     · 角色身上的衣饰（耳环、项链、外套）—— 那是造型/服装的事。\n"
    "     · 群量物（一群鸽子、满桌菜、几辆车）。\n"
    "   名字用剧本里的**具体叫法**并保持全片一致（同一把刀每一镜都写"
    "「断魂刀」，不要一镜写「刀」一镜写「那把长刀」），否则同一件道具会"
    "分裂成多个资产、各出一张图，跨镜必穿帮。\n"
    "   `props` 只列**本镜**的，与 characters 同款；顶层再给一个去重总表。\n"
    "10) **每个镜头还要给出导演意图（directing_note）。** "
    "下游的提示词优化器拿到的原本只有剧本原文，它不知道这一镜在全片里"
    "承担什么功能，只能把剧本「翻译」一遍；人工精品之所以好，是因为有"
    "导演先决定了这一镜要干什么。所以这里要把那件事补上：\n"
    "    `dramatic_function`：本镜的戏剧功能，从这四个里选一个 ——\n"
    "      `establish`（建立：交代空间/人物关系/情境）\n"
    "      `advance`（推进：发生了一件事，剧情向前走）\n"
    "      `turn`（转折：情绪或局势发生逆转，本镜是全片的钩子）\n"
    "      `resolve`（收束：一段剧情的落点、情绪释放或余味）\n"
    "    `dramatic_goal`：本镜的**戏剧目标** —— 这一镜要达成什么效果"
    "（如「暴露翟光的道德底线」）。这是导演意图里最上位的一项。\n"
    "    `core_conflict`：本镜的**核心冲突**，写清对立的双方"
    "（如「资源收益 vs 人性底线」）。\n"
    "    `emotional_curve`：本镜的**情绪曲线**，用箭头串起变化过程"
    "（如「试探 → 兴奋 → 被压制」）。⚠️ 要写**变化**，不是写一个静态的情绪词。\n"
    "    `core_subjects`：本镜的**核心主体**，画面围绕谁/什么展开"
    "（如「翟光 / 沈随」）。\n"
    "    `required_reactions`：本镜**必须拍到的反应** —— 哪些人的什么反应"
    "是本镜不能漏的（如「女性幸存者紧张、沈随瞬间转冷」）。"
    "⚠️ 这是下游安排「反应镜」的依据，写具体的人和具体的反应。\n"
    "    `key_visual_info`：本镜的**核心视觉信息** —— 观众必须看见的"
    "具体视觉要素（如「舔唇、女性回避、沈随抬手打断」）。\n"
    "    ⚠️ **不要在这里规定景别序列或镜头切法**（2026-10-11 删除该字段）。"
    "景别、机位与「切几刀」由**提示词层**按叙事需要自己设计 ——"
    "上游提前规定景别序列会造成职责冲突：两边都想管节奏，结果互相打架。"
    "实测该字段还有反作用：给多少个景别，下游就切多少段。\n"
    "    `emotional_beat`：本镜的情绪基调，**一句话、具体**，"
    "不要写「紧张」这种笼统词，写「强压着不让自己崩溃」这种可表演的。\n"
    "    `focus`：本镜画面**最该被看见的那个东西**（一个道具、一处表情、"
    "一个动作、一处空间关系）。\n"
    "    `action_intensity`：本镜的动作强度，从这三个里选一个 ——\n"
    "      `none`（对话/静止：人物基本站着或坐着，只有表情与手势）\n"
    "      `light`（有明确肢体动作但非打斗：推门、奔跑、跌倒、摔东西、拥抱）\n"
    "      `high`（打斗、追逐、爆炸、坠落等高强度动作场面）\n"
    "      ⚠️ 只看**这一镜的画面**，不看整场戏的氛围：战斗场景里一个"
    "「两人对视说话」的镜头是 `none`，不是 `high`。\n"
    '严格输出 JSON，格式为：'
    '{"shots":[{"order":1,"script_ref":"该镜对应的剧本片段","duration_sec":9.0,'
    '"link_to_prev":"continuous 或 transition","characters":["本镜在场的全部角色名"],'
    '"enters":[],"exits":[],"props":["本镜画面里的关键道具名"],"location":"场景名",'
    '"directing_note":{"dramatic_function":"establish|advance|turn|resolve",'
    '"dramatic_goal":"这一镜要达成什么效果",'
    '"core_conflict":"对立的双方",'
    '"emotional_curve":"试探 → 兴奋 → 被压制",'
    '"core_subjects":"翟光 / 沈随",'
    '"required_reactions":"必须拍到的反应，写具体的人和反应",'
    '"key_visual_info":"观众必须看见的具体视觉要素",'
    '"emotional_beat":"一句话、具体、可表演","focus":"最该被看见的东西",'
    '"action_intensity":"none|light|high"}}],'
    '"characters":["全部角色去重"],"locations":["全部场景去重"],'
    '"props":["全部道具去重"]}。'
    "只输出 JSON，不要 markdown 代码块、不要解释。"
)


# 对白特征（兜底合并的豁免判断：有对白的短镜头是合法的）。
# 只认引号——"特写：""近景："这类镜头术语也带冒号，不能凭冒号判定对白。
_DIALOG_MARKS = ("“", "”", "「", "」", "『", "』", '"')


#: 判定"同一段剧情被写了两遍"的相似度门槛。
#: 取 0.75 的依据是实测样本：项目 60a81f4482ce 第 28 集那对重复镜，
#: 后一份是前一份的近似副本（一对 0.80、一对 0.888），而**正常相邻镜**
#: （同一场戏里前后接续的两句台词）相似度普遍 < 0.5 —— 同一集里
#: 相似度最高的非重复对只有 0.16。所以 0.75 离两侧都有余量，
#: 既不会漏掉副本，也不会把正常镜头误判成重复。
_DUP_SIM_THRESHOLD = 0.75

#: 只在**相邻这么多个镜头以内**找重复。模型回退重写时，副本紧跟在原句之后
#: （实测是「8,9,8,9」这种 A B A B）。限窗是为了避免把同一场戏里
#: 前后呼应的台词（如首尾各出现一次的同一句口头禅）误判成重复。
_DUP_WINDOW = 4

#: 镜头文本对原文的覆盖率门槛。低于它说明这一集多半被截断、剧情丢了。
#: 标定依据见 `_breakdown_coverage`：健康集普遍 >90%（ep2 94.6% / ep6 96.3%），
#: 而受损集是 ep4 71.7% / ep9 69.1% / ep20 76.5% / ep21 74.6% —— 两侧离得很开。
_COVERAGE_FLOOR = 0.85


def _norm_for_dup(text: str) -> str:
    """重复判定用的归一化：去掉空白与场景标题行。

    合并 script_ref 时换行会被拉平（`A\\nB`），与单独一镜的 `A\\nB` 相比
    只因空白差异就判不相似，会把真正的副本漏掉，所以先抹掉空白。
    """
    t = re.sub(r"^(场[:：]\S+|景[:：].*|人物[:：].*)$", "", text or "", flags=re.M)
    return re.sub(r"\s+", "", t)


def _drop_duplicate_shots(shots: list[dict]) -> tuple[list[dict], list[str]]:
    """确定性兜底：**同一段剧情被规划两次**时丢掉重复的那一份。

    ## 为什么需要它

    触发样本（项目 60a81f4482ce 第 28 集，2026-10-12 用户甲反馈）：
    模型输出到第 8、9 镜之后**回退重写了一遍**，落库成

        镜209 △周围几个同事的眼神彻底变了… 小王(冷笑): 这还不是最精彩的！…
        镜210 小王(模仿赵柔的语气): 她信誓旦旦、指天发誓地说，这张黑卡…
        镜211 小王(冷笑一声): 这还不是最精彩的！…      ← 209 的副本(0.80)
        镜212 小王(模仿赵柔的语气): 她信誓旦旦、指天发誓地说… ← 210 的副本(0.888)

    决定性证据：这两句台词在全部 61 集原文里**各只出现 1 次**，
    所以重复 100% 来自模型退化，不是原文重复。

    这个形状同时造成用户反馈的第二个症状"后面的剧情提前到前面出现"——
    用前向游标扫原文位置，镜211/212 的文本位置回退到了 932 之前，
    而它俩正是这对副本。**两个症状是同一个 bug 的两面。**

    ## 为什么是"丢掉后来的那一份"

    保留**先出现**的那个：模型是顺着原文写的，第一次出现的位置才是
    剧情正确的位置，回退重写的那份才是错位的。丢后者即恢复原文顺序。

    返回 `(去重后的镜头, 说明列表)`；说明列表为空表示没有发现重复。
    """
    if len(shots) <= 1:
        return shots, []

    import difflib

    norms = [_norm_for_dup(s.get("script_ref") or "") for s in shots]
    drop: set[int] = set()
    notes: list[str] = []

    for j in range(len(shots)):
        if j in drop or len(norms[j]) < 20:
            continue
        # 只看紧邻的前 _DUP_WINDOW 个：副本总是紧跟原句出现
        for i in range(max(0, j - _DUP_WINDOW), j):
            if i in drop or len(norms[i]) < 20:
                continue
            a, b = norms[i], norms[j]
            # 短文本 quick_ratio 会虚高，先按长度粗筛（长宽比超 3 倍的不可能是副本）
            if len(a) > len(b) * 3 or len(b) > len(a) * 3:
                continue
            sm = difflib.SequenceMatcher(None, a, b)
            if sm.quick_ratio() < _DUP_SIM_THRESHOLD:
                continue
            ratio = sm.ratio()
            if ratio >= _DUP_SIM_THRESHOLD:
                drop.add(j)
                notes.append(
                    f"第 {j + 1} 个镜头与第 {i + 1} 个重复"
                    f"（相似度 {ratio:.2f}），已丢弃后者")
                break

    if not drop:
        return shots, []
    kept = [s for k, s in enumerate(shots) if k not in drop]
    return kept, notes


def _breakdown_coverage(script: str, shots: list[dict]) -> tuple[float, str | None]:
    """量出"镜头文本对原文的覆盖率"，低于门槛就返回告警。

    返回 `(覆盖率, 告警文本或 None)`。

    ## 为什么要有这一条

    这是"丢失剧情"最可靠的最后一道网 —— 它**不依赖对失败方式的任何假设**。
    括号修补治的是"结构破损"、去重治的是"写了两遍"，但模型真被截断时
    丢掉的尾部剧情，任何解析技巧都救不回来（它根本没写出来）。
    能做的只有：量出来、说出来、让调用方重试。

    ## 口径与实测标定

    覆盖率 = 各镜 script_ref 合起来覆盖的原文比例。**不指望 100%**：
    按拆解规则第 3 条，场景标题行（`【场景：…】`、`场:`、`景:`、`人物:`）
    属于元数据，本就不该进 script_ref。实测健康集普遍在 **90% 以上**。

    ⚠️ 门槛取 85% 是**离群判据**，不是精度目标。实测：
      · 正常集：ep2 94.6%、ep6 96.3%、ep11 96.0%（大多数 >90%）
      · 受损集：ep4 **71.7%**、ep9 **69.1%**、ep20 **76.5%**、ep21 74.6%
    两侧离得足够开，所以 85% 既不会把健康的集误报，也不会漏掉受损的集。
    """
    src = re.sub(r"^(场[:：]\S+|景[:：].*|人物[:：].*|【场景[:：].*)$", "",
                 (script or "").strip(), flags=re.M)
    src_n = len(re.sub(r"\s+", "", src))
    if src_n < 200:
        return 1.0, None                      # 太短，比例没有意义
    joined = re.sub(r"\s+", "", "".join((s.get("script_ref") or "")
                                        for s in shots))
    cov = len(joined) / src_n
    if cov >= _COVERAGE_FLOOR:
        return cov, None
    return cov, (f"本集镜头对原文的覆盖率仅 {cov * 100:.0f}%"
                 f"（{len(shots)} 个镜头 / 原文 {src_n} 字），"
                 f"低于 {_COVERAGE_FLOOR * 100:.0f}% 的门槛 —— "
                 f"多半是模型输出被截断、尾部剧情丢失，建议整集重拆")


def _detect_order_regression(script: str, shots: list[dict]) -> list[str]:
    """检测"后面的剧情跑到了前面的镜头里" —— script_ref 在原文中的位置回退。

    ## 判据（前向游标）

    按镜号顺序在原文里找每个镜头文本的位置，游标**只增不减**；
    从游标处往后找不到、但在游标之前能找到 → 记一次回退。

    ⚠️ **不能直接用 `find()`**：同一段文字可能在原文里出现多次，
    `find()` 永远返回**第一次**出现的位置，会把正常的后续镜头全判成"回退"。
    必须从游标往后找（`find(key, cur)`），这是本检测唯一的技术要点。

    ## 为什么只告警、不自动修

    `_drop_duplicate_shots` 处理的那类**能**确定性判定该丢哪一份（副本紧跟在
    原句之后，且后一份才是错位的），所以它自动修。
    但一般的"回退"做不到：镜号顺序错了，**删哪一个都可能删掉真剧情**，
    而错的那一个未必是后者。这种只能报给人看。两者分工明确。

    ## 与"重复"的关系

    实测（项目 60a81f4482ce）：ep28 那对重复镜**同时**触发了本检测 ——
    "后段剧情被提前"与"同一段被规划两次"是同一个 bug 的两面。
    去重先跑，所以这里报出来的已是去重后的**残余**问题。
    """
    src = re.sub(r"\s+", "", re.sub(
        r"^(场[:：]\S+|景[:：].*|人物[:：].*|【场景[:：].*)$", "",
        (script or "").strip(), flags=re.M))
    if len(src) < 200:
        return []
    cur = 0
    bad: list[str] = []
    for i, s in enumerate(shots, 1):
        key = _norm_for_dup(s.get("script_ref") or "")[:16]
        if len(key) < 8:
            continue
        p = src.find(key, cur)
        if p >= 0:
            cur = p + 1
            continue
        p0 = src.find(key)          # 只可能在游标之前
        if p0 >= 0:
            bad.append(f"第 {i} 个镜头的内容在原文里出现得更靠前"
                       f"（位置 {p0}，已推进到 {cur}）—— 疑似后段剧情被提前")
    return bad


def _merge_fragment_shots(shots: list[dict]) -> list[dict]:
    """确定性兜底：LLM 未遵守规则时，把"碎片镜头"并入相邻镜头。

    碎片镜头 = 无人物 且 无对白特征 且 原文 < 40 字（典型：纯环境描写、
    场景标题残留）。并入下一镜的 script_ref 开头（作画面开场氛围）；
    若是最后一镜则并入上一镜结尾。location 缺失时向后传递。
    """
    if len(shots) <= 1:
        return shots
    merged: list[dict] = []
    pending_prefix = ""   # 待并入下一镜的环境描写
    pending_loc: str | None = None
    for s in shots:
        ref = (s.get("script_ref") or "").strip()
        has_char = bool(s.get("characters"))
        has_dialog = any(m in ref for m in _DIALOG_MARKS)
        if not has_char and not has_dialog and len(ref) < 40:
            pending_prefix = f"{pending_prefix}{ref}" if pending_prefix else ref
            pending_loc = pending_loc or s.get("location")
            continue
        if pending_prefix:
            s["script_ref"] = f"{pending_prefix} {ref}"
            s["location"] = s.get("location") or pending_loc
            pending_prefix = ""
            pending_loc = None
        merged.append(s)
    if pending_prefix:
        if merged:
            merged[-1]["script_ref"] = f"{merged[-1]['script_ref']} {pending_prefix}"
        else:  # 整块全是环境描写：保底成一镜
            merged.append({"script_ref": pending_prefix, "link_to_prev": "transition",
                           "characters": [], "location": pending_loc})
    for i, s in enumerate(merged):
        s["order"] = i + 1
    return merged


#: 场景名里的**时间标记**（按空格/标点切出来的整词才算）。
#: 它不是空间，但它决定能不能并：白天的镜头和夜里的镜头并进同一条连续镜头
#: 就是穿帮。只按整词匹配，避免把「夜市」「日光浴室」这类地名误当时间。
_LOC_TIME_DAY = ("日", "白天", "晨", "清晨", "早", "早晨", "上午", "中午",
                 "下午", "午后", "日间")
_LOC_TIME_NIGHT = ("夜", "夜晚", "深夜", "凌晨", "晚", "晚上", "傍晚", "黄昏")
#: 内外景 / 时间标记之外的纯修饰词，比较物理空间时剥掉。
_LOC_DROP = _LOC_TIME_DAY + _LOC_TIME_NIGHT + ("内", "外", "内景", "外景")
#: 时空跳跃标记：只有一侧带 = 一侧是回忆、另一侧是当下，绝不合并。
#: （按子串匹配：真实数据里它常粘在括号里，如「顾家老宅（十二年前）」。）
_LOC_FLASHBACK = ("回忆", "闪回", "年前", "年后", "往事", "多年")
#: 场景名的切词分隔符（真实数据形如「夜 内 顾家客厅」「顾家大宅 客厅」
#: 「夜 路上/医院」「顾家老宅（十二年前）」）。
_LOC_SEPS = " \t　/／、,，;；·|｜()（）[]【】<>《》-—~～"
def _loc_tokens(s: str) -> list[str]:
    """按分隔符把场景名切成词。"""
    out, cur = [], ""
    for ch in s:
        if ch in _LOC_SEPS:
            if cur:
                out.append(cur)
            cur = ""
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out


def _loc_time_class(tokens: list[str]) -> str | None:
    """场景名里的昼夜标记：'day' / 'night' / None（没标）。"""
    for t in tokens:
        if t in _LOC_TIME_DAY:
            return "day"
        if t in _LOC_TIME_NIGHT:
            return "night"
    return None


def _loc_place_part(tokens: list[str]) -> str:
    """剥掉时间/内外景修饰后的**纯空间名**（拼在一起，便于做子串比较）。"""
    return "".join(t for t in tokens if t not in _LOC_DROP)


def _loc_related(a: str | None, b: str | None) -> bool:
    """两个场景名是否属于同一处物理空间**且同一时间**（合并的安全闸门）。

    一个镜头是一条**连续镜头**，所以只有真正同一处、同一时刻的两段才能并。
    判定分三步，任一步否决就不并（宁可漏合不可错合）：

    1) 时空跳跃：只有一侧标了「回忆 / 十二年前」→ 一侧是过去一侧是当下，不并。
    2) 昼夜冲突：一侧标「日」另一侧标「夜」→ 不并（并了就是一条镜头里天亮又天黑）。
    3) 空间相关：剥掉时间/内外景修饰后，相等 / 一方缺失 / 一方包含另一方 /
       共同前缀 ≥3 字。「豪华套房走廊及门口」与「豪华套房客厅」共享前缀
       「豪华套房」——正是"推门而入"那种一镜到底的走位，可以并。

    ⚠️ **共享通名不算相关**，试过、撤了。曾放宽成"共享一段含地点语素的子串
    就算同一处"，拿全库 896 组真实相邻场景对一验：`医院病房 ⇄ 医院走廊`
    （共享「医院」）、`顾氏集团 白薇办公室 ⇄ 顾耀东办公室`（共享「办公室」）、
    `工作室办公室 ⇄ 幼儿园教师办公室` 全部变成可并——「医院」「办公室」是通名
    不是同一处，并进一条连续镜头就是串戏。多留一刀远好过串戏。

    ⚠️ 剥时间修饰这一步同样是拿真实数据揪出来的：老实现直接在原串上比前缀，
    于是「夜 内 顾耀东书房」与「夜 内 沈修杰律所办公室」被判成相关——
    光「夜 内 」就凑满了 3 字前缀。全库有 167 处这种漏判；本来还被"其中一镜
    必须 <7s"挡住大半，一旦按 30s 打包（floor=ceil=30）就会大面积串戏。
    """
    x = (a or "").strip()
    y = (b or "").strip()
    if not x or not y or x == y:
        return True
    if any(t in x for t in _LOC_FLASHBACK) != any(t in y for t in _LOC_FLASHBACK):
        return False
    tx, ty = _loc_tokens(x), _loc_tokens(y)
    cx, cy = _loc_time_class(tx), _loc_time_class(ty)
    if cx and cy and cx != cy:
        return False
    px, py = _loc_place_part(tx), _loc_place_part(ty)
    if not px or not py or px == py:
        return True
    if px in py or py in px:
        return True
    n = 0
    for ca, cb in zip(px, py):
        if ca != cb:
            break
        n += 1
    return n >= 3


def _is_action_shot(s) -> bool:
    """这一镜是不是**高强度动作镜**（拆解阶段标的 `action_intensity == "high"`）。

    吃两种形状：合并/拆分阶段的草稿 `dict`，以及落库阶段的 `ShotDraft`。
    两处都要判，而它们一个是字典一个是 pydantic 模型 —— 只支持 dict 的话，
    落库那一处会**静默**取不到、永远按非动作镜钳制。

    老项目（本字段之前拆的）自然取不到，一律返回 False，行为与改动前完全一致。

    ⚠️ **只认 `high`**。`light`（推门/奔跑/跌倒/拥抱）返回 False，
    理由见 `shot_timing.action_window` 的「边界」一节：那类正是拆解提示词
    第 6 条要保护的连续动作，收紧窗口会把「开门」重新拆成两镜。
    """
    dn = (s.get("directing_note") if isinstance(s, dict)
          else getattr(s, "directing_note", None))
    if not isinstance(dn, dict):
        return False
    return str(dn.get("action_intensity") or "").strip().lower() == "high"


def _merge_short_shots(shots: list[dict],
                       win: _DurWindow = _DUR_WINDOW_DEFAULT) -> list[dict]:
    """确定性兜底：把短镜头并进相邻镜头。**合并只把秒数相加，不制造时长。**

    两种用法，由 `win` 区分：
    - 15s 级模型（默认参数）：`floor=7` —— 只并不足 7 秒的碎片。这是 B1
      （<7s 片段连贯性差）与 B2（一个开门情节被拆成两镜、门的外观前后不一致）
      的同一个解：LLM 没按甜点区间设计时由这里确定性补上。
    - 长镜模型（seedance-2.5，`floor=ceil=30`）：**只要装得下就并**，一路打包
      到 30 秒。这是长镜能力的正确用法——一场戏从 3 刀变 1 刀，AI 只想象一次
      那扇门；总时长一秒不变，因为合并就是把两段的秒数相加。

    合并条件（全部满足才并，宁可漏合不可错合）：
    - 其中一镜的**真实内容量** < win.floor（_raw_duration，不是钳制后的值）
    - 合并后 ≤ win.ceil（模型单次上限；15s 级下这里放到上限而不是目标上限，
      是因为 "5.5s 的到门口 + 7s 的推门而入" 合起来 12.5s——超了目标上限 12s
      却正是必须合并的那一对，拆开就是用户实测到的"门的外观前后不一致"）
    - **没换场**，两套判据分工明确：
      · 后一镜 `link_to_prev == "continuous"` → LLM 已明确宣称没换场，采信它，
        只再查人物相容。全库实测：4946 处 continuous 对场景名相同、104 处不同，
        而那 104 处绝大多数是同一处的更细名字（「酒店宴会厅 讲台前」→「讲台」、
        「民政局门口」→「民政局外台阶」），真标错的约 6 处 ≈ 全部的 0.12%。
        **不再拿场景名去二次否决 continuous**——同一场戏里 LLM 常给每镜写更细的
        子场景名（「医院大礼堂」→「大礼堂观众席」），按名字判就白留一刀，
        而每多一刀就多一个前后衔接不上的风险点。
      · 标了 `transition` → LLM 说这里断了，只有**场景相关且人物有交集**才推翻它。
        "走廊→推门进客厅" 常被误标 transition，实际是同一处空间的一镜到底走位。
    - 人物相容：两边角色有交集，或其中一边没有角色（纯动作/道具特写）
    合并后取**后一镜**的场景名：走廊→客厅这种推入，落点场景才是资产该锚的那个。

    ## 高强度动作镜不参与长镜打包（2026-09-23）

    相邻两镜**任一边**标了 `action_intensity == "high"` 时，本次判定改用
    `action_window(win)`（≤[7,15]），不用长镜的 [28,28]。
    「任一边」而不是「两边都是」：923 的 #1 正是「开团(动作) + 对话 + 指挥 +
    攻防」混着打包出来的 27.1 秒，只要有一边是动作镜，这一刀就不该抹掉。
    详见 `shot_timing.action_window` 的完整理由与实测。

    ⚠️ 非动作镜（`none`/`light`/老项目无此字段）走的仍是**逐字相同**的老路径：
    `_win_at` 在没有 high 时原样返回传入的 `win`。
    """
    if len(shots) <= 1:
        return shots
    action_win = action_window(win)

    def _win_at(a: dict, b: dict) -> _DurWindow:
        return action_win if (_is_action_shot(a) or _is_action_shot(b)) else win

    out: list[dict] = []
    for s in shots:
        ref = (s.get("script_ref") or "").strip()
        dur = _raw_duration(ref, s.get("duration_sec"), list(s.get("characters") or []))
        if out:
            prev = out[-1]
            w = _win_at(prev, s)
            pchars = list(prev.get("characters") or [])
            schars = list(s.get("characters") or [])
            overlap = bool(set(pchars) & set(schars))
            continuous = s.get("link_to_prev", "continuous") == "continuous"
            # continuous = LLM 明确宣称"这里没换场"（提示词规则 7：只有真正的
            # 场景切换/时间跳跃/视角转移才写 transition），直接采信。
            #
            # ⚠️ 2026-10-11：**`continuous` 路径不再查人物交集**。
            # 原先这里是 `chars_ok if continuous else ...` —— 「两边角色要有交集，
            # 或其中一边没有角色」。那条闸门是 2026-08-13（e51e179）随
            # `_merge_short_shots` 一起加的，提交信息只写了"人物有交集时并镜"，
            # **没有给出任何理由**，我此前为它编的"防止跨人物视角跳变"是自己
            # 事后补的、且被实测推翻：一次生成里本来就能换机位、换主体、
            # 切 13 刀（见 scripts/verify_cut_density.py —— 外部标杆 19 秒里
            # 13 个镜头、含多个角色，用的就是**一次生成**）。
            # **「A 说话 + B 的反应」并成一次生成恰恰就是正反打**，
            # 是影视最标准的拍法，不是需要防的异常。
            #
            # 实测代价：全库 440 对相邻镜（时长/场景/continuous 三条件全满足）
            # 单因人物无交集而未合并。典型如
            #   林晨把口令牌放下(4.5s) + 白薇抓过口令牌输入动态码(5.6s)
            # —— 同一场戏的连续动作，并成一镜才是对的。
            #
            # 现在 `continuous` 只认时长与场景：时长那一关已经保证了
            # "只在其中一边是碎片、且合并后不超上限"时才并，足够保守。
            #
            # transition 路径仍保留人物交集：那是 LLM 明说"这里断了"的情况，
            # 只有场景相关**且**人物有交集才推翻它（"走廊→推门进客厅"那类误标）。
            # 这条不动 —— 它服务于「救回误标的连续动作」，与上面的问题无关。
            same_scene = True if continuous else (
                overlap and _loc_related(prev.get("location"), s.get("location")))
            if (min(prev["_dur"], dur) < w.floor
                    and prev["_dur"] + dur <= w.ceil
                    and same_scene):
                prev["script_ref"] = f"{prev['script_ref']} {ref}".strip()
                prev["characters"] = pchars + [c for c in schars if c not in pchars]
                # 道具与人物同款合并（2026-10-08）：两镜并成一镜后，道具是并集。
                # 漏掉这一行的后果是**静默丢道具** —— 恰好是"同一个道具的一段过程
                # 必须放在同一镜"（规则 6）所鼓励的那种合并，合并后原先后半段的
                # 道具名就没了，提示词不再提它、参考图也不再注入。
                pprops = list(prev.get("props") or [])
                sprops = list(s.get("props") or [])
                prev["props"] = pprops + [x for x in sprops if x not in pprops]
                prev["location"] = s.get("location") or prev.get("location")
                # 合并后这一镜若任一边是动作镜，整镜就按动作镜对待：
                # directing_note 取"更高强度"的那份，否则合并出来的镜头会
                # 丢掉 high 标记，下游第 14 条就不触发了。
                if _is_action_shot(s) and not _is_action_shot(prev):
                    prev["directing_note"] = s.get("directing_note")
                prev["_dur"] = min(w.ceil, prev["_dur"] + dur)
                prev["duration_sec"] = round(prev["_dur"], 1)
                continue
        s = dict(s)
        s["script_ref"] = ref
        s["_dur"] = dur
        s["duration_sec"] = round(dur, 1)
        out.append(s)
    for i, s in enumerate(out):
        s.pop("_dur", None)
        s["order"] = i + 1
    return out


def _repair_json_brackets(text: str) -> tuple[str, list[str]]:
    """补全 JSON 里**缺失的闭合括号**，让 json.loads 能重新吃下整段。

    ⚠️ 这是 2026-10-13 补的第一道闸，起因是一个**静默丢剧情**的线上故障：
    某集模型明明输出了 9 个镜头，但第 6 个镜头**少写了一个 `}`**
    （写成 `"directing_note":{…}]`，正确应为 `"directing_note":{…}}]`），
    于是 `json.loads` 全文失败 → 走抢救路径 → 解析到第 6 个卡住 →
    **后面 4 个镜头连同剧情一起丢掉**。

    ⚠️ **关键认识：这不是 token 截断。** 那一集的原始输出只有 5385 字符，
    远低于 `max_tokens=16384`，而且结尾 `]}` 是闭合的 —— 模型以为自己写完了。
    所以"重试"和"调大 max_tokens"都治不了它；能治的只有把缺的括号补回来。
    实测：补上那 1 个 `}` 后，9 个镜头全部解析成功（原先只剩 5 个）。

    算法：单遍扫描，维护括号栈。
      · 遇 `{` / `[` → 入栈；
      · 遇 `}` / `]` 且与栈顶匹配 → 出栈；
      · 与栈顶**不匹配**（本例的 `]` 撞上 `{`）→ 说明栈顶那个括号忘了闭合，
        先补出它的闭合符，再处理当前括号；
      · 扫完栈仍有剩 → 在末尾按逆序补齐。

    字符串字面量内部一律跳过（含 `\\` 转义）：正文里会出现 `（）、【】`，
    而 `{}[]` 在字符串内是普通字符，不跳过就会算错括号深度。

    返回 `(修补后的文本, 修补说明列表)`；没有任何修补时说明列表为空。
    """
    out: list[str] = []
    stack: list[str] = []
    notes: list[str] = []
    in_str = False
    esc = False

    def _closer_for(opener: str) -> str:
        return "}" if opener == "{" else "]"

    for ch in text:
        if in_str:
            out.append(ch)
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            out.append(ch)
            continue
        if ch in "{[":
            stack.append(ch)
            out.append(ch)
            continue
        if ch in "}]":
            want = "{" if ch == "}" else "["
            if stack and stack[-1] == want:
                stack.pop()
                out.append(ch)
                continue
            # 它要配对的那个开括号在栈里存在吗？
            #   · 存在 → 说明它上方的括号被忘了闭合，逐层补上再配对；
            #   · 不存在 → **它自己就是多余的**，丢掉即可。
            # 这两者必须分开处理，否则会把一个本来完好的对象提前闭合。
            # 反例（本测试用例）：`{"a":{"b":1}]}`
            #   见到 `]` 时栈里只有 `[`... 只有 `{`，没有 `[`，
            #   若不加判断就"补一个 } 来迎合它"，会把最外层对象关掉，
            #   于是末尾那个真正的 `}` 反而成了多余的 —— 修完仍是坏 JSON。
            if want not in stack:
                notes.append(f"丢弃多余的 {ch}")
                continue
            # 逐层补到能接住当前括号
            while stack and stack[-1] != want:
                missing = _closer_for(stack.pop())
                notes.append(f"补 {missing}（在 {ch} 之前）")
                out.append(missing)
            if stack:
                stack.pop()
            out.append(ch)
            continue
        out.append(ch)

    # 收尾：栈里还剩的按逆序补齐（截断型损坏走到这里）
    if in_str:
        out.append('"')
        notes.append("补未闭合的字符串引号")
    while stack:
        missing = _closer_for(stack.pop())
        notes.append(f"补末尾 {missing}")
        out.append(missing)

    return "".join(out), notes


def _parse_breakdown_json(raw: str) -> dict:
    """解析拆解 JSON，带**括号修补**与**截断抢救**两级兜底。

    三级策略，按代价从低到高：

      1. **直接解析** —— 正常路径。
      2. **括号修补后解析**（2026-10-13 新增）—— 模型偶尔会漏写一个闭合括号，
         补回来即可拿到**全部**镜头。这一步治的是"结构破损"，与长度无关。
      3. **逐对象抢救** —— 真正的输出截断（尾部残缺如 `"ch`）才走这里：
         逐个 raw_decode 出**完整的**镜头对象，残缺尾部只能丢弃。

    ⚠️ 第 3 步是**有损**的，所以它发生时必须留下痕迹（`_salvaged` / `_salvage_note`）。
    历史教训：`_salvaged` 标记早就有，但**全代码库没有任何地方读它** ——
    于是"丢了一半镜头"和"正常拆完"在日志、UI、数据库里长得一模一样，
    用户只能等看到成片才发现剧情跳了，且无从归因。
    """
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]

    # ---- 第 1 级：直接解析 ----
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            data.setdefault("_salvaged", False)
            data.setdefault("_repaired", False)
            return data
    except json.JSONDecodeError as e:
        first_err = e

    # ---- 第 2 级：补括号再解析 ----
    repaired, notes = _repair_json_brackets(text)
    if notes:
        try:
            data = json.loads(repaired)
            if isinstance(data, dict) and data.get("shots"):
                logger.warning(
                    "[breakdown] 模型输出的 JSON 结构破损，已补括号修复：%s"
                    "（原报错 %s；修复后解出 %d 个镜头）",
                    "；".join(notes[:6]), first_err, len(data["shots"]))
                data["_salvaged"] = False
                data["_repaired"] = True
                data["_repair_notes"] = notes
                return data
        except json.JSONDecodeError:
            pass      # 修补也救不回来（多半是真截断），落到第 3 级

    # ---- 第 3 级：逐对象抢救（有损）----
    dec = json.JSONDecoder()
    start = text.find('"shots"')
    if start == -1:
        raise RuntimeError(f"模型未返回合法 JSON: {raw[:300]}")
    pos = text.find("[", start)
    if pos == -1:
        raise RuntimeError(f"模型未返回合法 JSON: {raw[:300]}")
    pos += 1
    shots: list[dict] = []
    while pos < len(text):
        while pos < len(text) and text[pos] in " \n\r\t,":
            pos += 1
        if pos >= len(text) or text[pos] == "]":
            break
        try:
            obj, pos = dec.raw_decode(text, pos)
            if isinstance(obj, dict) and obj.get("script_ref"):
                shots.append(obj)
        except json.JSONDecodeError:
            break  # 残缺尾部，丢弃
    if not shots:
        raise RuntimeError(f"模型未返回合法 JSON 且无法抢救: {raw[:300]}")
    # characters/locations/props 从镜头聚合（截断时顶层字段通常已丢失）
    chars: list[str] = []
    locs: list[str] = []
    prps: list[str] = []
    for s in shots:
        for c in s.get("characters") or []:
            if c not in chars:
                chars.append(c)
        loc = s.get("location")
        if loc and loc not in locs:
            locs.append(loc)
        # 抢救路径同样要收道具（2026-10-08）：被截断的那一块顶层字段已经丢了，
        # 不从镜头里补，这一块出现的道具就一个资产都建不出来。
        for x in s.get("props") or []:
            if x not in prps:
                prps.append(x)
    # ⚠️ 这条日志是本函数**唯一**的告警出口，必须显式且醒目：
    #    抢救=有损，意味着这一集的剧情已经少了一截，调用方要据此决定重试/告警。
    logger.warning(
        "[breakdown] 模型输出被截断，只能抢救出前 %d 个镜头，"
        "**尾部剧情已丢失**（原始输出 %d 字符，需整集重试）",
        len(shots), len(text))
    return {"shots": shots, "characters": chars, "locations": locs,
            "props": prps, "_salvaged": True, "_repaired": False,
            "_salvage_note": f"仅抢救出前 {len(shots)} 个镜头，尾部丢失"}


#: 拆解落库互斥锁：多集并发拆解时，order 编号（base_order 递增）与资产增量合并
#: 必须串行提交，否则并发读到相同 base_order → 镜头 order 重复 / 资产重复行。
#: LLM 调用（耗时主体）在锁外并发，只有落库段持锁，不牺牲并发收益。
#:
#: ⚠️ **按项目分锁，不是全模块一把**（2026-10-24 改）。
#: 临界区里读写的每一项都带 `project_id` 过滤：`max_order` 查的是本项目、
#: 资产增量合并查的是本项目、`refresh_present_characters(project_id)` 也是本项目。
#: 也就是说**跨项目根本不共享任何状态**，用一把全局锁只是让不同项目互相排队。
#: 而拆解的并发上限默认是 0（不设限），三个项目各拆 10 集 = 30 个协程排在
#: 同一把锁后面 —— 明明彼此无关。
#:
#: 同项目内部仍然严格串行（这才是 order 编号不重复的保证），语义不变。
_BREAKDOWN_DB_LOCKS: dict[str, asyncio.Lock] = {}


def _breakdown_lock(project_id: str) -> asyncio.Lock:
    """取该项目的拆解落库锁（首次访问时创建）。`setdefault` 原子且无 await。"""
    return _BREAKDOWN_DB_LOCKS.setdefault(project_id, asyncio.Lock())


async def do_breakdown(script: str, model_id: Optional[str],
                       project_id: Optional[str],
                       episode: Optional[int] = None,
                       max_chars: Optional[int] = None,
                       shot_cap_sec: Optional[float] = None) -> BreakdownOut:
    """拆解核心（供路由与一键成片 Saga 复用）。失败抛 RuntimeError。

    长文防丢：超过 2800 字按句界分块（不切断剧情），逐块拆解合并——
    避免整集直喂导致输出截断与中段剧情被略过。
    episode 传入时为"按集拆解"：只替换该集镜头（order 全项目连续递增），
    资产做增量合并；不传则整项目重拆（历史行为，episode 记 1）。
    多集并发安全：落库段持**本项目**的落库锁（见 _BREAKDOWN_DB_LOCKS 的注释）。

    `max_chars`：单镜 script_ref 的字数上限（解说剧专用）。解说剧的镜头时长是
    **旁白朗读时长**，上限来自视频模型的显存包线；一镜的文字读不完就必然声画
    错位。传了它就在提示词里写死字数上限，并在落库前跑
    `_split_overlong_shots` 确定性兜底（LLM 不遵守时照样成立）。
    不传 = 真人剧的老行为（按视频模型的单镜容量区间设计）。

    `shot_cap_sec`：视频模型宣称的单镜时长上限（**真人剧专用**）。
    它**不进提示词**、不改变任何一镜的秒数，只放宽 `_merge_short_shots` 的
    打包上限：15s 级模型只并碎片，seedance-2.5 的 30s 则把相邻节拍一路并到
    30 秒。所以同一集剧本换模型后**总时长不变、镜头数变少**——
    变的是刀数，不是内容。
    解说剧（max_chars 有值）不受它影响——那边的镜头长度由旁白朗读时长决定，
    用长窗口去合并会把按句切好的旁白又粘回去。
    """
    from ..script_import import MIN_BREAKDOWN_CHARS, split_for_ai
    from ..script_import import _CHARS_PER_SEC_SLOW as _CPS_SLOW

    # 解说剧的镜头长度由旁白朗读时长决定，一律用历史合并参数；
    # 真人剧才按模型的单镜能力放宽打包上限（只影响合并，不影响秒数）。
    win = (_DUR_WINDOW_DEFAULT if (max_chars and max_chars > 0)
           else _dur_window(shot_cap_sec))

    # 兜底守卫（C1）：正文过短一律不调 LLM，直接返回空结果。
    # run_breakdown_all 已在上游过滤过，但本函数也被 /breakdown 路由直接调用，
    # 而"给模型极少的字却要求它产出镜头"必然换来虚构内容 —— 这类假数据会一路
    # 流进资产/首帧/成片，事后极难分辨。宁可产出 0 镜。
    if len((script or "").strip()) < MIN_BREAKDOWN_CHARS:
        logger.warning("[breakdown] 正文仅 %d 字，低于 %d 字门槛，跳过拆解（不调 LLM）",
                       len((script or "").strip()), MIN_BREAKDOWN_CHARS)
        return BreakdownOut(shots=[], characters=[], locations=[],
                            model_id=model_id or "")

    # 拆解专用模型（config.llm_model_breakdown，空=回落 llm_model）。
    # 只在调用方**没点名**时套用：显式传了 model_id 说明是要测/要覆盖，尊重它。
    # 选型依据见 config 里那段的基准数据（gpt-5.6-terra 五项里四项第一）。
    llm = LLMProvider(model_id=model_id or get_settings().llm_model_breakdown
                      or get_settings().llm_model)
    system = _BREAKDOWN_SYSTEM
    if max_chars and max_chars > 0:
        # 解说剧：镜头颗粒度由"这段文字读多久"决定，不是由 7-15 秒视频决定。
        # 规则 5 说的 7-15 秒在这里会误导模型，所以显式覆盖掉。
        system += (
            f"\n【本片为解说剧，覆盖上述第 5 条】每个镜头的 script_ref "
            f"**不得超过 {max_chars} 个字**（含标点）。这是旁白朗读时长的硬上限，"
            f"超了旁白就读不完，声音会盖到下一个镜头上。"
            f"超过就在最近的句末标点处断开成两个镜头，两镜的 script_ref 拼起来"
            f"必须仍等于原文，不许删改任何文字。duration_sec 按中文语速 5 字/秒估算，"
            f"不必落在 7-15 秒区间。"
        )

    all_shots: list[dict] = []
    characters: list[str] = []
    locations: list[str] = []
    #: 道具总表（跨块去重）。与 characters/locations 平级 —— 三者都用来**建资产行**。
    props: list[str] = []
    #: 抢救痕迹（有损）与修补痕迹（无损）逐块累积，最终挂到 BreakdownOut 上。
    #: ⚠️ 这两个标记以前**根本没有出口**：`_salvaged` 只被赋值、全代码库无人读取，
    #: 于是"丢了一半镜头"和"正常拆完"在日志/UI/库里长得一模一样。
    salvage_notes: list[str] = []
    repaired = False
    # ---- 2026-11-10 新流程：模型切段（散文）→ 代码装箱 ----
    #
    # 只对真人剧生效（解说剧的镜头长度由旁白朗读时长决定，沿用老路径）。
    # 灰度开关 FW_BREAKDOWN_MODE=segments|legacy，见 config.breakdown_mode。
    use_segments = (not (max_chars and max_chars > 0)
                    and (get_settings().breakdown_mode or "").strip().lower() == "segments")
    seg_list: list = []
    if use_segments:
        from ..breakdown_segments import SEGMENT_SYSTEM, parse_segments
        system = SEGMENT_SYSTEM
    for chunk in split_for_ai(script):
        if use_segments:
            raw = await llm.complete(system, chunk, temperature=0.3,
                                     allow_truncated=True)
            segs, seg_warns = parse_segments(raw)
            if seg_warns:
                logger.warning("[breakdown] 分段解析告警：%s", "；".join(seg_warns[:8]))
            if not segs:
                logger.warning("[breakdown] 本块没有解析出任何段（原始输出前 200 字：%s）",
                               (raw or "")[:200])
                salvage_notes.append("有一块剧本没有解析出任何镜头，该部分剧情可能丢失（建议重拆）")
            seg_list.extend(segs)
            continue
        # allow_truncated: 极端情况下仍截断时，交给 _parse_breakdown_json 抢救
        # 完整镜头（丢弃残缺尾部），比整块报废更好
        raw = await llm.complete(system, chunk, temperature=0.3,
                                 allow_truncated=True)
        data = _parse_breakdown_json(raw)
        if data.get("_salvaged"):
            note = data.get("_salvage_note") or "输出被截断，尾部镜头已丢弃"
            salvage_notes.append(note)
            logger.warning("[breakdown] 本块发生有损抢救：%s（已记录到作业结果）", note)
        if data.get("_repaired"):
            repaired = True
        for s in data.get("shots", []):
            s["order"] = len(all_shots) + 1  # 跨块连续编号
            all_shots.append(s)
        for c in data.get("characters", []):
            if c not in characters:
                characters.append(c)
        for l in data.get("locations", []):
            if l not in locations:
                locations.append(l)
        # 道具总表同款跨块去重（2026-10-08）。它决定建哪些道具资产，
        # 漏掉就等于"只有第一块里出现过的道具才建资产"。
        for x in data.get("props", []):
            if x not in props:
                props.append(x)

    if use_segments:
        all_shots = [{"order": i + 1, "script_ref": g.script_ref,
                      "link_to_prev": "transition" if g.scene_change else "continuous",
                      "characters": g.characters, "props": g.props,
                      "location": g.location, "duration_sec": None}
                     for i, g in enumerate(seg_list)]

    # 确定性兜底：**同一段剧情被规划两次**必须在这里丢掉一份。
    #
    # 触发样本（项目 60a81f4482ce 第 28 集）：模型输出到第 8、9 镜后又回退重写了
    # 一遍第 8、9 镜，落库成了 A B A B。原文里这两句台词在全部 61 集中**各只出现
    # 1 次**，所以重复 100% 来自模型，不是原文。
    #
    # 为什么必须放在这里而不是指望提示词：这是**确定性**判据（文本相似度 + 邻接），
    # 无论模型怎么抽风都成立。放在合并之前——合并会把相邻的重复镜并成一条，
    # 反而把"两遍"糊成"一遍加长"，看起来像正常镜头，更难发现。
    all_shots, dup_notes = _drop_duplicate_shots(all_shots)
    if dup_notes:
        logger.warning("[breakdown] 检测到同段剧情被规划两次，已丢弃重复的一份：%s",
                       "；".join(dup_notes))

    if use_segments:
        # 装箱：同场的段依次装满到模型上限，只在换场时断开（见 breakdown_segments）。
        # 去重（上面）对段同样成立：它按相邻文本相似度判，与单位是"段"还是"镜"无关。
        from ..breakdown_segments import Segment, pack
        segs2 = [Segment(order=i + 1, script_ref=s["script_ref"],
                         location=s.get("location"),
                         scene_change=s.get("link_to_prev") == "transition",
                         characters=list(s.get("characters") or []),
                         props=list(s.get("props") or []))
                 for i, s in enumerate(all_shots)]
        all_shots = pack(segs2, float(win.ceil), loc_related=_loc_related)
        for s in all_shots:
            for c in s["characters"]:
                if c not in characters:
                    characters.append(c)
            if s.get("location") and s["location"] not in locations:
                locations.append(s["location"])
            for x in s["props"]:
                if x not in props:
                    props.append(x)
    else:
        # 确定性兜底：纯环境描写/场景标题残留不得独立成镜（跨块统一处理，
        # 保证块边界处的环境描写也能并入下一块的首个剧情镜头）
        all_shots = _merge_fragment_shots(all_shots)
        # 合并兜底：把短镜并进相邻镜头（同时消灭"一个开门拆两镜"）。长镜模型在这里
        # 把节拍一路打包到 30s——总时长不变，镜头数变少，这才是 2.5 的正确用法。
        # 必须在跨块合并之后做，块边界处的碎镜才有机会与邻块首镜合并。
        all_shots = _merge_short_shots(all_shots, win)
    # 解说剧兜底：读不完的镜头按句界拆开。**必须在合并之后**——
    # 先拆后合会把刚拆开的两段又并回去。
    all_shots = _split_overlong_shots(all_shots, max_chars)
    # 真人剧兜底：台词念不完的镜头按内容单元拆开（同样必须在合并之后）。
    # 与上面互斥：max_chars 为真即解说剧，已由上一步处理。
    if not max_chars:
        all_shots = _split_overlong_drama_shots(all_shots, win)
    if use_segments:
        # 新流程：时长用装箱的同一把尺子定稿（见 breakdown_segments.settle_durations）
        from ..breakdown_segments import settle_durations
        settle_durations(all_shots, float(win.ceil), _DUR_FLOOR)

    # 覆盖率自检：**这是"丢失剧情"最后也最可靠的一道网。**
    #
    # 上面的括号修补治的是"结构破损"，`_drop_duplicate_shots` 治的是"写了两遍"，
    # 但**输出真被截断**时丢掉的尾部剧情，任何解析技巧都救不回来 ——
    # 模型根本没写出来。唯一能做的：**量出来，说出来，让调用方重试。**
    #
    # 判据是"镜头文本对原文的覆盖率"：把各镜 script_ref 拼起来看原文有多少字
    # 没被任何镜头覆盖。正常集普遍在 90% 以上（场景标题行按规则 3 不进 script_ref，
    # 所以本就不该指望 100%）。实测受损集：ep4 只有 72%、ep9 70%、ep20 77% ——
    # 显著离群，且都伴随"镜数少得离谱"（1482 字的集只出 2 镜）。
    cov, cov_note = _breakdown_coverage(script, all_shots)
    if cov_note:
        logger.warning("[breakdown] %s", cov_note)

    # 顺序回退检测：**只告警、不自动修**。
    # 与 `_drop_duplicate_shots` 的分工：那个能确定该丢哪一份（副本紧跟原句、
    # 后一份才是错位的），所以自动丢；而一般的"后段提前"删哪一个都可能删掉
    # 真剧情，只能报给人看。
    order_notes = _detect_order_regression(script, all_shots)
    if order_notes:
        logger.warning("[breakdown] 检测到剧情顺序回退：%s", "；".join(order_notes))

    shots = [ShotDraft(**s) for s in all_shots]

    # 落库：传了 project_id 就持久化镜头与资产草稿（持锁防多集并发竞态）
    if project_id:
        # ⚠️ 不能写 `episode or 1`：前言的 episode 是 **0**，`or` 会把它静默
        # 变成 1，于是前言镜头和真正的第 1 集混在一起。上游 breakdown_by_episode
        # 已经过滤掉前言，但 /breakdown 路由也直接调本函数，这里必须自己站住。
        ep = episode if episode is not None else 1
        async with _breakdown_lock(project_id):
            with get_session() as session:
                if episode is not None:
                    # 按集：只删该集旧镜头，order 接在其他集之后连续编号
                    session.query(Shot).filter(
                        Shot.project_id == project_id, Shot.episode == ep).delete()
                    max_order = (session.query(Shot)
                                 .filter(Shot.project_id == project_id)
                                 .order_by(Shot.order.desc()).first())
                    base_order = max_order.order if max_order else 0
                else:
                    # 整项目重拆（历史行为）
                    session.query(Shot).filter(Shot.project_id == project_id).delete()
                    session.query(Asset).filter(Asset.project_id == project_id).delete()
                    base_order = 0
                for i, s in enumerate(shots):
                    # 导演意图（2026-09-20 新增）：拆解时一并产出，供提示词优化器
                    # 消费。**不新增数据库列**，放进 profile_override 这个既有的
                    # per-shot JSON 覆盖列里，用独立的 `directing_note` 键 ——
                    # `_override_of()` 是按 key 取值的，新键不会与
                    # generation_mode / model_id 等既有键冲突。
                    #
                    # 为什么必须由拆解给：下游优化器拿到的原本只有剧本原文，
                    # 它不知道这一镜在全片里承担什么功能，只能把剧本「翻译」一遍。
                    # 人工精品之所以好，是因为导演先决定了这一镜要干什么。
                    # 实测：光线覆盖 13.6%、景深 7.3% —— 缺的正是"这一镜要什么"。
                    _dn = getattr(s, "directing_note", None)
                    _ov = (json.dumps({"directing_note": _dn}, ensure_ascii=False)
                           if isinstance(_dn, dict) and _dn else None)
                    session.add(Shot(
                        id=uuid.uuid4().hex[:12], project_id=project_id,
                        order=base_order + i + 1, script_ref=s.script_ref,
                        link_to_prev=s.link_to_prev,
                        characters=json.dumps(s.characters, ensure_ascii=False),
                        # 道具（2026-10-08）：与 characters 同款 JSON 数组列。
                        # ⚠️ 必须用 `s.props`（ShotDraft 的声明字段）而不是
                        # `s.get("props")` —— s 是 ShotDraft 实例，没有 .get()。
                        props=json.dumps(s.props or [], ensure_ascii=False),
                        location=s.location,
                        profile_override=_ov,
                        episode=ep, status="pending",
                        # 解说剧按朗读时长（TTS 出来后 _retime_shot 还会再覆盖一次）；
                        # 真人剧钳到 [7, win.ceil]（合并后可达 30s）。用同一个 [7,15] 套解说剧，
                        # 480p 的 45s 长镜会被砍成 15s、1080p 的 7.5s 上限会被顶穿。
                        #
                        # ⚠️ 高强度动作镜用收紧后的窗口（2026-09-23）。这一处漏掉过：
                        # 合并与拆分都已按 ≤[7,15] 把动作镜切好，落库却仍按 win 钳，
                        # 而 `_clamp_duration` 里的**表演余量**会在原长上再加 1~4 秒
                        # —— 923 实测 #17 草稿 14.5s 被顶回 **18.5s**，等于把刚切开的
                        # 那一刀补回去一半，且全程无报错。
                        duration_sec=(
                            _narration_duration(s.script_ref,
                                                max_chars / _CPS_SLOW)
                            if max_chars and max_chars > 0
                            else float(s.duration_sec) if use_segments and s.duration_sec
                            else _clamp_duration(
                                s.script_ref, s.duration_sec,
                                action_window(win) if _is_action_shot(s) else win,
                                list(s.characters or []))),
                    ))
                # 资产增量合并（按集拆解时不清空其他集的角色/场景）。
                # 规则在 asset_seed.ensure_assets：角色按原名、场景/道具按归一名
                # （拆解给的场景带「夜 内」前缀，原样建会让同一个房间分裂成多行；
                # 道具同款，模型会在不同集里写「刀」/「那把长刀」）；同名墓碑不复活。
                # 道具**不做**通用陈设过滤：按关键词硬过滤会误杀「台灯」这种真道具，
                # 建多了用户能在要素页删，建少了无从补救。
                # 桌面端绕过拆解逐镜写字段时（agent patch_shot）也走同一份规则。
                from ..asset_seed import ensure_assets
                ensure_assets(session, project_id, characters=characters,
                              locations=locations, props=props)
                if episode is None:
                    proj = session.get(Project, project_id)
                    if proj:
                        proj.optimized_script = script
                # 3.9 在场推导（L1.5）：拆解 LLM 即使被规则 8 提醒过也仍会漏人，
                # 这里做一次确定性兜底 —— 同场连续戏内把先出现过、且没有离场
                # 描写的角色向后传播。必须在 commit **之前**跑：它读的就是刚
                # 落库的这批镜头，且要与它们同一个事务提交。
                session.flush()
                try:
                    refresh_present_characters(session, project_id)
                except Exception:  # noqa: BLE001
                    # 推导失败不能把整次拆解带走：没有 L1.5 只是退回旧行为，
                    # 而拆解结果本身是用户等了几十秒换来的
                    logger.exception("在场推导失败（拆解结果照常保存）")
                session.commit()

    return BreakdownOut(
        shots=shots,
        characters=characters,
        locations=locations,
        props=props,
        model_id=llm.model_id,
        # 告警顺序按"严重度"排：覆盖不足（剧情真丢了）> 截断抢救 > 顺序回退 > 去重。
        # 用户界面按序展示即可，第一条就是他最该看的那条。
        warnings=(([cov_note] if cov_note else []) + salvage_notes
                  + order_notes + dup_notes),
        lossy=bool(salvage_notes) or cov < _COVERAGE_FLOOR,
    )


@router.post("/script/breakdown", response_model=BreakdownOut)
async def script_breakdown(body: ScriptBreakdownIn) -> BreakdownOut:
    from .. import charge

    # 文本操作按次收（同 script_optimize）。
    charge.charge_sync("breakdown_all", {"project_id": body.project_id},
                       desc="剧本拆解", project_id=body.project_id)
    # 单集重拆也要按项目选定的视频模型定时长窗口，否则同一个 2.5 项目里
    # 「整本拆」出来的是 25-30s 长镜、「单集重拆」出来的却是 8-12s 碎镜。
    cap: float | None = None
    if body.project_id:
        with get_session() as session:
            proj = session.get(Project, body.project_id)
            if proj:
                cap = breakdown_shot_cap(proj)
    try:
        return await do_breakdown(body.script, body.model_id, body.project_id,
                                  episode=body.episode, shot_cap_sec=cap)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"拆解失败: {e!r}")


# ────────────────────────────────────────────────────────────────────────────
# 追加剧本（第二期/续集/编剧还没写完的后续集）
# ────────────────────────────────────────────────────────────────────────────

class AppendScriptIn(BaseModel):
    project_id: str
    script: str
    #: 期数标签（如"第二期"）。留空时自动推算（当前最大期号 +1）。
    period_label: Optional[str] = None
    model_id: Optional[str] = None
    pregen_prompts: bool = True


class AppendScriptOut(BaseModel):
    period: int
    period_label: str
    start_episode: int
    episodes_added: int
    skipped: list[dict]
    note: Optional[str] = None
    job_id: Optional[str] = None  # 2026-11-04: 改为异步 job 后返回 job ID


@router.post("/script/append", response_model=AppendScriptOut)
async def script_append(body: AppendScriptIn) -> AppendScriptOut:
    """追加剧本：在不清空已有镜头的前提下导入新的集。

    ## 用途

    适用于第二季、编剧还没写完后续集、或者分段导入的情况。
    新集复用项目里已有的角色/场景/资产，无需重建。

    ## 2026-11-04 重做：导入即定集号，只保存不拆解

    用户预期是「导入 → 剧本页立刻看到新集 → 自己点拆解」。
    此前有两处致命缺陷：

    1. **自动触发拆解**，没有给用户查看/编辑新集的机会；
    2. **靠 `episode_offset` 在拆解时才偏移集号**，而剧本页显示的是
       `smart_split_chapters(raw_script)` 的结果 —— 新旧两份剧本各自
       从"第1集"开始，拼在一起后按 order 排序会**交错**：

           旧第1集(1) 新第1集(1) 旧第2集(2) 新第2集(2)
               ↓ 重新编号
           第1集      第2集      第3集      第4集

       于是"第二期第1集"排到了"第一期第2集"前面，全剧顺序错乱。

    现在改为**在写库时就把新集的集号改写成绝对集号**（新剧本第1集 →
    项目第31集），并重写集标题行。这样 `raw_script` 本身就是一份
    集号连续的完整剧本，任何读它的地方（剧本页、拆解、导出）都天然正确，
    不再需要在拆解路径上传偏移量。

    `period_offsets` 仍然记录分期信息，但只用于**显示**（第31集显示成
    "第2期 第1集"），不再参与集号计算。
    """
    import json as _json
    import re as _re
    from ..db import Project
    from ..script_import import smart_split_chapters

    with get_session() as session:
        proj = session.get(Project, body.project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="项目不存在")

        # ── 现有全剧分集 ─────────────────────────────────────────────────
        old_chapters: list[dict] = smart_split_chapters(proj.raw_script or "")

        # ── 新剧本分集 ───────────────────────────────────────────────────
        new_chapters: list[dict] = smart_split_chapters(body.script or "")
        if not new_chapters:
            raise HTTPException(status_code=400, detail="追加的内容里解析不出任何剧集")

        # ── 当前最大集号 ─────────────────────────────────────────────────
        # 取三者最大：已拆镜头的集号、剧本里的集号。
        # 只看镜头会漏掉"剧本有但还没拆"的集，只看剧本会漏掉"镜头比剧本多"的
        # 历史项目（早期导入后剧本被改短过），所以两个都看。
        from sqlalchemy import func
        max_shot_ep = int(session.query(func.max(Shot.episode))
                          .filter(Shot.project_id == body.project_id).scalar() or 0)
        max_script_ep = max((c["order"] for c in old_chapters if c["order"] > 0), default=0)
        base_ep = max(max_shot_ep, max_script_ep)

        # ── 把新集号改写成绝对集号 ───────────────────────────────────────
        def _renumber_title(title: str, abs_order: int) -> str:
            """把 "第1集 归途" 改写成 "第31集 归途"。

            集/章/话/回/节/幕/场 一律统一成「集」——本项目只认集这一级。
            """
            tail = _re.sub(
                r'^第\s*[一二三四五六七八九十百千零壹贰叁肆伍陆柒捌玖\d]+'
                r'\s*[集章话回节幕场]\s*', '', title or '').strip()
            return f"第{abs_order}集 {tail}".strip()

        added: list[dict] = []
        skipped: list[dict] = []
        preamble_text: list[str] = []
        for c in new_chapters:
            if c["order"] <= 0:
                # 前言（第一个集标记之前的内容）：不拆解，但文本不能丢。
                # 并到**第一个新集**的正文开头，随那一集的镜头一起被拆解吸收，
                # 而不是静默丢弃。
                preamble_text.append(c["content"].strip())
                skipped.append({"episode": c["order"], "title": c["title"],
                                "reason": "非正片前言，已并入第一个新集的正文开头"})
                continue
            c["order"] = base_ep + c["order"]
            c["title"] = _renumber_title(c["title"], c["order"])
            added.append(c)

        if not added:
            raise HTTPException(status_code=400, detail="追加的内容里没有可用的剧集")

        if preamble_text:
            head = "\n\n".join(t for t in preamble_text if t)
            if head:
                added[0]["content"] = f"{head}\n\n{added[0]['content']}".strip()
                added[0]["word_count"] = len(added[0]["content"])

        # ── 合并并重排 ───────────────────────────────────────────────────
        merged = old_chapters + new_chapters
        merged.sort(key=lambda c: c["order"])

        # 用「标题行 + 正文」重新序列化，而不是把新文本裸拼到旧文本后面。
        # 裸拼会让新剧本开头的"第1集"标记落在旧剧本正文中间，下一次解析时
        # 被切成更多集（实测直接把 5+3 集切成 16 集）。
        # 这与 `PUT /episodes/{order}/content` 的做法一致：本系统的剧本
        # 真值就是这张分集表，序列化只是它的文本投影。
        proj.raw_script = "\n\n".join(
            f"{c['title']}\n{c['content']}".strip() for c in merged)
        proj.episodes = _json.dumps(
            [{"order": c["order"], "title": c["title"],
              "word_count": len(c["content"])} for c in merged],
            ensure_ascii=False)

        # ── 期数信息（只用于显示） ───────────────────────────────────────
        existing_periods: list[dict] = _json.loads(proj.period_offsets or "[]")
        period_no = (max((p["period"] for p in existing_periods), default=1) + 1)
        label = (body.period_label or f"第{period_no}期").strip()
        start_episode = base_ep + 1
        existing_periods.append({
            "period": period_no,
            "label": label,
            "start_episode": start_episode,
        })
        proj.period_offsets = _json.dumps(existing_periods, ensure_ascii=False)

        session.commit()

    return AppendScriptOut(
        period=period_no,
        period_label=label,
        start_episode=start_episode,
        episodes_added=len(added),
        skipped=skipped,
        note=(f"已导入 {len(added)} 集（第 {start_episode}–{base_ep + len(added)} 集），"
              f"剧本页可以查看和修改；确认无误后点「重新拆镜」开始拆解"),
        job_id=None,  # 不自动拆解
    )


@router.post("/script/append-file", response_model=AppendScriptOut)
async def script_append_file(
    file: UploadFile = File(...),
    project_id: str = Form(...),
    period_label: Optional[str] = Form(None),
    pregen_prompts: bool = Form(True),
) -> AppendScriptOut:
    """文件版追加剧本：支持 txt/md/docx/pdf，解析为文本后与文本版同流程。

    multipart：中间件与档位依赖都不解析这种请求体，拿不到 project_id，所以归属与档位**只能在这里判**
    （2026-11-05 补上：此前任何登录用户都能往别人的项目追加剧本）。
    """
    from ..script_files import parse_script_file
    from ..db import get_session

    def _require_project(pid: str = project_id) -> None:
        with get_session() as session:
            access.require_project_access(session, pid)

    await asyncio.to_thread(_require_project)

    content = await file.read()
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="文件超过 50MB 上限")
    try:
        text = parse_script_file(file.filename or "unknown", content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not text.strip():
        raise HTTPException(status_code=400, detail="文件中未提取到文字内容")

    return await script_append(AppendScriptIn(
        project_id=project_id,
        script=text,
        period_label=period_label or None,
        pregen_prompts=pregen_prompts,
    ))
