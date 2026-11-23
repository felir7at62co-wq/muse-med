"""Delivery checks over native manuscript_revision results."""

from hashlib import sha256
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from zipfile import ZipFile

from verification import DeliveryRejected, verify_delivery

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
BODY = ["第7集", "▲院子里，两人对坐。"]


def word(lines):
    paragraphs = "".join(f"<w:p><w:r><w:t>{line}</w:t></w:r></w:p>" for line in lines)
    data = BytesIO()
    with ZipFile(data, "w") as archive:
        archive.writestr("word/document.xml", f'<w:document xmlns:w="{W}"><w:body>{paragraphs}</w:body></w:document>')
    return data.getvalue()


def frames(state="complete", count=321, recorded=321):
    row = {"episode": 7, "frames": state, "frame_count": count, "recorded": recorded, "format_errors": 0}
    return {"episodes": [row], "format_error_count": 0, "warnings": []}


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.folder = TemporaryDirectory()
        self.workspace = Path(self.folder.name).resolve()
        for name in ("scripts", "final", "transcript"):
            (self.workspace / name).mkdir()
        markdown = ("\n".join(BODY) + "\n").encode()
        (self.workspace / "scripts/0007.md").write_bytes(markdown)
        (self.workspace / "transcript/asr.json").write_bytes(b"{}")
        self.binding = {"sessionId": "session-1", "workspace": str(self.workspace), "provider": "p", "model": "m",
                        "promptSha256": "a", "extraPatchSha256": "b"}
        self.results = [{"tool": "manuscript_revision", "method": "transcript_coverage", "result": {
            "state": "transcript_coverage", "episodes": [{
                "draft": {"path": str(self.workspace / "scripts/0007.md"), "file_sha256": sha256(markdown).hexdigest()},
                "asr": {"path": str(self.workspace / "transcript/asr.json"), "sha256": sha256(b"{}").hexdigest()}}]}}]

    def tearDown(self):
        self.folder.cleanup()

    def deliver(self, name, lines, check):
        data = word(lines)
        (self.workspace / "final" / name).write_bytes(data)
        self.results.append({"tool": "manuscript_revision", "method": "delivery", "result": {
            "state": "delivery", "source_mode": "video", "files": [{
                "path": str(self.workspace / "final" / name), "file_sha256": sha256(data).hexdigest(),
                "video_check": check}]}})

    def verify(self):
        return verify_delivery(self.workspace, 7, self.binding, {**self.binding, "finishReason": "completed"},
                               self.results)

    def test_the_latest_of_several_passing_words_is_delivered(self):
        self.deliver("v2.docx", BODY, frames())
        self.deliver("v3.docx", BODY, frames())
        result = self.verify()
        self.assertEqual(result["word"]["path"], "final/v3.docx")
        self.assertEqual([item["path"] for item in result["rejected"]], ["final/v2.docx"])
        self.deliver("v2.docx", BODY, frames())
        self.assertEqual(self.verify()["word"]["path"], "final/v2.docx")

    def test_an_incomplete_frame_review_is_named(self):
        self.deliver("v1.docx", BODY, frames("incomplete", 729, 296))
        with self.assertRaisesRegex(DeliveryRejected, r"found 0: frame review incomplete \(296/729 recorded\)"):
            self.verify()

    def test_a_word_with_an_old_body_does_not_pass(self):
        self.deliver("v1.docx", BODY[:1], frames())
        with self.assertRaisesRegex(DeliveryRejected, "Word body differs"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
