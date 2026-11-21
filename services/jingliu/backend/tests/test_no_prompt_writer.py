"""镜流不再用文本模型写镜头脚本：拆解不预生成、出片不兜底；首帧路线已下线，出片统一走全能参考。

所有会碰网络的东西（文本模型 / 生图 / 视频渠道 / ffmpeg）都打了桩；
`models` 夹具里任何一次真实的模型调用都会让测试当场失败。
"""
from __future__ import annotations

import importlib
import inspect
import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from conftest import PID, add_asset, add_shot, call_tool, get_shot, make_project, run, shots_of

APP = Path(__file__).resolve().parent.parent / "app"


@pytest.fixture()
def proj(db, tools):
    make_project(db)
    return db


@pytest.fixture()
def models(monkeypatch):
    """把文本模型与生图模型换成记账的桩。`llm` / `image` 是调用记录。"""
    from app.providers.image import ImageProvider
    from app.providers.llm import LLMProvider

    calls = SimpleNamespace(llm=[], image=[], llm_reply=None)

    async def _complete(self, system, user, *a, **kw):
        calls.llm.append((system, user))
        if calls.llm_reply is None:
            raise AssertionError("不该调用文本模型")
        return calls.llm_reply

    async def _generate(self, prompt, *a, **kw):
        calls.image.append({"prompt": prompt, **kw})
        return ["/fw/media/generated/img_fake.png"]

    monkeypatch.setattr(LLMProvider, "complete", _complete)
    monkeypatch.setattr(ImageProvider, "generate", _generate)
    return calls


# ---------------------------------------------------------------- 结构：引擎已删

def test_prompt_engine_is_removed_from_code():
    assert not (APP / "prompt_opt" / "house_rules.py").exists()
    assert not (APP / "prompt_opt" / "skill_assets").exists()
    popt = importlib.import_module("app.prompt_opt")
    svc = importlib.import_module("app.prompt_opt.service")
    for name in ("optimize_full", "optimize_to_prompt", "optimize_to_prompt_detailed",
                 "build_system_prompt", "get_status", "_house_rules"):
        assert not hasattr(popt, name) and not hasattr(svc, name), name
    # 留下的只有与写稿无关的查表函数
    assert popt.framework_for_model("seedance-2.5") == "seedance2"
    assert popt.framework_for_model("veo-3-1-fast") is None
    assert "LLMProvider" not in inspect.getsource(svc)

    revise = importlib.import_module("app.prompt_revise")
    assert not hasattr(revise, "revise_shot_prompt") and hasattr(revise, "revise_asset_prompt")

    jobs = importlib.import_module("app.jobs")
    assert not hasattr(jobs, "_pregen_prompts") and not hasattr(jobs, "run_reprompt")
    assert "reprompt" not in jobs.RUNNERS and "reprompt" in jobs.RETIRED_KINDS


def test_no_module_imports_the_removed_writer():
    """全仓 app/ 里不该再有人导入已删除的写稿入口（惰性导入也算）。"""
    gone = ("optimize_full", "optimize_to_prompt", "house_rules", "_pregen_prompts",
            "run_reprompt", "revise_shot_prompt as", "analyze_and_save",
            # 已无调用方的两个旧模块（站位分析 / 提示词拼装）：谁也不该再接回去
            "prompt_compose")
    # 文字版站位模块 `blocking` 按**整个模块名**认：`blocking_images`（站位图，2026-11-21）
    # 是另一个在用的模块，名字里带同一个词。
    dead_blocking = re.compile(r"(?<![\w])blocking(?![\w])")
    assert dead_blocking.search("from . import blocking") and dead_blocking.search(
        "from .blocking import analyze") and not dead_blocking.search("from . import blocking_images")
    hits = []
    for py in APP.rglob("*.py"):
        if py.name in ("blocking.py", "prompt_compose.py"):   # 那两个死模块自己互相引用
            continue
        for no, line in enumerate(py.read_text(encoding="utf-8").splitlines(), start=1):
            s = line.strip()
            if s.startswith(("from ", "import ")) and (any(g in s for g in gone)
                                                       or dead_blocking.search(s)):
                hits.append(f"{py.relative_to(APP)}:{no}: {s}")
    assert hits == []


