# Verified Muse artifact transfer and readback

English | [中文](README.zh.md)

## Summary

The manual [transfer workflow](../../../.github/workflows/muse-desktop.yml) supplements two approved draft releases with existing Windows EXE and Mac ARM DMG/ZIP files, then reads every remote byte in both releases. A separate public operation reads the same eleven files after publication. It does not build, install, publish, delete, replace assets, or access TOS.

## Table of Contents

- [Operator seal](#operator-seal)
- [Draft transfer](#draft-transfer)
- [Complete readback](#complete-readback)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="operator-seal"></a>

## Operator seal

The operator supplies `seal.json` beside this README after final source CI, both actual installer checks, and local publication staging pass. The seal contains only `schemaVersion: 1`, public `repository`, stable `version`, complete `sourceCommit`, positive `sourceRun`, two `releases`, and eleven `files`. Each release contains its positive numeric `id`, exact `tag`, and `prerelease` flag. Stable precedes RC compatibility. Each file contains only `filename`, byte `size`, and lowercase `sha256`. Strict field checks reject private paths, credentials and receipt contents. A missing seal prevents execution.

Repository-reference checks permit only the unique lowercase 40-digit `sourceCommit` declaration in this valid JSON input. Other commit references, malformed inputs, different paths and organization URLs remain rejected.

The eleven identities come from the verified final publication inventory. The operator preloads the eight small assets into both drafts, including Mac ZIP-first metadata with its same-batch ARM DMG. Both stable and RC tags point to the approved source. The source run must be a completed successful manual build on `main`, with exactly two successful native jobs and actual installation acceptance. Original artifacts must belong to that run and source and remain unexpired.

<a id="draft-transfer"></a>

## Draft transfer

Manually dispatch `codex/muse-release-artifact-transfer-105` with `operation=transfer`. Only this branch and repository can execute it. The workflow downloads the two original artifacts and two real installation receipts. Its small owner package locks `builder-util-runtime` and `semver` to the updater's versions, with registry integrity checks and lifecycle scripts disabled. It installs no repository workspace dependencies. The workflow token remains in memory; explicit release IDs avoid draft lookups by tag returning 404.

Both original `unsigned-build.json` files, every original artifact byte and both native acceptance receipts must match the source and version. Counts and SHA256/SHA512 match the records; five binaries also match the seal. Each receipt passes complete installed-file comparison, runtime checks and the native installer operation, and its installer SHA256 matches the exact EXE or DMG. The optional `builder-debug.yml` packaging diagnostic must be a regular file; it is not read, recorded, sealed or published. Diagnostic directories, symbolic links and every other extra filename are rejected.

Before and after each upload, both tags, draft IDs, visibility, prerelease flags, existing sizes and digests are checked. Missing or mismatched small assets, unexpected assets and incomplete uploads stop transfer. Matching binaries are skipped. Only absent EXE, DMG and ZIP files upload, without `--clobber`. Completion requires eleven assets in each draft, followed by complete remote byte readback. Keep both releases private throughout; GitHub offers no atomic draft condition on upload, so an external state change fails the next check.

<a id="complete-readback"></a>

## Complete readback

Draft readback streams all eleven assets from each approved release and compares exact byte counts and SHA256. The authenticated first request uses the fixed GitHub asset API; redirects are manual and never receive the token. Only HTTPS downloads on the two GitHub asset CDN hosts or the exact public asset address are accepted. Redirect count, stream size and time are bounded. HTTP failures, truncated or oversized bodies and digest mismatches fail.

Manually dispatch `operation=public-readback` after the operator publishes both releases. This operation downloads no original build artifacts and calls no upload method. All asset downloads are anonymous. It verifies both exact tag commits, public IDs, prerelease flags and eleven assets, GitHub Latest selecting the stable release, and the Atom feed selecting either current app entry from the same source. Atom uses the actual updater XML parser. It also follows the legacy `rc` channel's selection: stable, alpha and beta entries are skipped, and the first valid rc tag must be the sealed compatibility release. A current stable first entry cannot hide an older rc later in the feed.

Both modes check release metadata and asset IDs before and after each streamed file. Only download counters may change as a result of reading; other changes fail. Public discovery is checked again at completion. Safe JSON receipts contain source, release IDs, names, sizes, digests and asset IDs; no credential, signed URL or private path is recorded. The workflow retains a successful receipt or a minimal failure receipt as an Actions artifact. Readback success never publishes the release; the operator owns TOS verification and publication.

<a id="verification"></a>

## Verification

Install only the owner package with `npm ci --prefix scripts/owner/muse-release-artifact-transfer --ignore-scripts --no-audit --no-fund`, then run `node --test scripts/owner/muse-release-artifact-transfer/*.test.mjs`. Owner tests use temporary directories, injected GitHub adapters and mocked streamed responses. They acquire no network listeners and invoke no GitHub service. Fixtures cover original bytes and receipt binding, matching skips, complete transfer, source and visibility changes, redirects, private credential containment, stream limits, digests and public discovery.

The Actions entry refuses local execution, other repositories, nonmanual events and other branches. Help is available with `node scripts/owner/muse-release-artifact-transfer/run.mjs --help`. Final runner execution requires the approved seal. Readback receipts remain in the runner temporary directory and use exclusive creation to preserve existing records.

<a id="dev-note"></a>

## Dev Note

None.
