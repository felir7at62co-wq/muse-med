"""短剧编导的云端转写（2026-11-05，从 muse-med 的账号网关迁来）。

客户端 `audio_transcribe` 工具把抽好的音轨（16 kHz 单声道 WAV 或 MP3）提交到这里，镜流账号鉴权。
识别引擎二选一：
- **阿里云百炼 Paraformer（默认，2026-11-05 用户裁定）**：用镜流已有的语音识别 key（FW_BAILIAN_API_KEY），
  音频先放进 TOS 桶、签名链接交给百炼，之后按百炼任务号查询；剧本用途开说话人分离。客户端看到的任务
  不带 `service_version`（客户端只认火山的三个版本名，该字段可缺省）。
- 火山引擎录音文件识别（`FW_DRAMA_ASR_CONFIG` 显式配置时优先）：
  `flash`（极速版）音频 base64 随请求发出、同步出结果、没有可查询的原任务；
  `standard-v1` / `standard-v2`（标准版）先进桶，再按原任务号查询。

两者都没配时整个功能返回 503，客户端据此报「服务器未配置云端转写」。

配置文件字段（与 muse 网关同名，便于把那边的配置直接搬过来）：
    appId, accessToken            火山语音应用凭据（必填）
    routes                        {"subtitles": "flash", "screenplay": "standard-v2"}（默认值）
    maxAudioBytes                 单次上传上限，默认 100_000_000
    maxDurationSeconds            单段时长上限，默认 7200（极速版硬上限）
    maxDailySeconds, maxDailyJobs 每账号每天的计费上限，默认 36000 秒 / 200 次
    speakerDiarization            剧本用途是否分说话人，默认 true（版本 200，180 秒分长短）
    timeoutMs                     单次请求超时，默认 120000

同一个任务号（客户端持久化的幂等 UUID）只会向火山提交一次：重复提交返回原任务的状态，
提交结果未知（超时、断线）的任务只查询原任务、绝不自动重投——这一点与 muse 网关一致，避免重复计费。
"""
from __future__ import annotations

import base64
import datetime as _dt
import hashlib
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

_ENDPOINT = "https://openspeech.bytedance.com/api/v3/auc/bigmodel"
_RESOURCE_IDS = {"flash": "volc.bigasr.auc_turbo", "standard-v1": "volc.bigasr.auc", "standard-v2": "volc.seedasr.auc"}
_QUOTA_TYPES = {"qps", "concurrency", "audio_duration", "audio_duration_saas", "audio_duration_lifetime",
                "text_words_lifetime", "tokens_lifetime"}
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
#: 标准版查询的最短间隔：客户端轮询再勤，也不会每次都打到火山。
_QUERY_INTERVAL_SEC = 5
#: 标准版音频在桶里保留多久（签名链接的有效期同此），之后清掉。
_RETENTION_SEC = 6 * 3600

_lock = threading.Lock()


