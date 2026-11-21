"""站位图（2026-11-21）：登记 / 绑定 / 解除 / 删除 / 列出，以及它不该碰到的东西。

站位图由客户端 Agent 自己生成、自己决定什么时候做；镜流只登记、绑定到镜头、出片时当参考图带上。
写操作都经 `execute_tool`（与桌面端网关同一条路）。
"""
from __future__ import annotations

import json

import pytest

from conftest import PID, add_asset, add_shot, call_tool, get_shot, make_project, shots_of
from test_no_prompt_writer import _run_videos, models, video  # noqa: F401  （夹具）

IMG = "/fw/media/generated/blocking_ferry.png"
IMG2 = "/fw/media/generated/blocking_ferry_v2.png"


@pytest.fixture()
def proj(db, tools):
    make_project(db)
    return db


def _ov(db, sid) -> dict:
    raw = get_shot(db, sid).profile_override
    return json.loads(raw) if raw else {}


def _episode6(db) -> list[str]:
    """第 6 集五个镜头（全剧镜号 11–15），中间那个停用：本集镜号是 1、2、—、3、4。"""
    ids = [add_shot(db, PID, 10 + i, episode=6, script_ref=f"E6-{i}", location="渡口清晨",
                    disabled=1 if i == 3 else 0) for i in range(1, 6)]
    add_shot(db, PID, 1, episode=1, script_ref="E1-1")
    return ids


def _rows(db):
    from app.db import BlockingImage
    with db() as s:
        return [(r.id, r.name, r.image_url, r.location) for r in s.query(BlockingImage).all()]


# ---------------------------------------------------------------- 登记、绑定、列出

def test_register_binds_by_episode_range_and_reports_scope(proj):
    ids = _episode6(proj)
    loc = add_asset(proj, PID, "location", "渡口清晨", "/fw/media/generated/loc.png")

    out = call_tool("set_blocking_image", image_url=IMG, location="渡口清晨",
                    prompt="全景：林晨在左、沈母在右，面对面。", episode=6, shot_from=2, shot_to=3)
    assert out["ok"] is True and out["created"] is True and out["bound"] == 2
    b = out["blocking_image"]
    assert b["kind"] == "blocking" and b["name"] == "渡口清晨站位图" and b["ref"] == "@渡口清晨站位图"
    assert b["image_url"] == IMG and b["location"] == "渡口清晨" and b["location_id"] == loc
    # 本集镜号 2–3 = 全剧镜号 12 与 14（13 停用，不占本集镜号）
    assert b["shot_ids"] == [ids[1], ids[3]]
    assert [(s["episode"], s["order"], s["no"]) for s in b["shots"]] == [(6, 12, 2), (6, 14, 3)]
    assert b["ranges"] == [{"episode": 6, "from": 2, "to": 3}]
    assert b["scope"] == "渡口清晨 · 第 6 集 2–3 镜"

    # 绑定就是镜头上「用户加的参考图」那三个键；没绑的镜头一个字都没动
    ov = _ov(proj, ids[1])
    assert ov == {"refs": [IMG],
                  "ref_owners": [{"url": IMG, "kind": "blocking", "name": "渡口清晨站位图",
                                  "id": b["id"]}],
                  "ref_labels": {IMG: "站位图「渡口清晨站位图」"}}
    for untouched in (ids[0], ids[2], ids[4]):
        assert get_shot(proj, untouched).profile_override is None

    listed = call_tool("list_blocking_images")
    assert listed["ok"] is True and listed["count"] == 1 and listed["blocking_images"] == [b]
    # list_assets 里按 kind=blocking 一并给出，但它不在资产表里，也不算缺图
    assets = call_tool("list_assets")
    assert [a["kind"] for a in assets["assets"]] == ["location", "blocking"]
    assert assets["assets"][1]["scope"] == "渡口清晨 · 第 6 集 2–3 镜"
    assert assets["assets_missing_image"] == 0
    assert call_tool("list_assets", only_missing_image=True)["assets"] == []
    from app.db import Asset
    with proj() as s:
        assert s.query(Asset).filter(Asset.kind == "blocking").count() == 0


