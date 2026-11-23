"""Slot scheduler and run state machine.

Per slot: run → on failure retry at 1/2/4 min → restart WeChat and retry once → needs-human state (probe every 15 min).
Sleep is detected by comparing wall-clock and uptime deltas; slots missed while asleep, offline or stopped are uploaded as
`failed` runs (gaps), except the most recent one, which is caught up once after the network has been stable for 60 s.
"""
from __future__ import annotations

from collections import deque
import datetime as dt
import secrets
import threading

from . import VERSION
from .collect import Budget, EngagementJob, Link, RankingsJob, wait_until
from .errors import FATAL, GENERATION, HUMAN, CollectError
from .util import iso, read_json, write_json

KINDS = ('rankings', 'engagement')
HUMAN_STATES = {'wechat-logged-out': 'waiting-login', 'reentry-failed': 'reentry-failed', 'build-changed': 'build-changed'}


class SleepMonitor:
    """Detects sleep: wall time advancing much more than uptime (which stops while the Mac sleeps)."""

    def __init__(self, clock, threshold: float):
        self.clock = clock
        self.threshold = threshold
        self.last = (clock.wall(), clock.uptime())
        self.gaps: deque = deque(maxlen=50)

    def check(self) -> tuple[float, float] | None:
        """Return the `(from, to)` wall interval of a sleep since the previous check, if any."""
        wall, up = self.clock.wall(), self.clock.uptime()
        gap = (wall - self.last[0]) - (up - self.last[1])
        start = self.last[0]
        self.last = (wall, up)
        if gap > self.threshold:
            self.gaps.append((start, wall))
            return start, wall
        return None


def slots_between(times: list[str], start: float, end: float, tz) -> list[float]:
    """Slot timestamps in `(start, end]` for daily `HH:MM` times in `tz`."""
    out = []
    day = dt.datetime.fromtimestamp(start, tz).date()
    last = dt.datetime.fromtimestamp(end, tz).date()
    while day <= last:
        for text in times:
            hour, minute = map(int, text.split(':'))
            moment = dt.datetime(day.year, day.month, day.day, hour, minute, tzinfo=tz).timestamp()
            if start < moment <= end:
                out.append(moment)
        day += dt.timedelta(days=1)
    return sorted(out)


