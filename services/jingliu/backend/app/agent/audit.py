"""三类「只能靠人工发现」的缺陷：判据 + 处置分级（§13）。

用户点名了三类，并说「agent 应该是有希望和能力发现和解决」。它们**不是同一性质**，
混在一起做就会做出一个"看着很能干、实际在乱改"的 agent。所以本模块只做两件事：

  ① 算出**有哪些问题**、每条**能不能安全地自动改**；
  ② 给每个问题一句**人话原因**。

真正的写库动作在工具层（`tools_write` / `tools_audit`），走各自的校验与硬确认。

```
A. 造型跨集继承      现有规则有洞      发现 + 预览修复，人工点过才写库
B. 引用错误          现有机制已能自动修 只报告，绝不重写提示词
C. 台词人名被当在场   判据不存在        发现 + 只报告，改不改由人决定
```

## 三条硬纪律

1. **判据必须复用既有实现**。A 类用 `stage_pick`（与出片注入同一份排序），
   B 类用注入函数本身算出来的真实下发清单，C 类用 `drama_timing` 的说话人解析。
   另写一份"看起来差不多"的实现，必然与线上行为漂移 —— 而漂移的表现是
   "agent 说这套造型没生效、实际生效了"，用户从此不再相信任何一条报告。

2. **能改的只有一类**：上一段是**基础**造型时，可以把它的集区间延长。
   变体 / 场景绑定 / 情境服装一律**只报告**。实测数据支持这条（dev 全库
   28 处掉到通用图里，17 处的上一段是情境服装 —— 无脑补区间会把"掉到通用图"
   变成"穿错衣服"，更糟）。

3. **报告里必须有数量上限**。全库扫一遍可能报出几百条；面板只显示汇总数，
   明细默认折叠。没有上限的明细列表等于没有。
"""
from __future__ import annotations

import json
import logging
import re
import threading

logger = logging.getLogger("fw.agent.audit")

#: 单类明细的返回条数上限（汇总数不受影响，始终是真实总数）。
DETAIL_CAP = 200

#: 情境服装词表 —— **从 `costumes._SITUATIONAL` 取，不抄一份**。
#: 抄一份的后果：`costumes.py` 里加一个词，审计这边不知道，
#: 于是把"机长制服"当成可延长的基础造型建议延长 —— 正是 §13.1 警告的那个错误。


def _situational() -> set[str]:
    from ..costumes import _SITUATIONAL
    return _SITUATIONAL


def _base_key(stage_name: str) -> tuple[str, bool]:
    from ..costume_normalize import extract_base_key
    return extract_base_key(stage_name or "")


def _is_plain_base(st) -> tuple[bool, str]:
    """这套阶段是不是"可以直接延长集区间"的**基础**造型。返回 `(可延长, 原因)`。

    四个条件全中才算基础：没有镜号区间、没绑场景、不是变体、
    归一键不在情境服装表里。任何一条不中 → 只报告不写库。

    为什么这四个条件而不是"看起来像基础"：延长集区间是把这套造型铺到
    更多镜头上，铺错了就是让角色**穿着不该穿的衣服**出现在别的集里。
    而"掉到通用定妆图"顶多是**没有造型**，比穿错衣服轻。
    """
    lo, hi = st.shot_from, st.shot_to
    if lo is not None or hi is not None:
        return False, "它是镜头级变体（有镜号区间），不能用集区间延长"
    if (st.location or "").strip():
        return False, f"它绑定了场景「{st.location}」，跨集沿用要按场景判定"
    key, is_var = _base_key(st.stage_name)
    if is_var:
        return False, f"「{st.stage_name}」是变体造型（湿透/沾血一类），不应外溢"
    if key in _situational():
        return False, f"「{st.stage_name}」是情境服装，出了那个情境就该换回常服"
    return True, ""


# ---------------------------------------------------------------------------
# A 类：造型覆盖（§13.1）
# ---------------------------------------------------------------------------