def test_bind_by_ids_and_range_together_and_scope_joins_ranges(proj):
    ids = _episode6(proj)
    first = add_shot(proj, PID, 2, episode=1, script_ref="E1-2")
    made = call_tool("set_blocking_image", image_url=IMG, name="渡口对峙站位", location="渡口清晨")
    assert made["ok"] and made["blocking_image"]["scope"] == "渡口清晨 · 未绑定镜头"

    out = call_tool("bind_blocking_image", name="渡口对峙站位", shot_ids=[first, ids[0]],
                    episode=6, shot_from=4)
    assert out["ok"] and out["bound"] == 3 and out["already_bound"] == 0
    assert out["blocking_image"]["ranges"] == [{"episode": 1, "from": 2, "to": 2},
                                               {"episode": 6, "from": 1, "to": 1},
                                               {"episode": 6, "from": 4, "to": 4}]
    assert out["blocking_image"]["scope"] == "渡口清晨 · 第 1 集 2 镜，第 6 集 1、4 镜"
    # 再绑一次不重复：参考图列表里只有一份
    again = call_tool("bind_blocking_image", name="渡口对峙站位", shot_ids=[first])
    assert again["bound"] == 0 and again["already_bound"] == 1
    assert _ov(proj, first)["refs"] == [IMG]

    # 写死了整份参考图清单的镜头：照绑，但明说它不会生效
    fixed = add_shot(proj, PID, 3, episode=1, script_ref="E1-3",
                     profile_override=json.dumps({"ref_urls": ["/fw/media/uploads/only.png"]}))
    warned = call_tool("bind_blocking_image", name="渡口对峙站位", shot_ids=[fixed, first])
    assert warned["bound"] == 1 and warned["fixed_ref_list_shots"] == [fixed]
    assert "ref_urls" in warned["warning"] and "warning" not in again
    call_tool("unbind_blocking_image", name="渡口对峙站位", shot_ids=[fixed])

    # 停用的镜头也能按 id 绑，只是没有本集镜号、不进范围文字
    off = call_tool("bind_blocking_image", name="渡口对峙站位", shot_ids=[ids[2]])
    assert off["bound"] == 1
    assert {"id": ids[2], "episode": 6, "order": 13, "no": None} in off["blocking_image"]["shots"]
    assert off["blocking_image"]["scope"] == "渡口清晨 · 第 1 集 2 镜，第 6 集 1、4 镜"


def test_bad_input_changes_nothing(proj):
    ids = _episode6(proj)
    add_asset(proj, PID, "character", "林晨")

    def refused(**args):
        out = call_tool("set_blocking_image", **args)
        assert out["ok"] is False, args
        return out["error"]

    assert "image_url" in refused(location="渡口清晨")                           # 新登记没给图
    assert "镜流里的图片地址" in refused(image_url="https://example.com/a.png")
    assert "角色名" in refused(image_url=IMG, name="林晨")                        # 与角色同名
    assert "@" in refused(image_url=IMG, name="@站位")
    assert "不存在" in refused(image_url=IMG, shot_ids=[ids[0], "no-such-shot"])
    assert "没有本集镜号" in refused(image_url=IMG, episode=6, shot_from=9)
    assert "episode" in refused(image_url=IMG, shot_from=2)
    assert _rows(proj) == []                                   # 一张都没登记
    assert all(s.profile_override is None for s in shots_of(proj, PID))

    assert call_tool("set_blocking_image", image_url=IMG, name="甲")["ok"] is True
    assert "已经登记为站位图「甲」" in refused(image_url=IMG, name="乙")           # 同一张图登记两次
    for tool in ("bind_blocking_image", "unbind_blocking_image", "delete_blocking_image"):
        out = call_tool(tool, name="没有这张")
        assert out["ok"] is False and "没有叫「没有这张」的站位图" in out["error"]
    out = call_tool("bind_blocking_image", name="甲")
    assert out["ok"] is False and "指明绑到哪些镜头" in out["error"]
    assert [r[1] for r in _rows(proj)] == ["甲"]


