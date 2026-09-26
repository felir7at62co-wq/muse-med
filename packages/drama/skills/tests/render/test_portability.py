"""Offline checks; all synthetic files stay within this package."""
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


if __name__ == '__main__':
    unittest.main()
