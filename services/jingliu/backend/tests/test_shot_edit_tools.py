"""拆解的结构编辑工具（全部不调模型）：整集写入 / 插入 / 改单镜 / 拆 / 并 / 移 / 删。

对应 2026-11-19 的裁定：镜流的 AI 拆解只是可选初稿，Muse 必须能自由改它的结果。
这些测试都经 `execute_tool`（与桌面端网关同一条路），所以同时验证了工具已注册、
参数名与实现对得上。
"""
from __future__ import annotations

import json

import pytest

from conftest import PID, add_shot, call_tool, get_shot, make_project, shots_of


@pytest.fixture()
def proj(db, tools):
    make_project(db)
    return db


def _orders(db, episode=None):
    return [(s.order, s.episode, s.script_ref) for s in shots_of(db, PID, episode)]


# ---------------------------------------------------------------- write_episode_shots

def test_write_episode_shots_creates_rows_assets_and_no_prompt(proj):
    out = call_tool("write_episode_shots", episode=1, shots=[
        {"script_ref": "△林晨推门走进客厅。", "characters": ["林晨"], "location": "夜 内 林家客厅",
         "props": ["文件袋"], "duration_sec": 6, "label": "开场"},
        {"script_ref": "沈母：你还知道回来？", "characters": ["林晨", "沈母", "林晨"],
         "location": "夜 内 林家客厅"},
        {"script_ref": "△林晨转身下楼。", "characters": ["林晨"], "location": "林家楼道",
         "link_to_prev": True},
    ])
    assert out["ok"] is True and out["written"] == 3 and out["replaced"] == 0
    rows = shots_of(proj, PID)
    assert [r.order for r in rows] == [1, 2, 3]
    assert [r.id for r in rows] == [x["shot_id"] for x in out["shots"]]      # 顺序 = 数组顺序
    assert rows[0].script_ref == "△林晨推门走进客厅。" and rows[0].duration_sec == 6.0
    assert rows[0].special_name == "开场"
    assert json.loads(rows[1].characters) == ["林晨", "沈母"]                 # 去重保序
    assert json.loads(rows[0].props) == ["文件袋"]
    # 衔接：没给时同场景名接着演算连续，第一镜算换场；显式给的原样
    assert [r.link_to_prev for r in rows] == ["transition", "continuous", "continuous"]
    # 不写任何镜头脚本，也不标过期
    for r in rows:
        assert r.gen_prompt is None and r.prompt_state is None and r.profile_override is None
        assert r.stale == 0 and r.stale_reason is None
        assert r.is_special == 0 and r.status == "pending"
        assert r.duration_sec and r.duration_sec >= 1.0                      # 没给时长的也估了
    # 资产行与 patch_shot 同一规则：角色按原名，场景/道具按归一名
    created = {(a["kind"], a["name"]) for a in out["assets_created"]}
    assert created == {("character", "林晨"), ("character", "沈母"),
                       ("location", "林家客厅"), ("location", "林家楼道"), ("prop", "文件袋")}


def test_write_episode_shots_replace_keeps_other_episodes_in_order(proj):
    add_shot(proj, PID, 1, episode=1, script_ref="E1-a")
    add_shot(proj, PID, 2, episode=1, script_ref="E1-b",
             profile_override=json.dumps({"prompt": "已锁定的脚本"}))
    keep2 = add_shot(proj, PID, 3, episode=2, script_ref="E2-a")
    keep3 = add_shot(proj, PID, 4, episode=3, script_ref="E3-a")

    out = call_tool("write_episode_shots", episode=1,
                    shots=[{"script_ref": f"新{i}"} for i in range(1, 4)])
    assert out["ok"] and out["written"] == 3 and out["replaced"] == 2
    assert out["scripts_discarded"] == 1           # 被替换掉的锁定脚本要如实报出来
    assert _orders(proj) == [(1, 1, "新1"), (2, 1, "新2"), (3, 1, "新3"),
                             (4, 2, "E2-a"), (5, 3, "E3-a")]
    assert get_shot(proj, keep2).order == 4 and get_shot(proj, keep3).order == 5

    # 还没有镜头的一集：插在集号更小的镜头之后、更大的之前
    out = call_tool("write_episode_shots", episode=3, mode="append",
                    shots=[{"script_ref": "E3-b"}])
    assert out["ok"] and _orders(proj, 3) == [(5, 3, "E3-a"), (6, 3, "E3-b")]
    call_tool("write_episode_shots", episode=2, shots=[{"script_ref": "E2-x"}, {"script_ref": "E2-y"}])
    assert _orders(proj) == [(1, 1, "新1"), (2, 1, "新2"), (3, 1, "新3"),
                             (4, 2, "E2-x"), (5, 2, "E2-y"), (6, 3, "E3-a"), (7, 3, "E3-b")]


