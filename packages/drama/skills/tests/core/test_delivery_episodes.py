"""Offline delivery assembly with canonical two-, three-, and four-digit episode IDs."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = (Path(__file__).resolve().parents[2] /
          'skills/tweet-drama-delivery/scripts/assemble_delivery.py')


class DeliveryEpisodeTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('delivery_episode_tests', SCRIPT)
        self.delivery = importlib.util.module_from_spec(spec)
        with patch.object(sys, 'path', sys.path.copy()):
            spec.loader.exec_module(self.delivery)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name).resolve()
        self.config = self.project / '_probe/delivery-config'
        self.config.mkdir(parents=True)
        episodes = (1, 14, 140, 1000, 9999)
        self.masters = {}
        for episode in episodes:
            self.masters[episode] = self.write(f'export/{episode}.mp4', f'master for episode {episode}'.encode())
        self.write('assets/lead_m.png', b'male fixture')
        self.write('assets/lead_f.png', b'female fixture')
        self.write('source/original/script.txt', b'original script')
        self.write('_probe/delivery-config/简介.txt', '简介'.encode())
        for name, data in {
            '_confirmed_episodes.json': {'confirmed': [{'episode': ep} for ep in episodes]},
            'confirmed-films.json': {'films': {f'{ep:02d}': f'export/{ep}.mp4' for ep in episodes}},
            'film-reviews.json': {'films': {f'{ep:02d}': self.review_entry(ep) for ep in episodes}},
            '主角.json': {'male': ['lead_m.png'], 'female': ['lead_f.png']},
        }.items():
            (self.config / name).write_text(json.dumps(data), encoding='utf-8')

    def review_entry(self, episode, **overrides):
        entry = {
            'source': f'export/{episode}.mp4',
            'sha256': hashlib.sha256(self.masters[episode].read_bytes()).hexdigest(),
            'reviewed': True,
            'reviewed_at': '2026-10-30 12:00',
            'picture': 'ok', 'audio': 'ok', 'subtitle': 'ok', 'spec': 'ok',
            'issues': [],
        }
        entry.update(overrides)
        return entry

    def write(self, relative, data):
        path = self.project / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def rewrite_reviews(self, films):
        (self.config / 'film-reviews.json').write_text(json.dumps({'films': films}), encoding='utf-8')

    def assemble(self, episode):
        argv = ['assemble_delivery.py', '--project', str(self.project), '--episode', str(episode)]
        output = io.StringIO()
        with patch.object(sys, 'argv', argv), \
                patch.dict(os.environ, {}, clear=True), \
                patch.object(self.delivery, 'find_ffprobe', return_value=None), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.delivery.main(), 0)
        return json.loads(output.getvalue().split('<<<ASSEMBLY_REPORT>>>')[1]
                          .split('<<<END_ASSEMBLY_REPORT>>>')[0])

    def assemble_failure(self, episode):
        argv = ['assemble_delivery.py', '--project', str(self.project), '--episode', str(episode)]
        stderr = io.StringIO()
        with patch.object(sys, 'argv', argv), \
                patch.dict(os.environ, {}, clear=True), \
                patch.object(self.delivery, 'find_ffprobe', return_value=None), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as raised:
                self.delivery.main()
        self.assertEqual(raised.exception.code, 2)
        return stderr.getvalue()

    def assemble_notice(self, episode):
        """组装成功：返回 (report, 完整 stdout)，供提示性钩子断言。"""
        argv = ['assemble_delivery.py', '--project', str(self.project), '--episode', str(episode)]
        output = io.StringIO()
        with patch.object(sys, 'argv', argv), \
                patch.dict(os.environ, {}, clear=True), \
                patch.object(self.delivery, 'find_ffprobe', return_value=None), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.delivery.main(), 0)
        text = output.getvalue()
        report = json.loads(text.split('<<<ASSEMBLY_REPORT>>>')[1].split('<<<END_ASSEMBLY_REPORT>>>')[0])
        return report, text

    def films(self):
        return {path.name: path.read_bytes()
                for path in (self.project / 'delivery/00成片').iterdir()}

    def test_episode_140_can_be_reassembled_without_replacing_episode_14(self):
        self.assemble(14)
        self.assemble(140)
        self.masters[140] = self.write('export/140.mp4', b'updated episode 140')
        self.rewrite_reviews({'140': self.review_entry(140)})
        report = self.assemble(140)
        self.assertEqual(report['episode'], 140)
        self.assertEqual(report['film']['name'], '140.mp4')
        self.assertEqual(self.films(), {
            '14.mp4': b'master for episode 14',
            '140.mp4': b'updated episode 140',
        })

    def test_four_digit_episodes_survive_later_assembly_and_keep_full_ids(self):
        for episode in (1000, 9999, 1, 140):
            with self.subTest(episode=episode):
                report = self.assemble(episode)
                self.assertEqual(report['film']['name'], f'{episode:02d}.mp4')
        self.assertEqual(self.films(), {
            f'{episode:02d}.mp4': f'master for episode {episode}'.encode()
            for episode in (1, 140, 1000, 9999)
        })
        self.assertEqual({row['name'] for row in report['sections']['00成片']['files']},
                         set(self.films()))

    def test_noncanonical_film_names_block_assembly_without_changing_files(self):
        self.assemble(14)
        for name in ('1.mp4', '00.mp4', '0140.mp4', '10000.mp4', '140.mp4.bak', '140x.mp4'):
            with self.subTest(name=name):
                stray = self.write(f'delivery/00成片/{name}', b'preserve unrecognized file')
                before = self.films()
                with self.assertRaises(SystemExit) as raised:
                    self.assemble(140)
                self.assertEqual(raised.exception.code, 2)
                self.assertEqual(self.films(), before)
                stray.unlink()

    def test_out_of_range_episode_fails_before_gate_or_output_creation(self):
        for episode in (0, 10000):
            with self.subTest(episode=episode), \
                    patch.object(self.delivery, 'check_gate', side_effect=AssertionError('invalid episode reached gate')):
                with self.assertRaises(SystemExit) as raised:
                    self.assemble(episode)
                self.assertEqual(raised.exception.code, 2)
                self.assertFalse((self.project / 'delivery').exists())

    def test_report_carries_the_bound_film_review(self):
        report = self.assemble(14)
        review = report['review']
        self.assertTrue(review['registered'])
        entry = review['entry']
        self.assertEqual(entry['source'], 'export/14.mp4')
        self.assertEqual(entry['sha256'], self.review_entry(14)['sha256'])
        self.assertTrue(entry['reviewed'])
        self.assertEqual(entry['picture'], 'ok')

    def test_missing_registration_assembles_with_notice(self):
        self.rewrite_reviews({k: v for k, v in self.delivery_reviews().items() if k != '14'})
        report, text = self.assemble_notice(14)
        self.assertFalse(report['review']['registered'])
        self.assertIn('没有成片审查登记', text)
        self.assertIn('video-review', text)
        self.assertEqual(self.films(), {'14.mp4': b'master for episode 14'})

    def test_missing_reviews_file_assembles_with_notice(self):
        (self.config / 'film-reviews.json').unlink()
        report, text = self.assemble_notice(14)
        self.assertFalse(report['review']['registered'])
        self.assertIn('没有成片审查登记', text)
        self.assertEqual(self.films(), {'14.mp4': b'master for episode 14'})

    def test_incomplete_review_entry_assembles_with_notice(self):
        for overrides, hint in (({'reviewed': False}, 'reviewed 不是 true'), ({'sha256': 'abcd'}, 'sha256 缺失'),
                                ({'sha256': None}, 'sha256 缺失'), ({'source': ''}, 'source 缺失')):
            with self.subTest(overrides=overrides):
                self.rewrite_reviews({'14': self.review_entry(14, **overrides)})
                report, text = self.assemble_notice(14)
                self.assertFalse(report['review']['registered'])
                self.assertIn(hint, text)
                self.assertEqual(self.films(), {'14.mp4': b'master for episode 14'})

    def test_malformed_review_dimensions_remain_advisory(self):
        for value in ([], {}, ["ok"]):
            with self.subTest(value=value):
                self.rewrite_reviews({'14': self.review_entry(14, audio=value)})
                report, text = self.assemble_notice(14)
                self.assertFalse(report['review']['registered'])
                self.assertIn('audio', text)
                self.assertEqual(self.films(), {'14.mp4': b'master for episode 14'})

    def test_invalid_utf8_review_remains_advisory(self):
        (self.config / 'film-reviews.json').write_bytes(b'\xff')
        report, text = self.assemble_notice(14)
        self.assertFalse(report['review']['registered'])
        self.assertIn('不可读', text)
        self.assertEqual(self.films(), {'14.mp4': b'master for episode 14'})

    def test_invalid_review_source_remains_advisory(self):
        for source in ('\0', '\ud800'):
            with self.subTest(source=source):
                self.rewrite_reviews({'14': self.review_entry(14, source=source)})
                report, text = self.assemble_notice(14)
                self.assertFalse(report['review']['registered'])
                self.assertIn('source 无法解析', text)
                self.assertEqual(self.films(), {'14.mp4': b'master for episode 14'})

    def test_review_bound_to_a_different_master_source_assembles_with_notice(self):
        self.rewrite_reviews({'14': self.review_entry(14, source='export/1.mp4')})
        report, text = self.assemble_notice(14)
        self.assertFalse(report['review']['registered'])
        self.assertIn('与本次母版不一致', text)
        self.assertEqual(self.films(), {'14.mp4': b'master for episode 14'})

    def test_uppercase_sha256_registration_is_accepted(self):
        self.rewrite_reviews({'14': self.review_entry(14, sha256=self.review_entry(14)['sha256'].upper())})
        report = self.assemble(14)
        self.assertTrue(report['review']['registered'])
        self.assertEqual(report['film']['name'], '14.mp4')

    def test_bom_prefixed_review_registration_is_accepted(self):
        data = json.dumps({'films': {'14': self.review_entry(14)}}, ensure_ascii=False)
        (self.config / 'film-reviews.json').write_bytes('﻿'.encode('utf-8') + data.encode('utf-8'))
        report = self.assemble(14)
        self.assertTrue(report['review']['registered'])
        self.assertEqual(report['film']['name'], '14.mp4')

    def test_noncanonical_mapped_master_path_assembles(self):
        self.write('export/sub/placeholder.txt', b'fixture')
        (self.config / 'confirmed-films.json').write_text(
            json.dumps({'films': {'14': 'export/sub/../14.mp4'}}), encoding='utf-8')
        self.rewrite_reviews({'14': self.review_entry(14, source='export/sub/../14.mp4')})
        report = self.assemble(14)
        self.assertTrue(report['review']['registered'])
        self.assertEqual(report['film']['name'], '14.mp4')
        self.assertEqual(self.films(), {'14.mp4': b'master for episode 14'})

    def test_tampered_master_assembles_with_stale_review_notice(self):
        self.masters[14] = self.write('export/14.mp4', b'tampered master for episode 14')
        report, text = self.assemble_notice(14)
        self.assertFalse(report['review']['registered'])
        self.assertIn('SHA-256 与当前母版字节不一致', text)
        self.assertEqual(self.films(), {'14.mp4': b'tampered master for episode 14'})

    def test_unverified_dimension_assembles_with_notice(self):
        self.rewrite_reviews({'14': self.review_entry(14, audio='unverified')})
        report, text = self.assemble_notice(14)
        self.assertFalse(report['review']['registered'])
        self.assertIn('unverified', text)
        self.assertEqual(self.films(), {'14.mp4': b'master for episode 14'})

    def test_review_with_issues_assembles_and_is_reported(self):
        entry = self.review_entry(14, audio='issues',
                                  issues=[{'item': 'bgm_volume', 'time': '00:12-00:18',
                                           'detail': '实测 BGM 增益过低', 'fix': '提高增益后重渲'}])
        self.rewrite_reviews({'14': entry})
        report = self.assemble(14)
        self.assertTrue(report['review']['registered'])
        self.assertEqual(report['review']['entry']['audio'], 'issues')
        self.assertEqual(report['review']['entry']['issues'][0]['item'], 'bgm_volume')
        self.assertEqual(self.films(), {'14.mp4': b'master for episode 14'})

    def delivery_reviews(self):
        return {f'{episode:02d}': self.review_entry(episode) for episode in (1, 14, 140, 1000, 9999)}


if __name__ == '__main__':
    unittest.main()
