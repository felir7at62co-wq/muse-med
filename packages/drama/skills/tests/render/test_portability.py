"""Offline checks; all synthetic files stay within this package."""
import importlib.util
import argparse
import shutil
import subprocess
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

PACKAGE = Path(__file__).resolve().parents[2]
SKILLS = PACKAGE / 'skills'
DRAFT = SKILLS / 'tweet-drama-draft-build'
RENDER = SKILLS / 'tweet-drama-background-render'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PortabilityTests(unittest.TestCase):
    def test_model_cache_uses_writable_harness_home_not_skill_resources(self):
        paths = load('draft_model_paths_test', DRAFT / 'scripts/paths.py')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.dict(os.environ, {'DSH_HOME': str(root / 'managed')}), patch.object(paths, 'get_app_dir', side_effect=AssertionError('read-only skill tree')):
                self.assertEqual(Path(paths.get_models_dir()), root / 'managed' / 'cache' / 'models')
                self.assertFalse((root / 'managed').exists())
            with patch.dict(os.environ, {'DSH_HOME': '', 'HOME': temporary, 'USERPROFILE': temporary}):
                self.assertEqual(Path(paths.get_models_dir()), root / '.dsh' / 'cache' / 'models')

    def test_model_instructions_cover_bundled_runtime_and_writable_cache(self):
        instructions = (DRAFT / 'SKILL.md').read_text(encoding='utf-8')
        dependencies = (DRAFT / 'references/dependencies.md').read_text(encoding='utf-8')
        for document in (instructions, dependencies):
            self.assertIn('MUSE_WHISPER_MODEL_DIR', document)
            self.assertIn('DSH_HOME', document)
            self.assertIn('--cache-dir', document)
        self.assertNotIn('No speech-transcription model is required.', dependencies)

    def test_ffmpeg_explicit_environment(self):
        paths = load('draft_paths_test', DRAFT / 'scripts/paths.py')
        with patch.dict(os.environ, {'DSH_FFMPEG_PATH': '/configured/ffmpeg',
                                     'DSH_FFPROBE_PATH': '/configured/ffprobe'}):
            self.assertEqual(paths.get_ffmpeg_path(), '/configured/ffmpeg')
            self.assertEqual(paths.get_ffprobe_path(), '/configured/ffprobe')

    def test_ffmpeg_environment_preserves_dsh_priority_and_external_probe(self):
        paths = load('draft_configure_paths_test', DRAFT / 'scripts/paths.py')
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            root = Path(temporary)
            ffmpeg, fallback, ffprobe = (root / name for name in ('ffmpeg', 'fallback', 'ffprobe'))
            for executable in (ffmpeg, fallback, ffprobe):
                executable.touch()
            with patch.dict(os.environ, {'DSH_FFMPEG_PATH': str(ffmpeg), 'FFMPEG_PATH': str(fallback),
                                         'DSH_FFPROBE_PATH': str(ffprobe)}):
                os.environ.pop('FFMPEG_BINARY', None)
                os.environ.pop('FFPROBE_BINARY', None)
                self.assertEqual(paths.configure_ffmpeg_environment(), str(ffmpeg))
                self.assertEqual(os.environ['FFPROBE_BINARY'], str(ffprobe))

    def test_draft_setup_resolves_explicit_ffmpeg_without_ambiguous_paths_import(self):
        generator = load('draft_generator_test', DRAFT / 'scripts/draft_generator.py')
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            executable = Path(temporary) / 'ffmpeg.exe'
            executable.touch()
            with patch.dict(os.environ, {'DSH_FFMPEG_PATH': str(executable)}):
                generator.DraftGenerator()._setup_ffmpeg()
                self.assertEqual(os.environ['FFMPEG_BINARY'], str(executable))

    def test_batch_uses_episode_mix_and_explicit_ending(self):
        batch = load('render_batch_test', RENDER / 'scripts/render_batch.py')
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            project = Path(temporary)
            videos = project / 'video/01'
            videos.mkdir(parents=True)
            (videos / 'shot_001.mp4').touch()
            mixes = project / 'mixes'
            mixes.mkdir()
            (mixes / '01.mp3').touch()
            ending_audio = project / 'ending.mp3'
            ending_effect = project / 'ending.mp4'
            ending_audio.touch()
            ending_effect.touch()
            argv = ['render_batch', '--project', str(project), '--episodes', '1',
                    '--bgm-dir', str(mixes), '--ending-audio', str(ending_audio),
                    '--ending-effect', str(ending_effect)]
            with patch.object(sys, 'argv', argv), patch.object(batch.subprocess, 'run') as run, contextlib.redirect_stdout(io.StringIO()):
                run.return_value.returncode = 0
                batch.main()
            command = run.call_args.args[0]
            self.assertEqual(command[1], '-B')
            self.assertEqual(command[command.index('--bgm') + 1], str(mixes / '01.mp3'))
            self.assertEqual(command[command.index('--ending-effect') + 1], str(ending_effect))
            (mixes / '01.mp3').unlink()
            with patch.object(sys, 'argv', argv), patch.object(batch.subprocess, 'run') as run, contextlib.redirect_stdout(io.StringIO()):
                batch.main()
                run.assert_not_called()
            state = json.loads((project / 'exports/batch_render_tasks.json').read_text(encoding='utf-8'))
            self.assertEqual(state['tasks']['01']['status'], 'failed')
            self.assertIn('Missing reviewed multi-track BGM mix', state['tasks']['01']['error'])

    def test_subtitle_filter_uses_configured_fonts_not_machine_directory(self):
        render = load('render_episode_test', RENDER / 'scripts/render_episode.py')
        with patch.dict(os.environ, {'DSH_FONTS_DIR': '/licensed/fonts'}):
            value = render.subtitle_filter(Path('display.ass'))
            self.assertIn("fontsdir='/licensed/fonts'", value)
            self.assertNotIn('Windows/Fonts', value)

    def test_product_font_documentation_names_both_renderer_inputs(self):
        text = (RENDER / 'SKILL.md').read_text(encoding='utf-8')
        for term in ('MUSE_FONTS_DIR', 'MUSE_FONT_FAMILY', 'Noto Sans CJK SC'):
            self.assertIn(term, text)

    def test_product_font_directory_and_family_reach_subtitle_and_watermark(self):
        render = load('render_product_fonts_test', RENDER / 'scripts/render_episode.py')
        with tempfile.TemporaryDirectory() as temporary:
            srt, ass = Path(temporary) / 'a.srt', Path(temporary) / 'a.ass'
            srt.write_text('1\n00:00:00,000 --> 00:00:01,000\n简体字幕\n', encoding='utf-8')
            with patch.dict(os.environ, {'MUSE_FONTS_DIR': '/product/fonts', 'MUSE_FONT_FAMILY': 'Noto Sans CJK SC'}, clear=True):
                render.write_ass(srt, ass)
                self.assertIn("fontsdir='/product/fonts'", render.subtitle_filter(ass))
                text = ass.read_text(encoding='utf-8')
                self.assertIn('Style: Default,Noto Sans CJK SC,68,', text)
                self.assertIn('Style: Watermark,Noto Sans CJK SC,44,', text)
            with patch.dict(os.environ, {}, clear=True):
                render.write_ass(srt, ass)
                text = ass.read_text(encoding='utf-8')
                self.assertIn('Style: Default,SimHei,68,', text)
                self.assertIn('Style: Watermark,Microsoft YaHei,44,', text)
            with patch.dict(os.environ, {'MUSE_FONT_FAMILY': 'bad,style\n'}, clear=True):
                with self.assertRaises(ValueError):
                    render.write_ass(srt, ass)

    def test_single_episode_requires_ending_assets_only_for_legacy_and_photorealistic(self):
        import argparse
        render = load('render_cli_test', RENDER / 'scripts/render_episode.py')
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary)
            mix, timeline = project / 'mix.mp3', project / 'timeline.json'
            mix.touch()
            for medium in (None, 'photorealistic'):
                payload = {} if medium is None else {'delivery': {
                    'visual_medium': medium, 'width': 1440, 'height': 2560, 'fps': 60}}
                timeline.write_text(json.dumps(payload), encoding='utf-8')
                args = argparse.Namespace(project=project, bgm=mix, timeline=timeline,
                                          ending_duration=2, ending_audio=None, ending_effect=None)
                with patch.object(render, 'run') as run:
                    with self.assertRaisesRegex(ValueError, '--ending-audio is required'):
                        render.render(args)
                    run.assert_not_called()
                self.assertFalse((project / 'exports').exists())

    def test_missing_mix_fails_before_render_preparation(self):
        import argparse
        render = load('render_preflight_test', RENDER / 'scripts/render_episode.py')
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            project = Path(temporary)
            args = argparse.Namespace(project=project, episode='01', bgm=project / 'missing.mp3',
                                      ending_audio=project / 'ending.mp3', ending_effect=project / 'ending.mp4')
            with self.assertRaisesRegex(FileNotFoundError, 'missing.mp3'):
                render.render(args)
            self.assertFalse((project / 'exports').exists())

    def test_ending_effect_filter_plays_the_effect_at_its_own_speed(self):
        render = load('render_ending_speed_test', RENDER / 'scripts/render_episode.py')
        value = render.ending_effect_filter(2.0)
        self.assertIn('[1:v]setpts=PTS-STARTPTS,', value)
        self.assertNotIn('setpts=(PTS-STARTPTS)/', value)
        self.assertIn('tpad=stop_mode=add:stop_duration=2.000:color=black', value)
        self.assertIn('trim=0:2.000', value)

    def test_ending_effect_layout_follows_landscape_canvas_without_portrait_stretch(self):
        render = load('render_ending_canvas_test', RENDER / 'scripts/render_episode.py')
        portrait = render.ending_effect_filter(2.0)
        landscape = render.ending_effect_filter(2.0, width=1920, height=1080, fps=30)
        self.assertIn('crop=540:960,minterpolate=', portrait)
        self.assertIn('crop=960:540,minterpolate=', landscape)
        self.assertNotIn('crop=540:960', landscape)
        self.assertIn('fps=30,scale=1920:1080:flags=lanczos', landscape)

    def test_ending_assets_are_the_shipped_bytes(self):
        render = load('render_ending_asset_test', RENDER / 'scripts/render_episode.py')
        assets = RENDER / 'assets'
        render.verify_ending_asset(assets / 'ending_effect.mp4', render.ENDING_EFFECT)
        render.verify_ending_asset(assets / 'ending_audio.mp3', render.ENDING_AUDIO)
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            wrong = Path(temporary) / 'ending_effect.mp4'
            wrong.write_bytes(b'not the shipped effect')
            with self.assertRaisesRegex(ValueError, 'ending_effect.mp4'):
                render.verify_ending_asset(wrong, render.ENDING_EFFECT)

    def test_render_refuses_a_substituted_ending_effect_before_any_work(self):
        import argparse
        render = load('render_ending_gate_test', RENDER / 'scripts/render_episode.py')
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            project = Path(temporary)
            mix = project / 'mix.mp3'
            mix.touch()
            effect = project / 'ending.mp4'
            effect.touch()
            timeline = project / 'timeline.json'
            timeline.write_text('{}', encoding='utf-8')
            args = argparse.Namespace(project=project, episode='01', bgm=mix, timeline=timeline,
                                      ending_duration=2, ending_audio=RENDER / 'assets/ending_audio.mp3',
                                      ending_effect=effect)
            with self.assertRaisesRegex(ValueError, 'ending_effect.mp4'):
                render.render(args)
            self.assertFalse((project / 'exports').exists())

    def test_current_spoken_and_bgm_rules(self):
        text = (DRAFT / 'references/io-contract.md').read_text(encoding='utf-8')
        self.assertNotIn('on-screen spoken lines only', text)
        self.assertIn('os', text)
        self.assertNotIn('Optional actual_speech_start', text)
        render = (RENDER / 'SKILL.md').read_text(encoding='utf-8')
        self.assertIn('多于一首', render)
        self.assertIn('按正文情绪分段选曲', render)
        self.assertNotIn('E:\\aa-manju', render)



class DeliveryPolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = load('delivery_policy_test', RENDER / 'scripts/delivery_policy.py')

    @staticmethod
    def timeline(medium):
        return {'delivery': {'visual_medium': medium, 'width': 2560, 'height': 1440, 'fps': 30}}

    def test_explicit_media_apply_independent_of_style_text_and_orientation(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary)
            for medium, ending, mark in (('animation_3d', 0, False), ('photorealistic', 2_000_000, True)):
                for width, height in ((2560, 1440), (1440, 2560)):
                    payload = self.timeline(medium)
                    payload['delivery'].update(width=width, height=height)
                    (project / 'project_config.json').write_text(json.dumps({'project_bible': {
                        'visual_medium': medium, 'style': '3D photorealistic animation 真人'}}), encoding='utf-8')
                    result = self.policy.resolve_delivery(payload, project)
                    self.assertEqual((result['ending_duration_us'], result['add_watermark']), (ending, mark))
                    self.assertEqual((result['width'], result['height'], result['fps']), (width, height, 30))
                    self.assertEqual(result['warnings'], [])

    def test_missing_medium_preserves_legacy_with_explicit_warning(self):
        with self.assertLogs(self.policy.logger, level='WARNING') as captured:
            result = self.policy.resolve_delivery({'style': '3D动画', 'canvas': {'width': 2560, 'height': 1440}})
        self.assertIsNone(result['visual_medium'])
        self.assertEqual(result['ending_duration_us'], 2_000_000)
        self.assertTrue(result['add_watermark'])
        self.assertIn('visual_medium is missing', captured.output[0])
        self.assertEqual(len(result['warnings']), 1)

    def test_project_medium_applies_to_legacy_timeline_and_conflict_requires_prepare(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary)
            (project / 'project_config.json').write_text(json.dumps({
                'project_bible': {'visual_medium': 'animation_3d'}}), encoding='utf-8')
            self.assertFalse(self.policy.resolve_delivery({}, project)['add_watermark'])
            with self.assertRaisesRegex(ValueError, 'conflicts.*rerun prepare'):
                self.policy.resolve_delivery(self.timeline('photorealistic'), project)

    def test_invalid_explicit_medium_never_falls_back_or_infers(self):
        for value in (None, '', '3d', 'unknown', 3, {}, []):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'visual_medium must be'):
                self.policy.resolve_delivery(self.timeline(value))
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary)
            (project / 'project_config.json').write_text(json.dumps({
                'project_bible': {'visual_medium': '3d'}}), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'project_bible.visual_medium'):
                self.policy.resolve_delivery(self.timeline('animation_3d'), project)

    def test_malformed_project_geometry_fails_even_with_a_valid_timeline_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary)
            for geometry in (None, [], {'width': None}, {'height': 2559}, {'fps': 241}):
                (project / 'project_config.json').write_text(json.dumps({'project_bible': {
                    'visual_medium': 'animation_3d', 'delivery': geometry}}), encoding='utf-8')
                with self.subTest(geometry=geometry), self.assertRaisesRegex(ValueError, 'project_bible.delivery'):
                    self.policy.resolve_delivery(self.timeline('animation_3d'), project)
            (project / 'project_config.json').write_text(json.dumps({'project_bible': {
                'visual_medium': 'animation_3d', 'delivery': {'fps': 24}}}), encoding='utf-8')
            result = self.policy.resolve_delivery(self.timeline('animation_3d'), project)
            self.assertEqual(result['fps'], 30, 'the prepared snapshot owns delivery geometry')

    def test_snapshot_and_legacy_canvas_must_agree(self):
        timeline = self.timeline('animation_3d')
        timeline['canvas'] = {'width': 1440, 'height': 2560}
        with self.assertRaisesRegex(ValueError, 'canvas conflicts'):
            self.policy.resolve_delivery(timeline)
        timeline['canvas'] = {'width': 2560, 'height': 1440}
        self.assertEqual(self.policy.resolve_delivery(timeline)['width'], 2560)
        for key, value in (('width', 0), ('width', 2559), ('width', 9_007_199_254_740_992),
                           ('height', True), ('fps', 0), ('fps', 241), ('fps', 23.5), ('fps', float('nan'))):
            malformed = self.timeline('animation_3d')
            malformed['delivery'][key] = value
            with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, 'timeline.delivery'):
                self.policy.resolve_delivery(malformed)

    def test_animation_rejects_explicit_included_ending(self):
        timeline = self.timeline('animation_3d')
        timeline['body_end'] = 4
        with self.assertRaisesRegex(ValueError, 'animation_3d cannot include an ending'):
            self.policy.reject_animation_ending(timeline, 6_000_000, self.policy.resolve_delivery(timeline))
        self.policy.reject_animation_ending(timeline, 4_000_000, self.policy.resolve_delivery(timeline))

    def test_batch_accepts_animation_without_ending_arguments(self):
        batch = load('render_batch_animation_test', RENDER / 'scripts/render_batch.py')
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary)
            (project / 'video/01').mkdir(parents=True)
            (project / 'video/01/shot_001.mp4').touch()
            (project / 'mixes').mkdir()
            (project / 'mixes/01.mp3').touch()
            argv = ['render_batch', '--project', str(project), '--episodes', '1',
                    '--bgm-dir', str(project / 'mixes')]
            with patch.object(sys, 'argv', argv), patch.object(batch.subprocess, 'run') as run, \
                    contextlib.redirect_stdout(io.StringIO()):
                run.return_value.returncode = 0
                batch.main()
            self.assertNotIn('--ending-audio', run.call_args.args[0])
            self.assertNotIn('--ending-effect', run.call_args.args[0])



