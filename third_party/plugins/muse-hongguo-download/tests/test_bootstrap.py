"""Check private device initialization with isolated, keyless bytecode fixtures."""

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import py_compile
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "python" / "bootstrap.py"
SPEC = importlib.util.spec_from_file_location("muse_bootstrap_bridge", SCRIPT)
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)
INVOKE = """import importlib.util, sys
spec = importlib.util.spec_from_file_location('isolated_bootstrap', sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
bridge.SOURCE_SHA256 = sys.argv[2]
sys.exit(bridge.main())
"""


class BootstrapFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="muse-bootstrap-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.app = self.root / "app"
        self.app.mkdir(mode=0o700)
        self.request = {"appDir": str(self.app)}
        self.config = {"api_host": "catalog.example", "base_query": {"app_name": "fixture", "os": "android"},
                       "session_headers": {"sdk-version": "fixture"}}
        self.write_config()

    def write_config(self):
        (self.app / "config.json").write_text(json.dumps(self.config), encoding="utf-8")

    def assert_code(self, code, operation):
        with self.assertRaises(BRIDGE.BridgeError) as raised:
            operation()
        self.assertEqual(raised.exception.code, code)

    def prepare_source(self, before="", body=""):
        source = self.app / "devicepool.py"
        source.write_text("import os, secrets, uuid\n" + before + "\n"
                          "def gen_device(template):\n"
                          "    assert template == {}\n" + body +
                          "    return {'query': {'device_id': str(10**15 + secrets.randbelow(9 * 10**15)),\n"
                          "      'iid': str(10**15 + secrets.randbelow(9 * 10**15)), 'cdid': str(uuid.uuid4()),\n"
                          "      'device_brand': 'fixture', 'device_type': 'fixture', 'resolution': '1*1',\n"
                          "      'os_version': '1', 'os_api': '1', 'rom_version': 'fixture'},\n"
                          "      'user_agent': 'fixture-agent'}\n", encoding="utf-8")
        bytecode = self.app / "devicepool.pyc"
        py_compile.compile(str(source), cfile=str(bytecode), doraise=True)
        source.unlink()
        self.source_hash = hashlib.sha256(bytecode.read_bytes()).hexdigest()

    def invoke(self):
        result = subprocess.run([sys.executable, "-I", "-B", "-c", INVOKE, str(SCRIPT), self.source_hash],
                                input=json.dumps(self.request), text=True, capture_output=True, timeout=60)
        self.assertEqual(result.stderr, "")
        self.assertNotIn("PRIVATE", result.stdout)
        self.assertNotIn(str(self.root), result.stdout)
        self.assertLess(len(result.stdout), 128)
        self.assertEqual(list(self.app.glob(".muse-hongguo-devices-*")), [])
        return result, json.loads(result.stdout)