class AsrError(Exception):
    """带 HTTP 状态与可选 `Retry-After` 的拒绝；消息不含凭据与上游原文。"""

    def __init__(self, status: int, code: str, message: str, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.status, self.code, self.message, self.retry_after = status, code, message, retry_after


def load_config() -> dict | None:
    """读服务器私有配置；没配（或文件不存在）返回 None = 功能关闭。配置写错时直接报错，不静默关闭。"""
    path = os.environ.get("FW_DRAMA_ASR_CONFIG", "").strip()
    if not path:
        try:
            from .config import get_settings
            path = (getattr(get_settings(), "drama_asr_config", "") or "").strip()
        except Exception:  # noqa: BLE001
            path = ""
    if not path or not Path(path).is_file():
        return _paraformer_config()
    raw = json.loads(Path(path).read_text("utf-8"))
    if not isinstance(raw, dict) or not str(raw.get("appId") or "").strip() or not str(raw.get("accessToken") or "").strip():
        raise ValueError("FW_DRAMA_ASR_CONFIG 需要 appId 与 accessToken")
    cfg = {
        "engine": "volc",
        "appId": str(raw["appId"]).strip(), "accessToken": str(raw["accessToken"]).strip(),
        "routes": {"subtitles": "flash", "screenplay": "standard-v2", **(raw.get("routes") or {})},
        "maxAudioBytes": int(raw.get("maxAudioBytes", 100_000_000)),
        "maxDurationSeconds": int(raw.get("maxDurationSeconds", 7200)),
        "maxDailySeconds": int(raw.get("maxDailySeconds", 36_000)),
        "maxDailyJobs": int(raw.get("maxDailyJobs", 200)),
        "speakerDiarization": bool(raw.get("speakerDiarization", True)),
        "speakerDiarizationVersion": str(raw.get("speakerDiarizationVersion", "200")),
        "speakerLongAudioSeconds": int(raw.get("speakerLongAudioSeconds", 180)),
        "timeoutMs": int(raw.get("timeoutMs", 120_000)),
    }
    for purpose, version in cfg["routes"].items():
        if purpose not in ("subtitles", "screenplay") or version not in _RESOURCE_IDS:
            raise ValueError(f"FW_DRAMA_ASR_CONFIG routes 写错：{purpose}={version}")
    return cfg


#: Paraformer 任务在我们这边记的版本名；对客户端不下发（见 public）。
PARAFORMER = "paraformer"


def _paraformer_config() -> dict | None:
    """百炼 Paraformer 引擎的配置；没有语音识别 key 就返回 None（功能关闭）。上限与火山默认值相同。"""
    try:
        from .config import get_settings
        st = get_settings()
    except Exception:  # noqa: BLE001
        return None
    key = (getattr(st, "bailian_api_key", "") or "").strip()
    base = (getattr(st, "bailian_base_url", "") or "").rstrip("/")
    if not key or not base:
        return None
    return {"engine": PARAFORMER, "key": key, "base": base,
            "model": getattr(st, "bailian_asr_model", "") or "paraformer-v2",
            "routes": {"subtitles": PARAFORMER, "screenplay": PARAFORMER},
            "maxAudioBytes": 100_000_000, "maxDurationSeconds": 7200, "maxDailySeconds": 36_000, "maxDailyJobs": 200,
            "speakerDiarization": True, "timeoutMs": 120_000}


def configured() -> bool:
    try:
        return load_config() is not None
    except Exception:  # noqa: BLE001  写错的配置同样当作不可用，原因见日志
        logger.exception("[drama-asr] 配置读取失败")
        return False


# ---------------------------------------------------------------- 火山接口


class ProviderError(Exception):
    """一次失败的上游调用。只保留可公开的分类字段，从不保留上游正文。"""

    def __init__(self, operation: str, reason: str, resp: httpx.Response | None = None) -> None:
        super().__init__(f"asr {operation} {reason}")
        self.operation, self.reason = operation, reason
        self.http_status = resp.status_code if resp is not None else None
        code = resp.headers.get("X-Api-Status-Code") if resp is not None else None
        self.provider_code = code if code and re.fullmatch(r"\d{5,10}", code) else None
        self.quota_type = None
        self.retry_after = None
        if resp is not None and operation == "query":
            m = re.match(r"^quota exceeded for types: ([a-z_]+)$", resp.headers.get("X-Api-Message", ""), re.I)
            if m and m.group(1).lower() in _QUOTA_TYPES:
                self.quota_type = m.group(1).lower()
            ra = resp.headers.get("Retry-After", "")
            if ra.isdigit() and 0 < int(ra) <= 86400:
                self.retry_after = int(ra)
        rejected = reason in ("response", "http") and not (self.http_status or 0) >= 500 and \
            ((self.http_status or 0) >= 400 or self.provider_code is not None)
        self.code = "provider_rejected" if rejected else "provider_unavailable"

    def public(self) -> dict:
        out = {"reason": self.reason, "operation": self.operation}
        if self.http_status:
            out["http_status"] = self.http_status
        if self.provider_code:
            out["provider_code"] = self.provider_code
        if self.quota_type:
            out["quota_type"] = self.quota_type
        return out


def _headers(cfg: dict, job_id: str, resource_id: str) -> dict:
    return {"content-type": "application/json", "X-Api-App-Key": cfg["appId"], "X-Api-Access-Key": cfg["accessToken"],
            "X-Api-Resource-Id": resource_id, "X-Api-Request-Id": job_id}


def _normalize(body: dict) -> dict:
    """火山的 utterances → 客户端要的 segments（秒，带可选说话人与逐字时间）。"""
    utterances = (body or {}).get("result", {}).get("utterances")
    if not isinstance(utterances, list) or not utterances:
        raise ValueError("no utterances")
    segments: list[dict] = []
    for row in utterances:
        start, end, text = row.get("start_time"), row.get("end_time"), row.get("text")
        if not isinstance(start, (int, float)) or start < 0 or not isinstance(end, (int, float)) or end <= start \
                or not isinstance(text, str) or (segments and start < segments[-1]["start"] * 1000):
            raise ValueError("bad utterance")
        if not text.strip():
            continue
        seg: dict = {"start": start / 1000, "end": end / 1000, "text": text.strip()}
        ids = [v for v in (row.get("speaker_id"), (row.get("additions") or {}).get("speaker_id"),
                           (row.get("additions") or {}).get("speaker")) if v is not None]
        if ids:
            if any(not isinstance(v, str) or not v.strip() or v != ids[0] for v in ids):
                raise ValueError("bad speaker")
            seg["speaker_id"] = ids[0]
        words = row.get("words")
        if words is not None:
            if not isinstance(words, list):
                raise ValueError("bad words")
            seg["words"] = []
            for w in words:
                wt, ws, we = w.get("text"), w.get("start_time"), w.get("end_time")
                if not isinstance(wt, str):
                    raise ValueError("bad word")
                if not wt.strip() or (ws == we and re.fullmatch(r"[\W_\s]+", wt)):
                    continue
                if not isinstance(ws, (int, float)) or not isinstance(we, (int, float)) or ws < start or we > end \
                        or we <= ws or (seg["words"] and ws < seg["words"][-1]["start"] * 1000):
                    raise ValueError("bad word time")
                seg["words"].append({"start": ws / 1000, "end": we / 1000, "text": wt.strip()})
        segments.append(seg)
    if not segments:
        raise ValueError("no speech")
    return {"status": "complete", "segments": segments}


def _flash(cfg: dict, job_id: str, audio: bytes) -> dict:
    try:
        resp = httpx.post(f"{_ENDPOINT}/recognize/flash", timeout=cfg["timeoutMs"] / 1000,
                          headers={**_headers(cfg, job_id, _RESOURCE_IDS["flash"]), "X-Api-Sequence": "-1"},
                          json={"user": {"uid": "jingliu-drama-transcribe"}, "audio": {"data": base64.b64encode(audio).decode()},
                                "request": {"model_name": "bigmodel", "enable_itn": True, "enable_punc": True,
                                            "enable_ddc": False, "show_utterances": True}})
    except httpx.TimeoutException:
        raise ProviderError("flash", "timeout") from None
    except httpx.HTTPError:
        raise ProviderError("flash", "transport") from None
    code = resp.headers.get("X-Api-Status-Code")
    if resp.status_code >= 400:
        raise ProviderError("flash", "http", resp)
    if code == "20000003":
        return {"status": "silent"}
    if code != "20000000":
        raise ProviderError("flash", "response", resp)
    try:
        return _normalize(resp.json())
    except ValueError:
        raise ProviderError("flash", "result", resp) from None


def _submit(cfg: dict, job_id: str, version: str, url: str, fmt: str, language: str, purpose: str, duration: float) -> None:
    speakers: dict = {}
    if purpose == "screenplay" and cfg["speakerDiarization"]:
        speakers = {"enable_speaker_info": True, "ssd_version": cfg["speakerDiarizationVersion"]}
        if cfg["speakerDiarizationVersion"] == "200":
            speakers["ssd_mode"] = 1 if duration >= cfg["speakerLongAudioSeconds"] else 0
    body = {"user": {"uid": "jingliu-drama-transcribe"},
            "audio": {"format": fmt, "url": url, "rate": 16000, "channel": 1, **({"language": "zh-CN"} if language == "zh" else {})},
            "request": {"model_name": "bigmodel", "enable_itn": True, "enable_punc": True, "enable_ddc": False,
                        "show_utterances": True, **speakers, **({"enable_auto_lang": True} if language == "auto" else {})}}
    try:
        resp = httpx.post(f"{_ENDPOINT}/submit", timeout=cfg["timeoutMs"] / 1000, json=body,
                          headers={**_headers(cfg, job_id, _RESOURCE_IDS[version]), "X-Api-Sequence": "-1"})
    except httpx.TimeoutException:
        raise ProviderError("submit", "timeout") from None
    except httpx.HTTPError:
        raise ProviderError("submit", "transport") from None
    if resp.status_code < 400 and resp.headers.get("X-Api-Status-Code") in ("20000000", "20000001", "20000002"):
        return
    raise ProviderError("submit", "response", resp)


def _query(cfg: dict, job_id: str, version: str) -> dict:
    try:
        resp = httpx.post(f"{_ENDPOINT}/query", timeout=cfg["timeoutMs"] / 1000, content=b"{}",
                          headers=_headers(cfg, job_id, _RESOURCE_IDS[version]))
    except httpx.TimeoutException:
        raise ProviderError("query", "timeout") from None
    except httpx.HTTPError:
        raise ProviderError("query", "transport") from None
    code = resp.headers.get("X-Api-Status-Code")
    if resp.status_code >= 400:
        raise ProviderError("query", "http", resp)
    if code in ("20000001", "20000002"):
        return {"status": "processing", "queued": code == "20000002"}
    if code == "20000003":
        return {"status": "silent"}
    if code in ("45000006", "45000092", "55001010"):
        return {"status": "failed", "provider_code": code}
    if code != "20000000":
        raise ProviderError("query", "response", resp)
    try:
        return _normalize(resp.json())
    except ValueError:
        raise ProviderError("query", "result", resp) from None


# ---------------------------------------------------------------- 百炼 Paraformer


def _pf_submit(cfg: dict, url: str, language: str, purpose: str) -> str:
    """提交一个录音文件识别任务，返回百炼任务号。"""
    params: dict = {}
    if language == "zh":
        params["language_hints"] = ["zh"]
    if purpose == "screenplay" and cfg["speakerDiarization"]:
        params["diarization_enabled"] = True
    try:
        resp = httpx.post(f"{cfg['base']}/services/audio/asr/transcription", timeout=cfg["timeoutMs"] / 1000,
                          headers={"Authorization": f"Bearer {cfg['key']}", "Content-Type": "application/json",
                                   "X-DashScope-Async": "enable"},
                          json={"model": cfg["model"], "input": {"file_urls": [url]}, "parameters": params})
    except httpx.TimeoutException:
        raise ProviderError("submit", "timeout") from None
    except httpx.HTTPError:
        raise ProviderError("submit", "transport") from None
    if resp.status_code >= 400:
        raise ProviderError("submit", "http", resp)
    try:
        task_id = (resp.json().get("output") or {}).get("task_id")
    except ValueError:
        task_id = None
    if not isinstance(task_id, str) or not task_id:
        raise ProviderError("submit", "response", resp)
    return task_id


def _pf_query(cfg: dict, task_id: str) -> dict:
    """查百炼原任务；完成时当场取回结果（结果链接很快过期，不能存起来以后再取）。"""
    hdr = {"Authorization": f"Bearer {cfg['key']}"}
    try:
        resp = httpx.get(f"{cfg['base']}/tasks/{task_id}", headers=hdr, timeout=cfg["timeoutMs"] / 1000)
    except httpx.TimeoutException:
        raise ProviderError("query", "timeout") from None
    except httpx.HTTPError:
        raise ProviderError("query", "transport") from None
    if resp.status_code >= 400:
        raise ProviderError("query", "http", resp)
    try:
        out = resp.json().get("output") or {}
    except ValueError:
        raise ProviderError("query", "response", resp) from None
    status = out.get("task_status")
    if status in ("PENDING", "RUNNING"):
        return {"status": "processing", "queued": status == "PENDING"}
    results = [r for r in (out.get("results") or []) if isinstance(r, dict)]
    if status != "SUCCEEDED" or not results:
        return {"status": "failed", "provider_code": None}
    item = results[0]
    if item.get("subtask_status") != "SUCCEEDED":
        # 整段没有可识别的人声时，百炼把子任务判成失败并给这个码。
        if item.get("code") == "SUCCESS_WITH_NO_VALID_FRAGMENT":
            return {"status": "silent"}
        return {"status": "failed", "provider_code": None}
    try:
        got = httpx.get(item.get("transcription_url") or "", timeout=cfg["timeoutMs"] / 1000)
    except httpx.HTTPError:
        raise ProviderError("query", "transport") from None
    if got.status_code >= 400:
        raise ProviderError("query", "http", got)
    try:
        return _pf_normalize(got.json())
    except ValueError:
        raise ProviderError("query", "result", got) from None


def _pf_normalize(body: dict) -> dict:
    """百炼 transcripts[].sentences[] → 客户端要的 segments（秒，带可选说话人与逐字时间）。

    逐字的标点在百炼里是单独字段，拼回字上；越出所在句、或倒退的字时间整条丢掉（只丢那个字，不丢整句）。
    """
    sentences = [st for tr in (body or {}).get("transcripts") or [] for st in (tr.get("sentences") or [])]
    if not isinstance(sentences, list):
        raise ValueError("bad transcripts")
    segments: list[dict] = []
    for st in sorted((x for x in sentences if isinstance(x, dict)), key=lambda x: x.get("begin_time") or 0):
        start, end, text = st.get("begin_time"), st.get("end_time"), (st.get("text") or "").strip()
        if not text or not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or start < 0 or end <= start:
            continue
        if segments and start < segments[-1]["end"] * 1000:
            start = segments[-1]["end"] * 1000
            if end <= start:
                continue
        seg: dict = {"start": start / 1000, "end": end / 1000, "text": text}
        if st.get("speaker_id") is not None:
            seg["speaker_id"] = str(st["speaker_id"])
        words = []
        for w in st.get("words") or []:
            wt = ((w.get("text") or "") + (w.get("punctuation") or "")).strip()
            ws, we = w.get("begin_time"), w.get("end_time")
            if not wt or not isinstance(ws, (int, float)) or not isinstance(we, (int, float)) \
                    or ws < start or we > end or we <= ws or (words and ws < words[-1]["start"] * 1000):
                continue
            words.append({"start": ws / 1000, "end": we / 1000, "text": wt})
        if words:
            seg["words"] = words
        segments.append(seg)
    if not segments:
        return {"status": "silent"}
    return {"status": "complete", "segments": segments}


# ---------------------------------------------------------------- 音频与任务账本


def _probe(path: Path) -> tuple[float, str]:
    """服务器自己量时长与格式：配额不能依赖客户端报的数。"""
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                              "format=duration,format_name:stream=codec_name,sample_rate,channels", "-of", "json", str(path)],
                             capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        raise AsrError(503, "probe_unavailable", "服务器无法读取音频时长") from None
    if out.returncode != 0:
        raise AsrError(422, "invalid_audio", "无法解码这段音频")
    try:
        meta = json.loads(out.stdout)
    except ValueError:
        raise AsrError(422, "invalid_audio", "音频元数据无效") from None
    fmt_name = (meta.get("format") or {}).get("format_name")
    stream = (meta.get("streams") or [{}])[0]
    duration = float((meta.get("format") or {}).get("duration") or 0)
    if fmt_name == "mp3" and stream.get("codec_name") == "mp3":
        fmt = "mp3"
    elif fmt_name == "wav" and stream.get("codec_name") == "pcm_s16le" and int(stream.get("sample_rate") or 0) == 16000 \
            and stream.get("channels") == 1:
        fmt = "wav"
    else:
        raise AsrError(422, "invalid_audio", "只接受 MP3 或 16 kHz 单声道 PCM16 WAV")
    if duration <= 0:
        raise AsrError(422, "invalid_audio", "音频时长为 0")
    return duration, fmt


