"""造型覆盖的唯一规则：**一个镜头只归一套造型**（2026-10-31 用户裁定）。

## 规则

- 一套造型覆盖的镜头 = 第 `ep_from`–`ep_to` 集里的镜头；给了镜号区间（全剧镜号）就只覆盖区间内的。
- 同一角色的在用造型**两两不重叠**。新建 / 修改 / 恢复一套造型时，它**接管**自己的范围，
  与它重叠的旧造型自动**让出**这部分（裁短；被从中间切开时，后一段建成指针行共用同一张图；
  整套都被接管时打墓碑，可恢复）。
- 不再有「按场景生效」：`location` / `scene_bound` 不参与任何判断，写入时清空。
- 没被任何造型覆盖的镜头，用**资产页卡片上那张图**兜底（`card_image`）。

此前的规则是「多套同时覆盖时更具体的生效」：用户无法从界面上判断某一镜到底用哪套
（两套各覆盖三镜里的两镜，中间那镜归谁？），而且「睡衣·卧室」这类按场景跨集生效的
造型会在用户看不到的地方压过按集设的造型。

## 实现

所有写入都落到 `rebuild()`：给定一个「这一镜归谁」的判定函数，按集 / 镜重算出互不重叠的分段，
再把分段写回造型行。分段规则：

- 一集里该角色的镜头**全部**归同一套 → 整集归它（不写镜号区间），相邻整集合并成一个集区间；
- 一集被几套分了 → 按连续镜号切成若干段，每段写成「本集 + 镜号区间」；
- 还没拆镜的集（没有镜头）按集归属；
- 一套造型分到多段时，第一段留在原行上，其余各段建成指向它的指针行（同一张图、同一件衣服）。

`claim()`（新的接管）、`normalize()`（把可能重叠的一组造型理顺）、迁移脚本都只是给 `rebuild()`
传不同的判定函数，所以分段与写回只有这一份实现。调用方负责 commit。
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Callable, Optional

from .db import Asset, AssetStage, Project, Shot

log = logging.getLogger(__name__)

#: 判定函数：(集号, 全剧镜号或 None=该集还没有镜头) → 这一处归哪套造型（None = 不归任何一套）
Assign = Callable[[int, Optional[int]], Optional[AssetStage]]


def covers(st: AssetStage, episode: int, order: Optional[int]) -> bool:
    """这套造型是否覆盖第 `episode` 集的第 `order` 镜（order=None：该集还没有镜头，只看集区间）。

    ep_from/ep_to 均为 None 的造型表示"仅供手动引用"，不参与自动注入，
    此处直接返回 False——它不覆盖任何镜头。
    """
    if st.ep_from is None or st.ep_to is None:
        return False
    if not (st.ep_from <= episode <= st.ep_to):
        return False
    if order is None:
        return st.shot_from is None and st.shot_to is None
    if st.shot_from is not None and order < st.shot_from:
        return False
    if st.shot_to is not None and order > st.shot_to:
        return False
    return True


def _alive(session, project_id: str, character: str) -> list[AssetStage]:
    from . import stage_gate
    return (stage_gate.alive(session.query(AssetStage)
                             .filter(AssetStage.project_id == project_id,
                                     AssetStage.character_name == character))
            .order_by(AssetStage.ep_from, AssetStage.id).all())


def _specific_first(stages: list[AssetStage]) -> list[AssetStage]:
    """重叠存量的裁决顺序（只用于理顺历史数据）：带镜号区间的、区间窄的优先，其次集区间窄的。"""
    def key(st):
        has = st.shot_from is not None or st.shot_to is not None
        width = ((st.shot_to - st.shot_from) if (st.shot_from is not None and st.shot_to is not None)
                 else 10 ** 6)
        return (0 if has else 1, width, st.ep_to - st.ep_from, st.ep_from)
    return sorted(stages, key=key)


def owner_of(stages: list[AssetStage], episode: int, order: Optional[int]) -> Optional[AssetStage]:
    """在一组造型里找覆盖这一处的那套。规则保证至多一套；存量还没理顺时按 `_specific_first` 裁决。"""
    hit = [st for st in stages if covers(st, episode, order)]
    if len(hit) <= 1:
        return hit[0] if hit else None
    return _specific_first(hit)[0]


def max_episode(session, project_id: str) -> int:
    import json
    proj = session.get(Project, project_id)
    eps = json.loads(proj.episodes) if proj and proj.episodes else []
    top = session.query(Shot.episode).filter(Shot.project_id == project_id).order_by(Shot.episode.desc()).first()
    return max(len(eps), top[0] if top else 0, 1)


def _segments(session, project_id: str, stages: list[AssetStage], assign: Assign) -> dict[str, list[dict]]:
    """按判定函数算出每套造型分到的段：{stage_id: [{ep_from, ep_to, shot_from, shot_to}]}。

    原本写了镜号区间的造型，即使分到了整集也仍写成镜号区间（用户圈的是这几镜，
    以后这一集插进来的新镜头不该自动归它）；原本按集的造型分到整集时写成集区间。
    同一套造型相邻的段会合并。
    """
    by_shot = {st.id for st in stages if st.shot_from is not None or st.shot_to is not None}
    shots: dict[int, list[int]] = {}
    for o, e in (session.query(Shot.order, Shot.episode).filter(Shot.project_id == project_id)
                 .order_by(Shot.order).all()):
        shots.setdefault(e, []).append(o)
    allo = sorted(o for v in shots.values() for o in v)
    nxt = {allo[i]: allo[i + 1] for i in range(len(allo) - 1)}     # 全剧镜号里紧跟着的下一镜
    top = max([max_episode(session, project_id)] + [st.ep_to for st in stages if st.ep_to < 900])
    out: dict[str, list[dict]] = {st.id: [] for st in stages}
    run_owner: Optional[str] = None          # 上一个「整集」段的归属，用来合并相邻整集
    for ep in range(1, top + 1):
        orders = shots.get(ep) or []
        if not orders:
            w = assign(ep, None)
            pieces = [(w, None, None)]
        else:
            owners = [assign(ep, o) for o in orders]
            if all((x.id if x else None) == (owners[0].id if owners[0] else None) for x in owners):
                pieces = [(owners[0], None, None)]
            else:
                pieces, cur, start = [], owners[0], orders[0]
                for i in range(1, len(orders)):
                    if (owners[i].id if owners[i] else None) != (cur.id if cur else None):
                        pieces.append((cur, start, orders[i - 1]))
                        cur, start = owners[i], orders[i]
                pieces.append((cur, start, orders[-1]))
        for w, a, b in pieces:
            if w is None:
                run_owner = None
                continue
            if a is None and orders and w.id in by_shot:
                a, b = orders[0], orders[-1]
            segs = out.setdefault(w.id, [])
            last = segs[-1] if segs else None
            if a is None and run_owner == w.id and last and last["shot_from"] is None \
                    and last["ep_to"] == ep - 1:
                last["ep_to"] = ep
            elif a is not None and last and last["shot_from"] is not None and run_owner == w.id \
                    and last["shot_to"] is not None and a == nxt.get(last["shot_to"]):
                last["ep_to"], last["shot_to"] = ep, b
            else:
                segs.append({"ep_from": ep, "ep_to": ep, "shot_from": a, "shot_to": b})
            run_owner = w.id
    # 覆盖到最后一集的整集段，原来写的是「一直到最后」（ep_to 超出现有集数）就照旧保留，
    # 以后新加的集仍归它
    for st in stages:
        segs = out.get(st.id) or []
        if segs and st.ep_to > top and segs[-1]["shot_from"] is None and segs[-1]["ep_to"] == top:
            segs[-1]["ep_to"] = st.ep_to
    return out


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _label(st: AssetStage) -> str:
    if st.ep_from is None or st.ep_to is None:
        return f"「{st.stage_name}」手动引用（不限集）"
    rng = f"第{st.ep_from}集起" if st.ep_to >= 900 else (
        f"第{st.ep_from}集" if st.ep_from == st.ep_to else f"第{st.ep_from}–{st.ep_to}集")
    if st.shot_from is not None or st.shot_to is not None:
        rng += f" #{st.shot_from if st.shot_from is not None else ''}–#{st.shot_to if st.shot_to is not None else ''}"
    return f"「{st.stage_name}」{rng}"


def rebuild(session, project_id: str, character: str, assign: Assign,
            stages: Optional[list[AssetStage]] = None, keep: Optional[AssetStage] = None) -> list[str]:
    """按 `assign` 重写该角色全部在用造型的范围，使之互不重叠。返回给人看的改动说明。

    `keep`：调用方刚建 / 刚改的那一套。它一段都没分到时不打墓碑而是报错——
    「新的接管」却什么都没接管到，说明它的范围里一镜都没有（例如镜号写错），应当让调用方知道。
    """
    stages = stages if stages is not None else _alive(session, project_id, character)
    before = {st.id: (st.ep_from, st.ep_to, st.shot_from, st.shot_to) for st in stages}
    segs = _segments(session, project_id, stages, assign)
    notes: list[str] = []
    followers_of: dict[str, list[AssetStage]] = {}
    for st in stages:
        if st.source_stage_id:
            followers_of.setdefault(st.source_stage_id, []).append(st)
    for st in stages:
        mine = segs.get(st.id) or []
        # 第一段优先选「整集」段：原行若原本没写镜号区间，就尽量保持它不带镜号
        mine.sort(key=lambda s: (s["shot_from"] is not None, s["ep_from"], s["shot_from"] or 0))
        if not mine:
            if keep is not None and st.id == keep.id:
                raise ValueError(f"造型{_label(st)}的范围里没有任何镜头或集，什么都没有覆盖到")
            # 整套被别的造型接管：打墓碑（可恢复）。它若是别人的图源，把图交给第一个还在用的跟随者
            heirs = [f for f in followers_of.get(st.id, []) if segs.get(f.id)]
            if heirs:
                heir = heirs[0]
                if not heir.image_url and st.image_url:
                    heir.image_url = st.image_url
                heir.source_stage_id = st.source_stage_id
                for f in heirs[1:]:
                    f.source_stage_id = heir.id
            st.deleted_at = _now()
            notes.append(f"{_label(st)}的范围已全部被接管，这套造型已移到「已删除」（可恢复）")
            continue
        first, rest = mine[0], mine[1:]
        st.ep_from, st.ep_to = first["ep_from"], first["ep_to"]
        st.shot_from, st.shot_to = first["shot_from"], first["shot_to"]
        st.location, st.scene_bound = None, 0
        src = st.source_stage_id or st.id
        for seg in rest:
            session.add(AssetStage(
                id=uuid.uuid4().hex[:12], project_id=project_id, character_name=character,
                stage_name=st.stage_name, ep_from=seg["ep_from"], ep_to=seg["ep_to"],
                shot_from=seg["shot_from"], shot_to=seg["shot_to"], status=st.status,
                source_stage_id=src))
        if (st.ep_from, st.ep_to, st.shot_from, st.shot_to) != before[st.id] or rest:
            if keep is None or st.id != keep.id:
                notes.append(f"「{st.stage_name}」让出了重叠部分，现在是 {len(mine)} 段：" + "、".join(
                    (f"第{s['ep_from']}集" if s["ep_from"] == s["ep_to"] else f"第{s['ep_from']}–{s['ep_to']}集")
                    + (f" #{s['shot_from']}–#{s['shot_to']}" if s["shot_from"] is not None else "")
                    for s in mine))
    session.flush()
    return notes


def claim(session, st: AssetStage) -> list[str]:
    """`st`（刚建 / 刚改 / 刚恢复，已 add 到 session）接管它的范围；重叠的旧造型让出。返回改动说明。"""
    st.location, st.scene_bound = None, 0
    # 无集数造型（2026-11-04，仅供手动 @ 引用）：它不覆盖任何镜头，也就谈不上接管，
    # 直接返回。**必须在这里短路**——否则 rebuild(keep=st) 会因为"一段都没分到"
    # 抛 ValueError（那是给"填了集数却一镜都没命中"的错配置用的），
    # 于是"集数留空"这个功能从入口就建不出来。
    if st.ep_from is None or st.ep_to is None:
        return []
    others = [x for x in _alive(session, st.project_id, st.character_name) if x.id != st.id]

    def assign(ep, order):
        if covers(st, ep, order):
            return st
        return owner_of(others, ep, order)
    return rebuild(session, st.project_id, st.character_name, assign, stages=others + [st], keep=st)


def normalize(session, project_id: str, character: str) -> list[str]:
    """把该角色可能重叠的造型理顺（服装识别、合并资产、批量建造型之后调用）。

    重叠处按「镜号区间窄的 > 集区间窄的」裁决——与改规则之前的出片挑法一致，所以已有镜头用的图不变。
    """
    stages = _alive(session, project_id, character)
    if not overlaps(stages):
        for st in stages:
            st.location, st.scene_bound = None, 0
        return []
    return rebuild(session, project_id, character, lambda ep, o: owner_of(stages, ep, o), stages=stages)


def overlaps(stages: list[AssetStage]) -> list[tuple[AssetStage, AssetStage]]:
    """两两重叠的造型对（规则成立时为空）。"""
    out = []
    for i, a in enumerate(stages):
        for b in stages[i + 1:]:
            if a.ep_from > b.ep_to or b.ep_from > a.ep_to:
                continue
            a_lo, a_hi = a.shot_from, a.shot_to
            b_lo, b_hi = b.shot_from, b.shot_to
            if (a_lo is None and a_hi is None) or (b_lo is None and b_hi is None):
                out.append((a, b))
                continue
            lo = max(x for x in (a_lo, b_lo, -10 ** 9) if x is not None)
            hi = min(x for x in (a_hi, b_hi, 10 ** 9) if x is not None)
            if lo <= hi:
                out.append((a, b))
    return out


def card_image(session, project_id: str, character: str) -> Optional[str]:
    """资产页角色卡片上显示的那张图 = 没被任何造型覆盖的镜头用的兜底图（2026-10-31 用户裁定）。

    与前端 `imgOf` 同一口径：有造型图时取「基础造型」（不带镜号区间、集最早的那套）的图，
    没有就取第一套有图的造型；一套造型图都没有时才用角色资产自己的图。
    """
    from .costumes import resolve_stage_image
    stages = _alive(session, project_id, character)
    # 「第一套」按镜号排（同集多套逐镜造型时）：与界面看到的顺序一致。按 id 排是随机串，
    # 同一集里 5 套逐镜造型会挑中第 4 套，卡片与出片对不上（2026-11-01 生产 413 处）。
    stages = sorted(stages, key=lambda st: (st.ep_from, st.shot_from if st.shot_from is not None else -1, st.id))
    with_img = [(st, resolve_stage_image(session, st)) for st in stages]
    with_img = [(st, u) for st, u in with_img if u]
    if with_img:
        base = next(((st, u) for st, u in with_img if st.shot_from is None and st.shot_to is None), with_img[0])
        return base[1]
    a = (session.query(Asset).filter(Asset.project_id == project_id, Asset.kind == "character",
                                     Asset.name == character, Asset.deleted_at.is_(None)).first())
    return (a.image_url or None) if a else None
