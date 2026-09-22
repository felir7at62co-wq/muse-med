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

    def test_keys_resolve_dsh_home_without_repository_markers(self):
        module = load("tweet-drama-key-manager", "check_keys.py")
        with tempfile.TemporaryDirectory(dir=PACKAGE / "tests") as root:
            path = Path(root) / "secrets/pipeline.env"
            path.parent.mkdir()
            path.write_text("JUBIANAI_ADMIN_TOKEN=fixture-only-not-a-real-token\n", encoding="utf-8")
            output = io.StringIO()
            with patch.dict(os.environ, {"DSH_HOME": root, "DSH_PIPELINE_ENV": ""}), contextlib.redirect_stdout(output):
                try:
                    result = module.main()
                except SystemExit as exc:
                    result = str(exc)
            self.assertEqual(result, 0)
            self.assertIn(str(path), output.getvalue())
            self.assertNotIn("fixture-only-not-a-real-token", output.getvalue())

    def test_explicit_key_path_overrides_dsh_home(self):
        module = load("tweet-drama-key-manager", "check_keys.py")
        with tempfile.TemporaryDirectory(dir=PACKAGE / "tests") as root:
            path = Path(root) / "custom.env"
            path.write_text("JUBIANAI_ADMIN_TOKEN=fixture-only\n", encoding="utf-8")
            with patch.dict(os.environ, {"DSH_HOME": root, "DSH_PIPELINE_ENV": str(path)}), contextlib.redirect_stdout(io.StringIO()):
                try:
                    result = module.main()
                except SystemExit as exc:
                    result = str(exc)
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
