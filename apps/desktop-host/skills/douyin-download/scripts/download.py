"""Download a user-selected Douyin video with the bundled yt-dlp distribution."""

import argparse
from datetime import datetime, timezone
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class DownloadError(Exception):
    """A bounded diagnostic safe to display without private media URLs."""


def browser_selection(browser, profile):
    """Require one named browser and profile; never select the newest account."""
    if browser not in {"chrome", "edge", "firefox"}:
        raise DownloadError("Choose --browser chrome, edge, or firefox.")
    if not isinstance(profile, str) or not profile or len(profile) > 1024:
        raise DownloadError("Choose --browser-profile explicitly: Default, Profile 1, or the selected Firefox profile.")
    path = Path(profile)
    if path.is_absolute():
        if not path.is_dir():
            raise DownloadError("The selected browser profile directory does not exist.")
    elif profile in {".", ".."} or not re.fullmatch(r"[\w .-]+", profile):
        raise DownloadError("Browser profile must be one profile name or an existing absolute directory; no traversal or patterns.")
    return {"browser": browser, "profile": profile}


def selection_path(settings_home=None):
    """Locate the device's browser choice without accessing browser credentials."""
    home = Path(settings_home or os.environ.get("DSH_HOME") or os.environ.get("MUSE_HOME") or Path.home() / ".muse")
    if not home.is_absolute():
        raise DownloadError("Muse settings home must be an absolute directory.")
    path = home / "douyin" / "browser.json"
    if path.parent.is_symlink() or (hasattr(path.parent, "is_junction") and path.parent.is_junction()):
        raise DownloadError("Browser selection directory must not be a symbolic link or junction.")
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return path
    except OSError:
        raise DownloadError("Browser selection metadata could not be read; check Muse settings directory permissions.") from None
    if not stat.S_ISREG(mode):
        raise DownloadError("Browser selection must be a regular JSON file, not a link or directory.")
    return path


def read_browser_selection(settings_home=None):
    """Read only validated browser/profile fields, or None when no choice exists."""
    path = selection_path(settings_home)
    try:
        with path.open("r", encoding="utf-8") as stream:
            text = stream.read(4097)
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError):
        raise DownloadError("Browser selection could not be read; fix its permissions or clear the saved choice.") from None
    try:
        value = json.loads(text)
        if len(text) > 4096 or not isinstance(value, dict) or set(value) != {"version", "browser", "profile"} or type(value["version"]) is not int or value["version"] != 1:
            raise ValueError("unsupported browser choice")
        return browser_selection(value["browser"], value["profile"])
    except (TypeError, ValueError):
        raise DownloadError("Browser selection has invalid fields; clear it and choose the browser/profile again.") from None


