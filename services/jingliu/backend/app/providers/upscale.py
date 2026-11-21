"""RunningHub 高清放大（超分）通道 —— SeedVR2 工作流。

与 `video_runninghub.py` 的关系：**同一种提交协议，不同的工作流**。
那边是"文/图生视频"（三条 H3 工作流，节点号各不相同），这边是"把已有素材
放大一档"（SeedVR2 一条工作流）。两条业务的输入语义、计费方式、产物性质
都不一样（这边不花 token 花**机时**），所以独立成文件，只共用协议层。

## 与视频生成通道的三处关键差异

1. **提交时带完整工作流 JSON**（`workflow` 字段），不只是 workflowId。
   实测（2026-09）：只传 `workflow` 会被平台以 `code=301 must not be null`
   拒掉 —— `workflowId` 是**必填凭据**；但补上任意一个**本账号私有**的
   workflowId 之后，真正执行的是 `workflow` 里的那张图。于是这条工作流
   不必先复制保存进我们账号，用配置里的占位 id 即可提交。
   （对照：`providers/tts.py` 记的 810 WORKFLOW_NOT_SAVED_OR_NOT_RUNNING，
   正是"工作流非本账号私有"时**仅传 workflowId** 会踩到的坑。）
2. **只有一个输入槽**：`#16 VHS_LoadVideo.video` = 上传返回的 fileName。
   没有提示词、没有 seed（工作流里 seed 是固定值 610948117，放大是确定性
   任务，不需要每次换 seed）。
3. **输出节点固定是 `#72 VHS_VideoCombine`**，`audio` 直接接 `["16", 2]`
   —— 源音轨**原样透传**（不是重新编码的音轨）。实测产物 h264 + aac
   32000Hz，与源一致。

## 实测标定（2026-09，plus 机型）

| 输入 | 结果 |
|---|---|
| 720×1280 / 24fps / 48帧 / 2.000s | 1088×1934 / 24fps / 48帧 / 2.000s |
| 机时 | `taskCostTime=139` 秒，`consumeMoney=0.232` |

推论：`#71 Int` 的 1088 是**短边目标**（720 → 1088，长边按比例 1280→1934）。
时长与帧率**逐帧不变**，这是后面敢不调 `reset_clip_window` 的前提。
按 `0.232 / 139s` 反推 ≈ **¥6/h**，与 `runninghub_instance_type=plus`
（48G，¥6/h）的定价吻合。

## 为什么轮询同样无限期

见 `submit()` 的注释。放大长镜是**分钟级到小时级**的任务（8s 片段 ≈ 21 分钟，
15s ≈ 42 分钟，按 2s/139s 线性外推），主动判超时会把"排队慢"记成"失败"，
而这一次失败是**已经付过机时**的。与视频通道同一条纪律。
"""
from __future__ import annotations

import asyncio
import logging
import math
import shutil
import uuid
from pathlib import Path

import httpx

from ..config import get_settings
from ..media import GENERATED_DIR
from .video_runninghub import DEFAULT_INSTANCE_TYPE, resolve_instance_type
from ..err_text import human_error, upload_failed_msg
from . import http

logger = logging.getLogger(__name__)

#: 取成品的重试次数（2026-10-08）。取片是幂等的——只是把远端文件拉回来，
#: 不产生新的生成费用；而失败后去 cancel 一个**已经 SUCCESS 并计费**的任务，
#: 既省不下钱、又把这件已付费的成品丢掉。故宁可多试几次。
_MAX_DOWNLOAD_RETRIES = 4

# ---- 工作流节点映射（SeedVR2）----
# ⚠️ 与 H3 那三条工作流一样：节点号/字段名是**这条工作流专属**的，
# 不可与 MODE_NODES 里的任何一套混用。用错节点号会被平台以
# NODE_INFO_MISMATCH 拒绝；用错**字段名**更隐蔽——平台照收，节点值不变，
# 等于静默丢掉输入（在这里就是"上传了但放大的是别的东西 / 静默用默认视频"）。
#
# 本文件里这三个常量已由 2026-09 的一次真实端到端跑通反证（产物 1088×1934、
# 48 帧、含音轨），不是从 JSON 里抄来就完事的推断。
INPUT_NODE = "16"          # VHS_LoadVideo
INPUT_FIELD = "video"      # 唯一的输入槽
RESOLUTION_NODE = "71"     # Int —— 目标**短边**边长
RESOLUTION_FIELD = "value"
OUTPUT_NODE = "72"         # VHS_VideoCombine

#: 目标短边边长。1088 = 1088×1920 的 16:9 档短边，也是工作流作者的取值。
#: 4K 是 2160，1080p 是 1080 —— 1088 略高于 1080p，是常见的超分目标档。
#: 不按项目画幅自动换算：短边决定的是**放大倍数**而非画幅，各画幅按同一短边
#: 目标跑出来的清晰度观感一致，换算反而会让我们在某些画幅上花更多机时。
TARGET_SHORT_EDGE = 1088

