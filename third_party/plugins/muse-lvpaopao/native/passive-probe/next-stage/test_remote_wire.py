"""Synthetic-frame tests; no target connection or upstream executable code."""

import gzip
import unittest
import zlib

from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

import remote_wire as wire


def _fixture_outer(**values):
    """Use a separate protobuf schema to produce envelope negative controls."""
    file = descriptor_pb2.FileDescriptorProto(name="synthetic_outer.proto", syntax="proto2")
    msg = file.message_type.add(name="FixtureEnvelope")
    field = descriptor_pb2.FieldDescriptorProto
    for number, name, kind in (
        (1, "seq", field.TYPE_UINT64), (2, "after", field.TYPE_UINT64),
        (3, "category", field.TYPE_STRING), (4, "data", field.TYPE_BYTES),
        (5, "compressAlgo", field.TYPE_UINT64), (6, "originalSize", field.TYPE_UINT64),
    ):
        msg.field.add(number=number, name=name, type=kind, label=field.LABEL_OPTIONAL)
    pool = descriptor_pool.DescriptorPool()
    pool.Add(file)
    cls = message_factory.GetMessageClass(pool.FindMessageTypeByName("FixtureEnvelope"))
    return cls(**values).SerializeToString(deterministic=True)


class RoundTripTests(unittest.TestCase):
    def test_context_and_setup_field_numbers_match_binary_fixtures(self):
        for category, payload, expected in (
            ("addJsContext", {"jscontextId": "x", "jscontextName": "n"}, "0a017812016e"),
            ("removeJsContext", {"jscontextId": "x"}, "0a0178"),
            ("connectJsContext", {"jscontextId": "x"}, "0a0178"),
            ("setupContext", {"configureJs": "n", "publicJsMd5": "p", "threeJsMd5": "t", "supportCompressAlgo": 1}, "1a016e2201702a01743001"),
            ("setupContext", {"deviceInfo": {"screenWidth": 1.0, "pixelRatio": 2.0}}, "120a350000803f3d00000040"),
        ):
            with self.subTest(category=category, payload=payload):
                self.assertEqual(wire.decode_outer(wire.encode_frame(category, payload)).data, bytes.fromhex(expected))

    def test_request_fields_match_independently_authored_binary_fixture(self):
        # Inner: opId7, payload{}, context x. Outer is normal protobuf, not ldelim.
        fixture = bytes.fromhex(
            "080110001a0e6368726f6d65446576746f6f6c732209080712027b7d1a017828003000"
        )
        encoded = wire.encode_frame(
            wire.CATEGORY_CHROME_DEVTOOLS,
            {"opId": 7, "payload": "{}", "jscontextId": "x"}, seq=1,
        )
        self.assertEqual(encoded, fixture)
        value = wire.decode_frame(fixture)
        self.assertEqual((value.outer.seq, value.outer.after), (1, 0))
        self.assertEqual(value.payload.opId, 7)
        self.assertEqual(value.payload.payload, "{}")

    def test_request_and_result_keep_uint64_precision_and_selected_context(self):
        for category in (wire.CATEGORY_CHROME_DEVTOOLS, wire.CATEGORY_CHROME_DEVTOOLS_RESULT):
            for compression in (0, 1):
                with self.subTest(category=category, compression=compression):
                    value = wire.decode_frame(wire.encode_frame(
                        category,
                        {"opId": (1 << 64) - 1, "payload": '{"id":19}', "jscontextId": "ctx-target"},
                        seq=wire.UINT32_MAX, after=23, compress_algo=compression,
                    ))
                    self.assertEqual(value.payload.opId, (1 << 64) - 1)
                    self.assertEqual(value.payload.payload, '{"id":19}')
                    self.assertEqual(value.outer.seq, wire.UINT32_MAX)
                    self.assertEqual(wire.get_context_metadata(value).context_id, "ctx-target")

    def test_context_events_preserve_exact_category_and_fields(self):
        for category, fields in (
            (wire.CATEGORY_ADD_JS_CONTEXT, {"jscontextId": "ctx-1", "jscontextName": "app-service"}),
            (wire.CATEGORY_REMOVE_JS_CONTEXT, {"jscontextId": "ctx-1"}),
            (wire.CATEGORY_CONNECT_JS_CONTEXT, {"jscontextId": "ctx-1"}),
        ):
            with self.subTest(category=category):
                value = wire.decode_frame(wire.encode_frame(category, fields))
                metadata = wire.get_context_metadata(value)
                self.assertEqual(metadata.category, category)
                self.assertEqual(metadata.context_id, "ctx-1")
                self.assertEqual(metadata.context_name, fields.get("jscontextName"))

    def test_setup_fields_round_trip_without_executing_or_summarizing_script(self):
        script = 'throw new Error("must never execute");'
        value = wire.decode_frame(wire.encode_frame(wire.CATEGORY_SETUP_CONTEXT, {
            "registerInterface": {
                "objName": "synthetic",
                "objMethodList": [{"methodName": "observe", "methodArgList": ["a", "b"]}],
            },
            "deviceInfo": {
                "deviceName": "synthetic-device", "deviceModel": "test",
                "systemVersion": "synthetic-os", "wechatVersion": "test-version",
                "publibVersion": 11, "screenWidth": 640.0, "pixelRatio": 2.0,
                "userAgent": "synthetic-agent",
            },
            "configureJs": script, "publicJsMd5": "public-md5",
            "threeJsMd5": "three-md5", "supportCompressAlgo": 1,
        }, compress_algo=1))
        self.assertEqual(value.payload.configureJs, script)
        self.assertEqual(value.payload.deviceInfo.publibVersion, 11)
        self.assertEqual(value.payload.deviceInfo.screenWidth, 640.0)
        summary = wire.get_setup_metadata(value)
        self.assertEqual(summary.method_names, ("observe",))
        self.assertEqual(summary.registered_object, "synthetic")
        self.assertTrue(summary.has_configure_js)
        self.assertNotIn(script, repr(summary))
        self.assertNotIn("synthetic-device", repr(summary))
        self.assertIsNone(wire.get_context_metadata(value))

    def test_uncompressed_wrapper_records_zero_original_size(self):
        frame = wire.decode_outer(wire.encode_frame(wire.CATEGORY_ADD_JS_CONTEXT, {"jscontextId": "ctx"}))
        self.assertEqual(frame.compress_algo, 0)
        self.assertEqual(frame.original_size, 0)
        self.assertNotEqual(len(frame.data), 0)

    def test_empty_or_overlong_context_is_not_selected_by_helper(self):
        for context_id in ("", "x" * (wire.MAX_CONTEXT_ID_BYTES + 1)):
            with self.subTest(size=len(context_id)):
                value = wire.decode_frame(wire.encode_frame(
                    wire.CATEGORY_ADD_JS_CONTEXT,
                    {"jscontextId": context_id, "jscontextName": "expected-looking-name"},
                ))
                self.assertIsNone(wire.get_context_metadata(value))

    def test_optional_defaults_do_not_supply_implicit_context_or_script(self):
        value = wire.decode_frame(_fixture_outer(category="addJsContext", data=b""))
        self.assertEqual(value.outer.seq, 0)
        self.assertEqual(value.payload.jscontextId, "")
        self.assertIsNone(wire.get_context_metadata(value))
        self.assertIsNone(wire.get_setup_metadata(value))

    def test_unknown_outer_fields_are_skipped_by_protobuf(self):
        frame = wire.encode_frame("removeJsContext", {"jscontextId": "ctx"})
        self.assertEqual(wire.decode_frame(frame + bytes.fromhex("a00601")).payload.jscontextId, "ctx")


