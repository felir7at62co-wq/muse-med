"""Local character-library search and pair checks; no provider calls."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / "skills/jubian-asset-library/scripts"
sys.path.insert(0, str(SCRIPTS))
import character_candidates as characters
import search_assets


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


class CharacterLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "library"
        index = self.root / "index"
        write_jsonl(index / "assets.jsonl", [
            {"asset_id": 1, "asset_type_label": "character", "asset_name": "年轻村民",
             "style_label": "realistic", "project_name": "村庄", "usable": True},
            {"asset_id": 2, "asset_type_label": "character", "asset_name": "白色西装造型",
             "style_label": "realistic", "project_name": "都市", "usable": True},
            {"asset_id": 3, "asset_type_label": "character", "asset_name": "安保",
             "style_label": "realistic", "project_name": "都市", "usable": True},
            {"asset_id": 4, "asset_type_label": "character", "asset_name": "女士礼服",
             "style_label": "3d", "project_name": "都市", "usable": True},
            {"asset_id": 5, "asset_type_label": "character", "asset_name": "风衣女主",
             "style_label": "realistic", "project_name": "都市", "usable": True},
            {"asset_id": 6, "asset_type_label": "character", "asset_name": "记者风衣",
             "style_label": "realistic", "project_name": "都市", "usable": True},
            {"asset_id": 7, "asset_type_label": "character", "asset_name": "维修工围裙",
             "style_label": "realistic", "project_name": "都市", "usable": True},
            {"asset_id": 8, "asset_type_label": "character", "asset_name": "维修工工作围裙",
             "style_label": "realistic", "project_name": "都市", "usable": True},
            {"asset_id": 9, "asset_type_label": "character", "asset_name": "维修工围裙待核",
             "style_label": "realistic", "project_name": "都市", "usable": True},
            {"asset_id": 10, "asset_type_label": "character", "asset_name": "记者风衣待核",
             "style_label": "realistic", "project_name": "都市", "usable": True},
            {"asset_id": 11, "asset_type_label": "character", "asset_name": "无痣双胞胎",
             "style_label": "realistic", "project_name": "都市", "usable": True},
            {"asset_id": 12, "asset_type_label": "character", "asset_name": "有痣双胞胎",
             "style_label": "realistic", "project_name": "都市", "usable": True},
        ])
        write_jsonl(index / "tags.jsonl", [
            {"asset_id": 1, "local_path": "E:/old/a1.png",
             "tags": {"gender": "male", "age_group": "young", "tags": ["村民"]}},
            {"asset_id": 3, "tags": {"gender": "male", "tags": ["多人"]}},
            {"asset_id": 5, "tags": {"gender": "female", "age_group": "young"}},
            {"asset_id": 6, "tags": {"gender": "female", "age_group": "young"}},
        ])
        write_jsonl(index / "face-manifest.jsonl", [
            {"asset_id": 1, "status": "ok", "file": "faces/01/1_f0.jpg",
             "label_parts": {"face": {"age": 23, "gender": "男", "identity": "村民"}}},
            {"asset_id": 3, "status": "ok", "file": "faces/03/3_f0.jpg",
             "label_parts": {"face": {"age": 35, "gender": "男"}}},
            {"asset_id": 4, "status": "ok", "file": "faces/04/4_f0.jpg",
             "label_parts": {"face": {"age": 30, "gender": "女"}}},
            {"asset_id": 11, "status": "ok", "file": "faces/11/11_f0.jpg",
             "label_parts": {"face": {"age": 27, "gender": "女", "distinctive": "左眼下无痣"}}},
            {"asset_id": 12, "status": "ok", "file": "faces/12/12_f0.jpg",
             "label_parts": {"face": {"age": 27, "gender": "女", "distinctive": "左眼下有小痣"}}},
        ])
        write_jsonl(index / "fullbody-manifest.jsonl", [
            {"asset_id": 2, "status": "ok", "file": "fullbody/02/2_body.jpg"},
            {"asset_id": 3, "status": "ok", "file": "fullbody/03/3_body.jpg"},
            {"asset_id": 4, "status": "ok", "file": "fullbody/04/4_body.jpg"},
            {"asset_id": 5, "status": "ok", "file": "fullbody/05/5_body.jpg"},
            {"asset_id": 6, "status": "ok", "file": "fullbody/06/6_body.jpg"},
            {"asset_id": 7, "status": "ok", "file": "fullbody/07/7_body.jpg"},
            {"asset_id": 8, "status": "ok", "file": "fullbody/08/8_body.jpg"},
            {"asset_id": 9, "status": "ok", "file": "fullbody/09/9_body.jpg"},
            {"asset_id": 10, "status": "ok", "file": "fullbody/10/10_body.jpg"},
        ])
        write_jsonl(index / "clothing-library.jsonl", [
            {"asset_id": 2, "clothing": {"raw": "白色西装与黑色皮鞋"}},
            {"asset_id": 5, "clothing": {"raw": "红色大衣配米色围巾"}},
            {"asset_id": 6, "clothing": {"raw": "卡其色双排扣风衣配白色衬衫"}},
            {"asset_id": 7, "clothing": {"raw": "灰色衬衫配黑色围裙，棕色皮鞋"}},
            {"asset_id": 8, "clothing": {"raw": "灰色衬衫配深棕色工作围裙，黑色皮鞋"}},
            {"asset_id": 9, "clothing": {"raw": "灰色衬衫配帆布围裙"}},
        ])
        for relative in ("faces/01/1_f0.jpg", "faces/03/3_f0.jpg", "faces/04/4_f0.jpg",
                         "faces/11/11_f0.jpg", "faces/12/12_f0.jpg",
                         "fullbody/02/2_body.jpg", "fullbody/03/3_body.jpg", "fullbody/04/4_body.jpg",
                         "fullbody/05/5_body.jpg", "fullbody/06/6_body.jpg",
                         "fullbody/07/7_body.jpg", "fullbody/08/8_body.jpg", "fullbody/09/9_body.jpg",
                         "fullbody/10/10_body.jpg",
                         "media/a1.png"):
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"fixture")

    def test_search_joins_face_and_clothing_labels_without_stale_paths(self):
        faces = characters.search(self.root, "face", "村民", "realistic", "male")
        self.assertEqual([row["asset_id"] for row in faces], [1])
        bodies = characters.search(self.root, "body", "西装", "realistic")
        self.assertEqual([row["asset_id"] for row in bodies], [2])
        self.assertEqual(characters.search(self.root, "face", "不存在的称谓"), [])
        self.assertEqual(characters.search(self.root, "body", "西装", "3d"), [])

    def test_pair_resolves_two_assets_and_rejects_group_or_style_mismatch(self):
        result = characters.pair(self.root, 1, 2)
        self.assertEqual([result["face"]["asset_id"], result["body"]["asset_id"]], [1, 2])
        self.assertEqual(len(result["ordered_reference_paths"]), 2)
        self.assertEqual(result["identity_status"], "pending_review")
        self.assertEqual([row["asset_id"] for row in characters.search(self.root, "body", include_groups=True)
                          if row["group_image"]], [3])
        for face_id, body_id in ((3, 2), (1, 3), (1, 4)):
            with self.subTest(face_id=face_id, body_id=body_id), self.assertRaises(ValueError):
                characters.pair(self.root, face_id, body_id)

    def test_existing_asset_search_uses_current_media_and_requires_text_match(self):
        self.assertEqual(search_assets.local_media_paths(self.root)[1], str((self.root / "media/a1.png").resolve()))
        score, matched = search_assets.score_row(
            {"asset_name": "年轻村民", "prompt": "", "project_name": "村庄", "usable": True},
            None, ["不存在"], "不存在", "", False,
        )
        self.assertGreater(score, 0)
        self.assertFalse(matched)
        with patch.object(sys, "argv", ["search_assets.py", "--root", str(self.root),
                                        "--q", "村民", "--require-local", "--json"]):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                search_assets.main()
        found = json.loads(output.getvalue())
        self.assertEqual([row["asset_id"] for row in found], [1])
        self.assertEqual(found[0]["local_path"], str((self.root / "media/a1.png").resolve()))

    def test_escaped_manifest_path_is_not_served(self):
        write_jsonl(self.root / "index/face-manifest.jsonl", [
            {"asset_id": 1, "status": "ok", "file": "faces/../media/a1.png"},
        ])
        self.assertEqual(characters.candidates(self.root, "face"), [])

    def test_required_outfit_attributes_reject_query_only_false_positives(self):
        found = characters.search(self.root, "body", "米色风衣", "realistic", "female", "young",
                                  required_items=["米色|卡其色:风衣"])
        self.assertEqual([row["asset_id"] for row in found], [6, 10])
        self.assertEqual(found[0]["match_status"], "qualified")
        self.assertEqual(found[1]["match_status"], "needs_review")
        self.assertIn("卡其色双排扣风衣", found[0]["match_evidence"])
        self.assertEqual(characters.search(self.root, "body", "红色卫衣", "realistic", "female", "young",
                                           required_items=["砖红色|红色:卫衣|连帽衫"]), [])
        with self.assertRaises(ValueError):
            characters.search(self.root, "body", required=["|"])

    def test_outfit_color_is_bound_to_garment_and_missing_color_requires_review(self):
        found = characters.search(self.root, "body", "棕色围裙", "realistic",
                                  required_items=["棕色|褐色:围裙"])
        self.assertEqual([row["asset_id"] for row in found], [8, 9])
        self.assertEqual([row["match_status"] for row in found], ["qualified", "needs_review"])
        self.assertIn("深棕色工作围裙", found[0]["match_evidence"])
        self.assertIn("Color of 围裙 is not established", found[1]["review_reasons"])
        self.assertEqual(characters.search(self.root, "body", "棕色围裙", "realistic",
                                           required_items=["棕色:工作服"]), [])

    def test_missing_description_is_not_a_qualified_match(self):
        found = characters.search(self.root, "body", "记者风衣", "realistic",
                                  required_items=["米色|卡其色:风衣"])
        self.assertEqual(found[0]["match_status"], "qualified")
        self.assertEqual(found[1]["match_status"], "needs_review")
        self.assertEqual(found[1]["asset_id"], 10)
        self.assertIn("Clothing description is missing", found[1]["review_reasons"])

    def test_cli_reports_no_qualified_candidates_without_relaxing_constraints(self):
        with patch.object(sys, "argv", ["character_candidates.py", "--root", str(self.root),
                                        "--kind", "body", "--q", "砖红色连帽卫衣",
                                        "--require-item", "砖红色:卫衣"]):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                characters.main()
        result = json.loads(output.getvalue())
        self.assertEqual(result["qualified_count"], 0)
        self.assertEqual(result["result_status"], "no_qualified_candidates")
        self.assertEqual(result["candidates"], [])

    def test_outfit_color_without_color_suffix_is_recognized(self):
        self.assertEqual(characters._item_match("藏青针织衫配浅灰长裤", "藏青:针织衫"),
                         ("qualified", "藏青针织衫"))
        self.assertEqual(characters._item_match("墨绿夹克配白色T恤", "墨绿:夹克"),
                         ("qualified", "墨绿夹克"))

    def test_negated_face_feature_is_not_positive_evidence(self):
        found = characters.search(self.root, "face", "痣", "realistic", "female", "young",
                                  required=["痣"])
        self.assertEqual([row["asset_id"] for row in found], [12])


if __name__ == "__main__":
    unittest.main()
