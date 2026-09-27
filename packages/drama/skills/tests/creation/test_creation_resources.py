"""Offline creation-skill migration checks; no project or remote API access."""
from pathlib import Path
import re
import unittest

PACK = Path(__file__).resolve().parents[2]
SKILLS = PACK / "skills"
NAMES = (
    "shot-script-creator-9-16", "tweet-drama-pipeline",
    "tweet-drama-early-shot-script", "tweet-drama-asset-extract",
    "tweet-drama-asset-vision-check", "tweet-drama-shot-asset-match",
)

# A path that only exists in one packaged layout: the Electron install root, a
# node_modules tree, or an operator's own disk. Skill prose must resolve
# everything else against the base directory the loader reports per load, and may
# name those layouts only to forbid them (a bare `app.asar` with no path).
FIXED_INSTALL_ROOT = re.compile(
    r"app\.asar(?:\.unpacked)?[\\/]|node_modules[\\/]|resources[\\/]app[\\/]"
    r"|(?<![A-Za-z0-9])[A-Za-z]:[\\/]{1,2}(?:muse|dsh|muse-med)\b"
    r"|E:[\\/]{1,2}aa-manju",
    re.IGNORECASE,
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

    def test_self_check_judges_shot_fields_not_whole_file_text(self):
        text = (SKILLS / "tweet-drama-early-shot-script/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("自检只看脚本", text)
        self.assertIn("每个镜头块的字段", text)
        self.assertIn("不是违规", text)
        self.assertIn("validate", text)

    def test_project_config_schema_is_documented_where_the_compiler_reads_it(self):
        schema = (SKILLS / "tweet-drama-early-shot-script/references/project-config.md").read_text(encoding="utf-8")
        skill = (SKILLS / "tweet-drama-early-shot-script/SKILL.md").read_text(encoding="utf-8")
        pipeline = (SKILLS / "tweet-drama-pipeline/SKILL.md").read_text(encoding="utf-8")
        for key in ("jubian_script_id", "delivery", "max_effective_chars_per_shot"):
            self.assertIn(key, schema)
        self.assertIn("远端项目 ID", pipeline)
        self.assertIn("每镜有效字上限", pipeline)
        self.assertIn("正整数", schema)
        self.assertIn("references/project-config.md", skill)
        self.assertIn("references/project-config.md", pipeline)

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

    def test_skill_documents_resolve_resources_from_the_loaded_directory(self):
        """A shipped skill may not tell the model to look in a fixed install root.

        The loader reports one base directory per load, and a packaged install
        moves (app.asar.unpacked, a versioned runtime tree, an npm layout), so a
        hardcoded installation path in prose is stale as soon as the app updates.
        """
        checked = 0
        for path in sorted(SKILLS.rglob("*.md")):
            if "xiaohongshu-reference" in path.parts:
                continue
            with self.subTest(path=path):
                text = path.read_text(encoding="utf-8")
                self.assertIsNone(FIXED_INSTALL_ROOT.search(text),
                                  "skill prose names a fixed installation root")
            checked += 1
        self.assertGreater(checked, 10)

    def test_core_states_the_resource_resolution_rule(self):
        text = (SKILLS / "tweet-drama-core/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("技能资源只按**本次加载返回的技能目录**解析", text)
        self.assertIn("app.asar", text)
        self.assertIn("每次都会给出当前有效的目录", text)


class FixedInstallRootTests(unittest.TestCase):
    """The detector behind the shipped-prose check must reject what it claims to."""

    REJECTED = (
        r"E:\muse-med\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\dsh-drama-skills\skills",
        r"C:\muse\resources\app\skills\tweet-drama-core\scripts",
        r"$DSH_HOME/node_modules/@deepseek-ai/dsh-drama-skills/skills",
        r"E:\aa-manju\skills",
    )

    ACCEPTED = (
        "https://muse.tos-cn-beijing.volces.com/bgm/index.json",
        "python -B scripts/pipeline_state.py <项目目录> sync",
        "DSH_HOME/cache/models",
    )

    def test_detector_matches_every_fixed_root_spelling(self):
        for sample in self.REJECTED:
            with self.subTest(sample=sample):
                self.assertIsNotNone(FIXED_INSTALL_ROOT.search(sample))

    def test_detector_leaves_portable_paths_alone(self):
        for sample in self.ACCEPTED:
            with self.subTest(sample=sample):
                self.assertIsNone(FIXED_INSTALL_ROOT.search(sample))


if __name__ == "__main__":
    unittest.main()
