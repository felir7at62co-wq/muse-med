"""字幕工作流（2026-11-21）：镜头原声转写 → 用剧本台词逐字纠正 → 切条写进字幕轨。

用户的设想：「录音文件转写然后通过原剧本字进行纠正……落地成字幕工作流」。
识别通道、取音轨、下载素材都打了桩；任何一次真实的网络调用都会让测试失败。
"""
from __future__ import annotations

import json
import logging
import os

import httpx
import pytest

from conftest import PID, add_asset, add_shot, call_tool, make_project, run


# ---------------------------------------------------------------- 逐字纠正（纯函数）

def _fix(texts, lines, names=()):
    from app.subtitle_align import correct_segments
    segs = [{"start": float(i), "end": float(i) + 1.0, "text": t} for i, t in enumerate(texts)]
    out, st = correct_segments(segs, lines, names)
    return [s["text"] for s in out], st


def test_misheard_names_and_homophones_take_the_script_characters():
    texts, st = _fix(["林辰，你终于回来了！"], ["你终于回来了！"])     # 剧本里没有名字：多出来的保留
    assert texts == ["林辰，你终于回来了！"] and st["extra"] == 2 and st["fixed"] == 0

    texts, st = _fix(["林辰，你终于回来了！", "妈说林辰在等审木"],
                     ["林晨，你终于回来了！", "妈说林晨在等沈母。"], names=["林晨", "沈母"])
    assert texts == ["林晨，你终于回来了！", "妈说林晨在等沈母"]        # 标点、断句照识别结果
    assert st["fixed"] == 4 and st["similarity"] == 0.75 and not st["deviated"]   # 改过的字不算对上
    assert st["fixes"] == [{"heard": "辰", "script": "晨"}, {"heard": "辰", "script": "晨"},
                           {"heard": "审木", "script": "沈母"}]
    assert st["differs"] == []


@pytest.mark.parametrize("heard, line, want", [
    ("林辰你回来了", "林晨你回来了", "林晨你回来了"),       # 同音同调
    ("她说他在家里等", "她说她在家里等", "她说她在家里等"),
    ("慢慢的走", "慢慢地走", "慢慢地走"),                   # 轻声助词
    ("他跑的很快", "他跑得很快", "他跑得很快"),
    ("祝你生日快了", "祝你生日快乐", "祝你生日快乐"),
])
def test_same_sounds_take_the_script_characters(heard, line, want):
    texts, st = _fix([heard], [line])
    assert texts == [want] and st["differs"] == [] and len(st["fixes"]) == 1


@pytest.mark.parametrize("heard, line, got, want", [
    ("我全不要了", "我全部要了", "不", "部"),                 # 「不」的声调随后一个字变：bu2 对 bu4
    ("我全部要了", "我全不要了", "部", "不"),
    ("他们不对啊", "他们部队啊", "不对", "部队"),
    ("他们部队啊", "他们不对啊", "部队", "不对"),
    ("这不行啊", "这步行啊", "不", "步"),                     # 读音相同（都是 bu4），否定的字不同
    ("我布要走", "我不要走", "布", "不"),
    ("他们长得一样啊", "他们长得异样啊", "一", "异"),         # 「一」的声调也靠不住
    ("这是你吗", "这是你妈", "吗", "妈"),                     # 轻声：问句还是陈述
    ("这是你妈", "这是你吗", "妈", "吗"),
    ("妈吗你来了", "妈妈你来了", "吗", "妈"),                 # 两边都读 ma 也不改
])
def test_a_negation_or_an_unreliable_tone_is_kept_as_heard_and_listed(heard, line, got, want):
    texts, st = _fix([heard], [line])
    assert texts == [heard] and st["fixes"] == [] and st["differs"] == []
    assert st["doubts"] == [{"heard": got, "script": want}]


def test_a_name_that_reads_like_a_negation_is_kept_as_heard_and_listed():
    texts, st = _fix(["没姐你来了"], ["梅姐你来了"], names=["梅姐"])
    assert texts == ["没姐你来了"] and st["fixes"] == []
    assert st["doubts"] == [{"heard": "没", "script": "梅"}]


@pytest.mark.parametrize("heard, line, got, want, name", [
    ("我要买房子", "我要卖房子", "买", "卖", None),
    ("我想他了", "我像他了", "想", "像", None),
    ("他有来了", "他又来了", "有", "又", None),               # 「有」的又读 you4 不算
    ("妈，长姐来了", "妈，张姐来了", "长", "张", "张姐"),
    ("妈说林晨在等审木", "妈说林晨在等沈母", "审木", "沈母", "沈母"),
])
def test_a_tone_only_difference_is_kept_as_heard_unless_the_script_has_a_name_there(
        heard, line, got, want, name):
    texts, st = _fix([heard], [line])
    assert texts == [heard] and st["fixes"] == []
    assert st["differs"] == [{"heard": got, "script": want}]
    if name:
        texts, st = _fix([heard], [line], names=[name])
        assert texts == [line] and st["fixes"] == [{"heard": got, "script": want}]


