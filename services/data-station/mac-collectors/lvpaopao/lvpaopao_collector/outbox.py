"""Durable outbox of finished runs (atomic files, upload in order) and the uploader that also sends heartbeats and runs commands."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import threading

from .util import iso, read_json, write_atomic, write_json

STATION_WIDE = (401, 403, 404)
"""Token or configuration problems: keep the backlog and retry later instead of rejecting the file."""
COMMAND_ID = re.compile(r'^c-[0-9a-f-]{36}$')


class Outbox:
    """Run files under `pending/` named `<ms>-<runId>.json`; rejected files move to `rejected/` with a reason file."""

    def __init__(self, root: Path, config, clock, log):
        self.pending_dir = root / 'pending'
        self.rejected_dir = root / 'rejected'
        self.config = config
        self.clock = clock
        self.log = log
        self._lock = threading.Lock()
        for directory in (self.pending_dir, self.rejected_dir):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def add(self, run: dict) -> Path:
        """Persist a finished run atomically (tmp + fsync + rename) and apply the size and age caps."""
        with self._lock:
            path = self.pending_dir / f'{int(self.clock.wall() * 1000):013d}-{run["runId"]}.json'
            write_atomic(path, json.dumps(run, ensure_ascii=False, separators=(',', ':')).encode('utf8'))
            self._enforce_caps()
        return path

    def pending(self) -> list[Path]:
        """Pending run files, oldest first (temporary files are ignored)."""
        return sorted(path for path in self.pending_dir.glob('*.json') if not path.name.startswith('.'))

    def reject(self, path: Path, status: int, body: dict | None) -> None:
        """Move a permanently refused file aside and record why."""
        with self._lock:
            target = self.rejected_dir / path.name
            os.replace(path, target)
            write_json(target.with_suffix('.reason.json'), {'status': status, 'error': (body or {}).get('error'), 'at': self.clock.wall()})
        self.log('error', f'station rejected {path.name} with HTTP {status}')

    def _enforce_caps(self) -> None:
        files = self.pending()
        cutoff_ms = (self.clock.wall() - self.config['outbox']['maxAgeDays'] * 86400) * 1000
        for path in list(files):
            if int(path.name.split('-', 1)[0]) < cutoff_ms:
                path.unlink(missing_ok=True)
                files.remove(path)
                self.log('warn', f'dropped expired outbox file {path.name}')
        sizes = {path: path.stat().st_size for path in files}
        total = sum(sizes.values())
        for path in files:
            if total <= self.config['outbox']['maxBytes']:
                break
            total -= sizes[path]
            path.unlink(missing_ok=True)
            self.log('warn', f'dropped outbox file {path.name}: outbox over size cap')


class Uploader:
    """Uploads the outbox in order with exponential backoff, sends heartbeats, executes and acknowledges commands, and
    raises a Mac-side Feishu alert (lark-cli) when the station has been unreachable for too long."""

    def __init__(self, config, outbox: Outbox, station, clock, status, dispatch, alerter, log):
        self.config = config
        self.outbox = outbox
        self.station = station
        self.clock = clock
        self.status = status
        self.dispatch = dispatch
        self.alerter = alerter
        self.log = log
        self.started = clock.wall()
        self.next_upload = 0.0
        self.failures = 0
        self.last_heartbeat: float | None = None
        self.executed: dict[str, tuple[str, str]] = {}
        self.station_problem: str | None = None
        self.alerted = False

    def tick(self) -> None:
        """One pass: upload due files, heartbeat when due, alert on long outages."""
        now = self.clock.wall()
        if now >= self.next_upload:
            self.flush()
        interval = self.config['station']['loginHeartbeatSeconds'] if self.status()['state'] == 'waiting-login' else self.config['station']['heartbeatSeconds']
        if self.last_heartbeat is None or now - self.last_heartbeat >= interval:
            self.heartbeat()
        self._alert(now)

    def _backoff(self) -> None:
        low, high = self.config['outbox']['backoffSeconds'][0], self.config['outbox']['backoffSeconds'][-1]
        self.failures += 1
        self.next_upload = self.clock.wall() + min(high, low * 2 ** (self.failures - 1))

    def flush(self) -> int:
        """Upload pending runs oldest first; returns how many were accepted."""
        sent = 0
        for path in self.outbox.pending():
            run = read_json(path, limit=4 << 20)
            if run is None:
                self.outbox.reject(path, 0, {'error': 'unreadable local file'})
                continue
            response = self.station.post_run(run)
            if response.ok:
                path.unlink(missing_ok=True)
                sent += 1
                self.failures = 0
                self.station_problem = None
                continue
            if response.retryable:
                self.station_problem = None if response.status == 0 else f'数据站返回 {response.status}'
                self._backoff()
                return sent
            if response.status in STATION_WIDE:
                self.station_problem = f'数据站拒绝令牌或未配置（HTTP {response.status}）'
                self._backoff()
                return sent
            self.outbox.reject(path, response.status, response.body)
        self.next_upload = 0.0
        return sent

    def heartbeat(self) -> None:
        """Send the heartbeat and run the returned commands (each executed once, acked until the station confirms)."""
        payload = dict(self.status())
        payload['pendingUploads'] = len(self.outbox.pending())
        if self.station_problem and payload['state'] == 'ok':
            payload['message'] = self.station_problem[:300]
        response = self.station.heartbeat(payload)
        self.last_heartbeat = self.clock.wall()
        if not response.ok or not isinstance(response.body, dict):
            return
        for command in response.body.get('commands') or []:
            if not isinstance(command, dict) or not COMMAND_ID.match(str(command.get('id'))):
                continue
            identifier = command['id']
            if identifier not in self.executed:
                self.executed[identifier] = self.dispatch(command.get('action'))
                self.log('info', f'command {command.get("action")} {identifier}: {self.executed[identifier]}')
            result, message = self.executed[identifier]
            if self.station.ack(identifier, result, message).ok:
                self.executed[identifier] = ('acked', '')
        if len(self.executed) > 200:
            for key in list(self.executed)[:100]:
                del self.executed[key]

    def _alert(self, now: float) -> None:
        limit = self.config['alert']['unreachableHours'] * 3600
        reference = self.station.last_contact or self.started
        if not self.alerted and now - reference >= limit:
            text = (f'【绿泡泡采集】Mac 已超过 {self.config["alert"]["unreachableHours"]} 小时连不上数据站，'
                    f'本地待上传 {len(self.outbox.pending())} 条，最后联系 {iso(reference, self.config.tz)}')
            self.alerted = self.alerter.send(text)
        elif self.alerted and self.station.last_contact and now - self.station.last_contact < limit:
            self.alerter.send('【绿泡泡采集】Mac 已重新连上数据站，积压数据正在补传')
            self.alerted = False
