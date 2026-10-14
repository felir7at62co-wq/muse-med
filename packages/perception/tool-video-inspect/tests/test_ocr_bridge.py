"""Validate the OCR process protocol without installed engines or network access."""

import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("ocr_bridge", Path(__file__).parents[1] / "scripts" / "ocr_bridge.py")
BRIDGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BRIDGE)


class BridgeProtocol(unittest.TestCase):
    def payload(self):
        return {"language": "auto", "cpu_threads": 2, "frames": [
            {"id": "source-1", "timestamp_seconds": 3.5, "image_base64": base64.b64encode(b"image").decode()}
        ]}

    def test_invalid_requests_do_not_load_an_engine(self):
        invalid = [None, [], {}, {"language": "xx"}]
        for field, values in (("cpu_threads", [True, 0, 17, 1.5, None]), ("frames", [None, {}])):
            for value in values:
                payload = self.payload()
                payload[field] = value
                invalid.append(payload)
        for field, values in (("id", ["", None]), ("timestamp_seconds", [True, -1, float("inf"), float("nan"), "1"]),
                              ("image_base64", [None])):
            for value in values:
                payload = self.payload()
                payload["frames"][0][field] = value
                invalid.append(payload)
        with patch.object(BRIDGE.importlib.metadata, "version", side_effect=AssertionError("unexpected engine load")):
            for payload in invalid:
                with self.subTest(payload=payload):
                    self.assertEqual(BRIDGE.recognize(payload), {"ok": False, "code": "invalid_input"})

    def test_unavailable_language_is_explicit(self):
        payload = self.payload()
        payload["language"] = "zh-Hant-TW"
        self.assertEqual(BRIDGE.recognize(payload), {"ok": False, "code": "language_unavailable"})

    def test_missing_or_wrong_distribution_does_not_start_recognition(self):
        for version in ("unexpected", BRIDGE.importlib.metadata.PackageNotFoundError("rapidocr")):
            with patch.object(BRIDGE.importlib.metadata, "version", side_effect=version if isinstance(version, Exception) else None,
                              return_value=version):
                self.assertEqual(BRIDGE.recognize(self.payload()), {"ok": False, "code": "ocr_engine_unavailable"})

    def engine_case(self, root, *, corrupt=False, decode=True, recognize=True):
        models = root / "models"
        models.mkdir()
        data = b"locked-model"
        (models / "test.onnx").write_bytes(b"changed" if corrupt else data)
        params_seen = []
        image = types.SimpleNamespace(shape=(48, 64, 3))
        cv2 = types.ModuleType("cv2")
        cv2.error = RuntimeError
        cv2.IMREAD_COLOR = 1
        cv2.setNumThreads = lambda threads: None
        cv2.imdecode = lambda data, flag: image if decode else None
        numpy = types.ModuleType("numpy")
        numpy.uint8 = "uint8"
        numpy.frombuffer = lambda data, dtype: data
        rapid = types.ModuleType("rapidocr")
        rapid.__file__ = str(root / "__init__.py")
        polygon = types.SimpleNamespace(min=lambda axis: (1, 2), max=lambda axis: (21, 12))

        def engine(params):
            params_seen.append(params)

            def call(image):
                if not recognize:
                    raise RuntimeError("engine inference failure")
                return types.SimpleNamespace(boxes=[polygon], txts=["原样字幕 Hello"])
            return call

        rapid.RapidOCR = engine
        versions = {"rapidocr": "3.10.0", "onnxruntime": "1.23.2"}
        return (patch.dict(sys.modules, {"cv2": cv2, "numpy": numpy, "rapidocr": rapid}),
                patch.object(BRIDGE.importlib.metadata, "version", side_effect=versions.__getitem__),
                patch.object(BRIDGE, "MODELS", {"Det": ("test.onnx", hashlib.sha256(data).hexdigest())}), params_seen)

    def test_observed_lines_keep_source_identity_time_and_no_word_boxes(self):
        with tempfile.TemporaryDirectory() as directory:
            modules, versions, models, params = self.engine_case(Path(directory))
            with modules, versions, models:
                result = BRIDGE.recognize(self.payload())
            self.assertTrue(result["ok"])
            frame = result["frames"][0]
            self.assertEqual((frame["id"], frame["timestamp_seconds"], frame["image_width"], frame["image_height"]),
                             ("source-1", 3.5, 64, 48))
            self.assertEqual(frame["lines"], [{"text": "原样字幕 Hello", "bounding_box": {
                "x": 1.0, "y": 2.0, "width": 20.0, "height": 10.0}, "words": []}])
            self.assertEqual(params[0]["EngineConfig.onnxruntime.intra_op_num_threads"], 2)
            self.assertEqual(params[0]["Det.model_path"], str(Path(directory) / "models" / "test.onnx"))

    def test_corrupt_model_is_rejected_before_engine_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            modules, versions, models, params = self.engine_case(Path(directory), corrupt=True)
            with modules, versions, models:
                self.assertEqual(BRIDGE.recognize(self.payload()), {"ok": False, "code": "ocr_engine_unavailable"})
            self.assertEqual(params, [])

    def test_decode_and_inference_failure_are_not_empty_success(self):
        for options in ({"decode": False}, {"recognize": False}):
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory:
                modules, versions, models, _ = self.engine_case(Path(directory), **options)
                with modules, versions, models:
                    self.assertEqual(BRIDGE.recognize(self.payload()), {"ok": False, "code": "frame_decode_failed"})

    def test_main_outputs_one_json_and_keeps_engine_diagnostics_on_stderr(self):
        output, diagnostic = io.StringIO(), io.StringIO()

        def noisy(payload):
            print("engine diagnostic")
            return {"ok": False, "code": "ocr_engine_unavailable"}

        with patch.object(sys, "stdin", io.StringIO(json.dumps(self.payload()))), patch.object(sys, "stdout", output), \
                patch.object(sys, "stderr", diagnostic), patch.object(BRIDGE, "recognize", side_effect=noisy):
            BRIDGE.main()
        self.assertEqual(json.loads(output.getvalue()), {"ok": False, "code": "ocr_engine_unavailable"})
        self.assertEqual(diagnostic.getvalue(), "engine diagnostic\n")


if __name__ == "__main__":
    unittest.main()
