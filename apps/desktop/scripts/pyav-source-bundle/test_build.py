"""Offline checks for source selection and distribution integrity."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import sys

sys.dont_write_bytecode = True

SPEC = importlib.util.spec_from_file_location('pyav_bundle', Path(__file__).with_name('build.py'))
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


class SourceBundleTests(unittest.TestCase):
    def test_reads_only_literal_source_fields_without_executing_vendor_code(self):
        text = '''raise RuntimeError("must not execute")
x = Package(name="codec", source_url="https://example.org/codec.tar.gz", sha256="%s", build_arguments=unknown())
''' % ('a' * 64)
        self.assertEqual(build.vendor_sources(text), [{
            'name': 'codec.tar.gz', 'url': 'https://example.org/codec.tar.gz', 'sha256': 'a' * 64}])
        with self.assertRaises(ValueError):
            build.vendor_sources('x = Package(name="x", source_url=unknown(), sha256="a")')

    def test_refuses_unsafe_names_and_unpinned_checksums(self):
        for name, digest in [('../escape', 'a' * 64), ('x', 'floating'), ('a\\b', 'a' * 64)]:
            with self.assertRaises(ValueError):
                build.validate_source({'name': name, 'url': 'https://example.org/x', 'sha256': digest})

    def test_retained_patches_match_original_pkgbuild_checksums(self):
        lock = json.loads((build.RECIPE / 'lock.json').read_text())
        for item in lock['additional_sources']:
            if item['name'] not in lock['retained_input_origins']:
                continue
            with tempfile.TemporaryDirectory() as temp, patch.object(build, 'read_url') as network:
                path = Path(temp) / item['name']
                build.download(item, path)
                self.assertEqual(build.sha256(path), item['sha256'])
                network.assert_not_called()

    def test_failed_download_never_publishes_or_retains_partial_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'source.tar.gz'
            item = {'name': path.name, 'url': 'https://example.org/x', 'sha256': 'a' * 64}
            with patch.object(build, 'read_url', return_value=io.BytesIO(b'tampered')):
                with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                    build.download(item, path)
            self.assertFalse(path.exists())
            self.assertFalse(path.with_name(path.name + '.partial').exists())
            path.write_bytes(b'cached corruption')
            with patch.object(build, 'read_url') as network:
                with self.assertRaisesRegex(ValueError, 'Cached source checksum mismatch'):
                    build.download(item, path)
                network.assert_not_called()

    def test_extracts_license_text_without_following_archive_links(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root / 'test.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                info = tarfile.TarInfo('codec/COPYING')
                info.size = 7
                tar.addfile(info, io.BytesIO(b'license'))
            build.collect_licenses(archive, root / 'licenses')
            self.assertEqual((root / 'licenses/codec/COPYING').read_text(), 'license')
            with tarfile.open(archive, 'w:gz') as tar:
                info = tarfile.TarInfo('../COPYING')
                info.size = 7
                tar.addfile(info, io.BytesIO(b'license'))
            with self.assertRaises(ValueError):
                build.collect_licenses(archive, root / 'bad')

    def test_includes_explicit_embedded_header_licenses(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root / 'headers.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                info = tarfile.TarInfo('headers/include/api.h')
                info.size = 7
                tar.addfile(info, io.BytesIO(b'license'))
            with self.assertRaises(ValueError):
                build.collect_licenses(archive, root / 'unnamed')
            build.collect_licenses(archive, root / 'licenses', '.h')
            self.assertEqual((root / 'licenses/headers/include/api.h').read_text(), 'license')

    def test_verification_checks_archive_members_not_just_the_outer_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'source').mkdir()
            (root / 'source/data').write_text('original')
            build.package(root)
            first_digest = build.sha256(root / build.ARCHIVE)
            build.package(root)
            self.assertEqual(build.sha256(root / build.ARCHIVE), first_digest)
            build.verify(root)
            (root / 'source/data').write_text('changed')
            with self.assertRaises(ValueError):
                build.verify(root)
            (root / 'source/data').write_text('original')
            with tarfile.open(root / build.ARCHIVE, 'w:gz') as archive:
                info = tarfile.TarInfo('source/data')
                info.size = 7
                archive.addfile(info, io.BytesIO(b'changed'))
            manifest = json.loads((root / 'manifest.json').read_text())
            manifest['sha256'] = build.sha256(root / build.ARCHIVE)
            (root / 'manifest.json').write_text(json.dumps(manifest))
            (root / 'SHA256SUMS').write_text(f'{manifest["sha256"]}  {build.ARCHIVE}\n{build.sha256(root / "manifest.json")}  manifest.json\n')
            with self.assertRaisesRegex(ValueError, 'Source archive inventory mismatch'):
                build.verify(root)


if __name__ == '__main__':
    unittest.main()
