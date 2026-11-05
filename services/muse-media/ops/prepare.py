"""Prepare server-only gateway credentials, policy and writable state."""

import argparse
import json
import os
from pathlib import Path
import pwd
import tempfile


def private_write(path, content, uid, gid):
    """Replace a service-owned private file atomically inside its existing directory."""
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), 0o600)
            os.fchown(handle.fileno(), uid, gid)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def configuration(accounts_file):
    """Return explicit gateway limits and container-visible private file paths."""
    return {
        "version": 1,
        "auth_origin": "http://127.0.0.1:19389",
        "auth_host": "muse.aigc-pipeline.cn",
        "auth_public_origin": "https://muse.aigc-pipeline.cn",
        "upstream_origin": "http://127.0.0.1:19580",
        "upstream_key_file": "/run/secrets/dtk-service-key",
        "accounts_file": str(accounts_file),
        "policy_file": "/run/secrets/company-policy.json",
        "database_file": "/var/lib/muse-media/gateway.sqlite3",
        "requests_per_minute": 60,
        "max_requests_per_account": 2,
        "max_downloads_per_day": 20,
        "max_downloads_per_account": 2,
        "max_downloads_global": 4,
        "reservation_ttl_seconds": 900,
        "request_timeout_seconds": 70,
        "auth_timeout_seconds": 5,
        "max_request_bytes": 32768,
        "max_response_bytes": 1048576,
        "max_file_bytes": 536870912,
        "max_jobs_per_page": 100,
        "sqlite_timeout_seconds": 5,
    }


def read_private(path):
    """Read a regular owner-only deployment input, rejecting symlinks."""
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError(f"private input must be a regular owner-only file: {path.name}")
    return path.read_bytes()


def prepare(policy_file, key_file, private_dir, state_dir, accounts_file, image, uid, gid):
    """Install private deployment inputs without sending credentials to clients."""
    if not accounts_file.is_absolute() or accounts_file.parent != Path("/var/lib/muse/accounts"):
        raise ValueError("accounts file must be directly inside /var/lib/muse/accounts")
    if not image.startswith("muse-company-media:") or any(c.isspace() for c in image):
        raise ValueError("image must use a local muse-company-media tag")
    policy = read_private(policy_file)
    parsed = json.loads(policy)
    if parsed.get("version") != 1 or not isinstance(parsed.get("allowedCompanyIdentities"), list) or not isinstance(parsed.get("allowedAccountIds"), list):
        raise ValueError("company policy must declare version and both authorization lists")
    key = read_private(key_file).strip()
    if not key.startswith(b"dtk_") or b"\n" in key or b"\r" in key:
        raise ValueError("upstream key must be one DTK API key")
    for directory in (private_dir, state_dir):
        if directory.is_symlink():
            raise ValueError("service directory must not be a symlink")
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        os.chown(directory, uid, gid)
    private_write(private_dir / "company-policy.json", policy, uid, gid)
    private_write(private_dir / "dtk-service-key", key + b"\n", uid, gid)
    config = configuration(accounts_file)
    private_write(private_dir / "media-config.json", (json.dumps(config, indent=2) + "\n").encode(), uid, gid)
    variables = {"MUSE_MEDIA_IMAGE": image, "MUSE_MEDIA_UID": uid, "MUSE_MEDIA_GID": gid,
                 "MUSE_MEDIA_PRIVATE_DIR": str(private_dir), "MUSE_MEDIA_ACCOUNTS_DIR": str(accounts_file.parent),
                 "MUSE_MEDIA_STATE_DIR": str(state_dir)}
    private_write(private_dir / "compose.env", "".join(f"{k}={v}\n" for k, v in variables.items()).encode(), uid, gid)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--key", type=Path, default=Path("/etc/muse/dtk-service-key"))
    parser.add_argument("--private-dir", type=Path, default=Path("/etc/muse/media-gateway"))
    parser.add_argument("--state-dir", type=Path, default=Path("/var/lib/muse-media"))
    parser.add_argument("--accounts-file", type=Path, default=Path("/var/lib/muse/accounts/accounts.json"))
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    account = pwd.getpwnam("muse-gateway")
    prepare(args.policy, args.key, args.private_dir, args.state_dir, args.accounts_file, args.image, account.pw_uid, account.pw_gid)
    print("Server-only gateway configuration prepared.")
