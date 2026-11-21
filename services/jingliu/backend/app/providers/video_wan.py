"""阿里云百炼 万相 wan3.0 视频生成 Provider（2026-11-02 接入，官方 key）。

协议（官方文档「万相 3.0 视频生成 API 参考」，北京地域）：
- 提交: POST {base}/services/aigc/video-generation/video-synthesis
        头 `X-DashScope-Async: enable`，body={model, input:{prompt, media:[{type,url}]},
        parameters:{resolution, ratio, duration, audio, seed, prompt_extend, watermark}}
- 查询: GET  {base}/tasks/{task_id}，output.task_status ∈
        PENDING / RUNNING / SUCCEEDED / FAILED / CANCELED / UNKNOWN；成功时 output.video_url
        （**24 小时有效**，必须立即下载）。usage.output_video_duration = 计费秒数。
- 取消: POST {base}/tasks/{task_id}/cancel，只对 PENDING 有效（同方舟只能撤排队中的）。

素材组合（官方「素材组合」一节，传其他组合直接报错）：
  · first_frame / last_frame 与 reference_* **互斥**——首尾帧模式不能带参考图/音频
  · 只有「仅首帧」「首帧+尾帧」两种帧模式，**没有仅尾帧**（故 l2va 不可用）
  · reference_image（≤10）/ reference_audio（≤5 段、总长 ≤15 秒）可自由组合

提示词：沿用 seedance2 框架（用户裁定）。框架产出的 `@图片N` / `@音频N` 在这里
改写成万相的引用写法「图 N」「音频 N」（图和音频各自从 1 计数，顺序 = media 数组顺序，
与我们下发顺序一致）。`prompt_extend` 关掉：框架已经写好了完整提示词，
让百炼再改写一遍会冲掉台词/时间轴。

计费：按输出秒数 × 分辨率档（pricing.wan_cost）。失败任务官方不收费。
"""
from __future__ import annotations

import asyncio
import logging
import math
import re
import uuid

from ..config import get_settings
from . import http
from ..media import GENERATED_DIR
from ..media_store import commit_async
from .base import (AudioMode, VideoProvider, VideoRequest, VideoResult, VisualMode,
                   sanitize_video_prompt, to_public_url)

log = logging.getLogger(__name__)

WAN_MODEL_ID = "wan3.0-video"
_WAN_ASPECTS = ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"]
_MAX_IMAGES = 10
_MAX_AUDIOS = 5
_MAX_AUDIO_TOTAL_SEC = 15.0
#: 连续查询失败容忍次数。与 seedance 同理：查询失败 ≠ 任务失败，远端照跑照收费，
#: 守住同一个 task_id 轮询到底，别抛出去让 jobs.py 重提一条新任务。
_MAX_QUERY_ERRORS = 4

_CJK = r"[一-鿿\w）)」”]"


def wan_prompt(text: str) -> str:
    """seedance2 框架的引用写法 → 万相写法。

    `林倩@图片1` → `林倩（图 1）`；独立的 `@图片1` / `图片1` → `图 1`；
    `@音频2` / `音频2` → `音频 2`。幂等：已经是「图 1」的不再改。
    """
    t = text or ""
    t = re.sub(rf"(?<={_CJK})@图片\s*(\d+)", r"（图 \1）", t)
    t = re.sub(r"@?图片\s*(\d+)", r"图 \1", t)
    t = re.sub(r"@?音频\s*(\d+)", r"音频 \1", t)
    return t


