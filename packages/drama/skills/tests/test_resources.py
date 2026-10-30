"""Offline package regression tests; no real project or provider access."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PACKAGE = Path(__file__).resolve().parents[1]
SKILLS = PACKAGE / "skills"
ASSETS = SKILLS / "tweet-drama-core" / "scripts" / "asset_library"
sys.path.insert(0, str(ASSETS))


def load(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Resources(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=PACKAGE / "tests")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {"HOME": str(self.root), "USERPROFILE": str(self.root)}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.network = patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden"))
        self.request = self.network.start()
        self.addCleanup(self.network.stop)

    def delivery(self):
        return load(SKILLS / "tweet-drama-delivery/scripts/assemble_delivery.py")

    def project(self):
        project = self.root / "project"
        cfg = project / "_probe/delivery-config"
        cfg.mkdir(parents=True)
        for rel, data in {
            "export/master.mp4": b"offline video fixture",
            "assets/lead_m.png": b"male fixture",
            "assets/lead_f.png": b"female fixture",
            "source/original/script.txt": b"script fixture",
            "_probe/delivery-config/简介.txt": "简介".encode(),
        }.items():
            path = project / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        for name, data in {
            "_confirmed_episodes.json": {"confirmed": [{"episode": 1}]},
            "confirmed-films.json": {"films": {"01": "export/master.mp4"}},
            "film-reviews.json": {"films": {"01": {
                "source": "export/master.mp4",
                "sha256": hashlib.sha256(b"offline video fixture").hexdigest(),
                "reviewed": True, "reviewed_at": "2026-10-30 12:00",
                "picture": "ok", "audio": "ok", "subtitle": "ok", "spec": "ok", "issues": [],
            }}},
            "主角.json": {"male": ["lead_m.png"], "female": ["lead_f.png"]},
        }.items():
            (cfg / name).write_text(json.dumps(data), encoding="utf-8")
        return project

    def assemble(self, module, project, out=None):
        argv = ["assemble_delivery.py", "--project", str(project), "--episode", "1"]
        if out is not None:
            argv += ["--out", str(out)]
        with patch.object(sys, "argv", argv), patch.object(module, "find_ffprobe", return_value=None), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return module.main()

    def test_default_template_needs_no_external_directory(self):
        module = self.delivery()
        project = self.project()
        self.assertTrue(module.TEMPLATE.is_relative_to(SKILLS), "default template must be bundled")
        self.assertEqual(self.assemble(module, project), 0)
        self.assertEqual(len(list((project / "delivery").iterdir())), 9)
        self.assertEqual((project / "delivery/00成片/01.mp4").read_bytes(), (project / "export/master.mp4").read_bytes())

    def test_explicit_missing_template_fails_before_writes(self):
        os.environ["TWEET_DRAMA_TEMPLATE"] = str(self.root / "absent")
        project = self.project()
        with self.assertRaises(SystemExit):
            self.assemble(self.delivery(), project)
        self.assertFalse((project / "delivery").exists())

    def test_output_overlap_refused_without_upstream_changes(self):
        os.environ["TWEET_DRAMA_TEMPLATE"] = str(self.root)
        project = self.project()
        original = {p.relative_to(project): p.read_bytes() for p in project.rglob("*") if p.is_file()}
        for out in (project, project.parent, project / "assets", project / "export/nested", project / "source"):
            with self.subTest(out=out), self.assertRaises(SystemExit):
                self.assemble(self.delivery(), project, out)
            self.assertEqual({p.relative_to(project): p.read_bytes() for p in project.rglob("*") if p.is_file()}, original)

    def test_output_cannot_contain_external_master(self):
        project = self.project()
        out = self.root / "external"
        master = out / "01主角/master.mp4"
        master.parent.mkdir(parents=True)
        master.write_bytes(b"upstream must survive")
        (project / "_probe/delivery-config/confirmed-films.json").write_text(json.dumps({"films": {"01": str(master)}}), encoding="utf-8")
        (project / "_probe/delivery-config/film-reviews.json").write_text(json.dumps({"films": {"01": {
            "source": str(master),
            "sha256": hashlib.sha256(master.read_bytes()).hexdigest(),
            "reviewed": True, "picture": "ok", "audio": "ok", "subtitle": "ok", "spec": "ok", "issues": [],
        }}}), encoding="utf-8")
        with self.assertRaises(SystemExit):
            self.assemble(self.delivery(), project, out)
        self.assertEqual(master.read_bytes(), b"upstream must survive")

    @unittest.skipUnless(os.name == "nt", "Windows junction")
    def test_real_junction_refused_without_python312_path_api(self):
        project = self.project()
        out = project / "delivery"
        out.mkdir()
        link = out / "01主角"
        subprocess.run([os.environ.get("COMSPEC", r"C:\Windows\System32\cmd.exe"), "/c", "mklink", "/J", str(link), str(project / "assets")], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        self.addCleanup(os.rmdir, link)
        before = {p.name: p.read_bytes() for p in (project / "assets").iterdir()}
        with patch.object(Path, "is_junction", None, create=True), self.assertRaises(SystemExit):
            self.assemble(self.delivery(), project, out)
        self.assertEqual({p.name: p.read_bytes() for p in (project / "assets").iterdir()}, before)

    def test_asset_roots_use_dsh_home_and_explicit_override(self):
        os.environ["DSH_HOME"] = str(self.root / "home")
        self.assertEqual(load(ASSETS / "search_assets.py").ROOT, self.root / "home/data/jubian-asset-library")
        os.environ["JUBIAN_ASSET_LIBRARY_ROOT"] = str(self.root / "override")
        self.assertEqual(load(ASSETS / "search_assets.py").ROOT, self.root / "override")

    def test_skill_resources_are_portable_and_reports_honest(self):
        delivery = (SKILLS / "tweet-drama-delivery/SKILL.md").read_text(encoding="utf-8")
        self.assertNotIn("aa-manju", delivery)
        self.assertNotIn("delivery-assembly.json", delivery)
        self.assertIn("stdout", delivery)


if __name__ == "__main__":
    unittest.main()
