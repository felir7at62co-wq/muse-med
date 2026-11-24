"""Run verified Hongguo downloads and the native Muse episode workflow."""

from hashlib import sha256
from heapq import nlargest
import json
import math
import os
from pathlib import Path
import re
from time import monotonic, sleep, time
import unicodedata
from uuid import uuid4

from common import WorkError, attempts_left, canonical_json, command, digest, freeze, read, save, under
from verification import checked_file, native_manuscript_results, native_source_results, validate_sources, verify_delivery

CODE = Path(__file__).resolve().parent
SCOPE = CODE / "episode-scope.mjs"
PROMPT = CODE / "episode-prompt.txt"
RECOVERY = """继续原会话完成本集校验。沿用原片与已完成的语音；语音未完成用 inspect 查原收据，状态不明则保留并报告。查看原 review_id 的当前 pending，用 next 和 observe 核完全部补帧，再核对正文。仍有看帧不能解决的疑点留 QA。基于当前稿重新做对白核对和交付登记；正文有改动则先另存 Word 新版。沿用首条任务的来源和交付约束。"""
# What to repair for each delivery check, so a resumed Session fixes the failed step instead of repeating its work.
REPAIRS = (
    ("does not reach the original ending", "字幕识别没有覆盖到片尾：用 video_inspect metadata 的精确时长作为最后一段 video_ocr 的终点，补跑到片尾。"),
    ("gap in native OCR", "字幕识别分段之间有空档：补跑缺失的时间段，相邻分段首尾相接。"),
    ("OCR evidence is incomplete", "有字幕识别分段未扫完或有失败帧：重跑这些分段直到 scan_status 为 complete。"),
    ("latest dialogue comparison does not match", "对白核对用的不是当前正文：对最新 scripts 正文重新跑 manuscript_revision transcript_coverage；此后改了正文就再跑一次，最后另存 Word 并重新登记交付。"),
    ("comparison has no workspace audio evidence", "对白核对没有带本集语音识别结果：transcript_coverage 传入本集实际 ASR JSON 重新核对。"),
    ("did not use this episode recognition result", "对白核对没有使用本集语音识别结果：传入本集实际 ASR JSON 重新核对。"),
    ("disagree on completed frames", "看帧记录与 Word 不一致：用 next 和 observe 核完全部 pending 帧，再导出新版 Word 并登记交付。"),
    ("no native video review", "本集还没有看帧记录：用 video_inspect scan 和 observe/next 完成看帧。"),
    ("no successful native Word export", "本集没有成功导出 Word：用 screenplay_export_docx 导出后登记交付。"),
    ("frame review", "看帧没有做完，程序只收 frames=complete 的稿件；帧数再多也要全部记录，不能跳过、close 或以草稿交付。"
                "reopen 原 review_id，反复 next 和 observe，直到 pending=0、next=complete；做完之前不要导出、登记或 present。"
                "然后按画面补正正文，对最新正文重跑对白核对，另存 Word 新版，只登记这一份，确认 video_check 为 frames=complete。"),
    ("Word body differs", "Word 与当前正文不一致：正文定稿后不要再改，另存 Word 新版并只登记这一份。"),
    ("format errors", "格式检查有错误：按 delivery 返回的 format_errors 修正正文，再另存 Word 并登记。"),
    ("expected one current Word", "交付登记里没有通过检查的 Word：对当前正文另存 Word 新版并登记交付。"),
    ("did not complete", "上一轮没有正常结束：从中断处继续，完成剩余步骤。"),
    ("额度已用完", "上一轮因镜流积分用完停在中途，现已划拨：沿用已完成的结果，从中断处继续完成本集。"),
    ("镜流积分暂时查不到", "上一轮因额度服务暂时不可用停在中途：沿用已完成的结果，从中断处继续完成本集。"),
    ("episode record qa/", "本集 QA 记录缺失或格式不对：把来源、秒位和待核点存成 JSON 对象 qa/<四位集号>.json，再登记交付。"),
    ("episode record characters.json", '本集人物表缺失或格式不对：存成 characters.json，内容为 {"characters": [{"name": ...}]} 或这些条目的数组；'
                                       "transcript_coverage 的 characters_path 指向它重跑，再登记交付。"),
)


QUOTA_FAILURES = {"exhausted": ("QUOTA_EXHAUSTED", "额度已用完，请找组长划拨后再继续"),
                  "unavailable": ("QUOTA_UNAVAILABLE", "镜流积分暂时查不到，稍后再续跑")}
#: How often and how far apart a round retries when the gateway could not read Jingliu's balance (it asks for 30 s).
QUOTA_RETRIES, QUOTA_RETRY_SECONDS = 10, 30
QUOTA_RESUME = "上一步的模型调用被额度服务暂时拒绝，现在重试。沿用已完成的结果，从中断处继续完成本集。"


