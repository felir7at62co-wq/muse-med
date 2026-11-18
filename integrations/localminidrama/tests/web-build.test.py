"""Offline regression checks for the deployment artifact gate."""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('verifier', Path(__file__).parents[1] / 'verify-web-build.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
PARSER = Path(sys.argv.pop(1)).resolve()


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.write('index.html', '<script type="module" src="/studio/assets/index.js"></script>'
                   '<link rel="stylesheet" href="/studio/assets/main.css">')
        self.write('assets/index.js', 'import "./child.js";'
                   'const preload=["assets/child.js"];'
                   'const ready="muse-localminidrama:ready", ping="muse-localminidrama:ping";')
        self.write('assets/child.js', 'export const value=1;')
        self.write('assets/main.css', 'body{background:url("./pixel.svg")}')
        self.write('assets/pixel.svg', '<svg/>')

    def write(self, path, data):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(data, encoding='utf-8')

    def verify(self):
        return verifier.verify(self.root, parser_module=PARSER)

    def test_valid_base_and_transitive_assets(self):
        self.assertEqual(self.verify()['referenced_files'], 4)

    def test_explicit_root_base_supports_standalone_studio(self):
        self.write('index.html', (self.root / 'index.html').read_text().replace('/studio/', '/'))
        self.assertEqual(verifier.verify(self.root, base='/', parser_module=PARSER)['referenced_files'], 4)

    def test_root_base_is_rejected(self):
        self.write('index.html', '<script type="module" src="/assets/index.js"></script>')
        with self.assertRaisesRegex(verifier.ArtifactError, 'Wrong deployment base'):
            self.verify()

    def test_missing_entry_is_rejected(self):
        (self.root / 'assets/index.js').unlink()
        with self.assertRaisesRegex(verifier.ArtifactError, 'Missing resource'):
            self.verify()

    def test_missing_dynamic_chunk_is_rejected(self):
        self.write('assets/index.js', (self.root / 'assets/index.js').read_text() + 'import("./lost.js");')
        with self.assertRaisesRegex(verifier.ArtifactError, 'Missing resource'):
            self.verify()

    def test_wrong_nested_asset_base_is_rejected(self):
        self.write('assets/index.js', (self.root / 'assets/index.js').read_text() + 'const wrong="/assets/child.js";')
        with self.assertRaisesRegex(verifier.ArtifactError, 'Wrong deployment base'):
            self.verify()

    def test_missing_preload_dependency_is_rejected(self):
        self.write('assets/index.js', (self.root / 'assets/index.js').read_text() + 'const dependencies=["assets/missing.css"];')
        with self.assertRaisesRegex(verifier.ArtifactError, 'Missing resource'):
            self.verify()

    def test_missing_css_resource_is_rejected(self):
        (self.root / 'assets/pixel.svg').unlink()
        with self.assertRaisesRegex(verifier.ArtifactError, 'Missing resource'):
            self.verify()

    def test_missing_quoted_css_import_is_rejected(self):
        self.write('assets/main.css', '@import "./missing.css";')
        with self.assertRaisesRegex(verifier.ArtifactError, 'Missing resource'):
            self.verify()

    def test_external_quoted_css_import_is_rejected(self):
        self.write('assets/main.css', '@import "https://outside.invalid/theme.css";')
        with self.assertRaisesRegex(verifier.ArtifactError, 'Nonlocal resource'):
            self.verify()

    def test_existing_quoted_css_import_is_followed(self):
        self.write('assets/main.css', '@import "./theme.css" screen;')
        self.write('assets/theme.css', 'body{color:white}')
        self.assertEqual(self.verify()['referenced_files'], 4)

    def test_missing_favicon_is_rejected(self):
        self.write('index.html', (self.root / 'index.html').read_text()
                   + '<link rel="icon" href="/studio/favicon.svg">')
        with self.assertRaisesRegex(verifier.ArtifactError, 'Missing resource'):
            self.verify()

    def test_escape_is_rejected(self):
        self.write('assets/child.js', 'import "../../outside.js";')
        with self.assertRaisesRegex(verifier.ArtifactError, 'escapes artifact'):
            self.verify()

    def test_missing_bridge_is_rejected(self):
        self.write('assets/index.js', 'import "./child.js";')
        with self.assertRaisesRegex(verifier.ArtifactError, 'native-frame marker'):
            self.verify()


if __name__ == '__main__':
    unittest.main()
