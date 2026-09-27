# Agent Note: Resume packaging at the step that failed, and repack only what changed

Status: implemented

English | [中文](2026-09-27-packaging-resume-and-unchanged-package-skip.zh.md)

## Problem

`pnpm run package:desktop:win:x64:unsigned` runs thirteen steps (S1–S13) and has no resume path: a failure at S6 (the pinned community plugins refusing a Host version) or at S12 (`prepare:dsh`) left the operator with the whole 20–25 minute pipeline as the only retry, and the retry rebuilt byte-for-byte identical tarballs before reaching the step that had failed.

Packaging takes its inputs from the working tree rather than from a commit, and nothing said so. Two installers were lost to that in one day. A run that resumed only S12 absorbed another author's uncommitted edits, because a partially run pipeline reads whatever the tree holds. A separate run produced a drama tarball written at 15:32 while the fix it was meant to carry was committed at 15:39, so the installer both lacked the promised fix and could not be attributed to any commit; it was scrapped.

The media payload [already had the pattern that works](../../../../apps/desktop/scripts/prepare-media-runtime.ts): an existing payload is verified before it is reused, and the step reports `existing payload verified and reused`. Packing had no equivalent for its tarballs.

## Decision

Two changes, both in the packaging pipeline, both refusing rather than warning.

**Resume with guards (`--from`/`--only`).** [`package-steps.ts`](../../../../apps/desktop/scripts/package-steps.ts) owns the step table — the thirteen steps, their titles, and the paths each produces — and [`package-target.ts`](../../../../apps/desktop/scripts/package-target.ts) supplies each step's commands. `--list-steps` prints the table, so the mapping between a step and its artifacts has one home and cannot drift into prose.

A run then holds four rules, enforced in code and not in a runbook:

1. It refuses to start unless `git status --porcelain` lists nothing but `.pi-glla/` — the harness's own tracked runtime state.
2. It reads HEAD once at startup and re-reads it before every step, refusing when it moved.
3. Before the first step it prints every artifact the skipped steps left, each with its path, write time, byte length or entry count, SHA-256 digest, and a digest naming the whole set.
4. It refuses a reused artifact written before HEAD's commit time, naming the artifact, its write time, and the commit time.

Resuming requires the artifacts of *every* skipped step: an artifact that is missing, or one that predates the commit, stops the run before it starts. A failure message names the step and the `--from <S#>` that resumes it.

**Skip unchanged packages by content hash.** [`pack-plan.ts`](../../../../scripts/release/pack-plan.ts) digests the files `pnpm pack` reads — the manifest's `files` patterns, the names npm always packs, and the `main`/`bin` targets — together with the package manager and the input digests of the member's whole family dependency closure. [`pack.ts`](../../../../scripts/release/pack.ts) keeps a tarball when the recorded digest still matches, the recorded tarball content hash still matches the file, and the record's inputs covered the packed payload. Every decision is printed with the member name, digest, and artifact path; the record lives in `release-pack-<family>.json` beside the tarballs.

The dependency closure is what makes a partial reuse consistent. A consumer's own bytes cannot change because a dependency was repacked, but a release packs one commit: a dependency packed from new content means the consumer was packed before that content existed, so its digest changes and it is repacked.

The pack step keeps its existing place as the release boundary — it produces every tarball from one commit and hands the publish step exactly those bytes ([the release-sequence decision](2026-08-10-npm-release-sequences.md) owns that boundary); this decision changes which of those tarballs a run rewrites.

## Alternatives considered

**A run-state file recording each completed step.** Stronger attribution than a step table — the record could name the commit each artifact was built from. It also adds durable state that the tree must keep in sync with the tarballs, and the record can lie after a manual `rm`, so the run would still need the tree, HEAD, and freshness checks that carry the decision today.

**Reusing by mtime.** Cheaper and already familiar, and the incident shows why it fails: the drama tarball was newer than the files it was built from and older than the fix it was supposed to carry. Timestamps answer "when", never "from what".

**Hashing the packed tarball's payload instead of the inputs.** Exactly right in principle, but the payload is only known after packing, so it cannot decide whether to pack.

**`--resume` with no step argument.** Needs the same run state the rejected alternative needs; the failure message naming `--from <S#>` gives the operator the same one-command recovery with no state to go stale.

**Exact npm file selection.** Reimplementing npm-packlist's rules was rejected in favor of a superset: a declared path that is a directory contributes its subtree, and `readme|copying|licen[cs]e|notice|changes|changelog|history` names are always added. Over-inclusion only costs a repack; under-inclusion would reuse a tarball whose unrecorded file had changed. The recorded `inputsMatchPayload` flag makes the direction observable: measured against the 309 packed dsh-family tarballs and the 9 vendor tarballs, 308 of 309 members are fully covered, and `@deepseek-ai/dsh-experimental-webworker-packer` is repacked every run because `pnpm pack` adds a `lib/types/bin.js` its `files` patterns do not select.

## Consequences

A failure at S13 now retries in minutes instead of rebuilding the twenty-minute prefix, and the reusable prefix is printed with the digests that identify it. In the measured case — 309 dsh members, 21 changed at the commit being packed — the pack step drops from packing every member to packing those 21, seconds to minutes of wall clock rather than the full pack. The same-commit rerun that the incident needed (`--from S13` after a notarization or NSIS failure) skips packing entirely.

The cost is that a commit invalidates the reuse set: any commit, including one that changes only documentation, moves HEAD past the tarballs, so a resume after it repacks. That is the intended direction — packaging a tree that no commit names is what produced the scrapped installer.

The rules constrain *where* bytes come from, not *what* they contain: a clean tree at one commit is still the only thing a resumed run proves.
