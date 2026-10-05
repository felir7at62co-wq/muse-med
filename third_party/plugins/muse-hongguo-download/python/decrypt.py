"""Use the supplied CPython 3.11 offline modules without exposing media keys.

One bounded stdin JSON object supplies appDir, spade, input, output and ffmpeg.
The process emits only {ok, code}; media verification belongs to the caller.
"""

import base64
import contextlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


MAX_REQUEST_BYTES = 65_536
MODULE_NAMES = (
    "extract_keybox_pairs", "unwrap_spade", "oracle", "decutil", "offline_decrypt"
)
CPYTHON_311_MAGIC = b"\xa7\x0d\x0d\x0a"
REQUEST_KEYS = {"appDir", "spade", "input", "output", "ffmpeg"}
ERROR_CODES = frozenset({
    "BAD_REQUEST", "UNSAFE_PATH", "SOURCE_UNAVAILABLE", "SOURCE_VERSION_UNSUPPORTED",
    "INPUT_UNAVAILABLE", "FFMPEG_UNAVAILABLE", "OUTPUT_EXISTS", "SOURCE_LOAD_FAILED",
    "VERSION_UNSUPPORTED", "DECRYPT_FAILED", "OUTPUT_FAILED", "BRIDGE_FAILED"
})


class BridgeError(Exception):
    """Carry a fixed public error code without an original diagnostic."""

    def __init__(self, code):
        code = code if code in ERROR_CODES else "BRIDGE_FAILED"
        super().__init__(code)
        self.code = code


def runtime_supported():
    """Return whether original Python 3.11 bytecode can execute here."""
    return sys.implementation.name == "cpython" and sys.version_info[:2] == (3, 11)


def read_request(stream):
    """Parse one bounded UTF-8 object from a binary stdin stream."""
    raw = stream.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise BridgeError("BAD_REQUEST")
    try:
        request = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError):
        raise BridgeError("BAD_REQUEST") from None
    if not isinstance(request, dict) or set(request) != REQUEST_KEYS:
        raise BridgeError("BAD_REQUEST")
    if any(not isinstance(value, str) or not value or "\x00" in value
           for value in request.values()):
        raise BridgeError("BAD_REQUEST")
    spade = request["spade"]
    try:
        decoded = base64.b64decode(spade, validate=True)
    except (ValueError, UnicodeError):
        raise BridgeError("BAD_REQUEST") from None
    if not decoded or len(spade) > 8192:
        raise BridgeError("BAD_REQUEST")
    return request


def _absolute(value):
    path = Path(value)
    if not path.is_absolute():
        raise BridgeError("UNSAFE_PATH")
    return path


def validate_request(request):
    """Validate source and output metadata without reading media contents."""
    app = _absolute(request["appDir"])
    source = app / "frida"
    if not app.is_dir() or not source.is_dir() or source.is_symlink():
        raise BridgeError("SOURCE_UNAVAILABLE")
    for name in MODULE_NAMES:
        module = source / (name + ".pyc")
        try:
            info = module.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size < 16:
                raise BridgeError("SOURCE_UNAVAILABLE")
            with module.open("rb") as handle:
                header = handle.read(16)
        except OSError:
            raise BridgeError("SOURCE_UNAVAILABLE") from None
        if header[:4] != CPYTHON_311_MAGIC:
            raise BridgeError("SOURCE_VERSION_UNSUPPORTED")
    media = _absolute(request["input"])
    output = _absolute(request["output"])
    ffmpeg = _absolute(request["ffmpeg"])
    try:
        if not stat.S_ISREG(media.lstat().st_mode) or not os.access(media, os.R_OK):
            raise BridgeError("INPUT_UNAVAILABLE")
        media = media.resolve(strict=True)
    except OSError:
        raise BridgeError("INPUT_UNAVAILABLE") from None
    try:
        ffmpeg = ffmpeg.resolve(strict=True)
        if not ffmpeg.is_file() or not os.access(ffmpeg, os.X_OK):
            raise BridgeError("FFMPEG_UNAVAILABLE")
    except OSError:
        raise BridgeError("FFMPEG_UNAVAILABLE") from None
    try:
        source = source.resolve(strict=True)
        if not output.parent.is_dir():
            raise BridgeError("UNSAFE_PATH")
        output = output.parent.resolve(strict=True) / output.name
    except OSError:
        raise BridgeError("UNSAFE_PATH") from None
    if media == output or output.is_relative_to(app.resolve()):
        raise BridgeError("UNSAFE_PATH")
    if os.path.lexists(output):
        raise BridgeError("OUTPUT_EXISTS")
    return source, media, output, ffmpeg


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


