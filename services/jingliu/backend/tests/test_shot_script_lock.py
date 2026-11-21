"""镜头脚本的锁定规则：先有场景图、后锁脚本；锁定即清过期；读工具与闸门同一判据。

以及「镜流不再自己写镜头脚本」在 Agent 工具面与 HTTP 面上的体现：
相关工具已删、相关路由回 410。
"""
from __future__ import annotations

import json

import pytest

from conftest import (PID, add_asset, add_shot, call_tool, get_shot, make_project)


@pytest.fixture()
def proj(db, tools):
    make_project(db)
    return db


def _locked(db, sid) -> str | None:
    sh = get_shot(db, sid)
    return (json.loads(sh.profile_override) if sh.profile_override else {}).get("prompt")


# ---------------------------------------------------------------- 场景图闸门

def test_lock_rejected_without_scene_image_then_allowed(proj):
    sid = add_shot(proj, PID, 1, script_ref="△林晨进门。", location="夜 内 林家客厅")

    # ① 场景连资产行都没有
    out = call_tool("set_shot_prompt", shot_id=sid, prompt="0-3 秒：林晨推门。", lock=True)
    assert out["ok"] is False and out["code"] == "scene_assets_missing"
    assert out["missing_scene_assets"] == [{
        "shot_id": sid, "order": 1, "location": "夜 内 林家客厅", "scene": "林家客厅",
        "reason": "no_asset", "reason_text": out["missing_scene_assets"][0]["reason_text"]}]
    assert "allow_missing_scene_assets" in out["hint"]
    assert _locked(proj, sid) is None and get_shot(proj, sid).gen_prompt is None

    # ② 有资产行但还没出图
    aid = add_asset(proj, PID, "location", "林家客厅")
    out = call_tool("set_shot_prompt", shot_id=sid, prompt="0-3 秒：林晨推门。", lock=True)
    assert out["ok"] is False and out["missing_scene_assets"][0]["reason"] == "no_image"

    # 不锁定的底稿不受这条规则约束（但出片不会用它）
    out = call_tool("set_shot_prompt", shot_id=sid, prompt="草稿", lock=False)
    assert out["ok"] is True and out["prompt_state"] == "draft" and _locked(proj, sid) is None

    # ③ 场景图出好之后可以锁
    from app.db import Asset
    with proj() as s:
        s.get(Asset, aid).image_url = "/fw/media/generated/scene.png"
        s.commit()
    out = call_tool("set_shot_prompt", shot_id=sid, prompt="0-3 秒：林晨推门。", lock=True)
    assert out["ok"] is True and out["prompt_state"] == "manual"
    assert _locked(proj, sid) == "0-3 秒：林晨推门。"


def test_lock_override_for_special_cases_and_no_location(proj):
    no_img = add_shot(proj, PID, 1, script_ref="黑场字卡", location="虚空")
    no_loc = add_shot(proj, PID, 2, script_ref="纯特效镜头")

    out = call_tool("set_shot_prompt", shot_id=no_img, prompt="黑场。", lock=True,
                    allow_missing_scene_assets=True)
    assert out["ok"] is True and _locked(proj, no_img) == "黑场。"
    # 镜头没写场景：没有可对着写的场景，不拦
    out = call_tool("set_shot_prompt", shot_id=no_loc, prompt="粒子特效。", lock=True)
    assert out["ok"] is True and _locked(proj, no_loc) == "粒子特效。"


def test_scene_image_sources_stage_view_and_tombstone(proj):
    """「可用的图」与出片注入同一口径：场景造型图 / 多视角主图 / 资产图任一即可；删掉的资产不算。"""
    from app.db import AssetStage, SceneView
    a = add_shot(proj, PID, 1, script_ref="A", location="咖啡馆")
    b = add_shot(proj, PID, 2, script_ref="B", location="天台")
    c = add_shot(proj, PID, 3, script_ref="C", location="仓库")
    cafe = add_asset(proj, PID, "location", "咖啡馆")
    roof = add_asset(proj, PID, "location", "天台")
    add_asset(proj, PID, "location", "仓库", image_url="/img/warehouse.png",
              deleted_at="2026-11-01T00:00:00+00:00")
    with proj() as s:
        s.add(SceneView(id="sv1", project_id=PID, asset_id=cafe, view_key="angle_n",
                        kind="angle", label="主视角", image_url="/img/cafe_n.png"))
        s.add(AssetStage(id="st1", project_id=PID, character_name="天台", stage_name="雨夜",
                         ep_from=1, ep_to=1, image_url="/img/roof_rain.png"))
        s.commit()
    out = call_tool("set_shot_prompts", lock=True, items=[
        {"shot_id": a, "prompt": "脚本A"}, {"shot_id": b, "prompt": "脚本B"},
        {"shot_id": c, "prompt": "脚本C"}])
    by = {r["shot_id"]: r for r in out["results"]}
    assert by[a]["ok"] is True and by[b]["ok"] is True
    assert by[c]["ok"] is False and out["missing_scene_assets"][0]["reason"] == "deleted"
    assert roof and _locked(proj, a) == "脚本A" and _locked(proj, b) == "脚本B"


