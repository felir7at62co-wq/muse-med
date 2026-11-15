"""Set explicit upstream media storage limits through the private admin API."""

import argparse
from datetime import datetime, timezone
import http.cookiejar
import json
from pathlib import Path
import urllib.request

from prepare import read_private


def configure(admin_file, receipt, maximum, per_file):
    """Record previous and applied byte limits without exposing administrator credentials."""
    if maximum < per_file or per_file <= 0:
        raise ValueError("storage must be positive and at least the per-file limit")
    credentials = json.loads(read_private(admin_file))
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(path, method="GET", value=None):
        req = urllib.request.Request("http://127.0.0.1:19580" + path, method=method,
            headers={"Content-Type": "application/json"},
            data=json.dumps(value).encode() if value is not None else None)
        with opener.open(req, timeout=15) as response:
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError("upstream settings response exceeds 1 MiB")
            return json.loads(raw)["data"]
    call("/api/v1/auth/login", "POST", credentials)
    wanted = {"media.max_bytes": maximum, "media.max_file_bytes": per_file}
    previous = {row["key"]: row["value"] for row in call("/api/v1/admin/settings")["settings"] if row["key"] in wanted}
    for key, value in wanted.items():
        call("/api/v1/admin/settings/" + key, "PUT", {"value": value})
    observed = {row["key"]: row["value"] for row in call("/api/v1/admin/settings")["settings"] if row["key"] in wanted}
    if observed != wanted:
        raise RuntimeError("upstream storage limits did not match the requested values")
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(json.dumps({"verifiedAt": datetime.now(timezone.utc).isoformat(),
        "before": previous, "after": observed}, indent=2) + "\n")
    print(json.dumps({"storageLimits": observed}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--admin-file", type=Path, default=Path("/etc/muse/dtk-admin.json"))
    parser.add_argument("--receipt", type=Path, default=Path("/opt/muse/media-gateway/receipts/storage.json"))
    parser.add_argument("--max-bytes", type=int, default=20 * 1024 ** 3)
    parser.add_argument("--max-file-bytes", type=int, default=512 * 1024 ** 2)
    args = parser.parse_args()
    configure(args.admin_file, args.receipt, args.max_bytes, args.max_file_bytes)
