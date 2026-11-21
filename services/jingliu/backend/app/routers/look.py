"""资产视觉体检、场景多视角、美术设定板、全片影调与画风。

`POST /v2/assets/{id}/qc`                    —— 「人物图无场景 / 场景图无人」可核验
`GET  /v2/assets/{id}/scene-views` 及其 generate / delete
`POST /v2/assets/{id}/board`                  —— 8 张视角拼成美术设定板
`GET/PUT /v2/projects/{pid}/look` 与 `/look/regenerate`   —— 全片影调统一
`GET/PUT /v2/projects/{pid}/art-style`        —— 画风预设

## 为什么从 routes_v2.py 搬出来

行数预算「只许减」（见 `routers/__init__.py`）。它原先被迫**放在文件末尾**，
因为要用到上面才定义的 `JobOut` / `BackgroundTasks`（FastAPI 在装饰器执行时
就要解析返回注解，前置会 NameError）—— 那个"文件末尾依赖"的位置本身
就是巨石文件才有的怪相。搬出来以后这些依赖变成正常的模块级 import。

## 依赖方向

本模块 import `job_submit`（`_SUBMIT_LOCK` / `_run_job_guarded`）与 `jobs`
（`create_job` / `find_active_job` / `RUNNERS`）—— **路由层依赖任务层，
方向正确、无环**。这也是先把那对下沉到 `job_submit.py` 的原因：
否则本模块与 desub / upscale 会各自反向 import routes_v2。
"""
from __future__ import annotations

import asyncio
from typing import Optional
import json
import logging
import uuid

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from .. import access   # 多用户隔离：归属校验（2026-10-09）
from ..db import Asset, AssetStage, Job, Project, SceneView, desc_of, get_session
from .. import asset_gate
from .. import stage_gate
from ..job_models import JobOut
from ..job_submit import _SUBMIT_LOCK, _run_job_guarded
from .. import look_profile as _lp
from .. import scene_view as _sv
from .. import style_preset as _sp

router = APIRouter(prefix="/v2", tags=["look"])
logger = logging.getLogger(__name__)


def _scene_asset(session, asset_id: str) -> Asset:
    """取一个**场景**资产行，不是场景就 400。"""
    a = access.req_asset(session, asset_id)
    if a.kind != "location":
        raise HTTPException(status_code=400, detail="只有场景资产有多视角参考图")
    return a


def _view_row_payload(r: SceneView) -> dict:
    qc = None
    if (r.qc_json or "").strip():
        try:
            qc = json.loads(r.qc_json)
        except json.JSONDecodeError:
            qc = None       # 脏数据当没体检过，不让它把弹窗打崩
    v = _sv.BY_KEY.get(r.view_key)
    return {"id": r.id, "key": r.view_key, "kind": r.kind,
            "label": r.label, "sort": r.sort,
            "primary": bool(v.primary) if v else False,
            "image_url": r.image_url, "prompt": r.prompt, "qc": qc}


@router.get("/assets/{asset_id}/scene-views")
def get_scene_views(asset_id: str) -> dict:
    """一个场景资产的 8 张多视角参考图现状（资产弹窗打开时拉一次）。

    这里会**顺带补齐** 8 行 `SceneView`（`ensure_views` 幂等），并认领老项目
    已有的那张 `Asset.image_url` 当主视角——不认领的话前端会显示"主视角缺图"，
    用户点补齐就白花一次钱画同一个房间的同一个角度。

    视图定义（标签/顺序）随 `views` 一起下发，前端不硬编码任何标签。
    """
    with get_session() as session:
        a = _scene_asset(session, asset_id)
        rows = _sv.ensure_views(session, a)
        changed = _sv.sync_primary_to_asset(session, a)
        session.commit()
        payload = [_view_row_payload(r) for r in rows]
        return {"asset_id": a.id, "name": a.name, "project_id": a.project_id,
                "description": desc_of(a), "board_url": a.board_url,
                "progress": _sv.progress(session, a.id),
                "defs": _sv.views_payload(),
                "views": payload,
                # 主视角刚被认领/更新过 → 前端顺带刷一下资产缩略图
                "primary_synced": changed}





