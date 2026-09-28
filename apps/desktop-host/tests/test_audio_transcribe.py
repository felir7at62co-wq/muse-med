"""Offline audio transcription behavior without starting the Desktop host."""

import importlib.util
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "skills" / "audio-transcribe" / "scripts" / "transcribe.py"
MODEL_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")


def load_script():
    """Load the installed script from its skill directory."""
    if not SCRIPT.is_file():
        raise AssertionError(f"missing bundled transcription script: {SCRIPT}")
    spec = importlib.util.spec_from_file_location("muse_audio_transcribe", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TranscribeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="muse-audio-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.input = self.root / "sample.mp4"
        self.input.write_bytes(b"original media")
        self.txt = self.root / "result.txt"
        self.json = self.root / "result.json"
        self.model = self.root / "model"
        self.model.mkdir()
        for name in MODEL_FILES:
            (self.model / name).write_bytes(b"fixture")
        self.ffmpeg = self.root / "ffmpeg.exe"
        self.ffmpeg.write_bytes(b"fixture")
        self.module = load_script()

    def runtime(self, model=None, ffmpeg=None):
        return patch.dict(os.environ, {
            "MUSE_WHISPER_MODEL_DIR": str(self.model if model is None else model),
            "DSH_FFMPEG_PATH": str(self.ffmpeg if ffmpeg is None else ffmpeg),
        })

    def test_transcribes_locally_to_timestamp_text_and_segment_json(self):
        calls = []

        def fake_ffmpeg(args, **kwargs):
            calls.append(args)
            Path(args[-1]).write_bytes(b"wav")
            return subprocess.CompletedProcess(args, 0, b"", b"")

        class FakeModel:
            def __init__(self, path, **kwargs):
                calls.append((path, kwargs))

            def transcribe(self, path, **kwargs):
                self_path = Path(path)
                assert self_path.is_file()
                calls.append(kwargs)
                return iter([
                    types.SimpleNamespace(start=1.25, end=3.5, text=" 你好 "),
                    types.SimpleNamespace(start=3.5, end=4.0, text="世界"),
                ]), None

        fake_module = types.ModuleType("faster_whisper")
        fake_module.WhisperModel = FakeModel
        with self.runtime(), patch.dict(sys.modules, {"faster_whisper": fake_module}), \
                patch.object(self.module.subprocess, "run", side_effect=fake_ffmpeg):
            self.module.transcribe_file(self.input, self.txt, self.json, language="zh")

        self.assertEqual(self.input.read_bytes(), b"original media")
        self.assertEqual(self.txt.read_text(encoding="utf-8"),
                         "[00:00:01.250 --> 00:00:03.500] 你好\n"
                         "[00:00:03.500 --> 00:00:04.000] 世界\n")
        self.assertEqual(json.loads(self.json.read_text(encoding="utf-8")), [
            {"start": 1.25, "end": 3.5, "text": "你好"},
            {"start": 3.5, "end": 4.0, "text": "世界"},
        ])
        self.assertEqual(calls[0][0], str(self.ffmpeg))
        self.assertEqual(calls[0][calls[0].index("-protocol_whitelist") + 1], "file,pipe")
        self.assertEqual(calls[1][0], str(self.model))
        self.assertTrue(calls[1][1]["local_files_only"])
        self.assertEqual(calls[2]["language"], "zh")
        self.assertEqual(list(self.root.glob("*.wav")), [])

    def test_missing_model_fails_before_media_decode(self):
        with self.runtime(model=self.root / "absent"), \
                patch.object(self.module.subprocess, "run") as decoder:
            with self.assertRaisesRegex(RuntimeError, "MUSE_WHISPER_MODEL_DIR"):
                self.module.transcribe_file(self.input, self.txt, self.json)
        decoder.assert_not_called()
        self.assertFalse(self.txt.exists())
        self.assertFalse(self.json.exists())

    def test_missing_configured_ffmpeg_fails_before_media_decode(self):
        with self.runtime(ffmpeg=self.root / "absent.exe"), \
                patch.object(self.module.subprocess, "run") as decoder:
            with self.assertRaisesRegex(RuntimeError, "DSH_FFMPEG_PATH"):
                self.module.transcribe_file(self.input, self.txt, self.json)
        decoder.assert_not_called()

    def test_existing_output_is_never_overwritten(self):
        self.txt.write_text("approved prior transcript", encoding="utf-8")
        with self.runtime(), patch.object(self.module.subprocess, "run") as decoder:
            with self.assertRaisesRegex(FileExistsError, "result.txt"):
                self.module.transcribe_file(self.input, self.txt, self.json)
        decoder.assert_not_called()
        self.assertEqual(self.txt.read_text(encoding="utf-8"), "approved prior transcript")
        self.assertFalse(self.json.exists())

    def test_publishes_outputs_on_a_volume_without_hardlinks(self):
        with patch.object(self.module.os, "link", side_effect=OSError(errno.ENOTSUP, "unsupported")):
            self.module.publish_pair(self.txt, "[00:00:01.000] 你好\n", self.json,
                                     [{"start": 1.0, "end": 2.0, "text": "你好"}])
        self.assertEqual(self.txt.read_text(encoding="utf-8"), "[00:00:01.000] 你好\n")
        self.assertEqual(json.loads(self.json.read_text(encoding="utf-8"))[0]["text"], "你好")

    def test_output_cannot_alias_input_media(self):
        with self.runtime(), patch.object(self.module.subprocess, "run") as decoder:
            with self.assertRaisesRegex(ValueError, "input media"):
                self.module.transcribe_file(self.input, self.input, self.json)
        decoder.assert_not_called()
        self.assertEqual(self.input.read_bytes(), b"original media")

    def test_conversion_failure_leaves_both_outputs_absent(self):
        failure = subprocess.CalledProcessError(1, [str(self.ffmpeg)], stderr=b"invalid media")
        with self.runtime(), patch.object(self.module.subprocess, "run", side_effect=failure):
            with self.assertRaisesRegex(RuntimeError, "FFmpeg"):
                self.module.transcribe_file(self.input, self.txt, self.json)
        self.assertFalse(self.txt.exists())
        self.assertFalse(self.json.exists())
        self.assertEqual(self.input.read_bytes(), b"original media")

    def test_no_recognized_speech_does_not_publish_empty_transcript(self):
        def fake_ffmpeg(args, **kwargs):
            Path(args[-1]).write_bytes(b"wav")
            return subprocess.CompletedProcess(args, 0, b"", b"")

        class SilentModel:
            def __init__(self, path, **kwargs):
                pass

            def transcribe(self, path, **kwargs):
                return iter(()), None

        fake_module = types.ModuleType("faster_whisper")
        fake_module.WhisperModel = SilentModel
        with self.runtime(), patch.dict(sys.modules, {"faster_whisper": fake_module}), \
                patch.object(self.module.subprocess, "run", side_effect=fake_ffmpeg):
            with self.assertRaisesRegex(RuntimeError, "未识别到语音"):
                self.module.transcribe_file(self.input, self.txt, self.json)
        self.assertFalse(self.txt.exists())
        self.assertFalse(self.json.exists())

    def test_cli_requires_explicit_input_and_both_output_paths(self):
        done = subprocess.run([sys.executable, "-B", str(SCRIPT), "--input", str(self.input)],
                              capture_output=True, text=True, encoding="utf-8", check=False)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("--output-txt", done.stderr)
        self.assertIn("--output-json", done.stderr)


if __name__ == "__main__":
    unittest.main()
