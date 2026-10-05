"""Download a user-selected Douyin video with the bundled yt-dlp distribution."""

import argparse
from copy import copy
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
from urllib.request import HTTPRedirectHandler, HTTPCookieProcessor, Request, build_opener


MOBILE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
MEDIA_DOMAINS = ("douyin.com", "douyinvod.com", "bytecdn.cn", "byteimg.com", "ibytedtos.com", "amemv.com", "snssdk.com")


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
    """Accept only official Douyin and mobile-share domains in the in-memory session."""
    domain = entry.domain.lstrip(".").lower()
    return any(domain == site or domain.endswith("." + site) for site in ("douyin.com", "iesdouyin.com"))


class DouyinCookiePolicy(http.cookiejar.DefaultCookiePolicy):
    """Keep imported and newly received cookies scoped to official Douyin domains."""
    def set_ok(self, cookie, request):
        return douyin_cookie(cookie) and super().set_ok(cookie, request)

    def return_ok(self, cookie, request):
        return douyin_cookie(cookie) and super().return_ok(cookie, request)


def file_fallback_cookie_jar(downloader):
    """Copy the extractor's selected-file cookies without retaining unrelated account domains."""
    try:
        source = downloader.cookiejar
    except Exception:
        raise DownloadError("COOKIE_FILE_UNREADABLE: The selected Netscape Cookie file could not be loaded; export it again from the selected browser.") from None
    jar = http.cookiejar.CookieJar(policy=DouyinCookiePolicy())
    for entry in source:
        if douyin_cookie(entry):
            jar.set_cookie(copy(entry))
    return jar


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


def share_video_data(html, video_id):
    """Read JSON emitted by the official share player without executing scripts."""
    match = re.search(r"(?:window\.)?_ROUTER_DATA\s*=\s*", html)
    if not match:
        raise DownloadError("PUBLIC_SHARE_MEDIA_UNAVAILABLE: The official share page did not expose playable video data.")
    try:
        data, _ = json.JSONDecoder().raw_decode(html[match.end():].lstrip())
        pages = data["loaderData"]
        for page in pages.values():
            if not isinstance(page, dict):
                continue
            info = page.get("videoInfoRes")
            if not isinstance(info, dict):
                continue
            for item in info.get("item_list", []):
                if isinstance(item, dict) and str(item.get("aweme_id")) == video_id:
                    video = item.get("video", {})
                    urls = video.get("play_addr", {}).get("url_list", [])
                    if isinstance(urls, list) and urls:
                        return {"id": video_id, "title": item.get("desc", ""), "urls": [media_url(url) for url in urls]}
    except (ValueError, KeyError, TypeError, AttributeError):
        raise DownloadError("PUBLIC_SHARE_DATA_INVALID: The official share page returned unsupported video data.") from None
    raise DownloadError("PUBLIC_SHARE_MEDIA_UNAVAILABLE: The official share page did not expose this video's playback URL. Open it in the selected browser and complete any required verification.")


def media_url(url):
    """Accept only platform media hosts published by the official share page."""
    if not isinstance(url, str):
        raise DownloadError("The official share page returned an invalid media URL.")
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower()
        valid = (parsed.scheme in {"http", "https"} and not parsed.username and not parsed.password
                 and parsed.port in (None, 80, 443) and any(host == domain or host.endswith("." + domain) for domain in MEDIA_DOMAINS))
    except ValueError:
        valid = False
    if not valid:
        raise DownloadError("The official share page returned an unsupported media host.")
    return url


class MediaRedirect(HTTPRedirectHandler):
    """Keep media redirects inside the platform's public CDN hosts."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        media_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def public_share_media(source, cookiejar=None, timeout=30):
    """Fetch the official mobile share player's bounded server-rendered JSON."""
    video_id = source.rsplit("/", 1)[-1]
    url = f"https://www.iesdouyin.com/share/video/{video_id}/?from_ssr=1"
    handlers = [DouyinRedirect()]
    if cookiejar is not None:
        handlers.append(HTTPCookieProcessor(cookiejar))
    try:
        with build_opener(*handlers).open(Request(url, headers={"User-Agent": MOBILE_USER_AGENT, "Referer": "https://www.douyin.com/"}), timeout=timeout) as response:
            content = response.read(4 * 1024**2 + 1)
        if len(content) > 4 * 1024**2:
            raise DownloadError("The official share page exceeded the supported page size.")
        return share_video_data(content.decode("utf-8"), video_id)
    except DownloadError:
        raise
    except Exception:
        raise DownloadError("PUBLIC_SHARE_REQUEST_FAILED: The official share page could not be read; retry after checking your network and the selected browser.") from None


