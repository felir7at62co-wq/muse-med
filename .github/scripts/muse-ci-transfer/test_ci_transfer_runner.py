"""Check that a TOS HEAD cannot acknowledge a different ZIP or source."""

import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

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
            with patch.object(runner, "aws", provider), patch.object(runner, "configure_aws"):
                runner.preflight()
        finally:
            self.assertEqual(deleted, [runner.PREFIX + "/_runner-connectivity-probe.txt"])

    def test_probe_checks_readback_and_cleans_up(self):
        self.invoke()

    def test_probe_rejects_wrong_readback_and_still_cleans_up(self):
        with self.assertRaises(transfer.ProtocolError):
            self.invoke(corrupt=True)


class AddressingTests(unittest.TestCase):
    def test_configures_and_observes_virtual_style(self):
        calls = []

        def command(arguments, **options):
            calls.append(arguments)
            return SimpleNamespace(returncode=0, stdout="virtual\n")

        with patch.object(runner.shutil, "which", return_value="aws"), patch.object(runner.subprocess, "run", command):
            runner.configure_aws()
        self.assertEqual(calls[0], ["aws", "configure", "set", "default.s3.addressing_style", "virtual"])
        self.assertEqual(calls[-1], ["aws", "configure", "get", "default.s3.addressing_style"])

    def test_rejects_path_style_after_configuration(self):
        with patch.object(runner.shutil, "which", return_value="aws"), patch.object(runner.subprocess, "run",
                return_value=SimpleNamespace(returncode=0, stdout="path\n")):
            with self.assertRaises(transfer.ProtocolError):
                runner.configure_aws()


class SourceTests(unittest.TestCase):
    def test_accepts_only_explicit_configured_source(self):
        self.assertEqual(runner.require_source(runner.SOURCE), runner.SOURCE)

    def test_rejects_missing_and_incomplete_source(self):
        for value in (None, "", "branch-name", "0" * 39):
            with self.subTest(value=value), self.assertRaises(transfer.ProtocolError):
                runner.require_source(value)

    def identity(self, different_head=False):
        def factory(repository, artifact_id, *args):
            artifact = next(value for value in runner.ARTIFACTS if value["id"] == artifact_id)
            metadata = {"id": artifact_id, "expired": False, "size_in_bytes": artifact["size"],
                        "digest": "sha256:" + artifact["sha256"], "workflow_run": {
                            "head_sha": "0" * 40 if different_head else runner.SOURCE,
                            "id": 37567499544, "repository_id": 1365170863,
                            "head_repository_id": 1365170863}}
            return SimpleNamespace(metadata=lambda: metadata)

        with patch.object(transfer, "GitHubArchive", factory):
            runner.identity()

    def test_binds_source_to_both_fixed_artifacts(self):
        self.identity()

    def test_rejects_a_different_fixed_artifact_head(self):
        with self.assertRaises(transfer.ProtocolError):
            self.identity(different_head=True)


if __name__ == "__main__":
    unittest.main()
