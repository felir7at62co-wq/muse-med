"""Bounded observation of one verified mini-program launch in a Windows test process."""

import base64
import hashlib
import json
import ntpath
import os
import pathlib
import queue
import signal
import subprocess
import sys
import threading
import time


def normal_path(value):
    return ntpath.normcase(ntpath.normpath(value))


def file_digest(path):
    with pathlib.Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def require_target(config, *, allow_missing_renderer=False):
    """Check current process metadata without returning process arguments."""
    root_id = int(config['rootPid'])
    expected_id = config['expectedAppId']
    if (not isinstance(expected_id, str) or len(expected_id) != 18
            or not expected_id.startswith('wx')
            or any(character not in '0123456789abcdef' for character in expected_id[2:])):
        raise ValueError('Invalid expected application identifier')
    script = r"""$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$all=@(Get-CimInstance Win32_Process -Filter "Name='WeChatAppEx.exe'");
$root=@($all | Where-Object { $_.ProcessId -eq ROOT_ID });
if ($root.Count -ne 1) { throw 'Selected process unavailable' };
$children=@($all | Where-Object { $_.ParentProcessId -eq ROOT_ID });
$matches=@($children | Where-Object { $_.CommandLine.Contains('EXPECTED_ID') });
$foreign=0;
foreach ($child in $children) {
    foreach ($match in [regex]::Matches($child.CommandLine, 'wx[a-f0-9]{16}')) {
        if ($match.Value -ne 'EXPECTED_ID') { $foreign++ }
    }
};
[pscustomobject]@{
 RootPid=$root[0].ProcessId;
 CreatedUtc=$root[0].CreationDate.ToUniversalTime().ToString('o');
 ExecutablePath=$root[0].ExecutablePath;
 SessionId=$root[0].SessionId;
 MatchingTargetCount=$matches.Count;
 ForeignAppIdCount=$foreign;
} | ConvertTo-Json -Compress
""".replace('ROOT_ID', str(root_id)).replace('EXPECTED_ID', expected_id)
    encoded = base64.b64encode(script.encode('utf-16le')).decode()
    result = subprocess.run(
        ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        capture_output=True, timeout=20, check=True,
    )
    data = json.loads(result.stdout.decode('utf-8-sig'))
    if data['RootPid'] != root_id or data['CreatedUtc'] != config['rootCreatedUtc']:
        raise RuntimeError('Selected process identity changed')
    if normal_path(data['ExecutablePath']) != normal_path(config['executablePath']):
        raise RuntimeError('Selected executable path changed')
    allowed_counts = (0, 1) if allow_missing_renderer else (1,)
    if data['SessionId'] != config['sessionId'] or data['MatchingTargetCount'] not in allowed_counts:
        raise RuntimeError('Target session or application identity unavailable')
    if data['ForeignAppIdCount'] != 0:
        raise RuntimeError('Another mini-program is present in the selected process tree')
    for key, digest_key in [('executablePath', 'executableSHA256'), ('modulePath', 'moduleSHA256')]:
        if file_digest(config[key]) != config[digest_key]:
            raise RuntimeError('Selected runtime file changed')
    return {'rootPid': root_id, 'sessionId': data['SessionId'], 'targetRendererCount': data['MatchingTargetCount']}