def test_auto_name_avoids_taken_names(proj):
    add_asset(proj, PID, "prop", "天台站位图")
    a = call_tool("set_blocking_image", image_url=IMG, location="天台")
    b = call_tool("set_blocking_image", image_url=IMG2, location="天台")
    c = call_tool("set_blocking_image", image_url="/fw/media/generated/x.png")
    assert [x["blocking_image"]["name"] for x in (a, b, c)] == [
        "天台站位图2", "天台站位图3", "未指定场景站位图"]


# ---------------------------------------------------------------- 更新：换图、改名

def test_new_image_and_new_name_follow_bound_shots_in_place(proj):
    before, after = "/fw/media/uploads/prop_a.png", "/fw/media/uploads/prop_b.png"
    owners = [{"url": before, "kind": "prop", "name": "文件袋"},
              {"url": after, "kind": "prop", "name": "铜铃"}]
    sid = add_shot(proj, PID, 1, script_ref="A", video_url="/fw/media/generated/v.mp4",
                   props=json.dumps(["文件袋", "铜铃"]),
                   profile_override=json.dumps({"prompt": "锁定稿 @天台站位", "refs": [before],
                                                "ref_owners": owners[:1],
                                                "ref_labels": {before: "道具「文件袋」"}}))
    made = call_tool("set_blocking_image", image_url=IMG, name="天台站位", location="天台",
                     shot_ids=[sid])
    bid = made["blocking_image"]["id"]
    with proj() as s:                                   # 站位图后面再加一张手动参考图
        from app.db import Shot
        sh = s.get(Shot, sid)
        ov = json.loads(sh.profile_override)
        ov["refs"].append(after)
        ov["ref_owners"].append(owners[1])
        sh.profile_override = json.dumps(ov, ensure_ascii=False)
        sh.refs_stale = 0
        s.commit()

    out = call_tool("set_blocking_image", blocking_id=bid, image_url=IMG2, name="天台对峙站位")
    assert out["ok"] and out["created"] is False
    assert out["renamed_from"] == "天台站位" and out["image_replaced"] is True
    assert out["shots_updated"] == 1
    assert out["blocking_image"]["shot_ids"] == [sid] and out["blocking_image"]["image_url"] == IMG2
    assert out["blocking_image"]["location"] == "天台"            # 没给的项不动

    ov = _ov(proj, sid)
    assert ov["refs"] == [before, IMG2, after]                    # 原位换掉：后面的图不错位
    assert {"url": IMG2, "kind": "blocking", "name": "天台对峙站位", "id": bid} in ov["ref_owners"]
    assert not any(o["url"] == IMG for o in ov["ref_owners"]) and owners[0] in ov["ref_owners"]
    assert ov["ref_labels"] == {before: "道具「文件袋」", IMG2: "站位图「天台对峙站位」"}
    assert ov["prompt"] == "锁定稿 @天台站位"                      # 锁定的镜头脚本不替调用方改
    assert get_shot(proj, sid).refs_stale == 1                    # 已出过片：标记参考图变了

    # 同名再调 = 更新那一张；只改说明与所属场景，绑定不动
    same = call_tool("set_blocking_image", name="天台对峙站位", location="", prompt="新的说明")
    assert same["created"] is False and "shots_updated" not in same
    assert same["blocking_image"]["location"] is None and same["blocking_image"]["prompt"] == "新的说明"
    assert same["blocking_image"]["scope"] == "第 1 集 1 镜"
    assert len(_rows(proj)) == 1


# ---------------------------------------------------------------- 解除、删除

