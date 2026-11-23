"""The A/B report: minutes and spend between first passes, coverage, and the summary over a range."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from desk_report import report


def usage(output):
    return {"input": 0, "cacheRead": 0, "cacheWrite": 0, "output": output}


class ReportTest(unittest.TestCase):
    def test_minutes_and_spend_are_measured_between_first_passes(self):
        desk = {"title": "盛夏芬德拉", "bot": "转写1", "model": "m/flash",
                "doneAt": {"31": "2026-11-23 20:00:00", "32": "2026-11-23 20:06:00", "33": "2026-11-23 20:16:00"},
                "measures": {"31": {"speechCoverage": 0.9, "qa": True, "usage": usage(0)},
                             "32": {"speechCoverage": 0.8, "qa": True, "usage": usage(100_000)},
                             "33": {"speechCoverage": 0.7, "qa": False, "usage": usage(400_000)}}}
        result = report(desk, {"m/flash": {"output": 4.8}})
        self.assertEqual([(r["episode"], r["minutes"], r["yuan"]) for r in result["episodes"]],
                         [(31, None, None), (32, 6.0, 0.48), (33, 10.0, 1.44)])
        self.assertEqual(result["summary"]["medianMinutes"], 8.0)
        self.assertEqual(result["summary"]["medianCoverage"], 0.8)
        only = report(desk, {"m/flash": {"output": 4.8}}, 32, 33)
        self.assertEqual([r["episode"] for r in only["episodes"]], [32, 33])
        self.assertEqual(only["summary"]["qaShare"], 0.5)

    def test_speakers_are_checked_against_the_character_table(self):
        with TemporaryDirectory() as folder:
            workspace = Path(folder)
            (workspace / "outline").mkdir()
            (workspace / "episodes").mkdir()
            (workspace / "outline" / "人物表.json").write_text(json.dumps({"characters": [
                {"name": "周晟安", "aliases": ["周总"], "variants": ["周生安"]}, {"name": "白清枚", "aliases": [], "variants": []}],
                "supporting_descriptive_names": ["服务员"]}, ensure_ascii=False), encoding="utf-8")
            (workspace / "episodes" / "第1集.md").write_text(
                "第1集\n1-1 茶室 日 内\n人物：周晟安、白清枚\n周晟安：你好。\n白清枚（OS）：他就是周晟安？\n周生安：请坐。\n"
                "服务员：您的茶。\n陌生人：借过。\n", encoding="utf-8")
            desk = {"title": "盛夏芬德拉", "workspace": str(workspace), "doneAt": {"1": "2026-11-23 20:00:00"},
                    "measures": {"1": {"qa": True}}}
            result = report(desk, {})
            self.assertEqual(result["episodes"][0]["characters"], {"speakers": 5, "unknown": ["陌生人"], "misspelled": ["周生安"]})
            self.assertEqual((result["summary"]["unknownSpeakers"], result["summary"]["misspelledSpeakers"]), (1, 1))


if __name__ == "__main__":
    unittest.main()
