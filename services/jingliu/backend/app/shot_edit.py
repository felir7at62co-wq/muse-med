"""镜头拆解的**手工编辑**原语：整集写入 / 删除 / 按剧本拆分 / 合并。全部不调模型。

## 为什么要有这个模块（2026-11-19 用户裁定）

镜流的拆解（`routers/shots.do_breakdown`）是一次文本模型调用，保留为**可选的机器
初稿**；但「机器是死的」——特殊情况必须能人工改。此前能改的只有单镜字段
（`patch_shot`）和时间轴上的切/合（切的是**已出片的视频**，不是剧本），
「这一集我自己拆好了，按我的来」「这两镜并成一镜」「这一镜删掉」都做不到，
只能重跑整集拆解。

这里补齐的是**剧本层面**的结构编辑，供桌面端 Agent（Muse）的工具调用
（`agent/tools_write.py` 里的 `write_episode_shots` / `delete_shots` /
`split_shot(parts=…)` / `merge_shots`）。

## 三条不变式

1. **不写任何镜头脚本**。镜头脚本（视频提示词）由 Muse 在场景资产出图之后撰写
   并锁定（`set_shot_prompt(s)`，lock=true）；这里只动拆解字段。
2. **新建的行不过期，被改的行标过期**。新行没有任何下游产物可言（`stale=0`）；
   已有行的剧本一变，它身上的镜头脚本/成片就基于旧拆解了 → `stale=reprompt`，
   调用方据此知道那一稿要重写（写入并锁定新稿时清掉，见 `_write_prompt`）。
3. **`Shot.order` 永远是 1..N 连续整数**，且音频/字幕锚点、造型镜号区间跟着
   **镜头身份**走（`shot_timing.snapshot_* / remap_*_by_identity`）——理由见那几个
   函数的长注释：这些锚点存的是普通整数，重排时不搬就整体错位，且不报错。

## 事务

每个函数只收 `session`，**调用方负责 commit**；中途抛 `EditError` 时调用方
rollback（什么都没写进去）。`EditError.extra` 是给调用方（模型）看的结构化细节。
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from . import stale as stale_mod
from .db import AudioClip, Shot, SubtitleClip
from .shot_timing import (remap_anchors_by_identity, remap_stage_ranges_by_identity,
                          snapshot_anchors, snapshot_stage_ranges)

logger = logging.getLogger("fw.shot_edit")

#: 一次批量写入/删除最多多少镜。一集短剧常见 20~80 镜，300 已是很宽的上限；
#: 再多基本是把几集并成了一集，或模型在循环里出了错——让它分批并自查。
MAX_BATCH = 300
#: 一镜一次最多拆成几段。
MAX_SPLIT_PARTS = 20
#: 没给时长、也估不出来时的兜底（与 `insert_shot` 的历史默认一致）。
_FALLBACK_SEC = 5.0

#: 拆分出的新镜从原镜继承的 `profile_override` 键：只有**生成参数**。
#: 镜头脚本（prompt）、首尾帧、手动参考图这些都是"针对原来那一整段"的，不能照搬。
_INHERIT_OVERRIDE_KEYS = ("model_id", "generation_mode", "resolution", "megapixels",
                          "aspect_ratio", "image_model")

CONTINUOUS = "continuous"
TRANSITION = "transition"


class EditError(Exception):
    """可以原样给调用方看的拒绝原因；`extra` 并进工具返回值。"""

    def __init__(self, message: str, **extra: Any):
        super().__init__(message)
        self.message = message
        self.extra = extra

    def as_result(self) -> dict:
        return {"ok": False, "error": self.message, **self.extra}


# ---------------------------------------------------------------- 小工具

def flag(value) -> bool:
    """「危险开关」类布尔参数（force / allow_…）的严格解读。

    桌面端网关不做 schema 校验，模型给的原始 JSON 直接进工具。`bool("false")`
    是 True —— 用它解读 `force` 的话，一个写成字符串的 "false" 就会把已出的片删掉。
    所以只认明确的真值，其余一律当 False。
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value == 1
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return False


def clean_names(values) -> list[str]:
    """名字列表：去空白、去重、保序（顺序决定参考图注入的优先级）。"""
    out: list[str] = []
    if isinstance(values, str):
        values = [values]
    for v in values or []:
        n = v.strip() if isinstance(v, str) else ""
        if n and n not in out:
            out.append(n)
    return out


