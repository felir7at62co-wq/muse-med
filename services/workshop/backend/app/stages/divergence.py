"""分岔治理 —— 大纲（计划）与稿子（实况）对不上时怎么办。

见 `docs/PLAN-对话上下文重构与分岔治理.md` §4（2026-09-21 定稿）。

## 要解决的事

`state_ledger` 存在 `outline["state_ledger"]` 里，**只由大纲批次生成** ——
它记的是"计划里世界会变成什么样"。用户在剧本页把"A 第 3 集死"改成"第 5 集才死"之后：

  1. 账本仍是"A 第 3 集死"；
  2. 生成第 4 集时 prompt 里明写「已死角色不得出场」；
  3. → **AI 把 A 排除在第 4 集之外，和用户刚写的稿子对着干**；
  4. `consistency_lint` 还会把第 5 集报成 `dead_reappear` **error** ——
     用户故意改的东西被判成硬伤。

## 两件事，触发时机完全不同（此前被混为一谈）

  (A) **生成时用哪本账本** —— 每一次生成都必须对，用户没点过任何按钮也要对。
      由系统在生成任务内部保证（`effective_ledger`）。
  (B) **把分岔讲给用户听** —— 只在**用户主动点检查**时算、才呈现（`scan_divergence`）。
      不做后台定时扫描、不在保存后自动分析、不挂常驻标记、不推动作按钮。

## 事实类 vs 承诺类（决定"以稿子为准"是不是正确答案）

  · **事实类**（人物状态、设定、首次登场…）：世界变成了另一个样子
    → **稿子为准，覆盖计划**，并影响后续集生成的硬约束。
  · **承诺类**（伏笔埋/收、本集禁止项…）：**承诺落空了**
    → 稿子为准会让承诺悬空，所以要**报"未兑现"**。
    例：计划"第5集埋怀表"，实际没埋 —— 不能把计划改成"不埋"了事，
    因为**第30集还要回收它**，必须告诉用户"第30集的回收会悬空"。

## 成本

检测一律**先跑 0 次模型的粗筛**（账本 dead 名单 / 伏笔关键词 / forbidden 条目
是否出现在该集文本里）。只有粗筛命中、且需要判断"实际是哪一集死的"时，
才调 `polish.ledger.build_ledger`（10 集一批）。
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from sqlalchemy import select

from ..db import ScriptChapter, ScriptDraft, ScriptStoryboard, session_scope

logger = logging.getLogger("stages.divergence")


# ---------------------------------------------------------------------------
# 版本指纹：编辑时零开销的关键
# ---------------------------------------------------------------------------

async def _episode_texts(s, draft_id: int) -> tuple[dict[int, str], dict[int, dict]]:
    """取每集的"当前文本"与版本指纹。

    文本优先用正文；没有正文的集用剧本（全库 5,479 集是"大纲直生剧本"、没有正文）。
    """
    chs = (await s.execute(
        select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
    )).scalars().all()
    sbs = (await s.execute(
        select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
    )).scalars().all()

    from ..critique.rules import storyboard_to_text

    texts: dict[int, str] = {}
    fp: dict[int, dict] = {}
    for c in chs:
        if c.chapter_order is None:
            continue
        o = int(c.chapter_order)
        fp.setdefault(o, {"ch": None, "sb": None})["ch"] = int(c.version or 1)
        if (c.full_text or "").strip():
            texts[o] = c.full_text or ""
    for b in sbs:
        if b.chapter_order is None:
            continue
        o = int(b.chapter_order)
        fp.setdefault(o, {"ch": None, "sb": None})["sb"] = int(b.version or 1)
        if o not in texts and (b.shots_json or []):
            texts[o] = storyboard_to_text(b.shots_json or [])
    return texts, fp


def _stale_orders(saved_fp: dict, cur_fp: dict[int, dict]) -> list[int]:
    """指纹对不上的集 = 需要重算的集。

    ⚠️ 这是"编辑时零开销"的全部秘密：保存时**什么都不做**
    （`version` 本来就会 +1），只在真要用账本的那一刻比对一次。
    保存是高频事件（失焦即存），把分析挂在它上面必然出现
    "改一个错别字跑一次全集抽取"。
    """
    saved = {str(k): v for k, v in (saved_fp or {}).items()}
    out: list[int] = []
    for o, cur in cur_fp.items():
        old = saved.get(str(o))
        if old != cur:
            out.append(o)
    return sorted(out)


# ---------------------------------------------------------------------------
# 0 LLM 粗筛
# ---------------------------------------------------------------------------

#: 账本里"会写进生成提示词当硬约束"的三类短语字段（见 state_ledger.snapshot_text）。
#: 它们和人物死活是**同一个失效模式**：计划说没揭穿/没解决/没用过，
#: 用户其实已经在稿子里写了，AI 还按计划往下写。
_PHRASE_FIELDS = ("revealed_secrets", "open_threads", "used_elements")


def _ledger_has_phrase_fields(ledger: dict) -> bool:
    cum = (ledger or {}).get("cumulative") or {}
    return any((cum.get(k) or []) for k in _PHRASE_FIELDS)



def _norm_phrase(t: str) -> str:
    """比对用的归一化：去空白与常见标点。"""
    import re as _re
    return _re.sub(r"[\s，。、；：""''（）()【】\[\]!！?？.,;:]+", "", str(t or ""))


def _canonical(val: str, known: list[str]) -> str:
    """把抽取出来的措辞对齐到**计划里已有的那句话**。

    ⚠️ 不做这一步，"悬念已解决"就永远不生效：`_merge_into_cumulative` 是靠
    **字符串完全相等**把悬念从 open_threads 挪到 resolved_threads 的，
    而模型复述同一条悬念几乎不可能一字不差。对齐之后才能真正抵消。
    """
    nv = _norm_phrase(val)
    if not nv:
        return val
    for k in known:
        nk = _norm_phrase(k)
        if not nk:
            continue
        if nk == nv or nk in nv or nv in nk:
            return k
    return val


def _contradiction_candidates(ledger: dict, texts: dict[int, str],
                              stale: list[int] | None = None) -> list[int]:
    """粗筛：哪些集需要从稿子里抽实况。

    两条路：
      · **零成本**：账本说某人第 N 集前已死，而第 M>N 集文本里出现了他的名字
        —— 人名是确定字符串，直接搜即可（用户举的例子正是这条）。
      · **改过就抽**：秘密/悬念/已用元素在账本里存的是**短语**
        （"A是卧底""身世反转"），稿子揭穿它时未必用同样措辞，
        字面搜索会漏得厉害。所以这三类只能放宽成"这一集改过 && 账本里有这些字段"。
        代价是每次生成前多一次抽取（10 集一批），占一次整本生成的 <1%。
    """
    by_ep = (ledger or {}).get("by_episode") or {}
    dead_at: dict[str, int] = {}
    for k, v in by_ep.items():
        if not str(k).isdigit() or not isinstance(v, dict):
            continue
        ep = int(k)
        for name in (v.get("deaths") or []):
            n = str(name).strip()
            if n and (n not in dead_at or ep < dead_at[n]):
                dead_at[n] = ep
    hits: set[int] = set()
    for order, txt in texts.items():
        for name, dep in dead_at.items():
            if order > dep and name in txt:
                hits.add(order)
                hits.add(dep)
    if stale and _ledger_has_phrase_fields(ledger):
        hits.update(o for o in stale if o in texts)
    return sorted(hits)


# ---------------------------------------------------------------------------
# (A) 生成/校验用的"有效账本"
# ---------------------------------------------------------------------------

async def effective_ledger(draft_id: int, *, allow_llm: bool = True,
                           force: bool = False, scanned: int | None = None) -> dict:
    """返回**可用于生成与校验**的账本：计划账本 + 稿子实况覆盖。

    调用时机只有三个（见模块头）：生成任务开始前 / 用户点检查 / 对话点名某几集。

    流程：
      1. 读计划账本与它的 `derived_from` 指纹；
      2. 指纹一致 → **原样返回，零成本**；
      3. 指纹对不上 → 先 0 LLM 粗筛；粗筛没发现矛盾 → 只更新指纹，仍零成本；
      4. 粗筛命中 → 调 `polish.ledger.build_ledger` 抽实际事实，
         用**实际死亡集**覆盖计划死亡集，写回并更新指纹。
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {}
        outline = dict(d.outline or {})
        plan = dict(outline.get("state_ledger") or {})
        # ⚠️ 有效账本存在**另一个键**里，绝不覆盖 `state_ledger`。
        # 覆盖了就再也答不出"计划原本是什么"——分岔报告会在**分岔已被采纳之后**
        # 变成一片空白（2026-09-21 实测踩到：秘密明明提前揭穿了，报告却是 0 条）。
        cached = dict(outline.get("state_ledger_effective") or {})
        if not plan:
            # ⚠️ 没有计划账本 ≠ 没得算。
            # **自己导入**的草稿根本不会生成 state_ledger（实测用户 9 部草稿里
            # 3 部没有、其中 2 部有正文）—— 而"导入之后重建账本"正是这个按钮
            # 最该管用的场景。原来这里直接 return {}，用户看到的就是
            # "账本已重建：覆盖 0 集"（2026-09-22 用户反馈）。
            #
            # 🔴 2026-10-05 二次修正（这是真正的病根，上一版只修了一半）：
            # 「重建账本」按钮跑的是 force=True，它写的**只有** `state_ledger_effective`
            # （见 _persist），**从不写** `state_ledger`。而生成时（batch_gen /
            # router 单集）调的是非 force —— 于是走到这里看到 plan 为空就 return {}，
            # 把刚刚花钱重建、明明躺在库里的有效账本**原地丢掉**。
            # 用户侧现象：点完刷新回执说"覆盖 60 集"，但生成剧本时的账本硬约束
            # 一条都不生效（实测 2026-10-05：五本剧本全量重跑前 `effective_ledger()`
            # 返回空，而库里 cumulative 有死亡 2–3 条、已揭秘密 9–18 条）。
            # 修法：有有效账本时以它作基准继续走指纹/分岔逻辑，而不是当它不存在。
            if cached:
                plan = cached
            elif not force:
                return {}
            else:
                from .state_ledger import empty_ledger
                plan = empty_ledger()
        texts, cur_fp = await _episode_texts(s, draft_id)

    stale = _stale_orders(cached.get("derived_from") or {}, cur_fp)
    if not stale and not force:
        return cached or plan
    ledger = plan

    # force=用户主动点「刷新账本」：不做粗筛，全量重抽
    # （导入了一整本、或剧情大改之后，指纹与粗筛都不足以表达"整本都变了"）
    cand = sorted(texts) if force else _contradiction_candidates(
        ledger, dict(texts), stale=stale)
    if not cand or not allow_llm:
        # 稿子改过，但与计划账本没有明显矛盾 → 只更新指纹，不花一分钱
        await _persist(draft_id, ledger, cur_fp, scanned if force else None)
        return ledger

    try:
        from ..polish.ledger import build_ledger
        actual = await build_ledger({o: texts[o] for o in cand if o in texts})
    except Exception as e:  # noqa: BLE001
        logger.warning("draft %s 实况抽取失败，暂用计划账本: %s", draft_id, e)
        return ledger

    merged = _apply_actual(ledger, actual)
    await _persist(draft_id, merged, cur_fp, scanned if force else None)
    return merged