def quota_refusal(payloads):
    """`exhausted` or `unavailable` when the Muse account gateway refused a call over Jingliu credits, else None.

    The gateway marks its own refusals with the codes `quota_exhausted` / `quota_unavailable` in the response body,
    which the SDK keeps in the error that ends the turn (model calls) or in a failed tool result (speech jobs). A
    provider's own 402 (`insufficient_quota`) is neither. Only a turn that ended on `quota_unavailable` counts as
    unavailable: a failed speech submission the agent retried successfully does not.
    """
    exhausted = unavailable = False
    for payload in payloads:
        event = payload.get("event") if isinstance(payload, dict) else None
        if not isinstance(event, dict):
            continue
        data = event.get("data") or {}
        if event.get("type") == "turn/end" and (data.get("reason") or {}).get("kind") == "error":
            text = str(((data["reason"].get("error") or {}).get("message")) or "")
            exhausted = exhausted or "quota_exhausted" in text
            unavailable = unavailable or "quota_unavailable" in text
        elif event.get("type") == "tool/result" and isinstance(data.get("message"), dict) and data["message"].get("isError"):
            texts = [str(c.get("text", "")) for c in data["message"].get("content") or [] if isinstance(c, dict)]
            exhausted = exhausted or any("quota_exhausted" in text for text in texts)
    return "exhausted" if exhausted else "unavailable" if unavailable else None


def recovery_prompt(failure):
    """The resume instruction, naming the program check the previous attempt failed and how to repair it."""
    if not failure:
        return RECOVERY
    repair = next((text for key, text in REPAIRS if key in failure), "按原任务要求逐项补齐后重新核对和登记交付。")
    return f"{RECOVERY}\n\n上一次程序检查未通过：{failure}。{repair}"


def title_key(value):
    """Compare titles after normalizing whitespace, punctuation and width."""
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 200 or any(ord(c) < 32 for c in value):
        raise WorkError("SOURCE_TITLE", "缺少可核对的红果剧名")
    key = "".join(c for c in unicodedata.normalize("NFKC", value)
                  if not c.isspace() and not unicodedata.category(c).startswith("P"))
    if not key:
        raise WorkError("SOURCE_TITLE", "缺少可核对的红果剧名")
    return key


def one_series(result, key, title):
    """Read one exact series from the downloader's catalog or receipt."""
    items = result.get("items")
    if result.get("ok") is not True or not isinstance(items, list) or len(items) != 1:
        raise WorkError("SOURCE_CATALOG", "红果未返回一部可核对的剧")
    row = items[0]
    if row.get("seriesId") != key or title_key(row.get("title")) != title_key(title):
        raise WorkError("SOURCE_MISMATCH", "红果返回的剧名或编号与数据站不一致")
    count = row.get("episodeCount")
    if type(count) is not int or not 1 <= count <= 1000:
        raise WorkError("SOURCE_CATALOG", "红果全集集数未知")
    return row


def verified_media(download, manifest, key, title, expected):
    """Require all episodes, complete decoding and the original checksums."""
    result = read(under(download, manifest))
    row = one_series(result, key, title)
    files = row.get("episodes")
    if (result.get("complete") is not True or row.get("complete") is not True or
            row["episodeCount"] != expected or row.get("downloadedEpisodeCount") != expected or
            not isinstance(files, list) or len(files) != expected):
        raise WorkError("INCOMPLETE_MEDIA", "原片未下载齐全")
    checked = [verified_episode(download, episode, number) for number, episode in enumerate(files, 1)]
    if len({episode["path"] for episode in checked}) != expected:
        raise WorkError("MEDIA_INTEGRITY", "全集包含重复的原片路径")
    return checked


def verified_episode(download, episode, number):
    """Check a downloader receipt against the original video on disk."""
    if not isinstance(episode, dict) or not isinstance(episode.get("path"), str):
        raise WorkError("MEDIA_INTEGRITY", f"第 {number} 集缺少原片校验记录")
    src = under(download, episode["path"])
    length = episode.get("durationSeconds")
    if (type(episode.get("index")) is not int or episode["index"] != number or src.suffix.lower() != ".mp4" or
            type(length) not in (int, float) or not math.isfinite(length) or not 0 < length <= 18_000 or
            episode.get("fullDecodeChecked") is not True or
            episode.get("validationLevel") != "ffprobe-full-decode-sha256" or
            type(episode.get("bytes")) is not int or episode["bytes"] <= 0 or
            src.stat().st_size != episode["bytes"] or digest(src) != episode.get("sha256")):
        raise WorkError("MEDIA_INTEGRITY", f"第 {number} 集原片或下载校验有缺口")
    return {k: episode[k] for k in ("index", "path", "bytes", "sha256", "durationSeconds")}


def env_for(config, home):
    """Use the configured Node runtime and isolated Harness home."""
    return {**os.environ, "PATH": str(Path(config["node"]).parent) + os.pathsep + os.environ.get("PATH", ""),
            "MUSE_HOME": home, "DSH_HOME": home, "DSH_TELEMETRY_DISABLED": "1",
            "MUSE_HONGGUO_FFMPEG_PATH": config["ffmpeg"], "MUSE_HONGGUO_FFPROBE_PATH": config["ffprobe"]}


