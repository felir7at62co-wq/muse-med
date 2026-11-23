"""Every macOS call the collector makes (ps, lsof, kill, osascript, screencapture, sips, TCP probes), behind one facade.

Tests replace `MacSystem` with a fake. The JXA scripts below drive System Events accessibility and CoreGraphics; their
element paths in the isolated WeChat copy are NOT verified yet (see README).
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
import signal
import socket
import subprocess


@dataclass(frozen=True)
class Proc:
    """One row of `ps -axo pid=,ppid=,uid=,comm=`."""

    pid: int
    ppid: int
    uid: int
    comm: str


def parse_ps(text: str) -> list[Proc]:
    """Parse `ps -axo pid=,ppid=,uid=,comm=` output; malformed rows are skipped."""
    rows = []
    for line in text.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) != 4:
            continue
        try:
            rows.append(Proc(int(parts[0]), int(parts[1]), int(parts[2]), parts[3]))
        except ValueError:
            continue
    return rows


def parse_lsof_names(text: str) -> list[str]:
    """Return the `n` (name) fields of `lsof -F n` output."""
    return [line[1:] for line in text.splitlines() if line.startswith('n')]


def parse_lsof_pids(text: str) -> list[int]:
    """Return the `p` (pid) fields of `lsof -F p` output."""
    pids = []
    for line in text.splitlines():
        if line.startswith('p') and line[1:].isdigit():
            pids.append(int(line[1:]))
    return pids


# Dump the accessibility tree of every window of one process (by unix id) as JSON.
JXA_DUMP = r'''
function run(argv) {
  const pid = parseInt(argv[0], 10), maxDepth = parseInt(argv[1], 10), maxNodes = parseInt(argv[2], 10);
  const se = Application('System Events');
  const procs = se.processes.whose({unixId: pid});
  if (procs.length === 0) return JSON.stringify({error: 'process-not-found'});
  let count = 0;
  const get = (el, name) => { try { const v = el[name](); return v === null || v === undefined ? null : v; } catch (e) { return null; } };
  const text = v => (typeof v === 'string' ? v.slice(0, 120) : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : null);
  function node(el, depth) {
    count += 1;
    const out = {role: get(el, 'role'), subrole: get(el, 'subrole'), title: text(get(el, 'title')), description: text(get(el, 'description')),
                 name: text(get(el, 'name')), value: text(get(el, 'value')), position: get(el, 'position'), size: get(el, 'size')};
    try { out.actions = el.actions().map(a => a.name()); } catch (e) { out.actions = []; }
    if (depth < maxDepth && count < maxNodes) {
      let children = [];
      try { children = el.uiElements(); } catch (e) { children = []; }
      out.children = [];
      for (const child of children) { if (count >= maxNodes) { out.truncated = true; break; } out.children.push(node(child, depth + 1)); }
    }
    return out;
  }
  const proc = procs[0];
  const windows = [];
  for (const w of proc.windows()) windows.push(node(w, 0));
  return JSON.stringify({pid: pid, frontmost: get(proc, 'frontmost'), windows: windows, nodes: count});
}
'''

# Find the first element matching a spec in a process's windows and optionally perform an AX action on it.
JXA_FIND = r'''
function run(argv) {
  const spec = JSON.parse(argv[0]);
  const se = Application('System Events');
  const procs = se.processes.whose({unixId: spec.pid});
  if (procs.length === 0) return JSON.stringify({found: 0, error: 'process-not-found'});
  const get = (el, name) => { try { const v = el[name](); return typeof v === 'string' ? v : null; } catch (e) { return null; } };
  const texts = el => ['title', 'description', 'name', 'value'].map(k => get(el, k)).filter(v => v);
  const hit = (list, el) => !list || texts(el).some(t => list.some(want => t === want || t.indexOf(want) !== -1));
  const matches = el => (!spec.match.role || get(el, 'role') === spec.match.role) && (!spec.match.subrole || get(el, 'subrole') === spec.match.subrole) && hit(spec.match.text, el);
  let visited = 0;
  function search(el, depth) {
    visited += 1;
    if (matches(el)) return el;
    if (depth >= spec.maxDepth || visited >= spec.maxNodes) return null;
    let children = [];
    try { children = el.uiElements(); } catch (e) { return null; }
    for (const child of children) { const found = search(child, depth + 1); if (found) return found; }
    return null;
  }
  for (const w of procs[0].windows()) {
    if (spec.window && spec.window.text && !hit(spec.window.text, w)) continue;
    const el = search(w, 0);
    if (!el) continue;
    const info = {role: get(el, 'role'), title: get(el, 'title'), description: get(el, 'description')};
    if (spec.action) {
      try { el.actions.byName(spec.action).perform(); return JSON.stringify({found: 1, acted: true, element: info}); }
      catch (e) { return JSON.stringify({found: 1, acted: false, element: info, error: 'action-failed'}); }
    }
    return JSON.stringify({found: 1, acted: false, element: info});
  }
  return JSON.stringify({found: 0, visited: visited});
}
'''

# List on-screen CoreGraphics windows of one process; the window number feeds `screencapture -l`.
JXA_CG_WINDOWS = r'''
ObjC.import('CoreGraphics');
function run(argv) {
  const pid = parseInt(argv[0], 10);
  const raw = $.CGWindowListCopyWindowInfo(1 | 16, 0);
  const rows = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];
  const out = [];
  for (const row of rows) {
    if (row.kCGWindowOwnerPID !== pid) continue;
    out.push({id: row.kCGWindowNumber, layer: row.kCGWindowLayer, name: row.kCGWindowName || null, bounds: row.kCGWindowBounds || null});
  }
  return JSON.stringify(out);
}
'''


class MacSystem:
    """Real macOS implementation. Every call has a timeout; failures surface as `OSError`/`subprocess` errors or empty results."""

    def __init__(self):
        self._launched: dict[int, subprocess.Popen] = {}

    def _run(self, argv: list[str], timeout: float, env: dict | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(argv, capture_output=True, timeout=timeout, env=env, stdin=subprocess.DEVNULL)

    def processes(self) -> list[Proc]:
        """All processes with pid, parent, uid and executable path."""
        result = self._run(['/bin/ps', '-axo', 'pid=,ppid=,uid=,comm='], 10)
        return parse_ps(result.stdout.decode('utf8', errors='replace'))

    def start_time(self, pid: int) -> str | None:
        """`ps lstart` of `pid` as an identity token, or `None` when the process is gone."""
        try:
            result = self._run(['/bin/ps', '-p', str(pid), '-o', 'lstart='], 5)
        except (OSError, subprocess.SubprocessError):
            return None
        text = result.stdout.decode('ascii', errors='replace').strip()
        return text or None

    def environment(self, pid: int) -> str:
        """Command line plus environment of `pid` (`ps eww`), used to check the private HOME."""
        result = self._run(['/bin/ps', 'eww', '-p', str(pid), '-o', 'command='], 5)
        return result.stdout.decode('utf8', errors='replace').strip()

    def open_files(self, pids: list[int]) -> list[str]:
        """Paths opened by `pids` (`lsof -n -F n`)."""
        if not pids:
            return []
        result = self._run(['/usr/sbin/lsof', '-n', '-F', 'n', '-p', ','.join(map(str, pids))], 20)
        return parse_lsof_names(result.stdout.decode('utf8', errors='replace'))

    def listeners(self, port: int) -> list[int]:
        """Pids listening on TCP `port`."""
        result = self._run(['/usr/sbin/lsof', '-nP', f'-iTCP:{port}', '-sTCP:LISTEN', '-F', 'p'], 10)
        return parse_lsof_pids(result.stdout.decode('ascii', errors='replace'))

    def launch(self, argv: list[str], env: dict, cwd: str, log_path: str) -> int:
        """Start a detached process in its own session (it survives collector restarts); returns its pid."""
        descriptor = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=descriptor, stderr=descriptor, start_new_session=True)
        finally:
            os.close(descriptor)
        self._launched[process.pid] = process
        return process.pid

    def kill(self, pid: int, sig: int, group: bool) -> None:
        """Send `sig` to `pid` (or its process group when `group`); a vanished process is ignored."""
        try:
            if group and os.getpgid(pid) == pid:
                os.killpg(pid, sig)
            else:
                os.kill(pid, sig)
        except ProcessLookupError:
            pass

    def reap(self) -> None:
        """Collect exited WeChat processes this object launched (never `waitpid(-1)`, which would steal helper exit codes)."""
        for pid, process in list(self._launched.items()):
            if process.poll() is not None:
                del self._launched[pid]

    def jxa(self, script: str, args: list[str], timeout: float = 30) -> str:
        """Run a JavaScript-for-Automation script with arguments and return its stdout."""
        result = self._run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', script, *args], timeout)
        if result.returncode != 0:
            raise OSError('osascript failed: ' + result.stderr.decode('utf8', errors='replace')[:200])
        return result.stdout.decode('utf8', errors='replace').strip()

    def ax_dump(self, pid: int, max_depth: int = 12, max_nodes: int = 3000) -> dict:
        """Accessibility tree of all windows of `pid`."""
        return json.loads(self.jxa(JXA_DUMP, [str(pid), str(max_depth), str(max_nodes)], timeout=120))

    def ax_find(self, pid: int, match: dict, window: dict | None, action: str | None) -> dict:
        """Find (and optionally act on) the first element matching `match` in windows of `pid`."""
        spec = {'pid': pid, 'match': match, 'window': window, 'action': action, 'maxDepth': 14, 'maxNodes': 4000}
        return json.loads(self.jxa(JXA_FIND, [json.dumps(spec, ensure_ascii=False)], timeout=60))

    def cg_windows(self, pid: int) -> list[dict]:
        """On-screen CoreGraphics windows of `pid` with ids and bounds."""
        return json.loads(self.jxa(JXA_CG_WINDOWS, [str(pid)], timeout=20))

    def capture_window(self, window_id: int, path: str) -> None:
        """Capture exactly one window to a PNG file, without shadow or sound."""
        result = self._run(['/usr/sbin/screencapture', '-x', '-o', '-t', 'png', '-l', str(window_id), path], 20)
        if result.returncode != 0:
            raise OSError('screencapture failed')

    def shrink_png(self, path: str, max_pixels: int) -> None:
        """Downscale a PNG in place so its longer side is at most `max_pixels`."""
        self._run(['/usr/bin/sips', '-Z', str(max_pixels), path], 20)

    def tcp_probe(self, host: str, port: int, timeout: float) -> bool:
        """Whether a TCP connection to `host:port` succeeds within `timeout`."""
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return True
        except OSError:
            return False

    def run_command(self, argv: list[str], timeout: float, env: dict | None = None) -> int:
        """Run a short command (for example lark-cli) and return its exit code; output is discarded."""
        return self._run(argv, timeout, env).returncode


TERM = signal.SIGTERM
KILL = signal.SIGKILL
