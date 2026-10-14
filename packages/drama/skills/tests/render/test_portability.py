"""Offline checks; all synthetic files stay within this package."""
import argparse
import importlib.util
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

    def test_single_episode_requires_explicit_ending_effect(self):
        render = load('render_cli_test', RENDER / 'scripts/render_episode.py')
        argv = ['render', '--project', '.', '--episode', '01', '--timeline', 'timeline.json',
                '--subtitle-srt', 'display.srt', '--last-shot', '1', '--bgm', 'mix.mp3',
                '--ending-audio', 'ending.mp3']
        with patch.object(sys, 'argv', argv), patch.object(render, 'render', side_effect=AssertionError('must reject before rendering')), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                render.main()
            self.assertEqual(raised.exception.code, 2)

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
            args = argparse.Namespace(project=project, episode='01', bgm=mix,
                                      ending_audio=RENDER / 'assets/ending_audio.mp3', ending_effect=effect)
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


def load_path_renderer(name, script):
    original_path = sys.path[:]
    try:
        return load(name, RENDER / 'scripts' / script)
    finally:
        sys.path[:] = original_path


class ProjectPathTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.project = self.root / '中文项目 Alpha'
        self.project.mkdir()
        self.cwd = Path.cwd()
        self.assertNotEqual(self.project, self.cwd)

    def test_single_resolves_relative_paths_before_preflight(self):
        render = load_path_renderer('episode_relative_paths_test', 'render_episode.py')
        relative = {
            'timeline': Path('字幕 目录/01.timeline.json'),
            'subtitle_srt': Path('字幕 目录/01.srt'),
            'bgm': Path('配乐 目录/missing.mp3'),
            'ending_audio': Path('片尾 目录/ending.mp3'),
            'ending_effect': Path('片尾 目录/ending.mp4'),
            'output': Path('交付 目录/01.mp4'),
            'freeze_image': Path('片尾 目录/freeze.png'),
        }
        args = argparse.Namespace(project=Path(os.path.relpath(self.project, self.cwd)), **relative)
        with patch.object(render, 'run', side_effect=AssertionError('no media process')):
            with self.assertRaises(FileNotFoundError) as raised:
                render.render(args)
        self.assertEqual(raised.exception.args[0], self.project / relative['bgm'])
        self.assertEqual(args.project, self.project)
        for field, value in relative.items():
            self.assertEqual(getattr(args, field), self.project / value)
        self.assertEqual(Path.cwd(), self.cwd)
        self.assertFalse((self.project / 'exports').exists())

    def test_single_preserves_absolute_paths_and_unset_optional_paths(self):
        render = load_path_renderer('episode_absolute_paths_test', 'render_episode.py')
        absolute = {field: self.root / '独立 输入' / field for field in
                    ('timeline', 'subtitle_srt', 'bgm', 'ending_audio', 'ending_effect')}
        args = argparse.Namespace(project=self.project, output=None, freeze_image=None, **absolute)
        with self.assertRaises(FileNotFoundError):
            render.render(args)
        for field, value in absolute.items():
            self.assertEqual(getattr(args, field), value)
        self.assertIsNone(args.output)
        self.assertIsNone(args.freeze_image)
        self.assertEqual(Path.cwd(), self.cwd)

    def test_single_cli_uses_project_inputs_output_and_state_with_mixed_paths(self):
        render = load_path_renderer('episode_cli_paths_test', 'render_episode.py')
        inputs = self.project / '输入 文件'
        inputs.mkdir()
        (inputs / 'timeline.json').write_text(json.dumps({'clips': [
            {'shot': 1, 'start_us': 0, 'duration_us': 1_000_000}]}), encoding='utf-8')
        (inputs / 'display.srt').write_text('1\n00:00:00,000 --> 00:00:01,000\n测试\n', encoding='utf-8')
        (inputs / 'mix.mp3').touch()
        freeze = self.root / '独立 freeze.png'
        freeze.touch()
        source = self.project / 'video/01/shot_001.mp4'
        source.parent.mkdir(parents=True)
        source.write_bytes(b'unit-test source; never decoded')
        master = self.project / 'audio/01.wav'
        master.parent.mkdir()
        master.touch()
        output = self.project / '交付 文件/01.mp4'
        argv = ['render', '--project', os.path.relpath(self.project, self.cwd), '--episode', '1',
                '--timeline', '输入 文件/timeline.json', '--subtitle-srt', '输入 文件/display.srt',
                '--last-shot', '1', '--bgm', '输入 文件/mix.mp3', '--freeze-image', str(freeze),
                '--ending-audio', str(RENDER / 'assets/ending_audio.mp3'),
                '--ending-effect', str(RENDER / 'assets/ending_effect.mp4'),
                '--output', '交付 文件/01.mp4']

        def record_media_command(command):
            for index, value in enumerate(command[:-1]):
                if value == '-i':
                    self.assertTrue(Path(command[index + 1]).is_absolute())
            target = Path(command[-1])
            self.assertTrue(target.is_absolute())
            target.write_bytes(b'unit-test output; never a deliverable')

        facts = {'streams': [{'codec_type': 'video', 'width': 1440, 'height': 2560,
                             'codec_name': 'h264', 'avg_frame_rate': '60/1'},
                            {'codec_type': 'audio'}], 'format': {'duration': '3'}}
        with patch.object(sys, 'argv', argv), patch.object(render, 'run', side_effect=record_media_command), \
                patch.object(render, 'choose_encoder', return_value=('libx264', [], '')), \
                patch.object(render, 'probe', return_value=facts), \
                patch.object(render, 'assert_decodes_throughout'), contextlib.redirect_stdout(io.StringIO()):
            render.main()
        self.assertEqual(output.read_bytes(), b'unit-test output; never a deliverable')
        state = json.loads((self.project / 'exports/render_tasks.json').read_text(encoding='utf-8'))
        self.assertEqual(state['tasks']['01']['output'], str(output))
        ass = self.project / 'exports/.render_cache/01/2k60_h264_24m/display.ass'
        self.assertIn('测试', ass.read_text(encoding='utf-8-sig'))
        self.assertEqual(Path.cwd(), self.cwd)

    def test_batch_passes_project_relative_resources_as_absolute_arguments(self):
        batch = load_path_renderer('batch_project_paths_test', 'render_batch.py')
        source = self.project / 'video/01/shot_001.mp4'
        source.parent.mkdir(parents=True)
        source.touch()
        mix = self.project / '配乐 文件/01.mp3'
        mix.parent.mkdir()
        mix.touch()
        resources = self.project / '片尾 文件'
        resources.mkdir()
        (resources / 'ending.mp3').touch()
        effect = self.root / '独立 ending.mp4'
        effect.touch()
        argv = ['batch', '--project', os.path.relpath(self.project, self.cwd), '--episodes', '1',
                '--bgm-dir', '配乐 文件', '--ending-audio', '片尾 文件/ending.mp3',
                '--ending-effect', str(effect)]
        with patch.object(sys, 'argv', argv), patch.object(batch.subprocess, 'run') as run, \
                contextlib.redirect_stdout(io.StringIO()):
            run.return_value.returncode = 0
            batch.main()
        command = run.call_args.args[0]
        expected = {'--project': self.project, '--timeline': self.project / 'subtitles/01.timeline.json',
                    '--subtitle-srt': self.project / 'subtitles/01.display.srt', '--bgm': mix,
                    '--ending-audio': resources / 'ending.mp3', '--ending-effect': effect}
        for flag, path in expected.items():
            self.assertEqual(command[command.index(flag) + 1], str(path))
        self.assertTrue(Path(command[2]).is_absolute())
        state = json.loads((self.project / 'exports/batch_render_tasks.json').read_text(encoding='utf-8'))
        self.assertEqual(state['tasks']['01']['output'], str(self.project / 'exports/01.mp4'))
        self.assertEqual(Path.cwd(), self.cwd)


if __name__ == '__main__':
    unittest.main()
