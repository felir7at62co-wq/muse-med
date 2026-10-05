"""Check bridge validation, secret suppression and exclusive publication without live APIs."""

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
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "python" / "decrypt.py"
SPEC = importlib.util.spec_from_file_location("muse_decrypt_bridge", SCRIPT)
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


class BridgeFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="muse-decrypt-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.app = self.root / "app"
        self.source = self.app / "frida"
        self.source.mkdir(parents=True)
        for name in BRIDGE.MODULE_NAMES:
            (self.source / (name + ".pyc")).write_bytes(BRIDGE.CPYTHON_311_MAGIC + b"\0" * 12)
        self.media = self.root / "encrypted.mp4"
        self.media.write_bytes(b"encrypted fixture")
        self.ffmpeg = self.root / "ffmpeg"
        self.ffmpeg.write_bytes(b"fixture executable, never executed")
        self.ffmpeg.chmod(0o700)
        self.output = self.root / "result.mp4"
        self.request = {
            "appDir": str(self.app), "spade": "UFJJVkFURV9TUEFERQ==",
            "input": str(self.media), "output": str(self.output), "ffmpeg": str(self.ffmpeg)
        }

    def assert_code(self, code, operation):
        with self.assertRaises(BRIDGE.BridgeError) as raised:
            operation()
        self.assertEqual(raised.exception.code, code)


class BridgeValidationTests(BridgeFixture):

    def test_request_size_schema_and_base64_are_rejected_before_file_access(self):
        invalid = [b"{" + b"x" * BRIDGE.MAX_REQUEST_BYTES, b"[]", b'{"spade":"PRIVATE"}']
        for raw in invalid:
            self.assert_code("BAD_REQUEST", lambda raw=raw: BRIDGE.read_request(io.BytesIO(raw)))
        for field, value in (("spade", "PRIVATE!"), ("input", False), ("ffmpeg", "bad\0path")):
            request = dict(self.request, **{field: value})
            self.assert_code("BAD_REQUEST", lambda request=request: BRIDGE.read_request(io.BytesIO(json.dumps(request).encode())))

    def test_absolute_paths_are_required(self):
        for name in ("appDir", "input", "output", "ffmpeg"):
            self.assert_code("UNSAFE_PATH", lambda name=name: BRIDGE.validate_request(dict(self.request, **{name: "relative"})))

    def test_source_only_directory_is_not_imported(self):
        (self.source / "offline_decrypt.pyc").unlink()
        (self.source / "offline_decrypt.py").write_text("raise RuntimeError('PRIVATE')", encoding="utf-8")
        self.assert_code("SOURCE_UNAVAILABLE", lambda: BRIDGE.validate_request(self.request))
        self.assertEqual(self.media.read_bytes(), b"encrypted fixture")

    def test_other_bytecode_version_is_rejected(self):
        (self.source / "oracle.pyc").write_bytes(b"wrong magic header")
        self.assert_code("SOURCE_VERSION_UNSUPPORTED", lambda: BRIDGE.validate_request(self.request))

    def test_existing_output_is_preserved(self):
        self.output.write_bytes(b"existing output")
        raw = self.output.with_suffix(".raw.mp4")
        raw.write_bytes(b"existing raw")
        self.assert_code("OUTPUT_EXISTS", lambda: BRIDGE.validate_request(self.request))
        self.assertEqual(self.output.read_bytes(), b"existing output")
        self.assertEqual(raw.read_bytes(), b"existing raw")

    def test_input_and_source_files_cannot_be_output(self):
        self.assert_code("UNSAFE_PATH", lambda: BRIDGE.validate_request(dict(self.request, output=str(self.media))))
        self.assert_code("UNSAFE_PATH", lambda: BRIDGE.validate_request(dict(self.request, output=str(self.source / "new.mp4"))))

    def test_missing_media_and_non_executable_ffmpeg_are_rejected(self):
        self.media.unlink()
        self.assert_code("INPUT_UNAVAILABLE", lambda: BRIDGE.validate_request(self.request))
        self.media.write_bytes(b"encrypted fixture")
        self.ffmpeg.unlink()
        self.ffmpeg.mkdir()
        self.assert_code("FFMPEG_UNAVAILABLE", lambda: BRIDGE.validate_request(self.request))

    @unittest.skipIf(os.name == "nt", "Windows symlink creation requires optional host privileges")
    def test_symlinked_source_and_input_are_rejected(self):
        module = self.source / "oracle.pyc"
        copy = self.root / "copy.pyc"
        module.rename(copy)
        module.symlink_to(copy)
        self.assert_code("SOURCE_UNAVAILABLE", lambda: BRIDGE.validate_request(self.request))
        module.unlink()
        copy.rename(module)
        linked = self.root / "linked.mp4"
        linked.symlink_to(self.media)
        self.assert_code("INPUT_UNAVAILABLE", lambda: BRIDGE.validate_request(dict(self.request, input=str(linked))))

    @unittest.skipIf(BRIDGE.runtime_supported(), "Version rejection is only applicable outside real CPython 3.11")
    def test_unsupported_runtime_refuses_import_and_reports_only_fixed_status(self):
        result = subprocess.run([sys.executable, "-I", "-B", str(SCRIPT)],
                                input=json.dumps(self.request), text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {"ok": False, "code": "VERSION_UNSUPPORTED"})
        self.assertEqual(result.stderr, "")
        self.assertFalse(self.output.exists())


