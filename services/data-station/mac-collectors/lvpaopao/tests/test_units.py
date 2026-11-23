"""Unit tests: helper protocol client, process records, error mapping, config, slot maths, sleep detection and parsers."""
import os
from pathlib import Path
import subprocess
import sys
import threading

from support import Env, FakeClock, beijing

from lvpaopao_collector.config import ConfigError, read_token, validate
from lvpaopao_collector.errors import FATAL, GENERATION, HUMAN, TRANSIENT, CollectError, classify
from lvpaopao_collector.helper import HelperSession, ProcessRecords, prepare
from lvpaopao_collector.macos import parse_lsof_names, parse_lsof_pids, parse_ps
from lvpaopao_collector.scheduler import SleepMonitor, slots_between
from lvpaopao_collector.util import FileLock


class HelperTests(Env):

    def session(self, config=None):
        config = config or self.config()
        records = ProcessRecords(self.tmp / 'records.json', self.mac)
        prepared = prepare(config, records, threading.Event())
        session = HelperSession(config, prepared, records, self.tmp / 'helper.log')
        session.start()
        self.addCleanup(session.close)
        return session, records

    def test_handshake_call_and_clean_close(self):
        self.ready.touch()
        session, records = self.session()
        self.assertTrue(session.ready())
        value = session.call('detail', {'srcAppId': 'wx' + '0' * 16, 'dramaId': '1'})
        self.assertEqual(value['status'], 'detail-returned')
        self.assertEqual(len(__import__('json').loads((self.tmp / 'records.json').read_text())['processes']), 1)
        self.assertTrue(session.close())
        self.assertEqual(__import__('json').loads((self.tmp / 'records.json').read_text())['processes'], [])

    def test_waiting_target_until_ready(self):
        session, _records = self.session()
        self.assertFalse(session.ready())
        with self.assertRaises(CollectError) as caught:
            session.call('rankings', {'boardType': 6, 'pageIndex': 0, 'count': 20, 'coldStartTime': 1})
        self.assertEqual(caught.exception.kind, TRANSIENT)

    def test_generation_error_and_closed_event(self):
        self.ready.touch()
        self.scenario({'failAt': {'detail:1': 'context-removed'}})
        session, _records = self.session()
        with self.assertRaises(CollectError) as caught:
            session.call('detail', {'srcAppId': 'wx' + '0' * 16, 'dramaId': '1'})
        self.assertEqual((caught.exception.kind, caught.exception.code), (GENERATION, 'context-removed'))
        self.assertTrue(session.close(), 'hook-stopped with full cleanup is a confirmed close')

    def test_timeout_sends_cancel_and_keeps_generation(self):
        self.ready.touch()
        self.scenario({'failAt': {'detail:1': 'hang'}})
        session, _records = self.session(self.config(helper={'requestTimeoutSeconds': 1}))
        with self.assertRaises(CollectError) as caught:
            session.call('detail', {'srcAppId': 'wx' + '0' * 16, 'dramaId': '1'})
        self.assertEqual((caught.exception.kind, caught.exception.code), (TRANSIENT, 'request-timeout'))
        self.assertEqual(session.call('detail', {'srcAppId': 'wx' + '0' * 16, 'dramaId': '1'})['status'], 'detail-returned')

    def test_helper_exit_is_connection_lost(self):
        self.ready.touch()
        self.scenario({'failAt': {'detail:1': 'exit'}})
        session, _records = self.session()
        with self.assertRaises(CollectError) as caught:
            session.call('detail', {'srcAppId': 'wx' + '0' * 16, 'dramaId': '1'})
        self.assertEqual(caught.exception.code, 'connection-lost')
        self.assertFalse(session.close())

    def test_prepare_error_codes(self):
        records = ProcessRecords(self.tmp / 'records.json', self.mac)
        for code, reason, kind in (('mac-runtime-build-unsupported', 'build-changed', HUMAN),
                                   ('mac-isolated-wechat-required', 'wechat-not-running', GENERATION),
                                   ('setup-media-tools-missing', 'helper-error', FATAL)):
            self.scenario({'prepare': [code]})
            (self.resources / 'prepare-count').unlink(missing_ok=True)
            with self.assertRaises(CollectError) as caught:
                prepare(self.config(), records, threading.Event())
            self.assertEqual((caught.exception.reason, caught.exception.kind), (reason, kind))

    def test_leftover_cleanup_matches_pid_and_start_time(self):
        records = ProcessRecords(self.tmp / 'records.json', self.mac)
        leftover = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        self.addCleanup(leftover.kill)
        records.add('helper', leftover.pid)
        stranger = self.mac.add_proc('/usr/bin/other')
        records.add('prepare', stranger)
        self.mac.starts[stranger] = 'reused-pid-new-start'
        killed = records.cleanup()
        self.assertEqual(killed, [leftover.pid])
        leftover.wait(5)
        self.assertNotIn(stranger, [pid for pid, _sig, _group in self.mac.killed])


