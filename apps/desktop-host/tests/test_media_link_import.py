"""Direct media import leaves only verified, authorized project files."""

import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import textwrap
import unittest
from unittest.mock import Mock, patch


SCRIPT = Path(__file__).resolve().parents[1] / "skills" / "media-link-import" / "scripts" / "import_media.py"


def load_script():
    if not SCRIPT.is_file():
        raise AssertionError(f"missing bundled media import script: {SCRIPT}")
    spec = importlib.util.spec_from_file_location("muse_media_link_import", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeResponse(io.BytesIO):
    def __init__(self, body, content_type="video/mp4", url="https://example.com/video.mp4", length=None):
        super().__init__(body)
        self.headers = {"Content-Type": content_type}
        if length is not None:
            self.headers["Content-Length"] = str(length)
        self.url = url

    def geturl(self):
        return self.url


class MediaLinkImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="muse-media-import-")
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name) / "project"
        self.project.mkdir()
        self.module = load_script()
        self.body = b"\x00\x00\x00\x18ftypisom" + b"media" * 20

    def import_with(self, response, max_bytes=1000):
        with patch.object(self.module.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("1.1.1.1", 443))]), \
                patch.object(self.module, "open_media_url", return_value=response):
            return self.module.import_media("https://example.com/video.mp4", self.project, "episode-001.mp4", max_bytes,
                                            "user authorized project reference")

    def test_publishes_complete_mp4_in_project_and_reports_hash(self):
        result = self.import_with(FakeResponse(self.body, length=len(self.body)))
        target = self.project / "source" / "media" / "episode-001.mp4"
        self.assertEqual(target.read_bytes(), self.body)
        self.assertEqual(result["path"], str(target))
        self.assertEqual(result["bytes"], len(self.body))
        self.assertEqual(len(result["sha256"]), 64)
        self.assertNotIn("url", result)
        receipt = json.loads((target.parent / "episode-001.mp4.source.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["status"], "ready")
        self.assertEqual(receipt["source_url"], "https://example.com/video.mp4")
        self.assertEqual(receipt["authorization"], "user authorized project reference")
        self.assertEqual(receipt["sha256"], result["sha256"])
        self.assertEqual(receipt["bytes"], result["bytes"])

    def test_rejects_page_response_without_publishing_or_leaving_part(self):
        with self.assertRaisesRegex(self.module.MediaImportError, "media response"):
            self.import_with(FakeResponse(b"<html>share page</html>", "text/html"))
        self.assertFalse(list((self.project / "source" / "media").glob("*")))

    def test_rejects_stream_exceeding_limit_and_removes_part(self):
        with self.assertRaisesRegex(self.module.MediaImportError, "size limit"):
            self.import_with(FakeResponse(self.body), max_bytes=20)
        self.assertFalse(list((self.project / "source" / "media").glob("*")))

    def test_network_interruption_removes_part(self):
        class BrokenResponse(FakeResponse):
            def read(self, count=-1):
                if self.tell() > 0:
                    raise OSError("network interrupted")
                return super().read(count)

        with self.assertRaisesRegex(self.module.MediaImportError, "download failed"):
            self.import_with(BrokenResponse(self.body))
        self.assertFalse(list((self.project / "source" / "media").glob("*")))

    def test_failed_receipt_finalization_leaves_recoverable_pending_record(self):
        with patch.object(self.module.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("1.1.1.1", 443))]), \
                patch.object(self.module, "open_media_url", return_value=FakeResponse(self.body)), \
                patch.object(self.module.os, "replace", side_effect=OSError("interrupted")):
            with self.assertRaises(self.module.MediaImportError):
                self.module.import_media("https://example.com/video.mp4", self.project, "episode-001.mp4", 1000,
                                         "user authorized project reference")
        target = self.project / "source" / "media" / "episode-001.mp4"
        self.assertTrue(target.is_file())
        receipt = json.loads((target.parent / "episode-001.mp4.source.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["status"], "pending")
        self.assertEqual(receipt["sha256"], self.module.hashlib.sha256(self.body).hexdigest())
        self.assertFalse(list(target.parent.glob("*.part")))

    def test_hard_size_ceiling_cannot_be_raised_by_caller(self):
        with self.assertRaisesRegex(self.module.MediaImportError, "size limit"):
            self.module.import_media("https://example.com/video.mp4", self.project, "episode-001.mp4",
                                     2049 * 1024 * 1024, "user authorized project reference")

    def test_elapsed_download_deadline_removes_partial_media(self):
        with patch.object(self.module.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("1.1.1.1", 443))]), \
                patch.object(self.module, "open_media_url", return_value=FakeResponse(self.body)), \
                patch.object(self.module.time, "monotonic", side_effect=[0, 0, 2]):
            with self.assertRaisesRegex(self.module.MediaImportError, "time limit"):
                self.module.import_media("https://example.com/video.mp4", self.project, "episode-001.mp4", 1000,
                                         "user authorized project reference", max_seconds=1)
        self.assertFalse(list((self.project / "source" / "media").glob("*")))

    def test_existing_original_is_never_replaced(self):
        target = self.project / "source" / "media" / "episode-001.mp4"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"existing original")
        with self.assertRaisesRegex(self.module.MediaImportError, "already exists"):
            self.import_with(FakeResponse(self.body))
        self.assertEqual(target.read_bytes(), b"existing original")

    def test_rejects_insecure_and_private_addresses(self):
        for url in ("http://example.com/video.mp4", "https://127.0.0.1/video.mp4",
                    "https://192.168.1.2/video.mp4", "https://localhost/video.mp4",
                    "https://example.com/video.mp4?token=secret"):
            with self.subTest(url=url), self.assertRaises(self.module.MediaImportError):
                self.module.validate_public_https(url)
        with patch.object(self.module.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("10.0.0.5", 443))]):
            with self.assertRaisesRegex(self.module.MediaImportError, "public address"):
                self.module.validate_public_https("https://example.com/video.mp4")

    def test_redirect_to_private_host_is_rejected(self):
        address = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("1.1.1.1", 443))
        for url in ("https://127.0.0.1/internal", "http://example.com/video.mp4"):
            response = Mock(status=302)
            response.getheader.return_value = url
            connection = Mock()
            connection.getresponse.return_value = response
            with self.subTest(url=url), patch.object(self.module.socket, "getaddrinfo", return_value=[address]), \
                    patch.object(self.module, "PinnedHTTPSConnection", return_value=connection) as connection_type:
                with self.assertRaises(self.module.MediaImportError):
                    self.module.open_media_url("https://example.com/video.mp4", self.module.time.monotonic() + 300)
                connection_type.assert_called_once()
                connection.close.assert_called()

    def test_public_redirect_uses_newly_checked_address(self):
        first = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("1.1.1.1", 443))
        second = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("8.8.8.8", 443))
        redirect = Mock(status=302)
        redirect.getheader.return_value = "https://cdn.example.org/video.mp4"
        complete = Mock(status=200)
        first_connection = Mock()
        first_connection.getresponse.return_value = redirect
        second_connection = Mock()
        second_connection.getresponse.return_value = complete
        with patch.object(self.module.socket, "getaddrinfo", side_effect=[[first], [second]]), \
                patch.object(self.module, "PinnedHTTPSConnection",
                             side_effect=[first_connection, second_connection]) as connection_type:
            response = self.module.open_media_url("https://example.com/video.mp4", self.module.time.monotonic() + 300)
            self.assertEqual(response.geturl(), "https://cdn.example.org/video.mp4")
            self.assertEqual(connection_type.call_args_list[0].args[:2], ("example.com", first))
            self.assertEqual(connection_type.call_args_list[1].args[:2], ("cdn.example.org", second))
            response.__exit__(None, None, None)

    def test_media_response_reads_one_socket_chunk_at_a_time(self):
        connection = Mock()
        body = Mock()
        body.read1.return_value = b"a"
        wrapper = self.module.MediaResponse(connection, body, "https://example.com/video.mp4")
        self.assertEqual(wrapper.read(64 * 1024), b"a")
        body.read1.assert_called_once_with(64 * 1024)
        body.read.assert_not_called()

    def test_tls_socket_connects_to_prechecked_ip_without_second_dns_lookup(self):
        address = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("1.1.1.1", 443))
        rebound = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("10.0.0.5", 443))
        with patch.object(self.module.socket, "getaddrinfo", side_effect=[[address], [rebound]]) as resolver:
            host, checked_address = self.module.validate_public_https("https://example.com/video.mp4")
            with patch.object(self.module.socket, "socket") as socket_type, \
                    patch.object(self.module.ssl, "create_default_context") as context_type:
                connection = self.module.PinnedHTTPSConnection(host, checked_address, timeout=3)
                connection.connect()
                socket_type.return_value.connect.assert_called_once_with(("1.1.1.1", 443))
                context_type.return_value.wrap_socket.assert_called_once_with(socket_type.return_value, server_hostname=host)
            resolver.assert_called_once()

    def test_rejects_windows_junction_at_media_directory(self):
        original = Path.is_junction
        with patch.object(Path, "is_junction", lambda path: path.name == "media" or original(path)):
            with self.assertRaisesRegex(self.module.MediaImportError, "reparse"):
                self.module.output_path(self.project, "episode-001.mp4")

    def test_supervisor_terminates_slow_response_headers(self):
        self.assert_supervisor_stops_blocked_worker("headers")

    def test_supervisor_terminates_slow_body_and_cleans_part(self):
        self.assert_supervisor_stops_blocked_worker("body")

    def assert_supervisor_stops_blocked_worker(self, stage):
        marker = Path(self.temp.name) / f"{stage}.entered"
        fixture = Path(self.temp.name) / f"{stage}_worker.py"
        fixture.write_text(textwrap.dedent(f"""
            import importlib.util
            import json
            import os
            from pathlib import Path
            import socket
            import time

            script = Path({str(SCRIPT)!r})
            spec = importlib.util.spec_from_file_location("muse_media_link_import_worker", script)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            module.socket.getaddrinfo = lambda *args, **kwargs: [
                (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("1.1.1.1", 443))]
            marker = Path({str(marker)!r})
            stage = {stage!r}

            class Socket:
                def settimeout(self, seconds):
                    pass

            class Response:
                status = 200
                headers = {{"Content-Type": "video/mp4"}}
                calls = 0

                def read1(self, count):
                    self.calls += 1
                    if self.calls == 1:
                        return b"\\x00\\x00\\x00\\x18ftypisom"
                    marker.write_text(str(os.getpid()))
                    time.sleep(30)
                    return b""

                def close(self):
                    pass

            class Connection:
                def __init__(self, *args, **kwargs):
                    self.sock = Socket()

                def request(self, *args, **kwargs):
                    pass

                def getresponse(self):
                    if stage == "headers":
                        marker.write_text(str(os.getpid()))
                        time.sleep(30)
                    return Response()

                def close(self):
                    pass

            module.PinnedHTTPSConnection = Connection
            module.worker_main()
        """), encoding="utf-8")
        with patch.object(self.module, "__file__", str(fixture)):
            with self.assertRaisesRegex(self.module.MediaImportError, "time limit"):
                self.module.run_supervised_import("https://example.com/video.mp4", self.project,
                                                  "episode-001.mp4", 1000,
                                                  "user authorized project reference", max_seconds=3)
        self.assertTrue(marker.is_file(), "worker must reach the blocked network phase")
        media = self.project / "source" / "media"
        self.assertFalse(list(media.glob("*.part")))
        self.assertFalse((media / "episode-001.mp4").exists())


if __name__ == "__main__":
    unittest.main()