def audit_stage_coverage(project_id: str, *, episodes: list[int] | None = None,
                         detail_cap: int = DETAIL_CAP) -> dict:
    """逐镜找「有造型、但对这一镜无一适用」的角色。

    ## 判据怎么来的

    直接跑**出片时用的那个函数**（`jobs._auto_inject_refs`），看它这一个镜头
    到底取到了哪些图。取不到的角色 = 注入时掉了下去（通常会回落到角色通用
    定妆图）。这是唯一不会与线上漂移的判据：它算的就是线上那一刻会算的东西。

    ## 为什么还要看"上一段是什么"

    发现"掉了"只是第一步。能不能自动补，取决于上一段造型的性质：
      · 基础造型 → 可以把 `ep_to` 拉到该集（**预览**给用户，点了才写）
      · 变体 / 场景 / 情境 → 只报告，附原因

    后者占实测 17/28，无脑补会让角色穿错衣服。
    """
    from ..db import AssetStage, Project, Shot, effective_characters, get_session
    from .. import asset_gate, stage_gate
    from ..costumes import resolve_stage_image
    from ..scenes import canonical_of

    eps = sorted(set(int(x) for x in (episodes or [])))

    with get_session() as s:
        proj = s.get(Project, project_id)
        if proj is None:
            return {"ok": False, "error": f"项目不存在: {project_id}"}
        q = s.query(Shot).filter(Shot.project_id == project_id,
                                 Shot.disabled == 0)
        if eps:
            q = q.filter(Shot.episode.in_(eps))
        shots = q.order_by(Shot.order).all()
        if not shots:
            # ⚠️ 这个提前返回**必须与下面完整路径的形状一致**。
            # 2026-10-24 生产 500（`GET /v2/audit/overview` → KeyError:
            # 'safe_to_extend'）：这里原来只给了 ok/issues/total/note 四个键，
            # 而 `overview()` 在 `ok=True` 时无条件读 `a["safe_to_extend"]`。
            # 触发条件很窄但很真实——**项目里一镜都没有**时（刚建的项目、
            # 或镜头被全部删掉/重拆中），项目体检面板就会整块炸掉。
            # `get_readiness` 之类的入口又会把它摆在最显眼处，用户一点就 500。
            return {"ok": True, "issues": [], "total": 0, "shots_affected": 0,
                    "safe_to_extend": 0, "report_only": 0,
                    "truncated": False,
                    "note": "这个项目还没有镜头"}

        # 全部角色阶段一次取出，按角色索引（避免逐镜查库）
        stages_all = stage_gate.alive(
            s.query(AssetStage).filter(AssetStage.project_id == project_id)
        ).order_by(AssetStage.ep_from).all()
        by_char: dict[str, list] = {}
        for st in stages_all:
            by_char.setdefault(st.character_name, []).append(st)
        imgs = {st.id: resolve_stage_image(s, st) for st in stages_all}

        gone = asset_gate.deleted_names(s, project_id)

        issues: list[dict] = []
        for sh in shots:
            chars = effective_characters(sh)
            if not chars:
                continue
            shot_canon = canonical_of(s, project_id, sh.location)
            for c in chars:
                if c in gone:
                    continue
                cands = [x for x in by_char.get(c, []) if imgs.get(x.id)]
                if not cands:
                    continue            # 这个角色压根没图：那是"缺图"，不是本类问题
                from .. import stage_pick
                st = stage_pick.pick(cands, episode=sh.episode,
                                     order=sh.order, shot_canon=shot_canon)
                if st is not None:
                    continue            # 本镜有适用造型，正常
                issues.append(_coverage_issue(s, proj, sh, c, by_char.get(c, []),
                                              imgs))

    # 同一角色同一集的多镜聚合成一条 —— 用户要看的是"第 2 集林晚掉了 8 镜"，
    # 不是 8 条一模一样的记录。
    merged = _merge_coverage(issues)
    auto = [x for x in merged if x["safe_to_extend"]]
    return {
        "ok": True,
        "total": len(merged),
        "shots_affected": sum(len(x["shot_orders"]) for x in merged),
        "safe_to_extend": len(auto),
        "report_only": len(merged) - len(auto),
        "issues": merged[:detail_cap],
        "truncated": len(merged) > detail_cap,
        "note": _coverage_note(len(merged), len(auto)),
    }


