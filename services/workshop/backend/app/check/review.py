"""生成后检查（供「交给 Agent」的工作清单调用）。

三类检查，都**只判定不改稿**；修复由 Agent 按返回的意见调用 regenerate_* 完成：

| 函数 | 查什么 | 成本 |
|---|---|---|
| `mainline_review`   | 主线：主角本事是否出场、对手是否同一人、手法是否真实可信、相邻两集是否换了打法 | 每 12 集 1 次模型调用 |
| `storyboard_review` | 剧本机械指标：字数、整场无对白、连续动作行、对白占比 | 零模型 |
| `product_review`    | 小说/推文机械指标：缺章、空章、字数、上游报错文本、推文人称 | 零模型 |

为什么主线核对不放进生成管线：2026-10-28 A/B 实测，只靠生成时的规则拦不住中段滑回模型熟悉的套路
（证据—警察—投资人—发布会），而"成稿后逐集判定 + 只重写不过关的集"能把主线补回来
（独立盲评 44:30）。用户裁定由 Agent 在工作清单里调用，而不是改生成流程。

修复意见里的两条约束（用户 2026-10-28 采纳）：手法真实可信；相邻两集换一种打法。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Literal

from sqlalchemy import select

from ..db import ScriptChapter, ScriptDraft, ScriptStoryboard, session_scope
from ..defaults import DEFAULT_CHAPTER_WORD_TARGET
from ..models.llm import get_llm

logger = logging.getLogger("check.review")

#: 一次判定最多送多少集（12 集剧本约 1.5 万字，留足余量）
_JUDGE_CHUNK = 12
#: 剧本层送判定时每集截取的字数（只用于判断，不影响原稿）
_SB_CLIP = 2500

# 字数容差与正文/小说的生成口径一致（adapt_products._word_params、chapter_gen）
_WORD_LO, _WORD_HI = 0.7, 1.4


# ===================================================================== 主线核对
_JUDGE_PROMPT = """你是短剧总策划，负责核对一部剧有没有偏出主线。只判定，不改稿。

## 全剧主线
{mainline}

## 主角靠什么赢
{edge}

## 主要对手
{opponent}

## 待核对的内容（{layer_label}）
{episodes}

## 机械指标参考（仅供参考，结合内容判断，不是固定阈值）
{stats_block}

## 判定口径（四件事都成立才算 pass）
1. **主角的本事这一集真的出场了**：这一集的主要转折由主角用自己的本事推动——用她的专业或手艺做出判断、操作、验证或反击，并当场见到效果。仅仅"拿到证据""去找人谈""决定反击"、或被动挨打，算 fail。
2. **对手还是主线上的那位**：主要对抗发生在主线写的对手（或他手下的具体行为）与主角之间。中途换成与主线无关的新对手，或这一集的胜负由外部机构（警察、法院、上级、媒体、投资方）代劳，算 fail。
3. **手法真实可信**：主角用的方法是现实里确实存在、观众能看懂的做法。编造出来的科学原理或装置，算 fail。
4. **打法和上一集不同**：主角这一集的反制方式与上一集不是同一招（例如两集都是"当众拿仪器检测揭穿"算同一招）。第 1 集不判这一条。

关于机械指标：字数偏少可能意味着内容不充实，对白比例低可能意味着用动作代替了人物交锋，
但这些是参考信号不是硬标准——结合具体内容判断这一集是否真的有问题。

另外，用一句话写下"主角这一集用的打法"（tactic），用来比对相邻两集。

