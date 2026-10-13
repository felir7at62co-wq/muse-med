"""Offline source, resumability and concurrent registration tests for generated audio."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

SCRIPT = Path(__file__).resolve().parents[2] / "skills/tweet-drama-voice-continuity/scripts/prepare_voice_assets.py"


class GeneratedVoiceAssets(unittest.TestCase):
    def load(self):
        spec = importlib.util.spec_from_file_location("prepare_voice_assets", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        sys.path.insert(0, str(SCRIPT.parent))
        try:
            spec.loader.exec_module(module)
        finally:
            sys.path.pop(0)
        return module

    def project(self, root):
        source = root / "generated.wav"
        with wave.open(str(source), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(8000)
            output.writeframes(b"\x00\x01" * 8000 * 5)
        config = {"jubian_script_id": 123, "project_bible": {"characters": [
            {"character_id": "lu", "name": "陆沉舟"}, {"character_id": "lin", "name": "林晚"}]}}
        (root / "project_config.json").write_text(json.dumps(config), encoding="utf-8")
        self.request(root, source)
        return source

    def request(self, root, source, characters=None, name="request.json"):
        body = {"version": 1, "source_path": source.name, "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "source_task_id": "original-paid-task", "characters": characters if characters is not None else [
                    {"character_id": "lu", "intervals": [{"start_seconds": 1, "duration_seconds": 2}]}]}
        (root / name).write_text(json.dumps(body), encoding="utf-8")
        return body

    def ledger(self, root):
        return json.loads((root / "audio/voice-references/manifest.json").read_text(encoding="utf-8"))

    def test_extracts_track_and_candidate_and_resumes_without_changing_bytes(self):
        module = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.project(root)
            before = source.read_bytes()
            first = module.prepare(root, "request.json")
            again = module.prepare(root, "request.json")
            self.assertEqual(first, again)
            self.assertEqual(source.read_bytes(), before)
            self.assertEqual(first["track"]["duration_seconds"], 5)
            self.assertFalse(first["track"]["usable_as_voice_reference"])
            saved = self.ledger(root)
            self.assertEqual(len(saved["samples"]), 1)
            self.assertEqual(saved["samples"][0]["duration_seconds"], 2)
            self.assertFalse(saved["samples"][0]["speaker_verified"])
            self.assertEqual(saved["samples"][0]["status"], "candidate")
            self.assertEqual(first["paid_requests"], 0)

    def test_preserves_current_voice_and_unrelated_history_and_track_metadata(self):
        module = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.project(root)
            config = json.loads((root / "project_config.json").read_text())
            config["project_bible"]["characters"][0]["voice_profile"] = {"reference_audio": "https://example.invalid/approved.wav"}
            (root / "project_config.json").write_text(json.dumps(config))
            target = root / "audio/voice-references"
            target.mkdir(parents=True)
            history = {"character_id": "lin", "status": "approved", "custom": "retained"}
            (target / "manifest.json").write_text(json.dumps({"version": 1, "samples": [history], "custom": "keep"}))
            result = module.prepare(root, "request.json")
            self.assertEqual(result["characters"][0]["status"], "current_voice_preserved")
            saved = self.ledger(root)
            self.assertEqual(saved["samples"], [history])
            self.assertEqual(saved["custom"], "keep")
            self.assertEqual(json.loads((root / "project_config.json").read_text()), config)

    def test_numeric_task_identity_is_retained_and_legacy_ledger_is_project_pinned(self):
        module = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.project(root)
            request = self.request(root, source)
            request["source_task_id"] = 98765
            (root / "request.json").write_text(json.dumps(request))
            folder = root / "audio/voice-references"
            folder.mkdir(parents=True)
            (folder / "manifest.json").write_text(json.dumps({"samples": []}))
            module.prepare(root, "request.json")
            saved = self.ledger(root)
            self.assertEqual(saved["script_id"], 123)
            self.assertEqual(saved["samples"][0]["source_task_id"], "98765")

    def test_missing_interval_extracts_only_mixed_track_without_claiming_a_voice(self):
        module = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.project(root)
            self.request(root, source, [{"character_id": "lu"}])
            result = module.prepare(root, "request.json")
            self.assertEqual(result["characters"], [{"character_id": "lu", "status": "needs_interval"}])
            self.assertEqual(self.ledger(root)["samples"], [])

    def test_changed_candidate_or_source_is_not_silently_replaced(self):
        module = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.project(root)
            module.prepare(root, "request.json")
            saved = self.ledger(root)
            (root / saved["samples"][0]["path"]).write_bytes(b"corrupted sample")
            with self.assertRaisesRegex(ValueError, "Saved candidate changed"):
                module.prepare(root, "request.json")
            source.write_bytes(b"changed source")
            with self.assertRaisesRegex(ValueError, "source bytes changed"):
                module.prepare(root, "request.json")
            self.assertEqual(self.ledger(root), saved)

    def test_rejects_unknown_duplicate_identity_and_out_of_range_intervals(self):
        module = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.project(root)
            for rows in [[{"character_id": "unknown"}], [{"character_id": "lu"}, {"character_id": "lu"}],
                         [{"character_id": "lu", "intervals": [{"start_seconds": 4, "duration_seconds": 2}]}],
                         [{"character_id": "lu", "intervals": [{"start_seconds": 0, "duration_seconds": 16}]}],
                         [{"character_id": "lu", "intervals": [{"start_seconds": float("nan")}]}]]:
                self.request(root, source, rows)
                with self.assertRaises(ValueError):
                    module.prepare(root, "request.json")
            self.assertEqual(self.ledger(root)["samples"], [])

    def test_rejects_cross_project_and_linked_output_and_preserves_approved_records(self):
        module = self.load()
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory)
            source = self.project(root)
            request = self.request(root, source)
            request["source_path"] = str(Path(outside) / "outside.wav")
            (root / "request.json").write_text(json.dumps(request))
            with self.assertRaises((ValueError, FileNotFoundError)):
                module.prepare(root, "request.json")
            self.request(root, source)
            (root / "audio").mkdir()
            (root / "audio/voice-references").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "inside"):
                module.prepare(root, "request.json")
            self.assertEqual(list(Path(outside).iterdir()), [])

    def test_interruption_keeps_registered_progress_and_resumes_remaining_character(self):
        module = self.load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.project(root)
            self.request(root, source, [{"character_id": person, "intervals": [{"start_seconds": 1}]} for person in ["lu", "lin"]])
            original = module.extract
            calls = 0
            def interrupted(*args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise RuntimeError("interrupted")
                return original(*args, **kwargs)
            with patch.object(module, "extract", interrupted):
                with self.assertRaises(RuntimeError):
                    module.prepare(root, "request.json")
            self.assertEqual(len(self.ledger(root)["samples"]), 1)
            module.prepare(root, "request.json")
            self.assertEqual(len(self.ledger(root)["samples"]), 2)

    def test_two_processes_do_not_lose_candidate_registrations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.project(root)
            self.request(root, source, [{"character_id": "lin", "intervals": [{"start_seconds": 2}]}], "second.json")
            children = [subprocess.Popen([sys.executable, "-B", str(SCRIPT), "--project", str(root), "--request", name], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                        for name in ["request.json", "second.json"]]
            try:
                for child in children:
                    stdout, stderr = child.communicate(timeout=30)
                    self.assertEqual(child.returncode, 0, stderr.decode())
                    self.assertEqual(json.loads(stdout)["paid_requests"], 0)
            finally:
                for child in children:
                    if child.poll() is None:
                        child.kill()
                        child.communicate()
            saved = self.ledger(root)
            self.assertEqual({sample["character_id"] for sample in saved["samples"]}, {"lu", "lin"})
            self.assertEqual(len(saved["tracks"]), 1)


if __name__ == "__main__":
    unittest.main()
