"""站位图：登记、绑定到镜头、解除、删除、列出（2026-11-21）。

站位图是一场戏里各角色站在哪、朝哪的**全景参考图**。它由客户端 Agent 自己生成，什么时候
需要也由 Agent 判断；这里不生成、不判断该不该用，只保证数据不乱。

## 数据在哪

- 图本身：`db.BlockingImage` 一行（名字、图地址、所属场景名、生成说明）。
- 用在哪几镜：**只存在镜头上**。绑定 = 把图地址写进镜头 `profile_override` 的三个键，
  与「用户手动加到镜头上的参考图」完全同路（`routers/shots.py::switch_shot_ref_image`
  的场景 / 道具分支写的是同样三个键）：

      refs        [地址, …]                       出片时接在自动注入的参考图后面
      ref_owners  [{url, kind:"blocking", name, id}]  这张图是谁的
      ref_labels  {地址: "站位图「名字」"}          提示词里 `@名字` 转成 `名字@图片N` 的依据

  所以出片链路（`jobs.run_shot_videos`）不需要认识站位图：它按参考图带上，过同一套张数上限
  与人像入库。

## 为什么适用镜头不另存一份

存两份就要保证两份一致：删镜头、整集重写（`write_episode_shots` 会换掉整集的镜头行）、
拆镜、网页上手动去掉参考图，每一处都得记得回来改。只存在镜头上，这些操作之后
「适用镜头」自然是对的，不会留下指向不存在镜头的记录。

## 本集镜号

`no` = 这一集里**没停用**的镜头按全剧镜号排的第几个，与 `read_shots` 的顺序一致
（客户端按它给镜头编号）。停用的镜头没有本集镜号，仍绑着的会列在 `shots` 里、`no` 为空，
不进 `ranges` 与 `scope`。
"""
from __future__ import annotations

import json
import uuid

from .db import Asset, BlockingImage, Shot, iso_now

KIND = "blocking"

#: 一次绑定 / 解除最多多少镜。
MAX_SHOTS = 300

#: 名字长度上限。提示词里要整段写出 `@名字`，太长的名字本身就容易写错。
MAX_NAME = 60

#: 镜流里的图片地址前缀（与 `asset_image_write.set_images` 同一口径）。
_MEDIA_PREFIXES = ("/fw/media/", "/fwp/media/", "/media/")

#: 名字里不能出现的字符：`@` 是引用符，`「」` 是标签里包名字用的括号。
_BAD_NAME_CHARS = "@「」"


class BlockingError(ValueError):
    """参数或状态不对，整次调用不执行。`str(e)` 是给调用方看的那句话。"""


def label_of(name: str) -> str:
    """出片时这张图在参考图对照表里的标签；`at_refs` 取「」里的名字做 `@名字` 的匹配。"""
    return f"站位图「{name}」"


# ---------------------------------------------------------------------------
# 镜头上的三个键
# ---------------------------------------------------------------------------

def _override(shot: Shot) -> dict:
    try:
        ov = json.loads(shot.profile_override) if shot.profile_override else {}
    except (ValueError, TypeError):
        return {}
    return ov if isinstance(ov, dict) else {}


def _refs(ov: dict) -> list[str]:
    return [u for u in (ov.get("refs") or []) if isinstance(u, str) and u.strip()]


def _owners(ov: dict) -> list[dict]:
    return [o for o in (ov.get("ref_owners") or []) if isinstance(o, dict) and o.get("url")]


def _labels(ov: dict) -> dict:
    labels = ov.get("ref_labels")
    return dict(labels) if isinstance(labels, dict) else {}


def _write(shot: Shot, ov: dict, refs: list[str], owners: list[dict], labels: dict) -> None:
    for key, value in (("refs", refs), ("ref_owners", owners), ("ref_labels", labels)):
        if value:
            ov[key] = value
        else:
            ov.pop(key, None)
    shot.profile_override = json.dumps(ov, ensure_ascii=False) if ov else None
    if shot.video_url:
        # 已经出过片：参考图集合变了，这一版与当前设置不再一致。
        shot.refs_stale = 1