def _today() -> str:
    return _dt.datetime.now(_dt.timezone.utc).date().isoformat()


def public(job) -> dict:
    """任务行 → 客户端看的状态（字段与 muse 网关一致，客户端逐项校验）。"""
    flash = job.service_version == "flash"
    unresolved = job.status in ("submitting", "processing", "uncertain")
    if job.status in ("complete", "silent"):
        next_action = "use_result"
    elif job.status in ("preparing", "failed") and job.submitted_at is None and not job.provider_failure:
        next_action = "resume_upload"
    elif job.status == "failed" or (flash and job.status == "uncertain"):
        next_action = "inspect_receipt"
    elif not flash and unresolved:
        next_action = "poll_original"
    else:
        next_action = "wait"
    failure = json.loads(job.provider_failure) if job.provider_failure else None
    if not flash and unresolved and failure and failure.get("quota_type") in ("audio_duration_lifetime", "text_words_lifetime", "tokens_lifetime"):
        next_action = "inspect_receipt"
    recovery: dict = {"capability": "no_query" if flash and unresolved else "query_original_task" if unresolved else "none",
                      "next_action": next_action, "automatic_resubmit": False}
    if not flash and unresolved and job.next_query_at and job.next_query_at > time.time():
        recovery["retry_after"] = max(1, int(job.next_query_at - time.time()))
    out: dict = {"id": job.id, "status": job.status, "purpose": job.purpose, "recovery": recovery}
    if job.service_version != PARAFORMER:   # 客户端只认火山的三个版本名，Paraformer 任务不带这个字段
        out["service_version"] = job.service_version
    if job.status == "processing" and job.queued is not None:
        out["queued"] = bool(job.queued)
    if failure:
        out["provider_diagnostic"] = {k: v for k, v in failure.items() if k in ("reason", "operation", "http_status", "provider_code", "quota_type")}
    if job.status in ("uncertain", "failed") and job.failure_code in ("provider_rejected", "provider_unavailable", "storage_unavailable"):
        out["error_code"] = job.failure_code
    if job.status == "complete":
        out["segments"] = json.loads(job.segments or "[]")
    if job.retention_expired:
        out["retentionExpired"] = True
    return out