def test_write_episode_shots_append_goes_after_episode_tail(proj):
    add_shot(proj, PID, 1, episode=1, script_ref="E1-a", location="客厅")
    add_shot(proj, PID, 2, episode=2, script_ref="E2-a")
    out = call_tool("write_episode_shots", episode=1, mode="append",
                    shots=[{"script_ref": "E1-b", "location": "客厅"}, {"script_ref": "E1-c"}])
    assert out["ok"] and out["replaced"] == 0
    assert _orders(proj) == [(1, 1, "E1-a"), (2, 1, "E1-b"), (3, 1, "E1-c"), (4, 2, "E2-a")]
    rows = shots_of(proj, PID, 1)
    assert rows[1].link_to_prev == "continuous"      # 与本集上一镜同场景
    assert rows[2].link_to_prev == "transition"


def test_write_episode_shots_replace_refuses_when_media_exists_unless_forced(proj):
    add_shot(proj, PID, 1, episode=1, script_ref="旧1")
    with_frame = add_shot(proj, PID, 2, episode=1, script_ref="旧2",
                          first_frame_url="/fw/media/generated/img_a.png")
    with_video = add_shot(proj, PID, 3, episode=1, script_ref="旧3",
                          video_url="/fw/media/generated/v_a.mp4")

    out = call_tool("write_episode_shots", episode=1, shots=[{"script_ref": "新"}])
    assert out["ok"] is False and out["code"] == "episode_has_media"
    assert {x["shot_id"] for x in out["shots_with_media"]} == {with_frame, with_video}
    assert out["media_count"] == 2
    assert [s.script_ref for s in shots_of(proj, PID)] == ["旧1", "旧2", "旧3"]   # 什么都没动

    # append 不受这条限制
    assert call_tool("write_episode_shots", episode=1, mode="append",
                     shots=[{"script_ref": "追加"}])["ok"] is True

    out = call_tool("write_episode_shots", episode=1, force=True, shots=[{"script_ref": "新"}])
    assert out["ok"] is True and out["replaced"] == 4 and out["media_discarded"] == 2
    assert [s.script_ref for s in shots_of(proj, PID)] == ["新"]


def test_write_episode_shots_force_needs_confirm(tools):
    from app.agent import policy

    spec = tools.get_spec("write_episode_shots")
    assert spec.risk == "write" and spec.costs is False and spec.long_running is False
    assert policy.needs_confirm(spec, {"episode": 2, "shots": []}) is False
    assert policy.needs_confirm(spec, {"episode": 2, "shots": [], "force": True}) is True
    assert "第 2 集" in policy.confirm_text(spec, {"episode": 2, "force": True})
    for name in ("delete_shots", "merge_shots"):
        sp = tools.get_spec(name)
        assert sp.risk == "write" and sp.costs is False
        assert policy.needs_confirm(sp, {"shot_ids": ["a"]}) is False
        assert policy.needs_confirm(sp, {"shot_ids": ["a"], "force": True}) is True


