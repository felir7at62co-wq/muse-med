"""Cloud 24-hour video-to-screenplay production with Muse agents.

The runner owns only the mechanical parts. It works on up to `dramasAtOnce` series at a time, one slot each with its
own station worker id. Each slot claims one Hongguo series from the data station and keeps the lease alive, gets the complete series (a verified local download, or the worker's own downloader under the worker account),
places it in a cloud Muse workspace and publishes the finished screenplay. Muse agents in cloud Muse do all of the
transcription: one session per batch of episodes, with their own skills and sub-agents, in one shared workspace per
series. After each batch a mechanical check decides whether every episode is done (script, complete frame review,
speech result, Word). Missing parts go back to the agent by name; a series still incomplete after the configured
follow-ups is marked 待处理 with the reason and keeps everything for a later requeue.
"""
from __future__ import annotations

import argparse
import difflib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback
import unicodedata
import uuid
from threading import Event
from tempfile import TemporaryFile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import WorkError, digest, download_retry_generation, read, save, series_id  # noqa: E402
from station import ACTIVE, Lease, Station, StationError  # noqa: E402
from worker import choose_candidate, exclusions, resumable  # noqa: E402


class Interrupted(Exception):
    """The runner was asked to stop; the claimed series stays active for the next start."""


def run_preparation(argv, *, cwd, timeout, check):
    """Close the worker's owner pipe on cancellation and wait for its cleanup receipt."""
    check()
    with TemporaryFile(mode="w+", encoding="utf-8") as stdout, TemporaryFile(mode="w+", encoding="utf-8") as stderr:
        with subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr) as child:
            deadline = time.monotonic() + timeout
            stopped = None
            while child.poll() is None:
                if stopped is None:
                    try:
                        check()
                        if time.monotonic() >= deadline:
                            raise WorkError("PROCESS_TIMEOUT", "原片准备超时，正在等待执行器停止")
                    except (WorkError, Interrupted) as error:
                        stopped = error
                        child.stdin.close()
                try:
                    child.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    continue
            stdout.seek(0)
            stderr.seek(0)
            result = subprocess.CompletedProcess(argv, child.returncode, stdout.read(), stderr.read())
    lines = [line for line in result.stdout.splitlines() if line.strip().startswith("{")]
    try:
        receipt = json.loads(lines[-1]) if lines else None
    except ValueError:
        receipt = None
    if (not isinstance(receipt, dict) or type(receipt.get("ok")) is not bool or
            result.returncode != (0 if receipt["ok"] else 1) or
            receipt.get("code") == "PREPARATION_STOP_UNCONFIRMED"):
        raise WorkError("PREPARATION_STOP_UNCONFIRMED", "执行器退出未确认清理，已保留任务")
    if stopped is not None:
        raise stopped
    check()
    return result


# ---------- cloud Muse ----------

class MuseCloud:
    """Cloud Muse's own web API as its owner, from the server.

    The launch token cloud Muse prints to its unit's journal is exchanged for the session cookie; neither is logged.
    """

    def __init__(self, host, port, unit, sessions_root="/var/lib/muse-cloud/home/sessions"):
        self.host, self.port, self.unit, self.jar = host, port, unit, None
        self.sessions_root = Path(sessions_root)

    def _token(self):
        log = subprocess.run(["journalctl", "-u", self.unit, "--no-pager", "-o", "cat", "--since", "-30 days"],
                             capture_output=True, text=True, timeout=120).stdout
        found = re.findall(rf"http://{re.escape(self.host)}:{self.port}/\?token=([A-Za-z0-9_\-]+)", log)
        if not found:
            raise WorkError("MUSE_UNAVAILABLE", "云端 Muse 的登录令牌不可用")
        return found[-1]

    def _cookie(self):
        conn = http.client.HTTPConnection(self.host, self.port, timeout=30)
        conn.request("GET", "/?token=" + self._token(), headers={"Host": f"{self.host}:{self.port}"})
        response = conn.getresponse()
        response.read()
        jar = [value.split(";", 1)[0] for name, value in response.getheaders() if name.lower() == "set-cookie"]
        if not jar:
            raise WorkError("MUSE_UNAVAILABLE", f"云端 Muse 没有接受登录令牌（HTTP {response.status}）")
        return "; ".join(jar)

    def call(self, method, args):
        for attempt in (1, 2):
            if self.jar is None:
                self.jar = self._cookie()
            body = json.dumps({"type": "client-request", "rpcId": "runner-" + uuid.uuid4().hex[:12],
                               "method": method, "payload": {"args": args}})
            try:
                conn = http.client.HTTPConnection(self.host, self.port, timeout=120)
                conn.request("POST", "/api/" + method, body=body, headers={
                    "Host": f"{self.host}:{self.port}", "Content-Type": "application/json", "Cookie": self.jar})
                response = conn.getresponse()
                text = response.read().decode("utf-8", "replace")
            except OSError as error:
                raise WorkError("MUSE_UNAVAILABLE", f"云端 Muse 无法连接（{type(error).__name__}）") from None
            if response.status in (401, 403) and attempt == 1:
                self.jar = None
                continue
            try:
                result = json.loads(text)["result"]
            except (ValueError, KeyError, TypeError):
                raise WorkError("MUSE_UNAVAILABLE", f"云端 Muse 返回 HTTP {response.status}") from None
            if not result.get("ok"):
                raise WorkError("MUSE_REFUSED", f"{method}: {(result.get('error') or {}).get('code')}")
            return result.get("value")
        raise WorkError("MUSE_UNAVAILABLE", "云端 Muse 的登录已失效")

    def bot(self, endpoint, payload):
        """One request to DS Bot's own endpoint (`POST /api/bot`), as the owner; returns its value or raises."""
        for attempt in (1, 2):
            if self.jar is None:
                self.jar = self._cookie()
            try:
                conn = http.client.HTTPConnection(self.host, self.port, timeout=120)
                conn.request("POST", "/api/bot", body=json.dumps({"endpoint": endpoint, "payload": payload}),
                             headers={"Host": f"{self.host}:{self.port}", "Content-Type": "application/json", "Cookie": self.jar})
                response = conn.getresponse()
                text = response.read().decode("utf-8", "replace")
            except OSError as error:
                raise WorkError("MUSE_UNAVAILABLE", f"云端 Muse 无法连接（{type(error).__name__}）") from None
            if response.status in (401, 403) and attempt == 1:
                self.jar = None
                continue
            try:
                result = json.loads(text)
            except ValueError:
                raise WorkError("MUSE_UNAVAILABLE", f"云端 Muse 返回 HTTP {response.status}") from None
            if not isinstance(result, dict) or result.get("ok") is not True:
                raise WorkError("MUSE_REFUSED", f"{endpoint}: {(result or {}).get('error') if isinstance(result, dict) else result}"[:300])
            return result.get("value")
        raise WorkError("MUSE_UNAVAILABLE", "云端 Muse 的登录已失效")

    def create(self, cwd, preset):
        return self.call("session/create", {"request": {"cwd": cwd, "agentPreset": preset}})["sessionId"]

    def prompt(self, session, text):
        self.call("session/prompt", {"request": {"requestId": "runner-" + uuid.uuid4().hex, "sessionId": session,
                                                 "mode": "queue", "content": [{"type": "text", "text": text}],
                                                 "clientTimeZone": "Asia/Shanghai"}})

    def cancel(self, session):
        self.call("session/cancel", {"request": {"sessionId": session}})

    def sessions(self):
        return self.call("session/list", {"_request": {}})["items"]

    def started_at(self):
        """When the cloud Muse unit last became active (epoch seconds), or 0.0 when systemd does not say."""
        value = subprocess.run(["systemctl", "show", self.unit, "-p", "ActiveEnterTimestamp", "--timestamp=unix", "--value"],
                               capture_output=True, text=True, timeout=30).stdout.strip()
        return unix_timestamp(value)

    def log_lines(self, session):
        logs = sorted(self.sessions_root.glob(f"*/{session}/session.v4.jsonl.zstd"))
        if not logs:
            return []
        # A log still being written ends in an open frame; what precedes it decodes.
        return subprocess.run(["zstdcat", str(logs[-1])], capture_output=True, timeout=120).stdout.decode("utf-8", "replace").splitlines()

    def last_turn(self, session):
        """How the session's last turn ended, read from its own log: see `turn_outcome`."""
        return turn_outcome(self.log_lines(session))

    def tool_results(self, session, name):
        """The JSON results of every successful call of tool `name` in the session, oldest first."""
        return tool_results(self.log_lines(session), name)