def _coverage_issue(s, proj, sh, character: str, cands: list, imgs: dict) -> dict:
    """单个 (镜头, 角色) 的诊断：上一段是哪套、能不能延长。"""
    base = None
    for st in sorted(cands, key=lambda x: (x.ep_from, x.ep_to), reverse=True):
        if st.ep_to < sh.episode:
            base = st
            break
    row: dict = {
        "character": character,
        "episode": sh.episode,
        "shot_order": sh.order,
        "shot_id": sh.id,
        "last_stage": None,
        "last_stage_ep": None,
        "safe_to_extend": False,
        "why": "",
    }
    if base is None:
        row["why"] = ("这套角色在前面没有任何造型可用（可能第一阶段从更晚的集才开始），"
                      "需要用户决定它该穿什么")
        return row
    row["last_stage"] = base.stage_name
    row["last_stage_ep"] = [base.ep_from, base.ep_to]
    ok, why = _is_plain_base(base)
    row["safe_to_extend"] = ok
    row["stage_id"] = base.id
    row["why"] = (f"上一段是「{base.stage_name}」（第 {base.ep_from}–{base.ep_to} 集），"
                  f"可以延长到第 {sh.episode} 集" if ok
                  else f"上一段是「{base.stage_name}」：{why}")
    return row


def _merge_coverage(issues: list[dict]) -> list[dict]:
    """按 (角色, 上一段 stage_id) 聚合，保留涉及的集与镜号。"""
    out: dict[tuple, dict] = {}
    for it in issues:
        key = (it["character"], it.get("stage_id") or "")
        cur = out.get(key)
        if cur is None:
            cur = dict(it)
            cur["episodes"] = [it["episode"]]
            cur["shot_orders"] = [it["shot_order"]]
            out[key] = cur
        else:
            if it["episode"] not in cur["episodes"]:
                cur["episodes"].append(it["episode"])
            cur["shot_orders"].append(it["shot_order"])
            # 只要有一条需要人看，整组就按"要人看"处理 —— 安全侧
            cur["safe_to_extend"] = cur["safe_to_extend"] and it["safe_to_extend"]
    rows = list(out.values())
    for r in rows:
        r["episodes"] = sorted(r["episodes"])
        r["shot_orders"] = sorted(r["shot_orders"])
        r.pop("episode", None)
        r.pop("shot_order", None)
        r.pop("shot_id", None)
    rows.sort(key=lambda r: (-len(r["shot_orders"]), r["character"]))
    return rows


def _coverage_note(total: int, auto: int) -> str:
    if total == 0:
        return "没有发现造型覆盖问题"
    if auto == 0:
        return (f"{total} 处角色在本镜没有任何适用造型。全部**不建议自动延长**"
                "（上一段是变体/场景绑定/情境服装），需要用户逐条决定。")
    return (f"{total} 处角色在本镜没有适用造型，其中 {auto} 处的上一段是基础造型、"
            f"可以安全延长；其余 {total - auto} 处只报告，不要自动改。")


# ---------------------------------------------------------------------------
# B 类：引用完整性（§13.2）
# ---------------------------------------------------------------------------

_NUM_REF = re.compile(r"@\s*图\s*片?\s*(\d+)")