def test_write_episode_shots_validates_whole_batch(proj):
    add_shot(proj, PID, 1, episode=1, script_ref="旧")
    out = call_tool("write_episode_shots", episode=1,
                    shots=[{"script_ref": "好的"}, {"script_ref": "  "}, {"characters": ["甲"]}])
    assert out["ok"] is False
    assert [x["index"] for x in out["invalid_items"]] == [2, 3]
    assert [s.script_ref for s in shots_of(proj, PID)] == ["旧"]              # 整批没写

    out = call_tool("write_episode_shots", episode=1,
                    shots=[{"script_ref": f"s{i}"} for i in range(301)])
    assert out["ok"] is False and "300" in out["error"]
    assert call_tool("write_episode_shots", episode=1, shots=[])["ok"] is False
    assert call_tool("write_episode_shots", episode=1, mode="merge",
                     shots=[{"script_ref": "x"}])["ok"] is False
    assert call_tool("write_episode_shots", episode=0, shots=[{"script_ref": "x"}])["ok"] is False


def test_write_episode_shots_moves_anchors_with_their_shots(proj):
    """替换第 1 集（镜头数变了）之后，锚在第 2 集镜头上的字幕仍跟着那一镜走。"""
    from app.db import SubtitleClip
    add_shot(proj, PID, 1, episode=1, script_ref="E1-a")
    e2 = add_shot(proj, PID, 2, episode=2, script_ref="E2-a")
    with proj() as s:
        s.add(SubtitleClip(id="sub1", project_id=PID, text="字幕", start_shot_order=2))
        s.commit()
    call_tool("write_episode_shots", episode=1,
              shots=[{"script_ref": "a"}, {"script_ref": "b"}, {"script_ref": "c"}])
    assert get_shot(proj, e2).order == 4
    with proj() as s:
        assert s.get(SubtitleClip, "sub1").start_shot_order == 4


# ---------------------------------------------------------------- insert_shot

def test_insert_shot_places_after_order_with_fields(proj):
    a = add_shot(proj, PID, 1, episode=1, script_ref="A", location="客厅")
    b = add_shot(proj, PID, 2, episode=1, script_ref="B", location="客厅")
    c = add_shot(proj, PID, 3, episode=2, script_ref="C")

    out = call_tool("insert_shot", after_order=1, script_ref="△沈母端着茶走出来。",
                    characters=["沈母"], location="客厅", props=["茶杯"], label="补拍")
    assert out["ok"] is True and out["order"] == 2 and out["episode"] == 1
    new = get_shot(proj, out["shot_id"])
    assert new.script_ref == "△沈母端着茶走出来。"
    assert json.loads(new.characters) == ["沈母"] and json.loads(new.props) == ["茶杯"]
    assert new.location == "客厅" and new.link_to_prev == "continuous"       # 与上一镜同场景
    assert new.special_name == "补拍" and new.is_special == 0
    assert new.stale == 0 and new.gen_prompt is None and new.profile_override is None
    assert [get_shot(proj, x).order for x in (a, b, c)] == [1, 3, 4]         # 不是落到全剧末尾
    assert {(x["kind"], x["name"]) for x in out["assets_created"]} == {
        ("character", "沈母"), ("location", "客厅"), ("prop", "茶杯")}


def test_insert_shot_honours_episode_and_rejects_mismatch(proj):
    add_shot(proj, PID, 1, episode=1, script_ref="A")
    add_shot(proj, PID, 2, episode=2, script_ref="B")

    # 插成第 2 集的第一镜：位置在第 1 集末尾之后，集号显式给
    out = call_tool("insert_shot", after_order=1, episode=2, script_ref="第二集开场",
                    link_to_prev=False)
    assert out["ok"] and out["order"] == 2 and out["episode"] == 2
    assert get_shot(proj, out["shot_id"]).link_to_prev == "transition"
    assert _orders(proj) == [(1, 1, "A"), (2, 2, "第二集开场"), (3, 2, "B")]

    # 集号与位置对不上：拒绝，什么都不建
    bad = call_tool("insert_shot", after_order=3, episode=1, script_ref="放错地方")
    assert bad["ok"] is False and "集" in bad["error"]
    assert len(shots_of(proj, PID)) == 3

    # 空白镜头仍然可以建（旧用法）：插到最前、默认 5 秒、剧本为空
    blank = call_tool("insert_shot", after_order=0)
    assert blank["ok"] and blank["order"] == 1 and blank["episode"] == 1
    sh = get_shot(proj, blank["shot_id"])
    assert sh.script_ref == "" and sh.duration_sec == 5.0


