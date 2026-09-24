# Agent Note: Pin the DSH runtime and give the product its own version

Status: proposed

English | [中文](2026-09-24-pinned-runtime-product-migration.zh.md)

## Problem

This checkout is a fork of the whole harness that carries the muse-med desktop product. It has no local commits of its own: the product work sits directly on a merge base that is 2499 commits behind `origin/master`, and 1214 files differ from that base — 1073 fork-added files (+170,771 lines) and 141 edits into pre-existing upstream files (+5376 / −357). The product's own surface is 926 tracked files and 162,162 text lines, and `packages/drama`, `packages/jubian`, `packages/perception`, and `third_party/plugins` do not exist upstream at all.

Two facts make the current arrangement unstable. First, release identity is single-valued: `package.json` holds `0.1.6-alpha.1`, and 23 sites assert or derive that same value as both the product version and the DSH version, including `apps/desktop/src/runtime-tree.ts:173`, which requires the shared `@deepseek-ai/dsh` package to carry exactly the release version. The product therefore cannot take a release without also claiming a DSH version. Second, dependency resolution is by workspace protocol: product packages hold 130 `workspace:` references, 68 of them to upstream-owned packages, so the product can only be built inside the whole harness tree.

The cost is paid at the next upstream move. A read-only rehearsal (`git merge-tree --write-tree --name-only HEAD origin/master`) reports 77 conflicted files — 63 content conflicts and 14 modify/delete, 38 of them under `apps/desktop` — because upstream deleted several files the fork had edited, including `apps/desktop/renderer/plugin-manager.{js,css,html}`, `apps/desktop/src/preload.ts`, and the three `packages/llm/llm-deepseek/src/protocols/chat-completions/*.ts` modules. The product depends on surfaces no release publishes: `apps/desktop/scripts/prepare-package-set.ts:25-26` imports `scripts/release/process.ts` and `scripts/release/tarball.ts`, which exist only inside the repository.

## Proposal

The product keeps building and shipping the whole application from this repository, and the harness becomes an input rather than a base. A tracked [`upstream.json`](../../../../upstream.json) at the repository root records the target DSH release — commit and version — as the single place the pin lives. [`scripts/upstream-sync-rehearsal.ts`](../../../../scripts/upstream-sync-rehearsal.ts) owns that record: it re-derives the base from Git, refuses to continue when the record and Git disagree, and reports the conflicts a merge would raise without making it. The product's own version is `apps/desktop/package.json`, free to differ from it. The runtime descriptor gains `release.dshVersion` beside `release.version`, so `runtime-tree.ts:173` compares shared packages against the pinned DSH version while artifact naming and update metadata keep using the product version.

The product's 68 workspace references to upstream-owned packages move to pinned ranges, and the product packages that must be publishable leave upstream's `@deepseek-ai` scope, which the product cannot publish under. The desktop shell stays product-owned: the product owns 24,743 lines of shell and build scripting, the installer, and the media payload, and the reference third-party desktop client arranges the same relationship — a product-owned shell depending on a pinned runtime. The two non-public surfaces the shell relies on are replaced or explicitly owned: the repository build-script imports are ported into the product, and the loader internals in `apps/desktop-host/src/native-preset.ts` stay inside the product's control through the vendored `@deepseek-ai/cordis-plugin-loader` in `vendor/loader`.

The [independent-product decision](../../implemented/architecture/2026-09-23-muse-med-independent-desktop.md) continues to own the product home, preset roster, media environment, and credential isolation, and the [bundled-runtime decision](../../implemented/architecture/2026-09-08-desktop-bundled-runtime-and-external-plugins.md) continues to own package sharing and plugin lifecycle. Neither is superseded; this note changes where the harness comes from, not what the product is.

## What is deliberately not yet done

Stage 0 has landed: three files. `upstream.json` records the pin; `scripts/upstream-sync-rehearsal.ts` reads it, derives the base with `git merge-base HEAD <ref>`, runs `git merge-tree --write-tree --name-only`, classifies each conflict as content or modify/delete, and asserts that both the working tree and the ref set are byte-identical before and after; `scripts/upstream-sync-rehearsal.spec.ts` exercises it against a temporary repository that builds its own fork, upstream advance, a both-sides edit, and a deletion on each side. `pnpm exec tsx scripts/upstream-sync-rehearsal.ts` reports 77 conflicted files — 63 content, 14 modify/delete — and `pnpm exec vitest run scripts/upstream-sync-rehearsal.spec.ts --maxWorkers=1` passes 14 cases. The pin refuses to pass silently: a ref that does not resolve, a ref without a merge base, a pin that disagrees with Git, and an unknown flag each fail with the reason named.

