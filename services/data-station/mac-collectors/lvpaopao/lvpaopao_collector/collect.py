"""One collection link (lock → cleanup → prepare → helper → re-entry → ready) and the resumable rankings/engagement jobs."""
from __future__ import annotations

from pathlib import Path
import threading

from .errors import GENERATION, HUMAN, TRANSIENT, CollectError
from .helper import HelperSession, ProcessRecords, prepare
from .util import FileLock, iso

HELPER_PORT = 9421


class Link:
    """A helper connection that survives generation changes inside one run.

    `call()` rotates the helper before the per-run id limit or its lifetime ends, spaces calls by the configured minimum
    interval, retries transient failures on the same generation and raises everything else for the run's retry ladder.
    """

    def __init__(self, config, mac, guardian, records: ProcessRecords, clock, stop: threading.Event, sleep_check, log):
        self.config = config
        self.mac = mac
        self.guardian = guardian
        self.records = records
        self.clock = clock
        self.stop = stop
        self.sleep_check = sleep_check
        self.log = log
        self.lock = FileLock(Path(config['lockFile']))
        self.session: HelperSession | None = None
        self.last_call = 0.0
        self.calls = 0

    def __enter__(self) -> 'Link':
        self._acquire_lock()
        return self

    def __exit__(self, *_exc) -> None:
        self.close()
        self.lock.release()

    def _acquire_lock(self) -> None:
        deadline = self.clock.wall() + self.config['helper']['lockWaitSeconds']
        while not self.lock.acquire():
            if self.clock.wall() >= deadline:
                raise CollectError('helper-error', GENERATION, 'helper-busy', 'Muse 正在使用绿泡泡连接（锁被占用）')
            if self.clock.sleep(5, self.stop):
                raise CollectError('cancelled', GENERATION, 'cancelled', '采集端正在停止')

    def close(self) -> None:
        """Close the current generation and confirm cleanup (an unclean close is logged; leftovers are cleaned next time)."""
        if self.session is None:
            return
        session, self.session = self.session, None
        if not session.close():
            self.log('warn', 'helper close was not confirmed clean')

    def open(self) -> None:
        """Start a fresh generation and bring the mini-program under control."""
        self.close()
        killed = self.records.cleanup()
        if killed:
            self.log('warn', f'cleaned up leftover processes {killed}')
        if self.mac.listeners(HELPER_PORT):
            raise CollectError('helper-error', GENERATION, 'helper-busy', f'127.0.0.1:{HELPER_PORT} 被其他程序占用')
        try:
            prepared = prepare(self.config, self.records, self.stop)
        except CollectError as error:
            if error.code != 'mac-isolated-wechat-required' or not self.guardian.running():
                raise
            # WeChatAppEx may only start once a mini-program is opened (unverified): open 绿泡泡 and prepare again.
            self.log('info', 'WeChatAppEx not running; opening the mini-program before preparing again')
            self.guardian.run_steps(self.config['reentry']['strategies'][-1]['steps'], self.stop)
            prepared = prepare(self.config, self.records, self.stop)
        session = HelperSession(self.config, prepared, self.records, self.config.home / 'logs' / 'helper-stderr.log')
        self.session = session
        session.start()
        self._reenter()

    def _ready(self) -> bool:
        return self.session.ready(self.stop)

    def _wait_ready(self, seconds: float) -> bool:
        deadline = self.clock.wall() + seconds
        while self.clock.wall() < deadline:
            if self.clock.sleep(self.config['reentry']['statusPollSeconds'], self.stop):
                raise CollectError('cancelled', GENERATION, 'cancelled', '采集端正在停止')
            if self._ready():
                return True
        return False

    def _reenter(self) -> None:
        if self._ready():
            return
        for strategy in self.config['reentry']['strategies']:
            ok, detail = self.guardian.run_steps(strategy['steps'], self.stop)
            if self.stop.is_set():
                raise CollectError('cancelled', GENERATION, 'cancelled', '采集端正在停止')
            if ok and self._wait_ready(self.config['helper']['readyTimeoutSeconds']):
                self.log('info', f'mini-program re-entered via {strategy["name"]}')
                return
            self.log('warn', f'reentry strategy {strategy["name"]} failed: {detail or "not ready"}')
        if self.guardian.refresh_login().kind in ('qr', 'confirm'):
            raise CollectError('wechat-logged-out', HUMAN, 'logged-out', '隔离微信停在登录界面，需要扫码')
        raise CollectError('reentry-failed', GENERATION, 'reentry-failed', '无法自动重新进入绿泡泡小程序')

    def call(self, method: str, params: dict):
        """Run one read-only operation; returns the helper's public result (business status included)."""
        self.sleep_check()
        helper = self.config['helper']
        if self.session is None or self.session.failed is not None or self.session.requests >= helper['requestsPerGeneration'] \
                or self.session.age >= helper['lifetimeMs'] / 1000 - 120:
            self.open()
        retries = self.config['schedule']['callRetries']
        for attempt in range(retries + 1):
            wait = self.config['schedule']['minCallIntervalSeconds'] - (self.clock.wall() - self.last_call)
            if wait > 0 and self.clock.sleep(wait, self.stop):
                raise CollectError('cancelled', GENERATION, 'cancelled', '采集端正在停止')
            self.last_call = self.clock.wall()
            self.calls += 1
            try:
                value = self.session.call(method, params, stop=self.stop)
            except CollectError as error:
                if error.kind != TRANSIENT or attempt == retries:
                    raise
                self.clock.sleep(2 * (attempt + 1), self.stop)
                continue
            self.sleep_check()
            if isinstance(value, dict) and value.get('status') == 'native-call-timeout' and attempt < retries:
                continue
            return value
        raise CollectError('helper-error', GENERATION, 'retries-exhausted', '请求多次重试失败')


