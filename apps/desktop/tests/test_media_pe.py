"""Native closure checks distinguish an exact VC runtime name from NumPy's private renamed library."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('media_pe', Path(__file__).parents[1] / 'scripts' / 'audit-media-pe.py')
PE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PE)


class DependencyTests(unittest.TestCase):
    def test_private_hashed_library_does_not_supply_the_named_vc_runtime(self):
        names = {'msvcp140-a1b2c3.dll', 'vcruntime140.dll'}
        self.assertEqual(PE.classify_dependency('MSVCP140.dll', names), 'offline-vc-redistributable')
        self.assertEqual(PE.classify_dependency('MSVCP140_1.dll', names), 'offline-vc-redistributable')
        self.assertEqual(PE.classify_dependency('VCRUNTIME140.dll', names), 'payload')

    def test_unknown_dependencies_are_not_assumed_present_on_windows(self):
        self.assertEqual(PE.classify_dependency('KERNEL32.dll', set()), 'windows-os')
        self.assertEqual(PE.classify_dependency('api-ms-win-crt-runtime-l1-1-0.dll', set()), 'windows-os')
        self.assertEqual(PE.classify_dependency('vendor-missing.dll', set()), 'unresolved')


if __name__ == '__main__':
    unittest.main()
