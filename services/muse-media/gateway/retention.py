"""Single-writer media retention, transfer leases and a continuous dry-run approval gate."""

import asyncio
from collections import Counter
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import stat
import uuid

from configuration import Failure, document


@dataclass(frozen=True)
class Rules:
    """Explicit deployment settings; changing policy restarts the observation window."""

    mode: str
    interval_seconds: int
    acknowledged_seconds: int
    unacknowledged_seconds: int
    lease_seconds: int
    maximum_bytes: int
    high_bytes: int
    low_bytes: int
    preview_seconds: int
    maximum_gap_seconds: int
    max_inventory_rows: int
    max_delete_directories: int
    max_delete_bytes: int
    audit_days: int
    disk_warn_percent: int
    disk_clean_percent: int
    disk_stop_percent: int
    staging_seconds: int
    approval_file: str

    def __post_init__(self):
        if self.mode not in ('dry-run', 'enabled') or not Path(self.approval_file).is_absolute():
            raise ValueError('Invalid retention mode or approval path')
        for key, value in asdict(self).items():
            if key in ('mode', 'approval_file'):
                continue
            if type(value) is not int or value <= 0:
                raise ValueError('Retention limits must be positive integers')
        if not (self.low_bytes < self.high_bytes < self.maximum_bytes) or self.preview_seconds < 86400 or self.maximum_gap_seconds < self.interval_seconds or self.acknowledged_seconds < 86400 or self.unacknowledged_seconds < self.acknowledged_seconds or self.lease_seconds < 7200:
            raise ValueError('Inconsistent retention limits')
        if not 0 < self.disk_warn_percent < self.disk_clean_percent < self.disk_stop_percent < 100 or self.staging_seconds < 86400:
            raise ValueError('Invalid retention disk limits')

    @classmethod
    def load(cls, path):
        return cls(**document(path, 65536))

    def digest(self):
        value = asdict(self)
        value.pop('mode')
        return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def code_digest():
    """Bind approval to the exact runtime modules that admit, stream and delete media."""
    digest = hashlib.sha256()
    for name in ('app.py', 'configuration.py', 'ledger.py', 'projection.py', 'retention.py'):
        digest.update(name.encode())
        digest.update(Path(__file__).with_name(name).read_bytes())
    return digest.hexdigest()


def timestamp(value):
    """Require an aware upstream timestamp; malformed inventory blocks the whole sweep."""
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError('Inventory timestamp has no timezone')
    return parsed.timestamp()


