"""at_refs：手改稿里的引用必须转成官方编号（见模块头的用户甲用例）。

2026-10-27 起两条新口径（生产「巴郎错牵结良缘」三镜换脸）：
  · `@名字` → `名字@图片N`（保留名字，不再只剩编号）；
  · 编辑器显示成引用块的**裸名字**，下发时同样绑成 `名字@图片N`（`bind_bare_names`）。
"""
from app.at_refs import bind_bare_names, drop_dangling_refs, resolve_at_refs

IMGS = ["角色「刘盛」", "场景「公司茶水间拐角」（全景）"]
AUD = ["角色「刘盛」的音色"]


def test_voice_and_image_resolved():
    out, unk = resolve_at_refs('「@刘盛 」说："台词"，音色参考「@刘盛的音色 」', IMGS, AUD)
    assert "音频1" in out and "@刘盛的音色" not in out
    assert "刘盛@图片1" in out and "@刘盛" not in out
    assert unk == []


def test_longest_first_voice_not_split():
    out, _ = resolve_at_refs("@刘盛的音色", IMGS, AUD)
    assert out == "音频1"


def test_idempotent():
    once, _ = resolve_at_refs("@刘盛 与 @刘盛的音色", IMGS, AUD)
    assert resolve_at_refs(once, IMGS, AUD)[0] == once


def test_frame_offset():
    assert resolve_at_refs("@刘盛", IMGS, AUD, image_offset=1)[0] == "刘盛@图片2"


def test_resolve_leaves_bare_names_to_binder():
    s = '刘盛说："我喜欢刘盛的音色"'
    assert resolve_at_refs(s, IMGS, AUD)[0] == s


def test_unknown_kept_and_reported():
    out, unk = resolve_at_refs("@路人甲 走过", IMGS, AUD)
    assert out == "@路人甲 走过" and unk == ["路人甲"]


# ---- bind_bare_names ------------------------------------------------------

#: 生产「巴郎错牵结良缘」用户丁 E11·S045 第 4 版的真实下发顺序
BALANG = ["角色「夏依达」", "角色「古丽娜」", "角色「叶尔赞」", "场景「护林站工坊」"]


def test_every_occurrence_bound_not_just_first():
    s = "叶尔赞大步走进来，侧头看向夏依达。台词（叶尔赞）：你现在像掌柜了。夏依达敲响铜铃。"
    out, bound = bind_bare_names(s, BALANG)
    assert out.count("叶尔赞@图片3") == 2
    assert out.count("夏依达@图片1") == 2
    assert bound == ["叶尔赞", "夏依达"]


def test_dialogue_and_onscreen_text_not_bound():
    # 台词 / 画面文字里的名字是内容不是引用（前端 protectedRanges 同口径）
    s = '夏依达低头。{古丽娜你过来}【古丽娜】“叶尔赞来了”"夏依达"'
    out, _ = bind_bare_names(s, BALANG)
    assert out.startswith("夏依达@图片1低头。")
    assert "{古丽娜你过来}【古丽娜】“叶尔赞来了”\"夏依达\"" in out


def test_already_bound_forms_untouched_and_idempotent():
    s = "夏依达@图片1 走来，@图片2 为古丽娜，@图片3 的叶尔赞，@夏依达"
    out, bound = bind_bare_names(s, BALANG)
    assert out == s and bound == []
    once, _ = bind_bare_names("古丽娜坐下，古丽娜抬头", BALANG)
    assert bind_bare_names(once, BALANG)[0] == once


def test_longest_name_wins():
    out, _ = bind_bare_names("林七雨和林七", ["角色「林七」", "角色「林七雨」"])
    assert out == "林七雨@图片2和林七@图片1"


def test_only_sent_images_and_offset():
    # 达吾提这镜被「不带」了 → 不在清单里 → 不绑（界面上也显示为未带上）
    out, _ = bind_bare_names("达吾提冲进来，夏依达回头", BALANG, image_offset=1)
    assert out == "达吾提冲进来，夏依达@图片2回头"


def test_resolve_then_bind_full_pipeline():
    s = "@夏依达 走到正中央。古丽娜缩在角落。"
    mid, _ = resolve_at_refs(s, BALANG, [])
    out, _ = bind_bare_names(mid, BALANG)
    assert out == "夏依达@图片1 走到正中央。古丽娜@图片2缩在角落。"


# ---- drop_dangling_refs 误删（E12·#74）--------------------------------------

E12 = ["角色「古丽巴哈尔」", "角色「努尔古丽」", "场景「油坊新房」",
       "道具「茶碗」", "道具「热茶」", "道具「新茶参考」"]


def test_unknown_word_before_ref_not_treated_as_missing_person():
    s = "站位图参考@图片6 \n0.00–1.60 秒｜古丽巴哈尔与木门"
    known = {"古丽巴哈尔", "努尔古丽", "油坊新房", "茶碗", "热茶", "新茶参考"}
    out, dropped = drop_dangling_refs(s, E12, image_count=6, known_names=known)
    assert out == s and dropped == []


def test_known_but_unsent_person_still_dropped():
    # 被点名的是项目里真实存在、但这次没送的人 → 照旧剔
    s = "门外，达吾提@图片6 冲了进来"
    known = {"古丽巴哈尔", "达吾提", "新茶参考"}
    out, dropped = drop_dangling_refs(s, E12, image_count=6, known_names=known)
    assert "@图片6" not in out and dropped


def test_single_char_bare_name_not_bound_but_explicit_is():
    labels = ["角色「叶尔赞」", "道具「马」"]
    out, _ = bind_bare_names("叶尔赞牵着马，马蹄声近", labels)
    assert out == "叶尔赞@图片1牵着马，马蹄声近"
    mid, _ = resolve_at_refs("叶尔赞牵着@马 走来", labels, [])
    assert mid == "叶尔赞牵着马@图片2 走来"


def test_longer_unsent_entity_blocks_inner_name():
    # 「陈秀兰家」是本镜没送图的场景：里面的「陈秀兰」不算引用（前端同口径）
    labels = ["角色「陈秀兰」"]
    out, _ = bind_bare_names("陈秀兰家门口，陈秀兰抱着女儿", labels,
                             blockers={"陈秀兰", "陈秀兰家"})
    assert out == "陈秀兰家门口，陈秀兰@图片1抱着女儿"