def test_batch_lock_lists_rejected_shots_and_writes_the_rest(proj):
    ok1 = add_shot(proj, PID, 1, script_ref="A", location="客厅")
    bad1 = add_shot(proj, PID, 2, script_ref="B", location="楼道")
    bad2 = add_shot(proj, PID, 3, script_ref="C", location="楼道")
    add_asset(proj, PID, "location", "客厅", image_url="/img/living.png")
    add_asset(proj, PID, "location", "楼道")

    out = call_tool("set_shot_prompts", lock=True, items=[
        {"shot_id": ok1, "prompt": "脚本A"}, {"shot_id": bad1, "prompt": "脚本B"},
        {"shot_id": bad2, "prompt": "脚本C"}, {"shot_id": "nope", "prompt": "x"}])
    assert out["ok"] is True and out["written"] == 1 and out["failed"] == 3
    assert out["code"] == "scene_assets_missing" and out["rejected"] == 2
    assert [(m["shot_id"], m["scene"], m["reason"]) for m in out["missing_scene_assets"]] == [
        (bad1, "楼道", "no_image"), (bad2, "楼道", "no_image")]
    by = {r["shot_id"]: r for r in out["results"]}
    assert by[ok1]["ok"] and by[ok1]["prompt_state"] == "manual"
    assert by[bad1]["code"] == "scene_assets_missing" and by["nope"]["ok"] is False
    assert _locked(proj, ok1) == "脚本A" and _locked(proj, bad1) is None

    # 全部被拒时顶层也要有 error（模型只看 ok/error 也能知道原因）
    out = call_tool("set_shot_prompts", lock=True, items=[{"shot_id": bad1, "prompt": "脚本B"}])
    assert out["ok"] is False and "楼道" in out["error"] and out["rejected"] == 1

    out = call_tool("set_shot_prompts", lock=True, allow_missing_scene_assets=True,
                    items=[{"shot_id": bad1, "prompt": "脚本B"}, {"shot_id": bad2, "prompt": "脚本C"}])
    assert out["ok"] is True and out["written"] == 2 and "missing_scene_assets" not in out
    assert _locked(proj, bad2) == "脚本C"


# ---------------------------------------------------------------- 锁定即清过期

def test_locked_write_clears_stale(proj):
    add_asset(proj, PID, "location", "客厅", image_url="/img/living.png")
    sid = add_shot(proj, PID, 1, script_ref="A", location="客厅")
    assert call_tool("set_shot_prompt", shot_id=sid, prompt="第一稿", lock=True)["ok"]

    # 改了拆解 → 标过期，稿子还是旧的
    assert call_tool("patch_shot", shot_id=sid, script_ref="改过的剧本")["stale"] is True
    sh = get_shot(proj, sid)
    assert sh.stale == 1 and sh.stale_reason == "reprompt" and _locked(proj, sid) == "第一稿"
    assert call_tool("get_episode_readiness", episode=1)["summary"]["stale_orders"] == [1]

    # 重写并锁定 → 过期清掉
    out = call_tool("set_shot_prompt", shot_id=sid, prompt="第二稿", lock=True)
    assert out["ok"] and out["stale"] is False
    sh = get_shot(proj, sid)
    assert sh.stale == 0 and sh.stale_reason is None and sh.prompt_state == "manual"
    assert call_tool("get_episode_readiness", episode=1)["summary"]["stale_orders"] == []


