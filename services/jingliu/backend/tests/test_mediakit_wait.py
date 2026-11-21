"""火山 AI MediaKit 的等待（2026-11-21）：字幕擦除等得够久、网络抖动不算失败、不再假装能取消。

起因（云上实测）：1080×1920 的 5 秒片，火山 354 秒才出片，镜流旧上限 300 秒先判了失败，
随后发的 `DELETE /tasks/{id}` 返回 405 —— 火山这套接口没有取消，任务照样跑完、照样计费。
网络全部打桩：任何一次真实请求都会让测试失败。
"""
from __future__ import annotations

import httpx
import pytest

from conftest import run


class FakeMediaKit:
    """按剧本回答查询；记下每一次请求。"""

    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = []

    @staticmethod
    def _resp(method, url, code, body=None):
        return httpx.Response(code, json=body if body is not None else {},
                              request=httpx.Request(method, url))

    async def post(self, url, json=None, headers=None):
        self.calls.append("POST")
        return self._resp("POST", url, 200, {"success": True, "task_id": "amk-erase-1"})

    async def get(self, url, headers=None):
        self.calls.append("GET")
        step = self.answers.pop(0) if self.answers else (200, {"status": "running"})
        if isinstance(step, Exception):
            raise step
        code, body = step
        return self._resp("GET", url, code, body)

    async def delete(self, url, headers=None):
        self.calls.append("DELETE")
        return self._resp("DELETE", url, 405)


@pytest.fixture()
def erase(monkeypatch, tmp_path):
    """字幕擦除通道：素材、时长、取件、合音轨、等待全部打桩。返回 (provider, 设置剧本的函数)。"""
    import app.media as media
    import app.providers.http as http_mod
    import app.providers.mediakit_erase as mk
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "mediakit_api_key", "AKLT-test-only")
    src = tmp_path / "src.mp4"
    src.write_bytes(b"video")
    out = tmp_path / "out.mp4"
    out.write_bytes(b"erased")

    async def publish(self, video_url):
        return src, "https://bucket.example/src.mp4", ""

    async def duration(path):
        return 5.0

    async def download(self, url):
        return out

    async def mux(video, source):
        return video

    async def no_sleep(_sec):
        return None

    monkeypatch.setattr(mk.MediaKitEraseProvider, "_publish_seg", publish)
    monkeypatch.setattr(mk.MediaKitEraseProvider, "_download", download)
    monkeypatch.setattr(mk.MediaKitEraseProvider, "_mux_source_audio", staticmethod(mux))
    monkeypatch.setattr(media, "_probe_duration", duration)
    monkeypatch.setattr(mk.asyncio, "sleep", no_sleep)
    box = {}

    def script(answers):
        box["fake"] = FakeMediaKit(answers)
        monkeypatch.setattr(http_mod, "get", lambda base, **kw: box["fake"])
        return box["fake"]

    regions = [{"t0": 0.0, "t1": 5.0, "x": 0.05, "y": 0.69, "w": 0.9, "h": 0.09}]
    return mk.MediaKitEraseProvider(poll_interval=10), regions, script


def test_wait_limit_leaves_room_for_1080p_shots():
    from app.providers.mediakit_erase import _expected_for, _timeout_for
    assert _timeout_for(5.0) >= 2 * 354            # 实测 1080P 5 秒片 354 秒
    assert _timeout_for(4.1) >= 2 * 190            # 实测 496×864 4 秒片 190 秒
    assert _timeout_for(12.0) >= 2 * 12 * 71
    assert _timeout_for(0.5) == 900 and _timeout_for(600) == 5400
    assert 354 * 0.8 < _expected_for(5.0) < _timeout_for(5.0)


def test_erase_waits_past_the_old_limit_and_shrugs_off_query_blips(erase):
    provider, regions, script = erase
    done = (200, {"status": "completed", "result": {"video_url": "https://vod.example/out.mp4"}})
    fake = script([(200, {"status": "running"})] * 32
                  + [httpx.ConnectError("blip"), (503, {}), (500, {})] + [done])
    r = run(provider.erase("/fw/media/generated/src.mp4", regions, dur=5.0))
    assert r["ok"] is True, r
    assert r["elapsed"] == 360.0                   # 旧上限 300 秒时这里已经判失败
    assert "DELETE" not in fake.calls


def test_erase_gives_up_without_pretending_to_cancel(erase):
    provider, regions, script = erase
    fake = script([])                              # 永远 running（素材拉不到时就是这样）
    r = run(provider.erase("/fw/media/generated/src.mp4", regions, dur=5.0))
    assert r["ok"] is False
    assert "15 分钟" in r["error"] and "不支持取消" in r["error"] and "amk-erase-1" in r["error"]
    assert "已取消" not in r["error"]
    assert fake.calls.count("GET") == 90 and "DELETE" not in fake.calls


def test_three_not_found_answers_still_mean_the_task_is_gone(erase):
    provider, regions, script = erase
    script([(404, {})] * 3)
    r = run(provider.erase("/fw/media/generated/src.mp4", regions, dur=5.0))
    assert r["ok"] is False and "查不到" in r["error"]


# ---------------------------------------------------------------- 画质提升

def test_upscale_has_no_fake_cancel_and_keeps_polling_through_blips(monkeypatch, tmp_path):
    import app.media as media
    import app.providers.upscale_mediakit as up
    from app import usage
    from app.config import get_settings

    assert not hasattr(up.MediaKitUpscaleProvider, "cancel")
    monkeypatch.setattr(get_settings(), "mediakit_api_key", "AKLT-test-only")
    src = tmp_path / "src.mp4"
    src.write_bytes(b"video")
    answers = [RuntimeError("mediakit status HTTP 502"), ("running", {}),
               ("completed", {"result": {"video_url": "https://vod.example/up.mp4"}})]
    recorded = []

    async def publish(self, video_url):
        return src, "https://bucket.example/src.mp4", ""

    async def duration(path):
        return 4.0

    async def create(self, public_url):
        return "amk-up-1", {"resolution": "1080p"}

    async def status(self, task_id):
        step = answers.pop(0)
        if isinstance(step, Exception):
            raise step
        return step

    async def download(self, url):
        return src

    async def mux(video, source):
        return video

    async def no_sleep(_sec):
        return None

    monkeypatch.setattr(up.MediaKitUpscaleProvider, "_publish", publish)
    monkeypatch.setattr(up.MediaKitUpscaleProvider, "create", create)
    monkeypatch.setattr(up.MediaKitUpscaleProvider, "status", status)
    monkeypatch.setattr(up.MediaKitUpscaleProvider, "_download", download)
    monkeypatch.setattr(up.MediaKitUpscaleProvider, "_mux_source_audio", staticmethod(mux))
    monkeypatch.setattr(up.MediaKitUpscaleProvider, "_record",
                        lambda self, tid, **kw: recorded.append(kw["ok"]))
    monkeypatch.setattr(media, "_probe_duration", duration)
    monkeypatch.setattr(usage, "record_dispatch", lambda *a, **k: None)
    monkeypatch.setattr(usage, "cancel_requested", lambda: False)
    monkeypatch.setattr(up.asyncio, "sleep", no_sleep)

    r = run(up.MediaKitUpscaleProvider(poll_interval=10).upscale("/fw/media/generated/src.mp4"))
    assert r["ok"] is True, r
    assert recorded == [True] and answers == []
