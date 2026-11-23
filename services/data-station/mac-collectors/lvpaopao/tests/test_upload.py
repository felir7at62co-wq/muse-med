"""Outbox and uploader: ordering, idempotency, server 5xx/4xx, network loss with backlog, caps, heartbeat and the lark alert."""
import json

from support import Env, beijing

from lvpaopao_collector.util import read_json


def run(run_id, kind='rankings'):
    return {'schema': 1, 'runId': run_id, 'kind': kind, 'slot': '2026-11-15T09:00:00+08:00', 'startedAt': '2026-11-15T09:00:00+08:00',
            'finishedAt': '2026-11-15T09:01:00+08:00', 'status': 'failed', 'reason': 'mac-asleep',
            'collector': {'version': '1.0.0', 'host': 'collector-mac'}, 'rankings': [], 'engagement': []}


class UploadTests(Env):

    def test_uploads_in_order_and_treats_duplicate_as_done(self):
        service = self.service()
        for index in range(3):
            service.outbox.add(run(f'run-000{index}'))
            self.clock.advance(1)
        self.station.runs['run-0001'] = {}
        self.assertEqual(service.uploader.flush(), 3)
        self.assertEqual([item['body']['runId'] for item in self.station.of('/runs')], ['run-0000', 'run-0001', 'run-0002'])
        self.assertEqual(service.outbox.pending(), [])

    def test_atomic_files_only(self):
        service = self.service()
        path = service.outbox.add(run('run-atomic'))
        self.assertEqual(json.loads(path.read_text())['runId'], 'run-atomic')
        self.assertEqual(oct(path.stat().st_mode & 0o777), '0o600')
        self.assertEqual([item.name for item in path.parent.iterdir() if item.name.startswith('.')], [])

    def test_server_5xx_backs_off_and_keeps_backlog(self):
        service = self.service()
        service.outbox.add(run('run-a'))
        service.outbox.add(run('run-b'))
        self.station.run_status = 503
        self.assertEqual(service.uploader.flush(), 0)
        self.assertEqual(len(service.outbox.pending()), 2)
        first_wait = service.uploader.next_upload - self.clock.wall()
        service.uploader.flush()
        self.assertEqual(service.uploader.next_upload - self.clock.wall(), first_wait * 2)
        service.uploader.tick()
        self.assertEqual(len(self.station.of('/runs')), 2, 'tick respects the backoff')
        self.station.run_status = 200
        self.clock.advance(3600)
        service.uploader.tick()
        self.assertEqual(service.outbox.pending(), [])

    def test_network_loss_backlog_then_catch_up(self):
        service = self.service()
        self.station.close()
        service.station.base = 'http://127.0.0.1:9/api/service/lvpaopao'
        for index in range(4):
            service.outbox.add(run(f'run-net{index}'))
            self.clock.advance(1)
            service.uploader.tick()
        self.assertEqual(len(service.outbox.pending()), 4)
        self.assertEqual(service.uploader.failures, 1, 'only one attempt during the first backoff window')
        from support import FakeStation
        self.station = FakeStation()
        self.addCleanup(self.station.close)
        service.station.base = self.station.url
        self.clock.advance(3600)
        service.uploader.tick()
        self.assertEqual([item['body']['runId'] for item in self.station.of('/runs')], [f'run-net{index}' for index in range(4)])
        self.assertEqual(self.station.of('/heartbeat')[0]['body']['pendingUploads'], 0)

    def test_4xx_is_rejected_but_401_keeps_backlog(self):
        service = self.service()
        service.outbox.add(run('run-bad'))
        self.clock.advance(1)
        service.outbox.add(run('run-good'))
        self.station.run_status = lambda body: 409 if body['runId'] == 'run-bad' else 200
        self.assertEqual(service.uploader.flush(), 1)
        rejected = service.outbox.rejected_dir
        self.assertTrue(any(path.name.endswith('run-bad.json') for path in rejected.iterdir()))
        reason = [read_json(path) for path in rejected.iterdir() if path.name.endswith('.reason.json')][0]
        self.assertEqual(reason['status'], 409)
        service.outbox.add(run('run-auth'))
        self.station.run_status = 401
        service.uploader.flush()
        self.assertEqual(len(service.outbox.pending()), 1)
        self.assertIn('401', service.uploader.station_problem)

    def test_size_and_age_caps(self):
        config = self.config(outbox={'maxBytes': 1000, 'maxAgeDays': 1})
        service = self.service(config)
        for index in range(5):
            service.outbox.add(run(f'run-cap{index}'))
            self.clock.advance(1)
        total = sum(path.stat().st_size for path in service.outbox.pending())
        self.assertLessEqual(total, 1000)
        self.assertTrue(service.outbox.pending()[-1].name.endswith('run-cap4.json'))
        self.clock.advance(2 * 86400)
        service.outbox.add(run('run-new'))
        self.assertEqual([path.name.split('-', 1)[1] for path in service.outbox.pending()], ['run-new.json'])

    def test_heartbeat_fields_and_interval(self):
        service = self.service()
        service.guardian.tick()
        service.uploader.tick()
        body = self.station.of('/heartbeat')[0]['body']
        self.assertEqual(set(body), {'schema', 'sentAt', 'state', 'message', 'wechat', 'lastRun', 'nextSlot', 'pendingUploads', 'collector'})
        self.assertEqual(body['state'], 'ok')
        self.assertEqual(body['nextSlot'], '2026-11-15T09:00:00+08:00')
        self.assertEqual(body['wechat'], {'running': True, 'loggedIn': True})
        self.clock.advance(299)
        service.uploader.tick()
        self.assertEqual(len(self.station.of('/heartbeat')), 1)
        self.clock.advance(2)
        service.uploader.tick()
        self.assertEqual(len(self.station.of('/heartbeat')), 2)

    def test_command_executed_once_even_if_ack_is_lost(self):
        service = self.service()
        command = {'id': 'c-' + 'b' * 8 + '-bbbb-bbbb-bbbb-' + 'b' * 12, 'action': 'collect-now', 'issuedAt': 'x'}
        calls = []
        service.uploader.dispatch = lambda action: calls.append(action) or ('done', 'ok')
        original_ack = service.station.ack
        service.station.ack = lambda *args: type('R', (), {'ok': False})()
        self.station.commands = [command]
        service.uploader.heartbeat()
        service.station.ack = original_ack
        service.uploader.heartbeat()
        self.assertEqual(calls, ['collect-now'])
        self.assertEqual(self.station.commands, [])

    def test_lark_alert_after_six_hours_unreachable_and_recovery(self):
        config = self.config(alert={'chatId': 'oc_test123'})
        service = self.service(config)
        service.station.base = 'http://127.0.0.1:9/api/service/lvpaopao'
        service.uploader.tick()
        self.assertEqual(self.mac.commands, [])
        self.clock.advance(6 * 3600 + 1)
        service.uploader.tick()
        self.assertEqual(len(self.mac.commands), 1)
        argv = self.mac.commands[0]
        self.assertEqual(argv[1:5], ['im', '+messages-send', '--chat-id', 'oc_test123'])
        self.assertNotIn('test-token', ' '.join(argv))
        self.clock.advance(3600)
        service.uploader.tick()
        self.assertEqual(len(self.mac.commands), 1, 'one alert per outage')
        service.station.base = self.station.url
        self.clock.advance(3600)
        service.uploader.tick()
        self.assertEqual(len(self.mac.commands), 2)
        self.assertIn('重新连上', self.mac.commands[1][6])

    def test_alert_off_by_default(self):
        service = self.service()
        service.station.base = 'http://127.0.0.1:9/api/service/lvpaopao'
        self.clock.advance(7 * 3600)
        service.uploader.tick()
        self.assertEqual(self.mac.commands, [])

    def test_offline_network_state(self):
        service = self.service()
        self.mac.network = False
        service.scheduler.check_network()
        self.assertEqual(service.scheduler.status()['state'], 'offline-network')
        self.clock.now = beijing(2026, 11, 15, 9, 0, 5)
        self.assertTrue(service.scheduler.status()['message'])
