"""Build the pinned browser with an optional signed Debian package mirror."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit


def dockerfile(source, pin, mirror):
    """Validate the upstream file and optionally change its package download host."""
    raw = (source / "docker/Dockerfile.browser").read_bytes()
    if hashlib.sha256(raw).hexdigest() != pin["browserDockerfileSha256"]:
        raise ValueError("upstream browser Dockerfile SHA-256 does not match the pin")
    text = raw.decode()
    if mirror:
        parsed = urlsplit(mirror)
        if not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::[0-9]+)?/[A-Za-z0-9/_-]*", mirror):
            raise ValueError("Debian mirror must be an HTTPS base URL without credentials")
        prefix = (
            "RUN sed -i 's|http://deb.debian.org/debian|" + mirror.rstrip("/") + "|g' "
            "/etc/apt/sources.list.d/debian.sources "
            "&& printf 'Acquire::https::Proxy::" + parsed.hostname + " \"DIRECT\";\\n' "
            "> /etc/apt/apt.conf.d/99-muse-mirror\n\n"
        )
        text = text.replace("# Chromium's shared-library", prefix + "# Chromium's shared-library", 1)
    return text


def build(source, mirror):
    """Build a separate Dockerfile and record its hash without modifying upstream."""
    directory = Path(__file__).resolve().parent
    pin = json.loads((directory / "upstream.json").read_text())
    target = directory / "Dockerfile.browser"
    target.write_text(dockerfile(source, pin, mirror))
    metadata = {"upstreamDockerfileSha256": pin["browserDockerfileSha256"],
                "deploymentDockerfileSha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                "debianMirror": mirror, "cloakBrowserCommit": pin["cloakBrowserCommit"]}
    subprocess.run(["docker", "build", "--network", "host", "--build-arg", "HTTP_PROXY", "--build-arg", "HTTPS_PROXY",
                    "--build-arg", f"CLOAKBROWSER_COMMIT={pin['cloakBrowserCommit']}",
                    "-f", str(target), "-t", "dtk-browser-rpc:5.1.10", str(source)], check=True)
    (directory / "browser-build.json").write_text(json.dumps(metadata, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--apt-mirror")
    args = parser.parse_args()
    build(args.source, args.apt_mirror)
