"""Refresh Central Web's server-side browser cookie from the active Muse Web process."""

import http.client
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

UNIT = "muse-cloud.service"
COOKIE_DIRECTORY = Path("/run/muse-central-web-auth")
BOOTSTRAP_PATTERN = r"https?://[^\s<>\"']+[?&]token=[A-Za-z0-9_-]+"


def command(*argv):
    """Read systemd metadata without exposing its output on failure."""
    result = subprocess.run(argv, capture_output=True, check=True, text=True, timeout=5)
    return result.stdout


def active_invocation():
    """Return the current systemd invocation identifier."""
    value = command("systemctl", "show", "-p", "InvocationID", "--value", UNIT).strip()
    if not re.fullmatch(r"[0-9a-f]{32}", value) or value == "0" * 32:
        raise ValueError("Missing active invocation")
    return value


def bootstrap_path(origin, invocation):
    """Extract the current process's token exchange path for the configured backend."""
    rows = command(
        "journalctl", "-u", UNIT, f"_SYSTEMD_INVOCATION_ID={invocation}",
        "--grep=token=", "-o", "json", "--no-pager", "-n", "5",
        "--output-fields=MESSAGE",
    )
    for row in reversed(rows.splitlines()):
        message = json.loads(row).get("MESSAGE")
        if not isinstance(message, str):
            continue
        for match in reversed(re.findall(BOOTSTRAP_PATTERN, message)):
            candidate = urlsplit(match)
            if (candidate.scheme, candidate.netloc, candidate.path, candidate.fragment) != (
                origin.scheme, origin.netloc, "/", "",
            ):
                continue
            query = parse_qs(candidate.query)
            if list(query) == ["token"] and len(query["token"]) == 1:
                return "/?" + candidate.query
    raise ValueError("No matching browser launch address")


def exchange_cookie(origin, path):
    """Exchange the launch token with the native backend and discard the token."""
    connection = http.client.HTTPConnection(origin.hostname, origin.port, timeout=4)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        cookies = [
            value.split(";", 1)[0] for name, value in response.getheaders()
            if name.lower() == "set-cookie"
        ]
        if (
            response.status != 303 or response.getheader("Location") != "./"
            or len(cookies) != 1
            or not re.fullmatch(r"dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+", cookies[0])
        ):
            raise ValueError("Native browser cookie exchange rejected")
        return cookies[0]
    finally:
        connection.close()


def write_cookie(path, cookie):
    """Atomically publish one root-owned cookie readable only by the proxy group."""
    directory = path.parent
    metadata = directory.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
        raise ValueError("Unsafe cookie directory")
    descriptor, filename = tempfile.mkstemp(dir=directory, prefix=".backend-cookie-")
    try:
        with os.fdopen(descriptor, "w", encoding="ascii") as output:
            os.fchown(output.fileno(), 0, metadata.st_gid)
            os.fchmod(output.fileno(), 0o640)
            output.write(cookie + "\n")
        os.replace(filename, path)
    finally:
        Path(filename).unlink(missing_ok=True)


def main():
    """Read deployment settings and publish the native cookie."""
    config_path = Path(os.environ["MUSE_CENTRAL_CONFIG"])
    metadata = config_path.stat()
    if metadata.st_uid != 0 or metadata.st_mode & 0o022:
        raise ValueError("Unsafe deployment settings")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    target = Path(config["backendCookieFile"])
    origin = urlsplit(config["backendOrigin"])
    if (
        target.parent != COOKIE_DIRECTORY or origin.scheme != "http"
        or not origin.hostname or not origin.port or origin.username is not None
        or origin.password is not None or origin.path not in ("", "/")
        or origin.query or origin.fragment
    ):
        raise ValueError("Invalid backend settings")
    invocation = active_invocation()
    cookie = exchange_cookie(origin, bootstrap_path(origin, invocation))
    if invocation != active_invocation():
        raise ValueError("Native web restarted during authorization")
    write_cookie(target, cookie)


if __name__ == "__main__":
    try:
        main()
    except (KeyError, OSError, ValueError, http.client.HTTPException, subprocess.SubprocessError):
        sys.exit("Central Web backend authorization refresh failed")
