"""造型阶段（定妆/服装）与场景归一：剧本侧的"角色-造型-场景"三张台账。

`GET   /v2/projects/{pid}/stages`  `PATCH/DELETE /v2/stages/{id}`
`POST  /v2/stages/{id}/restore` / `stages/merge` / `stages/confirm-all`
`POST  /v2/stages/draft` / `stages/{id}/candidates`
`GET   /v2/projects/{pid}/readiness` / `costume-report`
场景：`GET /projects/{pid}/scenes` 及其 alias / canonicalize / preview /
apply-groups / describe；角色别名同构（`/characters/alias*`）。

## 为什么从 routes_v2.py 搬出来

它是原文件里**最大的一块**（约 1100 行、24 条路由）。行数预算「只许减」
（见 `routers/__init__.py`）。

## 搬迁时的两条边界判断（都不是随手）

- `costume_report` 住在 stage 块**内部**（L1285–1389），但它的实现**不依赖**
  任何 stage 工具（实测依赖为空）。它逻辑上属服装域，只是物理位置夹在这里。
  本批按"物理连续"整块搬，不是按域名硬拆——硬拆会在同一段代码里来回跳。
- `stages_draft` / `run_stages_draft` / `stage_candidates` 与 stage 块之间隔着
  服装识别（1720 行），但**必须与 stage 块同批搬**：它们引用了块内的
  `StageDraftIn` / `_clip_ep_ranges` / `_is_placeholder_stage`，分批搬会断。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
import json
import logging
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import access   # 多用户隔离：归属校验（2026-10-09）
from ..db import Asset, AssetStage, Project, Shot, get_session, profile_of
from ..providers.image import ImageProvider
from ..scene_desc import ensure_scene_descriptions
from .. import asset_gate
from .. import costumes
from .. import scene_board
from .. import stage_gate
from .. import scenes as scenes_mod

router = APIRouter(prefix="/v2", tags=["stage"])
logger = logging.getLogger(__name__)


# ---------- R1：人物资产阶段（集×镜头双层轴，契约 C5）----------
class StageOut(BaseModel):
    id: str
    character_name: str
    stage_name: str
    ep_from: Optional[int] = None
    ep_to: Optional[int] = None
    shot_from: Optional[int] = None
    shot_to: Optional[int] = None
    image_url: Optional[str] = None
    description: Optional[str] = None
    status: str
    #: 服装继承（"同一场景下同一人物服装相同"）：
    #: location = 本造型绑定的**归一场景名**；scene_bound = 是否场景决定型（可跨集沿用）。
    #: 两者都在资产页可改——AI 的 scene_bound 判定难免有争议，最终解释权归用户。
    location: Optional[str] = None
    scene_bound: bool = False
    #: 指针行：与该 id 的阶段是同一件衣服、共用它那张图（自己不出图）。
    source_stage_id: Optional[str] = None
    #: 指针行解析后的实际可用图（source 的 image_url）。前端据此显示缩略图，
    #: 不必自己再去追指针。
    effective_image_url: Optional[str] = None
    #: 本阶段区间内该角色**最终注入**的镜头 order 列表（P1-2 起 = (拆解真值 ∪ 人工add) − 人工remove，
    #: 与 jobs.py::_auto_inject_refs 完全同源 db.effective_characters）。
    #: 轨道按此渲染，避免"没出场却显示覆盖"的误导。
    present_orders: list[int] = []
    #: P1-2 人工覆写标记：本阶段区间内被人工「加入」注入的镜头 order（present_orders 子集，
    #: 轨道画斜纹/描边）与被人工「排除」的镜头 order（形成的空洞是手调的，tooltip/重置用）。
    manual_add_orders: list[int] = []
    manual_remove_orders: list[int] = []
    #: ⚠️ 已废弃（2026-10-22）：这里曾经是「虚拟段」标记，服务端把一个**没有库行**
    #: 的假造型（id `__nostage__<角色名>`）混进 `stages` 数组里，用来兑现
    #: 「轨道显示 = 实际注入」。桌面端的轨道是它唯一的真实用途，而轨道随桌面端
    #: 一起废弃了；网页端没有轨道，虚拟段就只剩副作用：它长得像造型但不是造型，
    #: PATCH / merge / 生成定妆全都 404，用户点一次失败一次。
    #:
    #: 现在改为 `GET /stages` 响应里的 `no_stage` 数组（见 `list_stages`），
    #: 语义不变、仍回答"哪些镜头只能用角色的通用定妆图"，但它**不再冒充造型**：
    #: 不进 `stages`、没有 id、任何写接口都碰不到它。
    #: 字段保留只为兼容旧版客户端读到的 `virtual=false`，服务端永不再置 true。
    virtual: bool = False
    #: ---- 生效范围诊断（2026-10-19 用户需求「造型阶段似乎没有生效」）----
    #: 本阶段在项目里**真的赢下**的镜头 order 列表（按 stage_pick 的唯一判据算）。
    #: 与 `present_orders` 的区别：后者是"角色在这几镜出场"，这里回答的是
    #: "这几镜**用的是这套衣服**"。用户反馈"无论怎么设都是第一套生效"，
    #: 靠这个字段一眼就能看出区间到底命中了几镜。
    hit_orders: list[int] = []
    #: 没生效时的人类可读原因（空串 = 正常）。取值见 `_stage_diagnosis`。
    diagnosis: str = ""
    #: 诊断分类：ok | no_image | no_shot_match | ep_mismatch | outranked | not_present
    diagnosis_kind: str = ""
def _stage_out(s: "AssetStage", present_orders: list[int] | None = None,
               manual_add: list[int] | None = None,
               manual_remove: list[int] | None = None,
               session=None, diag: dict | None = None) -> StageOut:
    from ..costumes import resolve_stage_image
    eff = s.image_url
    if not eff and s.source_stage_id and session is not None:
        eff = resolve_stage_image(session, s)
    d = diag or {}
    return StageOut(
        id=s.id, character_name=s.character_name, stage_name=s.stage_name,
        ep_from=s.ep_from, ep_to=s.ep_to, shot_from=s.shot_from, shot_to=s.shot_to,
        image_url=s.image_url, description=s.description, status=s.status,
        location=s.location, scene_bound=bool(s.scene_bound),
        source_stage_id=s.source_stage_id, effective_image_url=eff,
        present_orders=present_orders or [],
        manual_add_orders=manual_add or [],
        manual_remove_orders=manual_remove or [],
        hit_orders=d.get("hit_orders", []),
        diagnosis=d.get("diagnosis", ""),
        diagnosis_kind=d.get("diagnosis_kind", ""),
    )


def _present_orders_map(session, project_id: str) -> tuple[
        dict[str, list[int]], dict[str, list[int]], dict[str, list[int]]]:
    """角色名 → (最终注入 orders, 人工加入 orders, 人工排除 orders)，均按 order 升序。

    最终注入走 db.effective_characters（与 jobs.py::_auto_inject_refs 同源），
    人工增删来自 Shot.ref_overrides（L3），供轨道标记「这段是我手调的」。
    """
    from ..db import effective_characters
    rows = (session.query(Shot)
            .filter(Shot.project_id == project_id)
            .order_by(Shot.order).all())
    present: dict[str, list[int]] = {}
    added: dict[str, list[int]] = {}
    removed: dict[str, list[int]] = {}
    for sh in rows:
        try:
            l1 = {c for c in json.loads(sh.characters or "[]")
                  if isinstance(c, str) and c}
        except json.JSONDecodeError:
            l1 = set()
        for c in effective_characters(sh):
            present.setdefault(c, []).append(sh.order)
            if c not in l1:  # 注入了但拆解真值没有 → 人工加的
                added.setdefault(c, []).append(sh.order)
        try:
            ov = json.loads(sh.ref_overrides) if sh.ref_overrides else {}
        except json.JSONDecodeError:
            ov = {}
        for c in ov.get("remove", []):
            if isinstance(c, str) and c in l1:  # 真值有但被人工排除
                removed.setdefault(c, []).append(sh.order)
    return present, added, removed


def _stage_shot_conflict(a: AssetStage, b: AssetStage) -> bool:
    """两阶段在镜号维度上是否冲突。任一方没有镜号限制 → 视为覆盖全区间。

    绑了场景的阶段（`location` 非空）也算变体：它只在"人物身处该场景"时
    生效，天然是叠在基础造型之上的局部覆写，与基础阶段共存是设计意图。
    没有这条例外，"睡衣@卧室"这类场景决定型服装会被判成与基础阶段冲突，
    用户在资产页连保存都保存不了。

    模块级函数（原先长在 `patch_stage` 里）：`restore_stage` 要用同一套判据——
    恢复一个阶段和改一个阶段的区间，在"会不会撞上兄弟阶段"这件事上是同一个问题，
    各写一份必然漂移（一边允许场景变体共存、另一边不允许）。
    """
    def _is_base(x: AssetStage) -> bool:
        return (x.shot_from is None and x.shot_to is None
                and not (x.location or "").strip())
    if _is_base(a) or _is_base(b):
        # 至少一方是基础阶段：基础 vs 基础 = 冲突；基础 vs 变体 = 允许分层
        return _is_base(a) and _is_base(b)
    if (a.shot_from is None and a.shot_to is None) or \
       (b.shot_from is None and b.shot_to is None):
        # 场景绑定但不限镜号的两条：只有绑同一个场景才算冲突
        #（同一角色在同一场景不能有两套并存的造型，那样无法裁决）
        return ((a.location or "").strip() == (b.location or "").strip())
    a_lo = a.shot_from if a.shot_from is not None else -(10 ** 9)
    a_hi = a.shot_to if a.shot_to is not None else 10 ** 9
    b_lo = b.shot_from if b.shot_from is not None else -(10 ** 9)
    b_hi = b.shot_to if b.shot_to is not None else 10 ** 9
    return a_lo <= b_hi and b_lo <= a_hi


def _stage_range_label(st: AssetStage) -> str:
    """「第1-5集 #17-19镜」——冲突提示里指认是哪一条。

    无集数造型（ep_from/ep_to 均为 None，2026-11-04 起可建）= 仅供手动引用，
    不能渲染成「第None-None集」，否则用户看到的是一句读不懂的话。
    """
    if st.ep_from is None or st.ep_to is None:
        return "手动引用（不限集）"
    return (f"第{st.ep_from}-{st.ep_to}集"
            + (f" #{st.shot_from}-{st.shot_to}镜"
               if (st.shot_from is not None or st.shot_to is not None) else ""))


def _conflicting_sibling(session, st: AssetStage) -> AssetStage | None:
    """同角色的**在用**阶段里，第一个与 st 区间冲突的。没有则 None。

    墓碑不参与（见 `stage_gate`：删掉的阶段不该继续占着集区间）。
    """
    siblings = stage_gate.alive(
        session.query(AssetStage)
        .filter(AssetStage.project_id == st.project_id,
                AssetStage.character_name == st.character_name,
                AssetStage.id != st.id)).all()
    # 无集数造型（仅供手动引用）不占任何集区间，既不与别人冲突、也不会被别人抢。
    # 两侧任一侧无集数就直接跳过这一对——否则 None 参与比较会抛 TypeError。
    if st.ep_from is None or st.ep_to is None:
        return None
    for sib in siblings:
        if sib.ep_from is None or sib.ep_to is None:
            continue
        if st.ep_from <= sib.ep_to and sib.ep_from <= st.ep_to \
                and _stage_shot_conflict(st, sib):
            return sib
    return None


def make_room_for_shot(session, covering: AssetStage, order: int) -> list[AssetStage]:
    """把 `covering` 的镜号区间在 `order` 这一镜上**让开**，返回新拆出来的段。

    供「在镜头里手动换图」使用（`shots.switch_shot_ref_image`）：用户明确要求
    "就这一镜换张图"，而这一镜已经被另一套造型覆盖。此前那里直接 409，让用户
    自己去造型面板把区间改成不含这一镜——那等于把一个"改这一镜"的动作，变成
    "手工改 15 个镜头的覆盖关系"，而且改错了没有提示。

    ## 拆法：最多拆成两段，都是**指针行**

    原造型覆盖 73..76、用户要给 74 换图 → 拆成 73..73 与 75..76。
    两段都用 `source_stage_id` 指回原造型，因此：
      · 图是同一张（不复制、不重新生图、不会长出两张不一样的脸）
      · 用户之后在原造型上「改图」，拆出来的两段跟着变（都指同一个源）
      · 造型面板上能看出这是"同一件衣服的另一段"，而不是凭空多出两套造型

    若 `covering` 本身是指针行，拆出来的段指它的**源**而不是它自己——
    指针套指针会让 `costumes.resolve_stage_image` 多走一跳，且删除源时断链更难查。

    ## 边界（都按"不制造更糟的状态"处理）

    | 情形 | 处理 |
    |---|---|
    | 让开首镜（73）→ 只剩 74..76 | 只拆出后一段，前段为空**不建行** |
    | 让开尾镜（76）→ 只剩 73..75 | 只拆出前一段 |
    | 区间只有这一镜 | 不拆，返回 `[]`（调用方自己会就地换图） |
    | 开区间（shot_from/shot_to 有一端为 None） | **不拆**，抛 409 —— 拆开等于替用户把一个"不限"变成具体范围，副作用比 409 大 |

    调用方负责 commit；本函数只改内存对象。
    """
    lo = covering.shot_from
    hi = covering.shot_to
    if lo is None or hi is None:
        raise HTTPException(status_code=409, detail=(
            f"造型「{covering.stage_name}」的镜号范围是开区间"
            f"（{_stage_range_label(covering)}），无法在 #{order} 处自动让开。"
            "请先到「要素 · 造型阶段」给它填上具体的镜号范围。"))
    if not (lo <= order <= hi):
        return []                      # 本来就不覆盖这一镜，无需让
    if lo == hi:
        return []                      # 只有这一镜：调用方就地换图即可

    src_id = covering.source_stage_id or covering.id
    segs: list[tuple[int, int]] = []
    if lo <= order - 1:
        segs.append((lo, order - 1))
    if order + 1 <= hi:
        segs.append((order + 1, hi))

    # 段要落在本镜所在的集里：原造型的集区间可能跨多集，而镜号是**全剧连续**的。
    # 实例化时按镜号反查每段首尾镜所在的集，避免造出"集区间与镜号对不上"的行
    # ——那种行正是 `_check_stage_ranges` 现在会 400 的东西。
    ep_of: dict[int, int] = {
        o: e for (o, e) in
        session.query(Shot.order, Shot.episode)
        .filter(Shot.project_id == covering.project_id).all()}

    made: list[AssetStage] = []
    for a, b in segs:
        eps = [ep_of[o] for o in (a, b) if o in ep_of]
        ep_a = min(eps) if eps else covering.ep_from
        ep_b = max(eps) if eps else covering.ep_to
        seg = AssetStage(
            id=uuid.uuid4().hex[:12], project_id=covering.project_id,
            character_name=covering.character_name,
            # 名字带上原来的，用户才认得出这是"同一套衣服的另一段"；
            # 编号是镜号，改范围后可能不准，所以不写进名字（会误导）。
            stage_name=f"{covering.stage_name}（续）",
            ep_from=max(covering.ep_from, ep_a),
            ep_to=min(covering.ep_to, ep_b),
            shot_from=a, shot_to=b,
            # 指针行：图与描述都从源取，自己不持有
            image_url=None, source_stage_id=src_id,
            description=None,
            location=covering.location,
            scene_bound=covering.scene_bound,
            status=covering.status)
        session.add(seg)
        made.append(seg)
    return made



def _check_stage_ranges(session, st: AssetStage) -> None:
    """造型阶段的区间合法性。**patch 与 create 共用**——两处各写一份必然漂移。

    集数区间可选（ep_from/ep_to 均为 None）：表示"仅供手动引用"，不参与自动注入。
    只要有一端给了值，就视为有区间，完整校验。
    """
    # 无集数造型：直接跳过所有集数校验
    if st.ep_from is None and st.ep_to is None:
        # 镜号区间在没有集数的情况下没有意义，一并忽略
        return
    # 有一端没有另一端：不合法
    if st.ep_from is None or st.ep_to is None:
        raise HTTPException(status_code=400, detail="ep_from 和 ep_to 必须同时填写或同时留空")
    if st.ep_to < st.ep_from:
        raise HTTPException(status_code=400, detail="ep_to 不能小于 ep_from")
    if st.ep_from < 1:
        raise HTTPException(status_code=400, detail="ep_from 不能小于 1")
    if (st.shot_from is not None and st.shot_to is not None
            and st.shot_to < st.shot_from):
        raise HTTPException(status_code=400, detail="结束镜号不能小于起始镜号")
    # 区间越界校验：不能超过项目实际集数
    proj = session.get(Project, st.project_id)
    episodes = json.loads(proj.episodes) if proj and proj.episodes else []
    max_ep = max(
        [len(episodes)]
        + [sh.episode for sh in session.query(Shot)
           .filter(Shot.project_id == st.project_id).all()],
        default=1,
    ) or 1
    if st.ep_to > max_ep:
        raise HTTPException(status_code=400,
                            detail=f"ep_to 超出全剧集数（共 {max_ep} 集）")

    # ---- 镜号区间必须落在自己声明的集内（2026-10-22）----
    #
    # `shot_from/shot_to` 存的是**全剧连续**的 Shot.order，而 ep_from/ep_to 说的是
    # "这套造型属于第几集"。两者对不上时，这套造型在它自己的集里一镜都命中不到，
    # **永远不生效**，而界面上只显示区间、不显示结果 —— 用户只能得出
    # 「造型设了没用」这个结论。
    #
    # 生产实测（2026-10-22 只读扫描）：167 条带镜号区间的造型里有 21 条是这种
    # 自相矛盾的组合，例：
    #     ep22 声明、应存 60..63、实际存 48..48
    #     ep25 声明、应存 71..75、实际存 62..62
    # 它们全部来自 #renumber 不搬造型区间（已修），但存量与"人工填错"仍需入口拦截。
    #
    # 只在**两端都给了**的时候校验：只给一端的（开区间）语义是"从/到某一镜起"，
    # 另一端由集区间决定，不会自相矛盾。
    if st.shot_from is not None and st.shot_to is not None:
        ep_orders = [
            o for (o,) in (session.query(Shot.order)
                           .filter(Shot.project_id == st.project_id,
                                   Shot.episode >= st.ep_from,
                                   Shot.episode <= st.ep_to)
                           .order_by(Shot.order).all())
        ]
        if ep_orders:
            lo, hi = min(ep_orders), max(ep_orders)
            if st.shot_from < lo or st.shot_to > hi:
                raise HTTPException(
                    status_code=400,
                    detail=(f"镜号范围 #{st.shot_from}–#{st.shot_to} 不在"
                            f"第 {st.ep_from}–{st.ep_to} 集的镜号里"
                            f"（那一集是全剧 #{lo}–#{hi}）。"
                            "镜号是全剧连续的，不是每集从头数——"
                            f"要用本集第几镜，请填 #{lo} 起的连续编号。"),
                )

    # 与同角色其他造型的重叠不在这里拒：一镜只归一套，由调用方紧接着 `_claim(session, st)`
    # 让新的接管、旧的让出（2026-10-31，见 stage_coverage）。


def _claim(session, st: AssetStage) -> list[str]:
    """`st` 接管自己的范围（重叠的旧造型让出），返回改动说明；一镜都没覆盖到时 400。"""
    from ..stage_coverage import claim
    try:
        return claim(session, st)
    except ValueError as e:
        session.rollback()
        raise HTTPException(status_code=400, detail=str(e)) from None


@router.get("/projects/{project_id}/stages")
def list_stages(project_id: str) -> dict:
    with get_session() as session:
        # 墓碑阶段不进 stages：本函数的契约是「轨道显示 = 实际注入」，
        # 而删掉的阶段已经不再注入。它们单独走 deleted_stages（资产页的
        # 「已删除」组据此给恢复入口），且**不 claim orders**——否则那些镜头
        # 会被算作"已有阶段覆盖"，虚拟段就不出，用户看不到自己没造型了。
        rows = (stage_gate.alive(
            session.query(AssetStage)
            .filter(AssetStage.project_id == project_id))
            # 与 stage_coverage.card_image 同序：前端 imgOf 取「第一套」当卡片图
            .order_by(AssetStage.character_name, AssetStage.ep_from, AssetStage.shot_from,
                      AssetStage.id).all())
        present, added, removed = _present_orders_map(session, project_id)
        # 每阶段只带自己 ep 区间（及可选 shot_from/to 精修）内的出场镜头
        ep_of = {sh.order: sh.episode for sh in
                 session.query(Shot).filter(Shot.project_id == project_id).all()}
        # ---- 生效范围诊断（2026-10-19）----
        # 用户反馈「无论设置怎样的造型范围，实际引用时都是第一个默认造型生效」。
        # 逐个阶段回答"你到底赢下了哪几镜、没赢是为什么"，而不是让他翻库猜。
        # 判据与出片注入**同一份**（stage_pick），不另立一套。
        diags = _stage_diagnosis(session, project_id, rows, present)
        out = []
        claimed: dict[str, set[int]] = {}   # 角色 → 已被某阶段覆盖的 orders
        for s in rows:
            # 无集数造型（仅供手动引用）不覆盖任何镜头：命中数恒为 0，
            # 且不能走 in_range —— None 参与比较会抛 TypeError。
            if s.ep_from is None or s.ep_to is None:
                in_range = (lambda o: False)
            else:
                in_range = (lambda o: s.ep_from <= ep_of.get(o, -1) <= s.ep_to
                            and (s.shot_from is None or o >= s.shot_from)
                            and (s.shot_to is None or o <= s.shot_to))
            orders = [o for o in present.get(s.character_name, []) if in_range(o)]
            m_add = [o for o in added.get(s.character_name, []) if in_range(o)]
            m_rm = [o for o in removed.get(s.character_name, []) if in_range(o)]
            out.append(_stage_out(s, orders, m_add, m_rm, session=session,
                                  diag=diags.get(s.id)).model_dump())
            claimed.setdefault(s.character_name, set()).update(orders)
        # ---- 「只能用通用定妆图」的镜头（2026-10-22 取代虚拟段）----
        # 角色被注入、但没有任何**真造型**覆盖这些镜头 ——
        # ①拖拽注入的无阶段角色（含 custom 刚归类）②镜头在该角色所有阶段区间之外。
        #
        # 这段计算本身是必要的：它回答"这一镜这个角色会用哪张图"。以前它被包成
        # 一个假造型（`__nostage__<名字>`）塞进 `stages`，代价是整条写链路都要
        # 认得这个假 id（`stage_gate.is_virtual_id`、前端 isVirtualStage 六处判断、
        # 提示词弹窗两道兜底），而它换来的唯一能力是**桌面端轨道上多画一行**——
        # 轨道已随桌面端废弃。所以现在只留信息、不留假造型。
        #
        # 保留下来的两个语义（删虚拟段时最容易丢的就是这两条）：
        #   · 这里给的 `image_url` 就是 `jobs._auto_inject_refs_detailed` 回退时
        #     实际会注入的那张（Asset.image_url），不是随便找的一张 ——
        #     前端显示的图必须等于出片用的图，否则又是"界面一套、出片一套"。
        #   · 墓碑资产不出图：删掉的角色已经不再注入，这里若照旧列出来并给图，
        #     就等于告诉用户"它会用这张"。判据必须是**注入侧同一份**
        #     （`asset_gate.deleted_names`，且同名还有在用行时不算删过），
        #     否则合并之后同一个名字会被整条断掉。
        from ..asset_gate import deleted_names
        _alive_chars = {a.name for a in asset_gate.alive(
            session.query(Asset).filter(Asset.project_id == project_id,
                                        Asset.kind == "character")).all()}
        _gone_chars = deleted_names(session, project_id, "character")
        img_of = {a.name: a.image_url for a in asset_gate.alive(
            session.query(Asset).filter(Asset.project_id == project_id,
                                        Asset.kind == "character")).all()}
        no_stage = []
        for name, orders in present.items():
            # 已被删除的角色根本不注入（jobs 侧 `_gone` 就剔掉了），
            # 列在这里等于承诺"会用这张图"。
            if name in _gone_chars or name not in _alive_chars:
                continue
            orphan = [o for o in orders if o not in claimed.get(name, set())]
            if not orphan:
                continue
            eps = [ep_of.get(o, 1) for o in orphan]
            orphan_set = set(orphan)
            no_stage.append({
                "character_name": name,
                #: 这些镜头里这个角色**会用角色的通用定妆图**（不是任何一套造型）。
                "image_url": img_of.get(name),
                "present_orders": orphan,
                "ep_from": min(eps), "ep_to": max(eps),
                "manual_add_orders": [o for o in added.get(name, [])
                                      if o in orphan_set],
            })
        no_stage.sort(key=lambda x: (-len(x["present_orders"]), x["character_name"]))
        # 已删除的阶段：只给资产页的「已删除」组做恢复入口用，不参与轨道计算。
        # 带上 image_url 是为了让用户看图认出"删掉的是哪一套造型"——名字往往
        # 只是「造型2」，光看名字认不出。
        gone = [
            {"id": s.id, "character_name": s.character_name,
             "stage_name": s.stage_name, "ep_from": s.ep_from, "ep_to": s.ep_to,
             "shot_from": s.shot_from, "shot_to": s.shot_to,
             "image_url": s.image_url, "description": s.description,
             "location": s.location, "deleted_at": s.deleted_at}
            for s in (session.query(AssetStage)
                      .filter(AssetStage.project_id == project_id,
                              AssetStage.deleted_at.isnot(None))
                      .order_by(AssetStage.character_name,
                                AssetStage.ep_from).all())
        ]
        return {"stages": out, "deleted_stages": gone,
                # 「这些镜头只能用角色的通用定妆图」（2026-10-22 取代虚拟段）。
                # 读侧契约：`no_stage[i].image_url` 就是出片回退时实际注入的那张
                # （= Asset.image_url）；为 null 表示这个角色连通用图都没有。
                "no_stage": no_stage,
                "locations": _locations_map(session, project_id)}


def _stage_diagnosis(session, project_id: str, rows: list,
                     present: dict[str, list[int]]) -> dict[str, dict]:
    """每个阶段「到底赢下了哪几镜」，以及没赢时的原因（2026-10-19）。

    返回 `{stage_id: {hit_orders, diagnosis, diagnosis_kind}}`。

    用户原话：「造型阶段似乎没有生效，无论设置怎样的造型范围，实际引用时都是
    第一个默认造型生效」。在此之前这句话**无法被证伪也无法被证实**——界面只显示
    区间（还是全剧镜号），没有任何地方说明这套衣服最后覆盖了哪几个镜头。

    判据完全复用 `stage_pick`（= 出片注入用的那一份），所以这里的结论就是
    出片时的真相，不是近似。

    分类（`diagnosis_kind`）：
      · ok            —— 至少赢下一镜，正常
      · no_image      —— 没有图（也没有可复用的源图）。**最隐蔽的一类**：
                         出片侧把没图的造型直接从候选里滤掉，它连参与排序的机会
                         都没有，用户看到的永远是基础造型的那张脸。
      · no_shot_match —— 这套造型覆盖的集里还没有镜头；或填了镜号区间但没命中
                         任何镜头（多半是把它当成了「本集镜号」）。
      · not_present   —— 集里有镜头，但这个角色在这几集根本没出场。
      · scene_mismatch—— 角色出场了，但绑定的场景与这几镜的实际场景对不上
                         （比的是**归一场景名**）。
      · outranked     —— 角色出场、场景也对，但每一镜都被另一套更具体的造型压过。
                         ⚠️ 统计范围是**本套造型覆盖窗口内**的镜头，不是全项目
                         （2026-10-24 修，见 `_why_not` 的说明）。

    旧分类 `ep_mismatch`（镜号区间命中的镜头都不在集区间内）已并入
    `no_shot_match` / `not_present` 两类 —— 那个分类的判据把"区间"理解成
    "全项目所有镜"，正是这次的病根。
    """
    from .. import stage_pick
    from ..costumes import resolve_stage_image
    from ..scenes import canonical_of

    shots = (session.query(Shot)
             .filter(Shot.project_id == project_id)
             .order_by(Shot.order).all())
    # 归一场景一次算全：逐镜查别名表在 1424 镜的项目上是上千次查询（B29 同款）
    from ..scenes import canonical_map
    loc_canon = canonical_map(session, project_id, shots=shots)

    def _canon(raw: str | None) -> str:
        key = (raw or "").strip()
        if not key:
            return ""
        return loc_canon.get(key) or canonical_of(session, project_id, key)

    by_char: dict[str, list] = {}
    for s in rows:
        by_char.setdefault(s.character_name, []).append(s)
    # 图的可用性与出片侧同一口径（指针行解析到源图）
    usable_img = {s.id: bool(resolve_stage_image(session, s)) for s in rows}

    out: dict[str, dict] = {}
    for name, group in by_char.items():
        present_orders = set(present.get(name) or [])
        # 逐个**有该角色出场的镜头**问一次"你选了哪套"
        winners: dict[int, str] = {}
        for sh in shots:
            if sh.order not in present_orders:
                continue
            # ⚠️ 与出片侧一致：**只把有图的放进候选**。没图的造型在出片时压根
            # 不参与排序，诊断若把无图也算进去，就会得出"它会生效"的错误结论。
            cands = [x for x in group if usable_img.get(x.id)]
            best = stage_pick.pick(cands, episode=sh.episode, order=sh.order,
                                   shot_canon=_canon(sh.location))
            if best is not None:
                winners[sh.order] = best.id

        for s in group:
            hits = sorted(o for o, wid in winners.items() if wid == s.id)
            if hits:
                out[s.id] = {"hit_orders": hits, "diagnosis_kind": "ok",
                             "diagnosis": ""}
                continue
            out[s.id] = {"hit_orders": [], **_why_not(
                s, shots, present_orders, usable_img.get(s.id), winners, group,
                stage_pick, _canon)}
    return out


def _why_not(st, shots, present_orders: set[int], has_img: bool,
             winners: dict[int, str], group: list, stage_pick, canon) -> dict:
    """这套造型为什么一镜都没赢（措辞直接给用户看，说人话）。

    ## ⚠️ 判据必须先收进「这套造型自己的覆盖窗口」（2026-10-24 修）

    此前这里（以及它上面的分类链）只对**填了镜号区间**的造型做窗口判断；
    只填集数的造型直接掉到最后的 `beat_by`，而那个统计遍历的是
    `present_orders` —— **该角色在全项目出场的所有镜头**，不是这套造型覆盖的
    镜头。生产项目「消失的旅客」实测后果：

        周岩 ·「居家服」第 57–60 集 → 命中 0（**结果是对的**）
        诊断却写：「每一镜都被『雪地搜救服』压过（…共 15 镜）」

    那 15 镜是第 1/8/9 集的，与 57–60 集毫无关系；而真实原因是**周岩在第
    57–60 集一镜都没出场**（他最后一次出场是第 54 集 #227）。同一条错诊断也
    出现在「雪地搜救服 第 52–55 集」上。照它给的建议「把区间收窄到别的造型没
    覆盖的镜头上」去做只会更不生效 —— 区间本来就只剩 4 集。

    所以现在四种没赢的原因按**窗口内**的事实分开说：
      ① 这几集还没有镜头（项目还没拆到那儿）
      ② 集里有镜头，但填的镜号区间没命中
      ③ 窗口内有镜头、但角色在这几集根本没出场（最常见，且此前被说成"被压过"）
      ④ 角色出场了，但绑定的场景与这几镜的实际场景对不上
      ⑤ 真的被更具体的造型压过（只统计窗口内的镜头数）
    """
    if not has_img:
        return {"diagnosis_kind": "no_image",
                "diagnosis": "这套造型还没有图——出片时它根本不参与挑选，"
                             "永远会是别的那套生效。点「上传」或「提示词与生成」补一张。"}

    # 无集数造型（2026-11-04）：不参与自动挑选，只靠提示词里手动 @ 引用。
    # 这里必须单独说清楚——否则用户读到的是"一镜都没生效"，
    # 会以为功能坏了，而它的设计本来就是这样。
    if st.ep_from is None or st.ep_to is None:
        return {"diagnosis_kind": "manual_only",
                "diagnosis": "这套造型没有填集数，属于「手动引用」：出片不会自动选它，"
                             "要在提示词里 @ 这套造型才会用到这张图。"}

    ef, et = st.ep_from, st.ep_to
    lo, hi = st.shot_from, st.shot_to

    def _in_ep(sh) -> bool:
        return ef <= (sh.episode or 1) <= et

    ep_any = [sh for sh in shots if _in_ep(sh)]
    window = [sh for sh in ep_any
              if (lo is None or sh.order >= lo) and (hi is None or sh.order <= hi)]

    # ① 这几集还没拆出镜头
    if not ep_any:
        eps_all = sorted({(sh.episode or 1) for sh in shots})
        return {"diagnosis_kind": "no_shot_match",
                "diagnosis": f"第 {ef}–{et} 集目前还没有镜头（这个项目只拆到第 "
                             f"{max(eps_all) if eps_all else 0} 集），"
                             "等这几集拆出来它就会自动生效。"}

    # ② 集里有镜头，但镜号区间没命中（镜号是全剧连续的）
    if not window:
        lo_ep = min(sh.order for sh in ep_any)
        hi_ep = max(sh.order for sh in ep_any)
        return {"diagnosis_kind": "no_shot_match",
                "diagnosis": f"镜号范围 #{lo}–#{hi} 没命中第 {ef}–{et} 集里的任何镜头"
                             f"（那几集是全剧 #{lo_ep}–#{hi_ep}）。"
                             "镜号是全剧连续的，不是每集从头数。"}

    in_win_present = [sh for sh in window if sh.order in present_orders]

    # ③ 窗口内有镜头，但这个角色在这几集没出场
    #
    # 把"他到底在哪几集出场"直接写出来：用户下一步要么改集区间，要么去确认
    # 拆解是不是漏了这个角色。只说"没出场"，他还得自己去翻。
    if not in_win_present:
        eps_hit = sorted({(sh.episode or 1) for sh in shots
                          if sh.order in present_orders})
        if eps_hit:
            brief = _eps_brief(eps_hit)
            last = max((sh for sh in shots if sh.order in present_orders),
                       key=lambda x: x.order)
            tail = f"（最后一次出场是第 {last.episode} 集 #{last.order}）"
        else:
            brief, tail = "", ""
        return {"diagnosis_kind": "not_present",
                "diagnosis": f"第 {ef}–{et} 集里这个角色一镜都没出场"
                             + (f"——他出场的是{brief}{tail}" if brief else "")
                             + "。角色不出场就不会用到这套造型，"
                             "把集区间改成他真出场的集数即可。"}

    # ④ 角色出场了，但绑定的场景与这几镜的实际场景对不上
    #
    # 场景绑定比的是**归一名**（stage_pick.rank 用 canonical 比对）。剧本里
    # 同一个房间各集写法不同（「周宁家-客厅」/「周宁家客厅」），归一化没合上的
    # 话这条永远不生效，而界面上什么都看不出来。
    want = (st.location or "").strip()
    if want:
        seen: dict[str, list[int]] = {}
        for sh in in_win_present:
            seen.setdefault(canon(sh.location) or "（未写场景）", []).append(sh.order)
        if want not in seen:
            names = "、".join(f"「{k}」" for k in list(seen)[:4])
            more = "" if len(seen) <= 4 else f" 等 {len(seen)} 个场景"
            return {"diagnosis_kind": "scene_mismatch",
                    "diagnosis": f"这几镜的场景是 {names}{more}，"
                                 f"与绑定的「{want}」对不上，所以场景绑定没生效。"
                                 "要么改成实际的那个场景名，要么取消场景绑定改用集区间。"}

    # ⑤ 真的被压过 —— **只数这套造型窗口内、且角色出场的那几镜**
    beat_by: dict[str, int] = {}
    for sh in in_win_present:
        wid = winners.get(sh.order)
        if wid and wid != st.id:
            beat_by[wid] = beat_by.get(wid, 0) + 1
    if beat_by:
        top = max(beat_by.items(), key=lambda kv: kv[1])
        other = next((x for x in group if x.id == top[0]), None)
        nm = other.stage_name if other is not None else "另一套造型"
        rng = _stage_range_label(other) if other is not None else ""
        return {"diagnosis_kind": "outranked",
                "diagnosis": f"它的 {top[1]} 镜全都被「{nm}」"
                             + (f"（{rng}）" if rng else "")
                             + " 拿走了：对方填了更窄的镜号区间，或绑定了本镜的场景，"
                               "按「越具体越优先」它排在前面。"}

    return {"diagnosis_kind": "not_present",
            "diagnosis": "这几镜没有选中任何一套造型。"}


def _eps_brief(eps: list[int], cap: int = 8) -> str:
    """[1,8,9,30,…] → 「第 1、8、9、30 集」。太多时折成「第 1、8… 共 10 集」。"""
    if not eps:
        return ""
    head = "、".join(str(e) for e in eps[:cap])
    if len(eps) <= cap:
        return f"第 {head} 集"
    return f"第 {head}… 共 {len(eps)} 集"


def _locations_map(session, project_id: str) -> list[dict]:
    """P1-3 场景轨数据：每场景一行，最终注入 orders + 人工增删标记 + 参考图。

    L1 = Shot.location（拆解落库，单值），图源 = Asset(kind=location).image_url，
    L3 = ref_overrides.add_loc/remove_loc（与角色轨同契约 effective_locations）。

    轨道按**归一名**成行：同一个房间在各集写法不同（「夜 内 楚家公馆-客厅」
    与「楚家公馆-客厅」），按原名成行会把一个房间拆成好几条轨、每条各挂一张
    不同的参考图。场景资产也是按归一名存的，这里同口径才取得到图。
    """
    from ..scenes import canonical_locations, canonical_map, normalize_location
    rows = (session.query(Shot)
            .filter(Shot.project_id == project_id)
            .order_by(Shot.order).all())
    # 归一场景一次算全。逐镜 `canonical_of` 会查一次别名表，而
    # `canonical_locations` 内部**每个名字**再查一次——1460 镜的项目实测
    # 455 ms 全花在这里，且它在 sync def 里跑，多人同时开大项目就把
    # 单核打满（2026-11-13 15:55 现场：CPU 99-100%、/health 3 秒超时）。
    # 换成一次 `canonical_map` 后同一项目 7.6 ms（快 60 倍），返回值逐镜一致。
    # 与本文件 `list_stages` 里 stage 诊断那段（`loc_canon`）同一写法，B29 同款。
    loc_canon = canonical_map(session, project_id, shots=rows)

    def _canon(raw: str | None) -> str:
        """归一名。**不查库**——先查 `loc_canon`，没有才退回确定性清洗。

        与 `canonical_of` 语义等价：后者是"查别名表 → 查不到就
        `normalize_location(...)[0] or raw.strip()`"，这里是
        "查同一个别名表的快照 → 查不到就同一句兜底"。
        """
        key = (raw or "").strip()
        if not key:
            return ""
        return loc_canon.get(key) or normalize_location(key)[0] or key

    present: dict[str, list[int]] = {}
    added: dict[str, list[int]] = {}
    removed: dict[str, list[int]] = {}
    for sh in rows:
        l1 = {_canon(sh.location)} if sh.location else set()
        for c in canonical_locations(session, project_id, sh, canon=loc_canon):
            present.setdefault(c, []).append(sh.order)
            if c not in l1:
                added.setdefault(c, []).append(sh.order)
        try:
            ov = json.loads(sh.ref_overrides) if sh.ref_overrides else {}
        except json.JSONDecodeError:
            ov = {}
        for c in ov.get("remove_loc", []):
            if isinstance(c, str) and c:
                cn = _canon(c)
                if cn in l1:
                    removed.setdefault(cn, []).append(sh.order)
    img_of = {a.name: a.image_url for a in asset_gate.alive(
        session.query(Asset).filter(Asset.project_id == project_id,
                                    Asset.kind == "location")).all()}
    # 出现顺序按首镜 order 排，轨道行序与剧情推进一致
    return [
        {"name": name, "image_url": img_of.get(name),
         "present_orders": orders,
         "manual_add_orders": added.get(name, []),
         "manual_remove_orders": removed.get(name, [])}
        for name, orders in sorted(present.items(), key=lambda kv: kv[1][0])
    ]


class StagePatchIn(BaseModel):
    stage_name: Optional[str] = None
    ep_from: Optional[int] = None
    ep_to: Optional[int] = None
    shot_from: Optional[int] = None
    shot_to: Optional[int] = None
    description: Optional[str] = None
    image_url: Optional[str] = None
    status: Optional[str] = None  # draft | confirmed
    #: 服装继承的两个可改字段（用户对 AI 的 scene_bound 判定有最终解释权）。
    #: location 传空串 = 解除场景绑定。
    location: Optional[str] = None
    scene_bound: Optional[bool] = None
    #: 连同换图一起把旧造型描述清空（用户上传了自己的图时前端传 true）。
    #: 见 `_CLEAR_DESC_WHY`。只有"外来的新图"该传它——采用 AI 候选图不传，
    #: 那张图本来就是照着这段描述生出来的。
    clear_description: Optional[bool] = None


#: 为什么"换成用户自己的图"必须把旧描述清掉（2026-09-10 用户反馈的外观漂移）
#:
#: 造型描述在 `costumes.py` 拆剧本时就写好了 —— 那会儿一张图都还没有，
#: 写的是"剧本里这个人应该穿什么"。用户后来上传自己的定妆图，这段文字
#: 与新图毫无关系，但出片时 `jobs._auto_inject_refs_detailed` 仍把它作为
#: 参考图的文字锚点注入，且提示词里明写「原稿中与之矛盾的服装描写一律以此
#: 为准改写」（jobs.py 的 ref_notes 段）—— 于是**文字压过了参考图**，
#: 人物外观必然漂移。
#:
#: 清空之后走的是 jobs.py 里 `blind` 那条确定性兜底：没有文字造型的参考图，
#: 提示词**禁止**书写其服装/发型/配饰，外观完全交给参考图钳制。
#: 这正是"我传了自己的图"最想要的行为。
_CLEAR_DESC_WHY = "用户上传了自己的图，旧造型描述已与该图无关"


@router.patch("/stages/{stage_id}")
async def patch_stage(stage_id: str, body: StagePatchIn) -> dict:
    # 2026-09-10：这里原本在换图时同步等一次视觉反推（~8s 的多模态调用，
    # 还要把图整份 base64 上行）。它把"上传一张图"拖成了几十秒，且期间
    # 资产弹窗不许关闭 = 整页锁死。反推已改为弹窗里的手动按钮
    # （POST /v2/assets/describe-image），上传链路不再碰模型。
    with get_session() as session:
        st = session.get(AssetStage, stage_id)
        if st is not None:
            # 归属校验（2026-10-09）。放在原判空**之前**的 if 里：
            # 不存在仍走下面那条带解释的 404，存在但不是你的也是 404。
            access.req_stage(session, stage_id)
        if not st:
            # 虚拟段（`__nostage__`，库里没有行）是这里最常见的"查不到"来源：
            # 它由 list_stages 合成，前端若拿它当目标就会走到这。给一句能照做的话，
            # 而不是裸 stage not found——用户照着那句话就能把图传对地方。
            raise HTTPException(status_code=404,
                                detail=stage_gate.describe_missing(stage_id))
        # 已删除的阶段不接受编辑：让用户先恢复，再改。否则会出现"改了一个
        # 看不见的东西"——保存成功、界面上什么都没变。
        if st.deleted_at:
            raise HTTPException(status_code=409,
                                detail="该造型阶段已删除，请先恢复再编辑")
        if body.status is not None and body.status not in ("draft", "confirmed"):
            raise HTTPException(status_code=400, detail="status 只能是 draft/confirmed")
        # ⚠️ `shot_from/shot_to` 走**显式传 null 才清空**的语义（2026-10-19）。
        # 这一圈原本是统一的 `if v is not None: setattr(...)`，对"改范围"这个
        # 动作是错的：用户把镜号框清空就是想说"退回整集生效"，而 null 会被
        # 当成"没传"直接跳过 —— 保存成功、界面照旧，是最坏的那种静默失败。
        # 判据用 `model_fields_set`（Pydantic v2）：区分"请求里没这个键"与
        # "请求里明确写了 null"，前者不动、后者置空。
        for k in ("shot_from", "shot_to"):
            if k in body.model_fields_set:
                setattr(st, k, getattr(body, k))
        for k in ("stage_name", "ep_from", "ep_to", "description", "image_url",
                  "status"):
            v = getattr(body, k)
            if v is not None:
                setattr(st, k, v)
        # location / scene_bound 已不参与任何判断（2026-10-31 去掉「按场景生效」），收到也不写
        # 人工给了图 → 它自己就是源，解除指针（否则显示的还是别人的图）
        if body.image_url:
            st.source_stage_id = None
        # 用户上传自己的图 → 旧描述与新图无关，清掉（见 _CLEAR_DESC_WHY）。
        # 放在通用赋值之后：本次若同时手写了描述，以用户的字为准，不被清空。
        if body.clear_description and body.description is None:
            st.description = None
        _check_stage_ranges(session, st)
        _range_keys = {"ep_from", "ep_to", "shot_from", "shot_to"}
        notes = (_claim(session, st)
                 if _range_keys & {k for k in body.model_fields_set if getattr(body, k, None) is not None
                                   or k in ("shot_from", "shot_to")} else [])
        session.commit()
        out = _stage_out(st).model_dump()
        out["adjusted"] = notes
        # 换图才落版本。取快照出 session 再写（record 开自己的会话）。
        # `patch_stage` 是造型弹窗里"生成"与"上传"两条路的共同落点，
        # 漏了这里 = 造型图换过多少次都只有一个版本。
        _ver = ((st.project_id, st.id, f"{st.character_name} · {st.stage_name}",
                 st.image_url, st.description)
                if body.image_url else None)
    if _ver:
        from ..asset_versions import record as _rec
        # 造型的 `prompt` 与 `desc_in` 都填**着装描述**：这条路由是"上传/弹窗内生成"
        # 的落点，手上只有描述、没有拼好的复合稿。回退时读 desc_in，正好对得上。
        _rec(project_id=_ver[0], kind="stage", target_id=_ver[1],
             image_url=_ver[3], prompt=_ver[4], desc_in=_ver[4],
             source="upload", label=_ver[2])
    return out


class StageCreateIn(BaseModel):
    project_id: str
    character_name: str
    stage_name: str
    #: 集数区间可选。留空表示"仅供手动引用"——不参与自动注入，
    #: 只有用户在提示词里 @引用该造型时才生效。
    #: 区别于"全剧通用兜底"：兜底走资产卡通用图，无集数造型不参与兜底。
    ep_from: Optional[int] = None
    ep_to: Optional[int] = None
    shot_from: Optional[int] = None
    shot_to: Optional[int] = None
    description: Optional[str] = None
    location: Optional[str] = None
    scene_bound: Optional[bool] = None


@router.post("/stages")
def create_stage(body: StageCreateIn) -> dict:
    """手动新增一套造型阶段（资产页「新增造型」）。

    ⚠️ 2026-10-15 之前**根本没有这个接口**：网页端的「新增造型」按钮只渲染、
    不绑定任何 handler，点了毫无反应；阶段行此前只能由 AI 识别（stages/draft）
    或一键补全创建。用户想补一套 AI 没识别出来的衣服，没有任何办法。

    建出来的行**没有图**——之后在同一行点「提示词与生成 / 上传」补图，
    与 AI 识别出来的阶段走完全相同的后续链路。区间校验与 patch 共用
    `_check_stage_ranges`，冲突时 409 并告诉用户怎么改。
    """
    name = (body.stage_name or "").strip()
    char = (body.character_name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="造型名称不能为空")
    if not char:
        raise HTTPException(status_code=422, detail="缺少角色名")
    with get_session() as session:
        if not access.can_access_project(session, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        # 必须挂在一个**在用**的角色或场景资产下：阶段按 character_name 连接，
        # 名字对不上任何资产 = 建了一条永远不会被注入的孤儿行。
        # kind 允许 character 和 location（场景造型阶段，如"病房·日"/"病房·夜"）。
        a = (session.query(Asset)
             .filter(Asset.project_id == body.project_id,
                     Asset.kind.in_(["character", "location"]),
                     Asset.name == char, Asset.deleted_at.is_(None)).first())
        if a is None:
            raise HTTPException(status_code=404, detail=f"找不到角色或场景「{char}」")
        st = AssetStage(
            id=uuid.uuid4().hex[:12], project_id=body.project_id,
            character_name=char, stage_name=name,
            ep_from=body.ep_from, ep_to=body.ep_to,
            shot_from=body.shot_from, shot_to=body.shot_to,
            description=(body.description or "").strip() or None,
            status="draft")
        _check_stage_ranges(session, st)
        session.add(st)
        notes = _claim(session, st)
        session.commit()
        return {**_stage_out(st).model_dump(), "adjusted": notes}


@router.delete("/stages/{stage_id}")
def delete_stage(stage_id: str) -> dict:
    """删除造型阶段（用户 2026-09-09 需求 2）。**写墓碑，不真删行。**

    用户原话：「阶段删除后似乎没有撤销删除的能力」。此前这里是 `session.delete(st)`,
    误删一个已出定妆图的阶段就等于把那张图彻底丢掉——而"重跑服装识别"并不能
    找回它：那是按剧本**重新规划**，产出的是新 id、没有图的阶段，要重新花钱生图，
    名字与区间都可能和用户删掉的那条不同。

    墓碑之后：阶段立刻不再被注入/规划/合并（`stage_gate` 统一闸门），
    但行与图都还在，`POST /stages/{id}/restore` 能原样恢复。
    """
    with get_session() as session:
        st = session.get(AssetStage, stage_id)
        if st is not None:
            # 归属校验（2026-10-09）。放在原判空**之前**的 if 里：
            # 不存在仍走下面那条带解释的 404，存在但不是你的也是 404。
            access.req_stage(session, stage_id)
        if not st:
            raise HTTPException(status_code=404,
                                detail=stage_gate.describe_missing(stage_id))
        if st.deleted_at:
            # 幂等：重复删不报错（前端重试/双击都可能打两次）
            return {"ok": True, "already_deleted": True,
                    "character_name": st.character_name,
                    "stage_name": st.stage_name, "deleted_at": st.deleted_at}
        st.deleted_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        out = {"ok": True, "character_name": st.character_name,
               "stage_name": st.stage_name, "deleted_at": st.deleted_at,
               #: 这张定妆图还在磁盘上（GC 连墓碑一起扫），恢复后照旧可用
               "kept_image": bool(st.image_url)}
        # 指针行的源被删 → 跟随者会失去图源（costumes.resolve_stage_image 不穿透
        # 墓碑）。告诉用户有几条跟着一起失效，而不是让他事后发现"那几段没图了"。
        out["followers"] = (session.query(AssetStage)
                            .filter(AssetStage.source_stage_id == st.id,
                                    AssetStage.deleted_at.is_(None)).count())
        session.commit()
    return out


@router.post("/stages/{stage_id}/restore")
def restore_stage(stage_id: str) -> dict:
    """撤销删除造型阶段：清掉墓碑，阶段与定妆图原样回来。

    恢复出来的造型接管它原来的范围；这期间建在同一段上的造型让出（一镜只归一套），
    改了哪几套在 `adjusted` 里说明。
    """
    with get_session() as session:
        st = session.get(AssetStage, stage_id)
        if st is not None:
            # 归属校验（2026-10-09）。放在原判空**之前**的 if 里：
            # 不存在仍走下面那条带解释的 404，存在但不是你的也是 404。
            access.req_stage(session, stage_id)
        if not st:
            raise HTTPException(status_code=404,
                                detail=stage_gate.describe_missing(stage_id))
        if not st.deleted_at:
            return {"ok": True, "already_alive": True,
                    "stage": _stage_out(st).model_dump()}
        st.deleted_at = None
        notes = _claim(session, st)
        session.commit()
        return {"ok": True, "stage": _stage_out(st).model_dump(), "adjusted": notes}


class StageMergeIn(BaseModel):
    stage_ids: list[str]
    #: 保留哪个阶段的图/名/描述；缺省 = 有定妆图者优先，否则取第一个
    keep_id: Optional[str] = None


@router.post("/stages/merge")
def merge_stages(body: StageMergeIn) -> dict:
    """合并同一角色的多个造型阶段（资产页勾选合并，修「相似设定不能合一」）。

    语义：保留 keep 阶段（图/名/描述），ep 区间取所有被合并阶段的并集
    （min ep_from .. max ep_to），其余阶段删除；shot_from/to 清空（跨集后
    集内精修失去意义）。与未参与合并的造型重叠时，合并后的这套接管、它们让出。
    """
    if len(set(body.stage_ids)) < 2:
        raise HTTPException(status_code=400, detail="至少勾选 2 个阶段才能合并")
    with get_session() as session:
        rows = (session.query(AssetStage)
                .filter(AssetStage.id.in_(body.stage_ids)).all())
        if len(rows) != len(set(body.stage_ids)):
            raise HTTPException(status_code=404, detail="部分阶段不存在")
        # 归属校验（2026-10-09）：这个端点**只收 stage_ids、没有 project_id**，
        # 中间件的路径/查询串/请求体三道拦截全都够不着它，只能在这里逐行查。
        #
        # ⚠️ 必须在下面所有 409/400 判定**之前**、且对**每一行**都查：
        # 若先跑"只能合并同一角色"，一批"我的 + 别人的"混合 id 会得到 400 而非 404，
        # 等于告诉调用者"那几个 id 真实存在、只是不在你的项目里"——用报错差异
        # 探测他人数据。逐行查保证任何一个不是你的，整批都是"不存在"。
        if not all(access.can_access_project(session, r.project_id) for r in rows):
            raise HTTPException(status_code=404, detail="部分阶段不存在")
        # 墓碑不能参与合并：合并会改区间、删行、迁图，把一个"已删除"的东西
        # 卷进来只会让恢复变得没意义（用户恢复出来的还是不是原来那条？）。
        if any(r.deleted_at for r in rows):
            raise HTTPException(status_code=409,
                                detail="所选阶段中有已删除的，请先恢复或取消勾选")
        if len({r.project_id for r in rows}) > 1 or len({r.character_name for r in rows}) > 1:
            raise HTTPException(status_code=400, detail="只能合并同一角色的阶段")
        if body.keep_id:
            keep = next((r for r in rows if r.id == body.keep_id), None)
            if not keep:
                raise HTTPException(status_code=400, detail="keep_id 不在所选阶段中")
        else:
            keep = next((r for r in rows if r.image_url), rows[0])
        ep_from = min(r.ep_from for r in rows)
        ep_to = max(r.ep_to for r in rows)
        keep.ep_from, keep.ep_to = ep_from, ep_to
        keep.shot_from = keep.shot_to = None
        # 保留者缺图/缺描述时，从被合并者中兜底补齐（不丢已有资产）
        if not keep.image_url:
            keep.image_url = next(
                (r.image_url for r in rows if r.id != keep.id and r.image_url), None)
        if not keep.description:
            keep.description = next(
                (r.description for r in rows if r.id != keep.id and r.description), None)
        merged_names = [r.stage_name for r in rows if r.id != keep.id]
        for r in rows:
            if r.id != keep.id:
                session.delete(r)
        session.flush()
        notes = _claim(session, keep)
        session.commit()
        return {"ok": True, "kept": _stage_out(keep).model_dump(),
                "merged_names": merged_names, "adjusted": notes}


class StageConfirmAllIn(BaseModel):
    project_id: str
    #: 指定阶段 id；缺省=该项目所有「有图但仍是 draft」的阶段
    stage_ids: Optional[list[str]] = None


@router.post("/stages/confirm-all")
def confirm_all_stages(body: StageConfirmAllIn) -> dict:
    """批量把定妆图阶段置为 confirmed。**已废弃，仅留作 API 兼容。**

    历史上 `jobs._auto_inject_refs` 只注入 confirmed 的定妆图，AI 生成的阶段
    默认 draft，于是"资产明明生成了却没被注入"。现在注入只看有没有图——
    生成/上传即视为选定，不再需要额外一道确认，所以本端点对注入**无任何影响**，
    UI 上也已没有入口。status 现仅是资产页的人工标记。
    """
    with get_session() as session:
        q = stage_gate.alive(
            session.query(AssetStage)
            .filter(AssetStage.project_id == body.project_id,
                    AssetStage.image_url.isnot(None),
                    AssetStage.status != "confirmed"))
        if body.stage_ids:
            q = q.filter(AssetStage.id.in_(list(body.stage_ids)))
        rows = q.all()
        for st in rows:
            st.status = "confirmed"
        session.commit()
        return {"ok": True, "confirmed": len(rows),
                "ids": [st.id for st in rows]}


# ---------- 生产就绪度体检（出片前二次确认弹窗的数据源）----------
@router.get("/projects/{project_id}/readiness")
def project_readiness(project_id: str) -> dict:
    """只读体检：镜头/资产/首帧/模型能力是否具备开跑条件。

    弹窗打开时拉一次；job 结束后再拉一次刷新。不写任何库、不产生任何费用。
    """
    from ..readiness import compute_readiness
    data = compute_readiness(project_id)
    if data.get("error"):
        raise HTTPException(status_code=404, detail=data["error"])
    return data


# ---------- 场景归一字典（"同一场景下同一人物服装相同"的判据）----------
@router.get("/projects/{project_id}/scenes")
def list_scenes(project_id: str) -> dict:
    """场景归一字典：`{归一场景名: [该项目里的原始写法...]}` + 每组的镜头数。

    为什么要把它摊到 UI 上：服装继承、场景基准帧共享**全都以归一名为准**。
    归错了（两个不同房间被合成一个）画面就会错，所以必须让用户看得见、改得动。
    只读，不触发任何模型调用。
    """
    from ..scenes import canonical_map, normalize_location
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        from ..db import SceneAlias
        canon = canonical_map(session, project_id)
        src = {r.raw_name: r.source for r in (session.query(SceneAlias)
               .filter(SceneAlias.project_id == project_id).all())}
        counts: dict[str, int] = {}
        for sh in (session.query(Shot)
                   .filter(Shot.project_id == project_id).all()):
            lo = (sh.location or "").strip()
            if lo:
                counts[lo] = counts.get(lo, 0) + 1
        groups: dict[str, dict] = {}
        for raw, cn in sorted(canon.items()):
            g = groups.setdefault(cn, {"canonical": cn, "members": [], "shots": 0})
            g["members"].append({
                "raw_name": raw, "shots": counts.get(raw, 0),
                # manual = 用户改过，AI 重跑归一不会推翻
                "source": src.get(raw, "auto"),
                "time_of_day": normalize_location(raw)[1],
                "int_ext": normalize_location(raw)[2],
            })
            g["shots"] += counts.get(raw, 0)
    return {"scenes": sorted(groups.values(),
                             key=lambda g: (-g["shots"], g["canonical"]))}


class SceneAliasIn(BaseModel):
    project_id: str
    raw_name: str
    #: 归一场景名。改这个就是"把这个写法并到那个场景去"
    canonical: str


@router.patch("/scenes/alias")
def patch_scene_alias(body: SceneAliasIn) -> dict:
    """人工改一条场景归一映射（`source='manual'`，AI 重跑时不被覆盖）。

    误合并的修法就是把其中一个写法的 canonical 改回它自己的名字。
    """
    from ..scenes import set_alias
    canonical = (body.canonical or "").strip()
    if not canonical:
        raise HTTPException(status_code=400, detail="canonical 不能为空")
    with get_session() as session:
        if session.get(Project, body.project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
        changed = set_alias(session, body.project_id, body.raw_name,
                            canonical, source="manual")
        session.commit()
    return {"ok": True, "changed": changed,
            "raw_name": body.raw_name, "canonical": canonical}


class SceneCanonIn(BaseModel):
    project_id: str
    model_id: Optional[str] = None


@router.post("/projects/{project_id}/scenes/canonicalize")
async def canonicalize_project_scenes(project_id: str,
                                      body: Optional[SceneCanonIn] = None) -> dict:
    """跑一次场景别名合并（一次文本模型调用，**不生成任何图、不花生图钱**）。

    幂等：只更新 AI 来源的映射，人工改过的保持不动。
    `stages_draft` 内部也会先跑它，这里单独开一个入口是为了让用户能先看归一结果、
    确认没有误合并，再决定要不要去识别服装。
    """
    from ..scenes import canonicalize_scenes
    from .. import charge
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
    # 一次文本操作（按次收，不按底层调用数）。放在项目存在校验之后。
    charge.charge_sync("reprompt", {"project_id": project_id},
                       desc="场景名归一", project_id=project_id)
    try:
        out = await canonicalize_scenes(project_id,
                                        body.model_id if body else None)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"场景归一失败: {e!r}")
    return {"ok": True, "updated": out["updated"], "llm": out["llm"],
            "scenes": out["scenes"]}


class ScenePreviewIn(BaseModel):
    model_id: Optional[str] = None


@router.post("/projects/{project_id}/scenes/preview")
async def preview_project_scenes(project_id: str,
                                 body: Optional[ScenePreviewIn] = None) -> dict:
    """算一份归一建议并翻译成"执行后会变什么"，**一个字都不写库**。

    与 `/scenes/canonicalize` 的区别就是"写不写"：那条算完直接落库，
    而归一是**有损**的（同一归一名下的多行场景资产会被合并成一行，
    删掉的那行可能已经出过图、花过钱）。所以界面走的是这条：
    先看每组影响多少镜头、会删哪一行资产，逐组确认后再调 `/scenes/apply-groups`。

    成本：一次文本模型调用，不出图。前端应由用户点按钮触发，别在打开面板时自动跑。
    """
    from ..scenes import preview_groups, propose_scene_groups
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
    try:
        prop = await propose_scene_groups(project_id,
                                          body.model_id if body else None)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"场景归一建议失败: {e!r}")
    with get_session() as session:
        groups = preview_groups(session, project_id, prop["groups"], prop["meta"])
    return {"ok": True, "llm": prop["llm"], "groups": groups}


class SceneGroupIn(BaseModel):
    canonical: str
    members: list[str]


class SceneApplyIn(BaseModel):
    #: 用户**逐组确认过**的分组。只写这些组，不碰其它组。
    groups: list[SceneGroupIn]


@router.post("/projects/{project_id}/scenes/apply-groups")
def apply_project_scene_groups(project_id: str, body: SceneApplyIn) -> dict:
    """把用户确认过的那几组归一写进库（`source='manual'`，AI 重跑不推翻）。

    刻意**不**提供"把建议全盘接受"的入口：归一有损，
    全盘接受意味着用户在没看过的合并上也点了同意（见文档 U3）。

    资产收敛只作用于本次这些组的归一名（`scoped_assets=True`）——
    库里可能还留着早先 `stages_draft` 内部跑归一时写下的 AI 别名，
    那些组用户没看过，不该被这次确认顺带合并掉。
    """
    from ..scenes import apply_scene_groups, normalize_location, raw_locations
    if not body.groups:
        raise HTTPException(status_code=400, detail="没有要应用的分组")
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
        known = set(raw_locations(session, project_id))
        seen: set[str] = set()
        groups: list[dict] = []
        meta: dict[str, tuple[str | None, str | None]] = {}
        for g in body.groups:
            canon = (g.canonical or "").strip()
            if not canon:
                raise HTTPException(status_code=400, detail="归一名不能为空")
            members = [m.strip() for m in g.members if (m or "").strip()]
            if not members:
                raise HTTPException(status_code=400,
                                    detail=f"「{canon}」这一组没有成员")
            for m in members:
                # 不在本项目镜头里出现过的名字一律拒绝：这条接口只收敛既有写法，
                # 不是"任意写别名"的入口（那会往字典里塞永远匹配不到的死行）
                if m not in known:
                    raise HTTPException(
                        status_code=400,
                        detail=f"「{m}」不是本项目的场景名（可能镜头已改动，请重新预览）")
                if m in seen:
                    raise HTTPException(status_code=400,
                                        detail=f"「{m}」出现在多个分组里")
                seen.add(m)
                meta[m] = normalize_location(m)[1:]
            groups.append({"canonical": canon, "members": members})
        res = apply_scene_groups(session, project_id, groups,
                                 source="manual", meta=meta, scoped_assets=True)
        session.commit()
    return {"ok": True, "applied_groups": len(groups),
            "updated": res["updated"], "assets": res["assets"]}


class SceneDescIn(BaseModel):
    model_id: Optional[str] = None
    #: True = 连已有描述的场景一起重写。默认 False——用户手改过的描述
    #: 绝不能被 AI 重跑覆盖（A6 那次数据丢失的教训）。
    overwrite: bool = False


@router.post("/projects/{project_id}/scenes/describe")
async def describe_project_scenes(project_id: str,
                                  body: Optional[SceneDescIn] = None) -> dict:
    """为项目的所有场景生成文字描述并写入 `Asset.desc_auto`（Q3，纯文本调用不出图）。

    ## 为什么需要它

    场景参考图的提示词原来长这样：

        影视场景参考图：星云塔顶层-星空餐厅。要求：完整呈现空间布局…

    模型只拿到一个**场景名**——因为 `Asset.desc_auto` 恒为空（实测两个项目
    117/117 与 65/65 全空），永远走兜底分支。角色侧有 costumes.py 产出造型描述，
    场景侧此前**没有任何环节**产出描述，这是结构性缺口。

    跑完之后同一个接口的提示词会带上空间/陈设/材质/光线的具体描述，
    生图质量与画风稳定性都会明显不同。
    """
    from ..scene_desc import generate_scene_descriptions
    from .. import charge

    # 一次文本操作（按次收）。这条会调 LLM 但不出图，仍属"用户操作"。
    charge.charge_sync("reprompt", {"project_id": project_id},
                       desc="场景描述生成", project_id=project_id)
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
    try:
        out = await generate_scene_descriptions(
            project_id,
            model_id=body.model_id if body else None,
            overwrite=bool(body.overwrite) if body else False)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"场景描述生成失败: {e!r}")
    return {"ok": True, **out}


class CharAliasIn(BaseModel):
    model_id: Optional[str] = None


@router.post("/projects/{project_id}/characters/canonicalize")
async def canonicalize_project_characters(project_id: str,
                                          body: Optional[CharAliasIn] = None) -> dict:
    """跑一次角色名归一（一次文本模型调用，**不出图、不花生图钱**，N2）。

    把同一个人的多种写法归到一个标准名下：
        「少年陆明」+「陆明」→「陆明」（同一人的少年期，`age_stage` 区分）
        「江卫东的秘书」+「江卫东秘书」→ 择一（同一人的两种写法）

    ⚠️ 判定走 LLM 语义而非字面子串——实测「陆明父亲」⊃「陆明」但**是两个人**，
    按子串合并会让父子共用一张脸。归组保守：拿不准就不合并。

    幂等：只更新 `source='ai'` 的行，用户手改过的（`source='manual'`）不动。
    """
    from ..char_alias import canonicalize_characters
    from .. import charge

    # 一次文本操作（按次收），同 scenes/canonicalize。
    charge.charge_sync("reprompt", {"project_id": project_id},
                       desc="角色名归一", project_id=project_id)
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
    try:
        out = await canonicalize_characters(project_id,
                                            body.model_id if body else None)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"角色归一失败: {e!r}")
    return {"ok": True, **out}


@router.get("/projects/{project_id}/characters/aliases")
def list_character_aliases(project_id: str) -> dict:
    """角色归一字典（只读）：同一角色的各种写法 + 角色清单。

    与 `GET /projects/{id}/scenes` 对称。存在的理由很具体：3.11 的「上传素材
    自动归属」（`desktop/src/features/assets/attribute.ts`）要按**别名**认人——
    用户把 `小陆.png` 丢进来时，得先知道 `小陆` 是「陆明」的别名，才能归对卡。
    在此之前这个映射只有 `PATCH /characters/alias`（写得进、读不出），
    前端拿不到它，只能放弃"按别名匹配"这条规则。

    `characters` 是**角色清单**（项目里所有镜头出现过的角色，已归一）——
    归属时用来做前缀/子串匹配的候选池，同样不额外查一次才给。
    只读，不触发任何模型调用。
    """
    from ..char_alias import age_stage_map, canonical_character_map
    from ..db import CharacterAlias, effective_characters
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
        canon = canonical_character_map(session, project_id)
        ages = age_stage_map(session, project_id)
        src = {r.raw_name: r.source for r in (session.query(CharacterAlias)
               .filter(CharacterAlias.project_id == project_id).all())}
        groups: dict[str, dict] = {}
        for raw, cn in sorted(canon.items()):
            g = groups.setdefault(cn, {"canonical": cn, "members": []})
            g["members"].append({
                "raw_name": raw,
                # manual = 用户改过，AI 重跑归一不会推翻
                "source": src.get(raw, "auto"),
                "age_stage": ages.get(raw),
            })
        # 角色清单走 effective_characters —— 与注入/轨道渲染同源，
        # 保证"能归属到谁"和"轨道上能显示谁"是同一份名单。
        seen: dict[str, int] = {}
        for sh in (session.query(Shot)
                   .filter(Shot.project_id == project_id).all()):
            for c in effective_characters(sh):
                seen[c] = seen.get(c, 0) + 1
    return {
        "groups": sorted(groups.values(), key=lambda g: g["canonical"]),
        "characters": sorted(seen, key=lambda c: (-seen[c], c)),
    }


class CharAliasPatchIn(BaseModel):
    project_id: str
    raw_name: str
    #: 归一后的角色名。改这个就是"把这个写法并到那个角色去"；
    #: 填回它自己的名字 = 取消归一（误合并的修法）
    canonical: str
    age_stage: Optional[str] = None


@router.patch("/characters/alias")
def patch_character_alias(body: CharAliasPatchIn) -> dict:
    """人工改一条角色归一映射（`source='manual'`，AI 重跑时不被覆盖）。

    误合并的修法就是把其中一个写法的 canonical 改回它自己的名字。
    """
    import uuid as _uuid
    from ..db import CharacterAlias
    with get_session() as session:
        if session.get(Project, body.project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
        raw = (body.raw_name or "").strip()
        canon = (body.canonical or "").strip()
        if not raw or not canon:
            raise HTTPException(status_code=422, detail="raw_name 与 canonical 均不能为空")
        row = (session.query(CharacterAlias)
               .filter(CharacterAlias.project_id == body.project_id,
                       CharacterAlias.raw_name == raw).first())
        if row is None:
            row = CharacterAlias(id=_uuid.uuid4().hex[:12],
                                 project_id=body.project_id, raw_name=raw,
                                 canonical=canon, age_stage=body.age_stage,
                                 source="manual")
            session.add(row)
        else:
            row.canonical = canon
            row.age_stage = body.age_stage
            row.source = "manual"
        session.commit()
        return {"ok": True, "raw_name": raw, "canonical": canon,
                "age_stage": row.age_stage, "source": "manual"}


# ---------- 服装解析报告（花费闸门：先报数，用户点了才出图）----------
#: 每镜×角色的服装来源。与 jobs._auto_inject_refs 的 _rank 档位一一对应，
#: 是"注入时到底会用哪张图"的**说明书**，不是另一套判断逻辑。
_COSTUME_REASONS = {
    "explicit_variant": "剧本明写的镜号变体",
    "scene_inherited": "同场景沿用（场景决定型服装）",
    "scene_event": "同场景同集的事件型服装",
    "base_stage": "该集基础造型",
    "generic_asset": "角色通用定妆图",
    "none": "无可用参考图",
}


@router.get("/projects/{project_id}/costume-report")
def costume_report(project_id: str) -> dict:
    """逐镜×角色列出"这一镜会穿哪套、图从哪来"，并报出要花钱生成几张。

    这是用户确认的**花费闸门**数据源："先报数、等我点确认"——识别完先把清单和
    张数摊出来（免费复用的单独标出），用户点了才真去出图。

    判定与 `jobs._auto_inject_refs` 同口径（同一套档位、同一个归一场景判据），
    所以报告里写的就是生成时实际会发生的事，不会"报告一套、注入另一套"。
    """
    from ..costumes import resolve_stage_image
    from ..db import Asset, effective_characters
    from ..scenes import canonical_map
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
        canon = canonical_map(session, project_id)
        shots = (session.query(Shot)
                 .filter(Shot.project_id == project_id)
                 .order_by(Shot.order).all())
        # 墓碑阶段不进诊断：它不会被注入，也不该被算进"要花钱生成几张"
        stages = stage_gate.alive(
            session.query(AssetStage)
            .filter(AssetStage.project_id == project_id)).all()
        # 墓碑角色的通用资产图不算"已有图"：它不会被注入，诊断表里报有图
        # 会让用户以为不用管，实际出图时那一镜没有任何角色参考。
        generic = {a.name for a in asset_gate.alive(
            session.query(Asset).filter(Asset.project_id == project_id,
                                        Asset.kind == "character")).all()
                   if a.image_url}
        by_char: dict[str, list[AssetStage]] = {}
        for st in stages:
            by_char.setdefault(st.character_name, []).append(st)

        rows: list[dict] = []
        for sh in shots:
            if sh.disabled or sh.is_special:
                continue
            cn = canon.get((sh.location or "").strip(), (sh.location or "").strip())
            for c in effective_characters(sh):
                pick, reason = None, "none"
                best = (9, 0)
                for st in by_char.get(c, []):
                    lo, hi = st.shot_from, st.shot_to
                    loc = (st.location or "").strip()
                    # 无集数造型（仅供手动引用）不参与自动挑选，识别预览也照此处理，
                    # 否则 None 参与比较会抛 TypeError。
                    if st.ep_from is None or st.ep_to is None:
                        continue
                    in_ep = st.ep_from <= sh.episode <= st.ep_to
                    has_shots = lo is not None or hi is not None
                    miss = ((lo is not None and sh.order < lo)
                            or (hi is not None and sh.order > hi))
                    if has_shots and not miss:
                        rank = (0, (hi - lo) if (lo is not None and hi is not None)
                                else 10 ** 6)
                        why = "explicit_variant"
                    elif st.scene_bound and loc and loc == cn:
                        rank, why = (1, 0), "scene_inherited"
                    elif loc and loc == cn and in_ep:
                        rank, why = (2, 0), "scene_event"
                    elif not has_shots and not loc and in_ep:
                        rank, why = (3, 0), "base_stage"
                    else:
                        continue
                    if rank < best:
                        best, pick, reason = rank, st, why
                if pick is None and c in generic:
                    reason = "generic_asset"
                img = resolve_stage_image(session, pick) if pick is not None else None
                rows.append({
                    "order": sh.order, "episode": sh.episode,
                    "scene": cn, "character": c,
                    "stage_id": pick.id if pick is not None else None,
                    "stage_name": pick.stage_name if pick is not None else None,
                    "reason": reason, "reason_label": _COSTUME_REASONS[reason],
                    "has_image": bool(img) or (pick is None
                                              and reason == "generic_asset"),
                })

        # 报数：要花钱的 = 自己没图、也不是指针行的阶段；免费的 = 指针行 + 已有图
        to_generate = [st for st in stages
                       if not st.image_url and not st.source_stage_id]
        free_reuse = [st for st in stages
                      if not st.image_url and st.source_stage_id]
        stage_rows = [{
            "id": st.id, "character_name": st.character_name,
            "stage_name": st.stage_name,
            "ep_from": st.ep_from, "ep_to": st.ep_to,
            "shot_from": st.shot_from, "shot_to": st.shot_to,
            "location": st.location, "scene_bound": bool(st.scene_bound),
            "has_image": bool(st.image_url),
            "reuse_of": st.source_stage_id,
        } for st in sorted(stages, key=lambda x: (x.character_name, x.ep_from,
                                                  x.shot_from or 0))]
    covered = sum(1 for r in rows if r["has_image"])
    return {
        "stages": stage_rows,
        "shots": rows,
        "summary": {
            "stages_total": len(stages),
            "to_generate": len(to_generate),      # 需要真去出图的张数（花钱）
            "free_reuse": len(free_reuse),        # 复用同一件衣服的图（免费）
            "scene_bound": sum(1 for st in stages
                               if st.scene_bound and (st.location or "").strip()),
            "shot_char_pairs": len(rows),
            "shot_char_covered": covered,
            "shot_char_uncovered": len(rows) - covered,
        },
    }


class StageDraftIn(BaseModel):
    project_id: str
    #: 角色先验：{角色名: none|growth|multi}（设计稿"成长路线"三选项，作为 AI 提示）
    priors: Optional[dict[str, str]] = None
    model_id: Optional[str] = None

_STAGE_SYSTEM_LEGACY_NOTE = (
    "全剧服装识别已迁到 app/costumes.py（逐集并发扫描 + 完整性复查）。"
    "原来那份一次性提示词把 script[:6000] 和前 300 个镜头一起喂进去，"
    "对 8000 字的 5 集短剧就已经截掉四分之一，与"
    "「尽可能全面地生成所有剧情所需的服装」这条要求直接矛盾。"
)

#: 兜底占位阶段的名字。一键成片/首帧链路在"角色一张定妆图都没有"时会补建这样
#: 一行来挂图（见 jobs._plan_default_stages 的调用点），它不含任何造型信息。
_PLACEHOLDER_STAGE = "默认造型"


def _is_placeholder_stage(st: AssetStage) -> bool:
    """是否为"兜底占位"阶段（可被真正的造型规划取代）。

    判定：名字是「默认造型」、description 空、且没有镜头级 shot 区间。
    这三条同时成立只可能出自自动补建的兜底路径——用户/AI 真规划出来的阶段
    一定带 description（会喂进生图提示词），变体一定带 shot 区间。
    """
    return (st.stage_name == _PLACEHOLDER_STAGE
            and not (st.description or "").strip()
            and st.shot_from is None and st.shot_to is None)


def _clip_ep_ranges(rows: list[dict], blocked: set[int]) -> list[dict]:
    """把基础阶段的集区间裁掉已被"受保护阶段"占用的集，必要时拆成多段。

    受保护阶段（已出图、且不是兜底占位）的集区间不可被本次规划覆盖，否则同一集
    会出现两条基础阶段，`_auto_inject_refs` 就得在两条等价候选里瞎猜。
    这里对每条规划区间求「可用集」的连续段：全被占 → 丢弃该条；部分被占 → 拆段
    （每段继承同样的 stage_name/description）。
    """
    out: list[dict] = []
    for r in rows:
        avail = [e for e in range(r["ep_from"], r["ep_to"] + 1) if e not in blocked]
        if not avail:
            continue
        runs: list[list[int]] = []
        for e in avail:
            if runs and e == runs[-1][1] + 1:
                runs[-1][1] = e
            else:
                runs.append([e, e])
        for a, b in runs:
            out.append({**r, "ep_from": a, "ep_to": b})
    return out


@router.post("/stages/draft")
async def stages_draft(body: StageDraftIn) -> dict:
    """全剧服装识别 → 造型阶段落库（HTTP 入口，同步等结果）。

    长剧建议走 `costume_scan` job（有进度、可关窗口），本入口留给资产页的
    「✨ AI 识别造型」按钮和既有调用方。
    """
    # 与批量生图互斥。识别会**删掉所有无图阶段行**再重建，而 asset_batch
    # 正在往这些行写 image_url —— 行被删掉后，已生成（已付费）的图就成了
    # 孤儿，用户看到绿勾和空槽位。
    # jobs 侧的 _EXCLUSIVE_GROUPS 只管 job 之间；本接口是同步 HTTP，
    # 不经 find_active_job，所以必须在这里自己挡一次。
    from ..jobs import find_active_job
    from .. import charge
    busy = find_active_job("asset_batch", body.project_id, None)
    if busy:
        raise HTTPException(
            status_code=409,
            detail="资产批量生图正在进行中，此时重新识别造型会删掉正在写入的阶段行。"
                   "请等待生图完成或先停止该任务。",
        )
    # 文本操作按次收。放在 409 之后：被互斥挡掉的请求一分不花。
    charge.charge_sync("costume_scan", {"project_id": body.project_id},
                       desc="服装识别", project_id=body.project_id)
    return await run_stages_draft(body.project_id, body.model_id, body.priors)


async def run_stages_draft(project_id: str, model_id: str | None = None,
                           priors: Optional[dict[str, str]] = None,
                           progress_cb=None) -> dict:
    """全剧服装识别 → 造型阶段落库。

    识别本体在 `app/costumes.py`（逐集并发扫描 + 完整性复查，见该模块头部说明）。
    这里只负责把识别结果**增量地**落进 `asset_stages`，规则三条：

    1. **已出图的阶段一律不删不改区间**（用户的钱已经花在那张图上）。本次规划只在
       它没占用的集/镜头上做增量；唯一例外是"兜底占位阶段"
       （`_is_placeholder_stage`），它没有任何造型信息，会被真正的规划取代，
       图继承过去不浪费。
    2. **同一件衣服只有一张图**。同角色同衣服名在相隔很远的镜头段各出现一次时，
       只有第一段是"源"，其余段建成指针行（`source_stage_id`）共用源那张图。
       已出图的行天然优先当源。
    3. **场景绑定原样落库**（`location` + `scene_bound`）。注入时它是一整个优先级
       档位：剧本明写的镜号变体 > 场景绑定服装 > 基础阶段 > 角色通用图，
       其中场景绑定档**不看集区间**——"第 1 集卧室白色睡衣，第 10 集同一个卧室
       剧本没写衣着"就是靠这一档沿用同一张图的。

    `progress_cb(pct, note)`：0-100 的粗粒度进度（归一 → 逐集识别 → 落库），
    供 `jobs.run_costume_scan` 往 job 上报；HTTP 入口不传。

    **纯文本调用，不生成任何图片**（识别只决定"有哪些造型"，出图是另一步，
    由用户在生产检查弹窗里看过报数再点）。
    """
    from ..costumes import recognize_costumes

    def _p(pct: int, note: str = "") -> None:
        if progress_cb:
            try:
                progress_cb(pct, note)
            except Exception:  # noqa: BLE001 上报进度失败不影响识别
                logger.debug("[stages_draft %s] progress_cb 抛错，忽略", project_id)

    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        if not (proj.optimized_script or proj.raw_script):
            raise HTTPException(status_code=400, detail="项目没有剧本，请先导入")

    # ---- 角色名归一 + **写穿到资产层**（2026-10-12）----
    #
    # 用户裁定：造型识别是拆解的**固定能力**，不该要用户去点。同理，角色归一
    # 也不能只在别处写映射表——`recognize_costumes` 读的是 `adult_canonical_map`，
    # 映射不在的话同一个人的两种写法各建一套造型；而资产行是拆解按**原名**
    # 建好的，不写穿它，画面里仍是多个人的脸。
    #
    # ⚠️ **必须先于下面 `kept` 的加载**。`kept` 按 `character_name` 分组，是
    #    "已出图的阶段受保护、本次只做增量"的依据。若在改名之后才加载，旧名那批
    #    保护行就与新规划的名字对不上 → 保护失效 → 重跑识别可能覆盖用户已花钱
    #    出的图。顺序反了不报错，只会在某些项目上悄悄多花钱。
    #
    # 整段失败不阻断：归一只是"省几张图"，识别本身照跑。
    _p(2, "角色名归一中")
    try:
        from ..char_alias import apply_character_aliases, canonicalize_characters
        await canonicalize_characters(project_id, model_id)
        with get_session() as session:
            info = apply_character_aliases(session, project_id)
            session.commit()
        if info.get("renamed"):
            logger.info("[stages_draft %s] 角色资产收敛：改名 %d、合并 %d 行、"
                        "因已有内容而跳过 %d 个名字",
                        project_id, len(info["renamed"]), len(info["merged"]),
                        len(info["skipped_touched"]))
    except Exception as e:  # noqa: BLE001 归一失败退回"不归一"，识别照跑
        logger.warning("[stages_draft %s] 角色归一/资产收敛失败，按原名继续: %r",
                       project_id, e)

    with get_session() as session:
        # 既有的"已出图"阶段按角色归档。**不整个角色跳过**（那曾是一个真实 bug：
        # 角色只要出过一张图，造型规划就被永久冻结，于是每个角色永远只有一张资产图）。
        # 保护的本意只是"别把用户已花钱出图的阶段删掉/改区间"，那是**改写**；
        # 而**新增**阶段并不冒犯这条。
        # 墓碑阶段不进 kept：它既不该被"保护"（用户就是要它消失），也不该占集区间
        # 让规划避开——那会让重跑识别后照旧缺一段造型，且用户看不出为什么。
        kept: dict[str, list[dict]] = {}
        for s in (stage_gate.alive(
                  session.query(AssetStage)
                  .filter(AssetStage.project_id == project_id,
                          AssetStage.image_url.isnot(None)))
                  .order_by(AssetStage.ep_from).all()):
            kept.setdefault(s.character_name, []).append({
                "id": s.id, "stage_name": s.stage_name,
                "ep_from": s.ep_from, "ep_to": s.ep_to,
                "shot_from": s.shot_from, "shot_to": s.shot_to,
                "image_url": s.image_url,
                "placeholder": _is_placeholder_stage(s),
            })

    # 场景归一必须先于服装识别：识别时要让模型用**归一场景名**回填 scene 字段，
    # 否则"同一个场景"根本判不出来（实测 22 个场景名跨集复用率为 0）。
    # 幂等、且人工改过的映射不会被覆盖，所以每轮都跑无副作用。
    from ..scenes import canonicalize_scenes
    _p(3, "场景归一中")
    try:
        scene_info = await canonicalize_scenes(project_id, model_id)
    except Exception as e:  # noqa: BLE001 归一失败退回确定性清洗，不阻断识别
        logger.warning("[stages_draft %s] 场景归一失败，按原名处理: %r",
                       project_id, e)
        scene_info = {"scenes": [], "updated": 0, "llm": False}

    _p(15, "逐集扫描服装")

    def _scan_progress(done: int, total: int) -> None:
        # 逐集识别占 15-90：这一段最久（每集一次 LLM 调用），进度必须动起来
        _p(15 + int(75 * done / max(1, total)), f"已扫描 {done}/{total} 集")

    try:
        plan = await recognize_costumes(project_id, model_id, priors,
                                        progress_cb=_scan_progress)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"AI 识别失败: {e!r}")

    # ⚠️ 动库之前先确认方案是完整的。
    #
    # 下面的重建是「先无条件删除所有无图阶段，再按 plan 写回」。
    # 如果 LLM 这次全线失败（限流/超时/服务抖动），plan 会是空的 ——
    # 删除照常执行，重建循环遍历空列表，结果就是用户点了一下
    # 「AI 识别造型」，整套已规划好的造型阶段和指针行全没了，
    # 接口还返回 200「识别完成」。
    #
    # 单集失败也不行：那样重建出来的方案缺了几集，同样是用残缺覆盖完整。
    failed_eps = plan.get("failed_episodes") or []
    if failed_eps:
        raise HTTPException(
            status_code=502,
            detail=(f"第 {', '.join(map(str, failed_eps[:8]))} "
                    f"{'等 ' + str(len(failed_eps)) + ' 集' if len(failed_eps) > 8 else '集'}"
                    "识别失败，已中止以免覆盖现有造型方案。请稍后重试。"),
        )
    if not (plan.get("base") or plan.get("variants")):
        raise HTTPException(
            status_code=502,
            detail="AI 未识别出任何造型，已中止以免清空现有方案。请检查剧本内容或稍后重试。",
        )

    _p(92, "写入造型阶段")

    max_ep = plan["max_ep"]
    base_by_char: dict[str, list[dict]] = {}
    var_by_char: dict[str, list[dict]] = {}
    for r in plan["base"]:
        base_by_char.setdefault(r["character"], []).append(r)
    for r in plan["variants"]:
        var_by_char.setdefault(r["character"], []).append(r)

    created = 0
    variants = 0
    bound = 0                       # 场景绑定服装数（跨集沿用同一张图的那批）
    followers = 0                   # 指针行数（复用同衣图，不额外出图）
    reused = 0                      # 继承了兜底占位图的新阶段数（省下的生图钱）
    locked_names: set[str] = set()  # 有受保护阶段、本次只做增量的角色
    with get_session() as session:
        # 只清无图的阶段，保留已出图的（那条时间线不被覆盖）。
        # 指针行也一并清掉——它没有自己的图，重算成本为零，留着反而会指向已删的源。
        #
        # ⚠️ `deleted_at.is_(None)`：**墓碑必须留着**。一个被用户删掉的无图阶段
        # 若在这里被真删，「已删除」组里的恢复入口就跟着消失了——用户点一次
        # 「服装识别」，之前删掉的东西就再也撤销不回来（软删白软了）。
        session.query(AssetStage).filter(
            AssetStage.project_id == project_id,
            AssetStage.deleted_at.is_(None),
            AssetStage.image_url.is_(None)).delete()

        for name in sorted(set(base_by_char) | set(var_by_char)):
            mine = kept.get(name, [])
            holders = [k for k in mine if k["placeholder"]]      # 可被取代的兜底行
            locked = [k for k in mine if not k["placeholder"]]   # 受保护，不动
            if locked:
                locked_names.add(name)
            # 受保护的**基础**阶段（无 shot 区间）占掉的集，本次不再规划基础阶段；
            # 受保护的变体只占几个镜头，不封整集，所以不进 blocked。
            blocked = {e for k in locked
                       if k["shot_from"] is None and k["shot_to"] is None
                       for e in range(k["ep_from"], k["ep_to"] + 1)}
            # 已出图的变体签名，用于去重（同一件衣服同一段镜头不重复建、不重复烧钱）
            var_seen = {(k["stage_name"], k["shot_from"], k["shot_to"])
                        for k in mine if k["shot_from"] is not None
                        or k["shot_to"] is not None}
            # 同衣服的"源"登记表：已出图的行天然优先当源（图已经在它身上）
            owner: dict[str, str] = {}
            for k in mine:
                owner.setdefault(k["stage_name"], k["id"])

            # ---- 基础阶段 ----
            # ⚠️ `follow_name` 必须原样带过来（2026-10-12）：它是
            # `costumes._merge_base` 标出的"本段与首段是同一件衣服"，
            # 下面据此建指针行。这里只挑固定几个键，漏掉它这套机制就整个失效
            # ——而且失效是**静默的**（照旧各出一张图，没有任何报错），
            # 正是这次要修的那个缺陷本身复发。
            base = [{"stage_name": r["stage_name"], "ep_from": r["ep_from"],
                     "ep_to": min(r["ep_to"], max_ep),
                     "description": r["description"],
                     "follow_name": r.get("follow_name")}
                    for r in sorted(base_by_char.get(name, []),
                                    key=lambda x: x["ep_from"])
                    if r["ep_from"] <= max_ep]
            # 避让受保护阶段占用的集。全被占的角色 base 会变成空——这时兜底占位行
            # 必须留着，否则该角色会一张图都没有。
            base = _clip_ep_ranges(base, blocked)
            for st in base:
                # 继承兜底占位图：占位行本来就没有造型信息，它那张图对新基础阶段
                # 同样适用。一个占位图只继承给一条新阶段。
                inherit = next((h for h in holders if not h.get("_used")
                                and h["ep_from"] <= st["ep_to"]
                                and h["ep_to"] >= st["ep_from"]), None)
                if inherit is None:
                    inherit = next((h for h in holders if not h.get("_used")), None)
                if inherit is not None:
                    inherit["_used"] = True
                    reused += 1
                # 同一件衣服的后续段落 → 指针行，共用首段那张图（2026-10-12）。
                #
                # `follow_name` 由 `costumes._merge_base` 标出：同角色同归一键的
                # 第二段起。合并只能消掉相邻段，角色换了别的衣服再换回来时
                # （白大褂 ep1-3 → 羽绒服 → **白大褂** ep9-11）两段不相邻，
                # 此前各建一行、各自出图，同一件白大褂在成片里长成两个样子。
                #
                # ⚠️ 源必须是**本次真的落库了**的那一段（`owner` 里有），
                #    否则指针会指向一个不存在的 id。首段被受保护阶段挤掉时
                #    （`_clip_ep_ranges` 裁空）owner 里就没有它，这时本段
                #    退回当源自己出图 —— 宁可多出一张图，也不能指向空。
                sid = uuid.uuid4().hex[:12]
                follow_src = None
                fname = st.get("follow_name")
                if fname:
                    cand = owner.get(fname)
                    # `owner` 里记的可能是**同名的变体行**，那也是同一件衣服，
                    # 可以共用（与变体侧 `owner.get(stage_name)` 同一口径）。
                    if cand and cand != sid:
                        follow_src = cand
                session.add(AssetStage(
                    id=sid, project_id=project_id,
                    character_name=name, stage_name=st["stage_name"],
                    ep_from=st["ep_from"], ep_to=st["ep_to"],
                    description=st["description"], status="draft",
                    # 指针行**不带图**：带了就会被子系统和用户当成一套独立造型
                    # （readiness 会跳过它、resolve_stage_image 才去查源）。
                    image_url=(None if follow_src else
                               (inherit["image_url"] if inherit else None)),
                    source_stage_id=follow_src,
                ))
                if follow_src:
                    followers += 1
                else:
                    owner.setdefault(st["stage_name"], sid)
                created += 1
            # 占位行只在真被取代（本次为该角色写下了基础阶段）时才删；否则留着，
            # 不能让角色因为一次规划失手变成"零定妆图"。
            if base:
                for h in holders:
                    old = session.get(AssetStage, h["id"])
                    if old is not None:
                        session.delete(old)

            # ---- 服装变体 ----
            # 排序保证"源"先落库、指针行后落库（follow=False 优先），
            # 否则指针会指向一个还不存在的 id。
            for st in sorted(var_by_char.get(name, []),
                             key=lambda x: (bool(x["follow"]),
                                            x["shot_from"] or 0)):
                key = (st["stage_name"], st["shot_from"], st["shot_to"])
                if key in var_seen:
                    continue          # 同一件衣服同一段镜头已出图，不重复建
                src = owner.get(st["stage_name"])
                # follow=True（同衣的后续镜头段）或该衣服已有源 → 建指针行共用图
                is_follower = bool(st["follow"]) or src is not None
                sid = uuid.uuid4().hex[:12]
                session.add(AssetStage(
                    id=sid, project_id=project_id,
                    character_name=name, stage_name=st["stage_name"],
                    ep_from=max(1, min(st["ep_from"], max_ep)),
                    ep_to=max(1, min(max(st["ep_from"], st["ep_to"]), max_ep)),
                    shot_from=st["shot_from"], shot_to=st["shot_to"],
                    description=st["description"], status="draft",
                    source_stage_id=src if is_follower else None,
                ))
                if not is_follower:
                    owner[st["stage_name"]] = sid
                else:
                    followers += 1
                created += 1
                variants += 1
        # 一镜只归一套（2026-10-31）：识别出的变体按镜号叠在基础造型上，这里统一理顺成互不重叠
        # 的分段——重叠处按「镜号区间窄的优先」，与改规则之前出片的挑法一致。
        from ..stage_coverage import normalize
        session.flush()
        for name in sorted(set(base_by_char) | set(var_by_char)):
            normalize(session, project_id, name)
        session.commit()
    return {
        "created": created,
        "variants": variants,
        # 「按场景生效」已去掉（2026-10-31），恒为 0；键保留给老前端
        "scene_bound": 0,
        # 指针行数：与别的阶段是同一件衣服，共用图、不额外出图（省下的生图钱）
        "followers": followers,
        "reused_images": reused,
        # 扫描覆盖面：逐集并发扫了几段（用于向用户证明没有截断剧本）
        "episodes_scanned": plan["scanned"],
        # 归一后的场景数（同一个物理空间跨集只算一个）
        "scenes": len(scene_info.get("scenes") or []),
        # 语义：不是"整个角色被跳过"，而是"这些角色有已出图的阶段被保留，
        # 本次只在它没覆盖的集/镜头上做增量"
        "skipped_with_image": sorted(locked_names),
    }



class StageCandidatesIn(BaseModel):
    n: int = 4
    model_id: Optional[str] = None


@router.post("/stages/{stage_id}/candidates")
async def stage_candidates(stage_id: str, body: StageCandidatesIn) -> dict:
    """⚠️ **已被取代，新代码不要用**：候选定妆图请走 job 化的
    `POST /v2/assets/candidates` + `GET /v2/assets/candidates`。

    这是**同步版**：在一次 HTTP 请求里等所有图出完才返回。缺点致命——出 4 张要
    一两分钟，期间请求挂着、关掉弹窗就丢结果、任务抽屉里看不见、失败了什么也没留下。
    job 化那条路解决了以上全部，现网页端用的就是它。

    保留原因**只有一个**：桌面客户端自带前端产物（`frontendDist: "../dist"`），
    已安装的旧 Beta 里跑的是调这条路由的旧代码。删掉 = 那些用户的资产弹窗当场报错，
    而他们只能靠自己去点「检查更新」才能拿到新前端（S2 已经吃过这个教训）。
    所以它只是**兼容层**，不再是功能入口：

      · 前端包装 `api.stageCandidates` 已删除，`desktop/src` 里不应再出现它；
      · 不要给这条路由加新能力（换模型/排除图/张数上限之类）—— 加了只会让
        "候选图到底走哪条路"重新变成两个答案。复审误判就是这么来的，见
        `docs/AUDIT-2026-09-11-全面复审.md` 的 U6。

    与批量生图同口径：该角色**别的阶段**已有图时喂进去做参考，否则同一个人
    换个造型就换张脸。本阶段自己的图排除在外（拿它当参考等于原地复制）。
    """
    with get_session() as session:
        st = session.get(AssetStage, stage_id)
        if st is not None:
            # 归属校验（2026-10-09）。放在原判空**之前**的 if 里：
            # 不存在仍走下面那条带解释的 404，存在但不是你的也是 404。
            access.req_stage(session, stage_id)
        if not st:
            raise HTTPException(status_code=404,
                                detail=stage_gate.describe_missing(stage_id))
        # 已删除的阶段不给生候选图：那是**花钱**的操作，而出来的图无处可去
        # （PATCH 会被墓碑校验挡掉）。让用户先恢复。
        if st.deleted_at:
            raise HTTPException(status_code=409,
                                detail="该造型阶段已删除，请先恢复再生成候选图")
        # 同步出候选图：按张数先扣（确定价）。放在全部前置校验之后——
        # 上面两条 404/409 都不该扣用户的钱。
        from .. import charge
        charge.charge_sync("asset_candidates",
                           {"project_id": st.project_id, "n": 4},
                           desc="候选定妆图", project_id=st.project_id)
        prompt = (f"角色定妆照, {st.character_name}, {st.stage_name}, "
                  f"{st.description or ''}, 全身, 正面, 高质量, 短剧风格, 纯色背景")
        from ..asset_ref import character_base_ref
        base = character_base_ref(session, st.project_id, st.character_name,
                                  exclude_stage_ids={stage_id})
    provider = ImageProvider(model_id=body.model_id)
    try:
        urls = await provider.generate(prompt, n=max(1, min(body.n, 9)),
                                       ref_urls=[base] if base else None)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"候选图生成失败: {e!r}")
    return {"urls": urls, "prompt": prompt, "ref_used": base}