@pytest.mark.parametrize("heard, line, got, want, times", [
    ("你买不买", "你卖不卖", "买", "卖", 2),                  # 每个「买」旁边只有一个对得上的字
    ("你到底买不买啊", "你到底卖不卖啊", "买", "卖", 2),
    ("他说买就买", "他说卖就卖", "买", "卖", 2),
    ("我想你想得要命", "我像你像得要命", "想", "像", 2),
    ("你买", "你卖", "买", "卖", 1),                           # 很短的一镜
    ("我没你没", "我美你美", "没", "美", 2),                   # 含否定的字
])
def test_a_tone_only_difference_is_listed_wherever_it_is(heard, line, got, want, times):
    texts, st = _fix([heard], [line])
    assert texts == [heard] and st["fixes"] == [] and st["doubts"] == []
    assert st["differs"] == [{"heard": got, "script": want}] * times


def test_a_same_sound_without_matched_characters_beside_it_is_kept_and_listed():
    texts, st = _fix(["林辰林辰"], ["林晨林晨"], names=["林晨"])
    assert texts == ["林辰林辰"] and st["fixes"] == [] and st["differs"] == []
    assert st["doubts"] == [{"heard": "辰", "script": "晨"}] * 2
    _texts, st = _fix(["好啊好啊"], ["好吧好吧"])                # 读音不同、旁边对得上的字也不够：只计字数
    assert (st["differs"], st["doubts"], st["kept"]) == ([], [], 2)


@pytest.mark.parametrize("heard, line, got, want", [
    ("我不想去", "我很想去", "不", "很"),
    ("他不是坏人", "他就是坏人", "不", "就"),
    ("好的走吧", "是的走吧", "好", "是"),
    ("嗯，什么事", "林晨，什么事", "嗯", "林晨"),
    ("你好啊", "你好吗", "啊", "吗"),
    ("他说年薪518万是真的", "他说年薪三百一十八万是真的", "518", "三百一十八"),
])
def test_a_mismatch_that_reads_differently_is_left_as_heard_and_listed(heard, line, got, want):
    # 读音不同就不是听错，是念了别的字：按剧本改会把意思改反
    texts, st = _fix([heard], [line], names=["林晨"])
    assert texts == [heard]
    assert st["fixed"] == 0 and st["fixes"] == [] and not st["deviated"]
    assert st["differs"] == [{"heard": got, "script": want}]


def test_numbers_follow_the_script_spelling():
    texts, st = _fix(["年薪318万"], ["年薪三百一十八万"])
    assert texts == ["年薪三百一十八万"] and st["fixed"] == 5
    assert st["similarity"] == 1.0                          # 同一个数换了写法，算对上
    assert st["fixes"] == [{"heard": "318", "script": "三百一十八"}]
    assert _fix(["2026年我们结婚"], ["二零二六年我们结婚"])[0] == ["二零二六年我们结婚"]   # 逐位念
    assert _fix(["我们2个人"], ["我们两个人"])[0] == ["我们两个人"]
    assert _fix(["存了100050元"], ["存了十万零五十元"])[0] == ["存了十万零五十元"]


def test_a_number_split_across_segments_is_corrected_in_the_first_one():
    texts, st = _fix(["年薪3", "18万是真的"], ["年薪三百一十八万是真的"])
    assert texts == ["年薪三百一十八", "万是真的"]
    assert (st["similarity"], st["fixed"], st["kept"], st["unspoken"]) == (1.0, 5, 0, 0)


@pytest.mark.parametrize("n, spoken", [(0, "零"), (10, "十"), (15, "十五"), (110, "一百一十"), (1005, "一千零五"),
                                       (3_180_000, "三百一十八万"), (100_050, "十万零五十"),
                                       (100_010_000, "一亿零一万")])
def test_arabic_numbers_are_compared_by_their_chinese_reading(n, spoken):
    from app.subtitle_align import _cardinal
    assert _cardinal(n) == spoken


def test_mismatches_at_a_shot_edge_take_the_script_with_matched_context_on_the_other_side():
    texts, st = _fix(["临辰你终于回来了"], ["林晨，你终于回来了"])
    assert texts == ["林晨你终于回来了"] and st["fixed"] == 2
    texts, st = _fix(["你终于回来了，林辰"], ["你终于回来了，林晨"])
    assert texts == ["你终于回来了，林晨"] and st["fixed"] == 1
    texts, st = _fix(["你好临辰"], ["你好林辰"])            # 一边两个字，另一边一个字连到结尾
    assert texts == ["你好林辰"] and st["fixed"] == 1 and st["similarity"] == 0.75


@pytest.mark.parametrize("heard, line", [("好", "走"), ("好的", "走吧"), ("嗯，什么", "你说谎"),
                                         ("我不去", "快走吧")])
