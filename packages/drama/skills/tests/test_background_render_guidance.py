"""Render previews preserve approved choices without authorizing extra paid work."""
from pathlib import Path
import unittest


class BackgroundRenderGuidance(unittest.TestCase):
    def test_upscale_uses_live_catalogue_and_explicit_paid_authority(self):
        text = (Path(__file__).resolve().parents[1] / "skills" /
                "tweet-drama-background-render" / "SKILL.md").read_text(encoding="utf-8")
        for required in ("method=models, task_type=20", "默认 SeedVR2", "不保证精确 1080×1920",
                         "仿真人剧默认使用已认可原片", "不因画质判断自动购买"):
            self.assertIn(required, text)
        self.assertNotIn("models` 入口不接受 task_type=20", text)
        self.assertNotIn("参考价为 1 元/条", text)

    def test_render_previews_distinguish_music_plan_and_review_style(self):
        text = (Path(__file__).resolve().parents[1] / "skills" /
                "tweet-drama-background-render" / "SKILL.md").read_text(encoding="utf-8")
        for required in ("render_preview.delivery", "空 `bgm_plan` 不证明没混入音乐",
                         "不得把含对白的混音审查件当独立 BGM", "SRT 不携带审查视频的字体样式",
                         "普通样式差异先提示", "不新增批准或要求提示清零"):
            self.assertIn(required, text)

    def test_style_and_loudness_review_use_the_same_formal_candidate(self):
        text = (Path(__file__).resolve().parents[1] / "skills" /
                "tweet-drama-background-render" / "SKILL.md").read_text(encoding="utf-8")
        for required in ("字幕外观和混音响度以同一份 `drama_render` 正式候选为审查对象",
                         "相同的 delivery、字体和增益", "临时预览只证明文字与时间",
                         "不能据此宣称正式样式或混音已验收", "用户实际试听观看的同一候选",
                         "另存新候选重新听看", "不覆盖旧批准文件", "不新增硬门禁或批准步骤"):
            self.assertIn(required, text)


if __name__ == "__main__":
    unittest.main()