def download_public_media(info, directory, max_bytes, timeout):
    """Save the player-provided URL unchanged, including any watermark or signature."""
    target = Path(directory) / (info["id"] + ".mp4")
    for url in info["urls"]:
        target.unlink(missing_ok=True)
        try:
            with build_opener(MediaRedirect()).open(Request(media_url(url), headers={"User-Agent": MOBILE_USER_AGENT, "Referer": "https://www.douyin.com/"}), timeout=timeout) as response, target.open("xb") as stream:
                length = response.headers.get("Content-Length")
                if length and int(length) > max_bytes:
                    raise DownloadError("The video exceeded the configured download size limit.")
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > max_bytes:
                        raise DownloadError("The video exceeded the configured download size limit.")
                    stream.write(chunk)
                if total == 0 or (length and total != int(length)):
                    raise DownloadError("The platform media transfer was incomplete.")
            return target
        except DownloadError:
            raise
        except Exception:
            continue
    raise DownloadError("PUBLIC_MEDIA_DOWNLOAD_FAILED: The official playback URLs could not be downloaded.")


def output_directory(project):
    """Reject links in the download directory so publication stays in the workspace."""
    current = project.resolve()
    for part in ("source", "media", "douyin"):
        current = current / part
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            raise DownloadError("Download directories cannot be symbolic links or junctions.")
        current.mkdir(exist_ok=True)
    return current


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
    """Use the selected browser's official Douyin and share-domain cookies in memory."""
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


def download(url, project, *, cookie_file=None, ffprobe=None, ffmpeg=None, factory=None, browser=None,
        browser_profile=None, remember=False, public_only=False, settings_home=None, cookie_extractor=None,
        ssr_loader=None, media_downloader=None, request_timeout=30, max_bytes=2 * 1024**3):
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
    probe = ffprobe or os.environ.get("MUSE_FFPROBE_EXECUTABLE") or os.environ.get("DSH_FFPROBE_PATH") or os.environ.get("FFPROBE_PATH") or os.environ.get("DSH_FFPROBE") or shutil.which("ffprobe")
    if not probe:
        raise DownloadError("The bundled ffprobe executable is required to verify the downloaded video.")
    decoder = ffmpeg or os.environ.get("DSH_FFMPEG_PATH") or os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg")
    if not decoder:
        raise DownloadError("The bundled ffmpeg executable is required to decode the downloaded video.")
    if cookie_file and not Path(cookie_file).is_file():
        raise DownloadError("The selected local cookie file does not exist.")
    if remember:
        remember_browser(settings_home, choice["browser"], choice["profile"])
    cookiejar = browser_cookie_jar(choice, cookie_extractor) if choice else None
    source = resolve_share(source)
    output = output_directory(project)
    live_downloader = factory is None
    factory = factory or bundled_downloader()
    with tempfile.TemporaryDirectory(prefix=".download-", dir=output) as temporary:
        options = {
            "outtmpl": str(Path(temporary) / "%(id)s.%(ext)s"),
            "format": "best[ext=mp4]/best", "noplaylist": True,
            "quiet": True, "noprogress": True, "logger": PrivateLogger(),
            "socket_timeout": request_timeout, "retries": 2, "extractor_retries": 1,
            "max_filesize": max_bytes, "cachedir": False,
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
                try:
                    info = downloader.extract_info(source, download=True)
                    filename = Path(downloader.prepare_filename(info)).resolve()
                except Exception:
                    if cookie_file:
                        cookiejar = file_fallback_cookie_jar(downloader)
                    raise
        except Exception as error:
            if isinstance(error, DownloadError):
                raise
            if live_downloader or ssr_loader is not None:
                loader = ssr_loader or public_share_media
                info = loader(source, cookiejar, request_timeout)
                filename = (media_downloader or download_public_media)(info, temporary, max_bytes, request_timeout).resolve()
            else:
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
            subprocess.run([str(decoder), "-v", "error", "-xerror", "-i", str(filename), "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"],
                           capture_output=True, timeout=max(30, int(duration * 2)), check=True,
                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        except Exception as error:
            raise DownloadError("The downloaded file did not pass the video readability check.") from error
        with filename.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        target = output / filename.name
        receipt = target.with_suffix(target.suffix + ".source.json")
        record = {"source": source, "path": str(target), "bytes": filename.stat().st_size, "full_decode_verified": True,
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
    parser.add_argument("--ffmpeg", help="Bundled ffmpeg executable path")
    parser.add_argument("--settings-home", help="Muse's own settings directory")
    parser.add_argument("--request-timeout", type=int, default=30)
    parser.add_argument("--max-bytes", type=int, default=2 * 1024**3)
    args = parser.parse_args()
    try:
        if args.forget_browser:
            forget_browser(args.settings_home)
            if not args.url and not args.project:
                print(json.dumps({"status": "browser_selection_cleared"}))
                return 0
        if not args.url or not args.project:
            raise DownloadError("Downloads require --url and --project.")
        if not 1 <= args.request_timeout <= 300 or not 1 <= args.max_bytes <= 8 * 1024**3:
            raise DownloadError("Request timeout must be 1–300 seconds and size limit 1 byte–8 GiB.")
        result = download(args.url, args.project, cookie_file=args.cookie_file, ffprobe=args.ffprobe, ffmpeg=args.ffmpeg,
            browser=args.browser, browser_profile=args.browser_profile, remember=args.remember_browser,
            public_only=args.public_only, settings_home=args.settings_home, request_timeout=args.request_timeout, max_bytes=args.max_bytes)
    except DownloadError as error:
        print(json.dumps({"status": "blocked", "message": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