def audit_ref_integrity(project_id: str, *, episodes: list[int] | None = None,
                        detail_cap: int = DETAIL_CAP) -> dict:
    """报告 `@图片N` 的三类问题。

    ## 为什么是"报告"而不是"修复"

    `at_refs.remap_image_refs` / `drop_dangling_refs` 已经在出片时逐镜跑过三次纠错，
    它们是**确定性算法**（拿提示词自己的声明纠正自己）。agent 再改写一遍只会
    引入新错；而且这些提示词大多 `prompt_state == "manual"`（用户手改稿），
    碰它就是硬确认路径。

    ## 这里真正有价值的是第三类

    前两类线上已经自动处理了，用户看不到。真正"静默留在提示词里"的是
    **声明了一个不在这镜下发清单里的角色** —— `remap` 对不上清单所以不动，
    `dangling` 只看编号是否越界所以也不报。dev 全库实测 30 处。
    """
    from ..db import Shot, get_session
    from ..at_refs import dangling_image_refs, remap_image_refs

    eps = sorted(set(int(x) for x in (episodes or [])))
    with get_session() as s:
        q = s.query(Shot).filter(Shot.project_id == project_id,
                                 Shot.disabled == 0)
        if eps:
            q = q.filter(Shot.episode.in_(eps))
        shots = q.order_by(Shot.order).all()

        # ---- 项目级常量预取（2026-10-26）----
        # 逐镜调 `_auto_inject_refs` 时，它会为**每个镜头**重建一次
        # `deleted_names` 与场景归一映射。本项目实测：前者单次 1.86ms，
        # 546 个带 @ 的镜头就是 1018ms（占整轮 26%）；后者同理。
        # 这两样在一次遍历里是**不变的**，取一次即可 —— 实测 7ms。
        _pre: dict = {}
        try:
            from .. import asset_gate
            from ..scenes import canonical_map
            _pre["gone"] = asset_gate.deleted_names(s, project_id)
            _pre["canon"] = canonical_map(s, project_id, shots=shots)
        except Exception:  # noqa: BLE001 —— 预取失败就退回逐镜查，不影响结果
            logger.warning("[audit] 项目级预取失败，退回逐镜查库", exc_info=True)
            _pre = {}

    rows: list[dict] = []
    counts = {"remapped": 0, "dangling": 0, "phantom": 0}

    for sh in shots:
        prompt = (sh.gen_prompt or "").strip()
        if not prompt or "@" not in prompt:
            continue
        # 用**真实下发清单**算：与出片同一函数，不另写一份
        try:
            urls, labels = _injected_refs(sh.id, _pre or None)
        except Exception as e:  # noqa: BLE001 — 审计失败不该炸掉整轮
            logger.warning("[audit] 镜头 %s 算下发清单失败: %r", sh.id, e)
            continue
        if not labels and not urls:
            # 这一镜没有任何参考图：所有 @图片N 都是悬空的
            dangling = dangling_image_refs(prompt, [])
            if dangling:
                counts["dangling"] += 1
                rows.append({"shot_id": sh.id, "order": sh.order,
                             "episode": sh.episode, "kind": "dangling",
                             "detail": f"本镜没有下发任何参考图，但提示词引用了 "
                                       f"{'、'.join(dangling)}"})
            continue

        _, notes = remap_image_refs(prompt, labels)
        if notes:
            counts["remapped"] += 1
            rows.append({"shot_id": sh.id, "order": sh.order,
                         "episode": sh.episode, "kind": "remapped",
                         "detail": "；".join(notes[:5]),
                         "auto_fixed": True})

        dangling = dangling_image_refs(prompt, labels)
        if dangling:
            counts["dangling"] += 1
            rows.append({"shot_id": sh.id, "order": sh.order,
                         "episode": sh.episode, "kind": "dangling",
                         "detail": f"指向未下发的素材：{'、'.join(dangling)}",
                         "auto_fixed": True})

        phantom = _phantom_refs(prompt, labels, urls)
        if phantom:
            counts["phantom"] += 1
            rows.append({"shot_id": sh.id, "order": sh.order,
                         "episode": sh.episode, "kind": "phantom",
                         "detail": "；".join(phantom[:5]),
                         "auto_fixed": False})

    total = sum(counts.values())
    return {
        "ok": True,
        "total": total,
        "counts": counts,
        "issues": rows[:detail_cap],
        "truncated": len(rows) > detail_cap,
        "note": ("前两类（编号指错、指向未下发素材）出片时已被 at_refs 自动纠正，"
                 "这里只是让它们可见；**真正需要人看的是 phantom** ——"
                 "提示词声明了某个角色，但那个角色根本不在本镜的下发清单里，"
                 "而现有纠错救不了它。不要重写提示词里的编号。"),
    }


