"""The draft build's timeline contract, audio gain, subtitle text rules and delivery gate.

The generation tests run the real generator against real (tiny) media through the installed
`pyJianYingDraft` and ffmpeg; they skip when either is unavailable. Every fixture stays in a
temporary directory.
"""
import argparse
import errno
import hashlib
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
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


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
        cls.video_with_audio = source / 'source-with-audio.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(source / 'p1.mp4'),
                        '-i', str(cls.audio), '-map', '0:v:0', '-map', '1:a:0',
                        '-c:v', 'copy', '-c:a', 'aac', '-t', '2', str(cls.video_with_audio)],
                       check=True, timeout=30, creationflags=NO_WINDOW)
        probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0',
                                '-show_entries', 'stream=codec_name', '-of', 'json',
                                str(cls.video_with_audio)], check=True, capture_output=True,
                               text=True, timeout=30, creationflags=NO_WINDOW)
        if json.loads(probe.stdout)['streams'] != [{'codec_name': 'aac'}]:
            raise AssertionError('The duplicate-dialogue fixture must contain a real AAC stream')
        cls.short_video = source / 'non-integral-frame-with-audio.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                        'testsrc=size=160x120:rate=24:duration=2.041667', '-i', str(cls.audio),
                        '-map', '0:v:0', '-map', '1:a:0', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
                        '-t', '2.048', str(cls.short_video)], check=True, timeout=30, creationflags=NO_WINDOW)

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
        note = root / '03_subtitle/25.srt.review.txt'
        note.write_text('Alignment needs review', encoding='utf-8')
        with patch.object(sys, 'path', [str(SCRIPT.parent), *sys.path]):
            result = request_module.generate_request(request, str(drafts))
        self.assertTrue(result['success'], result)
        self.assertEqual(result['drafts_created'], 1)
        self.assertTrue(result['warnings'])
        self.assertEqual(result['quality'], 'needs_review')
        self.assertTrue(Path(result['drafts'][0]['review_path']).is_file())
        self.assertEqual((Path(result['materials_dir']) / '03_subtitle/25.srt.review.txt').read_text(), 'Alignment needs review')
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

    def test_project_audio_gains_reach_independent_sdk_tracks_without_duplicate_source_audio(self):
        root = self.build_root(timeline=self.delivery_timeline('animation_3d'))
        (root / 'project_config.json').write_text(json.dumps({'project_bible': {
            'visual_medium': 'animation_3d', 'delivery': {
                'audio': {'master_gain': 1, 'bgm_gain': 0.24}}}}), encoding='utf-8')
        (root / '04_bgm').mkdir()
        shutil.copy2(self.audio, root / '04_bgm/bed.wav')
        shutil.copy2(self.video_with_audio, root / '02_media/25/p1.mp4')
        content = self.generate_content(root)
        tracks = {track['name']: track for track in content['tracks']}
        self.assertEqual(tracks['主音频轨道']['segments'][0]['volume'], 1)
        self.assertEqual(tracks['BGM轨道']['segments'][0]['volume'], 0.24)
        self.assertTrue(all(segment['volume'] == 0 for segment in self.segments(content, 'video')))
        self.assertEqual(content['duration'], 4_000_000)

    def test_audio_snapshot_preserves_zero_and_does_not_merge_later_project_gains(self):
        timeline = self.delivery_timeline('animation_3d')
        timeline['delivery']['audio'] = {'master_gain': 0}
        root = self.build_root(timeline=timeline)
        (root / 'project_config.json').write_text(json.dumps({'project_bible': {'delivery': {
            'audio': {'master_gain': 2, 'bgm_gain': 0.24}}}}), encoding='utf-8')
        (root / '04_bgm').mkdir()
        shutil.copy2(self.audio, root / '04_bgm/bed.wav')
        content = self.generate_content(root)
        tracks = {track['name']: track for track in content['tracks']}
        self.assertEqual(tracks['主音频轨道']['segments'][0]['volume'], 0)
        self.assertEqual(tracks['BGM轨道']['segments'][0]['volume'], 1)

    def test_invalid_project_audio_is_rejected_before_creating_a_draft(self):
        root = self.build_root(timeline=self.delivery_timeline('animation_3d'))
        (root / 'project_config.json').write_text(json.dumps({'project_bible': {'delivery': {
            'audio': {'bgm_gain': None}}}}), encoding='utf-8')
        with patch.object(self.module.draft.DraftFolder, 'create_draft',
                          side_effect=AssertionError('invalid input must not create a draft')):
            with self.assertRaisesRegex(self.module.DraftInputError, 'bgm_gain'):
                self.generate(root)
        self.assertFalse((root / 'jianying' / DRAFT_NAME).exists())

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

    def test_embedded_dialogue_is_muted_only_after_the_independent_main_track_is_added(self):
        root = self.body_only_root()
        for shot in (1, 2):
            shutil.copy2(self.video_with_audio, root / f'02_media/25/p{shot}.mp4')
        content = self.generate_content(root)
        self.assertEqual([segment['volume'] for segment in self.segments(content, 'video')], [0, 0])
        self.assertEqual([segment['volume'] for segment in self.segments(content, 'audio')], [1.0])

    def test_delivery_checks_report_each_unmuted_or_unverified_body_source_volume(self):
        root = self.body_only_root()
        for shot in (1, 2):
            shutil.copy2(self.video_with_audio, root / f'02_media/25/p{shot}.mp4')
        content = self.generate_content(root)
        plan = self.module.draft_ending_plan(root / '05_timeline/25.timeline.json', self.clips())
        cues = self.module.normalize_srt(root / '03_subtitle/25.srt')
        self.module.verify_draft_delivery(content, self.clips(), 4_000_000, cues, plan)
        for index in range(2):
            for volume in (1, 0.5, None):
                with self.subTest(shot=index + 1, volume=volume):
                    bad = json.loads(json.dumps(content))
                    segment = self.segments(bad, 'video')[index]
                    if volume is None:
                        segment.pop('volume')
                    else:
                        segment['volume'] = volume
                    with self.assertRaises(self.module.DraftInputError) as captured:
                        self.module.verify_draft_delivery(bad, self.clips(), 4_000_000, cues, plan)
                    self.assertIn('源视频音量', str(captured.exception))
                    self.assertRegex(str(captured.exception), rf'镜头\s*{index + 1}')
        photo_only = json.loads(json.dumps(content))
        for material in photo_only['materials']['videos']:
            material['type'] = 'photo'
        for segment in self.segments(photo_only, 'video'):
            segment['volume'] = 1
        self.module.verify_draft_delivery(photo_only, self.clips(), 4_000_000, cues, plan)

    def test_delivery_checks_do_not_report_source_volume_without_independent_main_audio(self):
        root = self.body_only_root()
        for shot in (1, 2):
            shutil.copy2(self.video_with_audio, root / f'02_media/25/p{shot}.mp4')
        content = self.generate_content(root)
        plan = self.module.draft_ending_plan(root / '05_timeline/25.timeline.json', self.clips())
        cues = self.module.normalize_srt(root / '03_subtitle/25.srt')
        for audio_duration in (None, 4_000_000):
            for volume in (1, 0.5, None):
                with self.subTest(audio_duration=audio_duration, volume=volume):
                    bad = json.loads(json.dumps(content))
                    bad['tracks'] = [track for track in bad['tracks'] if track.get('name') != '主音频轨道']
                    for segment in self.segments(bad, 'video'):
                        if volume is None:
                            segment.pop('volume')
                        else:
                            segment['volume'] = volume
                    with self.assertRaisesRegex(self.module.DraftInputError, '主音频轨没有任何片段') as captured:
                        self.module.verify_draft_delivery(bad, self.clips(), audio_duration, cues, plan)
                    self.assertNotIn('源视频音量', str(captured.exception))

    def test_unmuted_body_sources_keep_the_saved_draft_with_review_warnings(self):
        root = self.body_only_root()
        for shot in (1, 2):
            shutil.copy2(self.video_with_audio, root / f'02_media/25/p{shot}.mp4')
        original_add = self.module.draft.ScriptFile.add_segment

        def unmute_body_source(script, segment, track=None):
            if isinstance(segment, self.module.draft.VideoSegment):
                segment.volume = 1
            return original_add(script, segment, track)

        with patch.object(self.module.draft.ScriptFile, 'add_segment', unmute_body_source):
            result = self.generation_result(root)
        self.assertTrue(result['success'], result)
        self.assertEqual(result['drafts_created'], 1)
        draft_path = Path(result['drafts'][0]['path'])
        self.assertTrue(draft_path.is_dir())
        content = json.loads((draft_path / 'draft_content.json').read_text(encoding='utf-8'))
        self.assertEqual([segment['volume'] for segment in self.segments(content, 'video')], [1, 1])
        main = next(track for track in content['tracks'] if track.get('name') == '主音频轨道')['segments']
        self.assertEqual(len(main), 1)
        self.assertEqual(main[0]['volume'], 1.0)
        self.assertEqual(main[0]['target_timerange'], {'start': 0, 'duration': 4_000_000})
        review = json.loads((draft_path / 'muse-review.json').read_text(encoding='utf-8'))
        for warnings in (review['warnings'], result['warnings']):
            for shot in (1, 2):
                with self.subTest(shot=shot, warnings=warnings):
                    self.assertTrue(any(f'镜头 {shot}' in warning and '源视频音量' in warning for warning in warnings), warnings)
            self.assertFalse(any('拒绝交付' in warning for warning in warnings), warnings)

    def test_direct_request_keeps_six_aac_sources_muted_with_one_independent_dialogue_track(self):
        root = Path(tempfile.mkdtemp(prefix='draft-single-dialogue-'))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        inputs = root / 'inputs'
        inputs.mkdir()
        audio = inputs / '01.wav'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-stream_loop', '2', '-i', str(self.audio),
                        '-map', '0:a:0', '-t', '12', '-c:a', 'pcm_s16le', str(audio)],
                       check=True, timeout=30, creationflags=NO_WINDOW)
        videos = []
        for shot in range(1, 7):
            path = inputs / f'shot_{shot:03d}.mp4'
            shutil.copy2(self.video_with_audio, path)
            probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0',
                                    '-show_entries', 'stream=codec_name', '-of', 'json', str(path)],
                                   check=True, capture_output=True, text=True, timeout=30, creationflags=NO_WINDOW)
            self.assertEqual(json.loads(probe.stdout)['streams'], [{'codec_name': 'aac'}])
            videos.append(path)
        timeline = {'clips': [{'shot': shot, 'start_us': (shot - 1) * 2_000_000, 'duration_us': 2_000_000}
                              for shot in range(1, 7)], 'body_end': 12,
                    'delivery': {'visual_medium': 'animation_3d', 'width': 480, 'height': 854, 'fps': 24}}
        timeline_path = inputs / '01.timeline.json'
        timeline_path.write_text(json.dumps(timeline), encoding='utf-8')
        srt = inputs / '01.srt'
        srt.write_text('1\n00:00:00,000 --> 00:00:12,000\n合成对白。\n', encoding='utf-8')
        sources = [audio, timeline_path, srt, *videos]
        source_hashes = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}
        drafts = root / 'editor'
        drafts.mkdir()
        request = {'project': str(root), 'episode': 1, 'name_prefix': '单路对白-', 'audio': str(audio),
                   'videos': [str(path) for path in videos], 'subtitle_srt': str(srt), 'timeline': str(timeline_path)}
        with patch.object(sys, 'path', [str(SCRIPT.parent), *sys.path]), patch.dict(os.environ), \
                patch.dict(sys.modules, {'jianying_draft': self.module}):
            spec = importlib.util.spec_from_file_location('draft_single_dialogue_request', SCRIPT.with_name('generate_draft_request.py'))
            request_module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(request_module)
            result = request_module.generate_request(request, str(drafts))
        self.assertTrue(result['success'], result)
        self.assertEqual(result['drafts_created'], 1)
        self.assertEqual(result['library']['name'], 'pyJianYingDraft')
        self.assertFalse(result['editor_open_verified'])
        draft_path = Path(result['drafts'][0]['path'])
        self.assertEqual(draft_path, drafts / '单路对白-01')
        content = json.loads((draft_path / 'draft_content.json').read_text(encoding='utf-8'))
        self.assertEqual(content['duration'], 12_000_000)
        video = self.segments(content, 'video')
        main = next(track for track in content['tracks'] if track.get('name') == '主音频轨道')['segments']
        self.assertEqual(len(video), 6)
        self.assertEqual([segment['volume'] for segment in video], [0] * 6)
        self.assertTrue(all(segment['speed'] == 1.0 for segment in video))
        self.assertEqual([segment['target_timerange'] for segment in video],
                         [{'start': (shot - 1) * 2_000_000, 'duration': 2_000_000} for shot in range(1, 7)])
        self.assertEqual(len(self.segments(content, 'audio')), 1)
        self.assertEqual(len(main), 1)
        self.assertEqual(main[0]['volume'], 1.0)
        self.assertEqual(main[0]['target_timerange'], {'start': 0, 'duration': 12_000_000})
        retained = Path(result['materials_dir'])
        video_materials = {material['id']: material for material in content['materials']['videos']}
        for shot, segment in enumerate(video, 1):
            path = Path(video_materials[segment['material_id']]['path'])
            self.assertTrue(path.is_absolute() and path.is_file())
            self.assertTrue(path.is_relative_to(retained))
            self.assertEqual(path.name, f'shot_{shot:03d}.mp4')
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), source_hashes[videos[shot - 1]])
        audio_materials = {material['id']: material for material in content['materials']['audios']}
        retained_audio = Path(audio_materials[main[0]['material_id']]['path'])
        self.assertTrue(retained_audio.is_absolute() and retained_audio.is_file())
        self.assertTrue(retained_audio.is_relative_to(retained))
        self.assertEqual(hashlib.sha256(retained_audio.read_bytes()).hexdigest(), source_hashes[audio])
        self.assertEqual({path: hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}, source_hashes)
        self.assertFalse(any('源视频音量' in warning for warning in result['warnings']))

    def test_failed_main_audio_import_keeps_embedded_video_audio_and_the_reviewable_draft(self):
        original_add = self.module.draft.ScriptFile.add_segment
        def fail_main_audio(script, segment, track=None):
            if isinstance(segment, self.module.draft.AudioSegment):
                raise RuntimeError('main audio could not be added')
            return original_add(script, segment, track)
        for failure in ('material', 'segment'):
            with self.subTest(failure=failure):
                root = self.body_only_root()
                for shot in (1, 2):
                    shutil.copy2(self.video_with_audio, root / f'02_media/25/p{shot}.mp4')
                mocked = (patch.object(self.module.draft, 'AudioMaterial', side_effect=RuntimeError('main audio unreadable'))
                          if failure == 'material' else patch.object(self.module.draft.ScriptFile, 'add_segment', fail_main_audio))
                with mocked:
                    content = self.generate_content(root)
                self.assertEqual([segment['volume'] for segment in self.segments(content, 'video')], [1.0, 1.0])
                self.assertFalse(self.segments(content, 'audio'))
                review = json.loads((root / 'jianying' / DRAFT_NAME / 'muse-review.json').read_text(encoding='utf-8'))
                self.assertTrue(any('主音频轨没有任何片段' in warning for warning in review['warnings']))

    def body_gap_root(self, clip_duration_us=2_048_000, medium='animation_3d'):
        timeline = {'clips': [{'shot': shot, 'start_us': (shot - 1) * clip_duration_us,
                               'duration_us': clip_duration_us} for shot in (1, 2)],
                    'body_end': 2 * clip_duration_us / 1e6,
                    'delivery': {'visual_medium': medium, 'width': 480, 'height': 854, 'fps': 24}}
        root = self.build_root(timeline=timeline, srt='1\n00:00:00,000 --> 00:00:01,000\n原声时钟\n')
        for shot in (1, 2):
            shutil.copy2(self.short_video, root / f'02_media/25/p{shot}.mp4')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                        f'sine=frequency=440:duration={2 * clip_duration_us / 1e6:.6f}', '-ar', '48000',
                        str(root / '01_audio/25.wav')], check=True, timeout=30, creationflags=NO_WINDOW)
        return root, timeline

    def test_small_sdk_video_tails_use_verified_frames_without_moving_body_audio_or_subtitles(self):
        for medium in ('animation_3d', 'photorealistic'):
            with self.subTest(medium=medium):
                root, timeline = self.body_gap_root(medium=medium)
                draft_dir = self.generate(root)
                content = json.loads((draft_dir / 'draft_content.json').read_text(encoding='utf-8'))
                evidence = json.loads((draft_dir / 'body-tail-evidence.json').read_text(encoding='utf-8'))['holds']
                self.assertEqual(len(evidence), 2)
                video = self.segments(content, 'video')
                self.assertEqual([segment['target_timerange'] for segment in video[:4]], [
                    {'start': 0, 'duration': 2_042_000}, {'start': 2_042_000, 'duration': 6_000},
                    {'start': 2_048_000, 'duration': 2_042_000}, {'start': 4_090_000, 'duration': 6_000}])
                self.assertTrue(all(segment['speed'] == 1.0 and segment['volume'] == 0 for segment in video[:4]))
                self.assertEqual(self.segments(content, 'audio')[0]['target_timerange'], {'start': 0, 'duration': 4_096_000})
                self.assertEqual(self.segments(content, 'text')[0]['target_timerange'], {'start': 0, 'duration': 1_000_000})
                self.assertEqual(json.loads((root / '05_timeline/25.timeline.json').read_text(encoding='utf-8')), timeline)
                for hold in evidence:
                    source, image = Path(hold['source']), Path(hold['image'])
                    self.assertEqual(hold['source_sha256'], hashlib.sha256(source.read_bytes()).hexdigest())
                    self.assertEqual(hold['image_sha256'], hashlib.sha256(image.read_bytes()).hexdigest())
                    expected = self.module.decoded_frame_hashes(source, hold['selected_duration_us'])[-1]
                    self.assertEqual(self.module.decoded_frame_hashes(image), [expected])
                    self.assertEqual(hold['frame_rgb_md5'], expected)
                if medium == 'animation_3d':
                    self.assertEqual(content['duration'], 4_096_000)
                    self.assertFalse((draft_dir / 'ending-evidence.json').exists())
                    self.assertFalse({'片尾音', '片尾特效', 'AI内容标识'} & {track['name'] for track in content['tracks']})
                else:
                    self.assertEqual(video[-1]['target_timerange'], {'start': 4_096_000, 'duration': 2_000_000})
                    self.assertEqual(content['duration'], 6_096_000)
                review = json.loads((draft_dir / 'muse-review.json').read_text(encoding='utf-8'))
                self.assertFalse(any('视频段数' in warning or '时间范围' in warning for warning in review['warnings']))

    def test_large_sdk_video_tails_remain_reviewable_without_automatic_holds(self):
        root, _timeline = self.body_gap_root(clip_duration_us=2_300_000)
        with self.assertLogs(self.module.logger, level='WARNING') as captured:
            draft_dir = self.generate(root)
        content = json.loads((draft_dir / 'draft_content.json').read_text(encoding='utf-8'))
        self.assertEqual(len(self.segments(content, 'video')), 2)
        self.assertFalse((draft_dir / 'body-tail-evidence.json').exists())
        self.assertIn('超过容差；不自动补帧', '\n'.join(captured.output))
        self.assertTrue((draft_dir / 'muse-review.json').exists())

    def test_body_tail_tolerance_includes_200ms_but_does_not_extend_beyond_it(self):
        for extra_us in (0, 1):
            with self.subTest(extra_us=extra_us):
                root, _timeline = self.body_gap_root(clip_duration_us=2_242_000 + extra_us)
                draft_dir = self.generate(root)
                evidence_path = draft_dir / 'body-tail-evidence.json'
                self.assertEqual(evidence_path.is_file(), extra_us == 0)
                if evidence_path.is_file():
                    holds = json.loads(evidence_path.read_text(encoding='utf-8'))['holds']
                    self.assertEqual([hold['duration_us'] for hold in holds], [200_000, 200_000])

    def test_unverified_body_tail_keeps_existing_segments_and_returns_a_review_warning(self):
        root, _timeline = self.body_gap_root()
        with patch.object(self.module, 'extract_draft_tail', side_effect=self.module.DraftInputError('frame mismatch')):
            draft_dir = self.generate(root)
        content = json.loads((draft_dir / 'draft_content.json').read_text(encoding='utf-8'))
        video = self.segments(content, 'video')
        self.assertEqual([segment['target_timerange'] for segment in video], [
            {'start': 0, 'duration': 2_042_000}, {'start': 2_048_000, 'duration': 2_042_000}])
        self.assertFalse((draft_dir / 'body-tail-evidence.json').exists())
        review = json.loads((draft_dir / 'muse-review.json').read_text(encoding='utf-8'))
        self.assertEqual(len([warning for warning in review['warnings'] if 'frame mismatch' in warning]), 2)

    def test_body_tail_records_do_not_excuse_missing_or_changed_source_segments(self):
        root, timeline = self.body_gap_root()
        draft_dir = self.generate(root)
        content = json.loads((draft_dir / 'draft_content.json').read_text(encoding='utf-8'))
        holds = json.loads((draft_dir / 'body-tail-evidence.json').read_text(encoding='utf-8'))['holds']
        plan = self.module.draft_ending_plan(root / '05_timeline/25.timeline.json', self.clips(timeline))
        cues = self.module.parse_srt_cues(root / '03_subtitle/25.srt')
        self.module.verify_draft_delivery(content, self.clips(timeline), 4_096_000, cues, plan, body_tail_holds=holds)
        for tamper in ('missing_source', 'missing_hold', 'changed_hold', 'undeclared_hold'):
            with self.subTest(tamper=tamper):
                bad = json.loads(json.dumps(content))
                track = next(track for track in bad['tracks'] if track['name'] == '视频轨道')
                records = holds
                if tamper == 'missing_source':
                    track['segments'].pop(0)
                elif tamper == 'missing_hold':
                    track['segments'].pop(1)
                elif tamper == 'changed_hold':
                    track['segments'][1]['target_timerange']['duration'] += 1
                else:
                    records = []
                with self.assertRaisesRegex(self.module.DraftInputError, '视频段数|正文末帧补齐'):
                    self.module.verify_draft_delivery(bad, self.clips(timeline), 4_096_000, cues, plan,
                                                       body_tail_holds=records)

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
        self.assertTrue(json.loads((draft / 'muse-review.json').read_text(encoding='utf-8'))['warnings'])

    def test_alignment_warning_preserves_a_reviewable_subtitled_draft(self):
        root = self.build_root()
        (root / '03_subtitle/25.srt.blocked').write_text('alignment pending', encoding='utf-8')
        with self.assertLogs(self.module.logger, level='WARNING') as notes:
            self.generate(root)
        self.assertIn('字幕对齐待核', '\n'.join(notes.output))
        draft = root / 'jianying' / DRAFT_NAME
        self.assertTrue((draft / 'draft_content.json').is_file())
        self.assertTrue(json.loads((draft / 'muse-review.json').read_text(encoding='utf-8'))['warnings'])

    def test_alignment_warning_without_srt_preserves_other_tracks(self):
        root = self.build_root(srt=None)
        (root / '03_subtitle').mkdir()
        (root / '03_subtitle/25.srt.blocked').write_text('alignment pending', encoding='utf-8')
        with self.assertLogs(self.module.logger, level='WARNING') as notes:
            self.generate(root)
        self.assertIn('字幕对齐待核', '\n'.join(notes.output))
        draft = root / 'jianying' / DRAFT_NAME
        self.assertTrue((draft / 'draft_content.json').is_file())
        self.assertTrue(json.loads((draft / 'muse-review.json').read_text(encoding='utf-8'))['warnings'])

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
        self.assertTrue(json.loads((draft / 'muse-review.json').read_text(encoding='utf-8'))['warnings'])

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
        self.assertTrue(json.loads((draft / 'muse-review.json').read_text(encoding='utf-8'))['warnings'])

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

    def test_32ms_container_tail_uses_clip_clock_and_retains_the_source_timeline(self):
        root = self.build_root(timeline=self.delivery_timeline('animation_3d', body_end=4.032))
        timeline_path = root / '05_timeline/25.timeline.json'
        original = timeline_path.read_bytes()
        content = self.generate_content(root)
        self.assertEqual(content['duration'], 4_000_000)
        self.assertEqual([segment['target_timerange'] for segment in self.segments(content, 'video')],
                         [{'start': 0, 'duration': 2_000_000},
                          {'start': 2_000_000, 'duration': 2_000_000}])
        review = json.loads((root / 'jianying' / DRAFT_NAME / 'muse-review.json').read_text(encoding='utf-8'))
        self.assertTrue(any('容器尾差' in warning for warning in review['warnings']))
        self.assertEqual(timeline_path.read_bytes(), original)

    def test_bgm_role_controls_the_independent_track_without_classifying_the_filename(self):
        for role, include in ((None, True), ('music_only', True), ('dialogue_music_mix', False)):
            with self.subTest(role=role):
                root = self.body_only_root()
                (root / '04_bgm').mkdir()
                shutil.copy2(self.audio, root / '04_bgm/review-mix.wav')
                shutil.copytree(root, root / 'materials')
                (root / 'jianying').mkdir()
                result = self.module.generate_draft(str(root / 'jianying'), str(root / 'materials'),
                    name_prefix='候选A-', project=str(root), bgm_role=role)
                self.assertTrue(result['success'], result)
                content = json.loads((root / 'jianying' / DRAFT_NAME / 'draft_content.json').read_text(encoding='utf-8'))
                self.assertEqual(len([track for track in content['tracks'] if track['name'] == 'BGM轨道']), int(include))
                self.assertEqual(len([track for track in content['tracks'] if track['name'] == '主音频轨道']), 1)
                if role == 'dialogue_music_mix':
                    self.assertTrue(any('不导入独立 BGM 轨' in warning for warning in result['warnings']))
                elif role is None:
                    self.assertTrue(any('未分析或确认其不含对白' in warning for warning in result['warnings']))
                else:
                    self.assertFalse(any('未声明为 music_only' in warning for warning in result['warnings']))

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
        bgm = root / 'approved-bgm'
        bgm.mkdir()
        shutil.copy2(self.audio, bgm / 'reviewed-mix.wav')
        generator.prepare_materials(str(root / '01_audio'), str(root / '02_media'), str(materials),
                                     subtitle_dir=str(root / '03_subtitle'), timeline_dir=str(root / '05_timeline'),
                                     bgm_dir=str(bgm), project=str(root), ending_audio=str(assets / 'ending_audio.mp3'),
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
        self.assertEqual(len(next(track for track in content['tracks'] if track['name'] == 'BGM轨道')['segments']), 1)
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

    def test_unselected_bgm_returns_review_warning_without_blocking_draft(self):
        root = self.build_root()
        shutil.copytree(root, root / 'materials')
        (root / 'jianying').mkdir()
        result = self.module.generate_draft(str(root / 'jianying'), str(root / 'materials'),
                                            name_prefix='候选A-', project=str(root))
        self.assertTrue(result['success'])
        self.assertEqual(result['drafts_created'], 1)
        self.assertTrue(any('配乐待验收' in warning for warning in result['warnings']))
        self.assertTrue((root / 'jianying' / DRAFT_NAME / 'draft_content.json').is_file())

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
