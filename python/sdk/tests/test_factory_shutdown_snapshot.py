"""Observe an active child during SIGTERM through the source dsh SDK profile."""
from __future__ import annotations

import os
from pathlib import Path
import runpy
import unittest

ROOT = Path(__file__).resolve().parents[3]


@unittest.skipIf(os.name == "nt", "requires POSIX SIGTERM delivery to the owned runtime")
@unittest.skipUnless((ROOT / "node_modules/tsx/dist/esm/index.mjs").is_file(), "requires pnpm install")
class FactoryShutdownSnapshotTests(unittest.TestCase):
    def test_active_child_settles_before_projection_teardown(self) -> None:
        smoke = runpy.run_path(str(ROOT / "scripts/smoke-python-runtime.py"))
        smoke["smoke_sdk_shutdown_snapshot"](None, False)
