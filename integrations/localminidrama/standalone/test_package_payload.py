"""Exercise the offline release helper using a minimal checkout and malformed archives."""

from hashlib import sha256
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

from package_payload import build, verify


class PackagePayloadTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.source = self.root / 'upstream'
        for name in (
            'backend-node/package.json',
            'backend-node/package-lock.json',
            'backend-node/src/server.js',
            'backend-node/migrations/001.sql',
            'backend-node/skills/readme.md',
            'frontweb/dist/index.html',
            'backend-node/configs/config.yaml',
        ):
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fixture: ' + name, encoding='utf-8')
        self.payload = self.root / 'release.tgz'

    def test_reproducible_payload_omits_local_configuration_and_verifies_hashes(self):
        result = build(self.source, self.payload)
        self.assertEqual(verify(self.payload, result['sha256']), result)
        self.assertEqual(build(self.source, self.root / 'second.tgz'), result)
        self.assertEqual(result['sha256'], sha256(self.payload.read_bytes()).hexdigest())
        with tarfile.open(self.payload, 'r:gz') as archive:
            self.assertNotIn('backend-node/configs/config.yaml', archive.getnames())
            self.assertIn('backend-node/migrations/001.sql', archive.getnames())

    def test_build_refuses_an_existing_output_and_preserves_it(self):
        self.payload.write_bytes(b'original output')
        with self.assertRaisesRegex(ValueError, 'output_already_exists'):
            build(self.source, self.payload)
        self.assertEqual(self.payload.read_bytes(), b'original output')

    def test_nested_private_file_cannot_enter_the_payload(self):
        (self.source / 'backend-node/src/.env.local').write_text('fixture', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'excluded_payload_path'):
            build(self.source, self.payload)
        self.assertFalse(self.payload.exists())

    def test_missing_frontend_entry_cannot_enter_the_payload(self):
        (self.source / 'frontweb/dist/index.html').unlink()
        with self.assertRaisesRegex(ValueError, 'incomplete_payload_source'):
            build(self.source, self.payload)
        self.assertFalse(self.payload.exists())

    def test_verify_detects_changed_member_even_if_outer_hash_matches(self):
        build(self.source, self.payload)
        changed = self.root / 'changed.tgz'
        with tarfile.open(self.payload, 'r:gz') as original, tarfile.open(changed, 'w:gz') as archive:
            for member in original:
                with original.extractfile(member) as file:
                    content = file.read()
                if member.name == 'frontweb/dist/index.html':
                    content = b'changed'
                    member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
        with self.assertRaisesRegex(ValueError, 'payload_manifest_mismatch'):
            verify(changed, sha256(changed.read_bytes()).hexdigest())

    def test_verify_refuses_wrong_release_checksum(self):
        build(self.source, self.payload)
        with self.assertRaisesRegex(ValueError, 'payload_sha256_mismatch'):
            verify(self.payload, '0' * 64)

    def test_verify_refuses_link_and_traversal_members(self):
        for name, kind, reason in [
            ('frontweb/dist/stolen.js', tarfile.SYMTYPE, 'non_regular_payload_member'),
            ('frontweb/dist/../../stolen.js', tarfile.REGTYPE, 'unsafe_payload_path'),
            ('frontweb/dist/C:stolen.js', tarfile.REGTYPE, 'unsafe_payload_path'),
        ]:
            with self.subTest(name=name):
                with tarfile.open(self.payload, 'w:gz') as archive:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    if kind == tarfile.SYMTYPE:
                        member.linkname = '/tmp/outside.js'
                    archive.addfile(member)
                with self.assertRaisesRegex(ValueError, reason):
                    verify(self.payload)


if __name__ == '__main__':
    unittest.main()
