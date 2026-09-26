# Agent Note: Re-review the pinned community plugins for every Host version bump

Status: implemented

English | [中文](2026-09-26-community-plugin-host-version-review.zh.md)

## Problem

[`build.mjs`](../../../../third_party/plugins/build.mjs) refuses to compile the five pinned community plugins while the checkout's Host version differs from the version its overlays were reviewed against, and it exposes no override. The `release(dsh): 0.1.6-alpha.2` bump moved all 305 manifests off the reviewed version, so step S6 of `pnpm run package:desktop:win:x64:unsigned` stopped with `community plugins: host 0.1.6-alpha.2 needs a new compatibility review` and produced no installer. The refusal is correct — the overlays write the Host version into a Codex runtime allowlist, into peer alternatives, and into `SOURCE.json` — but nothing in the repository said what a review covers, so the release could neither continue nor show that the plugins work against `0.1.6-alpha.2`.

## Decision

The gate names `0.1.6-alpha.2` as the reviewed version, and the reviewed version is stated once per artifact it reaches: the gate in [`build.mjs`](../../../../third_party/plugins/build.mjs), `approvedVersion` and the obsolete-version list in [`checks/codex-subagent.mjs`](../../../../third_party/plugins/checks/codex-subagent.mjs), the peer suffix and overlay expectations in [`build.test.mjs`](../../../../third_party/plugins/build.test.mjs), and the version statements in [`README.md`](../../../../third_party/plugins/README.md) (with its `README.zh.md` pair) and [`dsh-ponytail/README.md`](../../../../third_party/plugins/dsh-ponytail/README.md). No upstream pin changes: [`sources.json`](../../../../third_party/plugins/sources.json), [`upstream.json`](../../../../third_party/plugins/upstream.json) (whose `pinnedVersion` is the upstream merge base, not a product version), and the upstream-retained `compatibility.json`, which already listed `0.1.6-alpha.2` as a preview, stay as they are. [`build.test.mjs`](../../../../third_party/plugins/build.test.mjs) also gains the two requirements its own reproducibility comparison turned out to need: equal directory depth for the two builds, and a digest-first byte comparison.

Every future Host version bump repeats the same review before packaging, and a failing check stops the release instead of relaxing the expectation. The gate stays a hard equality check, so a bump cannot ship plugins whose overlays were never compiled against that Host.

## The review that accepted 0.1.6-alpha.2

Each pinned plugin was built alone through `node third_party/plugins/build.mjs --only <name> --out <dir>`: `dshmarket`, `dsh-ponytail`, `dsh-lark-bridge` and `dsh-ffmpeg` exited 0 unchanged; `dsh-codex-subscription` first exited 1 on exactly three assertions, all of them owned by `approvedVersion` (the `inspectSubagentRuntime` rejection list, the fixture manifest version, and the asserted preparation target), which is the constant the review exists to move.

The staged Codex runtime then ran its copied check plus three retained upstream suites — 32 tests including the 26 upstream checks and the 6 authenticated-transport and CLI checks — and the FFmpeg source ran its 89 retained checks.

### The reproducibility comparison failed on its own directory layout

[`build.test.mjs`](../../../../third_party/plugins/build.test.mjs) repeats all five builds and compares each pair of tarballs byte for byte. That comparison failed, and the failure was **not** plugin incompatibility: the test built the second copy into `<first output>/repeat`, one directory level deeper than the first. `build.mjs` stages every build in a `.source-build-*` directory created *inside* `--out` and links the toolchain into it with junctions, and rolldown records each source file's path in a `//#region` comment relative to the emitted file; resolving through those junctions makes that recorded path relative to the staging directory, so the deeper `--out` added one `../` to every comment. Under that layout no two builds can ever be byte-identical, for this Host version or any other. Rebuilding into two sibling `mkdtempSync` directories — equal depth — reproduced byte-identical tarballs for all five plugins, three times over.

### The failing assertion buried its own cause

The review's first reported error was `RangeError: Array buffer allocation failed` rather than a byte difference, because `assert.deepEqual` on two ~295 KB Buffers renders a full diff when they differ and allocating that diff is what failed first; the FFmpeg case then died as `status=null (3221226505)` on the same exhausted heap. The comparison now hashes before it renders: it compares length, then SHA-256, and prints both digests in the failure message. A failing assertion is itself a reporting mechanism, and this one reported an allocation error instead of the defect it had caught; a comparison over large artifacts must state its finding in a form the reporter can afford to produce.

## Testing

`node --test third_party/plugins/build.test.mjs` is the whole review for the five pinned sources; the gate plus the Codex and FFmpeg check counts are its pass criteria, and it must exit 0 before packaging resumes. The helper reads `npm_execpath`, so run it from a pnpm lifecycle script or set that variable to pnpm's entry file — `pnpm exec` alone does not export it, and every child build then fails with `invoke through pnpm exec node third_party/plugins/build.mjs` before any check runs. Both a real failure and a broken harness end as a non-zero exit, so a red run has to be diagnosed before the plugins are blamed: here the plugins compiled and passed every retained check while the comparison that reads their output was itself unusable.

## Alternatives considered

**Let an environment variable override the expected version.** The release could then pass the gate without a single plugin check running, and the tree would record nothing about which version was reviewed. The reviewed version has to be a reviewable change, not a release-time setting.

**Accept any `0.1.6-alpha.*` Host version.** The overlay pins `SUBAGENT_RUNTIME_VERSION` and `SUPPORTED_RUNTIME_VERSIONS` to the Host version it was compiled against, so a neighbouring version is exactly the case the equality check exists to reject.

**Derive the approved version from the Host version inside the check.** The check would compare the staged runtime against itself and could never report that a Host is unsupported, which is the one failure the Codex plugin's own allowlist depends on.

**Bump the constant and skip re-running the plugin checks.** Compilation and the retained suites are the only evidence that the overlays still apply to unchanged upstream text; the gate would then assert a review that never happened.

**Loosen the gate to a warning.** Packaging would silently ship an unreviewed runtime allowlist, and the failure would surface only after a user installed the result.

**Keep the nested output directory and compare tarball contents instead of bytes.** Unpacking and comparing entry listings would pass under either layout, but it would stop proving that the build is reproducible, which is the property the comparison exists for; the layout was the defect, not the byte comparison. Equal-depth siblings keep the original assertion and its strength.

**Keep `assert.deepEqual` and only raise the heap limit.** The assertion would then report a diff for a 295 KB pair only when it had enough memory to do so, which makes the diagnostic depend on the machine — and it was the exhaustion itself, not the limit, that replaced the byte difference with an allocation error.

## Consequences

A Host version bump is now a code change that blocks packaging until the whole review passes, which is the intended cost: the alternative is an installer carrying a plugin/runtime combination nobody compiled. The next bump — for example after the upstream `0.1.7-rc.2` merge lands — repeats this procedure, reruns `node --test third_party/plugins/build.test.mjs` against the new Host, and rewrites the same five places.

The review proves the pinned sources still compile and pass their retained checks against this Host, and that two clean builds of them are byte-identical. It does not prove that a plugin activates in a packaged Desktop profile; that remains the packaging smoke's and the installed-application's job, as the [source-snapshot proposal](../../../proposed/process/2026-09-23-muse-med-community-plugin-source.md) records.
