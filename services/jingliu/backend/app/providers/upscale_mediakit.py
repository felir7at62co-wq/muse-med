"""火山 AI MediaKit 画质增强（标准版）通道 —— 视频超分到 1080P。

## 与 `upscale.py`（RunningHub SeedVR2）的关系

**鸭子接口一致，协议完全不同。** 两者都提供

    .available                    → bool
    await .upscale(video_url, on_progress=None) -> dict

所以调用方 `upscale_jobs._one()` 只换一行实例化即可（见 `pick_upscale_provider`）。
不实现 `VideoProvider`：那个接口的语义是"按请求生成一段新视频"（要提示词、要时长、
要画幅），超分不需要其中任何一项 —— 理由同 `upscale.py` 的类文档。

## 三处关键差异（换渠道时必须知道）

| 维度 | RunningHub SeedVR2 | 火山 MediaKit 标准版 |
|---|---|---|
| 输入 | 上传文件拿平台 fileName | **必须公网可拉的 URL**（我们传 TOS 再给预签名直链） |
| 计费 | 按**机时** ¥6/h | 按**输出时长** 0.0125 元/秒（用户裁定 2026-11-09） |
| 音轨 | 产物自带（源音轨透传） | **产物没有音轨** —— 必须由我们 mux 回原片音轨 |
| 输出规格 | 短边 1088（比例不变） | 1920×1080 等固定档（`resolution` 枚举） |
| 处理时长 | ~70 倍 RTF | ≤20s 片子 ~22 倍，长片 6–10 倍 |

## 为什么音轨要自己合（实测）

火山 `result.video_url` 下载下来是**纯视频流**：`ffprobe` 只看到一个 h264 stream，
没有 audio。这不是我们参数没传对 —— 官方产物就是画面。
对成片来说无声即废片，所以这里用 ffmpeg `-c copy` 把**原视频的完整音轨**贴回去：

    ffmpeg -y -i <放大产物> -i <原片> -map 0:v:0 -map 1:a:0? -c copy -movflags +faststart

实测开销：8 秒 1080p 片子 **0.09 秒 / 峰值 53 MB**。因为 `-c copy` 不重编码，
只是把音轨字节复制进新容器，与视频时长基本无关。
`-map 1:a:0?` 的问号让**源片本来就没音轨**时静默跳过，退化成纯画面产物而不报错。

## 为什么轮询不设上限

与 `upscale.py` 同一条纪律：主动超时会把"排队慢"记成"失败"，而那次失败
可能已经在上游计费。真在排队时平台返回 `running`，不会误判。
判据只有"平台已经不认识这个任务了"（连续多次查不到），而不是"等了太久"。

实现见模块末尾的 `_MEDIAKIT_*` 常量与 `MediaKitUpscaleProvider`。
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from pathlib import Path

import httpx

from ..config import get_settings
from ..media import GENERATED_DIR
from ..err_text import human_error
from . import http

logger = logging.getLogger(__name__)

#: 轮询间隔（秒）。实测一条 8 秒片子约 164 秒完成，10 秒一查足够灵敏，
#: 又不会把上游打得太密（与官方"建议配置事件回调"的替代方案）。
POLL_INTERVAL_SEC = 10

#: 连续几次"平台查不到这个任务"才认定它已丢失。
#: 单次空响应可能是瞬时抖动；连续 3 次（30 秒）才下结论。
_LOST_STREAK = 3

#: 取件重试次数。取件是幂等操作（只是下载），失败退避重试即可 ——
#: 此刻上游**已经计费**，不能因为网络抖动把已付费的产物丢掉。
_MAX_DOWNLOAD_RETRIES = 4

#: 源素材在 TOS 上的保留时长。覆盖"排队 + 处理"即可（164 秒实测，长片按小时算）。
#: 用完即删，不留垃圾。
_SRC_URL_TTL_SEC = 6 * 3600

#: 上传到 TOS 的前缀（相对 DATA_DIR）。与 drama_asr 的 `drama-asr/` 分开，
#: 清理脚本可以按前缀整体回收。
_SRC_PREFIX = "upscale-src"

#: 火山画质增强的输入分辨率硬限制（官方文档）：短边 360–1440、长边 360–2560。
#: 超出会被上游拒。这里只用于**提前给出人话错误**，不做自动缩放
#: （缩小再放大等于二次损失，宁可拒绝也不要静默降质）。
_MIN_SHORT, _MAX_SHORT = 360, 1440
_MIN_LONG, _MAX_LONG = 360, 2560


class MediaKitUpscaleProvider:
    """把一条视频交给火山 AI MediaKit 标准版画质增强，返回落盘后的本地地址。"""

    def __init__(self, *, poll_interval: float = POLL_INTERVAL_SEC,
                 poll_max: int | None = None, timeout: float = 120.0) -> None:
        self.poll_interval = poll_interval
        #: 轮询上限：**默认不设**（无限期等平台给结论），理由见模块头。仅测试用。
        self.poll_max = poll_max
        self.timeout = timeout
        self.model_id = "mediakit-enhance"

    # ---- 凭据与配置 ----
    @staticmethod
    def _cfg() -> tuple[str, str, str, str]:
        """(key, base, resolution, scene)。缺 key 抛 RuntimeError。"""
        s = get_settings()
        key = (s.mediakit_api_key or "").strip()
        if not key:
            raise RuntimeError("FW_MEDIAKIT_API_KEY 未配置")
        base = (s.mediakit_base_url
                or "https://mediakit.cn-beijing.volces.com/api/v1").rstrip("/")
        return (key,
                base,
                (s.mediakit_resolution or "1080p").strip(),
                (s.mediakit_scene or "aigc").strip())

    @property
    def available(self) -> bool:
        """配了 key 就可提交（其余参数都有默认值）。"""
        try:
            self._cfg()
        except RuntimeError:
            return False
        return True

    @property
    def resolution(self) -> str:
        try:
            return self._cfg()[2]
        except RuntimeError:
            return ""

    # ---- 素材准备：本地文件 → 公网可拉的预签名直链 ----
    async def _publish(self, video_url: "str | Path") -> tuple[Path, str, str]:
        """把素材放到公网可拉的位置，返回 (本地源文件, 预签名直链, 桶内相对路径)。

        MediaKit **不接受文件上传**，只吃 URL。所以必须先把素材放进对象存储，
        拿一个带签名的直链给它。复用 `app.storage` 现成能力（TOS 已迁完，
        本地盘只是缓存）。

        ⚠️ 预签名链接里带签名，**不要写进日志**（`storage.presign` 的值含
        X-Tos-Signature）。
        """
        from ..media import ensure_local_async
        from .. import storage

        src = await ensure_local_async(str(video_url))
        if src is None or not Path(src).is_file():
            raise RuntimeError(f"待放大素材不可用: {video_url}")
        src = Path(src)
        if not storage.enabled():
            raise RuntimeError(
                "火山通道需要对象存储（素材要公网可拉）；FW_TOS_* 未配置")

        rel = f"{_SRC_PREFIX}/{uuid.uuid4().hex}.{src.suffix.lstrip('.') or 'mp4'}"
        await asyncio.to_thread(storage.put_file, src, rel)
        url = storage.public_url(rel, ttl=_SRC_URL_TTL_SEC)
        return src, url, rel

    @staticmethod
    def _cleanup(rel: str) -> None:
        """删桶内源素材。失败只记日志 —— 清理失败不该让一次成功的放大变成失败。"""
        try:
            from .. import storage
            storage.delete(rel)
        except Exception as e:  # noqa: BLE001
            logger.warning("[mediakit] 源素材清理失败 %s: %r", rel, e)

    # ---- 提交 / 查询 / 取件 ----
    async def create(self, public_url: str) -> tuple[str, dict]:
        """提交画质增强任务，返回 (task_id, 生效参数摘要)。"""
        key, base, resolution, scene = self._cfg()
        body = {"video_url": public_url, "scene": scene, "resolution": resolution}
        c = http.get(base, timeout=self.timeout)
        r = await c.post(f"{base}/tools/enhance-video", json=body,
                         headers={"Authorization": f"Bearer {key}"})
        d = _json(r)
        if r.status_code // 100 != 2 or not d.get("success", True):
            raise RuntimeError(_err(d, r, "mediakit create"))
        tid = d.get("task_id")
        if not tid:
            raise RuntimeError(f"mediakit create 未返回 task_id: {str(d)[:200]}")
        return str(tid), {"resolution": resolution, "scene": scene,
                          "tool_version": "standard"}

    async def status(self, task_id: str) -> tuple[str, dict]:
        """(status, 原始响应)。status 已小写；查不到任务时为空串。"""
        key, base, _res, _scene = self._cfg()
        c = http.get(base, timeout=self.timeout)
        r = await c.get(f"{base}/tasks/{task_id}",
                        headers={"Authorization": f"Bearer {key}"})
        d = _json(r)
        if r.status_code == 404:
            return "", {}
        if r.status_code // 100 != 2:
            raise RuntimeError(f"mediakit status HTTP {r.status_code}: {r.text[:200]}")
        return str(d.get("status") or "").lower(), d

    # ⚠️ 没有 `cancel()`：火山 AI MediaKit 这套 Bearer 接口**没有取消任务**。
    # 2026-11-21 实测 `DELETE /tasks/{id}` 返回 405，官方 CLI 也只有查询；文档里的
    # 「取消媒体处理任务」（KillJob）属于旧版 AK/SK 签名的智能处理接口，不是这一套。
    # 以前这里发的 DELETE 从没生效过：我们这边「已取消」，火山照样跑完、照样计费。

    async def _download(self, url: str) -> Path:
        """把产物拉回 generated/。返回本地磁盘路径。"""
        last: Exception | None = None
        for attempt in range(_MAX_DOWNLOAD_RETRIES):
            try:
                async with http.client("upscale-download", timeout=1800.0,
                                       follow_redirects=True) as c:
                    r = await c.get(url)
                if r.status_code != 200:
                    raise RuntimeError(f"下载放大产物失败 HTTP {r.status_code}")
                dest = GENERATED_DIR / f"up_{uuid.uuid4().hex[:12]}.mp4"
                dest.write_bytes(r.content)
                return dest
            except Exception as e:  # noqa: BLE001
                last = e
                logger.warning("[mediakit] 取片失败 %d/%d：%r",
                               attempt + 1, _MAX_DOWNLOAD_RETRIES, e)
                if attempt < _MAX_DOWNLOAD_RETRIES - 1:
                    await asyncio.sleep(min(10.0, 2.0 ** attempt))
        raise RuntimeError(f"放大已完成但下载失败：{last}")

    # ---- 音轨：把原片的完整音轨 mux 回火山产物 ----
    @staticmethod
    async def _mux_source_audio(video: Path, src: Path) -> Path:
        """把 `src` 的完整音轨贴到 `video` 上，原地替换并返回新路径。

        不重编码（`-c copy`）：实测 8 秒 1080p 只要 0.09 秒 / 53 MB，
        与视频时长基本无关。源片无音轨时 `-map 1:a:0?` 的问号让 ffmpeg
        静默跳过音频映射，产物保持纯画面 —— 不报错，也不伪造一条空音轨。
        """
        out = video.with_name(f"{video.stem}_a{video.suffix}")
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-v", "error", "-y",
            "-i", str(video), "-i", str(src),
            "-map", "0:v:0", "-map", "1:a:0?",
            "-c", "copy", "-movflags", "+faststart", str(out),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        _stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            msg = stderr.decode(errors="ignore")[-300:]
            raise RuntimeError(f"ffmpeg 合音轨失败：{msg}")
        if not out.is_file() or out.stat().st_size == 0:
            raise RuntimeError("ffmpeg 合音轨未产出文件")
        video.unlink(missing_ok=True)
        return out

    # ---- 记账 ----
    def _record(self, task_id: str, *, media_seconds: float,
                gen_seconds: float, ok: bool, free_reason: str = "") -> None:
        """记一行用量，**显式传 cost_fen**。

        ⚠️ 不传 `cost_fen` 的话，`usage.estimate_cost()` 里
        `category == "upscale"` 那条分支会按 **RunningHub 的机时单价**
        （¥6/h）给这一次估价 —— 那是另一条通道的价格，会多收一个数量级。
        """
        from .. import pricing
        from .. import usage
        try:
            if ok:
                fen = pricing.mediakit_upscale_cost(media_seconds)
                usage.record("upscale", model_id="mediakit-enhance",
                             channel="mediakit", ok=True,
                             gen_seconds=gen_seconds,
                             media_seconds=media_seconds,
                             cost_fen=fen, task_id=task_id,
                             meta={"resolution": self.resolution})
            else:
                usage.record("upscale", model_id="mediakit-enhance",
                             channel="mediakit", ok=False, cost_fen=0,
                             task_id=task_id,
                             meta={"free_reason": free_reason} if free_reason else None)
        except Exception:  # noqa: BLE001 —— 记账失败绝不影响生成
            logger.exception("[mediakit] 用量记账失败 task=%s", task_id)

    # ---- 端到端 ----
    async def upscale(self, video_url: "str | Path", on_progress=None) -> dict:
        """放大一条视频（整条提交，不切段）。

        返回：`{ok, video_url, cost_sec, money, error, cancelled, task_id, ...}`。
        `video_url` 是 `/fw/media/generated/xxx.mp4` —— 调用方 `_one()` 会拿它
        `ensure_local_async`，返回上游直链会在那一步失败。

        ## 为什么不切段

        RunningHub 要切段是因为它按 2s≈139s 机时的线性外推、百秒片子要跑两小时，
        且失败要整条重来。火山是 ≤20s 约 22 倍、长片 6–10 倍，一条 60 秒的片子
        十几分钟就完；而且它是**按输出时长**计费，切段只会多出拼接开销与接缝风险。
        """
        from ..media import _probe_duration

        out: dict = {"ok": False, "video_url": None, "cost_sec": 0.0,
                     "money": None, "error": None, "segments": 1}
        task_id = ""
        rel = ""
        src: Path | None = None
        try:
            src, public_url, rel = await self._publish(video_url)
            dur = float(await _probe_duration(src) or 0.0)
            if dur <= 0:
                raise RuntimeError("读不出素材时长；火山按输出时长计费，无法报价")
            self._check_input_spec(dur)

            task_id, meta = await self.create(public_url)
            out.update(meta)
            out["media_seconds"] = dur

            from .. import usage as _usage
            _usage.record_dispatch("upscale", task_id=task_id,
                                   model_id="mediakit-enhance",
                                   channel="mediakit",
                                   resolution=meta.get("resolution"),
                                   media_seconds=dur,
                                   meta={"source": "mediakit"})

            t0 = asyncio.get_running_loop().time()
            n = 0
            lost = 0
            while self.poll_max is None or n < self.poll_max:
                n += 1
                await asyncio.sleep(self.poll_interval)

                # 用户取消：我们停止等待、不向用户收费。火山没有取消接口，
                # 已派发的任务会照样跑完 —— 这一笔由我们承担，记账原因里写明。
                if _usage.cancel_requested():
                    self._record(task_id, media_seconds=dur, gen_seconds=0.0,
                                 ok=False, free_reason="用户取消（火山不支持取消，任务仍会跑完）")
                    return {**out, "error": "已取消", "cancelled": True,
                            "charged_fen": 0}

                try:
                    st, raw = await self.status(task_id)
                except Exception as e:  # noqa: BLE001
                    # 一次没问到（网络抖动、5xx）不是失败：任务多半还在跑、还在计费。
                    logger.info("[mediakit] 查询任务 %s 没成，下一轮再查：%r", task_id, e)
                    continue
                if not st:
                    lost += 1
                    if lost >= _LOST_STREAK:
                        logger.warning("[mediakit] 任务 %s 连续 %d 次查不到，认定已丢失",
                                       task_id, lost)
                        self._record(task_id, media_seconds=dur, gen_seconds=0.0,
                                     ok=False, free_reason="平台查不到该任务")
                        return {**out,
                                "error": ("火山平台上已查不到这个任务"
                                          "（可能已被清理）。已停止等待，请重新提交。"),
                                "lost": True}
                else:
                    lost = 0

                if st == "completed":
                    gen = asyncio.get_running_loop().time() - t0
                    url = ((raw.get("result") or {}).get("video_url") or "").strip()
                    if not url:
                        self._record(task_id, media_seconds=dur, gen_seconds=gen,
                                     ok=False, free_reason="产物无 video_url")
                        return {**out, "error": "火山任务完成但没有产物地址"}
                    # 先记账再取件：平台已出片、已计费，取件失败改变不了这一点。
                    self._record(task_id, media_seconds=dur, gen_seconds=gen, ok=True)
                    local = await self._download(url)
                    # 火山产物没有音轨 —— 贴回原片音轨（实测 0.09s / 53MB）。
                    try:
                        local = await self._mux_source_audio(local, src)
                    except Exception as e:  # noqa: BLE001
                        # 画面已经产出并计费，不能因为音频合不上就整条作废。
                        # 如实降级：交回无声画面，并在 note 里说清楚。
                        logger.warning("[mediakit] 合音轨失败，返回无声产物：%r", e)
                        out["audio_missing"] = str(e)[:160]
                    from ..media_store import commit_async
                    return {**out, "ok": True,
                            "video_url": await commit_async(local),
                            "task_id": task_id, "remote_url": url,
                            "cost_sec": round(gen, 1)}

                if st in {"failed", "error", "cancelled", "canceled", "timeout"}:
                    detail = _err(raw, None, f"mediakit {st}")
                    self._record(task_id, media_seconds=dur, gen_seconds=0.0,
                                 ok=False, free_reason=f"mediakit {st}")
                    return {**out, "error": f"火山任务 {st}：{detail}"}

                if n % 30 == 0:          # 每 5 分钟记一次，便于观察排队
                    logger.info("[mediakit] 任务 %s 仍在 %s，已等待 %.0f 分钟",
                                task_id, st, n * self.poll_interval / 60)

            self._record(task_id, media_seconds=dur, gen_seconds=0.0,
                         ok=False, free_reason="轮询达到上限")
            return {**out, "error": f"轮询达到显式上限 {self.poll_max} 次，已停止等待"
                                    f"（火山不支持取消，任务号 {task_id}）"}

        except Exception as e:  # noqa: BLE001
            if task_id:
                self._record(task_id, media_seconds=float(out.get("media_seconds") or 0),
                             gen_seconds=0.0, ok=False, free_reason="我方异常")
            out["error"] = human_error(e)
            return out
        finally:
            if rel:
                self._cleanup(rel)

    # ---- 输入规格预检 ----
    @staticmethod
    def _check_input_spec(dur: float) -> None:
        """火山的分辨率硬限制（短边 360–1440、长边 360–2560）。

        只做**友好报错**，不自动缩放：缩小再放大是二次损失，宁可拒绝也不要
        静默把用户的片子降质。判定放在提交前 —— 提交后才报错仍然会占一次任务。
        """
        # 注：分辨率检查在 `_one()` 那边已有一道"必须真的变大"的断言兜底；
        # 这里只挡明显超出平台上限的长片（火山对超长素材会直接拒）。
        if dur > 3600:
            raise RuntimeError(f"素材 {dur:.0f} 秒过长，火山画质增强单次上限约 1 小时")


# ---------------------------------------------------------------- 小工具

def _json(r: httpx.Response) -> dict:
    try:
        d = r.json()
    except Exception:  # noqa: BLE001
        return {}
    return d if isinstance(d, dict) else {}


def _err(d: dict, r: httpx.Response | None, prefix: str) -> str:
    """把上游错误压成一句人话。**不含凭据**（签名/Authorization 一律不进来）。"""
    e = d.get("error") if isinstance(d.get("error"), dict) else None
    if e:
        code = e.get("code") or ""
        msg = (e.get("message") or "").strip()
        return f"{code}: {msg}"[:300] if msg else str(code)[:300]
    if isinstance(d.get("message"), str) and d["message"].strip():
        return d["message"].strip()[:300]
    if r is not None:
        return f"{prefix} HTTP {r.status_code}: {r.text[:200]}"
    return prefix
