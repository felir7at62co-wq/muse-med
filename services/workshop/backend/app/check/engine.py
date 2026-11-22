"""体检引擎 —— 自动审稿全剧本。

四种体检, 可单跑可全跑:

  structure    大纲结构: 契约/钩子链/升级/伏笔/因果/价值翻转  ← stages/drama_gate, 零 LLM
  style        中文文风: 翻译腔/外语残留/欧美剧术语/AI 味     ← stages/chinese_style, 零 LLM
  consistency  一致性: 人名漂移(新, 零 LLM) + LLM 语义矛盾
  script       剧本格式: 场次头三行/对白行/△/字幕行的往返可解析性

为什么体检要直连 ScriptChapter / ScriptStoryboard 而不走 context_loader:
后者为**对话**设计, 整本上限约 3500 字(只带最后一集正文的前 1500 字)。体检的
全部意义就是"通读全剧", 被那个上限截掉的部分恰恰是最容易出问题的后半本。

两条贯穿全引擎的裁定(与项目既有决策一致):
  · **硬伤(error)只由确定性规则产出**。LLM 层的发现一律降为 warn。这样"硬伤数"
    在同一份稿子上可复现 —— 修一次就能归零, 不会被 LLM 每次换一批说法反复打脸。
  · **只标注不改写**。引擎绝不改库, 改动一律走 check/fixer.py。
"""
from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timezone

from sqlalchemy import select

from ..db import session_scope, ScriptDraft, ScriptChapter, ScriptStoryboard
from ..models.llm import get_llm
from ..rewrite.parser import parse_episode, serialize_episode
from . import prompts as P

logger = logging.getLogger("check.engine")

#: 全部体检项。前端「一键全查」= 这五项。
#: `divergence` 是 2026-09-21 新增的"大纲与稿子对不上"维度 ——
#: **只在用户主动体检时才算**（不做后台扫描、不在保存后自动分析）。
ALL_KINDS = ("structure", "style", "consistency", "script", "divergence")

KIND_LABEL = {
    "structure": "结构体检",
    "style": "文风体检",
    "consistency": "一致性体检",
    "script": "剧本体检",
    "divergence": "大纲与稿子分岔",
}

#: 单条 issue 列表的返回条数上限。50 集的大纲光文风问题就可能上百条,
#: 全塞进 SSE 会把前端卡死; 前端要的是"有多少、最严重的是哪些"。
MAX_ISSUES = 60

#: LLM 语义层每批集数。与 rewrite 的批次无关 —— 这里只求覆盖率, 不产出文本。
_LINT_BATCH = 12

_RE_EP_HEAD = re.compile(r"^第\s*(\d+)\s*集")

#: 人名归一: 疑似缀字集合。剥掉它们后**还剩 ≥2 字**才认作同一个人的词干
#: （判据见 _stem）。短剧里"林晚/林小晚/林婉儿"是同一个人的三种写法 ——
#: 这是最高频的硬伤, 且零成本可查。
#
#: ⚠️ 2026-10-08 修正: 旧实现无条件 `replace()` 掉这些字，导致
#:   · `老陈`/`小陈` 同簇 —— 而短剧里这几乎总是父子/师徒**两个人**，
#:     被报成"同一个人的不同写法"就是**误判**（用户这次报的正是这类）；
#:   · `王子`→`王`、`柱子`→`柱` —— "子/儿"是常见**名**字，不只是缀字。
#: 现改为"剥完必须还剩 ≥2 字"，两个字以下的词干不认（那基本只剩姓）。
_NAME_NOISE = ("小", "大", "老", "阿", "儿", "子")
_NAME_STRIP_RE = re.compile(r"[·・\s\.\-—_]")

#: 疑似人名的最短/最长字数。1 字多为"妈/爸/医生"这类称谓, 单列; 超过 6 字基本是误匹配。
_NAME_MIN, _NAME_MAX = 2, 6

#: 明显不是人名的说话人(旁白/群体/功能标记)。这些出现多少次都不算漂移。
_NON_NAME = {
    "旁白", "字幕", "画外音", "内心", "众人", "所有人", "大家", "群众", "记者",
    "主持人", "电话", "手机", "广播", "画外", "VO", "OS", "全体", "员工", "路人",
    "系统", "提示", "镜头", "特写",
}


