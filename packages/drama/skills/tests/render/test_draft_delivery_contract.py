"""The draft build's timeline contract, audio gain, subtitle text rules and delivery gate.

The generation tests run the real generator against real (tiny) media through the installed
`pyJianYingDraft` and ffmpeg; they skip when either is unavailable. Every fixture stays in a
temporary directory.
"""
import argparse
import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / 'skills/tweet-drama-draft-build/scripts/jianying_draft.py'
TIMELINE = {'clips': [{'shot': 1, 'start_us': 0, 'duration_us': 2_000_000},
                      {'shot': 2, 'start_us': 2_000_000, 'duration_us': 2_000_000}]}
SRT = ('1\n00:00:00,000 --> 00:00:00,900\n孕八周。指标目前正常。\n\n'
       '2\n00:00:00,900 --> 00:00:02,000\n但你最近睡眠不太好，注意休息。\n\n'
       '3\n00:00:02,000 --> 00:00:04,000\n八周？\n')
DRAFT_NAME = '候选A-25'


def load_draft_module():
    spec = importlib.util.spec_from_file_location('draft_delivery_contract', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DraftDeliveryContractTests(unittest.TestCase):
    module = None
    media = None

    @classmethod
    def setUpClass(cls):
        try:
            import pyJianYingDraft  # noqa: F401 - the generator imports it at module level
        except ImportError as error:  # pragma: no cover - the library is optional
            raise unittest.SkipTest(f'pyJianYingDraft is not installed: {error}')
        for binary in ('ffmpeg', 'ffprobe'):
            if shutil.which(binary) is None:  # pragma: no cover - ffmpeg is a documented dependency
                raise unittest.SkipTest(f'{binary} is not on PATH')
        cls.module = load_draft_module()
        cls.media = tempfile.TemporaryDirectory()
        source = Path(cls.media.name)
        cls.audio = source / '25.wav'
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
                        '-i', 'sine=frequency=440:duration=4', '-ar', '48000', '-ac', '2',
                        str(cls.audio)], check=True)
        for shot in (1, 2):
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
                            '-i', 'testsrc=size=160x120:rate=24:duration=2', '-pix_fmt', 'yuv420p',
                            str(source / f'p{shot}.mp4')], check=True)

    @classmethod
    def tearDownClass(cls):
        if cls.media is not None:
            cls.media.cleanup()

    def build_root(self, timeline=TIMELINE, srt=SRT):
        """Lay out one episode's materials the way `DraftGenerator.prepare_materials` does."""
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        source = Path(self.media.name)
        (root / '01_audio').mkdir(parents=True)
        (root / '02_media' / '25').mkdir(parents=True)
        shutil.copy2(self.audio, root / '01_audio' / '25.wav')
        for shot in (1, 2):
            shutil.copy2(source / f'p{shot}.mp4', root / '02_media' / '25' / f'p{shot}.mp4')
        if timeline is not None:
            (root / '05_timeline').mkdir()
            (root / '05_timeline' / '25.timeline.json').write_text(
                json.dumps(timeline, ensure_ascii=False), encoding='utf-8')
        if srt is not None:
            (root / '03_subtitle').mkdir()
            (root / '03_subtitle' / '25.srt').write_text(srt, encoding='utf-8')
        return root

    def generate(self, root):
        args = argparse.Namespace(drafts=str(root / 'jianying'), materials=str(root / 'materials'),
                                  template_dir=None, seq=None, name_prefix='候选A-', project=str(root))
        shutil.copytree(root, root / 'materials')
        (root / 'jianying').mkdir()
        self.module.main_with_args(args)
        return root / 'jianying' / DRAFT_NAME

    def generate_content(self, root):
        draft = self.generate(root)
        return json.loads((draft / 'draft_content.json').read_text(encoding='utf-8'))

    @staticmethod
    def segments(content, track_type):
        return [segment for track in content['tracks'] if track['type'] == track_type
                for segment in track['segments']]

    @staticmethod
    def clips(timeline=TIMELINE):
        return {clip['shot']: {'start_us': clip['start_us'], 'duration_us': clip['duration_us']}
                for clip in timeline['clips']}

    @staticmethod
    def texts(content):
        by_id = {material['id']: material for material in content['materials']['texts']}
        return [json.loads(by_id[segment['material_id']]['content'])
                for segment in DraftDeliveryContractTests.segments(content, 'text')]

    def test_a_timeline_with_other_field_names_refuses_instead_of_defaulting_to_five_seconds(self):
        root = self.build_root(timeline={'shots': [{'shot': 1, 'start': 0, 'end': 2},
                                                   {'shot': 2, 'start': 2, 'end': 4}]})
        with self.assertRaisesRegex(self.module.DraftInputError, 'clips') as raised:
            self.generate(root)
        message = str(raised.exception)
        self.assertIn('shots', message)
        self.assertIn('start_us', message)
        self.assertFalse((root / 'jianying' / DRAFT_NAME).exists())

    def test_every_shot_takes_its_own_duration_from_the_timeline(self):
        content = self.generate_content(self.build_root())
        video = self.segments(content, 'video')
        audio = self.segments(content, 'audio')
        self.assertEqual([segment['target_timerange']['duration'] for segment in video],
                         [2_000_000, 2_000_000])
        self.assertEqual([segment['target_timerange']['start'] for segment in video],
                         [0, 2_000_000])
        self.assertEqual(len(video), len(TIMELINE['clips']))
        video_total = sum(segment['target_timerange']['duration'] for segment in video)
        audio_total = sum(segment['target_timerange']['duration'] for segment in audio)
        self.assertLessEqual(abs(video_total - audio_total), self.module.TIMELINE_TOLERANCE_US)
        self.assertEqual(audio_total, 4_000_000)
        self.assertNotIn(self.module.DEFAULT_SHOT_DURATION_US,
                         [segment['target_timerange']['duration'] for segment in video])

    def test_a_normalized_input_track_is_written_at_unit_gain(self):
        content = self.generate_content(self.build_root())
        self.assertEqual(self.module.VOICE_VOLUME, 1.0)
        self.assertEqual([segment['volume'] for segment in self.segments(content, 'audio')], [1.0])

    def test_punctuated_lines_become_single_line_cues_matching_the_draft(self):
        root = self.build_root()
        content = self.generate_content(root)
        texts = self.texts(content)
        self.assertEqual(len(texts), 3)
        for style in texts:
            text = style['text']
            self.assertFalse([char for char in text if char in self.module.SUBTITLE_PUNCTUATION], text)
            self.assertNotIn('\n', text)
            self.assertLessEqual(self.module.effective_character_count(text),
                                 self.module.SUBTITLE_MAX_EFFECTIVE_CHARS)
        normalized = (root / 'jianying' / DRAFT_NAME / '25.normalized.srt')
        cues = [cue['text'] for cue in self.module.parse_srt_cues(normalized)]
        self.assertEqual(len(cues), len(texts))
        self.assertEqual(cues, [style['text'] for style in texts])
        self.assertNotIn('。', normalized.read_text(encoding='utf-8'))

    def test_long_unsplit_subtitle_refuses_before_draft_creation(self):
        root = self.build_root(srt='1\n00:00:00,000 --> 00:00:04,000\n'
                                   '孕八周。指标目前正常，但你最近睡眠不太好，注意休息。\n')
        with self.assertRaisesRegex(self.module.DraftInputError, '分句.*时间'):
            self.generate(root)
        self.assertFalse((root / 'jianying' / DRAFT_NAME).exists())

    def test_draft_segments_keep_short_speech_spans_and_pauses(self):
        srt = ('1\n00:00:00,100 --> 00:00:00,300\n甲。\n\n'
               '2\n00:00:00,500 --> 00:00:00,700\n乙！\n\n'
               '3\n00:00:02,200 --> 00:00:02,400\n丙。\n')
        content = self.generate_content(self.build_root(srt=srt))
        segments = self.segments(content, 'text')
        spans = [(segment['target_timerange']['start'],
                  segment['target_timerange']['start'] + segment['target_timerange']['duration'])
                 for segment in segments]
        self.assertEqual(spans, [(100_000, 300_000), (500_000, 700_000), (2_200_000, 2_400_000)])

    def test_a_timeline_that_disagrees_with_the_audio_is_refused(self):
        fifteen_seconds = {'clips': [{'shot': shot, 'start_us': (shot - 1) * 5_000_000,
                                      'duration_us': 5_000_000} for shot in (1, 2, 3)]}
        root = self.build_root(timeline=fifteen_seconds)
        with self.assertRaisesRegex(self.module.DraftInputError, '各段时长之和') as raised:
            self.generate(root)
        self.assertIn('15.000', str(raised.exception))
        self.assertIn('4.000', str(raised.exception))
        self.assertFalse((root / 'jianying' / DRAFT_NAME).exists())

    def test_the_delivery_gate_rejects_a_draft_whose_picture_does_not_match_its_audio(self):
        content = self.generate_content(self.build_root())
        self.module.verify_draft_delivery(content, self.clips(), 4_000_000,
                                          [{'text': text['text']} for text in self.texts(content)])
        self.segments(content, 'video')[1]['target_timerange']['duration'] = 5_000_000
        with self.assertRaisesRegex(self.module.DraftInputError, '视频总时长'):
            self.module.verify_draft_delivery(content, self.clips(), 4_000_000, [{}] * 3)

    def test_the_delivery_gate_rejects_a_draft_without_a_timeline(self):
        content = self.generate_content(self.build_root())
        with self.assertRaisesRegex(self.module.DraftInputError, '没有时间线'):
            self.module.verify_draft_delivery(content, {}, 4_000_000, [{}] * 3)

    def test_the_delivery_gate_rejects_missing_subtitle_style_fields(self):
        content = self.generate_content(self.build_root())
        material = content['materials']['texts'][0]
        inner = json.loads(material['content'])
        inner['styles'][0].pop('size')
        material['content'] = json.dumps(inner, ensure_ascii=False)
        with self.assertRaisesRegex(self.module.DraftInputError, '字号'):
            self.module.verify_draft_delivery(content, self.clips(), 4_000_000, [{}] * 3)


if __name__ == '__main__':
    unittest.main()