def _apply_actual(ledger: dict, actual: dict) -> dict:
    """把"稿子里的实况"盖到计划账本上（事实类 → 稿子为准）。

    目前覆盖**人物死亡集**：计划说第 3 集死、实际第 5 集才死 →
    把 deaths 从第 3 集挪到第 5 集，于是生成第 4 集时 A 仍然活着。
    """
    out = {k: (dict(v) if isinstance(v, dict) else v) for k, v in ledger.items()}
    by_ep = {str(k): dict(v) for k, v in (out.get("by_episode") or {}).items()
             if isinstance(v, dict)}

    actual_death: dict[str, int] = {}
    for st in (actual.get("char_states") or []):
        if not isinstance(st, dict) or st.get("revive_flag"):
            continue
        state = str(st.get("state") or "")
        if "死" not in state and "亡" not in state:
            continue
        name = str(st.get("char") or "").strip()
        try:
            ep = int(st.get("episode"))
        except Exception:
            continue
        if name and (name not in actual_death or ep < actual_death[name]):
            actual_death[name] = ep

    # 三类短语字段：实际在第几集发生，就记到第几集
    # （snapshot 会按集号重放，所以"记到哪一集"直接决定第 N 集生成时它算不算已发生）
    _cum = (ledger or {}).get("cumulative") or {}
    _known = {
        "revealed_secrets": [str(x) for x in (_cum.get("revealed_secrets") or [])],
        # 悬念要对齐到**未决**清单里的措辞（它就是将要被抵消的那一条）
        "resolved_threads": [str(x) for x in (_cum.get("open_threads") or [])]
                            + [str(x) for x in (_cum.get("resolved_threads") or [])],
        "used_elements": [str(x) for x in (_cum.get("used_elements") or [])],
    }
    for src_key, dst_key, val_key in (
        ("secrets_revealed", "revealed_secrets", "secret"),
        ("threads_resolved", "resolved_threads", "thread"),
        ("elements_used", "used_elements", "element"),
    ):
        for it in (actual.get(src_key) or []):
            if not isinstance(it, dict):
                continue
            val = _canonical(str(it.get(val_key) or "").strip(), _known[dst_key])
            try:
                ep = int(it.get("episode"))
            except Exception:
                continue
            if not val or ep <= 0:
                continue
            tgt = by_ep.setdefault(str(ep), {})
            cur = [str(x) for x in (tgt.get(dst_key) or [])]
            if val not in cur:
                cur.append(val)
            tgt[dst_key] = cur

    if not actual_death:
        out["by_episode"] = by_ep
        out["cumulative"] = _replay_cumulative(out)
        return out

    for name, real_ep in actual_death.items():
        for k, v in by_ep.items():
            deaths = [str(x) for x in (v.get("deaths") or [])]
            if name in deaths and str(k) != str(real_ep):
                v["deaths"] = [x for x in deaths if x != name]
        tgt = by_ep.setdefault(str(real_ep), {})
        tgt["deaths"] = sorted(set([str(x) for x in (tgt.get("deaths") or [])] + [name]))

    out["by_episode"] = by_ep
    out["cumulative"] = _replay_cumulative(out)
    return out