def test_breakdown_source_has_no_prompt_stage():
    jobs = importlib.import_module("app.jobs")
    for fn in (jobs.breakdown_by_episode, jobs.run_breakdown_all, jobs.run_shot_videos,
               jobs.run_one_click_film):
        code = "\n".join(l for l in inspect.getsource(fn).splitlines()
                         if not l.strip().startswith("#"))
        body = code.split('"""', 2)[-1]                     # 去掉文档串
        for word in ("optimize_full", "_pregen_prompts", "analyze_and_save", "prompt_compose"):
            assert word not in body, (fn.__name__, word)


# ---------------------------------------------------------------- 拆解不再写提示词

_SCRIPT = ("第1集 重逢\n" + "△林晨推开门走进客厅，沈母坐在沙发上看着他。\n沈母：你还知道回来？\n" * 3
           + "\n第2集 对峙\n" + "△天台上风很大，林晨握紧了手里的文件袋。\n林晨：这件事到此为止。\n" * 3)


def test_breakdown_creates_shots_and_enrichment_but_writes_no_prompt(proj, models, monkeypatch):
    import app.character_brief as character_brief
    import app.character_profile as character_profile
    import app.jobs as jobs
    import app.routes_v2 as routes_v2
    from app.asset_seed import ensure_assets
    from app.db import Shot

    ran: list[str] = []

    async def fake_do_breakdown(script, model_id, project_id, episode=None, **kw):
        """替身：像真的拆解那样落镜头行与资产行（真的那个要调文本模型）。"""
        with proj() as s:
            base = s.query(Shot).filter(Shot.project_id == project_id).count()
            for i in range(2):
                s.add(Shot(id=f"e{episode}s{i}", project_id=project_id, order=base + i + 1,
                           script_ref=f"第{episode}集第{i + 1}镜", episode=episode,
                           characters='["林晨"]', location="客厅", status="pending"))
            ensure_assets(s, project_id, characters=["林晨"], locations=["客厅"])
            s.commit()
        ran.append(f"breakdown:{episode}")
        return SimpleNamespace(shots=[1, 2], warnings=[], lossy=False)

    def stub(name, value=None):
        async def _f(*a, **kw):
            ran.append(name)
            return value if value is not None else {"ok": True}
        return _f

    monkeypatch.setattr(routes_v2, "do_breakdown", fake_do_breakdown)
    monkeypatch.setattr(routes_v2, "run_stages_draft", stub("costume"))
    monkeypatch.setattr(character_profile, "fill_profiles", stub("profiles"))
    monkeypatch.setattr(character_brief, "fill_briefs", stub("briefs"))
    monkeypatch.setattr(jobs, "_collect_look", stub("look"))
    monkeypatch.setattr(jobs, "ensure_scene_descriptions", stub("scene_desc"))
    monkeypatch.setattr(jobs, "ensure_prop_descriptions", stub("prop_desc"))

    out = run(jobs.breakdown_by_episode(PID, _SCRIPT, None))

    # 拆解本身与收尾步骤照旧
    assert sorted(x for x in ran if x.startswith("breakdown")) == ["breakdown:1", "breakdown:2"]
    assert {"costume", "profiles", "briefs", "look", "scene_desc", "prop_desc"} <= set(ran)
    assert [(e["episode"], e["shots"]) for e in out["episodes"]] == [(1, 2), (2, 2)]
    assert all("prompt_fallbacks" not in e and "error" not in e for e in out["episodes"])
    assert out["costume"] == {"ok": True} and out["profiles"] == {"ok": True}

    # 镜头行在、按集排好；一个字的提示词都没写，也没调文本模型
    rows = shots_of(proj, PID)
    assert [(r.order, r.episode) for r in rows] == [(1, 1), (2, 1), (3, 2), (4, 2)]
    for r in rows:
        assert r.gen_prompt is None and r.prompt_state is None and r.profile_override is None
        assert r.blocking_out is None and r.stale == 0
    assert models.llm == [] and models.image == []


