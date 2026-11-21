"""资产查重：**确定性筛选**的唯一实现（2026-10-28）。

## 这个模块负责什么，不负责什么

| 层 | 职责 | 在这里吗 |
|---|---|---|
| **筛选** | 从全项目资产里挑出"该放在一起看"的候选组 | ✅ 本模块 |
| **判断** | 这组到底是不是同一个实体（尤其「老吴」/「吴先生」） | ❌ 交给 agent 读剧情 |

用户 2026-10-28 的裁定原话：**「agent 完全有实力在对应的剧情中给出正确的判断」**。
所以这里只做**字面证据**能证明的事，不做语义判断 —— 判错会并掉一个真实存在的人。

## 为什么必须独立成模块

这段逻辑原先内联在 `agent.tools_read.find_duplicate_assets` 里，
于是**只有 agent 能调用**，要素页的「一键查重」按钮想用就得重写一份。
本项目已有两次同款教训（`upscale_candidates`、`desub_plan`）：
同一判据写两遍，迟早一处认、一处不认。

现在 agent 工具与 HTTP 路由共用本模块，保证"按钮说 21 组"和"agent 说 21 组"
是同一个数。

## 判据（**保守**，只做高精度的几条）

| 判据 | 例子 | 全库命中 |
|---|---|---|
| 字面同名（去噪后相等） | 「王建国 」vs「王建国」 | 299 组 |
| 括号外同名 | 「黑卡（至尊）」vs「黑卡」 | 38 组 |
| 描述完全相同且非空 | 同一段描述写了两行 | 0 组 |
| 场景：剥场次前缀后相同 | 「夜 内 公馆客厅」vs「公馆客厅」 | 含在上面 |

（实测数据来自 dev 库全量 340 个候选组。）

## ⚠️ 绝对不要加回来的判据

**名字互相包含**。2026-10-27 生产实测：一个项目里「礼盒」⊂ 三十多个不同的
礼盒名（「生日礼盒」「伴手礼盒」…），一次并成 31 个不相干的实体。
「手机」⊂「傅烬洲的手机」∈「尚宇的工作手机」同理 —— 那是**不同个体**，不是重复。
"""
from __future__ import annotations

import re
from collections import defaultdict

from . import asset_gate
from .db import Asset, Shot, desc_of, get_session

#: 能合并的三类。`custom` 不参与（`asset_merge.MERGEABLE` 同口径）。
KINDS = ("character", "location", "prop")

#: 场景名里的场次前缀（「夜 内 」「日/外」「日内」）：归一后再比。
_PREFIX = re.compile(r"^(?:日|夜|晨|黄昏|清晨|傍晚|白天|晚上)\s*[/ 　]?\s*"
                     r"(?:内|外)?\s*[/ 　]?\s*")
#: 噪点字符：空白、间隔号、括号本身、引号。归一后一律不计。
_NOISE = re.compile(r"[\s　·・_\-—（）()【】\[\]「」\"'“”]")
#: 括号及其中内容（「黑卡（至尊会员）」的「（至尊会员）」）。
_PAREN = re.compile(r"[（(【\[][^）)】\]]*[）)】\]]")
#: 同上但**带捕获组**，用来取括号里的内容。两者刻意分开：`_PAREN` 用在 `sub()` 里
#: 剥括号，形状不能改；取内容另建一条，免得为了一处需求把剥括号的行为一起改了。
_PAREN_IN = re.compile(r"[（(【\[](?P<in>[^）)】\]]*)[）)】\]]")

#: 道具分档阈值（引用镜头数）。见 `_prop_tier`。
PROP_LOW_REF_MAX = 3


def _norm(name: str, kind: str) -> str:
    """去噪 +（场景）剥场次前缀后的名字。空名字返回空串。"""
    n = name or ""
    if kind == "location":
        n = _PREFIX.sub("", n)
    return _NOISE.sub("", n)