def _record_failure(job, err: ProviderError, *, uncertain: bool) -> None:
    job.provider_failure = json.dumps(err.public(), ensure_ascii=False)
    job.failure_code = err.code
    job.status = "uncertain" if uncertain else "failed"


def submit(user_id: int, job_id: str, sha256: str, language: str, purpose: str, audio: bytes) -> dict:
    """受理一次提交。同一任务号重复提交返回原任务；受理前核对摘要、格式、时长与每日配额。"""
    from .db import DramaAsrJob, get_session
    cfg = load_config()
    if cfg is None:
        raise AsrError(503, "not_configured", "服务器尚未配置云端转写")
    if not _UUID.fullmatch(job_id or ""):
        raise AsrError(400, "invalid_request", "任务号必须是 UUID")
    if not _SHA256.fullmatch(sha256 or ""):
        raise AsrError(400, "invalid_request", "缺少音频摘要")
    if language not in ("zh", "auto") or purpose not in ("subtitles", "screenplay"):
        raise AsrError(400, "invalid_request", "语种或用途不受支持")
    if len(audio) == 0 or len(audio) > cfg["maxAudioBytes"]:
        raise AsrError(413, "audio_too_large", "音频大小超出上限")
    if hashlib.sha256(audio).hexdigest() != sha256:
        raise AsrError(400, "digest_mismatch", "音频摘要不一致")
    with _lock:
        with get_session() as s:
            job = s.get(DramaAsrJob, job_id)
            if job is not None:
                if job.user_id != user_id:
                    raise AsrError(409, "id_conflict", "任务号已被使用")
                if job.sha256 != sha256 or job.purpose != purpose:
                    raise AsrError(409, "id_conflict", "同一任务号不能换音频或用途")
                if job.submitted_at is not None or job.status not in ("preparing", "failed") or job.provider_failure:
                    return public(job)
    with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as tmp:
        tmp.write(audio)
        tmp_path = Path(tmp.name)
    try:
        duration, fmt = _probe(tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)
    if duration > cfg["maxDurationSeconds"]:
        raise AsrError(413, "audio_too_long", "音频时长超出上限")
    version = cfg["routes"][purpose]
    with _lock:
        with get_session() as s:
            day = _today()
            billed = [r for r in s.query(DramaAsrJob).filter(DramaAsrJob.user_id == user_id, DramaAsrJob.day == day,
                                                               DramaAsrJob.id != job_id).all()
                      if r.status != "failed" or r.submitted_at is not None]
            if len(billed) >= cfg["maxDailyJobs"] or sum(r.duration or 0 for r in billed) + duration > cfg["maxDailySeconds"]:
                raise AsrError(429, "daily_quota", "今天的云端转写额度已用完")
            job = s.get(DramaAsrJob, job_id) or DramaAsrJob(id=job_id, user_id=user_id)
            job.sha256, job.purpose, job.language, job.service_version = sha256, purpose, language, version
            job.duration, job.format, job.day, job.status = duration, fmt, day, "submitting"
            job.provider_failure, job.failure_code, job.segments = None, None, None
            s.merge(job)
            s.commit()
    if version == "flash":
        return _run_flash(cfg, job_id, audio)
    return _run_standard(cfg, job_id, version, audio, fmt, language, purpose, duration)


