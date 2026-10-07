"""Check that a TOS HEAD cannot acknowledge a different ZIP or source."""

import unittest
from pathlib import Path
from unittest.mock import patch

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


class PreflightTests(unittest.TestCase):
    def invoke(self, corrupt=False):
        payload = None
        deleted = []

        def provider(arguments):
            nonlocal payload
            action = arguments[1]
            if action == "put-object":
                payload = Path(arguments[arguments.index("--body") + 1]).read_bytes()
                return {}
            if action == "get-object":
                Path(arguments[-1]).write_bytes(b"x" * len(payload) if corrupt else payload)
                return {}
            if action == "head-object":
                return {"ContentLength": len(payload)}
            if action == "delete-object":
                deleted.append(arguments[arguments.index("--key") + 1])
                return {}
            self.fail("Unexpected AWS operation")

        try:
            with patch.object(runner, "aws", provider), patch.object(runner.shutil, "which", return_value="aws"):
                runner.preflight()
        finally:
            self.assertEqual(deleted, [runner.PREFIX + "/_runner-connectivity-probe.txt"])

    def test_probe_checks_readback_and_cleans_up(self):
        self.invoke()

    def test_probe_rejects_wrong_readback_and_still_cleans_up(self):
        with self.assertRaises(transfer.ProtocolError):
            self.invoke(corrupt=True)


if __name__ == "__main__":
    unittest.main()
