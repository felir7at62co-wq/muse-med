"""Offline checks for the subtitle aligner's pure parts; no model, no network.

The fixtures are synthetic character timelines, so the indexing that reads a match
span out of difflib is proven here rather than on an episode.
"""
import importlib.util
import os
import json
import hashlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

PACKAGE = Path(__file__).resolve().parents[2]
SCRIPTS = PACKAGE / 'skills' / 'tweet-drama-draft-build' / 'scripts'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ALIGN = load('align_subtitles_test', SCRIPTS / 'align_subtitles.py')


def timeline(text, start, seconds_per_char):
    """One character timeline for a stretch of recognized text."""
    return [(char, start + index * seconds_per_char,
             start + (index + 1) * seconds_per_char) for index, char in enumerate(text)]


class NormaliseTests(unittest.TestCase):
    def test_drops_punctuation_and_spaces(self):
        self.assertEqual(ALIGN.normalise('他说 A1，。 '), '他说A1')


class RequiredSecondsTests(unittest.TestCase):
    def test_short_line_keeps_the_minimum_and_long_line_the_maximum(self):
        self.assertEqual(ALIGN.required_seconds('甲'), 0.8)
        self.assertEqual(ALIGN.required_seconds('甲' * 80), 9.0)

    def test_punctuation_does_not_stretch_a_line(self):
        self.assertEqual(ALIGN.required_seconds('甲乙丙，。'), ALIGN.required_seconds('甲乙丙'))


class AlignTests(unittest.TestCase):
    def test_reads_the_span_from_the_recognized_side_of_each_match(self):
        # The model heard one extra character before the line, so the match block
        # starts at candidate index 1 while the line's own index stays 0. Reading
        # the span from the line's index would report 0.0-0.4 instead of 0.1-0.5.
        chars = timeline('嗯他说什么', 0.0, 0.1)
        start, end, score, cursor = ALIGN.align('他说什么', chars, 0)
        self.assertAlmostEqual(start, 0.1, places=3)
        self.assertAlmostEqual(end, 0.5, places=3)
        self.assertEqual(score, 1.0)
        self.assertEqual(cursor, 5)

    def test_searches_forward_only_so_a_repeated_line_takes_the_next_one(self):
        chars = timeline('甲乙丙丁甲乙', 0.0, 0.1)
        self.assertAlmostEqual(ALIGN.align('甲乙', chars, 4)[0], 0.4, places=3)
        self.assertAlmostEqual(ALIGN.align('甲乙', chars, 0)[0], 0.0, places=3)

    def test_reports_no_span_when_nothing_matches(self):
        chars = timeline('甲乙丙丁', 0.0, 0.1)
        self.assertEqual(ALIGN.align('完全不同', chars, 0)[2], 0.0)

    def test_requires_a_higher_score_for_a_longer_line(self):
        self.assertLess(ALIGN.acceptance_score('甲乙'), ALIGN.acceptance_score('甲乙丙丁戊己'))