# ---------------------------------------------------------------------------
# 数据装载
# ---------------------------------------------------------------------------

async def load_draft_episodes(draft_id: int) -> dict:
    """读整部草稿的正文/剧本 + 大纲。**不受 context_loader 的长度上限约束。**

    返回 {"kind", "episodes":[{order,title,text,shots}], "outline", "title"}
    """
    async with session_scope() as s:
        d = await s.get(ScriptDraft, draft_id)
        if not d:
            return {"kind": "none", "episodes": [], "outline": {}, "title": "",
                    "error": f"草稿 {draft_id} 不存在"}
        outline = d.outline or {}
        title = d.title or f"草稿{draft_id}"
        sbs = (await s.execute(
            select(ScriptStoryboard).where(ScriptStoryboard.draft_id == draft_id)
            .order_by(ScriptStoryboard.chapter_order)
        )).scalars().all()
        chs = (await s.execute(
            select(ScriptChapter).where(ScriptChapter.draft_id == draft_id)
            .order_by(ScriptChapter.chapter_order)
        )).scalars().all()

    # 与 rewrite 同一套优先级: 有剧本就用剧本(它才是最终拍摄稿), 否则用正文。
    if sbs:
        eps = []
        for sb in sbs:
            shots = sb.shots_json or []
            eps.append({"order": int(sb.chapter_order), "title": "",
                        "shots": shots,
                        "text": serialize_episode(shots, ep=int(sb.chapter_order))})
        return {"kind": "storyboard", "episodes": eps, "outline": outline, "title": title}
    eps = []
    for ch in chs:
        body = ch.full_text or ""
        if not body.strip():
            continue
        eps.append({"order": int(ch.chapter_order), "title": ch.title or "",
                    "shots": None,
                    "text": f"第{int(ch.chapter_order)}集 {ch.title or ''}".rstrip() + "\n\n" + body})
    return {"kind": "chapter", "episodes": eps, "outline": outline, "title": title}


def norm_scope(scope, episodes: list) -> tuple[int, int] | None:
    """把前端传来的 scope 归一成 (start, end) 并夹到实际存在的集区间。

    范围不合法(倒序/越界/空)一律**当作整本** —— 用户已经表达了"我要查这批"的意图,
    回 400 让他去改输入框是最差的选择; 给他全本, 他至少能得到东西。
    """
    orders = sorted(int(e["order"]) for e in episodes)
    if not orders:
        return None
    lo, hi = orders[0], orders[-1]
    if not isinstance(scope, dict):
        return None
    try:
        a = scope.get("start_ep")
        b = scope.get("end_ep")
        a = int(a) if a not in (None, "", 0) else None
        b = int(b) if b not in (None, "", 0) else None
    except (TypeError, ValueError):
        return None
    if a is None and b is None:
        return None
    a = a if a is not None else lo
    b = b if b is not None else hi
    if a > b:
        a, b = b, a
    a, b = max(a, lo), min(b, hi)
    if a > b:
        return None
    if a == lo and b == hi:
        return None
    return (a, b)


def _in_scope(order: int, sc: tuple[int, int] | None) -> bool:
    return True if sc is None else (sc[0] <= order <= sc[1])


def _issue(level: str, code: str, episode, message: str,
           detail: dict | None = None, fix_hint: str = "") -> dict:
    return {"level": level, "code": code, "episode": episode, "message": message,
            "detail": detail or {}, "fix_hint": fix_hint}


# ---------------------------------------------------------------------------
# 1) 结构体检 —— 零 LLM, 直接用现有门禁
# ---------------------------------------------------------------------------