def test_run_breakdown_job_ends_done_without_prompts(proj, models, monkeypatch):
    """走 job 入口（run_breakdown 工具提交的就是它）：拆完即 done，不再有提示词阶段。"""
    import app.jobs as jobs
    import app.routes_v2 as routes_v2
    from app.db import Project, Shot

    with proj() as s:
        s.get(Project, PID).raw_script = _SCRIPT
        s.commit()

    async def fake_do_breakdown(script, model_id, project_id, episode=None, **kw):
        with proj() as s:
            s.add(Shot(id=f"e{episode}", project_id=project_id, order=episode,
                       script_ref=f"第{episode}集", episode=episode, status="pending"))
            s.commit()
        return SimpleNamespace(shots=[1], warnings=[], lossy=False)

    async def noop(*a, **kw):
        return {"ok": True}

    monkeypatch.setattr(routes_v2, "do_breakdown", fake_do_breakdown)
    monkeypatch.setattr(routes_v2, "run_stages_draft", noop)
    monkeypatch.setattr("app.character_profile.fill_profiles", noop)
    monkeypatch.setattr("app.character_brief.fill_briefs", noop)
    monkeypatch.setattr(jobs, "_collect_look", noop)
    monkeypatch.setattr(jobs, "ensure_scene_descriptions", noop)
    monkeypatch.setattr(jobs, "ensure_prop_descriptions", noop)

    jid = jobs.create_job("breakdown_all", {"project_id": PID})
    run(jobs.run_breakdown_all(jid))
    job = jobs.get_job(jid)
    assert job.status == "done", job.error
    assert [e["shots"] for e in json.loads(job.result)["episodes"]] == [1, 1]
    assert all(r.gen_prompt is None for r in shots_of(proj, PID)) and models.llm == []


# ---------------------------------------------------------------- 出片：没有锁定脚本就拒绝

class _FakeVideo:
    """最小的视频渠道替身：记下收到的请求，立刻"出片"。"""
    model_id = "fake-video"
    max_reference_images = 0
    uses_ark_trusted_assets = False
    prompt_framework = None

    def __init__(self):
        from app.providers.base import AudioMode
        self.audio_mode = AudioMode.inline
        self.requests = []

    def mode_support(self):
        return {"t2va": {"available": True}, "i2va": {"available": True}}

    async def submit(self, req):
        from app.providers.base import VideoResult
        self.requests.append(req)
        return VideoResult(status="done", video_url="/fw/media/generated/v_fake.mp4", raw={})


@pytest.fixture()
def video(monkeypatch, models):
    """注册替身视频渠道，并把出片链路上其余会碰外部世界的点都桩掉。"""
    import app.jobs as jobs
    import app.media as media
    from app.providers.registry import registry

    fake = _FakeVideo()
    monkeypatch.setitem(registry._video, "fake-video", fake)
    fake.desc_calls = []

    async def _desc(*a, **kw):
        fake.desc_calls.append(1)
        return {}

    async def _thumb(url):
        return "/fw/media/generated/thumb_fake.jpg"

    async def _probe(url):
        return 0.0

    monkeypatch.setattr(jobs, "ensure_scene_descriptions", _desc)
    monkeypatch.setattr(jobs, "ensure_prop_descriptions", _desc)
    monkeypatch.setattr(media, "make_thumb", _thumb)
    monkeypatch.setattr(media, "probe_duration_local", _probe)
    return fake


