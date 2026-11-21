"""自动字幕用的火山「大模型录音文件识别 · 极速版」（2026-11-21）。

和短剧云端转写（`drama_asr`）用的是**同一个火山语音应用**、同一份配置
（`FW_DRAMA_ASR_CONFIG`：`appId` / `accessToken`），也就是 Muse 转写用的那个应用：
请求与结果解析直接复用 `drama_asr._flash` / `_normalize`，这里只把它包成自动字幕要的
`transcribe(path) -> [ASRSegment]`。

极速版是同步接口：音频 base64 随请求发出、当场出结果，没有可查询的原任务，所以字幕只走极速版：
配置里 `routes.subtitles` 不是 `flash`（标准版要先进桶、再按任务号查询）时火山通道关闭，
`config_error` 写明原因。镜头音轨是 16 kHz 单声道 mp3，几十 KB；每一段先核对配置里的
`maxAudioBytes` 与 `maxDurationSeconds`，超了就不发。`drama_asr` 的每账号每日上限
（`maxDailyJobs` / `maxDailySeconds`）只管 `/v2/drama/asr/jobs` 的转写任务，字幕的调用不计入；
`auto_subtitles` 任务也不扣积分（`charge.py` 里报价为 0）。

结果每句一段（起止时间是秒，相对音频开头），逐字时间留在 `words` 里，这里不按它切行：
超过一行的句子由 `subtitle_jobs._split_cue` 按标点切开、时长在这一句里按字数分。百炼的长句在
`asr_bailian.split_long_sentence` 里按逐字时间切，它在攒满 `MAX_LINE_CHARS` 个字时就断开、
不回头找前面的标点（「今天我｜们」），所以不拿来切火山的句子。
火山判定没有人声（状态码 20000003），或者结果里没有一句话，都返回空列表。

`FW_DRAMA_ASR_CONFIG` 只从进程环境读（systemd 单元的 `Environment=` / `EnvironmentFile=`；
`Settings` 没有这一项，写在 `backend/.env` 里不生效），值是 JSON 配置文件的路径。文件不存在、写错（坏 JSON、缺 `appId`、值的类型不对）或者读不了（没有读文件、进目录的权限）时火山通道不可用：
`config_error` 说明原因（只有错误类型，不含配置里的值），同一个文件的同一种错误每个进程只记一次日志。
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from pathlib import Path

from .asr import ASRSegment

logger = logging.getLogger(__name__)

#: 已经记过日志的 (配置文件路径, 错误类型)：字幕任务与 `/v2/asr/status` 每次都重读配置
_logged_errors: set[tuple[str, str]] = set()
#: `drama_asr._normalize` 判定「结果里没有一句话」时的两种说法：这是没人说话，不是故障
_NO_SPEECH = ("no utterances", "no speech")


def _log_once(path: str, kind: str) -> None:
    if (path, kind) in _logged_errors:
        return
    _logged_errors.add((path, kind))
    logger.warning("[asr-volc] FW_DRAMA_ASR_CONFIG 配置文件 %s 不可用（%s），火山录音文件识别关闭", path, kind)


def _describe(err) -> str:
    """一次失败调用的公开分类字段，写成一句话（`flash timeout`、`flash http，HTTP 403，状态码 45000001`）。"""
    out = [f"{err.operation} {err.reason}"]
    if err.http_status:
        out.append(f"HTTP {err.http_status}")
    if err.provider_code:
        out.append(f"状态码 {err.provider_code}")
    if err.quota_type:
        out.append(f"配额 {err.quota_type}")
    return "，".join(out)


class VolcFlashASR:
    """火山极速版。`available` 为假时调用方换别的通道或报未配置；配置写错时 `config_error` 给出原因。"""

    name = "volc-flash"

    def __init__(self) -> None:
        from .. import drama_asr
        #: 配置了 `FW_DRAMA_ASR_CONFIG` 却用不了时的原因；没配或配好了为 None
        self.config_error: str | None = None
        path = os.environ.get("FW_DRAMA_ASR_CONFIG", "").strip()
        try:
            # 路径上有进不去的目录时 `is_file()` 抛 PermissionError（Python 3.12），所以也在 try 里
            if path and not Path(path).is_file():
                self.config_error = "FW_DRAMA_ASR_CONFIG 指向的文件不存在，详见服务日志"
                _log_once(path, "文件不存在")
            cfg = drama_asr.load_config()
        except Exception as e:  # noqa: BLE001  坏 JSON、缺字段、值的类型不对、没有读权限都只关掉火山通道，不能让别的通道跟着报错
            cfg = None
            self.config_error = f"FW_DRAMA_ASR_CONFIG 指向的配置文件读不了（{type(e).__name__}），详见服务日志"
            _log_once(path, type(e).__name__)
        if cfg and cfg.get("engine") == "volc" and cfg["routes"]["subtitles"] != "flash":
            cfg = None
            self.config_error = ("FW_DRAMA_ASR_CONFIG 的 routes.subtitles 不是 flash：自动字幕只用火山极速版，"
                                 "火山通道关闭")
            _log_once(path, "routes.subtitles 不是 flash")
        self._cfg = cfg if cfg and cfg.get("engine") == "volc" else None

    @property
    def available(self) -> bool:
        return self._cfg is not None

    async def transcribe(self, path: str | Path, language: str | None = None,
                         prompt: str | None = None) -> list[ASRSegment]:
        """转写一个本地音频文件。`language` / `prompt` 是别的通道用的，这里不需要。"""
        from .. import drama_asr, media
        if self._cfg is None:
            raise RuntimeError("未配置火山录音文件识别（FW_DRAMA_ASR_CONFIG）")
        p = Path(path)
        audio = p.read_bytes()
        if not audio:
            raise RuntimeError(f"音频文件为空: {p.name}")
        if len(audio) > self._cfg["maxAudioBytes"]:
            raise RuntimeError(f"音频超过单次上限（{len(audio) / 1024 / 1024:.1f}MB）")
        seconds = await media._probe_duration(p)
        if seconds <= 0:
            raise RuntimeError(f"读不出音频时长，没有提交火山识别: {p.name}")
        if seconds > self._cfg["maxDurationSeconds"]:
            raise RuntimeError(f"音频 {seconds:.0f} 秒，超过单段时长上限 {self._cfg['maxDurationSeconds']} 秒")
        try:
            result = await asyncio.to_thread(drama_asr._flash, self._cfg, str(uuid.uuid4()), audio)
        except drama_asr.ProviderError as e:
            # `_flash` 在 `except ValueError` 里抛 ProviderError，那个 ValueError 留在 __context__ 上
            cause = e.__context__
            if e.reason == "result" and isinstance(cause, ValueError) and str(cause) in _NO_SPEECH:
                return []
            raise RuntimeError(f"火山语音识别失败（{_describe(e)}）") from None
        if result.get("status") == "silent":
            return []
        out: list[ASRSegment] = []
        for seg in result.get("segments") or []:
            row = ASRSegment(start=float(seg["start"]), end=float(seg["end"]), text=seg["text"])
            if seg.get("words"):
                row["words"] = seg["words"]
            out.append(row)
        return out
