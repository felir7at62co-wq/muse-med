"""剧变网关上的生图模型（2026-11-21，用户：「生图模型都接上吧，备用」）。

云上镜流只有网关这一条（`FW_GATEWAY_BASE_URL` = 剧变）。这里核对：
- 每个可选模型都有线路；只在剧变上核过的名字，网关不是剧变时不挂；
- nano-banana-pro 的名字在剧变上不带 `-preview` 也能出图；
- **不重复计费**（2026-11-21 审查）：同一网关上的候选名、Gemini 的 native→chat 回退，
  都只在上游肯定没受理时才发第二次；超时 / 5xx / 200（取件失败、没给图）/ 审核都到此为止；
- 账号级故障按账号冷却；「名字不存在」看完整响应体；
- 上游受理之后（200、提交成功）的任何失败都不重发，`generate` 用真实的重试次数（3）跑。
每个测试都数「上游会计费的请求」有几次。网络全部打桩：任何一次真实请求都会让测试失败。
"""
from __future__ import annotations

import base64
import io
import json
import re
import time as _time
import asyncio as _asyncio

_REAL_SLEEP = _asyncio.sleep          # 取件超时测试要真等一下（fixture 会把 asyncio.sleep 换成快进的）
from contextlib import asynccontextmanager

import httpx
import pytest

from conftest import run

JUBIAN = "https://gw.jubianai.net/v1"


def _png() -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (200, 160, 90)).save(buf, "PNG")
    return buf.getvalue()


_B64 = base64.b64encode(_png()).decode()

#: 上游回答的几种样子。`accepted` = 上游受理了这次请求（会计费）。
OK = {"kind": "ok"}


def status(code: int, body: str = "") -> dict:
    return {"kind": "status", "code": code, "body": body}


def native_200(payload: dict) -> dict:
    return {"kind": "json", "body": payload}


def raises(exc: Exception) -> dict:
    return {"kind": "raise", "exc": exc}


_MISSING = json.dumps({"error": {"code": "model_not_found",
                                 "message": "No available channel for model x under group default (distributor)"}})
_NO_CHANNEL = json.dumps({"error": {"code": "", "message": "当前分组 default 下对于模型 x 无可用渠道"}},
                         ensure_ascii=False)
_MODERATION = json.dumps({"error": {"message": "提交中含有违反平台政策的内容"}}, ensure_ascii=False)


def _accepted(b: dict) -> bool:
    if b["kind"] in ("ok", "json", "url", "empty"):
        return True
    if b["kind"] == "mj":
        return b["body"].get("code") in (1, 22)
    if b["kind"] == "rh":
        return bool(b["body"].get("taskId"))
    if b["kind"] == "raise":
        return not isinstance(b["exc"], (httpx.ConnectError, httpx.ConnectTimeout))
    body = b["body"]
    if "model_not_found" in body or "无可用渠道" in body or "No available channel" in body:
        return False
    return b["code"] >= 500 and "违反平台政策" not in body


