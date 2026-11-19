"""Cloud catalog, reference restrictions, atomic imports, and repeated migrations."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import DeclarativeBase, Session

from import_character_references import ingest

HERE = Path(__file__).resolve().parent


class Library(unittest.TestCase):
    def setUp(self):
        class Base(DeclarativeBase):
            pass
        self.db = create_engine("sqlite://")
        self.addCleanup(self.db.dispose)
        database = types.SimpleNamespace(Base=Base, get_session=lambda: Session(self.db))
        spec = importlib.util.spec_from_file_location("test_app.muse_references", HERE / "muse_references.py")
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"test_app.db": database}):
            spec.loader.exec_module(self.module)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.a = self.make_entry("a", "ancient", "发簪")
        self.b = self.make_entry("b", "urban", "蓝色西装")
        self.native = [{"asset_id": "prod", "kind": "character", "name": "hero"}]

    def make_entry(self, name, collection, tag):
        data = ("illustration " + name).encode()
        digest = hashlib.sha256(data).hexdigest()
        filename = digest + ".png"
        (self.source / filename).write_bytes(data)
        return dict(originalAssetId=name, catalogAssetId="character:muse-character-reference-qa:" + name,
                    file=filename, sha256=digest, bytes=len(data), collection=collection, format="flat",
                    metadataStatus="pending_review", category="character", setting=None, artStyle="3D", era=[],
                    gender="unknown", appearance=[], tags=[tag],
                    safety=dict.fromkeys(("canBind", "canReuse", "canPublish", "applyAllowed"), False))

    def put(self, *entries):
        (self.source / "manifest.json").write_text(json.dumps(dict(format=1, entries=entries)))
        return ingest(self.source, database=self.db, table=self.module.references, media=self.root / "media")

    def page(self, **options):
        def native(*, q, offset, limit, **other):
            rows = [r for r in self.native if not q or q in r["name"]]
            return dict(total=len(rows), items=rows[offset:offset + limit])
        default = dict(kind="character", q=None, mine=False, with_image=True, scope="all", sort="default",
                       limit=2, offset=0, importable_only=False)
        return self.module.shared_page(native, **(default | options))

    def test_verified_shared_rows_are_idempotent_and_searchable(self):
        self.assertEqual(self.put(self.a, self.b)["created"], 2)
        self.assertEqual(self.put(self.b, self.a)["created"], 0)
        self.assertEqual([v["asset_id"] for v in self.page()["items"]], ["prod", "mref-a"])
        self.assertEqual([v["asset_id"] for v in self.page(offset=2)["items"]], ["mref-b"])
        self.assertEqual(self.page(offset=3), {"total": 3, "items": []})
        self.assertEqual([v["asset_id"] for v in self.page(sort="least_used", offset=1)["items"]], ["mref-b", "prod"])
        for q in ("发簪", "古装", "ANCIENT"):
            result = self.page(q=q)["items"][0]
            self.assertTrue(result["reference_only"])
            self.assertFalse(result["reference"]["safety"]["canBind"])
            self.assertEqual(result["image_url"].split("/")[-1], self.a["file"])
        self.assertEqual(self.page(q="%")["total"], 0)
        self.assertEqual(self.page(kind="location")["total"], 1)
        self.assertEqual(self.page(mine=True)["total"], 1)
        self.assertEqual(self.page(importable_only=True)["total"], 1)
        self.assertEqual(self.page(scope="others")["total"], 3)

    def test_partial_corruption_and_conflicting_repeats_leave_existing_catalog_untouched(self):
        self.put(self.a)
        changed = self.a | {"tags": ["other"]}
        with self.assertRaisesRegex(ValueError, "has changed"):
            self.put(self.b, changed)
        (self.source / self.b["file"]).write_bytes(b"broken")
        with self.assertRaisesRegex(ValueError, "differs"):
            self.put(self.b)
        with self.db.connect() as db:
            self.assertEqual(db.scalars(select(self.module.references.c.name)).all(), ["a"])
