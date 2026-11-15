"""Check bootstrap secret preservation and private-file validation."""

from pathlib import Path
import tempfile
import unittest

from prepare import environment, prepare, private_json


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        (self.source / "docker").mkdir(parents=True)
        (self.source / "docker/compose.yml").write_text("services: {}\n")
        self.env = self.root / "dtk.env"
        self.admin = self.root / "admin.json"

    def run_prepare(self, port=19580):
        prepare(self.source, self.env, self.admin, port)

    def test_repeated_prepare_preserves_secrets(self):
        self.run_prepare()
        first = (self.env.read_bytes(), self.admin.read_bytes())
        self.run_prepare()
        self.assertEqual(first, (self.env.read_bytes(), self.admin.read_bytes()))
        self.assertEqual(self.env.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.admin.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.source / ".env").resolve(), self.env.resolve())
        with self.assertRaises(FileExistsError):
            private_json(self.admin, {"replacement": True})

    def test_public_environment_is_rejected(self):
        self.run_prepare()
        self.env.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "environment file"):
            self.run_prepare()

    def test_public_administrator_file_is_rejected(self):
        self.run_prepare()
        self.admin.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "administrator file"):
            self.run_prepare()

    def test_wrong_environment_link_is_rejected(self):
        other = self.root / "other.env"
        other.write_text("different\n")
        (self.source / ".env").symlink_to(other)
        with self.assertRaisesRegex(ValueError, "another environment"):
            self.run_prepare()
        self.assertEqual(other.read_text(), "different\n")

    def test_invalid_port_is_rejected_before_files_are_created(self):
        for port in (0, 80, 65536):
            with self.assertRaisesRegex(ValueError, "port"):
                self.run_prepare(port)
            self.assertFalse(self.env.exists())
            with self.assertRaises(ValueError):
                environment(port)


if __name__ == "__main__":
    unittest.main()