def _run_videos(payload: dict):
    import app.jobs as jobs
    jid = jobs.create_job("shot_videos", {"project_id": PID, "model_id": "fake-video", **payload})
    run(jobs.run_shot_videos(jid))
    return jobs.get_job(jid)


def test_shot_videos_refuses_unlocked_shots_without_any_model_call(proj, models, video):
    # 三种"没锁定"：从没写过 / 只有未锁定的底稿（存量机器稿）/ 标了 manual 但稿是空的
    bare = add_shot(proj, PID, 1, script_ref="△林晨进门。", location="客厅")
    draft = add_shot(proj, PID, 2, script_ref="沈母：回来了？", gen_prompt="旧的机器稿",
                     prompt_state="aligned")
    empty = add_shot(proj, PID, 3, script_ref="△沉默。", prompt_state="manual",
                     profile_override=json.dumps({"prompt": "   ", "generation_mode": "i2va"}))
    add_asset(proj, PID, "location", "客厅")          # 没有描述：旧逻辑会在出片前调文本模型补

    job = _run_videos({})
    assert job.status == "failed"
    result = json.loads(job.result)["shots"]
    assert [(r["order"], r["reason"]) for r in result] == [
        (1, "no_locked_prompt"), (2, "no_locked_prompt"), (3, "no_locked_prompt")]
    assert result[0]["error"] == "镜头 1 还没有锁定的镜头脚本，请先由 Muse 写入并锁定"
    assert "镜头 1 还没有锁定的镜头脚本" in (job.error or "")
    for sid, order in ((bare, 1), (draft, 2), (empty, 3)):
        sh = get_shot(proj, sid)
        assert sh.status == "failed" and sh.video_url is None and sh.first_frame_url is None
        assert sh.fail_reason == f"镜头 {order} 还没有锁定的镜头脚本，请先由 Muse 写入并锁定"
    assert get_shot(proj, draft).gen_prompt == "旧的机器稿"          # 底稿原样留着
    # 一次模型调用都没有：文本、生图、视频、出片前的描述补全
    assert models.llm == [] and models.image == []
    assert video.requests == [] and video.desc_calls == []


def test_shot_videos_sends_locked_prompt_verbatim_and_fails_only_the_unlocked(proj, models, video):
    locked = add_shot(proj, PID, 1, script_ref="剧本原文不该被发出去", duration_sec=5.0,
                      gen_prompt="锁定稿：0-5 秒，林晨推门进屋。", prompt_state="manual",
                      profile_override=json.dumps({"prompt": "锁定稿：0-5 秒，林晨推门进屋。"},
                                                  ensure_ascii=False))
    unlocked = add_shot(proj, PID, 2, script_ref="没写脚本的一镜")

    job = _run_videos({"shot_ids": [locked, unlocked]})
    assert job.status == "done"                      # 有一镜成功，整批不算失败
    by = {r["order"]: r for r in json.loads(job.result)["shots"]}
    assert by[1]["video_url"] == "/fw/media/generated/v_fake.mp4"
    assert by[2]["reason"] == "no_locked_prompt"

    assert len(video.requests) == 1
    assert video.requests[0].prompt == "锁定稿：0-5 秒，林晨推门进屋。"     # 原样，没有被改写/拼装
    sh = get_shot(proj, locked)
    assert sh.video_url == "/fw/media/generated/v_fake.mp4" and sh.status == "adopted"
    assert sh.gen_prompt == "锁定稿：0-5 秒，林晨推门进屋。" and sh.prompt_state == "manual"
    assert get_shot(proj, unlocked).status == "failed"
    assert models.llm == [] and models.image == []    # 锁定稿出片同样不调文本模型


