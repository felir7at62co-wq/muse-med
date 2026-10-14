"""Offline synthetic regressions for independently assigned episode work."""

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "skills/tweet-drama-core/scripts"))
from episode_coverage import _non_speech_kind, _source_speech, audit_project, paid_ready, write_pass_records
from pipeline_state import PipelineState


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class EpisodeScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = {"version": 1, "expected_episode_count": 300, "episodes": {}}

    def put(self, relative, text):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def put_json(self, relative, data):
        self.put(relative, json.dumps(data, ensure_ascii=False))

    def save_manifest(self):
        self.put_json("episodes/manifest.json", self.manifest)

    def add_episode(self, ep, reviewed=True):
        text = f"第{ep}集\n甲：收到。\n△甲起身。"
        self.put(f"episodes/{ep}.txt", text)
        self.manifest["episodes"][ep] = {"sha256": digest(text), "char_count": len(text)}
        if reviewed:
            self.put(f"shots/第{ep}集镜头脚本.md",
                     "【镜头1】\n台词：甲：收到。\n【镜头2】\n发声类型：action\n画面：甲起身。\n")
            self.put_json(f"shots_and_matches/ep{ep}-source-map.json", {
                "version": 1, "episode": ep, "source_sha256": digest(text),
                "shot_script": f"shots/第{ep}集镜头脚本.md",
                "entries": [
                    {"source_line": 1, "source_text": f"第{ep}集", "kind": "heading", "shots": [1]},
                    {"source_line": 2, "source_text": "甲：收到。", "kind": "dialogue", "shots": [1],
                     "speaker": "甲", "speech_text": "收到。"},
                    {"source_line": 3, "source_text": "△甲起身。", "kind": "action", "shots": [2]},
                ],
            })

    def scope(self, ids):
        self.manifest["work_scope"] = {"episode_ids": ids}
        self.save_manifest()

    def editing_inputs(self, ep, prefix=""):
        video = f"video/{ep}/shot_001.mp4"
        self.put(video, "source fixture")
        self.put_json(f"editing/{prefix}{ep}-timeline.json", {
            "clips": [{"shot": 1, "start_us": 0, "duration_us": 1_000_000}], "body_end": 1,
        })
        self.put_json(f"editing/{prefix}{ep}-sources.json", {
            "shots": [{"shot": 1, "video": video}],
        })

    def test_explicit_140_to_219_of_300_accepts_without_earlier_episode_work(self):
        ids = [str(ep) for ep in range(140, 220)]
        for ep in ids:
            self.add_episode(ep)
        self.scope(ids)
        result = write_pass_records(self.root)
        self.assertEqual(result["accept_status"], "passed")
        self.assertEqual(result["expected_episodes"], ids)
        self.assertEqual(result["declared_episode_count"], 300)
        self.assertEqual(paid_ready(self.root, ids)["status"], "passed")
        self.assertFalse((self.root / "episodes/01.txt").exists())
        state = PipelineState(self.root).project_stages(dry_run=True)["episodes"]
        self.assertEqual(state["projected"], "completed")
        self.assertEqual(state["note"]["completion_scope"], "work_scope")
        self.assertEqual(state["note"]["story_episode_count"], 300)
        self.assertEqual(state["note"]["episodes"], 80)

    def test_first_middle_and_last_declared_episode_cannot_disappear(self):
        ids = ["140", "141", "142"]
        for ep in ids:
            self.add_episode(ep)
        for missing in ids:
            with self.subTest(missing=missing):
                row = self.manifest["episodes"].pop(missing)
                source = self.root / f"episodes/{missing}.txt"
                text = source.read_text(encoding="utf-8")
                source.unlink()
                self.scope(ids)
                audit = write_pass_records(self.root, ["141"])
                self.assertEqual(audit["accept_status"], "blocked")
                self.assertIn("EP" + missing, " ".join(audit["source_reasons"]))
                state = PipelineState(self.root)._episode_inventory()
                self.assertEqual(state["issues"], audit["source_reasons"])
                self.assertEqual(paid_ready(self.root, ["141"])["status"], "blocked")
                self.manifest["episodes"][missing] = row
                self.put(f"episodes/{missing}.txt", text)

    def test_scope_never_defaults_to_existing_minimum_and_maximum(self):
        self.add_episode("140")
        self.add_episode("141")
        self.save_manifest()
        self.assertFalse(audit_project(self.root)["source_integrity"])
        del self.manifest["expected_episode_count"]
        self.save_manifest()
        self.assertFalse(audit_project(self.root)["source_integrity"])

    def test_legacy_full_story_retains_prefix_acceptance(self):
        self.manifest["expected_episode_count"] = 2
        self.add_episode("01")
        self.add_episode("02")
        self.save_manifest()
        self.assertEqual(write_pass_records(self.root, ["02"])["accept_status"], "blocked")
        self.assertEqual(write_pass_records(self.root, ["01", "02"])["accept_status"], "passed")
        self.assertEqual(paid_ready(self.root, ["02"])["status"], "passed")

    def test_explicit_scope_supports_independent_and_nonconsecutive_assignments(self):
        self.add_episode("140", reviewed=False)
        self.add_episode("141")
        self.add_episode("219")
        self.scope(["140", "141", "219"])
        result = write_pass_records(self.root, ["141", "219"])
        self.assertEqual(result["accept_status"], "passed")
        self.assertEqual(result["status"], "pending")
        self.assertEqual(paid_ready(self.root, ["141", "219"])["status"], "passed")
        self.assertEqual(paid_ready(self.root, ["140"])["status"], "blocked")
        for ids in (["219", "141"], ["141", "141"]):
            self.assertEqual(paid_ready(self.root, ids)["status"], "blocked")

    def test_out_of_scope_submission_blocked_even_when_manifest_has_episode(self):
        self.add_episode("139")
        self.add_episode("140")
        self.scope(["140"])
        self.assertEqual(write_pass_records(self.root, ["139"])["accept_status"], "blocked")
        self.assertEqual(write_pass_records(self.root, ["140"])["accept_status"], "passed")
        for ids in (["139"], ["141"], ["0140"], ["1400"], [], ["١٤٠"]):
            self.assertEqual(paid_ready(self.root, ids)["status"], "blocked")

    def test_malformed_scope_fails_closed(self):
        self.add_episode("140")
        for value in (None, [], {}, {"start": 140, "end": 140}, {"episode_ids": []},
                      {"episode_ids": [140]}, {"episode_ids": ["0140"]},
                      {"episode_ids": ["140", "140"]}, {"episode_ids": ["141", "140"]},
                      {"episode_ids": ["00"]}, {"episode_ids": ["301"]},
                      {"episode_ids": ["10000"]}, {"episode_ids": ["140"], "all": True}):
            with self.subTest(value=value):
                self.manifest["work_scope"] = value
                self.save_manifest()
                self.assertEqual(audit_project(self.root)["status"], "failed")
                self.assertEqual(write_pass_records(self.root, ["140"])["accept_status"], "blocked")
                self.assertEqual(paid_ready(self.root, ["140"])["status"], "blocked")
        self.assertFalse((self.root / "shots_and_matches/ep140-coverage-acceptance.json").exists())

    def test_duplicate_scope_episode_or_hash_keys_fail_audit_and_projection(self):
        self.add_episode("140")
        self.add_episode("141")
        self.scope(["140", "141"])
        self.assertEqual(write_pass_records(self.root)["accept_status"], "passed")
        (self.root / "episodes/141.txt").unlink()
        original = json.dumps(self.manifest)
        row = json.dumps(self.manifest["episodes"]["140"])
        fixtures = [
            original[:-1] + ', "work_scope": {"episode_ids": ["140"]}}',
            original.replace('"140": ' + row, '"140": ' + row + ', "140": ' + row),
            original.replace('"sha256": ', '"sha256": "' + 'a' * 64 + '", "sha256": ', 1),
        ]
        for text in fixtures:
            with self.subTest(text=text):
                self.put("episodes/manifest.json", text)
                self.assertEqual(paid_ready(self.root, ["140"])["status"], "blocked")
                audit = audit_project(self.root)
                self.assertIn("重复字段", " ".join(audit["source_reasons"]))
                self.assertEqual(PipelineState(self.root).project_stages(dry_run=True)["episodes"]["projected"], "failed")

    def test_bad_story_totals_or_manifest_versions_fail_closed(self):
        self.add_episode("140")
        for field, values in (("expected_episode_count", [None, True, 0, "300", 10000, 139]),
                              ("version", [True, 2, "1"])):
            original = self.manifest[field]
            for value in values:
                with self.subTest(field=field, value=value):
                    self.manifest[field] = value
                    self.scope(["140"])
                    self.assertEqual(audit_project(self.root)["status"], "failed")
            self.manifest[field] = original

    def test_unrelated_manifest_changes_preserve_episode_acceptance(self):
        self.add_episode("140")
        self.scope(["140"])
        self.assertEqual(write_pass_records(self.root)["accept_status"], "passed")
        self.manifest["episodes"]["219"] = {"sha256": "a" * 64}
        self.manifest["source_mtime"] = 123456
        self.save_manifest()
        self.assertEqual(paid_ready(self.root, ["140"])["status"], "passed")
        self.manifest["episodes"]["219"]["sha256"] = "b" * 64
        self.put("episodes/manifest.json", json.dumps(self.manifest, indent=4))
        self.assertTrue(audit_project(self.root)["episodes"]["140"]["accepted"])
        self.assertEqual(paid_ready(self.root, ["140"])["status"], "passed")

    def test_two_collaborators_merge_local_approvals_without_resigning(self):
        self.add_episode("140")
        self.add_episode("219")
        self.scope(["140"])
        self.assertEqual(write_pass_records(self.root)["accept_status"], "passed")
        with tempfile.TemporaryDirectory() as directory:
            other = Path(directory)
            shutil.copytree(self.root / "episodes", other / "episodes")
            shutil.copytree(self.root / "shots", other / "shots")
            shutil.copytree(self.root / "shots_and_matches", other / "shots_and_matches")
            (other / "episodes/140.txt").unlink()
            manifest = {**self.manifest, "work_scope": {"episode_ids": ["219"]}}
            (other / "episodes/manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            self.assertEqual(write_pass_records(other)["accept_status"], "passed")
            shutil.copyfile(other / "shots_and_matches/ep219-coverage-acceptance.json",
                            self.root / "shots_and_matches/ep219-coverage-acceptance.json")
        self.scope(["140", "219"])
        self.assertEqual(paid_ready(self.root, ["140", "219"])["status"], "passed")

    def test_changed_current_dependencies_invalidate_approval(self):
        self.add_episode("140")
        self.scope(["140"])
        self.assertEqual(write_pass_records(self.root)["accept_status"], "passed")
        for relative in ("episodes/140.txt", "shots/第140集镜头脚本.md",
                         "shots_and_matches/ep140-source-map.json"):
            with self.subTest(relative=relative):
                path = self.root / relative
                original = path.read_text(encoding="utf-8")
                self.put(relative, original + "\n")
                self.assertEqual(paid_ready(self.root, ["140"])["status"], "blocked")
                self.put(relative, original)
        self.manifest["episodes"]["140"]["char_count"] += 1
        self.save_manifest()
        self.assertEqual(paid_ready(self.root, ["140"])["status"], "blocked")
        self.manifest["episodes"]["140"]["char_count"] -= 1
        self.manifest["filter_options"] = {"filter_episode_title": True}
        self.save_manifest()
        self.assertEqual(paid_ready(self.root, ["140"])["status"], "blocked")

    def test_future_scope_source_tampering_still_blocks_signing(self):
        self.add_episode("140")
        self.add_episode("141")
        self.scope(["140", "141"])
        self.put("episodes/141.txt", "tampered")
        self.assertEqual(write_pass_records(self.root, ["140"])["accept_status"], "blocked")
        self.assertEqual(paid_ready(self.root, ["140"])["status"], "blocked")

    def test_legacy_record_requires_original_whole_manifest_hash(self):
        self.manifest["expected_episode_count"] = 1
        self.add_episode("01")
        self.save_manifest()
        self.assertEqual(write_pass_records(self.root)["accept_status"], "passed")
        path = self.root / "shots_and_matches/ep01-coverage-acceptance.json"
        record = json.loads(path.read_text(encoding="utf-8"))
        record.update(version=1, manifest_sha256=hashlib.sha256((self.root / "episodes/manifest.json").read_bytes()).hexdigest())
        del record["episode_manifest_sha256"]
        self.put_json(str(path.relative_to(self.root)), record)
        self.assertEqual(paid_ready(self.root, ["01"])["status"], "passed")
        self.put("episodes/manifest.json", json.dumps(self.manifest, indent=2))
        self.assertEqual(paid_ready(self.root, ["01"])["status"], "blocked")
        self.assertEqual(write_pass_records(self.root)["accept_status"], "passed")
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["version"], 2)

    def test_scoped_downstream_projection_ignores_other_collaborators_and_keeps_140(self):
        for ep in ("14", "140"):
            self.add_episode(ep)
            self.put_json(f"matches/{ep}.matched.json", {})
            self.put_json(f"episode_packages/{ep}/package.json", {})
            self.put(f"media/ep{ep}/p01.mp4", "fake")
            self.editing_inputs(ep, prefix="ep")
            self.put(f"export/delivery-ep{ep}.mp4", "fake")
        self.scope(["140"])
        before = PipelineState(self.root).project_stages(dry_run=True)
        self.assertNotEqual(before["export"]["projected"], "completed")
        self.assertFalse(before["export"]["note"]["legacy_single_without_coverage"])
        self.assertEqual(write_pass_records(self.root)["accept_status"], "passed")
        state = PipelineState(self.root)
        self.assertEqual(state._facts()["episodes_delivered"], {"140"})
        after = state.project_stages(dry_run=True)
        for stage in ("shots_and_matches", "video_tasks", "draft", "export"):
            self.assertEqual(after[stage]["projected"], "completed")
        (self.root / "export/delivery-ep140.mp4").unlink()
        self.assertNotEqual(state.project_stages(dry_run=True)["export"]["projected"], "completed")

    def test_physical_written_object_exception_never_hides_additional_speech(self):
        self.add_episode("140")
        self.scope(["140"])
        for line, expected in (
            ("△他拿起说明书。", "passed"),
            ("△甲拿起说明书，大声朗读。", "blocked"),
            ("△他拿起说明书，大声朗读。", "blocked"),
            ("△甲查看问卷，读出上面的内容。", "blocked"),
            ("△他拿起说明书，宣读条款。", "blocked"),
            ("△甲朗读后拿起说明书。", "blocked"),
            ("△他一边翻开问卷一边说。", "blocked"),
        ):
            with self.subTest(line=line):
                text = f"第140集\n甲：收到。\n{line}"
                self.put("episodes/140.txt", text)
                self.manifest["episodes"]["140"] = {"sha256": digest(text), "char_count": len(text)}
                self.save_manifest()
                path = self.root / "shots_and_matches/ep140-source-map.json"
                mapping = json.loads(path.read_text(encoding="utf-8"))
                mapping["source_sha256"] = digest(text)
                mapping["entries"][2]["source_text"] = line
                self.put_json(str(path.relative_to(self.root)), mapping)
                result = write_pass_records(self.root, ["140"])
                self.assertEqual(result["accept_status"], expected)
                self.assertEqual(paid_ready(self.root, ["140"])["status"], expected)
                if expected == "blocked":
                    self.assertFalse(result["episodes"]["140"]["accepted"])
                    self.assertEqual(result["episodes"]["140"]["status"], "pending")

    def test_scoped_editing_projection_reads_prepared_and_legacy_episode_names(self):
        ids = ["14", "140", "1000"]
        self.manifest["expected_episode_count"] = 1000
        for ep in ids:
            self.add_episode(ep)
            self.editing_inputs(ep)
        self.scope(ids)
        self.assertEqual(write_pass_records(self.root)["accept_status"], "passed")
        for ep in ("01", "0140", "1400", "10000", "١٤٠"):
            for prefix in ("", "ep"):
                self.put_json(f"editing/{prefix}{ep}-timeline.json", {})

        state = PipelineState(self.root)
        self.assertEqual({path.name for path in state._facts()["editing"]}, {
            f"{ep}-{suffix}.json" for ep in ids for suffix in ("timeline", "sources")
        })
        draft = state.project_stages(dry_run=True)["draft"]
        self.assertEqual(draft["projected"], "completed")
        self.assertEqual(draft["note"]["episodes_with_draft"], 3)
        self.assertEqual(draft["note"]["files"], 6)

        for suffix in ("timeline", "sources"):
            (self.root / f"editing/140-{suffix}.json").unlink()
        draft = state.project_stages(dry_run=True)["draft"]
        self.assertEqual(draft["projected"], "review")
        self.assertEqual(draft["note"]["episodes_with_draft"], 2)
        self.editing_inputs("140", prefix="ep")
        draft = state.project_stages(dry_run=True)["draft"]
        self.assertEqual(draft["projected"], "completed")
        self.assertEqual(draft["note"]["episodes_with_draft"], 3)

    def test_legacy_full_story_projection_reads_prepared_editing_names(self):
        self.manifest["expected_episode_count"] = 1
        self.add_episode("01")
        self.save_manifest()
        self.assertEqual(write_pass_records(self.root)["accept_status"], "passed")
        self.editing_inputs("01")
        state = PipelineState(self.root)
        self.assertEqual(state.project_stages(dry_run=True)["draft"]["projected"], "completed")
        (self.root / "editing/01-timeline.json").unlink()
        (self.root / "editing/01-sources.json").unlink()
        self.editing_inputs("01", prefix="ep")
        self.assertEqual(state.project_stages(dry_run=True)["draft"]["projected"], "completed")

    def test_scoped_draft_projection_rejects_unrelated_partial_and_invalid_editing_evidence(self):
        self.add_episode("140")
        self.scope(["140"])
        self.assertEqual(write_pass_records(self.root)["accept_status"], "passed")
        self.put("editing/140-notes.txt", "notes")
        self.put("editing/ep140-transcript.md", "transcript")
        timeline = self.root / "editing/140-timeline.json"
        sources = self.root / "editing/140-sources.json"
        timeline.mkdir()
        state = PipelineState(self.root)
        self.assertEqual(state._facts()["editing"], [])
        self.assertEqual(state.project_stages(dry_run=True)["draft"]["projected"], "pending")
        timeline.rmdir()
        self.editing_inputs("14")
        self.assertEqual(state.project_stages(dry_run=True)["draft"]["projected"], "pending")
        self.editing_inputs("140")
        draft = state.project_stages(dry_run=True)["draft"]
        self.assertEqual(draft["projected"], "completed")
        self.assertEqual(draft["note"]["completion_basis"], "editing_inputs")
        self.assertFalse(draft["note"]["editable_draft_verified"])
        original = {path: path.read_bytes() for path in (timeline, sources)}
        for missing in (timeline, sources):
            with self.subTest(missing=missing.name):
                missing.unlink()
                self.assertNotEqual(state.project_stages(dry_run=True)["draft"]["projected"], "completed")
                missing.write_bytes(original[missing])
        for path, document in (
            (timeline, "not JSON"), (sources, "not JSON"),
            (timeline, {"clips": []}), (sources, {"shots": []}),
            (timeline, {"clips": [{"shot": 1, "start_us": 0, "duration_us": True}]}),
            (sources, {"shots": [{"shot": 1, "video": "video/absent.mp4"}]}),
            (sources, {"shots": [{"shot": 14, "video": "video/140/shot_001.mp4"}]}),
        ):
            with self.subTest(path=path.name, document=document):
                path.write_text(document if isinstance(document, str) else json.dumps(document), encoding="utf-8")
                self.assertNotEqual(state.project_stages(dry_run=True)["draft"]["projected"], "completed")
                path.write_bytes(original[path])
        self.editing_inputs("140", prefix="ep")
        sources.unlink()
        self.assertNotEqual(state.project_stages(dry_run=True)["draft"]["projected"], "completed")
        sources.mkdir()
        self.assertNotEqual(state.project_stages(dry_run=True)["draft"]["projected"], "completed")
        sources.rmdir()
        timeline.unlink()
        self.assertEqual(state.project_stages(dry_run=True)["draft"]["projected"], "completed")

    def test_prepared_editing_clock_rejects_overlap_gaps_and_invalid_body_end(self):
        self.add_episode("140")
        self.scope(["140"])
        self.assertEqual(write_pass_records(self.root)["accept_status"], "passed")
        self.put("video/140/shot_001.mp4", "first source")
        self.put("video/140/shot_002.mp4", "second source")
        self.put_json("editing/140-sources.json", {"shots": [
            {"shot": number, "video": f"video/140/shot_{number:03}.mp4"} for number in (1, 2)
        ]})
        clips = [
            {"shot": 1, "start_us": 0, "duration_us": 1_000_000},
            {"shot": 2, "start_us": 1_000_000, "duration_us": 1_000_000},
        ]
        state = PipelineState(self.root)
        self.put_json("editing/140-timeline.json", {"clips": clips, "body_end": 2})
        self.assertEqual(state.project_stages(dry_run=True)["draft"]["projected"], "completed")
        for first_start, second_start in ((0, 0), (0, 9_000_000), (5_000_000, 6_000_000)):
            with self.subTest(first_start=first_start, second_start=second_start):
                changed = [{**clips[0], "start_us": first_start}, {**clips[1], "start_us": second_start}]
                self.put_json("editing/140-timeline.json", {"clips": changed})
                self.assertNotEqual(state.project_stages(dry_run=True)["draft"]["projected"], "completed")
        for body_end in (None, True, "2", -1, 0.5, 3, float("nan"), float("inf")):
            with self.subTest(body_end=body_end):
                self.put_json("editing/140-timeline.json", {"clips": clips, "body_end": body_end})
                self.assertNotEqual(state.project_stages(dry_run=True)["draft"]["projected"], "completed")
        self.put_json("editing/140-timeline.json", {"clips": clips})
        self.assertEqual(state.project_stages(dry_run=True)["draft"]["projected"], "completed")
        included = [clips[0], {**clips[1], "duration_us": 3_000_000}]
        self.put_json("editing/140-timeline.json", {"clips": included, "body_end": 2})
        self.assertEqual(state.project_stages(dry_run=True)["draft"]["projected"], "completed")
        invalid_included = [clips[0], {**clips[1], "duration_us": 2_000_000}]
        self.put_json("editing/140-timeline.json", {"clips": invalid_included, "body_end": 1})
        self.assertNotEqual(state.project_stages(dry_run=True)["draft"]["projected"], "completed")

    def test_cli_gate_reports_scope_and_blocks_unaccepted_episode(self):
        self.add_episode("140")
        self.add_episode("141", reviewed=False)
        self.scope(["140", "141"])
        script = Path(__file__).resolve().parents[2] / "skills/tweet-drama-core/scripts/episode_coverage.py"
        accepted = subprocess.run([sys.executable, "-B", str(script), str(self.root), "accept", "140"],
                                  capture_output=True, text=True, encoding="utf-8", check=False)
        self.assertEqual(accepted.returncode, 0, accepted.stdout + accepted.stderr)
        result = json.loads(accepted.stdout)
        self.assertEqual(result["expected_episodes"], ["140", "141"])
        self.assertTrue(result["explicit_work_scope"])
        self.assertEqual(result["status"], "pending")


