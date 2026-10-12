"""Exercise archive verification with isolated resource lists and payload bytes."""
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest


class SkillArchive(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "tests").mkdir()
        shutil.copyfile(Path(__file__).with_name("verify_pack.py"), self.root / "tests/verify_pack.py")
        self.guide = "skills/shots/references/director-format.md"
        self.files = {"skills/shots/SKILL.md": b"# Shots\n", self.guide: b"# Director guide\n"}
        for name, data in self.files.items():
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        tests = self.root / "skills/shots/tests/test_local.py"
        tests.parent.mkdir()
        tests.write_text("# Source-only test\n", encoding="utf-8")

    def verify(self, listed=None, omitted=None, stale=None):
        manifest = json.dumps({"name": "fixture-skills", "files": listed or list(self.files)}).encode()
        (self.root / "package.json").write_bytes(manifest)
        payloads = {"package.json": manifest, **self.files}
        if "skills/shots/tests/test_local.py" in json.loads(manifest)["files"]:
            payloads["skills/shots/tests/test_local.py"] = b"# Source-only test\n"
        archive = self.root / "skills.tgz"
        with tarfile.open(archive, "w:gz") as packed:
            for name in ["package.json", *json.loads(manifest)["files"]]:
                if name == omitted:
                    continue
                data = b"stale" if name == stale else payloads[name]
                member = tarfile.TarInfo("package/" + name)
                member.size = len(data)
                packed.addfile(member, io.BytesIO(data))
        return subprocess.run([sys.executable, str(self.root / "tests/verify_pack.py"), str(archive)],
                              capture_output=True, text=True, check=False)

    def test_ships_guides_and_keeps_nested_tests_in_source(self):
        self.assertEqual(self.verify().returncode, 0)

    def test_rejects_an_unlisted_production_guide(self):
        result = self.verify(listed=["skills/shots/SKILL.md"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unlisted skill files", result.stderr)
        self.assertIn(self.guide, result.stderr)

    def test_rejects_an_archive_missing_a_listed_guide(self):
        result = self.verify(omitted=self.guide)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("archive differs from exact allowlist", result.stderr)

    def test_rejects_a_stale_guide(self):
        result = self.verify(stale=self.guide)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("stale archive member", result.stderr)

    def test_rejects_tests_added_to_the_distribution(self):
        result = self.verify(listed=[*self.files, "skills/shots/tests/test_local.py"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("listed but absent", result.stderr)


if __name__ == "__main__":
    unittest.main()