# ---------------------------------------------------------------- patch_shot

def test_patch_shot_link_to_prev_marks_stale(proj):
    sid = add_shot(proj, PID, 1, script_ref="A", link_to_prev="continuous")
    out = call_tool("patch_shot", shot_id=sid, link_to_prev=False)
    assert out["ok"] and out["changed"] == ["link_to_prev"] and out["stale"] is True
    sh = get_shot(proj, sid)
    assert sh.link_to_prev == "transition" and sh.stale == 1 and sh.stale_reason == "reprompt"
    # 值没变不算改动
    out = call_tool("patch_shot", shot_id=sid, link_to_prev=False)
    assert out["changed"] == [] and out["stale"] is False
    assert call_tool("get_shot", shot_id=sid)["link_to_prev"] is False


# ---------------------------------------------------------------- split_shot(parts)

def test_split_shot_by_script(proj):
    a = add_shot(proj, PID, 1, script_ref="前", location="客厅")
    b = add_shot(proj, PID, 2, script_ref="△林晨进门。\n沈母：回来了？\n△林晨沉默。",
                 location="客厅", characters='["林晨", "沈母"]', props='["茶杯"]',
                 gen_prompt="旧脚本", prompt_state="manual",
                 profile_override=json.dumps({"prompt": "旧脚本", "model_id": "seedance-2.5",
                                              "first_frame_url": "/x.png"}, ensure_ascii=False))
    c = add_shot(proj, PID, 3, episode=2, script_ref="后")

    out = call_tool("split_shot", shot_id=b, parts=[
        {"script_ref": "△林晨进门。", "duration_sec": 4},
        {"script_ref": "沈母：回来了？"},
        {"script_ref": "△林晨沉默。", "duration_sec": 3},
    ])
    assert out["ok"] is True and out["mode"] == "script"
    ids = [x["shot_id"] for x in out["shots"]]
    assert ids[0] == b and [x["new"] for x in out["shots"]] == [False, True, True]
    assert [get_shot(proj, x).order for x in (a, *ids, c)] == [1, 2, 3, 4, 5]

    head = get_shot(proj, b)
    assert head.script_ref == "△林晨进门。" and head.duration_sec == 4.0
    # 原镜头的锁定脚本是针对整段写的 → 标过期，但稿子本身不动
    assert head.stale == 1 and head.stale_reason == "reprompt"
    assert json.loads(head.profile_override)["prompt"] == "旧脚本"
    assert out["stale_shot_ids"] == [b]

    for sid, ref in zip(ids[1:], ["沈母：回来了？", "△林晨沉默。"]):
        sh = get_shot(proj, sid)
        assert sh.script_ref == ref and sh.episode == 1 and sh.location == "客厅"
        assert json.loads(sh.characters) == ["林晨", "沈母"] and json.loads(sh.props) == ["茶杯"]
        assert sh.link_to_prev == "continuous"
        assert sh.stale == 0 and sh.gen_prompt is None and sh.prompt_state is None
        ov = json.loads(sh.profile_override)
        assert ov == {"model_id": "seedance-2.5"}       # 只继承生成参数，不继承脚本与首帧
        assert sh.video_url is None and sh.first_frame_url is None
    assert get_shot(proj, ids[2]).duration_sec == 3.0


