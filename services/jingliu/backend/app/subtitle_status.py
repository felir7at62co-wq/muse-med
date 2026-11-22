"""每一镜的字幕还对不对得上它现在的素材和台词（2026-11-21，Muse 逐字字幕）。

状态在**读取时**现算：字幕行与 `subtitle_sources` 记着做字幕时的 `video_url`，和镜头当前的比；
`subtitle_sources` 还记着当时这一镜台词的摘要，改了剧本也算过期。
重新生成、采纳别的版本、手动出片都会换 `video_url`，所以这些地方不用回头改字幕。

| 状态 | 意思 |
|---|---|
| `fresh` | 按当前素材和台词做的（没人说话的镜头也算：`subtitle_sources` 里有这一镜）；或只有手加的字幕、这一镜也没有台词 |
| `stale` | 有字幕是按别的素材做的，或做字幕之后这一镜的台词改了：没重做 |
| `unverified` | 有不是手加的字幕不是按源文件时间做的：老数据（不知道按哪份素材做的）或镜流自己老路径转写的 |
| `missing` | 这一镜还没做过字幕；只有手加的字幕、却有台词要念的镜头也算（台词还没字幕） |

只看 `kind == "subtitle"` 的字幕；`origin == "manual"` 的（用户手加的、改过的）不算身份，也不让状态变差。
一集的状态取最差的那一镜：`stale` > `missing` > `unverified` > `fresh`。
"""
from __future__ import annotations

FRESH, STALE, UNVERIFIED, MISSING = "fresh", "stale", "unverified", "missing"
#: 一集取最差的那一镜
_WORST = (STALE, MISSING, UNVERIFIED, FRESH)


def is_legacy(row) -> bool:
    """老数据的字幕行：`origin` 为空（迁移前写的，手加的和老自动转写的分不出来）。segments 任务默认不删它。"""
    return (row.kind or "subtitle") == "subtitle" and row.origin is None


def shot_lines_sha256(shot) -> str:
    """这一镜现在会被念出来的台词的摘要（与 `subtitle_sources.lines_sha256` 同一个算法）。"""
    from .drama_timing import spoken_lines
    from .subtitle_cues import lines_sha256
    return lines_sha256(spoken_lines(shot.script_ref or ""))


def subtitle_status(shot, rows, source=None) -> str:
    """一镜的字幕状态（见模块说明）。

    `rows`：锚在这一镜上的字幕行（`anchored_rows` 分好的）；`source`：这一镜的
    `SubtitleSource` 行，没有为 None。
    """
    from .drama_timing import spoken_lines
    url = shot.video_url or ""
    subs = [r for r in rows if (r.kind or "subtitle") == "subtitle"]
    auto = [r for r in subs if r.origin != "manual"]
    idents = {r.source_video_url for r in auto if r.source_video_url}
    if source is not None:
        idents.add(source.source_video_url or "")
    if any(u != url for u in idents):
        return STALE
    if source is not None and source.lines_sha256 and source.lines_sha256 != shot_lines_sha256(shot):
        return STALE
    if any(r.time_base != "source" for r in auto):
        return UNVERIFIED
    if idents:
        return FRESH
    if subs and not spoken_lines(shot.script_ref or ""):
        return FRESH
    return MISSING


def anchored_rows(shots, rows) -> dict[str, list]:
    """字幕行按所在镜头分组 → {shot_id: [行]}。

    有 `source_shot_id` 的按它找（镜头改过序也找得到）；老数据按 `start_shot_order`。
    锚着的镜头不在 `shots` 里的行不出现。
    """
    by_id = {s.id: s for s in shots}
    by_order = {s.order: s for s in shots}
    out: dict[str, list] = {s.id: [] for s in shots}
    for r in rows:
        sh = by_id.get(r.source_shot_id) if r.source_shot_id else by_order.get(r.start_shot_order)
        if sh is not None:
            out[sh.id].append(r)
    return out


def shot_statuses(session, project_id: str, shots) -> dict[str, str]:
    """这些镜头各自的字幕状态 → {shot_id: 状态}。只查库。"""
    from .db import SubtitleClip, SubtitleSource
    shots = list(shots)
    if not shots:
        return {}
    rows = (session.query(SubtitleClip)
            .filter(SubtitleClip.project_id == project_id, SubtitleClip.kind == "subtitle").all())
    ids = [s.id for s in shots]
    sources = {}
    for i in range(0, len(ids), 500):
        for src in session.query(SubtitleSource).filter(SubtitleSource.shot_id.in_(ids[i:i + 500])):
            sources[src.shot_id] = src
    grouped = anchored_rows(shots, rows)
    return {s.id: subtitle_status(s, grouped[s.id], sources.get(s.id)) for s in shots}


def episode_summary(shots, statuses: dict[str, str]) -> dict:
    """一集的字幕状态 → `{status, stale, missing, unverified}`，后三个是镜号列表。没有镜头时为 `missing`。"""
    out = {STALE: [], MISSING: [], UNVERIFIED: []}
    for s in shots:
        st = statuses.get(s.id, MISSING)
        if st in out:
            out[st].append(s.order)
    status = next((st for st in _WORST[:-1] if out[st]), FRESH) if shots else MISSING
    return {"status": status, **out}
