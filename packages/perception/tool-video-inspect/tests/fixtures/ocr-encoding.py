"""Exercise the shipped JSON protocol without loading an OCR engine."""

import importlib.util
import json
import sys


# Reproduce redirected Windows ACP output on UTF-8 hosts when UTF-8 mode is absent.
if not sys.flags.utf8_mode:
    sys.stdout.reconfigure(encoding="cp936")

spec = importlib.util.spec_from_file_location("ocr_bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def recognize(payload):
    return {"ok": True, "language_used": "zh-Hans-CN", "frames": [
        {"id": frame["id"], "timestamp_seconds": frame["timestamp_seconds"],
         "image_width": 64, "image_height": 48, "lines": [
             {"text": sys.argv[2], "words": [],
              "bounding_box": {"x": 8, "y": 32, "width": 48, "height": 10}}
         ]} for frame in payload["frames"]
    ]}


bridge.recognize = recognize
print(json.dumps({"utf8_mode": sys.flags.utf8_mode, "stdout_encoding": sys.stdout.encoding}), file=sys.stderr)
bridge.main()