def test_split_shot_argument_errors_and_time_mode_still_works(proj):
    sid = add_shot(proj, PID, 1, script_ref="整段", duration_sec=10.0,
                   video_url="/fw/media/generated/v.mp4")
    assert call_tool("split_shot", shot_id=sid)["ok"] is False
    assert call_tool("split_shot", shot_id=sid, at_sec=3,
                     parts=[{"script_ref": "a"}, {"script_ref": "b"}])["ok"] is False
    assert call_tool("split_shot", shot_id=sid, parts=[{"script_ref": "只有一段"}])["ok"] is False
    assert call_tool("split_shot", shot_id=sid,
                     parts=[{"script_ref": "a"}, {"script_ref": ""}])["ok"] is False
    assert len(shots_of(proj, PID)) == 1

    # 原有的按时间切（切已出的片）不受影响
    out = call_tool("split_shot", shot_id=sid, at_sec=4)
    assert out["ok"] is True and out["mode"] == "time"
    head, tail = shots_of(proj, PID)
    assert head.id == sid and head.duration_sec == 4.0 and tail.duration_sec == 6.0
    assert tail.video_url == head.video_url and tail.clip_in_sec == 4.0
    assert tail.script_ref == "整段" and head.stale == 0


# ---------------------------------------------------------------- merge_shots

def test_merge_shots_joins_script_in_order(proj):
    a = add_shot(proj, PID, 1, script_ref="△林晨进门。", location="客厅", duration_sec=4.0,
                 characters='["林晨"]', props='["文件袋"]', gen_prompt="脚本A",
                 prompt_state="manual", profile_override=json.dumps({"prompt": "脚本A"}))
    b = add_shot(proj, PID, 2, script_ref="沈母：回来了？", location="客厅", duration_sec=3.0,
                 characters='["沈母", "林晨"]')
    c = add_shot(proj, PID, 3, script_ref="△林晨沉默。", location="客厅", duration_sec=2.5,
                 props='["茶杯"]')
    d = add_shot(proj, PID, 4, script_ref="后面", location="楼道")

    # 传入顺序是乱的：按镜头顺序接
    out = call_tool("merge_shots", shot_ids=[c, a, b])
    assert out["ok"] is True and out["shot_id"] == a and out["merged"] == 3
    assert {x["shot_id"] for x in out["removed"]} == {b, c}
    head = get_shot(proj, a)
    assert head.script_ref == "△林晨进门。\n沈母：回来了？\n△林晨沉默。"
    assert json.loads(head.characters) == ["林晨", "沈母"]
    assert json.loads(head.props) == ["文件袋", "茶杯"]
    assert head.duration_sec == 9.5 and head.order == 1
    assert head.stale == 1 and head.stale_reason == "reprompt"      # 锁定脚本只对应第一段
    assert get_shot(proj, b) is None and get_shot(proj, c) is None
    assert get_shot(proj, d).order == 2


def test_merge_shots_rejects_non_adjacent_cross_episode_and_media(proj):
    a = add_shot(proj, PID, 1, script_ref="A")
    b = add_shot(proj, PID, 2, script_ref="B")
    c = add_shot(proj, PID, 3, script_ref="C", video_url="/fw/media/generated/v.mp4")
    d = add_shot(proj, PID, 4, episode=2, script_ref="D")

    assert call_tool("merge_shots", shot_ids=[a])["ok"] is False
    assert "相邻" in call_tool("merge_shots", shot_ids=[a, c])["error"]
    assert "集" in call_tool("merge_shots", shot_ids=[c, d])["error"]
    assert call_tool("merge_shots", shot_ids=[a, "nope"])["missing_shot_ids"] == ["nope"]

    out = call_tool("merge_shots", shot_ids=[b, c])          # c 已出片，会被并掉 → 拒绝
    assert out["ok"] is False and out["code"] == "shots_have_media"
    assert [x["shot_id"] for x in out["shots_with_media"]] == [c]
    assert len(shots_of(proj, PID)) == 4

    out = call_tool("merge_shots", shot_ids=[b, c], force=True)
    assert out["ok"] is True and out["media_discarded"] == 1
    assert [s.script_ref for s in shots_of(proj, PID)] == ["A", "B\nC", "D"]


