"""Download a user-selected Douyin video with the bundled yt-dlp distribution."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class DownloadError(Exception):
    """A bounded diagnostic safe to display without private media URLs."""


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

    def debug(self, message):
        pass

    def warning(self, message):
        pass

    def error(self, message):
        pass


def download(url, project, *, cookie_file=None, ffprobe=None, factory=None):
    """Publish verified media and a source receipt without replacing existing files."""
    source = resolve_share(normalize_url(url))
    project = Path(project)
    if not project.is_absolute() or not project.is_dir():
        raise DownloadError("Choose an existing absolute project directory.")
    probe = ffprobe or os.environ.get("MUSE_FFPROBE_EXECUTABLE") or os.environ.get("DSH_FFPROBE") or shutil.which("ffprobe")
    if not probe:
        raise DownloadError("The bundled ffprobe executable is required to verify the downloaded video.")
    if cookie_file and not Path(cookie_file).is_file():
        raise DownloadError("The selected local cookie file does not exist.")
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
                info = downloader.extract_info(source, download=True)
                filename = Path(downloader.prepare_filename(info)).resolve()
        except Exception as error:
            message = str(error).lower()
            code = "LOGIN_OR_VERIFICATION_REQUIRED" if any(word in message for word in ("cookie", "login", "captcha", "verify", "verification")) else "DOWNLOAD_FAILED"
            raise DownloadError(code + ": could not retrieve this video. Check the page in your browser; use a user-provided cookie file if requested, or report the missing resource.") from error
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
        return {"status": "downloaded", **record, "receipt": str(receipt)}


def main():
    """Run using Muse's bundled Python; no runtime package installation."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--cookie-file", help="User-provided Netscape cookie file; never pass cookie contents on the command line")
    parser.add_argument("--ffprobe", help="Bundled ffprobe executable path")
    args = parser.parse_args()
    try:
        result = download(args.url, args.project, cookie_file=args.cookie_file, ffprobe=args.ffprobe)
    except DownloadError as error:
        print(json.dumps({"status": "blocked", "message": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