#: 单段上限（秒）。超过就先切段、全部并发放大、再按序拼回（用户裁定 2026-10-18）。
#: 近百秒整条一次放大要近两小时、且一次失败全部重来；30s 一段则墙钟≈最长那段。
SEGMENT_MAX_SEC = 30.0
#: 单段失败自动重跑的次数。RunningHub 失败不收费（用户裁定），重跑不多花钱。
_SEG_RETRY = 1

#: 所有片段都还没上过平台（放大是产线末端的新动作），所以一律走上传。
#: 这个常量只是保留 upload 与直接复用平台文件名的分叉口，
#: 语义与 `video_runninghub._to_remote_name` 一致（`api/` 前缀 = 平台已有）。
_REMOTE_PREFIX = "api/"

_VIDEO_MIME = {".mp4": "video/mp4", ".mov": "video/quicktime",
               ".webm": "video/webm", ".mkv": "video/x-matroska"}


class UpscaleProvider:
    """把一个本地视频交给 SeedVR2 工作流放大，返回落盘后的本地地址。

    刻意**不**实现 `VideoProvider` 接口：那个接口的语义是"按请求生成一段新的
    视频"（要提示词、要时长、要画幅），而放大不需要其中任何一项。硬套上去会
    让调用方以为可以传提示词和时长，而它们在这里是被忽略的。
    """

    def __init__(self, *, instance_type: str | None = None,
                 poll_interval: float = 15.0, poll_max: int | None = None,
                 timeout: float = 120.0) -> None:
        self.poll_interval = poll_interval
        #: 轮询上限：**默认不设**（无限期等平台给结论），理由见模块头。
        #: 传正整数可恢复有限轮询，仅测试用。
        self.poll_max = poll_max
        self.timeout = timeout
        self._instance_type_override = instance_type
        self.model_id = "runninghub-seedvr2"

    # ---- 凭据 ----
    def _creds(self) -> tuple[str, str]:
        s = get_settings()
        key = (s.runninghub_api_key or "").strip()
        if not key:
            raise RuntimeError("FW_RUNNINGHUB_API_KEY 未配置")
        return key, (s.runninghub_base_url or "https://www.runninghub.cn").rstrip("/")

    @property
    def workflow_id(self) -> str:
        """占位 workflowId。

        平台要求这个字段非空，**真正执行的是 `workflow` 那张图**（实测）。
        默认是本账号保存的 SeedVR2 工作流（2026-10-18 起；此前借用 H3 的 id，
        后台因此把高清任务全记在「海螺 H3」名下）。留空时本功能判定为不可用。
        """
        s = get_settings()
        return (getattr(s, "runninghub_upscale_workflow_id", "") or "").strip()

    @property
    def available(self) -> bool:
        """key 与占位 workflowId 齐全才可用（缺一个都是提交必失败）。"""
        try:
            self._creds()
        except RuntimeError:
            return False
        return bool(self.workflow_id)

    @property
    def instance_type(self) -> str:
        """生效机型，永不为空（空串 → DEFAULT_INSTANCE_TYPE，即 plus）。"""
        if self._instance_type_override is not None:
            return resolve_instance_type(self._instance_type_override)
        return resolve_instance_type(get_settings().runninghub_instance_type)

    # ---- 工作流图 ----
    def _graph(self, remote_name: str) -> dict:
        """构造提交用的 ComfyUI graph（prompt 格式，带 class_type）。

        每次**深拷贝式重建**而不是改一个模块级 dict：`_graph` 的返回值会被
        直接 JSON 序列化发出去，而多个镜头是并发提交的（同一个 asyncio 事件
        循环里交错执行）。共用一个可变字典 = 一个镜头的输入槽会串到另一个
        镜头上去，症状是"放大的不是我传的那条视频"，而且并发下时有时无。
        """
        n = TARGET_SHORT_EDGE
        return {
            "12": {"inputs": {"video_info": ["16", 3]},
                   "class_type": "VHS_VideoInfoSource",
                   "_meta": {"title": "Video Info (Source) 🎥🅥🅗🅢"}},
            "16": {"inputs": {"video": remote_name, "force_rate": 0,
                              "force_size": "Disabled", "custom_width": 0,
                              "custom_height": 0, "frame_load_cap": 0,
                              "skip_first_frames": 0, "select_every_nth": 1,
                              "format": "AnimateDiff"},
                   "class_type": "VHS_LoadVideo",
                   "_meta": {"title": "Load Video (Upload) 🎥🅥🅗🅢"}},
            "26": {"inputs": {"text": "15.0", "anything": ["12", 2]},
                   "class_type": "easy showAnything",
                   "_meta": {"title": "Show Any"}},
            "65": {"inputs": {"model": "seedvr2_ema_7b_fp16.safetensors",
                              "seed": 610948117, "new_resolution": ["71", 0],
                              "batch_size": 21, "images": ["16", 0],
                              "block_swap_config": ["66", 0],
                              "extra_args": ["67", 0]},
                   "class_type": "SeedVR2",
                   "_meta": {"title": "SeedVR2 Video Upscaler"}},
            "66": {"inputs": {"blocks_to_swap": 32, "use_non_blocking": True,
                              "offload_io_components": False},
                   "class_type": "SeedVR2BlockSwap",
                   "_meta": {"title": "SeedVR2 BlockSwap Config"}},
            "67": {"inputs": {"tiled_vae": True, "vae_tile_size": 512,
                              "vae_tile_overlap": 64, "preserve_vram": True,
                              "cache_model": True, "enable_debug": True},
                   "class_type": "SeedVR2ExtraArgs",
                   "_meta": {"title": "SeedVR2 Extra Args"}},
            "71": {"inputs": {"value": n}, "class_type": "Int",
                   "_meta": {"title": "Int"}},
            "72": {"inputs": {"frame_rate": ["12", 0], "loop_count": 0,
                              "filename_prefix": "AnimateDiff",
                              "format": "video/h264-mp4", "pix_fmt": "yuv420p",
                              "crf": 19, "save_metadata": True,
                              "trim_to_audio": False, "pingpong": False,
                              "save_output": True, "no_preview": False,
                              "images": ["65", 0], "audio": ["16", 2]},
                   "class_type": "VHS_VideoCombine",
                   "_meta": {"title": "Video Combine 🎥🅥🅗🅢"}},
        }

    # ---- 素材上传 ----
    async def upload(self, local: Path | str) -> str:
        """上传本地视频，返回平台 fileName（形如 api/xxx.mp4）。"""
        key, base = self._creds()
        local = Path(local)
        if not local.exists():
            raise RuntimeError(f"待上传素材不存在: {local}")
        mime = _VIDEO_MIME.get(local.suffix.lower(), "application/octet-stream")
        # ⚠️ **不要 `read_bytes()` 整文件读进内存**（2026-10-24 独立复核后改）。
        #
        # 原来这里是 `raw = await asyncio.to_thread(local.read_bytes)`：
        # 那一步确实解决了"同步读阻塞事件循环"，但**内存问题一点没解决** ——
        # 整份素材仍驻留在内存里，直到 httpx 发完。
        #
        # 实测（27.8 MB 样本，模拟 150 个上传同时在途）：
        #   read_bytes() 150 份在途 → RSS 增量 **+4176 MB**
        #   传文件对象  150 份在途 → RSS 增量 **    +1 MB**
        # 差 4176 倍。而生产 `video_concurrency` 默认 **300**，素材 p90 19MB、
        # 最大 26MB：300 × 20MB ≈ 6 GB 起，叠上 multipart 的副本就是十几 GB。
        # 生产 41.8 GB RSS、637 个 64MB 满驻留块，正是这个形态
        # （不是 glibc malloc 参数的问题 —— 那只是让它"不还给 OS"，不是它涨这么大）。
        #
        # httpx 的 `FileField.render_data()` 本来就是**分块读**（CHUNK_SIZE=64KB）：
        # 只要传进去的是文件对象，它就不会把整份读进内存。改法只是把
        # `raw` 换成打开的文件句柄，语义完全不变。
        #
        # 上传超时放宽到 300s：实测片段 p90 约 19MB、最大 26MB（平台单文件上限
        # 30MB），120s 的默认超时在慢出口上会把一次正常上传判成失败。
        with open(local, "rb") as fh:
            async with http.client("upscale-upload", timeout=max(self.timeout, 300.0)) as c:
                r = await c.post(f"{base}/task/openapi/upload",
                                 data={"apiKey": key, "fileType": "video"},
                                 files={"file": (local.name, fh, mime)})
        if r.status_code != 200:
            # ⚠️ 报错必须**自带诊断信息**（2026-10-15）。此前只带 `r.text[:200]`，
            #    而 550 这种非标准码的上游响应**没有 body**，用户看到的就是
            #    `RH upload HTTP 550: ` 后面一片空白——查不出任何东西。
            #    非标准码的语义往往只留在响应头里（CDN/WAF 拒绝会在
            #    Server / CF-Ray / X-* 上留痕），所以把关键头一起带上。
            raise RuntimeError(upload_failed_msg(r, "视频"))
        d = r.json()
        if d.get("code") != 0:
            raise RuntimeError(f"RH upload error: {d.get('msg')}")
        fn = (d.get("data") or {}).get("fileName")
        if not fn:
            raise RuntimeError(f"RH upload 未返回 fileName: {str(d)[:200]}")
        return str(fn)

    async def to_remote_name(self, url_or_path: "str | Path") -> str:
        """本地地址 → 平台 fileName；已是平台文件名（api/ 前缀）则直接复用。

        也接受**本地文件路径**（`Path`）：切段放大时，切出来的段只在工作目录里，
        没有 /fw/media 地址。"""
        if isinstance(url_or_path, Path):
            if not url_or_path.is_file():
                raise RuntimeError(f"待放大素材不存在: {url_or_path}")
            return await self.upload(url_or_path)
        if url_or_path.startswith(_REMOTE_PREFIX):
            return url_or_path
        from ..media import ensure_local_async
        local = await ensure_local_async(url_or_path)
        if local is None or not local.exists():
            raise RuntimeError(f"待放大素材不可用: {url_or_path}")
        return await self.upload(local)

    # ---- 提交 / 状态 / 产出 ----
    async def create(self, remote_name: str) -> tuple[str, dict]:
        """提交放大任务，返回 (task_id, 生效参数摘要)。"""
        import json as _json
        key, base = self._creds()
        wf = self.workflow_id
        if not wf:
            raise RuntimeError("高清放大工作流未配置（runninghub_upscale_workflow_id 为空）")
        graph = self._graph(remote_name)
        payload = {
            "apiKey": key,
            # workflowId 是**必填凭据**（缺了报 code=301 must not be null），
            # 但真正执行的是 workflow 里的图 —— 所以这里传占位 id。
            "workflowId": wf,
            "workflow": _json.dumps(graph, ensure_ascii=False),
            "nodeInfoList": [{"nodeId": INPUT_NODE, "fieldName": INPUT_FIELD,
                              "fieldValue": remote_name}],
        }
        # instanceType 传非法值时平台**静默忽略**降级到默认机；"default" 不是
        # 平台认的取值，它表示"就用默认那台 24G 机"，故这一档不带该字段。
        inst = self.instance_type
        if inst and inst != "default":
            payload["instanceType"] = inst
        async with http.client("upscale-submit", timeout=self.timeout) as c:
            r = await c.post(f"{base}/task/openapi/create", json=payload)
        if r.status_code != 200:
            raise RuntimeError(f"RH create HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        if d.get("code") != 0:
            raise RuntimeError(
                f"RH create error: {d.get('msg')} {str(d.get('data'))[:200]}")
        data = d.get("data") or {}
        tid = data.get("taskId") if isinstance(data, dict) else None
        if not tid:
            raise RuntimeError(f"RH create 未返回 taskId: {str(d)[:200]}")
        return str(tid), {"instance_type": inst,
                          "target_short_edge": TARGET_SHORT_EDGE,
                          "output_node": OUTPUT_NODE}

    async def status(self, task_id: str) -> str:
        key, base = self._creds()
        # ⚠️ 用共享客户端，不要每轮 `async with httpx.AsyncClient(...)`（2026-10-24）。
        # 构造一次约 42ms 且**是同步的**（重读 CA 证书包 + 建 SSL 上下文），
        # 即使 AsyncClient 本身是异步的，构造它并不让出事件循环。
        # 而 status 是轮询驱动：每 poll_interval（默认 15s）查一次，
        # 一次放大要查几十上百次 —— 等于每 15 秒在事件循环上白烧 42ms。
        # 见 providers/http.py 模块头（那里有 2026-10-21 的 py-spy 现场证据）。
        c = http.get(base, timeout=self.timeout)
        r = await c.post(f"{base}/task/openapi/status",
                         json={"apiKey": key, "taskId": task_id})
        if r.status_code != 200:
            raise RuntimeError(f"RH status HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        if d.get("code") != 0:
            raise RuntimeError(f"RH status error: {d.get('msg')}")
        return str(d.get("data") or "").upper()

    async def outputs(self, task_id: str) -> list[dict]:
        """取产出条目（**保留整条**，不只是 url）。

        与视频通道只取 url 不同：这条工作流的 outputs 里带 `taskCostTime` 与
        `consumeMoney`，是**机时与金额的唯一来源**。放大按机时计费，
        不记下来用户就无从判断"这一批花了多少钱"。
        """
        key, base = self._creds()
        c = http.get(base, timeout=max(self.timeout, 120.0))
        r = await c.post(f"{base}/task/openapi/outputs",
                         json={"apiKey": key, "taskId": task_id})
        if r.status_code != 200:
            raise RuntimeError(f"RH outputs HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        if d.get("code") != 0:
            raise RuntimeError(
                f"RH outputs error: {d.get('msg')} {str(d.get('data'))[:200]}")
        data = d.get("data") or []
        items: list[dict] = []
        if isinstance(data, list):
            for it in data:
                if isinstance(it, dict):
                    u = it.get("fileUrl") or it.get("url")
                    if u:
                        items.append({**it, "fileUrl": str(u)})
                elif isinstance(it, str):
                    items.append({"fileUrl": it})
        if not items:
            raise RuntimeError(f"RH outputs 无产出地址: {str(d)[:200]}")
        return items

    async def failure_detail(self, task_id: str) -> str:
        """取平台侧真实失败原因（节点名 + 异常信息），拿不到返回空串。"""
        try:
            key, base = self._creds()
            async with http.client("upscale-create", timeout=self.timeout) as c:
                r = await c.post(f"{base}/task/openapi/outputs",
                                 json={"apiKey": key, "taskId": task_id})
            fr = ((r.json().get("data") or {}) or {}).get("failedReason") or {}
            node = fr.get("node_name") or ""
            msg = (fr.get("exception_message") or fr.get("exception_type") or "").strip()
            if not (node or msg):
                return ""
            return f"节点 {node}: {msg[:200]}" if node else msg[:200]
        except Exception:  # noqa: BLE001 —— 诊断信息拿不到不该盖掉原始失败
            return ""

    async def cancel(self, task_id: str) -> bool:
        key, base = self._creds()
        try:
            async with http.client("upscale-cancel", timeout=self.timeout) as c:
                r = await c.post(f"{base}/task/openapi/cancel",
                                 json={"apiKey": key, "taskId": task_id})
            return r.status_code == 200 and r.json().get("code") == 0
        except Exception:  # noqa: BLE001
            return False

    def _dispatch(self, task_id: str) -> None:
        """记一行「已派发、未结算」。金额未知，作用是**证明机时开始烧了**。

        取消结算按 `now - 派发时刻` 收等待时长（RunningHub 按机时计费），
        这一行的 `ts` 就是唯一的派发时刻来源。见 `usage.record_dispatch`。
        """
        from .. import usage
        usage.record_dispatch("upscale", task_id=task_id, model_id="seedvr2",
                              channel="runninghub",
                              meta={"instance": self.instance_type,
                                    "target_short_edge": TARGET_SHORT_EDGE})

    async def _download(self, url: str) -> tuple[str, Path]:
        """把产物拉回 generated/，返回 (/fw/media/generated/xxx.mp4, 磁盘路径)。"""
        async with http.client("upscale-download", timeout=1800.0, follow_redirects=True) as c:
            r = await c.get(url)
        if r.status_code != 200:
            raise RuntimeError(f"下载放大产物失败 HTTP {r.status_code}")
        name = f"up_{uuid.uuid4().hex[:12]}.mp4"
        dest = GENERATED_DIR / name
        dest.write_bytes(r.content)
        return f"/fw/media/generated/{name}", dest

    # ---- 端到端：单个任务 ----
    async def _upscale_single(self, video_url: "str | Path") -> dict:
        """把一个文件作为**一个** RunningHub 任务放大，返回 {"ok", "video_url", "cost_sec", "money", "error"}。

        超过 `SEGMENT_MAX_SEC` 的视频不要直接走这里 —— 走 `upscale()`，它会先切段。

        **只认 RunningHub 的结论**：轮询无限期，直到平台报 SUCCESS 或 FAILED。
        我方不设时间上限、不主动 cancel —— 主动打断会把"排队慢"误记成"失败"，
        既丢了已经付费排队的算力，也污染判断依据。（与视频通道同一条纪律，
        见 `video_runninghub.submit`。）异常路径（网络/解析出错）才 cancel：
        那是我方出错，任务留在平台上无人认领只会白烧机时。
        """
        out: dict = {"ok": False, "video_url": None, "cost_sec": 0.0,
                     "money": None, "error": None}
        task_id = ""
        try:
            remote = await self.to_remote_name(video_url)
            task_id, meta = await self.create(remote)
            out.update(meta)
            # ---- 派发即记账（2026-10-16）----
            # 一行 `cost_fen=0` 的「已派发、未结算」记录。金额此刻确实还不知道，
            # 但它的用处不在金额，而在**证明这次机时真的开始烧了**：
            # 用户取消时结算要按 `now - ts` 收这段等待时长（RunningHub 按机时计费），
            # 而这条 `ts` 就是唯一的派发时刻。没有它，取消路径只能看到
            # `SUM(cost_fen)=0`（放大本来就没等到结论），于是把预扣全额退回去——
            # 机时烧了、账上一片空白。
            self._dispatch(task_id)
            n = 0
            #: 连续几次「平台查不到这个任务」才认定它已丢失（见下方说明）。
            _LOST_STREAK = 3
            lost = 0
            while self.poll_max is None or n < self.poll_max:
                n += 1
                await asyncio.sleep(self.poll_interval)
                # ---- 用户取消（2026-10-16）----
                # runner 的检查点拦不住**已派发**的这一个：不在这里看一眼，
                # 它会一直轮询到出片，机时烧满、取消形同虚设。
                # 取消接口只是"停止继续烧"，已烧掉的照收 —— 按用户裁定，
                # 收**派发至今的等待时长**（平台不给取消瞬间的已耗机时）。
                from .. import usage as _usage
                if _usage.cancel_requested():
                    await self.cancel(task_id)
                    fen = _usage.settle_dispatch_by_wait(
                        "upscale", task_id=task_id, model_id="seedvr2",
                        channel="runninghub")
                    out["error"] = "已取消"
                    out["cancelled"] = True
                    out["charged_fen"] = fen
                    return out
                st = await self.status(task_id)
                # ---- 平台已经查不到这个任务（2026-10-24）----
                # `status()` 返回 `str(d.get("data") or "").upper()`，data 为 null
                # 时得到空串。**空串不是一种"进行中"状态** —— 它意味着平台那边
                # 没有这个 taskId（平台清理 / 实例回收 / 任务压根没落库）。
                #
                # 原来的写法对空串什么都不做，`while self.poll_max is None`
                # 于是永远转下去：协程永不释放，job 停在 running，而
                # `find_active_job` 把 running 当"正在跑" —— 这个项目的 shots
                # 互斥组被一个永远没结论的任务永久占住，之后再也提交不了
                # 出片/去字幕/放大，且没有任何报错。与
                # `video_runninghub.submit` 同一处修正，两处必须同步。
                #
                # ⚠️ 这不是给"排队慢"设超时：真在排队的任务返回 QUEUED /
                # RUNNING 等非空状态，走不到这里。判据只有一条 ——
                # **平台已经不知道这个任务了**。
                if not st:
                    lost += 1
                    if lost >= _LOST_STREAK:
                        logger.warning("RH 放大任务 %s 连续 %d 次查不到状态，"
                                       "认定已丢失", task_id, lost)
                        self._settle_free(task_id, "平台查不到该任务")
                        out["error"] = ("RunningHub 平台上已查不到这个任务"
                                        "（可能已被平台清理或实例回收）。"
                                        "已停止等待，请重新提交。")
                        out["lost"] = True
                        return out
                else:
                    lost = 0
                if st == "SUCCESS":
                    items = await self.outputs(task_id)
                    # 产出节点可能不止一个（工作流里插了预览节点就会有）。
                    # 只认 OUTPUT_NODE（#72 VHS_VideoCombine）—— 那是唯一带
                    # 音轨的成品；预览节点给的是无声的中间帧序列。
                    pick = next((it for it in items
                                 if str(it.get("nodeId")) == OUTPUT_NODE), items[0])
                    # 用量：按平台回报的生成耗时计价（6 元/小时）。记在取片之前——
                    # 平台已出片计费，取片失败也改变不了这一点。
                    from .. import usage as _usage
                    _usage.record("upscale", model_id="seedvr2", channel="runninghub",
                                  gen_seconds=_as_float(pick.get("taskCostTime")),
                                  vendor_money=pick.get("consumeMoney"),
                                  task_id=task_id)
                    # ⚠️ 取成品必须自己容错，**不能**让它落到下面那个 except
                    #    （2026-10-08 修）。下面那个 except 执行的是
                    #    `await self.cancel(task_id)` —— 而此刻任务已经 **SUCCESS**：
                    #    平台已经跑完（SeedVR2 约 139 秒 GPU／2 秒片段）、
                    #    已经计费。取消一个已完成的任务既省不下钱，还把这件
                    #    已付费的成品一起丢掉，用户看到的是"失败"。
                    #    取片是**幂等**的（只是把远端文件拉回来），退避重试即可。
                    local = None
                    for dl in range(_MAX_DOWNLOAD_RETRIES):
                        try:
                            local, _ = await self._download(pick["fileUrl"])
                            break
                        except Exception as e:  # noqa: BLE001
                            logger.warning("放大取片失败 %d/%d（task=%s）：%s",
                                           dl + 1, _MAX_DOWNLOAD_RETRIES, task_id, e)
                            if dl < _MAX_DOWNLOAD_RETRIES - 1:
                                await asyncio.sleep(min(10.0, 2.0 ** dl))
                    if local is None:
                        # 片子已产出、已计费 —— 把远端地址交回去，别再取消任务
                        return {**out, "ok": False, "task_id": task_id,
                                "remote_url": pick["fileUrl"],
                                "error": "放大已完成但下载失败（已在平台计费，"
                                         "可用上述远端地址取回）"}
                    out.update(ok=True, video_url=local, task_id=task_id,
                               remote_url=pick["fileUrl"],
                               cost_sec=_as_float(pick.get("taskCostTime")),
                               money=(pick.get("consumeMoney")
                                      if pick.get("consumeMoney") is not None else None))
                    return out
                if st in {"FAILED", "ERROR", "CANCELED", "CANCELLED"}:
                    detail = await self.failure_detail(task_id)
                    out["error"] = (f"RunningHub 任务 {st}" +
                                    (f"：{detail}" if detail else ""))
                    # RH 失败不收（用户裁定 2026-10-16）。必须**显式**结算成 0：
                    # 放着不管的派发行会被取消结算当成"在途"、按等待时长收。
                    self._settle_free(task_id, f"RH {st}")
                    return out
                if n % 20 == 0:      # 每 5 分钟记一次，便于观察长镜排队
                    logger.info("RH 放大任务 %s 仍在 %s，已等待 %.0f 分钟",
                                task_id, st, n * self.poll_interval / 60)
        except Exception as e:  # noqa: BLE001
            if task_id:
                await self.cancel(task_id)
                self._settle_free(task_id, "我方异常")
            out["error"] = human_error(e)
            return out
        if task_id:
            await self.cancel(task_id)
            self._settle_free(task_id, "轮询达到上限")
        out["error"] = f"轮询达到显式上限 {self.poll_max} 次，已取消任务"
        return out

    # ---- 端到端：对外入口（长视频切段并发）----
    async def upscale(self, video_url: str, on_progress=None) -> dict:
        """放大一条视频。**超过 `SEGMENT_MAX_SEC` 的先切段、全部并发、再按序拼回。**

        ## 为什么切段（用户裁定 2026-10-18）

        近百秒的整集一次交给 SeedVR2：按实测 2s ≈ 139s 机时线性外推，94s 要跑
        近两小时，而且这期间任何一次失败都是**整条重来**。切成若干个 ≤30s 的段
        同时跑：墙钟时间≈最长那一段，一段失败只重跑那一段。机时总量不变
        （按秒计费，不会因为切段多花钱）。

        ## 拼接为什么不会错位

          · **按帧号切**：N 帧均分成 k 段，每段精确到帧（不是按秒切——按秒切在
            非整帧边界上会多一帧或少一帧，拼回去时长就对不上 `_DUR_TOLERANCE_SEC`）；
          · 放大是逐帧的（帧数、帧率不变，见模块头实测），所以段的帧数原样保留；
          · 拼回时**只拼画面**，音轨直接取**原视频完整音轨**：各段各自重编码的
            音频首尾有编码器填充，直接接会在段与段之间留下咔哒/空隙。

        `on_progress(done, total)`：每完成一段回调一次（只有切段时才有意义）。
        返回结构与 `_upscale_single` 相同，另加 `segments`（段数）。
        """
        if isinstance(video_url, str) and video_url.startswith(_REMOTE_PREFIX):
            return await self._upscale_single(video_url)
        from ..media import WORK_DIR, _probe_duration, ensure_local_async
        src = await ensure_local_async(video_url)
        if src is None or not src.is_file():
            return {"ok": False, "video_url": None, "cost_sec": 0.0, "money": None,
                    "error": f"待放大素材不可用: {video_url}"}
        dur = await _probe_duration(src)
        if dur <= SEGMENT_MAX_SEC + 0.5:
            r = await self._upscale_single(video_url)
            return {**r, "segments": 1}

        frames, fps = await _probe_frames(src)
        if frames <= 0 or fps <= 0:
            return {"ok": False, "video_url": None, "cost_sec": 0.0, "money": None,
                    "error": "读不出视频的帧数/帧率，无法切段放大"}
        k = max(2, math.ceil(dur / SEGMENT_MAX_SEC))
        work = WORK_DIR / f"upseg_{uuid.uuid4().hex[:10]}"
        work.mkdir(parents=True, exist_ok=True)
        done = 0
        lock = asyncio.Lock()
        try:
            parts = await _split_by_frames(src, frames, fps, k, work)
            logger.info("[upscale] %s：%.1fs / %d 帧 → 切成 %d 段并发放大",
                        src.name, dur, frames, len(parts))
            if on_progress:
                on_progress(0, len(parts))

            async def _seg(i: int, part: Path) -> dict:
                nonlocal done
                r: dict = {}
                for attempt in range(1 + _SEG_RETRY):
                    r = await self._upscale_single(part)
                    if r.get("ok") or r.get("cancelled"):
                        break
                    logger.warning("[upscale] 第 %d/%d 段失败（第 %d 次）：%s",
                                   i + 1, len(parts), attempt + 1, r.get("error"))
                async with lock:
                    done += 1
                    if on_progress:
                        try:
                            on_progress(done, len(parts))
                        except Exception:  # noqa: BLE001 进度回调不该影响放大
                            pass
                return r

            rs = await asyncio.gather(*(_seg(i, p) for i, p in enumerate(parts)))
            cost = sum(float(r.get("cost_sec") or 0) for r in rs)
            money = sum(_as_float(r.get("money")) for r in rs)
            base = {"video_url": None, "cost_sec": cost, "money": money or None,
                    "segments": len(parts),
                    "task_ids": [r.get("task_id") for r in rs if r.get("task_id")]}
            if any(r.get("cancelled") for r in rs):
                return {**base, "ok": False, "cancelled": True, "error": "已取消"}
            bad = [(i, r) for i, r in enumerate(rs) if not r.get("ok")]
            if bad:
                i, r = bad[0]
                return {**base, "ok": False,
                        "error": (f"{len(parts)} 段中有 {len(bad)} 段放大失败"
                                  f"（第 {i + 1} 段：{r.get('error') or '未知原因'}）；"
                                  "已完成的段已按机时计费")}
            outs = [GENERATED_DIR / Path(r["video_url"]).name for r in rs]
            name = f"up_{uuid.uuid4().hex[:12]}.mp4"
            await _concat_with_source_audio(outs, src, GENERATED_DIR / name, work)
            for o in outs:                      # 段产物是中间件，拼完就删
                o.unlink(missing_ok=True)
            return {**base, "ok": True, "video_url": f"/fw/media/generated/{name}",
                    "error": None}
        except Exception as e:  # noqa: BLE001
            logger.warning("[upscale] 切段放大异常：%r", e)
            return {"ok": False, "video_url": None, "cost_sec": 0.0, "money": None,
                    "error": human_error(e)}
        finally:
            shutil.rmtree(work, ignore_errors=True)

    @staticmethod
    def _settle_free(task_id: str, reason: str) -> None:
        from .. import usage
        usage.settle_dispatch_free("upscale", task_id=task_id, model_id="seedvr2",
                                   channel="runninghub", reason=reason)


def _as_float(v) -> float:
    """平台把耗时/金额都当**字符串**返回（"139" / "0.232"），解析失败给 0。"""
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# ---------------------------------------------------------------- 切段与拼接

async def _ff(*args: str) -> str:
    """跑 ffmpeg/ffprobe，失败抛 RuntimeError（带 stderr 末尾，便于排查）。"""
    p = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await p.communicate()
    if p.returncode != 0:
        raise RuntimeError(f"{args[0]} 失败：{err.decode(errors='ignore')[-300:]}")
    return out.decode(errors="ignore")


async def _probe_frames(path: Path) -> tuple[int, float]:
    """(帧数, 帧率)。帧数用 count_packets 实数，不信容器头里的 nb_frames（常缺/不准）。"""
    out = await _ff("ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
                    "-show_entries", "stream=nb_read_packets,r_frame_rate",
                    "-of", "default=nw=1", str(path))
    kv = dict(l.split("=", 1) for l in out.splitlines() if "=" in l)
    try:
        num, den = kv.get("r_frame_rate", "0/1").split("/")
        fps = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        fps = 0.0
    try:
        frames = int(kv.get("nb_read_packets") or 0)
    except ValueError:
        frames = 0
    return frames, fps


async def _split_by_frames(src: Path, frames: int, fps: float, k: int,
                           work: Path) -> list[Path]:
    """把 `src` 按帧号均分成 `k` 段（每段帧数相差至多 1），逐段重编码。

    重编码而不是 `-c copy`：copy 只能切在关键帧上，段长就不受控了（可能超 30s），
    而且起止帧对不齐。码率封顶是为了守住平台单文件 30MB 上传上限
    （30s × 6Mbps ≈ 22.5MB + 音频）；放大前的这一次轻度重编码对最终画质无可见影响。
    """
    edges = [round(frames * i / k) for i in range(k + 1)]
    parts: list[Path] = []
    for i in range(k):
        a, b = edges[i], edges[i + 1]           # 本段 = 帧 [a, b)
        if b <= a:
            continue
        dst = work / f"seg_{i:03d}.mp4"
        await _ff("ffmpeg", "-v", "error", "-y", "-i", str(src),
                  "-vf", f"select='between(n\\,{a}\\,{b - 1})',setpts=N/({fps})/TB",
                  "-af", f"atrim=start={a / fps:.6f}:end={b / fps:.6f},asetpts=PTS-STARTPTS",
                  "-vsync", "passthrough",   # 旧版 ffmpeg（本机 4.x）不认 -fps_mode
                  "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
                  "-maxrate", "6M", "-bufsize", "12M", "-pix_fmt", "yuv420p",
                  "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(dst))
        got, _ = await _probe_frames(dst)
        if got != b - a:
            raise RuntimeError(f"切段帧数不对：第 {i + 1} 段应为 {b - a} 帧，实得 {got}")
        parts.append(dst)
    return parts


async def _concat_with_source_audio(parts: list[Path], src: Path, dest: Path,
                                    work: Path) -> None:
    """按序拼接放大后的各段画面（不重编码），音轨取原视频完整音轨（不重编码）。"""
    lst = work / "concat.txt"
    lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
    await _ff("ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
              "-i", str(src), "-map", "0:v:0", "-map", "1:a:0?",
              "-c", "copy", "-movflags", "+faststart", str(dest))


# ---------------------------------------------------------------- 渠道选择

def pick_upscale_provider():
    """按 `FW_UPSCALE_CHANNEL` 选一条超分通道；选中那条不可用则返回 None。

    取值：`mediakit`（默认，火山标准版 1080P）| `runninghub`（SeedVR2）。

    ## 为什么是"选一条"而不是"失败自动换另一条"

    与 `pick_asr_provider`（asr.py）同一条纪律：**通道故障应当报错让人知道，
    不是悄悄换一个产出不同结果的东西**。这里的差异更具体 ——

      · SeedVR2 输出**短边 1088**、比例随源、产物自带音轨；
      · MediaKit 输出**固定 1920×1080**、产物没有音轨（由我们 mux 回原片音轨）。

    同一批片子静默换渠道，用户的观感会不一致（清晰度档位、构图裁切都不同），
    而账单价也不同（机时 vs 时长）。所以只按配置走，不可用就返回 None，
    调用方报"未配置高清放大通道"。

    ## 这是运维开关，不是用户选项

    界面上没有任何入口能改它。火山出问题（额度、审核、上游故障）时，
    改一个环境变量重启即可切回 SeedVR2。
    """
    from ..config import get_settings
    ch = (getattr(get_settings(), "upscale_channel", "") or "mediakit").strip().lower()
    if ch == "runninghub":
        p = UpscaleProvider()
    else:
        from .upscale_mediakit import MediaKitUpscaleProvider
        p = MediaKitUpscaleProvider()
    return p if p.available else None