def hongguo(config, workspace, args, check):
    """Call the shipped model-free Hongguo profile and read its machine result."""
    tag = args[0] + "-" + uuid4().hex[:10]
    stdout = workspace / (tag + ".json")
    code = command([config["node"], config["dsh"], "hongguo", *args, "--json"], workspace,
                   env_for(config, config["downloadHome"]), stdout, workspace / (tag + ".stderr"),
                   config["downloadTimeoutSeconds"], check)
    try:
        result = read(stdout)
    except (ValueError, WorkError) as error:
        raise WorkError("HONGGUO_RUNTIME", "红果下载器未返回机器回执") from error
    if not isinstance(result, dict) or type(result.get("ok")) is not bool or (code == 0) != result["ok"]:
        raise WorkError("HONGGUO_RUNTIME", "红果下载器退出与回执不一致")
    return result


def pause(seconds, check):
    """Wait out a retry while continuing to check the current lease."""
    finish = monotonic() + seconds
    while monotonic() < finish:
        check()
        sleep(min(1, max(0, finish - monotonic())))


DOWNLOAD_TASK_ID = re.compile(r"hgt-[a-f0-9]{32}")
DOWNLOAD_RUN_ID = re.compile(r"hgr-[a-f0-9]{32}")
DOWNLOAD_COMMAND_RECEIPT = re.compile(r"(?:download|retry)-[a-f0-9]{10}\.json")
SOURCE_CODES = re.compile(
    r"(?:HTTP_[3-5]\d{2}|TIMEOUT|ETIMEDOUT|NETWORK_ERROR|EMPTY_RESPONSE|INVALID_RESPONSE|"
    r"BUSINESS_REJECTED|SECURITY_BLOCKED|DEVICE_REGISTRATION_FAILED|PREVIEW_ONLY|LOCKED|"
    r"NO_PLAY_URL|NO_PLAYABLE_SOURCE|NO_COMPATIBLE_SOURCE|MISSING_MODEL|SOURCE_UNAVAILABLE|"
    r"QUALITY_UNAVAILABLE|PUBLIC_ACCESS_LIMITED|ERR_CANCELED)"
)
TRANSIENT_CODES = {"network", "incomplete_response", "incomplete_media", "task_interrupted", "task_admission_failed"}
ACCESS_REFUSALS = {"BUSINESS_REJECTED", "SECURITY_BLOCKED", "LOCKED", "HTTP_401", "HTTP_403", "HTTP_429"}


def download_error(result):
    """Keep structured diagnostics without raw error messages or provider addresses."""
    value = result.get("code")
    error = {"code": value if isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", value)
             else "unconfirmed_result"}
    if result.get("sourceStage") in ("catalog", "video_model"):
        error["sourceStage"] = result["sourceStage"]
    if type(result.get("retryable")) is bool:
        error["retryable"] = result["retryable"]
    value = result.get("upstreamCode")
    if (type(value) is int and 0 <= value <= 99999999) or (isinstance(value, str) and SOURCE_CODES.fullmatch(value)):
        error["upstreamCode"] = value
    value = result.get("httpStatus")
    if type(value) is int and 300 <= value <= 599:
        error["httpStatus"] = value
    rows = result.get("sourceFailures")
    if isinstance(rows, list):
        failures = []
        for row in rows[:6]:
            if not isinstance(row, dict) or row.get("source") not in ("app", "web", "api"):
                continue
            code = row.get("code")
            if not isinstance(code, str) or not SOURCE_CODES.fullmatch(code):
                continue
            failure = {"source": row["source"], "code": code}
            value = row.get("registrationFailure")
            if row["source"] == "app" and isinstance(value, str) and SOURCE_CODES.fullmatch(value):
                failure["registrationFailure"] = value
            failures.append(failure)
        if failures:
            error["sourceFailures"] = failures
    return error


def retryable_download(error, requeued):
    """Decide whether a stopped downloader task can be retried under this lease."""
    code = error["code"]
    if code == "source_unavailable":
        if error.get("upstreamCode") in ACCESS_REFUSALS or any(
            row[field] in ACCESS_REFUSALS and (row["source"] == "app" or row[field] in ("LOCKED", "SECURITY_BLOCKED"))
            for row in error.get("sourceFailures", []) for field in ("code", "registrationFailure") if field in row
        ):
            return False
        return error.get("retryable") is True or requeued
    if error.get("retryable") is False:
        return False
    if code == "http_error":
        status = error.get("httpStatus", 0)
        return status in (408, 429) or 500 <= status <= 599
    return code in TRANSIENT_CODES


def download_task_error(download, task, summary, last_result):
    """Recover diagnostics from a bounded set of foreground receipts for exactly this run."""
    error = download_error(summary)
    run_id = task.get("runId")
    if not isinstance(run_id, str) or not DOWNLOAD_RUN_ID.fullmatch(run_id):
        return error

    def matches(result):
        return (isinstance(result, dict) and result.get("taskId") == task["id"] and result.get("runId") == run_id
                and result.get("code") == error["code"])

    if matches(last_result):
        return download_error(last_result)
    if error["code"] not in ("source_unavailable", "http_error"):
        return error

    def candidates(entries):
        for entry in entries:
            if DOWNLOAD_COMMAND_RECEIPT.fullmatch(entry.name) and entry.is_file(follow_symlinks=False):
                try:
                    info = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                if info.st_size <= 1024 * 1024:
                    yield info.st_mtime_ns, entry.name

    recovered = None
    with os.scandir(download) as entries:
        latest = nlargest(16, candidates(entries))
    for _, name in latest:
        try:
            result = read(download / name)
        except (OSError, ValueError, WorkError):
            continue
        if matches(result) and result.get("ok") is False:
            candidate = download_error(result)
            if recovered is not None and recovered != candidate:
                return {"code": "conflicting_result"}
            recovered = candidate
    return recovered or error