async def check_structure(data: dict, sc: tuple[int, int] | None) -> dict:
    """大纲结构门禁。复用 stages/drama_gate.check_outline（已有 6 大类检查）。"""
    from ..stages.drama_gate import check_outline

    outline = data.get("outline") or {}
    eps = outline.get("chapters") or outline.get("episodes") or []
    if not eps:
        return _pack([_issue(
            "warn", "no_outline", None,
            "这部剧还没有大纲，没有可做的结构体检。",
            fix_hint="先让 AI 生一版大纲（可以直接说「写一版50集大纲」）")], 0)

    try:
        # include_style=False：文风是本引擎独立的一类（check_style 扫同一份大纲），
        # 让 drama_gate 也扫会把同一条问题在「一键体检」里报两遍。
        rep = check_outline(outline, include_style=False)
    except Exception as ex:  # noqa: BLE001
        logger.warning("结构体检失败: %s", ex)
        return _pack([_issue("warn", "check_failed", None, f"结构体检异常：{ex}")], 0)

    issues = list(rep.get("issues") or [])
    if sc:  # 只保留范围内 + 无集号的全局问题(如"老大纲缺契约")
        issues = [i for i in issues
                  if i.get("episode") is None or _in_scope(int(i.get("episode") or 0), sc)]
    return _pack(issues, len(eps), extra={"structure": rep.get("structure") or {}})


# ---------------------------------------------------------------------------
# 2) 文风体检 —— 零 LLM
# ---------------------------------------------------------------------------

async def check_style(data: dict, sc: tuple[int, int] | None) -> dict:
    """中文文风: 大纲字段 + 每集正文/剧本。全部零 LLM 规则命中。"""
    from ..stages.chinese_style import scan_outline_style, scan_chinese_style

    issues: list[dict] = []
    outline = data.get("outline") or {}
    if outline:
        issues += scan_outline_style(outline)
    scanned = 0
    for ep in data.get("episodes") or []:
        order = int(ep["order"])
        if not _in_scope(order, sc):
            continue
        scanned += 1
        # 剧本用分镜文本(它就是最终稿); 正文用 full_text。
        # 剥掉 `场:` / `景:` / `人物:` / `△` 这些格式锚点再查 —— 它们不是中文文案,
        # 混进去会误报"英文单词"(如 `OS`)。
        body = _strip_anchors(ep.get("text") or "")
        issues += scan_chinese_style(body, where=f"第{order}集", episode=order)
    return _pack(issues, scanned)


_ANCHOR_RE = re.compile(r"^(场[:：]|景[:：]|人物[:：]|△|\(出字幕|（出字幕)")


def _strip_anchors(text: str) -> str:
    """去掉剧本格式锚点行, 只留人写的中文内容。"""
    keep = []
    for ln in (text or "").split("\n"):
        t = ln.strip()
        if not t or _ANCHOR_RE.match(t):
            continue
        keep.append(t)
    return "\n".join(keep)


# ---------------------------------------------------------------------------
# 3) 一致性体检 —— 人名漂移(零 LLM) + LLM 语义层
# ---------------------------------------------------------------------------

def _norm_name(name: str) -> str:
    """归一化人名用于聚类: 去间隔号/空白, 去掉常见的亲昵前后缀用字。"""
    n = _NAME_STRIP_RE.sub("", str(name or "").strip())
    return n


def _stem(name: str) -> str:
    """取"词干"用于判定两个写法是不是同一个人。

    ⚠️ 2026-10-08 修正。旧实现是 ``n.replace(t, "")`` 无条件剥字，两个后果：

      1. **把不同的人并成一簇**：``老陈``/``小陈`` 都被剥成 ``陈``。
         短剧里"老陈是小陈他爸"是极常见的设定，两个不同的人被报成
         "同一个人的不同写法" —— 用户看到的就是**误判**，代价是让他去改一个
         本来没问题的名字（误报贵于漏报）。
      2. **误伤名字本身的用字**：``王子``→``王``、``柱子``→``柱``。
         "子/儿"在中文人名里是常见**名**字，不只是缀字。

    新判据：**剥完必须还剩 ≥2 字才认这个词干**，否则原样返回。

      · ``林小晚`` → 剥掉中间的 ``小`` → ``林晚``（2 字）✓ 仍然能合并到 ``林晚``
        —— 这是本检测要抓的头号场景，绝不能被这次修正弄丢。
      · ``老陈``/``小陈`` → 剥完只剩 ``陈``（1 字）→ 不认，各保留原样 → 不再同簇。
      · ``王子`` → 剥完只剩 ``王`` → 不认，保留 ``王子``。

    依据：剥完只剩一个字时，那个字基本就是**姓**。同姓不同人是常态，
    不足以判定"同一个人的写法漂移"。真正的人名漂移（林晚/林小晚、林婉儿）
    剥完一定还剩 ≥2 字。
    """
    n = _norm_name(name)
    if len(n) <= 2:
        return n            # 2 字及以下没有可剥的余地：剥完必然只剩 1 字
    stripped = n
    for t in _NAME_NOISE:
        stripped = stripped.replace(t, "")
    return stripped if len(stripped) >= 2 else n


