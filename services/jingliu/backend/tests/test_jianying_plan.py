"""`POST /v2/projects/{pid}/jianying/plan`（2026-11-21）：每集一份剪映草稿 JSON + 素材清单，服务器上不落文件。"""
from __future__ import annotations

import json
import os

import pytest

from conftest import PID, add_shot, make_project

V1, V2, V3 = ("/fw/media/generated/v1.mp4", "/fw/media/generated/v2.mp4", "/fw/media/generated/v3.mp4")
BGM = "/fw/media/uploads/bgm.mp3"


@pytest.fixture()
def plan(db, monkeypatch):
    """两集；台账里有素材，本地一个文件都没有；从桶里拉文件会让测试失败。"""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import text

    from app import db as _db
    from app import storage
    from app.db import AudioClip, SubtitleClip, SubtitleSource
    from app.media_store import upsert_ledger
    from app.migrations import _TABLES
    from app.routers import jianying

    def no_fetch(*_a, **_kw):
        raise AssertionError("计划不该从桶里拉文件")

    monkeypatch.setattr(storage, "fetch", no_fetch)
    import pyJianYingDraft as draft
    if not hasattr(draft.ScriptFile, "add_track"):
        # requirements.txt 钉的 pyJianYingDraft 0.3.1 换了建轨与放段的写法；云端跑的仍是旧写法，
        # 本机安装时由 `muse-workbenches/install.py` 改写。这里用同样的对应关系把旧写法接到新库上。
        class ScriptFile(draft.ScriptFile):
            def __init__(self, width, height, fps):
                super().__init__(width, height, fps, maintrack_adsorb=True)

            def add_track(self, track_type, track_name=None):
                return self.append_track(draft.TrackSpec(track_type, track_name))

            def add_segment(self, segment, track_name=None):
                return super().add_segment(segment, track=track_name)

        monkeypatch.setattr(draft, "ScriptFile", ScriptFile)
    with _db.engine.begin() as conn:
        conn.execute(text("DROP TABLE IF EXISTS media_objects"))
        conn.execute(text(_TABLES["media_objects"]))
    for rel, size in (("generated/v1.mp4", 1000), ("generated/v2.mp4", 2000), ("generated/v3.mp4", 3000),
                      ("uploads/bgm.mp3", 500)):
        upsert_ledger(rel, key=rel, size=size, etag=f'"{rel}"',
                      meta={"width": 1080, "height": 1920, "duration_us": 8_000_000})
    make_project(db, title="测试剧")
    a = add_shot(db, PID, 1, episode=1, script_ref="沈母：你好。", video_url=V1, duration_sec=4.0)
    b = add_shot(db, PID, 2, episode=1, script_ref="林晨：再见。", video_url=V2, duration_sec=4.0,
                 clip_in_sec=1.0, clip_dur_sec=3.0)
    add_shot(db, PID, 3, episode=1, script_ref="停用", video_url=V3, disabled=1)
    c = add_shot(db, PID, 4, episode=2, script_ref="沈母：吃饭。", video_url=V3, duration_sec=4.0)
    with db() as s:
        s.add_all([
            SubtitleClip(id="s1", project_id=PID, text="你好", start_shot_order=1, start_offset_sec=0.5,
                         duration=1.0, source_shot_id=a, source_video_url=V1, time_base="source", origin="muse"),
            SubtitleClip(id="s2", project_id=PID, text="再见", start_shot_order=2, start_offset_sec=2.0,
                         duration=1.0, source_shot_id=b, source_video_url=V2, time_base="source", origin="muse"),
            SubtitleClip(id="s4", project_id=PID, text="旧素材的字幕", start_shot_order=4, start_offset_sec=0.0,
                         duration=1.0, source_shot_id=c, source_video_url=V1, time_base="source", origin="muse"),
            AudioClip(id="m1", project_id=PID, kind="music", url=BGM, status="done", start_shot_order=1,
                      start_offset_sec=0.0, duration=6.0),
        ])
        s.add(SubtitleSource(shot_id=c, project_id=PID, source_video_url=V1, origin="muse"))
        s.commit()
    app = FastAPI()
    app.include_router(jianying.router)
    client = TestClient(app)

    def call(episodes, **body):
        return client.post(f"/v2/projects/{PID}/jianying/plan", json={"episodes": episodes, **body})
    call.ids = (a, b, c)
    return call


def _texts(content: dict) -> list[str]:
    return [json.loads(t["content"])["text"] for t in content["materials"]["texts"]]


