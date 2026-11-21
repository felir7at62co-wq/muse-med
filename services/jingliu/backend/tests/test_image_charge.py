"""每张生成的图都扣积分（2026-11-21，用户：「用户的聊天生成都是需要扣除对应的额度的」）。

此前不收钱的三条路：自由生图任务（`kind="image"`，网页生图页和 Muse 的 `jingliu_image`）、
资产弹窗的场景多视角、智能体工具 `generate_scene_views`。现在都在提交时按张数预扣，
任务结束时按用量行 `SUM(cost_fen)` 多退少补，失败全额退；积分闸门关着时一分不扣。
另外几处张数报错的报价（候选图、兼容旧版的造型候选图同步接口、整项目补全）按实际张数算。
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from conftest import PID, add_asset, add_shot, call_tool, make_project, run, tool_ctx

UID = 7


@pytest.fixture()
def credit(db, tools, monkeypatch):
    """登录用户 UID 拥有项目 PID，个人池里有 10 元；`gate(False)` 关掉积分闸门。"""
    from app import access, config
    from app.db import BudgetLedger, BudgetPool, Job, UserBudget

    make_project(db, PID, owner_id=UID)
    with db() as s:
        s.add(UserBudget(user_id=UID, org_role="生成师", active=1))
        s.add(BudgetPool(pool_id=f"u:{UID}", balance_fen=1000))
        s.commit()

    def gate(on: bool) -> None:
        monkeypatch.setenv("FW_BUDGET_ENFORCED", "true" if on else "false")
        config.get_settings.cache_clear()

    def ledger() -> list[tuple[str, int, str | None]]:
        with db() as s:
            return sorted((r.entry, r.amount, r.job_id) for r in s.query(BudgetLedger).all())

    def balance() -> int:
        with db() as s:
            return s.get(BudgetPool, f"u:{UID}").balance_fen

    def set_balance(fen: int) -> None:
        with db() as s:
            s.get(BudgetPool, f"u:{UID}").balance_fen = fen
            s.commit()

    def jobs() -> int:
        with db() as s:
            return s.query(Job).count()

    gate(True)
    access.set_current_user({"id": UID, "username": f"u{UID}", "role": "user"})
    yield SimpleNamespace(db=db, gate=gate, ledger=ledger, balance=balance,
                          set_balance=set_balance, jobs=jobs)
    access.set_current_user(None)
    config.get_settings.cache_clear()


def _stub_images(monkeypatch, *, made: int | None = None, fail: bool = False) -> list[int]:
    """把生图渠道换成桩：像真渠道那样按出图张数记一行用量。返回每次调用请求的张数。"""
    from app import usage
    from app.providers.image import ImageProvider

    asked: list[int] = []

    async def _generate(self, prompt, *a, n=1, **kw):
        asked.append(n)
        if fail:
            raise RuntimeError("渠道不可用")
        got = n if made is None else made
        usage.record("image", model_id=self.model_id, channel="stub", units=got)
        return [f"/fw/media/generated/img_{i}.png" for i in range(got)]

    monkeypatch.setattr(ImageProvider, "generate", _generate)
    return asked


def _made(images: int):
    """替身 asset_batch runner：记 `images` 张图的用量并把任务置为完成。"""
    async def runner(jid: str) -> None:
        from app import jobs, usage
        usage.record("image", model_id="gpt-image-2", channel="stub", units=images)
        jobs._update(jid, status="done", progress=100)
    return runner


def _submit_image(payload: dict) -> tuple[str, object]:
    from fastapi import BackgroundTasks

    from app.job_models import JobSubmitIn
    from app.routes_v2 import submit_job

    bg = BackgroundTasks()
    out = run(submit_job(JobSubmitIn(kind="image", payload={"project_id": PID, **payload}), bg))
    return out.id, bg


@pytest.fixture()
def scene(credit, monkeypatch):
    """一个还没有任何视角图的场景资产；影调档案与 asset_batch 派发都打桩。返回资产 id。"""
    from app import job_submit, look_profile

    async def _no_look(project_id):
        return None

    monkeypatch.setattr(look_profile, "ensure", _no_look)
    credit.spawned = []
    monkeypatch.setattr(job_submit, "spawn_job",
                        lambda runner, jid, kind: credit.spawned.append((jid, kind)))
    return add_asset(credit.db, PID, "location", "渡口")


def _submit_views_route(aid: str, view_keys: list[str]):
    from fastapi import BackgroundTasks

    from app.routers.look import SceneViewsGenerateIn, generate_scene_views

    bg = BackgroundTasks()
    out = run(generate_scene_views(aid, SceneViewsGenerateIn(view_keys=view_keys), bg))
    return out.id, bg


# ---------------------------------------------------------------- 报价

def test_image_jobs_are_quoted_per_image():
    from app import charge

    assert charge.estimate("image", {}) == (25, "生图 1 张 × 0.25 元")
    assert charge.estimate("image", {"n": 2}) == (50, "生图 2 张 × 0.25 元")
    assert charge.estimate("image", {"n": 9})[0] == 100
    assert charge.estimate("image", {"n": "两张"})[0] == 25
    assert charge.estimate("image", {"model_id": "midjourney"}) == (100, "生图 4 张 × 0.25 元")
    assert charge.estimate("image", {"model_id": "midjourney", "n": 1})[0] == 100


def test_candidates_are_quoted_at_their_image_count_not_the_shot_count(db):
    from app import charge

    make_project(db, PID)
    for order in range(1, 7):
        add_shot(db, PID, order)
    assert charge.estimate("asset_candidates", {"project_id": PID, "n": 2}) == (50, "生图 2 张 × 0.25 元")
    assert charge.estimate("asset_candidates", {"project_id": PID, "n": 9})[0] == 100
    assert charge.estimate("asset_candidates", {"project_id": PID})[0] == 25


def test_a_full_asset_fill_is_quoted_at_the_missing_images(db, monkeypatch):
    from app import charge, scene_view

    make_project(db, PID)
    for order in range(1, 6):
        add_shot(db, PID, order, location="渡口")
    # 5 镜都在一个没有图的场景里：缺口是这个场景的全部视角，不是镜头数
    assert charge.estimate("asset_fill", {"project_id": PID}) == (
        scene_view.VIEW_COUNT * 25, f"生图 {scene_view.VIEW_COUNT} 张 × 0.25 元")

    seen: list[set[str]] = []
    monkeypatch.setattr(charge, "_fill_gap_count", lambda pid, kinds: seen.append(set(kinds)) or 3)
    assert charge.estimate("asset_fill", {"project_id": PID}) == (75, "生图 3 张 × 0.25 元")
    assert charge.estimate("asset_fill", {"project_id": PID, "kinds": ["prop"]})[0] == 75
    assert seen == [{"character", "location", "prop"}, {"prop"}]
    monkeypatch.setattr(charge, "_fill_gap_count", lambda pid, kinds: 0)
    assert charge.estimate("asset_fill", {"project_id": PID}) == (0, "没有缺图的要素")


def test_scene_view_quotes_count_the_views(tools):
    from app import scene_view
    from app.agent import policy

    spec = tools.get_spec("generate_scene_views")
    every = scene_view.VIEW_COUNT
    assert policy.estimate_for(spec, {"project_id": PID, "asset_id": "a"}) == (
        every * 25, f"生图 {every} 张 × 0.25 元")
    first, second = (v.key for v in scene_view.VIEWS[:2])
    assert policy.estimate_for(spec, {"project_id": PID, "asset_id": "a",
                                      "view_keys": [first, second, first]}) == (50, "生图 2 张 × 0.25 元")


def test_muse_reads_the_price_of_one_image(credit):
    quote = call_tool("cost_estimate", kind="image")
    assert (quote["estimate_fen"], quote["note"]) == (25, "生图 1 张 × 0.25 元")
    credit.gate(False)
    assert call_tool("cost_estimate", kind="image")["estimate_fen"] == 0


# ---------------------------------------------------------------- 自由生图任务

def test_an_image_job_holds_its_images_and_settles_on_the_images_made(credit, monkeypatch):
    asked = _stub_images(monkeypatch, made=2)
    jid, bg = _submit_image({"prompt": "雨夜小站", "n": 3})
    assert credit.ledger() == [("hold", -75, jid)]
    assert credit.balance() == 925

    run(bg())
    assert asked == [3]
    assert credit.ledger() == [("hold", -75, jid), ("settle", 25, jid)]
    assert credit.balance() == 950


def test_a_midjourney_job_holds_four_images(credit, monkeypatch):
    _stub_images(monkeypatch)
    jid, _bg = _submit_image({"prompt": "雨夜小站", "model_id": "midjourney", "n": 1})
    assert credit.ledger() == [("hold", -100, jid)]


def test_a_failed_image_job_is_refunded_in_full(credit, monkeypatch):
    _stub_images(monkeypatch, fail=True)
    jid, bg = _submit_image({"prompt": "雨夜小站"})
    run(bg())
    assert credit.ledger() == [("hold", -25, jid), ("settle", 25, jid)]
    assert credit.balance() == 1000


# ---------------------------------------------------------------- 场景多视角

def test_the_scene_view_route_holds_every_missing_view_and_settles(credit, scene, monkeypatch):
    from app import jobs, scene_view

    monkeypatch.setitem(jobs.RUNNERS, "asset_batch", _made(5))
    jid, bg = _submit_views_route(scene, [])
    held = scene_view.VIEW_COUNT * 25
    assert credit.ledger() == [("hold", -held, jid)]

    run(bg())
    assert credit.ledger() == [("hold", -held, jid), ("settle", held - 125, jid)]
    assert credit.balance() == 1000 - 125


def test_the_scene_view_tool_holds_the_named_views_and_settles(credit, scene):
    from app import scene_view
    from app.job_submit import _run_job_guarded

    keys = [v.key for v in scene_view.VIEWS[:3]]
    out = call_tool("generate_scene_views", asset_id=scene, view_keys=keys)
    jid = out["job_id"]
    assert (out["ok"], out["estimate_fen"], credit.spawned) == (True, 75, [(jid, "asset_batch")])
    assert credit.ledger() == [("hold", -75, jid)]

    run(_run_job_guarded(_made(2), jid, "asset_batch"))
    assert credit.ledger() == [("hold", -75, jid), ("settle", 25, jid)]
    assert credit.balance() == 950


def test_resending_a_scene_view_call_takes_over_its_job_and_holds_once(credit, scene):
    from app import jobs, scene_view
    from app.agent import registry
    from app.agent.executor import execute_tool

    keys = [v.key for v in scene_view.VIEWS[:2]]
    jid = call_tool("generate_scene_views", asset_id=scene, view_keys=keys)["job_id"]
    # 派发桩从不推进任务，这条 pending 像重启后无人接管的行：重发时重新派发，不再预扣。
    again = call_tool("generate_scene_views", asset_id=scene, view_keys=keys)
    assert (again["job_id"], again["deduped"]) == (jid, True)
    assert credit.spawned == [(jid, "asset_batch")] * 2

    jobs._update(jid, status="running")
    again = call_tool("generate_scene_views", asset_id=scene, view_keys=keys)
    assert (again["job_id"], again["deduped"], len(credit.spawned)) == (jid, True, 2)
    assert (credit.jobs(), credit.ledger(), credit.balance()) == (1, [("hold", -50, jid)], 950)

    spec = registry.get_spec("generate_scene_views")
    other = json.loads(run(execute_tool(tool_ctx(), spec, {"project_id": PID, "asset_id": scene,
                                                           "view_keys": keys}, call_id="call-other")))
    assert other["job_id"] != jid
    assert (credit.jobs(), credit.balance()) == (2, 900)


# ---------------------------------------------------------------- 闸门与余额

def test_nothing_is_held_while_the_credit_gate_is_off(credit, scene, monkeypatch):
    from app import jobs

    credit.gate(False)
    _stub_images(monkeypatch)
    monkeypatch.setitem(jobs.RUNNERS, "asset_batch", _made(8))
    _jid, bg = _submit_image({"prompt": "雨夜小站", "n": 2})
    run(bg())
    _jid, bg = _submit_views_route(scene, [])
    run(bg())
    assert call_tool("generate_scene_views", asset_id=scene)["estimate_fen"] > 0
    assert (credit.jobs(), credit.ledger(), credit.balance()) == (3, [], 1000)


def test_too_little_credit_stops_the_submission(credit, scene):
    from app import charge

    credit.set_balance(10)
    with pytest.raises(charge.InsufficientCredit):
        _submit_image({"prompt": "雨夜小站"})
    with pytest.raises(charge.InsufficientCredit):
        _submit_views_route(scene, [])
    out = call_tool("generate_scene_views", asset_id=scene)
    assert out["ok"] is False and "积分不足" in out["error"]
    assert (credit.jobs(), credit.ledger(), credit.spawned) == (0, [], [])


# ---------------------------------------------------------------- 兼容旧版的同步候选图

def test_the_legacy_stage_route_charges_the_images_it_makes(credit, monkeypatch):
    from app.db import AssetStage
    from app.routers.stage_scene import StageCandidatesIn, stage_candidates

    asked = _stub_images(monkeypatch)
    for order in range(1, 7):
        add_shot(credit.db, PID, order)
    with credit.db() as s:
        s.add(AssetStage(id="stage-0001", project_id=PID, character_name="角色甲",
                         stage_name="默认造型"))
        s.commit()
    assert len(run(stage_candidates("stage-0001", StageCandidatesIn(n=6)))["urls"]) == 6
    run(stage_candidates("stage-0001", StageCandidatesIn(n=20)))
    assert asked == [6, 9]
    assert credit.ledger() == [("spend", -225, None), ("spend", -150, None)]
    assert credit.balance() == 1000 - 375
