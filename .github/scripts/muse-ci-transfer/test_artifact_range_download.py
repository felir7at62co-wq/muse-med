"""Keyless rejection checks for the private artifact downloader."""

import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import artifact_range_download as downloader


class ValidationTests(unittest.TestCase):
    def headers(self, **changes):
        return {"Content-Range": "bytes 0-3/4", "Content-Length": "4", "ETag": '"same"', **changes}

    def test_accepts_exact_partial_response(self):
        self.assertEqual(downloader.validate_range(206, self.headers(), 0, 3, 4), '"same"')

    def test_rejects_full_response_instead_of_range(self):
        with self.assertRaisesRegex(downloader.ProtocolError, "required 206"):
            downloader.validate_range(200, self.headers(), 0, 3, 4)

    def test_rejects_wrong_range_total(self):
        with self.assertRaisesRegex(downloader.ProtocolError, "Content-Range"):
            downloader.validate_range(206, self.headers(**{"Content-Range": "bytes 0-3/5"}), 0, 3, 4)

    def test_rejects_wrong_range_length(self):
        with self.assertRaisesRegex(downloader.ProtocolError, "Content-Length"):
            downloader.validate_range(206, self.headers(**{"Content-Length": "5"}), 0, 3, 4)

    def test_rejects_changed_etag(self):
        with self.assertRaisesRegex(downloader.ProtocolError, "ETag changed"):
            downloader.validate_range(206, self.headers(), 0, 3, 4, '"different"')

    def test_rejects_weak_etag(self):
        with self.assertRaisesRegex(downloader.ProtocolError, "strong ETag"):
            downloader.validate_range(206, self.headers(**{"ETag": 'W/"same"'}), 0, 3, 4)

    def test_rejects_unavailable_artifact_digest(self):
        with self.assertRaises(downloader.ProtocolError):
            downloader.require_digest(None)

    def test_rejects_complete_zip_with_wrong_size(self):
        with tempfile.TemporaryDirectory(dir=downloader.ROOT) as temporary:
            archive = Path(temporary) / "fake.zip"
            archive.write_bytes(b"zip!")
            with self.assertRaisesRegex(downloader.ProtocolError, "incorrect size"):
                downloader.verify_archive(archive, 5, hashlib.sha256(b"zip!").hexdigest())

    def test_rejects_complete_zip_with_wrong_hash(self):
        with tempfile.TemporaryDirectory(dir=downloader.ROOT) as temporary:
            archive = Path(temporary) / "fake.zip"
            archive.write_bytes(b"zip!")
            with self.assertRaisesRegex(downloader.ProtocolError, "SHA-256"):
                downloader.verify_archive(archive, 4, hashlib.sha256(b"oops").hexdigest())


class FakeResponse:
    def __init__(self, status, data):
        self.status = status
        self.headers = {"Content-Range": "bytes 0-3/4", "Content-Length": "4", "ETag": '"same"'}
        self.data = io.BytesIO(data)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, count):
        return self.data.read(count)


class FakeArchive:
    def signed_url(self):
        return "https://example.test/archive?sig=memory-only", 0


class FakeOpener:
    def __init__(self, response):
        self.response = response
        self.request = None

    def open(self, request, timeout):
        self.request = request
        return self.response


class TransferTests(unittest.TestCase):
    def transfer(self, directory, status=206, data=b"zip!"):
        opener = FakeOpener(FakeResponse(status, data))
        result = downloader.fetch_chunk(FakeArchive(), opener, directory, 0, 0, 3, 4, None, 10)
        self.assertIsNone(opener.request.get_header("Authorization"))
        return result

    def test_actual_range_request_has_no_authorization(self):
        with tempfile.TemporaryDirectory(dir=downloader.ROOT) as temporary:
            directory = Path(temporary)
            etag, digest = self.transfer(directory)
            self.assertEqual(etag, '"same"')
            self.assertEqual(digest, hashlib.sha256(b"zip!").hexdigest())
            self.assertEqual((directory / "000000.chunk").read_bytes(), b"zip!")

    def test_fake_200_never_saves_a_chunk(self):
        with tempfile.TemporaryDirectory(dir=downloader.ROOT) as temporary:
            directory = Path(temporary)
            with self.assertRaises(downloader.ProtocolError):
                self.transfer(directory, status=200)
            self.assertEqual(list(directory.iterdir()), [])

    def test_short_body_never_saves_a_chunk(self):
        with tempfile.TemporaryDirectory(dir=downloader.ROOT) as temporary:
            directory = Path(temporary)
            with self.assertRaises(downloader.RetryableError):
                self.transfer(directory, data=b"zip")
            self.assertEqual(list(directory.iterdir()), [])

    def test_extra_body_never_saves_a_chunk(self):
        with tempfile.TemporaryDirectory(dir=downloader.ROOT) as temporary:
            directory = Path(temporary)
            with self.assertRaises(downloader.ProtocolError):
                self.transfer(directory, data=b"zip!!")
            self.assertEqual(list(directory.iterdir()), [])

    def test_complete_hash_rejection_never_publishes_zip(self):
        with tempfile.TemporaryDirectory(dir=downloader.ROOT) as temporary:
            output = Path(temporary) / "result.zip"
            identity = {"artifact_id": 1, "size": 4, "sha256": hashlib.sha256(b"oops").hexdigest()}
            worker = downloader.Downloader(None, None, output, identity, 4, 1, 0, 10)
            worker.directory.mkdir()
            (worker.directory / "000000.chunk").write_bytes(b"zip!")
            worker.manifest_path.write_text(json.dumps({"identity": worker.identity, "etag": '"same"',
                "chunks": {"0": hashlib.sha256(b"zip!").hexdigest()}}))
            with self.assertRaises(downloader.ProtocolError):
                worker.run()
            self.assertFalse(output.exists())
            self.assertFalse(output.with_name(output.name + ".assembling").exists())


if __name__ == "__main__":
    unittest.main()
