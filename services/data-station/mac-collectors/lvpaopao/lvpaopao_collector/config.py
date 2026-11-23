"""Collector configuration: defaults merged with a JSON file, validated once at start."""
from __future__ import annotations

import copy
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import zoneinfo

APP_SUPPORT = '~/Library/Application Support/muse-lvpaopao-collector'

DEFAULTS: dict = {
    'host': 'collector-mac',
    'home': APP_SUPPORT,
    'lockFile': APP_SUPPORT + '/run/helper.lock',
    'station': {
        'baseUrl': 'https://muse.aigc-pipeline.cn/data/api/service/lvpaopao',
        'tokenFile': APP_SUPPORT + '/station-token',
        'caFile': '/etc/ssl/cert.pem',
        'timeoutSeconds': 30,
        'heartbeatSeconds': 300,
        'loginHeartbeatSeconds': 20,
    },
    'wechat': {
        'app': APP_SUPPORT + '/wechat/WeChat-Muse-Test.app',
        'restartBackoffSeconds': [30, 60, 120, 300, 600],
        'stableSeconds': 600,
        'guardSeconds': 5,
        'loginCaptureSeconds': 20,
        'loginWindowMaxWidth': 520,
        'loginMarkers': {'confirm': ['进入微信'], 'qr': ['扫码登录', '二维码', '扫一扫', '请使用微信扫一扫']},
        'loginRefreshMarkers': ['刷新', '点击刷新', '重新加载'],
    },
    'helper': {
        'python': APP_SUPPORT + '/venv/bin/python3',
        'resources': APP_SUPPORT + '/native',
        'runtimeHome': APP_SUPPORT + '/helper-runtime',
        'ffmpeg': '/opt/homebrew/bin/ffmpeg',
        'ffprobe': '/opt/homebrew/bin/ffprobe',
        'lifetimeMs': 3600000,
        'maxCallbacks': 16384,
        'prepareTimeoutSeconds': 180,
        'helloTimeoutSeconds': 30,
        'requestTimeoutSeconds': 40,
        'cancelTimeoutSeconds': 5,
        'shutdownTimeoutSeconds': 15,
        'readyTimeoutSeconds': 60,
        'requestsPerGeneration': 1000,
        'lockWaitSeconds': 600,
    },
    'reentry': {
        'statusPollSeconds': 3,
        'strategies': [
            {'name': 'capsule-menu', 'steps': [
                {'process': 'appex', 'match': {'role': 'AXButton', 'text': ['更多', '…', '···', 'More']}, 'action': 'AXPress', 'waitSeconds': 5},
                {'process': 'appex', 'match': {'text': ['重新进入小程序']}, 'action': 'AXPress', 'waitSeconds': 5},
            ]},
            {'name': 'reopen-from-list', 'steps': [
                {'process': 'appex', 'match': {'subrole': 'AXCloseButton'}, 'window': {'text': ['绿泡泡']}, 'action': 'AXPress', 'waitSeconds': 3, 'optional': True},
                {'process': 'wechat', 'match': {'text': ['小程序']}, 'action': 'AXPress', 'waitSeconds': 5},
                {'process': 'appex', 'match': {'text': ['绿泡泡']}, 'action': 'AXPress', 'waitSeconds': 10},
            ]},
        ],
    },
    'rankings': {'times': ['09:00', '12:00', '15:00', '19:00', '22:00'], 'firstBoardType': 6, 'pages': 5, 'pageSize': 20, 'maxBoards': 20},
    'engagement': {'times': ['10:00'], 'topPerBoard': 10, 'watchlist': [], 'dailyCallBudget': 1500},
    'schedule': {
        'timezone': 'Asia/Shanghai',
        'tickSeconds': 15,
        'graceMinutes': 30,
        'retryDelaysSeconds': [60, 120, 240],
        'humanProbeSeconds': 900,
        'minCallIntervalSeconds': 1.0,
        'callRetries': 2,
        'sleepGapSeconds': 60,
        'networkStableSeconds': 60,
        'networkWaitMaxSeconds': 900,
        'runDeadlineMinutes': {'rankings': 50, 'engagement': 170},
    },
    'network': {'probeHosts': [['servicewechat.com', 443], ['223.5.5.5', 53]], 'probeTimeoutSeconds': 3},
    'outbox': {'maxBytes': 524288000, 'maxAgeDays': 30, 'backoffSeconds': [30, 900]},
    'alert': {'larkCli': '~/.local/bin/lark-cli', 'chatId': None, 'userId': None, 'unreachableHours': 6},
}