def _title(value, fallback: str) -> str:
    text = value.strip()[:160] if isinstance(value, str) else ''
    return text or fallback


class RankingsJob:
    """Reads every board (starting with `firstBoardType`, then the boards the service lists) page by page.

    A board interrupted by a generation failure is re-read from scratch on the next attempt with a new `coldStartTime`.
    """

    def __init__(self, config, clock, pages: int | None = None, page_size: int | None = None, budget=None):
        self.config = config
        self.clock = clock
        self.pages = pages or config['rankings']['pages']
        self.page_size = page_size or config['rankings']['pageSize']
        self.budget = budget
        self.queue = [config['rankings']['firstBoardType']]
        self.names: dict[int, str] = {}
        self.boards: dict[int, dict] = {}
        self.problem: str | None = None

    @property
    def has_data(self) -> bool:
        """Whether at least one board has entries."""
        return any(board['entries'] for board in self.boards.values())

    def run(self, link: Link) -> None:
        """Read all remaining boards."""
        index = 0
        while index < len(self.queue) and index < self.config['rankings']['maxBoards']:
            board_type = self.queue[index]
            index += 1
            if board_type not in self.boards:
                self._read_board(link, board_type)

    def _read_board(self, link: Link, board_type: int) -> None:
        cold = int(self.clock.wall())
        board = {'boardType': board_type, 'observedAt': iso(self.clock.wall(), self.config.tz), 'total': None, 'pagesRead': 0, 'partial': False, 'entries': []}
        seen: set[int] = set()
        for page in range(self.pages):
            if self.budget is not None and not self.budget.take():
                board['partial'] = True
                self.problem = 'budget-exhausted'
                break
            value = link.call('rankings', {'boardType': board_type, 'pageIndex': page, 'count': self.page_size, 'coldStartTime': cold})
            for item in (value.get('boards') or []) if isinstance(value, dict) else []:
                if isinstance(item, dict) and isinstance(item.get('type'), int) and item['type'] not in self.queue:
                    self.queue.append(item['type'])
                if isinstance(item, dict) and isinstance(item.get('type'), int) and isinstance(item.get('name'), str):
                    self.names[item['type']] = item['name']
            if not isinstance(value, dict) or value.get('status') != 'rankings-returned':
                board['partial'] = True
                self.problem = 'business-error'
                break
            board['pagesRead'] += 1
            board['total'] = value.get('total')
            board['partial'] = board['partial'] or bool(value.get('partial'))
            for entry in value.get('entries') or []:
                if entry['rank'] in seen:
                    continue
                seen.add(entry['rank'])
                board['entries'].append({'rank': entry['rank'], 'title': _title(entry.get('title'), entry['originDramaId']),
                                         'srcAppId': entry['srcAppId'], 'dramaId': entry['originDramaId']})
            if not value.get('hasMore'):
                break
        self.boards[board_type] = board

    def result(self) -> list[dict]:
        """Boards in the station's run format."""
        out = []
        for board_type in self.queue:
            board = self.boards.get(board_type)
            if board is None:
                continue
            name = _title(self.names.get(board_type), f'榜单 {board_type}')[:80]
            out.append({**board, 'boardName': name})
        return out[:50]


class Budget:
    """Daily call budget for engagement runs, persisted by the scheduler state."""

    def __init__(self, state: dict, limit: int, today: str):
        if state.get('date') != today:
            state.clear()
            state.update({'date': today, 'used': 0})
        self.state = state
        self.limit = limit

    def take(self) -> bool:
        """Consume one call; `False` when today's budget is used up."""
        if self.state['used'] >= self.limit:
            return False
        self.state['used'] += 1
        return True


