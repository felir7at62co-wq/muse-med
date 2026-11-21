"""资产改名的连带迁移（R1）。

## 为什么改名不能只改 Asset.name

`Asset.name` 不只是显示用的标签，它是**连接键**：镜头与资产的关联全靠名字相等
（全库 12 处 `Asset.name == ...` 查询）。只改 Asset 那一行的后果：

    把「陆明」改名为「陆医生」
      → 208 个镜头的 Shot.characters 仍是「陆明」
      → jobs.py 的 `Asset.name == c` 匹配 0 条
      → 这些镜头的定妆图**全部注入不到**，静默失效、无任何报错
      → 另有 43 个 AssetStage.character_name 一起失联

用户看到的是"改了个名字，然后出片突然没有人物一致性了"，几乎不可能反查到原因。

## 方案 B：改名即迁移

在**同一个事务**里把所有引用一起改掉，语义上真的是"把这个角色改叫别的"：

| 表 / 字段                        | 角色 | 场景 |
|----------------------------------|:----:|:----:|
| `Asset.name`                     |  ✓   |  ✓   |
| `Shot.characters`（JSON 数组）    |  ✓   |      |
| `Shot.location`                  |      |  ✓   |
| `Shot.ref_overrides`（JSON add/remove） | ✓ |      |
| `AssetStage.character_name`      |  ✓   |      |
| `AssetStage.location`（绑定场景） |      |  ✓   |
| `CharacterAlias.raw_name/canonical` | ✓ |      |
| `SceneAlias.raw_name/canonical`  |      |  ✓   |
| `SceneAnchor.location/canonical` |      |  ✓   |

漏改任何一处都是静默断链，所以这里**逐表列全**，并在返回值里报告每张表改了几行——
调用方（和用户）能当场看到"这次改名影响了 208 个镜头 + 43 个造型阶段"，
而不是改完什么都不知道。
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import func

from .db import (Asset, AssetImageVersion, AssetStage, CharacterAlias,
                 SceneAlias, SceneAnchor, Shot)

log = logging.getLogger(__name__)


def _rename_in_json_list(raw: str | None, old: str, new: str) -> tuple[str | None, bool]:
    """把 JSON 数组文本里的 old 换成 new。返回 (新文本, 是否改动)。"""
    if not raw:
        return raw, False
    try:
        arr = json.loads(raw)
    except (ValueError, TypeError):
        return raw, False
    if not isinstance(arr, list) or old not in arr:
        return raw, False
    # 去重：改名后可能与已有项撞名（把「小陆」改成「陆明」而该镜本就有「陆明」）
    seen, out = set(), []
    for x in arr:
        v = new if x == old else x
        if v not in seen:
            seen.add(v)
            out.append(v)
    return json.dumps(out, ensure_ascii=False), True


def _rename_in_ref_overrides(raw: str | None, old: str, new: str
                             ) -> tuple[str | None, bool]:
    """ref_overrides 里的**四种**名字载体都要改。返回 (新文本, 是否改动)。

    ## 为什么不止 add / remove（2026-10-23 用户反馈）

    用户原话：「合并资产后，视频提示词和引用中还是会出现合并时被放弃的资产」。
    排查发现 `ref_overrides` 里还藏着两处**记着实体名字**的东西，此前一处都没改：

      · `ref_owners`：`[{url, kind, name}]`，用户手动给某个实体换图时写下的归属。
      · `ref_labels`：`{url: "角色「小陆」"}`，给提示词优化器看的对照标签
        （它据此把 `@名字` 转写成 `@图片N`）。

    漏改的后果不是"显示得不好看"，而是**静默丢图**：
    `jobs._owned_user_refs` 拿 `owner.name` 去比 `effective_characters(shot)`，
    改名后那个名字已经不在本镜的生效集合里 → 这张图被判成"属于已不在本镜的实体"
    → 直接从注入列表里剔掉，只留一行 warning 日志。用户看到的是
    「我明明给这一镜换过图，合并之后它就没了」，而且没有任何界面提示。

    `ref_labels` 漏改的后果轻一些但同样真实：优化器拿到的对照表里写着旧名字，
    于是提示词里的 `@新名字` 转写不出编号 —— 等于白带一张参考图。
    """
    if not raw:
        return raw, False
    try:
        ov = json.loads(raw)
    except (ValueError, TypeError):
        return raw, False
    if not isinstance(ov, dict):
        return raw, False
    changed = False
    for key in ("add", "remove"):
        arr = ov.get(key)
        if isinstance(arr, list) and old in arr:
            seen, out = set(), []
            for x in arr:
                v = new if x == old else x
                if v not in seen:
                    seen.add(v)
                    out.append(v)
            ov[key] = out
            changed = True

    # 归属：只改名字，url/kind 原样（这张图还是这张图，只是它属于的实体改了名）
    owners = ov.get("ref_owners")
    if isinstance(owners, list):
        hit = False
        for o in owners:
            if isinstance(o, dict) and (o.get("name") or "").strip() == old:
                o["name"] = new
                hit = True
        if hit:
            changed = True

    # 标签：值形如 `角色「小陆」`。这里**按整段精确重写**而不是做子串替换 ——
    # 子串替换会把「小陆」误伤到标签里别的字上（比如项目里另有一个
    # 「小陆子」的标签），而标签只有我们自己拼出来的那三种形态。
    labels = ov.get("ref_labels")
    if isinstance(labels, dict):
        hit = False
        for u, lb in list(labels.items()):
            if not isinstance(lb, str):
                continue
            for pre in ("角色", "场景", "道具"):
                if lb == f"{pre}「{old}」":
                    labels[u] = f"{pre}「{new}」"
                    hit = True
                    break
        if hit:
            changed = True

    return (json.dumps(ov, ensure_ascii=False), True) if changed else (raw, False)


def rename_asset_everywhere(session, project_id: str, kind: str,
                            old: str, new: str,
                            aliases: bool = True,
                            assets: bool = True) -> dict[str, int]:
    """把一个资产名在**所有引用处**改掉。调用方负责 commit。

    `kind`：`character` 走角色相关的表，`location` 走场景相关的表。
    返回 `{表名: 改动行数}`——报给用户看"这次改名影响了多少东西"。

    `aliases=False`：**不动别名表**。用于"把别名映射应用到资产上"那条路径
    （`char_alias.apply_character_aliases`）——那里的 `raw_name → canonical`
    正是**要保留的桥**，跟着改等于把映射本身抹掉，下次重识别又从零开始。
    与之相对，用户手动改名（`PATCH /assets/{id}` 带 name）要走 `True`：
    那是在表态"这个角色以后就叫这个名字"，映射该跟着走。

    `assets=False`：**不把 `Asset.name` 一起改掉**，只迁移镜头/造型等引用。
    用于合并资产（`asset_merge`）：那里要把被并掉的行留成**墓碑**，而墓碑
    **必须保留自己的名字**。原因不是洁癖 —— 见下。

    ⚠️ **墓碑不能与被留行同名**（`assets=False` 存在的唯一理由）。
    `asset_gate.deleted_names` 是按行收名字、**不检查有没有同名在用行**：

        UPDATE assets SET name='陆明' WHERE name='陆医生'   -- 被并的行改叫「陆明」
        UPDATE assets SET deleted_at=... WHERE id=<被并行>   -- 再打成墓碑

    于是 `deleted_names` 返回 `{'陆明'}` —— **被留的那一行也进了"用户删过"的
    集合**，`jobs._auto_inject_refs_detailed` 会把它的参考图一起剔除：
    合并完这个角色突然不出图了，而且没有任何报错。既有的两条收敛路径
    （`scenes.reconcile_location_assets` / `char_alias.apply_character_aliases`）
    用 `session.delete` 真删，所以从未踩到；改软删就绕不开这一条。

    ⚠️ 两处的差别只在别名表一行，但方向是**相反**的，所以必须由调用方点名。
    """
    counts: dict[str, int] = {}

    def bump(k: str, n: int = 1) -> None:
        if n:
            counts[k] = counts.get(k, 0) + n

    def _blocking(sh, bump_key: str) -> None:
        """改走位台账里的旧名（2026-10-23）。

        ## 只动台账，**不动 `gen_prompt` 正文**（用户 2026-10-23 裁定）

        正文里那个名字是模型当时写下的**措辞**，不是"引用某个资产"：
        dev 全库实测，墓碑名字在 `gen_prompt` 里出现 1468 次，**100% 是散文**
        （`@旧名` / `旧名@图片N` 这两种显式引用形态一次都没有）。

        而中文没有词边界，"看到陆延舟"与"总裁助理"在字面上无法区分 ——
        试过两套判据（前后邻字符白名单、只改显式引用形态），抽样本看都同时有
        误改和漏改：场景名「室内」会把「总裁办公室内」改成「总裁办公顾家大宅外」
        （实测 41 处），道具「包」命中「包装」，单字角色名「我」「他」在前
        3000 镜里出现 3101 次。改错的代价（把用户的稿子改坏）远大于收益。

        结构化引用改好之后，正文里的旧名会**自然失去 chip**（`resolveRefs` 按
        当前生效角色集构建，旧名已不在其中），不会冒充"已删除的引用"。

        ## 台账为什么必须改

        `blocking_out` 的 key 是角色名，会被渲染成「上一镜结束时 林母 在…」
        注入下一镜的提示词。旧名留在这儿，下一镜的提示词里就会出现一个
        已经不存在的角色 —— 而且这是**结构化数据**，改它没有歧义。
        """
        try:
            bo = json.loads(sh.blocking_out or "")
        except (ValueError, TypeError):
            bo = None
        if isinstance(bo, dict) and old in bo and new not in bo:
            bo[new] = bo.pop(old)
            sh.blocking_out = json.dumps(bo, ensure_ascii=False)
            bump(f"{bump_key}.blocking_out")

    if kind == "character":
        for sh in session.query(Shot).filter(Shot.project_id == project_id).all():
            new_chars, c1 = _rename_in_json_list(sh.characters, old, new)
            if c1:
                sh.characters = new_chars
                bump("shots.characters")
            # ⚠️ **L1.5 在场推导也要一起改**（2026-10-12 补）。
            #
            # `present_characters` 是 continuity 从 `characters` 推导出来的，
            # 但它是**独立一列**、存的是推导当时的字符串。改名只改 characters 的话，
            # 这一列会留着旧名：下一镜注入时 `effective_characters` 把
            # (L1 ∪ L1.5) 合并，那些旧名就成了一批**查不到 Asset 的幽灵角色**
            # —— 它们不会报错，只是静默地不注入参考图（正是本模块存在的理由）。
            new_pres, c1b = _rename_in_json_list(
                getattr(sh, "present_characters", None), old, new)
            if c1b:
                sh.present_characters = new_pres
                bump("shots.present_characters")
            new_ov, c2 = _rename_in_ref_overrides(sh.ref_overrides, old, new)
            if c2:
                sh.ref_overrides = new_ov
                bump("shots.ref_overrides")
            _blocking(sh, "shots")

        n = (session.query(AssetStage)
             .filter(AssetStage.project_id == project_id,
                     AssetStage.character_name == old)
             .update({AssetStage.character_name: new}, synchronize_session=False))
        bump("asset_stages.character_name", n)

        if aliases:
            for col in (CharacterAlias.raw_name, CharacterAlias.canonical):
                n = (session.query(CharacterAlias)
                     .filter(CharacterAlias.project_id == project_id, col == old)
                     .update({col: new}, synchronize_session=False))
                bump(f"character_aliases.{col.key}", n)

    elif kind == "location":
        n = (session.query(Shot)
             .filter(Shot.project_id == project_id, Shot.location == old)
             .update({Shot.location: new}, synchronize_session=False))
        bump("shots.location", n)

        n = (session.query(AssetStage)
             .filter(AssetStage.project_id == project_id,
                     AssetStage.location == old)
             .update({AssetStage.location: new}, synchronize_session=False))
        bump("asset_stages.location", n)

        for col in (SceneAlias.raw_name, SceneAlias.canonical):
            if not aliases:
                break
            n = (session.query(SceneAlias)
                 .filter(SceneAlias.project_id == project_id, col == old)
                 .update({col: new}, synchronize_session=False))
            bump(f"scene_aliases.{col.key}", n)

        for col in (SceneAnchor.location, SceneAnchor.canonical):
            n = (session.query(SceneAnchor)
                 .filter(SceneAnchor.project_id == project_id, col == old)
                 .update({col: new}, synchronize_session=False))
            bump(f"scene_anchors.{col.key}", n)

        # 站位图按**场景名**记所属场景，名字要跟着走。
        from . import blocking_images
        bump("blocking_images.location",
             blocking_images.rename_location(session, project_id, old, new))

    elif kind == "prop":
        # 道具（2026-10-08）：只连 Shot.props 这一处。
        #
        # 与角色/场景的差别是**没有别名表**：道具不走 `CharacterAlias` /
        # `SceneAlias` 那套归一（没有"同一个道具的多种写法"要收敛），
        # 所以这里改一处就够、也不会漏改。
        #
        # ⚠️ 但漏改这一处的代价与角色侧一样大：`Shot.props` 是**注入参考图的
        # 唯一连接键**（jobs._auto_inject_refs_detailed 按名字查 Asset），
        # 改了 Asset.name 而没改这里，该道具从下一镜起全部静默不再注入。
        for sh in session.query(Shot).filter(Shot.project_id == project_id).all():
            new_props, n = _rename_in_json_list(sh.props, old, new)
            if n:
                sh.props = new_props
                bump("shots.props", n)
            _blocking(sh, "shots")

    # 最后改 Asset 本身：放在最后是为了让上面的查询都还能按旧名匹配到。
    # `assets=False` 时不改（见函数头：合并要保持墓碑原名，不同名才不毒化
    # `asset_gate.deleted_names`）。
    if assets:
        n = (session.query(Asset)
             .filter(Asset.project_id == project_id, Asset.kind == kind,
                     Asset.name == old)
             .update({Asset.name: new}, synchronize_session=False))
        bump("assets.name", n)

    log.info("[rename] 项目 %s 把 %s「%s」改名为「%s」：%s",
             project_id, kind, old, new, counts)
    return counts