def _core(raw: str, kind: str) -> str:
    """去掉括号注释、再去噪后的名字（「黑卡（至尊）」→「黑卡」）。

    ⚠️ 必须拿**原始名字**去剥括号：`_norm()` 会把括号本身也当噪声删掉，
    剥完之后是「黑卡至尊会员」，再去括号就没有任何东西可剥了。
    """
    return _norm(_PAREN.sub("", raw or ""), kind)


def _paren(raw: str) -> str:
    """括号里的内容，没有括号返回空串。"""
    m = _PAREN_IN.search(raw or "")
    return m.group("in").strip() if m else ""


def paren_core_same(a: str, b: str, kind: str) -> bool:
    """两条名字是否「只差一个括号注释」——即同一个实体的两种写法。

    ## 为什么不能只比「括号外」

    2026-10-28 用户报障：六个**不同的人**被并成了一组：

        围观村民（深灰夹克中年男）/（军绿外套中年男）/（紫毛衣头巾老年女）…

    它们在括号外全都叫「围观村民」，但那只是龙套的统称，括号里才是区分**个体**的
    东西。同类还有「顾耀东办公室（八年前）」vs「（破败）」「仙露琼浆（蔻兰版）」vs
    「（终极豪华版）」——括号一变就是另一个人/另一个状态/另一个版本。

    ## 判据

    · 两边都有括号且**内容不同** → 不是同一个（剔除）
    · 两边括号相同 → 同一个（保留）
    · **只有一边**有括号 → 「黑卡（至尊会员）」vs「黑卡」，同一个（保留）

    第三种才是这条判据原本要抓的东西：括号是可有可无的补充说明。
    """
    pa, pb = _paren(a), _paren(b)
    if pa and pb:
        return _norm(pa, kind) == _norm(pb, kind)
    return True


def _prop_tier(shot_refs: int, has_image: bool, has_desc: bool) -> str:
    """道具的档位。**只用于排序与默认勾选，不是"重要度评分"。**

    用户 2026-10-28 裁定：低引用道具也默认勾选，「真在乎的他会自己取消」。

      · `ghost`    —— 零引用且无图无描述：拆解改稿留下的空壳
      · `unused`   —— 零引用但有图或有描述
      · `low_ref`  —— 1..3 镜引用
      · `high_ref` —— 4+ 镜引用（贯穿全片，默认不勾）
    """
    if shot_refs <= 0:
        return "ghost" if not (has_image or has_desc) else "unused"
    return "low_ref" if shot_refs <= PROP_LOW_REF_MAX else "high_ref"


def _default_checked(tier: str | None) -> bool:
    """默认勾不勾。道具只有 `high_ref` 不勾；合并组恒为 True。"""
    return tier != "high_ref"


def shot_texts(session, project_id: str, kind: str, names: list[str],
               cap: int = 3000) -> dict[str, str]:
    """这些名字各自**出场镜头的剧本原文**，拼成一段，总长不超过 `cap` 字。

    给「AI 复审」用。为什么按组取而不是给全剧：
    实测（项目 29afad1b，583 镜 / 13 万字正文）单角色出场镜头正文
    **中位数 698 字、P75 2083 字**；而 P90 是 6458 字、P99 是 9.4 万字（长剧主角）。
    所以按组取是可行的，但**必须有上限** —— 否则一个主角就能把上下文撑爆。

    宁可截断也不分片：判"是不是同一个人"看前几场戏通常就够，
    而这个函数服务于一次交互式操作，不能让它变成几十秒的等待。
    """
    shots = (session.query(Shot)
             .filter(Shot.project_id == project_id)
             .order_by(Shot.order).all())
    # ⚠️ 场景资产存的是**归一名**，镜头存的是原名（「夜 内 卧室」vs「卧室」）。
    #    直接比字符串，场景组一个镜头都读不到 —— AI 拿着空白去判"是不是同一个地方"。
    cmap: dict[str, str] = {}
    if kind == "location":
        from .scenes import canonical_map
        cmap = canonical_map(session, project_id, shots=shots)
    out: dict[str, str] = {}
    for nm in names:
        parts: list[str] = []
        used = 0
        for sh in shots:
            if not _mentions(sh, kind, nm, cmap):
                continue
            txt = (sh.script_ref or "").strip()
            if not txt:
                continue
            if used + len(txt) > cap:
                parts.append("…（后续出场略）")
                break
            parts.append(txt)
            used += len(txt)
        out[nm] = "\n".join(parts)
    return out