def clean_location(value) -> str | None:
    """场景名：去空白，并剥掉混进来的镜号前缀（与 `PATCH /shots/{id}/breakdown` 同口径）。"""
    loc = value.strip() if isinstance(value, str) else ""
    if not loc:
        return None
    from .scene_desc import strip_shot_prefix
    return strip_shot_prefix(loc) or loc


def link_of(value) -> str | None:
    """`link_to_prev` 的入参 → 库里的取值。

    工具侧是布尔：true = 与上一镜连续（同一场戏接着演），false = 与上一镜之间换场/转场。
    网页侧的两个字符串取值也认，免得调用方照着 `get_shot` 的返回值原样传回来时被拒。
    None = 没给。认不出的值抛 `EditError`。
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return CONTINUOUS if value else TRANSITION
    if isinstance(value, (int, float)) and value in (0, 1):
        return CONTINUOUS if value else TRANSITION
    if isinstance(value, str):
        v = value.strip().lower()
        if v in (CONTINUOUS, "true", "1", "yes"):
            return CONTINUOUS
        if v in (TRANSITION, "false", "0", "no"):
            return TRANSITION
    raise EditError("link_to_prev 只能是 true（与上一镜连续）或 false（换场/转场）")


def override_of(shot) -> dict:
    try:
        ov = json.loads(shot.profile_override) if shot.profile_override else {}
    except (ValueError, TypeError):
        ov = {}
    return ov if isinstance(ov, dict) else {}


def has_media(shot) -> bool:
    """这一镜有没有**已生成的画面**（首帧图或视频）。整集替换/删除/合并的保护判据。"""
    return bool((shot.video_url or "").strip() or (shot.first_frame_url or "").strip())


def media_row(shot) -> dict:
    return {"shot_id": shot.id, "order": shot.order,
            "has_video": bool((shot.video_url or "").strip()),
            "has_first_frame": bool((shot.first_frame_url or "").strip())}


def mark_edited(shot) -> None:
    """已有镜头的拆解字段被改 → 标 `stale=reprompt`（不变式 2）。"""
    stale_mod.mark_stale(shot, stale_mod.REPROMPT)


def model_cap(session, project_id: str) -> float | None:
    """当前项目视频模型的单镜时长上限（秒）；拿不到返回 None（不钳）。"""
    from .db import Project, profile_of
    from .shot_timing import shot_seconds_cap
    p = session.get(Project, project_id)
    if p is None:
        return None
    try:
        return round(float(shot_seconds_cap(profile_of(p))[0]), 1)
    except Exception:  # noqa: BLE001
        return None


def estimate_duration(session, project_id: str, script_ref: str,
                      characters: list[str] | None = None) -> float:
    """没给时长时按剧本文字估一个：与机器拆解落库**同一把尺子**（确定性，不调模型）。

    真人剧走 `routers.shots._clamp_duration`（台词按语速、动作按节拍），
    解说剧走 `_narration_duration`（按旁白朗读时长）。估不出来退 5 秒。
    """
    try:
        from .db import Project
        from .shot_timing import _narration_duration, narration_max_chars
        cap = model_cap(session, project_id)
        proj = session.get(Project, project_id)
        max_chars = narration_max_chars(proj) if proj is not None else None
        if max_chars:
            from .script_import import _CHARS_PER_SEC_SLOW
            return float(_narration_duration(script_ref, max_chars / _CHARS_PER_SEC_SLOW))
        from .routers.shots import _clamp_duration, _dur_window
        return float(_clamp_duration(script_ref, None, _dur_window(cap),
                                     list(characters or [])))
    except Exception:  # noqa: BLE001 估时长失败不该让写入失败
        logger.warning("[shot_edit] 时长估算失败，按 %.1fs 兜底", _FALLBACK_SEC, exc_info=True)
        return _FALLBACK_SEC


def settle_duration(session, project_id: str, want, script_ref: str,
                    characters: list[str] | None, cap: float | None,
                    label: str, warnings: list[str]) -> float:
    """定稿一镜的目标时长：给了就用（钳到 [1, 模型上限]），没给就估。"""
    if want is None or want == "":
        val = estimate_duration(session, project_id, script_ref, characters)
    else:
        try:
            val = float(want)
        except (TypeError, ValueError):
            raise EditError(f"{label} 的 duration_sec 不是数字：{want!r}") from None
    val = max(1.0, val)
    if cap and val > cap:
        if want is not None and want != "":
            warnings.append(f"{label} 的时长 {val:.1f}s 超过当前视频模型单镜上限 "
                            f"{cap:.1f}s，已按 {cap:.1f}s 写入；内容装不下就再拆一镜")
        val = cap
    return round(val, 1)


def _ordered(session, project_id: str) -> list:
    return (session.query(Shot).filter(Shot.project_id == project_id)
            .order_by(Shot.order, Shot.id).all())


def _apply_order(session, project_id: str, final: list, snap, snap_st) -> None:
    """把 `final` 的顺序写成 1..N，并按身份搬回锚点与造型区间（不变式 3）。"""
    for i, sh in enumerate(final, start=1):
        if sh.order != i:
            sh.order = i
    session.flush()
    remap_anchors_by_identity(session, project_id, snap)
    remap_stage_ranges_by_identity(session, project_id, snap_st)


def _ep(shot) -> int:
    return int(shot.episode or 1)


def _require_ids(shot_ids, what: str) -> list[str]:
    if not isinstance(shot_ids, (list, tuple)) or not shot_ids:
        raise EditError(f"{what}：shot_ids 为空")
    ids: list[str] = []
    for x in shot_ids:
        sid = str(x or "").strip()
        if sid and sid not in ids:
            ids.append(sid)
    if not ids:
        raise EditError(f"{what}：shot_ids 为空")
    if len(ids) > MAX_BATCH:
        raise EditError(f"一次最多 {MAX_BATCH} 镜，这次 {len(ids)} 镜，请分批")
    return ids


def _load(session, project_id: str, ids: list[str]) -> list:
    rows = {s.id: s for s in session.query(Shot)
            .filter(Shot.project_id == project_id, Shot.id.in_(ids)).all()}
    missing = [i for i in ids if i not in rows]
    if missing:
        raise EditError("有镜头不存在或不属于本项目，什么都没有改",
                        missing_shot_ids=missing)
    return [rows[i] for i in ids]


# ---------------------------------------------------------------- 整集写入

def _parse_items(items) -> list[dict]:
    """校验并规整 `write_episode_shots` 的条目。任何一条不合法就整批拒绝（不写半集）。"""
    if not isinstance(items, (list, tuple)) or not items:
        raise EditError("shots 为空：至少要有一镜")
    if len(items) > MAX_BATCH:
        raise EditError(f"一次最多写 {MAX_BATCH} 镜，这次 {len(items)} 镜。"
                        "一集通常远少于这个数：请确认没有把几集并在一起，或分批用 mode=append 追加")
    out: list[dict] = []
    bad: list[dict] = []
    for i, it in enumerate(items, start=1):
        if not isinstance(it, dict):
            bad.append({"index": i, "error": "不是对象"})
            continue
        ref = it.get("script_ref")
        ref = ref.strip() if isinstance(ref, str) else ""
        if not ref:
            bad.append({"index": i, "error": "缺 script_ref（这一镜对应的剧本原文）"})
            continue
        try:
            link = link_of(it.get("link_to_prev"))
        except EditError as e:
            bad.append({"index": i, "error": e.message})
            continue
        label = it.get("label")
        out.append({
            "script_ref": ref,
            "duration_sec": it.get("duration_sec"),
            "characters": clean_names(it.get("characters")),
            "location": clean_location(it.get("location")),
            "props": clean_names(it.get("props")),
            "link": link,
            "label": (label.strip()[:255] or None) if isinstance(label, str) else None,
        })
    if bad:
        raise EditError(f"shots 里有 {len(bad)} 条不合法，整批没有写入（index 从 1 起）",
                        invalid_items=bad[:50])
    return out


def write_episode_shots(session, project_id: str, episode, items, *,
                        mode: str = "replace", force: bool = False) -> dict:
    """按调用方给的拆解，批量写入**一集**的镜头行。顺序 = 数组顺序。

    `mode="replace"`：替换这一集现有的全部镜头（含外部素材镜头）。现有镜头里只要有
    一镜已经出过首帧或视频，就拒绝（`EditError`，`shots_with_media` 列出是哪几镜），
    除非 `force=True`——那些画面随镜头行一起丢，找不回来。
    `mode="append"`：接在这一集最后一镜之后。

    这一集还没有镜头时，新镜头插在集号更小的那些镜头之后（保持全剧按集排）。
    资产行与 `patch_shot` 同一份规则（`asset_seed.ensure_assets`）。
    """
    try:
        ep = int(episode)
    except (TypeError, ValueError):
        raise EditError(f"episode 不是整数：{episode!r}") from None
    if ep < 1:
        raise EditError("episode 从 1 起（0 是前言，不拆镜头）")
    if mode not in ("replace", "append"):
        raise EditError('mode 只能是 "replace"（替换这一集现有镜头）或 "append"（接在这一集末尾）')
    rows = _parse_items(items)

    shots = _ordered(session, project_id)
    existing = [s for s in shots if _ep(s) == ep]
    gone: list = []
    if mode == "replace" and existing:
        blocked = [s for s in existing if has_media(s)]
        if blocked and not force:
            raise EditError(
                f"第 {ep} 集现有 {len(existing)} 镜里有 {len(blocked)} 镜已经出过首帧或视频，"
                "整集替换会把它们连同画面一起删掉，所以没有执行。"
                "只想加镜头用 mode=append；只改个别镜头用 patch_shot / split_shot / merge_shots / "
                "delete_shots；确实要整集推倒重来再传 force=true（需要用户确认）",
                code="episode_has_media",
                shots_with_media=[media_row(s) for s in blocked[:50]],
                media_count=len(blocked))
        gone = existing
    gone_ids = {s.id for s in gone}
    keep = [s for s in shots if s.id not in gone_ids]

    # ---- 插入位置（在 keep 里的下标）----
    if mode == "replace" and existing:
        first = existing[0].order
        pos = sum(1 for s in keep if s.order < first)
    elif mode == "append" and existing:
        pos = keep.index(existing[-1]) + 1
    else:
        # 这一集还没有镜头：接在最后一个集号更小的镜头之后
        pos = max((i + 1 for i, s in enumerate(keep) if _ep(s) < ep), default=0)

    # ⚠️ 快照必须在改任何 order / 删任何行之前取（见 shot_timing.snapshot_anchors）
    snap = snapshot_anchors(session, project_id)
    snap_st = snapshot_stage_ranges(session, project_id)

    cap = model_cap(session, project_id)
    warnings: list[str] = []
    prev_loc = None
    if mode == "append" and existing:
        prev_loc = existing[-1].location
    new_rows: list = []
    for i, r in enumerate(rows, start=1):
        link = r["link"]
        if link is None:
            # 没给：与上一镜场景名相同算连续，其余（含整集替换时的第一镜）算换场
            link = (CONTINUOUS if (r["location"] and prev_loc
                                   and r["location"] == prev_loc) else TRANSITION)
        dur = settle_duration(session, project_id, r["duration_sec"], r["script_ref"],
                              r["characters"], cap, f"第 {i} 条", warnings)
        new_rows.append(Shot(
            id=uuid.uuid4().hex[:12], project_id=project_id, order=0,
            script_ref=r["script_ref"], link_to_prev=link,
            characters=json.dumps(r["characters"], ensure_ascii=False),
            props=json.dumps(r["props"], ensure_ascii=False),
            location=r["location"], episode=ep, status="pending",
            duration_sec=dur, is_special=0, special_name=r["label"],
            stale=0, stale_reason=None))
        prev_loc = r["location"]

    media_discarded = sum(1 for s in gone if has_media(s))
    scripts_discarded = sum(1 for s in gone
                            if str(override_of(s).get("prompt") or "").strip())
    for s in gone:
        session.delete(s)
    for s in new_rows:
        session.add(s)
    session.flush()
    _apply_order(session, project_id, keep[:pos] + new_rows + keep[pos:], snap, snap_st)

    from .asset_seed import ensure_assets
    chars: list[str] = []
    locs: list[str] = []
    props: list[str] = []
    for r in rows:
        chars += [c for c in r["characters"] if c not in chars]
        if r["location"] and r["location"] not in locs:
            locs.append(r["location"])
        props += [p for p in r["props"] if p not in props]
    created = ensure_assets(session, project_id, characters=chars,
                            locations=locs, props=props)
    session.flush()

    out = {
        "ok": True, "episode": ep, "mode": mode,
        "written": len(new_rows), "replaced": len(gone),
        "shots": [{"shot_id": s.id, "order": s.order, "duration_sec": s.duration_sec,
                   "link_to_prev": s.link_to_prev == CONTINUOUS} for s in new_rows],
        "assets_created": created,
        "note": ("镜头行已写入，**没有写任何镜头脚本**：先把场景/角色资产的图补齐"
                 "（get_episode_readiness 看还缺哪些），再用 set_shot_prompts(lock=true) 逐镜写入并锁定"),
    }
    if scripts_discarded:
        # 被替换掉的镜头里有已锁定的镜头脚本：随镜头行一起没了，要让调用方知道
        out["scripts_discarded"] = scripts_discarded
    if media_discarded:
        out["media_discarded"] = media_discarded
        out["note"] += "；锚在被替换镜头上的字幕/音频不会自动删除，用 list_subtitle_clips / list_audio_clips 核对"
    if warnings:
        out["warnings"] = warnings
    return out


# ---------------------------------------------------------------- 删除

def delete_shots(session, project_id: str, shot_ids, *, force: bool = False) -> dict:
    """删掉一批镜头行（硬删），其余镜头的镜号收拢为连续。

    已经出过首帧或视频的镜头默认不删（`EditError` 列出是哪几镜）：只是暂时不用，
    该用停用（`patch_shot_timeline(disabled=true)`，随时能恢复）；确实要删传 `force=True`。
    """
    ids = _require_ids(shot_ids, "delete_shots")
    rows = _load(session, project_id, ids)
    blocked = [s for s in rows if has_media(s)]
    if blocked and not force:
        raise EditError(
            f"要删的 {len(rows)} 镜里有 {len(blocked)} 镜已经出过首帧或视频，删掉就找不回来，所以没有执行。"
            "只是这一版不要它，用 patch_shot_timeline(disabled=true) 停用；确实要删再传 force=true（需要用户确认）",
            code="shots_have_media",
            shots_with_media=[media_row(s) for s in blocked[:50]],
            media_count=len(blocked))
    deleted = [{"shot_id": s.id, "order": s.order, "episode": _ep(s)} for s in rows]
    gone_ids = {s.id for s in rows}
    shots = _ordered(session, project_id)
    snap = snapshot_anchors(session, project_id)
    snap_st = snapshot_stage_ranges(session, project_id)
    for s in rows:
        session.delete(s)
    session.flush()
    _apply_order(session, project_id, [s for s in shots if s.id not in gone_ids],
                 snap, snap_st)
    out = {"ok": True, "deleted": len(deleted), "shots": deleted,
           "remaining": session.query(Shot).filter(Shot.project_id == project_id).count(),
           "note": "镜号已重新连续编号（后面的镜头号都变了，再操作前用 list_shots 重新取）"}
    if blocked:
        out["media_discarded"] = len(blocked)
        out["note"] += "；锚在被删镜头上的字幕/音频不会自动删除，用 list_subtitle_clips / list_audio_clips 核对"
    return out


# ---------------------------------------------------------------- 按剧本拆分

def split_shot_script(session, project_id: str, shot_id: str, parts) -> dict:
    """把一镜**按剧本**拆成相邻的几镜（不是切视频，那是 `routers.shots.split_shot`）。

    第 1 段留在原镜头行上（原行的版本历史、已出的片都还挂在它身上，但剧本变短了
    → 标过期）；其余每段各建一行新镜头，紧跟其后，继承原镜的集号、出场角色、场景、
    道具与生成参数，**不继承镜头脚本与画面**（那是针对原来那一整段写的）。
    """
    if not isinstance(parts, (list, tuple)) or len(parts) < 2:
        raise EditError("parts 至少要两段：[{script_ref, duration_sec?}, …]")
    if len(parts) > MAX_SPLIT_PARTS:
        raise EditError(f"一镜一次最多拆成 {MAX_SPLIT_PARTS} 段，这次 {len(parts)} 段")
    refs: list[tuple[str, Any]] = []
    for i, p in enumerate(parts, start=1):
        ref = p.get("script_ref") if isinstance(p, dict) else None
        ref = ref.strip() if isinstance(ref, str) else ""
        if not ref:
            raise EditError(f"parts 第 {i} 段缺 script_ref（这一段对应的剧本原文）")
        refs.append((ref, p.get("duration_sec")))

    sh = session.get(Shot, shot_id)
    if sh is None or sh.project_id != project_id:
        raise EditError("镜头不存在或不属于本项目")
    if sh.is_special:
        raise EditError("外部素材镜头没有剧本可拆")

    shots = _ordered(session, project_id)
    idx = next(i for i, s in enumerate(shots) if s.id == sh.id)
    snap = snapshot_anchors(session, project_id)
    snap_st = snapshot_stage_ranges(session, project_id)

    cap = model_cap(session, project_id)
    warnings: list[str] = []
    try:
        chars = [c for c in json.loads(sh.characters or "[]") if isinstance(c, str)]
    except (ValueError, TypeError):
        chars = []
    # 内容有没有被改写（只比去空白后的文字）：改写是允许的，但要让调用方知道

    def _squash(t) -> str:
        return "".join((t or "").split())

    rewritten = _squash("".join(r for r, _d in refs)) != _squash(sh.script_ref)

    inherit = {k: v for k, v in override_of(sh).items() if k in _INHERIT_OVERRIDE_KEYS}
    ov_json = json.dumps(inherit, ensure_ascii=False) if inherit else None

    sh.script_ref = refs[0][0]
    sh.duration_sec = settle_duration(session, project_id, refs[0][1], refs[0][0], chars,
                                      cap, "第 1 段", warnings)
    if sh.clip_dur_sec is not None or sh.clip_in_sec is not None:
        # 不变式 duration_sec == clip_dur_sec（见 db.Shot.clip_in_sec）：这里改的是
        # 生成目标时长，而取片窗口是绑在已出片素材上的坐标，两者只能留一个。
        sh.clip_in_sec = None
        sh.clip_dur_sec = None
        warnings.append("原镜头在时间轴上的取片窗口已清除（剧本变了，那段素材不再对应这一镜）")
    mark_edited(sh)

    new_rows: list = []
    for n, (ref, want) in enumerate(refs[1:], start=2):
        new_rows.append(Shot(
            id=uuid.uuid4().hex[:12], project_id=project_id, order=0,
            script_ref=ref, link_to_prev=CONTINUOUS,
            characters=sh.characters or "[]", props=sh.props, location=sh.location,
            episode=sh.episode, status="pending", is_special=0,
            profile_override=ov_json, ref_overrides=sh.ref_overrides,
            disabled=sh.disabled or 0, stale=0, stale_reason=None,
            duration_sec=settle_duration(session, project_id, want, ref, chars, cap,
                                         f"第 {n} 段", warnings)))
    for s in new_rows:
        session.add(s)
    session.flush()
    _apply_order(session, project_id, shots[:idx + 1] + new_rows + shots[idx + 1:],
                 snap, snap_st)

    had_script = bool(str(override_of(sh).get("prompt") or sh.gen_prompt or "").strip())
    out = {
        "ok": True, "mode": "script",
        "shots": [{"shot_id": s.id, "order": s.order, "duration_sec": s.duration_sec,
                   "new": s is not sh} for s in [sh] + new_rows],
        "stale_shot_ids": [sh.id],
        "note": ("第 1 段留在原镜头上、已标为过期"
                 + ("（它原来的镜头脚本是针对整段写的，要重写并锁定）" if had_script else "")
                 + "；其余各段是新镜头，还没有镜头脚本"),
    }
    if rewritten:
        out["script_rewritten"] = True
        warnings.append("各段拼起来与原镜头的剧本文字不一致（已按你给的写入）")
    if has_media(sh):
        warnings.append("原镜头已出的首帧/视频还在，它演的是拆分前的整段内容，需要重新生成")
    if warnings:
        out["warnings"] = warnings
    return out


# ---------------------------------------------------------------- 合并

def merge_shots(session, project_id: str, shot_ids, *, force: bool = False) -> dict:
    """把同一集里**相邻**的几镜并成一镜：剧本按镜头顺序用换行接起来。

    留下的是其中镜号最小的那一行（版本历史、已出的片都还在它身上，剧本变长了
    → 标过期）；其余几行删掉。被删的行里有已出的首帧/视频时默认拒绝，`force=True` 才删。
    """
    ids = _require_ids(shot_ids, "merge_shots")
    if len(ids) < 2:
        raise EditError("至少要两镜才能合并")
    rows = sorted(_load(session, project_id, ids), key=lambda s: (s.order, s.id))
    if any(s.is_special for s in rows):
        raise EditError("外部素材镜头不能参与合并",
                        special_shot_ids=[s.id for s in rows if s.is_special])
    eps = sorted({_ep(s) for s in rows})
    if len(eps) > 1:
        raise EditError(f"这几镜分属第 {'、'.join(map(str, eps))} 集，只能合并同一集里的镜头")
    shots = _ordered(session, project_id)
    pos = [i for i, s in enumerate(shots) if s.id in set(ids)]
    if pos != list(range(pos[0], pos[0] + len(pos))):
        raise EditError("这几镜不相邻（中间隔着别的镜头），只能合并连续的镜头",
                        orders=[s.order for s in rows])
    head, rest = rows[0], rows[1:]
    blocked = [s for s in rest if has_media(s)]
    if blocked and not force:
        raise EditError(
            f"要并掉的 {len(rest)} 镜里有 {len(blocked)} 镜已经出过首帧或视频，合并会把它们删掉，所以没有执行。"
            "确实要合并再传 force=true（需要用户确认）",
            code="shots_have_media",
            shots_with_media=[media_row(s) for s in blocked[:50]],
            media_count=len(blocked))

    warnings: list[str] = []

    def _names(col) -> list[str]:
        out: list[str] = []
        for s in rows:
            try:
                vals = json.loads(getattr(s, col) or "[]")
            except (ValueError, TypeError):
                vals = []
            out += [v for v in vals if isinstance(v, str) and v and v not in out]
        return out

    chars, props = _names("characters"), _names("props")
    locs = [s.location for s in rows if (s.location or "").strip()]
    if len(set(locs)) > 1:
        warnings.append("这几镜的场景不同（" + " / ".join(dict.fromkeys(locs))
                        + f"），合并后按第一镜记为「{head.location or locs[0]}」")
    durs = [float(s.duration_sec or 0) for s in rows]
    total = sum(durs)
    cap = model_cap(session, project_id)

    # 被并掉的镜头上锚着的音频/字幕：挪到留下的那一镜，偏移加上它前面各段的时长。
    # ⚠️ 必须在取锚点快照**之前**做：快照记的是「锚点镜号 → 镜头身份」，先挪好，
    # 这些段落才会跟着留下的那一镜走。
    before = 0.0
    for s, d in zip(rows, durs):
        if s is not head:
            for model in (AudioClip, SubtitleClip):
                for c in (session.query(model)
                          .filter(model.project_id == project_id,
                                  model.start_shot_order == s.order).all()):
                    c.start_shot_order = head.order
                    c.start_offset_sec = round(float(c.start_offset_sec or 0) + before, 3)
        before += d

    head.script_ref = "\n".join((s.script_ref or "").strip() for s in rows
                                if (s.script_ref or "").strip())
    head.characters = json.dumps(chars, ensure_ascii=False)
    head.props = json.dumps(props, ensure_ascii=False)
    if not (head.location or "").strip() and locs:
        head.location = locs[0]
    new_dur = max(1.0, total) if total > 0 else _FALLBACK_SEC
    if cap and new_dur > cap:
        warnings.append(f"合并后时长 {new_dur:.1f}s 超过当前视频模型单镜上限 {cap:.1f}s，"
                        f"已按 {cap:.1f}s 写入；内容装不下就少并几镜")
        new_dur = cap
    head.duration_sec = round(new_dur, 1)
    if head.clip_dur_sec is not None or head.clip_in_sec is not None:
        head.clip_in_sec = None
        head.clip_dur_sec = None
        warnings.append("留下那一镜在时间轴上的取片窗口已清除（剧本变了，那段素材不再对应这一镜）")
    mark_edited(head)

    removed = [{"shot_id": s.id, "order": s.order} for s in rest]
    rest_ids = {s.id for s in rest}
    session.flush()
    snap = snapshot_anchors(session, project_id)
    snap_st = snapshot_stage_ranges(session, project_id)
    for s in rest:
        session.delete(s)
    session.flush()
    _apply_order(session, project_id, [s for s in shots if s.id not in rest_ids],
                 snap, snap_st)

    out = {
        "ok": True, "shot_id": head.id, "order": head.order,
        "duration_sec": head.duration_sec, "merged": len(rows), "removed": removed,
        "script_ref": head.script_ref, "stale": True,
        "note": "合并后的镜头已标为过期：它身上原来的镜头脚本只对应第一段，要重写并锁定；"
                "后面镜头的镜号都变了，再操作前用 list_shots 重新取",
    }
    if blocked:
        out["media_discarded"] = len(blocked)
    if has_media(head):
        warnings.append("留下那一镜已出的首帧/视频还在，它演的只是合并前的第一段，需要重新生成")
    if warnings:
        out["warnings"] = warnings
    return out
