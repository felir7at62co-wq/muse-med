"""Observe an active child during SIGTERM through the source dsh SDK profile."""
from __future__ import annotations

import os
from pathlib import Path
import runpy
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


@unittest.skipIf(os.name == "nt", "requires POSIX SIGTERM delivery to the owned runtime")
@unittest.skipUnless((ROOT / "node_modules/tsx/dist/esm/index.mjs").is_file(), "requires pnpm install")
class FactoryShutdownSnapshotTests(unittest.TestCase):
    def test_active_child_settles_before_projection_teardown(self) -> None:
        smoke = runpy.run_path(str(ROOT / "scripts/smoke-python-runtime.py"))
        smoke["smoke_sdk_shutdown_snapshot"](None, False)

    def test_host_skills_and_packaged_office_do_not_change_shutdown_oracles(self) -> None:
        smoke = runpy.run_path(str(ROOT / "scripts/smoke-python-runtime.py"))
        node = shutil.which("node")
        self.assertIsNotNone(node)
        with tempfile.TemporaryDirectory(prefix="dsh-shutdown-ambient-skills-") as temporary:
            root = Path(temporary).resolve()
            primary_runtime = root / "primary-runtime"
            bundled_node = primary_runtime / "dependencies/node/bin/node"
            bundled_node.parent.mkdir(parents=True)
            bundled_node.symlink_to(Path(node).resolve())
            shutil.copytree(ROOT / "packages/skill/skill-office/assets", root / "office-skills")
            agents_home = root / "agents"
            bundled_skills = root / "bundled-skills"
            for skill_root, name in ((agents_home / "skills", "host-shutdown-skill"),
                                     (bundled_skills, "bundled-shutdown-skill")):
                skill = skill_root / name / "SKILL.md"
                skill.parent.mkdir(parents=True)
                skill.write_text(f"---\nname: {name}\ndescription: Ambient shutdown fixture skill\n---\nFixture body.\n")
            smoke["smoke_sdk_shutdown_snapshot"](None, False, {
                "DSH_PRIMARY_RUNTIME": str(primary_runtime),
                "DSH_BUNDLED_PRIMARY_RUNTIME": str(primary_runtime),
                "DSH_BUNDLED_SKILL_DIR": str(bundled_skills),
                "DSH_AGENTS_HOME": str(agents_home),
            })