class Scheduler:
    """Owns the scheduling state and executes runs on the main thread. `tick()` is called every `tickSeconds`."""

    def __init__(self, config, mac, clock, guardian, outbox, records, stop: threading.Event, log):
        self.config = config
        self.mac = mac
        self.clock = clock
        self.guardian = guardian
        self.outbox = outbox
        self.records = records
        self.stop = stop
        self.log = log
        self.tz = config.tz
        self.path = config.home / 'state' / 'scheduler.json'
        self.state = read_json(self.path) or {}
        now = clock.wall()
        self.state.setdefault('lastHandled', {kind: now for kind in KINDS})
        self.state.setdefault('budget', {})
        self.state.setdefault('gaps', [])
        if 'lastAlive' in self.state and now - self.state['lastAlive'] > config['schedule']['sleepGapSeconds']:
            self.state['gaps'].append([self.state['lastAlive'], now, 'down'])
        self.sleep = SleepMonitor(clock, config['schedule']['sleepGapSeconds'])
        self.net_up_since: float | None = None
        self.net_checked = 0.0
        self.phase = 'idle'
        self.human: dict | None = self.state.get('human')
        self.queue: deque = deque()
        self.save()

    # -- persistence and status ------------------------------------------------------------------------------------
    def save(self) -> None:
        self.state['lastAlive'] = self.clock.wall()
        self.state['human'] = self.human
        self.state['gaps'] = self.state['gaps'][-50:]
        write_json(self.path, self.state)

    def next_slot(self) -> float | None:
        """The next scheduled slot of any kind."""
        now = self.clock.wall()
        upcoming = [slot for kind in KINDS for slot in slots_between(self.config[kind]['times'], now, now + 2 * 86400, self.tz)[:1]]
        return min(upcoming) if upcoming else None

    def status(self) -> dict:
        """Heartbeat fields (without `pendingUploads`), derived from guardian, human state, phase and network."""
        message = ''
        if self.guardian.blocked:
            state, message = 'error', {'forbidden-original-data': '隔离微信访问了主微信数据目录，已停止；排查后重启采集端',
                                       'wechat-app-missing': '找不到隔离微信副本', 'wechat-env-invalid': '运行中的隔离微信没有使用私有目录'}.get(self.guardian.blocked, self.guardian.blocked)
        elif self.human:
            state, message = self.human['state'], self.human['message']
        elif self.guardian.login.kind in ('qr', 'confirm'):
            state, message = 'waiting-login', '隔离微信停在登录界面，请在数据站扫码'
        elif self.phase in ('collecting', 'recovering'):
            state, message = self.phase, '正在采集' if self.phase == 'collecting' else '正在重试或重启微信'
        elif self.net_up_since is None and self.net_checked:
            state, message = 'offline-network', 'Mac 没有网络，恢复后补发'
        else:
            state = 'ok'
        upcoming = self.next_slot()
        if state == 'ok':
            message = '已就绪' + (f'，下一次 {dt.datetime.fromtimestamp(upcoming, self.tz):%H:%M}' if upcoming else '')
        return {'schema': 1, 'sentAt': iso(self.clock.wall(), self.tz), 'state': state, 'message': message[:300],
                'wechat': {'running': self.guardian.running(), 'loggedIn': self.guardian.login.logged_in},
                'lastRun': self.state.get('lastRun'), 'nextSlot': iso(upcoming, self.tz) if upcoming else None,
                'collector': {'version': VERSION, 'host': self.config['host']}}

    # -- commands --------------------------------------------------------------------------------------------------
    def dispatch(self, action: str) -> tuple[str, str]:
        """Execute a station command (called from the uploader thread)."""
        if action == 'start-login':
            ok, message = self.guardian.start_login()
            return ('done' if ok else 'failed'), message
        if action == 'collect-now':
            self.queue.append('rankings')
            return 'done', '已排队，马上采集榜单'
        return 'failed', f'不支持的指令 {action}'

    # -- environment checks ----------------------------------------------------------------------------------------
    def check_network(self) -> bool:
        """Probe the network and track how long it has been up."""
        now = self.clock.wall()
        self.net_checked = now
        timeout = self.config['network']['probeTimeoutSeconds']
        up = any(self.mac.tcp_probe(host, port, timeout) for host, port in self.config['network']['probeHosts'])
        if not up:
            self.net_up_since = None
        elif self.net_up_since is None:
            self.net_up_since = now
        return up

    def network_stable(self) -> bool:
        """Network has been up for `networkStableSeconds`."""
        return self.net_up_since is not None and self.clock.wall() - self.net_up_since >= self.config['schedule']['networkStableSeconds']

    def _sleep_check(self) -> None:
        gap = self.sleep.check()
        if gap is not None:
            self.state['gaps'].append([gap[0], gap[1], 'sleep'])
            self.log('warn', f'Mac slept {int(gap[1] - gap[0])} s')
            raise CollectError('mac-asleep', GENERATION, 'slept', 'Mac 刚从睡眠中醒来')

    # -- main tick -------------------------------------------------------------------------------------------------
    def tick(self) -> None:
        """Detect sleep, run queued commands, probe in the needs-human state, and run or record due slots."""
        gap = self.sleep.check()
        if gap is not None:
            self.state['gaps'].append([gap[0], gap[1], 'sleep'])
            self.log('warn', f'Mac slept {int(gap[1] - gap[0])} s; dropping any leftover helper')
            self.records.cleanup()
            self.net_up_since = None  # the network must prove itself stable again after waking
        self.check_network()
        self.save()
        if self.queue:
            self.queue.popleft()
            slot = self.clock.wall() // 60 * 60
            self.run('rankings', slot, forced=True)
            return
        if self.human and self.clock.wall() >= self.human['nextProbe']:
            self.probe()
        for kind in KINDS:
            if self.stop.is_set():
                return
            self._due(kind)

    def _due(self, kind: str) -> None:
        now = self.clock.wall()
        due = slots_between(self.config[kind]['times'], self.state['lastHandled'][kind], now, self.tz)
        if not due:
            return
        for slot in due[:-1]:
            self._record_missed(kind, slot)
        latest = due[-1]
        on_time = now - latest <= self.config['schedule']['graceMinutes'] * 60
        if self.human or self.guardian.blocked:
            return  # the latest slot stays pending: caught up after recovery or recorded as a gap once superseded
        if on_time or self.network_stable():
            self.run(kind, latest, catch_up=not on_time)

    def _missed_reason(self, slot: float) -> tuple[str, str]:
        for start, end, cause in self.state['gaps']:
            if start <= slot <= end:
                return 'mac-asleep', 'Mac 处于睡眠' if cause == 'sleep' else '采集端未运行（Mac 关机、重启或采集端停止）'
        if self.human:
            return self.human['reason'], self.human['message']
        if self.guardian.blocked:
            return 'wechat-not-running', '隔离微信被停止'
        return 'network', '错过时段时网络不可用'

    def _record_missed(self, kind: str, slot: float) -> None:
        reason, message = self._missed_reason(slot)
        now = self.clock.wall()
        self._emit(kind, slot, now, now, 'failed', reason, [], [])
        self.state['lastHandled'][kind] = max(self.state['lastHandled'][kind], slot)
        self.log('info', f'{kind} slot {iso(slot, self.tz)} missed: {reason} ({message})')
        self.save()

    def _emit(self, kind: str, slot: float, started: float, finished: float, status: str, reason: str | None,
              rankings: list, engagement: list) -> str:
        stamp = dt.datetime.fromtimestamp(slot, self.tz).strftime('%Y%m%dT%H%M%z')
        run_id = f'{stamp}-{kind}-{secrets.token_hex(4)}'
        run = {'schema': 1, 'runId': run_id, 'kind': kind, 'slot': iso(slot, self.tz), 'startedAt': iso(started, self.tz),
               'finishedAt': iso(finished, self.tz), 'status': status, 'reason': reason,
               'collector': {'version': VERSION, 'host': self.config['host']}, 'rankings': rankings, 'engagement': engagement}
        self.outbox.add(run)
        self.state['lastRun'] = {'runId': run_id, 'kind': kind, 'status': status, 'finishedAt': run['finishedAt']}
        return run_id

    # -- runs ------------------------------------------------------------------------------------------------------
    def _preflight(self) -> None:
        if not self.check_network() and not wait_until(self.clock, self.stop, self.check_network, self.config['schedule']['networkWaitMaxSeconds'], 15):
            raise CollectError('network', GENERATION, 'network-down', 'Mac 没有网络')
        if self.guardian.blocked:
            raise CollectError('wechat-not-running', HUMAN, self.guardian.blocked, '隔离微信被守护进程停止')
        if not wait_until(self.clock, self.stop, self.guardian.running, 90, 5):
            raise CollectError('wechat-not-running', GENERATION, 'wechat-not-running', '隔离微信未运行')
        if self.guardian.refresh_login().kind in ('qr', 'confirm'):
            raise CollectError('wechat-logged-out', HUMAN, 'logged-out', '隔离微信停在登录界面，请在数据站扫码')

    def _attempt(self, job) -> None:
        self._preflight()
        with Link(self.config, self.mac, self.guardian, self.records, self.clock, self.stop, self._sleep_check, self.log) as link:
            job.run(link)

    def run(self, kind: str, slot: float, catch_up: bool = False, forced: bool = False) -> None:
        """Run one slot through the retry ladder and queue its result for upload."""
        started = self.clock.wall()
        deadline = started + self.config['schedule']['runDeadlineMinutes'][kind] * 60
        if kind == 'rankings':
            job = RankingsJob(self.config, self.clock)
        else:
            today = dt.datetime.fromtimestamp(started, self.tz).date().isoformat()
            snapshot = read_json(self.config.home / 'state' / 'rankings-latest.json')
            job = EngagementJob(self.config, self.clock, Budget(self.state['budget'], self.config['engagement']['dailyCallBudget'], today),
                                snapshot if snapshot and snapshot.get('date') == today else None)
        self.log('info', f'{kind} run for {iso(slot, self.tz)} starts' + (' (catch-up)' if catch_up else ''))
        final: CollectError | None = None
        delays = self.config['schedule']['retryDelaysSeconds']
        failures, restarted = 0, False
        self.phase = 'collecting'
        try:
            while True:
                try:
                    self._attempt(job)
                    final = None
                    break
                except CollectError as error:
                    final = error
                    self.log('warn', f'{kind} attempt failed: {error.reason}/{error.code}: {error.message}')
                    if self.stop.is_set() or error.reason == 'cancelled':
                        final = CollectError('cancelled', GENERATION, 'cancelled', '采集端停止，本次采集中断')
                        break
                    if error.kind in (HUMAN, FATAL) or getattr(job, 'exhausted', False):
                        break
                    if self.clock.wall() >= deadline:
                        break
                    failures += 1
                    self.phase = 'recovering'
                    if failures <= len(delays):
                        if self.clock.sleep(delays[failures - 1], self.stop):
                            final = CollectError('cancelled', GENERATION, 'cancelled', '采集端停止，本次采集中断')
                            break
                    elif not restarted:
                        restarted = True
                        self.guardian.restart()
                    else:
                        break
        finally:
            self.phase = 'idle'
        reason = final.reason if final else job.problem
        has_data = job.has_data
        status = 'failed' if not has_data else 'partial' if reason else 'complete'
        if status == 'complete':
            reason = None
        elif reason is None:
            reason = 'helper-error'
        rankings = job.result() if kind == 'rankings' else []
        engagement = job.result() if kind == 'engagement' else []
        self._emit(kind, slot, started, self.clock.wall(), status, reason, rankings, engagement)
        if kind == 'rankings' and has_data:
            write_json(self.config.home / 'state' / 'rankings-latest.json',
                       {'date': dt.datetime.fromtimestamp(slot, self.tz).date().isoformat(),
                        'boards': [{'boardType': board['boardType'], 'entries': board['entries'][:self.config['engagement']['topPerBoard']]} for board in rankings]})
        cancelled = final is not None and final.reason == 'cancelled'
        if not cancelled and not forced:
            self.state['lastHandled'][kind] = max(self.state['lastHandled'][kind], slot)
        if final is not None and not cancelled and (final.kind in (HUMAN, FATAL) or restarted):
            self._enter_human(final)
        elif final is None:
            self.human = None
        self.save()
        self.log('info', f'{kind} run finished: {status} {reason or ""}')

    def _enter_human(self, error: CollectError) -> None:
        self.human = {'state': HUMAN_STATES.get(error.reason, 'error'), 'reason': error.reason, 'message': error.message[:300],
                      'since': self.clock.wall(), 'nextProbe': self.clock.wall() + self.config['schedule']['humanProbeSeconds']}
        self.log('error', f'needs a human: {error.reason}: {error.message}')

    def probe(self) -> bool:
        """In the needs-human state: try prepare + re-entry + status without collecting; leaves the state on success."""
        self.human['nextProbe'] = self.clock.wall() + self.config['schedule']['humanProbeSeconds']
        try:
            self._preflight()
            with Link(self.config, self.mac, self.guardian, self.records, self.clock, self.stop, self._sleep_check, self.log) as link:
                link.open()
        except CollectError as error:
            self.human.update(message=error.message[:300])
            if error.reason in HUMAN_STATES:
                self.human.update(state=HUMAN_STATES[error.reason], reason=error.reason)
            self.log('info', f'probe failed: {error.reason}/{error.code}')
            self.save()
            return False
        self.log('info', 'probe succeeded; leaving the needs-human state')
        self.human = None
        self.save()
        return True