def _replay_cumulative(ledger: dict) -> dict:
    """按 by_episode 重放出 cumulative。

    ⚠️ 为什么必须算：生成侧用的是 `snapshot(ledger, upto)`，它每次现场重放，
    所以 cumulative 空不空都不影响生成。但**「设定」面板读的就是 cumulative** ——
    不算的话，用户点完「刷新账本」看到的还是一片空白，以为没生效
    （2026-09-22 实测：重建后 by_episode 有数据、cumulative 全空）。
    """
    try:
        from .state_ledger import snapshot
        orders = [int(k) for k in (ledger.get("by_episode") or {}) if str(k).isdigit()]
        return snapshot(ledger, max(orders) if orders else 0)
    except Exception as e:  # noqa: BLE001
        logger.warning("重放 cumulative 失败: %s", e)
        return ledger.get("cumulative") or {}


async def _persist(draft_id: int, ledger: dict, fp: dict[int, dict],
                   scanned: int | None = None) -> None:
    """把有效账本缓存进 `state_ledger_effective`。

    ⚠️ **不动 `state_ledger`** —— 那是用户的计划（大纲生成写的），
    是分岔报告里"计划说什么"的唯一来源。
    """
    from sqlalchemy.orm.attributes import flag_modified
    led = dict(ledger)
    led["derived_from"] = {str(k): v for k, v in fp.items()}
    if scanned is not None:
        # 记下"上次全量重建是什么时候、读了多少集"。
        # 用户点完刷新可能会**刷新页面**导致收不到回执（2026-09-22 反馈），
        # 面板读这两个字段就能自己说清楚"那次到底跑完没有"。
        # 两个 dict 都写：`led` 进库给面板看，`ledger` 是调用方手里的对象，
        # 不写它的话 HTTP 回执里 refreshed_at 会是 null。
        stamp = datetime.now().isoformat(timespec="seconds")
        ledger["refreshed_at"] = led["refreshed_at"] = stamp
        ledger["refreshed_scanned"] = led["refreshed_scanned"] = scanned
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return
        outline = dict(d.outline or {})
        outline["state_ledger_effective"] = led
        d.outline = outline
        flag_modified(d, "outline")
        await s.commit()