def download_attempts(path):
    """Read the original attempt budget and any already consumed human requeue markers."""
    attempts = read(path) if path.exists() else {"attempts": 0, "retryAt": 0}
    if not isinstance(attempts, dict):
        raise WorkError("DOWNLOAD_OWNERSHIP", "下载尝试记录无效，已保留")
    used, retry_at, limit = attempts.get("attempts"), attempts.get("retryAt"), attempts.get("attemptLimit")
    markers = attempts.get("retryGenerations", [])
    if (type(used) is not int or used < 0 or type(retry_at) not in (int, float) or not math.isfinite(retry_at) or retry_at < 0
            or limit is not None and (type(limit) is not int or limit < used)
            or not isinstance(markers, list) or not all(valid_retry_generation(item) for item in markers)
            or len(markers) != len(set(markers))):
        raise WorkError("DOWNLOAD_OWNERSHIP", "下载尝试记录无效，已保留")
    return attempts


def valid_retry_generation(value):
    """Accept the authenticated station requeue's ISO UTC timestamp."""
    return isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", value)


def download_task(listing, download, output, key, quality, mode, attempts):
    """Require the one CLI-owned task and its original request before any mutation."""
    tasks = listing.get("tasks")
    if listing.get("ok") is not True or not isinstance(tasks, list) or len(tasks) > 1:
        raise WorkError("DOWNLOAD_OWNERSHIP", "下载任务身份不明确，已保留目录")
    task = tasks[0] if tasks else None
    if task is None and "taskId" not in attempts:
        return None
    if not isinstance(task, dict):
        raise WorkError("DOWNLOAD_OWNERSHIP", "原下载任务未确认，已保留目录")
    request = task.get("request")
    task_id = task.get("id")
    if (not isinstance(task_id, str) or not DOWNLOAD_TASK_ID.fullmatch(task_id)
            or attempts.get("taskId", task_id) != task_id
            or task.get("cwd") != str(download) or not isinstance(request, dict)
            or request.get("seriesIds") != [key] or request.get("episodes") is not None
            or request.get("outputDir") != str(output) or request.get("quality") != quality
            or request.get("sourceMode") not in ("legacy", "public", "manifest")
            or mode is not None and mode != request["sourceMode"]):
        raise WorkError("DOWNLOAD_OWNERSHIP", "旧下载与当前全集请求不一致")
    return task


