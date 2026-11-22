"""事实账本 (Story Ledger): 抽取全剧结构化事实, 用于跨集硬伤检测。

只做两类硬伤需要的最小事实抽取, 不顺手做别的:
  1. 人物状态时间线 (char_states): 抓"死亡复活"类 —— 死亡是吸收态,
     某集标记 dead 后再出场(alive/active)且无诈死/复活/回忆标记 → 硬伤。
  2. 关键设定断言 (facts): 抓"同一事实前后冲突" —— 同 key 出现互斥 value → 硬伤。
     (如: 父亲死因 = 空难 / 谋杀 / 病逝)

刻意不做的(避免浪费):
  - 不抽人物关系网/桥段/情绪曲线等与硬伤无关的东西。
  - 抽取只用单模型(gemini), 不做多模型交叉。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re

from ..models.llm import get_llm

logger = logging.getLogger("polish.ledger")

# 每批喂多少集(控制单次 prompt 长度; 短剧单集通常几百~上千字)
BATCH_EPISODES = 10
# 死亡吸收态: 这些状态视为"已死亡"
_DEATH_STATES = {"死亡", "身亡", "去世", "遇害", "死", "殒命", "阵亡"}
# 复活/诈死等豁免标记: 若某集事实里带这些, 则该角色"复活"是合法的, 不算硬伤
_REVIVE_MARKERS = {"诈死", "假死", "复活", "还魂", "双胞胎", "孪生", "回忆", "闪回",
                   "梦境", "幻觉", "其实没死", "并未死", "假装死", "替身"}


_LEDGER_SYSTEM = (
    "你是剧本事实考据员。给你连续几集的剧本正文, 只抽取【客观事实】, 严格输出 JSON。"
    "不要评价好坏, 不要发明剧本没写的内容。\n"
    '输出格式: {\n'
    '  "char_states": [{"char":"角色名","state":"死亡|重伤|被捕|入狱|出狱|在场|离场|其它","episode":集号(整数),'
    '"evidence":"原文依据(简短)","revive_flag":true/false(该处是否明确是诈死/复活/双胞胎/回忆/替身等豁免情形)}],\n'
    '  "facts": [{"key":"可比对的事实主键(如\'男主父亲死因\'\'女主真实身份\'\'传家宝下落\')","value":"该集给出的取值","episode":集号,"evidence":"原文依据(简短)"}],\n'
    '  "secrets_revealed": [{"secret":"被揭穿的秘密(一句话, 如\'A是卧底\')","episode":集号,"evidence":"原文依据(简短)"}],\n'
    '  "threads_resolved": [{"thread":"被解决的悬念(一句话)","episode":集号,"evidence":"原文依据(简短)"}],\n'
    '  "elements_used": [{"element":"用掉的重大元素/桥段(如\'身世反转\'\'假死\'\'商战反杀\')","episode":集号,"evidence":"原文依据(简短)"}]\n'
    "}\n"
    "要点: ①char_states 只记'状态变化'的关键时刻(尤其死亡/被捕/入狱/出狱/重伤), 日常在场不用记。"
    "②facts 只记'会前后矛盾才算硬伤'的确定性事实(身世/死因/关键物件下落/血缘关系等), 不记主观感受。"
    "③revive_flag 仅当原文明确交代是诈死/假死/双胞胎/回忆闪回等才为 true。"
    "④secrets_revealed 只记**当众/对关键人物揭开**的那一刻(读者早知道不算);"
    "threads_resolved 只记真正给出答案的那一刻(继续吊着不算);"
    "elements_used 只记**重大**桥段, 日常对话与常规冲突不要记。这三类宁缺勿滥。"
    "只输出 JSON, 不要解释或 markdown。"
)


def _parse_json(text: str, fallback):
    if not text:
        return fallback
    s = str(text).strip()
    m = re.search(r"```(?:json)?\s*(.+?)\s*```", s, re.DOTALL)
    if m:
        s = m.group(1).strip()
    i, j = s.find("{"), s.rfind("}")
    if i != -1 and j != -1 and j > i:
        try:
            return json.loads(s[i:j + 1], strict=False)
        except Exception:  # noqa: BLE001
            pass
    try:
        return json.loads(s, strict=False)
    except Exception:  # noqa: BLE001
        return fallback


#: 每集上限的保守兜底（取不到窗口配置时用，沿用改前的 4000）。
_LEDGER_PER_EP_FALLBACK = 4_000


def _ledger_per_ep_cap() -> int:
    """账本抽取时每集给多少字 —— 按模型窗口算。

    账本要抽"谁死了/伏笔埋了没"这类**事实**，而它们在长正文里常出现在集尾，
    截掉尾部等于漏记。故保头+保尾。
    """
    try:
        from ..config import get_settings
        from ..stages.text_budget import text_budget_chars
        return text_budget_chars(
            get_settings().llm_generate_model or "", purpose="polish")
    except Exception:  # noqa: BLE001
        return _LEDGER_PER_EP_FALLBACK


async def _extract_batch(episodes: list[tuple[int, str]]) -> dict:
    """抽一批集的事实。episodes: [(ep_no, text), ...]。返回 {char_states, facts}。

    ⚠️ 2026-10-10：每集上限改为按模型窗口算。原硬编码 `txt[:4000]` ——
    在 70 万口径下，一集 2 万字的长正文只喂前 4000 字，**死亡/伏笔这类事实
    常出现在集尾**，于是账本漏记，后续生成按漏记的账本走 → 硬伤。
    裁剪改为保头+保尾并显式标注。
    """
    per_cap = _ledger_per_ep_cap()
    body_parts = []
    for ep, txt in episodes:
        t = (txt or "")
        if len(t) > per_cap:
            from ..stages.episode_text import clip
            t = clip(t, per_cap, keep="both")
        body_parts.append(f"【第{ep}集】\n{t}")
    user = "\n\n".join(body_parts)
    try:
        llm = get_llm("rewrite", temperature=0.1, provider="gemini", max_tokens=4096)
        resp = await llm.ainvoke(
            [{"role": "system", "content": _LEDGER_SYSTEM},
             {"role": "user", "content": user}]
        )
        raw = getattr(resp, "content", "") or ""
        data = _parse_json(raw, {}) or {}
        def _lst(key: str) -> list:
            v = data.get(key) if isinstance(data, dict) else None
            return v if isinstance(v, list) else []
        return {
            "char_states": _lst("char_states"),
            "facts": _lst("facts"),
            # 2026-09-21 新增三类：它们在 state_ledger 里都是**写进生成提示词的硬约束**
            # （"已揭穿的秘密不得再当作未知""尚未解决的悬念""已用过的重大元素"），
            # 不从稿子里抽实况的话，会重犯"人物死活"那个错 —— 计划说没揭穿、
            # 用户其实已经写穿了，AI 还按"他不知道"往下写。
            "secrets_revealed": _lst("secrets_revealed"),
            "threads_resolved": _lst("threads_resolved"),
            "elements_used": _lst("elements_used"),
        }
    except Exception as e:  # noqa: BLE001
        logger.warning("ledger extract batch failed: %s", e)
        return {"char_states": [], "facts": [],
                "secrets_revealed": [], "threads_resolved": [], "elements_used": []}


async def build_ledger(episodes_text: dict[int, str]) -> dict:
    """建全剧事实账本。

    返回 {char_states, facts, secrets_revealed, threads_resolved, elements_used}。
    ⚠️ 前两个键是老调用方（hardcheck / fixer）依赖的, **不能改名或去掉**；
    后三个是 2026-09-21 新增, 老调用方拿不到也不受影响（它们只读前两个）。

    LLM 调用次数 = ceil(集数 / BATCH_EPISODES)。批次之间并发。
    """
    _EMPTY = {"char_states": [], "facts": [],
              "secrets_revealed": [], "threads_resolved": [], "elements_used": []}
    eps = sorted(episodes_text.keys())
    if not eps:
        return dict(_EMPTY)
    batches: list[list[tuple[int, str]]] = []
    for k in range(0, len(eps), BATCH_EPISODES):
        chunk = [(ep, episodes_text[ep]) for ep in eps[k:k + BATCH_EPISODES]]
        batches.append(chunk)
    results = await asyncio.gather(*[_extract_batch(b) for b in batches])
    out: dict[str, list] = {k: [] for k in _EMPTY}
    for r in results:
        for k in out:
            out[k].extend(r.get(k) or [])
    return out


def _is_dead_state(state: str) -> bool:
    s = str(state or "")
    return any(d in s for d in _DEATH_STATES)


def detect_ledger_issues(ledger: dict) -> list[dict]:
    """在账本上做纯规则的跨集硬伤检测(0 次 LLM)。

    产出统一硬伤工单 issue:
      {type, severity, title, episodes:[...], anchor, evidence}
    只出两类:
      A. 死亡吸收态被打破(死人复活): 某角色某集死亡, 之后集再出现非豁免的活动状态。
      B. 设定冲突: 同一 fact.key 出现互斥 value。
    """
    issues: list[dict] = []

    # ---- A. 死人复活 ----
    # 按角色聚合状态事件, 按集号排序
    by_char: dict[str, list[dict]] = {}
    for st in ledger.get("char_states") or []:
        if not isinstance(st, dict):
            continue
        name = str(st.get("char") or "").strip()
        if not name:
            continue
        try:
            ep = int(st.get("episode"))
        except Exception:
            continue
        by_char.setdefault(name, []).append({
            "episode": ep,
            "state": str(st.get("state") or ""),
            "evidence": str(st.get("evidence") or ""),
            "revive_flag": bool(st.get("revive_flag")),
        })

    for name, evts in by_char.items():
        evts.sort(key=lambda x: x["episode"])
        dead_ep = None
        dead_evi = ""
        for e in evts:
            if dead_ep is not None:
                # 已死亡后, 出现"活动/在场"且非豁免 → 硬伤
                st = e["state"]
                revived = e["revive_flag"] or any(mk in (st + e["evidence"]) for mk in _REVIVE_MARKERS)
                is_active = not _is_dead_state(st) and st not in ("离场", "")
                if is_active and not revived:
                    issues.append({
                        "type": "dead_revive",
                        "severity": "P0",
                        "title": f"角色「{name}」已在第{dead_ep}集死亡, 却在第{e['episode']}集再次正常出场({st})且无诈死/复活伏笔",
                        "episodes": [dead_ep, e["episode"]],
                        "anchor": f"第{e['episode']}集: 要么删除/改写「{name}」的出场, 要么在其间补出诈死/复活的合理伏笔",
                        "evidence": f"死亡依据(第{dead_ep}集): {dead_evi[:60]} | 复活出场(第{e['episode']}集): {e['evidence'][:60]}",
                    })
                    # 报一次即可(同一角色只报首个复活点), 避免刷屏
                    break
            if _is_dead_state(e["state"]) and not e["revive_flag"]:
                dead_ep = e["episode"]
                dead_evi = e["evidence"]

    # ---- B. 设定冲突 ----
    by_key: dict[str, list[dict]] = {}
    for fa in ledger.get("facts") or []:
        if not isinstance(fa, dict):
            continue
        key = str(fa.get("key") or "").strip()
        val = str(fa.get("value") or "").strip()
        if not key or not val:
            continue
        try:
            ep = int(fa.get("episode"))
        except Exception:
            ep = 0
        by_key.setdefault(key, []).append({
            "value": val, "episode": ep, "evidence": str(fa.get("evidence") or ""),
        })

    for key, vals in by_key.items():
        # 归一化 value 后看是否有 >1 个互斥取值
        norm = {}
        for v in vals:
            nv = re.sub(r"[\s，。、；;,.!?！？]", "", v["value"])
            norm.setdefault(nv, v)
        # 简单互斥判定: 归一化后有 2 个以上完全不同且互不包含的取值
        distinct = list(norm.keys())
        conflicting = []
        for a in range(len(distinct)):
            for b in range(a + 1, len(distinct)):
                x, y = distinct[a], distinct[b]
                if x and y and (x not in y) and (y not in x):
                    conflicting.append((norm[x], norm[y]))
        if conflicting:
            eps = sorted({v["episode"] for v in vals if v["episode"]})
            variants = "; ".join(f"第{v['episode']}集={v['value']}" for v in vals)
            issues.append({
                "type": "fact_conflict",
                "severity": "P0",
                "title": f"设定冲突: 「{key}」在全剧出现互斥说法 — {variants}",
                "episodes": eps,
                "anchor": f"全剧统一「{key}」为唯一版本, 修正其余集与之冲突的表述",
                "evidence": variants[:200],
            })

    return issues