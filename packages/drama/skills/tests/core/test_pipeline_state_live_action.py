import hashlib
import json
import tempfile
import unittest
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "skills" / "tweet-drama-core" / "scripts"))
from pipeline_state import STAGES, PipelineState


class LiveActionPipelineStateTests(unittest.TestCase):
    def test_stage_chain_matches_autonomous_jubian_pipeline(self):
        self.assertEqual(
            STAGES,
            (
                "source", "episodes", "style", "asset_prompts", "asset_candidates",
                "official_assets", "shots_and_matches", "video_tasks",
                "reviewed_videos", "draft", "export",
            ),
        )

    def test_new_project_initializes_every_stage(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            state = PipelineState(Path(directory) / "demo")
            self.assertEqual(tuple(state.data["stages"]), STAGES)


class EpisodeProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name)

    def put(self, relative, value):
        path = self.project / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding="utf-8")

    def split(self, episodes, expected_episode_count=None):
        manifest = {"version": 1, "episodes": {}}
        if expected_episode_count is not None:
            manifest["expected_episode_count"] = expected_episode_count
        for episode in episodes:
            text = f"第{episode}集\n角色：台词{episode}"
            self.put(f"episodes/{episode}.txt", text)
            manifest["episodes"][episode] = {"sha256": hashlib.sha256(text.encode()).hexdigest()}
        self.put("episodes/manifest.json", json.dumps(manifest))

    def products(self, episodes):
        for episode in episodes:
            self.put(f"shots/第{episode}集镜头脚本.md", "shot")
            self.put(f"matches/{episode}.matched.json", "{}")
            self.put(f"episode_packages/{episode}/package.json", "{}")
            self.put(f"media/ep{episode}/p01.mp4", "mock video")
            self.put(f"editing/ep{episode}-timeline.json", "{}")
            self.put(f"export/delivery-ep{episode}.mp4", "mock delivery")

    def projected(self, expected, accepted):
        audit = {"status": "passed" if set(expected) == set(accepted) else "pending",
                 "expected_episodes": list(expected), "reasons": [],
                 "source_integrity": True,
                 "episodes": {episode: {"status": "passed", "accepted": episode in accepted}
                              for episode in expected}}
        with patch("pipeline_state.audit_project", return_value=audit):
            return PipelineState(self.project).project_stages(dry_run=True)

    def test_gap_in_manifest_fails_even_when_artifact_counts_match(self):
        self.split(("01", "03"))
        self.products(("01", "03"))
        stages = self.projected(("01", "03"), ("01", "03"))
        self.assertEqual(stages["episodes"]["projected"], "failed")
        self.assertIn("consecutive", " ".join(stages["episodes"]["note"]["missing_evidence"]))
        self.assertNotEqual(stages["shots_and_matches"]["projected"], "completed")
        self.assertNotEqual(stages["video_tasks"]["projected"], "completed")
        self.assertNotEqual(stages["draft"]["projected"], "completed")
        self.assertNotEqual(stages["export"]["projected"], "completed")

    def test_declared_count_detects_missing_tail_and_accepts_complete_fifty_two(self):
        first_fifty_one = tuple(f"{number:02d}" for number in range(1, 52))
        self.split(first_fifty_one, expected_episode_count=52)
        missing = self.projected(first_fifty_one, first_fifty_one)
        self.assertEqual(missing["episodes"]["projected"], "failed")
        self.assertIn("52", " ".join(missing["episodes"]["note"]["missing_evidence"]))
        self.assertNotEqual(missing["video_tasks"]["projected"], "completed")

        all_fifty_two = (*first_fifty_one, "52")
        self.split(all_fifty_two, expected_episode_count=52)
        complete = self.projected(all_fifty_two, all_fifty_two)
        self.assertEqual(complete["episodes"]["projected"], "completed")

    def test_unrelated_episode_artifacts_cannot_satisfy_expected_episodes(self):
        self.split(("01", "02"))
        self.products(("01", "03"))
        stages = self.projected(("01", "02"), ("01", "02"))
        self.assertEqual(stages["episodes"]["projected"], "completed")
        self.assertEqual(stages["shots_and_matches"]["projected"], "review")
        self.assertEqual(stages["video_tasks"]["projected"], "review")
        self.assertEqual(stages["draft"]["projected"], "review")
        self.assertNotEqual(stages["export"]["projected"], "completed")
        self.assertEqual(stages["shots_and_matches"]["note"]["unexpected_scripts"], ["03"])
        self.assertEqual(stages["video_tasks"]["note"]["unexpected_generated"], ["03"])

    def test_changed_split_source_sha_fails_projection(self):
        self.split(("01",))
        self.products(("01",))
        self.put("episodes/01.txt", "changed text")
        stages = self.projected(("01",), ("01",))
        self.assertEqual(stages["episodes"]["projected"], "failed")
        self.assertIn("EP01", " ".join(stages["episodes"]["note"]["missing_evidence"]))
        self.assertNotEqual(stages["video_tasks"]["projected"], "completed")

    def test_unaccepted_coverage_keeps_downstream_in_review(self):
        self.split(("01",))
        self.products(("01",))
        self.put("shots_and_matches/ep01-source-map.json", "{}")
        stages = self.projected(("01",), ())
        self.assertEqual(stages["episodes"]["projected"], "completed")
        self.assertEqual(stages["shots_and_matches"]["projected"], "review")
        self.assertEqual(stages["video_tasks"]["projected"], "review")
        self.assertEqual(stages["draft"]["projected"], "review")
        self.assertNotEqual(stages["export"]["projected"], "completed")
        self.assertEqual(stages["video_tasks"]["note"]["coverage_pending"], ["01"])

    def test_review_evidence_does_not_complete_a_manifest_project_without_coverage(self):
        self.split(("01",))
        self.put("shots_and_matches/ep01-source-map.json", "{}")
        with patch.object(PipelineState, "_reviewed_sources", return_value=(["01"], [], [])):
            unaccepted = self.projected(("01",), ())
            accepted = self.projected(("01",), ("01",))
        self.assertEqual(unaccepted["reviewed_videos"]["projected"], "review")
        self.assertEqual(unaccepted["reviewed_videos"]["note"]["coverage_pending"], ["01"])
        self.assertEqual(accepted["reviewed_videos"]["projected"], "completed")

    def test_manual_completed_remains_visible_but_projection_reports_unaccepted_coverage(self):
        self.split(("01",))
        self.products(("01",))
        self.put("shots_and_matches/ep01-source-map.json", "{}")
        state = PipelineState(self.project)
        state.set("video_tasks", "completed")
        stages = self.projected(("01",), ())
        self.assertEqual(stages["video_tasks"]["status"], "completed")
        self.assertEqual(stages["video_tasks"]["projected"], "review")
        self.assertEqual(stages["video_tasks"]["note"]["coverage_pending"], ["01"])

    def test_legacy_single_manifest_keeps_exact_episode_projection(self):
        self.split(("01",))
        self.products(("01",))
        stages = self.projected(("01",), ())
        for stage in ("shots_and_matches", "video_tasks", "draft", "export"):
            self.assertEqual(stages[stage]["projected"], "completed")
            self.assertTrue(stages[stage]["note"]["legacy_single_without_coverage"])

    def test_multi_episode_without_coverage_does_not_use_legacy_projection(self):
        self.split(("01", "02"))
        self.products(("01", "02"))
        stages = self.projected(("01", "02"), ())
        for stage in ("shots_and_matches", "video_tasks", "draft", "export"):
            self.assertNotEqual(stages[stage]["projected"], "completed")
            self.assertFalse(stages[stage]["note"]["legacy_single_without_coverage"])

    def test_current_accepted_coverage_completes_one_and_multiple_episodes(self):
        for episodes in (("01",), ("01", "02")):
            with self.subTest(episodes=episodes):
                self.split(episodes)
                self.products(episodes)
                stages = self.projected(episodes, episodes)
                self.assertEqual(stages["episodes"]["projected"], "completed")
                self.assertEqual(stages["shots_and_matches"]["projected"], "completed")
                self.assertEqual(stages["video_tasks"]["projected"], "completed")
                self.assertEqual(stages["draft"]["projected"], "completed")
                self.assertEqual(stages["export"]["projected"], "completed")


if __name__ == "__main__":
    unittest.main()