def test_unbind_some_then_all_then_delete(proj):
    ids = _episode6(proj)
    keep = "/fw/media/uploads/prop.png"
    with proj() as s:
        from app.db import Shot
        s.get(Shot, ids[0]).profile_override = json.dumps(
            {"prompt": "锁定稿", "refs": [keep], "ref_labels": {keep: "道具「铜铃」"},
             "ref_owners": [{"url": keep, "kind": "prop", "name": "铜铃"}]})
        s.commit()
    call_tool("set_blocking_image", image_url=IMG, name="渡口站位", episode=6, shot_from=1, shot_to=4)

    out = call_tool("unbind_blocking_image", name="渡口站位", episode=6, shot_from=3, shot_to=4)
    assert out["ok"] and out["unbound"] == 2 and out["not_bound"] == 0
    assert out["blocking_image"]["scope"] == "第 6 集 1–2 镜"
    assert get_shot(proj, ids[4]).profile_override is None        # 解除后不留空壳
    # 镜头上别的手动参考图与锁定稿原样留着
    assert _ov(proj, ids[0])["refs"] == [keep, IMG]
    one = call_tool("unbind_blocking_image", name="渡口站位", shot_ids=[ids[0], ids[4]])
    assert one["unbound"] == 1 and one["not_bound"] == 1
    assert _ov(proj, ids[0]) == {"prompt": "锁定稿", "refs": [keep],
                                 "ref_labels": {keep: "道具「铜铃」"},
                                 "ref_owners": [{"url": keep, "kind": "prop", "name": "铜铃"}]}

    call_tool("bind_blocking_image", name="渡口站位", shot_ids=[ids[0]])
    everything = call_tool("unbind_blocking_image", name="渡口站位")      # 不给镜头 = 全部解除
    assert everything["unbound"] == 2 and everything["blocking_image"]["shot_ids"] == []
    assert len(_rows(proj)) == 1                                           # 站位图本身还在

    call_tool("bind_blocking_image", name="渡口站位", shot_ids=[ids[0], ids[1]])
    gone = call_tool("delete_blocking_image", name="渡口站位")
    assert gone["ok"] and gone["deleted"] is True and gone["unbound"] == 2
    assert _rows(proj) == [] and call_tool("list_blocking_images")["count"] == 0
    assert _ov(proj, ids[0])["refs"] == [keep] and get_shot(proj, ids[1]).profile_override is None


# ---------------------------------------------------------------- 删镜头、重写整集、删场景

def test_deleting_shots_or_rewriting_an_episode_leaves_no_dangling_binding(proj):
    ids = _episode6(proj)
    call_tool("set_blocking_image", image_url=IMG, name="渡口站位", location="渡口清晨",
              episode=6, shot_from=1, shot_to=4)

    assert call_tool("delete_shots", shot_ids=[ids[1]])["ok"] is True
    b = call_tool("list_blocking_images")["blocking_images"][0]
    assert b["shot_ids"] == [ids[0], ids[3], ids[4]]              # 删掉的那一镜不再出现
    assert b["scope"] == "渡口清晨 · 第 6 集 1–3 镜"               # 镜号收拢后仍连续

    out = call_tool("write_episode_shots", episode=6, force=True,
                    shots=[{"script_ref": "新1"}, {"script_ref": "新2"}])
    assert out["ok"] is True
    b = call_tool("list_blocking_images")["blocking_images"][0]
    assert b["shot_ids"] == [] and b["shots"] == [] and b["scope"] == "渡口清晨 · 未绑定镜头"
    assert len(_rows(proj)) == 1                                  # 站位图留着，可以重新绑


def test_scene_delete_and_rename_keep_the_blocking_image_consistent(proj):
    sid = add_shot(proj, PID, 1, script_ref="A", location="渡口清晨")
    loc = add_asset(proj, PID, "location", "渡口清晨", "/fw/media/generated/loc.png")
    call_tool("set_blocking_image", image_url=IMG, name="渡口站位", location="渡口清晨",
              shot_ids=[sid])

    # 场景改名：站位图记的场景名跟着改
    assert call_tool("rename_asset", asset_id=loc, new_name="渡口晨雾")["ok"] is True
    b = call_tool("list_blocking_images")["blocking_images"][0]
    assert b["location"] == "渡口晨雾" and b["location_id"] == loc
    assert b["scope"] == "渡口晨雾 · 第 1 集 1 镜"

    # 场景资产删除（墓碑）：没有指向已删资产的 id；站位图与它在镜头上的绑定照旧
    assert call_tool("delete_asset", asset_id=loc)["ok"] is True
    b = call_tool("list_blocking_images")["blocking_images"][0]
    assert b["location"] == "渡口晨雾" and b["location_id"] is None and b["shot_ids"] == [sid]
    assert call_tool("restore_asset", asset_id=loc)["ok"] is True
    assert call_tool("list_blocking_images")["blocking_images"][0]["location_id"] == loc


