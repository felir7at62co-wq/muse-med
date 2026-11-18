"""Run verified Hongguo downloads and the native Muse episode workflow."""

import json
import math
import os
from pathlib import Path
import re
from time import monotonic, sleep, time
import unicodedata
from uuid import uuid4

from common import WorkError, canonical_json, command, digest, freeze, read, save, under
from verification import checked_file, native_manuscript_results, native_source_results, validate_sources, verify_delivery

CODE = Path(__file__).resolve().parent
SCOPE = CODE / "episode-scope.mjs"
PROMPT = CODE / "episode-prompt.txt"
RECOVERY = """继续原会话完成本集校验。沿用原片与已完成的语音；语音未完成用 inspect 查原收据，状态不明则保留并报告。查看原 review_id 的当前 pending，用 next 和 observe 核完全部补帧，再核对正文。仍有看帧不能解决的疑点留 QA。基于当前稿重新做对白核对和交付登记；正文有改动则先另存 Word 新版。沿用首条任务的来源和交付约束。"""


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
    checked = []
    for number, episode in enumerate(files, 1):
        src = under(download, episode["path"])
        length = episode.get("durationSeconds")
        if (type(episode.get("index")) is not int or episode["index"] != number or src.suffix.lower() != ".mp4" or
                type(length) not in (int, float) or not math.isfinite(length) or not 0 < length <= 18_000 or
                episode.get("fullDecodeChecked") is not True or
                episode.get("validationLevel") != "ffprobe-full-decode-sha256" or
                src.stat().st_size <= 0 or src.stat().st_size != episode.get("bytes") or digest(src) != episode.get("sha256")):
            raise WorkError("MEDIA_INTEGRITY", f"第 {number} 集原片或下载校验有缺口")
        checked.append({k: episode[k] for k in ("index", "path", "bytes", "sha256", "durationSeconds")})
    if len({episode["path"] for episode in checked}) != expected:
        raise WorkError("MEDIA_INTEGRITY", "全集包含重复的原片路径")
    return checked


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


