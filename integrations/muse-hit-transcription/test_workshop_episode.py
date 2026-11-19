"""Check which evidence from a native Muse delivery can enter a Workshop material catalog."""
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from common import digest
from workshop_episode import delivery_files


class Materials(unittest.TestCase):
    def test_catalog_uses_current_word_and_verified_sources_and_excludes_jobs(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            work = root / "episodes/0007"
            paths = ("scripts/0007.md", "final/current.docx", "qa/0007.json", "characters.json", "transcript/raw/asr.json",
                     "transcript/ocr/7.json", "transcript/raw/asr.srt", ".muse/video-observations/review.json",
                     "transcript/jobs/private.json", "final/older.docx")
            for name in paths:
                p = work / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(name)
            md, word, qa, cast, asr, ocr = paths[:6]
            checked = {"markdownSHA256": digest(work / md), "word": {"path": word, "sha256": digest(work / word), "recordedFrames": 4},
                       "qaSHA256": digest(work / qa), "charactersSHA256": digest(work / cast), "asr": asr,
                       "asrSHA256": digest(work / asr), "ocr": [ocr], "ocrSHA256": {ocr: digest(work / ocr)},
                       "sessionId": "original", "reviewId": "review", "ocrEndSeconds": 8}
            row = {"index": 7, "sha256": "source"}
            manifest = delivery_files(root, row, checked)
            self.assertEqual({f["kind"] for f in manifest["files"]},
                             {"screenplay", "word", "characters", "asr", "qa", "ocr", "subtitles", "visual-review"})
            self.assertFalse(any("private" in f["path"] or "older" in f["path"] for f in manifest["files"]))
            (work / ocr).write_text("stale")
            with self.assertRaises(ValueError):
                delivery_files(root, row, checked)
