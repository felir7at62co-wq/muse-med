"""剪映草稿：只写剪辑参数（入出点 / 变速 / 音量 / 旁白轨 / 字幕），编码渲染在用户电脑上做。

复用 routers/jianying.py 的底层件（素材桩、写草稿、导入器打包、单文件 .bat），
**不改**那个模块——真人剧/解说剧的导出路径一行不动。

时间轴：镜头按序首尾相接；每镜按对齐结果的单元依次排：
  · dlg / sfx：原片原声，入出点 = 单元的源区间
  · narr：原声音量 0、画面按 speed 变速；旁白 TTS 放「旁白」轨同一时刻
  · fill（模型漏念的台词）：同 narr，TTS 放「补位配音」轨
字幕直接用**原文**（不做 ASR），长句按标点切成 ≤18 字的几行、按字数分时长。
"""
from __future__ import annotations

import json
import re
import shutil
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

from ..db import Project, Shot, get_session
from ..routers import jianying as J
from .pipeline import current_video, nd_of, nd_shots

SUB_MAX = 18


def _sub_lines(text: str, start: int, dur: int) -> list[tuple[str, int, int]]:
    """一句 → 若干行字幕 (文字, 起, 长)。按标点切、≤18 字一行，时长按字数分。"""
    parts = [p for p in re.split(r"(?<=[，。！？；…!?,;])", text.strip()) if p.strip()]
    lines, cur = [], ""
    for p in parts:
        if cur and len(cur) + len(p) > SUB_MAX:
            lines.append(cur)
            cur = ""
        cur += p
    if cur:
        lines.append(cur)
    if not lines:
        return []
    total = sum(len(l) for l in lines) or 1
    out, t = [], start
    for i, l in enumerate(lines):
        d = dur - (t - start) if i == len(lines) - 1 else int(dur * len(l) / total)
        out.append((l.strip("，,；;"), t, max(1, d)))
        t += d
    return out


def build(session, proj: Project, shots: list[Shot], name: str) -> dict:
    import pyJianYingDraft as draft
    from pyJianYingDraft import Timerange, TrackType

    from ..media_cache import meta_of, probe_meta

    w, h = J.CANVAS.get(proj.base_aspect or "9:16", (1080, 1920))
    script = draft.ScriptFile(w, h, J.DRAFT_FPS)
    script.add_track(TrackType.video)
    manifest: list[dict] = []
    seen: set[str] = set()

    #: 每镜实际用的视频（去字幕 / 高清过的处理版，或对齐时的原片）与说明
    videos = {s.id: current_video(session, s, nd_of(s).get("take")) for s in shots}
    rels = []
    for s in shots:
        tk = nd_of(s).get("take") or {}
        for u in [videos[s.id][0]] + [b.get("url") for b in nd_of(s).get("beats", [])] + \
                 [x.get("audio") for x in tk.get("units", [])]:
            if u and "/fw/media/" in u:
                rels.append(u.split("/fw/media/", 1)[1])
    meta = meta_of(rels)

    def want(url: str, fname: str):
        p = J._local(url)
        if p is None:
            return None
        rel = url.split("/fw/media/", 1)[1] if "/fw/media/" in url else ""
        m = meta.get(rel) or {}
        if not m.get("size") and p.is_file():
            m = {**probe_meta(p), "size": p.stat().st_size}
        if not m.get("size"):
            return None
        if fname not in seen:
            seen.add(fname)
            manifest.append({"url": J._pub(url), "name": fname, "size": m["size"], "_local": str(p)})
        return p, m

    st = J._text_style(proj)
    style = draft.TextStyle(size=st["size"], color=st["color"], align=1, bold=st["bold"],
                            auto_wrapping=True, max_line_width=0.82)
    border = draft.TextBorder(color=(0.0, 0.0, 0.0), width=st["stroke_width"])
    clip = draft.ClipSettings(transform_y=st["transform_y"])
    narr_segs, fill_segs, subs, notes = [], [], [], []
    t = 0
    cover = None
    for s in shots:
        nd = nd_of(s)
        tk = nd.get("take") or {}
        vurl, vnote = videos[s.id]
        if not vurl or not tk.get("units"):
            continue
        if vnote and vurl == tk.get("video_url") and vurl != s.video_url:
            notes.append(f"第{s.order}镜：{vnote}")
        # 文件名带上视频本身的名字：同一镜擦过字幕/高清后重新导出，导入器不会拿旧文件冒充
        fname = f"{s.id}-{Path(vurl).stem[-8:]}{Path(vurl).suffix or '.mp4'}"
        got = want(vurl, fname)
        if got is None:
            continue
        local, m = got
        if cover is None and local.is_file():
            cover = local
        mat = J._stub_material(draft.VideoMaterial, str(local),
                               f"E{(s.episode or 1):02d}-S{s.order:03d}", m, J._us(15))
        for u in tk["units"]:
            src_in, src_len = J._us(u["s"]), J._us(max(0.0, u["e"] - u["s"]))
            if src_len < J._us(0.05):
                continue
            spd = float(u.get("speed") or 1.0)
            out = int(round(src_len / spd))
            mute = u["k"] in ("narr", "fill")
            script.add_segment(draft.VideoSegment(
                mat, Timerange(t, out), source_timerange=Timerange(src_in, src_len),
                speed=spd, volume=0.0 if mute else 1.0))
            b = nd["beats"][u["beat"]] if u["beat"] < len(nd["beats"]) else {}
            audio = b.get("url") if u["k"] == "narr" else u.get("audio") if u["k"] == "fill" else None
            if audio:
                (narr_segs if u["k"] == "narr" else fill_segs).append((audio, t, out))
            if u["k"] != "sfx" and b.get("text"):
                speak = out
                if u["k"] == "narr" and b.get("dur"):
                    speak = min(out, J._us(b["dur"]))
                subs += _sub_lines(b["text"], t, speak)
            t += out
    total = t

    for tname, segs in (("旁白", narr_segs), ("补位配音", fill_segs)):
        if not segs:
            continue
        script.add_track(TrackType.audio, tname)
        cursor = 0
        for url, start, room in segs:
            got = want(url, f"{Path(url).stem}{Path(url).suffix or '.m4a'}")
            if got is None:
                continue
            local, m = got
            mat = J._stub_material(draft.AudioMaterial, str(local), f"{tname}·{Path(url).stem[-6:]}",
                                   m, room)
            dur = min(mat.duration, room)
            start = max(start, cursor)
            script.add_segment(draft.AudioSegment(mat, Timerange(start, dur),
                                                  source_timerange=Timerange(0, dur)),
                               track_name=tname)
            cursor = start + dur

    if subs:
        script.add_track(TrackType.text, "字幕")
        cursor = 0
        for text, start, dur in subs:
            start = max(start, cursor)
            if start >= total:
                break
            dur = min(dur, total - start)
            if dur <= 0:
                continue
            script.add_segment(draft.TextSegment(text, Timerange(start, dur), style=style,
                                                 border=border, clip_settings=clip),
                               track_name="字幕")
            cursor = start + dur
    # AI 标识：与真人剧导出同一个开关与样式（jianying._ai_label，项目设置里开）
    ai = J._ai_label(proj)
    if ai and total > 0:
        script.add_track(TrackType.text, "AI标识")
        script.add_segment(
            draft.TextSegment(ai["text"], Timerange(0, total),
                              style=draft.TextStyle(size=ai["size"], color=ai["color"], align=2,
                                                    alpha=ai["alpha"], auto_wrapping=False),
                              clip_settings=draft.ClipSettings(transform_x=ai["transform_x"],
                                                               transform_y=ai["transform_y"])),
            track_name="AI标识")
    return {"script": script, "manifest": manifest, "cover_src": cover, "name": name,
            "total_us": total, "notes": notes}


