"""Offline release transfer checks; no credentials, network, or product execution."""
import copy
import importlib.util
import io
import os
from pathlib import Path
import stat
import subprocess
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('transport', Path(__file__).with_name('transport.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)


class TransportTests(unittest.TestCase):
    def test_download_headers_use_each_github_endpoint_media_without_network(self):
        client = t.GitHub('synthetic')
        for path, media in [(f'/repos/{t.REPO}/actions/artifacts/12142398719/zip', 'application/vnd.github+json'),
                            (f'/repos/{t.REPO}/releases/assets/653900001', 'application/octet-stream')]:
            request = client.download_request(path)
            self.assertEqual(request.full_url, 'https://api.github.com' + path)
            self.assertEqual(request.get_header('Accept'), media)
            self.assertEqual(request.get_header('Accept-encoding'), 'identity')
            self.assertEqual(request.get_header('Authorization'), 'Bearer synthetic')
        with self.assertRaises(t.TransportError):
            client.download_request(f'/repos/{t.REPO}/unexpected')

    def test_workflow_shell_passes_the_same_runner_directory_to_both_python_phases(self):
        workflow = Path(__file__).resolve().parents[1] / 'workflows' / 'muse-desktop.yml'
        commands = [line.split('run: ', 1)[1] for line in workflow.read_text().splitlines()
                    if 'run: python3 -B' in line]
        self.assertEqual(len(commands), 2)
        runner = '/tmp/Muse transport runner'
        def arguments(command):
            result = subprocess.run(['bash', '-c', 'python3() { printf "%s\\0" "$@"; }\n' + command],
                                    env={**os.environ, 'RUNNER_TEMP': runner}, check=True, capture_output=True)
            return result.stdout.decode().rstrip('\0').split('\0')
        for command in commands:
            values = arguments(command)
            self.assertEqual(values[values.index('--work-directory') + 1], runner + '/muse-116-transport')
        escaped = commands[0].replace('"$RUNNER_TEMP/muse-116-transport"', '\\"$RUNNER_TEMP/muse-116-transport\\"')
        bad_values = arguments(escaped)
        self.assertNotEqual(bad_values[bad_values.index('--work-directory') + 1], runner + '/muse-116-transport')

    def test_exact_seal_has_twelve_files_and_three_large_binaries(self):
        manifest = t.identity()
        self.assertEqual(len(manifest['assets']), 12)
        self.assertEqual({a['filename'] for a in manifest['assets'] if a['size'] > 1024 * 1024}, t.LARGE)

    def test_native_acceptance_requires_every_smoke_and_same_installer(self):
        target = 'mac-arm64'
        identity = {'sourceCommit': t.SOURCE, 'version': '1.1.6', 'target': target}
        sha = 'a' * 64
        build = {**identity, 'unsigned': True, 'artifacts': {'muse-med-1.1.6-mac-arm64.dmg': {'sha256': sha}}}
        acceptance = {**identity, 'success': True, 'dmgMountedReadOnly': True, 'installerSha256': sha,
            'completeInstalledPayload': {'passed': True, 'comparedFiles': 1},
            'installedRuntimeSmoke': dict.fromkeys(['passed', 'archiveInventory', 'nativePayload', 'packagedHost',
                                                  'productPresetsAndSkills', 'officeConversions', 'teardown'], True)}
        sealed_installer = {'filename': 'muse-med-1.1.6-mac-arm64.dmg', 'sha256': sha}
        t.native_ok(build, acceptance, target, sealed_installer)
        for modify in [lambda a: a.update(sourceCommit='f' * 40),
                       lambda a: a['installedRuntimeSmoke'].update(teardown=False),
                       lambda a: a.update(installerSha256='b' * 64),
                       lambda a: a.pop('installerSha256')]:
            bad = copy.deepcopy(acceptance)
            modify(bad)
            with self.assertRaises(t.TransportError):
                t.native_ok(build, bad, target, sealed_installer)

    def test_native_installer_must_also_match_the_sealed_public_installer(self):
        target = 'win-x64'
        identity = {'sourceCommit': t.SOURCE, 'version': '1.1.6', 'target': target}
        sha = 'a' * 64
        name = 'muse-med-1.1.6-win-x64.exe'
        build = {**identity, 'unsigned': True, 'artifacts': {name: {'sha256': sha}}}
        acceptance = {**identity, 'success': True, 'silentInstallerExecuted': True, 'installerSha256': sha,
            'completeInstalledPayload': {'passed': True, 'comparedFiles': 1},
            'installedRuntimeSmoke': dict.fromkeys(['passed', 'archiveInventory', 'nativePayload', 'packagedHost',
                                                  'productPresetsAndSkills', 'officeConversions', 'teardown'], True)}
        t.native_ok(build, acceptance, target, {'filename': name, 'sha256': sha})
        for sealed in [{'filename': name, 'sha256': 'b' * 64}, {'filename': 'unrelated.exe', 'sha256': sha}]:
            with self.assertRaises(t.TransportError):
                t.native_ok(build, acceptance, target, sealed)

    def test_artifact_is_bound_to_source_run_name_expiration_and_digest(self):
        name = 'muse-win-x64-' + t.SOURCE
        value = {'id': 1, 'name': name, 'expired': False, 'size_in_bytes': 1, 'digest': 'sha256:' + 'a' * 64,
                 'workflow_run': {'id': t.RUN, 'head_sha': t.SOURCE}}
        t.artifact_ok(value, name)
        for bad in [{**value, 'id': 0}, {**value, 'expired': True}, {**value, 'digest': None},
                    {**value, 'workflow_run': {'id': t.RUN - 1, 'head_sha': t.SOURCE}},
                    {**value, 'workflow_run': {'id': t.RUN, 'head_sha': '0' * 40}}]:
            with self.assertRaises(t.TransportError):
                t.artifact_ok(bad, name)

    def test_only_same_source_unpublished_draft_is_usable(self):
        draft = t.DRAFTS[0]
        release = {'tag_name': draft[0], 'id': draft[1], 'prerelease': False, 'draft': True,
                   'published_at': None, 'target_commitish': t.SOURCE}
        t.release_ok(release, draft)
        for key, value in [('draft', False), ('published_at', 'now'), ('target_commitish', 'main'), ('prerelease', True)]:
            with self.assertRaises(t.TransportError):
                t.release_ok({**release, key: value}, draft)

    def test_uploaded_assets_need_full_size_and_exact_sha(self):
        expected = {'filename': 'file.zip', 'size': 5, 'sha256': 'a' * 64}
        asset = {'name': 'file.zip', 'size': 5, 'state': 'uploaded', 'digest': 'sha256:' + 'a' * 64}
        self.assertTrue(t.asset_ok(asset, expected))
        for key, value in [('state', 'starter'), ('size', 0), ('digest', None), ('name', 'other.zip')]:
            self.assertFalse(t.asset_ok({**asset, key: value}, expected))

    def test_signed_resources_cannot_take_auth_to_an_unrelated_origin(self):
        for url in ['https://x.blob.core.windows.net/file?signature=synthetic',
                    'https://release-assets.githubusercontent.com/file?signature=synthetic']:
            self.assertEqual(t.resource_url(url), url)
        for url in ['http://x.blob.core.windows.net/file', 'https://evil.example/file',
                    'https://user:password@release-assets.githubusercontent.com/file',
                    'https://release-assets.githubusercontent.com.evil.example/file']:
            with self.assertRaises(t.TransportError):
                t.resource_url(url)

    def test_acceptance_zip_rejects_path_traversal_and_symlink(self):
        for name, mode in [('../escape', stat.S_IFREG), ('/absolute', stat.S_IFREG),
                           ('muse-installer-acceptance-x/acceptance.json', stat.S_IFLNK)]:
            data = io.BytesIO()
            with zipfile.ZipFile(data, 'w') as archive:
                item = zipfile.ZipInfo(name)
                item.external_attr = mode << 16
                archive.writestr(item, '{}')
            with zipfile.ZipFile(data) as archive, self.assertRaises(t.TransportError):
                t.members(archive, 'win-x64', 'acceptance')

    def test_acceptance_zip_preserves_only_report_and_process_evidence(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w') as archive:
            archive.writestr('muse-installer-acceptance-x/acceptance.json', '{}')
            archive.writestr('muse-installer-acceptance-x/processes/smoke.log', 'ok')
        with zipfile.ZipFile(data) as archive:
            self.assertEqual(len(t.members(archive, 'win-x64', 'acceptance')), 2)

    def test_json_api_cannot_publish_or_change_refs(self):
        client = object.__new__(t.GitHub)
        for path, method in [(f'/repos/{t.REPO}/releases/416563912', 'PATCH'),
                             (f'/repos/{t.REPO}/git/refs/heads/main', 'PATCH'),
                             (f'/repos/{t.REPO}/releases', 'POST')]:
            with self.assertRaises(t.TransportError):
                client.api(path, method)


if __name__ == '__main__':
    unittest.main()
