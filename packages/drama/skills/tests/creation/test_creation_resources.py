"""Offline creation-skill migration checks; no project or remote API access."""
from pathlib import Path
import json
import re
import unittest

PACK = Path(__file__).resolve().parents[2]
SKILLS = PACK / "skills"
NAMES = (
    "shot-script-creator-9-16", "shot-script-creator-16-9-3d", "tweet-drama-pipeline",
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
    @staticmethod
    def _asset_prompt_templates():
        text = (SKILLS / "tweet-drama-asset-extract/SKILL.md").read_text(encoding="utf-8")
        matches = re.findall(
            r"已确认(真人|动画)风格的角色 prompt 使用以下模板.*?```text\n(.*?)\n```",
            text,
            re.DOTALL,
        )
        return text, dict(matches)

    def test_central_reuse_remains_a_preview_without_agent_issued_approval(self):
        for name in ("tweet-drama-shot-asset-match", "tweet-drama-pipeline"):
            text = (SKILLS / name / "SKILL.md").read_text(encoding="utf-8")
            for requirement in ("reuse_preview", "plan_path", "apply_allowed=false", "不自动绑定", "approved"):
                self.assertIn(requirement, text)
        text = (SKILLS / "tweet-drama-core/references/match-preview.md").read_text(encoding="utf-8")
        for requirement in ("episode_id", "awaiting_confirmation", "already_bound", "不接受 approved", "停止后续预检"):
            self.assertIn(requirement, text)

    def test_user_authorized_handoff_uses_existing_tools_without_native_confirmation(self):
        for name in ("tweet-drama-shot-asset-match", "tweet-drama-pipeline"):
            text = (SKILLS / name / "SKILL.md").read_text(encoding="utf-8")
            self.assertIn("匹配预览 → 复用建议 → 用户确认 → 模型调用原有 jubian_storyboard.select_assets", text)
            self.assertIn("apply_allowed=false 只表示预览本身不授予写入权限", text)
            self.assertNotIn("drama_assets_confirmation", text)
        text = (SKILLS / "tweet-drama-core/references/match-preview.md").read_text(encoding="utf-8")
        for value in ("shots[].selections", "idempotency_key", "未", "audio_preview → audio_apply", "不要把音频 asset_id 混入图片 selections"):
            self.assertIn(value, text)

    def test_matching_preview_reuses_workflow_and_preserves_approval_boundaries(self):
        for name in ("tweet-drama-asset-extract", "tweet-drama-shot-asset-match",
                     "tweet-drama-voice-continuity", "tweet-drama-pipeline"):
            text = (SKILLS / name / "SKILL.md").read_text(encoding="utf-8")
            for requirement in ("match_preview", "reuse_ready", "needs_review", "blocked"):
                self.assertIn(requirement, text)
            if name == "tweet-drama-voice-continuity":
                for requirement in ("实际听音核对", "首个样本的说话人和区间核对后按用户已有制作授权采用",
                                    "新候选不得覆盖既有默认", "替换须由用户或其授权组员明确认可"):
                    self.assertIn(requirement, text)
            else:
                self.assertIn("人工确认", text)
            self.assertIn("references/match-preview.md", text)
        contract = "skills/tweet-drama-core/references/match-preview.md"
        manifest = json.loads((PACK / "package.json").read_text(encoding="utf-8"))
        self.assertIn(contract, manifest["files"])
        text = (PACK / contract).read_text(encoding="utf-8")
        for requirement in ("source_sha256", "source_line", "current_project", "不自动生成", "missing"):
            self.assertIn(requirement, text)


    def test_voice_references_use_library_assets_and_reviewed_original_card_changes(self):
        text = (SKILLS / "tweet-drama-voice-continuity/SKILL.md").read_text(encoding="utf-8")
        for requirement in ("音频类别", "reference_audio_asset_id", "reference_audio_sha256",
                            "reference_audio_duration_seconds", "reference_audio=null",
                            "不自动替换", "audio_preview", "audio_apply", "最终有序",
                            "仍被引用", "删除预览", "expected_fingerprint",
                            "audio/voice-references/manifest.json", "ask_user_question",
                            "同一 fingerprint/key"):
            self.assertIn(requirement, text)
        self.assertNotIn("原卡 `save`", text)

    def test_project_bible_startup_reuses_answers_and_live_catalogue_choices(self):
        path = SKILLS / "tweet-drama-project-bible/SKILL.md"
        self.assertTrue(path.is_file())
        text = path.read_text(encoding="utf-8")
        for requirement in ("drama_project", "ask_user_question", "一次", "jubian_catalog", "SD2.0", "SD2.5",
                            "generation", "delivery", "episode_plan", "preview", "expected_revision", "edit_preview", "edit_apply",
                            "character_id", "voice_profile", "不能保证", "不作为写作"):
            self.assertIn(requirement, text)

    def test_project_bible_offers_visual_styles_and_preserves_custom_answers(self):
        text = (SKILLS / "tweet-drama-project-bible/SKILL.md").read_text(encoding="utf-8")
        example = re.search(r"```json\n(.*?)\n```", text, re.DOTALL)
        self.assertIsNotNone(example, "Startup needs a runnable ask_user_question example")
        question = json.loads(example.group(1))["questions"][0]
        self.assertEqual(question["id"], "project-style")
        self.assertEqual([item["label"] for item in question["options"]],
                         ["仿真人", "3D", "其他（自行输入）"])
        self.assertIn("自定义答案", question["question"])
        self.assertIn("custom", text)
        self.assertIn("project_bible.style", text)
        self.assertIn("不能把“其他（自行输入）”", text)

    def test_current_creation_skills_are_packaged(self):
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

    def test_asset_prompts_follow_confirmed_animation_style_without_live_action_constraints(self):
        text, templates = self._asset_prompt_templates()
        self.assertEqual(set(templates), {"真人", "动画"})
        values = {
            "identity": "守护云城的年轻女侠",
            "appearance": "二十二岁，东方脸型，丹凤眼，身形修长",
            "costume": "青色交领长袍，银色发冠，黑色长靴",
            "state": "非孕期，警觉",
        }
        for style in ("国漫水墨二维动画", "东方幻想3D动画"):
            with self.subTest(style=style):
                prompt = templates["动画"].format(project_style=style, **values)
                self.assertTrue(prompt.startswith(f"项目风格：{style}。"))
                for value in values.values():
                    self.assertIn(value, prompt)
                for live_only in ("真人选角审美", "禁止动漫脸", "真人角色设定板", "真实空间", "照片级真人"):
                    self.assertNotIn(live_only, prompt)
        self.assertIn("不得从 short-drama 预设名", text)
        self.assertIn("参考图服从已确认的项目风格", text)

    def test_asset_prompts_keep_established_live_action_board_and_character_details(self):
        _text, templates = self._asset_prompt_templates()
        values = {
            "identity": "豪门集团继承人",
            "appearance": "三十岁，东方脸型，眉眼锐利，身形挺拔",
            "costume": "深蓝双排扣西装，白衬衫，黑色皮鞋",
            "state": "非孕期，克制",
        }
        prompt = templates["真人"].format(project_style="现代都市仿真人短剧", **values)
        self.assertTrue(prompt.startswith("项目风格：现代都市仿真人短剧。"))
        for value in values.values():
            self.assertIn(value, prompt)
        for established_rule in ("单张16:9真人角色设定板", "纯白背景", "正面半身特写", "无头正面、侧面、背面三视图"):
            self.assertIn(established_rule, prompt)

    def test_asset_prompts_wait_for_unknown_style_instead_of_forcing_a_branch(self):
        text, _templates = self._asset_prompt_templates()
        for requirement in (
            "不填写可提交的最终 `prompt`",
            "不发起付费生成",
            "风格仍未确认时两个模板都不得使用",
            "不得从 short-drama 预设名、本技能旧称、剧本题材、参考图是真人照片、模型名称或历史资产猜测项目风格",
        ):
            self.assertIn(requirement, text)
        self.assertIn("只提取并保留角色身份、年龄、五官、体型、服装、发型、配饰、状态、场景和道具事实", text)

    def test_asset_review_uses_the_confirmed_style_instead_of_unconditional_live_action(self):
        text = (SKILLS / "tweet-drama-asset-vision-check/SKILL.md").read_text(encoding="utf-8")
        self.assertNotIn("- 通用：真人感、", text)
        for requirement in (
            "与已确认项目风格一致",
            "不得因缺少真人感判失败",
            "风格缺失、宽泛或冲突时保持待确认",
            "不得跨到另一风格分支",
            "角色身份、外貌、服装与状态",
        ):
            self.assertIn(requirement, text)

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
