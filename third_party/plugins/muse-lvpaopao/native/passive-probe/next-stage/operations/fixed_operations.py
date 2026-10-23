"""Validate fixed RPC inputs and expose only a parsed public result to model consumers."""
from __future__ import annotations

import inspect
from pathlib import Path
import re

from native_rpc import FixedOperation

OPERATIONS = ('status', 'search', 'detail', 'episodes', 'download_first_episode', 'download_episode', 'rankings', 'engagement')
TARGET_APP_ID = 'wx404dde55fb12df78'
COMMON = {'operation', 'status', 'identityMatched', 'appVersion', 'envVersion', 'pluginVersion', 'hostLoginState', 'businessCalls', 'timedOut'}
DIAGNOSTICS = {'failurePhase', 'failureKind', 'nativeErrorCode'}
DETAIL = {'srcAppId', 'dramaId', 'title', 'episodeCount', 'isFirstMediaFree', 'hasVideoInfo', 'hasPlayAuthorization'}
EXTRA = {
    'status': {'hasRequire', 'hasBizRequest', 'hasNativeWrapper'},
    'search': {'resultCount', 'partial', 'candidates'},
    'rankings': {'boardType', 'pageIndex', 'pageSize', 'coldStartTime', 'total', 'hasMore', 'partial', 'boards', 'entries'},
    'engagement': {'srcAppId', 'dramaId', 'episodeNo', 'observedAtMs', 'counts'},
    'detail': DETAIL,
    'episodes': DETAIL | {'requestedStart', 'requestedEndExclusive', 'episodeNumbers', 'partial'},
    'download_first_episode': DETAIL | {'serialNo', 'isStraight', 'hasPrivateMedia'},
    'download_episode': DETAIL | {'serialNo', 'isStraight', 'hasPrivateMedia'},
}
STATUSES = {
    'identity-unavailable', 'loader-unavailable', 'plugin-version-unavailable',
    'plugin-version-invalid', 'native-wrapper-unavailable', 'login-state-unavailable',
    'runtime-info-unavailable', 'status-returned', 'business-error',
    'rankings-list-unavailable', 'rankings-returned', 'search-list-unavailable', 'search-returned', 'drama-info-unavailable',
    'engagement-returned', 'engagement-unavailable', 'detail-returned', 'episode-range-outside-detail', 'episode-list-unavailable',
    'episodes-returned', 'first-episode-free-unconfirmed', 'playable-response-invalid',
    'playable-list-unavailable', 'playable-episode-unconfirmed',
    'straight-playback-unconfirmed', 'playable-url-unavailable',
    'first-episode-address-returned', 'episode-address-returned', 'native-call-timeout', 'native-call-failed',
}


class OperationError(RuntimeError):
    """Fixed, non-sensitive input/output failure code; no target errors or URL content."""


def _app_id(value):
    return isinstance(value, str) and re.fullmatch(r'wx[0-9a-f]{16}', value) is not None


