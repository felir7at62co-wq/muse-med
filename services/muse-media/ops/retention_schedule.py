"""Install a persistent one-time review timer after the first successful server observation."""

import argparse
from contextlib import closing
from datetime import datetime, timezone, timedelta
from pathlib import Path
import sqlite3
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'gateway'))
from retention import Rules, code_digest


def units(release, first_observed, preview_seconds):
    """Return a one-shot UTC review schedule; interrupted observation still fails runtime review."""
    release = Path(release).resolve()
    if any(char in str(release) for char in '\n\r%"\\ '):
        raise ValueError('The immutable release path is not safe for a systemd argument')
    due = datetime.fromtimestamp(first_observed, timezone.utc) + timedelta(seconds=preview_seconds + 600)
    service = f'''[Unit]
Description=Review Muse media dry-run before enabling retention
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 {release}/ops/retention_control.py promote --output /opt/muse/media-gateway/receipts/retention-review.json
TimeoutStartSec=300
UMask=0077
'''
    timer = f'''[Unit]
Description=One-time Muse media retention review

[Timer]
OnCalendar={due.strftime('%Y-%m-%d %H:%M:%S')} UTC
Persistent=true
Unit=muse-media-retention-review.service

[Install]
WantedBy=timers.target
'''
    return due.isoformat(), service, timer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--database', type=Path, default=Path('/var/lib/muse-media/gateway.sqlite3'))
    parser.add_argument('--rules', type=Path, default=Path('/etc/muse/media-gateway/retention.json'))
    args = parser.parse_args()
    rules = Rules.load(args.rules)
    if rules.mode != 'dry-run':
        raise ValueError('Only dry-run observation can start the review timer')
    with closing(sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        row = db.execute("SELECT MIN(created_at) FROM media_audits WHERE kind='sweep' AND policy_hash=? AND code_hash=? AND json_extract(payload,'$.mode')='dry-run' AND json_extract(payload,'$.error') IS NULL", (rules.digest(), code_digest())).fetchone()
    if row is None or row[0] is None:
        raise ValueError('There is no successful server dry-run observation')
    due, service, timer = units(args.release, row[0], rules.preview_seconds)
    Path('/etc/systemd/system/muse-media-retention-review.service').write_text(service)
    Path('/etc/systemd/system/muse-media-retention-review.timer').write_text(timer)
    storage_service = f'''[Unit]
Description=Observe Muse host storage without deleting files
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 {args.release.resolve()}/ops/host_storage.py --output /opt/muse/media-gateway/receipts/host-storage.json
TimeoutStartSec=120
UMask=0077
'''
    storage_timer = '''[Unit]
Description=Periodic Muse host storage observation

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
Unit=muse-storage-observe.service

[Install]
WantedBy=timers.target
'''
    Path('/etc/systemd/system/muse-storage-observe.service').write_text(storage_service)
    Path('/etc/systemd/system/muse-storage-observe.timer').write_text(storage_timer)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', '--now', 'muse-storage-observe.timer'], check=True)
    subprocess.run(['systemctl', 'enable', '--now', 'muse-media-retention-review.timer'], check=True)
    print(due)


if __name__ == '__main__':
    main()