def _injected_refs(shot_id: str, _pre: dict | None = None) -> tuple[list[str], list[str]]:
    """这一镜出片时会下发的参考图 `(urls, labels)`。

    `_pre`：逐镜循环时的项目级预取（见 `jobs._auto_inject_refs_with_source`）。
    批量审计传它，单次调用传 None。
    """
    from ..jobs import _auto_inject_refs
    if _pre is None:
        return _auto_inject_refs(shot_id, 9)
    # 预取路径：直接走带 `_pre` 的实现（薄壳 `_auto_inject_refs` 不接受它）
    from ..jobs import _auto_inject_refs_with_source
    urls, labels, _notes, _src = _auto_inject_refs_with_source(
        shot_id, 9, _pre=_pre)
    return urls, labels


def _phantom_refs(prompt: str, labels: list[str], urls: list[str]) -> list[str]:
    """找出「声明了某个角色、但该角色不在本镜下发清单里」的引用。

    判据：提示词里有 `@图片N 为X` / `X（@图片N）` 这类**显式声明**，
    而 X 在本镜的下发标签里找不到。

    ⚠️ 只认显式声明。曾试过"提示词里提到角色名但不在清单里"—— 4816 处，
    几乎全是正常描述（提示词本来就会写不在画面里的人）。高精度比高召回重要：
    报 4000 条等于一条都没报。
    """
    from ..at_refs import _collect_claims, _match_name, _sent_names

    real = _sent_names(labels, 0)
    if not real:
        return []
    names = list(real)
    out: list[str] = []
    for idx, _tier, claimed, _s, _e in _collect_claims(prompt):
        hit = _match_name(claimed, names)
        if hit is None:
            out.append(f"@图片{idx} 声明为「{claimed}」，但本镜下发清单里没有这个实体")
    return out


# ---------------------------------------------------------------------------
# C 类：台词人名被当成在场角色（§13.3）
# ---------------------------------------------------------------------------

#: 「只出现在引号里」的判据用。中文引号三种写法都要认。
_QUOTE_RE = re.compile(r"[“「『\"]([^”」』\"]{1,40})[”」』\"]")


def audit_present_characters(project_id: str, *, episodes: list[int] | None = None,
                             detail_cap: int = DETAIL_CAP) -> dict:
    """找出可能被误判为在场角色的名字。

    ## 两个高精度信号（试过、收敛到这里）

    | 信号 | 误报风险 | 处置 |
    |---|---|---|
    | 说话人带**画外标记**（(VO)/(OS)/旁白/内心/独白）却仍被列为在场 | 低 | 报告 |
    | 角色名**只在引号内**出现、动作描写里一次都没有，且不是说话人 | 中 | 报告，标 low_confidence |

    被否掉的两个信号（都太脏）："提示词提到角色名但不在清单"（4816 处，几乎全正常）、
    "只在引号/台词里出现"（1861 处，中文剧本的 `A：台词` 写法让台词标记紧贴名字）。

    ## 只报告，不自动改

    修复动作是 `set_ref_overrides(remove=[name])` —— 只断参考图链，不动
    `Shot.characters`、不动剧本原文。但那会改变画面内容，所以按批**硬确认**，
    不自动执行。见 §13.3 末尾关于"批量剔除是不是删除语义"的裁定。
    """
    from ..db import Shot, effective_characters, get_session
    from ..drama_timing import split_units, speaker_of

    eps = sorted(set(int(x) for x in (episodes or [])))
    with get_session() as s:
        q = s.query(Shot).filter(Shot.project_id == project_id,
                                 Shot.disabled == 0)
        if eps:
            q = q.filter(Shot.episode.in_(eps))
        shots = q.order_by(Shot.order).all()
        # 本项目有哪些角色资产 —— 用来过滤"名字根本不是一个角色"的噪音
        from ..db import Asset
        asset_names = {a.name for a in
                       s.query(Asset).filter(Asset.project_id == project_id,
                                             Asset.kind == "character").all()}

    rows: list[dict] = []
    counts = {"offscreen_speaker": 0, "quote_only": 0}

    for sh in shots:
        ref = sh.script_ref or ""
        if not ref.strip():
            continue
        present = effective_characters(sh)
        if not present:
            continue

        # ---- 信号 1：画外音说话人却仍被列为在场 ----
        vo_speakers: set[str] = set()
        action_text_parts: list[str] = []
        for u in split_units(ref):
            if u.kind == "vo":
                nm = speaker_of(u.raw)
                if nm:
                    vo_speakers.add(nm)
            elif u.kind == "action":
                action_text_parts.append(u.raw)

        for nm in sorted(vo_speakers & set(present)):
            counts["offscreen_speaker"] += 1
            rows.append({
                "shot_id": sh.id, "order": sh.order, "episode": sh.episode,
                "name": nm, "signal": "offscreen_speaker",
                "confidence": "high",
                "evidence": _vo_evidence(ref, nm),
            })

        # ---- 信号 2：只在引号内出现、动作描写里没有、也不是说话人 ----
        action_text = "".join(action_text_parts)
        quoted = set()
        for m in _QUOTE_RE.finditer(ref):
            quoted.add(m.group(1))
        for nm in present:
            if nm in vo_speakers or nm in action_text:
                continue
            if nm not in asset_names:
                continue                  # 不是角色资产：不猜
            # 名字必须**恰好出现在某段引号内**，而不是引号外还提到过
            in_quote = any(nm in q for q in quoted)
            if not in_quote:
                continue
            outside = ref
            for q in quoted:
                outside = outside.replace(q, "")
            if nm in outside:
                continue                  # 引号外也出现过 → 正常
            counts["quote_only"] += 1
            rows.append({
                "shot_id": sh.id, "order": sh.order, "episode": sh.episode,
                "name": nm, "signal": "quote_only",
                "confidence": "low",
                "evidence": _quote_evidence(ref, nm),
            })

    merged = _merge_present(rows)
    return {
        "ok": True,
        "total": len(rows),
        "total_merged": len(merged),
        "counts": counts,
        "issues": merged[:detail_cap],
        "truncated": len(merged) > detail_cap,
        "note": ("offscreen_speaker 是高精度信号（画外音按定义不在画面里）；"
                 "quote_only 是中等精度（「简糯！」也可能是别人喊她，她确实在场）。"
                 "两者都只报告。要改必须走 set_ref_overrides(remove=…)，"
                 "按批一次确认。"),
    }