class Retention:
    """The gateway owns the lock; no second process may delete managed media."""

    def __init__(self, gateway, rules):
        self.gateway, self.rules = gateway, rules
        self.db, self.clock = gateway.ledger.db, gateway.clock
        self.lock = asyncio.Lock()
        self.code_hash = code_digest()
        self.policy_hash = rules.digest() if rules else None

    def lease(self, row, entry):
        """Protect one owned transfer through the longest supported local import deadline."""
        if self.db.execute('SELECT 1 FROM media_deletions WHERE state<>\'deleted\'').fetchone():
            raise Failure(503, 'media_cleanup_reconciling')
        current = self.gateway.ledger.owned(row['account_id'], row['job_id'])
        if current['state'] not in ('cloud_saved', 'partial') or entry not in json.loads(current['files']):
            raise Failure(404, 'file_not_found')
        token = str(uuid.uuid4())
        seconds = self.rules.lease_seconds if self.rules else 7200
        self.db.execute('INSERT INTO media_receipts VALUES (?,?,?,?,?,?,NULL)',
                        (token, row['job_id'], entry['name'], entry['sha256'], self.clock(), self.clock() + seconds))
        return token

    def acknowledge(self, account, job_id, name, value):
        """An owner may acknowledge only its exact, unexpired issued file lease and digest."""
        if not isinstance(value, dict) or set(value) != {'lease', 'sha256'} or not isinstance(value['lease'], str) or not isinstance(value['sha256'], str):
            raise Failure(400, 'invalid_import_receipt')
        self.gateway.ledger.owned(account, job_id)
        row = self.db.execute('SELECT * FROM media_receipts WHERE token=? AND job_id=? AND name=? AND sha256=?',
                              (value['lease'], job_id, name, value['sha256'])).fetchone()
        if row is None or row['lease_until'] < self.clock() and row['imported_at'] is None:
            raise Failure(409, 'import_receipt_expired')
        self.db.execute('UPDATE media_receipts SET imported_at=COALESCE(imported_at,?),lease_until=? WHERE token=?',
                        (self.clock(), self.clock(), value['lease']))
        return {'state': 'acknowledged'}

    def download_admission(self):
        """Refuse new submissions while a deletion is unresolved or the last measured cache is full."""
        if not self.rules:
            return
        if self.db.execute("SELECT 1 FROM media_deletions WHERE state<>'deleted'").fetchone():
            raise Failure(429, 'media_cleanup_reconciling', 300)
        disk = shutil.disk_usage(Path(self.gateway.config.database_file).parent)
        if (disk.total - disk.free) * 100 >= disk.total * self.rules.disk_stop_percent:
            raise Failure(429, 'media_disk_full', 300)
        row = self.db.execute("SELECT payload FROM media_audits WHERE kind='sweep' ORDER BY id DESC LIMIT 1").fetchone()
        if row:
            value = json.loads(row[0])
            if value.get('volume_bytes', 0) >= self.rules.maximum_bytes:
                raise Failure(429, 'media_storage_limit', 300)

    async def api(self, method, path):
        """Use only fixed DTK media endpoints and the existing server-only service key."""
        status, _, body = await self.gateway.bounded(method, self.gateway.config.upstream_origin + path,
            headers={'authorization': 'Bearer ' + self.gateway.key, 'accept': 'application/json'})
        if status != 200:
            raise ValueError('Retention upstream unavailable')
        value = json.loads(body)
        if value.get('success') is not True or not isinstance(value.get('data'), dict):
            raise ValueError('Invalid retention response')
        return value['data']

    async def inventory(self):
        """Read every inventory row, including shared, pinned, removed and unfinished records."""
        items, total = [], None
        while total is None or len(items) < total:
            page = await self.api('GET', '/api/v1/downloads?limit=100&offset=' + str(len(items)))
            if type(page.get('total')) is not int or not isinstance(page.get('items'), list):
                raise ValueError('Invalid media inventory')
            if total is not None and total != page['total'] or page['total'] > self.rules.max_inventory_rows:
                raise ValueError('Media inventory changed or exceeds limit')
            total = page['total']
            if len(items) < total and not page['items']:
                raise ValueError('Incomplete media inventory')
            items.extend(page['items'])
        if len(items) != total or len({row['id'] for row in items}) != total:
            raise ValueError('Duplicate media inventory')
        for row in items:
            uuid.UUID(row['id'])
            if not isinstance(row['directory'], str) or type(row['pinned']) is not bool or type(row['on_disk']) is not bool or type(row['bytes_total']) is not int or row['bytes_total'] < 0 or not isinstance(row['state'], str):
                raise ValueError('Invalid media inventory row')
            timestamp(row['created_at'])
            if not isinstance(row['files'], list):
                raise ValueError('Invalid media manifest')
        return items

    def plan(self, inventory, now):
        """Group by physical directory; every owner and file must permit removal."""
        jobs = [dict(row) for row in self.db.execute("SELECT * FROM jobs WHERE tool='download_media'")]
        by_id = {}
        for job in jobs:
            by_id.setdefault(job['upstream_download'], []).append(job)
        pending = any(row['state'] in ('pending', 'submitting', 'unconfirmed') for row in jobs)
        groups = {}
        for item in inventory:
            groups.setdefault(item['directory'], []).append(item)
        output = []
        for directory, rows in groups.items():
            reason = None
            deadline = 0
            if not directory or not any(row['on_disk'] for row in rows):
                continue
            if pending:
                reason = 'unreconciled_download'
            for row in rows:
                if row['pinned']:
                    reason = 'pinned'
                    break
                if row['state'] not in ('completed', 'partial', 'failed', 'cancelled'):
                    reason = 'unfinished'
                    break
                refs = by_id.get(row['id'], [])
                if not refs:
                    reason = 'unmanaged_reference'
                    break
                for job in refs:
                    if job['state'] not in ('cloud_saved', 'partial', 'failed'):
                        reason = 'unreconciled_download'
                        break
                    files = json.loads(job['files'])
                    if not files:
                        # Failed/orphaned data cannot be attributed safely from an empty manifest.
                        reason = 'manifest_unknown'
                        break
                    for file in files:
                        claims = self.db.execute('SELECT * FROM media_receipts WHERE job_id=? AND name=? AND sha256=?',
                                                 (job['job_id'], file['name'], file['sha256'])).fetchall()
                        if any(claim['lease_until'] > now for claim in claims):
                            reason = 'active_transfer'
                        ack = [claim['imported_at'] for claim in claims if claim['imported_at'] is not None]
                        base = max(job['created_at'], timestamp(row['created_at']))
                        deadline = max(deadline, max(ack) + self.rules.acknowledged_seconds if ack else base + self.rules.unacknowledged_seconds)
            if not reason and now < deadline:
                reason = 'retention_period'
            output.append({'resource': hashlib.sha256(directory.encode()).hexdigest(), 'download_id': rows[0]['id'],
                           'bytes': max(row['bytes_total'] for row in rows), 'eligible': reason is None,
                           'reason': reason or 'retention_expired', 'deadline': deadline})
        return output

    def audit(self, kind, value):
        self.db.execute('INSERT INTO media_audits(created_at,kind,policy_hash,code_hash,payload) VALUES (?,?,?,?,?)',
                        (self.clock(), kind, self.policy_hash, self.code_hash, json.dumps(value, sort_keys=True)))

    def review(self, start=None, end=None):
        """Require uninterrupted 24-hour observation of this exact policy and executable code."""
        now = self.clock()
        rows = self.db.execute("SELECT * FROM media_audits WHERE kind='sweep' AND created_at>=? AND created_at<=? ORDER BY id",
                               (start if start is not None else now - self.rules.preview_seconds - self.rules.maximum_gap_seconds,
                                end if end is not None else now)).fetchall()
        if len(rows) < 2:
            raise ValueError('Insufficient retention observations')
        times = [row['created_at'] for row in rows]
        if times[-1] - times[0] < self.rules.preview_seconds or max(b - a for a, b in zip(times, times[1:])) > self.rules.maximum_gap_seconds or any(b <= a for a, b in zip(times, times[1:])):
            raise ValueError('Retention observation window is short or discontinuous')
        for row in rows:
            value = json.loads(row['payload'])
            if row['policy_hash'] != self.policy_hash or row['code_hash'] != self.code_hash or value.get('mode') != 'dry-run' or value.get('error') or value.get('deleted', 0) != 0 or value.get('upstream_ceiling') != 0:
                raise ValueError('Retention observations failed review')
        return {'policy_hash': self.policy_hash, 'code_hash': self.code_hash, 'start': times[0], 'end': times[-1], 'observations': len(rows)}

    def approved(self):
        approval = document(self.rules.approval_file, 65536)
        expected = self.review(approval['start'], approval['end'])
        if approval != expected:
            raise ValueError('Retention approval does not match observations')

    async def sweep(self):
        """Preview every decision; enabled deletion rechecks inventory while holding the admission lock."""
        async with self.lock:
            result = {'mode': self.rules.mode, 'deleted': 0, 'freed_bytes': 0}
            try:
                storage = await self.api('GET', '/api/v1/downloads/storage')
                if storage.get('max_bytes') != 0 or storage.get('downloader', {}).get('available') is not True:
                    raise ValueError('The independent upstream eviction must be disabled')
                volume = storage['downloader']['volume_bytes']
                if type(volume) is not int or volume < 0:
                    raise ValueError('Invalid media usage')
                disk = shutil.disk_usage(Path(self.gateway.config.database_file).parent)
                disk_percent = (disk.total - disk.free) * 100 / disk.total
                pressure = volume >= self.rules.high_bytes or disk_percent >= self.rules.disk_clean_percent
                result.update(volume_bytes=volume, upstream_ceiling=0, disk_percent=round(disk_percent, 2),
                              warning=disk_percent >= self.rules.disk_warn_percent, pressure=pressure)
                inventory = await self.inventory()
                decisions = self.plan(inventory, self.clock())
                result['decisions'] = decisions
                result['protected'] = dict(Counter(row['reason'] for row in decisions if not row['eligible']))
                if self.rules.mode == 'enabled':
                    self.approved()
                    # Unknown delete outcomes remain fenced across restart; a human must reconcile them.
                    if self.db.execute("SELECT 1 FROM media_deletions WHERE state<>'deleted'").fetchone():
                        raise ValueError('A prior deletion requires reconciliation')
                    for candidate in sorted((row for row in decisions if row['eligible']), key=lambda row: row['deadline']):
                        if pressure and volume - result['freed_bytes'] <= self.rules.low_bytes:
                            break
                        if result['deleted'] >= self.rules.max_delete_directories or result['freed_bytes'] + candidate['bytes'] > self.rules.max_delete_bytes:
                            break
                        latest = self.plan(await self.inventory(), self.clock())
                        if not any(row == candidate for row in latest):
                            raise ValueError('Retention candidate changed')
                        self.db.execute('INSERT INTO media_deletions VALUES (?,?,?,?) ON CONFLICT(resource) DO UPDATE SET download_id=excluded.download_id,state=excluded.state,created_at=excluded.created_at', (candidate['resource'], candidate['download_id'], 'deleting', self.clock()))
                        removed = await self.api('DELETE', '/api/v1/downloads/' + candidate['download_id'] + '/files')
                        after = await self.inventory()
                        if any(row['on_disk'] and hashlib.sha256(row['directory'].encode()).hexdigest() == candidate['resource'] for row in after):
                            raise ValueError('Deletion was not confirmed')
                        self.db.execute("UPDATE media_deletions SET state='deleted' WHERE resource=?", (candidate['resource'],))
                        ids = {row['id'] for row in inventory if hashlib.sha256(row['directory'].encode()).hexdigest() == candidate['resource']}
                        for download_id in ids:
                            self.db.execute("UPDATE jobs SET state='failed',result=?,updated_at=? WHERE upstream_download=?", ('{"code":"cloud_media_evicted"}', self.clock(), download_id))
                        result['deleted'] += 1
                        result['freed_bytes'] += int(removed['freed_bytes'])
            except Exception as error:
                # Public upstream text, paths and credentials never enter the audit.
                result['error'] = type(error).__name__
            # Gateway staging is private; abandoned copies are separate from DTK media.
            staged = []
            staging = Path(self.gateway.config.database_file).parent / 'staging'
            has_leases = self.db.execute('SELECT 1 FROM media_receipts WHERE lease_until>?', (self.clock(),)).fetchone()
            if not has_leases and staging.is_dir():
                for path in staging.glob('media-*'):
                    info = path.lstat()
                    if stat.S_ISREG(info.st_mode) and info.st_mtime <= self.clock() - self.rules.staging_seconds:
                        staged.append(path)
            result['staging_candidates'] = len(staged)
            # No removal of even orphan staging bytes before the observation gate passes.
            if self.rules.mode == 'enabled' and not result.get('error'):
                self.approved()
                for path in staged:
                    path.unlink(missing_ok=True)
                self.db.execute("DELETE FROM media_audits WHERE json_extract(payload,'$.mode')='enabled' AND created_at<?", (self.clock() - self.rules.audit_days * 86400,))
            self.audit('sweep', result)
            return result

    async def run(self):
        """An owned cancellable loop; shutdown awaits its final observation."""
        while True:
            try:
                await self.sweep()
            except Exception as error:
                self.audit('sweep', {'mode': self.rules.mode, 'error': type(error).__name__, 'deleted': 0})
            await asyncio.sleep(self.rules.interval_seconds)
