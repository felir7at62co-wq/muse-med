"""Offline migration checks; all generated files stay in this package."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

PACKAGE = Path(__file__).resolve().parents[2]
SKILLS = Path(os.environ.get("DSH_HELPER_TEST_SKILLS", PACKAGE / "skills"))


def load(skill, filename):
    path = SKILLS / skill / "scripts" / filename
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class SplitWorkScopeTests(unittest.TestCase):
    def setUp(self):
        self.module = load("tweet-drama-script-split", "script_processor.py")
        self.processor = self.module.ScriptProcessor()
        self.temp = tempfile.TemporaryDirectory(dir=PACKAGE / "tests")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / "project"
        self.episodes = self.project / "episodes"
        self.manifest_path = self.episodes / "manifest.json"

    def analysis(self, *numbers):
        source = self.root / "source.txt"
        source.write_text("\n".join(
            f"第{number}集\n旁白：这是第{number}集的新正文。" for number in numbers
        ), encoding="utf-8")
        return self.processor.analyze(str(source))

    def seed(self, numbers, **metadata):
        self.episodes.mkdir(parents=True, exist_ok=True)
        rows = {}
        for number in numbers:
            content = f"旁白：这是第{number}集的协作者正文。"
            (self.episodes / f"{number}.txt").write_text(content, encoding="utf-8")
            rows[number] = {"sha256": self.module.content_sha256(content),
                            "char_count": len(content), "owner": f"writer-{number}"}
        manifest = {"version": 1, "episodes": rows, **metadata}
        self.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return manifest

    def snapshot(self):
        return {str(path.relative_to(self.project)): path.read_bytes()
                for path in self.project.rglob("*") if path.is_file()}

    def read_manifest(self):
        return json.loads(self.manifest_path.read_text(encoding="utf-8"))

    def test_assigned_range_140_through_219_keeps_whole_story_total_300(self):
        ids = [str(number) for number in range(140, 220)]
        result = self.processor.save(
            str(self.project), self.analysis(*ids), work_scope={"episode_ids": ids},
            expected_episode_count=300,
        )
        self.assertTrue(result.success, result.error)
        self.assertEqual(result.episode_count, 80)
        manifest = self.read_manifest()
        self.assertEqual(manifest["expected_episode_count"], 300)
        self.assertEqual(manifest["work_scope"], {"episode_ids": ids})
        self.assertEqual(list(manifest["episodes"]), ids)
        self.assertEqual({path.stem for path in self.episodes.glob("*.txt")}, set(ids))

    def test_scoped_save_preserves_collaborator_rows_files_and_unknown_metadata(self):
        previous = self.seed(["01", "140", "220", "300"], expected_episode_count=300,
                             project_note={"editors": ["A", "B"]})
        (self.episodes / "300.txt").unlink()
        (self.episodes / "collaborator-notes.txt").write_text("keep these notes", encoding="utf-8")
        before = self.snapshot()
        result = self.processor.save(str(self.project), self.analysis(140, 141),
                                     work_scope={"episode_ids": ["140", "141"]})
        self.assertTrue(result.success, result.error)
        manifest = self.read_manifest()
        for number in ("01", "220", "300"):
            self.assertEqual(manifest["episodes"][number], previous["episodes"][number])
        for name in ("episodes/01.txt", "episodes/220.txt", "episodes/collaborator-notes.txt"):
            self.assertEqual(self.snapshot()[name], before[name])
        self.assertFalse((self.episodes / "300.txt").exists())
        self.assertNotEqual(manifest["episodes"]["140"]["sha256"], previous["episodes"]["140"]["sha256"])
        self.assertEqual(manifest["project_note"], previous["project_note"])
        self.assertEqual(manifest["expected_episode_count"], 300)

    def test_omitted_and_none_scope_count_preserve_existing_assignment(self):
        previous = self.seed(["140", "220"], work_scope={"episode_ids": ["140"]},
                             expected_episode_count=300)
        collaborator = (self.episodes / "220.txt").read_bytes()
        for kwargs in ({}, {"work_scope": None, "expected_episode_count": None}):
            with self.subTest(kwargs=kwargs):
                result = self.processor.save(str(self.project), self.analysis(140), **kwargs)
                self.assertTrue(result.success, result.error)
                manifest = self.read_manifest()
                self.assertEqual(manifest["work_scope"], previous["work_scope"])
                self.assertEqual(manifest["expected_episode_count"], 300)
                self.assertEqual(manifest["episodes"]["220"], previous["episodes"]["220"])
                self.assertEqual((self.episodes / "220.txt").read_bytes(), collaborator)
        before = self.snapshot()
        result = self.processor.save(str(self.project), self.analysis(219))
        self.assertFalse(result.success)
        self.assertIn("完全一致", result.error)
        self.assertEqual(self.snapshot(), before)

    def test_explicit_new_assignment_preserves_previously_assigned_episode(self):
        previous = self.seed(["140"], work_scope={"episode_ids": ["140"]}, expected_episode_count=300)
        content = (self.episodes / "140.txt").read_bytes()
        result = self.processor.save(str(self.project), self.analysis(219),
                                     work_scope={"episode_ids": ["219"]}, expected_episode_count=400)
        self.assertTrue(result.success, result.error)
        manifest = self.read_manifest()
        self.assertEqual(manifest["work_scope"], {"episode_ids": ["219"]})
        self.assertEqual(manifest["expected_episode_count"], 400)
        self.assertEqual(manifest["episodes"]["140"], previous["episodes"]["140"])
        self.assertEqual((self.episodes / "140.txt").read_bytes(), content)

    def test_noncontiguous_explicit_assignment_does_not_expand_to_a_range(self):
        self.seed(["02"])
        before = (self.episodes / "02.txt").read_bytes()
        ids = ["01", "140", "219"]
        result = self.processor.save(str(self.project), self.analysis(*ids),
                                     work_scope={"episode_ids": ids})
        self.assertTrue(result.success, result.error)
        self.assertEqual(self.read_manifest()["work_scope"], {"episode_ids": ids})
        self.assertEqual({path.stem for path in self.episodes.glob("*.txt")}, {"01", "02", "140", "219"})
        self.assertEqual((self.episodes / "02.txt").read_bytes(), before)

    def test_invalid_or_mismatched_scope_fails_without_changing_files_or_analysis(self):
        self.seed(["01", "140", "220"], expected_episode_count=300)
        invalid_scopes = [[], {}, {"episode_ids": []}, {"episode_ids": "140"},
                          {"episode_ids": [140]}, {"episode_ids": ["0140"]},
                          {"episode_ids": ["00"]}, {"episode_ids": ["10000"]},
                          {"episode_ids": ["140", "140"]}, {"episode_ids": ["141", "140"]},
                          {"episode_ids": ["301"]}, {"episode_ids": ["140", "141"]},
                          {"episode_ids": ["141"]}, {"episode_ids": ["140"], "start": 140}]
        for scope in invalid_scopes:
            with self.subTest(scope=scope):
                analysis = self.analysis(140)
                analysis.episodes[0].cleaned_content += "  "
                content = analysis.episodes[0].cleaned_content
                before = self.snapshot()
                result = self.processor.save(str(self.project), analysis, work_scope=scope)
                self.assertFalse(result.success)
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(analysis.episodes[0].cleaned_content, content)

    def test_invalid_total_fails_before_creating_output(self):
        for total in (True, 0, -1, 10000, "300", 139):
            with self.subTest(total=total):
                result = self.processor.save(str(self.project), self.analysis(140),
                                             work_scope={"episode_ids": ["140"]},
                                             expected_episode_count=total)
                self.assertFalse(result.success)
                self.assertFalse(self.project.exists())

    def test_malformed_existing_manifest_cannot_be_silently_replaced(self):
        row = {"sha256": "a" * 64, "char_count": 1}
        valid = {"version": 1, "episodes": {"140": row}}
        invalid = [[], {**valid, "version": True}, {**valid, "version": 2},
                   {**valid, "episodes": {}}, {**valid, "episodes": {"0140": row}},
                   {**valid, "episodes": {"140": []}},
                   {**valid, "episodes": {"140": {"sha256": "invalid"}}},
                   {**valid, "episodes": {"140": {**row, "char_count": True}}},
                   {**valid, "expected_episode_count": None},
                   {**valid, "expected_episode_count": 100},
                   {**valid, "work_scope": None},
                   {**valid, "work_scope": {"episode_ids": ["140", "140"]}}]
        self.seed(["140", "220"])
        payloads = [json.dumps(value) for value in invalid] + [
            "invalid json",
            '{"version": 1, "version": 1, "episodes": {"140": {"sha256": "' + "a" * 64 + '"}}}',
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                self.manifest_path.write_text(payload, encoding="utf-8")
                before = self.snapshot()
                result = self.processor.save(str(self.project), self.analysis(140),
                                             work_scope={"episode_ids": ["140"]}, expected_episode_count=300)
                self.assertFalse(result.success)
                self.assertEqual(self.snapshot(), before)

    def test_legacy_save_preserves_total_and_never_infers_scope(self):
        self.seed(["01", "140", "220"], expected_episode_count=300)
        result = self.processor.save(str(self.project), self.analysis(140, 219))
        self.assertTrue(result.success, result.error)
        manifest = self.read_manifest()
        self.assertEqual(manifest["expected_episode_count"], 300)
        self.assertNotIn("work_scope", manifest)
        self.assertEqual(set(manifest["episodes"]), {"140", "219"})
        self.assertEqual({path.stem for path in self.episodes.glob("*.txt")}, {"140", "219"})


class HelperMigrationTests(unittest.TestCase):
    def test_split_save_does_not_require_old_app_state(self):
        module = load("tweet-drama-script-split", "script_processor.py")
        with tempfile.TemporaryDirectory(dir=PACKAGE / "tests") as root:
            path = Path(root) / "source.txt"
            path.write_text("第1集\n旁白：这是一段必须保留的原始剧本文字。\n第2集\n角色OS：我不会忘记今天的事情。", encoding="utf-8")
            analysis = module.ScriptProcessor().analyze(str(path))
            result = module.ScriptProcessor().save(root, analysis)
            self.assertTrue(result.success, result.error)
            manifest = json.loads(Path(result.manifest_path).read_text(encoding="utf-8"))
            self.assertEqual(set(manifest["episodes"]), {"01", "02"})
            self.assertIn("角色OS", (Path(root) / "episodes/02.txt").read_text(encoding="utf-8"))
            self.assertFalse((Path(root) / "project_state.json").exists())

    def test_keys_resolve_harness_credential_store_without_repository_markers(self):
        module = load("tweet-drama-key-manager", "check_keys.py")
        with tempfile.TemporaryDirectory(dir=PACKAGE / "tests") as root:
            path = Path(root) / ".credentials.yaml"
            path.write_text("version: 1\nrefs:\n  JUBIANAI_ADMIN_TOKEN: fixture-only-not-a-real-token\n", encoding="utf-8")
            output = io.StringIO()
            with patch.dict(os.environ, {"DSH_HOME": root, "DSH_PIPELINE_ENV": ""},
                            clear=False), contextlib.redirect_stdout(output):
                os.environ.pop("JUBIANAI_ADMIN_TOKEN", None)
                os.environ.pop("JUBIAN_TOKEN", None)
                result = module.main()
            self.assertEqual(result, 0)
            self.assertIn(str(path), output.getvalue())
            self.assertNotIn("fixture-only-not-a-real-token", output.getvalue())

    def test_environment_token_outranks_the_credential_store(self):
        module = load("tweet-drama-key-manager", "check_keys.py")
        with tempfile.TemporaryDirectory(dir=PACKAGE / "tests") as root:
            (Path(root) / ".credentials.yaml").write_text(
                "version: 1\nrefs:\n  JUBIANAI_ADMIN_TOKEN: stored-fixture\n", encoding="utf-8")
            output = io.StringIO()
            with patch.dict(os.environ, {"DSH_HOME": root, "DSH_PIPELINE_ENV": "",
                                         "JUBIANAI_ADMIN_TOKEN": "environment-fixture"},
                            clear=False), contextlib.redirect_stdout(output):
                result = module.main()
            self.assertEqual(result, 0)
            self.assertIn("环境变量", output.getvalue())
            self.assertNotIn("stored-fixture", output.getvalue())

    def test_workspace_pipeline_env_still_supplies_the_token(self):
        module = load("tweet-drama-key-manager", "check_keys.py")
        with tempfile.TemporaryDirectory(dir=PACKAGE / "tests") as root:
            workspace = Path(root) / "workshop"
            path = workspace / ".agents/secrets/pipeline.env"
            path.parent.mkdir(parents=True)
            path.write_text("JUBIANAI_ADMIN_TOKEN=fixture-only-not-a-real-token\n", encoding="utf-8")
            output = io.StringIO()
            previous = os.getcwd()
            os.chdir(workspace)
            self.addCleanup(os.chdir, previous)
            try:
                with patch.dict(os.environ, {"DSH_HOME": str(Path(root) / "home"), "DSH_PIPELINE_ENV": ""},
                                clear=False), contextlib.redirect_stdout(output):
                    os.environ.pop("JUBIANAI_ADMIN_TOKEN", None)
                    os.environ.pop("JUBIAN_TOKEN", None)
                    result = module.main()
            finally:
                os.chdir(previous)
            self.assertEqual(result, 0)
            self.assertIn(str(path), output.getvalue())
            self.assertNotIn("fixture-only-not-a-real-token", output.getvalue())

    def test_explicit_key_path_overrides_the_workspace_secret(self):
        module = load("tweet-drama-key-manager", "check_keys.py")
        with tempfile.TemporaryDirectory(dir=PACKAGE / "tests") as root:
            path = Path(root) / "custom.env"
            path.write_text("JUBIANAI_ADMIN_TOKEN=fixture-only\n", encoding="utf-8")
            with patch.dict(os.environ, {"DSH_HOME": root, "DSH_PIPELINE_ENV": str(path)}):
                os.environ.pop("JUBIANAI_ADMIN_TOKEN", None)
                os.environ.pop("JUBIANAI_TOKEN", None)
                with contextlib.redirect_stdout(io.StringIO()):
                    result = module.main()
            self.assertEqual(result, 0)

    def test_xhs_runtime_is_user_owned_and_shared_with_installer(self):
        scripts = SKILLS / "xiaohongshu-reference/scripts"
        installer = (scripts / "install_xiaohongshu_mcp.ps1").read_text(encoding="utf-8")
        starter = (scripts / "start_xiaohongshu_mcp.ps1").read_text(encoding="utf-8")
        for text in (installer, starter):
            self.assertIn("$env:DSH_HOME", text)
            self.assertIn("$env:XIAOHONGSHU_RUNTIME", text)
        self.assertIn("-InstallDir $runtime", starter)
        self.assertIn("python -B $client", starter)

    def test_convert_text_preserves_dialogue(self):
        module = load("tweet-drama-script-convert", "convert_script.py")
        self.assertEqual(module.normalize_text("第1集\r\n旁白：你好。\r\n角色OS：再见。"), "第1集\n旁白：你好。\n角色OS：再见。\n")
        import olefile
        self.assertFalse(olefile.isOleFile(data=b"not-ole"))

    def test_inspect_keeps_creation_acceptance_rules(self):
        text = (SKILLS / "tweet-drama-project-inspect/SKILL.md").read_text(encoding="utf-8")
        for rule in ("至少 2 首", "情绪", "旁白", "OS", "实时目录允许时长", "比例和分辨率"):
            self.assertIn(rule, text)

    def test_xhs_write_tools_rejected_without_network(self):
        module = load("xiaohongshu-reference", "xhs_reference_search.py")
        client = module.XhsMcpClient("http://127.0.0.1:1/mcp")
        with patch.object(client, "_rpc", side_effect=AssertionError("network forbidden")):
            with self.assertRaises(PermissionError):
                client.call_tool("like_feed", {})


if __name__ == "__main__":
    unittest.main()
