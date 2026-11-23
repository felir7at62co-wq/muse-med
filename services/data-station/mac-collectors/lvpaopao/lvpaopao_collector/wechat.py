"""WeChat guardian: keeps the isolated WeChat copy running with its private home, guards the user's real WeChat data,
detects the login screen and drives the accessibility steps (login button, mini-program re-entry).

Login detection and every accessibility path here are heuristics that have NOT been verified against the real copy.
"""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import pwd
import tempfile
import threading
import time

from .macos import KILL, TERM, Proc
from .util import read_json, write_json

MAIN_PART = 'Contents/MacOS/WeChat'
APPEX_PART = 'Contents/MacOS/WeChatAppEx.app/Contents/MacOS/WeChatAppEx'
FORBIDDEN_SUFFIXES = ('Library/Containers/com.tencent.xinWeChat/', 'Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat/',
                      'Library/Application Support/WeChat/', 'Library/Application Support/com.tencent.xinWeChat/')
MAX_LOGIN_PNG = 1_048_576


@dataclass(frozen=True)
class LoginState:
    """Result of login detection: `kind` is `logged-in`, `qr`, `confirm` or `unknown`; `window` is the AX window info."""

    kind: str
    window: dict | None = None

    @property
    def logged_in(self) -> bool | None:
        """True/False when known, `None` when the heuristic cannot tell."""
        return True if self.kind == 'logged-in' else None if self.kind == 'unknown' else False


def _texts(node: dict, limit: int = 400) -> list[str]:
    found: list[str] = []
    stack = [node]
    while stack and len(found) < limit:
        item = stack.pop()
        for key in ('title', 'description', 'name', 'value'):
            if isinstance(item.get(key), str) and item[key]:
                found.append(item[key])
        stack.extend(item.get('children') or [])
    return found


def classify_login(main_dump: dict, appex_windows: int, config) -> LoginState:
    """Heuristic login detection from the WeChat main process's AX windows (unverified).

    A small window containing a confirm marker (「进入微信」) or a QR marker means logged out; a wide window or any open
    mini-program window means logged in; no windows at all is unknown (a logged-in WeChat can have every window closed).
    """
    markers = config['wechat']['loginMarkers']
    max_width = config['wechat']['loginWindowMaxWidth']
    wide = False
    for window in main_dump.get('windows') or []:
        size = window.get('size') or [0, 0]
        if size and size[0] > max_width:
            wide = True
            continue
        texts = _texts(window)
        if any(marker in text for marker in markers['confirm'] for text in texts):
            return LoginState('confirm', window)
        if any(marker in text for marker in markers['qr'] for text in texts):
            return LoginState('qr', window)
    if wide or appex_windows > 0:
        return LoginState('logged-in')
    return LoginState('unknown')