def test_batch_lock_and_edit_of_locked_prompt_clear_stale_but_draft_does_not(proj):
    from app.db import Shot
    a = add_shot(proj, PID, 1, script_ref="A", stale=1, stale_reason="reprompt")
    b = add_shot(proj, PID, 2, script_ref="B", stale=1, stale_reason="rebreak")
    c = add_shot(proj, PID, 3, script_ref="C", stale=1, stale_reason="reprompt")

    out = call_tool("set_shot_prompts", lock=True,
                    items=[{"shot_id": a, "prompt": "脚本A"}, {"shot_id": b, "prompt": "脚本B"}])
    assert out["written"] == 2
    assert [get_shot(proj, x).stale for x in (a, b)] == [0, 0]
    assert get_shot(proj, b).stale_reason is None

    # 未锁定的底稿：不清（reprompt 只降到 regen）
    assert call_tool("set_shot_prompt", shot_id=c, prompt="草稿")["stale"] is True
    sh = get_shot(proj, c)
    assert sh.stale == 1 and sh.stale_reason == "regen" and sh.prompt_state == "draft"

    # 已锁定的稿被局部修改（edit_shot_prompt 仍是锁定写入）→ 同样清掉
    with proj() as s:
        s.get(Shot, a).stale = 1
        s.get(Shot, a).stale_reason = "reprompt"
        s.commit()
    out = call_tool("edit_shot_prompt", shot_id=a, edits=[{"old": "脚本A", "new": "脚本A改"}])
    assert out["ok"] and out["prompt_state"] == "manual"
    assert get_shot(proj, a).stale == 0 and _locked(proj, a) == "脚本A改"


# ---------------------------------------------------------------- get_episode_readiness

def test_get_episode_readiness_rows_and_summary(proj):
    from app.db import AssetStage
    add_asset(proj, PID, "location", "林家客厅", image_url="/img/living.png")
    add_asset(proj, PID, "location", "林家楼道")
    add_asset(proj, PID, "character", "林晨", image_url="/img/linchen.png")
    add_asset(proj, PID, "character", "沈母")
    add_asset(proj, PID, "character", "管家")
    with proj() as s:      # 管家只有造型图、角色资产自己没图：算有图
        s.add(AssetStage(id="st-g", project_id=PID, character_name="管家", stage_name="默认造型",
                         ep_from=1, ep_to=1, image_url="/img/butler.png"))
        s.commit()
    s1 = add_shot(proj, PID, 1, script_ref="A", location="夜 内 林家客厅",
                  characters='["林晨", "沈母"]', gen_prompt="锁定稿", prompt_state="manual",
                  profile_override=json.dumps({"prompt": "锁定稿"}))
    s2 = add_shot(proj, PID, 2, script_ref="B", location="林家楼道", characters='["林晨", "管家"]',
                  stale=1, stale_reason="reprompt", first_frame_url="/img/ff.png")
    s3 = add_shot(proj, PID, 3, script_ref="C")
    add_shot(proj, PID, 4, script_ref="停用的", location="林家楼道", disabled=1)
    add_shot(proj, PID, 5, episode=2, script_ref="别的集", location="林家楼道")

    out = call_tool("get_episode_readiness", episode=1)
    assert out["ok"] is True and out["episode"] == 1 and len(out["shots"]) == 4
    r1, r2, r3, r4 = out["shots"]
    assert (r1["shot_id"], r1["order"], r1["location"], r1["scene"]) == (
        s1, 1, "夜 内 林家客厅", "林家客厅")
    assert r1["scene_has_image"] is True and r1["locked"] is True
    assert r1["prompt_state"] == "manual" and r1["stale"] is False
    assert r1["characters"] == [{"name": "林晨", "has_image": True},
                                {"name": "沈母", "has_image": False}]
    assert (r2["shot_id"], r2["scene_has_image"], r2["scene_reason"]) == (s2, False, "no_image")
    assert r2["locked"] is False and r2["stale"] is True and r2["stale_reason"] == "reprompt"
    assert r2["has_first_frame"] is True and r2["has_video"] is False
    assert r2["characters"] == [{"name": "林晨", "has_image": True},
                                {"name": "管家", "has_image": True}]
    assert (r3["shot_id"], r3["location"], r3["scene_has_image"]) == (s3, None, None)
    assert r4["disabled"] is True

    sm = out["summary"]
    assert sm["shots"] == 3 and sm["locked"] == 1            # 停用的不进汇总
    assert sm["unlocked_orders"] == [2, 3] and sm["stale_orders"] == [2]
    assert [(m["scene"], m["shots"], m["reason"]) for m in sm["scenes_missing_image"]] == [
        ("林家楼道", [2], "no_image")]
    assert sm["characters_missing_image"] == [{"name": "沈母", "shots": [1]}]
    assert sm["shots_without_location"] == [3]
    assert sm["scene_assets_ready"] is False

    empty = call_tool("get_episode_readiness", episode=9)
    assert empty["ok"] is True and empty["shots"] == [] and "write_episode_shots" in empty["note"]
    spec = __import__("app.agent.registry", fromlist=["x"]).get_spec("get_episode_readiness")
    assert spec.risk == "read" and spec.role == "viewer" and spec.costs is False


