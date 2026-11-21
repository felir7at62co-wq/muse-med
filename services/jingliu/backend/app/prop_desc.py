"""道具文字描述生成——把剧本里散落的道具线索汇成一段可用于生图的描述。

## 为什么需要（2026-10-20）

场景有 `scene_desc`、角色有 `character_profile` 与 `character_brief`，
**道具什么都没有**：`asset_prompt.prop_prompt(description=...)` 早就在签名里
留好了 `description` 参数，但全项目**没有任何调用方传过非空值**（三处传的都是
`a.prompt or None`，而 `prompt` 从未被道具写过）。后果是每一件道具图都只报道具名
——`prop_prompt` 模块自己写明这是**降级**行为：

    「没有就只报道具名——那是降级行为，与场景侧的 `scene_prompt` 同款口径」

对一个「三尺环首直刀」还能凑合，对「信物」「那块玉佩」这类名字就等于让模型
自己发明一件东西，全片每次生成都不一样。这正是用户报的
「拆解完拿不到完整提示词」在道具侧的形态。

## 与 scene_desc 的分工

骨架刻意与 `scene_desc` 保持同款（按实体分批、幂等、失败不阻断），
但归集方式不同：场景要先过 `canonical_of` 归一（同一个房间有十几种写法），
道具**不需要**——拆解写进 `Shot.props` 的名字就是建资产时用的名字，两边同源，
不会出现"同一个道具两个写法"的历史包袱（见 `jobs.ensure_prop_asset` 的注释）。
多一步归一反而会把两件不同道具（「玉佩」与「玉佩-断」）错误合并。

## 描述里写什么

只写**镜头能拍到的物理事实**：形制、材质、颜色、尺寸体量、工艺细节、磨损痕迹。

不写剧情、不写人物、不写它「象征着什么」——道具参考图是给模型看的一件静物，
写剧情只会让它往画面里加人（与 `scene_desc` 同一条纪律）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re

from .db import Asset, Project, Shot, desc_of, get_session

log = logging.getLogger(__name__)

#: 单个道具喂给模型的剧本片段上限。道具的外形线索通常一两句就说完了，
#: 再多是剧情不是形制。
_PROP_TEXT_CAP = 2000

#: 一件道具最多取多少个镜头的片段。55 镜里出现 55 次的道具没必要全喂。
_MAX_SHOTS_PER_PROP = 8

_SYS = (
    "你是影视道具美术指导。下面给你一部剧中**同一件道具**在若干镜头里的片段，"
    "请为它写一段用于生成**道具参考图**的画面描述。\n"
    "\n"
    "只写镜头能拍到的**物理事实**：\n"
    "1. 形制与尺寸（如：一把三尺长的环首直刀 / 一只掌心大小的白玉佩）\n"
    "2. 材质（金属/木质/玉石/织物……）与具体质感（哑光、镜面、粗糙、温润）\n"
    "3. 颜色（主色 + 点缀色）\n"
    "4. 工艺与细节（纹样、铭文、接缝、包边、镶嵌、做旧处理）\n"
    "5. **使用痕迹**——被用过、被珍惜或被糟蹋的证据：磨损、缺口、划痕、"
    "包浆、褪色、修补过的裂痕、绳结的松动。\n"
    "\n"
    "⚠️ **第 5 条必须写**。剧本没交代新旧时，按这件道具的用途与持有者"
    "主动定一个，写进描述里当成它的固有属性——和写颜色一样，不许留空。"
    "全新道具也要写出「为什么这么新」的具体物象（如未拆封的包装、出厂油膜）。\n"
    "\n"
    "**严禁**写以下内容：\n"
    "- 任何人物、手、人的动作或情绪（这是静物参考图，画面里不能有人）\n"
    "- 剧情、台词、事件、它的象征意义（那些由镜头提示词负责）\n"
    "- 主观评价（如「贵重的」「不祥的」），只写造成这种感觉的**具体物象**\n"
    "\n"
    "长度 60~150 字，中文，一段话，不分点。剧本没写到的细节可以按常理补全"
    "（如「刀」配刀鞘与护手），但不要编造剧本明确否定的东西。\n"
    '严格输出 JSON：{"description":"..."}，只输出 JSON。'
)


def _parse_json(raw: str) -> dict:
    """容错解析（与 scene_desc._parse_json 同口径）。失败抛 ValueError。"""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        text = text[start:end + 1]
    return json.loads(text)


async def describe_one_prop(name: str, refs: list[str],
                            model_id: str | None = None) -> str | None:
    """为单件道具生成描述。失败返回 None（调用方保持原样，不阻断）。"""
    from .providers.llm import LLMProvider

    body = "\n---\n".join(refs)[:_PROP_TEXT_CAP]
    if not body.strip():
        return None
    try:
        llm = LLMProvider(model_id=model_id)
        raw = await llm.complete(
            _SYS, f"道具名：{name}\n\n该道具出现的镜头片段：\n{body}",
            temperature=0.3)
        desc = (_parse_json(raw).get("description") or "").strip()
        return desc or None
    except Exception as e:  # noqa: BLE001 单件失败不阻断整批
        log.warning("[prop_desc] 道具 %r 描述生成失败: %r", name, e)
        return None


async def generate_prop_descriptions(project_id: str,
                                     model_id: str | None = None,
                                     overwrite: bool = False,
                                     progress_cb=None) -> dict:
    """为项目的所有道具生成描述并写入 `Asset.desc_auto`。

    `overwrite=False`（默认）时跳过已有描述的道具——用户手改过的描述
    绝不能被 AI 重跑覆盖掉（`scene_desc` 那边同样的纪律，A6 数据丢失的教训）。

    返回 `{"total","generated","skipped","failed"}`。
    """
    from .config import get_settings
    from .jobs import ensure_prop_asset

    with get_session() as session:
        if not session.get(Project, project_id):
            raise ValueError("project not found")
        shots = (session.query(Shot).filter(Shot.project_id == project_id)
                 .order_by(Shot.order).all())
        # 现有道具资产：名字 → 是否已有描述。⚠️ 读 `desc_of` 而不是 `prompt`：
        # 存量行可能把描述写在了 `prompt` 里（拆列之前），判"已有"时不能漏。
        existing: dict[str, bool] = {}
        for a in session.query(Asset).filter(
                Asset.project_id == project_id, Asset.kind == "prop").all():
            existing[a.name] = existing.get(a.name, False) or bool(desc_of(a))
        # 用户删掉的道具不再跑描述（需求 4）：跑了也没人用，纯粹白花一次 LLM。
        from . import asset_gate
        gone = asset_gate.deleted_names(session, project_id, "prop")

    # 按道具归集镜头片段。与场景不同**不做名称归一**——道具名前后同源，
    # 归一反而会把「玉佩」与「玉佩-断」这类不同道具错误合并。
    by_prop: dict[str, list[str]] = {}
    for sh in shots:
        try:
            items = json.loads(sh.props or "[]")
        except (ValueError, TypeError):
            continue
        if not isinstance(items, list):
            continue
        for x in items:
            n = x.strip() if isinstance(x, str) else ""
            if not n or n in gone:
                continue
            bucket = by_prop.setdefault(n, [])
            if len(bucket) < _MAX_SHOTS_PER_PROP:
                bucket.append((sh.script_ref or "").strip())

    todo = [(n, refs) for n, refs in by_prop.items()
            if overwrite or not existing.get(n, False)]
    total, done = len(todo), 0
    if not todo:
        return {"total": 0, "generated": 0, "skipped": len(by_prop), "failed": 0}

    # 并发用**既有**的 default_concurrency，不新增也不下调任何并发数（并发铁律）
    sem = asyncio.Semaphore(max(1, get_settings().default_concurrency))
    results: dict[str, str] = {}
    failed = 0

    async def _one(name: str, refs: list[str]) -> None:
        nonlocal done, failed
        async with sem:
            desc = await describe_one_prop(name, refs, model_id)
        if desc:
            results[name] = desc
        else:
            failed += 1
        done += 1
        if progress_cb:
            try:
                progress_cb(done, total)
            except Exception:  # noqa: BLE001 进度回调异常不该影响生成
                pass

    await asyncio.gather(*[_one(n, r) for n, r in todo])

    # 落库：没有资产行的道具要补建，否则描述写不进去。
    # ⚠️ 写 `desc_auto` 而不是 `prompt`（见 db.Asset.desc_auto）。
    with get_session() as session:
        for name, desc in results.items():
            ensure_prop_asset(session, project_id, name).desc_auto = desc
        session.commit()

    log.info("[prop_desc] 项目 %s：%d 个道具生成描述，%d 个失败，%d 个已有描述跳过",
             project_id, len(results), failed, len(by_prop) - total)
    return {"total": total, "generated": len(results),
            "skipped": len(by_prop) - total, "failed": failed}


#: 每个项目一把锁：同一项目的多条链路（补资产图 / 拆解末尾 / 预生成提示词）
#: 都会调 `ensure_prop_descriptions`，不加锁会并发跑同一批道具、重复花钱。
_ENSURE_LOCKS: dict[str, asyncio.Lock] = {}


async def ensure_prop_descriptions(project_id: str,
                                   model_id: str | None = None) -> dict:
    """**幂等**地补齐道具描述；失败只记日志，绝不抛异常。

    ## 该在哪调

    与 `scene_desc.ensure_scene_descriptions` 同款：接进**用**描述的地方
    （出图 / 出片 / 提示词预览）就地补齐，而不是指望用户先去点一个不存在的按钮。
    此外拆解末尾会显式跑一次（`jobs.breakdown_by_episode`），因为用户要的是
    「拆解完就能看到完整提示词」，而不是「第一次出图时才补上」。

    幂等来源：`overwrite=False` 跳过已有描述的道具，全都有描述时直接返回、
    一次 LLM 调用都不发。因此可以在每条链路开头无条件 await。
    """
    lock = _ENSURE_LOCKS.setdefault(project_id, asyncio.Lock())
    async with lock:
        try:
            seen = await _describe_from_existing_images(project_id)
        except Exception as e:  # noqa: BLE001
            log.warning("[prop_desc] 项目 %s 视觉反推道具描述失败：%s",
                        project_id, e)
            seen = 0
        try:
            out = await generate_prop_descriptions(project_id, model_id=model_id,
                                                   overwrite=False)
        except Exception as e:  # noqa: BLE001 补描述失败不能挡住出图/出片
            log.warning("[prop_desc] 项目 %s 道具描述补齐失败，按无描述继续: %r",
                        project_id, e)
            return {}
        if out.get("generated"):
            log.info("[prop_desc] 项目 %s 就地补齐 %s 个道具描述", project_id,
                     out.get("generated"))
        if seen:
            out = {**out, "from_image": seen}
        return out


async def _describe_from_existing_images(project_id: str) -> int:
    """**已经有图**却没有描述的道具：改成看图反推，而不是照剧本另写一份。

    理由与 `scene_desc._describe_from_existing_images` 完全一致：描述与参考图
    必须说同一件事。老项目的道具图是在没有描述时出的，此刻若按剧本补一份描述，
    就会造出第二个事实（描述写「黑鞘」而图里是红鞘），反而比没有描述更糟。

    ⚠️ 这是一条**后台批量回填**路径，不在任何交互链路上——反推一张图要 ~8s。

    返回反推成功的道具数。失败只记日志，剩下的交给按剧本生成那一路。
    """
    from .vision_desc import derive

    from . import asset_gate
    with get_session() as session:
        todo = [(a.id, a.name, a.image_url) for a in asset_gate.alive(
            session.query(Asset).filter(
                Asset.project_id == project_id, Asset.kind == "prop",
                Asset.image_url.isnot(None))).all()
            if not desc_of(a)]
    if not todo:
        return 0

    from .config import get_settings
    sem = asyncio.Semaphore(max(1, get_settings().default_concurrency))
    got: dict[str, str] = {}

    async def _one(aid: str, name: str, url: str) -> None:
        async with sem:
            desc = await derive(url, kind="prop")
        if desc:
            got[aid] = desc
        else:
            log.warning("[prop_desc] 道具 %r 已有图但视觉反推失败，"
                        "回退按剧本生成描述", name)

    await asyncio.gather(*[_one(i, n, u) for i, n, u in todo])
    if got:
        with get_session() as session:
            for aid, desc in got.items():
                a = session.get(Asset, aid)
                # 只填空的：手写描述在上面已被 todo 排除，这里再挡一次竞态。
                if a is not None and not desc_of(a):
                    a.desc_auto = desc
            session.commit()
        log.info("[prop_desc] 项目 %s：%d 个已有图的道具按图反推出描述",
                 project_id, len(got))
    return len(got)
