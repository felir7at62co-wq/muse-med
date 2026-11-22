"""自动字幕的 segments 模式（2026-11-21）：Muse 送来逐字识别结果，镜流不下载、不转写，只纠正、切条、按镜头替换。"""
from __future__ import annotations

import json
import os

import pytest

from conftest import PID, add_shot, make_project, run

V1, V2 = "/fw/media/generated/v1.mp4", "/fw/media/generated/v2.mp4"


def _words(text: str, t0: float = 0.0, step: float = 0.25, seg: int = 0) -> list[dict]:
    out, t = [], t0
    for ch in text:
        if ch in "，。！？" and out:
            out[-1]["text"] += ch
            continue
        out.append({"start": round(t, 3), "end": round(t + 0.2, 3), "text": ch, "seg": seg})
        t += step
    return out


@pytest.fixture()
def no_media(db, monkeypatch):
    """下载素材、选识别通道、剥音轨、量时长：segments 模式一样都不许碰。"""
    import app.media as media
    import app.providers.asr as asr_mod
    import app.subtitle_jobs as subtitle_jobs

    def forbidden(*_a, **_kw):
        raise AssertionError("segments 模式不该下载素材或转写")

    async def forbidden_async(*_a, **_kw):
        forbidden()

    monkeypatch.setattr(asr_mod, "pick_asr_provider", forbidden)
    monkeypatch.setattr(media, "ensure_local_async", forbidden_async)
    monkeypatch.setattr(media, "_probe_duration", forbidden_async)
    monkeypatch.setattr(subtitle_jobs, "_extract_asr_audio", forbidden_async)
    make_project(db, production_mode="drama")
    return db


def _job(segments, **extra):
    import app.jobs as jobs
    from app.subtitle_jobs import run_auto_subtitles
    jid = jobs.create_job("auto_subtitles", {"project_id": PID, "segments": segments, **extra})
    run(run_auto_subtitles(jid))
    job = jobs.get_job(jid)
    return job, json.loads(job.result) if job.result else None


def _rows(db):
    from app.db import SubtitleClip
    with db() as s:
        return [(c.source_shot_id, c.start_shot_order, c.text, c.origin, c.time_base,
                 round(c.start_offset_sec, 3), round(c.start_offset_sec + c.duration, 3))
                for c in s.query(SubtitleClip).order_by(SubtitleClip.start_shot_order,
                                                        SubtitleClip.start_offset_sec).all()]


def _files(root):
    return sorted(os.path.relpath(os.path.join(d, f), root) for d, _s, fs in os.walk(root) for f in fs)


def test_segments_are_corrected_and_written_without_downloading_or_transcribing(no_media):
    from app.config import get_settings
    from app.db import SubtitleSource
    db = no_media
    a = add_shot(db, PID, 1, script_ref="沈母：林晨，你终于回来了！", video_url=V1)
    b = add_shot(db, PID, 2, script_ref="林晨：我很想去。", video_url=V2, adopted_version=3)
    c = add_shot(db, PID, 3, script_ref="△空镜", video_url="/fw/media/generated/v3.mp4")
    data = get_settings().data_dir
    before = _files(data) if os.path.isdir(data) else []

    job, result = _job([
        {"shot_id": a, "video_url": V1, "source_sha256": "a" * 64, "duration_sec": 3.0,
         "words": _words("林辰，你终于回来了！")},
        {"shot_id": b, "video_url": V2, "source_sha256": "b" * 64, "words": _words("我不想去", 0.5)},
        {"shot_id": c, "video_url": "/fw/media/generated/v3.mp4", "words": []},
    ], episode=1)
    assert job.status == "done", job.error
    assert _rows(db) == [
        (a, 1, "林晨 你终于回来了", "muse", "source", 0.0, 1.95),
        (b, 2, "我不想去", "muse", "source", 0.5, 1.45)]
    assert (result["mode"], result["created"], result["refused"], result["episode"]) == ("segments", 2, [], 1)
    first, second, third = result["shots"]
    assert first["script_check"]["fixes"] == [{"heard": "辰", "script": "晨"}] and first["items"] == []
    (item,) = second["items"]
    assert (item["kind"], item["heard"], item["script"], item["decision"], second["pending"]) == (
        "differ", "不", "很", None, 1)
    assert third["cues"] == 0 and third["status"] == "fresh"
    with db() as s:
        src = {r.shot_id: (r.source_video_url, r.source_version, r.cues, r.review_pending, r.job_id)
               for r in s.query(SubtitleSource).all()}
    assert src == {a: (V1, None, 1, 0, job.id), b: (V2, 3, 1, 1, job.id),
                   c: ("/fw/media/generated/v3.mp4", None, 0, 0, job.id)}
    assert (_files(data) if os.path.isdir(data) else []) == before


