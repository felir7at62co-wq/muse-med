"""Check private deployment inputs and isolated Nginx route updates."""

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


prepare = module("ops_prepare", "prepare.py")
nginx = module("ops_nginx", "nginx.py")
bundler = module("ops_bundle", "bundle.py")


class OpsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.policy = self.root / "policy.json"
        self.policy.write_text(json.dumps({"version": 1, "allowedCompanyIdentities": [], "allowedAccountIds": []}))
        self.policy.chmod(0o600)
        self.key = self.root / "key"
        self.key.write_text("dtk_test-only\n")
        self.key.chmod(0o600)
        self.private = self.root / "private"
        self.state = self.root / "state"

    def prepare(self):
        prepare.prepare(self.policy, self.key, self.private, self.state,
            Path("/var/lib/muse/accounts/accounts.json"), "muse-company-media:test", os.getuid(), os.getgid())

    def test_private_files_and_limits(self):
        self.prepare()
        first_key = (self.private / "dtk-service-key").read_bytes()
        self.prepare()
        self.assertEqual((self.private / "dtk-service-key").read_bytes(), first_key)
        for name in ("media-config.json", "dtk-service-key", "company-policy.json", "compose.env"):
            self.assertEqual((self.private / name).stat().st_mode & 0o777, 0o600)
        config = json.loads((self.private / "media-config.json").read_text())
        self.assertEqual(config["requests_per_minute"], 60)
        self.assertEqual(config["max_downloads_per_day"], 20)
        self.assertEqual(config["max_downloads_global"], 4)
        self.assertNotIn("dtk_test-only", json.dumps(config))

    def test_shared_private_input_is_rejected(self):
        self.key.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "owner-only"):
            self.prepare()
        self.assertFalse(self.private.exists())

    def test_symlink_private_input_is_rejected(self):
        target = self.key.with_name("real-key")
        self.key.rename(target)
        self.key.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "owner-only"):
            self.prepare()

    def test_route_withdrawal_preserves_unrelated_changes(self):
        original = "server {\n" + nginx.ANCHOR + "    location / { proxy_pass http://original; }\n}\n"
        active = nginx.render_site(original, True)
        self.assertEqual(nginx.render_site(active, True), active)
        later = active.replace("http://original", "http://new-owner")
        self.assertEqual(nginx.render_site(later, False), original.replace("http://original", "http://new-owner"))
        with self.assertRaises(ValueError):
            nginx.render_site(original + nginx.ANCHOR, True)

    def test_bad_nginx_candidate_is_restored_without_reload(self):
        site = self.root / "site.conf"
        before = "server {\n" + nginx.ANCHOR + "}\n"
        site.write_text(before)
        include = self.root / "media.conf"
        with patch.object(nginx.subprocess, "run", return_value=SimpleNamespace(returncode=1)) as run:
            with self.assertRaisesRegex(RuntimeError, "previous site restored"):
                nginx.apply(site, include, self.root / "receipt.json", True, nginx.digest(before))
            self.assertEqual(run.call_count, 1)
        self.assertEqual(site.read_text(), before)

    def test_stale_nginx_review_is_rejected_before_write(self):
        site = self.root / "site.conf"
        site.write_text("server {\n" + nginx.ANCHOR + "}\n")
        with self.assertRaisesRegex(ValueError, "changed since review"):
            nginx.apply(site, self.root / "media.conf", self.root / "receipt.json", True, "stale")
        self.assertFalse((self.root / "media.conf").exists())

    def test_bundle_excludes_credentials_and_has_stable_content_hashes(self):
        gateway = self.root / "gateway"
        gateway.mkdir()
        (gateway / "Dockerfile").write_text("FROM scratch\n")
        (gateway / "app.py").write_text("value = 1\n")
        (gateway / ".env").write_text("SECRET=must-not-ship\n")
        (gateway / "policy.candidate.json").write_text('{"private":true}\n')
        (gateway / "policy.example.json").write_text('{"example":true}\n')
        (self.root / "ops").mkdir()
        first = bundler.bundle(self.root, self.root / "first.tar.gz")
        second = bundler.bundle(self.root, self.root / "second.tar.gz")
        self.assertEqual(first["sourceSha256"], second["sourceSha256"])
        self.assertEqual(first["archiveSha256"], second["archiveSha256"])
        self.assertEqual({file["path"] for file in first["files"]}, {"gateway/Dockerfile", "gateway/app.py", "gateway/policy.example.json"})


if __name__ == "__main__":
    unittest.main()