def _attach(shot: Shot, row: BlockingImage) -> bool:
    """把站位图挂到这一镜上。已经挂好且标签一致时什么都不改，返回 False。"""
    ov = _override(shot)
    refs, owners, labels = _refs(ov), _owners(ov), _labels(ov)
    url = row.image_url
    owner = {"url": url, "kind": KIND, "name": row.name, "id": row.id}
    if url in refs and owner in owners and labels.get(url) == label_of(row.name):
        return False
    if url not in refs:
        refs.append(url)
    owners = [o for o in owners if o.get("url") != url] + [owner]
    labels[url] = label_of(row.name)
    _write(shot, ov, refs, owners, labels)
    return True


def _detach(shot: Shot, url: str) -> bool:
    """把这张图从这一镜上拿掉。本来就没挂时返回 False。"""
    ov = _override(shot)
    refs, owners, labels = _refs(ov), _owners(ov), _labels(ov)
    if url not in refs and url not in labels and not any(o.get("url") == url for o in owners):
        return False
    labels.pop(url, None)
    _write(shot, ov, [u for u in refs if u != url],
           [o for o in owners if o.get("url") != url], labels)
    return True


def _reattach(shot: Shot, old_url: str, row: BlockingImage) -> None:
    """站位图换了图或改了名：在这一镜上原位换掉，不挪它在参考图里的位置。

    位置不能动：参考图的顺序就是提示词里「图片N」的编号来源，挪到末尾会让排在它后面的
    手动参考图全部错一位。
    """
    ov = _override(shot)
    refs, owners, labels = _refs(ov), _owners(ov), _labels(ov)
    url = row.image_url
    refs = [url if u == old_url else u for u in refs]
    refs = [u for i, u in enumerate(refs) if u not in refs[:i]]
    if url not in refs:
        refs.append(url)
    owners = ([o for o in owners if o.get("url") not in (old_url, url)]
              + [{"url": url, "kind": KIND, "name": row.name, "id": row.id}])
    labels.pop(old_url, None)
    labels[url] = label_of(row.name)
    _write(shot, ov, refs, owners, labels)


def _bound(session, project_id: str) -> dict[str, list[Shot]]:
    """本项目里每个参考图地址绑在哪些镜头上（只看带 `refs` 的镜头）。"""
    out: dict[str, list[Shot]] = {}
    shots = (session.query(Shot)
             .filter(Shot.project_id == project_id,
                     Shot.profile_override.contains('"refs"'))
             .order_by(Shot.order).all())
    for shot in shots:
        for url in _refs(_override(shot)):
            out.setdefault(url, []).append(shot)
    return out


# ---------------------------------------------------------------------------
# 本集镜号与范围文字
# ---------------------------------------------------------------------------

def numbering(session, project_id: str) -> dict[str, dict]:
    """`{shot_id: {id, episode, order, no}}`，`no` 见模块头的「本集镜号」。"""
    rows = (session.query(Shot.id, Shot.episode, Shot.order, Shot.disabled)
            .filter(Shot.project_id == project_id).order_by(Shot.order).all())
    out: dict[str, dict] = {}
    counter: dict[int, int] = {}
    for shot_id, episode, order, disabled in rows:
        ep = int(episode or 1)
        no = None
        if not disabled:
            counter[ep] = counter.get(ep, 0) + 1
            no = counter[ep]
        out[shot_id] = {"id": shot_id, "episode": ep, "order": order, "no": no}
    return out


def _ranges(shots: list[dict]) -> list[dict]:
    """把镜头合成 `[{episode, from, to}]`：同一集里本集镜号连续的并成一段。"""
    numbered = sorted((s["episode"], s["no"]) for s in shots if s["no"] is not None)
    out: list[dict] = []
    for episode, no in numbered:
        last = out[-1] if out else None
        if last and last["episode"] == episode and no <= last["to"] + 1:
            last["to"] = max(last["to"], no)
        else:
            out.append({"episode": episode, "from": no, "to": no})
    return out


def scope_text(location: str | None, ranges: list[dict]) -> str:
    """给人看的适用范围，例如 `渡口清晨 · 第 6 集 2–4 镜`。"""
    by_episode: dict[int, list[str]] = {}
    for r in ranges:
        span = str(r["from"]) if r["from"] == r["to"] else f"{r['from']}–{r['to']}"
        by_episode.setdefault(r["episode"], []).append(span)
    where = "，".join(f"第 {ep} 集 {'、'.join(spans)} 镜" for ep, spans in by_episode.items())
    parts = [p for p in ((location or "").strip(), where or "未绑定镜头") if p]
    return " · ".join(parts)