# ---------------------------------------------------------------------------
# (B) 分岔报告 —— 只在用户主动检查时跑
# ---------------------------------------------------------------------------

def _ep_entries(outline: dict) -> dict[int, dict]:
    eps = outline.get("episodes") or outline.get("chapters") or []
    out: dict[int, dict] = {}
    for i, ep in enumerate(eps if isinstance(eps, list) else []):
        if not isinstance(ep, dict):
            continue
        try:
            out[int(ep.get("order") or (i + 1))] = ep
        except Exception:
            out[i + 1] = ep
    return out


def _as_list(v: Any) -> list[str]:
    if not v:
        return []
    if isinstance(v, (list, tuple, set)):
        return [str(x).strip() for x in v if str(x or "").strip()]
    return [str(v).strip()] if str(v).strip() else []


async def scan_divergence(draft_id: int, *, allow_llm: bool = True) -> dict:
    """算出这部剧"计划 vs 实况"的全部分岔。**只在用户主动触发时调用。**

    返回 {"items": [...], "summary": {...}}；item 形如：
      {"kind": "fact|promise", "code": "...", "episode": 5,
       "plan": "...", "actual": "...", "impact": "..."}

    ⚠️ 只**陈述事实**，不带任何动作指令 —— 用户看完自己决定去改哪儿
    （2026-09-21 裁定：不推"去补写/同步大纲"这类按钮）。
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"items": [], "summary": {"fact": 0, "promise": 0, "total": 0}}
        outline = dict(d.outline or {})
        texts, _fp = await _episode_texts(s, draft_id)

    entries = _ep_entries(outline)
    items: list[dict] = []

    # ---- 事实类 1：人物状态（计划死亡集 vs 实际死亡集）----
    plan_led = outline.get("state_ledger") or {}
    eff = await effective_ledger(draft_id, allow_llm=allow_llm)
    plan_deaths = _deaths_map(plan_led)
    real_deaths = _deaths_map(eff)
    for name, pep in plan_deaths.items():
        # 0 LLM 粗筛：计划说他死了，可后面的稿子里还有他
        later = sorted(o for o, txt in texts.items() if o > pep and name in txt)
        rep = real_deaths.get(name)
        if rep is not None and rep != pep:
            # 抽取到了实际死亡集 —— 能说得很具体
            items.append({
                "kind": "fact", "code": "death_episode_moved", "episode": pep,
                "plan": f"第{pep}集 {name} 死亡",
                "actual": f"第{pep}集 {name} 未死；{name} 在第{rep}集死亡",
                "impact": "后续集的生成与校验已按实际（稿子）为准",
            })
        elif later:
            # 只有粗筛结论（没调模型 / 模型没给出死亡集）——
            # 仍然要报：这条本身就是用户最关心的信息，且**零成本**得到。
            items.append({
                "kind": "fact", "code": "dead_but_present", "episode": pep,
                "plan": f"第{pep}集 {name} 死亡",
                "actual": f"{name} 在第 {'、'.join(str(x) for x in later[:5])} 集的稿子里仍然出现",
                "impact": "若不是诈死/闪回，说明实际死亡时间与计划不同",
            })

    # ---- 事实类 2/3/4：秘密揭穿 / 悬念解决 / 重大元素 的时点 ----
    # 与人物死活是同一类问题：这三项都会被 snapshot_text 写成生成提示词里的硬约束
    #（"已揭穿的秘密不得再当作未知""尚未解决的悬念""已用过的重大元素"）。
    # 计划说第 20 集才揭穿、用户其实第 12 集就写穿了 —— 不纠正的话，
    # 第 13~19 集会被按"他还不知道"生成，和用户刚写的稿子对着干。
    for dst_key, label, verb in (
        ("revealed_secrets", "秘密", "揭穿"),
        ("resolved_threads", "悬念", "解决"),
        ("used_elements", "重大元素", "用掉"),
    ):
        plan_at = _phrase_map(plan_led, dst_key)
        real_at = _phrase_map(eff, dst_key)
        for val, pep in plan_at.items():
            rep = real_at.get(val)
            if rep is not None and rep != pep:
                items.append({
                    "kind": "fact", "code": f"{dst_key}_moved", "episode": min(pep, rep),
                    "plan": f"计划第{pep}集{verb}{label}「{val}」",
                    "actual": f"实际第{rep}集就{verb}了" if rep < pep else f"实际拖到第{rep}集才{verb}",
                    "impact": "两集之间的生成已按实际（稿子）为准",
                })
        for val, rep in real_at.items():
            if val not in plan_at:
                items.append({
                    "kind": "fact", "code": f"{dst_key}_unplanned", "episode": rep,
                    "plan": f"大纲里没有安排{verb}这个{label}",
                    "actual": f"实际第{rep}集{verb}了「{val}」",
                    "impact": "后续生成已把它当作已发生",
                })

    # ---- 承诺类 2/3：伏笔埋 / 收 ----
    plants: dict[str, int] = {}
    for order, ep in sorted(entries.items()):
        for token in _as_list(ep.get("plant")):
            plants.setdefault(token, order)
            if order in texts and token not in texts[order]:
                items.append({
                    "kind": "promise", "code": "plant_missing", "episode": order,
                    "plan": f"第{order}集应埋下「{token}」",
                    "actual": "实际稿子里没有出现",
                    "impact": _payoff_hint(entries, token, order),
                })
    for order, ep in sorted(entries.items()):
        for token in _as_list(ep.get("payoff")):
            if order in texts and token not in texts[order]:
                items.append({
                    "kind": "promise", "code": "payoff_missing", "episode": order,
                    "plan": f"第{order}集应回收「{token}」",
                    "actual": "实际稿子里没有出现",
                    "impact": "这条线索至今没有交代",
                })

    # ---- 承诺类 4：本集禁止项被违反 ----
    for order, ep in sorted(entries.items()):
        if order not in texts:
            continue
        for token in _as_list(ep.get("forbidden")):
            # 禁止项常写成整句（"男主不得直接表白"），整句去匹配必然不中；
            # 只有**足够短、像专名**的条目才做字面粗筛，避免满屏误报。
            if 2 <= len(token) <= 8 and token in texts[order]:
                items.append({
                    "kind": "promise", "code": "forbidden_hit", "episode": order,
                    "plan": f"第{order}集明确禁止「{token}」",
                    "actual": "实际稿子里出现了这个词",
                    "impact": "可能违背本集的设计意图（字面匹配，需人工确认）",
                })

    # ---- 事实类 5：角色首次登场早于计划 ----
    for order, ep in sorted(entries.items()):
        for name in _as_list(ep.get("first_appearance") or ep.get("debut")):
            earlier = [o for o, t in texts.items() if o < order and name in t]
            if earlier:
                items.append({
                    "kind": "fact", "code": "debut_earlier", "episode": order,
                    "plan": f"计划第{order}集 {name} 首次登场",
                    "actual": f"实际第{min(earlier)}集就已出现",
                    "impact": "登场顺序与计划不符",
                })

    items.sort(key=lambda x: (x.get("episode") or 0, x.get("code") or ""))
    return {
        "items": items,
        "summary": {
            "fact": sum(1 for i in items if i["kind"] == "fact"),
            "promise": sum(1 for i in items if i["kind"] == "promise"),
            "total": len(items),
        },
    }


def _phrase_map(ledger: dict, key: str) -> dict[str, int]:
    """{短语: 最早发生的集号}。用于比对计划与实际的**时点**。"""
    out: dict[str, int] = {}
    for k, v in ((ledger or {}).get("by_episode") or {}).items():
        if not str(k).isdigit() or not isinstance(v, dict):
            continue
        ep = int(k)
        for val in (v.get(key) or []):
            t = str(val).strip()
            if t and (t not in out or ep < out[t]):
                out[t] = ep
    return out


def _deaths_map(ledger: dict) -> dict[str, int]:
    out: dict[str, int] = {}
    for k, v in ((ledger or {}).get("by_episode") or {}).items():
        if not str(k).isdigit() or not isinstance(v, dict):
            continue
        ep = int(k)
        for name in (v.get("deaths") or []):
            n = str(name).strip()
            if n and (n not in out or ep < out[n]):
                out[n] = ep
    return out


def _payoff_hint(entries: dict[int, dict], token: str, plant_ep: int) -> str:
    """埋没埋成，真正的代价在"将来要收的那一集"——这正是承诺类与事实类的分野。"""
    for order, ep in sorted(entries.items()):
        if order > plant_ep and token in _as_list(ep.get("payoff")):
            return f"第{order}集的回收会悬空"
    return "后续没有安排回收，这条伏笔可能本就多余"
