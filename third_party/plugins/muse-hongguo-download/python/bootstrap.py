"""Initialize one private local device from the supplied, checksum-pinned module.

One bounded stdin object supplies appDir. The existing generic config is read
without modification; valid devices are retained and invalid devices fail.
Only {ok, code} is emitted, including when the original module prints or fails.
"""

import contextlib
import hashlib
import json
import marshal
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import types
import uuid


MAX_REQUEST_BYTES = 16_384
MAX_CONFIG_BYTES = 65_536
MAX_MODULE_BYTES = 262_144
CPYTHON_311_MAGIC = b"\xa7\x0d\x0d\x0a"
SOURCE_SHA256 = "85299d65916515c032b8e5c4b7920e4f52149099b23d74042aaa878a43c245ba"
QUERY_KEYS = frozenset({
    "ac", "aid", "app_name", "channel", "compliance_status", "device_brand",
    "device_platform", "device_type", "dpi", "dragon_device_type", "host_abi",
    "is_android_pad_screen", "language", "manifest_version_code",
    "need_personal_recommend", "os", "os_api", "os_version", "player_so_load",
    "pv_player", "resolution", "rom_version", "ssmix", "update_version_code",
    "version_code", "version_name",
})
HEADER_KEYS = frozenset({
    "passport-sdk-version", "sdk-version", "x-tt-store-region", "x-tt-store-region-src",
})
DEVICE_QUERY_KEYS = frozenset({
    "device_id", "iid", "cdid", "device_brand", "device_type", "resolution",
    "os_version", "os_api", "rom_version",
})
ERROR_CODES = frozenset({
    "BAD_REQUEST", "VERSION_UNSUPPORTED", "UNSAFE_PATH", "CONFIG_INVALID",
    "SOURCE_UNAVAILABLE", "SOURCE_VERSION_UNSUPPORTED", "SOURCE_HASH_MISMATCH",
    "SOURCE_LOAD_FAILED", "GENERATION_FAILED", "DEVICES_INVALID", "OUTPUT_FAILED",
    "BOOTSTRAP_FAILED",
})


class BridgeError(Exception):
    """Carry a fixed status code without private module diagnostics."""

    def __init__(self, code):
        self.code = code if code in ERROR_CODES else "BOOTSTRAP_FAILED"
        super().__init__(self.code)


def runtime_supported():
    """Return whether the pinned CPython 3.11 bytecode can execute."""
    return sys.implementation.name == "cpython" and sys.version_info[:2] == (3, 11)


def read_request(stream):
    """Read one bounded appDir object without accepting additional fields."""
    raw = stream.read(MAX_REQUEST_BYTES + 1)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError):
        raise BridgeError("BAD_REQUEST") from None
    if len(raw) > MAX_REQUEST_BYTES or not isinstance(value, dict) or set(value) != {"appDir"}:
        raise BridgeError("BAD_REQUEST")
    if not isinstance(value["appDir"], str) or not value["appDir"] or "\x00" in value["appDir"]:
        raise BridgeError("BAD_REQUEST")
    return value


def app_directory(value):
    """Require an absolute directory whose existing path components are directories."""
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise BridgeError("UNSAFE_PATH")
    try:
        for component in reversed((path, *path.parents)):
            if not stat.S_ISDIR(component.lstat().st_mode):
                raise BridgeError("UNSAFE_PATH")
        return path.resolve(strict=True)
    except OSError:
        raise BridgeError("UNSAFE_PATH") from None


def regular_bytes(path, limit, code):
    """Read a bounded regular file and reject symbolic links before and after open."""
    handle = None
    try:
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise BridgeError(code)
        handle = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        opened = os.fstat(handle)
        if not stat.S_ISREG(opened.st_mode) or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise BridgeError(code)
        with os.fdopen(handle, "rb") as stream:
            handle = None
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise BridgeError(code)
        return data
    except FileNotFoundError:
        raise
    except OSError:
        raise BridgeError(code) from None
    finally:
        if handle is not None:
            os.close(handle)


def parse_json(data, code):
    """Parse file JSON without retaining parser excerpts in the error."""
    try:
        return json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeError):
        raise BridgeError(code) from None


def clean_text(value, limit):
    """Return whether a bounded string is safe as a query or header value."""
    return isinstance(value, str) and 0 < len(value) <= limit and not any(c in value for c in "\r\n\x00")


def validate_config(app):
    """Accept only generic API fields and four non-credential session headers."""
    try:
        value = parse_json(regular_bytes(app / "config.json", MAX_CONFIG_BYTES, "CONFIG_INVALID"), "CONFIG_INVALID")
    except FileNotFoundError:
        raise BridgeError("CONFIG_INVALID") from None
    if not isinstance(value, dict) or set(value) != {"api_host", "base_query", "session_headers"}:
        raise BridgeError("CONFIG_INVALID")
    host, query, headers = value["api_host"], value["base_query"], value["session_headers"]
    if not isinstance(host, str) or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", host):
        raise BridgeError("CONFIG_INVALID")
    if not isinstance(query, dict) or not query or not set(query).issubset(QUERY_KEYS):
        raise BridgeError("CONFIG_INVALID")
    if any(not (clean_text(item, 1024) or type(item) in (int, bool)) for item in query.values()):
        raise BridgeError("CONFIG_INVALID")
    if not isinstance(headers, dict) or any(key.lower() not in HEADER_KEYS or not clean_text(item, 1024)
                                            for key, item in headers.items()):
        raise BridgeError("CONFIG_INVALID")


