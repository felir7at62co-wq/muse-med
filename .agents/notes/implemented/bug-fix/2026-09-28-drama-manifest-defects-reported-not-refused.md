# Agent Note: manifest defects are reported, not refused

Status: implemented

English | [中文](2026-09-28-drama-manifest-defects-reported-not-refused.zh.md)

## Problem

Two readers of a project's `assets_manifest.json` refused the whole file for a declaration they could not use, and the refusal cost the caller the findings it needed.

`drama_assets reconcile` read only `items` and treated an absent array as "no rows". A manifest whose asset array was spelled `assets` — the older spelling the shot scripts wrote, and one `jubian_organize` reads as well — therefore compared against an empty local side and reported every used asset the remote project already holds as unregistered, which is the one verdict this comparison exists to get right. The first fix refused the call with `CONTRACT_CHANGED` instead. That is worse for the caller: the file is authored by a model that still has to repair it, and one sentence naming one key costs that model every other finding in a file three tools read. `lead_readonly_records` had the opposite failure: an absent array was silently read as "no rows", so a manifest that lost its lead records reported those remote assets as unregistered without saying anything.

`drama_shot validate` had the same pair of failures one rule further in. A manifest row typed `role` rather than `角色` or `character` bound nothing, because the binder matches types by exact spelling, and no other rule noticed: a shot whose character asset was skipped answered `ok: true, 0 failures`. Refusing the manifest where the type is read repeats the shape [the state gate already rejected](2026-09-28-character-state-gate-at-binding.md) for its own registration fields — "refusing the whole document at read time would turn one legacy row into a parse failure that hides every other finding".

## Decision

**A manifest defect is an issue on the result, never a failed call.** Both readers keep reading every declaration they can and report the ones they cannot.

`readManifest` in [`src/manifest.ts`](../../../../packages/drama/tool-drama-assets/src/manifest.ts) returns the declarations plus an `issues` list, and the evidence document carries the same list. It accepts the asset array under `items` or `assets`, reading `items` first because that is the project's own key; a row that is not an object is skipped and named; a missing `lead_readonly_records` is reported rather than read as empty. Every issue has a stable code (`manifest_items_missing`, `manifest_items_spelling`, `lead_records_missing`, `manifest_record_unreadable`) and a message that names the key, the key names that are accepted, and the repair. The wording of the missing-array sentence is `jubian_organize`'s for the same key, so the two readers of one file say one thing about it.

`ready` now requires `issues` to be empty as well: a comparison whose local side could not be read reports an asset the remote already holds as unregistered, and that verdict is what a paid creation acts on. `dispose` carries the issues the evidence already holds instead of recomputing them, so a disposition cannot turn that verdict back into a ready one. The host gate needs no change — it reads `ready`.

Three facts still fail the call, because nothing can be compared past them: a missing file, a body that is not JSON, and a top-level object with no integer `script_id`.

**The mechanism differs from `jubian_organize` on purpose.** `organize` throws `CONTRACT_CHANGED` for an array it cannot find; `reconcile` returns a structured issue and `ready: false`. `organize` builds an index and answers a question the caller already framed; `reconcile` is the report a paid-generation gate and a human both read, and the model that has to repair the manifest reads it as one document. A thrown error ends that document at the first defect; a reported issue arrives beside the whole `unregistered` and `dangling` list the same run produced.

**This supersedes the refuse form recorded for the same declarations.** [The 2026-09-27 note](2026-09-27-silent-envelope-and-manifest-key-failures.md) had `readManifest` refuse a manifest whose array is not `items`, with `lead_readonly_records` left optional. That form was built on this codebase and rejected: the same run had already produced the findings the caller needs, and one thrown sentence ends the call before any of them reaches a model that still has to repair the file. Its envelope half — every reader rejecting through one redacted summary — stands and is implemented in [`jubian-api/src/reading.ts`](../../../../packages/jubian/jubian-api/src/reading.ts); only the manifest half is replaced here. `lead_readonly_records` is reported rather than defaulted, because an absent array is what made a lost lead record silent, and an older manifest spelling its asset array `assets` is read rather than refused, because the rows are right there and only the key name is not.

`parseAssetManifest` in [`src/assets.ts`](../../../../packages/drama/tool-shot-script/src/assets.ts) now returns `{ assets, issues }`, mirroring `parseShotScript`'s `{ shots, issues }`. A `type` outside the six spellings the binder matches is kept in the rows and reported as a failure issue naming the row number, the asset name, the value read, the accepted spellings and the repair. The readable rows still bind, and the script's own findings are still judged in the same run — so `validate` answers `ok: false` with the character asset visibly unbound instead of `ok: true` over an empty finding list.

## Alternatives considered

**Refuse the call, naming the missing key.** Rejected for both readers: it is one sentence instead of the run's other findings, and the caller cannot repair what it cannot see. It also split one file's behaviour from `drama_shot`, which reads the same manifest and kept reading it.

**Read the tolerated `assets` spelling silently.** Rejected: the project's own key is `items` — the pipeline's own manifests spell it that way, and `jubian_organize` was extended to accept `items` for that reason. The comparison uses the rows either way, so no verdict depends on the spelling; the caller is told the canonical key instead of being left with a file the next reader may not tolerate.

**Default a missing `lead_readonly_records` to an empty list.** Rejected: that is what produced the silent report of lead-character assets as unregistered. The repair is one line, and the issue says so.

**Treat an unusable `type` as a warning.** Rejected: a skipped character asset is a wrong artifact, not a pacing suggestion, and a warning leaves `ok: true` — exactly the state this check exists to prevent.

## Consequences

A manifest with any of these defects now yields `ready: false` and no longer releases a paid generation until it is repaired. That is the intended direction: those runs were already producing untrustworthy `unregistered` lists. `assets_manifest.json` files whose array is spelled `items` and which declare `lead_readonly_records` are unaffected, and a manifest defect no longer hides the script's own failures.

The `issues` field is additive to `_probe/asset-reconcile.json`; `_tools/asset_reconcile_report.py` and the host gate read the fields they already knew, and the gate's `ready` check is what makes the new field effective.

`drama_shot` still fails the call for a document that is not an object, for a missing asset array, and for a row with no `name` or `type`: those leave the row unreadable rather than unusable, and no issue could name the asset they are about.

## Verification

`pnpm vitest run packages/drama/tool-drama-assets` passes, 66 tests over two spec files: the assets-only manifest that reconciles its real rows and reports `manifest_items_spelling`, the manifest that declares no array and reports `manifest_items_missing` beside two other issues, the lead-record array that is missing or is not an array, the record that is not an object, and the `dispose` call that carries the issues forward.

`pnpm vitest run packages/drama/tool-shot-script` passes, 134 tests over seven spec files, including the registered-tool case where a `role`-typed character row leaves `ok: false`, the shot bound to its scene alone, and both the type issue and the restock request in `failures`.

`jubian_organize`'s own reading of the same file is unchanged by this work.