def test_a_short_shot_with_no_matching_character_is_left_as_heard_and_deviates(heard, line):
    texts, st = _fix([heard], [line])
    assert texts == [heard]
    assert st["fixed"] == 0 and st["similarity"] == 0 and st["deviated"] is True


@pytest.mark.parametrize("heard, line, doubts", [
    ("林辰", "林晨", [{"heard": "辰", "script": "晨"}]),     # 很短的一镜：交给人看
    ("林辰来", "林晨来", [{"heard": "辰", "script": "晨"}]),
    ("嗯好的", "嗯走吧", []),                                 # 差得多：整镜已经列出
    ("好的吧", "走吧", []),
    ("1000万", "一千万", []),
])
def test_a_mismatch_with_one_matched_character_beside_it_is_left_as_heard(heard, line, doubts):
    texts, st = _fix([heard], [line])
    assert texts == [heard]
    assert st["fixed"] == 0 and st["kept"] > 0 and st["unspoken"] > 0
    assert st["differs"] == [] and st["doubts"] == doubts


@pytest.mark.parametrize("heard, line, doubt", [
    ("他是坏人", "他不是坏人", {"heard": "", "script": "不"}),      # 少念
    ("我想去", "我不想去", {"heard": "", "script": "不"}),
    ("我们不能分开", "我们能分开", {"heard": "不", "script": ""}),  # 多念
    ("你别走", "你走", {"heard": "别", "script": ""}),
    ("你走吧，我不怪你", "你走吧，我怪你", {"heard": "不", "script": ""}),
    ("不好", "很好", {"heard": "不", "script": "很"}),              # 两个字：夹不进对得上的字中间
    ("你别", "你走", {"heard": "别", "script": "走"}),
])
def test_an_added_or_dropped_negation_is_kept_as_heard_and_listed(heard, line, doubt):
    # 相似度很高、意思却反了：识别漏了「不」，或者模型把台词念反了
    texts, st = _fix([heard], [line])
    assert texts == [heard] and st["fixes"] == [] and st["differs"] == [] and not st["deviated"]
    assert st["doubts"] == [doubt]


def test_unspoken_lines_are_not_added_and_ad_libs_are_kept():
    texts, st = _fix(["你终于回来了啊"], ["你终于回来了", "我等了你整整三年"])
    assert texts == ["你终于回来了啊"]
    assert st["kept"] == 1 and st["unspoken"] == 8 and st["fixed"] == 0 and st["doubts"] == []
    texts, st = _fix(["你终于回来了呀，快坐"], ["你终于回来了，快坐"])
    assert texts == ["你终于回来了呀，快坐"] and st["extra"] == 1 and st["doubts"] == []


def test_a_shot_that_says_something_else_is_left_alone():
    texts, st = _fix(["今天天气不错我们出去走走"], ["你终于回来了"])
    assert texts == ["今天天气不错我们出去走走"]
    assert st["deviated"] is True and st["similarity"] < 0.5 and st["fixed"] == 0
    # 多念的字在整镜没改时也记作多念
    texts, st = _fix(["我们今天下午一起出去走走吧好不好"], ["我们走吧"])
    assert st["deviated"] is True and (st["kept"], st["extra"], st["unspoken"]) == (0, 12, 0)


def test_nothing_heard_and_no_script_are_reported_one_way():
    for texts in ([], ["。"]):
        _out, st = _fix(texts, ["你终于回来了"])
        assert (st["similarity"], st["unheard"], st["deviated"], st["unspoken"]) == (0.0, True, False, 6)
    _out, st = _fix(["。"], [])
    assert st["no_script"] is False and st["similarity"] is None


def test_long_mismatches_are_kept_and_no_script_is_reported():
    # 对不上的字一处挨一处：是模型换了说法，不是听错，保留念出来的
    texts, st = _fix(["他说的那件事其实根本就不是真的"], ["他说的那件事其实我早就知道真的"])
    assert texts == ["他说的那件事其实根本就不是真的"]
    assert st["kept"] == 4 and st["unspoken"] == 4 and st["fixed"] == 0
    texts, st = _fix(["有人在说话"], [])
    assert texts == ["有人在说话"] and st["no_script"] is True


def test_fixes_can_cross_segment_boundaries_and_drop_stale_word_timings():
    from app.subtitle_align import correct_segments
    segs = [{"start": 0.0, "end": 1.0, "text": "你好林",
             "words": [{"start": 0.0, "end": 0.3, "text": "你"}]},
            {"start": 1.0, "end": 2.0, "text": "辰同学", "words": [{"start": 1.0, "end": 1.2, "text": "辰"}]},
            {"start": 2.0, "end": 3.0, "text": "再见", "words": [{"start": 2.0, "end": 2.4, "text": "再"}]}]
    out, st = correct_segments(segs, ["你好林晨同学，再见"])
    assert [s["text"] for s in out] == ["你好林", "晨同学", "再见"]
    assert [s["start"] for s in out] == [0.0, 1.0, 2.0]                  # 时间一律不动
    assert "words" not in out[1] and "words" in out[0] and "words" in out[2]
    assert st["fixed"] == 1


