"""角色名归一（N2）——把同一个人的多种写法归到一个 canonical 名下。

## 为什么需要

场景侧有 `SceneAlias` + `canonicalize_scenes`，角色侧此前**没有对应机制**。
剧本本身就会给同一个人多种写法，拆解如实记录（这是对的），于是：

    '陆明' 208 镜  ←→  '少年陆明' 3 镜        同一人的少年时期
    '江卫东的秘书' 1 镜 ←→ '江卫东秘书' 1 镜    同一人的两种写法

不归一 → `AssetStage` 里「陆明」43 个阶段 +「少年陆明」3 个阶段被当成两个人
各画各的定妆图，同一个角色在少年戏与成年戏里长得毫不相干。

## ⚠️ 为什么判定必须走 LLM，不能用字面子串

实测这些名字对**字面高度相似但绝非同一人**：

    '陆明父亲'    ⊃ '陆明'      父子是两个人！
    '江卫东的秘书' ⊃ '江卫东'    秘书是另一个角色！
    '审查组长'    ⊃ '审查组'     组长是人，审查组是机构

按子串合并会把父子、上下级并成一个人——那不是"没优化"，是**数据损坏**：
两个角色从此共用一张脸，且用户很难反查到是归一干的。

所以：
1. 判定交给 LLM 做语义判断（同 `canonicalize_scenes` 的思路）
2. 提示词里把这些反例**明确列出来**，而不是指望模型自己想到
3. 归组保守——拿不准就不合并。少归一只是少省一次图，错归一是脸都换了
4. `source='manual'` 的行 AI 重跑时不覆盖，用户能纠正误判

## age_stage

归一到同一 canonical 后，`age_stage`（少年/青年/中年/老年）仍区分——
「少年陆明」与「陆明」是同一个人但长相不同，各自出图是**对的**。
这正好接上 Q1 人物档案里的年龄段：同一人不同人生阶段，用年龄段区分，
而不是当成两个人。
"""
from __future__ import annotations

import json
import logging
import uuid

from .db import CharacterAlias, Shot, desc_of, get_session

log = logging.getLogger(__name__)

_SYS = (
    "你是剧本角色梳理员。下面给你一部剧里拆解出来的**角色名清单**（含出场镜头数）。"
    "请判断其中哪些名字指的是**同一个人**，把它们归并到一个标准名下。\n"
    "\n"
    "【必须合并的情况】\n"
    "- **第一人称叙述的「我」**：剧本里有时用「我」来讲主角自己的戏（同一部剧前面叫\n"
    "  「陆知夏」、后面写成「我」）。「我」指的就是那个主角 → 归到主角的标准名。\n"
    "  ⚠️ 只有**原文确实是第一人称叙述**时才这样归；「我们」「我家」不算。\n"
    "- 同一人的不同人生阶段：「少年陆明」与「陆明」→ 标准名「陆明」\n"
    "- 同一人的不同写法：「江卫东的秘书」与「江卫东秘书」→ 择一为标准名\n"
    "- 带职务/称谓前缀的同一人：「保洁王阿姨」与「王阿姨」→「王阿姨」\n"
    "\n"
    "【⚠️ 绝对不能合并的情况——名字相似但是不同的人】\n"
    "- 亲属关系：「陆明父亲」**不是**「陆明」，是他爸，两个人\n"
    "- 从属关系：「江卫东的秘书」**不是**「江卫东」，是另一个角色\n"
    "- 人 vs 机构：「审查组长」是人，「审查组」是机构，不能合并\n"
    "- 同姓不同人：「张医生」与「张护士」是两个人\n"
    "拿不准就**不要合并**——少合并只是少省一张图，错合并会让两个角色共用一张脸。\n"
    "\n"
    "标准名取**出场最多、最简洁**的那个写法。\n"
    "对每个原始名还要判断它的人生阶段 age_stage："
    "少年/青年/中年/老年，判断不出就填 null。\n"
    "（「少年陆明」age_stage=「少年」，「陆明」若是成年戏填「中年」或 null）\n"
    "\n"
    "只输出确实需要归并的组（组内 ≥2 个原始名）。没有任何可归并的就返回空数组。\n"
    '严格输出 JSON：{"groups":[{"canonical":"陆明",'
    '"members":[{"raw":"陆明","age_stage":null},'
    '{"raw":"少年陆明","age_stage":"少年"}]}]}，只输出 JSON。'
)


