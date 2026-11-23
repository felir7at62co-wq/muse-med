"""Client for the Muse lvpaopao native helper: preparation (`boot.py --prepare`), the JSONL stdio protocol and clean shutdown.

Protocol (plugin `src/jsonl.ts`): one JSON object per line; requests `{protocol:1,type:'request',id,method,params}`, answers
`{protocol:1,type:'result'|'error',id,...}`, events `waiting_target`/`ready`/`closed`, controls `cancel` and `close`.
At most 1024 request ids per helper run and 16 KiB per line we send; a malformed line kills the helper.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import uuid

from .errors import FATAL, GENERATION, TRANSIENT, CollectError, classify
from .util import read_json, write_json

EXPECTED_APP_ID = 'wx404dde55fb12df78'
CLEAN_CLOSE_STATUSES = frozenset({'control-close', 'control-eof', 'host-context-ended', 'hook-disposed', 'hook-stopped',
                                  'peer-ended', 'deadline', 'cancelled'})
REQUIRED_ACTIONS = ('status', 'detail', 'rankings', 'engagement')
MAX_IDS_PER_RUN = 1024
MAX_SENT_LINE = 16384
MAX_RECEIVED_LINE = 4 << 20


@dataclass(frozen=True)
class Prepared:
    """The single JSON line `boot.py --prepare` prints on success."""

    python: str
    helper: str
    sha256: str
    cwd: str


class ProcessRecords:
    """Pid + start-time records of processes this collector started, so a crashed run's leftovers can be cleaned up.

    Only processes whose recorded start time still matches are signalled; nothing is ever killed by name.
    """

    def __init__(self, path: Path, mac):
        self.path = path
        self.mac = mac
        self._lock = threading.Lock()

    def add(self, label: str, pid: int) -> None:
        """Record a process we just started."""
        start = self.mac.start_time(pid)
        with self._lock:
            records = (read_json(self.path) or {}).get('processes', [])
            records = [item for item in records if item.get('label') != label]
            records.append({'label': label, 'pid': pid, 'start': start})
            write_json(self.path, {'processes': records})

    def remove(self, label: str) -> None:
        """Forget a process that exited."""
        with self._lock:
            records = (read_json(self.path) or {}).get('processes', [])
            write_json(self.path, {'processes': [item for item in records if item.get('label') != label]})

    def cleanup(self, wait_seconds: float = 5.0) -> list[int]:
        """Terminate recorded processes that are still the same process (pid and start time); returns the pids signalled."""
        from .macos import KILL, TERM
        with self._lock:
            records = (read_json(self.path) or {}).get('processes', [])
        killed = []
        for item in records:
            pid, start = item.get('pid'), item.get('start')
            if type(pid) is not int or not start or self.mac.start_time(pid) != start:
                continue
            self.mac.kill(pid, TERM, group=False)
            deadline = time.monotonic() + wait_seconds
            while time.monotonic() < deadline and self.mac.start_time(pid) == start:
                time.sleep(0.1)
            if self.mac.start_time(pid) == start:
                self.mac.kill(pid, KILL, group=False)
            killed.append(pid)
        self.mac.reap()
        with self._lock:
            write_json(self.path, {'processes': []})
        return killed


def helper_environment(config) -> dict:
    """Environment for boot.py and the helper: UTF-8 stdio and explicit media tools (launchd's PATH lacks Homebrew)."""
    return {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': os.path.expanduser('~'), 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8',
            'DSH_FFMPEG_PATH': config['helper']['ffmpeg'], 'DSH_FFPROBE_PATH': config['helper']['ffprobe']}


def _sha256(path: str) -> str:
    with open(path, 'rb') as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def prepare(config, records: ProcessRecords, stop: threading.Event) -> Prepared:
    """Run `boot.py --prepare` and return the prepared helper launch; raises a classified `CollectError` on failure."""
    helper = config['helper']
    resources = Path(helper['resources'])
    argv = [helper['python'], '-u', str(resources / 'boot.py'), '--prepare', '--home', helper['runtimeHome'], '--resources', str(resources),
            '--lifetime-ms', str(helper['lifetimeMs']), '--max-callbacks', str(helper['maxCallbacks'])]
    Path(helper['runtimeHome']).mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        process = subprocess.Popen(argv, cwd=str(resources), env=helper_environment(config), stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except OSError:
        raise CollectError('helper-error', FATAL, 'prepare-launch-failed', '无法启动 helper 准备脚本（Python 或资源路径错误）') from None
    records.add('prepare', process.pid)
    deadline = time.monotonic() + helper['prepareTimeoutSeconds']
    try:
        while process.poll() is None:
            if stop.is_set() or time.monotonic() > deadline:
                process.terminate()
                try:
                    process.wait(5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(5)
                if stop.is_set():
                    raise CollectError('cancelled', GENERATION, 'cancelled', '采集端正在停止')
                raise CollectError('target-timeout', GENERATION, 'setup-timeout', '准备连接超时')
            time.sleep(0.2)
        output = process.stdout.read(65537).decode('utf8', errors='replace').strip().splitlines()
    finally:
        process.stdout.close()
        records.remove('prepare')
    try:
        value = json.loads(output[-1]) if output else None
    except ValueError:
        value = None
    if process.returncode != 0:
        code = value['error'].get('code') if isinstance(value, dict) and isinstance(value.get('error'), dict) else 'setup-failed'
        raise classify(str(code))
    if (not isinstance(value, dict) or value.get('transport') != 'local' or not all(isinstance(value.get(key), str) for key in ('localPython', 'localHelper', 'helperSha256', 'cwd'))):
        raise CollectError('helper-error', GENERATION, 'setup-output-invalid', '准备脚本输出无效')
    if _sha256(value['localHelper']) != value['helperSha256']:
        raise classify('helper-identity-mismatch')
    return Prepared(value['localPython'], value['localHelper'], value['helperSha256'], value['cwd'])


class HelperSession:
    """One helper process (one "generation"): handshake, sequential requests with cancel, and confirmed clean close."""

    def __init__(self, config, prepared: Prepared, records: ProcessRecords, log_path: Path):
        self.config = config
        self.prepared = prepared
        self.records = records
        self.log_path = log_path
        self.requests = 0
        self.started = time.monotonic()
        self.event: str | None = None
        self.closed_details: dict | None = None
        self._failure: CollectError | None = None
        self._responses: dict[str, dict] = {}
        self._cond = threading.Condition()
        self._process: subprocess.Popen | None = None
        self._reader: threading.Thread | None = None

    # -- lifecycle -------------------------------------------------------------------------------------------------
    def start(self) -> None:
        """Spawn the helper, record its identity and complete the `hello` handshake."""
        self.log_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        log = os.open(self.log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            self._process = subprocess.Popen([self.prepared.python, '-u', self.prepared.helper, '--rpc-stdio'], cwd=self.prepared.cwd,
                                             env=helper_environment(self.config), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
        except OSError:
            raise CollectError('helper-error', GENERATION, 'helper-launch-failed', '无法启动 helper') from None
        finally:
            os.close(log)
        self.records.add('helper', self._process.pid)
        self._reader = threading.Thread(target=self._read, name='helper-reader', daemon=True)
        self._reader.start()
        value = self.call('hello', {'expected_app_id': EXPECTED_APP_ID, 'helper_sha256': self.prepared.sha256},
                          timeout=self.config['helper']['helloTimeoutSeconds'])
        if (not isinstance(value, dict) or value.get('protocol_version') != 1 or value.get('helper_sha256') != self.prepared.sha256
                or value.get('expected_app_id') != EXPECTED_APP_ID or not isinstance(value.get('actions'), list)
                or not all(action in value['actions'] for action in REQUIRED_ACTIONS)):
            self._fail(CollectError('helper-error', GENERATION, 'handshake-mismatch', 'helper 握手不匹配'))
            raise self._failure

    @property
    def age(self) -> float:
        """Seconds since this generation started."""
        return time.monotonic() - self.started

    @property
    def failed(self) -> CollectError | None:
        """The terminal failure of this generation, if any."""
        return self._failure

    def close(self) -> bool:
        """Close the helper and confirm cleanup; returns whether it closed cleanly (status, cleanup flags and exit code 0)."""
        process = self._process
        if process is None:
            return True
        timeout = self.config['helper']['shutdownTimeoutSeconds']
        try:
            if process.poll() is None and process.stdin and not process.stdin.closed:
                self._send({'protocol': 1, 'type': 'close'})
                process.stdin.close()
        except (OSError, ValueError, CollectError):
            pass
        try:
            process.wait(timeout)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout)
        if self._reader:
            self._reader.join(2)
        for stream in (process.stdout, process.stdin):
            if stream is not None and not stream.closed:
                try:
                    stream.close()
                except OSError:
                    pass
        self.records.remove('helper')
        details = self.closed_details or {}
        cleanup = details.get('cleanup') if isinstance(details.get('cleanup'), dict) else {}
        clean = (process.returncode == 0 and details.get('status') in CLEAN_CLOSE_STATUSES
                 and all(cleanup.get(key) is True for key in ('dispose', 'unload', 'detach', 'serverClosed')))
        with self._cond:
            if self._failure is None:
                self._failure = CollectError('helper-error', GENERATION, 'connection-closed', '连接已关闭')
            self._cond.notify_all()
        return clean

    # -- protocol --------------------------------------------------------------------------------------------------
    def _fail(self, error: CollectError) -> None:
        with self._cond:
            if self._failure is None:
                self._failure = error
            self._cond.notify_all()

    def _read(self) -> None:
        stream = self._process.stdout
        while True:
            line = stream.readline(MAX_RECEIVED_LINE + 1)
            if not line:
                self._fail(CollectError('helper-error', GENERATION, 'connection-lost', 'helper 已退出'))
                return
            if len(line) > MAX_RECEIVED_LINE:
                self._fail(CollectError('helper-error', GENERATION, 'frame-too-large', 'helper 输出过大'))
                return
            try:
                frame = json.loads(line)
                if not isinstance(frame, dict) or frame.get('protocol') != 1:
                    raise ValueError()
            except ValueError:
                self._fail(CollectError('helper-error', GENERATION, 'invalid-response', 'helper 输出无效'))
                return
            with self._cond:
                if frame.get('type') == 'event':
                    self.event = frame.get('event')
                    if self.event == 'closed':
                        self.closed_details = frame.get('details') if isinstance(frame.get('details'), dict) else {}
                        status = str(self.closed_details.get('status'))
                        if self._failure is None:
                            self._failure = classify(status) if status not in ('control-close', 'control-eof') else \
                                CollectError('helper-error', GENERATION, 'connection-closed', '连接已关闭')
                elif frame.get('type') in ('result', 'error') and isinstance(frame.get('id'), str):
                    self._responses[frame['id']] = frame
                self._cond.notify_all()

    def _send(self, frame: dict) -> None:
        raw = json.dumps(frame, ensure_ascii=False, separators=(',', ':')).encode('utf8')
        if len(raw) > MAX_SENT_LINE:
            raise CollectError('helper-error', FATAL, 'frame-too-large', '请求过大')
        try:
            self._process.stdin.write(raw + b'\n')
            self._process.stdin.flush()
        except (OSError, ValueError):
            self._fail(CollectError('helper-error', GENERATION, 'connection-lost', 'helper 管道已断开'))
            raise self._failure from None

    def _wait(self, identifier: str, until: float, stop: threading.Event | None) -> dict | None:
        with self._cond:
            while identifier not in self._responses and self._failure is None:
                remaining = until - time.monotonic()
                if remaining <= 0 or (stop is not None and stop.is_set()):
                    return None
                self._cond.wait(min(remaining, 0.5))
            return self._responses.pop(identifier, None)

    def call(self, method: str, params: dict, timeout: float | None = None, stop: threading.Event | None = None):
        """Send one request and return its `value`; raises a classified `CollectError` (cancelling the request on timeout or stop)."""
        if self._failure is not None:
            raise self._failure
        if self.requests >= MAX_IDS_PER_RUN - 1:
            raise CollectError('helper-error', GENERATION, 'generation-exhausted', '本连接请求数已满')
        self.requests += 1
        identifier = uuid.uuid4().hex
        self._send({'protocol': 1, 'type': 'request', 'id': identifier, 'method': method, 'params': params})
        timeout = self.config['helper']['requestTimeoutSeconds'] if timeout is None else timeout
        frame = self._wait(identifier, time.monotonic() + timeout, stop)
        if frame is None and self._failure is not None:
            raise self._failure
        if frame is None:
            self._send({'protocol': 1, 'type': 'cancel', 'id': identifier})
            confirmed = self._wait(identifier, time.monotonic() + self.config['helper']['cancelTimeoutSeconds'], None)
            if confirmed is None:
                self._fail(CollectError('helper-error', GENERATION, 'cancel-unconfirmed', '取消请求未得到确认'))
                raise self._failure
            if stop is not None and stop.is_set():
                raise CollectError('cancelled', GENERATION, 'cancelled', '采集端正在停止')
            raise CollectError('helper-error', TRANSIENT, 'request-timeout', '请求超时')
        if frame['type'] == 'error':
            error = frame.get('error') if isinstance(frame.get('error'), dict) else {}
            raise classify(str(error.get('code', 'remote-error')))
        if 'value' not in frame:
            self._fail(CollectError('helper-error', GENERATION, 'invalid-response', 'helper 回复无效'))
            raise self._failure
        return frame['value']

    def ready(self, stop: threading.Event | None = None) -> bool:
        """Ask `status`; true once the mini-program is taken over (`status-returned`)."""
        value = self.call('status', {}, stop=stop)
        return isinstance(value, dict) and value.get('status') == 'status-returned'
