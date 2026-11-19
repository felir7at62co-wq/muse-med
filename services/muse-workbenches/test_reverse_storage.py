"""Exercise private TOS publication, retries, and integrity without a provider account."""
import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

from tos.exceptions import TosServerError

from reverse_storage import file_sha, publish, storage_prefix


class Store:
    def __init__(self):
        self.items = {}
        self.writes = []
        self.fail = set()

    def head_object(self, bucket, key):
        if key not in self.items:
            response = SimpleNamespace(request_id="test", headers={}, status=404)
            raise TosServerError(response, "missing", "NoSuchKey", "", key)
        raw, sha = self.items[key]
        return SimpleNamespace(content_length=len(raw), meta={"sha256": sha})

    def put_object(self, bucket, key, *, content, **opts):
        if key in self.fail:
            raise OSError("interrupted upload")
        if not opts["forbid_overwrite"] or key in self.items:
            raise AssertionError("duplicate write")
        sha = hashlib.sha256(content).hexdigest()
        if opts["content_sha256"] != sha:
            raise ValueError("bad payload hash")
        self.items[key] = content, sha
        self.writes.append(key)

    def put_object_from_file(self, bucket, key, path, **opts):
        self.put_object(bucket, key, content=Path(path).read_bytes(), **opts)


class Archive(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.store = Store()
        self.target = self.store, "test", "reverse/prod/"
        self.identity = "7/16/2/initial"
        self.manifest = {"sessionId": "one", "files": []}
        for name in ("screenplay", "qa"):
            f = self.root / (name + ".txt")
            f.write_text(name)
            self.manifest["files"].append({"kind": name, "path": f.name, "sha256": file_sha(f), "bytes": f.stat().st_size})

    def test_incomplete_set_is_invisible_and_retry_writes_only_missing_files(self):
        key = "reverse/prod/" + self.identity
        self.store.fail.add(key + "/qa/" + self.manifest["files"][1]["sha256"] + ".txt")
        with self.assertRaises(OSError):
            publish(self.root, self.manifest, self.identity, self.target)
        self.assertNotIn(key + "/manifest.json", self.store.items)
        self.store.fail.clear()
        final = publish(self.root, self.manifest, self.identity, self.target)
        self.assertEqual(self.store.writes[-1], final["manifestKey"])
        self.assertEqual(publish(self.root, self.manifest, self.identity, self.target), final)
        self.assertEqual(len(self.store.writes), 3)
        self.store.items[self.store.writes[0]] = b"tampered", "wrong"
        with self.assertRaises(ValueError):
            publish(self.root, self.manifest, self.identity, self.target)

    def test_local_catalog_has_no_download_secret_and_rejects_changed_evidence(self):
        catalog = publish(self.root, self.manifest, self.identity)
        self.assertNotIn("bucket", catalog)
        self.assertNotIn("path", catalog["files"][0])
        (self.root / "qa.txt").write_text("changed")
        with self.assertRaises(ValueError):
            publish(self.root, self.manifest, self.identity)

    def test_archive_prefix_and_file_cannot_escape_its_namespace(self):
        for prefix in ("", "/", "reverse/../prod", "/reverse", "reverse//prod"):
            with self.subTest(prefix=prefix), self.assertRaises(ValueError):
                storage_prefix(prefix)
        link = self.root / "alias"
        link.symlink_to(self.root / "screenplay.txt")
        self.manifest["files"][0]["path"] = "alias"
        with self.assertRaises(ValueError):
            publish(self.root, self.manifest, self.identity)
