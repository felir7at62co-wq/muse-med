"""资产图版本历史：角色 / 场景 / 造型三种目标共用。

## 解决什么

镜头早就有 `shot_versions`（每次出片落一条，可回退），但**资产图与造型图没有**：
重新生成 = 直接覆盖 `Asset.image_url` / `AssetStage.image_url`，旧图当场找不回来。

资产生图是花钱的，用户点「重新生成」多半只是想换一张试试。试坏了永久丢失
不可接受——这正是用户 2026-10-05 提的"图片的历史版本也需要可以查看和切换"。

## 三种目标，一张表

`kind` ∈ {`stage`, `character`, `location`, `prop`}：
- `stage` → 目标行是 `asset_stages.id`（造型定妆图）
- 其余 → 目标行是 `assets.id`（角色/场景/道具资产图）

合成一张表而不是两张：「取某目标的版本列表」「回退到某版」这两件事语义完全
一样，分表只会让上层写两遍。

## 记录时机

**所有**把图写进这两个字段的地方都必须记一笔，否则版本链会断——而断链是静默的
（用户看到"有 3 个版本"，实际上某次生成没进去，回退时会莫名其妙跳回更旧的图）。

落点共四类，已全部覆盖：
1. `jobs._gen_and_save` —— AI 生成后写回（三条分支：阶段 / 场景视角 / 资产）
2. `routers/assets.upsert-image` —— 用户上传或前端生成的图挂到资产上
3. `routers/stage_scene.patch_stage` —— 造型阶段改图（弹窗里生成/上传都走这条）
4. `adopt_asset_version` —— 回退本身也落一条（`source='adopt'`），
   这样"回退"本身也可回退，用户不会因为点错一下而丢掉刚做好的那张
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import text

from .db import Asset, AssetImageVersion, AssetStage, engine, get_session

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _adopted_no(session, target_id: str, rows: list) -> int | None:
    """这个目标**当前采用的是哪一版**。返回 `version_no`，判不出来给 None。

    唯一的权威判据是目标行上的 `adopted_version` 指针（`Asset` / `AssetStage`）。
    指针为 NULL（补这一列之前的存量）时退回"图与当前一致的最新一版"——**只取一版**。

    ⚠️ 这个"只取一版"是必须的（2026-10-15 修）：前端原来自己拿
    `版本行.image_url == 资产.image_url` 判断，而同一张图在历史里可以有**多行**
    （切回旧版曾各新增一行、上传与回填也会撞出同图的行），于是同一张图有几行、
    界面就同时打几个勾。用户实测在一个造型上看到四个勾、点哪个都取消不掉
    （点它只会再加一行）。**"当前是哪一版"是一个指针，不是一次 URL 比对。**
    """
    if not rows:
        return None
    kind = getattr(rows[0], "kind", None)
    row = (session.get(AssetStage, target_id) if kind == "stage"
           else session.get(Asset, target_id))
    if row is None:
        return None
    cur = getattr(row, "image_url", None) or ""
    by_no = {r.version_no: r for r in rows}
    # ① 指针可信时用它 —— 这一条才能让"用户点的就是那一版"在多行同图时成立。
    ptr = getattr(row, "adopted_version", None)
    if ptr and ptr in by_no and (by_no[ptr].image_url or "") == cur:
        return ptr
    # ② 指针为空、或它指的版本与当前图已经对不上（某条写图路径漏调 record()，
    #    或补这一列之前的存量）→ 退回"图与当前一致的最新一版"，**只取一版**。
    #    自愈比报错好：用户看到的仍是唯一一个勾，只是不再是"他上次点的那个版本号"。
    for r in rows:                      # 已按 version_no 倒序
        if (r.image_url or "") == cur:
            return r.version_no
    return None


def _set_adopted(session, kind: str, target_id: str, vno: int) -> None:
    """把"当前采用哪一版"指向 `vno`。

    写入点**只放在 record() 里**，因为它是"某张图被写进这个目标"的唯一汇聚点
    （十几个调用方各自写一遍指针，迟早有漏的——镜头侧的 `desub_jobs` /
    `upscale_jobs` 就各漏过一次同款，漏了的表现是"界面上没有任何一版标着当前"）。
    """
    row = (session.get(AssetStage, target_id) if kind == "stage"
           else session.get(Asset, target_id))
    if row is not None:
        row.adopted_version = vno


def record(*, project_id: str, kind: str, target_id: str, image_url: str | None,
           prompt: str | None = None, desc_in: str | None = None,
           model_id: str | None = None, prefer_no: int | None = None,
           source: str = "ai", label: str | None = None) -> int | None:
    """给某个目标落一条版本，并把"当前采用哪一版"指向它。返回版本号。

    `image_url` 为空时记一条"清空"版本。
    `prompt` 是**喂给模型的那份稿**，`desc_in` 是**用户可编辑的那份输入**
    （造型 = `asset_stages.description`；资产留空，因为 `Asset.prompt` 本身就是
    可编辑的整段稿）。两者必须分开存，理由见 `db.AssetImageVersion.desc_in`。

    ⚠️ **同一条「图 + 稿」不重复记**：`upsert-image` 这类接口会被前端重试、
    也会被"保存但不生图"的路径再调一次；而每次调用都记一笔的话，版本列表里会
    出现一串一模一样的图，用户根本分不清哪次是哪次。

    ⚠️ 判据必须是**全表**，不能只跟"最新一条"比（2026-10-15 修）。只比最新一条时，
    "切回一个更旧的版本"必然造出一条与旧行同 URL 的新行——prod 实测 45/45 条
    `adopt` 行都是重复 URL，用户来回切几次就在一个造型上看到四个勾。
    现在切回旧版会**复用**那一版的版本号、只挪指针，历史不再被复制品撑爆。

    `prefer_no` 是"用户点的就是这一版"（adopt 传它）。**存量库里同一份内容可能已有多行**
    ——老代码每次切版本都无条件追加，prod 实测 34 个 (target, url) 组有多行——
    纯按内容查就会命中版本号最大的那条，于是用户点了 v2、勾却跳到 v4 上
    （内容一样，但"我点的是哪个"对不上）。指名的那一版在候选里时优先它。
    """
    if not target_id or not project_id:
        return None
    try:
        with get_session() as session:
            cands = (session.query(AssetImageVersion)
                     .filter(AssetImageVersion.target_id == target_id,
                             AssetImageVersion.image_url == image_url,
                             AssetImageVersion.prompt == prompt,
                             AssetImageVersion.desc_in == desc_in)
                     .order_by(AssetImageVersion.version_no.desc()).all())
            same = None
            if prefer_no is not None:
                same = next((r for r in cands if r.version_no == prefer_no), None)
            if same is None and cands:
                same = cands[0]
            if same is not None:
                vno = same.version_no          # 同一份内容，复用已有版本号
            else:
                last = (session.query(AssetImageVersion)
                        .filter(AssetImageVersion.target_id == target_id)
                        .order_by(AssetImageVersion.version_no.desc()).first())
                vno = (last.version_no + 1) if last else 1
                session.add(AssetImageVersion(
                    id=uuid.uuid4().hex[:12], project_id=project_id, kind=kind,
                    target_id=target_id, version_no=vno, image_url=image_url,
                    prompt=prompt, desc_in=desc_in, model_id=model_id,
                    source=source, label=label, created_at=_now(),
                ))
            _set_adopted(session, kind, target_id, vno)
            session.commit()
            return vno
    except Exception:      # noqa: BLE001
        # 记版本失败**不能**让生图/上传失败——图已经生成、钱已经花了，
        # 丢一条历史远好过让用户看到"生成失败"而重花一次钱。
        logger.warning("[assetver] 记录版本失败 target=%s", target_id, exc_info=True)
        return None


def list_for(target_id: str, *, adopted: int | None = None) -> list[dict]:
    """某目标的版本列表，新的在前。

    `is_current` **由服务端判定**（读目标行的 `adopted_version` 指针），前端直接
    用它决定哪个按钮打勾——不再自己拿 URL 比对。理由见 `_adopted_no`：
    URL 相同的行可能有多条，前端比对会同时勾上好几版。
    """
    with get_session() as session:
        rows = (session.query(AssetImageVersion)
                .filter(AssetImageVersion.target_id == target_id)
                .order_by(AssetImageVersion.version_no.desc()).all())
        if adopted is None:
            adopted = _adopted_no(session, target_id, rows)
        return [{
            "version_no": r.version_no, "image_url": r.image_url,
            "prompt": r.prompt, "desc_in": r.desc_in,
            "model_id": r.model_id, "source": r.source,
            "label": r.label, "created_at": r.created_at,
            "is_current": (r.version_no == adopted),
        } for r in rows]


def get(target_id: str, version_no: int) -> dict | None:
    with get_session() as session:
        r = (session.query(AssetImageVersion)
             .filter(AssetImageVersion.target_id == target_id,
                     AssetImageVersion.version_no == version_no).first())
        if not r:
            return None
        return {"version_no": r.version_no, "image_url": r.image_url,
                "prompt": r.prompt, "desc_in": r.desc_in,
                "model_id": r.model_id, "source": r.source,
                "label": r.label, "created_at": r.created_at}


def backfill_from_current() -> dict:
    """给**存量**资产/造型各补一条「当前版本」。

    没有这一步的话，老项目点开版本列表是空的——用户看到"没有历史版本"，
    会以为这功能坏了，而不是"这张图是补上版本功能之前生成的"。
    补一条之后，第一次重新生成就会自然形成两条可切换的版本。

    幂等：已有任何版本记录的目标跳过，重复跑不会重复插。
    """
    from .db import Asset, AssetStage
    made = 0
    with get_session() as session:
        have = {r[0] for r in session.execute(
            text("SELECT DISTINCT target_id FROM asset_image_versions"))}

        stages = (session.query(AssetStage)
                  .filter(AssetStage.deleted_at.is_(None),
                          AssetStage.image_url.isnot(None)).all())
        assets = (session.query(Asset)
                  .filter(Asset.deleted_at.is_(None),
                          Asset.image_url.isnot(None)).all())

        # ⚠️ 这两个表都**没有 created_at 列**（asset_stages 连 prompt 都没有），
        # 所以回填条目只能用"现在"当时间戳。这不影响可读性：回填条目的
        # source='backfill'，前端会把它标成"原有图"而不是某次生成的结果。
        for st in stages:
            if st.id in have:
                continue
            session.add(AssetImageVersion(
                id=uuid.uuid4().hex[:12], project_id=st.project_id, kind="stage",
                target_id=st.id, version_no=1, image_url=st.image_url,
                prompt=st.description,          # 造型的"描述"就是它生图时的依据
                desc_in=st.description,         # 存量：描述本就是可编辑输入
                source="backfill", label=f"{st.character_name} · {st.stage_name}",
                created_at=_now(),
            ))
            st.adopted_version = 1              # 存量条目就是当前那张
            made += 1
        for a in assets:
            if a.id in have:
                continue
            session.add(AssetImageVersion(
                id=uuid.uuid4().hex[:12], project_id=a.project_id, kind=a.kind,
                target_id=a.id, version_no=1, image_url=a.image_url,
                prompt=a.prompt, source="backfill", label=a.name,
                created_at=_now(),
            ))
            a.adopted_version = 1               # 存量条目就是当前那张
            made += 1
        if made:
            session.commit()
    if made:
        logger.info("[assetver] 存量回填 %d 条版本", made)
    return {"created": made}