def main():
    if os.name != 'nt':
        raise RuntimeError('This observation controller is restricted to Windows')
    root = pathlib.Path(__file__).resolve().parent
    config = json.loads((root / 'config.json').read_text(encoding='utf-8'))
    duration = config['durationMs'] / 1000
    if duration < 10 or duration > 180:
        raise ValueError('Observation must finish within 10 to 180 seconds')
    source = (root / 'observe-launch.js').read_text(encoding='utf-8')
    if source.count('@@CONFIG@@') != 1:
        raise RuntimeError('Observation source placeholder is invalid')
    identity = require_target(config)
    probe_keys = ('expectedAppId', 'modulePath', 'loadStartRva', 'expectedEntryBytes',
                  'durationMs', 'scanBytes', 'indirectSlots', 'maxEvents')
    source = source.replace('@@CONFIG@@', json.dumps({key: config[key] for key in probe_keys}, separators=(',', ':')))
    import frida

    def bounded_call(callback, seconds=10):
        cancellation = frida.Cancellable()
        timer = threading.Timer(seconds, cancellation.cancel)
        timer.daemon = True
        timer.start()
        try:
            with cancellation:
                return callback()
        finally:
            timer.cancel()

    events = queue.Queue(maxsize=64)
    stopped = False
    script = None
    session = None
    records = []
    cleanup = {'dispose': False, 'unload': False, 'detach': False}

    def stop(_signum, _frame):
        nonlocal stopped
        stopped = True

    def message(value, binary_data):
        if binary_data is not None:
            return
        if value.get('type') == 'error':
            payload = {'type': 'script-error'}
        elif value.get('type') == 'send' and isinstance(value.get('payload'), dict):
            payload = value['payload']
        else:
            return
        try:
            events.put_nowait(payload)
        except queue.Full:
            stop(None, None)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    status = 'not-started'
    started = time.monotonic()
    try:
        session = bounded_call(lambda: frida.get_local_device().attach(config['rootPid'], persist_timeout=0))
        script = bounded_call(lambda: session.create_script(source, name='muse-lvpaopao-passive-launch'))
        script.on('message', message)
        bounded_call(script.load)
        status = 'observing'
        while not stopped and time.monotonic() - started < duration:
            try:
                payload = events.get(timeout=0.25)
            except queue.Empty:
                continue
            safe_keys = {'type', 'inlineOffsets', 'indirectOffsets', 'locationsTruncated', 'scene', 'count',
                         'matched', 'reason', 'code', 'passive', 'entryBytesVerified', 'modulePathMatched',
                         'durationMs', 'maxCallbacks', 'callbacks', 'unmatched', 'errors', 'detached', 'flushed'}
            payload = {key: value for key, value in payload.items() if key in safe_keys}
            records.append(payload)
            print(json.dumps(payload, ensure_ascii=False), flush=True)
            if payload.get('type') == 'target-launch':
                status = 'target-observed'
                break
            if payload.get('type') in {'script-error', 'observation-error', 'disposed'}:
                status = 'observation-stopped'
                break
        else:
            status = 'cancelled' if stopped else 'deadline'
    except Exception as error:
        status = 'failed-' + type(error).__name__
        raise
    finally:
        if script is not None:
            try:
                summary = bounded_call(script.exports_sync.dispose, 5)
                cleanup['dispose'] = isinstance(summary, dict) and summary.get('detached') is True and summary.get('flushed') is True
            except Exception as error:
                cleanup['disposeError'] = type(error).__name__
            try:
                bounded_call(script.unload, 5)
                cleanup['unload'] = True
            except Exception as error:
                cleanup['unloadError'] = type(error).__name__
        if session is not None:
            try:
                bounded_call(session.detach, 5)
                cleanup['detach'] = True
            except Exception as error:
                cleanup['detachError'] = type(error).__name__
        receipt = {
            'status': status, 'target': identity, 'events': records, 'cleanup': cleanup,
            'elapsedSeconds': round(time.monotonic() - started, 3),
            'businessCalls': 0, 'applicationFieldWrites': 0, 'portsOpened': 0,
        }
        (root / 'observation.receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'type': 'observation-finished', 'status': status, 'cleanup': cleanup}), flush=True)
        if (script is not None and not (cleanup['dispose'] and cleanup['unload'])) or (session is not None and not cleanup['detach']):
            raise RuntimeError('Observation cleanup incomplete; inspect the task receipt')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'type': 'controller-failed', 'errorType': type(error).__name__}), flush=True)
        sys.exit(1)
