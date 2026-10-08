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
    def test_library_pair_preserves_asset_provenance_and_originals(self):
        import style_references as refs
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            library = root / "library"
            index = library / "index"
            index.mkdir(parents=True)
            for name, rows in {
                "assets.jsonl": [
                    {"asset_id": 11, "asset_type_label": "character", "asset_name": "村民",
                     "style_label": "realistic"},
                    {"asset_id": 12, "asset_type_label": "character", "asset_name": "西装",
                     "style_label": "realistic"},
                ],
                "face-manifest.jsonl": [
                    {"asset_id": 11, "status": "ok", "file": "faces/11/11_f0.png",
                     "label_parts": {"face": {"gender": "男", "age": 30}}},
                ],
                "fullbody-manifest.jsonl": [
                    {"asset_id": 12, "status": "ok", "file": "fullbody/12/12_body.png"},
                ],
            }.items():
                (index / name).write_text(
                    "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
                    encoding="utf-8",
                )
            face = library / "faces/11/11_f0.png"
            body = library / "fullbody/12/12_body.png"
            for path, color in ((face, "red"), (body, "blue")):
                path.parent.mkdir(parents=True)
                Image.new("RGB", (16, 16), color).save(path)
            before = (face.read_bytes(), body.read_bytes())
            project = root / "project"
            refs.import_library_pair(project, "hero", "主角", "lead", library, 11, 12)
            data_path = project / "asset_style_references.json"
            data = json.loads(data_path.read_text(encoding="utf-8"))
            role = data["roles"]["hero"]
            self.assertEqual([c["library_asset_id"] for c in role["candidates"]], [11, 12])
            self.assertEqual([c["library_kind"] for c in role["candidates"]], ["face", "body"])
            self.assertEqual(role["review_authority"], "user_confirmation")
            with self.assertRaises(ValueError):
                refs.check_references(project, "hero")
            role.update(style_reference_status="approved",
                        review_reason="User selected face 11 and outfit 12 in this conversation")
            for candidate in role["candidates"]:
                candidate.update(review_status="approved", review_reason="Matches the role",
                                 extracted_visual_elements={"use": candidate["library_kind"]})
            data_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            refs.check_references(project, "hero")
            self.assertEqual((face.read_bytes(), body.read_bytes()), before)
            role["candidates"][0]["library_asset_id"] = 99
            with self.assertRaises(ValueError):
                refs.validate_role(project, role)

    def test_online_reference_requires_source_rights_and_agent_review(self):
        import style_references as refs
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "online.png"
            Image.new("RGB", (16, 16), "red").save(source)
            project = root / "project"
            source_page = "https://example.org/photos/red-dress"
            image_url = "https://example.org/media/red-dress.png"
            license_page = "https://example.org/licenses/reference-use"
            refs.import_online_reference(
                project, "hero", "主角", "lead", source,
                source_page, image_url, "Commercial reference permitted", license_page,
                "License permits commercial image-generation reference and provider upload",
            )
            path = project / "asset_style_references.json"
            data = json.loads(path.read_text(encoding="utf-8"))
            role = data["roles"]["hero"]
            candidate = role["candidates"][0]
            self.assertEqual(candidate["origin"], "online")
            self.assertEqual(candidate["source_url"], source_page)
            self.assertEqual(candidate["image_url"], image_url)
            self.assertEqual(candidate["license_url"], license_page)
            self.assertEqual(role["review_authority"], "agent_review")
            with self.assertRaises(ValueError):
                refs.check_references(project, "hero")

            role.update(style_reference_status="approved", review_reason="Agent checked source, rights, and outfit against the script")
            candidate.update(
                review_status="approved", review_reason="Red dress matches the character's party scene",
                extracted_visual_elements={"use": "red satin silhouette", "exclude": "model identity and brand"},
            )
            refs.validate_role(project, role)
            role["review_authority"] = "user_confirmation"
            with self.assertRaises(ValueError):
                refs.validate_role(project, role)
            role["review_authority"] = "agent_review"
            for key in ("source_url", "image_url", "license_name", "license_url", "usage_rights_reason"):
                value = candidate[key]
                candidate[key] = ""
                with self.assertRaises(ValueError, msg=key):
                    refs.validate_role(project, role)
                candidate[key] = value
            candidate["license_url"] = "http://example.org/licenses/reference-use"
            with self.assertRaises(ValueError):
                refs.validate_role(project, role)
            candidate["license_url"] = license_page
            path.write_text(json.dumps(data), encoding="utf-8")
            refs.check_references(project, "hero")
            Image.new("RGB", (16, 16), "blue").save(project / candidate["local_image_paths"][0])
            with self.assertRaises(ValueError):
                refs.check_references(project, "hero")

    def test_online_import_rejects_invalid_evidence_and_append_resets_review(self):
        import style_references as refs
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "online.png"
            Image.new("RGB", (16, 16), "red").save(source)
            project = root / "project"
            for source_page in ("", "http://example.org/photo", "https://example.org/photo.jpg"):
                with self.assertRaises(ValueError):
                    refs.import_online_reference(
                        project, "hero", "主角", "lead", source,
                        source_page, "https://example.org/photo.png", "CC BY 4.0", "https://example.org/license",
                        "Commercial generation reference and upload allowed",
                    )
            with self.assertRaises(ValueError):
                refs.import_online_reference(
                    project, "hero", "主角", "lead", source,
                    "https://example.org/photo", "https://example.org/photo.png",
                    "CC BY 4.0", "https://example.org/license.png",
                    "Commercial generation reference and upload allowed",
                )
            self.assertFalse((project / "asset_style_references.json").exists())
            refs.import_online_reference(
                project, "hero", "主角", "lead", source,
                "https://example.org/photo", "https://example.org/photo.png", "CC BY 4.0", "https://example.org/license",
                "Commercial generation reference and upload allowed",
            )
            another = root / "another.png"
            Image.new("RGB", (16, 16), "blue").save(another)
            refs.import_online_reference(
                project, "hero", "主角", "lead", another,
                "https://example.org/another", "https://example.org/another.png", "CC BY 4.0", "https://example.org/license",
                "Commercial generation reference and upload allowed", append=True,
            )
            role = json.loads((project / "asset_style_references.json").read_text(encoding="utf-8"))["roles"]["hero"]
            self.assertEqual(len(role["candidates"]), 2)
            self.assertEqual(role["style_reference_status"], "pending_review")
            self.assertEqual(role["review_reason"], "")
            role["candidates"] = ["bad candidate"]
            data = json.loads((project / "asset_style_references.json").read_text(encoding="utf-8"))
            data["roles"]["hero"] = role
            (project / "asset_style_references.json").write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(ValueError):
                refs.import_online_reference(
                    project, "hero", "主角", "lead", another,
                    "https://example.org/another", "https://example.org/another.png",
                    "CC BY 4.0", "https://example.org/license",
                    "Commercial generation reference and upload allowed", append=True,
                )

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
            role["review_authority"] = "agent_review"
            with self.assertRaises(ValueError):
                refs.validate_role(project, role)
            role.pop("review_authority")
            refs.validate_role(project, role)
            role["review_authority"] = "user_confirmation"
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

    def test_workflow_reviews_local_or_online_images_before_paid_generation(self):
        skills = SCRIPTS.parents[1]
        core = (skills / "tweet-drama-core/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("import-online", core)
        self.assertNotIn("缺图就询问并暂停", core)
        extract = (skills / "tweet-drama-asset-extract/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("web_search", extract)
        self.assertIn("web_fetch", extract)
        self.assertIn("read_image", extract)
        self.assertIn("import-online", extract)
        self.assertIn("agent_review", extract)
        self.assertIn("style_references.py <项目目录> <role_id> check", extract)
        self.assertIn("用户提供图片本身不等于批准选用", extract)
        self.assertNotIn("必须调用独立的 `xiaohongshu-reference`", extract)
        pipeline = (skills / "tweet-drama-pipeline/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("网上参考图只用于生成", pipeline)
        vision = (skills / "tweet-drama-asset-vision-check/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("同一候选", vision)
        self.assertIn("新候选", vision)
        optional = (skills / "xiaohongshu-reference/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("未明确提供 endpoint 时暂停", optional)
        self.assertNotIn("默认短剧流程使用用户本地参考图", optional)
        self.assertNotIn("2. 运行 `scripts/start_xiaohongshu_mcp.ps1`", optional)


if __name__ == "__main__":
    unittest.main()
