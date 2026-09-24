"""Offline checks for corresponding-source selection and distribution integrity."""
import hashlib
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

SPEC = importlib.util.spec_from_file_location('bgm_bundle', Path(__file__).with_name('build.py'))
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


def locked(path):
    data = Path(path).read_bytes()
    return {'name': Path(path).name, 'url': 'https://example.org/' + Path(path).name,
            'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


class SourceBundleTests(unittest.TestCase):
    def test_refuses_unsafe_names_unpinned_sizes_and_unpinned_checksums(self):
        base = {'name': 'codec.tar.gz', 'url': 'https://example.org/codec.tar.gz', 'bytes': 1, 'sha256': 'a' * 64}
        for item in [{**base, 'name': '../escape'}, {**base, 'name': 'a\\b'},
                     {**base, 'sha256': 'floating'}, {**base, 'bytes': 0},
                     {**base, 'url': 'http://example.org/codec.tar.gz'},
                     {**base, 'url': 'https://user:secret@example.org/codec.tar.gz'}]:
            with self.assertRaises(ValueError):
                build.validate_source(item)
        build.validate_source(base)

    def test_reuses_a_held_copy_only_after_rechecking_its_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            held = root / 'held'
            held.mkdir()
            (held / 'codec.tar.gz').write_bytes(b'real source')
            item = locked(held / 'codec.tar.gz')
            output = root / 'output/codec.tar.gz'
            with patch.object(build, 'read_url') as network:
                build.download(item, output, held)
                network.assert_not_called()
            self.assertEqual(output.read_bytes(), b'real source')
            (held / 'codec.tar.gz').write_bytes(b'tampered!!')
            with patch.object(build, 'read_url') as network:
                with self.assertRaisesRegex(ValueError, 'Retained local copy'):
                    build.download(item, root / 'other/codec.tar.gz', held)
                network.assert_not_called()
            self.assertFalse((root / 'other/codec.tar.gz').exists())

    def test_failed_download_never_publishes_or_retains_partial_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'source.tar.gz'
            item = {'name': path.name, 'url': 'https://example.org/x', 'bytes': 8, 'sha256': 'a' * 64}
            with patch.object(build, 'read_url', return_value=io.BytesIO(b'tampered')):
                with self.assertRaisesRegex(ValueError, 'checksum or size mismatch'):
                    build.download(item, path)
            self.assertFalse(path.exists())
            self.assertFalse(path.with_name(path.name + '.partial').exists())
            path.write_bytes(b'cached corruption')
            with patch.object(build, 'read_url') as network:
                with self.assertRaisesRegex(ValueError, 'Cached source'):
                    build.download(item, path)
                network.assert_not_called()

    def test_accepts_a_source_only_when_it_matches_the_build_tree_in_the_shipped_binary(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'mpg123.tar.bz2'
            path.write_bytes(b'upstream bytes')
            item = locked(path)
            prefix = build.sha512_prefix(path)
            item['build_tree_path'] = f'C:\\vcpkg\\buildtrees\\mpg123\\src\\{prefix}-3db975bc05.clean\\src\\libmpg123\\id3.c'
            build.check_source(item, path, 'Held copy')
            item['build_tree_path'] = 'C:\\vcpkg\\buildtrees\\mpg123\\src\\0000000000-3db975bc05.clean\\src\\libmpg123\\id3.c'
            with self.assertRaisesRegex(ValueError, 'build tree'):
                build.check_source(item, path, 'Held copy')
            item['build_tree_path'] = 'C:\\vcpkg\\buildtrees\\mpg123\\0d8db63f9b.clean'
            with self.assertRaisesRegex(ValueError, 'Unreadable vcpkg build tree path'):
                build.check_source(item, path, 'Held copy')

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

    def test_locked_components_are_pinned_unique_and_use_https(self):
        lock = build.load_lock()
        self.assertEqual(len(lock['components']), len({item['name'] for item in lock['components']}))
        self.assertEqual(len(lock['components']), len({item['id'] for item in lock['components']}))
        for item in lock['components']:
            self.assertTrue(item['url'].startswith('https://'), item['name'])
        prefixes = [build.build_tree_prefix(item) for item in lock['components']]
        self.assertEqual(prefixes.count('0d8db63f9b'), 1)

    def test_lock_refuses_a_component_that_ships_no_license_file_without_a_reason(self):
        item = {'name': 'codec.tar.gz', 'id': 'codec', 'url': 'https://example.org/codec.tar.gz',
                'bytes': 1, 'sha256': 'a' * 64}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'lock.json'
            path.write_text(json.dumps({'version': 1, 'components': [item]}))
            self.assertEqual(len(build.load_lock(path)['components']), 1)
            path.write_text(json.dumps({'version': 1, 'components': [{**item, 'license_files': False}]}))
            with self.assertRaisesRegex(ValueError, 'records no reason'):
                build.load_lock(path)
            path.write_text(json.dumps({'version': 1, 'components': [
                {**item, 'license_files': False, 'license_reason': 'no license file upstream'}]}))
            self.assertEqual(len(build.load_lock(path)['components']), 1)
            path.write_text(json.dumps({'version': 2, 'components': [item]}))
            with self.assertRaisesRegex(ValueError, 'Unsupported lock version'):
                build.load_lock(path)

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
            (root / 'SHA256SUMS').write_text(
                f'{manifest["sha256"]}  {build.ARCHIVE}\n{build.sha256(root / "manifest.json")}  manifest.json\n')
            with self.assertRaisesRegex(ValueError, 'Source archive inventory mismatch'):
                build.verify(root)


if __name__ == '__main__':
    unittest.main()
