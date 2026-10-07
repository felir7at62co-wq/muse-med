#!/usr/bin/env python3
"""Relay two fixed, verified build ZIPs to an isolated temporary TOS prefix."""

import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

import artifact_range_download as transfer


REPOSITORY = "felir7at62co-wq/muse-med"


def require_source(value):
    """Require an explicit lowercase source commit from the operator's public configuration."""
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise transfer.ProtocolError("MUSE_CI_TRANSFER_SOURCE_COMMIT must contain an explicit complete commit SHA")
    return value


SOURCE = require_source(os.environ.get("MUSE_CI_TRANSFER_SOURCE_COMMIT"))
PREFIX = "ci-transfer/20261007-0b6d47532eb3b9ba"
ENDPOINT = "https://tos-s3-cn-beijing.volces.com"
PUBLIC_BASE = "https://muse.tos-cn-beijing.volces.com"
ARTIFACTS = (
    {"id": 11460196721, "size": 1536420290,
     "sha256": "32933fe10a98dc608a501a085f72d9579854977bd1314b04f1e1c476009bb1ee",
     "filename": "muse-mac-arm64-artifact-11460196721.zip"},
    {"id": 11460053986, "size": 766360946,
     "sha256": "88ebf218fcc748dd620443b0565cc7be4ad4be0c768b684598299cd4230c4c47",
     "filename": "muse-win-x64-artifact-11460053986.zip"},
)


def archive_path(artifact):
    """Keep only the selected raw build ZIPs under the runner utility directory."""
    return transfer.ROOT / "archives" / artifact["filename"]


def download_one(artifact):
    """Download a selected archive with the reviewed verifier."""
    command = [sys.executable, str(transfer.ROOT / "artifact_range_download.py"),
        "--repository", REPOSITORY, "--artifact-id", str(artifact["id"]),
        "--output", str(archive_path(artifact)), "--expected-head", SOURCE,
        "--expected-size", str(artifact["size"]), "--expected-digest", "sha256:" + artifact["sha256"],
        "--concurrency", "8", "--chunk-size-mib", "16"]
    result = subprocess.run(command, check=False)
    if result.returncode:
        raise transfer.DownloadError(f"Selected artifact {artifact['id']} failed verification/download")


def download():
    """Probe one small range before downloading both exact raw ZIPs."""
    artifact = ARTIFACTS[0]
    ca_file = "/etc/ssl/cert.pem" if Path("/etc/ssl/cert.pem").is_file() else None
    archive = transfer.GitHubArchive(REPOSITORY, artifact["id"], None, ca_file, 90)
    metadata = archive.metadata()
    workflow = metadata.get("workflow_run", {})
    if (metadata.get("size_in_bytes") != artifact["size"]
            or transfer.require_digest(metadata.get("digest")) != artifact["sha256"]
            or workflow.get("head_sha") != SOURCE or workflow.get("id") != 37567499544):
        raise transfer.ProtocolError("Probe artifact metadata differs from the selected build")
    with tempfile.TemporaryDirectory(dir=transfer.ROOT) as temporary:
        started = time.monotonic()
        transfer.fetch_chunk(archive, transfer.make_opener(None, ca_file), Path(temporary),
            0, 0, transfer.MIB - 1, artifact["size"], None, 90)
        elapsed = time.monotonic() - started
        print(json.dumps({"stage": "runner-probe", "bytes": transfer.MIB,
            "seconds": round(elapsed, 3), "mib_per_second": round(1 / elapsed, 3)}), flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(download_one, ARTIFACTS))


def identity():
    """Bind the configured source to both immutable selected artifact records before checkout."""
    ca_file = "/etc/ssl/cert.pem" if Path("/etc/ssl/cert.pem").is_file() else None
    for artifact in ARTIFACTS:
        metadata = transfer.GitHubArchive(REPOSITORY, artifact["id"], None, ca_file, 90).metadata()
        workflow = metadata.get("workflow_run", {})
        if (metadata.get("id") != artifact["id"] or metadata.get("expired") is not False
                or metadata.get("size_in_bytes") != artifact["size"]
                or transfer.require_digest(metadata.get("digest")) != artifact["sha256"]
                or workflow.get("head_sha") != SOURCE or workflow.get("id") != 37567499544
                or workflow.get("repository_id") != 1365170863
                or workflow.get("head_repository_id") != 1365170863):
            raise transfer.ProtocolError("Configured source differs from the fixed artifact build")
    print(json.dumps({"stage": "source-identity", "source_commit": SOURCE,
                      "workflow_run": 37567499544}), flush=True)


def aws(arguments, allow_missing=False):
    """Keep AWS credentials in the environment and print only safe error codes."""
    environment = dict(os.environ)
    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        value = environment.get(name, "").strip()
        if not value:
            raise transfer.DownloadError("Runner is missing a dedicated TOS credential")
        environment[name] = value
    result = subprocess.run(["aws", *arguments, "--endpoint-url", ENDPOINT,
        "--region", "cn-beijing"], env=environment, capture_output=True, text=True, check=False)
    if result.returncode:
        match = re.search(r"An error occurred \(([A-Za-z0-9_-]+)\)", result.stderr)
        code = match.group(1) if match else "UnknownAwsError"
        if allow_missing and code in ("404", "NoSuchKey", "NotFound"):
            return None
        raise transfer.DownloadError(f"TOS request failed ({code}; exit {result.returncode})")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def validate_head(head, artifact):
    """Require the stored ZIP's exact size and immutable source metadata."""
    expected = {"sha256": artifact["sha256"], "artifact-id": str(artifact["id"]),
                "source-commit": SOURCE}
    if head.get("ContentLength") != artifact["size"] or head.get("Metadata") != expected:
        raise transfer.ProtocolError("TOS stored object size or source metadata differs")


