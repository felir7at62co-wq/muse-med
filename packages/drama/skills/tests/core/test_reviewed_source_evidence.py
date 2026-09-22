"""Review projection requires selected bytes and package-complete evidence."""
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "skills" / "tweet-drama-core" / "scripts" / "pipeline_state.py"
SPEC = importlib.util.spec_from_file_location("pipeline_state_evidence", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReviewedSourcesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.put("episodes/01.txt", "episode")
        self.put("episode_packages/01/package.json", {"video_tasks": [{"shots": [1]}, {"shots": [2]}]})
        self.package_sha256 = hashlib.sha256((self.root / "episode_packages/01/package.json").read_bytes()).hexdigest()
        self.rows = []
        for package in (1, 2):
            video = f"media/ep01/p{package:02}-clean.mp4"
            self.put(video, f"video {package}")
            self.put(f"video/01/shot_{package:03}.mp4", f"video {package}")
            digest = hashlib.sha256(f"video {package}".encode()).hexdigest()
            frame = f"reviews/p{package}.jpg"
            self.put(frame, "frame")
            self.put(f"reviews/ep01-p{package:02}.json", {
                "episode": 1, "package": package, "status": "approved", "video_path": video,
                "video_sha256": digest, "package_sha256": self.package_sha256, "subtitle_cleanup": "clean", "review_frames": [frame],
                "content_review": {**{key: "pass" for key in (
                    "identity", "wardrobe", "scene", "prop", "action_and_dialogue", "visible_artifacts"
                )}, "embedded_subtitles": "absent"},
            })
            self.rows.append({"shot": package, "package": package, "video": video, "sha256": digest,
                              "package_sha256": self.package_sha256})
        self.put("editing/01-sources.json", {"shots": self.rows})
        self.put("editing/01-timeline.json", {"clips": [{"shot": 1}, {"shot": 2}], "body_end": 2})

    def put(self, relative, value):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) if isinstance(value, (dict, list)) else value, encoding="utf-8")

    def projected(self):
        return MODULE.PipelineState(self.root).project_stages(dry_run=True)["reviewed_videos"]

    def test_complete_only_with_all_expected_selected_packages(self):
        self.assertEqual(self.projected()["projected"], "completed")
        self.put("editing/01-sources.json", {"shots": self.rows[:1]})
        self.assertEqual(self.projected()["projected"], "review")

    def test_clean_filename_is_not_evidence(self):
        (self.root / "editing/01-sources.json").unlink()
        self.assertEqual(self.projected()["projected"], "review")
        self.assertTrue(self.projected()["note"]["missing_evidence"])

    def test_changed_bytes_or_pending_subtitles_require_review(self):
        self.put("video/01/shot_001.mp4", "replacement")
        self.assertEqual(self.projected()["projected"], "review")
        self.put("video/01/shot_001.mp4", "video 1")
        path = self.root / "reviews/ep01-p01.json"
        review = json.loads(path.read_text())
        review["subtitle_cleanup"] = "pending"
        self.put("reviews/ep01-p01.json", review)
        self.assertEqual(self.projected()["projected"], "review")

    def test_missing_frames_or_explicit_package_mapping_require_review(self):
        (self.root / "reviews/p1.jpg").unlink()
        self.assertEqual(self.projected()["projected"], "review")
        self.put("reviews/p1.jpg", "frame")
        self.rows[0].pop("package")
        self.put("editing/01-sources.json", {"shots": self.rows})
        self.assertEqual(self.projected()["projected"], "review")

    def test_same_package_can_supply_multiple_selected_clips(self):
        self.rows.append({**self.rows[0], "shot": 3})
        self.put("video/01/shot_003.mp4", "video 1")
        self.put("editing/01-timeline.json", {"clips": [{"shot": n} for n in (1, 2, 3)], "body_end": 3})
        self.put("editing/01-sources.json", {"shots": self.rows})
        self.assertEqual(self.projected()["projected"], "completed")

    def test_incomplete_content_review_or_unknown_embedded_text_stays_review(self):
        review = json.loads((self.root / "reviews/ep01-p01.json").read_text())
        for checks in ({"identity": "pass"}, {"embedded_subtitles": "unknown"}):
            review["content_review"] = checks
            self.put("reviews/ep01-p01.json", review)
            self.assertEqual(self.projected()["projected"], "review")

    def test_same_count_recompile_invalidates_reviewed_package_identity(self):
        self.assertEqual(self.projected()["projected"], "completed")
        self.put("episode_packages/01/package.json", {"video_tasks": [{"shots": [2]}, {"shots": [1]}]})
        self.assertEqual(self.projected()["projected"], "review")

    def test_timeline_membership_must_match_selected_clips(self):
        self.put("editing/01-timeline.json", {"clips": [{"shot": 1}], "body_end": 1})
        self.assertEqual(self.projected()["projected"], "review")

    def test_missing_expected_episode_never_passes_from_an_unrelated_episode(self):
        self.put("episodes/02.txt", "episode")
        self.put("media/ep99/p01-clean.mp4", "not episode 2")
        self.assertEqual(self.projected()["projected"], "review")


if __name__ == "__main__":
    unittest.main()
