"""Connect the data station's queue to the qualified native Muse workflow."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sys
from threading import Event
import traceback
from uuid import uuid4

from common import WorkError, canonical_json, command, digest, freeze, read, save, series_id, sync_directory, under
from native import accepted, acquire_media, child_action, episode_workspace, sdk, scope_patch, title_key
from station import ACTIVE, TERMINAL, Lease, Station, StationError, station_url
from verification import DeliveryRejected

STOP = Event()
SCRIPT = Path(__file__).resolve()


class Interrupted(BaseException):
    """A requested stop. The original task and its evidence stay on disk."""


def load_config(path):
    """Resolve the worker's private configuration before taking a station lease."""
    cfg = read(path)
    for name in ("stateRoot", "dsh", "sourceRoot", "sdkHome", "sdkPatch", "downloadHome", "mediaRuntime",
                 "skillFiles", "node", "ffmpeg", "ffprobe", "stationTokenFile"):
        value = Path(cfg[name])
        if not value.is_absolute() or value.resolve() != value:
            raise WorkError("INVALID_CONFIG", f"{name} 需要明确的绝对路径")
        if name != "stateRoot" and not value.exists():
            raise WorkError("INVALID_CONFIG", f"{name} 路径不存在")
    if len({cfg["stateRoot"], cfg["sdkHome"], cfg["downloadHome"]}) != 3:
        raise WorkError("INVALID_CONFIG", "转写、下载和任务状态需要独立目录")
    if not re.fullmatch(r"muse-hit-[a-z0-9-]{3,60}", cfg["workerId"]):
        raise WorkError("INVALID_CONFIG", "工作实例编号格式不正确")
    for name, minimum, maximum in (
        ("requestTimeoutSeconds", 1, 30), ("heartbeatSeconds", 1, 120), ("pollSeconds", 1, 3600),
        ("downloadTimeoutSeconds", 30, 86400), ("reviewTimeoutSeconds", 30, 900),
        ("episodeTimeoutSeconds", 30, 86400), ("downloadCooldownSeconds", 0, 7200),
        ("downloadAttempts", 1, 10), ("episodeAttempts", 1, 3), ("diskReserveGiB", 1, 10000),
        ("maxEpisodesPerSeries", 1, 1000),
    ):
        if type(cfg[name]) is not int or not minimum <= cfg[name] <= maximum:
            raise WorkError("INVALID_CONFIG", f"{name} 超出配置范围")
    for key in ("provider", "model"):
        if not isinstance(cfg[key], str) or not cfg[key].strip():
            raise WorkError("INVALID_CONFIG", f"缺少 {key}")
    if type(cfg["publishChecked"]) is not bool or cfg["quality"] not in ("720p", "1080p", "auto"):
        raise WorkError("INVALID_CONFIG", "发布与下载画质配置不正确")
    station_url(cfg["stationBase"])
    exclusions(cfg)
    for key in cfg.get("onlySeries", []):
        series_id(key)
    return cfg


def exclusions(cfg):
    """Exclude existing manual queues by canonical series identity."""
    skipped = {series_id(key) for key in cfg.get("excludedSeries", [])}
    for path in cfg.get("excludeCatalogs", []):
        spec = read(Path(path))
        skipped.update(series_id(row["id"]) for row in spec["series"])
    return skipped


def check_stop():
    if STOP.is_set():
        raise Interrupted()


def emit(message):
    """Keep secrets and work contents out of service logs."""
    print(json.dumps(message, ensure_ascii=False), flush=True)


def choose_candidate(snapshot, root, cfg):
    """Choose the first queue entry with an unambiguous local owner."""
    skipped = exclusions(cfg)
    allowed = {series_id(key) for key in cfg.get("onlySeries", [])}
    for job in snapshot["queued"]:
        if job["state"] != "queued" or job.get("attempts") != 0:
            continue
        work_id = job["workId"]
        if not isinstance(work_id, str) or not work_id.startswith("hongguo:"):
            continue
        key = series_id(work_id.removeprefix("hongguo:"))
        if key not in skipped and (not allowed or key in allowed) and not (root / key).exists():
            return key
    return None