def test_one_click_film_stops_before_spending_when_nothing_is_locked(proj, models, video):
    import app.jobs as jobs
    from app.db import Project
    with proj() as s:
        p = s.get(Project, PID)
        p.raw_script = _SCRIPT
        # 首帧路线：没有这道闸的话，会先花钱给每一镜出首帧（还要调文本模型蒸馏），
        # 然后在出片环节全部失败
        p.default_profile = json.dumps({"generation_mode": "i2va", "video_model": "fake-video"})
        s.commit()
    a = add_shot(proj, PID, 1, script_ref="A")
    add_shot(proj, PID, 2, script_ref="B")
    models.llm_reply = "（不该被用到的蒸馏结果）"
    jid = jobs.create_job("one_click_film", {"project_id": PID, "video_model": "fake-video"})
    run(jobs.run_one_click_film(jid))
    job = jobs.get_job(jid)
    assert job.status == "failed"
    assert "2 个待出片镜头都还没有锁定的镜头脚本" in job.error and "Muse" in job.error
    assert models.llm == [] and models.image == [] and video.requests == []
    assert get_shot(proj, a).first_frame_url is None

    # 只要有一镜锁了稿就放行（「先出这几镜」的正常用法），没锁的由出片那一步逐镜报
    from app.db import Shot
    with proj() as s:
        s.get(Shot, a).profile_override = json.dumps({"prompt": "锁定稿A"})
        s.commit()
    jid = jobs.create_job("one_click_film", {"project_id": PID, "video_model": "fake-video"})
    run(jobs.run_one_click_film(jid))
    job = jobs.get_job(jid)
    assert job.status == "done", job.error
    assert get_shot(proj, a).video_url == "/fw/media/generated/v_fake.mp4"
    assert [r.prompt for r in video.requests] == ["锁定稿A"]


# ---------------------------------------------------------------- 首帧路线已下线（2026-11-20）

def test_first_frame_jobs_and_helpers_are_gone():
    import app.jobs as jobs
    for name in ("run_first_frames", "run_first_frame_pipeline", "_gen_first_frame",
                 "_distill_frame_prompt", "_set_shot_first_frame"):
        assert not hasattr(jobs, name), name
    for kind in ("first_frames", "first_frame_pipeline"):
        assert kind not in jobs.RUNNERS and kind not in jobs._TARGET_KINDS
        assert "全能参考" in jobs.RETIRED_KINDS[kind]


def test_only_text_and_full_reference_modes_remain():
    from app.providers.base import (GENERATION_MODES, VideoRequest, infer_generation_mode,
                                    live_generation_mode, live_mode_support)
    assert set(GENERATION_MODES) == {"t2va", "full_reference"}
    assert [live_generation_mode(m) for m in ("i2va", "fl2va", "l2va", "t2va", None)] == \
        ["full_reference", "full_reference", "full_reference", "t2va", None]
    # 帧图不再单独成模式；已下线的模式名按「没指定」推断
    assert infer_generation_mode(VideoRequest(prompt="x", first_frame_url="/a.png")) == "full_reference"
    assert infer_generation_mode(VideoRequest(prompt="x", generation_mode="i2va")) == "t2va"
    every = {m: {"available": True} for m in ("t2va", "i2va", "fl2va", "l2va", "full_reference")}
    assert set(live_mode_support(every)) == {"t2va", "full_reference"}


def test_old_first_frame_project_runs_as_full_reference_and_draws_no_frame(proj, models, video):
    import app.jobs as jobs
    from app.db import Project
    with proj() as s:
        p = s.get(Project, PID)
        p.default_profile = json.dumps({"generation_mode": "i2va", "video_model": "fake-video"})
        s.commit()
        assert jobs._resolve_project_gen_settings(p)[0] == "full_reference"
    a = add_shot(proj, PID, 1, script_ref="A", duration_sec=5.0, gen_prompt="锁定A",
                 prompt_state="manual", profile_override=json.dumps({"prompt": "锁定A"}))
    job = _run_videos({"shot_ids": [a]})
    assert job.status == "done", job.error
    assert models.llm == [] and models.image == []       # 没有蒸馏首帧描述，也没有出首帧图
    req = video.requests[0]
    assert (req.first_frame_url, req.last_frame_url, req.generation_mode) == (None, None, None)
    assert get_shot(proj, a).first_frame_url is None


