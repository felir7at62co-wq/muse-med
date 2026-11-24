"""Switch the account gateway unit to a prepared release, or roll it back (server side of switch.sh, as root).
Usage: switch.py <OPS> check|activate|rollback

The unit's effective ExecStart drop-in (the last one in name order that sets ExecStart) must also set WorkingDirectory and
name the live release path; activate replaces that path with the prepared release and nothing else. Health = the new main
process runs from the new release and GET /login answers 200 on the unit's MUSE_PORT with the Host of MUSE_PUBLIC_ORIGIN.
A failed activate restores the saved drop-in and restarts the previous release."""
import fcntl, http.client, json, os, signal, subprocess, sys, time
from pathlib import Path
from urllib.parse import urlsplit

OPS, MODE = Path(sys.argv[1]), sys.argv[2]
UNIT = os.environ.get('MUSE_GATEWAY_UNIT', 'muse-minimal-accounts.service')
DROPINS = Path('/etc/systemd/system') / (UNIT + '.d')
SUB = '/gateway/services/muse-accounts'
prepared = json.loads((OPS / 'prepared.json').read_text())
NEW, LIVE = prepared['release'], prepared['live']
saved, saved_name = OPS / 'dropin.before.conf', OPS / 'dropin.name'
exitfile = OPS / 'switch.exit'

def show(p): return subprocess.check_output(['systemctl', 'show', UNIT, '-p', p, '--value'], text=True).strip()
def cwd(pid):
    try: return os.readlink(f'/proc/{pid}/cwd')
    except OSError: return None
def env_of(pid):
    try: return dict(l.split('=', 1) for l in open(f'/proc/{pid}/environ').read().split('\0') if '=' in l)
    except OSError: return {}

def effective_dropin():
    files = sorted(p for p in DROPINS.glob('*.conf'))
    sets = [p for p in files if any(l.startswith('ExecStart=') and l.strip() != 'ExecStart=' for l in p.read_text().splitlines())]
    if not sets: sys.exit('STOP: no drop-in sets ExecStart')
    last = sets[-1]; text = last.read_text()
    wd = [p for p in files if any(l.startswith('WorkingDirectory=') for l in p.read_text().splitlines())]
    if not wd or wd[-1] != last: sys.exit(f'STOP: WorkingDirectory is not set by {last.name}; rewrite would be ambiguous')
    return last, text

def health(expected, previous, port, host):
    old_pid = show('MainPID')
    subprocess.run(['systemctl', 'restart', '--no-block', UNIT], check=True)
    started, forced, last = time.monotonic(), False, None
    while time.monotonic() - started < 150:
        state, pid = show('ActiveState'), show('MainPID')
        if not forced and time.monotonic() - started >= 25 and state == 'deactivating' and pid == old_pid and cwd(pid) == previous:
            os.kill(int(pid), signal.SIGKILL); forced = True; print('previous gateway did not stop; released its main process', flush=True)
        if state == 'active' and pid not in ('0', old_pid) and cwd(pid) == expected:
            c = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
            try:
                c.request('GET', '/login', headers={'Host': host}); r = c.getresponse(); last = r.status; r.read()
                if last == 200: return {'pid': int(pid), 'seconds': round(time.monotonic() - started), 'forcedPreviousStop': forced}
            except (OSError, http.client.HTTPException): pass
            finally: c.close()
        time.sleep(1)
    raise RuntimeError(f'gateway health did not recover, last HTTP {last}')

def write(path, data):
    tmp = path.with_name(path.name + '.switch-tmp')
    with tmp.open('w') as f: f.write(data)
    os.chmod(tmp, 0o644); os.replace(tmp, path)

def main():
    lock = open(OPS / '.switch.lock', 'w'); fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    pid = show('MainPID'); env = env_of(pid)
    port, host = int(env.get('MUSE_PORT', '0')), urlsplit(env.get('MUSE_PUBLIC_ORIGIN', '')).netloc
    if not port or not host: sys.exit('STOP: the running unit has no MUSE_PORT or MUSE_PUBLIC_ORIGIN')
    if MODE in ('check', 'activate'):
        if show('WorkingDirectory') != LIVE + SUB: sys.exit(f'STOP: the unit no longer runs {LIVE} (it runs {show("WorkingDirectory")}); prepare again')
        path, text = effective_dropin()
        n = text.count(LIVE + '/')
        if n < 2: sys.exit(f'STOP: {path.name} names the live release {n} times; expected WorkingDirectory and ExecStart')
        print(f'unit {UNIT} pid {pid} runs {LIVE}; {path.name} names it {n} times; target {NEW}', flush=True)
        if MODE == 'check': return
        saved.write_text(text); saved_name.write_text(path.name)
        write(path, text.replace(LIVE + '/', NEW + '/'))
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        try:
            result = health(NEW + SUB, LIVE + SUB, port, host)
        except Exception:
            print('activation failed; restoring the previous drop-in', flush=True)
            write(path, text); subprocess.run(['systemctl', 'daemon-reload'], check=True); health(LIVE + SUB, NEW + SUB, port, host); raise
        (OPS / 'activation.json').write_text(json.dumps({'from': LIVE, 'to': NEW, **result, 'at': time.strftime('%Y-%m-%dT%H:%M:%S%z')}, indent=1) + '\n')
        print(json.dumps(result), flush=True)
    elif MODE == 'rollback':
        if not saved.exists(): sys.exit('STOP: nothing saved; activate never ran')
        if show('WorkingDirectory') != NEW + SUB: sys.exit('STOP: the unit does not run the prepared release; nothing to roll back')
        path = DROPINS / saved_name.read_text().strip(); current = path.read_text()
        write(path, saved.read_text()); subprocess.run(['systemctl', 'daemon-reload'], check=True)
        try:
            result = health(LIVE + SUB, NEW + SUB, port, host)
        except Exception:
            print('rollback failed health; putting the prepared release back', flush=True)
            write(path, current); subprocess.run(['systemctl', 'daemon-reload'], check=True); health(NEW + SUB, LIVE + SUB, port, host); raise
        print(json.dumps({'rolledBackTo': LIVE, **result}), flush=True)
    else:
        sys.exit(__doc__)

try:
    main(); rc = 0
except SystemExit as e:
    rc = e.code if isinstance(e.code, int) else (print(e.code, flush=True) or 1)
except Exception as e:  # noqa: BLE001 - reported through the exit file
    print(f'FAILED: {e}', flush=True); rc = 1
if MODE != 'check': exitfile.write_text(f'{rc} {time.strftime("%Y-%m-%dT%H:%M:%S%z")}\n')
sys.exit(rc)