def test_each_episode_gets_draft_json_materials_and_subtitle_status(plan):
    from app.routers.jianying import DRAFT_TOKEN, EXPORT_DIR, MAT_TOKEN
    a, b, c = plan.ids
    existed = sorted(os.listdir(EXPORT_DIR)) if EXPORT_DIR.exists() else None
    r = plan([2, 1], switches={"ending": True})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["tokens"] == {"material": "__SFMAT__", "draft": "__SFDRAFT__", "root": "__SFROOT__"}
    assert out["unsupported"] == ["ending"]
    ep1, ep2 = out["episodes"]
    assert (ep1["episode"], ep1["name"], ep1["shots"]) == (1, "测试剧-第1集", 2)
    assert ep1["materials"] == [
        {"path": V1, "name": f"{a}.mp4", "size": 1000, "etag": '"generated/v1.mp4"'},
        {"path": V2, "name": f"{b}.mp4", "size": 2000, "etag": '"generated/v2.mp4"'},
        {"path": BGM, "name": "m1.mp3", "size": 500, "etag": '"uploads/bgm.mp3"'}]
    content, meta = ep1["draft_content"], ep1["draft_meta_info"]
    body = json.dumps(content, ensure_ascii=False)
    assert f"{MAT_TOKEN}/{a}.mp4" in body and "jingliu-tests-" not in body
    assert meta["draft_fold_path"] == DRAFT_TOKEN and meta["draft_cover"] == f"{DRAFT_TOKEN}/draft_cover.jpg"
    assert content["duration"] == ep1["duration_us"] == 7_000_000
    assert _texts(content) == ["你好", "再见"]
    texts = {json.loads(t["content"])["text"]: t["id"] for t in content["materials"]["texts"]}
    track = next(tr for tr in content["tracks"] if tr["type"] == "text")
    times = {seg["material_id"]: seg["target_timerange"] for seg in track["segments"]}
    assert times[texts["你好"]] == {"start": 500_000, "duration": 1_000_000}
    assert times[texts["再见"]] == {"start": 5_000_000, "duration": 1_000_000}   # 4 秒 + (2.0 − 入点 1.0)
    assert ep1["subtitles"] == {"status": "fresh", "stale": [], "missing": [], "unverified": [],
                                "switch": True, "cues": 2}
    assert ep1["music"] == {"switch": True, "clips": 1}
    assert ep1["cover"] == {"file": "draft_cover.jpg", "path": V1, "name": f"{a}.mp4", "source_in_us": 0}
    assert ep1["warnings"] == []
    assert ep2["subtitles"]["status"] == "stale" and ep2["subtitles"]["stale"] == [4]
    assert _texts(ep2["draft_content"]) == [] and "旧素材" in ep2["warnings"][0]
    assert (sorted(os.listdir(EXPORT_DIR)) if EXPORT_DIR.exists() else None) == existed

    again = plan([1, 2], switches={"ending": True}).json()["episodes"]
    assert [e["draft_sha256"] for e in again] == [ep1["draft_sha256"], ep2["draft_sha256"]]
    assert again[0]["draft_meta_info"]["draft_id"] != meta["draft_id"]


def test_switches_drop_music_and_subtitles_and_set_the_watermark(plan):
    out = plan([1], switches={"music": False, "subtitles": False, "watermark": True,
                              "watermark_text": "AI生成"}).json()
    (ep,) = out["episodes"]
    assert [m["path"] for m in ep["materials"]] == [V1, V2] and ep["music"] == {"switch": False, "clips": 0}
    assert ep["subtitles"]["switch"] is False and ep["subtitles"]["cues"] == 0
    assert _texts(ep["draft_content"]) == ["AI生成"] and out["unsupported"] == []
    plain = plan([1]).json()["episodes"][0]
    assert "AI生成" not in _texts(plain["draft_content"])          # 项目没开角标
    assert plain["draft_sha256"] != ep["draft_sha256"]


def test_episode_bounds_and_empty_episodes(plan):
    assert plan(list(range(1, 12))).status_code == 422
    assert plan([]).status_code == 422
    assert plan([9]).json()["episodes"] == [{"episode": 9, "error": "no_shots"}]


def test_the_zip_export_still_writes_the_same_draft_and_warns_about_stale_subtitles(plan):
    import zipfile

    from app.routers.jianying import EXPORT_DIR, MAT_TOKEN, ExportReq, _export_draft
    a, _b, _c = plan.ids
    out = _export_draft(PID, ExportReq(episode=2))
    assert "旧素材" in out["warnings"][0] and out["shots"] == 1
    out = _export_draft(PID, ExportReq(episode=1))
    assert out["warnings"] == [] and out["materials"] == 3 and out["duration_sec"] == 7.0
    with zipfile.ZipFile(EXPORT_DIR / out["name"]) as z:
        names = z.namelist()
        content = json.loads(z.read(next(n for n in names if n.endswith("draft_content.json"))))
        manifest = json.loads(z.read(next(n for n in names if n.endswith("manifest.json"))))
    assert _texts(content) == ["你好", "再见"] and f"{MAT_TOKEN}/{a}.mp4" in json.dumps(content)
    assert all(not k.startswith("_") for m in manifest["materials"] for k in m)
