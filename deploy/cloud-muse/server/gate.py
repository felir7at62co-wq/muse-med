#!/usr/bin/env python3
"""Quiet gate, snapshots, readiness and post-release checks for one cloud Muse release (run as root on the server).

Built from operations/web-bot-ui-fd8f20a231/quiet-check.py, served-check.py and
web-central-links-50f2932730.*/release.py. It prints no secret values: the one-time login URL is printed only by
`login-link`, whose output must be piped; state.json, the Feishu config and the journal token are read in-process
and reduced to counts and hashes.

Subcommands:
  check-only [--allow-desk-turns] [--shapes]  one read-only pass of the quiet gate; exit 0 when quiet
  wait --minutes N [--allow-desk-turns]       repeat the gate every 20 s until quiet (0) or timeout (3)
  snapshot OUT                                write before.json (sessions, Bots, Feishu hash, served client, ...)
  ready --expected SHA --prior-pid PID        wait until the restarted service serves SHA with Feishu ready
  check --before F --expected SHA --release R [--restart-wait S] [--out F]   the post-release checks
  live-check [--expected SHA]                 the post-release checks that need no before.json (read-only)
  journal --pid PID                           startup journal classification for one service PID
  runner-pause STATE / runner-restore STATE   pause transcription (recording whether we did) / undo only our pause
  runner                                      runner and desk summary (read-only)
  probe --unit U --port P --profile DIR       rehearsal: isolated service serves its client and Bot state
  login-link                                  print the current one-time login URL (pipe it; never to a terminal)
"""
import argparse
import hashlib
import http.client
import json
import os
import pathlib
import re
import runpy
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

ROOT = pathlib.Path('/var/lib/muse-cloud')
HOME = ROOT / 'home'
PROFILE = HOME / 'profiles/muse-cloud'
UNIT = 'muse-cloud.service'
DROPIN_DIR = pathlib.Path('/etc/systemd/system/muse-cloud.service.d')
HOST, PORT = '100.123.97.104', 19490
PRODUCTION_CFG = pathlib.Path('/opt/muse/production/config.json')
# The batch runner was retired on 11-23 (config archived); the Bot transcription desk keeps the same keys.
if not PRODUCTION_CFG.exists() and pathlib.Path('/opt/muse/production/desk.json').exists():
    PRODUCTION_CFG = pathlib.Path('/opt/muse/production/desk.json')
RUNNER_APP = '/srv/muse-hit-worker/app/agent_runner.py'
SCHEDULE_WINDOW_S = 210
SECRET = re.compile(r'token|http://100\.|login|cookie', re.I)
PROBLEM = re.compile(r'error|warn|fail|exception|ENOENT|EACCES|refused|denied|unhandled', re.I)
# Startup warnings every cloud start shows today (journal of PID 361993, 2026-11-23 15:05).
KNOWN = {
    'mcpManager registered twice': re.compile(r'service "mcpManager" has been registered'),
    'one entry did not activate': re.compile(r'^dsh: warning: 1 entry did not activate$'),
    'claude CLI not found': re.compile(r'Claude CLI version detection fell back|spawnSync claude ENOENT'),
}
# Runtime noise seen in the same journal; counted and reported, not a failure.
TOLERATED = {
    'Feishu read receipt without handler': re.compile(r"no im\.message\.message_read_v1 handle"),
    'ds-bot usage skipped unreadable Sessions': re.compile(r'ds-bot: usage could not read \d+ Sessions'),
}


class Fail(Exception):
    pass


def require(value, reason):
    if not value:
        raise Fail(reason)


def read(path):
    return json.loads(pathlib.Path(path).read_text(encoding='utf-8'))