#: 说明: 曾试图用"共享 2 字前缀"把 `林晚`/`林婉` 这类**字形笔误**也并成一簇, 好让
#: 「林婉儿」不至于自成单写法一簇而被漏掉。实测此路不通 —— 中文人名里
#: 「林晚/林婉儿」(同一个人) 与「张三/张四」(两个不同的人) 的公共前缀长度、
#: 编辑距离、名字长度**全都一样**, 任何基于字符统计的判据在抓住前者的同时
#: 一定会错并后者。误报会让用户去改一个本来没问题的名字, 代价高于漏报,
#: 故这里**只做精确词干聚类**(能可靠抓住"林晚/林小晚"这类缀字漂移)。
#: 字形笔误那一类交由 `_llm_consistency` 兜底。
def detect_name_drift(episodes: list, sc: tuple[int, int] | None) -> list[dict]:
    """查人名漂移: 同一个人的不同写法。**零 LLM**。

    短剧最高频的硬伤之一, 且现有任何检查都不覆盖 —— `check_outline` 查大纲契约,
    `scan_chinese_style` 查文风, 没人看"说话人名字是不是同一个人"。

    判定: 按词干聚类, 同簇出现 ≥2 种写法即报。只出现 1 次的写法降级为 warn
    (可能是偶发错字, 也可能是只出场一次的路人 —— 交给用户判断)。
    """
    from collections import Counter, defaultdict

    variants: dict[str, Counter] = defaultdict(Counter)
    where_of: dict[tuple[str, str], set] = defaultdict(set)   # (词干, 写法) -> 集号集合
    for ep in episodes:
        order = int(ep["order"])
        if not _in_scope(order, sc):
            continue
        for nm, _cnt in _speakers(ep.get("shots"), ep.get("text") or "").items():
            clean = _norm_name(nm)
            if not clean or clean in _NON_NAME:
                continue
            if not (_NAME_MIN <= len(clean) <= _NAME_MAX):
                continue
            st = _stem(clean)
            if len(st) < 1:
                continue
            variants[st][clean] += _cnt
            where_of[(st, clean)].add(order)

    out: list[dict] = []
    for st, cnt in variants.items():
        forms = [f for f, _ in cnt.most_common()]
        if len(forms) < 2:
            continue
        total = sum(cnt.values())
        best = forms[0]
        # 出现次数少的那几种写法: 若只出现 1 次, 很像错字, 但那也可能是真配角(如"林母")。
        rare = [f for f in forms if cnt[f] <= 1]
        level = "warn" if len(rare) == len(forms) - 1 and cnt[best] >= 5 else "error"
        detail_forms = [{"name": f, "count": cnt[f],
                         "episodes": sorted(where_of[(st, f)])[:10]} for f in forms]
        # 定位只看**少数写法**在哪几集, 不看主流写法 —— 主流写法(如"林晚")本来就每集都有,
        # 把它算进来会让 eps 永远 >1, episode 恒为 None, 于是这条最该修的问题反而
        # 落不进 run_fix 的正文修复通道(无集号的问题会被静默丢弃)。
        # 用户看到的「第 N 集」也随之从"全剧都有"变成"该改的是这几集"。
        eps_all = sorted({e for f in forms[1:] for e in where_of[(st, f)]})
        # 有少数写法的集就用最早的当落点(至少让「改这个」有靶子), 没有则整簇无集号。
        ep = eps_all[0] if eps_all else None
        fallback = sorted({e for f in forms for e in where_of[(st, f)]})
        where_label = "、".join(str(e) for e in (eps_all or fallback)[:12])
        out.append(_issue(
            level, "name_drift", ep,
            f"「{'/'.join(forms)}」像是同一个人的不同写法（共出现 {total} 次）"
            f"，少数写法出现在第 {where_label} 集。",
            {"stem": st, "forms": detail_forms, "drift_eps": eps_all,
             "canonical": best, "scope": "multi" if len(eps_all) > 1 else "single"},
            f"统一成一个写法（建议用出现最多的「{best}」）"
            + ("，全剧一起改" if len(eps_all) > 1 else "")))
    out.sort(key=lambda x: (0 if x["level"] == "error" else 1,
                            -(x["detail"]["forms"][0]["count"] if x["detail"].get("forms") else 0)))
    return out


