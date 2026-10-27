"""Deterministic sampling and coverage checks without downloading models or touching a project."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('tag_index', Path(__file__).resolve().parents[1] / 'scripts/build_tag_index.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class TagIndex(unittest.TestCase):
    def test_samples_include_start_middle_and_end(self):
        self.assertEqual(module.sample_starts(60, 10, 6), [0, 10, 20, 30, 40, 50])
        self.assertEqual(module.sample_starts(5, 10, 6), [0])
        self.assertEqual(module.sample_starts(60, 10, 1), [0])

    def test_overlap_does_not_inflate_coverage(self):
        self.assertEqual(module.covered_seconds([(0, 10), (5, 15), (12, 20)]), 20)
        self.assertEqual(module.covered_seconds([(0, 10), (50, 60)]), 20)

    def test_invalid_sampling_fails(self):
        for args in [(0, 10, 6), (60, 0, 6), (60, 10, 0)]:
            with self.assertRaises(ValueError):
                module.sample_starts(*args)

    def test_nonfinite_output_does_not_replace_a_saved_index(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'index.json'
            module.atomic_json(target, {'version': 1})
            original = target.read_bytes()
            with self.assertRaises(ValueError):
                module.atomic_json(target, {'invalid': float('nan')})
            self.assertEqual(target.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
