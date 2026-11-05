"""Create private DTK bootstrap files without replacing existing secrets."""

import argparse
import json
import os
from pathlib import Path
import secrets


def private_json(path, value):
    """Create a JSON file readable only by its owner; refuse replacement."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(json.dumps(value) + "\n")


def environment(port):
    """Return a fresh loopback-only configuration and random credentials."""
    if not 1024 <= port <= 65535:
        raise ValueError("port must be between 1024 and 65535")
    postgres = secrets.token_hex(32)
    redis = secrets.token_hex(32)
    return {
        "DTK_SECRET_KEY": secrets.token_hex(48),
        "POSTGRES_PASSWORD": postgres,
        "REDIS_PASSWORD": redis,
        "DTK_DATABASE_URL": f"postgresql+asyncpg://dtk:{postgres}@postgres:5432/dtk",
        "DTK_REDIS_URL": f"redis://:{redis}@redis:6379/0",
        "DTK_LOG_LEVEL": "info",
        "DTK_LOG_JSON": "true",
        "DTK_BIND_HOST": "127.0.0.1",
        "DTK_BIND_PORT": str(port),
        "DTK_IMAGE": "evil0ctal/douyin_tiktok_download_api",
        "DTK_IMAGE_TAG": "5.1.10",
        "DTK_DOWNLOADER_IMAGE": "evil0ctal/douyin_tiktok_download_api-downloader",
        "DTK_BROWSER_RPC_URL": "http://browser-rpc:9000",
        "DTK_DOWNLOADER_URL": "http://downloader:9100",
        "DTK_DOWNLOADER_TOKEN": secrets.token_hex(32),
        "CLOAKBROWSER_COMMIT": "fbf005bc199920b592df17ac4d489324e29d56d8",
    }


def prepare(source, env_file, admin_file, port):
    """Create missing credentials and attach the private environment to source."""
    if not 1024 <= port <= 65535:
        raise ValueError("port must be between 1024 and 65535")
    source = source.resolve(strict=True)
    if not (source / "docker/compose.yml").is_file():
        raise ValueError("source does not contain docker/compose.yml")
    env_file.parent.mkdir(parents=True, exist_ok=True)
    if not env_file.exists():
        descriptor = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            handle.write("".join(f"{key}={value}\n" for key, value in environment(port).items()))
    if env_file.stat().st_mode & 0o077:
        raise ValueError("environment file must not be accessible to group or other users")
    link = source / ".env"
    if link.is_symlink():
        if link.resolve() != env_file.resolve():
            raise ValueError("source .env points to another environment")
    elif link.exists():
        raise ValueError("source .env already exists; migrate it explicitly")
    else:
        link.symlink_to(env_file.resolve())
    if not admin_file.exists():
        private_json(admin_file, {"username": "muse-service-admin", "password": secrets.token_urlsafe(48)})
    if admin_file.stat().st_mode & 0o077:
        raise ValueError("administrator file must not be accessible to group or other users")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, default=Path("/etc/muse/dtk.env"))
    parser.add_argument("--admin-file", type=Path, default=Path("/etc/muse/dtk-admin.json"))
    parser.add_argument("--port", type=int, default=19580)
    args = parser.parse_args()
    prepare(args.source, args.env_file, args.admin_file, args.port)
    print("Private DTK configuration prepared; no existing credentials replaced.")
