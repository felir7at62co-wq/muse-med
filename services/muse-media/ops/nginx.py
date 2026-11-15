"""Activate or withdraw only the dedicated Muse media reverse-proxy include."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


ANCHOR = "    include /etc/nginx/muse-market-first-batch.locations.conf;\n"
INCLUDE = "    include /etc/nginx/muse-media.locations.conf;\n"


def render_site(text, activate):
    """Insert or remove one owned include while preserving unrelated directives."""
    if text.count(ANCHOR) != 1 or text.count(INCLUDE) > 1:
        raise ValueError("Nginx site does not have the expected unique include")
    if activate:
        return text if INCLUDE in text else text.replace(ANCHOR, ANCHOR + INCLUDE, 1)
    return text.replace(INCLUDE, "", 1)


def replace(path, value):
    """Replace a root-owned Nginx file without exposing partial configuration."""
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def digest(text):
    """Return the SHA-256 of one UTF-8 configuration file."""
    return hashlib.sha256(text.encode()).hexdigest()


def apply(site, include, receipt, activate, expected_site_sha256):
    """Test a narrowly changed site and reload Nginx only after validation."""
    if site.is_symlink() or include.is_symlink():
        raise ValueError("use regular Nginx configuration paths")
    before = site.read_text()
    if digest(before) != expected_site_sha256:
        raise ValueError("Nginx site changed since review; inspect the current file")
    after = render_site(before, activate)
    owned = (Path(__file__).parent / "media.locations.conf").read_text()
    if include.exists() and include.read_text() != owned:
        raise ValueError("media include contains another configuration")
    if activate and not include.exists():
        replace(include, owned)
    if after != before:
        replace(site, after)
    checked = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
    if checked.returncode != 0:
        if site.read_text() != after:
            raise RuntimeError("Nginx validation failed and the site changed concurrently; no reload performed")
        replace(site, before)
        raise RuntimeError("Nginx candidate validation failed; previous site restored without reload")
    subprocess.run(["systemctl", "reload", "nginx"], check=True)
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(json.dumps({"verifiedAt": datetime.now(timezone.utc).isoformat(),
        "active": activate, "site": str(site), "include": str(include),
        "siteBeforeSha256": digest(before), "siteAfterSha256": digest(after),
        "includeSha256": digest(owned), "nginxTest": True, "nginxReload": True}, indent=2) + "\n")
    print(json.dumps({"mediaRouteActive": activate, "nginxTest": True, "nginxReload": True}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("activate", "withdraw"))
    parser.add_argument("--site", type=Path, default=Path("/etc/nginx/sites-available/muse.aigc-pipeline.cn.conf"))
    parser.add_argument("--include", type=Path, default=Path("/etc/nginx/muse-media.locations.conf"))
    parser.add_argument("--receipt", type=Path, default=Path("/opt/muse/media-gateway/receipts/nginx.json"))
    parser.add_argument("--expected-site-sha256", required=True)
    args = parser.parse_args()
    apply(args.site, args.include, args.receipt, args.action == "activate", args.expected_site_sha256)
