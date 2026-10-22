"""Offline isolated-Mac ownership checks; no native attach, account or socket access."""
import hashlib
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import mac_runtime as runtime


@unittest.skipUnless(hasattr(os, 'getuid'), 'Mac ownership checks use POSIX identity')
class Tests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.app = Path(self.directory.name) / 'WeChat-Muse-Test.app'
        self.home = self.app.parent / 'user-home'
        self.home.mkdir()
        self.paths = [self.app / part for part in ('Contents/MacOS/WeChat', runtime.EXE_PART, runtime.MODULE_PART)]
        self.profile = dict(runtime.PROFILE)
        for name, path in zip(('mainSHA256', 'executableSHA256', 'moduleSHA256'), self.paths):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(name.encode())
            self.profile[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.config = dict(runtimeProfile=runtime.PROFILE_NAME, appPath=str(self.app), privateHome=str(self.home),
                           mainPid=11, rootPid=12, mainStarted='start-main', rootStarted='start-root',
                           executablePath=str(self.paths[1]), modulePath=str(self.paths[2]))
        self.rows = [['11', '1', str(os.getuid()), str(self.paths[0])],
                     ['12', '11', str(os.getuid()), str(self.paths[1])]]
        self.environment = ('command HOME=' + str(self.home) + ' CFFIXED_USER_HOME=' + str(self.home)).encode()
        for patcher in (mock.patch.object(runtime, 'PROFILE', self.profile),
                        mock.patch.object(runtime, '_processes', side_effect=lambda: self.rows),
                        mock.patch.object(runtime, '_started', side_effect=lambda pid: {11:'start-main', 12:'start-root'}[pid]),
                        mock.patch.object(runtime.subprocess, 'run', side_effect=lambda *_args, **_kwargs: SimpleNamespace(stdout=self.environment))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_exact_private_processes_accept_home_as_final_environment_value(self):
        self.assertTrue(runtime.verify(self.config)['privateHomeVerified'])

    def test_changed_binary_is_rejected(self):
        self.paths[2].write_bytes(b'other-build')
        with self.assertRaisesRegex(runtime.MacRuntimeFailure, 'build-unsupported'):
            runtime.verify(self.config)

    def test_reused_pid_is_rejected(self):
        self.config['rootStarted'] = 'old-root'
        with self.assertRaisesRegex(runtime.MacRuntimeFailure, 'process-changed'):
            runtime.verify(self.config)

    def test_foreign_owner_or_parent_is_rejected(self):
        for field, value in ((1, '99'), (2, str(os.getuid()+1)), (3, '/Applications/WeChat.app/other')):
            with self.subTest(field=field):
                old = self.rows[1][field]
                self.rows[1][field] = value
                with self.assertRaisesRegex(runtime.MacRuntimeFailure, 'process-changed'):
                    runtime.verify(self.config)
                self.rows[1][field] = old

    def test_ordinary_wechat_or_other_home_is_rejected(self):
        for field, value in (('appPath', '/Applications/WeChat.app'), ('privateHome', str(self.app.parent))):
            with self.subTest(field=field), self.assertRaisesRegex(runtime.MacRuntimeFailure, 'path-invalid'):
                runtime.verify(dict(self.config, **{field:value}))

    def test_home_in_another_environment_value_does_not_count(self):
        self.environment = ('command OTHER_HOME=' + str(self.home) + ' CFFIXED_USER_HOME=' + str(self.home)).encode()
        with self.assertRaisesRegex(runtime.MacRuntimeFailure, 'home-invalid'):
            runtime.verify(self.config)

    def test_peer_requires_exact_loopback_source_and_verified_ancestry(self):
        self.rows.append(['13', '12', str(os.getuid()), str(self.app/'child')])
        socket = b'p13\nn127.0.0.1:4321->127.0.0.1:9421\n'
        with mock.patch.object(runtime, 'verify', return_value={}), mock.patch.object(runtime.subprocess, 'run', return_value=SimpleNamespace(stdout=socket)):
            self.assertEqual(runtime.require_peer(self.config, 4321)['ownerPid'], 13)
            with self.assertRaisesRegex(runtime.MacRuntimeFailure, 'peer-rejected'):
                runtime.require_peer(self.config, 4322)
            self.rows[-1][1] = '1'
            with self.assertRaisesRegex(runtime.MacRuntimeFailure, 'peer-rejected'):
                runtime.require_peer(self.config, 4321)
