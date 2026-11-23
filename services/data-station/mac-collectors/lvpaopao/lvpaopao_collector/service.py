"""Wires the guardian, scheduler and uploader into one long-running process (launchd `cn.muse.lvpaopao.collector`)."""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import sys
import threading

from .alert import Alerter
from .config import read_token
from .helper import ProcessRecords
from .outbox import Outbox, Uploader
from .scheduler import Scheduler
from .station import Station
from .util import Clock, iso
from .wechat import Guardian


class Log:
    """JSON-lines log with a size cap (one rotated generation). Tokens never reach it."""

    def __init__(self, path: Path, clock, tz, echo: bool = False, max_bytes: int = 10 << 20):
        self.path = path
        self.clock = clock
        self.tz = tz
        self.echo = echo
        self.max_bytes = max_bytes
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    def __call__(self, level: str, message: str) -> None:
        line = json.dumps({'at': iso(self.clock.wall(), self.tz), 'level': level, 'thread': threading.current_thread().name, 'message': message}, ensure_ascii=False)
        with self._lock:
            try:
                if self.path.exists() and self.path.stat().st_size > self.max_bytes:
                    os.replace(self.path, self.path.with_suffix('.log.1'))
                with open(self.path, 'a', encoding='utf8') as stream:
                    stream.write(line + '\n')
            except OSError:
                pass
            if self.echo:
                print(line, file=sys.stderr, flush=True)


class Service:
    """The collector process: three threads sharing one stop event."""

    def __init__(self, config, mac, clock=None, token: str | None = None, echo: bool = False):
        self.config = config
        self.mac = mac
        self.clock = clock or Clock()
        self.stop = threading.Event()
        home = config.home
        for name in ('state', 'logs', 'outbox'):
            (home / name).mkdir(parents=True, exist_ok=True, mode=0o700)
        self.log = Log(home / 'logs' / 'collector.log', self.clock, config.tz, echo)
        self.station = Station(config, token if token is not None else read_token(config), self.clock)
        self.records = ProcessRecords(home / 'state' / 'processes.json', mac)
        self.guardian = Guardian(config, mac, self.clock, self.station, self.log)
        self.outbox = Outbox(home / 'outbox', config, self.clock, self.log)
        self.scheduler = Scheduler(config, mac, self.clock, self.guardian, self.outbox, self.records, self.stop, self.log)
        self.uploader = Uploader(config, self.outbox, self.station, self.clock, self.scheduler.status, self.scheduler.dispatch,
                                 Alerter(config, mac, self.log), self.log)

    def _loop(self, name: str, tick, interval: float) -> None:
        while not self.stop.is_set():
            try:
                tick()
            except Exception as error:  # a bug in one pass must not kill the thread; it is logged and retried next pass
                self.log('error', f'{name} pass failed: {type(error).__name__}: {error}')
            if self.clock.sleep(interval, self.stop):
                break

    def run(self) -> int:
        """Run until SIGTERM/SIGINT; the current helper call is cancelled, the helper closed and state flushed before exit."""
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: self.stop.set())
        self.log('info', 'collector starting')
        killed = self.records.cleanup()
        if killed:
            self.log('warn', f'cleaned up leftover processes from a previous run: {killed}')
        threads = [threading.Thread(target=self._loop, args=('guardian', self.guardian.tick, 2), name='guardian', daemon=True),
                   threading.Thread(target=self._loop, args=('uploader', self.uploader.tick, 5), name='uploader', daemon=True)]
        for thread in threads:
            thread.start()
        self._loop('scheduler', self.scheduler.tick, self.config['schedule']['tickSeconds'])
        for thread in threads:
            thread.join(30)
        self.scheduler.save()
        self.log('info', 'collector stopped')
        return 0