class CompressionTests(unittest.TestCase):
    def outer(self, data, original_size, flags=1):
        return _fixture_outer(category="addJsContext", data=data, compressAlgo=flags, originalSize=original_size)

    def test_exact_four_mib_decompression_is_bounded_and_accepted(self):
        body = b"x" * wire.MAX_PAYLOAD_BYTES
        result = wire.decode_outer(self.outer(zlib.compress(body), len(body)))
        self.assertEqual(result.original_size, wire.MAX_PAYLOAD_BYTES)

    def test_decompression_bomb_above_four_mib_is_rejected(self):
        body = b"x" * (wire.MAX_PAYLOAD_BYTES + 1)
        with self.assertRaisesRegex(wire.WireError, "exceeds 4 MiB"):
            wire.decode_outer(self.outer(zlib.compress(body), wire.MAX_PAYLOAD_BYTES))

    def test_truncated_invalid_and_trailing_compressed_data_are_rejected(self):
        raw = b"\x0a\x01x"
        compressed = zlib.compress(raw)
        for data in (compressed[:-1], b"not-zlib", compressed + b"extra", compressed + compressed, gzip.compress(raw)):
            with self.subTest(data_size=len(data)):
                with self.assertRaises(wire.WireError):
                    wire.decode_outer(self.outer(data, len(raw)))

    def test_compressed_original_size_must_match(self):
        with self.assertRaisesRegex(wire.WireError, "does not match"):
            wire.decode_outer(self.outer(zlib.compress(b"abc"), 2))

    def test_uncompressed_reader_ignores_informational_original_size(self):
        data = b"\x0a\x01x"
        value = wire.decode_frame(self.outer(data, 42, flags=0))
        self.assertEqual(value.outer.original_size, 42)
        self.assertEqual(value.outer.data, data)
        self.assertEqual(value.payload.jscontextId, "x")

    def test_unknown_compression_bits_are_rejected(self):
        for flags in (2, 3, wire.UINT32_MAX):
            with self.subTest(flags=flags):
                with self.assertRaisesRegex(wire.WireError, "unsupported compression"):
                    wire.decode_outer(self.outer(b"", 0, flags=flags))