class EngagementJob:
    """Per-episode interaction counts for the watch list, then the top N of every board in rank order, within the daily budget."""

    def __init__(self, config, clock, budget: Budget, snapshot: dict | None):
        self.config = config
        self.clock = clock
        self.budget = budget
        self.snapshot = snapshot
        self.targets: list[dict] | None = None
        self.dramas: dict[tuple, dict] = {}
        self.problem: str | None = None
        self.exhausted = False

    @property
    def has_data(self) -> bool:
        """Whether any drama has at least one episode read."""
        return any(drama['episodes'] for drama in self.dramas.values())

    def _targets(self, link: Link) -> list[dict]:
        targets = [dict(item) for item in self.config['engagement']['watchlist']]
        boards = (self.snapshot or {}).get('boards')
        top = self.config['engagement']['topPerBoard']
        if boards is None and top:
            job = RankingsJob(self.config, self.clock, pages=1, page_size=top, budget=self.budget)
            job.run(link)
            boards = [{'boardType': board['boardType'], 'entries': board['entries']} for board in job.result()]
        for rank in range(1, top + 1):
            for board in boards or []:
                for entry in board['entries']:
                    if entry['rank'] == rank:
                        targets.append({'srcAppId': entry['srcAppId'], 'dramaId': entry['dramaId'], 'title': entry['title']})
        unique, seen = [], set()
        for item in targets:
            key = (item['srcAppId'], item['dramaId'])
            if key not in seen:
                seen.add(key)
                unique.append(item)
        return unique[:200]

    def run(self, link: Link) -> None:
        """Read remaining dramas and episodes until done or the budget is exhausted."""
        if self.targets is None:
            self.targets = self._targets(link)
        for target in self.targets:
            if self.exhausted:
                return
            key = (target['srcAppId'], target['dramaId'])
            drama = self.dramas.setdefault(key, {'srcAppId': key[0], 'dramaId': key[1], 'title': target['title'], 'observedAt': None,
                                                 'episodeCount': None, 'detail': False, 'failed': set(), 'episodes': {}})
            if not drama['detail']:
                if not self._take():
                    return
                value = link.call('detail', {'srcAppId': key[0], 'dramaId': key[1]})
                if not isinstance(value, dict) or value.get('status') != 'detail-returned':
                    self.problem = 'business-error'
                    drama['detail'] = True
                    continue
                drama.update(detail=True, episodeCount=value.get('episodeCount'), title=_title(value.get('title'), target['title']),
                             observedAt=iso(self.clock.wall(), self.config.tz))
            for number in range(1, min(drama['episodeCount'] or 0, 10000) + 1):
                if number in drama['episodes'] or number in drama['failed']:
                    continue
                if not self._take():
                    return
                value = link.call('engagement', {'srcAppId': key[0], 'dramaId': key[1], 'episodeNo': number})
                status = value.get('status') if isinstance(value, dict) else None
                if status in ('engagement-returned', 'engagement-unavailable'):
                    counts = value.get('counts') or {}
                    drama['episodes'][number] = {'episodeNo': number, **{name: counts.get(name) for name in ('likes', 'comments', 'recommendations', 'shares')}}
                else:
                    drama['failed'].add(number)
                    self.problem = 'business-error'

    def _take(self) -> bool:
        if self.budget.take():
            return True
        self.exhausted = True
        self.problem = 'budget-exhausted'
        return False

    def result(self) -> list[dict]:
        """Dramas in the station's run format; dramas never read are left out."""
        out = []
        for drama in self.dramas.values():
            if not drama['episodes'] and drama['episodeCount'] is None:
                continue
            count = drama['episodeCount']
            missing = [n for n in range(1, min(count or 0, 10000) + 1) if n not in drama['episodes']]
            out.append({'srcAppId': drama['srcAppId'], 'dramaId': drama['dramaId'], 'title': drama['title'],
                        'observedAt': drama['observedAt'] or iso(self.clock.wall(), self.config.tz), 'episodeCount': count,
                        'partial': bool(missing) or count is None, 'missingEpisodes': missing,
                        'episodes': [drama['episodes'][n] for n in sorted(drama['episodes'])]})
        return out[:200]


def wait_until(clock, stop: threading.Event, predicate, seconds: float, step: float = 5) -> bool:
    """Poll `predicate` until true or `seconds` elapse; returns its last value (stop-aware)."""
    deadline = clock.wall() + seconds
    while True:
        if predicate():
            return True
        if clock.wall() >= deadline or clock.sleep(step, stop):
            return False
