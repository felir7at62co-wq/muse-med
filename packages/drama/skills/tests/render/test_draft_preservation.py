"""Protect an existing Jianying draft from a repeated generation."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'skills/tweet-drama-draft-build/scripts/jianying_draft.py'


class DraftPreservationTests(unittest.TestCase):
    def test_save_failure_or_missing_content_cannot_be_reported_as_success(self):
        original_path = sys.path[:]
        with patch.dict(sys.modules, {'pyJianYingDraft': types.SimpleNamespace()}):
            try:
                spec = importlib.util.spec_from_file_location('draft_save_contract', SCRIPT)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
            finally:
                sys.path[:] = original_path

        with tempfile.TemporaryDirectory() as temporary:
            draft_dir = Path(temporary) / 'new-candidate'

            def failed_save():
                raise OSError('primary write failed')

            def failed_dump(_path):
                raise OSError('fallback write failed')

            script = types.SimpleNamespace(save=failed_save, dump=failed_dump, dumps=lambda: json.dumps({'tracks': []}))
            with self.assertRaisesRegex(module.DraftInputError, '保存草稿.*失败'):
                module.save_verified_draft(script, draft_dir)

            script = types.SimpleNamespace(save=lambda: None, dump=failed_dump, dumps=lambda: json.dumps({'tracks': []}))
            with self.assertRaisesRegex(module.DraftInputError, 'draft_content.json'):
                module.save_verified_draft(script, draft_dir)

            def valid_dump(path):
                Path(path).write_text(json.dumps({'tracks': []}), encoding='utf-8')

            script = types.SimpleNamespace(save=failed_save, dump=valid_dump, dumps=lambda: json.dumps({'tracks': []}))
            self.assertEqual(module.save_verified_draft(script, draft_dir), {'tracks': []})

            with self.assertRaisesRegex(module.DraftInputError, 'BGM 轨道'):
                module.verify_draft_delivery({'tracks': []}, {}, None, None, expect_bgm=True)
            shifted_bgm = {'tracks': [{'type': 'audio', 'name': 'BGM轨道', 'segments': [
                {'target_timerange': {'start': 1_000_000, 'duration': 4_000_000}}
            ]}]}
            with self.assertRaisesRegex(module.DraftInputError, 'BGM 轨道'):
                module.verify_draft_delivery(shifted_bgm, {}, 4_000_000, None, expect_bgm=True)

            with patch.object(module, 'main_with_args', return_value=None):
                result = module.generate_draft(str(Path(temporary)), str(Path(temporary)))
            self.assertFalse(result['success'])
            self.assertEqual(result['drafts_created'], 0)
            self.assertEqual(result['drafts'], [])

    def test_alignment_warning_continues_in_a_candidate_and_preserves_existing_materials(self):
        spec = importlib.util.spec_from_file_location('draft_generator_blocked', SCRIPT.with_name('draft_generator.py'))
        generator_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator_module)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio = root / 'audio'
            video = root / 'video'
            subtitles = root / 'subtitles'
            materials = root / 'materials'
            for directory in (audio, video, subtitles, materials):
                directory.mkdir()
            (audio / '01.wav').write_bytes(b'audio')
            (subtitles / '01.srt').write_text('old subtitle', encoding='utf-8')
            (subtitles / '01.srt.blocked').write_text('alignment pending', encoding='utf-8')
            sentinel = materials / 'keep.txt'
            sentinel.write_text('keep prepared materials', encoding='utf-8')
            with self.assertLogs(generator_module.logger, level='WARNING') as notes:
                candidate = generator_module.DraftGenerator().prepare_materials(
                    str(audio), str(video), str(materials), subtitle_dir=str(subtitles), project=str(root))
            self.assertEqual(sentinel.read_text(encoding='utf-8'), 'keep prepared materials')
            self.assertNotEqual(Path(candidate), materials)
            self.assertTrue((Path(candidate) / '01_audio' / '01.wav').is_file())
            self.assertTrue(notes.output)

    def test_ambiguous_bgm_remains_unselected_and_preserves_existing_materials(self):
        spec = importlib.util.spec_from_file_location('draft_generator_ambiguous_bgm', SCRIPT.with_name('draft_generator.py'))
        generator_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator_module)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio, video, bgm, materials = (root / name for name in ('audio', 'video', 'bgm', 'materials'))
            for directory in (audio, video, bgm, materials):
                directory.mkdir()
            (audio / '01.wav').write_bytes(b'audio')
            (bgm / 'a.mp3').write_bytes(b'one')
            (bgm / 'b.mp3').write_bytes(b'two')
            sentinel = materials / 'keep.txt'
            sentinel.write_text('keep prepared materials', encoding='utf-8')
            with self.assertLogs(generator_module.logger, level='WARNING') as notes:
                candidate = generator_module.DraftGenerator().prepare_materials(
                    str(audio), str(video), str(materials), bgm_dir=str(bgm), project=str(root))
            self.assertEqual(sentinel.read_text(encoding='utf-8'), 'keep prepared materials')
            self.assertNotEqual(Path(candidate), materials)
            self.assertTrue((Path(candidate) / '01_audio' / '01.wav').is_file())
            self.assertTrue(notes.output)

    def test_missing_selected_bgm_preserves_existing_prepared_materials(self):
        spec = importlib.util.spec_from_file_location('draft_generator_missing_bgm', SCRIPT.with_name('draft_generator.py'))
        generator_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator_module)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio, video, materials = (root / name for name in ('audio', 'video', 'materials'))
            for directory in (audio, video, materials):
                directory.mkdir()
            (audio / '01.wav').write_bytes(b'audio')
            sentinel = materials / 'keep.txt'
            sentinel.write_text('keep prepared materials', encoding='utf-8')
            with self.assertRaisesRegex(FileNotFoundError, '已指定的 BGM 文件夹不存在'):
                generator_module.DraftGenerator().prepare_materials(
                    str(audio), str(video), str(materials), bgm_dir=str(root / 'missing-bgm'), project=str(root))
            self.assertEqual(sentinel.read_text(encoding='utf-8'), 'keep prepared materials')

    def test_explicit_bgm_requirement_remains_advisory_before_media_preparation(self):
        class DraftFolder:
            def __init__(self, _path):
                raise RuntimeError('Reached draft preparation')

        original_path = sys.path[:]
        with patch.dict(sys.modules, {'pyJianYingDraft': types.SimpleNamespace(DraftFolder=DraftFolder)}):
            try:
                spec = importlib.util.spec_from_file_location('draft_required_bgm', SCRIPT)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
            finally:
                sys.path[:] = original_path

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio = root / 'materials/01_audio'
            media = root / 'materials/02_media/01'
            drafts = root / 'jianying'
            for directory in (audio, media, drafts):
                directory.mkdir(parents=True)
            (audio / '01.wav').write_bytes(b'audio')
            (media / '001.mp4').write_bytes(b'video')
            for empty_directory in (False, True):
                if empty_directory:
                    (root / 'materials/04_bgm').mkdir()
                with self.assertLogs(module.logger, level='WARNING') as notes:
                    result = module.generate_draft(str(drafts), str(root / 'materials'), require_bgm=True)
                self.assertIn('Reached draft preparation', result['error'])
                self.assertTrue(any('配乐' in entry for entry in notes.output))
                self.assertEqual(list(drafts.iterdir()), [])

    def test_missing_episode_media_cannot_report_batch_success(self):
        class DraftFolder:
            def __init__(self, _path):
                pass

            def create_draft(self, _name, **_options):
                raise AssertionError('missing episode must fail before writing a draft')

        original_path = sys.path[:]
        with patch.dict(sys.modules, {'pyJianYingDraft': types.SimpleNamespace(DraftFolder=DraftFolder)}):
            try:
                spec = importlib.util.spec_from_file_location('draft_batch_missing_media', SCRIPT)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
            finally:
                sys.path[:] = original_path

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio = root / 'materials/01_audio'
            media = root / 'materials/02_media/02'
            bgm = root / 'materials/04_bgm'
            drafts = root / 'jianying'
            for directory in (audio, media, bgm, drafts):
                directory.mkdir(parents=True)
            for episode in ('01', '02'):
                (audio / f'{episode}.wav').write_bytes(b'audio')
            (media / '001.mp4').write_bytes(b'video')
            (bgm / 'reviewed.wav').write_bytes(b'music')

            result = module.generate_draft(str(drafts), str(root / 'materials'), seq='01')
            self.assertFalse(result['success'])
            self.assertIn('序列 01', result['error'])
            self.assertIn('对应的媒体文件夹', result['error'])
            self.assertEqual(list(drafts.iterdir()), [])

            batch_result = module.generate_draft(str(drafts), str(root / 'materials'))
            self.assertFalse(batch_result['success'])
            self.assertIn('对应的媒体文件夹', batch_result['error'])
            self.assertEqual(list(drafts.iterdir()), [])

    def test_draft_subtitles_must_match_approved_srt_text_and_timing(self):
        original_path = sys.path[:]
        with patch.dict(sys.modules, {'pyJianYingDraft': types.SimpleNamespace()}):
            try:
                spec = importlib.util.spec_from_file_location('draft_subtitle_comparison', SCRIPT)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
            finally:
                sys.path[:] = original_path
        content = {'tracks': [{'type': 'text', 'name': '字幕轨道', 'segments': [
            {'material_id': 'subtitle-1', 'target_timerange': {'start': 1_000_000, 'duration': 1_000_000}}
        ]}], 'materials': {'texts': [{'id': 'subtitle-1', 'content': json.dumps({'text': '实际字幕'})}]}}
        approved = [{'text': '审核字幕', 'start_us': 1_000_000, 'end_us': 2_000_000}]
        with self.assertRaisesRegex(module.DraftInputError, '字幕文字与已审核 SRT 不一致'):
            module.verify_draft_delivery(content, {}, None, approved)
        approved[0]['text'] = '实际字幕'
        approved[0]['start_us'] = 1_500_000
        with self.assertRaisesRegex(module.DraftInputError, '字幕时间与已审核 SRT 相差超过 0.05 秒'):
            module.verify_draft_delivery(content, {}, None, approved)

    def test_existing_candidate_draft_is_not_deleted_or_recreated(self):
        created = []

        class DraftFolder:
            def __init__(self, path):
                self.path = path

            def create_draft(self, name, **_options):
                created.append(name)
                raise AssertionError('existing draft must not be recreated')

        fake_library = types.SimpleNamespace(DraftFolder=DraftFolder)
        original_path = sys.path[:]
        with patch.dict(sys.modules, {'pyJianYingDraft': fake_library}):
            try:
                spec = importlib.util.spec_from_file_location('draft_preservation', SCRIPT)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
            finally:
                sys.path[:] = original_path

        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary)
            audio = project / 'materials/01_audio'
            media = project / 'materials/02_media/01'
            draft = project / 'jianying/候选A-01'
            audio.mkdir(parents=True)
            media.mkdir(parents=True)
            draft.mkdir(parents=True)
            (audio / '01.wav').write_bytes(b'audio')
            (media / '001.mp4').write_bytes(b'video')
            original = draft / 'draft_content.json'
            original.write_text('keep-this-draft', encoding='utf-8')
            args = argparse.Namespace(drafts=str(draft.parent), materials=str(project / 'materials'),
                                      template_dir=None, seq=None, name_prefix='候选A-', project=str(project))
            with self.assertRaisesRegex(module.DraftInputError, '候选A-01'):
                module.main_with_args(args)
            self.assertEqual(original.read_text(encoding='utf-8'), 'keep-this-draft')
            self.assertEqual(created, [])

    def test_name_prefix_cannot_write_outside_jianying_root(self):
        class DraftFolder:
            def __init__(self, _path):
                pass

            def create_draft(self, _name, **_options):
                raise AssertionError('invalid draft name must not reach the writer')

        fake_library = types.SimpleNamespace(DraftFolder=DraftFolder)
        original_path = sys.path[:]
        with patch.dict(sys.modules, {'pyJianYingDraft': fake_library}):
            try:
                spec = importlib.util.spec_from_file_location('draft_prefix_validation', SCRIPT)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
            finally:
                sys.path[:] = original_path
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary)
            audio = project / 'materials/01_audio'
            media = project / 'materials/02_media/01'
            audio.mkdir(parents=True)
            media.mkdir(parents=True)
            (audio / '01.wav').write_bytes(b'audio')
            (media / '001.mp4').write_bytes(b'video')
            for prefix in ('../other/', '..\\other\\', 'C:/other/', 'bad:name-'):
                with self.subTest(prefix=prefix):
                    args = argparse.Namespace(drafts=str(project / 'jianying'), materials=str(project / 'materials'),
                                              template_dir=None, seq=None, name_prefix=prefix, project=str(project))
                    with self.assertRaisesRegex(module.DraftInputError, 'name_prefix'):
                        module.main_with_args(args)


if __name__ == '__main__':
    unittest.main()