def _vo_evidence(ref: str, name: str) -> str:
    for line in (ref or "").splitlines():
        if name in line and re.search(r"os|vo|画外|内心|独白|心声|旁白", line, re.I):
            return line.strip()[:160]
    return f"{name} 以画外音/独白形式说话，但仍在在场角色清单里"


def _quote_evidence(ref: str, name: str) -> str:
    for m in _QUOTE_RE.finditer(ref or ""):
        if name in m.group(1):
            start = max(0, m.start() - 40)
            return ("…" + ref[start:m.end() + 20]).strip()[:200]
    return name


def _merge_present(rows: list[dict]) -> list[dict]:
    """按 (名字, 信号) 聚合：用户要看"第 3 集简糯 14 处"，不是 14 条。"""
    out: dict[tuple, dict] = {}
    for r in rows:
        key = (r["name"], r["signal"])
        cur = out.get(key)
        if cur is None:
            cur = dict(r)
            cur["episodes"] = [r["episode"]]
            cur["shot_orders"] = [r["order"]]
            cur["count"] = 1
            out[key] = cur
        else:
            cur["count"] += 1
            if r["episode"] not in cur["episodes"]:
                cur["episodes"].append(r["episode"])
            cur["shot_orders"].append(r["order"])
    rows2 = list(out.values())
    for r in rows2:
        r["episodes"] = sorted(r["episodes"])
        r["shot_orders"] = sorted(r["shot_orders"])
        r.pop("episode", None)
        r.pop("order", None)
    rows2.sort(key=lambda r: (-r["count"], r["name"]))
    return rows2


# ---------------------------------------------------------------------------
# 汇总（§13.4 的体检条）
# ---------------------------------------------------------------------------

