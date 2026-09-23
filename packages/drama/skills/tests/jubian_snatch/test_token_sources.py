"""Offline authentication-source isolation; all homes and tokens are test-owned."""
import contextlib
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import snatch_fixtures  # noqa: F401
import check_pool_live
import snatch_batch
from snatch_fixtures import FakePool
from snatcher import config


class TokenSources(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.user = self.root / 'user'
        self.product = self.root / 'product'
        self.user.mkdir()
        self.product.mkdir()
        self.env = patch.dict(os.environ, {'DSH_HOME': str(self.product)}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.home = patch.object(Path, 'home', return_value=self.user)
        self.home.start()
        self.addCleanup(self.home.stop)
        # Do not let a legacy CLI's module-global override escape a regression test.
        self.previous = config.__dict__.get('CREDENTIAL_FILES')
        config.__dict__.pop('CREDENTIAL_FILES', None)
        self.addCleanup(self.restore_override)

    def restore_override(self):
        config.__dict__.pop('CREDENTIAL_FILES', None)
        if self.previous is not None:
            config.CREDENTIAL_FILES = self.previous

    def credentials(self, home, token, filename='.credentials.yaml', key='JUBIANAI_ADMIN_TOKEN'):
        home.mkdir(parents=True, exist_ok=True)
        (home / filename).write_text(f'refs:\n  {key}: {token}\n', encoding='utf-8')

    def test_current_product_home_never_falls_back_to_the_other_account(self):
        self.credentials(self.user / '.dsh', 'other-account')
        self.assertEqual(config.prefill_token(), '')
        self.credentials(self.product, 'current-account')
        self.assertEqual(config.prefill_token(), 'current-account')

    def test_canonical_environment_precedes_explicit_legacy_and_files(self):
        self.credentials(self.product, 'file-account')
        os.environ.update(JUBIAN_TOKEN='legacy-explicit', JUBIANAI_ADMIN_TOKEN='canonical-explicit')
        self.assertEqual(config.prefill_token(), 'canonical-explicit')
        del os.environ['JUBIANAI_ADMIN_TOKEN']
        self.assertEqual(config.prefill_token(), 'legacy-explicit')
        del os.environ['JUBIAN_TOKEN']
        self.assertEqual(config.prefill_token(), 'file-account')

    def test_unusable_explicit_canonical_token_does_not_select_a_different_source(self):
        self.credentials(self.product, 'file-account')
        os.environ.update(JUBIANAI_ADMIN_TOKEN='\"\"', JUBIAN_TOKEN='legacy-account')
        self.assertEqual(config.prefill_token(), '')

    def test_no_alternate_account_file_or_reference_is_implicitly_selected(self):
        self.credentials(self.product, 'alternate-account', '.credentials-alt.yaml', 'jubian/token/alt')
        self.credentials(self.product, 'alternate-reference', key='jubian/token/alt')
        self.assertEqual(config.prefill_token(), '')

    def test_legacy_home_is_used_only_when_dsh_home_is_absent_or_empty(self):
        self.credentials(self.user / '.dsh', 'default-home-account')
        for value in (None, ''):
            if value is None:
                os.environ.pop('DSH_HOME', None)
            else:
                os.environ['DSH_HOME'] = value
            self.assertEqual(config.prefill_token(), 'default-home-account')

    def test_explicit_home_does_not_require_resolving_user_home(self):
        self.credentials(self.product, 'product-account')
        with patch.object(Path, 'home', side_effect=RuntimeError('no user home')):
            self.assertEqual(config.prefill_token(), 'product-account')

    def test_missing_or_malformed_current_file_does_not_read_legacy_home(self):
        self.credentials(self.user / '.dsh', 'other-account')
        (self.product / '.credentials.yaml').write_bytes(b'\xff\xfe\x00')
        self.assertEqual(config.prefill_token(), '')

    def test_both_cli_entrypoints_refuse_missing_current_auth_without_requests_or_token_output(self):
        self.credentials(self.user / '.dsh', 'other-account')
        for cli in (check_pool_live, snatch_batch):
            pool = FakePool({})
            output = io.StringIO()
            args = ['--ledger', str(self.root / 'claims.ndjson')]
            if cli is snatch_batch:
                args += ['--log', str(self.root / 'snatch.log')]
            with contextlib.redirect_stdout(output):
                code = cli.main(args, pool=pool)
            self.assertEqual(code, 2)
            self.assertEqual(pool.requests, [])
            self.assertIn('JUBIANAI_ADMIN_TOKEN', output.getvalue())
            self.assertNotIn('other-account', output.getvalue())
            self.assertNotIn('CREDENTIAL_FILES', config.__dict__)


if __name__ == '__main__':
    unittest.main()
