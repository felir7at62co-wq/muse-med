# Agent Note: the reader layer that never said what arrived, and the manifest key read as "no assets"

Status: implemented

English | [中文](2026-09-27-silent-envelope-and-manifest-key-failures.zh.md)

## Problem

Two failures a member hit on the alpha.3 build both reported a verdict while withholding the fact that would identify it.

**The reader layer threw a bare code.** `Jubian response did not match the expected envelope` appears 36 times in the member's session, from `13:41:10` to `17:30:42` — the whole working day, on the build the fix below shipped on — across `jubian_storyboard`, `jubian_video`, `jubian_media`, `jubian_catalog` and `jubian_model`. Every one of those messages was identical, and `DSH_JUBIAN_DEBUG_DUMP` appears in that session zero times, because nothing in the message named it. [Transport diagnostics](2026-09-28-jubian-unreadable-response-diagnostics.md) had added a redacted structure summary to the transport layer, but the transport only owns the envelope: it hands `data` to a reader, and each reader in `@deepseek-ai/dsh-jubian-api` threw `new JubianError('CONTRACT_CHANGED')` with no detail at all. Eleven reader modules each declared their own argument-less `invalid()`, so a payload the transport accepted and a reader could not use produced the one sentence that names neither the endpoint nor the fields.

**The reconcile side read a missing array key as an empty array.** `drama_assets reconcile` reported `"对账里还有 222 条未处置的未登记资产"` beside `"manifest":{"items":0}` three times (L963, L2814, L3340) while the manifest declared those assets under a different key; the member then wrote "清单用的是 assets 不是 items" (L3462) and got `ready:true` immediately after renaming the key (L3470). `manifest.ts`'s `rowsAt()` returned `[]` for `undefined`, so a manifest whose asset array was spelled `assets` was read as a project with no assets, and every asset the remote already held was judged unregistered. `jubian_organize` had already been changed to refuse a missing `items` ([organize.ts:160](../../../../packages/jubian/tool-jubian/src/organize.ts)), but the reconcile side had not moved since 09-22.

Both are the same defect shape: a check whose whole job is to stop a silent failure produced the failure it exists to prevent, and the artifact it wrote looked authoritative.

## Decision

**One summary function, rejected through by both layers.** [`describeRejection(value)`](../../../../packages/jubian/jubian/src/diagnostic.ts) composes the structure [`describePayload`](../../../../packages/jubian/jubian/src/diagnostic.ts) already reported, the envelope `code` against the accepted set (`0 / 200`), and the `DSH_JUBIAN_DEBUG_DUMP` sentence with its usage. `describeBodyRejection` is the same sentence for a body that never decoded. The transport rejects an unreadable envelope through them, and so does every reader, so the two layers cannot describe one body differently.

**Every payload reader reads through [`readPayload`](../../../../packages/jubian/jubian-api/src/reading.ts).** A reader's own `CONTRACT_CHANGED` is rewritten to name the reader and carry the summary; a detail the reader authored is kept and the summary appended, because the detail is the reader's conclusion and the summary is what actually arrived. A detail that already names the capture switch is passed through unchanged, so a reader wrapped twice — `withGenerationEnabled` calls `readStoryboard` — summarises one payload once.

**The manifest's asset array has one spelling.** `readManifest` reads `items` and refuses anything else with the sentence `jubian_organize` already uses, naming the key, the observed top-level keys, and the repair. `lead_readonly_records` stays optional, because it genuinely may be absent; the asset array may not, because reading it as absent is how 222 registered assets became 222 unregistered ones.

## Alternatives considered

**Let each reader keep its own `invalid()` and write its own summary.** Rejected: that is the drift the note exists to prevent, and it cannot cover a rejection thrown from a shared helper like `rows()` or `object()`, which is where most reader rejections originate.

**Make a missing `items` fall back to `assets`, as `jubian_organize` and the shot-script reader do.** Rejected for this comparison. Reading the other spelling as "no rows" is the failure being fixed, and a fallback keeps two spellings of one fact alive in the file whose only job is to settle that fact. Failing the call names the key in the same sentence in both the assets-present and assets-absent cases.

## Consequences

A reader refusal now names the reader that refused, the structure it received, the application code against the codes the envelope accepts, and the switch that captures the body, so one anonymous sentence can no longer stand for five tools and two unrelated causes.

Diagnosing a refusal costs one repeated call with `DSH_JUBIAN_DEBUG_DUMP` set; the captured line carries keys, types, lengths and codes, and never the body's access token or signed URL.

`drama_assets reconcile` reports a missing asset array as a structured issue with `ready: false` and keeps running, so a caller still reads the rest of the reconciliation; `jubian_organize index` refuses the same file with the same sentence, and the two mechanisms are documented in both READMEs.
## Verification

- `packages/jubian/jubian-api/tests/reader-rejection-summary.spec.ts` feeds one bad response to the transport and to a reader: both messages carry the structure, `code=500`, `accepted envelope codes: 0 / 200` and `DSH_JUBIAN_DEBUG_DUMP`; neither carries the body's access token or its signed URL; `null`, `undefined`, an array, a string, a number and a boolean are all described rather than rejected.
- `packages/jubian/jubian/tests/envelope-layout.spec.ts` keeps the transport-layer cases, including the unmapped-code number and the `accessToken` redaction.
- `packages/drama/tool-drama-assets/tests/reconcile.spec.ts` covers a manifest spelling its array `assets`, one carrying both keys, and one carrying neither; the two refusals differ only in the structure they list.