def _drama_id(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', value) is not None


def validate_parameters(operation, parameters):
    """Return the exact tagged template arguments; opaque drama IDs remain strings."""
    fields = {'engagement': {'srcAppId', 'dramaId', 'episodeNo'}, 'rankings': {'boardType', 'pageIndex', 'count', 'coldStartTime'}, 'status': set(), 'search': {'query'}, 'detail': {'srcAppId', 'dramaId'}, 'episodes': {'srcAppId', 'dramaId', 'start', 'count'}, 'download_first_episode': {'srcAppId', 'dramaId'}, 'download_episode': {'srcAppId', 'dramaId', 'episodeNo'}}
    if not isinstance(operation, str) or operation not in fields or not isinstance(parameters, dict) or set(parameters) != fields[operation]:
        raise OperationError('parameters-invalid')
    if operation == 'rankings' and (not _integer(parameters['boardType'], 1, 2147483647) or not _integer(parameters['pageIndex'], 0, 10000) or not _integer(parameters['count'], 1, 20) or not _integer(parameters['coldStartTime'], 1, 2147483647)):
        raise OperationError('parameters-invalid')
    if operation == 'search':
        query = parameters['query']
        if not isinstance(query, str) or not query.strip() or len(query) > 80 or re.search(r'[\x00-\x1f\x7f]', query):
            raise OperationError('parameters-invalid')
        try:
            query.encode('utf8')
        except UnicodeError:
            raise OperationError('parameters-invalid') from None
    if operation in ('detail', 'episodes', 'download_first_episode', 'download_episode', 'engagement') and (not _app_id(parameters['srcAppId']) or not _drama_id(parameters['dramaId'])):
        raise OperationError('parameters-invalid')
    if operation == 'episodes' and (type(parameters['start']) is not int or not 1 <= parameters['start'] <= (1 << 53) - 21 or type(parameters['count']) is not int or not 1 <= parameters['count'] <= 20):
        raise OperationError('parameters-invalid')
    if operation in ('download_episode', 'engagement') and (type(parameters['episodeNo']) is not int or not 1 <= parameters['episodeNo'] <= (1 << 53) - 1):
        raise OperationError('parameters-invalid')
    return {'operation': operation, **parameters}


def fixed_operations(allowed_operations):
    """Build NativeRpc's registry only from a trusted host's explicit operation whitelist."""
    if not isinstance(allowed_operations, (tuple, list)) or any(key not in OPERATIONS for key in allowed_operations) or len(set(allowed_operations)) != len(allowed_operations):
        raise OperationError('operation-whitelist-invalid')
    expression = Path(__file__).with_name('fixed-operation.js').read_text(encoding='utf8')
    if expression.count('@@PARAMS@@') != 1:
        raise OperationError('operation-template-invalid')
    return {key: FixedOperation(expression, lambda parameters, key=key: validate_parameters(key, parameters), timeout_seconds=35) for key in allowed_operations}


def _integer(value, low, high):
    return type(value) is int and low <= value <= high


def _text(value, limit):
    return value is None or isinstance(value, str) and len(value) <= limit and re.search(r'[\x00-\x1f\x7f]|[a-z][a-z0-9+.-]*://', value, re.I) is None


def _public(operation, parameters, value):
    if not isinstance(value, dict) or set(value) - DIAGNOSTICS != COMMON | EXTRA[operation] or value['operation'] != operation or not isinstance(value['status'], str) or value['status'] not in STATUSES:
        raise OperationError('public-result-invalid')
    if DIAGNOSTICS & set(value) and value['status'] not in {'native-call-failed', 'native-call-timeout'}:
        raise OperationError('public-result-invalid')
    if 'failurePhase' in value and value['failurePhase'] not in ('before-call', 'call-pending', 'response-received', 'projection'):
        raise OperationError('public-result-invalid')
    if 'failureKind' in value and value['failureKind'] not in ('TypeError', 'ReferenceError', 'RangeError', 'Error', 'other'):
        raise OperationError('public-result-invalid')
    if 'nativeErrorCode' in value and value['nativeErrorCode'] is not None and not _integer(value['nativeErrorCode'], -(1 << 31), (1 << 31) - 1):
        raise OperationError('public-result-invalid')
    if any(type(value[key]) is not bool for key in ('identityMatched', 'timedOut')) or not _integer(value['businessCalls'], 0, 0 if operation == 'status' else 1 if operation in ('search', 'rankings', 'detail', 'engagement') else 2):
        raise OperationError('public-result-invalid')
    if not _text(value['appVersion'], 64) or value['envVersion'] not in (None, 'release', 'trial', 'develop') or value['hostLoginState'] is not None and type(value['hostLoginState']) is not bool:
        raise OperationError('public-result-invalid')
    if value['pluginVersion'] is not None and (not isinstance(value['pluginVersion'], str) or len(value['pluginVersion']) > 32 or re.fullmatch(r'\d+\.\d+\.\d+', value['pluginVersion']) is None):
        raise OperationError('public-result-invalid')
    bool_fields = {'engagement': (), 'status': ('hasRequire', 'hasBizRequest', 'hasNativeWrapper'), 'search': ('partial',), 'rankings': ('partial', 'hasMore'), 'detail': ('isFirstMediaFree', 'hasVideoInfo', 'hasPlayAuthorization'), 'episodes': ('isFirstMediaFree', 'hasVideoInfo', 'hasPlayAuthorization', 'partial'), 'download_first_episode': ('isFirstMediaFree', 'hasVideoInfo', 'hasPlayAuthorization', 'isStraight', 'hasPrivateMedia'), 'download_episode': ('isFirstMediaFree', 'hasVideoInfo', 'hasPlayAuthorization', 'isStraight', 'hasPrivateMedia')}[operation]
    if any(type(value[key]) is not bool for key in bool_fields):
        raise OperationError('public-result-invalid')
    if operation in ('detail', 'episodes', 'download_first_episode', 'download_episode'):
        if value['srcAppId'] != parameters['srcAppId'] or value['dramaId'] != parameters['dramaId'] or not _text(value['title'], 160) or value['episodeCount'] is not None and not _integer(value['episodeCount'], 1, (1 << 53) - 1):
            raise OperationError('public-result-invalid')
    if operation == 'engagement':
        counts = value['counts']
        if value['srcAppId'] != parameters['srcAppId'] or value['dramaId'] != parameters['dramaId'] or value['episodeNo'] != parameters['episodeNo'] or type(value['episodeNo']) is not int:
            raise OperationError('public-result-invalid')
        if not isinstance(counts, dict) or set(counts) != {'likes', 'comments', 'recommendations', 'shares'} or any(item is not None and not _integer(item, 0, (1 << 53) - 1) for item in counts.values()):
            raise OperationError('public-result-invalid')
        if value['observedAtMs'] is not None and not _integer(value['observedAtMs'], 1, (1 << 53) - 1):
            raise OperationError('public-result-invalid')
        if value['status'] == 'engagement-returned' and (value['observedAtMs'] is None or all(item is None for item in counts.values())):
            raise OperationError('public-result-invalid')
    if operation == 'search':
        candidates = value['candidates']
        if not _integer(value['resultCount'], 0, (1 << 53) - 1) or not isinstance(candidates, list) or len(candidates) > 50 or len(candidates) > value['resultCount']:
            raise OperationError('public-result-invalid')
        for item in candidates:
            if not isinstance(item, dict) or set(item) != {'title', 'srcAppId', 'originDramaId'} or item['title'] is None or not _text(item['title'], 160) or not _app_id(item['srcAppId']) or not _drama_id(item['originDramaId']):
                raise OperationError('public-result-invalid')
        if len(candidates) < value['resultCount'] and not value['partial']:
            raise OperationError('public-result-invalid')
    if operation == 'rankings':
        if any(value[key] != parameters[param] for key, param in (('boardType', 'boardType'), ('pageIndex', 'pageIndex'), ('pageSize', 'count'), ('coldStartTime', 'coldStartTime'))):
            raise OperationError('public-result-invalid')
        if value['total'] is not None and not _integer(value['total'], 0, (1 << 53) - 1):
            raise OperationError('public-result-invalid')
        boards, entries = value['boards'], value['entries']
        if not isinstance(boards, list) or len(boards) > 50 or not isinstance(entries, list) or len(entries) > parameters['count']:
            raise OperationError('public-result-invalid')
        for board in boards:
            if not isinstance(board, dict) or set(board) != {'type', 'name'} or not _integer(board['type'], 1, 2147483647) or board['name'] is None or not _text(board['name'], 160):
                raise OperationError('public-result-invalid')
        if len({board['type'] for board in boards}) != len(boards):
            raise OperationError('public-result-invalid')
        for entry in entries:
            offset = parameters['pageIndex'] * parameters['count']
            if not isinstance(entry, dict) or set(entry) != {'rank', 'title', 'srcAppId', 'originDramaId'} or not _integer(entry['rank'], offset + 1, offset + parameters['count']) or entry['title'] is None or not _text(entry['title'], 160) or not _app_id(entry['srcAppId']) or not _drama_id(entry['originDramaId']):
                raise OperationError('public-result-invalid')
        ranks = [entry['rank'] for entry in entries]
        if ranks != sorted(set(ranks)) or value['status'] == 'rankings-returned' and (value['total'] is None or value['hasMore'] != ((parameters['pageIndex'] + 1) * parameters['count'] < value['total'])):
            raise OperationError('public-result-invalid')
    if operation == 'episodes':
        end = value['requestedEndExclusive']
        numbers = value['episodeNumbers']
        if value['requestedStart'] != parameters['start'] or not isinstance(numbers, list) or len(numbers) > parameters['count'] or end is not None and (not _integer(end, parameters['start'] + 1, parameters['start'] + parameters['count']) or value['episodeCount'] is None or end > value['episodeCount'] + 1):
            raise OperationError('public-result-invalid')
        if numbers and end is None or any(not _integer(number, parameters['start'], end - 1) for number in numbers) or numbers != sorted(set(numbers)):
            raise OperationError('public-result-invalid')
        if end is not None and len(numbers) < end - parameters['start'] and not value['partial']:
            raise OperationError('public-result-invalid')
    if operation == 'download_first_episode' and (value['serialNo'] is not None and (type(value['serialNo']) is not int or value['serialNo'] != 1) or value['hasPrivateMedia'] and (not value['isFirstMediaFree'] or not value['isStraight'] or value['serialNo'] != 1)):
        raise OperationError('public-result-invalid')
    if operation == 'download_episode' and (value['serialNo'] is not None and (type(value['serialNo']) is not int or value['serialNo'] != parameters['episodeNo']) or value['hasPrivateMedia'] and (not value['isStraight'] or value['serialNo'] != parameters['episodeNo'] or value['episodeCount'] is None or value['serialNo'] > value['episodeCount'])):
        raise OperationError('public-result-invalid')
    success = {'engagement': 'engagement-returned', 'status': 'status-returned', 'search': 'search-returned', 'rankings': 'rankings-returned', 'detail': 'detail-returned', 'episodes': 'episodes-returned', 'download_first_episode': 'first-episode-address-returned', 'download_episode': 'episode-address-returned'}[operation]
    if value['status'] == success and (not value['identityMatched'] or value['pluginVersion'] is None or value['hostLoginState'] is None or value['businessCalls'] != {'engagement': 1, 'status': 0, 'search': 1, 'rankings': 1, 'detail': 1, 'episodes': 2, 'download_first_episode': 2, 'download_episode': 2}[operation] or value['timedOut']):
        raise OperationError('public-result-invalid')
    if operation == 'episodes' and value['status'] == success and value['requestedEndExclusive'] is None:
        raise OperationError('public-result-invalid')
    if operation in ('download_first_episode', 'download_episode') and value['status'] == success and not value['hasPrivateMedia']:
        raise OperationError('public-result-invalid')
    return dict(value)


def split_result(operation, parameters, raw):
    """Parse host-only raw output into public facts and an optional private URL/binding."""
    validate_parameters(operation, parameters)
    if not isinstance(raw, dict) or set(raw) != {'publicResult', 'privateResult'}:
        raise OperationError('operation-result-invalid')
    public = _public(operation, parameters, raw['publicResult'])
    private = raw['privateResult']
    has_private = operation in ('download_first_episode', 'download_episode') and public['hasPrivateMedia']
    if not has_private:
        if private is not None:
            raise OperationError('private-result-unexpected')
        return public, None
    expected_binding = {'hostAppId': TARGET_APP_ID, 'srcAppId': parameters['srcAppId'], 'dramaId': parameters['dramaId'], 'serialNo': parameters['episodeNo'] if operation == 'download_episode' else 1, 'isStraight': True}
    if operation == 'download_first_episode':
        expected_binding['isFirstMediaFree'] = True
    else:
        expected_binding['playAuthorization'] = 'native-straight-playback'
    expected_status = 'episode-address-returned' if operation == 'download_episode' else 'first-episode-address-returned'
    if (public['status'] != expected_status or not isinstance(private, dict) or set(private) != {'mediaUrl', 'binding'}
            or private['binding'] != expected_binding or type(private['binding']['serialNo']) is not int
            or private['binding']['isStraight'] is not True
            or operation == 'download_first_episode' and private['binding']['isFirstMediaFree'] is not True):
        raise OperationError('private-result-invalid')
    url = private['mediaUrl']
    try:
        valid_url = isinstance(url, str) and url.startswith('https://') and len(url.encode('utf8')) <= 8192 and re.search(r'[\x00-\x20\x7f]', url) is None
    except UnicodeError:
        valid_url = False
    if not valid_url:
        raise OperationError('private-result-invalid')
    return public, {'mediaUrl': url, 'binding': dict(expected_binding)}


async def call_operation(rpc, operation, parameters, *, private_media_consumer=None):
    """Return only public facts; deliver a private URL exclusively to a trusted callback.

    The download callback is mandatory before dispatch and should seal the URL before
    attempting media transfer. Its result is discarded, never merged into model output.
    NativeRpc's registry must also explicitly whitelist the operation.
    """
    validate_parameters(operation, parameters)
    if operation in ('download_first_episode', 'download_episode') and not callable(private_media_consumer):
        raise OperationError('private-media-consumer-required')
    raw = await rpc.call(operation, parameters)
    public, private = split_result(operation, parameters, raw)
    if private is not None:
        try:
            pending = private_media_consumer(private['mediaUrl'], private['binding'])
            if inspect.isawaitable(pending):
                await pending
        except Exception:
            raise OperationError('private-media-consumer-failed') from None
    return public
