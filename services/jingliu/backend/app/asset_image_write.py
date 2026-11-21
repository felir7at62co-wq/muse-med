"""把一张图写进资产 / 造型的**唯一实现**（网页批量导入、Agent 导入、Agent 指定写图共用）。

## 为什么单独成模块（2026-10-31）

Agent 的 `import_assets_by_filename` 原先是网页 `POST /assets/import-by-filename` 的一份手抄，
两边已经漂移：

- 角色只有一套造型时，网页写进那套造型（出片注入读的就是它），Agent 写在角色的通用定妆图上
  —— 导入「成功」，出片照旧用旧图；
- Agent 不落版本：资产详情里看不到这张图，也没有「当前」的勾；
- 已删除的资产，网页说「先恢复」，Agent 只说「没对上」。

落点规则、版本记录、判名口径只在这里写一次。

## 落点（不指定造型时）

- 角色且**只有一套**在用造型 → 写进那套造型
- 角色且**有多套** → 写进角色的通用定妆图，并在结果里列出各套造型，不替用户猜是哪一套
- 角色无造型 / 场景 / 道具 → 写进资产本身
- 资产已删除（墓碑）→ 不复活，记为 `deleted`

## 「这张图只在第 X–Y 集用」

就是一套第 X–Y 集的造型（`add_episode_look`）。一镜只归一套：原本覆盖这几集的造型自动让出
（见 `stage_coverage`），其余集照旧。
"""
from __future__ import annotations

import uuid

from .db import Asset, AssetStage, CharacterAlias, Project, SceneAlias, Shot, get_session

#: 状态里算「写进去了」的两种
WRITTEN = ("stage", "asset")


class ImageWriteError(ValueError):
    """整批不执行的前置错误（参数不对、项目不存在）。逐条的问题写在结果里，不抛。"""


def _alive_stages(session, project_id: str) -> dict[str, list[AssetStage]]:
    from . import stage_gate
    rows = (stage_gate.alive(session.query(AssetStage).filter(AssetStage.project_id == project_id))
            .order_by(AssetStage.ep_from).all())
    out: dict[str, list[AssetStage]] = {}
    for st in rows:
        out.setdefault(st.character_name, []).append(st)
    return out


def last_episode(session, project_id: str) -> int:
    """全剧最后一集（与 `_check_stage_ranges` 的上限同一口径：剧本集数与镜头集号取大）。"""
    import json
    proj = session.get(Project, project_id)
    episodes = json.loads(proj.episodes) if proj and proj.episodes else []
    return max([len(episodes)] + [e for (e,) in session.query(Shot.episode)
                                  .filter(Shot.project_id == project_id).distinct().all()], default=1) or 1


def _stage_label(st: AssetStage) -> str:
    """「造型名」（第1–3集）。无集数造型（仅供手动引用）不能渲染成「第None–None集」。"""
    if st.ep_from is None or st.ep_to is None:
        return f"「{st.stage_name}」（手动引用·不限集）"
    rng = f"第{st.ep_from}集起" if st.ep_to >= 999 else f"第{st.ep_from}–{st.ep_to}集"
    return f"「{st.stage_name}」（{rng}）"


def _place(a: Asset, url: str, stages: list[AssetStage], stage: AssetStage | None) -> dict:
    """把 url 写到 a（或它的某套造型）上，返回结果行里的 status/target/note。"""
    if stage is not None:
        stage.image_url = url
        stage.source_stage_id = None      # 人工给了图，它自己就是源
        return {"status": "stage", "target": {"stage_id": stage.id, "character": a.name,
                                              "stage_name": stage.stage_name},
                "note": f"写进了造型「{stage.stage_name}」"}
    if a.kind == "character" and len(stages) == 1:
        return _place(a, url, stages, stages[0])
    a.image_url = url
    note = ""
    if a.kind == "character" and stages:
        note = (f"这个角色有 {len(stages)} 套造型（" + "、".join(_stage_label(s) for s in stages)
                + "），图存在角色资产上：出片按各套造型自己的图，资产页卡片和兜底也显示造型图，这张只在所有造型都没图时才用到。"
                "要换某一套，指定 stage_id 再写")
    return {"status": "asset", "target": {"asset_id": a.id, "kind": a.kind, "name": a.name},
            "note": note}