def export(project_id: str, episode: int | None, single_file: bool) -> dict:
    """产出剪映草稿包（与真人剧导出同一套导入器与交付形态）。"""
    from fastapi import HTTPException
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(404, "项目不存在")
        shots = [s for s in nd_shots(session, project_id)
                 if (episode is None or (s.episode or 1) == episode)
                 and (nd_of(s).get("take") or {}).get("video_url")]
        if not shots:
            raise HTTPException(400, "这一集还没有出好的镜头，先点「一键成片」")
        tag = f"第{episode}集" if episode is not None else "全片"
        built = build(session, proj, shots, f"{proj.title or project_id}-{tag}")
        n_shots = len(shots)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    pack_name = f"{project_id}-nd-{episode if episode is not None else 'all'}-{stamp}"
    pack = J.EXPORT_DIR / pack_name
    J.sweep_exports()
    if pack.exists():
        shutil.rmtree(pack)
    pack.mkdir(parents=True)
    try:
        info = J._write_draft(pack, built)
        src = Path(J.__file__).parent / "jianying_pack"
        for item in src.iterdir():
            dst = pack / item.name
            if item.is_dir():
                shutil.copytree(item, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(item, dst)
        mats = [{k: v for k, v in m.items() if not k.startswith("_")} for m in built["manifest"]]
        (pack / "manifest.json").write_text(
            json.dumps({"materials": mats, "drafts": [info], "mat_token": J.MAT_TOKEN,
                        "draft_token": J.DRAFT_TOKEN, "root_token": J.ROOT_TOKEN},
                       ensure_ascii=False, indent=2), encoding="utf-8")
        if single_file:
            out = J._emit_single_file(pack, pack_name, built, mats, n_shots, info)
            return {**out, **({"notes": built["notes"]} if built["notes"] else {})}
        zip_path = J.EXPORT_DIR / f"{pack_name}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(pack.rglob("*")):
                if f.is_file():
                    z.write(f, str(Path(pack_name) / f.relative_to(pack)))
    finally:
        if pack.exists():
            shutil.rmtree(pack, ignore_errors=True)
    return {"url": f"/fw/media/exports/jianying/{zip_path.name}", "name": zip_path.name,
            "file_size": zip_path.stat().st_size, "shots": n_shots, "materials": len(mats),
            "materials_bytes": sum(m["size"] for m in mats),
            "duration_sec": round(info["duration_us"] / 1_000_000, 1),
            "cover": bool(info["cover"]), "draft_name": info["name"],
            "expires_in_sec": J.EXPORT_TTL_SEC,
            **({"notes": built["notes"]} if built["notes"] else {})}