def sha_file(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def cmd(*args):
    return subprocess.check_output(args, text=True).strip()


def pid():
    return int(cmd('systemctl', 'show', UNIT, '-p', 'MainPID', '--value'))


def is_active(unit):
    return subprocess.run(['systemctl', 'is-active', unit], capture_output=True, text=True).stdout.strip()


def unit_env():
    import shlex
    return dict(item.split('=', 1) for item in shlex.split(cmd('systemctl', 'show', UNIT, '-p', 'Environment', '--value')))


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def cloud():
    cls = runpy.run_path(RUNNER_APP)['MuseCloud']
    cfg = read(PRODUCTION_CFG)
    return cls(cfg['museHost'], cfg['musePort'], cfg['museUnit'])


def bot_view(client):
    return client.bot('state', {'avatars': 'ref'})


# ---------- transcription: runner and desk ----------

def runner_summary():
    cfg = read(PRODUCTION_CFG)
    board = pathlib.Path(cfg['workspaceRoot']) / '.production'
    active = is_active('muse-agent-production.service')
    status_path = board / 'status.json'
    status = read(status_path)
    control = read(board / 'control.json')
    slots = [{'slot': s.get('slot'), 'stage': s.get('stage'), 'title': (s.get('current') or {}).get('title'),
              'openBatches': [b['episodes'] for b in (s.get('current') or {}).get('batches', []) if not b.get('done')]}
             for s in status.get('slots', [])]
    claims = sorted(p.name for p in pathlib.Path(cfg['stateRoot']).glob('active*.json'))
    boundary = all(s['stage'] == 'paused' or (s['stage'] == 'idle' and not s['title']) for s in slots)
    quiet = active != 'active' or (control.get('paused') is True and (status.get('control') or {}).get('paused') is True and boundary)
    desks = []
    for path in sorted(pathlib.Path(cfg['stateRoot']).glob('*/desk.json')):
        try:
            desk = read(path)
        except (OSError, ValueError):
            continue
        if desk.get('state') in ('preparing', 'ready'):
            desks.append({'series': desk.get('seriesId'), 'title': desk.get('title'), 'bot': desk.get('bot'),
                          'botId': desk.get('botId'), 'state': desk.get('state'), 'done': desk.get('done'), 'episodes': desk.get('episodes')})
    return {'runnerActive': active, 'controlPaused': control.get('paused') is True, 'statusAgeS': int(time.time() - status_path.stat().st_mtime),
            'slots': slots, 'claims': claims, 'runnerQuiet': quiet, 'deskDramas': desks,
            'deskActive': is_active('muse-transcription-desk.service')}


def write_json_atomic(path, value, owner='muse-cloud', mode=0o644):
    path = pathlib.Path(path)
    tmp = path.with_name('.' + path.name + '.release-tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    os.chmod(tmp, mode)
    import shutil
    shutil.chown(tmp, owner, owner)
    os.replace(tmp, path)


def runner_pause(state_file):
    control_path = pathlib.Path(read(PRODUCTION_CFG)['workspaceRoot']) / '.production/control.json'
    if not control_path.exists():
        pathlib.Path(state_file).write_text(json.dumps({'at': now_iso(), 'wePaused': False, 'absent': True}) + '\n')
        print('transcription runner: retired (no control file); nothing to pause')
        return
    control = read(control_path)
    state = {'at': now_iso(), 'controlBefore': control, 'wePaused': False}
    if control.get('paused') is not True:
        write_json_atomic(control_path, {**control, 'paused': True})
        state['wePaused'] = True
    pathlib.Path(state_file).write_text(json.dumps(state, ensure_ascii=False) + '\n')
    print('transcription runner:', 'paused by this release' if state['wePaused'] else 'was already paused by someone else (left as is)')


def runner_restore(state_file):
    path = pathlib.Path(state_file)
    if not path.exists():
        print('transcription runner: no pause record; nothing to undo')
        return
    state = read(path)
    if state.get('restoredAt'):
        print('transcription runner: already restored at', state['restoredAt'])
        return
    if not state.get('wePaused'):
        print('transcription runner: this release did not pause it; left paused as found')
        return
    control_path = pathlib.Path(read(PRODUCTION_CFG)['workspaceRoot']) / '.production/control.json'
    control = read(control_path)
    if control.get('paused') is True:
        write_json_atomic(control_path, {**control, 'paused': False})
        print('transcription runner: unpaused (this release had paused it)')
    else:
        print('transcription runner: already unpaused by someone else')
    state['restoredAt'] = now_iso()
    path.write_text(json.dumps(state, ensure_ascii=False) + '\n')


# ---------- quiet gate ----------

def shapes(value, depth=0):
    """Keys and types only, for reading an unfamiliar view without printing its values."""
    if depth > 2:
        return type(value).__name__
    if isinstance(value, dict):
        return {key: shapes(item, depth + 1) for key, item in list(value.items())[:25]}
    if isinstance(value, list):
        return [shapes(value[0], depth + 1), f'len={len(value)}'] if value else []
    return type(value).__name__


def short(sid):
    return sid.removeprefix('session-')[:8]


def mentions_only(collection, allowed):
    """Every running item names an allowed Bot or Session id (desk transcription Bots)."""
    items = collection.values() if isinstance(collection, dict) else collection if isinstance(collection, list) else [collection]
    keys = list(collection.keys()) if isinstance(collection, dict) else []
    texts = [json.dumps(item, ensure_ascii=False) for item in items] + keys
    return all(any(a in text for a in allowed) for text in texts)


def gate(allow_desk_turns=False, show_shapes=False):
    """Return (quiet, reasons, summary). Read-only."""
    reasons = []
    runner = runner_summary()
    if not runner['runnerQuiet']:
        reasons.append('transcription runner is not at a paused batch boundary: ' + json.dumps(runner['slots'], ensure_ascii=False))
    client = cloud()
    rows = client.sessions()
    view = bot_view(client)
    if show_shapes:
        print(json.dumps({'viewKeys': shapes(view), 'sessionRowKeys': shapes(rows[0]) if rows else None}, ensure_ascii=False, indent=1))
    allowed = set()
    if allow_desk_turns:
        bots = {b.get('id'): b for b in view.get('bots', []) if isinstance(b, dict)}
        for desk in runner['deskDramas']:
            bot = bots.get(desk['botId']) or {}
            allowed |= {x for x in (desk['botId'], bot.get('sessionId')) if x}
    running = [r['sessionId'] for r in rows if r.get('running')]
    blocked = [s for s in running if s not in allowed]
    if blocked:
        reasons.append(f'{len(blocked)} Muse session(s) running: ' + ', '.join(short(s) for s in blocked[:6]))
    for r in rows:
        inbox = (r.get('projections') or {}).get('values', {}).get('inbox', {})
        if isinstance(inbox, dict) and any(inbox.get(k) for k in ('next-turn', 'next-step', 'claim')) and r['sessionId'] not in allowed:
            reasons.append('session inbox pending: ' + short(r['sessionId']))
        if r.get('agentAvailable') and r['sessionId'] not in allowed:
            st = client.call('session/state', {'request': {'sessionId': r['sessionId']}})
            if st.get('running') or st.get('queue') or st.get('pendingInput'):
                reasons.append('attached session active or pending: ' + short(r['sessionId']))
            if client.call('terminal/list', {'sessionId': r['sessionId']}):
                reasons.append('attached session has a terminal: ' + short(r['sessionId']))
    result = client.call('schedule/list', {'request': {'active': True, 'limit': 100}})
    items = result.get('items', [])
    if len(items) != result.get('total'):
        reasons.append('schedule list incomplete')
    horizon = time.time() + SCHEDULE_WINDOW_S
    for row in items:
        at = row.get('scheduledAt')
        if not isinstance(at, str) or datetime.fromisoformat(at.replace('Z', '+00:00')).timestamp() <= horizon:
            reasons.append(f'a schedule is due within {SCHEDULE_WINDOW_S} s')
    if view.get('questions'):
        reasons.append('a Bot has a pending question')
    for key, value in (('partsRunning', view.get('partsRunning')),
                       *[('work.' + k, (view.get('work') or {}).get(k)) for k in ('bots', 'turns', 'rooms', 'approvals', 'waiting')]):
        if value and not (allowed and key in ('partsRunning', 'work.bots', 'work.turns') and mentions_only(value, allowed)):
            reasons.append('Bot work pending: ' + key)
    inflight = read(HOME / 'bot/inflight.json')
    for key in ('turns', 'queued'):
        value = inflight.get(key)
        if value and not (allowed and mentions_only(value, allowed)):
            reasons.append('Bot inflight ' + key)
    state = read(HOME / 'bot/state.json')
    for key in ('works', 'switching', 'roomBatches'):
        if state.get(key):
            reasons.append('durable Bot work pending: ' + key)
    summary = {'sessions': len(rows), 'running': len(running), 'allowedDeskSessions': len(allowed),
               'schedules': len(items), 'runner': runner}
    return not reasons, reasons, summary


# ---------- snapshot and served checks ----------

def feishu_hash(rows, view, state):
    """Hash of every enabled Feishu connection's chats and their owners (from quiet-check.py), with counts."""
    ids = {r['sessionId'] for r in rows}
    entries, counts = [], {'group': 0, 'direct': 0}
    for key, conn in state.get('im', {}).get('connections', {}).items():
        if conn.get('platform') != 'feishu' or not conn.get('enabled'):
            continue
        require(view.get('imStatus', {}).get(key, {}).get('state') == 'ready', 'Feishu transport is not ready')
        chats = []
        for cid, chat in sorted(conn.get('chats', {}).items()):
            kind = chat.get('kind')
            target = chat.get('target') or {}
            bot = target.get('botId') or (conn.get('botId') if kind == 'direct' and 'roomId' not in target else None)
            room = target.get('roomId')
            owner = state['bots'].get(bot, {}) if bot else state['rooms'].get(room, {}) if room else {}
            sid = owner.get('sessionId') or bot or room
            require(sid is None or sid in ids, 'an existing Feishu target session is missing')
            chats.append([cid, kind, bot, room, sid])
            if kind in counts:
                counts[kind] += 1
        entries.append([key, conn.get('botId'), sorted(chats)])
    require(entries, 'no enabled Feishu connection')
    return f"{counts['group']} {counts['direct']} " + hashlib.sha256(
        json.dumps(sorted(entries), ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def count(value):
    return len(value) if isinstance(value, (list, dict)) else int(bool(value))


def snapshot():
    client = cloud()
    rows = client.sessions()
    view = bot_view(client)
    state = read(HOME / 'bot/state.json')
    env = unit_env()
    feishu_config = HOME / 'integrations/dsh-feishu/config.json'
    owner_layer = PROFILE / 'cordis.patch.yml'
    return {
        'at': now_iso(), 'pid': pid(), 'release': env.get('MUSE_CLOUD_RELEASE'),
        'sessions': sorted(r['sessionId'] for r in rows),
        'bots': count(view.get('bots')), 'botIds': sorted(b.get('id') for b in view.get('bots', []) if isinstance(b, dict)),
        'mainBotIds': sorted(view.get('mainBotIds') or []), 'centralMembers': count(view.get('centralMembers')),
        'feishu': feishu_hash(rows, view, state),
        'feishuConfigSHA': sha_file(feishu_config) if feishu_config.exists() else None,
        'installedClientSHA': sha_file(PROFILE / 'node_modules/ds-bot/client.js'),
        'ownerLayerSHA': sha_file(owner_layer) if owner_layer.exists() else None,
        'configSHA': sha_file('/opt/muse/cloud/config/cloud.patch.yml'),
        'unitEnvNames': sorted(env), 'dropins': sorted(p.name for p in pathlib.Path('/etc/systemd/system/muse-cloud.service.d').glob('*.conf')),
        'nRestarts': int(cmd('systemctl', 'show', UNIT, '-p', 'NRestarts', '--value')),
    }


def startup_url(for_pid):
    log = subprocess.check_output(['journalctl', f'_PID={for_pid}', f'_SYSTEMD_UNIT={UNIT}', '-o', 'cat', '--no-pager'], text=True)
    found = re.findall(r'^dsh web: (https?://[^\s]+\?token=[A-Za-z0-9_-]+)\s*$', log, re.M)
    require(found, 'the service startup URL is not in the journal yet')
    return found[-1]


def served(expected, for_pid):
    """The running service serves the installed ds-bot client (= expected), Bot state, Central and a ready Feishu."""
    query = urlsplit(startup_url(for_pid)).query
    conn = http.client.HTTPConnection(HOST, PORT, timeout=8)
    conn.request('GET', '/?' + query)
    response = conn.getresponse()
    cookie = (response.getheader('Set-Cookie') or '').split(';', 1)[0]
    response.read()
    conn.close()
    require(response.status == 303 and cookie, 'login exchange did not return a session cookie')

    def get(path, payload=None):
        c = http.client.HTTPConnection(HOST, PORT, timeout=8)
        headers = {'Cookie': cookie}
        if payload is not None:
            headers['Content-Type'] = 'application/json'
        c.request('GET' if payload is None else 'POST', path, body=payload, headers=headers)
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, body

    status, page = get('/')
    require(status == 200, 'authenticated page unavailable')
    text = page.decode()
    marker = 'globalThis["__DSH_BOOT__"] = '
    graph = json.JSONDecoder().raw_decode(text[text.index(marker) + len(marker):])[0]
    row = next(entry for entry in graph['entries'] if entry['id'] == 'ds-bot')
    status, bundle = get('/' + row['url'].lstrip('/'))
    require(status == 200, 'advertised DS Bot bundle unavailable')
    installed = (PROFILE / 'node_modules/ds-bot/client.js').read_bytes()
    require(hashlib.sha256(installed).hexdigest() == expected, 'installed DS Bot client differs from the expected build')
    require(bundle.startswith(installed) or installed in bundle, 'served DS Bot bytes differ from the installed client')
    status, body = get('/api/bot', b'{"endpoint":"state","payload":{"avatars":"ref"}}')
    require(status == 200, 'Bot state endpoint unavailable')
    state = json.loads(body)
    require(state.get('ok') is True and isinstance(state.get('value'), dict), 'Bot state response invalid')
    view = state['value']
    feishu = [c for c in view.get('im', {}).get('connections', []) if c.get('platform') == 'feishu']
    legacy = [c for c in feishu if c.get('enabled') and c.get('dshImBotId')]
    require(legacy, 'the dsh-im Feishu connection is absent')
    require(all(view.get('imStatus', {}).get(c['id'], {}).get('state') == 'ready' for c in legacy), 'a dsh-im Feishu connection is not ready')
    require(view.get('centralMembers') and view.get('mainBotIds'), 'Central members or main Bots absent')
    return {'pid': for_pid, 'graphRev': graph.get('rev'), 'dsBotRev': row.get('rev'), 'servedClientSHA': expected,
            'feishuConnections': len(feishu), 'mainBots': len(view.get('mainBotIds', [])), 'centralMembers': count(view.get('centralMembers'))}


def ready(expected, prior_pid, timeout):
    until = time.monotonic() + timeout
    last = 'not started'
    while time.monotonic() < until:
        try:
            current = pid()
            if current > 0 and current != prior_pid and is_active(UNIT) == 'active':
                result = served(expected, current)
                print('ready:', json.dumps(result, ensure_ascii=False), flush=True)
                return result
            last = f'pid={current}'
        except (Fail, subprocess.CalledProcessError, OSError, ValueError, StopIteration, KeyError) as error:
            last = str(error)[:160]
        time.sleep(3)
    raise Fail('the restarted service did not become ready: ' + last)


# ---------- journal ----------

def journal(for_pid, minutes=None):
    args = ['journalctl', f'_PID={for_pid}', f'_SYSTEMD_UNIT={UNIT}', '-o', 'cat', '--no-pager']
    lines = subprocess.check_output(args, text=True).splitlines()
    known = {k: 0 for k in KNOWN}
    tolerated = {k: 0 for k in TOLERATED}
    unknown = []
    in_block = False
    for line in lines:
        if line[:1] in (' ', '\t', '}', ']', ')') or line.startswith("'") or line.startswith('  '):
            continue  # stack frames and wrapped objects belong to the header line above
        if SECRET.search(line):
            continue
        label = next((k for k, rx in KNOWN.items() if rx.search(line)), None)
        if label:
            known[label] += 1
            continue
        label = next((k for k, rx in TOLERATED.items() if rx.search(line)), None)
        if label:
            tolerated[label] += 1
            continue
        if PROBLEM.search(line):
            unknown.append(line[:220])
    return {'known': known, 'tolerated': tolerated, 'unknown': unknown}


def probe(unit, port, profile):
    """Rehearsal: the isolated service on 127.0.0.1:port serves its installed ds-bot client and Bot state."""
    log = subprocess.check_output(['journalctl', '-u', unit, '-o', 'cat', '--no-pager'], text=True)
    found = re.findall(r'^dsh web: (https?://[^\s]+\?token=[A-Za-z0-9_-]+)\s*$', log, re.M)
    require(found, 'the rehearsal startup URL is not in its journal yet')
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=8)
    conn.request('GET', '/?' + urlsplit(found[-1]).query)
    response = conn.getresponse()
    cookie = (response.getheader('Set-Cookie') or '').split(';', 1)[0]
    response.read()
    conn.close()
    require(response.status == 303 and cookie, 'rehearsal login exchange failed')

    def get(path, payload=None):
        c = http.client.HTTPConnection('127.0.0.1', port, timeout=15)
        headers = {'Cookie': cookie, **({'Content-Type': 'application/json'} if payload is not None else {})}
        c.request('GET' if payload is None else 'POST', path, body=payload, headers=headers)
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, body

    status, page = get('/')
    require(status == 200, 'rehearsal page unavailable')
    text = page.decode()
    marker = 'globalThis["__DSH_BOOT__"] = '
    graph = json.JSONDecoder().raw_decode(text[text.index(marker) + len(marker):])[0]
    row = next(entry for entry in graph['entries'] if entry['id'] == 'ds-bot')
    status, bundle = get('/' + row['url'].lstrip('/'))
    installed = (pathlib.Path(profile) / 'node_modules/ds-bot/client.js').read_bytes()
    require(status == 200 and (bundle.startswith(installed) or installed in bundle), 'rehearsal serves a different ds-bot client')
    status, body = get('/api/bot', b'{"endpoint":"state","payload":{"avatars":"ref"}}')
    value = json.loads(body) if status == 200 else {}
    require(value.get('ok') is True, f'rehearsal Bot state unavailable (HTTP {status})')
    lines = log.splitlines()
    unknown = [l[:220] for l in lines if l[:1] not in (' ', '\t', '}', ']', ')', "'") and not SECRET.search(l)
               and PROBLEM.search(l) and not any(rx.search(l) for rx in (*KNOWN.values(), *TOLERATED.values()))]
    return {'graphEntries': len(graph['entries']), 'servedClientSHA': hashlib.sha256(installed).hexdigest(),
            'botState': True, 'unknownJournalLines': unknown}


# ---------- post-release checks ----------

def static_checks(release, results):
    env = unit_env()

    def record(name, ok, detail=''):
        results.append((name, bool(ok), detail))

    record('ExecStart runs the new release', release and release in cmd('systemctl', 'show', UNIT, '-p', 'ExecStart', '--value'))
    record('MUSE_CLOUD_RELEASE is the new release', env.get('MUSE_CLOUD_RELEASE') == release)
    record('Central members env (drop-in central-members.conf)', {'MUSE_CENTRAL_MEMBERS', 'MUSE_CENTRAL_ORIGIN'} <= set(env))
    station = PROFILE / 'node_modules/ds-bot/src/host/station-events.js'
    if (DROPIN_DIR / 'station-events-retired.conf').exists():
        record('station webhook retired (route off, no Bot named)', not env.get('MUSE_STATION_EVENTS_SECRET_FILE') and 'MUSE_STATION_EVENTS_BOT' not in env)
        record('station-events.js keeps the route off without a secret file', station.exists() and 'if (!secretFile) return' in station.read_text())
    else:
        record('station notices env MUSE_STATION_EVENTS_BOT', 'MUSE_STATION_EVENTS_BOT' in env)
        record('station-events.js reads MUSE_STATION_EVENTS_BOT', station.exists() and 'MUSE_STATION_EVENTS_BOT' in station.read_text())
    record('DSH_PRIMARY_RUNTIME set and present', env.get('DSH_PRIMARY_RUNTIME') and os.path.isdir(env['DSH_PRIMARY_RUNTIME']))
    record('MUSE_DESKTOP_HOST not set (cloud keeps no studio media files)', 'MUSE_DESKTOP_HOST' not in env)
    jl = pathlib.Path(release) / 'packages/drama/jingliu-connection/lib'
    record('jingliu-connection has localVideo', any('localVideo' in p.read_text(errors='ignore') for p in jl.glob('*.js')))
    dpatch = pathlib.Path(release) / 'apps/desktop-host/config/desktop.cordis.patch.yml'
    record('workshop_script_editor in the release desktop patch', dpatch.exists() and 'workshop_script_editor' in dpatch.read_text())
    config = pathlib.Path('/opt/muse/cloud/config/cloud.patch.yml').read_text()
    record('cloud.patch.yml keeps muse-desktop-office, feishu-channel and feishuDshIm',
           'id: muse-desktop-office' in config and re.search(r'id: feishu-channel\n\s+disabled: false', config) and 'feishuDshIm:' in config)
    hongguo = PROFILE / 'node_modules/muse-hongguo-download/patches/0002-electron-main-only.patch'
    results.append(('WARN hongguo Node-only catalog patch (0002) present', hongguo.exists(),
                    '' if hongguo.exists() else 'missing: Hongguo download on cloud may fail like before 16:55 (fix is on codex/hongguo-node-runtime 88c3ea7d71)'))


def check(before_path, expected, release, restart_wait, out):
    results = []
    before = read(before_path)

    def record(name, ok, detail=''):
        results.append((name, bool(ok), detail))

    current = pid()
    record('service active with a new PID', is_active(UNIT) == 'active' and current not in (0, before['pid']), f"{before['pid']} -> {current}")
    try:
        record('served ds-bot client.js = built', served(expected, current)['servedClientSHA'] == expected, expected[:12])
    except (Fail, OSError, ValueError, StopIteration, KeyError, subprocess.CalledProcessError) as error:
        record('served ds-bot client.js = built', False, str(error)[:160])
    after = snapshot()
    record('Central members present', after['centralMembers'] > 0, f"{before['centralMembers']} -> {after['centralMembers']}")
    record('main Bots present', set(before['mainBotIds']) <= set(after['mainBotIds']), f"{len(before['mainBotIds'])} -> {len(after['mainBotIds'])}")
    record('Bots present', set(before['botIds']) <= set(after['botIds']), f"{before['bots']} -> {after['bots']}")
    record('sessions superset', set(before['sessions']) <= set(after['sessions']), f"{len(before['sessions'])} -> {len(after['sessions'])}")
    record('Feishu ready with the same bindings', before['feishu'] == after['feishu'], after['feishu'][:20])
    record('Feishu config file unchanged', before['feishuConfigSHA'] == after['feishuConfigSHA'])
    kept = {'central-members.conf'} | ({'station-events-retired.conf'} if 'station-events-retired.conf' in after['dropins'] else {'station-events-bot.conf'})
    record('drop-ins: central-members kept, station webhook kept or retired', kept <= set(after['dropins']), ','.join(after['dropins']))
    static_checks(release, results)
    j = journal(current)
    record('journal: only the known startup warnings', not j['unknown'], '; '.join(j['unknown'][:5]))
    results.append(('INFO journal counts', True, json.dumps({**j['known'], **j['tolerated']}, ensure_ascii=False)))
    if restart_wait:
        started = int(cmd('systemctl', 'show', UNIT, '-p', 'ActiveEnterTimestamp', '--timestamp=unix', '--value').lstrip('@'))
        left = started + restart_wait - time.time()
        if left > 0:
            print(f'waiting {int(left)} s for the {restart_wait} s restart window', flush=True)
            time.sleep(left)
        record(f'NRestarts 0 and same PID after {restart_wait} s',
               int(cmd('systemctl', 'show', UNIT, '-p', 'NRestarts', '--value')) == 0 and pid() == current)
    failed = [r for r in results if not r[1] and not r[0].startswith(('WARN', 'INFO'))]
    for name, ok, detail in results:
        tag = 'INFO' if name.startswith('INFO') else ('WARN' if name.startswith('WARN') and not ok else ('PASS' if ok else 'FAIL'))
        print(f'{tag:4} {name.removeprefix("WARN ").removeprefix("INFO ")}' + (f'  [{detail}]' if detail else ''))
    if out:
        pathlib.Path(out).write_text(json.dumps({'after': after, 'results': results, 'at': now_iso()}, ensure_ascii=False) + '\n')
    return not failed


def live_check(expected):
    """Read-only: the checks that need no before.json, against whatever runs now."""
    results = []
    env = unit_env()
    release = env.get('MUSE_CLOUD_RELEASE')
    current = pid()
    expected = expected or sha_file(PROFILE / 'node_modules/ds-bot/client.js')
    try:
        info = served(expected, current)
        results.append(('served ds-bot client.js = installed', True, expected[:12]))
        results.append(('INFO served', True, json.dumps(info, ensure_ascii=False)))
    except (Fail, OSError, ValueError, StopIteration, KeyError, subprocess.CalledProcessError) as error:
        results.append(('served ds-bot client.js = installed', False, str(error)[:160]))
    static_checks(release, results)
    j = journal(current)
    results.append(('journal: only the known startup warnings', not j['unknown'], '; '.join(j['unknown'][:5])))
    results.append(('INFO journal counts', True, json.dumps({**j['known'], **j['tolerated']}, ensure_ascii=False)))
    results.append(('INFO NRestarts', True, cmd('systemctl', 'show', UNIT, '-p', 'NRestarts', '--value')))
    for name, ok, detail in results:
        tag = 'INFO' if name.startswith('INFO') else ('WARN' if name.startswith('WARN') and not ok else ('PASS' if ok else 'FAIL'))
        print(f'{tag:4} {name.removeprefix("WARN ").removeprefix("INFO ")}' + (f'  [{detail}]' if detail else ''))
    return all(ok for name, ok, _ in results if not name.startswith(('WARN', 'INFO')))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('check-only'); p.add_argument('--allow-desk-turns', action='store_true'); p.add_argument('--shapes', action='store_true')
    sub.add_parser('running-sessions')
    p = sub.add_parser('wait'); p.add_argument('--minutes', type=float, default=60); p.add_argument('--allow-desk-turns', action='store_true')
    p = sub.add_parser('snapshot'); p.add_argument('out')
    p = sub.add_parser('ready'); p.add_argument('--expected', required=True); p.add_argument('--prior-pid', type=int, required=True); p.add_argument('--timeout', type=int, default=240)
    p = sub.add_parser('check'); p.add_argument('--before', required=True); p.add_argument('--expected', required=True); p.add_argument('--release', required=True)
    p.add_argument('--restart-wait', type=int, default=300); p.add_argument('--out')
    p = sub.add_parser('live-check'); p.add_argument('--expected')
    p = sub.add_parser('journal'); p.add_argument('--pid', type=int)
    p = sub.add_parser('runner-pause'); p.add_argument('state')
    p = sub.add_parser('runner-restore'); p.add_argument('state')
    sub.add_parser('runner')
    p = sub.add_parser('probe'); p.add_argument('--unit', required=True); p.add_argument('--port', type=int, required=True); p.add_argument('--profile', required=True); p.add_argument('--timeout', type=int, default=150)
    sub.add_parser('login-link')
    args = parser.parse_args()
    try:
        if args.command == 'running-sessions':
            # Sessions running right now, with the Bot that owns each (if any): what to wake after a busy restart.
            client = cloud()
            rows = client.sessions()
            view = bot_view(client)
            owners = {b.get('sessionId'): {'botId': b.get('id'), 'name': b.get('name')} for b in view.get('bots', []) if isinstance(b, dict)}
            running = [{'sessionId': r['sessionId'], **owners.get(r['sessionId'], {})} for r in rows if r.get('running')]
            print(json.dumps({'running': running}, ensure_ascii=False))
            return 0
        if args.command == 'check-only':
            quiet, reasons, summary = gate(args.allow_desk_turns, args.shapes)
            print(json.dumps(summary, ensure_ascii=False))
            print('QUIET' if quiet else 'NOT QUIET: ' + ' | '.join(reasons))
            return 0 if quiet else 1
        if args.command == 'wait':
            until = time.monotonic() + args.minutes * 60
            last = None
            while True:
                quiet, reasons, summary = gate(args.allow_desk_turns)
                if quiet:
                    print('QUIET', json.dumps(summary, ensure_ascii=False), flush=True)
                    return 0
                text = ' | '.join(reasons)
                if text != last:
                    print(time.strftime('%H:%M:%S'), 'waiting:', text, flush=True)
                    last = text
                if time.monotonic() > until:
                    print('TIMEOUT: not quiet within', args.minutes, 'minutes', flush=True)
                    return 3
                time.sleep(20)
        if args.command == 'snapshot':
            value = snapshot()
            pathlib.Path(args.out).write_text(json.dumps(value, ensure_ascii=False) + '\n')
            print('snapshot:', json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in value.items()}, ensure_ascii=False))
            return 0
        if args.command == 'ready':
            ready(args.expected, args.prior_pid, args.timeout)
            return 0
        if args.command == 'check':
            return 0 if check(args.before, args.expected, args.release, args.restart_wait, args.out) else 1
        if args.command == 'live-check':
            return 0 if live_check(args.expected) else 1
        if args.command == 'journal':
            print(json.dumps(journal(args.pid or pid()), ensure_ascii=False, indent=1))
            return 0
        if args.command == 'runner-pause':
            runner_pause(args.state)
            return 0
        if args.command == 'runner-restore':
            runner_restore(args.state)
            return 0
        if args.command == 'probe':
            until = time.monotonic() + args.timeout
            while True:
                try:
                    print(json.dumps(probe(args.unit, args.port, args.profile), ensure_ascii=False))
                    return 0
                except (Fail, OSError, ValueError, StopIteration, KeyError, subprocess.CalledProcessError) as error:
                    if is_active(args.unit) not in ('active', 'activating') or time.monotonic() > until:
                        print('STOP: rehearsal not ready:', str(error)[:200], file=sys.stderr)
                        return 1
                    time.sleep(3)
        if args.command == 'runner':
            print(json.dumps(runner_summary(), ensure_ascii=False, indent=1))
            return 0
        if args.command == 'login-link':
            require(not sys.stdout.isatty(), 'login-link prints a credential; pipe it to its destination')
            sys.stdout.write(startup_url(pid()) + '\n')
            return 0
    except Fail as error:
        print('STOP:', error, file=sys.stderr)
        return 1
    return 2


if __name__ == '__main__':
    sys.exit(main())