## 输出（严格 JSON 数组，直接输出数组本身）
[{{"order": 1, "pass": true, "tactic": "主角这一集用的打法", "failed": [], "reason": "一句话：她用了什么本事 / 哪里偏了"}}]
- failed 里填不成立的条目编号（1–4），pass 为 true 时为空数组。
- 必须覆盖上面列出的每一集，order 与给出的集号一致。"""

_FIX_HINT = {
    1: "这一集的主要转折由主角用自己的本事当面推动，并当场见到效果",
    2: "对抗回到主线上的对手{opp}本人（或他手下的具体行为）与主角之间，胜负由主角当面拿下，外部机构的结果用一两句交代",
    3: "主角的手法用现实中确实存在、观众一看就懂的做法",
    4: "主角这一集换一种打法，和上一集（{prev}）不同",
}


def _mainline_parts(outline: dict) -> tuple[str, str, str, str]:
    bible = outline.get("story_bible") or {}
    ml = bible.get("main_line") or {}
    mainline = "；".join(f"{k}={ml.get(k)}" for k in ("want", "blocker", "edge") if ml.get(k)) \
        or str(outline.get("synopsis") or "")
    opp = bible.get("opponent") or {}
    opp_name = str(opp.get("name") or "")
    opponent = (opp_name or "（大纲未单列，以主线为准）") + (("：" + str(opp.get("goal"))) if opp.get("goal") else "")
    edge = str(ml.get("edge") or "（未单独给出，以主线为准）")
    return mainline, edge, opponent, opp_name


def _outline_ep_text(ch: dict) -> str:
    rows = [f"### 第{ch.get('order')}集《{ch.get('title', '')}》",
            f"核心推进：{ch.get('core_push', '')}", f"梗概：{ch.get('synopsis', '')}"]
    for i, b in enumerate(ch.get("beats") or [], 1):
        if isinstance(b, dict):
            rows.append(f"  节拍{i}：{b.get('action', '')} → {b.get('turn', '')}")
        elif str(b).strip():
            rows.append(f"  节拍{i}：{b}")
    return "\n".join(rows)


def storyboard_plain(shots: list) -> str:
    """剧本 JSON → 人读文本（动作行 + "人物：台词"）。"""
    rows: list[str] = []
    for sc in shots or []:
        if not isinstance(sc, dict):
            continue
        rows.append(f"【{sc.get('scene_no', '')} {sc.get('time_loc', '')}】")
        for el in sc.get("elements") or []:
            if not isinstance(el, dict):
                continue
            if el.get("type") == "dialogue":
                rows.append(f"{el.get('character', '')}：{el.get('content', '')}")
            elif el.get("content"):
                rows.append(str(el["content"]))
    return "\n".join(rows)


def _parse_judge(text: str) -> list[dict]:
    m = re.search(r"\[.*\]", text or "", re.S)
    if not m:
        raise ValueError("判定结果不是 JSON 数组")
    data = json.loads(m.group(0))
    out = []
    for r in data:
        if not isinstance(r, dict):
            continue
        try:
            order = int(r.get("order"))
        except (TypeError, ValueError):
            continue
        failed = sorted({int(x) for x in (r.get("failed") or []) if str(x).isdigit() and 1 <= int(x) <= 4})
        ok = bool(r.get("pass")) and not failed
        out.append({"order": order, "pass": ok, "failed": [] if ok else (failed or [1]),
                    "tactic": str(r.get("tactic") or ""), "reason": str(r.get("reason") or "")})
    return out


async def mainline_review(draft_id: int, *, layer: Literal["outline", "storyboard"] = "outline",
                          start_ep: int = 0, end_ep: int = 0, provider: str | None = None) -> dict:
    """逐集核对是否贴合主线。返回 {episodes:[...], failed_orders:[...], judged, skipped}。"""
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise ValueError(f"草稿 #{draft_id} 不存在")
        outline = dict(d.outline or {})
        prov = provider or d.model_provider or "gemini"
        sbs: dict[int, list] = {}
        if layer == "storyboard":
            rows = (await s.execute(select(ScriptStoryboard).where(
                ScriptStoryboard.draft_id == draft_id))).scalars().all()
            sbs = {int(r.chapter_order): (r.shots_json or []) for r in rows}
    chapters = [c for c in (outline.get("chapters") or []) if isinstance(c, dict)]
    lo, hi = start_ep or 1, end_ep or 10 ** 6
    chapters = [c for c in chapters if lo <= int(c.get("order") or 0) <= hi]
    if not chapters:
        raise ValueError("指定范围内没有可核对的集")

    blocks: list[tuple[int, str]] = []
    stats_map: dict[int, dict] = {}   # 剧本层：机械指标，喂给 LLM 作为参考事实
    skipped: list[int] = []
    for c in chapters:
        o = int(c.get("order") or 0)
        if layer == "outline":
            blocks.append((o, _outline_ep_text(c)))
        else:
            body = storyboard_plain(sbs.get(o) or [])
            if not body.strip():
                skipped.append(o)
                continue
            if len(body) > _SB_CLIP:
                body = body[:_SB_CLIP] + "\n…（以下省略）"
            blocks.append((o, f"### 第{o}集《{c.get('title', '')}》\n{body}"))
            # 2026-11-07：计算本集剧本的机械指标（字数/对白/动作行/静默场），
            # 作为参考事实送进 LLM 提示词，由模型结合内容判断是否真有问题。
            # 不再用固定阈值机械卡——阈值是拍脑袋的经验值，不能决定质量好坏。
            stats_map[o] = _sb_stats(sbs.get(o) or [])
    if not blocks:
        raise ValueError("指定范围内的集都还没有剧本")

    mainline, edge, opponent, opp_name = _mainline_parts(outline)
    llm = get_llm("generate", temperature=0.1, provider=prov)
    results: list[dict] = []
    for i in range(0, len(blocks), _JUDGE_CHUNK):
        chunk = blocks[i:i + _JUDGE_CHUNK]
        # 第 4 条要和上一集比：跨块时把上一块最后一集的打法带进来
        prev_note = ""
        if results:
            prev_note = f"（上一集第{results[-1]['order']}集主角的打法：{results[-1]['tactic']}）\n\n"
        # 2026-11-07：机械指标（字数/对白/动作行）作为参考事实送进提示词，
        # 由 LLM 结合内容判断是否真有问题，不再用固定阈值机械卡。
        if stats_map and layer == "storyboard":
            stats_lines = []
            for o, _ in chunk:
                st = stats_map.get(o)
                if st:
                    stats_lines.append(
                        f"第{o}集：字数={st.get('chars',0)}"
                        f" 对白占比={int(st.get('dialogue_ratio',0)*100)}%"
                        f" 最长连续动作={st.get('max_action_run',0)}行"
                        f" 整场无对白={st.get('silent_scenes',0)}场"
                    )
            stats_block = "\n".join(stats_lines) if stats_lines else "（无）"
        else:
            stats_block = "（大纲层无剧本指标）"
        prompt = _JUDGE_PROMPT.format(
            mainline=mainline, edge=edge, opponent=opponent,
            layer_label="分集大纲" if layer == "outline" else "分集剧本",
            episodes=prev_note + "\n\n".join(b for _, b in chunk),
            stats_block=stats_block)
        resp = await llm.ainvoke(prompt)
        got = {r["order"]: r for r in _parse_judge(getattr(resp, "content", "") or "")}
        for o, _ in chunk:
            # 模型漏判的集不能当成"通过"——标成未判定，交给调用方决定
            results.append(got.get(o) or {"order": o, "pass": None, "failed": [], "tactic": "",
                                          "reason": "本集未得到判定结果，可缩小范围重试"})

    by_order = {r["order"]: r for r in results}
    for r in results:
        if r["pass"] is False:
            prev = by_order.get(r["order"] - 1)
            hints = [_FIX_HINT[k].format(opp=f"「{opp_name}」" if opp_name else "",
                                         prev=(prev or {}).get("tactic") or "上一集的打法")
                     for k in r["failed"]]
            r["fix_feedback"] = f"{r['reason']} 改法：" + "；".join(hints) + "。"
    return {
        "layer": layer,
        "episodes": results,
        "failed_orders": [r["order"] for r in results if r["pass"] is False],
        "unjudged_orders": [r["order"] for r in results if r["pass"] is None],
        "skipped_no_content": skipped,
    }


# ===================================================================== 剧本机械指标
#: 一集里允许的整场无对白场数（留给集尾钩子那种一两行的画面）
_SILENT_SCENES_MAX = 1
#: 连续动作行达到这个数就算"一段默片"
_ACTION_RUN_MAX = 6
#: 对白字数占比的下限
_DIALOGUE_RATIO_MIN = 0.35


def _sb_stats(shots: list) -> dict:
    total = dia = 0
    silent = 0
    best_run = 0
    for sc in shots or []:
        if not isinstance(sc, dict):
            continue
        els = [e for e in (sc.get("elements") or []) if isinstance(e, dict)]
        if els and not any(e.get("type") == "dialogue" for e in els):
            silent += 1
        run = 0
        for e in els:
            n = len(str(e.get("content") or ""))
            total += n
            if e.get("type") == "dialogue":
                dia += n
                run = 0
            elif e.get("type") == "action":
                run += 1
                best_run = max(best_run, run)
    return {"chars": total, "dialogue_ratio": round(dia / total, 2) if total else 0.0,
            "silent_scenes": silent, "max_action_run": best_run,
            "scenes": len([x for x in shots or [] if isinstance(x, dict)])}


async def storyboard_review(draft_id: int, *, start_ep: int = 0, end_ep: int = 0) -> dict:
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise ValueError(f"草稿 #{draft_id} 不存在")
        target = int(d.chapter_word_target or DEFAULT_CHAPTER_WORD_TARGET)
        orders = [int(c.get("order") or 0) for c in ((d.outline or {}).get("chapters") or []) if isinstance(c, dict)]
        rows = (await s.execute(select(ScriptStoryboard).where(
            ScriptStoryboard.draft_id == draft_id))).scalars().all()
    sbs = {int(r.chapter_order): (r.shots_json or []) for r in rows}
    lo, hi = start_ep or 1, end_ep or 10 ** 6
    wanted = sorted({o for o in (orders or list(sbs)) if lo <= o <= hi})
    eps, problems = [], []
    for o in wanted:
        shots = sbs.get(o) or []
        if not shots:
            problems.append({"order": o, "issue": "missing", "msg": "这一集还没有剧本"})
            continue
        st = _sb_stats(shots) | {"order": o}
        eps.append(st)
        if not (_WORD_LO * target <= st["chars"] <= _WORD_HI * target):
            problems.append({"order": o, "issue": "length",
                             "msg": f"字数 {st['chars']}，草稿设定约 {target}（合理区间 {int(_WORD_LO*target)}–{int(_WORD_HI*target)}）"})
        if st["silent_scenes"] > _SILENT_SCENES_MAX:
            problems.append({"order": o, "issue": "silent_scenes",
                             "msg": f"{st['silent_scenes']} 场整场没有对白；把这些场改成人物当面交锋、用台词推进"})
        if st["max_action_run"] >= _ACTION_RUN_MAX:
            problems.append({"order": o, "issue": "action_run",
                             "msg": f"有一段连续 {st['max_action_run']} 条动作行没有台词；压成一两条动作，其余改成对白"})
        if st["dialogue_ratio"] < _DIALOGUE_RATIO_MIN:
            problems.append({"order": o, "issue": "dialogue_ratio",
                             "msg": f"对白只占 {int(st['dialogue_ratio']*100)}%；剧情要靠人物对话推进"})
    return {"word_target": target, "episodes": eps, "problems": problems,
            "failed_orders": sorted({p["order"] for p in problems})}


# ===================================================================== 小说/推文机械指标
#: 推文是第一人称：每千字"我"至少出现这么多次
_TWEET_I_PER_K_MIN = 8


async def product_review(draft_id: int, kind: Literal["novel", "tweet"]) -> dict:
    from ..adapt_products.models import ChapterAdaptation
    from ..adapt_products.service import _looks_like_upstream_error
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            raise ValueError(f"草稿 #{draft_id} 不存在")
        target = int(d.chapter_word_target or DEFAULT_CHAPTER_WORD_TARGET)
        src = (await s.execute(select(ScriptChapter).where(
            ScriptChapter.draft_id == draft_id))).scalars().all()
        items = (await s.execute(select(ChapterAdaptation).where(
            ChapterAdaptation.draft_id == draft_id, ChapterAdaptation.kind == kind))).scalars().all()
    src_orders = sorted(int(c.chapter_order) for c in src if (c.full_text or "").strip())
    got = {int(a.chapter_order): (a.content or "") for a in items}
    problems = []
    for o in src_orders:
        if o not in got:
            problems.append({"order": o, "issue": "missing", "msg": "正文有这一章，但还没有生成"})
    for o, text in sorted(got.items()):
        n = len(text.strip())
        if not n:
            problems.append({"order": o, "issue": "empty", "msg": "内容为空"})
            continue
        if _looks_like_upstream_error(text):
            problems.append({"order": o, "issue": "upstream_error", "msg": "内容像是模型/审核的报错文字，不是正文"})
            continue
        if not (_WORD_LO * target <= n <= _WORD_HI * target):
            problems.append({"order": o, "issue": "length",
                             "msg": f"字数 {n}，草稿设定约 {target}（合理区间 {int(_WORD_LO*target)}–{int(_WORD_HI*target)}）"})
        if kind == "tweet":
            per_k = text.count("我") / n * 1000
            if per_k < _TWEET_I_PER_K_MIN:
                problems.append({"order": o, "issue": "person",
                                 "msg": f"推文应为第一人称，但每千字只有 {per_k:.1f} 个「我」；改成主角第一人称讲述"})
    return {"kind": kind, "word_target": target, "source_chapters": len(src_orders),
            "generated": len(got), "problems": problems,
            "failed_orders": sorted({p["order"] for p in problems})}


__all__ = ["mainline_review", "storyboard_review", "product_review", "storyboard_plain"]