def _speakers(shots, text: str):
    """统计一集里每个说话人出现多少次。优先走 shots(结构化, 无歧义)。"""
    from collections import Counter

    c: Counter = Counter()
    if shots:
        for scene in (shots or []):
            if not isinstance(scene, dict):
                continue
            for e in (scene.get("elements") or []):
                if isinstance(e, dict) and e.get("type") == "dialogue":
                    nm = str(e.get("character") or "").strip()
                    if nm:
                        c[nm] += 1
        return c
    # 正文没有结构化数据, 只能按"冒号前是名字"这个剧本文本惯例抽。
    # 用与 parser 同一套正则, 保证与剧本路径的判定一致。
    from ..rewrite.parser import _RE_DIALOGUE

    for ln in (text or "").split("\n"):
        m = _RE_DIALOGUE.match(ln.strip())
        if m:
            nm = m.group(1).strip()
            if nm:
                c[nm] += 1
    return c


async def check_consistency(data: dict, sc: tuple[int, int] | None,
                            provider: str, deep: bool) -> dict:
    """一致性: 人名漂移(确定性, 可 error) + LLM 语义层(一律 warn)。"""
    issues = detect_name_drift(data.get("episodes") or [], sc)
    packed = _pack(issues, len(data.get("episodes") or []))
    packed["characters"] = _character_index(data.get("episodes") or [], sc)
    packed["drift"] = [i for i in packed["issues"] if i["code"] == "name_drift"]

    if deep:
        try:
            sem = await _llm_consistency(data, sc, provider)
        except Exception as ex:  # noqa: BLE001
            logger.warning("一致性 LLM 层失败(降级跳过): %s", ex)
            sem = []
        if sem:
            packed["issues"] = packed["issues"] + sem
            packed["issues"].sort(key=_issue_sort_key)
            packed = _resummarize(packed)
    return packed


def _character_index(episodes: list, sc: tuple[int, int] | None) -> list[dict]:
    """每集出场说话人一览。前端"角色"视图直接用这个, 不必再查库。"""
    out = []
    for ep in episodes:
        order = int(ep["order"])
        if not _in_scope(order, sc):
            continue
        c = _speakers(ep.get("shots"), ep.get("text") or "")
        if c:
            out.append({"episode": order,
                        "names": [{"name": n, "lines": k} for n, k in c.most_common(20)]})
    return out