class AssetQcIn(BaseModel):
    #: 只体检这几个视角（场景资产用）；空 = 全部有图的
    view_keys: list[str] = []
    #: 角色图：是否按"三视图 + 左上角标注"的新口径判。2026-09-09 之前生成的
    #: 老定妆图是单视图无标注，对它们报这两项是代际差异而非缺陷。
    expect_three_view: bool = True
    expect_name_label: bool = True


class SceneViewsGenerateIn(BaseModel):
    #: 指定视角 = 无论有没有图都重画这几张；空 = 只补缺图的（省钱的默认）
    view_keys: list[str] = []
    #: 缺省用**项目自己的** image_model（不是全局默认——那正是色调不统一的成因之二）
    model_id: Optional[str] = None
    #: ⚠️ 场景图固定 16:9（见 jobs.SCENE_ASSET_SIZE）。这里写成同值只为不误导读者；
    #: 真正起作用的是 run_asset_batch 里对 scene_view_id 项的强制，客户端传什么都一样。
    size: str = "1792x1024"


@router.post("/assets/{asset_id}/scene-views/generate")
async def generate_scene_views(asset_id: str, body: SceneViewsGenerateIn,
                               background: BackgroundTasks) -> JobOut:
    """生成/补齐该场景的多视角参考图（走 asset_batch job，前端按 job 轮询进度）。

    提示词一律由 `jobs.scene_view_items_for_asset` 拼——**本路由不自己拼提示词**，
    否则弹窗手动补的图和一键成片自动补的图会是两套口径（`asset_prompt` 模块头
    记过这个教训）。

    影调档案在这里 `ensure`（没有就按剧本生一份）：8 张图必须共用同一套调色基调，
    否则一个场景内部就先花了。失败不阻断——退回无影调提示词。
    """
    from ..jobs import _resolve_asset_image_model, scene_view_items_for_asset

    with get_session() as session:
        a = _scene_asset(session, asset_id)
        proj = session.get(Project, a.project_id)
        project_id, title = a.project_id, (proj.title if proj else "")
        # 弹窗里当场选的模型 > 本项目给「场景」这一类配的模型 > 项目 image_model
        # （2026-10-21：三类资产可各用不同生图模型，见 jobs.asset_image_models）。
        image_model = body.model_id or _resolve_asset_image_model(proj, "location")

    try:
        look = await _lp.ensure(project_id)
    except Exception as e:  # noqa: BLE001 影调是增强项，绝不阻断出图
        logger.warning("[look] 场景视角生成时取影调失败，按无影调继续: %r", e)
        look = None

    bad = [k for k in body.view_keys if k not in _sv.BY_KEY]
    if bad:
        raise HTTPException(status_code=400, detail=f"未知视角: {'、'.join(bad)}")

    # 与批量补资产的去重（同 submit_job 的理由：同一批图生成两遍就是纯烧钱）。
    # 分两种情况，判据与 `find_active_job` 的 TB-04 一致：
    #   · 没点名视角（= 补齐缺失）→ 与在跑的 asset_batch **完全重叠**，挡住；
    #   · 点名了视角（= 用户要重画这一张）→ 定向操作，放行，否则"重画"点了没反应。
    # 查重与建 job 之间不能有 await，故共用 `_SUBMIT_LOCK`（见 submit_job 的说明）。
    from .. import charge
    from ..jobs import RUNNERS, create_job, find_active_job

    async with _SUBMIT_LOCK:
        if not body.view_keys:
            dup = find_active_job("asset_batch", project_id)
            if dup:
                raise HTTPException(status_code=409, detail={
                    "reason": "batch_running", "job_id": dup,
                    "message": "该项目的资产生图任务正在跑，缺失视角会由它一并补齐。"
                               "要立刻重画某一张请点名视角。"})
        with get_session() as session:
            a = _scene_asset(session, asset_id)
            items = scene_view_items_for_asset(session, a, title, look,
                                               body.view_keys or None)
            session.commit()
        if not items:
            raise HTTPException(status_code=400, detail={
                "reason": "nothing_to_do",
                "message": "这个场景的 8 张参考图都已生成。要重画请指定视角。"})

        payload = {"project_id": project_id, "items": items,
                   "size": body.size, "model_id": image_model}
        # 积分预扣（2026-11-21 补上：此前这条路由不扣费，视角图不收钱）。顺序与
        # POST /v2/jobs 一致：查重 → 扣 → 建 job，钱和任务共用先生成的 id；
        # `_run_job_guarded` 结束时按实际出图张数多退少补，失败全额退。
        jid = uuid.uuid4().hex[:12]
        _charged, _ = charge.should_charge("asset_batch", payload)
        if _charged:
            _est, _note = charge.estimate("asset_batch", payload)
            if _est > 0:
                charge.hold("asset_batch", payload, jid, amount_fen=_est, note=_note)
        create_job("asset_batch", payload, jid=jid)
    background.add_task(_run_job_guarded, RUNNERS["asset_batch"], jid, "asset_batch")
    return JobOut(id=jid, kind="asset_batch", status="pending", progress=0)