def unix_timestamp(value):
    """systemd's `--timestamp=unix` form (`@1795417523`) as epoch seconds; 0.0 for anything else."""
    match = re.fullmatch(r"@(\d+)", value.strip())
    return float(match.group(1)) if match else 0.0


def tool_results(lines, name):
    """Parsed JSON text of each `tool/result` answering a `tool/call` of `name` in a session log."""
    calls, results = set(), []
    for line in lines:
        if '"tool/' not in line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        data = event.get("data") or {}
        if event.get("type") == "tool/call" and data.get("name") == name:
            calls.add(data.get("callId"))
        elif event.get("type") == "tool/result" and (data.get("message") or {}).get("toolCallId") in calls:
            for part in (data.get("message") or {}).get("content") or []:
                try:
                    value = json.loads(part.get("text", "")) if isinstance(part, dict) else None
                except ValueError:
                    continue
                if isinstance(value, dict):
                    results.append(value)
    return results


def turn_outcome(lines):
    """(kind, detail) of the last turn in a session log: `completed`, `aborted` (detail: why, e.g. `disposed`),
    `error` (detail: the error code and message), `unfinished` when it started and never ended, or (None, None)
    when the session has no turn."""
    kind, detail = None, None
    for line in lines:
        if '"turn/' not in line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "turn/start":
            kind, detail = "unfinished", None
        elif event.get("type") == "turn/end":
            reason = (event.get("data") or {}).get("reason") or {}
            kind = reason.get("kind") if isinstance(reason, dict) else None
            if kind == "aborted":
                detail = ((reason.get("reason") or {}).get("kind")) if isinstance(reason.get("reason"), dict) else None
            elif kind == "error":
                error = reason.get("error") or {}
                detail = f"{error.get('code') or ''} {error.get('message') or ''}".strip()
            else:
                detail = None
    return kind, detail


# ---------- what the agent is asked ----------

#: Sub-agents an agent may start at once: more parallel starts fail with "Skill preparation did not complete".
MAX_SUBAGENTS = 3


def batch_prompt(title, total, first, last):
    """The request for one batch: the task, where the material is, and where each delivery goes."""
    lines = [f"把《{title}》第 {first}–{last} 集转成剧本（全剧 {total} 集）。"
             f"原片在当前目录的「原片」文件夹里（{first:04d}.mp4–{last:04d}.mp4），红果短剧。"]
    if first > 1:
        lines.append("前面的集已经转好：剧本在 episodes/，需要核对的地方在 qa/，人物表在 outline/人物表.json。"
                     "接着它们写，人名、称呼与人物表保持一致，新出现的人物补进人物表。")
    lines.append("要求：按原片忠实转写，每集写成分场剧本。交付放在下面的位置（N 用阿拉伯数字，不补零）："
                 "每集剧本 episodes/第N集.md；每集需要核对的地方 qa/第N集-待核.md；每集 Word final/第N集.docx。")
    lines.append(WORKING_RULES)
    lines.append("这批做完再告诉我结果。我不在，不要等我回复，遇到问题自己判断处理。")
    return "\n".join(lines)


