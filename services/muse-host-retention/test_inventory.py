"""Reference and planner tests use isolated release trees and explicit controlled snapshots."""

import json
import os
from pathlib import Path
import tempfile
import time
import unittest

from inventory import paths, tree, identity, scan
from policy import plan, load, policy_hash


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.releases = self.root / 'releases'
        self.releases.mkdir()
        self.logs = self.root / 'nginx'
        self.logs.mkdir()
        self.now = time.time()
        self.policy = json.loads(Path(__file__).with_name('policy.example.json').read_text())
        self.policy.update(release_groups=[{'name': 'web', 'root': str(self.releases), 'pattern': 'r[0-9]+', 'required_files': ['index.html']}],
                           log_roots=[str(self.logs)], pins=[], state_dir=str(self.root / 'state'))

    def release(self, name, days):
        path = self.releases / name
        path.mkdir(); (path / 'index.html').write_text(name)
        os.utime(path, (self.now - days*86400, self.now - days*86400))
        return path

    def snapshot(self, refs=(), opened=()):
        return scan(self.policy, reference_reader=lambda roots: (list(refs), list(opened)))

    def test_current_old_version_and_two_newer_rollback_choices_remain_protected(self):
        for name, days in [('r1', 50), ('r2', 40), ('r3', 30), ('r4', 20)]: self.release(name, days)
        active = str(self.releases / 'r1')
        rows = plan(self.snapshot([{'kind':'process-cwd','owner':'123','path':active}]), self.policy, self.now)
        self.assertEqual({Path(row['path']).name for row in rows if row['eligible']}, {'r2'})
        self.assertTrue(next(row for row in rows if row['path']==active)['reason'].startswith('referenced:'))

    def test_rollback_symlink_dependency_protects_an_older_release(self):
        for name,days in [('r1',50),('r2',40),('r3',30),('r4',20)]: self.release(name,days)
        (self.releases/'r4'/'dependency').symlink_to(self.releases/'r1')
        rows=plan(self.snapshot(),self.policy,self.now)
        self.assertFalse(any(row['eligible'] for row in rows))
        self.assertEqual(next(row for row in rows if Path(row['path']).name=='r1')['reason'],'retained-version-dependency')

    def test_self_receipts_do_not_pin_every_historical_release(self):
        for i in range(1,5):
            p=self.release('r'+str(i),50-i)
            (p/'deployment.json').write_text(json.dumps({'release':str(p)}))
            os.utime(p,(self.now-(50-i)*86400,)*2)
        rows=plan(self.snapshot(),self.policy,self.now)
        self.assertEqual([Path(row['path']).name for row in rows if row['eligible']],['r1'])

    def test_unknown_build_pin_and_recent_versions_are_not_candidates(self):
        for i in range(1,6): self.release('r'+str(i), 40-i)
        (self.releases/'r1'/'index.html').unlink()
        self.policy['pins']=[str(self.releases/'r2')]
        self.release('unknown',100)
        self.release('r6',1)
        rows=plan(self.snapshot(),self.policy,self.now)
        self.assertEqual(next(row for row in rows if row['path'].endswith('/r1'))['reason'],'unverified-build')
        self.assertFalse(next(row for row in rows if row['path'].endswith('/r2'))['eligible'])
        self.assertFalse(next(row for row in rows if row['path'].endswith('/unknown'))['eligible'])
        self.assertFalse(next(row for row in rows if row['path'].endswith('/r6'))['eligible'])

    def test_closed_rotated_logs_only_and_open_archives_are_protected(self):
        for name in ['access.log','access.log.20.gz','access.log.21','private.db','auth.log.22.gz']:
            p=self.logs/name;p.write_bytes(b'log');os.utime(p,(self.now-20*86400,)*2)
        rows=plan(self.snapshot(refs=[{'kind':'effective-nginx','owner':'nginx','path':str(self.logs/'access.log')}], opened=[str(self.logs/'access.log.21')]),self.policy,self.now)
        self.assertNotIn('access.log',[Path(row['path']).name for row in rows])
        self.assertEqual(next(row for row in rows if row['path'].endswith('/auth.log.22.gz'))['reason'], 'unknown-log-owner')
        self.assertEqual(next(row for row in rows if row['path'].endswith('/access.log.21'))['reason'],'open-log-file')
        self.assertTrue(next(row for row in rows if row['path'].endswith('/access.log.20.gz'))['eligible'])

    def test_reference_prefix_and_symbolic_link_escape_are_not_confused(self):
        self.assertEqual(paths('/opt/releases-old/r1', ['/opt/releases']),[])
        p=self.release('r1',40)
        (self.releases/'r2').symlink_to(p)
        rows=plan(self.snapshot(),self.policy,self.now)
        self.assertEqual(next(row for row in rows if row['path'].endswith('/r2'))['reason'],'unknown-object')
        with self.assertRaises(ValueError): plan({'complete':False},self.policy,self.now)

    def test_policy_refuses_short_windows_and_unsafe_roots(self):
        file=self.root/'policy.json';file.write_text(json.dumps(self.policy))
        self.assertEqual(load(file)['preview_seconds'],86400)
        self.policy['release_days']=1;file.write_text(json.dumps(self.policy))
        with self.assertRaises(ValueError): load(file)

    def test_tree_digest_changes_for_content_metadata_and_shared_link_updates(self):
        p=self.release('r1',40)
        before=tree(p,100)['hash'];(p/'index.html').write_text('changed')
        self.assertNotEqual(tree(p,100)['hash'],before)
        with self.assertRaises(RuntimeError): tree(p,0)

    def test_reference_failure_never_becomes_an_empty_successful_snapshot(self):
        def fail(_): raise PermissionError('unreadable process')
        with self.assertRaises(PermissionError): scan(self.policy,reference_reader=fail)

    def test_missing_tree_cannot_be_fingerprinted_as_an_empty_release(self):
        with self.assertRaises(FileNotFoundError):tree(self.releases/'missing',100)

    def test_journal_state_and_final_entry_age_both_control_log_eligibility(self):
        journal=self.root/'journal';journal.mkdir();self.policy['log_roots']=[str(journal)]
        file=journal/'system@abcdef-012345-012345.journal';file.write_bytes(b'archive')
        os.utime(file,(self.now-30*86400,)*2)
        for state,age,eligible in [('ONLINE',30,False),('ARCHIVED',1,False),('ARCHIVED',30,True)]:
            header=f'State: {state}\nTail realtime timestamp: date ({int((self.now-age*86400)*1e6):x})\n'
            snapshot=scan(self.policy,reference_reader=lambda roots:([],[]),command=lambda argv:header)
            self.assertEqual(plan(snapshot,self.policy,self.now)[0]['eligible'],eligible)