# ---------------------------------------------------------------- 火山极速版通道

@pytest.fixture()
def volc_cfg(monkeypatch):
    """配好火山极速版；音频时长按文件内容给（默认 1 秒）。"""
    from app import drama_asr, media
    cfg = {"engine": "volc", "appId": "app", "accessToken": "tok", "maxAudioBytes": 1000, "timeoutMs": 1000,
           "maxDurationSeconds": 60, "routes": {"subtitles": "flash", "screenplay": "standard-v2"}}
    monkeypatch.setattr(drama_asr, "load_config", lambda: cfg)
    seconds = {b"long": 61.0, b"unreadable": 0.0}

    async def probe(path):
        return seconds.get(path.read_bytes(), 1.0)

    monkeypatch.setattr(media, "_probe_duration", probe)
    return cfg


@pytest.fixture()
def volc(volc_cfg, monkeypatch):
    from app import drama_asr
    calls = []

    def flash(c, job_id, audio):
        calls.append(audio)
        if audio == b"silent":
            return {"status": "silent"}
        if audio == b"broken":
            raise drama_asr.ProviderError("flash", "timeout")
        return {"status": "complete", "segments": [
            {"start": 0.2, "end": 1.4, "text": "林辰你回来了",
             "words": [{"start": 0.2, "end": 0.5, "text": "林"}]}]}

    monkeypatch.setattr(drama_asr, "_flash", flash)
    return calls


def test_volc_flash_is_picked_first_and_parses_segments(volc, tmp_path):
    from app.providers.asr import pick_asr_provider
    provider = pick_asr_provider()
    assert provider.name == "volc-flash" and provider.available
    audio = tmp_path / "a.mp3"
    audio.write_bytes(b"voice")
    segs = run(provider.transcribe(audio))
    assert segs == [{"start": 0.2, "end": 1.4, "text": "林辰你回来了",
                     "words": [{"start": 0.2, "end": 0.5, "text": "林"}]}]
    audio.write_bytes(b"silent")
    assert run(provider.transcribe(audio)) == []
    audio.write_bytes(b"broken")
    with pytest.raises(RuntimeError) as err:
        run(provider.transcribe(audio))
    assert str(err.value) == "火山语音识别失败（flash timeout）"
    assert len(volc) == 3
    for body, message in ((b"x" * 2000, "单次上限"), (b"long", "单段时长上限 60 秒"), (b"unreadable", "读不出音频时长")):
        audio.write_bytes(body)
        with pytest.raises(RuntimeError, match=message):
            run(provider.transcribe(audio))
    assert len(volc) == 3                                   # 超限、量不出时长的都没有发出去


def _volc_reply(monkeypatch, body: dict) -> None:
    """让真的 `drama_asr._flash` 收到这样一个火山应答（状态码 20000000）。"""
    from app import drama_asr
    reply = httpx.Response(200, headers={"X-Api-Status-Code": "20000000"}, json=body)
    monkeypatch.setattr(drama_asr.httpx, "post", lambda *a, **kw: reply)


@pytest.mark.parametrize("utterances", [[], [{"start_time": 0, "end_time": 900, "text": " "}]])
def test_a_volc_result_without_speech_is_an_empty_result(volc_cfg, monkeypatch, tmp_path, utterances):
    from app.providers.asr_volc import VolcFlashASR
    _volc_reply(monkeypatch, {"result": {"utterances": utterances}})
    audio = tmp_path / "a.mp3"
    audio.write_bytes(b"ambient")
    assert run(VolcFlashASR().transcribe(audio)) == []
    _volc_reply(monkeypatch, {"result": {"utterances": [{"start_time": 900, "end_time": 100, "text": "坏"}]}})
    with pytest.raises(RuntimeError, match="火山语音识别失败（flash result，"):
        run(VolcFlashASR().transcribe(audio))


def test_without_volc_config_the_old_order_stands(monkeypatch, settings_env):
    from app import drama_asr
    from app.providers.asr import pick_asr_provider
    monkeypatch.setattr(drama_asr, "load_config", lambda: None)
    assert pick_asr_provider() is None                      # 测试环境没有百炼、whisper 的 key
    settings_env(FW_BAILIAN_API_KEY="test-key")
    assert pick_asr_provider().name == "bailian-paraformer"


@pytest.fixture()
def settings_env(monkeypatch):
    """设环境变量并让 `get_settings` 重读；测试结束后恢复。"""
    from app import config

    def set_env(**env):
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        config.get_settings.cache_clear()
    yield set_env
    monkeypatch.undo()
    config.get_settings.cache_clear()


