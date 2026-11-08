"""Report host storage and unknown release references without deleting host data."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess

from prepare import private_write
import os


def command(arguments):
    """Bound a read-only command and return only an operator-safe summary."""
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=60)
    return {'available': result.returncode == 0, 'summary': result.stdout.strip()[:8192]}


def report():
    """Keep host capacity separate from media TTL; unknown releases are protected."""
    disk = shutil.disk_usage('/')
    return {'observedAt': datetime.now(timezone.utc).isoformat(), 'mode': 'report-only', 'deleted': 0,
            'disk': {'total': disk.total, 'used': disk.used, 'free': disk.free},
            'journal': command(['journalctl', '--disk-usage']),
            'docker': command(['docker', 'system', 'df']),
            'logs': command(['du', '-sh', '/var/log']),
            'releases': [{'root': root, 'policy': 'protected_pending_reference_review',
                          **command(['du', '-sh', root])} for root in (
                              '/opt/muse/cloud-pilot/releases', '/opt/muse/market/releases',
                              '/opt/muse/media-gateway/releases')],
            'journalRetentionManagedHere': False, 'applicationReleaseDeletionEnabled': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    value = report()
    private_write(args.output, (json.dumps(value, indent=2) + '\n').encode(), os.getuid(), os.getgid())
    print(json.dumps({'mode': value['mode'], 'deleted': 0, 'freeBytes': value['disk']['free']}))