class UnmappedSpeechTests(unittest.TestCase):
    def test_partial_long_line_cannot_certify_its_missing_ending(self):
        line = '都怪这个小伙子不让座就算了还把人推出去了'
        chars = timeline('都怪这个小伙子不让座就算了', 0.0, 0.1)
        anchors = ALIGN.anchor([line], chars)
        self.assertIsNotNone(anchors[0])  # The old 55% threshold accepted this.
        self.assertEqual(ALIGN.unmapped_speech([line], anchors, chars), [])
        self.assertEqual(ALIGN.missing_script_speech([line], anchors, chars),
                         [{'line': 1, 'text': '还把人推出去了'}])

    def test_complete_line_has_no_missing_script_speech(self):
        line = '都怪这个小伙子不让座就算了还把人推出去了'
        chars = timeline(line, 0.0, 0.1)
        anchors = ALIGN.anchor([line], chars)
        self.assertEqual(ALIGN.missing_script_speech([line], anchors, chars), [])

    def test_strict_cli_reports_a_partly_recognized_script_line(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'clip.mp4').write_bytes(b'offline-test')
            line = '都怪这个小伙子不让座就算了还把人推出去了'
            (root / 'shots.json').write_text(json.dumps({'shots': [{'shot': 1, 'video': 'clip.mp4'}]}))
            (root / 'lines.json').write_text(json.dumps({'shots': [{'shot': 1, 'lines': [line]}]}))
            (root / 'receipts.json').write_text(json.dumps({'shots': [{'shot': 1, 'receipt': 'unused.json'}]}))
            args = ['align_subtitles.py', '--project', str(root), '--episode', '1',
                    '--shots', str(root / 'shots.json'), '--lines', str(root / 'lines.json'),
                    '--cloud-transcripts', str(root / 'receipts.json'),
                    '--out', str(root / 'aligned.json'), '--strict']
            output = io.StringIO()
            output.reconfigure = lambda **_: None
            with patch.object(sys, 'argv', args), patch.object(sys, 'stdout', output), \
                    patch.object(ALIGN, 'cloud_characters',
                                 return_value=timeline('都怪这个小伙子不让座就算了', 0.0, 0.1)), \
                    patch.object(ALIGN, 'probe_seconds', return_value=5.0):
                ALIGN.main()
            self.assertIn('提示', output.getvalue())
            result = json.loads((root / 'aligned.json').read_text(encoding='utf-8'))
            self.assertEqual(result['shots'][0]['strategy'], 'missing_script_speech')
            self.assertEqual(result['shots'][0]['missing_script_speech'][0]['text'], '还把人推出去了')

    def test_exact_line_and_short_asr_artifact_do_not_block(self):
        for text in ('一样的嘴脸', '啊啊一样的嘴脸'):
            with self.subTest(text=text):
                chars = timeline(text, 0.0, 0.1)
                anchors = ALIGN.anchor(['一样的嘴脸'], chars)
                self.assertEqual(ALIGN.unmapped_speech(['一样的嘴脸'], anchors, chars), [])

    def test_extra_line_before_script_is_rejected(self):
        chars = timeline('你怎么能推人呢太过分了一样的嘴脸', 0.0, 0.1)
        anchors = ALIGN.anchor(['一样的嘴脸'], chars)
        extras = ALIGN.unmapped_speech(['一样的嘴脸'], anchors, chars)
        self.assertEqual([item['text'] for item in extras], ['你怎么能推人呢太过分了'])

    def test_extra_line_after_script_is_rejected(self):
        chars = timeline('一样的嘴脸你怎么能推人呢', 0.0, 0.1)
        anchors = ALIGN.anchor(['一样的嘴脸'], chars)
        extras = ALIGN.unmapped_speech(['一样的嘴脸'], anchors, chars)
        self.assertEqual([item['text'] for item in extras], ['你怎么能推人呢'])

    def test_inserted_line_inside_anchor_is_rejected(self):
        chars = timeline('原文前半你怎么能推人呢原文后半', 0.0, 0.1)
        anchors = ALIGN.anchor(['原文前半原文后半'], chars)
        extras = ALIGN.unmapped_speech(['原文前半原文后半'], anchors, chars)
        self.assertEqual([item['text'] for item in extras], ['你怎么能推人呢'])

    def test_long_replacement_inside_anchor_is_rejected(self):
        chars = timeline('你怎么能推人呢得对', 0.0, 0.1)
        anchors = ALIGN.anchor(['你说得对'], chars)
        extras = ALIGN.unmapped_speech(['你说得对'], anchors, chars)
        self.assertEqual([item['text'] for item in extras], ['怎么能推人呢'])

    def test_substantial_speech_with_no_declared_lines_is_rejected(self):
        extras = ALIGN.unmapped_speech([], [], timeline('你怎么能推人', 0.0, 0.1))
        self.assertEqual(extras[0]['text'], '你怎么能推人')

    def test_strict_cli_returns_unmapped_speech_without_blocking(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'clip.mp4').write_bytes(b'offline-test')
            (root / 'shots.json').write_text(json.dumps({'shots': [{'shot': 1, 'video': 'clip.mp4'}]}))
            (root / 'lines.json').write_text(json.dumps({'shots': [{'shot': 1, 'lines': ['一样的嘴脸']}]}))
            (root / 'receipts.json').write_text(json.dumps({'shots': [{'shot': 1, 'receipt': 'unused.json'}]}))
            args = ['align_subtitles.py', '--project', str(root), '--episode', '1',
                    '--shots', str(root / 'shots.json'), '--lines', str(root / 'lines.json'),
                    '--cloud-transcripts', str(root / 'receipts.json'),
                    '--out', str(root / 'aligned.json'), '--strict']
            output = io.StringIO()
            output.reconfigure = lambda **_: None
            with patch.object(sys, 'argv', args), patch.object(sys, 'stdout', output), \
                    patch.object(ALIGN, 'cloud_characters',
                                 return_value=timeline('你怎么能推人呢太过分了一样的嘴脸', 0.0, 0.1)), \
                    patch.object(ALIGN, 'probe_seconds', return_value=5.0):
                ALIGN.main()
            self.assertIn('提示', output.getvalue())
            result = json.loads((root / 'aligned.json').read_text(encoding='utf-8'))
            self.assertEqual(result['shots'][0]['strategy'], 'unmapped_speech')


