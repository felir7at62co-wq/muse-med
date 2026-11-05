"""Check bounded HTTP response handling without contacting a service."""

import io
import unittest

from verify import MAX_RESPONSE_BYTES, request


class Response(io.BytesIO):
    status = 200


class Opener:
    def __init__(self, body):
        self.body = body

    def open(self, req, timeout):
        return Response(self.body)


class RequestTests(unittest.TestCase):
    def test_json_response_is_decoded(self):
        self.assertEqual(request(Opener(b'{"ok":true}'), "http://127.0.0.1", "/readyz"),
                         (200, {"ok": True}))

    def test_oversized_response_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "2 MiB"):
            request(Opener(b" " * (MAX_RESPONSE_BYTES + 1)), "http://127.0.0.1", "/readyz")


if __name__ == "__main__":
    unittest.main()