def remember_browser(settings_home, browser, profile):
    """Atomically save a browser choice, without login status or cookie contents."""
    choice = browser_selection(browser, profile)
    path = selection_path(settings_home)
    if path.exists():
        read_browser_selection(settings_home)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        selection_path(settings_home)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=".browser-", delete=False) as stream:
            staged = Path(stream.name)
            stream.write(json.dumps({"version": 1, **choice}, ensure_ascii=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        try:
            selection_path(settings_home)
            os.replace(staged, path)
        finally:
            staged.unlink(missing_ok=True)
    except OSError:
        raise DownloadError("Browser choice could not be saved; check Muse settings directory permissions.") from None


def forget_browser(settings_home=None):
    """Remove only Muse's regular choice file; leave every browser file intact."""
    path = selection_path(settings_home)
    try:
        path.unlink(missing_ok=True)
    except OSError:
        raise DownloadError("Browser choice could not be cleared; check Muse settings directory permissions.") from None


def douyin_cookie(entry):
    """Accept only Douyin's domain and subdomains in the in-memory session."""
    domain = entry.domain.lstrip(".").lower()
    return domain == "douyin.com" or domain.endswith(".douyin.com")


class DouyinCookiePolicy(http.cookiejar.DefaultCookiePolicy):
    """Keep both imported and newly received cookies scoped to Douyin."""
    def set_ok(self, cookie, request):
        return douyin_cookie(cookie) and super().set_ok(cookie, request)

    def return_ok(self, cookie, request):
        return douyin_cookie(cookie) and super().return_ok(cookie, request)


def normalize_url(value):
    """Accept a single Douyin share URL or canonicalize its video identifier."""
    match = re.search(r"https://[^\s<>]+", value)
    if not match:
        raise DownloadError("Provide a Douyin HTTPS video page or share link.")
    url = match.group().rstrip(".,;，。；）)")
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as error:
        raise DownloadError("The Douyin URL is malformed.") from error
    if (parsed.hostname not in {"www.douyin.com", "douyin.com", "v.douyin.com", "www.iesdouyin.com", "iesdouyin.com"}
            or parsed.username or parsed.password or port not in (None, 443)):
        raise DownloadError("This downloader accepts only Douyin HTTPS links.")
    if parsed.hostname == "v.douyin.com" and re.fullmatch(r"/[A-Za-z0-9_-]+/?", parsed.path):
        return "https://v.douyin.com" + parsed.path
    video = re.search(r"/(?:share/)?video/(\d+)", parsed.path)
    identifiers = parse_qs(parsed.query).get("modal_id", [])
    video_id = video.group(1) if video else identifiers[0] if len(identifiers) == 1 else ""
    if not re.fullmatch(r"\d{10,25}", video_id):
        raise DownloadError("A specific video link is required; a home page is not a video.")
    return "https://www.douyin.com/video/" + video_id


class DouyinRedirect(HTTPRedirectHandler):
    """Follow share redirects only to another supported Douyin URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        normalize_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def resolve_share(url):
    """Resolve a short link without importing browser cookies."""
    if urlsplit(url).hostname != "v.douyin.com":
        return url
    try:
        with build_opener(DouyinRedirect()).open(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=20) as response:
            resolved = normalize_url(response.url)
    except Exception as error:
        raise DownloadError("Share link resolution failed; open it in your browser and provide the final video page.") from error
    if urlsplit(resolved).hostname == "v.douyin.com":
        raise DownloadError("The share link did not resolve to a video page.")
    return resolved


def bundled_downloader():
    """Check the locked archive before importing its maintained extractor."""
    runtime = Path(__file__).resolve().parents[1] / "runtime"
    source = json.loads((runtime / "SOURCE.json").read_text(encoding="utf-8"))
    archive = runtime / "yt-dlp"
    if hashlib.sha256(archive.read_bytes()).hexdigest() != source["sha256"]:
        raise DownloadError("The bundled Douyin downloader is missing or damaged; repair the Muse installation.")
    sys.path.insert(0, str(archive))
    from yt_dlp import YoutubeDL
    return YoutubeDL


class PrivateLogger:
    """Keep extractor logs and signed URLs out of the model transcript."""

    def __init__(self):
        self.cookie_issue = None

    def classify(self, message):
        """Retain an error category, never the upstream message or cookie value."""
        text = str(message).lower()
        if "sqlite3 support" in text:
            self.cookie_issue = "BROWSER_COOKIE_RUNTIME_UNAVAILABLE"
        elif any(word in text for word in ["dpapi", "decrypt", "app-bound", "app bound"]):
            self.cookie_issue = "BROWSER_COOKIE_ENCRYPTION_UNSUPPORTED"
        elif "cookie database" in text or "database is locked" in text:
            self.cookie_issue = "BROWSER_COOKIE_DATABASE_LOCKED"

    def debug(self, message):
        pass

    def info(self, message):
        pass

    def warning(self, message, only_once=False):
        self.classify(message)

    def error(self, message):
        self.classify(message)


def browser_cookie_jar(choice, extractor=None):
    """Use yt-dlp's browser reader, then attach only Douyin cookies in memory."""
    bundled_downloader()
    from yt_dlp.cookies import YoutubeDLCookieJar, extract_cookies_from_browser
    extractor = extractor or extract_cookies_from_browser
    logger = PrivateLogger()
    try:
        source = extractor(choice["browser"], choice["profile"], logger)
    except Exception as error:
        logger.classify(error)
        if isinstance(error, PermissionError):
            logger.cookie_issue = "BROWSER_COOKIE_DATABASE_LOCKED"
        elif isinstance(error, FileNotFoundError):
            logger.cookie_issue = "BROWSER_PROFILE_NOT_FOUND"
        code = logger.cookie_issue or "BROWSER_COOKIE_READ_FAILED"
        raise DownloadError(f"{code}: Could not read the selected browser profile. Close it if the database is locked; unsupported browser encryption requires a user-exported --cookie-file instead.") from None
    jar = YoutubeDLCookieJar(policy=DouyinCookiePolicy())
    for entry in source:
        if douyin_cookie(entry):
            jar.set_cookie(entry)
    source.clear()
    if not len(jar):
        code = logger.cookie_issue or "DOUYIN_BROWSER_COOKIES_MISSING"
        raise DownloadError(f"{code}: No readable Douyin cookies in the selected profile. Open Douyin there and complete login/verification, or use --cookie-file; login has not been verified.")
    return jar


def download(url, project, *, cookie_file=None, ffprobe=None, factory=None, browser=None,
        browser_profile=None, remember=False, public_only=False, settings_home=None, cookie_extractor=None):
    """Publish verified media and a source receipt without replacing existing files."""
    if browser_profile is not None and browser is None:
        raise DownloadError("--browser-profile requires an explicit --browser.")
    if remember and browser is None:
        raise DownloadError("--remember-browser requires an explicit browser/profile choice.")
    if (cookie_file and browser) or (public_only and (cookie_file or browser or remember)):
        raise DownloadError("Choose one authentication source: browser/profile, --cookie-file, or --public-only.")
    choice = browser_selection(browser, browser_profile) if browser else None
    authentication = "browser" if choice else "cookie_file" if cookie_file else "public"
    if choice is None and not cookie_file and not public_only:
        choice = read_browser_selection(settings_home)
        if choice:
            authentication = "saved_browser"
    source = normalize_url(url)
    project = Path(project)
    if not project.is_absolute() or not project.is_dir():
        raise DownloadError("Choose an existing absolute project directory.")
    probe = ffprobe or os.environ.get("MUSE_FFPROBE_EXECUTABLE") or os.environ.get("DSH_FFPROBE") or shutil.which("ffprobe")
    if not probe:
        raise DownloadError("The bundled ffprobe executable is required to verify the downloaded video.")
    if cookie_file and not Path(cookie_file).is_file():
        raise DownloadError("The selected local cookie file does not exist.")
    if remember:
        remember_browser(settings_home, choice["browser"], choice["profile"])
    cookiejar = browser_cookie_jar(choice, cookie_extractor) if choice else None
    source = resolve_share(source)
    output = project / "source" / "media" / "douyin"
    output.mkdir(parents=True, exist_ok=True)
    factory = factory or bundled_downloader()
    with tempfile.TemporaryDirectory(prefix=".download-", dir=output) as temporary:
        options = {
            "outtmpl": str(Path(temporary) / "%(id)s.%(ext)s"),
            "format": "best[ext=mp4]/best", "noplaylist": True,
            "quiet": True, "noprogress": True, "logger": PrivateLogger(),
            "socket_timeout": 30, "retries": 2, "extractor_retries": 1,
            "max_filesize": 2 * 1024**3, "cachedir": False,
            "allowed_extractors": ["douyin"],
        }
        if cookie_file:
            private_cookies = Path(temporary) / "cookies.txt"
            shutil.copyfile(cookie_file, private_cookies)
            options["cookiefile"] = str(private_cookies)
        try:
            with factory(options) as downloader:
                if cookiejar is not None:
                    downloader.cookiejar = cookiejar
                info = downloader.extract_info(source, download=True)
                filename = Path(downloader.prepare_filename(info)).resolve()
        except Exception as error:
            message = str(error).lower()
            code = "LOGIN_OR_VERIFICATION_REQUIRED" if any(word in message for word in ("cookie", "login", "captcha", "verify", "verification")) else "DOWNLOAD_FAILED"
            raise DownloadError(code + ": could not retrieve this video. Check the page in the selected browser/profile; reuse that choice or use a user-provided --cookie-file if required. Login has not been verified.") from None
        if filename.parent != Path(temporary).resolve() or not filename.is_file():
            raise DownloadError("The downloader did not produce a local video file.")
        try:
            process = subprocess.run([str(probe), "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", str(filename)],
                                     capture_output=True, text=True, timeout=30, check=True,
                                     creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            metadata = json.loads(process.stdout)
            duration = float(metadata["format"]["duration"])
            if duration <= 0 or not any(item.get("codec_type") == "video" for item in metadata.get("streams", [])):
                raise ValueError("No readable video stream")
        except Exception as error:
            raise DownloadError("The downloaded file did not pass the video readability check.") from error
        with filename.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        target = output / filename.name
        receipt = target.with_suffix(target.suffix + ".source.json")
        record = {"source": source, "path": str(target), "bytes": filename.stat().st_size,
                  "sha256": digest, "duration_seconds": duration, "retrieved_at": datetime.now(timezone.utc).isoformat()}
        if target.exists() or receipt.exists():
            raise DownloadError("A video or receipt with this ID already exists; inspect the existing files before downloading again.")
        staged_receipt = Path(temporary) / "source.json"
        staged_receipt.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.link(filename, target)
        try:
            os.link(staged_receipt, receipt)
        except Exception:
            target.unlink()
            raise
        return {"status": "downloaded", **record, "receipt": str(receipt), "authentication": authentication}


def main():
    """Run using Muse's bundled Python; no runtime package installation."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url")
    parser.add_argument("--project")
    parser.add_argument("--cookie-file", help="User-provided Netscape cookie file; never pass cookie contents on the command line")
    parser.add_argument("--browser", choices=["chrome", "edge", "firefox"], help="Read only the explicitly selected local browser")
    parser.add_argument("--browser-profile", help="Required with --browser: a profile name or existing absolute directory")
    parser.add_argument("--remember-browser", action="store_true", help="Save only browser/profile choice under Muse home for later reuse")
    parser.add_argument("--public-only", action="store_true", help="Do not read or use a saved browser choice")
    parser.add_argument("--forget-browser", action="store_true", help="Clear only the saved Muse browser choice, not browser cookies")
    parser.add_argument("--ffprobe", help="Bundled ffprobe executable path")
    args = parser.parse_args()
    try:
        if args.forget_browser:
            forget_browser()
            if not args.url and not args.project:
                print(json.dumps({"status": "browser_selection_cleared"}))
                return 0
        if not args.url or not args.project:
            raise DownloadError("Downloads require --url and --project.")
        result = download(args.url, args.project, cookie_file=args.cookie_file, ffprobe=args.ffprobe,
            browser=args.browser, browser_profile=args.browser_profile, remember=args.remember_browser,
            public_only=args.public_only)
    except DownloadError as error:
        print(json.dumps({"status": "blocked", "message": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
