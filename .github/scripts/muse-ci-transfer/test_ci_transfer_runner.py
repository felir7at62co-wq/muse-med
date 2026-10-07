"""Check that a TOS HEAD cannot acknowledge a different ZIP or source."""

import unittest

import ci_transfer_runner as runner
import artifact_range_download as transfer


class HeadTests(unittest.TestCase):
    def head(self):
        artifact = runner.ARTIFACTS[0]
        return {"ContentLength": artifact["size"], "Metadata": {
            "sha256": artifact["sha256"], "artifact-id": str(artifact["id"]),
            "source-commit": runner.SOURCE}}

    def test_accepts_the_selected_zip(self):
        runner.validate_head(self.head(), runner.ARTIFACTS[0])

    def test_rejects_a_different_stored_size(self):
        head = self.head()
        head["ContentLength"] -= 1
        with self.assertRaises(transfer.ProtocolError):
            runner.validate_head(head, runner.ARTIFACTS[0])

    def test_rejects_a_different_stored_hash(self):
        head = self.head()
        head["Metadata"]["sha256"] = "0" * 64
        with self.assertRaises(transfer.ProtocolError):
            runner.validate_head(head, runner.ARTIFACTS[0])

    def test_rejects_a_different_source_commit(self):
        head = self.head()
        head["Metadata"]["source-commit"] = "0" * 40
        with self.assertRaises(transfer.ProtocolError):
            runner.validate_head(head, runner.ARTIFACTS[0])


if __name__ == "__main__":
    unittest.main()
