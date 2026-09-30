"""Reference extraction checks use local PCM files and forbid external calls."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import wave


SCRIPT = Path(__file__).resolve().parents[2] / "skills/tweet-drama-voice-continuity/scripts/extract_voice_reference.py"


class VoiceReferences(unittest.TestCase):
    def load(self):
        spec = importlib.util.spec_from_file_location("voice_reference", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def source(self, root):
        path = root / "source.wav"
        with wave.open(str(path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(8000)
            output.writeframes(b"\x00\x01" * 8000 * 4)
        return path

    def test_default_sample_is_two_seconds_and_preserves_source(self):
        module = self.load()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = self.source(root)
            before = source.read_bytes()
            report = module.extract(source, root / "voice.wav", 1, 2)
            self.assertEqual(report["duration_seconds"], 2)
            self.assertEqual(report["start_seconds"], 1)
            self.assertEqual(source.read_bytes(), before)
            with wave.open(str(root / "voice.wav"), "rb") as audio:
                self.assertEqual(audio.getnframes(), 16000)

    def test_refuses_truncated_interval_overlong_and_overwrite(self):
        module = self.load()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = self.source(root)
            for start, duration in [(3, 2), (0, 16), (-1, 2), (0, 0)]:
                with self.assertRaises(ValueError):
                    module.extract(source, root / "voice.wav", start, duration)
            module.extract(source, root / "voice.wav", 0, 2)
            with self.assertRaises(FileExistsError):
                module.extract(source, root / "voice.wav", 0, 2)


if __name__ == "__main__":
    unittest.main()
