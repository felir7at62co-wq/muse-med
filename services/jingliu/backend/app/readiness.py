"""生产就绪度体检（「▶ 全部生成视频」前的二次确认弹窗数据源）。

把出片之前的隐患（资产图缺口、服装造型没识别等）一次性摊开，交给弹窗展示。
纯只读，不写任何库。

## 首帧这一栏为什么恒为空

本模块原是为「🎬 首帧精控」(i2va) 路线写的：那条路线比别的长一截（定妆图 → 场景
锚定图 → 每镜首帧图 → 首帧生视频），有几处用户看不见的静默失效点。首帧 / 首尾帧 /
尾帧三种生成模式已于 2026-11-20 整体下线（用户裁定），出片统一走全能参考。
返回值里的 `first_frames` / `i2va_supported` 两项**留着且恒为"没有首帧这一步"**：
网页的弹窗与一键成片都按这两个键判断要不要显示首帧阶段，删键会让旧网页报错。
"""
from __future__ import annotations

import json

from .db import (Asset, AssetStage, Project, Shot, effective_characters,
                 get_session)


def _override_of(shot: Shot) -> dict:
    try:
        return json.loads(shot.profile_override) if shot.profile_override else {}
    except (ValueError, TypeError):
        return {}


def compute_readiness(project_id: str) -> dict:
    """算出该项目的生产就绪度快照。

    复用既有能力，不另起查询口径：
    - 生成模式/图像模型 → `jobs._resolve_project_gen_settings`
    - 视频模型 → `jobs._resolve_project_video_model`
    - 分辨率档位 → `jobs._resolve_project_resolution`
    - 角色/场景集合 → `db.effective_characters` / `scenes.canonical_locations`
      （与实际注入同契约，避免"弹窗说齐了、注入时却少一张"）
    """
    from .config import get_settings
    from .jobs import (_resolve_project_gen_settings, _resolve_project_resolution,
                       _resolve_project_video_model)

    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            return {"error": "project not found"}
        gen_mode, image_model = _resolve_project_gen_settings(proj)
        video_model = (_resolve_project_video_model(proj)
                       or get_settings().video_model)
        # 生产检查弹窗要用它算"分辨率可选档位"（画幅决定档位表）
        base_aspect = proj.base_aspect or "9:16"
        # 新建项目时选的分辨率档位。必须回给前端，否则「本次参数」面板
        # 无从知道项目值是什么，只能默认显示列表第一项（1080p）——
        # 用户明明选的 720p，面板上却写着 1080p，那是在骗人。
        # 可能为 None：老项目 default_profile 里没有这一项，那就是"模型默认"。
        resolution = _resolve_project_resolution(proj)
        shots = (session.query(Shot).filter(Shot.project_id == project_id)
                 .order_by(Shot.order).all())
        # 造型阶段：**排除用户删掉的**（`AssetStage.deleted_at` 墓碑，见 stage_gate）。
        # 不排的后果和资产墓碑一样：删掉的造型照旧报"缺定妆图"，用户点一次
        # 「补齐」就又花钱把它画回来了。
        from . import stage_gate
        stages = (stage_gate.alive(
                  session.query(AssetStage)
                  .filter(AssetStage.project_id == project_id))
                  .order_by(AssetStage.character_name, AssetStage.ep_from).all())
        # 资产：**排除用户删掉的**（`Asset.deleted_at` 墓碑，见 asset_gate 模块头）。
        # 只从这里排还不够——下面 used_locs / used_chars / used_props 是从 `Shot`
        # 算的、根本不看资产表，所以还要拿 `_gone` 去减，否则删掉的资产照样报
        # "缺图"，用户点一次「补齐」就又花钱把它画回来了。
        from . import asset_gate
        assets = asset_gate.alive(
            session.query(Asset).filter(Asset.project_id == project_id)).all()
        # 分 kind 的墓碑名集合。**必须分 kind**：`deleted_names` 不传 kind 时
        # 是跨三类混在一起的，拿它去减道具会把"道具「林晨」被删"错算成
        # "角色「林晨」也被删"，那个角色的定妆图就静默不注入了。
        # （下面减 used_props 用的就是这一份，见 2026-10-27 那段注释。）
        _gone_by_kind = {
            k: asset_gate.deleted_names(session, project_id, k)
            for k in ("character", "location", "prop")
        }
        _gone = asset_gate.deleted_names(session, project_id)

        # ---- 镜头维度 ----
        # 与 run_shot_videos 一致：外部素材(is_special)与停用镜头都不送去生成
        active = [s for s in shots if not s.disabled and not s.is_special]
        need_video = [s for s in active if not s.video_url]

        # ---- 资产维度 ----
        # 按**全部有效镜头**统计（不是只按"本轮待生成"的镜头）。
        #
        # 原实现只看 need_video，于是"全部镜头都已出片"的项目算出来的资产缺口恒为 0：
        # 造型阶段明明缺图（比如重新识别出的「丝绸睡裙」变体一张图都没有），
        # 生产检查弹窗里既不提示、「🖼 先补齐资产图」按钮也不出现，一键成片的补资产
        # 环节同样跳过——用户在资产页只能一直看着"每个角色一张图"。
        # 资产库是否完整是**项目级**属性，跟"这一轮还剩几个镜头要出片"无关。
        used_chars: set[str] = set()
        used_locs: set[str] = set()
        #: 镜头里出现过的道具名（2026-10-08 新增）。
        #:
        #: ⚠️ 与 used_locs 的**关键差异**：场景走归一（canonical_locations），
        #: 道具**不归一**。原因是道具没有 `SceneAlias` 那样的别名表——归一函数
        #: `canonical_of` 对道具只做确定性清洗（剥时间/内外前缀），而道具名里
        #: 本来就没有那些前缀；真需要归一时用户在要素页改一次名即可。
        #: 这里若强行归一，反而会把「断魂刀」这种短名清成空、整批丢失。
        #:
        #: 它**不参与花费闸门报数**：道具是从拆解结果里直接长出来的，
        #: 不像角色造型那样需要"先识别再补建阶段"，所以只统计已有多少、
        #: 缺图多少，见 `assets.props_no_image`。
        used_props: set[str] = set()
        char_eps: dict[str, set[int]] = {}
        # 角色出现过的**归一场景**集合：判定"场景绑定服装对本项目是否有效"用它。
        # 场景绑定服装的判据是"人物再次进入这个场景"，与集号无关，所以不能沿用
        # char_eps 那套集区间判断（否则第 1 集建立的睡衣在第 10 集会被当成"缺图"，
        # 或反过来被算成缺口去重复出图）。
        from .scenes import canonical_locations, canonical_map, canonical_of
        # 复用已加载的 shots（B29）：原先 canonical_map 内部会**再查一遍**
        # 该项目全部镜头，1424 镜的项目等于把整张镜头表加载两遍。
        canon = canonical_map(session, project_id, shots=shots)
        char_scenes: dict[str, set[str]] = {}
        for s in active:
            cn = canon.get((s.location or "").strip(), (s.location or "").strip())
            for c in effective_characters(s):
                used_chars.add(c)
                char_eps.setdefault(c, set()).add(s.episode)
                if cn:
                    char_scenes.setdefault(c, set()).add(cn)
            # 归一后再收：场景资产是按归一名存的，这里若收原名，
            # 「夜 内 楚家公馆-客厅」会被算成一个"缺图场景"去重复出一张图
            # （而它和「楚家公馆-客厅」本就是同一个房间、已经有图了）。
            # 传 canon 进去是为了不逐名查库（B29），语义与出片链路上那次调用一致。
            for lc in canonical_locations(session, project_id, s, canon=canon):
                used_locs.add(lc)
            # 道具：只在**镜头有这一列**时读。老库这一列是 NULL（迁移不回填），
            # 解析失败当空数组——绝不能因为一列脏数据让整个生产检查 500。
            try:
                for x in json.loads(getattr(s, "props", None) or "[]"):
                    if isinstance(x, str) and x.strip():
                        used_props.add(x.strip())
            except (ValueError, TypeError):
                pass
        # 用户删掉的角色/场景/道具不再计入缺口（需求 4）。放在收集之后统一减，
        # 而不是在循环里逐个判——循环里判会漏掉 char_eps / char_scenes 这些
        # 副产物，它们带着已删角色继续参与服装继承的判定。
        if _gone:
            used_chars -= _gone
            used_locs -= _gone
            for n in _gone:
                char_eps.pop(n, None)
                char_scenes.pop(n, None)
        # ⚠️ 道具**必须单独减一次**，而且用的是**按 kind 收的**那一份
        # （2026-10-27 用户报障「删除的资产还是被生成出来了」）。
        #
        # 道具是 2026-10-08 才加进这个函数的，上面那次减法当时写的是
        # `used_chars` / `used_locs` 两行，没有跟着补第三行 —— 于是
        # `used_props` 里永远留着已被删除的道具名。而下面
        # `props_no_image = used_props - prop_img` 里的 `prop_img` 只收
        # **有图且没被删**的行，被删的那件本来就不该有图 → 它**恒在缺口里**。
        #
        # 危害不止是"多画一张"：`_prop_items` 会把缺口摊成生图条目，
        # `ensure_prop_asset` 找不到没被删的同名行就**新建一行**，
        # 于是库里出现"一行墓碑 + 一行在用"。而 `asset_gate.deleted_names`
        # 有一条刻意规则——同名还有在用行时不算删过——被自己新建的这一行
        # 一撞，这次删除就**永久失效**：`_auto_inject_refs` 里的
        # `if pn in _gone: continue` 从此判不中，那件道具的参考图又回到每一镜。
        # 实测（dev 项目 1017）：删掉「手机」跑一次补全 → deleted_names
        # 里就没有「手机」了。所以这不是"删了还被生成"，是"删了一下就再也没删掉"。
        #
        # 按 kind 收而不是复用上面的 `_gone`：后者跨三类混在一起，
        # 道具「林晨」被删会连带把角色「林晨」也从 used_chars 里减掉。
        if _gone_by_kind["prop"]:
            used_props -= _gone_by_kind["prop"]

        # 角色通用定妆图（Asset kind=character）：阶段无图时 _auto_inject_refs 的回退项。
        # 资产页展示的就是这一层（每角色 1 张），阶段图是它的按集细分。
        char_generic = {a.name for a in assets
                        if a.kind == "character" and a.image_url}

        # 两趟扫描：先算出"哪些角色已有可注入的阶段图"，再据此判定每个缺图阶段
        # 到底是"只丢造型区分"还是"真的一张参考图都注入不到"。
        # （一趟扫不行：缺图的变体阶段常常排在它的基础阶段之前，单趟会把
        #  fallback 误判成 False，把"其实有基础定妆图兜着"的阶段报成红牌。）
        from .costumes import resolve_stage_image
        covered: set[str] = set()          # 有"可注入"阶段图的角色
        no_image: list[AssetStage] = []
        followers = 0                      # 指针行：共用源那张图，**不该再出图**
        scene_bound_n = 0

        def _relevant(st: AssetStage) -> bool:
            """本阶段对该项目是否"真的会被用到"（决定它缺图算不算缺口）。"""
            eps = char_eps.get(st.character_name, set())
            loc = (st.location or "").strip()
            if st.scene_bound and loc:
                # 场景决定型服装：只要该角色在**任何一集**进过这个归一场景就有效
                return loc in char_scenes.get(st.character_name, set())
            if loc:
                return (loc in char_scenes.get(st.character_name, set())
                        and any(st.ep_from <= e <= st.ep_to for e in eps))
            return any(st.ep_from <= e <= st.ep_to for e in eps)

        for st in stages:
            if st.character_name not in used_chars:
                continue
            if st.scene_bound and (st.location or "").strip():
                scene_bound_n += 1
            hit = _relevant(st)
            img = resolve_stage_image(session, st)
            if not st.image_url and st.source_stage_id:
                # 指针行：与源阶段是同一件衣服，注入时解析到源那张图。
                # 绝不能进 stages_no_image——那会让它被当成缺口去生成一张**新的**图，
                # 同一件衣服就长出两个样子（正是要消灭的不一致），还多花一次钱。
                followers += 1
                if hit and img:
                    covered.add(st.character_name)
                continue
            if not img:
                if hit:
                    no_image.append(st)
            elif hit:
                covered.add(st.character_name)

        def _stage_row(st: AssetStage) -> dict:
            return {"id": st.id, "character_name": st.character_name,
                    "stage_name": st.stage_name,
                    "ep_from": st.ep_from, "ep_to": st.ep_to,
                    "image_url": st.image_url,
                    "location": st.location,
                    "scene_bound": bool(st.scene_bound),
                    # True = 该角色另有可注入的图（同集基础阶段图 or 通用定妆图）
                    # → 仍能保人物一致，只是丢这一阶段特有的服装/妆容区分
                    "fallback": (st.character_name in char_generic
                                 or st.character_name in covered)}

        # 阶段无专属图（有图可回退时不阻断，仅丢造型区分）
        stages_no_image: list[dict] = [_stage_row(st) for st in no_image]

        # 真·无参考图的角色 = 既没有命中集区间的阶段图，也没有角色通用图。
        # 只有这一档才会让首帧退化成纯文生图（人物一致性无从谈起）。
        chars_no_asset = [
            {"name": n, "episodes": sorted(char_eps.get(n, set()))}
            for n in sorted(used_chars - covered - char_generic)
        ]
        # 场景资产名也要过一遍归一再比：老项目的资产行是按 Shot.location 原值
        # 建的（「夜 内 楚家公馆-客厅」），而 used_locs 已经是归一名。不归一就会
        # 把一个**已经有图**的房间报成缺图，去重复生成一张。
        loc_img = {c for c in (canonical_of(session, project_id, a.name)
                               for a in assets
                               if a.kind == "location" and a.image_url) if c}
        locations_no_image = sorted(used_locs - loc_img)
        # 道具缺口（2026-10-08）。与场景**同一个口径**：镜头里用到、但没有任何
        # 有图的道具资产。不比场景多一步归一，理由见 used_props 的注释。
        prop_img = {a.name for a in assets
                    if a.kind == "prop" and a.image_url and not a.deleted_at}
        props_no_image = sorted(used_props - prop_img)

        # 「🖼 补齐缺失资产」真正会生成的图片张数。
        # 不能用 len(stages_no_image) + len(chars_no_asset)：识别跑过之后，
        # 一个角色的每套衣服都是一个缺图阶段，而这个角色**同时**也在
        # chars_no_asset 里（它一张图都还没有），两边把同一批图数了两遍
        # （实测「测试3」：24 个缺图阶段 + 8 个无图角色 = 报 32，实际只出 25 张）。
        # 无图角色只有在**没有任何阶段覆盖它的出场集**时才会额外补建一个
        # 「默认造型」阶段（jobs._plan_default_stages 会避开已被占用的集）。
        stage_eps: dict[str, set[int]] = {}
        for st in stages:
            stage_eps.setdefault(st.character_name, set()).update(
                range(st.ep_from, st.ep_to + 1))
        chars_need_stage = [
            r["name"] for r in chars_no_asset
            if set(r["episodes"]) - stage_eps.get(r["name"], set())
        ]
        assets_to_generate = (len(stages_no_image) + len(chars_need_stage)
                              + len(locations_no_image) + len(props_no_image))

        # 花费闸门用的报数：要出几张图、免费复用几张
        costumes = {
            "stages_total": len(stages),
            # 识别是否跑过。没跑过时下面所有"要出几张图"的报数都不作数——
            # 它只等于"没有定妆图的角色数"，与剧情真正需要的服装套数无关。
            "scanned": bool(stages),
            "scene_bound": scene_bound_n,
            "followers": followers,          # 指针行：共用同一件衣服的图，不出图不花钱
            "to_generate": len(no_image),    # 真要花钱生成的张数
        }

    # ---- 提示分级 ----
    # 必须区分「还没做」与「会出错」：此前全是纯字符串，前端只能一律渲染成红字，
    # 于是刚导入剧本点「AI 生产」满屏标红——而那些红字说的全是流程还没走到，
    # 不是故障。level 决定前端用灰/黄/红：
    #   info  = 流程未开始，属正常（用户照着流程走就会消失）
    #   warn  = 会自动降级但能跑完
    #   error = 真会失败，动手前该先处理
    warnings: list[dict] = []
    if not costumes["scanned"]:
        warnings.append({
            "level": "info",
            "text": "尚未识别全剧服装造型。这是流程的第 ② 步——跑一次（纯文本、"
                    "不出图、不花生图的钱）之后，资产报数才反映剧情真正需要的服装套数。",
            "action": "costume_scan",
        })
    return {
        "project_id": project_id,
        "generation_mode": gen_mode,
        "video_model": video_model,
        "image_model": image_model,
        "base_aspect": base_aspect,
        "resolution": resolution,
        # 首帧路线已下线：这两项与下面的 first_frames 恒为"没有首帧这一步"（见模块头）。
        "i2va_supported": False,
        "i2va_reason": "首帧路线已下线，出片统一走全能参考",
        "shots": {
            "total": len(shots),
            "active": len(active),
            "with_video": len(active) - len(need_video),
            "need_video": len(need_video),
        },
        "first_frames": {"mode_active": False, "required": 0, "ready": 0, "missing": []},
        "assets": {
            "stages_no_image": stages_no_image,
            "chars_no_asset": chars_no_asset,
            "locations_no_image": locations_no_image,
            # 道具缺口（2026-10-08）：镜头里出现、但没有有图资产的。
            # 前端要素页的道具 tab / 一键补全的缺口清单读的就是它。
            "props_no_image": props_no_image,
            # 无图角色里还需要额外补建「默认造型」阶段的（其余角色的缺口已经
            # 体现在 stages_no_image 里了，别重复计数）
            "chars_need_stage": chars_need_stage,
            # 「🖼 补齐缺失资产」点下去真会生成的图片张数（去重后的口径）
            "to_generate": assets_to_generate,
        },
        "costumes": costumes,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# 逐集、逐镜的「能不能写镜头脚本」体检（2026-11-19）
# ---------------------------------------------------------------------------
#
# 镜头脚本（视频提示词）改由 Muse 撰写，而且**必须在场景资产出图之后写**：
# 脚本是对着场景图写的（陈设在哪、门在哪一侧、光从哪来），先写后出图，
# 两边必然对不上。所以要有一处能回答「这一镜的场景图有了没有」，
# 读工具 `get_episode_readiness` 与写工具锁定脚本时的闸门共用它——
# 两处各判一遍，迟早出现"体检说齐了、锁定时却被拒"。

#: 场景没有可用图的原因 → 给人看的一句话。
SCENE_REASON_CN = {
    "no_asset": "要素页还没有这个场景的资产行",
    "deleted": "这个场景资产已被删除",
    "no_image": "场景资产还没有出图",
}


def scene_image_status(session, shot, *, canon: dict[str, str] | None = None,
                       cache: dict | None = None) -> dict:
    """这一镜**所属场景**（`Shot.location`）的资产有没有可用的图。

    返回 `{location, scene, has_image, reason}`：
      · `location` 原样的 `Shot.location`；`scene` 归一后的场景名（资产按它存）
      · `has_image`：True / False；镜头**没写场景**时为 None（没有可对着写的场景，
        不在「先出场景图」这条规则之内）
      · `reason`：has_image=False 时的原因，`SCENE_REASON_CN` 的键

    「可用的图」与出片时注入场景参考图**同一顺序**
    （`jobs._auto_inject_refs_with_source` 的场景段）：覆盖本镜的场景造型图 →
    场景多视角里的主视角图 → 资产自己的 `image_url`，任一有值即可。

    `canon`：批量时把 `scenes.canonical_map` 的结果传进来，免得逐镜查别名表。
    `cache`：批量时传同一个 dict，同一个场景只查一次（造型图那一层仍按镜判）。
    """
    from . import asset_gate
    from .scenes import canonical_of, normalize_location

    raw = (shot.location or "").strip()
    if not raw:
        return {"location": None, "scene": None, "has_image": None, "reason": None}
    pid = shot.project_id
    name = ((canon.get(raw) or normalize_location(raw)[0] or raw) if canon is not None
            else (canonical_of(session, pid, raw) or raw))
    out = {"location": raw, "scene": name, "has_image": False, "reason": None}

    key = ("scene", name, raw)
    hit = cache.get(key) if cache is not None else None
    if hit is None:
        q = asset_gate.alive(session.query(Asset).filter(
            Asset.project_id == pid, Asset.kind == "location"))
        a = q.filter(Asset.name == name).first()
        if a is None and raw != name:
            a = q.filter(Asset.name == raw).first()     # 老项目按原名建的资产行
        reason = None
        if a is None:
            dead = (session.query(Asset.id)
                    .filter(Asset.project_id == pid, Asset.kind == "location",
                            Asset.name.in_([name, raw]),
                            Asset.deleted_at.isnot(None)).first())
            reason = "deleted" if dead else "no_asset"
        hit = {"asset": a, "reason": reason, "base": None, "stages": []}
        if a is not None:
            from .scene_view import pick_for_shot
            base, _label = pick_for_shot(session, a.id, shot=shot)
            hit["base"] = (base or a.image_url or "").strip() or None
            hit["stages"] = (session.query(AssetStage)
                             .filter(AssetStage.project_id == pid,
                                     AssetStage.character_name == a.name,
                                     AssetStage.deleted_at.is_(None),
                                     AssetStage.image_url.isnot(None)).all())
        if cache is not None:
            cache[key] = hit
    if hit["asset"] is None:
        out["reason"] = hit["reason"]
        return out
    url = hit["base"]
    if hit["stages"]:
        from .stage_pick import pick as _pick
        st = _pick(hit["stages"], episode=shot.episode or 1, order=shot.order or 0)
        if st is not None and (st.image_url or "").strip():
            url = st.image_url
    if url:
        out["has_image"] = True
    else:
        out["reason"] = "no_image"
    return out


def episode_readiness(project_id: str, episode: int) -> dict:
    """一集里每一镜「能不能写（并锁定）镜头脚本」的体检。纯只读。

    逐镜：镜号、场景及其图、出场角色及各自的图、脚本状态、是否过期；
    汇总：还缺图的场景 / 角色（各自卡住了哪几镜）、哪些镜头还没锁定脚本。
    """
    from . import asset_gate
    from .scenes import canonical_map
    from .stage_coverage import card_image

    ep = int(episode)
    with get_session() as session:
        if session.get(Project, project_id) is None:
            return {"error": "project not found"}
        shots = (session.query(Shot)
                 .filter(Shot.project_id == project_id, Shot.episode == ep)
                 .order_by(Shot.order).all())
        canon = canonical_map(session, project_id, shots=shots)
        gone_chars = asset_gate.deleted_names(session, project_id, "character")
        cache: dict = {}
        char_img: dict[str, bool] = {}

        rows: list[dict] = []
        scenes_missing: dict[str, dict] = {}
        chars_missing: dict[str, list[int]] = {}
        no_location: list[int] = []
        unlocked: list[int] = []
        stale: list[int] = []
        locked_n = 0
        active_n = 0
        for idx, s in enumerate(shots, start=1):
            sc = scene_image_status(session, s, canon=canon, cache=cache)
            chars = []
            for c in effective_characters(s):
                if c not in char_img:
                    char_img[c] = (c not in gone_chars
                                   and bool(card_image(session, project_id, c)))
                row = {"name": c, "has_image": char_img[c]}
                if c in gone_chars:
                    row["deleted"] = True
                chars.append(row)
            ov = _override_of(s)
            locked = bool(str(ov.get("prompt") or "").strip())
            row = {
                "shot_id": s.id, "order": s.order, "index": idx,
                "location": sc["location"], "scene": sc["scene"],
                "scene_has_image": sc["has_image"],
                "characters": chars,
                "prompt_state": s.prompt_state,
                "locked": locked,
                "stale": bool(s.stale), "stale_reason": s.stale_reason,
                "has_first_frame": bool((s.first_frame_url or "").strip()),
                # caller = 按调用方写的首帧描述出的，已钉住，出片时原样使用；
                # pinned = 用户在镜头设置里手填的；generated = 后端蒸馏出的（出片时会重画）
                "first_frame_source": (
                    (ov.get("first_frame_source") or "pinned") if ov.get("first_frame_url")
                    else ("generated" if (s.first_frame_url or "").strip() else None)),
                "has_video": bool((s.video_url or "").strip()),
            }
            if sc["reason"]:
                row["scene_reason"] = sc["reason"]
            if s.disabled:
                row["disabled"] = True
            if s.is_special:
                row["special"] = True
            rows.append(row)
            if s.disabled or s.is_special:
                continue                      # 不出片的镜头不进汇总
            active_n += 1
            if locked:
                locked_n += 1
            else:
                unlocked.append(s.order)
            if s.stale:
                stale.append(s.order)
            if sc["has_image"] is None:
                no_location.append(s.order)
            elif sc["has_image"] is False:
                m = scenes_missing.setdefault(
                    sc["scene"], {"scene": sc["scene"], "reason": sc["reason"],
                                  "shots": []})
                m["shots"].append(s.order)
            for c in chars:
                if not c["has_image"] and not c.get("deleted"):
                    chars_missing.setdefault(c["name"], []).append(s.order)

    return {
        "project_id": project_id, "episode": ep, "shots": rows,
        "summary": {
            "shots": active_n,
            "locked": locked_n,
            "unlocked_orders": unlocked,
            "stale_orders": stale,
            "scenes_missing_image": list(scenes_missing.values()),
            "characters_missing_image": [{"name": n, "shots": o}
                                         for n, o in chars_missing.items()],
            "shots_without_location": no_location,
            #: 场景图都齐了 → 可以开始写并锁定这一集的镜头脚本
            "scene_assets_ready": active_n > 0 and not scenes_missing,
        },
    }
