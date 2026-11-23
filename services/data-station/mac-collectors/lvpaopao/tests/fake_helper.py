"""Fake native helper speaking the JSONL stdio protocol, scripted by `scenario.json` next to this file.

Scenario keys (all optional):
  readyFile   — `status` reports `status-returned` only while this file exists (the fake re-entry creates it)
  failAt      — {"<method>:<global call number>": code | "exit" | "hang" | "business-error"}; counts persist in `counts.json`
  episodes    — episode count returned by `detail` (default 3)
  boardTotal  — `total` of every board (default 45)
  closeStatus — status of the final `closed` event (default control-close)
"""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
SCENARIO = json.loads((ROOT / 'scenario.json').read_text()) if (ROOT / 'scenario.json').exists() else {}
COUNTS = ROOT / 'counts.json'
BOARDS = [{'type': 6, 'name': '口碑榜'}, {'type': 7, 'name': '热播榜'}]


def emit(frame):
    sys.stdout.write(json.dumps({'protocol': 1, **frame}, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def count(method):
    counts = json.loads(COUNTS.read_text()) if COUNTS.exists() else {}
    counts[method] = counts.get(method, 0) + 1
    COUNTS.write_text(json.dumps(counts))
    return counts[method]


def common(operation, status):
    return {'operation': operation, 'status': status, 'identityMatched': True, 'appVersion': '1.0', 'envVersion': 'release',
            'pluginVersion': '1.2.3', 'hostLoginState': True, 'businessCalls': 1, 'timedOut': False}


def answer(method, params):
    ready = Path(SCENARIO['readyFile']).exists() if SCENARIO.get('readyFile') else True
    if method == 'status':
        return common('status', 'status-returned') if ready else {'status': 'waiting_target', 'ready': False, 'expectedAppId': 'wx404dde55fb12df78'}
    if not ready:
        return 'target-not-ready'
    if method == 'rankings':
        board, page, size = params['boardType'], params['pageIndex'], params['count']
        total = SCENARIO.get('boardTotal', 45)
        ranks = range(page * size + 1, min(total, (page + 1) * size) + 1)
        entries = [{'rank': rank, 'title': f'剧{board}-{rank}', 'srcAppId': 'wx' + f'{board:02x}' * 8, 'originDramaId': f'{board}{rank:04d}'} for rank in ranks]
        return {**common('rankings', 'rankings-returned'), 'boardType': board, 'pageIndex': page, 'pageSize': size,
                'coldStartTime': params['coldStartTime'], 'total': total, 'hasMore': (page + 1) * size < total, 'partial': False,
                'boards': BOARDS, 'entries': entries}
    if method == 'detail':
        return {**common('detail', 'detail-returned'), 'srcAppId': params['srcAppId'], 'dramaId': params['dramaId'], 'title': '详情' + params['dramaId'],
                'episodeCount': SCENARIO.get('episodes', 3), 'isFirstMediaFree': True, 'hasVideoInfo': True, 'hasPlayAuthorization': True}
    if method == 'engagement':
        return {**common('engagement', 'engagement-returned'), 'srcAppId': params['srcAppId'], 'dramaId': params['dramaId'],
                'episodeNo': params['episodeNo'], 'observedAtMs': 1, 'counts': {'likes': 10, 'comments': 2, 'recommendations': 3, 'shares': 1}}
    return 'operation-not-supported'


def main():
    pending = set()
    sha = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    emit({'type': 'event', 'event': 'waiting_target', 'details': {'durationMs': 60000}})
    status = SCENARIO.get('closeStatus', 'control-close')
    for line in sys.stdin:
        frame = json.loads(line)
        if frame.get('type') == 'close':
            break
        if frame.get('type') == 'cancel':
            if frame['id'] in pending:
                pending.discard(frame['id'])
                emit({'type': 'error', 'id': frame['id'], 'error': {'code': 'cancelled', 'message': 'cancelled'}})
            continue
        method, params, identifier = frame['method'], frame['params'], frame['id']
        if method == 'hello':
            if params.get('helper_sha256') != sha:
                emit({'type': 'error', 'id': identifier, 'error': {'code': 'helper-identity-mismatch', 'message': ''}})
                continue
            emit({'type': 'result', 'id': identifier, 'value': {'protocol_version': 1, 'helper_sha256': sha, 'expected_app_id': 'wx404dde55fb12df78',
                                                                 'actions': ['status', 'search', 'detail', 'episodes', 'rankings', 'engagement'], 'ready': False}})
            continue
        script = SCENARIO.get('failAt', {}).get(f'{method}:{count(method)}')
        if script == 'exit':
            sys.exit(3)
        if script == 'hang':
            pending.add(identifier)
            continue
        if script == 'business-error':
            emit({'type': 'result', 'id': identifier, 'value': {**common(method, 'business-error')}})
            continue
        if script:
            emit({'type': 'error', 'id': identifier, 'error': {'code': script, 'message': script}})
            if script in ('context-removed', 'hook-stopped'):
                emit({'type': 'event', 'event': 'closed', 'details': {'status': 'hook-stopped', 'cleanup': dict.fromkeys(('dispose', 'unload', 'detach', 'serverClosed'), True)}})
                sys.exit(0)
            continue
        value = answer(method, params)
        if isinstance(value, str):
            emit({'type': 'error', 'id': identifier, 'error': {'code': value, 'message': value}})
        else:
            emit({'type': 'result', 'id': identifier, 'value': value})
    emit({'type': 'event', 'event': 'closed', 'details': {'status': status, 'cleanup': dict.fromkeys(('dispose', 'unload', 'detach', 'serverClosed'), True)}})


if __name__ == '__main__':
    main()