def _parse_json(raw: str) -> dict:
    """容错解析（与 costumes._parse_json 同口径）。失败抛 ValueError。"""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        text = text[start:end + 1]
    return json.loads(text)


def collect_character_names(session, project_id: str) -> dict[str, int]:
    """该项目拆解出的全部角色名 → 出场镜头数。"""
    counts: dict[str, int] = {}
    for sh in session.query(Shot).filter(Shot.project_id == project_id).all():
        chars = sh.characters
        if isinstance(chars, str):
            try:
                chars = json.loads(chars)
            except (ValueError, TypeError):
                chars = []
        for c in (chars or []):
            if isinstance(c, str) and c.strip():
                counts[c] = counts.get(c, 0) + 1
    return counts


def canonical_character_map(session, project_id: str) -> dict[str, str]:
    """`{原始角色名: 归一名}`。没有映射的名字**不出现**在结果里。

    调用方按 `mapping.get(raw, raw)` 使用——查不到就用原名，
    保证没跑过归一的项目行为完全不变。

    ⚠️ 这里**包含**带 `age_stage` 的映射（如 `少年陆明 → 陆明`）。这是"名字怎么
    归并"的事实，UI 的别名面板就是靠它把同组的人**展示**给用户看/改的，滤掉
    会让那几行从界面上消失、用户再也改不了。

    **但"要不要按它折叠"是消费方的事**：造型识别不能折叠年龄阶段
    （`少年陆明` 的造型记到 `陆明` 名下，那几镜注入时就查不到、退回通用图，
    少年长着成年的脸）。所以那边走 `adult_canonical_map`，不是这个函数。
    两处的差别见 `adult_canonical_map` 的说明。
    """
    rows = (session.query(CharacterAlias)
            .filter(CharacterAlias.project_id == project_id).all())
    return {r.raw_name: r.canonical for r in rows if r.canonical}


def adult_canonical_map(session, project_id: str) -> dict[str, str]:
    """`canonical_character_map` 去掉带 `age_stage` 的行 —— 给**造型/资产**用。

    用户裁定是"**写法合并、年龄阶段保留**"：「赵医生/赵大夫」是同一个人的两种
    写法，该并；「少年陆明/陆明」是同一个人**不同的长相**，不该并。

    造型识别逐集问模型"这个角色穿什么"，拿到的角色名会**原样写进
    `AssetStage.character_name`**，而注入时是按镜头里的名字去查这张表的。
    折叠了年龄阶段就等于把少年戏的造型挂到成年角色名下：那几镜查
    `少年陆明` 一条都查不到，退到角色通用图——少年长着成年的脸，且不报错。
    这与 `apply_character_aliases` 的裁定 ①（跳过 age_stage 不合并资产行）是
    **同一条判据**，两处必须一致，否则会出现"资产层留着少年陆明、它的造型阶段
    却全记在陆明名下"的半拉状态——两边名单对不上，也都不报错。
    """
    return {raw: canon
            for raw, canon in canonical_character_map(session, project_id).items()
            if not (age_stage_map(session, project_id).get(raw) or "").strip()}


def age_stage_map(session, project_id: str) -> dict[str, str]:
    """`{原始角色名: 人生阶段}`，未判定的不出现。"""
    rows = (session.query(CharacterAlias)
            .filter(CharacterAlias.project_id == project_id).all())
    return {r.raw_name: r.age_stage for r in rows if r.age_stage}


