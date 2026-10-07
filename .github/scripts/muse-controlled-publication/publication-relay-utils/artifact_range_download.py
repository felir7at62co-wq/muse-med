#!/usr/bin/env python3
"""Download one authorized GitHub Actions artifact with verified byte ranges."""

from __future__ import annotations

import argparse
import concurrent.futures
import fcntl
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parent
MIB = 1024 * 1024


class DownloadError(Exception):
    """An error whose message contains no credentials or signed URLs."""


class ProtocolError(DownloadError):
    """The server did not return the required bytes or metadata."""


class RetryableError(DownloadError):
    """A network failure or retryable HTTP response."""


class ExpiredUrl(RetryableError):
    """The CDN rejected the current signed URL."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Expose redirects so API authorization never follows a CDN redirect."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def make_opener(proxy: str | None, ca_file: str | None):
    """Build a TLS-verified client with an explicit proxy policy."""
    context = ssl.create_default_context(cafile=ca_file)
    proxies = {"http": proxy, "https": proxy} if proxy else {}
    return urllib.request.build_opener(
        urllib.request.ProxyHandler(proxies),
        urllib.request.HTTPSHandler(context=context),
        NoRedirect(),
    )


def require_digest(value):
    """Return the archive SHA-256 or reject unavailable artifact digests."""
    if not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
        raise ProtocolError("GitHub artifact metadata has no valid SHA-256 digest")
    return value[7:]


def validate_range(status, headers, start, end, total, expected_etag=None):
    """Require exact partial-response fields and a stable strong ETag."""
    if status != 206:
        raise ProtocolError(f"Range request returned HTTP {status}; required 206")
    expected = f"bytes {start}-{end}/{total}"
    if headers.get("Content-Range") != expected:
        raise ProtocolError("Range response has incorrect Content-Range")
    length = headers.get("Content-Length")
    if length is not None and length != str(end - start + 1):
        raise ProtocolError("Range response has incorrect Content-Length")
    if headers.get("Content-Encoding", "identity").lower() != "identity":
        raise ProtocolError("Range response has unexpected Content-Encoding")
    etag = headers.get("ETag")
    if not isinstance(etag, str) or not re.fullmatch(r'"[\x21\x23-\x7e]{1,1022}"', etag):
        raise ProtocolError("Range response lacks a strong ETag")
    if expected_etag is not None and etag != expected_etag:
        raise ProtocolError("Range response ETag changed")
    return etag


def sha256_file(path):
    """Hash the exact file bytes without loading the archive in memory."""
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(8 * MIB):
            digest.update(block)
    return digest.hexdigest()


def verify_archive(path, size, digest):
    """Reject an archive unless both GitHub's size and SHA-256 match."""
    if path.stat().st_size != size:
        raise ProtocolError("Complete ZIP has incorrect size")
    if sha256_file(path) != digest:
        raise ProtocolError("Complete ZIP SHA-256 does not match GitHub metadata")