@router.delete("/assets/{asset_id}/scene-views/{view_key}")
def clear_scene_view(asset_id: str, view_key: str) -> dict:
    """清掉某个视角的图（只清这一行，图片文件保留在磁盘上）。

    为什么不顺手删文件：这张图可能已经被注入进某些镜头的提示词/已出的片子里，
    删文件会让那些镜头的参考图 404。清引用足够——用户要的是"重画这一张"。
    主视角被清空时同步清 `Asset.image_url`，否则 `ensure_views` 下次又把它认领回来。
    """
    if view_key not in _sv.BY_KEY:
        raise HTTPException(status_code=400, detail=f"未知视角: {view_key}")
    with get_session() as session:
        a = _scene_asset(session, asset_id)
        row = (session.query(SceneView)
               .filter(SceneView.asset_id == a.id,
                       SceneView.view_key == view_key).first())
        if row is None:
            raise HTTPException(status_code=404, detail="该视角还没有记录")
        old, row.image_url, row.qc_json = row.image_url, None, None
        if _sv.BY_KEY[view_key].primary and a.image_url == old:
            a.image_url = None
        session.commit()
    return {"ok": True}


@router.post("/assets/{asset_id}/board")
def build_scene_board(asset_id: str) -> dict:
    """把该场景已有的视角图拼成**美术设定板**并落库（`Asset.board_url`）。

    ⚠️ 设定板是**派生产物、只给人看**：它带格子线与中文标注，一旦当参考图注入
    镜头，模型会把格子和标注抄进画面（见 `scene_board` 模块头）。所以它只写
    `board_url` 这一列，绝不写 `image_url`，注入链路也从不读它。

    缺图的格子画"未生成"占位，不报错——"这个场景齐不齐"本身就是有用的信息。
    """
    from .. import scene_board
    with get_session() as session:
        a = _scene_asset(session, asset_id)
        proj = session.get(Project, a.project_id)
        title = proj.title if proj else ""
        look_text = _lp.phrase(_lp.decode(proj.look_json) if proj else None)
        views = [{"label": r.label, "kind": r.kind, "image_url": r.image_url}
                 for r in _sv.ensure_views(session, a)]
        desc, name = desc_of(a), a.name
        session.commit()

    url = scene_board.build(title, name, views, description=desc,
                            look_text=look_text or None)
    if not url:
        raise HTTPException(status_code=502, detail="设定板拼装失败（详见后端日志）")
    with get_session() as session:
        a = session.get(Asset, asset_id)
        if a is not None:
            a.board_url = url
            session.commit()
    return {"ok": True, "board_url": url}


