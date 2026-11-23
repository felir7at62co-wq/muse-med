"""Command line: `run` (launchd entry point), `once`, `status`, `probe-windows`, `stop-wechat`."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

from .config import ConfigError, load
from .macos import MacSystem
from .util import FileLock, iso, read_json, write_json


def _service_lock(config) -> FileLock:
    return FileLock(config.home / 'run' / 'service.lock')


def cmd_run(config, args) -> int:
    """Long-running collector (guardian + scheduler + uploader)."""
    from .service import Service
    lock = _service_lock(config)
    if not lock.acquire():
        print('another collector process is running', file=sys.stderr)
        return 75
    return Service(config, MacSystem(), echo=args.verbose).run()


def cmd_once(config, args) -> int:
    """One run of `--kind` now, then one upload pass; refuses while the service is running."""
    from .service import Service
    lock = _service_lock(config)
    if not lock.acquire():
        print('the collector service is running; use the station\'s 「立即采集」 instead', file=sys.stderr)
        return 75
    service = Service(config, MacSystem(), echo=True)
    service.guardian.tick()
    service.scheduler.run(args.kind, service.clock.wall() // 60 * 60, forced=True)
    service.uploader.flush()
    print(json.dumps(service.scheduler.state.get('lastRun'), ensure_ascii=False))
    return 0


def cmd_status(config, _args) -> int:
    """Print local state without contacting the station."""
    home = config.home
    pending = sorted((home / 'outbox' / 'pending').glob('*.json'))
    rejected = sorted((home / 'outbox' / 'rejected').glob('*.json'))
    scheduler = read_json(home / 'state' / 'scheduler.json') or {}
    print(json.dumps({'python': sys.executable, 'realPython': os.path.realpath(sys.executable), 'home': str(home),
                      'lastRun': scheduler.get('lastRun'), 'human': scheduler.get('human'), 'budget': scheduler.get('budget'),
                      'lastHandled': {kind: iso(value, config.tz) for kind, value in (scheduler.get('lastHandled') or {}).items()},
                      'wechat': read_json(home / 'state' / 'wechat.json'), 'pendingUploads': len(pending),
                      'rejectedUploads': len([path for path in rejected if not path.name.endswith('.reason.json')])},
                     ensure_ascii=False, indent=1))
    return 0


def cmd_probe_windows(config, args) -> int:
    """Dump the accessibility trees and CoreGraphics windows of the isolated copy to a private file (for pinning AX paths)."""
    from .wechat import APPEX_PART, MAIN_PART
    mac = MacSystem()
    app = config['wechat']['app']
    rows = mac.processes()
    main = [row.pid for row in rows if row.uid == os.getuid() and row.comm == f'{app}/{MAIN_PART}']
    appex = [row.pid for row in rows if row.uid == os.getuid() and row.comm == f'{app}/{APPEX_PART}' and row.ppid in main]
    report = {'app': app, 'processes': {}}
    for label, pids in (('wechat', main), ('appex', appex)):
        for pid in pids:
            entry = {}
            for name, call in (('ax', lambda: mac.ax_dump(pid, args.depth, args.nodes)), ('cgWindows', lambda: mac.cg_windows(pid))):
                try:
                    entry[name] = call()
                except (OSError, ValueError) as error:
                    entry[name] = {'error': str(error)}
            report['processes'][f'{label}:{pid}'] = entry
    out = Path(args.out)
    write_json(out, report)
    print(f'wrote {out} ({len(main)} WeChat, {len(appex)} WeChatAppEx process(es)); it may contain chat titles — keep it private')
    return 0 if main else 1


def cmd_stop_wechat(config, _args) -> int:
    """Stop the isolated copy this collector tracks (used by uninstall.sh)."""
    from .util import Clock
    from .wechat import Guardian
    guardian = Guardian(config, MacSystem(), Clock(), None, lambda level, message: print(level, message, file=sys.stderr))
    record = read_json(guardian.state_path) or {}
    guardian.main_pid, guardian.main_start = record.get('pid'), record.get('start')
    guardian.stop()
    return 0


def main(argv: list[str] | None = None) -> int:
    """Parse arguments and dispatch."""
    parser = argparse.ArgumentParser(prog='lvpaopao_collector')
    parser.add_argument('--config', type=Path, help='config JSON (defaults apply when omitted)')
    commands = parser.add_subparsers(dest='command', required=True)
    run = commands.add_parser('run')
    run.add_argument('--verbose', action='store_true')
    once = commands.add_parser('once')
    once.add_argument('--kind', choices=('rankings', 'engagement'), required=True)
    commands.add_parser('status')
    probe = commands.add_parser('probe-windows')
    probe.add_argument('--out', required=True)
    probe.add_argument('--depth', type=int, default=14)
    probe.add_argument('--nodes', type=int, default=5000)
    commands.add_parser('stop-wechat')
    args = parser.parse_args(argv)
    try:
        config = load(args.config)
    except ConfigError as error:
        print(f'config error: {error}', file=sys.stderr)
        return 78
    handler = {'run': cmd_run, 'once': cmd_once, 'status': cmd_status, 'probe-windows': cmd_probe_windows, 'stop-wechat': cmd_stop_wechat}[args.command]
    return handler(config, args)


if __name__ == '__main__':
    raise SystemExit(main())
