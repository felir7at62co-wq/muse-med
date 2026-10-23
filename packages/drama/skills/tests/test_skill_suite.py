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
    "anime-3d-assets",
    "character-reference-library",
    "jubian-snatch",
    "shot-script-creator-16-9-3d", "shot-script-creator-9-16",
    "tweet-drama-asset-vision-check",
    "tweet-drama-background-render", "tweet-drama-core", "tweet-drama-delivery",
    "tweet-drama-draft-build", "tweet-drama-key-manager",
    "tweet-drama-project-bible", "tweet-drama-project-inspect", "tweet-drama-script-convert",
    "tweet-drama-script-split", "tweet-drama-shot-asset-match",
    "tweet-drama-voice-continuity",
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
            core = root / "skills/tweet-drama-core/SKILL.md"
            self.assertTrue(core.is_file())
            core.write_text(core.read_text(encoding="utf-8") + "\n取得本次即时批准\npending 表示可交付\n", encoding="utf-8")
            errors = validate_skill_package(root)
            self.assertTrue(any("取得本次即时批准" in error for error in errors))
            self.assertTrue(any("pending 表示可交付" in error for error in errors))

    def test_core_command_uses_loaded_skill_directory(self):
        core = (SKILLS / "tweet-drama-core/SKILL.md").read_text(encoding="utf-8")
        self.assertNotIn("<DSH_HOME>/skills/", core)
        self.assertIn("python -B scripts/pipeline_state.py", core)

    def test_bgm_guidance_uses_scoped_feedback_and_advisory_music_choices(self):
        render = (SKILLS / "tweet-drama-background-render/SKILL.md").read_text(encoding="utf-8")
        for required in ("先 `drama_project action=read`", "project_bible.bgm_feedback", "本项目相近语境",
                         "按正文情绪分段选曲", "对白密度", "配器", "切点", "valence/arousal",
                         "可以只用一首，也可以不额外添加 BGM", "policy_findings", "不要求提示清零",
                         "实际可播放 A/B 试听", "集中一次请求反馈", "曲目许可与分析模型许可分别核实",
                         "仅限非商业用途", "Agent 自己的偏好不落成用户反馈"):
            self.assertIn(required, render)
        for obsolete in ("一集的 BGM 必须多于一首", "每集至少 2 首", "必须照 `fix` 改完再交付"):
            self.assertNotIn(obsolete, render)

    def test_project_bible_records_only_explicit_append_only_bgm_feedback(self):
        bible = (SKILLS / "tweet-drama-project-bible/SKILL.md").read_text(encoding="utf-8")
        for required in ("project_bible.bgm_feedback", "context_tags", "全局曲目黑名单", "明确改口",
                         "feedback_id", "recorded_at", "时间来自该次明确用户反馈", "不伪造写入",
                         "Agent 自己的选曲判断", "已有 ID 不能改写", "不授权重做视频"):
            self.assertIn(required, bible)

    def test_embedded_subtitles_are_reviewed_without_claiming_editability(self):
        render = (SKILLS / "tweet-drama-background-render/SKILL.md").read_text(encoding="utf-8")
        draft = (SKILLS / "tweet-drama-draft-build/SKILL.md").read_text(encoding="utf-8")
        for required in ("video_ocr", "video_inspect", "subtitle_plan", "retain_embedded", "source_sha256",
                         "普通识别疑点只提示", "不能宣称整集字幕均可编辑"):
            self.assertIn(required, render)
        for required in ("resolved_srt", "subtitle_overlay_report", "不可编辑", "不自动付费去字"):
            self.assertIn(required, draft)
        for source in (render, draft):
            self.assertIn("stretch_to_window", source)
            self.assertIn("省略", source)

    def test_character_reference_generation_distinguishes_asset_layout_and_unique_candidate_name(self):
        skill = (SKILLS / "character-reference-library/SKILL.md").read_text(encoding="utf-8")
        for required in (
            "先只读核对项目内已有资产名",
            "项目内唯一的名称",
            "不为规避未知结果而改名重投",
            "先区分人物设定板与成片镜头",
            "设定板按明确的角色资产规格",
            "不能把成片竖屏自动套给设定板",
            "不能沿用上一项目比例",
            "可经实时目录核价后选用角色设定板方案",
            "若返回 `candidate_limit_reached` 且已看的前三张都不合适",
            "至多再检索一次",
            "不要只凭前三张就宣称全库没有合适素材",
            "先把其现行主图作为同一人物的身份锚点",
            "不因职业、服装和风格相符就认作同一人",
            "若无法实际看到主图，说明身份一致性尚未核实",
            "明显换脸即判为不合格候选",
            "不因缺少分类就要求用户先登记",
            "素材授权仍要求正式登记 `role_class`",
            "依据剧本能明确判断时",
        ):
            self.assertIn(required, skill)

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