def _location_id(session, project_id: str, location: str | None) -> str | None:
    """所属场景当前在用的资产 id；场景资产不存在或已删除时为空（名字照旧保留）。"""
    from .scenes import location_asset
    asset = location_asset(session, project_id, location)
    return asset.id if asset is not None and not asset.deleted_at else None


def describe(session, row: BlockingImage, *, numbers: dict[str, dict] | None = None,
             bound: dict[str, list[Shot]] | None = None) -> dict:
    """一张站位图对外的样子（`list_assets` / `list_blocking_images` / 各写工具的返回共用）。"""
    numbers = numbers if numbers is not None else numbering(session, row.project_id)
    bound = bound if bound is not None else _bound(session, row.project_id)
    shots = [numbers[s.id] for s in bound.get(row.image_url, []) if s.id in numbers]
    ranges = _ranges(shots)
    return {
        "id": row.id, "kind": KIND, "name": row.name,
        "has_image": True, "image_url": row.image_url,
        "prompt": row.prompt or None,
        "location": row.location or None,
        "location_id": _location_id(session, row.project_id, row.location),
        "shots": shots, "shot_ids": [s["id"] for s in shots],
        "ranges": ranges, "scope": scope_text(row.location, ranges),
        # 提示词里引用它的写法；出片时转成 `名字@图片N`
        "ref": f"@{row.name}",
    }


def list_rows(session, project_id: str) -> list[dict]:
    """本项目全部站位图，先登记的在前。"""
    rows = (session.query(BlockingImage)
            .filter(BlockingImage.project_id == project_id).all())
    if not rows:
        return []
    numbers, bound = numbering(session, project_id), _bound(session, project_id)
    rows.sort(key=lambda r: (r.created_at or "", r.name or "", r.id))
    return [describe(session, r, numbers=numbers, bound=bound) for r in rows]


# ---------------------------------------------------------------------------
# 找到一张站位图 / 一批镜头
# ---------------------------------------------------------------------------

def find(session, project_id: str, *, blocking_id: str = "", name: str = "") -> BlockingImage:
    """按 id 或名字取一张；取不到抛 `BlockingError`。"""
    blocking_id, name = (blocking_id or "").strip(), (name or "").strip()
    if blocking_id:
        row = session.get(BlockingImage, blocking_id)
        if row is None or row.project_id != project_id:
            raise BlockingError("站位图不存在或不属于本项目（用 list_blocking_images 查 id）")
        return row
    if not name:
        raise BlockingError("要给 blocking_id 或 name，指明是哪一张站位图")
    row = (session.query(BlockingImage)
           .filter(BlockingImage.project_id == project_id, BlockingImage.name == name).first())
    if row is None:
        raise BlockingError(f"本项目没有叫「{name}」的站位图（用 list_blocking_images 查）")
    return row


def has_selector(shot_ids: list[str] | None, episode: int | None,
                 shot_from: int | None, shot_to: int | None) -> bool:
    return bool(shot_ids) or episode is not None or shot_from is not None or shot_to is not None


def select_shots(session, project_id: str, *, shot_ids: list[str] | None = None,
                 episode: int | None = None, shot_from: int | None = None,
                 shot_to: int | None = None) -> list[Shot]:
    """把「镜头 id 列表」和「第几集第几到第几镜（本集镜号）」解析成镜头行，按全剧镜号排。

    两种写法可以同时给，取并集。任何一个 id 不在本项目、或镜号区间里没有镜头，整次不执行：
    绑错镜头不会报错、只会让那一镜多带一张图，所以宁可不做。
    """
    wanted: dict[str, None] = {}
    ids = [str(i).strip() for i in (shot_ids or []) if str(i).strip()]
    if ids:
        found = {sid for (sid,) in (session.query(Shot.id)
                                    .filter(Shot.project_id == project_id, Shot.id.in_(ids)).all())}
        missing = [i for i in ids if i not in found]
        if missing:
            raise BlockingError(f"这些镜头不存在或不属于本项目：{missing[:10]}")
        wanted.update(dict.fromkeys(ids))
    if episode is not None or shot_from is not None or shot_to is not None:
        if episode is None or shot_from is None:
            raise BlockingError("按镜号指定要同时给 episode 和 shot_from（shot_to 不填 = 只这一镜）")
        first, last = int(shot_from), int(shot_to if shot_to is not None else shot_from)
        if first < 1 or last < first:
            raise BlockingError("镜号区间不对：shot_from 从 1 起，shot_to 不小于 shot_from")
        hit = [n["id"] for n in numbering(session, project_id).values()
               if n["episode"] == int(episode) and n["no"] is not None and first <= n["no"] <= last]
        if not hit:
            raise BlockingError(f"第 {episode} 集没有本集镜号 {first}–{last} 的镜头"
                                "（本集镜号按没停用的镜头从 1 数，用 read_shots 核对）")
        wanted.update(dict.fromkeys(hit))
    if len(wanted) > MAX_SHOTS:
        raise BlockingError(f"一次最多 {MAX_SHOTS} 镜，请分批")
    if not wanted:
        return []
    return (session.query(Shot)
            .filter(Shot.project_id == project_id, Shot.id.in_(list(wanted)))
            .order_by(Shot.order).all())


