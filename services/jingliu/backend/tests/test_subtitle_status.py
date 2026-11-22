"""字幕的素材身份（2026-11-21）：字幕行记着按哪份素材做的，状态在读取时与镜头当前的素材比。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from conftest import PID, add_shot, make_project

VECTORS = json.loads((Path(__file__).resolve().parent / "fixtures/subtitle_rules_vectors.json")
                     .read_text("utf-8"))


class _Shot:
    def __init__(self, clip_in_sec=None, clip_dur_sec=None, duration_sec=None, speed=None):
        self.clip_in_sec, self.clip_dur_sec, self.duration_sec = clip_in_sec, clip_dur_sec, duration_sec
        self.transform_meta = json.dumps({"speed": speed}) if speed else None


@pytest.mark.parametrize("case", VECTORS["spans"], ids=[c["name"] for c in VECTORS["spans"]])
def test_source_seconds_map_through_the_trim_window_and_speed(case):
    from app.shot_timing import subtitle_source_span
    got = subtitle_source_span(_Shot(**case["shot"]), case["start"], case["end"])
    if case["expect"] is None:
        assert got is None
    else:
        assert got == pytest.approx(tuple(case["expect"]))


def _clip(db, sid, order, *, url=None, origin="muse", kind="subtitle", text="字幕", offset=0.0):
    import uuid

    from app.db import SubtitleClip
    with db() as s:
        s.add(SubtitleClip(id=uuid.uuid4().hex[:12], project_id=PID, text=text, kind=kind,
                           start_shot_order=order, start_offset_sec=offset, duration=1.0,
                           source_shot_id=sid if url else None, source_video_url=url,
                           time_base="source" if url else None, origin=origin))
        s.commit()


def _source(db, sid, url):
    from app.db import SubtitleSource
    with db() as s:
        s.merge(SubtitleSource(shot_id=sid, project_id=PID, source_video_url=url, origin="muse"))
        s.commit()


def _statuses(db):
    from app.db import Shot
    from app.subtitle_status import shot_statuses
    with db() as s:
        shots = s.query(Shot).filter(Shot.project_id == PID).order_by(Shot.order).all()
        return {sh.order: st for sh, st in
                ((sh, shot_statuses(s, PID, shots)[sh.id]) for sh in shots)}


V1, V2 = "/fw/media/generated/v1.mp4", "/fw/media/generated/v2.mp4"


def test_each_shot_reports_fresh_stale_unverified_or_missing(db):
    make_project(db)
    a = add_shot(db, PID, 1, video_url=V1)
    b = add_shot(db, PID, 2, video_url=V1)
    add_shot(db, PID, 3, video_url=V1)
    d = add_shot(db, PID, 4, video_url=V1)
    e = add_shot(db, PID, 5, video_url=V1)
    _clip(db, a, 1, url=V1)
    _clip(db, b, 2, url=V2)                            # 按别的素材做的
    _clip(db, None, 3, origin=None)                    # 老数据
    _source(db, d, V1)                                 # 做过，没人说话
    _clip(db, None, 5, origin="manual")                # 只有手加的
    _clip(db, None, 1, origin="manual")                # 手加的不让状态变差
    _clip(db, None, 1, kind="title", origin=None)      # 标题不算字幕
    assert _statuses(db) == {1: "fresh", 2: "stale", 3: "unverified", 4: "fresh", 5: "fresh"}
    _source(db, e, V2)
    assert _statuses(db)[5] == "stale"


def test_legacy_rows_stay_readable_after_the_migration(db):
    from sqlalchemy import text

    from app import db as _db
    from app.db import SubtitleClip
    from app.migrations import run_migrations
    make_project(db)
    add_shot(db, PID, 1, video_url=V1)
    with _db.engine.begin() as conn:
        conn.execute(text("DROP TABLE subtitle_clips"))
        conn.execute(text("DROP TABLE subtitle_sources"))
        conn.execute(text("""CREATE TABLE subtitle_clips (id VARCHAR(16) PRIMARY KEY,
            project_id VARCHAR(16) NOT NULL, text TEXT DEFAULT '', kind VARCHAR(16) DEFAULT 'subtitle',
            start_shot_order INTEGER DEFAULT 1, start_offset_sec REAL DEFAULT 0, duration REAL DEFAULT 3,
            style TEXT, created_at TEXT)"""))
        conn.execute(text(f"INSERT INTO subtitle_clips (id, project_id, text, start_shot_order) "
                          f"VALUES ('old1', '{PID}', '老字幕', 1)"))
    applied = run_migrations()
    assert {"subtitle_clips.source_shot_id", "subtitle_clips.origin", "table:subtitle_sources"} <= set(applied)
    with db() as s:
        old = s.get(SubtitleClip, "old1")
        assert (old.text, old.source_video_url, old.time_base, old.origin) == ("老字幕", None, None, None)
        names = {r[1] for r in s.execute(text("PRAGMA index_list(subtitle_clips)"))}
        assert "ix_subtitle_clips_source_shot" in names
    assert _statuses(db) == {1: "unverified"}
    assert run_migrations() == []                       # 再跑一次什么都不改


def test_adopting_another_version_or_regenerating_makes_subtitles_stale(db):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.db import Shot, ShotVersion, reset_clip_window
    from app.routers import shots as shots_router
    make_project(db)
    sid = add_shot(db, PID, 1, video_url=V1)
    other = add_shot(db, PID, 2, video_url=V1)
    with db() as s:
        s.add(ShotVersion(id="ver2", shot_id=sid, version_no=2, video_url=V2, thumb_url="/fw/media/generated/t.jpg"))
        s.commit()
    _clip(db, sid, 1, url=V1)
    _source(db, other, V1)
    assert _statuses(db) == {1: "fresh", 2: "fresh"}

    app = FastAPI()
    app.include_router(shots_router.router)
    r = TestClient(app).post(f"/v2/shots/{sid}/adopt", json={"version_no": 2})
    assert r.status_code == 200, r.text
    with db() as s:                                     # 重新生成：写回新的 video_url（jobs.py 同款）
        sh = s.get(Shot, other)
        sh.video_url = "/fw/media/generated/v3.mp4"
        reset_clip_window(sh)
        s.commit()
    assert _statuses(db) == {1: "stale", 2: "stale"}


def test_rows_with_a_source_shot_follow_that_shot_after_a_reorder(db):
    from app.db import Shot, SubtitleClip
    from app.subtitle_status import anchored_rows
    make_project(db)
    a = add_shot(db, PID, 1, video_url=V1)
    b = add_shot(db, PID, 2, video_url=V2)
    _clip(db, a, 1, url=V1, text="第一镜")
    _clip(db, None, 2, origin=None, text="老的按镜号")
    with db() as s:                                     # 改序但不改字幕的锚点
        s.get(Shot, a).order, s.get(Shot, b).order = 2, 1
        s.commit()
        shots = s.query(Shot).all()
        grouped = anchored_rows(shots, s.query(SubtitleClip).all())
        assert [r.text for r in grouped[a]] == ["第一镜", "老的按镜号"]
        assert grouped[b] == []
    assert _statuses(db) == {1: "missing", 2: "unverified"}


def test_export_warns_about_stale_subtitles(db):
    from app.db import Shot
    from app.routers.jianying import _stale_subtitle_warnings
    make_project(db)
    sid = add_shot(db, PID, 3, video_url=V2)
    _clip(db, sid, 3, url=V1)
    with db() as s:
        shots = s.query(Shot).all()
        (warning,) = _stale_subtitle_warnings(s, PID, shots)
    assert "1 个镜头换过素材" in warning and "镜号 3" in warning