def validate_devices(value):
    """Require one complete device record produced by the original generator."""
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise BridgeError("DEVICES_INVALID")
    device = value[0]
    if set(device) != {"query", "user_agent"} or not clean_text(device["user_agent"], 1024):
        raise BridgeError("DEVICES_INVALID")
    query = device["query"]
    if not isinstance(query, dict) or set(query) != DEVICE_QUERY_KEYS or any(not clean_text(v, 256) for v in query.values()):
        raise BridgeError("DEVICES_INVALID")
    if any(not re.fullmatch(r"[1-9][0-9]{15}", query[key]) for key in ("device_id", "iid")):
        raise BridgeError("DEVICES_INVALID")
    try:
        identity = uuid.UUID(query["cdid"])
    except ValueError:
        raise BridgeError("DEVICES_INVALID") from None
    if identity.version != 4 or str(identity) != query["cdid"]:
        raise BridgeError("DEVICES_INVALID")
    return value


def existing_devices(app):
    """Retain valid private devices; only an absent file permits generation."""
    try:
        value = regular_bytes(app / "devices.json", MAX_CONFIG_BYTES, "DEVICES_INVALID")
    except FileNotFoundError:
        return False
    if os.name != "nt" and (app / "devices.json").lstat().st_mode & 0o077:
        raise BridgeError("DEVICES_INVALID")
    validate_devices(parse_json(value, "DEVICES_INVALID"))
    return True


@contextlib.contextmanager
def suppress_original_output():
    """Suppress Python, native and inherited child stdout and stderr."""
    saved = []
    with open(os.devnull, "w", encoding="utf-8") as sink:
        try:
            for target in (1, 2):
                original = os.dup(target)
                saved.append((target, original))
                os.dup2(sink.fileno(), target)
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                yield
        finally:
            for target, original in reversed(saved):
                os.dup2(original, target)
                os.close(original)


def generate_device(app):
    """Execute only verified module bytes and restore its process module entry."""
    try:
        data = regular_bytes(app / "devicepool.pyc", MAX_MODULE_BYTES, "SOURCE_UNAVAILABLE")
    except FileNotFoundError:
        raise BridgeError("SOURCE_UNAVAILABLE") from None
    if len(data) < 16 or data[:4] != CPYTHON_311_MAGIC:
        raise BridgeError("SOURCE_VERSION_UNSUPPORTED")
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        raise BridgeError("SOURCE_HASH_MISMATCH")
    missing = object()
    previous = sys.modules.get("devicepool", missing)
    module = types.ModuleType("devicepool")
    module.__file__ = str(app / "devicepool.pyc")
    sys.modules["devicepool"] = module
    try:
        with suppress_original_output():
            try:
                code = marshal.loads(data[16:])
                if not isinstance(code, types.CodeType):
                    raise BridgeError("SOURCE_LOAD_FAILED")
                exec(code, module.__dict__)
            except BaseException:
                raise BridgeError("SOURCE_LOAD_FAILED") from None
            generator = getattr(module, "gen_device", None)
            if not callable(generator):
                raise BridgeError("SOURCE_LOAD_FAILED")
            try:
                device = generator({})
            except BaseException:
                raise BridgeError("GENERATION_FAILED") from None
        return validate_devices([device])
    finally:
        if previous is missing:
            sys.modules.pop("devicepool", None)
        else:
            sys.modules["devicepool"] = previous


def publish_devices(app, devices):
    """Atomically publish private bytes without replacing another initializer's file."""
    name = ".muse-hongguo-devices-" + secrets.token_hex(16)
    staged = app / name
    created = False
    try:
        handle = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        created = True
        with os.fdopen(handle, "wb") as stream:
            stream.write((json.dumps(devices, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(staged, app / "devices.json", follow_symlinks=False)
        except FileExistsError:
            if not existing_devices(app):
                raise BridgeError("OUTPUT_FAILED")
    except OSError:
        raise BridgeError("OUTPUT_FAILED") from None
    finally:
        if created:
            try:
                staged.unlink()
            except OSError as _error:
                pass  # Preserve an entry whose ownership or availability has changed.


def run(request):
    """Initialize an absent device file; never replace or repair an existing one."""
    if not runtime_supported():
        raise BridgeError("VERSION_UNSUPPORTED")
    app = app_directory(request["appDir"])
    validate_config(app)
    if not existing_devices(app):
        publish_devices(app, generate_device(app))
    return {"ok": True, "code": "OK"}


def main():
    """Emit one fixed status object without original output or private values."""
    try:
        result = run(read_request(sys.stdin.buffer))
    except BridgeError as error:
        result = {"ok": False, "code": error.code}
    except BaseException:
        result = {"ok": False, "code": "BOOTSTRAP_FAILED"}
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