# ---------------------------------------------------------------------------
# 写
# ---------------------------------------------------------------------------

def _check_url(url: str) -> None:
    if not url.startswith(_MEDIA_PREFIXES):
        raise BlockingError("image_url 要是镜流里的图片地址（/fw/media/… 开头）：先把图传到镜流再登记")


def _check_name(session, project_id: str, name: str, *, self_id: str | None) -> None:
    if len(name) > MAX_NAME:
        raise BlockingError(f"名字最长 {MAX_NAME} 个字")
    if any(ch in name for ch in _BAD_NAME_CHARS):
        raise BlockingError("名字里不能有 @ 或「」")
    clash = (session.query(BlockingImage)
             .filter(BlockingImage.project_id == project_id, BlockingImage.name == name).first())
    if clash is not None and clash.id != self_id:
        raise BlockingError(f"已经有一张站位图叫「{name}」（id {clash.id}）：要改它就带上 blocking_id")
    asset = (session.query(Asset)
             .filter(Asset.project_id == project_id, Asset.name == name,
                     Asset.deleted_at.is_(None)).first())
    if asset is not None:
        # 提示词里按名字引用参考图：同名时 `@名字` 会落到先带上的那张（角色 / 场景图）上。
        kind_cn = {"character": "角色", "location": "场景", "prop": "道具"}.get(asset.kind, "资产")
        raise BlockingError(f"「{name}」已经是本项目的{kind_cn}名，"
                            f"站位图换个名字（例如「{name}站位图」）")


def _auto_name(session, project_id: str, location: str) -> str:
    base = f"{location or '未指定场景'}站位图"[:MAX_NAME - 4]
    taken = {n for (n,) in (session.query(BlockingImage.name)
                            .filter(BlockingImage.project_id == project_id).all())}
    taken |= {n for (n,) in (session.query(Asset.name)
                             .filter(Asset.project_id == project_id,
                                     Asset.deleted_at.is_(None)).all())}
    name, i = base, 1
    while name in taken:
        i += 1
        name = f"{base}{i}"
    return name


