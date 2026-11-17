"""Four-region prompt assembly keeps caller style separate from fixed layout."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

PACKAGE = Path(__file__).resolve().parents[2]
SCRIPT = PACKAGE / "skills/tweet-drama-asset-vision-check/scripts/character_board_prompt.py"


class CharacterBoardPrompt(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("character_board_prompt", SCRIPT)
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_art_direction_is_preserved_and_layout_does_not_change_between_media(self):
        styles = (
            "3D动漫，电影级三维CG，PBR材质、立体发束和柔和体积光照。",
            "2D动画，清晰手绘线条、赛璐璐平涂。",
            "真人摄影，写实服装与柔和影棚光。",
            "水彩插画，保留纸张纹理与透明色层。\n沿用用户确认的冷色调。",
        )
        character = "成年女性，短卷发，绿色夹克和长裤，白色平底鞋。"
        layouts = []
        for style in styles:
            with self.subTest(style=style):
                result = self.module.build_prompt(style, character)
                self.assertEqual(set(result), {"prompt", "image_aspect_ratio"})
                self.assertEqual(result["image_aspect_ratio"], "16:9")
                prefix = style + "\n人物设定：" + character + "\n"
                self.assertTrue(result["prompt"].startswith(prefix))
                layouts.append(result["prompt"][len(prefix):])
        self.assertEqual(len(set(layouts)), 1)

    def test_fixed_layout_does_not_inject_a_medium_or_material_style(self):
        for style in ("水彩，透明色层与纸张纹理。", "二维动画，保持手绘轮廓。", "三维动画，柔和棚拍光。"):
            with self.subTest(style=style):
                result = self.module.build_prompt(style, "保持已确认角色。")
                layout = result["prompt"].split("\n", 2)[2]
                for injected in ("PBR", "CG", "二维", "三维", "真人", "平涂", "次表面散射"):
                    self.assertNotIn(injected, layout)

    def test_four_distinct_regions_and_only_front_side_masks_reach_cli_output(self):
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "--style-prompt", "3D动漫，PBR材质。",
             "--character-prompt", "成年女性，短卷发，绿色夹克。"],
            capture_output=True, text=True, encoding="utf-8", timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        prompt = json.loads(result.stdout)["prompt"]
        regions = [line for line in prompt.splitlines() if line[:1] in "ABCD" and "区（" in line]
        self.assertEqual([line[:1] for line in regions], list("ABCD"))
        for line, angle in zip(regions[1:], ("0°", "90°", "180°")):
            self.assertIn(angle, line)
            self.assertIn("全身", line)
        self.assertIn("不遮罩", regions[0])
        self.assertIn("正脸皮肤", regions[1])
        self.assertIn("纯白遮罩", regions[1])
        self.assertIn("侧脸皮肤", regions[2])
        self.assertIn("纯白遮罩", regions[2])
        self.assertIn("完全不遮罩", regions[3])
        self.assertNotIn("纯白遮罩", regions[3])

    def test_missing_style_or_identity_never_produces_a_generation_prompt(self):
        for style, character in ((None, "角色"), ("  ", "角色"), ("风格", ""), ("风格", [])):
            with self.subTest(style=style, character=character):
                with self.assertRaises(ValueError):
                    self.module.build_prompt(style, character)
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "--style-prompt", " ", "--character-prompt", "角色"],
            capture_output=True, text=True, encoding="utf-8", timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_targeted_edit_keeps_the_original_style_and_all_four_regions(self):
        style = "2D动画，保留手绘线条和水彩色层。"
        result = self.module.build_prompt(style, "既有角色的绿色夹克。", edit_existing=True)
        self.assertTrue(result["prompt"].startswith(style + "\n"))
        self.assertIn("编辑当前候选人物板", result["prompt"])
        self.assertIn("不要删除背面", result["prompt"])
        self.assertIn(self.module.BOARD_LAYOUT, result["prompt"])
        self.assertNotIn("PBR", result["prompt"])

    def test_masks_are_opaque_graphics_exempt_from_face_rendering(self):
        result = self.module.build_prompt("水彩，保留纸张纹理。", "成年女性，面部自然。")
        prompt = result["prompt"]
        self.assertIn("#FFFFFF", prompt)
        self.assertIn("不透明度100%", prompt)
        self.assertIn("仅B、C脸部", prompt)
        self.assertIn("不参与人物皮肤、五官、材质或光照渲染", prompt)
        self.assertIn("只有A区显示清晰五官", prompt)
        for region in ("B", "C"):
            line = next(line for line in prompt.splitlines() if line.startswith(region + "区（"))
            self.assertIn("无五官纯白区域", line)
        self.assertNotIn("PBR", prompt)

    def test_repair_preserves_existing_four_views_and_uses_input_style(self):
        style = "真人摄影，服装有真实厚度。"
        result = self.module.build_prompt(style, "保留既有角色。", edit_existing=True)
        self.assertIn("四区已齐时", result["prompt"])
        self.assertIn("仅缺失C区时", result["prompt"])
        self.assertIn("不复制已有侧面", result["prompt"])
        self.assertIn("不继承候选的画风", result["prompt"])
        self.assertTrue(result["prompt"].startswith(style + "\n"))

    def test_create_and_repair_outputs_match_recorded_prompt_inputs(self):
        record = json.loads((Path(__file__).parent / "expected/character-board-prompt.json").read_text(encoding="utf-8"))
        for mode, expected in record["outputs"].items():
            with self.subTest(mode=mode):
                actual = self.module.build_prompt(record["style_prompt"], record["character_prompt"],
                                                  edit_existing=mode == "repair")
                self.assertEqual(actual, expected)

    def test_delivery_references_do_not_exempt_layout_or_style_from_acceptance(self):
        owner = PACKAGE / "skills/tweet-drama-asset-vision-check/SKILL.md"
        self.assertIn("版式或画风未通过", owner.read_text(encoding="utf-8"))
        directory = PACKAGE / "skills/anime-3d-assets/references"
        for filename in ("data-rules.md", "first-pass-cg.md", "reference-standard.md"):
            with self.subTest(reference=filename):
                text = (directory / filename).read_text(encoding="utf-8")
                self.assertIn("../../tweet-drama-asset-vision-check/SKILL.md#人物设定板版式", text)
                self.assertNotRegex(text, r"不加入必须通过的检查|不作为生成、导入或采用条件|不加入提交检查、导入或采用条件|不增加生成、导入或采用的前置条件")


if __name__ == "__main__":
    unittest.main()