def ensure_space(root, cfg):
    """Before requesting work, keep the deployment's disk reserve available."""
    if shutil.disk_usage(root).free < cfg["diskReserveGiB"] * 2**30:
        raise WorkError("DISK_RESERVE", "服务器达到设置的磁盘保留空间")


def merge_checked(directory, source):
    """Collect every current episode draft in order and freeze the full-script manifest."""
    files, receipts = [], []
    for row in source["media"]:
        record = accepted(directory, row)
        if not record:
            raise WorkError("MISSING_EPISODE", "剧本校验尚未覆盖全集")
        number = row["index"]
        root = episode_workspace(directory, number)
        text = under(root, root / "scripts" / f"{number:04d}.md").read_text(encoding="utf-8").strip()
        files.append(text)
        receipts.append({"episode": number, "videoSHA256": row["sha256"],
                         "scriptSHA256": record["markdownSHA256"], "wordSHA256": record["word"]["sha256"]})
    if [row["episode"] for row in receipts] != list(range(1, source["episodes"] + 1)):
        raise WorkError("MISSING_EPISODE", "交付中的剧集编号不连续")
    manuscript = directory / "screenplay.md"
    freeze(manuscript, "\n\n".join(files) + "\n")
    proof = {"seriesId": source["seriesId"], "episodes": len(receipts), "scriptSHA256": digest(manuscript),
             "receipt": receipts}
    freeze(directory / "delivery.json", canonical_json(proof))
    return manuscript, proof