def _mentions(shot, kind: str, name: str, cmap: dict[str, str] | None = None) -> bool:
    """这一镜是否出现了这个名字。与 `asset_merge._shot_index` 同口径。

    `cmap`：场景的 {原名: 归一名}。场景资产按归一名存，必须先归一再比。"""
    import json

    def _arr(raw):
        try:
            v = json.loads(raw or "[]")
            return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []
        except (ValueError, TypeError):
            return []

    if kind == "character":
        return name in set(_arr(shot.characters)) | set(
            _arr(getattr(shot, "present_characters", None)))
    if kind == "prop":
        return name in set(_arr(getattr(shot, "props", None)))
    raw = (shot.location or "").strip()
    return raw == name or (cmap or {}).get(raw) == name


def _ref_index(session, project_id: str, kind: str) -> dict[str, int]:
    """`{名字: 引用它的镜头数}`。直接复用 `asset_merge._shot_index`。

    不在这里重写：那个函数已经处理了场景归一、`present_characters`、
    `ref_overrides.add` 这些细节，重写一份必然漂移。
    """
    from .asset_merge import _shot_index
    return _shot_index(session, project_id, kind)


def asset_items(session, project_id: str, kind: str) -> list[dict]:
    """某一类的**在用**资产，弹窗 / AI 复审共用的精简形状。

    抽出来是因为 AI 复审要按同一个形状拼它新发现的组 —— 两处各写一份，
    前端就会遇到"机械组有 has_voice、AI 组没有"这种字段不齐。
    """
    rows = asset_gate.alive(
        session.query(Asset).filter(Asset.project_id == project_id,
                                    Asset.kind == kind)).all()
    refs = _ref_index(session, project_id, kind)
    return [{
        "id": a.id, "name": a.name or "",
        "shot_refs": refs.get((a.name or "").strip(), 0),
        "has_image": bool((a.image_url or "").strip()),
        "has_voice": bool((a.voice_url or "").strip()) if kind == "character" else None,
        "desc": (desc_of(a) or "").strip()[:60] or None,
    } for a in rows]


def group_key(kind: str, ids) -> str:
    """组的稳定 key：`kind:排序后的 id`。与前端 `ddGroupKey` 同一个算法。"""
    return f"{kind}:{','.join(sorted(ids))}"


