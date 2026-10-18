# Muse 1.1.6 transport only

This auxiliary branch transfers the existing accepted build from source `0064a968241e80645892ee7268167cc7f4a7cd4c`, Actions run `39141984760`. It does not build Muse, update main, change tags or publish either release. The original manifest and seal are included byte for byte; local directory strings in the manifest are ignored by the runner.

The runner verifies all four Actions ZIP digests and both native installer reports. Its three large binaries come from those CI artifacts; its nine small public files come from the already verified stable draft. Every public file must match the sealed size, SHA256 and SHA512 before transfer. GitHub operations preserve matching assets, record and clean only failed no-digest starters, and verify both unpublished drafts contain the same twelve files. Upload failures are reconciled without blind POST retries.

Only `GITHUB_TOKEN` is used for repository transport. The scoped TOS plan enters the separate helper through `MUSE_RELEASE_116_TOS_PLAN`; no original signing key is available to this workflow. Signed URLs, authentication and environment contents must not enter logs or artifacts. Only sanitized receipts are retained. The publication owner must review the receipt and separately publish the two drafts after all verification succeeds.

Run the offline Python tests with `python3 -B -m unittest discover -s .github/muse-release-116 -p test_transport.py`. Run the adjacent Node capability tests before dispatch. This workflow is manual and restricted to the auxiliary branch; do not merge it into main.