#: Said with every batch request and every resume: limits of the services the agent shares.
WORKING_RULES = ("已有的语音识别直接用：transcript/raw/ 里已有结果的集不要再识别；transcript/jobs/ 里已有回执的集，"
                 "用 inspect 查这个回执取结果，不要重新提交（重新提交会再计费）。语音识别查询慢或超时，过几分钟再查同一个回执。"
                 f"子代理同时最多开 {MAX_SUBAGENTS} 个，这几个结束后再开下一批。")


def follow_up_prompt(problems):
    rows = [f"- 第{number}集：{'；'.join(issues)}" for number, issues in sorted(problems.items())]
    return ("这一批还有几集没达到交付要求：\n" + "\n".join(rows) +
            "\n请补齐后再告诉我结果。我不在，不要等我回复，遇到问题自己判断处理。")


def library_prompt(library_title, title, key, last):
    """The request to store episodes 1–`last` as one version of the drama's library entry."""
    files = "、".join(f"episodes/第{n}集.md" for n in range(1, last + 1))
    return (f"把《{title}》第1–{last}集的剧本定稿入库到剧本工坊的定稿库。用户已经同意入库，参数也定好了，不用再问用户：\n"
            "- 用工具 script_finalize（在剧本工坊能力下，没看到就用 tool_search 找）；按要求先加载它需要的技能。\n"
            f"- title：{library_title}\n- files：按集排好的 {last} 个文件：{files}\n- rights：授权改编\n"
            f"- origin：hongguo:{key}\n- origin_title：{title}\n- kind 和 style 用默认值\n"
            "不要改剧本内容，也不要做别的事。完成后告诉我返回的剧本 id、版本号、是否新文本。我不在，不要等我回复。")


def asr_wait_prompt(problems):
    rows = [f"- 第{number}集：{'；'.join(issues)}" for number, issues in sorted(problems.items())]
    return ("这几集的语音识别还没取回结果，是识别服务慢，不是你做错了：\n" + "\n".join(rows) +
            "\n用 inspect 查已有的回执取结果，不要重新提交；取到后补齐这几集，再告诉我结果。我不在，不要等我回复。")


ANSWER = "我不在，按你的判断继续，不用等我回复。"
RESUME = ("刚才这一轮被中断了（云端服务重启或模型调用出错），不是你做错了。沿用已经做好的部分，接着把这一批做完，再告诉我结果。"
          + WORKING_RULES + "我不在，不要等我回复。")
#: Turn ends that an interruption causes, not the agent: the batch is resumed in the same session, uncounted.
INTERRUPTED = ("aborted", "error", "unfinished")
#: Receipt states of a speech task the service has not answered yet.
ASR_PENDING = ("prepared", "submitted", "queued", "processing", "uncertain")


# ---------- the mechanical check ----------

DIGITS = "零一二三四五六七八九"
SCENE = re.compile(r"^\s*#*\s*\d+\s*-\s*\d+\s+\S")
DIALOGUE = re.compile(r"^\s*([^▲#\s][^：:]{0,24}?)(?:（[^）]*）|\([^)]*\))?\s*[：:]\s*(.+)$")
NOT_DIALOGUE = re.compile(r"^(人物|场景|时间|地点|集数|备注|待核|QA)\s*[：:]")


