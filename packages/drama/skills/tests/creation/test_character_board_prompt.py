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


if __name__ == "__main__":
    unittest.main()