def test_merge_shots_carries_clips_onto_kept_shot(proj):
    from app.db import AudioClip
    a = add_shot(proj, PID, 1, script_ref="A", duration_sec=4.0)
    b = add_shot(proj, PID, 2, script_ref="B", duration_sec=3.0)
    c = add_shot(proj, PID, 3, script_ref="C", duration_sec=5.0)
    with proj() as s:
        s.add(AudioClip(id="ac-b", project_id=PID, start_shot_order=2, start_offset_sec=1.0))
        s.add(AudioClip(id="ac-c", project_id=PID, start_shot_order=3, start_offset_sec=0.5))
        s.commit()
    assert call_tool("merge_shots", shot_ids=[a, b])["ok"] is True
    with proj() as s:
        moved = s.get(AudioClip, "ac-b")
        assert (moved.start_shot_order, moved.start_offset_sec) == (1, 5.0)   # 4s + 原偏移 1s
        assert s.get(AudioClip, "ac-c").start_shot_order == 2                  # 跟着镜头 c 前移
    assert get_shot(proj, c).order == 2


# ---------------------------------------------------------------- move_shot

def test_move_shot_reorders_and_follows_episode(proj):
    a = add_shot(proj, PID, 1, episode=1, script_ref="A")
    b = add_shot(proj, PID, 2, episode=1, script_ref="B")
    c = add_shot(proj, PID, 3, episode=1, script_ref="C")
    d = add_shot(proj, PID, 4, episode=2, script_ref="D")

    out = call_tool("move_shot", shot_id=a, after_order=3)       # A 放到 C 之后
    assert out["ok"] and out["order"] == 3 and out["previous_order"] == 1 and out["episode"] == 1
    assert _orders(proj) == [(1, 1, "B"), (2, 1, "C"), (3, 1, "A"), (4, 2, "D")]

    out = call_tool("move_shot", shot_id=a, after_order=0)       # 挪到最前
    assert out["ok"] and out["order"] == 1
    assert [s.script_ref for s in shots_of(proj, PID)] == ["A", "B", "C", "D"]

    out = call_tool("move_shot", shot_id=c, after_order=4)       # 挪到第 2 集镜头之后 → 归入第 2 集
    assert out["ok"] and out["episode"] == 2 and out["previous_episode"] == 1
    assert _orders(proj) == [(1, 1, "A"), (2, 1, "B"), (3, 2, "D"), (4, 2, "C")]

    out = call_tool("move_shot", shot_id=c, after_order=2, episode=2)   # 放成第 2 集第一镜
    assert out["ok"] and out["order"] == 3 and out["episode"] == 2
    assert _orders(proj) == [(1, 1, "A"), (2, 1, "B"), (3, 2, "C"), (4, 2, "D")]

    assert call_tool("move_shot", shot_id=c, after_order=3)["ok"] is False      # 自己之后
    assert call_tool("move_shot", shot_id=c, after_order=99)["ok"] is False     # 没有这个镜号
    assert call_tool("move_shot", shot_id=d, after_order=1, episode=3)["ok"] is False
    for sid in (a, b, c, d):
        assert get_shot(proj, sid).stale == 0                    # 纯调序不标过期


# ---------------------------------------------------------------- delete_shots

def test_delete_shots_renumbers_and_guards_media(proj):
    a = add_shot(proj, PID, 1, script_ref="A")
    b = add_shot(proj, PID, 2, script_ref="B")
    c = add_shot(proj, PID, 3, script_ref="C", first_frame_url="/fw/media/generated/f.png")
    d = add_shot(proj, PID, 4, script_ref="D")

    out = call_tool("delete_shots", shot_ids=[b, "nope"])
    assert out["ok"] is False and out["missing_shot_ids"] == ["nope"]
    assert len(shots_of(proj, PID)) == 4                          # 有一个不存在就整批不删

    out = call_tool("delete_shots", shot_ids=[b, c])
    assert out["ok"] is False and out["code"] == "shots_have_media"
    assert [x["shot_id"] for x in out["shots_with_media"]] == [c]
    assert len(shots_of(proj, PID)) == 4

    out = call_tool("delete_shots", shot_ids=[b])
    assert out["ok"] is True and out["deleted"] == 1 and out["remaining"] == 3
    assert [(s.id, s.order) for s in shots_of(proj, PID)] == [(a, 1), (c, 2), (d, 3)]

    out = call_tool("delete_shots", shot_ids=[c], force=True)
    assert out["ok"] is True and out["media_discarded"] == 1
    assert [(s.id, s.order) for s in shots_of(proj, PID)] == [(a, 1), (d, 2)]