def test_frame_pictures_left_on_a_shot_travel_as_reference_images(proj, models, video):
    from app.db import ShotVersion
    video.max_reference_images = 9
    first, last = "/fw/media/generated/first.png", "/fw/media/generated/last.png"
    a = add_shot(proj, PID, 1, script_ref="A", duration_sec=5.0, gen_prompt="锁定A",
                 prompt_state="manual",
                 profile_override=json.dumps({"prompt": "锁定A", "generation_mode": "fl2va",
                                              "first_frame_url": first, "last_frame_url": last}))
    job = _run_videos({"shot_ids": [a]})
    assert job.status == "done", job.error
    req = video.requests[0]
    assert (req.first_frame_url, req.last_frame_url, req.generation_mode) == (None, None, None)
    assert req.reference_image_urls[-2:] == [first, last]
    assert models.llm == [] and models.image == []
    with proj() as s:
        meta = json.loads(s.query(ShotVersion).filter(ShotVersion.shot_id == a).one().meta)
    assert "已下线" in meta["mode_fallback"] and "参考图" in meta["mode_fallback"]


def test_seedance_sends_every_picture_as_a_reference_and_follows_the_enrolment_switch(monkeypatch):
    from app.providers import video_seedance
    from app.providers.base import VideoRequest
    req = VideoRequest(prompt="x", first_frame_url="/fw/media/generated/f.png",
                       last_frame_url="/fw/media/generated/l.png",
                       reference_image_urls=["/fw/media/generated/r1.png"])
    images = video_seedance.SeedanceVideoProvider._build_images(req)
    assert [i["role"] for i in images] == ["reference_image"] * 3
    # 帧图排在参考图之后：`@图片N` 是按参考图顺序编的号
    assert [i["url"].rsplit("/", 1)[-1] for i in images] == ["r1.png", "f.png", "l.png"]

    provider = video_seedance.SeedanceVideoProvider("seedance-2.0", "doubao-seedance-2-0-260128")
    assert set(provider.mode_support()) == {"t2va", "full_reference"}
    assert provider.supports_last_frame is False
    assert provider.uses_ark_trusted_assets is True      # 默认：直连火山，镜流自己入库
    monkeypatch.setattr(video_seedance.get_settings(), "ark_trusted_assets", False)
    gateway = video_seedance.SeedanceVideoProvider("seedance-2.0", "doubao-seedance-2-0-260128")
    assert gateway.uses_ark_trusted_assets is False      # 走统一网关：入库由网关做


def test_readiness_reports_no_first_frame_step(proj):
    from app.db import Project
    from app.readiness import compute_readiness
    with proj() as s:
        s.get(Project, PID).default_profile = json.dumps({"generation_mode": "i2va"})
        s.commit()
    add_shot(proj, PID, 1, script_ref="A",
             profile_override=json.dumps({"prompt": "锁定A", "generation_mode": "i2va"}))
    rd = compute_readiness(PID)
    assert rd["generation_mode"] == "full_reference"
    assert rd["first_frames"] == {"mode_active": False, "required": 0, "ready": 0, "missing": []}
    assert rd["i2va_supported"] is False
    assert not any("首帧" in w["text"] for w in rd["warnings"])


def test_new_projects_cannot_take_a_retired_mode(proj):
    from app.db import Project
    from app.routers.project import ProjectCreate, create_project_record
    made = create_project_record(ProjectCreate(
        title="旧网页还选得到首帧", custom_settings={"generation_mode": "i2va", "resolution": "720p"}), 1)
    with proj() as s:
        saved = json.loads(s.get(Project, made.id).default_profile)
    assert saved == {"generation_mode": "full_reference", "resolution": "720p"}
    from app.agent import tools_write
    assert tools_write.PROJECT_GENERATION_MODES == ("full_reference", "t2va")
