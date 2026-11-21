"""「解说剧·角色开口」的接口：进度与核对报告 / 剪映草稿导出 / 接受某句差异。

出片、重做都走通用任务通道 /v2/jobs（kind = nd_breakdown / nd_produce），
本文件只放这个模式独有的读写。路径都带 project_id，归属由中间件拦。
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import access
from ..db import Project, Shot, get_session
from ..nd import MODELS, is_nd
from ..nd import textutil as T
from ..nd.pipeline import current_video, model_of, nd_of, nd_shots, save_nd

router = APIRouter(prefix="/v2", tags=["narration-dialogue"])


def _report_items(sh: Shot, nd: dict) -> list[dict]:
    """这一镜需要人看一眼的地方：台词与原文不一致 / 声线男女反了 / TTS 补位 / 出片失败。"""
    items = []
    if nd.get("status") == "failed":
        items.append({"kind": "failed", "text": nd.get("error") or "出片失败"})
        return items
    tk = nd.get("take") or {}
    accepted = set(nd.get("accepted") or [])
    if (tk.get("frozen") or 0) >= 1.5 and -1 not in accepted:
        items.append({"kind": "frozen", "beat": -1, "sec": tk["frozen"]})
    for f in tk.get("fid") or []:
        b = nd["beats"][f["beat"]]
        if f["beat"] in accepted:
            continue
        if not f.get("said"):
            items.append({"kind": "fill", "beat": f["beat"], "who": b.get("who"), "orig": b["text"]})
            continue
        vc = f.get("voice")
        if vc and not vc.get("ok"):
            items.append({"kind": "voice", "beat": f["beat"], "who": b.get("who"), "orig": b["text"],
                          "heard_gender": vc.get("heard"), "hz": vc.get("hz")})
        if f["ratio"] < 0.999 and len(T.clean(b["text"])) > 1:
            items.append({"kind": "mismatch", "beat": f["beat"], "who": b.get("who"),
                          "orig": b["text"], "heard": f.get("heard"), "ratio": f["ratio"],
                          "miss": f.get("miss"), "extra": f.get("extra"), "swap": f.get("swap")})
    return items


@router.get("/projects/{project_id}/nd/state")
@access.requires(access.ROLE_VIEWER)
def nd_state(project_id: str) -> dict:
    from ..script_import import smart_split_chapters
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(404, "项目不存在")
        if not is_nd(proj):
            raise HTTPException(409, "这个项目不是「解说剧·角色开口」模式")
        titles = {c["order"]: c["title"] for c in smart_split_chapters(proj.raw_script or "")}
        eps: dict[int, dict] = {}
        for sh in nd_shots(session, project_id):
            nd = nd_of(sh)
            tk = nd.get("take") or {}
            ep = sh.episode or 1
            e = eps.setdefault(ep, {"episode": ep, "title": titles.get(ep, f"第{ep}集"), "shots": []})
            fid = {f["beat"]: f for f in tk.get("fid") or []}
            vurl, vnote = current_video(session, sh, tk) if tk else (None, "")
            units = tk.get("units") or []
            e["shots"].append({
                "id": sh.id, "order": sh.order, "location": sh.location,
                "status": nd.get("status") or "planned", "error": nd.get("error"),
                "attempts": nd.get("attempts") or 0,
                "video_url": vurl, "thumb_url": sh.thumb_url,
                #: 交付页处理过的（「去字幕＋高清」），或为什么没用处理版
                "processed": vnote if vurl and vurl != tk.get("video_url") else "",
                "processed_note": vnote if vurl == tk.get("video_url") and sh.video_url != vurl else "",
                "duration": round(sum(u.get("dur", 0) for u in units), 1) if units else None,
                "beats": [{"k": b["k"], "who": b.get("who"), "text": b["text"], "vis": b.get("vis"),
                           "dur": b.get("dur"), "inserted": bool(b.get("inserted")),
                           "fid": ({k: fid[i].get(k) for k in ("ratio", "said", "heard", "voice")}
                                   if i in fid else None),
                           "fill": any(u["k"] == "fill" and u["beat"] == i for u in units)}
                          for i, b in enumerate(nd.get("beats") or [])],
                "extra": tk.get("extra") or [],
                "report": _report_items(sh, nd),
            })
        # 只列已开通的（例如没配万相 key 时不出现在下拉里）
        from ..providers.registry import registry as _reg
        return {"model": model_of(proj),
                "models": [m for m in MODELS if _reg.get_video(m) is not None],
                "narration_voice_url": proj.narration_voice_url,
                "has_script": bool(proj.raw_script),
                "episodes": [eps[k] for k in sorted(eps)]}


class ExportIn(BaseModel):
    episode: Optional[int] = None
    single_file: bool = True


@router.post("/projects/{project_id}/nd/export")
@access.requires(access.ROLE_VIEWER)
def nd_export(project_id: str, body: ExportIn) -> dict:
    from ..nd.export import export
    return export(project_id, body.episode, body.single_file)


class AcceptIn(BaseModel):
    beat: int


@router.post("/projects/{project_id}/nd/shots/{shot_id}/accept")
@access.requires(access.ROLE_EDITOR)
def nd_accept(project_id: str, shot_id: str, body: AcceptIn) -> dict:
    """核对报告里「接受」这一句：不再列出（片子不动）。"""
    with get_session() as session:
        sh = access.req_shot(session, shot_id)
        if sh.project_id != project_id:
            raise HTTPException(404, "镜头不存在")
        nd = nd_of(sh)
    if not nd:
        raise HTTPException(409, "这个镜头不属于「解说剧·角色开口」")
    acc = set(nd.get("accepted") or [])
    acc.add(int(body.beat))
    nd["accepted"] = sorted(acc)
    save_nd(shot_id, nd)
    return {"ok": True}


class ModelIn(BaseModel):
    model: str


@router.put("/projects/{project_id}/nd/model")
@access.requires(access.ROLE_EDITOR)
def nd_set_model(project_id: str, body: ModelIn) -> dict:
    """出片模型（第一期只有 Seedance 2.0 / 2.0 mini）。存进项目 default_profile.video_model。"""
    import json
    if body.model not in MODELS:
        raise HTTPException(400, f"只支持 {', '.join(MODELS)}")
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj or not is_nd(proj):
            raise HTTPException(409, "这个项目不是「解说剧·角色开口」模式")
        try:
            prof = json.loads(proj.default_profile or "{}")
        except (ValueError, TypeError):
            prof = {}
        prof["video_model"] = body.model
        proj.default_profile = json.dumps(prof, ensure_ascii=False)
        session.commit()
    return {"ok": True, "model": body.model}
