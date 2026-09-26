"""Offline checks for the complete maintained drama skill suite."""
import ast
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

PACKAGE = Path(__file__).resolve().parents[1]
SKILLS = PACKAGE / "skills"
sys.path.insert(0, str(SKILLS / "tweet-drama-core/scripts"))
from validate_live_action_skills import validate_skill_package

EXPECTED = {
    "jubian-asset-library", "jubian-snatch", "shot-script-creator-9-16", "xiaohongshu-reference",
    "tweet-drama-asset-extract", "tweet-drama-asset-vision-check",
    "tweet-drama-background-render", "tweet-drama-core", "tweet-drama-delivery",
    "tweet-drama-draft-build", "tweet-drama-early-shot-script", "tweet-drama-key-manager",
    "tweet-drama-pipeline", "tweet-drama-project-inspect", "tweet-drama-script-convert",
    "tweet-drama-script-split", "tweet-drama-shot-asset-match",
}


class SkillSuite(unittest.TestCase):
    def test_complete_suite_passes_live_action_validator(self):
        self.assertEqual({p.parent.name for p in SKILLS.glob("*/SKILL.md")}, EXPECTED)
        self.assertEqual(validate_skill_package(PACKAGE), [])

    def test_validator_rejects_unapproved_final_and_reapproval_rules(self):
        with tempfile.TemporaryDirectory(dir=PACKAGE / "tests") as folder:
            root = Path(folder)
            for source in SKILLS.glob("*/SKILL.md"):
                target = root / "skills" / source.parent.name / source.name
                target.parent.mkdir(parents=True)
                shutil.copyfile(source, target)
            pipeline = root / "skills/tweet-drama-pipeline/SKILL.md"
            self.assertTrue(pipeline.is_file())
            pipeline.write_text(pipeline.read_text(encoding="utf-8") + "\n取得本次即时批准\npending 表示可交付\n", encoding="utf-8")
            errors = validate_skill_package(root)
            self.assertTrue(any("取得本次即时批准" in error for error in errors))
            self.assertTrue(any("pending 表示可交付" in error for error in errors))

    def test_core_command_uses_loaded_skill_directory(self):
        core = (SKILLS / "tweet-drama-core/SKILL.md").read_text(encoding="utf-8")
        self.assertNotIn("<DSH_HOME>/skills/", core)
        self.assertIn("python -B scripts/pipeline_state.py", core)

    def test_current_creative_authority_and_bgm_rules_are_preserved(self):
        pipeline = (SKILLS / "tweet-drama-pipeline/SKILL.md").read_text(encoding="utf-8")
        shots = (SKILLS / "tweet-drama-early-shot-script/SKILL.md").read_text(encoding="utf-8")
        render = (SKILLS / "tweet-drama-background-render/SKILL.md").read_text(encoding="utf-8")
        for required in ("不是普遍硬门禁", "说话人", "旁白/心声", "实时目录", "不能静默换模型"):
            self.assertIn(required, pipeline)
        for required in ("不是普遍硬禁", "原文要求的发声不删", "max_submit_seconds", "实时模型目录"):
            self.assertIn(required, shots)
        for required in ("一集的 BGM 必须多于一首", "按正文情绪分段选曲", "valence/arousal", "仅限非商业用途"):
            self.assertIn(required, render)

    def test_shipped_scripts_start_console_children_hidden(self):
        """A windowless parent must pass CREATE_NO_WINDOW, or Windows pops a console."""
        launches = 0
        for path in sorted(SKILLS.rglob("*.py")):
            if "__pycache__" in path.parts:
                continue
            source = path.read_text(encoding="utf-8")
            calls = [
                node for node in ast.walk(ast.parse(source))
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name) and node.func.value.id == "subprocess"
                and node.func.attr in {"run", "Popen", "call", "check_call", "check_output"}
            ]
            if not calls:
                continue
            self.assertIn('NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)', source, str(path))
            for call in calls:
                flags = [keyword for keyword in call.keywords if keyword.arg == "creationflags"]
                self.assertEqual([ast.unparse(flag.value) for flag in flags], ["NO_WINDOW"],
                                 f"{path}:{call.lineno} starts a console child without CREATE_NO_WINDOW")
                launches += 1
        self.assertGreater(launches, 0, "no shipped subprocess launch was checked")
        if hasattr(subprocess, "CREATE_NO_WINDOW"):
            self.assertEqual(subprocess.CREATE_NO_WINDOW, 0x08000000)


if __name__ == "__main__":
    unittest.main()
