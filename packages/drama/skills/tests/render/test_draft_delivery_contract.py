"""The draft build's timeline contract, audio gain, subtitle text rules and delivery gate.

The generation tests run the real generator against real (tiny) media through the installed
`pyJianYingDraft` and ffmpeg; they skip when either is unavailable. Every fixture stays in a
temporary directory.
"""
import argparse
import errno
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import os
import sys
from unittest.mock import patch
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


def windows_start_error(winerror, filename=None):
    """Model Windows startup metadata on both Windows and POSIX test hosts."""
    error = OSError(0, 'decoder startup failed', filename, winerror)
    if os.name != 'nt':
        error.winerror = winerror
    return error


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

    def test_direct_request_uses_upstream_library_and_retains_only_selected_episode_sources(self):
        root = self.build_root(timeline=self.delivery_timeline('animation_3d'))
        drafts = root / 'editor'
        drafts.mkdir()
        spec = importlib.util.spec_from_file_location('draft_request', SCRIPT.with_name('generate_draft_request.py'))
        request_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(request_module)
        request = {'project': str(root), 'episode': 25, 'name_prefix': '请求-',
                   'audio': str(root / '01_audio/25.wav'),
                   'videos': [str(root / f'02_media/25/p{shot}.mp4') for shot in (1, 2)],
                   'subtitle_srt': str(root / '03_subtitle/25.srt'),
                   'timeline': str(root / '05_timeline/25.timeline.json')}
        with patch.object(sys, 'path', [str(SCRIPT.parent), *sys.path]):
            result = request_module.generate_request(request, str(drafts))
        self.assertTrue(result['success'], result)
        self.assertEqual(result['drafts_created'], 1)
        self.assertEqual(result['library']['name'], 'pyJianYingDraft')
        self.assertFalse(result['editor_open_verified'])
        content_path = Path(result['drafts'][0]['path']) / 'draft_content.json'
        saved = content_path.read_bytes()
        content = json.loads(saved)
        self.assertEqual(content['duration'], 4_000_000)
        self.assertEqual(len(self.texts(content)), 3)
        for material in content['materials']['videos']:
            self.assertTrue(Path(material['path']).is_file())
        self.assertEqual(len(list((Path(result['materials_dir']) / '02_media').iterdir())), 1)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            request_module.generate_request(request, str(drafts))
        self.assertEqual(content_path.read_bytes(), saved)

    @staticmethod
    def segments(content, track_type):
        return [segment for track in content['tracks'] if track['type'] == track_type
                for segment in track['segments'] if track.get('name') not in ('AI内容标识', '片尾特效')]

    @staticmethod
    def clips(timeline=TIMELINE):
        return {clip['shot']: {'start_us': clip['start_us'], 'duration_us': clip['duration_us']}
                for clip in timeline['clips']}

    @staticmethod
    def texts(content):
        by_id = {material['id']: material for material in content['materials']['texts']}
        return [json.loads(by_id[segment['material_id']]['content'])
                for segment in DraftDeliveryContractTests.segments(content, 'text')]

    @staticmethod
    def delivery_timeline(medium, **extra):
        return {**TIMELINE, 'delivery': {'visual_medium': medium, 'width': 2560, 'height': 1440, 'fps': 30}, **extra}

    def test_animation_draft_has_only_body_and_never_reads_or_generates_ending_assets(self):
        root = self.build_root(timeline=self.delivery_timeline('animation_3d'))
        (root / '06_ending').mkdir()
        for name in ('ending_audio.mp3', 'ending_effect.mp4'):
            (root / '06_ending' / name).write_bytes(b'stale unusable ending asset')
        with patch.object(self.module, 'extract_draft_tail', side_effect=AssertionError('no tail extraction')), \
                patch.object(self.module, 'append_draft_watermark', side_effect=AssertionError('no added mark')):
            draft_dir = self.generate(root)
        content = json.loads((draft_dir / 'draft_content.json').read_text(encoding='utf-8'))
        self.assertEqual(content['duration'], 4_000_000)
        self.assertEqual(content['canvas_config']['width'], 2560)
        self.assertEqual(content['canvas_config']['height'], 1440)
        self.assertEqual(content['fps'], 30)
        self.assertEqual(len(self.segments(content, 'video')), 2)
        self.assertFalse({'片尾音', '片尾特效', 'AI内容标识'} & {track['name'] for track in content['tracks']})
        self.assertNotIn('内容由AI生成', json.dumps(content, ensure_ascii=False))
        self.assertFalse((draft_dir / 'Resources/last_video_tail_frame.png').exists())
        self.assertFalse((draft_dir / 'ending-evidence.json').exists())
        self.assertEqual(len(self.texts(content)), 3)

    def test_landscape_delivery_snapshot_preserves_unit_scale_for_854_by_480_source(self):
        timeline = self.delivery_timeline('animation_3d')
        timeline['delivery'].update(width=1920, height=1080, fps=30)
        root = self.build_root(timeline=timeline)
        for shot in (1, 2):
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                            'color=blue:s=854x480:r=24:d=2', '-pix_fmt', 'yuv420p',
                            str(root / f'02_media/25/p{shot}.mp4')], check=True)
        content = self.generate_content(root)
        self.assertEqual((content['canvas_config']['width'], content['canvas_config']['height']), (1920, 1080))
        for segment in self.segments(content, 'video'):
            self.assertEqual(segment['clip']['scale'], {'x': 1.0, 'y': 1.0})
        self.assertEqual({(item['width'], item['height']) for item in content['materials']['videos']}, {(854, 480)})

    def test_explicit_photorealistic_draft_retains_ending_and_notice(self):
        content = self.generate_content(self.build_root(timeline=self.delivery_timeline('photorealistic')))
        self.assertEqual(content['duration'], 6_000_000)
        self.assertEqual(len(self.segments(content, 'video')), 3)
        self.assertEqual(len([track for track in content['tracks'] if track['name'] == 'AI内容标识']), 1)

    def test_animation_draft_verifier_rejects_generated_mark_ending_and_extra_duration(self):
        root = self.build_root(timeline=self.delivery_timeline('animation_3d'))
        content = self.generate_content(root)
        plan = self.module.draft_ending_plan(root / '05_timeline/25.timeline.json', self.clips())
        cues = [{'text': text['text']} for text in self.texts(content)]
        self.module.verify_draft_delivery(content, self.clips(), 4_000_000, cues, plan)
        for track_name, message in (('AI内容标识', '不得添加 AI'), ('片尾音', '不得包含生成的片尾')):
            bad = json.loads(json.dumps(content))
            bad['tracks'].append({'type': 'text' if track_name == 'AI内容标识' else 'audio',
                                  'name': track_name, 'segments': []})
            with self.subTest(track=track_name), self.assertRaisesRegex(self.module.DraftInputError, message):
                self.module.verify_draft_delivery(bad, self.clips(), 4_000_000, cues, plan)
        content['duration'] = 6_000_000
        with self.assertRaisesRegex(self.module.DraftInputError, '总时长必须等于正文'):
            self.module.verify_draft_delivery(content, self.clips(), 4_000_000, cues, plan)

    def test_conflicting_medium_or_included_animation_ending_refuses_before_draft_creation(self):
        for mode in ('conflict', 'included'):
            timeline = self.delivery_timeline('animation_3d', **({'body_end': 2} if mode == 'included' else {}))
            root = self.build_root(timeline=timeline)
            if mode == 'conflict':
                (root / 'project_config.json').write_text(json.dumps({
                    'project_bible': {'visual_medium': 'photorealistic'}}), encoding='utf-8')
            with self.subTest(mode=mode), self.assertRaisesRegex(self.module.DraftInputError, 'prepare'):
                self.generate(root)
            self.assertFalse((root / 'jianying' / DRAFT_NAME).exists())

    def test_preparing_animation_ignores_missing_selected_endings_and_preserves_snapshot(self):
        root = self.build_root(timeline=self.delivery_timeline('animation_3d'))
        spec = importlib.util.spec_from_file_location('draft_prepare_animation', SCRIPT.with_name('draft_generator.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        materials = root / 'materials'
        module.DraftGenerator().prepare_materials(
            str(root / '01_audio'), str(root / '02_media'), str(materials),
            timeline_dir=str(root / '05_timeline'), project=str(root),
            ending_audio=str(root / 'missing.mp3'), ending_effect=str(root / 'missing.mp4'))
        self.assertFalse((materials / '06_ending').exists())
        self.assertEqual((materials / '05_timeline/25.timeline.json').read_bytes(),
                         (root / '05_timeline/25.timeline.json').read_bytes())

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
                         [2_000_000, 2_000_000, 2_000_000])
        self.assertEqual([segment['target_timerange']['start'] for segment in video],
                         [0, 2_000_000, 4_000_000])
        self.assertEqual(len(video), len(TIMELINE['clips']) + 1)
        video_total = sum(segment['target_timerange']['duration'] for segment in video)
        audio_total = sum(segment['target_timerange']['duration'] for segment in audio)
        self.assertLessEqual(abs(video_total - audio_total - 2_000_000), self.module.TIMELINE_TOLERANCE_US)
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

    def test_long_unsplit_subtitle_preserves_text_in_a_reviewable_draft(self):
        root = self.build_root(srt='1\n00:00:00,000 --> 00:00:04,000\n'
                                   '孕八周。指标目前正常，但你最近睡眠不太好，注意休息。\n')
        with self.assertLogs(self.module.logger, level='WARNING') as notes:
            self.generate(root)
        self.assertIn('建议长度', '\n'.join(notes.output))
        draft = root / 'jianying' / DRAFT_NAME
        self.assertTrue((draft / 'draft_content.json').is_file())
        self.assertTrue(json.loads((draft / 'muse-review.json').read_text())['warnings'])

    def test_alignment_warning_preserves_a_reviewable_subtitled_draft(self):
        root = self.build_root()
        (root / '03_subtitle/25.srt.blocked').write_text('alignment pending', encoding='utf-8')
        with self.assertLogs(self.module.logger, level='WARNING') as notes:
            self.generate(root)
        self.assertIn('字幕对齐待核', '\n'.join(notes.output))
        draft = root / 'jianying' / DRAFT_NAME
        self.assertTrue((draft / 'draft_content.json').is_file())
        self.assertTrue(json.loads((draft / 'muse-review.json').read_text())['warnings'])

    def test_alignment_warning_without_srt_preserves_other_tracks(self):
        root = self.build_root(srt=None)
        (root / '03_subtitle').mkdir()
        (root / '03_subtitle/25.srt.blocked').write_text('alignment pending', encoding='utf-8')
        with self.assertLogs(self.module.logger, level='WARNING') as notes:
            self.generate(root)
        self.assertIn('字幕对齐待核', '\n'.join(notes.output))
        draft = root / 'jianying' / DRAFT_NAME
        self.assertTrue((draft / 'draft_content.json').is_file())
        self.assertTrue(json.loads((draft / 'muse-review.json').read_text())['warnings'])

    def test_subtitle_import_failure_returns_a_warning_and_saved_candidate(self):
        root = self.build_root()
        with patch.object(self.module.draft.ScriptFile, 'import_srt', side_effect=RuntimeError('import failed')):
            with self.assertLogs(self.module.logger, level='WARNING') as notes:
                self.generate(root)
        self.assertIn('字幕未导入', '\n'.join(notes.output))
        self.assertTrue((root / 'jianying' / DRAFT_NAME / 'draft_content.json').is_file())

    def test_bgm_import_failure_returns_a_warning_and_saved_candidate(self):
        root = self.build_root()
        bgm = root / '04_bgm'
        bgm.mkdir()
        (bgm / 'mix.mp3').write_bytes(b'not audio')
        with self.assertLogs(self.module.logger, level='WARNING') as notes:
            self.generate(root)
        self.assertIn('BGM 未导入', '\n'.join(notes.output))
        draft = root / 'jianying' / DRAFT_NAME
        self.assertTrue((draft / 'draft_content.json').is_file())
        self.assertTrue(json.loads((draft / 'muse-review.json').read_text())['warnings'])

    def test_short_bgm_is_kept_without_looping_and_reported_for_review(self):
        root = self.build_root()
        bgm = root / '04_bgm'
        bgm.mkdir()
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
                        '-i', 'sine=frequency=330:duration=1', str(bgm / 'mix.wav')], check=True)
        with self.assertLogs(self.module.logger, level='WARNING') as notes:
            self.generate(root)
        self.assertIn('时长短于正文', '\n'.join(notes.output))
        draft = root / 'jianying' / DRAFT_NAME
        self.assertTrue((draft / 'draft_content.json').is_file())
        self.assertTrue(json.loads((draft / 'muse-review.json').read_text())['warnings'])

    def test_verified_bgm_and_subtitles_remain_editable_tracks(self):
        root = self.build_root(timeline=self.delivery_timeline('animation_3d'))
        bgm = root / '04_bgm'
        bgm.mkdir()
        shutil.copy2(root / '01_audio/25.wav', bgm / 'approved-mix.wav')
        content = self.generate_content(root)
        tracks = {track['name']: track for track in content['tracks']}
        self.assertEqual(len(tracks['BGM轨道']['segments']), 1)
        self.assertEqual(tracks['BGM轨道']['segments'][0]['target_timerange']['duration'], 4_000_000)
        self.assertEqual(len(tracks['字幕轨道']['segments']), 3)

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
        material_id = self.segments(content, 'text')[0]['material_id']
        material = next(item for item in content['materials']['texts'] if item['id'] == material_id)
        inner = json.loads(material['content'])
        inner['styles'][0].pop('size')
        material['content'] = json.dumps(inner, ensure_ascii=False)
        with self.assertRaisesRegex(self.module.DraftInputError, '字号'):
            self.module.verify_draft_delivery(content, self.clips(), 4_000_000, [{}] * 3)

    def test_ending_is_an_editable_image_of_the_true_last_decoded_video_frame(self):
        root = self.build_root()
        distractor = root / '02_media/25/p2.png'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                        'color=blue:s=160x120', '-frames:v', '1', str(distractor)], check=True)
        draft_dir = self.generate(root)
        content = json.loads((draft_dir / 'draft_content.json').read_text(encoding='utf-8'))
        ending = self.segments(content, 'video')[-1]
        materials = {item['id']: item for item in content['materials']['videos']}
        material = materials[ending['material_id']]
        self.assertEqual(material['type'], 'photo')
        self.assertEqual(Path(material['path']).name, 'last_video_tail_frame.png')
        self.assertEqual(ending['target_timerange'], {'start': 4_000_000, 'duration': 2_000_000})
        decoded = self.module.decoded_frame_hashes(root / '02_media/25/p2.mp4')
        self.assertEqual(len(decoded), 48)
        self.assertNotEqual(decoded[-1], decoded[-2])
        expected = decoded[-1:]
        self.assertEqual(self.module.decoded_frame_hashes(Path(material['path'])), expected)
        self.assertNotEqual(self.module.decoded_frame_hashes(distractor), expected)
        evidence = json.loads((draft_dir / 'ending-evidence.json').read_text(encoding='utf-8'))
        self.assertEqual(evidence['frame_rgb_md5'], expected[0])
        self.assertEqual(evidence['body_end_us'], 4_000_000)
        self.assertEqual(evidence['duration_us'], 6_000_000)
        self.assertFalse(evidence['already_included'])
        self.assertEqual(len(self.segments(content, 'video')), 3)

    def test_freeze_uses_the_tail_of_the_selected_interval_instead_of_unused_video(self):
        root = self.build_root()
        source = root / '02_media/25/p2.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                        'testsrc=size=160x120:rate=24:duration=3', '-pix_fmt', 'yuv420p',
                        str(source)], check=True)
        draft_dir = self.generate(root)
        image = draft_dir / 'Resources/last_video_tail_frame.png'
        selected = self.module.decoded_frame_hashes(source, 2_000_000)[-1:]
        self.assertNotEqual(selected, self.module.decoded_frame_hashes(source)[-1:])
        self.assertEqual(self.module.decoded_frame_hashes(image), selected)

    def test_variable_frame_rate_and_audio_do_not_change_which_frame_is_the_tail(self):
        root = self.build_root()
        source = root / '02_media/25/p2.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                        'testsrc=size=160x120:rate=24:duration=2', '-f', 'lavfi', '-i',
                        'sine=frequency=110:duration=2', '-vf', 'select=not(eq(mod(n\\,3)\\,0))',
                        '-fps_mode', 'vfr', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(source)], check=True)
        target = root / 'tail.png'
        expected = self.module.decoded_frame_hashes(source)
        self.module.extract_draft_tail(source, 2_000_000, target)
        self.assertEqual(self.module.decoded_frame_hashes(target), expected[-1:])

    def test_existing_two_second_ending_is_replaced_without_appending_a_second_ending(self):
        timeline = {'clips': [{'shot': 1, 'start_us': 0, 'duration_us': 2_000_000},
                              {'shot': 2, 'start_us': 2_000_000, 'duration_us': 4_000_000}],
                    'body_end': 4.0}
        root = self.build_root(timeline=timeline)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                        'testsrc=size=160x120:rate=24:duration=2', '-vf',
                        'tpad=stop_mode=clone:stop_duration=2', '-pix_fmt', 'yuv420p',
                        str(root / '02_media/25/p2.mp4')], check=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                        'sine=frequency=440:duration=6', '-ar', '48000', '-ac', '2',
                        str(root / '01_audio/25.wav')], check=True)
        (root / '06_ending').mkdir()
        shutil.copy2(SCRIPT.parents[2] / 'tweet-drama-background-render/assets/ending_audio.mp3',
                     root / '06_ending/ending_audio.mp3')
        draft_dir = self.generate(root)
        content = json.loads((draft_dir / 'draft_content.json').read_text(encoding='utf-8'))
        self.assertEqual(content['duration'], 6_000_000)
        self.assertEqual([track['name'] for track in content['tracks'] if track['type'] == 'audio'],
                         ['主音频轨道'])
        video = self.segments(content, 'video')
        self.assertEqual([item['target_timerange']['duration'] for item in video],
                         [2_000_000, 2_000_000, 2_000_000])
        evidence = json.loads((draft_dir / 'ending-evidence.json').read_text(encoding='utf-8'))
        self.assertTrue(evidence['already_included'])
        self.assertEqual(evidence['source_duration_us'], 2_000_000)

    def test_ai_notice_is_white_without_outline_and_covers_body_and_ending_on_both_canvases(self):
        for width, height in ((1440, 2560), (2560, 1440)):
            with self.subTest(canvas=(width, height)):
                timeline = {**TIMELINE, 'canvas': {'width': width, 'height': height}}
                content = self.generate_content(self.build_root(timeline=timeline))
                tracks = [track for track in content['tracks'] if track['type'] == 'text']
                notice = next(track for track in tracks if track['name'] == 'AI内容标识')
                self.assertEqual(len(notice['segments']), 1)
                segment = notice['segments'][0]
                material = next(item for item in content['materials']['texts']
                                if item['id'] == segment['material_id'])
                inner = json.loads(material['content'])
                self.assertEqual(inner['text'], '内容由AI生成')
                self.assertEqual(segment['target_timerange'], {'start': 0, 'duration': 6_000_000})
                self.assertEqual(inner['styles'][0]['fill']['content']['solid']['color'], [1.0, 1.0, 1.0])
                self.assertFalse(inner['styles'][0].get('strokes'))
                self.assertEqual(inner['styles'][0]['size'], self.module.WATERMARK_FONT_SIZE)
                position = segment['clip']['transform']
                x, y = self.module.watermark_position(width, height)
                self.assertEqual(position, {'x': x, 'y': y})
                self.assertGreater(x, 0)
                self.assertLess(y, 0)
                self.assertLess(x, 1)
                self.assertGreater(y, -1)
                self.assertEqual(len(tracks), 2)
                self.assertNotIn('内容纯属虚构', json.dumps(content, ensure_ascii=False))

    def test_bgm_and_ending_audio_overlap_without_being_counted_as_extra_picture_duration(self):
        root = self.build_root()
        (root / '04_bgm').mkdir()
        shutil.copy2(self.audio, root / '04_bgm/bgm.wav')
        (root / '06_ending').mkdir()
        assets = SCRIPT.parents[2] / 'tweet-drama-background-render/assets'
        for name in ('ending_audio.mp3', 'ending_effect.mp4'):
            shutil.copy2(assets / name, root / '06_ending' / name)
        content = self.generate_content(root)
        self.assertEqual(content['duration'], 6_000_000)
        for kind, name in (('audio', '片尾音'), ('video', '片尾特效')):
            track = next(item for item in content['tracks'] if item['type'] == kind and item['name'] == name)
            self.assertEqual(len(track['segments']), 1)
            span = track['segments'][0]['target_timerange']
            self.assertEqual(span['start'], 4_000_000)
            self.assertLessEqual(span['duration'], 2_000_000)
        self.assertEqual(len(self.segments(content, 'video')), 3)

    def test_damaged_video_or_failed_extraction_does_not_leave_a_deliverable_draft(self):
        root = self.build_root()
        (root / '02_media/25/p2.mp4').write_bytes(b'broken video')
        with self.assertRaisesRegex(self.module.DraftInputError, '最后一个正文镜头'):
            self.generate(root)
        self.assertFalse((root / 'jianying' / DRAFT_NAME).exists())

    def test_inconsistent_declared_body_end_is_refused_before_creating_a_draft(self):
        root = self.build_root(timeline={**TIMELINE, 'body_end': 3.0})
        with self.assertRaisesRegex(self.module.DraftInputError, 'body_end'):
            self.generate(root)
        self.assertFalse((root / 'jianying' / DRAFT_NAME).exists())

    def test_delivery_checks_notice_duration_and_freeze_count_separately_from_subtitles(self):
        content = self.generate_content(self.build_root())
        track = next(item for item in content['tracks'] if item['name'] == 'AI内容标识')
        track['segments'][0]['target_timerange']['duration'] = 4_000_000
        with self.assertRaisesRegex(self.module.DraftInputError, '覆盖正文和 2 秒片尾'):
            self.module.verify_draft_delivery(content, self.clips(), 4_000_000, [{}] * 3)
        video = next(item for item in content['tracks'] if item['name'] == '视频轨道')
        video['segments'].pop()
        with self.assertRaisesRegex(self.module.DraftInputError, '恰好一个可编辑末帧'):
            self.module.verify_draft_delivery(content, self.clips(), 4_000_000, [{}] * 3)

    def test_prepare_and_process_keep_requested_ending_assets_in_editable_tracks(self):
        root = self.build_root()
        spec = importlib.util.spec_from_file_location('draft_prepared_ending', SCRIPT.with_name('draft_generator.py'))
        generator_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator_module)
        generator = generator_module.DraftGenerator()
        assets = SCRIPT.parents[2] / 'tweet-drama-background-render/assets'
        materials = root / 'materials'
        generator.prepare_materials(str(root / '01_audio'), str(root / '02_media'), str(materials),
                                    subtitle_dir=str(root / '03_subtitle'), timeline_dir=str(root / '05_timeline'),
                                    project=str(root), ending_audio=str(assets / 'ending_audio.mp3'),
                                    ending_effect=str(assets / 'ending_effect.mp4'))
        (root / 'jianying').mkdir()
        with patch.dict(os.environ), patch.dict(sys.modules, {'jianying_draft': self.module}):
            result = generator.process(str(materials), str(root / 'jianying'), name_prefix='候选A-', project=str(root))
        self.assertTrue(result['success'])
        self.assertEqual(result['drafts_created'], 1)
        self.assertEqual(result['drafts'][0]['path'], str(root / 'jianying' / DRAFT_NAME))
        content = json.loads((root / 'jianying' / DRAFT_NAME / 'draft_content.json').read_text(encoding='utf-8'))
        self.assertEqual(result['drafts'][0]['id'], content.get('id', ''))
        self.assertEqual(content['duration'], 6_000_000)
        self.assertFalse([track for track in content['tracks'] if track['name'] == 'BGM轨道'])
        for name in ('片尾音', '片尾特效', 'AI内容标识'):
            self.assertEqual(len([track for track in content['tracks'] if track['name'] == name]), 1)

    def generation_result(self, root, seq=None):
        shutil.copytree(root, root / 'materials')
        (root / 'jianying').mkdir()
        return self.module.generate_draft(str(root / 'jianying'), str(root / 'materials'),
                                          name_prefix='候选A-', project=str(root), seq=seq)

    def body_only_root(self):
        return self.build_root(timeline={**TIMELINE, 'delivery': {
            'visual_medium': 'animation_3d', 'width': 1440, 'height': 2560, 'fps': 60}})

    def test_save_and_fallback_failure_reports_no_created_draft(self):
        root = self.body_only_root()
        with patch.object(self.module.draft.ScriptFile, 'save', side_effect=OSError('save denied')), \
                patch.object(self.module.draft.ScriptFile, 'dump', side_effect=OSError('dump denied')):
            result = self.generation_result(root)
        self.assertFalse(result['success'])
        self.assertEqual(result['drafts_created'], 0)
        self.assertEqual(len(result['drafts']), 1)
        self.assertFalse(result['drafts'][0]['success'])
        self.assertIn('save denied', result['drafts'][0]['error'])
        self.assertIn('dump denied', result['error'])
        self.assertFalse((root / 'jianying' / DRAFT_NAME).exists())

    def test_successful_fallback_requires_matching_saved_json(self):
        root = self.body_only_root()
        with patch.object(self.module.draft.ScriptFile, 'save', side_effect=OSError('save denied')):
            result = self.generation_result(root)
        self.assertTrue(result['success'])
        self.assertEqual(result['drafts_created'], 1)
        row = result['drafts'][0]
        content = json.loads((Path(row['path']) / 'draft_content.json').read_text(encoding='utf-8'))
        self.assertEqual(row['id'], content.get('id', ''))
        self.assertEqual(row['episode'], '25')
        self.assertEqual(row['error'], '')
        self.assertEqual(content['duration'], 4_000_000)

    def test_save_returning_without_writing_the_generated_content_is_failure(self):
        root = self.body_only_root()
        with patch.object(self.module.draft.ScriptFile, 'save', return_value=None):
            result = self.generation_result(root)
        self.assertFalse(result['success'])
        self.assertEqual(result['drafts_created'], 0)
        self.assertIn('回读草稿', result['error'])
        self.assertFalse((root / 'jianying' / DRAFT_NAME).exists())

    def test_saved_json_that_differs_from_verified_content_is_failure(self):
        root = self.body_only_root()
        original_save = self.module.draft.ScriptFile.save
        def changed_save(script):
            original_save(script)
            path = root / 'jianying' / DRAFT_NAME / 'draft_content.json'
            content = json.loads(path.read_text(encoding='utf-8'))
            content['duration'] += 1
            path.write_text(json.dumps(content), encoding='utf-8')
        with patch.object(self.module.draft.ScriptFile, 'save', changed_save):
            result = self.generation_result(root)
        self.assertFalse(result['success'])
        self.assertEqual(result['drafts_created'], 0)
        self.assertIn('不一致', result['error'])
        self.assertFalse((root / 'jianying' / DRAFT_NAME).exists())

    def test_second_save_failure_preserves_first_verified_draft_and_reports_both(self):
        root = self.body_only_root()
        shutil.copy2(root / '01_audio/25.wav', root / '01_audio/26.wav')
        shutil.copytree(root / '02_media/25', root / '02_media/26')
        shutil.copy2(root / '05_timeline/25.timeline.json', root / '05_timeline/26.timeline.json')
        shutil.copy2(root / '03_subtitle/25.srt', root / '03_subtitle/26.srt')
        original_save = self.module.draft.ScriptFile.save
        original_dump = self.module.draft.ScriptFile.dump
        saved = []
        def save(script):
            saved.append(script)
            if len(saved) == 2:
                raise OSError('second save failed')
            original_save(script)
        def dump(script, path):
            if len(saved) == 2:
                raise OSError('second dump failed')
            return original_dump(script, path)
        with patch.object(self.module.draft.ScriptFile, 'save', save), \
                patch.object(self.module.draft.ScriptFile, 'dump', dump):
            result = self.generation_result(root)
        self.assertFalse(result['success'])
        self.assertEqual(result['drafts_created'], 1)
        self.assertEqual([(row['episode'], row['success']) for row in result['drafts']],
                         [('25', True), ('26', False)])
        self.assertTrue((root / 'jianying' / DRAFT_NAME / 'draft_content.json').is_file())
        self.assertFalse((root / 'jianying' / '候选A-26').exists())
        self.assertIn('second dump failed', result['drafts'][1]['error'])

    def test_unmatched_episode_does_not_report_a_successful_empty_batch(self):
        root = self.body_only_root()
        result = self.generation_result(root, seq='99')
        self.assertFalse(result['success'])
        self.assertEqual(result['drafts_created'], 0)
        self.assertEqual(result['drafts'], [])
        self.assertIn('没有匹配', result['error'])

    def test_creation_failure_is_reported_without_retrying_the_same_candidate(self):
        root = self.body_only_root()
        with patch.object(self.module.draft.DraftFolder, 'create_draft',
                          side_effect=OSError('create denied')) as create:
            result = self.generation_result(root)
        create.assert_called_once()
        self.assertFalse(result['success'])
        self.assertEqual(result['drafts_created'], 0)
        self.assertIn('create denied', result['drafts'][0]['error'])
        self.assertFalse((root / 'jianying' / DRAFT_NAME).exists())

    def test_missing_selected_media_is_not_a_successful_skipped_episode(self):
        root = self.body_only_root()
        shutil.copy2(root / '01_audio/25.wav', root / '01_audio/26.wav')
        result = self.generation_result(root, seq='26')
        self.assertFalse(result['success'])
        self.assertEqual(result['drafts_created'], 0)
        self.assertEqual(result['drafts'][0]['episode'], '26')
        self.assertIn('无法找到', result['error'])

    def test_missing_selected_ending_does_not_destroy_prepared_materials(self):
        root = self.build_root()
        spec = importlib.util.spec_from_file_location('draft_missing_ending', SCRIPT.with_name('draft_generator.py'))
        generator_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator_module)
        materials = root / 'materials'
        materials.mkdir()
        sentinel = materials / 'keep.txt'
        sentinel.write_text('keep prepared files', encoding='utf-8')
        with self.assertRaisesRegex(FileNotFoundError, 'Missing selected ending asset'):
            generator_module.DraftGenerator().prepare_materials(str(root / '01_audio'), str(root / '02_media'),
                str(materials), project=str(root), ending_effect=str(root / 'missing.mp4'))
        self.assertEqual(sentinel.read_text(encoding='utf-8'), 'keep prepared files')

    def test_ending_audio_is_not_selected_as_bgm_when_no_bgm_folder_exists(self):
        root = self.build_root()
        (root / '06_ending').mkdir()
        assets = SCRIPT.parents[2] / 'tweet-drama-background-render/assets'
        shutil.copy2(assets / 'ending_audio.mp3', root / '06_ending/ending_audio.mp3')
        content = self.generate_content(root)
        self.assertFalse([track for track in content['tracks'] if track['name'] == 'BGM轨道'])
        audio_tracks = [track for track in content['tracks'] if track['type'] == 'audio']
        self.assertEqual([track['name'] for track in audio_tracks], ['主音频轨道', '片尾音'])
        ending = audio_tracks[1]['segments']
        self.assertEqual(len(ending), 1)
        self.assertEqual(ending[0]['target_timerange']['start'], 4_000_000)
        self.assertEqual(ending[0]['target_timerange']['duration'], 2_000_000)
        self.assertIsNone(self.module.find_material_folder_smart(root, 'bgm', [root / '01_audio']))
        self.assertNotIn(root / '06_ending', self.module.find_all_folders_by_type(root, 'bgm'))

    def test_decode_timeout_terminates_the_child_cleans_only_new_draft_and_preserves_old_draft(self):
        root = self.build_root()
        shutil.copytree(root, root / 'materials')
        editor = root / 'jianying'
        old = editor / 'old-candidate'
        old.mkdir(parents=True)
        sentinel = old / 'draft_content.json'
        sentinel.write_bytes(b'keep existing draft')
        blocked = root / 'blocked-decoder.py'
        pid_file = root / 'decoder.pid'
        blocked.write_text('import os, sys, time\nfrom pathlib import Path\n'
                           'Path(sys.argv[1]).write_text(str(os.getpid()))\n'
                           'while True: time.sleep(1)\n', encoding='utf-8')
        original_run = subprocess.run
        def run_decoder(command, **kwargs):
            if command[0] == str(blocked):
                self.assertEqual(kwargs['timeout'], 2.0)
                return original_run([sys.executable, str(blocked), str(pid_file)], **kwargs)
            return original_run(command, **kwargs)
        args = argparse.Namespace(drafts=str(editor), materials=str(root / 'materials'),
                                  template_dir=None, seq=None, name_prefix='候选A-', project=str(root))
        with patch.dict(os.environ, {'DSH_FFMPEG_PATH': str(blocked),
                                     'MUSE_DRAFT_DECODE_TIMEOUT_SECONDS': '2'}), \
             patch.object(self.module.subprocess, 'run', side_effect=run_decoder):
            with self.assertRaisesRegex(self.module.DraftInputError, '定格解码超过 2 秒'):
                self.module.main_with_args(args)
        self.assertFalse((editor / DRAFT_NAME).exists())
        self.assertEqual(sentinel.read_bytes(), b'keep existing draft')
        self.assertTrue(pid_file.exists(), 'decoder must have started before its deadline expired')
        if os.name != 'nt':
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pid_file.read_text()), 0)

    def test_invalid_decode_timeout_fails_before_creating_a_draft(self):
        for value in ('0', '-1', 'NaN', 'inf', 'invalid'):
            with self.subTest(value=value):
                root = self.build_root()
                with patch.dict(os.environ, {'MUSE_DRAFT_DECODE_TIMEOUT_SECONDS': value}):
                    with self.assertRaisesRegex(self.module.DraftInputError, 'MUSE_DRAFT_DECODE_TIMEOUT_SECONDS'):
                        self.generate(root)
                self.assertFalse((root / 'jianying' / DRAFT_NAME).exists())

    def test_creation_log_reports_the_selected_landscape_canvas(self):
        root = self.build_root(timeline={**TIMELINE, 'canvas': {'width': 2560, 'height': 1440}})
        with self.assertLogs(self.module.logger, level='INFO') as captured:
            self.generate(root)
        created = [line for line in captured.output if 'Successfully created new draft' in line]
        self.assertEqual(len(created), 1)
        self.assertIn('with 2560x1440 at 60fps', created[0])

    def test_decoder_start_failure_cleans_new_draft_and_preserves_existing_draft(self):
        for kind in ('missing', 'not-executable'):
            with self.subTest(decoder=kind):
                root = self.build_root()
                shutil.copytree(root, root / 'materials')
                editor = root / 'jianying'
                old = editor / 'old-candidate'
                old.mkdir(parents=True)
                sentinel = old / 'draft_content.json'
                sentinel.write_bytes(b'keep old draft on decoder startup error')
                decoder = root / kind
                if kind == 'not-executable':
                    decoder.mkdir()
                args = argparse.Namespace(drafts=str(editor), materials=str(root / 'materials'),
                                          template_dir=None, seq=None, name_prefix='候选A-', project=str(root))
                with patch.dict(os.environ, {'DSH_FFMPEG_PATH': str(decoder)}):
                    with self.assertRaisesRegex(self.module.DraftInputError, '定格或AI标识创建失败') as raised:
                        self.module.main_with_args(args)
                self.assertIn(str(decoder), str(raised.exception))
                self.assertIsInstance(raised.exception.__context__, OSError)
                self.assertFalse((editor / DRAFT_NAME).exists())
                self.assertEqual(sentinel.read_bytes(), b'keep old draft on decoder startup error')

    def test_windows_decoder_start_errors_without_filename_report_selected_executable(self):
        decoder = str(Path('configured decoder') / '中文 ffmpeg.exe')
        for winerror in (2, 5):
            with self.subTest(winerror=winerror):
                error = windows_start_error(winerror)
                self.assertIsNone(error.filename)
                original_errno, original_args, original_strerror = error.errno, error.args, error.strerror
                with patch.dict(os.environ, {'DSH_FFMPEG_PATH': decoder}), \
                     patch.object(self.module.subprocess, 'run', side_effect=error) as run:
                    with self.assertRaises(OSError) as raised:
                        self.module._ffmpeg_output(['-f', 'null', '-'])
                self.assertIs(raised.exception, error)
                self.assertIsNone(error.filename)
                self.assertIn(decoder, str(error))
                self.assertEqual(error.strerror, f'{original_strerror}（解码器：{decoder}）')
                self.assertEqual(error.errno, original_errno)
                self.assertEqual(error.winerror, winerror)
                self.assertEqual(error.args, original_args)
                self.assertEqual(run.call_args.args[0], [decoder, '-v', 'error', '-f', 'null', '-'])

    def test_other_decoder_start_oserrors_keep_original_filename_and_text(self):
        errors = [FileNotFoundError(errno.ENOENT, 'file missing'),
                  FileNotFoundError(errno.ENOENT, 'file missing', '/usr/bin/missing decoder'),
                  PermissionError(errno.EACCES, 'permission denied'),
                  PermissionError(errno.EACCES, 'permission denied', '/usr/bin/blocked decoder'),
                  OSError(5, 'input/output error'), OSError(5, 'input/output error', '/usr/bin/ffmpeg'),
                  windows_start_error(193), windows_start_error(2, 'original filename'),
                  windows_start_error(5, 'original filename')]
        for error in errors:
            with self.subTest(error=str(error)):
                original_filename, original_text = error.filename, str(error)
                with patch.dict(os.environ, {'DSH_FFMPEG_PATH': 'configured decoder'}), \
                     patch.object(self.module.subprocess, 'run', side_effect=error):
                    with self.assertRaises(OSError) as raised:
                        self.module._ffmpeg_output(['-f', 'null', '-'])
                self.assertIs(raised.exception, error)
                self.assertEqual(error.filename, original_filename)
                self.assertEqual(str(error), original_text)

    def test_decoder_non_oserror_is_not_reclassified(self):
        error = RuntimeError('original subprocess failure')
        with patch.object(self.module.subprocess, 'run', side_effect=error):
            with self.assertRaises(RuntimeError) as raised:
                self.module._ffmpeg_output(['-f', 'null', '-'])
        self.assertIs(raised.exception, error)

    def test_decoder_timeout_and_nonzero_exit_keep_existing_diagnostics(self):
        error = subprocess.TimeoutExpired(['decoder'], 3)
        with patch.dict(os.environ, {'MUSE_DRAFT_DECODE_TIMEOUT_SECONDS': '3'}), \
             patch.object(self.module.subprocess, 'run', side_effect=error):
            with self.assertRaisesRegex(self.module.DraftInputError, '定格解码超过 3 秒') as raised:
                self.module._ffmpeg_output(['-f', 'null', '-'])
        self.assertIs(raised.exception.__cause__, error)
        result = subprocess.CompletedProcess(['decoder'], 1, stdout='', stderr='original decoder stderr')
        with patch.object(self.module.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(self.module.DraftInputError, '定格提取失败：original decoder stderr'):
                self.module._ffmpeg_output(['-f', 'null', '-'])


if __name__ == '__main__':
    unittest.main()
