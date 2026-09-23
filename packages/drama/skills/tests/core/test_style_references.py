"""Local reference evidence checks; no network or paid tools."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

from PIL import Image

SCRIPTS = Path(__file__).resolve().parents[2] / "skills/tweet-drama-core/scripts"
sys.path.insert(0, str(SCRIPTS))


class StyleReferencesTests(unittest.TestCase):
    def test_local_import_review_and_changed_image(self):
        spec = importlib.util.find_spec("style_references")
        self.assertIsNotNone(spec, "local reference import/check entry is required")
        import style_references as refs
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "input.png"
            Image.new("RGB", (16, 16), "red").save(source)
            project = root / "project"
            refs.import_references(project, "hero", "主角", "lead", [source])
            with self.assertRaises(ValueError):
                refs.check_references(project, "hero")
            path = project / "asset_style_references.json"
            data = json.loads(path.read_text(encoding="utf-8"))
            role = data["roles"]["hero"]
            role["style_reference_status"] = "approved"
            with self.assertRaises(ValueError):
                refs.validate_role(project, role)
            role["review_reason"] = "User confirmed selected outfit in current conversation message 7"
            candidate = role["candidates"][0]
            candidate.update(review_status="approved", review_reason="Outfit matches the script", extracted_visual_elements={"use": "red fabric", "exclude": "identity"})
            path.write_text(json.dumps(data), encoding="utf-8")
            refs.check_references(project, "hero")
            archived = candidate["local_image_paths"][0]
            for bad_path in ("../input.png", str(source.resolve())):
                candidate["local_image_paths"] = [bad_path]
                with self.assertRaises(ValueError):
                    refs.validate_role(project, role)
            candidate["local_image_paths"] = [archived]
            refs.import_references(project, "other", "配角", "support", [source])
            self.assertIn("hero", json.loads(path.read_text(encoding="utf-8"))["roles"])
            Image.new("RGB", (16, 16), "blue").save(project / candidate["local_image_paths"][0])
            with self.assertRaises(ValueError):
                refs.check_references(project, "hero")
            role["candidates"] = []
            with self.assertRaises(ValueError):
                refs.validate_role(project, role)

    def test_missing_or_invalid_images_never_create_approval(self):
        spec = importlib.util.find_spec("style_references")
        self.assertIsNotNone(spec, "local reference import/check entry is required")
        import style_references as refs
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp)
            for paths in ([], [project / "missing.png"]):
                with self.assertRaises(ValueError):
                    refs.import_references(project, "hero", "主角", "lead", paths)
            bad = project / "bad.png"
            bad.write_text("not an image", encoding="utf-8")
            with self.assertRaises(ValueError):
                refs.import_references(project, "hero", "主角", "lead", [bad])
            self.assertFalse((project / "asset_style_references.json").exists())

    def test_workflow_uses_local_review_before_paid_generation(self):
        skills = SCRIPTS.parents[1]
        extract = (skills / "tweet-drama-asset-extract/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("默认使用用户提供的本地图片", extract)
        self.assertIn("style_references.py <项目目录> <role_id> check", extract)
        self.assertIn("用户提供图片本身不等于批准选用", extract)
        self.assertNotIn("必须调用独立的 `xiaohongshu-reference`", extract)
        optional = (skills / "xiaohongshu-reference/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("未明确提供 endpoint 时暂停", optional)
        self.assertNotIn("2. 运行 `scripts/start_xiaohongshu_mcp.ps1`", optional)


if __name__ == "__main__":
    unittest.main()
