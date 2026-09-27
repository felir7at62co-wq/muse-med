# Agent Note: the Windows installer shipped without one packaged media asset

Status: implemented

English | [中文](2026-09-28-installer-dropped-a-packaged-media-asset.zh.md)

## Problem

A 2026-09-28 session review found a renderer blocked by a missing input: every installed copy of `muse-med` carried `…\dsh-drama-skills\skills\tweet-drama-background-render\assets\ending_audio.mp3` (83,432 bytes) but not the `ending_effect.mp4` beside it (904,502 bytes, SHA-256 `49308bce…0010`), and a whole-disk search found the effect's bytes nowhere on the machine. The repository package carried both, `packages/drama/skills/package.json#files` named both, and `drama_render` refuses to render without both ([bundle-the-renderer-ending-media](../architecture/2026-09-22-bundle-the-renderer-ending-media.md), [ending-plays-at-its-own-speed](2026-09-26-ending-plays-at-its-own-speed.md)), so the loss happened between a correct package and a shipable installer. This was the third occurrence of "a resource did not reach the package", so the fix had to include a gate that names the missing asset instead of a session discovering it.

## Decision

`apps/desktop/electron-builder.config.mjs` sets `nsis.preCompressedFileExtensions: []`, and `apps/desktop/tests/nsis-payload-assets.spec.ts` pins that value.

The cause is upstream, in app-builder-lib 26.15.3 `out/targets/nsis/NsisTarget.js`. Its NSIS options default `preCompressedFileExtensions` to nine media extensions (`.avi .mov .m4v .mp4 .m4p .qt .mkv .webm .vmdk`, `:44`), which become `excluded: ['*.mp4', …]` (`:84`) and then `7z -xr!*.mp4` on the `app-64.7z` payload (`targets/archive.js:125-131`). Those files are meant to be re-added as separate installer entries, but the re-adding walk (`:666-688`) descends into `resources/` and prunes every directory whose path ends in `node_modules` (`:672-676`). A media asset inside a packaged runtime package sits at `resources/app.asar.unpacked/dsh/node_modules/…`, so it is excluded from the archive **and** never re-added: no installed copy receives it. `ending_audio.mp3`, `template.json`, and the other 4,180 payload files are unaffected because their extensions are not on that list, and electron-builder had already copied the `.mp4` into `app.asar.unpacked` (its asar header records `unpacked=true, size=904502`), so every earlier check that read `app.asar` saw a file the installer did not carry. Emptying the list archives the whole app directory, which is what the payload is for.

The renderer now distinguishes the two causes of an absent ending file, without weakening the byte rule. `requireEndingAssetFile()` ([render.ts](../../../../packages/drama/tool-episode-render/src/render.ts) calls it for both ending inputs) judges the supplied path and its sibling: because the two shipped ending files share a directory, a correct sibling proves the directory arrived and only this file is gone, so that message names a broken installation and its repair, while a directory holding neither names a wrong path and restates the shipped path and SHA-256. `requireShippedEndingAsset()` still refuses any bytes that are not the shipped asset's, still before the first media command.

Installer acceptance now verifies a pinned shipped-asset manifest — file name, byte count, and SHA-256 for all three assets under `dsh-drama-skills/**/assets/**` — against the members of the installer's own `app-64.7z`, and fails on a single missing or byte-differing asset, on an asset the payload carries that the manifest does not pin, and when an `app.asar` member is marked `unpacked` while the payload lacks it. The runner is `.local/verify-installer.mjs` with its record in `.local/release/install-verification-checklist.md`; both live under gitignored `.local/`, so the committed guards are the config value and its spec.

## Alternatives considered

**Move the ending assets out of `node_modules`.** Copying them into `resources/` directly (or via `extraResources`) escapes the prune, and was rejected because the tool's own contract, the skill text, and `delivery.ts` all name the assets at their path inside `dsh-drama-skills`; relocating them would make the shipped path a second, install-only one.

**Keep the default list and add `ending_effect.mp4` through `extraFiles`.** This duplicates one file into the payload under a path the tool never reads, so the renderer would still refuse a caller who points at the shipped skill directory, and the next packaged media asset would need the same hand-copy.

**Delete only `.mp4` from `preCompressedFileExtensions`.** This keeps an installer-size optimization for the eight remaining extensions, and was rejected because no current payload file outside `node_modules` uses any of them: the list buys nothing today, and re-listing it invites a future default change to drift unnoticed.

**Repair the installation after the fact.** Any post-install step that writes the asset would have to ship the bytes in the installer anyway, and it would leave a window where an installed product is missing a delivery prerequisite.

## Consequences

The Windows installer archives the media it previously stored as separate NSIS entries, so those bytes are LZMA2-compressed in `app-64.7z`; already-compressed media gains little, and the cost is build time on the media present, not correctness. Emptying the list is the correct trade because the payload's contract is completeness.

The rule lives in a transitive dependency, so the committed spec pins our configuration rather than the upstream behaviour: an app-builder-lib upgrade changes the excluded extensions only if it changes what `preCompressedFileExtensions: []` means, and the installer gate fails on the payload regardless. The gate needs a built installer, so it runs at release acceptance rather than in CI.

## Verification

`pnpm vitest run apps/desktop/tests/nsis-payload-assets.spec.ts` passes, and the electron-builder configuration's other consumers (`apps/desktop/tests/macos-signature.spec.ts`) are unchanged.

`node .local/verify-installer.mjs <installer> <workDir>` exits 1 on the built `muse-med-0.1.6-alpha.2-win-x64.exe` with one failure — `ending_effect.mp4: unpacked in app.asar but absent from the installer payload` — while both other assets PASS; its comparison table is `PASS ending_audio.mp3`, `ABSENT ending_effect.mp4`, `PASS template.json`.

Replaying the two steps (`7z a -xr!*.mp4` over the built runtime tree, then the re-adding walk over `resources/`) drops `ending_effect.mp4` from the archive under the default list, keeps both assets under an empty list, and re-adds zero files, matching the shipped payload's contents.
