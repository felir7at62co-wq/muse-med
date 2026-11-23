"""End-to-end runs through the scheduler: fake helper subprocess, fake macOS, loopback station, fake clock."""
import json
import threading

from support import Env, beijing

from lvpaopao_collector.util import FileLock


class RunTests(Env):

    def runs(self, service):
        service.uploader.flush()
        return [item['body'] for item in self.station.of('/runs')]

    def test_rankings_slot_complete_and_uploaded(self):
        service = self.service()
        self.clock.now = beijing(2026, 11, 15, 9, 0, 5)
        service.scheduler.tick()
        runs = self.runs(service)
        self.assertEqual(len(runs), 1)
        run = runs[0]
        self.assertEqual((run['kind'], run['status'], run['reason'], run['slot']), ('rankings', 'complete', None, '2026-11-15T09:00:00+08:00'))
        self.assertEqual([(board['boardType'], board['boardName'], board['pagesRead'], len(board['entries'])) for board in run['rankings']],
                         [(6, '口碑榜', 3, 45), (7, '热播榜', 3, 45)])
        self.assertEqual(run['rankings'][0]['entries'][0], {'rank': 1, 'title': '剧6-1', 'srcAppId': 'wx' + '06' * 8, 'dramaId': '60001'})
        self.assertRegex(run['runId'], r'^20261115T0900\+0800-rankings-[0-9a-f]{8}$')
        self.assertEqual(run['engagement'], [])
        self.assertTrue(all(item['token'] and item['origin'] is None for item in self.station.requests))
        self.assertEqual(service.scheduler.human, None)
        self.assertEqual(service.outbox.pending(), [])
        self.assertTrue(any(call['match'].get('text') == ['重新进入小程序'] for call in self.mac.ax_calls))

    def test_helper_generation_error_mid_run_resumes_on_new_generation(self):
        self.scenario({'failAt': {'rankings:4': 'context-removed'}})
        service = self.service()
        self.clock.now = beijing(2026, 11, 15, 9, 0, 5)
        service.scheduler.tick()
        run = self.runs(service)[0]
        self.assertEqual(run['status'], 'complete')
        self.assertEqual([len(board['entries']) for board in run['rankings']], [45, 45])
        self.assertEqual(int((self.resources / 'prepare-count').read_text()), 2)

    def test_helper_crash_and_leftover_is_cleaned(self):
        self.scenario({'failAt': {'rankings:2': 'exit'}})
        service = self.service()
        self.clock.now = beijing(2026, 11, 15, 9, 0, 5)
        service.scheduler.tick()
        self.assertEqual(self.runs(service)[0]['status'], 'complete')
        records = json.loads((self.tmp / 'home' / 'state' / 'processes.json').read_text())
        self.assertEqual(records['processes'], [])

    def test_business_error_marks_board_partial(self):
        self.scenario({'failAt': {'rankings:5': 'business-error'}})
        service = self.service()
        self.clock.now = beijing(2026, 11, 15, 9, 0, 5)
        service.scheduler.tick()
        run = self.runs(service)[0]
        self.assertEqual((run['status'], run['reason']), ('partial', 'business-error'))
        self.assertTrue(run['rankings'][1]['partial'])

    def test_reentry_falls_back_to_reopening_from_list(self):
        self.mac.reentry = 'list'
        service = self.service()
        self.clock.now = beijing(2026, 11, 15, 9, 0, 5)
        service.scheduler.tick()
        self.assertEqual(self.runs(service)[0]['status'], 'complete')

    def test_reentry_failure_ladder_restart_then_human_then_probe_recovers(self):
        self.mac.reentry = 'none'
        service = self.service()
        first_main = service.guardian.main_pid
        self.clock.now = beijing(2026, 11, 15, 9, 0, 5)
        service.scheduler.tick()
        run = self.runs(service)[0]
        self.assertEqual((run['status'], run['reason']), ('failed', 'reentry-failed'))
        self.assertEqual(len(self.mac.launched), 2, 'WeChat restarted once by the ladder')
        self.assertNotEqual(service.guardian.main_pid, first_main)
        self.assertEqual(int((self.resources / 'prepare-count').read_text()), 5, '1 + 3 retries + 1 after restart')
        status = service.scheduler.status()
        self.assertEqual(status['state'], 'reentry-failed')
        # probe 15 minutes later still fails; a human opens the mini-program; the next probe succeeds
        self.clock.advance(901)
        service.scheduler.tick()
        self.assertIsNotNone(service.scheduler.human)
        self.mac.reentry = 'capsule'
        self.clock.advance(901)
        service.scheduler.tick()
        self.assertIsNone(service.scheduler.human)
        self.assertEqual(service.scheduler.status()['state'], 'ok')

    def test_logged_out_goes_straight_to_waiting_login(self):
        self.mac.login = 'qr'
        service = self.service()
        service.guardian.tick()
        self.clock.now = beijing(2026, 11, 15, 9, 0, 5)
        service.scheduler.tick()
        run = self.runs(service)[0]
        self.assertEqual((run['status'], run['reason']), ('failed', 'wechat-logged-out'))
        self.assertEqual(service.scheduler.status()['state'], 'waiting-login')
        self.assertFalse((self.resources / 'prepare-count').exists(), 'no helper started while logged out')
        # login on the web page, next probe recovers, then the missed 09:00 slot is caught up once
        self.mac.login = 'logged-in'
        service.guardian.tick()
        self.clock.advance(901)
        service.scheduler.tick()
        self.assertIsNone(service.scheduler.human)
        self.clock.now = beijing(2026, 11, 15, 12, 0, 5)
        service.scheduler.tick()
        rankings = [(item['status'], item['slot'][11:16]) for item in self.runs(service) if item['kind'] == 'rankings']
        self.assertEqual(rankings, [('failed', '09:00'), ('complete', '12:00')])

    def test_build_change_needs_human(self):
        self.scenario({'prepare': ['mac-runtime-build-unsupported'] * 10})
        service = self.service()
        self.clock.now = beijing(2026, 11, 15, 9, 0, 5)
        service.scheduler.tick()
        run = self.runs(service)[0]
        self.assertEqual((run['status'], run['reason']), ('failed', 'build-changed'))
        self.assertEqual(service.scheduler.status()['state'], 'build-changed')
        self.assertEqual(int((self.resources / 'prepare-count').read_text()), 1)

    def test_wechat_not_running_is_retried_after_guardian_restart(self):
        self.scenario({'prepare': ['mac-isolated-wechat-required']})
        service = self.service()
        self.clock.now = beijing(2026, 11, 15, 9, 0, 5)
        service.scheduler.tick()
        self.assertEqual(self.runs(service)[0]['status'], 'complete')

    def test_sleep_mid_run_retries_and_completes(self):
        service = self.service()
        self.clock.now = beijing(2026, 11, 15, 9, 0, 5)
        original = service.scheduler._sleep_check
        calls = {'n': 0}

        def sleepy():
            calls['n'] += 1
            if calls['n'] == 3:
                self.clock.mac_sleeps(600)
            original()
        service.scheduler._sleep_check = sleepy
        service.scheduler.tick()
        run = self.runs(service)[0]
        self.assertEqual(run['status'], 'complete')
        self.assertTrue(any(gap[2] == 'sleep' for gap in service.scheduler.state['gaps']))

    def test_missed_slots_become_gaps_and_latest_is_caught_up_once(self):
        service = self.service()
        self.clock.now = beijing(2026, 11, 15, 8, 59)
        service.scheduler.tick()
        # Mac sleeps from 08:59 to 16:00: 09:00, 10:00 (engagement), 12:00 and 15:00 are missed
        self.clock.mac_sleeps(beijing(2026, 11, 15, 16, 0) - self.clock.now)
        self.mac.network = True
        service.scheduler.tick()
        early = [(item['kind'], item['slot'][11:16], item['status']) for item in self.runs(service)]
        self.assertEqual(early, [('rankings', '09:00', 'failed'), ('rankings', '12:00', 'failed')], 'catch-up waits for 60 s of stable network')
        self.clock.advance(61)
        service.scheduler.tick()
        runs = self.runs(service)
        summary = [(item['kind'], item['slot'][11:16], item['status'], item['reason']) for item in runs]
        self.assertIn(('rankings', '09:00', 'failed', 'mac-asleep'), summary)
        self.assertIn(('rankings', '12:00', 'failed', 'mac-asleep'), summary)
        self.assertIn(('rankings', '15:00', 'complete', None), summary)
        self.assertIn(('engagement', '10:00', 'complete', None), summary)
        self.clock.advance(60)
        service.scheduler.tick()
        self.assertEqual(len(self.runs(service)), len(runs), 'caught up only once')

    def test_collector_down_gap_is_recorded(self):
        service = self.service()
        service.scheduler.tick()
        self.clock.advance(4 * 3600)  # collector process not running (state lastAlive stays old)
        from lvpaopao_collector.service import Service
        restarted = Service(self.config(), self.mac, self.clock, token='x' * 40)
        restarted.station = service.station
        restarted.uploader.station = service.station
        restarted.scheduler.check_network()
        self.clock.advance(61)
        restarted.scheduler.tick()
        runs = self.runs(restarted)
        self.assertIn(('09:00', 'failed', 'mac-asleep'), [(item['slot'][11:16], item['status'], item['reason']) for item in runs if item['kind'] == 'rankings'])

    def test_lock_contention_reports_helper_busy(self):
        holder = FileLock(self.tmp / 'run' / 'helper.lock')
        self.assertTrue(holder.acquire())
        self.addCleanup(holder.release)
        service = self.service()
        self.clock.now = beijing(2026, 11, 15, 9, 0, 5)
        service.scheduler.tick()
        run = self.runs(service)[0]
        self.assertEqual((run['status'], run['reason']), ('failed', 'helper-error'))
        holder.release()
        self.clock.advance(901)
        service.scheduler.tick()
        self.assertIsNone(service.scheduler.human)

    def test_engagement_reads_watchlist_then_rank_order_within_budget(self):
        watch = {'srcAppId': 'wx' + 'ab' * 8, 'dramaId': 'w1', 'title': '关注剧'}
        config = self.config(engagement={'watchlist': [watch], 'topPerBoard': 2, 'dailyCallBudget': 12})
        service = self.service(config)
        self.clock.now = beijing(2026, 11, 15, 10, 0, 5)
        service.scheduler.state['lastHandled']['rankings'] = self.clock.now
        service.scheduler.tick()
        run = [item for item in self.runs(service) if item['kind'] == 'engagement'][0]
        self.assertEqual((run['status'], run['reason']), ('partial', 'budget-exhausted'))
        self.assertEqual([item['dramaId'] for item in run['engagement']], ['w1', '60001', '70001'], 'watch list, then rank 1 of every board')
        first = run['engagement'][0]
        self.assertEqual((first['episodeCount'], first['partial'], len(first['episodes'])), (3, False, 3))
        self.assertEqual(first['episodes'][0], {'episodeNo': 1, 'likes': 10, 'comments': 2, 'recommendations': 3, 'shares': 1})
        third = run['engagement'][2]
        self.assertEqual((third['partial'], third['missingEpisodes'], len(third['episodes'])), (True, [2, 3], 1))
        self.assertEqual(service.scheduler.state['budget']['used'], 12)

    def test_collect_now_command_runs_and_acks(self):
        service = self.service()
        self.station.commands = [{'id': 'c-' + '1' * 8 + '-1111-1111-1111-' + '1' * 12, 'action': 'collect-now', 'issuedAt': 'x'}]
        service.uploader.heartbeat()
        self.assertEqual(self.station.commands, [])
        service.scheduler.tick()
        runs = self.runs(service)
        self.assertEqual(runs[0]['status'], 'complete')
        self.assertEqual(self.station.of('/ack')[0]['body']['result'], 'done')

    def test_sigterm_cancels_hanging_call_and_closes_helper(self):
        self.scenario({'failAt': {'rankings:2': 'hang'}})
        config = self.config(helper={'requestTimeoutSeconds': 60})
        service = self.service(config)
        self.clock.now = beijing(2026, 11, 15, 9, 0, 5)
        timer = threading.Timer(1.5, service.stop.set)
        timer.start()
        service.scheduler.tick()
        timer.join()
        run = self.runs(service)[0]
        self.assertEqual((run['status'], run['reason']), ('failed', 'cancelled'), 'the interrupted board is not reported')
        self.assertLess(service.scheduler.state['lastHandled']['rankings'], beijing(2026, 11, 15, 9), 'slot stays pending for the restart')
        records = json.loads((self.tmp / 'home' / 'state' / 'processes.json').read_text())
        self.assertEqual(records['processes'], [])