def _run_flash(cfg: dict, job_id: str, audio: bytes) -> dict:
    from .db import DramaAsrJob, get_session
    with get_session() as s:
        job = s.get(DramaAsrJob, job_id)
        job.submitted_at = time.time()
        s.commit()
    try:
        result = _flash(cfg, job_id, audio)
    except ProviderError as err:
        logger.warning("[drama-asr] flash %s 失败 %s", job_id, err.public())
        with get_session() as s:
            job = s.get(DramaAsrJob, job_id)
            # 极速版没有原任务可查：结果未知就停在 uncertain，绝不自动重投（可能已计费）。
            _record_failure(job, err, uncertain=err.reason in ("timeout", "transport") or (err.http_status or 0) >= 500)
            s.commit()
            return public(job)
    with get_session() as s:
        job = s.get(DramaAsrJob, job_id)
        job.status = result["status"]
        job.segments = json.dumps(result.get("segments", []), ensure_ascii=False)
        s.commit()
        return public(job)


def _run_standard(cfg: dict, job_id: str, version: str, audio: bytes, fmt: str, language: str, purpose: str,
                  duration: float) -> dict:
    from . import storage
    from .db import DramaAsrJob, get_session
    if not storage.enabled():
        with get_session() as s:
            job = s.get(DramaAsrJob, job_id)
            job.status, job.failure_code = "failed", "storage_unavailable"
            s.commit()
            return public(job)
    rel = f"drama-asr/{job_id}.{fmt}"
    with tempfile.NamedTemporaryFile(suffix=f".{fmt}", delete=False) as tmp:
        tmp.write(audio)
        tmp_path = Path(tmp.name)
    try:
        storage.put_file(tmp_path, rel, content_type="audio/wav" if fmt == "wav" else "audio/mpeg")
    except Exception:  # noqa: BLE001
        logger.exception("[drama-asr] 音频上传桶失败 %s", job_id)
        with get_session() as s:
            job = s.get(DramaAsrJob, job_id)
            job.status, job.failure_code = "failed", "storage_unavailable"
            s.commit()
            return public(job)
    finally:
        tmp_path.unlink(missing_ok=True)
    url = storage.presign("GET", storage.key_for(rel), ttl=_RETENTION_SEC)
    with get_session() as s:
        job = s.get(DramaAsrJob, job_id)
        job.audio_rel, job.submitted_at = rel, time.time()
        s.commit()
    try:
        if version == PARAFORMER:
            task_id = _pf_submit(cfg, url, language, purpose)
            with get_session() as s:
                job = s.get(DramaAsrJob, job_id)
                job.provider_task_id = task_id
                s.commit()
        else:
            _submit(cfg, job_id, version, url, fmt, language, purpose, duration)
    except ProviderError as err:
        # 提交结果未知：保留原任务号，之后只查询，不重投。
        logger.warning("[drama-asr] submit %s 失败 %s", job_id, err.public())
        with get_session() as s:
            job = s.get(DramaAsrJob, job_id)
            _record_failure(job, err, uncertain=True)
            job.next_query_at = time.time() + _QUERY_INTERVAL_SEC
            s.commit()
            return public(job)
    with get_session() as s:
        job = s.get(DramaAsrJob, job_id)
        job.status, job.next_query_at = "processing", time.time() + _QUERY_INTERVAL_SEC
        s.commit()
        return public(job)


