"""Real-file quarantine, promotion and recovery behavior with controlled clocks and references."""

import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import unittest

from engine import Engine, atomic, code_hash
from policy import policy_hash
import test_inventory as fixtures


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.f=fixtures.InventoryTests();self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.now=self.f.now
        self.refs=[];self.opened=[]
        self.policy_file=self.f.root/'policy.json';atomic(self.policy_file,self.f.policy)
        def read(policy):
            self.f.policy=policy
            return self.f.snapshot(self.refs,self.opened)
        self.engine=Engine(self.policy_file,reader=read,clock=lambda:self.now)
        self.addCleanup(self.engine.close)
        for i in range(1,5):self.f.release('r'+str(i),50-i)

    def history(self, *, gap=False, error=False):
        start=self.now-86400
        for i in range(289):
            if gap and i in (30,31,32):continue
            value={'mode':'dry-run','deleted':0,'moved':0}
            if error and i==20:value['error']='PermissionError'
            self.engine.db.execute('INSERT INTO observations(at,code,policy,payload) VALUES (?,?,?,?)',
                (start+i*300,code_hash(),policy_hash(self.engine.policy),json.dumps(value)))

    def enable(self):
        atomic(self.engine.state/'approval.json',self.engine.review())
        atomic(self.policy_file,{**self.engine.policy,'mode':'enabled'})

    def test_dry_run_eligible_objects_are_never_moved_or_deleted(self):
        result=self.engine.tick()
        self.assertEqual(sum(row['eligible'] for row in result['decisions']),1)
        self.assertEqual(result['moved'],0);self.assertEqual(result['deleted'],0)
        self.assertEqual((self.f.releases/'r1'/'index.html').read_text(),'r1')
        self.assertEqual(self.engine.db.execute('SELECT COUNT(*) FROM quarantine').fetchone()[0],0)
        self.assertFalse((self.f.releases/'.muse-retention-quarantine').exists())

    def test_24_hour_gate_rejects_short_gapped_error_changed_and_clock_regression(self):
        with self.assertRaises(ValueError):self.engine.review()
        for options in ({'gap':True},{'error':True},{}):
            self.engine.db.execute('DELETE FROM observations');self.history(**options)
            if not options:self.engine.db.execute("UPDATE observations SET code='changed' WHERE id=20")
            with self.assertRaises(ValueError):self.engine.review()
        self.engine.db.execute('DELETE FROM observations');self.history()
        self.engine.db.execute('UPDATE observations SET at=at-900 WHERE id=(SELECT MIN(id)+2 FROM observations)')
        with self.assertRaises(ValueError):self.engine.review()

    def test_mode_change_without_approval_cannot_move_files(self):
        atomic(self.policy_file,{**self.engine.policy,'mode':'enabled'})
        self.assertIn('error',self.engine.tick())
        self.assertTrue((self.f.releases/'r1').exists())

    def test_release_is_recoverably_quarantined_before_purge(self):
        self.history();self.enable();result=self.engine.tick()
        self.assertEqual(result['moved'],1);self.assertEqual(result['deleted'],0)
        record=self.engine.db.execute('SELECT * FROM quarantine').fetchone()
        target=Path(record['target']);self.assertEqual((target/'index.html').read_text(),'r1')
        self.assertFalse((self.f.releases/'r1').exists())
        self.assertEqual(self.engine.tick()['deleted'],0)
        self.now+=86401
        result=self.engine.tick()
        self.assertNotIn('error',result);self.assertEqual(result['deleted'],1)
        self.assertFalse(target.exists())
        self.assertTrue((self.f.releases/'r2'/'index.html').exists())

    def test_new_reference_restores_quarantine_without_overwriting_anything(self):
        self.history();self.enable();self.engine.tick()
        self.refs.append({'kind':'effective-systemd','owner':'unit','path':str(self.f.releases/'r1'/'index.html')})
        result=self.engine.tick()
        self.assertEqual(result['restored'],1);self.assertEqual(result['deleted'],0)
        self.assertTrue((self.f.releases/'r1'/'index.html').exists())

    def test_new_reference_restores_dependencies_before_any_batch_purge(self):
        self.f.release('r5',20)
        (self.f.releases/'r2'/'dependency').symlink_to(self.f.releases/'r1')
        os.utime(self.f.releases/'r2',(self.now-48*86400,)*2)
        self.history();self.enable()
        self.assertEqual(self.engine.tick()['moved'],2)
        self.now+=86401
        self.refs.append({'kind':'effective-systemd','owner':'unit','path':str(self.f.releases/'r2'/'index.html')})
        result=self.engine.tick()
        self.assertEqual(result['deleted'],0);self.assertEqual(result['restored'],2)
        self.assertEqual((self.f.releases/'r2'/'dependency'/'index.html').read_text(),'r1')

    def test_active_deployment_protects_versions(self):
        original=self.engine.reader
        def deploying(policy):return {**original(policy),'deployment_busy':True}
        self.engine.reader=deploying
        self.history();self.enable()
        result=self.engine.tick()
        self.assertEqual(result['moved'],0);self.assertEqual(result['deleted'],0)
        self.assertTrue(all(row['reason']=='deployment-in-progress' for row in result['decisions']))

    def test_cli_requires_matching_qualification_and_complete_preview(self):
        script=Path(__file__).with_name('cli.py')
        checked=self.f.root/'qualification.json'
        atomic(checked,{'code':code_hash(),'passed':True,'tests':1})
        args=[sys.executable,str(script),'promote','--policy',str(self.policy_file),'--qualification',str(checked)]
        def run():return subprocess.run(args,capture_output=True,text=True,timeout=5)
        self.assertNotEqual(run().returncode,0)
        self.history()
        atomic(checked,{'code':'different','passed':True,'tests':1})
        self.assertNotEqual(run().returncode,0)
        self.assertEqual(json.loads(self.policy_file.read_text())['mode'],'dry-run')
        atomic(checked,{'code':code_hash(),'passed':True,'tests':1})
        result=run();self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(self.policy_file.read_text())['mode'],'enabled')

    def test_rollback_reserve_shrink_restores_a_quarantined_version(self):
        self.history();self.enable();self.engine.tick()
        import shutil
        shutil.rmtree(self.f.releases/'r2')
        self.now+=86401
        self.assertEqual(self.engine.tick()['restored'],1)
        self.assertTrue((self.f.releases/'r1').exists())

    def test_changed_file_and_new_active_reference_block_candidate_mutation(self):
        self.history();self.enable()
        _,rows=self.engine.observe();candidate=next(row for row in rows if row['eligible'])
        (Path(candidate['path'])/'index.html').write_text('new generation')
        with self.assertRaises(ValueError):self.engine.move(candidate)
        _,rows=self.engine.observe();candidate=next(row for row in rows if row['eligible'])
        self.refs.append({'kind':'process-command','owner':'123','path':candidate['path']})
        with self.assertRaises(ValueError):self.engine.move(candidate)
        self.assertTrue(Path(candidate['path']).exists())

    def test_new_recent_release_dependency_blocks_previously_selected_candidate(self):
        self.refs.append({'kind':'effective-systemd','owner':'unit','path':str(self.f.releases/'r2')})
        self.history();self.enable()
        _,rows=self.engine.observe()
        candidate=next(row for row in rows if row['path']==str(self.f.releases/'r1'))
        self.assertTrue(candidate['eligible'])
        recent=self.f.release('r5',13)
        self.f.release('r6',2);self.f.release('r7',1)
        (recent/'dependency').symlink_to(self.f.releases/'r1')
        os.utime(recent,(self.now-13*86400,)*2)
        with self.assertRaisesRegex(ValueError,'candidate-changed-or-protected'):
            self.engine.move(candidate)
        self.assertEqual((self.f.releases/'r1'/'index.html').read_text(),'r1')
        self.assertEqual(self.engine.db.execute('SELECT COUNT(*) FROM quarantine').fetchone()[0],0)

    def test_open_rotated_log_waits_then_quarantines_and_purges_only_after_the_extra_day(self):
        log=self.f.logs/'access.log.20.gz';log.write_text('archive')
        os.utime(log,(self.now-30*86400,)*2)
        self.refs.append({'kind':'effective-nginx','owner':'nginx','path':str(self.f.logs/'access.log')})
        self.opened.append(str(log))
        self.history();self.enable()
        result=self.engine.tick();self.assertTrue(log.exists())
        self.opened.clear();result=self.engine.tick()
        record=self.engine.db.execute('SELECT * FROM quarantine WHERE original=?',(str(log),)).fetchone()
        self.assertIsNotNone(record);self.assertTrue(Path(record['target']).exists())
        self.now+=86401;self.engine.tick()
        self.assertFalse(Path(record['target']).exists())

    def test_symlink_swap_and_failed_scans_do_not_remove_unrelated_data(self):
        self.history();self.enable();_,rows=self.engine.observe();candidate=next(row for row in rows if row['eligible'])
        import shutil
        shutil.rmtree(candidate['path'])
        secret=self.f.root/'outside';secret.mkdir();(secret/'private').write_text('preserve')
        Path(candidate['path']).symlink_to(secret)
        with self.assertRaises(ValueError):self.engine.move(candidate)
        self.assertEqual((secret/'private').read_text(),'preserve')
        def fail(_):raise PermissionError()
        self.engine.reader=fail
        self.assertEqual(self.engine.tick()['error'],'PermissionError')

    def test_switch_back_to_dry_run_preserves_quarantined_files(self):
        self.history();self.enable();self.engine.tick()
        target=Path(self.engine.db.execute('SELECT target FROM quarantine').fetchone()[0])
        self.now+=86401;atomic(self.policy_file,{**self.engine.policy,'mode':'dry-run'})
        result=self.engine.tick();self.assertEqual(result['deleted'],0);self.assertTrue(target.exists())

    def test_uncertain_delete_state_remains_fenced_across_restart(self):
        self.history();self.enable();self.engine.tick()
        self.engine.db.execute("UPDATE quarantine SET state='purging'")
        # Corruption/partial removal must not be called a successful purge.
        target=Path(self.engine.db.execute('SELECT target FROM quarantine').fetchone()[0])
        (target/'index.html').unlink();self.now+=86401
        result=self.engine.tick();self.assertIn('error',result)
        self.assertEqual(self.engine.db.execute('SELECT state FROM quarantine').fetchone()[0],'purging')

    def test_cleanup_lock_excludes_a_second_real_process_and_is_released(self):
        script="import fcntl,os,sys; f=open(sys.argv[1],'a');\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(3)"
        def child():return subprocess.run([sys.executable,'-c',script,str(self.engine.state/'cleanup.lock')],timeout=5).returncode
        with self.engine.lock():self.assertEqual(child(),3)
        self.assertEqual(child(),0)