def test_volc_wins_when_bailian_is_also_configured(volc, settings_env):
    from app.providers.asr import pick_asr_provider
    settings_env(FW_BAILIAN_API_KEY="test-key")
    assert pick_asr_provider().name == "volc-flash"


def test_a_subtitle_route_other_than_flash_turns_only_the_volc_channel_off(volc_cfg, settings_env):
    from app.providers.asr import pick_asr_provider
    from app.providers.asr_volc import VolcFlashASR
    volc_cfg["routes"] = {"subtitles": "standard-v2", "screenplay": "standard-v2"}
    volc = VolcFlashASR()
    assert not volc.available and "routes.subtitles 不是 flash" in volc.config_error
    assert pick_asr_provider() is None
    settings_env(FW_BAILIAN_API_KEY="test-key")
    assert pick_asr_provider().name == "bailian-paraformer"


@pytest.mark.parametrize("body, kind", [
    ('{"appId": "a", "accessToken": "t", "maxAudioBytes": null}', "TypeError"),
    ('{"appId": "a", "accessToken": "t", "routes": ["flash"]}', "TypeError"),
    ('{"appId": "a", "accessToken": "t", "routes": {"subtitles": ["flash"]}}', "TypeError"),
    ('{"appId": "a", "accessToken": "t", "timeoutMs": {"x": 1}}', "TypeError"),
    ('{"appId": "a", "accessToken": "t", "maxAudioBytes": "abc"}', "ValueError"),
    ('{not json', "JSONDecodeError"),
    ('["a"]', "ValueError"),
    (None, "文件不存在"),
])
def test_a_broken_volc_config_is_reported_and_leaves_the_other_channels_working(
        settings_env, tmp_path, caplog, body, kind):
    from app.providers.asr import pick_asr_provider
    from app.providers.asr_volc import VolcFlashASR
    from app.routers.voice import asr_status
    path = tmp_path / "asr.json"
    if body is not None:
        path.write_text(body, "utf-8")
    settings_env(FW_DRAMA_ASR_CONFIG=str(path), FW_BAILIAN_API_KEY="test-key")
    caplog.set_level(logging.WARNING, logger="app.providers.asr_volc")

    assert pick_asr_provider().name == "bailian-paraformer"
    volc = VolcFlashASR()
    assert not volc.available and kind in volc.config_error
    status = asr_status()
    assert status["provider"] == "bailian-paraformer" and status["volc_configured"] is False
    assert status["volc_config_error"] == volc.config_error
    warned = [r.getMessage() for r in caplog.records if r.name == "app.providers.asr_volc"]
    assert len(warned) == 1 and str(path) in warned[0] and kind in warned[0]   # 读了三次，只记一次
    assert "test-key" not in caplog.text and "accessToken" not in caplog.text


@pytest.mark.skipif(os.geteuid() == 0, reason="root 不受目录权限限制")
def test_a_volc_config_in_a_directory_jingliu_may_not_enter_turns_only_the_volc_channel_off(
        settings_env, tmp_path):
    from app.providers.asr import pick_asr_provider
    from app.providers.asr_volc import VolcFlashASR
    from app.routers.voice import asr_status
    locked = tmp_path / "locked"
    locked.mkdir()
    (locked / "asr.json").write_text('{"appId": "a", "accessToken": "t"}', "utf-8")
    settings_env(FW_DRAMA_ASR_CONFIG=str(locked / "asr.json"), FW_BAILIAN_API_KEY="test-key")
    locked.chmod(0)
    try:
        volc = VolcFlashASR()
        assert not volc.available and "PermissionError" in volc.config_error
        assert pick_asr_provider().name == "bailian-paraformer"
        assert asr_status()["volc_config_error"] == volc.config_error
    finally:
        locked.chmod(0o700)


def test_without_any_channel_the_job_names_the_broken_volc_config(db, settings_env, tmp_path):
    path = tmp_path / "asr.json"
    path.write_text('{"appId": "a", "accessToken": "t", "maxAudioBytes": null}', "utf-8")
    settings_env(FW_DRAMA_ASR_CONFIG=str(path))
    job = _run_job({})
    assert job.status == "failed"
    assert "TypeError" in job.error and "FW_BAILIAN_API_KEY" in job.error


# ---------------------------------------------------------------- 整个任务

