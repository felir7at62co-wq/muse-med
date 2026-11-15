"""Exercise readiness worker deadlines with owned real loopback streams."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import subprocess
import threading
import time
import unittest
from unittest.mock import patch

import verify


class ProbeServer(ThreadingHTTPServer):
    """Own streaming handlers until all connections and their threads stop."""

    daemon_threads = False
    block_on_close = True

    def __init__(self, mode):
        super().__init__(("127.0.0.1", 0), ProbeHandler)
        self.mode = mode
        self.stop_stream = threading.Event()
        self.entered = threading.Event()
        self.observed = []
        self.errors = []

    def handle_error(self, request, client_address):
        self.errors.append("readiness fixture handler failed")


class ProbeHandler(BaseHTTPRequestHandler):
    """Keep incomplete responses active so per-socket idle timeouts cannot suffice."""

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        self.server.observed.append((self.path, self.headers.get("Authorization"),
                                     self.headers.get("Cookie")))
        try:
            if self.server.mode == "headers":
                self.connection.sendall(b"HTTP/1.1 200 ")
            else:
                body = b'{"status":"ok"}' if self.server.mode == "ready" else b'{"waiting":"'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body) if self.server.mode == "ready" else 1048576))
                self.end_headers()
                self.wfile.write(body)
                self.wfile.flush()
            self.server.entered.set()
            if self.server.mode == "ready":
                return
            # Continuous traffic prevents an idle timeout while the parent owns the total deadline.
            while not self.server.stop_stream.wait(0.02):
                self.connection.sendall(b" " if self.server.mode == "headers" else b"x")
        except ConnectionError:
            # The readiness parent killed and reaped the client before the stream completed.
            return


@contextmanager
def probe_server(mode):
    """Yield an allocated loopback server and await every handler on exit."""
    server = ProbeServer(mode)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02})
    thread.start()
    try:
        yield server
    finally:
        server.stop_stream.set()
        server.shutdown()
        server.server_close()
        thread.join()
        if thread.is_alive():
            raise AssertionError("readiness fixture server did not stop")
        if server.errors:
            raise AssertionError(server.errors)


@contextmanager
def recorded_workers():
    """Observe real child handles without replacing process execution."""
    workers = []
    original = subprocess.Popen

    def record(*args, **kwargs):
        worker = original(*args, **kwargs)
        workers.append(worker)
        return worker

    try:
        with patch.object(verify.subprocess, "Popen", record):
            yield workers
    finally:
        for worker in workers:
            if worker.poll() is None:
                worker.kill()
                worker.wait()


class ReadinessProcessTests(unittest.TestCase):
    def test_ready_response_exits_the_real_anonymous_worker(self):
        with probe_server("ready") as server:
            with recorded_workers() as workers:
                verify.wait_ready(f"http://127.0.0.1:{server.server_port}", timeout=5)
                self.assertTrue(server.entered.is_set(), "the probe must reach the owned HTTP service")
                self.assertGreaterEqual(len(workers), 1)
                self.assertTrue(all(worker.poll() == 0 for worker in workers),
                                "successful workers must exit and be reaped before returning")
            self.assertEqual(server.observed, [("/readyz", None, None)])

    def assert_trickle_deadline(self, mode):
        with probe_server(mode) as server:
            watchdog_fired = threading.Event()

            def release_stream():
                watchdog_fired.set()
                server.stop_stream.set()

            # A broken I/O deadline must fail this test instead of hanging the test runner.
            watchdog = threading.Timer(8, release_stream)
            watchdog.start()
            try:
                with recorded_workers() as workers:
                    started = time.monotonic()
                    with self.assertRaisesRegex(RuntimeError, "ready|readiness|deadline"):
                        verify.wait_ready(f"http://127.0.0.1:{server.server_port}", timeout=5)
                    elapsed = time.monotonic() - started
                    self.assertTrue(server.entered.is_set(), "the incomplete response must actually be read")
                    self.assertFalse(watchdog_fired.is_set(), "only the product deadline may end the probe")
                    self.assertLess(elapsed, 8, "continuous traffic must not extend the parent deadline")
                    self.assertGreaterEqual(len(workers), 1)
                    self.assertTrue(all(worker.poll() is not None for worker in workers),
                                    "timed-out children must be reaped before the failure is reported")
                    self.assertTrue(all(worker.returncode != 0 for worker in workers),
                                    "an incomplete HTTP response cannot report a successful probe")
                self.assertTrue(server.observed)
                self.assertTrue(all(row == ("/readyz", None, None) for row in server.observed))
            finally:
                watchdog.cancel()
                watchdog.join()

    def test_trickling_headers_cannot_extend_the_total_deadline(self):
        self.assert_trickle_deadline("headers")

    def test_trickling_json_body_cannot_extend_the_total_deadline(self):
        self.assert_trickle_deadline("body")


if __name__ == "__main__":
    unittest.main()
