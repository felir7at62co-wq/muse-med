"""Offline generation preflight regressions for the bundled anime asset skill."""
import copy
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

PACKAGE = Path(__file__).resolve().parents[2]
SKILL = PACKAGE / "skills/anime-3d-assets"
SCRIPT = SKILL / "scripts/validate_generation_request.py"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
STYLE_URL = "https://example.invalid/style.png"
MATERIAL_URL = "https://example.invalid/material.png"


def load_script(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def planned_request(medium="3D动漫"):
    """Build a prepared asset and the exact single-item tool arguments."""
    prompt = (
        f"{medium}，次世代高精度建模 CG，物理可信 PBR 材质，精致风格化建模比例。"
        "人物按剧本年龄独立设计，织物有纤维、缝线、折边和厚度，"
        "局部粗糙度与反射层次清楚，柔和主辅光保留体积与接触阴影。"
        f"最终保持{medium}媒介与物理可信 PBR 质感。"
    )
    record = {
        "style_family": "3d_anime",
        "generation": {
            "prompt_parts": {"medium": medium},
            "final_prompt": prompt,
            "references": [
                {"purpose": "style", "upload_status": "uploaded", "submitted": True, "url": STYLE_URL},
                {"purpose": "structure", "upload_status": "uploaded", "submitted": True, "url": MATERIAL_URL},
            ],
        },
    }
    request = {
        "method": "image_generate", "prompt": prompt,
        "script_id": 123, "asset_name": "离线测试角色", "asset_type": 1,
        "idempotency_key": "offline-only-no-submit",
        "references": [STYLE_URL, MATERIAL_URL], "image_aspect_ratio": "16:9",
    }
    return record, request


class GenerationRequest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.validator = load_script(SCRIPT)

    def validate(self, record, request):
        return self.validator.validate_generation_request(record, request)

    def test_explicit_anime_medium_and_pbr_reach_the_exact_request(self):
        record, request = planned_request()
        before = copy.deepcopy((record, request))
        self.assertEqual(self.validate(record, request), [])
        self.assertEqual((record, request), before)
        self.assertIn("织物有纤维、缝线、折边和厚度", request["prompt"])
        self.assertIn("局部粗糙度与反射层次", request["prompt"])

    def test_supported_positive_medium_names(self):
        for medium in ("3D动漫", "3D国漫", "三维动漫", "3D动画", "三维动画", "风格化三维动画", "风格化动画", "3D动漫／风格化三维动画", "3danime", "stylizedanimation", "stylized animation", "3D anime", "3d Anime", "3D 动漫", "Stylized   Animation"):
            with self.subTest(medium=medium):
                self.assertEqual(self.validate(*planned_request(medium)), [])

    def test_exact_project_prefix_preserves_all_published_media_and_full_request(self):
        for medium in sorted(self.validator.MEDIA) + ["3D anime", "stylized animation", "Stylized   Animation", "3D 动漫"]:
            for prefix in ("项目风格: ", "项目风格："):
                with self.subTest(medium=medium, prefix=prefix):
                    record, request = planned_request(medium)
                    record["generation"]["final_prompt"] = request["prompt"] = prefix + request["prompt"]
                    request["image_style"] = "anime"
                    before = copy.deepcopy((record, request))
                    self.assertEqual(self.validate(record, request), [])
                    self.assertEqual((record, request), before)

    def test_nonleading_negative_or_inexact_prefix_does_not_supply_the_medium(self):
        for prefix in ("说明：", "项目风格 ：", "项目风格：\n", "项目风格：\r\n", "项目风格：不要", "不要"):
            with self.subTest(prefix=prefix):
                record, request = planned_request()
                record["generation"]["final_prompt"] = request["prompt"] = prefix + request["prompt"]
                self.assertIn("request.prompt must open with the declared positive animation medium",
                              self.validate(record, request))

    def test_provided_image_style_must_agree_with_confirmed_animation(self):
        for image_style in ("live_action", None, "unsupported", 1, ["anime"]):
            with self.subTest(image_style=image_style):
                record, request = planned_request()
                request["image_style"] = image_style
                self.assertIn("request.image_style must be anime for the declared animation medium",
                              self.validate(record, request))
        record, request = planned_request()
        request["image_style"] = "anime"
        self.assertEqual(self.validate(record, request), [])

    def test_lone_carriage_return_does_not_join_a_project_declaration(self):
        for medium in ("风格化动画", "stylized animation"):
            for prefix in ("项目风格:", "项目风格："):
                with self.subTest(medium=medium, prefix=prefix):
                    record, request = planned_request(medium)
                    record["generation"]["final_prompt"] = request["prompt"] = prefix + "\r" + request["prompt"]
                    self.assertIn("request.prompt must open with the declared positive animation medium",
                                  self.validate(record, request))

    def test_local_review_images_are_not_submitted(self):
        record, request = planned_request()
        record["generation"]["references"].append({"purpose": "local_review", "submitted": False})
        self.assertEqual(self.validate(record, request), [])
        record["generation"]["references"][-1]["submitted"] = True
        self.assertTrue(self.validate(record, request))

    def test_legacy_cg_only_prompt_fails_while_r2_positive_medium_passes(self):
        record, request = planned_request()
        # Reconstructed short examples of the observed drift and r2 style wording;
        # these are not complete historical requests or a recorded-session replay.
        legacy = "次世代高精度建模 CG，物理可信 PBR 材质，自然比例，皮肤微纹理。不要真人摄影，不要动漫平涂。"
        record["generation"]["final_prompt"] = request["prompt"] = legacy
        self.assertTrue(self.validate(record, request))
        medium = "3D国漫"
        r2 = "3D动漫，东方古装美型3D国漫，物理可信 PBR 材质，风格化建模比例与审美、均匀哑光CG着色、发束分组建模。"
        record["generation"]["prompt_parts"]["medium"] = "3D动漫"
        record["generation"]["final_prompt"] = request["prompt"] = r2
        self.assertIn(medium, r2)
        self.assertEqual(self.validate(record, request), [])

    def test_negative_only_animation_word_is_not_a_positive_medium(self):
        record, request = planned_request()
        for prompt in (
            "次世代高精度建模 CG，物理可信 PBR 材质。负面：不要3D动漫。",
            "禁止3D动漫，物理可信 PBR 材质。",
            "真人摄影，物理可信 PBR 材质。不要3D动画。",
        ):
            with self.subTest(prompt=prompt):
                record["generation"]["final_prompt"] = request["prompt"] = prompt
                self.assertTrue(self.validate(record, request))

    def test_medium_declaration_is_required_and_cannot_be_cg_only(self):
        record, request = planned_request()
        for parts in ({}, {"medium": "CG"}, {"medium": "photorealistic"}):
            with self.subTest(parts=parts):
                record["generation"]["prompt_parts"] = parts
                self.assertTrue(self.validate(record, request))

    def test_pbr_is_required_in_the_opening_sentence(self):
        record, request = planned_request()
        for prompt in (
            "3D动漫，精致风格化建模。",
            "3D动漫。随后使用物理可信 PBR 材质。",
            "3D动漫. PBR material details follow.",
        ):
            with self.subTest(prompt=prompt):
                record["generation"]["final_prompt"] = request["prompt"] = prompt
                self.assertTrue(self.validate(record, request))

    def test_pbr_adjacent_to_chinese_material_text_is_retained(self):
        record, request = planned_request()
        request["prompt"] = request["prompt"].replace("PBR 材质", "PBR材质")
        record["generation"]["final_prompt"] = request["prompt"]
        self.assertEqual(self.validate(record, request), [])

    def test_negation_attached_to_the_medium_is_not_a_positive_opening(self):
        record, request = planned_request()
        request["prompt"] = "3D动漫禁止，真人摄影，PBR 材质。"
        record["generation"]["final_prompt"] = request["prompt"]
        self.assertTrue(self.validate(record, request))

    def test_invalid_reference_purpose_returns_errors_instead_of_crashing(self):
        record, request = planned_request()
        record["generation"]["references"][0]["purpose"] = []
        self.assertTrue(self.validate(record, request))

    def test_agent_rewrite_after_recording_is_rejected(self):
        record, request = planned_request()
        request["prompt"] += " portrait photography"
        self.assertTrue(self.validate(record, request))

    def test_failed_upload_cannot_fall_back_to_text_only(self):
        record, request = planned_request()
        for reference in record["generation"]["references"]:
            reference.update(upload_status="failed", submitted=False, url=None)
        request["references"] = []
        self.assertTrue(self.validate(record, request))
        request.pop("references")
        self.assertTrue(self.validate(record, request))

    def test_failed_reference_cannot_be_dropped_from_the_actual_request(self):
        record, request = planned_request()
        record["generation"]["references"][1].update(upload_status="failed", submitted=False, url=None)
        request["references"] = [STYLE_URL]
        self.assertTrue(self.validate(record, request))

    def test_unconfirmed_or_unsubmitted_upload_does_not_authorize_generation(self):
        for change in ({"upload_status": "failed"}, {"upload_status": "pending"}, {"upload_status": None}, {"submitted": False}, {"submitted": "true"}):
            with self.subTest(change=change):
                record, request = planned_request()
                record["generation"]["references"][0].update(change)
                self.assertTrue(self.validate(record, request))

    def test_omitting_the_whole_style_plan_is_rejected(self):
        record, request = planned_request()
        record["generation"]["references"] = []
        request["references"] = []
        self.assertTrue(self.validate(record, request))

    def test_structure_reference_alone_cannot_replace_style_reference(self):
        record, request = planned_request()
        record["generation"]["references"][0]["purpose"] = "structure"
        self.assertTrue(self.validate(record, request))

    def test_remote_reference_urls_must_be_https(self):
        for url in ("http://example.invalid/style.png", "file:///style.png", "", "https:///style.png"):
            with self.subTest(url=url):
                record, request = planned_request()
                record["generation"]["references"][0]["url"] = request["references"][0] = url
                self.assertTrue(self.validate(record, request))

    def test_actual_reference_urls_and_order_must_match_the_plan(self):
        for references in ([STYLE_URL], [MATERIAL_URL, STYLE_URL], [STYLE_URL, "https://example.invalid/other.png"], [STYLE_URL, MATERIAL_URL, STYLE_URL]):
            with self.subTest(references=references):
                record, request = planned_request()
                request["references"] = references
                self.assertTrue(self.validate(record, request))

    def test_generation_preflight_does_not_claim_visual_review(self):
        record, request = planned_request()
        record["review"] = {"result": "not_checked"}
        self.assertEqual(self.validate(record, request), [])
        self.assertEqual(record["review"]["result"], "not_checked")

    def test_failed_reference_plan_remains_a_valid_structural_draft(self):
        structural = load_script(SKILL / "scripts/validate_asset_records.py")
        record = json.loads((SKILL / "assets/asset-template.json").read_text(encoding="utf-8"))
        record.update(project_id="offline", asset_id="CHAR-001", name="角色", type="character")
        prepared, request = planned_request()
        record["generation"] = prepared["generation"]
        record["generation"]["references"][0].update(upload_status="failed", submitted=False, url=None)
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(structural.validate_records([record], Path(folder)), [])
        self.assertTrue(self.validate(record, request))


class GenerationRequestCLI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def invoke(self, request, records):
        request_path = self.root / "request.json"
        request_path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
        paths = []
        for index, record in enumerate(records):
            file = self.root / f"record-{index}.json"
            file.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
            paths.append(file)
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "--request", str(request_path), "--records", *(str(p) for p in paths)],
            capture_output=True, text=True, encoding="utf-8", timeout=30, creationflags=NO_WINDOW,
        )
        self.assertEqual({p.name: p.read_bytes() for p in self.root.iterdir()}, before)
        report = json.loads(result.stdout)
        self.assertEqual(report["visual_review"], "not_performed")
        return result.returncode, report

    def test_single_prepared_request_exits_zero(self):
        record, request = planned_request()
        code, report = self.invoke(request, [record])
        self.assertEqual(code, 0)
        self.assertTrue(report["generation_ready"])
        self.assertEqual(report["errors"], [])

    def test_exact_project_prefix_passes_the_read_only_cli(self):
        record, request = planned_request("stylized animation")
        record["generation"]["final_prompt"] = request["prompt"] = "项目风格：" + request["prompt"]
        request["image_style"] = "anime"
        before = copy.deepcopy((record, request))
        code, report = self.invoke(request, [record])
        self.assertEqual(code, 0)
        self.assertTrue(report["generation_ready"])
        self.assertEqual((record, request), before)

    def test_later_conflicting_image_style_blocks_the_complete_batch(self):
        first, first_request = planned_request()
        second, second_request = planned_request("风格化动画")
        second_request["image_style"] = "live_action"
        items = [self.batch_item(first_request, "offline-first"), self.batch_item(second_request, "offline-second")]
        code, report = self.invoke({"method": "image_generate_batch", "script_id": 123, "items": items}, [first, second])
        self.assertEqual(code, 1)
        self.assertFalse(report["generation_ready"])
        self.assertIn("items[1]: request.image_style must be anime for the declared animation medium", report["errors"])

    def test_top_level_batch_image_style_is_rejected(self):
        for image_style in ("anime", "live_action", None):
            with self.subTest(image_style=image_style):
                record, item_request = planned_request()
                request = {"method": "image_generate_batch", "script_id": 123,
                           "image_style": image_style,
                           "items": [self.batch_item(item_request, "offline-batch-style")]}
                code, report = self.invoke(request, [record])
                self.assertEqual(code, 1)
                self.assertFalse(report["generation_ready"])
                self.assertIn("image_generate_batch requires per-item image_style, not a top-level image_style",
                              report["errors"])

    def test_explicit_pbr_prohibition_is_not_a_positive_material_requirement(self):
        for prompt in ("3D动漫，禁止PBR材质。", "3D动漫，物理可信PBR材质。其他要求：不要使用PBR材质。",
                       "3D动漫，物理可信PBR材质。不要使用PBR材质用于任何角色。",
                       "3D anime, do not use PBR materials.",
                       "3D anime, PBR materials. Do not use PBR materials for any character."):
            with self.subTest(prompt=prompt):
                record, request = planned_request("3D anime" if prompt.startswith("3D anime") else "3D动漫")
                record["generation"]["final_prompt"] = request["prompt"] = prompt
                code, report = self.invoke(request, [record])
                self.assertEqual(code, 1)
                self.assertFalse(report["generation_ready"])
                self.assertIn("items[0]: request.prompt explicitly prohibits PBR materials", report["errors"])

    def test_positive_live_action_or_photorealistic_instruction_is_rejected(self):
        for prompt in ("3D动漫，不是动画而是真人摄影，物理可信PBR材质。",
                       "3D动漫，物理可信PBR材质。使用photorealistic人物摄影。",
                       "3D anime, PBR materials. Not animation but photorealistic portrait photography."):
            with self.subTest(prompt=prompt):
                record, request = planned_request("3D anime" if prompt.startswith("3D anime") else "3D动漫")
                record["generation"]["final_prompt"] = request["prompt"] = prompt
                code, report = self.invoke(request, [record])
                self.assertEqual(code, 1)
                self.assertFalse(report["generation_ready"])
                self.assertIn("items[0]: request.prompt positively requests live-action photography", report["errors"])

    def test_negative_photography_exclusions_and_material_quality_advice_remain_valid(self):
        for medium, suffix in (("3D动漫", "不要真人摄影，不使用photorealistic人物摄影。避免PBR材质粗糙度不一致。"),
                               ("3D动漫", "禁止使用photorealistic，不要生成真人摄影。"),
                               ("3D anime", "Not photorealistic portrait photography, no live-action photography. Avoid inconsistent PBR material roughness."),
                               ("3D anime", "Non-photorealistic shading, do not make it photorealistic.")):
            with self.subTest(medium=medium):
                record, request = planned_request(medium)
                record["generation"]["final_prompt"] = request["prompt"] = request["prompt"] + suffix
                before = copy.deepcopy((record, request))
                code, report = self.invoke(request, [record])
                self.assertEqual(code, 0)
                self.assertTrue(report["generation_ready"])
                self.assertEqual(report["errors"], [])
                self.assertEqual((record, request), before)

    def test_conflicting_prompt_report_matches_the_owner_local_cli_snapshot(self):
        record, request = planned_request()
        record["generation"]["final_prompt"] = request["prompt"] = (
            "3D动漫，禁止PBR材质，使用photorealistic人物摄影。")
        code, report = self.invoke(request, [record])
        expected = json.loads((Path(__file__).parent / "expected/conflicting-request.json").read_text(encoding="utf-8"))
        self.assertEqual(code, 1)
        self.assertEqual(report, expected)

    def test_realistic_cg_lighting_and_materials_do_not_assert_a_photographic_medium(self):
        for prompt in ("3D动漫，物理可信PBR材质，photorealistic lighting and material textures, retain CGI characters.",
                       "3D动漫，物理可信PBR材质，写实3D角色，photorealistic PBR materials."):
            with self.subTest(prompt=prompt):
                record, request = planned_request()
                record["generation"]["final_prompt"] = request["prompt"] = prompt
                before = copy.deepcopy((record, request))
                code, report = self.invoke(request, [record])
                self.assertEqual(code, 0)
                self.assertEqual(report["errors"], [])
                self.assertEqual((record, request), before)

    def test_explicit_2d_direction_is_not_rewritten_or_rejected_by_photography_check(self):
        record, request = planned_request("风格化动画")
        record["generation"]["final_prompt"] = request["prompt"] = (
            "风格化动画，用户明确要求2D cel shading，物理可信PBR材质。不要真人摄影。")
        before = copy.deepcopy((record, request))
        code, report = self.invoke(request, [record])
        self.assertEqual(code, 0)
        self.assertTrue(report["generation_ready"])
        self.assertEqual((record, request), before)

    def test_unknown_reference_upload_stays_blocked_without_text_only_fallback(self):
        record, request = planned_request()
        record["generation"]["references"][0]["upload_status"] = "unknown"
        code, report = self.invoke(request, [record])
        self.assertEqual(code, 1)
        self.assertFalse(report["generation_ready"])
        self.assertEqual(request["references"], [STYLE_URL, MATERIAL_URL])

    def test_failed_upload_exits_one_before_generation(self):
        record, request = planned_request()
        record["generation"]["references"][0].update(upload_status="failed", submitted=False, url=None)
        request["references"] = []
        code, report = self.invoke(request, [record])
        self.assertEqual(code, 1)
        self.assertFalse(report["generation_ready"])
        self.assertTrue(report["errors"])

    def test_valid_batch_pairs_records_in_item_order(self):
        first, first_request = planned_request()
        second, second_request = planned_request("三维动画")
        items = [self.batch_item(first_request, "offline-first"), self.batch_item(second_request, "offline-second")]
        code, report = self.invoke({"method": "image_generate_batch", "script_id": 123, "items": items}, [first, second])
        self.assertEqual(code, 0)
        self.assertTrue(report["generation_ready"])

    def test_any_failed_batch_item_blocks_the_whole_batch(self):
        first, first_request = planned_request()
        second, second_request = planned_request("三维动画")
        second["generation"]["references"][0].update(upload_status="failed", submitted=False)
        items = [self.batch_item(first_request, "offline-first"), self.batch_item(second_request, "offline-second")]
        code, report = self.invoke({"method": "image_generate_batch", "script_id": 123, "items": items}, [first, second])
        self.assertEqual(code, 1)
        self.assertFalse(report["generation_ready"])
        self.assertTrue(report["errors"])

    def test_batch_record_count_or_order_mismatch_is_rejected(self):
        first, first_request = planned_request()
        second, second_request = planned_request("三维动画")
        for records in ([first], [second, first]):
            with self.subTest(records=len(records)):
                items = [self.batch_item(first_request, "offline-first"), self.batch_item(second_request, "offline-second")]
                code, report = self.invoke({"method": "image_generate_batch", "script_id": 123, "items": items}, records)
                self.assertEqual(code, 1)
                self.assertFalse(report["generation_ready"])

    def batch_item(self, request, key):
        """Project single arguments onto the existing batch item's wire fields."""
        item = {name: value for name, value in request.items()
                if name not in {"method", "script_id", "image_aspect_ratio"}}
        item["idempotency_key"] = key
        item["asset_name"] = key
        return item

    def test_unrelated_method_does_not_get_generation_approval(self):
        record, request = planned_request()
        request["method"] = "video_generate"
        code, report = self.invoke(request, [record])
        self.assertEqual(code, 1)
        self.assertFalse(report["generation_ready"])

    def test_malformed_json_returns_a_failed_report(self):
        request_path = self.root / "request.json"
        record_path = self.root / "record.json"
        request_path.write_text("{broken", encoding="utf-8")
        record_path.write_text("{}", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "--request", str(request_path), "--records", str(record_path)],
            capture_output=True, text=True, encoding="utf-8", timeout=30, creationflags=NO_WINDOW,
        )
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(result.stdout)["generation_ready"])

    def test_missing_json_file_returns_a_failed_report(self):
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "--request", str(self.root / "missing.json"), "--records", str(self.root / "missing-record.json")],
            capture_output=True, text=True, encoding="utf-8", timeout=30, creationflags=NO_WINDOW,
        )
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(result.stdout)["generation_ready"])


