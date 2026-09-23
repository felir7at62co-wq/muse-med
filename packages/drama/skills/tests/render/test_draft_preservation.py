"""Protect an existing Jianying draft from a repeated generation."""
import argparse
import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'skills/tweet-drama-draft-build/scripts/jianying_draft.py'


class DraftPreservationTests(unittest.TestCase):
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
