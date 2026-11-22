"""Factory job that turns the data station's hit queue into Workshop screenplays.

Each slot runs the shared hit-transcription worker for one series at a time: audience review, the complete
Hongguo download, then checked episode transcription by cloud Muse. A delivered series becomes a factory script
product, so later pipeline steps (spawn, distribute) consume it like any other script.
"""
import asyncio
from contextlib import suppress
from datetime import datetime
import fcntl
import json
import logging
import os
from pathlib import Path
import re
import shutil
import signal

from sqlalchemy import select

logger = logging.getLogger(__name__)

CONFIG_ENV = "MUSE_WORKSHOP_HIT_CONFIG"
QUALITIES = ("720p", "1080p")
REQUIRED_PATHS = ("workerApp", "python", "pythonPath", "dsh", "node", "sourceRoot", "mediaRuntime", "skillFiles",
                  "ffmpeg", "ffprobe", "stationTokenFile", "templateSdkHome", "templateDownloadHome", "slotRoot")
SERIES = re.compile(r"[1-9][0-9]{14,24}")
POLL_SECONDS = 300
CHECK_SECONDS = 10
PROGRESS_SECONDS = 30
STOP_GRACE_SECONDS = 90
_running: set[int] = set()
RESUMABLE = ("stopped", "failed", "completed")


class Stopped(Exception):
    """The user asked the job to stop. Claimed series keep their state for the next run."""


def deployment():
    """Read the operator's private worker template; parameters chosen per run live in the job config."""
    location = os.environ.get(CONFIG_ENV)
    if not location:
        raise ValueError("工坊尚未启用视频转剧本，请管理员配置转写执行器")
    value = json.loads(Path(location).read_text(encoding="utf-8"))
    for key in REQUIRED_PATHS:
        item = Path(value.get(key) or "")
        if not item.is_absolute() or not item.exists():
            raise ValueError(f"视频转剧本配置缺少有效的 {key}")
    if not (Path(value["workerApp"]) / "worker.py").is_file():
        raise ValueError("视频转剧本配置的 workerApp 缺少 worker.py")
    if not (Path(value["templateSdkHome"]) / "account/session.json").is_file():
        raise ValueError("工坊专用 Muse 账号尚未配置")
    if not (Path(value["templateDownloadHome"]) / "profiles/hongguo").is_dir():
        raise ValueError("红果下载配置尚未安装")
    for key in ("stationBase", "provider", "model"):
        if not isinstance(value.get(key), str) or not value[key].strip():
            raise ValueError(f"视频转剧本配置缺少 {key}")
    if type(value.get("maxSlots")) is not int or not 1 <= value["maxSlots"] <= 16:
        raise ValueError("视频转剧本配置的 maxSlots 必须是 1 到 16")
    return value


def options(config, dep):
    """Normalize the parameters shared by the pipeline editor, the job API and Muse."""
    count = config.get("count", 0)
    concurrency = config.get("concurrency", 1)
    if type(count) is not int or count < 0:
        raise ValueError("部数必须是不小于 0 的整数，0 表示持续运行")
    if type(concurrency) is not int or not 1 <= concurrency <= dep["maxSlots"]:
        raise ValueError(f"同时转写部数必须是 1 到 {dep['maxSlots']}")
    quality = config.get("quality") or "720p"
    if quality not in QUALITIES:
        raise ValueError("画质只能是 720p 或 1080p")
    only = config.get("only_series") or []
    if isinstance(only, str):
        only = [item for item in re.split(r"[\s,，、]+", only) if item]
    if not isinstance(only, list) or not all(isinstance(item, str) and SERIES.fullmatch(item) for item in only):
        raise ValueError("指定剧目需要红果作品编号")
    return {"count": count, "concurrency": concurrency, "quality": quality,
            "publish": bool(config.get("publish", False)), "only_series": list(dict.fromkeys(only))}