class EnvelopeTests(unittest.TestCase):
    def test_category_limits_count_utf8_bytes(self):
        self.assertEqual(wire.decode_outer(_fixture_outer(category="x" * 64)).category, "x" * 64)
        for category in ("", "x" * 65, "😀" * 17):
            with self.subTest(size=len(category)):
                with self.assertRaisesRegex(wire.WireError, "category"):
                    wire.decode_outer(_fixture_outer(category=category))

    def test_malformed_outer_and_truncated_inner_frames_are_rejected(self):
        for frame in (b"\x80", b"\x00", b"\x1a\x04x", b"\x1a\x01\xff"):
            with self.subTest(frame=frame):
                with self.assertRaises(wire.WireError):
                    wire.decode_frame(frame)
        for data in (b"\x0a\x04x", b"\x0a\x01\xff"):
            frame = _fixture_outer(category="addJsContext", data=data)
            with self.assertRaisesRegex(wire.WireError, "truncated"):
                wire.decode_frame(frame)

    def test_oversized_numeric_varints_do_not_silently_truncate_to_uint32(self):
        for name in ("seq", "after", "compressAlgo", "originalSize"):
            with self.subTest(field=name):
                with self.assertRaisesRegex(wire.WireError, "uint32"):
                    wire.decode_outer(_fixture_outer(category="addJsContext", **{name: 1 << 32}))

    def test_duplicate_numeric_and_packed_wrong_wire_fields_are_rejected(self):
        duplicate = b"\x08\x01" + _fixture_outer(category="addJsContext", seq=2)
        packed = b"\x0a\x01\x01" + _fixture_outer(category="addJsContext")
        for frame in (duplicate, packed):
            with self.subTest(frame=frame):
                with self.assertRaises(wire.WireError):
                    wire.decode_outer(frame)

    def test_outer_frame_data_and_original_size_limits_are_independent(self):
        cases = (
            b"x" * (wire.MAX_FRAME_BYTES + 1),
            _fixture_outer(category="addJsContext", data=b"x" * (wire.MAX_DATA_BYTES + 1)),
            _fixture_outer(category="addJsContext", originalSize=wire.MAX_PAYLOAD_BYTES + 1),
        )
        for frame in cases:
            with self.subTest(size=len(frame)):
                with self.assertRaises(wire.WireError):
                    wire.decode_outer(frame)

    def test_unknown_category_can_be_observed_but_never_guessed_as_known_payload(self):
        frame = _fixture_outer(category="futureCategory", data=b"")
        self.assertEqual(wire.decode_outer(frame).category, "futureCategory")
        with self.assertRaisesRegex(wire.WireError, "unsupported category"):
            wire.decode_frame(frame)

    def test_encoder_rejects_bad_fields_and_limits_without_target_activity(self):
        for category, fields, extra in (
            ("ChromeDevtools", {}, {}),
            ("chromeDevtools", {"opId": -1}, {}),
            ("chromeDevtools", {"opId": 1 << 64}, {}),
            ("chromeDevtools", {"notAField": "x"}, {}),
            ("chromeDevtools", {}, {"seq": True}),
            ("chromeDevtools", {}, {"after": -1}),
            ("chromeDevtools", {}, {"compress_algo": 3}),
            ("chromeDevtools", {"payload": "x" * wire.MAX_PAYLOAD_BYTES}, {}),
        ):
            with self.subTest(category=category, extra=extra):
                with self.assertRaises(wire.WireError):
                    wire.encode_frame(category, fields, **extra)


if __name__ == "__main__":
    unittest.main()
