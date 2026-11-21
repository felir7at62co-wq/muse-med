"""角色档案（性别 / 年龄 / 身份）——提示词的人称锚。

## 为什么需要这个模块

提示词优化是**逐镜**做的，模型只看得到本镜那几行剧本。中文剧本里人名不带性别
（"林晨走到门前"），于是优化器只能猜代词——实测项目「就可能会」85 个镜头里，
**20 个纯女性角色镜头**的英文提示词写成了 `he / his / him`，21 个写出了
`man / male`，第 2 镜甚至把 38 岁女主林晨写成 "a well-groomed young executive
in a sharp dark suit"（男装男性）。全能参考路线下提示词与参考图打架，模型按
提示词走 → 女主直接变成男人，参考图形同虚设。

解决办法不是在每镜提示词里"多写几句"，而是把**全集统一的人物档案**在优化前
喂给优化器，并在优化后做一次确定性代词自检。档案只含性别/年龄/身份气质，
**不含服装**——服装是逐镜变化的，由 AssetStage 的造型描述在生成时另行锚定
（见 jobs._auto_inject_refs_detailed）。

## 缓存

按 (project_id, episode, 剧本指纹) 缓存在进程内：剧本重拆 → 指纹变 → 自动失效，
不需要任何显式 invalidate。一集只花一次纯文本调用（不出图、不花生图的钱）。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re

from .db import Asset, Shot, effective_characters, get_session

log = logging.getLogger(__name__)

#: (project_id, episode, script_fingerprint) -> {角色名: {"gender","brief"}}
_CACHE: dict[tuple[str, int, str], dict[str, dict]] = {}

#: 每个 (项目, 集号) 一把锁 —— **不是**全模块一把。
#:
#: 2026-10-20 改：此前是模块级 `asyncio.Lock()`，同项目不同集也互相排队。
#: 后果在拆解末尾补齐档案时被放大成分钟级：80 集 = 80 次串行 LLM 调用。
#: 锁的目的只是"同一集并发时别重复调用"，粒度到集就够，多了纯属自伤。
_LOCKS: dict[tuple[str, int], asyncio.Lock] = {}

_SYS = (
    "你是剧本人物档案整理员。根据给定剧本片段，为每个指定角色判定性别、年龄段与身份。\n"
    "1) gender 只能是 \"女\"、\"男\"、\"未知\" 三选一。有明确证据才判定"
    "（称谓如太太/小姐/先生、代词、外貌与服饰描写、亲属与职务关系、"
    "他人对其的称呼）；证据不足写 \"未知\"，不要臆测。\n"
    "2) age 只能是 \"幼儿\"、\"儿童\"、\"少年\"、\"青年\"、\"中年\"、\"老年\"、\"未知\" 七选一。"
    "依据：称谓（老爷子/丫头/小孩）、辈分与亲属关系（爷爷/父亲/儿子）、"
    "职务资历、他人对其年龄的描述。**证据不足写 \"未知\"，不要臆测**。\n"
    "3) brief 一句话不超过 30 字：身份职业 + 气质关键词。"
    "不要写服装（服装逐镜变化，由别处提供），也不必重复年龄段（已由 age 表达）。\n"
    "4) form 只能是 \"人\"、\"动物\"、\"非人\" 三选一：猫狗鸟等写 \"动物\"；"
    "机器人、妖怪、玩偶、外星生物等写 \"非人\"；其余写 \"人\"。form 不是 \"人\" 时，"
    "species 写它具体是什么（如 \"狸花猫幼猫\"、\"白色鹦鹉\"），是 \"人\" 时 species 留空。"
    "动物的 age 按它自己的年龄段选（幼崽用 \"幼儿\"，成年用 \"青年\"），gender 照常判定。\n"
    "5) 只为给定的角色名输出，不要新增、不要改名。\n"
    '严格输出 JSON：'
    '{"角色名":{"form":"人","species":"","gender":"女","age":"中年","brief":"集团CFO，冷艳从容"}}。'
    "只输出 JSON，不要 markdown 代码块、不要解释。"
)

#: 年龄段 → 写进生图提示词的说法。**带上具体岁数区间**：只说「少年」模型仍会
#: 画成二十几岁的人，而「约 12-17 岁」是它能照着画的硬约束。
#: 这正是「成人小孩分不开」的要害——年龄必须是可执行的数字，不是形容词。
_AGE_LABEL = {
    "幼儿": "幼儿，约 1-3 岁",
    "儿童": "儿童，约 4-11 岁",
    "少年": "青少年，约 12-17 岁",
    "青年": "青年，约 18-35 岁",
    "中年": "中年，约 36-55 岁",
    "老年": "老年，约 56 岁以上",
}

#: 英文提示词里的性别标记。**只查第三人称代词**，不查 man/male 这类名词——
#: 名词几乎全是合法的画外/背景人物（实测「就可能会」项目：22 个命中里 21 个
#: 靠代词就能抓到，剩下 1 个是纯名词命中，内容恰是"门缝里传来男人的低笑声 /
#: muffled male laughter"这种剧本原有的画外音，属误报）。代词才是"女主被写成
#: 男人"的真实信号：出场角色本人一定是用代词指代的。
_MALE_RE = re.compile(r"\b(he|his|him|himself)\b", re.I)
_FEMALE_RE = re.compile(r"\b(she|her|hers|herself)\b", re.I)

_PRONOUN_HINT = {
    "女": "女性，英文代词必须用 she/her",
    "男": "男性，英文代词必须用 he/his",
}


def _material(project_id: str, episode: int) -> tuple[str, list[str]]:
    """取该集的剧本文本与出场角色名（提示词阶段唯一可靠的剧本来源）。"""
    with get_session() as session:
        shots = (session.query(Shot)
                 .filter(Shot.project_id == project_id, Shot.episode == episode)
                 .order_by(Shot.order).all())
        names: list[str] = []
        chunks: list[str] = []
        for sh in shots:
            for c in effective_characters(sh):
                if c not in names:
                    names.append(c)
            if sh.script_ref:
                chunks.append(sh.script_ref)
    # 判定性别只需要人物出场的上下文，不需要整集全文；截断保证单次调用不超长
    text = "\n".join(chunks)
    return text[:9000], names


def _parse(raw: str, names: list[str]) -> dict[str, dict]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    # 2026-10-17：zx1 的 gemini-3.6/3.8-flash 自 10-16 起会把输出按固定宽度硬折行，
    # 换行落在字符串字面量**中间**（实测 `"体贴理⏎智"`、`"gender":"女⏎"`），
    # json.loads 报 Invalid control character，档案整批拿不到。
    # 必须**删掉**而不是换成空格：折行点在词中间，补空格会得到「体贴理 智」。
    # JSON 的 token 之间本不需要空白，所以连结构换行一起删也不改变语义。
    # 默认模型已换 gpt-6-sol（实测不折行），这里只是兜底。
    text = re.sub(r'[\x00-\x1f]+', '', text)
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        # ⚠️ 此前这里**重复**写了两个同样的 except 分支（2026-10-20 修）：
        # 第二个 `except` 永远不会执行，而兜底提取 `{...}` 恰好写在第二个里。
        # 后果是模型只要在 JSON 外面多说一句话，`data` 就从未被赋值，
        # 下面 `isinstance(data, dict)` 直接抛 UnboundLocalError，
        # 被调用方吞成 `{}` —— 表现是"整批角色都拿不到档案"，
        # 而不是"只有解析失败的那几个没有"。兜底必须只剩一处。
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            return {}
        try:
            data = json.loads(m.group(0))
        except (ValueError, TypeError):
            return {}
    out: dict[str, dict] = {}
    if not isinstance(data, dict):
        return {}
    for n in names:
        v = data.get(n)
        if isinstance(v, str):          # 模型偷懒只回了一句话
            v = {"gender": "未知", "brief": v}
        if not isinstance(v, dict):
            continue
        g = str(v.get("gender") or "未知").strip()
        if g not in ("女", "男"):
            g = "未知"
        # age 与 gender 同等对待：受限词表 + 越界即"未知"。
        # 不接受自由文本——「看起来不大」这种没法转成生图能执行的岁数区间。
        a = str(v.get("age") or "未知").strip()
        if a not in _AGE_LABEL:
            a = "未知"
        out[n] = {"gender": g, "age": a,
                  "brief": str(v.get("brief") or "").strip()[:60]}
        f = str(v.get("form") or "人").strip()
        if f in _NONHUMAN_FORMS:
            out[n]["form"] = f
            out[n]["species"] = str(v.get("species") or "").strip()[:30]
    return out


#: 非人形态。缺省 / 越界一律按「人」——存量档案没有这个字段，行为与改动前一致。
_NONHUMAN_FORMS = ("动物", "非人")


def creature_of(brief: dict[str, dict], name: str) -> str | None:
    """这个角色若**不是人**，返回它是什么（「狸花猫幼猫」/「动物」）；是人或无档案返回 None。

    下游据此换掉人形专用的东西：定妆照的三视图版式与手脚鞋靴、五官发型档案、
    逐镜提示词里的人称（2026-10-31 用户实测：猫角色被画成真人姑娘、逐镜写成"双手撑地"）。
    """
    b = (brief or {}).get(name) or {}
    if b.get("form") not in _NONHUMAN_FORMS:
        return None
    return (b.get("species") or "").strip() or b["form"]


def apply_overrides(project_id: str, brief: dict[str, dict]) -> dict[str, dict]:
    """把**落库档案**里该压过逐集结果的部分盖上去，返回新字典。

    逐镜提示词用的是逐集现算的档案（`character_brief`），不读 `brief_json`。
    所以用户/Agent 手工改过的档案（`source == "user"`）必须在这里整条盖上，
    否则改档案对逐镜提示词毫无作用；落库档案里的非人形态（form/species）同样盖上——
    「小满是一只猫」不该因为某一集的剧本片段没提到猫就被重判成人。
    """
    from .db import Asset
    out = {k: dict(v) for k, v in (brief or {}).items()}
    with get_session() as session:
        rows = (session.query(Asset.name, Asset.brief_json)
                .filter(Asset.project_id == project_id, Asset.kind == "character",
                        Asset.deleted_at.is_(None), Asset.brief_json.isnot(None)).all())
    for name, blob in rows:
        try:
            saved = json.loads(blob or "")
        except (ValueError, TypeError):
            continue
        if not isinstance(saved, dict):
            continue
        if saved.get("source") == "user":
            out[name] = {k: v for k, v in saved.items() if k != "source"}
        elif saved.get("form") in _NONHUMAN_FORMS and name in out:
            out[name]["form"], out[name]["species"] = saved["form"], saved.get("species") or ""
    return out


async def character_brief(project_id: str, episode: int,
                          model_id: str | None = None) -> dict[str, dict]:
    """该集的角色档案 {name: {"gender","age","brief"}}。失败返回 {}（不阻断生成链路）。"""
    text, names = _material(project_id, episode)
    if not names or not text:
        return {}
    key = (project_id, episode,
           hashlib.md5(text.encode("utf-8")).hexdigest()[:12])
    hit = _CACHE.get(key)
    if hit is not None:
        return apply_overrides(project_id, hit)
    lock = _LOCKS.setdefault((project_id, episode), asyncio.Lock())
    async with lock:
        hit = _CACHE.get(key)          # 双检：同集多镜并发时只调一次
        if hit is not None:
            return apply_overrides(project_id, hit)
        from .providers.llm import LLMProvider
        try:
            llm = LLMProvider(model_id=model_id)
            raw = await llm.complete(
                _SYS,
                f"角色名单：{'、'.join(names)}\n\n剧本片段：\n{text}",
                temperature=0.0, allow_truncated=True)
            brief = _parse(raw, names)
        except Exception as e:  # noqa: BLE001
            # 档案拿不到就退回原行为，不能让提示词生成失败。
            # ⚠️ 但**不缓存失败**（2026-10-20 改）：此前 `{}` 也会写进 `_CACHE`，
            # 于是一次偶发超时就把该集**整个进程生命周期内**永久钉死成"无档案"，
            # 后续 131 个角色的预览全部走空档案、且再也不会重试。
            log.warning("[brief] 第 %s 集人物档案生成失败（不缓存，下次重试）: %r",
                        episode, e)
            return {}
        _CACHE[key] = brief
        return apply_overrides(project_id, brief)


# ---------------------------------------------------------------------------
# 落库：把一次 LLM 的结果钉在资产行上
# ---------------------------------------------------------------------------

def load_brief(project_id: str, name: str) -> dict | None:
    """读某个角色**已经落库**的档案；没有返回 None。

    提示词预览（`routers/shotflow.prompt_preview`）走这条同步读库的路，
    不再 `await character_brief(...)` —— 那会让「打开角色的提示词窗口」变成
    一次 8~188s 的模型调用，而它本该是「点一下、立刻看到」。

    生产实测：`/fwp/v2/assets/prompt-preview` 416 次 200（4–8ms）、
    **29 次 504（正好 300.00s，nginx 超时）**、18 次 499（19~261s 客户端放弃）。
    """
    from .db import Asset
    with get_session() as session:
        a = (session.query(Asset)
             .filter(Asset.project_id == project_id, Asset.kind == "character",
                     Asset.name == name, Asset.deleted_at.is_(None)).first())
        if a is None or not a.brief_json:
            return None
        try:
            d = json.loads(a.brief_json)
        except (ValueError, TypeError):
            return None
    return d if isinstance(d, dict) else None


def save_briefs(project_id: str, briefs: dict[str, dict]) -> int:
    """把 {角色名: {gender,age,brief}} 写进对应资产行的 `brief_json`。返回写入条数。

    ⚠️ 只写**还没落库**的行（`brief_json` 为空）。档案一旦落库就是"这个人是谁"
    的既成事实，后续批次拿着不同的剧集上下文重算可能给出不同答案——
    用户会看到同一个角色今天 30 岁明天 25 岁。要改档案请走显式入口。
    """
    if not briefs:
        return 0
    from .db import Asset
    n = 0
    with get_session() as session:
        rows = (session.query(Asset)
                .filter(Asset.project_id == project_id, Asset.kind == "character")
                .all())
        by_name = {}
        for a in rows:
            by_name.setdefault(a.name, a)
        for name, info in briefs.items():
            if not isinstance(info, dict):
                continue
            a = by_name.get(name)
            if a is None:
                # 还没有资产行：建一行（拆解一般会建，增量拆解/手工加角色会漏）。
                # 不建的话这份档案永远存不下来，每次预览都得重算。
                import uuid as _uuid
                a = Asset(id=_uuid.uuid4().hex[:12], project_id=project_id,
                          kind="character", name=name)
                session.add(a)
                by_name[name] = a
            if (a.brief_json or "").strip():
                continue
            a.brief_json = json.dumps(info, ensure_ascii=False)
            n += 1
        session.commit()
    return n


async def fill_briefs(project_id: str, episodes: list[int] | None = None,
                      model_id: str | None = None) -> dict:
    """为本项目**还缺档案的角色**生成并落库人称档案。

    拆解末尾调用。返回 `{"episodes","generated","failed"}`。

    ## 只扫"缺档案角色首次出场的那几集"

    此前这里无差别扫全部集：80 集的项目 = 80 次纯文本调用，而重跑一次拆解
    时这些档案**早就有了**，那 80 次调用纯属白烧（每次 8~188s，加起来是分钟级）。
    改成先看谁缺档案（`assets.brief_json` 为空且未删除），再按
    `Shot.characters` 反查每个角色**首次出场**的集 —— 判定性别/年龄只需要
    那一集的上下文（与 `jobs._collect_briefs` 同一策略），去重后往往只剩个位数。

    `episodes` 显式给了就只扫这些集（不影响"跳过已有档案"这条）。

    ⚠️ 并发按 `default_concurrency`，不新增也不下调任何并发数（并发铁律）。
    `character_brief` 的锁粒度是 (项目, 集)，这里可以真正并发——
    此前它是模块级一把锁，不同集也只能一个接一个跑。
    """
    import asyncio

    from .config import get_settings

    with get_session() as session:
        # 谁还缺档案：只看活着的角色行。**没有资产行**的角色也要算进来
        # （拆解一般会建，增量拆解/手工加角色会漏），它们必然缺。
        have = {a.name for a in session.query(Asset)
                .filter(Asset.project_id == project_id, Asset.kind == "character")
                .all() if (a.brief_json or "").strip()}
        # 角色 → 首次出场集。整表读一遍再解析，比逐角色 LIKE 查 N 次便宜得多。
        first_ep: dict[str, int] = {}
        for ep, raw in (session.query(Shot.episode, Shot.characters)
                        .filter(Shot.project_id == project_id).all()):
            if ep is None:
                continue
            try:
                names = json.loads(raw or "[]")
            except (ValueError, TypeError):
                continue
            if not isinstance(names, list):
                continue
            for n in names:
                if not isinstance(n, str):
                    continue
                n = n.strip()
                if n and (n not in first_ep or ep < first_ep[n]):
                    first_ep[n] = ep

    want_names = [n for n in first_ep if n not in have]
    if episodes is not None:
        want = sorted({e for e in episodes if e} | set())
    else:
        want = sorted({first_ep[n] for n in want_names})
    if not want:
        return {"episodes": 0, "generated": 0, "failed": 0}

    sem = asyncio.Semaphore(max(1, get_settings().default_concurrency))
    results: dict[str, dict] = {}
    failed = 0

    async def _one(ep: int) -> None:
        nonlocal failed
        async with sem:
            b = await character_brief(project_id, ep, model_id)
        if b:
            results.update(b)
        else:
            failed += 1

    await asyncio.gather(*[_one(e) for e in want])
    n = save_briefs(project_id, results)
    log.info("[brief] 项目 %s：缺档案角色 %d 个，扫描 %d 集，落库 %d 条，%d 集失败/无角色",
             project_id, len(want_names), len(want), n, failed)
    return {"episodes": len(want), "generated": n, "failed": failed,
            "wanted": len(want_names)}


def brief_for_image(brief: dict[str, dict], name: str) -> str | None:
    """单人物档案（资产图生成用）。返回「性别 + 年龄段 + 身份气质」一句话，无档案返回 None。

    Q1 修复关键：资产定妆照提示词缺性别/年龄时，模型只能靠角色名猜，
    「周雪」「林辰」这类名字性别歧义大，猜错就是女主变男人、小孩变大人。
    这里把档案的核心属性拼成一句话，让模型知道"这是个什么人"。

    ⚠️ 年龄取的是**结构化的 `age` 字段**，不是从 brief 文本里捞。
    早先的实现只让模型把年龄写进 30 字的自由文本 brief，再用「按逗号切分 +
    关键词命中」去回捞——模型一旦为了压字数没写年龄（很常见），提示词里就
    **一个年龄线索都没有**，于是小孩画成大人。年龄和性别一样是硬约束，
    必须是受限词表里的独立字段。文本回捞作为兼容老缓存的兜底保留。
    """
    b = brief.get(name)
    if not b:
        return None
    gender = b.get("gender")
    desc = (b.get("brief") or "").strip()
    age = b.get("age")
    if not gender and not desc and not age:
        return None

    creature = creature_of(brief, name)
    if creature:
        # 非人：说清它是什么，不套人的性别称谓与「约 18-35 岁」这类人类岁数
        sex = {"女": "雌性", "男": "雄性"}.get(gender or "")
        young = "幼年" if age in ("幼儿", "儿童", "少年") and "幼" not in creature else ""
        head = f"{b.get('form')}角色：{young}{creature}" + (f"，{sex}" if sex else "")
        return "，".join(x for x in (head, desc[:60]) if x)

    parts = []
    # gender 的取值域由 _SYS 规定，只有 "女"/"男"/"未知" 三种（见 _parse 的兜底）。
    # "未知" 不写进提示词——与其让模型看到"性别未知"而随机发挥，
    # 不如不提，让它从造型描述与角色名去推断。
    if gender == "女":
        parts.append("女性")
    elif gender == "男":
        parts.append("男性")

    # 年龄段：优先用结构化字段（带具体岁数区间，模型能照着画）
    age_seg = _AGE_LABEL.get(age or "")
    if age_seg:
        parts.append(age_seg)
    else:
        # 兜底：老缓存/老数据没有 age 字段时，仍从 brief 文本里捞一次
        age_hints = ("岁", "年轻", "少年", "青年", "中年", "老年",
                     "幼儿", "儿童", "少女", "少男")
        hit = next((s for s in desc.split("，") if any(h in s for h in age_hints)), None)
        if hit:
            age_seg = hit.strip("，。！？、；： ")
            parts.append(age_seg)

    # 剩余描述去掉已提取的年龄段，保留核心身份/气质
    remain = desc
    if age_seg and age_seg in desc:
        remain = desc.replace(age_seg, "").strip("，。！？、；： ")
    if remain and len(remain) <= 60:  # 只保留简短核心描述，避免提示词过长
        parts.append(remain)

    return "，".join(parts) if parts else None


def brief_context(brief: dict[str, dict], names: list[str]) -> str | None:
    """把本镜出场人物的档案压成一段提示词补充背景。无可用档案返回 None。

    ⚠️ 必须带上 `age`：年龄段已从 brief 自由文本里**移出**成了独立字段
    （见 `_SYS`），这里若只拼 gender + brief，逐镜提示词就会彻底失去年龄线索——
    比它原来"碰巧从 brief 文本里蹭到年龄"还差。年龄和性别一样要写成硬约束。
    """
    lines: list[str] = []
    for n in names:
        b = brief.get(n)
        if not b:
            continue
        creature = creature_of(brief, n)
        if creature:
            desc = b.get("brief") or ""
            lines.append(f"- {n}：是{creature}（{b.get('form')}，不是人），"
                         f"以{creature}自身的形体、姿态与动作出现，指代用 it 或名字"
                         + (f"；{desc}" if desc else ""))
            continue
        hint = _PRONOUN_HINT.get(b.get("gender", ""),
                                 "性别未确认，避免使用任何性别代词与男女称谓")
        age = _AGE_LABEL.get(b.get("age") or "")
        desc = b.get("brief") or ""
        tail = "；".join(x for x in (age, desc) if x)
        lines.append(f"- {n}：{hint}{('；' + tail) if tail else ''}")
    if not lines:
        return None
    return ("本镜出场人物档案（人称代词、性别称谓与年龄段必须与此完全一致："
            "严禁把女性角色写成 he/his/him/man/male/boy，"
            "也严禁把男性角色写成 she/her/woman/female；"
            "严禁把儿童写成成年人、把老人写成年轻人）：\n" + "\n".join(lines))


def pronoun_conflict(prompt: str, brief: dict[str, dict],
                     names: list[str]) -> str | None:
    """确定性自检：提示词里指代出场角色的第三人称代词与人物档案冲突时返回说明。

    只在**本镜出场角色性别一致**（全女或全男）时判定——混合阵容里两种代词
    都合法，无从判起。只查代词、不查 man/male 这类名词（见 _MALE_RE 注释）：
    画外音"a man's low laughter"是剧本原文，不是错误。
    """
    genders = {brief[n]["gender"] for n in names
               if n in brief and brief[n]["gender"] in ("女", "男")}
    if len(genders) != 1:
        return None
    g = genders.pop()
    if g == "女" and _MALE_RE.search(prompt or ""):
        return "本镜出场角色全部为女性，提示词中却用了 he/his/him 指代"
    if g == "男" and _FEMALE_RE.search(prompt or ""):
        return "本镜出场角色全部为男性，提示词中却用了 she/her 指代"
    return None


def fix_pronoun_instruction(conflict: str) -> str:
    """代词冲突后的重写指令（附加在补充背景里再优化一次）。"""
    return (f"⚠️ 上一版提示词存在人称错误：{conflict}。"
            "请严格按人物档案改正**出场角色本人**的代词、称谓与外观描述"
            "（女性用 she/her 且不得描述为 man/male）；"
            "剧本中确实存在的画外或背景人物按原意保留，不要删改剧情与台词。")