class OptionalResources(unittest.TestCase):
    def assert_positive_opening(self, prompt):
        opening = re.split(r"[。.!?！？\n]", prompt.strip(), maxsplit=1)[0]
        self.assertRegex(opening, r"(?i)^(?:3D\s*(?:动漫|国漫|动画|anime)|三维(?:动漫|动画)|风格化(?:三维)?动画|stylized\s+animation)")
        self.assertRegex(opening, r"(?i)\bPBR\b")

    def copyable_prompts(self, name):
        text = (SKILL / "references" / name).read_text(encoding="utf-8")
        prompts = re.findall(r"\x60\x60\x60text\r?\n(.*?)\r?\n\x60\x60\x60", text, re.S)
        self.assertTrue(prompts, f"{name}: no copyable prompts checked")
        return [prompt.strip() for prompt in prompts]

    def test_skill_rules_do_not_strip_the_requested_positive_medium(self):
        first_pass = (SKILL / "references/first-pass-cg.md").read_text(encoding="utf-8")
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        self.assertNotRegex(first_pass, r"正向描述禁用[：:]\s*三维动画")
        self.assertNotIn("不使用三维动画等泛化风格词", skill)

    def test_copyable_design_and_production_prompts_keep_medium_and_pbr(self):
        validator = load_script(SCRIPT)
        for name in ("design-and-prompts.md", "production-examples.md"):
            for index, prompt in enumerate(self.copyable_prompts(name)):
                with self.subTest(reference=name, prompt=index):
                    self.assert_positive_opening(prompt)
                    record, request = planned_request()
                    record["generation"]["final_prompt"] = request["prompt"] = prompt
                    self.assertEqual(validator.validate_generation_request(record, request), [])

    def test_project_style_lock_keeps_the_medium_and_pbr_at_both_ends(self):
        project = json.loads((SKILL / "assets/project-template.json").read_text(encoding="utf-8"))
        lock = project["style_lock"]
        self.assert_positive_opening(lock["required_prefix"])
        self.assertRegex(lock["required_suffix"], r"(?i)(?:3D\s*(?:动漫|国漫|动画|anime)|三维(?:动漫|动画)|风格化(?:三维)?动画|stylized\s+animation)")
        self.assertRegex(lock["required_suffix"], r"(?i)\bPBR\b")

    def test_scene_records_match_the_copyable_prompts_and_keep_medium(self):
        prompts = self.copyable_prompts("production-examples.md")
        for index, name in enumerate(("scene-day.example.json", "scene-night.example.json")):
            with self.subTest(record=name):
                record = json.loads((SKILL / "assets" / name).read_text(encoding="utf-8"))
                generation = record["generation"]
                self.assert_positive_opening(generation["final_prompt"])
                self.assertEqual(generation["final_prompt"].strip(), prompts[index])
                self.assertTrue(generation["final_prompt"].startswith(generation["prompt_parts"]["medium"]))

    def test_every_relative_markdown_resource_is_available(self):
        for file in SKILL.rglob("*.md"):
            text = file.read_text(encoding="utf-8")
            for match in re.finditer(r"!?\[[^\]]*\]\(([^)]+)\)", text):
                target = match.group(1).split("#", 1)[0]
                if not target or re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I):
                    continue
                with self.subTest(file=file.relative_to(SKILL), target=target):
                    self.assertTrue((file.parent / target).is_file())

    def test_ci_runs_the_preflight_before_desktop_packaging(self):
        workflow = (PACKAGE.parents[2] / ".github/workflows/muse-desktop.yml").read_text(encoding="utf-8")
        command = "python -B -m unittest discover -s packages/drama/skills/tests/anime_3d"
        self.assertIn(command, workflow)
        self.assertLess(workflow.index(command), workflow.index("Build and verify the assembled application"))

    def test_complete_asset_skill_is_included_in_the_default_package(self):
        package = json.loads((PACKAGE / "package.json").read_text(encoding="utf-8"))
        expected = {path.relative_to(PACKAGE).as_posix() for path in SKILL.rglob("*") if path.is_file()}
        self.assertTrue(expected.issubset(set(package["files"])))
        self.assertIn("skills/anime-3d-assets/SKILL.md", expected)


if __name__ == "__main__":
    unittest.main()