_TIME = re.compile(r'^([01]\d|2[0-3]):[0-5]\d$')
_APP_ID = re.compile(r'^wx[0-9a-f]{16}$')
_DRAMA_ID = re.compile(r'^[A-Za-z0-9._:-]{1,128}$')
_PATH_KEYS = (('home',), ('lockFile',), ('station', 'tokenFile'), ('station', 'caFile'), ('wechat', 'app'), ('helper', 'python'),
              ('helper', 'resources'), ('helper', 'runtimeHome'), ('alert', 'larkCli'))


class ConfigError(ValueError):
    """The configuration is invalid; the message names the field."""


@dataclass(frozen=True)
class Config:
    """Validated configuration; `data` keeps the merged JSON tree with expanded paths."""

    data: dict

    def __getitem__(self, key: str):
        return self.data[key]

    @property
    def home(self) -> Path:
        """Collector state directory."""
        return Path(self.data['home'])

    @property
    def tz(self) -> zoneinfo.ZoneInfo:
        """Timezone of the schedule (Beijing time by default)."""
        return zoneinfo.ZoneInfo(self.data['schedule']['timezone'])

    @property
    def private_home(self) -> Path:
        """The isolated copy's private home, `user-home` next to the app (as `mac_runtime.verify` requires)."""
        return Path(self.data['wechat']['app']).parent / 'user-home'


def _merge(base: dict, override: dict, prefix: str = '') -> dict:
    result = copy.deepcopy(base)
    for key, value in override.items():
        if key not in base:
            raise ConfigError(f'unknown config field: {prefix}{key}')
        if isinstance(base[key], dict) and isinstance(value, dict) and key not in ('runDeadlineMinutes',):
            result[key] = _merge(base[key], value, f'{prefix}{key}.')
        else:
            result[key] = value
    return result


def _number(value, name: str, low: float, high: float, integer: bool = False):
    kinds = (int,) if integer else (int, float)
    if isinstance(value, bool) or not isinstance(value, kinds) or not low <= value <= high:
        raise ConfigError(f'invalid {name}')
    return value


def _times(values, name: str) -> None:
    if not isinstance(values, list) or not all(isinstance(item, str) and _TIME.match(item) for item in values) or len(set(values)) != len(values):
        raise ConfigError(f'invalid {name}')


def _seconds_list(values, name: str, low: int, high: int) -> None:
    if not isinstance(values, list) or not values or not all(isinstance(item, int) and not isinstance(item, bool) and low <= item <= high for item in values):
        raise ConfigError(f'invalid {name}')


