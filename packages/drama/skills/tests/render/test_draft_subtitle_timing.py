"""Subtitle normalization keeps measured cue boundaries; no network or media writes."""
import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / 'skills/tweet-drama-draft-build/scripts/jianying_draft.py'


class DraftSubtitleTimingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import pyJianYingDraft  # noqa: F401
        except ImportError as error:
            raise unittest.SkipTest(f'pyJianYingDraft is not installed: {error}')
        spec = importlib.util.spec_from_file_location('draft_subtitle_timing', SCRIPT)
        cls.draft = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.draft)

    def test_short_cues_keep_speech_times_and_the_gap_between_lines(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = Path(temporary) / 'source.srt', Path(temporary) / 'normalized.srt'
            source.write_text('1\n00:00:00,100 --> 00:00:00,300\n甲。\n\n'
                              '2\n00:00:00,500 --> 00:00:00,700\n乙！\n', encoding='utf-8')
            cues = self.draft.normalize_srt(source, output)
            self.assertEqual([(cue['start_us'], cue['end_us']) for cue in cues],
                             [(100_000, 300_000), (500_000, 700_000)])
            self.assertEqual([cue['text'] for cue in cues], ['甲', '乙'])

    def test_long_cue_without_split_speech_times_is_rejected_without_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = Path(temporary) / 'source.srt', Path(temporary) / 'normalized.srt'
            source.write_text('1\n00:00:00,100 --> 00:00:08,000\n'
                              '这是第一段台词 这是第二段台词 后面还有一段台词\n', encoding='utf-8')
            with self.assertRaisesRegex(self.draft.DraftInputError, '分句.*时间'):
                self.draft.normalize_srt(source, output)
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