Recording a commit identifier in a maintained file required one exception in [`verify-repository-references`](../../../../scripts/verify-repository-references.ts), whose rule exists to stop prose and documents from carrying hashes that rot: the pin record is that identifier's subject rather than a reference to it. The exemption is the exact repository-root path `upstream.json` and nothing else — the organization URL is still rejected inside it, a file of that name under any directory is still rejected, and every other file keeps the rule.

Everything after Stage 0 is unimplemented, and the staged plan with its acceptance checks and rollbacks lives in `.local/architecture/pinned-runtime-migration.md`, outside the repository's tracked documentation. No version site has changed, no dependency has moved off the workspace protocol, and no package has been renamed; the 23 version sites, the 68 workspace edges to upstream-owned packages, the scope decision, and the two non-public upstream imports named in `## Risks` are all still open. The pinned DSH release the product would target has not been chosen — `apps/desktop/package.json` and `package.json` still both read `0.1.6-alpha.1`.

The vendoring question is also deliberately unanswered in the direction the reference takes it. The reference desktop client vendors 891 tarballs across three pins (48 MB of its 82.6 MB checkout) and rewrites 618 `resolutions` per bump. All 309 packages of its active pin, and all 120 probed in this session, are already published to npm at that version, so registry resolution is available for the 36 packages this product needs at runtime. Vendoring is deferred to the case where a specific package must be patched; no package is patched today.

## Alternatives considered

**Stay a fork and rely on sync discipline.** The rehearsal bounds the cost at 77 files rather than 1214, so this is survivable. It loses because the cost grows with every skipped release, 38 of the conflicts are in the shell the product is actively editing, and the two facts that make the fork unstable — single-valued release identity and workspace-protocol resolution — are untouched by any amount of discipline.

**Adopt the reference's full mechanism.** Vendoring the runtime would pin the DSH packages hermetically and make an offline build trivial. It loses on measured cost: 891 tarballs and 618 resolutions maintained in the product repository, plus up to 19 upstream packages patched per version, for a product that needs 36 packages and patches none. It also makes the DSH version inseparable from the product version again, which is the problem being solved.

**Replace the desktop shell with a thin plugin over a pinned runtime.** This is where the reference's own wording misleads: its shell *is* a product package. Porting 90 script files and 14,287 lines, the renderer, the installer, and the media staging into a new shape has no test that would catch a regression mid-port, and it buys nothing that Stages 2 and 3 do not already buy.

**Keep the `@deepseek-ai` scope and publish nothing.** Viable while every product package stays `private: true` and ships inside the app. It loses only when a package must be published independently, so the scope decision is deferred until that need exists rather than taken now.

## Risks

The pin is only as good as the release it names. If a DSH release drops or renames a package the product consumes, the failure surfaces as a resolution error at install time, not as a compile error, so the pin must be validated by a real package install and Host boot and not by reading version numbers.

Two non-public surfaces survive the change. The deep import of `app-builder-lib/out/vm/WineVm.js` in `apps/desktop/scripts/windows-sign.mjs:8` remains coupled to a third-party tool's internal layout, and `apps/desktop-host/src/native-preset.ts` reaches Cordis loader entry and tree internals that no release documents. The vendored loader keeps the second inside the product's control; the first does not go away.

Moving the product's version off the DSH version changes the update-metadata filename that `desktop-upload-plan.ts` derives. A release cut between the two stages can publish metadata a running app cannot read.

## Acceptance criteria

Stage 0's criterion is met: `pnpm exec tsx scripts/upstream-sync-rehearsal.ts` exits successfully only while `upstream.json` matches `git merge-base HEAD origin/master`, reports 77 conflicted files — 63 content, 14 modify/delete — and changes neither the working tree nor the ref set; `pnpm exec vitest run scripts/upstream-sync-rehearsal.spec.ts --maxWorkers=1` passes its 14 cases against a fixture repository with no remote.

The remaining stages are done when `pnpm run prepare:desktop` fails if the DSH release named by the pin and the DSH packages actually installed disagree and succeeds when they agree; `apps/desktop/package.json` carries a version independent of the pinned DSH version while artifact names, update metadata, and the runtime descriptor remain self-consistent; no product package resolves an upstream-owned package through `workspace:`; and a packaged build boots the Host and mounts all three product presets with the DSH packages coming only from the pin.