@contextlib.contextmanager
def original_modules(source, ffmpeg):
    """Load only the five fixed .pyc entries and restore process module state."""
    missing = object()
    previous = {name: sys.modules.get(name, missing) for name in MODULE_NAMES}
    previous_path = sys.path[:]
    loaded = {}
    try:
        for name in MODULE_NAMES:
            loader = importlib.machinery.SourcelessFileLoader(
                name, str(source / (name + ".pyc"))
            )
            spec = importlib.util.spec_from_loader(name, loader)
            if spec is None:
                raise BridgeError("SOURCE_LOAD_FAILED")
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            try:
                loader.exec_module(module)
            except BaseException:
                raise BridgeError("SOURCE_LOAD_FAILED") from None
            loaded[name] = module
        decutil = loaded["decutil"]
        if not callable(getattr(decutil, "_ff_exe", None)):
            raise BridgeError("SOURCE_LOAD_FAILED")
        decutil._ff_exe = lambda name: str(ffmpeg) if name == "ffmpeg" else None
        decoder = getattr(loaded["offline_decrypt"], "offline_decrypt", None)
        if not callable(decoder):
            raise BridgeError("SOURCE_LOAD_FAILED")
        yield decoder
    finally:
        sys.path[:] = previous_path
        for name, module in previous.items():
            if module is missing:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def run(request):
    """Decrypt into a private directory and publish without replacing a file."""
    if not runtime_supported():
        raise BridgeError("VERSION_UNSUPPORTED")
    source, media, output, ffmpeg = validate_request(request)
    temporary = Path(tempfile.mkdtemp(prefix=".muse-hongguo-decrypt-", dir=output.parent))
    staged = temporary / "decrypted.mp4"
    raw = staged.with_suffix(".raw.mp4")
    try:
        with suppress_original_output():
            try:
                with original_modules(source, ffmpeg) as decoder:
                    result = decoder(request["spade"], str(media), str(staged))
            except BridgeError:
                raise
            except BaseException:
                raise BridgeError("DECRYPT_FAILED") from None
        if not isinstance(result, str) or Path(result) != staged:
            raise BridgeError("DECRYPT_FAILED")
        if not staged.is_file() or staged.is_symlink() or staged.stat().st_size == 0:
            raise BridgeError("DECRYPT_FAILED")
        os.chmod(staged, 0o600)
        try:
            # A hard link publishes the complete file atomically and refuses an existing target.
            os.link(staged, output)
        except FileExistsError:
            raise BridgeError("OUTPUT_EXISTS") from None
        except OSError:
            raise BridgeError("OUTPUT_FAILED") from None
        return {"ok": True, "code": "OK"}
    finally:
        for owned in (staged, raw):
            try:
                owned.unlink(missing_ok=True)
            except OSError as _error:
                pass  # Only this private operation's explicit output files may be removed.
        try:
            temporary.rmdir()
        except OSError as _error:
            pass  # Preserve unexpected entries rather than recursively deleting other files.


def main():
    """Emit one bounded status object; source diagnostics never reach the caller."""
    try:
        request = read_request(sys.stdin.buffer)
        result = run(request)
    except BridgeError as error:
        result = {"ok": False, "code": error.code}
    except BaseException:
        result = {"ok": False, "code": "BRIDGE_FAILED"}
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