# ---------------------------------------------------------------- 影调档案

@router.get("/projects/{project_id}/look")
def get_project_look(project_id: str) -> dict:
    """全片影调档案 + 词表（前端据此渲染下拉，不硬编码任何词）。"""
    with get_session() as session:
        p = session.get(Project, project_id)
        if not p:
            raise HTTPException(status_code=404, detail="project not found")
        look = _lp.decode(p.look_json)
    return {"look": look,                      # None = 还没生成过
            "phrase": _lp.phrase(look),        # 实际拼进提示词的那句话，可见即可查
            "axes": _lp.axes_payload(),
            "extra_max": _lp.EXTRA_MAX_LEN,
            "axis_max": _lp.AXIS_MAX_LEN}


class ProjectLookIn(BaseModel):
    #: {轴 key: 取值}。词表外的自定义短词也接受（越界值只标注、不丢弃）
    axes: dict[str, str] = {}
    #: 词表表达不了的整片质感补充
    extra: str = ""


@router.put("/projects/{project_id}/look")
@access.requires(access.ROLE_MANAGER)
def put_project_look(project_id: str, body: ProjectLookIn) -> dict:
    """手改影调档案（标 `confirmed`，此后自动流程不再覆盖）。

    ⚠️ 改影调**不会**自动重画任何已生成的图。它只影响此后新生成的资产图、
    场景视角图、首帧图与视频提示词——想让老图跟上，得删掉重画（前端给这句提示）。
    """
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
    doc = _lp.save(project_id, {"axes": body.axes, "extra": body.extra},
                   confirmed=True)
    if doc is None:
        raise HTTPException(status_code=400, detail="影调档案为空（至少给一个轴的取值）")
    return {"ok": True, "look": doc, "phrase": _lp.phrase(doc)}


class ProjectStyleIn(BaseModel):
    #: 画风 key（`style_preset.STYLES`）。空串/None = 清空，回到该模式默认档。
    art_style: Optional[str] = None


@router.get("/projects/{project_id}/art-style")
def get_project_art_style(project_id: str) -> dict:
    """项目画风现状 + 该模式可选清单（含未启用档，供前端灰显）。"""
    with get_session() as session:
        p = session.get(Project, project_id)
        if not p:
            raise HTTPException(status_code=404, detail="project not found")
        mode, chosen = p.production_mode, p.art_style
    eff = _sp.resolve(mode, chosen)
    cat = {m["key"]: m for m in _sp.catalog()["modes"]}
    m = cat.get((mode or "drama"), cat["drama"])
    return {
        "production_mode": mode,
        "art_style": chosen,
        "effective_style": eff.key,
        "effective_label": eff.label,
        #: 选了一档但它还没启用 —— 前端要显式说明"当前实际按都市档生成"，
        #: 否则用户会以为自己选的古风已经生效，出图不对却找不到原因。
        "pending": bool(chosen) and chosen != eff.key,
        "styles": m["styles"],
        "default_style": m["default"],
    }


@router.put("/projects/{project_id}/art-style")
@access.requires(access.ROLE_MANAGER)
def put_project_art_style(project_id: str, body: ProjectStyleIn) -> dict:
    """改画风。

    ⚠️ 与影调同理：**不会重画任何已生成的图**，只影响此后新生成的资产图、
    场景视角图、首帧图与视频提示词。前端把这句话摊开写在面板上。

    非法 key（不属于本模式/不存在）被 `sanitize` 清成 None 而不是报错——
    但这里要把结果如实回给前端（`art_style` 为 null 就是没设上）。
    """
    with get_session() as session:
        p = session.get(Project, project_id)
        if not p:
            raise HTTPException(status_code=404, detail="project not found")
        p.art_style = _sp.sanitize(p.production_mode, body.art_style)
        session.commit()
        mode, chosen = p.production_mode, p.art_style
    eff = _sp.resolve(mode, chosen)
    return {"ok": True, "art_style": chosen, "effective_style": eff.key,
            "effective_label": eff.label,
            "pending": bool(chosen) and chosen != eff.key}