class Worker:
    """Own one work directory and one station lease at a time."""

    def __init__(self, cfg, path, station, runner=command):
        self.cfg, self.config_path, self.station, self.run_command = cfg, path, station, runner
        self.root = Path(cfg["stateRoot"])
        self.active = self.root / "active.json"
        self.owner = {"station": cfg["stationBase"], "workerId": cfg["workerId"],
                      **{key: cfg[key] for key in ("sdkHome", "downloadHome", "sourceRoot") if key in cfg}}

    def guard(self, lease):
        check_stop()
        lease.check()
        ensure_space(self.root, self.cfg)

    def start_child(self, directory, action, deadline, lease):
        tag = str(action) + "-" + uuid4().hex[:10]
        out = directory / "logs" / f"{tag}.json"
        rc = self.run_command([sys.executable, "-B", str(SCRIPT), str(self.config_path), "--child",
                               directory.name, str(action)], directory, os.environ.copy(), out,
                              out.with_suffix(".stderr"), deadline, lambda: self.guard(lease))
        try:
            result = read(out)
        except (WorkError, ValueError) as error:
            raise WorkError("MUSE_CHILD", "Muse 子进程未返回可核对的完成记录") from error
        if rc != 0 or result.get("ok") is not True:
            raise WorkError(result["code"], result["message"])

    def retire(self, directory, key, state):
        """Record the station outcome before releasing the local active slot."""
        if directory.is_dir():
            save(directory / "station-outcome.json", {"workId": key, "state": state})
        self.active.unlink()
        sync_directory(self.root)
        emit({"workId": key, "state": state})

    def bound_claim(self, snapshot):
        """Reconcile a possibly accepted claim using its original work and worker IDs."""
        if self.active.exists():
            active = read(self.active)
            if active["owner"] != self.owner:
                raise WorkError("WORKER_CHANGED", "任务记录属于另一个执行实例")
            key = series_id(active["workId"])
            if key in exclusions(self.cfg):
                raise WorkError("WORK_ALREADY_SCHEDULED", "这部剧已在其他队列工作")
            directory = self.root / key
            try:
                existing = self.station.job(key)
            except StationError as error:
                if error.status == 404 and not directory.exists():
                    self.retire(directory, key, "withdrawn")
                    return None
                raise
            if existing.get("workId") != "hongguo:" + key:
                raise WorkError("CLAIM_MISMATCH", "数据站返回了其他作品")
            if existing["state"] in TERMINAL:
                self.retire(directory, key, existing["state"])
                return None
            if existing["state"] in ACTIVE and existing.get("workerId") != self.cfg["workerId"]:
                self.retire(directory, key, "other-worker")
                return None
        else:
            key = choose_candidate(snapshot, self.root, self.cfg)
            if key is None:
                return None
            save(self.active, {"owner": self.owner, "workId": key})
        claim = self.station.claim(self.cfg["workerId"], key)
        job = claim.get("job")
        if (not isinstance(job, dict) or job.get("workId") != "hongguo:" + key or job.get("sourceId") != key or
                job.get("state") not in ACTIVE or job.get("workerId") != self.cfg["workerId"] or
                not isinstance(claim.get("lease"), str) or len(claim["lease"]) < 16):
            raise WorkError("CLAIM_MISMATCH", "领取回执没有确认同一作品和执行实例")
        return key, claim

    def process(self, directory, key, claim, lease):
        """Review, download, transcribe, verify, then record the complete delivery."""
        work, review = claim.get("work"), claim.get("review")
        if (not isinstance(work, dict) or not isinstance(review, dict) or type(review.get("required")) is not bool or
                review["required"] and not isinstance(review.get("standard"), str)):
            raise WorkError("CLAIM_CONTEXT", "数据站未返回剧目资料和选材复核要求")
        title_key(work.get("title"))
        directory.mkdir(exist_ok=True)
        for name in ("logs", "records"):
            (directory / name).mkdir(exist_ok=True)
        proof = directory / "series.json"
        if proof.exists():
            original = read(proof)
            if original["seriesId"] != key or title_key(original["work"]["title"]) != title_key(work["title"]):
                raise WorkError("SOURCE_CHANGED", "先前任务与本次领取的剧目不一致")
            work, review = original["work"], original["review"]
        else:
            save(proof, {"seriesId": key, "work": work, "review": review})
        if review["required"]:
            lease.update(state="downloading", message="复核剧目是否符合选材方向")
            self.start_child(directory, "review", self.cfg["reviewTimeoutSeconds"], lease)
            result = read(directory / "review-result.json")
            if result["decision"] == "reject":
                return self.station.reject(key, lease.value, result["reason"])["state"]
            if result["decision"] != "accept":
                raise WorkError("SELECTION_REVIEW", "选材资料不足：" + result["reason"])

        lease.update(state="downloading", message="核对红果目录和全集文件")
        source = acquire_media(self.cfg, directory, key, work, lambda: self.guard(lease))
        for row in source["media"]:
            n = row["index"]
            if accepted(directory, row):
                continue
            lease.update(state="transcribing", episode=n - 1, totalEpisodes=source["episodes"], message=f"正在转写第 {n} 集")
            for _ in range(self.cfg["episodeAttempts"]):
                try:
                    self.start_child(directory, n, self.cfg["episodeTimeoutSeconds"], lease)
                except WorkError as error:
                    record = directory / "records" / f"{n:04d}.json"
                    if (error.code in ("LEASE_UNCONFIRMED", "DISK_RESERVE", "SESSION_UNCONFIRMED",
                                       "BINDING_CHANGED", "SOURCE_CHANGED") or not record.is_file() or
                            read(record)["attempt"] >= self.cfg["episodeAttempts"]):
                        raise
                else:
                    if accepted(directory, row):
                        break
                    raise WorkError("EPISODE_QA", "Muse 未生成当前集的完整验收记录")
            if not accepted(directory, row):
                raise WorkError("EPISODE_QA", f"第 {n} 集未通过校验")
            lease.update(state="transcribing", episode=n, totalEpisodes=source["episodes"], message=f"第 {n} 集已通过来源与格式检查")
        lease.update(state="checking", episode=source["episodes"], totalEpisodes=source["episodes"], message="核对全集稿件")
        combined, verification = merge_checked(directory, source)
        self.guard(lease)
        if self.cfg["publishChecked"]:
            result = self.station.publish(key, lease.value, combined, verification)
            if result["job"]["state"] != "published":
                raise StationError(None)
            return "published"
        return self.station.attention(key, lease.value, "DRAFT_READY", "全集草稿已通过程序检查，等待内容验收")["state"]

    def once(self):
        """Process at most one candidate, keeping the prior task if any outcome is unknown."""
        check_stop()
        ensure_space(self.root, self.cfg)
        receipt = self.bound_claim(self.station.candidates() if not self.active.exists() else None)
        if receipt is None:
            return False
        key, claim = receipt
        directory = self.root / key
        if directory.is_symlink():
            raise WorkError("WORKSPACE_CHANGED", "转写目录已变成链接")
        with Lease(self.station, key, claim["lease"], self.cfg["workerId"], self.cfg["heartbeatSeconds"]) as lease:
            try:
                result = self.process(directory, key, claim, lease)
            except StationError:
                raise
            except WorkError as error:
                lease.check()
                result = self.station.attention(key, lease.value, error.code, str(error))["state"]
            if result not in TERMINAL:
                raise StationError(None)
        self.retire(directory, key, result)
        return True


