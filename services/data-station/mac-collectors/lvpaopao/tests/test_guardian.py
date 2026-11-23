"""WeChat guardian: private launch, crash restart with backoff, forbidden-path guard, adoption, login screen and start-login."""
from support import Env, TOKEN

from lvpaopao_collector.macos import KILL, TERM
from lvpaopao_collector.wechat import classify_login


class GuardianTests(Env):

    def guardian(self):
        service = self.service()
        return service, service.guardian

    def test_launches_copy_with_private_home(self):
        _service, guardian = self.guardian()
        self.assertEqual(len(self.mac.launched), 1)
        launch = self.mac.launched[0]
        home = str(self.app.parent / 'user-home')
        self.assertEqual(launch['argv'], [str(self.app / 'Contents/MacOS/WeChat')])
        self.assertEqual(launch['env'], {'HOME': home, 'CFFIXED_USER_HOME': home, 'TMPDIR': home + '/tmp/'})
        self.assertTrue(guardian.running())
        self.assertIsNotNone(guardian.appex_pid())

    def test_crash_restarts_with_backoff(self):
        _service, guardian = self.guardian()
        self.mac.crash_wechat()
        guardian.tick()
        self.assertFalse(guardian.running())
        self.assertEqual(len(self.mac.launched), 1, 'waits for the backoff')
        self.clock.advance(29)
        guardian.tick()
        self.assertEqual(len(self.mac.launched), 1)
        self.clock.advance(2)
        guardian.tick()
        self.assertEqual(len(self.mac.launched), 2)
        self.mac.crash_wechat()
        guardian.tick()
        self.clock.advance(31)
        guardian.tick()
        self.assertEqual(len(self.mac.launched), 2, 'second crash in a row backs off 60 s')
        self.clock.advance(30)
        guardian.tick()
        self.assertEqual(len(self.mac.launched), 3)

    def test_forbidden_original_data_stops_copy_and_blocks(self):
        service, guardian = self.guardian()
        import pwd, os
        real_home = pwd.getpwuid(os.getuid()).pw_dir.rstrip('/')
        self.mac.files[guardian.main_pid] = [f'{real_home}/Library/Containers/com.tencent.xinWeChat/Data/x.db']
        main = guardian.main_pid
        self.clock.advance(10)
        guardian.tick()
        self.assertEqual(guardian.blocked, 'forbidden-original-data')
        self.assertIn((main, TERM, True), self.mac.killed)
        self.clock.advance(3600)
        guardian.tick()
        self.assertEqual(len(self.mac.launched), 1, 'never relaunched while blocked')
        self.assertEqual(service.scheduler.status()['state'], 'error')

    def test_private_home_files_are_not_forbidden(self):
        _service, guardian = self.guardian()
        self.mac.files[guardian.main_pid] = [str(self.app.parent / 'user-home/Library/Containers/com.tencent.xinWeChat/Data/x.db')]
        self.clock.advance(10)
        guardian.tick()
        self.assertIsNone(guardian.blocked)

    def test_adopts_running_copy_after_collector_restart(self):
        _service, guardian = self.guardian()
        pid = guardian.main_pid
        second = self.service()
        self.assertEqual(second.guardian.main_pid, pid)
        self.assertEqual(len(self.mac.launched), 1)

    def test_refuses_to_adopt_copy_without_private_home(self):
        self.mac.add_proc(str(self.app / 'Contents/MacOS/WeChat'), env='WeChat HOME=/Users/someone')
        service = self.service()
        self.assertEqual(service.guardian.blocked, 'wechat-env-invalid')
        self.assertEqual(self.mac.launched, [])

    def test_missing_copy_blocks(self):
        import shutil
        shutil.rmtree(self.app)
        service = self.service()
        self.assertEqual(service.guardian.blocked, 'wechat-app-missing')

    def test_logged_out_uploads_login_window_every_20s_then_deletes(self):
        self.mac.login = 'qr'
        service, guardian = self.guardian()
        guardian.tick()
        self.assertEqual(guardian.login.kind, 'qr')
        self.assertEqual(len(self.station.of('/login-screen', 'PUT')), 1)
        self.clock.advance(10)
        guardian.tick()
        self.assertEqual(len(self.station.of('/login-screen', 'PUT')), 1)
        self.clock.advance(11)
        guardian.tick()
        puts = self.station.of('/login-screen', 'PUT')
        self.assertEqual(len(puts), 2)
        self.assertEqual(puts[0]['body']['kind'], 'qr')
        self.assertTrue(puts[0]['body']['capturedAt'].endswith('+08:00'))
        self.assertEqual(self.mac.captures, 2)
        self.assertEqual(service.scheduler.status()['state'], 'waiting-login')
        self.assertIs(service.scheduler.status()['wechat']['loggedIn'], False)
        self.mac.login = 'logged-in'
        self.clock.advance(5)
        guardian.tick()
        self.assertEqual(len(self.station.of('/login-screen', 'DELETE')), 1)
        self.assertEqual(service.scheduler.status()['state'], 'ok')

    def test_start_login_command_presses_enter_wechat(self):
        self.mac.login = 'confirm'
        service, guardian = self.guardian()
        guardian.tick()
        self.station.commands = [{'id': 'c-' + 'a' * 8 + '-aaaa-aaaa-aaaa-' + 'a' * 12, 'action': 'start-login', 'issuedAt': 'x'}]
        service.uploader.heartbeat()
        self.assertTrue(any(call['match'].get('text') == ['进入微信'] and call['action'] == 'AXPress' for call in self.mac.ax_calls))
        ack = self.station.of('/ack')[0]['body']
        self.assertEqual(ack['result'], 'done')
        self.assertIn('手机', ack['message'])
        self.assertEqual(self.station.commands, [])
        self.assertEqual(self.station.of('/heartbeat')[0]['body']['state'], 'waiting-login')

    def test_start_login_on_qr_screen_refreshes(self):
        self.mac.login = 'qr'
        service, guardian = self.guardian()
        ok, message = guardian.start_login()
        self.assertTrue(ok)
        self.assertEqual(message, '已刷新二维码')

    def test_restart_kills_and_relaunches(self):
        _service, guardian = self.guardian()
        first = guardian.main_pid
        guardian.restart()
        self.assertIn((first, TERM, True), self.mac.killed)
        self.assertNotEqual(guardian.main_pid, first)
        self.assertNotIn((first, KILL, True), self.mac.killed)

    def test_classify_login_heuristics(self):
        config = self.config()
        small = {'size': [280, 380]}
        self.assertEqual(classify_login({'windows': [{**small, 'children': [{'title': '进入微信'}]}]}, 0, config).kind, 'confirm')
        self.assertEqual(classify_login({'windows': [{**small, 'children': [{'value': '扫码登录'}]}]}, 0, config).kind, 'qr')
        self.assertEqual(classify_login({'windows': [{'size': [1000, 700], 'children': [{'value': '二维码'}]}]}, 0, config).kind, 'logged-in',
                         'text in a wide (chat) window is ignored')
        self.assertEqual(classify_login({'windows': []}, 1, config).kind, 'logged-in')
        state = classify_login({'windows': []}, 0, config)
        self.assertEqual((state.kind, state.logged_in), ('unknown', None))
        self.assertTrue(TOKEN)
