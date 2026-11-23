"""Shared fakes: clock, macOS facade, loopback station and a config factory wired to the fake helper."""
from __future__ import annotations

import datetime as dt
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import unittest

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from lvpaopao_collector.config import validate  # noqa: E402
from lvpaopao_collector.macos import Proc  # noqa: E402

TESTS = Path(__file__).resolve().parent
BEIJING = dt.timezone(dt.timedelta(hours=8))
PNG = b'\x89PNG\r\n\x1a\n' + b'0' * 64


def beijing(year, month, day, hour, minute=0, second=0) -> float:
    """POSIX time of a Beijing wall-clock moment."""
    return dt.datetime(year, month, day, hour, minute, second, tzinfo=BEIJING).timestamp()


class FakeClock:
    """Wall time and uptime that only move when told; `sleep` advances both instantly."""

    def __init__(self, start: float):
        self.now = start
        self.up = 1000.0
        self.lock = threading.Lock()

    def wall(self) -> float:
        return self.now

    def uptime(self) -> float:
        return self.up

    def advance(self, seconds: float) -> None:
        with self.lock:
            self.now += seconds
            self.up += seconds

    def mac_sleeps(self, seconds: float) -> None:
        """Wall time moves, uptime does not (what macOS does while asleep)."""
        self.now += seconds

    def sleep(self, seconds: float, stop: threading.Event) -> bool:
        if stop.is_set():
            return True
        self.advance(max(0.0, seconds))
        return stop.is_set()


class FakeMac:
    """In-memory macOS: process table, AX trees, window capture, network and lark-cli.

    `reentry`: 'capsule' (the capsule menu works), 'list' (only reopening from the list works) or 'none'.
    `login`: 'logged-in', 'qr' or 'confirm'.
    """

    def __init__(self, app: Path, ready_file: Path):
        self.app = app
        self.ready_file = ready_file
        self.uid = os.getuid()
        self.procs: dict[int, Proc] = {}
        self.starts: dict[int, str] = {}
        self.envs: dict[int, str] = {}
        self.files: dict[int, list[str]] = {}
        self.listening: list[int] = []
        self.next_pid = 5000
        self.launched: list[dict] = []
        self.killed: list[tuple] = []
        self.login = 'logged-in'
        self.reentry = 'capsule'
        self.network = True
        self.ax_calls: list[dict] = []
        self.captures = 0
        self.commands: list[list[str]] = []

    # process table
    def add_proc(self, comm: str, ppid: int = 1, env: str = '') -> int:
        self.next_pid += 1
        pid = self.next_pid
        self.procs[pid] = Proc(pid, ppid, self.uid, comm)
        self.starts[pid] = f'start-{pid}'
        self.envs[pid] = env
        return pid

    def remove(self, pid: int) -> None:
        self.procs.pop(pid, None)
        self.starts.pop(pid, None)

    def crash_wechat(self) -> None:
        for pid in list(self.procs):
            if self.procs[pid].comm.startswith(str(self.app)):
                self.remove(pid)

    def processes(self):
        return list(self.procs.values())

    def start_time(self, pid):
        if pid in self.starts:
            return self.starts[pid]
        try:
            os.kill(pid, 0)
        except OSError:
            return None
        return f'real-{pid}'

    def environment(self, pid):
        return self.envs.get(pid, '')

    def open_files(self, pids):
        return [path for pid in pids for path in self.files.get(pid, [])]

    def listeners(self, port):
        return list(self.listening)

    def launch(self, argv, env, cwd, log_path):
        environment = ' '.join(f'{key}={env[key]}' for key in ('HOME', 'CFFIXED_USER_HOME', 'TMPDIR'))
        main = self.add_proc(argv[0], env=f'{argv[0]} {environment}')
        self.add_proc(str(self.app / 'Contents/MacOS/WeChatAppEx.app/Contents/MacOS/WeChatAppEx'), ppid=main)
        self.launched.append({'argv': argv, 'env': {key: env[key] for key in ('HOME', 'CFFIXED_USER_HOME', 'TMPDIR')}, 'cwd': cwd})
        return main

    def kill(self, pid, sig, group):
        self.killed.append((pid, sig, group))
        if pid in self.procs:
            if group:
                self.crash_wechat()
            self.remove(pid)
        else:
            try:
                os.kill(pid, sig)
            except OSError:
                pass

    def reap(self):
        pass

    # accessibility
    def _main_pid(self):
        return next((pid for pid, proc in self.procs.items() if proc.comm == str(self.app / 'Contents/MacOS/WeChat')), None)

    def ax_dump(self, pid, max_depth=12, max_nodes=3000):
        if pid == self._main_pid():
            if self.login == 'qr':
                return {'windows': [{'title': '微信', 'size': [280, 380], 'position': [10, 20], 'children': [{'role': 'AXStaticText', 'value': '请使用微信扫一扫登录'}]}]}
            if self.login == 'confirm':
                return {'windows': [{'title': '微信', 'size': [280, 380], 'position': [10, 20], 'children': [{'role': 'AXButton', 'title': '进入微信'}]}]}
            return {'windows': [{'title': '微信', 'size': [900, 640], 'position': [0, 0]}]}
        return {'windows': [{'title': '绿泡泡', 'size': [400, 800]}] if self.ready_file.exists() else []}

    def ax_find(self, pid, match, window, action):
        self.ax_calls.append({'pid': pid, 'match': match, 'action': action})
        texts = match.get('text') or []
        if '进入微信' in texts and self.login == 'confirm':
            return {'found': 1, 'acted': True}
        if '刷新' in texts and self.login == 'qr':
            return {'found': 1, 'acted': True}
        if self.login != 'logged-in':
            return {'found': 0}
        if self.reentry == 'capsule' and ('更多' in texts or '重新进入小程序' in texts):
            if '重新进入小程序' in texts:
                self.ready_file.touch()
            return {'found': 1, 'acted': True}
        if self.reentry == 'list' and (match.get('subrole') == 'AXCloseButton' or texts in (['小程序'], ['绿泡泡'])):
            if texts == ['绿泡泡']:
                self.ready_file.touch()
            return {'found': 1, 'acted': True}
        return {'found': 0}

    def cg_windows(self, pid):
        return [{'id': 77, 'layer': 0, 'bounds': {'X': 10, 'Y': 20, 'Width': 280, 'Height': 380}}, {'id': 78, 'layer': 0, 'bounds': {'X': 0, 'Y': 0, 'Width': 1, 'Height': 1}}]

    def capture_window(self, window_id, path):
        assert window_id == 77, 'only the login window may be captured'
        self.captures += 1
        Path(path).write_bytes(PNG)

    def shrink_png(self, path, max_pixels):
        pass

    def tcp_probe(self, host, port, timeout):
        return self.network

    def run_command(self, argv, timeout, env=None):
        self.commands.append(argv)
        return 0