async def canonicalize_characters(project_id: str,
                                  model_id: str | None = None) -> dict:
    """跑一次角色名归一，结果写进 `character_aliases`。

    幂等：只更新 `source='ai'` 的行，人工改过的（`source='manual'`）保持不动。
    角色名 ≤1 个时直接返回，不浪费一次模型调用。

    返回 `{"groups": [...], "updated": n, "llm": bool}`。
    """
    from .providers.llm import LLMProvider

    with get_session() as session:
        counts = collect_character_names(session, project_id)
        manual = {r.raw_name for r in
                  session.query(CharacterAlias)
                  .filter(CharacterAlias.project_id == project_id,
                          CharacterAlias.source == "manual").all()}

    if len(counts) <= 1:
        return {"groups": [], "updated": 0, "llm": False}

    listing = "\n".join(f"- {n}（{c} 镜）"
                        for n, c in sorted(counts.items(), key=lambda kv: -kv[1]))
    try:
        llm = LLMProvider(model_id=model_id)
        raw = await llm.complete(_SYS, f"角色名清单：\n{listing}", temperature=0.0)
        groups = _parse_json(raw).get("groups") or []
    except Exception as e:  # noqa: BLE001 归一失败不阻断，退回"不归一"
        log.warning("[char_alias] 项目 %s 角色归一失败，退回不归一: %r", project_id, e)
        return {"groups": [], "updated": 0, "llm": False}

    updated = 0
    out_groups: list[dict] = []
    with get_session() as session:
        for g in groups:
            canon = (g.get("canonical") or "").strip()
            members = g.get("members") or []
            if not canon or len(members) < 2:
                continue
            # 归一名必须是清单里真实存在的名字——模型偶尔会造一个新名字出来
            if canon not in counts:
                log.info("[char_alias] 跳过：归一名 %r 不在角色清单里", canon)
                continue
            kept: list[dict] = []
            for m in members:
                raw_name = (m.get("raw") or "").strip() if isinstance(m, dict) else str(m).strip()
                if not raw_name or raw_name not in counts:
                    continue
                if raw_name in manual:
                    continue          # 人工映射不被 AI 覆盖
                age = (m.get("age_stage") or None) if isinstance(m, dict) else None
                row = (session.query(CharacterAlias)
                       .filter(CharacterAlias.project_id == project_id,
                               CharacterAlias.raw_name == raw_name).first())
                if row is None:
                    row = CharacterAlias(id=uuid.uuid4().hex[:12],
                                         project_id=project_id,
                                         raw_name=raw_name, canonical=canon,
                                         age_stage=age, source="ai")
                    session.add(row)
                else:
                    row.canonical, row.age_stage, row.source = canon, age, "ai"
                updated += 1
                kept.append({"raw": raw_name, "age_stage": age})
            if len(kept) >= 2:
                out_groups.append({"canonical": canon, "members": kept})
        session.commit()

    log.info("[char_alias] 项目 %s：归并 %d 组、%d 条映射",
             project_id, len(out_groups), updated)
    return {"groups": out_groups, "updated": updated, "llm": True}


# ---------------------------------------------------------------------------
# 把映射写穿到资产层（2026-10-12）
# ---------------------------------------------------------------------------
#
# ## 为什么必须有这一步
#
# `canonicalize_characters` 只写 `character_aliases` 这张**映射表**，一个字都
# 没动资产。而拆解建资产行时是 `Asset(name=c)` **原样建**（对照场景侧
# `scenes.canonical_of(...)` 是明确过归一的，注释还写着为什么）——于是归一对
# 角色资产层**从来没生效过**。
#
# 实测《十八年前》（跑过归一的项目）：`character_aliases` 里 12 条映射齐全，
# 而 `assets` 表里 `少年陆明`/`陆明`、`陆明父亲`/`陆父`、`赵医生`/`赵大夫`、
# `保洁王阿姨`/`王阿姨` **四对全部同时存在**，各出一张定妆图。
# 用户看到的正是"同一个人的多个阶段被拆成了多个角色资产"。

def _char_keep_rank(a, canon: str) -> tuple:
    """合并同名角色资产时「留哪一行」的排序键（越小越优先留）。

    与 `scenes._keep_rank` 同款判据、同款理由：第一优先级是"没被用户删掉"，
    否则一个墓碑行可能把同组里用户还在用的那一行合并掉，资产就凭空消失了。

    其后依次：已经叫归一名的 → 有图的 → 有形象档案的 → 有描述的。
    ⚠️ **音色**放在很靠前：角色音色是用户上传的、丢了要重新录，
    比一张能重新生成的定妆图珍贵得多。
    """
    return (a.deleted_at is not None,
            not bool((a.voice_url or "").strip()),
            bool(getattr(a, "profile_json", None)),
            a.name != canon,
            not bool(a.image_url),
            not bool(desc_of(a)))


