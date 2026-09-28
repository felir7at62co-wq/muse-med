"""Save public HTTPS audio or video bytes in one authorized Muse project."""

import argparse
from datetime import datetime, timezone
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse


class MediaImportError(Exception):
    """A media URL or project output cannot be imported safely."""


def validate_public_https(url):
    """Resolve one public destination that the TLS socket must use."""
    try:
        parsed = urllib.parse.urlsplit(url)
        host = parsed.hostname
        port = parsed.port
    except ValueError as error:
        raise MediaImportError("invalid HTTPS media URL") from error
    if (parsed.scheme != "https" or not host or port not in (None, 443)
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or re.search(r"[\x00-\x20\\]", url)):
        raise MediaImportError("public HTTPS media URL without credentials or query parameters required")
    host = host.rstrip(".").lower()
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise MediaImportError("local media address is not allowed")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        if "." not in host:
            raise MediaImportError("public media host required") from None
        literal = None
    if literal is not None and not literal.is_global:
        raise MediaImportError("public address required")
    try:
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError as error:
        raise MediaImportError("media host could not be resolved") from error
    if not addresses or any(not ipaddress.ip_address(address[4][0]).is_global for address in addresses):
        raise MediaImportError("public address required")
    return host, addresses[0]


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Connect to the validated IP while verifying TLS for the URL hostname."""

    def __init__(self, host, address, timeout):
        super().__init__(host, port=443, timeout=timeout, context=ssl.create_default_context())
        self.checked_address = address

    def connect(self):
        family, kind, protocol, _, destination = self.checked_address
        sock = socket.socket(family, kind, protocol)
        try:
            sock.settimeout(self.timeout)
            sock.connect(destination)
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise


class MediaResponse:
    """Keep one pinned HTTPS connection alive while its media body is read."""

    def __init__(self, connection, response, url):
        self.connection = connection
        self.response = response
        self.headers = response.headers
        self.url = url

    def read(self, count):
        return self.response.read1(count)

    def geturl(self):
        return self.url

    def set_read_timeout(self, seconds):
        self.connection.sock.settimeout(seconds)

    def __enter__(self):
        return self

    def __exit__(self, _type, _value, _traceback):
        self.response.close()
        self.connection.close()


def open_media_url(url, deadline):
    """Follow HTTPS redirects with a new pinned, certificate-checked connection."""
    current = url
    for _ in range(6):
        host, address = validate_public_https(current)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise MediaImportError("media time limit exceeded")
        connection = PinnedHTTPSConnection(host, address, timeout=min(30, remaining))
        parsed = urllib.parse.urlsplit(current)
        try:
            connection.request("GET", parsed.path or "/", headers={
                "User-Agent": "muse-med-media-import/0.1",
                "Accept": "video/*, audio/*, application/octet-stream",
            })
            response = connection.getresponse()
        except BaseException:
            connection.close()
            raise
        if response.status in (301, 302, 303, 307, 308):
            location = response.getheader("Location")
            response.close()
            connection.close()
            if not location:
                raise MediaImportError("media redirect has no destination")
            current = urllib.parse.urljoin(current, location)
            continue
        if response.status != 200:
            response.close()
            connection.close()
            raise MediaImportError(f"media server returned HTTP {response.status}")
        return MediaResponse(connection, response, current)
    raise MediaImportError("too many media redirects")


def media_type(header):
    """Recognize the local media formats consumed by the transcription workflow."""
    if len(header) >= 8 and header[4:8] == b"ftyp":
        return "iso"
    if header.startswith(b"RIFF") and header[8:12] == b"WAVE":
        return "wav"
    if header.startswith(b"ID3") or len(header) >= 2 and header[0] == 0xFF and header[1] & 0xE0 == 0xE0:
        return "mp3"
    if header.startswith(b"fLaC"):
        return "flac"
    if header.startswith(b"OggS"):
        return "ogg"
    if header.startswith(b"\x1a\x45\xdf\xa3"):
        return "webm"
    return None


EXTENSIONS = {
    ".mp4": "iso", ".m4a": "iso", ".mov": "iso", ".wav": "wav",
    ".mp3": "mp3", ".flac": "flac", ".ogg": "ogg", ".webm": "webm",
}

HARD_MAX_BYTES = 2048 * 1024 * 1024
HARD_MAX_SECONDS = 1800


def assert_no_reparse(path):
    """Reject existing symlinks and Windows junctions in the selected path."""
    path = Path(path)
    for part in (*reversed(path.parents), path):
        if part.is_symlink() or part.is_junction():
            raise MediaImportError("project path contains a reparse point")
    if os.path.normcase(os.path.realpath(path)) != os.path.normcase(os.path.abspath(path)):
        raise MediaImportError("project path resolves outside its declared directory")


def output_path(project, filename):
    """Place one new file inside the selected project's source/media directory."""
    root = Path(project)
    if not root.is_absolute() or ".." in root.parts or not root.is_dir():
        raise MediaImportError("absolute authorized project directory must already exist")
    assert_no_reparse(root)
    if (not filename or filename in (".", "..") or re.search(r"[\\/:*?\"<>|\x00-\x1f]", filename)
            or filename.rstrip(". ") != filename or filename.split(".", 1)[0].lower() in
            {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
            or Path(filename).suffix.lower() not in EXTENSIONS):
        raise MediaImportError("safe audio or video filename with a supported extension required")
    source = root / "source"
    media = source / "media"
    assert_no_reparse(source)
    assert_no_reparse(media)
    media.mkdir(parents=True, exist_ok=True)
    assert_no_reparse(media)
    target = media / filename
    if target.exists() or target.is_symlink():
        raise MediaImportError("media output already exists")
    if target.with_name(target.name + ".source.json").exists():
        raise MediaImportError("media source record already exists; reconcile the previous import")
    return target


def import_media(url, project, filename, max_bytes, rights_note, max_seconds=900, run_id=None):
    """Download and publish a checked media file without replacing existing work."""
    if not isinstance(max_bytes, int) or not 0 < max_bytes <= HARD_MAX_BYTES:
        raise MediaImportError("media size limit must be at most 2048 MiB")
    if not isinstance(max_seconds, int) or not 0 < max_seconds <= HARD_MAX_SECONDS:
        raise MediaImportError("media time limit must be at most 1800 seconds")
    if not isinstance(rights_note, str) or not 0 < len(rights_note.strip()) <= 4096:
        raise MediaImportError("source authorization note required")
    if run_id is None:
        run_id = secrets.token_hex(12)
    if not isinstance(run_id, str) or re.fullmatch(r"[a-f0-9]{24}", run_id) is None:
        raise MediaImportError("invalid media import identifier")
    target = output_path(project, filename)
    temp_path = None
    receipt_temp = None
    receipt = target.with_name(target.name + ".source.json")
    deadline = time.monotonic() + max_seconds
    try:
        with open_media_url(url, deadline) as response:
            validate_public_https(response.geturl())
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower().strip()
            if content_type and not (content_type.startswith(("audio/", "video/"))
                                     or content_type in ("application/octet-stream", "application/mp4", "application/ogg")):
                raise MediaImportError("media response required; page or other content returned")
            length = response.headers.get("Content-Length")
            if length is not None and length.isdigit() and int(length) > max_bytes:
                raise MediaImportError("media size limit exceeded")
            with tempfile.NamedTemporaryFile(prefix=f".muse-media-{run_id}-", suffix=".part",
                                             dir=target.parent, delete=False) as output:
                temp_path = Path(output.name)
                assert_no_reparse(target.parent)
                digest = hashlib.sha256()
                total = 0
                header = b""
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise MediaImportError("media time limit exceeded")
                    if hasattr(response, "set_read_timeout"):
                        response.set_read_timeout(min(30, remaining))
                    chunk = response.read(64 * 1024)
                    if time.monotonic() > deadline:
                        raise MediaImportError("media time limit exceeded")
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise MediaImportError("media size limit exceeded")
                    if len(header) < 16:
                        header += chunk[:16 - len(header)]
                    output.write(chunk)
                    digest.update(chunk)
            if total == 0 or media_type(header) != EXTENSIONS[target.suffix.lower()]:
                raise MediaImportError("response is not the requested audio or video format")
        record = {
            "version": 1,
            "status": "pending",
            "source_url": url,
            "authorization": rights_note.strip(),
            "file": filename,
            "bytes": total,
            "sha256": digest.hexdigest(),
            "recorded_at": datetime.now(timezone.utc).isoformat(),
        }
        assert_no_reparse(target.parent)
        with receipt.open("x", encoding="utf-8", newline="\n") as output:
            json.dump(record, output, ensure_ascii=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        try:
            assert_no_reparse(target.parent)
            os.link(temp_path, target)
            assert_no_reparse(target.parent)
        except FileExistsError as error:
            raise MediaImportError("media output already exists") from error
        except OSError as error:
            raise MediaImportError("media could not be published without replacing an existing file") from error
        record["status"] = "ready"
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         prefix=f".muse-receipt-{run_id}-",
                                         suffix=".part", dir=target.parent, delete=False) as output:
            receipt_temp = Path(output.name)
            json.dump(record, output, ensure_ascii=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        assert_no_reparse(target.parent)
        os.replace(receipt_temp, receipt)
        receipt_temp = None
        assert_no_reparse(target.parent)
        return {"path": str(target), "receipt": str(receipt), "bytes": total,
                "sha256": digest.hexdigest(), "content_type": content_type}
    except (urllib.error.URLError, http.client.HTTPException, OSError) as error:
        raise MediaImportError("media download failed; check the direct link and network") from error
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
        if receipt_temp is not None:
            receipt_temp.unlink(missing_ok=True)


def clean_run_parts(directory, run_id):
    """Remove only temporary files created by one supervised import."""
    assert_no_reparse(directory)
    for prefix in (f".muse-media-{run_id}-", f".muse-receipt-{run_id}-"):
        for part in directory.glob(f"{prefix}*.part"):
            part.unlink(missing_ok=True)


def run_supervised_import(url, project, filename, max_bytes, rights_note, max_seconds=900):
    """Stop the worker process when DNS, TLS, headers, or body outlast the deadline."""
    if not isinstance(max_bytes, int) or not 0 < max_bytes <= HARD_MAX_BYTES:
        raise MediaImportError("media size limit must be at most 2048 MiB")
    if not isinstance(max_seconds, int) or not 0 < max_seconds <= HARD_MAX_SECONDS:
        raise MediaImportError("media time limit must be at most 1800 seconds")
    if not isinstance(rights_note, str) or not 0 < len(rights_note.strip()) <= 4096:
        raise MediaImportError("source authorization note required")
    started = time.monotonic()
    target = output_path(project, filename)
    run_id = secrets.token_hex(12)
    request = {"url": url, "project": str(project), "filename": filename, "max_bytes": max_bytes,
               "rights_note": rights_note, "max_seconds": max_seconds, "run_id": run_id}
    try:
        remaining = max_seconds - (time.monotonic() - started)
        if remaining <= 0:
            raise MediaImportError("media time limit exceeded")
        try:
            completed = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve()), "--worker"],
                                       input=json.dumps(request), capture_output=True, text=True, encoding="utf-8",
                                       timeout=remaining, check=False)
        except subprocess.TimeoutExpired as error:
            raise MediaImportError("media time limit exceeded") from error
        if completed.returncode != 0:
            raise MediaImportError("media import worker failed")
        try:
            answer = json.loads(completed.stdout)
        except (ValueError, TypeError) as error:
            raise MediaImportError("media import worker returned an invalid result") from error
        if answer.get("ok") is not True:
            raise MediaImportError(answer.get("error", "media import worker failed"))
        return answer["result"]
    finally:
        clean_run_parts(target.parent, run_id)


