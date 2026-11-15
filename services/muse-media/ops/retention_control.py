"""Review continuous dry-run evidence and promote only a tested, matching runtime."""

import argparse
from dataclasses import asdict
from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'gateway'))
from retention import Retention, Rules, code_digest
from prepare import read_private, private_write


MODULES = ('app.py', 'configuration.py', 'ledger.py', 'projection.py', 'retention.py')


def review(database, rules_file, attestation_file):
    """Read the durable observation window without opening or migrating the live ledger."""
    rules = Rules.load(rules_file)
    attestation = json.loads(read_private(attestation_file))
    if attestation.get('code_hash') != code_digest() or attestation.get('passed') is not True:
        raise ValueError('The runtime lacks matching passed qualification')
    for name in ('gateway_runtime', 'retention_isolation', 'native_import', 'media_snapshot'):
        check = attestation.get('checks', {}).get(name, {})
        if check.get('passed') is not True or type(check.get('count')) is not int or check['count'] <= 0:
            raise ValueError('Missing required qualification: ' + name)
    db = sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        if db.execute('PRAGMA user_version').fetchone()[0] != 2:
            raise ValueError('The retention ledger has not been upgraded')
        gateway = SimpleNamespace(ledger=SimpleNamespace(db=db), clock=time.time)
        retention = Retention(gateway, rules)
        approval = retention.review()
        last = db.execute("SELECT payload,created_at FROM media_audits WHERE kind='sweep' ORDER BY id DESC LIMIT 1").fetchone()
        if last is None or time.time() - last['created_at'] > rules.maximum_gap_seconds:
            raise ValueError('The retention loop is no longer observing')
        if db.execute("SELECT 1 FROM media_deletions WHERE state<>'deleted'").fetchone():
            raise ValueError('A deletion is awaiting reconciliation')
        return rules, approval
    finally:
        db.close()


def verify_image(compose_file, env_file, expected_hash):
    """Verify the running image's source modules without exposing its environment or credentials."""
    command = ['docker', 'compose', '--env-file', str(env_file), '-f', str(compose_file)]
    script = "from retention import code_digest; print(code_digest())"
    result = subprocess.run(command + ['exec', '-T', 'gateway', 'python', '-c', script],
                            check=True, capture_output=True, text=True, timeout=30)
    if result.stdout.strip() != expected_hash:
        raise ValueError('The running gateway differs from the reviewed source')
    return command


def verify_enabled(database, expected_hash, started, timeout=60):
    """Require an actual successful enabled sweep before reporting activation."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with closing(sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True)) as db:
            row = db.execute("SELECT payload,code_hash FROM media_audits WHERE kind='sweep' AND created_at>=? ORDER BY id DESC LIMIT 1", (started,)).fetchone()
        if row:
            value = json.loads(row[0])
            if row[1] == expected_hash and value.get('mode') == 'enabled' and not value.get('error'):
                return
            if value.get('error'):
                raise ValueError('Enabled retention failed its first observation')
        time.sleep(1)
    raise TimeoutError('Enabled retention did not report readiness')


def promote(database, rules_file, attestation_file, compose_file, env_file, *, restart=None):
    """Approval precedes mode publication; failed review leaves both runtime and policy unchanged."""
    rules, approval = review(database, rules_file, attestation_file)
    if rules.mode != 'dry-run':
        raise ValueError('Only a dry-run policy can be promoted')
    command = verify_image(compose_file, env_file, approval['code_hash'])
    target = Path(rules_file)
    owner = target.stat()
    if Path(rules.approval_file).parent != Path('/run/secrets'):
        raise ValueError('The approval must use the read-only container secrets mount')
    approval_target = target.parent / Path(rules.approval_file).name
    private_write(approval_target, (json.dumps(approval, indent=2) + '\n').encode(), owner.st_uid, owner.st_gid)
    enabled = {**asdict(rules), 'mode': 'enabled'}
    private_write(target, (json.dumps(enabled, indent=2) + '\n').encode(), owner.st_uid, owner.st_gid)
    started = time.time()
    try:
        if restart:
            restart()
        else:
            subprocess.run(command + ['up', '-d', '--no-deps', '--force-recreate', 'gateway'], check=True, timeout=120)
            verify_image(compose_file, env_file, approval['code_hash'])
            verify_enabled(database, approval['code_hash'], started)
    except Exception:
        # An uncertain restart must return to the non-deleting policy before a later operator retry.
        private_write(target, (json.dumps(asdict(rules), indent=2) + '\n').encode(), owner.st_uid, owner.st_gid)
        raise
    return {'state': 'enabled', 'approval': approval, 'reviewedAt': datetime.now(timezone.utc).isoformat()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('review', 'promote'))
    parser.add_argument('--database', type=Path, default=Path('/var/lib/muse-media/gateway.sqlite3'))
    parser.add_argument('--rules', type=Path, default=Path('/etc/muse/media-gateway/retention.json'))
    parser.add_argument('--attestation', type=Path, default=Path('/etc/muse/media-gateway/retention-qualification.json'))
    parser.add_argument('--compose', type=Path, default=Path(__file__).with_name('compose.yml'))
    parser.add_argument('--env-file', type=Path, default=Path('/etc/muse/media-gateway/compose.env'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.action == 'promote':
            result = promote(args.database, args.rules, args.attestation, args.compose, args.env_file)
        else:
            _, report = review(args.database, args.rules, args.attestation)
            result = {'state': 'review_passed', 'approval': report}
    except Exception as error:
        result = {'state': 'review_blocked', 'code': type(error).__name__,
                  'reviewedAt': datetime.now(timezone.utc).isoformat()}
        args.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        private_write(args.output, (json.dumps(result, indent=2) + '\n').encode(), os.getuid(), os.getgid())
        print(json.dumps(result))
        return 1
    args.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    private_write(args.output, (json.dumps(result, indent=2) + '\n').encode(), os.getuid(), os.getgid())
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