def test_edit_tools_refuse_other_projects_shots(proj):
    make_project(proj, "other-proj")
    foreign = add_shot(proj, "other-proj", 1, script_ref="别人的")
    mine = add_shot(proj, PID, 1, script_ref="我的")
    assert call_tool("delete_shots", shot_ids=[foreign])["ok"] is False
    assert call_tool("merge_shots", shot_ids=[mine, foreign])["ok"] is False
    assert call_tool("move_shot", shot_id=foreign, after_order=0)["ok"] is False
    assert call_tool("split_shot", shot_id=foreign,
                     parts=[{"script_ref": "a"}, {"script_ref": "b"}])["ok"] is False
    assert get_shot(proj, foreign).script_ref == "别人的"


def test_bad_arguments_come_back_as_tool_errors_not_crashes(proj):
    """桌面端网关不做 schema 校验，原始 JSON 直接进工具：类型不对要回一句人话，而不是抛异常。"""
    sid = add_shot(proj, PID, 1, script_ref="A")
    for out in (
        call_tool("insert_shot", after_order=1, script_ref="x", duration_sec="很长"),
        call_tool("insert_shot", after_order="第一镜"),
        call_tool("patch_shot", shot_id=sid, link_to_prev="也许"),
        call_tool("write_episode_shots", episode="一", shots=[{"script_ref": "x"}]),
        call_tool("write_episode_shots", episode=1,
                  shots=[{"script_ref": "x", "duration_sec": "abc"}]),
        call_tool("write_episode_shots", episode=1,
                  shots=[{"script_ref": "x", "link_to_prev": "maybe"}]),
        call_tool("delete_shots", shot_ids=[]),
        call_tool("merge_shots", shot_ids="not-a-list"),
        call_tool("split_shot", shot_id=sid, parts="not-a-list"),
        call_tool("move_shot", shot_id=sid, after_order="x"),
    ):
        assert out["ok"] is False and out["error"] and "工具执行失败" not in out["error"], out
    assert [s.script_ref for s in shots_of(proj, PID)] == ["A"]
    # 网页侧的两个字符串取值也认（照着别处的返回值原样传回来时不该被拒）
    assert call_tool("patch_shot", shot_id=sid, link_to_prev="transition")["changed"] == [
        "link_to_prev"]


def test_string_false_does_not_force_destructive_edits(proj):
    """`bool("false")` 是 True：危险开关必须严格解读，否则一个写成字符串的 false 会删掉已出的片。"""
    from app.agent import policy, registry

    a = add_shot(proj, PID, 1, script_ref="A", video_url="/fw/media/generated/v.mp4")
    add_asset_free = add_shot(proj, PID, 2, script_ref="B", location="没图的场景")
    assert call_tool("delete_shots", shot_ids=[a], force="false")["code"] == "shots_have_media"
    assert call_tool("write_episode_shots", episode=1, force="false",
                     shots=[{"script_ref": "x"}])["code"] == "episode_has_media"
    assert get_shot(proj, a) is not None
    assert policy.needs_confirm(registry.get_spec("delete_shots"),
                                {"shot_ids": [a], "force": "false"}) is False
    assert policy.needs_confirm(registry.get_spec("delete_shots"),
                                {"shot_ids": [a], "force": "true"}) is True
    out = call_tool("set_shot_prompt", shot_id=add_asset_free, prompt="脚本", lock=True,
                    allow_missing_scene_assets="false")
    assert out["ok"] is False and out["code"] == "scene_assets_missing"