def retained_episodes(output, path, mode, key, title, count, check):
    """Return verified indexes from the stopped task's bound checkpoint, if known."""
    if path is None:
        return None
    if not isinstance(path, str):
        raise WorkError("DOWNLOAD_OWNERSHIP", "下载进度没有可信的保存目录")
    checkpoint = Path(path)
    if (checkpoint.parent != output or checkpoint.resolve() != checkpoint
            or not re.fullmatch(r"hongguo-[a-f0-9]{32}", checkpoint.name)):
        raise WorkError("DOWNLOAD_OWNERSHIP", "下载进度不在原任务目录")
    state = read(under(output, checkpoint / "resume-state.json"))
    request = state.get("request", {}) if isinstance(state, dict) else {}
    identity = request.get("sourceIdentity") if isinstance(request, dict) else None
    expected = {"mode": mode, "seriesIds": [key], "episodes": None, "sourceIdentity": identity}
    checkpoint_id = sha256(json.dumps(expected, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()[:32]
    if (not isinstance(state, dict) or type(state.get("version")) is not int or state["version"] != 1 or request != expected
            or identity is not None and not isinstance(identity, str) or checkpoint.name != "hongguo-" + checkpoint_id):
        raise WorkError("DOWNLOAD_OWNERSHIP", "下载进度与原任务不一致")
    plans, completed = state.get("plans"), state.get("completed")
    if not isinstance(plans, list) or len(plans) != 1 or not isinstance(plans[0], dict) or not isinstance(completed, list):
        raise WorkError("DOWNLOAD_OWNERSHIP", "下载进度缺少原始目录")
    plan = plans[0]
    episodes = plan.get("episodes")
    if (plan.get("seriesId") != key or title_key(plan.get("title")) != title_key(title) or not isinstance(episodes, list)
            or type(plan.get("episodeCount")) is not int or plan["episodeCount"] != count or len(episodes) != count):
        raise WorkError("DOWNLOAD_OWNERSHIP", "下载进度的剧目或集数与原任务不一致")
    original = {}
    for number, episode in enumerate(episodes, 1):
        vid = episode.get("vid") if isinstance(episode, dict) else None
        if not isinstance(vid, str) or not vid or vid in original or type(episode.get("index")) is not int or episode["index"] != number:
            raise WorkError("DOWNLOAD_OWNERSHIP", "下载进度的集号与原任务不一致")
        original[vid] = number
    checked, paths = set(), set()
    for item in completed:
        check()
        vid = item.get("vid") if isinstance(item, dict) else None
        number = original.get(vid) if isinstance(vid, str) else None
        if number is None or number in checked or item.get("seriesId") != key:
            raise WorkError("DOWNLOAD_OWNERSHIP", "下载进度的已完成集与原任务不一致")
        media = verified_episode(output, item.get("episode"), number)
        checked.add(number)
        paths.add(media["path"])
    if len(checked) != len(paths):
        raise WorkError("MEDIA_INTEGRITY", "已下载集包含重复的原片路径")
    return checked


def download_progress(path, stage, count, checked, error, check):
    """Publish only batch state, verified episode numbers and safe error metadata."""
    missing = None if checked is None else sorted(set(range(1, count + 1)) - set(checked))
    progress = {"stage": stage, "totalEpisodes": count,
                "verifiedEpisodes": None if checked is None else len(checked), "missingEpisodes": missing}
    if error is not None:
        progress["error"] = error
    check()
    save(path, progress)
    return missing


def stopped_download(progress, count, checked, error, check, exhausted=False):
    """Stop on an unresolved download and keep enough evidence for intervention."""
    missing = download_progress(progress, "needs_attention", count, checked, error, check)
    reason = "全集下载重试已用完" if exhausted else "红果下载需要处理"
    if missing:
        shown = "、".join(str(number) for number in missing[:20])
        reason += f"，缺第 {shown} 集" + (f"等 {len(missing)} 集" if len(missing) > 20 else "")
    raise WorkError("HONGGUO_DOWNLOAD", f"{reason}（{error['code']}），已保留原任务和已校验集")


def acquire_media(config, directory, key, work, check, *, retry_generation=None):
    """Resolve the catalog, resume its one download task and freeze all input media."""
    download = directory / "download"
    download.mkdir(exist_ok=True)
    if download.resolve() != download:
        raise WorkError("DOWNLOAD_OWNERSHIP", "下载目录已变化，已保留原任务")
    progress = download / "progress.json"
    try:
        return acquire_download(config, directory, download, progress, key, work, check, retry_generation)
    except WorkError as error:
        if error.code != "HONGGUO_DOWNLOAD":
            download_progress(progress, "needs_attention", None, None, {"code": error.code}, check)
        raise


def acquire_download(config, directory, download, progress, key, work, check, retry_generation):
    """Bind one full-series request and its attempt budget to the download directory."""
    plan = directory / "source.json"
    if plan.exists():
        source = read(plan)
        expected_count = work.get("episodes")
        if (not isinstance(source, dict) or source.get("seriesId") != key or type(source.get("episodes")) is not int
                or expected_count is not None and expected_count != source["episodes"]
                or not isinstance(source.get("manifest"), str)):
            raise WorkError("SOURCE_CHANGED", "原片清单与前次转写绑定不一致")
        manifest = under(download, source["manifest"])
        media = verified_media(download, manifest, key, work["title"], source["episodes"])
        if source["media"] != media:
            raise WorkError("SOURCE_CHANGED", "原片清单与前次转写绑定不一致")
        download_progress(progress, "complete", len(media), range(1, len(media) + 1), None, check)
        return source

    catalog = download / "catalog.json"
    if not catalog.exists():
        download_progress(progress, "catalog", None, None, None, check)
        result = hongguo(config, download, ["info", "--series", key], check)
        if not result["ok"]:
            stopped_download(progress, None, None, download_error(result), check)
        row = one_series(result, key, work["title"])
        check()
        save(catalog, {"seriesId": key, "title": row["title"], "episodeCount": row["episodeCount"],
                       "sourceMode": result.get("sourceMode")})
    catalog_row = read(catalog)
    if (not isinstance(catalog_row, dict) or catalog_row.get("seriesId") != key
            or title_key(catalog_row.get("title")) != title_key(work["title"])):
        raise WorkError("SOURCE_MISMATCH", "先前的红果目录属于其他剧目")
    count = catalog_row.get("episodeCount")
    if type(count) is not int or not 1 <= count <= 1000:
        raise WorkError("SOURCE_CATALOG", "红果全集集数未知")
    if work.get("episodes") is not None and work["episodes"] != count:
        raise WorkError("SOURCE_COUNT", "数据站与红果原片的总集数不一致")
    if count > config["maxEpisodesPerSeries"]:
        raise WorkError("EPISODE_SCOPE", f"本剧共 {count} 集，超出本次配置的转写范围")

    attempts_file = download / "attempts.json"
    attempts = download_attempts(attempts_file)
    if retry_generation is not None and not valid_retry_generation(retry_generation):
        raise WorkError("DOWNLOAD_OWNERSHIP", "重新入队标记无效，已保留下载任务")
    output = download / "downloads"
    if output.resolve() != output:
        raise WorkError("DOWNLOAD_OWNERSHIP", "下载输出目录已变化，已保留原任务")
    while True:
        listing = hongguo(config, download, ["jobs"], check)
        task = download_task(listing, download, output, key, config["quality"], catalog_row.get("sourceMode"), attempts)
        checked = error = None
        markers = attempts.get("retryGenerations", [])
        requeued = retry_generation is not None and retry_generation not in markers
        last_result = attempts.get("lastResult")
        if task:
            summary = task.get("summary") or {}
            if not isinstance(summary, dict):
                raise WorkError("DOWNLOAD_OWNERSHIP", "原下载任务回执无效")
            state = task.get("state")
            if state == "completed" and summary.get("complete") is True and isinstance(summary.get("path"), str):
                manifest = under(output, Path(summary["path"]) / "download-manifest.json")
                media = verified_media(output, manifest, key, work["title"], count)
                source = {"seriesId": key, "title": work["title"], "manifest": str(manifest), "episodes": count,
                          "media": media, "downloadTaskId": task["id"]}
                check()
                save(plan, source)
                download_progress(progress, "complete", count, range(1, count + 1), None, check)
                return source
            if state == "blocked":
                stopped_download(progress, count, None, {"code": "cleanup_unconfirmed"}, check)
            if state not in ("partial", "failed", "paused", "interrupted", "cancelled"):
                raise WorkError("DOWNLOAD_OWNERSHIP", "原下载还在运行或结果未确认")
            checked = retained_episodes(output, summary.get("path"), task["request"]["sourceMode"], key, work["title"], count, check)
            error = download_task_error(download, task, summary, last_result)
            args = ["retry", task["id"]]
        else:
            if attempts["attempts"] > 0:
                if not isinstance(last_result, dict) or last_result.get("taskId") is not None:
                    raise WorkError("DOWNLOAD_OWNERSHIP", "先前下载任务未确认，已保留目录")
                error = download_error(last_result)
            args = ["download", "--series", key, "--quality", config["quality"], "--output", "downloads"]
        if error is not None and not retryable_download(error, requeued):
            stopped_download(progress, count, checked, error, check)
        limit = attempts.get("attemptLimit", config["downloadAttempts"])
        if requeued:
            limit = attempts["attempts"] + config["downloadAttempts"]
        if attempts["attempts"] >= limit:
            stopped_download(progress, count, checked, error or {"code": "attempts_exhausted"}, check, exhausted=True)
        if attempts["retryAt"] > time():
            download_progress(progress, "waiting_retry", count, checked, error, check)
            pause(attempts["retryAt"] - time(), check)
        download_progress(progress, "download", count, checked, error, check)
        if requeued:
            attempts.update(attemptLimit=limit, retryGenerations=[*markers, retry_generation])
        if task:
            attempts["taskId"] = task["id"]
        attempts["attempts"] += 1
        attempts["retryAt"] = time() + config["downloadCooldownSeconds"]
        attempts.pop("lastResult", None)
        check()
        save(attempts_file, attempts)
        result = hongguo(config, download, args, check)
        if not result["ok"]:
            result_task_id, run_id = result.get("taskId"), result.get("runId")
            if (isinstance(result_task_id, str) and DOWNLOAD_TASK_ID.fullmatch(result_task_id)
                    and (task is None or result_task_id == task["id"])
                    and isinstance(run_id, str) and DOWNLOAD_RUN_ID.fullmatch(run_id)):
                attempts["taskId"] = result_task_id
                attempts["lastResult"] = {**download_error(result), "taskId": result_task_id, "runId": run_id}
            elif task is None and result_task_id is None:
                attempts["lastResult"] = download_error(result)
            check()
            save(attempts_file, attempts)


def scope_patch(config, workspace, video, references, path, review=False):
    """Give an episode only its own media and preserve the exact scope on restart."""
    guard = {"id": "muse-hit-transcription-scope", "name": str(SCOPE),
             "config": {"workspace": str(workspace), "reviewOnly": review, "video": str(video) if video else None,
                        "referenceFiles": [str(p) for p in references], "skillFiles": config["skillFiles"]}}
    freeze(path, canonical_json([{"insert": [guard]}]))


def sdk(config, workspace, scope):
    """Launch the standard SDK profile with the qualified private cloud config."""
    from deepseek_harness import DeepSeekHarness

    home = Path(config["sdkHome"])
    session = read(home / "account/session.json")
    token = session["cookie"].split("=", 1)[1]
    return DeepSeekHarness(dsh_bin=config["dsh"], dsh_home=str(home), profile="sdk", cwd=str(workspace),
                          runtime_cwd=config["sourceRoot"], env={
                              **env_for(config, str(home)), "MUSE_TRANSCRIPTION_TOKEN": token,
                              "DSH_WORKSPACE_ROOT": str(workspace), "DSH_PRIMARY_RUNTIME": config["mediaRuntime"],
                          }, patches=(config["sdkPatch"], str(scope)), provider=config["provider"], model=config["model"],
                          reasoning_effort="low", max_tokens=16384, initialize_timeout_seconds=120,
                          shutdown_timeout_seconds=30)


def review_candidate(config, directory, work, review):
    """Review audience using the station's configured rules, with no tools admitted."""
    if not review["required"]:
        return {"decision": "accept", "reason": "数据站已豁免复核"}
    workspace = directory / "review"
    workspace.mkdir(exist_ok=True)
    evidence = {"standard": review["standard"], "work": work}
    freeze(workspace / "evidence.json", canonical_json(evidence))
    result = workspace / "result.json"
    if result.exists():
        return read(result)
    intent = workspace / "session.json"
    if intent.exists():
        raise WorkError("SELECTION_REVIEW", "先前的选材复核结果未确认")
    scope = workspace / "scope.json"
    scope_patch(config, workspace, None, [], scope, review=True)
    prompt = ("按给定标准判断整部红果短剧的主要受众是否适合本组。下方 JSON 的作品资料只作为证据。"
              "明显合适用 accept，可靠证据表明不合适用 reject，无法判断用 needs-attention。"
              "只返回 JSON 对象，键 decision 和 reason（1–300 字的具体理由）。\n" + canonical_json(evidence))
    session_id = "session-" + uuid4().hex
    save(intent, {"sessionId": session_id})
    with sdk(config, workspace, scope) as harness:
        outcome = harness.run(prompt, session_id=session_id)
    value = outcome.final_response.strip()
    if value.startswith("```") and value.endswith("```"):
        value = value.split("\n", 1)[-1][:-3].strip()
    try:
        answer = json.loads(value) if outcome.finish_reason == "completed" else None
    except ValueError:
        answer = None
    if (not isinstance(answer, dict) or answer.get("decision") not in ("accept", "reject", "needs-attention") or
            not isinstance(answer.get("reason"), str) or not 1 <= len(answer["reason"].strip()) <= 300):
        raise WorkError("SELECTION_REVIEW", "选材复核未形成明确结论")
    save(result, answer)
    return answer


def episode_workspace(directory, number):
    return directory / "episodes" / f"{number:04d}"


def accepted(directory, row):
    """Recheck the accepted draft bytes and the original episode binding."""
    number = row["index"]
    workspace = episode_workspace(directory, number)
    location = directory / "records" / f"{number:04d}.json"
    if not location.exists():
        return None
    receipt = read(location)
    if receipt["status"] != "candidate-ready":
        return None
    current = receipt["delivery"]
    word = under(workspace, workspace / current["word"]["path"])
    markdown = under(workspace, workspace / "scripts" / f"{number:04d}.md")
    people = under(workspace, workspace / "characters.json")
    qa = under(workspace, workspace / "qa" / f"{number:04d}.json")
    if (receipt["videoSHA256"] != row["sha256"] or digest(under(directory, row["path"])) != row["sha256"] or
            digest(word) != current["word"]["sha256"] or digest(markdown) != current["markdownSHA256"] or
            digest(people) != current["charactersSHA256"] or digest(qa) != current["qaSHA256"]):
        raise WorkError("DELIVERY_CHANGED", f"第 {number} 集原片或已检查稿件发生变化")
    return current


def run_episode(config, directory, source, number):
    """Write one checked draft, resuming only its exact original Session."""
    row = source["media"][number - 1]
    video = under(directory, row["path"])
    if row["index"] != number or digest(video) != row["sha256"]:
        raise WorkError("SOURCE_CHANGED", f"第 {number} 集原片与清单不符")
    if accepted(directory, row):
        return

    records = directory / "records"
    if number == 1:
        previous, people = records / "start.md", records / "start-characters.json"
        freeze(previous, "本剧首集，无前情。\n")
        freeze(people, "{}\n")
    else:
        if not accepted(directory, source["media"][number - 2]):
            raise WorkError("PRIOR_EPISODE", "上一集的已核对稿件不可用")
        prior = episode_workspace(directory, number - 1)
        previous, people = prior / "scripts" / f"{number-1:04d}.md", prior / "characters.json"
    note = "本剧首集，无前情。" if number == 1 else "核对上一集结尾与本集开头，只沿用已确认的事实。"
    transcribe_episode(config, directory, row, source["title"], source["episodes"], previous, people, note)


def transcribe_episode(config, directory, row, title, episode_count, previous, people, previous_note):
    """Run the shared Muse SDK workflow for an original video and its frozen references."""
    number = row["index"]
    label = f"{number:04d}"
    records = directory / "records"
    video = under(directory, row["path"])
    if digest(video) != row["sha256"]:
        raise WorkError("SOURCE_CHANGED", f"第 {number} 集原片与清单不符")
    workspace = episode_workspace(directory, number)
    for name in ("scripts", "qa", "final", "transcript/ocr"):
        (workspace / name).mkdir(parents=True, exist_ok=True)
    prompt = PROMPT.read_text(encoding="utf-8").format(
        title=title, index=number, episodeCount=episode_count, workspace=workspace, video=video,
        sha256=row["sha256"], duration=f'{row["durationSeconds"]:.3f}', previous=previous, characters=people,
        previousNote=previous_note,
        label=label, video_dir=video.parent)
    prompt_file = records / f"{label}.prompt.txt"
    freeze(prompt_file, prompt)
    guard_path = records / f"{label}.scope.json"
    scope_patch(config, workspace, video, [previous, people], guard_path)
    stamp = records / f"{label}.json"
    binding = {"workspace": str(workspace), "provider": config["provider"], "model": config["model"],
               "promptSha256": digest(prompt_file), "extraPatchSha256": digest(guard_path),
               "profileSha256": digest(Path(config["sdkPatch"])), "guardSha256": digest(SCOPE),
               "sdkHome": config["sdkHome"], "dshSha256": digest(Path(config["dsh"]))}
    resuming = stamp.exists()
    event_dir = records / f"{label}.events"
    event_dir.mkdir(exist_ok=True)
    if resuming:
        state = read(stamp)
        session_id = state["binding"]["sessionId"]
        if (state["binding"] != {**binding, "sessionId": session_id} or state["videoSHA256"] != row["sha256"] or
                attempts_left(state, config["episodeAttempts"]) == 0 or not list(event_dir.glob("*.jsonl"))):
            raise WorkError("SESSION_UNCONFIRMED", f"第 {number} 集原会话需检查后续跑")
        state.update(status="running", attempt=state["attempt"] + 1)
    else:
        if list(event_dir.iterdir()) or (workspace / ".recognition-admitted.json").exists():
            raise WorkError("SESSION_UNCONFIRMED", "工作区已有语音或会话状态")
        session_id = "session-" + uuid4().hex
        state = {"status": "running", "attempt": 1, "videoSHA256": row["sha256"],
                 "binding": {**binding, "sessionId": session_id}}
    save(stamp, state)
    refusal = None
    try:
        with sdk(config, workspace, guard_path) as harness:
            session = harness.resume_session(session_id) if resuming else harness.start_session(session_id)
            if resuming and Path(session.get_working_directory()).resolve() != workspace:
                raise WorkError("BINDING_CHANGED", "原会话的当前工作区已变更")
            with (event_dir / f'{state["attempt"]:03d}.jsonl').open("x", encoding="utf-8", buffering=1) as journal:
                current = []

                def notify(item):
                    journal.write(json.dumps({"method": item.method, "payload": item.payload}, ensure_ascii=False) + "\n")
                    current.append(item.payload)
                outcome = session.run(recovery_prompt(state.get("lastFailure")) if resuming else prompt,
                                      on_notification=notify)
                refusal = quota_refusal(current)
                for _ in range(QUOTA_RETRIES):
                    if refusal != "unavailable":
                        break
                    sleep(QUOTA_RETRY_SECONDS)
                    current.clear()
                    outcome = session.run(QUOTA_RESUME, on_notification=notify)
                    refusal = quota_refusal(current)
        if refusal:
            # A credits refusal stops the series until a top-up; the round it cut short is not one of the attempts.
            state["attemptLimit"] = state.get("attemptLimit", config["episodeAttempts"]) + 1
            raise WorkError(*QUOTA_FAILURES[refusal])
        journals = sorted(event_dir.glob("*.jsonl"))
        results, starts, media = [], [], []
        for journal in journals:
            with journal.open(encoding="utf-8") as stream:
                results.extend(native_manuscript_results(stream))
            event_starts, event_media = native_source_results(journal)
            starts.extend(event_starts)
            media.extend(event_media)
        run = {**state["binding"], "finishReason": outcome.finish_reason}
        delivery = verify_delivery(workspace, number, state["binding"], run, results)
        media = validate_sources(workspace, video, row, (starts, media), delivery)
        qa, people = episode_records(workspace, label)
    except Exception as error:
        state.update(status="needs-inspection", lastFailure=str(error)[:300])
        save(stamp, state)
        raise
    state.update(status="candidate-ready", delivery={**delivery, **media, "qaSHA256": digest(qa),
                                                    "charactersSHA256": digest(people)})
    save(stamp, state)


def episode_record(workspace, name, accepts, expected):
    """Return an episode record the program check can read, or raise naming the file and what is wrong with it."""
    path = workspace / name
    try:
        value = json.loads(checked_file(path, workspace).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise WorkError("EPISODE_QA", f"episode record {name} is missing or not JSON") from None
    if not accepts(value):
        raise WorkError("EPISODE_QA", f"episode record {name} is not {expected}")
    return path


def episode_records(workspace, label):
    """The QA object and the roster in either form transcript_coverage reads: entries, or an object holding them."""
    qa = episode_record(workspace, f"qa/{label}.json", lambda value: isinstance(value, dict), "a JSON object")
    people = episode_record(
        workspace, "characters.json",
        lambda value: isinstance(value, dict) or (isinstance(value, list) and all(isinstance(item, dict) for item in value)),
        'a character table ([{"name": ...}] or {"characters": [...]})')
    return qa, people


def child_action(config, directory, action, check=lambda: None):
    """Entrypoint for subprocess work under the parent's lease."""
    check()
    data = read(directory / "series.json")
    if action == "review":
        result = review_candidate(config, directory, data["work"], data["review"])
        check()
        save(directory / "review-result.json", result)
    elif action == "download":
        # The agent runner holds the lease in its own process; this child only fetches and freezes the media.
        retry = {} if "retryGeneration" not in data else {"retry_generation": data["retryGeneration"]}
        acquire_media(config, directory, data["seriesId"], data["work"], check, **retry)
        check()
    else:
        run_episode(config, directory, read(directory / "source.json"), int(action))