def _record_versions(project_id: str, results: list[dict]) -> None:
    """版本记录在写事务之外落（record 开自己的会话），并把「当前采用」指向新图。"""
    from . import asset_versions as av
    for r in results:
        t = r.get("target") or {}
        if r["status"] == "stage":
            av.record(project_id=project_id, kind="stage", target_id=t["stage_id"],
                      image_url=r["url"], source="upload",
                      label=f"{t['character']} · {t['stage_name']}")
        elif r["status"] == "asset":
            av.record(project_id=project_id, kind=t["kind"], target_id=t["asset_id"],
                      image_url=r["url"], source="upload", label=t["name"])


def _counts(results: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return counts


def _match(key: str, by_key: dict[str, list[Asset]], level: int) -> tuple[list[Asset], str]:
    """返回 `(候选, 匹配方式)`；匹配方式 ∈ exact | contains | token | ""。

      · **exact**   —— 归一名相等（含别名指向），确定性匹配，可以直接写入
      · **contains**—— 归一后的资产名是文件名的完整子串（「男主」⊆「男主礼服」）
      · **token**   —— 文件名与资产名两侧的**词**互相全覆盖（100%），
                       用于「秦墨特写」↔「秦墨」这类包含关系不成立的写法

    ⚠️ 后两种都是**模糊**匹配：只给出候选，调用方必须让用户确认后才写。
    40 张图里错挂一张，用户很难发现；而"没对上"他立刻看得见。

    ⚠️ 单字名不参与模糊匹配：一个叫「他」或「日」的资产会包含在几乎每个文件名里，
    那不是匹配，是噪声。（单字名走 exact 仍可正常导入。）
    """
    exact = by_key.get(key)
    if exact:
        return (list(exact), "exact")
    if level < 2:
        return ([], "")

    hits: list[Asset] = []
    seen: set[str] = set()

    def add(assets):
        for a in assets:
            if a.id not in seen:
                seen.add(a.id)
                hits.append(a)

    # ① 资产名 ⊆ 文件名（含别名）
    #
    # ⚠️ 加一条长度占比护栏（2026-11-04）：光"包含"会把「男主」匹配到
    # 「男主__不存在.png」「男主版废稿-不要用.png」这类明显不是同一张的文件上，
    # 而项目里最常见的名字恰恰是「男主」「病房」这种极短词 —— 不设护栏时
    # 几乎每个文件都会冒出一个候选，用户只能一路点"全部确认"，确认就等于没有。
    #
    # 阈值取 40%：实测常见写法都能过（男主⊆男主礼服 50%、病房⊆病房日 67%、
    # 秦墨⊆秦墨特写 50%），而「男主」⊆「男主__不存在」=29% 被挡掉。
    # 这只是"要不要给用户看这个候选"，写不写仍由用户逐张确认。
    for name_key, assets in by_key.items():
        if len(name_key) >= 2 and name_key in key \
                and len(name_key) >= 0.4 * len(key):
            add(assets)
    if hits:
        return (hits, "contains")

    # ② 词级全覆盖：两侧的词互为子集（任一方向满 100%）
    #    词 = 由空白/下划线/连字符/点号分隔的片段；纯中文没有分隔符时整串就是一个词，
    #    于是这一层对中文退化成"整串互相包含"，而那个情况已经由 ① 覆盖。
    #    所以这里真正救的是「秦墨_特写」vs「秦墨」、「hospital_night」vs「hospital」。
    key_tokens = {t for t in _tokens(key) if len(t) >= 2}
    if not key_tokens:
        return ([], "")
    for name_key, assets in by_key.items():
        if len(name_key) < 2:
            continue
        name_tokens = {t for t in _tokens(name_key) if len(t) >= 2}
        if not name_tokens:
            continue
        if name_tokens <= key_tokens or key_tokens <= name_tokens:
            add(assets)
    return (hits, "token" if hits else "")


def _tokens(s: str) -> list[str]:
    """把归一后的名字切成词。分隔符=空白/下划线/连字符/点/斜杠/括号。

    ⚠️ 不能直接写 `re.split(r"[^\\w]+")`：Python 的 `\\w` **包含下划线**，
    于是「秦墨_特写」会被当成一个词，这一层等于没生效（实测踩过）。

    刻意**不**对纯中文做分词：没有可靠的免费分词器，切错了就是把图挂错人。
    中文场景由「资产名 ⊆ 文件名」那一层覆盖，足够。
    """
    import re as _re
    return [t for t in _re.split(r"[\s_\-./\\|()（）\[\]【】]+", s or "") if t]


def import_by_filename(project_id: str, items: list[dict], level: int = 1,
                       decided: dict | None = None) -> dict:
    """按文件名把一批图写进同名资产 / 造型。items = [{filename, url}]。

    返回逐条结果（status ∈ stage/asset/confirm/unmatched/ambiguous/deleted/duplicate/error），
    调用方必须原样给用户看，尤其 unmatched：批量操作最坏的形态是看着成功、其实没对上。

    ## 模糊命中一律**不写**，先让用户确认（2026-11-04 用户裁定）

    `level=2` 的包含/词级匹配只产出候选，行状态是 `confirm`（附 `candidates`）。
    用户确认后把 `decided` 传回来再调一次：`{"男主礼服.png": "<asset_id>"}`。
    **只有 `decided` 里点名的那个才写**——绝不在用户没看过的前提下替他挂图。
    精确命中（文件名就是资产名）仍然直接写，不受影响。
    """
    from .routers.assets import _name_key

    if level not in (1, 2):
        raise ImageWriteError("level 只能是 1 或 2")
    if not items:
        raise ImageWriteError("没有要导入的图片")
    if len(items) > 500:
        raise ImageWriteError("一次最多导入 500 张")
    decided = decided or {}
    results: list[dict] = []
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise ImageWriteError("项目不存在")
        by_key: dict[str, list[Asset]] = {}
        for a in session.query(Asset).filter(Asset.project_id == project_id).all():
            by_key.setdefault(_name_key(a.name), []).append(a)
        # Layer 2：把别名也加进 by_key，让"男一礼服"能匹配到别名"男一"指向的资产
        # 别名映射：alias_key → 目标资产名 → 目标资产
        # CharacterAlias: raw_name -> canonical, SceneAlias: raw_name -> canonical
        for ca in (session.query(CharacterAlias)
                   .filter(CharacterAlias.project_id == project_id).all()):
            alias_key = _name_key(ca.raw_name)
            # 找到别名指向的资产
            target_assets = by_key.get(_name_key(ca.canonical), [])
            for a in target_assets:
                if alias_key not in by_key:
                    by_key[alias_key] = []
                if a not in by_key[alias_key]:
                    by_key[alias_key].append(a)
        for sa in (session.query(SceneAlias)
                   .filter(SceneAlias.project_id == project_id).all()):
            alias_key = _name_key(sa.raw_name)
            target_assets = by_key.get(_name_key(sa.canonical), [])
            for a in target_assets:
                if alias_key not in by_key:
                    by_key[alias_key] = []
                if a not in by_key[alias_key]:
                    by_key[alias_key].append(a)
        stages = _alive_stages(session, project_id)
        seen_urls: dict[str, str] = {}
        for it in items:
            fn = str((it or {}).get("filename") or "")
            url = str((it or {}).get("url") or "").strip()
            key = _name_key(fn)
            row = {"filename": fn, "name": key, "url": url, "status": "", "target": None, "note": ""}
            results.append(row)
            if not url or not key:
                row.update(status="error", note="缺少上传地址或文件名")
                continue
            if url in seen_urls:
                row.update(status="duplicate", note=f"与「{seen_urls[url]}」是同一张图，已跳过")
                continue
            seen_urls[url] = fn
            hits, how = _match(key, by_key, level)
            if not hits:
                row.update(status="unmatched", note="本项目里没有叫这个名字的资产")
                continue
            alive = [a for a in hits if not a.deleted_at]
            if not alive:
                row.update(status="deleted", note="这个资产已被删除——先恢复它再上传，不会自动复活")
                continue
            # 用户在界面上确认过的那一张，优先于一切自动匹配
            chosen = decided.get(fn)
            if chosen:
                pick = next((a for a in alive if a.id == chosen), None)
                if pick is None:
                    row.update(status="error",
                               note="确认的目标不在这一批候选里（资产可能刚被删除或改名），请重试")
                    continue
                alive = [pick]
                how = "exact"
            if len({a.id for a in alive}) > 1:
                kinds = {a.kind for a in alive}
                row.update(status="ambiguous",
                           candidates=[{"asset_id": a.id, "name": a.name, "kind": a.kind}
                                       for a in alive],
                           note=("同名资产有多种类型（" + "/".join(sorted(kinds)) + "）" if len({a.name for a in alive}) == 1
                                 else "文件名里包含不止一个资产名") + "，请指定是哪一个")
                continue
            a = alive[0]
            # 模糊命中不写：先问。用户确认后带着 decided 再调一次才落库。
            if how in ("contains", "token") and not decided.get(fn):
                row.update(status="confirm",
                           candidates=[{"asset_id": a.id, "name": a.name, "kind": a.kind}],
                           note=(f"文件名不是完整的资产名，按「{'包含资产名' if how == 'contains' else '词全覆盖'}」"
                                 f"猜是「{a.name}」——确认后再写"))
                continue
            row.update(_place(a, url, stages.get(a.name, []) if a.kind == "character" else [], None))
        session.commit()
    _record_versions(project_id, results)
    counts = _counts(results)
    return {"ok": True, "results": results, "counts": counts,
            "imported": sum(counts.get(s, 0) for s in WRITTEN)}


def set_images(project_id: str, items: list[dict]) -> dict:
    """把图写到**指定**的资产 / 造型上（用户说了「这张是林晓」，文件名对不上时用）。

    items = [{url, asset_id 或 name（可带 kind）, stage_id 或 stage_name（可选，只对角色）}]。
    指定了造型就写那套造型；没指定按模块顶部的落点规则。认不准的一律报错，不猜。
    """
    if not items:
        raise ImageWriteError("items 为空")
    if len(items) > 200:
        raise ImageWriteError("一次最多 200 张，请分批")
    results: list[dict] = []
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise ImageWriteError("项目不存在")
        assets = session.query(Asset).filter(Asset.project_id == project_id).all()
        stages = _alive_stages(session, project_id)
        for it in items:
            it = it or {}
            url = str(it.get("url") or "").strip()
            label = it.get("asset_id") or it.get("name")
            row = {"asset": label, "url": url, "status": "", "target": None, "note": ""}
            results.append(row)
            if not url:
                row.update(status="error", note="缺 url：先用 upload_media 上传本机图片")
                continue
            if not url.startswith(("/fw/media/", "/fwp/media/", "/media/")):
                row.update(status="error", note="url 要是镜流里的图片地址：先用 upload_media 上传")
                continue
            if it.get("asset_id"):
                cands = [a for a in assets if a.id == it["asset_id"]]
            else:
                name = str(it.get("name") or "").strip()
                cands = [a for a in assets if a.name == name
                         and (not it.get("kind") or a.kind == it["kind"])]
            if not cands:
                row.update(status="unmatched", note="本项目里找不到这个资产（用 list_assets 查准名字或 asset_id）")
                continue
            alive = [a for a in cands if not a.deleted_at]
            if not alive:
                row.update(status="deleted", note="这个资产已被删除——先恢复它再写图")
                continue
            if len(alive) > 1:
                row.update(status="ambiguous", candidates=[{"asset_id": a.id, "kind": a.kind} for a in alive],
                           note="同名资产不止一个，请改用 asset_id 或带上 kind")
                continue
            a = alive[0]
            mine = stages.get(a.name, []) if a.kind == "character" else []
            stage = None
            if it.get("stage_id") or it.get("stage_name"):
                if a.kind != "character":
                    row.update(status="error", note="只有角色有造型；场景/道具直接写资产图，去掉 stage 参数")
                    continue
                stage = next((s for s in mine if s.id == it.get("stage_id")
                              or (not it.get("stage_id") and s.stage_name == it.get("stage_name"))), None)
                if stage is None:
                    row.update(status="error", note="这个角色没有这套造型（已删除的造型要先恢复）。现有："
                               + ("、".join(_stage_label(s) for s in mine) or "无"))
                    continue
            row.update(_place(a, url, mine, stage))
        session.commit()
    _record_versions(project_id, results)
    counts = _counts(results)
    done = sum(counts.get(s, 0) for s in WRITTEN)
    return {"ok": done > 0, "results": results, "counts": counts, "written": done}


def add_episode_look(project_id: str, character_name: str, stage_name: str, ep_from: int, ep_to: int,
                     image_url: str | None = None, description: str | None = None) -> dict:
    """给角色加一套**只在第 ep_from–ep_to 集用**的造型（可同时给图）。

    区间合法性与网页「新增造型」同一个校验（`stage_scene._check_stage_ranges`）。
    一镜只归一套（`stage_coverage.claim`）：这几集归新造型，原本覆盖它们的造型自动让出。
    """
    from fastapi import HTTPException

    from .routers.stage_scene import _check_stage_ranges

    character_name = (character_name or "").strip()
    stage_name = (stage_name or "").strip()
    if not character_name or not stage_name:
        raise ImageWriteError("character_name 与 stage_name 都不能为空")
    if image_url and not image_url.startswith(("/fw/media/", "/fwp/media/", "/media/")):
        raise ImageWriteError("image_url 要是镜流里的图片地址：先用 upload_media 上传")
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise ImageWriteError("项目不存在")
        a = (session.query(Asset).filter(Asset.project_id == project_id, Asset.kind == "character",
                                         Asset.name == character_name, Asset.deleted_at.is_(None)).first())
        if a is None:
            raise ImageWriteError(f"找不到角色「{character_name}」（名字要与资产表一致；已删除的先恢复）")
        if any(s.stage_name == stage_name for s in _alive_stages(session, project_id).get(character_name, [])):
            raise ImageWriteError(f"「{character_name}」已有一套叫「{stage_name}」的造型：换个名字，"
                                  "或用 set_asset_images 指定这套造型换图")
        # 「一直用到最后」= 到全剧最后一集（区间校验不收超出集数的值）
        ep_to = min(int(ep_to), last_episode(session, project_id))
        st = AssetStage(id=uuid.uuid4().hex[:12], project_id=project_id, character_name=character_name,
                        stage_name=stage_name, ep_from=int(ep_from), ep_to=ep_to,
                        description=(description or "").strip() or None, status="draft")
        try:
            _check_stage_ranges(session, st)
        except HTTPException as e:
            raise ImageWriteError(str(e.detail)) from None
        if image_url:
            st.image_url = image_url
        session.add(st)
        # 一镜只归一套：这几集归新造型，原本覆盖它们的造型让出（被切开的后段建成指针行，仍是原来那张图）
        from .stage_coverage import claim
        try:
            notes = claim(session, st)
        except ValueError as e:
            session.rollback()
            raise ImageWriteError(str(e)) from None
        session.commit()
        out = {"ok": True, "stage_id": st.id, "character": character_name, "stage_name": stage_name,
               "episodes": [st.ep_from, st.ep_to], "has_image": bool(image_url)}
        if notes:
            out["adjusted"] = notes
            out["note"] = f"第 {st.ep_from}–{st.ep_to} 集现在用「{stage_name}」；" + "；".join(notes)
        label = f"{character_name} · {stage_name}"
    if image_url:
        from . import asset_versions as av
        av.record(project_id=project_id, kind="stage", target_id=out["stage_id"], image_url=image_url,
                  source="upload", label=label)
    return out