class BootstrapValidationTests(BootstrapFixture):
    def test_request_is_bounded_and_accepts_only_one_absolute_path_field(self):
        for raw in (b"{" + b"x" * BRIDGE.MAX_REQUEST_BYTES, b"[]", b"{}", b'{"appDir":true}',
                    b'{"appDir":"x","extra":1}', b'{"appDir":"a\\u0000b"}', b"\xff"):
            self.assert_code("BAD_REQUEST", lambda raw=raw: BRIDGE.read_request(io.BytesIO(raw)))
        self.assertEqual(BRIDGE.read_request(io.BytesIO(json.dumps(self.request).encode())), self.request)
        self.assert_code("UNSAFE_PATH", lambda: BRIDGE.app_directory("relative"))
        self.assert_code("UNSAFE_PATH", lambda: BRIDGE.app_directory(str(self.app / ".." / "app")))

    def test_config_rejects_device_identifiers_and_credential_headers(self):
        for key in ("device_id", "iid", "cdid", "android_id", "openudid", "session_id"):
            with self.subTest(key=key):
                self.config["base_query"][key] = "PRIVATE_VALUE"
                self.write_config()
                self.assert_code("CONFIG_INVALID", lambda: BRIDGE.validate_config(self.app))
                del self.config["base_query"][key]
        for key in ("Cookie", "x-tt-token", "Authorization", "X-Api-Key", "user-agent"):
            with self.subTest(key=key):
                self.config["session_headers"][key] = "PRIVATE_VALUE"
                self.write_config()
                self.assert_code("CONFIG_INVALID", lambda: BRIDGE.validate_config(self.app))
                del self.config["session_headers"][key]

    def test_missing_invalid_and_oversized_config_fail_without_devices(self):
        file = self.app / "config.json"
        for data in (b"[]", b"not JSON", b"x" * (BRIDGE.MAX_CONFIG_BYTES + 1)):
            file.write_bytes(data)
            self.assert_code("CONFIG_INVALID", lambda: BRIDGE.validate_config(self.app))
        file.unlink()
        self.assert_code("CONFIG_INVALID", lambda: BRIDGE.validate_config(self.app))
        self.assertFalse((self.app / "devices.json").exists())

    def test_config_rejects_nested_values_and_header_line_breaks(self):
        self.config["base_query"]["os"] = {"private": "value"}
        self.write_config()
        self.assert_code("CONFIG_INVALID", lambda: BRIDGE.validate_config(self.app))
        self.config["base_query"]["os"] = "android"
        self.config["session_headers"]["sdk-version"] = "value\r\nPRIVATE"
        self.write_config()
        self.assert_code("CONFIG_INVALID", lambda: BRIDGE.validate_config(self.app))

    def test_invalid_existing_devices_are_never_regenerated(self):
        file = self.app / "devices.json"
        for data in (b"[]", b"not JSON", b"x" * (BRIDGE.MAX_CONFIG_BYTES + 1), b'[{}]'):
            file.write_bytes(data)
            file.chmod(0o600)
            self.assert_code("DEVICES_INVALID", lambda: BRIDGE.existing_devices(self.app))
            self.assertEqual(file.read_bytes(), data)

    def test_other_runtime_fails_before_source_or_configuration_access(self):
        with patch.object(BRIDGE, "runtime_supported", return_value=False):
            self.assert_code("VERSION_UNSUPPORTED", lambda: BRIDGE.run({"appDir": "/missing"}))

    @unittest.skipIf(os.name == "nt", "Windows symlinks require optional host privileges")
    def test_symlinked_app_config_module_and_devices_are_rejected(self):
        linked = self.root / "linked"
        linked.symlink_to(self.app, target_is_directory=True)
        self.assert_code("UNSAFE_PATH", lambda: BRIDGE.app_directory(str(linked)))
        for name, code, operation in (
            ("config.json", "CONFIG_INVALID", lambda: BRIDGE.validate_config(self.app)),
            ("devicepool.pyc", "SOURCE_UNAVAILABLE", lambda: BRIDGE.generate_device(self.app)),
            ("devices.json", "DEVICES_INVALID", lambda: BRIDGE.existing_devices(self.app)),
        ):
            with self.subTest(name=name):
                target = self.app / name
                if target.exists():
                    target.unlink()
                target.symlink_to(self.root / "absent")
                self.assert_code(code, operation)
                target.unlink()