def validate(data: dict) -> Config:
    """Merge `data` over the defaults, validate every field and expand `~` in paths."""
    merged = _merge(DEFAULTS, data)
    _times(merged['rankings']['times'], 'rankings.times')
    _times(merged['engagement']['times'], 'engagement.times')
    rankings, engagement, helper, schedule = merged['rankings'], merged['engagement'], merged['helper'], merged['schedule']
    _number(rankings['firstBoardType'], 'rankings.firstBoardType', 1, 2147483647, True)
    _number(rankings['pages'], 'rankings.pages', 1, 25, True)
    _number(rankings['pageSize'], 'rankings.pageSize', 1, 20, True)
    _number(rankings['maxBoards'], 'rankings.maxBoards', 1, 50, True)
    _number(engagement['topPerBoard'], 'engagement.topPerBoard', 0, 20, True)
    _number(engagement['dailyCallBudget'], 'engagement.dailyCallBudget', 0, 100000, True)
    for item in engagement['watchlist']:
        if (not isinstance(item, dict) or set(item) != {'srcAppId', 'dramaId', 'title'} or not _APP_ID.match(str(item['srcAppId']))
                or not _DRAMA_ID.match(str(item['dramaId'])) or not isinstance(item['title'], str) or not 1 <= len(item['title'].strip()) <= 160):
            raise ConfigError('invalid engagement.watchlist entry (needs srcAppId, dramaId, title)')
    _number(helper['lifetimeMs'], 'helper.lifetimeMs', 60000, 14400000, True)
    _number(helper['maxCallbacks'], 'helper.maxCallbacks', 1, 16384, True)
    _number(helper['requestsPerGeneration'], 'helper.requestsPerGeneration', 50, 1000, True)
    for key in ('prepareTimeoutSeconds', 'helloTimeoutSeconds', 'requestTimeoutSeconds', 'readyTimeoutSeconds', 'lockWaitSeconds'):
        _number(helper[key], f'helper.{key}', 1, 3600)
    for key in ('cancelTimeoutSeconds', 'shutdownTimeoutSeconds'):
        _number(helper[key], f'helper.{key}', 0.1, 120)
    _seconds_list(schedule['retryDelaysSeconds'], 'schedule.retryDelaysSeconds', 1, 3600)
    _seconds_list(merged['wechat']['restartBackoffSeconds'], 'wechat.restartBackoffSeconds', 1, 3600)
    _seconds_list(merged['outbox']['backoffSeconds'], 'outbox.backoffSeconds', 1, 86400)
    for key in ('tickSeconds', 'graceMinutes', 'humanProbeSeconds', 'sleepGapSeconds', 'networkStableSeconds', 'networkWaitMaxSeconds'):
        _number(schedule[key], f'schedule.{key}', 0, 86400)
    _number(schedule['minCallIntervalSeconds'], 'schedule.minCallIntervalSeconds', 0, 60)
    _number(schedule['callRetries'], 'schedule.callRetries', 0, 5, True)
    deadlines = schedule['runDeadlineMinutes']
    if not isinstance(deadlines, dict) or set(deadlines) != {'rankings', 'engagement'}:
        raise ConfigError('invalid schedule.runDeadlineMinutes')
    for kind, minutes in deadlines.items():
        _number(minutes, f'schedule.runDeadlineMinutes.{kind}', 1, 1440)
    try:
        zoneinfo.ZoneInfo(schedule['timezone'])
    except (zoneinfo.ZoneInfoNotFoundError, ValueError, TypeError):
        raise ConfigError('invalid schedule.timezone') from None
    if not str(merged['wechat']['app']).endswith('/WeChat-Muse-Test.app'):
        raise ConfigError('wechat.app must point at the isolated WeChat-Muse-Test.app copy')
    if not str(merged['station']['baseUrl']).startswith(('https://', 'http://127.0.0.1', 'http://localhost')):
        raise ConfigError('station.baseUrl must be HTTPS')
    for strategy in merged['reentry']['strategies']:
        if not isinstance(strategy, dict) or not isinstance(strategy.get('name'), str) or not isinstance(strategy.get('steps'), list) or not strategy['steps']:
            raise ConfigError('invalid reentry strategy')
        for step in strategy['steps']:
            if not isinstance(step, dict) or step.get('process') not in ('wechat', 'appex') or not isinstance(step.get('match'), dict):
                raise ConfigError(f'invalid reentry step in {strategy["name"]}')
    alert = merged['alert']
    if alert['chatId'] is not None and alert['userId'] is not None:
        raise ConfigError('alert.chatId and alert.userId are mutually exclusive')
    for key, prefix in (('chatId', 'oc_'), ('userId', 'ou_')):
        if alert[key] is not None and (not isinstance(alert[key], str) or not re.fullmatch(prefix + r'[A-Za-z0-9_-]{1,120}', alert[key])):
            raise ConfigError(f'invalid alert.{key}')
    for path in _PATH_KEYS:
        section = merged
        for key in path[:-1]:
            section = section[key]
        section[path[-1]] = os.path.expanduser(str(section[path[-1]]))
    return Config(merged)


def load(path: Path | None) -> Config:
    """Read a JSON configuration file (or only the defaults when `path` is `None`) and validate it."""
    if path is None:
        return validate({})
    try:
        data = json.loads(Path(path).read_text(encoding='utf8'))
    except (OSError, ValueError) as error:
        raise ConfigError(f'cannot read config: {error}') from None
    if not isinstance(data, dict):
        raise ConfigError('config must be a JSON object')
    return validate(data)


def read_token(config: Config) -> str:
    """Read the station token from its private file; refuses group/world-readable or malformed files. Never logged."""
    path = Path(config['station']['tokenFile'])
    info = path.lstat()
    if not path.is_file() or path.is_symlink() or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise ConfigError('station token file must be a regular 0600 file owned by this user')
    token = path.read_text(encoding='ascii').strip()
    if not re.fullmatch(r'[A-Za-z0-9._~-]{32,512}', token):
        raise ConfigError('station token file content is invalid')
    return token