def find_groups(session, project_id: str,
                kinds: list[str] | None = None) -> dict:
    """全项目的查重候选组（**只读**）。

    返回 `{"groups": [...], "stats": {...}}`，组按"用户真看得见的重复"排序：
    有图的、被引用多的排前面。

    每组结构见 `PLAN-资产一键查重.md` 的 5.2。这里额外带上 `tier` /
    `default_checked`（道具）与 `needs_ai`（是否建议走 AI 复审）。
    """
    want = [k for k in (kinds or KINDS) if k in KINDS]
    if not want:
        return {"groups": [], "stats": {"total_assets": 0, "total_groups": 0}}

    groups: list[dict] = []
    total_assets = 0

    for kind in want:
        items = asset_items(session, project_id, kind)
        total_assets += len(items)

        by_id = {x["id"]: x for x in items}

        # 并查集：把两两"字面上像重复"的并成一组
        parent = {x["id"]: x["id"] for x in items}

        def find(a: str) -> str:
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        def union(a: str, b: str) -> None:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra

        reasons: dict[tuple[str, str], set[str]] = defaultdict(set)
        for i, x in enumerate(items):
            for y in items[i + 1:]:
                nx, ny = _norm(x["name"], kind), _norm(y["name"], kind)
                why = None
                if nx and nx == ny:
                    why = "字面同名"
                elif x["desc"] and x["desc"] == y["desc"]:
                    why = "描述完全相同"
                elif nx and ny and _core(x["name"], kind) == _core(y["name"], kind):
                    # 「黑卡（至尊会员）」vs「黑卡」—— 括号里的注释不算名字的一部分。
                    # ⚠️ 不能用"互相包含"，见模块头。
                    # ⚠️ 两边**都有括号却不同**的是不同个体（六个不同的围观村民），
                    #    见 `paren_core_same` 的说明。
                    if paren_core_same(x["name"], y["name"], kind):
                        why = "括号外名字相同"
                if why:
                    union(x["id"], y["id"])
                    reasons[(x["id"], y["id"])].add(why)

        buckets: dict[str, list[dict]] = defaultdict(list)
        for x in items:
            buckets[find(x["id"])].append(x)

        for root, grp in buckets.items():
            if len(grp) < 2:
                continue
            whys: set[str] = set()
            for (a, b), ws in reasons.items():
                if find(a) == root:
                    whys |= ws
            # 有图 / 被引用多的排在组内前面 —— 合并时留哪一行优先看这两条
            grp.sort(key=lambda z: (not z["has_image"], -z["shot_refs"], z["name"]))
            keep = max(grp, key=lambda z: (bool(z["has_image"]), z["shot_refs"]))

            tier = None
            if kind == "prop":
                top = grp[0]
                tier = _prop_tier(top["shot_refs"], top["has_image"], bool(top["desc"]))

            groups.append({
                "kind": kind,
                "reason": "、".join(sorted(whys)) or "疑似重复",
                "assets": grp,
                "suggest_keep": {"id": keep["id"], "name": keep["name"]},
                "tier": tier,
                "default_checked": _default_checked(tier),
                # 括号外同名 = 名字只差一个括号注释，**语义上可能是两回事**
                # （「傅烬洲」vs「傅烬洲（13岁）」）。这类交给 AI 读剧情判断。
                "needs_ai": "括号外名字相同" in whys,
                "verdict": None,
                "verdict_reason": None,
            })

    groups.sort(key=lambda g: (-sum(1 for a in g["assets"] if a["has_image"]),
                               -sum(a["shot_refs"] for a in g["assets"])))
    return {
        "groups": groups,
        "stats": {
            "total_assets": total_assets,
            "total_groups": len(groups),
            "needs_ai": sum(1 for g in groups if g["needs_ai"]),
        },
    }


def prop_delete_candidates(session, project_id: str) -> list[dict]:
    """**不在任何重复组里**、但可以删的道具（高频的不算候选）。

    查重面板除了"合并重复"，另一半诉求是"清掉不重要的道具"。
    两者数据源不同：合并看的是"有没有重复"，删除看的是"有没有用"。
    所以这里单独出一份清单，按引用次数升序 —— 最可能该删的排最前。
    """
    rows = asset_gate.alive(
        session.query(Asset).filter(Asset.project_id == project_id,
                                    Asset.kind == "prop")).all()
    refs = _ref_index(session, project_id, "prop")
    out = []
    for a in rows:
        n = refs.get((a.name or "").strip(), 0)
        has_img = bool((a.image_url or "").strip())
        has_desc = bool((desc_of(a) or "").strip())
        tier = _prop_tier(n, has_img, has_desc)
        if tier == "high_ref":
            continue                      # 贯穿全片的道具不进候选
        out.append({
            "id": a.id, "name": a.name or "",
            "shot_refs": n, "has_image": has_img, "desc": (desc_of(a) or "").strip()[:60] or None,
            "tier": tier, "default_checked": True,
        })
    out.sort(key=lambda x: (x["shot_refs"], not x["has_image"], x["name"]))
    return out
