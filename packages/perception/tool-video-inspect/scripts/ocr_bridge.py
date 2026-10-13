"""Offline CPU OCR bridge using the release-pinned RapidOCR models and runtime."""

import base64
import contextlib
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import sys


MODELS = {
    "Det": ("PP-OCRv6_det_small.onnx", "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f"),
    "Cls": ("ch_ppocr_mobile_v2.0_cls_mobile.onnx", "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c"),
    "Rec": ("PP-OCRv6_rec_small.onnx", "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884"),
}


def recognize(payload):
    """Keep source IDs and timecodes, returning only observed line text and boxes."""
    if not isinstance(payload, dict) or payload.get("language") not in ("auto", "zh-Hans-CN", "zh-Hant-TW", "en-US"):
        return {"ok": False, "code": "invalid_input"}
    if payload["language"] == "zh-Hant-TW":
        return {"ok": False, "code": "language_unavailable"}
    frames = payload.get("frames")
    threads = payload.get("cpu_threads")
    if not isinstance(frames, list) or isinstance(threads, bool) or not isinstance(threads, int) or not 1 <= threads <= 16:
        return {"ok": False, "code": "invalid_input"}
    for frame in frames:
        if (not isinstance(frame, dict) or not isinstance(frame.get("id"), str) or not frame["id"]
                or isinstance(frame.get("timestamp_seconds"), bool)
                or not isinstance(frame.get("timestamp_seconds"), (int, float))
                or not math.isfinite(frame["timestamp_seconds"]) or frame["timestamp_seconds"] < 0
                or not isinstance(frame.get("image_base64"), str)):
            return {"ok": False, "code": "invalid_input"}
    try:
        if importlib.metadata.version("rapidocr") != "3.10.0" or importlib.metadata.version("onnxruntime") != "1.23.2":
            return {"ok": False, "code": "ocr_engine_unavailable"}
        import cv2
        import numpy as np
        import rapidocr
        from rapidocr import RapidOCR
        model_root = Path(rapidocr.__file__).parent / "models"
        params = {"EngineConfig.onnxruntime.intra_op_num_threads": threads,
                  "EngineConfig.onnxruntime.inter_op_num_threads": 1,
                  "EngineConfig.onnxruntime.use_coreml": False,
                  "Global.log_level": "error"}
        for task, (name, digest) in MODELS.items():
            path = model_root / name
            if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                return {"ok": False, "code": "ocr_engine_unavailable"}
            params[f"{task}.model_path"] = str(path)
        cv2.setNumThreads(threads)
        engine = RapidOCR(params=params)
    except (ImportError, OSError, importlib.metadata.PackageNotFoundError, RuntimeError, ValueError):
        return {"ok": False, "code": "ocr_engine_unavailable"}
    recognized = []
    for frame in frames:
        try:
            image = cv2.imdecode(np.frombuffer(base64.b64decode(frame["image_base64"], validate=True), dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                return {"ok": False, "code": "frame_decode_failed"}
            result = engine(image)
        except (ValueError, RuntimeError, cv2.error):
            return {"ok": False, "code": "frame_decode_failed"}
        lines = []
        if result.boxes is not None:
            for text, polygon in zip(result.txts or [], result.boxes):
                left, top = polygon.min(axis=0)
                right, bottom = polygon.max(axis=0)
                lines.append({"text": text, "bounding_box": {"x": float(left), "y": float(top),
                             "width": float(right - left), "height": float(bottom - top)}, "words": []})
        recognized.append({"id": frame["id"], "timestamp_seconds": frame["timestamp_seconds"],
                           "image_width": int(image.shape[1]), "image_height": int(image.shape[0]), "lines": lines})
    return {"ok": True, "language_used": "zh-Hans-CN", "frames": recognized}


def main():
    """Emit one JSON response, keeping engine diagnostics off the process protocol."""
    try:
        payload = json.load(sys.stdin)
    except (ValueError, UnicodeError):
        result = {"ok": False, "code": "invalid_input"}
    else:
        with contextlib.redirect_stdout(sys.stderr):
            result = recognize(payload)
    json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