# ---------------------------------------------------------------- 不参与资产的那几套逻辑

def test_asset_tools_do_not_reach_blocking_images(proj):
    add_asset(proj, PID, "location", "渡口")
    add_asset(proj, PID, "location", "渡口清晨")
    made = call_tool("set_blocking_image", image_url=IMG, name="渡口站位", location="渡口清晨")
    bid = made["blocking_image"]["id"]

    for tool, args in (("rename_asset", {"asset_id": bid, "new_name": "改名"}),
                       ("delete_asset", {"asset_id": bid}),
                       ("restore_asset", {"asset_id": bid})):
        out = call_tool(tool, **args)
        assert out["ok"] is False and "资产不存在" in out["error"], tool
    out = call_tool("set_asset_images", items=[{"asset_id": bid, "url": IMG2}])
    assert out["ok"] is False and out["results"][0]["status"] == "unmatched"
    out = call_tool("set_asset_images", items=[{"name": "渡口站位", "url": IMG2}])
    assert out["results"][0]["status"] == "unmatched"

    dup = call_tool("find_duplicate_assets")
    assert "渡口站位" not in json.dumps(dup, ensure_ascii=False)
    compact = call_tool("list_assets", compact=True)
    assert "渡口站位" not in json.dumps(compact, ensure_ascii=False)
    assert _rows(proj) == [(bid, "渡口站位", IMG, "渡口清晨")]


# ---------------------------------------------------------------- 出片：按参考图带上

def test_bound_blocking_image_is_sent_as_a_reference_and_named_in_the_prompt(proj, models, video):
    video.max_reference_images = 9
    char_img = "/fw/media/generated/linchen.png"
    add_asset(proj, PID, "character", "林晨", char_img)
    sid = add_shot(proj, PID, 1, script_ref="A", duration_sec=5.0, characters='["林晨"]',
                   gen_prompt="按 @渡口站位 的站位：@林晨 站在左侧。", prompt_state="manual",
                   profile_override=json.dumps({"prompt": "按 @渡口站位 的站位：@林晨 站在左侧。"}))
    other = add_shot(proj, PID, 2, script_ref="B", duration_sec=5.0, characters='["林晨"]',
                     gen_prompt="@林晨 独自走远。", prompt_state="manual",
                     profile_override=json.dumps({"prompt": "@林晨 独自走远。"}))
    call_tool("set_blocking_image", image_url=IMG, name="渡口站位", shot_ids=[sid])

    job = _run_videos({"shot_ids": [sid, other]})
    assert job.status == "done", job.error
    sent = {tuple(r.reference_image_urls): r.prompt for r in video.requests}
    # 站位图排在自动带上的角色图后面；提示词里的 @名字 转成了对应编号
    assert sent[(char_img, IMG)] == "按 渡口站位@图片2 的站位：林晨@图片1 站在左侧。"
    assert sent[(char_img,)] == "林晨@图片1 独自走远。"            # 没绑的镜头不带它
    assert models.llm == [] and models.image == []

    # 镜头上的标签被别的写入路径丢掉时，名字从站位图表里补回来
    with proj() as s:
        from app.db import Shot
        sh = s.get(Shot, sid)
        ov = json.loads(sh.profile_override)
        ov.pop("ref_labels")
        ov.pop("ref_owners")
        sh.profile_override = json.dumps(ov, ensure_ascii=False)
        s.commit()
    video.requests.clear()
    assert _run_videos({"shot_ids": [sid]}).status == "done"
    assert video.requests[0].prompt == "按 渡口站位@图片2 的站位：林晨@图片1 站在左侧。"


# ---------------------------------------------------------------- 导出、清理、清盘

