"""资产查重的「AI 复审」（2026-10-28 用户需求）。

## 用户的两条要求

1. 「直接阅读全文成本显然太高、太慢，但如果不阅读原文 agent 显然也会大量错判。
   也许只有几个特定情况下的资产才应该引入 agent 读资产出现的对应剧本给出判断。」
2. 「机械化检查的深度不够，许多其实也不重要的道具没删除、或者存在角色仍然有
   重合的卡片的情况。」—— 复审**不只是给机械候选打分**，还要**找出机械判据漏掉的**。

## 三步，只有第二步读剧本

```
① 找候选（只读名字）    角色/场景/道具的全部名字 + 出场镜头数 → 「可能同指」的组
                         570 个资产的名字合计约 3300 字，几乎免费
② 核实（读出场剧本）    **只对 ① 点名的组**、以及机械判据拿不准的组（只差括号注释），
                         读组内每个名字出场镜头的剧本原文（每个名字截到 1500 字）
③ 道具取舍（读出场片段）全部道具 + 各自第一次出场的一句原文（约 50 字）
                         → 哪些只是陈设/背景可以删、哪些低频但关键要留
```

实测（项目 29afad1b：583 镜 / 13 万字正文）单个实体的出场正文中位数 698 字、
P90 6458 字、P99 9.4 万字（长剧主角）。所以"按组读"可行，但必须截断。

## 结果只是建议

AI 的结论只决定弹窗里**默认勾不勾**，执行永远由用户点。判错 = 用户取消一个勾选。
所以 ① 刻意放宽（漏报的代价远大于多报，多报的会在 ② 被剔掉）。

## 不走 agent run

理由见 `docs/PLAN-资产一键查重.md` 5.4（写操作不受 cap_fen 约束、结果截断 8000 字、
审批只有整批布尔等）。这里是普通的批量文本调用，作为 job 跑（有进度、可关弹窗）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from collections import defaultdict

from . import asset_dedupe
from .db import Shot, get_session

log = logging.getLogger(__name__)

#: ② 核实时每个名字读多少字的出场剧本。
#:
#: ⚠️ 第一版是 1500 字/名字，实测（项目 29afad1b）一次复审读了 **17 万字** —— 比全剧正文
#:    （13 万字）还多，等于没省。原因是组多（73 组）、大组名字多（一个场景组 17 个写法）。
#:    判"是不是同一个"靠的是**称谓出现的那几场**，名字自己的前两三镜就够。
#:    所以改成：每个名字 ≤ 600 字，每组再设总预算，大组按人头均分（最少 250 字）。
PER_MEMBER_CAP = 600
GROUP_BUDGET = 2400
PER_MEMBER_MIN = 250
#: ② 每次 LLM 调用核实几组（太多会让单次输出变长、半截 JSON 的风险上升）。
VERIFY_BATCH = 3
#: ① 每类最多接受多少个候选组（防模型把整张清单两两配对）。
MAX_FIND_GROUPS = 40
#: ③ 每次 LLM 调用判多少件道具。
PROP_BATCH = 120
#: ③ 每件道具附的出场片段长度。
PROP_SNIPPET = 50

KIND_CN = {"character": "角色", "location": "场景", "prop": "道具"}

_QUOTE_RULE = "所有说明文字里不要用英文双引号，引用名字一律用「」。"

_SYS_FIND = (
    "你在整理一部短剧拆解出来的{kind}清单（每行：名字｜出现在多少个镜头）。"
    "拆解时同一个{kind}常因称谓不同被拆成了多条，例如角色「老吴」「吴先生」「吴总」，"
    "场景「傅家客厅」「傅宅客厅」，道具「包」「包包」「名牌包」。\n"
    "请找出**可能**指同一个{kind}的名字组。要**宽松**：每组之后会有人读剧本逐一核实，"
    "漏掉一组的代价比多报一组大得多。\n"
    "但下面这些明显不是同一个，不要放进一组：亲属（「陆明父亲」≠「陆明」）、"
    "从属（「江总的秘书」≠「江总」）、同姓不同职（「张医生」「张护士」）、"
    "泛指群体（「保安们」）、同类但不同个体（「傅烬洲的手机」≠「尚宇的手机」）。\n"
    "同一个人的不同年龄段、不同造型的写法（「少年陆明」「陆明」，「傅烬洲（睡衣）」"
    "「傅烬洲（西装）」）**要**列出来。\n"
    "只输出组内 ≥2 个名字的组；名字必须原样来自清单，不许改写。" + _QUOTE_RULE + "\n"
    '严格输出 JSON：{{"groups":[{{"names":["名字1","名字2"],"why":"不超过20字"}}]}}，'
    '没有就输出 {{"groups":[]}}。'
)

_SYS_VERIFY = (
    "判断下面每组名字在剧情里是否指同一个{kind}。每个名字后面附了它出场镜头的剧本原文"
    "（可能有截断）。\n"
    "根据剧情判断：称谓不同但其实是同一个 → 放进同一个 cluster；不同个体 → 不要放一起。"
    "一组里可能只有一部分是同一个，按实际情况分 cluster。\n"
    "同一个人、但这些写法代表**不同的样子**（不同年龄段、不同服装、不同妆容，"
    "且在剧本里分别出现在不同的镜头）也算同一个，该 cluster 标 stage=true——"
    "合并时会按出场镜头把各自的样子转成造型阶段。只是称呼不同、样子一样的标 stage=false。\n"
    "每个 cluster 给出 keep：最适合当标准名的那个（通常是全名或出场最多的），必须原样来自该组。\n"
    "reason 要引用剧情依据，不超过 40 字。" + _QUOTE_RULE + "\n"
    '严格输出 JSON：{{"results":[{{"gid":1,"clusters":[{{"names":["a","b"],"keep":"a",'
    '"stage":false,"reason":"…"}}],"note":"不是同一个时说明原因"}}]}}。'
    "一组里没有任何两个是同一个时 clusters 给空数组。"
)

_SYS_PROPS = (
    "下面是短剧拆解出的道具清单。每行：编号｜道具名｜出现在多少个镜头｜第一次出场的原文片段。\n"
    "每件道具都会**单独生成一张参考图**并注入画面，道具太多既费钱又让画面参考变乱。\n"
    "判断：\n"
    "· **可以删**：场景里的普通陈设与背景物（桌椅、门、杯子、纸巾、餐具、普通食物饮料）、"
    "一闪而过且不影响剧情的物件、动作的附属物（「吸管」「筷子」）。删掉后画面里照样可以"
    "出现它，只是不再单独做参考图。**出现次数多不代表重要**：反复出现的门、桌子照样可以删。\n"
    "· **要保留**：推动剧情的关键物件（凶器、信物、合同、证据、反复特写的物品）、"
    "角色标志性物件（主角的车、常戴的饰品）。\n"
    "拿不准的两边都不要放。delete 列出可以删的；keep 只列**出现不超过 3 镜但你认为关键**的。"
    "why 不超过 20 字。" + _QUOTE_RULE + "\n"
    '严格输出 JSON：{"delete":[{"id":1,"why":"…"}],"keep":[{"id":5,"why":"…"}]}。'
)


def _parse_json(raw: str) -> dict:
    """容错解析。失败抛 ValueError。

    ⚠️ 不能用「第一个 { 到最后一个 }」整段去 loads（2026-10-28 实测）：模型偶尔会
    连着吐**两个** JSON 对象，整段解析报 `Extra data`，那一批核实就整个作废。
    这里用 `raw_decode` 只取第一个完整对象，后面的多余内容丢掉。
    """
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start = text.find("{")
    if start < 0:
        raise ValueError("没有 JSON 对象")
    obj, _end = json.JSONDecoder().raw_decode(text[start:])
    if not isinstance(obj, dict):
        raise ValueError("JSON 不是对象")
    return obj


async def _llm_json(system: str, user: str, model_id: str | None) -> dict:
    """调一次文本模型并解析成 JSON；**解析失败重试一次**（模型输出偶发不合规）。

    ⚠️ temperature 传 1.0（2026-10-28 实测）：zx1 渠道上的 gpt-6-sol 拒绝非默认值
    （`Only the default (1) value is supported`），而 provider 会把这个 400 判成
    **模型级不可用、整条渠道冷却 120 秒** —— 一次复审能把全站同模型的调用都拖慢。
    这是 provider 层的共性问题（costumes / prompt_opt 也传了 0.2~0.3），不在本模块修；
    这里先避开它。
    """
    from .providers.llm import LLMProvider
    last: Exception | None = None
    for _ in range(2):
        raw = await LLMProvider(model_id=model_id).complete(system, user, temperature=1.0)
        try:
            return _parse_json(raw)
        except (ValueError, TypeError) as e:
            last = e
    raise ValueError(f"模型两次都没返回合规 JSON：{last}")


def _prop_snippets(session, project_id: str, names: set[str]) -> dict[str, str]:
    """每件道具**第一次出场**那一镜的原文片段（以道具名为中心截 ~50 字）。"""
    out: dict[str, str] = {}
    shots = (session.query(Shot).filter(Shot.project_id == project_id)
             .order_by(Shot.order).all())
    for sh in shots:
        try:
            props = json.loads(sh.props or "[]")
        except (ValueError, TypeError):
            continue
        if not isinstance(props, list):
            continue
        txt = re.sub(r"\s+", " ", sh.script_ref or "").strip()
        for p in props:
            if not isinstance(p, str):
                continue
            n = p.strip()
            if n not in names or n in out:
                continue
            i = txt.find(n)
            if i < 0:
                out[n] = txt[:PROP_SNIPPET]
            else:
                lo = max(0, i - PROP_SNIPPET // 2)
                out[n] = txt[lo:lo + PROP_SNIPPET]
    return out


class _UF:
    """并查集（按 asset id）。"""

    def __init__(self) -> None:
        self.p: dict[str, str] = {}

    def find(self, a: str) -> str:
        self.p.setdefault(a, a)
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


async def review(project_id: str, *, model_id: str | None = None,
                 progress=None) -> dict:
    """跑一次 AI 复审，返回**完整的、修订过的**查重清单（形状同 `/asset-duplicates`）。

    `progress(label, done, total)`：阶段回调，给 job 的进度条用。

    返回在 `/asset-duplicates` 的基础上多出：
      · 每组 `source`（rule|ai）、`verdict`（same|different|stage|None）、
        `verdict_reason`、`key`
      · 每件道具 `ai`（delete|keep|None）、`ai_reason`
      · `stats.read_chars`（本次一共读了多少字剧本）、`notes`（失败的批次）
    """
    from .config import get_settings

    def _p(label: str, done: int = 0, total: int = 0) -> None:
        if progress:
            try:
                progress(label, done, total)
            except Exception:  # noqa: BLE001 进度上报不影响主流程
                pass

    notes: list[str] = []
    sem = asyncio.Semaphore(max(1, get_settings().default_concurrency))   # 既有并发，不新增
    llm_calls = 0

    with get_session() as s:
        base = asset_dedupe.find_groups(s, project_id)
        items = {k: asset_dedupe.asset_items(s, project_id, k) for k in asset_dedupe.KINDS}
        props_mech = asset_dedupe.prop_delete_candidates(s, project_id)
        all_prop_names = {x["name"].strip() for x in items["prop"] if x["name"].strip()}
        snippets = _prop_snippets(s, project_id, all_prop_names)

    by_id = {k: {x["id"]: x for x in v} for k, v in items.items()}
    name_ids: dict[str, dict[str, list[str]]] = {k: defaultdict(list) for k in items}
    for k, v in items.items():
        for x in v:
            name_ids[k][x["name"].strip()].append(x["id"])

    async def _call(system: str, user: str):
        nonlocal llm_calls
        async with sem:
            llm_calls += 1
            return await _llm_json(system, user, model_id)

    # ---------------- ③ 道具取舍：读出场片段 ----------------
    prop_rows = sorted(items["prop"], key=lambda x: (x["shot_refs"], x["name"]))
    prop_verdict: dict[str, tuple[str, str]] = {}     # id → (delete|keep, why)
    pbatches = [prop_rows[i:i + PROP_BATCH] for i in range(0, len(prop_rows), PROP_BATCH)]

    async def _props(batch: list[dict]):
        idx = {i: x for i, x in enumerate(batch, 1)}
        body = "\n".join(
            f"{i}｜{x['name']}｜{x['shot_refs']}｜{snippets.get(x['name'].strip(), '')}"
            for i, x in idx.items())
        try:
            d = await _call(_SYS_PROPS, body)
        except Exception as e:  # noqa: BLE001
            log.warning("[dedupe-ai] 道具取舍失败（项目 %s）: %r", project_id, e)
            notes.append(f"有 {len(batch)} 件道具的取舍判断失败，这部分只用了机械判据")
            return
        for verdict in ("delete", "keep"):
            for r in d.get(verdict) or []:
                try:
                    x = idx[int(r.get("id"))]
                except (TypeError, ValueError, KeyError):
                    continue
                prop_verdict[x["id"]] = (verdict, str(r.get("why") or "").strip()[:60])

    # ③ 与 ①② **并行**：它不依赖候选与核实。第一版是串行的，实测整轮 201 秒，
    #    其中道具这一段白等了 158 秒。
    props_task = asyncio.ensure_future(asyncio.gather(*[_props(b) for b in pbatches]))

    # ---------------- ① 找候选：只读名字 ----------------
    _p("AI 正在看全部名字，找可能重复的", 0, 0)

    async def _find(kind: str) -> list[list[str]]:
        names = sorted(name_ids[kind], key=lambda n: -len(name_ids[kind][n]))
        if len(names) < 2:
            return []
        refs = {x["name"].strip(): x["shot_refs"] for x in items[kind]}
        body = "\n".join(f"{n}｜{refs.get(n, 0)}" for n in sorted(names))
        try:
            d = await _call(_SYS_FIND.format(kind=KIND_CN[kind]), body)
        except Exception as e:  # noqa: BLE001 单类失败不拖垮整轮
            log.warning("[dedupe-ai] %s 找候选失败（项目 %s）: %r", kind, project_id, e)
            notes.append(f"{KIND_CN[kind]}的候选查找失败，这一类只用了机械判据")
            return []
        out = []
        for g in (d.get("groups") or [])[:MAX_FIND_GROUPS]:
            ns = [n.strip() for n in (g.get("names") or []) if isinstance(n, str)]
            ns = list(dict.fromkeys(n for n in ns if n in name_ids[kind]))   # 只认清单里的
            if len(ns) >= 2:
                out.append(ns)
        return out

    found = dict(zip(asset_dedupe.KINDS,
                     await asyncio.gather(*[_find(k) for k in asset_dedupe.KINDS])))

    # ---------------- 组装待核实的组 ----------------
    #   · ① 点名的组
    #   · 机械组里 needs_ai 的（只差括号注释）
    #   与机械组有交集的，把机械组整组并进来一起核实（否则会出现两组各占一半的同一个人）。
    verify: dict[str, list[dict]] = {k: [] for k in asset_dedupe.KINDS}
    absorbed: set[str] = set()             # 被并进核实组的机械组 key
    mech_by_kind: dict[str, list[dict]] = defaultdict(list)
    for g in base["groups"]:
        g["key"] = asset_dedupe.group_key(g["kind"], [a["id"] for a in g["assets"]])
        g["source"] = "rule"
        mech_by_kind[g["kind"]].append(g)

    for kind in asset_dedupe.KINDS:
        uf = _UF()
        seeds: list[set[str]] = []
        for ns in found[kind]:
            ids = [i for n in ns for i in name_ids[kind][n]]
            seeds.append(set(ids))
        for g in mech_by_kind[kind]:
            if g["needs_ai"]:
                seeds.append({a["id"] for a in g["assets"]})
        for ids in seeds:
            ids = list(ids)
            for i in ids[1:]:
                uf.union(ids[0], i)
        # 与机械组相交 → 整组并入
        touched = {i for ids in seeds for i in ids}
        for g in mech_by_kind[kind]:
            gids = [a["id"] for a in g["assets"]]
            if touched & set(gids):
                for i in gids[1:]:
                    uf.union(gids[0], i)
                absorbed.add(g["key"])
        comps: dict[str, set[str]] = defaultdict(set)
        for i in list(uf.p):
            comps[uf.find(i)].add(i)
        for ids in comps.values():
            names = sorted({by_id[kind][i]["name"].strip() for i in ids})
            if len(names) >= 2:
                verify[kind].append({"ids": ids, "names": names})

    # ---------------- ② 核实：只读这几组的出场剧本 ----------------
    read_chars = 0
    jobs: list[tuple[str, list[dict]]] = []
    for kind, gs in verify.items():
        for i in range(0, len(gs), VERIFY_BATCH):
            jobs.append((kind, gs[i:i + VERIFY_BATCH]))
    done_n = 0
    _p("AI 正在读相关剧情核实", 0, len(jobs))

    async def _verify(kind: str, batch: list[dict]):
        nonlocal read_chars, done_n
        texts: dict[str, str] = {}
        with get_session() as s:
            for g in batch:
                cap = max(PER_MEMBER_MIN,
                          min(PER_MEMBER_CAP, GROUP_BUDGET // max(1, len(g["names"]))))
                texts.update(asset_dedupe.shot_texts(s, project_id, kind, g["names"], cap=cap))
        parts = []
        for gi, g in enumerate(batch, 1):
            seg = [f"=== 第 {gi} 组 ==="]
            for n in g["names"]:
                t = texts.get(n) or "（没有找到出场原文）"
                read_chars += len(t)
                seg.append(f"【{n}】\n{t}")
            parts.append("\n".join(seg))
        try:
            d = await _call(_SYS_VERIFY.format(kind=KIND_CN[kind]), "\n\n".join(parts))
            res = {int(r.get("gid")): r for r in (d.get("results") or [])
                   if isinstance(r, dict) and str(r.get("gid", "")).isdigit()}
        except Exception as e:  # noqa: BLE001
            log.warning("[dedupe-ai] %s 核实失败（项目 %s）: %r", kind, project_id, e)
            res = None
        done_n += 1
        _p("AI 正在读相关剧情核实", done_n, len(jobs))
        return kind, batch, res

    verified = await asyncio.gather(*[_verify(k, b) for k, b in jobs])

    await props_task
    read_chars += sum(len(snippets.get(x["name"].strip(), "")) for x in prop_rows)

    # ---------------- 汇总成修订后的清单 ----------------
    groups_out: list[dict] = [g for g in base["groups"] if g["key"] not in absorbed]
    mech_index = {g["key"]: g for g in base["groups"]}

    def _mk_group(kind: str, ids: set[str], verdict: str | None, reason: str | None,
                  keep_name: str | None, source: str) -> dict:
        assets = sorted((by_id[kind][i] for i in ids),
                        key=lambda z: (not z["has_image"], -z["shot_refs"], z["name"]))
        cand = [a for a in assets if keep_name and a["name"].strip() == keep_name]
        keep = max(cand or assets, key=lambda z: (bool(z["has_image"]), z["shot_refs"]))
        key = asset_dedupe.group_key(kind, ids)
        old = mech_index.get(key)
        tier = None
        if kind == "prop":
            top = assets[0]
            tier = asset_dedupe._prop_tier(top["shot_refs"], top["has_image"], bool(top["desc"]))
        return {
            "kind": kind, "key": key,
            "reason": old["reason"] if old else "AI 读剧情后认为是同一个",
            "assets": assets,
            "suggest_keep": {"id": keep["id"], "name": keep["name"]},
            "tier": tier,
            "needs_ai": False,
            "source": source,
            "verdict": verdict, "verdict_reason": reason,
            # stage 也默认勾：合并时转成造型，不会丢掉各自的样子（见 asset_merge._age_stage_to_stage）
            "default_checked": verdict in ("same", "stage"),
        }

    ai_new = 0
    for kind, batch, res in verified:
        for gi, g in enumerate(batch, 1):
            r = (res or {}).get(gi) if res is not None else None
            mech_in = [mech_index[k] for k in absorbed
                       if mech_index[k]["kind"] == kind
                       and {a["id"] for a in mech_index[k]["assets"]} <= g["ids"]]
            if res is None or r is None:
                # 核实失败：机械组原样放回（不带结论），AI 新发现的不出（未核实不推荐）
                for m in mech_in:
                    groups_out.append(m)
                if res is None:
                    notes.append(f"有一批{KIND_CN[kind]}没能核实，保留机械判据的结果")
                continue
            uf = _UF()
            for i in g["ids"]:
                uf.find(i)
            meta: dict[str, tuple[bool, str, str]] = {}      # root → (age, reason, keep)
            for c in r.get("clusters") or []:
                ns = [n.strip() for n in (c.get("names") or []) if isinstance(n, str)]
                ids = [i for n in ns if n in g["names"] for i in name_ids[kind][n]
                       if i in g["ids"]]
                for i in ids[1:]:
                    uf.union(ids[0], i)
                if len(ids) >= 2:
                    meta[ids[0]] = (bool(c.get("stage") or c.get("age_stage")),
                                    str(c.get("reason") or "").strip()[:80],
                                    str(c.get("keep") or "").strip())
            # 字面完全同名的机械组（非 needs_ai）是确定的，AI 拆开也不算数
            for m in mech_in:
                if not m["needs_ai"]:
                    mids = [a["id"] for a in m["assets"]]
                    for i in mids[1:]:
                        uf.union(mids[0], i)
            comps: dict[str, set[str]] = defaultdict(set)
            for i in g["ids"]:
                comps[uf.find(i)].add(i)
            emitted = False
            for root, ids in comps.items():
                if len(ids) < 2:
                    continue
                info = next((meta[k] for k in meta if uf.find(k) == root), None)
                age, reason, keepn = info if info else (False, None, None)
                in_one_mech = any(ids <= {a["id"] for a in m["assets"]} for m in mech_in)
                # stage：同一个人、不同样子 → 合并时转成造型阶段（as_stages），
                # 用户 2026-10-28 裁定「这是造型阶段该解决的事，应该合并」，所以照样默认勾选。
                # 造型阶段只有角色有。场景/道具即使模型标了 stage，也只是普通合并，
                # 标成「合并为造型」会误导用户以为会多出造型（2026-10-28 实测场景被标了 stage）。
                age = age and kind == "character"
                verdict = "stage" if age else "same"
                if age:
                    reason = (reason or "同一个人、不同样子") + "；合并时按出场镜头转成造型阶段"
                groups_out.append(_mk_group(kind, ids, verdict, reason, keepn,
                                            "rule" if in_one_mech else "ai"))
                if not in_one_mech:
                    ai_new += 1
                emitted = True
            # 机械判据拿不准、AI 判定不是同一个：照样列出来但不勾，让用户看到理由
            for m in mech_in:
                mids = {a["id"] for a in m["assets"]}
                if not any(len(ids) >= 2 and mids & ids for ids in comps.values()):
                    groups_out.append({**m, "verdict": "different",
                                       "verdict_reason": str(r.get("note") or
                                                             "AI 读剧情后认为不是同一个")[:80],
                                       "default_checked": False})
            if not emitted and not mech_in:
                pass          # AI 自己提的候选、核实后不是：不打扰用户

    # 道具组：组内**每一件** AI 都判了"可以删" → 不合并，直接让它们进删除清单。
    # 实测（29afad1b）「办公室大门」五种写法被并成一组，而 AI 同时说它们都只是陈设——
    # 把五张没用的卡合成一张没用的卡，用户还得再删一次，纯属多余。
    junk = [g for g in groups_out if g["kind"] == "prop"
            and all(prop_verdict.get(a["id"], ("", ""))[0] == "delete" for a in g["assets"])]
    if junk:
        jk = {g["key"] for g in junk}
        groups_out = [g for g in groups_out if g["key"] not in jk]
        ai_new -= sum(1 for g in junk if g["source"] == "ai")

    groups_out.sort(key=lambda g: (-sum(1 for a in g["assets"] if a["has_image"]),
                                   -sum(a["shot_refs"] for a in g["assets"])))

    # 道具清单：机械候选 + AI 认为可删的高频道具；AI 认为关键的低频道具默认不勾
    props_out: list[dict] = []
    seen: set[str] = set()
    for p in props_mech:
        v = prop_verdict.get(p["id"])
        p = {**p, "ai": v[0] if v else None, "ai_reason": v[1] if v else None}
        if v and v[0] == "keep":
            p["default_checked"] = False
        props_out.append(p)
        seen.add(p["id"])
    for pid_, (v, why) in prop_verdict.items():
        if v != "delete" or pid_ in seen:
            continue
        x = by_id["prop"].get(pid_)
        if not x:
            continue
        props_out.append({
            "id": x["id"], "name": x["name"], "shot_refs": x["shot_refs"],
            "has_image": x["has_image"], "desc": x["desc"],
            "tier": asset_dedupe._prop_tier(x["shot_refs"], x["has_image"], bool(x["desc"])),
            "default_checked": True, "ai": "delete", "ai_reason": why,
        })
    props_out.sort(key=lambda x: (x["shot_refs"], not x["has_image"], x["name"]))

    return {
        "ok": True,
        "reviewed": True,
        "groups": groups_out,
        "unused_props": props_out,
        "stats": {
            **base["stats"],
            "total_groups": len(groups_out),
            "unused_props": len(props_out),
            "ai_new_groups": ai_new,
            "ai_verified_groups": sum(len(v) for v in verify.values()),
            "ai_props_delete": sum(1 for v, _ in prop_verdict.values() if v == "delete"),
            "ai_props_keep": sum(1 for v, _ in prop_verdict.values() if v == "keep"),
            "read_chars": read_chars,
            "llm_calls": llm_calls,
        },
        "notes": list(dict.fromkeys(notes)),
    }


async def run_asset_dedupe_ai(jid: str) -> None:
    """job 入口：`POST /v2/jobs {kind: "asset_dedupe_ai", payload: {project_id}}`。

    走通用 job 通道是为了白拿三样：同项目去重（双击不跑两遍）、归属校验、
    按操作计费（`charge.TEXT_KINDS`，与拆解/服装识别同口径，0.5 元/次）。
    结果整份写进 `job.result`，前端拿到后**替换**弹窗里的清单。
    """
    from .jobs import _update, get_job, set_job_phase

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload or "{}")
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return
    _update(jid, status="running", progress=1)

    def _progress(label: str, done: int, total: int) -> None:
        set_job_phase(jid, {"key": "asset_dedupe_ai", "label": label,
                            "done": done, "total": total})

    try:
        out = await review(project_id, model_id=p.get("model_id"), progress=_progress)
    except Exception as e:  # noqa: BLE001 失败要说清楚，不能静默
        log.exception("[dedupe-ai] 复审失败（项目 %s）", project_id)
        _update(jid, status="failed", error=f"AI 复审失败：{type(e).__name__}: {e}"[:300])
        return
    _update(jid, status="done", progress=100,
            result=json.dumps(out, ensure_ascii=False))