def checked_config(config):
    """Validate a job or step config for the API; unrelated keys such as task_name are kept."""
    from fastapi import HTTPException
    try:
        return {**(config or {}), **options(config or {}, deployment())}
    except (OSError, ValueError, KeyError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def checked_steps(steps):
    """Validate the 视频转剧本 steps of a pipeline preset before it is saved."""
    return [{**step, "config": checked_config(step.get("config"))}
            if isinstance(step, dict) and step.get("type") == "video_transcribe" else step
            for step in steps or []]


def slot_paths(dep, index):
    root = Path(dep["slotRoot"]) / f"slot-{index}"
    return {"root": root, "state": root / "state", "sdk": root / "sdk-home", "download": root / "download-home",
            "config": root / "worker.json", "log": root / "worker.log", "lock": root / "slot.lock"}


def prepare_slot(dep, index, opts):
    """Give a slot its own persistent worker identity, SDK home and download home."""
    paths = slot_paths(dep, index)
    for key in ("root", "state"):
        paths[key].mkdir(mode=0o700, parents=True, exist_ok=True)
    template = Path(dep["templateSdkHome"])
    account = paths["sdk"] / "account"
    account.mkdir(mode=0o700, parents=True, exist_ok=True)
    shutil.copy2(template / "account/session.json", account / "session.json")
    if (template / "presets").is_dir():
        shutil.copytree(template / "presets", paths["sdk"] / "presets", dirs_exist_ok=True)
    # The profile names the template's account, preset and session directories; each slot uses its own copies.
    patch = (template / "transcription.patch.json").read_text(encoding="utf-8")
    (paths["sdk"] / "transcription.patch.json").write_text(patch.replace(str(template), str(paths["sdk"])), encoding="utf-8")
    if not (paths["download"] / "profiles/hongguo").is_dir():
        shutil.copytree(Path(dep["templateDownloadHome"]), paths["download"], symlinks=True, dirs_exist_ok=True)
    quality = opts["quality"]
    if (paths["state"] / "active.json").exists() and paths["config"].exists():
        # A claimed series keeps the download request it started with.
        quality = json.loads(paths["config"].read_text(encoding="utf-8")).get("quality", quality)
    worker = {
        "stationBase": dep["stationBase"], "stationTokenFile": dep["stationTokenFile"],
        "workerId": f"muse-hit-workshop-{index}", "stateRoot": str(paths["state"]),
        "sourceRoot": dep["sourceRoot"], "dsh": dep["dsh"], "node": dep["node"],
        "ffmpeg": dep["ffmpeg"], "ffprobe": dep["ffprobe"],
        "sdkHome": str(paths["sdk"]), "sdkPatch": str(paths["sdk"] / "transcription.patch.json"),
        "downloadHome": str(paths["download"]), "mediaRuntime": dep["mediaRuntime"], "skillFiles": dep["skillFiles"],
        "provider": dep["provider"], "model": dep["model"], "quality": quality, "publishChecked": opts["publish"],
        "requestTimeoutSeconds": 10, "heartbeatSeconds": 45, "pollSeconds": 60,
        "downloadTimeoutSeconds": 7200, "downloadCooldownSeconds": dep.get("downloadCooldownSeconds", 900),
        "downloadAttempts": dep.get("downloadAttempts", 10), "reviewTimeoutSeconds": 300,
        "episodeTimeoutSeconds": 7200, "episodeAttempts": dep.get("episodeAttempts", 3), "diskReserveGiB": dep.get("diskReserveGiB", 24),
        "maxEpisodesPerSeries": 1000, "excludeCatalogs": [], "onlySeries": opts["only_series"],
    }
    paths["config"].write_text(json.dumps(worker, ensure_ascii=False, indent=2), encoding="utf-8")
    return paths


def outcome(lines):
    """Read the worker's machine lines: a retired series, a waiting error, or nothing to claim."""
    for line in reversed(lines):
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and isinstance(value.get("workId"), str) and isinstance(value.get("state"), str):
            return {"kind": "retired", "series": value["workId"], "state": value["state"]}
        if isinstance(value, dict) and value.get("state") in ("waiting", "stopped"):
            return {"kind": "waiting", "code": value.get("code"), "message": value.get("message") or ""}
    return {"kind": "idle"}


def chapters(directory):
    """Collect the checked episode drafts in delivery order as Workshop chapters."""
    proof = json.loads((directory / "delivery.json").read_text(encoding="utf-8"))
    rows = []
    for receipt in proof["receipt"]:
        number = receipt["episode"]
        text = (directory / "episodes" / f"{number:04d}" / "scripts" / f"{number:04d}.md").read_text(encoding="utf-8").strip()
        rows.append({"order": number, "title": f"第{number}集", "content": text, "word_count": len(text)})
    return rows


def series_title(directory):
    with suppress(OSError, ValueError, KeyError):
        return json.loads((directory / "series.json").read_text(encoding="utf-8"))["work"]["title"]
    return directory.name


def review_reason(directory):
    with suppress(OSError, ValueError, KeyError):
        return json.loads((directory / "review-result.json").read_text(encoding="utf-8"))["reason"]
    return ""


async def station_get(dep, route):
    import httpx
    token = Path(dep["stationTokenFile"]).read_text(encoding="utf-8").strip()
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(dep["stationBase"].rstrip("/") + route,
                                    headers={"X-Muse-Data-Service-Token": token})
        response.raise_for_status()
        return response.json()


async def status():
    """Readiness and queue counts for the editor."""
    try:
        dep = deployment()
    except (OSError, ValueError, KeyError) as error:
        return {"ready": False, "error": str(error)}
    try:
        counts = (await station_get(dep, "/candidates?limit=1"))["counts"]
    except Exception as error:  # noqa: BLE001 - the editor shows the station as unreachable
        return {"ready": False, "error": f"数据站暂时无法访问（{type(error).__name__}）", "maxSlots": dep["maxSlots"]}
    return {"ready": True, "queue": counts, "maxSlots": dep["maxSlots"]}


def acquire(path):
    handle = path.open("a+b")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return None
    return handle


class Run:
    """One factory job: free slots each loop over single-series worker passes."""

    def __init__(self, job_id, user_id, dep, opts):
        self.job_id, self.user_id, self.dep, self.opts = job_id, user_id, dep, opts
        self.slots = {}
        self.delivered, self.attention, self.rejected = [], [], []
        self.stop_requested = False

    async def stop_flag(self):
        from ..db.session import session_scope
        from .models import FactoryJob
        async with session_scope() as session:
            job = await session.get(FactoryJob, self.job_id)
            requested = job is None or bool((job.result or {}).get("manual_stop_requested"))
        self.stop_requested = self.stop_requested or requested
        return self.stop_requested

    def capacity_left(self, index):
        if self.opts["count"] == 0:
            return True
        busy = sum(1 for other, slot in self.slots.items() if other != index and slot.get("process"))
        return len(self.delivered) + busy < self.opts["count"]

    async def pass_once(self, index, paths):
        """Run one worker pass on this slot, stopping its process group when the user stops the job."""
        env = {**os.environ, "HOME": str(paths["root"]), "PYTHONPATH": self.dep["pythonPath"], "PYTHONUNBUFFERED": "1"}
        with paths["log"].open("ab") as log:
            process = await asyncio.create_subprocess_exec(
                self.dep["python"], "-B", str(Path(self.dep["workerApp"]) / "worker.py"), str(paths["config"]), "--once",
                cwd=self.dep["workerApp"], env=env, stdout=asyncio.subprocess.PIPE, stderr=log, start_new_session=True)
            self.slots[index]["process"] = process
            reader = asyncio.create_task(process.stdout.read())
            try:
                while True:
                    try:
                        await asyncio.wait_for(asyncio.shield(process.wait()), CHECK_SECONDS)
                        break
                    except asyncio.TimeoutError:
                        if await self.stop_flag():
                            await self.terminate(process)
                            break
            except asyncio.CancelledError:
                await self.terminate(process)
                raise
            finally:
                self.slots[index]["process"] = None
            output = (await reader).decode("utf-8", "replace")
        log_lines = [line for line in output.splitlines() if line.strip()]
        with paths["log"].open("a", encoding="utf-8") as log:
            log.write("\n".join(log_lines) + "\n")
        return outcome(log_lines)

    async def terminate(self, process):
        if process.returncode is not None:
            return
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(process.wait(), STOP_GRACE_SECONDS)
        except asyncio.TimeoutError:
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            await process.wait()

    async def record(self, paths, result):
        key = result["series"]
        directory = paths["state"] / key
        title = series_title(directory)
        state = result["state"]
        if state == "rejected":
            self.rejected.append({"series_id": key, "title": title, "reason": review_reason(directory)[:200]})
            return
        if state in ("published", "needs-attention") and (directory / "delivery.json").is_file():
            await self.deliver(directory, key, title, state)
            return
        if state not in ("needs-attention", "failed"):
            logger.info("[video_transcribe %s] %s released as %s", self.job_id, key, state)
            return
        reason = ""
        with suppress(Exception):
            job = await station_get(self.dep, f"/jobs/{key}")
            reason = ((job.get("lastError") or {}).get("reason") or (job.get("lastError") or {}).get("message") or "")
        self.attention.append({"series_id": key, "title": title, "state": state, "reason": str(reason)[:200]})

    async def deliver(self, directory, key, title, state):
        """Store the checked screenplay as a factory script once, then release the downloaded videos."""
        from ..db.session import session_scope
        from .models import FactoryProduct
        rows = chapters(directory)
        words = sum(row["word_count"] for row in rows)
        async with session_scope() as session:
            existing = (await session.execute(select(FactoryProduct).where(
                FactoryProduct.job_id == self.job_id, FactoryProduct.product_type == "script"))).scalars().all()
            if not any((p.meta_data or {}).get("series_id") == key for p in existing):
                session.add(FactoryProduct(
                    job_id=self.job_id, user_id=self.user_id, product_type="script", title=title,
                    content=json.dumps({"chapters": rows}, ensure_ascii=False), status="completed",
                    meta_data={"source": "hongguo", "series_id": key, "episodes": len(rows),
                               "completed_episodes": len(rows), "words": words,
                               "source_label": f"红果《{title}》", "station_state": state,
                               "published": state == "published", "work_dir": str(directory)}))
                await session.commit()
        self.delivered.append({"series_id": key, "title": title, "episodes": len(rows), "published": state == "published"})
        shutil.rmtree(directory / "download" / "downloads", ignore_errors=True)

    async def slot_loop(self, index, handle):
        """Own one locked slot until the count is met, the queue is empty, or the user stops the job."""
        try:
            paths = prepare_slot(self.dep, index, self.opts)
            self.slots[index] = {"process": None, "paths": paths}
            while not await self.stop_flag():
                holding = (paths["state"] / "active.json").exists()
                if not holding and not self.capacity_left(index):
                    break
                result = await self.pass_once(index, paths)
                if self.stop_requested:
                    break
                if result["kind"] == "retired":
                    await self.record(paths, result)
                    continue
                if result["kind"] == "idle" and not (paths["state"] / "active.json").exists():
                    if self.opts["only_series"]:
                        break
                    queued = None
                    with suppress(Exception):
                        queued = (await station_get(self.dep, "/candidates?limit=1"))["counts"].get("queued")
                    if self.opts["count"] and queued == 0:
                        break
                if result["kind"] == "waiting":
                    logger.warning("[video_transcribe %s] slot %s waiting: %s %s", self.job_id, index,
                                   result.get("code"), result.get("message"))
                await self.sleep(POLL_SECONDS)
        finally:
            self.slots.pop(index, None)
            handle.close()

    async def sleep(self, seconds):
        waited = 0
        while waited < seconds and not await self.stop_flag():
            await asyncio.sleep(CHECK_SECONDS)
            waited += CHECK_SECONDS

    async def live(self):
        """Per-slot station progress for the job detail page."""
        rows = []
        for index, slot in sorted(self.slots.items()):
            row = {"slot": index, "state": "idle"}
            active = slot["paths"]["state"] / "active.json"
            with suppress(OSError, ValueError, KeyError):
                key = json.loads(active.read_text(encoding="utf-8"))["workId"]
                row.update(series_id=key, title=series_title(slot["paths"]["state"] / key), state="claimed")
                with suppress(Exception):
                    job = await station_get(self.dep, f"/jobs/{key}")
                    progress = job.get("progress") or {}
                    row.update(state=job.get("state"), episode=progress.get("episode"),
                               total=progress.get("totalEpisodes"), message=progress.get("message"))
            rows.append(row)
        return rows

    async def publish_progress(self, final=None):
        from ..db.session import session_scope
        from .models import FactoryJob
        slots = await self.live()
        queue = None
        with suppress(Exception):
            queue = (await station_get(self.dep, "/candidates?limit=1"))["counts"]
        working = sum(1 for row in slots if row.get("series_id"))
        parts = [f"{working} 部转写中", f"已出稿 {len(self.delivered)} 部"]
        if self.rejected:
            parts.append(f"选材未通过 {len(self.rejected)} 部")
        if self.attention:
            parts.append(f"待处理 {len(self.attention)} 部")
        if queue is not None:
            parts.append(f"队列 {queue.get('queued', 0)} 部")
        percent = round(len(self.delivered) / self.opts["count"] * 100) if self.opts["count"] else None
        async with session_scope() as session:
            # Lock the row so a stop request committed meanwhile is read and kept, not overwritten.
            job = await session.get(FactoryJob, self.job_id, with_for_update=True)
            if job is None:
                return
            job.progress = {"percent": 100 if final == "completed" else percent, "status_message": " · ".join(parts),
                            "slots": slots, "queue": queue}
            result = dict(job.result or {})
            result.update(delivered=self.delivered, attention=self.attention, rejected=self.rejected)
            job.result = result
            if final:
                job.status = final
                job.finished_at = datetime.utcnow()
                if final == "stopped":
                    result.pop("manual_stop_requested", None)
                    job.result = result
            await session.commit()

    async def reporter(self):
        while True:
            await asyncio.sleep(PROGRESS_SECONDS)
            with suppress(Exception):
                await self.publish_progress()

    async def restore(self):
        """Keep the results of earlier runs of the same job. A stop requested before a restart still applies."""
        from ..db.session import session_scope
        from .models import FactoryJob
        async with session_scope() as session:
            job = await session.get(FactoryJob, self.job_id, with_for_update=True)
            result = dict((job.result or {}) if job else {})
            if job:
                job.result = result
                job.status = "running"
                job.finished_at = None
                job.error_message = None
                await session.commit()
        self.delivered = list(result.get("delivered") or [])
        self.attention = list(result.get("attention") or [])
        self.rejected = list(result.get("rejected") or [])


def reopen(job):
    """Mark a job to run again in place: clear its stop request and previous end, keep its results and claimed series."""
    result = dict(job.result or {})
    result.pop("manual_stop_requested", None)
    job.result = result
    job.status = "pending"
    job.finished_at = None
    job.error_message = None


async def resume_job(job, session, background_tasks):
    """POST /factory/jobs/{id}/resume for the user's own 视频转剧本 job: continue it with its saved parameters."""
    from fastapi import HTTPException
    if job.status not in RESUMABLE:
        stopping = bool((job.result or {}).get("manual_stop_requested"))
        raise HTTPException(status_code=409, detail="任务正在停止，停下后再续跑" if stopping else "任务正在运行，无需续跑")
    config = checked_config(job.config)
    reopen(job)
    await session.commit()
    background_tasks.add_task(run_video_transcribe_job, job.id, config, job.user_id)
    return {"job_id": job.id, "resumed": True, "message": "已续跑视频转剧本任务"}


async def run_video_transcribe_job(job_id: int, config: dict, user_id: int):
    """Factory entry point. A second call for a job already running in this process returns at once."""
    if job_id in _running:
        return
    _running.add(job_id)
    run = None
    try:
        dep = deployment()
        opts = options(config, dep)
        run = Run(job_id, user_id, dep, opts)
        await run.restore()
        reporter = asyncio.create_task(run.reporter())
        try:
            await run_slots(run, dep, opts)
        finally:
            reporter.cancel()
        await run.publish_progress("stopped" if run.stop_requested else "completed")
    except Exception as error:  # noqa: BLE001 - surfaced on the job
        logger.exception("[video_transcribe %s] failed", job_id)
        from ..db.session import session_scope
        from .models import FactoryJob
        async with session_scope() as session:
            job = await session.get(FactoryJob, job_id)
            if job:
                job.status = "failed"
                job.error_message = str(error)[:500]
                job.finished_at = datetime.utcnow()
                await session.commit()
    finally:
        _running.discard(job_id)


async def run_slots(run, dep, opts):
    """Claim up to the requested number of free slots; slots held by other jobs are skipped."""
    tasks = []
    Path(dep["slotRoot"]).mkdir(mode=0o700, parents=True, exist_ok=True)
    for index in range(1, dep["maxSlots"] + 1):
        if len(tasks) >= opts["concurrency"]:
            break
        handle = acquire(Path(dep["slotRoot"]) / f"slot-{index}.lock")
        if handle is not None:
            tasks.append(asyncio.create_task(run.slot_loop(index, handle)))
    if not tasks:
        raise RuntimeError("转写执行位都被其他任务占用，请稍后再试或降低同时转写部数")
    await asyncio.gather(*tasks)