@unittest.skipUnless(BRIDGE.runtime_supported(), "The original .pyc execution path requires actual CPython 3.11")
class BridgeExecutionTests(BridgeFixture):
    def prepare_modules(self, body):
        sources = {
            "extract_keybox_pairs": "print('PRIVATE_INITIALIZATION')\n",
            "unwrap_spade": "import os\nos.write(2, b'PRIVATE_NATIVE')\n",
            "oracle": "import extract_keybox_pairs\n",
            "decutil": "def _ff_exe(name):\n    raise RuntimeError('unconfigured')\n",
            "offline_decrypt": "import os, sys\nfrom pathlib import Path\nimport decutil\n"
                "def offline_decrypt(spade, input_path, output_path):\n"
                "    print(spade)\n    print('PRIVATE_KEY', file=sys.stderr)\n"
                "    assert decutil._ff_exe('ffmpeg') == " + repr(str(self.ffmpeg)) + "\n"
                "    assert decutil._ff_exe('ffprobe') is None\n" + body
        }
        for name, source in sources.items():
            file = self.source / (name + ".py")
            file.write_text(source, encoding="utf-8")
            py_compile.compile(str(file), cfile=str(self.source / (name + ".pyc")), doraise=True)
            file.unlink()

    def invoke(self):
        result = subprocess.run([sys.executable, "-I", "-B", str(SCRIPT)],
                                input=json.dumps(self.request), text=True, capture_output=True, timeout=15)
        self.assertEqual(result.stderr, "")
        self.assertNotIn("PRIVATE", result.stdout)
        self.assertNotIn(self.request["spade"], result.stdout)
        self.assertNotIn(str(self.root), result.stdout)
        self.assertLess(len(result.stdout), 128)
        self.assertEqual(list(self.root.glob(".muse-hongguo-decrypt-*")), [])
        return result, json.loads(result.stdout)

    def test_private_initialization_and_function_output_are_suppressed(self):
        self.prepare_modules("    Path(output_path).write_bytes(b'new media')\n"
                             "    Path(output_path).with_suffix('.raw.mp4').write_bytes(b'owned raw')\n"
                             "    return output_path\n")
        raw = self.output.with_suffix(".raw.mp4")
        raw.write_bytes(b"unrelated preexisting raw")
        result, status = self.invoke()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(status, {"ok": True, "code": "OK"})
        self.assertEqual(self.output.read_bytes(), b"new media")
        self.assertEqual(raw.read_bytes(), b"unrelated preexisting raw")

    def test_failed_decoder_cleans_owned_files_and_retains_input(self):
        self.prepare_modules("    Path(output_path).write_bytes(b'partial')\n"
                             "    Path(output_path).with_suffix('.raw.mp4').write_bytes(b'partial raw')\n"
                             "    raise RuntimeError('PRIVATE_EXCEPTION')\n")
        result, status = self.invoke()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(status, {"ok": False, "code": "DECRYPT_FAILED"})
        self.assertFalse(self.output.exists())
        self.assertEqual(self.media.read_bytes(), b"encrypted fixture")

    def test_a_part_target_uses_an_mp4_name_for_original_ffmpeg_remux(self):
        self.output = self.root / "result.decoded.part"
        self.request["output"] = str(self.output)
        self.prepare_modules("    assert output_path.endswith('.mp4')\n"
                             "    Path(output_path).write_bytes(b'new media')\n"
                             "    return output_path\n")
        _, status = self.invoke()
        self.assertEqual(status, {"ok": True, "code": "OK"})
        self.assertEqual(self.output.read_bytes(), b"new media")

    def test_raw_fallback_is_not_published_as_completed_media(self):
        self.prepare_modules("    raw = Path(output_path).with_suffix('.raw.mp4')\n"
                             "    raw.write_bytes(b'raw media')\n    return str(raw)\n")
        _, status = self.invoke()
        self.assertEqual(status, {"ok": False, "code": "DECRYPT_FAILED"})
        self.assertFalse(self.output.exists())

    def test_target_created_during_decode_is_not_replaced_or_deleted(self):
        self.prepare_modules("    Path(output_path).write_bytes(b'new media')\n"
                             "    Path(" + repr(str(self.output)) + ").write_bytes(b'other owner')\n"
                             "    return output_path\n")
        _, status = self.invoke()
        self.assertEqual(status, {"ok": False, "code": "OUTPUT_EXISTS"})
        self.assertEqual(self.output.read_bytes(), b"other owner")

    def test_fd_stdout_and_stderr_are_restored_after_a_suppressed_exception(self):
        code = "import runpy, os\nb = runpy.run_path(" + repr(str(SCRIPT)) + ")\n"
        code += "try:\n    with b['suppress_original_output']():\n"
        code += "        os.write(1, b'PRIVATE_STDOUT')\n        os.write(2, b'PRIVATE_STDERR')\n"
        code += "        raise ValueError('PRIVATE_EXCEPTION')\nexcept ValueError:\n    pass\n"
        code += "os.write(1, b'PUBLIC_STDOUT')\nos.write(2, b'PUBLIC_STDERR')\n"
        result = subprocess.run([sys.executable, "-I", "-B", "-c", code],
                                text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "PUBLIC_STDOUT")
        self.assertEqual(result.stderr, "PUBLIC_STDERR")

    def test_process_cancellation_preserves_input_and_another_owners_target(self):
        ready = self.root / "ready"
        self.prepare_modules("    Path(output_path).write_bytes(b'partial')\n"
                             "    Path(" + repr(str(ready)) + ").write_bytes(b'ready')\n"
                             "    import threading\n    threading.Event().wait()\n")
        child = subprocess.Popen([sys.executable, "-I", "-B", str(SCRIPT)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True)
        try:
            child.stdin.write(json.dumps(self.request))
            child.stdin.close()
            deadline = time.monotonic() + 15
            while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(ready.exists(), "The isolated decoder must reach the cancellation state")
            self.output.write_bytes(b"other owner")
            child.terminate()
            child.wait(timeout=15)
            self.assertNotEqual(child.returncode, 0)
            self.assertEqual(self.output.read_bytes(), b"other owner")
            self.assertEqual(self.media.read_bytes(), b"encrypted fixture")
            self.assertEqual(child.stdout.read(), "")
            self.assertEqual(child.stderr.read(), "")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=15)
            for handle in (child.stdin, child.stdout, child.stderr):
                handle.close()


if __name__ == "__main__":
    unittest.main()