def test_export_puts_blocking_images_in_their_own_folder(proj, monkeypatch):
    import app.media_cache as media_cache
    from app.asset_export import build_manifest

    add_asset(proj, PID, "location", "渡口清晨", "/fw/media/generated/loc.png")
    call_tool("set_blocking_image", image_url=IMG, name="渡口/站位", location="渡口清晨")
    call_tool("set_blocking_image", image_url="/fw/media/generated/lost.png", name="丢了的")
    sizes = {"generated/loc.png": {"size": 10}, "generated/blocking_ferry.png": {"size": 20}}
    monkeypatch.setattr(media_cache, "meta_of", lambda rels: {r: sizes[r] for r in rels if r in sizes})

    man = build_manifest(PID)
    assert sorted(i["path"] for i in man["items"]) == ["场景/渡口清晨/渡口清晨.png",
                                                       "站位图/渡口_站位.png"]
    assert man["missing"] == [{"kind": "blocking", "name": "丢了的", "why": "图片文件取不到"}]


def test_blocking_image_file_counts_as_referenced_and_goes_with_the_project(proj, monkeypatch):
    from app import media_refs, project_purge
    from app.db import BlockingImage

    # 清盘要查的文件台账表由迁移脚本建，测试库里没有；这里只看库行删没删干净
    monkeypatch.setattr(project_purge, "exclusive_files", lambda session, pid: ([], 0, 0))
    call_tool("set_blocking_image", image_url=IMG, name="渡口站位")       # 没绑任何镜头
    with proj() as s:
        # 清理缓存按这份引用集判断「还有没有人在用」：没绑镜头的站位图也在里面
        assert "blocking_ferry.png" in media_refs.referenced_filenames(s)
        refs = media_refs.find_references(s, IMG)
        assert [(r["type"], r["label"]) for r in refs] == [("blocking_image", "站位图「渡口站位」")]
        assert project_purge._row_counts(s, PID)["blocking_images"] == 1
        project_purge.purge(s, PID)
        assert s.query(BlockingImage).count() == 0


# ---------------------------------------------------------------- 桌面端网关

def test_desktop_gateway_offers_the_blocking_tools(proj):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.routers import desktop_agent

    app = FastAPI()
    app.include_router(desktop_agent.router)
    client = TestClient(app)
    listed = {t["name"]: t for t in client.get("/v2/desktop-agent/tools").json()["tools"]}
    props = lambda n: set(listed[n]["parameters"]["properties"])   # noqa: E731
    where = {"shot_ids", "episode", "shot_from", "shot_to"}
    assert props("set_blocking_image") == {"project_id", "image_url", "name", "location", "prompt",
                                           "blocking_id"} | where
    assert props("bind_blocking_image") == {"project_id", "blocking_id", "name"} | where
    assert props("unbind_blocking_image") == {"project_id", "blocking_id", "name"} | where
    assert props("delete_blocking_image") == {"project_id", "blocking_id", "name"}
    assert props("list_blocking_images") == {"project_id"}
    for name in ("set_blocking_image", "bind_blocking_image", "unbind_blocking_image",
                 "delete_blocking_image", "list_blocking_images"):
        t = listed[name]
        assert t["costs"] is False and t["long_running"] is False and t["needs_confirm"] is False
        assert t["risk"] == ("read" if name == "list_blocking_images" else "write")
        assert t["role"] == ("viewer" if name == "list_blocking_images" else "editor")

    sid = add_shot(proj, PID, 1, script_ref="A")

    def call(name, args):
        return client.post("/v2/desktop-agent/tool",
                           json={"project_id": PID, "name": name, "args": args})

    r = call("set_blocking_image", {"image_url": IMG, "location": "渡口清晨", "shot_ids": [sid]})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert r.json()["blocking_image"]["scope"] == "渡口清晨 · 第 1 集 1 镜"
    r = call("list_blocking_images", {})
    assert r.status_code == 200 and r.json()["count"] == 1
    # 工具级失败也是 200 + ok=false：模型看得到原因
    r = call("bind_blocking_image", {"name": "渡口清晨站位图", "shot_ids": ["nope"]})
    assert r.status_code == 200 and r.json()["ok"] is False and "不存在" in r.json()["error"]