class PureTests(Env):

    def test_classify(self):
        self.assertEqual(classify('busy').kind, TRANSIENT)
        self.assertEqual(classify('hook-stopped').kind, GENERATION)
        self.assertEqual(classify('helper-identity-mismatch').reason, 'build-changed')
        self.assertEqual(classify('something-new').reason, 'helper-error')

    def test_config_validation(self):
        validate({})
        with self.assertRaises(ConfigError):
            validate({'nope': 1})
        with self.assertRaises(ConfigError):
            validate({'wechat': {'app': '/Applications/WeChat.app'}})
        with self.assertRaises(ConfigError):
            validate({'rankings': {'times': ['25:00']}})
        with self.assertRaises(ConfigError):
            validate({'engagement': {'watchlist': [{'srcAppId': 'bad', 'dramaId': '1', 'title': 'x'}]}})
        with self.assertRaises(ConfigError):
            validate({'alert': {'chatId': 'oc_a', 'userId': 'ou_b'}})

    def test_token_file_must_be_private(self):
        config = self.config()
        path = Path(config['station']['tokenFile'])
        path.write_text('t' * 40)
        os.chmod(path, 0o644)
        with self.assertRaises(ConfigError):
            read_token(config)
        os.chmod(path, 0o600)
        self.assertEqual(read_token(config), 't' * 40)

    def test_slots_between(self):
        tz = self.config().tz
        slots = slots_between(['09:00', '22:00'], beijing(2026, 11, 14, 21, 0), beijing(2026, 11, 15, 9, 0), tz)
        self.assertEqual(slots, [beijing(2026, 11, 14, 22, 0), beijing(2026, 11, 15, 9, 0)])

    def test_sleep_monitor(self):
        clock = FakeClock(0)
        monitor = SleepMonitor(clock, 60)
        clock.advance(30)
        self.assertIsNone(monitor.check())
        clock.mac_sleeps(3600)
        self.assertEqual(monitor.check(), (30, 3630))

    def test_file_lock_contention(self):
        first, second = FileLock(self.tmp / 'l'), FileLock(self.tmp / 'l')
        self.assertTrue(first.acquire())
        self.assertFalse(second.acquire())
        first.release()
        self.assertTrue(second.acquire())
        second.release()

    def test_parsers(self):
        rows = parse_ps(' 12 1 501 /Applications/A B.app/Contents/MacOS/A B\n bad line\n')
        self.assertEqual((rows[0].pid, rows[0].uid, rows[0].comm), (12, 501, '/Applications/A B.app/Contents/MacOS/A B'))
        self.assertEqual(parse_lsof_names('p12\nfcwd\nn/Users/x/file\n'), ['/Users/x/file'])
        self.assertEqual(parse_lsof_pids('p12\nf3\np13\n'), [12, 13])


class DeploymentTests(Env):

    def test_example_config_and_plist_template(self):
        import json
        import plistlib
        from support import PACKAGE_ROOT
        validate(json.loads((PACKAGE_ROOT / 'config.example.json').read_text(encoding='utf8')))
        raw = (PACKAGE_ROOT / 'launchd' / 'cn.muse.lvpaopao.collector.plist.template').read_text().replace('@ROOT@', '/Users/x/Library/Application Support/c')
        plist = plistlib.loads(raw.encode())
        self.assertEqual(plist['ProgramArguments'][-1], 'run')
        self.assertTrue(plist['KeepAlive'] and plist['AbandonProcessGroup'])
