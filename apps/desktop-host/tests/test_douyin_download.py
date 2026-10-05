"""Exercise URL routing, private credentials, and verified local publication."""
import importlib.util
import contextlib
import http.cookiejar
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.request import Request

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


def cookie(domain, value="fixture-private"):
    return http.cookiejar.Cookie(0, "session", value, None, False, domain, True,
        domain.startswith("."), "/", True, True, None, True, None, None, {})


class DownloadTests(unittest.TestCase):
    def setUp(self):
        settings = tempfile.TemporaryDirectory()
        self.addCleanup(settings.cleanup)
        environment = patch.dict(os.environ, {"DSH_HOME": settings.name, "MUSE_HOME": settings.name, "DSH_FFMPEG_PATH": "fixture-decoder"})
        environment.start()
        self.addCleanup(environment.stop)

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

    def test_official_share_json_matches_requested_video_without_changing_playback_url(self):
        playback = "https://aweme.snssdk.com/aweme/v1/playwm/?video_id=public-fixture"
        data = {"loaderData": {"video_(id)/page": {"videoInfoRes": {"item_list": [
            {"aweme_id": "7689044552593788169", "desc": "公开作品", "video": {"play_addr": {"url_list": [playback]}}}
        ]}}}}
        html = "<script>window._ROUTER_DATA = " + json.dumps(data) + ";</script>"
        result = module.share_video_data(html, "7689044552593788169")
        self.assertEqual(result["urls"], [playback])
        with self.assertRaisesRegex(module.DownloadError, "PUBLIC_SHARE_MEDIA_UNAVAILABLE"):
            module.share_video_data(html, "7689044552593788170")
        data["loaderData"]["video_(id)/page"]["videoInfoRes"]["item_list"][0]["video"]["play_addr"]["url_list"] = ["https://127.0.0.1/private"]
        with self.assertRaisesRegex(module.DownloadError, "unsupported media host"):
            module.share_video_data("window._ROUTER_DATA = " + json.dumps(data), "7689044552593788169")

    def test_empty_share_player_is_not_reported_as_downloaded(self):
        with self.assertRaisesRegex(module.DownloadError, "PUBLIC_SHARE_MEDIA_UNAVAILABLE"):
            module.share_video_data('window._ROUTER_DATA = {"loaderData":{"video_(id)/page":{"itemId":"7689044552593788169"}}}', "7689044552593788169")

    def test_extractor_failure_uses_official_share_fallback_and_full_decode_before_publication(self):
        class Rejected(FakeDownloader):
            def extract_info(self, *args, **kwargs):
                raise RuntimeError("Fresh cookies required")
        calls = []
        def save(info, directory, limit, timeout):
            path = Path(directory) / (info["id"] + ".mp4")
            path.write_bytes(b"fallback-video")
            return path
        def verify(argv, **kwargs):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, json.dumps({"format": {"duration": "3.5"}, "streams": [{"codec_type": "video"}]}), "")
        with tempfile.TemporaryDirectory() as directory, patch.object(module.subprocess, "run", side_effect=verify):
            result = module.download("https://www.douyin.com/video/7689044552593788169", directory,
                ffprobe="fixture-probe", factory=Rejected, ssr_loader=lambda *args: {"id": "7689044552593788169", "urls": []}, media_downloader=save)
            self.assertEqual(result["status"], "downloaded")
            self.assertTrue(result["full_decode_verified"])
            self.assertIn("-xerror", calls[-1])
            self.assertNotIn("play", Path(result["receipt"]).read_text())

    def test_decode_failure_keeps_workspace_free_of_unverified_media(self):
        count = 0
        def verify(argv, **kwargs):
            nonlocal count
            count += 1
            if count == 2:
                raise subprocess.CalledProcessError(1, argv)
            return subprocess.CompletedProcess(argv, 0, json.dumps({"format": {"duration": "3.5"}, "streams": [{"codec_type": "video"}]}), "")
        with tempfile.TemporaryDirectory() as directory, patch.object(module.subprocess, "run", side_effect=verify):
            with self.assertRaisesRegex(module.DownloadError, "readability"):
                module.download("https://www.douyin.com/video/7689044552593788169", directory, ffprobe="fixture-probe", factory=FakeDownloader)
            self.assertEqual(list((Path(directory) / "source/media/douyin").iterdir()), [])

    def test_cookie_file_fallback_reuses_only_official_domain_cookies_and_preserves_input(self):
        parent = module.bundled_downloader()
        class Rejected(parent):
            def __init__(self, options):
                super().__init__(options, auto_init=False)
            def extract_info(self, *args, **kwargs):
                raise RuntimeError("Fresh cookies required")
        captured = []
        def load(source, jar, timeout):
            captured.extend(entry.domain for entry in jar)
            for host, expected in [("www.douyin.com", "douyin-fixture-private"), ("www.iesdouyin.com", "share-fixture-private"), ("example.com", None)]:
                request = Request("https://" + host + "/")
                jar.add_cookie_header(request)
                header = request.get_header("Cookie")
                self.assertEqual(header, "session=" + expected if expected else None)
            jar.set_cookie_if_ok(cookie(".example.com"), Request("https://www.example.com/"))
            self.assertEqual(len(jar), 2)
            return {"id": "7689044552593788169", "urls": []}
        def save(info, directory, *args):
            target = Path(directory) / (info["id"] + ".mp4")
            target.write_bytes(b"fallback-video")
            return target
        probe = subprocess.CompletedProcess([], 0, json.dumps({"format": {"duration": "3.5"}, "streams": [{"codec_type": "video"}]}), "")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "selected-cookies.txt"
            original = "# Netscape HTTP Cookie File\n.douyin.com\tTRUE\t/\tTRUE\t2147483647\tsession\tdouyin-fixture-private\n.iesdouyin.com\tTRUE\t/\tTRUE\t2147483647\tsession\tshare-fixture-private\n.example.com\tTRUE\t/\tTRUE\t2147483647\tsession\tunrelated-fixture-private\n.douyin.com.evil.example\tTRUE\t/\tTRUE\t2147483647\tsession\timpostor-fixture-private\n"
            path.write_text(original)
            with patch.object(module.subprocess, "run", return_value=probe), contextlib.redirect_stdout(io.StringIO()) as output:
                result = module.download("https://www.douyin.com/video/7689044552593788169", directory,
                    cookie_file=str(path), ffprobe="fixture-probe", factory=Rejected, ssr_loader=load, media_downloader=save)
            self.assertEqual(captured, [".douyin.com", ".iesdouyin.com"])
            self.assertEqual(result["status"], "downloaded")
            self.assertEqual(result["authentication"], "cookie_file")
            self.assertEqual(path.read_text(), original)
            self.assertEqual(output.getvalue(), "")
            self.assertNotIn("fixture-private", json.dumps(result))
            self.assertNotIn("fixture-private", Path(result["receipt"]).read_text())

    def test_unreadable_cookie_file_does_not_fall_back_without_the_selected_credentials(self):
        class Rejected(FakeDownloader):
            @property
            def cookiejar(self):
                raise ValueError("unreadable fixture-private cookie")
            def extract_info(self, *args, **kwargs):
                raise RuntimeError("Fresh cookies required")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "selected-cookies.txt"
            path.write_text("malformed cookie fixture")
            with self.assertRaisesRegex(module.DownloadError, "COOKIE_FILE_UNREADABLE") as failure:
                module.download("https://www.douyin.com/video/7689044552593788169", directory,
                    cookie_file=str(path), ffprobe="fixture-probe", factory=Rejected,
                    ssr_loader=lambda *args: self.fail("must not replace selected-file authentication with public access"))
            self.assertNotIn("fixture-private", str(failure.exception))
            self.assertEqual(path.read_text(), "malformed cookie fixture")
            self.assertEqual(list((Path(directory) / "source/media/douyin").iterdir()), [])

    def test_selected_browser_fallback_keeps_share_domain_authentication_without_crossing_domains(self):
        class Rejected(FakeDownloader):
            def extract_info(self, *args, **kwargs):
                raise RuntimeError("Fresh cookies required")
        def extract(*args):
            jar = http.cookiejar.CookieJar()
            for domain, value in [(".douyin.com", "douyin-fixture-private"), (".iesdouyin.com", "share-fixture-private"), (".example.com", "unrelated-fixture-private")]:
                jar.set_cookie(cookie(domain, value))
            return jar
        def load(source, jar, timeout):
            self.assertEqual(len(jar), 2)
            request = Request("https://www.iesdouyin.com/")
            jar.add_cookie_header(request)
            self.assertEqual(request.get_header("Cookie"), "session=share-fixture-private")
            raise module.DownloadError("PUBLIC_SHARE_MEDIA_UNAVAILABLE: fixture has no playback")
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(module.DownloadError, "PUBLIC_SHARE_MEDIA_UNAVAILABLE") as failure:
                module.download("https://www.douyin.com/video/7689044552593788169", directory,
                    browser="chrome", browser_profile="Default", ffprobe="fixture-probe", factory=Rejected,
                    cookie_extractor=extract, ssr_loader=load)
            self.assertNotIn("fixture-private", str(failure.exception))
            self.assertEqual(list((Path(directory) / "source/media/douyin").iterdir()), [])

    def test_download_output_does_not_follow_workspace_link(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            try:
                (Path(directory) / "source").symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest("Host cannot create test symlinks")
            with self.assertRaisesRegex(module.DownloadError, "symbolic links"):
                module.download("https://www.douyin.com/video/7689044552593788169", directory, ffprobe="fixture-probe", factory=FakeDownloader)
            self.assertEqual(list(Path(outside).iterdir()), [])

    def test_selected_profile_only_passes_douyin_cookies_to_downloader(self):
        captured = []
        calls = []
        sizes = []
        headers = []
        class Inspected(FakeDownloader):
            def extract_info(self, *args, **kwargs):
                captured.extend((entry.domain, entry.value) for entry in self.cookiejar)
                self.cookiejar.set_cookie_if_ok(cookie(".example.com"), Request("https://www.example.com/"))
                sizes.append(len(self.cookiejar))
                headers.append(self.cookiejar.get_cookie_header("https://www.iesdouyin.com/"))
                headers.append(self.cookiejar.get_cookie_header("https://www.example.com/"))
                return super().extract_info(*args, **kwargs)
        def extract(browser, profile, logger):
            calls.append((browser, profile))
            logger.debug("private-cookie=fixture-private")
            jar = http.cookiejar.CookieJar()
            for domain in [".douyin.com", "www.douyin.com", ".iesdouyin.com", ".example.com", ".douyin.com.evil.example", ".iesdouyin.com.evil.example"]:
                jar.set_cookie(cookie(domain))
            return jar
        probe = subprocess.CompletedProcess([], 0, json.dumps({"format": {"duration": "3.5"}, "streams": [{"codec_type": "video"}]}), "")
        with tempfile.TemporaryDirectory() as directory, patch.object(module.subprocess, "run", return_value=probe), contextlib.redirect_stdout(io.StringIO()) as output:
            result = module.download("https://www.douyin.com/video/7689044552593788169", directory,
                browser="edge", browser_profile="Profile 1", ffprobe="fixture-probe", factory=Inspected,
                cookie_extractor=extract, settings_home=Path(directory) / "settings")
            self.assertEqual(calls, [("edge", "Profile 1")])
            self.assertEqual([domain for domain, _ in captured], [".douyin.com", "www.douyin.com", ".iesdouyin.com"])
            self.assertEqual(sizes, [3])
            self.assertEqual(headers, ["session=fixture-private", None])
            self.assertNotIn("fixture-private", json.dumps(result))
            self.assertEqual(output.getvalue(), "")
            self.assertNotIn("fixture-private", Path(result["receipt"]).read_text())

    def test_choice_reuses_explicit_profile_without_storing_cookie_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module.remember_browser(root, "chrome", "Default")
            self.assertEqual(module.read_browser_selection(root), {"browser": "chrome", "profile": "Default"})
            text = (root / "douyin/browser.json").read_text()
            self.assertEqual(json.loads(text), {"version": 1, "browser": "chrome", "profile": "Default"})
            calls = []
            def extract(browser, profile, logger):
                calls.append((browser, profile))
                jar = http.cookiejar.CookieJar()
                jar.set_cookie(cookie(".douyin.com"))
                return jar
            probe = subprocess.CompletedProcess([], 0, json.dumps({"format": {"duration": "3.5"}, "streams": [{"codec_type": "video"}]}), "")
            with patch.object(module.subprocess, "run", return_value=probe):
                result = module.download("https://www.douyin.com/video/7689044552593788169", root,
                    ffprobe="fixture-probe", factory=FakeDownloader, cookie_extractor=extract, settings_home=root)
            self.assertEqual(calls, [("chrome", "Default")])
            self.assertEqual(result["authentication"], "saved_browser")
            self.assertNotIn("fixture-private", text)
            module.forget_browser(root)
            self.assertIsNone(module.read_browser_selection(root))

    def test_browser_profile_is_required_and_conflicting_auth_is_rejected_before_read(self):
        with tempfile.TemporaryDirectory() as directory:
            for arguments in [{"browser": "chrome"}, {"browser": "edge", "browser_profile": "../other"},
                    {"browser": "edge", "browser_profile": "Default", "cookie_file": "cookies.txt"}]:
                with self.subTest(arguments=arguments), self.assertRaises(module.DownloadError):
                    module.download("https://www.douyin.com/video/7689044552593788169", directory,
                        ffprobe="fixture-probe", factory=FakeDownloader,
                        cookie_extractor=lambda *args: self.fail("must not read a browser"), **arguments)

    def test_public_only_skips_saved_browser(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module.remember_browser(root, "chrome", "Default")
            probe = subprocess.CompletedProcess([], 0, json.dumps({"format": {"duration": "3.5"}, "streams": [{"codec_type": "video"}]}), "")
            with patch.object(module.subprocess, "run", return_value=probe):
                result = module.download("https://www.douyin.com/video/7689044552593788169", root,
                    public_only=True, ffprobe="fixture-probe", factory=FakeDownloader, settings_home=root,
                    cookie_extractor=lambda *args: self.fail("public mode must not read a browser"))
            self.assertEqual(result["authentication"], "public")

    def test_browser_failures_are_bounded_and_do_not_claim_login(self):
        for failure, code in [(PermissionError("locked fixture-private"), "BROWSER_COOKIE_DATABASE_LOCKED"),
                (RuntimeError("App-bound DPAPI fixture-private"), "BROWSER_COOKIE_ENCRYPTION_UNSUPPORTED"),
                (FileNotFoundError("fixture-private"), "BROWSER_PROFILE_NOT_FOUND")]:
            def extract(*args):
                raise failure
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(module.DownloadError) as result:
                    module.download("https://www.douyin.com/video/7689044552593788169", directory,
                        browser="chrome", browser_profile="Default", ffprobe="fixture-probe",
                        factory=FakeDownloader, cookie_extractor=extract, settings_home=directory)
                self.assertIn(code, str(result.exception))
                self.assertNotIn("fixture-private", str(result.exception))

    def test_saved_selection_rejects_unknown_fields_and_does_not_replace_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "douyin/browser.json"
            path.parent.mkdir()
            text = json.dumps({"version": 1, "browser": "chrome", "profile": "Default", "cookie": "fixture-private"})
            path.write_text(text)
            with self.assertRaises(module.DownloadError):
                module.read_browser_selection(root)
            self.assertEqual(path.read_text(), text)
            path.unlink()
            path.mkdir()
            for operation in [lambda: module.remember_browser(root, "chrome", "Default"), lambda: module.forget_browser(root)]:
                with self.assertRaises(module.DownloadError):
                    operation()
            self.assertTrue(path.is_dir())

    def test_decryption_warning_with_empty_jar_is_reported_without_upstream_text(self):
        def extract(browser, profile, logger):
            logger.warning("failed to decrypt DPAPI fixture-private", only_once=True)
            return http.cookiejar.CookieJar()
        with self.assertRaises(module.DownloadError) as result:
            module.browser_cookie_jar({"browser": "chrome", "profile": "Default"}, extract)
        self.assertIn("BROWSER_COOKIE_ENCRYPTION_UNSUPPORTED", str(result.exception))
        self.assertNotIn("fixture-private", str(result.exception))

    def test_bundled_downloader_request_handler_uses_filtered_memory_jar(self):
        parent = module.bundled_downloader()
        handlers = []
        class LocalDownloader(parent):
            def __init__(self, options):
                self.filename = Path(options["outtmpl"]).parent / "7689044552593788169.mp4"
                super().__init__(options, auto_init=False)
            def extract_info(self, *args, **kwargs):
                handler = self._request_director.handlers["Urllib"]
                handlers.append(handler.cookiejar is self.cookiejar)
                self.filename.write_bytes(b"test-video")
                return {"id": "7689044552593788169"}
            def prepare_filename(self, info):
                return str(self.filename)
        def extract(*args):
            jar = http.cookiejar.CookieJar()
            jar.set_cookie(cookie(".douyin.com"))
            return jar
        probe = subprocess.CompletedProcess([], 0, json.dumps({"format": {"duration": "3.5"}, "streams": [{"codec_type": "video"}]}), "")
        with tempfile.TemporaryDirectory() as directory, patch.object(module.subprocess, "run", return_value=probe):
            module.download("https://www.douyin.com/video/7689044552593788169", directory,
                browser="edge", browser_profile="Default", ffprobe="fixture-probe", factory=LocalDownloader,
                cookie_extractor=extract)
        self.assertEqual(handlers, [True])

    def test_remembered_choice_does_not_claim_browser_login_on_empty_cookie_jar(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(module.DownloadError, "login has not been verified"):
                module.download("https://www.douyin.com/video/7689044552593788169", directory,
                    browser="edge", browser_profile="Default", remember=True, ffprobe="fixture-probe",
                    factory=FakeDownloader, cookie_extractor=lambda *args: http.cookiejar.CookieJar(), settings_home=directory)
            self.assertEqual(module.read_browser_selection(directory), {"browser": "edge", "profile": "Default"})

    def test_forget_refuses_symlink_without_touching_its_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "browser-data.json"
            target.write_text("original-browser-data")
            path = root / "douyin/browser.json"
            path.parent.mkdir()
            try:
                path.symlink_to(target)
            except OSError:
                self.skipTest("Host cannot create test symlinks")
            for operation in [lambda: module.remember_browser(root, "chrome", "Default"), lambda: module.forget_browser(root)]:
                with self.assertRaises(module.DownloadError):
                    operation()
            self.assertTrue(path.is_symlink())
            self.assertEqual(target.read_text(), "original-browser-data")


if __name__ == "__main__":
    unittest.main()
