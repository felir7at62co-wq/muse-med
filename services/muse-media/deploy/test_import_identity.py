"""Identity import input handling and server-side reporting without a platform or server."""

import importlib.util
import io
import json
import os
from pathlib import Path
import pty
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("import_identity", Path(__file__).with_name("import-identity.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReadHiddenTests(unittest.TestCase):
    def test_terminal_line_longer_than_the_canonical_limit_arrives_whole(self):
        leader, follower = pty.openpty()
        value = "ttwid=" + "x" * 7000
        # The paste arrives after the prompt, once the terminal has left canonical mode.
        paste = threading.Timer(0.3, os.write, (leader, b"\x1b[200~" + value.encode() + b"\x1b[201~\r"))
        paste.start()
        with open(follower, "rb", buffering=0, closefd=False) as stream, redirect_stdout(io.StringIO()):
            original = os.dup(0)
            os.dup2(stream.fileno(), 0)
            try:
                received = module.read_hidden("cookie: ")
            finally:
                os.dup2(original, 0)
                os.close(original)
        os.close(leader)
        os.close(follower)
        self.assertEqual(received, value)


class ServerImportTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        tests = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def reply(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])) or b"{}")
                tests.calls.append((self.path, body))
                if self.path == "/api/v1/auth/login":
                    return self.reply(200, {"success": True})
                if self.path == "/api/v1/admin/identities/import":
                    report = {"detected_format": "header", "detected_platform": "douyin", "browser_family": "chrome", "browser_major": 157,
                              "authenticated": "sessionid" in body["cookies"], "expires_at": None, "missing_required": [], "warning_codes": [], "usable": True}
                    if body["dry_run"]:
                        return self.reply(200, {"success": True, "data": {"stored": False, "report": report}})
                    return self.reply(201, {"success": True, "data": {"stored": True, "identity_id": "identity-1", "report": report}})
                return self.reply(202, {"success": True, "data": {"task_id": "task-1"}})

            def do_GET(self):
                tests.calls.append((self.path, None))
                self.reply(200, {"success": True, "data": {"state": "done", "data": {"reason": "live", "account_id": "1"}}})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.directory = tempfile.TemporaryDirectory()
        self.admin = Path(self.directory.name) / "admin.json"
        self.admin.write_text(json.dumps({"username": "admin", "password": "private-admin-password"}))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.directory.cleanup()

    def run_import(self, cookies):
        output = io.StringIO()
        module.time.sleep = lambda _seconds: None
        with redirect_stdout(output):
            status = module.server_import({"cookies": cookies, "user_agent": "Mozilla/5.0 Chrome/157.0.0.0", "note": "note"}, self.admin, self.base)
        return status, output.getvalue()

    def test_logged_in_jar_is_previewed_stored_reserved_and_checked(self):
        status, output = self.run_import("ttwid=a; sessionid=private-session")
        self.assertEqual(status, 0)
        paths = [path for path, _ in self.calls]
        self.assertEqual(paths, ["/api/v1/auth/login", "/api/v1/admin/identities/import", "/api/v1/admin/identities/import",
                                 "/api/v1/admin/identities/identity-1/session", "/api/v1/tasks/task-1"])
        self.assertTrue(self.calls[1][1]["dry_run"] and self.calls[1][1]["reserved"])
        self.assertFalse(self.calls[2][1]["dry_run"])
        self.assertIn("identity-1", output)
        self.assertIn("live", output)
        self.assertNotIn("private-session", output)
        self.assertNotIn("private-admin-password", output)

    def test_jar_without_a_login_is_not_stored(self):
        status, _output = self.run_import("ttwid=a")
        self.assertEqual(status, 1)
        self.assertEqual([path for path, _ in self.calls], ["/api/v1/auth/login", "/api/v1/admin/identities/import"])


if __name__ == "__main__":
    unittest.main()
