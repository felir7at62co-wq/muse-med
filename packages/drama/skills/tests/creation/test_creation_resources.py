"""Offline creation-skill migration checks; no project or remote API access."""
from pathlib import Path
import unittest

PACK = Path(__file__).resolve().parents[2]
SKILLS = PACK / "skills"
NAMES = (
    "shot-script-creator-9-16", "tweet-drama-pipeline",
    "tweet-drama-early-shot-script", "tweet-drama-asset-extract",
    "tweet-drama-asset-vision-check", "tweet-drama-shot-asset-match",
)


class CreationResourcesTests(unittest.TestCase):
    def test_six_current_skills_are_packaged(self):
        for name in NAMES:
            with self.subTest(skill=name):
                self.assertTrue((SKILLS / name / "SKILL.md").is_file())

    def test_pipeline_requires_segmented_bgm(self):
        path = SKILLS / "tweet-drama-pipeline/SKILL.md"
        self.assertTrue(path.is_file())
        text = path.read_text(encoding="utf-8")
        self.assertIn("每集至少 2 段", text)
        self.assertIn("情绪", text)

    def test_current_narration_and_model_rules_survive(self):
        path = SKILLS / "shot-script-creator-9-16/SKILL.md"
        self.assertTrue(path.is_file())
        text = path.read_text(encoding="utf-8")
        self.assertIn("旁白、解说、心声/OS 保留身份、文字和发声方式", text)
        self.assertIn("不是硬上限", text)
        self.assertIn("上限来自当前分镜与实时模型目录", text)

    def test_compilation_uses_current_tool_without_missing_local_entry(self):
        text = (SKILLS / "tweet-drama-early-shot-script/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("drama_shot", text)
        self.assertNotIn("scripts/compile_director_shots.py", text)

    def test_spatial_examples_follow_current_director_format(self):
        root = SKILLS / "shot-script-creator-9-16/references"
        car = (root / "another-spice.md").read_text(encoding="utf-8")
        soccer = (root / "soccer-field-space.md").read_text(encoding="utf-8")
        self.assertNotIn("相机置于【", car)
        self.assertIn("【镜头1】", soccer)
        self.assertIn("主体状态追踪：", soccer)
        self.assertNotIn("【机位在", soccer)

    def test_asset_reconciliation_uses_available_remote_tools(self):
        text = (SKILLS / "tweet-drama-asset-extract/SKILL.md").read_text(encoding="utf-8")
        self.assertNotIn("python _tools/", text)
        self.assertIn("jubian_asset", text)
        self.assertIn("blocking", text)

    def test_only_maintenance_file_types_are_packaged(self):
        for name in NAMES:
            for path in (SKILLS / name).rglob("*"):
                if path.is_file():
                    with self.subTest(path=path):
                        self.assertIn(path.suffix, {".md", ".py", ".yaml"})
                        self.assertNotIn("__pycache__", path.parts)
                        self.assertNotIn("_legacy", path.parts)


if __name__ == "__main__":
    unittest.main()