def test_only_the_sent_shots_are_replaced_and_hand_added_subtitles_stay(no_media):
    from app.db import SubtitleClip
    db = no_media
    a = add_shot(db, PID, 1, script_ref="沈母：我很想去。", video_url=V1)
    b = add_shot(db, PID, 2, script_ref="林晨：走吧。", video_url=V2)
    add_shot(db, PID, 3, script_ref="林晨：好。", video_url="/fw/media/generated/v3.mp4")
    with db() as s:
        s.add_all([SubtitleClip(id="legacy1", project_id=PID, text="老的自动字幕", start_shot_order=1),
                   SubtitleClip(id="legacy3", project_id=PID, text="别的镜头", start_shot_order=3),
                   SubtitleClip(id="hand1", project_id=PID, text="手加的", start_shot_order=1,
                                origin="manual"),
                   SubtitleClip(id="title1", project_id=PID, text="片名", kind="title", start_shot_order=1)])
        s.commit()
    job, result = _job([{"shot_id": a, "video_url": V1, "words": _words("我不想去")},
                        {"shot_id": b, "video_url": V2, "words": _words("走吧")}], replace_legacy=True)
    assert job.status == "done"
    (item,) = [x for x in result["shots"][0]["items"] if x["kind"] == "differ"]

    # 第二次只送第一镜，并选了「换成剧本的字」：第二镜、别的镜头、手加的都不动；
    # 与手加字幕重叠的那条还等人选
    job, result = _job([{"shot_id": a, "video_url": V1, "words": _words("我不想去"),
                         "decisions": [{"id": item["id"], "action": "script"}]}])
    assert job.status == "done" and result["shots"][0]["pending"] == 1
    assert {x["kind"]: x["decision"] for x in result["shots"][0]["items"]} == {
        "differ": "script", "manual_overlap": None}
    with db() as s:
        texts = sorted((c.start_shot_order, c.text, c.origin) for c in s.query(SubtitleClip).all())
    assert texts == [(1, "我很想去", "muse"), (1, "手加的", "manual"), (1, "片名", None),
                     (2, "走吧", "muse"), (3, "别的镜头", None)]


def test_a_shot_whose_video_changed_or_bad_words_is_refused_and_keeps_its_subtitles(no_media):
    db = no_media
    a = add_shot(db, PID, 1, script_ref="沈母：你好。", video_url=V2)
    b = add_shot(db, PID, 2, script_ref="沈母：再见。", video_url=V1)
    job, result = _job([{"shot_id": a, "video_url": V1, "words": _words("你好")},
                        {"shot_id": b, "video_url": V1, "words": [{"start": 2, "end": 1, "text": "再"}]},
                        {"shot_id": "nope", "video_url": V1, "words": []}])
    assert job.status == "failed" and "一镜都没写" in job.error
    assert result["refused"] == [
        {"shot_id": a, "order": 1, "reason": "video_changed", "video_url": V2},
        {"shot_id": b, "order": 2, "reason": "invalid"},
        {"shot_id": "nope", "reason": "not_found"}]
    assert _rows(db) == []
    job, _result = _job([])
    assert job.status == "failed" and "segments" in job.error


def test_source_rows_follow_the_trim_window_in_the_srt(no_media):
    from app.db import Shot
    from app.routers.subtitle import export_subtitles_srt
    db = no_media
    add_shot(db, PID, 1, script_ref="沈母：你好。", video_url=V2, duration_sec=2.0)
    b = add_shot(db, PID, 2, script_ref="林晨：我回来了，你终于回来了。", video_url=V1, duration_sec=5.0)
    job, _ = _job([{"shot_id": b, "video_url": V1,
                    "words": _words("我回来了，", 0.0) + _words("你终于回来了。", 2.0, seg=1)}])
    assert job.status == "done"
    with db() as s:                                     # 修剪掉开头 1.5 秒：第一句不出字幕
        sh = s.get(Shot, b)
        sh.clip_in_sec, sh.clip_dur_sec, sh.duration_sec = 1.5, 3.0, 3.0
        s.commit()
    srt = export_subtitles_srt(PID)
    assert srt["count"] == 1
    assert "00:00:02,500 --> 00:00:03,950\n你终于回来了" in srt["srt"]   # 第一镜 2 秒 + (2.0 − 1.5)


def test_segments_go_through_the_jobs_endpoint_like_muse_submits_them(no_media):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app import routes_v2
    db = no_media
    a = add_shot(db, PID, 1, script_ref="沈母：你好。", video_url=V1)
    app = FastAPI()
    app.include_router(routes_v2.router)
    client = TestClient(app)
    body = {"kind": "auto_subtitles", "payload": {"project_id": PID, "segments": [
        {"shot_id": a, "video_url": V1, "words": _words("你好")}]}}
    r = client.post("/v2/jobs", json=body)
    assert r.status_code == 200, r.text
    status = client.get(f"/v2/jobs/{r.json()['id']}").json()
    assert status["status"] == "done", status
    assert json.loads(status["result"])["created"] == 1
