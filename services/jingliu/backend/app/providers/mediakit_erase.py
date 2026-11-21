"""火山 AI MediaKit「字幕擦除（精细版）」通道。

## 与旧通道（yudian）的关系

旧通道**已删除**。它没有时间参数、会改输出帧率、产物帧数不可控，而我们的
拼接按**帧**接、音轨按整条从原片 copy，两者一错开就是永久的音画错位
（`docs/AUDIT-2026-11-12-去字幕音画不对应.md`）。火山整条送、整条回，
不存在接缝，那个失效模式从根上消失。

## 实测确认的接口形态（勿重新论证，2026-11-13 实测）

| 事实 | 后果 |
|---|---|
| 端点 `POST /tools/erase-video-subtitle-pro` | 与标准版 `erase-video-subtitle` 是两个工具，task_type 各自独立 |
| 必传 `model_version: "v5.6"`、`mode: "Text"` | 缺了不会报错，但行为未定义 |
| 坐标是**归一化 0–1**，字段 `erase_ratio_location: [{top_left_x, top_left_y, bottom_right_x, bottom_right_y}]` | 前端存的就是比例，直接搬过来，不需要乘像素 |
| 支持**分时段不同坐标** `time_segment_filter.segments[]` | 同一镜前后框位置不同时用它表达 |
| ⚠️ 全局框与分时段框**互斥**，同时传直接 400 | 二选一，见 `_build_body` |
| 不传坐标 = 自动识别整条 | — |
| 产出**保留音轨**、帧率帧数与原片一致（24→24、265→265） | 仍贴回原片音轨，保证一字节不差 |
| ⚠️ 素材拉不到时**不报错、一直 running**（实测 31 分钟） | 必须我方设超时，见 `_poll_timeout` |
| 慢：11 秒片约 345 秒（标准版 81 秒） | 执行改成多镜并行 |

## 为什么坐标与时间都要

坐标收窄了改动范围（实测：只框顶部时，框外的字幕完整保留），时间分段让
同一镜里「前 3 秒擦底部、后 4 秒擦右上」这种情形也能表达。两者都不是省钱的
手段 —— 火山按**被处理视频的时长**计费，整条送就是整条的钱。
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from pathlib import Path

import httpx

from ..config import get_settings
from ..err_text import human_error
from ..media import GENERATED_DIR
from . import http
from .upscale_mediakit import (  # noqa: F401  （复用同一条通道的既有实现）
    _LOST_STREAK,
    _MAX_DOWNLOAD_RETRIES,
    MediaKitUpscaleProvider,
)

logger = logging.getLogger(__name__)

#: 轮询间隔。精细版实测 11 秒片 345 秒、3 秒片 101 秒，10 秒一查足够灵敏。
POLL_INTERVAL_SEC = 10

#: 源素材在桶里的保留时长。精细版很慢（长镜可能十几分钟），给足。
_SRC_URL_TTL_SEC = 6 * 3600

#: 上传到 TOS 的前缀。与 `upscale-src/` 分开，可按前缀整体回收。
_SRC_PREFIX = "desub-src"

#: 火山字幕擦除的模型版本。**不是**我们自己的版本号，是上游枚举值。
MODEL_VERSION = "v5.6"

#: 超时系数：实测约 31 倍时长（11 秒 → 345 秒），给到 60 倍再兜一个下限。
#: ⚠️ 这个上限是**必需的**：素材拉不到时上游既不出片也不报错（实测 31 分钟
#: 仍 running），没有上限就会把 job 永远钉在 running，之后该项目再也提交不了
#: 同组任务。
_TIMEOUT_FACTOR = 60.0
_TIMEOUT_MIN_SEC = 180.0
_TIMEOUT_MAX_SEC = 1800.0

#: 观测到的「平台已经完成」的状态集合。
_DONE = {"completed"}
#: 终态里的失败型。
_FAILED = {"failed", "error", "cancelled", "canceled", "timeout"}


def _timeout_for(dur: float) -> float:
    return min(_TIMEOUT_MAX_SEC, max(_TIMEOUT_MIN_SEC, dur * _TIMEOUT_FACTOR))


def _ratio_box(x: float, y: float, w: float, h: float) -> dict:
    """比例框（x,y,w,h）→ 火山要的 (top_left_x, top_left_y, bottom_right_x, bottom_right_y)。

    **这是唯一换算点。** 前端全程存 0–1 比例（与 `MosaicParams` 同坐标系），
    火山收的也是比例，所以这里只做「左上角 + 宽高」→「左上 + 右下」。

    夹进画面并保证非退化：越界坐标上游会 400，而 w/h 为 0 的退化成零面积框
    在 `MIN_REGION_SIZE` 挡不住的边角情况下真的能算出来。
    """
    x0 = max(0.0, min(1.0, float(x)))
    y0 = max(0.0, min(1.0, float(y)))
    x1 = max(0.0, min(1.0, x0 + max(0.0, float(w))))
    y1 = max(0.0, min(1.0, y0 + max(0.0, float(h))))
    if x1 - x0 < 1e-3:
        x1 = min(1.0, x0 + 1e-3)
    if y1 - y0 < 1e-3:
        y1 = min(1.0, y0 + 1e-3)
    return {"top_left_x": round(x0, 4), "top_left_y": round(y0, 4),
            "bottom_right_x": round(x1, 4), "bottom_right_y": round(y1, 4)}


def build_body(video_url: str, regions: list[dict], dur: float) -> dict:
    """把该镜的全部待擦块拼成请求体。

    `regions` 元素形如 `{t0, t1, x, y, w, h}`（`t0/t1` 是**镜头输出秒**，
    与 `desub` 存的口径一致，范围 0..dur）。

    两种情况：
      · 所有块的时间并集覆盖全片、且只有一个框 → 传**全局框**（最简，也最省心）；
      · 否则 → 传 `time_segment_filter`。

    全局框与分时段框**不能同时出现**（实测 400），所以这里是二选一，
    不是"都传上去让上游自己挑"。
    """
    if not regions:
        # 空 = 让火山自动识别整条。
        return {"video_url": video_url, "model_version": MODEL_VERSION, "mode": "Text"}

    boxes = {(r["x"], r["y"], r["w"], r["h"]) for r in regions}
    covers_all = (len(boxes) == 1
                  and min(float(r["t0"]) for r in regions) <= 0.05
                  and max(float(r["t1"]) for r in regions) >= dur - 0.05)
    if covers_all:
        r = regions[0]
        return {"video_url": video_url, "model_version": MODEL_VERSION,
                "mode": "Text",
                "erase_ratio_location": [_ratio_box(r["x"], r["y"], r["w"], r["h"])]}

    segs = []
    for r in sorted(regions, key=lambda z: float(z["t0"])):
        a = max(0.0, min(dur, float(r["t0"])))
        b = max(a + 0.05, min(dur, float(r["t1"])))
        segs.append({"start_time": round(a, 3), "end_time": round(b, 3),
                     "erase_ratio_location": [
                         _ratio_box(r["x"], r["y"], r["w"], r["h"])]})
    return {"video_url": video_url, "model_version": MODEL_VERSION, "mode": "Text",
            "time_segment_filter": {"mode": "selected", "segments": segs}}


class MediaKitEraseProvider(MediaKitUpscaleProvider):
    """把一条视频交给火山字幕擦除（精细版），返回落盘并贴上原音轨的本地地址。

    继承只因**素材发布、取件、合音轨**这三段与画质增强逐字相同（同一把 key、
    同一个桶、同一种无音轨产物的处理）。工具名、请求体、超时策略都不同。
    """

    def __init__(self, *, poll_interval: float = POLL_INTERVAL_SEC,
                 poll_max: int | None = None, timeout: float = 120.0) -> None:
        super().__init__(poll_interval=poll_interval, poll_max=poll_max,
                         timeout=timeout)
        self.model_id = "mediakit-erase-pro"

    @property
    def available(self) -> bool:
        """只要配了 MediaKit key 就可用。不再有第二把凭据。"""
        return bool((get_settings().mediakit_api_key or "").strip())

    async def _publish_seg(self, video_url: str) -> tuple[Path, str, str]:
        """发到桶里换成公网直链；前缀用去字幕自己的。"""
        from .. import storage
        from ..media import ensure_local_async

        src = await ensure_local_async(str(video_url))
        if src is None or not Path(src).is_file():
            raise RuntimeError(f"待擦除素材不可用: {video_url}")
        src = Path(src)
        if not storage.enabled():
            raise RuntimeError("火山通道需要对象存储（素材要公网可拉）；FW_TOS_* 未配置")
        rel = f"{_SRC_PREFIX}/{uuid.uuid4().hex}.{src.suffix.lstrip('.') or 'mp4'}"
        await asyncio.to_thread(storage.put_file, src, rel)
        return src, storage.public_url(rel, ttl=_SRC_URL_TTL_SEC), rel

    async def erase(self, video_url: str, regions: list[dict], *,
                    dur: float, on_progress=None) -> dict:
        """擦一条镜头。

        `regions` 见 `build_body`；`dur` 是**源文件时长**（用来拼时间分段与算超时）。

        返回 `{ok, video_url, task_id, error, elapsed}`。`video_url` 是
        `/fw/media/generated/xxx.mp4`，调用方拿它去 `ensure_local_async`。
        """
        from ..media import _probe_duration

        out = {"ok": False, "video_url": None, "task_id": "",
               "error": None, "elapsed": 0.0}
        task_id = ""
        rel = ""
        src: Path | None = None
        try:
            src, public, rel = await self._publish_seg(video_url)
            real_dur = float(await _probe_duration(src) or 0.0)
            if real_dur <= 0:
                raise RuntimeError("读不出素材时长，无法估算超时与分段")
            dur = real_dur if dur <= 0 else min(dur, real_dur)

            body = build_body(public, regions, dur)
            s = get_settings()
            base = (s.mediakit_base_url
                    or "https://mediakit.cn-beijing.volces.com/api/v1").rstrip("/")
            key = (s.mediakit_api_key or "").strip()
            hdr = {"Authorization": f"Bearer {key}"}

            c = http.get(base, timeout=self.timeout)
            r = await c.post(f"{base}/tools/erase-video-subtitle-pro",
                             json=body, headers=hdr)
            d = self._json(r)
            if r.status_code // 100 != 2 or not d.get("success", True):
                msg = self._err(d, r, "erase create")
                raise RuntimeError(msg)
            task_id = str(d.get("task_id") or "")
            if not task_id:
                raise RuntimeError(f"提交成功但没拿到 task_id：{str(d)[:200]}")
            out["task_id"] = task_id
            out["mode"] = ("global" if "erase_ratio_location" in body
                           else "segments" if "time_segment_filter" in body
                           else "auto")

            limit = _timeout_for(dur)
            waited = 0.0
            lost = 0
            while waited < limit:
                await asyncio.sleep(self.poll_interval)
                waited += self.poll_interval
                if on_progress is not None:
                    try:
                        on_progress(min(0.95, waited / limit))
                    except Exception:            # noqa: BLE001
                        pass
                st, raw = await self._status(base, key, task_id)
                if not st:
                    lost += 1
                    if lost >= _LOST_STREAK:
                        raise RuntimeError("火山平台上已查不到这个任务（可能已被清理）")
                    continue
                lost = 0
                if st in _DONE:
                    url = ((raw.get("result") or {}).get("video_url") or "").strip()
                    if not url:
                        raise RuntimeError("火山任务完成但没有产物地址")
                    local = await self._download(url)
                    try:
                        local = await self._mux_source_audio(local, src)
                    except Exception as e:       # noqa: BLE001
                        # 画面已出、已计费，不能因为音频合不上整条作废。
                        logger.warning("[desub] 合音轨失败，交付无声产物：%r", e)
                        out["audio_missing"] = str(e)[:160]
                    out.update(ok=True, elapsed=round(waited, 1),
                               video_url=f"/fw/media/generated/{local.name}",
                               remote_url=url)
                    return out
                if st in _FAILED:
                    raise RuntimeError(f"火山任务 {st}：{self._err(raw, None, st)}")
            # 超时：主动取消，别让上游继续计费。
            await self.cancel(base, key, task_id)
            raise RuntimeError(f"等待超过 {int(limit)} 秒仍未出片，已取消任务")

        except Exception as e:                   # noqa: BLE001
            out["error"] = human_error(e)
            return out
        finally:
            if rel:
                self._cleanup(rel)

    # ---- 小工具（父类那几个方法与本次调用无关，这里只补两个）----
    @staticmethod
    def _json(r: httpx.Response) -> dict:
        try:
            d = r.json()
        except Exception:                        # noqa: BLE001
            return {}
        return d if isinstance(d, dict) else {}

    @staticmethod
    def _err(d: dict, r: httpx.Response | None, prefix: str) -> str:
        e = d.get("error") if isinstance(d.get("error"), dict) else None
        if e:
            code = e.get("code") or ""
            msg = (e.get("message") or "").strip()
            return f"{code}: {msg}"[:300] if msg else str(code)[:300]
        if r is not None:
            return f"{prefix} HTTP {r.status_code}: {r.text[:200]}"
        return prefix

    async def _status(self, base: str, key: str, task_id: str) -> tuple[str, dict]:
        c = http.get(base, timeout=self.timeout)
        r = await c.get(f"{base}/tasks/{task_id}",
                        headers={"Authorization": f"Bearer {key}"})
        if r.status_code == 404:
            return "", {}
        if r.status_code // 100 != 2:
            return "", {}
        d = self._json(r)
        return str(d.get("status") or "").lower(), d

    async def cancel(self, base: str, key: str, task_id: str) -> bool:
        try:
            c = http.get(base, timeout=self.timeout)
            r = await c.delete(f"{base}/tasks/{task_id}",
                               headers={"Authorization": f"Bearer {key}"})
            return r.status_code // 100 == 2
        except Exception:                        # noqa: BLE001
            return False
