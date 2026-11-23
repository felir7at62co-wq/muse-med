"""转写工作台: the data-station plumbing that transcription Bots in cloud Muse call as tools.

Bots decide everything about the work: which drama, which Bot, how to transcribe, when it is done. The desk only does
what a Bot cannot: it holds the station claim and its lease heartbeat, gets the complete series onto the server (a
checksum-verified local download, or the worker's downloader under the worker account), places it in a cloud Muse
workspace as `原片/NNNN.mp4` and points the assigned Bot's working folder there, reports the mechanical check of each
episode as advice, and on request publishes the combined screenplay to the station and deletes the videos, or hands
the drama back as 待处理.

It serves one JSON request per line on a Unix socket (`socketPath`, group `socketGroup`); `desk_mcp.py` exposes the
operations to cloud Muse as MCP tools. State lives in `<stateRoot>/<series>/desk.json` beside the runner's
`state.json`, so a restarted desk claims its dramas again under the same worker and resumes their heartbeats.
"""
from __future__ import annotations

import argparse
import grp
import json
import os
from pathlib import Path
import signal
import socketserver
import stat
import sys
import threading
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from agent_runner import MuseCloud, Production, check_episode  # noqa: E402
from common import WorkError, digest, read, save, series_id  # noqa: E402
from station import ACTIVE, Lease, Station, StationError  # noqa: E402

OPERATIONS = ("reserve", "claim", "status", "publish", "release")
#: Sent to a transcription Bot whose turn an interruption ended while its drama is unfinished.
RESUME_BOT = ("刚才你这一轮被中断了（云端服务重启或模型调用出错），不是你做错了。先看工作区和 drama_status，"
              "从缺的地方接着做这部剧；做完一批照常入库。用户不在线，不要等回复。")
INTERRUPTED = ("aborted", "error", "unfinished")
#: DS Bot capabilities a Bot needs to work a drama from the desk: these tools and the transcription skill.
BOT_CAPABILITIES = ("transcription-desk", "drama-transcribing")
USAGE_FIELDS = ("input", "cacheRead", "cacheWrite", "output", "calls")


def usage_delta(now, then):
    return {field: (now or {}).get(field, 0) - (then or {}).get(field, 0) for field in USAGE_FIELDS}


def context_tokens(lines):
    """The working context size of the session's latest model request, or 0 when none is logged."""
    for line in reversed(lines):
        if '"workingContextTokens"' not in line:
            continue
        try:
            value = (json.loads(line).get("data") or {}).get("workingContextTokens")
        except ValueError:
            continue
        if isinstance(value, int):
            return value
    return 0


def compactions(lines):
    """Times (epoch ms) of the finished context compactions in a session log."""
    found = []
    for line in lines:
        if '"compaction/end"' not in line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "compaction/end":
            found.append(event.get("time"))
    return found
HOLDING = ("preparing", "ready")
MAX_REQUEST = 16 * 1024
#: Episodes listed one by one in a status reply; the rest are counted.
STATUS_ROWS = 20


def work_key(value):
    if not isinstance(value, str):
        raise WorkError("INVALID_WORK", "作品编号形如 hongguo:7550544718799588376")
    return series_id(value.strip().removeprefix("hongguo:"))