def chinese_number(match):
    n = int(match.group())
    if n < 10:
        return DIGITS[n]
    if n < 100:
        return ("" if n // 10 == 1 else DIGITS[n // 10]) + "十" + (DIGITS[n % 10] if n % 10 else "")
    return "".join(DIGITS[int(c)] for c in str(n))


def comparable(text):
    text = re.sub(r"\d+", chinese_number, unicodedata.normalize("NFKC", text))
    return "".join(c for c in text if unicodedata.category(c)[0] in "LN")


def dialogue(script):
    lines = []
    for line in script.splitlines():
        line = line.strip()
        if not line or line.startswith("▲") or SCENE.match(line) or NOT_DIALOGUE.match(line):
            continue
        found = DIALOGUE.match(line)
        if found:
            lines.append(found.group(2))
    return "".join(lines)


def speech_coverage(segments, script):
    """Share of the speech result's text that the script's dialogue contains, in order."""
    reference, written = comparable("".join(segments)), comparable(dialogue(script))
    if not reference or not written:
        return None
    blocks = difflib.SequenceMatcher(None, reference, written, autojunk=False).get_matching_blocks()
    return sum(block.size for block in blocks) / len(reference)


def frame_review(workspace, number):
    """(recorded, total, complete) for the episode's best frame-review record in the workspace."""
    best = (0, 0, False)
    for path in workspace.glob("**/.muse/video-observations/*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if Path(str(record.get("path", ""))).name != f"{number:04d}.mp4":
            continue
        frames = record.get("frames") if isinstance(record.get("frames"), list) else []
        recorded = sum(1 for frame in frames if isinstance(frame, dict) and "observation" in frame)
        found = (recorded, len(frames), bool(record.get("scan_complete")) and bool(frames) and recorded == len(frames))
        if found[2] or recorded > best[0]:
            best = found
            if found[2]:
                break
    return best


def speech_result(workspace, number):
    for path in sorted(workspace.glob(f"transcript/**/{number:04d}-v*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            segments = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(segments, list) and segments:
            return [str(segment.get("text", "")) for segment in segments if isinstance(segment, dict)]
    return None


def check_episode(workspace, number, min_coverage):
    """(required, advised, measures): what is still missing for one episode, and its measured evidence."""
    required, advised = [], []
    script_path = workspace / "episodes" / f"第{number}集.md"
    script = script_path.read_text(encoding="utf-8", errors="replace") if script_path.is_file() else ""
    if len(script.strip()) < 30:
        required.append(f"缺 episodes/第{number}集.md")
    elif not any(SCENE.match(line) for line in script.splitlines()):
        required.append("剧本里没有场次标题")
    recorded, total, complete = frame_review(workspace, number)
    if not complete:
        required.append(f"逐帧审看没做完（已记录 {recorded}/{total} 帧）" if total else "没有逐帧审看记录")
    segments = speech_result(workspace, number)
    pending = None
    if segments is None:
        pending = pending_speech(workspace, number)
        required.append(f"语音识别还在等服务返回（回执 {pending[0]}，状态 {pending[1]}）" if pending else "没有本集的语音识别结果")
    word = workspace / "final" / f"第{number}集.docx"
    if not word.is_file() or word.read_bytes()[:2] != b"PK":
        required.append(f"缺 final/第{number}集.docx")
    if not (workspace / "qa" / f"第{number}集-待核.md").is_file():
        advised.append(f"缺 qa/第{number}集-待核.md")
    coverage = speech_coverage(segments, script) if segments and script else None
    if coverage is not None and coverage < min_coverage:
        advised.append(f"台词与语音识别差距较大（覆盖 {coverage:.0%}），请对照原片复核漏句")
    return required, advised, {"frames": f"{recorded}/{total}", "speechCoverage": None if coverage is None else round(coverage, 3),
                               "speechPending": pending is not None}


def pending_speech(workspace, number):
    """(receipt path, state) of this episode's newest speech receipt that the service has not answered, or None."""
    receipts = sorted(workspace.glob(f"transcript/jobs/{number:04d}-v*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in receipts[:1]:
        try:
            status = json.loads(path.read_text(encoding="utf-8")).get("status")
        except (OSError, ValueError, AttributeError):
            return None
        if status in ASR_PENDING:
            return str(path.relative_to(workspace)), status
    return None


# ---------- control and status ----------

class Control:
    """What the supervising Bot or an operator asks of the runner, from <workspaceRoot>/.production/control.json.

    `paused` holds every slot at its next batch boundary (the leases stay alive) and stops new claims;
    `dramasAtOnce` is how many series are worked on at once, from 1 up to the runner's `maxDramasAtOnce` (a larger
    number is held at that cap); `onlySeries` limits claims to those series; `skipSeries` never claims them. Series are
    Hongguo ids, with or without the station's `hongguo:` prefix. An unreadable file keeps the last valid request.
    """

    def __init__(self, path, cap=1):
        self.path, self.cap = path, cap
        self.last = {"paused": False, "dramasAtOnce": 1, "onlySeries": [], "skipSeries": []}

    def read(self):
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            value = {}
        except (OSError, ValueError):
            return self.last
        if not isinstance(value, dict):
            return self.last
        try:
            ids = {name: [series_id(item.strip().removeprefix("hongguo:")) for item in value.get(name) or []
                          if isinstance(item, str) and item.strip()] for name in ("onlySeries", "skipSeries")}
        except (WorkError, ValueError, TypeError):
            return self.last
        at_once = value.get("dramasAtOnce", 1)
        if isinstance(at_once, bool) or not isinstance(at_once, int) or at_once < 1:
            return self.last
        self.last = {"paused": value.get("paused") is True, "dramasAtOnce": min(at_once, self.cap), **ids}
        return self.last


def own_requeued(snapshot, root, cfg):
    """A queued series this runner retired earlier (failed or 待处理) whose attempts another worker's expired lease
    used up: its evidence is here, so it is taken back. `choose_candidate` takes only jobs with no attempts."""
    skipped = exclusions(cfg)
    allowed = {series_id(key) for key in cfg.get("onlySeries", [])}
    for job in snapshot["queued"]:
        work_id = job.get("workId")
        if job.get("state") != "queued" or not isinstance(work_id, str) or not work_id.startswith("hongguo:"):
            continue
        key = series_id(work_id.removeprefix("hongguo:"))
        if key not in skipped and (not allowed or key in allowed) and resumable(root / key):
            return key
    return None


# ---------- production ----------

class Production:
    """Claim, prepare, hand to agents batch by batch, check, publish; one series per slot, `dramasAtOnce` slots."""

    def __init__(self, cfg, station, muse, run=run_preparation):
        self.cfg, self.station, self.muse, self.run = cfg, station, muse, run
        self.root = Path(cfg["stateRoot"])
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.stop = Event()
        self.worker_cfg = json.loads(Path(cfg["workerConfig"]).read_text(encoding="utf-8")) if cfg.get("workerConfig") else {}
        self.board = Path(cfg["workspaceRoot"]) / ".production"
        self.board.mkdir(parents=True, exist_ok=True)
        self.own(self.board)
        self.control = Control(self.board / "control.json", cfg.get("maxDramasAtOnce", 1))
        if not self.control.path.exists():
            self.control.path.write_text(json.dumps(self.control.last, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
            self.control.path.chmod(0o644)
            self.own(self.control.path)
        self.local = threading.local()
        self.slots = {}
        self.claiming = threading.Lock()
        self.reporting = threading.Lock()

    # --- slots ---

    def slot(self):
        return getattr(self.local, "slot", 1)

    def worker_id(self):
        return self.cfg["workerId"] if self.slot() == 1 else f"{self.cfg['workerId']}-{self.slot()}"

    @property
    def active(self):
        return self.root / ("active.json" if self.slot() == 1 else f"active-{self.slot()}.json")

    def active_slots(self):
        found = set()
        for path in self.root.glob("active*.json"):
            match = re.fullmatch(r"active(?:-([1-9][0-9]*))?\.json", path.name)
            if match:
                found.add(int(match.group(1) or 1))
        return found

    def own(self, path):
        if self.cfg.get("workspaceOwner"):
            shutil.chown(path, self.cfg["workspaceOwner"], self.cfg["workspaceOwner"])

    def write_status(self, stage=None, **extra):
        """Record this slot's stage and write the runner's state for the supervising Bot: each slot's series and
        batches, the control in effect, and recent outcomes. Without a stage only the file is rewritten."""
        with self.reporting:
            if stage is not None:
                entry = self.slots.setdefault(self.slot(), {})
                entry.pop("error", None)
                entry.update(stage=stage, **extra)
            self.publish_status()

    def summary(self, state):
        return {"seriesId": state["seriesId"], "title": state.get("title"), "retries": state.get("retries", 0),
                "episodes": len(state.get("media") or []) or state.get("episodes"), "workspace": state.get("workspace"),
                "library": state.get("library"),
                "batches": [{"episodes": name, "done": batch.get("done", False), "followUps": batch.get("followUps", 0),
                             "resumes": batch.get("resumes", 0), "asrWaits": batch.get("asrWaits", 0),
                             "session": batch.get("session")} for name, batch in state.get("batches", {}).items()]}

    def publish_status(self):
        recent = []
        for path in sorted(self.root.glob("*/state.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:10]:
            try:
                row = read(path)
            except (OSError, ValueError, WorkError):
                continue
            if row.get("outcome"):
                recent.append({"seriesId": row["seriesId"], "title": row.get("title"), "outcome": row["outcome"],
                               "reason": row.get("reason"), "retries": row.get("retries", 0), "workspace": row.get("workspace")})
        slots = []
        for number, entry in sorted(self.slots.items()):
            row = {"slot": number, "worker": self.cfg["workerId"] if number == 1 else f"{self.cfg['workerId']}-{number}",
                   "stage": entry.get("stage"), "current": self.summary(entry["state"]) if entry.get("state") else None}
            if entry.get("error"):
                row["error"] = entry["error"]
            slots.append(row)
        status = {"updatedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "control": self.control.read(),
                  "maxDramasAtOnce": self.control.cap, "batchSize": self.cfg["batchSize"], "slots": slots, "recent": recent}
        target = self.board / "status.json"
        temporary = self.board / ".status.json.tmp"
        temporary.write_text(json.dumps(status, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        temporary.chmod(0o640)
        self.own(temporary)
        os.replace(temporary, target)

    def log(self, **fields):
        where = {} if self.slot() == 1 else {"slot": self.slot()}
        print(json.dumps({"at": time.strftime("%Y-%m-%d %H:%M:%S"), **where, **fields}, ensure_ascii=False), flush=True)

    def wait(self, seconds):
        if self.stop.wait(seconds):
            raise Interrupted()

    # --- state ---

    def state_path(self, key):
        return self.root / key / "state.json"

    def load_state(self, key, claim):
        path = self.state_path(key)
        if path.is_file():
            state = read(path)
            if state.get("outcome"):
                # Queued again after it stopped: unfinished batches start over in a fresh session; done ones stay.
                state["retries"] = state.get("retries", 0) + 1
                state.pop("outcome")
                state.pop("reason", None)
                state["batches"] = {name: batch for name, batch in state.get("batches", {}).items() if batch.get("done")}
            return state
        work = claim.get("work") or {}
        return {"seriesId": key, "title": work.get("title") or key, "episodes": work.get("episodes"), "batches": {}}

    def save_state(self, key, state):
        (self.root / key).mkdir(mode=0o700, exist_ok=True)
        save(self.state_path(key), state)

    # --- one series ---

    def next_series(self):
        if self.active.is_file():
            return series_id(read(self.active)["workId"])
        control = self.control.read()
        if control["paused"]:
            self.write_status("paused")
            return None
        cfg = dict(self.cfg)
        if control["onlySeries"]:
            cfg["onlySeries"] = control["onlySeries"]
        cfg["excludedSeries"] = list(cfg.get("excludedSeries", [])) + control["skipSeries"]
        snapshot = self.station.candidates()
        key = choose_candidate(snapshot, self.root, cfg) or own_requeued(snapshot, self.root, cfg)
        if key is None:
            self.write_status("idle")
        return key

    def once(self, slot=None):
        """Work on at most one series in this slot (the calling thread's, else `slot`); True when one was claimed."""
        if slot is not None:
            self.local.slot = slot
        with self.claiming:
            key = self.next_series()
            if key is None:
                return False
            claim = self.station.claim(self.worker_id(), key)
            job = claim.get("job")
            if (not isinstance(job, dict) or job.get("workId") != "hongguo:" + key or job.get("state") not in ACTIVE or
                    job.get("workerId") != self.worker_id() or not isinstance(claim.get("lease"), str) or len(claim["lease"]) < 16):
                self.log(event="not-claimed", series=key, state=(job or {}).get("state"))
                self.active.unlink(missing_ok=True)
                return True
            save(self.active, {"workId": key})
        state = self.load_state(key, claim)
        retry_generation = download_retry_generation(job, state.get("retryGeneration"))
        if retry_generation is not None:
            state["retryGeneration"] = retry_generation
        self.save_state(key, state)
        self.write_status("claimed", state=state)
        self.log(event="claimed", series=key, title=state["title"])
        with Lease(self.station, key, claim["lease"], self.worker_id(), self.cfg["heartbeatSeconds"]) as lease:
            try:
                outcome = self.process(key, claim, state, lease)
            except (Interrupted, StationError):
                raise
            except WorkError as error:
                if error.code in ("LEASE_UNCONFIRMED", "MUSE_UNAVAILABLE", "PREPARATION_STOP_UNCONFIRMED"):
                    raise
                lease.check()
                outcome = self.station.attention(key, lease.value, error.code, str(error))["state"]
                state["reason"] = str(error)[:400]
                self.log(event="needs-attention", series=key, code=error.code, reason=str(error)[:300])
        state["outcome"] = outcome
        self.save_state(key, state)
        save(self.root / key / "station-outcome.json", {"workId": key, "state": outcome})
        self.active.unlink(missing_ok=True)
        self.write_status("idle", state=None)
        self.log(event="finished", series=key, outcome=outcome)
        return True

    def process(self, key, claim, state, lease):
        work, review = claim.get("work") or {}, claim.get("review") or {}
        title = state["title"]
        if review.get("required") and not state.get("reviewed"):
            lease.update(state="downloading", message="复核剧目是否符合选材方向")
            result = self.child(key, "review", work, review, self.cfg.get("reviewTimeoutSeconds", 1800),
                                check=lambda: self.check_preparation(lease))
            if result["decision"] == "reject":
                return self.station.reject(key, lease.value, result["reason"])["state"]
            if result["decision"] != "accept":
                raise WorkError("SELECTION_REVIEW", "选材资料不足：" + str(result.get("reason")))
            state["reviewed"] = True
            self.save_state(key, state)
        lease.update(state="downloading", message="核对红果目录和全集文件")
        self.write_status("preparing")
        check = lambda: self.check_preparation(lease)
        media = self.media(key, work, review, state, check=check)
        workspace = self.place(key, title, media, state, check=check)
        total, size = len(media), self.cfg["batchSize"]
        for first in range(1, total + 1, size):
            last = min(first + size - 1, total)
            batch = state["batches"].setdefault(f"{first}-{last}", {"followUps": 0, "done": False})
            if batch["done"]:
                continue
            if not batch.get("session"):
                self.hold_while_paused(lease)
            lease.update(state="transcribing", episode=first - 1, totalEpisodes=total, message=f"第 {first}–{last} 集转写中")
            self.run_batch(key, title, total, first, last, workspace, batch, state, lease)
        lease.update(state="checking", episode=total, totalEpisodes=total, message="核对全集稿件")
        manuscript = self.combine(workspace, total, self.root / key)
        result = self.station.publish(key, lease.value, manuscript, {"scriptSHA256": digest(manuscript), "episodes": total})
        if (result.get("job") or {}).get("state") != "published":
            raise StationError(None)
        self.cleanup(key, workspace)
        return "published"

    # --- media ---

    def cached_media(self, key, expected):
        """A complete, checksum-verified download of this series already on the server, if any."""
        for cache in self.cfg.get("mediaCaches", []):
            source_path = Path(cache) / key / "source.json"
            if not source_path.is_file():
                continue
            try:
                source = read(source_path)
                media = sorted(source["media"], key=lambda row: row["index"])
                if source["seriesId"] != key or [row["index"] for row in media] != list(range(1, len(media) + 1)):
                    continue
                if expected is not None and len(media) != expected:
                    continue
                for row in media:
                    path = Path(row["path"])
                    if not path.is_file() or path.stat().st_size != row["bytes"] or digest(path) != row["sha256"]:
                        raise ValueError(row["index"])
            except (OSError, KeyError, TypeError, ValueError, WorkError):
                continue
            return [{key_: row[key_] for key_ in ("index", "path", "bytes", "sha256", "durationSeconds")} for row in media]
        return None

    def check_preparation(self, lease):
        if self.stop.is_set():
            raise Interrupted()
        lease.check()

    def media(self, key, work, review, state, *, check=lambda: None):
        check()
        if state.get("media"):
            return state["media"]
        media = self.cached_media(key, work.get("episodes"))
        if media is None:
            self.child(key, "download", work, review, self.cfg.get("downloadTimeoutSeconds", 6 * 3600), check=check,
                       retry_generation=state.get("retryGeneration"))
            source = read(Path(self.worker_cfg["stateRoot"]) / key / "source.json")
            media = self.cached_media_from(source)
        check()
        state["media"] = media
        self.save_state(key, state)
        return media

    def cached_media_from(self, source):
        base = Path(self.worker_cfg["stateRoot"]) / source["seriesId"]
        rows = []
        for row in sorted(source["media"], key=lambda r: r["index"]):
            path = Path(row["path"]) if Path(row["path"]).is_absolute() else base / row["path"]
            rows.append({"index": row["index"], "path": str(path), "bytes": row["bytes"], "sha256": row["sha256"],
                         "durationSeconds": row["durationSeconds"]})
        return rows

    def place(self, key, title, media, state, *, check=lambda: None):
        """The series workspace in cloud Muse with its original videos as 原片/NNNN.mp4."""
        check()
        safe = re.sub(r"[\\/:*?\"<>|\s]+", "", title)[:40] or key
        workspace = Path(self.cfg["workspaceRoot"]) / f"{safe}-{key}"
        originals = workspace / "原片"
        originals.mkdir(parents=True, exist_ok=True)
        owner = self.cfg.get("workspaceOwner")
        for row in media:
            check()
            target = originals / f"{row['index']:04d}.mp4"
            if not target.is_file() or target.stat().st_size != row["bytes"]:
                shutil.copyfile(row["path"], target)
            if owner:
                shutil.chown(target, owner, owner)
            target.chmod(0o640)
        if owner:
            for path in (Path(self.cfg["workspaceRoot"]), workspace, originals):
                shutil.chown(path, owner, owner)
        check()
        state["workspace"] = str(workspace)
        self.save_state(key, state)
        return workspace

    def cleanup(self, key, workspace):
        """No videos stay on the server after publication; scripts, records and Word files remain."""
        shutil.rmtree(workspace / "原片", ignore_errors=True)
        if self.worker_cfg.get("stateRoot"):
            shutil.rmtree(Path(self.worker_cfg["stateRoot"]) / key / "download" / "downloads", ignore_errors=True)

    def child(self, key, action, work, review, timeout, *, check=lambda: None, retry_generation=None):
        """Run one worker child action under the worker account and return its result."""
        check()
        directory = Path(self.worker_cfg["stateRoot"]) / key
        directory.mkdir(parents=True, exist_ok=True)
        context = {"seriesId": key, "work": work, "review": review}
        if retry_generation is not None:
            context["retryGeneration"] = retry_generation
        save(directory / "series.json", context)
        user = self.cfg["workerUser"]
        for path in (directory.parent, directory, directory / "series.json"):
            shutil.chown(path, user, user)
        # The worker's selection review imports the Muse Python SDK from the source tree (`workerPythonPath`).
        env = [f"HOME={self.cfg['workerHome']}"] + ([f"PYTHONPATH={self.cfg['workerPythonPath']}"] if self.cfg.get("workerPythonPath") else [])
        result = self.run(["runuser", "-u", user, "--", "env", *env, self.cfg["workerPython"], "-B",
                           str(Path(self.cfg["workerApp"]) / "worker.py"),
                           self.cfg["workerConfig"], "--child", key, action, "--owner-pipe"],
                          cwd=self.cfg["workerApp"], timeout=timeout, check=check)
        lines = [line for line in (result.stdout or "").splitlines() if line.strip().startswith("{")]
        outcome = json.loads(lines[-1]) if lines else {"ok": False, "code": "CHILD_FAILED", "message": (result.stderr or "")[-300:]}
        if not outcome.get("ok"):
            raise WorkError(outcome.get("code", "CHILD_FAILED"), outcome.get("message", f"{action} 未完成"))
        return read(directory / "review-result.json") if action == "review" else outcome

    def ready(self, lease=None):
        """Wait until cloud Muse has been up for `museWarmupSeconds`, so a prompt does not meet unregistered models."""
        warmup = self.cfg.get("museWarmupSeconds", 90)
        while True:
            started = self.muse.started_at()
            left = started + warmup - time.time() if started else 0
            if left <= 0:
                return
            if lease is not None:
                lease.check()
            self.wait(min(left, self.cfg["pollSeconds"]))

    def hold_while_paused(self, lease):
        """At a batch boundary, wait while paused; the lease heartbeat keeps the claim."""
        while self.control.read()["paused"]:
            lease.check()
            self.write_status("paused")
            self.wait(self.cfg["pollSeconds"])

    # --- agents ---

    def run_batch(self, key, title, total, first, last, workspace, batch, state, lease):
        numbers = range(first, last + 1)
        if not batch.get("session"):
            self.ready(lease)
            batch["session"] = self.muse.create(str(workspace), self.cfg["preset"])
            self.save_state(key, state)
            self.muse.prompt(batch["session"], batch_prompt(title, total, first, last))
            batch["promptedAt"] = batch["windowAt"] = time.time()
            self.save_state(key, state)
            self.log(event="batch-started", series=key, episodes=f"{first}-{last}", session=batch["session"])
        while True:
            self.wait_idle(workspace, batch, lease)
            problems, measures = {}, {}
            for number in numbers:
                required, advised, measures[number] = check_episode(workspace, number, self.cfg["minSpeechCoverage"])
                issues = required + (advised if batch["followUps"] == 0 else [])
                if issues:
                    problems[number] = issues
            missing = {n: issues for n, issues in problems.items()
                       if any(not issue.startswith(("缺 qa/", "台词与语音识别")) for issue in issues)}
            if not problems or (not missing and batch["followUps"] > 0):
                batch.update(done=True, measures=measures)
                self.save_state(key, state)
                self.log(event="batch-done", series=key, episodes=f"{first}-{last}", followUps=batch["followUps"],
                         resumes=batch.get("resumes", 0), asrWaits=batch.get("asrWaits", 0))
                self.store_in_library(key, title, workspace, last, state, lease)
                return
            waiting = {n: issues for n, issues in missing.items() if measures[n]["speechPending"]}
            if missing and waiting == missing and time.time() < self.window_end(batch):
                # Only the speech service is late: ask again later, without spending a follow-up.
                self.wait(self.cfg.get("asrRetrySeconds", 300))
                self.ready(lease)
                self.muse.prompt(batch["session"], asr_wait_prompt(waiting))
                batch["promptedAt"] = time.time()
                batch["asrWaits"] = batch.get("asrWaits", 0) + 1
                self.save_state(key, state)
                self.log(event="batch-asr-wait", series=key, episodes=f"{first}-{last}", waiting=sorted(waiting))
                continue
            if batch["followUps"] >= self.cfg["followUps"]:
                summary = "；".join(f"第{n}集{'、'.join(issues)}" for n, issues in sorted(missing.items()))
                interrupted = f"（本批被中断续做 {batch['resumes']} 次）" if batch.get("resumes") else ""
                raise WorkError("AGENT_INCOMPLETE", f"第 {first}–{last} 集仍未完成{interrupted}：{summary}"[:400])
            batch["followUps"] += 1
            self.ready(lease)
            self.muse.prompt(batch["session"], follow_up_prompt(problems))
            batch["promptedAt"] = batch["windowAt"] = time.time()
            self.save_state(key, state)
            self.log(event="batch-follow-up", series=key, episodes=f"{first}-{last}", problems=len(problems))

    def store_in_library(self, key, title, workspace, last, state, lease):
        """Store episodes 1–`last` as a new version of the drama's Workshop library entry, in a short session of its
        own. A failure is logged and recorded, not raised: the next batch stores every episode again."""
        library = self.cfg.get("library") or {}
        if not library.get("enabled"):
            return
        library_title = library.get("title", "{title}【转写稿】").format(title=title)
        session = None
        try:
            self.ready(lease)
            session = self.muse.create(str(workspace), self.cfg["preset"])
            self.muse.prompt(session, library_prompt(library_title, title, key, last))
            deadline, quiet = time.time() + library.get("timeoutSeconds", 1200), 0
            while time.time() < deadline and quiet < 2:
                lease.check()
                self.wait(self.cfg["pollSeconds"])
                quiet = 0 if any(item.get("running") for item in self.muse.sessions() if item.get("sessionId") == session) else quiet + 1
            stored = [row for row in self.muse.tool_results(session, "script_finalize") if row.get("episodes") == last]
        except WorkError as error:
            stored = []
            self.log(event="library-failed", series=key, code=error.code, message=str(error)[:200])
        if stored:
            state["library"] = {"title": library_title, "id": stored[-1].get("id"), "version": stored[-1].get("version"),
                                "episodes": last, "session": session}
            self.log(event="library-stored", series=key, **{k: state["library"][k] for k in ("id", "version", "episodes")})
        else:
            state["libraryFailed"] = {"episodes": last, "session": session, "at": time.strftime("%Y-%m-%d %H:%M:%S")}
            self.log(event="library-not-stored", series=key, episodes=last, session=session)
        self.save_state(key, state)

    def window_end(self, batch):
        """Each counted request (the batch request, a follow-up) opens `batchTimeoutMinutes`; resumes do not."""
        return batch.get("windowAt", batch.get("promptedAt", time.time())) + self.cfg["batchTimeoutMinutes"] * 60

    def wait_idle(self, workspace, batch, lease):
        """Wait until the batch's last turn completed and no session in its workspace runs for two polls.

        A turn that an interruption ended (a cloud Muse restart, a model or provider error, a turn that never ended)
        is resumed in the same session without counting a follow-up, after a backoff that grows with consecutive
        interruptions; the request's time window is the only limit. Past the window running sessions are cancelled.
        """
        quiet, answered = 0, False
        while True:
            lease.check()
            self.write_status("transcribing")
            deadline = self.window_end(batch)
            try:
                items = [item for item in self.muse.sessions() if item.get("cwd") == str(workspace)]
            except WorkError as error:
                if error.code != "MUSE_UNAVAILABLE" or time.time() > deadline:
                    raise
                self.log(event="muse-unavailable", session=batch.get("session"))
                quiet = 0
                self.wait(self.cfg["pollSeconds"])
                continue
            if not answered and any((((item.get("projections") or {}).get("values") or {}).get("userQuestions") or {}).get("active")
                                    for item in items):
                self.muse.prompt(batch["session"], ANSWER)
                answered = True
            if any(item.get("running") for item in items):
                quiet = 0
            else:
                quiet += 1
                if quiet >= 2 and time.time() - batch.get("promptedAt", 0) >= 2 * self.cfg["pollSeconds"]:
                    kind, detail = self.muse.last_turn(batch["session"])
                    if kind == "error" and detail and "quota_exhausted" in detail:
                        raise WorkError("QUOTA_EXHAUSTED", "额度已用完，请找组长划拨后再继续")
                    if kind not in INTERRUPTED:
                        batch["interruptions"] = 0
                        return
                    if time.time() > deadline:
                        self.log(event="batch-timeout", session=batch.get("session"), lastTurn=kind)
                        return
                    streak = batch.get("interruptions", 0)
                    self.wait(min(self.cfg["pollSeconds"] * 2 ** streak, self.cfg.get("resumeBackoffMaxSeconds", 1800)))
                    self.ready(lease)
                    self.muse.prompt(batch["session"], RESUME)
                    batch["promptedAt"] = time.time()
                    batch["interruptions"] = streak + 1
                    batch["resumes"] = batch.get("resumes", 0) + 1
                    self.log(event="batch-resumed", session=batch.get("session"), lastTurn=kind, detail=(detail or "")[:120])
                    quiet = 0
                    continue
            if time.time() > deadline:
                for item in items:
                    if item.get("running"):
                        self.muse.cancel(item["sessionId"])
                self.log(event="batch-timeout", session=batch.get("session"))
                return
            self.wait(self.cfg["pollSeconds"])

    def combine(self, workspace, total, directory):
        parts = []
        for number in range(1, total + 1):
            text = (workspace / "episodes" / f"第{number}集.md").read_text(encoding="utf-8").strip()
            if not re.match(rf"^\s*#*\s*第\s*{number}\s*集", text):
                text = f"第{number}集\n{text}"
            parts.append(text)
        manuscript = directory / "screenplay.md"
        manuscript.write_text("\n\n".join(parts) + "\n", encoding="utf-8")
        return manuscript


def run(production, idle_seconds, error_seconds):
    """Keep `dramasAtOnce` slots working, plus any slot that still holds a claim, until stopped."""
    threads = {}
    while not production.stop.is_set():
        wanted = production.control.read()["dramasAtOnce"]
        for number in sorted(set(range(1, wanted + 1)) | production.active_slots()):
            if number not in threads or not threads[number].is_alive():
                threads[number] = threading.Thread(target=work_slot, args=(production, number, idle_seconds, error_seconds),
                                                   name=f"slot-{number}", daemon=True)
                threads[number].start()
        try:
            production.wait(production.cfg["pollSeconds"])
        except Interrupted:
            break
    for thread in threads.values():
        thread.join()


def work_slot(production, number, idle_seconds, error_seconds):
    """One slot: a series at a time until stopped, or until `dramasAtOnce` drops below it with nothing claimed."""
    production.local.slot = number
    while not production.stop.is_set():
        if number > production.control.read()["dramasAtOnce"] and not production.active.exists():
            with production.reporting:
                production.slots.pop(number, None)
                production.publish_status()
            return
        try:
            if not production.once():
                production.wait(idle_seconds)
        except Interrupted:
            return
        except Exception as error:  # noqa: BLE001 - one slot's failure is reported and retried; the others go on.
            code, message = getattr(error, "code", None) or type(error).__name__, str(error)[:300]
            production.log(event="error", code=code, message=message)
            if not isinstance(error, (WorkError, StationError, OSError, subprocess.SubprocessError)):
                traceback.print_exc()
            try:
                production.write_status("error", error={"code": code, "message": message})
            except OSError as status_error:
                production.log(event="status-unwritable", message=str(status_error)[:200])
            try:
                production.wait(error_seconds)
            except Interrupted:
                return


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("--once", action="store_true", help="work on at most one series, then exit")
    args = parser.parse_args()
    cfg = json.loads(args.config.read_text(encoding="utf-8"))
    station = Station(cfg["stationBase"], cfg["stationTokenFile"], cfg.get("requestTimeoutSeconds", 30))
    production = Production(cfg, station, MuseCloud(cfg["museHost"], cfg["musePort"], cfg["museUnit"],
                                                    cfg.get("museSessionsRoot", "/var/lib/muse-cloud/home/sessions")))
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: production.stop.set())
    production.log(event="started", worker=cfg["workerId"], maxDramasAtOnce=production.control.cap)
    if args.once:
        try:
            production.once()
        except Interrupted:
            pass
    else:
        run(production, cfg.get("idleSeconds", 600), cfg.get("errorPauseSeconds", 300))
    production.log(event="stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
