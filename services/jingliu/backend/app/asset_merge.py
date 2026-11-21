"""合并同一项目里的多个**资产行**（用户 2026-10-16 需求）。

## 它解决什么

拆解按剧本里的**写法**建资产行，于是同一个实体常被拆成好几行：

    「陆明」/「陆医生」/「小陆」        → 三行角色资产、三张定妆图
    「楚家公馆-客厅」/「夜 内 楚家公馆-客厅」→ 两行场景资产、两个房间长不一样

用户在要素页勾选它们、点「合并选中」，收敛成一行。

## 三条硬规矩（都是被数据模型逼出来的）

**① 造型按 `character_name` 认行，不按 `Asset.id`。**
`AssetStage` 与 `Asset` 之间**没有外键**（全库无 FK），连接键是名字字符串。
所以"把造型跟着搬过去"的唯一干净做法是复用 `rename_asset_everywhere` ——
它那条 `UPDATE asset_stages SET character_name = new WHERE ... = old` 会
**原地改名**，行 id 不变，于是版本历史（`asset_image_versions.target_id`
指向 stage.id）、指针链（`source_stage_id`）、火山私域人像库缓存全部无痛保留。

**② 软删，不 `session.delete`。**
既有的两条收敛路径（`scenes.reconcile_location_assets`、
`char_alias.apply_character_aliases`）都是真删，不可逆。这里一律走墓碑
（`deleted_at`），与 `asset_gate` / `stage_gate` 同一套语义：断链、不显示、
但仍可恢复。用户裁定（2026-10-16）：重叠造型里输的那个也软删。

**③ 区间冲突必须让用户裁决，不能自动选。**
把 A 的造型并到 B 名下后，B 可能拥有两套覆盖同一集数的**基础**造型。
此时 `jobs._rank()` 给两条都打同一档，`next(...)` 取排序稳定性的第一条
—— **静默随机选一套**。`stage_scene.py` 里 `restore_stage` 的注释原文就在防
这个状态："悄悄恢复出两套并存的造型，生图时只能随机选一套"。
所以预演必须把冲突摆出来，由用户点掉输的那个。

## ⚠️ 软删逼出来的两个连带修正

**a) 墓碑不能与被留行同名。** 详见 `asset_rename.rename_asset_everywhere`
的 `assets=False` 参数说明：同名墓碑会让 `asset_gate.deleted_names` 把
**在用的那一行也报成"已删除"**，该角色突然不出参考图且无任何报错。
这里靠 `assets=False`（保留墓碑原名）+ `deleted_names` 的同名过滤双保险。

**b) 场景多视角图必须跟着搬。** `SceneView` 是全库**唯一按 `asset_id` 关联**
的资产表，而既有的 `scenes.reconcile_location_assets` 合并时**不迁移它**
（被删行的 8 张图会变成孤儿）。本模块会把它接上 —— 注意 `scene_views` 上有
`(asset_id, view_key)` 唯一索引，所以**不能直接把行搬过去**（留存行通常已有
同名 view_key 的占位行，会撞唯一键），必须"填进留存行缺图的那些视角"。
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone

from . import stage_gate
from .db import Asset, AssetStage, CharacterAlias, SceneView, Shot, desc_of

log = logging.getLogger(__name__)

#: 能合并的 kind。`custom` 不参与：它没有注入链路，合并它没有意义。
MERGEABLE = ("character", "location", "prop")

#: 合并进留存行时按顺序**补空位**的列（留存行已有的值一律不覆盖）。
#: 不覆盖是硬规矩：留存行的图/描述可能是用户手工换过的。
_FILL_COLS = ("image_url", "voice_url", "profile_json", "prompt", "board_url")
#: 私域人像库缓存跟着图走：留存的图换了，这组 id 就作废。
_VOLC_COLS = ("volc_asset_id", "volc_asset_status", "volc_asset_src")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# 判据：留哪一行
# ---------------------------------------------------------------------------

def keep_rank(a: Asset, kind: str) -> tuple:
    """合并时「留哪一行」的排序键（越小越优先留）。

    与 `scenes._keep_rank` / `char_alias._char_keep_rank` 同款理由：
    **墓碑不能赢** —— 否则同组里用户还在用的那行会被墓碑合并掉，资产凭空消失。

    其后按 kind 分：
      · character：音色 → 形象档案 → 有图 → 有描述
        （音色排最前：用户上传的，丢了要重新录，比一张能重新生成的定妆图珍贵）
      · location：有图 → 有设定板 → 有描述
      · prop：有图 → 有描述

    ⚠️ 判据必须是**模块级、预览与执行共用**。两处各写一遍的话，预览说
    "会保留 A"、实际留下的却是 B —— 而这个动作用户看不到第二次。
    """
    if kind == "character":
        return (a.deleted_at is not None,
                not bool((a.voice_url or "").strip()),
                not bool(getattr(a, "profile_json", None)),
                not bool(a.image_url),
                not bool(desc_of(a)))
    if kind == "location":
        return (a.deleted_at is not None,
                not bool(a.image_url),
                not bool(getattr(a, "board_url", None)),
                not bool(desc_of(a)))
    return (a.deleted_at is not None,
            not bool(a.image_url),
            not bool(desc_of(a)))


# ---------------------------------------------------------------------------
# 镜头引用索引（判断"这一行是不是真的没人用"）
# ---------------------------------------------------------------------------

def _shot_index(session, project_id: str, kind: str) -> dict[str, int]:
    """`{名字: 引用它的镜头数}`。

    用来标出"合并后这个名字在剧本里一次都不出现"的行 —— 那种行是**幽灵**
    （拆解改过稿、或本来就是误建的），合并时可以直接丢，不用心疼。
    """
    out: dict[str, int] = {}
    shots = session.query(Shot).filter(Shot.project_id == project_id).all()

    def _arr(raw):
        try:
            v = json.loads(raw or "[]")
            return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []
        except (ValueError, TypeError):
            return []

    def _ov(sh):
        try:
            v = json.loads(sh.ref_overrides) if sh.ref_overrides else {}
            return v if isinstance(v, dict) else {}
        except (ValueError, TypeError):
            return {}

    def _bump(nm: str) -> None:
        nm = (nm or "").strip()
        if nm:
            out[nm] = out.get(nm, 0) + 1

    # 场景要先过一遍归一（`Shot.location` 存原名、资产存归一名）。
    # ⚠️ `canonical_map` 在循环里调用是 O(镜头数 × 查库)，这里提到循环外。
    cmap: dict[str, str] = {}
    if kind == "location":
        from .scenes import canonical_map
        cmap = canonical_map(session, project_id, shots=shots)

    for sh in shots:
        if kind == "character":
            for c in set(_arr(sh.characters)) | set(
                    _arr(getattr(sh, "present_characters", None))):
                _bump(c)
            for c in _ov(sh).get("add", []) or []:
                if isinstance(c, str):
                    _bump(c)
        elif kind == "prop":
            for p in set(_arr(sh.props)):
                _bump(p)
        else:
            if sh.location:
                raw = sh.location.strip()
                _bump(cmap.get(raw, raw))
            for c in _ov(sh).get("add_loc", []) or []:
                if isinstance(c, str):
                    _bump(cmap.get(c, c))
    return out


# ---------------------------------------------------------------------------
# 造型
# ---------------------------------------------------------------------------

def _stage_conflict(a: AssetStage, b: AssetStage) -> bool:
    """两套造型是不是"覆盖同一段、只能留一套"。

    **刻意复用 `routers.stage_scene._stage_shot_conflict`**，不在这里重写：
    那个函数是 patch / restore / merge 三处共用的唯一定义，注释里就写着
    "各写一份必然漂移（一边允许场景变体共存、另一边不允许）"。这里的代价比
    保存失败隐蔽得多 —— 是"生图时随机选一套造型"。
    """
    from .routers.stage_scene import _stage_shot_conflict
    return _stage_shot_conflict(a, b)


def _stage_label(st: AssetStage) -> str:
    from .routers.stage_scene import _stage_range_label
    label = _stage_range_label(st)
    loc = (st.location or "").strip()
    return f"{label} @{loc}" if loc else label


def _stage_groups(session, project_id: str, names: list[str]) -> dict[str, list]:
    """按 `character_name` 取出这些名字名下的**在用**造型行。"""
    if not names:
        return {}
    rows = stage_gate.alive(
        session.query(AssetStage)
        .filter(AssetStage.project_id == project_id,
                AssetStage.character_name.in_(names))).all()
    out: dict[str, list] = {}
    for r in rows:
        out.setdefault(r.character_name, []).append(r)
    return out


def _conflict_pairs(rows: list[AssetStage]) -> list[tuple[AssetStage, AssetStage]]:
    pairs = []
    for i, a in enumerate(rows):
        for b in rows[i + 1:]:
            if a.ep_from <= b.ep_to and b.ep_from <= a.ep_to and _stage_conflict(a, b):
                pairs.append((a, b))
    return pairs


def _stage_keep_key(st: AssetStage) -> tuple:
    """冲突里「留哪一套」的排序键（越小越优先留）。**确定性、可解释、可预演**。

    为什么必须确定：两套造型盖同一段镜头时，注入会随机选一套
    （见 `_stage_conflict`）。所以合并时必须裁决，而裁决规则若不确定，
    预览说的和实际留下的就会不同 —— 用户看不到第二次。

    排序：
      ① **有定妆图** —— 有图的丢掉，下次出片就得重新生成，那是真金白银；
      ② 覆盖**镜头更多** —— 覆盖 20 镜的造型比覆盖 1 镜的更可能是"主造型"；
      ③ `ep_from` 更早 —— 先入为主，与 `keep_rank` 的哲学一致；
      ④ `shot_from` 为空优先 —— 基础造型（不限镜号）比镜头级变体更该留；
      ⑤ id 兜底 —— 保证全序，避免 `sort` 在并列时依赖输入顺序。
    """
    lo, hi = st.shot_from, st.shot_to
    width = (hi - lo) if (lo is not None and hi is not None) else 10 ** 6
    return (
        not bool((st.image_url or "").strip()),   # 有图优先
        -int(width),                                # 覆盖更广优先
        int(st.ep_from),
        lo is not None,                             # 基础造型优先（无镜号区间）
        str(st.id),
    )


def _conflict_groups(conflicts: list[dict]) -> list[set[str]]:
    """冲突图的连通分量（每个分量是一组互相牵连的造型 id）。"""
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for c in conflicts:
        ra, rb = find(c["a"]["id"]), find(c["b"]["id"])
        if ra != rb:
            parent[ra] = rb
    groups: dict[str, set[str]] = {}
    for x in list(parent):
        groups.setdefault(find(x), set()).add(x)
    return list(groups.values())


def check_stage_drops(conflicts: list[dict], drop_ids: set[str]) -> str | None:
    """校验一组丢弃决定。合法返回 None，否则返回一句**指名道姓**的人话。

    ## 规则（2026-10-21 改）

    旧规则是"**每一对恰好丢一套**"。它对两套之间的冲突没问题，但三套两两冲突
    （A~B、B~C、A~C，dev 实测 2 例）时在数学上**无解** —— 等价于给三角形做
    二着色：无论怎么选，总有一对两侧同时被丢或同时被留。用户每一处都点了、
    永远提交不了，报错还在说"还有 N 处没选"。

    新规则描述的才是真正想要的结果：
      ① **留下的造型之间不能还有冲突**（每一对至少丢一套）——
         否则注入时随机选一套，这是合并存在的理由；
      ② **每组互相牵连的冲突至少留一套** —— 否则那段镜头一套造型都没了。
    三角形留 1 丢 2 合法；两套之间丢 1 合法；全丢、全留都不合法。
    """
    for c in conflicts:
        if c["a"]["id"] not in drop_ids and c["b"]["id"] not in drop_ids:
            return (f"还有未裁决的造型冲突：「{c['a']['name']}」与「{c['b']['name']}」"
                    f"都留着，它们覆盖同一段（{c['a']['label']}），请丢掉其中一套")
    names = {}
    for c in conflicts:
        for side in ("a", "b"):
            names[c[side]["id"]] = c[side]["name"]
    for g in _conflict_groups(conflicts):
        if g <= drop_ids:
            shown = "、".join(f"「{names.get(x, x)}」" for x in sorted(g))
            return f"{shown} 这一组冲突里的造型全被丢弃了，至少要留一套"
    return None


def suggest_stage_drops(conflicts: list[dict], rows_by_id: dict) -> set[str]:
    """按 `_stage_keep_key` 给出**一定合法**的丢弃建议。

    每个冲突组内按优先级从高到低贪心：与已留下的都不冲突就留，否则丢。
    结果是一个极大独立集 —— 满足 `check_stage_drops` 的两条规则，
    三角形也有解（留最好的一套，丢另两套）。
    """
    adj: dict[str, set[str]] = {}
    for c in conflicts:
        a, b = c["a"]["id"], c["b"]["id"]
        adj.setdefault(a, set()).add(b)
        adj.setdefault(b, set()).add(a)
    drop: set[str] = set()
    for g in _conflict_groups(conflicts):
        kept: set[str] = set()
        for sid in sorted(g, key=lambda x: _stage_keep_key(rows_by_id[x])):
            if adj.get(sid, set()) & kept:
                drop.add(sid)
            else:
                kept.add(sid)
    return drop


# ---------------------------------------------------------------------------
# 场景
# ---------------------------------------------------------------------------

def _canon(session, project_id: str, name: str | None) -> str:
    from .scenes import canonical_of
    return canonical_of(session, project_id, name) or (name or "").strip()


def _redir_location_refs(session, project_id: str, old: str, new: str) -> dict:
    """把场景名 `old` 的**资产侧引用**重指到 `new`。返回 {表名: 改动数}。

    ⚠️ **刻意不用 `rename_asset_everywhere`**（虽然它有个 location 分支）。
    它会把 `Shot.location` 一起改掉 —— 而场景是"镜头留原名、资产在归一名"
    两个名字空间，改镜头等于抹掉 `SceneAlias` 那座桥
    （`scenes.reconcile_location_assets` 的注释讲过同一件事）。这里只动资产侧。

    处理两张表：
      · `AssetStage.location`（造型绑定的场景，可跨集沿用的服装）
      · `SceneAnchor.location/canonical`（该归一场景全剧唯一的基准帧）
    """
    from .db import SceneAnchor

    counts: dict[str, int] = {}

    n = (session.query(AssetStage)
         .filter(AssetStage.project_id == project_id,
                 AssetStage.location == old)
         .update({AssetStage.location: new}, synchronize_session=False))
    if n:
        counts["asset_stages.location"] = n

    # 锚点有 `(project_id, canonical)` 唯一索引，不能无脑 UPDATE：
    # 若 new 已经有一张锚点，直接把 old 那张改过去会撞唯一键、整笔事务失败。
    # 这种时候保留 new 已有的那张（它才是留存场景自己生成好的基准帧），
    # old 那张只把 location 字段改成 new 以便追溯，canonical 置空 ——
    # canonical 为空的行不再参与"按归一名找锚点"，等于体面退役。
    old_rows = (session.query(SceneAnchor)
                .filter(SceneAnchor.project_id == project_id,
                        (SceneAnchor.canonical == old)
                        | (SceneAnchor.location == old)).all())
    taken = {(r.canonical or "") for r in
             session.query(SceneAnchor)
             .filter(SceneAnchor.project_id == project_id,
                     SceneAnchor.canonical == new).all()}
    moved = 0
    for r in old_rows:
        if (r.canonical or "") == old and new in taken:
            r.canonical = None          # 留存场景已有基准帧，这条退役
            r.location = new
        else:
            if (r.canonical or "") == old:
                r.canonical = new
                taken.add(new)
            if (r.location or "") == old:
                r.location = new
        moved += 1
    if moved:
        counts["scene_anchors"] = moved
    return counts


def _move_scene_views(session, project_id: str, keep_id: str,
                      drop_ids: list[str]) -> int:
    """把被合并场景的多视角图接到留存行上。返回接过去的张数。

    ⚠️ **不能直接把行搬过去**：`scene_views` 上有 `(asset_id, view_key)` 唯一
    索引，而留存行通常已经有同一 `view_key` 的占位行（`ensure_views` 按代码
    定义固定建 8 行），改 `asset_id` 会撞唯一键。所以规则是**填留存行缺图的
    那些视角**；留存行已经有图的视角不动（那是它自己生成好的图）。
    """
    keep_rows = {v.view_key: v for v in
                 session.query(SceneView)
                 .filter(SceneView.project_id == project_id,
                         SceneView.asset_id == keep_id).all()}
    moved = 0
    for v in (session.query(SceneView)
              .filter(SceneView.project_id == project_id,
                      SceneView.asset_id.in_(drop_ids)).all()):
        if not v.image_url:
            continue
        tgt = keep_rows.get(v.view_key)
        if tgt is None:
            v.asset_id = keep_id          # 留存行没有这个视角 → 整行搬过去
            keep_rows[v.view_key] = v
            moved += 1
        elif not tgt.image_url:
            # 留存行有这个视角但是空的 → 把图填进去（不搬行，避免撞唯一键）
            tgt.image_url = v.image_url
            if not tgt.prompt:
                tgt.prompt = v.prompt
            if not tgt.qc_json:
                tgt.qc_json = v.qc_json
            moved += 1
    return moved


def _redirect_scene_aliases(session, project_id: str, from_canon: str,
                            to_canon: str,
                            extra_raws: list[str] | None = None) -> int:
    """把"归一后是 `from_canon`"的所有写法重指到 `to_canon`。返回改了几条。

    用户勾选两个场景名合并，本质就是**断言"这是同一个地方"** —— 那正是
    `SceneAlias` 存在的意义，所以这里写的是 `source='manual'`（AI 重跑归一
    不会覆盖人工判断，见 `scenes.set_alias`）。

    ⚠️ `from_canon` 自身**无条件**写一条，不看"现在有没有镜头用它"。
    只按"当前有引用的名字"去重指会漏掉两种情况，而两种都是静默丢图：
      · 用户之后又加了一镜在这个场景（或改稿把名字写回来）；
      · `ref_overrides.add_loc` 里手写过的那个名字。
    用户已经断言过"是同一个地方"，这条断言就该落成一条持久的映射，
    而不是只在"恰好有镜头在用"时才补。

    `extra_raws`：被并资产的**原始行名**。它与 `from_canon` 常常不同
    （原名可能是「夜 内 楚家公馆-客厅」而归一名是「楚家公馆-客厅」），
    两个写法都要重指，否则旧写法仍会落回一个已经没有资产行的名字。
    """
    from .scenes import canonical_map, set_alias
    cmap = canonical_map(session, project_id)
    raws = {from_canon, *(extra_raws or [])}
    for raw, can in cmap.items():
        if can == from_canon and raw:
            raws.add(raw)
    n = 0
    for raw in sorted(r for r in raws if r and r != to_canon):
        if set_alias(session, project_id, raw, to_canon, source="manual"):
            n += 1
    return n


# ---------------------------------------------------------------------------
# 预演
# ---------------------------------------------------------------------------

def plan(session, project_id: str, ids: list[str], as_stages: bool = False) -> dict:
    """**只算不写**。返回展示给用户的预演，以及能不能合并。

    调用方负责把 `blockers` 非空翻成 409/400。`keep_rank` 与 `apply_merge`
    共用，所以预演说会留哪一行、实际就留哪一行。
    """
    ids = list(dict.fromkeys(ids))          # 去重保序
    rows = [session.get(Asset, i) for i in ids]
    if any(r is None for r in rows):
        return {"ok": False, "blockers": ["部分资产不存在"], "missing": [
            i for i, r in zip(ids, rows) if r is None]}
    rows = [r for r in rows if r is not None]
    if len(rows) < 2:
        return {"ok": False, "blockers": ["至少选中 2 个资产才能合并"]}

    kinds = {r.kind for r in rows}
    projects = {r.project_id for r in rows}
    if len(projects) > 1:
        return {"ok": False, "blockers": ["只能合并同一个项目里的资产"]}
    if len(kinds) > 1:
        return {"ok": False, "blockers": [
            "只能合并同一类资产（角色归角色、场景归场景、道具归道具）"]}
    kind = kinds.pop()
    if kind not in MERGEABLE:
        return {"ok": False, "blockers": [f"「{kind}」这类资产不支持合并"]}

    blockers: list[str] = []
    warnings: list[str] = []

    alive_rows = [r for r in rows if not r.deleted_at]
    if len(alive_rows) != len(rows):
        blockers.append("所选里有已删除的资产，请先恢复或取消勾选再合并")
    if len(alive_rows) < 2:
        blockers.append("至少要有 2 个未删除的资产")

    # ---- 角色：年龄阶段不能合并 ----
    #
    # ⚠️ 判据是「**阶段不同**才拦」，不是「带了年龄阶段就拦」（2026-10-28 用户报障）。
    #
    # 报障原话：「围观村民（深灰夹克中年男）」与「深灰夹克中年男」被判成
    # "带年龄阶段，代表长相不同的同一个人"而拒绝合并 —— 可这两条根本是**同一个
    # 人名的两种写法**（全称与简写），别名表里两条的 age_stage 都是「中年」。
    # 旧判据只看 `age_stage` 有没有值，于是任何被归一识别过的角色都**永远合并不了**，
    # 实测全库 43 行 CharacterAlias 里有 age_stage 的都会被拦。
    #
    # 现在的判据：
    #   · 两条同属一个人（按 canonical 分组）且**阶段相同** → 允许合并
    #     （它们的差别由造型承载，见 `_age_stage_to_stage`）
    #   · 阶段**不同**（少年 vs 中年）→ 仍然拦。合并会让两者共用一张脸，
    #     而"把不同年龄段转成造型阶段"还没上线（方案见 PLAN 3.2）。
    #   · 认不出是不是同一个人（没有 alias 行）→ 保守拦下，与旧行为一致。
    skipped_age: list[str] = []
    if kind == "character":
        names = {(r.name or "").strip() for r in alive_rows}
        age_rows = (session.query(CharacterAlias)
                    .filter(CharacterAlias.project_id == project_id,
                            CharacterAlias.raw_name.in_(names)).all())
        by_name = {r.raw_name: r for r in age_rows}
        #: 归一到同一个人、且阶段相同 → 只差写法，可以合并
        same_entity = True
        stages: set[str] = set()
        for n in names:
            row = by_name.get(n)
            if row is None or not (row.age_stage or "").strip():
                # 这一条没有映射信息：判不了"是不是同一个人"，保守拦下
                same_entity = False
                continue
            stages.add((row.age_stage or "").strip())
            # canonical 各写各的也算判不了（老数据里 raw==canonical 很常见）
            if (row.canonical or "").strip() not in ("", n) and \
                    (row.canonical or "").strip() not in names:
                same_entity = False
        if len(stages) > 1:
            same_entity = False
        if age_rows and not same_entity:
            skipped_age = sorted({r.raw_name for r in age_rows
                                  if (r.age_stage or "").strip()})
        if age_rows and len(stages) == 1 and same_entity:
            # 同一个人、同一个阶段：允许合并。差别（各有各的图/描述）在
            # `apply_merge` 里落成一条造型阶段，而不是丢掉。
            warnings.append(
                "这几条是同一个人的不同写法（年龄阶段相同），可以合并；"
                "被并的那条若有自己的图或描述，会落成该角色名下的一条造型")
        if skipped_age and as_stages:
            # 用户（或 AI 复审）明确要「转成造型」：不同年龄段/不同造型的写法
            # 并进同一张卡，各自的样子落成镜号区间造型（`_age_stage_to_stage`）。
            # 用户 2026-10-28 裁定：这是造型阶段该解决的事，应该合并。
            warnings.append(
                "「" + "」「".join(skipped_age) + "」会按各自出场的镜头区间，"
                "转成留存角色名下的造型阶段——合并后不会丢掉各自的样子")
            skipped_age = []
        if skipped_age:
            # 「少年陆明」与「陆明」是同一人、不同长相，各自出图才对
            # （`CharacterAlias.age_stage` 的设计意图）。合并会让两者共用一张脸。
            blockers.append(
                "以下角色带年龄阶段，代表**长相不同**的同一个人，不能合并："
                + "、".join(f"「{x}」" for x in skipped_age))

    # ---- 场景：归一名不一致要明说（但**不拦**）----
    if kind == "location":
        canons = sorted({_canon(session, project_id, r.name) for r in alive_rows})
        if len(canons) > 1:
            # 不拦：用户勾选就是在断言"这是同一个地方"，那正是 manual 别名的用途。
            # 但必须说清 —— 合并后原本那批镜头会改用留存行的图。
            warnings.append(
                "所选场景归一后不是同一个地方（" + "、".join(f"「{c}」" for c in canons)
                + "）。合并会把它们当作同一个地方，原本挂在前者的镜头改用留存行的图。")

    if len(alive_rows) < 2:
        return {"ok": False, "blockers": blockers, "kind": kind}

    # ---- 留哪一行 ----
    alive_rows.sort(key=lambda a: keep_rank(a, kind))
    keep = alive_rows[0]
    drops = alive_rows[1:]

    idx = _shot_index(session, project_id, kind)

    def _refs(nm: str) -> int:
        return idx.get((nm or "").strip(), 0)

    out: dict = {
        "ok": not blockers, "kind": kind, "blockers": blockers,
        "warnings": warnings,
        "keep": {"id": keep.id, "name": keep.name, "image_url": keep.image_url,
                 "has_voice": bool((keep.voice_url or "").strip()),
                 "shot_refs": _refs(keep.name)},
        "drops": [{"id": d.id, "name": d.name, "image_url": d.image_url,
                   "has_voice": bool((d.voice_url or "").strip()),
                   "shot_refs": _refs(d.name),
                   # 剧本里一次都没出现 → 真幽灵，合并没有信息损失
                   "ghost": _refs(d.name) == 0} for d in drops],
        "stages": None, "scene_views": None,
    }

    # ---- 造型（只有角色有）----
    if kind == "character":
        names = [(r.name or "").strip() for r in alive_rows]
        groups = _stage_groups(session, project_id, names)
        per_name, all_rows = [], []
        for r in alive_rows:
            nm = (r.name or "").strip()
            lst = groups.get(nm, [])
            per_name.append({"name": nm, "count": len(lst),
                             "with_image": sum(1 for s in lst if s.image_url)})
            all_rows.extend(lst)
        pairs = _conflict_pairs(all_rows)
        conflict_ids: set[str] = set()
        conflicts = []
        rows_by_id = {r.id: r for r in all_rows}
        for a, b in pairs:
            conflict_ids.add(a.id)
            conflict_ids.add(b.id)
            conflicts.append({
                "a": {"id": a.id, "name": a.stage_name, "label": _stage_label(a),
                      "from": a.character_name, "image_url": a.image_url},
                "b": {"id": b.id, "name": b.stage_name, "label": _stage_label(b),
                      "from": b.character_name, "image_url": b.image_url},
            })
        #: 自动裁决建议（见 `suggest_stage_drops`）。这不是"跳过约束"——
        #: 每组冲突仍然只留互不冲突的造型，只是先按可解释的规则替用户选好，
        #: 他一次确认即可。建议**一定**能通过 `check_stage_drops`。
        auto_drop = suggest_stage_drops(conflicts, rows_by_id)
        for c in conflicts:
            a_id, b_id = c["a"]["id"], c["b"]["id"]
            c["suggest_drop"] = [x for x in (a_id, b_id) if x in auto_drop]
            c["suggest_keep"] = next((x for x in (a_id, b_id) if x not in auto_drop), None)
        auto_drop = sorted(auto_drop)
        auto_ok = check_stage_drops(conflicts, set(auto_drop)) is None
        out["stages"] = {
            "total": len(all_rows),
            "per_name": per_name,
            "conflicts": conflicts,
            "conflict_stage_ids": sorted(conflict_ids),
            #: 一键采纳时提交的 drop_stage_ids（已去重、顺序稳定）
            "auto_drop_stage_ids": auto_drop,
            #: 一键采纳能否通过 `check_stage_drops`。按构造恒为 True，
            #: 留这个字段是给前端一个硬开关：将来规则变了、建议算错了，
            #: 前端看到 False 就不预选、不给一键，退回人工逐处裁决。
            "auto_ok": auto_ok,
            # 不冲突的都自动跟随留存行（原地改名），用户不必逐条确认
            "clean": len(all_rows) - len(conflict_ids),
            # 合并后这个名字会变（= 留存行的名字），界面要写清楚
            "target_name": (keep.name or "").strip(),
        }
        # 指针行：两条指针指向同一个源，合并后 = 同角色两条指着同一张图，
        # 既不报错也没有意义。罕见（全库 31 条），但说一句比不说好。
        pointed: dict[str, list[str]] = {}
        for st in all_rows:
            src = (st.source_stage_id or "").strip()
            if src:
                pointed.setdefault(src, []).append(st.id)
        if any(len(v) > 1 for v in pointed.values()):
            warnings.append("有造型指向同一张图（共用造型），合并后不会自动去重，"
                            "如需处理请到造型页")

    # ---- 场景多视角（只有场景有）----
    if kind == "location":
        keep_views = (session.query(SceneView)
                      .filter(SceneView.project_id == project_id,
                              SceneView.asset_id == keep.id).all())
        have = {v.view_key for v in keep_views if v.image_url}
        drop_ids = [d.id for d in drops]
        movable = 0
        for v in (session.query(SceneView)
                  .filter(SceneView.project_id == project_id,
                          SceneView.asset_id.in_(drop_ids)).all()):
            if v.image_url and v.view_key not in have:
                have.add(v.view_key)      # 同一次里不重复计数
                movable += 1
        out["scene_views"] = {
            "keep_with_image": len(have),
            "move_count": movable,
        }
        if movable:
            warnings.append(f"被合并的场景上有 {movable} 张多视角图会转过来"
                            "（既有的场景归一脚本不会做这件事，这里补上）")

    return out


def _stage_segments(session, project_id: str, old: str, target: str) -> tuple[list[tuple[int, int]], list[int]]:
    """被并写法 `old` 的出场镜头切成若干**连续段**，返回 `(段列表, 与 target 同镜的镜号)`。

    段的切法：按全剧镜号排序，**只要中间夹着一个 target 出场的镜头就断开**。
    例：少年江卫东 48-50、成年江卫东 47 与 51 —— 段是 48-50，不能扩成 47-51，
    否则成年那两镜也会被套上少年的脸。没有 target 出场的空镜可以并进同一段
    （造型只作用于该角色在场的镜头，空镜无所谓）。
    """
    from .db import Shot

    def _arr(raw):
        try:
            v = json.loads(raw or "[]")
            return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []
        except (ValueError, TypeError):
            return []

    mine: list[int] = []
    theirs: list[int] = []
    both: list[int] = []
    for s in (session.query(Shot).filter(Shot.project_id == project_id)
              .order_by(Shot.order).all()):
        chars = set(_arr(s.characters)) | set(_arr(getattr(s, "present_characters", None)))
        a, b = old in chars, target in chars
        if a and b:
            both.append(s.order)
        elif a:
            mine.append(s.order)
        elif b:
            theirs.append(s.order)
    import bisect
    theirs.sort()
    segs: list[tuple[int, int]] = []
    for o in sorted(mine):
        if segs:
            lo, hi = segs[-1]
            # hi 与 o 之间夹着 target 出场的镜头？—— 有就断开，没有就续上
            k = bisect.bisect_right(theirs, hi)
            if not (k < len(theirs) and theirs[k] < o):
                segs[-1] = (lo, o)
                continue
        segs.append((o, o))
    return segs, both


def _age_stage_to_stage(session, project_id: str, target: str, drops: list) -> list[dict]:
    """把被并掉的写法**落成留存角色名下的造型阶段**，返回给用户看的逐条说明。

    ## 为什么

    用户 2026-10-28：「不同年龄段角色的不同造型，这个应该是造型阶段解决的问题
    （应该合并），而不是保留两个资产卡片」，并追问能否识别「同一个人在某几集和
    某几集使用不同造型」。答案就是这里：合并时把那条写法的出场镜头落成一条
    **镜号区间造型**（`stage_pick` 里镜号命中是最高档，天然压过基础造型）。

    ## 造型行怎么建

      · 名字：括号里的词（「傅烬洲（13岁）」→「13岁」），见 `_stage_name_of`
      · 区间：`_stage_segments` 切出来的连续段。**多段就建多行，第一行是源、
        其余是指针行**（`source_stage_id`）—— 同一件衣服/同一张脸全剧只一个样子，
        也只花一次生图钱（这正是指针行的设计用途，见 `db.AssetStage`）
      · 图/描述：带上被并那条自己的；**没有图也照建** —— 一条没图的造型正好
        被「一键补全」认成缺口，自动去生那套造型的图

    ## 什么时候不建、为什么

      · 剧本里找不到它的出场镜头 → 没区间可记
      · 它与留存名**同一镜同时出现** → 那是两个人同时在场，**不是**同一人的两个造型。
        这一条在 `plan(as_stages=True)` 里就会被拦成 blocker，走不到这里；
        这里再判一次只为防御
    """
    out: list[dict] = []
    for r in drops:
        old = (r.name or "").strip()
        if not old or old == target:
            continue
        segs, both = _stage_segments(session, project_id, old, target)
        label = _stage_name_of(old, target)
        if both:
            out.append({"name": old, "created": False,
                        "why": f"与「{target}」在 {len(both)} 个镜头里同时出现，像是两个人，未建造型"})
            continue
        if not segs:
            out.append({"name": old, "created": False,
                        "why": "剧本里没有它的出场镜头，没建造型"})
            continue
        from .db import Shot
        ep_of = {s.order: s.episode for s in
                 session.query(Shot.order, Shot.episode)
                 .filter(Shot.project_id == project_id).all()}
        src_id = None
        for lo, hi in segs:
            st = AssetStage(
                id=uuid.uuid4().hex[:12], project_id=project_id,
                character_name=target, stage_name=label,
                ep_from=int(ep_of.get(lo) or 1),
                ep_to=int(ep_of.get(hi) or ep_of.get(lo) or 1),
                shot_from=lo, shot_to=hi,
                # 源行带图与描述；指针行不带图（注入时解析到源那张）
                image_url=(r.image_url or None) if src_id is None else None,
                description=(desc_of(r) or None),
                source_stage_id=src_id,
                status="draft",
            )
            session.add(st)
            if src_id is None:
                src_id = st.id
        out.append({"name": old, "created": True, "stage_name": label,
                    "segments": [{"shot_from": a, "shot_to": b,
                                  "ep_from": int(ep_of.get(a) or 1),
                                  "ep_to": int(ep_of.get(b) or 1)} for a, b in segs],
                    "has_image": bool(r.image_url)})
    return out


def _stage_name_of(old: str, target: str) -> str:
    """造型名。按优先级：

      ① 括号里的词：「傅烬洲（13岁）」→「13岁」、「围观村民（深灰夹克中年男）」→「深灰夹克中年男」
      ② 去掉留存名后剩下的部分，**至少两个字**：「少年江卫东」→「少年」
      ③ 否则用原名：「小夜繁星」去掉「夜繁星」只剩「小」，一个字看不出是什么（实测），
         直接叫「小夜繁星」更清楚
    """
    import re
    m = re.search(r"[（(【\[]([^）)】\]]+)[）)】\]]", old or "")
    if m and m.group(1).strip():
        return m.group(1).strip()[:40]
    rest = (old or "").replace(target or "", "").strip()
    if len(rest) >= 2:
        return rest[:40]
    return (old or "原写法")[:40]


# ---------------------------------------------------------------------------
# 执行
# ---------------------------------------------------------------------------

def apply_merge(session, project_id: str, ids: list[str],
                keep_id: str | None = None,
                drop_stage_ids: list[str] | None = None,
                as_stages: bool = False) -> dict:
    """**写库**。调用方负责 commit。

    `keep_id`：留哪一行。None = 按 `keep_rank` 自动选（预演已给用户看过）。
    `drop_stage_ids`：区间冲突里**用户点掉的**那些造型（软删）。
    未被裁决的冲突对**直接拒绝** —— 不允许静默留两套并存的造型。

    幂等：再跑一次时被并的行已是墓碑，`plan` 会因"未删除的不足 2 个"而拒绝。
    """
    from .asset_rename import rename_asset_everywhere

    p = plan(session, project_id, ids, as_stages=as_stages)
    if not p["ok"]:
        raise ValueError("；".join(p["blockers"]) or "无法合并")

    kind = p["kind"]
    rows = [r for r in (session.get(Asset, i) for i in dict.fromkeys(ids))
            if r is not None]
    alive_rows = sorted([r for r in rows if not r.deleted_at],
                        key=lambda a: keep_rank(a, kind))
    keep = next((r for r in alive_rows if r.id == keep_id), None) if keep_id else None
    if keep_id and keep is None:
        raise ValueError("keep_id 不在所选的未删除资产里")
    if keep is None:
        keep = alive_rows[0]
    drops = [r for r in alive_rows if r.id != keep.id]
    if not drops:
        raise ValueError("没有需要合并的行")

    stages_moved = 0
    stages_dropped: list[str] = []
    #: 被并写法落成的造型阶段（见 `_age_stage_to_stage`）。非角色恒为空。
    stages_created: list[dict] = []
    views_moved = 0
    #: 走位台账里被改掉的旧角色名处数（2026-10-23）。
    #: **不含提示词正文** —— 正文是模型写下的措辞，按用户 2026-10-23 裁定不动，
    #: 理由见 `asset_rename.rename_asset_everywhere._blocking`。
    blocking_fixed = 0
    aliases_written = 0
    prop_renamed = 0
    target = (keep.name or "").strip()

    # ---- ① 角色：裁决造型冲突 → 把造型整体改名搬过来 ----
    if kind == "character":
        conflict_ids = set(p["stages"]["conflict_stage_ids"])
        drop_stage_ids = set(drop_stage_ids or [])
        if drop_stage_ids - conflict_ids:
            raise ValueError("被点掉的造型里有不在冲突清单中的，请重新预演")
        err = check_stage_drops(p["stages"]["conflicts"], drop_stage_ids)
        if err:
            raise ValueError(err)
        for sid in sorted(drop_stage_ids):
            st = session.get(AssetStage, sid)
            if st is not None and not st.deleted_at:
                st.deleted_at = _now()          # 软删，可恢复
                stages_dropped.append(f"{st.character_name}·{st.stage_name}")

        # 被并的写法若有**自己独有的图或描述**，先落成留存角色名下的造型阶段。
        # ⚠️ 必须在下面的改名**之前**：改名会把镜头里的旧名换成留存名，
        #    之后就再也找不到"这个写法出现在哪几镜"了（区间会算成留存行的全部镜头）。
        #
        # 只在有东西可承载时才做：两条都没图没描述 = 纯写法差异，并完就完了，
        # 不需要多出一条空造型去占区间。
        # `as_stages`（用户/AI 判定"同一个人、不同造型"）时**一律**转：没有图也建，
        # 空图造型会被「一键补全」认成缺口去生那套造型的图。
        if as_stages or any((d.image_url or "").strip() or (desc_of(d) or "").strip()
                            for d in drops):
            stages_created = _age_stage_to_stage(session, project_id, target, drops)
        else:
            stages_created = []

        for r in drops:
            old = (r.name or "").strip()
            if old and old != target:
                # `aliases=False`：别名表是桥，跟着改等于把映射抹掉。
                # `assets=False`：墓碑要保留自己的名字（见模块头 ⚠️ a）。
                _c = rename_asset_everywhere(session, project_id, "character", old,
                                             target, aliases=False, assets=False)
                # 走位台账被改的处数从返回值里取（改名内部逐镜统计）
                blocking_fixed += int((_c or {}).get("shots.blocking_out", 0))
        # bulk update 之后 ORM 身份映射里还是旧名，不 expire 会让下面按新名
        # 分组时漏掉刚改过的那几行 —— 表现为"什么都没发生"且不报错
        for r in alive_rows:
            session.expire(r)
        # 归位后该角色名下**在用**的造型总数（已排除刚软删的那些）
        stages_moved = len(_stage_groups(session, project_id, [target]).get(target, []))

    # ---- ② 场景：重指别名 → 搬多视角图 → 把留存行自身也归一到归一名 ----
    elif kind == "location":
        # ⚠️ 场景资产的 `name` 一律存**归一名**（`Shot.location` 才是原名，
        # 两者由 `SceneAlias` 桥接）。这里必须用归一名当目标，不能拿
        # `keep.name` 直接用：留存行可能本身就是个原名
        # （「夜 内 楚家公馆-客厅」），照原名留下的话，注入按归一名
        # （「楚家公馆-客厅」）去查资产表就查不到它 —— 那个场景静默没图。
        target = _canon(session, project_id, keep.name)
        for d in drops:
            dc = _canon(session, project_id, d.name)
            if not dc or dc == target:
                continue
            # 原始行名与归一名常常不同，两个写法都要重指 —— 只重指归一名的话，
            # 旧写法仍会落回一个已经没有资产行的名字，那些镜头静默丢参考图。
            aliases_written += _redirect_scene_aliases(
                session, project_id, dc, target, extra_raws=[(d.name or "").strip()])
            # 造型绑定的场景、场景锚点也要跟着走。
            # ⚠️ 用 `_redir_location_refs` 而**不是** `rename_asset_everywhere`：
            # 后者会把 `Shot.location` 原名一起改掉，那是两个名字空间，改了等于
            # 抹掉 SceneAlias 那座桥（scenes.py 的注释讲过同一件事）。
            _redir_location_refs(session, project_id, dc, target)
        # 留存行自己的名字也要归一到归一名（同一个理由：注入按归一名查）
        if target and keep.name != target:
            _redir_location_refs(session, project_id, keep.name, target)
            keep.name = target
        views_moved = _move_scene_views(session, project_id, keep.id,
                                        [d.id for d in drops])

    # ---- ③ 道具：只有 Shot.props 一处引用 ----
    else:
        for d in drops:
            old = (d.name or "").strip()
            if old and old != target:
                _c = rename_asset_everywhere(session, project_id, "prop", old, target,
                                             aliases=False, assets=False)
                blocking_fixed += int((_c or {}).get("shots.blocking_out", 0))
                prop_renamed += 1

    # ---- ④ 并行列：只补空位，绝不覆盖 ----
    for d in drops:
        for f in _FILL_COLS:
            if not (getattr(keep, f, None) or "").strip() \
                    and (getattr(d, f, None) or "").strip():
                setattr(keep, f, getattr(d, f))
        for f in _VOLC_COLS:
            if not getattr(keep, f, None) and getattr(d, f, None):
                setattr(keep, f, getattr(d, f))
        # 软删（用户裁定 2026-10-16）：可恢复，且是"用户说过不要它"的唯一表达。
        # 真删的坑写在 asset_gate 模块头：会被三处自动流程原地建回来。
        d.deleted_at = _now()

    # 一镜只归一套（2026-10-31）：两个角色的造型并到一起后可能重叠，理顺成互不重叠的分段
    if kind == "character":
        from .stage_coverage import normalize
        session.flush()
        normalize(session, project_id, keep.name)

    log.info("[merge] %s 合并 %s：留「%s」，并掉 %s"
             "（造型搬 %d / 丢 %d，视图搬 %d，别名重指 %d）",
             project_id, kind, keep.name, [d.name for d in drops],
             stages_moved, len(stages_dropped), views_moved, aliases_written)
    return {
        "ok": True, "kind": kind,
        "keep": {"id": keep.id, "name": keep.name, "image_url": keep.image_url},
        "merged": [d.name for d in drops],
        "stages_moved": max(0, stages_moved),
        "stages_dropped": stages_dropped,
        "views_moved": views_moved,
        "blocking_fixed": blocking_fixed,
        "stages_created": stages_created,
        "aliases_redirected": aliases_written,
        "prop_renamed": prop_renamed,
    }


#: 供调用方判断"这一组能不能合并"，避免为了看一眼而自己拼 plan（会漏判据）
def preview(session, project_id: str, ids: list[str]) -> dict:
    """`plan` 的别名，语义上强调"这是只读预演"。"""
    return plan(session, project_id, ids)