class Desk:
    def __init__(self, cfg, station, muse, run=None):
        self.cfg, self.station, self.muse = cfg, station, muse
        self.production = Production(cfg, station, muse, **({"run": run} if run else {}))
        self.root = Path(cfg["stateRoot"])
        self.worker = cfg.get("deskWorkerId", cfg["workerId"])
        self.leases, self.threads = {}, {}
        self.lock = threading.RLock()

    # --- state ---

    def path(self, key):
        return self.root / key / "desk.json"

    def load(self, key):
        path = self.path(key)
        return read(path) if path.is_file() else None

    def save(self, key, desk):
        (self.root / key).mkdir(mode=0o700, parents=True, exist_ok=True)
        save(self.path(key), desk)

    def dramas(self):
        rows = []
        for path in sorted(self.root.glob("*/desk.json")):
            try:
                rows.append(read(path))
            except (OSError, ValueError, WorkError):
                continue
        return rows

    def log(self, **fields):
        print(json.dumps({"at": time.strftime("%Y-%m-%d %H:%M:%S"), **fields}, ensure_ascii=False), flush=True)

    # --- bots ---

    def bot_usage(self, bot_id):
        """The Bot's model usage over the last 30 days (DS Bot's usage summary), or None when it cannot be read."""
        try:
            return (self.muse.bot("usage-summary", {"botId": bot_id, "timeZone": "Asia/Shanghai"}) or {}).get("month")
        except WorkError:
            return None

    def bots(self):
        value = self.muse.bot("state", {})
        return {bot["name"]: bot for bot in value.get("bots", []) if isinstance(bot, dict) and bot.get("name")}

    # --- operations ---

    def reserve(self, args):
        """The 储备库 queue in station order, what is being worked on, and this desk's dramas."""
        limit = args.get("limit", 15)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise WorkError("INVALID_LIMIT", "limit 取 1–100")
        listing = self.station.candidates()
        queued = [{"workId": job.get("workId"), "rush": job.get("rushAt") is not None, "attempts": job.get("attempts"),
                   "requestedBy": job.get("requestedBy"), "lastError": (job.get("lastError") or {}).get("reason"),
                   "progress": job.get("progress")} for job in listing.get("queued", [])[:limit]]
        active = [{"workId": job.get("workId"), "state": job.get("state"), "workerId": job.get("workerId"),
                   "progress": (job.get("progress") or {}).get("message")} for job in listing.get("active", [])]
        mine = [{"workId": "hongguo:" + row["seriesId"], "title": row.get("title"), "bot": row.get("bot"), "state": row.get("state"),
                 "workspace": row.get("workspace")} for row in self.dramas()]
        return {"queued": queued, "queuedTotal": (listing.get("counts") or {}).get("queued"), "active": active, "desk": mine,
                "note": "queued 按数据站排队顺序；剧名、热度用 data_station_search 按编号查。"}

    def claim(self, args):
        key, name = work_key(args.get("work_id")), args.get("bot")
        if not isinstance(name, str) or not name.strip():
            raise WorkError("INVALID_BOT", "写明交给哪个转写 Bot，例如 转写1")
        with self.lock:
            desk = self.load(key)
            if desk and desk.get("state") in HOLDING:
                if desk.get("bot") != name:
                    raise WorkError("ALREADY_ASSIGNED", f"这部剧已经交给 {desk.get('bot')}")
                return self.summary(desk)
            if desk and desk.get("state") == "published":
                raise WorkError("ALREADY_PUBLISHED", "这部剧已经上架")
            bot = self.bots().get(name)
            if bot is None:
                raise WorkError("UNKNOWN_BOT", f"没有叫 {name} 的 Bot，先建好再派")
            for other in self.dramas():
                if other.get("bot") == name and other.get("state") in HOLDING:
                    raise WorkError("BOT_BUSY", f"{name} 手上还有《{other.get('title')}》，做完上架或退回后再派新剧")
            for capability in BOT_CAPABILITIES:
                if capability not in (bot.get("capabilities") or []):
                    self.muse.bot("bot-capability", {"botId": bot["id"], "name": capability, "attached": True})
            claim = self.station.claim(self.worker, key)
            job = claim.get("job")
            if (not isinstance(job, dict) or job.get("workId") != "hongguo:" + key or job.get("state") not in ACTIVE or
                    job.get("workerId") != self.worker or not isinstance(claim.get("lease"), str) or len(claim["lease"]) < 16):
                raise WorkError("NOT_CLAIMED", f"数据站没有把这部剧交给工作台（状态 {(job or {}).get('state')}）")
            work = claim.get("work") or {}
            desk = {"seriesId": key, "title": work.get("title") or key, "episodes": work.get("episodes"), "bot": name,
                    "botId": bot["id"], "state": "preparing", "claimedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "work": work, "review": claim.get("review") or {}, "model": bot.get("model"), "usageAtClaim": self.bot_usage(bot["id"])}
            self.save(key, desk)
            self.hold(key, claim["lease"])
            self.log(event="claimed", series=key, title=desk["title"], bot=name)
            self.start_preparing(key)
            return self.summary(desk)

    def hold(self, key, lease_value):
        lease = Lease(self.station, key, lease_value, self.worker, self.cfg["heartbeatSeconds"])
        lease.__enter__()
        self.leases[key] = lease

    def start_preparing(self, key):
        thread = threading.Thread(target=self.prepare, args=(key,), name=f"prepare-{key}", daemon=True)
        self.threads[key] = thread
        thread.start()

    def prepare(self, key):
        """Selection review when the station asks for it, the complete series, its workspace, the Bot's folder."""
        desk = self.load(key)
        lease = self.leases.get(key)
        if lease is None:
            return
        try:
            state = self.production.load_state(key, {"work": desk["work"]})
            state.pop("outcome", None)
            state.pop("reason", None)
            review = desk.get("review") or {}
            if review.get("required") and not state.get("reviewed"):
                lease.update(state="downloading", message="复核剧目是否符合选材方向")
                result = self.production.child(key, "review", desk["work"], review, self.cfg.get("reviewTimeoutSeconds", 1800))
                if result["decision"] == "reject":
                    self.station.reject(key, lease.value, result["reason"])
                    return self.finish(key, "rejected", reason=result["reason"])
                if result["decision"] != "accept":
                    raise WorkError("SELECTION_REVIEW", "选材资料不足：" + str(result.get("reason")))
                state["reviewed"] = True
                self.production.save_state(key, state)
            lease.update(state="downloading", message=f"准备原片，交给 {desk['bot']}")
            media = self.production.media(key, desk["work"], review, state)
            workspace = self.production.place(key, desk["title"], media, state)
            if (self.load(key) or {}).get("state") != "preparing":
                return  # handed back while the series was being prepared; the Bot keeps its folder
            self.muse.bot("update-bot", {"id": desk["botId"], "workDir": str(workspace)})
            lease.update(state="transcribing", episode=0, totalEpisodes=len(media), message=f"{desk['bot']} 转写中")
            with self.lock:
                desk = self.load(key)
                if desk.get("state") != "preparing":
                    return
                desk.update(state="ready", workspace=str(workspace), episodes=len(media), readyAt=time.strftime("%Y-%m-%d %H:%M:%S"))
                desk.pop("error", None)
                self.save(key, desk)
            self.log(event="ready", series=key, workspace=str(workspace), bot=desk["bot"])
        except Exception as error:  # noqa: BLE001 - any failure is recorded on the drama for the Bots to see
            with self.lock:
                desk = self.load(key)
                desk["error"] = {"code": getattr(error, "code", None) or type(error).__name__, "message": str(error)[:400],
                                 "at": time.strftime("%Y-%m-%d %H:%M:%S")}
                self.save(key, desk)
            self.log(event="prepare-failed", series=key, code=desk["error"]["code"], message=desk["error"]["message"])

    def summary(self, desk):
        row = {"workId": "hongguo:" + desk["seriesId"], "title": desk.get("title"), "bot": desk.get("bot"),
               "state": desk.get("state"), "episodes": desk.get("episodes"), "workspace": desk.get("workspace")}
        if desk.get("error"):
            row["error"] = desk["error"]
        if desk.get("state") == "preparing":
            row["note"] = "正在准备原片（新剧下载可能要几小时）；state 变成 ready 后再派单。"
        return row

    def status(self, args):
        key = work_key(args.get("work_id"))
        desk = self.load(key)
        if desk is None:
            raise WorkError("NOT_ON_DESK", "工作台没有这部剧；先用 drama_claim 领取")
        reply = self.summary(desk)
        lease = self.leases.get(key)
        reply["lease"] = "held" if lease and not lease.fault else ("lost" if lease else "none")
        if desk.get("state") != "ready":
            return reply
        workspace, total = Path(desk["workspace"]), desk["episodes"]
        done, open_rows = 0, []
        leading = 0
        for number in range(1, total + 1):
            required, advised, _ = check_episode(workspace, number, self.cfg["minSpeechCoverage"])
            if required:
                open_rows.append({"episode": number, "missing": required})
            else:
                done += 1
                if leading == number - 1:
                    leading = number
            if advised and not required and len(open_rows) < STATUS_ROWS:
                open_rows.append({"episode": number, "advice": advised})
        reply.update(done=done, total=total, open=open_rows[:STATUS_ROWS], openMore=max(0, len(open_rows) - STATUS_ROWS),
                     publishable=done == total, firstDone=min((desk.get("doneAt") or {}).values(), default=None),
                     lastDone=max((desk.get("doneAt") or {}).values(), default=None), nudges=(desk.get("watch") or {}).get("nudges", 0),
                     usage=self.usage(desk, done), quality=quality_by_phase(desk))
        if lease and not lease.fault:
            try:
                lease.update(state="transcribing", episode=leading, totalEpisodes=total, message=f"{desk['bot']} 转写中，已完成 {done}/{total} 集")
            except WorkError:
                reply["lease"] = "lost"
        return reply

    def usage(self, desk, done):
        """Model tokens the Bot used since it took this drama (it holds one drama at a time), in all and per episode
        done, and the speech minutes the drama needs; spend in yuan when `prices` names the Bot's model."""
        if desk.get("usageAtClaim") is None:
            return None
        now = self.bot_usage(desk["botId"])
        if now is None:
            return None
        used = usage_delta(now, desk["usageAtClaim"])
        row = {"tokens": used, "perEpisode": {field: round(value / done) for field, value in used.items()} if done else None}
        state_path = self.root / desk["seriesId"] / "state.json"
        media = (read(state_path) if state_path.is_file() else {}).get("media") or []
        row["speechMinutes"] = round(sum(item.get("durationSeconds") or 0 for item in media) / 60, 1)
        price = (self.cfg.get("prices") or {}).get(desk.get("model") or "")
        if price:
            yuan = sum(used[field] * price.get(field, 0) for field in USAGE_FIELDS if field != "calls") / 1_000_000
            row["yuan"] = round(yuan, 2)
            row["yuanPerEpisode"] = round(yuan / done, 2) if done else None
        return row

    def publish(self, args):
        key = work_key(args.get("work_id"))
        with self.lock:
            desk = self.load(key)
            if desk is None or desk.get("state") != "ready":
                raise WorkError("NOT_READY", "只有工作台上已就绪的剧能上架")
            lease = self.leases.get(key)
            if lease is None:
                raise WorkError("LEASE_UNCONFIRMED", "工作台没有这部剧的租约；稍后再试")
            lease.check()
            workspace, total = Path(desk["workspace"]), desk["episodes"]
            missing = {}
            for number in range(1, total + 1):
                required, _, _ = check_episode(workspace, number, self.cfg["minSpeechCoverage"])
                if required:
                    missing[number] = required
            if missing:
                rows = "；".join(f"第{n}集{'、'.join(issues)}" for n, issues in sorted(missing.items())[:10])
                raise WorkError("INCOMPLETE", f"还有 {len(missing)} 集没达到交付要求：{rows}"[:900])
            lease.update(state="checking", episode=total, totalEpisodes=total, message="核对全集稿件")
            manuscript = self.production.combine(workspace, total, self.root / key)
            result = self.station.publish(key, lease.value, manuscript, {"scriptSHA256": digest(manuscript), "episodes": total})
            if (result.get("job") or {}).get("state") != "published":
                raise WorkError("PUBLISH_UNCONFIRMED", "数据站没有确认上架；用 drama_status 查看后再试")
            self.production.cleanup(key, workspace)
            return self.finish(key, "published")

    def release(self, args):
        key = work_key(args.get("work_id"))
        reason = args.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            raise WorkError("INVALID_REASON", "写明退回原因，用户会在储备看板上看到")
        with self.lock:
            desk = self.load(key)
            if desk is None or desk.get("state") not in HOLDING:
                raise WorkError("NOT_HELD", "工作台没有在做这部剧")
            lease = self.leases.get(key)
            if lease is None:
                raise WorkError("LEASE_UNCONFIRMED", "工作台没有这部剧的租约；稍后再试")
            lease.check()
            self.station.attention(key, lease.value, "BOT_RELEASED", reason.strip()[:400])
            save(self.root / key / "station-outcome.json", {"workId": key, "state": "needs-attention"})
            return self.finish(key, "released", reason=reason.strip()[:400])

    def finish(self, key, outcome, reason=None):
        lease = self.leases.pop(key, None)
        if lease is not None:
            lease.__exit__(None, None, None)
        with self.lock:
            desk = self.load(key)
            desk.update(state=outcome, finishedAt=time.strftime("%Y-%m-%d %H:%M:%S"))
            if reason:
                desk["reason"] = reason
            self.save(key, desk)
        self.log(event=outcome, series=key, reason=reason)
        return self.summary(desk)

    def resume(self):
        """After a restart, claim every held drama again (the station returns the same lease) and go on preparing."""
        for desk in self.dramas():
            if desk.get("state") not in HOLDING:
                continue
            key = desk["seriesId"]
            try:
                claim = self.station.claim(self.worker, key)
                if (claim.get("job") or {}).get("workerId") != self.worker or not isinstance(claim.get("lease"), str):
                    raise WorkError("NOT_CLAIMED", "数据站没有确认工作台仍持有这部剧")
                self.hold(key, claim["lease"])
                if desk.get("state") == "preparing":
                    self.start_preparing(key)
                self.log(event="resumed", series=key, state=desk.get("state"))
            except (WorkError, StationError, OSError) as error:
                desk["error"] = {"code": getattr(error, "code", None) or type(error).__name__, "message": str(error)[:400]}
                self.save(key, desk)
                self.log(event="resume-failed", series=key, message=str(error)[:300])

    # --- watch ---

    def watch_once(self):
        """One pass over the dramas Bots are working on: record when each episode first passes the check, and nudge
        a Bot whose last turn an interruption ended (after two idle passes, with a doubling wait between nudges)."""
        try:
            bots = {bot["id"]: bot for bot in self.muse.bot("state", {}).get("bots", [])}
            running = {item.get("sessionId") for item in self.muse.sessions() if item.get("running")}
        except WorkError as error:
            self.log(event="watch-skipped", code=error.code)
            return
        for desk in self.dramas():
            if desk.get("state") != "ready":
                continue
            key, now = desk["seriesId"], time.time()
            workspace, total = Path(desk["workspace"]), desk["episodes"]
            bot = bots.get(desk.get("botId")) or {}
            session = bot.get("sessionId")
            parts = desk.setdefault("parts", [])
            if session and (not parts or parts[-1]["session"] != session):
                parts.append({"session": session, "at": time.strftime("%Y-%m-%d %H:%M:%S"), "compactions": []})
            if session:
                parts[-1]["compactions"] = compactions(self.muse.log_lines(session))
            phase = {"part": len(parts), "compactions": len(parts[-1]["compactions"]) if parts else 0}
            done_at = desk.setdefault("doneAt", {})
            measured = desk.setdefault("measures", {})
            done = 0
            for number in range(1, total + 1):
                required, advised, measures = check_episode(workspace, number, self.cfg["minSpeechCoverage"])
                if not required:
                    done += 1
                    if str(number) not in done_at:
                        done_at[str(number)] = time.strftime("%Y-%m-%d %H:%M:%S")
                        measured[str(number)] = {**measures, "qa": not any(item.startswith("缺 qa/") for item in advised), **phase}
            watch = desk.setdefault("watch", {"idle": 0, "nudges": 0, "lastNudge": 0})
            if done == total or not session or session in running:
                watch["idle"] = 0
            else:
                lines = self.muse.log_lines(session)
                kind, detail = self.muse.last_turn(session)
                watch["idle"] = watch["idle"] + 1 if kind in INTERRUPTED else 0
                wait = min(self.cfg.get("watchSeconds", 300) * 2 ** watch["nudges"], self.cfg.get("resumeBackoffMaxSeconds", 1800))
                if watch["idle"] >= 2 and now - watch["lastNudge"] >= wait:
                    try:
                        tokens = context_tokens(lines)
                        if tokens >= self.cfg.get("partTokenLimit", 300_000):
                            # A context this large is what the model route rejects; go on in a fresh part,
                            # which carries DS Bot's handoff note, rather than resending it.
                            self.muse.bot("bot-new-part", {"botId": desk["botId"]})
                            watch["freshParts"] = watch.get("freshParts", 0) + 1
                            self.log(event="bot-fresh-part", series=key, bot=desk.get("bot"), contextTokens=tokens)
                        self.muse.bot("send", {"sessionId": desk["botId"], "text": RESUME_BOT})
                        watch.update(idle=0, nudges=watch["nudges"] + 1, lastNudge=now, lastTurn=kind, detail=(detail or "")[:160])
                        self.log(event="bot-nudged", series=key, bot=desk.get("bot"), lastTurn=kind, detail=(detail or "")[:120])
                    except WorkError as error:
                        self.log(event="bot-nudge-failed", series=key, code=error.code)
            with self.lock:
                current = self.load(key)
                if current and current.get("state") == "ready":
                    current.update(doneAt=done_at, measures=measured, parts=parts, watch=watch, done=done)
                    self.save(key, current)

    def watch(self, stop):
        while not stop.wait(self.cfg.get("watchSeconds", 300)):
            try:
                self.watch_once()
            except Exception as error:  # noqa: BLE001 - the watch must keep running; the failure is logged
                self.log(event="watch-failed", message=f"{type(error).__name__}: {error}"[:300])

    def execute(self, request):
        operation, args = request.get("operation"), request.get("args") or {}
        if operation not in OPERATIONS or not isinstance(args, dict):
            raise WorkError("INVALID_OPERATION", "支持 reserve、claim、status、publish、release")
        return getattr(self, operation)(args)

    def close(self):
        for key in list(self.leases):
            self.leases.pop(key).__exit__(None, None, None)


def quality_by_phase(desk):
    """Episodes grouped by the Bot's part and the compactions before them, with their mean speech coverage and the
    share with a 待核 file: whether quality holds after the Bot's context moved on."""
    groups = {}
    for number, row in (desk.get("measures") or {}).items():
        key = (row.get("part", 0), row.get("compactions", 0))
        groups.setdefault(key, []).append((int(number), row))
    phases = []
    for (part, count), rows in sorted(groups.items()):
        coverage = [row["speechCoverage"] for _, row in rows if row.get("speechCoverage") is not None]
        phases.append({"part": part, "compactionsBefore": count, "episodes": sorted(n for n, _ in rows),
                       "meanCoverage": round(sum(coverage) / len(coverage), 3) if coverage else None,
                       "qaShare": round(sum(1 for _, row in rows if row.get("qa")) / len(rows), 2)})
    return phases


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            raw = self.rfile.readline(MAX_REQUEST + 1)
            if len(raw) > MAX_REQUEST:
                raise WorkError("INVALID_REQUEST", "请求太长")
            request = json.loads(raw)
            if not isinstance(request, dict):
                raise WorkError("INVALID_REQUEST", "请求格式不对")
            reply = {"ok": True, "result": self.server.desk.execute(request)}
        except WorkError as error:
            reply = {"ok": False, "code": error.code, "message": str(error)}
        except StationError as error:
            reply = {"ok": False, "code": "STATION_UNCONFIRMED", "message": f"数据站没有确认这次操作（{error}）；用 drama_status 查看后再决定"}
        except (ValueError, OSError) as error:
            reply = {"ok": False, "code": "DESK_FAILED", "message": f"工作台出错：{type(error).__name__}"}
        try:
            self.wfile.write((json.dumps(reply, ensure_ascii=False) + "\n").encode("utf-8"))
        except OSError:
            pass


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def serve(cfg):
    station = Station(cfg["stationBase"], cfg["stationTokenFile"], cfg.get("requestTimeoutSeconds", 30))
    muse = MuseCloud(cfg["museHost"], cfg["musePort"], cfg["museUnit"], cfg.get("museSessionsRoot", "/var/lib/muse-cloud/home/sessions"))
    desk = Desk(cfg, station, muse)
    socket_path = Path(cfg["socketPath"])
    if socket_path.exists():
        if not stat.S_ISSOCK(socket_path.lstat().st_mode):
            raise SystemExit(f"{socket_path} is not a socket")
        socket_path.unlink()
    desk.resume()
    stop = threading.Event()
    threading.Thread(target=desk.watch, args=(stop,), name="watch", daemon=True).start()
    with Server(str(socket_path), Handler) as server:
        server.desk = desk
        os.chown(socket_path, 0, grp.getgrnam(cfg["socketGroup"]).gr_gid)
        socket_path.chmod(0o660)
        signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown).start())
        desk.log(event="started", worker=desk.worker, socket=str(socket_path))
        try:
            server.serve_forever(poll_interval=1)
        finally:
            stop.set()
            desk.close()
            socket_path.unlink(missing_ok=True)
            desk.log(event="stopped")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    args = parser.parse_args()
    serve(json.loads(args.config.read_text(encoding="utf-8")))


if __name__ == "__main__":
    main()
