# Agent Note: Jubian upscale route and unknown writes

Status: implemented

English | [中文](2026-09-21-jubian-upscale-route.zh.md)

## Problem

An inferred `/aigc/storyboard/upscale` endpoint blocks HD conversion. A failed request remains an unknown write, so repairing the route must not bypass its ledger record.

## Decision

The upscale dispatcher uses `POST /aigc/storyboard/hdConversion`. Public frontend [module 917c](https://web.jubianai.net/static/js/chunk-7652bf40.378292fb.js) exports `h` as function `f`, which posts data to that route; [ScriptHDConversionDialog](https://web.jubianai.net/static/js/chunk-46be48c6.54967903.js) submits its form through that export. The form uses task type 20 and SeedVR2 selectors, without `videoResolution`. Existing duration is retained; `Math.floor` applies only to the dialog's fallback duration.

The existing builder and ledger remain unchanged. A key recorded as unknown on the incorrect route still replays without sending anything. The caller must reconcile provider tasks and charges before considering a fresh submission; route correction does not authorize one.

Resolution hints do not authorize HD processing. `needs_upscale` retains its numeric comparison and nullable boolean output; tool guidance treats it as neither a content-usability verdict nor a payment obligation. SD2.5 defaults to original clips without submitting or waiting for HD. Every model requires an explicit user request or authorization for the specific HD operation; SD2.5 remains eligible when requested. Export dimensions and source resolution are reported separately because local scaling does not restore source detail.

## Alternatives considered

**Retry the corrected route under a fresh key automatically.** A different path does not establish that the first attempt had no effect or charge; this would bypass the ledger's protection.

**Add a resolution field or rewrite the payload.** The public form and existing request builder already agree for an unprocessed source; speculative fields are unnecessary.

**Automatically buy HD for every below-target result, or prohibit SD2.5 HD entirely.** Resolution is not user authorization, while a blanket model ban would reject explicit user requests. Offline output tests cover both target branches, unchanged true/false/null values, and tool descriptions that reject automatic payment.

## Consequences

Focused dispatcher tests pin the route, complete payload, accepted task id, and no-network replay for accepted and historical unknown keys. Builder and ledger tests cover their existing validation. No paid request verifies this repair; runtime activation and provider reconciliation remain the caller's responsibility. Processed-source selection is outside this route-only repair.
