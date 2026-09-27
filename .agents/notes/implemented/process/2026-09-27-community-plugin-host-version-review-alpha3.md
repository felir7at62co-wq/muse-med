# Agent Note: Accept 0.1.6-alpha.3 for the pinned community plugins

Status: implemented

English | [中文](2026-09-27-community-plugin-host-version-review-alpha3.zh.md)

## Problem

`release(dsh): 0.1.6-alpha.3` moved all 305 manifests off the Host version the community plugin overlays were reviewed against, so [`build.mjs`](../../../../third_party/plugins/build.mjs) stopped step S6 of `pnpm run package:desktop:win:x64:unsigned` with `community plugins: host 0.1.6-alpha.3 needs a new compatibility review`, and the run produced no installer. That stop is the mechanism [the alpha.2 review](2026-09-26-community-plugin-host-version-review.md) designed: the gate has no override, and the reviewed version is written once per artifact the overlays reach. Packaging could not resume until the five pinned sources had been reviewed against `0.1.6-alpha.3`.

## Decision

`0.1.6-alpha.3` is the reviewed version, stated in the same five places the alpha.2 round established: the gate in [`build.mjs`](../../../../third_party/plugins/build.mjs), `approvedVersion` and the obsolete-version list in [`checks/codex-subagent.mjs`](../../../../third_party/plugins/checks/codex-subagent.mjs), the peer suffix and overlay expectations in [`build.test.mjs`](../../../../third_party/plugins/build.test.mjs), and the version statements in [`README.md`](../../../../third_party/plugins/README.md) with its `README.zh.md` pair and in [`dsh-ponytail/README.md`](../../../../third_party/plugins/dsh-ponytail/README.md). The obsolete-version list gains `0.1.6-alpha.2` and keeps `0.1.6-alpha.1`; it names versions the staged runtime must reject, so the approved version cannot appear in it. No upstream pin changes: [`sources.json`](../../../../third_party/plugins/sources.json), [`upstream.json`](../../../../upstream.json) (whose `pinnedVersion` is the upstream merge base, not a product version), and the upstream-retained `compatibility.json` stay as they are.

## The review that accepted 0.1.6-alpha.3

The gate is one of the five places and it rejects the build before any check runs, so the review begins by moving it. With the gate alone moved, `node --test third_party/plugins/build.test.mjs` exited 1 on one source and two assertions: the copied Codex check still expected `0.1.6-alpha.2` from a staged runtime that now reports `0.1.6-alpha.3`, so `reads the unpacked CLI manifest before composing its physical wrapper path` failed with `Codex subtask runtime is not prepared`, and `runtime preparation targets the same exact approved product provider` failed with `actual '0.1.6-alpha.3'` against `expected '0.1.6-alpha.2'`. Both assertions are owned by `approvedVersion`. No overlay failed on upstream source text, and no other source failed.

With the remaining four places moved, the same command exited 0: three tests passed, the staged Codex runtime passed all 32 checks (26 retained upstream plus 6 authenticated-transport and CLI checks), and the FFmpeg source passed all 89. Each source then built alone through

```sh
pnpm exec node third_party/plugins/build.mjs --only <name> --out <dir>
```

`dshmarket`, `dsh-codex-subscription`, `dsh-ponytail`, `dsh-lark-bridge` and `dsh-ffmpeg` each exited 0, and the reproducibility comparison inside `build.test.mjs` reproduced all five tarballs byte for byte from two same-depth staging directories.

## Testing

`node --test third_party/plugins/build.test.mjs` is the whole review, and it must exit 0 before packaging resumes; the gate plus the Codex and FFmpeg check counts are its pass criteria. It reads `npm_execpath`, so it runs from a pnpm lifecycle script or with that variable set to pnpm's entry file. The five single-source builds above are the per-plugin evidence that the tarballs the packaging step consumes were compiled against this Host.

## Alternatives considered

**Treat the five constant edits as the whole review.** Moving the version and packaging without re-running the checks would assert a review that never happened; compilation and the retained suites are the only evidence that the overlays still apply to unchanged upstream text, and the Codex allowlist assertion is what reports a Host the plugin does not support.

**Derive the expected version from the family version, or add one controlled "accept this version" entry point.** The gate in `build.mjs` could compare the checkout's Host version against the version the release tooling already resolved, and record the review where the release reads it, instead of restating the version in five files that are discoverable only by failing the build. Two bumps have now each paid that cost, and nothing in the repository lists the five places for the next one. Not done here: the reviewed version has to stay a reviewable code change, the [alpha.2 review](2026-09-26-community-plugin-host-version-review.md) rejects both an environment override and deriving the value inside the Codex check (which must still be able to report an unsupported Host), and this round's job was to accept one version rather than redesign the gate.

**Review only `dsh-codex-subscription`, the one source that failed.** The gate blocks every source until it moves, the other four carry the same Host version in `SOURCE.json` and in the peer alternatives the build rewrites, and "unchanged" is observable only by building them.

## Consequences

Packaging resumed, and the installer carries plugins whose overlays were compiled against `0.1.6-alpha.3`. The recurring cost is unchanged: five hand-edited version statements per Host bump, no list of them, and an obsolete-version list that grows by one product version per round. The derivation sketched above is the improvement this round argues for; it is not implemented here.

The mechanism — the gate, what a review covers, and the equal-depth byte comparison — remains owned by [the alpha.2 review](2026-09-26-community-plugin-host-version-review.md). This note records the round that accepted `0.1.6-alpha.3` and supersedes that note's version statements, which name `0.1.6-alpha.2` as the version reviewed in that round.