@unittest.skipUnless(BRIDGE.runtime_supported(), "Original module execution requires CPython 3.11")
class BootstrapExecutionTests(BootstrapFixture):
    def test_generator_output_is_private_and_existing_devices_are_retained(self):
        calls = self.root / "calls"
        self.prepare_source("print('PRIVATE_IMPORT')\nos.write(2, b'PRIVATE_NATIVE')\n",
                            "    print('PRIVATE_DEVICE')\n"
                            "    with open(" + repr(str(calls)) + ", 'a') as stream:\n        stream.write('call\\n')\n")
        result, status = self.invoke()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(status, {"ok": True, "code": "OK"})
        device_path = self.app / "devices.json"
        saved = device_path.read_bytes()
        BRIDGE.validate_devices(json.loads(saved))
        if os.name != "nt":
            self.assertEqual(device_path.stat().st_mode & 0o777, 0o600)
        result, status = self.invoke()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(status, {"ok": True, "code": "OK"})
        self.assertEqual(device_path.read_bytes(), saved)
        self.assertEqual(calls.read_text(), "call\n")

    def test_unpinned_and_other_version_bytecode_are_not_executed(self):
        self.prepare_source("raise RuntimeError('PRIVATE_IMPORT')")
        self.assert_code("SOURCE_HASH_MISMATCH", lambda: BRIDGE.generate_device(self.app))
        bytecode = self.app / "devicepool.pyc"
        bytecode.write_bytes(b"wrong magic" + b"\0" * 16)
        self.assert_code("SOURCE_VERSION_UNSUPPORTED", lambda: BRIDGE.generate_device(self.app))
        self.assertFalse((self.app / "devices.json").exists())

    def test_module_state_is_restored_after_success_and_failure(self):
        previous = types.ModuleType("devicepool")
        missing = object()
        original = sys.modules.get("devicepool", missing)
        sys.modules["devicepool"] = previous
        try:
            for body, code in (("", None), ("    raise RuntimeError('PRIVATE_EXCEPTION')\n", "GENERATION_FAILED")):
                self.prepare_source(body=body)
                with patch.object(BRIDGE, "SOURCE_SHA256", self.source_hash):
                    if code:
                        self.assert_code(code, lambda: BRIDGE.generate_device(self.app))
                    else:
                        BRIDGE.validate_devices(BRIDGE.generate_device(self.app))
                self.assertIs(sys.modules["devicepool"], previous)
        finally:
            if original is missing:
                sys.modules.pop("devicepool", None)
            else:
                sys.modules["devicepool"] = original

    def test_failed_initialization_and_invalid_generator_output_are_sanitized(self):
        for before, body, code in (
            ("raise RuntimeError('PRIVATE_EXCEPTION')", "", "SOURCE_LOAD_FAILED"),
            ("", "    return {'private': 'PRIVATE_VALUE'}\n", "DEVICES_INVALID"),
            ("", "    raise RuntimeError('PRIVATE_EXCEPTION')\n", "GENERATION_FAILED"),
        ):
            with self.subTest(code=code):
                self.prepare_source(before, body)
                result, status = self.invoke()
                self.assertEqual(result.returncode, 1)
                self.assertEqual(status, {"ok": False, "code": code})
                self.assertFalse((self.app / "devices.json").exists())

    def test_existing_invalid_file_blocks_the_generator(self):
        self.prepare_source("raise RuntimeError('PRIVATE_IMPORT')")
        file = self.app / "devices.json"
        file.write_bytes(b"invalid original file")
        file.chmod(0o600)
        result, status = self.invoke()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(status, {"ok": False, "code": "DEVICES_INVALID"})
        self.assertEqual(file.read_bytes(), b"invalid original file")

    def test_two_processes_publish_one_stable_device_without_overwriting(self):
        release = self.root / "release"
        self.prepare_source(body="    import pathlib, time\n"
                            "    pathlib.Path(" + repr(str(self.root)) + ", 'ready-' + str(os.getpid())).touch()\n"
                            "    while not pathlib.Path(" + repr(str(release)) + ").exists():\n        time.sleep(0.01)\n")
        children = []

        def cleanup(child):
            if child.poll() is None:
                child.kill()
                child.wait(timeout=60)
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream:
                    stream.close()

        for _ in range(2):
            child = subprocess.Popen([sys.executable, "-I", "-B", "-c", INVOKE, str(SCRIPT), self.source_hash],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.addCleanup(cleanup, child)
            children.append(child)
            child.stdin.write(json.dumps(self.request))
            child.stdin.close()
            child.stdin = None
        deadline = time.monotonic() + 60
        while len(list(self.root.glob("ready-*"))) < 2 and all(child.poll() is None for child in children):
            if time.monotonic() >= deadline:
                self.fail("Both isolated generators must reach publication before release")
            time.sleep(0.01)
        self.assertEqual(len(list(self.root.glob("ready-*"))), 2)
        release.touch()
        for child in children:
            stdout, stderr = child.communicate(timeout=60)
            self.assertEqual(child.returncode, 0)
            self.assertEqual(stderr, "")
            self.assertEqual(json.loads(stdout), {"ok": True, "code": "OK"})
        saved = (self.app / "devices.json").read_bytes()
        BRIDGE.validate_devices(json.loads(saved))
        self.assertEqual(list(self.app.glob(".muse-hongguo-devices-*")), [])
        self.invoke()
        self.assertEqual((self.app / "devices.json").read_bytes(), saved)


if __name__ == "__main__":
    unittest.main()
