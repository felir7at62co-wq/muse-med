"""Check the company media endpoint without collecting platform content."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import urllib.error
import urllib.request

from prepare import read_private


TOOLS = {"parse_url", "get_video", "get_user", "list_user_posts", "list_comments",
         "get_content_history", "download_media", "get_task_result"}


def request(base, path, body=None, cookie=None):
    """Return bounded JSON and HTTP status; never include credentials in errors."""
    headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(base + path, headers=headers,
        data=json.dumps(body).encode() if body is not None else None)
    try:
        response = urllib.request.urlopen(req, timeout=80)
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        return status, {}
    with response:
        raw = response.read(1048577)
        if len(raw) > 1048576:
            raise ValueError("gateway response exceeds 1 MiB")
        return response.status, json.loads(raw)


def verify(base, cookie_file, receipt, rate_check):
    """Verify anonymous rejection, scoped tools and optional account rate limiting."""
    ready, _ = request("http://127.0.0.1:19581", "/readyz")
    rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    denied, _ = request(base, "/api/media/mcp/", rpc)
    if ready != 200 or denied != 401:
        raise RuntimeError(f"gateway readiness or authentication failed: ready={ready}, anonymous={denied}")
    result = {"verifiedAt": datetime.now(timezone.utc).isoformat(), "origin": base,
              "ready": ready, "anonymousMcp": denied, "authenticated": False,
              "rateLimitVerified": False, "explicitContentToolCalls": 0}
    if cookie_file:
        cookie = read_private(cookie_file).decode().strip()
        if not cookie or "\n" in cookie or "\r" in cookie:
            raise ValueError("cookie file must contain a single Cookie header value")
        status, listed = request(base, "/api/media/mcp/", rpc, cookie)
        found = {tool["name"] for tool in listed.get("result", {}).get("tools", [])}
        if status != 200 or found != TOOLS:
            raise RuntimeError(f"authorized tool list failed: HTTP {status}, count={len(found)}")
        jobs, _ = request(base, "/api/media/jobs", cookie=cookie)
        own_status, _ = request(base, "/api/media/status", cookie=cookie)
        if jobs != 200 or own_status != 200:
            raise RuntimeError("account-scoped job/status read failed")
        result.update({"authenticated": True, "authorizedMcp": status, "toolNames": sorted(found),
                       "jobs": jobs, "accountStatus": own_status})
        if rate_check:
            for _ in range(61):
                limited, _ = request(base, "/api/media/mcp/", rpc, cookie)
                if limited == 429:
                    break
                if limited != 200:
                    raise RuntimeError(f"unexpected status during account rate check: {limited}")
            else:
                raise RuntimeError("account rate limit did not reject the bounded request burst")
            result["rateLimitVerified"] = True
    elif rate_check:
        raise ValueError("rate check requires an authorized private cookie file")
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({key: result[key] for key in ("ready", "anonymousMcp", "authenticated", "rateLimitVerified", "explicitContentToolCalls")}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default="http://127.0.0.1:19581")
    parser.add_argument("--cookie-file", type=Path)
    parser.add_argument("--receipt", type=Path, default=Path("/opt/muse/media-gateway/receipts/verification.json"))
    parser.add_argument("--rate-check", action="store_true")
    args = parser.parse_args()
    verify(args.origin, args.cookie_file, args.receipt, args.rate_check)
