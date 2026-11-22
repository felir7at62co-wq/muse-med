"""`POST /v2/projects/{pid}/edit-plan`（2026-11-21）：Muse 按集做逐字字幕要的镜头、窗口、台词、人名与字幕状态。"""
from __future__ import annotations

import json

import pytest

from conftest import PID, add_asset, add_shot, make_project

V1, V2 = "/fw/media/generated/v1.mp4", "/fw/media/generated/v2.mp4"


@pytest.fixture()
def client(db):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import text

    from app import db as _db
    from app.migrations import _TABLES
    from app.routers import subtitle
    with _db.engine.begin() as conn:
        conn.execute(text("DROP TABLE IF EXISTS media_objects"))
        conn.execute(text(_TABLES["media_objects"]))
    app = FastAPI()
    app.include_router(subtitle.router)
    return TestClient(app)


def test_edit_plan_lists_enabled_shots_with_windows_lines_names_and_status(db, client):
    from app.db import SubtitleClip, SubtitleSource
    from app.media_store import upsert_ledger
    make_project(db)
    add_asset(db, PID, "character", "沈母")
    a = add_shot(db, PID, 1, episode=1, script_ref="△推门。\n林晨：妈，我回来了。", video_url=V1,
                 adopted_version=2, clip_in_sec=1.5, clip_dur_sec=3.0, duration_sec=3.0,
                 transform_meta=json.dumps({"speed": 1.5}))
    b = add_shot(db, PID, 2, episode=1, script_ref="△空镜", video_url=V2, duration_sec=4.0)
    add_shot(db, PID, 3, episode=1, script_ref="沈母：别走。", video_url=V2, disabled=1)
    c = add_shot(db, PID, 4, episode=2, script_ref="沈母：吃饭吧。", video_url=None)
    upsert_ledger("generated/v1.mp4", key="k1", size=1234, etag='"e1"')
    with db() as s:
        s.add(SubtitleClip(id="c1", project_id=PID, text="妈 我回来了", start_shot_order=1,
                           start_offset_sec=1.6, duration=1.0, source_shot_id=a, source_video_url=V1,
                           time_base="source", origin="muse"))
        s.add(SubtitleSource(shot_id=b, project_id=PID, source_video_url=V1, origin="muse"))
        s.commit()

    r = client.post(f"/v2/projects/{PID}/edit-plan", json={"episodes": [2, 1, 1]})
    assert r.status_code == 200, r.text
    plan = r.json()
    assert plan["project_id"] == PID and plan["names"] == ["林晨", "沈母"]
    ep1, ep2 = plan["episodes"]
    assert ep1["episode"] == 1 and [s["order"] for s in ep1["shots"]] == [1, 2]      # 停用的不在
    first, second = ep1["shots"]
    assert first == {
        "shot_id": a, "order": 1, "episode": 1, "video_path": V1, "version": 2,
        "video_size": 1234, "video_etag": '"e1"', "clip_in_sec": 1.5, "clip_dur_sec": 3.0, "speed": 1.5,
        "output_sec": 2.0, "lines": ["妈，我回来了。"],
        "subtitles": {"status": "fresh", "cues": 1, "time_base": "source"}}
    assert second["lines"] == [] and second["subtitles"] == {"status": "stale", "cues": 0, "time_base": None}
    assert second["video_size"] is None and second["clip_in_sec"] == 0.0 and second["clip_dur_sec"] == 4.0
    assert ep1["subtitles"] == {"status": "stale", "stale": [2], "missing": [], "unverified": []}
    (only,) = ep2["shots"]
    assert only["shot_id"] == c and only["video_path"] is None and only["subtitles"]["status"] == "missing"
    assert ep2["subtitles"] == {"status": "missing", "stale": [], "missing": [4], "unverified": []}


def test_edit_plan_bounds(db, client):
    make_project(db)
    assert client.post(f"/v2/projects/{PID}/edit-plan", json={"episodes": []}).status_code == 422
    assert client.post(f"/v2/projects/{PID}/edit-plan",
                       json={"episodes": list(range(1, 102))}).status_code == 422
    assert client.post(f"/v2/projects/{PID}/edit-plan", json={"episodes": [0]}).status_code == 422
    assert client.post("/v2/projects/nope/edit-plan", json={"episodes": [1]}).status_code == 404
    r = client.post(f"/v2/projects/{PID}/edit-plan", json={"episodes": [7]})
    assert r.json()["episodes"] == [{"episode": 7, "shots": [], "subtitles": {
        "status": "missing", "stale": [], "missing": [], "unverified": []}}]
