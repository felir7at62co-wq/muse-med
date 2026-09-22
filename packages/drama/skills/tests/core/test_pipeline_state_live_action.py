import tempfile
import unittest
from pathlib import Path
import sys

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


if __name__ == "__main__":
    unittest.main()