def acquire_media(config, directory, key, work, check):
    """Resolve the catalog, resume its one download task and freeze all input media."""
    download = directory / "download"
    download.mkdir(exist_ok=True)
    plan = directory / "source.json"
    if plan.exists():
        source = read(plan)
        manifest = under(download, source["manifest"])
        media = verified_media(download, manifest, key, work["title"], source["episodes"])
        if source["media"] != media:
            raise WorkError("SOURCE_CHANGED", "原片清单与前次转写绑定不一致")
        return source

    catalog = download / "catalog.json"
    if not catalog.exists():
        row = one_series(hongguo(config, download, ["info", "--series", key], check), key, work["title"])
        save(catalog, {"seriesId": key, "title": row["title"], "episodeCount": row["episodeCount"]})
    catalog_row = read(catalog)
    count = catalog_row["episodeCount"]
    if catalog_row["seriesId"] != key or title_key(catalog_row["title"]) != title_key(work["title"]):
        raise WorkError("SOURCE_MISMATCH", "先前的红果目录属于其他剧目")
    if work.get("episodes") is not None and work["episodes"] != count:
        raise WorkError("SOURCE_COUNT", "数据站与红果原片的总集数不一致")
    if count > config["maxEpisodesPerSeries"]:
        raise WorkError("EPISODE_SCOPE", f"本剧共 {count} 集，超出本次配置的转写范围")

    attempts_file = download / "attempts.json"
    attempts = read(attempts_file) if attempts_file.exists() else {"attempts": 0, "retryAt": 0}
    output = download / "downloads"
    while True:
        listing = hongguo(config, download, ["jobs"], check)
        tasks = listing.get("tasks")
        if not listing["ok"] or not isinstance(tasks, list) or len(tasks) > 1:
            raise WorkError("DOWNLOAD_OWNERSHIP", "下载任务身份不明确，已保留目录")
        task = tasks[0] if tasks else None
        if task:
            request = task.get("request", {})
            if (task.get("cwd") != str(download) or request.get("seriesIds") != [key] or
                    request.get("episodes") is not None or Path(request.get("outputDir", "")).resolve() != output or
                    request.get("quality") != config["quality"]):
                raise WorkError("DOWNLOAD_OWNERSHIP", "旧下载与当前全集请求不一致")
            summary = task.get("summary") or {}
            if task["state"] == "completed" and summary.get("complete") is True:
                manifest = under(download, Path(summary["path"]) / "download-manifest.json")
                media = verified_media(download, manifest, key, work["title"], count)
                source = {"seriesId": key, "title": work["title"], "manifest": str(manifest), "episodes": count,
                          "media": media, "downloadTaskId": task["id"]}
                save(plan, source)
                return source
            if task["state"] not in ("partial", "failed", "paused", "interrupted"):
                raise WorkError("DOWNLOAD_OWNERSHIP", "原下载还在运行或结果未确认")
            if not re.fullmatch(r"hgt-[a-z0-9]{32}", task["id"]):
                raise WorkError("DOWNLOAD_OWNERSHIP", "旧下载编号不可信")
            if summary.get("code") and any(word in summary["code"] for word in ("auth", "license", "source_changed", "cleanup", "permission")):
                raise WorkError("HONGGUO_DOWNLOAD", "红果下载需要处理来源、权限或未退出进程")
            args = ["retry", task["id"]]
        else:
            args = ["download", "--series", key, "--quality", config["quality"], "--output", "downloads"]
        if attempts["attempts"] >= config["downloadAttempts"]:
            raise WorkError("HONGGUO_DOWNLOAD", "全集下载仍有缺集，已保留原任务和成功集数")
        if attempts["retryAt"] > time():
            pause(attempts["retryAt"] - time(), check)
        attempts["attempts"] += 1
        attempts["retryAt"] = time() + config["downloadCooldownSeconds"]
        save(attempts_file, attempts)
        hongguo(config, download, args, check)


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
    label = f"{number:04d}"
    row = source["media"][number - 1]
    video = under(directory, row["path"])
    if row["index"] != number or digest(video) != row["sha256"]:
        raise WorkError("SOURCE_CHANGED", f"第 {number} 集原片与清单不符")
    if accepted(directory, row):
        return

    records = directory / "records"
    workspace = episode_workspace(directory, number)
    for name in ("scripts", "qa", "final", "transcript/ocr"):
        (workspace / name).mkdir(parents=True, exist_ok=True)
    if number == 1:
        previous, people = records / "start.md", records / "start-characters.json"
        freeze(previous, "本剧首集，无前情。\n")
        freeze(people, "{}\n")
    else:
        if not accepted(directory, source["media"][number - 2]):
            raise WorkError("PRIOR_EPISODE", "上一集的已核对稿件不可用")
        prior = episode_workspace(directory, number - 1)
        previous, people = prior / "scripts" / f"{number-1:04d}.md", prior / "characters.json"
    prompt = PROMPT.read_text(encoding="utf-8").format(
        title=source["title"], index=number, episodeCount=source["episodes"], workspace=workspace, video=video,
        sha256=row["sha256"], duration=f'{row["durationSeconds"]:.3f}', previous=previous, characters=people,
        previousNote="本剧首集，无前情。" if number == 1 else "核对上一集结尾与本集开头，只沿用已确认的事实。",
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
                state["attempt"] >= config["episodeAttempts"] or not list(event_dir.glob("*.jsonl"))):
            raise WorkError("SESSION_UNCONFIRMED", f"第 {number} 集原会话需检查后续跑")
        state.update(status="running", attempt=state["attempt"] + 1)
    else:
        if list(event_dir.iterdir()) or (workspace / ".recognition-admitted.json").exists():
            raise WorkError("SESSION_UNCONFIRMED", "工作区已有语音或会话状态")
        session_id = "session-" + uuid4().hex
        state = {"status": "running", "attempt": 1, "videoSHA256": row["sha256"],
                 "binding": {**binding, "sessionId": session_id}}
    save(stamp, state)
    try:
        with sdk(config, workspace, guard_path) as harness:
            session = harness.resume_session(session_id) if resuming else harness.start_session(session_id)
            if resuming and Path(session.get_working_directory()).resolve() != workspace:
                raise WorkError("BINDING_CHANGED", "原会话的当前工作区已变更")
            with (event_dir / f'{state["attempt"]:03d}.jsonl').open("x", encoding="utf-8", buffering=1) as journal:
                def notify(item):
                    journal.write(json.dumps({"method": item.method, "payload": item.payload}, ensure_ascii=False) + "\n")
                outcome = session.run(RECOVERY if resuming else prompt, on_notification=notify)
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
        qa = checked_file(workspace / "qa" / f"{label}.json", workspace)
        people = checked_file(workspace / "characters.json", workspace)
        if not isinstance(read(qa), dict) or not isinstance(read(people), dict):
            raise WorkError("EPISODE_QA", "缺少本集人物与待核对项")
    except Exception:
        state["status"] = "needs-inspection"
        save(stamp, state)
        raise
    state.update(status="candidate-ready", delivery={**delivery, **media, "qaSHA256": digest(qa),
                                                    "charactersSHA256": digest(people)})
    save(stamp, state)


def child_action(config, directory, action):
    """Entrypoint for subprocess work under the parent's lease."""
    data = read(directory / "series.json")
    if action == "review":
        save(directory / "review-result.json", review_candidate(config, directory, data["work"], data["review"]))
    else:
        run_episode(config, directory, read(directory / "source.json"), int(action))
