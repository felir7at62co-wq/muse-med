"""Promotion tests never invoke Docker or change real systemd configuration."""

from dataclasses import asdict
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'gateway'))
from retention import Rules, code_digest
from ledger import Ledger
from types import SimpleNamespace


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


control = load('retention_control')
schedule = load('retention_schedule')
preparer = load('retention_prepare')


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.database = self.root / 'jobs.sqlite3'
        cfg = SimpleNamespace(database_file=str(self.database), sqlite_timeout_seconds=2)
        self.ledger = Ledger(cfg)
        self.addCleanup(self.ledger.close)
        self.rules = Rules(**json.loads((Path(__file__).parent.parent / 'gateway/retention.example.json').read_text()))
        self.path = self.root / 'retention.json'
        self.path.write_text(json.dumps(asdict(self.rules)))
        self.path.chmod(0o600)
        self.attestation = self.root / 'qualification.json'
        self.attestation.write_text(json.dumps({'passed': True, 'code_hash': code_digest(), 'checks': {
            name: {'passed': True, 'count': 1} for name in ('gateway_runtime', 'retention_isolation', 'native_import', 'media_snapshot')}}))
        self.attestation.chmod(0o600)
        self.now = time.time()

    def history(self, failure=False):
        for i in range(289):
            self.ledger.db.execute('INSERT INTO media_audits(created_at,kind,policy_hash,code_hash,payload) VALUES (?,?,?,?,?)',
                (self.now - 86400 + i * 300, 'sweep', self.rules.digest(), code_digest(), json.dumps({
                    'mode': 'dry-run', 'deleted': 0, 'upstream_ceiling': 0,
                    **({'error': 'UpstreamUnavailable'} if failure and i == 20 else {})})))

    def test_prepare_preserves_private_settings_and_refuses_a_second_start(self):
        private = self.root / 'private'
        private.mkdir()
        env = private / 'compose.env'
        env.write_text('MUSE_MEDIA_IMAGE=muse-company-media:old\nMUSE_MEDIA_UID=999\nCUSTOM=preserved\n')
        env.chmod(0o600)
        with closing(sqlite3.connect(self.root / 'gateway.sqlite3')) as backup:
            self.ledger.db.backup(backup)
        calls = []
        def upstream(_admin, method, path, data=None):
            calls.append((method, path, data))
            return {'settings': [{'key': 'media.max_bytes', 'value': 20 * 1024**3 if len(calls) == 1 else 0}]}
        with patch.object(preparer, 'upstream', upstream):
            result = preparer.prepare(private, self.root, 'muse-company-media:reviewed', private / 'admin.json')
            self.assertEqual(result['mode'], 'dry-run')
            self.assertEqual(json.loads((private / 'retention.json').read_text())['mode'], 'dry-run')
            self.assertIn('CUSTOM=preserved', env.read_text())
            self.assertIn('MUSE_MEDIA_RETENTION_CONFIG=/run/secrets/retention.json', env.read_text())
            with closing(sqlite3.connect(result['backup'])) as db:
                self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 2)
            with self.assertRaises(ValueError):
                preparer.prepare(private, self.root, 'muse-company-media:reviewed', private / 'admin.json')
            self.assertEqual(len(calls), 3)

    def test_short_failed_changed_and_unqualified_cannot_publish_approval(self):
        original = self.path.read_bytes()
        for history in ('short', 'error'):
            self.ledger.db.execute('DELETE FROM media_audits')
            if history == 'error':
                self.history(True)
            with patch.object(control, 'verify_image') as verify:
                with self.assertRaises(ValueError):
                    control.promote(self.database, self.path, self.attestation, 'compose.yml', 'env')
                verify.assert_not_called()
            self.assertEqual(self.path.read_bytes(), original)
            self.assertFalse((self.root / 'retention-approval.json').exists())
        self.ledger.db.execute('DELETE FROM media_audits')
        self.history()
        self.attestation.write_text('{"passed":true,"code_hash":"wrong"}')
        self.attestation.chmod(0o600)
        with self.assertRaises(ValueError):
            control.review(self.database, self.path, self.attestation)

    def test_promotion_only_after_complete_review_and_matching_runtime(self):
        self.history()
        restarted = []
        with patch.object(control, 'verify_image', return_value=['docker']) as verify:
            result = control.promote(self.database, self.path, self.attestation, 'compose.yml', 'env', restart=lambda: restarted.append(True))
        verify.assert_called_once()
        self.assertEqual(result['state'], 'enabled')
        self.assertEqual(restarted, [True])
        self.assertEqual(json.loads(self.path.read_text())['mode'], 'enabled')
        approval = json.loads((self.root / 'retention-approval.json').read_text())
        self.assertEqual(approval['observations'], 289)
        self.assertGreaterEqual(approval['end'] - approval['start'], 86400)

    def test_uncertain_restart_returns_policy_to_dry_run(self):
        self.history()
        def fail():
            raise TimeoutError()
        with patch.object(control, 'verify_image', return_value=['docker']):
            with self.assertRaises(TimeoutError):
                control.promote(self.database, self.path, self.attestation, 'compose.yml', 'env', restart=fail)
        self.assertEqual(json.loads(self.path.read_text())['mode'], 'dry-run')

    def test_running_image_mismatch_blocks_publication(self):
        self.history()
        with patch.object(control.subprocess, 'run', return_value=SimpleNamespace(stdout='different-source')):
            with self.assertRaises(ValueError):
                control.promote(self.database, self.path, self.attestation, 'compose.yml', 'env')
        self.assertEqual(json.loads(self.path.read_text())['mode'], 'dry-run')

    def test_activation_report_requires_an_actual_successful_enabled_sweep(self):
        self.ledger.db.execute('INSERT INTO media_audits(created_at,kind,policy_hash,code_hash,payload) VALUES (?,?,?,?,?)',
            (self.now, 'sweep', self.rules.digest(), code_digest(), '{"mode":"enabled","deleted":0}'))
        control.verify_enabled(self.database, code_digest(), self.now - 1)
        self.ledger.db.execute('UPDATE media_audits SET payload=?', (json.dumps({'mode': 'enabled', 'error': 'ValueError'}),))
        with self.assertRaises(ValueError):
            control.verify_enabled(self.database, code_digest(), self.now - 1)
        with self.assertRaises(TimeoutError):
            control.verify_enabled(self.database, code_digest(), self.now + 1, timeout=0)

    def test_persistent_timer_is_after_24_hours_and_has_no_delete_command(self):
        due, service, timer = schedule.units('/opt/muse/media-gateway/releases/reviewed', self.now, 86400)
        from datetime import datetime
        self.assertGreaterEqual(datetime.fromisoformat(due).timestamp(), self.now + 86400)
        self.assertIn('Persistent=true', timer)
        self.assertIn('retention_control.py promote', service)
        self.assertNotIn('rm ', service)
        self.assertNotIn('prune', service)
        with self.assertRaises(ValueError):
            schedule.units('/opt/muse/untrusted path', self.now, 86400)