class FakeStation:
    """Loopback HTTP fake of `/api/service/lvpaopao/*`; records every request."""

    def __init__(self):
        self.requests: list[dict] = []
        self.run_status = 200
        self.commands: list[dict] = []
        self.runs: dict[str, dict] = {}
        station = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def _reply(self, status, body):
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _handle(self):
                length = int(self.headers.get('Content-Length') or 0)
                body = json.loads(self.rfile.read(length)) if length else None
                station.requests.append({'method': self.command, 'path': self.path, 'body': body, 'token': self.headers.get('X-Muse-Data-Service-Token'),
                                         'origin': self.headers.get('Origin')})
                path = self.path.replace('/api/service/lvpaopao', '')
                if path == '/runs':
                    status = station.run_status(body) if callable(station.run_status) else station.run_status
                    if status != 200:
                        return self._reply(status, {'error': 'scripted'})
                    duplicate = body['runId'] in station.runs
                    station.runs[body['runId']] = body
                    return self._reply(200, {'accepted': True, 'duplicate': duplicate, 'works': 0})
                if path == '/heartbeat':
                    return self._reply(200, {'commands': list(station.commands), 'serverTime': '2026-11-15T09:00:00+08:00'})
                if path.startswith('/commands/'):
                    identifier = path.split('/')[2]
                    station.commands = [item for item in station.commands if item['id'] != identifier]
                    return self._reply(200, {'removed': True})
                if path == '/login-screen':
                    return self._reply(200, {'stored': True} if self.command == 'PUT' else {'removed': True})
                return self._reply(404, {'error': 'not found'})

            do_POST = do_PUT = do_DELETE = _handle

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}/api/service/lvpaopao'

    def of(self, path: str, method: str = 'POST') -> list[dict]:
        return [item for item in self.requests if item['path'].endswith(path) and item['method'] == method]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


TOKEN = 'test-token-' + 'a' * 32


class Env(unittest.TestCase):
    """Base test case: temp home, fake helper resources, fake mac, fake station and fake clock."""

    start = beijing(2026, 11, 15, 8, 55)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='lvpaopao-test-'))
        self.resources = self.tmp / 'native'
        self.resources.mkdir()
        shutil.copy(TESTS / 'fake_boot.py', self.resources / 'boot.py')
        shutil.copy(TESTS / 'fake_helper.py', self.resources / 'fake_helper.py')
        self.ready = self.tmp / 'ready'
        self.app = self.tmp / 'wechat' / 'WeChat-Muse-Test.app'
        self.app.mkdir(parents=True)
        self.scenario({})
        self.station = FakeStation()
        self.addCleanup(self.station.close)
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.clock = FakeClock(self.start)
        self.mac = FakeMac(self.app, self.ready)

    def scenario(self, value: dict) -> None:
        (self.resources / 'scenario.json').write_text(json.dumps({'readyFile': str(self.ready), **value}))

    def config(self, **sections):
        data = {
            'home': str(self.tmp / 'home'), 'lockFile': str(self.tmp / 'run' / 'helper.lock'),
            'station': {'baseUrl': self.station.url, 'tokenFile': str(self.tmp / 'token'), 'timeoutSeconds': 5},
            'wechat': {'app': str(self.app)},
            'helper': {'python': sys.executable, 'resources': str(self.resources), 'runtimeHome': str(self.tmp / 'runtime'),
                       'requestTimeoutSeconds': 5, 'readyTimeoutSeconds': 9, 'lockWaitSeconds': 20, 'shutdownTimeoutSeconds': 5},
            'reentry': {'statusPollSeconds': 3},
            'schedule': {'minCallIntervalSeconds': 1.0},
        }
        for key, value in sections.items():
            if isinstance(value, dict) and isinstance(data.get(key), dict):
                data[key] = {**data[key], **value}
            else:
                data[key] = value
        return validate(data)

    def service(self, config=None):
        from lvpaopao_collector.service import Service
        service = Service(config or self.config(), self.mac, self.clock, token=TOKEN)
        service.guardian.tick()
        return service
