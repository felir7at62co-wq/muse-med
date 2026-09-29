"""Exercise URL routing, private credentials, and verified local publication."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "skills/douyin-download/scripts/download.py"
spec = importlib.util.spec_from_file_location("douyin_download", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeDownloader:
    def __init__(self, options):
        self.options = options
        self.filename = Path(options["outtmpl"]).parent / "7689044552593788169.mp4"

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def extract_info(self, url, download):
        self.filename.write_bytes(b"test-video")
        if "cookiefile" in self.options:
            Path(self.options["cookiefile"]).write_text("rotated-cookie", encoding="utf-8")
        return {"id": "7689044552593788169"}

    def prepare_filename(self, info):
        return str(self.filename)


class DownloadTests(unittest.TestCase):
    def test_page_variants_and_share_text(self):
        canonical = "https://www.douyin.com/video/7689044552593788169"
        self.assertEqual(module.normalize_url("https://www.douyin.com/jingxuan?modal_id=7689044552593788169"), canonical)
        self.assertEqual(module.normalize_url(canonical + "?tracking=discarded"), canonical)
        self.assertEqual(module.normalize_url("分享 https://v.douyin.com/Ab123/ 看视频"), "https://v.douyin.com/Ab123/")
        self.assertEqual(module.normalize_url("https://www.iesdouyin.com/share/video/7689044552593788169/"), canonical)

    def test_unrelated_destinations_and_missing_video_fail(self):
        for url in ["https://douyin.com.evil.example/video/7689044552593788169", "https://localhost/video/7689044552593788169", "https://www.douyin.com/", "http://www.douyin.com/video/7689044552593788169"]:
            with self.subTest(url=url), self.assertRaises(module.DownloadError):
                module.normalize_url(url)

    def test_bundled_downloader_hash_and_import(self):
        self.assertEqual(module.bundled_downloader().__name__, "YoutubeDL")

    def test_download_keeps_receipt_and_does_not_modify_input_cookie(self):
        with tempfile.TemporaryDirectory() as directory:
            cookie = Path(directory) / "input-cookies.txt"
            cookie.write_text("original-cookie", encoding="utf-8")
            probe = subprocess.CompletedProcess([], 0, json.dumps({"format": {"duration": "3.5"}, "streams": [{"codec_type": "video"}]}), "")
            with patch.object(module.subprocess, "run", return_value=probe):
                result = module.download("https://www.douyin.com/jingxuan?modal_id=7689044552593788169", directory, cookie_file=str(cookie), ffprobe="fixture-probe", factory=FakeDownloader)
                self.assertEqual(result["status"], "downloaded")
                self.assertEqual(cookie.read_text(), "original-cookie")
                receipt = Path(result["receipt"]).read_text(encoding="utf-8")
                self.assertNotIn("cookie", receipt)
                self.assertNotIn("modal_id", receipt)
                self.assertTrue(Path(result["path"]).is_file())
                with self.assertRaisesRegex(module.DownloadError, "already exists"):
                    module.download(result["source"], directory, ffprobe="fixture-probe", factory=FakeDownloader)
                self.assertEqual(Path(result["path"]).read_bytes(), b"test-video")

    def test_unreadable_download_is_not_published(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(module.subprocess, "run", side_effect=ValueError("bad media")):
            with self.assertRaisesRegex(module.DownloadError, "readability"):
                module.download("https://www.douyin.com/video/7689044552593788169", directory, ffprobe="fixture-probe", factory=FakeDownloader)
            self.assertEqual(list((Path(directory) / "source/media/douyin").iterdir()), [])

    def test_auth_failure_does_not_echo_private_extractor_message(self):
        class Rejected(FakeDownloader):
            def extract_info(self, *args, **kwargs):
                raise RuntimeError("fresh cookies required: https://cdn.example/?secret=fixture-private")
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(module.DownloadError) as result:
                module.download("https://www.douyin.com/video/7689044552593788169", directory, ffprobe="fixture-probe", factory=Rejected)
            self.assertIn("LOGIN_OR_VERIFICATION_REQUIRED", str(result.exception))
            self.assertNotIn("fixture-private", str(result.exception))


if __name__ == "__main__":
    unittest.main()