async def _llm_consistency(data: dict, sc: tuple[int, int] | None, provider: str) -> list[dict]:
    """LLM 语义层: 时间线/关系/设定/因果/人物崩坏/伏笔悬空。分批跑, 全降为 warn。"""
    from ..stages.consistency_lint import _extract_json
    from ..stages.state_ledger import snapshot_text

    eps = [e for e in (data.get("episodes") or []) if _in_scope(int(e["order"]), sc)]
    if not eps:
        return []
    outline = data.get("outline") or {}

    out: list[dict] = []
    valid_all = {int(e["order"]) for e in eps}

    for i in range(0, len(eps), _LINT_BATCH):
        batch = eps[i:i + _LINT_BATCH]
        start = int(batch[0]["order"])
        end = int(batch[-1]["order"])
        # 世界状态快照: 沿用 lint 的做法 —— 从第1集起时不注入快照, 否则 LLM 会
        # 臆造"第0集"并报时间线倒错的假硬伤。
        if start > 1:
            snap = snapshot_text(outline.get("state_ledger") or {}, start - 1)
        else:
            # 与 consistency_lint 同一裁定: 不能注入"截至第0集"的快照,
            # 否则 LLM 会臆造出不存在的"第0集"并报时间线倒错的假硬伤。
            snap = ("（本段从第1集开始，是故事开头，之前没有任何已发生的剧情。"
                    "不存在「第0集」。）")
        body = "\n\n".join(_ep_block(e) for e in batch)
        prompt = P.CHECK_PROMPT.format(snapshot=snap, start=start, end=end, script=body)
        try:
            llm = get_llm("extract", temperature=0, provider=provider)
            resp = await llm.ainvoke(
                [{"role": "system", "content": P.CHECK_SYSTEM},
                 {"role": "user", "content": prompt}])
            d = _extract_json(getattr(resp, "content", "") or "")
        except Exception as ex:  # noqa: BLE001
            logger.warning("一致性 LLM 第%d~%d集失败: %s", start, end, ex)
            continue

        for it in (d.get("issues") or []):
            try:
                ep_no = int(it.get("episode", 0))
            except (TypeError, ValueError):
                continue
            if ep_no not in valid_all:  # 丢弃臆造/越界集号
                continue
            msg = str(it.get("message") or "").strip()
            if not msg:
                continue
            out.append(_issue(
                "warn",                      # 硬伤只由规则层产出, 见模块 docstring
                "llm_" + str(it.get("code") or "semantic"), ep_no, msg,
                {"source": "llm"},
                str(it.get("fix_hint") or "").strip()))
    return out


def _ep_block(ep: dict) -> str:
    """给 LLM 的单集正文。截到 3000 字 —— 语义层看的是情节脉络不是文笔,
    整本 50 集全文塞进去会超窗口, 且对"有没有矛盾"这个判断没有增量。"""
    t = ep.get("text") or ""
    if len(t) > 3000:
        t = t[:1500] + "\n……（中间略）……\n" + t[-1500:]
    return f"【第{ep['order']}集】{ep.get('title') or ''}\n{t}"


# ---------------------------------------------------------------------------
# 4) 剧本体检 —— 往返可解析性, 零 LLM
# ---------------------------------------------------------------------------

def check_script(data: dict, sc: tuple[int, int] | None) -> dict:
    """剧本格式: 序列化 → 解析 → 再序列化, 比对是否等价。

    为什么用"往返等价"而不是逐行正则校验: 解析器就是导出/生成/精修共用的那一个。
    能往返等价 = 这份剧本在系统里**任何地方都不会被解析错**(导出 Word、精修、
    生成分镜都走同一个 parser)。不能等价 = 一定有一行格式错了, 而错误点
    恰好是 roundtrip_equivalent 给出的第一处差异。
    """
    from ..rewrite.parser import roundtrip_equivalent

    issues: list[dict] = []
    scanned = 0
    kind = data.get("kind")
    if kind != "storyboard":
        return _pack([_issue(
            "warn", "no_storyboard", None,
            "这部剧还没有剧本（分镜）数据，剧本体检只对剧本有效。",
            fix_hint="先让 AI 生成剧本（可以直接说「把正文改成剧本」）")], 0)

    for ep in data.get("episodes") or []:
        order = int(ep["order"])
        if not _in_scope(order, sc):
            continue
        scanned += 1
        shots = ep.get("shots") or []
        if not shots:
            issues.append(_issue("error", "empty_episode", order,
                                 f"第{order}集是空的（0 个场次）。",
                                 fix_hint="这一集需要重新生成"))
            continue
        ok, diff = roundtrip_equivalent(shots, ep=order)
        if not ok:
            issues.append(_issue(
                "error", "roundtrip_broken", order,
                f"第{order}集有一行的格式无法被系统解析：{diff[:200]}",
                {"diff": diff[:500]},
                "检查这一行的场次头/对白结构：`场:N-M` `景:` `人物:` `△` 或 `角色名: 台词`"))
        # 场次编号连续性: 场:3-1 / 场:3-3 跳号会让拍摄排期对不上。
        nums = []
        for s in shots:
            sn = str(s.get("scene_no") or "")
            m = re.search(r"(\d+)\s*$", sn)
            if m:
                nums.append(int(m.group(1)))
        if nums and nums != list(range(nums[0], nums[0] + len(nums))):
            issues.append(_issue("warn", "scene_no_gap", order,
                                 f"第{order}集的场次编号不连续：{nums[:20]}",
                                 {"scene_nos": nums}, "重新编号为连续的 1..N"))
    return _pack(issues, scanned)


