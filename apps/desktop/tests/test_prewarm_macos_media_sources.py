"""Exercise raw-source cache acquisition without external requests or product execution."""

import importlib.util
import io
import hashlib
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/prewarm_macos_media_sources.py'
SPEC = importlib.util.spec_from_file_location('prewarm_macos_media_sources', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class MacSourceCacheTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='muse-source-cache-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.cache = self.root / 'downloads'
        self.raw = {resource.filename: f'original {resource.filename}'.encode()
                    for resource in MODULE.current_sources(SCRIPT.parent)}
        self.resources = [MODULE.Resource(name, len(data), hashlib.sha256(data).hexdigest())
                          for name, data in self.raw.items()]

    def archive(self, changes=None, extra=None):
        path = self.root / 'bundle.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, data in self.raw.items():
                if changes is not None and name in changes:
                    data = changes[name]
                if data is None:
                    continue
                member = tarfile.TarInfo(f'source/source-archives/{name}')
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            recipe = b'old recipe must not be installed'
            member = tarfile.TarInfo('source/recipe/prepare-macos-media.ts')
            member.size = len(recipe)
            archive.addfile(member, io.BytesIO(recipe))
            if extra is not None:
                member, data = extra
                archive.addfile(member, io.BytesIO(data) if data is not None else None)
        return path, MODULE.Resource(path.name, path.stat().st_size, hashlib.sha256(path.read_bytes()).hexdigest())

    def run_prewarm(self, **kwargs):
        archive, bundle = self.archive(**kwargs)
        return MODULE.prewarm(archive, self.cache, self.resources, bundle)

    def assert_no_staging(self):
        self.assertEqual(list(self.cache.glob('.mac-source-prewarm-*')), [])

    def test_current_locks_select_seven_unique_originals(self):
        resources = MODULE.current_sources(SCRIPT.parent)
        self.assertEqual(len(resources), 7)
        self.assertEqual(len({resource.filename for resource in resources}), 7)
        self.assertEqual(resources[0].filename, 'ffmpeg-9.0.2.tar.xz')

    def test_raw_caches_and_second_ffmpeg_are_complete_and_repeatable(self):
        result = self.run_prewarm()
        expected = {Path(name): data for name, data in self.raw.items()}
        expected[Path('macos-media') / self.resources[0].filename] = self.raw[self.resources[0].filename]
        actual = {path.relative_to(self.cache): path.read_bytes() for path in self.cache.rglob('*') if path.is_file()}
        self.assertEqual(actual, expected)
        self.assertTrue(result['success'])
        self.assertTrue(all(row['status'] == 'verified-existing' for row in self.run_prewarm()['cacheFiles']))
        self.assert_no_staging()

    def test_outer_corruption_is_rejected_before_cache_creation(self):
        archive, bundle = self.archive()
        data = bytearray(archive.read_bytes())
        data[-1] ^= 1
        archive.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
            MODULE.prewarm(archive, self.cache, self.resources, bundle)
        self.assertFalse(self.cache.exists())

    def test_each_current_lock_and_missing_original_fail_before_publication(self):
        for resource in self.resources:
            with self.subTest(resource=resource.filename):
                with self.assertRaisesRegex(ValueError, 'invalid source member|current source lock mismatch'):
                    self.run_prewarm(changes={resource.filename: b'x' * resource.bytes})
                self.assertFalse(self.cache.exists())
        with self.assertRaisesRegex(ValueError, 'lacks a current locked source'):
            self.run_prewarm(changes={self.resources[-1].filename: None})

    def test_unsafe_paths_links_special_files_and_duplicates_are_rejected(self):
        for name in ['../outside', '/outside', 'source/../outside', 'source\\outside', 'C:/outside']:
            with self.subTest(name=name):
                member = tarfile.TarInfo(name)
                with self.assertRaisesRegex(ValueError, 'unsafe archive member'):
                    self.run_prewarm(extra=(member, b''))
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE]:
            with self.subTest(kind=kind):
                member = tarfile.TarInfo('source/link')
                member.type, member.linkname = kind, '../outside'
                with self.assertRaisesRegex(ValueError, 'links/special files refused'):
                    self.run_prewarm(extra=(member, None))
        member = tarfile.TarInfo(f'source/source-archives/{self.resources[0].filename}')
        with self.assertRaisesRegex(ValueError, 'duplicate archive member'):
            self.run_prewarm(extra=(member, b''))
        self.assertFalse(self.cache.exists())

    def test_mismatched_existing_cache_is_preserved_without_other_publication(self):
        nested = self.cache / 'macos-media'
        nested.mkdir(parents=True)
        conflict = nested / self.resources[0].filename
        conflict.write_bytes(b'foreign cache')
        with self.assertRaisesRegex(ValueError, 'size mismatch'):
            self.run_prewarm()
        self.assertEqual(conflict.read_bytes(), b'foreign cache')
        self.assertEqual([path for path in self.cache.rglob('*') if path.is_file()], [conflict])
        self.assert_no_staging()

    @unittest.skipIf(os.name == 'nt', 'Mac CI cache symlinks use native POSIX permissions')
    def test_existing_file_and_directory_symlinks_are_not_followed(self):
        outside = self.root / 'outside'
        outside.mkdir()
        protected = outside / self.resources[0].filename
        protected.write_bytes(b'unchanged')
        self.cache.mkdir()
        link = self.cache / self.resources[0].filename
        link.symlink_to(protected)
        with self.assertRaisesRegex(ValueError, 'regular file required'):
            self.run_prewarm()
        link.unlink()
        (self.cache / 'macos-media').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'real directory required'):
            self.run_prewarm()
        self.assertEqual(protected.read_bytes(), b'unchanged')

    def test_racing_conflict_keeps_foreign_file_and_rolls_back_owned_files(self):
        link = MODULE.os.link
        conflict = self.cache / 'macos-media' / self.resources[0].filename

        def race(source, destination):
            if destination == conflict:
                destination.write_bytes(b'other writer')
            return link(source, destination)

        with patch.object(MODULE.os, 'link', side_effect=race):
            with self.assertRaisesRegex(ValueError, 'size mismatch'):
                self.run_prewarm()
        self.assertEqual(conflict.read_bytes(), b'other writer')
        self.assertEqual([path for path in self.cache.rglob('*') if path.is_file()], [conflict])
        self.assert_no_staging()

    def test_partial_oversized_or_wrong_download_is_removed(self):
        resource = MODULE.Resource('bundle.tar.gz', 8, hashlib.sha256(b'complete').hexdigest())
        destination = self.root / 'download'

        class Interrupted(io.BytesIO):
            def read(self, size=-1):
                if self.tell():
                    raise OSError('interrupted response')
                return super().read(3)

        for response in [Interrupted(b'complete'), io.BytesIO(b'short'), io.BytesIO(b'oversized'), io.BytesIO(b'corrupt!')]:
            with self.subTest(response=type(response).__name__):
                with self.assertRaises((OSError, ValueError)):
                    MODULE.download_bundle(destination, resource, lambda url, timeout: response)
                self.assertFalse(destination.exists())

    def test_complete_download_is_verified(self):
        resource = MODULE.Resource('bundle.tar.gz', 8, hashlib.sha256(b'complete').hexdigest())
        destination = self.root / 'download'
        MODULE.download_bundle(destination, resource, lambda url, timeout: io.BytesIO(b'complete'))
        self.assertEqual(destination.read_bytes(), b'complete')

    def test_locked_filename_alias_is_rejected_before_outputs(self):
        scripts = self.root / 'locks'
        scripts.mkdir()
        media = json.loads((SCRIPT.parent / 'macos-media-lock.json').read_bytes())
        media['source']['filename'] = '../outside'
        (scripts / 'macos-media-lock.json').write_text(json.dumps(media))
        (scripts / 'macos-subtitle-lock.json').write_bytes((SCRIPT.parent / 'macos-subtitle-lock.json').read_bytes())
        with self.assertRaisesRegex(ValueError, 'unsafe locked filename'):
            MODULE.current_sources(scripts)
        self.assertFalse(self.cache.exists())


if __name__ == '__main__':
    unittest.main()