def get(user_id: int, job_id: str) -> dict:
    """读任务；标准版未结束且到了查询时间时，顺手向火山查一次原任务（不会新建任务）。"""
    from .db import DramaAsrJob, get_session
    with get_session() as s:
        job = s.get(DramaAsrJob, job_id)
        if job is None or job.user_id != user_id:
            raise AsrError(404, "not_found", "没有这个转写任务")
        due = job.service_version != "flash" and job.status in ("processing", "uncertain") and job.submitted_at is not None \
            and (job.next_query_at or 0) <= time.time()
        if not due:
            _expire(job)
            s.commit()
            return public(job)
    cfg = load_config()
    if cfg is None:
        raise AsrError(503, "not_configured", "服务器尚未配置云端转写")
    try:
        if job.service_version == PARAFORMER:
            if not job.provider_task_id:
                # 提交结果未知（没拿到百炼任务号）：没有原任务可查，也绝不重投，交给人核对。
                raise ProviderError("query", "response")
            if cfg.get("engine") != PARAFORMER:
                raise AsrError(503, "not_configured", "服务器尚未配置云端转写")
            result = _pf_query(cfg, job.provider_task_id)
        else:
            if cfg.get("engine") != "volc":
                raise AsrError(503, "not_configured", "服务器尚未配置火山云端转写")
            result = _query(cfg, job_id, job.service_version)
        err = None
    except ProviderError as e:
        result, err = None, e
    with get_session() as s:
        job = s.get(DramaAsrJob, job_id)
        if err is not None:
            job.provider_failure = json.dumps(err.public(), ensure_ascii=False)
            job.failure_code = err.code
            job.next_query_at = time.time() + (err.retry_after or max(_QUERY_INTERVAL_SEC * 6, 30))
        else:
            job.status = result["status"]
            job.queued = result.get("queued")
            job.next_query_at = time.time() + _QUERY_INTERVAL_SEC
            if result["status"] == "complete":
                job.segments = json.dumps(result["segments"], ensure_ascii=False)
                job.provider_failure, job.failure_code = None, None
            elif result["status"] == "failed":
                job.provider_failure = json.dumps({"reason": "response", "operation": "query",
                                                   "provider_code": result.get("provider_code")}, ensure_ascii=False)
                job.failure_code = "provider_rejected"
            elif result["status"] == "processing":
                job.provider_failure, job.failure_code = None, None
        _expire(job)
        s.commit()
        return public(job)


def _expire(job) -> None:
    """音频过了留存期就从桶里删掉；任务结果照旧可读。"""
    if job.audio_rel and job.submitted_at and time.time() - job.submitted_at > _RETENTION_SEC \
            and job.status in ("complete", "silent", "failed"):
        try:
            from . import storage
            storage.delete(job.audio_rel)
        except Exception:  # noqa: BLE001
            logger.warning("[drama-asr] 清理过期音频失败 %s", job.id)
            return
        job.audio_rel, job.retention_expired = None, True


def new_job_id() -> str:
    return str(uuid.uuid4())