# ---------------------------------------------------------------------------
# 打包 / 排序
# ---------------------------------------------------------------------------

_LEVEL_ORDER = {"error": 0, "warn": 1}


def _issue_sort_key(it: dict):
    return (_LEVEL_ORDER.get(it.get("level"), 2),
            it.get("episode") if it.get("episode") is not None else -1,
            it.get("code") or "")


def _pack(issues: list[dict], scanned: int, extra: dict | None = None) -> dict:
    """统一成前端报告卡的形状, 并分配稳定 issue id。"""
    issues = sorted(issues, key=_issue_sort_key)
    total = len(issues)
    shown = issues[:MAX_ISSUES]
    for i, it in enumerate(shown):
        it.setdefault("id", f"{it.get('code')}-{it.get('episode') or 0}-{i}")
    out = {
        "ok": not any(i["level"] == "error" for i in shown),
        "error": sum(1 for i in shown if i["level"] == "error"),
        "warn": sum(1 for i in shown if i["level"] == "warn"),
        "issues": shown,
        "truncated": total > MAX_ISSUES,
        "total": total,
        "scanned": scanned,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
    if extra:
        out.update(extra)
    return out


def _resummarize(packed: dict) -> dict:
    packed["ok"] = not any(i["level"] == "error" for i in packed["issues"])
    packed["error"] = sum(1 for i in packed["issues"] if i["level"] == "error")
    packed["warn"] = sum(1 for i in packed["issues"] if i["level"] == "warn")
    packed["total"] = len(packed["issues"])
    return packed


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------

async def check_divergence(draft_id: int, sc) -> dict:
    """「大纲与稿子分岔」维度 —— 只陈述事实，不推动作。

    事实类（人物状态、首次登场…）：世界变成了另一个样子 → 生成侧已按稿子为准，
      这里报 info，让用户知道计划过期了。
    承诺类（伏笔埋/收、本集禁止项）：承诺落空了 → 报 warn，
      因为它会让**将来那一集**的回收悬空（这正是不能"以稿子为准就完事"的原因）。

    ⚠️ 不出 error：用户亲手改出来的分岔是**意图**，不是硬伤
    （把它报成 error 正是改版前 consistency_lint 的毛病）。
    """
    from ..stages.divergence import scan_divergence
    rep = await scan_divergence(draft_id)
    issues: list[dict] = []
    for it in rep.get("items") or []:
        ep = it.get("episode")
        if sc and ep and not (sc[0] <= int(ep) <= sc[1]):
            continue
        promise = it.get("kind") == "promise"
        issues.append(_issue(
            "warn" if promise else "info",
            it.get("code") or "divergence",
            ep,
            f"计划：{it.get('plan')}｜实际：{it.get('actual')}",
            detail={"impact": it.get("impact"), "diverge_kind": it.get("kind")},
        ))
    return _pack(issues, len(rep.get("items") or []))


async def run_check(*, draft_id: int, kinds=None, scope=None,
                    provider: str = "gemini", deep: bool = True) -> dict:
    """跑体检。返回完整报告(可直接落 agent_messages.report_json)。

    kinds 为空 = ALL_KINDS。区块之间互不阻断: 任一区块抛异常只记一条 warn,
    其余照跑 —— 体检本身出问题不该让用户什么都拿不到。
    """
    t0 = time.time()
    kinds = [k for k in (kinds or ALL_KINDS) if k in ALL_KINDS] or list(ALL_KINDS)
    data = await load_draft_episodes(draft_id)
    if data.get("error"):
        return {"kind": "check", "draft_id": draft_id, "error": data["error"],
                "checks": {}, "totals": {"error": 0, "warn": 0}}

    sc = norm_scope(scope, data.get("episodes") or [])
    checks: dict[str, dict] = {}
    for k in kinds:
        try:
            if k == "structure":
                checks[k] = await check_structure(data, sc)
            elif k == "style":
                checks[k] = await check_style(data, sc)
            elif k == "consistency":
                checks[k] = await check_consistency(data, sc, provider, deep)
            elif k == "script":
                checks[k] = check_script(data, sc)
            elif k == "divergence":
                checks[k] = await check_divergence(draft_id, sc)
        except Exception as ex:  # noqa: BLE001
            logger.exception("体检区块 %s 失败: %s", k, ex)
            checks[k] = {"ok": False, "error": 0, "warn": 1, "issues": [
                _issue("warn", "block_failed", None, f"{KIND_LABEL.get(k, k)}执行失败：{ex}")],
                "scanned": 0, "truncated": False, "total": 1,
                "checked_at": datetime.now(timezone.utc).isoformat()}

    e = sum(c.get("error", 0) for c in checks.values())
    w = sum(c.get("warn", 0) for c in checks.values())
    # 扁平清单: 前端报告卡只读这一个数组就能渲染全部条目(不用遍历 checks 的嵌套)。
    # 按 硬伤优先 → 集号 排序, 前端不必再排一遍 —— 排序规则只有一处, 不会前后端两套。
    # id 前置 kind 前缀: _pack 分配的是 "{code}-{ep}-{i}", 不同区块的 code 可能撞名,
    # 而修复是按 id 回传的 —— 撞名会让"点A修B"。前缀一加, id 全局唯一。
    flat: list[dict] = []
    for _k, _c in checks.items():
        for _it in (_c.get("issues") or []):
            _iid = _it.get("id") or ""
            flat.append({**_it, "id": f"{_k}:{_iid}" if _iid else "",
                         "kind": _k, "kind_label": KIND_LABEL.get(_k, _k)})
    flat.sort(key=lambda i: (0 if i.get("level") == "error" else 1,
                             int(i.get("episode") or 0), str(i.get("id") or "")))
    return {
        "kind": "check",
        "draft_id": draft_id,
        "title": data.get("title") or "",
        "source": data.get("kind"),
        "scope": {"start_ep": sc[0], "end_ep": sc[1]} if sc else None,
        "scope_label": (f"第{sc[0]}-{sc[1]}集" if sc else "整本"),
        "kinds": kinds,
        "checks": checks,
        "issues_flat": flat,
        "totals": {"error": e, "warn": w,
                   "episodes": len(data.get("episodes") or []),
                   "scanned": max((c.get("scanned") or 0) for c in checks.values()) if checks else 0},
        "elapsed_ms": int((time.time() - t0) * 1000),
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }


def report_to_text(report: dict) -> str:
    """把报告渲染成聊天里那段人类可读的话(报告卡另渲染结构化部分)。

    只写"查了什么、多少问题、最该先改哪几条" —— 逐条清单在报告卡里,
    聊天正文里再抄一遍会让气泡长得没法看。
    """
    if report.get("error"):
        return f"体检没能完成：{report['error']}"
    checks = report.get("checks") or {}
    tot = report.get("totals") or {}
    title = report.get("title") or ""
    scope = report.get("scope")
    where = f"第{scope['start_ep']}-{scope['end_ep']}集" if scope else "整本"
    lines = [f"《{title}》{where}体检完成：**{tot.get('error', 0)} 个硬伤、"
             f"{tot.get('warn', 0)} 条提醒**（扫了 {tot.get('scanned', 0)} 集，"
             f"{report.get('elapsed_ms', 0) / 1000:.1f} 秒）。", ""]
    for k in report.get("kinds") or []:
        c = checks.get(k) or {}
        mark = "✅" if c.get("ok") else "⚠️"
        lines.append(f"- {mark} {KIND_LABEL.get(k, k)}：{c.get('error', 0)} 个硬伤 / "
                     f"{c.get('warn', 0)} 条提醒")
    errs = [i for c in checks.values() for i in (c.get("issues") or [])
            if i.get("level") == "error"][:3]
    if errs:
        lines.append("")
        lines.append("先改这几条：")
        for i in errs:
            ep = f"第{i['episode']}集 " if i.get("episode") else ""
            lines.append(f"- {ep}{i['message']}")
    if tot.get("error", 0) or tot.get("warn", 0):
        lines.append("")
        lines.append("下面是完整清单，可以逐条点「让 AI 改这个」，也可以直接说「一键全修」。")
    return "\n".join(lines)