def child(cfg, root, key, action):
    """Record completion or a visible native check failure without exposing raw input."""
    directory = root / series_id(key)
    try:
        child_action(cfg, directory, action)
    except WorkError as error:
        emit({"ok": False, "code": error.code, "message": str(error)})
        return 1
    except DeliveryRejected as error:
        emit({"ok": False, "code": "DELIVERY_CHECK", "message": "原片依据、格式或最新稿件未通过程序检查"})
        print(str(error), file=sys.stderr)
        return 1
    except Exception as error:
        emit({"ok": False, "code": "MUSE_RUN", "message": f"Muse 未完成本次操作（{type(error).__name__}）"})
        traceback.print_exc()
        return 1
    emit({"ok": True})
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--inspect", action="store_true")
    mode.add_argument("--check-runtime", action="store_true")
    mode.add_argument("--once", action="store_true")
    mode.add_argument("--run", action="store_true")
    mode.add_argument("--child", nargs=2, help=argparse.SUPPRESS)
    args = parser.parse_args()
    cfg = load_config(args.config.resolve())
    root = Path(cfg["stateRoot"])
    if args.child:
        return child(cfg, root, *args.child)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    station = Station(cfg["stationBase"], cfg["stationTokenFile"], cfg["requestTimeoutSeconds"])
    if args.inspect:
        snapshot = station.candidates()
        emit({"counts": snapshot["counts"], "nextSeries": choose_candidate(snapshot, root, cfg)})
        return 0
    with (root / ".worker.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        worker = Worker(cfg, args.config.resolve(), station)
        freeze(root / "owner.json", canonical_json(worker.owner))
        if args.check_runtime:
            ws = root / "runtime-check"
            ws.mkdir(exist_ok=True)
            scope = ws / "scope.json"
            scope_patch(cfg, ws, None, [], scope, review=True)
            with sdk(cfg, ws, scope):
                pass
            from native import hongguo
            if not hongguo(cfg, ws, ["jobs"], check_stop)["ok"]:
                raise WorkError("HONGGUO_RUNTIME", "红果配置无法启动")
            emit({"nativeProfileStarted": True, "downloadProfileStarted": True, "modelCalls": 0})
            return 0
        while True:
            try:
                result = worker.once()
            except WorkError as error:
                emit({"state": "waiting", "code": error.code, "message": str(error)})
                if args.once:
                    return 1
                result = False
            if args.once:
                return 0
            if not result:
                STOP.wait(cfg["pollSeconds"])
            check_stop()


if __name__ == "__main__":
    os.umask(0o077)
    signal.signal(signal.SIGTERM, lambda *_: STOP.set())
    try:
        raise SystemExit(main())
    except Interrupted:
        raise SystemExit(0)
    except (WorkError, KeyError, ValueError, OSError) as error:
        emit({"state": "stopped", "message": str(error) if isinstance(error, WorkError) else type(error).__name__})
        raise SystemExit(1)