def test_readiness_and_lock_gate_agree(proj):
    """体检说缺图的镜头，锁定时一定被拒；体检说齐了的，一定能锁。"""
    add_asset(proj, PID, "location", "客厅", image_url="/img/a.png")
    add_asset(proj, PID, "location", "楼道")
    ids = [add_shot(proj, PID, 1, script_ref="A", location="日 内 客厅"),
           add_shot(proj, PID, 2, script_ref="B", location="楼道"),
           add_shot(proj, PID, 3, script_ref="C", location="没建资产的地方")]
    rows = call_tool("get_episode_readiness", episode=1)["shots"]
    out = call_tool("set_shot_prompts", lock=True,
                    items=[{"shot_id": i, "prompt": "脚本"} for i in ids])
    by = {r["shot_id"]: r["ok"] for r in out["results"]}
    assert [by[r["shot_id"]] for r in rows] == [r["scene_has_image"] for r in rows] == [
        True, False, False]


# ---------------------------------------------------------------- 工具面 / HTTP 面

def test_prompt_writer_tools_are_gone(tools):
    specs = tools.all_specs()
    for gone in ("run_reprompt", "revise_shot_prompt", "reset_shot_prompt", "run_one_click_film"):
        assert gone not in specs
    # 资产生图提示词的改写不是镜头脚本，保留
    assert "revise_asset_prompt" in specs
    # 只读说明类工具还在，且不依赖已删除的提示词引擎
    assert {"get_prompt_rules", "preview_prompt", "check_prompt_health"} <= set(specs)
    from app.agent import policy
    for gone in ("run_reprompt", "revise_shot_prompt", "run_one_click_film"):
        assert gone not in policy._KIND_OF
    # 每个花钱的工具都要有报价映射（漏了报价恒为 0）
    for name, sp in specs.items():
        if sp.costs and sp.long_running:
            assert name in policy._KIND_OF or getattr(sp, "job_kind", None), name


def test_get_prompt_rules_still_reads_without_engine(proj):
    with proj() as s:
        from app.db import Project
        s.get(Project, PID).default_profile = json.dumps({"video_model": "seedance-2.5"})
        s.commit()
    out = call_tool("get_prompt_rules")
    assert out["ok"] is True and "format" in out and "version" not in out
    assert call_tool("check_prompt_health")["ok"] is True


@pytest.fixture()
def client(proj):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app import routes_v2
    from app.routers import desktop_agent, shots

    app = FastAPI()
    app.include_router(shots.router)
    app.include_router(routes_v2.router)
    app.include_router(desktop_agent.router)
    return TestClient(app)


def test_prompt_writer_routes_return_410(client, proj):
    sid = add_shot(proj, PID, 1, script_ref="A", gen_prompt="锁定稿", prompt_state="manual",
                   profile_override=json.dumps({"prompt": "锁定稿"}))
    r = client.post(f"/v2/shots/{sid}/prompt/revise", json={"instruction": "把雨改成雪"})
    assert r.status_code == 410 and "Muse" in r.json()["detail"]
    assert client.post(f"/v2/shots/{sid}/prompt/revise").status_code == 410     # 不带 body 也是 410
    r = client.delete(f"/v2/shots/{sid}/prompt")
    assert r.status_code == 410 and "Muse" in r.json()["detail"]
    assert _locked(proj, sid) == "锁定稿"                                        # 锁定稿没被清掉
    r = client.post("/v2/jobs", json={"kind": "reprompt", "payload": {"project_id": PID}})
    assert r.status_code == 410 and "Muse" in r.json()["detail"]
    assert client.get("/v2/prompt-opt/status").status_code == 410
    # 手改保存（网页编辑器）仍然可用：它就是「写入并锁定」
    r = client.patch(f"/v2/shots/{sid}/prompt", json={"gen_prompt": "网页手改稿"})
    assert r.status_code == 200 and _locked(proj, sid) == "网页手改稿"

    from app.db import Job
    with proj() as s:
        assert s.query(Job).count() == 0                # 410 的提交没有建任务
        s.add(Job(id="old-reprompt", kind="reprompt", status="failed",
                  payload=json.dumps({"project_id": PID}), project_id=PID))
        s.commit()
    assert client.post("/v2/jobs/old-reprompt/retry").status_code == 410


