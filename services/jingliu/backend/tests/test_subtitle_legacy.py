"""老字幕与手加字幕在 Muse 逐字字幕旁边的待遇（2026-11-21 评审修正）。

- segments 任务默认不删 `origin` 为空的老字幕（分不出手加的还是老自动转写的），`replace_legacy` 时才删，删前存档；
- 手加的字幕永远不删，与 Muse 字幕时间重叠处列进待核；
- 只有手加字幕、却有台词要念的镜头不算做好；老路径转写的行不算按源文件时间做的；改了台词算过期；
- 旧网页界面看到、改动的都是老口径的偏移；
- 合并镜头时 Muse 字幕跟着锚到留下的那一镜并且过期。
"""
from __future__ import annotations

import json

import pytest

from conftest import PID, add_shot, make_project, run

V1, V2, V3 = "/fw/media/generated/v1.mp4", "/fw/media/generated/v2.mp4", "/fw/media/generated/v3.mp4"


def _words(text: str, t0: float = 0.0, step: float = 0.25, seg: int = 0) -> list[dict]:
    return [{"start": round(t0 + i * step, 3), "end": round(t0 + i * step + 0.2, 3), "text": ch, "seg": seg}
            for i, ch in enumerate(text)]


def _job(segments, **extra):
    import app.jobs as jobs
    from app.subtitle_jobs import run_auto_subtitles
    jid = jobs.create_job("auto_subtitles", {"project_id": PID, "segments": segments, **extra})
    run(run_auto_subtitles(jid))
    job = jobs.get_job(jid)
    return job, json.loads(job.result) if job.result else None


def _statuses(db):
    from app.db import Shot
    from app.subtitle_status import shot_statuses
    with db() as s:
        shots = s.query(Shot).filter(Shot.project_id == PID).order_by(Shot.order).all()
        got = shot_statuses(s, PID, shots)
        return {sh.order: got[sh.id] for sh in shots}


def _texts(db):
    from app.db import SubtitleClip
    with db() as s:
        return sorted((c.start_shot_order, c.text, c.origin) for c in s.query(SubtitleClip).all())


@pytest.fixture()
def project(db):
    make_project(db, production_mode="drama")
    return db


def test_legacy_rows_stay_unless_the_payload_asks_to_replace_them_and_are_archived(project):
    from app.db import SubtitleClip, SubtitleClipArchive
    db = project
    a = add_shot(db, PID, 1, script_ref="林晨：我回来了。", video_url=V1)
    b = add_shot(db, PID, 2, script_ref="沈母：走吧。", video_url=V2)
    with db() as s:
        s.add_all([SubtitleClip(id="handadded01", project_id=PID, text="我手加的字幕", start_shot_order=1),
                   SubtitleClip(id="oldasr00001", project_id=PID, text="老转写", start_shot_order=2,
                                origin="asr", source_shot_id=b, source_video_url=V2)])
        s.commit()
    assert _statuses(db) == {1: "unverified", 2: "unverified"}

    job, result = _job([{"shot_id": a, "video_url": V1, "words": _words("我回来了")},
                        {"shot_id": b, "video_url": V2, "words": _words("走吧")}])
    assert job.status == "done"
    assert result["refused"] == [{"shot_id": a, "order": 1, "reason": "legacy_subtitles", "legacy": 1}]
    assert result["archived"] == 1                       # 镜流老路径转写的行照换，先存档
    assert _texts(db) == [(1, "我手加的字幕", None), (2, "走吧", "muse")]
    assert _statuses(db) == {1: "unverified", 2: "fresh"}

    job, result = _job([{"shot_id": a, "video_url": V1, "words": _words("我回来了")}], replace_legacy=True)
    assert job.status == "done" and result["refused"] == [] and result["archived"] == 1
    assert _texts(db) == [(1, "我回来了", "muse"), (2, "走吧", "muse")]
    with db() as s:
        kept = sorted((r.clip_id, r.text, r.origin, r.reason, r.start_shot_order)
                      for r in s.query(SubtitleClipArchive).all())
    assert kept == [("handadded01", "我手加的字幕", None, "replace_legacy", 1),
                    ("oldasr00001", "老转写", "asr", "replace_asr", 2)]
    assert _statuses(db) == {1: "fresh", 2: "fresh"}


def test_hand_added_rows_stay_and_overlapping_muse_cues_wait_for_review(project):
    from fastapi import HTTPException  # noqa: F401  (导入路由模块需要)

    from app.routers import subtitle as R
    db = project
    a = add_shot(db, PID, 1, script_ref="林晨：我回来了。", video_url=V1)
    R.create_subtitle_clip(R.SubtitleClipIn(project_id=PID, text="三年后", start_shot_order=1,
                                            start_offset_sec=0.0, duration=0.4))
    assert _statuses(db) == {1: "missing"}               # 只有手加的，台词还没有字幕

    job, result = _job([{"shot_id": a, "video_url": V1, "source_sha256": "a" * 64,
                         "words": _words("我回来了", 0.2)}])
    assert job.status == "done"
    (shot,) = result["shots"]
    (item,) = [x for x in shot["items"] if x["kind"] == "manual_overlap"]
    assert (item["heard"], item["script"], item["decision"]) == ("我回来了", "三年后", None)
    assert shot["pending"] >= 1
    assert _texts(db) == [(1, "三年后", "manual"), (1, "我回来了", "muse")]
    assert _statuses(db) == {1: "fresh"}

    job, result = _job([{"shot_id": a, "video_url": V1, "source_sha256": "a" * 64,
                         "words": _words("我回来了", 0.2), "decisions": [{"id": item["id"], "action": "drop"}]}])
    (shot,) = result["shots"]
    assert [x["decision"] for x in shot["items"] if x["id"] == item["id"]] == ["drop"]
    assert _texts(db) == [(1, "三年后", "manual")]


