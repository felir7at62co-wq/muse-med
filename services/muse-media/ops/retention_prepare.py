"""Prepare a non-deleting retention deployment while preserving the live account service."""

import argparse
from contextlib import closing
from dataclasses import asdict
from datetime import datetime, timezone
import http.cookiejar
import json
import os
from pathlib import Path
import sqlite3
import sys
import urllib.request

from prepare import private_write, read_private

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'gateway'))
from retention import Rules, code_digest


def upstream(admin_file, method, path, data=None):
    """Authenticate privately; return only parsed data, never the cookie or admin response text."""
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), urllib.request.ProxyHandler({}))
    base = 'http://127.0.0.1:19580'
    def call(method, path, value=None):
        request = urllib.request.Request(base + path, method=method,
            headers={'Content-Type': 'application/json'}, data=json.dumps(value).encode() if value is not None else None)
        with opener.open(request, timeout=15) as response:
            body = response.read(1048577)
        if len(body) > 1048576:
            raise ValueError('Upstream response exceeds the deployment limit')
        return json.loads(body)['data']
    call('POST', '/api/v1/auth/login', json.loads(read_private(admin_file)))
    return call(method, path, data)


def prepare(private_dir, state_dir, image, admin_file):
    """Back up SQLite consistently, install dry-run rules and stop the independent media evictor."""
    if not image.startswith('muse-company-media:') or any(char.isspace() for char in image):
        raise ValueError('Invalid immutable media image')
    private_dir, state_dir = Path(private_dir), Path(state_dir)
    rules_file = private_dir / 'retention.json'
    if rules_file.exists():
        raise ValueError('Retention is already prepared; inspect its history instead of resetting it')
    env_file = private_dir / 'compose.env'
    original_env = read_private(env_file)
    owner = env_file.stat()
    rules = Rules(**json.loads((Path(__file__).parent.parent / 'gateway/retention.example.json').read_text()))
    if rules.mode != 'dry-run':
        raise ValueError('Initial retention deployment must be dry-run')
    database = state_dir / 'gateway.sqlite3'
    backup = state_dir / ('pre-retention-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.sqlite3')
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(backup)) as target:
        source.backup(target)
    backup.chmod(0o600)
    # Do not print any of the other private settings or credentials.
    settings = upstream(admin_file, 'GET', '/api/v1/admin/settings')
    previous = next(row['value'] for row in settings['settings'] if row['key'] == 'media.max_bytes')
    baseline = {'preparedAt': datetime.now(timezone.utc).isoformat(), 'previousUpstreamCeiling': previous,
                'backup': str(backup), 'code_hash': code_digest(), 'mode': 'dry-run'}
    private_write(private_dir / 'retention-baseline.json', (json.dumps(baseline, indent=2) + '\n').encode(), owner.st_uid, owner.st_gid)
    private_write(private_dir / 'compose.pre-retention.env', original_env, owner.st_uid, owner.st_gid)
    private_write(rules_file, (json.dumps(asdict(rules), indent=2) + '\n').encode(), owner.st_uid, owner.st_gid)
    upstream(admin_file, 'PUT', '/api/v1/admin/settings/media.max_bytes', {'value': 0})
    observed = upstream(admin_file, 'GET', '/api/v1/admin/settings')
    if next(row['value'] for row in observed['settings'] if row['key'] == 'media.max_bytes') != 0:
        raise ValueError('The independent media cleaner remains enabled')
    lines = [line for line in original_env.decode().splitlines() if not line.startswith(('MUSE_MEDIA_IMAGE=', 'MUSE_MEDIA_RETENTION_CONFIG='))]
    lines.extend(['MUSE_MEDIA_IMAGE=' + image, 'MUSE_MEDIA_RETENTION_CONFIG=/run/secrets/retention.json'])
    private_write(env_file, ('\n'.join(lines) + '\n').encode(), owner.st_uid, owner.st_gid)
    return baseline


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--private-dir', type=Path, default=Path('/etc/muse/media-gateway'))
    parser.add_argument('--state-dir', type=Path, default=Path('/var/lib/muse-media'))
    parser.add_argument('--admin-file', type=Path, default=Path('/etc/muse/dtk-admin.json'))
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.private_dir, args.state_dir, args.image, args.admin_file)))