def save(session, project_id: str, *, blocking_id: str = "", name: str = "",
         image_url: str = "", location: str | None = None,
         prompt: str | None = None) -> tuple[BlockingImage, dict]:
    """登记一张新的，或更新已有的一张。返回 `(行, 这次改了什么)`。调用方负责 commit。

    - 给了 `blocking_id`：更新那一张，只改传进来的项（`name` / `image_url` 非空才改，
      `location` / `prompt` 传 None = 不动，传空串 = 清空）。
    - 没给 id、名字与已有站位图相同：更新同名的那一张。
    - 否则新登记：必须有 `image_url`；名字不填按场景自动起。

    换图、改名会同步到已经绑定的镜头上（地址、归属名、标签一起改），所以绑定不会因为
    更新而失效。提示词里手写的 `@旧名字` 不改：那是锁定的镜头脚本，由调用方自己换。
    """
    blocking_id, name, image_url = ((blocking_id or "").strip(), (name or "").strip(),
                                    (image_url or "").strip())
    row: BlockingImage | None = None
    if blocking_id:
        row = find(session, project_id, blocking_id=blocking_id)
    elif name:
        row = (session.query(BlockingImage)
               .filter(BlockingImage.project_id == project_id, BlockingImage.name == name).first())

    if image_url:
        _check_url(image_url)
        other = (session.query(BlockingImage)
                 .filter(BlockingImage.project_id == project_id,
                         BlockingImage.image_url == image_url).first())
        if other is not None and (row is None or other.id != row.id):
            raise BlockingError(f"这张图已经登记为站位图「{other.name}」（id {other.id}）")

    if row is None:
        if not image_url:
            raise BlockingError("新登记站位图要给 image_url")
        loc = (location or "").strip()
        final_name = name or _auto_name(session, project_id, loc)
        _check_name(session, project_id, final_name, self_id=None)
        row = BlockingImage(id=uuid.uuid4().hex[:12], project_id=project_id, name=final_name,
                            image_url=image_url, prompt=(prompt or "").strip() or None,
                            location=loc or None, created_at=iso_now(), updated_at=iso_now())
        session.add(row)
        return row, {"created": True}

    info: dict = {"created": False}
    old_url, old_name = row.image_url, row.name
    if name and name != old_name:
        _check_name(session, project_id, name, self_id=row.id)
        row.name = name
        info["renamed_from"] = old_name
    if image_url and image_url != old_url:
        row.image_url = image_url
        info["image_replaced"] = True
    if location is not None:
        row.location = location.strip() or None
    if prompt is not None:
        row.prompt = prompt.strip() or None
    row.updated_at = iso_now()

    if row.image_url != old_url or row.name != old_name:
        moved = 0
        for shot in _bound(session, project_id).get(old_url, []):
            _reattach(shot, old_url, row)
            moved += 1
        info["shots_updated"] = moved
    return row, info


def bind(session, row: BlockingImage, shots: list[Shot]) -> dict:
    """把站位图挂到这些镜头上，作为出片时的参考图。调用方负责 commit。"""
    added = sum(1 for shot in shots if _attach(shot, row))
    out: dict = {"bound": added, "already_bound": len(shots) - added}
    fixed = [shot.id for shot in shots if _override(shot).get("ref_urls")]
    if fixed:
        # 这些镜头写死了整份参考图清单（`ref_urls`）：出片只带清单里的图，自动注入的与
        # 手动加的参考图（站位图在内）都不带。绑定照做，但要让调用方知道它不会生效。
        out["fixed_ref_list_shots"] = fixed
        out["warning"] = (f"{len(fixed)} 个镜头指定了整份参考图清单（ref_urls），出片时只带那份清单，"
                          "站位图不会被带上；要用站位图，先清掉这些镜头的 ref_urls"
                          "（set_shot_override 的 clear）")
    return out


def unbind(session, row: BlockingImage, shots: list[Shot] | None = None) -> dict:
    """从这些镜头上拿掉；`shots` 为 None = 从所有绑着它的镜头上拿掉。调用方负责 commit。"""
    targets = shots if shots is not None else _bound(session, row.project_id).get(row.image_url, [])
    removed = sum(1 for shot in targets if _detach(shot, row.image_url))
    return {"unbound": removed, "not_bound": len(targets) - removed}


def remove(session, row: BlockingImage) -> dict:
    """删掉这张站位图，并从所有镜头上拿掉。调用方负责 commit。

    图片文件不在这里删：行没了之后它不再出现在 `media_refs.URL_COLUMNS` 的引用集里，
    没有别处在用的话，由清理缓存按孤儿文件回收。
    """
    out = unbind(session, row)
    session.delete(row)
    return {"deleted": True, "unbound": out["unbound"]}


def rename_location(session, project_id: str, old: str, new: str) -> int:
    """场景改名时把站位图的所属场景名一起改（`asset_rename` 的场景分支调用）。"""
    return (session.query(BlockingImage)
            .filter(BlockingImage.project_id == project_id, BlockingImage.location == old)
            .update({BlockingImage.location: new, BlockingImage.updated_at: iso_now()},
                    synchronize_session=False))


def label_for_url(session, project_id: str, url: str) -> str | None:
    """这个地址是不是本项目的一张站位图；是就返回它的参考图标签。

    镜头上的 `ref_labels` 被别的写入路径丢掉时，`jobs._ref_label_for` 靠它把名字补回来，
    否则提示词里的 `@名字` 转不成编号。
    """
    row = (session.query(BlockingImage)
           .filter(BlockingImage.project_id == project_id,
                   BlockingImage.image_url == url).first())
    return label_of(row.name) if row is not None else None