class FakeGateway:
    """按 (协议, 模型名) 或 模型名 回答；记下每一次请求，并数上游会计费的次数。"""

    def __init__(self, script: dict):
        self.script = {k: (list(v) if isinstance(v, list) else v) for k, v in script.items()}
        self.calls: list[tuple[str, str]] = []
        self.bodies: list[dict] = []
        self.billed = 0
        self.downloads: dict[str, object] = {}      # 取件地址 → 状态码或异常
        self.fetches = 0
        self.queries = 0
        self.gets: list[str] = []                   # 取件 / 轮询请求过的地址，按顺序

    def _behaviour(self, kind: str, model: str) -> dict:
        for key in ((kind, model), model):
            if key in self.script:
                b = self.script[key]
                if isinstance(b, list):
                    return b.pop(0) if len(b) > 1 else b[0]
                return b
        return OK

    async def post(self, url, headers=None, json=None, data=None, files=None):
        m = re.search(r"/models/([^/:]+):generateContent", url)
        if m:
            kind, model = "native", m.group(1)
        elif url.endswith("/chat/completions"):
            kind, model = "chat", json["model"]
        elif url.endswith("/images/generations"):
            kind, model = "images", json["model"]
        elif url.endswith("/images/edits"):
            kind, model = "edits", data["model"]
        elif url.endswith("/mj/submit/imagine"):
            kind, model = "mj-submit", "midjourney"
        elif url.endswith("/openapi/v2/query"):          # RunningHub 轮询：不计费，不记进 calls
            self.queries += 1
            q = self.script.get("rh-query", {"status": "SUCCESS",
                                             "results": [{"url": "https://cdn.example/rh.png"}]})
            if isinstance(q, list):
                q = q.pop(0) if len(q) > 1 else q[0]
            if isinstance(q, str):
                return httpx.Response(200, text=q, request=httpx.Request("POST", url))
            return httpx.Response(200, json=q, request=httpx.Request("POST", url))
        elif "/openapi/v2/" in url:
            kind, model = "rh-submit", url.rsplit("/openapi/v2/", 1)[1]
        else:
            raise AssertionError(f"unexpected url {url}")
        self.calls.append((kind, model))
        self.bodies.append(json or {})
        b = self._behaviour(kind, model)
        self.billed += _accepted(b)
        req = httpx.Request("POST", url)
        if b["kind"] == "raise":
            raise b["exc"]
        if b["kind"] == "status":
            return httpx.Response(b["code"], text=b["body"], request=req)
        if b["kind"] == "json":
            return httpx.Response(200, json=b["body"], request=req)
        if b["kind"] == "url":
            link = b.get("url", "https://cdn.example/out.png")
            dl = b.get("dl", 404)
            if isinstance(dl, int) and 300 <= dl < 400:
                target = b.get("loc", "https://cdn2.example/final.png")
                self.downloads[link] = {"status": dl, "loc": target}
                self.downloads.setdefault(target, b.get("loc_dl", 200))
            else:
                self.downloads[link] = dl
            return httpx.Response(200, json={"data": [{"url": link}]}, request=req)
        if b["kind"] in ("mj", "rh"):
            return httpx.Response(200, json=b["body"], request=req)
        if b["kind"] == "empty":
            return httpx.Response(200, json={"data": []}, request=req)
        if kind == "rh-submit":
            return httpx.Response(200, json={"taskId": "rh-task-1"}, request=req)
        if kind == "mj-submit":
            body = {"code": 1, "result": "mj-task-1"}
        elif kind == "native":
            body = {"candidates": [{"content": {"parts": [{"inlineData": {"data": _B64}}]}}]}
        elif kind == "chat":
            body = {"choices": [{"message": {"content": f"data:image/png;base64,{_B64}"}}]}
        else:
            body = {"data": [{"b64_json": _B64}]}
        return httpx.Response(200, json=body, request=req)

    async def get(self, url, follow=False, **kw):
        req = httpx.Request("GET", url)
        self.gets.append(url)
        if "/mj/task/" in url:                       # Midjourney 轮询
            self.fetches += 1
            task = self.script.get("mj-fetch", {"status": "IN_PROGRESS"})
            if isinstance(task, list):
                task = task.pop(0) if len(task) > 1 else task[0]
            if isinstance(task, str):
                return httpx.Response(200, text=task, request=req)
            return httpx.Response(200, json=task, request=req)
        # 取件（上游给的是图片链接时）
        dl = self.downloads.get(url, self.script.get("download", 404))
        if isinstance(dl, Exception):
            raise dl
        if dl == "hang":                             # 一直不回（测取件总时长上限）
            await _REAL_SLEEP(5)
        if isinstance(dl, dict):                     # 跳转
            return httpx.Response(dl["status"], headers={"Location": dl["loc"]}, request=req)
        if isinstance(dl, bytes):                    # 指定内容（测大小上限 / 非图片）
            return httpx.Response(200, content=dl, request=req)
        if dl == 200 or dl == "hang":
            return httpx.Response(200, content=base64.b64decode(_B64), request=req)
        if 300 <= dl < 400:
            return httpx.Response(dl, headers={"Location": "https://cdn.example/x?Expires=1795290429"},
                                  request=req)
        return httpx.Response(dl, text="cdn error", request=req)


