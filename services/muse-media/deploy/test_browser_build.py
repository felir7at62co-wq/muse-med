"""Check pinned browser source and package-mirror generation."""

import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("browser_build", Path(__file__).parent / "build-browser.py")
browser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser)


class BrowserBuildTests(unittest.TestCase):
    def test_mirror_keeps_upstream_unchanged_and_package_signatures_enabled(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / "docker").mkdir()
            original = "FROM python:3.12\n# Chromium's shared-library dependencies\nRUN apt-get update\n"
            file = source / "docker/Dockerfile.browser"
            file.write_text(original)
            pin = {"browserDockerfileSha256": hashlib.sha256(file.read_bytes()).hexdigest()}
            self.assertEqual(browser.dockerfile(source, pin, None), original)
            transformed = browser.dockerfile(source, pin, "https://mirrors.aliyun.com/debian")
            self.assertIn("https://mirrors.aliyun.com/debian", transformed)
            self.assertNotIn("trusted=yes", transformed)
            self.assertNotIn("AllowInsecure", transformed)
            self.assertEqual(file.read_text(), original)
            for mirror in ("http://mirror/debian", "https://user:secret@mirror/debian", "https://mirror/debian';echo injected"):
                with self.assertRaises(ValueError):
                    browser.dockerfile(source, pin, mirror)
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                browser.dockerfile(source, {"browserDockerfileSha256": "different"}, None)


if __name__ == "__main__":
    unittest.main()