#: 汇总数的进程内缓存：project_id → (结果, 写入时刻)。
#:
#: ## 为什么要缓存（2026-10-26 生产只读排查）
#:
#: `overview()` 是**全量重算**：它把三个阶段各跑一遍，其中
#: `audit_ref_integrity` 对**每一个带 `@` 的镜头**完整算一次"本镜会下发哪几张
#: 参考图"。生产实测（项目 06b5aee23dc2，589 镜）：
#:
#:   · 整轮 7028 条 SQL、5.28 秒（1332 SQL/s）
#:   · 单次耗时随并发**线性增长**：1 并发 5.9s → 8 并发 101.9s → 16 并发 210.1s
#:     （CPU 占用恒等于并发数倍，是 GIL 下纯 Python 计算串行的典型形态）
#:
#: 而前端每 10 秒就把这个端点重扫一遍（`liveRefresh → gotoStep → renderElements
#: → loadAuditBar`）。生产 14:49–15:03 那 21 分钟里它独占 8.4 个 anyio 线程槽
#: （40 槽的 21%），全站合计 43% —— 这就是"卡顿但不完全卡死"的来源。
#:
#: ## 为什么缓存是安全的
#:
#: 返回的是**汇总数**（三个面板的三个数字），实测每项目仅 ~312 字节，
#: 全库 380 个项目也才 ~120 KB —— 不会推高内存。
#:
#: 真正的风险是**脏读**（改了镜头/资产却看到旧数字），所以：
#:   · TTL 只有 30 秒 —— 用户不会 30 秒内改两次剧本还指望体检条实时变；
#:   · 任何写操作后都会调 `invalidate_overview()`（见该函数说明）；
#:   · 过期即重算，绝不返回过期结果。
#:
#: ⚠️ **只缓存汇总，不缓存明细**。明细（issues 数组）每项目可能几百 KB～几 MB，
#: 且前端只在抽屉展开时才要，缓存它纯属浪费。
_OVERVIEW_CACHE: dict[str, tuple[dict, float]] = {}
_OVERVIEW_TTL = 30.0
_OVERVIEW_CACHE_MAX = 2000      # 防御性上限：超过就整体清空，不做 LRU（不值得）

#: 单飞（single-flight）：同一项目**同时**只允许一次计算，其余等它算完直接拿结果。
#:
#: ## 为什么光有缓存不够（2026-10-26 实测）
#:
#: 缓存只在**算完之后**才生效。而这个端点被前端每 10 秒重扫一次，多个标签页/
#: 多个用户同时开着「要素」页时，它们会**同时** miss 缓存、然后各自从头算一遍。
#: 生产实测（项目 06b5aee23dc2）：14:49–15:03 那 21 分钟里出现 58 次调用，
#: 其中大量是同一项目的并发重复计算，独占 8.4 个线程槽（40 槽的 21%）。
#:
#: 单飞把"N 个并发 = N 次计算"变成"1 次计算 + N-1 个等待"。而本函数是**纯读**、
#: 结果只依赖库的快照，所以共享同一次计算的结果是正确的。
#:
#: ⚠️ 用 `threading` 而不是 `asyncio`：`overview` 是**同步函数**，跑在 anyio 的
#: 线程池里（路由是 `def audit_overview`）。在这里用 asyncio 原语会直接崩。
_OVERVIEW_FLIGHT: dict[str, "threading.Event"] = {}
_OVERVIEW_FLIGHT_GUARD = threading.Lock()


def invalidate_overview(project_id: str | None = None) -> None:
    """让体检条的汇总缓存失效。`project_id=None` 清空全部。

    调用点（凡是会改变三类体检结论的写操作）：
      · 镜头增删改（拆解落库、插入/删除镜头、改 characters/location/gen_prompt）
      · 资产/造型阶段的增删改（尤其是删资产、删造型、补图）
      · 参考图 override（`ref_overrides` / `ref_urls`）

    ⚠️ 漏调的后果只是"最多 30 秒内看到旧数字"，不是错误结果 —— 这是刻意
    选的取舍：宁可在极端情况下慢 30 秒刷新，也不为了即时性在每条写路径上
    都硬塞一次失效调用（那反而容易漏且难维护）。
    """
    if project_id is None:
        _OVERVIEW_CACHE.clear()
    else:
        _OVERVIEW_CACHE.pop(project_id, None)


