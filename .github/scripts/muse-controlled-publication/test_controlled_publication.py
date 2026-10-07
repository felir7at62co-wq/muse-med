"""Offline controller checks; do not call GitHub, TOS, upload, tag or publish."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SCRIPT = Path(__file__).with_name('controlled-publication.py')
SPEC = importlib.util.spec_from_file_location('controlled_publication', SCRIPT)
controller = importlib.util.module_from_spec(SPEC)
with patch.dict(os.environ, {'MUSE_CI_TRANSFER_SOURCE_COMMIT': 'f' * 40}):
    SPEC.loader.exec_module(controller)


class ControllerTests(unittest.TestCase):
    def test_draft_tag_endpoint_404_resolves_exact_release_id(self):
        tag = 'v1.0.3'
        draft = {'id': 73, 'tag_name': tag, 'draft': True, 'assets': []}
        with patch.object(controller, 'api', side_effect=[None, [draft], draft]) as remote:
            self.assertEqual(controller.release_for_tag(tag), draft)
            self.assertEqual([call.args[0] for call in remote.call_args_list],
                             ['releases/tags/' + tag, 'releases?per_page=100&page=1', 'releases/73'])

    def test_draft_lookup_rejects_duplicates_absence_and_mismatched_id(self):
        tag = 'v1.0.3'
        draft = {'id': 73, 'tag_name': tag, 'draft': True, 'assets': []}
        for responses in ([None, [draft, {**draft, 'id': 74}]], [None, []],
                          [None, [draft], {**draft, 'id': 74}],
                          [None, [{**draft, 'id': '73'}]],
                          [None, [draft], {**draft, 'tag_name': 'another-tag'}]):
            with patch.object(controller, 'api', side_effect=responses):
                with self.assertRaises(controller.PublicationError):
                    controller.release_for_tag(tag)
        with patch.object(controller, 'api', side_effect=[None, []]):
            self.assertIsNone(controller.release_for_tag(tag, missing=True))

    def test_draft_lookup_pages_exact_tag_and_rejects_cross_page_duplicates(self):
        tag = 'v1.0.3'
        draft = {'id': 73, 'tag_name': tag, 'draft': True, 'assets': []}
        unrelated = [{'id': index + 100, 'tag_name': 'other-' + str(index)} for index in range(100)]
        with patch.object(controller, 'api', side_effect=[None, unrelated, [draft], draft]) as remote:
            self.assertEqual(controller.release_for_tag(tag), draft)
            self.assertEqual(remote.call_args_list[2].args[0], 'releases?per_page=100&page=2')
        with patch.object(controller, 'api', side_effect=[None, [draft, *unrelated[:99]], [draft]]):
            with self.assertRaisesRegex(controller.PublicationError, 'Multiple releases'):
                controller.release_for_tag(tag)
        with patch.object(controller, 'api', side_effect=[None, *[unrelated for _ in range(20)]]) as remote:
            with self.assertRaisesRegex(controller.PublicationError, 'bounded reconciliation'):
                controller.release_for_tag(tag)
            self.assertEqual(remote.call_count, 21)

    def test_source_setting_is_mandatory_and_exact_lowercase_full_commit(self):
        for value in (None, '', 'f' * 39, 'F' * 40, 'g' * 40):
            environment = dict(os.environ)
            environment.pop('MUSE_CI_TRANSFER_SOURCE_COMMIT', None)
            if value is not None:
                environment['MUSE_CI_TRANSFER_SOURCE_COMMIT'] = value
            result = subprocess.run([sys.executable, str(SCRIPT), '--help'], env=environment,
                                    capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('MUSE_CI_TRANSFER_SOURCE_COMMIT', result.stderr)
        result = subprocess.run([sys.executable, str(SCRIPT), '--help'],
                                env={**os.environ, 'MUSE_CI_TRANSFER_SOURCE_COMMIT': 'f' * 40},
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0)

    def test_prepare_without_gate_is_read_only(self):
        with patch.dict(os.environ, {}, clear=True):
            controller.require_authorization('prepare')

    def test_remote_modes_reject_missing_or_non_push_authorization(self):
        authorized = {'MUSE_RELEASE_AUTHORIZATION': controller.AUTHORIZED,
                      'GITHUB_EVENT_NAME': 'push', 'GITHUB_REF': 'refs/heads/' + controller.OPS_BRANCH,
                      'GITHUB_REPOSITORY': controller.REPOSITORY}
        for mode in ('draft', 'publish'):
            for name in authorized:
                wrong = dict(authorized)
                wrong[name] = 'wrong'
                with patch.dict(os.environ, wrong, clear=True), self.assertRaises(controller.PublicationError):
                    controller.require_authorization(mode)
            with patch.dict(os.environ, authorized, clear=True):
                controller.require_authorization(mode)

    def test_exact_job_inventory_includes_real_windows_coverage(self):
        def responses(path, **kwargs):
            if path == 'branches/main':
                return {'commit': {'sha': controller.SOURCE}}
            if path.startswith('actions/artifacts/'):
                artifact = next(item for item in controller.relay.ARTIFACTS if path.endswith(str(item['id'])))
                target = controller.TARGETS[controller.relay.ARTIFACTS.index(artifact)]
                return {'id': artifact['id'], 'name': 'muse-' + target + '-' + controller.SOURCE,
                        'expired': False, 'size_in_bytes': artifact['size'], 'digest': 'sha256:' + artifact['sha256'],
                        'workflow_run': {'id': controller.BUILD_RUN, 'head_sha': controller.SOURCE}}
            build = str(controller.BUILD_RUN) in path
            if '/jobs?' in path:
                count = 2 if build else 16
                jobs = [{'status': 'completed', 'conclusion': 'success'} for _ in range(count)]
                if not build and self.fail_real_coverage:
                    jobs[-1] = {'status': 'in_progress', 'conclusion': None}
                return {'total_count': count, 'jobs': jobs}
            return {'head_sha': controller.SOURCE, 'event': 'workflow_dispatch' if build else 'pull_request',
                    'status': 'completed', 'conclusion': 'success'}
        self.fail_real_coverage = False
        with patch.object(controller, 'api', side_effect=responses), patch.object(controller, 'command', return_value=controller.SOURCE):
            controller.validate_remote_build()
            self.fail_real_coverage = True
            with self.assertRaises(controller.PublicationError):
                controller.validate_remote_build()

    def test_existing_assets_reject_partial_digest_extra_and_duplicate(self):
        file = {'filename': 'one.zip', 'size': 8, 'sha256': 'a' * 64}
        inventory = {'files': [file]}
        asset = {'name': 'one.zip', 'size': 8, 'digest': 'sha256:' + 'a' * 64, 'state': 'uploaded'}
        self.assertEqual(controller.check_assets({'assets': [asset]}, inventory, complete=True), {'one.zip'})
        for assets in ([{**asset, 'state': 'starter'}], [{**asset, 'digest': 'sha256:' + 'b' * 64}],
                       [asset, {**asset, 'name': 'extra.zip'}], [asset, asset], []):
            with self.assertRaises(controller.PublicationError):
                controller.check_assets({'assets': assets}, inventory, complete=True)

    def test_original_archive_accepts_only_flat_exact_members(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'good.zip'
            with zipfile.ZipFile(archive, 'w') as target:
                for name in controller.expected_members('win-x64'):
                    target.writestr(name, b'synthetic-only')
            with patch.dict(controller.BUILD_DIAGNOSTICS, {'win-x64': {
                    'size': len(b'synthetic-only'), 'sha256': controller.hashlib.sha256(b'synthetic-only').hexdigest()}}):
                controller.extract_original(archive, 'win-x64', root / 'good')
            self.assertEqual({entry.name for entry in (root / 'good').iterdir()}, controller.expected_members('win-x64'))
            for index, extra in enumerate(('../outside', 'nested/unsigned-build.json', 'extra.txt')):
                bad = root / ('bad' + str(index) + '.zip')
                with zipfile.ZipFile(bad, 'w') as target:
                    for name in controller.expected_members('win-x64'):
                        target.writestr(name, b'synthetic-only')
                    target.writestr(extra, b'never-extracted')
                with self.assertRaises(controller.PublicationError):
                    controller.extract_original(bad, 'win-x64', root / ('rejected' + str(index)))
                self.assertFalse((root / ('rejected' + str(index))).exists())

    def test_original_builder_diagnostic_has_fixed_bytes_before_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'bad-diagnostic.zip'
            with zipfile.ZipFile(archive, 'w') as target:
                for name in controller.expected_members('win-x64'):
                    target.writestr(name, b'synthetic-only')
            with self.assertRaisesRegex(controller.PublicationError, 'builder diagnostic differs'):
                controller.extract_original(archive, 'win-x64', root / 'rejected')
            self.assertFalse((root / 'rejected').exists())

    def test_no_remote_modes_before_gate(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(controller, 'validate_remote_build') as remote:
            with patch.object(controller.sys, 'argv', ['controlled-publication.py', '--mode', 'publish']):
                with self.assertRaises(controller.PublicationError):
                    controller.main()
            remote.assert_not_called()

    def test_wrong_tag_target_is_never_moved(self):
        with patch.object(controller, 'api', return_value={'object': {'type': 'commit', 'sha': 'b' * 40}}) as remote:
            with self.assertRaises(controller.PublicationError):
                controller.tag_commit('v1.0.3')
            self.assertEqual(remote.call_count, 1)

    def test_tos_success_precedes_stable_then_rc_publication_and_public_readback(self):
        inventory = {'files': [{'filename': 'one.zip', 'size': 8, 'sha256': 'a' * 64}]}
        release = {'assets': [{'name': 'one.zip', 'size': 8, 'digest': 'sha256:' + 'a' * 64, 'state': 'uploaded'}]}
        observed = []
        def node(argv, log):
            observed.append(('node', argv))
        def shell(argv, **kwargs):
            observed.append(('shell', argv))
        with patch.object(controller, 'logged_node', side_effect=node), patch.object(controller, 'command', side_effect=shell):
            with patch.object(controller, 'api', return_value=release):
                controller.publish(Path('/synthetic-only'), inventory, 'runner')
        self.assertIn('publish-muse-tos.mjs', observed[0][1][0])
        self.assertEqual(observed[1][1][-1], '--tos')
        self.assertEqual(observed[2][1][3], 'v1.0.3')
        self.assertEqual(observed[2][1][-1], '--latest')
        self.assertEqual(observed[3][1][3], 'v1.0.3-rc.muse-stable')
        self.assertEqual(observed[3][1][-1], '--latest=false')
        self.assertEqual(len(observed), 6)
        self.assertEqual({item[1][-1] for item in observed[4:]}, set(controller.TAGS))

    def test_tos_full_readback_failure_never_exposes_github_release(self):
        with patch.object(controller, 'logged_node', side_effect=controller.PublicationError('Synthetic public body mismatch')):
            with patch.object(controller, 'command') as write, patch.object(controller, 'api') as remote:
                with self.assertRaises(controller.PublicationError):
                    controller.publish(Path('/synthetic-only'), {'files': []}, 'already-published')
                write.assert_not_called()
                remote.assert_not_called()

    def test_uncertain_upload_response_reconciles_completed_digest_without_retry(self):
        file = {'filename': 'one.zip', 'size': 8, 'sha256': 'a' * 64}
        inventory = {'files': [file], 'output': '/synthetic-only'}
        empty = {'draft': True, 'assets': []}
        completed = {'draft': True, 'assets': [{'name': 'one.zip', 'size': 8,
                     'digest': 'sha256:' + 'a' * 64, 'state': 'uploaded'}]}
        with patch.object(controller, 'tag_commit', return_value=controller.SOURCE):
            with patch.object(controller, 'api', side_effect=[empty, completed, completed, completed]) as remote:
                with patch.object(controller, 'command', side_effect=controller.PublicationError('Synthetic lost upload response')) as upload:
                    controller.upload_draft('v1.0.3', inventory, empty)
                self.assertEqual(upload.call_count, 1)
                self.assertEqual(remote.call_count, 4)


if __name__ == '__main__':
    unittest.main()