def worker_main():
    """Read one private request from the supervising CLI process."""
    request = json.load(sys.stdin)
    try:
        result = import_media(request["url"], request["project"], request["filename"], request["max_bytes"],
                              request["rights_note"], max_seconds=request["max_seconds"], run_id=request["run_id"])
    except MediaImportError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))


def main():
    if sys.argv[1:] == ["--worker"]:
        worker_main()
        return
    parser = argparse.ArgumentParser(description="Import a public HTTPS direct audio or video URL into one Muse project")
    parser.add_argument("--url", required=True, help="Public HTTPS direct media URL without credentials or query parameters")
    parser.add_argument("--project", required=True, type=Path, help="Existing, authorized project directory")
    parser.add_argument("--filename", required=True, help="New media basename with its true extension")
    parser.add_argument("--rights-note", required=True, help="User authorization or license for this source")
    parser.add_argument("--max-mib", type=int, default=2048, help="Maximum download size in MiB (1-2048)")
    parser.add_argument("--max-seconds", type=int, default=900, help="Maximum elapsed time in seconds (1-1800)")
    args = parser.parse_args()
    try:
        result = run_supervised_import(args.url, args.project, args.filename, args.max_mib * 1024 * 1024,
                                       args.rights_note, max_seconds=args.max_seconds)
    except MediaImportError as error:
        parser.exit(1, f"media import: {error}\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
