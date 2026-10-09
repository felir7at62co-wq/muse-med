"""Offline regression cases for the per-episode coverage and paid-work gate."""

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "skills" / "tweet-drama-core" / "scripts"))
from episode_coverage import audit_project, paid_ready, write_pass_records


SOURCE_01 = "第01集\n1-1 公司大厅 日 内\n江屹：我是父亲。\n周桂芳（OS）：真的吗？\n△江屹转身。"
SOURCE_02 = "第02集\n2-1 地铁车厢 日 内\n江屹：第二集。"
SHOT_01 = """真人短剧写实风格
【镜头1】
画面：江屹在公司大厅。
发声类型：dialogue
台词：江屹：我是父亲。
真人短剧写实风格
【镜头2】
画面：周桂芳不在画面中。
发声类型：vo
说话人：周桂芳
OS：真的吗？
真人短剧写实风格
【镜头3】
画面：江屹转身。
发声类型：action
"""
SHOT_02 = """真人短剧写实风格
【镜头1】
画面：地铁车厢。
发声类型：dialogue
台词：江屹：第二集。
"""


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def put(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def put_json(path, data):
    put(path, json.dumps(data, ensure_ascii=False))


class CoverageTests(unittest.TestCase):
    def test_skill_package_includes_coverage_gate(self):
        package = Path(__file__).resolve().parents[2] / "package.json"
        resources = json.loads(package.read_text(encoding="utf-8"))["files"]
        self.assertIn("skills/tweet-drama-core/scripts/episode_coverage.py", resources)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def episode(self, ep="01", source=None, shot=None):
        source = source or (SOURCE_01 if ep == "01" else SOURCE_02)
        shot = shot or (SHOT_01 if ep == "01" else SHOT_02)
        source_path = self.root / "episodes" / f"{ep}.txt"
        shot_name = f"shots/第{ep}集镜头脚本.md"
        put(source_path, source)
        put(self.root / shot_name, shot)
        lines = source.splitlines()
        if ep == "01":
            kinds = ["heading", "scene", "dialogue", "os", "action"]
            shots = [[1], [1], [1], [2], [3]]
            speakers = {3: ("江屹", "我是父亲。"), 4: ("周桂芳", "真的吗？")}
        else:
            kinds = ["heading", "scene", "dialogue"]
            shots = [[1], [1], [1]]
            speakers = {3: ("江屹", "第二集。")}
        entries = []
        for number, (line, kind, numbers) in enumerate(zip(lines, kinds, shots), 1):
            row = {"source_line": number, "source_text": line, "kind": kind, "shots": numbers}
            if number in speakers:
                row["speaker"], row["speech_text"] = speakers[number]
            entries.append(row)
        put_json(self.root / "shots_and_matches" / f"ep{ep}-source-map.json", {
            "version": 1, "episode": ep, "source_sha256": sha(source),
            "shot_script": shot_name, "entries": entries,
        })
        return {"sha256": sha(source), "char_count": len(source)}

    def manifest(self, rows, expected_episode_count=None):
        manifest = {"version": 1, "episodes": rows}
        if expected_episode_count is not None:
            manifest["expected_episode_count"] = expected_episode_count
        put_json(self.root / "episodes" / "manifest.json", manifest)

    def mapping(self, ep="01"):
        path = self.root / "shots_and_matches" / f"ep{ep}-source-map.json"
        return path, json.loads(path.read_text(encoding="utf-8"))

    def test_complete_single_episode_requires_and_writes_bound_record(self):
        self.manifest({"01": self.episode()})
        before = audit_project(self.root)
        self.assertEqual(before["status"], "passed")
        self.assertFalse(before["episodes"]["01"]["accepted"])
        accepted = write_pass_records(self.root)
        self.assertEqual(accepted["status"], "passed")
        self.assertTrue(accepted["episodes"]["01"]["accepted"])
        record = json.loads((self.root / "shots_and_matches/ep01-coverage-acceptance.json").read_text(encoding="utf-8"))
        self.assertEqual(record["speech_count"], 2)
        self.assertEqual(record["source_sha256"], sha(SOURCE_01))
        self.assertEqual(paid_ready(self.root, ["01"])["status"], "passed")

    def test_complete_multiple_episodes_pass_in_order(self):
        self.manifest({"01": self.episode("01"), "02": self.episode("02")})
        result = write_pass_records(self.root)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["expected_episodes"], ["01", "02"])
        self.assertTrue(all(row["accepted"] for row in result["episodes"].values()))
        self.assertEqual(paid_ready(self.root, ["01", "02"])["status"], "passed")
        self.assertEqual(paid_ready(self.root, ["02", "01"])["status"], "blocked")

    def test_first_episode_can_advance_while_future_map_is_pending(self):
        self.manifest({"01": self.episode("01"), "02": self.episode("02")})
        (self.root / "shots_and_matches/ep02-source-map.json").unlink()
        accepted = write_pass_records(self.root, ["01"])
        self.assertEqual(accepted["status"], "pending")
        self.assertEqual(accepted["accept_status"], "passed")
        self.assertTrue(accepted["episodes"]["01"]["accepted"])
        self.assertEqual(paid_ready(self.root, ["01"])["status"], "passed")
        self.assertEqual(paid_ready(self.root, ["02"])["status"], "blocked")

    def test_splitter_default_without_episode_heading_can_pass(self):
        self.manifest({"01": self.episode("01"), "02": self.episode("02")})
        source = SOURCE_02.split("\n", 1)[1]
        put(self.root / "episodes/02.txt", source)
        manifest_path = self.root / "episodes/manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["episodes"]["02"]["sha256"] = sha(source)
        put_json(manifest_path, manifest)
        map_path, mapping = self.mapping("02")
        mapping["source_sha256"] = sha(source)
        mapping["entries"] = [{**row, "source_line": row["source_line"] - 1}
                              for row in mapping["entries"][1:]]
        put_json(map_path, mapping)
        result = write_pass_records(self.root, ["01", "02"])
        self.assertEqual(result["accept_status"], "passed")
        self.assertEqual(paid_ready(self.root, ["02"])["status"], "passed")

    def test_declared_fifty_two_blocks_missing_final_episode(self):
        rows = {"01": self.episode("01")}
        for number in range(2, 52):
            ep = f"{number:02d}"
            source = f"第{ep}集\n{number}-1 场景 日 内\n江屹：第{ep}集。"
            put(self.root / "episodes" / f"{ep}.txt", source)
            rows[ep] = {"sha256": sha(source), "char_count": len(source)}
        self.manifest(rows, expected_episode_count=52)
        result = write_pass_records(self.root, ["01"])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["accept_status"], "blocked")
        self.assertIn("EP52", " ".join(result["source_reasons"]))
        self.assertFalse((self.root / "shots_and_matches/ep01-coverage-acceptance.json").exists())
        self.assertEqual(paid_ready(self.root, ["01"])["status"], "blocked")

    def test_first_of_fifty_two_can_advance_without_future_shots(self):
        rows = {"01": self.episode("01")}
        for number in range(2, 53):
            ep = f"{number:02d}"
            source = f"第{ep}集\n{number}-1 场景 日 内\n江屹：第{ep}集。"
            put(self.root / "episodes" / f"{ep}.txt", source)
            rows[ep] = {"sha256": sha(source), "char_count": len(source)}
        self.manifest(rows, expected_episode_count=52)
        accepted = write_pass_records(self.root, ["01"])
        self.assertEqual(accepted["accept_status"], "passed")
        self.assertEqual(accepted["status"], "pending")
        self.assertEqual(len(accepted["expected_episodes"]), 52)
        self.assertEqual(accepted["declared_episode_count"], 52)
        self.assertEqual(paid_ready(self.root, ["01"])["status"], "passed")
        self.assertEqual(paid_ready(self.root, ["02"])["status"], "blocked")

    def test_future_source_sha_change_blocks_earlier_signature(self):
        self.manifest({"01": self.episode("01"), "02": self.episode("02")})
        put(self.root / "episodes/02.txt", SOURCE_02 + "\n△后加动作。")
        result = write_pass_records(self.root, ["01"])
        self.assertEqual(result["accept_status"], "blocked")
        self.assertFalse((self.root / "shots_and_matches/ep01-coverage-acceptance.json").exists())
        self.assertEqual(paid_ready(self.root, ["01"])["status"], "blocked")

    def test_episode_gap_one_three_blocks_every_signature(self):
        self.manifest({"01": self.episode("01"), "03": self.episode("03", source="第03集\n江屹：第三集。", shot=SHOT_02)})
        result = write_pass_records(self.root)
        self.assertEqual(result["status"], "failed")
        self.assertIn("EP02", " ".join(result["reasons"]))
        self.assertFalse((self.root / "shots_and_matches/ep01-coverage-acceptance.json").exists())

    def test_body_heading_mismatched_to_manifest_episode(self):
        self.manifest({"01": self.episode("01"), "02": self.episode("02", source="第03集\n2-1 地铁车厢 日 内\n江屹：第二集。")})
        result = write_pass_records(self.root)
        self.assertEqual(result["status"], "failed")
        self.assertIn("EP02", " ".join(result["episodes"]["02"]["reasons"]))
        self.assertIn("正文集号", " ".join(result["episodes"]["02"]["reasons"]))

    def test_missing_one_dialogue_fails(self):
        self.manifest({"01": self.episode()})
        put(self.root / "shots/第01集镜头脚本.md", SHOT_01.replace("台词：江屹：我是父亲。", "发声类型：action"))
        result = write_pass_records(self.root)
        self.assertEqual(result["status"], "failed")
        self.assertIn("漏对白", " ".join(result["episodes"]["01"]["reasons"]))

    def test_wrong_speaker_and_voice_type_fail(self):
        self.manifest({"01": self.episode()})
        for changed in (SHOT_01.replace("台词：江屹：我是父亲。", "台词：周桂芳：我是父亲。"),
                        SHOT_01.replace("OS：真的吗？", "台词：周桂芳：真的吗？").replace("发声类型：vo", "发声类型：dialogue")):
            put(self.root / "shots/第01集镜头脚本.md", changed)
            result = write_pass_records(self.root)
            self.assertEqual(result["status"], "failed")
            self.assertIn("说话人或 OS/VO", " ".join(result["episodes"]["01"]["reasons"]))

    def test_map_cannot_self_report_wrong_source_speaker_or_os(self):
        self.manifest({"01": self.episode()})
        path, mapping = self.mapping()
        mapping["entries"][3]["kind"] = "dialogue"
        put_json(path, mapping)
        result = write_pass_records(self.root)
        self.assertEqual(result["status"], "failed")
        self.assertIn("与原文不符", " ".join(result["episodes"]["01"]["reasons"]))

    def test_os_replaced_by_vo_fails_even_when_both_compile_as_vo(self):
        self.manifest({"01": self.episode()})
        put(self.root / "shots/第01集镜头脚本.md", SHOT_01.replace("OS：真的吗？", "VO：真的吗？"))
        result = write_pass_records(self.root)
        self.assertEqual(result["status"], "failed")
        self.assertIn("OS/VO 子类型错误", " ".join(result["episodes"]["01"]["reasons"]))

    def test_generic_offscreen_is_pending_without_os_vo_evidence(self):
        self.manifest({"01": self.episode()})
        put(self.root / "shots/第01集镜头脚本.md", SHOT_01.replace("说话人：周桂芳\nOS：真的吗？", "台词：周桂芳（画外音）：真的吗？"))
        result = write_pass_records(self.root)
        self.assertEqual(result["status"], "pending")
        self.assertIn("未保留可验证的 OS/VO", " ".join(result["episodes"]["01"]["reasons"]))

    def test_generic_source_offscreen_cannot_claim_vo(self):
        self.manifest({"01": self.episode()})
        source = SOURCE_01.replace("周桂芳（OS）：真的吗？", "周桂芳（画外音）：真的吗？")
        put(self.root / "episodes/01.txt", source)
        manifest_path = self.root / "episodes/manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["episodes"]["01"]["sha256"] = sha(source)
        put_json(manifest_path, manifest)
        path, mapping = self.mapping()
        mapping["source_sha256"] = sha(source)
        mapping["entries"][3].update(source_text="周桂芳（画外音）：真的吗？", kind="vo")
        put_json(path, mapping)
        result = write_pass_records(self.root)
        self.assertEqual(result["status"], "pending")
        self.assertFalse((self.root / "shots_and_matches/ep01-coverage-acceptance.json").exists())

    def test_source_sha_change_invalidates_record(self):
        self.manifest({"01": self.episode()})
        self.assertTrue(write_pass_records(self.root)["episodes"]["01"]["accepted"])
        put(self.root / "episodes/01.txt", SOURCE_01 + "\n新加对白：必须重新验收。")
        result = audit_project(self.root)
        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["episodes"]["01"]["accepted"])
        self.assertIn("原文 SHA", " ".join(result["episodes"]["01"]["reasons"]))

    def test_missing_source_mapping_is_pending(self):
        self.manifest({"01": self.episode()})
        (self.root / "shots_and_matches/ep01-source-map.json").unlink()
        result = write_pass_records(self.root)
        self.assertEqual(result["status"], "pending")
        self.assertFalse((self.root / "shots_and_matches/ep01-coverage-acceptance.json").exists())

    def test_missing_source_line_mapping_fails(self):
        self.manifest({"01": self.episode()})
        path, mapping = self.mapping()
        mapping["entries"] = [row for row in mapping["entries"] if row["source_line"] != 3]
        put_json(path, mapping)
        result = write_pass_records(self.root)
        self.assertEqual(result["status"], "failed")
        self.assertIn("来源行 3 缺少", " ".join(result["episodes"]["01"]["reasons"]))

    def test_unsupported_source_speech_format_stays_pending(self):
        source = "第01集\n江屹（惊讶）：真的吗？"
        single_shot = "真人短剧写实风格\n【镜头1】\n发声类型：dialogue\n台词：江屹：真的吗？\n"
        self.manifest({"01": self.episode(source=source, shot=single_shot)})
        path, mapping = self.mapping()
        mapping["entries"] = mapping["entries"][:2]
        mapping["entries"][1].update(kind="dialogue", speaker="江屹", speech_text="真的吗？", shots=[1])
        put_json(path, mapping)
        result = audit_project(self.root)
        self.assertEqual(result["episodes"]["01"]["status"], "pending")

    def test_bare_unclassified_line_cannot_be_hidden_as_action(self):
        self.manifest({"01": self.episode()})
        path, mapping = self.mapping()
        source = SOURCE_01.replace("△江屹转身。", "江屹转身说了下一句")
        put(self.root / "episodes/01.txt", source)
        manifest_path = self.root / "episodes/manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["episodes"]["01"]["sha256"] = sha(source)
        put_json(manifest_path, manifest)
        mapping["source_sha256"] = sha(source)
        mapping["entries"][4]["source_text"] = "江屹转身说了下一句"
        put_json(path, mapping)
        result = audit_project(self.root)
        self.assertEqual(result["status"], "pending")
        self.assertIn("无法独立判定", " ".join(result["episodes"]["01"]["reasons"]))

    def test_speech_embedded_in_action_cannot_be_hidden_as_silent_action(self):
        source = "第01集\n△江屹说：我是父亲。"
        shot = "真人短剧写实风格\n【镜头1】\n发声类型：action\n画面：江屹站着。\n"
        self.manifest({"01": self.episode(source=source, shot=shot)})
        path, mapping = self.mapping()
        mapping["entries"] = [mapping["entries"][0], {
            "source_line": 2, "source_text": "△江屹说：我是父亲。",
            "kind": "action", "shots": [1],
        }]
        put_json(path, mapping)
        result = write_pass_records(self.root)
        self.assertEqual(result["status"], "failed")
        self.assertIn("把发声误标", " ".join(result["episodes"]["01"]["reasons"]))
        self.assertFalse((self.root / "shots_and_matches/ep01-coverage-acceptance.json").exists())

    def test_malformed_mapping_kind_fails_closed_with_reason(self):
        self.manifest({"01": self.episode()})
        path, mapping = self.mapping()
        mapping["entries"][2]["kind"] = []
        put_json(path, mapping)
        result = audit_project(self.root)
        self.assertEqual(result["status"], "failed")
        self.assertIn("类型无效", " ".join(result["episodes"]["01"]["reasons"]))

    def test_failed_gate_makes_zero_paid_calls(self):
        self.manifest({"01": self.episode()})
        sent = []

        def fake_paid_sender():
            if paid_ready(self.root, ["01"])["status"] == "passed":
                sent.append("PUT")

        fake_paid_sender()  # Valid content without signed evidence cannot send.
        self.assertEqual(sent, [])
        self.assertEqual(paid_ready(self.root, ["01"])["status"], "blocked")
        write_pass_records(self.root)
        fake_paid_sender()
        self.assertEqual(sent, ["PUT"])
        # Stale bytes immediately block a formerly approved episode.
        put(self.root / "episodes/01.txt", SOURCE_01 + "\n江屹：改了。")
        fake_paid_sender()
        self.assertEqual(sent, ["PUT"])

    def test_cli_accept_and_gate_exit_codes(self):
        self.manifest({"01": self.episode("01"), "02": self.episode("02")})
        (self.root / "shots_and_matches/ep02-source-map.json").unlink()
        script = Path(__file__).resolve().parents[2] / "skills" / "tweet-drama-core" / "scripts" / "episode_coverage.py"

        def command(*args):
            return subprocess.run([sys.executable, "-B", str(script), str(self.root), *args],
                                  capture_output=True, text=True, check=False)

        self.assertEqual(command("gate", "01").returncode, 1)
        accepted = command("accept", "01")
        self.assertEqual(accepted.returncode, 0, accepted.stderr + accepted.stdout)
        self.assertEqual(command("gate", "01").returncode, 0)
        self.assertEqual(command("gate", "02").returncode, 1)


if __name__ == "__main__":
    unittest.main()