def _is_pristine(a) -> bool:
    """这一行资产还是"空的"——没有任何用户/AI 投入过的内容。

    判据取**要合并时才有价值的那几列**（图 / 音色 / 形象档案 / 描述）：
    这几列非空就说明有人往里放过东西（用户传的图、录的音色、AI 出的定妆图、
    写过的形象描述），删掉这行就是**真丢东西**。
    """
    return not any((getattr(a, f, None) or "").strip()
                   for f in ("image_url", "voice_url", "profile_json", "prompt",
                             "desc_auto", "brief_json"))


def apply_character_aliases(session, project_id: str,
                            only_raw: set[str] | None = None,
                            pristine_only: bool = True) -> dict:
    """把角色归一映射**写穿**到 `Asset` / `AssetStage` / `Shot`。

    调用方负责 commit。幂等：改名后再跑一次，`raw` 已经不在库里，无操作。

    `only_raw`：只处理这些原始名（`None` = 全部）。逐组确认的入口必须传它 ——
    用户确认的是"合并这一组"，不该顺带把库里另外几十组 AI 早先写下的映射
    也一起收敛掉（那是用户没看过、且会**删资产行**的有损动作）。

    ## 三条裁定（用户 2026-10-12）

    **① `age_stage` 非空的映射不合并。** 「少年陆明」与「陆明」是同一人但
    长相不同，各自出图才对（这正是 `db.py` 里 `CharacterAlias.age_stage`
    的设计意图）。所以这里**跳过**带年龄阶段的映射——它保持独立资产。
    合并掉就等于让少年陆明和成年陆明共用一张脸。

    **② 别名表本身不动**（`aliases=False`）。`raw_name → canonical` 是
    **桥**，跟着改等于把映射抹掉。

    **③ 只收敛"干净"的资产行**（`pristine_only=True`，用户裁定"不碰存量，
    只修以后"）。这是**自动路径**（拆解固定跑这一段）必须开的开关：拆解刚建的
    资产行一定是干净的，收敛它们零风险；而老项目里已经出过图 / 存过音色 /
    写过形象档案的行**一律不动**——合并会 `session.delete` 掉重复行，那是在
    用户不知情的情况下删他花过钱的东西。
    只有用户**点名确认过某一组**的入口（`only_raw` 非空）才该传 False。

    ## ⚠️ 与场景侧的差别（不是写错了）

    `reconcile_location_assets` 明确**不**走 `rename_asset_everywhere`，因为
    场景是"镜头留原名、资产在归一名"两个空间。角色侧**反过来**：全库 12 处
    `Asset.name == c` 的查询拿的 `c` 直接来自 `effective_characters(shot)`，
    **没有任何一处做查询期归一**。所以这里必须把 `Shot.characters` 一起改名，
    否则资产在归一名空间、注入在原名空间，匹配 0 条、参考图全部静默不注入
    ——正是 `asset_rename` 模块头部描述的那个失灵。

    ## 返回

    `{"renamed": {旧名: 新名}, "merged": [被合并掉的名字],
       "skipped_age": [...], "skipped_touched": [...]}`
    """
    from .asset_rename import rename_asset_everywhere
    from .db import Asset

    rows = (session.query(CharacterAlias)
            .filter(CharacterAlias.project_id == project_id).all())

    # ---- ① 先算出"想把谁并到谁"，逐组判一次能不能动 ----
    #
    # ⚠️ **判据必须按"组"而不是按"条"**。改名与合并是两件事，但缺一不可：
    #    只改名不合并 → 「赵大夫」改叫「赵医生」，而库里本来就有一行「赵医生」，
    #    于是**两行同名资产**并列，`Asset.name == c` 的 `.first()` 随机取一行
    #    ——比不归一更糟。所以只要这组里有一行碰过（有图/音色/档案/描述），
    #    整组都不动，改名的收益不值得拿用户的图去赌。
    by_name: dict[str, list] = {}
    for a in (session.query(Asset)
              .filter(Asset.project_id == project_id,
                      Asset.kind == "character").all()):
        nm = (a.name or "").strip()
        if nm:
            by_name.setdefault(nm, []).append(a)

    plan: dict[str, list[str]] = {}       # canonical → [要改名的 raw, ...]
    skipped_age: list[str] = []
    for r in rows:
        raw = (r.raw_name or "").strip()
        canon = (r.canonical or "").strip()
        if not raw or not canon or raw == canon:
            continue                      # 恒等映射：无事可做
        if (r.age_stage or "").strip():
            # 年龄阶段：同一人的不同人生期，**保持独立资产**（裁定 ①）
            skipped_age.append(raw)
            continue
        if only_raw is not None and raw not in only_raw:
            continue
        if raw not in by_name:
            continue                      # 资产层本来就没这行，无事可做
        plan.setdefault(canon, []).append(raw)

    skipped_touched: list[str] = []
    if pristine_only:
        for canon, raws in list(plan.items()):
            rows_in_group = [a for a in by_name.get(canon, [])]
            for raw in raws:
                rows_in_group.extend(by_name.get(raw, []))
            if any(not _is_pristine(a) for a in rows_in_group):
                # 用户裁定"不碰存量"：这组里有出过图/存过音色/写过档案的行
                skipped_touched.extend(raws)
                del plan[canon]

    # ---- ② 改名：raw → canonical ----
    renamed: dict[str, str] = {}
    for canon, raws in sorted(plan.items()):
        for raw in sorted(raws):
            rename_asset_everywhere(session, project_id, "character", raw, canon,
                                    aliases=False)
            renamed[raw] = canon
            log.info("[char_alias] %s：资产层改名 %r → %r（别名表保持不动）",
                     project_id, raw, canon)

    if not renamed:
        return {"renamed": {}, "merged": [],
                "skipped_age": sorted(set(skipped_age)),
                "skipped_touched": sorted(set(skipped_touched))}

    # ⚠️ 上面用的是 bulk update，ORM 身份映射里还是**旧名**。
    #    不 expire 的话，下面按新名分组时会漏掉刚改过的那几行，
    #    合并就成了"什么都没发生"且不报错——静默失效。
    #
    # 只 expire 这几类资产行，**不用 `expire_all()`**：调用方（拆解流程）
    # 在同一个 session 里可能还持有别处的未提交改动，全局 expire 会把它们
    # 一起丢掉。范围收窄到本次真正动过的对象。
    for a in (session.query(Asset)
              .filter(Asset.project_id == project_id,
                      Asset.kind == "character").all()):
        session.expire(a)

    # ---- ③ 合并：改名后撞名了（「赵大夫」并进库里已有的「赵医生」）----
    #
    # ⚠️ 只在**本次动过的组**里合并（`renamed.values()`）。不设这个限制的话，
    #    库里任何一对同名资产行都会被顺手合并掉——包括用户自己建重了的、
    #    我们完全没看过的那批。那是又一次"没报错但删了东西"。
    merged: list[str] = []
    want = set(renamed.values())
    groups: dict[str, list] = {}
    for a in (session.query(Asset)
              .filter(Asset.project_id == project_id,
                      Asset.kind == "character").all()):
        nm = (a.name or "").strip()
        if nm and nm in want:
            groups.setdefault(nm, []).append(a)

    for canon, items in groups.items():
        if len(items) < 2:
            continue
        items.sort(key=lambda a: _char_keep_rank(a, canon))
        keep, dups = items[0], items[1:]
        for d in dups:
            # 只**补空位**，绝不覆盖留存行已有的值 —— 那可能是用户手工换过的
            for f in ("image_url", "voice_url", "profile_json", "prompt"):
                if not (getattr(keep, f, None) or "").strip() \
                        and (getattr(d, f, None) or "").strip():
                    setattr(keep, f, getattr(d, f))
            # 私域人像库缓存跟着图走：留存的图换了，这组 id 就作废
            if not getattr(keep, "volc_asset_id", None) \
                    and getattr(d, "volc_asset_id", None):
                keep.volc_asset_id = d.volc_asset_id
                keep.volc_asset_status = d.volc_asset_status
                keep.volc_asset_src = d.volc_asset_src
            merged.append(d.name)
            session.delete(d)
        if keep.name != canon:
            keep.name = canon

    if merged:
        log.info("[char_alias] %s：资产层合并 %d 行 → %s",
                 project_id, len(merged), sorted(set(merged)))
    return {"renamed": renamed, "merged": merged,
            "skipped_age": sorted(set(skipped_age)),
            "skipped_touched": sorted(set(skipped_touched))}
