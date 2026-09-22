"""Stdlib-only checks for the Windows runtime preparer's file safety policy."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/runtime.py'
spec = importlib.util.spec_from_file_location('portable_runtime', SCRIPT)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class PortableRuntimeTest(unittest.TestCase):
    def test_pth_preserves_relative_namespace_paths_but_rejects_executable_or_external(self):
        self.assertTrue(runtime.keep_pth('namespace.pth', b'# namespace\nnamespace_lib\n'))
        for content in (b'import dangerous\n', b'import\tdangerous\n',
                        b'C:\\old\\Lib\n', b'../outside\n', b'/outside\n',
                        b'\x80\x04pickled state dict'):
            with self.subTest(content=content), self.assertRaises(ValueError):
                runtime.keep_pth('unknown.pth', content)
        self.assertFalse(runtime.keep_pth('distutils-precedence.pth', runtime.DISTUTILS_SHIM.encode()))

    def test_site_pth_location_reviews_only_where_site_scans(self):
        self.assertTrue(runtime.site_pth_location('Lib/site-packages/setuptools.pth'))
        self.assertFalse(runtime.site_pth_location(
            'Lib/site-packages/torchmetrics/functional/image/lpips_models/alex.pth'))

    def test_record_maps_native_library_resources_but_not_venv_launchers(self):
        self.assertEqual(runtime.record_destination('pkg/core.py'), 'Lib/site-packages/pkg/core.py')
        self.assertEqual(runtime.record_destination('../../Library/bin/mkl.dll'), 'Library/bin/mkl.dll')
        self.assertIsNone(runtime.record_destination('../../Scripts/pip.exe'))
        for value in ('../../../outside', '/outside', 'C:/outside', 'pkg\\outside'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                runtime.record_destination(value)

    def test_new_output_refuses_existing_directory_and_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            existing = root / 'existing'
            existing.mkdir()
            marker = existing / 'user.txt'
            marker.write_text('untouched', encoding='utf-8')
            for path in (existing, marker):
                with self.assertRaises(FileExistsError):
                    runtime.new_output(path)
            self.assertEqual(marker.read_text(encoding='utf-8'), 'untouched')

    def test_manifest_detects_corruption_unknown_files_and_unsafe_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            item = root / 'asset'
            item.write_bytes(b'original')
            manifest = {'version': 1, 'files': [runtime.file_record(item, root)]}
            (root / 'runtime-manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
            runtime.verify_files(root)
            item.write_bytes(b'corrupt')
            with self.assertRaises(ValueError):
                runtime.verify_files(root)
            item.write_bytes(b'original')
            (root / 'unknown').write_bytes(b'x')
            with self.assertRaises(ValueError):
                runtime.verify_files(root)
            (root / 'unknown').unlink()
            manifest['files'][0]['path'] = '../outside'
            (root / 'runtime-manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
            with self.assertRaises(ValueError):
                runtime.verify_files(root)


if __name__ == '__main__':
    unittest.main()