class Guardian:
    """Owns the isolated WeChat copy. `tick()` is called every few seconds from its own thread."""

    def __init__(self, config, mac, clock, station, log):
        self.config = config
        self.mac = mac
        self.clock = clock
        self.station = station
        self.log = log
        self.app = Path(config['wechat']['app'])
        self.home = config.private_home
        self.state_path = config.home / 'state' / 'wechat.json'
        self.uid = os.getuid()
        real_home = pwd.getpwuid(self.uid).pw_dir.rstrip('/')
        self.forbidden = tuple(f'{real_home}/{suffix}' for suffix in FORBIDDEN_SUFFIXES)
        self.lock = threading.RLock()
        self.main_pid: int | None = None
        self.main_start: str | None = None
        self.blocked: str | None = None
        self.login = LoginState('unknown')
        self.restarts = 0
        self.next_launch = 0.0
        self.running_since: float | None = None
        self.last_guard = 0.0
        self.last_capture = 0.0
        self.screen_shown = False
        self.wanted = True

    # -- process tracking ------------------------------------------------------------------------------------------
    @property
    def main_exe(self) -> str:
        """Absolute path of the copy's main executable."""
        return str(self.app / MAIN_PART)

    def running(self) -> bool:
        """Whether the tracked copy is still the same process (pid and start time)."""
        with self.lock:
            return self.main_pid is not None and self.mac.start_time(self.main_pid) == self.main_start

    def appex_pid(self, rows: list[Proc] | None = None) -> int | None:
        """Pid of the copy's WeChatAppEx root (child of the main process), if running."""
        if not self.running():
            return None
        rows = rows if rows is not None else self.mac.processes()
        for row in rows:
            if row.ppid == self.main_pid and row.uid == self.uid and row.comm == str(self.app / APPEX_PART):
                return row.pid
        return None

    def owned_pids(self, rows: list[Proc]) -> list[int]:
        """The main process and all descendants that run from inside the copy's bundle."""
        owned = {self.main_pid}
        changed = True
        while changed:
            changed = False
            for row in rows:
                if row.ppid in owned and row.pid not in owned and row.comm.startswith(str(self.app) + '/'):
                    owned.add(row.pid)
                    changed = True
        return [row.pid for row in rows if row.pid in owned]

    def _adopt(self) -> bool:
        """Adopt an already running copy (after a collector restart) if its environment is the private one."""
        record = read_json(self.state_path) or {}
        for row in self.mac.processes():
            if row.uid != self.uid or row.comm != self.main_exe:
                continue
            start = self.mac.start_time(row.pid)
            environment = ' ' + self.mac.environment(row.pid) + ' '
            if f' HOME={self.home} ' not in environment or f' CFFIXED_USER_HOME={self.home} ' not in environment:
                self.blocked = 'wechat-env-invalid'
                self.log('error', f'running WeChat-Muse-Test pid {row.pid} lacks the private HOME; not adopted')
                return False
            self.main_pid, self.main_start = row.pid, start
            self.running_since = self.clock.wall() if record.get('pid') != row.pid else record.get('since', self.clock.wall())
            self._save()
            self.log('info', f'adopted isolated WeChat pid {row.pid}')
            return True
        return False

    def _save(self) -> None:
        write_json(self.state_path, {'pid': self.main_pid, 'start': self.main_start, 'since': self.running_since})

    def launch(self) -> None:
        """Start the copy with the private HOME/CFFIXED_USER_HOME/TMPDIR, as the reference launcher does."""
        tmp = self.home / 'tmp'
        tmp.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        env.update({'HOME': str(self.home), 'CFFIXED_USER_HOME': str(self.home), 'TMPDIR': str(tmp) + '/'})
        log_path = self.config.home / 'logs' / 'wechat.log'
        log_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        pid = self.mac.launch([self.main_exe], env, str(self.app.parent), str(log_path))
        with self.lock:
            self.main_pid, self.main_start = pid, self.mac.start_time(pid)
            self.running_since = self.clock.wall()
            self.login = LoginState('unknown')
            self._save()
        self.log('info', f'launched isolated WeChat pid {pid}')

    def stop(self, wait_seconds: float = 10.0) -> None:
        """Terminate the tracked copy (process group when we started it), escalating to SIGKILL."""
        with self.lock:
            pid, start = self.main_pid, self.main_start
        if pid is None or self.mac.start_time(pid) != start:
            return
        self.mac.kill(pid, TERM, group=True)
        deadline = time.monotonic() + wait_seconds
        while time.monotonic() < deadline and self.mac.start_time(pid) == start:
            time.sleep(0.2)
        if self.mac.start_time(pid) == start:
            self.mac.kill(pid, KILL, group=True)
        self.mac.reap()
        with self.lock:
            self.main_pid = self.main_start = None
            self.running_since = None

    def restart(self) -> None:
        """Restart the copy now (retry ladder step 2), bypassing the crash backoff."""
        self.log('warn', 'restarting isolated WeChat')
        self.stop()
        if self.blocked is None and self.app.exists():
            self.launch()

    # -- periodic work ---------------------------------------------------------------------------------------------
    def tick(self) -> None:
        """Keep the copy alive with backoff, run the forbidden-path guard, refresh login state and upload login screenshots."""
        now = self.clock.wall()
        if self.blocked is not None:
            return
        if not self.running():
            if self.main_pid is not None:
                self.log('warn', f'isolated WeChat pid {self.main_pid} exited')
                self.mac.reap()
                with self.lock:
                    stable = self.running_since is not None and now - self.running_since >= self.config['wechat']['stableSeconds']
                    self.restarts = 0 if stable else self.restarts + 1
                    self.main_pid = self.main_start = None
                    self.running_since = None
                    self.login = LoginState('unknown')
                backoff = self.config['wechat']['restartBackoffSeconds']
                self.next_launch = now + backoff[min(max(self.restarts - 1, 0), len(backoff) - 1)]
            if not self._adopt() and self.blocked is None and self.wanted and now >= self.next_launch:
                if not self.app.exists():
                    self.blocked = 'wechat-app-missing'
                    self.log('error', f'isolated WeChat copy not found at {self.app}')
                    return
                self.launch()
            return
        if now - self.last_guard >= self.config['wechat']['guardSeconds']:
            self.last_guard = now
            if self._forbidden_seen():
                return
        self.refresh_login()
        self._login_screen(now)

    def _forbidden_seen(self) -> bool:
        rows = self.mac.processes()
        files = self.mac.open_files(self.owned_pids(rows))
        if any(path.startswith(prefix) for path in files for prefix in self.forbidden):
            self.log('error', 'isolated WeChat opened the original WeChat data directory; stopping it')
            self.blocked = 'forbidden-original-data'
            self.stop()
            return True
        return False

    def refresh_login(self) -> LoginState:
        """Re-run login detection; on AX failure the previous state is kept as `unknown`."""
        if not self.running():
            self.login = LoginState('unknown')
            return self.login
        try:
            dump = self.mac.ax_dump(self.main_pid, max_depth=8, max_nodes=400)
            appex = self.appex_pid()
            appex_windows = len((self.mac.ax_dump(appex, max_depth=0, max_nodes=20).get('windows') or [])) if appex else 0
            self.login = classify_login(dump, appex_windows, self.config)
        except (OSError, ValueError, TypeError) as error:
            self.log('warn', f'login detection failed: {error}')
            self.login = LoginState('unknown')
        return self.login

    def _login_screen(self, now: float) -> None:
        if self.login.kind in ('qr', 'confirm'):
            if now - self.last_capture < self.config['wechat']['loginCaptureSeconds']:
                return
            self.last_capture = now
            png = self.capture_login()
            if png is not None and self.station.put_login_screen(png, self.login.kind):
                self.screen_shown = True
        elif self.login.kind == 'logged-in' and self.screen_shown:
            if self.station.delete_login_screen():
                self.screen_shown = False

    def capture_login(self) -> bytes | None:
        """Capture only the login window: match its AX bounds to a CoreGraphics window id, then `screencapture -l`."""
        window = self.login.window or {}
        try:
            candidates = [row for row in self.mac.cg_windows(self.main_pid) if row.get('layer') == 0]
        except (OSError, ValueError) as error:
            self.log('warn', f'window list failed: {error}')
            return None
        position, size = window.get('position') or [None, None], window.get('size') or [None, None]
        def distance(row):
            bounds = row.get('bounds') or {}
            return sum(abs((a or 0) - (b or 0)) for a, b in ((bounds.get('X'), position[0]), (bounds.get('Y'), position[1]),
                                                                (bounds.get('Width'), size[0]), (bounds.get('Height'), size[1])))
        if not candidates:
            return None
        best = min(candidates, key=distance)
        with tempfile.TemporaryDirectory(prefix='lvpaopao-login-') as directory:
            path = os.path.join(directory, 'login.png')
            try:
                self.mac.capture_window(int(best['id']), path)
                if os.path.getsize(path) > MAX_LOGIN_PNG:
                    self.mac.shrink_png(path, 720)
                raw = Path(path).read_bytes()
            except OSError as error:
                self.log('warn', f'login capture failed: {error}')
                return None
        return raw if 8 < len(raw) <= MAX_LOGIN_PNG else None

    # -- accessibility actions -------------------------------------------------------------------------------------
    def start_login(self) -> tuple[bool, str]:
        """Handle a `start-login` command: press 「进入微信」, or refresh an expired QR code."""
        state = self.refresh_login()
        if state.kind == 'logged-in':
            return True, '微信已登录，无需操作'
        if not self.running():
            return False, '隔离微信未运行'
        markers = self.config['wechat']['loginMarkers']['confirm'] if state.kind == 'confirm' else self.config['wechat']['loginRefreshMarkers']
        try:
            result = self.mac.ax_find(self.main_pid, {'role': 'AXButton', 'text': markers}, None, 'AXPress')
            if not result.get('acted') and state.kind != 'confirm':
                result = self.mac.ax_find(self.main_pid, {'text': markers}, None, 'AXPress')
        except (OSError, ValueError) as error:
            return False, f'辅助功能操作失败：{error}'[:300]
        if result.get('acted'):
            self.last_capture = 0.0
            return True, '已点击进入微信，请在手机上确认' if state.kind == 'confirm' else '已刷新二维码'
        return state.kind == 'qr', '当前是二维码界面，请直接扫码' if state.kind == 'qr' else '没有找到可点击的登录按钮'

    def run_steps(self, steps: list[dict], stop: threading.Event) -> tuple[bool, str]:
        """Run one re-entry strategy: each step waits for its element and performs its AX action."""
        for index, step in enumerate(steps):
            pid = self.main_pid if step['process'] == 'wechat' else self.appex_pid()
            deadline = self.clock.wall() + float(step.get('waitSeconds', 5))
            acted = False
            while not acted:
                if pid is not None:
                    try:
                        result = self.mac.ax_find(pid, step['match'], step.get('window'), step.get('action', 'AXPress'))
                        acted = bool(result.get('acted'))
                    except (OSError, ValueError) as error:
                        self.log('warn', f'reentry step {index} failed: {error}')
                if acted or self.clock.wall() >= deadline or self.clock.sleep(1, stop):
                    break
                if pid is None:
                    pid = self.main_pid if step['process'] == 'wechat' else self.appex_pid()
            if not acted and not step.get('optional'):
                return False, f'第 {index + 1} 步未找到可点击的元素'
            self.clock.sleep(1, stop)
        return True, ''
