"""Real kernel/file-system checks for active draft build ownership."""

import hashlib
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[2] / 'skills/tweet-drama-draft-build/scripts'
sys.path.insert(0, str(SCRIPTS))
from draft_stage_guard import BuildLease, DraftBuildBusyError, DraftStageGuard


class DraftStageGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='muse-stage-guard-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stage = self.root / 'ep42-aa-private'
        self.stage.mkdir()
        self.media = self.stage / 'body.mp4'
        self.media.write_bytes(b'retained original media')

    def powershell(self, command):
        shell = shutil.which('pwsh') or shutil.which('powershell')
        self.assertIsNotNone(shell, 'Windows stage guard tests require PowerShell')
        return subprocess.run([shell, '-NoLogo', '-NoProfile', '-NonInteractive',
                               '-Command', command], capture_output=True, text=True, timeout=20)

    def literal(self, path):
        return "'" + str(path).replace("'", "''") + "'"

    def child(self, body, *args):
        script = 'import sys\n' + f'sys.path.insert(0, {str(SCRIPTS)!r})\n' \
            + 'from draft_stage_guard import BuildLease, DraftBuildBusyError, DraftStageGuard\n' + body
        process = subprocess.Popen([sys.executable, '-I', '-B', '-u', '-c', script,
                                    *map(str, args)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True,
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        def stop():
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=15)
        self.addCleanup(stop)
        return process

    def ready(self, process):
        with ThreadPoolExecutor(max_workers=1) as reader:
            line = reader.submit(process.stdout.readline)
            try:
                return line.result(timeout=15).strip()
            finally:
                if not line.done():
                    process.kill()
                    process.wait(timeout=15)

    def test_same_name_contends_and_other_names_continue(self):
        with BuildLease(self.root, 'AA-EP42') as owner:
            with self.assertRaises(DraftBuildBusyError):
                with BuildLease(self.root, 'AA-EP42'):
                    self.fail('a second owner entered')
            with BuildLease(self.root, 'AA-EP43'):
                self.assertTrue(self.media.is_file())
        self.assertTrue(owner.path.is_file())
        with BuildLease(self.root, 'AA-EP42'):
            self.assertEqual(self.media.read_bytes(), b'retained original media')

    def test_exception_releases_lease(self):
        with self.assertRaisesRegex(RuntimeError, 'native failure'):
            with BuildLease(self.root, 'AA-EP42'):
                raise RuntimeError('native failure')
        with BuildLease(self.root, 'AA-EP42'):
            pass

    @unittest.skipUnless(os.name == 'nt', 'Windows case-insensitive target paths')
    def test_case_alias_cannot_claim_the_same_draft(self):
        with BuildLease(self.root, 'AA-EP42'):
            with self.assertRaises(DraftBuildBusyError):
                with BuildLease(str(self.root).upper(), 'aa-ep42'):
                    self.fail('case aliases bypassed draft ownership')

    def test_second_process_is_rejected_until_owner_exits(self):
        owner = self.child("with BuildLease(sys.argv[1], 'AA-EP42'):\n"
                           " print('ready', flush=True)\n sys.stdin.readline()\n", self.root)
        self.assertEqual(self.ready(owner), 'ready')
        contender = self.child("try:\n with BuildLease(sys.argv[1], 'AA-EP42'):\n"
                               "  print('unexpected owner')\nexcept DraftBuildBusyError:\n print('busy')\n",
                               self.root)
        stdout, stderr = contender.communicate(timeout=15)
        self.assertEqual((contender.returncode, stdout.strip(), stderr), (0, 'busy', ''))
        owner.kill()
        owner.communicate(timeout=15)
        with BuildLease(self.root, 'AA-EP42'):
            self.assertTrue(self.media.is_file())

    def test_guard_requires_ownership_and_in_stage_material(self):
        guard = DraftStageGuard(self.stage)
        with self.assertRaisesRegex(RuntimeError, 'entered first'):
            guard.protect_file(self.media)
        outside = self.root / 'original.mp4'
        outside.write_bytes(b'do not touch')
        with guard:
            with self.assertRaisesRegex(ValueError, 'inside the stage'):
                guard.protect_file(outside)
            guard.protect_file(self.media)
        guard.close()
        self.assertEqual(outside.read_bytes(), b'do not touch')

    @unittest.skipUnless(os.name == 'nt', 'Windows delete-sharing behavior')
    def test_active_stage_move_is_blocked_but_receipt_writes_continue(self):
        moved = self.root / 'quarantined'
        receipt = self.stage / 'aa-runtime.json'
        with DraftStageGuard(self.stage):
            result = self.powershell(f'Move-Item -LiteralPath {self.literal(self.stage)} '
                                     f'-Destination {self.literal(moved)} -Force -ErrorAction Stop')
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertTrue(self.stage.is_dir())
            self.assertFalse(moved.exists())
            receipt.write_text(json.dumps({'status': 'saved'}), encoding='utf-8')
            self.assertEqual(json.loads(receipt.read_text()), {'status': 'saved'})
        result = self.powershell(f'Move-Item -LiteralPath {self.literal(self.stage)} '
                                 f'-Destination {self.literal(moved)} -Force -ErrorAction Stop')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((moved / 'body.mp4').is_file())

    @unittest.skipUnless(os.name == 'nt', 'Windows delete-sharing behavior')
    def test_force_recursive_removal_cannot_delete_protected_materials(self):
        before = hashlib.sha256(self.media.read_bytes()).hexdigest()
        with DraftStageGuard(self.stage) as guard:
            guard.protect_file(self.media)
            result = self.powershell(f'Remove-Item -LiteralPath {self.literal(self.stage)} '
                                     '-Recurse -Force -ErrorAction Stop')
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertEqual(hashlib.sha256(self.media.read_bytes()).hexdigest(), before)
            (self.stage / 'aa-runtime.json').write_text('{"status":"saved"}', encoding='utf-8')
        result = self.powershell(f'Remove-Item -LiteralPath {self.literal(self.stage)} '
                                 '-Recurse -Force -ErrorAction Stop')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.stage.exists())

    @unittest.skipUnless(os.name == 'nt', 'Windows delete-sharing behavior')
    def test_lock_file_cannot_be_force_removed_while_owned(self):
        with BuildLease(self.root, 'AA-EP42') as owner:
            result = self.powershell(f'Remove-Item -LiteralPath {self.literal(owner.path)} '
                                     '-Force -ErrorAction Stop')
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertTrue(owner.path.is_file())
            with self.assertRaises(DraftBuildBusyError):
                with BuildLease(self.root, 'AA-EP42'):
                    self.fail('force removal bypassed the live owner')

    @unittest.skipUnless(os.name == 'nt', 'Windows delete-sharing behavior')
    def test_process_death_releases_stage_guard(self):
        owner = self.child("with DraftStageGuard(sys.argv[1]) as guard:\n"
                           " guard.protect_file(sys.argv[2])\n print('ready', flush=True)\n"
                           " sys.stdin.readline()\n", self.stage, self.media)
        self.assertEqual(self.ready(owner), 'ready')
        moved = self.root / 'after-owner-exit'
        command = f'Move-Item -LiteralPath {self.literal(self.stage)} ' \
            f'-Destination {self.literal(moved)} -Force -ErrorAction Stop'
        self.assertNotEqual(self.powershell(command).returncode, 0)
        owner.kill()
        owner.communicate(timeout=15)
        result = self.powershell(command)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((moved / 'body.mp4').is_file())


if __name__ == '__main__':
    unittest.main()
