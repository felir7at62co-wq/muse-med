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
                (root / 'new').mkdir()
                return {'success': True}
            with patch.dict(sys.modules, {'jianying_draft': SimpleNamespace(generate_draft=generate)}):
                result = DraftGenerator().process(directory, directory, name_prefix='new')
            self.assertEqual(result, {'success': True, 'drafts_created': 1})
            self.assertEqual((old / 'draft_content.json').read_text(), 'keep')

if __name__ == '__main__':
    unittest.main()