class _Bound:
    """一个 `http.client(...)` 拿到的客户端：记住它跟不跟随跳转。"""

    def __init__(self, fake: FakeGateway, follow: bool):
        self.fake, self.follow = fake, follow

    async def post(self, url, **kw):
        return await self.fake.post(url, **kw)

    async def get(self, url, **kw):
        # 同真 httpx：客户端设了跟随跳转（且这次请求没关掉），就自动一路跟下去——不管跳到哪
        follow = kw.pop("follow_redirects", self.follow)
        for _ in range(20):
            r = await self.fake.get(url, follow=follow, **kw)
            if not (follow and r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location")):
                return r
            url = r.headers["location"]
        return r

    @asynccontextmanager
    async def stream(self, method, url, **kw):
        assert kw.get("follow_redirects") is False         # 跳转必须由我们自己一跳一跳地查
        yield await self.fake.get(url)


@pytest.fixture()
def gateway(db, monkeypatch):
    """只配网关一把 key（同云上）；其余渠道一律不配。返回 设置剧本的函数 `script(dict, base=剧变)`。"""
    import app.providers.http as http_mod
    import app.providers.image as image
    from app.config import get_settings

    s = get_settings()
    monkeypatch.setattr(s, "gateway_api_key", "sk-test-only")
    for name in ("image_api_key", "kege_base_url", "modelverse_api_key", "runninghub_api_key",
                 "api4me_api_key", "api4me_gemini_api_key"):
        monkeypatch.setattr(s, name, "")
    monkeypatch.setattr(s, "image_retries", 3)               # 与线上一致：受理后的失败不许被它放大
    monkeypatch.setattr(image, "_COOLDOWN", {})

    async def no_backoff(attempt, base=2.0):
        return None

    monkeypatch.setattr(image, "_backoff", no_backoff)

    class Clock:                                              # 只替换 monotonic；其余照用真 time
        t = 1000.0

        def monotonic(self):
            return self.t

        def __getattr__(self, name):
            return getattr(_time, name)

    clock = Clock()
    monkeypatch.setattr(image, "time", clock)
    real_sleep = image.asyncio.sleep

    async def fast_sleep(sec, *a, **k):
        clock.t += sec
        await real_sleep(0)

    monkeypatch.setattr(image.asyncio, "sleep", fast_sleep)

    # 取件地址解析：*.example 是公网；IP 字面量就是它自己；intranet.example 故意指向内网
    async def resolve(host):
        if host == "intranet.example":
            return ["10.0.0.5"]
        if host.endswith(".example"):
            return ["93.184.216.34"]
        return [host]

    monkeypatch.setattr(image, "_host_addresses", resolve, raising=False)

    def script(behaviours: dict | None = None, base: str = JUBIAN) -> FakeGateway:
        monkeypatch.setattr(s, "gateway_base_url", base)
        image._COOLDOWN.clear()
        fake = FakeGateway(behaviours or {})

        @asynccontextmanager
        async def client(name, **kw):
            yield _Bound(fake, bool(kw.get("follow_redirects")))

        monkeypatch.setattr(http_mod, "client", client)
        return fake
    return script


def _gen(model: str, n: int = 1):
    from app.providers.image import ImageProvider
    return run(ImageProvider(model).generate("教室", size="1024x1536", n=n))


# ---------------------------------------------------------------- 有哪些线路

def test_every_selectable_model_has_a_line_on_the_jubian_gateway(gateway):
    from app.providers.image import IMAGE_MODELS, channel_names
    gateway()
    assert [m["id"] for m in IMAGE_MODELS if not channel_names(m["id"])] == ["z-image"]
    # 同一网关上的备用名字都收在一条渠道里（候选名链），不再各开一条
    first_ask = {"gpt-image-2": ("images", "gpt-image-2-c"),
                 "nano-banana-pro": ("native", "gemini-3-pro-image-preview"),
                 "nano-banana-2": ("native", "gemini-3.1-flash-image"),
                 "gpt-image-2.5": ("images", "gpt-image-2.5-flare"),
                 "gpt-image-2.6": ("images", "gpt-image-2.6-flare"),
                 "nano-banana": ("native", "gemini-2.5-flash-image"),
                 "nano-banana-2.1": ("native", "gemini-nano-banana-2.1"),
                 "nano-banana-2-lite": ("native", "gemini-3.1-flash-lite-image")}
    for mid, upstream in first_ask.items():
        assert channel_names(mid) == ["zx1"], mid
        fake = gateway()
        assert len(_gen(mid)) == 1
        assert fake.calls == [upstream] and fake.billed == 1, mid


def test_jubian_only_names_stay_off_other_gateways(gateway):
    from app.providers.image import channel_names
    fake = gateway({"gpt-image-2-c": status(503, _MISSING), "gpt-image-2": status(503, _NO_CHANNEL)},
                   base="https://zx1.deepwl.net/v1")
    for mid in ("gpt-image-2.5", "gpt-image-2.6", "nano-banana", "nano-banana-2.1", "nano-banana-2-lite"):
        assert channel_names(mid) == [], mid
    with pytest.raises(RuntimeError):
        _gen("gpt-image-2")
    assert fake.calls == [("images", "gpt-image-2-c"), ("images", "gpt-image-2")]   # 没有 -high


# ---------------------------------------------------------------- 换名只在没受理时

def test_gpt_image_2_takes_the_high_name_only_when_the_others_were_not_accepted(gateway):
    fake = gateway({"gpt-image-2-c": status(503, _MISSING), "gpt-image-2": status(503, _NO_CHANNEL)})
    assert len(_gen("gpt-image-2")) == 1
    assert fake.calls == [("images", "gpt-image-2-c"), ("images", "gpt-image-2"), ("images", "gpt-image-2-high")]
    assert fake.billed == 1


_SIGNED_429 = "https://cdn.example/out.png?Expires=1795290429&Signature=abc"


@pytest.mark.parametrize("answer", [
    status(504, "gateway timeout"),
    status(500, "upstream error"),
    raises(httpx.ReadTimeout("slow")),
    {"kind": "url", "dl": 404},          # 200 给了链接，取件失败
    {"kind": "url", "dl": 504},          # CDN 504（文本里有 timeout）
    {"kind": "url", "dl": 429},          # CDN 429
    {"kind": "url", "dl": 408},          # CDN 408
    {"kind": "url", "dl": RuntimeError("weird")},           # 取件时任何意外
    {"kind": "json", "body": {"data": [{"b64_json": "!!!not-base64"}]}},   # 解码失败
    {"kind": "json", "body": {"data": [{"b64_json": base64.b64encode(b"<html>busy</html>").decode()}]}},
    {"kind": "url", "dl": 403, "url": _SIGNED_429},          # 签名链接本身含 "429"
    {"kind": "url", "dl": httpx.ReadTimeout("cdn slow")},    # 取件读超时
    {"kind": "empty"},                   # 200 但 data: []
    {"kind": "json", "body": {"oops": True}},                # 200 但不是图片结构
    status(500, _MODERATION),            # 审核拒绝
], ids=["504", "500", "read-timeout", "download-404", "download-504", "download-429", "download-408",
        "download-other-error", "bad-base64", "not-an-image", "signed-url-429", "download-read-timeout", "empty-200", "odd-200", "moderation"])
def test_gpt_image_2_never_pays_twice(gateway, answer):
    from app.providers.image import ContentRejected
    fake = gateway({"gpt-image-2-c": status(503, _MISSING), "gpt-image-2": answer})
    with pytest.raises((RuntimeError, ContentRejected)) as e:
        _gen("gpt-image-2")
    assert fake.calls == [("images", "gpt-image-2-c"), ("images", "gpt-image-2")]  # 没重发、没换到 -high
    assert fake.billed <= 1
    assert "cdn.example" not in str(e.value)                 # 签名链接不进报错


def test_a_partial_download_loss_is_not_refilled(gateway):
    # n=2：上游给了 2 个链接，一个取不回 —— 交回 1 张，不再为丢的那张补发一次
    fake = gateway({"gpt-image-2-c": status(503, _MISSING)})
    fake.script["gpt-image-2"] = {"kind": "json", "body": {"data": [
        {"b64_json": _B64}, {"url": "https://cdn.example/second.png"}]}}
    assert len(_gen("gpt-image-2", n=2)) == 1
    assert fake.calls == [("images", "gpt-image-2-c"), ("images", "gpt-image-2")] and fake.billed == 1


def test_rate_limits_are_still_retried_but_only_by_status(gateway):
    fake = gateway({"gpt-image-2-c": status(503, _MISSING), "gpt-image-2": [status(429, "slow down"), OK]})
    assert len(_gen("gpt-image-2")) == 1
    assert fake.calls.count(("images", "gpt-image-2")) == 2 and fake.billed == 1

    # 400 的正文里出现 "timeout" 不算限流：只发一次
    fake = gateway({"gpt-image-2-c": status(503, _MISSING),
                    "gpt-image-2": status(400, json.dumps({"error": {"message": "invalid param: timeout"}}))})
    with pytest.raises(RuntimeError):
        _gen("gpt-image-2")
    assert fake.calls == [("images", "gpt-image-2-c"), ("images", "gpt-image-2")]


def test_gpt_image_2_5_moves_on_only_while_lines_have_no_channel(gateway):
    fake = gateway({"gpt-image-2.5-flare": status(503, _NO_CHANNEL)})
    assert len(_gen("gpt-image-2.5")) == 1
    assert fake.calls == [("images", "gpt-image-2.5-flare"), ("images", "gpt-image-2.5-sunburst")]
    assert fake.billed == 1

    for answer in (status(504, "gateway timeout"), {"kind": "url", "dl": 504}, {"kind": "empty"}):
        fake = gateway({"gpt-image-2.5-flare": answer})
        with pytest.raises(RuntimeError):
            _gen("gpt-image-2.5")
        assert fake.calls == [("images", "gpt-image-2.5-flare")] and fake.billed == 1


def test_model_missing_is_read_from_the_whole_body(gateway):
    long_body = json.dumps({"error": {"message": "x" * 300, "type": "new_api_error", "code": "model_not_found"}})
    fake = gateway({"gpt-image-2-c": status(503, long_body)})
    assert len(_gen("gpt-image-2")) == 1
    assert fake.calls == [("images", "gpt-image-2-c"), ("images", "gpt-image-2")]


# ---------------------------------------------------------------- 账号级故障按账号冷却

@pytest.mark.parametrize("code", [401, 402, 403])
def test_a_dead_key_cools_every_line_of_that_account(gateway, code):
    from app.providers.image import _healthy
    fake = gateway({"gpt-image-2-c": status(code, json.dumps({"error": {"message": "invalid key / balance"}}))})
    with pytest.raises(RuntimeError):
        _gen("gpt-image-2")
    assert fake.calls == [("images", "gpt-image-2-c")] and fake.billed == 0
    assert not _healthy("zx1", "nano-banana-2") and not _healthy("zx1-mj", "midjourney")
    assert _healthy("kege", "gpt-image-2")


# ---------------------------------------------------------------- Gemini：native → chat 只在没受理时

def test_nano_banana_pro_takes_the_gateway_name_when_preview_is_missing(gateway):
    fake = gateway({"gemini-3-pro-image-preview": status(503, _MISSING)})
    assert len(_gen("nano-banana-pro")) == 1
    assert fake.calls == [("native", "gemini-3-pro-image-preview"), ("chat", "gemini-3-pro-image-preview"),
                          ("native", "gemini-3-pro-image")]
    assert fake.billed == 1


@pytest.mark.parametrize("answer, error", [
    (raises(httpx.ReadTimeout("slow")), "ReadTimeout"),
    (status(504, "gateway timeout"), "504"),
    (native_200({"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "好的"}]}}]}),
     "没有图"),
    (native_200({"candidates": [{"finishReason": "IMAGE_SAFETY"}]}), "IMAGE_SAFETY"),
    (native_200({"promptFeedback": {"blockReason": "PROHIBITED_CONTENT"}}), "PROHIBITED_CONTENT"),
], ids=["read-timeout", "504", "200-no-image", "image-safety", "prompt-blocked"])
def test_gemini_does_not_retry_on_chat_after_native_may_have_been_billed(gateway, answer, error):
    from app.providers.image import ContentRejected
    fake = gateway({("native", "gemini-3.1-flash-image"): answer})
    with pytest.raises((RuntimeError, ContentRejected)) as e:
        _gen("nano-banana-2")
    assert fake.calls == [("native", "gemini-3.1-flash-image")]
    assert error in str(e.value) or error in "；".join(getattr(e.value, "categories", []))
    if "SAFETY" in error or "PROHIBITED" in error:
        assert isinstance(e.value, ContentRejected)


@pytest.mark.parametrize("answer", [status(404, "not found"), status(400, json.dumps({"error": {"message": "bad"}})),
                                    raises(httpx.ConnectError("refused"))],
                         ids=["404", "400", "connect-error"])
def test_gemini_falls_back_to_chat_when_native_was_not_accepted(gateway, answer):
    fake = gateway({("native", "gemini-3.1-flash-image"): answer})
    assert len(_gen("nano-banana-2")) == 1
    assert fake.calls == [("native", "gemini-3.1-flash-image"), ("chat", "gemini-3.1-flash-image")]
    assert fake.billed == 1


def test_gemini_chat_200_without_an_image_is_not_resent(gateway):
    fake = gateway({("native", "gemini-3.1-flash-image"): status(404, "not found"),
                    ("chat", "gemini-3.1-flash-image"): native_200({"choices": [{"message": {"content": "抱歉"}}]})})
    with pytest.raises(RuntimeError, match="没有图"):
        _gen("nano-banana-2")
    assert fake.calls == [("native", "gemini-3.1-flash-image"), ("chat", "gemini-3.1-flash-image")]
    assert fake.billed == 1


def test_gemini_keeps_native_images_when_n_is_more_than_one(gateway):
    fake = gateway({("native", "gemini-3.1-flash-image"): [OK, status(504, "gateway timeout")]})
    assert len(_gen("nano-banana-2", n=2)) == 1                       # 交回已出的那张，不再走 chat
    assert fake.calls == [("native", "gemini-3.1-flash-image")] * 2

    fake = gateway({("native", "gemini-3.1-flash-image"): [OK, status(404, "not found")]})
    assert len(_gen("nano-banana-2", n=2)) == 2                       # chat 只补剩下的一张
    assert fake.calls == [("native", "gemini-3.1-flash-image")] * 2 + [("chat", "gemini-3.1-flash-image")]
    assert fake.billed == 2


def test_image_size_goes_only_to_3x_gemini_models(gateway):
    fake = gateway()
    _gen("nano-banana")
    assert fake.calls[-1] == ("native", "gemini-2.5-flash-image")
    assert "imageSize" not in fake.bodies[-1]["generationConfig"]["imageConfig"]
    _gen("nano-banana-2")
    assert fake.bodies[-1]["generationConfig"]["imageConfig"]["imageSize"] == "1K"


def test_gateway_only_gemini_models_ask_for_their_gateway_names(gateway):
    # 名字取自剧变公开模型列表（/api/pricing，2026-11-21），三个都实测出过图
    fake = gateway()
    for mid, upstream in (("nano-banana", "gemini-2.5-flash-image"),
                          ("nano-banana-2.1", "gemini-nano-banana-2.1"),
                          ("nano-banana-2-lite", "gemini-3.1-flash-lite-image")):
        assert len(_gen(mid)) == 1
        assert fake.calls[-1] == ("native", upstream)


def test_new_models_are_accepted_for_projects_and_the_muse_tools():
    from app.agent.tools_write import _image_models
    ids = set(_image_models())
    assert {"gpt-image-2.5", "gpt-image-2.6", "nano-banana", "nano-banana-2.1", "nano-banana-2-lite"} <= ids
    assert "midjourney" not in ids


# ---------------------------------------------------------------- Midjourney：提交受理后不再提交

_MJ_DONE = {"status": "SUCCESS", "imageUrls": [{"url": f"https://cdn.example/mj{i}.png"} for i in range(4)]}


def test_midjourney_poll_timeout_does_not_resubmit(gateway):
    fake = gateway({"mj-fetch": {"status": "IN_PROGRESS"}})
    with pytest.raises(RuntimeError, match="仍未完成"):
        _gen("midjourney")
    assert fake.calls == [("mj-submit", "midjourney")] and fake.billed == 1
    assert fake.fetches > 50                                # 确实一直在等，等到点才放弃


@pytest.mark.parametrize("dl", [504, 429, httpx.ReadTimeout("cdn slow")], ids=["504", "429", "read-timeout"])
def test_midjourney_download_failure_does_not_resubmit(gateway, dl):
    fake = gateway({"mj-fetch": _MJ_DONE, "download": dl})
    with pytest.raises(RuntimeError) as e:
        _gen("midjourney")
    assert fake.calls == [("mj-submit", "midjourney")] and fake.billed == 1
    assert "cdn.example" not in str(e.value)


def test_midjourney_works_and_a_full_queue_is_retried(gateway):
    fake = gateway({"mj-fetch": _MJ_DONE, "download": 200})
    assert len(_gen("midjourney")) == 4
    assert fake.calls == [("mj-submit", "midjourney")]

    # 队列满（code 23）没受理：退避重试，三次都满才放弃，一次也没计费
    fake = gateway({("mj-submit", "midjourney"): {"kind": "mj", "body": {"code": 23}}})
    with pytest.raises(RuntimeError):
        _gen("midjourney")
    assert fake.calls == [("mj-submit", "midjourney")] * 3 and fake.billed == 0


# ---------------------------------------------------------------- patch 11：受理之后的各种边角

def test_a_redirecting_image_link_is_followed_with_a_single_post(gateway):
    fake = gateway({"gpt-image-2-c": status(503, _MISSING), "gpt-image-2": {"kind": "url", "dl": 302}})
    assert len(_gen("gpt-image-2")) == 1
    assert fake.calls == [("images", "gpt-image-2-c"), ("images", "gpt-image-2")] and fake.billed == 1
    assert fake.gets == ["https://cdn.example/out.png", "https://cdn2.example/final.png"]   # 我们自己跟的跳转


def test_name_switching_reads_flags_not_text():
    from app.providers.image import ChannelDown, _try_next_name
    assert not _try_next_name(RuntimeError("HTTP 400: model_not_found 字样出现在别处"))
    assert not _try_next_name(ChannelDown("HTTP 503: no available channel"))     # 没带标记
    assert _try_next_name(ChannelDown("x", model_missing=True))
    assert _try_next_name(ChannelDown("x", no_channel=True))
    assert not _try_next_name(ChannelDown("x", account_level=True, no_channel=True))


def test_a_non_image_200_is_not_recorded_as_usage(gateway, monkeypatch):
    from app import usage
    recorded = []
    monkeypatch.setattr(usage, "record", lambda *a, **k: recorded.append(k))
    fake = gateway({"gpt-image-2-c": status(503, _MISSING), "gpt-image-2": {"kind": "json", "body": {
        "data": [{"b64_json": base64.b64encode(b"").decode() or "AAAA"}]}}})
    with pytest.raises(RuntimeError, match="上游已受理但未取回图片"):
        _gen("gpt-image-2")
    assert recorded == [] and fake.billed == 1


def test_after_an_accepted_loss_the_chain_stops_and_no_quota_hint_is_given(gateway, monkeypatch):
    from app.config import get_settings
    s = get_settings()
    fake = gateway({"gpt-image-2-c": status(503, _MISSING), "gpt-image-2": {"kind": "empty"}})
    monkeypatch.setattr(s, "kege_base_url", "https://kege.example")        # 再配一家
    monkeypatch.setattr(s, "kege_gpt_api_key", "sk-kege-test")
    with pytest.raises(RuntimeError) as e:
        _gen("gpt-image-2")
    assert "上游已受理但未取回图片" in str(e.value) and "API KEY" not in str(e.value)
    assert fake.calls == [("images", "gpt-image-2-c"), ("images", "gpt-image-2")]   # 没换到 kege


def test_gemini_caps_at_n_and_dedupes_chat_images(gateway):
    two = {"candidates": [{"content": {"parts": [{"inlineData": {"data": _B64}},
                                                 {"inlineData": {"data": _B64}}]}}]}
    fake = gateway({("native", "gemini-3.1-flash-image"): native_200(two)})
    assert len(_gen("nano-banana-2", n=1)) == 1                   # 一次回两张，只要一张
    assert fake.calls == [("native", "gemini-3.1-flash-image")]

    dup = {"choices": [{"message": {"content": f"data:image/png;base64,{_B64}",
                                    "images": [{"image_url": {"url": f"data:image/png;base64,{_B64}"}}]}}]}
    fake = gateway({("native", "gemini-3.1-flash-image"): status(404, "not found"),
                    ("chat", "gemini-3.1-flash-image"): native_200(dup)})
    assert len(_gen("nano-banana-2", n=2)) == 2                   # 每次 chat 那张图只算一张
    assert fake.calls == [("native", "gemini-3.1-flash-image")] + [("chat", "gemini-3.1-flash-image")] * 2


def test_gemini_chat_stops_at_the_first_200_without_an_image(gateway):
    empty = native_200({"choices": [{"message": {"content": "抱歉"}}]})
    fake = gateway({("native", "gemini-3.1-flash-image"): status(404, "not found"),
                    ("chat", "gemini-3.1-flash-image"): [OK, empty, OK]})
    assert len(_gen("nano-banana-2", n=3)) == 1                   # 第二次没给图就停，不发第三次
    assert fake.calls == [("native", "gemini-3.1-flash-image")] + [("chat", "gemini-3.1-flash-image")] * 2
    assert fake.billed == 2


def test_gemini_native_bad_body_and_a_dropped_connection_are_terminal(gateway):
    fake = gateway({("native", "gemini-3.1-flash-image"): native_200({"candidates": "oops"})})
    with pytest.raises(RuntimeError, match="上游已受理但未取回图片"):
        _gen("nano-banana-2")
    assert fake.calls == [("native", "gemini-3.1-flash-image")]

    # 「没回应就断开」是在整个请求写完之后才报的：对端可能已经在出图 —— 不改走 chat（审查实测会重复计费）
    gone = raises(httpx.RemoteProtocolError("Server disconnected without sending a response."))
    fake = gateway({("native", "gemini-3.1-flash-image"): gone})
    with pytest.raises(RuntimeError):
        _gen("nano-banana-2")
    assert fake.calls == [("native", "gemini-3.1-flash-image")] and fake.billed == 1


def test_midjourney_tolerates_a_bad_poll_body(gateway):
    fake = gateway({"mj-fetch": ["<html>busy</html>", _MJ_DONE], "download": 200})
    assert len(_gen("midjourney")) == 4
    assert fake.calls == [("mj-submit", "midjourney")] and fake.fetches == 2


@pytest.fixture()
def runninghub(gateway, monkeypatch):
    """只配 RunningHub（gpt-image-2 链上只剩 rh-g2）。"""
    from app.config import get_settings
    s = get_settings()

    def script(behaviours=None):
        fake = gateway(behaviours)
        monkeypatch.setattr(s, "gateway_api_key", "")
        monkeypatch.setattr(s, "runninghub_api_key", "rh-test-only")
        monkeypatch.setattr(s, "runninghub_base_url", "https://rh.example")
        return fake
    return script


def test_runninghub_never_resubmits_after_a_task_id(runninghub):
    from app.providers.image import channel_names
    fake = runninghub({"rh-query": ["not json", {"status": "SUCCESS",
                                                 "results": [{"url": "https://cdn.example/rh.png"}]}],
                       "download": 200})
    assert channel_names("gpt-image-2") == ["rh-g2"]
    assert len(_gen("gpt-image-2")) == 1                          # 轮询回了一次怪东西，下一轮照常
    assert [c[0] for c in fake.calls] == ["rh-submit"]

    fake = runninghub({"rh-query": {"status": "RUNNING"}})
    with pytest.raises(RuntimeError, match="上游已受理但未取回图片"):
        _gen("gpt-image-2")
    assert [c[0] for c in fake.calls] == ["rh-submit"] and fake.queries == 60   # 等到点，不重新提交

    fake = runninghub({"download": 504})
    with pytest.raises(RuntimeError):
        _gen("gpt-image-2")
    assert [c[0] for c in fake.calls] == ["rh-submit"]


def test_runninghub_keeps_what_it_has_when_a_later_task_fails(runninghub):
    fake = runninghub({"rh-query": [{"status": "SUCCESS", "results": [{"url": "https://cdn.example/1.png"}]},
                                    {"status": "FAILED", "errorMessage": "gpu oom"}],
                       "download": 200})
    assert len(_gen("gpt-image-2", n=2)) == 1
    assert [c[0] for c in fake.calls] == ["rh-submit", "rh-submit"]


# ---------------------------------------------------------------- patch 11 v2：取件的安全边界

@pytest.mark.parametrize("target", [
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.100.100.200/latest/meta-data/",
    "http://[::1]/x.png",
    "http://[fd00::1]/x.png",
    "https://intranet.example/x.png",                      # 域名解析到 10.0.0.5
    "file:///etc/passwd",
], ids=["loopback", "metadata", "cgnat", "ipv6-loopback", "ipv6-ula", "resolves-private", "file"])
def test_a_redirect_into_the_private_network_is_refused(gateway, target):
    fake = gateway({"gpt-image-2-c": status(503, _MISSING),
                    "gpt-image-2": {"kind": "url", "dl": 302, "loc": target}})
    with pytest.raises(RuntimeError) as e:
        _gen("gpt-image-2")
    assert fake.gets == ["https://cdn.example/out.png"]      # 跳转目标一次都没请求
    assert fake.billed == 1 and "上游已受理但未取回图片" in str(e.value)
    assert "127.0.0.1" not in str(e.value) and "169.254" not in str(e.value)


def test_a_private_first_link_is_refused_before_any_request(gateway):
    fake = gateway({"gpt-image-2-c": status(503, _MISSING),
                    "gpt-image-2": {"kind": "url", "url": "http://192.168.1.10/out.png", "dl": 200}})
    with pytest.raises(RuntimeError):
        _gen("gpt-image-2")
    assert fake.gets == []


def test_redirects_are_capped_at_five_hops(gateway):
    fake = gateway({"gpt-image-2-c": status(503, _MISSING),
                    "gpt-image-2": {"kind": "url", "dl": 302, "loc": "https://cdn.example/hop1"}})
    original_post = fake.post

    async def post(url, **kw):                                # 出图之后再把跳转链挂上
        r = await original_post(url, **kw)
        for i in range(1, 8):
            fake.downloads[f"https://cdn.example/hop{i}"] = {"status": 302, "loc": f"https://cdn.example/hop{i + 1}"}
        return r

    fake.post = post
    with pytest.raises(RuntimeError):
        _gen("gpt-image-2")
    assert len(fake.gets) == 6                                # 原链接 + 5 跳，第 6 跳不再请求


def test_downloads_are_capped_in_size_and_time(gateway, monkeypatch):
    import app.providers.image as image
    monkeypatch.setattr(image, "_DOWNLOAD_MAX_BYTES", 1000)
    png = base64.b64decode(_B64)

    fake = gateway({"gpt-image-2-c": status(503, _MISSING),
                    "gpt-image-2": {"kind": "url", "url": "https://cdn.example/big.png", "dl": png + b"\0" * 2000}})
    with pytest.raises(RuntimeError, match="上游已受理但未取回图片"):   # 带 Content-Length：先看头就拒
        _gen("gpt-image-2")
    assert fake.billed == 1

    monkeypatch.setattr(image, "_DOWNLOAD_TIMEOUT_SEC", 0.05)          # 一直不回：到点放弃，不重发
    fake = gateway({"gpt-image-2-c": status(503, _MISSING), "gpt-image-2": {"kind": "url", "dl": "hang"}})
    with pytest.raises(RuntimeError, match="上游已受理但未取回图片"):
        _gen("gpt-image-2")
    assert fake.calls == [("images", "gpt-image-2-c"), ("images", "gpt-image-2")] and fake.billed == 1


def test_streamed_size_cap_without_a_length_header(monkeypatch):
    import app.providers.image as image

    class Resp:
        status_code = 200
        headers: dict = {}

        def raise_for_status(self):
            return None

        async def aiter_bytes(self):
            for _ in range(10):
                yield b"x" * 400

    class Client:
        @asynccontextmanager
        async def stream(self, method, url, **kw):
            yield Resp()

    async def public(host):
        return ["93.184.216.34"]

    monkeypatch.setattr(image, "_DOWNLOAD_MAX_BYTES", 1000)
    monkeypatch.setattr(image, "_host_addresses", public)
    with pytest.raises(image.UnsafeDownload, match="大小上限"):
        run(image._download(Client(), "https://cdn.example/big"))


def test_reference_images_from_the_private_network_are_refused(gateway):
    import app.providers.image as image
    fake = gateway()
    with pytest.raises(image.RefUnavailable):
        run(image._load_ref_bytes(["http://127.0.0.1:8080/ref.png"]))
    assert fake.gets == []                                    # 一次都没去请求


def test_bmp_magic_alone_is_not_an_image():
    from app.providers.image import _is_image
    assert not _is_image(b"BM this is plain text, not a bitmap")
    assert _is_image(base64.b64decode(_B64))


# ---------------------------------------------------------------- patch 12：IPv6 里藏着的 IPv4、被拒参考图计数

@pytest.mark.parametrize("addr, public", [
    ("93.184.216.34", True), ("2606:4700::1111", True), ("64:ff9b::808:808", True),     # NAT64 → 8.8.8.8
    ("::7f00:1", False), ("::a00:5", False), ("::1", False), ("::", False),          # IPv4 兼容 / 回环 / 空
    ("::ffff:10.0.0.1", False), ("64:ff9b::7f00:1", False), ("64:ff9b::a9fe:a9fe", False),
    ("64:ff9b:1::a00:1", False), ("2002:7f00:1::1", False),
    ("2001:0:4136:e378:8000:63bf:80ff:fffe", False),                                   # Teredo
    ("100.64.1.1", False), ("169.254.169.254", False), ("fd00::1", False), ("not-an-ip", False),
])
def test_embedded_ipv4_inside_ipv6_is_checked(addr, public):
    from app.providers.image import _is_public_ip
    assert _is_public_ip(addr) is public


def test_refused_reference_images_are_counted_in_the_error(gateway):
    import app.providers.image as image
    gateway()
    with pytest.raises(image.RefUnavailable, match="其中 2 张地址不安全被拒"):
        run(image._load_ref_bytes(["http://127.0.0.1/a.png", "http://169.254.169.254/b.png"]))


# ---------------------------------------------------------------- patch 12 v2：IDNA、异常写法、SIIT

@pytest.mark.parametrize("host", ["ß.x.example", "ς.x.example", "faß.x.example"])
def test_the_guard_checks_the_name_httpx_will_connect_to(gateway, monkeypatch, host):
    """IDNA 2003（Python 自带）与 2008（httpx）对这些字符编码不同：两种名字分别答公网 / 内网。"""
    import app.providers.image as image

    async def split_brain(name):
        # IDNA 2008 的名字（httpx 真正去连的）→ 内网；其余（2003 的 ss / xn--4xa 之类）→ 公网
        return ["10.0.0.5"] if name in ("xn--zca.x.example", "xn--3xa.x.example", "xn--fa-hia.x.example") \
            else ["93.184.216.34"]

    fake = gateway()
    monkeypatch.setattr(image, "_host_addresses", split_brain)
    with pytest.raises(image.UnsafeDownload, match="内网"):
        run(image._download(_Bound(fake, False), f"http://{host}/a.png"))
    assert fake.gets == []


@pytest.mark.parametrize("url", ["http://[127.0.0.1]/x.png", "http://a..b.example/x.png",
                                 "http://" + "a" * 64 + ".example/x.png", "ftp://cdn.example/x.png"])
def test_odd_address_forms_are_refused_as_unsafe(gateway, monkeypatch, url):
    import app.providers.image as image

    async def real_resolver_shape(name):                      # 同真解析：坏标签在编码时就抛 UnicodeError
        name.encode("idna")
        return ["93.184.216.34"]

    fake = gateway()
    monkeypatch.setattr(image, "_host_addresses", real_resolver_shape)
    with pytest.raises(image.UnsafeDownload):
        run(image._download(_Bound(fake, False), url))
    if url.startswith("http"):                                # ftp:// 参考图在更前面就按「认不出」丢了
        with pytest.raises(image.RefUnavailable, match="其中 1 张地址不安全被拒"):
            run(image._load_ref_bytes([url]))
    assert fake.gets == []


def test_our_ipv6_rules_hold_even_if_the_stdlib_called_everything_global(monkeypatch):
    """3.12.4+ 的标准库本身已经拒了这些；把 is_global 改成永远 True，验证我们自己的分支。"""
    import ipaddress
    from app.providers.image import _is_public_ip
    monkeypatch.setattr(ipaddress.IPv6Address, "is_global", property(lambda self: True))
    for addr in ("2002:7f00:1::1", "2001:0:4136:e378:8000:63bf:80ff:fffe", "64:ff9b:1::a00:1",
                 "::ffff:10.0.0.1", "::ffff:0:a00:1", "::ffff:0:7f00:1", "::7f00:1", "64:ff9b::7f00:1"):
        assert _is_public_ip(addr) is False, addr
    assert _is_public_ip("2606:4700::1111") is True


def test_the_reference_error_keeps_the_action_within_the_first_200_chars(gateway):
    import app.providers.image as image
    gateway()
    long = "http://127.0.0.1/" + "x" * 300 + ".png"
    with pytest.raises(image.RefUnavailable) as e:
        run(image._load_ref_bytes([long, long, long]))
    head = str(e.value)[:200]
    assert "请补上图片后重试" in head and "其中 3 张地址不安全被拒" in head