@router.post("/projects/{project_id}/look/regenerate")
@access.requires(access.ROLE_MANAGER)
async def regenerate_project_look(project_id: str) -> dict:
    """按剧本重新判一套影调（清空旧档案后重跑）。

    与形象档案同理：影调是审美判断，重判几乎必然给出不同结果，所以**只能**
    由用户显式触发，自动流程永不重生成（`look_profile.ensure` 绝不覆盖已有）。
    """
    with get_session() as session:
        p = session.get(Project, project_id)
        if not p:
            raise HTTPException(status_code=404, detail="project not found")
        p.look_json = None          # 清空才会被 ensure 当作"缺档案"
        session.commit()
    look = await _lp.ensure(project_id)
    if not look:
        raise HTTPException(status_code=502, detail="影调档案生成失败，请重试")
    return {"ok": True, "look": look, "phrase": _lp.phrase(look)}


@router.post("/assets/{asset_id}/qc")
async def qc_asset(asset_id: str, body: AssetQcIn) -> dict:
    """视觉体检：核验"人物图里没有场景 / 场景图里没有人 / 标注是否到位"。

    体检**不阻断任何流程、判不合格也只标记不删图**：判定本身会出错（模型也会
    看错），自动删图等于让一个不可靠的判断销毁用户资产（见 `asset_qc` 模块头）。

    场景视角的结论落库到 `scene_views.qc_json`（重开弹窗还能看到）；
    角色图只返回不落库——`assets` / `asset_stages` 上没有承载它的列，
    为一个可选的质检结论加列不值得。
    """
    from .. import asset_qc

    with get_session() as session:
        a = access.req_asset(session, asset_id)
        kind, name = a.kind, a.name
        if kind == "location":
            rows = _sv.ensure_views(session, a)
            session.commit()
            want = set(body.view_keys or [])
            targets = [(r.id, r.view_key, r.label, r.image_url) for r in rows
                       if (r.image_url or "").strip()
                       and (not want or r.view_key in want)]
        else:
            targets = [(None, None, "定妆图", a.image_url)] \
                if (a.image_url or "").strip() else []
            # 角色的图实际挂在造型阶段上，资产通用图往往为空，这里一并体检。
            # 墓碑阶段跳过：体检要调模型（花钱/耗时），对一个用户已经删掉的
            # 造型出结论毫无用处。
            for st in stage_gate.alive(
                    session.query(AssetStage)
                    .filter(AssetStage.project_id == a.project_id,
                            AssetStage.character_name == a.name)).all():
                if (st.image_url or "").strip():
                    targets.append((None, None, st.stage_name or "造型", st.image_url))
    if not targets:
        raise HTTPException(status_code=400, detail="这个资产还没有可体检的图")

    async def _one(t):
        _rid, _key, label, url = t
        if kind == "location":
            res = await asset_qc.check_scene(
                url, expect_name_label=body.expect_name_label)
        else:
            res = await asset_qc.check_character(
                url, expect_three_view=body.expect_three_view,
                expect_name_label=body.expect_name_label)
        return {"view_key": _key, "row_id": _rid, "label": label,
                "image_url": url, "result": res,
                "summary": asset_qc.describe(res)}

    out = await asyncio.gather(*[_one(t) for t in targets])

    if kind == "location":
        with get_session() as session:
            for item in out:
                if not item["row_id"] or item["result"] is None:
                    continue        # 体检没跑成就不写——别把"未完成"存成"通过"
                row = session.get(SceneView, item["row_id"])
                if row is not None:
                    row.qc_json = json.dumps(item["result"], ensure_ascii=False)
            session.commit()

    bad = [i for i in out if i["result"] and not i["result"].get("ok")]
    return {"name": name, "kind": kind, "checked": len(out),
            "failed": len(bad), "items": list(out)}