def test_manual_only_shot_without_lines_is_fresh_and_old_path_rows_are_unverified(project):
    from app.db import SubtitleClip
    db = project
    add_shot(db, PID, 1, script_ref="△空镜", video_url=V1)
    b = add_shot(db, PID, 2, script_ref="林晨：好。", video_url=V2)
    with db() as s:
        s.add_all([SubtitleClip(id="note1", project_id=PID, text="三年后", start_shot_order=1, origin="manual"),
                   SubtitleClip(id="asr1", project_id=PID, text="好", start_shot_order=2, origin="asr",
                                source_shot_id=b, source_video_url=V2)])
        s.commit()
    assert _statuses(db) == {1: "fresh", 2: "unverified"}


def test_editing_the_script_after_the_subtitles_makes_them_stale(project):
    from app.db import Shot
    db = project
    a = add_shot(db, PID, 1, script_ref="林晨：我回来了。", video_url=V1)
    job, _ = _job([{"shot_id": a, "video_url": V1, "words": _words("我回来了")}])
    assert job.status == "done" and _statuses(db) == {1: "fresh"}
    with db() as s:
        s.get(Shot, a).script_ref = "林晨：我终于回来了。"
        s.commit()
    assert _statuses(db) == {1: "stale"}


def test_words_keep_the_order_muse_sent_so_review_ids_match_the_local_rules(project):
    from app.subtitle_jobs import _segment_words
    words = _words("林辰你终于回来了", 0.0, 0.2, 0) + _words("我不想去", 0.9, 0.2, 1)
    assert _segment_words(words) == [{k: w[k] for k in ("start", "end", "text", "seg")} for w in words]


def test_the_web_ui_reads_and_drags_muse_rows_in_legacy_units(project):
    import uuid

    from app.db import Shot, SubtitleClip
    from app.routers import subtitle as R
    db = project
    add_shot(db, PID, 1, script_ref="林晨：第一句。", video_url=V1, duration_sec=5.0)
    b = add_shot(db, PID, 2, script_ref="林晨：第二句。", video_url=V2, duration_sec=5.0,
                 clip_in_sec=1.5, clip_dur_sec=3.0, transform_meta=json.dumps({"speed": 1.5}))
    add_shot(db, PID, 3, script_ref="林晨：第三句。", video_url=V3, duration_sec=5.0)
    rid = uuid.uuid4().hex[:12]
    with db() as s:
        s.add(SubtitleClip(id=rid, project_id=PID, text="第二句", start_shot_order=2, start_offset_sec=1.6,
                           duration=0.8, source_shot_id=b, source_video_url=V2, time_base="source",
                           origin="muse"))
        s.commit()
    (clip,) = R.list_subtitle_clips(PID)["clips"]
    assert (clip["start_shot_order"], clip["start_offset_sec"], clip["duration"]) == (2, pytest.approx(0.1),
                                                                                      pytest.approx(0.8))

    R.patch_subtitle_clip(rid, R.SubtitleClipPatch(text="第二句话"))
    with db() as s:
        row = s.get(SubtitleClip, rid)
        assert (row.origin, row.time_base, row.source_shot_id) == ("manual", "source", b)

    R.patch_subtitle_clip(rid, R.SubtitleClipPatch(start_shot_order=3, start_offset_sec=0.5))
    with db() as s:
        row = s.get(SubtitleClip, rid)
        assert (row.origin, row.time_base, row.source_shot_id, row.start_shot_order,
                row.start_offset_sec) == ("manual", None, None, 3, 0.5)
        assert row.duration == pytest.approx(0.8)
        assert s.get(Shot, b).order == 2
    srt = R.export_subtitles_srt(PID)["srt"]
    assert "00:00:07,500 --> 00:00:08,300\n第二句话" in srt          # 第一镜 5 秒 + 第二镜 3/1.5 秒 + 0.5


def test_merging_shots_moves_muse_rows_to_the_kept_shot_and_marks_them_stale(project):
    from app.db import SubtitleClip, SubtitleSource
    from app.shot_edit import merge_shots
    db = project
    a = add_shot(db, PID, 1, script_ref="林晨：第一句。", video_url=V1)
    b = add_shot(db, PID, 2, script_ref="林晨：第二句。")
    job, _ = _job([{"shot_id": a, "video_url": V1, "words": _words("第一句")}])
    assert job.status == "done"
    with db() as s:                                       # 第二镜没出片，但留着一条按它锚的 Muse 字幕
        s.add(SubtitleClip(id="museb", project_id=PID, text="第二句", start_shot_order=2, start_offset_sec=0.4,
                           duration=0.6, source_shot_id=b, source_video_url=V2, time_base="source",
                           origin="muse"))
        s.merge(SubtitleSource(shot_id=b, project_id=PID, source_video_url=V2, origin="muse"))
        s.commit()
    with db() as s:
        merge_shots(s, PID, [a, b], force=True)
        s.commit()
    with db() as s:
        moved = s.get(SubtitleClip, "museb")
        assert (moved.source_shot_id, moved.start_shot_order, moved.start_offset_sec) == (a, 1, 0.4)
        assert s.get(SubtitleSource, b) is None
    assert _statuses(db) == {1: "stale"}
