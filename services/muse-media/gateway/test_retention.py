"""Retention tests use real SQLite, isolated files, controlled clocks and explicit barriers."""

import asyncio
from dataclasses import replace
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import uuid

from configuration import Failure
from ledger import Ledger
from retention import Retention, Rules


class RetentionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = 1800000000.0
        cfg = SimpleNamespace(database_file=str(self.root / 'jobs.sqlite3'), sqlite_timeout_seconds=2,
            max_downloads_per_day=20, max_downloads_global=4, max_downloads_per_account=2,
            reservation_ttl_seconds=900, max_jobs_per_page=100)
        self.ledger = Ledger(cfg, lambda: self.now)
        self.addCleanup(self.ledger.close)
        rules = json.loads(Path(__file__).with_name('retention.example.json').read_text())
        rules['approval_file'] = str(self.root / 'approval.json')
        self.rules = Rules(**rules)
        self.gateway = SimpleNamespace(ledger=self.ledger, clock=lambda: self.now, config=cfg)
        self.retention = Retention(self.gateway, self.rules)
        self.download_id = str(uuid.uuid4())
        self.data = b'private media data'
        self.sha = hashlib.sha256(self.data).hexdigest()
        self.file = {'name': 'video.mp4', 'sha256': self.sha, 'bytes': len(self.data), 'kind': 'video'}
        self.inventory = [{'id': self.download_id, 'directory': 'douyin/user/post', 'state': 'completed',
            'pinned': False, 'on_disk': True, 'bytes_total': len(self.data), 'created_at': datetime.fromtimestamp(self.now - 8 * 86400, timezone.utc).isoformat(), 'files': [self.file]}]
        self.media = self.root / 'video.mp4'
        self.media.write_bytes(self.data)
        self.calls = []
        self.before_delete = None
        self.before_inventory = None
        self.retention.api = self.api
        self.job = self.add_job('a', 'first', self.download_id)

    def add_job(self, account, request, download_id):
        row, _ = self.ledger.create(account, 'download_media', {'request_id': request, 'url': 'https://www.douyin.com/video/1'})
        self.ledger.db.execute('UPDATE jobs SET created_at=? WHERE job_id=?', (self.now - 8 * 86400, row['job_id']))
        return self.ledger.update(self.ledger.owned(account, row['job_id']), 'cloud_saved', download=download_id, files=[self.file])

    async def api(self, method, path):
        self.calls.append((method, path))
        if path.endswith('/storage'):
            return {'max_bytes': 0, 'downloader': {'available': True, 'volume_bytes': self.media.stat().st_size if self.media.exists() else 0}}
        if path.startswith('/api/v1/downloads?'):
            if self.before_inventory:
                self.before_inventory()
            return {'total': len(self.inventory), 'items': [dict(row) for row in self.inventory]}
        if method == 'DELETE':
            if self.before_delete:
                await self.before_delete()
            self.media.unlink()
            for row in self.inventory:
                row['on_disk'] = False
            return {'freed_bytes': len(self.data), 'downloads': 1}
        raise AssertionError((method, path))

    def history(self, *, error=False, gap=False, altered=False):
        start = self.now - 86400
        for i in range(289):
            if gap and 100 <= i <= 103:
                continue
            self.now = start + i * 300
            self.retention.audit('sweep', {'mode': 'dry-run', 'deleted': 0, 'upstream_ceiling': 0,
                **({'error': 'ValueError'} if error and i == 10 else {})})
        if altered:
            self.ledger.db.execute('UPDATE media_audits SET code_hash=\'other\' WHERE id=10')

    def enable(self):
        report = self.retention.review()
        Path(self.rules.approval_file).write_text(json.dumps(report))
        self.retention.rules = replace(self.rules, mode='enabled')

    async def test_preview_does_not_delete_even_eligible_and_orphan_staging(self):
        staging = self.root / 'staging'
        staging.mkdir()
        stale = staging / 'media-orphan'
        stale.write_bytes(b'orphan')
        import os
        os.utime(stale, (self.now - 90000, self.now - 90000))
        result = await self.retention.sweep()
        self.assertTrue(result['decisions'][0]['eligible'])
        self.assertEqual(result['staging_candidates'], 1)
        self.assertEqual(result['deleted'], 0)
        self.assertEqual(self.media.read_bytes(), self.data)
        self.assertTrue(stale.exists())
        self.assertFalse(any(method == 'DELETE' for method, _ in self.calls))

    async def test_owner_exact_digest_lease_and_full_shared_reference_deadlines(self):
        token = self.retention.lease(self.job, self.file)
        with self.assertRaises(Failure):
            self.retention.acknowledge('b', self.job['job_id'], 'video.mp4', {'lease': token, 'sha256': self.sha})
        with self.assertRaises(Failure):
            self.retention.acknowledge('a', self.job['job_id'], 'video.mp4', {'lease': token, 'sha256': '0' * 64})
        self.assertEqual(self.retention.plan(self.inventory, self.now)[0]['reason'], 'active_transfer')
        self.retention.acknowledge('a', self.job['job_id'], 'video.mp4', {'lease': token, 'sha256': self.sha})
        self.now += 86401
        self.assertTrue(self.retention.plan(self.inventory, self.now)[0]['eligible'])
        other = self.add_job('b', 'shared', self.download_id)
        self.ledger.db.execute('UPDATE jobs SET created_at=? WHERE job_id=?', (self.now, other['job_id']))
        self.assertEqual(self.retention.plan(self.inventory, self.now)[0]['reason'], 'retention_period')
        self.now += 7 * 86400 + 1
        self.assertTrue(self.retention.plan(self.inventory, self.now)[0]['eligible'])

    async def test_two_transfers_one_ack_keeps_other_lease_protected(self):
        first = self.retention.lease(self.job, self.file)
        self.retention.lease(self.job, self.file)
        self.retention.acknowledge('a', self.job['job_id'], 'video.mp4', {'lease': first, 'sha256': self.sha})
        self.assertEqual(self.retention.plan(self.inventory, self.now)[0]['reason'], 'active_transfer')

    async def test_pinned_unknown_unfinished_and_pending_protect_entire_directory(self):
        for patch, reason in [({'pinned': True}, 'pinned'), ({'id': str(uuid.uuid4())}, 'unmanaged_reference'), ({'state': 'running'}, 'unfinished')]:
            shared = {**self.inventory[0], **patch}
            self.assertEqual(self.retention.plan(self.inventory + [shared], self.now)[0]['reason'], reason)
        self.ledger.create('c', 'download_media', {'request_id': 'uncertain'})
        self.assertEqual(self.retention.plan(self.inventory, self.now)[0]['reason'], 'unreconciled_download')

    async def test_short_gapped_failed_changed_and_clock_regression_previews_cannot_enable(self):
        with self.assertRaises(ValueError):
            self.retention.review()
        for options in ({'gap': True}, {'error': True}, {'altered': True}):
            self.ledger.db.execute('DELETE FROM media_audits')
            self.history(**options)
            with self.assertRaises(ValueError):
                self.retention.review()
        self.ledger.db.execute('DELETE FROM media_audits')
        self.history()
        self.ledger.db.execute('UPDATE media_audits SET created_at=created_at-900 WHERE id=(SELECT MIN(id)+5 FROM media_audits)')
        with self.assertRaises(ValueError):
            self.retention.review()

    async def test_approved_deletion_removes_bytes_and_preserves_receipt_as_evicted(self):
        self.history()
        self.enable()
        result = await self.retention.sweep()
        self.assertNotIn('error', result)
        self.assertEqual(result['deleted'], 1)
        self.assertFalse(self.media.exists())
        row = self.ledger.public(self.ledger.owned('a', self.job['job_id']))
        self.assertEqual(row['code'], 'cloud_media_evicted')
        self.assertEqual(row['files'], [self.file])
        self.assertFalse(row['automatic_resubmit'])

    async def test_mode_toggle_without_approval_never_deletes(self):
        self.retention.rules = replace(self.rules, mode='enabled')
        result = await self.retention.sweep()
        self.assertIn('error', result)
        self.assertTrue(self.media.exists())

    async def test_recheck_after_pin_change_refuses_deletion(self):
        self.history()
        self.enable()
        calls = 0
        def pin_on_second_inventory():
            nonlocal calls
            calls += 1
            if calls == 2:
                self.inventory[0]['pinned'] = True
        self.before_inventory = pin_on_second_inventory
        result = await self.retention.sweep()
        self.assertIn('error', result)
        self.assertFalse(any(method == 'DELETE' for method, _ in self.calls))
        self.assertTrue(self.media.exists())

    async def test_delete_failure_is_fenced_and_blocks_new_transfers_and_submissions(self):
        self.history()
        self.enable()
        async def fail():
            raise TimeoutError('secret upstream URL')
        self.before_delete = fail
        result = await self.retention.sweep()
        self.assertEqual(result['error'], 'TimeoutError')
        self.assertNotIn('secret', json.dumps(result))
        with self.assertRaises(Failure):
            self.retention.lease(self.job, self.file)
        with self.assertRaises(Failure):
            self.retention.download_admission()
        self.assertTrue(self.media.exists())
        self.ledger.close()
        self._cleanups.pop()
        self.ledger = Ledger(self.gateway.config, lambda: self.now)
        self.addCleanup(self.ledger.close)
        self.assertEqual(self.ledger.db.execute('SELECT state FROM media_deletions').fetchone()[0], 'deleting')

    async def test_admission_lock_excludes_lease_grant_during_delete(self):
        self.history()
        self.enable()
        entered, release = asyncio.Event(), asyncio.Event()
        async def barrier():
            entered.set()
            await release.wait()
        self.before_delete = barrier
        sweep = asyncio.create_task(self.retention.sweep())
        await asyncio.wait_for(entered.wait(), 2)
        async def acquire():
            async with self.retention.lock:
                return self.retention.lease(self.job, self.file)
        claim = asyncio.create_task(acquire())
        await asyncio.sleep(0)
        self.assertFalse(claim.done())
        release.set()
        await sweep
        with self.assertRaises(Failure):
            await claim

    async def test_schema_one_upgrades_without_changing_original_job(self):
        self.ledger.db.execute('PRAGMA user_version=1')
        before = self.ledger.db.execute('SELECT * FROM jobs').fetchone()
        self.ledger.close()
        self._cleanups.pop()
        self.ledger = Ledger(self.gateway.config, lambda: self.now)
        self.addCleanup(self.ledger.close)
        self.assertEqual(tuple(self.ledger.db.execute('SELECT * FROM jobs').fetchone()), tuple(before))
        self.assertEqual(self.ledger.db.execute('PRAGMA user_version').fetchone()[0], 2)
