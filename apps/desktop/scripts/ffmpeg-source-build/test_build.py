"""Keyless checks for pinned source selection and paired release artifacts."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile


class SourceBuildTests(unittest.TestCase):
    def setUp(self):
        module_path = Path(__file__).with_name('build.py')
        self.assertTrue(module_path.is_file(), 'source-preserving FFmpeg builder is required')
        spec = importlib.util.spec_from_file_location('source_build', module_path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory(prefix='muse-ffmpeg-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.lock = self.module.load_lock(Path(__file__).with_name('lock.json'))

    def test_lock_rejects_floating_sources_and_toolchains(self):
        for key, invalid in [('builder_commit', 'master'), ('ffmpeg_commit', 'release/9.0'),
                             ('base_image', 'ghcr.io/btbn/ffmpeg-builds/base:latest'),
                             ('toolchain_image', 'ubuntu:latest')]:
            with self.subTest(key=key):
                bad = {**self.lock, key: invalid}
                path = self.root / 'invalid.json'
                path.write_text(json.dumps(bad), encoding='utf-8')
                with self.assertRaises(ValueError):
                    self.module.load_lock(path)

    def test_selected_downloads_match_generated_dependency_inputs(self):
        builder = self.root / 'builder'
        builder.mkdir()
        (builder / 'Dockerfile').write_text(
            'FROM ghcr.io/btbn/ffmpeg-builds/base-win64:latest AS base-layer\n'
            'ENV SELF="scripts.d/50-x264.sh" STAGENAME="50-x264"\n'
            'RUN --mount=src=scripts.d/50-x264.sh,dst=/stage.sh '
            '--mount=src=.cache/downloads/50-x264_' + 'a' * 64 + '.tar.xz,dst=/cache.tar.xz run_stage /stage.sh\n',
            encoding='utf-8')
        (builder / 'download.sh').write_text('for STAGE in scripts.d/*.sh scripts.d/*/*.sh; do\ntrue\ndone\n'
                                             'docker run "${REGISTRY}/${REPO}/base:latest${DOCKER_TAG_SUFFIX:-}"\n',
                                             encoding='utf-8')
        sources = self.module.pin_generated_inputs(builder, self.lock)
        self.assertEqual(sources, ['50-x264_' + 'a' * 64 + '.tar.xz'])
        self.assertIn(self.lock['toolchain_image'], (builder / 'Dockerfile').read_text())
        self.assertIn('for STAGE in scripts.d/50-x264.sh; do', (builder / 'download.sh').read_text())
        (builder / 'Dockerfile').write_text('FROM unreviewed:latest\n', encoding='utf-8')
        with self.assertRaises(ValueError):
            self.module.pin_generated_inputs(builder, self.lock)

    def test_mingw_guard_accepts_only_the_pinned_priority_zero_constructor(self):
        shell = (Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Git/bin/bash.exe'
                 if os.name == 'nt' else shutil.which('bash'))
        if not shell or not Path(shell).is_file():
            self.skipTest('Bash unavailable; Linux cross-build job runs this check')
        builder = self.root / 'builder'
        stage = builder / 'scripts.d/10-mingw.sh'
        stage.parent.mkdir(parents=True)
        stage.write_text("    sed -zi 's/__constructor__\\s*)/__constructor__(0))/g; t; q1' "
                         "mingw-w64-crt/ssp/stack_chk_guard.c\n", encoding='utf-8')
        self.assertTrue(hasattr(self.module, 'patch_mingw_guard'), 'pinned Mingw source already has priority zero')
        self.module.patch_mingw_guard(builder)
        guard = builder / 'mingw-w64-crt/ssp/stack_chk_guard.c'
        guard.parent.mkdir(parents=True)
        for source, succeeds in [('__attribute__((constructor(0)))\n', True),
                                 ('__attribute__((constructor(1)))\n', False),
                                 ('__attribute__((__constructor__))\n', False)]:
            with self.subTest(source=source):
                guard.write_text(source, encoding='utf-8', newline='\n')
                result = subprocess.run([str(shell), 'scripts.d/10-mingw.sh'], cwd=builder,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
                self.assertEqual(result.returncode == 0, succeeds)
                self.assertEqual(guard.read_text(), source)
        stage.write_text('unexpected upstream script\n', encoding='utf-8')
        with self.assertRaises(ValueError):
            self.module.patch_mingw_guard(builder)

    def test_default_source_download_includes_pinned_recursive_submodules(self):
        builder = self.root / 'builder'
        helper = builder / 'util/dl_functions.sh'
        helper.parent.mkdir(parents=True)
        helper.write_text('default_dl() {\n    echo "git-mini-clone \\"$SCRIPT_REPO\\" \\"$SCRIPT_COMMIT\\" \\"$1\\""\n}\n',
                          encoding='utf-8', newline='\n')
        self.assertTrue(hasattr(self.module, 'patch_submodule_downloads'), 'source caches must contain gitlink dependencies')
        self.module.patch_submodule_downloads(builder)
        shell = (Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Git/bin/bash.exe'
                 if os.name == 'nt' else shutil.which('bash'))
        if not shell or not Path(shell).is_file():
            self.skipTest('Bash unavailable; Linux job exercises generated download commands')
        command = subprocess.check_output([str(shell), '-c',
            'source util/dl_functions.sh; SCRIPT_REPO=https://example.invalid/repo; SCRIPT_COMMIT=abc; default_dl .'],
            cwd=builder, text=True).strip()
        self.assertEqual(command, 'git-mini-clone "https://example.invalid/repo" "abc" "." && '
                         'git -C "." submodule update --init --recursive --depth=1')
        helper.write_text('unexpected upstream script\n', encoding='utf-8')
        with self.assertRaises(ValueError):
            self.module.patch_submodule_downloads(builder)

    def make_inputs(self):
        for relative, content in {
            'builder/README.md': 'builder scripts',
            'builder/patch.diff': 'dependency patch',
            'ffmpeg/COPYING.GPLv3': 'license',
            'ffmpeg/configure': 'source configure',
            'runtime/bin/ffmpeg.exe': 'self built ffmpeg',
            'runtime/bin/ffprobe.exe': 'self built ffprobe',
            'runtime/LICENSE.txt': 'license',
            'evidence/config.log': 'configure and toolchain evidence',
            'builder/.cache/downloads/dep.tar.xz': 'dependency source',
        }.items():
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding='utf-8')
        return self.root / 'builder', self.root / 'ffmpeg', self.root / 'runtime', self.root / 'evidence'

    def test_packages_binary_with_its_actual_sources_and_hashes(self):
        builder, ffmpeg, runtime, evidence = self.make_inputs()
        out = self.root / 'out'
        self.module.package_artifacts(out, builder, ffmpeg, runtime, evidence,
                                      Path(__file__).parent, self.lock, ['dep.tar.xz'])
        manifest = json.loads((out / 'build-manifest.json').read_text())
        self.assertEqual(manifest['inputs'], self.lock)
        for name, digest in manifest['artifacts'].items():
            self.assertEqual(self.module.sha256(out / name), digest)
        with zipfile.ZipFile(out / manifest['binary_archive']) as archive:
            self.assertIn('ffmpeg/bin/ffmpeg.exe', archive.namelist())
            self.assertIn('ffmpeg/LICENSE.txt', archive.namelist())
        with tarfile.open(out / manifest['source_archive']) as archive:
            names = archive.getnames()
            for required in ['source/ffmpeg/configure', 'source/builder/patch.diff',
                             'source/builder/.cache/downloads/dep.tar.xz',
                             'source/evidence/config.log', 'source/recipe/build.py']:
                self.assertIn(required, names)
        self.module.verify_artifacts(out)
        original_manifest = (out / 'build-manifest.json').read_bytes()
        manifest['executables']['ffmpeg.exe'] = '0' * 64
        (out / 'build-manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        with self.assertRaises(ValueError):
            self.module.verify_artifacts(out)
        (out / 'build-manifest.json').write_bytes(original_manifest)
        (out / manifest['binary_archive']).write_bytes(b'tampered')
        with self.assertRaises(ValueError):
            self.module.verify_artifacts(out)

    def test_dependency_licenses_are_bundled_without_extracting_paths(self):
        cache = self.root / 'cache'
        cache.mkdir()
        source = cache / 'lib.tar.xz'
        with tarfile.open(source, 'w:xz') as archive:
            for name in ('./COPYING', './docs/FTL.TXT', '../LICENSE'):
                member = tarfile.TarInfo(name)
                member.size = 7
                archive.addfile(member, io.BytesIO(b'license'))
        runtime = self.root / 'runtime'
        self.module.collect_licenses(cache, ['lib.tar.xz'], runtime)
        self.assertEqual((runtime / 'licenses/lib/COPYING').read_text(), 'license')
        self.assertTrue((runtime / 'licenses/lib/docs/FTL.TXT').is_file())
        self.assertFalse((runtime / 'licenses/LICENSE').exists())
        with tarfile.open(cache / 'empty.tar.xz', 'w:xz'):
            pass
        with self.assertRaises(ValueError):
            self.module.collect_licenses(cache, ['empty.tar.xz'], runtime)

    def link_source(self, alias, target):
        try:
            alias.symlink_to(target)
        except OSError as error:
            if getattr(error, 'winerror', None) == 1314:
                self.skipTest('Windows symlink privilege unavailable; Linux build job runs this check')
            raise

    def test_source_cache_symlink_archives_the_owned_target_bytes(self):
        builder, ffmpeg, runtime, evidence = self.make_inputs()
        alias = builder / '.cache/downloads/dep.tar.xz'
        target = alias.with_name('actual-source.tar.xz')
        alias.rename(target)
        self.link_source(alias, target.name)
        expected_hash = self.module.sha256(target)
        out = self.root / 'out'
        self.module.package_artifacts(out, builder, ffmpeg, runtime, evidence,
                                      Path(__file__).parent, self.lock, ['dep.tar.xz'])
        manifest = json.loads((out / 'build-manifest.json').read_text())
        self.assertEqual(manifest['dependency_sources']['dep.tar.xz'], expected_hash)
        with tarfile.open(out / manifest['source_archive']) as archive:
            member = archive.getmember('source/builder/.cache/downloads/dep.tar.xz')
            self.assertTrue(member.isfile(), 'source bundle must contain bytes, not an unresolved symlink')
            self.assertEqual(archive.extractfile(member).read(), target.read_bytes())

    def test_resolved_source_outside_cache_refuses_packaging_without_link_privileges(self):
        builder, ffmpeg, runtime, evidence = self.make_inputs()
        alias = builder / '.cache/downloads/dep.tar.xz'
        outside = self.root / 'outside-source.tar.xz'
        outside.write_bytes(b'outside cache')
        resolve = Path.resolve
        def resolved(path, *args, **kwargs):
            return outside if path == alias else resolve(path, *args, **kwargs)
        with patch.object(Path, 'resolve', resolved), self.assertRaises(ValueError):
            self.module.package_artifacts(self.root / 'out', builder, ffmpeg, runtime, evidence,
                                          Path(__file__).parent, self.lock, ['dep.tar.xz'])
        self.assertFalse((self.root / 'out').exists())

    def test_source_cache_symlink_outside_cache_refuses_packaging(self):
        builder, ffmpeg, runtime, evidence = self.make_inputs()
        alias = builder / '.cache/downloads/dep.tar.xz'
        alias.unlink()
        outside = self.root / 'outside-source.tar.xz'
        outside.write_bytes(b'outside cache')
        self.link_source(alias, outside)
        with self.assertRaises(ValueError):
            self.module.package_artifacts(self.root / 'out', builder, ffmpeg, runtime, evidence,
                                          Path(__file__).parent, self.lock, ['dep.tar.xz'])
        self.assertFalse((self.root / 'out').exists())

    def test_missing_dependency_source_prevents_packaging(self):
        builder, ffmpeg, runtime, evidence = self.make_inputs()
        with self.assertRaises(FileNotFoundError):
            self.module.package_artifacts(self.root / 'out', builder, ffmpeg, runtime, evidence,
                                          Path(__file__).parent, self.lock, ['missing.tar.xz'])
        self.assertFalse((self.root / 'out' / 'build-manifest.json').exists())


if __name__ == '__main__':
    unittest.main()