@pytest.fixture()
def drama(db, tools, tmp_path, monkeypatch):
    """一部真人剧：两集，每镜一条视频；识别结果按视频地址给（None = 视频没有音轨）。"""
    import app.media as media
    import app.providers.asr as asr_mod
    import app.subtitle_jobs as subtitle_jobs

    make_project(db, production_mode="drama")
    heard = {}

    class FakeASR:
        name = "fake"

        async def transcribe(self, path, language=None, prompt=None):
            return [dict(s) for s in heard[path.name]]

    async def local(url):
        if not url:
            return None
        f = tmp_path / url.rsplit("/", 1)[-1]
        f.write_bytes(b"video")
        return f

    async def extract(path):
        if heard["audio-" + path.name] is None:
            return None
        out = tmp_path / ("audio-" + path.name)
        out.write_bytes(b"audio")
        return out

    monkeypatch.setattr(asr_mod, "pick_asr_provider", lambda: FakeASR())
    monkeypatch.setattr(media, "ensure_local_async", local)
    monkeypatch.setattr(subtitle_jobs, "_extract_asr_audio", extract)

    def shot(order, episode, script, segments, video_url=None):
        name = f"v{order}.mp4"
        heard["audio-" + name] = segments
        heard[name] = segments
        return add_shot(db, PID, order, episode=episode, script_ref=script,
                        video_url=f"/fw/media/generated/{name}" if video_url is None else video_url)
    shot.heard = heard
    return db, shot


def _subs(db):
    from app.db import SubtitleClip
    with db() as s:
        return [(c.start_shot_order, c.text, round(c.start_offset_sec, 2))
                for c in s.query(SubtitleClip).order_by(SubtitleClip.start_shot_order,
                                                         SubtitleClip.start_offset_sec).all()]


def _run_job(payload):
    import app.jobs as jobs
    from app.subtitle_jobs import run_auto_subtitles
    jid = jobs.create_job("auto_subtitles", {"project_id": PID, **payload})
    run(run_auto_subtitles(jid))
    return jobs.get_job(jid)


def test_episode_is_transcribed_and_corrected_against_the_script(drama):
    db, shot = drama
    shot(1, 1, "△林晨推门进来。\n沈母：林晨，你终于回来了！",
         [{"start": 0.5, "end": 2.5, "text": "林辰，你终于回来了！"}])
    shot(2, 1, "林晨：我回来了，妈。",
         [{"start": 0.0, "end": 3.0, "text": "今天天气不错我们出去走走"}])       # 和剧本对不上
    shot(3, 2, "沈母：吃饭吧。", [{"start": 0.0, "end": 1.0, "text": "吃饭吧"}])

    job = _run_job({"episode": 1})
    assert job.status == "done", job.error
    assert _subs(db) == [(1, "林晨 你终于回来了", 0.5), (2, "今天天气不错我们出去走走", 0.0)]
    result = json.loads(job.result)
    check = result["script_check"]
    assert result["episode"] == 1 and result["asr"] == "fake" and result["created"] == 2
    assert (check["shots"], check["fixed_chars"], check["review_count"]) == (2, 1, 2)
    assert (check["fixed_shots"], check["mismatch_shots"], check["no_script_shots"]) == (1, 1, 0)
    off, fixed = check["review"]                            # 对不上的在前；改过字的也列出来，让人能核对
    assert fixed["order"] == 1 and fixed["fixes"] == [{"heard": "辰", "script": "晨"}]
    assert "辰→晨" in fixed["reason"] and fixed["shot_id"]
    assert off["order"] == 2 and "差得多" in off["reason"] and off["fixes"] == []
    assert (check["omitted_mismatch_shots"], check["omitted_fix_shots"]) == (0, 0)
    assert "1 个镜头和剧本对不上（镜号 2）、1 个镜头按剧本改了字，请看一眼" in (job.error or "")

    # 重做这一集：只清这一集的自动字幕；手加的字幕与别的集不动
    from app.db import SubtitleClip
    with db() as s:
        s.add(SubtitleClip(id="manual1", project_id=PID, text="片名", kind="title",
                           start_shot_order=1, start_offset_sec=0.0, duration=2.0))
        s.commit()
    assert _run_job({"episode": 2}).status == "done"
    assert _run_job({"episode": 1, "replace": True}).status == "done"
    assert [x[1] for x in _subs(db)] == ["片名", "林晨 你终于回来了", "今天天气不错我们出去走走", "吃饭吧"]

    # 关掉纠正：原样用识别结果
    job = _run_job({"episode": 1, "replace": True, "align_script": False})
    assert ("林辰 你终于回来了" in [x[1] for x in _subs(db)]
            and json.loads(job.result)["script_check"] is None)


def test_a_line_said_differently_keeps_the_spoken_words_and_is_listed(drama):
    db, shot = drama
    shot(1, 1, "沈母：我很想去。", [{"start": 0.0, "end": 1.0, "text": "我不想去"}])
    job = _run_job({})
    assert job.status == "done"
    assert [x[1] for x in _subs(db)] == ["我不想去"]
    check = json.loads(job.result)["script_check"]
    assert check["fixed_chars"] == 0 and check["fixed_shots"] == 0
    (entry,) = check["review"]
    assert entry["differs"] == [{"heard": "不", "script": "很"}] and "不（剧本是很）" in entry["reason"]
    assert "1 个镜头和剧本对不上（镜号 1），请看一眼" in (job.error or "")


