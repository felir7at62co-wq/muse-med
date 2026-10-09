# Verified Muse draft artifact transfer

English | [中文](README.zh.md)

## Summary

The manual [transfer workflow](../../../.github/workflows/muse-desktop.yml) supplements two approved draft releases with existing Windows EXE and Mac ARM DMG/ZIP files. It downloads the successful native build and actual installation receipts. It checks the complete original bytes before any upload. It does not build, install, publish, delete, replace assets, or access TOS.

## Table of Contents

- [Operator seal](#operator-seal)
- [Draft transfer](#draft-transfer)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="operator-seal"></a>

## Operator seal

The operator supplies `seal.json` beside this README after final source CI, both actual installer checks, and local publication staging pass. The seal contains only `schemaVersion: 1`, the public `repository`, stable `version`, complete `sourceCommit`, positive `sourceRun`, two `releases`, and eleven `files`. Each release contains its positive numeric `id`, exact `tag`, and `prerelease` flag. Stable precedes the RC compatibility release. Each file contains only `filename`, byte `size`, and lowercase `sha256`. Private staging paths, credentials and receipt contents are rejected by the strict field checks. This branch has no default seal; a missing seal prevents transfer.

The eleven file identities come from the verified final publication inventory. The operator preloads the eight small assets into both drafts, including the current Mac update metadata. The operator sets both stable and RC tags to the approved source. The source run must be a completed successful manual build on `main`, with exactly two successful native jobs and actual installation acceptance. Original artifacts must belong to that run and source and remain unexpired.

<a id="draft-transfer"></a>

## Draft transfer

The workflow runs only through manual dispatch of `codex/muse-release-artifact-transfer-105`. It uses Node builtins, GitHub CLI and the artifact download action; it installs no repository dependencies. The workflow token remains in memory. Metadata requests use explicit release IDs because a draft lookup by tag can return 404. No credential is printed or written to a file.

Both original `unsigned-build.json` files, every listed original artifact byte and both native acceptance receipts must match the approved source and version. Binary byte counts and SHA256/SHA512 must match their original records; the five binary files also match the public seal. Each receipt must pass the complete installed-file comparison, installed runtime checks and native installer operation, and its installer SHA256 must match the exact EXE or DMG.

Before and after every single-file upload, the helper verifies both tags and draft release IDs, visibility, prerelease flags, existing asset byte counts and digests. Missing or mismatched small assets, unexpected assets, and partially uploaded assets stop transfer. Matching large assets are skipped. The helper uploads only absent EXE, DMG and ZIP files, without `--clobber`. Completion requires exactly eleven matching assets in each draft. Operators must keep both releases private during transfer; GitHub does not offer an atomic draft condition on asset upload. A changed release fails the next identity check.

The release operator owns the subsequent complete remote byte readback and publication. A transfer success verifies GitHub asset metadata and preserves draft visibility; it does not authorize or perform public release. After a connection failure, rerun the workflow only after checking the current drafts. A fully matching uploaded asset is skipped, and any mismatch remains a failure.

<a id="verification"></a>

## Verification

Run `node --test scripts/owner/muse-release-artifact-transfer/*.test.mjs` from the checkout. Owner tests use private temporary directories and injected GitHub adapters. They do not invoke GitHub, consume credentials or acquire network listeners. Test fixtures cover source/run/job/artifact ownership, release visibility and tags, original file hashes and actual receipt binding, matching asset skips and complete two-draft transfer.

The Actions entry refuses local execution, other repositories, nonmanual events and other branches. Its command help is available with `node scripts/owner/muse-release-artifact-transfer/run.mjs --help`. Final runner execution remains an operator verification after the approved seal is supplied.

<a id="dev-note"></a>

## Dev Note

None.