def upload_one(artifact):
    """Put only a fully verified ZIP and report an independently fetched S3 HEAD."""
    path = archive_path(artifact)
    transfer.verify_archive(path, artifact["size"], artifact["sha256"])
    key = PREFIX + "/" + artifact["filename"]
    head = aws(["s3api", "head-object", "--bucket", "muse", "--key", key], allow_missing=True)
    if head is not None:
        validate_head(head, artifact)
    else:
        aws(["s3", "cp", str(path), "s3://muse/" + key, "--only-show-errors", "--no-progress",
             "--content-type", "application/zip", "--metadata",
             "sha256=" + artifact["sha256"] + ",artifact-id=" + str(artifact["id"]) + ",source-commit=" + SOURCE])
        head = aws(["s3api", "head-object", "--bucket", "muse", "--key", key])
        validate_head(head, artifact)
    receipt = {"stage": "tos-head-verified", "artifact_id": artifact["id"],
        "source_commit": SOURCE, "size": head["ContentLength"], "sha256": artifact["sha256"],
        "etag": head.get("ETag"), "url": PUBLIC_BASE + "/" + key}
    print(json.dumps(receipt), flush=True)
    return receipt


def configure_aws():
    """Require virtual bucket hosts and bounded multipart transfers for TOS."""
    if not shutil.which("aws"):
        raise transfer.DownloadError("Runner has no AWS CLI")
    # These settings contain no credentials; multipart uploads remain bounded.
    for key, value in (("addressing_style", "virtual"), ("max_concurrent_requests", "8"),
                       ("multipart_threshold", "64MB"), ("multipart_chunksize", "32MB")):
        result = subprocess.run(["aws", "configure", "set", "default.s3." + key, value],
                                capture_output=True, check=False)
        if result.returncode:
            raise transfer.DownloadError("Unable to configure bounded TOS multipart transfer")
    configured = subprocess.run(["aws", "configure", "get", "default.s3.addressing_style"],
                                capture_output=True, text=True, check=False)
    if configured.returncode or configured.stdout.strip() != "virtual":
        raise transfer.ProtocolError("TOS requires AWS CLI virtual addressing style")
    print(json.dumps({"stage": "aws-configuration", "addressing_style": "virtual",
                      "bucket_host": "muse.tos-s3-cn-beijing.volces.com"}), flush=True)


def upload():
    """Upload independently named ZIPs without channel or installer publication."""
    configure_aws()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        receipts = list(pool.map(upload_one, ARTIFACTS))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as target:
            target.write("Verified temporary raw ZIP relay\n\n")
            for receipt in receipts:
                target.write(f"- {receipt['url']} — {receipt['size']} bytes; SHA-256 {receipt['sha256']}\n")


def preflight():
    """Verify small-object Put/Get/hash without requiring bucket-list permission."""
    configure_aws()
    payload = b"Muse temporary relay connectivity probe\n"
    digest = hashlib.sha256(payload).hexdigest()
    key = PREFIX + "/_runner-connectivity-probe.txt"
    with tempfile.TemporaryDirectory(dir=transfer.ROOT) as temporary:
        source, received = Path(temporary) / "source.txt", Path(temporary) / "received.txt"
        source.write_bytes(payload)
        aws(["s3api", "put-object", "--bucket", "muse", "--key", key,
             "--body", str(source), "--content-type", "text/plain", "--metadata", "sha256=" + digest])
        try:
            aws(["s3api", "get-object", "--bucket", "muse", "--key", key, str(received)])
            transfer.verify_archive(received, len(payload), digest)
            head = aws(["s3api", "head-object", "--bucket", "muse", "--key", key])
            if head.get("ContentLength") != len(payload):
                raise transfer.ProtocolError("Probe HeadObject size differs")
            print(json.dumps({"stage": "tos-preflight", "bucket": "muse", "bytes": len(payload),
                              "sha256": digest, "put_get_head_verified": True}), flush=True)
        finally:
            try:
                aws(["s3api", "delete-object", "--bucket", "muse", "--key", key])
            except transfer.DownloadError as error:
                print(f"Probe cleanup deferred: {error}", flush=True)


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["download"]:
            download()
        elif sys.argv[1:] == ["upload"]:
            upload()
        elif sys.argv[1:] == ["preflight"]:
            preflight()
        elif sys.argv[1:] == ["identity"]:
            identity()
        else:
            raise transfer.DownloadError("Expected identity, preflight, download or upload")
    except transfer.DownloadError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(f"Relay failed ({type(error).__name__}); details suppressed to protect credentials", file=sys.stderr)
        sys.exit(1)