class PlaceTests(unittest.TestCase):
    def test_keeps_a_matched_span_and_fills_the_gap_around_it(self):
        chars = timeline('乙丙', 1.4, 0.1)
        anchors = ALIGN.anchor(['甲句', '乙丙'], chars)
        self.assertIsNone(anchors[0])
        self.assertIsNotNone(anchors[1])
        cues, strategy = ALIGN.place(['甲句', '乙丙'], anchors, 3.0)
        self.assertEqual(strategy, 'anchored')
        self.assertAlmostEqual(cues[1][0], 1.4, places=3)
        # The unmatched line is laid out before the anchor, never across the shot.
        self.assertGreaterEqual(cues[0][0], 0.0)
        self.assertLessEqual(cues[0][1], 1.4)

    def test_labels_a_shot_with_no_match_as_estimated(self):
        cues, strategy = ALIGN.place(['甲句'], [None], 2.0)
        self.assertEqual(strategy, 'estimated_total')
        self.assertEqual(len(cues), 1)

    def test_every_line_anchored_is_reported_as_aligned(self):
        chars = timeline('甲句乙句', 0.0, 0.1)
        anchors = ALIGN.anchor(['甲句', '乙句'], chars)
        cues, strategy = ALIGN.place(['甲句', '乙句'], anchors, 2.0)
        self.assertEqual(strategy, 'asr_aligned')
        self.assertEqual(len(cues), 2)

    def test_short_matched_lines_keep_their_measured_spans(self):
        anchors = [(0.1, 0.3), (0.5, 0.7)]
        cues, strategy = ALIGN.place(['甲', '乙'], anchors, 1.2)
        self.assertEqual(strategy, 'asr_aligned')
        self.assertEqual(cues, anchors)

    def test_matched_spans_outside_the_clip_are_not_compressed(self):
        with self.assertRaisesRegex(SystemExit, '时间'):
            ALIGN.place(['甲', '乙'], [(0.2, 0.4), (1.1, 1.3)], 1.2)

    def test_matched_spans_that_overlap_are_not_retimed(self):
        with self.assertRaisesRegex(SystemExit, '时间'):
            ALIGN.place(['甲', '乙'], [(0.1, 0.6), (0.5, 0.7)], 1.2)

    def test_matched_spans_with_invalid_times_are_rejected(self):
        for span in [(-0.1, 0.2), (0.2, 0.2), (float('nan'), 0.5), (0.1, float('inf'))]:
            with self.subTest(span=span), self.assertRaisesRegex(SystemExit, '时间'):
                ALIGN.place(['甲'], [span], 1.2)

    def test_a_shot_without_lines_places_nothing(self):
        self.assertEqual(ALIGN.place([], [], 2.0), ([], 'no_lines'))


class SettleTests(unittest.TestCase):
    def test_keeps_cues_ordered_and_inside_the_shot(self):
        cues = ALIGN.settle([(0.0, 1.0), (0.5, 2.0)], 3.0)
        self.assertEqual(cues, [(0.0, 1.0), (1.0, 2.0)])

    def test_compresses_instead_of_leaving_zero_length_cues(self):
        cues = ALIGN.settle([(0.0, 5.0), (5.0, 10.0)], 4.0)
        self.assertTrue(all(end > start for start, end in cues))
        self.assertLessEqual(max(end for _, end in cues), 4.0)

    def test_orders_cues_that_would_overlap(self):
        cues = ALIGN.monotonic([(0.0, 2.0), (0.5, 1.0)], 5.0, 0.8)
        self.assertEqual(cues[1][0], 2.0)


