import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from draft_generator import DraftGenerator

class DraftRootTests(unittest.TestCase):
    def test_missing_editor_root_is_not_created(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / 'missing'
            with self.assertRaisesRegex(ValueError, 'existing absolute'):
                DraftGenerator().process(directory, str(missing))
            self.assertFalse(missing.exists())

    def test_relative_root_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'existing absolute'):
            DraftGenerator().process('.', '.')

    def test_passes_the_resolved_root_to_generation_and_preserves_existing_drafts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / 'old'
            old.mkdir()
            (old / 'draft_content.json').write_text('keep')
            def generate(**kwargs):
                self.assertEqual(kwargs['drafts_dir'], directory)
                (root / 'unrelated-a').mkdir()
                (root / 'unrelated-b').mkdir()
                return {'success': True, 'drafts_created': 1, 'drafts': [
                    {'episode': '01', 'name': 'new', 'path': str(root / 'new'),
                     'id': 'saved-draft-id', 'success': True, 'error': ''}]}
            with patch.dict(sys.modules, {'jianying_draft': SimpleNamespace(generate_draft=generate)}):
                result = DraftGenerator().process(directory, directory, name_prefix='new')
            self.assertEqual(result['drafts_created'], 1)
            self.assertEqual(result['drafts'][0]['id'], 'saved-draft-id')
            self.assertEqual(result['drafts'][0]['path'], str(root / 'new'))
            self.assertEqual((old / 'draft_content.json').read_text(), 'keep')

    def test_partial_failure_is_returned_without_counting_new_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            result = {'success': False, 'drafts_created': 0, 'drafts': [], 'error': 'save failed'}
            def generate(**_kwargs):
                (Path(directory) / 'incomplete').mkdir()
                return result
            with patch.dict(sys.modules, {'jianying_draft': SimpleNamespace(generate_draft=generate)}):
                self.assertIs(DraftGenerator().process(directory, directory), result)

if __name__ == '__main__':
    unittest.main()
