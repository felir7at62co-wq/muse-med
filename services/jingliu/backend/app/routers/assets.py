"""资产（角色 / 场景 / 自定义）的 CRUD、出图、资料与视觉描述。

`POST   /v2/assets/generate` / `GET /v2/assets/candidates`
`POST   /v2/assets`  `PATCH/DELETE /v2/assets/{id}`  `POST /v2/assets/{id}/restore`
`GET/PUT /v2/assets/{id}/profile`  `POST /v2/assets/{id}/profile/regenerate`
`POST   /v2/assets/upsert-image`   —— 本地上传换图
`POST   /v2/assets/describe-image` —— 「🔍 AI 看图补写」

## 为什么从 routes_v2.py 搬出来

行数预算「只许减」（见 `routers/__init__.py`）。这一段在原文件里是一整块
连续代码，只碰 Asset / Project / Shot 三张表与图像 provider，整块搬走。

## 两条口径（别在改动时丢掉）

- **显式参考图优先于定妆图自动挑选**：`assets/generate` 传了非空 `ref_urls`
  就落 refs，仅在为空时才回退到自动挑定妆图。传空数组 ≠ 不传 ——
  空数组会被后端当成「显式空列表」而跳过自动挑选（前端因此传 null）。
- `describe_image` 是**用户显式点按钮**才跑的那条路径，语义与自动链路不同：
  外观应尽量交给参考图钳制，不要凭文字猜。见 `vision_desc` 的模块头。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
import json
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import access   # 多用户隔离：归属校验（2026-10-09）
from ..db import Asset, Project, Shot, get_session
from ..providers.image import ImageProvider

router = APIRouter(prefix="/v2", tags=["assets"])


# ---------- 阶段③：资产生图 ----------
class AssetGenerateIn(BaseModel):
    prompt: str
    model_id: Optional[str] = None  # 缺省用 settings.image_model（gpt-image-2）
    size: str = "1024x1024"
    #: 出几张候选。上限 4：这是同步接口，再多前端要等到超时，且每张都花钱
    n: int = Field(1, ge=1, le=4)
    #: 显式参考图（图生图）。传了就用它，不再自动找
    ref_urls: Optional[list[str]] = None
    # ---- 自动参考：同角色跨造型保脸（不传 ref_urls 时生效）----
    #: 项目 id；与 character_name 一起传才会去找该角色已有的定妆图当参考
    project_id: Optional[str] = None
    character_name: Optional[str] = None
    #: 正在重生成的那一张（阶段 id / 当前图 URL），会被排除出参考候选——
    #: 拿它自己当参考等于原地复制，而点重新生成就是想换一版
    exclude_stage_id: Optional[str] = None
    exclude_url: Optional[str] = None
    #: 关掉自动参考（用户想彻底重画一张脸时）
    use_char_ref: bool = True


class AssetGenerateOut(BaseModel):
    urls: list[str]
    model_id: str
    #: 实际用作参考的已有定妆图（None = 纯文生图）。前端据此如实标注，
    #: 不能让用户以为"保脸了"而其实没有
    ref_used: Optional[str] = None


@router.post("/assets/generate", response_model=AssetGenerateOut)
async def assets_generate(body: AssetGenerateIn) -> AssetGenerateOut:
    from ..providers.image import ContentRejected
    from .. import charge

    # 同步出图：先扣费再出图（生图是确定价 0.15 元/张，不需要事后结算）。
    # 走 charge_sync 而不是 hold/settle —— 这条没有 job 行，没有"终态"可等。
    charge.charge_sync("asset_generate", {"project_id": body.project_id,
                                          "n": body.n},
                       project_id=body.project_id)

    # 参考图：显式传的优先；否则按角色自动找已有定妆图（同一张脸）。
    # 与批量生图 run_asset_batch 共用 character_base_ref，两条路挑的基准一致。
    refs = list(body.ref_urls or [])
    if not refs and body.use_char_ref and body.project_id and body.character_name:
        from ..asset_ref import character_base_ref
        with get_session() as session:
            base = character_base_ref(
                session, body.project_id, body.character_name,
                exclude_stage_ids={body.exclude_stage_id} if body.exclude_stage_id else None,
                exclude_url=body.exclude_url)
        if base:
            refs = [base]

    provider = ImageProvider(model_id=body.model_id)
    try:
        urls = await provider.generate(body.prompt, size=body.size, n=body.n,
                                       ref_urls=refs or None)
    except ContentRejected as e:
        # 与首帧同口径：审核拒绝要能被前端识别，给"换模型/改提示词"而非"重试"
        cats = "、".join(e.categories) if e.categories else ""
        raise HTTPException(status_code=422, detail={
            "reason": "moderation",
            "categories": e.categories,
            "message": (f"提示词被内容审核判定违规{('（' + cats + '）') if cats else ''}。"
                        "重试无效——同一提示词判定一致。请弱化提示词中的敏感描写，"
                        "或换用其他生图模型（各厂商审核尺度不同）。"),
        }) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail={
            "reason": "channel", "message": f"生图失败: {str(e)[:300]}"}) from e
    return AssetGenerateOut(urls=urls, model_id=provider.model_id,
                            ref_used=refs[0] if refs else None)


@router.get("/projects/{project_id}/image-jobs")
def list_image_jobs(project_id: str, limit: int = 60) -> dict:
    """镜流「生图」页的历史：本项目最近若干次自由生图，带产出图。

    自由生图的图**不落任何资产表**（见 jobs.run_image_generate 的说明），
    只活在 job.result 里。所以这个端点不是"锦上添花的列表"，而是那些图
    **唯一**能被找回来的入口——没有它，图已落盘、钱已花掉、UI 却什么都看不见
    （候选图那条链路当初就是这个坑，见 latest_asset_candidates 的说明）。

    按 rowid 倒序：Job 表没有时间列，SQLite 的 rowid 就是插入顺序。
    只回 kind="image"，不掺 asset_candidates/asset_generate——后两者有自己的
    归属（某个资产），混进来会让"这是谁生成的"变得没法回答。
    """
    from sqlalchemy import text as _sql_text

    from ..db import Job
    limit = max(1, min(int(limit or 60), 200))
    with get_session() as session:
        rows = (session.query(Job)
                .filter(Job.kind == "image", Job.project_id == project_id)
                .order_by(_sql_text("rowid DESC")).limit(limit).all())
    items = []
    for j in rows:
        try:
            res = json.loads(j.result) if j.result else {}
        except json.JSONDecodeError:
            res = {}
        err = None
        if j.error:
            try:
                err = json.loads(j.error)
            except json.JSONDecodeError:
                err = {"reason": "channel", "message": j.error}
        items.append({
            "job_id": j.id, "status": j.status, "progress": j.progress,
            "created_at": j.created_at,
            # 提交者：管理员看别人的项目时，得知道这批图是谁出的
            "user_id": j.user_id,
            "urls": res.get("urls") or [], "prompt": res.get("prompt") or "",
            "model_id": res.get("model_id") or "", "size": res.get("size") or "",
            "n": res.get("n") or 0, "ref_used": res.get("ref_used") or [],
            "error": err,
        })
    return {"items": items, "truncated": len(items) >= limit}


@router.get("/projects/{project_id}/asset-picks")
def asset_picks(project_id: str, q: str = "", limit: int = 300) -> dict:
    """「出图页把图用到项目里」的落点清单（2026-10-22 用户需求）。

    ## 为什么需要它

    自由生图（`kind="image"`）的产物**不落任何资产表**，只活在 `job.result`
    里（见 `list_image_jobs` 的说明）。用户在那页生成了一张满意的角色图之后，
    项目里没有任何地方"用得上"它——只能下载到本机再手动上传。

    这个端点给**落点**：本项目现有的要素（角色/场景/道具）与造型阶段，前端
    让用户选一个，然后走各自既有的写入接口（`upsert-image` / `PATCH /stages`）。
    刻意不在这里写库：写入的语义在既有接口里已经定死了（造型要走区间校验、
    资产要落版本链），在这里再实现一遍必然分叉。

    ## 为什么不直接复用 `/projects/{id}/detail`

    那是 1.6MB 起步的整包（1424 镜 + 全部资产 + 版本号），而出图页只需要
    一份可选的名单。为了点开一个下拉去拉整包是不可接受的。

    ## 只回名单，不回图

    `has_image` 够前端标出"这些已经有图，选了就是覆盖"。不在响应里带 URL：
    这个端点的用途是选落点，不是看图；带上 URL 会让响应大一倍而没人用。

    `limit` 只截要素/造型各多少条，**不静默截断**：`truncated` 如实告诉前端
    还有没列出来的，免得用户搜不到自己那个要素却以为是丢了。
    """
    from ..db import AssetStage
    kw = (q or "").strip()
    lim = max(1, min(int(limit or 300), 1000))
    with get_session() as session:
        if not access.can_access_project(session, project_id):
            raise HTTPException(status_code=404, detail="project not found")
        aq = (session.query(Asset)
              .filter(Asset.project_id == project_id,
                      Asset.kind.in_(("character", "location", "prop")),
                      Asset.deleted_at.is_(None)))
        if kw:
            aq = aq.filter(Asset.name.ilike(f"%{kw}%"))
        assets = aq.order_by(Asset.kind, Asset.name).limit(lim + 1).all()
        sq = (session.query(AssetStage)
              .filter(AssetStage.project_id == project_id,
                      AssetStage.deleted_at.is_(None)))
        if kw:
            sq = sq.filter(AssetStage.character_name.ilike(f"%{kw}%"))
        stages = (sq.order_by(AssetStage.character_name, AssetStage.ep_from)
                  .limit(lim + 1).all())
    return {
        "assets": [{"id": a.id, "kind": a.kind, "name": a.name,
                    "has_image": bool(a.image_url)} for a in assets[:lim]],
        "stages": [{"id": s.id, "character_name": s.character_name,
                    "stage_name": s.stage_name,
                    "ep_from": s.ep_from, "ep_to": s.ep_to,
                    "shot_from": s.shot_from, "shot_to": s.shot_to,
                    "has_image": bool(s.image_url)} for s in stages[:lim]],
        "truncated": len(assets) > lim or len(stages) > lim,
    }


@router.get("/assets/candidates")
def latest_asset_candidates(project_id: str, kind: str, name: str,
                            stage_id: Optional[str] = None) -> dict:
    """该资产最近一次候选图生成 job 的快照（没有则 job_id=null）。

    弹窗打开时拉一次：在跑 → 显示"生成中"并轮询；已完成 → 直接把上次那几张
    候选摆出来接着挑。候选图**不落资产表**（只有点选那张才落），所以这里是
    关窗之后唯一能把它们找回来的入口——否则图已落盘、钱已花掉，UI 却看不见。

    按 rowid 倒序取最新（Job 表没有时间列；SQLite rowid 即插入顺序）。
    """
    from sqlalchemy import text as _sql_text

    from ..db import Job
    with get_session() as session:
        rows = (session.query(Job)
                .filter(Job.kind == "asset_candidates")
                .order_by(_sql_text("rowid DESC")).limit(200).all())
        for j in rows:
            try:
                p = json.loads(j.payload or "{}")
            except json.JSONDecodeError:
                continue
            if (p.get("project_id") != project_id or p.get("kind") != kind
                    or p.get("name") != name or (p.get("stage_id") or None) != (stage_id or None)):
                continue
            res = json.loads(j.result) if j.result else {}
            err = j.error
            if err:
                try:
                    err = json.loads(err).get("message") or err
                except json.JSONDecodeError:
                    pass
            return {"job_id": j.id, "status": j.status, "progress": j.progress,
                    "urls": res.get("urls") or [], "ref_used": res.get("ref_used"),
                    "prompt": res.get("prompt"), "error": err}
    return {"job_id": None, "status": None, "urls": []}


@router.get("/assets/generate-status")
def asset_generate_status(project_id: str, kind: str, name: str,
                          stage_id: Optional[str] = None) -> dict:
    """该资产/造型最近一次**单张生图**（kind=`asset_generate`）的快照。

    给"刷新页面后进度就丢"兜底：`asset_generate` 是 job，进度落在 Job 行里，
    但前端刷新后内存全清，不知道这个目标上是否还有任务在跑、跑到哪了。
    打开提示词弹窗时问一次这里，就能把"生成中…"和进度如实接回来——
    而不是像同步接口那样，一刷新就什么都不知道了。

    与 `/assets/candidates` 分开：那是**候选池**（不落库、供挑选），这里是
    **已写回资产的单张图**。两者若要合并，刷新后就会把候选池当成生成结果，
    用户会以为"图已经换好了"而实际上还没有。
    """
    from ..db import Job
    with get_session() as session:
        rows = (session.query(Job)
                .filter(Job.kind == "asset_generate", Job.project_id == project_id)
                .order_by(Job.created_at.desc()).limit(100).all())
        for j in rows:
            try:
                p = json.loads(j.payload or "{}")
            except json.JSONDecodeError:
                continue
            if (p.get("kind") != kind or p.get("name") != name
                    or (p.get("stage_id") or None) != (stage_id or None)):
                continue
            res = json.loads(j.result) if j.result else {}
            err = j.error
            if err:
                try:
                    err = json.loads(err).get("message") or err
                except json.JSONDecodeError:
                    pass
            return {"job_id": j.id, "status": j.status, "progress": j.progress,
                    "url": res.get("url") or (res.get("urls") or [None])[0],
                    "error": err, "created_at": j.created_at}
    return {"job_id": None, "status": None, "progress": 0}


# ---------- 资产 CRUD（自定义资产 + 拖拽重分类/换图）----------
#: 允许的资产种类。`prop`（道具）于 2026-10-08 加入 —— 此前**前端全面支持、后端全面拒绝**：
#: 要素页有道具 tab、`KIND_CN`/`KIND_LABEL` 都写着「道具」、一键补全的缺口清单里
#: 也列着 prop，但后端这个白名单不含它，于是「新建道具」必然 400、
#: 拆解建不出道具行、补全永远没有缺图道具可补。用户的反馈
#: 「拆分镜头时似乎没有识别和提取道具」根子就在这一行。
#:
#: dev 库实测：加之前 prop 资产 **0 条**，而 character 1469 / location 2760 ——
#: 差额不是"道具少"，是整条链路从来没通过。
_ASSET_KINDS = ("character", "location", "prop", "custom")


class AssetCreateIn(BaseModel):
    project_id: str
    kind: str = "custom"          # character | location | prop | custom
    name: str
    image_url: Optional[str] = None
    #: 用户改过的整段终稿。**导入资产库/别的项目时不要传它**——
    #: 终稿里含着来源项目的画风前缀、构图句与影调句，搬到另一个项目会打架。
    prompt: Optional[str] = None
    #: 描述（场景陈设 / 道具形制 / 角色外貌）。导入时搬的是它，见 db.Asset.desc_auto。
    desc_auto: Optional[str] = None


@router.post("/assets")
async def create_asset(body: AssetCreateIn) -> dict:
    """新建资产（资产页「自定义」分组：上传图 / AI 生图后落库）。"""
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="资产名不能为空")
    if body.kind not in _ASSET_KINDS:
        raise HTTPException(status_code=400, detail=f"kind 只能是 {'/'.join(_ASSET_KINDS)}")

    # 上传图无描述 → **保持为空**，不再同步反推（那是 ~8s 的多模态调用，
    # 会把"新建一个自定义资产"拖成十几秒）。描述为空是安全的：出片时走
    # jobs.py 的 blind 兜底，提示词禁止书写该图的服装/陈设，外观由图钳制。
    # 想要文字描述的用户在资产弹窗里点「AI 看图补写」即可。
    with get_session() as session:
        if not session.get(Project, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        dup = (session.query(Asset)
               .filter(Asset.project_id == body.project_id,
                       Asset.kind == body.kind, Asset.name == name).first())
        _new_ver: tuple | None = None
        if dup and dup.deleted_at:
            # 撞上墓碑行：用户手工新建同名资产 = 显式说"我又要它了"，
            # 按恢复处理并写入本次的图/描述。报 409 是最差的选择——
            # 那一行在资产页上不可见，用户会以为是幽灵冲突。
            dup.deleted_at = None
            if body.image_url:
                dup.image_url = body.image_url
            if body.prompt:
                dup.prompt = body.prompt
            if body.desc_auto:
                dup.desc_auto = body.desc_auto
            session.commit()
            out = {"id": dup.id, "kind": dup.kind, "name": dup.name,
                   "image_url": dup.image_url, "restored": True}
            if body.image_url:
                _new_ver = (body.project_id, dup.kind, dup.id, dup.name,
                            dup.image_url)
            else:
                return out
        elif dup:
            raise HTTPException(status_code=409, detail=f"已有同名{body.kind}资产「{name}」")
        else:
            aid = uuid.uuid4().hex[:12]
            session.add(Asset(id=aid, project_id=body.project_id, kind=body.kind,
                              name=name, image_url=body.image_url,
                              prompt=body.prompt or None,
                              desc_auto=body.desc_auto or None))
            session.commit()
            out = {"id": aid, "kind": body.kind, "name": name,
                   "image_url": body.image_url}
            if body.image_url:
                _new_ver = (body.project_id, body.kind, aid, name, body.image_url,
                            body.prompt)
    # 新建/恢复时带图 → 落版本 1，让版本链从第一次就有起点
    if _new_ver:
        from ..asset_versions import record as _rec
        _rec(project_id=_new_ver[0], kind=_new_ver[1], target_id=_new_ver[2],
             image_url=_new_ver[4], prompt=_new_ver[5] or None,
             source="upload", label=_new_ver[3])
    return out


class AssetPatchIn(BaseModel):
    #: 改 kind = 拖拽重分类（custom 拖上人物轨→character / 场景轨→location）
    kind: Optional[str] = None
    name: Optional[str] = None
    image_url: Optional[str] = None
    #: 角色参考音色（上传音频/视频 URL；空串=清除）
    voice_url: Optional[str] = None
    #: 造型/场景文字描述。出片时会作为参考图的文字锚点喂给提示词优化器，
    #: 用户在资产弹窗里改了必须存得下来（空串=清除）。
    prompt: Optional[str] = None
    #: 连同换图一起把旧描述清空（用户上传了自己的图时传 true）。见 _CLEAR_DESC_WHY。
    clear_prompt: Optional[bool] = None


@router.patch("/assets/{asset_id}")
async def patch_asset(asset_id: str, body: AssetPatchIn) -> dict:
    # 换图不再同步反推描述（见 patch_stage 顶部注释）：反推改为手动按钮。
    with get_session() as session:
        a = access.req_asset(session, asset_id)
        if body.kind is not None:
            if body.kind not in _ASSET_KINDS:
                raise HTTPException(status_code=400,
                                    detail=f"kind 只能是 {'/'.join(_ASSET_KINDS)}")
            a.kind = body.kind
        # 改名走**连带迁移**（R1）。Asset.name 是连接键（全库 12 处
        # `Asset.name == ...`），只改这一行会让引用它的镜头静默失联：
        # 把「陆明」改成「陆医生」→ 208 个镜头的 characters 仍是「陆明」
        # → 定妆图全部注入不到，且没有任何报错。
        # 所以在同一事务里把 Shot/AssetStage/别名表的引用一起改掉。
        renamed: dict[str, int] = {}
        if body.name is not None and body.name.strip():
            new_name = body.name.strip()
            if new_name != a.name:
                from ..asset_rename import rename_asset_everywhere
                renamed = rename_asset_everywhere(
                    session, a.project_id, a.kind, a.name, new_name)
                session.expire(a)      # 上面用的是 bulk update，实例缓存已过期
        if body.image_url is not None:
            a.image_url = body.image_url
        if body.voice_url is not None:
            a.voice_url = body.voice_url or None   # 空串=清除
        if body.prompt is not None:
            a.prompt = body.prompt or None
        elif body.clear_prompt:
            a.prompt = None       # 用户换成了自己的图（见 _CLEAR_DESC_WHY）
        session.commit()
        out = {"id": a.id, "kind": a.kind, "name": a.name,
               "image_url": a.image_url, "voice_url": a.voice_url,
               "prompt": a.prompt}
        if renamed:
            # 改名连带改了哪些表、各几行——让用户当场看到影响面
            # （"这次改名动了 208 个镜头 + 43 个造型阶段"），而不是改完毫无反馈
            out["renamed"] = renamed
        # 只在**真的换了图**时落版本。先取出快照，出了 session 再写——
        # record() 会开自己的会话，叠在还开着的会话里容易撞 SQLite 写锁。
        _ver = ((a.project_id, a.kind, a.id, a.name, a.image_url, a.prompt)
                if body.image_url is not None else None)
    if _ver:
        from ..asset_versions import record as _rec
        # 资产的 `prompt` 列**就是**可编辑的那份稿，所以 val 与输入同义。
        # 带上它，回退到这一版时提示词框才拿得到当时那份稿；不带的话这一版
        # 在界面上是"没有存稿"，用户切过去会看到上一版留下的文本。
        # ⚠️ 只改提示词**不换图**时不落版本（`image_url is None`）：版本列表按
        # **图**分版，同一张图挂十几条改稿记录只会让用户更分不清哪版是哪版。
        _rec(project_id=_ver[0], kind=_ver[1], target_id=_ver[2],
             image_url=_ver[4], prompt=_ver[5] or None,
             source="upload", label=_ver[3])
    return out


@router.get("/projects/{project_id}/asset-duplicates")
def asset_duplicates(project_id: str, kinds: str = "",
                     include_props_unused: bool = True) -> dict:
    """**一键查重**（2026-10-28 用户需求）：机械化候选清单。

    用户原话：「资产提取太细致了，不同的人物、场景称谓会分别识别为一个
    不同的资产，道具里也有很多不重要的道具被识别出来了」，同时明确
    **细致度要保留**（多识别比漏识别好），补一个查重入口。

    ## 这一层只做筛选，不做判断

    判据是**字面**的（同一名字、只差括号注释、场景只差场次前缀）。
    「老吴」/「吴先生」这类必须读剧情才能判断的，这里认不出来 ——
    那是 `needs_ai=true` 的组交给 agent 做的事（见 `asset_dedupe` 模块头）。

    ## 为什么是普通 GET 而不是开一轮 agent

    agent run 那条路有五处框架级限制会直接毁掉这个需求：写操作不受
    `cap_fen` 约束、只读工具白名单没接线、工具结果截断 8000 字符、
    审批只有整批一个布尔、`recursion_limit` 默认 25。详见
    `docs/PLAN-资产一键查重.md` 5.4。这里 179ms 出全量结果，全部绕开。

    ## 幂等

    纯读，不写库。合并过的资产变成墓碑，不在 `alive` 里，所以再查一次
    列表会自然变短 —— 这正好让"还剩几组"有个诚实的答案。
    """
    from .. import asset_dedupe
    want = [k.strip() for k in (kinds or "").split(",") if k.strip()] or None
    if want and any(k not in asset_dedupe.KINDS for k in want):
        raise HTTPException(
            status_code=400,
            detail=f"kinds 只能是 {list(asset_dedupe.KINDS)} 的组合")
    with get_session() as session:
        if not session.get(Project, project_id):
            raise HTTPException(status_code=404, detail="project not found")
        found = asset_dedupe.find_groups(session, project_id, want)
        unused = (asset_dedupe.prop_delete_candidates(session, project_id)
                  if include_props_unused and (not want or "prop" in want) else [])
    return {
        "ok": True,
        "groups": found["groups"],
        "unused_props": unused,
        "stats": {
            **found["stats"],
            "unused_props": len(unused),
        },
    }


@router.delete("/assets/{asset_id}")
def delete_asset(asset_id: str) -> dict:
    """删除资产（用户 2026-09-09 需求 4）。**写墓碑，不真删行。**

    用户的原话是「删掉的资产不该再在后面的生成过程中可见、被调用」。
    此前这里是 `session.delete(a)`，达不到这个要求——有**三处**自动流程会
    按名字把它原地建回来（拆解后的资产增量合并 / `ensure_location_asset` /
    资产 upsert），还有第四处更隐蔽：`readiness.locations_no_image` 是从
    `Shot.location` 算的、根本不看资产表，所以真删之后依然报"缺图"，
    用户点一次"补齐"就又花钱把它画回来了。

    墓碑（`Asset.deleted_at`）让这四处都能认出"这是用户故意删的"从而跳过。

    语义边界（用户决策「只断资产链，不动剧本」）：
      · 断掉：不再注入参考图、不计入缺图缺口、不被自动流程重建、资产页不显示
      · 不动：镜头里该角色/场景照旧存在，剧本一个字不改
      · 保留：已生成的图与磁盘文件全在，`POST /assets/{id}/restore` 可恢复
    """
    with get_session() as session:
        a = access.req_asset(session, asset_id)
        if a.deleted_at:
            # 幂等：重复删不报错（前端重试/双击都可能打两次）
            return {"ok": True, "already_deleted": True, "name": a.name,
                    "kind": a.kind, "deleted_at": a.deleted_at}
        a.deleted_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        name, kind, pid = a.name, a.kind, a.project_id
        deleted_at = a.deleted_at
        session.commit()
        # 影响面：让用户当场看到"这个场景还挂在 37 个镜头上，那些镜头不会被删，
        # 只是不再有它的参考图了"——比删完毫无反馈强得多。
        if kind == "location":
            from ..scenes import canonical_map
            shots = session.query(Shot).filter(Shot.project_id == pid).all()
            cmap = canonical_map(session, pid, shots=shots)
            affected = sum(
                1 for s in shots
                if (cmap.get((s.location or "").strip(), "")
                    or (s.location or "").strip()) == name)
        elif kind == "prop":
            # 道具挂在 Shot.props 上，不在 characters 里——原来一律数 characters，
            # 删道具时永远报"影响 0 镜"，用户会以为它没被任何镜头用到。
            affected = sum(
                1 for (props,) in session.query(Shot.props)
                .filter(Shot.project_id == pid).all()
                if name in (json.loads(props or "[]") or []))
        else:
            affected = sum(
                1 for (chars,) in session.query(Shot.characters)
                .filter(Shot.project_id == pid).all()
                if name in (json.loads(chars or "[]") or []))
    return {"ok": True, "name": name, "kind": kind, "deleted_at": deleted_at,
            #: 仍然挂着这个角色/场景的镜头数（**不会**被改动，只是不再注入它）
            "affected_shots": affected}


@router.post("/assets/{asset_id}/restore")
def restore_asset(asset_id: str) -> dict:
    """撤销删除：清掉墓碑，资产及其图原样回来。

    删除是软的，所以恢复是完整的——图、档案、场景多视角行全都还在，
    不需要重新生成任何东西。
    """
    with get_session() as session:
        a = access.req_asset(session, asset_id)
        a.deleted_at = None
        session.commit()
        return {"ok": True, "name": a.name, "kind": a.kind}


class AssetMergeIn(BaseModel):
    #: 要合并的资产 id（≥2）
    asset_ids: list[str]
    #: 留哪一行；缺省 = 按 `asset_merge.keep_rank` 自动选（预演里给用户看过）
    keep_id: Optional[str] = None
    #: 区间冲突的造型里，**用户选择丢弃**的那些（软删）。未裁决的冲突会被 409 拒绝。
    drop_stage_ids: Optional[list[str]] = None
    #: 「同一个人、不同造型/年龄段」：被并的写法按出场镜头落成留存角色的造型阶段，
    #: 而不是因为带年龄阶段被拦下（2026-10-28 用户裁定，见 asset_merge._age_stage_to_stage）。
    as_stages: bool = False


def _require_assets(session, asset_ids: list[str]) -> None:
    """逐行校验归属。

    ⚠️ 必须逐行、且在任何 400/409 判定**之前**（照 `merge_stages` 的做法）：
    access 中间件只从请求体里认 `project_id` 这个键，而本请求体只有
    `asset_ids` —— 中间件够不着。若先跑业务校验，"我的 + 别人的"混合 id
    会得到 400 而非 404，等于用报错差异告诉调用者"那几个 id 真实存在、
    只是不在你的项目里"。
    """
    for aid in asset_ids:
        access.req_asset(session, aid)      # 不存在/无权限 → 404「资产不存在」


def _merge_project(session, asset_ids: list[str]) -> str:
    """这批资产的共同 project_id（`asset_merge.plan` 会再校验同项目同 kind）。"""
    from ..db import Asset
    pids = {r for (r,) in session.query(Asset.project_id)
            .filter(Asset.id.in_(asset_ids)).all()}
    if len(pids) != 1:
        raise HTTPException(status_code=400, detail="只能合并同一个项目里的资产")
    return pids.pop()


@router.post("/assets/merge/preview")
def merge_preview(body: AssetMergeIn) -> dict:
    """**预演合并**：只算不写。给用户看清会留哪一行、会丢什么、哪里要他裁决。

    为什么必须有这一档：合并是**有损**的（被并的行打成墓碑、造型可能被软删），
    而"会留 A 还是留 B"由 `keep_rank` 机械判定。让用户在看不见结果的情况下点
    "合并"是不可接受的 —— 他没法知道留下的是不是带音色那一行。
    """
    from .. import asset_merge
    with get_session() as session:
        _require_assets(session, body.asset_ids)
        pid = _merge_project(session, body.asset_ids)
        return asset_merge.plan(session, pid, body.asset_ids, as_stages=body.as_stages)


@router.post("/assets/merge")
def merge_assets(body: AssetMergeIn) -> dict:
    """合并选中的资产（要素页「合并选中的资产」）。

    语义：留下 `keep_id`（缺省按 `keep_rank` 自动选），其余打成**墓碑**
    （软删、可恢复，不真删 —— 真删会被三处自动流程原地建回来，见 asset_gate）。
    角色：造型按 `character_name` 原地改名跟着过来（行 id 不变 →
    版本历史/指针链/火山缓存全保留）；区间重叠的造型**必须由用户裁决**，
    未裁决直接 409 拒绝，不允许静默留两套并存的造型。
    场景：重指 `SceneAlias` 到留存行（把"这是同一个地方"这个判断写下来）、
    并把被并场景的多视角图接到留存行缺的那些视角上。
    """
    from .. import asset_merge
    with get_session() as session:
        _require_assets(session, body.asset_ids)
        pid = _merge_project(session, body.asset_ids)
        try:
            out = asset_merge.apply_merge(
                session, pid, body.asset_ids,
                keep_id=body.keep_id, drop_stage_ids=body.drop_stage_ids,
                as_stages=body.as_stages)
        except ValueError as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
        session.commit()
        return out


# ---------------------------------------------------------------- 形象档案

@router.get("/assets/{asset_id}/profile")
def get_asset_profile(asset_id: str) -> dict:
    """角色形象档案 + 词表（前端据此渲染下拉）。

    词表随档案一起返回，前端不硬编码——词表是后端的事实来源
    （`character_profile.AXES`），两处各写一份必然漂移。
    """
    from .. import character_profile as cp

    with get_session() as session:
        a = access.req_asset(session, asset_id)
        if a.kind != "character":
            raise HTTPException(status_code=400, detail="只有角色资产有形象档案")
        prof = cp.decode(a.profile_json)
        name = a.name

    # 老档案可能存着 period/generic；一律夹到已上线的风格预设，
    # 免得下发给前端的下拉里出现关掉的古装词。
    genre = cp.active_genre((prof or {}).get("genre"))
    return {
        "name": name,
        "profile": prof,          # None = 还没生成过
        "genre": genre,
        "axes": [{"key": ax.key, "label": ax.label,
                  "values": ax.values or [], "optional": ax.optional}
                 for ax in cp.axes_for_genre(genre)],
        "extra_max": cp.EXTRA_MAX_LEN,
    }


class AssetProfileIn(BaseModel):
    #: {轴 key: 取值}。词表外的自定义值也接受（见 character_profile 模块开头）
    axes: dict[str, str] = {}
    #: 词表覆盖不到的独有特征（疤痕/义眼/胎记）
    extra: str = ""
    genre: Optional[str] = None


@router.put("/assets/{asset_id}/profile")
def put_asset_profile(asset_id: str, body: AssetProfileIn) -> dict:
    """手改形象档案。

    ⚠️ 改档案 = 改这个角色的脸。**已生成的定妆图不会自动重画**——
    要让新档案生效，得删掉该角色的定妆图再补齐资产（前端会给这句提示）。
    手改的档案标 `confirmed`，此后自动流程不再覆盖。
    """
    from .. import character_profile as cp

    with get_session() as session:
        a = access.req_asset(session, asset_id)
        if a.kind != "character":
            raise HTTPException(status_code=400, detail="只有角色资产有形象档案")
        project_id, name = a.project_id, a.name

    ok = cp.save_profile(project_id, name, {
        "axes": body.axes, "extra": body.extra,
        "genre": cp.active_genre(body.genre)})
    if not ok:
        raise HTTPException(status_code=404, detail="asset not found")
    return {"ok": True, "profile": cp.load_profiles(project_id).get(name)}


@router.get("/projects/{project_id}/profiles/status")
def profiles_status(project_id: str) -> dict:
    """本项目角色形象档案的覆盖情况 + 最近一次生成的结果（2026-10-17）。

    「要素」页据此显示"缺谁、上次为什么没生成"，并决定是否露出
    「补生成缺失档案」按钮（提交 `profile_fill` job）。

    ## 缺谁：从**现有数据**现算，不读历史

    缺档案 = 活着的角色资产里 `profile_json` 为空的那些。用户删掉角色、
    补跑成功、上传新角色都会立刻反映出来；只看最近一次 job 的 `missing`
    会过时（例如之后又拆出了新角色）。

    ## 上次为什么没生成：读最近一次**写过档案报告**的 job

    拆解（`breakdown_all` 的 `result.profiles`）与补跑（`profile_fill`）两种来源，
    取最新的一条。按 rowid 倒序 —— Job 表的插入顺序。
    """
    from sqlalchemy import text as _sql_text

    from .. import asset_gate
    from ..db import Job
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise HTTPException(404, "project not found")
        rows = asset_gate.alive(
            session.query(Asset).filter(Asset.project_id == project_id,
                                        Asset.kind == "character")).all()
        names = sorted({a.name for a in rows})
        have = {a.name for a in rows if (a.profile_json or "").strip()}
        jobs = (session.query(Job)
                .filter(Job.project_id == project_id,
                        Job.kind.in_(("breakdown_all", "profile_fill")))
                .order_by(_sql_text("rowid DESC")).limit(20).all())
        last = None
        for j in jobs:
            if j.kind == "profile_fill" and j.status in ("pending", "running"):
                last = {"job_id": j.id, "kind": j.kind, "status": j.status,
                        "at": j.updated_at or j.created_at, "error": None,
                        "generated": 0}
                break
            try:
                rep = (json.loads(j.result) if j.result else {}).get("profiles")
            except (json.JSONDecodeError, AttributeError):
                rep = None
            if j.kind == "profile_fill" and j.status == "failed" and not rep:
                rep = {"error": j.error, "generated": 0}
            if rep:
                last = {"job_id": j.id, "kind": j.kind, "status": j.status,
                        "at": j.updated_at or j.created_at,
                        "error": rep.get("error"),
                        "generated": int(rep.get("generated") or 0)}
                break
    missing = [n for n in names if n not in have]
    return {"total": len(names), "have": len(names) - len(missing),
            "missing": missing, "last": last}


@router.post("/assets/{asset_id}/profile/regenerate")
async def regenerate_asset_profile(asset_id: str) -> dict:
    """按剧本重新识别该角色的形象档案（清空旧档案后重跑）。

    重新识别几乎必然给出不同的五官——档案是审美判断，不是事实提取。
    所以这**只能**由用户显式触发，自动流程永不重生成（见 `ensure_profiles`）。
    """
    from .. import character_profile as cp

    with get_session() as session:
        a = access.req_asset(session, asset_id)
        if a.kind != "character":
            raise HTTPException(status_code=400, detail="只有角色资产有形象档案")
        project_id, name = a.project_id, a.name
        a.profile_json = None      # 清空才会被 ensure_profiles 当作"缺档案"
        session.commit()

    got = await cp.ensure_profiles(project_id, [name])
    prof = got.get(name)
    if not prof:
        raise HTTPException(status_code=502, detail="形象档案识别失败，请重试")
    return {"ok": True, "profile": prof}


class AssetImageUpsertIn(BaseModel):
    project_id: str
    kind: str
    name: str
    image_url: Optional[str] = None
    #: 角色参考音色（上传音频/视频 URL；与 image_url 至少传一个）
    voice_url: Optional[str] = None
    #: 用户手写的造型/场景描述（资产弹窗里改提示词时传）。空串 = 清空。
    prompt: Optional[str] = None
    #: 连同换图一起把旧描述清空（用户上传了自己的图时传 true）。见 _CLEAR_DESC_WHY。
    clear_prompt: Optional[bool] = None


@router.post("/assets/upsert-image")
async def upsert_asset_image(body: AssetImageUpsertIn) -> dict:
    """按 (kind, name) 换图/换音色（拖资产卡到场景轨段=替换参考图；
    资产详情弹窗上传音色）。无 Asset 行则建（upsert 兜底）。
    """
    if body.kind not in _ASSET_KINDS:
        raise HTTPException(status_code=400, detail=f"kind 只能是 {'/'.join(_ASSET_KINDS)}")
    if body.image_url is None and body.voice_url is None and body.prompt is None:
        raise HTTPException(status_code=422, detail="image_url/voice_url/prompt 至少传一个")

    # 换图不再同步反推描述（见 patch_stage 顶部注释）：反推改为手动按钮。
    with get_session() as session:
        if not session.get(Project, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        a = (session.query(Asset)
             .filter(Asset.project_id == body.project_id,
                     Asset.kind == body.kind, Asset.name == body.name).first())
        if a is None:
            a = Asset(id=uuid.uuid4().hex[:12], project_id=body.project_id,
                      kind=body.kind, name=body.name)
            session.add(a)
        elif a.deleted_at:
            # 本路由只有前端用户操作会调（拖资产卡换图 / 上传音色），
            # 往墓碑行上静默写图 = 用户看不到任何变化。按恢复处理。
            a.deleted_at = None
        if body.image_url is not None:
            a.image_url = body.image_url
        if body.voice_url is not None:
            a.voice_url = body.voice_url or None
        if body.prompt is not None:
            a.prompt = body.prompt or None
        elif body.clear_prompt:
            a.prompt = None       # 用户换成了自己的图（见 _CLEAR_DESC_WHY）
        session.commit()
        out = {"id": a.id, "kind": a.kind, "name": a.name,
               "image_url": a.image_url, "voice_url": a.voice_url,
               "prompt": a.prompt}
        # 出了 session 再落版本（record 开自己的会话，别和外层写事务叠着）
        _ver = ((a.project_id, a.kind, a.id, a.name, a.image_url, a.prompt)
                if body.image_url is not None else None)
    if _ver:
        from ..asset_versions import record as _rec
        # source 用 upload：这条路由还兼着"前端拿到生成结果后写回"的用途
        # （生成接口只返回 URL、不落库），所以不写 ai——写 ai 会让用户以为
        # 它一定是模型直出，而实际上可能是他从本机传的。
        _rec(project_id=_ver[0], kind=_ver[1], target_id=_ver[2],
             image_url=_ver[4], prompt=_ver[5] or None,
             source="upload", label=_ver[3])
    return out


class DescribeImageIn(BaseModel):
    image_url: str
    #: character | location（决定用造型记录员还是置景记录员的题面）
    kind: str = "character"


@router.post("/assets/describe-image")
async def describe_image(body: DescribeImageIn) -> dict:
    """看图写一段造型/场景描述（资产弹窗「🔍 AI 看图补写」按钮）。

    **不落库**：结果回给前端填进输入框，由用户过目/修改后失焦才存。
    这是 2026-09-10 起视觉反推的唯一入口——它以前挂在换图链路上自动跑，
    把上传拖成几十秒且期间整页锁死，见 `patch_stage` 顶部注释。

    正因为经用户过目，写回去的就是用户的字，**不再加** `AUTO_PREFIX`。
    该前缀只保留读路径（`strip_auto`）以兼容历史数据。
    """
    from .. import vision_desc

    url = (body.image_url or "").strip()
    if not url:
        raise HTTPException(status_code=422, detail="image_url 不能为空")
    kind = body.kind if body.kind in ("location", "prop") else "character"
    text = await vision_desc.derive(url, kind=kind)
    if not text:
        # derive 内部把所有异常都吞成 None（反推是锦上添花，不该让用户传不上图）。
        # 但**手动点按钮**是显式请求，静默返回空等于按钮坏了，这里必须报出来。
        raise HTTPException(status_code=502, detail="看图失败，请稍后重试或自己写一句")
    return {"description": vision_desc.strip_auto(text)}


# ---------------- 按文件名批量导入图片（2026-10-19 用户需求） ----------------
#
# 用户原话：「项目内支持批量上传图片并根据图片文件名分析并导入资产
# （例如图片名和资产名同时为「男3」时，就把图片导入对应资产）」。
#
# 一次选一整个文件夹的定妆图，文件名就是资产名 —— 这是批量做项目时最常见的
# 动作，而在此之前只能一张张点、点到对的那一行。手工点错行是**静默**的：
# 图传上去了、界面也变了，只是那个角色永远不会用到它。
#
# ## 三条硬规则
#
# 1. **不做模糊匹配**。文件名去掉扩展名后必须与资产名**归一后相等**
#    （忽略大小写、首尾空白、全半角空白）。"男 3" 能对上 "男3"，
#    "男三" 不能 —— 猜错等于把 A 的脸安到 B 身上，那是不可逆的错误。
# 2. **不做静默跳过**。每个文件都必须在结果里出现一次，且标明落了哪里、
#    或者为什么没落（没这个资产 / 重名 / 已删除 / 重复）。
# 3. **不新建资产**。文件名对不上任何资产时只报告，让用户自己决定是不是要新建
#    （悄悄建一批「IMG_2043」资产只会把要素页塞满垃圾）。

class FilenameImportIn(BaseModel):
    project_id: str
    #: [{filename: "男3.png", url: "/fw/media/uploads/xxx.png"}, …]
    #: URL 由前端先走 `/v2/media/upload` 拿到 —— 批量上传不适合塞进一个
    #: multipart 请求：任意一张失败就要整体重传，而用户往往一次拖几十张。
    items: list[dict] = Field(default_factory=list)
    #: 1 = 只认「文件名 = 资产名」；2 = 额外给出模糊候选（**只给候选，不写**）
    level: int = 2
    #: 用户在界面上逐张确认过的：{"男主礼服.png": "<asset_id>"}。
    #: 第二轮请求带上它，那张才会真正写入（见 asset_image_write.import_by_filename）。
    decided: dict[str, str] = Field(default_factory=dict)


#: 文件名与资产名的归一：去扩展名 → 全角空格转半角 → 去首尾空白 → 忽略大小写。
#: **不**去掉名字内部的空格/标点：那会让「男 3」与「男-3」也撞上，
#: 而这两个在剧本里是两个不同的称呼。
def _name_key(raw: str) -> str:
    base = (raw or "").strip()
    # 只剥**已知图片扩展名**，而不是 `.` 之后的一切：
    # 资产名本身可能带点（「V2.0 造型」不该被截成「V2」）。
    import os as _os
    stem, ext = _os.path.splitext(base)
    if ext.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
        stem = base
    return (stem.replace("　", " ").strip()).casefold()


@router.post("/assets/import-by-filename")
async def import_by_filename(body: FilenameImportIn) -> dict:
    """把一批图片按**文件名 = 资产名**写进本项目对应的资产 / 造型。

    返回逐条的处置结果，前端必须原样展示（尤其 `unmatched`）：
    批量操作最坏的形态是"看着成功了，其实一张都没对上"。

    落点选择（与资产页「上传图片」按钮同一套分流，别各写一份）：
      · 角色且**只有一套**造型 → 写进那套造型（出片注入读的就是它）
      · 角色且**有多套** → 写进 `Asset.image_url`（基础图），并在结果里
        注明"这个角色有 N 套造型，造型仍用各自的图"——不替用户猜是哪一套
      · 角色无造型 / 非角色 → 写进 `Asset.image_url`
      · 资产已删除（墓碑）→ 不复活，记为 `deleted`
    """
    from ..asset_image_write import ImageWriteError, import_by_filename as _import

    pid = (body.project_id or "").strip()
    if not pid:
        raise HTTPException(status_code=422, detail="缺少 project_id")
    if not body.items:
        raise HTTPException(status_code=422, detail="没有要导入的图片")
    if len(body.items) > 500:
        raise HTTPException(status_code=400, detail="一次最多导入 500 张")
    with get_session() as session:
        if not access.can_access_project(session, pid):
            raise HTTPException(status_code=404, detail="project not found")
    # 落点、版本记录、判名口径都在 asset_image_write（Agent 导入共用同一份）
    try:
        return _import(pid, body.items, level=body.level, decided=body.decided)
    except ImageWriteError as e:
        raise HTTPException(status_code=400, detail=str(e)) from None


# ---------------------------------------------------------------- 一键下载资产
#
# 为什么不是服务端打 ZIP：一次导出 P90 263 MB、最大 1.1 GB（连场景多视角 5 GB）。
# 服务端打包要「从桶拉回 → 落盘 → 再发给用户」，出网翻倍、占内存、还超 nginx
# 的 300 秒读超时。而地址本身永久可解析，所以只下发**清单**，让用户本机的
# 脚本直接对着对象存储下载 —— 服务器一次字节都不经手。
# 详见 `app/asset_export.py` 模块头。

class AssetExportIn(BaseModel):
    #: 导出范围。`base` = 当前图 + 造型；`views` = 场景多视角（体积大头）；
    #: `voice` = 角色参考音色。后两项必须用户显式勾，默认只导 base。
    scopes: list[str] = Field(default_factory=lambda: ["base"])
    #: True = 产出自包含 .bat（双击即用）；False = 产 zip。
    single_file: bool = True


@router.get("/projects/{project_id}/asset-export/preview")
@access.requires(access.ROLE_VIEWER)
def asset_export_preview(project_id: str, scopes: str = "base") -> dict:
    """导出前的预览：多少个文件、多大、哪几项缺图。**不产包、不落盘。**

    必须让用户先看到体积再点下载：5 GB 的包跑 40 分钟才断，比不让点更糟。
    """
    from ..asset_export import build_manifest

    want = [x.strip() for x in (scopes or "base").split(",") if x.strip()]
    with get_session() as session:
        if not access.can_access_project(session, project_id):
            raise HTTPException(status_code=404, detail="project not found")
    try:
        man = build_manifest(project_id, want)
    except (ValueError, LookupError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    return {
        "folder": man["folder"],
        "count": len(man["items"]),
        "total_bytes": man["total_bytes"],
        "max_bytes": man["max_bytes"],
        "too_big": man["too_big"],
        "missing": man["missing"],
        "scopes": man["scopes"],
    }


@router.post("/projects/{project_id}/asset-export")
@access.requires(access.ROLE_VIEWER)
def asset_export(project_id: str, body: AssetExportIn) -> dict:
    """产出「清单 + 下载脚本」的交付物，返回下载地址。

    交付物里**没有图**（图在你自己的机器上下），只有几十 KB 的清单与脚本。
    所以这几十 KB 的包按 `EXPORT_TTL_SEC` 过期即删，随时可以零成本重出。
    """
    from ..asset_export import build_manifest, emit_pack

    with get_session() as session:
        if not access.can_access_project(session, project_id):
            raise HTTPException(status_code=404, detail="project not found")
    try:
        man = build_manifest(project_id, body.scopes)
    except (ValueError, LookupError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from None
    if not man["items"]:
        raise HTTPException(status_code=400,
                            detail="这个项目还没有可导出的资产图（先在资产页补齐）")
    if man["too_big"]:
        raise HTTPException(
            status_code=413,
            detail=f"这次要导 {man['total_bytes'] / 1048576:.0f} MB，超过 "
                   f"{man['max_bytes'] / 1048576:.0f} MB 上限。"
                   "请少勾几项（场景多视角通常占九成体积），或改用桌面端导出。")
    return emit_pack(man, single_file=body.single_file)