class ConservativeActionTests(unittest.TestCase):
    def test_four_digit_scene_ids_do_not_include_five_digits_or_numeric_speech(self):
        for line in ("1000-1 老宅 日内", "9999-1 山路 日外"):
            self.assertEqual(_non_speech_kind(line), "scene")
        for line in ("10000-1 老宅 日内", "1000：收到。", "1000-1：收到。"):
            self.assertIsNone(_non_speech_kind(line))

    def test_written_object_words_are_not_automatically_speech(self):
        for line in ("△他拿起说明书。", "▲她翻开问卷。", "动作：放下答题卡。", "画面：两人合上说明文件。"):
            with self.subTest(line=line):
                self.assertEqual(_non_speech_kind(line), "action")
                self.assertIsNone(_source_speech(line))

    def test_dialogue_or_ambiguous_explanation_cannot_hide_in_action(self):
        for verb in ("说", "问", "答", "说明"):
            line = f"△甲{verb}：收到。"
            with self.subTest(line=line):
                self.assertIsNone(_non_speech_kind(line))
                if verb != "说明":
                    self.assertEqual(_source_speech(line), ("dialogue", "甲", "收到。"))
        for line in ("△甲一边铺纸一边说。", "△甲说明来路。", "△甲拿起说明书，说：收到。",
                     "△甲阅读说明书上的话：收到。", "△甲查看问卷并问他姓名。", "△甲放下答题卡，念出答案。"):
            with self.subTest(line=line):
                self.assertIsNone(_non_speech_kind(line))


if __name__ == "__main__":
    unittest.main()
