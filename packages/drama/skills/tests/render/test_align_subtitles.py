"""Offline checks for the subtitle aligner's pure parts; no model, no network.

The fixtures are synthetic character timelines, so the indexing that reads a match
span out of difflib is proven here rather than on an episode.
"""
import importlib.util
import os
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
            root = Path(temporary)
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
            root = Path(temporary)
            default = root / 'cache' / 'models' / 'faster-whisper' / 'faster-whisper-fixture'
            explicit = root / 'explicit' / 'faster-whisper-fixture'
            for directory in (default, explicit):
                directory.mkdir(parents=True)
                for name in ALIGN.MODEL_FILES:
                    (directory / name).write_bytes(b'fixture')
            args = SimpleNamespace(model_dir='', model_url='', model_sha256='', cache_dir='')
            with patch.dict(os.environ, {'DSH_HOME': temporary, 'MUSE_WHISPER_MODEL_DIR': ''}), patch.object(ALIGN, 'fetch_model', side_effect=AssertionError('network')):
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


if __name__ == '__main__':
    unittest.main()