class GitHubArchive:
    """Keep API credentials and refreshable CDN URLs only in process memory."""

    def __init__(self, repository, artifact_id, proxy, ca_file, timeout):
        result = subprocess.run(
            ["gh", "auth", "token", "--hostname", "github.com"],
            capture_output=True, text=True, check=False,
        )
        if result.returncode or not result.stdout.strip():
            raise DownloadError("Unable to obtain the configured GitHub credential")
        self._token = result.stdout.strip()
        self._base = f"https://api.github.com/repos/{repository}/actions/artifacts/{artifact_id}"
        self._opener = make_opener(proxy, ca_file)
        self._timeout = timeout
        self._lock = threading.Lock()
        self._url = None
        self._generation = 0

    def _request(self, suffix=""):
        return urllib.request.Request(self._base + suffix, headers={
            "Authorization": "Bearer " + self._token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "muse-private-artifact-downloader",
        })

    def metadata(self):
        """Fetch metadata exclusively from api.github.com."""
        try:
            with self._opener.open(self._request(), timeout=self._timeout) as response:
                if response.status != 200:
                    raise ProtocolError("GitHub metadata response is not HTTP 200")
                body = response.read(2 * MIB + 1)
            if len(body) > 2 * MIB:
                raise ProtocolError("GitHub metadata response is too large")
            result = json.loads(body)
            if not isinstance(result, dict):
                raise ProtocolError("GitHub metadata is not an object")
            return result
        except urllib.error.HTTPError as error:
            raise DownloadError(f"GitHub metadata request returned HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise DownloadError("GitHub metadata request failed; check network and TLS trust") from None
        except (ValueError, UnicodeDecodeError):
            raise ProtocolError("GitHub metadata is not valid JSON") from None

    def _redirect_url(self):
        try:
            with self._opener.open(self._request("/zip"), timeout=self._timeout):
                raise ProtocolError("GitHub archive API did not return a redirect")
        except urllib.error.HTTPError as error:
            if error.code != 302:
                raise DownloadError(f"GitHub archive request returned HTTP {error.code}") from None
            url = error.headers.get("Location", "")
            parsed = urllib.parse.urlsplit(url)
            if (parsed.scheme != "https" or not parsed.hostname or parsed.username
                    or parsed.password or parsed.fragment or parsed.port not in (None, 443)):
                raise ProtocolError("GitHub returned an invalid HTTPS archive redirect")
            return url
        except (urllib.error.URLError, TimeoutError, OSError):
            raise DownloadError("GitHub archive redirect request failed") from None

    def signed_url(self):
        """Obtain the current signed URL; never expose it to logs or disk."""
        with self._lock:
            if self._url is None:
                self._url = self._redirect_url()
            return self._url, self._generation

    def refresh(self, rejected_generation):
        """Refresh once for a group of workers that rejected the same URL."""
        with self._lock:
            if rejected_generation == self._generation:
                self._url = self._redirect_url()
                self._generation += 1


def fetch_chunk(archive, opener, directory, index, start, end, total, etag, timeout):
    """Save only a complete validated 206 response, without API authorization."""
    url, generation = archive.signed_url()
    headers = {"Range": f"bytes={start}-{end}", "Accept-Encoding": "identity",
               "User-Agent": "muse-private-artifact-downloader"}
    if etag is not None:
        headers["If-Match"] = etag
    # This request is built independently; API Authorization is never copied.
    request = urllib.request.Request(url, headers=headers)
    temporary = directory / f"{index:06d}.partial.{os.getpid()}.{threading.get_ident()}"
    destination = directory / f"{index:06d}.chunk"
    expected_size = end - start + 1
    try:
        with opener.open(request, timeout=timeout) as response:
            response_etag = validate_range(response.status, response.headers, start, end, total, etag)
            digest = hashlib.sha256()
            length = 0
            with temporary.open("wb") as target:
                os.fchmod(target.fileno(), 0o600)
                while block := response.read(min(MIB, expected_size - length + 1)):
                    length += len(block)
                    if length > expected_size:
                        raise ProtocolError("Range response contains extra bytes")
                    target.write(block)
                    digest.update(block)
                target.flush()
                os.fsync(target.fileno())
            if length != expected_size:
                raise RetryableError("Range response ended before the requested bytes arrived")
        os.replace(temporary, destination)
        return response_etag, digest.hexdigest()
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            archive.refresh(generation)
            raise ExpiredUrl("CDN rejected the signed URL; refreshed it") from None
        if error.code == 429 or 500 <= error.code <= 599:
            raise RetryableError(f"CDN returned HTTP {error.code}") from None
        raise ProtocolError(f"CDN returned HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as error:
        raise RetryableError(f"Range transfer failed ({type(error).__name__})") from None
    finally:
        temporary.unlink(missing_ok=True)


class Downloader:
    """Resume verified chunks and publish a file only after full ZIP verification."""

    def __init__(self, archive, opener, output, identity, chunk_size, concurrency, retries, timeout):
        self.archive, self.opener, self.output = archive, opener, output
        self.identity = {**identity, "chunk_size": chunk_size}
        self.chunk_size, self.concurrency = chunk_size, concurrency
        self.retries, self.timeout = retries, timeout
        self.directory = output.with_name(output.name + ".chunks")
        self.manifest_path = self.directory / "manifest.json"
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.state = {"identity": self.identity, "etag": None, "chunks": {}}
        self.completed_bytes = 0
        self.started = time.monotonic()
        self.last_report = 0.0

    def _save(self):
        temporary = self.directory / "manifest.json.tmp"
        with temporary.open("w", encoding="utf-8") as target:
            os.fchmod(target.fileno(), 0o600)
            json.dump(self.state, target, sort_keys=True)
            target.write("\n")
        os.replace(temporary, self.manifest_path)

    def _record(self, index, etag, digest, length):
        with self.lock:
            self.state["etag"] = etag
            self.state["chunks"][str(index)] = digest
            self.completed_bytes += length
            self._save()
            now = time.monotonic()
            if now - self.last_report >= 5:
                elapsed = now - self.started
                print(f"progress {self.completed_bytes}/{self.identity['size']} bytes; "
                      f"{self.completed_bytes / max(elapsed, 0.001) / MIB:.2f} MiB/s", flush=True)
                self.last_report = now

    def _transfer(self, index):
        start = index * self.chunk_size
        end = min(start + self.chunk_size, self.identity["size"]) - 1
        for attempt in range(self.retries + 1):
            if self.stop.is_set():
                raise DownloadError("Download cancelled after another worker failed")
            try:
                etag, digest = fetch_chunk(self.archive, self.opener, self.directory,
                    index, start, end, self.identity["size"], self.state["etag"], self.timeout)
                self._record(index, etag, digest, end - start + 1)
                return
            except RetryableError as error:
                if attempt == self.retries:
                    raise DownloadError(f"Chunk {index} exhausted retries: {error}") from None
                print(f"retry chunk {index} attempt {attempt + 1}: {error}", flush=True)
                if self.stop.wait(min(2 ** attempt, 20)):
                    raise DownloadError("Download cancelled after another worker failed")

    def run(self, keep_chunks=False):
        """Download and verify the requested artifact, preserving valid chunks on failure."""
        if self.output.exists():
            verify_archive(self.output, self.identity["size"], self.identity["sha256"])
            print("Existing ZIP verified against GitHub metadata", flush=True)
            return
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.manifest_path.exists():
            try:
                state = json.loads(self.manifest_path.read_text(encoding="utf-8"))
            except (ValueError, UnicodeDecodeError):
                raise DownloadError("Invalid chunk manifest; move it aside before restarting") from None
            if not isinstance(state, dict) or state.get("identity") != self.identity:
                raise DownloadError("Chunk manifest does not match this artifact and chunk size")
            if not isinstance(state.get("chunks"), dict):
                raise DownloadError("Invalid chunk manifest entries")
            if state.get("etag") is not None:
                validate_range(206, {"Content-Range": "bytes 0-0/1", "ETag": state["etag"]}, 0, 0, 1)
            self.state = state
        count = math.ceil(self.identity["size"] / self.chunk_size)
        pending = []
        for index in range(count):
            path = self.directory / f"{index:06d}.chunk"
            length = min(self.chunk_size, self.identity["size"] - index * self.chunk_size)
            digest = self.state["chunks"].get(str(index))
            if (path.exists() and path.stat().st_size == length and isinstance(digest, str)
                    and re.fullmatch(r"[0-9a-f]{64}", digest) and sha256_file(path) == digest):
                self.completed_bytes += length
            else:
                self.state["chunks"].pop(str(index), None)
                pending.append(index)
        self._save()
        print(f"artifact {self.identity['artifact_id']}; {self.identity['size']} bytes; "
              f"{len(pending)}/{count} chunks pending; concurrency {self.concurrency}", flush=True)
        if pending and self.state["etag"] is None:
            self._transfer(pending.pop(0))
        with concurrent.futures.ThreadPoolExecutor(max_workers=self.concurrency) as pool:
            futures = [pool.submit(self._transfer, index) for index in pending]
            try:
                for future in concurrent.futures.as_completed(futures):
                    future.result()
            except BaseException:
                self.stop.set()
                for future in futures:
                    future.cancel()
                raise
        assembling = self.output.with_name(self.output.name + ".assembling")
        try:
            print("Assembling ZIP and verifying complete SHA-256", flush=True)
            with assembling.open("wb") as target:
                os.fchmod(target.fileno(), 0o600)
                for index in range(count):
                    with (self.directory / f"{index:06d}.chunk").open("rb") as source:
                        shutil.copyfileobj(source, target, 8 * MIB)
                target.flush()
                os.fsync(target.fileno())
            verify_archive(assembling, self.identity["size"], self.identity["sha256"])
            os.replace(assembling, self.output)
        finally:
            assembling.unlink(missing_ok=True)
        if not keep_chunks:
            shutil.rmtree(self.directory)
        print(json.dumps({"verified": True, "artifact_id": self.identity["artifact_id"],
                          "bytes": self.identity["size"], "sha256": self.identity["sha256"],
                          "output": str(self.output)}), flush=True)


def parse_args():
    """Expose bounded concurrency, explicit networking, and source expectations."""
    parser = argparse.ArgumentParser(description=__doc__, epilog=
        "Uses the configured gh credential only for api.github.com. Signed CDN URLs "
        "stay in memory, and CDN requests never receive Authorization. Cached chunks "
        "are rehashed on resume. Final ZIP requires GitHub's exact size and SHA-256. "
        "Outputs must remain under this utility's private artifact directory.")
    parser.add_argument("--repository", required=True, help="GitHub owner/repository")
    parser.add_argument("--artifact-id", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-head", help="Require the artifact workflow's commit SHA")
    parser.add_argument("--expected-size", type=int)
    parser.add_argument("--expected-digest", help="Expected sha256:HEX from artifact metadata")
    parser.add_argument("--concurrency", type=int, default=16, help="1–16 workers (default: 16)")
    parser.add_argument("--chunk-size-mib", type=int, default=4, help="1–64 MiB per chunk (default: 4)")
    parser.add_argument("--retries", type=int, default=5, help="Retries per chunk (default: 5)")
    parser.add_argument("--timeout", type=int, default=90, help="Socket timeout seconds (default: 90)")
    parser.add_argument("--proxy", help="Explicit HTTP(S) proxy; omitted means direct, ignoring env proxies")
    default_ca = "/etc/ssl/cert.pem" if Path("/etc/ssl/cert.pem").is_file() else None
    parser.add_argument("--ca-file", default=default_ca, help="TLS CA bundle (system bundle by default)")
    parser.add_argument("--keep-chunks", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository):
        parser.error("--repository must be owner/repository")
    if args.artifact_id <= 0 or not 1 <= args.concurrency <= 16 or not 1 <= args.chunk_size_mib <= 64:
        parser.error("artifact ID must be positive; concurrency 1–16; chunk size 1–64 MiB")
    if not 0 <= args.retries <= 20 or not 1 <= args.timeout <= 600:
        parser.error("retries must be 0–20 and timeout 1–600 seconds")
    if args.expected_head and not re.fullmatch(r"[0-9a-f]{40}", args.expected_head):
        parser.error("--expected-head must be a complete lowercase Git commit SHA")
    if args.proxy:
        proxy = urllib.parse.urlsplit(args.proxy)
        if proxy.scheme not in ("http", "https") or not proxy.hostname or proxy.username or proxy.password:
            parser.error("--proxy must be an HTTP(S) URL without credentials")
    args.output = args.output.resolve()
    if not args.output.is_relative_to(ROOT) or args.output == ROOT:
        parser.error("--output must be inside this utility's private artifact directory")
    return args


def main():
    """Run without printing raw transport exceptions or credential-bearing data."""
    args = parse_args()
    args.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_path = args.output.with_name(args.output.name + ".lock")
    with lock_path.open("a") as lock:
        os.fchmod(lock.fileno(), 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DownloadError("Another downloader holds this output's lock") from None
        archive = GitHubArchive(args.repository, args.artifact_id, args.proxy, args.ca_file, args.timeout)
        metadata = archive.metadata()
        size = metadata.get("size_in_bytes")
        if metadata.get("id") != args.artifact_id or metadata.get("expired") is not False:
            raise ProtocolError("Artifact identity does not match or artifact is expired")
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            raise ProtocolError("GitHub artifact size is invalid")
        digest = require_digest(metadata.get("digest"))
        if args.expected_size is not None and size != args.expected_size:
            raise ProtocolError("GitHub artifact size differs from --expected-size")
        if args.expected_digest is not None and digest != require_digest(args.expected_digest):
            raise ProtocolError("GitHub artifact digest differs from --expected-digest")
        workflow = metadata.get("workflow_run")
        head = workflow.get("head_sha") if isinstance(workflow, dict) else None
        if args.expected_head is not None and head != args.expected_head:
            raise ProtocolError("Artifact workflow commit differs from --expected-head")
        identity = {"repository": args.repository, "artifact_id": args.artifact_id,
                    "size": size, "sha256": digest, "head_sha": head}
        Downloader(archive, make_opener(args.proxy, args.ca_file), args.output, identity,
                   args.chunk_size_mib * MIB, args.concurrency, args.retries, args.timeout).run(args.keep_chunks)


if __name__ == "__main__":
    def interrupt(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupt)
    try:
        main()
    except KeyboardInterrupt:
        print("Interrupted; verified chunks are preserved for resume", file=sys.stderr)
        sys.exit(130)
    except DownloadError as error:
        print(f"Download failed: {error}", file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # Transport exception strings may contain signed URLs; never print them.
        print(f"Download failed ({type(error).__name__}); no final ZIP was published", file=sys.stderr)
        sys.exit(1)