class WanVideoProvider(VideoProvider):
    """万相 wan3.0（百炼异步任务通道）。音画一体，支持首帧/首尾帧/全能参考（图+音频）。"""

    label = "万相 wan3.0"

    def __init__(self, model_id: str = WAN_MODEL_ID, *, min_duration: int = 2,
                 max_duration: int = 30, poll_interval: float = 15.0,
                 poll_max: int = 120) -> None:
        self.model_id = model_id
        self.visual_mode = VisualMode.reference
        self.audio_mode = AudioMode.inline
        # 官方 duration 取 [2, 30] 整数（2026-11-02 实测传 1 被拒）。
        self.min_duration = int(min_duration)
        self.max_duration = int(max_duration)
        self.duration_slots = list(range(self.min_duration, self.max_duration + 1))
        self.supports_last_frame = True
        self.aspect_ratios = list(_WAN_ASPECTS)
        self.max_reference_images = _MAX_IMAGES
        self.max_input_images = _MAX_IMAGES
        self.supports_reference_audio = True
        self.max_reference_audios = _MAX_AUDIOS
        # 官方支持参考视频（≤5 段/总 15 秒），但上传通道与 @视频N 编号都没接，如实声明 False
        self.supports_reference_video = False
        self.uses_ark_trusted_assets = False
        self.prompt_framework = "seedance2"
        #: 提示词里认 `@图片N` 编号（由本 provider 改写成「图 N」）。jobs.py 据此给优化器
        #: 下发编号对照表、把裸名字绑成编号——与官方 seedance 同一条路径。
        self.at_ref_syntax = True
        self.supported_resolutions = ["480p", "720p", "1080p"]
        self.poll_interval = poll_interval
        self.poll_max = poll_max

    def resolution_for(self, megapixels: float | None) -> str | None:
        """与 submit() 的映射同一份（与 seedance 同口径）。"""
        mp = megapixels or 0.9
        return "480p" if mp <= 0.5 else "720p" if mp <= 1.2 else "1080p"

    def mode_support(self) -> dict[str, dict]:
        """帧模式不能带参考音频（与 reference_* 互斥）；没有「仅尾帧」。"""
        return {
            "t2va": {"available": True, "reference_audio": True},
            "i2va": {"available": True, "reference_audio": False},
            "fl2va": {"available": True, "reference_audio": False},
            "l2va": {"available": False, "reference_audio": False,
                     "reason": "万相不支持只给尾帧"},
            "full_reference": {"available": True, "reference_audio": True,
                               "reference_video": False},
        }

    def _cfg(self) -> tuple[str, str]:
        s = get_settings()
        key = (s.wan_api_key or "").strip()
        if not key:
            raise RuntimeError("FW_WAN_API_KEY 未配置")
        return key, s.wan_base_url.rstrip("/")

    @staticmethod
    async def _audio_media(req: VideoRequest, cap: int) -> list[dict]:
        """参考音频：≤cap 段，**总长 ≤15 秒**（官方硬限，超了整单报错）。

        按下发顺序累加，放不下的那段及之后的都不带（顺序 = 「音频 N」编号，
        跳着带会让编号错位）。测不出时长的按 15 秒算——宁可少带一段。
        """
        from ..media import probe_duration_local
        urls = list(req.reference_audio_urls or [])
        if not urls and req.reference_audio_url:
            urls = [req.reference_audio_url]
        out: list[dict] = []
        total = 0.0
        for u in urls[:cap]:
            try:
                d = await probe_duration_local(u)
            except Exception:  # noqa: BLE001
                d = 0.0
            d = d if d > 0 else _MAX_AUDIO_TOTAL_SEC
            if total + d > _MAX_AUDIO_TOTAL_SEC + 1e-6:
                log.warning("[wan] 参考音频总长将超 15 秒，第 %d 段起不带", len(out) + 1)
                break
            pub = to_public_url(u)
            if not pub:
                break
            out.append({"type": "reference_audio", "url": pub})
            total += d
        return out

    async def build_body(self, req: VideoRequest) -> tuple[dict, dict]:
        """组请求体。返回 (body, meta)。拆出来是为了验收脚本能不联网地检查组合规则。"""
        # 向上取整：镜头时长由剪辑方案定，宁长不短（8.4s 截成 8s 会吃掉末尾台词）
        seconds = int(math.ceil((req.duration_ms or 5000) / 1000 - 1e-6))
        seconds = max(self.min_duration, min(self.max_duration, seconds))
        resolution = self.resolution_for(req.megapixels)
        aspect = req.aspect_ratio if req.aspect_ratio in _WAN_ASPECTS else "9:16"
        prompt = sanitize_video_prompt(req.prompt.strip()) or req.prompt.strip()

        media: list[dict] = []
        if req.first_frame_url:
            # 帧模式：与参考图/音频互斥，只能「首帧」或「首帧+尾帧」
            media.append({"type": "first_frame", "url": to_public_url(req.first_frame_url)})
            if req.last_frame_url:
                media.append({"type": "last_frame", "url": to_public_url(req.last_frame_url)})
            if req.reference_image_urls or req.reference_audio_urls or req.reference_audio_url:
                log.info("[wan] 首帧模式不能带参考图/音频（官方互斥），已不带")
        else:
            refs = [to_public_url(u) for u in (req.reference_image_urls or [])]
            refs = [u for u in refs if u]
            if len(refs) > _MAX_IMAGES:
                log.warning("[wan] 参考图 %d 张超上限 %d，截掉多余的", len(refs), _MAX_IMAGES)
            media += [{"type": "reference_image", "url": u} for u in refs[:_MAX_IMAGES]]
            media += await self._audio_media(req, self.max_reference_audios)
        n_aud = sum(1 for m in media if m["type"] == "reference_audio")
        if n_aud and not re.search(r"音频\s*\d", prompt):
            # 只送音频不点名，模型可能把它当背景音（seedance 同款经验）
            prompt = prompt.rstrip().rstrip("。") + "。整个视频主角的音色参考音频1。"
        prompt = wan_prompt(prompt)

        params = {"resolution": resolution.upper(), "duration": seconds, "audio": True,
                  "prompt_extend": False, "watermark": False,
                  "ratio": "adaptive" if req.first_frame_url else aspect}
        if req.seed is not None and 0 <= int(req.seed) <= 2147483647:
            params["seed"] = int(req.seed)
        inp: dict = {"prompt": prompt[:20000]}
        if media:
            inp["media"] = media
        body = {"model": self.model_id, "input": inp, "parameters": params}
        meta = {"resolution": resolution, "duration": seconds, "ratio": params["ratio"],
                "media": [m["type"] for m in media]}
        return body, meta

    async def submit(self, req: VideoRequest) -> VideoResult:
        key, base = self._cfg()
        if req.reference_video_url:
            return VideoResult(status="failed", error="万相通道暂未接入参考视频")
        if req.last_frame_url and not req.first_frame_url:
            return VideoResult(status="failed", error="万相不支持只给尾帧（需要同时给首帧）")
        body, meta = await self.build_body(req)
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                   "X-DashScope-Async": "enable"}
        try:
            c = http.get(base, timeout=120.0)
            r = await c.post(f"{base}/services/aigc/video-generation/video-synthesis",
                             headers=headers, json=body)
        except Exception as e:  # noqa: BLE001
            return VideoResult(status="failed", error=f"提交失败: {e!r}")
        try:
            d = r.json()
        except ValueError:
            d = {}
        tid = ((d.get("output") or {}).get("task_id")) if isinstance(d, dict) else None
        if r.status_code != 200 or not tid:
            return VideoResult(status="failed",
                               error=f"HTTP {r.status_code}: {d.get('code', '')} "
                                     f"{str(d.get('message') or r.text)[:300]}")
        tid = str(tid)

        from .. import usage as _usage
        # 派发即记账：用户取消时还能知道这条任务发出去了、按多少秒估
        _usage.record_dispatch("video", task_id=tid, model_id=self.model_id,
                               channel="dashscope", resolution=meta["resolution"],
                               media_seconds=meta["duration"])
        qfail = 0
        cancel_tried = False
        for _ in range(self.poll_max):
            await asyncio.sleep(self.poll_interval)
            if not cancel_tried and _usage.cancel_requested():
                cancel_tried = True
                if await self._cancel_pending(tid, key, base):
                    _usage.settle_dispatch_free("video", task_id=tid, model_id=self.model_id,
                                                channel="dashscope", reason="排队中被取消")
                    return VideoResult(status="failed", task_id=tid, error="已取消",
                                       raw={**meta, "cancelled": True})
                log.info("[wan] 任务 %s 已开跑、无法取消，继续守到出片", tid)
            try:
                st = await self._query(tid, key, base)
            except Exception as e:  # noqa: BLE001
                qfail += 1
                log.warning("[wan] 查询失败 %d/%d（task=%s）：%s",
                            qfail, _MAX_QUERY_ERRORS, tid, e)
                if qfail >= _MAX_QUERY_ERRORS:
                    return VideoResult(status="failed", task_id=tid,
                                       error=f"连续 {qfail} 次查询失败: {e!r}", raw=meta)
                continue
            qfail = 0
            if st["status"] == "SUCCEEDED" and st.get("video_url"):
                # 先记账再取片：远端已出片计费，取片失败改变不了这一点
                self._record_usage(tid, meta, st.get("usage"), ok=True)
                for attempt in range(_MAX_QUERY_ERRORS):
                    try:
                        local = await self._download(st["video_url"])
                        secs = self._out_seconds(st.get("usage"), meta)
                        return VideoResult(status="done", task_id=tid, video_url=local,
                                           duration_ms=int(secs * 1000),
                                           raw={**meta, "usage": st.get("usage")})
                    except Exception as e:  # noqa: BLE001
                        log.warning("[wan] 取片失败 %d/%d（task=%s）：%s",
                                    attempt + 1, _MAX_QUERY_ERRORS, tid, e)
                        if attempt < _MAX_QUERY_ERRORS - 1:
                            await asyncio.sleep(min(10.0, 2.0 ** attempt))
                return VideoResult(status="failed", task_id=tid,
                                   error="出片成功但下载失败（已在远端计费，"
                                         "片子地址 24 小时内有效，可重试本镜）", raw=meta)
            if st["status"] in ("FAILED", "CANCELED", "UNKNOWN"):
                # 官方：失败任务不收费
                self._record_usage(tid, meta, None, ok=False)
                return VideoResult(status="failed", task_id=tid,
                                   error=f"任务 {st['status']}: {st.get('reason', '')[:200]}",
                                   raw=meta)
        return VideoResult(status="failed", task_id=tid,
                           error=f"轮询超时(>{int(self.poll_interval * self.poll_max)}s)",
                           raw=meta)

    @staticmethod
    def _out_seconds(u: object, meta: dict) -> float:
        """计费秒数：官方 usage.output_video_duration，缺了按请求时长。"""
        u = u if isinstance(u, dict) else {}
        try:
            v = float(u.get("output_video_duration") or u.get("duration") or 0)
        except (TypeError, ValueError):
            v = 0.0
        return v if v > 0 else float(meta.get("duration") or 0)

    def _record_usage(self, task_id: str, meta: dict, u: object, ok: bool) -> None:
        from .. import usage
        secs = self._out_seconds(u, meta) if ok else 0.0
        usage.record("video", model_id=self.model_id, channel="dashscope", ok=ok,
                     task_id=task_id, media_seconds=secs,
                     resolution=meta.get("resolution"),
                     cost_fen=None if ok else 0,
                     meta={"task_id": task_id, "ratio": meta.get("ratio"),
                           "media": meta.get("media")})

    @staticmethod
    async def _cancel_pending(task_id: str, key: str, base: str) -> bool:
        """只撤 PENDING（排队中）的任务；已开跑的撤不掉，返回 False。"""
        try:
            st = await WanVideoProvider._query(task_id, key, base)
            if st.get("status") != "PENDING":
                return False
            c = http.get(base, timeout=30.0)
            r = await c.post(f"{base}/tasks/{task_id}/cancel",
                             headers={"Authorization": f"Bearer {key}"})
            return r.status_code == 200
        except Exception as e:  # noqa: BLE001 —— 取消不成就当没取消，继续守
            log.warning("[wan] 取消任务 %s 失败：%r", task_id, e)
            return False

    @staticmethod
    async def _query(task_id: str, key: str, base: str) -> dict:
        c = http.get(base, timeout=60.0)
        r = await c.get(f"{base}/tasks/{task_id}", headers={"Authorization": f"Bearer {key}"})
        if r.status_code != 200:
            raise RuntimeError(f"查询 HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        out = d.get("output") or {}
        return {"status": str(out.get("task_status") or "").upper(),
                "video_url": out.get("video_url"),
                "usage": d.get("usage"),
                "reason": f"{out.get('code') or ''} {out.get('message') or ''}".strip()}

    @staticmethod
    async def _download(remote: str) -> str:
        name = f"wan_{uuid.uuid4().hex[:12]}.mp4"
        dest = GENERATED_DIR / name
        c = http.get("download", timeout=600.0, follow_redirects=True)
        try:
            async with c.stream("GET", remote) as resp:
                resp.raise_for_status()
                with dest.open("wb") as w:
                    async for chunk in resp.aiter_bytes(1024 * 256):
                        w.write(chunk)
        except BaseException:
            dest.unlink(missing_ok=True)     # 半截文件不能留给巡检当成片传进桶
            raise
        return await commit_async(dest)

    async def poll(self, task_id: str) -> VideoResult:
        key, base = self._cfg()
        st = await self._query(task_id, key, base)
        if st["status"] == "SUCCEEDED" and st.get("video_url"):
            local = await self._download(st["video_url"])
            return VideoResult(status="done", task_id=task_id, video_url=local)
        if st["status"] in ("FAILED", "CANCELED", "UNKNOWN"):
            return VideoResult(status="failed", task_id=task_id, error=st.get("reason"))
        return VideoResult(status="running", task_id=task_id)