class ModelSourceTests(unittest.TestCase):
    def test_bundled_model_env_is_used_without_network_and_explicit_cli_wins(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            bundled, explicit = root / 'bundled', root / 'explicit'
            for directory in (bundled, explicit):
                directory.mkdir()
                for name in ALIGN.MODEL_FILES:
                    (directory / name).write_bytes(b'fixture')
            args = SimpleNamespace(model_dir='', model_url='', model_sha256='', cache_dir=str(root / 'cache'))
            with patch.dict(os.environ, {'MUSE_WHISPER_MODEL_DIR': str(bundled)}), patch.object(ALIGN, 'fetch_model', side_effect=AssertionError('network')):
                self.assertEqual(ALIGN.resolve_model(args), bundled)
                args.model_dir = str(explicit)
                self.assertEqual(ALIGN.resolve_model(args), explicit)
                args.model_dir = ''
                (bundled / 'model.bin').unlink()
                with self.assertRaises(SystemExit):
                    ALIGN.resolve_model(args)

    def test_explicit_archive_choice_precedes_bundled_environment(self):
        args = SimpleNamespace(model_dir='', model_url='https://example.test/model.zip', model_sha256='a' * 64, cache_dir='cache')
        with patch.dict(os.environ, {'MUSE_WHISPER_MODEL_DIR': 'unused'}), patch.object(ALIGN, 'fetch_model', return_value=Path('downloaded')) as fetch:
            self.assertEqual(ALIGN.resolve_model(args), Path('downloaded'))
            fetch.assert_called_once_with(args.model_url, args.model_sha256, Path('cache').resolve())

    def test_default_harness_cache_and_explicit_cache_are_resolved_without_download(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            default = root / 'cache' / 'models' / 'faster-whisper' / 'faster-whisper-fixture'
            explicit = root / 'explicit' / 'faster-whisper-fixture'
            for directory in (default, explicit):
                directory.mkdir(parents=True)
                for name in ALIGN.MODEL_FILES:
                    (directory / name).write_bytes(b'fixture')
            args = SimpleNamespace(model_dir='', model_url='', model_sha256='', cache_dir='')
            with patch.dict(os.environ, {'DSH_HOME': str(root), 'MUSE_WHISPER_MODEL_DIR': ''}), patch.object(ALIGN, 'fetch_model', side_effect=AssertionError('network')):
                self.assertEqual(ALIGN.resolve_model(args), default)
                args.cache_dir = str(explicit.parent)
                self.assertEqual(ALIGN.resolve_model(args), explicit)

    def test_refuses_a_download_without_a_digest(self):
        with self.assertRaises(SystemExit):
            ALIGN.fetch_model('https://example.test/model.zip', '', Path('/tmp/never-used'))

    def test_names_every_way_to_supply_the_model(self):
        class Args:
            model_dir = ''
            model_url = ''
            model_sha256 = ''
            cache_dir = ''

        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {'MUSE_WHISPER_MODEL_DIR': ''}):
            args = Args()
            args.cache_dir = temporary
            with self.assertRaises(SystemExit) as caught:
                ALIGN.resolve_model(args)
        message = str(caught.exception)
        self.assertIn('--model-dir', message)
        self.assertIn('--model-url', message)
        self.assertIn('模型仓库', message)


class OfflineSilentShotTests(unittest.TestCase):
    def run_silent_shot(self, recognized):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / 'shot.mp4'
            video.write_bytes(b'offline-test')
            (root / 'shots.json').write_text(json.dumps({'shots': [{'shot': 1, 'video': 'shot.mp4'}]}))
            (root / 'lines.json').write_text(json.dumps({'shots': [{'shot': 1, 'lines': []}]}))
            args = ['align_subtitles.py', '--project', str(root), '--episode', '1',
                    '--shots', str(root / 'shots.json'), '--lines', str(root / 'lines.json'),
                    '--model-dir', str(root), '--out', str(root / 'aligned.json'), '--strict']
            output = io.StringIO()
            output.reconfigure = lambda **_: None
            fake_whisper = SimpleNamespace(WhisperModel=lambda *_, **__: object())
            with patch.object(sys, 'argv', args), patch.object(sys, 'stdout', output), \
                    patch.dict(sys.modules, {'faster_whisper': fake_whisper}), \
                    patch.object(ALIGN, 'resolve_model', return_value=root), \
                    patch.object(ALIGN, 'transcribe', return_value=recognized) as transcribe, \
                    patch.object(ALIGN, 'probe_seconds', return_value=4.0):
                ALIGN.main()
                if recognized:
                    self.assertIn("提示", output.getvalue())
            transcribe.assert_called_once()
            self.assertEqual(transcribe.call_args.args[0], video.resolve())
            return json.loads((root / 'aligned.json').read_text(encoding='utf-8'))

    def test_offline_model_detects_unplanned_speech_in_declared_silent_shot(self):
        result = self.run_silent_shot(timeline('你怎么能推人', 0.0, 0.1))
        self.assertEqual(result['shots'][0]['strategy'], 'unmapped_speech')

    def test_offline_model_checks_a_truly_silent_shot(self):
        result = self.run_silent_shot([])
        self.assertEqual(result['shots'][0]['strategy'], 'no_lines')


class CloudReceiptTests(unittest.TestCase):
    def test_cloud_mode_reports_unverified_silence_without_a_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'shot.mp4').write_bytes(b'offline-test')
            (root / 'shots.json').write_text(json.dumps({'shots': [{'shot': 1, 'video': 'shot.mp4'}]}))
            (root / 'lines.json').write_text(json.dumps({'shots': [{'shot': 1, 'lines': []}]}))
            (root / 'receipts.json').write_text(json.dumps({'shots': []}))
            args = ['align_subtitles.py', '--project', str(root), '--episode', '1',
                    '--shots', str(root / 'shots.json'), '--lines', str(root / 'lines.json'),
                    '--cloud-transcripts', str(root / 'receipts.json'),
                    '--out', str(root / 'aligned.json'), '--strict']
            with patch.object(sys, 'argv', args):
                ALIGN.main()
            result = json.loads((root / 'aligned.json').read_text(encoding='utf-8'))
            self.assertEqual(result['shots'][0]['strategy'], 'missing_evidence')
            self.assertEqual(result['shots'][0]['cues'], [])
            self.assertTrue(result['shots'][0]['warnings'])

    def test_matches_words_to_current_source_and_rejects_replaced_video(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / 'shot.mp4'
            video.write_bytes(b'source')
            jobs, raw = root / 'transcript/jobs', root / 'transcript/raw'
            jobs.mkdir(parents=True)
            raw.mkdir()
            receipt = jobs / 'shot-v1.json'
            receipt.write_text(json.dumps({'status': 'complete', 'source': str(video), 'stem': 'shot', 'version': 1,
                'sourceSha256': hashlib.sha256(b'source').hexdigest()}), encoding='utf-8')
            output = raw / 'shot-v1.json'
            output.write_text(json.dumps([{'start': 0, 'end': 2, 'text': '你好', 'words': [
                {'start': 0.2, 'end': 0.5, 'text': '你'}, {'start': 0.8, 'end': 1.2, 'text': '好'}]}]), encoding='utf-8')
            self.assertEqual(ALIGN.cloud_characters(video, receipt), [('你', 0.2, 0.5), ('好', 0.8, 1.2)])
            output.write_text(json.dumps([{'start': 0, 'end': 2, 'text': '你好'}]), encoding='utf-8')
            with self.assertRaisesRegex(SystemExit, '字词时间戳'):
                ALIGN.cloud_characters(video, receipt)
            output.write_text('[]', encoding='utf-8')
            self.assertEqual(ALIGN.cloud_characters(video, receipt, allow_empty=True), [])
            with self.assertRaisesRegex(SystemExit, '语音片段'):
                ALIGN.cloud_characters(video, receipt)
            video.write_bytes(b'changed')
            with self.assertRaisesRegex(SystemExit, '内容已变化'):
                ALIGN.cloud_characters(video, receipt)

    def test_silent_receipt_verifies_a_no_lines_shot_without_raw_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / 'shot.mp4'
            video.write_bytes(b'silent-source')
            jobs = root / 'transcript/jobs'
            jobs.mkdir(parents=True)
            receipt = jobs / 'shot-v1.json'
            receipt.write_text(json.dumps({'status': 'silent', 'source': str(video), 'stem': 'shot', 'version': 1,
                'sourceSha256': hashlib.sha256(b'silent-source').hexdigest()}), encoding='utf-8')
            self.assertEqual(ALIGN.cloud_characters(video, receipt, allow_empty=True), [])
            with self.assertRaisesRegex(SystemExit, '剧本含台词'):
                ALIGN.cloud_characters(video, receipt)
            video.write_bytes(b'changed')
            with self.assertRaisesRegex(SystemExit, '内容已变化'):
                ALIGN.cloud_characters(video, receipt, allow_empty=True)


if __name__ == '__main__':
    unittest.main()