class RenderDeliveryMediaTests(unittest.TestCase):
    """Exercise real FFmpeg outputs at a tiny delivery size through both medium branches."""

    @classmethod
    def setUpClass(cls):
        for binary in ('ffmpeg', 'ffprobe'):
            if shutil.which(binary) is None:
                raise unittest.SkipTest(f'{binary} is not on PATH')
        cls.render = load('render_delivery_media_test', RENDER / 'scripts/render_episode.py')

    def inputs(self, medium):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / 'video/01').mkdir(parents=True)
        (root / 'audio').mkdir()
        source = root / 'video/01/shot_001.mp4'
        # The white source box stands in for an existing source mark; it must survive delivery.
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                        'color=blue:s=160x96:r=12:d=0.5', '-vf',
                        'drawbox=x=5:y=5:w=20:h=10:color=white:t=fill', '-pix_fmt', 'yuv420p',
                        str(source)], check=True)
        audio = root / 'audio/01.wav'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                        'sine=frequency=440:duration=0.5', '-ar', '48000', '-ac', '2', str(audio)], check=True)
        mix = root / 'mix.wav'
        shutil.copy2(audio, mix)
        timeline = root / 'timeline.json'
        delivery = {'width': 160, 'height': 96, 'fps': 12}
        if medium is not None:
            delivery['visual_medium'] = medium
        timeline.write_text(json.dumps({'delivery': delivery, 'body_end': 0.5,
                                       'clips': [{'shot': 1, 'start_us': 0, 'duration_us': 500_000}]}), encoding='utf-8')
        srt = root / 'subtitle.srt'
        srt.write_text('1\n00:00:00,000 --> 00:00:00,400\n字幕\n', encoding='utf-8')
        return argparse.Namespace(project=root, episode='01', timeline=timeline, subtitle_srt=srt,
                                  last_shot=1, bgm=mix, ending_audio=RENDER / 'assets/ending_audio.mp3',
                                  ending_effect=RENDER / 'assets/ending_effect.mp4', ending_duration=2.0,
                                  master_volume=1, bgm_volume=0.1, freeze_image=None, output=None, force=False)

    def render_tiny(self, args):
        with patch.object(self.render, 'choose_encoder', return_value=('libx264', ['-preset', 'ultrafast'], 'test CPU')):
            return self.render.render(args)

    def test_animation_final_stops_at_body_preserves_source_mark_and_needs_no_ending_assets(self):
        args = self.inputs('animation_3d')
        args.ending_audio = args.project / 'absent.mp3'
        args.ending_effect = args.project / 'absent.mp4'
        args.freeze_image = args.project / 'absent.png'
        with patch.object(self.render, 'extract_tail_frame', side_effect=AssertionError('no generated tail')), \
                patch.object(self.render, 'verify_ending_asset', side_effect=AssertionError('no ending validation')):
            result = self.render_tiny(args)
        self.assertAlmostEqual(result['duration'], 0.5, delta=0.05)
        self.assertEqual(result['expected_duration'], 0.5)
        self.assertEqual((result['width'], result['height'], result['fps']), (160, 96, 12))
        self.assertEqual(result['warnings'], [])
        cache = next((args.project / 'exports/.render_cache/01').iterdir())
        ass = (cache / 'display.ass').read_text(encoding='utf-8-sig')
        self.assertNotIn('Watermark', ass)
        self.assertIn('字幕', ass)
        self.assertFalse((cache / 'ending.mp4').exists())
        self.assertFalse((cache / 'last_video_tail_frame.png').exists())
        self.assertEqual(len((cache / 'concat.txt').read_text().splitlines()), 1)
        pixels = subprocess.run(['ffmpeg', '-v', 'error', '-i', result['output'], '-frames:v', '1',
                                 '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout
        offset = (8 * 160 + 10) * 3
        self.assertTrue(all(value > 230 for value in pixels[offset:offset + 3]), 'source mark must remain')

    def test_partial_animation_render_validates_body_end_against_the_full_timeline(self):
        args = self.inputs('animation_3d')
        payload = json.loads(args.timeline.read_text())
        payload['clips'].append({'shot': 2, 'start_us': 500_000, 'duration_us': 500_000})
        payload['body_end'] = 1.0
        args.timeline.write_text(json.dumps(payload), encoding='utf-8')
        result = self.render_tiny(args)
        self.assertAlmostEqual(result['duration'], 0.5, delta=0.05)
        self.assertEqual(result['expected_duration'], 0.5)

    def test_changed_body_duration_rebuilds_cached_shots_with_the_same_source_bytes(self):
        args = self.inputs('animation_3d')
        self.render_tiny(args)
        payload = json.loads(args.timeline.read_text())
        payload['clips'][0]['duration_us'] = 250_000
        payload['body_end'] = 0.25
        args.timeline.write_text(json.dumps(payload), encoding='utf-8')
        with patch.object(self.render, 'run', wraps=self.render.run) as run:
            result = self.render_tiny(args)
        rebuilt = [call for call in run.call_args_list if call.args[0][-1].endswith('shot_001.mp4')]
        self.assertEqual(len(rebuilt), 1)
        self.assertAlmostEqual(result['duration'], 0.25, delta=0.05)
        self.assertEqual(result['expected_duration'], 0.25)

    def test_photorealistic_and_missing_medium_keep_two_second_ending_and_ai_notice(self):
        for medium in ('photorealistic', None):
            with self.subTest(medium=medium):
                args = self.inputs(medium)
                result = self.render_tiny(args)
                self.assertAlmostEqual(result['duration'], 2.5, delta=0.15)
                self.assertEqual(result['expected_duration'], 2.5)
                self.assertEqual(bool(result['warnings']), medium is None)
                cache = next((args.project / 'exports/.render_cache/01').iterdir())
                ass = (cache / 'display.ass').read_text(encoding='utf-8-sig')
                self.assertEqual(ass.count('内容由AI生成'), 1)
                self.assertTrue((cache / 'ending.mp4').is_file())
                self.assertTrue((cache / 'last_video_tail_frame.png').is_file())
                self.assertEqual(len((cache / 'concat.txt').read_text().splitlines()), 2)

    def test_animation_included_ending_refuses_before_ffmpeg_and_preserves_prior_export(self):
        args = self.inputs('animation_3d')
        payload = json.loads(args.timeline.read_text())
        payload['body_end'] = 0.25
        args.timeline.write_text(json.dumps(payload), encoding='utf-8')
        old = args.project / 'exports/01.mp4'
        old.parent.mkdir()
        old.write_bytes(b'prior export')
        with patch.object(self.render, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'animation_3d cannot include an ending'):
                self.render.render(args)
            run.assert_not_called()
        self.assertEqual(old.read_bytes(), b'prior export')

    def test_cli_animation_without_ending_flags_writes_verified_result(self):
        args = self.inputs('animation_3d')
        argv = ['render_episode', '--project', str(args.project), '--episode', '01',
                '--timeline', str(args.timeline), '--subtitle-srt', str(args.subtitle_srt),
                '--last-shot', '1', '--bgm', str(args.bgm)]
        with patch.object(sys, 'argv', argv), \
                patch.object(self.render, 'choose_encoder', return_value=('libx264', ['-preset', 'ultrafast'], 'test CPU')), \
                contextlib.redirect_stdout(io.StringIO()):
            self.render.main()
        state = json.loads((args.project / 'exports/render_tasks.json').read_text())
        self.assertEqual(state['tasks']['01']['visual_medium'], 'animation_3d')
        self.assertEqual(state['tasks']['01']['expected_duration'], 0.5)
        self.assertTrue(Path(state['tasks']['01']['output']).is_file())


if __name__ == '__main__':
    unittest.main()
