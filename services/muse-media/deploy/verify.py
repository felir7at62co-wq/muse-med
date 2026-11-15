"""Bootstrap the private service key and verify DTK without platform requests."""

import argparse
from datetime import datetime, timezone
import http.cookiejar
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

TOOLS = {
    "parse_url", "get_video", "get_user", "list_user_posts", "list_comments",
    "get_content_history", "pool_status", "download_media", "transcribe_video", "get_task_result",
}
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
READINESS_WORKER = (
    "import runpy, sys; "
    "module = runpy.run_path(sys.argv[1], run_name='dtk_readiness_probe'); "
    "sys.exit(module['readiness_probe'](sys.argv[2], float(sys.argv[3])))"
)


def request(opener, base, path, body=None, key=None, timeout=20):
    """Return status and decoded JSON, without including response data in errors."""
    headers = {"Accept": "application/json, text/event-stream"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(base + path, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        response = opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as error:
        error.close()
        return error.code, {}
    with response:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("DTK response exceeds 2 MiB")
        payload = raw.decode()
        if payload.startswith("event:") or payload.startswith("data:"):
            payload = next(line[6:] for line in payload.splitlines() if line.startswith("data: "))
        return response.status, json.loads(payload)


def readiness_probe(base, timeout):
    """Run the anonymous probe worker without credentials, proxies or body output."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        status, _ = request(opener, base, "/readyz", timeout=timeout)
    except (OSError, ValueError):
        return 3
    return 0 if status == 200 else 3


def wait_ready(base, timeout=120):
    """Use one monotonic probe deadline and reap every admitted worker."""
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("readiness timeout must be a positive finite number of seconds")
    deadline = time.monotonic() + timeout
    environment = {name: os.environ[name] for name in ("SYSTEMROOT", "WINDIR") if name in os.environ}
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        attempt_deadline = min(deadline, time.monotonic() + 20)
        budget = attempt_deadline - time.monotonic()
        if budget <= 0:
            break
        try:
            process = subprocess.Popen(
                [sys.executable, "-I", "-c", READINESS_WORKER, str(Path(__file__).resolve()), base, str(budget)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environment,
            )
        except OSError as error:
            raise RuntimeError("DTK readiness probe could not start; check the Python installation") from error
        code = None
        try:
            remaining = min(deadline, attempt_deadline) - time.monotonic()
            if remaining > 0:
                try:
                    code = process.wait(timeout=remaining)
                except subprocess.TimeoutExpired:
                    pass
        finally:
            try:
                if process.poll() is None:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass  # The worker exited between poll and kill; it still needs reaping.
            finally:
                process.wait()
        if code == 0:
            if time.monotonic() < deadline:
                return
            break
        if code not in (None, 3):
            raise RuntimeError("DTK readiness probe failed unexpectedly; check the service response and verifier installation")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(2, remaining))
    raise RuntimeError(f"DTK did not become ready within {timeout:g} seconds")


def published_bindings(service, metadata):
    """Return observed loopback publications; reject shared host networks and unknown data."""
    if not isinstance(metadata, dict) or metadata.get("running") is not True:
        raise RuntimeError(f"required service is not running: {service}")
    network = metadata.get("networkMode")
    if not isinstance(network, str) or not network or network == "host" or network.startswith("container:"):
        raise RuntimeError(f"required service uses an unverified host/shared network: {service}")
    ports = metadata.get("ports")
    if not isinstance(ports, dict):
        raise RuntimeError(f"published port state is missing or unrecognized: {service}")
    observed = []
    for container_port, bindings in ports.items():
        parts = container_port.split("/")
        if len(parts) != 2 or not parts[0].isdecimal() or not 1 <= int(parts[0]) <= 65535 or parts[1] not in ("tcp", "udp", "sctp"):
            raise RuntimeError(f"container port state is unrecognized: {service}")
        if bindings is None:
            continue
        if not isinstance(bindings, list):
            raise RuntimeError(f"published port state is unrecognized: {service}")
        for binding in bindings:
            if not isinstance(binding, dict):
                raise RuntimeError(f"published binding is unrecognized: {service}")
            host_ip, host_port = binding.get("HostIp"), binding.get("HostPort")
            try:
                address = ipaddress.ip_address(host_ip) if isinstance(host_ip, str) else None
            except ValueError as error:
                raise RuntimeError(f"published binding is public or unrecognized: {service}") from error
            if address is None or not address.is_loopback or not isinstance(host_port, str) or not host_port.isdecimal() or not 1 <= int(host_port) <= 65535:
                raise RuntimeError(f"published binding is public or unrecognized: {service}")
            observed.append({"containerPort": container_port, "hostIp": str(address), "hostPort": int(host_port)})
    return sorted(observed, key=lambda binding: (binding["containerPort"], binding["hostIp"], binding["hostPort"]))


def runtime(source, env_file, pin, port=19580):
    """Read running image IDs and database migration state without environment values."""
    command = ["docker", "compose", "--env-file", str(env_file), "-p", "muse-dtk",
               "-f", str(source / "docker/compose.yml")]
    def output(arguments):
        return subprocess.check_output(arguments, text=True, stderr=subprocess.DEVNULL).strip()
    images = {}
    publications = {}
    networks = {}
    for service in ("api", "worker", "postgres", "redis", "browser-rpc", "downloader"):
        container = output(command + ["ps", "-q", service])
        if len(container.splitlines()) != 1:
            raise RuntimeError(f"required service container is missing or ambiguous: {service}")
        metadata = json.loads(output(["docker", "inspect", "--format",
            '{"running":{{json .State.Running}},"networkMode":{{json .HostConfig.NetworkMode}},"ports":{{json .NetworkSettings.Ports}}}', container]))
        publications[service] = published_bindings(service, metadata)
        networks[service] = metadata["networkMode"]
        image = output(["docker", "inspect", "--format", "{{.Image}}", container])
        digests = json.loads(output(["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", image]))
        images[service] = {"imageId": image, "repoDigests": digests or []}
        if service in ("api", "worker", "downloader"):
            labels = json.loads(output(["docker", "image", "inspect", "--format", "{{json .Config.Labels}}", image]))
            revision = labels.get("org.opencontainers.image.revision")
            version = labels.get("org.opencontainers.image.version")
            if revision != pin["commit"] or version != pin["tag"]:
                raise RuntimeError(f"running image revision differs from the pin: {service}")
            images[service].update({"revision": revision, "version": version})
        environment_keys = output(["docker", "inspect", "--format",
            '{{range .Config.Env}}{{println (index (split . "=") 0)}}{{end}}', container]).splitlines()
        if any(name.lower() in ("http_proxy", "https_proxy", "all_proxy") for name in environment_keys):
            raise RuntimeError(f"runtime proxy must be configured separately from the build proxy: {service}")
    primary = next((binding for binding in publications["api"] if binding == {
        "containerPort": "8000/tcp", "hostIp": "127.0.0.1", "hostPort": port}), None)
    if primary is None:
        raise RuntimeError("running API does not publish the requested loopback endpoint")
    transcriber = {}
    for service in ("api", "worker"):
        configuration = json.loads(output(command + ["exec", "-T", service, "python", "-c",
            "import json; from dtk.core.config import BootstrapSettings; print(json.dumps({'configured': bool(BootstrapSettings().transcriber_url)}))"]))
        if not isinstance(configuration, dict) or type(configuration.get("configured")) is not bool:
            raise RuntimeError(f"transcriber configuration could not be observed: {service}")
        transcriber[service] = configuration["configured"]
    transcriber_container = output(command + ["ps", "-q", "transcriber"])
    if any(transcriber.values()) or transcriber_container:
        raise RuntimeError("transcriber is configured or running; disable it before verification")
    migrated = output(command + ["ps", "-aq", "migrate"])
    migration_state = json.loads(output(["docker", "inspect", "--format",
        '{"exitCode":{{.State.ExitCode}},"status":"{{.State.Status}}"}', migrated]))
    expected_revision = output(command + ["exec", "-T", "api", "python", "-c",
        "from dtk.db.migrate import head_revision; print(head_revision())"])
    actual_revision = output(command + ["exec", "-T", "postgres", "psql", "-U", "dtk", "-d", "dtk", "-Atc",
        "SELECT version_num FROM alembic_version"])
    if migration_state != {"exitCode": 0, "status": "exited"} or actual_revision != expected_revision:
        raise RuntimeError("database migration state does not match the running application")
    browser = json.loads(output(command + ["exec", "-T", "api", "python", "-c",
        "import urllib.request; print(urllib.request.urlopen('http://browser-rpc:9000/rpc/health', timeout=10).read().decode())"]))
    if browser.get("status") != "ok" or browser.get("backend") != "cloak" or pin["cloakBrowserCommit"] not in str(browser.get("backend_pin", "")):
        raise RuntimeError("running browser backend does not match the pinned CloakBrowser")
    return {"images": images, "migration": {**migration_state, "revision": actual_revision},
            "browserRuntime": {key: browser.get(key) for key in ("backend", "backend_version", "backend_pin", "chromium_major")},
            "listen": f"{primary['hostIp']}:{primary['hostPort']}", "publishedBindings": publications,
            "networkModes": networks, "transcriberEnabled": any(transcriber.values()) or bool(transcriber_container),
            "transcriberRuntime": {**transcriber, "containerRunning": bool(transcriber_container)}}


def verify(source, env_file, admin_file, key_file, receipt_file, port, readiness_timeout=120):
    """Initialize once, issue a limited service key, and record secret-free checks."""
    base = f"http://127.0.0.1:{port}"
    wait_ready(base, readiness_timeout)
    pin = json.loads((Path(__file__).parent / "upstream.json").read_text())
    runtime_state = runtime(source, env_file, pin, port)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    status, setup = request(opener, base, "/api/setup/status")
    if status != 200:
        raise RuntimeError(f"setup status failed: HTTP {status}")
    credentials = json.loads(admin_file.read_text())
    if not setup["data"]["initialized"]:
        command = ["docker", "compose", "--env-file", str(env_file), "-p", "muse-dtk",
                   "-f", str(source / "docker/compose.yml"), "exec", "-T", "redis", "sh", "-c",
                   'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw GET setup:token']
        token = subprocess.check_output(command, text=True, stderr=subprocess.DEVNULL).strip()
        if not token:
            raise RuntimeError("setup token is not available")
        status, result = request(opener, base, "/api/setup/init", {**credentials, "token": token})
        if status != 201:
            raise RuntimeError(f"administrator initialization failed: HTTP {status}")
    status, result = request(opener, base, "/api/v1/auth/login", credentials)
    if status != 200:
        raise RuntimeError(f"private administrator login failed: HTTP {status}")
    status, system = request(opener, base, "/api/v1/system/status")
    data = system.get("data") if isinstance(system, dict) else None
    if status != 200 or not isinstance(data, dict) or data.get("version") != "5.1.10":
        raise RuntimeError("running API version is not 5.1.10")
    components = data.get("components")
    if not isinstance(components, dict):
        raise RuntimeError("running API component state could not be observed")
    for name in ("browser_rpc", "downloader"):
        component = components.get(name)
        if not isinstance(component, dict) or component.get("ok") is not True:
            raise RuntimeError(f"required component is not healthy: {name}")
    transcriber = components.get("transcriber")
    if not isinstance(transcriber, dict) or transcriber.get("configured") is not False or "ok" not in transcriber or transcriber["ok"] is not None:
        raise RuntimeError("API transcriber is configured or its state is unrecognized; disable it before verification")
    if not key_file.exists():
        status, result = request(opener, base, "/api/v1/admin/api-keys", {
            "name": "muse-company-media-service",
            "scopes": ["douyin:read", "tiktok:read", "bilibili:read", "archive:read", "media:read", "media:write"],
            "rate_limit": 300,
        })
        if status != 201:
            raise RuntimeError(f"service key creation failed: HTTP {status}")
        data = result["data"]
        key = data.get("key") or data.get("api_key")
        if not key or not isinstance(key, str):
            raise RuntimeError("service key response does not contain a key")
        descriptor = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(key + "\n")
    if key_file.stat().st_mode & 0o077:
        raise ValueError("service key file must not be accessible to group or other users")
    key = key_file.read_text().strip()
    anonymous = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    denied, _ = request(anonymous, base, "/mcp/", rpc)
    status, listed = request(anonymous, base, "/mcp/", rpc, key)
    found = {tool["name"] for tool in listed.get("result", {}).get("tools", [])}
    if denied != 401 or status != 200 or found != TOOLS:
        raise RuntimeError(f"MCP check failed: anonymous={denied}, authorized={status}, tools={len(found)}")
    status, _ = request(anonymous, base, "/api/v1/admin/users", key=key)
    if status != 403:
        raise RuntimeError(f"limited service key reached administrator route: HTTP {status}")
    archive = source.parent / "source-v5.1.10.tar.gz"
    archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
    if archive_hash != pin["sourceArchiveSha256"]:
        raise RuntimeError("deployed source archive SHA-256 does not match the pin")
    browser_build = json.loads((Path(__file__).parent / "browser-build.json").read_text())
    browser_file = Path(__file__).parent / "Dockerfile.browser"
    if hashlib.sha256(browser_file.read_bytes()).hexdigest() != browser_build["deploymentDockerfileSha256"]:
        raise RuntimeError("deployment browser Dockerfile differs from the recorded build")
    receipt = {"verifiedAt": datetime.now(timezone.utc).isoformat(), "upstream": pin,
               "readiness": 200, "anonymousMcp": denied,
               "authorizedMcp": 200, "toolNames": sorted(found), "adminDenied": 403,
               "explicitContentToolCalls": 0,
               "sourceArchiveSha256": archive_hash, "apiVersion": system["data"]["version"],
               "components": {name: {"configured": components[name].get("configured"),
                            "ok": components[name].get("ok")} for name in ("browser_rpc", "downloader", "transcriber")},
               **runtime_state,
               "browserBuild": browser_build, "runtimeBuildProxy": False,
               "serviceKeyFile": str(key_file)}
    receipt_file.parent.mkdir(parents=True, exist_ok=True)
    receipt_file.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"readiness": 200, "anonymousMcp": denied, "authorizedMcp": 200,
                      "toolCount": len(found), "adminDenied": 403, "explicitContentToolCalls": 0}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, default=Path("/etc/muse/dtk.env"))
    parser.add_argument("--admin-file", type=Path, default=Path("/etc/muse/dtk-admin.json"))
    parser.add_argument("--key-file", type=Path, default=Path("/etc/muse/dtk-service-key"))
    parser.add_argument("--receipt", type=Path, default=Path("/opt/muse/dtk/receipts/deployment.json"))
    parser.add_argument("--port", type=int, default=19580)
    def positive_seconds(value):
        try:
            seconds = float(value)
        except ValueError as error:
            raise argparse.ArgumentTypeError("readiness timeout must be a positive finite number") from error
        if not math.isfinite(seconds) or seconds <= 0:
            raise argparse.ArgumentTypeError("readiness timeout must be a positive finite number")
        return seconds
    parser.add_argument("--readiness-timeout", type=positive_seconds, default=120,
                        help="total readiness wait budget in seconds (default: 120)")
    args = parser.parse_args()
    verify(args.source, args.env_file, args.admin_file, args.key_file, args.receipt, args.port, args.readiness_timeout)