def test_a_dropped_or_added_negation_is_listed(drama):
    db, shot = drama
    shot(1, 1, "林晨：我不想去。", [{"start": 0.0, "end": 1.0, "text": "我想去"}])
    shot(2, 1, "沈母：你走。", [{"start": 0.0, "end": 1.0, "text": "你别走"}])
    shot(3, 1, "沈母：好。", [{"start": 0.0, "end": 1.0, "text": "好"}])
    job = _run_job({})
    assert job.status == "done"
    assert [x[1] for x in _subs(db)] == ["我想去", "你别走", "好"]      # 字幕照念出来的
    check = json.loads(job.result)["script_check"]
    assert (check["mismatch_shots"], check["review_count"]) == (2, 2)
    first, second = check["review"]
    assert first["order"] == 1 and first["doubts"] == [{"heard": "", "script": "不"}]
    assert first["reason"] == "分不出是听错还是念的就和剧本不同，按听到的保留：没念「不」"
    assert second["order"] == 2 and second["doubts"] == [{"heard": "别", "script": ""}]
    assert second["reason"].endswith("多念了「别」")
    assert "2 个镜头和剧本对不上（镜号 1、2），请看一眼" in (job.error or "")


def test_mismatched_shots_are_listed_before_shots_that_only_have_corrections(drama):
    # 整个项目跑一遍：几乎每镜都有改过的字，清单满了也不能挤掉后面那个意思反了的镜头
    db, shot = drama
    for order in range(1, 71):
        shot(order, 1 + (order - 1) // 35, "林晨：林晨，你终于回来了！",
             [{"start": 0.0, "end": 1.0, "text": "林辰，你终于回来了！"}])
    shot(71, 3, "沈母：他不是坏人，你别乱说。", [{"start": 0.0, "end": 1.0, "text": "他是坏人，你别乱说。"}])
    job = _run_job({})
    check = json.loads(job.result)["script_check"]
    orders = [r["order"] for r in check["review"]]
    assert orders == [71, *range(1, 60)] and check["review"][0]["doubts"] == [{"heard": "", "script": "不"}]
    assert (check["review_count"], check["mismatch_shots"], check["fixed_shots"]) == (71, 1, 70)
    assert (check["omitted_mismatch_shots"], check["omitted_fix_shots"]) == (0, 11)
    assert "1 个镜头和剧本对不上（镜号 71）、70 个镜头按剧本改了字，请看一眼" in job.error


def test_a_same_sounding_negation_or_question_is_not_corrected_and_is_listed_first(drama):
    # 读音相近的「不」「部」、「吗」「妈」按剧本改会把意思改反；只改过字的镜头超过 60 个，也要列出来
    db, shot = drama
    for order in range(1, 66):
        shot(order, 1, "林晨：林晨，你终于回来了！", [{"start": 0.0, "end": 1.0, "text": "林辰，你终于回来了！"}])
    said = {66: ("我全部要了", "我全不要了"), 67: ("我全不要了", "我全部要了"),
            68: ("他们部队啊", "他们不对啊"), 69: ("这是你妈", "这是你吗")}
    for order, (line, heard) in said.items():
        shot(order, 2, f"沈母：{line}。", [{"start": 0.0, "end": 1.0, "text": heard}])
    job = _run_job({})
    assert [text for order, text, _ in _subs(db) if order > 65] == [heard for _, heard in said.values()]
    check = json.loads(job.result)["script_check"]
    assert [r["order"] for r in check["review"]] == [66, 67, 68, 69, *range(1, 57)]
    assert [r["doubts"] for r in check["review"][:4]] == [
        [{"heard": "不", "script": "部"}], [{"heard": "部", "script": "不"}],
        [{"heard": "不对", "script": "部队"}], [{"heard": "吗", "script": "妈"}]]
    assert all(r["fixes"] == [] and r["differs"] == [] for r in check["review"][:4])
    assert check["review"][0]["reason"] == "分不出是听错还是念的就和剧本不同，按听到的保留：不（剧本是部）"
    assert (check["mismatch_shots"], check["fixed_shots"], check["omitted_fix_shots"]) == (4, 65, 9)
    assert "4 个镜头和剧本对不上（镜号 66、67、68、69）、65 个镜头按剧本改了字，请看一眼" in job.error


def test_the_review_list_and_the_warning_name_a_bounded_number_of_mismatched_shots(drama, monkeypatch):
    import app.subtitle_jobs as subtitle_jobs
    monkeypatch.setattr(subtitle_jobs, "_REVIEW_MISMATCH_MAX", 2)
    monkeypatch.setattr(subtitle_jobs, "_WARN_ORDERS_MAX", 2)
    db, shot = drama
    for order in range(1, 4):
        shot(order, 1, "沈母：我很想去。", [{"start": 0.0, "end": 1.0, "text": "我不想去"}])
    shot(4, 1, "林晨：林晨，你终于回来了！", [{"start": 0.0, "end": 1.0, "text": "林辰，你终于回来了！"}])
    job = _run_job({})
    check = json.loads(job.result)["script_check"]
    assert [r["order"] for r in check["review"]] == [1, 2, 4]
    assert (check["review_count"], check["omitted_mismatch_shots"], check["omitted_fix_shots"]) == (4, 1, 0)
    assert "3 个镜头和剧本对不上（镜号 1、2 等）" in job.error