def overview(project_id: str) -> dict:
    """三类问题的**汇总数**，不启动 run、不花钱。

    面板只显示这三个数 + 一个「让 Agent 处理」按钮。明细在抽屉里可展开、
    默认折叠 —— 报出几百条然后全部铺开，用户就不看了，等于没做。

    ⚠️ 带 30 秒进程内缓存 + 单飞，理由与安全边界见 `_OVERVIEW_CACHE`
    与 `_OVERVIEW_FLIGHT` 的说明。命中时不发任何 SQL —— 这条路径在稳态下
    从"5.28 秒 / 7028 条查询"降到"0 查询"；并发时从"N 次计算"降到"1 次"。
    """
    import copy
    import time as _time

    now = _time.monotonic()
    hit = _OVERVIEW_CACHE.get(project_id)
    if hit is not None:
        val, ts = hit
        if now - ts < _OVERVIEW_TTL:
            # 返回**副本**：调用方（路由层）可能往里加字段或改动嵌套 dict，
            # 直接交出缓存对象会让下一次命中拿到被改过的数据。
            return copy.deepcopy(val)

    # ---- 单飞：同一项目同时只算一次 ----
    # 抢到 Event 的那个负责计算，其余在 wait() 上等；算完 set() 把它们全部放行。
    with _OVERVIEW_FLIGHT_GUARD:
        ev = _OVERVIEW_FLIGHT.get(project_id)
        owner = ev is None
        if owner:
            ev = threading.Event()
            _OVERVIEW_FLIGHT[project_id] = ev
    if not owner:
        # 等别人算完（上限略大于一次计算的实测耗时；超时就自己算，绝不永久挂住）
        ev.wait(timeout=120.0)
        hit = _OVERVIEW_CACHE.get(project_id)
        if hit is not None:
            val, ts = hit
            if _time.monotonic() - ts < _OVERVIEW_TTL:
                return copy.deepcopy(val)
        # 等不到结果（上一个失败/超时）→ 自己算。此时不再占 flight 位，
        # 可能短暂出现两个并发计算，可接受：正确性不受影响，只是这一轮多算一次。
        return _overview_compute(project_id)

    try:
        out = _overview_compute(project_id)
        return out
    finally:
        with _OVERVIEW_FLIGHT_GUARD:
            if _OVERVIEW_FLIGHT.get(project_id) is ev:
                _OVERVIEW_FLIGHT.pop(project_id, None)
        ev.set()


def _overview_compute(project_id: str) -> dict:
    """真正算一次汇总，并写缓存。由 `overview` 在单飞临界区内调用。"""
    import copy
    import time as _time

    now = _time.monotonic()
    a = audit_stage_coverage(project_id, detail_cap=0)
    b = audit_ref_integrity(project_id, detail_cap=0)
    c = audit_present_characters(project_id, detail_cap=0)
    if not a.get("ok", False):
        # ⚠️ 失败**不缓存**：项目不存在可能只是因为 id 打错，而临时性失败
        # （查库抖动）更不该被记住 30 秒。宁可每次都重算。
        return {"ok": False, "error": a.get("error")}
    out = {
        "ok": True,
        "project_id": project_id,
        "stage_coverage": {
            "total": a["total"],
            "safe_to_extend": a["safe_to_extend"],
            "report_only": a["report_only"],
        },
        "ref_integrity": {
            "total": b["total"],
            "phantom": b["counts"]["phantom"],
            "auto_fixed": b["counts"]["remapped"] + b["counts"]["dangling"],
        },
        "present_characters": {
            "total": c["total_merged"],
            "high_confidence": c["counts"]["offscreen_speaker"],
            "low_confidence": c["counts"]["quote_only"],
        },
        "note": "三类都不花钱；「让 Agent 处理」会开一轮只做审计与修复的 run。",
    }
    # 写缓存前先判上限：极端情况（大量临时项目 id 被打错）不至于无限涨。
    if len(_OVERVIEW_CACHE) >= _OVERVIEW_CACHE_MAX:
        _OVERVIEW_CACHE.clear()
    _OVERVIEW_CACHE[project_id] = (out, now)
    import copy
    return copy.deepcopy(out)