def test_first_frame_route_job_kinds_and_tools_are_retired(client, proj, tools):
    """首帧 / 首尾帧 / 尾帧三种生成模式下线（2026-11-20）：路由与任务回 410，工具不再提供。"""
    sid = add_shot(proj, PID, 1, script_ref="A", profile_override=json.dumps({"prompt": "锁定A"}))
    r = client.post(f"/v2/shots/{sid}/first-frame", json={"frame_prompt": "x"})
    assert r.status_code == 410 and "全能参考" in r.json()["detail"]
    assert client.post(f"/v2/shots/{sid}/first-frame").status_code == 410       # 不带 body 也是 410
    for kind in ("first_frames", "first_frame_pipeline"):
        r = client.post("/v2/jobs", json={"kind": kind, "payload": {"project_id": PID}})
        assert r.status_code == 410 and "全能参考" in r.json()["detail"], kind
    from app.db import Job
    with proj() as s:
        assert s.query(Job).count() == 0                # 410 的提交没有建任务

    offered = client.get("/v2/providers/video").json()
    assert set(offered["generation_modes"]) == {"t2va", "full_reference"}
    assert all(not {"i2va", "fl2va", "l2va"} & set(p["modes"]) for p in offered["providers"])

    specs = tools.all_specs()
    from app.agent import policy
    for gone in ("run_first_frames", "regen_first_frame"):
        assert gone not in specs and gone not in policy._KIND_OF
    out = call_tool("set_shot_override", shot_id=sid, generation_mode="i2va")
    assert out["ok"] is False and "已下线" in out["error"]
    assert _locked(proj, sid) == "锁定A"
    assert call_tool("set_shot_override", shot_id=sid, generation_mode="t2va")["ok"] is True
    out = call_tool("check_episodes_progress", episodes=[1], step="first_frames")
    assert out["ok"] is False and "first_frames" not in out["error"]


def test_desktop_gateway_lists_and_calls_new_tools(client, proj):
    listed = {t["name"]: t for t in client.get("/v2/desktop-agent/tools").json()["tools"]}
    for gone in ("run_reprompt", "revise_shot_prompt", "reset_shot_prompt", "run_one_click_film",
                 "run_first_frames", "regen_first_frame"):
        assert gone not in listed
    for name in ("write_episode_shots", "delete_shots", "move_shot", "merge_shots",
                 "get_episode_readiness"):
        t = listed[name]
        assert t["costs"] is False and t["long_running"] is False
        assert t["risk"] == ("read" if name == "get_episode_readiness" else "write")
    props = lambda n: set(listed[n]["parameters"]["properties"])   # noqa: E731
    assert props("write_episode_shots") == {"project_id", "episode", "shots", "mode", "force"}
    assert {"episode", "script_ref", "characters", "location", "props",
            "link_to_prev"} <= props("insert_shot")
    assert "link_to_prev" in props("patch_shot")
    assert props("split_shot") == {"shot_id", "at_sec", "parts"}
    assert "allow_missing_scene_assets" in props("set_shot_prompt")
    assert "allow_missing_scene_assets" in props("set_shot_prompts")
    assert props("set_shot_override") == {"shot_id", "model_id", "generation_mode", "clear"}

    def call(name, args, **kw):
        return client.post("/v2/desktop-agent/tool",
                           json={"project_id": PID, "name": name, "args": args, **kw})

    r = call("write_episode_shots", {"episode": 1, "shots": [{"script_ref": "A"},
                                                             {"script_ref": "B"}]})
    assert r.status_code == 200 and r.json()["ok"] is True and r.json()["written"] == 2
    # force=true 走确认门：先 409，带 confirmed 才执行
    r = call("write_episode_shots", {"episode": 1, "force": True, "shots": [{"script_ref": "C"}]})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "needs_confirm"
    r = call("write_episode_shots", {"episode": 1, "force": True, "shots": [{"script_ref": "C"}]},
             confirmed=True)
    assert r.status_code == 200 and r.json()["replaced"] == 2
    assert call("run_reprompt", {}).status_code == 404
    r = call("get_episode_readiness", {"episode": 1})
    assert r.status_code == 200 and [s["order"] for s in r.json()["shots"]] == [1]


def test_check_episodes_progress_counts_only_locked_scripts(proj):
    """「prompts 这一步做完了」= 每一镜都有锁定稿；存量的未锁定机器稿不算。"""
    add_shot(proj, PID, 1, script_ref="A", gen_prompt="锁定稿", prompt_state="manual",
             profile_override=json.dumps({"prompt": "锁定稿"}))
    add_shot(proj, PID, 2, script_ref="B", gen_prompt="旧机器稿", prompt_state="aligned")
    add_shot(proj, PID, 3, script_ref="C")
    out = call_tool("check_episodes_progress", episodes=[1], step="prompts")
    assert out["ok"] is True and out["done"] is False
    assert out["missing_by_episode"] == {"1": {"prompts": [2, 3]}}