def test_shots_with_script_lines_but_no_speech_are_listed(drama):
    db, shot = drama
    shot(1, 1, "沈母：你终于回来了，快坐。", [])                          # 识别结果为空
    shot(2, 1, "林晨：嗯。", None)                                         # 视频没有音轨
    shot(3, 1, "林晨：我回来了。", [{"start": 0.0, "end": 1.0, "text": "我回来了"}])
    job = _run_job({})
    assert job.status == "done", job.error
    result = json.loads(job.result)
    check = result["script_check"]
    assert (result["silent"], check["shots"], check["mismatch_shots"]) == (1, 3, 2)
    first, second = check["review"]
    assert first["order"] == 1 and first["similarity"] == 0.0
    assert first["reason"] == "没有识别出说话声，剧本里这一镜有 8 个字的台词"
    assert second["order"] == 2 and second["reason"] == "视频没有音轨，剧本里这一镜有 1 个字的台词"
    assert check["unspoken_chars"] == 9


def test_shots_whose_script_has_no_lines_are_reported_once_per_job(drama):
    db, shot = drama
    shot(1, 1, "林晨推门进来，说：你终于回来了。", [{"start": 0.0, "end": 1.0, "text": "你终于回来了"}])
    shot(2, 1, "她轻声说，走吧。", [{"start": 0.0, "end": 1.0, "text": "走吧"}])
    job = _run_job({})
    assert job.status == "done"
    check = json.loads(job.result)["script_check"]
    assert (check["no_script_shots"], check["review_count"], check["review"]) == (2, 0, [])
    assert job.error.count("剧本里没有「角色：台词」格式的台词") == 1
    assert "2 个镜头的剧本里没有「角色：台词」格式的台词，没有按剧本纠正" in job.error


def test_a_shot_with_an_empty_video_url_counts_as_failed(drama):
    db, shot = drama
    shot(1, 1, "沈母：你好。", [{"start": 0.0, "end": 1.0, "text": "你好"}])
    shot(2, 1, "沈母：再见。", [], video_url="")
    job = _run_job({})
    result = json.loads(job.result)
    assert job.status == "done" and (result["total"], result["failed"], result["created"]) == (2, 1, 1)
    assert "1/2 段镜头原声识别失败" in job.error


def test_character_names_may_differ_in_tone(drama):
    db, shot = drama
    shot(1, 1, "林晨：我去看沈母。", [{"start": 0.0, "end": 1.0, "text": "我去看审木"}])
    check = json.loads(_run_job({}).result)["script_check"]
    assert check["review"][0]["differs"] == [{"heard": "审木", "script": "沈母"}]
    add_asset(db, PID, "character", "沈母")
    check = json.loads(_run_job({"replace": True}).result)["script_check"]
    assert check["review"][0]["fixes"] == [{"heard": "审木", "script": "沈母"}]
    assert [x[1] for x in _subs(db)] == ["我去看沈母"]


def test_narration_audio_is_not_corrected(drama):
    from app.db import AudioClip, Project
    db, shot = drama
    shot(1, 1, "沈母：林晨，你回来了。", [{"start": 0.0, "end": 1.0, "text": "镜头原声"}])
    with db() as s:
        s.get(Project, PID).production_mode = "narration"
        s.add(AudioClip(id="n1", project_id=PID, kind="narration", url="/fw/media/generated/n1.mp3",
                        status="done", start_shot_order=1, start_offset_sec=0.5, duration=2.0))
        s.commit()
    shot.heard["n1.mp3"] = [{"start": 0.0, "end": 1.0, "text": "林辰你回来了"}]
    job = _run_job({})
    result = json.loads(job.result)
    assert job.status == "done" and result["source"] == "旁白" and result["script_check"] is None
    assert _subs(db) == [(1, "林辰你回来了", 0.5)]


def test_muse_tool_passes_episode_and_alignment(drama):
    from app.db import Job
    db, shot = drama
    shot(1, 1, "沈母：你好。", [{"start": 0.0, "end": 1.0, "text": "你好"}])
    out = call_tool("run_auto_subtitles", episode=1, replace=True)
    assert out["kind"] == "auto_subtitles" and out["job_id"], out
    with db() as s:
        job = s.query(Job).filter(Job.kind == "auto_subtitles").one()
        assert json.loads(job.payload) == {"project_id": PID, "replace": True,
                                           "align_script": True, "episode": 1}
    from app.agent import registry
    props = set(registry.get_spec("run_auto_subtitles").args_schema.model_fields)
    assert props == {"project_id", "replace", "episode", "align_script"}
